/**
 * CREBAIN ROS Multi-Sensor Integration Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * Subscribes to ROS sensor topics and feeds measurements to the native fusion backend
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { ROSBridge, type ConnectionState } from './ROSBridge'
import type {
  ThermalDetection,
  ThermalDetectionArray,
  AcousticDetection,
  AcousticDetectionArray,
  RadarDetection,
  RadarDetectionArray,
  LidarDetection,
  LidarDetectionArray,
} from './types'
import {
  type SensorMeasurement,
  type FusedTrack,
  type FusionStats,
  type FilterAlgorithm,
  processMeasurements,
  initFusion,
  getFusionStats,
  setFusionConfig,
  clearTracks,
} from '../detection/AdvancedSensorFusion'
import { fusionLogger as log } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ROSSensorConfig {
  /** ROS bridge WebSocket URL */
  rosUrl: string
  /** Auto-connect on mount */
  autoConnect: boolean
  /** Sensor fusion algorithm */
  algorithm: FilterAlgorithm
  /** Process noise for Kalman filters */
  processNoise: number
  /** Measurement noise for Kalman filters */
  measurementNoise: number
  /** Topic configurations */
  topics: {
    thermal?: string // Default: /crebain/thermal/detections
    acoustic?: string // Default: /crebain/acoustic/detections
    radar?: string // Default: /crebain/radar/detections
    lidar?: string // Default: /crebain/lidar/detections
    visual?: string // Default: /crebain/visual/detections (from YOLO)
  }
  /** Fusion update rate in Hz */
  fusionRateHz: number
}

export type ROSSensorConfigInput = Partial<Omit<ROSSensorConfig, 'topics'>> & {
  topics?: Partial<ROSSensorConfig['topics']>
}

export interface ROSSensorState {
  connectionState: ConnectionState
  connectionError: string | null
  fusionStats: FusionStats | null
  tracks: FusedTrack[]
  sensorStatus: {
    thermal: boolean
    acoustic: boolean
    radar: boolean
    lidar: boolean
    visual: boolean
    radiofrequency: boolean
  }
  lastUpdateMs: number
}

export interface UseROSSensorsReturn extends ROSSensorState {
  connect: () => Promise<void>
  disconnect: () => void
  setAlgorithm: (algorithm: FilterAlgorithm) => Promise<void>
  clearAllTracks: () => Promise<void>
  addVisualDetection: (
    cameraId: string,
    position: [number, number, number],
    confidence: number,
    classLabel: string
  ) => void
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_ROS_SENSOR_CONFIG: ROSSensorConfig = {
  rosUrl: 'ws://localhost:9090',
  autoConnect: false,
  algorithm: 'ExtendedKalman',
  processNoise: 1.0,
  measurementNoise: 2.0,
  topics: {
    thermal: '/crebain/thermal/detections',
    acoustic: '/crebain/acoustic/detections',
    radar: '/crebain/radar/detections',
    lidar: '/crebain/lidar/detections',
    visual: '/crebain/visual/detections',
  },
  fusionRateHz: 10,
}

// Maximum measurements to process per fusion cycle (backpressure guard)
// Prevents memory spikes if a ROS topic floods with data
const MAX_MEASUREMENTS_PER_CYCLE = 10_000

export function clampFusionRateHz(rateHz: number): number {
  if (!Number.isFinite(rateHz)) return DEFAULT_ROS_SENSOR_CONFIG.fusionRateHz
  return Math.min(Math.max(rateHz, 1), 60)
}

export function mergeROSSensorConfig(config: ROSSensorConfigInput = {}): ROSSensorConfig {
  return {
    ...DEFAULT_ROS_SENSOR_CONFIG,
    ...config,
    topics: {
      ...DEFAULT_ROS_SENSOR_CONFIG.topics,
      ...config.topics,
    },
    fusionRateHz: clampFusionRateHz(config.fusionRateHz ?? DEFAULT_ROS_SENSOR_CONFIG.fusionRateHz),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function thermalToMeasurement(det: ThermalDetection, sensorId: string): SensorMeasurement {
  return {
    sensor_id: sensorId,
    modality: 'thermal',
    timestamp_ms: det.header.stamp.secs * 1000 + det.header.stamp.nsecs / 1e6,
    position: [det.position.x, det.position.y, det.position.z],
    covariance: [2, 2, 2], // Thermal has moderate uncertainty
    confidence: det.confidence,
    class_label: det.classification,
    metadata: {
      temperature_k: det.temperature_kelvin,
      signature_area: det.signature_area,
    },
  }
}

export function acousticToMeasurement(det: AcousticDetection, sensorId: string): SensorMeasurement {
  // Convert spherical to Cartesian
  const r = det.range_estimate
  const az = det.azimuth
  const el = det.elevation
  const x = r * Math.cos(el) * Math.cos(az)
  const y = r * Math.cos(el) * Math.sin(az)
  const z = r * Math.sin(el)

  // Estimate velocity from Doppler if available
  let velocity: [number, number, number] | undefined
  if (det.doppler_hz !== 0) {
    // Assume 343 m/s speed of sound, doppler_hz = f_shift
    // v_radial = doppler_hz * c / f_carrier (approximate)
    const vRadial = det.doppler_hz * 0.1 // Simplified
    velocity = [vRadial * Math.cos(az), vRadial * Math.sin(az), 0]
  }

  return {
    sensor_id: sensorId,
    modality: 'acoustic',
    timestamp_ms: det.header.stamp.secs * 1000 + det.header.stamp.nsecs / 1e6,
    position: [x, y, z],
    velocity,
    covariance: [10, 10, 10], // Acoustic has high position uncertainty
    confidence: det.confidence,
    class_label: det.classification,
    metadata: {
      spl_db: det.spl_db,
      frequency_hz: det.dominant_frequency_hz,
      doppler_hz: det.doppler_hz,
      azimuth: det.azimuth,
      elevation: det.elevation,
    },
  }
}

export function radarToMeasurement(det: RadarDetection, sensorId: string): SensorMeasurement {
  // Convert spherical to Cartesian
  const r = det.range
  const az = det.azimuth
  const el = det.elevation
  const x = r * Math.cos(el) * Math.cos(az)
  const y = r * Math.cos(el) * Math.sin(az)
  const z = r * Math.sin(el)

  // Radial velocity to Cartesian (along line of sight)
  const vRadial = det.radial_velocity
  const velocity: [number, number, number] = [
    vRadial * Math.cos(el) * Math.cos(az),
    vRadial * Math.cos(el) * Math.sin(az),
    vRadial * Math.sin(el),
  ]

  return {
    sensor_id: sensorId,
    modality: 'radar',
    timestamp_ms: det.header.stamp.secs * 1000 + det.header.stamp.nsecs / 1e6,
    position: [x, y, z],
    velocity,
    covariance: [0.5, 1, 1], // Radar has good range, moderate angle uncertainty
    confidence: det.confidence,
    class_label: det.classification,
    metadata: {
      rcs_dbsm: det.rcs_dbsm,
      radial_velocity: det.radial_velocity,
    },
  }
}

export function lidarToMeasurement(det: LidarDetection, sensorId: string): SensorMeasurement {
  return {
    sensor_id: sensorId,
    modality: 'lidar',
    timestamp_ms: det.header.stamp.secs * 1000 + det.header.stamp.nsecs / 1e6,
    position: [det.centroid.x, det.centroid.y, det.centroid.z],
    velocity: [det.velocity.x, det.velocity.y, det.velocity.z],
    covariance: [0.1, 0.1, 0.1], // LIDAR has very good position accuracy
    confidence: det.confidence,
    class_label: det.classification,
    metadata: {
      num_points: det.num_points,
      bbox_size_x: det.bbox_max.x - det.bbox_min.x,
      bbox_size_y: det.bbox_max.y - det.bbox_min.y,
      bbox_size_z: det.bbox_max.z - det.bbox_min.z,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════════

export function useROSSensors(
  config: ROSSensorConfigInput = {}
): UseROSSensorsReturn {
  const fullConfig = useMemo(() => mergeROSSensorConfig(config), [config])

  const [state, setState] = useState<ROSSensorState>({
    connectionState: 'disconnected',
    connectionError: null,
    fusionStats: null,
    tracks: [],
    sensorStatus: {
      thermal: false,
      acoustic: false,
      radar: false,
      lidar: false,
      visual: false,
      radiofrequency: false,
    },
    lastUpdateMs: 0,
  })

  const rosBridgeRef = useRef<ROSBridge | null>(null)
  const measurementBufferRef = useRef<SensorMeasurement[]>([])
  const fusionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sensorTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Mark sensor as active (with timeout)
  const markSensorActive = useCallback((modality: keyof ROSSensorState['sensorStatus']) => {
    setState(prev => ({
      ...prev,
      sensorStatus: { ...prev.sensorStatus, [modality]: true },
    }))

    // Clear existing timeout
    const existing = sensorTimeoutsRef.current.get(modality)
    if (existing) clearTimeout(existing)

    // Set timeout to mark as inactive after 2 seconds of no data
    const timeout = setTimeout(() => {
      setState(prev => ({
        ...prev,
        sensorStatus: { ...prev.sensorStatus, [modality]: false },
      }))
    }, 2000)
    sensorTimeoutsRef.current.set(modality, timeout)
  }, [])

  // Process buffered measurements through fusion
  const runFusionCycle = useCallback(async () => {
    let measurements = measurementBufferRef.current
    if (measurements.length === 0) return

    // Backpressure guard: if buffer is overflowing, drop oldest measurements
    // This prevents memory spikes if a ROS topic floods with data
    if (measurements.length > MAX_MEASUREMENTS_PER_CYCLE) {
      log.warn(`Dropping ${measurements.length - MAX_MEASUREMENTS_PER_CYCLE} excess measurements (buffer overflow)`)
      measurements = measurements.slice(-MAX_MEASUREMENTS_PER_CYCLE)
    }

    measurementBufferRef.current = []

    try {
      const tracks = await processMeasurements(measurements)
      const stats = await getFusionStats()

      setState(prev => ({
        ...prev,
        tracks,
        fusionStats: stats,
        lastUpdateMs: Date.now(),
      }))
    } catch (error) {
      log.error('Fusion cycle error', { error })
    }
  }, [])

  // Initialize fusion engine
  useEffect(() => {
    initFusion({
      algorithm: fullConfig.algorithm,
      process_noise: fullConfig.processNoise,
      measurement_noise: fullConfig.measurementNoise,
    }).catch(err => log.error('Fusion init failed', { error: err }))
  }, [fullConfig.algorithm, fullConfig.processNoise, fullConfig.measurementNoise])

  // Set up fusion interval
  useEffect(() => {
    const intervalMs = 1000 / fullConfig.fusionRateHz
    fusionIntervalRef.current = setInterval(runFusionCycle, intervalMs)

    return () => {
      if (fusionIntervalRef.current) {
        clearInterval(fusionIntervalRef.current)
      }
    }
  }, [fullConfig.fusionRateHz, runFusionCycle])

  // Connect to ROS bridge
  const connect = useCallback(async () => {
    if (rosBridgeRef.current) {
      rosBridgeRef.current.disconnect()
    }

    const bridge = new ROSBridge({
      url: fullConfig.rosUrl,
      autoReconnect: true,
      onStateChange: (newState) => {
        setState(prev => ({ ...prev, connectionState: newState }))
      },
      onError: (error) => {
        setState(prev => ({ ...prev, connectionError: error.message }))
      },
    })

    rosBridgeRef.current = bridge

    try {
      await bridge.connect()

      // Subscribe to thermal detections
      if (fullConfig.topics.thermal) {
        bridge.subscribe<ThermalDetectionArray>(
          fullConfig.topics.thermal,
          'crebain_msgs/ThermalDetectionArray',
          (msg) => {
            markSensorActive('thermal')
            const measurements = msg.detections.map((det, i) =>
              thermalToMeasurement(det, `thermal_${i}`)
            )
            measurementBufferRef.current.push(...measurements)
          }
        )
      }

      // Subscribe to acoustic detections
      if (fullConfig.topics.acoustic) {
        bridge.subscribe<AcousticDetectionArray>(
          fullConfig.topics.acoustic,
          'crebain_msgs/AcousticDetectionArray',
          (msg) => {
            markSensorActive('acoustic')
            const measurements = msg.detections.map((det, i) =>
              acousticToMeasurement(det, `acoustic_${i}`)
            )
            measurementBufferRef.current.push(...measurements)
          }
        )
      }

      // Subscribe to radar detections
      if (fullConfig.topics.radar) {
        bridge.subscribe<RadarDetectionArray>(
          fullConfig.topics.radar,
          'crebain_msgs/RadarDetectionArray',
          (msg) => {
            markSensorActive('radar')
            const measurements = msg.detections.map((det, i) =>
              radarToMeasurement(det, `radar_${i}`)
            )
            measurementBufferRef.current.push(...measurements)
          }
        )
      }

      // Subscribe to LIDAR detections
      if (fullConfig.topics.lidar) {
        bridge.subscribe<LidarDetectionArray>(
          fullConfig.topics.lidar,
          'crebain_msgs/LidarDetectionArray',
          (msg) => {
            markSensorActive('lidar')
            const measurements = msg.detections.map((det, i) =>
              lidarToMeasurement(det, `lidar_${i}`)
            )
            measurementBufferRef.current.push(...measurements)
          }
        )
      }

      setState(prev => ({ ...prev, connectionError: null }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState(prev => ({ ...prev, connectionError: message }))
      throw error
    }
  }, [fullConfig.rosUrl, fullConfig.topics, markSensorActive])

  // Disconnect from ROS bridge
  const disconnect = useCallback(() => {
    if (rosBridgeRef.current) {
      rosBridgeRef.current.disconnect()
      rosBridgeRef.current = null
    }
    setState(prev => ({
      ...prev,
      connectionState: 'disconnected',
      sensorStatus: {
        thermal: false,
        acoustic: false,
        radar: false,
        lidar: false,
        visual: false,
        radiofrequency: false,
      },
    }))
  }, [])

  // Set fusion algorithm
  const setAlgorithm = useCallback(async (algorithm: FilterAlgorithm) => {
    await setFusionConfig({
      algorithm,
      process_noise: fullConfig.processNoise,
      measurement_noise: fullConfig.measurementNoise,
      association_threshold: 10.0,
      max_missed_detections: 5,
      min_confirmation_hits: 3,
      particle_count: 100,
    })
  }, [fullConfig.processNoise, fullConfig.measurementNoise])

  // Clear all tracks
  const clearAllTracks = useCallback(async () => {
    await clearTracks()
    setState(prev => ({ ...prev, tracks: [], fusionStats: null }))
  }, [])

  // Add visual detection from CoreML/YOLO
  const addVisualDetection = useCallback((
    cameraId: string,
    position: [number, number, number],
    confidence: number,
    classLabel: string
  ) => {
    markSensorActive('visual')
    measurementBufferRef.current.push({
      sensor_id: cameraId,
      modality: 'visual',
      timestamp_ms: Date.now(),
      position,
      covariance: [1, 1, 1],
      confidence,
      class_label: classLabel,
      metadata: {},
    })
  }, [markSensorActive])

  // Auto-connect - connect/disconnect are stable useCallback refs
  useEffect(() => {
    if (fullConfig.autoConnect) {
      connect().catch(err => log.error('Auto-connect failed', { error: err }))
    }

    return () => {
      disconnect()
    }
  }, [fullConfig.autoConnect, connect, disconnect])

  // Cleanup
  useEffect(() => {
    return () => {
      // Clear all sensor timeouts
      for (const timeout of sensorTimeoutsRef.current.values()) {
        clearTimeout(timeout)
      }
      sensorTimeoutsRef.current.clear()
    }
  }, [])

  return {
    ...state,
    connect,
    disconnect,
    setAlgorithm,
    clearAllTracks,
    addVisualDetection,
  }
}

export default useROSSensors
