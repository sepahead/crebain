/**
 * CREBAIN Transform Manager
 * Adaptive Response & Awareness System (ARAS)
 *
 * TF (Transform) tree management with efficient caching
 * Subscribes to /tf and /tf_static for coordinate frame transforms
 */

import type { ROSBridge } from './ROSBridge'
import type {
  TransformStamped,
  Transform,
  Point,
  Vector3,
  Time,
  TFMessage,
} from './types'
import { timeToDate, createTime } from './types'
import {
  multiplyQuaternions,
  inverseQuaternion,
  rotateVectorByQuaternion,
} from '../lib/mathUtils'

// Re-export TFMessage for convenience
export type { TFMessage }

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface CachedTransform {
  transform: TransformStamped
  /** The transform's own header.stamp in ms — index for time-based lookups
   *  (works for sim time, where wall clock and ROS time diverge) */
  stampMs: number
  /** Wall-clock arrival time in ms — used only for cache expiry */
  receivedAtMs: number
  isStatic: boolean
}

export interface TransformLookupResult {
  transform: Transform
  timestamp: Time
  valid: boolean
  error?: string
}

export interface TransformManagerConfig {
  /** Cache duration for dynamic transforms in ms (default: 10000) */
  cacheDurationMs: number
  /** Throttle rate for /tf subscription in ms (default: 10) */
  throttleRateMs: number
  /** Maximum cache size per frame pair (default: 100) */
  maxCacheSize: number
}

// ─────────────────────────────────────────────────────────────────────────────
// STANDARD FRAME IDS
// ─────────────────────────────────────────────────────────────────────────────

export const StandardFrames = {
  WORLD: 'world',
  MAP: 'map',
  ODOM: 'odom',
  BASE_LINK: 'base_link',
  BASE_FOOTPRINT: 'base_footprint',
  BODY: 'body',
  CAMERA: 'camera_link',
  IMU: 'imu_link',
  GPS: 'gps_link',
  LIDAR: 'lidar_link',
} as const

export type StandardFrame = typeof StandardFrames[keyof typeof StandardFrames]

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TransformManagerConfig = {
  cacheDurationMs: 10000, // 10 seconds
  throttleRateMs: 10, // 100 Hz
  maxCacheSize: 100,
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFORM MANAGER
// ─────────────────────────────────────────────────────────────────────────────

export class TransformManager {
  private bridge: ROSBridge | null = null
  private config: TransformManagerConfig

  // Cache: Map<"parent->child", Array<CachedTransform>>
  private transformCache: Map<string, CachedTransform[]> = new Map()
  private staticTransforms: Map<string, CachedTransform> = new Map()

  // Frame tree: Map<child, parent>
  private frameTree: Map<string, string> = new Map()

  private unsubscribes: Array<() => void> = []
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null

  constructor(config: Partial<TransformManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Start the transform manager
   */
  start(bridge: ROSBridge): void {
    if (this.bridge) {
      this.stop()
    }

    this.bridge = bridge

    // Subscribe to /tf (dynamic transforms)
    const unsubTF = bridge.subscribe<TFMessage>(
      '/tf',
      'tf2_msgs/TFMessage',
      (msg) => this.handleTFMessage(msg, false),
      this.config.throttleRateMs
    )
    this.unsubscribes.push(unsubTF)

    // Subscribe to /tf_static (static transforms)
    const unsubTFStatic = bridge.subscribe<TFMessage>(
      '/tf_static',
      'tf2_msgs/TFMessage',
      (msg) => this.handleTFMessage(msg, true)
    )
    this.unsubscribes.push(unsubTFStatic)

    // Start cache cleanup interval
    this.cleanupIntervalId = setInterval(
      () => this.cleanupCache(),
      this.config.cacheDurationMs / 2
    )
  }

  /**
   * Stop the transform manager
   */
  stop(): void {
    for (const unsub of this.unsubscribes) {
      unsub()
    }
    this.unsubscribes = []

    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId)
      this.cleanupIntervalId = null
    }

    this.transformCache.clear()
    this.staticTransforms.clear()
    this.frameTree.clear()
    this.bridge = null
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TF MESSAGE HANDLING
  // ───────────────────────────────────────────────────────────────────────────

  private handleTFMessage(msg: TFMessage, isStatic: boolean): void {
    const receivedAtMs = Date.now()

    for (const tf of msg.transforms) {
      const key = this.makeKey(tf.header.frame_id, tf.child_frame_id)

      // Update frame tree
      this.frameTree.set(tf.child_frame_id, tf.header.frame_id)

      const cached: CachedTransform = {
        transform: tf,
        stampMs: timeToDate(tf.header.stamp).getTime(),
        receivedAtMs,
        isStatic,
      }

      if (isStatic) {
        // Static transforms are stored separately and never expire
        this.staticTransforms.set(key, cached)
      } else {
        // Dynamic transforms are cached with history for interpolation
        let cache = this.transformCache.get(key)
        if (!cache) {
          cache = []
          this.transformCache.set(key, cache)
        }

        cache.push(cached)

        // Limit cache size
        if (cache.length > this.config.maxCacheSize) {
          cache.shift()
        }
      }
    }
  }

  private makeKey(parent: string, child: string): string {
    return `${parent}->${child}`
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TRANSFORM LOOKUP
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Look up transform from source frame to target frame
   * Uses cached transforms, falls back to frame tree traversal
   */
  lookupTransform(
    targetFrame: string,
    sourceFrame: string,
    time?: Time
  ): TransformLookupResult {
    // Same frame - identity transform
    if (targetFrame === sourceFrame) {
      return {
        transform: {
          translation: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
        timestamp: time || createTime(),
        valid: true,
      }
    }

    // Try direct lookup
    const direct = this.getDirectTransform(targetFrame, sourceFrame, time)
    if (direct) {
      return {
        transform: direct.transform.transform,
        timestamp: direct.transform.header.stamp,
        valid: true,
      }
    }

    // Try inverse lookup
    const inverse = this.getDirectTransform(sourceFrame, targetFrame, time)
    if (inverse) {
      return {
        transform: this.invertTransform(inverse.transform.transform),
        timestamp: inverse.transform.header.stamp,
        valid: true,
      }
    }

    // Try frame tree traversal
    const chain = this.findTransformChain(targetFrame, sourceFrame)
    if (chain) {
      const combined = this.combineTransformChain(chain, time)
      if (combined) {
        return combined
      }
    }

    return {
      transform: {
        translation: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
      },
      timestamp: time || createTime(),
      valid: false,
      error: `No transform from ${sourceFrame} to ${targetFrame}`,
    }
  }

  /**
   * Get direct transform between parent and child
   */
  private getDirectTransform(
    parent: string,
    child: string,
    time?: Time
  ): CachedTransform | null {
    const key = this.makeKey(parent, child)

    // Check static transforms first
    const staticTf = this.staticTransforms.get(key)
    if (staticTf) {
      return staticTf
    }

    // Check dynamic transform cache
    const cache = this.transformCache.get(key)
    if (!cache || cache.length === 0) {
      return null
    }

    if (!time) {
      // Return most recent
      return cache[cache.length - 1]
    }

    // Find the transform whose own header stamp is closest to the requested
    // time — comparing against ROS time keeps sim-time lookups meaningful.
    const targetMs = timeToDate(time).getTime()
    let closest = cache[0]
    let minDiff = Math.abs(closest.stampMs - targetMs)

    for (let i = 1; i < cache.length; i++) {
      const diff = Math.abs(cache[i].stampMs - targetMs)
      if (diff < minDiff) {
        minDiff = diff
        closest = cache[i]
      }
    }

    return closest
  }

  /**
   * Find chain of transforms from source to target via frame tree
   */
  private findTransformChain(
    target: string,
    source: string
  ): Array<{ parent: string; child: string; inverse: boolean }> | null {
    // BFS from source to target
    const visited = new Set<string>()
    const queue: Array<{ frame: string; path: Array<{ parent: string; child: string; inverse: boolean }> }> = [
      { frame: source, path: [] }
    ]

    while (queue.length > 0) {
      const { frame, path } = queue.shift()!

      if (frame === target) {
        return path
      }

      if (visited.has(frame)) continue
      visited.add(frame)

      // Going up (we walk child -> parent). The stored `parent->child`
      // transform already maps child-frame coords -> parent-frame coords, which
      // is exactly the direction we travel, so it is used as-is (NOT inverted).
      const parent = this.frameTree.get(frame)
      if (parent && !visited.has(parent)) {
        queue.push({
          frame: parent,
          path: [...path, { parent, child: frame, inverse: false }],
        })
      }

      // Going down (we walk parent -> child). The stored `parent->child`
      // transform maps child -> parent, the opposite of our travel direction,
      // so it must be inverted.
      for (const [child, p] of this.frameTree) {
        if (p === frame && !visited.has(child)) {
          queue.push({
            frame: child,
            path: [...path, { parent: frame, child, inverse: true }],
          })
        }
      }
    }

    return null
  }

  /**
   * Combine a chain of transforms
   */
  private combineTransformChain(
    chain: Array<{ parent: string; child: string; inverse: boolean }>,
    time?: Time
  ): TransformLookupResult | null {
    let result: Transform = {
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    }

    for (const link of chain) {
      const tf = this.getDirectTransform(link.parent, link.child, time)
      if (!tf) return null

      let transform = tf.transform.transform
      if (link.inverse) {
        transform = this.invertTransform(transform)
      }

      // The chain is ordered source -> ... -> target. We need
      // T_target_source = step_n ∘ … ∘ step_1 ∘ step_0 with the source-side step
      // applied FIRST. composeTransforms(A, B) applies B before A, so the newest
      // (target-ward) step goes on the LEFT.
      result = this.composeTransforms(transform, result)
    }

    return {
      transform: result,
      timestamp: time || createTime(),
      valid: true,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TRANSFORM OPERATIONS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Invert a transform
   */
  private invertTransform(tf: Transform): Transform {
    const invRotation = inverseQuaternion(tf.rotation)
    const invTranslation = rotateVectorByQuaternion(
      { x: -tf.translation.x, y: -tf.translation.y, z: -tf.translation.z },
      invRotation
    )

    return {
      translation: invTranslation,
      rotation: invRotation,
    }
  }

  /**
   * Compose two transforms: result = tf1 * tf2
   */
  private composeTransforms(tf1: Transform, tf2: Transform): Transform {
    // Combined rotation
    const rotation = multiplyQuaternions(tf1.rotation, tf2.rotation)

    // Combined translation: tf1.translation + tf1.rotation * tf2.translation
    const rotatedTranslation = rotateVectorByQuaternion(tf2.translation, tf1.rotation)
    const translation = {
      x: tf1.translation.x + rotatedTranslation.x,
      y: tf1.translation.y + rotatedTranslation.y,
      z: tf1.translation.z + rotatedTranslation.z,
    }

    return { translation, rotation }
  }

  /**
   * Transform a point from source frame to target frame
   */
  transformPoint(
    point: Point,
    targetFrame: string,
    sourceFrame: string,
    time?: Time
  ): Point | null {
    const lookup = this.lookupTransform(targetFrame, sourceFrame, time)
    if (!lookup.valid) return null

    const tf = lookup.transform
    const rotated = rotateVectorByQuaternion(point, tf.rotation)

    return {
      x: rotated.x + tf.translation.x,
      y: rotated.y + tf.translation.y,
      z: rotated.z + tf.translation.z,
    }
  }

  /**
   * Transform a vector from source frame to target frame (rotation only)
   */
  transformVector(
    vector: Vector3,
    targetFrame: string,
    sourceFrame: string,
    time?: Time
  ): Vector3 | null {
    const lookup = this.lookupTransform(targetFrame, sourceFrame, time)
    if (!lookup.valid) return null

    return rotateVectorByQuaternion(vector, lookup.transform.rotation)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CACHE MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  private cleanupCache(): void {
    const now = Date.now()
    const expiry = now - this.config.cacheDurationMs

    for (const [key, cache] of this.transformCache) {
      // Expire by wall-clock arrival time, never by header stamp, so sim-time
      // transforms (whose stamps lag wall time) are not evicted prematurely.
      const filtered = cache.filter(tf => tf.receivedAtMs > expiry)

      if (filtered.length === 0) {
        this.transformCache.delete(key)
      } else if (filtered.length !== cache.length) {
        this.transformCache.set(key, filtered)
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ACCESSORS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Get all known frames
   */
  getKnownFrames(): string[] {
    const frames = new Set<string>()

    for (const [child, parent] of this.frameTree) {
      frames.add(child)
      frames.add(parent)
    }

    return Array.from(frames)
  }

  /**
   * Get parent frame for a given frame
   */
  getParentFrame(frame: string): string | null {
    return this.frameTree.get(frame) || null
  }

  /**
   * Check if a frame is known
   */
  hasFrame(frame: string): boolean {
    return this.frameTree.has(frame) || Array.from(this.frameTree.values()).includes(frame)
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    dynamicTransforms: number
    staticTransforms: number
    knownFrames: number
  } {
    let dynamicCount = 0
    for (const cache of this.transformCache.values()) {
      dynamicCount += cache.length
    }

    return {
      dynamicTransforms: dynamicCount,
      staticTransforms: this.staticTransforms.size,
      knownFrames: this.getKnownFrames().length,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

let instance: TransformManager | null = null

export function getTransformManager(): TransformManager {
  if (!instance) {
    instance = new TransformManager()
  }
  return instance
}

export function createTransformManager(
  config?: Partial<TransformManagerConfig>
): TransformManager {
  return new TransformManager(config)
}
