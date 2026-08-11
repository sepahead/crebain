import { describe, expect, it } from 'vitest'
import { CircularBuffer } from '../CircularBuffer'

describe('CircularBuffer', () => {
  it('rejects capacities that can throw or allocate without a project bound', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new CircularBuffer(capacity)).toThrow('positive safe integer')
    }
    expect(() => new CircularBuffer(CircularBuffer.MAX_CAPACITY + 1)).toThrow('no greater')
  })

  it('keeps deterministic oldest-to-newest ordering across overwrite', () => {
    const buffer = new CircularBuffer<number>(3)
    buffer.push(1)
    buffer.push(2)
    buffer.push(3)
    buffer.push(4)

    expect(buffer.toArray()).toEqual([2, 3, 4])
    expect(buffer.lastN(2)).toEqual([4, 3])
    expect(buffer.get(0.5)).toBeUndefined()
    expect(() => buffer.lastN(-1)).toThrow('non-negative safe integer')
  })

  it('releases stored references when cleared', () => {
    const buffer = new CircularBuffer<object>(2)
    const first = {}
    buffer.push(first)
    buffer.clear()

    expect(buffer.length).toBe(0)
    expect(buffer.toArray()).toEqual([])
    buffer.push({ next: true })
    expect(buffer.oldest()).toEqual({ next: true })
  })
})
