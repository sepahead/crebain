import { copyPlainData } from '../lib/copyPlainData'
import {
  DeterministicDroneWorld,
  SCENE_DYNAMICS_PROFILE,
  type DynamicsObservation,
  type InitialPosition,
  type ScheduledDynamicsAction,
} from '../physics/DeterministicDroneWorld'
import {
  AcousticState,
  ownAcousticConfig,
  type AcousticConfig,
  type PressureBlock,
} from './AcousticObservation'
import { ThermalState, ownThermalConfig, type ThermalConfig } from './ThermalObservation'
import { closedKeys, finiteRange, ownSceneSpec, type SceneSpec } from './SceneSpec'

export interface EnvironmentPlan {
  profile: 'crebain.cpu-city-environment.v1'
  runId: string
  sourceIdentity: string
  seed: number
  drones: Array<{ id: string; position: InitialPosition }>
  scene: SceneSpec
  acoustic: AcousticConfig
  thermal: ThermalConfig
}

export interface EnvironmentCheckpoint {
  readonly ownerId: string
  readonly sequence: number
  readonly tick: number
  readonly sha256: string
}
export class CpuReconstructionError extends Error {
  constructor(
    readonly primaryFailure: string,
    readonly cleanupConfirmed: boolean,
    readonly cleanupFailure: string | null
  ) {
    super(`CPU reconstruction rejected: ${primaryFailure}`)
    this.name = 'CpuReconstructionError'
  }
}

interface RetainedCheckpoint {
  serialized: string
  tick: number
  history: ScheduledDynamicsAction[]
  bytes: number
}
interface EnvironmentFamily {
  owners: number
  checkpoints: number
  bytes: number
  reconstructing: boolean
  reconstructionCheckpointBytes: number
  temporaryRestoreOwners: number
}
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024
const MAX_FAMILY_CHECKPOINT_BYTES = 128 * 1024 * 1024

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new Error('Non-finite environment checkpoint state')
    if (Object.is(item, -0)) return { float64: 'negative-zero' }
    if (item && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    return item
  })
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Complete CPU state only. Camera pixels require the separately owned graphics process.
 * A coupled observation owner must retire this state after failed required rendering.
 */
export class EnvironmentState {
  readonly ownerId = crypto.randomUUID()
  readonly #plan: EnvironmentPlan
  #dynamics: DeterministicDroneWorld
  #acoustic: AcousticState
  #thermal: ThermalState
  #history: ScheduledDynamicsAction[] = []
  #checkpoints = new Map<EnvironmentCheckpoint, RetainedCheckpoint>()
  #family: EnvironmentFamily = {
    owners: 1,
    checkpoints: 0,
    bytes: 0,
    reconstructing: false,
    reconstructionCheckpointBytes: 0,
    temporaryRestoreOwners: 0,
  }
  #sequence = 0
  #phase: 'active' | 'busy' | 'retired' = 'active'
  #cleanupError: Error | null = null

  private constructor(plan: EnvironmentPlan, dynamics: DeterministicDroneWorld) {
    this.#plan = plan
    this.#dynamics = dynamics
    this.#acoustic = new AcousticState(plan.acoustic, plan.scene, plan.drones.length)
    this.#thermal = new ThermalState(plan.thermal, plan.drones.length)
    Object.freeze(this)
  }

  static async prepare(input: EnvironmentPlan): Promise<EnvironmentState> {
    const plan = copyPlainData(input)
    closedKeys(plan, [
      'profile',
      'runId',
      'sourceIdentity',
      'seed',
      'drones',
      'scene',
      'acoustic',
      'thermal',
    ])
    if (plan.profile !== 'crebain.cpu-city-environment.v1')
      throw new Error('Unsupported CPU environment profile')
    ownSceneSpec(plan.scene)
    ownAcousticConfig(plan.acoustic)
    ownThermalConfig(plan.thermal)
    if (!Array.isArray(plan.drones)) throw new Error('Environment drone roster is required')
    for (const drone of plan.drones) {
      const positions = Array.isArray(drone.position)
        ? [drone.position]
        : [drone.position.uniformBox.min, drone.position.uniformBox.max]
      for (const point of positions) point.forEach((value) => finiteRange(value, -1000, 1000))
    }
    const dynamics = await DeterministicDroneWorld.prepare({
      profile: SCENE_DYNAMICS_PROFILE,
      geometry: 'static-cuboids-v1',
      staticGeometry: plan.scene.solids.map((row) => row.shape),
      runId: plan.runId,
      sourceIdentity: plan.sourceIdentity,
      seed: plan.seed,
      drones: plan.drones,
      capabilities: ['dynamics', 'attitude_controller'],
    })
    try {
      return new EnvironmentState(plan, dynamics)
    } catch (error) {
      const cleanupErrors: unknown[] = []
      try {
        dynamics.retire()
      } catch (cleanup) {
        cleanupErrors.push(cleanup)
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          [error, ...cleanupErrors],
          'CPU environment preparation failed with unresolved dynamics cleanup',
          { cause: error }
        )
      throw error
    }
  }

  private active(): void {
    if (this.#phase !== 'active') throw new Error(`CPU environment is ${this.#phase}`)
  }

  schedule(input: ScheduledDynamicsAction): void {
    this.active()
    const action = copyPlainData(input)
    this.#dynamics.schedule(action)
    this.#history.push(action)
  }

  /** Actual pressure samples. Temperature state remains a privileged rendering input. */
  advance(): PressureBlock {
    this.active()
    if (this.#dynamics.observe().tick >= 7200)
      throw new Error('Environment duration budget exhausted')
    this.#phase = 'busy'
    try {
      this.#dynamics.advance(1)
      const sources = this.#dynamics.mechanicalSources()
      this.#thermal.advance(sources.map((source) => source.mechanicalPowerW))
      const pressure = this.#acoustic.advance(
        sources.map(({ position, rpm }) => ({ position, rpm }))
      )
      this.#phase = 'active'
      return pressure
    } catch (error) {
      this.#phase = 'active'
      const cleanupErrors: unknown[] = []
      try {
        this.retire()
      } catch (cleanup) {
        cleanupErrors.push(cleanup)
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          [error, ...cleanupErrors],
          'CPU environment failed after transition with unresolved cleanup',
          { cause: error }
        )
      throw new Error('CPU environment failed after transition; owner retired', { cause: error })
    }
  }

  /** Privileged simulator reference, not a measured image or fused position. */
  reference(): {
    dynamics: DynamicsObservation
    temperaturesK: number[]
    radiancesWPerM2Sr: number[]
  } {
    this.active()
    return {
      dynamics: this.#dynamics.observe(),
      temperaturesK: this.#thermal.temperatures(),
      radiancesWPerM2Sr: this.#thermal.radiances(),
    }
  }

  async checkpoint(): Promise<EnvironmentCheckpoint> {
    this.active()
    if (
      this.#family.checkpoints >= 8 ||
      this.#family.bytes + MAX_CHECKPOINT_BYTES > MAX_FAMILY_CHECKPOINT_BYTES
    )
      throw new Error('Environment checkpoint family budget exhausted')
    this.#phase = 'busy'
    this.#family.checkpoints++
    this.#family.bytes += MAX_CHECKPOINT_BYTES
    try {
      const handle = await this.#dynamics.checkpoint()
      let dynamics: unknown
      try {
        dynamics = JSON.parse(this.#dynamics.checkpointState(handle)) as unknown
      } finally {
        this.#dynamics.releaseCheckpoint(handle)
      }
      const serialized = canonical({
        schema: 'crebain.cpu-environment-checkpoint.v1',
        plan: this.#plan,
        dynamics,
        history: this.#history,
        acoustic: this.#acoustic.checkpoint(),
        thermal: this.#thermal.checkpoint(),
      })
      const bytes = new TextEncoder().encode(serialized).byteLength
      if (bytes > MAX_CHECKPOINT_BYTES)
        throw new Error('Environment checkpoint byte budget exhausted')
      const checkpoint = Object.freeze({
        ownerId: this.ownerId,
        sequence: ++this.#sequence,
        tick: this.#dynamics.observe().tick,
        sha256: await digest(serialized),
      })
      this.#checkpoints.set(checkpoint, {
        serialized,
        tick: checkpoint.tick,
        history: structuredClone(this.#history),
        bytes,
      })
      this.#family.bytes -= MAX_CHECKPOINT_BYTES - bytes
      return checkpoint
    } catch (error) {
      this.#family.checkpoints--
      this.#family.bytes -= MAX_CHECKPOINT_BYTES
      throw error
    } finally {
      this.#phase = 'active'
    }
  }

  private retained(handle: EnvironmentCheckpoint): RetainedCheckpoint {
    const stored = this.#checkpoints.get(handle)
    if (!stored) throw new Error('Environment checkpoint is foreign, altered, or released')
    return stored
  }

  checkpointState(handle: EnvironmentCheckpoint): string {
    this.active()
    return this.retained(handle).serialized
  }

  releaseCheckpoint(handle: EnvironmentCheckpoint): void {
    this.active()
    const stored = this.retained(handle)
    this.#checkpoints.delete(handle)
    this.#family.checkpoints--
    this.#family.bytes -= stored.bytes
  }

  private async reconstruct(stored: RetainedCheckpoint): Promise<EnvironmentState> {
    let candidate: EnvironmentState | undefined
    try {
      candidate = await EnvironmentState.prepare(this.#plan)
      for (const action of stored.history) candidate.schedule(action)
      for (let tick = 0; tick < stored.tick; tick++) candidate.advance()
      const handle = await candidate.checkpoint()
      const actual = candidate.checkpointState(handle)
      candidate.releaseCheckpoint(handle)
      if (actual !== stored.serialized)
        throw new Error('Complete CPU environment reconstruction changed state')
      return candidate
    } catch (error) {
      let cleanupConfirmed = false
      let cleanupFailure: string | null = 'Candidate preparation returned no cleanup authority'
      if (candidate) {
        try {
          candidate.retire()
          cleanupConfirmed = true
          cleanupFailure = null
        } catch (cleanup) {
          cleanupFailure = String(cleanup).slice(0, 2048)
        }
      }
      throw new CpuReconstructionError(
        String(error).slice(0, 2048),
        cleanupConfirmed,
        cleanupFailure
      )
    }
  }

  async fork(handle: EnvironmentCheckpoint): Promise<EnvironmentState> {
    this.active()
    const stored = this.retained(handle)
    if (this.#family.owners >= 4) throw new Error('Environment owner family budget exhausted')
    if (this.#family.reconstructing) throw new Error('Environment family reconstruction is busy')
    if (this.#family.reconstructionCheckpointBytes !== 0)
      throw new Error('A temporary reconstruction checkpoint has unresolved cleanup')
    if (this.#family.temporaryRestoreOwners !== 0)
      throw new Error('A temporary restore owner has unresolved cleanup')
    this.#family.reconstructing = true
    this.#family.reconstructionCheckpointBytes = MAX_CHECKPOINT_BYTES
    this.#phase = 'busy'
    this.#family.owners++
    let releaseCheckpointReservation = true
    try {
      const branch = await this.reconstruct(stored)
      branch.#family.owners--
      branch.#family = this.#family
      return branch
    } catch (error) {
      if (!(error instanceof CpuReconstructionError) || error.cleanupConfirmed)
        this.#family.owners--
      else releaseCheckpointReservation = false
      throw error
    } finally {
      this.#phase = 'active'
      this.#family.reconstructing = false
      if (releaseCheckpointReservation) this.#family.reconstructionCheckpointBytes = 0
    }
  }

  async restore(handle: EnvironmentCheckpoint): Promise<void> {
    this.active()
    const stored = this.retained(handle)
    if (this.#family.reconstructing) throw new Error('Environment family reconstruction is busy')
    if (this.#family.reconstructionCheckpointBytes !== 0)
      throw new Error('A temporary reconstruction checkpoint has unresolved cleanup')
    if (this.#family.temporaryRestoreOwners !== 0)
      throw new Error('A temporary restore owner has unresolved cleanup')
    this.#family.reconstructing = true
    this.#family.reconstructionCheckpointBytes = MAX_CHECKPOINT_BYTES
    this.#family.temporaryRestoreOwners = 1
    let releaseTemporaryOwner = true
    this.#phase = 'busy'
    try {
      const candidate = await this.reconstruct(stored)
      const previous = this.#dynamics
      this.#dynamics = candidate.#dynamics
      this.#thermal = candidate.#thermal
      this.#acoustic = candidate.#acoustic
      this.#history = candidate.#history
      candidate.#phase = 'retired'
      candidate.#family.owners--
      try {
        previous.retire()
      } catch (error) {
        releaseTemporaryOwner = false
        this.#phase = 'active'
        let currentCleanup: unknown = null
        try {
          this.retire()
        } catch (cleanup) {
          currentCleanup = cleanup
        }
        throw new AggregateError(
          [error, ...(currentCleanup ? [currentCleanup] : [])],
          'Restored environment retired after unresolved previous-owner cleanup',
          { cause: error }
        )
      }
    } catch (error) {
      if (error instanceof CpuReconstructionError && !error.cleanupConfirmed)
        releaseTemporaryOwner = false
      throw error
    } finally {
      if (this.#phase === 'busy') this.#phase = 'active'
      this.#family.reconstructing = false
      if (releaseTemporaryOwner) {
        this.#family.reconstructionCheckpointBytes = 0
        this.#family.temporaryRestoreOwners = 0
      }
    }
  }

  retire(): void {
    if (this.#phase === 'retired') {
      if (this.#cleanupError) throw this.#cleanupError
      return
    }
    this.active()
    this.#phase = 'retired'
    try {
      this.#dynamics.retire()
    } catch (error) {
      this.#cleanupError = new Error('CPU environment resource cleanup remains unresolved', {
        cause: error,
      })
      throw this.#cleanupError
    }
    this.#family.owners--
    for (const stored of this.#checkpoints.values()) {
      this.#family.checkpoints--
      this.#family.bytes -= stored.bytes
    }
    this.#checkpoints.clear()
  }

  resourceStatus(): {
    retainedOwners: number
    retainedCheckpoints: number
    retainedBytes: number
    reconstructionCheckpointBytes: number
    temporaryRestoreOwners: number
    cleanup: 'not_retired' | 'confirmed' | 'unresolved'
  } {
    return {
      retainedOwners: this.#family.owners,
      retainedCheckpoints: this.#family.checkpoints,
      retainedBytes: this.#family.bytes,
      reconstructionCheckpointBytes: this.#family.reconstructionCheckpointBytes,
      temporaryRestoreOwners: this.#family.temporaryRestoreOwners,
      cleanup:
        this.#phase !== 'retired' ? 'not_retired' : this.#cleanupError ? 'unresolved' : 'confirmed',
    }
  }
}
