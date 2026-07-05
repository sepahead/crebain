/**
 * CREBAIN Detection Worker
 * Adaptive Response & Awareness System (ARAS)
 *
 * Web Worker for non-blocking ML inference
 * Runs detection on separate thread to maintain UI responsiveness
 */

import { YOLODetector } from './YOLODetector'
import { RFDETRDetector } from './RFDETRDetector'
import { MoondreamDetector } from './MoondreamDetector'
import { CoreMLDetector } from './CoreMLDetector'
import type {
  DetectorConfig,
  DetectorType,
  DetectionWorkerMessage,
  DetectionWorkerResponse,
  ObjectDetector,
} from './types'

// Worker state
let detector: ObjectDetector | null = null
let currentDetectorType: DetectorType = 'yolo'

// Sequential message queue: ort-web sessions do not support concurrent run()
// calls (a second detect while one is in flight throws "Session already
// started"), and an init arriving mid-detect must not dispose the detector
// under the in-flight inference. Chaining every message through this promise
// serializes init/detect/dispose, so a re-init only runs after the current
// detect has finished (or rejected) and its response has been sent.
let messageQueue: Promise<void> = Promise.resolve()

const DETECTOR_TYPES = new Set<DetectorType>(['yolo', 'rf-detr', 'moondream', 'coreml'])
const WORKER_MESSAGE_TYPES = new Set<DetectionWorkerMessage['type']>([
  'init',
  'detect',
  'dispose',
  'status',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDetectorType(value: unknown): value is DetectorType {
  return typeof value === 'string' && DETECTOR_TYPES.has(value as DetectorType)
}

function isWorkerMessageType(value: unknown): value is DetectionWorkerMessage['type'] {
  return (
    typeof value === 'string' && WORKER_MESSAGE_TYPES.has(value as DetectionWorkerMessage['type'])
  )
}

function isImageData(value: unknown): value is ImageData {
  return typeof ImageData !== 'undefined' && value instanceof ImageData
}

function normalizeWorkerMessage(value: unknown): DetectionWorkerMessage | null {
  if (!isRecord(value)) return null
  if (!isWorkerMessageType(value.type)) return null

  const requestId = typeof value.requestId === 'number' ? value.requestId : undefined

  if (!isRecord(value.payload)) {
    return { type: value.type, requestId }
  }

  if (value.type === 'init') {
    return {
      type: value.type,
      requestId,
      payload: {
        detectorType: isDetectorType(value.payload.detectorType)
          ? value.payload.detectorType
          : undefined,
        config: isRecord(value.payload.config) ? value.payload.config : undefined,
      },
    }
  }

  if (value.type === 'detect') {
    return {
      type: value.type,
      requestId,
      payload: {
        imageData: isImageData(value.payload.imageData) ? value.payload.imageData : undefined,
        imageWidth:
          typeof value.payload.imageWidth === 'number' ? value.payload.imageWidth : undefined,
        imageHeight:
          typeof value.payload.imageHeight === 'number' ? value.payload.imageHeight : undefined,
      },
    }
  }

  return { type: value.type, requestId }
}

/**
 * Handle incoming messages from main thread
 */
self.onmessage = (event: MessageEvent<unknown>) => {
  const message = normalizeWorkerMessage(event.data)
  if (!message) {
    const raw = isRecord(event.data) ? event.data : undefined
    sendResponse({
      type: 'error',
      requestId: typeof raw?.requestId === 'number' ? raw.requestId : undefined,
      payload: { error: 'Malformed worker message' },
    })
    return
  }

  messageQueue = messageQueue
    .then(() => dispatchMessage(message))
    .catch((error) => {
      sendResponse({
        type: 'error',
        requestId: message.requestId,
        payload: { error: error instanceof Error ? error.message : String(error) },
      })
    })
}

async function dispatchMessage(message: DetectionWorkerMessage): Promise<void> {
  const { type, payload, requestId } = message

  switch (type) {
    case 'init':
      await handleInit(requestId, payload?.detectorType, payload?.config)
      break

    case 'detect':
      await handleDetect(requestId, payload?.imageData, payload?.imageWidth, payload?.imageHeight)
      break

    case 'dispose':
      await handleDispose(requestId)
      break

    case 'status':
      handleStatus(requestId)
      break

    default:
      sendResponse({
        type: 'error',
        requestId,
        payload: { error: `Unknown message type: ${String(type)}` },
      })
  }
}

/**
 * Initialize the detector
 */
async function handleInit(
  requestId: number | undefined,
  detectorType?: DetectorType,
  config?: Partial<DetectorConfig>
): Promise<void> {
  const requestedType = detectorType || 'yolo'

  // If detector is ready and same type, return early
  if (detector?.isReady() && currentDetectorType === requestedType) {
    sendResponse({
      type: 'ready',
      requestId,
      payload: {
        status: {
          isReady: true,
          modelLoaded: true,
          averageLatency: detector.getAverageLatency(),
        },
      },
    })
    return
  }

  // Dispose existing detector if switching types. The message queue guarantees
  // no detect is in flight here.
  if (detector && currentDetectorType !== requestedType) {
    await detector.dispose()
    detector = null
  }

  try {
    detector = createDetector(requestedType, config)
    currentDetectorType = requestedType
    await detector.initialize()

    sendResponse({
      type: 'ready',
      requestId,
      payload: {
        status: {
          isReady: true,
          modelLoaded: true,
          averageLatency: 0,
        },
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendResponse({
      type: 'error',
      requestId,
      payload: { error: `Initialization failed: ${message}` },
    })
  }
}

/**
 * Create detector instance based on type
 */
function createDetector(
  detectorType: DetectorType,
  config?: Partial<DetectorConfig>
): ObjectDetector {
  switch (detectorType) {
    case 'rf-detr':
      return new RFDETRDetector(config)
    case 'moondream':
      return new MoondreamDetector(config)
    case 'coreml':
      return new CoreMLDetector(config)
    case 'yolo':
    default:
      return new YOLODetector(config)
  }
}

/**
 * Run detection on image data
 */
async function handleDetect(
  requestId: number | undefined,
  imageData?: ImageData,
  _width?: number,
  _height?: number
): Promise<void> {
  if (!detector?.isReady()) {
    sendResponse({
      type: 'error',
      requestId,
      payload: { error: 'Detector not ready' },
    })
    return
  }

  if (!imageData) {
    sendResponse({
      type: 'error',
      requestId,
      payload: { error: 'No image data provided' },
    })
    return
  }

  const startTime = performance.now()

  try {
    const detections = await detector.detect(imageData)
    const inferenceTime = performance.now() - startTime

    sendResponse({
      type: 'detections',
      requestId,
      payload: {
        detections,
        inferenceTime,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendResponse({
      type: 'error',
      requestId,
      payload: { error: `Detection failed: ${message}` },
    })
  }
}

/**
 * Dispose detector and free resources
 */
async function handleDispose(requestId?: number): Promise<void> {
  if (detector) {
    await detector.dispose()
    detector = null
  }
  sendResponse({
    type: 'status',
    requestId,
    payload: {
      status: {
        isReady: false,
        modelLoaded: false,
        averageLatency: 0,
      },
    },
  })
}

/**
 * Get current status
 */
function handleStatus(requestId?: number): void {
  sendResponse({
    type: 'status',
    requestId,
    payload: {
      status: {
        isReady: detector?.isReady() ?? false,
        modelLoaded: detector !== null,
        averageLatency: detector?.getAverageLatency() ?? 0,
      },
    },
  })
}

/**
 * Send response to main thread
 */
function sendResponse(response: DetectionWorkerResponse): void {
  self.postMessage(response)
}

// Handle errors
self.onerror = (error) => {
  const message =
    error instanceof ErrorEvent
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown worker error'
  sendResponse({
    type: 'error',
    payload: { error: `Worker error: ${message}` },
  })
}
