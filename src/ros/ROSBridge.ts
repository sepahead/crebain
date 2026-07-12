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
  ModelStates,
  Odometry,
  PoseStamped,
  State,
} from './types'
import { namespacedRosTopic } from './utils'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type { ConnectionState } from './types'

/** Raw renderer rosbridge is available only in Vite development and tests. */
export const RENDERER_ROSBRIDGE_AVAILABLE = true

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

interface SubscribeParams {
  throttleRate?: number
  queueLength?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// ROS BRIDGE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

// Allowed URL schemes for ROS bridge connections
const ALLOWED_SCHEMES = ['ws:', 'wss:']
const MAX_ROS_NAME_LENGTH = 256
const ROS_GRAPH_NAME_PATTERN = /^\/[A-Za-z0-9_/]+$/
const ROS_MESSAGE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*\/[A-Za-z][A-Za-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateRosGraphName(name: string, kind: 'topic' | 'service'): void {
  if (name.length === 0 || name.trim() !== name) {
    throw new Error(`Invalid ROS ${kind}: name must not be empty or padded`)
  }
  if (name.length > MAX_ROS_NAME_LENGTH) {
    throw new Error(`Invalid ROS ${kind}: name exceeds ${MAX_ROS_NAME_LENGTH} characters`)
  }
  if (name === '/' || !name.startsWith('/')) {
    throw new Error(`Invalid ROS ${kind}: name must be absolute`)
  }
  if (name.includes('//') || name.includes('\0') || /\s/.test(name) || !ROS_GRAPH_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ROS ${kind}: name contains invalid characters`)
  }
}

function validateRosMessageType(type: string): void {
  if (!ROS_MESSAGE_TYPE_PATTERN.test(type)) {
    throw new Error('Invalid ROS message type')
  }
}

function subscribeParamsEqual(a: SubscribeParams, b: SubscribeParams): boolean {
  return a.throttleRate === b.throttleRate && a.queueLength === b.queueLength
}

function validateNonNegativeNumber(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`Invalid ROS ${field}: value must be a non-negative finite number`)
  }
}

// Validate ROS bridge URL for security
export function validateRosUrl(url: string): { valid: boolean; error?: string } {
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
  private intentionalClose = false
  private pendingConnectReject: ((error: Error) => void) | null = null
  private subscriptions: Map<string, Subscription[]> = new Map()
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
    // A manual (re)connect re-enables auto-reconnect after an intentional
    // disconnect() and starts with a fresh reconnect-attempt budget.
    this.intentionalClose = false
    this.reconnectAttempts = 0
    return this.openSocket()
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state === 'connected' && this.canSend()) {
        resolve()
        return
      }

      // Re-entry safety: cancel any pending reconnect and tear down a socket
      // that is still connecting/open so two live sockets never coexist and an
      // orphaned socket's events cannot clobber the state of a newer one.
      this.clearReconnectTimer()
      this.teardownSocket()

      this.setState('connecting')

      const ws = new WebSocket(this.config.url)
      this.ws = ws
      this.pendingConnectReject = reject

      ws.onopen = () => {
        if (this.ws !== ws) return
        this.pendingConnectReject = null
        this.setState('connected')
        this.reconnectAttempts = 0
        this.resubscribeAll()
        this.config.onConnect?.()
        resolve()
      }

      ws.onclose = () => {
        if (this.ws !== ws) return
        this.ws = null
        const wasConnected = this.state === 'connected'
        this.setState('disconnected')

        // A socket that closed before opening is a failed connect attempt.
        const pendingReject = this.pendingConnectReject
        this.pendingConnectReject = null
        pendingReject?.(new Error('Connection closed before opening'))

        if (wasConnected) {
          this.config.onDisconnect?.()
        }

        if (
          !this.intentionalClose &&
          this.config.autoReconnect &&
          this.reconnectAttempts < this.config.maxReconnectAttempts
        ) {
          this.scheduleReconnect()
        }
      }

      ws.onerror = (event) => {
        if (this.ws !== ws) return
        const error = new Error(`WebSocket error: ${event.type}`)
        this.config.onError?.(error)

        if (this.state === 'connecting') {
          this.pendingConnectReject = null
          reject(error)
        }
      }

      ws.onmessage = (event: MessageEvent<unknown>) => {
        if (this.ws !== ws) return
        if (typeof event.data === 'string') {
          this.handleMessage(event.data)
        }
      }
    })
  }

  disconnect(): void {
    // Mark the close as intentional so it does not trigger auto-reconnect;
    // the next manual connect() re-enables reconnection.
    this.intentionalClose = true
    this.clearReconnectTimer()
    this.teardownSocket('Disconnected from ROS bridge')
    this.setState('disconnected')
  }

  /**
   * Detach and close the current socket (if any) without firing its handlers,
   * rejecting any connect() promise still waiting on it.
   */
  private teardownSocket(reason: string = 'Connection attempt superseded'): void {
    const pendingReject = this.pendingConnectReject
    this.pendingConnectReject = null
    pendingReject?.(new Error(reason))

    const ws = this.ws
    if (!ws) return
    this.ws = null
    ws.onopen = null
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
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
      // Use openSocket() directly so automatic retries do not reset the
      // reconnect-attempt budget the way a manual connect() does.
      this.openSocket().catch((error) => {
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
    return this.state === 'connected' && this.canSend()
  }

  private canSend(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MESSAGE HANDLING
  // ───────────────────────────────────────────────────────────────────────────

  private handleMessage(data: string): void {
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      // Malformed JSON - ignore invalid messages
      return
    }

    if (!isRecord(message) || typeof message.op !== 'string') {
      return
    }

    switch (message.op) {
      case 'publish':
        if (typeof message.topic !== 'string') return
        this.handleTopicMessage(message.topic, message.msg)
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

  #send(message: ROSBridgeMessage): boolean {
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
      return true
    }
    return false
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
    validateRosGraphName(topic, 'topic')
    validateRosMessageType(type)
    validateNonNegativeNumber(throttleRate, 'throttle rate')
    validateNonNegativeNumber(queueLength, 'queue length')

    const subscription: Subscription = {
      topic,
      type,
      callback: callback as ROSMessageCallback<unknown>,
      throttleRate,
      queueLength,
    }

    // Add to local subscriptions
    const subs = this.subscriptions.get(topic) || []
    const previousParams = this.effectiveSubscribeParams(subs)
    subs.push(subscription)
    this.subscriptions.set(topic, subs)

    // (Re)send the subscribe request when this is the first subscriber or the
    // pooled throttle/queue parameters became more permissive.
    const params = this.effectiveSubscribeParams(subs)
    if (subs.length === 1 || !subscribeParamsEqual(previousParams, params)) {
      this.sendSubscribe(topic, subs[0].type, params)
    }

    // Return unsubscribe function
    return () => this.unsubscribe(topic, callback as ROSMessageCallback<unknown>)
  }

  unsubscribe(topic: string, callback: ROSMessageCallback<unknown>): void {
    validateRosGraphName(topic, 'topic')
    const subs = this.subscriptions.get(topic)
    if (!subs) return

    const idx = subs.findIndex(s => s.callback === callback)
    if (idx === -1) return

    const previousParams = this.effectiveSubscribeParams(subs)
    subs.splice(idx, 1)

    // Send unsubscribe message if no more subscriptions to this topic
    if (subs.length === 0) {
      this.subscriptions.delete(topic)
      this.#send({
        op: 'unsubscribe',
        id: this.generateId(),
        topic,
      })
      return
    }

    // Remaining subscribers may allow stricter throttling — update the server.
    const params = this.effectiveSubscribeParams(subs)
    if (!subscribeParamsEqual(previousParams, params)) {
      this.sendSubscribe(topic, subs[0].type, params)
    }
  }

  /**
   * Pool the most permissive subscribe parameters across a topic's
   * subscribers: the smallest throttle interval and the largest queue.
   * An undefined throttle from any subscriber means "every message", which
   * always wins.
   */
  private effectiveSubscribeParams(subs: Subscription[]): SubscribeParams {
    let throttleRate: number | undefined
    let queueLength: number | undefined
    let unthrottled = subs.length === 0

    for (const sub of subs) {
      if (sub.throttleRate === undefined) {
        unthrottled = true
      } else if (throttleRate === undefined || sub.throttleRate < throttleRate) {
        throttleRate = sub.throttleRate
      }
      if (sub.queueLength !== undefined && (queueLength === undefined || sub.queueLength > queueLength)) {
        queueLength = sub.queueLength
      }
    }

    return { throttleRate: unthrottled ? undefined : throttleRate, queueLength }
  }

  private sendSubscribe(topic: string, type: string, params: SubscribeParams): void {
    this.#send({
      op: 'subscribe',
      id: this.generateId(),
      topic,
      type,
      throttle_rate: params.throttleRate,
      queue_length: params.queueLength,
    })
  }

  private resubscribeAll(): void {
    for (const [topic, subs] of this.subscriptions) {
      if (subs.length > 0) {
        this.sendSubscribe(topic, subs[0].type, this.effectiveSubscribeParams(subs))
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GAZEBO SPECIFIC HELPERS
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

  subscribeToOdometry(
    namespace: string,
    callback: ROSMessageCallback<Odometry>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      namespacedRosTopic(namespace, 'mavros/local_position/odom'),
      'nav_msgs/Odometry',
      callback,
      throttleRate
    )
  }

  subscribeToPose(
    namespace: string,
    callback: ROSMessageCallback<PoseStamped>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      namespacedRosTopic(namespace, 'mavros/local_position/pose'),
      'geometry_msgs/PoseStamped',
      callback,
      throttleRate
    )
  }

  subscribeToState(
    namespace: string,
    callback: ROSMessageCallback<State>
  ): () => void {
    return this.subscribe(
      namespacedRosTopic(namespace, 'mavros/state'),
      'mavros_msgs/State',
      callback
    )
  }

}
