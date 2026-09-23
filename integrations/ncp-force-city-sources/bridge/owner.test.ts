import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { cityPlan } from '../../../src/environment/__tests__/CitySourceFixtures'
import {
  graphicsInputDigest,
  GraphicsSourceIntegrityError,
  type SourceGraphicsPlan,
  type SourceGraphicsInput,
  type GraphicsSourceSelection,
  type GraphicsSourceReceipt,
  type SourceGraphicsPort,
} from '../../../src/environment/GraphicsContract'
import { CityEnvironmentError } from '../../../src/environment/ForceCityEnvironment'
import { actualFactory, CityBridge, nativePlan } from './owner'
import { decodeFrame, decodeTyped, object, sha256, validate } from './codec'
import type { Prepare, SourceOutcome } from './types'

const run = '12345678-1234-4234-9234-123456789abc'
const source = 'a'.repeat(64)
type Schema = Record<string, unknown>
const definitions = (
  JSON.parse(
    readFileSync(new URL('../contracts/application.schema.v1.json', import.meta.url), 'utf8')
  ) as { $defs: Record<string, Schema> }
).$defs

/** Test-side encoder. Production Rust supplies these closed binary64 wrappers. */
function encode(name: string, input: unknown): unknown {
  const visit = (schema: Schema, value: unknown): unknown => {
    if (typeof schema.$ref === 'string') return visit(definitions[schema.$ref.slice(8)], value)
    const arms = schema.oneOf ?? schema.anyOf
    if (Array.isArray(arms)) {
      for (const arm of arms as Schema[]) {
        try {
          const encoded = visit(arm, value)
          if (typeof arm.$ref !== 'string') throw new Error('Named test variant required')
          decodeTyped(arm.$ref.slice(8), encoded)
          return encoded
        } catch {
          /* Try another closed variant. */
        }
      }
      throw new Error('Test variant rejected')
    }
    if (schema.type === 'number') {
      const bytes = Buffer.alloc(8)
      bytes.writeDoubleBE(value as number)
      return { f64: bytes.toString('hex') }
    }
    if (schema.type === 'array')
      return (value as unknown[]).map((item, index) =>
        visit(
          (schema.prefixItems as Schema[] | undefined)?.[index] ?? (schema.items as Schema),
          item
        )
      )
    if (schema.type === 'object')
      return Object.fromEntries(
        Object.entries(object(value)).map(([key, item]) => [
          key,
          visit((schema.properties as Record<string, Schema>)[key], item),
        ])
      )
    return value
  }
  validate(name, input)
  return visit(definitions[name], input)
}

function prepare(total = 3): Prepare {
  const native = cityPlan(
    3,
    total === 12
      ? { rgb: 4, thermal: 4, pressure: 4 }
      : { rgb: Math.min(total, 4), thermal: 0, pressure: 0 }
  )
  const p = {
    schema: 'crebain.force-city-prepare.v1',
    composition_digest: 'dcdb94c6c6db02e7f643d0ed89337174f321ece88c8194aa56d152589c5c67a8',
    resource_plan_digest: source,
    world: {
      profile: native.world.profile,
      engine_model: native.world.drones[0].controller.engineModel,
      frame: native.scene.frame,
      horizon_ticks: 2,
      action_budget: 4096,
      entity_ids: native.world.drones.map((row) => row.id),
      initial_positions: native.world.drones.map((row) => row.position),
      controller_references: native.world.drones.map((row) => [
        row.controller.referenceAltitudeM,
        row.controller.referenceHeadingRad,
      ]),
    },
    scene: {
      id: native.scene.id,
      materials: native.scene.materials,
      solids: native.scene.solids.map((row) => ({
        id: row.shape.id,
        center: row.shape.center,
        half_extents: row.shape.halfExtents,
        yaw: row.shape.yaw,
        friction: row.shape.friction,
        restitution: row.shape.restitution,
        material_index: 0,
      })),
    },
    sources: native.requests.map((request) => {
      const identity = {
        request_id: request.requestId,
        source_id: request.sourceId,
        entity_index: native.world.drones.findIndex((row) => row.id === request.entityId),
        scope: 'entity_requested_world_fixed',
        publication_period_ticks: request.periodTicks,
        kind: request.kind,
      }
      if (request.kind === 'pressure')
        return {
          ...identity,
          position: native.scene.microphones.find((row) => row.id === request.sceneSourceId)!
            .position,
          sample_rate_hz: 16000,
          observation_model: 'crebain.discrete-direct-acoustic.v1',
        }
      const camera = (
        request.kind === 'rgb' ? native.scene.rgbCameras : native.scene.thermalCameras
      ).find((row) => row.id === request.sceneSourceId)!
      return {
        ...identity,
        position: camera.position,
        target: camera.target,
        width: camera.width,
        height: camera.height,
        fov_degrees: camera.fovDegrees,
        rendering_mode: request.kind === 'rgb' ? 'mesh_and_authored_gaussians' : 'bolometric_mesh',
      }
    }),
    ...(native.acoustic ? { acoustic: native.acoustic } : {}),
    ...(native.thermal ? { thermal: native.thermal } : {}),
  }
  validate('Prepare', p)
  return p as Prepare
}

/** Synthetic source acquisition only. Actual Rapier and native retention still execute. */
class Graphics implements SourceGraphicsPort {
  planSha256 = ''
  plan!: SourceGraphicsPlan
  calls: Array<[number, string]> = []
  retires = 0
  fail: string | null = null
  failure: Error = new Error('selected acquisition unavailable')
  cleanupFailure: Error | null = null
  malformed = false
  launch = async (plan: SourceGraphicsPlan) => {
    this.plan = plan
    this.planSha256 = await graphicsInputDigest(plan)
    return this
  }
  async captureSourceInto(
    input: SourceGraphicsInput,
    selection: GraphicsSourceSelection,
    bytes: Uint8Array
  ): Promise<GraphicsSourceReceipt> {
    this.calls.push([input.tick, selection.cameraId])
    if (input.tick > 0 && selection.cameraId === this.fail) throw this.failure
    const camera = (
      selection.kind === 'rgb' ? this.plan.scene.rgbCameras : this.plan.scene.thermalCameras
    ).find((row) => row.id === selection.cameraId)!
    if (selection.kind === 'rgb')
      bytes.fill(input.tick + this.plan.scene.rgbCameras.indexOf(camera))
    else {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let offset = 0; offset < bytes.length; offset += 4)
        view.setFloat32(offset, 133.29733, true)
    }
    return {
      planSha256: this.planSha256,
      inputSha256: await graphicsInputDigest(input),
      tick: this.malformed && input.tick > 0 ? input.tick + 1 : input.tick,
      kind: selection.kind,
      cameraId: selection.cameraId,
      width: camera.width,
      height: camera.height,
      rowOrigin: 'bottom-left',
      encoding: selection.kind === 'rgb' ? 'rgba8-srgb' : 'float32-le',
      byteLength: bytes.length,
    }
  }
  retire() {
    this.retires++
    if (this.cleanupFailure) throw this.cleanupFailure
  }
}
const bridges: CityBridge[] = []
afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.retire()
})
async function start(p = prepare(), graphics = new Graphics()) {
  const bridge = new CityBridge(actualFactory(graphics.launch))
  bridges.push(bridge)
  const prepared = object(
    await bridge.command({
      kind: 'prepare',
      run_id: run,
      source_identity: source,
      prepare: encode('Prepare', p),
    })
  )
  const rows = p.world.entity_ids.map((_, i) => [
    i,
    'set',
    true,
    [0.02, 0.0, p.world.controller_references[i][1], p.world.controller_references[i][0]],
  ])
  const advance = {
    kind: 'advance',
    tick: 1,
    rows: rows.map((row) => encode('ControlRow', row)),
    previous_native_batch_sha256: null,
  }
  return { bridge, graphics, prepared, advance }
}

for (const count of [0, 2, 3, 4, 12])
  test(`actual world and ${count} selected source projections`, async () => {
    const p = prepare(count)
    const { bridge, prepared, advance } = await start(p)
    const mapping = nativePlan(p, run, source)
    expect(mapping.world.staticGeometry[0]).toEqual(mapping.scene.solids[0].shape)
    expect(mapping.requests.map((row) => row.entityId)).toEqual(
      p.sources.map((row) => p.world.entity_ids[row.entity_index])
    )
    const batch = object(object(await bridge.command(advance)).batch)
    expect(batch.owner_id).toBe(object(prepared.data).owner_id)
    expect(batch.source_failed).toBe(false)
    const slots = batch.slots as SourceOutcome[]
    expect(slots).toHaveLength(count)
    for (const slot of slots) {
      expect(slot.status).toBe('produced')
      if (slot.status !== 'produced') throw new Error('Produced test source required')
      const request = {
        kind: 'read_chunk',
        native_batch_sha256: batch.native_batch_sha256,
        request_id: slot.request_id,
        original_sha256: slot.original_payload_sha256,
        offset: 0,
      }
      const chunk = object(await bridge.command(request))
      const bytes = Buffer.from(chunk.bytes_base64 as string, 'base64')
      expect(sha256(bytes)).toBe(slot.original_payload_sha256)
      await expect(
        bridge.command({ ...request, original_sha256: 'b'.repeat(64) })
      ).rejects.toThrow()
    }
    await expect(bridge.command(advance)).rejects.toThrow('lineage')
    await bridge.command({ kind: 'release', native_batch_sha256: batch.native_batch_sha256 })
    await expect(
      bridge.command({ kind: 'release', native_batch_sha256: batch.native_batch_sha256 })
    ).rejects.toThrow()
    expect(await bridge.retire()).toBe(true)
  })

test('invalid later control row rejects before any acquisition and valid roster still works', async () => {
  const { bridge, graphics, advance } = await start()
  const before = graphics.calls.length
  const bad = structuredClone(advance)
  ;(bad.rows[2] as unknown[])[0] = 1
  await expect(bridge.command(bad)).rejects.toThrow('entity order')
  expect(graphics.calls).toHaveLength(before)
  expect(object(object(await bridge.command(advance)).batch).tick).toBe(1)
})

test('declared not-due source remains absent until its exact due tick', async () => {
  const p = prepare(2)
  p.sources[0].publication_period_ticks = 2
  const { bridge, graphics, advance } = await start(p)
  const first = object(object(await bridge.command(advance)).batch)
  expect(first.slots).toMatchObject([
    { status: 'not_due', next_due_tick: 2 },
    { status: 'produced' },
  ])
  expect(graphics.calls.filter((row) => row[0] === 1).map((row) => row[1])).toEqual(['source-01'])
  await bridge.command({ kind: 'release', native_batch_sha256: first.native_batch_sha256 })
  const control = object(first.control).rows as Array<[number, string, string, boolean]>
  const second = object(
    object(
      await bridge.command({
        kind: 'advance',
        tick: 2,
        previous_native_batch_sha256: first.native_batch_sha256,
        rows: control.map((row) => encode('ControlRow', [row[0], 'hold', row[1]])),
      })
    ).batch
  )
  expect((second.slots as SourceOutcome[]).map((row) => row.status)).toEqual([
    'produced',
    'produced',
  ])
})

test('source acquisition failure keeps prior originals and prevents another transition', async () => {
  const { bridge, graphics, advance } = await start()
  graphics.fail = 'source-01'
  const batch = object(object(await bridge.command(advance)).batch)
  const slots = batch.slots as SourceOutcome[]
  expect(batch.source_failed).toBe(true)
  expect(slots.map((row) => row.status)).toEqual(['produced', 'failed', 'absent'])
  const first = slots[0]
  if (first.status !== 'produced') throw new Error('Missing prior original')
  const request = {
    kind: 'read_chunk',
    native_batch_sha256: batch.native_batch_sha256,
    request_id: first.request_id,
    original_sha256: first.original_payload_sha256,
    offset: 0,
  }
  const bytes = Buffer.from(object(await bridge.command(request)).bytes_base64 as string, 'base64')
  expect(bytes.equals(Buffer.alloc(first.byte_length, 1))).toBe(true)
  expect(sha256(bytes)).toBe(first.original_payload_sha256)
  await expect(bridge.command({ ...request, request_id: slots[1].request_id })).rejects.toThrow()
  await bridge.command({ kind: 'release', native_batch_sha256: batch.native_batch_sha256 })
  await expect(
    bridge.command({ ...advance, tick: 2, previous_native_batch_sha256: batch.native_batch_sha256 })
  ).rejects.toThrow()
  expect(await bridge.retire()).toBe(true)
  expect(graphics.retires).toBe(1)
})

for (const fault of ['integrity', 'malformed', 'cleanup'] as const)
  test(`${fault} does not become a typed partial success`, async () => {
    const { bridge, graphics, advance } = await start()
    if (fault === 'malformed') graphics.malformed = true
    else {
      graphics.fail = 'source-01'
      if (fault === 'integrity')
        graphics.failure = new GraphicsSourceIntegrityError('changed transfer identity')
      else graphics.cleanupFailure = new Error('source owner cleanup unresolved')
    }
    await expect(bridge.command(advance)).rejects.toBeInstanceOf(CityEnvironmentError)
    expect(await bridge.retire()).toBe(fault !== 'cleanup')
    const retained = bridge.retirementFailures()
    if (fault === 'cleanup') {
      expect(retained).toHaveLength(1)
      expect(retained[0]).toBeInstanceOf(AggregateError)
      expect((retained[0] as AggregateError).errors).toContain(graphics.cleanupFailure)
      expect(await bridge.retire()).toBe(false)
      expect(bridge.retirementFailures()[0]).toBe(retained[0])
      expect(graphics.retires).toBe(1)
    } else expect(retained).toEqual([])
    await expect(bridge.command(advance)).rejects.toThrow('Retired')
  })

test('failed construction never acquires cleanup confirmation from an absent owner', async () => {
  const original = new Error('constructor failed after attempted ownership')
  const bridge = new CityBridge(async () => {
    throw original
  })
  bridges.push(bridge)
  await expect(
    bridge.command({
      kind: 'prepare',
      run_id: run,
      source_identity: source,
      prepare: encode('Prepare', prepare()),
    })
  ).rejects.toBe(original)
  expect(await bridge.retire()).toBe(false)
  expect(await bridge.retire()).toBe(false)
})

test('closed frame and binary64 decoder preserve signs and reject ambiguous or foreign tokens', () => {
  const row = [0, 'set', true, [-0, 0, 0.03, 23]]
  const encoded = encode('ControlRow', row)
  expect(
    Object.is((decodeTyped('ControlRow', encoded) as [number, string, boolean, number[]])[3][0], -0)
  ).toBe(true)
  expect(() => decodeTyped('ControlRow', row)).toThrow()
  const valid = JSON.stringify({
    schema: 'crebain.city-engine-request.v1',
    generation: run,
    sequence: 1,
    command: { kind: 'retire' },
  })
  expect(decodeFrame(Buffer.from(valid)).sequence).toBe(1)
  for (const bad of [
    valid.replace('"sequence":1', '"sequence":1.0'),
    valid.replace('"sequence":1', '"sequence":1,"sequence":1'),
    valid + ' ',
    valid.replace('"sequence":1', '"sequence":-0'),
    valid.replace('"retire"', '"rétire"'),
  ])
    expect(() => decodeFrame(Buffer.from(bad))).toThrow()
  expect(() => decodeFrame(Buffer.from(valid.slice(0, -1)))).toThrow()
  expect(() => decodeFrame(new Uint8Array(65537))).toThrow()
})
