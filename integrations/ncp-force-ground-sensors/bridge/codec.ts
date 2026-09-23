import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

type Schema = boolean | Record<string, unknown>
const bridge = JSON.parse(
  readFileSync(new URL('../contracts/engine-bridge.schema.v1.json', import.meta.url), 'utf8')
) as { $defs: Record<string, Schema> }
const application = JSON.parse(
  readFileSync(new URL('../contracts/application.schema.v1.json', import.meta.url), 'utf8')
) as { $defs: Record<string, Schema> }
const runtime = JSON.parse(
  readFileSync(
    new URL('../contracts/engine-runtime-receipt.schema.v1.json', import.meta.url),
    'utf8'
  )
) as { $defs: Record<string, Schema> }
let family: { $defs: Record<string, Schema> } | undefined
let familyBridge: { $defs: Record<string, Schema> } | undefined
let familyRuntime: { $defs: Record<string, Schema> } | undefined

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object')
  return value as Record<string, unknown>
}
export function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected array')
  return value as unknown[]
}
export function keys(value: unknown, expected: string[]): Record<string, unknown> {
  const record = object(value)
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key))
  )
    throw new Error('Closed object roster changed')
  return record
}
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
function matches(
  schema: Schema,
  value: unknown,
  definitions: Record<string, Schema>,
  depth = 0
): boolean {
  if (depth > 24 || schema === false) return false
  if (schema === true) return true
  if (typeof schema.$ref === 'string') {
    const target = schema.$ref.startsWith('#/$defs/')
      ? definitions[schema.$ref.slice(8)]
      : undefined
    return target !== undefined && matches(target, value, definitions, depth + 1)
  }
  if (Object.hasOwn(schema, 'const')) return schema.const === value
  if (Array.isArray(schema.enum)) return schema.enum.includes(value)
  if (Array.isArray(schema.oneOf))
    return (
      schema.oneOf.filter((arm: Schema) => matches(arm, value, definitions, depth + 1)).length === 1
    )
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.some((arm: Schema) => matches(arm, value, definitions, depth + 1))
  switch (schema.type) {
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type !== 'integer' || (Number.isSafeInteger(value) && !Object.is(value, -0))) &&
        (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
        (typeof schema.maximum !== 'number' || value <= schema.maximum)
      )
    case 'string':
      return (
        typeof value === 'string' &&
        /^[\x20-\x7e]*$/.test(value) &&
        (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength) &&
        (typeof schema.pattern !== 'string' || new RegExp(schema.pattern).test(value))
      )
    case 'array': {
      if (
        !Array.isArray(value) ||
        value.length < Number(schema.minItems ?? 0) ||
        value.length > Number(schema.maxItems ?? 0)
      )
        return false
      if (Array.isArray(schema.prefixItems)) {
        const prefix = schema.prefixItems as Schema[]
        return (
          value.length === prefix.length &&
          value.every((item, index) => matches(prefix[index], item, definitions, depth + 1))
        )
      }
      return value.every((item) => matches(schema.items as Schema, item, definitions, depth + 1))
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const fields = schema.properties as Record<string, Schema>
      const record = value as Record<string, unknown>
      return (
        Object.keys(record).length === Object.keys(fields).length &&
        Object.entries(fields).every(
          ([name, field]) =>
            Object.hasOwn(record, name) && matches(field, record[name], definitions, depth + 1)
        )
      )
    }
    default:
      return false
  }
}

export function validateFrozen(
  name: string,
  value: unknown,
  side:
    'bridge' | 'application' | 'runtime' | 'family' | 'familyBridge' | 'familyRuntime' = 'bridge'
): void {
  if (side === 'family')
    family ??= JSON.parse(
      readFileSync(
        new URL('../contracts/family.application.schema.v1.json', import.meta.url),
        'utf8'
      )
    ) as { $defs: Record<string, Schema> }
  if (side === 'familyBridge')
    familyBridge ??= JSON.parse(
      readFileSync(
        new URL('../contracts/family.engine-bridge.schema.v1.json', import.meta.url),
        'utf8'
      )
    ) as { $defs: Record<string, Schema> }
  if (side === 'familyRuntime')
    familyRuntime ??= JSON.parse(
      readFileSync(
        new URL('../contracts/family.runtime-receipt.schema.v1.json', import.meta.url),
        'utf8'
      )
    ) as { $defs: Record<string, Schema> }
  const definitions = {
    bridge,
    application,
    runtime,
    family,
    familyBridge,
    familyRuntime,
  }[side]!.$defs
  if (!Object.hasOwn(definitions, name) || !matches(definitions[name], value, definitions))
    throw new Error('Closed installed schema rejected')
}

/** Parse only bounded compact integer JSON; continuous values use typed bit wrappers. */
export function decodeFrame(
  bytes: Uint8Array,
  side: 'bridge' | 'familyBridge' = 'bridge'
): Record<string, unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > 65536) throw new Error('Frame bound')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value: unknown = JSON.parse(text)
  const stack: Array<[unknown, number]> = [[value, 0]]
  let nodes = 0
  while (stack.length) {
    const current = stack.pop()
    if (!current) throw new Error('Internal stack')
    const [item, depth] = current
    if (++nodes > 4096 || depth > 16) throw new Error('JSON work bound')
    if (
      typeof item === 'number' &&
      (!Number.isSafeInteger(item) || item < 0 || Object.is(item, -0))
    )
      throw new Error('Integer token')
    if (item && typeof item === 'object') {
      if (Array.isArray(item)) for (const child of item) stack.push([child, depth + 1])
      else
        for (const [key, child] of Object.entries(item)) {
          if (Buffer.byteLength(key) > 128) throw new Error('Key bound')
          stack.push([child, depth + 1])
        }
    }
  }
  // Decoded duplicates, noncanonical escapes, whitespace and alternate number
  // spellings cannot reproduce the original compact string.
  if (JSON.stringify(value) !== text) throw new Error('Noncanonical bridge JSON')
  validateFrozen('Request', value, side)
  return object(value)
}

/** Encode declared continuous response fields by schema, preserving integral floats and -0. */
export function encodeFamilyFrame(value: unknown): Buffer {
  if (!familyBridge)
    familyBridge = JSON.parse(
      readFileSync(
        new URL('../contracts/family.engine-bridge.schema.v1.json', import.meta.url),
        'utf8'
      )
    ) as { $defs: Record<string, Schema> }
  const definitions = familyBridge.$defs
  const convert = (schema: Schema, input: unknown, depth = 0): unknown => {
    if (depth > 24 || typeof schema === 'boolean') throw new Error('Family response schema bound')
    if (schema.$ref === '#/$defs/Float64') {
      if (typeof input !== 'number' || !Number.isFinite(input))
        throw new Error('Family response scalar')
      const bytes = Buffer.alloc(8)
      bytes.writeDoubleBE(input)
      return { f64: bytes.toString('hex') }
    }
    if (typeof schema.$ref === 'string')
      return convert(definitions[schema.$ref.slice(8)], input, depth + 1)
    const choices = schema.oneOf ?? schema.anyOf
    if (Array.isArray(choices)) {
      const accepted: unknown[] = []
      for (const arm of choices as Schema[]) {
        try {
          accepted.push(convert(arm, input, depth + 1))
        } catch {
          /* Another closed arm may fit. */
        }
      }
      if (accepted.length !== 1) throw new Error('Family response union')
      return accepted[0]
    }
    let converted = input
    if (schema.type === 'object') {
      const fields = schema.properties as Record<string, Schema>
      const record = keys(input, Object.keys(fields))
      converted = Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          convert(field, record[name], depth + 1),
        ])
      )
    } else if (schema.type === 'array') {
      converted = rows(input).map((item, index) =>
        convert(
          Array.isArray(schema.prefixItems)
            ? (schema.prefixItems[index] as Schema)
            : (schema.items as Schema),
          item,
          depth + 1
        )
      )
    }
    if (!matches(schema, converted, definitions)) throw new Error('Family response shape')
    return converted
  }
  const encoded = convert(definitions.Response, value)
  const bytes = Buffer.from(JSON.stringify(encoded))
  if (bytes.length === 0 || bytes.length > 65536) throw new Error('Family response frame bound')
  return bytes
}

export function unwrapFloats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapFloats)
  if (value && typeof value === 'object') {
    const record = object(value)
    if (Object.hasOwn(record, 'f64')) {
      keys(record, ['f64'])
      if (typeof record.f64 !== 'string' || !/^[0-9a-f]{16}$/.test(record.f64))
        throw new Error('Binary64 token')
      const scalar = Buffer.from(record.f64, 'hex').readDoubleBE()
      if (!Number.isFinite(scalar)) throw new Error('Nonfinite binary64')
      return scalar
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, unwrapFloats(child)])
    )
  }
  return value
}

export function payloadBytes(text: unknown, count: number, kind: string): Buffer {
  if (typeof text !== 'string' || text.length !== Math.ceil(count / 3) * 4)
    throw new Error('Payload extent')
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length !== count || bytes.toString('base64') !== text)
    throw new Error('Canonical base64')
  const width = kind === 'radiance' ? 4 : kind === 'pressure' ? 8 : 1
  if (count % width !== 0) throw new Error('Payload alignment')
  if (width !== 1)
    for (let offset = 0; offset < count; offset += width) {
      const scalar = width === 4 ? bytes.readFloatLE(offset) : bytes.readDoubleLE(offset)
      if (!Number.isFinite(scalar) || (width === 4 && (scalar < 0 || scalar > 10000)))
        throw new Error('Payload scalar')
    }
  return bytes
}
