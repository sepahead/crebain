/**
 * CREBAIN Zenoh Bridge Client
 * Adaptive Response & Awareness System (ARAS)
 *
 * Native bridge using Tauri commands to communicate via Zenoh
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  ROSMessageCallback,
  PoseStamped,
  Image,
  CompressedImage,
  CameraInfo,
  Imu,
  ModelStates,
  ConnectionState,
  Pose,
  Twist,
} from './types'
import { createHeader } from './types'
import { getMessageRegistry } from './MessageRegistry'
import { validateGazeboPose, validateGazeboTwist } from './gazeboValidation'
import { normalizeRosNamespace } from './utils'
import { rosLogger as log } from '../lib/logger'
import { TAURI_COMMANDS } from '../lib/tauriCommands'
import { getTransportEventName } from '../lib/transportEvents'
import { assertNativeBackendAllowed } from '../integrations/engramHost'
import { validateRosGraphName } from './rosNameValidation'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES (Backend Mappings)
// ─────────────────────────────────────────────────────────────────────────────

interface RustPoseData {
  position: [number, number, number]
  orientation: [number, number, number, number]
  timestamp: number
  frame_id: string
}

interface RustVelocityCmd {
  linear: [number, number, number]
  angular: [number, number, number]
}

interface RustCameraFrame {
  data: string
  width: number
  height: number
  encoding: string
  timestamp: number
  frame_id: string
  is_bigendian: number
  step: number
}

interface RustCameraReady {
  deliveryId: string
  generation: string
  cameraSubscriptionId: string
}

interface RustTelemetryEnvelope {
  generation: string
  subscriptionId: string
  data: unknown
}

interface RustCameraInfoData {
  height: number
  width: number
  distortion_model: string
  d: number[]
  k: number[]
  r: number[]
  p: number[]
  timestamp: number
  frame_id: string
}

interface RustImuData {
  orientation: [number, number, number, number]
  orientation_covariance: [number, number, number, number, number, number, number, number, number]
  angular_velocity: [number, number, number]
  angular_velocity_covariance: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  linear_acceleration: [number, number, number]
  linear_acceleration_covariance: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  timestamp: number
  frame_id: string
}

interface RustModelStates {
  name: string[]
  pose: RustPoseData[]
  twist: RustVelocityCmd[]
}

interface NativeListener {
  id: number
  type: string
  callback: ROSMessageCallback<unknown>
  throttleRateMs: number
  queueLength: number
  lastQueuedAt: number
  queue: unknown[]
  draining: boolean
  active: boolean
  pendingCameraSettlements: Set<() => void>
}

interface PendingCameraDelivery {
  type: string
  mapper: (data: unknown) => unknown
  payload: RustCameraReady
}

interface CameraDeliveryRunner {
  subscriptionGeneration: number
  topicGeneration: number
  running: boolean
  pending: PendingCameraDelivery | null
}

const DEFAULT_NATIVE_QUEUE_LENGTH = 1
const MAX_NATIVE_QUEUE_LENGTH = 4
const MAX_NATIVE_THROTTLE_MS = 60_000
const MAX_NATIVE_LISTENERS_PER_TOPIC = 256
const MAX_NATIVE_LISTENERS = 1024
const POSITIVE_U64_DECIMAL_PATTERN = /^[1-9][0-9]{0,19}$/
const MAX_U64 = 18_446_744_073_709_551_615n
const CAMERA_SETUP_TIMEOUT_MS = 12_000
const CAMERA_TAKE_TIMEOUT_MS = 10_000
const CAMERA_LISTENER_SETTLE_TIMEOUT_MS = 8_000
const CAMERA_ACK_TIMEOUT_MS = 4_000
const NATIVE_CONNECT_TIMEOUT_MS = 15_000
const NATIVE_DISCONNECT_TIMEOUT_MS = 10_000
const NATIVE_SUBSCRIPTION_SETUP_TIMEOUT_MS = 12_000

class NativeOperationTimeoutError extends Error {}

function withNativeOperationDeadline<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  message: string,
  onLateResolve?: (value: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const finish = (outcome: 'resolve' | 'reject', value: unknown): void => {
      if (settled) {
        if (outcome === 'resolve') onLateResolve?.(value as T)
        return
      }
      settled = true
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      if (outcome === 'resolve') resolve(value as T)
      else reject(value instanceof Error ? value : new Error(message, { cause: value }))
    }

    timeoutId = setTimeout(() => {
      timeoutId = undefined
      finish('reject', new NativeOperationTimeoutError(message))
    }, timeoutMs)

    void Promise.resolve(operation).then(
      (value) => finish('resolve', value),
      (error: unknown) => finish('reject', error)
    )
  })
}

function isCanonicalPositiveU64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    POSITIVE_U64_DECIMAL_PATTERN.test(value) &&
    BigInt(value) <= MAX_U64
  )
}

// The native transport is process-global, while React StrictMode can briefly
// create multiple bridge instances. Serialize every native lifecycle command in
// frontend intent order so independent IPC tasks cannot rotate the backend out of
// order. The latest reserved connect intent is also visible before its queued
// operation starts, preventing an older instance from becoming locally connected.
let nativeLifecycleTail: Promise<void> = Promise.resolve()
let latestNativeConnectIntent = 0
let latestNativeSubscriptionIntent = 0

function nextGeneration(current: number, label: string): number {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} generation exhausted`)
  }
  return current + 1
}

function reserveNativeConnectIntent(): number {
  latestNativeConnectIntent = nextGeneration(latestNativeConnectIntent, 'Native connect intent')
  return latestNativeConnectIntent
}

function reserveNativeSubscriptionId(): string {
  latestNativeSubscriptionIntent = nextGeneration(
    latestNativeSubscriptionIntent,
    'Native subscription'
  )
  return latestNativeSubscriptionIntent.toString()
}

function enqueueNativeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeLifecycleTail.then(operation, operation)
  nativeLifecycleTail = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

function validateNativeTopic(topic: string): void {
  try {
    validateRosGraphName(topic, 'topic')
  } catch {
    throw new Error('Invalid native ROS topic')
  }
}

function snapshotMappedMessage(type: string, message: unknown): unknown {
  if (type === 'sensor_msgs/Image') {
    const image = message as Image
    return {
      ...image,
      header: { ...image.header, stamp: { ...image.header.stamp } },
      data: Array.isArray(image.data) ? [...image.data] : image.data,
    }
  }
  if (type === 'sensor_msgs/CompressedImage') {
    const image = message as CompressedImage
    return {
      ...image,
      header: { ...image.header, stamp: { ...image.header.stamp } },
      data: Array.isArray(image.data) ? [...image.data] : image.data,
    }
  }
  if (type === 'sensor_msgs/CameraInfo') {
    const info = message as CameraInfo
    return {
      ...info,
      header: { ...info.header, stamp: { ...info.header.stamp } },
      D: [...info.D],
      K: [...info.K],
      R: [...info.R],
      P: [...info.P],
    }
  }
  if (type === 'sensor_msgs/Imu') {
    const imu = message as Imu
    return {
      ...imu,
      header: { ...imu.header, stamp: { ...imu.header.stamp } },
      orientation: { ...imu.orientation },
      orientation_covariance: [...imu.orientation_covariance],
      angular_velocity: { ...imu.angular_velocity },
      angular_velocity_covariance: [...imu.angular_velocity_covariance],
      linear_acceleration: { ...imu.linear_acceleration },
      linear_acceleration_covariance: [...imu.linear_acceleration_covariance],
    }
  }
  if (type === 'geometry_msgs/PoseStamped') {
    const pose = message as PoseStamped
    return {
      ...pose,
      header: { ...pose.header, stamp: { ...pose.header.stamp } },
      pose: {
        position: { ...pose.pose.position },
        orientation: { ...pose.pose.orientation },
      },
    }
  }
  if (type === 'gazebo_msgs/ModelStates') {
    const states = message as ModelStates
    return {
      name: [...states.name],
      pose: states.pose.map((pose) => ({
        position: { ...pose.position },
        orientation: { ...pose.orientation },
      })),
      twist: states.twist.map((twist) => ({
        linear: { ...twist.linear },
        angular: { ...twist.angular },
      })),
    }
  }
  throw new Error(`Cannot snapshot unsupported native ROS message type: ${type}`)
}

function headerFromRust(frameId: string, timestamp: number) {
  const seconds = Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0
  const secs = Math.floor(seconds)
  const nsecs = Math.min(999_999_999, Math.round((seconds - secs) * 1e9))
  return {
    ...createHeader(frameId),
    stamp: { secs, nsecs },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZENOH BRIDGE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

export class ZenohBridge {
  private state: ConnectionState = 'disconnected'
  private unlisteners: Map<string, UnlistenFn> = new Map()
  private listeners: Map<string, NativeListener[]> = new Map()
  private listenerIdCounter = 0
  private lifecycleGeneration = 0
  private subscriptionGeneration = 0
  private topicGenerations: Map<string, number> = new Map()
  private subscriptionIds: Map<string, string> = new Map()
  private cameraDeliveryRunners: Map<string, CameraDeliveryRunner> = new Map()
  private backendGeneration: string | null = null

  // Configuration (mocking ROSBridge config)
  public config = {
    url: 'zenoh://localhost',
    // Native sessions are terminal after close. Reconnection is an explicit
    // `connect()` call that constructs a fresh backend bridge.
    autoReconnect: false,
  }

  public onStateChange?: (state: ConnectionState) => void
  public onError?: (error: Error) => void

  constructor() {}

  // ───────────────────────────────────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    assertNativeBackendAllowed()
    if (this.state === 'connected') return

    const connectIntent = reserveNativeConnectIntent()
    this.lifecycleGeneration = nextGeneration(
      this.lifecycleGeneration,
      'Native transport lifecycle'
    )
    const lifecycleGeneration = this.lifecycleGeneration
    this.setState('connecting')

    try {
      await enqueueNativeLifecycle(async () => {
        const backendGeneration = await withNativeOperationDeadline(
          invoke<unknown>(TAURI_COMMANDS.transport.connect),
          NATIVE_CONNECT_TIMEOUT_MS,
          'Native transport connection timed out',
          (lateGeneration) => {
            if (!isCanonicalPositiveU64(lateGeneration)) return
            void invoke(TAURI_COMMANDS.transport.disconnect, {
              generation: lateGeneration,
            }).catch((cleanupError: unknown) => {
              log.warn('Failed to close a late native transport connection', {
                error: cleanupError,
              })
            })
          }
        )
        if (!isCanonicalPositiveU64(backendGeneration)) {
          throw new Error('Native transport returned an invalid lifecycle generation')
        }
        if (
          lifecycleGeneration !== this.lifecycleGeneration ||
          connectIntent !== latestNativeConnectIntent
        ) {
          // Close the stale generation before a queued newer connect can enter the
          // backend. Exact generation matching also protects external replacements.
          try {
            await invoke(TAURI_COMMANDS.transport.disconnect, {
              generation: backendGeneration,
            })
          } catch {
            // The local intent is already stale and owns no usable connection.
          }
          return
        }
        this.backendGeneration = backendGeneration
        this.setState('connected')
      })
    } catch (error) {
      if (
        lifecycleGeneration !== this.lifecycleGeneration ||
        connectIntent !== latestNativeConnectIntent
      ) {
        return
      }
      this.backendGeneration = null
      this.setState('disconnected')
      this.notifyError(error)
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.lifecycleGeneration = nextGeneration(
      this.lifecycleGeneration,
      'Native transport lifecycle'
    )
    const lifecycleGeneration = this.lifecycleGeneration
    const backendGeneration = this.backendGeneration
    this.backendGeneration = null
    this.subscriptionGeneration = nextGeneration(
      this.subscriptionGeneration,
      'Native subscription lifecycle'
    )

    // Invalidate and release local delivery synchronously. A pending setup
    // checks these generations after every await and cannot attach afterward.
    for (const unlisten of this.unlisteners.values()) {
      this.releaseUnlistener(unlisten, 'disconnect')
    }
    this.unlisteners.clear()
    for (const topic of this.listeners.keys()) this.deactivateTopic(topic)
    this.listeners.clear()
    this.topicGenerations.clear()
    this.subscriptionIds.clear()
    this.cameraDeliveryRunners.clear()
    this.setState('disconnected')

    const operation = enqueueNativeLifecycle(async () => {
      if (backendGeneration === null) return
      try {
        await withNativeOperationDeadline(
          invoke(TAURI_COMMANDS.transport.disconnect, {
            generation: backendGeneration,
          }),
          NATIVE_DISCONNECT_TIMEOUT_MS,
          'Native transport disconnect timed out'
        )
      } catch (error) {
        // Disconnect errors are non-fatal; local delivery is already fenced.
        this.notifyError(error)
      }
    })
    try {
      await operation
    } finally {
      if (lifecycleGeneration === this.lifecycleGeneration) {
        this.backendGeneration = null
      }
    }
  }

  getState(): ConnectionState {
    return this.state
  }

  isConnected(): boolean {
    return this.state === 'connected'
  }

  private setState(state: ConnectionState) {
    this.state = state
    try {
      this.onStateChange?.(state)
    } catch (error) {
      log.warn('Native transport state callback failed', { error, state })
    }
  }

  private notifyError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    try {
      this.onError?.(normalized)
    } catch (callbackError) {
      log.warn('Native transport error callback failed', { error: callbackError })
    }
  }

  private async cleanUpBackendSubscription(
    topic: string,
    generation: string,
    subscriptionId: string,
    context: string
  ): Promise<void> {
    await withNativeOperationDeadline(
      invoke(TAURI_COMMANDS.transport.unsubscribe, {
        topic,
        generation,
        subscriptionId,
      }),
      CAMERA_ACK_TIMEOUT_MS,
      `${context} timed out for ${topic}`
    )
  }

  private nextTopicGeneration(topic: string): number {
    const generation = nextGeneration(
      this.topicGenerations.get(topic) ?? 0,
      `Native topic ${topic}`
    )
    this.topicGenerations.set(topic, generation)
    return generation
  }

  private nextListenerId(): number {
    this.listenerIdCounter = nextGeneration(this.listenerIdCounter, 'Native listener')
    return this.listenerIdCounter
  }

  private listenerCount(): number {
    let count = 0
    for (const listeners of this.listeners.values()) count += listeners.length
    return count
  }

  private deactivateListener(listener: NativeListener): void {
    listener.active = false
    listener.queue.length = 0
    listener.draining = false
    for (const cancel of [...listener.pendingCameraSettlements]) cancel()
    listener.pendingCameraSettlements.clear()
  }

  private deactivateTopic(topic: string): void {
    for (const listener of this.listeners.get(topic) ?? []) {
      this.deactivateListener(listener)
    }
  }

  private isSubscriptionCurrent(
    topic: string,
    subscriptionGeneration: number,
    topicGeneration: number
  ): boolean {
    return (
      this.subscriptionGeneration === subscriptionGeneration &&
      this.topicGenerations.get(topic) === topicGeneration &&
      this.listeners.has(topic)
    )
  }

  private releaseUnlistener(unlisten: UnlistenFn, context: string): void {
    try {
      unlisten()
    } catch (error) {
      log.warn('Failed to release native event listener', { context, error })
    }
  }

  private reportListenerError(topic: string, error: unknown): void {
    log.warn(`Native telemetry callback failed for ${topic}`, { error })
  }

  private settleCameraListener(
    topic: string,
    listener: NativeListener,
    callbackResult: unknown,
    subscriptionGeneration: number,
    topicGeneration: number
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const finish = (): boolean => {
        if (settled) return false
        settled = true
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        listener.pendingCameraSettlements.delete(cancel)
        resolve()
        return true
      }
      const cancel = (): void => {
        finish()
      }

      listener.pendingCameraSettlements.add(cancel)
      timeoutId = setTimeout(() => {
        timeoutId = undefined
        if (!finish()) return
        if (
          listener.active &&
          this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration) &&
          this.listeners.get(topic)?.includes(listener)
        ) {
          log.warn(`Native camera listener timed out for ${topic}`)
          this.unsubscribeById(topic, listener.id)
        }
      }, CAMERA_LISTENER_SETTLE_TIMEOUT_MS)

      void Promise.resolve(callbackResult).then(
        () => {
          finish()
        },
        (error: unknown) => {
          this.reportListenerError(topic, error)
          finish()
        }
      )
    })
  }

  private isCameraReady(value: unknown): value is RustCameraReady {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    try {
      const candidate = value as Record<string, unknown>
      const keys = Object.keys(candidate)
      return (
        keys.length === 3 &&
        Object.hasOwn(candidate, 'deliveryId') &&
        Object.hasOwn(candidate, 'cameraSubscriptionId') &&
        Object.hasOwn(candidate, 'generation') &&
        isCanonicalPositiveU64(candidate.deliveryId) &&
        isCanonicalPositiveU64(candidate.cameraSubscriptionId) &&
        isCanonicalPositiveU64(candidate.generation)
      )
    } catch {
      return false
    }
  }

  private admitTelemetryEnvelope(
    topic: string,
    eventName: string,
    payload: unknown,
    expectedSubscriptionId: string
  ): RustTelemetryEnvelope | null {
    try {
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new Error('expected an object')
      }
      const candidate = payload as Record<string, unknown>
      const keys = Object.keys(candidate)
      if (
        keys.length !== 3 ||
        !keys.includes('generation') ||
        !keys.includes('subscriptionId') ||
        !keys.includes('data') ||
        !isCanonicalPositiveU64(candidate.generation) ||
        !isCanonicalPositiveU64(candidate.subscriptionId)
      ) {
        throw new Error('expected an exact native telemetry envelope')
      }
      if (
        candidate.generation !== this.backendGeneration ||
        candidate.subscriptionId !== expectedSubscriptionId ||
        candidate.subscriptionId !== this.subscriptionIds.get(topic)
      ) {
        return null
      }
      return {
        generation: candidate.generation,
        subscriptionId: candidate.subscriptionId,
        data: candidate.data,
      }
    } catch (error) {
      log.warn('Rejected malformed native telemetry envelope', {
        topic,
        eventName,
        error,
      })
      return null
    }
  }

  private admitCameraReadyDescriptor(
    topic: string,
    payload: unknown,
    subscriptionGeneration: number,
    topicGeneration: number
  ): payload is RustCameraReady {
    const eventName = getTransportEventName(topic)
    if (!this.isCameraReady(payload)) {
      log.warn('Rejected malformed native camera-ready descriptor', { topic, eventName })
      if (this.backendGeneration !== null) {
        this.failCameraTopic(
          topic,
          subscriptionGeneration,
          topicGeneration,
          this.backendGeneration,
          'malformed camera-ready descriptor'
        )
      }
      return false
    }
    if (payload.generation !== this.backendGeneration) return false
    if (payload.cameraSubscriptionId !== this.subscriptionIds.get(topic)) {
      void withNativeOperationDeadline(
        invoke(TAURI_COMMANDS.transport.unsubscribe, {
          topic,
          generation: payload.generation,
          subscriptionId: payload.cameraSubscriptionId,
        }),
        CAMERA_ACK_TIMEOUT_MS,
        `Stale native camera descriptor cleanup timed out for ${topic}`
      ).catch((cleanupError: unknown) => {
        log.warn(`Failed to clean up stale native camera descriptor for ${topic}`, {
          error: cleanupError,
          eventName,
        })
      })
      return false
    }
    return true
  }

  private removeCameraDeliveryRunnerExact(
    topic: string,
    subscriptionGeneration: number,
    topicGeneration: number
  ): void {
    const runner = this.cameraDeliveryRunners.get(topic)
    if (
      runner?.subscriptionGeneration === subscriptionGeneration &&
      runner.topicGeneration === topicGeneration
    ) {
      this.cameraDeliveryRunners.delete(topic)
    }
  }

  private isCameraDeliveryRunnerCurrent(topic: string, runner: CameraDeliveryRunner): boolean {
    return (
      this.cameraDeliveryRunners.get(topic) === runner &&
      this.isSubscriptionCurrent(topic, runner.subscriptionGeneration, runner.topicGeneration)
    )
  }

  private enqueueCameraDelivery(
    topic: string,
    type: string,
    mapper: (data: unknown) => unknown,
    payload: unknown,
    subscriptionGeneration: number,
    topicGeneration: number
  ): void {
    const runner = this.cameraDeliveryRunners.get(topic)
    if (
      runner?.subscriptionGeneration !== subscriptionGeneration ||
      runner.topicGeneration !== topicGeneration ||
      !this.isCameraDeliveryRunnerCurrent(topic, runner)
    ) {
      return
    }
    if (!this.admitCameraReadyDescriptor(topic, payload, subscriptionGeneration, topicGeneration)) {
      return
    }

    const delivery = {
      type,
      mapper,
      payload: {
        deliveryId: payload.deliveryId,
        generation: payload.generation,
        cameraSubscriptionId: payload.cameraSubscriptionId,
      },
    }
    if (runner.running) {
      if (runner.pending === null) {
        runner.pending = delivery
      } else {
        log.warn(`Dropping excess native camera-ready descriptor for ${topic}`)
      }
      return
    }

    runner.running = true
    void this.drainCameraDeliveryRunner(topic, runner, delivery)
  }

  private async drainCameraDeliveryRunner(
    topic: string,
    runner: CameraDeliveryRunner,
    first: PendingCameraDelivery
  ): Promise<void> {
    let delivery: PendingCameraDelivery | null = first
    try {
      while (delivery !== null && this.isCameraDeliveryRunnerCurrent(topic, runner)) {
        await this.consumeCameraDelivery(
          topic,
          delivery.type,
          delivery.mapper,
          delivery.payload,
          runner.subscriptionGeneration,
          runner.topicGeneration
        )
        if (!this.isCameraDeliveryRunnerCurrent(topic, runner)) return
        delivery = runner.pending
        runner.pending = null
      }
    } finally {
      runner.pending = null
      if (this.cameraDeliveryRunners.get(topic) === runner) runner.running = false
    }
  }

  private failCameraTopic(
    topic: string,
    subscriptionGeneration: number,
    topicGeneration: number,
    generation: string,
    reason: string
  ): void {
    if (!this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration)) return

    log.warn(`Deactivating native camera topic ${topic}`, { reason })
    this.nextTopicGeneration(topic)
    const unlisten = this.unlisteners.get(topic)
    if (unlisten) {
      this.releaseUnlistener(unlisten, topic)
      this.unlisteners.delete(topic)
    }
    this.deactivateTopic(topic)
    this.listeners.delete(topic)
    this.cameraDeliveryRunners.delete(topic)
    const subscriptionId = this.subscriptionIds.get(topic)
    this.subscriptionIds.delete(topic)
    if (subscriptionId === undefined) {
      this.notifyError(new Error(`Native camera subscription identity is missing for ${topic}`))
      return
    }
    void withNativeOperationDeadline(
      invoke(TAURI_COMMANDS.transport.unsubscribe, {
        topic,
        generation,
        subscriptionId,
      }),
      CAMERA_ACK_TIMEOUT_MS,
      `Native camera unsubscribe timed out for ${topic}`
    ).catch((error: unknown) => {
      log.warn(`Failed to quarantine native camera topic ${topic}`, {
        error,
        eventName: getTransportEventName(topic),
      })
    })
  }

  private async deliverPulledCameraMessage(
    topic: string,
    message: unknown,
    subscriptionGeneration: number,
    topicGeneration: number
  ): Promise<void> {
    if (!this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration)) return
    const listeners = [...(this.listeners.get(topic) ?? [])]
    const completions: Promise<void>[] = []

    for (const listener of listeners) {
      if (!listener.active) continue
      const now = performance.now()
      if (listener.throttleRateMs > 0 && now - listener.lastQueuedAt < listener.throttleRateMs) {
        continue
      }
      listener.lastQueuedAt = now

      try {
        const result = (listener.callback as (value: unknown) => unknown)(
          snapshotMappedMessage(listener.type, message)
        )
        completions.push(
          this.settleCameraListener(
            topic,
            listener,
            result,
            subscriptionGeneration,
            topicGeneration
          )
        )
      } catch (error) {
        this.reportListenerError(topic, error)
      }
    }

    await Promise.all(completions)
  }

  private async consumeCameraDelivery(
    topic: string,
    type: string,
    mapper: (data: unknown) => unknown,
    payload: unknown,
    subscriptionGeneration: number,
    topicGeneration: number
  ): Promise<void> {
    if (!this.admitCameraReadyDescriptor(topic, payload, subscriptionGeneration, topicGeneration))
      return
    const eventName = getTransportEventName(topic)
    const { deliveryId, generation, cameraSubscriptionId } = payload

    let pulled = false
    try {
      const frame = await withNativeOperationDeadline(
        invoke<RustCameraFrame>(TAURI_COMMANDS.transport.takeCameraFrame, {
          topic,
          deliveryId,
          cameraSubscriptionId,
          generation,
        }),
        CAMERA_TAKE_TIMEOUT_MS,
        `Native camera pull timed out for ${topic}`
      )
      pulled = true

      const registry = getMessageRegistry()
      if (!registry.validate(type, frame)) {
        log.warn(`Rejected malformed pulled native ${type} telemetry`, { topic, eventName })
        return
      }

      let message: unknown
      try {
        message = mapper(frame)
      } catch (error) {
        log.warn(`Failed to map pulled native ${type} telemetry`, {
          topic,
          eventName,
          error,
        })
        return
      }
      await this.deliverPulledCameraMessage(topic, message, subscriptionGeneration, topicGeneration)
    } catch (error) {
      log.warn(`Failed to pull native camera delivery for ${topic}`, { error, eventName })
      this.failCameraTopic(
        topic,
        subscriptionGeneration,
        topicGeneration,
        generation,
        'camera pull failed or timed out'
      )
    } finally {
      if (pulled) {
        try {
          await withNativeOperationDeadline(
            invoke(TAURI_COMMANDS.transport.ackCameraFrame, {
              topic,
              deliveryId,
              cameraSubscriptionId,
              generation,
            }),
            CAMERA_ACK_TIMEOUT_MS,
            `Native camera acknowledgement timed out for ${topic}`
          )
        } catch (error) {
          log.warn(`Failed to acknowledge native camera delivery for ${topic}`, {
            error,
            eventName,
          })
          this.failCameraTopic(
            topic,
            subscriptionGeneration,
            topicGeneration,
            generation,
            'camera acknowledgement failed or timed out'
          )
        }
      }
    }
  }

  private enqueueForListener(
    topic: string,
    listener: NativeListener,
    message: unknown,
    subscriptionGeneration: number,
    topicGeneration: number
  ): void {
    if (!listener.active) return

    const now = performance.now()
    if (listener.throttleRateMs > 0 && now - listener.lastQueuedAt < listener.throttleRateMs) {
      return
    }
    listener.lastQueuedAt = now

    if (listener.queue.length >= listener.queueLength) {
      listener.queue.splice(0, listener.queue.length - listener.queueLength + 1)
    }
    let snapshot: unknown
    try {
      snapshot = snapshotMappedMessage(listener.type, message)
    } catch (error) {
      this.reportListenerError(topic, error)
      return
    }
    listener.queue.push(snapshot)
    if (listener.draining) return

    listener.draining = true
    queueMicrotask(() =>
      this.drainListener(topic, listener, subscriptionGeneration, topicGeneration)
    )
  }

  private drainListener(
    topic: string,
    listener: NativeListener,
    subscriptionGeneration: number,
    topicGeneration: number
  ): void {
    const currentListeners = this.listeners.get(topic)
    if (
      !listener.active ||
      !this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration) ||
      !currentListeners?.includes(listener)
    ) {
      listener.queue.length = 0
      listener.draining = false
      return
    }

    if (listener.queue.length === 0) {
      listener.draining = false
      return
    }
    const message = listener.queue.shift()

    let callbackResult: unknown
    try {
      callbackResult = (listener.callback as (value: unknown) => unknown)(message)
    } catch (error) {
      this.reportListenerError(topic, error)
      queueMicrotask(() =>
        this.drainListener(topic, listener, subscriptionGeneration, topicGeneration)
      )
      return
    }

    // Promise.resolve also handles synchronous void callbacks. Awaiting a
    // returned thenable keeps one slow consumer from overlapping its own
    // deliveries while every other listener continues independently.
    void Promise.resolve(callbackResult)
      .catch((error: unknown) => this.reportListenerError(topic, error))
      .finally(() =>
        queueMicrotask(() =>
          this.drainListener(topic, listener, subscriptionGeneration, topicGeneration)
        )
      )
  }

  private unsupported(feature: string): Error {
    return new Error(
      `[ZenohBridge] ${feature} is not supported over Zenoh transport. ` +
        'Use ROSBridge for this capability or add a native Zenoh request/response implementation.'
    )
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TOPIC OPERATIONS
  // ───────────────────────────────────────────────────────────────────────────

  subscribe<T>(
    topic: string,
    type: string,
    callback: ROSMessageCallback<T>,
    throttleRate?: number,
    queueLength?: number
  ): () => void {
    validateNativeTopic(topic)
    if (
      throttleRate !== undefined &&
      (!Number.isSafeInteger(throttleRate) ||
        throttleRate < 0 ||
        throttleRate > MAX_NATIVE_THROTTLE_MS)
    ) {
      throw new Error('Invalid native ROS throttle rate')
    }
    if (
      queueLength !== undefined &&
      (!Number.isSafeInteger(queueLength) ||
        queueLength < 1 ||
        queueLength > MAX_NATIVE_QUEUE_LENGTH)
    ) {
      throw new Error(
        `Invalid native ROS queue length: expected an integer within [1, ${MAX_NATIVE_QUEUE_LENGTH}]`
      )
    }
    if (this.state !== 'connected' || this.backendGeneration === null) {
      throw new Error('Native transport is not connected')
    }

    const registry = getMessageRegistry()
    const command = registry.getCommand(type)
    if (!command) {
      throw new Error(`Native ROS message type is not supported: ${type}`)
    }

    const existing = this.listeners.get(topic)
    if (existing && existing[0]?.type !== type) {
      throw new Error(
        `Native ROS topic ${topic} is already subscribed as ${existing[0].type}; refusing conflicting type ${type}`
      )
    }
    if (
      (existing?.length ?? 0) >= MAX_NATIVE_LISTENERS_PER_TOPIC ||
      this.listenerCount() >= MAX_NATIVE_LISTENERS
    ) {
      throw new Error('Native ROS subscription limit exceeded')
    }

    const listener: NativeListener = {
      id: this.nextListenerId(),
      type,
      callback: callback as ROSMessageCallback<unknown>,
      throttleRateMs: throttleRate ?? 0,
      queueLength: queueLength ?? DEFAULT_NATIVE_QUEUE_LENGTH,
      lastQueuedAt: Number.NEGATIVE_INFINITY,
      queue: [],
      draining: false,
      active: true,
      pendingCameraSettlements: new Set(),
    }
    if (existing) {
      existing.push(listener)
      return () => this.unsubscribeById(topic, listener.id)
    }

    this.listeners.set(topic, [listener])
    const subscriptionGeneration = this.subscriptionGeneration
    const topicGeneration = this.nextTopicGeneration(topic)
    const subscriptionId = reserveNativeSubscriptionId()
    this.subscriptionIds.set(topic, subscriptionId)

    this.setupSubscription(
      topic,
      type,
      command,
      subscriptionGeneration,
      topicGeneration,
      subscriptionId
    )
      .then((unlisten) => {
        if (!this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration)) {
          this.removeCameraDeliveryRunnerExact(topic, subscriptionGeneration, topicGeneration)
          if (unlisten) this.releaseUnlistener(unlisten, topic)
          return
        }
        if (!unlisten) return
        this.unlisteners.set(topic, unlisten)
      })
      .catch((err) => {
        this.removeCameraDeliveryRunnerExact(topic, subscriptionGeneration, topicGeneration)
        if (!this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration)) return
        log.error(`Failed to subscribe to ${topic}`, {
          error: err,
          eventName: getTransportEventName(topic),
        })
        this.notifyError(err)
        this.deactivateTopic(topic)
        this.listeners.delete(topic)
        if (this.subscriptionIds.get(topic) === subscriptionId) {
          this.subscriptionIds.delete(topic)
        }
      })

    return () => this.unsubscribeById(topic, listener.id)
  }

  private unsubscribeById(topic: string, listenerId: number): void {
    const subs = this.listeners.get(topic)
    if (!subs) return

    const idx = subs.findIndex((listener) => listener.id === listenerId)
    if (idx < 0) return
    const [listener] = subs.splice(idx, 1)
    this.deactivateListener(listener)

    if (subs.length === 0) {
      this.nextTopicGeneration(topic)
      // Remove backend listener
      const unlisten = this.unlisteners.get(topic)
      if (unlisten) {
        this.releaseUnlistener(unlisten, topic)
        this.unlisteners.delete(topic)
      }
      this.listeners.delete(topic)
      this.cameraDeliveryRunners.delete(topic)
      // Tell backend to stop subscription
      const subscriptionId = this.subscriptionIds.get(topic)
      this.subscriptionIds.delete(topic)
      const generation = this.backendGeneration
      if (generation === null) return
      if (subscriptionId === undefined) {
        this.notifyError(new Error(`Native subscription identity is missing for ${topic}`))
        return
      }
      void withNativeOperationDeadline(
        invoke(TAURI_COMMANDS.transport.unsubscribe, {
          topic,
          generation,
          subscriptionId,
        }),
        CAMERA_ACK_TIMEOUT_MS,
        `Native unsubscribe timed out for ${topic}`
      ).catch((err: unknown) => {
        log.warn(`Failed to unsubscribe from ${topic}`, {
          error: err,
          eventName: getTransportEventName(topic),
        })
      })
    }
  }

  private async setupSubscription(
    topic: string,
    type: string,
    command: string,
    subscriptionGeneration: number,
    topicGeneration: number,
    subscriptionId: string
  ): Promise<UnlistenFn | null> {
    const registry = getMessageRegistry()
    const isCamera = type === 'sensor_msgs/Image' || type === 'sensor_msgs/CompressedImage'
    const setupDeadline =
      performance.now() +
      (isCamera ? CAMERA_SETUP_TIMEOUT_MS : NATIVE_SUBSCRIPTION_SETUP_TIMEOUT_MS)

    let mapper: (data: unknown) => unknown
    if (type === 'sensor_msgs/Image') {
      mapper = (d) => this.mapImageFrame(d as RustCameraFrame)
    } else if (type === 'sensor_msgs/CompressedImage') {
      mapper = (d) => this.mapCompressedImageFrame(d as RustCameraFrame)
    } else if (type === 'sensor_msgs/CameraInfo') {
      mapper = (d) => this.mapCameraInfoData(d as RustCameraInfoData)
    } else if (type === 'sensor_msgs/Imu') {
      mapper = (d) => this.mapImuData(d as RustImuData)
    } else if (type === 'geometry_msgs/PoseStamped') {
      mapper = (d) => this.mapPoseData(d as RustPoseData)
    } else if (type === 'gazebo_msgs/ModelStates') {
      mapper = (d) => this.mapModelStates(d as RustModelStates)
    } else {
      throw new Error(`Native ROS message mapper is not supported: ${type}`)
    }

    if (isCamera) {
      this.cameraDeliveryRunners.set(topic, {
        subscriptionGeneration,
        topicGeneration,
        running: false,
        pending: null,
      })
    }

    // Set up listener FIRST to avoid race condition
    // This ensures we're listening before the backend sends frames
    const eventName = getTransportEventName(topic)
    const listenerTimeoutMs = setupDeadline - performance.now()
    if (listenerTimeoutMs <= 0) {
      throw new NativeOperationTimeoutError(`Native listener registration timed out for ${topic}`)
    }
    const listenerRegistration = listen(eventName, (event) => {
      if (!this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration)) return

      if (isCamera) {
        this.enqueueCameraDelivery(
          topic,
          type,
          mapper,
          event.payload,
          subscriptionGeneration,
          topicGeneration
        )
        return
      }

      const envelope = this.admitTelemetryEnvelope(topic, eventName, event.payload, subscriptionId)
      if (envelope === null) return

      if (!registry.validate(type, envelope.data)) {
        log.warn(`Rejected malformed native ${type} telemetry`, { topic, eventName })
        return
      }

      let msg: unknown
      try {
        msg = mapper(envelope.data)
      } catch (error) {
        log.warn(`Failed to map native ${type} telemetry`, { topic, eventName, error })
        return
      }
      const subs = this.listeners.get(topic)
      if (subs) {
        for (const listener of [...subs]) {
          this.enqueueForListener(topic, listener, msg, subscriptionGeneration, topicGeneration)
        }
      }
    })
    const unlisten = await withNativeOperationDeadline(
      listenerRegistration,
      listenerTimeoutMs,
      `Native listener registration timed out for ${topic}`,
      (lateUnlisten) => this.releaseUnlistener(lateUnlisten, `${topic}:late-registration`)
    )

    if (!this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration)) {
      this.removeCameraDeliveryRunnerExact(topic, subscriptionGeneration, topicGeneration)
      this.releaseUnlistener(unlisten, topic)
      return null
    }

    const generation = this.backendGeneration
    if (generation === null || this.state !== 'connected') {
      this.removeCameraDeliveryRunnerExact(topic, subscriptionGeneration, topicGeneration)
      this.releaseUnlistener(unlisten, topic)
      throw new Error('Native transport is not connected')
    }

    // NOW tell backend to start subscription
    try {
      const args =
        command === TAURI_COMMANDS.transport.subscribeCamera
          ? {
              topic,
              compressed: type === 'sensor_msgs/CompressedImage',
              cameraSubscriptionId: subscriptionId,
              generation,
            }
          : { topic, generation, subscriptionId }
      const remainingSetupMs = setupDeadline - performance.now()
      if (remainingSetupMs <= 0) {
        throw new NativeOperationTimeoutError(`Native subscription setup timed out for ${topic}`)
      }
      await withNativeOperationDeadline(
        invoke(command, args),
        remainingSetupMs,
        `Native subscription setup timed out for ${topic}`,
        () => {
          void this.cleanUpBackendSubscription(
            topic,
            generation,
            subscriptionId,
            'Late native subscription cleanup'
          ).catch((cleanupError: unknown) => {
            log.warn(`Failed to clean up late native subscription for ${topic}`, {
              error: cleanupError,
              eventName,
            })
          })
        }
      )
      if (!this.isSubscriptionCurrent(topic, subscriptionGeneration, topicGeneration)) {
        this.removeCameraDeliveryRunnerExact(topic, subscriptionGeneration, topicGeneration)
        this.releaseUnlistener(unlisten, topic)
        void this.cleanUpBackendSubscription(
          topic,
          generation,
          subscriptionId,
          'Stale native subscription cleanup'
        ).catch((cleanupError: unknown) => {
          log.warn(`Failed to clean up stale native subscription for ${topic}`, {
            error: cleanupError,
            eventName,
          })
        })
        return null
      }
    } catch (error) {
      // If backend subscription fails, clean up the listener
      this.removeCameraDeliveryRunnerExact(topic, subscriptionGeneration, topicGeneration)
      this.releaseUnlistener(unlisten, topic)
      try {
        await this.cleanUpBackendSubscription(
          topic,
          generation,
          subscriptionId,
          'Native subscription setup cleanup'
        )
      } catch (cleanupError) {
        log.warn(`Failed to clean up native subscription setup for ${topic}`, {
          error: cleanupError,
          eventName,
        })
      }
      log.warn(`Backend subscription failed for ${topic}`, { error, eventName })
      throw error
    }

    return unlisten
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DATA MAPPERS
  // ───────────────────────────────────────────────────────────────────────────

  private mapImageFrame(frame: RustCameraFrame): Image {
    return {
      header: headerFromRust(frame.frame_id, frame.timestamp),
      height: frame.height,
      width: frame.width,
      encoding: frame.encoding,
      is_bigendian: frame.is_bigendian,
      step: frame.step,
      data: frame.data,
    }
  }

  private mapCompressedImageFrame(frame: RustCameraFrame): CompressedImage {
    return {
      header: headerFromRust(frame.frame_id, frame.timestamp),
      format: frame.encoding,
      data: frame.data,
    }
  }

  private mapCameraInfoData(info: RustCameraInfoData): CameraInfo {
    return {
      header: headerFromRust(info.frame_id, info.timestamp),
      height: info.height,
      width: info.width,
      distortion_model: info.distortion_model,
      D: info.d,
      K: info.k,
      R: info.r,
      P: info.p,
    }
  }

  private mapImuData(data: RustImuData): Imu {
    return {
      header: headerFromRust(data.frame_id, data.timestamp),
      orientation: {
        x: data.orientation[0],
        y: data.orientation[1],
        z: data.orientation[2],
        w: data.orientation[3],
      },
      orientation_covariance: [...data.orientation_covariance],
      angular_velocity: {
        x: data.angular_velocity[0],
        y: data.angular_velocity[1],
        z: data.angular_velocity[2],
      },
      angular_velocity_covariance: [...data.angular_velocity_covariance],
      linear_acceleration: {
        x: data.linear_acceleration[0],
        y: data.linear_acceleration[1],
        z: data.linear_acceleration[2],
      },
      linear_acceleration_covariance: [...data.linear_acceleration_covariance],
    }
  }

  private mapPoseData(data: RustPoseData): PoseStamped {
    return {
      header: headerFromRust(data.frame_id, data.timestamp),
      pose: this.mapPose(data),
    }
  }

  private mapModelStates(data: RustModelStates): ModelStates {
    return {
      name: data.name,
      pose: data.pose.map((pose) => this.mapPose(pose)),
      twist: data.twist.map((twist) => this.mapTwist(twist)),
    }
  }

  private mapPose(data: RustPoseData): Pose {
    const pose = {
      position: { x: data.position[0], y: data.position[1], z: data.position[2] },
      orientation: {
        x: data.orientation[0],
        y: data.orientation[1],
        z: data.orientation[2],
        w: data.orientation[3],
      },
    }
    validateGazeboPose(pose)
    return pose
  }

  private mapTwist(data: RustVelocityCmd): Twist {
    const twist = {
      linear: { x: data.linear[0], y: data.linear[1], z: data.linear[2] },
      angular: { x: data.angular[0], y: data.angular[1], z: data.angular[2] },
    }
    validateGazeboTwist(twist)
    return twist
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HELPERS (Compatibility with ROSBridge)
  // ───────────────────────────────────────────────────────────────────────────

  subscribeToModelStates(
    callback: ROSMessageCallback<ModelStates>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe('/gazebo/model_states', 'gazebo_msgs/ModelStates', callback, throttleRate)
  }

  subscribeToPose(
    namespace: string,
    callback: ROSMessageCallback<PoseStamped>,
    throttleRate: number = 50
  ): () => void {
    const ns = normalizeRosNamespace(namespace)
    return this.subscribe(
      `/${ns}/mavros/local_position/pose`,
      'geometry_msgs/PoseStamped',
      callback,
      throttleRate
    )
  }

  subscribeToOdometry(_ns: string, _cb: (msg: unknown) => void): () => void {
    throw this.unsupported('Odometry subscriptions')
  }
  subscribeToState(_ns: string, _cb: (msg: unknown) => void): () => void {
    throw this.unsupported('MAVROS state subscriptions')
  }
}
