import type { FusionFrameContext } from './SensorFusion'
import type { Detection } from './types'

export const BROWSER_FUSION_BATCH_WINDOW_MS = 200
export const MAX_BROWSER_FUSION_PENDING_CAMERAS = 64

interface PendingCameraFrame {
  detections: Detection[]
  receivedAtMs: number
  sourceFrameId: string
}

export interface BrowserFusionBatch {
  context: FusionFrameContext
  detections: Map<string, Detection[]>
  sourceFrameIds: ReadonlyMap<string, string>
}

export type BrowserFusionEnqueueStatus =
  'accepted' | 'evicted_pending_camera_frame' | 'rejected_invalid' | 'rejected_capacity'

/**
 * One-shot coalescer for the browser visualization fusion path.
 *
 * The viewer retains the latest per-camera detections for display, but those
 * retained arrays must never double as a work queue. This class owns the
 * separate bounded queue: `takeBatch` atomically consumes every pending camera
 * frame, gives the batch a strictly increasing epoch, and returns `null` until
 * another source frame is explicitly enqueued.
 */
export class BrowserFusionBatcher {
  private generation = 1
  private epoch = 0
  private sourceFrameSequence = 0
  private readonly pending = new Map<string, PendingCameraFrame>()

  enqueue(
    cameraId: string,
    detections: Detection[],
    receivedAtMs: number
  ): BrowserFusionEnqueueStatus {
    if (!cameraId || !Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) {
      return 'rejected_invalid'
    }
    const evictsPendingFrame = this.pending.has(cameraId)
    if (!evictsPendingFrame && this.pending.size >= MAX_BROWSER_FUSION_PENDING_CAMERAS) {
      return 'rejected_capacity'
    }

    this.sourceFrameSequence += 1
    this.pending.set(cameraId, {
      detections,
      receivedAtMs,
      sourceFrameId: `${this.generation}:${this.sourceFrameSequence}`,
    })
    return evictsPendingFrame ? 'evicted_pending_camera_frame' : 'accepted'
  }

  takeBatch(): BrowserFusionBatch | null {
    if (this.pending.size === 0) return null

    this.epoch += 1
    const detections = new Map<string, Detection[]>()
    const sourceFrameIds = new Map<string, string>()
    let timestampMs = 0

    for (const [cameraId, frame] of this.pending) {
      detections.set(cameraId, frame.detections)
      sourceFrameIds.set(cameraId, frame.sourceFrameId)
      let measuredAtMs: number | null = null
      for (const detection of frame.detections) {
        if (Number.isSafeInteger(detection.timestamp) && detection.timestamp >= 0) {
          measuredAtMs = Math.max(measuredAtMs ?? 0, detection.timestamp)
        }
      }
      const frameTimestampMs = measuredAtMs ?? frame.receivedAtMs
      timestampMs = Math.max(timestampMs, frameTimestampMs)
    }
    this.pending.clear()

    return {
      context: {
        frameId: `visual:${this.generation}:${this.epoch}`,
        epoch: this.epoch,
        timestampMs,
      },
      detections,
      sourceFrameIds,
    }
  }

  removeCamera(cameraId: string): void {
    this.pending.delete(cameraId)
  }

  reset(): void {
    this.pending.clear()
    this.generation += 1
    this.sourceFrameSequence = 0
  }
}
