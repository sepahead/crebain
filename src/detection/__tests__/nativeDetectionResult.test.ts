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

  it('rejects duplicate identities and undeclared response fields', () => {
    const duplicate = validResponse()
    duplicate.detections.push({ ...duplicate.detections[0] })
    expect(() => normalizeNativeDetectionResult(duplicate, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      'detection IDs must be unique'
    )

    expect(() =>
      normalizeNativeDetectionResult(
        { ...validResponse(), authority: 'none' },
        FRAME_WIDTH,
        FRAME_HEIGHT
      )
    ).toThrow('response must be an object')
    expect(() =>
      normalizeNativeDetectionResult(
        {
          ...validResponse(),
          detections: [{ ...validResponse().detections[0], authority: 'none' }],
        },
        FRAME_WIDTH,
        FRAME_HEIGHT
      )
    ).toThrow('detections[0] must be an object')
  })

  it('rejects inconsistent success and error envelopes', () => {
    const response = { ...validResponse(), error: 'unexpected error' }

    expect(() => normalizeNativeDetectionResult(response, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      'successful responses must carry null error'
    )
  })

  it('rejects unbounded native timings and error text', () => {
    expect(() =>
      normalizeNativeDetectionResult(
        { ...validResponse(), inferenceTimeMs: 86_400_001 },
        FRAME_WIDTH,
        FRAME_HEIGHT
      )
    ).toThrow('inferenceTimeMs must be at most')

    expect(() =>
      normalizeNativeDetectionResult(
        {
          ...validResponse(),
          success: false,
          detections: [],
          error: 'x'.repeat(2_049),
        },
        FRAME_WIDTH,
        FRAME_HEIGHT
      )
    ).toThrow('error must be a non-empty string of at most 2048 UTF-8 bytes')
  })

  it('rejects unsafe identity text and measures its UTF-8 byte length', () => {
    const nulLabel = validResponse()
    nulLabel.detections[0].classLabel = 'bad\0label'
    expect(() => normalizeNativeDetectionResult(nulLabel, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      'classLabel'
    )

    const c1ControlLabel = validResponse()
    c1ControlLabel.detections[0].classLabel = 'bad\u0085label'
    expect(() => normalizeNativeDetectionResult(c1ControlLabel, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      'classLabel'
    )

    const multibyteLabel = validResponse()
    multibyteLabel.detections[0].classLabel = '€'.repeat(86)
    expect(() => normalizeNativeDetectionResult(multibyteLabel, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      '256 UTF-8 bytes'
    )
  })
})
