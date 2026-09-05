import { copyPlainData } from '../lib/copyPlainData'
import { ownStaticGeometry, type StaticCuboid } from '../physics/StaticGeometry'

export type Vec3 = [number, number, number]
export interface SceneMaterial {
  id: string
  linearRgb: Vec3
  gaussianOpacity: number
  temperatureK: number
  emissivity: number
}
export interface SceneCamera {
  id: string
  position: Vec3
  target: Vec3
  width: number
  height: number
  fovDegrees: number
  periodTicks: number
}
export interface SceneSpec {
  profile: 'crebain.city-scene.v1'
  id: string
  frame: 'three-y-up-z-forward-m'
  solids: Array<{ shape: StaticCuboid; materialId: string }>
  materials: SceneMaterial[]
  rgbCameras: SceneCamera[]
  thermalCameras: SceneCamera[]
  microphones: Array<{ id: string; position: Vec3 }>
}

export function closedKeys(
  value: unknown,
  keys: string[]
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
  )
    throw new Error('Expected a closed environment value')
}

export function finiteRange(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error('Environment value outside the finite operating envelope')
}

function position(value: unknown): asserts value is Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('Expected a three-axis vector')
  value.forEach((component) => finiteRange(component, -1000, 1000))
}

function orderedIds(rows: Array<{ id: string }>, maximum: number): void {
  if (!Array.isArray(rows) || rows.length > maximum)
    throw new Error('Environment roster over budget')
  let previous = ''
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(row.id) ||
      row.id <= previous
    )
      throw new Error('Environment IDs must be sorted and unique')
    previous = row.id
  }
}

function cameras(rows: SceneCamera[], maximumDimension: number): void {
  orderedIds(rows, 4)
  for (const row of rows) {
    closedKeys(row, ['id', 'position', 'target', 'width', 'height', 'fovDegrees', 'periodTicks'])
    position(row.position)
    position(row.target)
    if (row.position.every((value, axis) => value === row.target[axis]))
      throw new Error('Camera direction must be nonzero')
    finiteRange(row.fovDegrees, 5, 120)
    for (const size of [row.width, row.height]) {
      finiteRange(size, 8, maximumDimension)
      if (!Number.isSafeInteger(size)) throw new Error('Camera dimension must be an integer')
    }
    finiteRange(row.periodTicks, 1, 120)
    if (!Number.isSafeInteger(row.periodTicks)) throw new Error('Camera period must be an integer')
  }
}

/** Frozen, complete scene input; no executable or external-resource fields are admitted. */
export function ownSceneSpec(input: SceneSpec): SceneSpec {
  const scene = copyPlainData(input)
  closedKeys(scene, [
    'profile',
    'id',
    'frame',
    'solids',
    'materials',
    'rgbCameras',
    'thermalCameras',
    'microphones',
  ])
  if (scene.profile !== 'crebain.city-scene.v1' || scene.frame !== 'three-y-up-z-forward-m')
    throw new Error('Unsupported environment scene profile or frame')
  orderedIds([{ id: scene.id }], 1)
  orderedIds(scene.materials, 16)
  if (scene.materials.length === 0) throw new Error('Scene materials are required')
  const materialIds = new Set(scene.materials.map((row) => row.id))
  for (const row of scene.materials) {
    closedKeys(row, ['id', 'linearRgb', 'gaussianOpacity', 'temperatureK', 'emissivity'])
    position(row.linearRgb)
    row.linearRgb.forEach((channel) => finiteRange(channel, 0, 1))
    finiteRange(row.gaussianOpacity, 0, 1)
    finiteRange(row.temperatureK, 150, 800)
    finiteRange(row.emissivity, 0, 1)
  }
  if (!Array.isArray(scene.solids)) throw new Error('Scene solids are required')
  for (const row of scene.solids) {
    closedKeys(row, ['shape', 'materialId'])
    if (!materialIds.has(row.materialId)) throw new Error('Unknown scene material')
  }
  ownStaticGeometry(scene.solids.map((row) => row.shape))
  cameras(scene.rgbCameras, 1280)
  cameras(scene.thermalCameras, 320)
  orderedIds(scene.microphones, 4)
  for (const row of scene.microphones) {
    closedKeys(row, ['id', 'position'])
    position(row.position)
  }
  return scene
}

/** Project-authored city block. These are procedural solids, not a captured reconstruction. */
export function createCityBlockScene(): SceneSpec {
  const solids: SceneSpec['solids'] = []
  for (let block = 0; block < 16; block++) {
    const x = (block % 4) * 14 - 21
    const z = Math.floor(block / 4) * 14 - 21
    const height = 4 + (block % 3) * 3
    solids.push({
      shape: {
        id: `building-${String(block).padStart(2, '0')}`,
        center: [x, height / 2, z],
        halfExtents: [4, height / 2, 4],
        yaw: 0,
        friction: 0.5,
        restitution: 0,
      },
      materialId: 'concrete',
    })
  }
  const camera = (id: string, position: Vec3): SceneCamera => ({
    id,
    position,
    target: [0, 8, 0],
    width: 320,
    height: 240,
    fovDegrees: 70,
    periodTicks: 12,
  })
  return ownSceneSpec({
    profile: 'crebain.city-scene.v1',
    id: 'owned-city-block',
    frame: 'three-y-up-z-forward-m',
    solids,
    materials: [
      {
        id: 'concrete',
        linearRgb: [0.35, 0.38, 0.43],
        gaussianOpacity: 0.85,
        temperatureK: 293.15,
        emissivity: 0.9,
      },
    ],
    rgbCameras: [camera('rgb-a', [0, 14, 38]), camera('rgb-b', [38, 14, 0])],
    thermalCameras: [{ ...camera('thermal-a', [0, 14, 38]), width: 160, height: 120 }],
    microphones: [
      { id: 'mic-a', position: [0, 2, 10] },
      { id: 'mic-b', position: [4, 2, 10] },
    ],
  })
}

/** Exact segment/cuboid intersection for the admitted fixed yaw-only solids. */
export function segmentBlocked(start: Vec3, end: Vec3, solids: SceneSpec['solids']): boolean {
  return solids.some(({ shape }) => {
    const cosine = Math.cos(shape.yaw)
    const sine = Math.sin(shape.yaw)
    const local = (point: Vec3): Vec3 => {
      const x = point[0] - shape.center[0]
      const z = point[2] - shape.center[2]
      return [cosine * x - sine * z, point[1] - shape.center[1], sine * x + cosine * z]
    }
    const a = local(start)
    const b = local(end)
    let near = 0
    let far = 1
    for (let axis = 0; axis < 3; axis++) {
      const delta = b[axis] - a[axis]
      const half = shape.halfExtents[axis]
      if (delta === 0) {
        if (a[axis] < -half || a[axis] > half) return false
        continue
      }
      const first = (-half - a[axis]) / delta
      const second = (half - a[axis]) / delta
      near = Math.max(near, Math.min(first, second))
      far = Math.min(far, Math.max(first, second))
      if (near > far) return false
    }
    return far > 0 && near < 1
  })
}
