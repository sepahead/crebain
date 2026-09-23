import { copyPlainData } from '../lib/copyPlainData'
import {
  ForceCityWorld,
  type ForceCityBatch,
  type ForceCityTransition,
  type ForceCityBodyState,
} from '../physics/ForceCityWorld'
import { AcousticState, type PressureBlock } from './AcousticObservation'
import { ThermalState } from './ThermalObservation'
import {
  graphicsInputDigest,
  isGraphicsSourceIntegrityError,
  type SourceGraphicsLauncher,
  type SourceGraphicsPort,
  type SourceGraphicsPlan,
  type SourceGraphicsInput,
  type GraphicsSourceReceipt,
} from './GraphicsContract'
import { closedKeys } from './SceneSpec'
import {
  CITY_CHUNK_BYTES,
  CITY_ORIGINAL_BYTES,
  CITY_CONTROL_BYTES,
  CITY_RECEIPT_BYTES,
  CITY_GRAPHICS_INPUT_BYTES,
  cityRequire,
  cityJson,
  citySha256,
  cityValueDigest,
  ownCityEnvironmentPlan,
  cityResourceBounds,
  citySourceMaximumBytes,
  type CityEnvironmentPlan,
  type CitySourceRequest,
  type CityResourceBounds,
} from './CitySourceContract'

interface SourceJoin {
  requestId: string
  sourceId: string
  entityId: string
}
export type CitySourceOutcome = SourceJoin &
  (
    | { status: 'not_due'; nextDueTick: number | null }
    | {
        status: 'produced'
        sourceTick: number
        availableAfterTick: number
        sourceConfigSha256: string
        originalSha256: string
        productionSha256: string
        byteLength: number
        tensor:
          | {
              kind: 'rgba8'
              width: number
              height: number
              rowOrigin: 'bottom-left'
              encoding: 'rgba8-srgb'
            }
          | {
              kind: 'radiance'
              width: number
              height: number
              rowOrigin: 'bottom-left'
              dtype: 'f32le'
              unit: 'W/(m2 sr)'
            }
          | {
              kind: 'pressure'
              sampleStart: number
              sampleEnd: number
              sampleRateHz: 16000
              dtype: 'f64le'
              unit: 'pascal'
            }
      }
    | { status: 'failed'; reason: 'acquisition_failed'; diagnostic: string }
    | { status: 'absent'; reason: 'not_attempted_after_failure'; causalRequestId: string }
  )
export interface CityObservation {
  schema: 'crebain.force-city-source-batch.v1'
  ownerId: string
  planSha256: string
  sceneSha256: string
  tick: number
  previousBatchSha256: string | null
  status: 'complete' | 'source_failed'
  control: {
    beforeStateSha256: string
    afterStateSha256: string
    transitionSha256: string
    transitionByteLength: number
    rows: Array<{
      entityId: string
      actionSha256: string
      selection: 'set' | 'hold'
      armed: boolean
    }>
  }
  slots: CitySourceOutcome[]
  batchSha256: string
}
/** Same-runtime local authority. Copied fields never recreate its native lease. */
export interface CityObservationHandle {
  readonly ownerId: string
  readonly tick: number
  readonly sha256: string
}
export interface CityEnvironmentFailure {
  stage: 'cpu_or_model' | 'source' | 'source_validation' | 'receipt'
  executedTick: number | null
  componentCleanup: 'confirmed' | 'unresolved'
  processRetirement: 'outside_component_scope'
  completeObservation: false
  primaryFailure: string
  secondaryFailures: string[]
  cleanupFailures: string[]
}
export class CityEnvironmentError extends Error {
  constructor(
    readonly outcome: Readonly<CityEnvironmentFailure>,
    readonly handle: CityObservationHandle | null,
    primary: unknown,
    readonly cleanupErrors: readonly unknown[],
    readonly secondaryErrors: readonly unknown[]
  ) {
    super('City environment retired without a complete observation', { cause: primary })
    this.name = 'CityEnvironmentError'
  }
}
export class CityEnvironmentPreparationError extends AggregateError {
  constructor(
    primary: unknown,
    cleanup: unknown[],
    readonly graphicsCleanup: 'not_selected' | 'confirmed' | 'unresolved' | 'not_returned'
  ) {
    super([primary, ...cleanup], 'City preparation failed; no environment authority returned', {
      cause: primary,
    })
    this.name = 'CityEnvironmentPreparationError'
  }
}
interface RetainedBatch {
  handle: CityObservationHandle
  observation: CityObservation
  produced: Map<string, { offset: number; length: number; sha256: string }>
  controlLength: number
}

function diagnostic(error: unknown): string {
  try {
    const message: unknown =
      error && typeof error === 'object' ? (error as { message?: unknown }).message : null
    if (typeof message === 'string') return message.slice(0, 256)
  } catch {
    /* Cleanup and original exception identity do not depend on formatting. */
  }
  return 'Unprintable city environment failure'
}

/** One CPU world, exclusive actual sources, and one bounded original-byte lease. No fork or NCP authority. */
export class ForceCityEnvironment {
  readonly ownerId = crypto.randomUUID()
  readonly #plan: CityEnvironmentPlan
  readonly #bounds: CityResourceBounds
  readonly #planSha256: string
  readonly #sceneSha256: string
  readonly #cpu: ForceCityWorld
  readonly #graphics: SourceGraphicsPort | null
  readonly #acoustic: AcousticState | null
  readonly #thermal: ThermalState | null
  readonly #arena: Uint8Array
  readonly #metadata: Uint8Array
  readonly #controlBytes: Uint8Array
  readonly #offsets: Map<string, number>
  readonly #sourceDigests: Map<string, string>
  #phase: 'active' | 'busy' | 'failed' | 'retired' = 'active'
  #retained: RetainedBatch | null = null
  #lastBatch: string | null = null
  #cleanup: Promise<unknown[]> | null = null
  #failure: Readonly<CityEnvironmentFailure> | null = null

  private constructor(
    plan: CityEnvironmentPlan,
    bounds: CityResourceBounds,
    planSha256: string,
    sceneSha256: string,
    cpu: ForceCityWorld,
    graphics: SourceGraphicsPort | null,
    arena: Uint8Array,
    metadata: Uint8Array,
    controlBytes: Uint8Array,
    sourceDigests: Map<string, string>
  ) {
    this.#plan = plan
    this.#bounds = bounds
    this.#planSha256 = planSha256
    this.#sceneSha256 = sceneSha256
    this.#cpu = cpu
    this.#graphics = graphics
    this.#arena = arena
    this.#metadata = metadata
    this.#controlBytes = controlBytes
    this.#sourceDigests = sourceDigests
    this.#acoustic = plan.acoustic
      ? new AcousticState(plan.acoustic, plan.scene, plan.world.drones.length)
      : null
    this.#thermal = plan.thermal ? new ThermalState(plan.thermal, plan.world.drones.length) : null
    this.#offsets = new Map()
    let offset = 0
    for (const source of plan.requests) {
      this.#offsets.set(source.requestId, offset)
      offset += citySourceMaximumBytes(plan, source)
    }
    Object.freeze(this)
  }

  static async prepare(
    input: CityEnvironmentPlan,
    launch?: SourceGraphicsLauncher,
    limits?: { originalBytes: number; receiptBytes: number; controlBytes: number }
  ): Promise<ForceCityEnvironment> {
    const plan = ownCityEnvironmentPlan(input)
    const bounds = cityResourceBounds(plan)
    const capacity = copyPlainData(
      limits ?? {
        originalBytes: bounds.originalBytes,
        receiptBytes: bounds.receiptBytes,
        controlBytes: bounds.cpuReturnEncodedBytes,
      }
    )
    closedKeys(capacity, ['originalBytes', 'receiptBytes', 'controlBytes'])
    cityRequire(
      Number.isSafeInteger(capacity.originalBytes) &&
        capacity.originalBytes >= bounds.originalBytes &&
        capacity.originalBytes <= CITY_ORIGINAL_BYTES &&
        Number.isSafeInteger(capacity.receiptBytes) &&
        capacity.receiptBytes >= bounds.receiptBytes &&
        capacity.receiptBytes <= CITY_RECEIPT_BYTES &&
        Number.isSafeInteger(capacity.controlBytes) &&
        capacity.controlBytes >= bounds.cpuReturnEncodedBytes &&
        capacity.controlBytes <= CITY_CONTROL_BYTES,
      'City output capacity before construction'
    )
    const selectedGraphics = plan.scene.rgbCameras.length + plan.scene.thermalCameras.length > 0
    cityRequire(
      selectedGraphics === (launch !== undefined),
      'Install a graphics launcher exactly when cameras are requested'
    )
    // These actual backing allocations precede every engine or renderer constructor.
    const arena = new Uint8Array(bounds.originalBytes)
    const metadata = new Uint8Array(bounds.receiptBytes)
    const controlBytes = new Uint8Array(bounds.cpuReturnEncodedBytes)
    const planSha256 = await cityValueDigest(plan)
    const sceneSha256 = await cityValueDigest(plan.scene)
    const sourceDigests = new Map<string, string>()
    for (const source of plan.requests) {
      const instance =
        source.kind === 'rgb'
          ? plan.scene.rgbCameras.find((row) => row.id === source.sceneSourceId)
          : source.kind === 'thermal'
            ? plan.scene.thermalCameras.find((row) => row.id === source.sceneSourceId)
            : plan.scene.microphones.find((row) => row.id === source.sceneSourceId)
      sourceDigests.set(
        source.requestId,
        await cityValueDigest({
          source,
          instance,
          frame: plan.scene.frame,
          model:
            source.kind === 'pressure'
              ? plan.acoustic
              : source.kind === 'thermal'
                ? plan.thermal
                : 'rgba8-srgb',
        })
      )
    }
    let cpu: ForceCityWorld | null = null
    let graphics: SourceGraphicsPort | null = null
    try {
      cpu = await ForceCityWorld.prepare(plan.world)
      if (selectedGraphics) {
        const graphicsPlan: SourceGraphicsPlan = {
          profile: 'crebain.owned-force-city-source-graphics.v1',
          sourceIdentity: plan.world.sourceIdentity,
          scene: plan.scene,
          droneIds: plan.world.drones.map((row) => row.id),
          thermal: plan.thermal ?? null,
        }
        const expected = await graphicsInputDigest(graphicsPlan)
        graphics = await launch!(graphicsPlan)
        cityRequire(graphics.planSha256 === expected, 'Graphics construction plan identity changed')
      }
      const owner = new ForceCityEnvironment(
        plan,
        bounds,
        planSha256,
        sceneSha256,
        cpu,
        graphics,
        arena,
        metadata,
        controlBytes,
        sourceDigests
      )
      if (graphics) {
        const initial = owner.graphicsInput(
          0,
          cpu.observeBodies().map((row) => row.body)
        )
        const expectedInput = await graphicsInputDigest(initial)
        // Tick-zero readbacks allocate fixed driver/view resources before any motor effect.
        // No observation handle or original production identity is issued for readiness pixels.
        for (const source of plan.requests) {
          if (source.kind === 'pressure') continue
          const offset = owner.#offsets.get(source.requestId)
          cityRequire(offset !== undefined, 'Missing reserved source offset')
          const target = arena.subarray(offset, offset + citySourceMaximumBytes(plan, source))
          const receipt = await graphics.captureSourceInto(
            initial,
            { kind: source.kind, cameraId: source.sceneSourceId },
            target
          )
          owner.checkGraphics(receipt, source, 0, expectedInput)
          if (source.kind === 'thermal') owner.checkThermal(target)
        }
        arena.fill(0)
      }
      return owner
    } catch (primary) {
      const errors: unknown[] = []
      let graphicsCleanup: CityEnvironmentPreparationError['graphicsCleanup'] = selectedGraphics
        ? 'not_returned'
        : 'not_selected'
      if (cpu)
        try {
          cpu.retire()
        } catch (error) {
          errors.push(error)
        }
      if (graphics) {
        try {
          await graphics.retire()
          graphicsCleanup = 'confirmed'
        } catch (error) {
          graphicsCleanup = 'unresolved'
          errors.push(error)
        }
      }
      throw new CityEnvironmentPreparationError(primary, errors, graphicsCleanup)
    }
  }

  private graphicsInput(tick: number, bodies: ForceCityBodyState[]): SourceGraphicsInput {
    cityRequire(this.#graphics, 'Graphics is not selected')
    const temperatures = this.#thermal?.temperatures()
    const input: SourceGraphicsInput = {
      planSha256: this.#graphics.planSha256,
      tick,
      drones: bodies.map((body, index) => ({
        id: this.#plan.world.drones[index].id,
        position: body.state.position as [number, number, number],
        orientation: body.state.orientation as [number, number, number, number],
        temperatureK: temperatures?.[index] ?? null,
      })),
    }
    const owned = copyPlainData(input)
    cityRequire(
      new TextEncoder().encode(cityJson(owned)).byteLength <= CITY_GRAPHICS_INPUT_BYTES,
      'City graphics input extent'
    )
    return owned
  }

  private checkGraphics(
    input: GraphicsSourceReceipt,
    source: CitySourceRequest,
    tick: number,
    inputDigest: string
  ): GraphicsSourceReceipt {
    const value = copyPlainData(input)
    closedKeys(value, [
      'planSha256',
      'inputSha256',
      'tick',
      'kind',
      'cameraId',
      'width',
      'height',
      'rowOrigin',
      'encoding',
      'byteLength',
    ])
    const cameras =
      source.kind === 'rgb' ? this.#plan.scene.rgbCameras : this.#plan.scene.thermalCameras
    const camera = cameras.find((row) => row.id === source.sceneSourceId)!
    cityRequire(
      value.planSha256 === this.#graphics!.planSha256 &&
        value.inputSha256 === inputDigest &&
        value.tick === tick &&
        value.kind === source.kind &&
        value.cameraId === source.sceneSourceId &&
        value.width === camera.width &&
        value.height === camera.height &&
        value.rowOrigin === 'bottom-left' &&
        value.encoding === (source.kind === 'rgb' ? 'rgba8-srgb' : 'float32-le') &&
        value.byteLength === camera.width * camera.height * 4,
      'Original graphics source receipt mismatch'
    )
    return value
  }

  private async stopComponents(): Promise<unknown[]> {
    this.#cleanup ??= (async () => {
      const failures: unknown[] = []
      try {
        this.#cpu.retire()
      } catch (error) {
        failures.push(error)
      }
      if (this.#graphics)
        try {
          await this.#graphics.retire()
        } catch (error) {
          failures.push(error)
        }
      return failures
    })()
    return this.#cleanup
  }

  private async retain(
    observation: Omit<CityObservation, 'batchSha256'>,
    produced: RetainedBatch['produced']
  ): Promise<CityObservationHandle> {
    const json = cityJson(observation)
    const encoded = new TextEncoder().encodeInto(json, this.#metadata)
    cityRequire(
      encoded.read === json.length,
      'City receipt exceeded its preallocated extent after execution'
    )
    const sha256 = await citySha256(this.#metadata.subarray(0, encoded.written))
    const handle = Object.freeze({ ownerId: this.ownerId, tick: observation.tick, sha256 })
    const batch = copyPlainData({ ...observation, batchSha256: sha256 })
    this.#retained = {
      handle,
      observation: batch,
      produced,
      controlLength: observation.control.transitionByteLength,
    }
    return handle
  }

  async advance(input: ForceCityBatch): Promise<CityObservationHandle> {
    cityRequire(
      this.#phase === 'active' && this.#retained === null,
      'City owner is unavailable or its previous batch remains retained'
    )
    const before = this.#cpu.status()
    this.#phase = 'busy'
    let transition: ForceCityTransition | null = null
    let stage: CityEnvironmentFailure['stage'] = 'cpu_or_model'
    const produced = new Map<string, { offset: number; length: number; sha256: string }>()
    let failedSource: { requestId: string; error: unknown } | null = null
    let handle: CityObservationHandle | null = null
    let stopped: unknown[] | null = null
    try {
      transition = await this.#cpu.advanceControlled(input, this.#bounds.cpuReturnEncodedBytes)
      const tick = transition.tick
      const bodies = transition.entities.map((row) => row.after)
      this.#thermal?.advance(
        bodies.map((body) =>
          body.rotors.reduce(
            (sum, rotor) => sum + Math.abs((rotor.torque * rotor.rpm * 2 * Math.PI) / 60),
            0
          )
        )
      )
      const pressure =
        this.#acoustic?.advance(
          bodies.map((body) => ({
            position: body.state.position as [number, number, number],
            rpm: body.rotors.map((rotor) => rotor.rpm) as [number, number, number, number],
          }))
        ) ?? null
      if (pressure) this.checkPressure(pressure, tick)
      const graphicsInput = this.#graphics ? this.graphicsInput(tick, bodies) : null
      const inputDigest = graphicsInput ? await graphicsInputDigest(graphicsInput) : null
      const controlJson = cityJson(transition)
      const encodedControl = new TextEncoder().encodeInto(controlJson, this.#controlBytes)
      cityRequire(
        encodedControl.read === controlJson.length,
        'City control exceeded its preallocated extent'
      )
      const transitionByteLength = encodedControl.written
      const transitionSha256 = await citySha256(
        this.#controlBytes.subarray(0, transitionByteLength)
      )
      const slots = new Map<string, CitySourceOutcome>()
      const join = (row: CitySourceRequest): SourceJoin => ({
        requestId: row.requestId,
        sourceId: row.sourceId,
        entityId: row.entityId,
      })
      for (const source of this.#plan.requests)
        if (tick % source.periodTicks !== 0) {
          const next = tick + source.periodTicks - (tick % source.periodTicks)
          slots.set(source.requestId, {
            ...join(source),
            status: 'not_due',
            nextDueTick: next <= this.#plan.world.horizonTicks ? next : null,
          })
        }
      // The model advances once. Pressure originals precede graphics acquisition; catalog order stays fixed.
      const order = ['pressure', 'rgb', 'thermal'].flatMap((kind) =>
        this.#plan.requests.filter((row) => row.kind === kind)
      )
      stage = 'source'
      for (const source of order) {
        if (tick % source.periodTicks !== 0) continue
        if (failedSource) {
          slots.set(source.requestId, {
            ...join(source),
            status: 'absent',
            reason: 'not_attempted_after_failure',
            causalRequestId: failedSource.requestId,
          })
          continue
        }
        {
          const offset = this.#offsets.get(source.requestId)!
          const length =
            source.kind === 'pressure'
              ? (pressure!.sampleEnd - pressure!.sampleStart) * 8
              : citySourceMaximumBytes(this.#plan, source)
          const bytes = this.#arena.subarray(offset, offset + length)
          let tensor: Extract<CitySourceOutcome, { status: 'produced' }>['tensor']
          if (source.kind === 'pressure') {
            const microphone = this.#plan.scene.microphones.findIndex(
              (row) => row.id === source.sceneSourceId
            )
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            pressure!.channels[microphone].forEach((value, index) =>
              view.setFloat64(index * 8, value, true)
            )
            tensor = {
              kind: 'pressure',
              sampleStart: pressure!.sampleStart,
              sampleEnd: pressure!.sampleEnd,
              sampleRateHz: 16000,
              dtype: 'f64le',
              unit: 'pascal',
            }
          } else {
            let result: GraphicsSourceReceipt
            try {
              result = await this.#graphics!.captureSourceInto(
                graphicsInput!,
                { kind: source.kind, cameraId: source.sceneSourceId },
                bytes
              )
            } catch (error) {
              if (isGraphicsSourceIntegrityError(error)) {
                stage = 'source_validation'
                throw error
              }
              failedSource = { requestId: source.requestId, error }
              slots.set(source.requestId, {
                ...join(source),
                status: 'failed',
                reason: 'acquisition_failed',
                diagnostic: '',
              })
              continue
            }
            // A malformed receipt is an integrity failure, not a typed source acquisition failure.
            stage = 'source_validation'
            const receipt = this.checkGraphics(result, source, tick, inputDigest!)
            if (source.kind === 'thermal') this.checkThermal(bytes)
            tensor =
              source.kind === 'rgb'
                ? {
                    kind: 'rgba8',
                    width: receipt.width,
                    height: receipt.height,
                    rowOrigin: 'bottom-left',
                    encoding: 'rgba8-srgb',
                  }
                : {
                    kind: 'radiance',
                    width: receipt.width,
                    height: receipt.height,
                    rowOrigin: 'bottom-left',
                    dtype: 'f32le',
                    unit: 'W/(m2 sr)',
                  }
          }
          const originalSha256 = await citySha256(bytes)
          const sourceConfigSha256 = this.#sourceDigests.get(source.requestId)!
          const productionSha256 = await cityValueDigest({
            ownerId: this.ownerId,
            planSha256: this.#planSha256,
            sceneSha256: this.#sceneSha256,
            tick,
            source,
            sourceConfigSha256,
            originalSha256,
          })
          produced.set(source.requestId, { offset, length, sha256: originalSha256 })
          slots.set(source.requestId, {
            ...join(source),
            status: 'produced',
            sourceTick: tick,
            availableAfterTick: tick,
            sourceConfigSha256,
            originalSha256,
            productionSha256,
            byteLength: length,
            tensor,
          })
          stage = 'source'
        }
      }
      if (failedSource) {
        stopped = await this.stopComponents()
        const slot = slots.get(failedSource.requestId)!
        if (slot.status === 'failed') slot.diagnostic = diagnostic(failedSource.error)
      }
      stage = 'receipt'
      handle = await this.retain(
        {
          schema: 'crebain.force-city-source-batch.v1',
          ownerId: this.ownerId,
          planSha256: this.#planSha256,
          sceneSha256: this.#sceneSha256,
          tick,
          previousBatchSha256: this.#lastBatch,
          status: failedSource ? 'source_failed' : 'complete',
          control: {
            beforeStateSha256: transition.beforeStateSha256,
            afterStateSha256: transition.afterStateSha256,
            transitionSha256,
            transitionByteLength,
            rows: transition.entities.map((row) => ({
              entityId: row.droneId,
              actionSha256: row.action.sha256,
              selection: row.selection,
              armed: row.action.armed,
            })),
          },
          slots: this.#plan.requests.map((row) => slots.get(row.requestId)!),
        },
        produced
      )
      if (failedSource) {
        stage = 'source'
        throw failedSource.error
      }
      this.#phase = 'active'
      return handle
    } catch (caught) {
      const status = this.#cpu.status()
      if (
        !transition &&
        status.phase === 'active' &&
        status.lastCompletedTick === before.lastCompletedTick
      ) {
        this.#phase = 'active'
        throw caught
      }
      const cleanup = stopped ?? (await this.stopComponents())
      const primary = failedSource ? failedSource.error : caught
      const secondary = failedSource && failedSource.error !== caught ? [caught] : []
      this.#phase = 'failed'
      this.#failure = copyPlainData({
        stage,
        executedTick: transition?.tick ?? status.executedTick,
        componentCleanup: cleanup.length ? 'unresolved' : 'confirmed',
        processRetirement: 'outside_component_scope',
        completeObservation: false,
        primaryFailure: diagnostic(primary),
        secondaryFailures: secondary.map(diagnostic),
        cleanupFailures: cleanup.map(diagnostic),
      })
      throw new CityEnvironmentError(
        this.#failure,
        handle,
        primary,
        Object.freeze([...cleanup]),
        Object.freeze(secondary)
      )
    }
  }

  private checkThermal(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let at = 0; at < bytes.byteLength; at += 4) {
      const value = view.getFloat32(at, true)
      cityRequire(
        Number.isFinite(value) && value >= 0 && value <= 10000,
        'Invalid original thermal scalar'
      )
    }
  }

  private checkPressure(block: PressureBlock, tick: number): void {
    cityRequire(
      block.sampleStart === Math.floor(((tick - 1) * 16000) / 120) &&
        block.sampleEnd === Math.floor((tick * 16000) / 120) &&
        block.sampleRateHz === 16000 &&
        block.unit === 'pascal' &&
        block.channels.length === this.#plan.scene.microphones.length,
      'Original pressure clock or channel roster changed'
    )
    for (const channel of block.channels)
      cityRequire(
        channel.length === block.sampleEnd - block.sampleStart &&
          Array.from(channel).every(Number.isFinite),
        'Invalid original pressure interval'
      )
  }

  private retained(handle: CityObservationHandle): RetainedBatch {
    cityRequire(
      this.#phase !== 'busy' && this.#retained?.handle === handle,
      'Foreign, altered, busy, or released city lease'
    )
    return this.#retained
  }

  observation(handle: CityObservationHandle): CityObservation {
    return this.retained(handle).observation
  }

  /** One detached bounded raw-byte copy. Caller storage is additional to the native arena. */
  readChunk(
    handle: CityObservationHandle,
    requestId: string,
    expectedSha256: string,
    offset: number
  ): Uint8Array {
    const source = this.retained(handle).produced.get(requestId)
    cityRequire(
      source &&
        source.sha256 === expectedSha256 &&
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        offset < source.length &&
        offset % CITY_CHUNK_BYTES === 0,
      'Unknown source, digest, or chunk offset'
    )
    return this.#arena.slice(
      source.offset + offset,
      source.offset + Math.min(offset + CITY_CHUNK_BYTES, source.length)
    )
  }

  release(handle: CityObservationHandle): void {
    const retained = this.retained(handle)
    this.#lastBatch = retained.handle.sha256
    this.#retained = null
    this.#arena.fill(0)
    this.#controlBytes.fill(0)
  }

  /** Privileged mechanical/control record; never a modality or ordinary predictor input. */
  readControlChunk(
    handle: CityObservationHandle,
    expectedSha256: string,
    offset: number
  ): Uint8Array {
    const retained = this.retained(handle)
    cityRequire(
      expectedSha256 === retained.observation.control.transitionSha256 &&
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        offset < retained.controlLength &&
        offset % CITY_CHUNK_BYTES === 0,
      'Unknown privileged control digest or chunk offset'
    )
    return this.#controlBytes.slice(
      offset,
      Math.min(offset + CITY_CHUNK_BYTES, retained.controlLength)
    )
  }

  /** Privileged CPU reference only; no sensor or reconstruction authority. */
  cpuReference(): string {
    cityRequire(this.#phase === 'active', 'City CPU reference unavailable')
    return this.#cpu.referenceState()
  }

  resourceStatus() {
    return {
      phase: this.#phase,
      bounds: this.#bounds,
      originalBackingBytes: this.#arena.byteLength,
      receiptBackingBytes: this.#metadata.byteLength,
      controlBackingBytes: this.#controlBytes.byteLength,
      retainedSources: this.#retained?.produced.size ?? 0,
      failure: this.#failure,
      processRetirement: 'outside_component_scope' as const,
    }
  }

  async retire(): Promise<void> {
    cityRequire(this.#phase !== 'busy', 'Busy city owner requires its containing process lifecycle')
    this.#phase = 'retired'
    const errors = await this.stopComponents()
    if (errors.length) throw new AggregateError(errors, 'City component cleanup remains unresolved')
  }
}
