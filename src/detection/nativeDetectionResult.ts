import type { CoreMLBoundingBox, CoreMLDetection, CoreMLDetectionResult } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid native detection response: ${field} must be a finite number`)
  }
  return value
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  return requireFiniteNumber(value, field)
}

function normalizeBoundingBox(value: unknown, field: string): CoreMLBoundingBox {
  if (!isRecord(value)) {
    throw new Error(`Invalid native detection response: ${field} must be an object`)
  }

  return {
    x1: requireFiniteNumber(value.x1, `${field}.x1`),
    y1: requireFiniteNumber(value.y1, `${field}.y1`),
    x2: requireFiniteNumber(value.x2, `${field}.x2`),
    y2: requireFiniteNumber(value.y2, `${field}.y2`),
  }
}

function normalizeDetection(value: unknown, index: number): CoreMLDetection {
  const field = `detections[${index}]`
  if (!isRecord(value)) {
    throw new Error(`Invalid native detection response: ${field} must be an object`)
  }
  if (typeof value.id !== 'string') {
    throw new Error(`Invalid native detection response: ${field}.id must be a string`)
  }
  if (typeof value.classLabel !== 'string') {
    throw new Error(`Invalid native detection response: ${field}.classLabel must be a string`)
  }

  return {
    id: value.id,
    classLabel: value.classLabel,
    classIndex: requireFiniteNumber(value.classIndex, `${field}.classIndex`),
    confidence: requireFiniteNumber(value.confidence, `${field}.confidence`),
    bbox: normalizeBoundingBox(value.bbox, `${field}.bbox`),
    timestamp: requireFiniteNumber(value.timestamp, `${field}.timestamp`),
  }
}

export function normalizeNativeDetectionResult(value: unknown): CoreMLDetectionResult {
  if (!isRecord(value)) {
    throw new Error('Invalid native detection response: response must be an object')
  }
  if (typeof value.success !== 'boolean') {
    throw new Error('Invalid native detection response: success must be a boolean')
  }

  const success = value.success
  const detectionsValue = value.detections
  if (success && !Array.isArray(detectionsValue)) {
    throw new Error('Invalid native detection response: detections must be an array')
  }

  return {
    success,
    detections: Array.isArray(detectionsValue) ? detectionsValue.map(normalizeDetection) : [],
    inferenceTimeMs: success ? requireFiniteNumber(value.inferenceTimeMs, 'inferenceTimeMs') : nullableFiniteNumber(value.inferenceTimeMs, 'inferenceTimeMs') ?? 0,
    preprocessTimeMs: nullableFiniteNumber(value.preprocessTimeMs, 'preprocessTimeMs'),
    postprocessTimeMs: nullableFiniteNumber(value.postprocessTimeMs, 'postprocessTimeMs'),
    backend: typeof value.backend === 'string' ? value.backend : null,
    error: typeof value.error === 'string' ? value.error : null,
  }
}
