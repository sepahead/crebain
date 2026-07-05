/**
 * CREBAIN Drone System Hook
 * Manages drone physics, spawning, and controls
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import DronePhysicsWorld, {
  type DronePhysicsBody,
  FlightController,
  type MotorCommands,
} from '../physics/DronePhysics'
import { DRONE_TYPES, toQuadcopterParams } from '../physics/DroneTypes'
import SensorSuite from '../physics/SensorSimulation'
import { disposeObject3D, forEachMesh } from '../lib/three/sceneObjects'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type FlightMode = 'manual' | 'stabilized' | 'altitude_hold' | 'position_hold' | 'waypoint'

export interface DroneInstance {
  id: string
  typeId: string
  physicsBody: DronePhysicsBody
  mesh: THREE.Object3D | null
  flightController: FlightController
  sensorSuite: SensorSuite
  flightMode: FlightMode
  targetAltitude: number
  targetPosition: THREE.Vector3
  waypoints: THREE.Vector3[]
}

export interface DroneControls {
  pitch: number // -1 to 1
  roll: number // -1 to 1
  yaw: number // -1 to 1
  throttle: number // 0 to 1
}

interface UseDroneSystemReturn {
  drones: DronePhysicsBody[]
  droneInstances: DroneInstance[]
  selectedDroneId: string | null
  isReady: boolean
  spawnDrone: (typeId: string, position: THREE.Vector3) => Promise<string>
  removeDrone: (id: string) => void
  selectDrone: (id: string | null) => void
  armDrone: (id: string, armed: boolean) => void
  setFlightMode: (id: string, mode: FlightMode) => void
  setControls: (id: string, controls: DroneControls) => void
  getDroneScene: () => THREE.Group
}

// ─────────────────────────────────────────────────────────────────────────────
// GLB MODEL CACHE
// ─────────────────────────────────────────────────────────────────────────────

const modelCache = new Map<string, THREE.Object3D>()
const gltfLoader = new GLTFLoader()

async function loadDroneModel(modelPath: string): Promise<THREE.Object3D> {
  if (modelCache.has(modelPath)) {
    return modelCache.get(modelPath)!.clone()
  }

  return new Promise((resolve) => {
    gltfLoader.load(
      modelPath,
      (gltf) => {
        const model = gltf.scene
        forEachMesh(model, (mesh) => {
          mesh.castShadow = true
          mesh.receiveShadow = true
        })
        modelCache.set(modelPath, model)
        resolve(model.clone())
      },
      undefined,
      () => {
        // Model load failed - use fallback mesh silently
        const fallback = createFallbackDroneMesh()
        resolve(fallback)
      }
    )
  })
}

function createFallbackDroneMesh(): THREE.Object3D {
  const group = new THREE.Group()

  // Body
  const bodyGeom = new THREE.BoxGeometry(0.3, 0.08, 0.3)
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x333333 })
  const body = new THREE.Mesh(bodyGeom, bodyMat)
  group.add(body)

  // Arms
  const armGeom = new THREE.BoxGeometry(0.4, 0.02, 0.02)
  const armMat = new THREE.MeshStandardMaterial({ color: 0x444444 })

  const arm1 = new THREE.Mesh(armGeom, armMat)
  arm1.rotation.y = Math.PI / 4
  group.add(arm1)

  const arm2 = new THREE.Mesh(armGeom, armMat)
  arm2.rotation.y = -Math.PI / 4
  group.add(arm2)

  // Rotors
  const rotorGeom = new THREE.CylinderGeometry(0.08, 0.08, 0.01, 16)
  const rotorMat = new THREE.MeshStandardMaterial({
    color: 0x666666,
    transparent: true,
    opacity: 0.5,
  })

  const positions = [
    [0.15, 0.04, 0.15],
    [0.15, 0.04, -0.15],
    [-0.15, 0.04, 0.15],
    [-0.15, 0.04, -0.15],
  ]

  positions.forEach(([x, y, z]) => {
    const rotor = new THREE.Mesh(rotorGeom, rotorMat)
    rotor.position.set(x, y, z)
    group.add(rotor)
  })

  return group
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useDroneSystem(scene: THREE.Scene | null): UseDroneSystemReturn {
  const physicsWorldRef = useRef<DronePhysicsWorld | null>(null)
  const droneInstancesRef = useRef<Map<string, DroneInstance>>(new Map())
  const droneSceneRef = useRef<THREE.Group>(new THREE.Group())
  const animationFrameRef = useRef<number>(0)
  const droneCounterRef = useRef<number>(0)

  const [isReady, setIsReady] = useState(false)
  const [selectedDroneId, setSelectedDroneId] = useState<string | null>(null)
  const [droneList, setDroneList] = useState<DronePhysicsBody[]>([])
  const [instanceList, setInstanceList] = useState<DroneInstance[]>([])

  // Control state for manual flight
  const controlsRef = useRef<Map<string, DroneControls>>(new Map())

  // Initialize physics world
  useEffect(() => {
    let mounted = true
    // Stable container identities snapshotted for the cleanup (the refs are
    // never reassigned, only mutated).
    const droneInstances = droneInstancesRef.current
    const controls = controlsRef.current
    const droneScene = droneSceneRef.current

    const initPhysics = async () => {
      const world = new DronePhysicsWorld()
      await world.init()
      if (!mounted) {
        // Unmounted (or scene changed) while the WASM world was initializing:
        // destroy the orphaned world instead of leaking it.
        world.destroy()
        return
      }
      physicsWorldRef.current = world

      // Add drone scene to main scene
      if (scene) {
        droneSceneRef.current.name = 'DroneScene'
        scene.add(droneSceneRef.current)
      }

      setIsReady(true)
    }

    void initPhysics()

    return () => {
      mounted = false
      cancelAnimationFrame(animationFrameRef.current)

      // Remove and dispose spawned drone meshes before tearing down the world
      // (three.js does not release GPU resources on scene removal).
      droneInstances.forEach((instance) => {
        if (instance.mesh) {
          droneScene.remove(instance.mesh)
          disposeObject3D(instance.mesh)
        }
        physicsWorldRef.current?.removeDrone(instance.id)
      })
      droneInstances.clear()
      controls.clear()
      scene?.remove(droneScene)

      physicsWorldRef.current?.destroy()
      physicsWorldRef.current = null
      setIsReady(false)
    }
  }, [scene])

  // Physics update loop
  useEffect(() => {
    if (!isReady) return

    let lastTime = performance.now()

    const updateLoop = () => {
      const world = physicsWorldRef.current
      if (!world) return

      // Real clamped elapsed time: flight-controller gains must not depend on
      // the monitor refresh rate (the physics world itself steps at a fixed
      // 120 Hz internally). Clamp matches DronePhysicsWorld.update().
      const now = performance.now()
      const dt = Math.min((now - lastTime) / 1000, 0.1)
      lastTime = now

      // Update each drone
      droneInstancesRef.current.forEach((instance) => {
        const { physicsBody, flightController, flightMode } = instance
        const controls = controlsRef.current.get(instance.id) || {
          pitch: 0,
          roll: 0,
          yaw: 0,
          throttle: 0.5,
        }

        if (physicsBody.state.armed) {
          let motorCommands: MotorCommands

          switch (flightMode) {
            case 'manual': {
              // Direct motor control (dangerous!)
              const baseThrottle = controls.throttle
              motorCommands = {
                front_left: Math.max(
                  0,
                  Math.min(
                    1,
                    baseThrottle + controls.pitch * 0.2 + controls.roll * 0.2 - controls.yaw * 0.1
                  )
                ),
                front_right: Math.max(
                  0,
                  Math.min(
                    1,
                    baseThrottle + controls.pitch * 0.2 - controls.roll * 0.2 + controls.yaw * 0.1
                  )
                ),
                rear_left: Math.max(
                  0,
                  Math.min(
                    1,
                    baseThrottle - controls.pitch * 0.2 + controls.roll * 0.2 + controls.yaw * 0.1
                  )
                ),
                rear_right: Math.max(
                  0,
                  Math.min(
                    1,
                    baseThrottle - controls.pitch * 0.2 - controls.roll * 0.2 - controls.yaw * 0.1
                  )
                ),
              }
              break
            }

            case 'stabilized':
            case 'altitude_hold':
            case 'position_hold':
            default: {
              // Use flight controller
              const targetRoll = controls.roll * 0.5 // Max 30 degrees
              const targetPitch = controls.pitch * 0.5
              const targetYawRate = controls.yaw * 2 // rad/s
              const targetAlt =
                flightMode === 'altitude_hold' || flightMode === 'position_hold'
                  ? instance.targetAltitude
                  : physicsBody.state.position.y + (controls.throttle - 0.5) * 2

              motorCommands = flightController.update(
                physicsBody,
                targetRoll,
                targetPitch,
                targetYawRate,
                targetAlt,
                dt
              )
              break
            }
          }

          physicsBody.setMotorCommands(motorCommands)
        }
      })

      // Step physics
      world.update()

      animationFrameRef.current = requestAnimationFrame(updateLoop)
    }

    updateLoop()

    return () => {
      cancelAnimationFrame(animationFrameRef.current)
    }
  }, [isReady])

  // Mirror the physics-loop drone lists into React state at a low fixed
  // cadence instead of per-rAF: fresh array identities every frame re-render
  // consumers at display refresh rate (pattern: useRosActuatorLoop). Bodies
  // are mutated in place, so identity only needs to change on membership.
  useEffect(() => {
    if (!isReady) return

    const sameMembers = <T>(a: T[], b: T[]) =>
      a.length === b.length && a.every((item, i) => item === b[i])

    const snapshotId = setInterval(() => {
      const world = physicsWorldRef.current
      if (!world) return
      const nextDrones = world.getAllDrones()
      const nextInstances = [...droneInstancesRef.current.values()]
      setDroneList((prev) => (sameMembers(prev, nextDrones) ? prev : nextDrones))
      setInstanceList((prev) => (sameMembers(prev, nextInstances) ? prev : nextInstances))
    }, 250)

    return () => clearInterval(snapshotId)
  }, [isReady])

  // Spawn a new drone
  const spawnDrone = useCallback(
    async (typeId: string, position: THREE.Vector3): Promise<string> => {
      const world = physicsWorldRef.current
      if (!world) throw new Error('Physics world not initialized')

      const droneType = DRONE_TYPES[typeId]
      if (!droneType) throw new Error(`Unknown drone type: ${typeId}`)

      // Generate ID
      droneCounterRef.current++
      const id = `${typeId.toUpperCase()}-${String(droneCounterRef.current).padStart(3, '0')}`

      // Load model
      const mesh = await loadDroneModel(droneType.modelPath)
      mesh.name = id
      mesh.scale.setScalar(droneType.physics.dimensions.x) // Scale based on drone size
      droneSceneRef.current.add(mesh)

      // Create physics body
      const params = toQuadcopterParams(droneType)
      const physicsBody = world.createDrone(id, params, position, mesh)

      // Create flight controller and sensors
      const flightController = new FlightController()
      const sensorSuite = new SensorSuite()

      // Create instance
      const instance: DroneInstance = {
        id,
        typeId,
        physicsBody,
        mesh,
        flightController,
        sensorSuite,
        flightMode: 'stabilized',
        targetAltitude: position.y,
        targetPosition: position.clone(),
        waypoints: [],
      }

      droneInstancesRef.current.set(id, instance)
      controlsRef.current.set(id, { pitch: 0, roll: 0, yaw: 0, throttle: 0.5 })

      // Auto-select new drone
      setSelectedDroneId(id)

      return id
    },
    []
  )

  // Remove a drone
  const removeDrone = useCallback(
    (id: string) => {
      const world = physicsWorldRef.current
      const instance = droneInstancesRef.current.get(id)

      if (instance?.mesh) {
        droneSceneRef.current.remove(instance.mesh)
      }

      if (world) {
        world.removeDrone(id)
      }

      droneInstancesRef.current.delete(id)
      controlsRef.current.delete(id)

      if (selectedDroneId === id) {
        setSelectedDroneId(null)
      }
    },
    [selectedDroneId]
  )

  // Select a drone
  const selectDrone = useCallback((id: string | null) => {
    setSelectedDroneId(id)
  }, [])

  // Arm/disarm drone
  const armDrone = useCallback((id: string, armed: boolean) => {
    const instance = droneInstancesRef.current.get(id)
    if (instance) {
      instance.physicsBody.setArmed(armed)
      if (armed) {
        instance.targetAltitude = instance.physicsBody.state.position.y
      }
    }
  }, [])

  // Set flight mode
  const setFlightMode = useCallback((id: string, mode: FlightMode) => {
    const instance = droneInstancesRef.current.get(id)
    if (instance) {
      instance.flightMode = mode
      instance.flightController.reset()

      if (mode === 'altitude_hold' || mode === 'position_hold') {
        instance.targetAltitude = instance.physicsBody.state.position.y
        instance.targetPosition = instance.physicsBody.state.position.clone()
      }
    }
  }, [])

  // Set control inputs
  const setControls = useCallback((id: string, controls: DroneControls) => {
    controlsRef.current.set(id, controls)
  }, [])

  // Get drone scene group
  const getDroneScene = useCallback(() => {
    return droneSceneRef.current
  }, [])

  return {
    drones: droneList,
    droneInstances: instanceList,
    selectedDroneId,
    isReady,
    spawnDrone,
    removeDrone,
    selectDrone,
    armDrone,
    setFlightMode,
    setControls,
    getDroneScene,
  }
}

export default useDroneSystem
