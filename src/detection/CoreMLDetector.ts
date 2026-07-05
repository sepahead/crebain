/**
 * CREBAIN CoreML Detector
 * Adaptive Response & Awareness System (ARAS)
 *
 * CoreML model implementation converted to ONNX format
 * Supports Apple Vision-style preprocessing and both classification/detection outputs
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
  centerBoxToCorners,
  clampBoxToImage,
  computeLetterboxGeometry,
  findMaxScore,
  findMaxYoloClassScore,
  isLikelyNormalizedBox,
  isValidBox,
  nonMaxSuppression,
  projectLetterboxBoxToImage,
  readYoloCenterBox,
  recordLatency,
  scaleNormalizedBox,
  type BoundingBox,
  type LetterboxGeometry,
} from './detectorMath'
import {
  normalizeImageNetRgb,
  normalizeRawRgb,
  normalizeUnitRgb,
  normalizeVisionBiasRgb,
  RGB_CHANNELS,
  rgbaToNchwRgbFloat32,
} from './detectorPreprocess'
import {
  assertDims,
  assertFiniteTensorValues,
  assertFloat32Tensor,
  assertTensorLength,
  tensorElementCount,
  validateRank2Tensor,
  validateRank3Tensor,
} from './tensorValidation'

// CoreML detector class mapping
const COREML_CLASSES: DetectionClass[] = ['drone', 'bird', 'aircraft', 'helicopter', 'unknown']

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
  | 'vision' // Apple Vision framework default: [0,1] range
  | 'vision_bias' // Vision with bias: [-1,1] range
  | 'imagenet' // Standard ImageNet normalization
  | 'raw' // No normalization, just [0,255]

/**
 * CoreML model output format
 */
export type CoreMLOutputFormat =
  | 'detection' // Bounding boxes with class scores
  | 'classification' // Class probabilities only (will create center detection)
  | 'yolo' // YOLO-style output from converted model

/**
 * Extended config for CoreML detector
 */
export interface CoreMLDetectorConfig extends DetectorConfig {
  preprocessMode: CoreMLPreprocessMode
  outputFormat: CoreMLOutputFormat
  classMapping?: Record<number, DetectionClass>
  inputName?: string // Model-specific input tensor name
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
      executionProviders.push('webgpu')
    }

    executionProviders.push({ name: 'wasm' })

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders,
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
    }

    try {
      this.session = await ort.InferenceSession.create(this.config.modelPath, sessionOptions)

      // Note: Input size can be configured via constructor config
      // ONNX Runtime Web doesn't expose graph metadata directly

      this.ready = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[CoreMLDetector] Failed to load model: ${message}`, { cause: error })
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
      // Compute the letterbox geometry once per frame (pixel-aligned, matching
      // the preprocessing draw) and reuse it in postprocessing so boxes are
      // projected back with the exact geometry the image was drawn with.
      const geometry = computeLetterboxGeometry(
        { width: imageData.width, height: imageData.height },
        this.inputSize,
        true
      )

      // Preprocess image with CoreML-style normalization
      const inputTensor = this.preprocessImage(imageData, geometry)

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
      const outputDims = output.dims

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
        case 'yolo': {
          const yoloData = validateRank3Tensor(output.data, outputDims, '[CoreMLDetector]')
          detections = this.postprocessYOLO(
            yoloData,
            outputDims,
            imageData.width,
            imageData.height,
            geometry
          )
          break
        }
        case 'detection':
        default: {
          const detectionData = assertFloat32Tensor(output.data, '[CoreMLDetector]')
          detections = this.postprocessDetection(
            detectionData,
            outputDims,
            imageData.width,
            imageData.height,
            results,
            geometry
          )
        }
      }

      // Record latency
      recordLatency(this.latencyHistory, this.maxLatencyHistory, startTime)

      return detections
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[CoreMLDetector] Inference error: ${message}`, { cause: error })
    }
  }

  /**
   * Preprocess image with Apple Vision-style normalization
   * CoreML models may expect different normalization than ImageNet
   */
  private preprocessImage(imageData: ImageData, geometry: LetterboxGeometry): ort.Tensor {
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

    // Fill with neutral color based on preprocess mode
    ctx.fillStyle = this.config.preprocessMode === 'vision_bias' ? '#808080' : '#000000'
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

    // Convert to tensor with appropriate normalization
    const tensorData = rgbaToNchwRgbFloat32(resizedData, targetWidth, targetHeight, (r, g, b) =>
      this.normalizePixel(r, g, b)
    )

    return new ort.Tensor('float32', tensorData, [1, RGB_CHANNELS, targetHeight, targetWidth])
  }

  /**
   * Normalize pixel values based on preprocessing mode
   */
  private normalizePixel(r: number, g: number, b: number): readonly [number, number, number] {
    switch (this.config.preprocessMode) {
      case 'vision':
        // Apple Vision default: scale to [0, 1]
        return normalizeUnitRgb(r, g, b)

      case 'vision_bias':
        // Apple Vision with bias: scale to [-1, 1]
        return normalizeVisionBiasRgb(r, g, b)

      case 'imagenet':
        // Standard ImageNet normalization
        return normalizeImageNetRgb(r, g, b)

      case 'raw':
        // No normalization, keep [0, 255]
        return normalizeRawRgb(r, g, b)

      default:
        return normalizeUnitRgb(r, g, b)
    }
  }

  /**
   * Postprocess detection output
   * Handles various CoreML detection output formats
   */
  private postprocessDetection(
    output: Float32Array,
    dims: readonly number[],
    origWidth: number,
    origHeight: number,
    allResults: ort.InferenceSession.OnnxValueMapType,
    geometry: LetterboxGeometry
  ): Detection[] {
    const detections: Detection[] = []

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
      const classes = classesOutput
        ? assertFloat32Tensor(classesOutput.data, '[CoreMLDetector classes]')
        : undefined
      // Separate outputs format
      return this.postprocessSeparateOutputs(
        boxes,
        boxesOutput.dims,
        scores,
        classes,
        origWidth,
        origHeight,
        geometry
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
      let box: BoundingBox

      if (predSize === 6) {
        // Format: [class_id, score, x1, y1, x2, y2]
        classId = Math.round(output[baseIdx])
        score = output[baseIdx + 1]
        box = [output[baseIdx + 2], output[baseIdx + 3], output[baseIdx + 4], output[baseIdx + 5]]
      } else if (predSize === 5) {
        // Format: [x1, y1, x2, y2, score] - single class
        box = [output[baseIdx], output[baseIdx + 1], output[baseIdx + 2], output[baseIdx + 3]]
        score = output[baseIdx + 4]
        classId = 0
      } else if (hasClassScores) {
        // Format: [x, y, w, h, obj_conf, class_scores...]
        const cx = output[baseIdx]
        const cy = output[baseIdx + 1]
        const w = output[baseIdx + 2]
        const h = output[baseIdx + 3]

        box = centerBoxToCorners(cx, cy, w, h)

        // obj_conf sits at baseIdx + 4; class scores start at baseIdx + 5.
        // Final confidence is obj_conf × best class score.
        const objConf = output[baseIdx + 4]
        const numClasses = predSize - 5
        const { classIndex: maxClassIdx, score: maxScore } = findMaxScore(
          output,
          baseIdx + 5,
          numClasses
        )

        classId = maxClassIdx
        score = objConf * maxScore
      } else {
        continue
      }

      // Filter by confidence threshold
      if (score < this.config.confidenceThreshold) {
        continue
      }

      // Check if coordinates are normalized
      const isNormalized = isLikelyNormalizedBox(box)

      if (isNormalized) {
        box = scaleNormalizedBox(box, this.inputSize)
      }

      // Convert from model coordinates to original image coordinates
      box = projectLetterboxBoxToImage(box, geometry)

      // Clamp to image bounds
      box = clampBoxToImage(box, { width: origWidth, height: origHeight })

      // Skip invalid boxes
      if (!isValidBox(box)) {
        continue
      }

      const detClass = this.classMapping[classId] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: score,
        bbox: box,
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, score),
      })
    }

    // Apply NMS and limit results
    const nmsDetections = nonMaxSuppression(detections, this.config.iouThreshold)
    return nmsDetections.slice(0, this.config.maxDetections)
  }

  /**
   * Handle separate output tensors (common in CoreML exports)
   */
  private postprocessSeparateOutputs(
    boxes: Float32Array,
    boxDims: readonly number[],
    scores: Float32Array,
    classes: Float32Array | undefined,
    origWidth: number,
    origHeight: number,
    geometry: LetterboxGeometry
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
    assertTensorLength(
      boxes,
      tensorElementCount([numPredictions, 4], '[CoreMLDetector boxes]'),
      '[CoreMLDetector boxes]'
    )
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

      let box: BoundingBox = [boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]]

      // Handle normalized coordinates
      if (isLikelyNormalizedBox(box)) {
        box = scaleNormalizedBox(box, this.inputSize)
      }

      // Convert to original image coordinates
      box = projectLetterboxBoxToImage(box, geometry)

      // Clamp to image bounds
      box = clampBoxToImage(box, { width: origWidth, height: origHeight })

      if (!isValidBox(box)) {
        continue
      }

      const classId = classes ? Math.round(classes[i]) : 0
      const detClass = this.classMapping[classId] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: score,
        bbox: box,
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, score),
      })
    }

    const nmsDetections = nonMaxSuppression(detections, this.config.iouThreshold)
    return nmsDetections.slice(0, this.config.maxDetections)
  }

  /**
   * Postprocess classification output
   * Creates a centered detection from classification results
   */
  private postprocessClassification(
    output: Float32Array,
    _dims: readonly number[],
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
    dims: readonly number[],
    origWidth: number,
    origHeight: number,
    geometry: LetterboxGeometry
  ): Detection[] {
    if (dims[0] !== 1 || dims[1] <= 4 || dims[2] <= 0) {
      throw new Error(`[CoreMLDetector] Invalid YOLO output shape: [${dims.join(', ')}]`)
    }

    const detections: Detection[] = []

    // YOLOv8 format: [1, 84, 8400] (84 = 4 bbox + 80 classes)
    const numClasses = dims[1] - 4
    const numPredictions = dims[2]

    for (let i = 0; i < numPredictions; i++) {
      // Find max class score
      const { classIndex: maxClassIdx, score: maxScore } = findMaxYoloClassScore(
        output,
        numPredictions,
        i,
        numClasses
      )

      if (maxScore < this.config.confidenceThreshold) {
        continue
      }

      // Get bounding box (center format)
      let box = readYoloCenterBox(output, numPredictions, i)

      // Convert to original image coordinates
      box = projectLetterboxBoxToImage(box, geometry)

      // Clamp
      box = clampBoxToImage(box, { width: origWidth, height: origHeight })

      const detClass = this.classMapping[maxClassIdx] || 'unknown'

      detections.push({
        id: generateDetectionId(),
        class: detClass,
        confidence: maxScore,
        bbox: box,
        timestamp: Date.now(),
        threatLevel: getThreatLevel(detClass, maxScore),
      })
    }

    const nmsDetections = nonMaxSuppression(detections, this.config.iouThreshold)
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
 * Create a CoreMLDetector instance with default configuration
 */
export function createCoreMLDetector(config?: Partial<CoreMLDetectorConfig>): CoreMLDetector {
  return new CoreMLDetector(config)
}
