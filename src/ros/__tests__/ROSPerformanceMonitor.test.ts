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

    expect(monitor.getTopicStats('/camera')).toEqual(expect.objectContaining({
      topic: '/camera',
      messageCount: 2,
      byteCount: 300,
      avgLatencyMs: 30,
      minLatencyMs: 20,
      maxLatencyMs: 40,
    }))
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
