import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())
const listenMock = vi.hoisted(() =>
  vi.fn(
    async (
      _eventName: string,
      _handler: (event: { payload: unknown }) => void
    ): Promise<unknown> => vi.fn()
  )
)

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

import { ZenohBridge } from '../ZenohBridge'
import { getTransportEventName } from '../../lib/transportEvents'
import type { Image, PoseStamped, ROSMessageCallback } from '../types'

const MAX_U64_DECIMAL = '18446744073709551615'

function rawImage(timestamp: number) {
  return {
    data: 'AQID',
    width: 1,
    height: 1,
    encoding: 'rgb8',
    timestamp,
    frame_id: 'camera',
    is_bigendian: 0,
    step: 3,
  }
}

function rawPose(positionX: number, orientationW: number) {
  return {
    position: [positionX, 0, 0],
    orientation: [0, 0, 0, orientationW],
    timestamp: 1.25,
    frame_id: 'world',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function nativeDisconnectCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'transport_disconnect')
}

function cameraTakeCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'transport_take_camera_frame')
}

function cameraSubscribeCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'transport_subscribe_camera')
}

function cameraSubscriptionId(callIndex = cameraSubscribeCalls().length - 1): string {
  const value = (cameraSubscribeCalls()[callIndex]?.[1] as Record<string, unknown> | undefined)
    ?.cameraSubscriptionId
  if (typeof value !== 'string') throw new Error('Camera subscription identity is unavailable')
  return value
}

function cameraReady(
  deliveryId: string,
  generation: string,
  subscriptionId = cameraSubscriptionId()
) {
  return { deliveryId, generation, cameraSubscriptionId: subscriptionId }
}

function nativeUnsubscribeCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'transport_unsubscribe')
}

function cameraAckCalls() {
  return invokeMock.mock.calls.filter(([command]) => command === 'transport_ack_camera_frame')
}

describe('ZenohBridge', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects through the native transport command', async () => {
    invokeMock.mockResolvedValue('7')
    const bridge = new ZenohBridge()
    const states: string[] = []
    bridge.onStateChange = state => states.push(state)

    await bridge.connect()

    expect(invokeMock).toHaveBeenCalledWith('transport_connect')
    expect(states).toEqual(['connecting', 'connected'])
    expect(bridge.isConnected()).toBe(true)
  })

  it('retains the maximum u64 lifecycle generation exactly through camera delivery', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve(MAX_U64_DECIMAL)
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/max_generation', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))

    expect(cameraSubscribeCalls()[0]?.[1]).toMatchObject({ generation: MAX_U64_DECIMAL })
    eventHandler?.({ payload: cameraReady('1', MAX_U64_DECIMAL) })

    await vi.waitFor(() => expect(cameraAckCalls()).toHaveLength(1))
    expect(cameraTakeCalls()[0]?.[1]).toMatchObject({ generation: MAX_U64_DECIMAL })
    expect(cameraAckCalls()[0]?.[1]).toMatchObject({ generation: MAX_U64_DECIMAL })
  })

  it.each([
    ['safe integer number', 7],
    ['unsafe integer number', Number.MAX_SAFE_INTEGER + 1],
    ['zero', '0'],
    ['leading zero', '01'],
    ['signed decimal', '+1'],
    ['u64 overflow', '18446744073709551616'],
  ])('rejects a noncanonical native lifecycle generation: %s', async (_label, value) => {
    invokeMock.mockResolvedValue(value)
    const bridge = new ZenohBridge()

    await expect(bridge.connect()).rejects.toThrow(
      'Native transport returned an invalid lifecycle generation'
    )
    expect(bridge.getState()).toBe('disconnected')
    expect(nativeDisconnectCalls()).toEqual([])
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
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '7' : undefined)
    )
    const unlisten = vi.fn()
    listenMock.mockResolvedValueOnce(unlisten)
    const bridge = new ZenohBridge()
    const callback = vi.fn()
    await bridge.connect()

    const unsubscribe = bridge.subscribe('/camera/image', 'sensor_msgs/Image', callback)
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledWith(getTransportEventName('/camera/image'), expect.any(Function)))
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('transport_subscribe_camera', {
        topic: '/camera/image',
        compressed: false,
        cameraSubscriptionId: expect.stringMatching(/^[1-9][0-9]*$/),
        generation: '7',
      })
    )

    unsubscribe()

    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())
    expect(invokeMock).toHaveBeenCalledWith('transport_unsubscribe', {
      topic: '/camera/image',
      cameraSubscriptionId: expect.stringMatching(/^[1-9][0-9]*$/),
      generation: '7',
    })
  })

  it('selects the compressed camera wire schema explicitly', async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '11' : undefined)
    )
    const bridge = new ZenohBridge()
    await bridge.connect()

    bridge.subscribe('/camera/custom_feed', 'sensor_msgs/CompressedImage', vi.fn())

    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('transport_subscribe_camera', {
        topic: '/camera/custom_feed',
        compressed: true,
        cameraSubscriptionId: expect.stringMatching(/^[1-9][0-9]*$/),
        generation: '11',
      })
    )
  })

  it('assigns an exact new native identity when a camera topic is reopened', async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '12' : undefined)
    )
    const bridge = new ZenohBridge()
    await bridge.connect()

    const unsubscribeFirst = bridge.subscribe(
      '/camera/reopened',
      'sensor_msgs/Image',
      vi.fn()
    )
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))
    const firstIdentity = (cameraSubscribeCalls()[0]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId
    unsubscribeFirst()
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))

    bridge.subscribe('/camera/reopened', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(2))
    const secondIdentity = (cameraSubscribeCalls()[1]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId

    expect(firstIdentity).toEqual(expect.stringMatching(/^[1-9][0-9]*$/))
    expect(secondIdentity).toEqual(expect.stringMatching(/^[1-9][0-9]*$/))
    expect(secondIdentity).not.toBe(firstIdentity)
    expect(nativeUnsubscribeCalls()[0]?.[1]).toEqual({
      topic: '/camera/reopened',
      generation: '12',
      cameraSubscriptionId: firstIdentity,
    })
  })

  it('rejects an old readiness identity without deactivating the reopened listener', async () => {
    const eventHandlers: Array<(event: { payload: unknown }) => void> = []
    listenMock.mockImplementation(async (_eventName, handler) => {
      eventHandlers.push(handler)
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('121')
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    const closeOld = bridge.subscribe('/camera/identity_race', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))
    const oldIdentity = cameraSubscriptionId(0)

    closeOld()
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))
    const reopenedCallback = vi.fn()
    bridge.subscribe('/camera/identity_race', 'sensor_msgs/Image', reopenedCallback)
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(2))
    const reopenedIdentity = cameraSubscriptionId(1)

    eventHandlers[1]?.({ payload: cameraReady('41', '121', oldIdentity) })
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(2))
    expect(cameraTakeCalls()).toEqual([])
    expect(nativeUnsubscribeCalls()[1]?.[1]).toEqual({
      topic: '/camera/identity_race',
      generation: '121',
      cameraSubscriptionId: oldIdentity,
    })

    eventHandlers[1]?.({ payload: cameraReady('42', '121', reopenedIdentity) })
    await vi.waitFor(() => expect(reopenedCallback).toHaveBeenCalledOnce())
    expect(cameraTakeCalls()[0]?.[1]).toEqual({
      topic: '/camera/identity_race',
      deliveryId: '42',
      cameraSubscriptionId: reopenedIdentity,
      generation: '121',
    })
    await vi.waitFor(() => expect(cameraAckCalls()).toHaveLength(1))
  })

  it('does not let a stale identity displace a valid descriptor queued behind acknowledgement', async () => {
    const eventHandlers: Array<(event: { payload: unknown }) => void> = []
    listenMock.mockImplementation(async (_eventName, handler) => {
      eventHandlers.push(handler)
      return vi.fn()
    })
    const firstAck = deferred<void>()
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'transport_connect') return Promise.resolve('122')
      if (command === 'transport_take_camera_frame') {
        return Promise.resolve(rawImage(Number(args?.deliveryId)))
      }
      if (command === 'transport_ack_camera_frame' && args?.deliveryId === '1') {
        return firstAck.promise
      }
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    const closeOld = bridge.subscribe('/camera/pending_identity', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))
    const oldIdentity = cameraSubscriptionId(0)
    closeOld()
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))

    const callback = vi.fn()
    bridge.subscribe('/camera/pending_identity', 'sensor_msgs/Image', callback)
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(2))
    const currentIdentity = cameraSubscriptionId(1)

    eventHandlers[1]?.({ payload: cameraReady('1', '122', currentIdentity) })
    await vi.waitFor(() => expect(cameraAckCalls()).toHaveLength(1))
    eventHandlers[1]?.({ payload: cameraReady('2', '122', oldIdentity) })
    eventHandlers[1]?.({ payload: cameraReady('3', '122', currentIdentity) })
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(2))

    expect(cameraTakeCalls().map(([, args]) => args?.deliveryId)).toEqual(['1'])
    firstAck.resolve()

    await vi.waitFor(() => expect(cameraTakeCalls()).toHaveLength(2))
    expect(cameraTakeCalls().map(([, args]) => args?.deliveryId)).toEqual(['1', '3'])
    await vi.waitFor(() => expect(cameraAckCalls()).toHaveLength(2))
    expect(callback).toHaveBeenCalledTimes(2)
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
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('13')
      if (command === 'transport_subscribe_camera_info') {
        return Promise.reject(new Error('subscribe failed'))
      }
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()

    try {
      bridge.subscribe('/camera/info', 'sensor_msgs/CameraInfo', vi.fn())
      await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())
    } finally {
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    }

    expect(invokeMock).toHaveBeenCalledWith('transport_subscribe_camera_info', {
      topic: '/camera/info',
      generation: '13',
    })
  })

  it('uses the exact camera identity to clean up a failed native setup', async () => {
    const unlisten = vi.fn()
    listenMock.mockResolvedValueOnce(unlisten)
    let cameraSubscribeAttempts = 0
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('14')
      if (command === 'transport_subscribe_camera') {
        cameraSubscribeAttempts += 1
        return cameraSubscribeAttempts === 1
          ? Promise.reject(new Error('camera subscribe failed'))
          : Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()

    bridge.subscribe('/camera/setup_failure', 'sensor_msgs/Image', vi.fn())

    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))
    const subscribeIdentity = (cameraSubscribeCalls()[0]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId
    expect(unlisten).toHaveBeenCalledOnce()
    expect(nativeUnsubscribeCalls()[0]?.[1]).toEqual({
      topic: '/camera/setup_failure',
      generation: '14',
      cameraSubscriptionId: subscribeIdentity,
    })

    await Promise.resolve()
    await Promise.resolve()
    bridge.subscribe('/camera/setup_failure', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(2))
    const reopenedIdentity = (cameraSubscribeCalls()[1]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId
    expect(reopenedIdentity).toEqual(expect.stringMatching(/^[1-9][0-9]*$/))
    expect(reopenedIdentity).not.toBe(subscribeIdentity)
  })

  it('bounds a non-settling camera setup and reopens with a fresh identity', async () => {
    vi.useFakeTimers()
    let cameraSubscribeAttempts = 0
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('141')
      if (command === 'transport_subscribe_camera') {
        cameraSubscribeAttempts += 1
        return cameraSubscribeAttempts === 1
          ? new Promise<void>(() => undefined)
          : Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/setup_timeout', 'sensor_msgs/Image', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    const retiredIdentity = (cameraSubscribeCalls()[0]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId

    await vi.advanceTimersByTimeAsync(11_999)
    expect(nativeUnsubscribeCalls()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(nativeUnsubscribeCalls()[0]?.[1]).toEqual({
      topic: '/camera/setup_timeout',
      generation: '141',
      cameraSubscriptionId: retiredIdentity,
    })

    await vi.advanceTimersByTimeAsync(0)
    bridge.subscribe('/camera/setup_timeout', 'sensor_msgs/Image', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    const reopenedIdentity = (cameraSubscribeCalls()[1]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId
    expect(reopenedIdentity).toEqual(expect.stringMatching(/^[1-9][0-9]*$/))
    expect(reopenedIdentity).not.toBe(retiredIdentity)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds listener registration and releases an unlisten that resolves after timeout', async () => {
    vi.useFakeTimers()
    const registration = deferred<() => void>()
    const lateUnlisten = vi.fn()
    listenMock.mockReturnValueOnce(registration.promise)
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '143' : undefined)
    )
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/listen_timeout', 'sensor_msgs/Image', vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(11_999)
    expect(cameraSubscribeCalls()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(cameraSubscribeCalls()).toEqual([])

    bridge.subscribe('/camera/listen_timeout', 'sensor_msgs/Image', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(cameraSubscribeCalls()).toHaveLength(1)

    registration.resolve(lateUnlisten)
    await vi.advanceTimersByTimeAsync(0)
    expect(lateUnlisten).toHaveBeenCalledOnce()
    expect(cameraSubscribeCalls()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one setup deadline between listener registration and native declaration', async () => {
    vi.useFakeTimers()
    const registration = deferred<() => void>()
    const setup = deferred<void>()
    const unlisten = vi.fn()
    listenMock.mockReturnValueOnce(registration.promise)
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('144')
      if (command === 'transport_subscribe_camera') return setup.promise
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/shared_setup_deadline', 'sensor_msgs/Image', vi.fn())
    await vi.advanceTimersByTimeAsync(8_000)
    registration.resolve(unlisten)
    await vi.advanceTimersByTimeAsync(0)
    expect(cameraSubscribeCalls()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(3_999)
    expect(nativeUnsubscribeCalls()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(nativeUnsubscribeCalls()).toHaveLength(1)
    expect(unlisten).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds exact cleanup when a completed camera setup has become stale', async () => {
    const setup = deferred<void>()
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('142')
      if (command === 'transport_subscribe_camera') return setup.promise
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    const unsubscribe = bridge.subscribe(
      '/camera/setup_stale',
      'sensor_msgs/Image',
      vi.fn()
    )
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))
    const identity = (cameraSubscribeCalls()[0]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId

    unsubscribe()
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))
    setup.resolve(undefined)
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(2))

    expect(nativeUnsubscribeCalls().map(([, args]) => args)).toEqual([
      { topic: '/camera/setup_stale', generation: '142', cameraSubscriptionId: identity },
      { topic: '/camera/setup_stale', generation: '142', cameraSubscriptionId: identity },
    ])
  })

  it('does not send a native disconnect from an instance without an owned generation', async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '15' : undefined)
    )
    const activeBridge = new ZenohBridge()
    const unownedBridge = new ZenohBridge()
    await activeBridge.connect()

    await unownedBridge.disconnect()

    expect(nativeDisconnectCalls()).toEqual([])
    expect(activeBridge.isConnected()).toBe(true)
  })

  it('does not restore connected state when disconnect supersedes a pending connect', async () => {
    let resolveConnect!: (generation: string) => void
    const connectResult = new Promise<string>((resolve) => {
      resolveConnect = resolve
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return connectResult
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    const states: string[] = []
    bridge.onStateChange = state => states.push(state)

    const connect = bridge.connect()
    await vi.waitFor(() => expect(bridge.getState()).toBe('connecting'))
    const disconnect = bridge.disconnect()
    resolveConnect('17')
    await Promise.all([connect, disconnect])

    expect(bridge.getState()).toBe('disconnected')
    expect(states).not.toContain('connected')
    expect(nativeDisconnectCalls()).toEqual([
      ['transport_disconnect', { generation: '17' }],
    ])
  })

  it('serializes StrictMode-style connect intents before native lifecycle entry', async () => {
    let resolveFirstConnect!: (generation: string) => void
    const firstConnectResult = new Promise<string>((resolve) => {
      resolveFirstConnect = resolve
    })
    let connectCount = 0
    invokeMock.mockImplementation((command: string) => {
      if (command !== 'transport_connect') return Promise.resolve(undefined)
      connectCount += 1
      return connectCount === 1 ? firstConnectResult : Promise.resolve('47')
    })
    const staleBridge = new ZenohBridge()
    const activeBridge = new ZenohBridge()

    const staleConnect = staleBridge.connect()
    await vi.waitFor(() => expect(staleBridge.getState()).toBe('connecting'))
    const staleDisconnect = staleBridge.disconnect()
    const activeConnect = activeBridge.connect()

    // The second instance cannot overtake the unresolved first native command,
    // even if the backend runtime would otherwise schedule IPC tasks in reverse.
    expect(connectCount).toBe(1)
    resolveFirstConnect('46')
    await Promise.all([staleConnect, staleDisconnect, activeConnect])

    expect(nativeDisconnectCalls()).toEqual([
      ['transport_disconnect', { generation: '46' }],
    ])
    expect(activeBridge.isConnected()).toBe(true)
  })

  it('cancels a pending subscription setup before it can reach the backend', async () => {
    let resolveListen!: () => void
    const listenGate = new Promise<void>((resolve) => {
      resolveListen = resolve
    })
    const unlisten = vi.fn()
    listenMock.mockImplementationOnce(async () => {
      await listenGate
      return unlisten
    })
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '19' : undefined)
    )
    const bridge = new ZenohBridge()
    await bridge.connect()
    const unsubscribe = bridge.subscribe('/camera/pending', 'sensor_msgs/Image', vi.fn())

    unsubscribe()
    resolveListen()
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled())

    expect(invokeMock).not.toHaveBeenCalledWith(
      'transport_subscribe_camera',
      expect.anything()
    )
  })

  it('preserves the ROS orientation-unavailable covariance sentinel', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '23' : undefined)
    )
    const bridge = new ZenohBridge()
    await bridge.connect()
    const callback = vi.fn()
    bridge.subscribe('/imu/data', 'sensor_msgs/Imu', callback)
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('transport_subscribe_imu', {
        topic: '/imu/data',
        generation: '23',
      })
    )

    eventHandler?.({
      payload: {
        orientation: [0, 0, 0, 0],
        orientation_covariance: [-1, 0, 0, 0, 0, 0, 0, 0, 0],
        angular_velocity: [1, 2, 3],
        angular_velocity_covariance: [1, 0, 0, 0, 2, 0, 0, 0, 3],
        linear_acceleration: [4, 5, 6],
        linear_acceleration_covariance: [4, 0, 0, 0, 5, 0, 0, 0, 6],
        timestamp: 1.25,
        frame_id: 'imu',
      },
    })

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    expect(callback.mock.calls[0]?.[0].orientation_covariance[0]).toBe(-1)
  })

  it('pulls camera frames from bounded native delivery and validates before mapping', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'transport_connect') return Promise.resolve('29')
      if (command === 'transport_take_camera_frame') {
        return Promise.resolve(
          args?.deliveryId === '1' ? { ...rawImage(1), data: [1, 2, 3] } : rawImage(2)
        )
      }
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    const callback = vi.fn()
    await bridge.connect()
    bridge.subscribe('/camera/validated', 'sensor_msgs/Image', callback)
    await vi.waitFor(() => expect(eventHandler).toBeDefined())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))

    eventHandler?.({ payload: cameraReady('1', '29') })
    await vi.waitFor(() =>
      expect(cameraAckCalls()).toContainEqual([
        'transport_ack_camera_frame',
        {
          topic: '/camera/validated',
          deliveryId: '1',
          cameraSubscriptionId: cameraSubscriptionId(),
          generation: '29',
        },
      ])
    )
    expect(callback).not.toHaveBeenCalled()

    eventHandler?.({ payload: cameraReady('2', '29') })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    expect(callback.mock.calls[0]?.[0].header.stamp.secs).toBe(2)
    expect(cameraTakeCalls()).toContainEqual([
      'transport_take_camera_frame',
      {
        topic: '/camera/validated',
        deliveryId: '2',
        cameraSubscriptionId: cameraSubscriptionId(),
        generation: '29',
      },
    ])
    await vi.waitFor(() =>
      expect(cameraAckCalls()).toContainEqual([
        'transport_ack_camera_frame',
        {
          topic: '/camera/validated',
          deliveryId: '2',
          cameraSubscriptionId: cameraSubscriptionId(),
          generation: '29',
        },
      ])
    )
  })

  it('fails closed on a malformed current camera-ready descriptor', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '291' : undefined)
    )
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/malformed_ready', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(eventHandler).toBeDefined())

    eventHandler?.({ payload: rawImage(0) })

    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))
    expect(cameraTakeCalls()).toEqual([])
    expect(nativeUnsubscribeCalls()[0]?.[1]).toMatchObject({
      topic: '/camera/malformed_ready',
      generation: '291',
      cameraSubscriptionId: expect.stringMatching(/^[1-9][0-9]*$/),
    })
  })

  it.each([
    ['unsafe integer number', Number.MAX_SAFE_INTEGER + 1],
    ['leading-zero string', '0291'],
    ['u64 overflow string', '18446744073709551616'],
  ])('rejects a noncanonical camera-ready lifecycle generation: %s', async (_label, value) => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '291' : undefined)
    )
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/malformed_generation', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(eventHandler).toBeDefined())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))

    eventHandler?.({
      payload: {
        deliveryId: '1',
        generation: value,
        cameraSubscriptionId: cameraSubscriptionId(),
      },
    })

    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))
    expect(cameraTakeCalls()).toEqual([])
  })

  it('accepts the u64 maximum delivery ID and rejects the first overflow value', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('292')
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/u64_delivery', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(eventHandler).toBeDefined())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))

    eventHandler?.({ payload: cameraReady('18446744073709551615', '292') })
    await vi.waitFor(() => expect(cameraAckCalls()).toHaveLength(1))
    expect((cameraTakeCalls()[0]?.[1] as Record<string, unknown>).deliveryId).toBe(
      '18446744073709551615'
    )

    eventHandler?.({ payload: cameraReady('18446744073709551616', '292') })
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))
    expect(cameraTakeCalls()).toHaveLength(1)
  })

  it('accepts the u64 maximum subscription ID as stale and rejects its overflow', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('293')
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      return Promise.resolve(undefined)
    })
    const callback = vi.fn()
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/u64_subscription', 'sensor_msgs/Image', callback)
    await vi.waitFor(() => expect(eventHandler).toBeDefined())

    eventHandler?.({
      payload: cameraReady('1', '293', '18446744073709551615'),
    })
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))
    expect(nativeUnsubscribeCalls()[0]?.[1]).toMatchObject({
      cameraSubscriptionId: '18446744073709551615',
    })

    eventHandler?.({ payload: cameraReady('2', '293') })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(cameraAckCalls()).toHaveLength(1))

    eventHandler?.({
      payload: cameraReady('3', '293', '18446744073709551616'),
    })
    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(2))
    expect(cameraTakeCalls()).toHaveLength(1)
    expect(nativeUnsubscribeCalls()[1]?.[1]).toMatchObject({
      cameraSubscriptionId: cameraSubscriptionId(),
    })
  })

  it('delivers bounded pose telemetry without non-finite downstream state', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '30' : undefined)
    )
    const bridge = new ZenohBridge()
    const callback = vi.fn()
    await bridge.connect()
    bridge.subscribe('/pose/bounded', 'geometry_msgs/PoseStamped', callback)
    await vi.waitFor(() => expect(eventHandler).toBeDefined())

    eventHandler?.({ payload: rawPose(1_000_000, 1.01) })
    eventHandler?.({ payload: rawPose(1_000_000 + 1e-6, 1) })
    eventHandler?.({ payload: rawPose(Number.MAX_VALUE, 1) })
    eventHandler?.({ payload: rawPose(0, 0.98) })

    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    const delivered = callback.mock.calls[0]?.[0]
    expect(delivered.pose.position.x).toBe(1_000_000)
    expect(delivered.pose.orientation.w).toBe(1.01)
    expect(
      [
        delivered.pose.position.x,
        delivered.pose.position.y,
        delivered.pose.position.z,
        delivered.pose.orientation.x,
        delivered.pose.orientation.y,
        delivered.pose.orientation.z,
        delivered.pose.orientation.w,
      ].every(Number.isFinite)
    ).toBe(true)
  })

  it('delivers ModelStates only within the shared pose and twist envelope', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '32' : undefined)
    )
    const bridge = new ZenohBridge()
    const callback = vi.fn()
    await bridge.connect()
    bridge.subscribe('/models/bounded', 'gazebo_msgs/ModelStates', callback)
    await vi.waitFor(() => expect(eventHandler).toBeDefined())
    const atLimits = {
      name: ['drone'],
      pose: [rawPose(1_000_000, 0.99)],
      twist: [{ linear: [100, 0, 0], angular: [0, 0, 50] }],
    }

    eventHandler?.({ payload: atLimits })
    eventHandler?.({
      payload: {
        ...atLimits,
        twist: [{ linear: [100 + 1e-6, 0, 0], angular: [0, 0, 0] }],
      },
    })
    eventHandler?.({
      payload: {
        ...atLimits,
        twist: [{ linear: [0, 0, 0], angular: [0, 0, 50 + 1e-6] }],
      },
    })

    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    const delivered = callback.mock.calls[0]?.[0]
    expect(delivered.name).toEqual(['drone'])
    expect(
      [
        delivered.pose[0].position.x,
        delivered.pose[0].orientation.w,
        delivered.twist[0].linear.x,
        delivered.twist[0].angular.z,
      ].every(Number.isFinite)
    ).toBe(true)
  })

  it('isolates callback failures across listeners on the same topic', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('31')
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    const laterCallback = vi.fn()
    await bridge.connect()
    bridge.subscribe('/camera/isolation', 'sensor_msgs/Image', () => {
      throw new Error('consumer failed')
    })
    bridge.subscribe('/camera/isolation', 'sensor_msgs/Image', laterCallback)
    await vi.waitFor(() => expect(eventHandler).toBeDefined())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))

    eventHandler?.({ payload: cameraReady('1', '31') })

    await vi.waitFor(() => expect(laterCallback).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(cameraAckCalls()).toHaveLength(1))
  })

  it('retains native camera delivery until asynchronous listeners settle', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('35')
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      return Promise.resolve(undefined)
    })
    let release!: () => void
    const callback = vi.fn(
      (_message: Image) => new Promise<void>((resolve) => (release = resolve))
    )
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe(
      '/camera/acknowledged',
      'sensor_msgs/Image',
      callback
    )
    await vi.waitFor(() => expect(eventHandler).toBeDefined())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))

    eventHandler?.({ payload: cameraReady('1', '35') })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(cameraAckCalls()).toEqual([])

    release()
    await vi.waitFor(() =>
      expect(cameraAckCalls()).toEqual([
        [
          'transport_ack_camera_frame',
          {
            topic: '/camera/acknowledged',
            deliveryId: '1',
            cameraSubscriptionId: cameraSubscriptionId(),
            generation: '35',
          },
        ],
      ])
    )
  })

  it('fails closed at the ten-second camera pull deadline', async () => {
    vi.useFakeTimers()
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('50')
      if (command === 'transport_take_camera_frame') {
        return new Promise<ReturnType<typeof rawImage>>(() => undefined)
      }
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/pull_timeout', 'sensor_msgs/Image', vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    eventHandler?.({ payload: cameraReady('1', '50') })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(nativeUnsubscribeCalls()).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(nativeUnsubscribeCalls()).toHaveLength(1)
    expect(cameraAckCalls()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('quarantines only a non-settling camera listener and keeps healthy peers live', async () => {
    vi.useFakeTimers()
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'transport_connect') return Promise.resolve('51')
      if (command === 'transport_take_camera_frame') {
        return Promise.resolve(rawImage(Number(args?.deliveryId)))
      }
      return Promise.resolve(undefined)
    })
    const unresolved = deferred<void>()
    const stalled = vi.fn(() => unresolved.promise)
    const healthy = vi.fn()
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/quarantine', 'sensor_msgs/Image', stalled)
    bridge.subscribe('/camera/quarantine', 'sensor_msgs/Image', healthy)
    await vi.advanceTimersByTimeAsync(0)

    eventHandler?.({ payload: cameraReady('1', '51') })
    await vi.advanceTimersByTimeAsync(0)
    expect(stalled).toHaveBeenCalledOnce()
    expect(healthy).toHaveBeenCalledOnce()
    expect(cameraAckCalls()).toEqual([])

    await vi.advanceTimersByTimeAsync(8_000)
    expect(cameraAckCalls()).toHaveLength(1)
    expect(nativeUnsubscribeCalls()).toEqual([])

    eventHandler?.({ payload: cameraReady('2', '51') })
    await vi.advanceTimersByTimeAsync(0)
    expect(stalled).toHaveBeenCalledOnce()
    expect(healthy).toHaveBeenCalledTimes(2)
    expect(cameraAckCalls()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending listener deadline on teardown and acknowledges promptly', async () => {
    vi.useFakeTimers()
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    const unlisten = vi.fn()
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return unlisten
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('52')
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe(
      '/camera/teardown',
      'sensor_msgs/Image',
      () => new Promise<void>(() => undefined)
    )
    await vi.advanceTimersByTimeAsync(0)

    eventHandler?.({ payload: cameraReady('1', '52') })
    await vi.advanceTimersByTimeAsync(0)
    expect(cameraAckCalls()).toEqual([])

    await bridge.disconnect()
    await vi.advanceTimersByTimeAsync(0)

    expect(cameraAckCalls()).toEqual([
      [
        'transport_ack_camera_frame',
        {
          topic: '/camera/teardown',
          deliveryId: '1',
          cameraSubscriptionId: cameraSubscriptionId(),
          generation: '52',
        },
      ],
    ])
    expect(unlisten).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails closed and permits an explicit reopen when acknowledgement never settles', async () => {
    vi.useFakeTimers()
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('53')
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      if (command === 'transport_ack_camera_frame') {
        return new Promise<void>(() => undefined)
      }
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/ack_timeout', 'sensor_msgs/Image', vi.fn())
    await vi.advanceTimersByTimeAsync(0)

    eventHandler?.({ payload: cameraReady('1', '53') })
    await vi.advanceTimersByTimeAsync(0)
    expect(cameraAckCalls()).toHaveLength(1)
    expect(nativeUnsubscribeCalls()).toEqual([])

    eventHandler?.({ payload: cameraReady('2', '53') })
    await vi.advanceTimersByTimeAsync(0)
    expect(cameraTakeCalls()).toHaveLength(1)
    expect(cameraAckCalls()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(4_000)
    expect(nativeUnsubscribeCalls()).toHaveLength(1)
    expect(cameraTakeCalls()).toHaveLength(1)
    expect(cameraAckCalls()).toHaveLength(1)
    const retiredIdentity = (nativeUnsubscribeCalls()[0]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId

    bridge.subscribe('/camera/ack_timeout', 'sensor_msgs/Image', vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    const reopenedIdentity = (cameraSubscribeCalls()[1]?.[1] as Record<string, unknown>)
      .cameraSubscriptionId

    expect(retiredIdentity).toEqual(expect.stringMatching(/^[1-9][0-9]*$/))
    expect(reopenedIdentity).toEqual(expect.stringMatching(/^[1-9][0-9]*$/))
    expect(reopenedIdentity).not.toBe(retiredIdentity)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails closed immediately when acknowledgement is rejected', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('54')
      if (command === 'transport_take_camera_frame') return Promise.resolve(rawImage(1))
      if (command === 'transport_ack_camera_frame') {
        return Promise.reject(new Error('ack rejected'))
      }
      return Promise.resolve(undefined)
    })
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/ack_rejected', 'sensor_msgs/Image', vi.fn())
    await vi.waitFor(() => expect(eventHandler).toBeDefined())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))

    eventHandler?.({ payload: cameraReady('1', '54') })

    await vi.waitFor(() => expect(nativeUnsubscribeCalls()).toHaveLength(1))
    expect(cameraAckCalls()).toHaveLength(1)
    expect(nativeUnsubscribeCalls()[0]?.[1]).toMatchObject({
      topic: '/camera/ack_rejected',
      generation: '54',
      cameraSubscriptionId: expect.stringMatching(/^[1-9][0-9]*$/),
    })
  })

  it('acknowledges a pulled frame when its subscription becomes stale in flight', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    let resolveTake!: (frame: ReturnType<typeof rawImage>) => void
    const takeResult = new Promise<ReturnType<typeof rawImage>>((resolve) => {
      resolveTake = resolve
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === 'transport_connect') return Promise.resolve('36')
      if (command === 'transport_take_camera_frame') return takeResult
      return Promise.resolve(undefined)
    })
    const callback = vi.fn()
    const bridge = new ZenohBridge()
    await bridge.connect()
    const unsubscribe = bridge.subscribe(
      '/camera/stale',
      'sensor_msgs/Image',
      callback
    )
    await vi.waitFor(() => expect(eventHandler).toBeDefined())
    await vi.waitFor(() => expect(cameraSubscribeCalls()).toHaveLength(1))

    eventHandler?.({ payload: cameraReady('9', '36') })
    await vi.waitFor(() => expect(cameraTakeCalls()).toHaveLength(1))
    unsubscribe()
    resolveTake(rawImage(9))

    await vi.waitFor(() =>
      expect(cameraAckCalls()).toEqual([
        [
          'transport_ack_camera_frame',
          {
            topic: '/camera/stale',
            deliveryId: '9',
            cameraSubscriptionId: cameraSubscriptionId(),
            generation: '36',
          },
        ],
      ])
    )
    expect(callback).not.toHaveBeenCalled()
    expect(cameraSubscribeCalls()).toHaveLength(1)
  })

  it('bounds each asynchronous callback queue and drops the oldest pending frame', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '37' : undefined)
    )
    const releases: Array<() => void> = []
    const callback = vi.fn(
      (_message: PoseStamped) => new Promise<void>((resolve) => releases.push(resolve))
    )
    const asynchronousCallback = callback as unknown as ROSMessageCallback<PoseStamped>
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe(
      '/pose/queued',
      'geometry_msgs/PoseStamped',
      asynchronousCallback,
      undefined,
      1
    )
    await vi.waitFor(() => expect(eventHandler).toBeDefined())

    eventHandler?.({ payload: rawPose(1, 1) })
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    eventHandler?.({ payload: rawPose(2, 1) })
    eventHandler?.({ payload: rawPose(3, 1) })
    releases.shift()?.()

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2))
    expect(
      callback.mock.calls.map(([message]) => message.pose.position.x)
    ).toEqual([1, 3])
    releases.shift()?.()
  })

  it('applies throttle policy per listener without starving unthrottled listeners', async () => {
    let eventHandler: ((event: { payload: unknown }) => void) | undefined
    let now = 0
    const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => now)
    listenMock.mockImplementationOnce(async (_eventName, handler) => {
      eventHandler = handler
      return vi.fn()
    })
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '41' : undefined)
    )
    const unthrottled = vi.fn()
    const throttled = vi.fn()
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/pose/throttle', 'geometry_msgs/PoseStamped', unthrottled)
    bridge.subscribe('/pose/throttle', 'geometry_msgs/PoseStamped', throttled, 100)
    await vi.waitFor(() => expect(eventHandler).toBeDefined())

    eventHandler?.({ payload: rawPose(1, 1) })
    await vi.waitFor(() => expect(unthrottled).toHaveBeenCalledTimes(1))
    now = 50
    eventHandler?.({ payload: rawPose(2, 1) })
    await vi.waitFor(() => expect(unthrottled).toHaveBeenCalledTimes(2))

    expect(throttled).toHaveBeenCalledTimes(1)
    performanceNow.mockRestore()
  })

  it('rejects conflicting topic types and unbounded queue requests', async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'transport_connect' ? '43' : undefined)
    )
    const bridge = new ZenohBridge()
    await bridge.connect()
    bridge.subscribe('/camera/policy', 'sensor_msgs/Image', vi.fn())

    expect(() =>
      bridge.subscribe('/camera/policy', 'sensor_msgs/CompressedImage', vi.fn())
    ).toThrow('refusing conflicting type')
    expect(() =>
      bridge.subscribe('/camera/other', 'sensor_msgs/Image', vi.fn(), undefined, 0)
    ).toThrow('queue length')
    expect(() =>
      bridge.subscribe('/camera/other', 'sensor_msgs/Image', vi.fn(), undefined, 5)
    ).toThrow('queue length')
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
