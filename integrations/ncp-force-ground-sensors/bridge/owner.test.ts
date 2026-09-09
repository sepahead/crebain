import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SensorBridge, type LeaseOwner } from './owner'
import { decodeFrame, object, payloadBytes, sha256, unwrapFloats, validateFrozen } from './codec'
import { exactJson } from '../../../src/environment/ExactJson'
import type { EnvironmentPlan } from '../../../src/environment/EnvironmentState'
import type { ObservationHandle } from '../../../src/environment/EnvironmentOwner'
import { graphicsInputDigest } from '../../../src/environment/GraphicsContract'
import {
  MAX_RUNTIME_RECEIPT_BYTES,
  publishPreparedRuntime,
  RUNTIME_RECEIPT_PREFIX,
  type PreparedGraphics,
} from './runtime-receipt'

const workload = JSON.parse(
  readFileSync(new URL('../contracts/m1.workload.v1.json', import.meta.url), 'utf8')
) as { specification: Record<string, unknown> }
const schema = JSON.parse(
  readFileSync(new URL('../contracts/application.schema.v1.json', import.meta.url), 'utf8')
) as { $defs: Record<string, Record<string, unknown>> }
const generation = '33333333-3333-4333-8333-333333333333'
const ownerId = '44444444-4444-4444-8444-444444444444'
function wrapped(value: unknown, rule: Record<string, unknown>): unknown {
  if (typeof rule.$ref === 'string')
    return wrapped(value, schema.$defs[rule.$ref.split('/').at(-1) as string])
  if (rule.type === 'number') {
    const bytes = Buffer.alloc(8)
    bytes.writeDoubleBE(Number(value))
    return { f64: bytes.toString('hex') }
  }
  if (Array.isArray(value))
    return value.map((item) => wrapped(item, rule.items as Record<string, unknown>))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        wrapped(item, (rule.properties as Record<string, Record<string, unknown>>)[key]),
      ])
    )
  return value
}
function preparation(): Record<string, unknown> {
  return {
    kind: 'prepare',
    run_id: '11111111-1111-4111-8111-111111111111',
    source_identity: 'a'.repeat(64),
    specification: wrapped(workload.specification, schema.$defs.Specification),
    planned_ticks: 24,
  }
}
function framed(command: unknown, sequence = 1): Buffer {
  return Buffer.from(
    JSON.stringify({ schema: 'crebain.sensor-engine-request.v1', generation, sequence, command })
  )
}
function advance(tick: number, previous: string | null = null): Record<string, unknown> {
  return {
    kind: 'advance',
    tick,
    previous_engine_batch_sha256: previous,
    accepted_action_request_digest: 'c'.repeat(64),
    action:
      tick === 1
        ? {
            kind: 'set_target',
            armed: true,
            roll_rad: { f64: '8000000000000000' },
            pitch_rad: { f64: '0000000000000000' },
            heading_rad: { f64: '0000000000000000' },
            altitude_m: { f64: '4020000000000000' },
          }
        : { kind: 'hold', accepted_action_request_digest: 'c'.repeat(64) },
  }
}

class SyntheticOwner implements LeaseOwner {
  readonly ownerId = ownerId
  ticks = 0
  releases = 0
  retires = 0
  failRetire = false
  failRelease = false
  previous: string | null = null
  lease: ObservationHandle | null = null
  serialized = ''
  scheduled: unknown[] = []
  constructor(readonly plan: EnvironmentPlan) {}
  schedule(action: unknown): void {
    this.scheduled.push(action)
  }
  async advance(): Promise<ObservationHandle> {
    if (this.lease) throw new Error('Synthetic live lease')
    const tick = ++this.ticks
    const start = Math.floor(((tick - 1) * 16000) / 120),
      end = Math.floor((tick * 16000) / 120)
    const pressure = Buffer.alloc((end - start) * 8)
    for (let i = 0; i < pressure.length; i += 8) pressure.writeDoubleLE(-0, i)
    const payload = {
      profile: 'crebain.force-ground-observation.v1',
      environmentProfile: this.plan.profile,
      planSha256: sha256(exactJson(this.plan)),
      privilegedControl: { json: 'PRIVATE-CONTROL' },
      ownerId,
      ancestry: null,
      sourceIdentity: this.plan.sourceIdentity,
      sceneSha256: sha256(exactJson(this.plan.scene)),
      tick,
      time: { numerator: tick, denominator: 120, unit: 'second' },
      previousBatchSha256: this.previous,
      privilegedReference: { json: 'PRIVATE-COUNTERFACTUAL' },
      pressure: {
        sampleStart: start,
        sampleEnd: end,
        sampleRateHz: 16000,
        unit: 'pascal',
        channels: this.plan.scene.microphones.map((m) => ({
          microphoneId: m.id,
          encoding: 'float64-le',
          bytesBase64: pressure.toString('base64'),
        })),
      },
      graphics: {
        generation,
        planSha256: 'd'.repeat(64),
        inputSha256: 'e'.repeat(64),
        tick,
        rowOrigin: 'bottom-left',
        rgb: this.plan.scene.rgbCameras
          .filter((c) => tick % c.periodTicks === 0)
          .map((c) => ({
            cameraId: c.id,
            width: c.width,
            height: c.height,
            encoding: 'rgba8-srgb',
            bytesBase64: Buffer.alloc(c.width * c.height * 4).toString('base64'),
          })),
        thermal: this.plan.scene.thermalCameras
          .filter((c) => tick % c.periodTicks === 0)
          .map((c) => ({
            cameraId: c.id,
            width: c.width,
            height: c.height,
            encoding: 'float32-le',
            unit: 'W/(m2 sr)',
            bytesBase64: Buffer.alloc(c.width * c.height * 4).toString('base64'),
          })),
      },
    }
    this.serialized = JSON.stringify(payload)
    this.lease = Object.freeze({ ownerId, tick, sha256: sha256(this.serialized) })
    this.previous = this.lease.sha256
    return this.lease
  }
  readObservation(handle: ObservationHandle): string {
    if (handle !== this.lease) throw new Error('Synthetic lease identity')
    return this.serialized
  }
  releaseObservation(handle: ObservationHandle): void {
    if (this.failRelease || handle !== this.lease) throw new Error('Synthetic release failure')
    this.releases++
    this.lease = null
  }
  async retire(): Promise<void> {
    this.retires++
    if (this.failRetire) throw new Error('Synthetic retirement failure')
    this.lease = null
  }
}

describe('closed private grammar, synthetic controls only', () => {
  test('bounded prepare and exact negative-zero word pass; malformed alternatives reject', () => {
    const input = framed(preparation())
    expect(decodeFrame(input).sequence).toBe(1)
    expect(Object.is(unwrapFloats({ f64: '8000000000000000' }), -0)).toBe(true)
    expect(() => unwrapFloats({ f64: '7ff0000000000000' })).toThrow()
    expect(() =>
      decodeFrame(
        Buffer.from(input.toString().replace('"sequence":1', '"sequence":1,"sequence":1'))
      )
    ).toThrow()
    expect(() =>
      decodeFrame(Buffer.from(input.toString().replace('"sequence":1', '"sequence":1.0')))
    ).toThrow()
    expect(() => decodeFrame(Buffer.concat([Buffer.from(' '), input]))).toThrow()
    expect(() => decodeFrame(Buffer.alloc(65537))).toThrow()
    expect(() => decodeFrame(framed({ ...preparation(), executable: '/forbidden' }))).toThrow()
    const integerWrapper = preparation()
    object(integerWrapper.specification).seed = { f64: '0000000000000000' }
    expect(() => decodeFrame(framed(integerWrapper))).toThrow()
    const rawContinuous = preparation()
    object(object(rawContinuous.specification).controller).referenceAltitudeM = 8
    expect(() => decodeFrame(framed(rawContinuous))).toThrow()
  })
  test('finite little-endian payloads preserve zero sign and reject bad extents', () => {
    const zero = Buffer.alloc(8)
    zero.writeDoubleLE(-0)
    expect(payloadBytes(zero.toString('base64'), 8, 'pressure')).toEqual(zero)
    const nan = Buffer.alloc(8)
    nan.writeDoubleLE(NaN)
    expect(() => payloadBytes(nan.toString('base64'), 8, 'pressure')).toThrow()
    expect(() => payloadBytes(zero.toString('base64').replace(/=$/, ''), 8, 'pressure')).toThrow()
  })
})

describe('retained native projection, synthetic engine only', () => {
  test('M1 due schedule, original bytes, private exclusion and explicit native lease release', async () => {
    let native: SyntheticOwner | undefined
    const bridge = new SensorBridge(async (plan) => {
      native = new SyntheticOwner(plan)
      return native
    })
    const prepared = await bridge.command(object(decodeFrame(framed(preparation())).command))
    validateFrozen('Response', {
      schema: 'crebain.sensor-engine-response.v1',
      generation,
      sequence: 1,
      body: prepared,
    })
    let previous: string | null = null
    let total = 0,
      chunks = 0,
      pressureSamples = 0,
      rgb = 0,
      thermal = 0
    for (let tick = 1; tick <= 24; tick++) {
      const response = object(await bridge.command(advance(tick, previous)))
      expect(JSON.stringify(response)).not.toContain('PRIVATE')
      const batch = object(response.batch)
      const digest = String(batch.engine_batch_sha256)
      expect(native?.lease?.sha256).toBe(digest)
      await expect(bridge.command(advance(tick + 1, digest))).rejects.toThrow()
      for (const payload of batch.payloads as Array<{
        sensor_id: string
        kind: string
        byte_length: number
        payload_sha256: string
      }>) {
        const parts: Buffer[] = []
        for (let offset = 0; offset < payload.byte_length; offset += 32768) {
          const count = Math.min(32768, payload.byte_length - offset)
          const result = object(
            await bridge.command({
              kind: 'read_chunk',
              tick,
              engine_batch_sha256: digest,
              sensor_id: payload.sensor_id,
              offset,
              max_bytes: count,
            })
          )
          const bytes = Buffer.from(String(result.bytes_base64), 'base64')
          expect(bytes.length).toBe(count)
          expect(sha256(bytes)).toBe(String(result.chunk_sha256))
          parts.push(bytes)
          chunks++
        }
        const bytes = Buffer.concat(parts)
        expect(sha256(bytes)).toBe(payload.payload_sha256)
        if (payload.kind === 'pressure') {
          pressureSamples += bytes.length / 8
          expect(Object.is(bytes.readDoubleLE(), -0)).toBe(true)
        } else if (payload.kind === 'rgba8') rgb++
        else thermal++
        total += bytes.length
      }
      await expect(
        bridge.command({ kind: 'release_lease', tick, engine_batch_sha256: 'f'.repeat(64) })
      ).rejects.toThrow()
      await bridge.command({ kind: 'release_lease', tick, engine_batch_sha256: digest })
      await expect(
        bridge.command({ kind: 'release_lease', tick, engine_batch_sha256: digest })
      ).rejects.toThrow()
      previous = digest
    }
    expect([rgb, thermal, pressureSamples, total, chunks]).toEqual([12, 8, 3200, 4326400, 168])
    expect(native?.ticks).toBe(24)
    expect(native?.releases).toBe(24)
    expect(await bridge.retire()).toBe(true)
  })
  test('retirement joins pending preparation and rejects its late success', async () => {
    let resolve: ((owner: LeaseOwner) => void) | undefined
    let native: SyntheticOwner | undefined
    const bridge = new SensorBridge((plan) => {
      native = new SyntheticOwner(plan)
      return new Promise<LeaseOwner>((done) => {
        resolve = done
      })
    })
    const preparing = bridge.command(object(decodeFrame(framed(preparation())).command))
    const rejected = preparing.then(
      () => null,
      (error: unknown) => error
    )
    let confirmed = false
    const retirement = bridge.retire().then((value) => {
      confirmed = value
      return value
    })
    await Promise.resolve()
    expect(confirmed).toBe(false)
    if (!native || !resolve) throw new Error('Synthetic preparation setup')
    resolve(native)
    expect(await rejected).toBeInstanceOf(Error)
    expect(await retirement).toBe(true)
    expect(native.retires).toBe(1)
  })
  test('failed cleanup remains failed on repeated retirement', async () => {
    const bridge = new SensorBridge(async (plan) => {
      const owner = new SyntheticOwner(plan)
      owner.failRetire = true
      return owner
    })
    await bridge.command(object(decodeFrame(framed(preparation())).command))
    expect(await bridge.retire()).toBe(false)
    expect(await bridge.retire()).toBe(false)
    await expect(bridge.command(advance(1))).rejects.toThrow('Retired bridge')
  })
})

function syntheticRuntime(): Record<string, unknown> {
  return {
    generation,
    pid: 101,
    browserVersion: '151.0.7922.34',
    planSha256: 'd'.repeat(64),
    graphics: {
      version: 'Synthetic WebGL 2.0',
      renderer: 'Synthetic renderer',
      vendor: 'Synthetic vendor',
    },
    distributionScope: 'development-component',
    workerPid: 102,
    workerRuntime: { name: 'node', version: '26.7.0', executable: '/selected/bin/node' },
  }
}
function runtimeSource(diagnostics: unknown = syntheticRuntime()): PreparedGraphics {
  return {
    sourceIdentity: 'a'.repeat(64),
    planSha256: 'd'.repeat(64),
    diagnostics: () => diagnostics,
  }
}
const syntheticPrepared = {
  kind: 'prepared',
  engine_owner_id: ownerId,
  scene_sha256: 'b'.repeat(64),
}

describe('private browser-reported runtime receipt', () => {
  test('Node worker metadata follows the actual closed diagnostic shape', () => {
    const worker = { name: 'node', version: '26.7.0', executable: '/selected/bin/node' }
    const diagnostic = { ...syntheticRuntime(), workerRuntime: worker }
    expect(() => validateFrozen('Diagnostics', diagnostic, 'runtime')).not.toThrow()
    for (const executable of ['/another installation/node', '/' + 'x'.repeat(4095)])
      expect(() =>
        validateFrozen(
          'Diagnostics',
          { ...diagnostic, workerRuntime: { ...worker, executable } },
          'runtime'
        )
      ).not.toThrow()
    const malformed: unknown[] = [null, {}, { ...worker, extra: true }]
    for (const name of Object.keys(worker)) {
      const incomplete: Record<string, unknown> = { ...worker }
      delete incomplete[name]
      malformed.push(incomplete)
    }
    malformed.push({ ...worker, name: 'bun' })
    for (const version of ['', '26', '26.7', '26.7.0\n', 'v26.7.0', '1'.repeat(65)])
      malformed.push({ ...worker, version })
    for (const executable of [
      '',
      'relative/node',
      '/',
      '/bad\nnode',
      '/é/node',
      '/' + 'x'.repeat(4096),
    ])
      malformed.push({ ...worker, executable })
    for (const workerRuntime of malformed)
      expect(() =>
        validateFrozen('Diagnostics', { ...diagnostic, workerRuntime }, 'runtime')
      ).toThrow()
  })

  test('complete receipt writes once before prepared and retains closed joins', async () => {
    const events: string[] = []
    await publishPreparedRuntime(
      object(JSON.parse(framed(preparation()).toString())),
      syntheticPrepared,
      runtimeSource(),
      async (line) => {
        expect(line.length).toBeLessThanOrEqual(MAX_RUNTIME_RECEIPT_BYTES)
        expect(line.toString().endsWith('\n')).toBe(true)
        expect(line.toString().startsWith(RUNTIME_RECEIPT_PREFIX)).toBe(true)
        const receipt = object(JSON.parse(line.toString().slice(RUNTIME_RECEIPT_PREFIX.length)))
        validateFrozen('Receipt', receipt, 'runtime')
        expect(receipt.generation).toBe(generation)
        expect(receipt.run_id).toBe(preparation().run_id)
        expect(receipt.source_identity).toBe('a'.repeat(64))
        expect(receipt.engine_owner_id).toBe(ownerId)
        expect(receipt.scene_sha256).toBe('b'.repeat(64))
        expect(object(receipt.graphics).plan_sha256).toBe('d'.repeat(64))
        events.push('written')
      },
      async (body) => {
        expect(body).toBe(syntheticPrepared)
        events.push('prepared')
      }
    )
    expect(events).toEqual(['written', 'prepared'])
  })

  test('missing malformed unavailable and wrong-join diagnostics cannot publish', async () => {
    const malformed: unknown[] = [undefined, null, {}, { ...syntheticRuntime(), extra: true }]
    for (const name of Object.keys(syntheticRuntime())) {
      const value = syntheticRuntime()
      delete value[name]
      malformed.push(value)
    }
    for (const value of [0, -0, -1, 1.5, 2147483648, true])
      malformed.push({ ...syntheticRuntime(), pid: value })
    malformed.push({ ...syntheticRuntime(), pid: 102 })
    malformed.push({ ...syntheticRuntime(), generation: 'wrong' })
    malformed.push({ ...syntheticRuntime(), planSha256: 'e'.repeat(64) })
    malformed.push({ ...syntheticRuntime(), distributionScope: 'installed' })
    for (const value of ['', 'x'.repeat(257), 'unavailable', 'bad\nline', 'é']) {
      malformed.push({ ...syntheticRuntime(), browserVersion: value })
      for (const field of ['version', 'renderer', 'vendor'])
        malformed.push({
          ...syntheticRuntime(),
          graphics: { ...object(syntheticRuntime().graphics), [field]: value },
        })
    }
    malformed.push({
      ...syntheticRuntime(),
      graphics: { ...object(syntheticRuntime().graphics), extra: 'field' },
    })
    for (const diagnostics of malformed) {
      let writes = 0,
        publications = 0
      const selected = diagnostics === undefined ? undefined : runtimeSource(diagnostics)
      await expect(
        publishPreparedRuntime(
          object(JSON.parse(framed(preparation()).toString())),
          syntheticPrepared,
          selected,
          async () => {
            writes++
          },
          async () => {
            publications++
          }
        )
      ).rejects.toThrow()
      expect(writes).toBe(0)
      expect(publications).toBe(0)
    }
    for (const request of [
      object(JSON.parse(framed(preparation(), 2).toString())),
      object(JSON.parse(framed({ ...preparation(), source_identity: 'b'.repeat(64) }).toString())),
      object(JSON.parse(framed({ ...preparation(), run_id: 'wrong' }).toString())),
    ]) {
      let publications = 0
      await expect(
        publishPreparedRuntime(
          request,
          syntheticPrepared,
          runtimeSource(),
          async () => {},
          async () => {
            publications++
          }
        )
      ).rejects.toThrow()
      expect(publications).toBe(0)
    }
    const diagnostic = syntheticRuntime()
    diagnostic.browserVersion = 'x'.repeat(256)
    diagnostic.graphics = {
      version: 'x'.repeat(256),
      renderer: 'x'.repeat(256),
      vendor: 'x'.repeat(256),
    }
    let publications = 0
    await publishPreparedRuntime(
      object(JSON.parse(framed(preparation()).toString())),
      syntheticPrepared,
      runtimeSource(diagnostic),
      async () => {},
      async () => {
        publications++
      }
    )
    expect(publications).toBe(1)
  })

  test('failed receipt writes never publish prepared; a fresh completed write does', async () => {
    const request = object(JSON.parse(framed(preparation()).toString()))
    let publications = 0
    await expect(
      publishPreparedRuntime(
        request,
        syntheticPrepared,
        runtimeSource(),
        async () => {
          throw new Error('Synthetic closed stderr')
        },
        async () => {
          publications++
        }
      )
    ).rejects.toThrow('Synthetic closed stderr')
    expect(publications).toBe(0)
    let complete: (() => void) | undefined
    const pending = publishPreparedRuntime(
      request,
      syntheticPrepared,
      runtimeSource(),
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
      async () => {
        publications++
      }
    )
    await Promise.resolve()
    expect(publications).toBe(0)
    if (!complete) throw new Error('Synthetic writer did not start')
    complete()
    await pending
    expect(publications).toBe(1)
  })

  test('graphics plan joins use the existing signed-zero digest meaning', async () => {
    const negative = { coordinate: -0 },
      positive = { coordinate: 0 }
    const digest = await graphicsInputDigest(negative)
    expect(digest).not.toBe(await graphicsInputDigest(positive))
    expect(digest).not.toBe(sha256(JSON.stringify(negative)))
    const diagnostics = { ...syntheticRuntime(), planSha256: digest }
    const selected = { ...runtimeSource(diagnostics), planSha256: digest }
    let publications = 0
    await publishPreparedRuntime(
      object(JSON.parse(framed(preparation()).toString())),
      syntheticPrepared,
      selected,
      async () => {},
      async () => {
        publications++
      }
    )
    expect(publications).toBe(1)
  })
})
