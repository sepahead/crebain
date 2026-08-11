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
import { runNativeDetectionRequest } from '../detection/nativeDetectionRequest'
import { TAURI_COMMANDS } from '../lib/tauriCommands'
import { isEngramEmbeddedMode } from '../integrations/engramHost'
import { detectionLogger as log } from '../lib/logger'
import { isBoundedSceneName, MAX_SCENE_CAMERAS } from '../lib/sceneLimits'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface CameraInfo {
  id: string
  name: string
  isActive: boolean
  /** Stable for metadata edits and different for a replacement camera instance. */
  instanceId: string
}

interface CaptureDropReport {
  instanceId: string
  reportedAt: number
}

export function pruneCaptureDropReports(
  reports: Map<string, CaptureDropReport>,
  cameras: ReadonlyArray<{ id: string; instanceId: string }>
): void {
  const currentInstances = new Map(cameras.map((camera) => [camera.id, camera.instanceId]))
  for (const [cameraId, report] of reports) {
    if (currentInstances.get(cameraId) !== report.instanceId) reports.delete(cameraId)
  }
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

export const CAMERA_CAPTURE_UNAVAILABLE_ERROR =
  'Camera capture unavailable; detection cycle skipped'
export const CAMERA_CAPTURE_DROP_REPORT_INTERVAL_MS = 5_000
export const MAX_DETECTION_INTERVAL_MS = 60_000

export function normalizeDetectionIntervalMs(value: number): number {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DETECTION_INTERVAL_MS
    ? value
    : DEFAULT_DETECTION_INTERVAL_MS
}

export function normalizeDetectionConfidenceThreshold(value: number): number {
  return Number.isFinite(value) && value >= DEFAULT_CONFIDENCE_THRESHOLD && value <= 1
    ? value
    : DEFAULT_CONFIDENCE_THRESHOLD
}

function selectActiveCameras(cameras: readonly CameraInfo[]): CameraInfo[] {
  const selected: CameraInfo[] = []
  const seenIds = new Set<string>()
  for (const camera of cameras) {
    if (selected.length >= MAX_SCENE_CAMERAS) break
    if (
      !camera?.isActive ||
      !isBoundedSceneName(camera.id) ||
      !isBoundedSceneName(camera.instanceId) ||
      seenIds.has(camera.id)
    ) {
      continue
    }
    seenIds.add(camera.id)
    selected.push({ ...camera })
  }
  return selected
}

function notifyDetectionObserver(label: string, observer: (() => void) | undefined): void {
  if (!observer) return
  try {
    observer()
  } catch (error) {
    log.warn(`${label} callback failed`, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Convert CoreML detection to our Detection format
export function convertDetection(
  coremlDet: CoreMLDetection,
  frameWidth: number,
  frameHeight: number
): Detection {
  const detClass = mapToDetectionClass(coremlDet.classLabel)
  const threatLevel = getThreatLevel(detClass, coremlDet.confidence)

  return {
    id: coremlDet.id,
    class: detClass,
    confidence: coremlDet.confidence,
    bbox: [coremlDet.bbox.x1, coremlDet.bbox.y1, coremlDet.bbox.x2, coremlDet.bbox.y2],
    timestamp: coremlDet.timestamp,
    threatLevel,
    frameWidth,
    frameHeight,
  }
}

// Extract raw RGBA buffer from ImageData for the native detection path.
// Note: Legacy base64 path removed - use `detect_native_raw` for cross-platform demos/tests.
export function imageDataToRGBA(imageData: ImageData): Uint8Array {
  return new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength)
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
  const nativeAccessAllowed = !isEngramEmbeddedMode()
  const effectiveIntervalMs = normalizeDetectionIntervalMs(intervalMs)

  // Lock to prevent overlapping detection runs
  const isProcessingRef = useRef(false)
  // Track current camera index for round-robin processing
  const currentCameraIndexRef = useRef(0)
  const loopGenerationRef = useRef(0)
  const captureDropReportsRef = useRef<Map<string, CaptureDropReport>>(new Map())

  // Detection inputs can change independently of the scheduler. Keeping their
  // latest values in refs prevents ordinary parent renders from cancelling and
  // immediately restarting the loop while still applying updates next cycle.
  const camerasRef = useRef(cameras)
  const exportCameraFeedRef = useRef(exportCameraFeed)
  const confidenceThresholdRef = useRef(confidenceThreshold)
  const onDetectionRef = useRef(onDetection)
  const onPerformanceRef = useRef(onPerformance)
  const onErrorRef = useRef(onError)

  camerasRef.current = cameras
  exportCameraFeedRef.current = exportCameraFeed
  confidenceThresholdRef.current = normalizeDetectionConfidenceThreshold(confidenceThreshold)
  onDetectionRef.current = onDetection
  onPerformanceRef.current = onPerformance
  onErrorRef.current = onError

  useEffect(() => {
    pruneCaptureDropReports(captureDropReportsRef.current, cameras)
  }, [cameras])

  // Stable reference to the detection function
  const runDetectionCycle = useCallback(
    async (isCurrent: () => boolean = () => true, signal?: AbortSignal) => {
      // Skip if already processing or no cameras
      if (isProcessingRef.current) return

      const activeCameras = selectActiveCameras(camerasRef.current)
      if (activeCameras.length === 0) return

      isProcessingRef.current = true
      let processingCameraId: string | undefined

      try {
        // Round-robin: process one camera per cycle for better performance
        const cameraIndex = currentCameraIndexRef.current % activeCameras.length
        const camera = activeCameras[cameraIndex]
        processingCameraId = camera.id
        const cameraIsStillActive = () =>
          camerasRef.current.some(
            (currentCamera) =>
              currentCamera.id === camera.id &&
              currentCamera.instanceId === camera.instanceId &&
              currentCamera.isActive
          )
        currentCameraIndexRef.current = (cameraIndex + 1) % activeCameras.length

        // Export camera feed
        const imageData = await exportCameraFeedRef.current(camera.id)
        if (!isCurrent() || !cameraIsStillActive()) return
        if (!imageData) {
          const now = Date.now()
          const previousReport = captureDropReportsRef.current.get(camera.id)
          if (
            previousReport === undefined ||
            previousReport.instanceId !== camera.instanceId ||
            now < previousReport.reportedAt ||
            now - previousReport.reportedAt >= CAMERA_CAPTURE_DROP_REPORT_INTERVAL_MS
          ) {
            captureDropReportsRef.current.set(camera.id, {
              instanceId: camera.instanceId,
              reportedAt: now,
            })
            notifyDetectionObserver('Detection error', () =>
              onErrorRef.current?.(CAMERA_CAPTURE_UNAVAILABLE_ERROR, camera.id)
            )
          }
          return
        }
        // A recovered feed starts a new outage window if capture later drops again.
        captureDropReportsRef.current.delete(camera.id)

        // Use the raw RGBA path to avoid PNG encode/decode overhead.
        // Uint8Array is serializable by Tauri 2.x to Vec<u8>.
        const rgbaData = imageDataToRGBA(imageData)

        const response = await runNativeDetectionRequest(
          () =>
            invoke<unknown>(TAURI_COMMANDS.detection.nativeRaw, {
              rgbaData,
              width: imageData.width,
              height: imageData.height,
              confidenceThreshold: confidenceThresholdRef.current,
              maxDetections: DEFAULT_MAX_DETECTIONS,
            }),
          { signal, isCurrent }
        )
        if (!isCurrent() || !cameraIsStillActive()) return
        const result = normalizeNativeDetectionResult(response, imageData.width, imageData.height)

        if (!result.success) {
          notifyDetectionObserver('Detection error', () =>
            onErrorRef.current?.(result.error || 'Detection failed', camera.id)
          )
          return
        }

        // Convert detections
        const detections = result.detections.map((det) =>
          convertDetection(det, imageData.width, imageData.height)
        )

        // Report detections
        notifyDetectionObserver('Detection result', () =>
          onDetectionRef.current?.(camera.id, detections, result.inferenceTimeMs)
        )

        // Report performance
        notifyDetectionObserver('Detection performance', () =>
          onPerformanceRef.current?.({
            inferenceTimeMs: result.inferenceTimeMs,
            preprocessTimeMs: result.preprocessTimeMs ?? 0,
            postprocessTimeMs: result.postprocessTimeMs ?? 0,
            detectionCount: detections.length,
            cameraId: camera.id,
          })
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (isCurrent()) {
          notifyDetectionObserver('Detection error', () =>
            onErrorRef.current?.(message, processingCameraId)
          )
        }
      } finally {
        isProcessingRef.current = false
      }
    },
    []
  )

  // Set up the detection loop using async iteration for better backpressure handling
  // This prevents queue buildup when detection takes longer than intervalMs
  useEffect(() => {
    if (!enabled || !nativeAccessAllowed) {
      loopGenerationRef.current += 1
      return
    }

    let cancelled = false
    const requestController = new AbortController()
    const generation = loopGenerationRef.current + 1
    loopGenerationRef.current = generation
    const isCurrent = () => !cancelled && loopGenerationRef.current === generation

    let delayId: ReturnType<typeof setTimeout> | undefined
    const loop = async (): Promise<void> => {
      await runDetectionCycle(isCurrent, requestController.signal)
      if (!cancelled) {
        delayId = setTimeout(() => void loop(), effectiveIntervalMs)
      }
    }

    void loop()

    return () => {
      cancelled = true
      loopGenerationRef.current += 1
      if (delayId !== undefined) clearTimeout(delayId)
      requestController.abort(new DOMException('Detection loop stopped', 'AbortError'))
    }
  }, [effectiveIntervalMs, enabled, nativeAccessAllowed, runDetectionCycle])
}

export default useDetectionLoop
