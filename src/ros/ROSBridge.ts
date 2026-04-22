/**
 * CREBAIN ROS Bridge Client
 * Adaptive Response & Awareness System (ARAS)
 *
 * WebSocket client for rosbridge_suite with auto-reconnect
 */

import type {
  ROSBridgeMessage,
  ROSMessageCallback,
  ConnectionState,
} from './types'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type { ConnectionState } from './types'

export interface ROSBridgeConfig {
  url: string
  autoReconnect: boolean
  reconnectIntervalMs: number
  maxReconnectAttempts: number
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (error: Error) => void
  onStateChange?: (state: ConnectionState) => void
}

interface Subscription {
  topic: string
  type: string
  callback: ROSMessageCallback<unknown>
  throttleRate?: number
  queueLength?: number
}

interface PendingServiceCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ─────────────────────────────────────────────────────────────────────────────
// ROS BRIDGE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

// Allowed URL schemes for ROS bridge connections
const ALLOWED_SCHEMES = ['ws:', 'wss:']

// Validate ROS bridge URL for security
function validateRosUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url)
    
    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      return { valid: false, error: `Invalid scheme: ${parsed.protocol}. Only ws:// and wss:// are allowed.` }
    }
    
    if (!parsed.hostname) {
      return { valid: false, error: 'Missing hostname in URL' }
    }
    
    // Block potentially dangerous hostnames
    if (parsed.hostname.includes('..') || parsed.hostname.startsWith('-')) {
      return { valid: false, error: 'Invalid hostname format' }
    }
    
    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }
}

export class ROSBridge {
  private ws: WebSocket | null = null
  private config: ROSBridgeConfig
  private state: ConnectionState = 'disconnected'
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private subscriptions: Map<string, Subscription[]> = new Map()
  private advertisedTopics: Map<string, string> = new Map() // topic -> type
  private pendingServiceCalls: Map<string, PendingServiceCall> = new Map()
  private messageIdCounter = 0

  constructor(config: Partial<ROSBridgeConfig> & { url: string }) {
    const validation = validateRosUrl(config.url)
    if (!validation.valid) {
      throw new Error(`Invalid ROS bridge URL: ${validation.error}`)
    }
    
    this.config = {
      autoReconnect: true,
      reconnectIntervalMs: 3000,
      maxReconnectAttempts: 10,
      ...config,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state === 'connected') {
        resolve()
        return
      }

      this.setState('connecting')
      
      this.ws = new WebSocket(this.config.url)

      this.ws.onopen = () => {
        this.setState('connected')
        this.reconnectAttempts = 0
        this.resubscribeAll()
        this.readvertiseAll()
        this.config.onConnect?.()
        resolve()
      }

      this.ws.onclose = () => {
        this.ws = null
        const wasConnected = this.state === 'connected'
        this.setState('disconnected')
        
        if (wasConnected) {
          this.config.onDisconnect?.()
        }

        if (this.config.autoReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
          this.scheduleReconnect()
        }
      }

      this.ws.onerror = (event) => {
        const error = new Error(`WebSocket error: ${event.type}`)
        this.config.onError?.(error)
        
        if (this.state === 'connecting') {
          reject(error)
        }
      }

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data)
      }
    })
  }

  disconnect(): void {
    this.config.autoReconnect = false
    this.clearReconnectTimer()
    
    // Clear all pending service calls to prevent memory leaks
    for (const [, pending] of this.pendingServiceCalls) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Disconnected from ROS bridge'))
    }
    this.pendingServiceCalls.clear()
    
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    
    this.setState('disconnected')
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.config.onStateChange?.(state)
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()
    this.reconnectAttempts++
    this.setState('reconnecting')
    
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        if (this.config.onError) {
          this.config.onError(error instanceof Error ? error : new Error(String(error)))
        }
      })
    }, this.config.reconnectIntervalMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  getState(): ConnectionState {
    return this.state
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.ws !== null
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MESSAGE HANDLING
  // ───────────────────────────────────────────────────────────────────────────

  private handleMessage(data: string): void {
    let message: ROSBridgeMessage
    try {
      message = JSON.parse(data)
    } catch (e) {
      // Malformed JSON - ignore invalid messages
      return
    }

    switch (message.op) {
      case 'publish':
        this.handleTopicMessage(message.topic!, message.msg)
        break
      case 'service_response':
        this.handleServiceResponse(message.id!, message.values, message.result as boolean)
        break
      default:
        // Ignore other message types
        break
    }
  }

  private handleTopicMessage(topic: string, msg: unknown): void {
    const subs = this.subscriptions.get(topic)
    if (subs) {
      for (const sub of subs) {
        sub.callback(msg)
      }
    }
  }

  private handleServiceResponse(id: string, values: unknown, result: boolean): void {
    const pending = this.pendingServiceCalls.get(id)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingServiceCalls.delete(id)
      
      if (result) {
        pending.resolve(values)
      } else {
        pending.reject(new Error('Service call failed'))
      }
    }
  }

  private send(message: ROSBridgeMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  private generateId(): string {
    return `msg_${++this.messageIdCounter}_${Date.now()}`
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
    const subscription: Subscription = {
      topic,
      type,
      callback: callback as ROSMessageCallback<unknown>,
      throttleRate,
      queueLength,
    }

    // Add to local subscriptions
    const subs = this.subscriptions.get(topic) || []
    subs.push(subscription)
    this.subscriptions.set(topic, subs)

    // Send subscribe message if this is the first subscription to this topic
    if (subs.length === 1) {
      this.send({
        op: 'subscribe',
        id: this.generateId(),
        topic,
        type,
        throttle_rate: throttleRate,
        queue_length: queueLength,
      })
    }

    // Return unsubscribe function
    return () => this.unsubscribe(topic, callback as ROSMessageCallback<unknown>)
  }

  unsubscribe(topic: string, callback: ROSMessageCallback<unknown>): void {
    const subs = this.subscriptions.get(topic)
    if (!subs) return

    const idx = subs.findIndex(s => s.callback === callback)
    if (idx !== -1) {
      subs.splice(idx, 1)
    }

    // Send unsubscribe message if no more subscriptions to this topic
    if (subs.length === 0) {
      this.subscriptions.delete(topic)
      this.send({
        op: 'unsubscribe',
        id: this.generateId(),
        topic,
      })
    }
  }

  advertise(topic: string, type: string): void {
    this.advertisedTopics.set(topic, type)
    this.send({
      op: 'advertise',
      id: this.generateId(),
      topic,
      type,
    })
  }

  unadvertise(topic: string): void {
    this.advertisedTopics.delete(topic)
    this.send({
      op: 'unadvertise',
      id: this.generateId(),
      topic,
    })
  }

  publish<T>(topic: string, msg: T): void {
    this.send({
      op: 'publish',
      id: this.generateId(),
      topic,
      msg,
    })
  }

  private resubscribeAll(): void {
    for (const [topic, subs] of this.subscriptions) {
      if (subs.length > 0) {
        const first = subs[0]
        this.send({
          op: 'subscribe',
          id: this.generateId(),
          topic,
          type: first.type,
          throttle_rate: first.throttleRate,
          queue_length: first.queueLength,
        })
      }
    }
  }

  private readvertiseAll(): void {
    // Re-advertise all previously advertised topics after reconnection
    for (const [topic, type] of this.advertisedTopics) {
      this.send({
        op: 'advertise',
        id: this.generateId(),
        topic,
        type,
      })
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SERVICE OPERATIONS
  // ───────────────────────────────────────────────────────────────────────────

  callService<TRequest, TResponse>(
    service: string,
    request: TRequest,
    timeoutMs: number = 10000
  ): Promise<TResponse> {
    return new Promise((resolve, reject) => {
      const id = this.generateId()

      const timeout = setTimeout(() => {
        this.pendingServiceCalls.delete(id)
        reject(new Error(`Service call to ${service} timed out`))
      }, timeoutMs)

      this.pendingServiceCalls.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      })

      this.send({
        op: 'call_service',
        id,
        service,
        args: request,
      })
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GAZEBO SPECIFIC HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  subscribeToModelStates(
    callback: ROSMessageCallback<import('./types').ModelStates>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      '/gazebo/model_states',
      'gazebo_msgs/ModelStates',
      callback,
      throttleRate
    )
  }

  subscribeToOdometry(
    namespace: string,
    callback: ROSMessageCallback<import('./types').Odometry>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      `/${namespace}/mavros/local_position/odom`,
      'nav_msgs/Odometry',
      callback,
      throttleRate
    )
  }

  subscribeToPose(
    namespace: string,
    callback: ROSMessageCallback<import('./types').PoseStamped>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      `/${namespace}/mavros/local_position/pose`,
      'geometry_msgs/PoseStamped',
      callback,
      throttleRate
    )
  }

  subscribeToState(
    namespace: string,
    callback: ROSMessageCallback<import('./types').State>
  ): () => void {
    return this.subscribe(
      `/${namespace}/mavros/state`,
      'mavros_msgs/State',
      callback
    )
  }

  publishSetpointPosition(
    namespace: string,
    pose: import('./types').PoseStamped
  ): void {
    this.publish(`/${namespace}/mavros/setpoint_position/local`, pose)
  }

  publishSetpointVelocity(
    namespace: string,
    twist: import('./types').TwistStamped
  ): void {
    this.publish(`/${namespace}/mavros/setpoint_velocity/cmd_vel`, twist)
  }

  async setMode(namespace: string, mode: string): Promise<boolean> {
    const response = await this.callService<{ custom_mode: string }, { mode_sent: boolean }>(
      `/${namespace}/mavros/set_mode`,
      { custom_mode: mode }
    )
    return response.mode_sent
  }

  async arm(namespace: string, value: boolean = true): Promise<boolean> {
    const response = await this.callService<{ value: boolean }, { success: boolean }>(
      `/${namespace}/mavros/cmd/arming`,
      { value }
    )
    return response.success
  }

  async takeoff(
    namespace: string,
    altitude: number,
    latitude: number = 0,
    longitude: number = 0
  ): Promise<boolean> {
    const response = await this.callService<
      { min_pitch: number; yaw: number; latitude: number; longitude: number; altitude: number },
      { success: boolean }
    >(
      `/${namespace}/mavros/cmd/takeoff`,
      { min_pitch: 0, yaw: 0, latitude, longitude, altitude }
    )
    return response.success
  }

  async land(namespace: string): Promise<boolean> {
    const response = await this.callService<
      { min_pitch: number; yaw: number; latitude: number; longitude: number; altitude: number },
      { success: boolean }
    >(
      `/${namespace}/mavros/cmd/land`,
      { min_pitch: 0, yaw: 0, latitude: 0, longitude: 0, altitude: 0 }
    )
    return response.success
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLETON INSTANCE
// ─────────────────────────────────────────────────────────────────────────────

let defaultBridge: ROSBridge | null = null

export function getROSBridge(): ROSBridge | null {
  return defaultBridge
}
