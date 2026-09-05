import { copyPlainData } from '../lib/copyPlainData'
import { type ScheduledDynamicsAction } from '../physics/DeterministicDroneWorld'
import {
  EnvironmentState,
  CpuReconstructionError,
  type EnvironmentPlan,
  type EnvironmentCheckpoint,
} from './EnvironmentState'
import { ownSceneSpec, closedKeys } from './SceneSpec'
import { ownAcousticConfig, type PressureBlock } from './AcousticObservation'
import { ownThermalConfig } from './ThermalObservation'
import { exactJson } from './ExactJson'
import { graphicsInputDigest, type GraphicsInput, type GraphicsPlan } from './GraphicsContract'

/** The caller installs the project-owned process launcher; this is not arbitrary-code isolation. */
export interface EnvironmentGraphics {
  diagnostics(): { generation: string; planSha256: string }
  captureJson(inputJson: string): Promise<string>
  retire(): Promise<void>
}
export type GraphicsLauncher = (planJson: string) => Promise<EnvironmentGraphics>
export interface ObservationHandle {
  readonly ownerId: string
  readonly tick: number
  readonly sha256: string
}
export interface StaticRenderCheckpoint {
  readonly ownerId: string
  readonly sequence: number
  readonly tick: number
  readonly sha256: string
}
export interface EnvironmentAncestry {
  parentOwnerId: string
  checkpointSha256: string
  checkpointTick: number
  parentAcceptedBatchSha256: string
  acceptedActionPosition: number
  graphicsGeneration: string
  reconstruction: 'exact-cpu-and-current-static-pixels'
}
/** Failed preparation returned no environment authority; cleanup outcomes remain independent. */
export class EnvironmentPreparationError extends Error {
  constructor(
    readonly primaryFailure: string,
    readonly cleanupErrors: string[],
    readonly cpuCleanup: 'confirmed' | 'unresolved',
    readonly graphicsCleanup: 'confirmed' | 'unresolved' | 'not_returned'
  ) {
    super(`Environment preparation rejected: ${primaryFailure}`)
    this.name = 'EnvironmentPreparationError'
  }
}
export class EnvironmentForkError extends Error {
  constructor(
    readonly primaryFailure: string,
    readonly cleanupErrors: string[],
    readonly familySlotReleased: boolean
  ) {
    super(`Static-render fork rejected: ${primaryFailure}`)
    this.name = 'EnvironmentForkError'
  }
}
interface RenderReference {
  inputJson: string
  inputSha256: string
  pixelsJson: string
}
interface RetainedStaticCheckpoint {
  cpu: EnvironmentCheckpoint
  metadataJson: string
  metadataBytes: number
  render: RenderReference
  acceptedBatchSha256: string
  actionPosition: number
}
interface GraphicsFamily {
  owners: number
  checkpoints: number
  metadataBytes: number
  reconstructing: boolean
  stagingRawBytes: number
  generations: Set<string>
  ports: WeakSet<EnvironmentGraphics>
  attempts: number
}
const MAX_CHECKPOINT_METADATA_BYTES = 1024 * 1024
const MAX_FAMILY_METADATA_BYTES = 8 * MAX_CHECKPOINT_METADATA_BYTES
export interface EnvironmentFailure {
  attemptedTick: number
  executedTick: number | null
  acceptedObservationTick: number
  sourceIdentity: string
  sourceSceneSha256: string
  completeSensorObservation: false
  knownCpuState: {
    encoding: 'crebain.cpu-environment-checkpoint.v1'
    sha256: string
    json: string
  } | null
  knownCpuStateStatus: 'captured' | 'unavailable'
  reason: string
  cleanupErrors: string[]
}

interface PixelRow {
  cameraId: string
  width: number
  height: number
  bytesBase64: string
}
interface ProcessFrames {
  generation: string
  planSha256: string
  inputSha256: string
  tick: number
  rowOrigin: 'bottom-left'
  rgb: Array<PixelRow & { encoding: 'rgba8-srgb' }>
  thermal: Array<PixelRow & { encoding: 'float32-le'; unit: 'W/(m2 sr)' }>
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  return btoa(binary)
}
function decodeBytes(text: unknown, count: number): Uint8Array {
  if (typeof text !== 'string' || text.length !== Math.ceil(count / 3) * 4)
    throw new Error('Observation byte extent or base64 encoding changed')
  const binary = atob(text)
  if (binary.length !== count || btoa(binary) !== text)
    throw new Error('Observation base64 is not canonical')
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/** One actual CPU owner, one graphics generation, and one immutable accepted batch lease. */
export class EnvironmentOwner {
  readonly ownerId = crypto.randomUUID()
  readonly #plan: EnvironmentPlan
  readonly #cpu: EnvironmentState
  readonly #graphics: EnvironmentGraphics
  readonly #graphicsPlanSha256: string
  readonly #graphicsGeneration: string
  readonly #sceneSha256: string
  readonly #maxBatchBytes: number
  readonly #launch: GraphicsLauncher
  readonly #graphicsPlanJson: string
  readonly #family: GraphicsFamily
  readonly #ancestry: EnvironmentAncestry | null
  #familySlotHeld = true
  #cpuCleanup: 'not_attempted' | 'confirmed' | 'unresolved' = 'not_attempted'
  #checkpointSequence = 0
  #actionPosition = 0
  #lastRender: RenderReference | null = null
  #checkpoints = new Map<StaticRenderCheckpoint, RetainedStaticCheckpoint>()
  #executedTick = 0
  #currentExecutionKnown = true
  #acceptedTick = 0
  #phase: 'active' | 'busy' | 'retired' = 'active'
  #lastBatchSha256: string | null = null
  #lease: { handle: ObservationHandle; json: string } | null = null
  #failure: EnvironmentFailure | null = null
  #completion: Promise<void> | null = null
  #candidateGraphics: EnvironmentGraphics | null = null

  private constructor(
    plan: EnvironmentPlan,
    cpu: EnvironmentState,
    graphics: EnvironmentGraphics,
    graphicsPlanSha256: string,
    graphicsGeneration: string,
    sceneSha256: string,
    maxBatchBytes: number,
    launch: GraphicsLauncher,
    graphicsPlanJson: string,
    family: GraphicsFamily = {
      owners: 1,
      checkpoints: 0,
      metadataBytes: 0,
      reconstructing: false,
      stagingRawBytes: 0,
      generations: new Set<string>(),
      ports: new WeakSet<EnvironmentGraphics>(),
      attempts: 1,
    },
    ancestry: EnvironmentAncestry | null = null
  ) {
    this.#plan = plan
    this.#cpu = cpu
    this.#graphics = graphics
    this.#graphicsPlanSha256 = graphicsPlanSha256
    this.#graphicsGeneration = graphicsGeneration
    this.#sceneSha256 = sceneSha256
    this.#maxBatchBytes = maxBatchBytes
    this.#launch = launch
    this.#graphicsPlanJson = graphicsPlanJson
    this.#family = family
    this.#ancestry = ancestry
    this.#family.generations.add(graphicsGeneration)
    this.#family.ports.add(graphics)
    Object.freeze(this)
  }

  static async prepare(
    input: EnvironmentPlan,
    launch: GraphicsLauncher,
    maxBatchBytes = 32 * 1024 * 1024
  ): Promise<EnvironmentOwner> {
    const plan = copyPlainData(input)
    ownSceneSpec(plan.scene)
    ownAcousticConfig(plan.acoustic)
    ownThermalConfig(plan.thermal)
    const maximum =
      [...plan.scene.rgbCameras, ...plan.scene.thermalCameras].reduce(
        (sum, camera) => sum + camera.width * camera.height * 4,
        0
      ) +
      plan.scene.microphones.length * 134 * 8
    if (
      !Number.isSafeInteger(maxBatchBytes) ||
      maxBatchBytes < maximum ||
      maxBatchBytes > 32 * 1024 * 1024
    )
      throw new Error(
        'Observation capacity must cover the complete admitted batch before preparation'
      )
    const cpu = await EnvironmentState.prepare(plan)
    let graphics: EnvironmentGraphics | undefined
    try {
      const graphicsPlan: GraphicsPlan = {
        profile: 'crebain.owned-city-graphics.v1',
        sourceIdentity: plan.sourceIdentity,
        scene: plan.scene,
        droneIds: plan.drones.map((drone) => drone.id),
        thermal: plan.thermal,
      }
      const graphicsPlanSha256 = await graphicsInputDigest(graphicsPlan)
      const graphicsPlanJson = exactJson(graphicsPlan)
      graphics = await launch(graphicsPlanJson)
      const identity = copyPlainData(graphics.diagnostics())
      if (
        identity.planSha256 !== graphicsPlanSha256 ||
        typeof identity.generation !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(identity.generation)
      )
        throw new Error('Graphics preparation does not bind the requested plan and generation')
      return new EnvironmentOwner(
        plan,
        cpu,
        graphics,
        graphicsPlanSha256,
        identity.generation,
        await sha256(exactJson(plan.scene)),
        maxBatchBytes,
        launch,
        graphicsPlanJson
      )
    } catch (error) {
      const cleanupErrors: string[] = []
      let cpuCleanup: 'confirmed' | 'unresolved' = 'unresolved'
      let graphicsCleanup: 'confirmed' | 'unresolved' | 'not_returned' = 'not_returned'
      try {
        cpu.retire()
        cpuCleanup = 'confirmed'
      } catch (cleanup) {
        cleanupErrors.push(`CPU: ${String(cleanup).slice(0, 2048)}`)
      }
      if (graphics) {
        graphicsCleanup = 'unresolved'
        try {
          await graphics.retire()
          graphicsCleanup = 'confirmed'
        } catch (cleanup) {
          cleanupErrors.push(`Graphics: ${String(cleanup).slice(0, 2048)}`)
        }
      }
      throw new EnvironmentPreparationError(
        String(error).slice(0, 2048),
        cleanupErrors,
        cpuCleanup,
        graphicsCleanup
      )
    }
  }

  private active(): void {
    if (this.#phase !== 'active') throw new Error(`Environment owner is ${this.#phase}`)
  }

  status(): {
    phase: string
    executedTick: number | null
    lastObservedCompletedCpuTick: number
    acceptedObservationTick: number
    leased: boolean
    initialObservation: 'not_acquired' | 'inherited_checkpoint'
  } {
    return {
      phase: this.#phase,
      executedTick: this.#failure
        ? this.#failure.executedTick
        : this.#currentExecutionKnown
          ? this.#executedTick
          : null,
      lastObservedCompletedCpuTick: this.#executedTick,
      acceptedObservationTick: this.#acceptedTick,
      leased: this.#lease !== null,
      initialObservation: this.#ancestry ? 'inherited_checkpoint' : 'not_acquired',
    }
  }

  schedule(input: ScheduledDynamicsAction): void {
    this.active()
    this.#cpu.schedule(input)
    this.#actionPosition++
  }

  private frames(
    json: string,
    tick: number,
    inputSha256: string,
    generation = this.#graphicsGeneration
  ): ProcessFrames {
    if (typeof json !== 'string' || json.length > Math.ceil((this.#maxBatchBytes * 4) / 3) + 131072)
      throw new Error('Graphics result exceeds the admitted transport extent')
    const frames = JSON.parse(json) as ProcessFrames
    closedKeys(frames, [
      'generation',
      'planSha256',
      'inputSha256',
      'tick',
      'rowOrigin',
      'rgb',
      'thermal',
    ])
    if (
      frames.generation !== generation ||
      frames.planSha256 !== this.#graphicsPlanSha256 ||
      frames.inputSha256 !== inputSha256 ||
      frames.tick !== tick ||
      frames.rowOrigin !== 'bottom-left'
    )
      throw new Error('Graphics result source, scene, generation, or tick join failed')
    for (const modality of ['rgb', 'thermal'] as const) {
      const expected = this.#plan.scene[
        modality === 'rgb' ? 'rgbCameras' : 'thermalCameras'
      ].filter((camera) => tick % camera.periodTicks === 0)
      const rows = frames[modality]
      if (!Array.isArray(rows) || rows.length !== expected.length)
        throw new Error('Required graphics roster changed')
      rows.forEach((row, index) => {
        closedKeys(
          row,
          modality === 'rgb'
            ? ['cameraId', 'width', 'height', 'encoding', 'bytesBase64']
            : ['cameraId', 'width', 'height', 'encoding', 'unit', 'bytesBase64']
        )
        const camera = expected[index]
        if (
          row.cameraId !== camera.id ||
          row.width !== camera.width ||
          row.height !== camera.height ||
          row.encoding !== (modality === 'rgb' ? 'rgba8-srgb' : 'float32-le')
        )
          throw new Error('Graphics camera identity, axes, or dtype changed')
        const bytes = decodeBytes(row.bytesBase64, row.width * row.height * 4)
        if (modality === 'thermal') {
          if (!('unit' in row) || row.unit !== 'W/(m2 sr)')
            throw new Error('Thermal radiance unit changed')
          const view = new DataView(bytes.buffer)
          for (let offset = 0; offset < bytes.length; offset += 4) {
            const value = view.getFloat32(offset, true)
            if (!Number.isFinite(value) || value < 0 || value > 10000)
              throw new Error('Thermal result contains an invalid radiance')
          }
        }
      })
    }
    return frames
  }

  private async pixelIdentity(frames: ProcessFrames): Promise<string> {
    const identity = { rowOrigin: frames.rowOrigin, rgb: [] as unknown[], thermal: [] as unknown[] }
    for (const modality of ['rgb', 'thermal'] as const)
      for (const row of frames[modality]) {
        const { bytesBase64, ...axes } = row
        identity[modality].push({
          ...axes,
          sha256: await sha256(decodeBytes(bytesBase64, row.width * row.height * 4)),
        })
      }
    return JSON.stringify(identity)
  }

  /** The raw-byte reservation and exclusive lease precede the actual physical transition. */
  async advance(): Promise<ObservationHandle> {
    this.active()
    if (this.#lease)
      throw new Error('Release the accepted observation lease before another transition')
    if (this.#executedTick >= 7200) throw new Error('Environment duration budget exhausted')
    const tick = this.#executedTick + 1
    const samples = Math.floor((tick * 16000) / 120) - Math.floor(((tick - 1) * 16000) / 120)
    const reservedBytes =
      [...this.#plan.scene.rgbCameras, ...this.#plan.scene.thermalCameras]
        .filter((camera) => tick % camera.periodTicks === 0)
        .reduce((sum, camera) => sum + camera.width * camera.height * 4, 0) +
      this.#plan.scene.microphones.length * samples * 8
    if (reservedBytes > this.#maxBatchBytes)
      throw new Error('Observation capacity unavailable before execution')
    this.#phase = 'busy'
    let resolveCompletion!: () => void
    this.#completion = new Promise((resolve) => {
      resolveCompletion = resolve
    })
    let observedExecution = false
    this.#currentExecutionKnown = false
    try {
      const pressure = this.#cpu.advance()
      this.#executedTick = tick
      observedExecution = true
      this.#currentExecutionKnown = true
      const reference = this.#cpu.reference()
      const sourceJson = exactJson(reference)
      const request: GraphicsInput = {
        planSha256: this.#graphicsPlanSha256,
        tick,
        drones: reference.dynamics.drones.map((drone, index) => ({
          id: drone.id,
          position: drone.position as [number, number, number],
          orientation: drone.orientation as [number, number, number, number],
          temperatureK: reference.temperaturesK[index],
        })),
      }
      const requestJson = exactJson(request)
      const inputSha256 = await graphicsInputDigest(JSON.parse(requestJson))
      const frames = this.frames(await this.#graphics.captureJson(requestJson), tick, inputSha256)
      const audio = this.pressure(pressure, tick)
      const batch = {
        profile: 'crebain.multimodal-observation.v1',
        ownerId: this.ownerId,
        ancestry: this.#ancestry,
        sourceIdentity: this.#plan.sourceIdentity,
        sceneSha256: this.#sceneSha256,
        tick,
        time: { numerator: tick, denominator: 120, unit: 'second' },
        previousBatchSha256: this.#lastBatchSha256,
        privilegedReference: {
          encoding: 'json-with-signed-zero',
          sha256: await sha256(sourceJson),
          json: sourceJson,
        },
        pressure: audio,
        graphics: frames,
      }
      const json = JSON.stringify(batch)
      if (json.length > Math.ceil((this.#maxBatchBytes * 4) / 3) + 131072)
        throw new Error('Joined observation exceeds the admitted byte envelope')
      const digest = await sha256(json)
      const render: RenderReference = {
        inputJson: requestJson,
        inputSha256,
        pixelsJson: await this.pixelIdentity(frames),
      }
      if (
        new TextEncoder().encode(JSON.stringify(render)).byteLength >
        MAX_CHECKPOINT_METADATA_BYTES / 2
      )
        throw new Error('Static-render reference exceeds its fixed per-owner reservation')
      if (this.#phase !== 'busy')
        throw new Error('Retired environment generation cannot accept an observation')
      const handle = Object.freeze({ ownerId: this.ownerId, tick, sha256: digest })
      this.#lease = { handle, json }
      this.#lastBatchSha256 = digest
      this.#lastRender = render
      this.#acceptedTick = tick
      this.#phase = 'active'
      return handle
    } catch (error) {
      await this.fail(tick, observedExecution, error)
      throw new Error(
        'Environment transition lacks an accepted complete observation; generation retired',
        { cause: error }
      )
    } finally {
      resolveCompletion()
      this.#completion = null
    }
  }

  private pressure(block: PressureBlock, tick: number): unknown {
    if (
      block.sampleStart !== Math.floor(((tick - 1) * 16000) / 120) ||
      block.sampleEnd !== Math.floor((tick * 16000) / 120) ||
      block.channels.length !== this.#plan.scene.microphones.length
    )
      throw new Error('Actual acoustic window or microphone roster changed')
    return {
      sampleStart: block.sampleStart,
      sampleEnd: block.sampleEnd,
      sampleRateHz: 16000,
      unit: 'pascal',
      channels: block.channels.map((values, index) => {
        if (values.length !== block.sampleEnd - block.sampleStart)
          throw new Error('Actual pressure sample extent changed')
        const buffer = new ArrayBuffer(values.length * 8)
        const view = new DataView(buffer)
        values.forEach((value, sample) => {
          if (!Number.isFinite(value))
            throw new Error('Actual pressure contains a non-finite value')
          view.setFloat64(sample * 8, value, true)
        })
        return {
          microphoneId: this.#plan.scene.microphones[index].id,
          encoding: 'float64-le',
          bytesBase64: encodeBytes(new Uint8Array(buffer)),
        }
      }),
    }
  }

  readObservation(handle: ObservationHandle): string {
    this.active()
    if (this.#lease?.handle !== handle)
      throw new Error('Observation lease is foreign, altered, or released')
    return this.#lease.json
  }

  releaseObservation(handle: ObservationHandle): void {
    this.active()
    if (this.#lease?.handle !== handle)
      throw new Error('Observation lease is foreign, altered, or released')
    this.#lease = null
  }

  checkpointEligibility(): {
    eligible: boolean
    reason: string
    barrierPeriodTicks: number | null
  } {
    const cameras = [...this.#plan.scene.rgbCameras, ...this.#plan.scene.thermalCameras]
    if (cameras.length === 0)
      return {
        eligible: false,
        reason: 'Static-render checkpoints require a camera',
        barrierPeriodTicks: null,
      }
    const gcd = (left: number, right: number): number => {
      while (right !== 0) [left, right] = [right, left % right]
      return left
    }
    let period = 1
    for (const camera of cameras) {
      period = (period / gcd(period, camera.periodTicks)) * camera.periodTicks
      if (period > 7200)
        return {
          eligible: false,
          reason: 'No all-camera checkpoint barrier occurs within 7200 ticks',
          barrierPeriodTicks: null,
        }
    }
    const reason =
      this.#phase !== 'active'
        ? `Environment owner is ${this.#phase}`
        : this.#lease
          ? 'Release the observation lease before checkpointing'
          : this.#acceptedTick === 0 || this.#acceptedTick % period !== 0
            ? 'The accepted tick is not an all-camera checkpoint barrier'
            : 'eligible'
    return { eligible: reason === 'eligible', reason, barrierPeriodTicks: period }
  }

  private beginOperation(): () => void {
    this.#phase = 'busy'
    let resolve!: () => void
    this.#completion = new Promise((done) => {
      resolve = done
    })
    return () => {
      if (this.#phase === 'busy') this.#phase = 'active'
      resolve()
      this.#completion = null
    }
  }

  async checkpoint(): Promise<StaticRenderCheckpoint> {
    const eligibility = this.checkpointEligibility()
    if (!eligibility.eligible) throw new Error(eligibility.reason)
    if (this.#family.reconstructing) throw new Error('Environment family reconstruction is busy')
    if (
      this.#family.checkpoints >= 8 ||
      this.#family.metadataBytes + MAX_CHECKPOINT_METADATA_BYTES > MAX_FAMILY_METADATA_BYTES
    )
      throw new Error('Static-render checkpoint metadata budget exhausted')
    const render = this.#lastRender!
    const acceptedBatchSha256 = this.#lastBatchSha256!
    this.#family.reconstructing = true
    this.#family.checkpoints++
    this.#family.metadataBytes += MAX_CHECKPOINT_METADATA_BYTES
    const finish = this.beginOperation()
    let cpu: EnvironmentCheckpoint | undefined
    try {
      cpu = await this.#cpu.checkpoint()
      const metadataJson = JSON.stringify({
        profile: 'crebain.static-render-checkpoint.v1',
        ownerId: this.ownerId,
        sourceIdentity: this.#plan.sourceIdentity,
        sceneSha256: this.#sceneSha256,
        graphicsPlanSha256: this.#graphicsPlanSha256,
        graphicsGeneration: this.#graphicsGeneration,
        tick: this.#acceptedTick,
        acceptedBatchSha256,
        actionPosition: this.#actionPosition,
        cpuSha256: cpu.sha256,
        render,
        scope: 'Exact CPU state and reconstructed current static pixels; no hidden GPU-state clone',
      })
      const metadataBytes = new TextEncoder().encode(metadataJson).byteLength
      if (metadataBytes > MAX_CHECKPOINT_METADATA_BYTES)
        throw new Error('Static-render checkpoint metadata exceeds its reservation')
      const digest = await sha256(metadataJson)
      if (this.#phase !== 'busy') throw new Error('Retired environment cannot publish a checkpoint')
      const handle = Object.freeze({
        ownerId: this.ownerId,
        sequence: ++this.#checkpointSequence,
        tick: this.#acceptedTick,
        sha256: digest,
      })
      this.#checkpoints.set(handle, {
        cpu,
        metadataJson,
        metadataBytes,
        render,
        acceptedBatchSha256,
        actionPosition: this.#actionPosition,
      })
      this.#family.metadataBytes -= MAX_CHECKPOINT_METADATA_BYTES - metadataBytes
      return handle
    } catch (error) {
      if (cpu) this.#cpu.releaseCheckpoint(cpu)
      this.#family.checkpoints--
      this.#family.metadataBytes -= MAX_CHECKPOINT_METADATA_BYTES
      throw error
    } finally {
      this.#family.reconstructing = false
      finish()
    }
  }

  private retained(handle: StaticRenderCheckpoint): RetainedStaticCheckpoint {
    const stored = this.#checkpoints.get(handle)
    if (!stored) throw new Error('Static-render checkpoint is foreign, altered, or released')
    return stored
  }

  /** Serializable audit strings do not carry executable fork authority. */
  checkpointAudit(handle: StaticRenderCheckpoint): {
    metadataJson: string
    cpuCheckpointJson: string
  } {
    this.active()
    const stored = this.retained(handle)
    return {
      metadataJson: stored.metadataJson,
      cpuCheckpointJson: this.#cpu.checkpointState(stored.cpu),
    }
  }

  releaseCheckpoint(handle: StaticRenderCheckpoint): void {
    this.active()
    const stored = this.retained(handle)
    this.#cpu.releaseCheckpoint(stored.cpu)
    this.#checkpoints.delete(handle)
    this.#family.checkpoints--
    this.#family.metadataBytes -= stored.metadataBytes
  }

  async fork(handle: StaticRenderCheckpoint): Promise<EnvironmentOwner> {
    this.active()
    const stored = this.retained(handle)
    if (this.#family.owners >= 4) throw new Error('Graphics owner family budget exhausted')
    if (this.#family.attempts >= 256)
      throw new Error('Graphics generation attempt budget exhausted')
    if (this.#family.reconstructing) throw new Error('Environment family reconstruction is busy')
    // Count constructing and cleanup-unresolved generations. This bounds logical reservations,
    // not transient JSON/base64 allocations, driver memory, or arbitrary in-process code.
    this.#family.owners++
    this.#family.attempts++
    this.#family.reconstructing = true
    this.#family.stagingRawBytes = this.#maxBatchBytes
    const finish = this.beginOperation()
    let cpu: EnvironmentState | undefined
    let graphics: EnvironmentGraphics | undefined
    let launchAttempted = false
    try {
      cpu = await this.#cpu.fork(stored.cpu)
      if (this.#phase !== 'busy') throw new Error('Parent retired during CPU reconstruction')
      launchAttempted = true
      graphics = await this.#launch(this.#graphicsPlanJson)
      if (this.#family.ports.has(graphics)) {
        graphics = undefined
        launchAttempted = false
        throw new Error('A graphics port already owned by this family cannot become a new child')
      }
      this.#candidateGraphics = graphics
      if (this.#phase !== 'busy') throw new Error('Parent retired during graphics reconstruction')
      const identity = copyPlainData(graphics.diagnostics())
      if (
        identity.planSha256 !== this.#graphicsPlanSha256 ||
        typeof identity.generation !== 'string' ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(identity.generation) ||
        this.#family.generations.has(identity.generation)
      )
        throw new Error('Reconstructed graphics lacks a fresh generation and exact plan')
      this.#family.generations.add(identity.generation)
      const frames = this.frames(
        await graphics.captureJson(stored.render.inputJson),
        handle.tick,
        stored.render.inputSha256,
        identity.generation
      )
      if ((await this.pixelIdentity(frames)) !== stored.render.pixelsJson)
        throw new Error('Reconstructed current static pixels changed')
      if (this.#phase !== 'busy')
        throw new Error('Retired parent cannot admit a reconstructed child')
      const ancestry: EnvironmentAncestry = {
        parentOwnerId: this.ownerId,
        checkpointSha256: handle.sha256,
        checkpointTick: handle.tick,
        parentAcceptedBatchSha256: stored.acceptedBatchSha256,
        acceptedActionPosition: stored.actionPosition,
        graphicsGeneration: identity.generation,
        reconstruction: 'exact-cpu-and-current-static-pixels',
      }
      const child = new EnvironmentOwner(
        this.#plan,
        cpu,
        graphics,
        this.#graphicsPlanSha256,
        identity.generation,
        this.#sceneSha256,
        this.#maxBatchBytes,
        this.#launch,
        this.#graphicsPlanJson,
        this.#family,
        ancestry
      )
      child.#executedTick = handle.tick
      child.#acceptedTick = handle.tick
      child.#lastBatchSha256 = stored.acceptedBatchSha256
      child.#actionPosition = stored.actionPosition
      child.#lastRender = stored.render
      return child
    } catch (error) {
      const cleanupErrors: string[] = []
      let released = !launchAttempted
      if (error instanceof CpuReconstructionError && !error.cleanupConfirmed) {
        released = false
        cleanupErrors.push(`CPU reconstruction cleanup unresolved: ${error.cleanupFailure}`)
      }
      if (graphics) {
        try {
          await graphics.retire()
          released = true
        } catch (cleanup) {
          cleanupErrors.push(String(cleanup).slice(0, 2048))
        }
      } else if (launchAttempted)
        cleanupErrors.push(
          'Graphics launch failed without a returned owner; cleanup remains unresolved'
        )
      if (cpu) {
        try {
          cpu.retire()
        } catch (cleanup) {
          cleanupErrors.push(String(cleanup).slice(0, 2048))
          released = false
        }
      }
      if (released) this.#family.owners--
      throw new EnvironmentForkError(String(error).slice(0, 2048), cleanupErrors, released)
    } finally {
      this.#candidateGraphics = null
      this.#family.reconstructing = false
      this.#family.stagingRawBytes = 0
      finish()
    }
  }

  private releaseFamilySlot(): void {
    if (!this.#familySlotHeld) return
    this.#familySlotHeld = false
    this.#family.owners--
  }

  private retireCpu(): void {
    if (this.#cpuCleanup === 'confirmed') return
    if (this.#cpuCleanup === 'unresolved') throw new Error('Prior CPU cleanup remains unresolved')
    try {
      this.#cpu.retire()
      this.#cpuCleanup = 'confirmed'
    } catch (error) {
      this.#cpuCleanup = 'unresolved'
      throw error
    }
  }

  resourceStatus(): {
    reservedOwners: number
    checkpoints: number
    metadataBytes: number
    stagingRawBytes: number
    generationAttempts: number
  } {
    return {
      reservedOwners: this.#family.owners,
      checkpoints: this.#family.checkpoints,
      metadataBytes: this.#family.metadataBytes,
      stagingRawBytes: this.#family.stagingRawBytes,
      generationAttempts: this.#family.attempts,
    }
  }

  private clearRetained(): void {
    for (const stored of this.#checkpoints.values()) {
      this.#family.checkpoints--
      this.#family.metadataBytes -= stored.metadataBytes
    }
    this.#checkpoints.clear()
    this.#lastRender = null
    this.#lease = null
  }

  private async fail(tick: number, observedExecution: boolean, error: unknown): Promise<void> {
    this.#phase = 'retired'
    const failure: EnvironmentFailure = {
      attemptedTick: tick,
      executedTick: observedExecution ? tick : null,
      acceptedObservationTick: this.#acceptedTick,
      sourceIdentity: this.#plan.sourceIdentity,
      sourceSceneSha256: this.#sceneSha256,
      completeSensorObservation: false,
      knownCpuState: null,
      knownCpuStateStatus: 'unavailable',
      reason: String(error).slice(0, 2048),
      cleanupErrors: [],
    }
    try {
      const checkpoint = await this.#cpu.checkpoint()
      failure.knownCpuState = {
        encoding: 'crebain.cpu-environment-checkpoint.v1',
        sha256: checkpoint.sha256,
        json: this.#cpu.checkpointState(checkpoint),
      }
      failure.knownCpuStateStatus = 'captured'
      this.#cpu.releaseCheckpoint(checkpoint)
    } catch {
      /* A missing state capture does not erase observed execution or create a complete sensor result. */
    }
    try {
      this.retireCpu()
    } catch (cleanup) {
      failure.cleanupErrors.push(String(cleanup).slice(0, 2048))
    }
    try {
      await this.#graphics.retire()
      if (failure.cleanupErrors.length === 0) this.releaseFamilySlot()
    } catch (cleanup) {
      failure.cleanupErrors.push(String(cleanup).slice(0, 2048))
    }
    this.clearRetained()
    this.#failure = failure
  }

  failure(): EnvironmentFailure | null {
    return this.#failure ? structuredClone(this.#failure) : null
  }

  async retire(): Promise<void> {
    const completion = this.#completion
    const candidate = this.#candidateGraphics
    this.#phase = 'retired'
    let graphicsRetired = false
    try {
      const cleanup = await Promise.allSettled([
        this.#graphics.retire(),
        ...(candidate ? [candidate.retire()] : []),
      ])
      graphicsRetired = cleanup[0].status === 'fulfilled'
      const errors = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : []
      )
      if (errors.length) throw new AggregateError(errors, 'Environment graphics cleanup failed')
    } finally {
      if (completion) await completion
      this.retireCpu()
      this.clearRetained()
      if (graphicsRetired) this.releaseFamilySlot()
    }
  }
}
