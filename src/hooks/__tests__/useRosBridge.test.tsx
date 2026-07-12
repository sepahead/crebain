import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { useRosBridge, type UseRosBridgeConfig, type UseRosBridgeReturn } from '../useRosBridge'
import { installMockWebSocket, MockWebSocket, sentMessages } from '../../test/mockWebSocket'
import { ROSBridge } from '../../ros/ROSBridge'
import { ZenohBridge } from '../../ros/ZenohBridge'

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }))
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let hook: UseRosBridgeReturn
let restoreWebSocket: () => void
let renderSnapshots: Array<{
  requestedTransport: UseRosBridgeConfig['transport']
  bridge: UseRosBridgeReturn['bridge']
}>

function Harness({ config }: { config: Partial<UseRosBridgeConfig> }) {
  hook = useRosBridge(config)
  renderSnapshots.push({
    requestedTransport: config.transport ?? 'websocket',
    bridge: hook.bridge,
  })
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
    renderSnapshots = []
    tauriMocks.invoke.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    restoreWebSocket()
  })

  it('reactively exposes the bridge even when it is not connected', async () => {
    const root = await renderHook({
      transport: 'websocket',
      autoConnect: false,
      enablePerformanceMonitoring: false,
    })

    expect(hook.bridge).toBeInstanceOf(ROSBridge)
    expect(hook.state).toBe('disconnected')
    await act(async () => root.unmount())
  })

  it('never exposes a bridge owned by the previous transport during a switch', async () => {
    const websocketConfig: Partial<UseRosBridgeConfig> = {
      transport: 'websocket',
      autoConnect: false,
      enablePerformanceMonitoring: false,
    }
    const root = await renderHook(websocketConfig)
    const websocketBridge = hook.bridge
    expect(websocketBridge).toBeInstanceOf(ROSBridge)

    renderSnapshots = []
    await act(async () => {
      root.render(<Harness config={{ ...websocketConfig, transport: 'zenoh' }} />)
    })

    expect(renderSnapshots[0]).toEqual({
      requestedTransport: 'zenoh',
      bridge: null,
    })
    expect(
      renderSnapshots.some(
        ({ requestedTransport, bridge }) =>
          requestedTransport === 'zenoh' && bridge === websocketBridge
      )
    ).toBe(false)
    expect(hook.bridge).toBeInstanceOf(ZenohBridge)
    await act(async () => root.unmount())
  })

  it('ignores connection failures from a bridge superseded by a transport switch', async () => {
    const root = await renderHook({
      transport: 'websocket',
      autoConnect: true,
      autoReconnect: false,
      enablePerformanceMonitoring: false,
    })

    expect(MockWebSocket.last()).toBeDefined()
    expect(hook.state).toBe('connecting')

    await act(async () => {
      root.render(
        <Harness
          config={{
            transport: 'zenoh',
            autoConnect: false,
            enablePerformanceMonitoring: false,
          }}
        />
      )
      await Promise.resolve()
    })

    expect(hook.bridge).toBeInstanceOf(ZenohBridge)
    expect(hook.state).toBe('disconnected')
    expect(hook.error).toBeNull()

    await act(async () => root.unmount())
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
    const serviceResponse = hook.callService<{ value: number }, { ok: boolean }>('/service', {
      value: 1,
    })
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
      expect.objectContaining({
        topic: '/camera',
        messageCount: 1,
        byteCount: 100,
        avgLatencyMs: 20,
      }),
    ])
    expect(hook.performance.quality).toEqual(expect.objectContaining({ avgLatencyMs: 20 }))

    await act(async () => root.unmount())
  })
})
