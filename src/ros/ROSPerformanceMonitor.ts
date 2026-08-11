/**
 * CREBAIN ROS Performance Monitor
 * Adaptive Response & Awareness System (ARAS)
 *
 * Tracks message latency, throughput, and connection quality
 * Provides automatic degradation detection
 */

import { CircularBuffer } from '../lib/CircularBuffer'
import { rosLogger as log } from '../lib/logger'
import { isValidRosGraphName, MAX_ROS_GRAPH_NAME_LENGTH } from './rosNameValidation'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface LatencySample {
  topic: string
  latencyMs: number
  timestamp: number
}

export interface ThroughputSample {
  topic: string
  messagesPerSecond: number
  bytesPerSecond: number
  timestamp: number
}

interface MessageSample {
  byteCount: number
  timestamp: number
}

export interface TopicStats {
  topic: string
  /** Messages since construction/reset while the bounded monitor retains this topic. */
  messageCount: number
  /** Bytes since construction/reset while the bounded monitor retains this topic. */
  byteCount: number
  /** Messages retained in the current rolling window. */
  windowMessageCount: number
  /** Bytes retained in the current rolling window. */
  windowByteCount: number
  lastReceived: number
  avgLatencyMs: number
  minLatencyMs: number
  maxLatencyMs: number
  p95LatencyMs: number
  messagesPerSecond: number
  bytesPerSecond: number
}

export interface ConnectionQuality {
  /** Overall quality score 0-100 */
  score: number
  /** Quality level */
  level: 'excellent' | 'good' | 'fair' | 'poor' | 'critical'
  /** Average latency across all topics */
  avgLatencyMs: number
  /** Total message throughput */
  totalMessagesPerSecond: number
  /** Number of dropped messages (estimated) */
  droppedMessages: number
  /** Connection uptime in seconds */
  uptimeSeconds: number
}

export interface PerformanceAlert {
  type: 'high_latency' | 'low_throughput' | 'message_gap' | 'connection_degraded'
  topic?: string
  message: string
  severity: 'warning' | 'error'
  /** Monotonic milliseconds from the browser performance time origin. */
  timestamp: number
}

export interface PerformanceConfig {
  /** Window size for rolling statistics in ms (default: 5000) */
  windowSizeMs: number
  /** High latency threshold in ms (default: 100) */
  highLatencyThresholdMs: number
  /** Message gap threshold in ms (default: 1000) */
  messageGapThresholdMs: number
  /** Minimum expected messages per second (default: 1) */
  minMessagesPerSecond: number
  /** Maximum samples to keep per topic (default: 1000) */
  maxSamplesPerTopic: number
}

export type AlertCallback = (alert: PerformanceAlert) => void

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PerformanceConfig = {
  windowSizeMs: 5000,
  highLatencyThresholdMs: 100,
  messageGapThresholdMs: 1000,
  minMessagesPerSecond: 1,
  maxSamplesPerTopic: 1000,
}

/** Matches the transport-wide ROS subscription ceiling. */
export const MAX_PERFORMANCE_TOPICS = 1_024
/** Bounds allocation when callers customize the rolling history. */
export const MAX_PERFORMANCE_SAMPLES_PER_TOPIC = 10_000
/** Caps preallocated slots across latency and message buffers. */
export const MAX_PERFORMANCE_SAMPLE_SLOTS = 1_024_000
/** Accommodates the largest renderer transport envelope with bounded headroom. */
export const MAX_PERFORMANCE_MESSAGE_BYTES = 128 * 1024 * 1024
/** Samples above one day are not actionable transport latency measurements. */
export const MAX_PERFORMANCE_LATENCY_MS = 24 * 60 * 60 * 1_000
export const MAX_PERFORMANCE_WINDOW_MS = MAX_PERFORMANCE_LATENCY_MS
export const MAX_PERFORMANCE_MESSAGES_PER_SECOND = 1_000_000
export const MAX_PERFORMANCE_TOPIC_LENGTH = MAX_ROS_GRAPH_NAME_LENGTH
/** Prevent one noisy topic from driving UI work at transport message rate. */
export const PERFORMANCE_ALERT_COOLDOWN_MS = 5_000
/** Bound periodic callback work while still rotating through stale topics. */
export const MAX_PERFORMANCE_ALERTS_PER_CHECK = 32

function isValidPerformanceTopic(topic: string): boolean {
  return isValidRosGraphName(topic)
}

function validatePerformanceConfig(config: PerformanceConfig): PerformanceConfig {
  if (
    !Number.isSafeInteger(config.windowSizeMs) ||
    config.windowSizeMs <= 0 ||
    config.windowSizeMs > MAX_PERFORMANCE_WINDOW_MS
  ) {
    throw new Error(
      `Performance window size must be an integer from 1 to ${MAX_PERFORMANCE_WINDOW_MS}`
    )
  }
  if (
    !Number.isSafeInteger(config.messageGapThresholdMs) ||
    config.messageGapThresholdMs < 0 ||
    config.messageGapThresholdMs > MAX_PERFORMANCE_WINDOW_MS
  ) {
    throw new Error(
      `Message gap threshold must be an integer from 0 to ${MAX_PERFORMANCE_WINDOW_MS}`
    )
  }
  if (
    !Number.isFinite(config.highLatencyThresholdMs) ||
    config.highLatencyThresholdMs < 0 ||
    config.highLatencyThresholdMs > MAX_PERFORMANCE_LATENCY_MS
  ) {
    throw new Error(
      `High latency threshold must be between 0 and ${MAX_PERFORMANCE_LATENCY_MS} milliseconds`
    )
  }
  if (
    !Number.isFinite(config.minMessagesPerSecond) ||
    config.minMessagesPerSecond < 0 ||
    config.minMessagesPerSecond > MAX_PERFORMANCE_MESSAGES_PER_SECOND
  ) {
    throw new Error(
      `Minimum message rate must be between 0 and ${MAX_PERFORMANCE_MESSAGES_PER_SECOND}`
    )
  }
  if (
    !Number.isSafeInteger(config.maxSamplesPerTopic) ||
    config.maxSamplesPerTopic <= 0 ||
    config.maxSamplesPerTopic > MAX_PERFORMANCE_SAMPLES_PER_TOPIC
  ) {
    throw new Error(
      `Maximum samples per topic must be an integer from 1 to ${MAX_PERFORMANCE_SAMPLES_PER_TOPIC}`
    )
  }
  return Object.freeze({ ...config })
}

// ─────────────────────────────────────────────────────────────────────────────
// PERFORMANCE MONITOR
// ─────────────────────────────────────────────────────────────────────────────

export class ROSPerformanceMonitor {
  private config: PerformanceConfig
  private topicLatencies: Map<string, CircularBuffer<LatencySample>> = new Map()
  private topicMessageSamples: Map<string, CircularBuffer<MessageSample>> = new Map()
  private topicLifetimeMessageCounts: Map<string, number> = new Map()
  private topicLifetimeByteCounts: Map<string, number> = new Map()
  private topicLastReceived: Map<string, number> = new Map()
  private topicLastObserved: Map<string, number> = new Map()
  private trackedTopics: Set<string> = new Set()
  private allocatedSampleSlots = 0
  private alertCallbacks: Set<AlertCallback> = new Set()
  private lastAlertAt: Map<string, number> = new Map()
  private lowThroughputScanCursor = 0
  private lastObservedTime: number = performance.now()
  private statisticsStartTime: number = this.lastObservedTime
  private accumulatedUptimeMs = 0
  private runningSince: number | null = null
  private droppedMessages: number = 0
  private updateIntervalId: ReturnType<typeof setInterval> | null = null

  constructor(config: Partial<PerformanceConfig> = {}) {
    this.config = validatePerformanceConfig({ ...DEFAULT_CONFIG, ...config })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Start the performance monitor
   */
  start(): void {
    if (this.updateIntervalId !== null) return

    this.runningSince = this.now()

    // Start periodic stats calculation and alert checking
    this.updateIntervalId = setInterval(() => {
      this.checkForAlerts()
    }, 1000)
  }

  /**
   * Stop the performance monitor
   */
  stop(): void {
    if (this.updateIntervalId !== null) {
      clearInterval(this.updateIntervalId)
      this.updateIntervalId = null
      if (this.runningSince !== null) {
        this.accumulatedUptimeMs += this.now() - this.runningSince
        this.runningSince = null
      }
    }
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.topicLatencies.clear()
    this.topicMessageSamples.clear()
    this.topicLifetimeMessageCounts.clear()
    this.topicLifetimeByteCounts.clear()
    this.topicLastReceived.clear()
    this.topicLastObserved.clear()
    this.trackedTopics.clear()
    this.lastAlertAt.clear()
    this.lowThroughputScanCursor = 0
    this.allocatedSampleSlots = 0
    this.droppedMessages = 0
    const now = this.now()
    this.statisticsStartTime = now
    this.accumulatedUptimeMs = 0
    this.runningSince = this.updateIntervalId === null ? null : now
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DATA RECORDING
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Record a received message. `sentTimestamp` is an epoch-millisecond clock
   * reading comparable to Date.now(); callers with an already measured
   * duration must use recordLatency().
   */
  recordMessage(topic: string, messageSize: number, sentTimestamp?: number): void {
    if (
      !isValidPerformanceTopic(topic) ||
      !Number.isSafeInteger(messageSize) ||
      messageSize < 0 ||
      messageSize > MAX_PERFORMANCE_MESSAGE_BYTES
    ) {
      return
    }

    const wallTime = Date.now()
    const now = this.now()
    this.trackTopic(topic, now)
    const messageBuffer = this.getOrCreateBuffer(this.topicMessageSamples, topic)
    if (!messageBuffer) return

    // Update message count
    const count = this.topicLifetimeMessageCounts.get(topic) || 0
    const nextCount = count + 1

    // Update byte count
    const bytes = this.topicLifetimeByteCounts.get(topic) || 0
    const nextBytes = bytes + messageSize
    if (!Number.isSafeInteger(nextCount) || !Number.isSafeInteger(nextBytes)) return
    this.topicLifetimeMessageCounts.set(topic, nextCount)
    this.topicLifetimeByteCounts.set(topic, nextBytes)

    messageBuffer.push({ byteCount: messageSize, timestamp: now })

    // Check for message gap
    const lastReceived = this.topicLastReceived.get(topic)
    if (lastReceived !== undefined && now - lastReceived > this.config.messageGapThresholdMs) {
      this.droppedMessages = Math.min(Number.MAX_SAFE_INTEGER, this.droppedMessages + 1)
      this.emitAlert({
        type: 'message_gap',
        topic,
        message: `Message gap of ${now - lastReceived}ms detected on ${topic}`,
        severity: 'warning',
        timestamp: now,
      })
    }
    this.topicLastReceived.set(topic, now)

    // This low-level API accepts an epoch timestamp. Public adapters that
    // already measured a latency must call recordLatency() instead.
    if (
      sentTimestamp !== undefined &&
      Number.isFinite(sentTimestamp) &&
      sentTimestamp >= 0 &&
      sentTimestamp <= wallTime &&
      wallTime - sentTimestamp <= MAX_PERFORMANCE_LATENCY_MS
    ) {
      this.recordLatencySample(topic, wallTime - sentTimestamp, now)
    }
  }

  /**
   * Record a latency sample directly
   */
  recordLatency(topic: string, latencyMs: number): void {
    if (
      !isValidPerformanceTopic(topic) ||
      !Number.isFinite(latencyMs) ||
      latencyMs < 0 ||
      latencyMs > MAX_PERFORMANCE_LATENCY_MS
    ) {
      return
    }
    const now = this.now()
    this.trackTopic(topic, now)
    this.recordLatencySample(topic, latencyMs, now)
  }

  private recordLatencySample(topic: string, latencyMs: number, now: number): void {
    const buffer = this.getOrCreateBuffer(this.topicLatencies, topic)
    if (!buffer) return

    buffer.push({
      topic,
      latencyMs,
      timestamp: now,
    })

    if (latencyMs > this.config.highLatencyThresholdMs) {
      this.emitAlert({
        type: 'high_latency',
        topic,
        message: `High latency ${latencyMs.toFixed(1)}ms on ${topic}`,
        severity: latencyMs > this.config.highLatencyThresholdMs * 2 ? 'error' : 'warning',
        timestamp: now,
      })
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STATISTICS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Get statistics for a specific topic
   */
  getTopicStats(topic: string): TopicStats | null {
    return this.getTopicStatsAt(topic, this.now())
  }

  private getTopicStatsAt(topic: string, now: number): TopicStats | null {
    const messageCount = this.topicLifetimeMessageCounts.get(topic) || 0
    const byteCount = this.topicLifetimeByteCounts.get(topic) || 0
    const lastReceived = this.topicLastReceived.get(topic) || 0
    const latencyBuffer = this.topicLatencies.get(topic)
    const messageBuffer = this.topicMessageSamples.get(topic)

    if (messageCount === 0) return null

    const cutoff = now - this.config.windowSizeMs
    const messageSamples = messageBuffer?.filter((sample) => sample.timestamp >= cutoff) ?? []
    const windowMessageCount = messageSamples.length
    const windowByteCount = messageSamples.reduce((sum, sample) => sum + sample.byteCount, 0)
    // Before one complete window has elapsed, divide by the observed duration;
    // afterwards use the fixed configured window. Keep a positive denominator at
    // startup without stretching a sub-second configured window.
    const elapsedMs = Math.max(0, now - this.statisticsStartTime)
    const windowDurationMs = Math.min(this.config.windowSizeMs, Math.max(1, elapsedMs))
    const windowDurationSeconds = windowDurationMs / 1000

    // Calculate latency stats
    let avgLatencyMs = 0
    let minLatencyMs = Infinity
    let maxLatencyMs = 0
    let p95LatencyMs = 0

    if (latencyBuffer && latencyBuffer.length > 0) {
      const latencies = latencyBuffer
        .filter((sample) => sample.timestamp >= cutoff)
        .map((sample) => sample.latencyMs)

      if (latencies.length > 0) {
        latencies.sort((a, b) => a - b)
        minLatencyMs = latencies[0]
        maxLatencyMs = latencies[latencies.length - 1]
        avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length
        const nearestRankIndex = Math.ceil(latencies.length * 0.95) - 1
        p95LatencyMs = latencies[nearestRankIndex]
      }
    }

    return {
      topic,
      messageCount,
      byteCount,
      windowMessageCount,
      windowByteCount,
      lastReceived,
      avgLatencyMs,
      minLatencyMs: minLatencyMs === Infinity ? 0 : minLatencyMs,
      maxLatencyMs,
      p95LatencyMs,
      messagesPerSecond: windowMessageCount / windowDurationSeconds,
      bytesPerSecond: windowByteCount / windowDurationSeconds,
    }
  }

  /**
   * Get statistics for all topics
   */
  getAllTopicStats(): TopicStats[] {
    return this.getAllTopicStatsAt(this.now())
  }

  private getAllTopicStatsAt(now: number): TopicStats[] {
    const topics = new Set<string>([
      ...this.topicLifetimeMessageCounts.keys(),
      ...this.topicLatencies.keys(),
    ])

    const stats: TopicStats[] = []
    for (const topic of topics) {
      const topicStats = this.getTopicStatsAt(topic, now)
      if (topicStats) {
        stats.push(topicStats)
      }
    }

    return stats
  }

  /**
   * Get overall connection quality
   */
  getConnectionQuality(): ConnectionQuality {
    const now = this.now()
    return this.getConnectionQualityAt(this.getAllTopicStatsAt(now), now)
  }

  getPerformanceSnapshot(): {
    quality: ConnectionQuality
    topicStats: TopicStats[]
  } {
    const now = this.now()
    const topicStats = this.getAllTopicStatsAt(now)
    return {
      quality: this.getConnectionQualityAt(topicStats, now),
      topicStats,
    }
  }

  private getConnectionQualityAt(stats: TopicStats[], now: number): ConnectionQuality {
    const uptimeSeconds = this.uptimeMsAt(now) / 1000

    if (stats.length === 0) {
      return {
        score: 0,
        level: 'critical',
        avgLatencyMs: 0,
        totalMessagesPerSecond: 0,
        droppedMessages: this.droppedMessages,
        uptimeSeconds,
      }
    }

    // Calculate averages
    const avgLatencyMs = stats.reduce((sum, s) => sum + s.avgLatencyMs, 0) / stats.length
    const totalMessagesPerSecond = stats.reduce((sum, s) => sum + s.messagesPerSecond, 0)

    // Calculate quality score (0-100)
    let score = 100

    // Latency penalty (up to -40 points)
    if (avgLatencyMs > 10) {
      score -= Math.min(40, (avgLatencyMs - 10) / 2)
    }

    // Throughput penalty (up to -30 points)
    const expectedMps = this.config.minMessagesPerSecond * stats.length
    if (expectedMps > 0 && totalMessagesPerSecond < expectedMps) {
      score -= Math.min(30, (1 - totalMessagesPerSecond / expectedMps) * 30)
    }

    // A topic with no message in the complete rolling window is stale even when
    // its lifetime average was once high. Penalize that condition separately so
    // a fully frozen connection cannot remain "good".
    const staleTopicCount = stats.filter(
      (stat) => now - stat.lastReceived >= this.config.windowSizeMs
    ).length
    if (staleTopicCount > 0) {
      score -= (staleTopicCount / stats.length) * 50
    }

    // Dropped message penalty (up to -30 points)
    if (this.droppedMessages > 0) {
      const totalMessages = stats.reduce((sum, s) => sum + s.messageCount, 0)
      const dropRate = this.droppedMessages / (totalMessages + this.droppedMessages)
      score -= Math.min(30, dropRate * 100)
    }

    score = Math.max(0, Math.round(score))

    // Determine level
    let level: ConnectionQuality['level']
    if (score >= 90) level = 'excellent'
    else if (score >= 70) level = 'good'
    else if (score >= 50) level = 'fair'
    else if (score >= 25) level = 'poor'
    else level = 'critical'

    return {
      score,
      level,
      avgLatencyMs,
      totalMessagesPerSecond,
      droppedMessages: this.droppedMessages,
      uptimeSeconds,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ALERTS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Register an alert callback
   */
  onAlert(callback: AlertCallback): () => void {
    this.alertCallbacks.add(callback)
    return () => this.alertCallbacks.delete(callback)
  }

  private emitAlert(alert: PerformanceAlert): boolean {
    const key = `${alert.type}\0${alert.topic ?? ''}`
    const previous = this.lastAlertAt.get(key)
    if (previous !== undefined && alert.timestamp - previous < PERFORMANCE_ALERT_COOLDOWN_MS) {
      return false
    }
    this.lastAlertAt.delete(key)
    this.lastAlertAt.set(key, alert.timestamp)
    // Snapshot the subscribers. A callback that registers another callback
    // cannot extend the active dispatch and manufacture unbounded work.
    const publishedAlert = Object.freeze({ ...alert })
    for (const callback of [...this.alertCallbacks]) {
      try {
        callback(publishedAlert)
      } catch (error) {
        log.error('Alert callback error', { error })
      }
    }
    return true
  }

  private checkForAlerts(): void {
    const now = this.now()
    const quality = this.getConnectionQualityAt(this.getAllTopicStatsAt(now), now)
    let emittedAlerts = 0

    // Check for degraded connection
    if (quality.level === 'poor' || quality.level === 'critical') {
      if (
        this.emitAlert({
          type: 'connection_degraded',
          message: `Connection quality ${quality.level}: score ${quality.score}/100`,
          severity: quality.level === 'critical' ? 'error' : 'warning',
          timestamp: now,
        })
      ) {
        emittedAlerts += 1
      }
    }

    // Check individual topics from a persistent cursor. Starting at the first
    // Map entry on every pass lets its cooldown expire before a large tail is
    // reached, which can starve later topics forever.
    const topics = [...this.topicLastReceived.entries()]
    const topicCount = topics.length
    const startIndex = topicCount === 0 ? 0 : this.lowThroughputScanCursor % topicCount
    let visitedTopics = 0
    while (visitedTopics < topicCount && emittedAlerts < MAX_PERFORMANCE_ALERTS_PER_CHECK) {
      const [topic, lastReceived] = topics[(startIndex + visitedTopics) % topicCount]
      visitedTopics += 1
      if (now - lastReceived > this.config.windowSizeMs) {
        if (
          this.emitAlert({
            type: 'low_throughput',
            topic,
            message: `No messages received on ${topic} for ${((now - lastReceived) / 1000).toFixed(1)}s`,
            severity: 'warning',
            timestamp: now,
          })
        ) {
          emittedAlerts += 1
        }
      }
    }
    this.lowThroughputScanCursor = topicCount === 0 ? 0 : (startIndex + visitedTopics) % topicCount
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ACCESSORS
  // ───────────────────────────────────────────────────────────────────────────

  getConfig(): Readonly<PerformanceConfig> {
    return this.config
  }

  setConfig(config: Partial<PerformanceConfig>): void {
    const nextConfig = validatePerformanceConfig({ ...this.config, ...config })
    if (nextConfig.maxSamplesPerTopic !== this.config.maxSamplesPerTopic) {
      const bufferCount = this.topicLatencies.size + this.topicMessageSamples.size
      const nextAllocatedSampleSlots = bufferCount * nextConfig.maxSamplesPerTopic
      if (nextAllocatedSampleSlots > MAX_PERFORMANCE_SAMPLE_SLOTS) {
        throw new Error(
          `Configured history would exceed ${MAX_PERFORMANCE_SAMPLE_SLOTS} aggregate sample slots`
        )
      }
      const resizedLatencies = this.resizeBuffers(
        this.topicLatencies,
        nextConfig.maxSamplesPerTopic
      )
      const resizedMessageSamples = this.resizeBuffers(
        this.topicMessageSamples,
        nextConfig.maxSamplesPerTopic
      )
      this.topicLatencies = resizedLatencies
      this.topicMessageSamples = resizedMessageSamples
      this.allocatedSampleSlots = nextAllocatedSampleSlots
    }
    this.config = nextConfig
  }

  getUptimeSeconds(): number {
    return this.uptimeMsAt(this.now()) / 1000
  }

  getDroppedMessageCount(): number {
    return this.droppedMessages
  }

  private now(observedDurationTime: number = performance.now()): number {
    this.lastObservedTime = Math.max(this.lastObservedTime, observedDurationTime)
    return this.lastObservedTime
  }

  private uptimeMsAt(now: number): number {
    if (this.runningSince === null) return this.accumulatedUptimeMs
    return this.accumulatedUptimeMs + Math.max(0, now - this.runningSince)
  }

  private trackTopic(topic: string, now: number): void {
    if (!this.trackedTopics.has(topic)) {
      while (this.trackedTopics.size >= MAX_PERFORMANCE_TOPICS) this.evictOldestTopic(topic)
      this.trackedTopics.add(topic)
    }
    this.topicLastObserved.delete(topic)
    this.topicLastObserved.set(topic, now)
  }

  private getOrCreateBuffer<T>(
    buffers: Map<string, CircularBuffer<T>>,
    topic: string
  ): CircularBuffer<T> | null {
    const existing = buffers.get(topic)
    if (existing) return existing
    while (
      this.allocatedSampleSlots + this.config.maxSamplesPerTopic >
      MAX_PERFORMANCE_SAMPLE_SLOTS
    ) {
      if (!this.evictOldestTopic(topic)) return null
    }
    const buffer = new CircularBuffer<T>(this.config.maxSamplesPerTopic)
    buffers.set(topic, buffer)
    this.allocatedSampleSlots += this.config.maxSamplesPerTopic
    return buffer
  }

  private evictOldestTopic(excludedTopic: string): boolean {
    let oldestTopic: string | undefined
    for (const topic of this.topicLastObserved.keys()) {
      if (topic !== excludedTopic) {
        oldestTopic = topic
        break
      }
    }
    if (oldestTopic === undefined) return false
    if (this.topicLatencies.delete(oldestTopic)) {
      this.allocatedSampleSlots -= this.config.maxSamplesPerTopic
    }
    if (this.topicMessageSamples.delete(oldestTopic)) {
      this.allocatedSampleSlots -= this.config.maxSamplesPerTopic
    }
    this.topicLifetimeMessageCounts.delete(oldestTopic)
    this.topicLifetimeByteCounts.delete(oldestTopic)
    this.topicLastReceived.delete(oldestTopic)
    this.topicLastObserved.delete(oldestTopic)
    this.trackedTopics.delete(oldestTopic)
    for (const type of ['high_latency', 'low_throughput', 'message_gap'] as const) {
      this.lastAlertAt.delete(`${type}\0${oldestTopic}`)
    }
    return true
  }

  private resizeBuffers<T>(
    buffers: Map<string, CircularBuffer<T>>,
    capacity: number
  ): Map<string, CircularBuffer<T>> {
    const resized = new Map<string, CircularBuffer<T>>()
    for (const [topic, buffer] of buffers) {
      const replacement = new CircularBuffer<T>(capacity)
      for (const sample of buffer.toArray().slice(-capacity)) replacement.push(sample)
      resized.set(topic, replacement)
    }
    return resized
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

export function createPerformanceMonitor(
  config?: Partial<PerformanceConfig>
): ROSPerformanceMonitor {
  return new ROSPerformanceMonitor(config)
}
