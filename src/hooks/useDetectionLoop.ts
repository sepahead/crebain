/**
 * CREBAIN Continuous Detection Loop
 * Adaptive Response & Awareness System (ARAS)
 *
 * Hook for running native detection on camera feeds at regular intervals.
 *
 * Uses the backend-side `detect_native_raw` command, which selects the best
 * available detector on the current platform.
 */

import { useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { Detection, CoreMLDetection } from '../detection/types'
import {
  mapToDetectionClass,
  getThreatLevel,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_DETECTIONS,
  DEFAULT_DETECTION_INTERVAL_MS,
} from '../detection/types'
import { normalizeNativeDetectionResult } from '../detection/nativeDetectionResult'
import { TAURI_COMMANDS } from '../lib/tauriCommands'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface CameraInfo {
  id: string
  name: string
  isActive: boolean
}

interface DetectionLoopOptions {
  /** Array of cameras to process */
  cameras: CameraInfo[]
  /** Function to export camera feed as ImageData */
  exportCameraFeed: (cameraId: string) => ImageData | null | Promise<ImageData | null>
  /** Whether detection is enabled */
  enabled: boolean
  /** Interval between detection runs in ms (default: 100) */
  intervalMs?: number
  /** Confidence threshold for detections (default: 0.25) */
  confidenceThreshold?: number
  /** Callback when detections are complete for a camera */
  onDetection?: (cameraId: string, detections: Detection[], inferenceTimeMs: number) => void
  /** Callback with performance metrics */
  onPerformance?: (metrics: {
    inferenceTimeMs: number
    preprocessTimeMs: number
    postprocessTimeMs: number
    detectionCount: number
    cameraId: string
  }) => void
  /** Callback on error */
  onError?: (error: string, cameraId?: string) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Convert CoreML detection to our Detection format
export function convertDetection(coremlDet: CoreMLDetection, frameWidth: number, frameHeight: number): Detection {
  const detClass = mapToDetectionClass(coremlDet.classLabel)
  const threatLevel = getThreatLevel(detClass, coremlDet.confidence)
  
  return {
    id: coremlDet.id,
    class: detClass,
    confidence: coremlDet.confidence,
    bbox: [
      coremlDet.bbox.x1,
      coremlDet.bbox.y1,
      coremlDet.bbox.x2,
      coremlDet.bbox.y2,
    ],
    timestamp: coremlDet.timestamp,
    threatLevel,
    frameWidth,
    frameHeight,
  }
}

// Extract raw RGBA buffer from ImageData for the native detection path.
// Note: Legacy base64 path removed - use `detect_native_raw` for cross-platform demos/tests.
export function imageDataToRGBA(imageData: ImageData): Uint8Array {
  return new Uint8Array(
    imageData.data.buffer,
    imageData.data.byteOffset,
    imageData.data.byteLength
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hook for running continuous native detection on camera feeds
 * 
 * Features:
 * - Runs detection every intervalMs (default 100ms = 10 FPS)
 * - Prevents overlapping detections with a lock mechanism
 * - Cycles through all active cameras each interval
 * - Reports detections and performance metrics via callbacks
 */
export function useDetectionLoop(options: DetectionLoopOptions): void {
  const {
    cameras,
    exportCameraFeed,
    enabled,
    intervalMs = DEFAULT_DETECTION_INTERVAL_MS,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
    onDetection,
    onPerformance,
    onError,
  } = options

  // Lock to prevent overlapping detection runs
  const isProcessingRef = useRef(false)
  // Track current camera index for round-robin processing
  const currentCameraIndexRef = useRef(0)
  const loopGenerationRef = useRef(0)

  // Stable reference to the detection function
  const runDetectionCycle = useCallback(async (isCurrent: () => boolean = () => true) => {
    // Skip if already processing or no cameras
    if (isProcessingRef.current) return
    
    const activeCameras = cameras.filter(c => c.isActive)
    if (activeCameras.length === 0) return

    isProcessingRef.current = true
    let processingCameraId: string | undefined

    try {
      // Round-robin: process one camera per cycle for better performance
      const cameraIndex = currentCameraIndexRef.current % activeCameras.length
      const camera = activeCameras[cameraIndex]
      processingCameraId = camera.id
      currentCameraIndexRef.current = (cameraIndex + 1) % activeCameras.length

      // Export camera feed
      const imageData = await exportCameraFeed(camera.id)
      if (!isCurrent()) return
      if (!imageData) {
        isProcessingRef.current = false
        return
      }

      // Use the raw RGBA path to avoid PNG encode/decode overhead.
      // Uint8Array is serializable by Tauri 2.x to Vec<u8>.
      const rgbaData = imageDataToRGBA(imageData)

      const response = await invoke<unknown>(TAURI_COMMANDS.detection.nativeRaw, {
        rgbaData,
        width: imageData.width,
        height: imageData.height,
        confidenceThreshold,
        maxDetections: DEFAULT_MAX_DETECTIONS,
      })
      if (!isCurrent()) return
      const result = normalizeNativeDetectionResult(response)

      if (!result.success) {
        onError?.(result.error || 'Detection failed', camera.id)
        isProcessingRef.current = false
        return
      }

      // Convert detections
      const detections = result.detections.map(det => convertDetection(det, imageData.width, imageData.height))

      // Report detections
      onDetection?.(camera.id, detections, result.inferenceTimeMs)

      // Report performance
      onPerformance?.({
        inferenceTimeMs: result.inferenceTimeMs,
        preprocessTimeMs: result.preprocessTimeMs ?? 0,
        postprocessTimeMs: result.postprocessTimeMs ?? 0,
        detectionCount: detections.length,
        cameraId: camera.id,
      })

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onError?.(message, processingCameraId)
    } finally {
      isProcessingRef.current = false
    }
  }, [cameras, exportCameraFeed, confidenceThreshold, onDetection, onPerformance, onError])

  // Set up the detection loop using async iteration for better backpressure handling
  // This prevents queue buildup when detection takes longer than intervalMs
  useEffect(() => {
    if (!enabled) {
      loopGenerationRef.current += 1
      return
    }

    let cancelled = false
    const generation = loopGenerationRef.current + 1
    loopGenerationRef.current = generation
    const isCurrent = () => !cancelled && loopGenerationRef.current === generation

    const loop = async () => {
      while (!cancelled) {
        await runDetectionCycle(isCurrent)
        
        if (!cancelled) {
          await new Promise(resolve => setTimeout(resolve, intervalMs))
        }
      }
    }

    loop()

    return () => {
      cancelled = true
      loopGenerationRef.current += 1
    }
  }, [enabled, intervalMs, runDetectionCycle])
}

export default useDetectionLoop
