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

function assertFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be finite`)
  }
}

function assertNonNegativeFinite(value: unknown, name: string): asserts value is number {
  assertFiniteNumber(value, name)
  if (value < 0) {
    throw new Error(`${name} must be non-negative`)
  }
}

function assertConfidence(value: unknown, name: string): asserts value is number {
  assertFiniteNumber(value, name)
  if (value < 0 || value > 1) {
    throw new Error(`${name} must be within [0, 1]`)
  }
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${name} must be an object`)
  }
}

function assertPoint(point: unknown, name: string): asserts point is { x: number; y: number; z: number } {
  assertRecord(point, name)
  const record = point
  assertFiniteNumber(record.x, `${name}.x`)
  assertFiniteNumber(record.y, `${name}.y`)
  assertFiniteNumber(record.z, `${name}.z`)
}

function assertTimestamp(header: unknown, name: string): asserts header is { stamp: { secs: number; nsecs: number } } {
  assertRecord(header, name)
  const stamp = (header).stamp
  assertRecord(stamp, `${name}.stamp`)
  const record = stamp
  const secs = record.secs
  const nsecs = record.nsecs
  if (typeof secs !== 'number' || !Number.isSafeInteger(secs) || secs < 0) {
    throw new Error(`${name}.stamp.secs must be a safe non-negative integer`)
  }
  if (typeof nsecs !== 'number' || !Number.isSafeInteger(nsecs) || nsecs < 0 || nsecs >= 1_000_000_000) {
    throw new Error(`${name}.stamp.nsecs must be a safe integer within [0, 1000000000)`)
  }
}

function timestampMs(header: { stamp: { secs: number; nsecs: number } }): number {
  return header.stamp.secs * 1000 + header.stamp.nsecs / 1e6
}

function assertVector3Tuple(value: unknown, name: string): asserts value is [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${name} must contain exactly 3 values`)
  }
  value.forEach((coordinate, index) => assertFiniteNumber(coordinate, `${name}[${index}]`))
}

function pushValidatedMeasurements<T>(
  detections: unknown,
  modality: keyof ROSSensorState['sensorStatus'],
  convert: (det: T, sensorId: string) => SensorMeasurement
): SensorMeasurement[] {
  if (!Array.isArray(detections)) {
    log.warn('Dropping malformed ROS sensor detection array', { modality })
    return []
  }

  const measurements: SensorMeasurement[] = []
  detections.forEach((det, index) => {
    try {
      measurements.push(convert(det as T, `${modality}_${index}`))
    } catch (error) {
      log.warn('Dropping malformed ROS sensor detection', { modality, index, error })
    }
  })
  return measurements
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function thermalToMeasurement(det: ThermalDetection, sensorId: string): SensorMeasurement {
  assertString(sensorId, 'sensorId')
  assertRecord(det, 'thermal')
  assertTimestamp(det.header, 'thermal.header')
  assertPoint(det.position, 'thermal.position')
  assertNonNegativeFinite(det.temperature_kelvin, 'thermal.temperature_kelvin')
  assertNonNegativeFinite(det.signature_area, 'thermal.signature_area')
  assertConfidence(det.confidence, 'thermal.confidence')
  assertString(det.classification, 'thermal.classification')

  return {
    sensor_id: sensorId,
    modality: 'thermal',
    timestamp_ms: timestampMs(det.header),
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
  assertString(sensorId, 'sensorId')
  assertRecord(det, 'acoustic')
  assertTimestamp(det.header, 'acoustic.header')
  assertFiniteNumber(det.azimuth, 'acoustic.azimuth')
  assertFiniteNumber(det.elevation, 'acoustic.elevation')
  assertNonNegativeFinite(det.range_estimate, 'acoustic.range_estimate')
  assertNonNegativeFinite(det.spl_db, 'acoustic.spl_db')
  assertNonNegativeFinite(det.dominant_frequency_hz, 'acoustic.dominant_frequency_hz')
  assertFiniteNumber(det.doppler_hz, 'acoustic.doppler_hz')
  assertConfidence(det.confidence, 'acoustic.confidence')
  assertString(det.classification, 'acoustic.classification')

  // Convert spherical to Cartesian
  const r = det.range_estimate
  const az = det.azimuth
  const el = det.elevation
  const x = r * Math.cos(el) * Math.cos(az)
  const y = r * Math.cos(el) * Math.sin(az)
  const z = r * Math.sin(el)

  // Estimate radial velocity from the Doppler shift, but only when the carrier
  // frequency is known: v_radial = doppler_hz * c / f_carrier (c = speed of
  // sound). Without a valid carrier we leave velocity undefined rather than feed
  // a fabricated value into the fusion filter.
  const SPEED_OF_SOUND_MS = 343
  let velocity: [number, number, number] | undefined
  if (det.doppler_hz !== 0 && det.dominant_frequency_hz > 0) {
    const vRadial = (det.doppler_hz * SPEED_OF_SOUND_MS) / det.dominant_frequency_hz
    // Project along the full line-of-sight direction (including elevation).
    velocity = [
      vRadial * Math.cos(el) * Math.cos(az),
      vRadial * Math.cos(el) * Math.sin(az),
      vRadial * Math.sin(el),
    ]
  }

  return {
    sensor_id: sensorId,
    modality: 'acoustic',
    timestamp_ms: timestampMs(det.header),
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
  assertString(sensorId, 'sensorId')
  assertRecord(det, 'radar')
  assertTimestamp(det.header, 'radar.header')
  assertNonNegativeFinite(det.range, 'radar.range')
  assertFiniteNumber(det.azimuth, 'radar.azimuth')
  assertFiniteNumber(det.elevation, 'radar.elevation')
  assertFiniteNumber(det.radial_velocity, 'radar.radial_velocity')
  assertFiniteNumber(det.rcs_dbsm, 'radar.rcs_dbsm')
  assertConfidence(det.confidence, 'radar.confidence')
  assertString(det.classification, 'radar.classification')

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
    timestamp_ms: timestampMs(det.header),
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
  assertString(sensorId, 'sensorId')
  assertRecord(det, 'lidar')
  assertTimestamp(det.header, 'lidar.header')
  assertPoint(det.centroid, 'lidar.centroid')
  assertPoint(det.bbox_min, 'lidar.bbox_min')
  assertPoint(det.bbox_max, 'lidar.bbox_max')
  assertPoint(det.velocity, 'lidar.velocity')
  assertNonNegativeFinite(det.num_points, 'lidar.num_points')
  if (!Number.isSafeInteger(det.num_points)) {
    throw new Error('lidar.num_points must be a safe integer')
  }
  assertConfidence(det.confidence, 'lidar.confidence')
  assertString(det.classification, 'lidar.classification')

  const bboxSizeX = det.bbox_max.x - det.bbox_min.x
  const bboxSizeY = det.bbox_max.y - det.bbox_min.y
  const bboxSizeZ = det.bbox_max.z - det.bbox_min.z
  assertNonNegativeFinite(bboxSizeX, 'lidar.bbox_size_x')
  assertNonNegativeFinite(bboxSizeY, 'lidar.bbox_size_y')
  assertNonNegativeFinite(bboxSizeZ, 'lidar.bbox_size_z')

  return {
    sensor_id: sensorId,
    modality: 'lidar',
    timestamp_ms: timestampMs(det.header),
    position: [det.centroid.x, det.centroid.y, det.centroid.z],
    velocity: [det.velocity.x, det.velocity.y, det.velocity.z],
    covariance: [0.1, 0.1, 0.1], // LIDAR has very good position accuracy
    confidence: det.confidence,
    class_label: det.classification,
    metadata: {
      num_points: det.num_points,
      bbox_size_x: bboxSizeX,
      bbox_size_y: bboxSizeY,
      bbox_size_z: bboxSizeZ,
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════════

export function useROSSensors(
  config: ROSSensorConfigInput = {}
): UseROSSensorsReturn {
  const rosUrl = config.rosUrl ?? DEFAULT_ROS_SENSOR_CONFIG.rosUrl
  const autoConnect = config.autoConnect ?? DEFAULT_ROS_SENSOR_CONFIG.autoConnect
  const algorithm = config.algorithm ?? DEFAULT_ROS_SENSOR_CONFIG.algorithm
  const processNoise = config.processNoise ?? DEFAULT_ROS_SENSOR_CONFIG.processNoise
  const measurementNoise = config.measurementNoise ?? DEFAULT_ROS_SENSOR_CONFIG.measurementNoise
  const fusionRateHz = config.fusionRateHz ?? DEFAULT_ROS_SENSOR_CONFIG.fusionRateHz
  const thermalTopic = config.topics?.thermal
  const acousticTopic = config.topics?.acoustic
  const radarTopic = config.topics?.radar
  const lidarTopic = config.topics?.lidar
  const visualTopic = config.topics?.visual

  const fullConfig = useMemo(() => mergeROSSensorConfig({
    rosUrl,
    autoConnect,
    algorithm,
    processNoise,
    measurementNoise,
    fusionRateHz,
    topics: {
      thermal: thermalTopic,
      acoustic: acousticTopic,
      radar: radarTopic,
      lidar: lidarTopic,
      visual: visualTopic,
    },
  }), [
    rosUrl,
    autoConnect,
    algorithm,
    processNoise,
    measurementNoise,
    fusionRateHz,
    thermalTopic,
    acousticTopic,
    radarTopic,
    lidarTopic,
    visualTopic,
  ])

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
    fusionIntervalRef.current = setInterval(() => void runFusionCycle(), intervalMs)

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
            const measurements = pushValidatedMeasurements(msg?.detections, 'thermal', thermalToMeasurement)
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
            const measurements = pushValidatedMeasurements(msg?.detections, 'acoustic', acousticToMeasurement)
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
            const measurements = pushValidatedMeasurements(msg?.detections, 'radar', radarToMeasurement)
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
            const measurements = pushValidatedMeasurements(msg?.detections, 'lidar', lidarToMeasurement)
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
    assertString(cameraId, 'cameraId')
    assertVector3Tuple(position, 'visual.position')
    assertConfidence(confidence, 'visual.confidence')
    assertString(classLabel, 'visual.classLabel')
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
    const sensorTimeouts = sensorTimeoutsRef.current
    return () => {
      // Clear all sensor timeouts
      for (const timeout of sensorTimeouts.values()) {
        clearTimeout(timeout)
      }
      sensorTimeouts.clear()
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
