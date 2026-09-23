import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { decodeFrame, encodeFamilyFrame, unwrapFloats } from './codec'
import { binding, neutral } from './family-fixtures.test-support'
import { withinFamilyDeadline } from './family-stdio'

function selected() {
  return {
    schema: 'crebain.family-engine-response.v1',
    generation: randomUUID(),
    sequence: 1,
    body: {
      kind: 'selected',
      result: {
        kind: 'decision_committed',
        checkpoint: {
          family_id: randomUUID(),
          checkpoint_token: randomUUID(),
          parent_binding: binding(),
          parent_native_owner_id: randomUUID(),
          tick: 3,
          checkpoint_sha256: 'a'.repeat(64),
        },
        forecast_commitment_digest: 'b'.repeat(64),
        selected_case_id: 'case-1',
        selected_target: { ...neutral, roll_rad: -0 },
      },
    },
  }
}

test('closed family response preserves negative zero and integral binary64 fields', () => {
  const value = selected()
  const bytes = encodeFamilyFrame(value)
  const wire = JSON.parse(bytes.toString())
  expect(wire.sequence).toBe(1)
  expect(wire.body.result.selected_target.roll_rad).toEqual({ f64: '8000000000000000' })
  expect(wire.body.result.selected_target.altitude_m).toEqual({ f64: '4020000000000000' })
  expect(unwrapFloats(wire)).toEqual(value)
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const changed = selected()
    changed.body.result.selected_target.roll_rad = invalid
    expect(() => encodeFamilyFrame(changed)).toThrow()
  }
  expect(() => encodeFamilyFrame({ ...value, extra: true })).toThrow()
  expect(() => encodeFamilyFrame({ ...value, sequence: -0 })).toThrow()
})

test('family request parser admits one canonical closed frame and rejects alternate bytes', () => {
  const value = {
    schema: 'crebain.family-engine-request.v1',
    generation: randomUUID(),
    sequence: 1,
    command: { kind: 'retire' },
  }
  const raw = JSON.stringify(value)
  expect(decodeFrame(Buffer.from(raw), 'familyBridge')).toEqual(value)
  for (const bytes of [
    Buffer.from(' ' + raw),
    Buffer.from(raw.replace('"sequence":1', '"sequence":1,"sequence":1')),
    Buffer.from(raw.replace('"sequence":1', '"sequence":1.0')),
    Buffer.from(raw.replace('"sequence":1', '"sequence":-0')),
    Buffer.from(JSON.stringify({ ...value, command: { kind: 'import_checkpoint', bytes: '{}' } })),
    Buffer.from(JSON.stringify({ ...value, unknown: null })),
    Buffer.from([0xff]),
    Buffer.alloc(65537),
  ]) {
    expect(() => decodeFrame(bytes, 'familyBridge')).toThrow()
  }
})

test('expired or nonfinite family deadlines cannot start an operation', async () => {
  let calls = 0
  const operation = async () => ++calls
  for (const expires of [performance.now() - 1, NaN, Infinity, -Infinity])
    await expect(withinFamilyDeadline(operation, expires)).rejects.toThrow(
      'Private family deadline'
    )
  expect(calls).toBe(0)
  expect(await withinFamilyDeadline(operation, performance.now() + 1000)).toBe(1)
  expect(calls).toBe(1)
})

test('one fixed family deadline rejects a pending operation without replacing its error', async () => {
  let calls = 0
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  try {
    await expect(
      withinFamilyDeadline(() => {
        calls++
        return pending
      }, performance.now() + 10)
    ).rejects.toThrow('Private family deadline')
    expect(calls).toBe(1)
  } finally {
    finish!()
  }
  const original = new Error('operation failed')
  try {
    await withinFamilyDeadline(async () => {
      throw original
    }, performance.now() + 1000)
    throw new Error('failure was accepted')
  } catch (error) {
    expect(error).toBe(original)
  }
})
