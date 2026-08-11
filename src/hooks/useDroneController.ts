/**
 * CREBAIN Drone Controller Hook
 * Connects keyboard input to drone physics simulation
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  DronePhysicsWorld,
  type DronePhysicsBody,
  FlightController,
  MAX_PHYSICS_DT_SECONDS,
} from '../physics/DronePhysics'
import { DRONE_TYPES, toQuadcopterParams, type DroneTypeDefinition } from '../physics/DroneTypes'
import { useKeyboardControls, type DroneControlInput } from './useKeyboardControls'
import { logger } from '../lib/logger'
import {
  isAdmissibleRouteWaypoints,
  isFiniteRouteWaypoint,
  MAX_ROUTE_WAYPOINTS,
} from '../lib/routeLimits'
import {
  attachObject3DToScene,
  disposeObject3D,
  isObject3DInScene,
} from '../lib/three/sceneObjects'
import { isEngramEmbeddedMode } from '../integrations/engramHost'
import { isBoundedSceneName, MAX_SCENE_DRONES } from '../lib/sceneLimits'
import type { CommandLike } from '@sepahead/ncp'
import {
  assertDevNcpEntityCapacity,
  boundedDevNcpElapsed,
  DevNcpCommandStream,
  validateDevNcpKinematicSpawn,
} from './devNcpCommand'
import { createPlaceholderDrone, loadDroneModel as loadDroneModelAsset } from './droneModel'

export {
  assertDevNcpEntityCapacity,
  boundedDevNcpElapsed,
  DevNcpCommandStream,
  ingestDevNcpCommand,
  MAX_DEV_NCP_ENTITIES,
  MAX_DEV_NCP_KINEMATIC_SCALE,
  normalizeDevNcpCommand,
  validateDevNcpKinematicSpawn,
} from './devNcpCommand'

const log = logger.scope('DroneController')

// Reused scratches to avoid allocating a THREE.Euler / Vector3 / Quaternion
// every frame in the physics rAF loop.
const scratchEuler = new THREE.Euler()
const scratchVelocity = new THREE.Vector3()
const scratchQuaternion = new THREE.Quaternion()

export const MAX_MANAGED_DRONES = MAX_SCENE_DRONES

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteVector3(value: THREE.Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
}

function validateDroneSpawnState(position: THREE.Vector3, state?: DroneSpawnState): void {
  if (!isFiniteVector3(position)) {
    throw new Error('Drone spawn position must contain finite values')
  }
  if (state?.orientation) {
    const orientation = state.orientation
    const lengthSquared = orientation.lengthSq()
    if (
      ![orientation.x, orientation.y, orientation.z, orientation.w].every(Number.isFinite) ||
      !Number.isFinite(lengthSquared) ||
      lengthSquared <= Number.EPSILON
    ) {
      throw new Error('Drone spawn orientation must be a finite non-zero quaternion')
    }
  }
  for (const [label, vector] of [
    ['velocity', state?.velocity],
    ['angular velocity', state?.angularVelocity],
  ] as const) {
    if (vector && !isFiniteVector3(vector)) {
      throw new Error(`Drone spawn ${label} must contain finite values`)
    }
  }
  if (state?.battery !== undefined && !Number.isFinite(state.battery)) {
    throw new Error('Drone spawn battery must be finite')
  }
}

export type RouteMode = 'none' | 'once' | 'patrol'

export interface Waypoint {
  position: THREE.Vector3
  altitude: number
  speed?: number // Optional speed override
}

export interface DroneRoute {
  waypoints: Waypoint[]
  mode: RouteMode
  currentWaypointIndex: number
  isActive: boolean
  arrivalThreshold: number // Distance to consider waypoint reached
}

export interface ManagedDrone {
  id: string
  type: string
  name: string
  physicsBody: DronePhysicsBody
  flightController: FlightController
  mesh: THREE.Object3D | null
  /** Rotor meshes cached at spawn so the rAF loop can animate them without
   * per-frame name lookups. Their order is model-defined and visual only; it
   * must not be interpreted as the physics FL/FR/RL/RR order. */
  rotorMeshes: THREE.Object3D[]
  route: DroneRoute
}

export interface DroneSpawnState {
  id?: string
  orientation?: THREE.Quaternion
  velocity?: THREE.Vector3
  angularVelocity?: THREE.Vector3
  armed?: boolean
  battery?: number
}

export interface SuspendedDroneScene {
  readonly drones: readonly ManagedDrone[]
  readonly droneCounter: number
  readonly selectedDroneId: string | null
  readonly wasPaused: boolean
  readonly errors: readonly unknown[]
  state: 'suspended' | 'restored' | 'disposed'
}

interface UseDroneControllerOptions {
  scene: THREE.Scene | null
  /** If false, skip physics initialization and make every mutation callback inert. */
  enabled?: boolean
  onDroneStateChange?: (drones: ManagedDrone[]) => void
}

/** Collect `rotor_<i>` meshes in index order for caching on a managed drone. */
function collectRotorMeshes(root: THREE.Object3D): THREE.Object3D[] {
  const rotors: THREE.Object3D[] = []
  for (let i = 0; ; i++) {
    const rotor = root.getObjectByName(`rotor_${i}`)
    if (!rotor) break
    rotors.push(rotor)
  }
  return rotors
}

interface DroneDetachmentResult {
  released: boolean
  errors: unknown[]
}

/**
 * Detach the live resources for one managed drone without disposing its mesh.
 * Three.js events and Rapier cleanup can throw after mutating ownership, so the
 * result is derived from the resulting graph and world rather than exceptions.
 */
function detachManagedDroneResources(
  scene: THREE.Scene | null,
  world: DronePhysicsWorld | null,
  drone: ManagedDrone
): DroneDetachmentResult {
  const errors: unknown[] = []
  const mesh = drone.mesh
  const meshErrorCount = errors.length
  if (mesh?.parent) {
    if (!isObject3DInScene(scene, mesh)) {
      errors.push(new Error(`Drone ${drone.id} mesh belongs to an unexpected scene graph`))
    } else {
      try {
        mesh.removeFromParent()
      } catch (error) {
        errors.push(error)
      }
    }
  }
  const meshReleased = mesh?.parent == null
  if (!meshReleased && errors.length === meshErrorCount) {
    errors.push(new Error(`Drone ${drone.id} mesh remains attached after cleanup`))
  }

  const retainedBody = world?.getDrone(drone.id)
  const bodyErrorCount = errors.length
  if (retainedBody === drone.physicsBody) {
    try {
      world?.removeDrone(drone.id)
    } catch (error) {
      errors.push(error)
    }
  } else if (retainedBody !== undefined) {
    errors.push(new Error(`Drone ${drone.id} physics ID belongs to a different body`))
  }
  const bodyReleased = world?.getDrone(drone.id) !== drone.physicsBody
  if (!bodyReleased && errors.length === bodyErrorCount) {
    errors.push(new Error(`Drone ${drone.id} physics body remains active after cleanup`))
  }

  return { released: meshReleased && bodyReleased, errors }
}

function disposeDetachedDroneMesh(drone: ManagedDrone, errors: unknown[]): void {
  if (!drone.mesh) return
  try {
    disposeObject3D(drone.mesh)
  } catch (error) {
    errors.push(error)
  }
}

function insertManagedDroneAt(
  store: Map<string, ManagedDrone>,
  drone: ManagedDrone,
  index: number
): boolean {
  if (store.has(drone.id)) return store.get(drone.id) === drone
  const entries = [...store.entries()]
  entries.splice(Math.min(Math.max(index, 0), entries.length), 0, [drone.id, drone])
  store.clear()
  for (const [id, entry] of entries) store.set(id, entry)
  return true
}

export function commitSimulationPauseState(
  pauseState: { current: boolean },
  commit: (paused: boolean) => void,
  resetTime: () => void,
  paused: boolean
): void {
  const wasPaused = pauseState.current
  pauseState.current = paused
  commit(paused)
  if (wasPaused && !paused) resetTime()
}

export function useDroneController(options: UseDroneControllerOptions) {
  const { scene, enabled = true, onDroneStateChange } = options

  const sceneRef = useRef<THREE.Scene | null>(scene)
  useEffect(() => {
    sceneRef.current = scene
  }, [scene])

  const physicsWorldRef = useRef<DronePhysicsWorld | null>(null)
  const [physicsReady, setPhysicsReady] = useState(false)
  const dronesRef = useRef<Map<string, ManagedDrone>>(new Map())
  const [drones, setDrones] = useState<ManagedDrone[]>([])
  const onDroneStateChangeRef = useRef(onDroneStateChange)
  const [selectedDroneId, setSelectedDroneId] = useState<string | null>(null)
  const [isPaused, setIsPaused] = useState(true)
  const isPausedRef = useRef(true)
  const animationFrameRef = useRef<number>(0)
  const loaderRef = useRef<GLTFLoader | null>(null)
  const droneCounterRef = useRef(0)
  const spawnGenerationRef = useRef(0)
  const pendingDroneSpawnsRef = useRef<Set<symbol>>(new Set())
  const pendingDroneIdsRef = useRef<Set<string>>(new Set())
  const pendingDroneDisposalsRef = useRef<Set<SuspendedDroneScene>>(new Set())

  useEffect(() => {
    onDroneStateChangeRef.current = onDroneStateChange
  }, [onDroneStateChange])

  if (!loaderRef.current) {
    loaderRef.current = new GLTFLoader()
  }

  const updateDronesList = useCallback(() => {
    const dronesList = Array.from(dronesRef.current.values())
    setDrones(dronesList)
    try {
      onDroneStateChangeRef.current?.(dronesList)
    } catch (error) {
      // A presentation callback must not unwind an ownership transition after
      // the scene graph or physics registry has already changed.
      log.warn('Drone state observer failed', { error })
    }
  }, [])

  const setSimulationPaused = useCallback(
    (paused: boolean) => {
      if (!enabled) return
      commitSimulationPauseState(
        isPausedRef,
        setIsPaused,
        () => physicsWorldRef.current?.resetTime(),
        paused
      )
    },
    [enabled]
  )

  const togglePause = useCallback(() => {
    setSimulationPaused(!isPausedRef.current)
  }, [setSimulationPaused])

  const resetSimulation = useCallback(
    (pausedAfterReset = false) => {
      if (!enabled) return
      // Invalidate model loads that began before this reset. The world and scene
      // objects intentionally keep their identity, so identity checks alone
      // cannot distinguish a stale spawn from the new simulation generation.
      spawnGenerationRef.current += 1
      const retiring = Array.from(dronesRef.current.values())
      const previouslySelectedDroneId = selectedDroneId
      dronesRef.current.clear()
      updateDronesList()
      setSelectedDroneId(null)
      isPausedRef.current = pausedAfterReset
      setIsPaused(pausedAfterReset)
      const cleanupErrors: unknown[] = []
      const retained: ManagedDrone[] = []
      for (const drone of retiring) {
        const result = detachManagedDroneResources(sceneRef.current, physicsWorldRef.current, drone)
        cleanupErrors.push(...result.errors)
        if (result.released) disposeDetachedDroneMesh(drone, cleanupErrors)
        else retained.push(drone)
      }
      for (const [index, drone] of retained.entries()) {
        if (!insertManagedDroneAt(dronesRef.current, drone, index)) {
          cleanupErrors.push(
            new Error(`Cannot retain drone ${drone.id}: a different live drone owns its ID`)
          )
        }
      }
      if (retained.length > 0) {
        updateDronesList()
        setSelectedDroneId(
          previouslySelectedDroneId &&
            retained.some((drone) => drone.id === previouslySelectedDroneId)
            ? previouslySelectedDroneId
            : (retained[0]?.id ?? null)
        )
      }
      if (cleanupErrors.length > 0) {
        log.warn('Simulation reset completed with resource-cleanup failures', {
          count: cleanupErrors.length,
          firstError: cleanupErrors[0],
        })
      }
    },
    [enabled, selectedDroneId, updateDronesList]
  )

  /**
   * Detach the current drone graph without disposing its meshes. The caller
   * owns the returned token and must restore or dispose it exactly once.
   */
  const suspendDronesForSceneRestore = useCallback((): SuspendedDroneScene => {
    if (!enabled) throw new Error('Drone simulation is disabled')
    const world = physicsWorldRef.current
    const scene = sceneRef.current
    if (!world || !scene) throw new Error('Drone simulation is not ready')

    spawnGenerationRef.current += 1
    const suspended = Array.from(dronesRef.current.values())
    dronesRef.current.clear()
    updateDronesList()
    setSelectedDroneId(null)
    const wasPaused = isPausedRef.current
    isPausedRef.current = true
    setIsPaused(true)
    const errors: unknown[] = []
    for (const drone of suspended) {
      errors.push(...detachManagedDroneResources(scene, world, drone).errors)
    }
    return {
      drones: suspended,
      droneCounter: droneCounterRef.current,
      selectedDroneId,
      wasPaused,
      errors,
      state: 'suspended',
    }
  }, [enabled, selectedDroneId, updateDronesList])

  const restoreSuspendedDrones = useCallback(
    (suspension: SuspendedDroneScene): void => {
      if (suspension.state !== 'suspended') {
        throw new Error(`Drone scene suspension is already ${suspension.state}`)
      }
      const world = physicsWorldRef.current
      const scene = sceneRef.current
      if (!enabled || !world || !scene) throw new Error('Drone simulation is not ready')
      if (dronesRef.current.size !== 0) {
        throw new Error('Cannot restore drones into a non-empty simulation')
      }

      const restored: Array<{ drone: ManagedDrone; createdBody: boolean }> = []
      try {
        for (const suspended of suspension.drones) {
          const oldBody = suspended.physicsBody
          const oldState = oldBody.state
          const retainedBody = world.getDrone(suspended.id)
          if (retainedBody && retainedBody !== oldBody) {
            throw new Error(`Cannot restore drone ${suspended.id}: its physics ID is already owned`)
          }
          const createdBody = retainedBody === undefined
          const body =
            retainedBody ??
            world.createDrone(
              suspended.id,
              oldBody.params,
              oldState.position,
              suspended.mesh ?? undefined
            )
          const managed = { ...suspended, physicsBody: body }
          // Track ownership immediately. Any later Rapier setter or scene event
          // can throw. Rollback removes only a body created by this attempt and
          // preserves a retained body whose earlier detach reported failure.
          restored.push({ drone: managed, createdBody })
          dronesRef.current.set(managed.id, managed)
          body.state.position.copy(oldState.position)
          body.state.velocity.copy(oldState.velocity)
          body.state.acceleration.copy(oldState.acceleration)
          body.state.orientation.copy(oldState.orientation).normalize()
          body.state.angularVelocity.copy(oldState.angularVelocity)
          body.state.battery = oldState.battery
          body.state.rotors = oldState.rotors.map((rotor) => ({
            ...rotor,
            position: rotor.position.clone(),
          }))
          body.setMotorCommands(oldBody.targetCommands)
          body.setArmed(oldState.armed)
          body.rigidBody?.setTranslation(oldState.position, true)
          body.rigidBody?.setRotation(body.state.orientation, true)
          body.rigidBody?.setLinvel(oldState.velocity, true)
          body.rigidBody?.setAngvel(oldState.angularVelocity, true)
          if (suspended.mesh) {
            suspended.mesh.position.copy(oldState.position)
            suspended.mesh.quaternion.copy(body.state.orientation)
            const attachment = attachObject3DToScene(scene, suspended.mesh, `drone ${suspended.id}`)
            if (!attachment.attached) {
              throw new AggregateError(
                attachment.errors,
                `Cannot restore drone ${suspended.id} mesh`
              )
            }
            if (attachment.errors.length > 0) {
              log.warn('Drone mesh attached with scene-event failures', {
                id: suspended.id,
                count: attachment.errors.length,
                firstError: attachment.errors[0],
              })
            }
          }
        }
      } catch (error) {
        const cleanupErrors: unknown[] = []
        for (const { drone, createdBody } of restored) {
          if (drone.mesh) {
            try {
              scene.remove(drone.mesh)
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError)
            }
            if (drone.mesh.parent !== null) {
              cleanupErrors.push(
                new Error(`Restored drone ${drone.id} did not detach during rollback`)
              )
            }
          }
          if (createdBody) {
            try {
              world.removeDrone(drone.id)
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError)
            }
            if (world.getDrone(drone.id) === drone.physicsBody) {
              const retained = suspension.drones.find((entry) => entry.id === drone.id)
              if (retained) retained.physicsBody = drone.physicsBody
            }
          }
        }
        dronesRef.current.clear()
        updateDronesList()
        if (cleanupErrors.length > 0) {
          log.warn('Failed to fully roll back a suspended drone restoration', {
            count: cleanupErrors.length,
            firstError: cleanupErrors[0],
          })
        }
        throw error
      }

      suspension.state = 'restored'
      pendingDroneDisposalsRef.current.delete(suspension)
      droneCounterRef.current = suspension.droneCounter
      updateDronesList()
      setSelectedDroneId(
        suspension.selectedDroneId && dronesRef.current.has(suspension.selectedDroneId)
          ? suspension.selectedDroneId
          : null
      )
      commitSimulationPauseState(
        isPausedRef,
        setIsPaused,
        () => world.resetTime(),
        suspension.wasPaused
      )
    },
    [enabled, updateDronesList]
  )

  const disposeSuspendedDrones = useCallback((suspension: SuspendedDroneScene): boolean => {
    if (suspension.state !== 'suspended') return suspension.state === 'disposed'
    const errors: unknown[] = []
    const world = physicsWorldRef.current
    let allReleased = true
    for (const drone of suspension.drones) {
      const result = detachManagedDroneResources(sceneRef.current, world, drone)
      errors.push(...result.errors)
      allReleased &&= result.released
    }
    if (!allReleased) {
      pendingDroneDisposalsRef.current.add(suspension)
      log.warn('Suspended drone cleanup retains live resources for a retry', {
        count: errors.length,
        firstError: errors[0],
      })
      return false
    }
    for (const drone of suspension.drones) disposeDetachedDroneMesh(drone, errors)
    suspension.state = 'disposed'
    pendingDroneDisposalsRef.current.delete(suspension)
    if (errors.length > 0) {
      log.warn('Suspended drone resources detached with disposal failures', {
        count: errors.length,
        firstError: errors[0],
      })
    }
    return true
  }, [])

  useEffect(() => {
    const pending = pendingDroneDisposalsRef.current
    return () => {
      for (const suspension of [...pending]) disposeSuspendedDrones(suspension)
    }
  }, [disposeSuspendedDrones, enabled])

  const { keyState, getControlInput, setArmed } = useKeyboardControls({
    enabled: enabled && selectedDroneId !== null,
    onArm: () => {
      if (!enabled) return
      const drone = selectedDroneId ? dronesRef.current.get(selectedDroneId) : null
      if (drone) {
        drone.physicsBody.setArmed(true)
        updateDronesList()
      }
    },
    onDisarm: () => {
      if (!enabled) return
      const drone = selectedDroneId ? dronesRef.current.get(selectedDroneId) : null
      if (drone) {
        drone.physicsBody.setArmed(false)
        updateDronesList()
      }
    },
    onEmergency: () => {
      if (!enabled) return
      dronesRef.current.forEach((drone) => {
        drone.physicsBody.setArmed(false)
      })
      updateDronesList()
    },
  })
  useEffect(() => {
    if (!enabled) {
      // A disabled controller owns no physics world or drone state. React runs
      // the preceding enabled effect's cleanup before this branch, so publish
      // the cleared public state without issuing state updates during unmount.
      updateDronesList()
      setSelectedDroneId(null)
      isPausedRef.current = true
      setIsPaused(true)
      setPhysicsReady(false)
      return
    }

    let mounted = true
    // Stable Map identity snapshotted for the cleanup (the ref is never
    // reassigned, only mutated).
    const drones = dronesRef.current

    const initPhysics = async () => {
      const world = new DronePhysicsWorld()
      await world.init()
      if (mounted) {
        physicsWorldRef.current = world
        setPhysicsReady(true)
      } else {
        try {
          world.destroy()
        } catch (error) {
          log.warn('Late physics initialization cleanup failed after unmount', { error })
        }
      }
    }

    void initPhysics().catch((error: unknown) => {
      if (!mounted) return
      setPhysicsReady(false)
      log.error('Drone physics initialization failed', { error })
    })

    return () => {
      mounted = false
      spawnGenerationRef.current += 1
      const retiring = Array.from(drones.values())
      const world = physicsWorldRef.current
      const activeScene = sceneRef.current
      // Publish both tombstones before cleanup. Three.js and Rapier can invoke
      // synchronous callbacks, and reentrant code must not observe retired state.
      drones.clear()
      physicsWorldRef.current = null
      const cleanupErrors: unknown[] = []
      for (const drone of retiring) {
        const result = detachManagedDroneResources(activeScene, world, drone)
        cleanupErrors.push(...result.errors)
        if (result.released) disposeDetachedDroneMesh(drone, cleanupErrors)
      }
      try {
        world?.destroy()
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupErrors.length > 0) {
        log.warn('Drone controller unmounted with resource-cleanup failures', {
          count: cleanupErrors.length,
          firstError: cleanupErrors[0],
        })
      }
    }
  }, [enabled, updateDronesList])

  const loadDroneModel = useCallback(
    (droneType: DroneTypeDefinition) => loadDroneModelAsset(loaderRef.current, droneType),
    []
  )

  const spawnDrone = useCallback(
    async (
      typeId: string,
      customName?: string,
      position?: THREE.Vector3,
      initialState?: DroneSpawnState
    ): Promise<string | null> => {
      if (!enabled) return null
      const initialWorld = physicsWorldRef.current
      const initialScene = sceneRef.current
      const spawnGeneration = spawnGenerationRef.current
      if (!initialWorld || !initialScene) {
        log.error('Spawn failed: Physics world or scene not ready', {
          physics: !!physicsWorldRef.current,
          scene: !!sceneRef.current,
        })
        return null
      }

      const droneType = DRONE_TYPES[typeId]
      if (!droneType) return null
      if (dronesRef.current.size + pendingDroneSpawnsRef.current.size >= MAX_MANAGED_DRONES) {
        log.warn('Spawn rejected: managed drone limit reached', { limit: MAX_MANAGED_DRONES })
        return null
      }
      if (customName !== undefined && !isBoundedSceneName(customName)) {
        log.warn('Spawn rejected: drone name is invalid')
        return null
      }
      const requestedId = initialState?.id
      if (requestedId !== undefined && !isBoundedSceneName(requestedId)) {
        log.warn('Spawn rejected: drone id is invalid')
        return null
      }
      if (
        requestedId !== undefined &&
        (dronesRef.current.has(requestedId) ||
          initialWorld.getDrone(requestedId) !== undefined ||
          pendingDroneIdsRef.current.has(requestedId))
      ) {
        log.warn('Spawn rejected: duplicate drone id', { id: requestedId })
        return null
      }

      const spawnPos = position
        ? position.clone()
        : new THREE.Vector3(
            (Math.random() - 0.5) * 10,
            5 + Math.random() * 5,
            (Math.random() - 0.5) * 10
          )
      try {
        validateDroneSpawnState(spawnPos, initialState)
      } catch (error) {
        log.error('Spawn rejected before model load', { error })
        return null
      }

      const spawnToken = Symbol('drone-spawn')
      pendingDroneSpawnsRef.current.add(spawnToken)
      if (requestedId !== undefined) pendingDroneIdsRef.current.add(requestedId)
      try {
        let mesh: THREE.Object3D | null
        try {
          mesh = await loadDroneModel(droneType)
        } catch (error) {
          log.error('Spawn failed while loading the drone model', { typeId, error })
          return null
        }
        if (
          spawnGenerationRef.current !== spawnGeneration ||
          physicsWorldRef.current !== initialWorld ||
          sceneRef.current !== initialScene
        ) {
          if (mesh) {
            try {
              disposeObject3D(mesh)
            } catch (error) {
              log.warn('Stale drone model cleanup failed', { typeId, error })
            }
          }
          return null
        }

        droneCounterRef.current++
        const id = requestedId ?? `drone_${Date.now()}_${droneCounterRef.current}`
        const name =
          customName ?? `${droneType.name.split(' ')[0].toUpperCase()}-${droneCounterRef.current}`
        if (dronesRef.current.has(id) || initialWorld.getDrone(id) !== undefined) {
          if (mesh) disposeObject3D(mesh)
          log.error('Spawn failed: duplicate drone id', { id })
          return null
        }

        let managedDrone: ManagedDrone | null = null
        try {
          const rotorMeshes = mesh ? collectRotorMeshes(mesh) : []
          const flightController = new FlightController()
          const params = toQuadcopterParams(droneType)
          const physicsBody = initialWorld.createDrone(id, params, spawnPos)
          managedDrone = {
            id,
            type: typeId,
            name,
            physicsBody,
            flightController,
            mesh,
            rotorMeshes,
            route: {
              waypoints: [],
              mode: 'none',
              currentWaypointIndex: 0,
              isActive: false,
              arrivalThreshold: 2.0,
            },
          }

          if (initialState?.orientation) {
            physicsBody.state.orientation.copy(initialState.orientation).normalize()
            physicsBody.rigidBody?.setRotation(physicsBody.state.orientation, true)
          }
          if (initialState?.velocity) {
            physicsBody.state.velocity.copy(initialState.velocity)
            physicsBody.rigidBody?.setLinvel(initialState.velocity, true)
          }
          if (initialState?.angularVelocity) {
            physicsBody.state.angularVelocity.copy(initialState.angularVelocity)
            physicsBody.rigidBody?.setAngvel(initialState.angularVelocity, true)
          }
          if (initialState?.battery !== undefined) {
            physicsBody.state.battery = THREE.MathUtils.clamp(initialState.battery, 0, 1)
          }
          physicsBody.setArmed(initialState?.armed ?? true)

          if (mesh) {
            mesh.position.copy(spawnPos)
            mesh.quaternion.copy(physicsBody.state.orientation)
            physicsBody.mesh = mesh
            const attachment = attachObject3DToScene(initialScene, mesh, `drone ${id}`)
            if (!attachment.attached) {
              throw new AggregateError(attachment.errors, `Cannot activate drone ${id} mesh`)
            }
            if (attachment.errors.length > 0) {
              log.warn('Drone mesh attached with scene-event failures', {
                id,
                count: attachment.errors.length,
                firstError: attachment.errors[0],
              })
            }
          }

          dronesRef.current.set(id, managedDrone)
          updateDronesList()

          if (dronesRef.current.size === 1) {
            setSelectedDroneId(id)
          }

          return id
        } catch (error) {
          const cleanupErrors: unknown[] = []
          if (managedDrone) {
            if (dronesRef.current.get(id) === managedDrone) dronesRef.current.delete(id)
            const result = detachManagedDroneResources(initialScene, initialWorld, managedDrone)
            cleanupErrors.push(...result.errors)
            if (result.released) {
              disposeDetachedDroneMesh(managedDrone, cleanupErrors)
            } else if (
              !insertManagedDroneAt(dronesRef.current, managedDrone, dronesRef.current.size)
            ) {
              cleanupErrors.push(
                new Error(`Cannot retain partially spawned drone ${id}: its ID is already owned`)
              )
            }
          } else {
            // No managed owner exists until createDrone returns. The model is
            // still detached in this branch and can be reclaimed directly.
            if (initialWorld.getDrone(id) !== undefined) {
              try {
                initialWorld.removeDrone(id)
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError)
              }
            }
            if (mesh) {
              try {
                disposeObject3D(mesh)
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError)
              }
            }
          }
          updateDronesList()
          if (dronesRef.current.get(id) === managedDrone) setSelectedDroneId(id)
          log.error('Spawn failed after model load', {
            id,
            error,
            cleanupErrorCount: cleanupErrors.length,
            firstCleanupError: cleanupErrors[0],
          })
          return null
        }
      } finally {
        pendingDroneSpawnsRef.current.delete(spawnToken)
        if (requestedId !== undefined) pendingDroneIdsRef.current.delete(requestedId)
      }
    },
    [enabled, loadDroneModel, updateDronesList]
  )

  const removeDrone = useCallback(
    (id: string): boolean => {
      if (!enabled) return false
      const drone = dronesRef.current.get(id)
      if (!drone) return false
      const originalIndex = [...dronesRef.current.keys()].indexOf(id)
      const wasSelected = selectedDroneId === id

      // Publish the tombstone before Three.js or Rapier cleanup can dispatch a
      // synchronous callback. Reentrant removal must observe absence.
      dronesRef.current.delete(id)
      updateDronesList()

      const errors: unknown[] = []
      const result = detachManagedDroneResources(sceneRef.current, physicsWorldRef.current, drone)
      errors.push(...result.errors)
      if (result.released) {
        disposeDetachedDroneMesh(drone, errors)
      } else if (!insertManagedDroneAt(dronesRef.current, drone, originalIndex)) {
        errors.push(new Error(`Cannot retain drone ${id}: a different live drone owns its ID`))
      }
      updateDronesList()

      if (!result.released && dronesRef.current.get(id) === drone) {
        if (wasSelected) setSelectedDroneId(id)
      } else if (wasSelected) {
        const remaining = Array.from(dronesRef.current.keys())
        setSelectedDroneId(remaining.length > 0 ? remaining[0] : null)
      }
      if (errors.length > 0) {
        log.warn(
          result.released
            ? 'Drone removed with detached-resource disposal failures'
            : 'Drone cleanup retained resources for a later retry',
          { id, count: errors.length, firstError: errors[0] }
        )
      }
      return result.released
    },
    [enabled, selectedDroneId, updateDronesList]
  )

  const selectDrone = useCallback(
    (id: string | null) => {
      if (!enabled) return
      if (id !== null && !dronesRef.current.has(id)) return
      setSelectedDroneId(id)

      if (id) {
        const drone = dronesRef.current.get(id)
        if (drone) {
          setArmed(drone.physicsBody.state.armed)
        }
      }
    },
    [enabled, setArmed]
  )

  const renameDrone = useCallback(
    (id: string, newName: string): boolean => {
      if (!enabled || !isBoundedSceneName(newName)) return false
      const drone = dronesRef.current.get(id)
      if (!drone) return false

      drone.name = newName
      updateDronesList()
      return true
    },
    [enabled, updateDronesList]
  )

  const setRoute = useCallback(
    (
      droneId: string,
      waypoints: Waypoint[],
      mode: RouteMode,
      restored?: { isActive?: boolean; currentWaypointIndex?: number }
    ) => {
      if (!enabled || !Array.isArray(waypoints)) return false
      const drone = dronesRef.current.get(droneId)
      if (!drone) return false
      if (mode !== 'none' && mode !== 'once' && mode !== 'patrol') return false
      if (restored?.isActive !== undefined && typeof restored.isActive !== 'boolean') {
        return false
      }
      if (
        restored?.currentWaypointIndex !== undefined &&
        (!Number.isSafeInteger(restored.currentWaypointIndex) ||
          restored.currentWaypointIndex < 0 ||
          (waypoints.length === 0
            ? restored.currentWaypointIndex !== 0
            : restored.currentWaypointIndex >= waypoints.length))
      ) {
        return false
      }
      if (mode === 'none' && waypoints.length > 0) return false
      if (restored?.isActive === true && (mode === 'none' || waypoints.length === 0)) return false
      const maxAltitude = DRONE_TYPES[drone.type]?.physics.maxAltitude
      if (!isAdmissibleRouteWaypoints(waypoints, { maxAltitude })) return false

      const convertedWaypoints = waypoints.map((wp) => {
        const pos = wp.position as { x: number; y: number; z: number }
        return {
          position: new THREE.Vector3(pos.x, pos.y, pos.z),
          altitude: wp.altitude,
          ...(wp.speed === undefined ? {} : { speed: wp.speed }),
        }
      })

      drone.route = {
        waypoints: convertedWaypoints,
        mode,
        currentWaypointIndex: Math.min(
          restored?.currentWaypointIndex ?? 0,
          Math.max(convertedWaypoints.length - 1, 0)
        ),
        isActive: restored?.isActive ?? (convertedWaypoints.length > 0 && mode !== 'none'),
        arrivalThreshold: 2.0,
      }

      if (convertedWaypoints.length === 0 || mode === 'none') drone.route.isActive = false

      if (drone.route.isActive && !drone.physicsBody.state.armed) {
        drone.physicsBody.setArmed(true)
      }

      updateDronesList()
      return true
    },
    [enabled, updateDronesList]
  )

  const addWaypoint = useCallback(
    (droneId: string, waypoint: Waypoint) => {
      if (!enabled) return
      const drone = dronesRef.current.get(droneId)
      if (!drone) return
      const maxAltitude = DRONE_TYPES[drone.type]?.physics.maxAltitude
      if (
        drone.route.waypoints.length >= MAX_ROUTE_WAYPOINTS ||
        !isFiniteRouteWaypoint(waypoint, { maxAltitude })
      )
        return

      const position = waypoint.position as { x: number; y: number; z: number }
      drone.route.waypoints.push({
        position: new THREE.Vector3(position.x, position.y, position.z),
        altitude: waypoint.altitude,
        ...(waypoint.speed === undefined ? {} : { speed: waypoint.speed }),
      })
      updateDronesList()
    },
    [enabled, updateDronesList]
  )

  const clearRoute = useCallback(
    (droneId: string) => {
      if (!enabled) return
      const drone = dronesRef.current.get(droneId)
      if (!drone) return

      drone.route = {
        waypoints: [],
        mode: 'none',
        currentWaypointIndex: 0,
        isActive: false,
        arrivalThreshold: 2.0,
      }
      updateDronesList()
    },
    [enabled, updateDronesList]
  )

  const toggleRoute = useCallback(
    (droneId: string, active?: boolean) => {
      if (!enabled) return
      const drone = dronesRef.current.get(droneId)
      if (!drone || drone.route.waypoints.length === 0) return

      drone.route.isActive = active ?? !drone.route.isActive
      if (drone.route.isActive && drone.route.mode === 'none') {
        drone.route.mode = 'once'
      }
      updateDronesList()
    },
    [enabled, updateDronesList]
  )

  // Route control input through a ref: getControlInput's identity changes with
  // every keydown/keyup, and keeping it in the rAF effect deps would restart
  // the physics loop on each key event.
  const getControlInputRef = useRef(getControlInput)
  useEffect(() => {
    getControlInputRef.current = getControlInput
  }, [getControlInput])

  useEffect(() => {
    if (!enabled || !physicsReady || !physicsWorldRef.current) return

    let lastTime = performance.now()

    const update = () => {
      const now = performance.now()
      const elapsedSeconds = (now - lastTime) / 1000
      lastTime = now

      if (isPaused) {
        animationFrameRef.current = requestAnimationFrame(update)
        return
      }

      if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
        animationFrameRef.current = requestAnimationFrame(update)
        return
      }
      const dt = Math.min(elapsedSeconds, MAX_PHYSICS_DT_SECONDS)

      dronesRef.current.forEach((drone) => {
        const isSelected = drone.id === selectedDroneId

        if (drone.mesh) {
          const ring = drone.mesh.getObjectByName('selection_ring')
          if (ring) ring.visible = isSelected
        }

        if (!drone.physicsBody.state.armed) return

        const hasActiveRoute = drone.route.isActive && drone.route.waypoints.length > 0

        let targetRoll = 0
        let targetPitch = 0
        let targetYawRate = 0
        let targetAlt = drone.physicsBody.state.position.y

        if (hasActiveRoute) {
          const currentWaypoint = drone.route.waypoints[drone.route.currentWaypointIndex]
          if (currentWaypoint) {
            const pos = drone.physicsBody.state.position
            const dx = currentWaypoint.position.x - pos.x
            const dz = currentWaypoint.position.z - pos.z
            const distanceSquared = dx * dx + dz * dz
            const arrivalThresholdSquared =
              drone.route.arrivalThreshold * drone.route.arrivalThreshold

            if (distanceSquared < arrivalThresholdSquared) {
              const localVel = scratchVelocity
                .copy(drone.physicsBody.state.velocity)
                .applyQuaternion(
                  scratchQuaternion.copy(drone.physicsBody.state.orientation).invert()
                )

              const brakeGain = 0.4
              targetPitch = Math.max(-0.4, Math.min(0.4, -localVel.z * brakeGain))
              targetRoll = Math.max(-0.4, Math.min(0.4, -localVel.x * brakeGain))
              targetAlt = currentWaypoint.altitude

              const speedSquared = localVel.x * localVel.x + localVel.z * localVel.z
              if (speedSquared < 0.25) {
                drone.route.currentWaypointIndex++

                if (drone.route.currentWaypointIndex >= drone.route.waypoints.length) {
                  if (drone.route.mode === 'patrol') {
                    drone.route.currentWaypointIndex = 0
                  } else {
                    drone.route.isActive = false
                    drone.route.currentWaypointIndex = 0
                  }
                }
              }
            } else {
              const distXZ = Math.sqrt(distanceSquared)
              const targetHeading = Math.atan2(dx, dz)
              const currentHeading = scratchEuler.setFromQuaternion(
                drone.physicsBody.state.orientation,
                'YXZ'
              ).y

              let headingError = targetHeading - currentHeading
              while (headingError > Math.PI) headingError -= 2 * Math.PI
              while (headingError < -Math.PI) headingError += 2 * Math.PI

              targetYawRate = Math.max(-1.5, Math.min(1.5, headingError * 1.5))

              if (Math.abs(headingError) < Math.PI / 3) {
                const speed = currentWaypoint.speed ?? 1.0
                const slowdownDist = 8.0
                const minPitch = 0.05

                const approachFactor = Math.min(1.0, distXZ / slowdownDist)
                const maxPitch = 0.25 * speed
                targetPitch = minPitch + (maxPitch - minPitch) * approachFactor

                const alignmentFactor = 1.0 - Math.abs(headingError) / (Math.PI / 3)
                targetPitch *= alignmentFactor
              }

              targetAlt = currentWaypoint.altitude
            }
          }
        } else if (isSelected) {
          const input: DroneControlInput = getControlInputRef.current()
          const droneType = DRONE_TYPES[drone.type]

          if (
            droneType?.category === 'quadcopter' &&
            Math.abs(input.roll) < 0.05 &&
            Math.abs(input.pitch) < 0.05
          ) {
            const localVel = scratchVelocity
              .copy(drone.physicsBody.state.velocity)
              .applyQuaternion(scratchQuaternion.copy(drone.physicsBody.state.orientation).invert())

            const brakeGain = 0.35
            targetPitch = -localVel.z * brakeGain
            targetRoll = -localVel.x * brakeGain

            targetPitch = Math.max(-0.5, Math.min(0.5, targetPitch))
            targetRoll = Math.max(-0.5, Math.min(0.5, targetRoll))
          } else {
            targetRoll = input.roll * 0.5
            targetPitch = input.pitch * 0.5
          }

          targetYawRate = input.yaw * 2
          targetAlt = drone.physicsBody.state.position.y + (input.throttle - 0.5) * 2
        }

        const commands = drone.flightController.update(
          drone.physicsBody,
          targetRoll,
          targetPitch,
          targetYawRate,
          targetAlt,
          dt
        )

        drone.physicsBody.setMotorCommands(commands)
      })

      physicsWorldRef.current?.update()

      dronesRef.current.forEach((drone) => {
        drone.physicsBody.state.rotors.forEach((rotor, i) => {
          const rotorMesh = drone.rotorMeshes[i]
          if (rotorMesh) {
            rotorMesh.rotation.y += (rotor.rpm / 60) * dt * Math.PI * 2 * 0.1
          }
        })
      })

      animationFrameRef.current = requestAnimationFrame(update)
    }

    animationFrameRef.current = requestAnimationFrame(update)

    return () => {
      cancelAnimationFrame(animationFrameRef.current)
    }
  }, [enabled, physicsReady, isPaused, selectedDroneId])

  const getActiveDronesInfo = useCallback(() => {
    return Array.from(dronesRef.current.values()).map((drone) => ({
      id: drone.id,
      type: drone.type,
      name: drone.name,
      armed: drone.physicsBody.state.armed,
      battery: drone.physicsBody.state.battery,
      position: drone.physicsBody.state.position.clone(),
      velocity: drone.physicsBody.state.velocity.clone(),
    }))
  }, [])

  // ── DEV-ONLY: NCP → drone test bridge ──────────────────────────────────────
  // Additive, dev-gated in-browser injection point for manually exercising a
  // managed CREBAIN drone with wire-shaped NCP CommandFrames. It opens no NCP
  // transport or session; callers invoke the window helper directly.
  // It delegates the safety-critical parts to the SDK's ActionBuffer
  // (@sepahead/ncp) instead of hand-rolling them: seq >= 1 discipline (an
  // unstamped frame is dropped), the ttl_ms deadline (a stale frame HOLDs), the
  // active-mode allowlist, and a LATCHING ESTOP (once tripped, every later frame
  // HOLDs until reset()). It keeps CREBAIN-specific kinematics on top — a per-axis
  // velocity clamp, the integration-step clamp, and the altitude floor — which the
  // SDK does not own. The published wire gate runs before ActionBuffer for every
  // non-ESTOP command; a raw ESTOP still latches before validation by design.
  // This deliberately does NOT touch the owned NCP bridges (src/neuro,
  // src-tauri/src/ncp); it exists to verify that NCP action-plane input visibly
  // moves a real drone. Exposed on window only under Vite dev.
  useEffect(() => {
    if (!enabled || !import.meta.env.DEV || isEngramEmbeddedMode()) return
    // Safety limits for NCP-driven actuation (the kinematic layer the SDK does
    // not own; the SDK ActionBuffer owns seq/ttl/mode/latch).
    const MAX_NCP_VELOCITY_MS = 10 // per-axis velocity clamp (m/s)
    const clampUp = (y: number) => Math.max(0.1, y)
    const clampVelocity = (v: number) =>
      Number.isFinite(v) ? Math.max(-MAX_NCP_VELOCITY_MS, Math.min(MAX_NCP_VELOCITY_MS, v)) : 0
    // Physics-free "kinematic" drones (id -> mesh) so an NCP peer can drive a
    // visible drone even where the Rapier WASM runtime is unavailable.
    const kin = new Map<string, THREE.Object3D>()
    const commandStreams = new Map<
      string,
      { stream: DevNcpCommandStream; lastApplyS: number | null }
    >()
    let kinCounter = 0
    const streamFor = (id: string) => {
      let state = commandStreams.get(id)
      if (!state) {
        state = { stream: new DevNcpCommandStream(), lastApplyS: null }
        commandStreams.set(id, state)
      }
      return state
    }
    const posOf = (id: string): { x: number; y: number; z: number } | null => {
      const m = kin.get(id)
      if (m) return { x: m.position.x, y: m.position.y, z: m.position.z }
      const body = physicsWorldRef.current?.getDrone(id)
      if (!body) return null
      const sp = body.state.position
      return { x: sp.x, y: sp.y, z: sp.z }
    }
    const moveTo = (id: string, x: number, y: number, z: number): boolean => {
      const m = kin.get(id)
      if (m) {
        m.position.set(x, clampUp(y), z)
        return true
      }
      const body = physicsWorldRef.current?.getDrone(id)
      if (!body) return false
      body.state.position.set(x, clampUp(y), z)
      body.rigidBody?.setTranslation({ x, y: clampUp(y), z }, true)
      body.rigidBody?.setLinvel({ x: 0, y: 0, z: 0 }, true)
      body.syncMesh()
      return true
    }
    const bridge = {
      // Rapier-backed spawn (production path).
      async spawn(x = 0, y = 1.5, z = 0): Promise<string | null> {
        return spawnDrone('maverick', 'NCP-UAV', new THREE.Vector3(x, clampUp(y), z))
      },
      // Physics-free spawn: a visible drone mesh moved purely by NCP setpoints.
      spawnKinematic(x = 0, y = 1.5, z = 0, scale = 2.5): string {
        validateDevNcpKinematicSpawn(x, y, z, scale)
        assertDevNcpEntityCapacity(kin.size, physicsWorldRef.current?.getAllDrones().length ?? 0)
        const type = DRONE_TYPES['maverick'] ?? Object.values(DRONE_TYPES)[0]
        const mesh = createPlaceholderDrone(type)
        mesh.scale.setScalar(scale)
        mesh.position.set(x, clampUp(y), z)
        const activeScene = sceneRef.current
        if (!activeScene) {
          disposeObject3D(mesh)
          throw new Error('Cannot spawn a kinematic drone without an active scene')
        }
        const attachment = attachObject3DToScene(activeScene, mesh, 'dev NCP kinematic drone')
        if (!attachment.attached) {
          const cleanupErrors = [...attachment.errors]
          if (mesh.parent === null) {
            try {
              disposeObject3D(mesh)
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError)
            }
          } else {
            cleanupErrors.push(
              new Error('Kinematic drone is attached to an unexpected scene graph')
            )
          }
          throw new AggregateError(cleanupErrors, 'Kinematic drone activation failed', {
            cause: attachment.errors[0],
          })
        }
        if (attachment.errors.length > 0) {
          log.warn('Kinematic drone attached with scene-event failures', {
            count: attachment.errors.length,
            firstError: attachment.errors[0],
          })
        }
        const id = `ncp-kin-${++kinCounter}`
        kin.set(id, mesh)
        return id
      },
      list(): string[] {
        return [...kin.keys(), ...(physicsWorldRef.current?.getAllDrones().map((d) => d.id) ?? [])]
      },
      pose(id: string) {
        return posOf(id)
      },
      // Apply one NCP CommandFrame. The SDK ActionBuffer owns the safety-critical
      // decision (seq >= 1 discipline, ttl_ms deadline, active-mode allowlist,
      // latching ESTOP); this bridge only clamps the resulting setpoint and
      // integrates it kinematically. `active(now)` returns the setpoint channels
      // to apply, or null to HOLD (fail-safe to zero velocity).
      applyCommand(id: string, frame: unknown) {
        const p = posOf(id)
        if (!p) return null
        const nowS = performance.now() / 1000
        const state = streamFor(id)
        const step = boundedDevNcpElapsed(state.lastApplyS, nowS)
        state.lastApplyS = nowS
        let command: CommandLike
        try {
          command = state.stream.ingest(nowS, frame)
        } catch (error) {
          log.warn('Dropped unsafe dev NCP command', {
            error: error instanceof Error ? error.message : String(error),
          })
          return {
            pose: posOf(id),
            mode: isRecord(frame) && frame.mode === 'estop' ? 'estop' : 'hold',
            applied: [0, 0, 0] as [number, number, number],
            held: true,
            estopped: state.stream.isEstopped(),
          }
        }
        const setpoint = state.stream.active(nowS) // null => HOLD (stale/estop/non-active)
        let v: [number, number, number] = [0, 0, 0]
        let held = setpoint === null
        if (setpoint) {
          const velocity = setpoint.velocity_setpoint
          const ch = velocity?.data
          if (
            velocity?.unit === 'm/s' &&
            Array.isArray(ch) &&
            ch.length === 3 &&
            ch.every(Number.isFinite)
          ) {
            v = [clampVelocity(ch[0]), clampVelocity(ch[1]), clampVelocity(ch[2])]
          } else {
            held = true
          }
        }
        // Axis convention: the wire [x, y, z] is applied directly to three.js
        // world coordinates (Y-up; v[1] is the altitude rate). The Rust `ncp`
        // feature path emits only a local `VelocitySetpointProposal` with a
        // caller-supplied frame identity; it performs no MAVROS or actuator
        // mapping.
        moveTo(id, p.x + v[0] * step, p.y + v[1] * step, p.z + v[2] * step)
        return {
          pose: posOf(id),
          mode: command.mode,
          applied: v,
          held,
          estopped: state.stream.isEstopped(),
        }
      },
      // Development reset authority: replace stream state so clearing ESTOP cannot
      // resurrect a command buffered before or during the latch.
      reset(id?: string) {
        if (id === undefined) commandStreams.clear()
        else commandStreams.delete(id)
      },
    }
    const w = window as unknown as { __ncpDrone?: typeof bridge }
    w.__ncpDrone = bridge
    return () => {
      for (const mesh of kin.values()) {
        try {
          mesh.removeFromParent()
        } catch (error) {
          log.warn('Failed to remove a dev NCP kinematic mesh', { error })
        }
        try {
          disposeObject3D(mesh)
        } catch (error) {
          log.warn('Failed to dispose a dev NCP kinematic mesh', { error })
        }
      }
      kin.clear()
      commandStreams.clear()
      delete w.__ncpDrone
    }
  }, [enabled, spawnDrone])

  return {
    drones,
    physicsReady,
    selectedDroneId,
    keyState,
    spawnDrone,
    removeDrone,
    selectDrone,
    setRoute,
    addWaypoint,
    clearRoute,
    toggleRoute,
    renameDrone,
    getActiveDronesInfo,
    physicsWorld: physicsWorldRef.current,
    isPaused,
    togglePause,
    setSimulationPaused,
    resetSimulation,
    suspendDronesForSceneRestore,
    restoreSuspendedDrones,
    disposeSuspendedDrones,
  }
}

export default useDroneController
