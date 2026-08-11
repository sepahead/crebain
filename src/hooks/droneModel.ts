import * as THREE from 'three'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { DroneTypeDefinition } from '../physics/DroneTypes'
import { logger } from '../lib/logger'
import { disposeObject3D, forEachMesh } from '../lib/three/sceneObjects'

const log = logger.scope('DroneModel')
const DRONE_MODEL_LOAD_TIMEOUT_MS = 30_000

function normalizeError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value })
}

/** Build the procedural fallback used when a model is absent or cannot load. */
export function createPlaceholderDrone(droneType: DroneTypeDefinition): THREE.Object3D {
  const group = new THREE.Group()

  if (droneType.category === 'quadcopter' || droneType.category === 'hexacopter') {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.05, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x333333 })
    )
    group.add(body)

    const armLength = droneType.physics.armLength || 0.175
    const rotorCount = droneType.physics.rotorCount || 4
    for (let index = 0; index < rotorCount; index += 1) {
      const angle = (index / rotorCount) * Math.PI * 2 + Math.PI / 4
      const x = Math.cos(angle) * armLength
      const z = Math.sin(angle) * armLength
      const arm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 0.01, armLength * 0.7),
        new THREE.MeshStandardMaterial({ color: 0x444444 })
      )
      arm.position.set(x * 0.5, 0, z * 0.5)
      arm.rotation.z = Math.PI / 2
      arm.rotation.y = angle
      group.add(arm)

      const rotor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.01, 16),
        new THREE.MeshStandardMaterial({
          color: 0x666666,
          transparent: true,
          opacity: 0.5,
        })
      )
      rotor.position.set(x, 0.03, z)
      rotor.name = `rotor_${index}`
      group.add(rotor)
    }
  } else if (droneType.category === 'loitering_munition' || droneType.category === 'fixed_wing') {
    const wing = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.5, 3),
      new THREE.MeshStandardMaterial({ color: 0x4a4a4a })
    )
    wing.rotation.x = Math.PI / 2
    wing.rotation.z = Math.PI
    group.add(wing)
  }

  return group
}

function createFallbackDrone(droneType: DroneTypeDefinition): THREE.Object3D {
  const placeholder = createPlaceholderDrone(droneType)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.6, 0.7, 32),
    new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
    })
  )
  ring.rotation.x = -Math.PI / 2
  ring.name = 'selection_ring'
  ring.visible = false
  placeholder.add(ring)
  return placeholder
}

/** Load and normalize one drone model, with a bounded procedural fallback. */
export function loadDroneModel(
  loader: GLTFLoader | null,
  droneType: DroneTypeDefinition
): Promise<THREE.Object3D | null> {
  const modelPath = droneType.modelPath
  if (!modelPath) return Promise.resolve(createFallbackDrone(droneType))
  if (!loader) return Promise.resolve(null)

  return new Promise((resolve, reject) => {
    let settled = false
    const finishResolve = (value: THREE.Object3D | null): boolean => {
      if (settled) return false
      settled = true
      window.clearTimeout(timeoutId)
      resolve(value)
      return true
    }
    const finishReject = (error: unknown): boolean => {
      if (settled) return false
      settled = true
      window.clearTimeout(timeoutId)
      reject(normalizeError(error, `Model ${droneType.id} failed to load`))
      return true
    }
    const resolveFallback = (reason?: unknown): void => {
      if (settled) return
      if (reason !== undefined) {
        log.warn(`Model ${droneType.id} could not be prepared, using placeholder`, { reason })
      }
      try {
        finishResolve(createFallbackDrone(droneType))
      } catch (error) {
        finishReject(error)
      }
    }
    const disposeLateModel = (model: THREE.Object3D): void => {
      try {
        disposeObject3D(model)
      } catch (error) {
        log.warn(`Late model ${droneType.id} could not be disposed`, { error })
      }
    }
    const timeoutId = window.setTimeout(() => {
      resolveFallback(new Error(`model load exceeded ${DRONE_MODEL_LOAD_TIMEOUT_MS} ms`))
    }, DRONE_MODEL_LOAD_TIMEOUT_MS)

    try {
      loader.load(
        modelPath,
        (gltf) => {
          if (settled) {
            disposeLateModel(gltf.scene)
            return
          }
          let cleanupRoot: THREE.Object3D | null = gltf.scene
          try {
            const model = gltf.scene.clone()
            cleanupRoot = model
            const box = new THREE.Box3().setFromObject(model)
            if (box.isEmpty()) {
              cleanupRoot = null
              disposeObject3D(model)
              resolveFallback(new Error('model has empty bounds'))
              return
            }

            const center = box.getCenter(new THREE.Vector3())
            const size = box.getSize(new THREE.Vector3())
            const wrapper = new THREE.Group()
            wrapper.name = 'drone_wrapper'
            model.position.sub(center)
            wrapper.add(model)
            cleanupRoot = wrapper

            let rotorIndex = 0
            forEachMesh(model, (mesh) => {
              const lowerName = mesh.name.toLowerCase()
              if (lowerName.includes('rotor') || lowerName.includes('prop')) {
                mesh.name = `rotor_${rotorIndex}`
                rotorIndex += 1
              }
            })

            const ringRadius = Math.max(size.x, size.z) * 0.6
            const ring = new THREE.Mesh(
              new THREE.RingGeometry(ringRadius, ringRadius * 1.1, 32),
              new THREE.MeshBasicMaterial({
                color: 0x00ff00,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.8,
              })
            )
            ring.rotation.x = -Math.PI / 2
            ring.position.y = -size.y * 0.5 - 0.05
            ring.name = 'selection_ring'
            ring.visible = false
            wrapper.add(ring)

            cleanupRoot = null
            finishResolve(wrapper)
          } catch (error) {
            const cleanupErrors: unknown[] = []
            if (cleanupRoot) {
              try {
                disposeObject3D(cleanupRoot)
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError)
              }
            }
            if (cleanupErrors.length > 0) {
              finishReject(
                new AggregateError(
                  [error, ...cleanupErrors],
                  `Model ${droneType.id} preparation and cleanup failed`,
                  { cause: error }
                )
              )
              return
            }
            resolveFallback(error)
          }
        },
        undefined,
        (error) => resolveFallback(error)
      )
    } catch (error) {
      finishReject(error)
    }
  })
}
