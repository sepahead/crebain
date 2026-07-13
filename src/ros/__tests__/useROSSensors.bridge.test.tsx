import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROSBridge } from '../ROSBridge'
import {
  NATIVE_FUSION_BACKEND_REQUIRED,
  ROS_SENSOR_WEBSOCKET_REQUIRED,
  useROSSensors,
  type ROSSensorConfigInput,
  type UseROSSensorsReturn,
} from '../useROSSensors'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const fusionMocks = vi.hoisted(() => ({
  initFusion: vi.fn(async () => undefined),
  processMeasurements: vi.fn(
    async (
      _measurements: unknown[],
      _timestampMs?: number,
      _upstreamDroppedMeasurements?: number
    ) => []
  ),
  getFusionStats: vi.fn(async () => null),
  setFusionConfig: vi.fn(async () => undefined),
  clearTracks: vi.fn(async () => undefined),
}))

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
}))

vi.mock('../../detection/AdvancedSensorFusion', () => fusionMocks)
vi.mock('@tauri-apps/api/core', () => ({ isTauri: tauriMocks.isTauri }))

let hook: UseROSSensorsReturn

function Harness({ config }: { config: ROSSensorConfigInput }) {
  hook = useROSSensors(config)
  return null
}

async function renderHarness(config: ROSSensorConfigInput): Promise<{
  root: Root
  rerender: (nextConfig: ROSSensorConfigInput) => Promise<void>
}> {
  const container = document.createElement('div')
  const root = createRoot(container)

  await act(async () => {
    root.render(<Harness config={config} />)
  })

  return {
    root,
    rerender: async (nextConfig) => {
      await act(async () => {
        root.render(<Harness config={nextConfig} />)
      })
    },
  }
}

describe('useROSSensors bridge ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriMocks.isTauri.mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses one external bridge, cleans up its subscriptions, and never disconnects it', async () => {
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const unsubscribers: Array<ReturnType<typeof vi.fn>> = []
    const subscribe = vi.spyOn(bridge, 'subscribe').mockImplementation(() => {
      const unsubscribe = vi.fn()
      unsubscribers.push(unsubscribe)
      return unsubscribe
    })
    const connect = vi.spyOn(bridge, 'connect').mockResolvedValue(undefined)
    const disconnect = vi.spyOn(bridge, 'disconnect').mockImplementation(() => undefined)
    const connectedConfig: ROSSensorConfigInput = {
      autoConnect: true,
      externalConnection: {
        bridge,
        connectionState: 'connected',
      },
    }
    const { root, rerender } = await renderHarness(connectedConfig)

    expect(connect).not.toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledTimes(4)
    expect(subscribe.mock.calls.map(([topic]) => topic)).toEqual([
      '/crebain/thermal/detections',
      '/crebain/acoustic/detections',
      '/crebain/radar/detections',
      '/crebain/lidar/detections',
    ])
    expect(hook.connectionState).toBe('connected')

    await rerender({
      ...connectedConfig,
      externalConnection: {
        bridge,
        connectionState: 'disconnected',
      },
    })

    expect(unsubscribers).toHaveLength(4)
    unsubscribers.forEach((unsubscribe) => expect(unsubscribe).toHaveBeenCalledTimes(1))
    expect(disconnect).not.toHaveBeenCalled()
    expect(hook.connectionState).toBe('disconnected')

    await rerender(connectedConfig)
    const reconnectedUnsubscribers = unsubscribers.slice(4)
    expect(reconnectedUnsubscribers).toHaveLength(4)

    await act(async () => hook.disconnect())
    reconnectedUnsubscribers.forEach((unsubscribe) => expect(unsubscribe).toHaveBeenCalledTimes(1))
    expect(disconnect).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('reports unsupported external transports without creating a hidden WebSocket', async () => {
    const connect = vi.spyOn(ROSBridge.prototype, 'connect')
    const { root } = await renderHarness({
      autoConnect: true,
      externalConnection: {
        bridge: null,
        connectionState: 'disconnected',
        unsupportedReason: ROS_SENSOR_WEBSOCKET_REQUIRED,
      },
    })

    expect(connect).not.toHaveBeenCalled()
    expect(hook.connectionState).toBe('disconnected')
    expect(hook.connectionError).toBe(ROS_SENSOR_WEBSOCKET_REQUIRED)

    await act(async () => root.unmount())
  })

  it('preserves the standalone internally owned bridge mode', async () => {
    const unsubscribe = vi.fn()
    const connect = vi.spyOn(ROSBridge.prototype, 'connect').mockResolvedValue(undefined)
    const subscribe = vi
      .spyOn(ROSBridge.prototype, 'subscribe')
      .mockImplementation(() => unsubscribe)
    const disconnect = vi
      .spyOn(ROSBridge.prototype, 'disconnect')
      .mockImplementation(() => undefined)
    const { root } = await renderHarness({ autoConnect: true })

    expect(connect).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(4)

    await act(async () => root.unmount())
    expect(unsubscribe).toHaveBeenCalledTimes(4)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('keeps browser ROS subscriptions honest without invoking native fusion commands', async () => {
    vi.useFakeTimers()
    tauriMocks.isTauri.mockReturnValue(false)
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    const subscribe = vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })

    const { root } = await renderHarness({
      fusionRateHz: 10,
      externalConnection: { bridge, connectionState: 'connected' },
    })

    expect(tauriMocks.isTauri).toHaveBeenCalledTimes(1)
    expect(hook.fusionAvailable).toBe(false)
    expect(hook.fusionError).toBe(NATIVE_FUSION_BACKEND_REQUIRED)
    expect(hook.connectionState).toBe('connected')
    expect(subscribe).toHaveBeenCalledTimes(4)

    act(() => {
      callbacks.get('/crebain/thermal/detections')?.({
        detections: [
          {
            header: { stamp: { secs: 1, nsecs: 0 } },
            position: { x: 1, y: 2, z: 3 },
            temperature_kelvin: 300,
            signature_area: 2,
            confidence: 0.9,
            classification: 'drone',
          },
        ],
      })
      hook.addVisualDetection('camera-1', [1, 2, 3], 0.8, 'drone', Date.now())
    })

    expect(hook.sensorStatus.thermal).toBe(true)
    expect(hook.sensorStatus.visual).toBe(true)

    await act(async () => vi.advanceTimersByTime(500))
    await act(async () => {
      await expect(hook.setAlgorithm('UnscentedKalman')).rejects.toThrow(
        NATIVE_FUSION_BACKEND_REQUIRED
      )
      await hook.clearAllTracks()
    })
    act(() => hook.disconnect())

    expect(fusionMocks.initFusion).not.toHaveBeenCalled()
    expect(fusionMocks.processMeasurements).not.toHaveBeenCalled()
    expect(fusionMocks.getFusionStats).not.toHaveBeenCalled()
    expect(fusionMocks.setFusionConfig).not.toHaveBeenCalled()
    expect(fusionMocks.clearTracks).not.toHaveBeenCalled()
    expect(hook.fusionError).toBe(NATIVE_FUSION_BACKEND_REQUIRED)

    await act(async () => root.unmount())
  })

  it('fails closed when the Tauri runtime probe is unavailable', async () => {
    tauriMocks.isTauri.mockImplementationOnce(() => {
      throw new Error('runtime probe failed')
    })

    const { root } = await renderHarness({ autoConnect: false })

    expect(hook.fusionAvailable).toBe(false)
    expect(hook.fusionError).toBe(NATIVE_FUSION_BACKEND_REQUIRED)
    expect(fusionMocks.initFusion).not.toHaveBeenCalled()
    expect(fusionMocks.clearTracks).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('serializes slow fusion cycles and schedules one follow-up pass', async () => {
    vi.useFakeTimers()
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })

    let resolveFirstCycle: ((tracks: []) => void) | undefined
    fusionMocks.processMeasurements
      .mockImplementationOnce(
        () =>
          new Promise<[]>((resolve) => {
            resolveFirstCycle = resolve
          })
      )
      .mockResolvedValue([])

    const { root } = await renderHarness({
      fusionRateHz: 10,
      externalConnection: {
        bridge,
        connectionState: 'connected',
      },
    })
    const onThermal = callbacks.get('/crebain/thermal/detections')
    expect(onThermal).toBeDefined()
    const message = {
      detections: [
        {
          header: { stamp: { secs: 1, nsecs: 0 } },
          position: { x: 1, y: 2, z: 3 },
          temperature_kelvin: 300,
          signature_area: 2,
          confidence: 0.9,
          classification: 'drone',
        },
      ],
    }

    onThermal?.(message)
    await act(async () => vi.advanceTimersByTime(100))
    expect(fusionMocks.processMeasurements).toHaveBeenCalledTimes(1)

    onThermal?.(message)
    await act(async () => vi.advanceTimersByTime(100))
    expect(fusionMocks.processMeasurements).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstCycle?.([])
      await Promise.resolve()
    })
    expect(fusionMocks.processMeasurements).toHaveBeenCalledTimes(2)

    await act(async () => root.unmount())
  })

  it('reports single-message detection truncation to native frame admission', async () => {
    vi.useFakeTimers()
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })
    const detections = Array.from({ length: 514 }, (_, index) => ({
      header: { stamp: { secs: 1, nsecs: 0 } },
      position: { x: index, y: 2, z: 3 },
      temperature_kelvin: 300,
      signature_area: 2,
      confidence: 0.9,
      classification: 'drone',
    }))
    const { root } = await renderHarness({
      fusionRateHz: 10,
      externalConnection: { bridge, connectionState: 'connected' },
    })

    callbacks.get('/crebain/thermal/detections')?.({ detections })
    await act(async () => vi.advanceTimersByTime(100))

    const [measurements, timestampMs, upstreamDropped] =
      fusionMocks.processMeasurements.mock.calls[0]
    expect(measurements).toHaveLength(512)
    expect((measurements[0] as { position: number[] }).position[0]).toBe(2)
    expect(timestampMs).toBe(1000)
    expect(upstreamDropped).toBe(2)

    await act(async () => root.unmount())
  })

  it('reports accumulated buffer overflow instead of nominal survivor-only fusion', async () => {
    vi.useFakeTimers()
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })
    const detections = Array.from({ length: 300 }, (_, index) => ({
      header: { stamp: { secs: 2, nsecs: 0 } },
      position: { x: index, y: 2, z: 3 },
      temperature_kelvin: 300,
      signature_area: 2,
      confidence: 0.9,
      classification: 'drone',
    }))
    const { root } = await renderHarness({
      fusionRateHz: 10,
      externalConnection: { bridge, connectionState: 'connected' },
    })

    callbacks.get('/crebain/thermal/detections')?.({ detections })
    callbacks.get('/crebain/thermal/detections')?.({ detections })
    await act(async () => vi.advanceTimersByTime(100))

    const [measurements, timestampMs, upstreamDropped] =
      fusionMocks.processMeasurements.mock.calls[0]
    expect(measurements).toHaveLength(512)
    expect(timestampMs).toBe(2000)
    expect(upstreamDropped).toBe(88)

    await act(async () => root.unmount())
  })

  it('preserves one timestamp for visual tracks emitted from the same detector frame', async () => {
    vi.useFakeTimers()
    const { root } = await renderHarness({ fusionRateHz: 10 })
    const detectorFrameTimestamp = 42_000

    act(() => {
      hook.addVisualDetection('visual:track-1', [1, 2, 3], 0.9, 'drone', detectorFrameTimestamp)
    })
    vi.setSystemTime(new Date(123_456))
    act(() => {
      hook.addVisualDetection('visual:track-2', [4, 5, 6], 0.8, 'drone', detectorFrameTimestamp)
    })
    await act(async () => vi.advanceTimersByTime(100))

    const [measurements, frameTimestamp] = fusionMocks.processMeasurements.mock.calls[0]
    expect(measurements).toEqual([
      expect.objectContaining({ sensor_id: 'visual:track-1', timestamp_ms: detectorFrameTimestamp }),
      expect.objectContaining({ sensor_id: 'visual:track-2', timestamp_ms: detectorFrameTimestamp }),
    ])
    expect(frameTimestamp).toBe(detectorFrameTimestamp)

    await act(async () => root.unmount())
  })

  it('waits for an in-flight cycle before clearing and drops its stale result', async () => {
    vi.useFakeTimers()
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })

    let resolveCycle: ((tracks: never[]) => void) | undefined
    fusionMocks.processMeasurements.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          resolveCycle = resolve
        })
    )
    fusionMocks.clearTracks.mockResolvedValue(undefined)

    const { root } = await renderHarness({
      fusionRateHz: 10,
      externalConnection: { bridge, connectionState: 'connected' },
    })
    callbacks.get('/crebain/thermal/detections')?.({
      detections: [
        {
          header: { stamp: { secs: 1, nsecs: 0 } },
          position: { x: 1, y: 2, z: 3 },
          temperature_kelvin: 300,
          signature_area: 2,
          confidence: 0.9,
          classification: 'drone',
        },
      ],
    })
    await act(async () => vi.advanceTimersByTime(100))

    let clearPromise: Promise<void> | undefined
    act(() => {
      clearPromise = hook.clearAllTracks()
    })
    await Promise.resolve()
    expect(fusionMocks.clearTracks).not.toHaveBeenCalled()

    await act(async () => {
      resolveCycle?.([{ id: 'stale-track' }] as unknown as never[])
      await clearPromise
    })

    expect(fusionMocks.clearTracks).toHaveBeenCalledTimes(1)
    expect(fusionMocks.getFusionStats).not.toHaveBeenCalled()
    expect(hook.tracks).toEqual([])

    await act(async () => root.unmount())
  })

  it('clears after an in-flight cycle when an external sensor session disconnects', async () => {
    vi.useFakeTimers()
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })

    let resolveCycle: ((tracks: never[]) => void) | undefined
    fusionMocks.processMeasurements.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          resolveCycle = resolve
        })
    )
    let resolveClear: (() => void) | undefined
    const clearCompleted = new Promise<void>((resolve) => {
      resolveClear = resolve
    })
    fusionMocks.clearTracks.mockImplementationOnce(async () => {
      resolveClear?.()
    })

    const { root } = await renderHarness({
      fusionRateHz: 10,
      externalConnection: { bridge, connectionState: 'connected' },
    })
    callbacks.get('/crebain/thermal/detections')?.({
      detections: [
        {
          header: { stamp: { secs: 1, nsecs: 0 } },
          position: { x: 1, y: 2, z: 3 },
          temperature_kelvin: 300,
          signature_area: 2,
          confidence: 0.9,
          classification: 'drone',
        },
      ],
    })
    await act(async () => vi.advanceTimersByTime(100))

    act(() => hook.disconnect())
    await Promise.resolve()
    expect(fusionMocks.clearTracks).not.toHaveBeenCalled()

    await act(async () => {
      resolveCycle?.([{ id: 'stale-track' }] as unknown as never[])
      await clearCompleted
    })

    expect(fusionMocks.clearTracks).toHaveBeenCalledTimes(1)
    expect(fusionMocks.getFusionStats).not.toHaveBeenCalled()
    expect(hook.tracks).toEqual([])

    await act(async () => root.unmount())
  })

  it('waits for an in-flight cycle before reinitializing the fusion configuration', async () => {
    vi.useFakeTimers()
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })

    let resolveCycle: ((tracks: never[]) => void) | undefined
    fusionMocks.processMeasurements.mockImplementationOnce(
      () =>
        new Promise<never[]>((resolve) => {
          resolveCycle = resolve
        })
    )
    fusionMocks.initFusion.mockResolvedValue(undefined)

    const connectedConfig: ROSSensorConfigInput = {
      algorithm: 'ExtendedKalman',
      fusionRateHz: 10,
      externalConnection: { bridge, connectionState: 'connected' },
    }
    const { root, rerender } = await renderHarness(connectedConfig)
    callbacks.get('/crebain/thermal/detections')?.({
      detections: [
        {
          header: { stamp: { secs: 1, nsecs: 0 } },
          position: { x: 1, y: 2, z: 3 },
          temperature_kelvin: 300,
          signature_area: 2,
          confidence: 0.9,
          classification: 'drone',
        },
      ],
    })
    await act(async () => vi.advanceTimersByTime(100))
    expect(fusionMocks.initFusion).toHaveBeenCalledTimes(1)

    await rerender({ ...connectedConfig, algorithm: 'UnscentedKalman' })
    await Promise.resolve()
    expect(fusionMocks.initFusion).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCycle?.([{ id: 'stale-track' }] as unknown as never[])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fusionMocks.initFusion).toHaveBeenCalledTimes(2)
    expect(fusionMocks.getFusionStats).not.toHaveBeenCalled()
    expect(hook.tracks).toEqual([])

    await act(async () => root.unmount())
  })

  it('sends empty fusion frames until native tracks have aged out', async () => {
    vi.useFakeTimers()
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })
    fusionMocks.processMeasurements
      .mockResolvedValueOnce([{ id: 'track-1' }] as unknown as never[])
      .mockResolvedValueOnce([])

    const { root } = await renderHarness({
      fusionRateHz: 10,
      externalConnection: { bridge, connectionState: 'connected' },
    })
    callbacks.get('/crebain/thermal/detections')?.({
      detections: [
        {
          header: { stamp: { secs: 1, nsecs: 0 } },
          position: { x: 1, y: 2, z: 3 },
          temperature_kelvin: 300,
          signature_area: 2,
          confidence: 0.9,
          classification: 'drone',
        },
      ],
    })

    await act(async () => vi.advanceTimersByTime(100))
    await act(async () => vi.advanceTimersByTime(100))

    expect(fusionMocks.processMeasurements).toHaveBeenCalledTimes(2)
    expect(fusionMocks.processMeasurements).toHaveBeenNthCalledWith(1, expect.any(Array), 1000, 0)
    expect(fusionMocks.processMeasurements).toHaveBeenLastCalledWith([], 1000, 0)

    await act(async () => root.unmount())
  })

  it('keeps data, empty, and mixed cycles on one monotonic sensor clock', async () => {
    vi.useFakeTimers()
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callbacks = new Map<string, (message: unknown) => void>()
    vi.spyOn(bridge, 'subscribe').mockImplementation((topic, _type, callback) => {
      callbacks.set(topic, callback)
      return vi.fn()
    })
    const thermal = (timestampMs: number, x: number) => ({
      header: {
        stamp: {
          secs: Math.floor(timestampMs / 1000),
          nsecs: (timestampMs % 1000) * 1_000_000,
        },
      },
      position: { x, y: 2, z: 3 },
      temperature_kelvin: 300,
      signature_area: 2,
      confidence: 0.9,
      classification: 'drone',
    })
    const { root } = await renderHarness({
      fusionRateHz: 10,
      externalConnection: { bridge, connectionState: 'connected' },
    })

    // Pre-data closure frames use the neutral sensor epoch, never wall time.
    await act(async () => vi.advanceTimersByTime(100))
    callbacks.get('/crebain/thermal/detections')?.({ detections: [thermal(1_000, 1)] })
    await act(async () => vi.advanceTimersByTime(100))
    await act(async () => vi.advanceTimersByTime(100))
    callbacks.get('/crebain/thermal/detections')?.({
      detections: [thermal(1_050, 2), thermal(1_100, 3)],
    })
    await act(async () => vi.advanceTimersByTime(100))

    expect(
      fusionMocks.processMeasurements.mock.calls.map(([, frameTimestamp]) => frameTimestamp)
    ).toEqual([0, 1_000, 1_000, 1_100])
    const finalMeasurements = fusionMocks.processMeasurements.mock.calls[3][0] as Array<{
      timestamp_ms: number
    }>
    expect(finalMeasurements.map((measurement) => measurement.timestamp_ms)).toEqual([1_050, 1_100])

    await act(async () => root.unmount())
  })

  it('does not let a rejected future batch poison the renderer clock', async () => {
    vi.useFakeTimers()
    fusionMocks.processMeasurements.mockRejectedValueOnce(new Error('preflight rejected'))
    const { root } = await renderHarness({ fusionRateHz: 10 })

    act(() => {
      hook.addVisualDetection('visual:future', [1, 2, 3], 0.9, 'drone', 9_000)
    })
    await act(async () => vi.advanceTimersByTime(100))
    act(() => {
      hook.addVisualDetection('visual:valid', [1, 2, 3], 0.9, 'drone', 1_000)
    })
    await act(async () => vi.advanceTimersByTime(100))

    expect(fusionMocks.processMeasurements).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ timestamp_ms: 9_000 })],
      9_000,
      0
    )
    expect(fusionMocks.processMeasurements).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ timestamp_ms: 1_000 })],
      1_000,
      0
    )

    await act(async () => root.unmount())
  })
})
