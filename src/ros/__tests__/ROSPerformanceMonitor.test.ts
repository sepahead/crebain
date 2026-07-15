import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPerformanceMonitor } from '../ROSPerformanceMonitor'

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
})
