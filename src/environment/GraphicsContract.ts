import { copyPlainData } from '../lib/copyPlainData'
import { closedKeys, ownSceneSpec, type SceneSpec } from './SceneSpec'
import { ownThermalConfig, type ThermalConfig } from './ThermalObservation'

export interface GraphicsPlan {
  profile: 'crebain.owned-city-graphics.v1'
  sourceIdentity: string
  scene: SceneSpec
  droneIds: string[]
  thermal: ThermalConfig
}
export interface GraphicsInput {
  planSha256: string
  tick: number
  drones: Array<{
    id: string
    position: [number, number, number]
    orientation: [number, number, number, number]
    temperatureK: number
  }>
}
/** Separate source-level graphics profile; unrequested thermal physics is absent. */
export interface SourceGraphicsPlan {
  profile: 'crebain.owned-force-city-source-graphics.v1'
  sourceIdentity: string
  scene: SceneSpec
  droneIds: string[]
  thermal: ThermalConfig | null
}
export interface SourceGraphicsInput {
  planSha256: string
  tick: number
  drones: Array<{
    id: string
    position: [number, number, number]
    orientation: [number, number, number, number]
    temperatureK: number | null
  }>
}
export interface GraphicsSourceSelection {
  kind: 'rgb' | 'thermal'
  cameraId: string
}
export interface GraphicsSourceReceipt {
  planSha256: string
  inputSha256: string
  tick: number
  kind: 'rgb' | 'thermal'
  cameraId: string
  width: number
  height: number
  rowOrigin: 'bottom-left'
  encoding: 'rgba8-srgb' | 'float32-le'
  byteLength: number
}
/** Caller installs the real owner. Disposal here does not attest operating-system exit. */
export interface SourceGraphicsPort {
  readonly planSha256: string
  captureSourceInto(
    input: SourceGraphicsInput,
    source: GraphicsSourceSelection,
    destination: Uint8Array
  ): Promise<GraphicsSourceReceipt>
  retire(): void | Promise<void>
}
export type SourceGraphicsLauncher = (plan: SourceGraphicsPlan) => Promise<SourceGraphicsPort>

export {
  GraphicsSourceIntegrityError,
  isGraphicsSourceIntegrityError,
} from './GraphicsSourceErrors.js'

/** Pure source-profile admission, before either source storage or a renderer is constructed. */
export function ownSourceGraphicsPlan(input: SourceGraphicsPlan): SourceGraphicsPlan {
  const plan = copyPlainData(input)
  closedKeys(plan, ['profile', 'sourceIdentity', 'scene', 'droneIds', 'thermal'])
  if (
    plan.profile !== 'crebain.owned-force-city-source-graphics.v1' ||
    !/^[a-f0-9]{64}$/.test(plan.sourceIdentity)
  )
    throw new Error('Unsupported source graphics profile or source identity')
  ownSceneSpec(plan.scene)
  if (plan.scene.rgbCameras.length + plan.scene.thermalCameras.length === 0)
    throw new Error('Source graphics requires a requested camera')
  if (plan.scene.thermalCameras.length > 0 !== (plan.thermal !== null))
    throw new Error('Source graphics thermal selection changed')
  if (plan.thermal !== null) ownThermalConfig(plan.thermal)
  if (!Array.isArray(plan.droneIds) || plan.droneIds.length < 1 || plan.droneIds.length > 256)
    throw new Error('Graphics drone roster outside the operating envelope')
  let previous = ''
  for (const id of plan.droneIds) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) || id <= previous)
      throw new Error('Graphics drone IDs must be sorted and unique')
    previous = id
  }
  return plan
}
export interface GraphicsFrames {
  planSha256: string
  inputSha256: string
  tick: number
  rowOrigin: 'bottom-left'
  rgb: Array<{
    cameraId: string
    width: number
    height: number
    encoding: 'rgba8-srgb'
    pixels: Uint8Array
  }>
  thermal: Array<{
    cameraId: string
    width: number
    height: number
    unit: 'W/(m2 sr)'
    radiance: Float32Array
  }>
}

/** Exact input bytes, including the sign of zero. A digest is not simulator attestation. */
export async function graphicsInputDigest(value: unknown): Promise<string> {
  const serialized = JSON.stringify(value, (_key, item: unknown) =>
    Object.is(item, -0) ? { binary64: 'negative-zero' } : item
  )
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
