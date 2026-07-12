/**
 * CREBAIN ROS Bridge React Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * React hook for managing ROS bridge connection state
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ROSBridge } from '#renderer-rosbridge'
import { ZenohBridge } from '../ros/ZenohBridge'
import {
  ROSPerformanceMonitor,
  type ConnectionQuality,
  type PerformanceAlert,
  type TopicStats,
} from '../ros/ROSPerformanceMonitor'
import type { ConnectionState, ModelStates, ROSMessageCallback } from '../ros/types'
import type { TelemetryBridge } from '../ros/TelemetryBridge'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface UseRosBridgeConfig {
  /** Transport layer to use */
  transport: 'websocket' | 'zenoh'
  url: string
  autoConnect: boolean
  autoReconnect: boolean
  reconnectIntervalMs: number
  maxReconnectAttempts: number
  /** Enable performance monitoring (default: true) */
  enablePerformanceMonitoring: boolean
  /** High latency threshold in ms for alerts (default: 100) */
  highLatencyThresholdMs: number
}

export interface UseRosBridgeReturn {
  state: ConnectionState
  isConnected: boolean
  error: string | null
  bridge: TelemetryBridge | null
  connect: () => Promise<void>
  disconnect: () => void
  subscribe: <T>(
    topic: string,
    type: string,
    callback: ROSMessageCallback<T>,
    throttleRate?: number
  ) => () => void
  /** Performance monitoring data */
  performance: {
    quality: ConnectionQuality | null
    topicStats: TopicStats[]
    alerts: PerformanceAlert[]
  }
  /** Record a message receipt for performance tracking */
  recordMessage: (topic: string, sizeBytes: number, latencyMs?: number) => void
}

type RosTransport = UseRosBridgeConfig['transport']
type RosBridgeInstance = ROSBridge | ZenohBridge

interface BridgeSnapshot {
  transport: RosTransport
  bridge: RosBridgeInstance | null
  telemetry: TelemetryBridge | null
}

function telemetryFacade(bridge: RosBridgeInstance): TelemetryBridge {
  return Object.freeze({
    getState: () => bridge.getState(),
    isConnected: () => bridge.isConnected(),
    subscribe: <T>(
      topic: string,
      type: string,
      callback: ROSMessageCallback<T>,
      throttleRate?: number,
      queueLength?: number
    ) => bridge.subscribe(topic, type, callback, throttleRate, queueLength),
    subscribeToModelStates: (callback: ROSMessageCallback<ModelStates>, throttleRate?: number) =>
      bridge.subscribeToModelStates(callback, throttleRate),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: UseRosBridgeConfig = {
  transport: import.meta.env.DEV ? 'websocket' : 'zenoh',
  url: 'ws://localhost:9090',
  autoConnect: false,
  autoReconnect: true,
  reconnectIntervalMs: 3000,
  maxReconnectAttempts: 10,
  enablePerformanceMonitoring: true,
  highLatencyThresholdMs: 100,
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useRosBridge(config: Partial<UseRosBridgeConfig> = {}): UseRosBridgeReturn {
  // Memoize config values individually to avoid re-creating the bridge on every render.
  // Spreading config into a new object would produce a new reference each render,
  // causing the useEffect below to tear down and reconnect the bridge continuously.
  const transport = config.transport ?? DEFAULT_CONFIG.transport
  const url = config.url ?? DEFAULT_CONFIG.url
  const autoConnect = config.autoConnect ?? DEFAULT_CONFIG.autoConnect
  const autoReconnect = config.autoReconnect ?? DEFAULT_CONFIG.autoReconnect
  const reconnectIntervalMs = config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs
  const maxReconnectAttempts = config.maxReconnectAttempts ?? DEFAULT_CONFIG.maxReconnectAttempts
  const enablePerformanceMonitoring =
    config.enablePerformanceMonitoring ?? DEFAULT_CONFIG.enablePerformanceMonitoring
  const highLatencyThresholdMs =
    config.highLatencyThresholdMs ?? DEFAULT_CONFIG.highLatencyThresholdMs

  const [state, setState] = useState<ConnectionState>('disconnected')
  const [error, setError] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<PerformanceAlert[]>([])
  const [quality, setQuality] = useState<ConnectionQuality | null>(null)
  const [topicStats, setTopicStats] = useState<TopicStats[]>([])

  const requestedTransportRef = useRef<RosTransport>(transport)
  requestedTransportRef.current = transport
  const [bridgeSnapshot, setBridgeSnapshot] = useState<BridgeSnapshot>(() => ({
    transport,
    bridge: null,
    telemetry: null,
  }))
  const bridgeSnapshotRef = useRef<BridgeSnapshot>({ transport, bridge: null, telemetry: null })
  const performanceMonitorRef = useRef<ROSPerformanceMonitor | null>(null)

  const getActiveBridge = useCallback((): RosBridgeInstance | null => {
    const snapshot = bridgeSnapshotRef.current
    return snapshot.transport === requestedTransportRef.current ? snapshot.bridge : null
  }, [])

  // Initialize bridge and performance monitor
  useEffect(() => {
    let bridge: RosBridgeInstance
    let monitor: ROSPerformanceMonitor | null = null
    const ownsBridge = () => {
      const snapshot = bridgeSnapshotRef.current
      return (
        requestedTransportRef.current === transport &&
        snapshot.transport === transport &&
        snapshot.bridge === bridge
      )
    }
    const updateConnectionState = (nextState: ConnectionState) => {
      if (ownsBridge()) setState(nextState)
    }
    const updateError = (nextError: unknown) => {
      if (ownsBridge()) {
        setError(nextError instanceof Error ? nextError.message : String(nextError))
      }
    }

    if (transport === 'zenoh') {
      bridge = new ZenohBridge()
      bridge.onStateChange = updateConnectionState
    } else {
      bridge = new ROSBridge({
        url,
        autoReconnect,
        reconnectIntervalMs,
        maxReconnectAttempts,
        onStateChange: updateConnectionState,
        onError: updateError,
        onConnect: () => {
          if (!ownsBridge()) return
          setError(null)
          // Reset performance monitor on connect
          monitor?.reset()
        },
      })
    }

    const nextSnapshot: BridgeSnapshot = { transport, bridge, telemetry: telemetryFacade(bridge) }
    bridgeSnapshotRef.current = nextSnapshot
    setBridgeSnapshot(nextSnapshot)
    setState(bridge.getState())
    setError(null)

    // Initialize performance monitor if enabled
    let statsInterval: ReturnType<typeof setInterval> | null = null
    if (enablePerformanceMonitoring) {
      monitor = new ROSPerformanceMonitor({
        highLatencyThresholdMs,
      })

      // Subscribe to alerts
      monitor.onAlert((alert) => {
        if (ownsBridge()) {
          setAlerts((prev) => [...prev.slice(-99), alert]) // Keep last 100 alerts
        }
      })

      performanceMonitorRef.current = monitor

      // Update stats periodically
      statsInterval = setInterval(() => {
        if (ownsBridge() && monitor) {
          setQuality(monitor.getConnectionQuality())
          setTopicStats(monitor.getAllTopicStats())
        }
      }, 1000)
    }

    if (autoConnect) {
      bridge.connect().catch(updateError)
    }

    return () => {
      if (statsInterval) clearInterval(statsInterval)
      if (bridgeSnapshotRef.current.bridge === bridge) {
        bridgeSnapshotRef.current = { transport, bridge: null, telemetry: null }
      }
      void bridge.disconnect()
      if (performanceMonitorRef.current === monitor) {
        performanceMonitorRef.current = null
      }
    }
  }, [
    transport,
    url,
    autoConnect,
    autoReconnect,
    reconnectIntervalMs,
    maxReconnectAttempts,
    enablePerformanceMonitoring,
    highLatencyThresholdMs,
  ])

  // Connect function
  const connect = useCallback(async () => {
    const bridge = getActiveBridge()
    if (bridge) {
      setError(null)
      try {
        await bridge.connect()
      } catch (err) {
        if (getActiveBridge() !== bridge) return
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [getActiveBridge])

  // Disconnect function
  const disconnect = useCallback(() => {
    const bridge = getActiveBridge()
    if (bridge) {
      void bridge.disconnect()
    }
  }, [getActiveBridge])

  // Subscribe function
  const subscribe = useCallback(
    <T>(
      topic: string,
      type: string,
      callback: ROSMessageCallback<T>,
      throttleRate?: number
    ): (() => void) => {
      const bridge = getActiveBridge()
      if (bridge) {
        return bridge.subscribe(topic, type, callback, throttleRate)
      }
      return () => {}
    },
    [getActiveBridge]
  )

  // Record message for performance tracking
  const recordMessage = useCallback((topic: string, sizeBytes: number, latencyMs?: number) => {
    performanceMonitorRef.current?.recordMessage(topic, sizeBytes, latencyMs)
  }, [])

  const activeBridge = bridgeSnapshot.transport === transport ? bridgeSnapshot.telemetry : null
  const activeState = activeBridge ? state : 'disconnected'

  return {
    state: activeState,
    isConnected: activeState === 'connected',
    error,
    bridge: activeBridge,
    connect,
    disconnect,
    subscribe,
    performance: {
      quality,
      topicStats,
      alerts,
    },
    recordMessage,
  }
}

export default useRosBridge
