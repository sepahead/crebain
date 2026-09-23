// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  GraphicsSourceIntegrityError,
  graphicsInputDigest,
  type SourceGraphicsPlan,
  type SourceGraphicsInput,
  type GraphicsSourceSelection,
  type GraphicsSourceReceipt,
} from '../GraphicsContract'
import {
  GraphicsSourceAcquisitionError,
  GraphicsSourceRetention,
  GRAPHICS_SOURCE_CAPACITY_BYTES,
  GRAPHICS_SOURCE_CHUNK_BYTES,
} from '../GraphicsSourceRetention'
import { cityPlan } from './CitySourceFixtures'

function sourcePlan(): SourceGraphicsPlan {
  const plan = cityPlan(2, { rgb: 1, thermal: 1, pressure: 0 })
  return {
    profile: 'crebain.owned-force-city-source-graphics.v1',
    sourceIdentity: plan.world.sourceIdentity,
    scene: plan.scene,
    droneIds: plan.world.drones.map((row) => row.id),
    thermal: plan.thermal!,
  }
}

/** Exact custody controls over synthetic bytes; this supplies no rendered-pixel qualification. */
class Control {
  planSha256 = ''
  launched = 0
  calls = 0
  retires = 0
  cleanupError: Error | null = null
  fail = false
  primary: unknown = null
  wait: Promise<void> | null = null
  alter: (value: GraphicsSourceReceipt) => GraphicsSourceReceipt = (value) => value
  readonly plan: SourceGraphicsPlan
  constructor(plan = sourcePlan()) {
    this.plan = plan
  }
  launch = async (plan: SourceGraphicsPlan) => {
    this.launched++
    this.planSha256 = await graphicsInputDigest(plan)
    return this
  }
  runtimeIdentity() {
    return { version: 'synthetic', renderer: 'synthetic', vendor: 'synthetic' }
  }
  input(): SourceGraphicsInput {
    return {
      planSha256: this.planSha256,
      tick: 0,
      drones: this.plan.droneIds.map((id) => ({
        id,
        position: [-0, 23, 0],
        orientation: [0, 0, 0, 1],
        temperatureK: this.plan.thermal ? 293.15 : null,
      })),
    }
  }
  async captureSourceInto(
    input: SourceGraphicsInput,
    source: GraphicsSourceSelection,
    bytes: Uint8Array
  ): Promise<GraphicsSourceReceipt> {
    this.calls++
    if (this.wait) await this.wait
    if (this.fail) throw this.primary
    for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = offset % 251
    const rows = source.kind === 'rgb' ? this.plan.scene.rgbCameras : this.plan.scene.thermalCameras
    const camera = rows.find((row) => row.id === source.cameraId)!
    return this.alter({
      planSha256: this.planSha256,
      inputSha256: await graphicsInputDigest(input),
      tick: input.tick,
      kind: source.kind,
      cameraId: source.cameraId,
      width: camera.width,
      height: camera.height,
      rowOrigin: 'bottom-left',
      encoding: source.kind === 'rgb' ? 'rgba8-srgb' : 'float32-le',
      byteLength: bytes.length,
    })
  }
  retire() {
    this.retires++
    if (this.cleanupError) throw this.cleanupError
  }
}
const rgb: GraphicsSourceSelection = { kind: 'rgb', cameraId: 'rgb-0' }

describe('one-source original custody', () => {
  it.each([8, 128, 1280])(
    'copies complete %i-square originals through bounded chunks',
    async (size) => {
      const plan = sourcePlan()
      plan.scene.rgbCameras[0].width = size
      plan.scene.rgbCameras[0].height = size
      const control = new Control(plan)
      const owner = await GraphicsSourceRetention.prepare(plan, control.launch)
      try {
        expect(owner.capacityBytes).toBe(4 * size * size)
        const input = control.input()
        const lease = await owner.capture(input, rgb)
        expect(lease.receipt.inputSha256).toBe(await graphicsInputDigest(input))
        const received = new Uint8Array(lease.receipt.byteLength)
        for (let offset = 0; offset < received.length; offset += GRAPHICS_SOURCE_CHUNK_BYTES) {
          const chunk = await owner.read(lease.sequence, lease.originalSha256, offset)
          expect(chunk.bytes.length).toBe(
            Math.min(GRAPHICS_SOURCE_CHUNK_BYTES, received.length - offset)
          )
          received.set(chunk.bytes, offset)
          chunk.bytes.fill(0)
        }
        expect(received.every((value, offset) => value === offset % 251)).toBe(true)
        owner.release(lease.sequence, lease.originalSha256)
        const successor = await owner.capture(input, { kind: 'thermal', cameraId: 'thermal-0' })
        expect(successor.sequence).toBe(lease.sequence + 1)
        await expect(owner.read(lease.sequence, lease.originalSha256, 0)).rejects.toThrow('Foreign')
        expect(control.calls).toBe(2)
      } finally {
        await owner.retire()
      }
      expect(control.retires).toBe(1)
    }
  )

  it('rejects insufficient capacity before the graphics constructor and admits its exact bound', async () => {
    const control = new Control()
    await expect(
      GraphicsSourceRetention.prepare(control.plan, control.launch, 255)
    ).rejects.toThrow('capacity')
    await expect(
      GraphicsSourceRetention.prepare(
        control.plan,
        control.launch,
        GRAPHICS_SOURCE_CAPACITY_BYTES + 1
      )
    ).rejects.toThrow('capacity')
    expect(control.launched).toBe(0)
    const owner = await GraphicsSourceRetention.prepare(control.plan, control.launch, 256)
    expect(owner.capacityBytes).toBe(256)
    await owner.retire()
  })

  it('rejects zero or foreign source plans before construction', async () => {
    const control = new Control()
    const invalid = structuredClone(control.plan)
    invalid.scene.rgbCameras = []
    invalid.scene.thermalCameras = []
    invalid.thermal = null
    await expect(GraphicsSourceRetention.prepare(invalid, control.launch)).rejects.toThrow('camera')
    invalid.scene.rgbCameras = control.plan.scene.rgbCameras
    invalid.droneIds = ['duplicate', 'duplicate']
    await expect(GraphicsSourceRetention.prepare(invalid, control.launch)).rejects.toThrow('unique')
    expect(control.launched).toBe(0)
  })

  it('rejects overlap, stale identity, skipped reads, and early release without discarding a valid lease', async () => {
    const control = new Control()
    const owner = await GraphicsSourceRetention.prepare(control.plan, control.launch)
    try {
      await expect(
        owner.capture(control.input(), { kind: 'rgb', cameraId: 'foreign' })
      ).rejects.toThrow('source')
      expect(control.calls).toBe(0)
      const lease = await owner.capture(control.input(), rgb)
      await expect(owner.capture(control.input(), rgb)).rejects.toThrow('unavailable')
      await expect(owner.read(lease.sequence + 1, lease.originalSha256, 0)).rejects.toThrow(
        'Foreign'
      )
      await expect(owner.read(lease.sequence, '0'.repeat(64), 0)).rejects.toThrow('Foreign')
      await expect(owner.read(lease.sequence, lease.originalSha256, 1)).rejects.toThrow('prefix')
      expect(() => owner.release(lease.sequence, lease.originalSha256)).toThrow('Incomplete')
      const pending = owner.read(lease.sequence, lease.originalSha256, 0)
      expect(() => owner.release(lease.sequence, lease.originalSha256)).toThrow('Incomplete')
      await expect(owner.read(lease.sequence, lease.originalSha256, 0)).rejects.toThrow('prefix')
      const bytes = (await pending).bytes
      expect(bytes[250]).toBe(250)
      owner.release(lease.sequence, lease.originalSha256)
      expect(() => owner.release(lease.sequence, lease.originalSha256)).toThrow('Foreign')
      await expect(owner.read(lease.sequence, lease.originalSha256, 0)).rejects.toThrow('Foreign')
      expect((await owner.capture(control.input(), rgb)).sequence).toBe(2)
    } finally {
      await owner.retire()
    }
  })

  it.each(['tick', 'width', 'inputSha256', 'encoding', 'extra'])(
    'rejects altered %s metadata and forbids further acquisition',
    async (field) => {
      const control = new Control()
      control.alter = (receipt) => ({
        ...receipt,
        [field]: field === 'tick' || field === 'width' ? 999 : 'changed',
      })
      const owner = await GraphicsSourceRetention.prepare(control.plan, control.launch)
      try {
        await expect(owner.capture(control.input(), rgb)).rejects.toBeInstanceOf(
          GraphicsSourceIntegrityError
        )
        await expect(owner.capture(control.input(), rgb)).rejects.toThrow('unavailable')
        expect(control.calls).toBe(1)
      } finally {
        await owner.retire()
      }
    }
  )

  it.each([null, undefined, new Error('real selected capture failed')])(
    'preserves actual acquisition cause %s and does not retry cleanup',
    async (primary) => {
      const control = new Control()
      control.fail = true
      control.primary = primary
      const cleanup = new Error('unknown cleanup')
      control.cleanupError = cleanup
      const owner = await GraphicsSourceRetention.prepare(control.plan, control.launch)
      const error = await owner.capture(control.input(), rgb).catch((value: unknown) => value)
      expect(error).toBeInstanceOf(GraphicsSourceAcquisitionError)
      expect((error as Error).cause).toBe(primary)
      await expect(owner.retire()).rejects.toBe(cleanup)
      await expect(owner.retire()).rejects.toBe(cleanup)
      expect(control.retires).toBe(1)
    }
  )

  it('preserves a local integrity failure identity rather than relabeling it as acquisition', async () => {
    const control = new Control()
    control.fail = true
    control.primary = new GraphicsSourceIntegrityError('failed original digest')
    const owner = await GraphicsSourceRetention.prepare(control.plan, control.launch)
    await expect(owner.capture(control.input(), rgb)).rejects.toBe(control.primary)
    await owner.retire()
  })

  it('rejects late publication after retirement while preserving the acquisition promise', async () => {
    const control = new Control()
    let resume!: () => void
    control.wait = new Promise<void>((resolve) => {
      resume = resolve
    })
    const owner = await GraphicsSourceRetention.prepare(control.plan, control.launch)
    const capture = owner.capture(control.input(), rgb)
    const outcome = capture.catch((value: unknown) => value)
    const retirement = owner.retire()
    expect(control.retires).toBe(0)
    resume()
    expect(await outcome).toBeInstanceOf(GraphicsSourceIntegrityError)
    await retirement
    expect(control.retires).toBe(1)
    await expect(owner.capture(control.input(), rgb)).rejects.toThrow('unavailable')
  })

  it('keeps construction identity failure and cleanup failure as separate original objects', async () => {
    const control = new Control()
    const cleanup = new Error('construction cleanup failed')
    control.cleanupError = cleanup
    const error = await GraphicsSourceRetention.prepare(control.plan, async () => control).catch(
      (value: unknown) => value
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBeInstanceOf(GraphicsSourceIntegrityError)
    expect((error as AggregateError).errors[1]).toBe(cleanup)
    expect(control.retires).toBe(1)
  })
})
