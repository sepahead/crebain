import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPerformanceMonitor,
  MAX_PERFORMANCE_LATENCY_MS,
  MAX_PERFORMANCE_MESSAGE_BYTES,
  MAX_PERFORMANCE_SAMPLES_PER_TOPIC,
  MAX_PERFORMANCE_TOPICS,
  MAX_PERFORMANCE_TOPIC_LENGTH,
} from '../ROSPerformanceMonitor'

describe('ROSPerformanceMonitor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records topic statistics and calculates connection quality', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const monitor = createPerformanceMonitor({ highLatencyThresholdMs: 100 })
    vi.advanceTimersByTime(1_000)

    monitor.recordMessage('/camera', 200, Date.now() - 20)
    monitor.recordMessage('/camera', 100, Date.now() - 40)

    expect(monitor.getTopicStats('/camera')).toEqual(
      expect.objectContaining({
        topic: '/camera',
        messageCount: 2,
        byteCount: 300,
        windowMessageCount: 2,
        windowByteCount: 300,
        messagesPerSecond: 2,
        bytesPerSecond: 300,
        avgLatencyMs: 30,
        minLatencyMs: 20,
        maxLatencyMs: 40,
        p95LatencyMs: 40,
      })
    )
    expect(monitor.getAllTopicStats()).toHaveLength(1)
    expect(monitor.getConnectionQuality()).toEqual(expect.objectContaining({
      avgLatencyMs: 30,
      droppedMessages: 0,
    }))
  })

  it('emits high latency and message gap alerts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const monitor = createPerformanceMonitor({ highLatencyThresholdMs: 50, messageGapThresholdMs: 100 })
    const alert = vi.fn()
    monitor.onAlert(alert)

    monitor.recordMessage('/pose', 10, Date.now() - 75)
    vi.advanceTimersByTime(150)
    monitor.recordMessage('/pose', 10, Date.now() - 10)

    expect(alert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'high_latency',
      topic: '/pose',
      severity: 'warning',
    }))
    expect(alert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'message_gap',
      topic: '/pose',
      severity: 'warning',
    }))
    expect(monitor.getDroppedMessageCount()).toBe(1)
  })

  it('emits degraded connection alerts while running without topic stats', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const monitor = createPerformanceMonitor()
    const alert = vi.fn()
    monitor.onAlert(alert)

    monitor.start()
    await vi.advanceTimersByTimeAsync(1_000)
    monitor.stop()

    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection_degraded' }))
  })

  it('emits low throughput alerts while running', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const monitor = createPerformanceMonitor({ windowSizeMs: 100 })
    const alert = vi.fn()
    monitor.onAlert(alert)
    monitor.recordMessage('/model_states', 10, Date.now() - 5)

    monitor.start()
    await vi.advanceTimersByTimeAsync(1_000)
    monitor.stop()

    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'low_throughput',
      topic: '/model_states',
    }))
  })

  it('expires frozen traffic from rolling health while retaining lifetime totals', () => {
    vi.useFakeTimers()
    vi.setSystemTime(30_000)
    const monitor = createPerformanceMonitor({ windowSizeMs: 1_000 })
    vi.advanceTimersByTime(500)

    monitor.recordMessage('/camera', 200, Date.now() - 20)
    expect(monitor.getTopicStats('/camera')).toEqual(
      expect.objectContaining({
        messageCount: 1,
        byteCount: 200,
        windowMessageCount: 1,
        windowByteCount: 200,
      })
    )

    vi.advanceTimersByTime(1_001)

    expect(monitor.getTopicStats('/camera')).toEqual(
      expect.objectContaining({
        messageCount: 1,
        byteCount: 200,
        windowMessageCount: 0,
        windowByteCount: 0,
        messagesPerSecond: 0,
        bytesPerSecond: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
      })
    )
    expect(monitor.getConnectionQuality().level).toBe('critical')
  })

  it('uses nearest-rank p95 for the rolling latency sample', () => {
    vi.useFakeTimers()
    vi.setSystemTime(40_000)
    const monitor = createPerformanceMonitor()
    vi.advanceTimersByTime(1_000)

    for (let latencyMs = 1; latencyMs <= 100; latencyMs++) {
      monitor.recordMessage('/pose', 1, Date.now() - latencyMs)
    }

    expect(monitor.getTopicStats('/pose')?.p95LatencyMs).toBe(95)
  })

  it('records direct latency durations and rejects invalid samples', () => {
    vi.useFakeTimers()
    vi.setSystemTime(45_000)
    const monitor = createPerformanceMonitor({ highLatencyThresholdMs: 10 })
    const alert = vi.fn()
    monitor.onAlert(alert)
    monitor.recordMessage('/pose', 1)

    monitor.recordLatency('/pose', 20)
    monitor.recordLatency('/pose', -1)
    monitor.recordLatency('/pose', Number.POSITIVE_INFINITY)

    expect(monitor.getTopicStats('/pose')).toEqual(
      expect.objectContaining({ avgLatencyMs: 20, minLatencyMs: 20, maxLatencyMs: 20 })
    )
    expect(alert).toHaveBeenCalledOnce()
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'high_latency', topic: '/pose' })
    )
  })

  it('starts idempotently without resetting uptime or leaking intervals', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    const monitor = createPerformanceMonitor()

    monitor.start()
    vi.advanceTimersByTime(500)
    monitor.start()

    expect(monitor.getUptimeSeconds()).toBe(0.5)
    expect(vi.getTimerCount()).toBe(1)

    monitor.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resets statistics and supports config updates', () => {
    const monitor = createPerformanceMonitor({ highLatencyThresholdMs: 100 })

    monitor.recordMessage('/imu', 42, Date.now() - 10)
    monitor.setConfig({ highLatencyThresholdMs: 5 })
    monitor.reset()

    expect(monitor.getTopicStats('/imu')).toBeNull()
    expect(monitor.getDroppedMessageCount()).toBe(0)
    expect(monitor.getConfig().highLatencyThresholdMs).toBe(5)
  })

  it('rejects invalid configuration atomically', () => {
    expect(() => createPerformanceMonitor({ windowSizeMs: 0 })).toThrow(
      'Performance window size must be a positive safe integer'
    )
    expect(() => createPerformanceMonitor({ maxSamplesPerTopic: 1.5 })).toThrow(
      `Maximum samples per topic must be an integer from 1 to ${MAX_PERFORMANCE_SAMPLES_PER_TOPIC}`
    )
    expect(() =>
      createPerformanceMonitor({ maxSamplesPerTopic: MAX_PERFORMANCE_SAMPLES_PER_TOPIC + 1 })
    ).toThrow(
      `Maximum samples per topic must be an integer from 1 to ${MAX_PERFORMANCE_SAMPLES_PER_TOPIC}`
    )
    expect(() =>
      createPerformanceMonitor({ highLatencyThresholdMs: MAX_PERFORMANCE_LATENCY_MS + 1 })
    ).toThrow(
      `High latency threshold must be between 0 and ${MAX_PERFORMANCE_LATENCY_MS} milliseconds`
    )

    const monitor = createPerformanceMonitor()
    const original = monitor.getConfig()
    expect(() => monitor.setConfig({ minMessagesPerSecond: Number.NaN })).toThrow(
      'Minimum message rate must be a finite non-negative number'
    )
    expect(monitor.getConfig()).toBe(original)
  })

  it('rejects invalid message samples without corrupting statistics', () => {
    const monitor = createPerformanceMonitor()

    monitor.recordMessage('', 1)
    monitor.recordMessage(' /camera', 1)
    monitor.recordMessage('/camera', -1)
    monitor.recordMessage('/camera', 1.5)
    monitor.recordMessage('/camera', Number.POSITIVE_INFINITY)
    monitor.recordMessage('/camera', MAX_PERFORMANCE_MESSAGE_BYTES + 1)
    monitor.recordMessage(`/${'a'.repeat(MAX_PERFORMANCE_TOPIC_LENGTH)}`, 1)
    monitor.recordLatency('', 1)
    monitor.recordLatency('/invalid\0topic', 1)
    monitor.recordLatency(`/${'a'.repeat(MAX_PERFORMANCE_TOPIC_LENGTH)}`, 1)
    monitor.recordLatency('camera', 1)
    monitor.recordLatency('/', 1)
    monitor.recordLatency('/camera//front', 1)
    monitor.recordLatency('/camera front', 1)
    monitor.recordLatency('/camera-front', 1)
    monitor.recordLatency('/camera', MAX_PERFORMANCE_LATENCY_MS + 1)
    monitor.recordLatency('/camera', Number.MAX_VALUE)

    expect(monitor.getAllTopicStats()).toEqual([])
    expect(monitor.getConnectionQuality()).toEqual(
      expect.objectContaining({ score: 0, totalMessagesPerSecond: 0 })
    )
  })

  it('keeps every reported metric finite at the maximum latency boundary', () => {
    const monitor = createPerformanceMonitor()
    monitor.recordMessage('/camera', 1, Date.now() - MAX_PERFORMANCE_LATENCY_MS - 1)
    monitor.recordLatency('/camera', MAX_PERFORMANCE_LATENCY_MS)
    monitor.recordLatency('/camera', MAX_PERFORMANCE_LATENCY_MS)
    monitor.recordLatency('/camera', Number.MAX_VALUE)

    const stats = monitor.getTopicStats('/camera')
    const quality = monitor.getConnectionQuality()
    expect(stats).not.toBeNull()
    expect(Object.values(stats ?? {}).filter((value) => typeof value === 'number').every(Number.isFinite)).toBe(true)
    expect(Object.values(quality).filter((value) => typeof value === 'number').every(Number.isFinite)).toBe(true)
    expect(stats?.avgLatencyMs).toBe(MAX_PERFORMANCE_LATENCY_MS)
  })

  it('supports a zero expected message rate without producing a non-finite score', () => {
    vi.useFakeTimers()
    vi.setSystemTime(60_000)
    const monitor = createPerformanceMonitor({ minMessagesPerSecond: 0 })
    monitor.recordMessage('/on_demand', 1)

    expect(monitor.getConnectionQuality()).toEqual(
      expect.objectContaining({ score: 100, level: 'excellent' })
    )
  })

  it('resizes existing sample windows when the configured capacity changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(70_000)
    const monitor = createPerformanceMonitor({ maxSamplesPerTopic: 4 })
    for (let size = 1; size <= 4; size++) monitor.recordMessage('/camera', size)

    monitor.setConfig({ maxSamplesPerTopic: 2 })

    expect(monitor.getTopicStats('/camera')).toEqual(
      expect.objectContaining({
        messageCount: 4,
        byteCount: 10,
        windowMessageCount: 2,
        windowByteCount: 7,
      })
    )
  })

  it('evicts the least recently used topic when topic churn reaches the bound', () => {
    const monitor = createPerformanceMonitor({ maxSamplesPerTopic: 1 })
    for (let index = 0; index < MAX_PERFORMANCE_TOPICS; index++) {
      const topic = `/topic_${index}`
      if (index % 2 === 0) monitor.recordMessage(topic, 1)
      else monitor.recordLatency(topic, 1)
    }

    monitor.recordMessage('/overflow_message', 1)
    monitor.recordLatency('/overflow_latency', 1)
    monitor.recordMessage('/overflow_latency', 1)

    expect(monitor.getAllTopicStats()).toHaveLength(MAX_PERFORMANCE_TOPICS / 2 + 1)
    expect(monitor.getTopicStats('/topic_0')).toBeNull()
    expect(monitor.getTopicStats('/overflow_message')).not.toBeNull()
    expect(monitor.getTopicStats('/overflow_latency')).not.toBeNull()
  })

  it('rejects a history resize that would exceed the aggregate slot budget', () => {
    const monitor = createPerformanceMonitor({ maxSamplesPerTopic: 1 })
    for (let index = 0; index < 103; index++) {
      const topic = `/topic_${index}`
      monitor.recordMessage(topic, 1)
      monitor.recordLatency(topic, 1)
    }
    const original = monitor.getConfig()

    expect(() =>
      monitor.setConfig({ maxSamplesPerTopic: MAX_PERFORMANCE_SAMPLES_PER_TOPIC })
    ).toThrow('Configured history would exceed')
    expect(monitor.getConfig()).toBe(original)
    expect(monitor.getTopicStats('/topic_0')).toEqual(
      expect.objectContaining({ messageCount: 1, windowMessageCount: 1 })
    )
  })

  it('clamps uptime when the wall clock moves backwards', () => {
    vi.useFakeTimers()
    vi.setSystemTime(80_000)
    const monitor = createPerformanceMonitor()
    const alert = vi.fn()
    monitor.onAlert(alert)
    monitor.recordMessage('/camera', 1)
    vi.setSystemTime(79_000)
    monitor.recordMessage('/camera', 1)
    vi.setSystemTime(80_000)

    expect(monitor.getUptimeSeconds()).toBe(0)
    expect(monitor.getConnectionQuality().uptimeSeconds).toBe(0)
    expect(monitor.getTopicStats('/camera')).toEqual(
      expect.objectContaining({ messageCount: 2, windowMessageCount: 2 })
    )
    expect(monitor.getDroppedMessageCount()).toBe(0)
    expect(alert).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'message_gap' }))
  })
})
