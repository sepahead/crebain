// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DronePhysicsBody, DronePhysicsWorld } from '../../physics/DronePhysics'
import {
  ForceCityWorld,
  type ForceCityBatch,
  type ForceCityTransition,
} from '../../physics/ForceCityWorld'
import { AcousticState } from '../AcousticObservation'
import {
  CITY_ORIGINAL_BYTES,
  CITY_CHUNK_BYTES,
  cityResourceBounds,
  citySha256,
  cityJson,
  ownCityEnvironmentPlan,
  type CityEnvironmentPlan,
} from '../CitySourceContract'
import {
  ForceCityEnvironment,
  CityEnvironmentError,
  CityEnvironmentPreparationError,
  type CityObservation,
  type CityObservationHandle,
  type CitySourceOutcome,
} from '../ForceCityEnvironment'
import {
  graphicsInputDigest,
  type SourceGraphicsPlan,
  type SourceGraphicsInput,
  type SourceGraphicsPort,
  type SourceGraphicsLauncher,
  type GraphicsSourceSelection,
  type GraphicsSourceReceipt,
} from '../GraphicsContract'
import { cityPlan, citySet, cityHold } from './CitySourceFixtures'

/** Synthetic source transport. It cannot establish actual rendered pixels or native qualification. */
class SourceControl implements SourceGraphicsPort {
  planSha256 = ''
  plan!: SourceGraphicsPlan
  calls: Array<{ tick: number; cameraId: string }> = []
  retires = 0
  failure: unknown = new Error('selected source unavailable')
  failCamera: string | null = null
  failTick = 1
  cleanupError: Error | null = null
  alter: ((receipt: GraphicsSourceReceipt) => GraphicsSourceReceipt) | null = null
  launch: SourceGraphicsLauncher = async (plan) => {
    this.plan = plan
    this.planSha256 = await graphicsInputDigest(plan)
    return this
  }
  async captureSourceInto(
    input: SourceGraphicsInput,
    source: GraphicsSourceSelection,
    bytes: Uint8Array
  ): Promise<GraphicsSourceReceipt> {
    this.calls.push({ tick: input.tick, cameraId: source.cameraId })
    if (input.tick === this.failTick && source.cameraId === this.failCamera) throw this.failure
    const rows = source.kind === 'rgb' ? this.plan.scene.rgbCameras : this.plan.scene.thermalCameras
    const camera = rows.find((row) => row.id === source.cameraId)!
    if (source.kind === 'rgb') bytes.fill(input.tick + rows.indexOf(camera))
    else {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let offset = 0; offset < bytes.byteLength; offset += 4)
        view.setFloat32(offset, 133.29733, true)
    }
    const receipt: GraphicsSourceReceipt = {
      planSha256: this.planSha256,
      inputSha256: await graphicsInputDigest(input),
      tick: input.tick,
      kind: source.kind,
      cameraId: camera.id,
      width: camera.width,
      height: camera.height,
      rowOrigin: 'bottom-left',
      encoding: source.kind === 'rgb' ? 'rgba8-srgb' : 'float32-le',
      byteLength: bytes.byteLength,
    }
    return input.tick && this.alter ? this.alter(receipt) : receipt
  }
  retire(): void {
    this.retires++
    if (this.cleanupError) throw this.cleanupError
  }
}

const owners = new Set<ForceCityEnvironment>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const owner of owners) await owner.retire()
  owners.clear()
})
async function prepare(plan = cityPlan(), control = new SourceControl()) {
  const graphics = plan.scene.rgbCameras.length + plan.scene.thermalCameras.length > 0
  const owner = await ForceCityEnvironment.prepare(plan, graphics ? control.launch : undefined)
  owners.add(owner)
  return { owner, control }
}
function produced(
  batch: CityObservation,
  requestId: string
): Extract<CitySourceOutcome, { status: 'produced' }> {
  const row = batch.slots.find((slot) => slot.requestId === requestId)
  if (row?.status !== 'produced') throw new Error('Expected produced fixture source')
  return row
}
function controlBytes(owner: ForceCityEnvironment, handle: CityObservationHandle): Uint8Array {
  const { transitionSha256, transitionByteLength } = owner.observation(handle).control
  const result = new Uint8Array(transitionByteLength)
  for (let offset = 0; offset < result.length; offset += CITY_CHUNK_BYTES)
    result.set(owner.readControlChunk(handle, transitionSha256, offset), offset)
  return result
}

describe('force-city source admission and actual backing', () => {
  it.each([0, 2, 3, 4, 12])(
    'admits %i exclusive sources with no mandatory modality',
    async (total) => {
      const selected =
        total === 12 ? { rgb: 4, thermal: 4, pressure: 4 } : { rgb: 0, thermal: 0, pressure: total }
      const plan = cityPlan(2, selected)
      const { owner, control } = await prepare(plan)
      const bounds = cityResourceBounds(plan)
      expect(owner.resourceStatus()).toMatchObject({
        originalBackingBytes: bounds.originalBytes,
        receiptBackingBytes: bounds.receiptBytes,
        controlBackingBytes: bounds.cpuReturnEncodedBytes,
        processRetirement: 'outside_component_scope',
      })
      expect(control.calls.length).toBe(selected.rgb + selected.thermal)
      expect(control.calls.every((row) => row.tick === 0)).toBe(true)
      const handle = await owner.advance(citySet(plan))
      expect(owner.observation(handle).slots).toHaveLength(total)
      expect(owner.observation(handle).slots.every((row) => row.status === 'produced')).toBe(true)
      if (!selected.rgb && !selected.thermal) expect(control.retires).toBe(0)
    }
  )

  it('rejects every relational plan defect before any CPU or graphics construction', async () => {
    const valid = cityPlan()
    const variations: Array<(plan: CityEnvironmentPlan) => void> = [
      (plan) => {
        plan.requests[1].entityId = 'foreign'
      },
      (plan) => {
        plan.requests[1].sourceId = plan.requests[0].sourceId
      },
      (plan) => {
        plan.requests[1] = {
          ...plan.requests[0],
          requestId: plan.requests[1].requestId,
          sourceId: 'distinct',
        }
      },
      (plan) => {
        plan.requests.reverse()
      },
      (plan) => {
        plan.requests.pop()
      },
      (plan) => {
        plan.requests[0].periodTicks = 2
      },
      (plan) => {
        plan.requests[0].kind = 'mounted' as 'rgb'
      },
      (plan) => {
        plan.world.staticGeometry = []
      },
      (plan) => {
        plan.scene.solids[0].shape.center[0] += 1
      },
      (plan) => {
        delete plan.acoustic
      },
      (plan) => {
        delete plan.thermal
      },
      (plan) => {
        Reflect.set(plan, 'acoustic', null)
      },
      (plan) => {
        Reflect.set(plan, 'thermal', false)
      },
    ]
    const cpu = vi.spyOn(ForceCityWorld, 'prepare')
    const control = new SourceControl(),
      launch = vi.fn(control.launch)
    for (const change of variations) {
      // Detach both geometry rosters so this is a real failed join, not an aliased fixture edit.
      const plan = structuredClone(valid)
      plan.world.staticGeometry = structuredClone(plan.world.staticGeometry)
      change(plan)
      await expect(ForceCityEnvironment.prepare(plan, launch)).rejects.toThrow()
    }
    for (const plan of [
      cityPlan(2, { rgb: 5, thermal: 4, pressure: 4 }),
      cityPlan(2, { rgb: 5, thermal: 0, pressure: 0 }),
    ])
      await expect(ForceCityEnvironment.prepare(plan, launch)).rejects.toThrow()
    await expect(ForceCityEnvironment.prepare(valid)).rejects.toThrow('exactly when cameras')
    await expect(
      ForceCityEnvironment.prepare(cityPlan(2, { rgb: 0, thermal: 0, pressure: 0 }), launch)
    ).rejects.toThrow('exactly when cameras')
    expect(cpu).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    const accepted = await ForceCityEnvironment.prepare(valid, launch)
    owners.add(accepted)
    expect(cpu).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledOnce()
  })

  it('reserves the exact maximum original, control, and receipt extents before construction', async () => {
    const plan = cityPlan(256, { rgb: 4, thermal: 4, pressure: 4 })
    plan.scene.rgbCameras.forEach((row) => {
      row.width = 1280
      row.height = 1280
    })
    plan.scene.thermalCameras.forEach((row) => {
      row.width = 320
      row.height = 320
    })
    plan.acoustic!.maximumRangeM = 128
    plan.acoustic!.soundSpeedMps = 300
    const bounds = cityResourceBounds(plan)
    expect(bounds).toMatchObject({
      originalBytes: 27_857_088,
      receiptBytes: 131072,
      cpuReturnEncodedBytes: 8_392_704,
      acousticHistoryBytes: 13_985_792,
      rgbReadbackBytes: 26_214_400,
      thermalReadbackBytes: 1_638_400,
      renderTargetColorBytes: 32_768_000,
      opaqueRuntimeMemoryBound: false,
    })
    const capacity = {
      originalBytes: bounds.originalBytes,
      receiptBytes: bounds.receiptBytes,
      controlBytes: bounds.cpuReturnEncodedBytes,
    }
    const cpu = vi.spyOn(ForceCityWorld, 'prepare'),
      control = new SourceControl(),
      launch = vi.fn(control.launch)
    for (const wrong of [
      { ...capacity, originalBytes: CITY_ORIGINAL_BYTES - 1 },
      { ...capacity, originalBytes: CITY_ORIGINAL_BYTES + 1 },
      { ...capacity, receiptBytes: bounds.receiptBytes - 1 },
      { ...capacity, controlBytes: bounds.cpuReturnEncodedBytes - 1 },
    ])
      await expect(ForceCityEnvironment.prepare(plan, launch, wrong)).rejects.toThrow(
        'capacity before construction'
      )
    expect(cpu).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    const owner = await ForceCityEnvironment.prepare(plan, launch, capacity)
    owners.add(owner)
    expect(owner.resourceStatus().originalBackingBytes).toBe(CITY_ORIGINAL_BYTES)
    expect(control.calls).toHaveLength(8)
  })

  it('owns detached plans and preserves signed zero in source identity', async () => {
    const plan = cityPlan(),
      owned = ownCityEnvironmentPlan(plan)
    plan.scene.rgbCameras[0].position[0] = 4
    expect(owned.scene.rgbCameras[0].position[0]).toBe(0)
    expect(Object.isFrozen(owned.requests[0])).toBe(true)
    expect(cityJson({ value: -0 })).not.toBe(cityJson({ value: 0 }))
    const bad = structuredClone(plan) as unknown as Record<string, unknown>
    Object.defineProperty(bad, 'requests', {
      get: () => {
        throw new Error('getter must not run')
      },
    })
    expect(() => ownCityEnvironmentPlan(bad as unknown as CityEnvironmentPlan)).toThrow()
  })
})

describe('shared physical clock and original source custody', () => {
  it.each(['rgb', 'thermal'] as const)(
    'runs an explicitly selected %s-only plan without another model',
    async (kind) => {
      const plan = cityPlan(2, {
        rgb: kind === 'rgb' ? 1 : 0,
        thermal: kind === 'thermal' ? 1 : 0,
        pressure: 0,
      })
      const { owner, control } = await prepare(plan)
      const handle = await owner.advance(citySet(plan)),
        observation = owner.observation(handle)
      expect(observation.slots).toHaveLength(1)
      expect(observation.slots[0].status).toBe('produced')
      expect(control.plan.thermal === null).toBe(kind === 'rgb')
      expect(owner.resourceStatus().bounds.acousticHistoryBytes).toBe(0)
    }
  )

  it('marks an out-of-horizon next image as not due without inventing a measurement', async () => {
    const plan = cityPlan(2, { rgb: 1, thermal: 0, pressure: 0 })
    plan.world.horizonTicks = 1
    plan.scene.rgbCameras[0].periodTicks = 2
    plan.requests[0].periodTicks = 2
    const { owner, control } = await prepare(plan),
      handle = await owner.advance(citySet(plan))
    expect(owner.observation(handle).slots[0]).toMatchObject({
      status: 'not_due',
      nextDueTick: null,
    })
    expect(control.calls).toEqual([{ tick: 0, cameraId: 'rgb-0' }])
    await expect(owner.advance(cityHold(owner.observation(handle)))).rejects.toThrow()
  })
  it.each([1, 2, 3, 256])(
    'joins %i real bodies to exact independent pressure and control bytes',
    async (count) => {
      const plan = cityPlan(count, { rgb: 0, thermal: 0, pressure: 2 })
      plan.requests[1].periodTicks = 2
      const { owner } = await prepare(plan)
      const reference = await ForceCityWorld.prepare(plan.world)
      const acoustic = new AcousticState(plan.acoustic!, plan.scene, count)
      let batch = citySet(plan)
      try {
        for (let tick = 1; tick <= 3; tick++) {
          const expected = await reference.advanceControlled(batch)
          const block = acoustic.advance(
            expected.entities.map((row) => ({
              position: row.after.state.position as [number, number, number],
              rpm: row.after.rotors.map((rotor) => rotor.rpm) as [number, number, number, number],
            }))
          )
          const handle = await owner.advance(batch),
            observation = owner.observation(handle)
          const bytes = controlBytes(owner, handle)
          expect(await citySha256(bytes)).toBe(observation.control.transitionSha256)
          expect(new TextDecoder().decode(bytes)).toBe(cityJson(expected))
          expect(owner.cpuReference()).toBe(reference.referenceState())
          for (const [index, source] of plan.requests.entries()) {
            if (tick % source.periodTicks !== 0) {
              expect(observation.slots[index]).toMatchObject({
                status: 'not_due',
                nextDueTick: tick + 1,
              })
              expect(() => owner.readChunk(handle, source.requestId, 'a'.repeat(64), 0)).toThrow()
              continue
            }
            const row = produced(observation, source.requestId)
            expect(row.tensor).toMatchObject({
              kind: 'pressure',
              sampleStart: block.sampleStart,
              sampleEnd: block.sampleEnd,
            })
            const actual = owner.readChunk(handle, source.requestId, row.originalSha256, 0)
            const expectedBytes = new Uint8Array(block.channels[index].length * 8)
            const view = new DataView(expectedBytes.buffer)
            block.channels[index].forEach((value, offset) =>
              view.setFloat64(offset * 8, value, true)
            )
            expect(actual).toEqual(expectedBytes)
            expect(await citySha256(actual)).toBe(row.originalSha256)
          }
          expect(
            observation.control.rows.every((row) => row.selection === (tick === 1 ? 'set' : 'hold'))
          ).toBe(true)
          batch = cityHold(observation)
          owner.release(handle)
        }
      } finally {
        reference.retire()
      }
    }
  )

  it('rejects an invalid final row before effects and owns leases, bytes, and history across release', async () => {
    const plan = cityPlan(),
      { owner } = await prepare(plan)
    const before = owner.cpuReference(),
      batch = citySet(plan)
    const last = batch.rows.at(-1)!
    if (last.kind !== 'set') throw new Error('Fixture needs a set row')
    const invalid: ForceCityBatch = {
      ...batch,
      rows: [batch.rows[0], { ...last, target: { ...last.target, roll_rad: 1 } }],
    }
    const motor = vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands')
    await expect(owner.advance(invalid)).rejects.toThrow()
    expect(owner.cpuReference()).toBe(before)
    expect(motor).not.toHaveBeenCalled()
    const handle = await owner.advance(batch),
      observation = owner.observation(handle)
    await expect(owner.advance(cityHold(observation))).rejects.toThrow('remains retained')
    expect(() => owner.observation({ ...handle })).toThrow('Foreign')
    const row = produced(observation, plan.requests[0].requestId)
    const original = owner.readChunk(handle, row.requestId, row.originalSha256, 0)
    original.fill(254)
    expect(await citySha256(owner.readChunk(handle, row.requestId, row.originalSha256, 0))).toBe(
      row.originalSha256
    )
    for (const offset of [-1, 1, row.byteLength, NaN])
      expect(() => owner.readChunk(handle, row.requestId, row.originalSha256, offset)).toThrow()
    expect(() => owner.readChunk(handle, row.requestId, 'f'.repeat(64), 0)).toThrow()
    expect(() => owner.readControlChunk(handle, row.originalSha256, 0)).toThrow()
    const next = cityHold(observation)
    owner.release(handle)
    expect(() => owner.observation(handle)).toThrow()
    const second = await owner.advance(next)
    expect(owner.observation(second).previousBatchSha256).toBe(handle.sha256)
  })

  it('keeps equal synthetic pixels from distinct native source instances as distinct productions', async () => {
    const plan = cityPlan(2, { rgb: 1, thermal: 2, pressure: 0 })
    const { owner } = await prepare(plan),
      handle = await owner.advance(citySet(plan))
    const batch = owner.observation(handle)
    const rows = plan.requests
      .filter((row) => row.kind === 'thermal')
      .map((row) => produced(batch, row.requestId))
    expect(rows[0].originalSha256).toBe(rows[1].originalSha256)
    expect(rows[0].productionSha256).not.toBe(rows[1].productionSha256)
    expect(rows[0].sourceConfigSha256).not.toBe(rows[1].sourceConfigSha256)
    expect(rows[0].entityId).not.toBe(rows[1].entityId)
  })
})

describe('post-effect failures and preparation retirement', () => {
  it('retains a bounded receipt at maximum identifier lengths and escaped failure text', async () => {
    const plan = cityPlan(256, { rgb: 4, thermal: 4, pressure: 4 })
    plan.world.drones.forEach((row, index) => {
      row.id = `d${String(index).padStart(3, '0')}${'x'.repeat(60)}`
    })
    plan.requests.forEach((row, index) => {
      row.entityId = plan.world.drones[index].id
      row.requestId = `r${String(index).padStart(2, '0')}${'x'.repeat(61)}`
      row.sourceId = `s${String(index).padStart(2, '0')}${'x'.repeat(61)}`
    })
    const { owner, control } = await prepare(plan)
    control.failCamera = 'rgb-3'
    control.failure = new Error('\u0000'.repeat(256))
    let caught: unknown
    try {
      await owner.advance(citySet(plan))
    } catch (error) {
      caught = error
    }
    const error = caught as CityEnvironmentError,
      observation = owner.observation(error.handle!)
    expect(observation.control.rows).toHaveLength(256)
    expect(new TextEncoder().encode(cityJson(observation)).length).toBeLessThan(
      cityResourceBounds(plan).receiptBytes
    )
    expect(observation.slots.filter((row) => row.status === 'failed')).toHaveLength(1)
    expect(observation.slots.filter((row) => row.status === 'produced')).toHaveLength(7)
  })

  it('rejects invalid readiness radiance before a motor write and retains cleanup separately', async () => {
    const plan = cityPlan(1, { rgb: 0, thermal: 1, pressure: 0 }),
      control = new SourceControl()
    const capture = control.captureSourceInto.bind(control)
    vi.spyOn(control, 'captureSourceInto').mockImplementation(async (input, source, bytes) => {
      const receipt = await capture(input, source, bytes)
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(0, NaN, true)
      return receipt
    })
    const motors = vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands')
    await expect(ForceCityEnvironment.prepare(plan, control.launch)).rejects.toMatchObject({
      graphicsCleanup: 'confirmed',
      cause: new Error('Invalid original thermal scalar'),
    })
    expect(motors).not.toHaveBeenCalled()
    expect(control.retires).toBe(1)
  })

  it.each([null, undefined])(
    'preserves a thrown %s as the original acquisition failure',
    async (primary) => {
      const plan = cityPlan(),
        { owner, control } = await prepare(plan)
      control.failCamera = 'rgb-0'
      control.failure = primary
      let caught: unknown
      try {
        await owner.advance(citySet(plan))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(CityEnvironmentError)
      expect((caught as CityEnvironmentError).cause).toBe(primary)
      expect((caught as CityEnvironmentError).handle).not.toBeNull()
    }
  )
  it('retains successful original peers when a later selected source actually throws', async () => {
    const plan = cityPlan(3, { rgb: 2, thermal: 1, pressure: 1 })
    const { owner, control } = await prepare(plan)
    control.failCamera = 'rgb-1'
    let caught: unknown
    try {
      await owner.advance(citySet(plan))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CityEnvironmentError)
    const error = caught as CityEnvironmentError
    expect(error.cause).toBe(control.failure)
    expect(error.outcome).toMatchObject({
      stage: 'source',
      executedTick: 1,
      componentCleanup: 'confirmed',
      processRetirement: 'outside_component_scope',
      completeObservation: false,
    })
    const handle = error.handle!,
      observation = owner.observation(handle)
    expect(observation.status).toBe('source_failed')
    expect(observation.slots.map((row) => row.status)).toEqual([
      'produced',
      'failed',
      'absent',
      'produced',
    ])
    expect(control.calls.filter((row) => row.tick === 1).map((row) => row.cameraId)).toEqual([
      'rgb-0',
      'rgb-1',
    ])
    for (const row of observation.slots.filter((slot) => slot.status === 'produced'))
      expect(await citySha256(owner.readChunk(handle, row.requestId, row.originalSha256, 0))).toBe(
        row.originalSha256
      )
    expect(control.retires).toBe(1)
    expect(() => owner.readChunk(handle, plan.requests[1].requestId, '0'.repeat(64), 0)).toThrow()
    await expect(owner.advance(cityHold(observation))).rejects.toThrow()
    owner.release(handle)
    await expect(owner.advance(cityHold(observation))).rejects.toThrow()
  })

  it('preserves acquisition, publication, and unresolved cleanup failures without retrying', async () => {
    const plan = cityPlan(),
      { owner, control } = await prepare(plan)
    control.failCamera = 'rgb-0'
    control.cleanupError = new Error('cleanup unknown')
    const publication = new Error('receipt encoding failure')
    const original = TextEncoder.prototype.encodeInto
    vi.spyOn(TextEncoder.prototype, 'encodeInto').mockImplementation(function (
      this: TextEncoder,
      text,
      bytes
    ) {
      if (text?.includes('crebain.force-city-source-batch.v1')) throw publication
      return original.call(this, text, bytes)
    })
    let caught: unknown
    try {
      await owner.advance(citySet(plan))
    } catch (error) {
      caught = error
    }
    const error = caught as CityEnvironmentError
    expect(error).toBeInstanceOf(CityEnvironmentError)
    expect(error.cause).toBe(control.failure)
    expect(error.secondaryErrors).toEqual([publication])
    expect(error.cleanupErrors).toEqual([control.cleanupError])
    expect(error.handle).toBeNull()
    expect(error.outcome).toMatchObject({
      stage: 'receipt',
      componentCleanup: 'unresolved',
      executedTick: 1,
    })
    await expect(owner.retire()).rejects.toThrow('unresolved')
    await expect(owner.retire()).rejects.toThrow('unresolved')
    expect(control.retires).toBe(1)
    owners.delete(owner)
  })

  it.each(['tick', 'source', 'shape', 'extent', 'input', 'extra'])(
    'retires invalid %s receipts without a favorable partial batch',
    async (kind) => {
      const plan = cityPlan(),
        { owner, control } = await prepare(plan)
      control.alter = (receipt) => ({
        ...receipt,
        ...(kind === 'tick' ? { tick: receipt.tick + 1 } : {}),
        ...(kind === 'source' ? { cameraId: 'foreign' } : {}),
        ...(kind === 'shape' ? { width: 9 } : {}),
        ...(kind === 'extent' ? { byteLength: 0 } : {}),
        ...(kind === 'input' ? { inputSha256: '0'.repeat(64) } : {}),
        ...(kind === 'extra' ? { foreign: true } : {}),
      })
      let caught: unknown
      try {
        await owner.advance(citySet(plan))
      } catch (error) {
        caught = error
      }
      const error = caught as CityEnvironmentError
      expect(error.outcome).toMatchObject({ stage: 'source_validation', executedTick: 1 })
      expect(error.handle).toBeNull()
      expect(control.retires).toBe(1)
      await expect(owner.advance(citySet(plan))).rejects.toThrow()
    }
  )

  it('retires a post-first-motor failure with honest CPU uncertainty and original identity', async () => {
    const plan = cityPlan(2, { rgb: 0, thermal: 0, pressure: 0 }),
      { owner } = await prepare(plan)
    const primary = new Error('second motor write'),
      actual = DronePhysicsBody.prototype.setMotorCommands
    let calls = 0
    vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands').mockImplementation(function (
      this: DronePhysicsBody,
      commands
    ) {
      if (++calls === 2) throw primary
      return actual.call(this, commands)
    })
    let caught: unknown
    try {
      await owner.advance(citySet(plan))
    } catch (error) {
      caught = error
    }
    const error = caught as CityEnvironmentError
    expect(error.handle).toBeNull()
    expect(error.outcome).toMatchObject({ executedTick: 0, stage: 'cpu_or_model' })
    expect((error.cause as Error).cause).toBe(primary)
    expect(owner.resourceStatus().phase).toBe('failed')
  })

  it('keeps preparation failure and returned cleanup distinct from an unreturned launcher', async () => {
    const plan = cityPlan(),
      control = new SourceControl(),
      primary = new Error('readback readiness failed')
    control.failCamera = 'rgb-0'
    control.failTick = 0
    control.failure = primary
    const motor = vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands')
    let caught: unknown
    try {
      await ForceCityEnvironment.prepare(plan, control.launch)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CityEnvironmentPreparationError)
    expect((caught as CityEnvironmentPreparationError).cause).toBe(primary)
    expect((caught as CityEnvironmentPreparationError).graphicsCleanup).toBe('confirmed')
    expect(control.retires).toBe(1)
    expect(motor).not.toHaveBeenCalled()
    const destroy = vi.spyOn(DronePhysicsWorld.prototype, 'destroy')
    try {
      await ForceCityEnvironment.prepare(plan, async () => {
        throw primary
      })
    } catch (error) {
      caught = error
    }
    expect((caught as CityEnvironmentPreparationError).graphicsCleanup).toBe('not_returned')
    expect((caught as CityEnvironmentPreparationError).cause).toBe(primary)
    expect(destroy).toHaveBeenCalledOnce()
    const accepted = await prepare(plan)
    expect(accepted.control.calls.every((row) => row.tick === 0)).toBe(true)
  })

  it('reports complete CPU control bytes as privileged data, not source payloads', async () => {
    const plan = cityPlan(2, { rgb: 0, thermal: 0, pressure: 0 }),
      { owner } = await prepare(plan)
    const handle = await owner.advance(citySet(plan))
    const control = JSON.parse(
      new TextDecoder().decode(controlBytes(owner, handle))
    ) as ForceCityTransition
    expect(control.entities).toHaveLength(2)
    expect(control.entities[0].controller).toBeDefined()
    expect(owner.observation(handle).slots).toEqual([])
    expect(() =>
      owner.readChunk(handle, 'control', owner.observation(handle).control.transitionSha256, 0)
    ).toThrow()
  })
})
