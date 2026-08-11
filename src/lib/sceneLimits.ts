/** Resource and identity limits shared by live scene mutation and persistence. */
export const MAX_SCENE_CAMERAS = 64
export const MAX_SCENE_DRONES = 256
export const MAX_SCENE_ASSETS = 128
export const MAX_SCENE_DETECTIONS = 10_000
export const MAX_CAMERA_PATROL_POINTS = 4_096
export const MAX_SCENE_NAME_BYTES = 256
export const MAX_CAMERA_RENDER_PIXELS = 16_777_216

const utf8Encoder = new TextEncoder()

export function hasBoundedUtf8Length(value: string, maximumBytes: number): boolean {
  return utf8Encoder.encode(value).byteLength <= maximumBytes
}

/** Identity text must survive JSON, native IPC, logs, and browser controls unchanged. */
export function isBoundedSceneName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !Array.from(value).some((character) => /\p{Cc}/u.test(character)) &&
    hasBoundedUtf8Length(value, MAX_SCENE_NAME_BYTES)
  )
}
