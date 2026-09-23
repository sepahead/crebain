import { randomUUID } from 'node:crypto'
import {
  EnvironmentOwner,
  EnvironmentForkError,
  observationEnvelopeBytes,
  type EnvironmentAncestry,
  type StaticRenderCheckpoint,
} from '../../../src/environment/EnvironmentOwner'
import type { EnvironmentPlan } from '../../../src/environment/EnvironmentState'
import { exactJson } from '../../../src/environment/ExactJson'
import { keys, object, rows, sha256, validateFrozen } from './codec'
import { SensorBridge, type GraphicsFactory, type LeaseOwner } from './owner'
import { PRESSURE_TARGET_DIGEST, PRESSURE_WINDOW_BYTES, pressureWindowRms } from './pressure-window'
import type {
  Advanced,
  BranchAncestry,
  BranchPlan,
  BufferBinding,
  CanonicalFinalState,
  Checkpointed,
  CheckpointReference,
  Command,
  CommittedStamp,
  DecisionCommitted,
  EvaluationResult,
  FamilyAdvanced,
  FamilyPlan,
  PixelIdentity,
  PressureSegment,
  ReservationReference,
} from './family-types'

/** Actual in-process owners carry authority; no serialized input implements this interface. */
export interface CheckpointOwner extends LeaseOwner {
  checkpoint(): Promise<StaticRenderCheckpoint>
  checkpointAudit(handle: StaticRenderCheckpoint): {
    metadataJson: string
    cpuCheckpointJson: string
  }
  releaseCheckpoint(handle: StaticRenderCheckpoint): void
  fork(handle: StaticRenderCheckpoint): Promise<CheckpointOwner>
}
export type CheckpointOwnerFactory = (
  plan: EnvironmentPlan,
  maximum: number
) => Promise<CheckpointOwner>

/** Use the native owner without changing its CPU reconstruction or renderer comparison. */
export function actualFamilyFactory(graphics: GraphicsFactory): CheckpointOwnerFactory {
  return (plan, maximum) =>
    EnvironmentOwner.prepare(
      plan,
      graphics,
      maximum,
      observationEnvelopeBytes(plan.profile, maximum)
    )
}

interface NativeBatch {
  engine_owner_id: string
  source_identity: string
  scene_sha256: string
  body_tick: number
  engine_batch_sha256: string
  previous_engine_batch_sha256: string | null
  payloads: Array<{ sensor_id: string; kind: string; byte_length: number; payload_sha256: string }>
}
interface Endpoint {
  slot: number
  binding: BufferBinding
  native: CheckpointOwner | null
  bridge: SensorBridge | null
  tick: number
  nativeBatch: string | null
  sensorBatch: string | null
  acceptedAction: string | null
  lastStamp: CommittedStamp | null
  lease: boolean
  pending: { batch: NativeBatch; requestDigest: string } | null
}
interface Branch {
  plan: BranchPlan
  endpoint: Endpoint
  reservation: ReservationReference | null
  reservationCommitted: boolean
  ancestry: BranchAncestry | null
  restoredCommitted: boolean
  window: Buffer | null
  windowBytes: number
  segments: PressureSegment[]
  evaluated: EvaluationResult | null
  evaluationCommit: CommittedStamp | null
  nativeRetired: boolean
  terminal: CommittedStamp | null
  ackSent: boolean
  channelClosed: boolean
}
interface AuditSummary {
  cpu: string
  graphicsPlan: string
  generation: string
  input: string
  pixels: PixelIdentity[]
  acceptedBatch: string
  actionPosition: number
}

function checked<T>(name: string, value: unknown): T {
  validateFrozen(name, value, 'family')
  return structuredClone(value) as T
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}

/** Bit-sensitive equality for admitted closed values; object member order is irrelevant. */
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => equal(item, right[index]))
    )
  const a = Object.entries(left)
  const b = right as Record<string, unknown>
  return (
    a.length === Object.keys(b).length &&
    a.every(([key, value]) => Object.hasOwn(b, key) && equal(value, b[key]))
  )
}

function endpoint(
  slot: number,
  binding: BufferBinding,
  tick = 0,
  nativeBatch: string | null = null
): Endpoint {
  return {
    slot,
    binding,
    native: null,
    bridge: null,
    tick,
    nativeBatch,
    sensorBatch: null,
    acceptedAction: null,
    lastStamp: null,
    lease: false,
    pending: null,
  }
}

/** Named byte allowances include dormant endpoints; they are not a total process-RSS limit. */
export function familyReservationBytes(
  endpointCount: number,
  maximumDueBytes: number
): {
  sdk_owners_and_clients: number
  frame_queues: number
  bridge_scratch: number
  native_raw_payloads: number
  receiver_assembly: number
  pressure_window: number
  client_pressure_window: number
  ingress_requested_stack: number
  guardian_diagnostic_prefix: number
} {
  if (
    !Number.isSafeInteger(endpointCount) ||
    endpointCount < 2 ||
    endpointCount > 16 ||
    !Number.isSafeInteger(maximumDueBytes) ||
    maximumDueBytes < 1 ||
    maximumDueBytes > 32 * 1024 * 1024
  )
    throw new Error('Family reservation bounds')
  const frame = 65536,
    chunk = 32768
  return {
    sdk_owners_and_clients: endpointCount * (1261568 + 1085440),
    frame_queues: 2 * endpointCount * frame,
    bridge_scratch: 10 * frame + 2 * chunk,
    native_raw_payloads: maximumDueBytes,
    receiver_assembly: 3 * maximumDueBytes + chunk,
    pressure_window: PRESSURE_WINDOW_BYTES,
    client_pressure_window: PRESSURE_WINDOW_BYTES,
    ingress_requested_stack: endpointCount * 256 * 1024,
    guardian_diagnostic_prefix: 128 * 1024,
  }
}

/**
 * Private native half of the optional live family. SDK commit and channel facts must
 * come from the sole trusted Rust host, never from a peer-supplied closure claim.
 * This component does not construct SDK Owners or prove process retirement.
 */
export class NativeCheckpointFamily {
  readonly plan: FamilyPlan
  readonly reservationBytes: ReturnType<typeof familyReservationBytes>
  private readonly canonical: Endpoint
  private readonly branches: Branch[]
  private readonly started: number
  private lastObservedTime: number
  private readonly preparation: Record<string, unknown>
  private readonly nativePlanSha: string
  private readonly sceneSha: string
  private readonly maximum: number
  private checkpoint: {
    handle: StaticRenderCheckpoint
    summary: AuditSummary
    result: Checkpointed
    committed: boolean
  } | null = null
  private decision: DecisionCommitted | null = null
  private decisionStamp: CommittedStamp | null = null
  private selectedExecution: CommittedStamp | null = null
  private canonicalFinal: { summary: AuditSummary; state: CanonicalFinalState } | null = null
  private checkpointReleased = false
  private preparedCommitted = false
  private releaseCommitted = false
  private activeBranch: Branch | null = null
  private nextBranch = 0
  private busy = false
  private pendingWork: Promise<unknown> | null = null
  private failed = false
  private closed = false
  private cleanup: Promise<boolean> | null = null
  private readonly cleanupFailures: unknown[] = []
  private forkCleanupUnresolved = false
  private readonly nativeIds = new Set<string>()
  private readonly graphicsGenerations = new Set<string>()

  constructor(
    input: FamilyPlan,
    readonly familyPlanDigest: string,
    private readonly sourceIdentity: string,
    private readonly factory: CheckpointOwnerFactory,
    private readonly now: () => number = () => performance.now()
  ) {
    this.plan = freeze(checked<FamilyPlan>('FamilyPlan', input))
    checked('Digest', familyPlanDigest)
    checked('Digest', sourceIdentity)
    const plan = this.plan
    const horizon = plan.body.planned_ticks
    const cameras = [
      ...plan.body.specification.scene.rgbCameras,
      ...plan.body.specification.scene.thermalCameras,
    ]
    const target = plan.evaluation
    const bindings = [plan.canonical_binding, ...plan.branches.map((row) => row.binding)]
    if (
      plan.limits.endpoint_count !== bindings.length ||
      plan.landmark_tick >= horizon ||
      !cameras.length ||
      cameras.some(
        (camera) =>
          plan.landmark_tick % camera.periodTicks !== 0 || horizon % camera.periodTicks !== 0
      ) ||
      target.first_tick <= plan.landmark_tick ||
      target.last_tick !== horizon ||
      target.first_tick + 2 !== target.last_tick ||
      Math.floor((target.last_tick * 16000) / 120) -
        Math.floor(((target.first_tick - 1) * 16000) / 120) !==
        400 ||
      target.target_function_digest !== PRESSURE_TARGET_DIGEST ||
      !plan.body.specification.scene.microphones.some(
        (microphone) => `pressure:${microphone.id}` === target.sensor_id
      ) ||
      new Set(plan.branches.map((row) => row.case_id)).size !== plan.branches.length ||
      plan.branches.some((row, index) => row.slot !== index + 1) ||
      ['run_id', 'endpoint_id', 'generation'].some(
        (field) =>
          new Set(bindings.map((binding) => binding[field as keyof BufferBinding])).size !==
          bindings.length
      ) ||
      bindings.some(
        (binding) =>
          binding.profile_digest !== bindings[0].profile_digest ||
          binding.application_digest !== bindings[0].application_digest
      )
    )
      throw new Error('Family plan admission')
    this.maximum =
      cameras.reduce((sum, camera) => sum + camera.width * camera.height * 4, 0) +
      plan.body.specification.scene.microphones.length * 134 * 8
    this.reservationBytes = familyReservationBytes(bindings.length, this.maximum)
    this.canonical = endpoint(0, plan.canonical_binding)
    this.branches = plan.branches.map((row) => ({
      plan: row,
      endpoint: endpoint(row.slot, row.binding),
      reservation: null,
      reservationCommitted: false,
      ancestry: null,
      restoredCommitted: false,
      window: null,
      windowBytes: 0,
      segments: [],
      evaluated: null,
      evaluationCommit: null,
      nativeRetired: false,
      terminal: null,
      ackSent: false,
      channelClosed: false,
    }))
    this.preparation = {
      kind: 'prepare',
      run_id: plan.canonical_binding.run_id,
      source_identity: sourceIdentity,
      specification: plan.body.specification,
      planned_ticks: horizon,
    }
    const nativePlan = {
      ...plan.body.specification,
      runId: `ncp-${plan.canonical_binding.run_id}`,
      sourceIdentity,
    }
    this.nativePlanSha = sha256(exactJson(nativePlan))
    this.sceneSha = sha256(exactJson(plan.body.specification.scene))
    this.started = now()
    if (!Number.isFinite(this.started)) throw new Error('Family clock unavailable')
    this.lastObservedTime = this.started
  }

  private observeTime(): void {
    let current: number
    try {
      current = this.now()
    } catch (error) {
      this.failed = true
      throw error
    }
    const elapsed = current - this.started
    if (
      !Number.isFinite(elapsed) ||
      current < this.lastObservedTime ||
      elapsed >= this.plan.limits.total_wall_seconds * 1000
    )
      this.failed = true
    else this.lastObservedTime = current
  }

  private active(): void {
    this.observeTime()
    if (this.closed || this.failed || this.busy) throw new Error('Family retired, busy, or expired')
  }

  private async perform<T>(operation: () => Promise<T>): Promise<T> {
    this.active()
    this.busy = true
    const work = Promise.resolve().then(operation)
    this.pendingWork = work
    try {
      const result = await work
      this.observeTime()
      if (this.closed || this.failed)
        throw new Error('Native operation completed after family retirement or deadline')
      return result
    } catch (error) {
      this.failed = true
      throw error
    } finally {
      this.busy = false
      this.pendingWork = null
    }
  }

  private selected(slot: number): Endpoint {
    if (slot === 0) return this.canonical
    const branch = this.activeBranch
    if (!branch || branch.plan.slot !== slot || !branch.endpoint.bridge || branch.nativeRetired)
      throw new Error('Inactive family endpoint')
    return branch.endpoint
  }

  private stamp(endpoint: Endpoint, input: CommittedStamp): CommittedStamp {
    const stamp = checked<CommittedStamp>('CommittedStamp', input)
    if (
      !equal(stamp.binding, endpoint.binding) ||
      stamp.sequence <= (endpoint.lastStamp?.sequence ?? 0)
    )
      throw new Error('Committed endpoint identity or order')
    return stamp
  }

  async prepare(): Promise<{ engine_owner_id: string; scene_sha256: string }> {
    this.active()
    if (this.canonical.bridge) throw new Error('Family already prepared')
    return this.perform(async () => {
      this.canonical.bridge = new SensorBridge(async (plan, maximum) => {
        if (maximum !== this.maximum) throw new Error('Prepared native reservation changed')
        const owner = await this.factory(plan, maximum)
        this.canonical.native = owner
        checked('Uuid', owner.ownerId)
        this.nativeIds.add(owner.ownerId)
        return owner
      })
      const result = object(await this.canonical.bridge.command(this.preparation))
      return {
        engine_owner_id: String(result.engine_owner_id),
        scene_sha256: String(result.scene_sha256),
      }
    })
  }

  async advance(
    slot: number,
    input: Command,
    requestDigest: string
  ): Promise<{ kind: 'advanced'; batch: NativeBatch }> {
    this.active()
    const command = checked<Command>('Command', input)
    checked('Digest', requestDigest)
    const selected = this.selected(slot)
    if (
      !this.preparedCommitted ||
      (slot !== 0 && !this.activeBranch?.restoredCommitted) ||
      !selected.bridge ||
      selected.pending ||
      selected.lease ||
      command.tick !== selected.tick + 1 ||
      command.tick > this.plan.body.planned_ticks ||
      command.previous_batch_digest !== selected.sensorBatch
    )
      throw new Error('Family advance order or retained output')
    const action = command.action
    if (command.tick > this.plan.landmark_tick) {
      if (!this.decisionStamp) throw new Error('Forecast decision is not committed')
      const target = slot === 0 ? this.decision?.selected_target : this.activeBranch?.plan.target
      if (command.tick === this.plan.landmark_tick + 1) {
        if (!target || !equal(action, target)) throw new Error('Frozen branch target changed')
      } else if (action.kind !== 'hold')
        throw new Error('Continuation must hold its accepted target')
    }
    const accepted = action.kind === 'set_target' ? requestDigest : selected.acceptedAction
    if (!accepted || (action.kind === 'hold' && action.accepted_action_request_digest !== accepted))
      throw new Error('Held action commitment changed')
    return this.perform(async () => {
      const result = object(
        await selected.bridge!.command({
          kind: 'advance',
          tick: command.tick,
          previous_engine_batch_sha256: selected.nativeBatch,
          action,
          accepted_action_request_digest: accepted,
        })
      )
      const batch = result.batch as NativeBatch
      selected.tick = command.tick
      selected.nativeBatch = batch.engine_batch_sha256
      selected.acceptedAction = accepted
      selected.lease = true
      selected.pending = { batch, requestDigest }
      if (slot !== 0 && command.tick >= this.plan.evaluation.first_tick) {
        const branch = this.activeBranch!
        const pressure = selected.bridge!.copyPayload(this.plan.evaluation.sensor_id)
        if (!branch.window || branch.windowBytes + pressure.length > PRESSURE_WINDOW_BYTES)
          throw new Error('Evaluation pressure reservation exceeded')
        pressure.copy(branch.window, branch.windowBytes)
      }
      return { kind: 'advanced', batch }
    })
  }

  observePrepareCommit(input: CommittedStamp): void {
    this.active()
    if (!this.canonical.native || this.preparedCommitted)
      throw new Error('No new native preparation to commit')
    this.canonical.lastStamp = this.stamp(this.canonical, input)
    this.preparedCommitted = true
  }

  async readChunk(slot: number, sensorId: string, offset: number, count: number): Promise<unknown> {
    this.active()
    const selected = this.selected(slot)
    if (
      !selected.lease ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 32768
    )
      throw new Error('Family chunk admission')
    return this.perform(() =>
      selected.bridge!.command({
        kind: 'read_chunk',
        tick: selected.tick,
        engine_batch_sha256: selected.nativeBatch,
        sensor_id: sensorId,
        offset,
        max_bytes: count,
      })
    )
  }

  async releaseLease(slot: number): Promise<CanonicalFinalState | null> {
    this.active()
    const selected = this.selected(slot)
    if (!selected.lease) throw new Error('No retained family lease')
    return this.perform(async () => {
      await selected.bridge!.command({
        kind: 'release_lease',
        tick: selected.tick,
        engine_batch_sha256: selected.nativeBatch,
      })
      selected.lease = false
      if (slot === 0 && selected.tick === this.plan.body.planned_ticks) {
        const summary = await this.temporarySummary(selected.native!)
        if (summary.acceptedBatch !== selected.nativeBatch)
          throw new Error('Canonical final CPU and accepted observation differ')
        const state: CanonicalFinalState = {
          body_tick: selected.tick,
          native_batch_sha256: selected.nativeBatch!,
          cpu_state_sha256: summary.cpu,
          render_input_sha256: summary.input,
          pixels: summary.pixels,
        }
        this.canonicalFinal = { summary, state }
        return structuredClone(state)
      }
      return null
    })
  }

  /** Called only after SDK Owner.process returns the actual validated COMMITTED result. */
  observeAdvanceCommit(slot: number, input: CommittedStamp, result: FamilyAdvanced): void {
    this.active()
    const selected = this.selected(slot)
    const stamp = this.stamp(selected, input)
    const returned = checked<FamilyAdvanced>('FamilyAdvanced', result)
    const advanced: Advanced = returned.body
    const pending = selected.pending
    if (
      !pending ||
      selected.lease ||
      stamp.request_digest !== pending.requestDigest ||
      advanced.tick !== selected.tick ||
      advanced.accepted_action_request_digest !== selected.acceptedAction ||
      advanced.batch.engine_owner_id !== selected.native?.ownerId ||
      advanced.batch.engine_batch_sha256 !== selected.nativeBatch ||
      advanced.batch.body_tick !== selected.tick ||
      advanced.batch.source_identity !== this.sourceIdentity ||
      advanced.batch.scene_sha256 !== this.sceneSha ||
      advanced.batch.previous_batch_digest !== selected.sensorBatch ||
      !equal(returned.ancestry, slot === 0 ? null : this.activeBranch?.ancestry) ||
      !equal(
        returned.canonical_final_state,
        slot === 0 && selected.tick === this.plan.body.planned_ticks
          ? this.canonicalFinal?.state
          : null
      )
    )
      throw new Error('SDK result differs from the native transition')
    if (slot !== 0 && selected.tick >= this.plan.evaluation.first_tick) {
      const branch = this.activeBranch!
      const target = advanced.batch.slots.filter(
        (row) => row.sensor_id === this.plan.evaluation.sensor_id
      )
      const source = pending.batch.payloads.find(
        (row) => row.sensor_id === this.plan.evaluation.sensor_id
      )
      if (target.length !== 1 || target[0].kind !== 'due' || !source)
        throw new Error('Evaluation source manifest absent')
      const { typed_manifest: typed, byte_manifest: bytes } = target[0]
      const sampleStart = Math.floor(((selected.tick - 1) * 16000) / 120)
      const sampleEnd = Math.floor((selected.tick * 16000) / 120)
      if (
        !equal(bytes.binding, selected.binding) ||
        bytes.creating_request_digest !== stamp.request_digest ||
        bytes.payload_sha256 !== source.payload_sha256 ||
        bytes.byte_length !== source.byte_length ||
        bytes.byte_length !== (sampleEnd - sampleStart) * 8 ||
        typed.sensor_id !== target[0].sensor_id ||
        typed.byte_manifest_digest !== bytes.manifest_digest ||
        typed.engine_batch_sha256 !== selected.nativeBatch ||
        typed.source_body_tick !== selected.tick ||
        typed.available_after_body_tick !== selected.tick ||
        typed.tensor.kind !== 'pressure' ||
        typed.tensor.sample_start !== sampleStart ||
        typed.tensor.sample_end !== sampleEnd ||
        typed.tensor.shape[0] !== sampleEnd - sampleStart ||
        !branch.window ||
        sha256(
          branch.window.subarray(branch.windowBytes, branch.windowBytes + bytes.byte_length)
        ) !== bytes.payload_sha256 ||
        branch.segments.length !== selected.tick - this.plan.evaluation.first_tick
      )
        throw new Error('Evaluation manifest and original pressure bytes differ')
      branch.segments.push({
        source_body_tick: selected.tick,
        available_after_body_tick: selected.tick,
        sample_start: sampleStart,
        sample_end: sampleEnd,
        typed_manifest_digest: typed.manifest_digest,
        byte_manifest_digest: bytes.manifest_digest,
        payload_sha256: bytes.payload_sha256,
        byte_length: bytes.byte_length,
      })
      branch.windowBytes += bytes.byte_length
    }
    selected.sensorBatch = advanced.batch.batch_digest
    selected.pending = null
    selected.lastStamp = stamp
    if (slot === 0 && selected.tick === this.plan.body.planned_ticks) this.selectedExecution = stamp
  }

  private audit(owner: CheckpointOwner, handle: StaticRenderCheckpoint): AuditSummary {
    const audit = owner.checkpointAudit(handle)
    if (
      Buffer.byteLength(audit.metadataJson) > 1024 * 1024 ||
      Buffer.byteLength(audit.cpuCheckpointJson) > 64 * 1024 * 1024 ||
      sha256(audit.metadataJson) !== handle.sha256
    )
      throw new Error('Native checkpoint audit extent or identity')
    const metadata = keys(JSON.parse(audit.metadataJson), [
      'profile',
      'ownerId',
      'sourceIdentity',
      'sceneSha256',
      'graphicsPlanSha256',
      'graphicsGeneration',
      'tick',
      'acceptedBatchSha256',
      'actionPosition',
      'cpuSha256',
      'render',
      'scope',
    ])
    const render = keys(metadata.render, ['inputJson', 'inputSha256', 'pixelsJson'])
    if (
      metadata.profile !== 'crebain.static-render-checkpoint.v1' ||
      metadata.ownerId !== owner.ownerId ||
      handle.ownerId !== owner.ownerId ||
      metadata.tick !== handle.tick ||
      metadata.sourceIdentity !== this.sourceIdentity ||
      metadata.sceneSha256 !== this.sceneSha ||
      metadata.cpuSha256 !== sha256(audit.cpuCheckpointJson) ||
      typeof render.inputJson !== 'string' ||
      sha256(render.inputJson) !== render.inputSha256 ||
      typeof render.pixelsJson !== 'string'
    )
      throw new Error('Native checkpoint audit join')
    const pixels = keys(JSON.parse(render.pixelsJson), ['rowOrigin', 'rgb', 'thermal'])
    if (pixels.rowOrigin !== 'bottom-left') throw new Error('Checkpoint pixel axes')
    const identities: PixelIdentity[] = []
    for (const [modality, cameras] of [
      ['rgb', this.plan.body.specification.scene.rgbCameras],
      ['thermal', this.plan.body.specification.scene.thermalCameras],
    ] as const) {
      const actual = rows(pixels[modality])
      if (actual.length !== cameras.length) throw new Error('Checkpoint camera roster')
      for (let index = 0; index < cameras.length; index++) {
        const row = keys(
          actual[index],
          modality === 'rgb'
            ? ['cameraId', 'width', 'height', 'encoding', 'sha256']
            : ['cameraId', 'width', 'height', 'encoding', 'unit', 'sha256']
        )
        const camera = cameras[index]
        if (
          row.cameraId !== camera.id ||
          row.width !== camera.width ||
          row.height !== camera.height ||
          row.encoding !== (modality === 'rgb' ? 'rgba8-srgb' : 'float32-le') ||
          (modality === 'thermal' && row.unit !== 'W/(m2 sr)')
        )
          throw new Error('Checkpoint pixel tensor')
        identities.push(
          checked('PixelIdentity', {
            sensor_id: `${modality}:${camera.id}`,
            payload_sha256: row.sha256,
          })
        )
      }
    }
    checked('Digest', metadata.cpuSha256)
    checked('Digest', metadata.graphicsPlanSha256)
    checked('Digest', render.inputSha256)
    checked('Digest', metadata.acceptedBatchSha256)
    checked('Uuid', metadata.graphicsGeneration)
    if (
      !Number.isSafeInteger(metadata.actionPosition) ||
      Number(metadata.actionPosition) < 1 ||
      Number(metadata.actionPosition) > 7200
    )
      throw new Error('Checkpoint action history position')
    return {
      cpu: String(metadata.cpuSha256),
      graphicsPlan: String(metadata.graphicsPlanSha256),
      generation: String(metadata.graphicsGeneration),
      input: String(render.inputSha256),
      pixels: identities,
      acceptedBatch: String(metadata.acceptedBatchSha256),
      actionPosition: Number(metadata.actionPosition),
    }
  }

  private async temporarySummary(owner: CheckpointOwner): Promise<AuditSummary> {
    const handle = await owner.checkpoint()
    let primary: unknown
    let failed = false
    let summary: AuditSummary | undefined
    try {
      summary = this.audit(owner, handle)
    } catch (error) {
      failed = true
      primary = error
    }
    try {
      owner.releaseCheckpoint(handle)
    } catch (cleanup) {
      if (failed)
        throw new AggregateError(
          [primary, cleanup],
          'Checkpoint audit and temporary release failed',
          { cause: cleanup }
        )
      throw cleanup
    }
    if (failed) throw primary
    return summary!
  }

  async createCheckpoint(expectedSensorBatch: string): Promise<Checkpointed> {
    this.active()
    const parent = this.canonical
    if (
      !parent.native ||
      parent.pending ||
      parent.lease ||
      parent.tick !== this.plan.landmark_tick ||
      parent.sensorBatch !== expectedSensorBatch ||
      this.checkpoint ||
      this.checkpointReleased
    )
      throw new Error('Canonical checkpoint boundary')
    return this.perform(async () => {
      const handle = await parent.native!.checkpoint()
      // The native owner's own registry retains this object through audit failure and cleanup.
      const summary = this.audit(parent.native!, handle)
      if (summary.acceptedBatch !== parent.nativeBatch || handle.tick !== parent.tick)
        throw new Error('Checkpoint accepted batch')
      const result: Checkpointed = {
        kind: 'checkpointed',
        reference: {
          family_id: this.plan.family_id,
          checkpoint_token: randomUUID(),
          parent_binding: parent.binding,
          parent_native_owner_id: parent.native!.ownerId,
          tick: handle.tick,
          checkpoint_sha256: handle.sha256,
        },
        cpu_state_sha256: summary.cpu,
        graphics_plan_sha256: summary.graphicsPlan,
        render_input_sha256: summary.input,
        pixels: summary.pixels,
        accepted_native_batch_sha256: summary.acceptedBatch,
        accepted_sensor_batch_digest: parent.sensorBatch!,
        accepted_action_position: summary.actionPosition,
      }
      this.checkpoint = { handle, summary, result, committed: false }
      this.graphicsGenerations.add(summary.generation)
      return structuredClone(result)
    })
  }

  observeCheckpointCommit(input: CommittedStamp): void {
    this.active()
    if (!this.checkpoint || this.checkpoint.committed)
      throw new Error('No new checkpoint to commit')
    this.canonical.lastStamp = this.stamp(this.canonical, input)
    this.checkpoint.committed = true
  }

  private retained(input: CheckpointReference): NonNullable<NativeCheckpointFamily['checkpoint']> {
    checked('CheckpointReference', input)
    if (!this.checkpoint?.committed || !equal(input, this.checkpoint.result.reference))
      throw new Error('Unknown, foreign, or released live checkpoint selector')
    return this.checkpoint
  }

  select(
    input: CheckpointReference,
    selectedCase: string,
    forecastDigest: string
  ): DecisionCommitted {
    this.active()
    this.retained(input)
    checked('Digest', forecastDigest)
    const selected = this.branches.find(
      (branch) => branch.plan.case_id === selectedCase && branch.plan.purpose === 'label'
    )
    if (
      !selected ||
      this.decision ||
      this.canonical.tick !== this.plan.landmark_tick ||
      this.canonical.pending
    )
      throw new Error('Forecast selection boundary')
    this.decision = {
      kind: 'decision_committed',
      checkpoint: structuredClone(input),
      forecast_commitment_digest: forecastDigest,
      selected_case_id: selectedCase,
      selected_target: selected.plan.target,
    }
    return structuredClone(this.decision)
  }

  observeDecisionCommit(input: CommittedStamp): void {
    this.active()
    if (!this.decision || this.decisionStamp) throw new Error('No new decision to commit')
    this.decisionStamp = this.stamp(this.canonical, input)
    this.canonical.lastStamp = this.decisionStamp
  }

  reserve(
    input: CheckpointReference,
    caseId: string,
    executionDigest: string,
    requestDigest: string
  ): ReservationReference {
    this.active()
    this.retained(input)
    checked('Digest', requestDigest)
    const branch = this.branches[this.nextBranch]
    if (
      !branch ||
      branch.plan.case_id !== caseId ||
      this.activeBranch ||
      !this.decisionStamp ||
      !this.selectedExecution ||
      this.selectedExecution.result_digest !== executionDigest ||
      this.canonical.tick !== this.plan.body.planned_ticks ||
      this.canonical.pending ||
      this.canonical.lease
    )
      throw new Error('Evaluation reservation boundary')
    branch.reservation = {
      family_id: this.plan.family_id,
      reservation_token: randomUUID(),
      case_id: caseId,
      branch_binding: branch.plan.binding,
      checkpoint: structuredClone(input),
      reserving_request_digest: requestDigest,
    }
    this.activeBranch = branch
    return structuredClone(branch.reservation)
  }

  observeReservationCommit(input: CommittedStamp): void {
    this.active()
    const branch = this.activeBranch
    const stamp = this.stamp(this.canonical, input)
    if (
      !branch?.reservation ||
      branch.reservationCommitted ||
      stamp.request_digest !== branch.reservation.reserving_request_digest
    )
      throw new Error('No matching reservation to commit')
    branch.reservationCommitted = true
    this.canonical.lastStamp = stamp
  }

  async restore(
    input: ReservationReference,
    familyPlanDigest: string
  ): Promise<{
    ancestry: BranchAncestry
    cpu_state_sha256: string
    render_input_sha256: string
    pixels: readonly PixelIdentity[]
  }> {
    this.active()
    checked('ReservationReference', input)
    const branch = this.activeBranch
    if (
      !branch?.reservationCommitted ||
      !equal(input, branch.reservation) ||
      branch.endpoint.native ||
      familyPlanDigest !== this.familyPlanDigest ||
      !this.checkpoint ||
      !this.canonical.native
    )
      throw new Error('Unknown, consumed, or foreign branch reservation')
    const retained = this.retained(input.checkpoint)
    return this.perform(async () => {
      branch.window = Buffer.alloc(PRESSURE_WINDOW_BYTES)
      let child: CheckpointOwner
      try {
        child = await this.canonical.native!.fork(retained.handle)
      } catch (error) {
        // No child capability returned. Only the native owner's typed cleanup fact
        // can release the reservation; successful parent retirement cannot do so.
        this.forkCleanupUnresolved = !(
          error instanceof EnvironmentForkError && error.familySlotReleased
        )
        throw error
      }
      branch.endpoint.native = child
      const summary = await this.temporarySummary(child)
      checked('Uuid', child.ownerId)
      if (
        this.nativeIds.has(child.ownerId) ||
        this.graphicsGenerations.has(summary.generation) ||
        summary.cpu !== retained.summary.cpu ||
        summary.graphicsPlan !== retained.summary.graphicsPlan ||
        summary.input !== retained.summary.input ||
        !equal(summary.pixels, retained.summary.pixels) ||
        summary.acceptedBatch !== retained.summary.acceptedBatch ||
        summary.actionPosition !== retained.summary.actionPosition
      )
        throw new Error('Native restored state or current pixels differ')
      this.nativeIds.add(child.ownerId)
      this.graphicsGenerations.add(summary.generation)
      const ancestry: EnvironmentAncestry = {
        parentOwnerId: this.canonical.native!.ownerId,
        checkpointSha256: retained.handle.sha256,
        checkpointTick: retained.handle.tick,
        parentAcceptedBatchSha256: retained.summary.acceptedBatch,
        acceptedActionPosition: retained.summary.actionPosition,
        graphicsGeneration: summary.generation,
        reconstruction: 'exact-cpu-and-current-static-pixels',
      }
      branch.endpoint.bridge = await SensorBridge.restored(child, this.preparation, ancestry)
      branch.endpoint.tick = retained.handle.tick
      branch.endpoint.nativeBatch = retained.summary.acceptedBatch
      branch.ancestry = {
        family_id: this.plan.family_id,
        case_id: branch.plan.case_id,
        origin: retained.result.reference,
        origin_plan_digest: this.nativePlanSha,
        origin_engine_run_id: `ncp-${this.plan.canonical_binding.run_id}`,
        origin_native_batch_sha256: retained.summary.acceptedBatch,
        origin_sensor_batch_digest: retained.result.accepted_sensor_batch_digest,
        action_history_position: retained.summary.actionPosition,
        selection: this.decisionStamp!,
        selected_execution: this.selectedExecution!,
        execution_binding: branch.plan.binding,
        native_owner_id: child.ownerId,
        graphics_generation: summary.generation,
        reconstruction: 'exact-cpu-and-current-static-pixels',
      }
      return {
        ancestry: structuredClone(branch.ancestry),
        cpu_state_sha256: summary.cpu,
        render_input_sha256: summary.input,
        pixels: structuredClone(summary.pixels),
      }
    })
  }

  async evaluate(
    slot: number,
    expectedBatch: string,
    targetDigest: string
  ): Promise<EvaluationResult> {
    this.active()
    const branch = this.activeBranch
    const selected = this.selected(slot)
    if (
      slot === 0 ||
      !branch?.ancestry ||
      !branch.window ||
      selected.tick !== this.plan.body.planned_ticks ||
      selected.sensorBatch !== expectedBatch ||
      targetDigest !== PRESSURE_TARGET_DIGEST ||
      selected.pending ||
      selected.lease ||
      branch.evaluated ||
      branch.windowBytes !== PRESSURE_WINDOW_BYTES ||
      branch.segments.length !== 3
    )
      throw new Error('Restricted evaluation boundary')
    return this.perform(async () => {
      const final = await this.temporarySummary(selected.native!)
      if (final.acceptedBatch !== selected.nativeBatch)
        throw new Error('Final CPU and accepted observation differ')
      if (
        equal(branch.plan.target, this.decision!.selected_target) &&
        final.cpu !== this.canonicalFinal?.summary.cpu
      )
        throw new Error('Matched selected action changed the complete final CPU state')
      const result: EvaluationResult = {
        kind: 'pressure_window_evaluated',
        ancestry: branch.ancestry!,
        target: this.plan.evaluation,
        segments: branch.segments,
        window_payload_sha256: sha256(branch.window!),
        value_pa: pressureWindowRms(branch.window!),
        final_cpu_state_sha256: final.cpu,
        final_native_batch_sha256: selected.nativeBatch!,
        final_sensor_batch_digest: selected.sensorBatch!,
        accepted_action_request_digest: selected.acceptedAction!,
        scientific_validation: false,
      }
      const evaluated = checked<EvaluationResult>('EvaluationResult', result)
      branch.evaluated = evaluated
      return structuredClone(evaluated)
    })
  }

  observeRestoreCommit(slot: number, input: CommittedStamp): void {
    this.active()
    const selected = this.selected(slot)
    const branch = this.activeBranch
    if (slot === 0 || !branch?.ancestry || branch.restoredCommitted)
      throw new Error('No new restored preparation to commit')
    selected.lastStamp = this.stamp(selected, input)
    branch.restoredCommitted = true
  }

  observeEvaluationCommit(slot: number, input: CommittedStamp): void {
    this.active()
    const selected = this.selected(slot)
    const branch = this.activeBranch
    if (slot === 0 || !branch?.evaluated || branch.evaluationCommit)
      throw new Error('No new evaluation to commit')
    branch.evaluationCommit = this.stamp(selected, input)
    selected.lastStamp = branch.evaluationCommit
  }

  async finishBranch(slot: number, evaluationDigest: string): Promise<void> {
    this.active()
    const selected = this.selected(slot)
    const branch = this.activeBranch
    if (
      slot === 0 ||
      !branch?.evaluationCommit ||
      branch.evaluationCommit.result_digest !== evaluationDigest ||
      selected.lease ||
      selected.pending ||
      branch.nativeRetired
    )
      throw new Error('Branch finish boundary')
    await this.perform(async () => {
      if (!(await selected.bridge!.retire())) throw new Error('Unresolved native branch retirement')
      branch.nativeRetired = true
      branch.window = null
    })
  }

  observeBranchTerminal(input: CommittedStamp): void {
    this.active()
    const branch = this.activeBranch
    if (!branch?.nativeRetired || branch.terminal)
      throw new Error('No native-retired terminal to commit')
    branch.terminal = this.stamp(branch.endpoint, input)
    branch.endpoint.lastStamp = branch.terminal
  }

  /** The trusted host calls this after exact ACK response transmission, not merely ACK admission. */
  observeBranchAckSent(input: CommittedStamp): void {
    this.active()
    const branch = this.activeBranch
    if (!branch?.terminal || !equal(branch.terminal, input))
      throw new Error('No matching terminal ACK transmission')
    branch.ackSent = true
  }

  /** The trusted host has observed actual EOF and the SDK has no retained result. */
  observeBranchChannelClosed(input: CommittedStamp): void {
    this.active()
    const branch = this.activeBranch
    if (!branch?.terminal || !branch.ackSent || !equal(branch.terminal, input))
      throw new Error('Branch channel closed before ACK')
    branch.channelClosed = true
    this.activeBranch = null
    this.nextBranch++
  }

  releaseCheckpoint(input: CheckpointReference, lastTerminalDigest: string): void {
    this.active()
    const retained = this.retained(input)
    if (
      this.activeBranch ||
      this.branches.some(
        (branch) => !branch.channelClosed || !branch.nativeRetired || !branch.terminal
      ) ||
      this.branches.at(-1)?.terminal?.result_digest !== lastTerminalDigest
    )
      throw new Error('Checkpoint family closure remains pending')
    try {
      this.canonical.native!.releaseCheckpoint(retained.handle)
    } catch (error) {
      this.failed = true
      throw error
    }
    this.checkpoint = null
    this.checkpointReleased = true
  }

  observeCheckpointReleaseCommit(input: CommittedStamp): void {
    this.active()
    if (!this.checkpointReleased || this.releaseCommitted)
      throw new Error('No checkpoint release to commit')
    this.canonical.lastStamp = this.stamp(this.canonical, input)
    this.releaseCommitted = true
  }

  async finishCanonical(terminals: readonly CommittedStamp[]): Promise<CanonicalFinalState> {
    this.active()
    if (
      !this.releaseCommitted ||
      !equal(
        terminals,
        this.branches.map((branch) => branch.terminal)
      ) ||
      !this.selectedExecution ||
      !this.canonicalFinal ||
      this.canonical.lease ||
      this.canonical.pending
    )
      throw new Error('Canonical finish lacks complete family closure')
    const state = await this.perform(async () => {
      const current = await this.temporarySummary(this.canonical.native!)
      if (!equal(current, this.canonicalFinal!.summary))
        throw new Error('Canonical complete state changed during branch evaluation')
      if (!(await this.canonical.bridge!.retire()))
        throw new Error('Unresolved canonical native retirement')
      return structuredClone(this.canonicalFinal!.state)
    })
    this.closed = true
    return state
  }

  /** Idempotent cleanup retains original failures; it grants no OS process-retirement claim. */
  retire(): Promise<boolean> {
    this.closed = true
    this.cleanup ??= (async () => {
      await this.pendingWork?.catch(() => undefined)
      const branch = this.activeBranch?.endpoint
      for (const selected of [branch, this.canonical]) {
        if (!selected) continue
        try {
          if (selected.bridge) {
            if (!(await selected.bridge.retire()))
              throw new Error('Native bridge cleanup unresolved')
          } else await selected.native?.retire()
        } catch (error) {
          this.cleanupFailures.push(error)
        }
      }
      return this.cleanupFailures.length === 0 && !this.forkCleanupUnresolved
    })()
    return this.cleanup
  }
}
