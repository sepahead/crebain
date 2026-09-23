import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
type Schema = boolean | Record<string, unknown>
const definitions = (
  JSON.parse(
    readFileSync(new URL('../contracts/application.schema.v1.json', import.meta.url), 'utf8')
  ) as { $defs: Record<string, Schema> }
).$defs
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
        Object.keys(record).every((key) => Object.hasOwn(fields, key)) &&
        (schema.required as string[]).every((key) => Object.hasOwn(record, key)) &&
        Object.entries(record).every(([name, value]) =>
          matches(fields[name], value, definitions, depth + 1)
        )
      )
    }
    default:
      return false
  }
}

export function validate(name: string, value: unknown): void {
  if (!Object.hasOwn(definitions, name) || !matches(definitions[name], value, definitions))
    throw new Error('Closed city shape rejected')
}
/** Decode declared continuous fields only from binary64 wrappers. */
export function decodeTyped(name: string, input: unknown): unknown {
  const decode = (schema: Schema, value: unknown, depth = 0): unknown => {
    if (depth > 24 || typeof schema === 'boolean') throw new Error('City schema depth')
    if (typeof schema.$ref === 'string')
      return decode(definitions[schema.$ref.slice(8)], value, depth + 1)
    const arms = schema.oneOf ?? schema.anyOf
    if (Array.isArray(arms)) {
      const accepted: unknown[] = []
      for (const arm of arms as Schema[]) {
        try {
          accepted.push(decode(arm, value, depth + 1))
        } catch {
          /* Try the next closed variant. */
        }
      }
      if (accepted.length !== 1) throw new Error('City union identity')
      return accepted[0]
    }
    let result = value
    if (schema.type === 'number') {
      const encoded = keys(value, ['f64']).f64
      if (typeof encoded !== 'string' || !/^[0-9a-f]{16}$/.test(encoded))
        throw new Error('Continuous binary64 token')
      result = Buffer.from(encoded, 'hex').readDoubleBE()
    } else if (schema.type === 'object') {
      const record = object(value)
      const fields = schema.properties as Record<string, Schema>
      if (
        Object.keys(record).some((key) => !Object.hasOwn(fields, key)) ||
        (schema.required as string[]).some((key) => !Object.hasOwn(record, key))
      )
        throw new Error('Closed city object')
      result = Object.fromEntries(
        Object.entries(record).map(([key, item]) => [key, decode(fields[key], item, depth + 1)])
      )
    } else if (schema.type === 'array') {
      result = rows(value).map((item, index) =>
        decode(
          Array.isArray(schema.prefixItems)
            ? (schema.prefixItems[index] as Schema)
            : (schema.items as Schema),
          item,
          depth + 1
        )
      )
    }
    if (!matches(schema, result, definitions)) throw new Error('City field shape')
    return result
  }
  if (!Object.hasOwn(definitions, name)) throw new Error('Unknown city shape')
  return decode(definitions[name], input)
}
/** Compact canonical integer JSON, bounded before native construction. */
export function decodeFrame(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > 65536)
    throw new Error('City private frame capacity')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value: unknown = JSON.parse(text)
  const stack: Array<[unknown, number]> = [[value, 0]]
  let nodes = 0
  while (stack.length) {
    const [item, depth] = stack.pop()!
    if (++nodes > 16384 || depth > 24) throw new Error('City private parsed extent')
    if (
      typeof item === 'number' &&
      (!Number.isSafeInteger(item) || item < 0 || Object.is(item, -0))
    )
      throw new Error('City private integer token')
    if (typeof item === 'string') {
      for (let index = 0; index < item.length; index++) {
        if (item.charCodeAt(index) > 127) throw new Error('City private ASCII token')
      }
    }
    if (item && typeof item === 'object') {
      const children = Array.isArray(item) ? item : Object.values(item)
      if (children.length + stack.length + nodes > 16384)
        throw new Error('City private node capacity')
      for (const child of children) stack.push([child, depth + 1])
    }
  }
  if (JSON.stringify(value) !== text) throw new Error('City private canonical tokens')
  const request = keys(value, ['schema', 'generation', 'sequence', 'command'])
  if (
    request.schema !== 'crebain.city-engine-request.v1' ||
    typeof request.generation !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      request.generation
    ) ||
    typeof request.sequence !== 'number' ||
    request.sequence < 1
  )
    throw new Error('City private request identity')
  return request
}
