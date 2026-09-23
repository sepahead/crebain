import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { familyFailureLine, reportFamilyFailure } from './family-failure'

function decoded(primary: unknown) {
  const bytes = familyFailureLine(primary)
  expect(bytes.length).toBeLessThanOrEqual(4096)
  expect(bytes.toString('ascii')).toBe(bytes.toString('utf8'))
  const prefix = 'CREBAIN_FAMILY_FAILURE_V1 '
  expect(bytes.subarray(0, prefix.length).toString()).toBe(prefix)
  const record = JSON.parse(bytes.subarray(prefix.length).toString())
  expect(record.schema).toBe('crebain.family-failure.v1')
  expect(record.authority).toBe('advisory-only')
  return record
}

test('advisory summary keeps the primary and cleanup as separate aggregate members', () => {
  const primary = new Error('primary operation failed')
  const cleanup = new Error('separate cleanup failed')
  const failure = new AggregateError([primary, cleanup], 'operation and cleanup failed', {
    cause: cleanup,
  })
  const record = decoded(failure)
  expect(record.nodes.map((node: { message: string }) => node.message)).toEqual([
    'operation and cleanup failed',
    'primary operation failed',
    'separate cleanup failed',
  ])
  expect(record.edges).toEqual([
    { from: 0, to: 1, relation: 'aggregate', index: 0 },
    { from: 0, to: 2, relation: 'aggregate', index: 1 },
    { from: 0, to: 2, relation: 'cause', index: null },
  ])
  expect(record.truncated).toBe(false)
  expect(failure.errors[0]).toBe(primary)
  expect(failure.errors[1]).toBe(cleanup)
})

test('own data inspection rejects getters, hostile proxy traps, and coercion hooks', () => {
  let calls = 0
  const hostile = new Error()
  for (const field of ['message', 'errors', 'cause', 'name'])
    Object.defineProperty(hostile, field, {
      get() {
        calls++
        throw new Error('getter must remain uncalled')
      },
    })
  hostile.toString = () => {
    calls++
    throw new Error('coercion must remain uncalled')
  }
  expect(decoded(hostile).nodes[0].inspection_failed).toBe(true)
  expect(calls).toBe(0)
  const proxy = new Proxy(hostile, {
    getOwnPropertyDescriptor() {
      throw new Error('descriptor trap')
    },
  })
  expect(decoded(proxy).nodes[0].inspection_failed).toBe(true)
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  expect(decoded(revoked.proxy).nodes[0].inspection_failed).toBe(true)
  const errors = Proxy.revocable([], {})
  errors.revoke()
  expect(decoded({ errors: errors.proxy }).nodes[0].inspection_failed).toBe(true)
  expect(calls).toBe(0)
})

test('cycles, nested shared causes, sparse rosters, and messages share finite budgets', () => {
  const cycle = new Error('cycle')
  Object.defineProperty(cycle, 'cause', { value: cycle })
  expect(decoded(cycle).edges).toEqual([{ from: 0, to: 0, relation: 'cause', index: null }])
  let nested: Error = new Error('"\\\n🙂'.repeat(1000))
  for (let depth = 0; depth < 20; depth++)
    nested = new AggregateError([nested, nested], 'level', { cause: nested })
  const record = decoded(nested)
  expect(record.nodes.length).toBeLessThanOrEqual(8)
  expect(record.edges.length).toBeLessThanOrEqual(8)
  expect(record.truncated).toBe(true)
  for (const edge of record.edges) {
    expect(edge.from).toBeLessThan(record.nodes.length)
    if (edge.to !== null) expect(edge.to).toBeLessThan(record.nodes.length)
  }
  const paired = decoded(new AggregateError([nested, new Error('cleanup stays separate')]))
  expect(paired.nodes[paired.edges[1].to].message).toBe('cleanup stays separate')
  expect(paired.edges[1]).toEqual({ from: 0, to: 2, relation: 'aggregate', index: 1 })
  const wide = decoded(
    new AggregateError(Array.from({ length: 16 }, () => new Error('"\\'.repeat(1000))))
  )
  expect(wide.nodes.length).toBe(8)
  expect(wide.edges.length).toBe(8)
  expect(wide.truncated).toBe(true)
  expect(wide.nodes[1].message.length).toBe(128)
  expect(wide.nodes[1].message_truncated).toBe(true)
  expect(decoded({ errors: new Array(0xffffffff) }).truncated).toBe(true)
  for (const value of [null, undefined, true, NaN, 1n, Symbol('advisory'), 'message'])
    expect(decoded(value).nodes.length).toBe(1)
})

test('failed or stalled diagnostic writes cannot replace the original failure', async () => {
  const primary = new Error('retained primary')
  let originalLine: Buffer | undefined
  expect(
    await reportFamilyFailure(primary, (line, done) => {
      originalLine = line
      done()
    })
  ).toBe(true)
  expect(originalLine).toEqual(familyFailureLine(primary))
  expect(
    await reportFamilyFailure(primary, () => {
      throw new Error('write throws')
    })
  ).toBe(false)
  expect(await reportFamilyFailure(primary, (_, done) => done(new Error('write fails')))).toBe(
    false
  )
  const started = performance.now()
  expect(await reportFamilyFailure(primary, () => {})).toBe(false)
  expect(performance.now() - started).toBeLessThan(3000)
  expect(primary.message).toBe('retained primary')
})

test('actual production catch retains distinct primary and cleanup failures without native work', async () => {
  const generation = randomUUID()
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./family-failure.test-support.ts', import.meta.url)),
      '--node',
      process.execPath,
      '--generation',
      generation,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const payload = Buffer.from(
      JSON.stringify({
        schema: 'crebain.family-engine-request.v1',
        generation,
        sequence: 1,
        command: { kind: 'retire' },
      })
    )
    const header = Buffer.alloc(4)
    header.writeUInt32BE(payload.length)
    child.stdin.write(Buffer.concat([header, payload]))
    await child.stdin.flush()
    const status = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('production catch child deadline')), 5000)
      }),
    ])
    expect(status).toBe(1)
    expect(await new Response(child.stdout).text()).toBe('')
    const stderr = await new Response(child.stderr).text()
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(4096)
    const record = JSON.parse(stderr.slice('CREBAIN_FAMILY_FAILURE_V1 '.length))
    expect(record.authority).toBe('advisory-only')
    expect(record.nodes.map((node: { message: string }) => node.message)).toEqual([
      'Family operation and cleanup failed',
      'synthetic primary operation failure',
      'synthetic separate cleanup failure',
    ])
    expect(record.edges.slice(0, 2)).toEqual([
      { from: 0, to: 1, relation: 'aggregate', index: 0 },
      { from: 0, to: 2, relation: 'aggregate', index: 1 },
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
    child.stdin.end()
  }
})
