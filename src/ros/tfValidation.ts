import type { Quaternion, Transform, TransformStamped, Vector3 } from './types'

/** Operational bound for both ingress edges and composed TF translations. */
export const MAX_TF_TRANSLATION_METERS = 1_000_000
export const MAX_TF_FRAME_ID_LENGTH = 256
export const TF_QUATERNION_NORM_TOLERANCE = 1e-3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys)
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  )
}

function finiteVector3(value: unknown): Vector3 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['x', 'y', 'z'])) return null
  if (
    typeof value.x !== 'number' ||
    !Number.isFinite(value.x) ||
    typeof value.y !== 'number' ||
    !Number.isFinite(value.y) ||
    typeof value.z !== 'number' ||
    !Number.isFinite(value.z)
  ) {
    return null
  }
  return { x: value.x, y: value.y, z: value.z }
}

function finiteQuaternion(value: unknown): Quaternion | null {
  if (!isRecord(value) || !hasExactKeys(value, ['x', 'y', 'z', 'w'])) return null
  if (
    typeof value.x !== 'number' ||
    !Number.isFinite(value.x) ||
    typeof value.y !== 'number' ||
    !Number.isFinite(value.y) ||
    typeof value.z !== 'number' ||
    !Number.isFinite(value.z) ||
    typeof value.w !== 'number' ||
    !Number.isFinite(value.w)
  ) {
    return null
  }
  return { x: value.x, y: value.y, z: value.z, w: value.w }
}

export function isValidTfFrameId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TF_FRAME_ID_LENGTH &&
    value.trim() === value &&
    !value.includes('\0') &&
    !/\s/u.test(value)
  )
}

export function isBoundedTfTranslation(value: unknown): value is Vector3 {
  const vector = finiteVector3(value)
  return vector !== null && Math.hypot(vector.x, vector.y, vector.z) <= MAX_TF_TRANSLATION_METERS
}

/**
 * Ingress policy: reject zero or materially non-unit quaternions, then
 * normalize accepted rounding drift to an exact unit quaternion before cache.
 */
export function normalizeIngressTfQuaternion(value: unknown): Quaternion | null {
  const quaternion = finiteQuaternion(value)
  if (!quaternion) return null
  const norm = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
  if (
    !Number.isFinite(norm) ||
    norm === 0 ||
    Math.abs(norm - 1) > TF_QUATERNION_NORM_TOLERANCE
  ) {
    return null
  }
  return {
    x: quaternion.x / norm,
    y: quaternion.y / norm,
    z: quaternion.z / norm,
    w: quaternion.w / norm,
  }
}

/**
 * Computed policy: composition/interpolation may introduce ordinary floating
 * drift, so any finite nonzero result is normalized, then its translation is
 * checked against the same operational bound. Nonfinite results fail closed.
 */
export function normalizeComputedTfQuaternion(value: unknown): Quaternion | null {
  const quaternion = finiteQuaternion(value)
  if (!quaternion) return null
  const norm = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
  if (!Number.isFinite(norm) || norm === 0) return null
  return {
    x: quaternion.x / norm,
    y: quaternion.y / norm,
    z: quaternion.z / norm,
    w: quaternion.w / norm,
  }
}

export function normalizeIngressTfTransform(value: unknown): Transform | null {
  if (!isRecord(value) || !hasExactKeys(value, ['translation', 'rotation'])) return null
  const translation = finiteVector3(value.translation)
  const rotation = normalizeIngressTfQuaternion(value.rotation)
  if (
    !translation ||
    Math.hypot(translation.x, translation.y, translation.z) > MAX_TF_TRANSLATION_METERS ||
    !rotation
  ) {
    return null
  }
  return { translation, rotation }
}

export function normalizeComputedTfTransform(value: unknown): Transform | null {
  if (!isRecord(value) || !hasExactKeys(value, ['translation', 'rotation'])) return null
  const translation = finiteVector3(value.translation)
  const rotation = normalizeComputedTfQuaternion(value.rotation)
  if (
    !translation ||
    Math.hypot(translation.x, translation.y, translation.z) > MAX_TF_TRANSLATION_METERS ||
    !rotation
  ) {
    return null
  }
  return { translation, rotation }
}

export function normalizeIngressTransformStamped(
  value: TransformStamped
): TransformStamped | null {
  if (!isValidTfFrameId(value.header?.frame_id) || !isValidTfFrameId(value.child_frame_id)) {
    return null
  }
  const transform = normalizeIngressTfTransform(value.transform)
  if (!transform) return null
  return {
    ...value,
    header: { ...value.header },
    transform,
  }
}
