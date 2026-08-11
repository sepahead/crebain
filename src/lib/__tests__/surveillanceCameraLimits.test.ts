import { describe, expect, it } from 'vitest'

import {
  MAX_SURVEILLANCE_CAMERA_NAME_BYTES,
  normalizeSurveillanceCameraName,
} from '../surveillanceCameraLimits'

describe('normalizeSurveillanceCameraName', () => {
  it('trims and accepts a bounded name', () => {
    expect(normalizeSurveillanceCameraName('  North gate  ')).toBe('North gate')
  })

  it('rejects empty and UTF-8 names beyond the scene-contract byte limit', () => {
    expect(normalizeSurveillanceCameraName('   ')).toBeNull()
    expect(
      normalizeSurveillanceCameraName('a'.repeat(MAX_SURVEILLANCE_CAMERA_NAME_BYTES))
    ).toHaveLength(MAX_SURVEILLANCE_CAMERA_NAME_BYTES)
    expect(
      normalizeSurveillanceCameraName('€'.repeat(MAX_SURVEILLANCE_CAMERA_NAME_BYTES / 2))
    ).toBeNull()
  })
})
