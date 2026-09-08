// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import example from '../../../examples/native-environment/force-ground-run.json'
import {
  EnvironmentState,
  type FORCE_GROUND_PROFILE,
  type EnvironmentPlan,
} from '../EnvironmentState'
import { AcousticState } from '../AcousticObservation'
import { ThermalState } from '../ThermalObservation'
import { createCityBlockScene } from '../SceneSpec'
import {
  DeterministicDroneWorld,
  FORCE_PROFILE,
  CONTROLLED_RETURN_BYTES,
  type ScheduledDynamicsAction,
} from '../../physics/DeterministicDroneWorld'
import { DronePhysicsWorld } from '../../physics/DronePhysics'

type ForcePlan = Extract<EnvironmentPlan, { profile: typeof FORCE_GROUND_PROFILE }>
const plan = () => structuredClone(example.plan) as unknown as ForcePlan
const action = (tick = 1): ScheduledDynamicsAction =>
  ({ ...structuredClone(example.actions[0]), tick }) as ScheduledDynamicsAction
const owners: Array<{ retire(): void }> = []
async function prepare(input = plan()) {
  const owner = await EnvironmentState.prepare(input)
  owners.push(owner)
  return owner
}
async function state(owner: EnvironmentState) {
  const handle = await owner.checkpoint()
  const json = owner.checkpointState(handle)
  owner.releaseCheckpoint(handle)
  return json
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const owner of owners.splice(0)) owner.retire()
})

describe('one-drone force-ground CPU ownership', () => {
  it.each(['two-drones', 'solid', 'engine', 'extra', 'city-controller'] as const)(
    'rejects %s before allocating physics and retains valid preparation',
    async (mutation) => {
      const input = plan()
      if (mutation === 'two-drones') input.drones.push({ id: 'drone-001', position: [1, 8, 0] })
      if (mutation === 'solid') input.scene.solids = [createCityBlockScene().solids[0]]
      if (mutation === 'engine') Object.assign(input.controller, { engineModel: 'unknown' })
      if (mutation === 'extra') Object.assign(input, { staticGeometry: [] })
      if (mutation === 'city-controller')
        Object.assign(input, { profile: 'crebain.cpu-city-environment.v1' })
      const allocate = vi.spyOn(DeterministicDroneWorld, 'prepare')
      await expect(EnvironmentState.prepare(input)).rejects.toThrow()
      expect(allocate).not.toHaveBeenCalled()
      await prepare()
      expect(allocate).toHaveBeenCalledTimes(1)
    }
  )

  it('requires explicit first-tick control and reserves output before mutation', async () => {
    const owner = await prepare()
    expect(() => owner.advance()).toThrow('advanceControlled')
    await expect(owner.advanceControlled()).rejects.toThrow('explicitly scheduled')
    owner.schedule(action(2))
    await expect(owner.advanceControlled()).rejects.toThrow('explicitly scheduled')
    owner.schedule(action())
    const before = await state(owner)
    await expect(owner.advanceControlled(CONTROLLED_RETURN_BYTES - 1)).rejects.toThrow(
      'reservation'
    )
    expect(await state(owner)).toBe(before)
    expect((await owner.advanceControlled()).transition.action.tick).toBe(1)
  })

  it.each(['yaw-rate', 'tilt', 'heading', 'altitude', 'duplicate', 'stale'] as const)(
    'rejects %s without changing accepted history',
    async (mutation) => {
      const owner = await prepare()
      owner.schedule(action())
      await owner.advanceControlled()
      const next = action(2)
      if (mutation === 'yaw-rate') Object.assign(next.control, { yawRate: 0 })
      if (mutation === 'tilt') Object.assign(next.control, { roll_rad: 0.12 })
      if (mutation === 'heading') Object.assign(next.control, { heading_rad: 0.21 })
      if (mutation === 'altitude') Object.assign(next.control, { altitude_m: 8.51 })
      if (mutation === 'duplicate') owner.schedule(next)
      if (mutation === 'stale') next.tick = 1
      const before = await state(owner)
      expect(() => owner.schedule(next)).toThrow()
      expect(await state(owner)).toBe(before)
      expect((await owner.advanceControlled()).transition.tick).toBe(2)
    }
  )

  it('matches direct qualified dynamics and advances actual thermal and pressure models once', async () => {
    const input = plan()
    const owner = await prepare(input)
    const direct = await DeterministicDroneWorld.prepare({
      profile: FORCE_PROFILE,
      geometry: 'ground-cuboid-v1',
      capabilities: ['dynamics', 'force_attitude_height'],
      runId: input.runId,
      sourceIdentity: input.sourceIdentity,
      seed: input.seed,
      drones: input.drones,
      controller: input.controller,
    })
    owners.push(direct)
    const thermal = new ThermalState(input.thermal, 1)
    const acoustic = new AcousticState(input.acoustic, input.scene, 1)
    const changed = action(4)
    Object.assign(changed.control, { heading_rad: 0.04, pitch_rad: 0.03 })
    for (const accepted of [action(), changed]) {
      owner.schedule(accepted)
      direct.schedule(accepted)
    }
    for (let tick = 1; tick <= 8; tick++) {
      const coupled = await owner.advanceControlled()
      const reference = await direct.advanceControlled()
      expect(coupled.transition).toEqual(reference)
      expect(coupled.transition.action.tick).toBe(tick < 4 ? 1 : 4)
      const sources = direct.mechanicalSources()
      thermal.advance(sources.map((source) => source.mechanicalPowerW))
      expect(coupled.pressure).toEqual(
        acoustic.advance(sources.map(({ position, rpm }) => ({ position, rpm })))
      )
      expect(owner.reference().temperaturesK).toEqual(thermal.temperatures())
      expect(owner.reference().dynamics).toEqual(direct.observe())
    }
    expect(owner.reference().temperaturesK[0]).toBeGreaterThan(input.thermal.initialK)
  })

  it('awaits complete controlled reconstruction with an accepted future action', async () => {
    const parent = await prepare()
    parent.schedule(action())
    const future = action(5)
    Object.assign(future.control, { roll_rad: 0.02 })
    parent.schedule(future)
    for (let tick = 0; tick < 3; tick++) await parent.advanceControlled()
    const checkpoint = await parent.checkpoint()
    const child = await parent.fork(checkpoint)
    owners.push(child)
    expect(await state(child)).toBe(parent.checkpointState(checkpoint))
    for (let tick = 0; tick < 4; tick++)
      expect(await child.advanceControlled()).toEqual(await parent.advanceControlled())
    await parent.restore(checkpoint)
    expect(await state(parent)).toBe(parent.checkpointState(checkpoint))
    parent.releaseCheckpoint(checkpoint)
  })

  it.each(['thermal', 'acoustic'] as const)(
    'retains completed physics when %s fails',
    async (sensor) => {
      const owner = await prepare()
      owner.schedule(action())
      const failure =
        sensor === 'thermal'
          ? vi.spyOn(ThermalState.prototype, 'advance').mockImplementationOnce(() => {
              throw new Error('thermal failure')
            })
          : vi.spyOn(AcousticState.prototype, 'advance').mockImplementationOnce(() => {
              throw new Error('acoustic failure')
            })
      await expect(owner.advanceControlled()).rejects.toMatchObject({
        outcome: {
          executedTick: 1,
          lastCompletedTick: 1,
          lastAcceptedControlTick: 1,
          transition: { tick: 1 },
          thermalComplete: sensor === 'acoustic',
          acousticComplete: false,
          cleanupConfirmed: true,
        },
      })
      expect(() => owner.reference()).toThrow('retired')
      failure.mockRestore()
      const healthy = await prepare()
      healthy.schedule(action())
      expect((await healthy.advanceControlled()).transition.tick).toBe(1)
    }
  )

  it('preserves unknown execution from the qualified engine failure outcome', async () => {
    const owner = await prepare()
    owner.schedule(action())
    const actual = DronePhysicsWorld.prototype.advanceTicks
    const failure = vi
      .spyOn(DronePhysicsWorld.prototype, 'advanceTicks')
      .mockImplementationOnce(function (this: DronePhysicsWorld, ticks) {
        actual.call(this, ticks)
        throw new Error('Engine changed before returning')
      })
    await expect(owner.advanceControlled()).rejects.toMatchObject({
      outcome: {
        executedTick: null,
        lastCompletedTick: 0,
        lastAcceptedControlTick: 0,
        transition: null,
        thermalComplete: false,
        acousticComplete: false,
      },
    })
    failure.mockRestore()
    const healthy = await prepare()
    healthy.schedule(action())
    expect((await healthy.advanceControlled()).transition.tick).toBe(1)
  })
})
