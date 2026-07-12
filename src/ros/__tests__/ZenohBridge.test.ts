import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('subscribes through the registry command and unsubscribes when the last listener is removed', async () => {
    invokeMock.mockResolvedValue(undefined)
    const unlisten = vi.fn()
    listenMock.mockResolvedValueOnce(unlisten)
    const bridge = new ZenohBridge()
    const callback = vi.fn()

    const unsubscribe = bridge.subscribe('/camera/image', 'sensor_msgs/Image', callback)
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledWith(getTransportEventName('/camera/image'), expect.any(Function)))
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('transport_subscribe_camera', {
        topic: '/camera/image',
        compressed: false,
      })
    )

    unsubscribe()

    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())
    expect(invokeMock).toHaveBeenCalledWith('transport_unsubscribe', { topic: '/camera/image' })
  })

  it('selects the compressed camera wire schema explicitly', async () => {
    invokeMock.mockResolvedValue(undefined)
    const bridge = new ZenohBridge()

    bridge.subscribe('/camera/custom_feed', 'sensor_msgs/CompressedImage', vi.fn())

    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('transport_subscribe_camera', {
        topic: '/camera/custom_feed',
        compressed: true,
      })
    )
  })

  it('rejects malformed topics before registering a native listener', () => {
    const bridge = new ZenohBridge()

    expect(() => bridge.subscribe('/über/image raw', 'sensor_msgs/Image', vi.fn())).toThrow(
      'Invalid native ROS topic'
    )
    expect(listenMock).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
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

  it('retains telemetry-only compatibility subscriptions', () => {
    const bridge = new ZenohBridge()

    expect(() => bridge.subscribeToOdometry('/drone1', vi.fn())).toThrow('Odometry subscriptions is not supported')
    expect(() => bridge.subscribeToState('/drone1', vi.fn())).toThrow('MAVROS state subscriptions is not supported')
  })

  it('has no public publish, service, Gazebo, or MAVROS command methods', () => {
    const bridge = new ZenohBridge() as unknown as Record<string, unknown>

    for (const method of [
      'publish',
      'publishAsync',
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
