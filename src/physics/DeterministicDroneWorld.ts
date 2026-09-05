/** Explicit ownership of CREBAIN's existing Rapier dynamics and flight controllers. */
import * as THREE from 'three'
import { copyPlainData } from '../lib/copyPlainData'
import { MAX_SCENE_DRONES } from '../lib/sceneLimits'
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
  capabilities: ['dynamics', 'attitude_controller']
  drones: Array<{ id: string; position: InitialPosition }>
}

export type DynamicsPlan = DynamicsPlanBase &
  (
    | { profile: typeof DYNAMICS_PROFILE; geometry: 'ground-cuboid-v1' }
    | {
        profile: typeof SCENE_DYNAMICS_PROFILE
        geometry: 'static-cuboids-v1'
        staticGeometry: StaticCuboid[]
      }
  )

export type DynamicsControl =
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
  exactKeys(plan, [
    'profile',
    'runId',
    'sourceIdentity',
    'seed',
    'capabilities',
    'geometry',
    'drones',
    ...(sceneProfile ? ['staticGeometry'] : []),
  ])
  if (
    (!sceneProfile && plan.profile !== DYNAMICS_PROFILE) ||
    !ID.test(plan.runId) ||
    !/^[a-f0-9]{64}$/.test(plan.sourceIdentity) ||
    !Number.isInteger(plan.seed) ||
    plan.seed < 0 ||
    plan.seed > 0xffff_ffff ||
    plan.geometry !== (sceneProfile ? 'static-cuboids-v1' : 'ground-cuboid-v1') ||
    JSON.stringify(plan.capabilities) !== '["dynamics","attitude_controller"]' ||
    !Array.isArray(plan.drones) ||
    plan.drones.length < 1 ||
    plan.drones.length > MAX_SCENE_DRONES
  ) {
    throw new Error('Unsupported dynamics plan or capabilities')
  }
  if (plan.profile === SCENE_DYNAMICS_PROFILE) ownStaticGeometry(plan.staticGeometry)
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

function validateControl(control: DynamicsControl): void {
  if (control.kind === 'motors') {
    exactKeys(control, ['kind', 'commands'])
    exactKeys(control.commands, ['front_left', 'front_right', 'rear_left', 'rear_right'])
    for (const value of Object.values(control.commands)) {
      boundedNumber(value, 1)
      if (value < 0) throw new Error('Motor commands must be in [0, 1]')
    }
  } else if (control.kind === 'attitude') {
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
  #controls = new Map<string, DynamicsControl>()
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
      const owner = new DeterministicDroneWorld(ownedPlan, physics, { owners: 1, checkpoints: 0 })
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
        owner.#controllers.set(row.id, new FlightController())
        owner.#controls.set(row.id, {
          kind: 'motors',
          commands: { front_left: 0, front_right: 0, rear_left: 0, rear_right: 0 },
        })
      }
      return owner
    } catch (error) {
      physics.destroy()
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
      !this.#controllers.has(action.droneId) ||
      typeof action.armed !== 'boolean' ||
      this.#history.length >= MAX_PENDING ||
      this.#pending.some(
        (previous) => previous.tick === action.tick && previous.droneId === action.droneId
      )
    )
      throw new Error('Invalid, duplicate, stale, or over-budget dynamics action')
    validateControl(action.control)
    this.#history.push(action)
    this.#pending.push(action)
    this.#pending.sort((a, b) => a.tick - b.tick || (a.droneId < b.droneId ? -1 : 1))
  }

  advance(ticks: number): DynamicsObservation {
    this.active()
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
          } else {
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
      this.retire()
      throw new Error('Dynamics advancement failed after mutation; owner retired', { cause: error })
    }
  }

  observe(): DynamicsObservation {
    this.active()
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

  async checkpoint(): Promise<DynamicsCheckpoint> {
    this.active()
    if (this.#family.checkpoints >= MAX_CHECKPOINTS)
      throw new Error('Checkpoint retention budget exhausted')
    this.#phase = 'busy'
    this.#family.checkpoints++
    try {
      const physics = this.#physics.checkpoint()
      const controllers = [...this.#controllers].map(
        ([id, controller]): [string, FlightControllerCheckpoint] => [id, controller.checkpoint()]
      )
      const controls = structuredClone([...this.#controls])
      const pending = structuredClone(this.#pending)
      const history = structuredClone(this.#history)
      const serialized = canonicalJson({
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
      })
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
        history,
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
        candidate.advance(Math.min(MAX_ADVANCE_TICKS, stored.tick - candidate.#tick))
      }
      const checkpoint = await candidate.checkpoint()
      const reconstructed = candidate.checkpointState(checkpoint)
      candidate.releaseCheckpoint(checkpoint)
      if (reconstructed !== stored.serialized) {
        throw new Error('Exact action-prefix reconstruction changed complete dynamics state')
      }
      return candidate
    } catch (error) {
      candidate.retire()
      throw error
    }
  }

  private adopt(candidate: DeterministicDroneWorld): void {
    this.#physics = candidate.#physics
    this.#controllers = candidate.#controllers
    this.#controls = candidate.#controls
    this.#pending = candidate.#pending
    this.#history = candidate.#history
    this.#rng = candidate.#rng
    this.#tick = candidate.#tick
    candidate.#phase = 'retired'
    candidate.#family.owners--
  }

  async restore(handle: DynamicsCheckpoint): Promise<void> {
    this.active()
    const stored = this.retained(handle)
    this.#phase = 'busy'
    try {
      const candidate = await this.reconstruct(stored)
      const previous = this.#physics
      this.adopt(candidate)
      try {
        previous.destroy()
      } catch (error) {
        this.#phase = 'active'
        this.retire()
        throw new Error('Restored dynamics owner retired after resource cleanup failure', {
          cause: error,
        })
      }
    } finally {
      if (this.#phase === 'busy') this.#phase = 'active'
    }
  }

  async fork(handle: DynamicsCheckpoint): Promise<DeterministicDroneWorld> {
    this.active()
    const stored = this.retained(handle)
    if (this.#family.owners >= MAX_OWNERS) throw new Error('Fork owner budget exhausted')
    this.#phase = 'busy'
    this.#family.owners++
    try {
      const reconstructed = await this.reconstruct(stored)
      const branch = new DeterministicDroneWorld(
        structuredClone(this.#plan),
        reconstructed.#physics,
        this.#family,
        {
          ownerId: this.ownerId,
          checkpoint: handle.sha256,
        }
      )
      branch.adopt(reconstructed)
      return branch
    } catch (error) {
      this.#family.owners--
      throw error
    } finally {
      this.#phase = 'active'
    }
  }

  retire(): void {
    if (this.#phase === 'retired') return
    if (this.#phase === 'busy') throw new Error('Cannot retire during a checkpoint transaction')
    this.#phase = 'retired'
    this.#family.owners--
    this.#family.checkpoints -= this.#checkpoints.size
    this.#checkpoints.clear()
    this.#pending = []
    this.#history = []
    this.#controllers.clear()
    this.#controls.clear()
    this.#physics.destroy()
  }
}
