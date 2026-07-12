import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROSBridge, validateRosUrl, type ROSBridgeConfig } from '../ROSBridge'
import { installMockWebSocket, MockWebSocket, sentMessages } from '../../test/mockWebSocket'

let restoreWebSocket: () => void

async function connectBridge(config: Partial<ROSBridgeConfig> = {}) {
  const bridge = new ROSBridge({
    url: 'ws://localhost:9090',
    autoReconnect: false,
    ...config,
  })
  const promise = bridge.connect()
  const ws = MockWebSocket.last()
  ws.open()
  await promise
  return { bridge, ws }
}

describe('ROSBridge telemetry surface', () => {
  beforeEach(() => {
    restoreWebSocket = installMockWebSocket()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    restoreWebSocket()
  })

  it('accepts websocket URLs', () => {
    expect(validateRosUrl('ws://localhost:9090')).toEqual({ valid: true })
    expect(validateRosUrl('wss://ros.example.com/bridge')).toEqual({ valid: true })
  })

  it('rejects non-websocket schemes and malformed URLs', () => {
    expect(validateRosUrl('http://localhost:9090')).toMatchObject({
      valid: false,
      error: 'Invalid scheme: http:. Only ws:// and wss:// are allowed.',
    })
    expect(validateRosUrl('not-a-url')).toMatchObject({
      valid: false,
      error: 'Invalid URL format',
    })
  })

  it('rejects invalid hostname formats and dangerous inputs', () => {
    expect(validateRosUrl('ws://-bad-host:9090')).toMatchObject({
      valid: false,
      error: 'Invalid hostname format',
    })
    expect(validateRosUrl('ws://robot..local:9090')).toMatchObject({
      valid: false,
      error: 'Invalid hostname format',
    })
    expect(() => new ROSBridge({ url: 'file:///tmp/socket' })).toThrow('Invalid ROS bridge URL')
  })

  it('subscribes once per topic and dispatches telemetry', async () => {
    const { bridge, ws } = await connectBridge()
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()

    const unsubscribeFirst = bridge.subscribe('/camera', 'sensor_msgs/Image', firstCallback, 50, 10)
    const unsubscribeSecond = bridge.subscribe('/camera', 'sensor_msgs/Image', secondCallback, 50, 10)
    ws.receive({ op: 'publish', topic: '/camera', msg: { frame: 1 } })
    unsubscribeFirst()
    unsubscribeSecond()

    expect(sentMessages(ws).filter((message) => message.op === 'subscribe')).toEqual([
      expect.objectContaining({
        topic: '/camera',
        type: 'sensor_msgs/Image',
        throttle_rate: 50,
        queue_length: 10,
      }),
    ])
    expect(sentMessages(ws).filter((message) => message.op === 'unsubscribe')).toHaveLength(1)
    expect(firstCallback).toHaveBeenCalledWith({ frame: 1 })
    expect(secondCallback).toHaveBeenCalledWith({ frame: 1 })
  })

  it('ignores malformed inbound publish payloads', async () => {
    const { bridge, ws } = await connectBridge()
    const callback = vi.fn()

    bridge.subscribe('/camera', 'sensor_msgs/Image', callback)
    ws.receive({ op: 'publish', msg: { frame: 1 } })

    expect(callback).not.toHaveBeenCalled()
  })

  it('rejects invalid subscription topics, message types, and queue parameters', async () => {
    const { bridge } = await connectBridge()

    expect(() => bridge.subscribe('relative/topic', 'sensor_msgs/Image', vi.fn())).toThrow(
      'Invalid ROS topic: name must be absolute'
    )
    expect(() => bridge.subscribe('/bad topic', 'sensor_msgs/Image', vi.fn())).toThrow(
      'Invalid ROS topic: name contains invalid characters'
    )
    expect(() => bridge.subscribe('/camera', 'Image', vi.fn())).toThrow(
      'Invalid ROS message type'
    )
    expect(() => bridge.subscribe('/camera', 'sensor_msgs/Image', vi.fn(), -1)).toThrow(
      'Invalid ROS throttle rate'
    )
  })

  it('resubscribes telemetry after reconnecting', async () => {
    vi.useFakeTimers()
    const { bridge, ws } = await connectBridge({
      autoReconnect: true,
      reconnectIntervalMs: 50,
      maxReconnectAttempts: 1,
    })
    bridge.subscribe('/pose', 'geometry_msgs/PoseStamped', vi.fn(), 25)

    ws.close()
    await vi.advanceTimersByTimeAsync(50)
    const reconnectWs = MockWebSocket.last()
    reconnectWs.open()
    await Promise.resolve()

    expect(reconnectWs).not.toBe(ws)
    expect(sentMessages(reconnectWs).map((message) => message.op)).toEqual(['subscribe'])
  })

  it('has no public write or service methods', () => {
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' }) as unknown as Record<
      string,
      unknown
    >

    for (const method of [
      'send',
      'advertise',
      'unadvertise',
      'publish',
      'callService',
      'publishSetpointPosition',
      'publishSetpointVelocity',
      'setMode',
      'arm',
      'takeoff',
      'land',
    ]) {
      expect(bridge[method], method).toBeUndefined()
    }
  })
})
