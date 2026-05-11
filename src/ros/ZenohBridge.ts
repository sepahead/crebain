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
  TwistStamped,
  Twist,
  Image,
  CompressedImage,
  CameraInfo,
  Imu,
  ModelStates,
  ConnectionState
} from './types'
import { createHeader } from './types'
import { getMessageRegistry } from './MessageRegistry'
import { normalizeRosNamespace } from './utils'
import { rosLogger as log } from '../lib/logger'
import { TAURI_COMMANDS } from '../lib/tauriCommands'
import { getTransportEventName } from '../lib/transportEvents'

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
  angular_velocity: [number, number, number]
  linear_acceleration: [number, number, number]
  timestamp: number
}

interface RustModelStates {
  name: string[]
  pose: RustPoseData[]
  twist: RustVelocityCmd[]
}

interface RustTwistStampedData {
  twist: RustVelocityCmd
  timestamp: number
  frame_id: string
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// ZENOH BRIDGE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

export class ZenohBridge {
  private state: ConnectionState = 'disconnected'
  private unlisteners: Map<string, UnlistenFn> = new Map()
  private listeners: Map<string, ROSMessageCallback<unknown>[]> = new Map()
  
  // Per-topic throttle tracking for client-side rate limiting
  private topicThrottles: Map<string, { rate: number; lastEmit: number }> = new Map()

  // Configuration (mocking ROSBridge config)
  public config = {
    url: 'zenoh://localhost',
    autoReconnect: true,
  }

  public onStateChange?: (state: ConnectionState) => void

  constructor() {}

  // ───────────────────────────────────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.state === 'connected') return

    this.setState('connecting')
    try {
      await invoke(TAURI_COMMANDS.transport.connect)
      this.setState('connected')
    } catch (error) {
      this.setState('disconnected')
      throw error
    }
  }

  async disconnect(): Promise<void> {
    try {
      await invoke(TAURI_COMMANDS.transport.disconnect)
      for (const unlisten of this.unlisteners.values()) {
        unlisten()
      }
      this.unlisteners.clear()
      this.listeners.clear()
      this.topicThrottles.clear()
      this.setState('disconnected')
    } catch {
      // Disconnect errors are non-fatal
      this.setState('disconnected')
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
    this.onStateChange?.(state)
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
    _queueLength?: number
  ): () => void {
    const wrappedCallback = callback as ROSMessageCallback<unknown>
    const existing = this.listeners.get(topic)
    
    // Store throttle rate for this topic (use provided rate or default to no throttling)
    if (throttleRate && throttleRate > 0) {
      this.topicThrottles.set(topic, { rate: throttleRate, lastEmit: 0 })
    }
    
    if (existing) {
      // Already subscribed to this topic, just add the callback
      existing.push(wrappedCallback)
      return () => this.unsubscribe(topic, wrappedCallback)
    }

    // First subscriber to this topic
    this.listeners.set(topic, [wrappedCallback])

    // Set up backend subscription
    this.setupSubscription(topic, type)
      .then((unlisten) => {
        if (!unlisten) {
          // Backend subscription not created (unsupported type)
          this.listeners.delete(topic)
          return
        }
        // Check if listeners were removed while we were setting up
        if (!this.listeners.has(topic)) {
          unlisten()
          return
        }
        this.unlisteners.set(topic, unlisten)
      })
      .catch((err) => {
        log.error(`Failed to subscribe to ${topic}`, {
          error: err,
          eventName: getTransportEventName(topic),
        })
        this.listeners.delete(topic)
        this.topicThrottles.delete(topic)
      })

    return () => this.unsubscribe(topic, wrappedCallback)
  }

  unsubscribe(topic: string, callback: ROSMessageCallback<unknown>): void {
    const subs = this.listeners.get(topic)
    if (!subs) return

    const idx = subs.findIndex(s => s === callback)
    if (idx !== -1) {
      subs.splice(idx, 1)
    }

    if (subs.length === 0) {
      // Remove backend listener
      const unlisten = this.unlisteners.get(topic)
      if (unlisten) {
        unlisten()
        this.unlisteners.delete(topic)
      }
      this.listeners.delete(topic)
      this.topicThrottles.delete(topic)
      // Tell backend to stop subscription
      invoke(TAURI_COMMANDS.transport.unsubscribe, { topic }).catch(err => {
        log.warn(`Failed to unsubscribe from ${topic}`, {
          error: err,
          eventName: getTransportEventName(topic),
        })
      })
    }
  }

  private async setupSubscription(topic: string, type: string): Promise<UnlistenFn | null> {
    const registry = getMessageRegistry()
    
    // Check if type is registered
    if (!registry.isRegistered(type)) {
      log.warn(`Subscription type not supported: ${type}`)
      return null
    }

    // Get command from registry
    const command = registry.getCommand(type)
    if (!command) {
      log.warn(`No command registered for type ${type}`)
      return null
    }

    // Select appropriate mapper based on type
    // Use arrow wrappers to preserve `this` context for mapper methods
    let mapper: (data: unknown) => unknown = (d) => d
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
    }

    // Set up listener FIRST to avoid race condition
    // This ensures we're listening before the backend sends frames
    const eventName = getTransportEventName(topic)
    const unlisten = await listen(eventName, (event) => {
      // Apply client-side throttling if configured for this topic
      const throttle = this.topicThrottles.get(topic)
      if (throttle) {
        const now = performance.now()
        if (now - throttle.lastEmit < throttle.rate) {
          return // Skip this message due to throttle
        }
        throttle.lastEmit = now
      }
      
      const msg = mapper(event.payload)
      const subs = this.listeners.get(topic)
      if (subs) {
        subs.forEach(cb => cb(msg))
      }
    })

    // NOW tell backend to start subscription
    try {
      await invoke(command, { topic })
    } catch (error) {
      // If backend subscription fails, clean up the listener
      unlisten()
      log.warn(`Backend subscription failed for ${topic}`, { error, eventName })
      throw error
    }

    return unlisten
  }

  publish<T>(topic: string, msgOrType: T | string, msg?: T): void {
    this.publishAsync(topic, msgOrType, msg).catch(e => {
      log.error(`Failed to publish to ${topic}`, { error: e })
    })
  }

  async publishAsync<T>(topic: string, msgOrType: T | string, msg?: T): Promise<void> {
    // Support both old and new signatures for compatibility
    // Old: publish(topic, message)
    // New: publish(topic, type, message)
    let type: string
    let message: T
    
    if (typeof msgOrType === 'string') {
      // New signature: (topic, type, message)
      type = msgOrType
      message = msg!
    } else {
      // Old signature: (topic, message) - infer type from message
      message = msgOrType
      type = this.inferMessageType(message)
    }

    if (type === 'geometry_msgs/Twist') {
      const cmd = this.mapTwistToRust(message as unknown as Twist)
      await invoke(TAURI_COMMANDS.transport.publishVelocity, { topic, cmd })
    } else if (type === 'geometry_msgs/TwistStamped') {
      const cmd = this.mapTwistStampedToRust(message as unknown as TwistStamped)
      await invoke(TAURI_COMMANDS.transport.publishTwistStamped, { topic, cmd })
    } else if (type === 'geometry_msgs/PoseStamped') {
      const pose = this.mapPoseStampedToRust(message as unknown as PoseStamped)
      await invoke(TAURI_COMMANDS.transport.publishPose, { topic, pose })
    } else {
      throw this.unsupported(`Publish message type ${type}`)
    }
  }

  /**
   * Infer message type from message structure (legacy support)
   * Prefer explicit type parameter in publish(topic, type, msg)
   */
  private inferMessageType(msg: unknown): string {
    if (!isRecord(msg)) {
      return 'unknown'
    }
    if ('linear' in msg && 'angular' in msg && !('header' in msg)) {
      return 'geometry_msgs/Twist'
    }
    if ('header' in msg && 'twist' in msg) {
      return 'geometry_msgs/TwistStamped'
    }
    if ('pose' in msg && 'header' in msg) {
      return 'geometry_msgs/PoseStamped'
    }
    return 'unknown'
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DATA MAPPERS
  // ───────────────────────────────────────────────────────────────────────────

  private mapImageFrame(frame: RustCameraFrame): Image {
    return {
      header: createHeader(frame.frame_id),
      height: frame.height,
      width: frame.width,
      encoding: frame.encoding,
      is_bigendian: frame.is_bigendian,
      step: frame.step,
      data: frame.data
    }
  }

  private mapCompressedImageFrame(frame: RustCameraFrame): CompressedImage {
    return {
      header: createHeader(frame.frame_id),
      format: frame.encoding,
      data: frame.data,
    }
  }

  private mapCameraInfoData(info: RustCameraInfoData): CameraInfo {
    return {
      header: createHeader(info.frame_id),
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
      header: createHeader('imu_link'),
      orientation: { x: data.orientation[0], y: data.orientation[1], z: data.orientation[2], w: data.orientation[3] },
      orientation_covariance: [],
      angular_velocity: { x: data.angular_velocity[0], y: data.angular_velocity[1], z: data.angular_velocity[2] },
      angular_velocity_covariance: [],
      linear_acceleration: { x: data.linear_acceleration[0], y: data.linear_acceleration[1], z: data.linear_acceleration[2] },
      linear_acceleration_covariance: []
    }
  }

  private mapPoseData(data: RustPoseData): PoseStamped {
    return {
      header: createHeader(data.frame_id),
      pose: {
        position: { x: data.position[0], y: data.position[1], z: data.position[2] },
        orientation: { x: data.orientation[0], y: data.orientation[1], z: data.orientation[2], w: data.orientation[3] }
      }
    }
  }

  private mapModelStates(data: RustModelStates): ModelStates {
    return {
      name: data.name,
      pose: data.pose.map(p => ({
        position: { x: p.position[0], y: p.position[1], z: p.position[2] },
        orientation: { x: p.orientation[0], y: p.orientation[1], z: p.orientation[2], w: p.orientation[3] }
      })),
      twist: data.twist.map(t => ({
        linear: { x: t.linear[0], y: t.linear[1], z: t.linear[2] },
        angular: { x: t.angular[0], y: t.angular[1], z: t.angular[2] }
      }))
    }
  }

  private mapTwistToRust(twist: Twist): RustVelocityCmd {
    return {
      linear: [twist.linear.x, twist.linear.y, twist.linear.z],
      angular: [twist.angular.x, twist.angular.y, twist.angular.z]
    }
  }

  private mapTwistStampedToRust(msg: TwistStamped): RustTwistStampedData {
    return {
      twist: this.mapTwistToRust(msg.twist),
      timestamp: msg.header.stamp.secs + msg.header.stamp.nsecs * 1e-9,
      frame_id: msg.header.frame_id,
    }
  }

  private mapPoseStampedToRust(msg: PoseStamped): RustPoseData {
    return {
      position: [msg.pose.position.x, msg.pose.position.y, msg.pose.position.z],
      orientation: [msg.pose.orientation.x, msg.pose.orientation.y, msg.pose.orientation.z, msg.pose.orientation.w],
      timestamp: msg.header.stamp.secs + msg.header.stamp.nsecs * 1e-9,
      frame_id: msg.header.frame_id
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HELPERS (Compatibility with ROSBridge)
  // ───────────────────────────────────────────────────────────────────────────

  subscribeToModelStates(
    callback: ROSMessageCallback<ModelStates>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      '/gazebo/model_states',
      'gazebo_msgs/ModelStates',
      callback,
      throttleRate
    )
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

  async callService<TRequest, TResponse>(
    _service: string,
    _request: TRequest,
    _timeoutMs: number = 10000
  ): Promise<TResponse> {
    // Zenoh service calls require a proper request/response protocol implementation.
    // The ROS2 service layer over Zenoh needs:
    // 1. Service request CDR encoding with correlation IDs
    // 2. Service response topic subscription
    // 3. Request/response matching
    // 
    // For Gazebo control (pause/unpause/reset), use direct topic publishing instead,
    // or use ROSBridge which supports native ROS service calls.
    throw new Error(
      '[ZenohBridge] Service calls are not supported over Zenoh transport. ' +
      'Use ROSBridge for service calls, or implement direct topic-based control.'
    )
  }

  subscribeToOdometry(_ns: string, _cb: (msg: unknown) => void): () => void { throw this.unsupported('Odometry subscriptions') }
  subscribeToState(_ns: string, _cb: (msg: unknown) => void): () => void { throw this.unsupported('MAVROS state subscriptions') }
  
  publishSetpointPosition(ns: string, pose: PoseStamped): Promise<void> {
    const n = normalizeRosNamespace(ns)
    return this.publishAsync(`/${n}/mavros/setpoint_position/local`, 'geometry_msgs/PoseStamped', pose)
  }

  publishSetpointVelocity(ns: string, twist: TwistStamped): Promise<void> {
    const n = normalizeRosNamespace(ns)
    return this.publishAsync(`/${n}/mavros/setpoint_velocity/cmd_vel`, 'geometry_msgs/TwistStamped', twist)
  }

  async setMode(_namespace: string, _mode: string): Promise<boolean> { throw this.unsupported('MAVROS setMode') }
  async arm(_namespace: string, _value: boolean = true): Promise<boolean> { throw this.unsupported('MAVROS arming') }
  async takeoff(_namespace: string, _altitude: number, _latitude: number = 0, _longitude: number = 0): Promise<boolean> { throw this.unsupported('MAVROS takeoff') }
  async land(_namespace: string): Promise<boolean> { throw this.unsupported('MAVROS landing') }
}
