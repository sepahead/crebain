/**
 * CREBAIN Moondream Detector
 * Adaptive Response & Awareness System (ARAS)
 *
 * Moondream2 Vision-Language Model implementation using @xenova/transformers
 * Uses natural language prompting for zero-shot object detection
 *
 * EXPERIMENTAL / NON-FUNCTIONAL: the pinned @xenova/transformers@2.17.2 does
 * not support the moondream2 architecture, and its ImageToTextPipeline ignores
 * the prompt entirely (only pixel_values are fed to generate()), so prompted
 * detection cannot work. initialize() fails fast with a clear error; see
 * MoondreamDetector's class doc for details.
 */

import type { ObjectDetector, Detection, DetectionClass, DetectorConfig } from './types'
import {
  averageLatency,
  intersectionOverUnion,
  recordLatency,
  type BoundingBox,
} from './detectorMath'
import { generateDetectionId, getThreatLevel } from './types'

// Type declaration for @xenova/transformers (optional dependency)
type TransformersPipeline = (
  image: string,
  options?: { prompt?: string; max_new_tokens?: number }
) => Promise<Array<{ generated_text: string }>>

// Detection classes we're looking for
const MOONDREAM_CLASSES: DetectionClass[] = ['drone', 'bird', 'aircraft', 'helicopter', 'unknown']

// Keywords to class mapping for fallback parsing
const KEYWORD_TO_CLASS: Record<string, DetectionClass> = {
  drone: 'drone',
  quadcopter: 'drone',
  uav: 'drone',
  unmanned: 'drone',
  bird: 'bird',
  crow: 'bird',
  eagle: 'bird',
  hawk: 'bird',
  seagull: 'bird',
  pigeon: 'bird',
  aircraft: 'aircraft',
  airplane: 'aircraft',
  plane: 'aircraft',
  jet: 'aircraft',
  helicopter: 'helicopter',
  chopper: 'helicopter',
  rotorcraft: 'helicopter',
}

// Detection prompt for structured output
const DETECTION_PROMPT = `Analyze this surveillance image. List all flying objects (drones, birds, aircraft, helicopters) with their approximate positions.

Output as JSON array: [{"object": "type", "position": "location description", "x": 0.0-1.0, "y": 0.0-1.0, "confidence": 0.0-1.0}]

If no flying objects detected, output: []`

// Simpler fallback prompt
const FALLBACK_PROMPT = `What flying objects (drones, birds, aircraft, helicopters) do you see in this image? Describe their positions (left, right, center, top, bottom).`

/**
 * Parsed detection from Moondream response
 */
interface ParsedDetection {
  object: string
  position?: string
  x?: number
  y?: number
  width?: number
  height?: number
  confidence?: number
}

/**
 * Moondream Detector using @xenova/transformers
 * Uses vision-language model for zero-shot detection via prompting
 *
 * EXPERIMENTAL — NOT FUNCTIONAL with the currently pinned dependencies:
 * - @xenova/transformers@2.17.2 has no moondream architecture, so the
 *   'Xenova/moondream2' model cannot be loaded by its `pipeline()` at all.
 * - Even for models it can load, v2's ImageToTextPipeline discards the
 *   `prompt` option (generate() receives only pixel_values), so the prompted
 *   zero-shot detection this class is built around is impossible.
 * Migrating to transformers v3 (which added moondream support) is the real
 * fix; until then initialize() rejects with an explicit error and the worker
 * reports the failure instead of silently returning garbage. The parsing/
 * bbox-estimation code below is retained for that future migration.
 */
export class MoondreamDetector implements ObjectDetector {
  name = 'Moondream2'
  modelPath: string
  inputSize = { width: 384, height: 384 } // Moondream's typical input
  classes = MOONDREAM_CLASSES

  private pipeline: unknown = null
  private config: DetectorConfig
  private ready = false
  private latencyHistory: number[] = []
  private readonly maxLatencyHistory = 30

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = {
      modelPath: config.modelPath || 'Xenova/moondream2',
      confidenceThreshold: config.confidenceThreshold ?? 0.3,
      iouThreshold: config.iouThreshold ?? 0.5,
      maxDetections: config.maxDetections ?? 20,
      useWebGPU: config.useWebGPU ?? false, // Transformers.js handles backend selection
    }
    this.modelPath = this.config.modelPath
  }

  /**
   * Fail fast: this detector cannot work with the pinned library.
   *
   * @xenova/transformers@2.17.2 does not implement the moondream2
   * architecture, and its ImageToTextPipeline ignores the detection prompt
   * (generate() is only given pixel_values), so loading a pipeline here would
   * produce a detector that can never detect anything. Rejecting up front
   * keeps the failure honest: the worker surfaces "Initialization failed"
   * and the detector stays not-ready, so detect() is never reached.
   */
  initialize(): Promise<void> {
    return Promise.reject(
      new Error(
        '[MoondreamDetector] Not functional: the pinned @xenova/transformers@2.17.2 does not ' +
          'support the moondream2 architecture, and its image-to-text pipeline ignores prompts, ' +
          'so prompted zero-shot detection cannot work. Select the yolo, rf-detr, or coreml ' +
          'detector instead (moondream requires a transformers.js v3 migration).'
      )
    )
  }

  /**
   * Run detection on image data
   */
  async detect(imageData: ImageData): Promise<Detection[]> {
    if (!this.pipeline || !this.ready) {
      throw new Error('[MoondreamDetector] Not initialized')
    }

    const startTime = performance.now()

    try {
      // Convert ImageData to base64 data URL for transformers.js
      const imageUrl = await this.imageDataToDataURL(imageData)

      // Run inference with detection prompt
      const pipelineFunc = this.pipeline as TransformersPipeline

      const results = await pipelineFunc(imageUrl, {
        prompt: DETECTION_PROMPT,
        max_new_tokens: 256,
      })

      let detections: Detection[] = []
      const responseText = results[0]?.generated_text || ''

      // Try parsing as JSON first
      detections = this.parseJSONResponse(responseText, imageData.width, imageData.height)

      // If JSON parsing failed, try fallback text parsing
      if (detections.length === 0 && responseText.trim().length > 2) {
        // Run with simpler prompt for fallback
        const fallbackResults = await pipelineFunc(imageUrl, {
          prompt: FALLBACK_PROMPT,
          max_new_tokens: 128,
        })
        const fallbackText = fallbackResults[0]?.generated_text || ''
        detections = this.parseTextResponse(fallbackText, imageData.width, imageData.height)
      }

      // Filter by confidence and limit
      detections = detections
        .filter((d) => d.confidence >= this.config.confidenceThreshold)
        .slice(0, this.config.maxDetections)

      // Record latency
      recordLatency(this.latencyHistory, this.maxLatencyHistory, startTime)

      return detections
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[MoondreamDetector] Inference error: ${message}`, { cause: error })
    }
  }

  /**
   * Convert ImageData to a base64 data URL via OffscreenCanvas encoding.
   * Works in both main thread and Web Worker contexts.
   */
  private async imageDataToDataURL(imageData: ImageData): Promise<string> {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('[MoondreamDetector] Failed to get 2D context')
    }
    ctx.putImageData(imageData, 0, 0)

    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('[MoondreamDetector] Failed to encode frame'))
      reader.readAsDataURL(blob)
    })
  }

  /**
   * Parse JSON-formatted response from Moondream
   */
  private parseJSONResponse(text: string, imgWidth: number, imgHeight: number): Detection[] {
    const detections: Detection[] = []

    try {
      // Find JSON array in response
      const jsonMatch = text.match(/\[[\s\S]*?\]/g)
      if (!jsonMatch) return []

      for (const jsonStr of jsonMatch) {
        const parsed = JSON.parse(jsonStr) as ParsedDetection[]

        if (!Array.isArray(parsed)) continue

        for (const item of parsed) {
          if (!item.object) continue

          // Map object type to detection class
          const detClass = this.mapToDetectionClass(item.object)

          // Calculate bounding box from normalized coordinates or position description
          const bbox = this.calculateBbox(item, imgWidth, imgHeight)

          // Use provided confidence or estimate based on detection specificity
          const confidence = item.confidence ?? this.estimateConfidence(item)

          detections.push({
            id: generateDetectionId(),
            class: detClass,
            confidence,
            bbox,
            timestamp: Date.now(),
            threatLevel: getThreatLevel(detClass, confidence),
          })
        }
      }
    } catch {
      // JSON parsing failed, return empty array
      return []
    }

    return detections
  }

  /**
   * Parse text response when JSON fails (fallback)
   */
  private parseTextResponse(text: string, imgWidth: number, imgHeight: number): Detection[] {
    const detections: Detection[] = []
    const lowerText = text.toLowerCase()

    // Look for object mentions with position indicators
    for (const [keyword, detClass] of Object.entries(KEYWORD_TO_CLASS)) {
      const keywordLower = keyword.toLowerCase()
      let searchStart = 0

      while (true) {
        const idx = lowerText.indexOf(keywordLower, searchStart)
        if (idx === -1) break

        searchStart = idx + keyword.length

        // Extract surrounding context for position estimation
        const contextStart = Math.max(0, idx - 50)
        const contextEnd = Math.min(lowerText.length, idx + keyword.length + 50)
        const context = lowerText.slice(contextStart, contextEnd)

        // Estimate position from context
        const position = this.estimatePositionFromContext(context)

        // Create bounding box (VLMs can't give precise boxes, so use region-based)
        const bbox = this.positionToBbox(position, imgWidth, imgHeight)

        detections.push({
          id: generateDetectionId(),
          class: detClass,
          confidence: 0.5, // Lower confidence for text-parsed detections
          bbox,
          timestamp: Date.now(),
          threatLevel: getThreatLevel(detClass, 0.5),
        })
      }
    }

    // Remove duplicates based on similar position
    return this.deduplicateDetections(detections)
  }

  /**
   * Map object string to DetectionClass
   */
  private mapToDetectionClass(objectType: string): DetectionClass {
    const lower = objectType.toLowerCase()

    for (const [keyword, detClass] of Object.entries(KEYWORD_TO_CLASS)) {
      if (lower.includes(keyword)) {
        return detClass
      }
    }

    return 'unknown'
  }

  /**
   * Calculate bounding box from parsed detection
   */
  private calculateBbox(
    item: ParsedDetection,
    imgWidth: number,
    imgHeight: number
  ): [number, number, number, number] {
    // If we have normalized coordinates
    if (typeof item.x === 'number' && typeof item.y === 'number') {
      const x = item.x * imgWidth
      const y = item.y * imgHeight
      const w = (item.width ?? 0.15) * imgWidth
      const h = (item.height ?? 0.15) * imgHeight

      return [
        Math.max(0, x - w / 2),
        Math.max(0, y - h / 2),
        Math.min(imgWidth, x + w / 2),
        Math.min(imgHeight, y + h / 2),
      ]
    }

    // Fall back to position description
    const position = this.parsePositionDescription(item.position || 'center')
    return this.positionToBbox(position, imgWidth, imgHeight)
  }

  /**
   * Parse position description to normalized coordinates
   */
  private parsePositionDescription(desc: string): { x: number; y: number } {
    const lower = desc.toLowerCase()

    let x = 0.5
    let y = 0.5

    if (lower.includes('left')) x = 0.25
    else if (lower.includes('right')) x = 0.75

    if (lower.includes('top') || lower.includes('upper')) y = 0.25
    else if (lower.includes('bottom') || lower.includes('lower')) y = 0.75

    return { x, y }
  }

  /**
   * Estimate position from surrounding context
   */
  private estimatePositionFromContext(context: string): { x: number; y: number } {
    return this.parsePositionDescription(context)
  }

  /**
   * Convert position to bounding box
   */
  private positionToBbox(
    position: { x: number; y: number },
    imgWidth: number,
    imgHeight: number
  ): [number, number, number, number] {
    // Default box size (15% of image)
    const boxWidth = imgWidth * 0.15
    const boxHeight = imgHeight * 0.15

    const centerX = position.x * imgWidth
    const centerY = position.y * imgHeight

    return [
      Math.max(0, centerX - boxWidth / 2),
      Math.max(0, centerY - boxHeight / 2),
      Math.min(imgWidth, centerX + boxWidth / 2),
      Math.min(imgHeight, centerY + boxHeight / 2),
    ]
  }

  /**
   * Estimate confidence based on detection specificity
   */
  private estimateConfidence(item: ParsedDetection): number {
    let confidence = 0.6 // Base confidence

    // Higher confidence if coordinates provided
    if (typeof item.x === 'number' && typeof item.y === 'number') {
      confidence += 0.15
    }

    // Higher confidence if specific object type
    const lower = item.object.toLowerCase()
    if (lower.includes('drone') || lower.includes('quadcopter')) {
      confidence += 0.1
    }

    return Math.min(0.95, confidence)
  }

  /**
   * Remove duplicate detections based on position
   */
  private deduplicateDetections(detections: Detection[]): Detection[] {
    const result: Detection[] = []

    for (const det of detections) {
      let isDuplicate = false

      for (const existing of result) {
        if (existing.class === det.class) {
          // Check if bboxes overlap significantly
          const iou = this.calculateIoU(existing.bbox, det.bbox)
          if (iou > 0.5) {
            isDuplicate = true
            // Keep higher confidence one
            if (det.confidence > existing.confidence) {
              Object.assign(existing, det)
            }
            break
          }
        }
      }

      if (!isDuplicate) {
        result.push(det)
      }
    }

    return result
  }

  /**
   * Calculate Intersection over Union
   */
  private calculateIoU(boxA: BoundingBox, boxB: BoundingBox): number {
    return intersectionOverUnion(boxA, boxB)
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
   * Dispose of the pipeline and free resources
   */
  dispose(): Promise<void> {
    this.pipeline = null
    this.ready = false
    this.latencyHistory = []
    return Promise.resolve()
  }
}

/**
 * Create a MoondreamDetector instance with default configuration
 */
export function createMoondreamDetector(config?: Partial<DetectorConfig>): MoondreamDetector {
  return new MoondreamDetector(config)
}
