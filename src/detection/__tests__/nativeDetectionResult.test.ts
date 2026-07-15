import { describe, expect, it } from 'vitest'
import { normalizeNativeDetectionResult } from '../nativeDetectionResult'

const FRAME_WIDTH = 640
const FRAME_HEIGHT = 480

function validResponse() {
  return {
    success: true,
    detections: [
      {
        id: 'native-1',
        classLabel: 'drone',
        classIndex: 0,
        confidence: 0.75,
        bbox: { x1: 10, y1: 20, x2: 30, y2: 40 },
        timestamp: 1_700_000_000_000,
      },
    ],
    inferenceTimeMs: 4,
    preprocessTimeMs: null,
    postprocessTimeMs: null,
    backend: 'ONNX Runtime',
    error: null,
  }
}

describe('normalizeNativeDetectionResult', () => {
  it('accepts the bounded native IPC contract', () => {
    expect(normalizeNativeDetectionResult(validResponse(), FRAME_WIDTH, FRAME_HEIGHT)).toEqual(
      validResponse()
    )
  })

  it.each([
    ['NaN confidence', { confidence: Number.NaN }],
    ['out-of-range confidence', { confidence: 1.01 }],
    ['fractional class index', { classIndex: 1.5 }],
    ['out-of-range class index', { classIndex: 80 }],
    ['fractional timestamp', { timestamp: 1.5 }],
    ['negative timestamp', { timestamp: -1 }],
    ['inverted box', { bbox: { x1: 30, y1: 20, x2: 10, y2: 40 } }],
    ['out-of-frame box', { bbox: { x1: 10, y1: 20, x2: 641, y2: 40 } }],
  ])('rejects a detection with %s', (_name, mutation) => {
    const response = validResponse()
    response.detections[0] = { ...response.detections[0], ...mutation }

    expect(() => normalizeNativeDetectionResult(response, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      'Invalid native detection response'
    )
  })

  it('rejects oversized detection arrays before traversing them', () => {
    const response = validResponse()
    response.detections = Array.from({ length: 101 }, () => response.detections[0])

    expect(() => normalizeNativeDetectionResult(response, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      '100-item limit'
    )
  })

  it('rejects inconsistent success and error envelopes', () => {
    const response = { ...validResponse(), error: 'unexpected error' }

    expect(() => normalizeNativeDetectionResult(response, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      'successful responses must carry null error'
    )
  })
})
