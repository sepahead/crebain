import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROSBridge, validateRosUrl, type ROSBridgeConfig } from '../ROSBridge'
import type { PoseStamped, TwistStamped } from '../types'
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

describe('ROSBridge', () => {
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

  it('rejects non-websocket schemes', () => {
    expect(validateRosUrl('http://localhost:9090')).toMatchObject({
      valid: false,
      error: 'Invalid scheme: http:. Only ws:// and wss:// are allowed.',
    })
  })

  it('rejects malformed URLs', () => {
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
    expect(validateRosUrl('ws://')).toMatchObject({
      valid: false,
      error: 'Invalid URL format',
    })
  })

  it('throws when constructed with an invalid URL', () => {
    expect(() => new ROSBridge({ url: 'file:///tmp/socket' })).toThrow('Invalid ROS bridge URL')
  })

  it('normalizes namespaces for setpoint publishers', () => {
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const publish = vi.spyOn(bridge, 'publish').mockImplementation(() => undefined)
    const pose: PoseStamped = {
      header: { stamp: { secs: 0, nsecs: 0 }, frame_id: 'map' },
      pose: {
        position: { x: 1, y: 2, z: 3 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    }
    const twist: TwistStamped = {
      header: { stamp: { secs: 0, nsecs: 0 }, frame_id: 'map' },
      twist: {
        linear: { x: 1, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      },
    }

    bridge.publishSetpointPosition('/drone1/', pose)
    bridge.publishSetpointVelocity('///drone2///', twist)

    expect(publish).toHaveBeenNthCalledWith(1, '/drone1/mavros/setpoint_position/local', pose)
    expect(publish).toHaveBeenNthCalledWith(2, '/drone2/mavros/setpoint_velocity/cmd_vel', twist)
  })

  it('normalizes namespaces for MAVROS service helpers', async () => {
    const bridge = new ROSBridge({ url: 'ws://localhost:9090' })
    const callService = vi.spyOn(bridge, 'callService')
    callService.mockResolvedValueOnce({ mode_sent: true })
    callService.mockResolvedValueOnce({ success: true })

    await expect(bridge.setMode('/drone1/', 'OFFBOARD')).resolves.toBe(true)
    await expect(bridge.arm('///drone1///')).resolves.toBe(true)

    expect(callService).toHaveBeenNthCalledWith(1, '/drone1/mavros/set_mode', { custom_mode: 'OFFBOARD' })
    expect(callService).toHaveBeenNthCalledWith(2, '/drone1/mavros/cmd/arming', { value: true })
  })

  it('sends one subscribe message per topic and dispatches published messages', async () => {
    const { bridge, ws } = await connectBridge()
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()

    const unsubscribeFirst = bridge.subscribe('/camera', 'sensor_msgs/Image', firstCallback, 50, 10)
    const unsubscribeSecond = bridge.subscribe('/camera', 'sensor_msgs/Image', secondCallback, 50, 10)
    ws.receive({ op: 'publish', topic: '/camera', msg: { frame: 1 } })
    unsubscribeFirst()
    unsubscribeSecond()

    const messages = sentMessages(ws)
    expect(messages.filter((message) => message.op === 'subscribe')).toEqual([
      expect.objectContaining({
        topic: '/camera',
        type: 'sensor_msgs/Image',
        throttle_rate: 50,
        queue_length: 10,
      }),
    ])
    expect(messages.filter((message) => message.op === 'unsubscribe')).toHaveLength(1)
    expect(firstCallback).toHaveBeenCalledWith({ frame: 1 })
    expect(secondCallback).toHaveBeenCalledWith({ frame: 1 })
  })

  it('ignores malformed inbound publish and service response payloads', async () => {
    const { bridge, ws } = await connectBridge()
    const callback = vi.fn()

    bridge.subscribe('/camera', 'sensor_msgs/Image', callback)
    const response = bridge.callService('/service', {}, 100)
    const call = sentMessages(ws).find((message) => message.op === 'call_service')

    ws.receive({ op: 'publish', msg: { frame: 1 } })
    ws.receive({ op: 'service_response', id: call?.id, values: { success: true }, result: 'true' })

    expect(callback).not.toHaveBeenCalled()

    ws.receive({ op: 'service_response', id: call?.id, values: { success: true }, result: true })
    await expect(response).resolves.toEqual({ success: true })
  })

  it('serializes advertise, publish, and unadvertise operations', async () => {
    const { bridge, ws } = await connectBridge()

    bridge.advertise('/cmd_vel', 'geometry_msgs/Twist')
    bridge.publish('/cmd_vel', { linear: { x: 1, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } })
    bridge.unadvertise('/cmd_vel')

    expect(sentMessages(ws).map((message) => message.op)).toEqual(['advertise', 'publish', 'unadvertise'])
    expect(sentMessages(ws)[1]).toMatchObject({
      topic: '/cmd_vel',
      msg: { linear: { x: 1, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } },
    })
  })

  it('rejects invalid outbound topics, message types, and queue parameters', async () => {
    const { bridge } = await connectBridge()

    expect(() => bridge.subscribe('relative/topic', 'sensor_msgs/Image', vi.fn())).toThrow('Invalid ROS topic: name must be absolute')
    expect(() => bridge.subscribe('/bad topic', 'sensor_msgs/Image', vi.fn())).toThrow('Invalid ROS topic: name contains invalid characters')
    expect(() => bridge.subscribe('/camera', 'Image', vi.fn())).toThrow('Invalid ROS message type')
    expect(() => bridge.subscribe('/camera', 'sensor_msgs/Image', vi.fn(), -1)).toThrow('Invalid ROS throttle rate')
    expect(() => bridge.advertise('/cmd_vel', 'Twist')).toThrow('Invalid ROS message type')
    expect(() => bridge.publish('//cmd_vel', {})).toThrow('Invalid ROS topic: name contains invalid characters')
  })

  it('resolves service calls from service_response messages', async () => {
    const { bridge, ws } = await connectBridge()

    const response = bridge.callService<{ request: boolean }, { success: boolean }>('/service', { request: true })
    const call = sentMessages(ws).find((message) => message.op === 'call_service')
    ws.receive({ op: 'service_response', id: call?.id, values: { success: true }, result: true })

    await expect(response).resolves.toEqual({ success: true })
    expect(call).toMatchObject({
      service: '/service',
      args: { request: true },
    })
  })

  it('rejects failed service responses', async () => {
    const { bridge, ws } = await connectBridge()

    const response = bridge.callService('/service', {})
    const call = sentMessages(ws).find((message) => message.op === 'call_service')
    ws.receive({ op: 'service_response', id: call?.id, values: {}, result: false })

    await expect(response).rejects.toThrow('Service call failed')
  })

  it('rejects service calls immediately when disconnected', async () => {
    const bridge = new ROSBridge({ url: 'ws://localhost:9090', autoReconnect: false })

    await expect(bridge.callService('/service', {})).rejects.toThrow('ROS bridge not connected')
  })

  it('rejects invalid service calls before sending', async () => {
    const { bridge, ws } = await connectBridge()

    await expect(bridge.callService('relative/service', {})).rejects.toThrow('Invalid ROS service: name must be absolute')
    await expect(bridge.callService('/service', {}, 0)).rejects.toThrow('Invalid ROS service timeout')
    expect(sentMessages(ws).filter((message) => message.op === 'call_service')).toHaveLength(0)
  })

  it('rejects service calls that time out', async () => {
    vi.useFakeTimers()
    const { bridge } = await connectBridge()

    const response = bridge.callService('/slow_service', {}, 100)
    const expectation = expect(response).rejects.toThrow('Service call to /slow_service timed out')
    await vi.advanceTimersByTimeAsync(100)

    await expectation
  })

  it('rejects pending service calls on disconnect', async () => {
    const { bridge, ws } = await connectBridge()

    const response = bridge.callService('/pending_service', {}, 1000)
    const expectation = expect(response).rejects.toThrow('Disconnected from ROS bridge')
    bridge.disconnect()

    await expectation
    expect(ws.closeCalls).toBe(1)
    expect(bridge.getState()).toBe('disconnected')
  })

  it('resubscribes and readvertises after reconnecting', async () => {
    vi.useFakeTimers()
    const { bridge, ws } = await connectBridge({
      autoReconnect: true,
      reconnectIntervalMs: 50,
      maxReconnectAttempts: 1,
    })
    bridge.subscribe('/pose', 'geometry_msgs/PoseStamped', vi.fn(), 25)
    bridge.advertise('/cmd_vel', 'geometry_msgs/Twist')

    ws.close()
    await vi.advanceTimersByTimeAsync(50)
    const reconnectWs = MockWebSocket.last()
    reconnectWs.open()
    await Promise.resolve()

    expect(reconnectWs).not.toBe(ws)
    expect(sentMessages(reconnectWs).map((message) => message.op)).toEqual(['subscribe', 'advertise'])
    expect(sentMessages(reconnectWs)[0]).toMatchObject({
      topic: '/pose',
      type: 'geometry_msgs/PoseStamped',
      throttle_rate: 25,
    })
  })
})
