import { describe, expect, it } from 'vitest'
import {
  normalizeImageNetRgb,
  normalizeRawRgb,
  normalizeUnitRgb,
  normalizeVisionBiasRgb,
  rgbaToNchwRgbFloat32,
} from '../detectorPreprocess'

describe('detectorPreprocess', () => {
  it('converts RGBA pixels to NCHW RGB tensors', () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 128, 255, 255,
    ])

    const tensor = rgbaToNchwRgbFloat32(rgba, 2, 1, normalizeUnitRgb)

    expect(tensor[0]).toBe(1)
    expect(tensor[1]).toBe(0)
    expect(tensor[2]).toBe(0)
    expect(tensor[3]).toBeCloseTo(128 / 255)
    expect(tensor[4]).toBe(0)
    expect(tensor[5]).toBe(1)
  })

  it('rejects RGBA payloads with mismatched dimensions', () => {
    expect(() => rgbaToNchwRgbFloat32(new Uint8ClampedArray(3), 1, 1, normalizeUnitRgb))
      .toThrow('RGBA length 3 does not match expected 4')
  })

  it('applies detector normalization modes', () => {
    expect(normalizeUnitRgb(255, 128, 0)).toEqual([1, 128 / 255, 0])
    expect(normalizeVisionBiasRgb(255, 127.5, 0)).toEqual([1, 0, -1])
    expect(normalizeRawRgb(1, 2, 3)).toEqual([1, 2, 3])

    const imagenet = normalizeImageNetRgb(255, 128, 0)
    expect(imagenet[0]).toBeCloseTo((1 - 0.485) / 0.229)
    expect(imagenet[1]).toBeCloseTo((128 / 255 - 0.456) / 0.224)
    expect(imagenet[2]).toBeCloseTo((0 - 0.406) / 0.225)
  })
})
