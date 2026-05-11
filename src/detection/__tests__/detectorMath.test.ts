import { describe, expect, it } from 'vitest'
import {
  centerBoxToCorners,
  clampBoxToImage,
  computeLetterboxGeometry,
  findMaxScore,
  findMaxYoloClassScore,
  intersectionOverUnion,
  isLikelyNormalizedBox,
  nonMaxSuppression,
  projectLetterboxBoxToImage,
  readYoloCenterBox,
  recordLatency,
  scaleNormalizedBox,
  averageLatency,
} from '../detectorMath'
import type { Detection } from '../types'

describe('detectorMath', () => {
  it('computes letterbox geometry for wide and tall images', () => {
    expect(computeLetterboxGeometry({ width: 1280, height: 720 }, { width: 640, height: 640 })).toEqual({
      scale: 0.5,
      offsetX: 0,
      offsetY: 140,
      scaledWidth: 640,
      scaledHeight: 360,
    })
    expect(computeLetterboxGeometry({ width: 720, height: 1280 }, { width: 640, height: 640 })).toEqual({
      scale: 0.5,
      offsetX: 140,
      offsetY: 0,
      scaledWidth: 360,
      scaledHeight: 640,
    })
  })

  it('projects and clamps boxes through letterbox geometry', () => {
    const geometry = computeLetterboxGeometry({ width: 1280, height: 720 }, { width: 640, height: 640 })
    const projected = projectLetterboxBoxToImage([100, 160, 300, 260], geometry)

    expect(projected).toEqual([200, 40, 600, 240])
    expect(clampBoxToImage([-10, 40, 1500, 800], { width: 1280, height: 720 })).toEqual([0, 40, 1280, 720])
  })

  it('scales normalized boxes and computes IoU', () => {
    expect(isLikelyNormalizedBox([0.1, 0.2, 0.5, 0.8])).toBe(true)
    expect(scaleNormalizedBox([0.1, 0.2, 0.5, 0.8], { width: 640, height: 480 })).toEqual([64, 96, 320, 384])
    expect(intersectionOverUnion([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(25 / 175)
  })

  it('reads YOLO channel-first boxes and class scores', () => {
    const numPredictions = 2
    const output = new Float32Array(8 * numPredictions)
    output[1] = 20
    output[numPredictions + 1] = 30
    output[2 * numPredictions + 1] = 10
    output[3 * numPredictions + 1] = 8
    output[4 * numPredictions + 1] = 0.25
    output[5 * numPredictions + 1] = 0.75

    expect(centerBoxToCorners(20, 30, 10, 8)).toEqual([15, 26, 25, 34])
    expect(readYoloCenterBox(output, numPredictions, 1)).toEqual([15, 26, 25, 34])
    expect(findMaxYoloClassScore(output, numPredictions, 1, 2)).toEqual({ classIndex: 1, score: 0.75 })
  })

  it('finds max score with custom stride and caps latency history', () => {
    const score = findMaxScore(new Float32Array([0.1, 99, 0.9, 99, 0.2]), 0, 3, 2)
    expect(score.classIndex).toBe(1)
    expect(score.score).toBeCloseTo(0.9)

    const history = [1, 2]
    expect(recordLatency(history, 2, 10, 16)).toBe(6)
    expect(history).toEqual([2, 6])
    expect(averageLatency(history)).toBe(4)
    expect(averageLatency([])).toBe(0)
  })

  it('applies class-agnostic non-maximum suppression by confidence', () => {
    const detections: Detection[] = [
      {
        id: 'low-overlap',
        class: 'drone',
        confidence: 0.8,
        bbox: [1, 1, 11, 11],
        timestamp: 1,
        threatLevel: 3,
      },
      {
        id: 'best',
        class: 'drone',
        confidence: 0.9,
        bbox: [0, 0, 10, 10],
        timestamp: 1,
        threatLevel: 4,
      },
      {
        id: 'far',
        class: 'bird',
        confidence: 0.7,
        bbox: [100, 100, 110, 110],
        timestamp: 1,
        threatLevel: 2,
      },
    ]

    expect(nonMaxSuppression(detections, 0.5).map((detection) => detection.id)).toEqual(['best', 'far'])
  })
})
