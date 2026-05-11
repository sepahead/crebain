import { describe, expect, it } from 'vitest'
import { validateRank3Tensor } from '../tensorValidation'

describe('tensorValidation', () => {
  it('accepts valid rank-3 Float32 tensors', () => {
    const data = new Float32Array(2 * 3 * 4)

    expect(validateRank3Tensor(data, [2, 3, 4], 'test')).toBe(data)
  })

  it('rejects malformed tensor ranks and lengths', () => {
    expect(() => validateRank3Tensor(new Float32Array(4), [2, 2], 'test')).toThrow('expected rank 3')
    expect(() => validateRank3Tensor(new Float32Array(3), [1, 2, 2], 'test')).toThrow('does not match expected')
  })

  it('rejects non-finite tensor values', () => {
    const data = new Float32Array([1, Number.NaN, 3, 4])

    expect(() => validateRank3Tensor(data, [1, 2, 2], 'test')).toThrow('must be finite')
  })
})
