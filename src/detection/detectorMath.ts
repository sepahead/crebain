import type { Detection } from './types'

export type BoundingBox = [number, number, number, number]

export interface ImageSize {
  width: number
  height: number
}

export interface LetterboxGeometry {
  scale: number
  offsetX: number
  offsetY: number
  scaledWidth: number
  scaledHeight: number
}

export interface ClassScore {
  classIndex: number
  score: number
}

export function assertImageSize(name: string, size: ImageSize): void {
  if (!Number.isSafeInteger(size.width) || size.width <= 0) {
    throw new Error(`${name}.width must be a positive safe integer`)
  }
  if (!Number.isSafeInteger(size.height) || size.height <= 0) {
    throw new Error(`${name}.height must be a positive safe integer`)
  }
}

export function computeLetterboxGeometry(
  sourceSize: ImageSize,
  targetSize: ImageSize,
  pixelAligned = false
): LetterboxGeometry {
  assertImageSize('sourceSize', sourceSize)
  assertImageSize('targetSize', targetSize)

  const scale = Math.min(targetSize.width / sourceSize.width, targetSize.height / sourceSize.height)
  const scaledWidth = pixelAligned ? Math.round(sourceSize.width * scale) : sourceSize.width * scale
  const scaledHeight = pixelAligned
    ? Math.round(sourceSize.height * scale)
    : sourceSize.height * scale
  const offsetX = pixelAligned
    ? Math.round((targetSize.width - scaledWidth) / 2)
    : (targetSize.width - scaledWidth) / 2
  const offsetY = pixelAligned
    ? Math.round((targetSize.height - scaledHeight) / 2)
    : (targetSize.height - scaledHeight) / 2

  return { scale, offsetX, offsetY, scaledWidth, scaledHeight }
}

export function centerBoxToCorners(
  cx: number,
  cy: number,
  width: number,
  height: number
): BoundingBox {
  return [cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2]
}

export function isLikelyNormalizedBox(box: BoundingBox): boolean {
  return box.every((value) => Number.isFinite(value) && value <= 1)
}

export function scaleNormalizedBox(box: BoundingBox, targetSize: ImageSize): BoundingBox {
  assertImageSize('targetSize', targetSize)
  return [
    box[0] * targetSize.width,
    box[1] * targetSize.height,
    box[2] * targetSize.width,
    box[3] * targetSize.height,
  ]
}

export function projectLetterboxBoxToImage(
  box: BoundingBox,
  geometry: LetterboxGeometry
): BoundingBox {
  return [
    (box[0] - geometry.offsetX) / geometry.scale,
    (box[1] - geometry.offsetY) / geometry.scale,
    (box[2] - geometry.offsetX) / geometry.scale,
    (box[3] - geometry.offsetY) / geometry.scale,
  ]
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function clampBoxToImage(box: BoundingBox, imageSize: ImageSize): BoundingBox {
  assertImageSize('imageSize', imageSize)
  return [
    clamp(box[0], 0, imageSize.width),
    clamp(box[1], 0, imageSize.height),
    clamp(box[2], 0, imageSize.width),
    clamp(box[3], 0, imageSize.height),
  ]
}

export function isValidBox(box: BoundingBox): boolean {
  return box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1]
}

export function boxArea(box: BoundingBox): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1])
}

export function intersectionOverUnion(boxA: BoundingBox, boxB: BoundingBox): number {
  const ix1 = Math.max(boxA[0], boxB[0])
  const iy1 = Math.max(boxA[1], boxB[1])
  const ix2 = Math.min(boxA[2], boxB[2])
  const iy2 = Math.min(boxA[3], boxB[3])
  const intersection = boxArea([ix1, iy1, ix2, iy2])
  const union = boxArea(boxA) + boxArea(boxB) - intersection

  return union > 0 ? intersection / union : 0
}

export function readYoloCenterBox(
  output: Float32Array,
  numPredictions: number,
  predictionIndex: number
): BoundingBox {
  const cx = output[predictionIndex]
  const cy = output[numPredictions + predictionIndex]
  const width = output[2 * numPredictions + predictionIndex]
  const height = output[3 * numPredictions + predictionIndex]
  return centerBoxToCorners(cx, cy, width, height)
}

export function findMaxScore(
  output: Float32Array,
  startIndex: number,
  count: number,
  stride = 1
): ClassScore {
  let score = 0
  let classIndex = 0

  for (let index = 0; index < count; index++) {
    const value = output[startIndex + index * stride]
    if (value > score) {
      score = value
      classIndex = index
    }
  }

  return { classIndex, score }
}

export function findMaxYoloClassScore(
  output: Float32Array,
  numPredictions: number,
  predictionIndex: number,
  numClasses: number
): ClassScore {
  return findMaxScore(output, 4 * numPredictions + predictionIndex, numClasses, numPredictions)
}

export function recordLatency(
  history: number[],
  maxHistory: number,
  startTime: number,
  endTime = performance.now()
): number {
  const latency = endTime - startTime
  if (Number.isFinite(latency) && latency >= 0) {
    history.push(latency)
    while (history.length > maxHistory) {
      history.shift()
    }
  }
  return latency
}

export function averageLatency(history: readonly number[]): number {
  return history.length === 0
    ? 0
    : history.reduce((total, latency) => total + latency, 0) / history.length
}

export function nonMaxSuppression(
  detections: readonly Detection[],
  iouThreshold: number
): Detection[] {
  if (detections.length === 0) {
    return []
  }

  // Per-class NMS: a box only suppresses overlapping boxes of the SAME class,
  // so e.g. a high-confidence bird box cannot erase a co-located drone box.
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence)
  const kept: Detection[] = []

  while (sorted.length > 0) {
    const best = sorted.shift()
    if (!best) {
      break
    }
    kept.push(best)

    for (let index = sorted.length - 1; index >= 0; index--) {
      if (
        sorted[index].class === best.class &&
        intersectionOverUnion(best.bbox, sorted[index].bbox) > iouThreshold
      ) {
        sorted.splice(index, 1)
      }
    }
  }

  return kept
}
