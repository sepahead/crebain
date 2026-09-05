// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import {
  DYNAMICS_PROFILE,
  DeterministicDroneWorld,
  type DynamicsCheckpoint,
  type DynamicsPlan,
  type ScheduledDynamicsAction,
} from '../DeterministicDroneWorld'
import { DronePhysicsWorld, FlightController, PHYSICS_FIXED_DT } from '../DronePhysics'

const owners: DeterministicDroneWorld[] = []
const plan = (): DynamicsPlan => ({
  profile: DYNAMICS_PROFILE,
  runId: 'dynamics-control',
  sourceIdentity: 'a'.repeat(64),
  seed: 17,
  capabilities: ['dynamics', 'attitude_controller'],
  geometry: 'ground-cuboid-v1',
  drones: [
    { id: 'drone-a', position: [0, 12, 0] },
    { id: 'drone-b', position: { uniformBox: { min: [5, 15, 5], max: [8, 18, 8] } } },
  ],
})

const action = (tick = 1, droneId = 'drone-a'): ScheduledDynamicsAction => ({
  tick,
  droneId,
  armed: true,
  control: { kind: 'attitude', roll: 0.03, pitch: -0.02, yawRate: 0.1, altitude: 14 },
})

async function prepare(input = plan()): Promise<DeterministicDroneWorld> {
  const owner = await DeterministicDroneWorld.prepare(input)
  owners.push(owner)
  return owner
}

async function fork(owner: DeterministicDroneWorld, checkpoint: DynamicsCheckpoint) {
  const branch = await owner.fork(checkpoint)
  owners.push(branch)
  return branch
}

async function state(owner: DeterministicDroneWorld): Promise<string> {
  const checkpoint = await owner.checkpoint()
  const value = owner.checkpointState(checkpoint)
  owner.releaseCheckpoint(checkpoint)
  return value
}

afterEach(() => {
  owners.splice(0).forEach((owner) => owner.retire())
  vi.restoreAllMocks()
})

describe('actual Rapier deterministic dynamics ownership', () => {
  it('matches direct existing dynamics and controller execution at every tick', async () => {
    const input = plan()
    input.drones = [input.drones[0]]
    const owner = await prepare(input)
    owner.schedule(action())
    const direct = new DronePhysicsWorld('explicit')
    await direct.init()
    expect(direct.isUsingFallback()).toBe(false)
    const drone = direct.createDrone('drone-a', undefined, new THREE.Vector3(0, 12, 0))
    const controller = new FlightController()
    drone.setArmed(true)
    try {
      for (let tick = 1; tick <= 180; tick++) {
        drone.setMotorCommands(controller.update(drone, 0.03, -0.02, 0.1, 14, PHYSICS_FIXED_DT))
        direct.advanceTicks(1)
        const observed = owner.advance(1)
        expect(observed.drones[0].position).toEqual(drone.state.position.toArray())
        expect(observed.drones[0].velocity).toEqual(drone.state.velocity.toArray())
        expect(observed.drones[0].battery).toBe(drone.state.battery)
      }
      const recorded = JSON.parse(await state(owner)) as { physics: unknown; controllers: unknown }
      expect(recorded.physics).toEqual(JSON.parse(direct.checkpoint().serialized))
      expect(recorded.controllers).toEqual([['drone-a', controller.checkpoint()]])
      expect(drone.state.position.toArray()).not.toEqual([0, 12, 0])
      expect(drone.state.battery).toBeLessThan(1)
    } finally {
      direct.destroy()
    }
  })

  it('restores all hidden state and preserves future trajectories across independent branches', async () => {
    const owner = await prepare()
    owner.schedule(action())
    owner.schedule(action(1, 'drone-b'))
    owner.schedule({
      ...action(60),
      control: { kind: 'attitude', roll: -0.04, pitch: 0.05, yawRate: -0.1, altitude: 15 },
    })
    owner.advance(35)
    const checkpoint = await owner.checkpoint()
    const reference = owner.checkpointState(checkpoint)
    const captured = JSON.parse(reference) as {
      clock: { pending: unknown[] }
      rng: { state: number }
      controllers: Array<[string, { integrals: number[]; previousErrors: number[] }]>
      physics: {
        drones: Array<{ battery: number; rotors: Array<{ rpm: number }>; commands: unknown }>
      }
    }
    expect(captured.clock.pending).toHaveLength(1)
    expect(captured.rng.state).not.toBe(17)
    expect(captured.controllers[0][1].integrals.some((value) => value !== 0)).toBe(true)
    expect(captured.controllers[0][1].previousErrors.some((value) => value !== 0)).toBe(true)
    expect(captured.physics.drones[0].rotors.some((rotor) => rotor.rpm > 0)).toBe(true)
    expect(captured.physics.drones[0].battery).toBeLessThan(1)
    const a = await fork(owner, checkpoint)
    const b = await fork(owner, checkpoint)
    expect(await state(a)).toBe(reference)
    expect(await state(b)).toBe(reference)
    a.advance(120)
    expect(await state(owner)).toBe(reference)
    expect(await state(b)).toBe(reference)
    b.advance(120)
    owner.advance(120)
    expect(await state(a)).toBe(await state(b))
    expect(await state(a)).toBe(await state(owner))
    await owner.restore(checkpoint)
    expect(await state(owner)).toBe(reference)
    owner.advance(120)
    expect(await state(owner)).toBe(await state(a))
  })

  it('a changed branch action changes its actual effect without changing siblings or canonical state', async () => {
    const owner = await prepare()
    owner.schedule(action())
    owner.advance(20)
    const checkpoint = await owner.checkpoint()
    const a = await fork(owner, checkpoint)
    const b = await fork(owner, checkpoint)
    a.schedule({ ...action(21), armed: false })
    a.advance(100)
    b.advance(100)
    expect(a.observe().drones[0].position).not.toEqual(b.observe().drones[0].position)
    expect(await state(owner)).toBe(owner.checkpointState(checkpoint))
    const branchCheckpoint = await a.checkpoint()
    await expect(owner.restore(branchCheckpoint)).rejects.toThrow('foreign')
    expect(owner.observe().tick).toBe(20)
  })

  it('presentation reads and wall-clock schedules cannot change logical trajectories', async () => {
    const a = await prepare()
    const b = await prepare()
    a.schedule(action())
    b.schedule(action())
    const clock = vi.spyOn(performance, 'now')
    for (let tick = 0; tick < 120; tick++) {
      clock.mockReturnValue(tick % 2 ? 1e12 : -1e6)
      for (let frame = 0; frame < tick % 7; frame++) {
        const view = a.observe()
        view.drones[0].position[0] = 9000
      }
      a.advance(1)
    }
    b.advance(120)
    expect(await state(a)).toBe(await state(b))
    const explicit = new DronePhysicsWorld('explicit')
    expect(() => explicit.update()).toThrow('advanceTicks')
    const desktop = new DronePhysicsWorld()
    expect(() => desktop.advanceTicks(1)).toThrow('Explicit advancement')
  })

  it('rejects forged, corrupted, copied, foreign and released checkpoints before mutation', async () => {
    const owner = await prepare()
    const other = await prepare()
    const checkpoint = await owner.checkpoint()
    const before = await state(owner)
    for (const corrupted of [
      { ...checkpoint },
      { ...checkpoint, tick: 1 },
      { ...checkpoint, sha256: '0'.repeat(64) },
      JSON.parse(JSON.stringify(checkpoint)) as DynamicsCheckpoint,
    ])
      await expect(owner.restore(corrupted)).rejects.toThrow('unrecognized')
    await expect(other.fork(checkpoint)).rejects.toThrow('foreign')
    expect(await state(owner)).toBe(before)
    await owner.restore(checkpoint)
    owner.releaseCheckpoint(checkpoint)
    await expect(owner.restore(checkpoint)).rejects.toThrow('released')
  })

  it('rejects unsupported state attachments and invalid inputs without partial preparation', async () => {
    for (const invalid of [
      { ...plan(), sensors: [] },
      { ...plan(), capabilities: ['dynamics', 'attitude_controller', 'fusion'] },
      { ...plan(), geometry: 'city-splat' },
      { ...plan(), seed: Number.NaN },
      { ...plan(), drones: [{ id: 'drone-a', position: [0, Infinity, 0] }] },
    ])
      await expect(DeterministicDroneWorld.prepare(invalid as DynamicsPlan)).rejects.toThrow()
    const owner = await prepare()
    const before = await state(owner)
    for (const ticks of [0, -1, 0.5, 2401, Infinity])
      expect(() => owner.advance(ticks)).toThrow('budget')
    expect(() => owner.schedule({ ...action(), droneId: 'absent' })).toThrow()
    expect(() =>
      owner.schedule({
        ...action(),
        control: { kind: 'attitude', roll: NaN, pitch: 0, yawRate: 0, altitude: 1 },
      })
    ).toThrow()
    expect(await state(owner)).toBe(before)
    owner.schedule(action())
    expect(() => owner.schedule(action())).toThrow('duplicate')
    owner.advance(1)
    expect(() => owner.schedule(action())).toThrow('stale')
  })

  it('bounds retained checkpoints and forks and reclaims capacity after release', async () => {
    const owner = await prepare()
    const checkpoints = []
    for (let index = 0; index < 8; index++) checkpoints.push(await owner.checkpoint())
    await expect(owner.checkpoint()).rejects.toThrow('budget')
    owner.releaseCheckpoint(checkpoints[7])
    const replacement = await owner.checkpoint()
    owner.releaseCheckpoint(replacement)
    const branches = []
    for (let index = 0; index < 7; index++) branches.push(await fork(owner, checkpoints[0]))
    await expect(owner.fork(checkpoints[0])).rejects.toThrow('budget')
    branches[0].retire()
    const replacementBranch = await fork(owner, checkpoints[0])
    expect(replacementBranch.observe()).toEqual(owner.observe())
    owner.retire()
    replacementBranch.advance(1)
    expect(() => owner.observe()).toThrow('retired')
  })

  it('blocks mutation while checkpoint hashing owns the transaction', async () => {
    const owner = await prepare()
    const pending = owner.checkpoint()
    expect(() => owner.advance(1)).toThrow('busy')
    expect(() => owner.retire()).toThrow('transaction')
    await pending
    owner.advance(1)
    expect(owner.observe().tick).toBe(1)
  })

  it.each([1, 8, 32, 256])(
    'round-trips all %i admitted drones through actual Rapier',
    async (count) => {
      const input = plan()
      input.drones = Array.from({ length: count }, (_, index) => ({
        id: `drone-${String(index).padStart(3, '0')}`,
        position: [index * 2, 5, 0] as [number, number, number],
      }))
      const owner = await prepare(input)
      owner.advance(3)
      const checkpoint = await owner.checkpoint()
      const branch = await fork(owner, checkpoint)
      expect(branch.observe().drones).toHaveLength(count)
      expect(await state(branch)).toBe(owner.checkpointState(checkpoint))
      branch.advance(3)
      owner.advance(3)
      expect(await state(branch)).toBe(await state(owner))
    }
  )

  it('binds deterministic spawn randomness and copies caller-owned inputs', async () => {
    const input = plan()
    const owner = await prepare(input)
    input.drones[0].position = [100, 200, 300]
    expect(owner.observe().drones[0].position).toEqual([0, 12, 0])
    const changedSeed = await prepare({ ...plan(), seed: 43 })
    expect(changedSeed.observe().drones[1].position).not.toEqual(owner.observe().drones[1].position)
    const next = action()
    owner.schedule(next)
    next.armed = false
    owner.advance(1)
    expect(owner.observe().drones[0].armed).toBe(true)
    expect(Object.isFrozen(owner)).toBe(true)
  })

  it('retains signed zero and rejects fabricated hidden-state replacements', async () => {
    const owner = await prepare()
    owner.schedule({
      ...action(),
      control: { kind: 'attitude', roll: -0, pitch: 0, yawRate: 0, altitude: 14 },
    })
    const checkpoint = await owner.checkpoint()
    const before = owner.checkpointState(checkpoint)
    expect(before).toContain('negative-zero')
    const branch = await fork(owner, checkpoint)
    expect(await state(branch)).toBe(before)
    for (const field of ['controllers', 'controls', 'rng', 'physics', 'clock']) {
      const altered = JSON.parse(before) as Record<string, unknown>
      altered[field] = null
      const bytes = new TextEncoder().encode(JSON.stringify(altered))
      const changedDigest = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (value) => value.toString(16).padStart(2, '0')
      ).join('')
      await expect(owner.restore({ ...checkpoint, sha256: changedDigest })).rejects.toThrow(
        'unrecognized'
      )
    }
    expect(await state(owner)).toBe(before)
  })

  it('recovers checkpoint reservation after hash failure and rejects physics fallback', async () => {
    const owner = await prepare()
    const before = owner.observe()
    const digest = vi
      .spyOn(crypto.subtle, 'digest')
      .mockRejectedValue(new Error('hash unavailable'))
    for (let index = 0; index < 9; index++)
      await expect(owner.checkpoint()).rejects.toThrow('hash unavailable')
    expect(owner.observe()).toEqual(before)
    digest.mockRestore()
    expect((await owner.checkpoint()).tick).toBe(0)
    vi.spyOn(DronePhysicsWorld.prototype, 'isUsingFallback').mockReturnValue(true)
    const destroy = vi.spyOn(DronePhysicsWorld.prototype, 'destroy')
    await expect(DeterministicDroneWorld.prepare(plan())).rejects.toThrow('actual Rapier')
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('retires after a physics failure following an actual mutation', async () => {
    const owner = await prepare()
    const advance = DronePhysicsWorld.prototype.advanceTicks
    vi.spyOn(DronePhysicsWorld.prototype, 'advanceTicks').mockImplementation(function (
      this: DronePhysicsWorld,
      ticks: number
    ) {
      advance.call(this, ticks)
      throw new Error('failure after real physics tick')
    })
    expect(() => owner.advance(1)).toThrow('after mutation; owner retired')
    expect(() => owner.observe()).toThrow('retired')
    await expect(owner.checkpoint()).rejects.toThrow('retired')
  })

  it.each([8, 32, 256])(
    'preserves complete %i-drone state through contacts and changed actions for 720 future ticks',
    async (count) => {
      const input = plan()
      input.drones = Array.from({ length: count }, (_, index) => ({
        id: `drone-${String(index).padStart(3, '0')}`,
        // Overlapping cuboids exercise contact resolution before they reach the ground.
        position: [(index % 16) * 0.35, 0.3 + Math.floor(index / 16) * 0.12, 0] as [
          number,
          number,
          number,
        ],
      }))
      const owner = await prepare(input)
      for (let index = 0; index < count; index++) {
        owner.schedule({
          ...action(61, input.drones[index].id),
          control: { kind: 'attitude', roll: 0.01, pitch: -0.01, yawRate: 0.01, altitude: 3 },
        })
        owner.schedule({ ...action(301, input.drones[index].id), armed: false })
      }
      owner.advance(35)
      const checkpoint = await owner.checkpoint()
      const a = await fork(owner, checkpoint)
      const b = await fork(owner, checkpoint)
      for (let block = 0; block < 12; block++) {
        // Reverse the sibling order on alternate blocks to expose shared state.
        for (const branch of block % 2 ? [a, b] : [b, a]) branch.advance(60)
        owner.advance(60)
        const expected = await state(owner)
        expect((await state(a)) === expected).toBe(true)
        expect((await state(b)) === expected).toBe(true)
      }
      expect(owner.observe().tick).toBe(755)
      expect(owner.observe().drones.some((drone) => drone.battery < 1)).toBe(true)
    }
  )

  it('rejects a reconstruction that differs in hidden controller state without replacing the owner', async () => {
    const owner = await prepare()
    owner.schedule(action())
    owner.advance(20)
    const checkpoint = await owner.checkpoint()
    const before = owner.checkpointState(checkpoint)
    const inspect = FlightController.prototype.checkpoint
    const corrupted = vi
      .spyOn(FlightController.prototype, 'checkpoint')
      .mockImplementation(function (this: FlightController) {
        const state = inspect.call(this)
        state.previousErrors[0] += 0.5
        return state
      })
    await expect(owner.restore(checkpoint)).rejects.toThrow('complete dynamics state')
    corrupted.mockRestore()
    expect(await state(owner)).toBe(before)
    await owner.restore(checkpoint)
    expect(await state(owner)).toBe(before)
  })

  it('preserves late-accepted future actions and rejects work beyond the complete horizon', async () => {
    const input = plan()
    input.drones = [input.drones[0]]
    const owner = await prepare(input)
    owner.advance(20)
    owner.schedule(action(200))
    owner.advance(20)
    owner.schedule({ ...action(100), armed: false })
    const checkpoint = await owner.checkpoint()
    const branch = await fork(owner, checkpoint)
    for (const ticks of [2400, 2400, 2360]) {
      owner.advance(ticks)
      branch.advance(ticks)
    }
    expect(owner.observe().tick).toBe(7200)
    expect((await state(branch)) === (await state(owner))).toBe(true)
    const end = await owner.checkpoint()
    await owner.restore(end)
    expect(owner.observe().tick).toBe(7200)
    expect(() => owner.advance(1)).toThrow('budget')
    expect(() => owner.schedule(action(7201))).toThrow('over-budget')
  })

  it('rejects sparse positions and the 257th drone before initializing physics', async () => {
    const initialize = vi.spyOn(DronePhysicsWorld.prototype, 'init')
    const sparse = plan()
    sparse.drones[0].position = new Array(3) as [number, number, number]
    await expect(DeterministicDroneWorld.prepare(sparse)).rejects.toThrow('dense')
    const oversized = plan()
    oversized.drones = Array.from({ length: 257 }, (_, index) => ({
      id: `drone-${index}`,
      position: [index, 10, 0],
    }))
    await expect(DeterministicDroneWorld.prepare(oversized)).rejects.toThrow('Unsupported')
    expect(initialize).not.toHaveBeenCalled()
    await prepare()
    expect(initialize).toHaveBeenCalledOnce()
  })

  it('rejects changing plan accessors without evaluating them or initializing physics', async () => {
    const input = plan()
    const initialize = vi.spyOn(DronePhysicsWorld.prototype, 'init')
    const geometry = vi
      .fn()
      .mockReturnValueOnce('ground-cuboid-v1')
      .mockReturnValue('unsupported-city')
    Object.defineProperty(input, 'geometry', { enumerable: true, get: geometry })
    await expect(DeterministicDroneWorld.prepare(input)).rejects.toThrow('accessors')
    expect(geometry).not.toHaveBeenCalled()
    expect(initialize).not.toHaveBeenCalled()
    const valid = plan()
    const owner = await prepare(valid)
    expect(Object.isFrozen(valid)).toBe(false)
    const captured = JSON.parse(await state(owner)) as { plan: DynamicsPlan }
    expect(captured.plan.geometry).toBe('ground-cuboid-v1')
  })

  it('binds action validation, history, and pending execution to one accepted data value', async () => {
    const owner = await prepare()
    const before = await state(owner)
    const changing = action()
    const armed = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true)
    Object.defineProperty(changing, 'armed', { enumerable: true, get: armed })
    expect(() => owner.schedule(changing)).toThrow('accessors')
    expect(armed).not.toHaveBeenCalled()
    expect(await state(owner)).toBe(before)
    const accepted = action()
    owner.schedule(accepted)
    accepted.armed = false
    const checkpoint = await owner.checkpoint()
    const captured = JSON.parse(owner.checkpointState(checkpoint)) as {
      clock: { pending: ScheduledDynamicsAction[]; history: ScheduledDynamicsAction[] }
    }
    expect(captured.clock.pending[0]).toEqual(captured.clock.history[0])
    expect(captured.clock.pending[0].armed).toBe(true)
    const branch = await fork(owner, checkpoint)
    owner.advance(120)
    branch.advance(120)
    expect(owner.observe().drones[0].armed).toBe(true)
    expect(await state(branch)).toBe(await state(owner))
  })

  it('rejects nested accessors, symbol keys, hidden fields, and array extras before admission', async () => {
    const owner = await prepare()
    const before = await state(owner)
    const nested = action()
    const roll = vi.fn().mockReturnValue(0)
    Object.defineProperty(nested.control, 'roll', { enumerable: true, get: roll })
    expect(() => owner.schedule(nested)).toThrow('accessors')
    expect(roll).not.toHaveBeenCalled()
    const symbolic = action()
    Object.defineProperty(symbolic, Symbol('extra'), { value: true })
    expect(() => owner.schedule(symbolic)).toThrow('symbol')
    const hidden = action()
    Object.defineProperty(hidden, 'extra', { value: true, enumerable: false })
    expect(() => owner.schedule(hidden)).toThrow('hidden')
    for (const key of ['extra', Symbol('extra')]) {
      const input = plan()
      Object.defineProperty(input.drones[0].position, key, { value: true, enumerable: true })
      await expect(DeterministicDroneWorld.prepare(input)).rejects.toThrow()
    }
    const arrayAccessor = plan()
    const coordinate = vi.fn().mockReturnValue(12)
    Object.defineProperty(arrayAccessor.drones[0].position, '1', {
      enumerable: true,
      get: coordinate,
    })
    await expect(DeterministicDroneWorld.prepare(arrayAccessor)).rejects.toThrow('accessors')
    expect(coordinate).not.toHaveBeenCalled()
    expect(await state(owner)).toBe(before)
    owner.schedule(action())
    owner.advance(1)
  })

  it('bounds data copying and rejects cycles while accepting shared ordinary arrays', async () => {
    const cyclic = plan()
    Object.assign(cyclic.drones[0], { position: cyclic })
    await expect(DeterministicDroneWorld.prepare(cyclic)).rejects.toThrow('acyclic')
    await expect(
      DeterministicDroneWorld.prepare({ ...plan(), runId: 'a'.repeat(257) })
    ).rejects.toThrow('string budget')
    let deep: unknown = 0
    for (let depth = 0; depth < 9; depth++) deep = { value: deep }
    const nested = plan()
    Object.assign(nested.drones[0], { position: deep })
    await expect(DeterministicDroneWorld.prepare(nested)).rejects.toThrow('copy budget')
    const shared = plan()
    shared.drones[1].position = shared.drones[0].position
    const owner = await prepare(shared)
    expect(owner.observe().drones[0].position).toEqual(owner.observe().drones[1].position)
    const checkpoint = await owner.checkpoint()
    const branch = await fork(owner, checkpoint)
    expect(await state(branch)).toBe(owner.checkpointState(checkpoint))
  })
})
