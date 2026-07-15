import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROSBridge, validateRosUrl, type ROSBridgeConfig } from '../ROSBridge'
import { installMockWebSocket, MockWebSocket, sentMessages } from '../../test/mockWebSocket'
import { MAX_TF_TRANSLATION_METERS } from '../tfValidation'

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

function rawImage(frame: number) {
  return {
    header: {
      seq: frame,
      stamp: { secs: 1, nsecs: 0 },
      frame_id: 'camera',
    },
    height: 1,
    width: 1,
    encoding: 'rgb8',
    is_bigendian: 0,
    step: 3,
    data: [1, 2, 3],
  }
}

const ROS_HEADER = {
  seq: 1,
  stamp: { secs: 1, nsecs: 0 },
  frame_id: 'world',
}

function telemetryPose(positionX: number, orientationW: number) {
  return {
    position: { x: positionX, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: orientationW },
  }
}

function telemetryTwist(linearX: number, angularZ: number) {
  return {
    linear: { x: linearX, y: 0, z: 0 },
    angular: { x: 0, y: 0, z: angularZ },
  }
}

function receiveRaw(ws: MockWebSocket, data: string): void {
  ws.onmessage?.({ data } as MessageEvent)
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

  it('gives every consumer an exact subscription ID and dispatches telemetry once', async () => {
    const { bridge, ws } = await connectBridge()
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()

    const unsubscribeFirst = bridge.subscribe('/camera', 'sensor_msgs/Image', firstCallback, 50, 10)
    const unsubscribeSecond = bridge.subscribe('/camera', 'sensor_msgs/Image', secondCallback, 50, 10)
    ws.receive({ op: 'publish', topic: '/camera', msg: rawImage(1) })
    unsubscribeFirst()
    unsubscribeSecond()

    const subscribes = sentMessages(ws).filter((message) => message.op === 'subscribe')
    const unsubscribes = sentMessages(ws).filter((message) => message.op === 'unsubscribe')
    expect(subscribes).toHaveLength(2)
    expect(subscribes).toEqual([
      expect.objectContaining({
        topic: '/camera',
        type: 'sensor_msgs/Image',
        throttle_rate: 50,
        queue_length: 10,
      }),
      expect.objectContaining({
        topic: '/camera',
        type: 'sensor_msgs/Image',
        throttle_rate: 50,
        queue_length: 10,
      }),
    ])
    expect(subscribes[0].id).not.toBe(subscribes[1].id)
    expect(unsubscribes.map((message) => message.id)).toEqual(
      subscribes.map((message) => message.id)
    )
    expect(firstCallback).toHaveBeenCalledWith(rawImage(1))
    expect(secondCallback).toHaveBeenCalledWith(rawImage(1))
  })

  it('ignores malformed inbound publish payloads', async () => {
    const { bridge, ws } = await connectBridge()
    const callback = vi.fn()

    bridge.subscribe('/camera', 'sensor_msgs/Image', callback)
    ws.receive({ op: 'publish', msg: { frame: 1 } })

    expect(callback).not.toHaveBeenCalled()
  })

  it('rejects same-topic type conflicts before creating a server subscription', async () => {
    const { bridge, ws } = await connectBridge()
    bridge.subscribe('/camera', 'sensor_msgs/Image', vi.fn())

    expect(() =>
      bridge.subscribe('/camera', 'sensor_msgs/CompressedImage', vi.fn())
    ).toThrow('refusing conflicting type')
    expect(sentMessages(ws).filter((message) => message.op === 'subscribe')).toHaveLength(1)
  })

  it('requires a runtime schema for non-built-in message types', async () => {
    const { bridge } = await connectBridge()

    expect(() => bridge.subscribe('/custom', 'custom_msgs/Telemetry', vi.fn())).toThrow(
      'No runtime schema is registered'
    )
    expect(() =>
      bridge.subscribe('/custom', 'custom_msgs/Telemetry', vi.fn(), undefined, undefined, (value) =>
        Boolean(value && typeof value === 'object' && 'reading' in value)
      )
    ).not.toThrow()
  })

  it('rejects duplicate keys, unexpected envelope fields, and schema-invalid payloads', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ onError })
    const callback = vi.fn()
    bridge.subscribe('/camera', 'sensor_msgs/Image', callback)

    receiveRaw(
      ws,
      '{"op":"publish","topic":"/camera","msg":{"width":1,"\\u0077idth":2}}'
    )
    ws.receive({ op: 'publish', topic: '/camera', msg: rawImage(1), unexpected: true })
    ws.receive({ op: 'publish', topic: '/camera', msg: { frame: 1 } })

    expect(callback).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(3)
    expect(onError.mock.calls.map(([error]) => String(error))).toEqual([
      expect.stringContaining('duplicate JSON object key'),
      expect.stringContaining('malformed ROS bridge publish envelope'),
      expect.stringContaining('did not match its runtime schema'),
    ])
  })

  it('enforces bounded frame, translation, and quaternion schemas for TF ingress', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ onError })
    const callback = vi.fn()
    bridge.subscribe('/tf', 'tf2_msgs/TFMessage', callback)
    const validTransform = {
      header: { stamp: { secs: 1, nsecs: 0 }, frame_id: 'world' },
      child_frame_id: 'base_link',
      transform: {
        translation: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0, w: 1.0005 },
      },
    }

    for (const transform of [
      { ...validTransform, header: { ...validTransform.header, frame_id: '' } },
      { ...validTransform, child_frame_id: '' },
      {
        ...validTransform,
        transform: { ...validTransform.transform, rotation: { x: 0, y: 0, z: 0, w: 0 } },
      },
      {
        ...validTransform,
        transform: { ...validTransform.transform, rotation: { x: 0, y: 0, z: 0, w: 0.5 } },
      },
      {
        ...validTransform,
        transform: {
          ...validTransform.transform,
          translation: { x: MAX_TF_TRANSLATION_METERS + 1, y: 0, z: 0 },
        },
      },
    ]) {
      ws.receive({ op: 'publish', topic: '/tf', msg: { transforms: [transform] } })
    }
    ws.receive({ op: 'publish', topic: '/tf', msg: { transforms: [validTransform] } })

    expect(onError).toHaveBeenCalledTimes(5)
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ transforms: [validTransform] })
  })

  it('enforces inclusive pose and twist magnitude bounds for ModelStates ingress', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ onError })
    const callback = vi.fn()
    bridge.subscribe('/gazebo/model_states', 'gazebo_msgs/ModelStates', callback)
    const atLimits = {
      name: ['drone'],
      pose: [telemetryPose(1_000_000, 0.99)],
      twist: [telemetryTwist(100, 50)],
    }
    const publish = (msg: unknown) =>
      ws.receive({ op: 'publish', topic: '/gazebo/model_states', msg })

    publish(atLimits)
    publish({ ...atLimits, pose: [telemetryPose(1_000_000 + 1e-6, 1)] })
    publish({ ...atLimits, pose: [telemetryPose(Number.MAX_VALUE, 1)] })
    publish({ ...atLimits, pose: [telemetryPose(0, 0.98)] })
    publish({ ...atLimits, twist: [telemetryTwist(100 + 1e-6, 0)] })
    publish({ ...atLimits, twist: [telemetryTwist(0, 50 + 1e-6)] })

    expect(callback).toHaveBeenCalledOnce()
    const delivered = callback.mock.calls[0]?.[0]
    expect(delivered).toEqual(atLimits)
    expect(
      [
        delivered.pose[0].position.x,
        delivered.pose[0].orientation.w,
        delivered.twist[0].linear.x,
        delivered.twist[0].angular.z,
      ].every(Number.isFinite)
    ).toBe(true)
    expect(onError).toHaveBeenCalledTimes(5)
  })

  it('applies the pose and twist envelope to consumed PoseStamped and Odometry', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ onError })
    const poseCallback = vi.fn()
    const odometryCallback = vi.fn()
    bridge.subscribe('/pose', 'geometry_msgs/PoseStamped', poseCallback)
    bridge.subscribe('/odometry', 'nav_msgs/Odometry', odometryCallback)
    const poseStamped = { header: ROS_HEADER, pose: telemetryPose(1_000_000, 1.01) }
    const odometry = {
      header: ROS_HEADER,
      child_frame_id: 'base_link',
      pose: { pose: telemetryPose(1_000_000, 0.99), covariance: Array(36).fill(0) },
      twist: { twist: telemetryTwist(100, 50), covariance: Array(36).fill(0) },
    }

    ws.receive({ op: 'publish', topic: '/pose', msg: poseStamped })
    ws.receive({ op: 'publish', topic: '/odometry', msg: odometry })
    ws.receive({
      op: 'publish',
      topic: '/pose',
      msg: { ...poseStamped, pose: telemetryPose(1_000_000 + 1e-6, 1) },
    })
    ws.receive({
      op: 'publish',
      topic: '/odometry',
      msg: {
        ...odometry,
        twist: {
          ...odometry.twist,
          twist: telemetryTwist(0, 50 + 1e-6),
        },
      },
    })

    expect(poseCallback).toHaveBeenCalledWith(poseStamped)
    expect(odometryCallback).toHaveBeenCalledWith(odometry)
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('requires and preserves the canonical LIDAR covariance tuple', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ onError })
    const callback = vi.fn()
    bridge.subscribe(
      '/crebain/lidar/detections',
      'crebain_msgs/LidarDetectionArray',
      callback
    )
    const validDetection = {
      header: { stamp: { secs: 10, nsecs: 500_000_000 }, frame_id: 'lidar' },
      id: 'lidar-1',
      centroid: { x: 1, y: 2, z: 3 },
      bbox_min: { x: 0, y: 1, z: 2 },
      bbox_max: { x: 2, y: 3, z: 4 },
      velocity: { x: 0.1, y: 0.2, z: 0.3 },
      covariance: [0.04, 0.09, 0.16],
      num_points: 42,
      confidence: 0.85,
      classification: 'drone',
    }
    const envelope = (detection: Record<string, unknown>) => ({
      header: { stamp: { secs: 10, nsecs: 500_000_000 }, frame_id: 'lidar' },
      detections: [detection],
    })
    const { covariance: _omitted, ...missingCovariance } = validDetection

    ws.receive({
      op: 'publish',
      topic: '/crebain/lidar/detections',
      msg: envelope(missingCovariance),
    })
    ws.receive({
      op: 'publish',
      topic: '/crebain/lidar/detections',
      msg: envelope({ ...validDetection, covariance: [0, 0.09, 0.16] }),
    })
    ws.receive({
      op: 'publish',
      topic: '/crebain/lidar/detections',
      msg: envelope(validDetection),
    })

    expect(_omitted).toEqual([0.04, 0.09, 0.16])
    expect(onError).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith(envelope(validDetection))
  })

  it('enforces a configurable inbound byte limit below the hard ceiling', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ maxIncomingMessageBytes: 64, onError })
    bridge.subscribe('/camera', 'sensor_msgs/Image', vi.fn())

    receiveRaw(ws, JSON.stringify({ op: 'publish', topic: '/camera', msg: rawImage(1) }))

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('inbound byte limit') })
    )
  })

  it('isolates callback failures so later consumers still receive valid data', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ onError })
    const laterCallback = vi.fn()
    bridge.subscribe('/camera', 'sensor_msgs/Image', () => {
      throw new Error('consumer failed')
    })
    bridge.subscribe('/camera', 'sensor_msgs/Image', laterCallback)

    ws.receive({ op: 'publish', topic: '/camera', msg: rawImage(2) })

    expect(laterCallback).toHaveBeenCalledWith(rawImage(2))
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('consumer failed') })
    )
  })

  it('reports rejected callback promises without blocking later consumers', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ onError })
    const laterCallback = vi.fn()
    bridge.subscribe('/camera', 'sensor_msgs/Image', async () => {
      throw new Error('asynchronous consumer failed')
    })
    bridge.subscribe('/camera', 'sensor_msgs/Image', laterCallback)

    ws.receive({ op: 'publish', topic: '/camera', msg: rawImage(2) })
    await Promise.resolve()

    expect(laterCallback).toHaveBeenCalledWith(rawImage(2))
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('asynchronous consumer failed') })
    )
  })

  it('isolates a throwing error observer so later consumers still receive data', async () => {
    const { bridge, ws } = await connectBridge({
      onError: () => {
        throw new Error('observer failed')
      },
    })
    const laterCallback = vi.fn()
    bridge.subscribe('/camera', 'sensor_msgs/Image', () => {
      throw new Error('consumer failed')
    })
    bridge.subscribe('/camera', 'sensor_msgs/Image', laterCallback)

    ws.receive({ op: 'publish', topic: '/camera', msg: rawImage(3) })

    expect(laterCallback).toHaveBeenCalledWith(rawImage(3))
  })

  it('attributes status responses only to active subscription IDs', async () => {
    const onError = vi.fn()
    const { bridge, ws } = await connectBridge({ onError })
    bridge.subscribe('/camera', 'sensor_msgs/Image', vi.fn())
    const subscribeId = sentMessages(ws).find((message) => message.op === 'subscribe')?.id

    ws.receive({ op: 'status', id: 'unknown', level: 'error', msg: 'unrelated' })
    ws.receive({ op: 'status', id: subscribeId, level: 'warning', msg: 'known request' })

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('known request') })
    )
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
    expect(sentMessages(reconnectWs)[0].id).toBe(
      sentMessages(ws).find((message) => message.op === 'subscribe')?.id
    )
  })

  it('settles connect even when state and connect observers throw', async () => {
    const onStateChange = vi.fn(() => {
      throw new Error('state observer failed')
    })
    const onConnect = vi.fn(() => {
      throw new Error('connect observer failed')
    })
    const bridge = new ROSBridge({
      url: 'ws://localhost:9090',
      autoReconnect: false,
      onStateChange,
      onConnect,
    })

    const promise = bridge.connect()
    const ws = MockWebSocket.last()
    ws.open()

    await expect(promise).resolves.toBeUndefined()
    expect(bridge.getState()).toBe('connected')
    expect(onStateChange).toHaveBeenCalledWith('connected')
    expect(onConnect).toHaveBeenCalledOnce()
  })

  it('rejects a failed connect even when the error observer throws', async () => {
    const bridge = new ROSBridge({
      url: 'ws://localhost:9090',
      autoReconnect: false,
      onError: () => {
        throw new Error('error observer failed')
      },
    })

    const promise = bridge.connect()
    MockWebSocket.last().error('failed-connect')

    await expect(promise).rejects.toThrow('WebSocket error: failed-connect')
  })

  it('reconnects even when disconnect and state observers throw', async () => {
    vi.useFakeTimers()
    const onDisconnect = vi.fn(() => {
      throw new Error('disconnect observer failed')
    })
    const bridge = new ROSBridge({
      url: 'ws://localhost:9090',
      autoReconnect: true,
      reconnectIntervalMs: 50,
      maxReconnectAttempts: 1,
      onDisconnect,
      onStateChange: () => {
        throw new Error('state observer failed')
      },
    })
    const promise = bridge.connect()
    const first = MockWebSocket.last()
    first.open()
    await promise

    first.close()
    await vi.advanceTimersByTimeAsync(50)
    const replacement = MockWebSocket.last()
    expect(replacement).not.toBe(first)
    replacement.open()
    await Promise.resolve()

    expect(onDisconnect).toHaveBeenCalledOnce()
    expect(bridge.getState()).toBe('connected')
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
