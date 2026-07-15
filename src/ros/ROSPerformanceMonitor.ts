/**
 * CREBAIN ROS Performance Monitor
 * Adaptive Response & Awareness System (ARAS)
 *
 * Tracks message latency, throughput, and connection quality
 * Provides automatic degradation detection
 */

import { CircularBuffer } from '../lib/CircularBuffer'
import { rosLogger as log } from '../lib/logger'

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
  /** Lifetime messages since construction/reset. */
  messageCount: number
  /** Lifetime bytes since construction/reset. */
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
  private alertCallbacks: Set<AlertCallback> = new Set()
  private startTime: number = Date.now()
  private droppedMessages: number = 0
  private updateIntervalId: ReturnType<typeof setInterval> | null = null

  constructor(config: Partial<PerformanceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Start the performance monitor
   */
  start(): void {
    if (this.updateIntervalId !== null) return

    this.startTime = Date.now()

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
    this.droppedMessages = 0
    this.startTime = Date.now()
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
    const now = Date.now()

    // Update message count
    const count = this.topicLifetimeMessageCounts.get(topic) || 0
    this.topicLifetimeMessageCounts.set(topic, count + 1)

    // Update byte count
    const bytes = this.topicLifetimeByteCounts.get(topic) || 0
    this.topicLifetimeByteCounts.set(topic, bytes + messageSize)

    let messageBuffer = this.topicMessageSamples.get(topic)
    if (!messageBuffer) {
      messageBuffer = new CircularBuffer<MessageSample>(this.config.maxSamplesPerTopic)
      this.topicMessageSamples.set(topic, messageBuffer)
    }
    messageBuffer.push({ byteCount: messageSize, timestamp: now })

    // Check for message gap
    const lastReceived = this.topicLastReceived.get(topic)
    if (lastReceived && (now - lastReceived) > this.config.messageGapThresholdMs) {
      this.droppedMessages++
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
      sentTimestamp <= now
    ) {
      this.recordLatencySample(topic, now - sentTimestamp, now)
    }
  }

  /**
   * Record a latency sample directly
   */
  recordLatency(topic: string, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return
    this.recordLatencySample(topic, latencyMs, Date.now())
  }

  private recordLatencySample(topic: string, latencyMs: number, now: number): void {
    let buffer = this.topicLatencies.get(topic)
    if (!buffer) {
      buffer = new CircularBuffer<LatencySample>(this.config.maxSamplesPerTopic)
      this.topicLatencies.set(topic, buffer)
    }

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
    const messageCount = this.topicLifetimeMessageCounts.get(topic) || 0
    const byteCount = this.topicLifetimeByteCounts.get(topic) || 0
    const lastReceived = this.topicLastReceived.get(topic) || 0
    const latencyBuffer = this.topicLatencies.get(topic)
    const messageBuffer = this.topicMessageSamples.get(topic)

    if (messageCount === 0) return null

    const now = Date.now()
    const cutoff = now - this.config.windowSizeMs
    const messageSamples = messageBuffer?.filter((sample) => sample.timestamp >= cutoff) ?? []
    const windowMessageCount = messageSamples.length
    const windowByteCount = messageSamples.reduce((sum, sample) => sum + sample.byteCount, 0)
    // Before one complete window has elapsed, divide by the observed duration;
    // afterwards use the fixed configured window. Keep a positive denominator at
    // startup without stretching a sub-second configured window.
    const elapsedMs = Math.max(0, now - this.startTime)
    const windowDurationMs = Math.min(
      this.config.windowSizeMs,
      Math.max(1, elapsedMs)
    )
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
    const topics = new Set<string>([
      ...this.topicLifetimeMessageCounts.keys(),
      ...this.topicLatencies.keys(),
    ])

    const stats: TopicStats[] = []
    for (const topic of topics) {
      const topicStats = this.getTopicStats(topic)
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
    const stats = this.getAllTopicStats()
    const uptimeSeconds = (Date.now() - this.startTime) / 1000

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
    if (totalMessagesPerSecond < expectedMps) {
      score -= Math.min(30, (1 - totalMessagesPerSecond / expectedMps) * 30)
    }

    // A topic with no message in the complete rolling window is stale even when
    // its lifetime average was once high. Penalize that condition separately so
    // a fully frozen connection cannot remain "good".
    const now = Date.now()
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

  private emitAlert(alert: PerformanceAlert): void {
    for (const callback of this.alertCallbacks) {
      try {
        callback(alert)
      } catch (error) {
        log.error('Alert callback error', { error })
      }
    }
  }

  private checkForAlerts(): void {
    const now = Date.now()
    const quality = this.getConnectionQuality()

    // Check for degraded connection
    if (quality.level === 'poor' || quality.level === 'critical') {
      this.emitAlert({
        type: 'connection_degraded',
        message: `Connection quality ${quality.level}: score ${quality.score}/100`,
        severity: quality.level === 'critical' ? 'error' : 'warning',
        timestamp: now,
      })
    }

    // Check for low throughput on individual topics
    for (const [topic, lastReceived] of this.topicLastReceived) {
      if ((now - lastReceived) > this.config.windowSizeMs) {
        this.emitAlert({
          type: 'low_throughput',
          topic,
          message: `No messages received on ${topic} for ${((now - lastReceived) / 1000).toFixed(1)}s`,
          severity: 'warning',
          timestamp: now,
        })
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ACCESSORS
  // ───────────────────────────────────────────────────────────────────────────

  getConfig(): Readonly<PerformanceConfig> {
    return this.config
  }

  setConfig(config: Partial<PerformanceConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getUptimeSeconds(): number {
    return (Date.now() - this.startTime) / 1000
  }

  getDroppedMessageCount(): number {
    return this.droppedMessages
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

let instance: ROSPerformanceMonitor | null = null

export function getPerformanceMonitor(): ROSPerformanceMonitor {
  if (!instance) {
    instance = new ROSPerformanceMonitor()
  }
  return instance
}

export function createPerformanceMonitor(
  config?: Partial<PerformanceConfig>
): ROSPerformanceMonitor {
  return new ROSPerformanceMonitor(config)
}
