import { describe, expect, it } from 'vitest'
import { tensorElementCount, validateRank3Tensor } from '../tensorValidation'

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

  it('rejects unsafe tensor dimensions and element counts', () => {
    expect(() => validateRank3Tensor(new Float32Array(1), [1, Number.MAX_SAFE_INTEGER + 1, 1], 'test'))
      .toThrow('dimension 1 must be a positive integer')
    expect(() => tensorElementCount([Number.MAX_SAFE_INTEGER, 2], 'test'))
      .toThrow('tensor dimensions exceed safe element count')
  })
})
