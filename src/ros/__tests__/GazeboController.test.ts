import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGazeboController } from '../GazeboController'
import type { Pose, Twist } from '../types'

function createBridge(overrides: Record<string, unknown> = {}): any {
  return {
    isConnected: vi.fn(() => true),
    subscribe: vi.fn(() => vi.fn()),
    callService: vi.fn(async () => ({})),
    ...overrides,
  }
}

const pose: Pose = {
  position: { x: 1, y: 2, z: 3 },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
}

const twist: Twist = {
  linear: { x: 0, y: 0, z: 0 },
  angular: { x: 0, y: 0, z: 0 },
}

describe('GazeboController', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('subscribes to clock updates on connect and cleans up on disconnect', () => {
    const unsubscribe = vi.fn()
    let clockCallback: ((msg: { clock: { secs: number; nsecs: number } }) => void) | undefined
    const bridge = createBridge({
      subscribe: vi.fn((_topic, _type, callback) => {
        clockCallback = callback
        return unsubscribe
      }),
    })
    const controller = createGazeboController()
    const onStateChange = vi.fn()
    controller.onStateChange(onStateChange)

    controller.connect(bridge)
    clockCallback?.({ clock: { secs: 12, nsecs: 500_000_000 } })
    controller.disconnect()

    expect(bridge.subscribe).toHaveBeenCalledWith('/clock', 'rosgraph_msgs/Clock', expect.any(Function), 100)
    expect(controller.getSimulationTime()).toBe(12.5)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(controller.isConnected()).toBe(false)
    expect(onStateChange).toHaveBeenCalled()
  })

  it('routes pause and unpause through Gazebo services and updates pause state', async () => {
    const bridge = createBridge()
    const controller = createGazeboController()
    controller.connect(bridge)

    await expect(controller.pause()).resolves.toBe(true)
    expect(controller.isPaused()).toBe(true)
    await expect(controller.unpause()).resolves.toBe(true)
    expect(controller.isPaused()).toBe(false)

    expect(bridge.callService).toHaveBeenNthCalledWith(1, '/gazebo/pause_physics', {})
    expect(bridge.callService).toHaveBeenNthCalledWith(2, '/gazebo/unpause_physics', {})
  })

  it('returns false for service calls when disconnected', async () => {
    const controller = createGazeboController()

    await expect(controller.pause()).resolves.toBe(false)
    await expect(controller.resetWorld()).resolves.toBe(false)
    await expect(controller.spawnSDF('model', '<sdf />', pose)).resolves.toBe(false)
    await expect(controller.deleteModel('model')).resolves.toBe(false)
  })

  it('resets simulation time after reset simulation succeeds', async () => {
    const bridge = createBridge()
    let clockCallback: ((msg: { clock: { secs: number; nsecs: number } }) => void) | undefined
    bridge.subscribe = vi.fn((_topic: string, _type: string, callback: (msg: { clock: { secs: number; nsecs: number } }) => void) => {
      clockCallback = callback
      return vi.fn()
    })
    const controller = createGazeboController()
    controller.connect(bridge)
    clockCallback?.({ clock: { secs: 42, nsecs: 0 } })

    await expect(controller.resetSimulation()).resolves.toBe(true)

    expect(bridge.callService).toHaveBeenCalledWith('/gazebo/reset_simulation', {})
    expect(controller.getSimulationTime()).toBe(0)
  })

  it('routes model spawn and delete requests', async () => {
    const bridge = createBridge({
      callService: vi.fn(async () => ({ success: true, status_message: 'ok' })),
    })
    const controller = createGazeboController()
    controller.connect(bridge)

    await expect(controller.spawnSDF('drone1', '<sdf />', pose, '/drone1', 'world')).resolves.toBe(true)
    await expect(controller.spawnURDF('robot1', '<robot />', pose, '/robot1', 'map')).resolves.toBe(true)
    await expect(controller.deleteModel('drone1')).resolves.toBe(true)

    expect(bridge.callService).toHaveBeenNthCalledWith(1, '/gazebo/spawn_sdf_model', {
      model_name: 'drone1',
      model_xml: '<sdf />',
      robot_namespace: '/drone1',
      initial_pose: pose,
      reference_frame: 'world',
    })
    expect(bridge.callService).toHaveBeenNthCalledWith(2, '/gazebo/spawn_urdf_model', {
      model_name: 'robot1',
      model_xml: '<robot />',
      robot_namespace: '/robot1',
      initial_pose: pose,
      reference_frame: 'map',
    })
    expect(bridge.callService).toHaveBeenNthCalledWith(3, '/gazebo/delete_model', { model_name: 'drone1' })
  })

  it('gets and sets model state including velocity updates', async () => {
    const bridge = createBridge({
      callService: vi.fn(async (service: string) => {
        if (service === '/gazebo/get_model_state') {
          return { success: true, status_message: 'ok', pose, twist }
        }
        return { success: true, status_message: 'ok' }
      }),
    })
    const controller = createGazeboController()
    controller.connect(bridge)

    await expect(controller.getModelState('drone1')).resolves.toEqual({ pose, twist })
    await expect(controller.setModelState('drone1', pose, twist, 'map')).resolves.toBe(true)
    await expect(controller.teleportModel('drone1', { x: 5, y: 6, z: 7 })).resolves.toBe(true)
    await expect(controller.setModelVelocity('drone1', { x: 1, y: 0, z: 0 })).resolves.toBe(true)

    expect(bridge.callService).toHaveBeenCalledWith('/gazebo/get_model_state', {
      model_name: 'drone1',
      relative_entity_name: 'world',
    })
    expect(bridge.callService).toHaveBeenCalledWith('/gazebo/set_model_state', {
      model_state: {
        model_name: 'drone1',
        pose,
        twist,
        reference_frame: 'map',
      },
    })
    expect(bridge.callService).toHaveBeenCalledWith('/gazebo/set_model_state', expect.objectContaining({
      model_state: expect.objectContaining({
        pose: { position: { x: 5, y: 6, z: 7 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      }),
    }))
  })

  it('returns failure values when Gazebo services reject or return unsuccessful responses', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bridge = createBridge({
      callService: vi.fn(async (service: string) => {
        if (service === '/gazebo/get_model_state') return { success: false, status_message: 'missing' }
        if (service === '/gazebo/delete_model') return { success: false, status_message: 'missing' }
        throw new Error('service unavailable')
      }),
    })
    const controller = createGazeboController()
    controller.connect(bridge)

    try {
      await expect(controller.pause()).resolves.toBe(false)
      await expect(controller.getModelState('missing')).resolves.toBeNull()
      await expect(controller.deleteModel('missing')).resolves.toBe(false)
    } finally {
      consoleError.mockRestore()
      consoleWarn.mockRestore()
    }
  })
})
