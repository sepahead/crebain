import { copyPlainData } from '../lib/copyPlainData'
import { closedKeys } from './SceneSpec'
import {
  GraphicsSourceIntegrityError,
  isGraphicsSourceIntegrityError,
  graphicsInputDigest,
  ownSourceGraphicsPlan,
  type SourceGraphicsPlan,
  type SourceGraphicsInput,
  type SourceGraphicsPort,
  type GraphicsSourceSelection,
  type GraphicsSourceReceipt,
} from './GraphicsContract'

export const GRAPHICS_SOURCE_CAPACITY_BYTES = 4 * 1280 * 1280
export const GRAPHICS_SOURCE_CHUNK_BYTES = 32_768

export interface RetainedGraphicsSource {
  schema: 'crebain.private-graphics-source.v1'
  sequence: number
  receipt: GraphicsSourceReceipt
  originalSha256: string
}

export interface GraphicsSourceChunk {
  sequence: number
  originalSha256: string
  offset: number
  bytes: Uint8Array
  chunkSha256: string
}

interface RuntimePort extends SourceGraphicsPort {
  runtimeIdentity(): { version: string; renderer: string; vendor: string }
}

/** The actual capture call failed. Transport or receipt checks use a distinct local error. */
export class GraphicsSourceAcquisitionError extends Error {
  constructor(primary: unknown) {
    super('The selected actual graphics acquisition failed', { cause: primary })
    this.name = 'GraphicsSourceAcquisitionError'
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** One browser-owned source arena. A containing process must enforce acquisition deadlines. */
export class GraphicsSourceRetention {
  readonly planSha256: string
  readonly capacityBytes: number
  readonly #plan: SourceGraphicsPlan
  readonly #graphics: RuntimePort
  readonly #arena: Uint8Array
  #phase: 'active' | 'busy' | 'leased' | 'failed' | 'retired' = 'active'
  #lease: Readonly<RetainedGraphicsSource> | null = null
  #sequence = 0
  #readOffset = 0
  #reading = false
  #pending: Promise<Readonly<RetainedGraphicsSource>> | null = null
  #cleanup: Promise<void> | null = null

  private constructor(plan: SourceGraphicsPlan, graphics: RuntimePort, arena: Uint8Array) {
    this.#plan = plan
    this.#graphics = graphics
    this.#arena = arena
    this.capacityBytes = arena.byteLength
    this.planSha256 = graphics.planSha256
    Object.freeze(this)
  }

  static async prepare(
    input: SourceGraphicsPlan,
    launch: (plan: SourceGraphicsPlan) => Promise<RuntimePort>,
    capacityBytes = GRAPHICS_SOURCE_CAPACITY_BYTES
  ): Promise<GraphicsSourceRetention> {
    const plan = ownSourceGraphicsPlan(input)
    const required = Math.max(
      ...[...plan.scene.rgbCameras, ...plan.scene.thermalCameras].map(
        (row) => 4 * row.width * row.height
      )
    )
    if (
      !Number.isSafeInteger(capacityBytes) ||
      capacityBytes < required ||
      capacityBytes > GRAPHICS_SOURCE_CAPACITY_BYTES
    )
      throw new Error('Source retention capacity must admit the largest selected original')
    // Allocate actual backing before invoking any graphics constructor.
    const arena = new Uint8Array(required)
    const expectedPlan = await graphicsInputDigest(plan)
    const graphics = await launch(plan)
    try {
      if (graphics.planSha256 !== expectedPlan)
        throw new GraphicsSourceIntegrityError('Source retention graphics plan changed')
      return new GraphicsSourceRetention(plan, graphics, arena)
    } catch (primary) {
      const cleanupFailures: unknown[] = []
      try {
        await graphics.retire()
      } catch (cleanup) {
        cleanupFailures.push(cleanup)
      }
      if (cleanupFailures.length)
        throw new AggregateError(
          [primary, ...cleanupFailures],
          'Source retention construction failed',
          {
            cause: primary,
          }
        )
      throw primary
    }
  }

  runtimeIdentity(): { version: string; renderer: string; vendor: string } {
    return this.#graphics.runtimeIdentity()
  }

  async capture(
    input: SourceGraphicsInput,
    selection: GraphicsSourceSelection
  ): Promise<Readonly<RetainedGraphicsSource>> {
    if (this.#phase !== 'active') throw new Error('Source retention is unavailable')
    const value = copyPlainData(input)
    const source = copyPlainData(selection)
    closedKeys(source, ['kind', 'cameraId'])
    if (source.kind !== 'rgb' && source.kind !== 'thermal')
      throw new Error('Unknown retained graphics modality')
    const rows =
      source.kind === 'rgb' ? this.#plan.scene.rgbCameras : this.#plan.scene.thermalCameras
    const camera = rows.find((row) => row.id === source.cameraId)
    if (
      !camera ||
      value.planSha256 !== this.planSha256 ||
      !Number.isSafeInteger(value.tick) ||
      value.tick < 0 ||
      value.tick > 7200 ||
      value.tick % camera.periodTicks !== 0 ||
      this.#sequence >= Number.MAX_SAFE_INTEGER
    )
      throw new Error('Retained graphics source, tick, or plan changed')
    this.#phase = 'busy'
    const pending = this.captureOwned(value, source, camera.width, camera.height)
    this.#pending = pending
    try {
      return await pending
    } finally {
      this.#pending = null
    }
  }

  private async captureOwned(
    input: SourceGraphicsInput,
    source: GraphicsSourceSelection,
    width: number,
    height: number
  ): Promise<Readonly<RetainedGraphicsSource>> {
    const length = 4 * width * height
    const bytes = this.#arena.subarray(0, length)
    try {
      let captured: GraphicsSourceReceipt
      try {
        captured = await this.#graphics.captureSourceInto(input, source, bytes)
      } catch (primary) {
        if (isGraphicsSourceIntegrityError(primary)) throw primary
        throw new GraphicsSourceAcquisitionError(primary)
      }
      const receipt = copyPlainData(captured)
      closedKeys(receipt, [
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
      if (
        receipt.planSha256 !== this.planSha256 ||
        receipt.inputSha256 !== (await graphicsInputDigest(input)) ||
        receipt.tick !== input.tick ||
        receipt.kind !== source.kind ||
        receipt.cameraId !== source.cameraId ||
        receipt.width !== width ||
        receipt.height !== height ||
        receipt.rowOrigin !== 'bottom-left' ||
        receipt.encoding !== (source.kind === 'rgb' ? 'rgba8-srgb' : 'float32-le') ||
        receipt.byteLength !== length
      )
        throw new GraphicsSourceIntegrityError('Actual source receipt changed')
      const originalSha256 = await sha256(bytes)
      if (this.#phase !== 'busy')
        throw new GraphicsSourceIntegrityError('Retired source acquisition cannot publish')
      this.#lease = copyPlainData({
        schema: 'crebain.private-graphics-source.v1',
        sequence: ++this.#sequence,
        receipt,
        originalSha256,
      })
      this.#readOffset = 0
      this.#phase = 'leased'
      return this.#lease
    } catch (error) {
      if (this.#phase !== 'retired') this.#phase = 'failed'
      bytes.fill(0)
      if (error instanceof GraphicsSourceAcquisitionError || isGraphicsSourceIntegrityError(error))
        throw error
      throw new GraphicsSourceIntegrityError('Source receipt or original commitment failed', error)
    }
  }

  private current(sequence: number, originalSha256: string): Readonly<RetainedGraphicsSource> {
    if (
      this.#phase !== 'leased' ||
      !this.#lease ||
      sequence !== this.#lease.sequence ||
      originalSha256 !== this.#lease.originalSha256
    )
      throw new GraphicsSourceIntegrityError('Foreign or released graphics source')
    return this.#lease
  }

  async read(
    sequence: number,
    originalSha256: string,
    offset: number
  ): Promise<GraphicsSourceChunk> {
    const lease = this.current(sequence, originalSha256)
    if (
      !Number.isSafeInteger(offset) ||
      this.#reading ||
      offset !== this.#readOffset ||
      offset < 0 ||
      offset >= lease.receipt.byteLength
    )
      throw new GraphicsSourceIntegrityError('Graphics chunk must follow the exact read prefix')
    const end = Math.min(offset + GRAPHICS_SOURCE_CHUNK_BYTES, lease.receipt.byteLength)
    const bytes = this.#arena.slice(offset, end)
    // Claim the offset before awaiting, so overlapping reads cannot copy the same extent.
    this.#readOffset = end
    this.#reading = true
    try {
      const chunkSha256 = await sha256(bytes)
      if (this.current(sequence, originalSha256) !== lease)
        throw new GraphicsSourceIntegrityError('Graphics lease changed during a read')
      return { sequence, originalSha256, offset, bytes, chunkSha256 }
    } catch (error) {
      if (this.#phase !== 'retired') this.#phase = 'failed'
      throw error
    } finally {
      this.#reading = false
    }
  }

  release(sequence: number, originalSha256: string): void {
    const lease = this.current(sequence, originalSha256)
    if (this.#reading || this.#readOffset !== lease.receipt.byteLength)
      throw new GraphicsSourceIntegrityError('Incomplete graphics source cannot release')
    this.#arena.fill(0, 0, lease.receipt.byteLength)
    this.#lease = null
    this.#phase = 'active'
  }

  retire(): Promise<void> {
    this.#phase = 'retired'
    if (!this.#cleanup) {
      const pending = this.#pending
      this.#cleanup = (async () => {
        // The outer process deadline owns a stuck acquisition. Awaited local work is not killed here.
        if (pending) await pending.catch(() => undefined)
        this.#arena.fill(0)
        this.#lease = null
        await this.#graphics.retire()
      })()
    }
    return this.#cleanup
  }
}
