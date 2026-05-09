import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TwistStamped } from '../types'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}))

import { ZenohBridge } from '../ZenohBridge'

describe('ZenohBridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
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

  it('rejects service calls because native Zenoh services are unsupported', async () => {
    const bridge = new ZenohBridge()

    await expect(bridge.callService('/gazebo/reset', {})).rejects.toThrow('Service calls are not supported')
  })
})
