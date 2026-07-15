import { describe, expect, it } from 'vitest'
import { createMessageRegistry } from '../MessageRegistry'

const rawPose = {
  position: [1, 2, 3],
  orientation: [0, 0, 0, 1],
  timestamp: 1.25,
  frame_id: 'map',
}

const rawImage = {
  data: 'AQID',
  width: 1,
  height: 1,
  encoding: 'rgb8',
  timestamp: 1.25,
  frame_id: 'camera',
  is_bigendian: 0,
  step: 3,
}

const rawCameraInfo = {
  height: 480,
  width: 640,
  distortion_model: 'plumb_bob',
  d: [0, 0, 0, 0, 0],
  k: Array<number>(9).fill(0),
  r: Array<number>(9).fill(0),
  p: Array<number>(12).fill(0),
  timestamp: 1.25,
  frame_id: 'camera',
}

describe('MessageRegistry', () => {
  it('maps exactly the native telemetry types to transport commands', () => {
    const registry = createMessageRegistry()

    expect(registry.getCommand('sensor_msgs/Image')).toBe('transport_subscribe_camera')
    expect(registry.getCommand('sensor_msgs/CompressedImage')).toBe(
      'transport_subscribe_camera'
    )
    expect(registry.getCommand('sensor_msgs/CameraInfo')).toBe(
      'transport_subscribe_camera_info'
    )
    expect(registry.getCommand('sensor_msgs/Imu')).toBe('transport_subscribe_imu')
    expect(registry.getCommand('geometry_msgs/PoseStamped')).toBe('transport_subscribe_pose')
    expect(registry.getCommand('gazebo_msgs/ModelStates')).toBe(
      'transport_subscribe_model_states'
    )
    expect(registry.isRegistered('std_msgs/String')).toBe(false)
    expect(registry.isRegistered('geometry_msgs/Twist')).toBe(false)
  })

  it('validates the raw native image contract rather than a ROS-shaped payload', () => {
    const registry = createMessageRegistry()

    expect(registry.validate('sensor_msgs/Image', rawImage)).toBe(true)
    expect(registry.validate('sensor_msgs/Image', { ...rawImage, data: [1, 2, 3] })).toBe(false)
    expect(registry.validate('sensor_msgs/Image', { ...rawImage, step: 4 })).toBe(false)
    expect(registry.validate('sensor_msgs/Image', { ...rawImage, extra: true })).toBe(false)

    expect(
      registry.validate('sensor_msgs/CompressedImage', {
        ...rawImage,
        data: 'iVBORw==',
        encoding: 'png',
      })
    ).toBe(true)
  })

  it('validates bounded native camera-info arrays', () => {
    const registry = createMessageRegistry()

    expect(registry.validate('sensor_msgs/CameraInfo', rawCameraInfo)).toBe(true)
    expect(registry.validate('sensor_msgs/CameraInfo', { ...rawCameraInfo, k: [1] })).toBe(false)
    expect(
      registry.validate('sensor_msgs/CameraInfo', {
        ...rawCameraInfo,
        d: Array<number>(33).fill(0),
      })
    ).toBe(false)
  })

  it('preserves the IMU unavailable-orientation sentinel while rejecting malformed tuples', () => {
    const registry = createMessageRegistry()
    const rawImu = {
      orientation: [0, 0, 0, 0],
      orientation_covariance: [-1, 0, 0, 0, 0, 0, 0, 0, 0],
      angular_velocity: [1, 2, 3],
      angular_velocity_covariance: Array<number>(9).fill(0),
      linear_acceleration: [4, 5, 6],
      linear_acceleration_covariance: Array<number>(9).fill(0),
      timestamp: 1.25,
      frame_id: 'imu',
    }

    expect(registry.validate('sensor_msgs/Imu', rawImu)).toBe(true)
    expect(
      registry.validate('sensor_msgs/Imu', {
        ...rawImu,
        orientation_covariance: Array<number>(9).fill(0),
      })
    ).toBe(false)
    expect(registry.validate('sensor_msgs/Imu', { ...rawImu, angular_velocity: [1, 2] })).toBe(
      false
    )
  })

  it('validates pose and equal-length model-state arrays', () => {
    const registry = createMessageRegistry()
    const modelStates = {
      name: ['drone'],
      pose: [rawPose],
      twist: [{ linear: [1, 0, 0], angular: [0, 0, 0] }],
    }

    expect(registry.validate('geometry_msgs/PoseStamped', rawPose)).toBe(true)
    expect(
      registry.validate('geometry_msgs/PoseStamped', {
        header: {},
        pose: { position: {}, orientation: {} },
      })
    ).toBe(false)
    expect(registry.validate('gazebo_msgs/ModelStates', modelStates)).toBe(true)
    expect(registry.validate('gazebo_msgs/ModelStates', { ...modelStates, twist: [] })).toBe(false)
  })

  it('enforces native pose and ModelStates numeric envelopes at exact limits', () => {
    const registry = createMessageRegistry()
    const atLimitPose = {
      ...rawPose,
      position: [1_000_000, 0, 0],
      orientation: [0, 0, 0, 1.01],
    }
    const atLimits = {
      name: ['drone'],
      pose: [{ ...atLimitPose, orientation: [0, 0, 0, 0.99] }],
      twist: [{ linear: [100, 0, 0], angular: [0, 0, 50] }],
    }

    expect(registry.validate('geometry_msgs/PoseStamped', atLimitPose)).toBe(true)
    expect(registry.validate('gazebo_msgs/ModelStates', atLimits)).toBe(true)
    expect(
      registry.validate('geometry_msgs/PoseStamped', {
        ...rawPose,
        position: [1_000_000 + 1e-6, 0, 0],
      })
    ).toBe(false)
    expect(
      registry.validate('geometry_msgs/PoseStamped', {
        ...rawPose,
        position: [Number.MAX_VALUE, 0, 0],
      })
    ).toBe(false)
    expect(
      registry.validate('geometry_msgs/PoseStamped', {
        ...rawPose,
        orientation: [0, 0, 0, 0.98],
      })
    ).toBe(false)
    expect(
      registry.validate('gazebo_msgs/ModelStates', {
        ...atLimits,
        twist: [{ linear: [100 + 1e-6, 0, 0], angular: [0, 0, 0] }],
      })
    ).toBe(false)
    expect(
      registry.validate('gazebo_msgs/ModelStates', {
        ...atLimits,
        twist: [{ linear: [0, 0, 0], angular: [0, 0, 50 + 1e-6] }],
      })
    ).toBe(false)
  })

  it('keeps builtin listings registered, deduplicated, and fail-closed', () => {
    const registry = createMessageRegistry()
    const builtinTypes = registry.getBuiltinTypes()

    expect(new Set(builtinTypes).size).toBe(builtinTypes.length)
    expect(registry.listTypes()).toEqual(builtinTypes)
    for (const type of builtinTypes) {
      expect(registry.isRegistered(type)).toBe(true)
      expect(registry.validate(type, null)).toBe(false)
    }
    expect(registry.validate('missing/Type', {})).toBe(false)
    expect(registry.getCommand('missing/Type')).toBeNull()
  })
})
