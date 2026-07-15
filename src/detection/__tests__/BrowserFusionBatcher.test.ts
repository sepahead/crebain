import { describe, expect, it } from 'vitest'
import { BrowserFusionBatcher, MAX_BROWSER_FUSION_PENDING_CAMERAS } from '../BrowserFusionBatcher'
import type { Detection } from '../types'

function detection(id: string, timestamp: number): Detection {
  return {
    id,
    class: 'drone',
    confidence: 0.9,
    bbox: [1, 1, 2, 2],
    timestamp,
  }
}

describe('BrowserFusionBatcher', () => {
  it('consumes each camera frame once instead of replaying retained display data', () => {
    const batcher = new BrowserFusionBatcher()
    expect(batcher.enqueue('camera-a', [detection('a', 100)], 90)).toBe('accepted')
    expect(batcher.enqueue('camera-b', [detection('b', 110)], 95)).toBe('accepted')

    const first = batcher.takeBatch()
    expect(first?.context).toEqual({
      frameId: 'visual:1:1',
      epoch: 1,
      timestampMs: 110,
    })
    expect(first?.detections.get('camera-a')?.[0].id).toBe('a')
    expect(first?.sourceFrameIds.get('camera-a')).toBe('1:1')
    expect(batcher.takeBatch()).toBeNull()

    expect(batcher.enqueue('camera-b', [detection('b-next', 120)], 115)).toBe('accepted')
    const second = batcher.takeBatch()
    expect(second?.context.epoch).toBe(2)
    expect(second?.detections.has('camera-a')).toBe(false)
    expect(second?.detections.get('camera-b')?.[0].id).toBe('b-next')
  })

  it('bounds pending work at the 64-camera viewer envelope', () => {
    const batcher = new BrowserFusionBatcher()
    for (let index = 0; index < MAX_BROWSER_FUSION_PENDING_CAMERAS; index += 1) {
      expect(batcher.enqueue(`camera-${index}`, [], index)).toBe('accepted')
    }
    expect(batcher.enqueue('camera-overflow', [], 100)).toBe('rejected_capacity')
    expect(batcher.takeBatch()?.detections).toHaveProperty(
      'size',
      MAX_BROWSER_FUSION_PENDING_CAMERAS
    )
  })

  it('invalidates queued frames on scene reset without reusing a batch identity', () => {
    const batcher = new BrowserFusionBatcher()
    batcher.enqueue('camera-a', [detection('restored', 100)], 100)
    batcher.reset()
    expect(batcher.takeBatch()).toBeNull()

    batcher.enqueue('camera-a', [detection('live', 200)], 200)
    expect(batcher.takeBatch()?.context.frameId).toBe('visual:2:1')
  })

  it('reports deterministic latest-wins eviction before a duplicate camera can amplify work', () => {
    const batcher = new BrowserFusionBatcher()
    expect(batcher.enqueue('camera-a', [detection('old', 100)], 100)).toBe('accepted')
    expect(batcher.enqueue('camera-a', [detection('new', 110)], 110)).toBe(
      'evicted_pending_camera_frame'
    )
    expect(
      batcher
        .takeBatch()
        ?.detections.get('camera-a')
        ?.map(({ id }) => id)
    ).toEqual(['new'])
  })
})
