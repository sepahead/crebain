import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_PERFORMANCE_DURATION_MS,
  MAX_PERFORMANCE_HISTORY,
  usePerformanceTracker,
} from '../usePerformanceTracker'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let tracker: ReturnType<typeof usePerformanceTracker>

function Harness({ maxHistory }: { maxHistory: number }) {
  tracker = usePerformanceTracker({ maxHistory })
  return null
}

describe('usePerformanceTracker', () => {
  const roots: Array<ReturnType<typeof createRoot>> = []

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount())
  })

  async function render(maxHistory: number) {
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    await act(async () => root.render(<Harness maxHistory={maxHistory} />))
  }

  it('bounds retained history and keeps the lifetime sample count', async () => {
    await render(2)

    await act(async () => {
      tracker.recordSample({ inferenceTimeMs: 1, detectionCount: 1 })
      tracker.recordSample({ inferenceTimeMs: 2, detectionCount: 2 })
      tracker.recordSample({ inferenceTimeMs: 3, detectionCount: 3 })
    })

    expect(tracker.history.map((sample) => sample.inferenceTimeMs)).toEqual([2, 3])
    expect(tracker.totalSamples).toBe(3)
    expect(tracker.getAverageInferenceTime()).toBe(2.5)
  })

  it('rejects unsafe configuration and non-finite samples before state changes', async () => {
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    expect(() => {
      act(() => root.render(<Harness maxHistory={MAX_PERFORMANCE_HISTORY + 1} />))
    }).toThrow('Performance history')
    await act(async () => root.unmount())
    roots.splice(roots.indexOf(root), 1)

    await render(2)
    expect(() => tracker.recordSample({ inferenceTimeMs: Number.NaN, detectionCount: 0 })).toThrow(
      'finite'
    )
    expect(() => tracker.recordSample({ inferenceTimeMs: 1, detectionCount: 0.5 })).toThrow(
      'safe integer'
    )
    expect(() =>
      tracker.recordSample({
        inferenceTimeMs: MAX_PERFORMANCE_DURATION_MS + 1,
        detectionCount: 0,
      })
    ).toThrow('Performance durations')
    expect(() => tracker.recordSample({ inferenceTimeMs: 1, detectionCount: 101 })).toThrow(
      'within 0 and 100'
    )
    expect(tracker.history).toEqual([])
  })
})
