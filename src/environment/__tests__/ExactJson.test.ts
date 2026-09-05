// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { exactJson } from '../ExactJson'
import { graphicsInputDigest } from '../GraphicsContract'

describe('exact numeric JSON at the graphics boundary', () => {
  it('preserves signed zero, subnormal, finite extreme, and ordinary values in JS and Python', () => {
    const values = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -1.25]
    const encoded = exactJson(values)
    const decoded = JSON.parse(encoded) as number[]
    values.forEach((value, index) => expect(Object.is(value, decoded[index])).toBe(true))
    expect(encoded).toContain('-0.0')
    const observed = execFileSync(
      'python3',
      [
        '-c',
        'import json,struct,sys;print(json.dumps([struct.pack(">d",v).hex() for v in json.loads(sys.argv[1])]))',
        encoded,
      ],
      { encoding: 'utf8', timeout: 1000 }
    )
    const bits = values.map((value) => {
      const bytes = Buffer.alloc(8)
      bytes.writeDoubleBE(value)
      return bytes.toString('hex')
    })
    expect(JSON.parse(observed)).toEqual(bits)
  })

  it('rejects non-JSON data without executing ordinary accessors', () => {
    const read = vi.fn(() => 1)
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      undefined,
      new Date(),
      {
        get value() {
          return read()
        },
      },
    ])
      expect(() => exactJson(value)).toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(exactJson({ value: 1 })).toBe('{"value":1}')
  })

  it('binds the exact transported decoded numeric meaning and detects normal JSON zero erasure', async () => {
    const input = { position: [-0, 0, Number.MIN_VALUE] }
    expect(await graphicsInputDigest(JSON.parse(exactJson(input)))).toBe(
      await graphicsInputDigest(input)
    )
    expect(await graphicsInputDigest(JSON.parse(JSON.stringify(input)))).not.toBe(
      await graphicsInputDigest(input)
    )
  })
})
