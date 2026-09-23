import { readFileSync } from 'node:fs'
import { sha256 } from './codec'

const target = JSON.parse(
  readFileSync(
    new URL('../contracts/pressure-window-rms.semantic.v1.json', import.meta.url),
    'utf8'
  )
) as unknown

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** SHA-256 of the installed target's sorted-key compact UTF-8 JSON; not an authority token. */
export const PRESSURE_TARGET_DIGEST = sha256(canonical(target))
export const PRESSURE_WINDOW_SAMPLES = 400
export const PRESSURE_WINDOW_BYTES = PRESSURE_WINDOW_SAMPLES * 8

/** Ordered binary64 Neumaier RMS over the exact original little-endian pressure bytes. */
export function pressureWindowRms(bytes: Uint8Array): number {
  if (bytes.byteLength !== PRESSURE_WINDOW_BYTES) throw new Error('Pressure window extent')
  const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let maximum = 0
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    const value = values.getFloat64(offset, true)
    if (!Number.isFinite(value)) throw new Error('Nonfinite pressure sample')
    maximum = Math.max(maximum, Math.abs(value))
  }
  if (maximum === 0) return 0
  let sum = 0
  let correction = 0
  for (let offset = 0; offset < bytes.byteLength; offset += 8) {
    const scaled = values.getFloat64(offset, true) / maximum
    const value = scaled * scaled
    const next = sum + value
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum
    sum = next
    if (!Number.isFinite(correction) || !Number.isFinite(sum))
      throw new Error('Nonfinite pressure accumulation')
  }
  const combined = sum + correction
  const average = combined / PRESSURE_WINDOW_SAMPLES
  const root = Math.sqrt(average)
  const result = maximum * root
  if (![combined, average, root, result].every(Number.isFinite) || result < 0)
    throw new Error('Nonfinite pressure target')
  return result
}
