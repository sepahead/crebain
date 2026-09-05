import * as THREE from 'three'
import { SplatMesh } from '@sparkjsdev/spark'
import { createPlaceholderDrone } from '../hooks/droneModel'
import { DRONE_TYPES } from '../physics/DroneTypes'
import { DEFAULT_QUADCOPTER_PARAMS } from '../physics/DronePhysics'
import { ownSceneSpec, type SceneSpec } from './SceneSpec'

export interface SceneProjection {
  rgb: THREE.Scene
  thermal: THREE.Scene
  splats: SplatMesh
  rgbDrones: Map<string, THREE.Object3D>
  thermalDrones: Map<string, THREE.Object3D>
  thermalMaterials: Map<string, THREE.ShaderMaterial>
}

/** Numeric bolometric radiance output. Display coloring belongs to a separate view. */
export function thermalMaterial(radiance: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { radiance: { value: radiance } },
    vertexShader:
      'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'uniform float radiance; void main() { gl_FragColor = vec4(radiance, 0.0, 0.0, 1.0); }',
    toneMapped: false,
  })
}

/** Reuse the desktop procedural quadcopter mesh with this profile's actual arm length. */
function droneMesh(): THREE.Object3D {
  return createPlaceholderDrone({
    ...DRONE_TYPES.maverick,
    physics: {
      ...DRONE_TYPES.maverick.physics,
      // Existing dynamics use this parameter as each X/Z offset; the desktop mesh uses radius.
      armLength: Math.SQRT2 * DEFAULT_QUADCOPTER_PARAMS.armLength,
      rotorCount: 4,
    },
  })
}

export async function createSceneProjection(
  input: SceneSpec,
  droneIds: string[]
): Promise<SceneProjection> {
  const spec = ownSceneSpec(input)
  const rgb = new THREE.Scene()
  rgb.background = new THREE.Color(0.03, 0.05, 0.08)
  rgb.add(new THREE.AmbientLight(0xffffff, 1))
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(20, 40, 10)
  rgb.add(sun)
  const thermal = new THREE.Scene()
  const materials = new Map(spec.materials.map((material) => [material.id, material]))
  const thermalMaterials = new Map<string, THREE.ShaderMaterial>()
  for (const solid of spec.solids) {
    const geometry = new THREE.BoxGeometry(
      ...(solid.shape.halfExtents.map((half) => half * 2) as [number, number, number])
    )
    const color = materials.get(solid.materialId)!.linearRgb
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: new THREE.Color(...color), roughness: 1 })
    )
    mesh.position.fromArray(solid.shape.center)
    mesh.rotation.y = solid.shape.yaw
    rgb.add(mesh)
    const material = thermalMaterial(0)
    thermalMaterials.set(`solid:${solid.shape.id}`, material)
    const heatMesh = new THREE.Mesh(geometry, material)
    heatMesh.position.copy(mesh.position)
    heatMesh.quaternion.copy(mesh.quaternion)
    thermal.add(heatMesh)
  }
  // This exactly matches the ground primitive already owned by DronePhysicsWorld.
  const ground = new THREE.BoxGeometry(2000, 0.2, 2000)
  const floor = new THREE.Mesh(
    ground,
    new THREE.MeshStandardMaterial({ color: 0x25272b, roughness: 1 })
  )
  floor.position.y = -0.1
  rgb.add(floor)
  const floorMaterial = thermalMaterial(0)
  thermalMaterials.set('ground', floorMaterial)
  const heatFloor = new THREE.Mesh(ground, floorMaterial)
  heatFloor.position.y = -0.1
  thermal.add(heatFloor)

  const splats = new SplatMesh({
    constructSplats: (output) => {
      for (const { shape, materialId } of spec.solids) {
        const orientation = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          shape.yaw
        )
        const baseColor = materials.get(materialId)!.linearRgb
        // Authored Gaussian surface appearance; no captured-scene or inferred-solid claim.
        for (let normalAxis = 0; normalAxis < 3; normalAxis++)
          for (const side of [-1, 1]) {
            const u = (normalAxis + 1) % 3
            const v = (normalAxis + 2) % 3
            for (let row = 0; row < 8; row++)
              for (let column = 0; column < 8; column++) {
                const local = [0, 0, 0]
                local[normalAxis] = side * (shape.halfExtents[normalAxis] + 0.02)
                local[u] = ((row + 0.5) / 4 - 1) * shape.halfExtents[u]
                local[v] = ((column + 0.5) / 4 - 1) * shape.halfExtents[v]
                const scale = shape.halfExtents.map((half) => half / 7)
                scale[normalAxis] = 0.015
                const center = new THREE.Vector3()
                  .fromArray(local)
                  .applyQuaternion(orientation)
                  .add(new THREE.Vector3().fromArray(shape.center))
                const color = new THREE.Color(...baseColor).multiplyScalar(
                  0.75 + 0.1 * ((row + column) % 3)
                )
                output.pushSplat(
                  center,
                  new THREE.Vector3().fromArray(scale),
                  orientation,
                  materials.get(materialId)!.gaussianOpacity,
                  color
                )
              }
          }
      }
    },
  })
  await splats.initialized
  rgb.add(splats)
  const rgbDrones = new Map<string, THREE.Object3D>()
  const thermalDrones = new Map<string, THREE.Object3D>()
  for (const id of droneIds) {
    const model = droneMesh()
    rgb.add(model)
    rgbDrones.set(id, model)
    const material = thermalMaterial(0)
    thermalMaterials.set(`drone:${id}`, material)
    const heatModel = model.clone(true)
    heatModel.traverse((object) => {
      if (object instanceof THREE.Mesh) object.material = material
    })
    thermal.add(heatModel)
    thermalDrones.set(id, heatModel)
  }
  return { rgb, thermal, splats, rgbDrones, thermalDrones, thermalMaterials }
}
