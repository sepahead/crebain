import { copyPlainData } from '../lib/copyPlainData'

function encode(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite exact JSON number')
    return Object.is(value, -0) ? '-0.0' : String(value)
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`)
      .join(',')}}`
  throw new Error('Value is outside exact JSON')
}

/**
 * Use the audited bounded copier before encoding JSON numeric tokens.
 * The copier's Proxy and descriptor-allocation limits also apply here.
 */
export function exactJson(value: unknown): string {
  return encode(copyPlainData(value))
}
