import { isBoundedSceneName, MAX_SCENE_NAME_BYTES } from './sceneLimits'

export const MIN_SURVEILLANCE_CAMERA_PAN_DEGREES = -180
export const MAX_SURVEILLANCE_CAMERA_PAN_DEGREES = 180
export const MIN_SURVEILLANCE_CAMERA_TILT_DEGREES = -85
export const MAX_SURVEILLANCE_CAMERA_TILT_DEGREES = 85
export const MIN_SURVEILLANCE_CAMERA_FOV_DEGREES = 5
export const MAX_SURVEILLANCE_CAMERA_FOV_DEGREES = 120
export const MAX_SURVEILLANCE_CAMERA_NAME_BYTES = MAX_SCENE_NAME_BYTES

/** Normalize a user-entered camera name to the persisted scene contract. */
export function normalizeSurveillanceCameraName(value: string): string | null {
  const normalized = value.trim()
  return isBoundedSceneName(normalized) ? normalized : null
}
