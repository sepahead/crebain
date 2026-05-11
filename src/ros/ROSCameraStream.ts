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

export type FrameCallback = (frame: DecodedFrame) => void
export type CameraInfoCallback = (info: CameraInfo) => void

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: CameraStreamConfig = {
  throttleMs: 33, // ~30 FPS max
  queueLength: 1, // Drop old frames
  useImageBitmap: true,
}

// Encoding conversion map for raw images (kept for reference)
const _ENCODING_CHANNELS: Record<string, number> = {
  mono8: 1,
  mono16: 2,
  bgr8: 3,
  rgb8: 3,
  bgra8: 4,
  rgba8: 4,
  bayer_rggb8: 1,
  bayer_bggr8: 1,
  bayer_gbrg8: 1,
  bayer_grbg8: 1,
}
void _ENCODING_CHANNELS // Silence unused warning

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
    const prefix = namespace ? `${namespace}/` : ''

    // Subscribe to compressed image (preferred)
    if (this.config.compressedTopic) {
      const topic = `${prefix}${this.config.compressedTopic}`
      const unsub = bridge.subscribe<CompressedImage>(
        topic,
        'sensor_msgs/CompressedImage',
        (msg) => this.handleCompressedImage(msg),
        this.config.throttleMs,
        this.config.queueLength
      )
      this.unsubscribes.push(unsub)
    }

    // Subscribe to raw image (fallback)
    if (this.config.rawTopic && !this.config.compressedTopic) {
      const topic = `${prefix}${this.config.rawTopic}`
      const unsub = bridge.subscribe<Image>(
        topic,
        'sensor_msgs/Image',
        (msg) => this.handleRawImage(msg),
        this.config.throttleMs,
        this.config.queueLength
      )
      this.unsubscribes.push(unsub)
    }

    // Subscribe to camera info (intrinsics/calibration)
    if (this.config.infoTopic) {
      const topic = `${prefix}${this.config.infoTopic}`
      const unsub = bridge.subscribe<CameraInfo>(
        topic,
        'sensor_msgs/CameraInfo',
        (msg) => this.handleCameraInfo(msg)
      )
      this.unsubscribes.push(unsub)
    }
  }

  /**
   * Stop streaming
   */
  stop(): void {
    for (const unsub of this.unsubscribes) {
      unsub()
    }
    this.unsubscribes = []
    this.bridge = null
    this.resetStats()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MESSAGE HANDLERS
  // ───────────────────────────────────────────────────────────────────────────

  private async handleCompressedImage(msg: CompressedImage): Promise<void> {
    this.stats.framesReceived++

    try {
      const frame = await this.decodeCompressedImage(msg)
      if (frame) {
        this.stats.framesDecoded++
        this.updateStats(frame.decodeTimeMs)
        this.notifyFrameCallbacks(frame)
      }
    } catch (error) {
      this.stats.framesDropped++
      log.error('Failed to decode compressed image', { error })
    }
  }

  private async handleRawImage(msg: Image): Promise<void> {
    this.stats.framesReceived++

    try {
      const frame = await this.decodeRawImage(msg)
      if (frame) {
        this.stats.framesDecoded++
        this.updateStats(frame.decodeTimeMs)
        this.notifyFrameCallbacks(frame)
      }
    } catch (error) {
      this.stats.framesDropped++
      log.error('Failed to decode raw image', { error })
    }
  }

  private handleCameraInfo(msg: CameraInfo): void {
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

    // Determine MIME type
    const mimeType = msg.format.includes('png') ? 'image/png' : 'image/jpeg'
    
    const bytesToBlob = (bytes: Uint8Array): Blob => {
      // BlobPart typing in TS is strict about ArrayBuffer vs SharedArrayBuffer.
      // Normalize to ArrayBuffer-backed slices for broad compatibility.
      if (bytes.buffer instanceof ArrayBuffer) {
        const slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        return new Blob([slice], { type: mimeType })
      }
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      return new Blob([copy.buffer], { type: mimeType })
    }

    // Prefer decoding directly from bytes when possible (avoids base64 overhead)
    let blob: Blob
    if (typeof msg.data === 'string') {
      // Assume base64-encoded payload
      blob = bytesToBlob(this.base64ToUint8Array(msg.data))
    } else if (msg.data instanceof Uint8Array) {
      blob = bytesToBlob(msg.data)
    } else if (Array.isArray(msg.data)) {
      blob = bytesToBlob(new Uint8Array(msg.data))
    } else {
      return null
    }

    if (this.config.useImageBitmap) {
      // Browser-native decoding via ImageBitmap
      const bitmap = await createImageBitmap(blob)

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
          const canvas = new OffscreenCanvas(img.width, img.height)
          const ctx = canvas.getContext('2d')!
          ctx.drawImage(img, 0, 0)
          const imageData = ctx.getImageData(0, 0, img.width, img.height)

          resolve({
            image: imageData,
            width: img.width,
            height: img.height,
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

    // Get raw bytes
    let bytes: Uint8Array
    if (typeof msg.data === 'string') {
      bytes = this.base64ToUint8Array(msg.data)
    } else if (msg.data instanceof Uint8Array) {
      bytes = msg.data
    } else if (Array.isArray(msg.data)) {
      bytes = new Uint8Array(msg.data)
    } else {
      return null
    }

    const { width, height, encoding } = msg
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      return null
    }

    const bytesPerPixel = this.rawBytesPerPixel(encoding)
    if (bytesPerPixel === null) {
      log.warn(`Unsupported encoding: ${encoding}`)
      return null
    }

    const minStep = width * bytesPerPixel
    const step = msg.step ?? minStep
    const expectedLength = step * height
    if (
      !Number.isSafeInteger(minStep) ||
      !Number.isSafeInteger(step) ||
      !Number.isSafeInteger(expectedLength) ||
      step < minStep
    ) {
      return null
    }
    if (bytes.length < expectedLength) {
      return null
    }

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

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
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
