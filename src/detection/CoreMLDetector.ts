/**
 * CREBAIN CoreML Detector
 * Adaptive Response & Awareness System (ARAS)
 *
 * CoreML model implementation converted to ONNX format
 * Supports Apple Vision-style preprocessing and both classification/detection outputs
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
  assertDims,
  assertFiniteTensorValues,
  assertFloat32Tensor,
  assertTensorLength,
  validateRank2Tensor,
  validateRank3Tensor,
} from './tensorValidation'

// CoreML detector class mapping
const COREML_CLASSES: DetectionClass[] = [
  'drone',
  'bird',
  'aircraft',
  'helicopter',
  'unknown',
]

// Default class index mapping (customize for your CoreML model)
const CLASS_INDEX_TO_DETECTION: Record<number, DetectionClass> = {
  0: 'drone',
  1: 'bird',
  2: 'aircraft',
  3: 'helicopter',
  4: 'unknown',
}

/**
 * Preprocessing mode for CoreML models
 * Different CoreML models may use different normalization schemes
 */
export type CoreMLPreprocessMode = 
  | 'vision'      // Apple Vision framework default: [0,1] range
  | 'vision_bias' // Vision with bias: [-1,1] range
  | 'imagenet'    // Standard ImageNet normalization
  | 'raw'         // No normalization, just [0,255]

/**
 * CoreML model output format
 */
export type CoreMLOutputFormat =
  | 'detection'       // Bounding boxes with class scores
  | 'classification'  // Class probabilities only (will create center detection)
  | 'yolo'           // YOLO-style output from converted model

/**
 * Extended config for CoreML detector
 */
export interface CoreMLDetectorConfig extends DetectorConfig {
  preprocessMode: CoreMLPreprocessMode
  outputFormat: CoreMLOutputFormat
  classMapping?: Record<number, DetectionClass>
  inputName?: string  // Model-specific input tensor name
  outputName?: string // Model-specific output tensor name
}

/**
 * CoreML Detector using ONNX Runtime Web
 * For models converted from CoreML (.mlmodel) to ONNX format
 */
export class CoreMLDetector implements ObjectDetector {
  name = 'CoreML-ONNX'
  modelPath: string
  inputSize = { width: 416, height: 416 } // Common CoreML detection size
  classes = COREML_CLASSES

  private session: ort.InferenceSession | null = null
  private config: CoreMLDetectorConfig
  private ready = false
  private latencyHistory: number[] = []
  private readonly maxLatencyHistory = 30
  private classMapping: Record<number, DetectionClass>

  constructor(config: Partial<CoreMLDetectorConfig> = {}) {
    this.config = {
      modelPath: config.modelPath || '/models/coreml-detector.onnx',
      confidenceThreshold: config.confidenceThreshold ?? 0.3,
      iouThreshold: config.iouThreshold ?? 0.45,
      maxDetections: config.maxDetections ?? 100,
      useWebGPU: config.useWebGPU ?? true,
      preprocessMode: config.preprocessMode || 'vision',
      outputFormat: config.outputFormat || 'detection',
      inputName: config.inputName,
      outputName: config.outputName,
    }
    this.modelPath = this.config.modelPath
    this.classMapping = config.classMapping || CLASS_INDEX_TO_DETECTION
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
      executionProviders.push('webgpu')
    }

    executionProviders.push('webgl')
    executionProviders.push({ name: 'wasm' })

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
      
      // Note: Input size can be configured via constructor config
      // ONNX Runtime Web doesn't expose graph metadata directly
      
      this.ready = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[CoreMLDetector] Failed to load model: ${message}`)
    }
  }

  /**
   * Run detection on image data
   */
  async detect(imageData: ImageData): Promise<Detection[]> {
    if (!this.session || !this.ready) {
      throw new Error('[CoreMLDetector] Not initialized')
    }

    const startTime = performance.now()

    try {
      // Preprocess image with CoreML-style normalization
      const inputTensor = this.preprocessImage(imageData)

      // Get input name from session or config
      const inputName = this.config.inputName || this.session.inputNames[0] || 'image'

      // Run inference
      const results = await this.session.run({
        [inputName]: inputTensor,
      })

      // Get output tensor
      const outputName = this.config.outputName || this.session.outputNames[0]
      const output = results[outputName]
      if (!output) {
        throw new Error('No output from model')
      }
      const outputDims = output.dims as number[]

      // Postprocess based on output format
      let detections: Detection[]
      switch (this.config.outputFormat) {
        case 'classification':
          if (outputDims.length === 2) {
            const classData = validateRank2Tensor(output.data, outputDims, '[CoreMLDetector]')
            detections = this.postprocessClassification(
              classData,
              outputDims,
              imageData.width,
              imageData.height
            )
            break
          }
          detections = this.postprocessClassification(
            assertFloat32Tensor(output.data, '[CoreMLDetector]'),
            outputDims,
            imageData.width,
            imageData.height
          )
          break
        case 'yolo':
          const yoloData = validateRank3Tensor(output.data, outputDims, '[CoreMLDetector]')
          detections = this.postprocessYOLO(
            yoloData,
            outputDims,
            imageData.width,
            imageData.height
          )
          break
        case 'detection':
        default:
          const detectionData = assertFloat32Tensor(output.data, '[CoreMLDetector]')
          detections = this.postprocessDetection(
            detectionData,
            outputDims,
            imageData.width,
            imageData.height,
            results
          )
      }

      // Record latency
      const latency = performance.now() - startTime
      this.latencyHistory.push(latency)
      if (this.latencyHistory.length > this.maxLatencyHistory) {
        this.latencyHistory.shift()
      }

      return detections
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[CoreMLDetector] Inference error: ${message}`)
    }
  }

  /**
   * Preprocess image with Apple Vision-style normalization
   * CoreML models may expect different normalization than ImageNet
   */
  private preprocessImage(imageData: ImageData): ort.Tensor {
    const { width, height, data } = imageData
    const targetWidth = this.inputSize.width
    const targetHeight = this.inputSize.height

    // Create canvas for resizing
    const canvas = new OffscreenCanvas(targetWidth, targetHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('[CoreMLDetector] Failed to get 2D context')
    }

    // Create temporary canvas with original image
    const tempCanvas = new OffscreenCanvas(width, height)
    const tempCtx = tempCanvas.getContext('2d')
    if (!tempCtx) {
      throw new Error('[CoreMLDetector] Failed to get temp 2D context')
    }
    const tempImageData = tempCtx.createImageData(width, height)
    tempImageData.data.set(data)
    tempCtx.putImageData(tempImageData, 0, 0)

    // Resize with aspect ratio preservation (letterboxing)
    const scale = Math.min(targetWidth / width, targetHeight / height)
    const scaledWidth = Math.round(width * scale)
    const scaledHeight = Math.round(height * scale)
    const offsetX = Math.round((targetWidth - scaledWidth) / 2)
    const offsetY = Math.round((targetHeight - scaledHeight) / 2)

    // Fill with neutral color based on preprocess mode
    ctx.fillStyle = this.config.preprocessMode === 'vision_bias' ? '#808080' : '#000000'
    ctx.fillRect(0, 0, targetWidth, targetHeight)

    // Draw resized image
    ctx.drawImage(tempCanvas, offsetX, offsetY, scaledWidth, scaledHeight)

    // Get resized image data
    const resizedData = ctx.getImageData(0, 0, targetWidth, targetHeight).data

    // Convert to tensor with appropriate normalization
    const channels = 3
    const tensorData = new Float32Array(1 * channels * targetHeight * targetWidth)

    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const pixelIndex = (y * targetWidth + x) * 4
        const tensorIndex = y * targetWidth + x

        const r = resizedData[pixelIndex]
        const g = resizedData[pixelIndex + 1]
        const b = resizedData[pixelIndex + 2]

        // Apply normalization based on mode
        const [nr, ng, nb] = this.normalizePixel(r, g, b)

        // NCHW format (batch, channels, height, width)
        tensorData[0 * targetHeight * targetWidth + tensorIndex] = nr // R
        tensorData[1 * targetHeight * targetWidth + tensorIndex] = ng // G
        tensorData[2 * targetHeight * targetWidth + tensorIndex] = nb // B
      }
    }

    return new ort.Tensor('float32', tensorData, [1, channels, targetHeight, targetWidth])
  }

  /**
   * Normalize pixel values based on preprocessing mode
   */
  private normalizePixel(r: number, g: number, b: number): [number, number, number] {
    switch (this.config.preprocessMode) {
      case 'vision':
        // Apple Vision default: scale to [0, 1]
        return [r / 255, g / 255, b / 255]

      case 'vision_bias':
        // Apple Vision with bias: scale to [-1, 1]
        return [
          (r / 255) * 2 - 1,
          (g / 255) * 2 - 1,
          (b / 255) * 2 - 1,
        ]

      case 'imagenet':
        // Standard ImageNet normalization
        const mean = [0.485, 0.456, 0.406]
        const std = [0.229, 0.224, 0.225]
        return [
          (r / 255 - mean[0]) / std[0],
          (g / 255 - mean[1]) / std[1],
          (b / 255 - mean[2]) / std[2],
        ]

      case 'raw':
        // No normalization, keep [0, 255]
        return [r, g, b]

      default:
        return [r / 255, g / 255, b / 255]
    }
  }

  /**
   * Postprocess detection output
   * Handles various CoreML detection output formats
   */
  private postprocessDetection(
    output: Float32Array,
    dims: number[],
    origWidth: number,
    origHeight: number,
    allResults: ort.InferenceSession.OnnxValueMapType
  ): Detection[] {
    const detections: Detection[] = []

    // Calculate scale factors for coordinate conversion
    const scale = Math.min(this.inputSize.width / origWidth, this.inputSize.height / origHeight)
    const offsetX = (this.inputSize.width - origWidth * scale) / 2
    const offsetY = (this.inputSize.height - origHeight * scale) / 2

    // Try to detect output format from dimensions
    // Common formats:
    // - [1, N, 6]: class_id, score, x1, y1, x2, y2
    // - [1, N, 5+C]: x, y, w, h, obj_conf, class_scores...
    // - Separate outputs: boxes, scores, classes

    // Check if we have separate output tensors (common in CoreML exports)
    const boxesOutput = allResults['boxes'] || allResults['coordinates'] || allResults['bboxes']
    const scoresOutput = allResults['scores'] || allResults['confidence']
    const classesOutput = allResults['classes'] || allResults['labels']

    if (boxesOutput && scoresOutput) {
      const boxes = assertFloat32Tensor(boxesOutput.data, '[CoreMLDetector boxes]')
      const scores = assertFloat32Tensor(scoresOutput.data, '[CoreMLDetector scores]')
      const classes = classesOutput ? assertFloat32Tensor(classesOutput.data, '[CoreMLDetector classes]') : undefined
      // Separate outputs format
      return this.postprocessSeparateOutputs(
        boxes,
        boxesOutput.dims as number[],
        scores,
        classes,
        origWidth,
        origHeight,
        scale,
        offsetX,
        offsetY
      )
    }

    // Single output tensor format
    validateRank3Tensor(output, dims, '[CoreMLDetector]')
    const numPredictions = dims[1]
    const predSize = dims[2] || dims[1]
    if (dims[0] !== 1 || numPredictions <= 0 || predSize < 5) {
      throw new Error(`[CoreMLDetector] Invalid detection output shape: [${dims.join(', ')}]`)
    }

    // Determine format based on prediction size
    const hasClassScores = predSize > 6

    for (let i = 0; i < numPredictions; i++) {
      const baseIdx = i * predSize

      let classId: number
      let score: number
      let x1: number, y1: number, x2: number, y2: number

      if (predSize === 6) {
        // Format: [class_id, score, x1, y1, x2, y2]
        classId = Math.round(output[baseIdx])
        score = output[baseIdx + 1]
        x1 = output[baseIdx + 2]
        y1 = output[baseIdx + 3]
        x2 = output[baseIdx + 4]
        y2 = output[baseIdx + 5]
      } else if (predSize === 5) {
        // Format: [x1, y1, x2, y2, score] - single class
        x1 = output[baseIdx]
        y1 = output[baseIdx + 1]
        x2 = output[baseIdx + 2]
        y2 = output[baseIdx + 3]
        score = output[baseIdx + 4]
        classId = 0
      } else if (hasClassScores) {
        // Format: [x, y, w, h, class_scores...]
        const cx = output[baseIdx]
        const cy = output[baseIdx + 1]
        const w = output[baseIdx + 2]
        const h = output[baseIdx + 3]

        x1 = cx - w / 2
        y1 = cy - h / 2
        x2 = cx + w / 2
        y2 = cy + h / 2

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
      } else {
        continue
      }

      // Filter by confidence threshold
      if (score < this.config.confidenceThreshold) {
        continue
      }

      // Check if coordinates are normalized
      const isNormalized = x1 <= 1 && y1 <= 1 && x2 <= 1 && y2 <= 1

      if (isNormalized) {
        x1 = x1 * this.inputSize.width
        y1 = y1 * this.inputSize.height
        x2 = x2 * this.inputSize.width
        y2 = y2 * this.inputSize.height
      }

      // Convert from model coordinates to original image coordinates
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

      const detClass = this.classMapping[classId] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: score,
        bbox: [x1, y1, x2, y2],
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, score),
      })
    }

    // Apply NMS and limit results
    const nmsDetections = this.nonMaxSuppression(detections)
    return nmsDetections.slice(0, this.config.maxDetections)
  }

  /**
   * Handle separate output tensors (common in CoreML exports)
   */
  private postprocessSeparateOutputs(
    boxes: Float32Array,
    boxDims: number[],
    scores: Float32Array,
    classes: Float32Array | undefined,
    origWidth: number,
    origHeight: number,
    scale: number,
    offsetX: number,
    offsetY: number
  ): Detection[] {
    const detections: Detection[] = []
    if (boxDims.length !== 2 && boxDims.length !== 3) {
      throw new Error(`[CoreMLDetector] Invalid boxes output rank: ${boxDims.length}`)
    }
    assertDims(boxDims, boxDims.length, '[CoreMLDetector boxes]')
    const boxCoordinateDim = boxDims[boxDims.length - 1]
    if (boxCoordinateDim !== 4) {
      throw new Error(`[CoreMLDetector boxes]: expected 4 box coordinates, got ${boxCoordinateDim}`)
    }
    const numPredictions = boxDims.length === 3 ? boxDims[1] : boxDims[0]
    assertTensorLength(boxes, numPredictions * 4, '[CoreMLDetector boxes]')
    assertFiniteTensorValues(boxes, '[CoreMLDetector boxes]')
    assertFiniteTensorValues(scores, '[CoreMLDetector scores]')
    if (scores.length < numPredictions) {
      throw new Error('[CoreMLDetector scores]: tensor length is shorter than box count')
    }
    if (classes && classes.length < numPredictions) {
      throw new Error('[CoreMLDetector classes]: tensor length is shorter than box count')
    }
    if (classes) {
      assertFiniteTensorValues(classes, '[CoreMLDetector classes]')
    }

    for (let i = 0; i < numPredictions; i++) {
      const score = scores[i]

      if (score < this.config.confidenceThreshold) {
        continue
      }

      // Get box coordinates
      let x1 = boxes[i * 4]
      let y1 = boxes[i * 4 + 1]
      let x2 = boxes[i * 4 + 2]
      let y2 = boxes[i * 4 + 3]

      // Handle normalized coordinates
      const isNormalized = x1 <= 1 && y1 <= 1 && x2 <= 1 && y2 <= 1

      if (isNormalized) {
        x1 = x1 * this.inputSize.width
        y1 = y1 * this.inputSize.height
        x2 = x2 * this.inputSize.width
        y2 = y2 * this.inputSize.height
      }

      // Convert to original image coordinates
      x1 = (x1 - offsetX) / scale
      y1 = (y1 - offsetY) / scale
      x2 = (x2 - offsetX) / scale
      y2 = (y2 - offsetY) / scale

      // Clamp to image bounds
      x1 = Math.max(0, Math.min(origWidth, x1))
      y1 = Math.max(0, Math.min(origHeight, y1))
      x2 = Math.max(0, Math.min(origWidth, x2))
      y2 = Math.max(0, Math.min(origHeight, y2))

      if (x2 <= x1 || y2 <= y1) {
        continue
      }

      const classId = classes ? Math.round(classes[i]) : 0
      const detClass = this.classMapping[classId] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: score,
        bbox: [x1, y1, x2, y2],
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, score),
      })
    }

    const nmsDetections = this.nonMaxSuppression(detections)
    return nmsDetections.slice(0, this.config.maxDetections)
  }

  /**
   * Postprocess classification output
   * Creates a centered detection from classification results
   */
  private postprocessClassification(
    output: Float32Array,
    _dims: number[],
    origWidth: number,
    origHeight: number
  ): Detection[] {
    const detections: Detection[] = []
    if (output.length === 0) {
      throw new Error('[CoreMLDetector] Classification output must not be empty')
    }
    for (let i = 0; i < output.length; i++) {
      if (!Number.isFinite(output[i])) {
        throw new Error(`[CoreMLDetector] Classification score ${i} must be finite`)
      }
    }

    // Find top predictions
    const numClasses = output.length

    // Create array of [index, score] pairs
    const scores: Array<{ classId: number; score: number }> = []
    for (let i = 0; i < numClasses; i++) {
      scores.push({ classId: i, score: output[i] })
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score)

    // Take top predictions above threshold
    for (const { classId, score } of scores) {
      if (score < this.config.confidenceThreshold) {
        break
      }

      const detClass = this.classMapping[classId] || 'unknown'

      // For classification, create a centered bounding box
      // covering 60% of the image
      const boxWidth = origWidth * 0.6
      const boxHeight = origHeight * 0.6
      const x1 = (origWidth - boxWidth) / 2
      const y1 = (origHeight - boxHeight) / 2

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: score,
        bbox: [x1, y1, x1 + boxWidth, y1 + boxHeight],
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, score),
      })

      // Only return top classification
      break
    }

    return detections
  }

  /**
   * Postprocess YOLO-style output from converted CoreML model
   */
  private postprocessYOLO(
    output: Float32Array,
    dims: number[],
    origWidth: number,
    origHeight: number
  ): Detection[] {
    if (dims[0] !== 1 || dims[1] <= 4 || dims[2] <= 0) {
      throw new Error(`[CoreMLDetector] Invalid YOLO output shape: [${dims.join(', ')}]`)
    }

    const detections: Detection[] = []

    const scale = Math.min(this.inputSize.width / origWidth, this.inputSize.height / origHeight)
    const offsetX = (this.inputSize.width - origWidth * scale) / 2
    const offsetY = (this.inputSize.height - origHeight * scale) / 2

    // YOLOv8 format: [1, 84, 8400] (84 = 4 bbox + 80 classes)
    const numClasses = dims[1] - 4
    const numPredictions = dims[2]

    for (let i = 0; i < numPredictions; i++) {
      // Find max class score
      let maxScore = 0
      let maxClassIdx = 0

      for (let c = 0; c < numClasses; c++) {
        const score = output[(4 + c) * numPredictions + i]
        if (score > maxScore) {
          maxScore = score
          maxClassIdx = c
        }
      }

      if (maxScore < this.config.confidenceThreshold) {
        continue
      }

      // Get bounding box (center format)
      const cx = output[0 * numPredictions + i]
      const cy = output[1 * numPredictions + i]
      const w = output[2 * numPredictions + i]
      const h = output[3 * numPredictions + i]

      let x1 = cx - w / 2
      let y1 = cy - h / 2
      let x2 = cx + w / 2
      let y2 = cy + h / 2

      // Convert to original image coordinates
      x1 = (x1 - offsetX) / scale
      y1 = (y1 - offsetY) / scale
      x2 = (x2 - offsetX) / scale
      y2 = (y2 - offsetY) / scale

      // Clamp
      x1 = Math.max(0, Math.min(origWidth, x1))
      y1 = Math.max(0, Math.min(origHeight, y1))
      x2 = Math.max(0, Math.min(origWidth, x2))
      y2 = Math.max(0, Math.min(origHeight, y2))

      const detClass = this.classMapping[maxClassIdx] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: maxScore,
        bbox: [x1, y1, x2, y2],
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, maxScore),
      })
    }

    const nmsDetections = this.nonMaxSuppression(detections)
    return nmsDetections.slice(0, this.config.maxDetections)
  }

  /**
   * Non-Maximum Suppression
   */
  private nonMaxSuppression(detections: Detection[]): Detection[] {
    if (detections.length === 0) return []

    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence)
    const kept: Detection[] = []

    while (sorted.length > 0) {
      const best = sorted.shift()!
      kept.push(best)

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

    const ix1 = Math.max(ax1, bx1)
    const iy1 = Math.max(ay1, by1)
    const ix2 = Math.min(ax2, bx2)
    const iy2 = Math.min(ay2, by2)

    const iw = Math.max(0, ix2 - ix1)
    const ih = Math.max(0, iy2 - iy1)
    const intersection = iw * ih

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
      this.session = null
      this.ready = false
      this.latencyHistory = []
    }
  }
}

/**
 * Create a CoreMLDetector instance with default configuration
 */
export function createCoreMLDetector(config?: Partial<CoreMLDetectorConfig>): CoreMLDetector {
  return new CoreMLDetector(config)
}
