import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  CityEnvironmentError,
  type CityEnvironmentFailure,
} from '../../../src/environment/ForceCityEnvironment'
import { cityFailureLine, reportCityFailure } from './failure'

function decoded(primary: unknown, retirement: unknown[] = []) {
  const line = cityFailureLine(primary, retirement)
  expect(line.length).toBeLessThanOrEqual(4096)
  expect(line.toString('ascii')).toBe(line.toString('utf8'))
  const prefix = 'CREBAIN_CITY_FAILURE_V1 '
  expect(line.subarray(0, prefix.length).toString()).toBe(prefix)
  const value = JSON.parse(line.subarray(prefix.length).toString())
  expect(value.schema).toBe('crebain.city-failure.v1')
  expect(value.authority).toBe('advisory-only')
  return value
}
const outcome: CityEnvironmentFailure = {
  stage: 'source',
  executedTick: 1,
  componentCleanup: 'unresolved',
  processRetirement: 'outside_component_scope',
  completeObservation: false,
  primaryFailure: 'primary',
  secondaryFailures: [],
  cleanupFailures: [],
}

test('native primary and both sidecars retain distinct causes within finite graph capacity', () => {
  const primary = new Error('original source failure')
  const cleanup = new Error('original cleanup failure')
  const secondary = new Error('original secondary failure')
  const failure = new CityEnvironmentError(outcome, null, primary, [cleanup], [secondary])
  const record = decoded(failure, [cleanup])
  const messages = record.nodes.map((node: { message: string }) => node.message)
  for (const error of [primary, cleanup, secondary]) expect(messages).toContain(error.message)
  expect(failure.cause).toBe(primary)
  expect(failure.cleanupErrors[0]).toBe(cleanup)
  expect(record.nodes.length).toBeLessThanOrEqual(8)
  expect(record.edges.length).toBeLessThanOrEqual(8)
})

test('unavailable sidecars, huge rosters, cycles and primitive throws remain bounded', () => {
  const primary = new Error('primary')
  let getters = 0
  Object.defineProperty(primary, 'cleanupErrors', {
    get() {
      getters++
      throw new Error('not called')
    },
  })
  Object.defineProperty(primary, 'secondaryErrors', { value: new Array(0xffffffff) })
  Object.defineProperty(primary, 'cause', { value: primary })
  const record = decoded(primary, [undefined])
  expect(getters).toBe(0)
  expect(record.truncated).toBe(true)
  expect(record.nodes.some((node: { inspection_failed: boolean }) => node.inspection_failed)).toBe(
    true
  )
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  expect(decoded(revoked.proxy).nodes.length).toBeLessThanOrEqual(8)
  for (const value of [undefined, null, true, 1n, Symbol('failure')])
    expect(decoded(value).nodes.length).toBe(2)
})

test('successful, failed and stalled advisory delivery preserve the original object', async () => {
  const primary = new Error('source failure')
  let written: Buffer | undefined
  expect(
    await reportCityFailure(primary, [], (line, done) => {
      written = line
      done()
    })
  ).toBe(true)
  expect(written).toEqual(cityFailureLine(primary))
  expect(
    await reportCityFailure(primary, [], () => {
      throw new Error('diagnostic write failed')
    })
  ).toBe(false)
  expect(
    await reportCityFailure(primary, [], (_, done) => done(new Error('write callback failed')))
  ).toBe(false)
  const start = performance.now()
  expect(await reportCityFailure(primary, [], () => {})).toBe(false)
  expect(performance.now() - start).toBeLessThan(3000)
  expect(primary.message).toBe('source failure')
})

test('actual production catch keeps original source, nested cleanup and final cleanup', async () => {
  const generation = randomUUID()
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('./failure.test-support.ts', import.meta.url)),
      '--generation',
      generation,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 'crebain.city-engine-request.v1',
        generation,
        sequence: 1,
        command: { kind: 'retire' },
      })
    )
    const header = Buffer.alloc(4)
    header.writeUInt32BE(bytes.length)
    child.stdin.write(Buffer.concat([header, bytes]))
    await child.stdin.flush()
    expect(
      await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('production catch deadline')), 3000)
        }),
      ])
    ).toBe(1)
    expect(await new Response(child.stdout).text()).toBe('')
    const stderr = await new Response(child.stderr).text()
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(4096)
    const value = JSON.parse(stderr.slice('CREBAIN_CITY_FAILURE_V1 '.length))
    expect(value.authority).toBe('advisory-only')
    const messages = value.nodes.map((node: { message: string }) => node.message)
    for (const message of [
      'synthetic primary operation',
      'synthetic nested cleanup',
      'synthetic final cleanup',
    ])
      expect(messages).toContain(message)
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
    child.stdin.end()
  }
})
