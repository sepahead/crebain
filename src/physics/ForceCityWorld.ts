/** One shared CPU world with atomic admission of per-entity force-control batches. */
import * as THREE from 'three'
import { copyPlainData } from '../lib/copyPlainData'
import { MAX_SCENE_DRONES } from '../lib/sceneLimits'
import {
  DronePhysicsWorld,
  PHYSICS_FIXED_DT,
  type DronePhysicsBody,
  type MotorCommands,
} from './DronePhysics'
import {
  ALLOCATION_POLICY,
  ENGINE_MODEL,
  GAINS,
  LIMITS,
  PHYSICAL,
  checkEnvelope,
  compute,
  ownForceControllerConfig,
  ownTarget,
  type ForceControllerConfig,
  type State,
  type Target,
} from './ForceAttitudeController'
import { ownStaticGeometry, prepareStaticGeometry, type StaticCuboid } from './StaticGeometry'

export const FORCE_CITY_PROFILE = 'crebain.rapier-force-city.v1'
export const FORCE_CITY_MAX_TICKS = 7200
export const FORCE_CITY_MAX_ACTIONS = 4096
export const FORCE_CITY_RETURN_HEADER_BYTES = 4096
export const FORCE_CITY_RETURN_ENTITY_BYTES = 32768
const PLAN_BYTES = 256 * 1024
const ACTION_BYTES = 1024
// Existing physics bound, admitted plan, two bounded arrays, and shared metadata.
const STATE_BYTES =
  4 * 1024 * 1024 +
  PLAN_BYTES +
  (FORCE_CITY_MAX_ACTIONS + MAX_SCENE_DRONES) * (ACTION_BYTES + 1) +
  4096
const ID = /^[a-z][a-z0-9_-]{0,63}$/
const DIGEST = /^[a-f0-9]{64}$/

export interface ForceCityPlan {
  profile: typeof FORCE_CITY_PROFILE
  runId: string
  /** Caller-declared source identity, not loaded-code attestation. */
  sourceIdentity: string
  horizonTicks: number
  actionBudget: number
  drones: Array<{
    id: string
    position: [number, number, number]
    controller: ForceControllerConfig
  }>
  staticGeometry: StaticCuboid[]
}

export type ForceCityRow =
  | { kind: 'set'; droneId: string; armed: boolean; target: Target }
  | { kind: 'hold'; droneId: string; actionSha256: string }

/** Every row is required in the prepared order, including explicit holds. */
export interface ForceCityBatch {
  tick: number
  rows: ForceCityRow[]
}

export interface ForceCityAction {
  tick: number
  droneId: string
  armed: boolean
  target: Target
  sha256: string
}

export interface ForceCityBodyState {
  state: State
  battery: number
  rotors: Array<{
    rpm: number
    thrust: number
    torque: number
    position: number[]
    direction: number
  }>
}

export interface ForceCityEntityTransition {
  droneId: string
  selection: 'set' | 'hold'
  action: ForceCityAction
  before: ForceCityBodyState
  postEventState: State
  controller: ReturnType<typeof compute>
  appliedMotorTargets: MotorCommands
  after: ForceCityBodyState
}

export interface ForceCityTransition {
  profile: typeof FORCE_CITY_PROFILE
  runId: string
  sourceIdentity: string
  tick: number
  beforeStateSha256: string
  afterStateSha256: string
  entities: ForceCityEntityTransition[]
}

export interface ForceCityFailure {
  executedTick: number | null
  lastCompletedTick: number
  lastAcceptedTick: number
  beforeStateSha256: string | null
  mutationStarted: boolean
  historyCommitted: boolean
  admittedActions: number
  preparedRows: Array<{
    droneId: string
    actionSha256: string
    armed: boolean
    motorTargets: MotorCommands
  }>
  armedRowsCompleted: string[]
  motorRowsCompleted: string[]
  inFlight: { droneId: string; operation: 'armed' | 'motors' } | null
  physicsAttempted: boolean
  primaryFailure: string
  cleanupConfirmed: boolean
  cleanupFailure: string | null
}

/** Original exceptions remain separately available even when formatting them fails. */
export class ForceCityAdvanceError extends Error {
  constructor(
    readonly outcome: Readonly<ForceCityFailure>,
    primary: unknown,
    readonly cleanupError: unknown
  ) {
    super('Force-city transition failed; owner retired and retry is forbidden', { cause: primary })
    this.name = 'ForceCityAdvanceError'
  }
}

export class ForceCityCleanupError extends AggregateError {
  readonly cleanupConfirmed = false
  constructor(primary: unknown, cleanup: unknown) {
    super([primary, cleanup], 'Force-city preparation failed with unresolved cleanup', {
      cause: primary,
    })
    this.name = 'ForceCityCleanupError'
  }
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  require(value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('|') ===
      [...keys].sort().join('|'), 'Closed force-city data required')
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new Error('Non-finite force-city state')
    if (Object.is(item, -0)) return { float64: 'negative-zero' }
    if (item && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    return item
  })
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonical(value)).byteLength
}

async function digest(serialized: string): Promise<string> {
  const bytes = new TextEncoder().encode(serialized)
  const result = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Reserve the fixed shape with 32 bytes for each finite number, including tagged -0. */
function maximumOutputBytes(value: unknown): number {
  if (typeof value === 'number') {
    require(Number.isFinite(value), 'Non-finite force-city output')
    return 32
  }
  if (typeof value === 'boolean') return 5
  if (value === null) return 4
  if (typeof value === 'string') return byteLength(value)
  if (Array.isArray(value)) {
    const rows: unknown[] = value
    return (
      2 +
      Math.max(0, rows.length - 1) +
      rows.reduce<number>((n, row) => n + maximumOutputBytes(row), 0)
    )
  }
  require(value !== null && typeof value === 'object', 'Unsupported force-city output value')
  const entries = Object.entries(value)
  return (
    2 +
    Math.max(0, entries.length - 1) +
    entries.reduce((n, [key, row]) => n + byteLength(key) + 1 + maximumOutputBytes(row), 0)
  )
}

function boundedVector(value: number[], length: number): void {
  require(Array.isArray(value) &&
    value.length === length &&
    value.every(Number.isFinite), 'Invalid owned force-city vector')
}

function bodyState(drone: DronePhysicsBody): ForceCityBodyState {
  const { state } = drone
  const result: ForceCityBodyState = {
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
  for (const values of [result.state.position, result.state.velocity, result.state.angularVelocity])
    boundedVector(values, 3)
  boundedVector(result.state.orientation, 4)
  require(typeof result.state.armed === 'boolean' &&
    Number.isFinite(result.battery), 'Invalid owned force-city body')
  require(result.rotors.length === 4, 'Force-city requires four actual rotors')
  for (const rotor of result.rotors) {
    boundedVector(rotor.position, 3)
    require([rotor.rpm, rotor.thrust, rotor.torque].every(Number.isFinite) &&
      (rotor.direction === -1 || rotor.direction === 1), 'Invalid owned force-city rotor')
  }
  return result
}

function diagnostic(error: unknown): string {
  // Cleanup always precedes optional inspection of a possibly hostile thrown value.
  try {
    if (error && typeof error === 'object') {
      const message: unknown = (error as { message?: unknown }).message
      if (typeof message === 'string') return message.slice(0, 256)
    }
  } catch {
    // Diagnostic failure must not replace the original exception or skip retirement.
  }
  return 'Unprintable force-city failure'
}

function ownPlan(input: ForceCityPlan): ForceCityPlan {
  const plan = copyPlainData(input)
  exactKeys(plan, [
    'profile',
    'runId',
    'sourceIdentity',
    'horizonTicks',
    'actionBudget',
    'drones',
    'staticGeometry',
  ])
  require(plan.profile === FORCE_CITY_PROFILE &&
    typeof plan.runId === 'string' &&
    ID.test(plan.runId) &&
    typeof plan.sourceIdentity === 'string' &&
    DIGEST.test(plan.sourceIdentity) &&
    Number.isSafeInteger(plan.horizonTicks) &&
    plan.horizonTicks >= 1 &&
    plan.horizonTicks <= FORCE_CITY_MAX_TICKS &&
    Number.isSafeInteger(plan.actionBudget) &&
    plan.actionBudget <= FORCE_CITY_MAX_ACTIONS &&
    Array.isArray(plan.drones) &&
    plan.drones.length >= 1 &&
    plan.drones.length <= MAX_SCENE_DRONES &&
    plan.actionBudget >= plan.drones.length, 'Unsupported force-city plan or resource bounds')
  let previous = ''
  for (const row of plan.drones) {
    exactKeys(row, ['id', 'position', 'controller'])
    require(typeof row.id === 'string' &&
      ID.test(row.id) &&
      row.id > previous, 'Force-city roster must be sorted and unique')
    previous = row.id
    boundedVector(row.position, 3)
    require(row.position.every((value) => Math.abs(value) <= 100000) &&
      row.position[1] > 0.05, 'Initial force-city position outside envelope')
    ownForceControllerConfig(row.controller)
  }
  ownStaticGeometry(plan.staticGeometry)
  require(byteLength(plan) <= PLAN_BYTES, 'Force-city plan byte budget exhausted')
  return plan
}

/** CPU component only: no sensors, NCP endpoint, renderer, checkpoint handle, or fork authority. */
export class ForceCityWorld {
  #phase: 'active' | 'busy' | 'retired' = 'active'
  #tick = 0
  #acceptedTick = 0
  #actionCount = 0
  #history: ForceCityAction[] = []
  #held = new Map<string, ForceCityAction>()
  #failure: Readonly<ForceCityFailure> | null = null
  #cleanupConfirmed: boolean | null = null
  #cleanupError: unknown = null

  #plan: ForceCityPlan
  #physics: DronePhysicsWorld

  private constructor(plan: ForceCityPlan, physics: DronePhysicsWorld) {
    this.#plan = plan
    this.#physics = physics
    Object.freeze(this)
  }

  static async prepare(input: ForceCityPlan): Promise<ForceCityWorld> {
    const plan = ownPlan(input)
    const physics = new DronePhysicsWorld('explicit', prepareStaticGeometry(plan.staticGeometry))
    try {
      await physics.init()
      require(physics.isReady() && !physics.isUsingFallback(), 'Force-city requires actual Rapier')
      for (const row of plan.drones) {
        const drone = physics.createDrone(row.id, undefined, new THREE.Vector3(...row.position))
        const params = drone.params
        const actual = {
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
        require(canonical(actual) ===
          canonical(PHYSICAL), 'Force-city requires the reviewed default quadcopter')
        checkEnvelope(bodyState(drone).state, {
          kind: 'force_attitude_height',
          roll_rad: 0,
          pitch_rad: 0,
          heading_rad: row.controller.referenceHeadingRad,
          altitude_m: row.controller.referenceAltitudeM,
        })
      }
      const runtime = JSON.parse(physics.checkpoint().serialized) as { runtime: unknown }
      require(runtime.runtime === '0.19.3' &&
        PHYSICS_FIXED_DT === 1 / 120, 'Force-city engine or clock changed')
      const owner = new ForceCityWorld(plan, physics)
      owner.serializedState()
      return owner
    } catch (error) {
      try {
        physics.destroy()
      } catch (cleanup) {
        throw new ForceCityCleanupError(error, cleanup)
      }
      throw error
    }
  }

  private active(): void {
    require(this.#phase === 'active', `Force-city owner is ${this.#phase}`)
  }

  /** Privileged simulator state for byte comparisons; grants no restoration capability. */
  referenceState(): string {
    this.active()
    return this.serializedState()
  }

  private serializedState(): string {
    const serialized = canonical({
      schema: 'crebain.force-city-reference.v1',
      plan: this.#plan,
      clock: { tick: this.#tick, frequencyHz: 120 },
      history: this.#history,
      held: [...this.#held.values()],
      physics: JSON.parse(this.#physics.checkpoint().serialized) as unknown,
      forceControl: {
        engineModel: ENGINE_MODEL,
        allocationPolicy: ALLOCATION_POLICY,
        gains: GAINS,
        limits: LIMITS,
        physical: PHYSICAL,
      },
    })
    require(new TextEncoder().encode(serialized).byteLength <=
      STATE_BYTES, 'Force-city reference byte budget exhausted')
    return serialized
  }

  private ownBatch(input: ForceCityBatch): ForceCityBatch {
    const batch = copyPlainData(input)
    exactKeys(batch, ['tick', 'rows'])
    require(Number.isSafeInteger(batch.tick) &&
      batch.tick === this.#tick + 1 &&
      batch.tick <= this.#plan.horizonTicks &&
      Array.isArray(batch.rows) &&
      batch.rows.length ===
        this.#plan.drones.length, 'Force-city requires the exact next tick and complete roster')
    let changes = 0
    for (const [index, row] of batch.rows.entries()) {
      const prepared = this.#plan.drones[index]
      require(row !== null &&
        typeof row === 'object' &&
        row.droneId === prepared.id, 'Force-city row is missing, foreign, duplicated, or reordered')
      if (row.kind === 'set') {
        exactKeys(row, ['kind', 'droneId', 'armed', 'target'])
        require(typeof row.armed === 'boolean', 'Force-city armed value must be Boolean')
        ownTarget(row.target, prepared.controller)
        changes++
      } else {
        exactKeys(row, ['kind', 'droneId', 'actionSha256'])
        const held = this.#held.get(row.droneId)
        require(row.kind === 'hold' &&
          typeof row.actionSha256 === 'string' &&
          DIGEST.test(row.actionSha256) &&
          held?.sha256 === row.actionSha256, 'Force-city hold has no exact retained action')
      }
    }
    require(this.#actionCount + changes <=
      this.#plan.actionBudget, 'Force-city changed-action budget exhausted before mutation')
    return batch
  }

  async advanceControlled(
    input: ForceCityBatch,
    outputCapacityBytes = FORCE_CITY_RETURN_HEADER_BYTES +
      this.#plan.drones.length * FORCE_CITY_RETURN_ENTITY_BYTES
  ): Promise<ForceCityTransition> {
    this.active()
    this.#phase = 'busy'
    const progress = {
      executedTick: this.#tick as number | null,
      beforeStateSha256: null as string | null,
      mutationStarted: false,
      historyCommitted: false,
      preparedRows: [] as ForceCityFailure['preparedRows'],
      armedRowsCompleted: [] as string[],
      motorRowsCompleted: [] as string[],
      inFlight: null as ForceCityFailure['inFlight'],
      physicsAttempted: false,
    }
    let retireOnFailure = false
    try {
      const batch = this.ownBatch(input)
      const extent =
        FORCE_CITY_RETURN_HEADER_BYTES + this.#plan.drones.length * FORCE_CITY_RETURN_ENTITY_BYTES
      require(Number.isSafeInteger(outputCapacityBytes) &&
        outputCapacityBytes >= extent, 'Force-city output reservation exhausted before mutation')
      const actions: ForceCityAction[] = []
      for (const row of batch.rows) {
        if (row.kind === 'hold') actions.push(this.#held.get(row.droneId)!)
        else {
          const action = {
            tick: batch.tick,
            droneId: row.droneId,
            armed: row.armed,
            target: row.target,
          }
          const accepted = copyPlainData({
            ...action,
            sha256: await digest(
              canonical({
                runId: this.#plan.runId,
                sourceIdentity: this.#plan.sourceIdentity,
                action,
              })
            ),
          })
          require(byteLength(accepted) <=
            ACTION_BYTES, 'Force-city action byte budget exhausted before mutation')
          actions.push(accepted)
        }
      }
      // All calculations see the same unmodified world. A failed state/control envelope retires it.
      retireOnFailure = true
      const drones = this.#physics.getAllDrones()
      require(drones.length === actions.length &&
        drones.every(
          (drone, i) => drone.id === actions[i].droneId
        ), 'Owned force-city roster changed')
      const entities = actions.map((action, index): ForceCityEntityTransition => {
        const before = bodyState(drones[index])
        const postEventState = { ...before.state, armed: action.armed }
        const controller = compute(
          postEventState,
          action.target,
          this.#plan.drones[index].controller
        )
        return {
          droneId: action.droneId,
          selection: batch.rows[index].kind,
          action: structuredClone(action),
          before,
          postEventState,
          controller,
          appliedMotorTargets: { ...controller.commands },
          after: before,
        }
      })
      retireOnFailure = false
      progress.preparedRows = entities.map((row) => ({
        droneId: row.droneId,
        actionSha256: row.action.sha256,
        armed: row.action.armed,
        motorTargets: { ...row.appliedMotorTargets },
      }))
      const staged: ForceCityTransition = {
        profile: FORCE_CITY_PROFILE,
        runId: this.#plan.runId,
        sourceIdentity: this.#plan.sourceIdentity,
        tick: batch.tick,
        beforeStateSha256: '0'.repeat(64),
        afterStateSha256: '0'.repeat(64),
        entities,
      }
      require(maximumOutputBytes(staged) <=
        extent, 'Force-city output shape exceeds its reserved extent before mutation')
      const output = new Uint8Array(extent)
      const additions = actions.filter((_action, index) => batch.rows[index].kind === 'set')
      const history = [...this.#history, ...additions]
      const held = new Map(actions.map((action) => [action.droneId, action]))
      retireOnFailure = true
      const beforeState = this.serializedState()
      retireOnFailure = false
      progress.beforeStateSha256 = await digest(beforeState)

      // No input, history, hash, or output admission remains after this boundary.
      progress.mutationStarted = true
      this.#history = history
      this.#held = held
      this.#actionCount = history.length
      progress.historyCommitted = true
      for (const [index, drone] of drones.entries()) {
        progress.inFlight = { droneId: drone.id, operation: 'armed' }
        drone.setArmed(actions[index].armed)
        progress.armedRowsCompleted.push(drone.id)
        progress.inFlight = { droneId: drone.id, operation: 'motors' }
        drone.setMotorCommands(entities[index].appliedMotorTargets)
        progress.motorRowsCompleted.push(drone.id)
        progress.inFlight = null
      }
      progress.physicsAttempted = true
      progress.executedTick = null
      this.#physics.advanceTicks(1)
      this.#tick = batch.tick
      progress.executedTick = batch.tick
      for (const [index, drone] of drones.entries()) {
        entities[index].after = bodyState(drone)
        checkEnvelope(entities[index].after.state, actions[index].target)
      }
      staged.beforeStateSha256 = progress.beforeStateSha256
      staged.afterStateSha256 = await digest(this.serializedState())
      const encoded = canonical(staged)
      require(new TextEncoder().encodeInto(encoded, output).read ===
        encoded.length, 'Force-city return exceeded its reserved extent')
      this.#acceptedTick = batch.tick
      this.#phase = 'active'
      return staged
    } catch (primary) {
      this.#phase = 'active'
      if (!progress.mutationStarted && !retireOnFailure) throw primary
      try {
        this.retire()
      } catch {
        // retire retains the original cleanup value. Do not retry or obscure the primary.
      }
      this.#failure = copyPlainData({
        ...progress,
        lastCompletedTick: this.#tick,
        lastAcceptedTick: this.#acceptedTick,
        admittedActions: this.#actionCount,
        primaryFailure: diagnostic(primary),
        cleanupConfirmed: this.#cleanupConfirmed === true,
        cleanupFailure: this.#cleanupConfirmed === true ? null : diagnostic(this.#cleanupError),
      })
      throw new ForceCityAdvanceError(this.#failure, primary, this.#cleanupError)
    }
  }

  status() {
    return {
      phase: this.#phase,
      executedTick: this.#failure ? this.#failure.executedTick : this.#tick,
      lastCompletedTick: this.#tick,
      lastAcceptedTick: this.#acceptedTick,
      admittedActions: this.#actionCount,
      cleanupConfirmed: this.#cleanupConfirmed,
      failure: this.#failure,
    }
  }

  retire(): void {
    if (this.#phase === 'retired') {
      if (!this.#cleanupConfirmed) throw this.#cleanupError
      return
    }
    require(this.#phase !== 'busy', 'Cannot retire during a force-city transaction')
    this.#phase = 'retired'
    this.#history = []
    this.#held.clear()
    try {
      this.#physics.destroy()
      this.#cleanupConfirmed = true
    } catch (error) {
      this.#cleanupConfirmed = false
      this.#cleanupError = error
      throw error
    }
  }
}
