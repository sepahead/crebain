/** Explicit ownership of CREBAIN's existing Rapier dynamics and flight controllers. */
import * as THREE from 'three'
import { copyPlainData } from '../lib/copyPlainData'
import { MAX_SCENE_DRONES } from '../lib/sceneLimits'
import {
  PROFILE as FORCE_PROFILE,
  ENGINE_MODEL,
  ALLOCATION_POLICY,
  GAINS as FORCE_GAINS,
  LIMITS as FORCE_LIMITS,
  PHYSICAL as FORCE_PHYSICAL,
  compute as computeForce,
  checkEnvelope as checkForceEnvelope,
  ownTarget as ownForceTarget,
  ownForceControllerConfig,
  type ForceControllerConfig,
  type State as ForceState,
  type Target as ForceTarget,
} from './ForceAttitudeController'
export { FORCE_PROFILE }
/** Logical encoded return reservation. This is not a JavaScript heap/RSS bound. */
export const CONTROLLED_RETURN_BYTES = 32768
export interface ControlledTransition {
  profile: typeof FORCE_PROFILE
  runId: string
  sourceIdentity: string
  tick: number
  beforeStateSha256: string
  afterStateSha256: string
  action: ScheduledDynamicsAction
  controller: ReturnType<typeof computeForce> | null
  before: ControlledBodyState
  postEventState: ForceState
  appliedMotorTargets: MotorCommands
  after: ControlledBodyState
  observation: DynamicsObservation
}
interface ControlledBodyState {
  state: ForceState
  battery: number
  rotors: Array<{
    rpm: number
    thrust: number
    torque: number
    position: number[]
    direction: number
  }>
}
export interface ControlledFailure {
  executedTick: number | null
  lastCompletedTick: number
  lastAcceptedTick: number
  beforeStateSha256: string | null
  mutationStarted: boolean
  primaryFailure: string
  cleanupConfirmed: boolean
  cleanupFailure: string | null
}
/** Cleanup uncertainty is retained independently from the primary operation failure. */
export class DynamicsCleanupError extends AggregateError {
  readonly cleanupConfirmed = false
  constructor(primary: unknown, cleanup: unknown) {
    super([primary, cleanup], 'Dynamics operation failed with unresolved cleanup', {
      cause: primary,
    })
    this.name = 'DynamicsCleanupError'
  }
}
export class ControlledAdvanceError extends Error {
  constructor(readonly outcome: Readonly<ControlledFailure>) {
    super(
      outcome.mutationStarted
        ? 'Controlled dynamics failed after mutation; owner retired'
        : 'Controlled dynamics owned state invalid before execution; owner retired'
    )
    this.name = 'ControlledAdvanceError'
  }
}

import { ownStaticGeometry, prepareStaticGeometry, type StaticCuboid } from './StaticGeometry'
import {
  DronePhysicsWorld,
  FlightController,
  PHYSICS_FIXED_DT,
  type FlightControllerCheckpoint,
  type MotorCommands,
} from './DronePhysics'

export const DYNAMICS_PROFILE = 'crebain.rapier-dynamics.v1'
export const SCENE_DYNAMICS_PROFILE = 'crebain.rapier-scene-dynamics.v1'
const MAX_TICKS = 7200
const MAX_ADVANCE_TICKS = 2400
const MAX_PENDING = 4096
const MAX_CHECKPOINTS = 8
const MAX_OWNERS = 8
const MAX_CHECKPOINT_BYTES = 5 * 1024 * 1024
const ID = /^[a-z][a-z0-9_-]{0,63}$/

type Vector = [number, number, number]
export type InitialPosition = Vector | { uniformBox: { min: Vector; max: Vector } }

interface DynamicsPlanBase {
  runId: string
  /** Caller-declared source digest. This field does not attest loaded code. */
  sourceIdentity: string
  seed: number
  drones: Array<{ id: string; position: InitialPosition }>
}

export type DynamicsPlan = DynamicsPlanBase &
  (
    | {
        profile: typeof DYNAMICS_PROFILE
        geometry: 'ground-cuboid-v1'
        capabilities: ['dynamics', 'attitude_controller']
      }
    | {
        profile: typeof SCENE_DYNAMICS_PROFILE
        geometry: 'static-cuboids-v1'
        staticGeometry: StaticCuboid[]
        capabilities: ['dynamics', 'attitude_controller']
      }
    | {
        profile: typeof FORCE_PROFILE
        geometry: 'ground-cuboid-v1'
        capabilities: ['dynamics', 'force_attitude_height']
        controller: ForceControllerConfig
      }
  )

export type DynamicsControl =
  | ForceTarget
  | { kind: 'motors'; commands: MotorCommands }
  | { kind: 'attitude'; roll: number; pitch: number; yawRate: number; altitude: number }

/** Applied immediately before the named physics tick, starting at tick one. */
export interface ScheduledDynamicsAction {
  tick: number
  droneId: string
  armed: boolean
  control: DynamicsControl
}

export interface DynamicsObservation {
  profile: DynamicsPlan['profile']
  tick: number
  time: { numerator: number; denominator: 120; unit: 'second' }
  /** Simulator truth only. This is not a sensor or fused observation. */
  drones: Array<{
    id: string
    position: number[]
    velocity: number[]
    orientation: number[]
    angularVelocity: number[]
    battery: number
    armed: boolean
  }>
}

export interface DynamicsCheckpoint {
  readonly ownerId: string
  readonly sequence: number
  readonly tick: number
  readonly sha256: string
}

/** Privileged model input. These are actual simulator sources, never sensor measurements. */
export interface MechanicalSourceState {
  id: string
  position: [number, number, number]
  rpm: [number, number, number, number]
  mechanicalPowerW: number
}

interface StoredCheckpoint {
  serialized: string
  history: ScheduledDynamicsAction[]
  tick: number
}

interface OwnerFamily {
  owners: number
  checkpoints: number
  reconstructing: boolean
}

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join('|') !== [...keys].sort().join('|')
  ) {
    throw new Error('Expected a closed dynamics object')
  }
}

function boundedNumber(value: unknown, limit: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) {
    throw new Error('Dynamics number outside the finite operating envelope')
  }
}

function vector(value: unknown): asserts value is Vector {
  if (!Array.isArray(value) || value.length !== 3) throw new Error('Expected a three-axis position')
  for (const component of value) boundedNumber(component, 100_000)
}

function validatePlan(plan: DynamicsPlan): void {
  const sceneProfile = plan.profile === SCENE_DYNAMICS_PROFILE
  const forceProfile = plan.profile === FORCE_PROFILE
  exactKeys(plan, [
    'profile',
    'runId',
    'sourceIdentity',
    'seed',
    'capabilities',
    'geometry',
    'drones',
    ...(sceneProfile ? ['staticGeometry'] : []),
    ...(forceProfile ? ['controller'] : []),
  ])
  if (
    (!sceneProfile && !forceProfile && plan.profile !== DYNAMICS_PROFILE) ||
    !ID.test(plan.runId) ||
    !/^[a-f0-9]{64}$/.test(plan.sourceIdentity) ||
    !Number.isInteger(plan.seed) ||
    plan.seed < 0 ||
    plan.seed > 0xffff_ffff ||
    plan.geometry !== (sceneProfile ? 'static-cuboids-v1' : 'ground-cuboid-v1') ||
    JSON.stringify(plan.capabilities) !==
      (forceProfile
        ? '["dynamics","force_attitude_height"]'
        : '["dynamics","attitude_controller"]') ||
    !Array.isArray(plan.drones) ||
    plan.drones.length < 1 ||
    plan.drones.length > (forceProfile ? 1 : MAX_SCENE_DRONES)
  ) {
    throw new Error('Unsupported dynamics plan or capabilities')
  }
  if (plan.profile === SCENE_DYNAMICS_PROFILE) ownStaticGeometry(plan.staticGeometry)
  if (plan.profile === FORCE_PROFILE) ownForceControllerConfig(plan.controller)
  let previous = ''
  for (const drone of plan.drones) {
    exactKeys(drone, ['id', 'position'])
    if (!ID.test(drone.id) || drone.id <= previous)
      throw new Error('Drone roster must be sorted and unique')
    previous = drone.id
    if (Array.isArray(drone.position)) vector(drone.position)
    else {
      exactKeys(drone.position, ['uniformBox'])
      exactKeys(drone.position.uniformBox, ['min', 'max'])
      vector(drone.position.uniformBox.min)
      vector(drone.position.uniformBox.max)
      const { min, max } = drone.position.uniformBox
      if (min.some((value, axis) => value > max[axis])) {
        throw new Error('Invalid spawn box')
      }
    }
  }
}

function validateControl(control: DynamicsControl, plan: DynamicsPlan): void {
  if (control.kind === 'motors') {
    exactKeys(control, ['kind', 'commands'])
    exactKeys(control.commands, ['front_left', 'front_right', 'rear_left', 'rear_right'])
    for (const value of Object.values(control.commands)) {
      boundedNumber(value, 1)
      if (value < 0) throw new Error('Motor commands must be in [0, 1]')
    }
  } else if (control.kind === 'force_attitude_height' && plan.profile === FORCE_PROFILE) {
    ownForceTarget(control, plan.controller)
  } else if (control.kind === 'attitude' && plan.profile !== FORCE_PROFILE) {
    exactKeys(control, ['kind', 'roll', 'pitch', 'yawRate', 'altitude'])
    boundedNumber(control.roll, Math.PI)
    boundedNumber(control.pitch, Math.PI)
    boundedNumber(control.yawRate, 10)
    boundedNumber(control.altitude, 100_000)
  } else throw new Error('Unsupported dynamics control')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new Error('Non-finite dynamics state')
    if (Object.is(item, -0)) return { float64: 'negative-zero' }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    }
    return item
  })
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * One mutation owner. Checkpoint handles are in-process capabilities, not signatures.
 * No mesh, external callback, sensor, fusion, network, or wall-clock attachment is admitted.
 */
export class DeterministicDroneWorld {
  readonly ownerId = crypto.randomUUID()
  readonly branchOf: Readonly<{ ownerId: string; checkpoint: string }> | null
  #physics: DronePhysicsWorld
  #controllers = new Map<string, FlightController>()
  #controls = new Map<string, DynamicsControl | null>()
  #heldActionTicks = new Map<string, number>()
  #controlledAcceptedTick = 0
  #controlledFailure: Readonly<ControlledFailure> | null = null
  #cleanupError: Error | null = null
  #pending: ScheduledDynamicsAction[] = []
  #history: ScheduledDynamicsAction[] = []
  #checkpoints = new Map<DynamicsCheckpoint, StoredCheckpoint>()
  #tick = 0
  #rng: number
  #sequence = 0
  #phase: 'active' | 'busy' | 'retired' = 'active'
  #plan: DynamicsPlan
  #family: OwnerFamily

  private constructor(
    plan: DynamicsPlan,
    physics: DronePhysicsWorld,
    family: OwnerFamily,
    branchOf: { ownerId: string; checkpoint: string } | null = null
  ) {
    this.#physics = physics
    this.#plan = plan
    this.#family = family
    this.#rng = plan.seed
    this.branchOf = branchOf && Object.freeze(branchOf)
    Object.freeze(this)
  }

  static async prepare(plan: DynamicsPlan): Promise<DeterministicDroneWorld> {
    const ownedPlan = copyPlainData(plan)
    validatePlan(ownedPlan)
    const physics = new DronePhysicsWorld(
      'explicit',
      ownedPlan.profile === SCENE_DYNAMICS_PROFILE
        ? prepareStaticGeometry(ownedPlan.staticGeometry)
        : undefined
    )
    await physics.init()
    try {
      if (!physics.isReady() || physics.isUsingFallback())
        throw new Error('The dynamics profile requires actual Rapier')
      const owner = new DeterministicDroneWorld(ownedPlan, physics, {
        owners: 1,
        checkpoints: 0,
        reconstructing: false,
      })
      for (const row of ownedPlan.drones) {
        const position = Array.isArray(row.position)
          ? [...row.position]
          : [...row.position.uniformBox.min]
        // The explicit spawn sampler replaces ambient randomness only for this profile.
        if (!Array.isArray(row.position)) {
          for (let axis = 0; axis < 3; axis++) {
            const { min, max } = row.position.uniformBox
            position[axis] = min[axis] + owner.random() * (max[axis] - min[axis])
          }
        }
        physics.createDrone(row.id, undefined, new THREE.Vector3().fromArray(position))
        if (ownedPlan.profile !== FORCE_PROFILE)
          owner.#controllers.set(row.id, new FlightController())
        owner.#controls.set(
          row.id,
          ownedPlan.profile === FORCE_PROFILE
            ? null
            : {
                kind: 'motors',
                commands: { front_left: 0, front_right: 0, rear_left: 0, rear_right: 0 },
              }
        )
      }
      if (ownedPlan.profile === FORCE_PROFILE) {
        const drone = physics.getAllDrones()[0]
        const params = drone.params
        const physical = {
          mass: params.mass,
          gravity: 9.81,
          arm: params.armLength,
          inertia: params.momentOfInertia.toArray(),
          kt: params.thrustCoefficient,
          kq: params.torqueCoefficient,
          maxRpm: 15000,
          thrustCap: params.maxThrust,
          torqueCap: params.maxTorque,
        }
        const runtime = JSON.parse(physics.checkpoint().serialized) as { runtime: unknown }
        if (
          canonicalJson(physical) !== canonicalJson(FORCE_PHYSICAL) ||
          runtime.runtime !== '0.19.3' ||
          PHYSICS_FIXED_DT !== 1 / 120
        )
          throw new Error('Force controller requires its exact default-quad Rapier model')
      }
      return owner
    } catch (error) {
      try {
        physics.destroy()
      } catch (cleanup) {
        throw new DynamicsCleanupError(error, cleanup)
      }
      throw error
    }
  }

  private random(): number {
    // A named uint32 LCG is sufficient for deterministic placement; it is not sensor noise.
    this.#rng = (Math.imul(1664525, this.#rng) + 1013904223) >>> 0
    return this.#rng / 0x1_0000_0000
  }

  private active(): void {
    if (this.#phase !== 'active') throw new Error(`Dynamics owner is ${this.#phase}`)
  }

  schedule(action: ScheduledDynamicsAction): void {
    this.active()
    action = copyPlainData(action)
    exactKeys(action, ['tick', 'droneId', 'armed', 'control'])
    if (
      !Number.isSafeInteger(action.tick) ||
      action.tick <= this.#tick ||
      action.tick > MAX_TICKS ||
      !this.#controls.has(action.droneId) ||
      typeof action.armed !== 'boolean' ||
      this.#history.length >= MAX_PENDING ||
      this.#pending.some(
        (previous) => previous.tick === action.tick && previous.droneId === action.droneId
      )
    )
      throw new Error('Invalid, duplicate, stale, or over-budget dynamics action')
    validateControl(action.control, this.#plan)
    this.#history.push(action)
    this.#pending.push(action)
    this.#pending.sort((a, b) => a.tick - b.tick || (a.droneId < b.droneId ? -1 : 1))
  }

  advance(ticks: number): DynamicsObservation {
    this.active()
    if (this.#plan.profile === FORCE_PROFILE)
      throw new Error('Force profile requires advanceControlled')
    if (
      !Number.isSafeInteger(ticks) ||
      ticks < 1 ||
      ticks > MAX_ADVANCE_TICKS ||
      this.#tick + ticks > MAX_TICKS
    ) {
      throw new Error('Dynamics advance exceeds its tick budget')
    }
    try {
      for (let count = 0; count < ticks; count++) {
        const next = this.#tick + 1
        while (this.#pending[0]?.tick === next) {
          const action = this.#pending.shift()!
          this.#physics.getDrone(action.droneId)!.setArmed(action.armed)
          this.#controls.set(action.droneId, action.control)
        }
        for (const [id, controller] of this.#controllers) {
          const drone = this.#physics.getDrone(id)!
          const control = this.#controls.get(id)!
          if (control.kind === 'attitude') {
            drone.setMotorCommands(
              controller.update(
                drone,
                control.roll,
                control.pitch,
                control.yawRate,
                control.altitude,
                PHYSICS_FIXED_DT
              )
            )
          } else if (control.kind === 'motors') {
            controller.reset()
            drone.setMotorCommands(control.commands)
          }
        }
        this.#physics.advanceTicks(1)
        this.#tick = next
      }
      const observation = this.observe()
      canonicalJson(observation)
      return observation
    } catch (error) {
      try {
        this.retire()
      } catch (cleanup) {
        throw new DynamicsCleanupError(error, cleanup)
      }
      throw new Error('Dynamics advancement failed after mutation; owner retired', { cause: error })
    }
  }

  private controlledBody(): ControlledBodyState {
    const { state } = this.#physics.getAllDrones()[0]
    return {
      state: {
        position: state.position.toArray(),
        velocity: state.velocity.toArray(),
        orientation: state.orientation.toArray(),
        angularVelocity: state.angularVelocity.toArray(),
        armed: state.armed,
      },
      battery: state.battery,
      rotors: state.rotors.map((rotor) => ({
        rpm: rotor.rpm,
        thrust: rotor.thrust,
        torque: rotor.torque,
        position: rotor.position.toArray(),
        direction: rotor.direction,
      })),
    }
  }

  private async stateDigest(): Promise<string> {
    const bytes = new TextEncoder().encode(this.serializedState())
    if (bytes.byteLength > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint byte budget exhausted')
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  /**
   * One owned tick and bounded return value. No transport retry or durable receipt store.
   * The allowance covers encoded output only. Caller retention and heap overhead are separate.
   */
  async advanceControlled(
    outputCapacityBytes = CONTROLLED_RETURN_BYTES
  ): Promise<ControlledTransition> {
    this.active()
    if (this.#plan.profile !== FORCE_PROFILE)
      throw new Error('Controlled advancement requires the force profile')
    if (!Number.isSafeInteger(outputCapacityBytes) || outputCapacityBytes < CONTROLLED_RETURN_BYTES)
      throw new Error('Controlled output reservation exhausted before mutation')
    if (this.#tick >= MAX_TICKS) throw new Error('Dynamics advance exceeds its tick budget')
    // Reserve the entire fixed output extent before arming, motor state, or physics changes.
    const output = new Uint8Array(CONTROLLED_RETURN_BYTES)
    const next = this.#tick + 1
    const droneId = this.#plan.drones[0].id
    const pending = this.#pending.find((row) => row.tick === next)
    const control = pending?.control ?? this.#controls.get(droneId)
    if (!control)
      throw new Error('Controlled tick requires an explicitly scheduled target or motor action')
    let before: ControlledBodyState
    let postEventState: ForceState
    let controller: ReturnType<typeof computeForce> | null
    try {
      before = this.controlledBody()
      canonicalJson(before)
      postEventState = { ...before.state, armed: pending?.armed ?? before.state.armed }
      controller =
        control.kind === 'force_attitude_height'
          ? computeForce(postEventState, control, this.#plan.controller)
          : null
    } catch (error) {
      throw this.controlledRetirement(error, this.#tick, false, null)
    }
    const armed = postEventState.armed
    if (control.kind !== 'force_attitude_height' && control.kind !== 'motors')
      throw new Error('Unsupported force-profile control')
    const appliedMotorTargets = controller
      ? controller.commands
      : control.kind === 'motors'
        ? control.commands
        : null
    if (!appliedMotorTargets) throw new Error('Missing applied motor target')
    const action: ScheduledDynamicsAction = {
      tick: pending?.tick ?? this.#heldActionTicks.get(droneId)!,
      droneId,
      armed,
      control,
    }
    if (!Number.isSafeInteger(action.tick)) throw new Error('Missing held-action lineage')
    let beforeStateSha256: string | null = null
    let mutationStarted = false
    let executedTick: number | null = this.#tick
    this.#phase = 'busy'
    try {
      beforeStateSha256 = await this.stateDigest()
      mutationStarted = true
      const drone = this.#physics.getDrone(droneId)!
      if (pending) {
        this.#pending.shift()
        drone.setArmed(pending.armed)
        this.#controls.set(droneId, control)
        this.#heldActionTicks.set(droneId, pending.tick)
      }
      drone.setMotorCommands(appliedMotorTargets)
      executedTick = null
      this.#physics.advanceTicks(1)
      this.#tick = next
      executedTick = next
      const after = this.controlledBody()
      if (control.kind === 'force_attitude_height') checkForceEnvelope(after.state, control)
      const afterStateSha256 = await this.stateDigest()
      const result: ControlledTransition = {
        profile: FORCE_PROFILE,
        runId: this.#plan.runId,
        sourceIdentity: this.#plan.sourceIdentity,
        tick: next,
        beforeStateSha256,
        afterStateSha256,
        action: structuredClone(action),
        controller,
        before,
        postEventState,
        appliedMotorTargets: { ...appliedMotorTargets },
        after,
        observation: this.observation(),
      }
      const encoded = canonicalJson(result)
      const written = new TextEncoder().encodeInto(encoded, output)
      if (written.read !== encoded.length)
        throw new Error('Controlled return exceeded its reserved extent')
      this.#controlledAcceptedTick = next
      this.#phase = 'active'
      return result
    } catch (error) {
      this.#phase = 'active'
      if (!mutationStarted) throw error
      throw this.controlledRetirement(error, executedTick, mutationStarted, beforeStateSha256)
    }
  }

  private controlledRetirement(
    error: unknown,
    executedTick: number | null,
    mutationStarted: boolean,
    beforeStateSha256: string | null
  ): ControlledAdvanceError {
    const primaryFailure =
      error instanceof Error ? error.message.slice(0, 512) : 'Unknown controlled transition failure'
    let cleanupFailure: string | null = null
    try {
      this.retire()
    } catch (cleanup) {
      cleanupFailure =
        cleanup instanceof Error
          ? cleanup.message.slice(0, 512)
          : 'Unknown dynamics cleanup failure'
    }
    this.#controlledFailure = Object.freeze({
      executedTick,
      lastCompletedTick: this.#tick,
      lastAcceptedTick: this.#controlledAcceptedTick,
      beforeStateSha256,
      mutationStarted,
      primaryFailure,
      cleanupConfirmed: cleanupFailure === null,
      cleanupFailure,
    })
    return new ControlledAdvanceError(this.#controlledFailure)
  }

  /** A failed engine call cannot be relabeled as the previously completed tick. */
  controlledStatus(): {
    phase: 'active' | 'busy' | 'retired'
    executedTick: number | null
    lastCompletedTick: number
    lastAcceptedTick: number
    cleanupConfirmed: boolean | null
    failure: Readonly<ControlledFailure> | null
  } {
    if (this.#plan.profile !== FORCE_PROFILE)
      throw new Error('Controlled status requires the force profile')
    return {
      phase: this.#phase,
      executedTick: this.#controlledFailure ? this.#controlledFailure.executedTick : this.#tick,
      lastCompletedTick: this.#tick,
      lastAcceptedTick: this.#controlledAcceptedTick,
      cleanupConfirmed: this.#phase === 'retired' ? this.#cleanupError === null : null,
      failure: this.#controlledFailure,
    }
  }

  observe(): DynamicsObservation {
    this.active()
    return this.observation()
  }

  private observation(): DynamicsObservation {
    return {
      profile: this.#plan.profile,
      tick: this.#tick,
      time: { numerator: this.#tick, denominator: 120, unit: 'second' },
      drones: this.#physics.getAllDrones().map(({ id, state }) => ({
        id,
        position: state.position.toArray(),
        velocity: state.velocity.toArray(),
        orientation: state.orientation.toArray(),
        angularVelocity: state.angularVelocity.toArray(),
        battery: state.battery,
        armed: state.armed,
      })),
    }
  }

  mechanicalSources(): MechanicalSourceState[] {
    this.active()
    return this.#physics.getAllDrones().map(({ id, state }) => {
      if (state.rotors.length !== 4)
        throw new Error('Mechanical source requires four actual rotors')
      return {
        id,
        position: [state.position.x, state.position.y, state.position.z],
        rpm: [state.rotors[0].rpm, state.rotors[1].rpm, state.rotors[2].rpm, state.rotors[3].rpm],
        mechanicalPowerW: state.rotors.reduce(
          (sum, rotor) => sum + Math.abs((rotor.torque * rotor.rpm * 2 * Math.PI) / 60),
          0
        ),
      }
    })
  }

  private serializedState(): string {
    const physics = this.#physics.checkpoint()
    const controllers = [...this.#controllers].map(
      ([id, controller]): [string, FlightControllerCheckpoint] => [id, controller.checkpoint()]
    )
    const controls = structuredClone([...this.#controls])
    const pending = structuredClone(this.#pending)
    const history = structuredClone(this.#history)
    return canonicalJson({
      schema: 'crebain.dynamics-checkpoint.v1',
      plan: this.#plan,
      clock: { tick: this.#tick, frequencyHz: 120, pending, history },
      rng: {
        algorithm: 'lcg32-numerical-recipes',
        scope: 'initial-placement-only',
        state: this.#rng,
      },
      physics: JSON.parse(physics.serialized) as unknown,
      controllers,
      controls,
      ...(this.#plan.profile === FORCE_PROFILE
        ? {
            forceControl: {
              engineModel: ENGINE_MODEL,
              allocationPolicy: ALLOCATION_POLICY,
              gains: FORCE_GAINS,
              limits: FORCE_LIMITS,
              physical: FORCE_PHYSICAL,
              heldActionTicks: [...this.#heldActionTicks],
            },
          }
        : {}),
    })
  }

  async checkpoint(): Promise<DynamicsCheckpoint> {
    this.active()
    if (this.#family.checkpoints >= MAX_CHECKPOINTS)
      throw new Error('Checkpoint retention budget exhausted')
    this.#phase = 'busy'
    this.#family.checkpoints++
    try {
      const serialized = this.serializedState()
      if (new TextEncoder().encode(serialized).byteLength > MAX_CHECKPOINT_BYTES)
        throw new Error('Checkpoint byte budget exhausted')
      const handle = Object.freeze({
        ownerId: this.ownerId,
        sequence: ++this.#sequence,
        tick: this.#tick,
        sha256: await sha256(serialized),
      })
      this.#checkpoints.set(handle, {
        serialized,
        history: structuredClone(this.#history),
        tick: this.#tick,
      })
      return handle
    } catch (error) {
      this.#family.checkpoints--
      throw error
    } finally {
      this.#phase = 'active'
    }
  }

  private retained(handle: DynamicsCheckpoint): StoredCheckpoint {
    const stored = this.#checkpoints.get(handle)
    if (!stored) throw new Error('Checkpoint is foreign, altered, released, or unrecognized')
    return stored
  }

  /** Privileged reference state for an audit/label owner. Never an observation adapter. */
  checkpointState(handle: DynamicsCheckpoint): string {
    this.active()
    return this.retained(handle).serialized
  }

  releaseCheckpoint(handle: DynamicsCheckpoint): void {
    this.active()
    this.retained(handle)
    this.#checkpoints.delete(handle)
    this.#family.checkpoints--
  }

  private async reconstruct(stored: StoredCheckpoint): Promise<DeterministicDroneWorld> {
    const candidate = await DeterministicDroneWorld.prepare(this.#plan)
    try {
      for (const action of stored.history) candidate.schedule(action)
      while (candidate.#tick < stored.tick) {
        if (candidate.#plan.profile === FORCE_PROFILE) await candidate.advanceControlled()
        else candidate.advance(Math.min(MAX_ADVANCE_TICKS, stored.tick - candidate.#tick))
      }
      // A scoped comparison string never enters the retained-checkpoint map.
      const reconstructed = candidate.serializedState()
      if (new TextEncoder().encode(reconstructed).byteLength > MAX_CHECKPOINT_BYTES)
        throw new Error('Checkpoint byte budget exhausted')
      if (reconstructed !== stored.serialized) {
        throw new Error('Exact action-prefix reconstruction changed complete dynamics state')
      }
      return candidate
    } catch (error) {
      try {
        candidate.retire()
      } catch (cleanup) {
        throw new DynamicsCleanupError(error, cleanup)
      }
      throw error
    }
  }

  private adopt(candidate: DeterministicDroneWorld): void {
    this.#physics = candidate.#physics
    this.#controllers = candidate.#controllers
    this.#controls = candidate.#controls
    this.#heldActionTicks = candidate.#heldActionTicks
    this.#controlledAcceptedTick = candidate.#controlledAcceptedTick
    this.#pending = candidate.#pending
    this.#history = candidate.#history
    this.#rng = candidate.#rng
    this.#tick = candidate.#tick
    candidate.#phase = 'retired'
    candidate.#family.owners--
  }

  private reserveReconstruction(): void {
    if (this.#family.owners >= MAX_OWNERS) throw new Error('Reconstruction owner budget exhausted')
    if (this.#family.reconstructing) throw new Error('Family reconstruction already in progress')
    this.#family.reconstructing = true
    this.#family.owners++
  }

  async restore(handle: DynamicsCheckpoint): Promise<void> {
    this.active()
    const stored = this.retained(handle)
    this.reserveReconstruction()
    this.#phase = 'busy'
    let releaseReservation = true
    try {
      const candidate = await this.reconstruct(stored)
      const previous = this.#physics
      this.adopt(candidate)
      try {
        previous.destroy()
      } catch (error) {
        // The replacement may retire, but the previous world remains unconfirmed.
        releaseReservation = false
        this.#phase = 'active'
        let replacementCleanup: unknown = null
        try {
          this.retire()
        } catch (cleanup) {
          replacementCleanup = cleanup
        }
        const failure = new DynamicsCleanupError(
          new Error('Restored dynamics owner retired after resource cleanup failure'),
          new AggregateError(
            [error, ...(replacementCleanup === null ? [] : [replacementCleanup])],
            'Restore cleanup failures'
          )
        )
        this.#cleanupError = failure
        throw failure
      }
    } catch (error) {
      if (error instanceof DynamicsCleanupError) releaseReservation = false
      throw error
    } finally {
      if (releaseReservation) this.#family.owners--
      this.#family.reconstructing = false
      if (this.#phase === 'busy') this.#phase = 'active'
    }
  }

  async fork(handle: DynamicsCheckpoint): Promise<DeterministicDroneWorld> {
    this.active()
    const stored = this.retained(handle)
    this.reserveReconstruction()
    this.#phase = 'busy'
    let reconstructed: DeterministicDroneWorld | null = null
    try {
      reconstructed = await this.reconstruct(stored)
      const branch = new DeterministicDroneWorld(
        structuredClone(this.#plan),
        reconstructed.#physics,
        this.#family,
        { ownerId: this.ownerId, checkpoint: handle.sha256 }
      )
      branch.adopt(reconstructed)
      return branch
    } catch (error) {
      let failure = error
      if (reconstructed) {
        try {
          reconstructed.retire()
        } catch (cleanup) {
          failure = new DynamicsCleanupError(error, cleanup)
        }
      }
      if (!(failure instanceof DynamicsCleanupError)) this.#family.owners--
      throw failure
    } finally {
      this.#family.reconstructing = false
      this.#phase = 'active'
    }
  }

  retire(): void {
    if (this.#phase === 'retired') {
      if (this.#cleanupError) throw this.#cleanupError
      return
    }
    if (this.#phase === 'busy') throw new Error('Cannot retire during a checkpoint transaction')
    this.#phase = 'retired'
    this.#family.checkpoints -= this.#checkpoints.size
    this.#checkpoints.clear()
    this.#pending = []
    this.#history = []
    this.#controllers.clear()
    this.#controls.clear()
    this.#heldActionTicks.clear()
    try {
      this.#physics.destroy()
    } catch (error) {
      this.#cleanupError =
        error instanceof Error
          ? error
          : new Error('Unknown dynamics cleanup failure', { cause: error })
      throw this.#cleanupError
    }
    this.#family.owners--
  }
}
