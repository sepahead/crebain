import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  EnvironmentAncestry,
  ObservationHandle,
  StaticRenderCheckpoint,
} from '../../../src/environment/EnvironmentOwner'
import type { EnvironmentPlan } from '../../../src/environment/EnvironmentState'
import { exactJson } from '../../../src/environment/ExactJson'
import type { ScheduledDynamicsAction } from '../../../src/physics/DeterministicDroneWorld'
import { NativeCheckpointFamily, type CheckpointOwner } from './family'
import { sha256 } from './codec'
import { PRESSURE_TARGET_DIGEST } from './pressure-window'
import type {
  Advanced,
  BranchAncestry,
  BufferBinding,
  Command,
  CommittedStamp,
  FamilyPlan,
  FamilyAdvanced,
  SetTarget,
  Specification,
} from './family-types'

export const digest = (value: unknown): string => sha256(JSON.stringify(value))
export const sourceIdentity = 'a'.repeat(64)
export function binding(): BufferBinding {
  return {
    profile_digest: 'b'.repeat(64),
    application_digest: 'c'.repeat(64),
    run_id: randomUUID(),
    endpoint_id: randomUUID(),
    generation: randomUUID(),
  }
}
export const neutral: SetTarget = {
  kind: 'set_target',
  armed: true,
  roll_rad: 0,
  pitch_rad: 0,
  heading_rad: 0,
  altitude_m: 8,
}

export function familyPlan(branches = 2): FamilyPlan {
  const original = JSON.parse(
    readFileSync(new URL('../contracts/m1.workload.v1.json', import.meta.url), 'utf8')
  ) as { specification: Specification }
  const spec = structuredClone(original.specification)
  const scene = {
    ...spec.scene,
    thermalCameras: [],
    rgbCameras: spec.scene.rgbCameras.map((camera) => ({
      ...camera,
      width: 8,
      height: 8,
      periodTicks: 3,
    })),
  }
  return {
    family_id: randomUUID(),
    canonical_binding: binding(),
    body: {
      specification: { ...spec, scene },
      planned_ticks: 6,
      composition_digest: 'e'.repeat(64),
    },
    landmark_tick: 3,
    branches: Array.from({ length: branches }, (_, index) => ({
      slot: index + 1,
      case_id: `case-${index + 1}`,
      purpose: 'label',
      binding: binding(),
      target: { ...neutral },
    })),
    evaluation: {
      kind: 'scaled_compensated_pressure_rms400_v1',
      sensor_id: 'pressure:mic-a',
      first_tick: 4,
      last_tick: 6,
      sample_count: 400,
      unit: 'pascal',
      target_function_digest: PRESSURE_TARGET_DIGEST,
    },
    limits: {
      total_wall_seconds: 600,
      endpoint_count: branches + 1,
      max_active_native_owners: 2,
      public_checkpoint_slots: 1,
      temporary_checkpoint_slots: 1,
      evaluation_window_bytes: 3200,
    },
  }
}

interface Snapshot {
  tick: number
  history: ScheduledDynamicsAction[]
  previous: string
  metadata: string
  cpu: string
}

/** Deliberately synthetic, deterministic owner. It does not execute dynamics or render pixels. */
export class SyntheticCheckpointOwner implements CheckpointOwner {
  readonly ownerId = randomUUID()
  readonly generation = randomUUID()
  tick = 0
  history: ScheduledDynamicsAction[] = []
  previous: string | null = null
  ancestry: EnvironmentAncestry | null = null
  lease: ObservationHandle | null = null
  json = ''
  readonly checkpoints = new Map<StaticRenderCheckpoint, Snapshot>()
  readonly children: SyntheticCheckpointOwner[] = []
  retired = false
  retirementCalls = 0
  failRetire = false
  failFork: unknown = null
  mismatchCpu = false
  mismatchPixels = false
  corruptAncestry = false
  inheritedRenderTick: number | null = null
  constructor(readonly plan: EnvironmentPlan) {}

  schedule(action: ScheduledDynamicsAction): void {
    this.history.push(structuredClone(action))
  }
  private pixelRows(modality: 'rgb' | 'thermal', tick: number, digestOnly = false): unknown[] {
    const cameras = modality === 'rgb' ? this.plan.scene.rgbCameras : this.plan.scene.thermalCameras
    return cameras
      .filter((camera) => tick % camera.periodTicks === 0)
      .map((camera) => {
        const bytes = Buffer.alloc(
          camera.width * camera.height * 4,
          modality === 'rgb' ? (this.mismatchPixels ? 1 : 0) : 0
        )
        return {
          cameraId: camera.id,
          width: camera.width,
          height: camera.height,
          encoding: modality === 'rgb' ? 'rgba8-srgb' : 'float32-le',
          ...(modality === 'thermal' ? { unit: 'W/(m2 sr)' } : {}),
          ...(digestOnly ? { sha256: sha256(bytes) } : { bytesBase64: bytes.toString('base64') }),
        }
      })
  }
  async advance(): Promise<ObservationHandle> {
    if (this.retired || this.lease) throw new Error('Synthetic owner is unavailable')
    const tick = ++this.tick
    const start = Math.floor(((tick - 1) * 16000) / 120),
      end = Math.floor((tick * 16000) / 120)
    const pressure = Buffer.alloc((end - start) * 8)
    for (let index = 0; index < end - start; index++)
      pressure.writeDoubleLE((index + start) % 17 === 0 ? -0 : (index + start) / 100, index * 8)
    this.json = JSON.stringify({
      profile: 'crebain.force-ground-observation.v1',
      environmentProfile: this.plan.profile,
      planSha256: sha256(exactJson(this.plan)),
      privilegedControl: { synthetic: true },
      ownerId: this.ownerId,
      ancestry: this.corruptAncestry ? null : this.ancestry,
      sourceIdentity: this.plan.sourceIdentity,
      sceneSha256: sha256(exactJson(this.plan.scene)),
      tick,
      time: { numerator: tick, denominator: 120, unit: 'second' },
      previousBatchSha256: this.previous,
      privilegedReference: { synthetic: true },
      pressure: {
        sampleStart: start,
        sampleEnd: end,
        sampleRateHz: 16000,
        unit: 'pascal',
        channels: this.plan.scene.microphones.map((microphone) => ({
          microphoneId: microphone.id,
          encoding: 'float64-le',
          bytesBase64: pressure.toString('base64'),
        })),
      },
      graphics: {
        generation: this.generation,
        planSha256: digest(this.plan.scene),
        inputSha256: digest({ tick }),
        tick,
        rowOrigin: 'bottom-left',
        rgb: this.pixelRows('rgb', tick),
        thermal: this.pixelRows('thermal', tick),
      },
    })
    this.lease = Object.freeze({ ownerId: this.ownerId, tick, sha256: sha256(this.json) })
    this.previous = this.lease.sha256
    return this.lease
  }
  readObservation(handle: ObservationHandle): string {
    if (handle !== this.lease) throw new Error('Foreign synthetic observation')
    return this.json
  }
  releaseObservation(handle: ObservationHandle): void {
    if (handle !== this.lease) throw new Error('Foreign synthetic observation')
    this.lease = null
  }
  async checkpoint(): Promise<StaticRenderCheckpoint> {
    if (this.retired || this.lease || !this.tick || this.tick % 3 !== 0)
      throw new Error('Synthetic checkpoint boundary')
    const cpu = JSON.stringify({
      tick: this.tick,
      history: this.history,
      mismatch: this.mismatchCpu,
    })
    const inputJson = JSON.stringify({ tick: this.tick })
    const metadata = JSON.stringify({
      profile: 'crebain.static-render-checkpoint.v1',
      ownerId: this.ownerId,
      sourceIdentity: this.plan.sourceIdentity,
      sceneSha256: sha256(exactJson(this.plan.scene)),
      graphicsPlanSha256: digest(this.plan.scene),
      graphicsGeneration: this.generation,
      tick: this.tick,
      acceptedBatchSha256: this.previous,
      actionPosition: this.history.length,
      cpuSha256: sha256(cpu),
      render: {
        inputJson,
        inputSha256: sha256(inputJson),
        pixelsJson: JSON.stringify({
          rowOrigin: 'bottom-left',
          rgb: this.pixelRows('rgb', this.tick, true),
          thermal: this.pixelRows('thermal', this.tick, true),
        }),
      },
      scope: 'SYNTHETIC component control only',
    })
    const handle = Object.freeze({
      ownerId: this.ownerId,
      sequence: this.checkpoints.size + 1,
      tick: this.tick,
      sha256: sha256(metadata),
    })
    this.checkpoints.set(handle, {
      tick: this.tick,
      history: structuredClone(this.history),
      previous: this.previous!,
      metadata,
      cpu,
    })
    return handle
  }
  checkpointAudit(handle: StaticRenderCheckpoint): {
    metadataJson: string
    cpuCheckpointJson: string
  } {
    const checkpoint = this.checkpoints.get(handle)
    if (!checkpoint || this.retired) throw new Error('Foreign, copied, or retired native handle')
    return { metadataJson: checkpoint.metadata, cpuCheckpointJson: checkpoint.cpu }
  }
  releaseCheckpoint(handle: StaticRenderCheckpoint): void {
    if (!this.checkpoints.delete(handle)) throw new Error('Foreign or released native handle')
  }
  async fork(handle: StaticRenderCheckpoint): Promise<CheckpointOwner> {
    if (this.failFork) throw this.failFork
    const checkpoint = this.checkpoints.get(handle)
    if (!checkpoint || this.retired) throw new Error('Foreign, copied, or retired native handle')
    const child = new SyntheticCheckpointOwner(this.plan)
    child.tick = checkpoint.tick
    child.history = structuredClone(checkpoint.history)
    child.previous = checkpoint.previous
    child.mismatchCpu = this.mismatchCpu
    child.mismatchPixels = this.mismatchPixels
    child.ancestry = {
      parentOwnerId: this.ownerId,
      checkpointSha256: handle.sha256,
      checkpointTick: handle.tick,
      parentAcceptedBatchSha256: checkpoint.previous,
      acceptedActionPosition: checkpoint.history.length,
      graphicsGeneration: child.generation,
      reconstruction: 'exact-cpu-and-current-static-pixels',
    }
    this.children.push(child)
    return child
  }
  async retire(): Promise<void> {
    this.retirementCalls++
    this.retired = true
    if (this.failRetire) throw new Error('Synthetic native cleanup unresolved')
    this.lease = null
    this.checkpoints.clear()
  }
}

export class FamilyHarness {
  readonly family: NativeCheckpointFamily
  parent: SyntheticCheckpointOwner | null = null
  readonly sequences = new Map<number, number>()
  readonly lastBatch = new Map<number, string>()
  readonly acceptedAction = new Map<number, string>()
  readonly lastStamp = new Map<number, CommittedStamp>()
  readonly ancestry = new Map<number, BranchAncestry>()
  transformCommit: ((value: FamilyAdvanced, stamp: CommittedStamp) => FamilyAdvanced) | null = null
  constructor(
    readonly plan = familyPlan(),
    now?: () => number
  ) {
    this.family = new NativeCheckpointFamily(
      plan,
      digest(plan),
      sourceIdentity,
      async (nativePlan) => {
        this.parent = new SyntheticCheckpointOwner(nativePlan)
        return this.parent
      },
      now
    )
  }
  stamp(slot: number, requestDigest = digest(randomUUID())): CommittedStamp {
    const sequence = (this.sequences.get(slot) ?? 0) + 1
    this.sequences.set(slot, sequence)
    const stamp = {
      binding: slot === 0 ? this.plan.canonical_binding : this.plan.branches[slot - 1].binding,
      sequence,
      request_digest: requestDigest,
      result_digest: digest([slot, sequence, requestDigest]),
    }
    this.lastStamp.set(slot, stamp)
    return stamp
  }
  command(slot: number, tick: number, target?: SetTarget): Command {
    return {
      kind: 'advance_tick',
      tick,
      previous_batch_digest: this.lastBatch.get(slot) ?? null,
      action: target ?? {
        kind: 'hold',
        accepted_action_request_digest: this.acceptedAction.get(slot)!,
      },
      capture_reservation: { kind: 'absent' },
    }
  }
  async advance(slot: number, tick: number, target?: SetTarget): Promise<Advanced> {
    const request = digest([slot, tick, target ?? null])
    const command = this.command(slot, tick, target)
    const returned = await this.family.advance(slot, command, request)
    if (target) this.acceptedAction.set(slot, request)
    const binding = slot === 0 ? this.plan.canonical_binding : this.plan.branches[slot - 1].binding
    const start = Math.floor(((tick - 1) * 16000) / 120),
      end = Math.floor((tick * 16000) / 120)
    const result: Advanced = {
      kind: 'advanced',
      tick,
      accepted_action_request_digest: this.acceptedAction.get(slot)!,
      batch: {
        schema: 'crebain.sensor-batch.v1',
        plan_digest: digest(this.plan),
        engine_owner_id: returned.batch.engine_owner_id,
        engine_batch_sha256: returned.batch.engine_batch_sha256,
        source_identity: sourceIdentity,
        scene_sha256: returned.batch.scene_sha256,
        body_tick: tick,
        previous_batch_digest: this.lastBatch.get(slot) ?? null,
        batch_digest: digest([slot, tick, 'batch']),
        slots: returned.batch.payloads.map((payload, index) => ({
          kind: 'due',
          sensor_id: payload.sensor_id,
          byte_manifest: {
            schema: 'ncp.modular.buffer-manifest.v1',
            binding,
            buffer_id: tick * 16 + index + 1,
            creating_request_digest: request,
            causal_predecessor: null,
            semantic_digest: digest(payload.kind),
            byte_length: payload.byte_length,
            payload_sha256: payload.payload_sha256,
            chunk_bytes: 32768,
            chunk_count: Math.ceil(payload.byte_length / 32768),
            imported_manifest_digest: null,
            manifest_digest: digest([slot, tick, index, 'bytes']),
          },
          typed_manifest: {
            schema: 'crebain.sensor-manifest.v1',
            sensor_contract_digest: digest(payload.kind),
            sensor_id: payload.sensor_id,
            byte_manifest_digest: digest([slot, tick, index, 'bytes']),
            engine_batch_sha256: returned.batch.engine_batch_sha256,
            source_body_tick: tick,
            available_after_body_tick: tick,
            manifest_digest: digest([slot, tick, index, 'typed']),
            tensor:
              payload.kind === 'pressure'
                ? {
                    kind: 'pressure',
                    dtype: 'f64le',
                    shape: [end - start],
                    layout: 'c_contiguous',
                    sample_start: start,
                    sample_end: end,
                    sample_rate_hz: 16000,
                    unit: 'pascal',
                  }
                : {
                    kind: 'rgba8',
                    dtype: 'u8',
                    shape: [8, 8, 4],
                    layout: 'c_contiguous',
                    row_origin: 'bottom-left',
                    encoding: 'rgba8-srgb',
                  },
          },
        })),
      },
    }
    const finalState = await this.family.releaseLease(slot)
    const stamp = this.stamp(slot, request)
    const committedValue: FamilyAdvanced = {
      kind: 'family_advanced',
      body: result,
      ancestry: this.ancestry.get(slot) ?? null,
      canonical_final_state: finalState,
    }
    this.family.observeAdvanceCommit(
      slot,
      stamp,
      this.transformCommit?.(committedValue, stamp) ?? committedValue
    )
    this.lastBatch.set(slot, result.batch.batch_digest)
    return result
  }

  observeRestore(slot: number, ancestry: BranchAncestry): void {
    this.ancestry.set(slot, ancestry)
    this.family.observeRestoreCommit(slot, this.stamp(slot))
  }
  async selectedCanonical(): Promise<
    Awaited<ReturnType<NativeCheckpointFamily['createCheckpoint']>>
  > {
    await this.family.prepare()
    this.family.observePrepareCommit(this.stamp(0))
    for (let tick = 1; tick <= this.plan.landmark_tick; tick++)
      await this.advance(0, tick, tick === 1 ? neutral : undefined)
    const checkpoint = await this.family.createCheckpoint(this.lastBatch.get(0)!)
    this.family.observeCheckpointCommit(this.stamp(0))
    this.family.select(
      checkpoint.reference,
      this.plan.branches[0].case_id,
      digest('frozen-forecast')
    )
    this.family.observeDecisionCommit(this.stamp(0))
    for (let tick = this.plan.landmark_tick + 1; tick <= this.plan.body.planned_ticks; tick++)
      await this.advance(
        0,
        tick,
        tick === this.plan.landmark_tick + 1 ? this.plan.branches[0].target : undefined
      )
    return checkpoint
  }
}
