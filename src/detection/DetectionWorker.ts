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
let isInitializing = false
let currentDetectorType: DetectorType = 'yolo'

const DETECTOR_TYPES = new Set<DetectorType>(['yolo', 'rf-detr', 'moondream', 'coreml'])
const WORKER_MESSAGE_TYPES = new Set<DetectionWorkerMessage['type']>(['init', 'detect', 'dispose', 'status'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDetectorType(value: unknown): value is DetectorType {
  return typeof value === 'string' && DETECTOR_TYPES.has(value as DetectorType)
}

function isWorkerMessageType(value: unknown): value is DetectionWorkerMessage['type'] {
  return typeof value === 'string' && WORKER_MESSAGE_TYPES.has(value as DetectionWorkerMessage['type'])
}

function isImageData(value: unknown): value is ImageData {
  return typeof ImageData !== 'undefined' && value instanceof ImageData
}

function normalizeWorkerMessage(value: unknown): DetectionWorkerMessage | null {
  if (!isRecord(value)) return null
  if (!isWorkerMessageType(value.type)) return null

  if (!isRecord(value.payload)) {
    return { type: value.type }
  }

  if (value.type === 'init') {
    return {
      type: value.type,
      payload: {
        detectorType: isDetectorType(value.payload.detectorType) ? value.payload.detectorType : undefined,
        config: isRecord(value.payload.config) ? value.payload.config as Partial<DetectorConfig> : undefined,
      },
    }
  }

  if (value.type === 'detect') {
    return {
      type: value.type,
      payload: {
        imageData: isImageData(value.payload.imageData) ? value.payload.imageData : undefined,
        imageWidth: typeof value.payload.imageWidth === 'number' ? value.payload.imageWidth : undefined,
        imageHeight: typeof value.payload.imageHeight === 'number' ? value.payload.imageHeight : undefined,
      },
    }
  }

  return { type: value.type }
}

/**
 * Handle incoming messages from main thread
 */
self.onmessage = async (event: MessageEvent<unknown>) => {
  const message = normalizeWorkerMessage(event.data)
  if (!message) {
    sendResponse({
      type: 'error',
      payload: { error: 'Malformed worker message' },
    })
    return
  }

  const { type, payload } = message

  switch (type) {
    case 'init':
      await handleInit(payload?.detectorType, payload?.config)
      break

    case 'detect':
      await handleDetect(payload?.imageData, payload?.imageWidth, payload?.imageHeight)
      break

    case 'dispose':
      handleDispose()
      break

    case 'status':
      handleStatus()
      break

    default:
      sendResponse({
        type: 'error',
        payload: { error: `Unknown message type: ${type}` },
      })
  }
}

/**
 * Initialize the detector
 */
async function handleInit(
  detectorType?: DetectorType,
  config?: Partial<DetectorConfig>
): Promise<void> {
  if (isInitializing) {
    sendResponse({
      type: 'error',
      payload: { error: 'Already initializing' },
    })
    return
  }

  const requestedType = detectorType || 'yolo'

  // If detector is ready and same type, return early
  if (detector?.isReady() && currentDetectorType === requestedType) {
    sendResponse({
      type: 'ready',
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

  // Dispose existing detector if switching types
  if (detector && currentDetectorType !== requestedType) {
    detector.dispose()
    detector = null
  }

  isInitializing = true

  try {
    detector = createDetector(requestedType, config)
    currentDetectorType = requestedType
    await detector.initialize()

    sendResponse({
      type: 'ready',
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
      payload: { error: `Initialization failed: ${message}` },
    })
  } finally {
    isInitializing = false
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
  imageData?: ImageData,
  _width?: number,
  _height?: number
): Promise<void> {
  if (!detector?.isReady()) {
    sendResponse({
      type: 'error',
      payload: { error: 'Detector not ready' },
    })
    return
  }

  if (!imageData) {
    sendResponse({
      type: 'error',
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
      payload: {
        detections,
        inferenceTime,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendResponse({
      type: 'error',
      payload: { error: `Detection failed: ${message}` },
    })
  }
}

/**
 * Dispose detector and free resources
 */
function handleDispose(): void {
  if (detector) {
    detector.dispose()
    detector = null
  }
  sendResponse({
    type: 'status',
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
function handleStatus(): void {
  sendResponse({
    type: 'status',
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
  const message = error instanceof ErrorEvent ? error.message : String(error)
  sendResponse({
    type: 'error',
    payload: { error: `Worker error: ${message}` },
  })
}
