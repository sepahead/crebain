/**
 * CREBAIN Performance Tracker Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * Tracks performance history for real-time monitoring
 */

import { useState, useCallback, useRef } from 'react'
import type { PerformanceData } from '../components/PerformancePanel'
import { DEFAULT_MAX_DETECTIONS } from '../detection/types'

interface UsePerformanceTrackerOptions {
  maxHistory?: number
}

interface UsePerformanceTrackerReturn {
  /** Current performance data */
  currentData: PerformanceData | null
  /** History of performance data */
  history: PerformanceData[]
  /** Record a new performance sample */
  recordSample: (data: Omit<PerformanceData, 'timestamp'>) => void
  /** Clear all history */
  clearHistory: () => void
  /** Get average inference time */
  getAverageInferenceTime: () => number
  /** Get total samples recorded */
  totalSamples: number
}

const DEFAULT_MAX_HISTORY = 100
export const MAX_PERFORMANCE_HISTORY = 10_000
export const MAX_PERFORMANCE_DURATION_MS = 24 * 60 * 60 * 1_000

function validatePerformanceSample(data: Omit<PerformanceData, 'timestamp'>): void {
  const durations = [data.inferenceTimeMs, data.preprocessTimeMs, data.postprocessTimeMs].filter(
    (value): value is number => value !== undefined
  )
  if (
    durations.some(
      (value) => !Number.isFinite(value) || value < 0 || value > MAX_PERFORMANCE_DURATION_MS
    )
  ) {
    throw new TypeError(
      `Performance durations must be finite and within 0 and ${MAX_PERFORMANCE_DURATION_MS} ms`
    )
  }
  if (
    !Number.isSafeInteger(data.detectionCount) ||
    data.detectionCount < 0 ||
    data.detectionCount > DEFAULT_MAX_DETECTIONS
  ) {
    throw new TypeError(
      `Performance detection count must be a safe integer within 0 and ${DEFAULT_MAX_DETECTIONS}`
    )
  }
}

/**
 * Hook to track performance history for the PerformancePanel
 */
export function usePerformanceTracker(
  options: UsePerformanceTrackerOptions = {}
): UsePerformanceTrackerReturn {
  const { maxHistory = DEFAULT_MAX_HISTORY } = options
  if (
    !Number.isSafeInteger(maxHistory) ||
    maxHistory <= 0 ||
    maxHistory > MAX_PERFORMANCE_HISTORY
  ) {
    throw new RangeError(
      `Performance history must be within 1 and ${MAX_PERFORMANCE_HISTORY} samples`
    )
  }

  const [currentData, setCurrentData] = useState<PerformanceData | null>(null)
  const [history, setHistory] = useState<PerformanceData[]>([])
  const totalSamplesRef = useRef(0)

  const recordSample = useCallback(
    (data: Omit<PerformanceData, 'timestamp'>) => {
      validatePerformanceSample(data)
      const sample: PerformanceData = {
        ...data,
        timestamp: Date.now(),
      }

      setCurrentData(sample)
      totalSamplesRef.current += 1

      setHistory((prev) => {
        const newHistory = [...prev, sample]
        // Keep only the last maxHistory samples
        if (newHistory.length > maxHistory) {
          return newHistory.slice(-maxHistory)
        }
        return newHistory
      })
    },
    [maxHistory]
  )

  const clearHistory = useCallback(() => {
    setHistory([])
    setCurrentData(null)
    totalSamplesRef.current = 0
  }, [])

  const getAverageInferenceTime = useCallback(() => {
    if (history.length === 0) return 0
    const sum = history.reduce((acc, h) => acc + h.inferenceTimeMs, 0)
    return sum / history.length
  }, [history])

  return {
    currentData,
    history,
    recordSample,
    clearHistory,
    getAverageInferenceTime,
    totalSamples: totalSamplesRef.current,
  }
}

export default usePerformanceTracker
