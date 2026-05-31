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
import {
  averageLatency,
  clampBoxToImage,
  computeLetterboxGeometry,
  findMaxScore,
  isLikelyNormalizedBox,
  isValidBox,
  projectLetterboxBoxToImage,
  recordLatency,
  scaleNormalizedBox,
  type BoundingBox,
} from './detectorMath'
import { normalizeImageNetRgb, RGB_CHANNELS, rgbaToNchwRgbFloat32 } from './detectorPreprocess'
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
      const outputData = validateRank3Tensor(output.data, output.dims, '[RFDETRDetector]')

      // Postprocess to get detections
      const detections = this.postprocess(
        outputData,
        output.dims,
        imageData.width,
        imageData.height
      )

      // Record latency
      recordLatency(this.latencyHistory, this.maxLatencyHistory, startTime)

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
    const geometry = computeLetterboxGeometry(
      { width, height },
      { width: targetWidth, height: targetHeight },
      true
    )

    // Fill with gray (letterbox padding)
    ctx.fillStyle = '#808080'
    ctx.fillRect(0, 0, targetWidth, targetHeight)

    // Draw resized image
    ctx.drawImage(tempCanvas, geometry.offsetX, geometry.offsetY, geometry.scaledWidth, geometry.scaledHeight)

    // Get resized image data
    const resizedData = ctx.getImageData(0, 0, targetWidth, targetHeight).data

    // Convert to NCHW format with normalization (0-1)
    // RF-DETR typically uses ImageNet normalization
    const tensorData = rgbaToNchwRgbFloat32(resizedData, targetWidth, targetHeight, normalizeImageNetRgb)

    return new ort.Tensor('float32', tensorData, [1, RGB_CHANNELS, targetHeight, targetWidth])
  }

  /**
   * Postprocess RF-DETR output to Detection array
   * RF-DETR output shape: [1, N, 6] where 6 = [class_id, score, x1, y1, x2, y2]
   * or [1, N, 5+num_classes] depending on model export
   */
  private postprocess(
    output: Float32Array,
    dims: readonly number[],
    origWidth: number,
    origHeight: number
  ): Detection[] {
    if (dims[0] !== 1 || dims[1] <= 0 || dims[2] < 5) {
      throw new Error(`[RFDETRDetector] Invalid RF-DETR output shape: [${dims.join(', ')}]`)
    }

    const detections: Detection[] = []

    // Calculate scale factors for coordinate conversion
    const geometry = computeLetterboxGeometry(
      { width: origWidth, height: origHeight },
      this.inputSize
    )

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
      let box: BoundingBox

      if (isFormatA) {
        // Format A: [class_id, score, x1, y1, x2, y2]
        classId = Math.round(output[baseIdx])
        score = output[baseIdx + 1]
        box = [output[baseIdx + 2], output[baseIdx + 3], output[baseIdx + 4], output[baseIdx + 5]]
      } else {
        // Format B: [x1, y1, x2, y2, class_scores...]
        box = [output[baseIdx], output[baseIdx + 1], output[baseIdx + 2], output[baseIdx + 3]]

        // Find max class score
        const numClasses = predSize - 4
        const { classIndex: maxClassIdx, score: maxScore } = findMaxScore(output, baseIdx + 4, numClasses)

        classId = maxClassIdx
        score = maxScore
      }

      // Filter by confidence threshold
      if (score < this.config.confidenceThreshold) {
        continue
      }

      // Convert from model input coordinates to original image coordinates
      // RF-DETR may output normalized [0,1] or absolute pixel coordinates
      const isNormalized = isLikelyNormalizedBox(box)

      if (isNormalized) {
        // Convert from normalized to pixel coordinates
        box = scaleNormalizedBox(box, this.inputSize)
      }

      // Remove letterbox padding and scale to original image
      box = projectLetterboxBoxToImage(box, geometry)

      // Clamp to image bounds
      box = clampBoxToImage(box, { width: origWidth, height: origHeight })

      // Skip invalid boxes
      if (!isValidBox(box)) {
        continue
      }

      // Map COCO class to detection class
      const detClass = COCO_TO_DETECTION[classId] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: score,
        bbox: box,
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
    return averageLatency(this.latencyHistory)
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
