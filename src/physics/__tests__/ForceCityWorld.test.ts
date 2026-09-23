// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { DronePhysicsBody, DronePhysicsWorld } from '../DronePhysics'
import { ENGINE_MODEL, compute, type State } from '../ForceAttitudeController'
import {
  FORCE_CITY_PROFILE,
  FORCE_CITY_RETURN_ENTITY_BYTES,
  FORCE_CITY_RETURN_HEADER_BYTES,
  ForceCityAdvanceError,
  ForceCityCleanupError,
  ForceCityWorld,
  type ForceCityBatch,
  type ForceCityPlan,
  type ForceCityRow,
  type ForceCityTransition,
} from '../ForceCityWorld'
import { prepareStaticGeometry } from '../StaticGeometry'

const owners: ForceCityWorld[] = []
const plan = (count = 2): ForceCityPlan => ({
  profile: FORCE_CITY_PROFILE,
  runId: 'force-city-control',
  sourceIdentity: 'e'.repeat(64),
  horizonTicks: 24,
  actionBudget: Math.max(count, 12),
  drones: Array.from({ length: count }, (_, index) => ({
    id: `drone-${String(index).padStart(3, '0')}`,
    position: [(index % 16) * 3, 23 + (index % 3), Math.floor(index / 16) * 3],
    controller: {
      engineModel: ENGINE_MODEL,
      referenceAltitudeM: 23 + (index % 3),
      referenceHeadingRad: (index % 2) * 0.02,
    },
  })),
  staticGeometry: [
    {
      id: 'wall',
      center: [-5, 3, 0],
      halfExtents: [1, 3, 6],
      yaw: 0.2,
      friction: 0.7,
      restitution: 0.1,
    },
  ],
})

function setBatch(input: ForceCityPlan, tick = 1): ForceCityBatch {
  return {
    tick,
    rows: input.drones.map((row, index) => ({
      kind: 'set',
      droneId: row.id,
      armed: true,
      target: {
        kind: 'force_attitude_height',
        roll_rad: index % 2 ? -0.02 : 0.03,
        pitch_rad: 0.01,
        heading_rad: row.controller.referenceHeadingRad,
        altitude_m: row.controller.referenceAltitudeM,
      },
    })),
  }
}

function holdBatch(result: ForceCityTransition): ForceCityBatch {
  return {
    tick: result.tick + 1,
    rows: result.entities.map((row) => ({
      kind: 'hold',
      droneId: row.droneId,
      actionSha256: row.action.sha256,
    })),
  }
}

async function prepare(input = plan()) {
  const owner = await ForceCityWorld.prepare(input)
  owners.push(owner)
  return owner
}

async function sha256(text: string) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(raw), (value) => value.toString(16).padStart(2, '0')).join('')
}

function state(drone: DronePhysicsBody, armed: boolean): State {
  return {
    position: drone.state.position.toArray(),
    velocity: drone.state.velocity.toArray(),
    orientation: drone.state.orientation.toArray(),
    angularVelocity: drone.state.angularVelocity.toArray(),
    armed,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  owners.splice(0).forEach((owner) => owner.retire())
})

describe('whole-roster force-city CPU ownership', () => {
  it('rejects the complete invalid plan before initializing and accepts the bounded positive', async () => {
    const init = vi.spyOn(DronePhysicsWorld.prototype, 'init')
    const valid = plan()
    for (const wrong of [
      { ...valid, profile: 'crebain.rapier-force-attitude.v1' },
      { ...valid, drones: [] },
      plan(257),
      { ...valid, drones: [...valid.drones].reverse() },
      { ...valid, drones: [valid.drones[0], valid.drones[0]] },
      { ...valid, actionBudget: 1 },
      { ...valid, actionBudget: 4097 },
      { ...valid, horizonTicks: 7201 },
      { ...valid, horizonTicks: 1.5 },
      { ...valid, capability: 'camera' },
      { ...valid, staticGeometry: [{ ...valid.staticGeometry[0], restitution: 2 }] },
      {
        ...valid,
        drones: [
          valid.drones[0],
          {
            ...valid.drones[1],
            controller: { ...valid.drones[1].controller, engineModel: 'foreign' },
          },
        ],
      },
    ])
      await expect(ForceCityWorld.prepare(wrong as ForceCityPlan)).rejects.toThrow()
    expect(init).not.toHaveBeenCalled()
    const owner = await prepare(valid)
    expect(init).toHaveBeenCalledOnce()
    expect(JSON.parse(owner.referenceState()).physics.staticGeometry).toEqual(valid.staticGeometry)
  })

  it('keeps an invalid later row, omitted rows, foreign IDs, duplicates and reordering entirely pre-effect', async () => {
    const input = plan(),
      owner = await prepare(input),
      batch = setBatch(input)
    const before = owner.referenceState()
    const armed = vi.spyOn(DronePhysicsBody.prototype, 'setArmed')
    const motors = vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands')
    const step = vi.spyOn(DronePhysicsWorld.prototype, 'advanceTicks')
    const last = batch.rows[1]
    if (last.kind !== 'set') throw new Error('Fixture requires set')
    for (const wrong of [
      {
        ...batch,
        rows: [batch.rows[0], { ...last, target: { ...last.target, roll_rad: 0.10001 } }],
      },
      { ...batch, rows: batch.rows.slice(0, 1) },
      { ...batch, rows: [{ ...batch.rows[0], droneId: 'foreign' }, last] },
      { ...batch, rows: [batch.rows[0], batch.rows[0]] },
      { ...batch, rows: [...batch.rows].reverse() },
      { ...batch, tick: 2 },
      { ...batch, tick: 1.1 },
      {
        ...batch,
        rows: [{ kind: 'hold', droneId: input.drones[0].id, actionSha256: '0'.repeat(64) }, last],
      },
    ]) {
      await expect(owner.advanceControlled(wrong as ForceCityBatch)).rejects.toThrow()
      expect(owner.referenceState()).toBe(before)
      expect(owner.status()).toMatchObject({
        phase: 'active',
        lastAcceptedTick: 0,
        admittedActions: 0,
      })
    }
    expect(armed).not.toHaveBeenCalled()
    expect(motors).not.toHaveBeenCalled()
    expect(step).not.toHaveBeenCalled()
    expect((await owner.advanceControlled(batch)).tick).toBe(1)
    expect(step).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('rejects getters and sparse arrays without evaluating or retaining caller input', async () => {
    const input = plan(),
      owner = await prepare(input)
    const before = owner.referenceState(),
      batch = setBatch(input)
    const getter = vi.fn(() => true)
    Object.defineProperty(batch.rows[1], 'armed', { get: getter, enumerable: true })
    await expect(owner.advanceControlled(batch)).rejects.toThrow('accessors')
    expect(getter).not.toHaveBeenCalled()
    const sparse = setBatch(input)
    sparse.rows = new Array<ForceCityRow>(2)
    sparse.rows[0] = setBatch(input).rows[0]
    await expect(owner.advanceControlled(sparse)).rejects.toThrow('dense')
    expect(owner.referenceState()).toBe(before)
    const accepted = setBatch(input)
    const running = owner.advanceControlled(accepted)
    input.drones[0].controller.referenceAltitudeM = -100
    if (accepted.rows[0].kind === 'set') accepted.rows[0].target.altitude_m = -200
    const result = await running
    expect(result.entities[0].action.target.altitude_m).toBe(23)
    expect(JSON.parse(owner.referenceState()).plan.drones[0].controller.referenceAltitudeM).toBe(23)
  })

  it('rejoins heterogeneous controls and actual geometry with one unchanged direct Rapier world', async () => {
    const input = plan(3),
      owner = await prepare(input)
    const direct = new DronePhysicsWorld('explicit', prepareStaticGeometry(input.staticGeometry))
    await direct.init()
    const drones = input.drones.map((row) =>
      direct.createDrone(row.id, undefined, new THREE.Vector3(...row.position))
    )
    let batch = setBatch(input)
    try {
      for (let tick = 1; tick <= 12; tick++) {
        const before = owner.referenceState()
        // Freeze every command from the common pre-step state before applying any row.
        const staged = drones.map((drone, index) => {
          const row = setBatch(input).rows[index]
          if (row.kind !== 'set') throw new Error('Fixture requires set')
          return compute(state(drone, row.armed), row.target, input.drones[index].controller)
        })
        for (const [index, drone] of drones.entries()) {
          drone.setArmed(true)
          drone.setMotorCommands(staged[index].commands)
        }
        direct.advanceTicks(1)
        const result = await owner.advanceControlled(batch)
        expect(result.beforeStateSha256).toBe(await sha256(before))
        expect(result.afterStateSha256).toBe(await sha256(owner.referenceState()))
        expect(JSON.parse(owner.referenceState()).physics).toEqual(
          JSON.parse(direct.checkpoint().serialized)
        )
        expect(result.entities.map((row) => row.appliedMotorTargets)).toEqual(
          staged.map((row) => row.commands)
        )
        expect(result.entities.map((row) => row.action.tick)).toEqual([1, 1, 1])
        batch = holdBatch(result)
      }
    } finally {
      direct.destroy()
    }
  })

  it('binds holds to exact per-entity action history and never charges holds as new actions', async () => {
    const input = { ...plan(), actionBudget: 2, horizonTicks: 3 },
      owner = await prepare(input)
    let result = await owner.advanceControlled(setBatch(input))
    const before = owner.referenceState()
    await expect(owner.advanceControlled(setBatch(input, 2))).rejects.toThrow('action budget')
    const foreign = holdBatch(result)
    if (foreign.rows[0].kind !== 'hold') throw new Error('Fixture requires hold')
    foreign.rows[0].actionSha256 = result.entities[1].action.sha256
    await expect(owner.advanceControlled(foreign)).rejects.toThrow('retained action')
    expect(owner.referenceState()).toBe(before)
    result = await owner.advanceControlled(holdBatch(result))
    result = await owner.advanceControlled(holdBatch(result))
    expect(owner.status()).toMatchObject({ lastAcceptedTick: 3, admittedActions: 2 })
    const terminal = owner.referenceState()
    await expect(owner.advanceControlled(holdBatch(result))).rejects.toThrow('next tick')
    expect(owner.referenceState()).toBe(terminal)
  })

  it('rejects stale holds after replacement while preserving other entity authority and source disarm', async () => {
    const input = plan(),
      owner = await prepare(input)
    const initial = await owner.advanceControlled(setBatch(input))
    const changed = holdBatch(initial),
      change = setBatch(input, 2).rows[0]
    if (change.kind !== 'set') throw new Error('Fixture requires set')
    changed.rows[0] = { ...change, armed: false }
    const result = await owner.advanceControlled(changed)
    expect(
      result.entities[0].after.rotors.every(
        (rotor) => rotor.rpm === 0 && rotor.thrust === 0 && rotor.torque === 0
      )
    ).toBe(true)
    expect(result.entities[0].controller.allocation_applied).toBe(false)
    expect(result.entities[1].action.sha256).toBe(initial.entities[1].action.sha256)
    expect(result.entities[0].action.sha256).not.toBe(initial.entities[0].action.sha256)
    const stale = { ...holdBatch(initial), tick: 3 }
    const before = owner.referenceState()
    await expect(owner.advanceControlled(stale)).rejects.toThrow('retained action')
    expect(owner.referenceState()).toBe(before)
    expect((await owner.advanceControlled(holdBatch(result))).tick).toBe(3)
  })

  it('returns detached nested values and guards concurrent operations throughout hashing', async () => {
    const input = plan(),
      owner = await prepare(input)
    const original = crypto.subtle.digest.bind(crypto.subtle)
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      await barrier
      return original(...args)
    })
    const pending = owner.advanceControlled(setBatch(input))
    expect(owner.status().phase).toBe('busy')
    await expect(owner.advanceControlled(setBatch(input))).rejects.toThrow('busy')
    expect(() => owner.referenceState()).toThrow('busy')
    expect(() => owner.retire()).toThrow('transaction')
    release()
    const result = await pending,
      hold = holdBatch(result),
      before = owner.referenceState()
    result.entities[0].after.rotors[0].rpm = 999
    result.entities[0].before.state.position[0] = 999
    result.entities[0].action.target.altitude_m = -10
    result.entities[0].controller.commands.front_left = 0
    result.entities[0].action.sha256 = '0'.repeat(64)
    expect(owner.referenceState()).toBe(before)
    expect((await owner.advanceControlled(hold)).tick).toBe(2)
  })

  it('admits output capacity before any motor effect and bounds a 256-row component return', async () => {
    const input = plan(256),
      owner = await prepare(input),
      batch = setBatch(input)
    const extent = FORCE_CITY_RETURN_HEADER_BYTES + 256 * FORCE_CITY_RETURN_ENTITY_BYTES
    const before = owner.referenceState()
    const motors = vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands')
    const step = vi.spyOn(DronePhysicsWorld.prototype, 'advanceTicks')
    await expect(owner.advanceControlled(batch, extent - 1)).rejects.toThrow('before mutation')
    expect(owner.referenceState()).toBe(before)
    expect(motors).not.toHaveBeenCalled()
    expect(step).not.toHaveBeenCalled()
    const result = await owner.advanceControlled(batch, extent)
    expect(result.entities).toHaveLength(256)
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(extent)
    expect(step).toHaveBeenCalledExactlyOnceWith(1)
    expect(motors).toHaveBeenCalledTimes(256)
    expect(owner.status()).toMatchObject({ lastAcceptedTick: 1, admittedActions: 256 })
  })

  it('retires after a fault following one fully applied row and retains the uncertain next write', async () => {
    const input = plan(),
      owner = await prepare(input),
      primary = new Error('second arming failed after assignment')
    const original = DronePhysicsBody.prototype.setArmed
    vi.spyOn(DronePhysicsBody.prototype, 'setArmed').mockImplementation(function (
      this: DronePhysicsBody,
      armed
    ) {
      original.call(this, armed)
      if (this.id === input.drones[1].id) throw primary
    })
    const step = vi.spyOn(DronePhysicsWorld.prototype, 'advanceTicks')
    const motors = vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands')
    let failure: unknown
    try {
      await owner.advanceControlled(setBatch(input))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ForceCityAdvanceError)
    expect((failure as Error).cause).toBe(primary)
    const preparedRows = (failure as ForceCityAdvanceError).outcome.preparedRows
    expect(preparedRows.map((row) => row.droneId)).toEqual(input.drones.map((row) => row.id))
    expect(preparedRows[0].motorTargets).toEqual(motors.mock.calls[0][0])
    expect(preparedRows.every((row) => /^[a-f0-9]{64}$/.test(row.actionSha256))).toBe(true)
    expect(Object.isFrozen(preparedRows[0].motorTargets)).toBe(true)
    expect(failure).toMatchObject({
      outcome: {
        executedTick: 0,
        lastCompletedTick: 0,
        lastAcceptedTick: 0,
        mutationStarted: true,
        historyCommitted: true,
        admittedActions: 2,
        armedRowsCompleted: [input.drones[0].id],
        motorRowsCompleted: [input.drones[0].id],
        inFlight: { droneId: input.drones[1].id, operation: 'armed' },
        physicsAttempted: false,
        cleanupConfirmed: true,
      },
    })
    expect(step).not.toHaveBeenCalled()
    await expect(owner.advanceControlled(setBatch(input))).rejects.toThrow('retired')
    expect(() => owner.referenceState()).toThrow('retired')
  })

  it('does not mark a throwing motor write as confirmed completion even after it changed the body', async () => {
    const input = plan(),
      owner = await prepare(input)
    const original = DronePhysicsBody.prototype.setMotorCommands
    vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands').mockImplementationOnce(function (
      this: DronePhysicsBody,
      commands
    ) {
      original.call(this, commands)
      throw new Error('post-write failure')
    })
    await expect(owner.advanceControlled(setBatch(input))).rejects.toMatchObject({
      outcome: {
        executedTick: 0,
        armedRowsCompleted: [input.drones[0].id],
        motorRowsCompleted: [],
        inFlight: { droneId: input.drones[0].id, operation: 'motors' },
        cleanupConfirmed: true,
      },
    })
  })

  it('reports unknown engine completion after a throwing real step', async () => {
    const input = plan(),
      owner = await prepare(input)
    const original = DronePhysicsWorld.prototype.advanceTicks
    vi.spyOn(DronePhysicsWorld.prototype, 'advanceTicks').mockImplementation(function (
      this: DronePhysicsWorld,
      ticks
    ) {
      original.call(this, ticks)
      throw new Error('real tick returned internally then wrapper failed')
    })
    await expect(owner.advanceControlled(setBatch(input))).rejects.toMatchObject({
      outcome: {
        executedTick: null,
        lastCompletedTick: 0,
        lastAcceptedTick: 0,
        motorRowsCompleted: input.drones.map((row) => row.id),
        inFlight: null,
        physicsAttempted: true,
        cleanupConfirmed: true,
      },
    })
  })

  it('distinguishes pre-effect hash rejection from completed but unaccepted post-hash failure', async () => {
    const input = plan(),
      owner = await prepare(input),
      before = owner.referenceState()
    const original = crypto.subtle.digest.bind(crypto.subtle)
    const hash = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementationOnce(original)
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('pre-state hash failed'))
    await expect(owner.advanceControlled(setBatch(input))).rejects.toThrow('pre-state hash')
    expect(owner.referenceState()).toBe(before)
    expect(owner.status()).toMatchObject({ phase: 'active', admittedActions: 0 })
    hash
      .mockImplementationOnce(original)
      .mockImplementationOnce(original)
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('post-state hash failed'))
    await expect(owner.advanceControlled(setBatch(input))).rejects.toMatchObject({
      outcome: {
        executedTick: 1,
        lastCompletedTick: 1,
        lastAcceptedTick: 0,
        mutationStarted: true,
        cleanupConfirmed: true,
        primaryFailure: 'post-state hash failed',
      },
    })
  })

  it('retires completed but unaccepted execution when final bounded encoding fails', async () => {
    const input = plan(),
      owner = await prepare(input)
    vi.spyOn(TextEncoder.prototype, 'encodeInto').mockReturnValueOnce({ read: 0, written: 0 })
    await expect(owner.advanceControlled(setBatch(input))).rejects.toMatchObject({
      outcome: {
        executedTick: 1,
        lastCompletedTick: 1,
        lastAcceptedTick: 0,
        primaryFailure: 'Force-city return exceeded its reserved extent',
        cleanupConfirmed: true,
      },
    })
  })

  it('retires an invalid common-state envelope before motor changes and leaves a fresh owner usable', async () => {
    const input = plan(),
      owner = await prepare(input)
    const original = DronePhysicsWorld.prototype.getAllDrones
    vi.spyOn(DronePhysicsWorld.prototype, 'getAllDrones').mockImplementationOnce(function (
      this: DronePhysicsWorld
    ) {
      const drones = original.call(this)
      drones[1].state.velocity.x = NaN
      return drones
    })
    const motors = vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands')
    await expect(owner.advanceControlled(setBatch(input))).rejects.toMatchObject({
      outcome: {
        executedTick: 0,
        mutationStarted: false,
        historyCommitted: false,
        motorRowsCompleted: [],
        admittedActions: 0,
        cleanupConfirmed: true,
      },
    })
    expect(motors).not.toHaveBeenCalled()
    const fresh = await prepare(input)
    expect((await fresh.advanceControlled(setBatch(input))).tick).toBe(1)
  })

  it('cleans up before formatting hostile errors and preserves original cleanup uncertainty', async () => {
    const input = plan(),
      owner = await prepare(input)
    const primary = Object.defineProperty(new Error('original primary'), 'message', {
      get() {
        throw new Error('hostile diagnostic')
      },
    })
    const cleanup = new Error('cleanup reported failure after actual free')
    const destroy = DronePhysicsWorld.prototype.destroy
    const free = vi.spyOn(DronePhysicsWorld.prototype, 'destroy').mockImplementationOnce(function (
      this: DronePhysicsWorld
    ) {
      destroy.call(this)
      throw cleanup
    })
    vi.spyOn(DronePhysicsBody.prototype, 'setMotorCommands').mockImplementationOnce(() => {
      throw primary
    })
    let failure: unknown
    try {
      await owner.advanceControlled(setBatch(input))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ForceCityAdvanceError)
    expect((failure as ForceCityAdvanceError).cause).toBe(primary)
    expect((failure as ForceCityAdvanceError).cleanupError).toBe(cleanup)
    expect(failure).toMatchObject({
      outcome: { cleanupConfirmed: false, primaryFailure: 'Unprintable force-city failure' },
    })
    expect(free).toHaveBeenCalledOnce()
    expect(() => owner.retire()).toThrow(cleanup)
    expect(free).toHaveBeenCalledOnce()
    owners.splice(owners.indexOf(owner), 1) // The fixture already freed the actual world.
    const fresh = await prepare(input)
    fresh.retire()
    fresh.retire()
    expect(fresh.status().cleanupConfirmed).toBe(true)
  })

  it('retains partial preparation and cleanup failures independently and rejects fallback', async () => {
    const input = plan(),
      primary = new Error('second body failed'),
      cleanup = new Error('prepare cleanup report failed')
    const create = DronePhysicsWorld.prototype.createDrone,
      destroy = DronePhysicsWorld.prototype.destroy
    vi.spyOn(DronePhysicsWorld.prototype, 'createDrone').mockImplementation(function (
      this: DronePhysicsWorld,
      ...args
    ) {
      if (args[0] === input.drones[1].id) throw primary
      return create.apply(this, args)
    })
    vi.spyOn(DronePhysicsWorld.prototype, 'destroy').mockImplementationOnce(function (
      this: DronePhysicsWorld
    ) {
      destroy.call(this)
      throw cleanup
    })
    let failure: unknown
    try {
      await ForceCityWorld.prepare(input)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ForceCityCleanupError)
    expect((failure as ForceCityCleanupError).errors).toEqual([primary, cleanup])
    expect((failure as ForceCityCleanupError).cause).toBe(primary)
    vi.restoreAllMocks()
    const fallback = vi
      .spyOn(DronePhysicsWorld.prototype, 'isUsingFallback')
      .mockReturnValueOnce(true)
    await expect(ForceCityWorld.prepare(input)).rejects.toThrow('actual Rapier')
    fallback.mockRestore()
    expect((await prepare(input)).status().phase).toBe('active')
  })
})
