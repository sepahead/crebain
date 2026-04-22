/**
 * CREBAIN YOLOv8 Detector
 * Adaptive Response & Awareness System (ARAS)
 *
 * YOLOv8 Nano implementation using ONNX Runtime Web with WebGPU acceleration
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

// Default COCO classes that might map to our detection classes
const COCO_TO_DETECTION: Record<number, DetectionClass> = {
  0: 'unknown',    // person -> might be operator
  14: 'bird',      // bird
  4: 'aircraft',   // aeroplane
  // Add more mappings as needed for custom drone model
}

/**
 * YOLOv8 Detector using ONNX Runtime Web
 */
export class YOLODetector implements ObjectDetector {
  name = 'YOLOv8-Nano'
  modelPath: string
  inputSize = { width: 640, height: 640 }
  classes: DetectionClass[] = ['drone', 'bird', 'aircraft', 'helicopter', 'unknown']

  private session: ort.InferenceSession | null = null
  private config: DetectorConfig
  private ready = false
  private latencyHistory: number[] = []
  private readonly maxLatencyHistory = 30

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = {
      modelPath: config.modelPath || '/models/yolov8n.onnx',
      confidenceThreshold: config.confidenceThreshold ?? 0.25,
      iouThreshold: config.iouThreshold ?? 0.45,
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
      // WASM-specific options
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
      throw new Error(`[YOLODetector] Failed to load model: ${message}`)
    }
  }

  /**
   * Run detection on image data
   */
  async detect(imageData: ImageData): Promise<Detection[]> {
    if (!this.session || !this.ready) {
      throw new Error('[YOLODetector] Not initialized')
    }

    const startTime = performance.now()

    try {
      // Preprocess image
      const inputTensor = this.preprocessImage(imageData)

      // Run inference
      const results = await this.session.run({
        images: inputTensor, // YOLOv8 uses 'images' as input name
      })

      // Get output tensor
      const output = results[this.session.outputNames[0]]
      if (!output) {
        throw new Error('No output from model')
      }

      // Postprocess to get detections
      const detections = this.postprocess(
        output.data as Float32Array,
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
      throw new Error(`[YOLODetector] Inference error: ${message}`)
    }
  }

  /**
   * Preprocess image to tensor format expected by YOLO
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
      throw new Error('[YOLODetector] Failed to get 2D context for preprocessing canvas')
    }

    // Create temporary canvas with original image
    const tempCanvas = new OffscreenCanvas(width, height)
    const tempCtx = tempCanvas.getContext('2d')
    if (!tempCtx) {
      throw new Error('[YOLODetector] Failed to get 2D context for temporary canvas')
    }
    const tempImageData = tempCtx.createImageData(width, height)
    tempImageData.data.set(data)
    tempCtx.putImageData(tempImageData, 0, 0)

    // Resize to target size with letterboxing
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
    const channels = 3
    const tensorData = new Float32Array(1 * channels * targetHeight * targetWidth)

    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const pixelIndex = (y * targetWidth + x) * 4
        const tensorIndex = y * targetWidth + x

        // RGB channels (normalized to 0-1)
        tensorData[0 * targetHeight * targetWidth + tensorIndex] = resizedData[pixelIndex] / 255     // R
        tensorData[1 * targetHeight * targetWidth + tensorIndex] = resizedData[pixelIndex + 1] / 255 // G
        tensorData[2 * targetHeight * targetWidth + tensorIndex] = resizedData[pixelIndex + 2] / 255 // B
      }
    }

    return new ort.Tensor('float32', tensorData, [1, channels, targetHeight, targetWidth])
  }

  /**
   * Postprocess YOLO output to Detection array
   * YOLOv8 output shape: [1, 84, 8400] (84 = 4 bbox + 80 classes)
   */
  private postprocess(
    output: Float32Array,
    dims: number[],
    origWidth: number,
    origHeight: number
  ): Detection[] {
    const numClasses = dims[1] - 4 // 84 - 4 = 80 classes for COCO
    const numPredictions = dims[2]  // 8400 predictions

    const detections: Detection[] = []

    // Calculate scale factors for coordinate conversion
    const scale = Math.min(this.inputSize.width / origWidth, this.inputSize.height / origHeight)
    const offsetX = (this.inputSize.width - origWidth * scale) / 2
    const offsetY = (this.inputSize.height - origHeight * scale) / 2

    // Process each prediction
    for (let i = 0; i < numPredictions; i++) {
      // Get class scores and find max
      let maxScore = 0
      let maxClassIdx = 0

      for (let c = 0; c < numClasses; c++) {
        const score = output[(4 + c) * numPredictions + i]
        if (score > maxScore) {
          maxScore = score
          maxClassIdx = c
        }
      }

      // Filter by confidence threshold
      if (maxScore < this.config.confidenceThreshold) {
        continue
      }

      // Get bounding box (center format: cx, cy, w, h)
      const cx = output[0 * numPredictions + i]
      const cy = output[1 * numPredictions + i]
      const w = output[2 * numPredictions + i]
      const h = output[3 * numPredictions + i]

      // Convert to corner format (x1, y1, x2, y2)
      let x1 = cx - w / 2
      let y1 = cy - h / 2
      let x2 = cx + w / 2
      let y2 = cy + h / 2

      // Convert from model input coordinates to original image coordinates
      x1 = (x1 - offsetX) / scale
      y1 = (y1 - offsetY) / scale
      x2 = (x2 - offsetX) / scale
      y2 = (y2 - offsetY) / scale

      // Clamp to image bounds
      x1 = Math.max(0, Math.min(origWidth, x1))
      y1 = Math.max(0, Math.min(origHeight, y1))
      x2 = Math.max(0, Math.min(origWidth, x2))
      y2 = Math.max(0, Math.min(origHeight, y2))

      // Map COCO class to detection class
      const detClass = COCO_TO_DETECTION[maxClassIdx] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: maxScore,
        bbox: [x1, y1, x2, y2],
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, maxScore),
      })
    }

    // Apply NMS
    const nmsDetections = this.nonMaxSuppression(detections)

    // Limit detections
    return nmsDetections.slice(0, this.config.maxDetections)
  }

  /**
   * Non-Maximum Suppression
   */
  private nonMaxSuppression(detections: Detection[]): Detection[] {
    if (detections.length === 0) return []

    // Sort by confidence (descending)
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence)

    const kept: Detection[] = []

    while (sorted.length > 0) {
      const best = sorted.shift()!
      kept.push(best)

      // Remove overlapping detections
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (this.iou(best.bbox, sorted[i].bbox) > this.config.iouThreshold) {
          sorted.splice(i, 1)
        }
      }
    }

    return kept
  }

  /**
   * Calculate Intersection over Union
   */
  private iou(boxA: [number, number, number, number], boxB: [number, number, number, number]): number {
    const [ax1, ay1, ax2, ay2] = boxA
    const [bx1, by1, bx2, by2] = boxB

    // Intersection
    const ix1 = Math.max(ax1, bx1)
    const iy1 = Math.max(ay1, by1)
    const ix2 = Math.min(ax2, bx2)
    const iy2 = Math.min(ay2, by2)

    const iw = Math.max(0, ix2 - ix1)
    const ih = Math.max(0, iy2 - iy1)
    const intersection = iw * ih

    // Union
    const areaA = (ax2 - ax1) * (ay2 - ay1)
    const areaB = (bx2 - bx1) * (by2 - by1)
    const union = areaA + areaB - intersection

    return union > 0 ? intersection / union : 0
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
      // ONNX Runtime Web sessions are automatically garbage collected
      this.session = null
      this.ready = false
      this.latencyHistory = []
    }
  }
}

/**
 * Create a YOLODetector instance with default configuration
 */
export function createYOLODetector(config?: Partial<DetectorConfig>): YOLODetector {
  return new YOLODetector(config)
}
