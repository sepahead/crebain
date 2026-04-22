/**
 * CREBAIN ROS Bridge React Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * React hook for managing ROS bridge connection state
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ROSBridge, ConnectionState } from '../ros/ROSBridge'
import { ZenohBridge } from '../ros/ZenohBridge'
import { ROSPerformanceMonitor, type ConnectionQuality, type PerformanceAlert, type TopicStats } from '../ros/ROSPerformanceMonitor'
import type { ROSMessageCallback } from '../ros/types'

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
  bridge: ROSBridge | ZenohBridge | null
  connect: () => Promise<void>
  disconnect: () => void
  subscribe: <T>(
    topic: string,
    type: string,
    callback: ROSMessageCallback<T>,
    throttleRate?: number
  ) => () => void
  publish: <T>(topic: string, msg: T) => void
  callService: <TReq, TRes>(service: string, request: TReq) => Promise<TRes>
  /** Performance monitoring data */
  performance: {
    quality: ConnectionQuality | null
    topicStats: TopicStats[]
    alerts: PerformanceAlert[]
  }
  /** Record a message receipt for performance tracking */
  recordMessage: (topic: string, sizeBytes: number, latencyMs?: number) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: UseRosBridgeConfig = {
  transport: 'websocket',
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

export function useRosBridge(
  config: Partial<UseRosBridgeConfig> = {}
): UseRosBridgeReturn {
  // Memoize config values individually to avoid re-creating the bridge on every render.
  // Spreading config into a new object would produce a new reference each render,
  // causing the useEffect below to tear down and reconnect the bridge continuously.
  const transport = config.transport ?? DEFAULT_CONFIG.transport
  const url = config.url ?? DEFAULT_CONFIG.url
  const autoConnect = config.autoConnect ?? DEFAULT_CONFIG.autoConnect
  const autoReconnect = config.autoReconnect ?? DEFAULT_CONFIG.autoReconnect
  const reconnectIntervalMs = config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs
  const maxReconnectAttempts = config.maxReconnectAttempts ?? DEFAULT_CONFIG.maxReconnectAttempts
  const enablePerformanceMonitoring = config.enablePerformanceMonitoring ?? DEFAULT_CONFIG.enablePerformanceMonitoring
  const highLatencyThresholdMs = config.highLatencyThresholdMs ?? DEFAULT_CONFIG.highLatencyThresholdMs

  const [state, setState] = useState<ConnectionState>('disconnected')
  const [error, setError] = useState<string | null>(null)
  const [alerts, setAlerts] = useState<PerformanceAlert[]>([])
  const [quality, setQuality] = useState<ConnectionQuality | null>(null)
  const [topicStats, setTopicStats] = useState<TopicStats[]>([])
  
  const bridgeRef = useRef<ROSBridge | ZenohBridge | null>(null)
  const performanceMonitorRef = useRef<ROSPerformanceMonitor | null>(null)

  // Initialize bridge and performance monitor
  useEffect(() => {
    let bridge: ROSBridge | ZenohBridge

    if (transport === 'zenoh') {
      bridge = new ZenohBridge()
      bridge.onStateChange = setState
      // Handle auto-connect for Zenoh
      if (autoConnect) {
        bridge.connect().catch((err) => {
          setError(err instanceof Error ? err.message : String(err))
        })
      }
    } else {
      bridge = new ROSBridge({
        url,
        autoReconnect,
        reconnectIntervalMs,
        maxReconnectAttempts,
        onStateChange: setState,
        onError: (err) => setError(err.message),
        onConnect: () => {
          setError(null)
          // Reset performance monitor on connect
          performanceMonitorRef.current?.reset()
        },
      })
      
      if (autoConnect) {
        bridge.connect().catch((err) => {
          setError(err.message)
        })
      }
    }

    bridgeRef.current = bridge

    // Initialize performance monitor if enabled
    let statsInterval: ReturnType<typeof setInterval> | null = null
    if (enablePerformanceMonitoring) {
      const monitor = new ROSPerformanceMonitor({
        highLatencyThresholdMs,
      })
      
      // Subscribe to alerts
      monitor.onAlert((alert) => {
        setAlerts(prev => [...prev.slice(-99), alert]) // Keep last 100 alerts
      })
      
      performanceMonitorRef.current = monitor

      // Update stats periodically
      statsInterval = setInterval(() => {
        if (performanceMonitorRef.current) {
          setQuality(performanceMonitorRef.current.getConnectionQuality())
          setTopicStats(performanceMonitorRef.current.getAllTopicStats())
        }
      }, 1000)
    }

    return () => {
      if (statsInterval) clearInterval(statsInterval)
      bridge.disconnect()
      bridgeRef.current = null
      performanceMonitorRef.current = null
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
    if (bridgeRef.current) {
      setError(null)
      try {
        await bridgeRef.current.connect()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [])

  // Disconnect function
  const disconnect = useCallback(() => {
    if (bridgeRef.current) {
      bridgeRef.current.disconnect()
    }
  }, [])

  // Subscribe function
  const subscribe = useCallback(<T>(
    topic: string,
    type: string,
    callback: ROSMessageCallback<T>,
    throttleRate?: number
  ): (() => void) => {
    if (bridgeRef.current) {
      return bridgeRef.current.subscribe(topic, type, callback, throttleRate)
    }
    return () => {}
  }, [])

  // Publish function
  const publish = useCallback(<T>(topic: string, msg: T) => {
    if (bridgeRef.current) {
      bridgeRef.current.publish(topic, msg)
    }
  }, [])

  // Call service function
  const callService = useCallback(<TReq, TRes>(
    service: string,
    request: TReq
  ): Promise<TRes> => {
    if (bridgeRef.current) {
      return bridgeRef.current.callService(service, request)
    }
    return Promise.reject(new Error('ROS bridge not connected'))
  }, [])

  // Record message for performance tracking
  const recordMessage = useCallback((topic: string, sizeBytes: number, latencyMs?: number) => {
    performanceMonitorRef.current?.recordMessage(topic, sizeBytes, latencyMs)
  }, [])

  return {
    state,
    isConnected: state === 'connected',
    error,
    bridge: bridgeRef.current,
    connect,
    disconnect,
    subscribe,
    publish,
    callService,
    performance: {
      quality,
      topicStats,
      alerts,
    },
    recordMessage,
  }
}

export default useRosBridge
