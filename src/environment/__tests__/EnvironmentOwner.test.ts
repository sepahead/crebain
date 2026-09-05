// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EnvironmentOwner,
  EnvironmentForkError,
  type EnvironmentGraphics,
  type GraphicsLauncher,
} from '../EnvironmentOwner'
import { EnvironmentState, type EnvironmentPlan } from '../EnvironmentState'
import { createCityBlockScene } from '../SceneSpec'
import { graphicsInputDigest, type GraphicsPlan, type GraphicsInput } from '../GraphicsContract'

const owners: EnvironmentOwner[] = []
const input = (): EnvironmentPlan => {
  const scene = structuredClone(createCityBlockScene())
  for (const row of [...scene.rgbCameras, ...scene.thermalCameras]) {
    row.width = 8
    row.height = 8
    row.periodTicks = 1
  }
  return {
    profile: 'crebain.cpu-city-environment.v1',
    runId: 'joined-control',
    sourceIdentity: 'd'.repeat(64),
    seed: 4,
    drones: [{ id: 'drone-a', position: [0, 8, 0] }],
    scene,
    acoustic: {
      profile: 'crebain.discrete-direct-acoustic.v1',
      sampleRateHz: 16000,
      soundSpeedMps: 343,
      maximumRangeM: 32,
      referenceDistanceM: 1,
      referencePressurePa: 1,
      bladeCount: 2,
      blockedGain: 0,
      noiseStdPa: 0.001,
      seed: 9,
    },
    thermal: {
      profile: 'crebain.lumped-gray-thermal.v1',
      ambientK: 293.15,
      initialK: 293.15,
      capacityJPerK: 100,
      areaM2: 0.1,
      convectionWPerM2K: 10,
      emissivity: 0.9,
      motorEfficiency: 0.7,
    },
  }
}

/** Synthetic transport controls only. Actual renderer qualification uses the private browser campaign. */
class ControlGraphics implements EnvironmentGraphics {
  readonly generation = crypto.randomUUID()
  plan!: GraphicsPlan
  planSha256 = ''
  mutation: 'none' | 'tick' | 'generation' | 'thermal-nan' | 'rgb' = 'none'
  cleanupFails = false
  hang = false
  captureStarted = false
  rejectPending: ((reason: Error) => void) | null = null
  retired = false
  launch: GraphicsLauncher = async (json) => {
    this.plan = JSON.parse(json) as GraphicsPlan
    this.planSha256 = await graphicsInputDigest(this.plan)
    return this
  }
  diagnostics() {
    return { generation: this.generation, planSha256: this.planSha256 }
  }
  async captureJson(json: string): Promise<string> {
    this.captureStarted = true
    if (this.hang)
      return new Promise((_resolve, reject) => {
        this.rejectPending = reject
      })
    const request = JSON.parse(json) as GraphicsInput
    const pixelRows = (thermal: boolean) =>
      this.plan.scene[thermal ? 'thermalCameras' : 'rgbCameras']
        .filter((camera) => request.tick % camera.periodTicks === 0)
        .map((camera) => {
          const bytes = Buffer.alloc(camera.width * camera.height * 4)
          if (!thermal && this.mutation === 'rgb') bytes[0] = 1
          if (thermal)
            for (let offset = 0; offset < bytes.length; offset += 4)
              bytes.writeFloatLE(this.mutation === 'thermal-nan' ? NaN : 133.29733, offset)
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
      rgb: pixelRows(false),
      thermal: pixelRows(true),
    })
  }
  async retire(): Promise<void> {
    this.retired = true
    this.rejectPending?.(new Error('Control graphics process terminated'))
    this.rejectPending = null
    if (this.cleanupFails) throw new Error('Synthetic unconfirmed process cleanup')
  }
}
async function prepare(
  control = new ControlGraphics()
): Promise<{ owner: EnvironmentOwner; control: ControlGraphics }> {
  const owner = await EnvironmentOwner.prepare(input(), control.launch)
  owners.push(owner)
  return { owner, control }
}
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.retire()
  vi.restoreAllMocks()
})

describe('exact CPU and reconstructed current static-pixel branches', () => {
  it('does not claim graphics cleanup when the launcher returns no authority', async () => {
    const cleanup = vi.spyOn(EnvironmentState.prototype, 'retire')
    const launch = vi.fn(async () => {
      throw new Error('Launcher returned no graphics authority')
    })
    await expect(EnvironmentOwner.prepare(input(), launch)).rejects.toMatchObject({
      primaryFailure: 'Error: Launcher returned no graphics authority',
      cpuCleanup: 'confirmed',
      graphicsCleanup: 'not_returned',
      cleanupErrors: [],
    })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledTimes(1)
    cleanup.mockRestore()
    const healthy = await prepare()
    expect((await healthy.owner.advance()).tick).toBe(1)
  })

  it.each([
    { cpuFails: false, graphicsFails: false },
    { cpuFails: true, graphicsFails: false },
    { cpuFails: false, graphicsFails: true },
    { cpuFails: true, graphicsFails: true },
  ])(
    'attempts both preparation cleanups and preserves the primary failure (CPU=$cpuFails, graphics=$graphicsFails)',
    async ({ cpuFails, graphicsFails }) => {
      const control = new ControlGraphics()
      control.cleanupFails = graphicsFails
      const identity = vi.spyOn(control, 'diagnostics').mockReturnValue({
        generation: 'invalid-generation-with-extra-fields',
        planSha256: '0'.repeat(64),
      })
      const originalRetire = EnvironmentState.prototype.retire
      const cpuCleanup = vi
        .spyOn(EnvironmentState.prototype, 'retire')
        .mockImplementationOnce(function (this: EnvironmentState) {
          originalRetire.call(this)
          if (cpuFails) throw new Error('Synthetic preparation CPU cleanup failure')
        })
      const graphicsCleanup = vi.spyOn(control, 'retire')
      const rejection: unknown = await EnvironmentOwner.prepare(input(), control.launch).catch(
        (error: unknown) => error
      )
      expect(cpuCleanup).toHaveBeenCalledTimes(1)
      expect(graphicsCleanup).toHaveBeenCalledTimes(1)
      expect(control.retired).toBe(true)
      expect(rejection).toMatchObject({
        primaryFailure:
          'Error: Graphics preparation does not bind the requested plan and generation',
        cpuCleanup: cpuFails ? 'unresolved' : 'confirmed',
        graphicsCleanup: graphicsFails ? 'unresolved' : 'confirmed',
        cleanupErrors: [
          ...(cpuFails ? ['CPU: Error: Synthetic preparation CPU cleanup failure'] : []),
          ...(graphicsFails ? ['Graphics: Error: Synthetic unconfirmed process cleanup'] : []),
        ],
      })
      identity.mockRestore()
      cpuCleanup.mockRestore()
      graphicsCleanup.mockRestore()
      const healthy = await prepare()
      expect((await healthy.owner.advance()).tick).toBe(1)
    }
  )

  it.each([false, true])(
    'propagates rejected CPU reconstruction cleanup without allocating graphics (unresolved=%s)',
    async (unresolved) => {
      const { parent, graphics } = await family()
      const checkpoint = await barrier(parent)
      const before = parent.checkpointAudit(checkpoint)
      const originalState = EnvironmentState.prototype.checkpointState
      const changed = vi
        .spyOn(EnvironmentState.prototype, 'checkpointState')
        .mockImplementation(function (this: EnvironmentState, handle) {
          return `${originalState.call(this, handle)} `
        })
      const originalRetire = EnvironmentState.prototype.retire
      const cleanup = vi
        .spyOn(EnvironmentState.prototype, 'retire')
        .mockImplementationOnce(function (this: EnvironmentState) {
          originalRetire.call(this)
          if (unresolved) throw new Error('Synthetic rejected CPU candidate cleanup failure')
        })
      try {
        await parent.fork(checkpoint)
        throw new Error('Expected failed reconstruction')
      } catch (error) {
        expect(error).toBeInstanceOf(EnvironmentForkError)
        expect((error as EnvironmentForkError).primaryFailure).toContain(
          'reconstruction changed state'
        )
        expect((error as EnvironmentForkError).familySlotReleased).toBe(!unresolved)
        expect((error as EnvironmentForkError).cleanupErrors.length).toBe(unresolved ? 1 : 0)
      }
      expect(graphics).toHaveLength(1)
      expect(parent.resourceStatus().reservedOwners).toBe(unresolved ? 2 : 1)
      expect(cleanup).toHaveBeenCalledTimes(1)
      changed.mockRestore()
      cleanup.mockRestore()
      expect(parent.checkpointAudit(checkpoint)).toEqual(before)
      expect((await parent.advance()).tick).toBe(2)
    }
  )

  it('retains unresolved CPU cleanup after a one-shot failure followed by a no-op retry', async () => {
    const control = new ControlGraphics()
    const parent = await EnvironmentOwner.prepare(input(), control.launch)
    const original = EnvironmentState.prototype.retire
    const cleanup = vi
      .spyOn(EnvironmentState.prototype, 'retire')
      .mockImplementationOnce(function (this: EnvironmentState) {
        original.call(this)
        throw new Error('Observed CPU cleanup failure after actual retirement')
      })
      .mockImplementation(() => {})
    await expect(parent.retire()).rejects.toThrow('Observed CPU cleanup failure')
    await expect(parent.retire()).rejects.toThrow('Prior CPU cleanup remains unresolved')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(parent.resourceStatus().reservedOwners).toBe(1)
    cleanup.mockRestore()
    const healthy = await family()
    await healthy.parent.retire()
    expect(healthy.parent.resourceStatus().reservedOwners).toBe(0)
  })

  it('cannot erase failed-transition CPU cleanup through later owner retirement', async () => {
    const control = new ControlGraphics()
    const parent = await EnvironmentOwner.prepare(input(), control.launch)
    const original = EnvironmentState.prototype.retire
    const cleanup = vi
      .spyOn(EnvironmentState.prototype, 'retire')
      .mockImplementationOnce(function (this: EnvironmentState) {
        original.call(this)
        throw new Error('Observed failed-transition CPU cleanup')
      })
      .mockImplementation(() => {})
    control.mutation = 'tick'
    await expect(parent.advance()).rejects.toThrow('generation retired')
    expect(parent.failure()!.cleanupErrors).toContain(
      'Error: Observed failed-transition CPU cleanup'
    )
    await expect(parent.retire()).rejects.toThrow('Prior CPU cleanup remains unresolved')
    expect(parent.resourceStatus().reservedOwners).toBe(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    cleanup.mockRestore()
  })

  async function family(plan = input()) {
    const graphics: ControlGraphics[] = []
    const parent = await EnvironmentOwner.prepare(plan, async (json) => {
      const control = new ControlGraphics()
      graphics.push(control)
      return control.launch(json)
    })
    owners.push(parent)
    return { parent, graphics }
  }
  async function barrier(parent: EnvironmentOwner) {
    const observation = await parent.advance()
    parent.releaseObservation(observation)
    return parent.checkpoint()
  }

  it('rejects missing, leased, not-due, and horizon-ineligible barriers before CPU checkpointing', async () => {
    const cpu = vi.spyOn(EnvironmentState.prototype, 'checkpoint')
    const { parent } = await family()
    await expect(parent.checkpoint()).rejects.toThrow('barrier')
    const lease = await parent.advance()
    await expect(parent.checkpoint()).rejects.toThrow('lease')
    expect(cpu).not.toHaveBeenCalled()
    parent.releaseObservation(lease)
    const checkpoint = await parent.checkpoint()
    expect(cpu).toHaveBeenCalledTimes(1)
    expect(parent.checkpointAudit(checkpoint).cpuCheckpointJson).toContain('acoustic')
    const delayedPlan = input()
    delayedPlan.scene.rgbCameras[0].periodTicks = 2
    const delayed = await family(delayedPlan)
    const delayedLease = await delayed.parent.advance()
    delayed.parent.releaseObservation(delayedLease)
    cpu.mockClear()
    await expect(delayed.parent.checkpoint()).rejects.toThrow('barrier')
    const impossiblePlan = input()
    impossiblePlan.scene.rgbCameras[0].periodTicks = 113
    impossiblePlan.scene.rgbCameras[1].periodTicks = 109
    impossiblePlan.scene.thermalCameras[0].periodTicks = 107
    const impossible = await family(impossiblePlan)
    expect(impossible.parent.checkpointEligibility().barrierPeriodTicks).toBeNull()
    await expect(impossible.parent.checkpoint()).rejects.toThrow('7200')
    expect(cpu).not.toHaveBeenCalled()
  })

  it('keeps fresh matched siblings exact through same-action futures with distinct causal identities', async () => {
    const { parent, graphics } = await family()
    const future = {
      tick: 4,
      droneId: 'drone-a',
      armed: true,
      control: {
        kind: 'motors' as const,
        commands: { front_left: 0.7, front_right: 0.7, rear_left: 0.7, rear_right: 0.7 },
      },
    }
    parent.schedule(future)
    const checkpoint = await barrier(parent)
    const audit = parent.checkpointAudit(checkpoint)
    const left = await parent.fork(checkpoint)
    const right = await parent.fork(checkpoint)
    owners.push(left, right)
    expect(new Set(graphics.map((row) => row.generation)).size).toBe(3)
    expect(left.status().executedTick).toBe(1)
    expect(right.status().acceptedObservationTick).toBe(1)
    expect(() => left.schedule(future)).toThrow('duplicate')
    expect(parent.checkpointAudit(checkpoint)).toEqual(audit)
    for (let tick = 2; tick <= 24; tick++) {
      const a = await left.advance()
      const b = await right.advance()
      const first = JSON.parse(left.readObservation(a))
      const second = JSON.parse(right.readObservation(b))
      expect(first.privilegedReference).toEqual(second.privilegedReference)
      expect(first.pressure).toEqual(second.pressure)
      expect(first.graphics.rgb).toEqual(second.graphics.rgb)
      expect(first.graphics.thermal).toEqual(second.graphics.thermal)
      expect(a.sha256).not.toBe(b.sha256)
      expect(first.ancestry).toMatchObject({
        parentOwnerId: parent.ownerId,
        checkpointSha256: checkpoint.sha256,
        checkpointTick: 1,
        acceptedActionPosition: 1,
      })
      left.releaseObservation(a)
      right.releaseObservation(b)
    }
    const leftCheckpoint = await left.checkpoint()
    const rightCheckpoint = await right.checkpoint()
    expect(left.checkpointAudit(leftCheckpoint).cpuCheckpointJson).toBe(
      right.checkpointAudit(rightCheckpoint).cpuCheckpointJson
    )
    expect(parent.status().executedTick).toBe(1)
    expect(parent.checkpointAudit(checkpoint)).toEqual(audit)
  })

  it('allows interventions only in free future slots and preserves the other branch', async () => {
    const { parent } = await family()
    const checkpoint = await barrier(parent)
    const unchanged = await parent.fork(checkpoint)
    const changed = await parent.fork(checkpoint)
    owners.push(unchanged, changed)
    changed.schedule({
      tick: 2,
      droneId: 'drone-a',
      armed: true,
      control: {
        kind: 'motors',
        commands: { front_left: 0.8, front_right: 0.8, rear_left: 0.8, rear_right: 0.8 },
      },
    })
    const a = await unchanged.advance()
    const b = await changed.advance()
    expect(JSON.parse(unchanged.readObservation(a)).privilegedReference).not.toEqual(
      JSON.parse(changed.readObservation(b)).privilegedReference
    )
    expect(parent.status().executedTick).toBe(1)
  })

  it('rejects copied and released audit handles and retains valid family neighbors', async () => {
    const { parent } = await family()
    const checkpoint = await barrier(parent)
    await expect(parent.fork({ ...checkpoint })).rejects.toThrow('foreign')
    expect(() => parent.checkpointAudit({ ...checkpoint })).toThrow('foreign')
    const children = []
    for (let index = 0; index < 3; index++) children.push(await parent.fork(checkpoint))
    owners.push(...children)
    expect(parent.resourceStatus().reservedOwners).toBe(4)
    await expect(parent.fork(checkpoint)).rejects.toThrow('budget')
    await children[0].retire()
    const replacement = await parent.fork(checkpoint)
    owners.push(replacement)
    parent.releaseCheckpoint(checkpoint)
    await expect(parent.fork(checkpoint)).rejects.toThrow('released')
    expect(parent.resourceStatus().checkpoints).toBe(0)
  })

  it('keeps primary pixel drift and unresolved child cleanup separate without changing the parent lease', async () => {
    let index = 0
    const parent = await EnvironmentOwner.prepare(input(), async (json) => {
      const control = new ControlGraphics()
      if (index++ > 0) {
        control.mutation = 'rgb'
        control.cleanupFails = true
      }
      return control.launch(json)
    })
    owners.push(parent)
    const checkpoint = await barrier(parent)
    const retained = parent.checkpointAudit(checkpoint)
    const lease = await parent.advance()
    const observed = parent.readObservation(lease)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await parent.fork(checkpoint)
        throw new Error('Expected failed child')
      } catch (error) {
        expect(error).toBeInstanceOf(EnvironmentForkError)
        expect((error as EnvironmentForkError).primaryFailure).toContain('pixels changed')
        expect((error as EnvironmentForkError).cleanupErrors).toContain(
          'Error: Synthetic unconfirmed process cleanup'
        )
        expect((error as EnvironmentForkError).familySlotReleased).toBe(false)
      }
    }
    await expect(parent.fork(checkpoint)).rejects.toThrow('budget')
    expect(parent.resourceStatus().reservedOwners).toBe(4)
    expect(parent.resourceStatus().stagingRawBytes).toBe(0)
    expect(parent.readObservation(lease)).toBe(observed)
    expect(parent.checkpointAudit(checkpoint)).toEqual(retained)
    parent.releaseObservation(lease)
    const next = await parent.advance()
    expect(next.tick).toBe(3)
  })

  it('rejects a reused parent graphics port without retiring the parent', async () => {
    const control = new ControlGraphics()
    const parent = await EnvironmentOwner.prepare(input(), control.launch)
    owners.push(parent)
    const checkpoint = await barrier(parent)
    await expect(parent.fork(checkpoint)).rejects.toThrow('already owned')
    expect(control.retired).toBe(false)
    expect(parent.resourceStatus().reservedOwners).toBe(1)
    expect((await parent.advance()).tick).toBe(2)
  })

  it('interrupts a pending candidate and rejects concurrent family reconstruction without late admission', async () => {
    const graphics: ControlGraphics[] = []
    const parent = await EnvironmentOwner.prepare(input(), async (json) => {
      const control = new ControlGraphics()
      if (graphics.length) control.hang = true
      graphics.push(control)
      return control.launch(json)
    })
    owners.push(parent)
    const checkpoint = await barrier(parent)
    const pending = parent.fork(checkpoint)
    const rejection = expect(pending).rejects.toThrow('fork rejected')
    while (!graphics[1]?.captureStarted) await new Promise((resolve) => setTimeout(resolve, 1))
    await expect(parent.fork(checkpoint)).rejects.toThrow('busy')
    expect(parent.resourceStatus().stagingRawBytes).toBeGreaterThan(0)
    await parent.retire()
    await rejection
    expect(graphics[1].retired).toBe(true)
    expect(parent.status().phase).toBe('retired')
    expect(parent.resourceStatus().reservedOwners).toBe(0)
  })
})

describe('joined environment lifecycle with explicit synthetic transport controls', () => {
  it('reports unknown execution while cleanup is still pending after an unobserved CPU return', async () => {
    const { owner, control } = await prepare()
    const original = EnvironmentState.prototype.advance
    vi.spyOn(EnvironmentState.prototype, 'advance').mockImplementationOnce(function (
      this: EnvironmentState
    ) {
      original.call(this)
      throw new Error('CPU transitioned before the caller observed its return')
    })
    let release!: () => void
    let started!: () => void
    const cleanupStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const cleanupGate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(control, 'retire').mockImplementationOnce(async () => {
      started()
      await cleanupGate
    })
    const pending = expect(owner.advance()).rejects.toThrow('generation retired')
    await cleanupStarted
    const during = owner.status()
    release()
    await pending
    expect(during.executedTick).toBeNull()
    expect(during.lastObservedCompletedCpuTick).toBe(0)
    expect(owner.status().executedTick).toBeNull()
    const positive = await prepare()
    await positive.owner.advance()
    expect(positive.owner.status().executedTick).toBe(1)
  })

  it('reserves capacity before allocating physics or launching graphics', async () => {
    const physics = vi.spyOn(EnvironmentState, 'prepare')
    const launch = vi.fn(new ControlGraphics().launch)
    await expect(EnvironmentOwner.prepare(input(), launch, 1)).rejects.toThrow('capacity')
    expect(physics).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    await prepare()
    expect(physics).toHaveBeenCalledTimes(1)
  })

  it('commits one actual CPU/audio step only after the joined output and requires explicit lease release', async () => {
    const { owner } = await prepare()
    const first = await owner.advance()
    const retained = owner.readObservation(first)
    const batch = JSON.parse(retained)
    expect(batch.pressure.sampleStart).toBe(0)
    expect(batch.pressure.sampleEnd).toBe(133)
    expect(JSON.parse(batch.privilegedReference.json).dynamics.tick).toBe(1)
    expect(owner.status()).toMatchObject({
      executedTick: 1,
      acceptedObservationTick: 1,
      leased: true,
    })
    await expect(owner.advance()).rejects.toThrow('lease')
    expect(owner.status().executedTick).toBe(1)
    expect(() => owner.readObservation({ ...first })).toThrow('foreign')
    expect(() => owner.releaseObservation({ ...first })).toThrow('foreign')
    owner.releaseObservation(first)
    expect(() => owner.readObservation(first)).toThrow('released')
    const second = await owner.advance()
    expect(JSON.parse(owner.readObservation(second)).pressure.sampleStart).toBe(133)
    expect(owner.status().acceptedObservationTick).toBe(2)
    expect(JSON.parse(retained).tick).toBe(1)
  })

  it.each(['tick', 'generation', 'thermal-nan'] as const)(
    'retires after actual CPU execution when required graphics has %s drift',
    async (mutation) => {
      const { owner, control } = await prepare()
      const first = await owner.advance()
      owner.releaseObservation(first)
      control.mutation = mutation
      await expect(owner.advance()).rejects.toThrow('generation retired')
      const failure = owner.failure()!
      expect(failure).toMatchObject({
        attemptedTick: 2,
        executedTick: 2,
        acceptedObservationTick: 1,
        completeSensorObservation: false,
        knownCpuStateStatus: 'captured',
      })
      expect(failure.knownCpuState!.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.parse(failure.knownCpuState!.json).dynamics.clock.tick).toBe(2)
      expect(control.retired).toBe(true)
      await expect(owner.advance()).rejects.toThrow('retired')
      expect(() =>
        owner.schedule({
          tick: 3,
          droneId: 'drone-a',
          armed: false,
          control: {
            kind: 'motors',
            commands: { front_left: 0, front_right: 0, rear_left: 0, rear_right: 0 },
          },
        })
      ).toThrow('retired')
      const positive = await prepare()
      expect((await positive.owner.advance()).tick).toBe(1)
    }
  )

  it('retirement interrupts pending graphics and cannot accept a late observation', async () => {
    const { owner, control } = await prepare()
    control.hang = true
    const operation = owner.advance()
    const rejection = expect(operation).rejects.toThrow('generation retired')
    await vi.waitFor(() => expect(control.captureStarted).toBe(true))
    await owner.retire()
    await rejection
    expect(owner.failure()).toMatchObject({
      executedTick: 1,
      acceptedObservationTick: 0,
      completeSensorObservation: false,
    })
  })

  it('does not invent an executed tick when the CPU transition itself fails without an observation', async () => {
    const { owner } = await prepare()
    const actual = EnvironmentState.prototype.advance
    const failure = vi.spyOn(EnvironmentState.prototype, 'advance').mockImplementation(function (
      this: EnvironmentState
    ) {
      actual.call(this)
      throw new Error('Indeterminate CPU control')
    })
    await expect(owner.advance()).rejects.toThrow('generation retired')
    expect(owner.failure()).toMatchObject({
      attemptedTick: 1,
      executedTick: null,
      acceptedObservationTick: 0,
    })
    expect(owner.status()).toMatchObject({ executedTick: null, lastObservedCompletedCpuTick: 0 })
    expect(JSON.parse(owner.failure()!.knownCpuState!.json).dynamics.clock.tick).toBe(1)
    failure.mockRestore()
    const positive = await prepare()
    await positive.owner.advance()
    expect(positive.owner.status()).toMatchObject({
      executedTick: 1,
      lastObservedCompletedCpuTick: 1,
    })
  })
})
