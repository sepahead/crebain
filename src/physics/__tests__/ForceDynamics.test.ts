// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  CONTROLLED_RETURN_BYTES,
  ControlledAdvanceError,
  DynamicsCleanupError,
  DYNAMICS_PROFILE,
  FORCE_PROFILE,
  DeterministicDroneWorld,
  type DynamicsPlan,
  type ScheduledDynamicsAction,
} from '../DeterministicDroneWorld'
import {
  ALLOCATION_POLICY,
  ENGINE_MODEL,
  LIMITS,
  compute,
  type ForceControllerConfig,
  type Target,
} from '../ForceAttitudeController'
import { DronePhysicsWorld } from '../DronePhysics'

const owners: DeterministicDroneWorld[] = []
const config: ForceControllerConfig = {
  engineModel: ENGINE_MODEL,
  referenceAltitudeM: 23,
  referenceHeadingRad: 0,
}
const target = (): Target => ({
  kind: 'force_attitude_height',
  roll_rad: 0,
  pitch_rad: 0,
  heading_rad: 0,
  altitude_m: 23,
})
const plan = (): DynamicsPlan => ({
  profile: FORCE_PROFILE,
  runId: 'force-control',
  sourceIdentity: 'c'.repeat(64),
  seed: 17,
  geometry: 'ground-cuboid-v1',
  capabilities: ['dynamics', 'force_attitude_height'],
  controller: { ...config },
  drones: [{ id: 'drone-a', position: [0, 23, 0] }],
})
const action = (tick = 1): ScheduledDynamicsAction => ({
  tick,
  droneId: 'drone-a',
  armed: true,
  control: target(),
})
async function prepare(input = plan()) {
  const owner = await DeterministicDroneWorld.prepare(input)
  owners.push(owner)
  return owner
}
async function checkpoint(owner: DeterministicDroneWorld) {
  const handle = await owner.checkpoint()
  const serialized = owner.checkpointState(handle)
  owner.releaseCheckpoint(handle)
  return { sha256: handle.sha256, serialized }
}
afterEach(() => {
  vi.restoreAllMocks()
  owners.splice(0).forEach((owner) => owner.retire())
})

describe('explicit force-controller native ownership', () => {
  it('retires corrupted owned state before physics while leaving a fresh owner usable', async () => {
    const owner = await prepare()
    owner.schedule(action())
    const get = DronePhysicsWorld.prototype.getAllDrones
    vi.spyOn(DronePhysicsWorld.prototype, 'getAllDrones').mockImplementationOnce(function (
      this: DronePhysicsWorld
    ) {
      const rows = get.call(this)
      rows[0].state.velocity.x = NaN
      return rows
    })
    const step = vi.spyOn(DronePhysicsWorld.prototype, 'advanceTicks')
    await expect(owner.advanceControlled()).rejects.toMatchObject({
      outcome: {
        executedTick: 0,
        mutationStarted: false,
        lastAcceptedTick: 0,
        cleanupConfirmed: true,
      },
    })
    expect(step).not.toHaveBeenCalled()
    expect(owner.controlledStatus().phase).toBe('retired')
    await expect(owner.advanceControlled()).rejects.toThrow('retired')
    const fresh = await prepare()
    fresh.schedule(action())
    expect((await fresh.advanceControlled()).tick).toBe(1)
  })
  it('retains an unconfirmed retirement outcome across a later no-op call', async () => {
    const owner = await prepare()
    const destroy = DronePhysicsWorld.prototype.destroy
    const cleanup = vi
      .spyOn(DronePhysicsWorld.prototype, 'destroy')
      .mockImplementationOnce(function (this: DronePhysicsWorld) {
        destroy.call(this)
        throw new Error('reported cleanup failure after actual free')
      })
    expect(() => owner.retire()).toThrow('reported cleanup failure')
    expect(cleanup).toHaveBeenCalledOnce()
    cleanup.mockRestore()
    expect(() => owner.retire()).toThrow('reported cleanup failure')
    expect(owner.controlledStatus()).toMatchObject({ phase: 'retired', cleanupConfirmed: false })
    // The fixture actually freed the world before reporting failure. Preserve the failed disposition.
    owners.splice(owners.indexOf(owner), 1)
    const fresh = await prepare()
    fresh.retire()
    expect(() => fresh.retire()).not.toThrow()
    expect(fresh.controlledStatus().cleanupConfirmed).toBe(true)
  })

  it('keeps unresolved reconstruction slots charged and reserves restore capacity before creation', async () => {
    const owner = await prepare()
    const handle = await owner.checkpoint()
    const before = owner.checkpointState(handle)
    const inspect = DronePhysicsWorld.prototype.checkpoint
    vi.spyOn(DronePhysicsWorld.prototype, 'checkpoint').mockImplementation(function (
      this: DronePhysicsWorld
    ) {
      const copied = JSON.parse(inspect.call(this).serialized)
      copied.drones[0].battery = 0.5
      return { serialized: JSON.stringify(copied) }
    })
    const destroy = DronePhysicsWorld.prototype.destroy
    const cleanup = vi.spyOn(DronePhysicsWorld.prototype, 'destroy').mockImplementation(function (
      this: DronePhysicsWorld
    ) {
      destroy.call(this)
      throw new Error('candidate cleanup reported failure after actual free')
    })
    for (let attempt = 0; attempt < 7; attempt++) {
      await expect(owner.fork(handle)).rejects.toMatchObject({
        cleanupConfirmed: false,
        errors: [
          expect.objectContaining({
            message: 'Exact action-prefix reconstruction changed complete dynamics state',
          }),
          expect.objectContaining({
            message: 'candidate cleanup reported failure after actual free',
          }),
        ],
      })
    }
    expect(cleanup).toHaveBeenCalledTimes(7)
    const initialize = vi.spyOn(DronePhysicsWorld.prototype, 'init')
    await expect(owner.fork(handle)).rejects.toThrow('budget')
    await expect(owner.restore(handle)).rejects.toThrow('budget')
    expect(initialize).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect((await checkpoint(owner)).serialized).toBe(before)
  })

  it('reclaims confirmed failed candidates and restores successfully without retaining a temporary checkpoint', async () => {
    const owner = await prepare()
    const handle = await owner.checkpoint()
    const before = owner.checkpointState(handle)
    const inspect = DronePhysicsWorld.prototype.checkpoint
    const capture = vi
      .spyOn(DronePhysicsWorld.prototype, 'checkpoint')
      .mockImplementation(function (this: DronePhysicsWorld) {
        const copied = JSON.parse(inspect.call(this).serialized)
        copied.drones[0].battery = 0.5
        return { serialized: JSON.stringify(copied) }
      })
    for (let attempt = 0; attempt < 9; attempt++)
      await expect(owner.fork(handle)).rejects.toThrow('complete dynamics state')
    capture.mockRestore()
    await owner.restore(handle)
    expect((await checkpoint(owner)).serialized).toBe(before)
    const branch = await owner.fork(handle)
    owners.push(branch)
    expect((await checkpoint(branch)).serialized).toBe(before)
  })

  it('retains prior-world cleanup uncertainty after a restored replacement retires normally', async () => {
    const owner = await prepare()
    const handle = await owner.checkpoint()
    const destroy = DronePhysicsWorld.prototype.destroy
    const cleanup = vi
      .spyOn(DronePhysicsWorld.prototype, 'destroy')
      .mockImplementationOnce(function (this: DronePhysicsWorld) {
        destroy.call(this)
        throw new Error('prior world cleanup report failed')
      })
    await expect(owner.restore(handle)).rejects.toBeInstanceOf(DynamicsCleanupError)
    expect(cleanup).toHaveBeenCalledTimes(2)
    cleanup.mockRestore()
    expect(() => owner.retire()).toThrow('unresolved cleanup')
    expect(owner.controlledStatus().cleanupConfirmed).toBe(false)
    owners.splice(owners.indexOf(owner), 1)
  })

  it('rejects an absent target and insufficient return allowance before any effect', async () => {
    const owner = await prepare()
    const before = await checkpoint(owner)
    const advance = vi.spyOn(DronePhysicsWorld.prototype, 'advanceTicks')
    await expect(owner.advanceControlled()).rejects.toThrow('explicitly scheduled')
    expect(await checkpoint(owner)).toEqual(before)
    owner.schedule(action())
    const scheduled = await checkpoint(owner)
    await expect(owner.advanceControlled(CONTROLLED_RETURN_BYTES - 1)).rejects.toThrow(
      'before mutation'
    )
    expect(advance).not.toHaveBeenCalled()
    expect(await checkpoint(owner)).toEqual(scheduled)
    const result = await owner.advanceControlled()
    expect(result.tick).toBe(1)
    expect(result.beforeStateSha256).toBe(scheduled.sha256)
    expect(result.afterStateSha256).toBe((await checkpoint(owner)).sha256)
    expect(owner.controlledStatus()).toMatchObject({
      phase: 'active',
      executedTick: 1,
      lastAcceptedTick: 1,
    })
    result.after.state.position[1] = 700
    result.observation.drones[0].position[1] = 800
    if (result.action.control.kind === 'force_attitude_height') {
      result.action.control.roll_rad = -0.09
      result.action.control.altitude_m = 900
    }
    result.appliedMotorTargets.front_left = 0
    expect((await checkpoint(owner)).sha256).toBe(result.afterStateSha256)
    expect(owner.observe().drones[0].position[1]).toBeLessThan(24)
    const other = await prepare()
    other.schedule(action())
    await other.advanceControlled()
    for (let tick = 0; tick < 12; tick++) {
      expect((await owner.advanceControlled()).afterStateSha256).toBe(
        (await other.advanceControlled()).afterStateSha256
      )
    }
  })

  it('publishes independently mutable nested motor actions without changing retained control', async () => {
    const owner = await prepare(),
      other = await prepare()
    const motors: ScheduledDynamicsAction = {
      ...action(),
      control: {
        kind: 'motors',
        commands: {
          front_left: 0.5,
          front_right: 0.5,
          rear_left: 0.5,
          rear_right: 0.5,
        },
      },
    }
    owner.schedule(motors)
    other.schedule(motors)
    const output = await owner.advanceControlled()
    await other.advanceControlled()
    if (output.action.control.kind === 'motors') output.action.control.commands.front_right = 1
    output.before.rotors[0].position[0] = 400
    output.after.rotors[0].rpm = 300
    expect((await checkpoint(owner)).sha256).toBe(output.afterStateSha256)
    for (let tick = 0; tick < 12; tick++)
      expect((await owner.advanceControlled()).afterStateSha256).toBe(
        (await other.advanceControlled()).afterStateSha256
      )
  })

  it('keeps profile selection immutable and old checkpoint serialization separate', async () => {
    const owner = await prepare()
    expect(() => owner.advance(1)).toThrow('advanceControlled')
    expect(() =>
      owner.schedule({
        ...action(),
        control: { kind: 'attitude', roll: 0, pitch: 0, yawRate: 0, altitude: 23 },
      })
    ).toThrow('Unsupported')
    const legacy = await prepare({
      profile: DYNAMICS_PROFILE,
      runId: 'old-control',
      sourceIdentity: 'd'.repeat(64),
      seed: 17,
      geometry: 'ground-cuboid-v1',
      capabilities: ['dynamics', 'attitude_controller'],
      drones: [{ id: 'drone-a', position: [0, 23, 0] }],
    })
    expect(() => legacy.schedule(action())).toThrow('Unsupported')
    await expect(legacy.advanceControlled()).rejects.toThrow('force profile')
    expect((await checkpoint(legacy)).serialized).not.toContain('forceControl')
    const owned = JSON.parse((await checkpoint(owner)).serialized)
    expect(owned.forceControl.allocationPolicy).toBe('full-moments-before-collective-v1')
    expect(owned.forceControl.allocationPolicy).toBe(ALLOCATION_POLICY)
    expect(owned.forceControl.limits).toEqual(LIMITS)
  })

  it('rejects altered engine/configuration and oversized new-profile rosters before preparation', async () => {
    const initialize = vi.spyOn(DronePhysicsWorld.prototype, 'init')
    for (const broken of [
      { ...plan(), controller: { ...config, engineModel: 'other' } },
      { ...plan(), controller: { ...config, referenceAltitudeM: NaN } },
      { ...plan(), capabilities: ['dynamics', 'attitude_controller'] },
      {
        ...plan(),
        drones: [
          { id: 'drone-a', position: [0, 23, 0] },
          { id: 'drone-b', position: [5, 23, 0] },
        ],
      },
    ])
      await expect(DeterministicDroneWorld.prepare(broken as DynamicsPlan)).rejects.toThrow()
    expect(initialize).not.toHaveBeenCalled()
    await prepare()
    expect(initialize).toHaveBeenCalledOnce()
  })

  it('rejoins actual before/action/motor/after state against the unchanged direct world', async () => {
    const owner = await prepare()
    const held = { ...target(), roll_rad: 0.03, pitch_rad: -0.02 }
    owner.schedule({ ...action(), control: held })
    const direct = new DronePhysicsWorld('explicit')
    await direct.init()
    const drone = direct.createDrone('drone-a', undefined, new THREE.Vector3(0, 23, 0))
    try {
      for (let tick = 1; tick <= 36; tick++) {
        drone.setArmed(true)
        const commands = compute(
          {
            position: drone.state.position.toArray(),
            velocity: drone.state.velocity.toArray(),
            orientation: drone.state.orientation.toArray(),
            angularVelocity: drone.state.angularVelocity.toArray(),
            armed: true,
          },
          held,
          config
        )
        drone.setMotorCommands(commands.commands)
        direct.advanceTicks(1)
        const before = await checkpoint(owner)
        const result = await owner.advanceControlled()
        expect(result.beforeStateSha256).toBe(before.sha256)
        const after = await checkpoint(owner)
        expect(result.afterStateSha256).toBe(after.sha256)
        expect(result.action.tick).toBe(1)
        expect(result.postEventState.armed).toBe(true)
        expect(result.appliedMotorTargets).toEqual(commands.commands)
        expect(result.after.rotors.map((x) => x.rpm)).toEqual(drone.state.rotors.map((x) => x.rpm))
        expect(JSON.parse(after.serialized).physics).toEqual(
          JSON.parse(direct.checkpoint().serialized)
        )
        expect(result.controller!.target).toEqual(held)
      }
    } finally {
      direct.destroy()
    }
  })

  it('retains inherited future actions, exact replay, and independent changed branches', async () => {
    const owner = await prepare()
    owner.schedule(action())
    owner.schedule({ ...action(20), control: { ...target(), pitch_rad: 0.02 } })
    for (let tick = 0; tick < 12; tick++) await owner.advanceControlled()
    const handle = await owner.checkpoint()
    const before = owner.checkpointState(handle)
    const first = await owner.fork(handle)
    owners.push(first)
    expect((await checkpoint(first)).serialized).toBe(before)
    for (let tick = 0; tick < 24; tick++) await first.advanceControlled()
    const same = await checkpoint(first)
    first.retire()
    expect((await checkpoint(owner)).serialized).toBe(before)
    const changed = await owner.fork(handle)
    owners.push(changed)
    changed.schedule({ ...action(15), control: { ...target(), roll_rad: -0.03 } })
    for (let tick = 0; tick < 24; tick++) await changed.advanceControlled()
    expect(changed.observe().drones[0].position).not.toEqual(
      JSON.parse(same.serialized).physics.drones[0].position
    )
    changed.retire()
    for (let tick = 0; tick < 24; tick++) await owner.advanceControlled()
    expect((await checkpoint(owner)).serialized).toBe(same.serialized)
    await owner.restore(handle)
    expect((await checkpoint(owner)).serialized).toBe(before)
  })

  it('makes opposite small roll requests produce opposite actual lateral velocity', async () => {
    const plus = await prepare(),
      minus = await prepare()
    plus.schedule({ ...action(), control: { ...target(), roll_rad: 0.03 } })
    minus.schedule({ ...action(), control: { ...target(), roll_rad: -0.03 } })
    for (let tick = 0; tick < 60; tick++) {
      await plus.advanceControlled()
      await minus.advanceControlled()
    }
    expect(plus.observe().drones[0].velocity[0]).toBeGreaterThan(0)
    expect(minus.observe().drones[0].velocity[0]).toBeLessThan(0)
    expect(plus.observe().drones[0].position).not.toEqual(minus.observe().drones[0].position)
  })

  it('preserves source disarm and real zero-RPM rearm without a seeded startup', async () => {
    const owner = await prepare()
    owner.schedule(action())
    await owner.advanceControlled()
    owner.schedule({ ...action(2), armed: false })
    const stopped = await owner.advanceControlled()
    expect(stopped.after.rotors.every((x) => x.rpm === 0 && x.thrust === 0 && x.torque === 0)).toBe(
      true
    )
    expect(stopped.controller!.allocation_applied).toBe(false)
    owner.schedule(action(3))
    const rearmed = await owner.advanceControlled()
    for (const [i, motor] of Object.values(rearmed.appliedMotorTargets).entries())
      expect(rearmed.after.rotors[i].rpm).toBeCloseTo((motor * 15000) / 12, 10)
    expect(rearmed.after.rotors.every((x) => x.rpm < 1251)).toBe(true)
  })

  it('restores pre-effect availability after hash failure but reports known post-effect retirement', async () => {
    const owner = await prepare()
    owner.schedule(action())
    const original = crypto.subtle.digest.bind(crypto.subtle)
    const digest = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValueOnce(new Error('pre-hash failed'))
    await expect(owner.advanceControlled()).rejects.toThrow('pre-hash failed')
    expect(owner.controlledStatus()).toMatchObject({
      phase: 'active',
      executedTick: 0,
      lastAcceptedTick: 0,
    })
    digest.mockImplementationOnce(original).mockRejectedValueOnce(new Error('post-hash failed'))
    await expect(owner.advanceControlled()).rejects.toMatchObject({
      outcome: { executedTick: 1, lastAcceptedTick: 0, cleanupConfirmed: true },
    })
    expect(owner.controlledStatus()).toMatchObject({
      phase: 'retired',
      executedTick: 1,
      lastCompletedTick: 1,
      lastAcceptedTick: 0,
    })
    expect(() => owner.observe()).toThrow('retired')
    await expect(owner.advanceControlled()).rejects.toThrow('retired')
  })

  it('does not claim a prior tick after a throwing actual physics transition', async () => {
    const owner = await prepare()
    owner.schedule(action())
    const original = DronePhysicsWorld.prototype.advanceTicks
    vi.spyOn(DronePhysicsWorld.prototype, 'advanceTicks').mockImplementation(function (
      this: DronePhysicsWorld,
      ticks: number
    ) {
      original.call(this, ticks)
      throw new Error('after actual tick')
    })
    await expect(owner.advanceControlled()).rejects.toBeInstanceOf(ControlledAdvanceError)
    expect(owner.controlledStatus()).toMatchObject({
      phase: 'retired',
      executedTick: null,
      lastCompletedTick: 0,
      lastAcceptedTick: 0,
    })
  })

  it('retires completed-but-unaccepted execution when reserved return encoding fails', async () => {
    const owner = await prepare()
    owner.schedule(action())
    vi.spyOn(TextEncoder.prototype, 'encodeInto').mockReturnValue({ read: 0, written: 0 })
    await expect(owner.advanceControlled()).rejects.toMatchObject({
      outcome: {
        executedTick: 1,
        lastAcceptedTick: 0,
        primaryFailure: 'Controlled return exceeded its reserved extent',
      },
    })
    expect(owner.controlledStatus().phase).toBe('retired')
  })
})
