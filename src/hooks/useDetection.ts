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
  // Correlate concurrent detect() calls by request id rather than FIFO order:
  // worker responses can arrive out of order, so FIFO matching would resolve a
  // call with another request's detections.
  const pendingCallsRef = useRef<
    Map<
      number,
      {
        resolve: (detections: Detection[]) => void
        reject: (error: Error) => void
      }
    >
  >(new Map())
  const nextRequestIdRef = useRef(0)
  const initTimeoutRef = useRef<number | null>(null)

  const [state, setState] = useState<DetectionState>({
    isReady: false,
    isLoading: false,
    error: null,
    detections: [],
    inferenceTime: 0,
    averageLatency: 0,
  })

  const rejectPendingCalls = useCallback((error: Error) => {
    pendingCallsRef.current.forEach(({ reject }) => {
      reject(error)
    })
    pendingCallsRef.current.clear()
  }, [])

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
        setState((prev) => ({
          ...prev,
          isReady: true,
          isLoading: false,
          averageLatency: payload?.status?.averageLatency ?? 0,
        }))
        break

      case 'detections': {
        setState((prev) => ({
          ...prev,
          detections: payload?.detections ?? [],
          inferenceTime: payload?.inferenceTime ?? 0,
        }))
        // Resolve the specific call that issued this request id.
        const { requestId } = event.data
        if (requestId !== undefined) {
          const pendingCall = pendingCallsRef.current.get(requestId)
          if (pendingCall) {
            pendingCallsRef.current.delete(requestId)
            pendingCall.resolve(payload?.detections ?? [])
          }
        }
        break
      }

      case 'error': {
        setState((prev) => ({
          ...prev,
          error: payload?.error ?? 'Unknown error',
          isLoading: false,
        }))
        // Reject only the call this error belongs to. Errors without a request
        // id are global (init/status) and must not reject an in-flight detect().
        const { requestId } = event.data
        if (requestId !== undefined) {
          const failedCall = pendingCallsRef.current.get(requestId)
          if (failedCall) {
            pendingCallsRef.current.delete(requestId)
            failedCall.reject(new Error(payload?.error ?? 'Unknown error'))
          }
        }
        break
      }

      case 'status':
        setState((prev) => ({
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
  const initialize = useCallback((): Promise<void> => {
    if (workerRef.current) {
      return Promise.resolve()
    }

    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      // Create worker - Vite handles the worker bundling
      const worker = new Worker(new URL('../detection/DetectionWorker.ts', import.meta.url), {
        type: 'module',
      })

      worker.onmessage = handleWorkerMessage
      worker.onerror = (error) => {
        // Clear timeout on error
        if (initTimeoutRef.current) {
          clearTimeout(initTimeoutRef.current)
          initTimeoutRef.current = null
        }
        setState((prev) => ({
          ...prev,
          error: `Worker error: ${error.message}`,
          isLoading: false,
          isReady: false,
        }))
        rejectPendingCalls(new Error(`Worker error: ${error.message}`))
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
        if (workerRef.current === worker) {
          workerRef.current = null
        }
      }

      workerRef.current = worker

      // Set initialization timeout (30 seconds)
      initTimeoutRef.current = window.setTimeout(() => {
        const w = workerRef.current
        if (!w) return
        setState((prev) => ({
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
      setState((prev) => ({
        ...prev,
        error: `Failed to create worker: ${message}`,
        isLoading: false,
      }))
    }
    return Promise.resolve()
  }, [config, handleWorkerMessage, rejectPendingCalls])

  /**
   * Run detection on image data
   */
  const detect = useCallback(
    async (imageData: ImageData): Promise<Detection[]> => {
      if (!workerRef.current || !state.isReady) {
        throw new Error('Detector not ready')
      }

      return new Promise((resolve, reject) => {
        const requestId = nextRequestIdRef.current++
        pendingCallsRef.current.set(requestId, { resolve, reject })

        const message: DetectionWorkerMessage = {
          type: 'detect',
          requestId,
          payload: {
            imageData,
            imageWidth: imageData.width,
            imageHeight: imageData.height,
          },
        }

        workerRef.current!.postMessage(message)
      })
    },
    [state.isReady]
  )

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
    rejectPendingCalls(new Error('Worker disposed'))

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
  }, [rejectPendingCalls])

  // Auto-initialize if enabled
  useEffect(() => {
    if (autoInit) {
      void initialize()
    }

    return () => {
      // Clear timeout on unmount
      if (initTimeoutRef.current) {
        clearTimeout(initTimeoutRef.current)
        initTimeoutRef.current = null
      }
      // Reject pending calls
      rejectPendingCalls(new Error('Component unmounted'))

      if (workerRef.current) {
        // Clean up worker listeners to prevent memory leaks
        workerRef.current.onmessage = null
        workerRef.current.onerror = null
        workerRef.current.terminate()
        workerRef.current = null
      }
    }
  }, [autoInit, initialize, rejectPendingCalls])

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
