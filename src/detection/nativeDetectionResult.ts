import type { CoreMLBoundingBox, CoreMLDetection, CoreMLDetectionResult } from './types'

const MAX_NATIVE_DETECTIONS = 100
const MAX_COCO_CLASS_INDEX = 79
const MAX_NATIVE_STRING_LENGTH = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid native detection response: ${field} must be a finite number`)
  }
  return value
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null) return null
  return requireNonNegativeNumber(value, field)
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  const number = requireFiniteNumber(value, field)
  if (number < 0) {
    throw new Error(`Invalid native detection response: ${field} must be non-negative`)
  }
  return number
}

function requireSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(
      `Invalid native detection response: ${field} must be a safe integer between ${minimum} and ${maximum}`
    )
  }
  return value as number
}

function requireBoundedString(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_NATIVE_STRING_LENGTH
  ) {
    throw new Error(
      `Invalid native detection response: ${field} must be a non-empty string of at most ${MAX_NATIVE_STRING_LENGTH} characters`
    )
  }
  return value
}

function normalizeBoundingBox(
  value: unknown,
  field: string,
  frameWidth: number,
  frameHeight: number
): CoreMLBoundingBox {
  if (!isRecord(value)) {
    throw new Error(`Invalid native detection response: ${field} must be an object`)
  }

  const bbox = {
    x1: requireNonNegativeNumber(value.x1, `${field}.x1`),
    y1: requireNonNegativeNumber(value.y1, `${field}.y1`),
    x2: requireNonNegativeNumber(value.x2, `${field}.x2`),
    y2: requireNonNegativeNumber(value.y2, `${field}.y2`),
  }
  if (bbox.x2 <= bbox.x1 || bbox.y2 <= bbox.y1) {
    throw new Error(`Invalid native detection response: ${field} must have ordered positive area`)
  }
  if (bbox.x2 > frameWidth || bbox.y2 > frameHeight) {
    throw new Error(
      `Invalid native detection response: ${field} must stay within the ${frameWidth}x${frameHeight} frame`
    )
  }
  return bbox
}

function normalizeDetection(
  value: unknown,
  index: number,
  frameWidth: number,
  frameHeight: number
): CoreMLDetection {
  const field = `detections[${index}]`
  if (!isRecord(value)) {
    throw new Error(`Invalid native detection response: ${field} must be an object`)
  }

  const confidence = requireFiniteNumber(value.confidence, `${field}.confidence`)
  if (confidence < 0 || confidence > 1) {
    throw new Error(
      `Invalid native detection response: ${field}.confidence must be between 0 and 1`
    )
  }

  return {
    id: requireBoundedString(value.id, `${field}.id`),
    classLabel: requireBoundedString(value.classLabel, `${field}.classLabel`),
    classIndex: requireSafeInteger(
      value.classIndex,
      `${field}.classIndex`,
      0,
      MAX_COCO_CLASS_INDEX
    ),
    confidence,
    bbox: normalizeBoundingBox(value.bbox, `${field}.bbox`, frameWidth, frameHeight),
    timestamp: requireSafeInteger(
      value.timestamp,
      `${field}.timestamp`,
      0,
      Number.MAX_SAFE_INTEGER
    ),
  }
}

export function normalizeNativeDetectionResult(
  value: unknown,
  frameWidth: number,
  frameHeight: number
): CoreMLDetectionResult {
  requireSafeInteger(frameWidth, 'frameWidth', 1, Number.MAX_SAFE_INTEGER)
  requireSafeInteger(frameHeight, 'frameHeight', 1, Number.MAX_SAFE_INTEGER)

  if (!isRecord(value)) {
    throw new Error('Invalid native detection response: response must be an object')
  }
  if (typeof value.success !== 'boolean') {
    throw new Error('Invalid native detection response: success must be a boolean')
  }

  const success = value.success
  const detectionsValue = value.detections
  if (!Array.isArray(detectionsValue)) {
    throw new Error('Invalid native detection response: detections must be an array')
  }
  if (detectionsValue.length > MAX_NATIVE_DETECTIONS) {
    throw new Error(
      `Invalid native detection response: detections exceeds the ${MAX_NATIVE_DETECTIONS}-item limit`
    )
  }
  if (!success && detectionsValue.length > 0) {
    throw new Error('Invalid native detection response: failed responses must not carry detections')
  }

  const backend = requireBoundedString(value.backend, 'backend')
  const error = value.error
  if (success && error !== null) {
    throw new Error('Invalid native detection response: successful responses must carry null error')
  }
  if (!success && (typeof error !== 'string' || error.trim().length === 0)) {
    throw new Error(
      'Invalid native detection response: failed responses must carry a non-empty error'
    )
  }

  return {
    success,
    detections: detectionsValue.map((detection, index) =>
      normalizeDetection(detection, index, frameWidth, frameHeight)
    ),
    inferenceTimeMs: requireNonNegativeNumber(value.inferenceTimeMs, 'inferenceTimeMs'),
    preprocessTimeMs: nullableFiniteNumber(value.preprocessTimeMs, 'preprocessTimeMs'),
    postprocessTimeMs: nullableFiniteNumber(value.postprocessTimeMs, 'postprocessTimeMs'),
    backend,
    error: typeof error === 'string' ? error : null,
  }
}
