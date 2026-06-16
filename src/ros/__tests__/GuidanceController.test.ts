import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGuidanceController } from '../GuidanceController'
import type { ROSBridge } from '../ROSBridge'

function createBridge(connected = true) {
  return {
    isConnected: vi.fn(() => connected),
    advertise: vi.fn(),
    publishSetpointVelocity: vi.fn(),
  }
}

describe('GuidanceController', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalizes namespaces and advertises velocity setpoints when started', () => {
    const bridge = createBridge()
    const controller = createGuidanceController()

    controller.start(bridge as unknown as ROSBridge, '///drone1///')

    expect(controller.isActive()).toBe(true)
    expect(bridge.advertise).toHaveBeenCalledWith(
      '/drone1/mavros/setpoint_velocity/cmd_vel',
      'geometry_msgs/TwistStamped'
    )

    controller.stop()
  })

  it('ramps direct velocity commands and publishes stamped setpoints', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const bridge = createBridge()
    const controller = createGuidanceController({ rateHz: 10, maxAcceleration: 10, maxVelocity: 5 })
    const callback = vi.fn()
    controller.onCommand(callback)

    controller.start(bridge as unknown as ROSBridge, 'drone1')
    controller.setDirectVelocity({ x: 10, y: 0, z: 0 })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(100)

    const firstMessage = bridge.publishSetpointVelocity.mock.calls[0][1]
    const secondMessage = bridge.publishSetpointVelocity.mock.calls[1][1]
    expect(bridge.publishSetpointVelocity).toHaveBeenNthCalledWith(1, 'drone1', expect.any(Object))
    expect(firstMessage.header).toEqual({ seq: 0, stamp: { secs: 1, nsecs: 100_000_000 }, frame_id: 'base_link' })
    expect(firstMessage.twist.linear.x).toBeCloseTo(1)
    expect(secondMessage.header.seq).toBe(1)
    expect(secondMessage.twist.linear.x).toBeCloseTo(2)
    expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({
      velocity: expect.objectContaining({ x: 2, y: 0, z: 0 }),
      isEmergencyStop: false,
    }))

    controller.stop()
  })

  it('publishes zero velocity when the target is within the arrival threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const bridge = createBridge()
    const controller = createGuidanceController({ rateHz: 10, arrivalThreshold: 0.5 })
    const callback = vi.fn()
    controller.onCommand(callback)

    controller.start(bridge as unknown as ROSBridge, '/drone1/')
    controller.updateCurrentPosition({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    controller.setTargetPosition({ x: 0.25, y: 0, z: 0 })
    await vi.advanceTimersByTimeAsync(100)

    const message = bridge.publishSetpointVelocity.mock.calls[0][1]
    expect(message.twist.linear).toEqual({ x: 0, y: 0, z: 0 })
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      distanceToTarget: 0.25,
      estimatedTimeToArrival: 0,
      isEmergencyStop: false,
    }))

    controller.stop()
  })

  it('emergency stops immediately and notifies subscribers', () => {
    const bridge = createBridge()
    const controller = createGuidanceController()
    const callback = vi.fn()
    controller.onCommand(callback)

    controller.start(bridge as unknown as ROSBridge, '/drone1')
    controller.updateCurrentPosition({ x: 0, y: 0, z: 10 }, { x: 4, y: 0, z: 0 })
    controller.setDirectVelocity({ x: 4, y: 0, z: 0 })
    controller.emergencyStop()

    const message = bridge.publishSetpointVelocity.mock.calls[0][1]
    expect(message.twist.linear).toEqual({ x: 0, y: 0, z: 0 })
    expect(callback).toHaveBeenCalledWith({
      velocity: { x: 0, y: 0, z: 0 },
      isEmergencyStop: true,
      distanceToTarget: 0,
      estimatedTimeToArrival: 0,
    })

    controller.stop()
  })

  it('restarts the control loop when the configured rate changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000)
    const bridge = createBridge()
    const controller = createGuidanceController({ rateHz: 10 })

    controller.start(bridge as unknown as ROSBridge, 'drone1')
    controller.setConfig({ rateHz: 20 })
    bridge.publishSetpointVelocity.mockClear()
    controller.setDirectVelocity({ x: 1, y: 0, z: 0 })
    await vi.advanceTimersByTimeAsync(50)

    expect(controller.isActive()).toBe(true)
    expect(bridge.advertise).toHaveBeenCalledTimes(2)
    expect(bridge.publishSetpointVelocity).toHaveBeenCalledTimes(1)

    controller.stop()
  })
})
