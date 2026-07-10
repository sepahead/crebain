/**
 * CREBAIN Drone Controller Hook
 * Connects keyboard input to drone physics simulation
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DronePhysicsWorld, type DronePhysicsBody, FlightController } from '../physics/DronePhysics'
import { DRONE_TYPES, toQuadcopterParams, type DroneTypeDefinition } from '../physics/DroneTypes'
import { useKeyboardControls, type DroneControlInput } from './useKeyboardControls'
import { logger } from '../lib/logger'
import { disposeObject3D, forEachMesh } from '../lib/three/sceneObjects'
// The SDK plant-side deadline/seq/latch primitive for the dev NCP→drone bridge.
import { ActionBuffer } from '@sepahead/ncp'

const log = logger.scope('DroneController')

// Reused scratches to avoid allocating a THREE.Euler / Vector3 / Quaternion
// every frame in the physics rAF loop.
const scratchEuler = new THREE.Euler()
const scratchVelocity = new THREE.Vector3()
const scratchQuaternion = new THREE.Quaternion()

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
  /** Rotor meshes cached at spawn (index order matches physics rotors) so the
   *  rAF loop can spin them without per-frame getObjectByName lookups. */
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

interface UseDroneControllerOptions {
  scene: THREE.Scene | null
  enabled?: boolean
  onDroneStateChange?: (drones: ManagedDrone[]) => void
}

/**
 * Build a simple procedural placeholder mesh for a drone type, used when a model
 * is missing or fails to load. Pure factory (depends only on `droneType`), kept at
 * module scope so it is not a React dependency.
 */
function createPlaceholderDrone(droneType: DroneTypeDefinition): THREE.Object3D {
  const group = new THREE.Group()

  if (droneType.category === 'quadcopter' || droneType.category === 'hexacopter') {
    const bodyGeom = new THREE.BoxGeometry(0.2, 0.05, 0.2)
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x333333 })
    const body = new THREE.Mesh(bodyGeom, bodyMat)
    group.add(body)

    const armLength = droneType.physics.armLength || 0.175
    const rotorCount = droneType.physics.rotorCount || 4

    for (let i = 0; i < rotorCount; i++) {
      const angle = (i / rotorCount) * Math.PI * 2 + Math.PI / 4
      const x = Math.cos(angle) * armLength
      const z = Math.sin(angle) * armLength

      const armGeom = new THREE.CylinderGeometry(0.01, 0.01, armLength * 0.7)
      const armMat = new THREE.MeshStandardMaterial({ color: 0x444444 })
      const arm = new THREE.Mesh(armGeom, armMat)
      arm.position.set(x * 0.5, 0, z * 0.5)
      arm.rotation.z = Math.PI / 2
      arm.rotation.y = angle
      group.add(arm)

      const rotorGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.01, 16)
      const rotorMat = new THREE.MeshStandardMaterial({
        color: 0x666666,
        transparent: true,
        opacity: 0.5,
      })
      const rotor = new THREE.Mesh(rotorGeom, rotorMat)
      rotor.position.set(x, 0.03, z)
      rotor.name = `rotor_${i}`
      group.add(rotor)
    }
  } else if (droneType.category === 'loitering_munition' || droneType.category === 'fixed_wing') {
    const wingGeom = new THREE.ConeGeometry(0.5, 1.5, 3)
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a })
    const wing = new THREE.Mesh(wingGeom, wingMat)
    wing.rotation.x = Math.PI / 2
    wing.rotation.z = Math.PI
    group.add(wing)
  }

  return group
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
  const [selectedDroneId, setSelectedDroneId] = useState<string | null>(null)
  const [isPaused, setIsPaused] = useState(true)
  const animationFrameRef = useRef<number>(0)
  const loaderRef = useRef<GLTFLoader | null>(null)
  const droneCounterRef = useRef(0)
  const spawnGenerationRef = useRef(0)

  if (!loaderRef.current) {
    loaderRef.current = new GLTFLoader()
  }

  const updateDronesList = useCallback(() => {
    const dronesList = Array.from(dronesRef.current.values())
    setDrones(dronesList)
    onDroneStateChange?.(dronesList)
  }, [onDroneStateChange])

  const togglePause = useCallback(() => {
    if (isPaused) {
      // Reset time to avoid physics jump after resume
      physicsWorldRef.current?.resetTime()
    }
    setIsPaused((prev) => !prev)
  }, [isPaused])

  const setSimulationPaused = useCallback((paused: boolean) => {
    setIsPaused((wasPaused) => {
      if (wasPaused && !paused) physicsWorldRef.current?.resetTime()
      return paused
    })
  }, [])

  const resetSimulation = useCallback(
    (pausedAfterReset = false) => {
      // Invalidate model loads that began before this reset. The world and scene
      // objects intentionally keep their identity, so identity checks alone
      // cannot distinguish a stale spawn from the new simulation generation.
      spawnGenerationRef.current += 1
      dronesRef.current.forEach((drone) => {
        if (drone.mesh && sceneRef.current) {
          sceneRef.current.remove(drone.mesh)
          disposeObject3D(drone.mesh)
        }
        physicsWorldRef.current?.removeDrone(drone.id)
      })
      dronesRef.current.clear()
      updateDronesList()
      setSelectedDroneId(null)
      setIsPaused(pausedAfterReset)
    },
    [updateDronesList]
  )

  const { keyState, getControlInput, setArmed } = useKeyboardControls({
    enabled: enabled && selectedDroneId !== null,
    onArm: () => {
      const drone = selectedDroneId ? dronesRef.current.get(selectedDroneId) : null
      if (drone) {
        drone.physicsBody.setArmed(true)
        updateDronesList()
      }
    },
    onDisarm: () => {
      const drone = selectedDroneId ? dronesRef.current.get(selectedDroneId) : null
      if (drone) {
        drone.physicsBody.setArmed(false)
        updateDronesList()
      }
    },
    onEmergency: () => {
      dronesRef.current.forEach((drone) => {
        drone.physicsBody.setArmed(false)
      })
      updateDronesList()
    },
  })
  useEffect(() => {
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
        world.destroy()
      }
    }

    void initPhysics()

    return () => {
      mounted = false
      spawnGenerationRef.current += 1
      // Remove and dispose spawned drone meshes (same loop as resetSimulation)
      // before destroying the world — scene removal alone leaks GPU resources.
      drones.forEach((drone) => {
        if (drone.mesh && sceneRef.current) {
          sceneRef.current.remove(drone.mesh)
          disposeObject3D(drone.mesh)
        }
        physicsWorldRef.current?.removeDrone(drone.id)
      })
      drones.clear()
      physicsWorldRef.current?.destroy()
      physicsWorldRef.current = null
      setPhysicsReady(false)
    }
  }, [])

  const loadDroneModel = useCallback(
    async (droneType: DroneTypeDefinition): Promise<THREE.Object3D | null> => {
      if (!loaderRef.current) return null
      return new Promise((resolve) => {
        loaderRef.current!.load(
          droneType.modelPath,
          (gltf) => {
            const model = gltf.scene.clone()
            const box = new THREE.Box3().setFromObject(model)

            if (!box.isEmpty()) {
              const center = box.getCenter(new THREE.Vector3())
              const size = box.getSize(new THREE.Vector3())

              const wrapper = new THREE.Group()
              wrapper.name = 'drone_wrapper'
              model.position.sub(center)
              wrapper.add(model)

              let rotorIdx = 0
              forEachMesh(model, (mesh) => {
                if (
                  mesh.name.toLowerCase().includes('rotor') ||
                  mesh.name.toLowerCase().includes('prop')
                ) {
                  mesh.name = `rotor_${rotorIdx++}`
                }
              })

              const ringRadius = Math.max(size.x, size.z) * 0.6
              const ringGeom = new THREE.RingGeometry(ringRadius, ringRadius * 1.1, 32)
              const ringMat = new THREE.MeshBasicMaterial({
                color: 0x00ff00,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.8,
              })
              const ring = new THREE.Mesh(ringGeom, ringMat)
              ring.rotation.x = -Math.PI / 2
              ring.position.y = -size.y * 0.5 - 0.05
              ring.name = 'selection_ring'
              ring.visible = false
              wrapper.add(ring)

              wrapper.scale.setScalar(1)
              resolve(wrapper)
            } else {
              log.warn(`Model ${droneType.id} has empty bounds, using placeholder`)
              const placeholder = createPlaceholderDrone(droneType)
              resolve(placeholder)
            }
          },
          undefined,
          () => {
            const placeholder = createPlaceholderDrone(droneType)

            const ringGeom = new THREE.RingGeometry(0.6, 0.7, 32)
            const ringMat = new THREE.MeshBasicMaterial({
              color: 0x00ff00,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.8,
            })
            const ring = new THREE.Mesh(ringGeom, ringMat)
            ring.rotation.x = -Math.PI / 2
            ring.name = 'selection_ring'
            ring.visible = false
            placeholder.add(ring)

            resolve(placeholder)
          }
        )
      })
    },
    []
  )

  const spawnDrone = useCallback(
    async (
      typeId: string,
      customName?: string,
      position?: THREE.Vector3,
      initialState?: DroneSpawnState
    ): Promise<string | null> => {
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

      const spawnPos = position
        ? position.clone()
        : new THREE.Vector3(
            (Math.random() - 0.5) * 10,
            5 + Math.random() * 5,
            (Math.random() - 0.5) * 10
          )

      const mesh = await loadDroneModel(droneType)
      if (
        spawnGenerationRef.current !== spawnGeneration ||
        physicsWorldRef.current !== initialWorld ||
        sceneRef.current !== initialScene
      ) {
        if (mesh) disposeObject3D(mesh)
        return null
      }

      droneCounterRef.current++
      const id = initialState?.id || `drone_${Date.now()}_${droneCounterRef.current}`
      const name =
        customName || `${droneType.name.split(' ')[0].toUpperCase()}-${droneCounterRef.current}`
      if (dronesRef.current.has(id)) {
        if (mesh) disposeObject3D(mesh)
        log.error('Spawn failed: duplicate drone id', { id })
        return null
      }

      const params = toQuadcopterParams(droneType)
      const physicsBody = initialWorld.createDrone(id, params, spawnPos)
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
        initialScene.add(mesh)
        physicsBody.mesh = mesh
      }

      const flightController = new FlightController()

      const route: DroneRoute = {
        waypoints: [],
        mode: 'none',
        currentWaypointIndex: 0,
        isActive: false,
        arrivalThreshold: 2.0,
      }

      const managedDrone: ManagedDrone = {
        id,
        type: typeId,
        name,
        physicsBody,
        flightController,
        mesh,
        rotorMeshes: mesh ? collectRotorMeshes(mesh) : [],
        route,
      }

      dronesRef.current.set(id, managedDrone)
      updateDronesList()

      if (dronesRef.current.size === 1) {
        setSelectedDroneId(id)
      }

      return id
    },
    [loadDroneModel, updateDronesList]
  )

  const removeDrone = useCallback(
    (id: string) => {
      const drone = dronesRef.current.get(id)
      if (!drone) return

      if (drone.mesh && sceneRef.current) {
        sceneRef.current.remove(drone.mesh)
        disposeObject3D(drone.mesh)
      }

      physicsWorldRef.current?.removeDrone(id)

      dronesRef.current.delete(id)
      updateDronesList()

      if (selectedDroneId === id) {
        const remaining = Array.from(dronesRef.current.keys())
        setSelectedDroneId(remaining.length > 0 ? remaining[0] : null)
      }
    },
    [selectedDroneId, updateDronesList]
  )

  const selectDrone = useCallback(
    (id: string | null) => {
      setSelectedDroneId(id)

      if (id) {
        const drone = dronesRef.current.get(id)
        if (drone) {
          setArmed(drone.physicsBody.state.armed)
        }
      }
    },
    [setArmed]
  )

  const renameDrone = useCallback(
    (id: string, newName: string) => {
      const drone = dronesRef.current.get(id)
      if (!drone) return

      drone.name = newName
      updateDronesList()
    },
    [updateDronesList]
  )

  const setRoute = useCallback(
    (
      droneId: string,
      waypoints: Waypoint[],
      mode: RouteMode,
      restored?: { isActive?: boolean; currentWaypointIndex?: number }
    ) => {
      const drone = dronesRef.current.get(droneId)
      if (!drone) return

      const convertedWaypoints = waypoints.map((wp) => {
        const pos = wp.position as { x: number; y: number; z: number }
        return {
          ...wp,
          position:
            wp.position instanceof THREE.Vector3
              ? wp.position
              : new THREE.Vector3(pos.x, pos.y, pos.z),
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
    },
    [updateDronesList]
  )

  const addWaypoint = useCallback(
    (droneId: string, waypoint: Waypoint) => {
      const drone = dronesRef.current.get(droneId)
      if (!drone) return

      drone.route.waypoints.push(waypoint)
      updateDronesList()
    },
    [updateDronesList]
  )

  const clearRoute = useCallback(
    (droneId: string) => {
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
    [updateDronesList]
  )

  const toggleRoute = useCallback(
    (droneId: string, active?: boolean) => {
      const drone = dronesRef.current.get(droneId)
      if (!drone || drone.route.waypoints.length === 0) return

      drone.route.isActive = active ?? !drone.route.isActive
      if (drone.route.isActive && drone.route.mode === 'none') {
        drone.route.mode = 'once'
      }
      updateDronesList()
    },
    [updateDronesList]
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
      const dt = (now - lastTime) / 1000
      lastTime = now

      if (isPaused) {
        animationFrameRef.current = requestAnimationFrame(update)
        return
      }

      dronesRef.current.forEach((drone) => {
        if (!drone.physicsBody.state.armed) return

        const isSelected = drone.id === selectedDroneId

        if (drone.mesh) {
          const ring = drone.mesh.getObjectByName('selection_ring')
          if (ring) ring.visible = isSelected
        }

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
            const distXZ = Math.sqrt(dx * dx + dz * dz)

            if (distXZ < drone.route.arrivalThreshold) {
              const localVel = scratchVelocity
                .copy(drone.physicsBody.state.velocity)
                .applyQuaternion(
                  scratchQuaternion.copy(drone.physicsBody.state.orientation).invert()
                )

              const brakeGain = 0.4
              targetPitch = Math.max(-0.4, Math.min(0.4, -localVel.z * brakeGain))
              targetRoll = Math.max(-0.4, Math.min(0.4, -localVel.x * brakeGain))
              targetAlt = currentWaypoint.altitude

              const speed = Math.sqrt(localVel.x * localVel.x + localVel.z * localVel.z)
              if (speed < 0.5) {
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
  // Additive, dev-gated injection point that lets an external NCP peer drive a
  // managed CREBAIN drone from wire-0.6 CommandFrames (velocity_setpoint in m/s).
  // Since wire 0.6 it delegates the safety-critical parts to the SDK's ActionBuffer
  // (@sepahead/ncp) instead of hand-rolling them: seq >= 1 discipline (an
  // unstamped frame is dropped), the ttl_ms deadline (a stale frame HOLDs), the
  // active-mode allowlist, and a LATCHING ESTOP (once tripped, every later frame
  // HOLDs until reset()). It keeps CREBAIN-specific kinematics on top — a per-axis
  // velocity clamp, the integration-step clamp, and the altitude floor — which the
  // SDK does not own. This is STRICTER than ncp-core's raw allowlist only in that
  // it exposes an explicit reset() for the dev latch.
  // This deliberately does NOT touch the owned NCP bridges (src/neuro,
  // src-tauri/src/ncp); it exists to verify that NCP action-plane input visibly
  // moves a real drone. Exposed on window only under Vite dev.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    interface NcpChannel {
      data?: number[]
      unit?: string
    }
    interface NcpCommandFrame {
      mode?: string
      seq?: number
      ttl_ms?: number
      channels?: Record<string, NcpChannel>
    }
    // Safety limits for NCP-driven actuation (the kinematic layer the SDK does
    // not own; the SDK ActionBuffer owns seq/ttl/mode/latch).
    const MAX_NCP_VELOCITY_MS = 10 // per-axis velocity clamp (m/s)
    const MAX_NCP_DT_S = 0.5 // integration step clamp (s)
    // The SDK deadline backstop + seq discipline + latching ESTOP for the bridge.
    const buffer = new ActionBuffer()
    const clampUp = (y: number) => Math.max(0.1, y)
    const clampVelocity = (v: number) =>
      Number.isFinite(v) ? Math.max(-MAX_NCP_VELOCITY_MS, Math.min(MAX_NCP_VELOCITY_MS, v)) : 0
    // Physics-free "kinematic" drones (id -> mesh) so an NCP peer can drive a
    // visible drone even where the Rapier WASM runtime is unavailable.
    const kin = new Map<string, THREE.Object3D>()
    let kinCounter = 0
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
        const type = DRONE_TYPES['maverick'] ?? Object.values(DRONE_TYPES)[0]
        const mesh = createPlaceholderDrone(type)
        mesh.scale.setScalar(scale)
        mesh.position.set(x, clampUp(y), z)
        sceneRef.current?.add(mesh)
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
      // Kinematic teleport (NCP-computed trajectory replay).
      setPose(id: string, x: number, y: number, z: number) {
        return moveTo(id, x, y, z)
      },
      // Apply one NCP CommandFrame. The SDK ActionBuffer owns the safety-critical
      // decision (seq >= 1 discipline, ttl_ms deadline, active-mode allowlist,
      // latching ESTOP); this bridge only clamps the resulting setpoint and
      // integrates it kinematically. `active(now)` returns the setpoint channels
      // to apply, or null to HOLD (fail-safe to zero velocity).
      applyCommand(id: string, frame: NcpCommandFrame, dt = 0.05) {
        const p = posOf(id)
        if (!p) return null
        const nowS = performance.now() / 1000
        // Ingest the frame; ActionBuffer drops seq<1, refreshes the deadline, and
        // latches on an ESTOP (fail-safe never dropped, stamped or not).
        buffer.onCommand(nowS, {
          mode: (frame?.mode ?? 'hold') as 'init' | 'active' | 'hold' | 'estop',
          seq: frame?.seq ?? 0,
          ttl_ms: frame?.ttl_ms,
          channels: (frame?.channels ?? {}) as Record<string, { data: number[]; unit?: string }>,
        })
        const setpoint = buffer.active(nowS) // null => HOLD (stale/estop/non-active/unstamped)
        let v: [number, number, number] = [0, 0, 0]
        const held = setpoint === null
        if (setpoint) {
          const ch = setpoint.velocity_setpoint?.data
          if (Array.isArray(ch) && ch.length >= 3) {
            v = [clampVelocity(ch[0]), clampVelocity(ch[1]), clampVelocity(ch[2])]
          }
        }
        const step = Number.isFinite(dt) ? Math.max(0, Math.min(MAX_NCP_DT_S, dt)) : 0
        // Axis convention: the wire [x, y, z] is applied directly to three.js
        // world coordinates (Y-up; v[1] is the altitude rate). The Rust `ncp`
        // feature path instead forwards the same vector as a MAVROS ENU
        // cmd_vel (Z-up) — peers must match the convention of the path they
        // target.
        moveTo(id, p.x + v[0] * step, p.y + v[1] * step, p.z + v[2] * step)
        return {
          pose: posOf(id),
          mode: frame?.mode ?? 'hold',
          applied: v,
          held,
          estopped: buffer.isEstopped(),
        }
      },
      // Supervisor authority: clear a latched ESTOP so the bridge can actuate again.
      reset() {
        buffer.reset()
      },
    }
    const w = window as unknown as { __ncpDrone?: typeof bridge }
    w.__ncpDrone = bridge
    return () => {
      for (const m of kin.values()) sceneRef.current?.remove(m)
      kin.clear()
      delete w.__ncpDrone
    }
  }, [spawnDrone])

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
  }
}

export default useDroneController
