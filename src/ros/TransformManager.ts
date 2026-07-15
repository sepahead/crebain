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
  Quaternion,
} from './types'
import { createTime } from './types'
import {
  multiplyQuaternions,
  inverseQuaternion,
  rotateVectorByQuaternion,
} from '../lib/mathUtils'
import {
  isValidTfFrameId,
  normalizeComputedTfQuaternion,
  normalizeComputedTfTransform,
  normalizeIngressTransformStamped,
} from './tfValidation'

// Re-export TFMessage for convenience
export type { TFMessage }

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface CachedTransform {
  transform: TransformStamped
  /** Exact ROS header stamp — index for time-based lookups. */
  stampNanoseconds: bigint
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

interface TransformTimeRange {
  earliestNanoseconds: bigint
  latestNanoseconds: bigint
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

    for (const incomingTf of msg.transforms) {
      // Apply the same reject-then-normalize policy used by ROSBridge. Keeping
      // this check here protects direct/native ingestion and test harnesses too.
      const tf = normalizeIngressTransformStamped(incomingTf)
      if (!tf) continue
      const stampNanoseconds = this.timeToNanoseconds(tf.header.stamp)
      if (stampNanoseconds === null) continue
      const key = this.makeKey(tf.header.frame_id, tf.child_frame_id)

      // Update frame tree
      this.frameTree.set(tf.child_frame_id, tf.header.frame_id)

      const cached: CachedTransform = {
        transform: tf,
        stampNanoseconds,
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

        // ROS delivery is not guaranteed to be timestamp ordered. Keep each
        // edge ordered by its sensor stamp so interpolation and common-time
        // lookup do not depend on arrival order. A repeated stamp replaces the
        // older sample instead of making selection ambiguous.
        const duplicateIndex = cache.findIndex(
          (candidate) => candidate.stampNanoseconds === cached.stampNanoseconds
        )
        if (duplicateIndex >= 0) {
          cache[duplicateIndex] = cached
        } else {
          const insertionIndex = cache.findIndex(
            (candidate) => candidate.stampNanoseconds > cached.stampNanoseconds
          )
          if (insertionIndex < 0) {
            cache.push(cached)
          } else {
            cache.splice(insertionIndex, 0, cached)
          }
        }

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
    if (!isValidTfFrameId(targetFrame) || !isValidTfFrameId(sourceFrame)) {
      return {
        transform: {
          translation: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
        timestamp: time || createTime(),
        valid: false,
        error: 'Invalid or empty TF frame ID',
      }
    }

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
        timestamp: time || direct.transform.header.stamp,
        valid: true,
      }
    }

    // Try inverse lookup
    const inverse = this.getDirectTransform(sourceFrame, targetFrame, time)
    if (inverse) {
      const inverted = this.invertTransform(inverse.transform.transform)
      if (inverted) {
        return {
          transform: inverted,
          timestamp: time || inverse.transform.header.stamp,
          valid: true,
        }
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
      error:
        `No temporally coherent transform from ${sourceFrame} to ${targetFrame}` +
        (time ? ' at the requested ROS time (dynamic extrapolation is disabled)' : ''),
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

    // Explicit-time lookups interpolate only between samples that bracket the
    // requested ROS time. There is deliberately no forward or backward
    // extrapolation: returning a nearest sample would silently label stale or
    // future geometry as if it existed at the requested instant.
    const targetNanoseconds = this.timeToNanoseconds(time)
    if (targetNanoseconds === null) return null

    const exact = cache.find(
      (candidate) => candidate.stampNanoseconds === targetNanoseconds
    )
    if (exact) return exact

    const upperIndex = cache.findIndex(
      (candidate) => candidate.stampNanoseconds > targetNanoseconds
    )
    if (upperIndex <= 0) {
      return null
    }

    const before = cache[upperIndex - 1]
    const after = cache[upperIndex]
    const intervalNanoseconds = after.stampNanoseconds - before.stampNanoseconds
    if (intervalNanoseconds <= 0n) return null

    const alpha =
      Number(targetNanoseconds - before.stampNanoseconds) / Number(intervalNanoseconds)
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null
    const interpolated = this.interpolateTransform(
      before.transform.transform,
      after.transform.transform,
      alpha
    )
    if (!interpolated) return null
    return {
      transform: {
        ...before.transform,
        header: {
          ...before.transform.header,
          stamp: time,
        },
        transform: interpolated,
      },
      stampNanoseconds: targetNanoseconds,
      receivedAtMs: Math.max(before.receivedAtMs, after.receivedAtMs),
      isStatic: false,
    }
  }

  private getDynamicTimeRange(parent: string, child: string): TransformTimeRange | null {
    if (this.staticTransforms.has(this.makeKey(parent, child))) return null
    const cache = this.transformCache.get(this.makeKey(parent, child))
    if (!cache || cache.length === 0) return null
    return {
      earliestNanoseconds: cache[0].stampNanoseconds,
      latestNanoseconds: cache[cache.length - 1].stampNanoseconds,
    }
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
    let evaluationTime = time
    if (!evaluationTime) {
      // "Latest" for a multi-hop chain means the latest instant contained in
      // every dynamic edge's history. Selecting each edge's independent latest
      // sample produces a transform that never existed at one coherent time.
      const ranges = chain
        .map((link) => this.getDynamicTimeRange(link.parent, link.child))
        .filter((range): range is TransformTimeRange => range !== null)

      if (ranges.length > 0) {
        const earliestCommonNanoseconds = ranges.reduce(
          (latest, range) =>
            range.earliestNanoseconds > latest ? range.earliestNanoseconds : latest,
          ranges[0].earliestNanoseconds
        )
        const latestCommonNanoseconds = ranges.reduce(
          (earliest, range) =>
            range.latestNanoseconds < earliest ? range.latestNanoseconds : earliest,
          ranges[0].latestNanoseconds
        )
        if (latestCommonNanoseconds < earliestCommonNanoseconds) return null
        evaluationTime = this.nanosecondsToTime(latestCommonNanoseconds)
      }
    }

    let result: Transform = {
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    }

    for (const link of chain) {
      const tf = this.getDirectTransform(link.parent, link.child, evaluationTime)
      if (!tf) return null

      let transform = tf.transform.transform
      if (link.inverse) {
        const inverted = this.invertTransform(transform)
        if (!inverted) return null
        transform = inverted
      }

      // The chain is ordered source -> ... -> target. We need
      // T_target_source = step_n ∘ … ∘ step_1 ∘ step_0 with the source-side step
      // applied FIRST. composeTransforms(A, B) applies B before A, so the newest
      // (target-ward) step goes on the LEFT.
      const composed = this.composeTransforms(transform, result)
      if (!composed) return null
      result = composed
    }

    return {
      transform: result,
      timestamp: evaluationTime || createTime(),
      valid: true,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TRANSFORM OPERATIONS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Invert a transform
   */
  private invertTransform(tf: Transform): Transform | null {
    const normalized = normalizeComputedTfTransform(tf)
    if (!normalized) return null
    const invRotation = inverseQuaternion(normalized.rotation)
    const invTranslation = rotateVectorByQuaternion(
      {
        x: -normalized.translation.x,
        y: -normalized.translation.y,
        z: -normalized.translation.z,
      },
      invRotation
    )

    return normalizeComputedTfTransform({
      translation: invTranslation,
      rotation: invRotation,
    })
  }

  /**
   * Compose two transforms: result = tf1 * tf2
   */
  private composeTransforms(tf1: Transform, tf2: Transform): Transform | null {
    const first = normalizeComputedTfTransform(tf1)
    const second = normalizeComputedTfTransform(tf2)
    if (!first || !second) return null

    // Combined rotation
    const rotation = multiplyQuaternions(first.rotation, second.rotation)

    // Combined translation: tf1.translation + tf1.rotation * tf2.translation
    const rotatedTranslation = rotateVectorByQuaternion(second.translation, first.rotation)
    const translation = {
      x: first.translation.x + rotatedTranslation.x,
      y: first.translation.y + rotatedTranslation.y,
      z: first.translation.z + rotatedTranslation.z,
    }

    return normalizeComputedTfTransform({ translation, rotation })
  }

  private interpolateTransform(
    before: Transform,
    after: Transform,
    alpha: number
  ): Transform | null {
    const rotation = this.slerpQuaternion(before.rotation, after.rotation, alpha)
    if (!rotation) return null
    return normalizeComputedTfTransform({
      translation: {
        x: before.translation.x + (after.translation.x - before.translation.x) * alpha,
        y: before.translation.y + (after.translation.y - before.translation.y) * alpha,
        z: before.translation.z + (after.translation.z - before.translation.z) * alpha,
      },
      rotation,
    })
  }

  private slerpQuaternion(
    before: Quaternion,
    after: Quaternion,
    alpha: number
  ): Quaternion | null {
    const start = normalizeComputedTfQuaternion(before)
    const normalizedEnd = normalizeComputedTfQuaternion(after)
    if (!start || !normalizedEnd || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null
    let end = normalizedEnd
    let dot = start.x * end.x + start.y * end.y + start.z * end.z + start.w * end.w

    // q and -q represent the same rotation; choose the shortest arc.
    if (dot < 0) {
      dot = -dot
      end = { x: -end.x, y: -end.y, z: -end.z, w: -end.w }
    }

    if (dot > 0.9995) {
      return normalizeComputedTfQuaternion({
        x: start.x + alpha * (end.x - start.x),
        y: start.y + alpha * (end.y - start.y),
        z: start.z + alpha * (end.z - start.z),
        w: start.w + alpha * (end.w - start.w),
      })
    }

    const theta = Math.acos(Math.min(1, Math.max(-1, dot)))
    const sinTheta = Math.sin(theta)
    if (!(sinTheta > 0) || !Number.isFinite(sinTheta)) return null
    const startWeight = Math.sin((1 - alpha) * theta) / sinTheta
    const endWeight = Math.sin(alpha * theta) / sinTheta
    return normalizeComputedTfQuaternion({
      x: start.x * startWeight + end.x * endWeight,
      y: start.y * startWeight + end.y * endWeight,
      z: start.z * startWeight + end.z * endWeight,
      w: start.w * startWeight + end.w * endWeight,
    })
  }

  private timeToNanoseconds(time: Time): bigint | null {
    if (
      !Number.isSafeInteger(time.secs) ||
      time.secs < 0 ||
      !Number.isSafeInteger(time.nsecs) ||
      time.nsecs < 0 ||
      time.nsecs >= 1_000_000_000
    ) {
      return null
    }
    return BigInt(time.secs) * 1_000_000_000n + BigInt(time.nsecs)
  }

  private nanosecondsToTime(nanoseconds: bigint): Time {
    const seconds = nanoseconds / 1_000_000_000n
    return {
      secs: Number(seconds),
      nsecs: Number(nanoseconds % 1_000_000_000n),
    }
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
    if (![point.x, point.y, point.z].every(Number.isFinite)) return null
    const lookup = this.lookupTransform(targetFrame, sourceFrame, time)
    if (!lookup.valid) return null

    const tf = lookup.transform
    const rotated = rotateVectorByQuaternion(point, tf.rotation)

    const result = {
      x: rotated.x + tf.translation.x,
      y: rotated.y + tf.translation.y,
      z: rotated.z + tf.translation.z,
    }
    return [result.x, result.y, result.z].every(Number.isFinite) ? result : null
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
    if (![vector.x, vector.y, vector.z].every(Number.isFinite)) return null
    const lookup = this.lookupTransform(targetFrame, sourceFrame, time)
    if (!lookup.valid) return null

    const result = rotateVectorByQuaternion(vector, lookup.transform.rotation)
    return [result.x, result.y, result.z].every(Number.isFinite) ? result : null
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
