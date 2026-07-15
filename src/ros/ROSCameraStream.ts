/**
 * CREBAIN ROS Camera Stream
 * Adaptive Response & Awareness System (ARAS)
 *
 * Subscribes to ROS camera topics (from Gazebo) and streams frames to the frontend
 * Supports both raw and compressed image formats with efficient decoding
 */

import type { ROSBridge } from './ROSBridge'
import type { ZenohBridge } from './ZenohBridge'
import type { Image, CompressedImage, CameraInfo, Header } from './types'
import { namespacedRosTopic } from './utils'
import { rosLogger as log } from '../lib/logger'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface CameraStreamConfig {
  /** Topic for compressed images (preferred for bandwidth) */
  compressedTopic?: string
  /** Topic for raw images (fallback) */
  rawTopic?: string
  /** Topic for camera info (intrinsics) */
  infoTopic?: string
  /** Throttle rate in ms (0 = no throttle) */
  throttleMs: number
  /** Queue length for subscription */
  queueLength: number
  /** Use ImageBitmap for browser-native decoding */
  useImageBitmap: boolean
}

export interface DecodedFrame {
  /** Decoded image as ImageBitmap or ImageData */
  image: ImageBitmap | ImageData
  /** Frame width */
  width: number
  /** Frame height */
  height: number
  /** ROS header with timestamp */
  header: Header
  /** Decode latency in ms */
  decodeTimeMs: number
  /** Frame sequence number */
  sequence: number
}

export interface CameraStreamStats {
  framesReceived: number
  framesDecoded: number
  framesDropped: number
  averageDecodeMs: number
  averageLatencyMs: number
  currentFps: number
}

type IncomingCameraFrame =
  | { kind: 'compressed'; message: CompressedImage; generation: number }
  | { kind: 'raw'; message: Image; generation: number }

type PendingCameraFrame = IncomingCameraFrame & { settle: () => void }

export type FrameCallback = (frame: DecodedFrame) => void
export type CameraInfoCallback = (info: CameraInfo) => void

/**
 * Release the GPU-backed bitmap owned by a decoded frame.
 * Idempotent; ImageData-backed frames are a no-op.
 */
export function closeFrameImage(frame: DecodedFrame): void {
  if (typeof ImageBitmap !== 'undefined' && frame.image instanceof ImageBitmap) {
    frame.image.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CameraStreamConfig = {
  throttleMs: 33, // ~30 FPS max
  queueLength: 1, // Drop old frames
  useImageBitmap: true,
}

export const MAX_CAMERA_ENCODED_BYTES = 64 * 1024 * 1024
export const MAX_CAMERA_DECODED_BYTES = 64 * 1024 * 1024
export const MAX_CAMERA_DIMENSION = 8_192
export const MAX_CAMERA_PIXELS = Math.floor(MAX_CAMERA_DECODED_BYTES / 4)
/**
 * Per-stream decode cap across every lifecycle generation. One stale browser
 * decode may coexist with the current generation so restart can recover, but
 * repeated restarts can never accumulate unbounded decoding work.
 */
export const MAX_CAMERA_DECODE_WORKERS = 2
const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_CAMERA_ENCODED_BYTES / 3) * 4
const MAX_CAMERA_FORMAT_LENGTH = 64
const MAX_CAMERA_FRAME_ID_LENGTH = 256

// ─────────────────────────────────────────────────────────────────────────────
// ROS CAMERA STREAM
// ─────────────────────────────────────────────────────────────────────────────

export class ROSCameraStream {
  private bridge: ROSBridge | ZenohBridge | null = null
  private config: CameraStreamConfig
  private frameCallbacks: Set<FrameCallback> = new Set()
  private infoCallbacks: Set<CameraInfoCallback> = new Set()
  private unsubscribes: Array<() => void> = []
  private cameraInfo: CameraInfo | null = null
  private streamGeneration = 0
  private decodeWorkerGenerations: Set<number> = new Set()
  private pendingFrame: PendingCameraFrame | null = null

  // Stats tracking
  private stats: CameraStreamStats = {
    framesReceived: 0,
    framesDecoded: 0,
    framesDropped: 0,
    averageDecodeMs: 0,
    averageLatencyMs: 0,
    currentFps: 0,
  }
  private lastFrameTime: number = 0
  private fpsWindow: number[] = []
  private decodeWindow: number[] = []

  constructor(config: Partial<CameraStreamConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    if (!Number.isSafeInteger(this.config.throttleMs) || this.config.throttleMs < 0) {
      throw new Error('Camera throttleMs must be a safe non-negative integer')
    }
    if (!Number.isSafeInteger(this.config.queueLength) || this.config.queueLength < 0) {
      throw new Error('Camera queueLength must be a safe non-negative integer')
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Start streaming from ROS camera topics
   */
  start(bridge: ROSBridge | ZenohBridge, namespace: string = ''): void {
    if (this.bridge) {
      this.stop()
    }

    this.bridge = bridge
    const generation = ++this.streamGeneration

    // Subscribe to compressed image (preferred)
    if (this.config.compressedTopic) {
      // namespacedRosTopic yields absolute topic names even for empty or
      // non-`/` namespaces (raw prefixing would produce invalid relative ones)
      const topic = namespacedRosTopic(namespace, this.config.compressedTopic)
      const unsub = bridge.subscribe<CompressedImage>(
        topic,
        'sensor_msgs/CompressedImage',
        (msg) => this.enqueueFrame({ kind: 'compressed', message: msg, generation }),
        this.config.throttleMs,
        this.config.queueLength
      )
      this.unsubscribes.push(unsub)
    }

    // Subscribe to raw image (fallback)
    if (this.config.rawTopic && !this.config.compressedTopic) {
      const topic = namespacedRosTopic(namespace, this.config.rawTopic)
      const unsub = bridge.subscribe<Image>(
        topic,
        'sensor_msgs/Image',
        (msg) => this.enqueueFrame({ kind: 'raw', message: msg, generation }),
        this.config.throttleMs,
        this.config.queueLength
      )
      this.unsubscribes.push(unsub)
    }

    // Subscribe to camera info (intrinsics/calibration)
    if (this.config.infoTopic) {
      const topic = namespacedRosTopic(namespace, this.config.infoTopic)
      const unsub = bridge.subscribe<CameraInfo>(
        topic,
        'sensor_msgs/CameraInfo',
        (msg) => {
          if (generation === this.streamGeneration) this.handleCameraInfo(msg)
        }
      )
      this.unsubscribes.push(unsub)
    }
  }

  /**
   * Stop streaming
   */
  stop(): void {
    this.streamGeneration += 1
    this.pendingFrame?.settle()
    this.pendingFrame = null
    for (const unsub of this.unsubscribes) {
      unsub()
    }
    this.unsubscribes = []
    this.bridge = null
    this.cameraInfo = null
    this.resetStats()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MESSAGE HANDLERS
  // ───────────────────────────────────────────────────────────────────────────

  private enqueueFrame(frame: IncomingCameraFrame): Promise<void> {
    return new Promise((settle) => {
      if (frame.generation !== this.streamGeneration) {
        settle()
        return
      }
      this.stats.framesReceived++

      if (this.pendingFrame) {
        // Keep only the latest not-yet-decoded frame. Resolve the replaced
        // callback so native pull/ack delivery can release its reservation.
        this.pendingFrame.settle()
        this.stats.framesDropped++
      }
      this.pendingFrame = { ...frame, settle }
      void this.drainDecodeQueue(frame.generation)
    })
  }

  private async drainDecodeQueue(generation: number): Promise<void> {
    if (
      this.decodeWorkerGenerations.has(generation) ||
      this.decodeWorkerGenerations.size >= MAX_CAMERA_DECODE_WORKERS ||
      this.pendingFrame?.generation !== generation
    ) {
      return
    }
    this.decodeWorkerGenerations.add(generation)

    try {
      while (this.pendingFrame?.generation === generation) {
        const pending = this.pendingFrame
        this.pendingFrame = null
        try {
          if (generation !== this.streamGeneration) continue
          const decoded =
            pending.kind === 'compressed'
              ? await this.decodeCompressedImage(pending.message)
              : await this.decodeRawImage(pending.message)

          if (pending.generation !== this.streamGeneration) {
            if (decoded) closeFrameImage(decoded)
            continue
          }
          if (!decoded) {
            this.stats.framesDropped++
            continue
          }

          this.stats.framesDecoded++
          this.updateStats(decoded.decodeTimeMs)
          this.notifyFrameCallbacks(decoded)
        } catch (error) {
          if (pending.generation === this.streamGeneration) {
            this.stats.framesDropped++
            log.error(`Failed to decode ${pending.kind} image`, { error })
          }
        } finally {
          pending.settle()
        }
      }
    } finally {
      this.decodeWorkerGenerations.delete(generation)
      // A callback can enqueue between the loop's final condition and this
      // finally block. The set above enforces the global cross-generation cap.
      if (this.pendingFrame) void this.drainDecodeQueue(this.pendingFrame.generation)
    }
  }

  private handleCameraInfo(msg: CameraInfo): void {
    if (!this.isValidCameraInfo(msg)) {
      log.warn('Dropping malformed ROS camera info')
      return
    }
    this.cameraInfo = msg
    for (const callback of this.infoCallbacks) {
      try {
        callback(msg)
      } catch (error) {
        log.error('Camera info callback error', { error })
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // IMAGE DECODING
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Decode compressed image (JPEG/PNG)
   */
  private async decodeCompressedImage(msg: CompressedImage): Promise<DecodedFrame | null> {
    const startTime = performance.now()
    if (!this.isValidHeader(msg?.header) || typeof msg.format !== 'string') return null

    const bytes = this.toBoundedBytes(msg.data, MAX_CAMERA_ENCODED_BYTES)
    if (!bytes || bytes.byteLength === 0) return null
    const inspection = this.inspectEncodedImage(bytes)
    if (!inspection || !this.declaredFormatMatches(msg.format, inspection.mimeType)) return null
    if (!this.validDecodedDimensions(inspection.width, inspection.height)) return null

    // BlobPart typing in TS is strict about ArrayBuffer vs SharedArrayBuffer.
    // Normalize to an owned ArrayBuffer-backed slice.
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    const blob = new Blob([copy.buffer], { type: inspection.mimeType })

    if (this.config.useImageBitmap) {
      // Browser-native decoding via ImageBitmap
      const bitmap = await createImageBitmap(blob)
      if (
        bitmap.width !== inspection.width ||
        bitmap.height !== inspection.height ||
        !this.validDecodedDimensions(bitmap.width, bitmap.height)
      ) {
        bitmap.close()
        return null
      }

      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        header: msg.header,
        decodeTimeMs: performance.now() - startTime,
        sequence: msg.header.seq ?? 0,
      }
    } else {
      // Canvas-based decoding (fallback)
      return new Promise((resolve) => {
        const img = new Image()
        const url = URL.createObjectURL(blob)
        img.onload = () => {
          URL.revokeObjectURL(url)
          const width = img.naturalWidth || img.width
          const height = img.naturalHeight || img.height
          if (
            width !== inspection.width ||
            height !== inspection.height ||
            !this.validDecodedDimensions(width, height)
          ) {
            resolve(null)
            return
          }
          const canvas = new OffscreenCanvas(width, height)
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            resolve(null)
            return
          }
          ctx.drawImage(img, 0, 0)
          const imageData = ctx.getImageData(0, 0, width, height)

          resolve({
            image: imageData,
            width,
            height,
            header: msg.header,
            decodeTimeMs: performance.now() - startTime,
            sequence: msg.header.seq ?? 0,
          })
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          resolve(null)
        }
        img.src = url
      })
    }
  }

  /**
   * Decode raw image (rgb8, bgr8, mono8, etc.)
   */
  private async decodeRawImage(msg: Image): Promise<DecodedFrame | null> {
    const startTime = performance.now()
    if (!this.isValidHeader(msg?.header)) return null
    const { width, height, encoding } = msg
    if (!this.validDecodedDimensions(width, height) || typeof encoding !== 'string') return null
    if (msg.is_bigendian !== 0 && msg.is_bigendian !== 1) return null

    const bytesPerPixel = this.rawBytesPerPixel(encoding)
    if (bytesPerPixel === null) {
      log.warn(`Unsupported encoding: ${encoding}`)
      return null
    }

    const minStep = width * bytesPerPixel
    const step = msg.step
    const expectedLength = step * height
    if (
      !Number.isSafeInteger(minStep) ||
      !Number.isSafeInteger(step) ||
      !Number.isSafeInteger(expectedLength) ||
      step < minStep ||
      expectedLength > MAX_CAMERA_ENCODED_BYTES
    ) {
      return null
    }
    const bytes = this.toBoundedBytes(msg.data, expectedLength)
    if (!bytes || bytes.length !== expectedLength) return null

    // Create RGBA ImageData
    const imageData = new ImageData(width, height)
    const rgba = imageData.data

    for (let y = 0; y < height; y++) {
      const srcRow = y * step
      const dstRow = y * width * 4
      if (encoding === 'rgba8') {
        rgba.set(bytes.subarray(srcRow, srcRow + minStep), dstRow)
      } else {
        for (let x = 0; x < width; x++) {
          const src = srcRow + x * bytesPerPixel
          const dst = dstRow + x * 4
          if (encoding === 'rgb8') {
            rgba[dst] = bytes[src]
            rgba[dst + 1] = bytes[src + 1]
            rgba[dst + 2] = bytes[src + 2]
            rgba[dst + 3] = 255
          } else if (encoding === 'bgr8') {
            rgba[dst] = bytes[src + 2]
            rgba[dst + 1] = bytes[src + 1]
            rgba[dst + 2] = bytes[src]
            rgba[dst + 3] = 255
          } else if (encoding === 'bgra8') {
            rgba[dst] = bytes[src + 2]
            rgba[dst + 1] = bytes[src + 1]
            rgba[dst + 2] = bytes[src]
            rgba[dst + 3] = bytes[src + 3]
          } else if (encoding === 'mono8') {
            rgba[dst] = bytes[src]
            rgba[dst + 1] = bytes[src]
            rgba[dst + 2] = bytes[src]
            rgba[dst + 3] = 255
          }
        }
      }
    }

    // Optionally convert to ImageBitmap for GPU use
    if (this.config.useImageBitmap) {
      const bitmap = await createImageBitmap(imageData)
      if (bitmap.width !== width || bitmap.height !== height) {
        bitmap.close()
        return null
      }
      return {
        image: bitmap,
        width,
        height,
        header: msg.header,
        decodeTimeMs: performance.now() - startTime,
        sequence: msg.header.seq ?? 0,
      }
    }

    return {
      image: imageData,
      width,
      height,
      header: msg.header,
      decodeTimeMs: performance.now() - startTime,
      sequence: msg.header.seq ?? 0,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ENCODING UTILITIES
  // ───────────────────────────────────────────────────────────────────────────

  private base64ToUint8Array(base64: string, maximumBytes: number): Uint8Array | null {
    if (
      base64.length === 0 ||
      base64.length > MAX_BASE64_IMAGE_CHARS ||
      base64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)
    ) {
      return null
    }

    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const decodedLength = (base64.length / 4) * 3 - padding
    if (!Number.isSafeInteger(decodedLength) || decodedLength > maximumBytes) return null

    let binary: string
    try {
      binary = atob(base64)
    } catch {
      return null
    }
    if (binary.length !== decodedLength) return null
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  private toBoundedBytes(data: Image['data'], maximumBytes: number): Uint8Array | null {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      maximumBytes > MAX_CAMERA_ENCODED_BYTES
    ) {
      return null
    }
    if (typeof data === 'string') return this.base64ToUint8Array(data, maximumBytes)
    if (data instanceof Uint8Array) {
      return data.byteLength <= maximumBytes ? data : null
    }
    if (!Array.isArray(data) || data.length > maximumBytes) return null
    if (!data.every((byte) => Number.isSafeInteger(byte) && byte >= 0 && byte <= 255)) return null
    return new Uint8Array(data)
  }

  private validDecodedDimensions(width: unknown, height: unknown): width is number {
    if (
      typeof width !== 'number' ||
      typeof height !== 'number' ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > MAX_CAMERA_DIMENSION ||
      height > MAX_CAMERA_DIMENSION
    ) {
      return false
    }
    const pixels = width * height
    const rgbaBytes = pixels * 4
    return (
      Number.isSafeInteger(pixels) &&
      pixels <= MAX_CAMERA_PIXELS &&
      Number.isSafeInteger(rgbaBytes) &&
      rgbaBytes <= MAX_CAMERA_DECODED_BYTES
    )
  }

  private inspectEncodedImage(
    bytes: Uint8Array
  ): { mimeType: 'image/png' | 'image/jpeg'; width: number; height: number } | null {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    if (bytes.length >= 24 && pngSignature.every((byte, index) => bytes[index] === byte)) {
      const ihdrLength = this.readUint32BigEndian(bytes, 8)
      const isIhdr = bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
      if (ihdrLength !== 13 || !isIhdr) return null
      return {
        mimeType: 'image/png',
        width: this.readUint32BigEndian(bytes, 16),
        height: this.readUint32BigEndian(bytes, 20),
      }
    }

    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return null
    }
    const startOfFrameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ])
    let offset = 2
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) return null
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
      if (offset >= bytes.length) return null
      const marker = bytes[offset]
      offset += 1
      if (marker === 0xd9 || marker === 0xda) return null
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      if (offset + 1 >= bytes.length) return null
      const segmentLength = bytes[offset] * 256 + bytes[offset + 1]
      if (segmentLength < 2 || offset + segmentLength > bytes.length) return null
      if (startOfFrameMarkers.has(marker)) {
        if (segmentLength < 7) return null
        return {
          mimeType: 'image/jpeg',
          height: bytes[offset + 3] * 256 + bytes[offset + 4],
          width: bytes[offset + 5] * 256 + bytes[offset + 6],
        }
      }
      offset += segmentLength
    }
    return null
  }

  private readUint32BigEndian(bytes: Uint8Array, offset: number): number {
    return (
      bytes[offset] * 0x1000000 +
      bytes[offset + 1] * 0x10000 +
      bytes[offset + 2] * 0x100 +
      bytes[offset + 3]
    )
  }

  private declaredFormatMatches(
    format: string,
    detected: 'image/png' | 'image/jpeg'
  ): boolean {
    if (
      format.length > MAX_CAMERA_FORMAT_LENGTH ||
      Array.from(format).some((character) => {
        const codePoint = character.codePointAt(0)
        return codePoint === undefined || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      })
    ) {
      return false
    }
    const normalized = format.trim().toLowerCase()
    const declaresPng = /(^|[^a-z0-9])png([^a-z0-9]|$)/u.test(normalized)
    const declaresJpeg = /(^|[^a-z0-9])jpe?g([^a-z0-9]|$)/u.test(normalized)
    if (declaresPng && declaresJpeg) return false
    if (declaresPng) return detected === 'image/png'
    if (declaresJpeg) return detected === 'image/jpeg'
    // Match the native compatibility policy: an empty ROS format may fall back
    // only to a signature-confirmed JPEG, never to PNG or an unknown codec.
    return normalized.length === 0 && detected === 'image/jpeg'
  }

  private isValidHeader(header: unknown): header is Header {
    if (typeof header !== 'object' || header === null || Array.isArray(header)) return false
    const record = header as Record<string, unknown>
    const keys = Object.keys(record)
    if (
      keys.some((key) => !['seq', 'stamp', 'frame_id'].includes(key)) ||
      !Object.prototype.hasOwnProperty.call(record, 'stamp') ||
      !Object.prototype.hasOwnProperty.call(record, 'frame_id') ||
      (record.seq !== undefined &&
        (typeof record.seq !== 'number' || !Number.isSafeInteger(record.seq) || record.seq < 0)) ||
      typeof record.frame_id !== 'string' ||
      record.frame_id.length > MAX_CAMERA_FRAME_ID_LENGTH ||
      Array.from(record.frame_id).some((character) => {
        const codePoint = character.codePointAt(0)
        return (
          /\s/u.test(character) ||
          codePoint === undefined ||
          codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f)
        )
      })
    ) {
      return false
    }
    const stamp = record.stamp
    if (typeof stamp !== 'object' || stamp === null || Array.isArray(stamp)) return false
    const time = stamp as Record<string, unknown>
    const timeKeys = Object.keys(time)
    if (timeKeys.some((key) => !['secs', 'nsecs'].includes(key)) || timeKeys.length !== 2) {
      return false
    }
    return (
      typeof time.secs === 'number' &&
      Number.isSafeInteger(time.secs) &&
      time.secs >= 0 &&
      typeof time.nsecs === 'number' &&
      Number.isSafeInteger(time.nsecs) &&
      time.nsecs >= 0 &&
      time.nsecs < 1_000_000_000
    )
  }

  private isValidCameraInfo(info: unknown): info is CameraInfo {
    if (typeof info !== 'object' || info === null || Array.isArray(info)) return false
    const record = info as Record<string, unknown>
    const allowedKeys = new Set([
      'header',
      'height',
      'width',
      'distortion_model',
      'D',
      'K',
      'R',
      'P',
      'binning_x',
      'binning_y',
      'roi',
    ])
    const finiteArray = (value: unknown, length?: number, maximum = 32) =>
      Array.isArray(value) &&
      value.length <= maximum &&
      (length === undefined || value.length === length) &&
      value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    const safeOptionalInteger = (value: unknown) =>
      value === undefined ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    const validRoi = (value: unknown) => {
      if (value === undefined) return true
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const roi = value as Record<string, unknown>
      return (
        Object.keys(roi).every((key) =>
          ['x_offset', 'y_offset', 'height', 'width', 'do_rectify'].includes(key)
        ) &&
        ['x_offset', 'y_offset', 'height', 'width'].every(
          (key) => typeof roi[key] === 'number' && Number.isSafeInteger(roi[key]) && roi[key] >= 0
        ) &&
        typeof roi.do_rectify === 'boolean'
      )
    }
    if (typeof record.distortion_model !== 'string') return false
    const distortionModel = record.distortion_model.trim().toLowerCase()
    const expectedDistortionLength =
      distortionModel === 'plumb_bob'
        ? 5
        : distortionModel === 'rational_polynomial'
          ? 8
          : distortionModel === 'equidistant'
            ? 4
            : undefined
    return (
      Object.keys(record).every((key) => allowedKeys.has(key)) &&
      this.isValidHeader(record.header) &&
      this.validDecodedDimensions(record.width, record.height) &&
      record.distortion_model.length <= MAX_CAMERA_FORMAT_LENGTH &&
      /^[a-z0-9_.-]*$/u.test(distortionModel) &&
      finiteArray(record.D, expectedDistortionLength) &&
      finiteArray(record.K, 9) &&
      finiteArray(record.R, 9) &&
      finiteArray(record.P, 12) &&
      safeOptionalInteger(record.binning_x) &&
      safeOptionalInteger(record.binning_y) &&
      validRoi(record.roi)
    )
  }

  private rawBytesPerPixel(encoding: string): number | null {
    if (encoding === 'rgba8' || encoding === 'bgra8') return 4
    if (encoding === 'rgb8' || encoding === 'bgr8') return 3
    if (encoding === 'mono8') return 1
    return null
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CALLBACKS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Register callback for decoded frames
   */
  onFrame(callback: FrameCallback): () => void {
    this.frameCallbacks.add(callback)
    return () => this.frameCallbacks.delete(callback)
  }

  /**
   * Register callback for camera info
   */
  onCameraInfo(callback: CameraInfoCallback): () => void {
    this.infoCallbacks.add(callback)
    // Immediately call with cached info if available
    if (this.cameraInfo) {
      callback(this.cameraInfo)
    }
    return () => this.infoCallbacks.delete(callback)
  }

  private notifyFrameCallbacks(frame: DecodedFrame): void {
    if (this.frameCallbacks.size === 0) {
      // No consumer takes ownership — release the GPU-backed bitmap now
      // instead of leaking one per decoded frame.
      closeFrameImage(frame)
      return
    }
    for (const callback of this.frameCallbacks) {
      try {
        callback(frame)
      } catch (error) {
        log.error('Frame callback error', { error })
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STATS
  // ───────────────────────────────────────────────────────────────────────────

  private updateStats(decodeTimeMs: number): void {
    const now = performance.now()

    // Update FPS calculation
    if (this.lastFrameTime > 0) {
      const frameTime = now - this.lastFrameTime
      this.fpsWindow.push(frameTime)
      if (this.fpsWindow.length > 30) {
        this.fpsWindow.shift()
      }
      const avgFrameTime = this.fpsWindow.reduce((a, b) => a + b, 0) / this.fpsWindow.length
      this.stats.currentFps = 1000 / avgFrameTime
    }
    this.lastFrameTime = now

    // Update decode time average
    this.decodeWindow.push(decodeTimeMs)
    if (this.decodeWindow.length > 30) {
      this.decodeWindow.shift()
    }
    this.stats.averageDecodeMs = this.decodeWindow.reduce((a, b) => a + b, 0) / this.decodeWindow.length
  }

  private resetStats(): void {
    this.stats = {
      framesReceived: 0,
      framesDecoded: 0,
      framesDropped: 0,
      averageDecodeMs: 0,
      averageLatencyMs: 0,
      currentFps: 0,
    }
    this.fpsWindow = []
    this.decodeWindow = []
    this.lastFrameTime = 0
  }

  /**
   * Get current streaming statistics
   */
  getStats(): Readonly<CameraStreamStats> {
    return this.stats
  }

  /**
   * Get cached camera info
   */
  getCameraInfo(): CameraInfo | null {
    return this.cameraInfo
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a camera stream for a specific drone camera
 * Note: droneNamespace is passed to stream.start(), not embedded in topics
 */
export function createDroneCameraStream(
  _droneNamespace: string,
  cameraName: string = 'camera'
): ROSCameraStream {
  return new ROSCameraStream({
    compressedTopic: `${cameraName}/image_raw/compressed`,
    rawTopic: `${cameraName}/image_raw`,
    infoTopic: `${cameraName}/camera_info`,
    throttleMs: 33,
    queueLength: 1,
    useImageBitmap: true,
  })
}

/**
 * Create a thermal camera stream
 * Note: droneNamespace is passed to stream.start(), not embedded in topics
 */
export function createThermalCameraStream(
  _droneNamespace: string,
  cameraName: string = 'thermal_camera'
): ROSCameraStream {
  return new ROSCameraStream({
    rawTopic: `${cameraName}/image_raw`,
    infoTopic: `${cameraName}/camera_info`,
    throttleMs: 100, // Thermal cameras typically lower framerate
    queueLength: 1,
    useImageBitmap: true,
  })
}
