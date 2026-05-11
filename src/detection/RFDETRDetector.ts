/**
 * CREBAIN RF-DETR Detector
 * Adaptive Response & Awareness System (ARAS)
 *
 * RF-DETR (Real-Time Detection Transformer) implementation using ONNX Runtime Web
 * DETR-based architecture with end-to-end detection (no NMS required)
 */

import * as ort from 'onnxruntime-web'
import {
  ObjectDetector,
  Detection,
  DetectionClass,
  DetectorConfig,
  generateDetectionId,
  getThreatLevel,
} from './types'
import { validateRank3Tensor } from './tensorValidation'

// RF-DETR class mapping - customize based on trained model
const RFDETR_CLASSES: DetectionClass[] = [
  'drone',
  'bird',
  'aircraft',
  'helicopter',
  'unknown',
]

// Default COCO classes that might map to our detection classes
const COCO_TO_DETECTION: Record<number, DetectionClass> = {
  0: 'unknown',    // person -> might be operator
  14: 'bird',      // bird
  4: 'aircraft',   // aeroplane
  // Add more mappings as needed for custom drone model
}

/**
 * RF-DETR Detector using ONNX Runtime Web
 * Uses transformer-based detection with direct set prediction (no NMS needed)
 */
export class RFDETRDetector implements ObjectDetector {
  name = 'RF-DETR'
  modelPath: string
  inputSize = { width: 640, height: 640 }
  classes = RFDETR_CLASSES

  private session: ort.InferenceSession | null = null
  private config: DetectorConfig
  private ready = false
  private latencyHistory: number[] = []
  private readonly maxLatencyHistory = 30

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = {
      modelPath: config.modelPath || '/models/rf-detr.onnx',
      confidenceThreshold: config.confidenceThreshold ?? 0.35,
      iouThreshold: config.iouThreshold ?? 0.5, // Not used - DETR outputs are post-NMS
      maxDetections: config.maxDetections ?? 100,
      useWebGPU: config.useWebGPU ?? true,
    }
    this.modelPath = this.config.modelPath
  }

  /**
   * Initialize the ONNX session with WebGPU/WebGL/WASM fallback
   */
  async initialize(): Promise<void> {
    if (this.session) {
      return
    }

    // Configure execution providers with fallback chain
    const executionProviders: ort.InferenceSession.ExecutionProviderConfig[] = []

    if (this.config.useWebGPU) {
      // WebGPU for Metal acceleration on Mac
      executionProviders.push('webgpu')
    }

    // WebGL fallback
    executionProviders.push('webgl')

    // WASM fallback with SIMD
    executionProviders.push({
      name: 'wasm',
    })

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
    }

    try {
      this.session = await ort.InferenceSession.create(
        this.config.modelPath,
        sessionOptions
      )
      this.ready = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[RFDETRDetector] Failed to load model: ${message}`)
    }
  }

  /**
   * Run detection on image data
   */
  async detect(imageData: ImageData): Promise<Detection[]> {
    if (!this.session || !this.ready) {
      throw new Error('[RFDETRDetector] Not initialized')
    }

    const startTime = performance.now()

    try {
      // Preprocess image
      const inputTensor = this.preprocessImage(imageData)

      // Get input name from model (RF-DETR may use different naming)
      const inputName = this.session.inputNames[0] || 'image'

      // Run inference
      const results = await this.session.run({
        [inputName]: inputTensor,
      })

      // Get output tensor
      const output = results[this.session.outputNames[0]]
      if (!output) {
        throw new Error('No output from model')
      }
      const outputData = validateRank3Tensor(output.data, output.dims as number[], '[RFDETRDetector]')

      // Postprocess to get detections
      const detections = this.postprocess(
        outputData,
        output.dims as number[],
        imageData.width,
        imageData.height
      )

      // Record latency
      const latency = performance.now() - startTime
      this.latencyHistory.push(latency)
      if (this.latencyHistory.length > this.maxLatencyHistory) {
        this.latencyHistory.shift()
      }

      return detections
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[RFDETRDetector] Inference error: ${message}`)
    }
  }

  /**
   * Preprocess image to tensor format expected by RF-DETR
   * Input: NCHW format with normalized RGB values
   */
  private preprocessImage(imageData: ImageData): ort.Tensor {
    const { width, height, data } = imageData
    const targetWidth = this.inputSize.width
    const targetHeight = this.inputSize.height

    // Create canvas for resizing
    const canvas = new OffscreenCanvas(targetWidth, targetHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('[RFDETRDetector] Failed to get 2D context for preprocessing canvas')
    }

    // Create temporary canvas with original image
    const tempCanvas = new OffscreenCanvas(width, height)
    const tempCtx = tempCanvas.getContext('2d')
    if (!tempCtx) {
      throw new Error('[RFDETRDetector] Failed to get 2D context for temporary canvas')
    }
    const tempImageData = tempCtx.createImageData(width, height)
    tempImageData.data.set(data)
    tempCtx.putImageData(tempImageData, 0, 0)

    // Resize to target size with letterboxing (preserve aspect ratio)
    const scale = Math.min(targetWidth / width, targetHeight / height)
    const scaledWidth = Math.round(width * scale)
    const scaledHeight = Math.round(height * scale)
    const offsetX = Math.round((targetWidth - scaledWidth) / 2)
    const offsetY = Math.round((targetHeight - scaledHeight) / 2)

    // Fill with gray (letterbox padding)
    ctx.fillStyle = '#808080'
    ctx.fillRect(0, 0, targetWidth, targetHeight)

    // Draw resized image
    ctx.drawImage(tempCanvas, offsetX, offsetY, scaledWidth, scaledHeight)

    // Get resized image data
    const resizedData = ctx.getImageData(0, 0, targetWidth, targetHeight).data

    // Convert to NCHW format with normalization (0-1)
    // RF-DETR typically uses ImageNet normalization
    const channels = 3
    const tensorData = new Float32Array(1 * channels * targetHeight * targetWidth)

    // ImageNet mean and std for normalization
    const mean = [0.485, 0.456, 0.406]
    const std = [0.229, 0.224, 0.225]

    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const pixelIndex = (y * targetWidth + x) * 4
        const tensorIndex = y * targetWidth + x

        // RGB channels (normalized with ImageNet stats)
        tensorData[0 * targetHeight * targetWidth + tensorIndex] = 
          (resizedData[pixelIndex] / 255 - mean[0]) / std[0]     // R
        tensorData[1 * targetHeight * targetWidth + tensorIndex] = 
          (resizedData[pixelIndex + 1] / 255 - mean[1]) / std[1] // G
        tensorData[2 * targetHeight * targetWidth + tensorIndex] = 
          (resizedData[pixelIndex + 2] / 255 - mean[2]) / std[2] // B
      }
    }

    return new ort.Tensor('float32', tensorData, [1, channels, targetHeight, targetWidth])
  }

  /**
   * Postprocess RF-DETR output to Detection array
   * RF-DETR output shape: [1, N, 6] where 6 = [class_id, score, x1, y1, x2, y2]
   * or [1, N, 5+num_classes] depending on model export
   */
  private postprocess(
    output: Float32Array,
    dims: number[],
    origWidth: number,
    origHeight: number
  ): Detection[] {
    if (dims[0] !== 1 || dims[1] <= 0 || dims[2] < 5) {
      throw new Error(`[RFDETRDetector] Invalid RF-DETR output shape: [${dims.join(', ')}]`)
    }

    const detections: Detection[] = []

    // Calculate scale factors for coordinate conversion
    const scale = Math.min(this.inputSize.width / origWidth, this.inputSize.height / origHeight)
    const offsetX = (this.inputSize.width - origWidth * scale) / 2
    const offsetY = (this.inputSize.height - origHeight * scale) / 2

    // Determine output format based on dimensions
    // Format A: [1, N, 6] - class_id, score, x1, y1, x2, y2
    // Format B: [1, N, 4+num_classes] - x1, y1, x2, y2, class_scores...
    const numPredictions = dims[1]
    const predSize = dims[2]

    // Detect if it's format A (class_id, score, box) or format B (box, class_scores)
    const isFormatA = predSize === 6

    for (let i = 0; i < numPredictions; i++) {
      const baseIdx = i * predSize

      let classId: number
      let score: number
      let x1: number, y1: number, x2: number, y2: number

      if (isFormatA) {
        // Format A: [class_id, score, x1, y1, x2, y2]
        classId = Math.round(output[baseIdx])
        score = output[baseIdx + 1]
        x1 = output[baseIdx + 2]
        y1 = output[baseIdx + 3]
        x2 = output[baseIdx + 4]
        y2 = output[baseIdx + 5]
      } else {
        // Format B: [x1, y1, x2, y2, class_scores...]
        x1 = output[baseIdx]
        y1 = output[baseIdx + 1]
        x2 = output[baseIdx + 2]
        y2 = output[baseIdx + 3]

        // Find max class score
        const numClasses = predSize - 4
        let maxScore = 0
        let maxClassIdx = 0

        for (let c = 0; c < numClasses; c++) {
          const classScore = output[baseIdx + 4 + c]
          if (classScore > maxScore) {
            maxScore = classScore
            maxClassIdx = c
          }
        }

        classId = maxClassIdx
        score = maxScore
      }

      // Filter by confidence threshold
      if (score < this.config.confidenceThreshold) {
        continue
      }

      // Convert from model input coordinates to original image coordinates
      // RF-DETR may output normalized [0,1] or absolute pixel coordinates
      const isNormalized = x1 <= 1 && y1 <= 1 && x2 <= 1 && y2 <= 1

      if (isNormalized) {
        // Convert from normalized to pixel coordinates
        x1 = x1 * this.inputSize.width
        y1 = y1 * this.inputSize.height
        x2 = x2 * this.inputSize.width
        y2 = y2 * this.inputSize.height
      }

      // Remove letterbox padding and scale to original image
      x1 = (x1 - offsetX) / scale
      y1 = (y1 - offsetY) / scale
      x2 = (x2 - offsetX) / scale
      y2 = (y2 - offsetY) / scale

      // Clamp to image bounds
      x1 = Math.max(0, Math.min(origWidth, x1))
      y1 = Math.max(0, Math.min(origHeight, y1))
      x2 = Math.max(0, Math.min(origWidth, x2))
      y2 = Math.max(0, Math.min(origHeight, y2))

      // Skip invalid boxes
      if (x2 <= x1 || y2 <= y1) {
        continue
      }

      // Map COCO class to detection class
      const detClass = COCO_TO_DETECTION[classId] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: score,
        bbox: [x1, y1, x2, y2],
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, score),
      })
    }

    // RF-DETR outputs are already post-NMS, but limit to maxDetections
    // Sort by confidence and take top results
    detections.sort((a, b) => b.confidence - a.confidence)
    return detections.slice(0, this.config.maxDetections)
  }

  /**
   * Get average inference latency
   */
  getAverageLatency(): number {
    if (this.latencyHistory.length === 0) return 0
    return this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length
  }

  /**
   * Check if detector is ready
   */
  isReady(): boolean {
    return this.ready
  }

  /**
   * Dispose of the session and free resources
   */
  dispose(): void {
    if (this.session) {
      this.session = null
      this.ready = false
      this.latencyHistory = []
    }
  }
}

/**
 * Create an RFDETRDetector instance with default configuration
 */
export function createRFDETRDetector(config?: Partial<DetectorConfig>): RFDETRDetector {
  return new RFDETRDetector(config)
}
