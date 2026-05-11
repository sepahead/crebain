import { tensorElementCount } from './tensorValidation'

export const RGB_CHANNELS = 3
export const RGBA_CHANNELS = 4
export const MAX_COLOR_VALUE = 255

export type PixelNormalizer = (r: number, g: number, b: number) => readonly [number, number, number]

export function rgbaToNchwRgbFloat32(
  rgbaData: ArrayLike<number>,
  width: number,
  height: number,
  normalizePixel: PixelNormalizer
): Float32Array {
  const planeSize = tensorElementCount([height, width], 'rgbaToNchwRgbFloat32 plane')
  const expectedRgbaLength = tensorElementCount([height, width, RGBA_CHANNELS], 'rgbaToNchwRgbFloat32 rgba')
  if (rgbaData.length !== expectedRgbaLength) {
    throw new Error(`rgbaToNchwRgbFloat32: RGBA length ${rgbaData.length} does not match expected ${expectedRgbaLength}`)
  }

  const tensorData = new Float32Array(RGB_CHANNELS * planeSize)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * RGBA_CHANNELS
      const tensorIndex = y * width + x
      const [r, g, b] = normalizePixel(
        rgbaData[pixelIndex],
        rgbaData[pixelIndex + 1],
        rgbaData[pixelIndex + 2]
      )

      tensorData[tensorIndex] = r
      tensorData[planeSize + tensorIndex] = g
      tensorData[2 * planeSize + tensorIndex] = b
    }
  }

  return tensorData
}

export function normalizeUnitRgb(r: number, g: number, b: number): readonly [number, number, number] {
  return [r / MAX_COLOR_VALUE, g / MAX_COLOR_VALUE, b / MAX_COLOR_VALUE]
}

export function normalizeVisionBiasRgb(r: number, g: number, b: number): readonly [number, number, number] {
  return [
    (r / MAX_COLOR_VALUE) * 2 - 1,
    (g / MAX_COLOR_VALUE) * 2 - 1,
    (b / MAX_COLOR_VALUE) * 2 - 1,
  ]
}

export function normalizeImageNetRgb(r: number, g: number, b: number): readonly [number, number, number] {
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  return [
    (r / MAX_COLOR_VALUE - mean[0]) / std[0],
    (g / MAX_COLOR_VALUE - mean[1]) / std[1],
    (b / MAX_COLOR_VALUE - mean[2]) / std[2],
  ]
}

export function normalizeRawRgb(r: number, g: number, b: number): readonly [number, number, number] {
  return [r, g, b]
}
