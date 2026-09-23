import type { SceneSpec } from './SceneSpec'
import type { ThermalConfig } from './ThermalObservation'

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
