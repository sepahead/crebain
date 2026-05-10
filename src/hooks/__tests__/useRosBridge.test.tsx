import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useRosBridge, type UseRosBridgeConfig, type UseRosBridgeReturn } from '../useRosBridge'
import { installMockWebSocket, MockWebSocket, sentMessages } from '../../test/mockWebSocket'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let hook: UseRosBridgeReturn
let restoreWebSocket: () => void

function Harness({ config }: { config: Partial<UseRosBridgeConfig> }) {
  hook = useRosBridge(config)
  return null
}

async function renderHook(config: Partial<UseRosBridgeConfig> = {}) {
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness config={config} />)
  })
  return root
}

async function connectHook() {
  let promise!: Promise<void>
  await act(async () => {
    promise = hook.connect()
    await Promise.resolve()
  })
  const ws = MockWebSocket.last()
  await act(async () => {
    ws.open()
    await promise
  })
  return ws
}

describe('useRosBridge', () => {
  beforeEach(() => {
    restoreWebSocket = installMockWebSocket()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    restoreWebSocket()
  })

  it('connects a websocket bridge and delegates topic and service operations', async () => {
    const root = await renderHook({
      transport: 'websocket',
      url: 'ws://localhost:9090',
      autoReconnect: false,
      enablePerformanceMonitoring: false,
    })

    const ws = await connectHook()
    const callback = vi.fn()
    const unsubscribe = hook.subscribe('/camera', 'sensor_msgs/Image', callback, 20)
    hook.publish('/cmd', { value: 1 })
    const serviceResponse = hook.callService<{ value: number }, { ok: boolean }>('/service', { value: 1 })
    const serviceCall = sentMessages(ws).find((message) => message.op === 'call_service')
    ws.receive({ op: 'publish', topic: '/camera', msg: { frame: 1 } })
    ws.receive({ op: 'service_response', id: serviceCall?.id, values: { ok: true }, result: true })
    unsubscribe()

    expect(hook.state).toBe('connected')
    expect(hook.isConnected).toBe(true)
    expect(callback).toHaveBeenCalledWith({ frame: 1 })
    expect(await serviceResponse).toEqual({ ok: true })
    expect(sentMessages(ws).map((message) => message.op)).toEqual([
      'subscribe',
      'publish',
      'call_service',
      'unsubscribe',
    ])

    await act(async () => root.unmount())
  })

  it('stores connection errors from failed websocket connections', async () => {
    const root = await renderHook({
      transport: 'websocket',
      url: 'ws://localhost:9090',
      autoReconnect: false,
      enablePerformanceMonitoring: false,
    })

    await act(async () => {
      const promise = hook.connect()
      await Promise.resolve()
      MockWebSocket.last().error('error')
      await promise
    })

    expect(hook.error).toBe('WebSocket error: error')

    await act(async () => root.unmount())
  })

  it('records performance stats and high latency alerts', async () => {
    vi.useFakeTimers()
    const root = await renderHook({
      transport: 'websocket',
      url: 'ws://localhost:9090',
      autoReconnect: false,
      enablePerformanceMonitoring: true,
      highLatencyThresholdMs: 5,
    })

    await act(async () => {
      hook.recordMessage('/camera', 100, Date.now() - 20)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(hook.performance.alerts).toEqual([
      expect.objectContaining({ type: 'high_latency', topic: '/camera' }),
    ])
    expect(hook.performance.topicStats).toEqual([
      expect.objectContaining({ topic: '/camera', messageCount: 1, byteCount: 100, avgLatencyMs: 20 }),
    ])
    expect(hook.performance.quality).toEqual(expect.objectContaining({ avgLatencyMs: 20 }))

    await act(async () => root.unmount())
  })
})
