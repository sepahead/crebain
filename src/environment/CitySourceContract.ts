import { copyPlainData } from '../lib/copyPlainData'
import { MAX_SCENE_DRONES } from '../lib/sceneLimits'
import {
  ownForceCityPlan,
  FORCE_CITY_RETURN_HEADER_BYTES,
  FORCE_CITY_RETURN_ENTITY_BYTES,
  type ForceCityPlan,
} from '../physics/ForceCityWorld'
import { ownSceneSpec, closedKeys, type SceneSpec } from './SceneSpec'
import { ownAcousticConfig, type AcousticConfig } from './AcousticObservation'
import { ownThermalConfig, type ThermalConfig } from './ThermalObservation'

export const CITY_ENVIRONMENT_PROFILE = 'crebain.force-city-environment.v1'
export const CITY_ORIGINAL_BYTES = 27_857_088
export const CITY_CHUNK_BYTES = 32_768
export const CITY_PLAN_BYTES = 512 * 1024
export const CITY_GRAPHICS_INPUT_BYTES = 128 * 1024
export const CITY_MAX_SOURCES = 12
export const CITY_CONTROL_BYTES =
  FORCE_CITY_RETURN_HEADER_BYTES + FORCE_CITY_RETURN_ENTITY_BYTES * MAX_SCENE_DRONES
export const CITY_RECEIPT_HEADER_BYTES = 16_384
export const CITY_RECEIPT_ENTITY_BYTES = 256
export const CITY_RECEIPT_SOURCE_BYTES = 4096
export const CITY_RECEIPT_BYTES =
  CITY_RECEIPT_HEADER_BYTES +
  CITY_RECEIPT_ENTITY_BYTES * MAX_SCENE_DRONES +
  CITY_RECEIPT_SOURCE_BYTES * CITY_MAX_SOURCES
const ID = /^[a-z][a-z0-9_-]{0,63}$/

/** Exclusive recipient of one real world-fixed scene source, not a mounted sensor. */
export interface CitySourceRequest {
  requestId: string
  sourceId: string
  entityId: string
  kind: 'rgb' | 'thermal' | 'pressure'
  sceneSourceId: string
  periodTicks: number
}

/** Native component input. The installed NCP application has a separate wire projection. */
export interface CityEnvironmentPlan {
  profile: typeof CITY_ENVIRONMENT_PROFILE
  world: ForceCityPlan
  scene: SceneSpec
  requests: CitySourceRequest[]
  acoustic?: AcousticConfig
  thermal?: ThermalConfig
}

export interface CityResourceBounds {
  originalBytes: number
  receiptBytes: number
  chunkBytes: typeof CITY_CHUNK_BYTES
  graphicsInputBytes: typeof CITY_GRAPHICS_INPUT_BYTES
  cpuReturnEncodedBytes: number
  acousticHistoryBytes: number
  acousticBlockBytes: number
  rgbReadbackBytes: number
  thermalReadbackBytes: number
  renderTargetColorBytes: number
  renderTargetPixels: number
  authoredGaussians: number
  opaqueRuntimeMemoryBound: false
}

export function cityRequire(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Same finite, signed-zero-preserving value projection for all city component identities. */
export function cityJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-finite city value')
    if (Object.is(item, -0)) return { float64: 'negative-zero' }
    if (item && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    return item
  })
}

export async function citySha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function cityValueDigest(value: unknown): Promise<string> {
  return citySha256(new TextEncoder().encode(cityJson(value)))
}

export function ownCityEnvironmentPlan(input: CityEnvironmentPlan): CityEnvironmentPlan {
  const plan = copyPlainData(input)
  closedKeys(plan, [
    'profile',
    'world',
    'scene',
    'requests',
    ...(Object.hasOwn(plan, 'acoustic') ? ['acoustic'] : []),
    ...(Object.hasOwn(plan, 'thermal') ? ['thermal'] : []),
  ])
  cityRequire(plan.profile === CITY_ENVIRONMENT_PROFILE, 'Unsupported city environment profile')
  ownForceCityPlan(plan.world)
  ownSceneSpec(plan.scene)
  cityRequire(
    cityJson(plan.world.staticGeometry) === cityJson(plan.scene.solids.map((row) => row.shape)),
    'City geometry must join the actual shared physics and observation scene'
  )
  for (const entity of plan.world.drones)
    cityRequire(
      entity.position.every((value) => Math.abs(value) <= 1000),
      'City source position bound'
    )
  cityRequire(
    Array.isArray(plan.requests) && plan.requests.length <= CITY_MAX_SOURCES,
    'City source count bound'
  )
  const native = new Map<string, number | null>([
    ...plan.scene.rgbCameras.map((row) => [`rgb:${row.id}`, row.periodTicks] as const),
    ...plan.scene.thermalCameras.map((row) => [`thermal:${row.id}`, row.periodTicks] as const),
    ...plan.scene.microphones.map((row) => [`pressure:${row.id}`, null] as const),
  ])
  const sources = new Set<string>()
  const entities = new Set(plan.world.drones.map((row) => row.id))
  let previous = ''
  for (const row of plan.requests) {
    closedKeys(row, ['requestId', 'sourceId', 'entityId', 'kind', 'sceneSourceId', 'periodTicks'])
    for (const id of [row.requestId, row.sourceId, row.entityId, row.sceneSourceId])
      cityRequire(typeof id === 'string' && ID.test(id), 'Invalid city source identity')
    cityRequire(
      row.requestId > previous && !sources.has(row.sourceId) && entities.has(row.entityId),
      'City requests require ordered unique identities and an owned entity'
    )
    cityRequire(
      ['rgb', 'thermal', 'pressure'].includes(row.kind),
      'Unsupported city source modality'
    )
    const key = `${row.kind}:${row.sceneSourceId}`
    cityRequire(native.has(key), 'Foreign or aliased native source')
    cityRequire(
      Number.isSafeInteger(row.periodTicks) &&
        row.periodTicks >= 1 &&
        row.periodTicks <= 120 &&
        (native.get(key) === null || native.get(key) === row.periodTicks),
      'City source cadence mismatch'
    )
    native.delete(key)
    sources.add(row.sourceId)
    previous = row.requestId
  }
  cityRequire(native.size === 0, 'Every native source requires one exclusive request')
  cityRequire(
    plan.scene.microphones.length > 0 === Object.hasOwn(plan, 'acoustic'),
    'Select the acoustic model exactly when pressure sources are requested'
  )
  cityRequire(
    plan.scene.thermalCameras.length > 0 === Object.hasOwn(plan, 'thermal'),
    'Select the thermal model exactly when thermal sources are requested'
  )
  if (Object.hasOwn(plan, 'acoustic')) ownAcousticConfig(plan.acoustic!)
  if (Object.hasOwn(plan, 'thermal')) ownThermalConfig(plan.thermal!)
  cityRequire(
    new TextEncoder().encode(cityJson(plan)).byteLength <= CITY_PLAN_BYTES,
    'City plan byte bound'
  )
  return plan
}

export function citySourceMaximumBytes(
  plan: CityEnvironmentPlan,
  source: CitySourceRequest
): number {
  if (source.kind === 'pressure') return 134 * 8
  const rows = source.kind === 'rgb' ? plan.scene.rgbCameras : plan.scene.thermalCameras
  const camera = rows.find((row) => row.id === source.sceneSourceId)
  cityRequire(camera, 'Missing native camera')
  return 4 * camera.width * camera.height
}

export function cityResourceBounds(input: CityEnvironmentPlan): CityResourceBounds {
  const plan = ownCityEnvironmentPlan(input)
  const sum = (rows: SceneSpec['rgbCameras'], stride: number): number =>
    rows.reduce((total, row) => total + stride * row.width * row.height, 0)
  const originalBytes = plan.requests.reduce(
    (total, source) => total + citySourceMaximumBytes(plan, source),
    0
  )
  cityRequire(originalBytes <= CITY_ORIGINAL_BYTES, 'City aggregate original-byte bound')
  const acousticHistoryBytes = plan.acoustic
    ? 8 *
      plan.world.drones.length *
      (Math.ceil((plan.acoustic.maximumRangeM / plan.acoustic.soundSpeedMps) * 16000) + 2)
    : 0
  return Object.freeze({
    originalBytes,
    // At most 256 ASCII bytes per applied row, 4096 per source, and one fixed header.
    receiptBytes:
      CITY_RECEIPT_HEADER_BYTES +
      CITY_RECEIPT_ENTITY_BYTES * plan.world.drones.length +
      CITY_RECEIPT_SOURCE_BYTES * plan.requests.length,
    chunkBytes: CITY_CHUNK_BYTES,
    graphicsInputBytes: CITY_GRAPHICS_INPUT_BYTES,
    cpuReturnEncodedBytes:
      FORCE_CITY_RETURN_HEADER_BYTES + FORCE_CITY_RETURN_ENTITY_BYTES * plan.world.drones.length,
    acousticHistoryBytes,
    acousticBlockBytes: 134 * 8 * plan.scene.microphones.length,
    // Spark retains one RGBA8 readback per fixed view. Thermal uses one largest shared RGBA32F scratch.
    rgbReadbackBytes: sum(plan.scene.rgbCameras, 4),
    thermalReadbackBytes: Math.max(
      0,
      ...plan.scene.thermalCameras.map((row) => 16 * row.width * row.height)
    ),
    renderTargetColorBytes: sum(plan.scene.rgbCameras, 4) + sum(plan.scene.thermalCameras, 16),
    renderTargetPixels: sum(plan.scene.rgbCameras, 1) + sum(plan.scene.thermalCameras, 1),
    authoredGaussians: plan.scene.solids.length * 6 * 8 * 8,
    opaqueRuntimeMemoryBound: false,
  })
}
