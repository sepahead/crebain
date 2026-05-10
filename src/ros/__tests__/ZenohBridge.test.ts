import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TwistStamped } from '../types'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() => vi.fn(async () => vi.fn()))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

import { ZenohBridge } from '../ZenohBridge'
import { getTransportEventName } from '../../lib/transportEvents'

describe('ZenohBridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockClear()
  })

  it('connects through the native transport command', async () => {
    invokeMock.mockResolvedValue(undefined)
    const bridge = new ZenohBridge()
    const states: string[] = []
    bridge.onStateChange = state => states.push(state)

    await bridge.connect()

    expect(invokeMock).toHaveBeenCalledWith('transport_connect')
    expect(states).toEqual(['connecting', 'connected'])
    expect(bridge.isConnected()).toBe(true)
  })

  it('resets connection state when native connect fails', async () => {
    invokeMock.mockRejectedValue(new Error('zenoh unavailable'))
    const bridge = new ZenohBridge()
    const states: string[] = []
    bridge.onStateChange = state => states.push(state)

    await expect(bridge.connect()).rejects.toThrow('zenoh unavailable')

    expect(states).toEqual(['connecting', 'disconnected'])
    expect(bridge.isConnected()).toBe(false)
  })

  it('publishes normalized setpoint velocity commands', () => {
    invokeMock.mockResolvedValue(undefined)
    const bridge = new ZenohBridge()
    const twist: TwistStamped = {
      header: { stamp: { secs: 10, nsecs: 500_000_000 }, frame_id: 'map' },
      twist: {
        linear: { x: 1, y: 2, z: 3 },
        angular: { x: 0.1, y: 0.2, z: 0.3 },
      },
    }

    bridge.publishSetpointVelocity('/drone1/', twist)

    expect(invokeMock).toHaveBeenCalledWith('transport_publish_twist_stamped', {
      topic: '/drone1/mavros/setpoint_velocity/cmd_vel',
      cmd: {
        twist: {
          linear: [1, 2, 3],
          angular: [0.1, 0.2, 0.3],
        },
        timestamp: 10.5,
        frame_id: 'map',
      },
    })
  })

  it('handles malformed legacy publish payloads as unsupported messages', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const bridge = new ZenohBridge()

    try {
      bridge.publish('/cmd_vel', null)
    } finally {
      consoleError.mockRestore()
    }

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('subscribes through the registry command and unsubscribes when the last listener is removed', async () => {
    invokeMock.mockResolvedValue(undefined)
    const unlisten = vi.fn()
    listenMock.mockResolvedValueOnce(unlisten)
    const bridge = new ZenohBridge()
    const callback = vi.fn()

    const unsubscribe = bridge.subscribe('/camera/image', 'sensor_msgs/Image', callback)
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledWith(getTransportEventName('/camera/image'), expect.any(Function)))
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('transport_subscribe_camera', { topic: '/camera/image' }))

    unsubscribe()

    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())
    expect(invokeMock).toHaveBeenCalledWith('transport_unsubscribe', { topic: '/camera/image' })
  })

  it('listens on sanitized event names for unsafe topic characters', async () => {
    invokeMock.mockResolvedValue(undefined)
    const bridge = new ZenohBridge()

    bridge.subscribe('/über/image raw', 'sensor_msgs/Image', vi.fn())

    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledWith(
      getTransportEventName('/über/image raw'),
      expect.any(Function)
    ))
    expect(getTransportEventName('/über/image raw')).toBe('crebain.transport.%2F%C3%BCber%2Fimage%20raw')
  })

  it('cleans up the event listener when backend subscription fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unlisten = vi.fn()
    listenMock.mockResolvedValueOnce(unlisten)
    invokeMock.mockRejectedValueOnce(new Error('subscribe failed'))
    const bridge = new ZenohBridge()

    try {
      bridge.subscribe('/camera/info', 'sensor_msgs/CameraInfo', vi.fn())
      await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())
    } finally {
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    }

    expect(invokeMock).toHaveBeenCalledWith('transport_subscribe_camera_info', { topic: '/camera/info' })
  })

  it('rejects service calls because native Zenoh services are unsupported', async () => {
    const bridge = new ZenohBridge()

    await expect(bridge.callService('/gazebo/reset', {})).rejects.toThrow('Service calls are not supported')
  })
})
