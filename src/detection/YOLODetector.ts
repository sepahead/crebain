/**
 * CREBAIN YOLOv8 Detector
 * Adaptive Response & Awareness System (ARAS)
 *
 * YOLOv8 Nano implementation using ONNX Runtime Web with WebGPU acceleration
 */

import * as ort from 'onnxruntime-web'
import {
  type ObjectDetector,
  type Detection,
  type DetectionClass,
  type DetectorConfig,
  generateDetectionId,
  getThreatLevel,
} from './types'
import {
  averageLatency,
  clampBoxToImage,
  computeLetterboxGeometry,
  findMaxYoloClassScore,
  isValidBox,
  nonMaxSuppression,
  projectLetterboxBoxToImage,
  readYoloCenterBox,
  recordLatency,
  type LetterboxGeometry,
} from './detectorMath'
import { normalizeUnitRgb, RGB_CHANNELS, rgbaToNchwRgbFloat32 } from './detectorPreprocess'
import { validateRank3Tensor } from './tensorValidation'

// Default COCO classes that might map to our detection classes
const COCO_TO_DETECTION: Record<number, DetectionClass> = {
  0: 'unknown', // person -> might be operator
  14: 'bird', // bird
  4: 'aircraft', // aeroplane
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
   * Initialize the ONNX session with WebGPU/WASM fallback
   */
  async initialize(): Promise<void> {
    if (this.session) {
      return
    }

    // Configure execution providers with fallback chain.
    // Note: the 'webgl' execution provider no longer exists in onnxruntime-web
    // 1.24 (cpu/wasm/webgpu/webnn only), so WASM is the sole CPU fallback.
    const executionProviders: ort.InferenceSession.ExecutionProviderConfig[] = []

    if (this.config.useWebGPU) {
      // WebGPU for Metal acceleration on Mac
      executionProviders.push('webgpu')
    }

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
      this.session = await ort.InferenceSession.create(this.config.modelPath, sessionOptions)
      this.ready = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[YOLODetector] Failed to load model: ${message}`, { cause: error })
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
      // Compute the letterbox geometry once per frame (pixel-aligned, matching
      // the preprocessing draw) and reuse it in postprocessing so boxes are
      // projected back with the exact geometry the image was drawn with.
      const geometry = computeLetterboxGeometry(
        { width: imageData.width, height: imageData.height },
        this.inputSize,
        true
      )

      // Preprocess image
      const inputTensor = this.preprocessImage(imageData, geometry)

      // Run inference
      const results = await this.session.run({
        images: inputTensor, // YOLOv8 uses 'images' as input name
      })

      // Get output tensor
      const output = results[this.session.outputNames[0]]
      if (!output) {
        throw new Error('No output from model')
      }
      const outputData = validateRank3Tensor(output.data, output.dims, '[YOLODetector]')

      // Postprocess to get detections
      const detections = this.postprocess(
        outputData,
        output.dims,
        imageData.width,
        imageData.height,
        geometry
      )

      // Record latency
      recordLatency(this.latencyHistory, this.maxLatencyHistory, startTime)

      return detections
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[YOLODetector] Inference error: ${message}`, { cause: error })
    }
  }

  /**
   * Preprocess image to tensor format expected by YOLO
   * Input: NCHW format with normalized RGB values
   */
  private preprocessImage(imageData: ImageData, geometry: LetterboxGeometry): ort.Tensor {
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

    // Fill with gray (letterbox padding)
    ctx.fillStyle = '#808080'
    ctx.fillRect(0, 0, targetWidth, targetHeight)

    // Draw resized image
    ctx.drawImage(
      tempCanvas,
      geometry.offsetX,
      geometry.offsetY,
      geometry.scaledWidth,
      geometry.scaledHeight
    )

    // Get resized image data
    const resizedData = ctx.getImageData(0, 0, targetWidth, targetHeight).data

    // Convert to NCHW format with normalization (0-1)
    const tensorData = rgbaToNchwRgbFloat32(
      resizedData,
      targetWidth,
      targetHeight,
      normalizeUnitRgb
    )

    return new ort.Tensor('float32', tensorData, [1, RGB_CHANNELS, targetHeight, targetWidth])
  }

  /**
   * Postprocess YOLO output to Detection array
   * YOLOv8 output shape: [1, 84, 8400] (84 = 4 bbox + 80 classes)
   */
  private postprocess(
    output: Float32Array,
    dims: readonly number[],
    origWidth: number,
    origHeight: number,
    geometry: LetterboxGeometry
  ): Detection[] {
    if (dims[0] !== 1 || dims[1] <= 4 || dims[2] <= 0) {
      throw new Error(`[YOLODetector] Invalid YOLO output shape: [${dims.join(', ')}]`)
    }

    const numClasses = dims[1] - 4 // 84 - 4 = 80 classes for COCO
    const numPredictions = dims[2] // 8400 predictions

    const detections: Detection[] = []

    // Process each prediction
    for (let i = 0; i < numPredictions; i++) {
      // Get class scores and find max
      const { classIndex: maxClassIdx, score: maxScore } = findMaxYoloClassScore(
        output,
        numPredictions,
        i,
        numClasses
      )

      // Filter by confidence threshold
      if (maxScore < this.config.confidenceThreshold) {
        continue
      }

      // Get bounding box (center format: cx, cy, w, h)
      // Convert to corner format (x1, y1, x2, y2)
      let box = readYoloCenterBox(output, numPredictions, i)

      // Convert from model input coordinates to original image coordinates
      box = projectLetterboxBoxToImage(box, geometry)

      // Clamp to image bounds
      box = clampBoxToImage(box, { width: origWidth, height: origHeight })

      // Skip invalid (zero-area / degenerate) boxes
      if (!isValidBox(box)) {
        continue
      }

      // Map COCO class to detection class
      const detClass = COCO_TO_DETECTION[maxClassIdx] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: maxScore,
        bbox: box,
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, maxScore),
      })
    }

    // Apply NMS
    const nmsDetections = nonMaxSuppression(detections, this.config.iouThreshold)

    // Limit detections
    return nmsDetections.slice(0, this.config.maxDetections)
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
  async dispose(): Promise<void> {
    const session = this.session
    this.session = null
    this.ready = false
    this.latencyHistory = []
    if (session) {
      // ONNX Runtime Web sessions hold WASM/GPU memory that is NOT garbage
      // collected — it must be released explicitly.
      try {
        await session.release()
      } catch {
        // Best effort: releasing an already-released session must not throw.
      }
    }
  }
}

/**
 * Create a YOLODetector instance with default configuration
 */
export function createYOLODetector(config?: Partial<DetectorConfig>): YOLODetector {
  return new YOLODetector(config)
}
