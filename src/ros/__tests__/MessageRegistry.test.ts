import { describe, expect, it } from 'vitest'
import { createMessageRegistry } from '../MessageRegistry'

describe('MessageRegistry', () => {
  it('maps built-in message types to centralized transport commands', () => {
    const registry = createMessageRegistry()

    expect(registry.getCommand('sensor_msgs/Image')).toBe('transport_subscribe_camera')
    expect(registry.getCommand('sensor_msgs/CompressedImage')).toBe('transport_subscribe_camera')
    expect(registry.getCommand('sensor_msgs/CameraInfo')).toBe('transport_subscribe_camera_info')
    expect(registry.getCommand('sensor_msgs/Imu')).toBe('transport_subscribe_imu')
    expect(registry.getCommand('geometry_msgs/PoseStamped')).toBe('transport_subscribe_pose')
    expect(registry.getCommand('geometry_msgs/Twist')).toBe('transport_publish_velocity')
    expect(registry.getCommand('gazebo_msgs/ModelStates')).toBe('transport_subscribe_model_states')
  })

  it('validates supported sensor payload shapes', () => {
    const registry = createMessageRegistry()

    expect(registry.validate('sensor_msgs/Image', {
      data: 'base64',
      width: 640,
      height: 480,
      encoding: 'rgba8',
    })).toBe(true)
    expect(registry.validate('sensor_msgs/Image', {
      data: 'base64',
      width: 640,
      encoding: 'rgba8',
    })).toBe(false)

    expect(registry.validate('sensor_msgs/CameraInfo', {
      height: 480,
      width: 640,
      distortion_model: 'plumb_bob',
      d: [],
      k: [],
      r: [],
      p: [],
    })).toBe(true)
    expect(registry.validate('sensor_msgs/CameraInfo', { height: 480, width: 640 })).toBe(false)
  })

  it('validates pose, model state, and clock payloads', () => {
    const registry = createMessageRegistry()

    expect(registry.validate('geometry_msgs/PoseStamped', {
      header: {},
      pose: { position: {}, orientation: {} },
    })).toBe(true)
    expect(registry.validate('geometry_msgs/PoseStamped', { pose: {} })).toBe(false)
    expect(registry.validate('gazebo_msgs/ModelStates', { name: [], pose: [], twist: [] })).toBe(true)
    expect(registry.validate('gazebo_msgs/ModelStates', { name: [], pose: [] })).toBe(false)
    expect(registry.validate('rosgraph_msgs/Clock', { clock: { secs: 1, nsecs: 2 } })).toBe(true)
    expect(registry.validate('rosgraph_msgs/Clock', { clock: { secs: '1', nsecs: 2 } })).toBe(false)
  })

  it('validates standard message payloads', () => {
    const registry = createMessageRegistry()

    expect(registry.validate('std_msgs/Header', {
      stamp: { secs: 1, nsecs: 2 },
      frame_id: 'map',
    })).toBe(true)
    expect(registry.validate('std_msgs/Header', {
      stamp: { secs: 1 },
      frame_id: 'map',
    })).toBe(false)
    expect(registry.validate('std_msgs/String', { data: 'ready' })).toBe(true)
    expect(registry.validate('std_msgs/String', { data: 1 })).toBe(false)
  })

  it('validates velocity command payload boundaries', () => {
    const registry = createMessageRegistry()

    expect(registry.validate('geometry_msgs/Twist', {
      linear: [1, 2, 3],
      angular: [0, 0, 0],
    })).toBe(true)
    expect(registry.validate('geometry_msgs/Twist', {
      linear: { x: 1, y: 2, z: 3 },
      angular: [0, 0, 0],
    })).toBe(false)
    expect(registry.validate('geometry_msgs/Twist', {
      linear: [1, 2, 3],
    })).toBe(false)
  })

  it('keeps builtin type listings registered and deduplicated', () => {
    const registry = createMessageRegistry()
    const builtinTypes = registry.getBuiltinTypes()
    const listedTypes = registry.listTypes()

    expect(new Set(builtinTypes).size).toBe(builtinTypes.length)
    for (const type of builtinTypes) {
      expect(registry.isRegistered(type)).toBe(true)
      expect(listedTypes).toContain(type)
    }
  })

  it('returns false for malformed builtin payloads without throwing', () => {
    const registry = createMessageRegistry()

    for (const type of registry.getBuiltinTypes()) {
      expect(() => registry.validate(type, null)).not.toThrow()
      expect(registry.validate(type, null)).toBe(false)
    }
    expect(registry.validate('rosgraph_msgs/Clock', {})).toBe(false)
  })

  it('supports custom message registration', () => {
    const registry = createMessageRegistry()
    const mapper = (data: { value: number }) => ({ doubled: data.value * 2 })

    registry.register('custom/Value', {
      mapper,
      command: 'custom_command',
      validator: (data) => typeof data.value === 'number',
    })

    expect(registry.isRegistered('custom/Value')).toBe(true)
    expect(registry.getCommand('custom/Value')).toBe('custom_command')
    expect(registry.getMapper('custom/Value')?.({ value: 2 })).toEqual({ doubled: 4 })
    expect(registry.validate('custom/Value', { value: 2 })).toBe(true)
    expect(registry.validate('custom/Value', { value: '2' })).toBe(false)
  })

  it('returns safe defaults for unknown types', () => {
    const registry = createMessageRegistry()

    expect(registry.isRegistered('missing/Type')).toBe(false)
    expect(registry.getCommand('missing/Type')).toBeNull()
    expect(registry.getMapper('missing/Type')).toBeNull()
    expect(registry.validate('missing/Type', {})).toBe(false)
  })
})
