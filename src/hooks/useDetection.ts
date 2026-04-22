/**
 * CREBAIN Detection Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * React hook for managing detection workers
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Detection,
  DetectorConfig,
  DetectionWorkerMessage,
  DetectionWorkerResponse,
} from '../detection/types'

interface DetectionState {
  isReady: boolean
  isLoading: boolean
  error: string | null
  detections: Detection[]
  inferenceTime: number
  averageLatency: number
}

interface UseDetectionOptions {
  autoInit?: boolean
  config?: Partial<DetectorConfig>
}

interface UseDetectionReturn extends DetectionState {
  initialize: () => Promise<void>
  detect: (imageData: ImageData) => Promise<Detection[]>
  dispose: () => void
}

/**
 * Hook for using detection worker
 */
export function useDetection(options: UseDetectionOptions = {}): UseDetectionReturn {
  const { autoInit = false, config } = options

  const workerRef = useRef<Worker | null>(null)
  // Use a queue to handle multiple concurrent detect() calls
  const pendingCallsRef = useRef<Array<{
    resolve: (detections: Detection[]) => void
    reject: (error: Error) => void
  }>>([])
  const initTimeoutRef = useRef<number | null>(null)

  const [state, setState] = useState<DetectionState>({
    isReady: false,
    isLoading: false,
    error: null,
    detections: [],
    inferenceTime: 0,
    averageLatency: 0,
  })

  /**
   * Handle messages from worker
   */
  const handleWorkerMessage = useCallback((event: MessageEvent<DetectionWorkerResponse>) => {
    const { type, payload } = event.data

    switch (type) {
      case 'ready':
        // Clear initialization timeout on success
        if (initTimeoutRef.current) {
          clearTimeout(initTimeoutRef.current)
          initTimeoutRef.current = null
        }
        setState(prev => ({
          ...prev,
          isReady: true,
          isLoading: false,
          averageLatency: payload?.status?.averageLatency ?? 0,
        }))
        break

      case 'detections':
        setState(prev => ({
          ...prev,
          detections: payload?.detections ?? [],
          inferenceTime: payload?.inferenceTime ?? 0,
        }))
        // Resolve the first pending call in the queue
        const pendingCall = pendingCallsRef.current.shift()
        if (pendingCall) {
          pendingCall.resolve(payload?.detections ?? [])
        }
        break

      case 'error':
        setState(prev => ({
          ...prev,
          error: payload?.error ?? 'Unknown error',
          isLoading: false,
        }))
        // Reject the first pending call in the queue
        const failedCall = pendingCallsRef.current.shift()
        if (failedCall) {
          failedCall.reject(new Error(payload?.error ?? 'Unknown error'))
        }
        break

      case 'status':
        setState(prev => ({
          ...prev,
          isReady: payload?.status?.isReady ?? false,
          averageLatency: payload?.status?.averageLatency ?? 0,
        }))
        break
    }
  }, [])

  /**
   * Initialize the worker with timeout
   */
  const initialize = useCallback(async (): Promise<void> => {
    if (workerRef.current) {
      return
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }))

    try {
      // Create worker - Vite handles the worker bundling
      const worker = new Worker(
        new URL('../detection/DetectionWorker.ts', import.meta.url),
        { type: 'module' }
      )

      worker.onmessage = handleWorkerMessage
      worker.onerror = (error) => {
        // Clear timeout on error
        if (initTimeoutRef.current) {
          clearTimeout(initTimeoutRef.current)
          initTimeoutRef.current = null
        }
        setState(prev => ({
          ...prev,
          error: `Worker error: ${error.message}`,
          isLoading: false,
        }))
      }

      workerRef.current = worker

      // Set initialization timeout (30 seconds)
      initTimeoutRef.current = window.setTimeout(() => {
        const w = workerRef.current
        if (!w) return
        setState(prev => ({
          ...prev,
          error: 'Worker initialization timed out after 30 seconds',
          isLoading: false,
        }))
        // Clear handlers before terminating to prevent stale callbacks
        w.onmessage = null
        w.onerror = null
        w.terminate()
        workerRef.current = null
      }, 30000)

      // Send init message
      const message: DetectionWorkerMessage = {
        type: 'init',
        payload: { config },
      }
      worker.postMessage(message)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState(prev => ({
        ...prev,
        error: `Failed to create worker: ${message}`,
        isLoading: false,
      }))
    }
  }, [config, handleWorkerMessage])

  /**
   * Run detection on image data
   */
  const detect = useCallback(async (imageData: ImageData): Promise<Detection[]> => {
    if (!workerRef.current || !state.isReady) {
      throw new Error('Detector not ready')
    }

    return new Promise((resolve, reject) => {
      // Add to queue instead of overwriting
      pendingCallsRef.current.push({ resolve, reject })

      const message: DetectionWorkerMessage = {
        type: 'detect',
        payload: {
          imageData,
          imageWidth: imageData.width,
          imageHeight: imageData.height,
        },
      }

      workerRef.current!.postMessage(message)
    })
  }, [state.isReady])

  /**
   * Dispose the worker
   */
  const dispose = useCallback(() => {
    // Clear any pending timeout
    if (initTimeoutRef.current) {
      clearTimeout(initTimeoutRef.current)
      initTimeoutRef.current = null
    }
    // Reject any pending calls
    pendingCallsRef.current.forEach(({ reject }) => {
      reject(new Error('Worker disposed'))
    })
    pendingCallsRef.current = []

    if (workerRef.current) {
      // Clean up worker listeners before disposing
      workerRef.current.onmessage = null
      workerRef.current.onerror = null
      const message: DetectionWorkerMessage = { type: 'dispose' }
      workerRef.current.postMessage(message)
      workerRef.current.terminate()
      workerRef.current = null
    }
    setState({
      isReady: false,
      isLoading: false,
      error: null,
      detections: [],
      inferenceTime: 0,
      averageLatency: 0,
    })
  }, [])

  // Auto-initialize if enabled
  useEffect(() => {
    if (autoInit) {
      initialize()
    }

    return () => {
      // Clear timeout on unmount
      if (initTimeoutRef.current) {
        clearTimeout(initTimeoutRef.current)
        initTimeoutRef.current = null
      }
      // Reject pending calls
      pendingCallsRef.current.forEach(({ reject }) => {
        reject(new Error('Component unmounted'))
      })
      pendingCallsRef.current = []

      if (workerRef.current) {
        // Clean up worker listeners to prevent memory leaks
        workerRef.current.onmessage = null
        workerRef.current.onerror = null
        workerRef.current.terminate()
        workerRef.current = null
      }
    }
  }, [autoInit, initialize])

  return {
    ...state,
    initialize,
    detect,
    dispose,
  }
}

// Note: useMultiCameraDetection was removed as the current architecture
// uses a shared worker approach. For per-camera workers, create multiple
// useDetection instances directly in the component.
