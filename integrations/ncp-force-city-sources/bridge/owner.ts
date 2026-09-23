import {
  ForceCityEnvironment,
  CityEnvironmentError,
  type CityObservation,
  type CityObservationHandle,
  type CitySourceOutcome,
} from '../../../src/environment/ForceCityEnvironment'
import {
  ownCityEnvironmentPlan,
  cityValueDigest,
  type CityEnvironmentPlan,
} from '../../../src/environment/CitySourceContract'
import type { SourceGraphicsLauncher } from '../../../src/environment/GraphicsContract'
import type { ForceCityBatch } from '../../../src/physics/ForceCityWorld'
import { decodeTyped, keys, rows, sha256, validate } from './codec'
import type { Prepare, ControlRow, SourceOutcome, Tensor } from './types'

export type NativePort = Pick<
  ForceCityEnvironment,
  'ownerId' | 'advance' | 'observation' | 'readChunk' | 'release' | 'resourceStatus' | 'retire'
>
export type NativeFactory = (plan: CityEnvironmentPlan) => Promise<NativePort>
export const actualFactory =
  (launch?: SourceGraphicsLauncher): NativeFactory =>
  (plan) =>
    ForceCityEnvironment.prepare(
      plan,
      plan.scene.rgbCameras.length + plan.scene.thermalCameras.length ? launch : undefined
    )

/** Resolve every compact index against one frozen shared-world mapping. */
export function nativePlan(p: Prepare, run: string, source: string): CityEnvironmentPlan {
  const staticGeometry = p.scene.solids.map((row) => ({
    id: row.id,
    center: row.center,
    halfExtents: row.half_extents,
    yaw: row.yaw,
    friction: row.friction,
    restitution: row.restitution,
  }))
  const cameras = (kind: 'rgb' | 'thermal') =>
    p.sources
      .filter((row) => row.kind === kind)
      .map((row) => {
        if (row.kind === 'pressure') throw new Error('Camera variant')
        return {
          id: row.source_id,
          position: row.position,
          target: row.target,
          width: row.width,
          height: row.height,
          fovDegrees: row.fov_degrees,
          periodTicks: row.publication_period_ticks,
        }
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return ownCityEnvironmentPlan({
    profile: 'crebain.force-city-environment.v1',
    world: {
      profile: p.world.profile,
      runId: `ncp-${run}`,
      sourceIdentity: source,
      horizonTicks: p.world.horizon_ticks,
      actionBudget: p.world.action_budget,
      drones: p.world.entity_ids.map((id, index) => ({
        id,
        position: p.world.initial_positions[index],
        controller: {
          engineModel: p.world.engine_model,
          referenceAltitudeM: p.world.controller_references[index][0],
          referenceHeadingRad: p.world.controller_references[index][1],
        },
      })),
      staticGeometry,
    },
    scene: {
      profile: 'crebain.city-scene.v1',
      id: p.scene.id,
      frame: p.world.frame,
      materials: p.scene.materials,
      solids: staticGeometry.map((shape, index) => ({
        shape,
        materialId: p.scene.materials[p.scene.solids[index].material_index]?.id,
      })),
      rgbCameras: cameras('rgb'),
      thermalCameras: cameras('thermal'),
      microphones: p.sources
        .filter((row) => row.kind === 'pressure')
        .map((row) => ({ id: row.source_id, position: row.position }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
    requests: p.sources.map((row) => ({
      requestId: row.request_id,
      sourceId: row.source_id,
      entityId: p.world.entity_ids[row.entity_index],
      kind: row.kind,
      sceneSourceId: row.source_id,
      periodTicks: row.publication_period_ticks,
    })),
    ...(p.acoustic ? { acoustic: p.acoustic } : {}),
    ...(p.thermal ? { thermal: p.thermal } : {}),
  })
}
function tensor(slot: Extract<CitySourceOutcome, { status: 'produced' }>): Tensor {
  const t = slot.tensor
  if (t.kind === 'rgba8')
    return {
      kind: 'rgba8',
      dtype: 'u8',
      shape: [t.height, t.width, 4],
      layout: 'c_contiguous',
      row_origin: t.rowOrigin,
      encoding: t.encoding,
    }
  if (t.kind === 'radiance')
    return {
      kind: 'radiance',
      dtype: t.dtype,
      shape: [t.height, t.width],
      layout: 'c_contiguous',
      row_origin: t.rowOrigin,
      unit: t.unit,
    }
  return {
    kind: 'pressure',
    dtype: t.dtype,
    shape: [t.sampleEnd - t.sampleStart],
    layout: 'c_contiguous',
    sample_start: t.sampleStart,
    sample_end: t.sampleEnd,
    sample_rate_hz: t.sampleRateHz,
    unit: t.unit,
  }
}
/** Native originals keep their declared production identity; association adds no local sensing. */
export function projectObservation(p: Prepare, value: CityObservation): Record<string, unknown> {
  if (
    value.control.rows.length !== p.world.entity_ids.length ||
    value.slots.length !== p.sources.length
  )
    throw new Error('Native complete roster')
  const control = {
    tick: value.tick,
    execution: 'known_completed',
    before_state_sha256: value.control.beforeStateSha256,
    after_state_sha256: value.control.afterStateSha256,
    native_transition_sha256: value.control.transitionSha256,
    all_motor_assignments_completed: true,
    rows: value.control.rows.map((row, index) => {
      if (row.entityId !== p.world.entity_ids[index]) throw new Error('Native control entity order')
      return [index, row.actionSha256, row.selection, row.armed]
    }),
  }
  validate('ControlReceipt', control)
  const slots: SourceOutcome[] = value.slots.map((slot, index) => {
    const requested = p.sources[index]
    if (
      slot.requestId !== requested.request_id ||
      slot.sourceId !== requested.source_id ||
      slot.entityId !== p.world.entity_ids[requested.entity_index]
    )
      throw new Error('Native source identity changed')
    const identity = {
      request_id: slot.requestId,
      source_id: slot.sourceId,
      entity_index: requested.entity_index,
    }
    let result: SourceOutcome
    switch (slot.status) {
      case 'produced':
        result = {
          ...identity,
          status: 'produced',
          source_config_digest: slot.sourceConfigSha256,
          source_body_tick: slot.sourceTick,
          available_after_body_tick: slot.availableAfterTick,
          source_production_digest: slot.productionSha256,
          original_payload_sha256: slot.originalSha256,
          byte_length: slot.byteLength,
          tensor: tensor(slot),
        }
        break
      case 'not_due':
        result = { ...identity, status: 'not_due', next_due_tick: slot.nextDueTick }
        break
      case 'failed':
        result = {
          ...identity,
          status: 'failed',
          attempted_at_tick: value.tick,
          reason: slot.reason,
          diagnostic: slot.diagnostic.replace(/[^\x20-\x7e]/g, '?').slice(0, 256),
        }
        break
      case 'absent':
        result = {
          ...identity,
          status: 'absent',
          due_at_tick: value.tick,
          reason: slot.reason,
          causal_failed_request_id: slot.causalRequestId,
        }
        break
    }
    validate('SourceOutcome', result)
    return result
  })
  return {
    owner_id: value.ownerId,
    native_plan_sha256: value.planSha256,
    scene_sha256: value.sceneSha256,
    tick: value.tick,
    previous_native_batch_sha256: value.previousBatchSha256,
    native_batch_sha256: value.batchSha256,
    source_failed: value.status === 'source_failed',
    control,
    slots,
  }
}

/** One native world and at most one retained opaque observation lease. */
export class CityBridge {
  #owner: NativePort | null = null
  #prepare: Prepare | null = null
  #lease: CityObservationHandle | null = null
  #previous: string | null = null
  #planDigest: string | null = null
  #sceneDigest: string | null = null
  #attempted = false
  #failed = false
  #retirement: Promise<boolean> | null = null
  #retirementFailures: unknown[] = []
  constructor(private readonly factory: NativeFactory) {}
  async command(input: Record<string, unknown>): Promise<unknown> {
    if (input.kind === 'retire') {
      keys(input, ['kind'])
      return { kind: 'retired', cleanup_confirmed: await this.retire() }
    }
    if (this.#retirement) throw new Error('Retired city bridge')
    if (input.kind === 'prepare') {
      keys(input, ['kind', 'run_id', 'source_identity', 'prepare'])
      if (
        this.#attempted ||
        this.#owner ||
        typeof input.run_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          input.run_id
        ) ||
        typeof input.source_identity !== 'string' ||
        !/^[0-9a-f]{64}$/.test(input.source_identity)
      )
        throw new Error('City preparation identity')
      const p = decodeTyped('Prepare', input.prepare) as Prepare
      if (
        p.world.entity_ids.length !== p.world.initial_positions.length ||
        p.world.entity_ids.length !== p.world.controller_references.length
      )
        throw new Error('City parallel rosters')
      const plan = nativePlan(p, input.run_id, input.source_identity)
      const planDigest = await cityValueDigest(plan)
      const sceneDigest = await cityValueDigest(plan.scene)
      this.#attempted = true
      this.#owner = await this.factory(plan)
      this.#prepare = p
      this.#planDigest = planDigest
      this.#sceneDigest = sceneDigest
      const r = this.#owner.resourceStatus()
      return {
        kind: 'prepared',
        data: {
          owner_id: this.#owner.ownerId,
          native_plan_sha256: planDigest,
          scene_sha256: sceneDigest,
          backing_bytes: [r.originalBackingBytes, r.receiptBackingBytes, r.controlBackingBytes],
        },
      }
    }
    const owner = this.#owner
    const p = this.#prepare
    if (!owner || !p) throw new Error('Unprepared city bridge')
    if (input.kind === 'advance') {
      keys(input, ['kind', 'tick', 'rows', 'previous_native_batch_sha256'])
      if (
        this.#failed ||
        this.#lease ||
        input.previous_native_batch_sha256 !== this.#previous ||
        typeof input.tick !== 'number' ||
        !Number.isSafeInteger(input.tick) ||
        input.tick < 1 ||
        input.tick > p.world.horizon_ticks
      )
        throw new Error('City advance lineage')
      const compact = rows(input.rows).map((row) => decodeTyped('ControlRow', row) as ControlRow)
      if (compact.length !== p.world.entity_ids.length)
        throw new Error('Whole city action roster required')
      const action: ForceCityBatch = {
        tick: input.tick,
        rows: compact.map((row, index) => {
          if (row[0] !== index) throw new Error('City action entity order')
          const droneId = p.world.entity_ids[index]
          return row[1] === 'hold'
            ? { kind: 'hold', droneId, actionSha256: row[2] }
            : {
                kind: 'set',
                droneId,
                armed: row[2],
                target: {
                  kind: 'force_attitude_height',
                  roll_rad: row[3][0],
                  pitch_rad: row[3][1],
                  heading_rad: row[3][2],
                  altitude_m: row[3][3],
                },
              }
        }),
      }
      let sourceFailed = false
      try {
        this.#lease = await owner.advance(action)
      } catch (error) {
        this.#failed = true
        if (
          !(error instanceof CityEnvironmentError) ||
          !error.handle ||
          error.outcome.stage !== 'source' ||
          error.outcome.executedTick !== input.tick ||
          error.outcome.componentCleanup !== 'confirmed'
        )
          throw error
        this.#lease = error.handle
        sourceFailed = true
      }
      const observation = owner.observation(this.#lease)
      if (
        observation.ownerId !== owner.ownerId ||
        observation.planSha256 !== this.#planDigest ||
        observation.sceneSha256 !== this.#sceneDigest ||
        observation.tick !== input.tick ||
        observation.previousBatchSha256 !== this.#previous ||
        (observation.status === 'source_failed') !== sourceFailed
      )
        throw new Error('Native city observation lineage')
      return { kind: 'advanced', batch: projectObservation(p, observation) }
    }
    if (input.kind === 'read_chunk') {
      keys(input, ['kind', 'native_batch_sha256', 'request_id', 'original_sha256', 'offset'])
      if (
        !this.#lease ||
        input.native_batch_sha256 !== this.#lease.sha256 ||
        typeof input.request_id !== 'string' ||
        typeof input.original_sha256 !== 'string' ||
        typeof input.offset !== 'number'
      )
        throw new Error('City original read identity')
      const bytes = owner.readChunk(
        this.#lease,
        input.request_id,
        input.original_sha256,
        input.offset
      )
      if (bytes.length < 1 || bytes.length > 32768) throw new Error('City original read extent')
      return {
        kind: 'chunk',
        native_batch_sha256: this.#lease.sha256,
        request_id: input.request_id,
        original_sha256: input.original_sha256,
        offset: input.offset,
        bytes_base64: Buffer.from(bytes).toString('base64'),
        chunk_sha256: sha256(bytes),
      }
    }
    if (input.kind === 'release') {
      keys(input, ['kind', 'native_batch_sha256'])
      if (!this.#lease || input.native_batch_sha256 !== this.#lease.sha256)
        throw new Error('City original release identity')
      owner.release(this.#lease)
      this.#previous = this.#lease.sha256
      this.#lease = null
      return { kind: 'released', native_batch_sha256: this.#previous }
    }
    throw new Error('Unsupported private city operation')
  }
  retire(): Promise<boolean> {
    this.#retirement ??= (async () => {
      if (!this.#owner) return !this.#attempted
      try {
        await this.#owner.retire()
        return true
      } catch (error) {
        this.#retirementFailures = [error]
        return false
      }
    })()
    return this.#retirement
  }
  /** Advisory causes stay separate from the unchanged retirement-confirmation boolean. */
  retirementFailures(): readonly unknown[] {
    return this.#retirementFailures.slice()
  }
}
