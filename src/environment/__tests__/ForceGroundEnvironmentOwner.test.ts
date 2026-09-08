// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import example from '../../../examples/native-environment/force-ground-run.json'
import {
  EnvironmentOwner,
  observationEnvelopeBytes,
  type EnvironmentGraphics,
  type GraphicsLauncher,
} from '../EnvironmentOwner'
import { EnvironmentState, FORCE_GROUND_PROFILE, type EnvironmentPlan } from '../EnvironmentState'
import { AcousticState } from '../AcousticObservation'
import { ThermalState } from '../ThermalObservation'
import { exactJson } from '../ExactJson'
import { graphicsInputDigest, type GraphicsPlan, type GraphicsInput } from '../GraphicsContract'
import {
  CONTROLLED_RETURN_BYTES,
  DeterministicDroneWorld,
  type ScheduledDynamicsAction,
} from '../../physics/DeterministicDroneWorld'

type ForcePlan = Extract<EnvironmentPlan, { profile: typeof FORCE_GROUND_PROFILE }>
function plan(): ForcePlan {
  const input = structuredClone(example.plan) as unknown as ForcePlan
  for (const camera of [...input.scene.rgbCameras, ...input.scene.thermalCameras]) {
    camera.width = 8
    camera.height = 8
    camera.periodTicks = 1
  }
  return input
}
const action = (tick = 1): ScheduledDynamicsAction =>
  ({ ...structuredClone(example.actions[0]), tick }) as ScheduledDynamicsAction
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** Synthetic transport controls; the separate real zero-splat capture supplies renderer evidence. */
class GraphicsControl implements EnvironmentGraphics {
  generation = crypto.randomUUID()
  plan!: GraphicsPlan
  planSha256 = ''
  calls = 0
  retired = false
  cleanupFails = false
  mutation: 'none' | 'tick' | 'generation' | 'thermal' | 'readback' = 'none'
  launch: GraphicsLauncher = async (json) => {
    this.plan = JSON.parse(json) as GraphicsPlan
    this.planSha256 = await graphicsInputDigest(this.plan)
    return this
  }
  diagnostics() {
    return { generation: this.generation, planSha256: this.planSha256 }
  }
  async captureJson(json: string) {
    this.calls++
    if (this.mutation === 'readback') throw new Error('Readback failed')
    const request = JSON.parse(json) as GraphicsInput
    const rows = (thermal: boolean) =>
      this.plan.scene[thermal ? 'thermalCameras' : 'rgbCameras']
        .filter((camera) => request.tick % camera.periodTicks === 0)
        .map((camera) => {
          const bytes = Buffer.alloc(camera.width * camera.height * 4)
          if (thermal)
            for (let offset = 0; offset < bytes.length; offset += 4)
              bytes.writeFloatLE(this.mutation === 'thermal' ? NaN : 133.29733, offset)
          return {
            cameraId: camera.id,
            width: camera.width,
            height: camera.height,
            encoding: thermal ? 'float32-le' : 'rgba8-srgb',
            ...(thermal ? { unit: 'W/(m2 sr)' } : {}),
            bytesBase64: bytes.toString('base64'),
          }
        })
    return JSON.stringify({
      generation:
        this.mutation === 'generation' ? '22222222-2222-4222-8222-222222222222' : this.generation,
      planSha256: this.planSha256,
      inputSha256: await graphicsInputDigest(request),
      tick: request.tick + (this.mutation === 'tick' ? 1 : 0),
      rowOrigin: 'bottom-left',
      rgb: rows(false),
      thermal: rows(true),
    })
  }
  async retire() {
    this.retired = true
    if (this.cleanupFails) throw new Error('Unresolved graphics cleanup')
  }
}
const owners: EnvironmentOwner[] = []
async function prepare(input = plan(), graphics = new GraphicsControl()) {
  const owner = await EnvironmentOwner.prepare(input, graphics.launch)
  owners.push(owner)
  return { owner, graphics }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const owner of owners.splice(0)) await owner.retire()
})

function verifyControl(json: string, input: ForcePlan) {
  const batch = JSON.parse(json)
  expect(batch.profile).toBe('crebain.force-ground-observation.v1')
  expect(batch.environmentProfile).toBe(FORCE_GROUND_PROFILE)
  expect(batch.planSha256).toBe(hash(exactJson(input)))
  expect(batch.privilegedControl.encoding).toBe('crebain.controlled-transition-json.v1')
  expect(hash(batch.privilegedControl.json)).toBe(batch.privilegedControl.sha256)
  const transition = JSON.parse(batch.privilegedControl.json, (_key, value) =>
    value && typeof value === 'object' && value.float64 === 'negative-zero' ? -0 : value
  )
  expect(transition.profile).toBe('crebain.rapier-force-attitude.v1')
  expect(transition.tick).toBe(batch.tick)
  expect(transition.sourceIdentity).toBe(input.sourceIdentity)
  expect(transition.observation).toEqual(JSON.parse(batch.privilegedReference.json).dynamics)
  if (transition.controller)
    expect(transition.controller.allocation.policy).toBe('full-moments-before-collective-v1')
  expect(transition.afterStateSha256).toMatch(/^[a-f0-9]{64}$/)
  return { batch, transition }
}

describe('force-ground control and observation joins', () => {
  it('binds exact control, held-action lineage, actual pressure, and the owned plan', async () => {
    const input = plan()
    const { owner } = await prepare(input)
    await expect(owner.advance()).rejects.toThrow('explicitly scheduled')
    expect(owner.status()).toMatchObject({
      phase: 'active',
      executedTick: 0,
      acceptedObservationTick: 0,
    })
    owner.schedule(action())
    let previous: string | null = null
    for (let tick = 1; tick <= 3; tick++) {
      const handle = await owner.advance()
      const json = owner.readObservation(handle)
      const { batch, transition } = verifyControl(json, input)
      expect(transition.action.tick).toBe(1)
      expect(batch.previousBatchSha256).toBe(previous)
      expect(batch.pressure.sampleEnd).toBe(Math.floor((tick * 16000) / 120))
      expect(batch.graphics.tick).toBe(tick)
      expect(transition.appliedMotorTargets).toEqual(transition.controller.commands)
      expect(Buffer.byteLength(json)).toBeLessThanOrEqual(
        observationEnvelopeBytes(input.profile, 32 * 1024 * 1024)
      )
      await expect(owner.advance()).rejects.toThrow('lease')
      previous = handle.sha256
      owner.releaseObservation(handle)
    }
  })

  it('retains raw-motor controls without assigning force-controller diagnostics', async () => {
    const input = plan()
    const { owner } = await prepare(input)
    owner.schedule({
      tick: 1,
      droneId: 'drone-000',
      armed: true,
      control: {
        kind: 'motors',
        commands: { front_left: 0.6, front_right: 0.6, rear_left: 0.6, rear_right: 0.6 },
      },
    })
    const handle = await owner.advance()
    expect(verifyControl(owner.readObservation(handle), input).transition.controller).toBeNull()
    owner.releaseObservation(handle)
  })

  it('rejects an ordinary profile getter without invocation before deriving default capacity', async () => {
    const input = plan()
    const getter = vi.fn(() => FORCE_GROUND_PROFILE)
    Object.defineProperty(input, 'profile', { enumerable: true, get: getter })
    const allocate = vi.spyOn(EnvironmentState, 'prepare')
    const graphics = new GraphicsControl()
    const launch = vi.fn(graphics.launch)
    await expect(EnvironmentOwner.prepare(input, launch)).rejects.toThrow('accessors')
    expect(getter).not.toHaveBeenCalled()
    expect(allocate).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    const owner = await EnvironmentOwner.prepare(plan(), launch)
    owners.push(owner)
    owner.schedule(action())
    expect((await owner.advance()).tick).toBe(1)
    expect(allocate).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it.each([null, Number.NaN, '32768', false])(
    'rejects explicit invalid encoded capacity %s without treating it as omitted',
    async (capacity) => {
      const allocate = vi.spyOn(EnvironmentState, 'prepare')
      const graphics = new GraphicsControl()
      const launch = vi.fn(graphics.launch)
      await expect(
        EnvironmentOwner.prepare(plan(), launch, undefined, capacity as unknown as number)
      ).rejects.toThrow('Encoded observation capacity')
      expect(allocate).not.toHaveBeenCalled()
      expect(launch).not.toHaveBeenCalled()
      const owner = await EnvironmentOwner.prepare(plan(), launch, undefined, undefined)
      owners.push(owner)
      owner.schedule(action())
      expect((await owner.advance()).tick).toBe(1)
    }
  )

  it('reserves the shared encoded envelope before CPU allocation or graphics launch', async () => {
    const input = plan()
    const maximum =
      [...input.scene.rgbCameras, ...input.scene.thermalCameras].reduce(
        (sum, camera) => sum + camera.width * camera.height * 4,
        0
      ) +
      input.scene.microphones.length * 134 * 8
    const bound = observationEnvelopeBytes(input.profile, maximum)
    expect(bound - observationEnvelopeBytes('crebain.cpu-city-environment.v1', maximum)).toBe(
      2 * CONTROLLED_RETURN_BYTES + 1024
    )
    const allocate = vi.spyOn(EnvironmentState, 'prepare')
    const graphics = new GraphicsControl()
    const launch = vi.fn(graphics.launch)
    await expect(EnvironmentOwner.prepare(input, launch, maximum, bound - 1)).rejects.toThrow(
      'Encoded observation capacity'
    )
    expect(allocate).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    const owner = await EnvironmentOwner.prepare(input, launch, maximum, bound)
    owners.push(owner)
    owner.schedule(action())
    expect((await owner.advance()).tick).toBe(1)
  })

  it.each(['tick', 'generation', 'thermal', 'readback'] as const)(
    'retains executed control without accepting %s graphics',
    async (mutation) => {
      const { owner, graphics } = await prepare()
      owner.schedule(action())
      graphics.mutation = mutation
      await expect(owner.advance()).rejects.toThrow('generation retired')
      expect(owner.failure()).toMatchObject({
        executedTick: 1,
        acceptedObservationTick: 0,
        completeSensorObservation: false,
        forceControl: { transition: { tick: 1 }, cpuFailure: null },
      })
      expect(owner.status().phase).toBe('retired')
      const positive = await prepare()
      positive.owner.schedule(action())
      expect((await positive.owner.advance()).tick).toBe(1)
    }
  )

  it.each(['thermal', 'acoustic'] as const)(
    'does not erase physics completion after %s fails',
    async (sensor) => {
      const { owner, graphics } = await prepare()
      owner.schedule(action())
      const failure =
        sensor === 'thermal'
          ? vi.spyOn(ThermalState.prototype, 'advance').mockImplementationOnce(() => {
              throw new Error('Thermal failed')
            })
          : vi.spyOn(AcousticState.prototype, 'advance').mockImplementationOnce(() => {
              throw new Error('Acoustic failed')
            })
      await expect(owner.advance()).rejects.toThrow('generation retired')
      expect(graphics.calls).toBe(0)
      expect(owner.status()).toMatchObject({
        executedTick: 1,
        lastObservedCompletedCpuTick: 1,
        acceptedObservationTick: 0,
      })
      expect(owner.failure()?.forceControl).toMatchObject({
        transition: { tick: 1 },
        cpuFailure: {
          executedTick: 1,
          lastAcceptedControlTick: 1,
          thermalComplete: sensor === 'acoustic',
          acousticComplete: false,
          cleanupConfirmed: true,
        },
      })
      failure.mockRestore()
      const positive = await prepare()
      positive.owner.schedule(action())
      expect((await positive.owner.advance()).tick).toBe(1)
    }
  )

  it.each(['before', 'after'] as const)(
    'keeps capacity during retirement %s the awaited CPU return',
    async (position) => {
      const { owner, graphics } = await prepare()
      owner.schedule(action())
      let start!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => {
        start = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const actual = DeterministicDroneWorld.prototype.advanceControlled
      vi.spyOn(DeterministicDroneWorld.prototype, 'advanceControlled').mockImplementationOnce(
        async function (this: DeterministicDroneWorld, bytes) {
          if (position === 'before') {
            start()
            await gate
          }
          const result = await actual.call(this, bytes)
          if (position === 'after') {
            start()
            await gate
          }
          return result
        }
      )
      const advance = expect(owner.advance()).rejects.toThrow('generation retired')
      await started
      await expect(owner.advance()).rejects.toThrow('busy')
      await expect(owner.checkpoint()).rejects.toThrow('busy')
      let retired = false
      const retirement = owner.retire().then(() => {
        retired = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(retired).toBe(false)
      expect(owner.resourceStatus().reservedOwners).toBe(1)
      expect(owner.status()).toMatchObject({
        phase: 'retired',
        executedTick: null,
        acceptedObservationTick: 0,
      })
      release()
      await advance
      await retirement
      expect(graphics.calls).toBe(0)
      expect(owner.status()).toMatchObject({
        phase: 'retired',
        executedTick: 1,
        acceptedObservationTick: 0,
      })
      expect(owner.resourceStatus().reservedOwners).toBe(0)
    }
  )

  it('rejects a dropped or changed controlled return before accepting the sensor batch', async () => {
    for (const mutation of ['missing', 'tick'] as const) {
      const { owner } = await prepare()
      owner.schedule(action())
      const actual = EnvironmentState.prototype.advanceControlled
      const changed = vi
        .spyOn(EnvironmentState.prototype, 'advanceControlled')
        .mockImplementationOnce(async function (this: EnvironmentState, bytes) {
          const result = await actual.call(this, bytes)
          if (mutation === 'missing') Object.assign(result, { transition: null })
          else result.transition.tick++
          return result
        })
      await expect(owner.advance()).rejects.toThrow('generation retired')
      expect(owner.status()).toMatchObject({ executedTick: 1, acceptedObservationTick: 0 })
      changed.mockRestore()
    }
    const input = plan()
    const { owner } = await prepare(input)
    owner.schedule(action())
    const handle = await owner.advance()
    const json = owner.readObservation(handle)
    verifyControl(json, input)
    const missing = JSON.parse(json)
    delete missing.privilegedControl
    expect(() => verifyControl(JSON.stringify(missing), input)).toThrow()
    const changed = JSON.parse(json)
    changed.privilegedControl.json += ' '
    expect(() => verifyControl(JSON.stringify(changed), input)).toThrow()
    owner.releaseObservation(handle)
  })

  it('retains unknown execution when no typed CPU outcome or completed return is observed', async () => {
    const { owner } = await prepare()
    owner.schedule(action())
    const actual = EnvironmentState.prototype.advanceControlled
    const failure = vi
      .spyOn(EnvironmentState.prototype, 'advanceControlled')
      .mockImplementationOnce(async function (this: EnvironmentState, bytes) {
        await actual.call(this, bytes)
        throw new Error('Completed return hidden by synthetic boundary failure')
      })
    await expect(owner.advance()).rejects.toThrow('generation retired')
    expect(owner.status()).toMatchObject({
      executedTick: null,
      lastObservedCompletedCpuTick: 0,
      acceptedObservationTick: 0,
    })
    expect(owner.failure()?.forceControl).toEqual({ transition: null, cpuFailure: null })
    failure.mockRestore()
    const positive = await prepare()
    positive.owner.schedule(action())
    expect((await positive.owner.advance()).tick).toBe(1)
  })

  it('preserves typed unknown execution from a failed controlled physics return', async () => {
    const { owner } = await prepare()
    owner.schedule(action())
    const actual = DeterministicDroneWorld.prototype.advanceControlled
    const failure = vi
      .spyOn(DeterministicDroneWorld.prototype, 'advanceControlled')
      .mockImplementationOnce(async function (this: DeterministicDroneWorld, bytes) {
        await actual.call(this, bytes)
        throw new Error('No recognized completed engine return')
      })
    await expect(owner.advance()).rejects.toThrow('generation retired')
    expect(owner.status()).toMatchObject({
      executedTick: null,
      lastObservedCompletedCpuTick: 0,
      acceptedObservationTick: 0,
    })
    expect(owner.failure()?.forceControl?.cpuFailure).toMatchObject({
      executedTick: null,
      lastCompletedTick: 0,
      lastAcceptedControlTick: 0,
    })
    failure.mockRestore()
    const positive = await prepare()
    positive.owner.schedule(action())
    expect((await positive.owner.advance()).tick).toBe(1)
  })

  it('retains a family reservation after unresolved graphics cleanup', async () => {
    const { owner, graphics } = await prepare()
    owner.schedule(action())
    graphics.mutation = 'readback'
    graphics.cleanupFails = true
    await expect(owner.advance()).rejects.toThrow('generation retired')
    expect(owner.failure()).toMatchObject({ executedTick: 1, acceptedObservationTick: 0 })
    expect(owner.failure()?.cleanupErrors).toHaveLength(1)
    expect(owner.resourceStatus().reservedOwners).toBe(1)
    await expect(owner.retire()).rejects.toThrow('graphics cleanup failed')
    expect(owner.resourceStatus().reservedOwners).toBe(1)
    graphics.cleanupFails = false
    await owner.retire()
    expect(owner.resourceStatus().reservedOwners).toBe(0)
    const positive = await prepare()
    await positive.owner.retire()
    expect(positive.owner.resourceStatus().reservedOwners).toBe(0)
  })

  it('retains the valid 18-field allocation and explicit signed-zero target', async () => {
    const input = plan()
    const { owner } = await prepare(input)
    const target = action()
    Object.assign(target.control, { roll_rad: -0 })
    owner.schedule(target)
    const handle = await owner.advance()
    const json = owner.readObservation(handle)
    const { batch, transition } = verifyControl(json, input)
    expect(Object.keys(transition.controller.allocation)).toEqual([
      'requestedF',
      'requestedMoments',
      'boundedF',
      'scale',
      'initialScale',
      'decrements',
      'yawInterval',
      'limitedYaw',
      'nullspace',
      'forces',
      'achieved',
      'residuals',
      'forceRounding',
      'targets',
      'limitations',
      'policy',
      'ceiling',
      'ceilingDecrements',
    ])
    expect(batch.privilegedControl.json).toContain('"float64":"negative-zero"')
    expect(Object.is(transition.action.control.roll_rad, -0)).toBe(true)
    owner.releaseObservation(handle)
  })

  it.each(['extra', 'policy', 'target', 'nonfinite', 'oversized'] as const)(
    'rejects %s owned diagnostics without weakening caller admission',
    async (mutation) => {
      const { owner } = await prepare()
      owner.schedule(action())
      const actual = EnvironmentState.prototype.advanceControlled
      const changed = vi
        .spyOn(EnvironmentState.prototype, 'advanceControlled')
        .mockImplementationOnce(async function (this: EnvironmentState, bytes) {
          const result = await actual.call(this, bytes)
          const controller = result.transition.controller!
          if (mutation === 'extra') Object.assign(controller.allocation, { extra: 0 })
          if (mutation === 'policy')
            Object.assign(controller.allocation, { policy: 'collective-first' })
          if (mutation === 'target')
            Object.assign(controller, { target: { ...controller.target, heading_rad: 0.1 } })
          if (mutation === 'nonfinite') controller.ay = Number.NaN
          if (mutation === 'oversized')
            Object.assign(controller.allocation, {
              forces: Array.from({ length: 256 }, () => 'x'.repeat(256)),
            })
          return result
        })
      await expect(owner.advance()).rejects.toThrow('generation retired')
      expect(owner.failure()).toMatchObject({ executedTick: 1, acceptedObservationTick: 0 })
      changed.mockRestore()
      const positive = await prepare()
      positive.owner.schedule(action())
      expect((await positive.owner.advance()).tick).toBe(1)
    }
  )

  it('reconstructs matched siblings and preserves accepted future actions and a separate intervention', async () => {
    const input = plan()
    const parent = await EnvironmentOwner.prepare(input, async (json) =>
      new GraphicsControl().launch(json)
    )
    owners.push(parent)
    parent.schedule(action())
    parent.schedule(action(3))
    const first = await parent.advance()
    parent.releaseObservation(first)
    const checkpoint = await parent.checkpoint()
    const left = await parent.fork(checkpoint)
    owners.push(left)
    const right = await parent.fork(checkpoint)
    owners.push(right)
    const altered = await parent.fork(checkpoint)
    owners.push(altered)
    const intervention = action(2)
    Object.assign(intervention.control, { pitch_rad: 0.03 })
    altered.schedule(intervention)
    for (const child of [left, right, altered]) expect(() => child.schedule(action(3))).toThrow()
    const rightHandle = await right.advance()
    const leftHandle = await left.advance()
    const alteredHandle = await altered.advance()
    const rightBatch = verifyControl(right.readObservation(rightHandle), input)
    const leftBatch = verifyControl(left.readObservation(leftHandle), input)
    const alteredBatch = verifyControl(altered.readObservation(alteredHandle), input)
    expect(leftBatch.transition).toEqual(rightBatch.transition)
    expect(leftBatch.batch.pressure).toEqual(rightBatch.batch.pressure)
    expect(leftBatch.transition.appliedMotorTargets).not.toEqual(
      alteredBatch.transition.appliedMotorTargets
    )
    expect(parent.status()).toMatchObject({ executedTick: 1, acceptedObservationTick: 1 })
    left.releaseObservation(leftHandle)
    right.releaseObservation(rightHandle)
    altered.releaseObservation(alteredHandle)
    parent.releaseCheckpoint(checkpoint)
  })
})
