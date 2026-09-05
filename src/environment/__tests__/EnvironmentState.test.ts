// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentState, type EnvironmentPlan } from '../EnvironmentState'
import { createCityBlockScene } from '../SceneSpec'
import * as thermalObservation from '../ThermalObservation'
import type { ScheduledDynamicsAction } from '../../physics/DeterministicDroneWorld'
import { DeterministicDroneWorld } from '../../physics/DeterministicDroneWorld'

const owners: EnvironmentState[] = []
const input = (count = 1): EnvironmentPlan => ({
  profile: 'crebain.cpu-city-environment.v1',
  runId: 'environment-control',
  sourceIdentity: 'c'.repeat(64),
  seed: 9,
  drones: Array.from({ length: count }, (_, index) => ({
    id: `drone-${String(index).padStart(3, '0')}`,
    position: [0, 12, index * 0.7],
  })),
  scene: createCityBlockScene(),
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
    seed: 28,
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
})
const action = (tick = 1, id = 'drone-000'): ScheduledDynamicsAction => ({
  tick,
  droneId: id,
  armed: true,
  control: {
    kind: 'motors',
    commands: { front_left: 0.6, front_right: 0.6, rear_left: 0.6, rear_right: 0.6 },
  },
})
async function prepare(plan = input()): Promise<EnvironmentState> {
  const owner = await EnvironmentState.prepare(plan)
  owners.push(owner)
  return owner
}
async function completeState(owner: EnvironmentState): Promise<string> {
  const h = await owner.checkpoint()
  const value = owner.checkpointState(h)
  owner.releaseCheckpoint(h)
  return value
}
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.retire())
  vi.restoreAllMocks()
})

describe('complete CPU city environment state', () => {
  it.each([false, true])(
    'preserves CPU preparation failure separately from cleanup (cleanupFails=%s)',
    async (cleanupFails) => {
      const primary = new Error('Synthetic failure after thermal construction')
      const cleanupFailure = new Error('Synthetic dynamics preparation cleanup failure')
      const OriginalThermalState = thermalObservation.ThermalState
      const construction = vi.spyOn(thermalObservation, 'ThermalState').mockImplementationOnce(
        class extends OriginalThermalState {
          constructor(...args: ConstructorParameters<typeof OriginalThermalState>) {
            super(...args)
            throw primary
          }
        }
      )
      const originalRetire = DeterministicDroneWorld.prototype.retire
      const cleanup = vi
        .spyOn(DeterministicDroneWorld.prototype, 'retire')
        .mockImplementationOnce(function (this: DeterministicDroneWorld) {
          originalRetire.call(this)
          if (cleanupFails) throw cleanupFailure
        })
      const rejection: unknown = await EnvironmentState.prepare(input()).catch(
        (error: unknown) => error
      )
      if (cleanupFails) {
        expect(rejection).toBeInstanceOf(AggregateError)
        expect(rejection).toMatchObject({ cause: primary, errors: [primary, cleanupFailure] })
      } else expect(rejection).toBe(primary)
      expect(cleanup).toHaveBeenCalledTimes(1)
      construction.mockRestore()
      cleanup.mockRestore()
      const healthy = await prepare()
      expect(healthy.advance().sampleEnd).toBe(133)
    }
  )

  it.each([false, true])(
    'preserves CPU transition failure separately from cleanup (cleanupFails=%s)',
    async (cleanupFails) => {
      const owner = await EnvironmentState.prepare(input())
      const primary = new Error('Synthetic sensor failure after actual CPU transition')
      const cleanupFailure = new Error('Synthetic dynamics transition cleanup failure')
      const sensor = vi
        .spyOn(DeterministicDroneWorld.prototype, 'mechanicalSources')
        .mockImplementationOnce(() => {
          throw primary
        })
      const originalRetire = DeterministicDroneWorld.prototype.retire
      const cleanup = vi
        .spyOn(DeterministicDroneWorld.prototype, 'retire')
        .mockImplementationOnce(function (this: DeterministicDroneWorld) {
          originalRetire.call(this)
          if (cleanupFails) throw cleanupFailure
        })
      let rejection: unknown
      try {
        owner.advance()
      } catch (error) {
        rejection = error
      }
      if (cleanupFails) {
        expect(rejection).toBeInstanceOf(AggregateError)
        expect(rejection).toMatchObject({ cause: primary })
        expect((rejection as AggregateError).errors[0]).toBe(primary)
        expect((rejection as AggregateError).errors[1]).toMatchObject({ cause: cleanupFailure })
      } else expect(rejection).toMatchObject({ cause: primary })
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(owner.resourceStatus().cleanup).toBe(cleanupFails ? 'unresolved' : 'confirmed')
      expect(() => owner.advance()).toThrow('retired')
      sensor.mockRestore()
      cleanup.mockRestore()
      const healthy = await prepare()
      expect(healthy.advance().sampleEnd).toBe(133)
    }
  )

  it('uses actual rotor power and pressure while keeping temperatures explicitly privileged', async () => {
    const owner = await prepare()
    owner.schedule(action())
    let hasPressure = false
    for (let step = 0; step < 120; step++) {
      const pressure = owner.advance()
      hasPressure ||= pressure.channels.some((channel) =>
        channel.some((value) => Math.abs(value) > 0.01)
      )
    }
    expect(hasPressure).toBe(true)
    expect(owner.reference().temperaturesK[0]).toBeGreaterThan(293.15)
    const state = JSON.parse(await completeState(owner))
    expect(state.dynamics.physics.staticGeometry).toHaveLength(16)
    expect(state.acoustic.sample).toBe(16000)
    expect(state.thermal.tick).toBe(120)
    expect(
      state.dynamics.physics.drones[0].rotors.some((rotor: { rpm: number }) => rotor.rpm > 0)
    ).toBe(true)
  })

  it('reconstructs complete sensor state and accepted future actions before long independent continuations', async () => {
    const owner = await prepare()
    owner.schedule(action())
    owner.schedule({ ...action(70), armed: false })
    for (let tick = 0; tick < 30; tick++) owner.advance()
    const checkpoint = await owner.checkpoint()
    const original = owner.checkpointState(checkpoint)
    const a = await owner.fork(checkpoint)
    owners.push(a)
    const b = await owner.fork(checkpoint)
    owners.push(b)
    expect(await completeState(a)).toBe(original)
    expect(await completeState(b)).toBe(original)
    for (let tick = 0; tick < 180; tick++) {
      const right = b.advance()
      const left = a.advance()
      expect(left).toEqual(right)
      expect(owner.advance()).toEqual(right)
    }
    expect(await completeState(a)).toBe(await completeState(b))
    expect(await completeState(a)).toBe(await completeState(owner))
    await owner.restore(checkpoint)
    expect(await completeState(owner)).toBe(original)
    a.schedule(action(211))
    // A source change cannot reach the microphones before its propagation delay.
    expect(a.advance()).toEqual(b.advance())
    let changed = false
    for (let tick = 0; tick < 20; tick++) {
      const left = a.advance()
      const right = b.advance()
      changed ||= left.channels.some((channel, index) =>
        channel.some((value, sample) => value !== right.channels[index][sample])
      )
    }
    expect(changed).toBe(true)
    expect(await completeState(owner)).toBe(original)
  })

  it('reconstructs a 32-drone city through the same actual dynamics and sensor code', async () => {
    const plan = input(32)
    const owner = await prepare(plan)
    plan.drones.forEach((drone) => owner.schedule(action(1, drone.id)))
    for (let tick = 0; tick < 24; tick++) owner.advance()
    const checkpoint = await owner.checkpoint()
    const branch = await owner.fork(checkpoint)
    owners.push(branch)
    for (let tick = 0; tick < 96; tick++) expect(owner.advance()).toEqual(branch.advance())
    expect(await completeState(branch)).toBe(await completeState(owner))
    expect(branch.reference().dynamics.drones).toHaveLength(32)
  })

  it('rejects foreign, altered, and released checkpoint handles without changing the owner', async () => {
    const owner = await prepare()
    const checkpoint = await owner.checkpoint()
    const before = await completeState(owner)
    await expect(owner.restore({ ...checkpoint })).rejects.toThrow('foreign')
    expect(await completeState(owner)).toBe(before)
    owner.releaseCheckpoint(checkpoint)
    await expect(owner.fork(checkpoint)).rejects.toThrow('released')
    const fresh = await owner.checkpoint()
    const branch = await owner.fork(fresh)
    owners.push(branch)
    expect(await completeState(branch)).toBe(before)
  })

  it('limits each family to one reconstruction and releases the reservation after completion', async () => {
    const owner = await prepare()
    const checkpoint = await owner.checkpoint()
    const branch = await owner.fork(checkpoint)
    owners.push(branch)
    const branchCheckpoint = await branch.checkpoint()
    const first = owner.restore(checkpoint)
    expect(owner.resourceStatus().reconstructionCheckpointBytes).toBe(64 * 1024 * 1024)
    expect(owner.resourceStatus().temporaryRestoreOwners).toBe(1)
    await expect(branch.restore(branchCheckpoint)).rejects.toThrow('reconstruction is busy')
    await first
    expect(owner.resourceStatus().reconstructionCheckpointBytes).toBe(0)
    expect(owner.resourceStatus().temporaryRestoreOwners).toBe(0)
    await expect(branch.restore(branchCheckpoint)).resolves.toBeUndefined()
    expect(await completeState(branch)).toBe(await completeState(owner))
  })

  it.each([
    { operation: 'fork' as const, unresolved: false },
    { operation: 'fork' as const, unresolved: true },
    { operation: 'restore' as const, unresolved: false },
    { operation: 'restore' as const, unresolved: true },
  ])(
    'accounts for an acquired verification checkpoint after $operation cleanup (unresolved=$unresolved)',
    async ({ operation, unresolved }) => {
      const owner = await prepare()
      const checkpoint = await owner.checkpoint()
      const before = owner.checkpointState(checkpoint)
      const candidates: EnvironmentState[] = []
      const changed = vi
        .spyOn(EnvironmentState.prototype, 'checkpointState')
        .mockImplementationOnce(function (this: EnvironmentState) {
          candidates.push(this)
          expect(this.resourceStatus().retainedCheckpoints).toBe(1)
          throw new Error('Synthetic verification read failure after checkpoint acquisition')
        })
      const originalRetire = EnvironmentState.prototype.retire
      const cleanup = vi
        .spyOn(EnvironmentState.prototype, 'retire')
        .mockImplementationOnce(function (this: EnvironmentState) {
          if (unresolved) throw new Error('Synthetic candidate cleanup failure before retirement')
          originalRetire.call(this)
        })
      try {
        await expect(owner[operation](checkpoint)).rejects.toMatchObject({
          primaryFailure: 'Error: Synthetic verification read failure after checkpoint acquisition',
          cleanupConfirmed: !unresolved,
          cleanupFailure: unresolved
            ? 'Error: Synthetic candidate cleanup failure before retirement'
            : null,
        })
        const candidate = candidates[0]
        expect(candidate).toBeDefined()
        expect(candidate.resourceStatus().retainedCheckpoints).toBe(unresolved ? 1 : 0)
        expect(owner.resourceStatus()).toMatchObject({
          retainedOwners: operation === 'fork' && unresolved ? 2 : 1,
          temporaryRestoreOwners: operation === 'restore' && unresolved ? 1 : 0,
          reconstructionCheckpointBytes: unresolved ? 64 * 1024 * 1024 : 0,
        })
        changed.mockRestore()
        cleanup.mockRestore()
        expect(owner.checkpointState(checkpoint)).toBe(before)
        if (unresolved) {
          await expect(owner.restore(checkpoint)).rejects.toThrow('unresolved cleanup')
          await expect(owner.fork(checkpoint)).rejects.toThrow('unresolved cleanup')
        } else {
          await expect(owner.restore(checkpoint)).resolves.toBeUndefined()
          expect(owner.resourceStatus().reconstructionCheckpointBytes).toBe(0)
        }
      } finally {
        changed.mockRestore()
        cleanup.mockRestore()
        // The test retains its injected candidate. Production admission has no such authority.
        if (candidates[0]) originalRetire.call(candidates[0])
      }
      if (unresolved) {
        // External test cleanup does not authorize changing the owner's unresolved disposition.
        expect(owner.resourceStatus().reconstructionCheckpointBytes).toBe(64 * 1024 * 1024)
      }
      const healthy = await prepare()
      const healthyCheckpoint = await healthy.checkpoint()
      await expect(healthy.restore(healthyCheckpoint)).resolves.toBeUndefined()
      expect(healthy.resourceStatus().temporaryRestoreOwners).toBe(0)
      expect(healthy.resourceStatus().reconstructionCheckpointBytes).toBe(0)
    }
  )

  it('does not turn unresolved underlying cleanup into success on an idempotent retry', async () => {
    const owner = await EnvironmentState.prepare(input())
    const original = DeterministicDroneWorld.prototype.retire
    const cleanup = vi
      .spyOn(DeterministicDroneWorld.prototype, 'retire')
      .mockImplementationOnce(function (this: DeterministicDroneWorld) {
        original.call(this)
        throw new Error('Observed dynamics cleanup failure')
      })
      .mockImplementation(() => {})
    expect(() => owner.retire()).toThrow('remains unresolved')
    expect(() => owner.retire()).toThrow('remains unresolved')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(owner.resourceStatus()).toMatchObject({ cleanup: 'unresolved', retainedOwners: 1 })
    cleanup.mockRestore()
    const positive = await prepare()
    positive.retire()
    expect(positive.resourceStatus()).toMatchObject({ cleanup: 'confirmed', retainedOwners: 0 })
  })

  it('retires the CPU owner after a post-transition sensor-domain failure', async () => {
    const plan = input()
    plan.drones[0].position = [1001, 12, 0]
    await expect(prepare(plan)).rejects.toThrow('finite')
    const owner = await prepare()
    const invalid = vi
      .spyOn(DeterministicDroneWorld.prototype, 'mechanicalSources')
      .mockReturnValue([
        { id: 'drone-000', position: [1001, 12, 0], rpm: [0, 0, 0, 0], mechanicalPowerW: 0 },
      ])
    expect(() => owner.advance()).toThrow('owner retired')
    expect(() => owner.reference()).toThrow('retired')
    invalid.mockRestore()
    const valid = await prepare()
    expect(valid.advance().sampleEnd).toBe(133)
  })
})
