import { describe, it, expect } from 'vitest'
import { convertDetection, imageDataToRGBA } from '../useDetectionLoop'
import type { CoreMLDetection } from '../../detection/types'

describe('useDetectionLoop helpers', () => {
  it('maps native detections to tactical detections', () => {
    const nativeDetection: CoreMLDetection = {
      id: 'det-1',
      classLabel: 'kite',
      classIndex: 33,
      confidence: 0.9,
      bbox: { x1: 10, y1: 20, x2: 30, y2: 40 },
      timestamp: 1234,
    }

    const detection = convertDetection(nativeDetection, 640, 480)

    expect(detection).toMatchObject({
      id: 'det-1',
      class: 'drone',
      confidence: 0.9,
      bbox: [10, 20, 30, 40],
      timestamp: 1234,
      threatLevel: 4,
      frameWidth: 640,
      frameHeight: 480,
    })
  })

  it('creates a zero-copy Uint8Array view over ImageData', () => {
    const imageData = {
      data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]),
      width: 1,
      height: 2,
      colorSpace: 'srgb',
    } as ImageData
    const rgba = imageDataToRGBA(imageData)

    expect(rgba).toBeInstanceOf(Uint8Array)
    expect(Array.from(rgba)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    imageData.data[0] = 9
    expect(rgba[0]).toBe(9)
  })
})
