/**
 * CREBAIN ROS Multi-Sensor Integration Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * Subscribes to ROS sensor topics and feeds measurements to the native fusion backend
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { isTauri } from '@tauri-apps/api/core'
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

/**
 * A ROS connection whose lifecycle is owned outside this hook.
 *
 * Passing this object opts out of the hook's legacy, internally owned
 * WebSocket. The sensor hook may add and remove only its own subscriptions; it
 * never connects or disconnects the supplied bridge.
 */
export interface ExternalROSSensorConnection {
  bridge: Pick<ROSBridge, 'subscribe'> | null
  connectionState: ConnectionState
  connectionError?: string | null
  /** Explain why the external transport cannot carry custom sensor topics. */
  unsupportedReason?: string | null
}

export type ROSSensorConfigInput = Partial<Omit<ROSSensorConfig, 'topics'>> & {
  topics?: Partial<ROSSensorConfig['topics']>
  externalConnection?: ExternalROSSensorConnection
}

export interface ROSSensorState {
  connectionState: ConnectionState
  connectionError: string | null
  /** Whether the native Tauri sensor-fusion backend can be used. */
  fusionAvailable: boolean
  /** Native fusion availability or initialization error, if any. */
  fusionError: string | null
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

export const ROS_SENSOR_WEBSOCKET_REQUIRED =
  'Custom ROS sensor fusion topics require the WebSocket transport. Switch the ROS transport to WebSocket to enable them.'

export const NATIVE_FUSION_BACKEND_REQUIRED =
  'Native sensor fusion is unavailable in browser mode. Open CREBAIN in the desktop app to enable fused tracks.'

const INACTIVE_SENSOR_STATUS: ROSSensorState['sensorStatus'] = {
  thermal: false,
  acoustic: false,
  radar: false,
  lidar: false,
  visual: false,
  radiofrequency: false,
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

function assertPoint(
  point: unknown,
  name: string
): asserts point is { x: number; y: number; z: number } {
  assertRecord(point, name)
  const record = point
  assertFiniteNumber(record.x, `${name}.x`)
  assertFiniteNumber(record.y, `${name}.y`)
  assertFiniteNumber(record.z, `${name}.z`)
}

function assertTimestamp(
  header: unknown,
  name: string
): asserts header is { stamp: { secs: number; nsecs: number } } {
  assertRecord(header, name)
  const stamp = header.stamp
  assertRecord(stamp, `${name}.stamp`)
  const record = stamp
  const secs = record.secs
  const nsecs = record.nsecs
  if (typeof secs !== 'number' || !Number.isSafeInteger(secs) || secs < 0) {
    throw new Error(`${name}.stamp.secs must be a safe non-negative integer`)
  }
  if (
    typeof nsecs !== 'number' ||
    !Number.isSafeInteger(nsecs) ||
    nsecs < 0 ||
    nsecs >= 1_000_000_000
  ) {
    throw new Error(`${name}.stamp.nsecs must be a safe integer within [0, 1000000000)`)
  }
}

function timestampMs(header: { stamp: { secs: number; nsecs: number } }): number {
  // Round to an integer: SensorMeasurement.timestamp_ms is a Rust u64, and
  // serde_json rejects a fractional number for u64 — a sub-millisecond
  // nanosecond remainder (the common case for real ROS stamps) would otherwise
  // fail deserialization of the ENTIRE fusion batch at the Tauri boundary.
  return Math.round(header.stamp.secs * 1000 + header.stamp.nsecs / 1e6)
}

function assertVector3Tuple(
  value: unknown,
  name: string
): asserts value is [number, number, number] {
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
  const startIndex = Math.max(0, detections.length - MAX_MEASUREMENTS_PER_CYCLE)
  if (startIndex > 0) {
    log.warn('Dropping oldest ROS sensor detections before validation', {
      modality,
      dropped: startIndex,
    })
  }
  detections.slice(startIndex).forEach((det, relativeIndex) => {
    const index = startIndex + relativeIndex
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

  const r = det.range
  const az = det.azimuth
  const el = det.elevation

  // Radar is the one polar modality: keep position as [range, azimuth, elevation]
  // so the Rust EKF consumes it through its polar measurement model and Jacobian.
  // The fusion core converts to a Cartesian world position internally. (Sending
  // pre-converted Cartesian here would be re-interpreted as polar and corrupted.)
  const position: [number, number, number] = [r, az, el]

  // Seed the track velocity in Cartesian m/s by projecting the scalar radial
  // velocity onto the line of sight — the fusion core stores velocity Cartesian.
  const vRadial = det.radial_velocity
  const velocity: [number, number, number] = [
    vRadial * Math.cos(el) * Math.cos(az),
    vRadial * Math.cos(el) * Math.sin(az),
    vRadial * Math.sin(el),
  ]

  // Measurement noise R in POLAR units to match `position`:
  // [range_m², azimuth_rad², elevation_rad²]. Radar resolves range well but
  // angle coarsely; ~0.7 m range 1σ, ~1° azimuth, ~1.5° elevation.
  const AZIMUTH_SIGMA_RAD = (1.0 * Math.PI) / 180
  const ELEVATION_SIGMA_RAD = (1.5 * Math.PI) / 180
  const covariance: [number, number, number] = [
    0.5,
    AZIMUTH_SIGMA_RAD * AZIMUTH_SIGMA_RAD,
    ELEVATION_SIGMA_RAD * ELEVATION_SIGMA_RAD,
  ]

  return {
    sensor_id: sensorId,
    modality: 'radar',
    timestamp_ms: timestampMs(det.header),
    position,
    velocity,
    covariance,
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

export function useROSSensors(config: ROSSensorConfigInput = {}): UseROSSensorsReturn {
  const rosUrl = config.rosUrl ?? DEFAULT_ROS_SENSOR_CONFIG.rosUrl
  const autoConnect = config.autoConnect ?? DEFAULT_ROS_SENSOR_CONFIG.autoConnect
  const algorithm = config.algorithm ?? DEFAULT_ROS_SENSOR_CONFIG.algorithm
  const processNoise = config.processNoise ?? DEFAULT_ROS_SENSOR_CONFIG.processNoise
  const measurementNoise = config.measurementNoise ?? DEFAULT_ROS_SENSOR_CONFIG.measurementNoise
  const fusionRateHz = config.fusionRateHz ?? DEFAULT_ROS_SENSOR_CONFIG.fusionRateHz
  const thermalTopic = config.topics?.thermal ?? DEFAULT_ROS_SENSOR_CONFIG.topics.thermal
  const acousticTopic = config.topics?.acoustic ?? DEFAULT_ROS_SENSOR_CONFIG.topics.acoustic
  const radarTopic = config.topics?.radar ?? DEFAULT_ROS_SENSOR_CONFIG.topics.radar
  const lidarTopic = config.topics?.lidar ?? DEFAULT_ROS_SENSOR_CONFIG.topics.lidar
  const visualTopic = config.topics?.visual ?? DEFAULT_ROS_SENSOR_CONFIG.topics.visual
  const usesExternalConnection = config.externalConnection !== undefined
  const externalBridge = config.externalConnection?.bridge ?? null
  const externalConnectionState = config.externalConnection?.connectionState ?? 'disconnected'
  const externalConnectionError = config.externalConnection?.connectionError ?? null
  const externalUnsupportedReason = config.externalConnection?.unsupportedReason ?? null
  const [fusionBackendAvailable] = useState(() => {
    try {
      return isTauri()
    } catch (error) {
      log.warn('Failed to detect the Tauri runtime; disabling native sensor fusion', { error })
      return false
    }
  })

  const fullConfig = useMemo(
    () =>
      mergeROSSensorConfig({
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
      }),
    [
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
    ]
  )

  const [state, setState] = useState<ROSSensorState>({
    connectionState: 'disconnected',
    connectionError: null,
    fusionAvailable: fusionBackendAvailable,
    fusionError: fusionBackendAvailable ? null : NATIVE_FUSION_BACKEND_REQUIRED,
    fusionStats: null,
    tracks: [],
    sensorStatus: { ...INACTIVE_SENSOR_STATUS },
    lastUpdateMs: 0,
  })

  const ownedBridgeRef = useRef<ROSBridge | null>(null)
  const subscriptionCleanupsRef = useRef<Array<() => void>>([])
  const measurementBufferRef = useRef<SensorMeasurement[]>([])
  const fusionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fusionReadyRef = useRef(false)
  const fusionCycleRunningRef = useRef(false)
  const fusionCycleRequestedRef = useRef(false)
  const fusionCycleGenerationRef = useRef(0)
  const fusionCycleCompletionRef = useRef<Promise<void>>(Promise.resolve())
  const fusionMaintenanceRef = useRef<Promise<void>>(Promise.resolve())
  const fusionMaintenanceCountRef = useRef(0)
  const fusionInitGenerationRef = useRef(0)
  const hasActiveTracksRef = useRef(false)
  const previousExternalBridgeRef = useRef<ExternalROSSensorConnection['bridge']>(null)
  const externalWasConnectedRef = useRef(false)
  const sensorTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Mark sensor as active (with timeout)
  const markSensorActive = useCallback((modality: keyof ROSSensorState['sensorStatus']) => {
    setState((prev) => ({
      ...prev,
      sensorStatus: { ...prev.sensorStatus, [modality]: true },
    }))

    // Clear existing timeout
    const existing = sensorTimeoutsRef.current.get(modality)
    if (existing) clearTimeout(existing)

    // Set timeout to mark as inactive after 2 seconds of no data
    const timeout = setTimeout(() => {
      setState((prev) => ({
        ...prev,
        sensorStatus: { ...prev.sensorStatus, [modality]: false },
      }))
    }, 2000)
    sensorTimeoutsRef.current.set(modality, timeout)
  }, [])

  const removeSensorSubscriptions = useCallback(() => {
    const cleanups = subscriptionCleanupsRef.current.splice(0)
    for (const unsubscribe of cleanups) {
      try {
        unsubscribe()
      } catch (error) {
        log.warn('Failed to remove ROS sensor subscription', { error })
      }
    }
  }, [])

  const resetSensorActivity = useCallback(() => {
    // Results from a cycle started before this reset no longer describe the
    // active sensor session and must not repopulate React state.
    fusionCycleGenerationRef.current += 1
    for (const timeout of sensorTimeoutsRef.current.values()) {
      clearTimeout(timeout)
    }
    sensorTimeoutsRef.current.clear()
    measurementBufferRef.current = []
    fusionCycleRequestedRef.current = false
    hasActiveTracksRef.current = false
    setState((prev) => ({
      ...prev,
      sensorStatus: { ...INACTIVE_SENSOR_STATUS },
      tracks: [],
      fusionStats: null,
      lastUpdateMs: 0,
    }))
  }, [])

  /**
   * Serialize fusion maintenance behind the active processing cycle. Besides
   * keeping React state honest via the generation check, this ordering ensures
   * an old native process command cannot finish after a clear/init command and
   * repopulate the backend with measurements from the previous session.
   */
  const queueFusionMaintenance = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      if (!fusionBackendAvailable) {
        return Promise.reject(new Error(NATIVE_FUSION_BACKEND_REQUIRED))
      }

      const previousMaintenance = fusionMaintenanceRef.current
      const activeCycle = fusionCycleCompletionRef.current
      fusionMaintenanceCountRef.current += 1

      const task = previousMaintenance
        .then(() => activeCycle)
        .then(operation)
        .finally(() => {
          fusionMaintenanceCountRef.current -= 1
        })

      // Keep the queue usable after a failed maintenance command while still
      // returning the original rejection to the caller.
      fusionMaintenanceRef.current = task.then(
        () => undefined,
        () => undefined
      )
      return task
    },
    [fusionBackendAvailable]
  )

  const appendMeasurements = useCallback((measurements: SensorMeasurement[]) => {
    if (!fusionBackendAvailable || measurements.length === 0) return

    const current = measurementBufferRef.current
    const total = current.length + measurements.length
    if (total <= MAX_MEASUREMENTS_PER_CYCLE) {
      current.push(...measurements)
      return
    }

    const dropped = total - MAX_MEASUREMENTS_PER_CYCLE
    log.warn('Dropping oldest buffered ROS measurements', { dropped })
    if (measurements.length >= MAX_MEASUREMENTS_PER_CYCLE) {
      measurementBufferRef.current = measurements.slice(-MAX_MEASUREMENTS_PER_CYCLE)
      return
    }

    measurementBufferRef.current = current.slice(dropped).concat(measurements)
  }, [fusionBackendAvailable])

  const installSensorSubscriptions = useCallback(
    (bridge: NonNullable<ExternalROSSensorConnection['bridge']>) => {
      removeSensorSubscriptions()
      const cleanups: Array<() => void> = []

      try {
        if (fullConfig.topics.thermal) {
          cleanups.push(
            bridge.subscribe<ThermalDetectionArray>(
              fullConfig.topics.thermal,
              'crebain_msgs/ThermalDetectionArray',
              (msg) => {
                markSensorActive('thermal')
                const measurements = pushValidatedMeasurements(
                  msg?.detections,
                  'thermal',
                  thermalToMeasurement
                )
                appendMeasurements(measurements)
              }
            )
          )
        }

        if (fullConfig.topics.acoustic) {
          cleanups.push(
            bridge.subscribe<AcousticDetectionArray>(
              fullConfig.topics.acoustic,
              'crebain_msgs/AcousticDetectionArray',
              (msg) => {
                markSensorActive('acoustic')
                const measurements = pushValidatedMeasurements(
                  msg?.detections,
                  'acoustic',
                  acousticToMeasurement
                )
                appendMeasurements(measurements)
              }
            )
          )
        }

        if (fullConfig.topics.radar) {
          cleanups.push(
            bridge.subscribe<RadarDetectionArray>(
              fullConfig.topics.radar,
              'crebain_msgs/RadarDetectionArray',
              (msg) => {
                markSensorActive('radar')
                const measurements = pushValidatedMeasurements(
                  msg?.detections,
                  'radar',
                  radarToMeasurement
                )
                appendMeasurements(measurements)
              }
            )
          )
        }

        if (fullConfig.topics.lidar) {
          cleanups.push(
            bridge.subscribe<LidarDetectionArray>(
              fullConfig.topics.lidar,
              'crebain_msgs/LidarDetectionArray',
              (msg) => {
                markSensorActive('lidar')
                const measurements = pushValidatedMeasurements(
                  msg?.detections,
                  'lidar',
                  lidarToMeasurement
                )
                appendMeasurements(measurements)
              }
            )
          )
        }
      } catch (error) {
        for (const unsubscribe of cleanups) {
          unsubscribe()
        }
        throw error
      }

      subscriptionCleanupsRef.current = cleanups
    },
    [appendMeasurements, fullConfig.topics, markSensorActive, removeSensorSubscriptions]
  )

  // Process buffered measurements through fusion. The native backend is
  // serialized here as well as internally: an interval tick during a slow
  // cycle requests one follow-up pass instead of launching overlapping IPC.
  const runFusionCycle = useCallback(async () => {
    if (!fusionBackendAvailable || !fusionReadyRef.current) return
    if (fusionMaintenanceCountRef.current > 0) {
      fusionCycleRequestedRef.current = true
      return
    }
    if (fusionCycleRunningRef.current) {
      fusionCycleRequestedRef.current = true
      return
    }

    fusionCycleRunningRef.current = true
    const generation = fusionCycleGenerationRef.current

    const cycle = (async () => {
      try {
        do {
          fusionCycleRequestedRef.current = false
          if (!fusionReadyRef.current || generation !== fusionCycleGenerationRef.current) break

          const measurements = measurementBufferRef.current
          if (measurements.length === 0 && !hasActiveTracksRef.current) break
          measurementBufferRef.current = []

          try {
            const tracks = await processMeasurements(measurements)
            if (!fusionReadyRef.current || generation !== fusionCycleGenerationRef.current) break

            hasActiveTracksRef.current = tracks.length > 0
            let stats: FusionStats | null | undefined
            try {
              stats = await getFusionStats()
            } catch (error) {
              log.error('Failed to read fusion statistics', { error })
            }

            if (generation === fusionCycleGenerationRef.current && fusionReadyRef.current) {
              setState((prev) => ({
                ...prev,
                tracks,
                fusionStats: stats === undefined ? prev.fusionStats : stats,
                lastUpdateMs: Date.now(),
              }))
            }
          } catch (error) {
            log.error('Fusion cycle error', { error })
          }
        } while (fusionCycleRequestedRef.current)
      } finally {
        fusionCycleRunningRef.current = false
      }
    })()

    fusionCycleCompletionRef.current = cycle
    try {
      await cycle
    } finally {
      if (fusionCycleCompletionRef.current === cycle) {
        fusionCycleCompletionRef.current = Promise.resolve()
      }
    }
  }, [fusionBackendAvailable])

  // Initialize fusion engine
  useEffect(() => {
    const generation = ++fusionInitGenerationRef.current
    fusionCycleGenerationRef.current += 1
    let cancelled = false
    fusionReadyRef.current = false
    hasActiveTracksRef.current = false
    setState((prev) => ({
      ...prev,
      fusionAvailable: fusionBackendAvailable,
      fusionError: fusionBackendAvailable ? null : NATIVE_FUSION_BACKEND_REQUIRED,
      tracks: [],
      fusionStats: null,
      lastUpdateMs: 0,
    }))

    if (!fusionBackendAvailable) {
      return () => {
        cancelled = true
        fusionReadyRef.current = false
      }
    }

    void queueFusionMaintenance(() =>
      initFusion({
        algorithm: fullConfig.algorithm,
        process_noise: fullConfig.processNoise,
        measurement_noise: fullConfig.measurementNoise,
      })
    )
      .then(() => {
        if (!cancelled && generation === fusionInitGenerationRef.current) {
          fusionReadyRef.current = true
          setState((prev) => ({ ...prev, fusionError: null }))
        }
      })
      .catch((error) => {
        if (!cancelled && generation === fusionInitGenerationRef.current) {
          log.error('Fusion init failed', { error })
          const message = error instanceof Error ? error.message : String(error)
          setState((prev) => ({
            ...prev,
            fusionError: `Native sensor fusion failed to initialize: ${message}`,
          }))
        }
      })

    return () => {
      cancelled = true
      fusionReadyRef.current = false
    }
  }, [
    fullConfig.algorithm,
    fullConfig.processNoise,
    fullConfig.measurementNoise,
    fusionBackendAvailable,
    queueFusionMaintenance,
  ])

  // Set up fusion interval
  useEffect(() => {
    if (!fusionBackendAvailable) return

    const intervalMs = 1000 / fullConfig.fusionRateHz
    fusionIntervalRef.current = setInterval(() => void runFusionCycle(), intervalMs)

    return () => {
      if (fusionIntervalRef.current) {
        clearInterval(fusionIntervalRef.current)
      }
    }
  }, [fullConfig.fusionRateHz, fusionBackendAvailable, runFusionCycle])

  const disconnectOwnedBridge = useCallback(() => {
    removeSensorSubscriptions()
    resetSensorActivity()
    if (ownedBridgeRef.current) {
      ownedBridgeRef.current.disconnect()
      ownedBridgeRef.current = null
    }
    if (fusionBackendAvailable) {
      void queueFusionMaintenance(clearTracks).catch((error) =>
        log.error('Failed to clear fusion tracks', { error })
      )
    }
    setState((prev) => ({
      ...prev,
      connectionState: 'disconnected',
    }))
  }, [
    fusionBackendAvailable,
    queueFusionMaintenance,
    removeSensorSubscriptions,
    resetSensorActivity,
  ])

  // Connect the legacy internally owned bridge, or attach subscriptions to an
  // already-connected external bridge without taking ownership of it.
  const connect = useCallback(async () => {
    if (usesExternalConnection) {
      if (externalUnsupportedReason) {
        throw new Error(externalUnsupportedReason)
      }
      if (!externalBridge || externalConnectionState !== 'connected') {
        throw new Error('The externally managed ROS bridge is not connected')
      }

      installSensorSubscriptions(externalBridge)
      setState((prev) => ({
        ...prev,
        connectionState: externalConnectionState,
        connectionError: externalConnectionError,
      }))
      return
    }

    disconnectOwnedBridge()
    const bridge = new ROSBridge({
      url: fullConfig.rosUrl,
      autoReconnect: true,
      onStateChange: (newState) => {
        setState((prev) => ({ ...prev, connectionState: newState }))
      },
      onError: (error) => {
        setState((prev) => ({ ...prev, connectionError: error.message }))
      },
    })

    ownedBridgeRef.current = bridge

    try {
      await bridge.connect()
      installSensorSubscriptions(bridge)
      setState((prev) => ({ ...prev, connectionError: null }))
    } catch (error) {
      removeSensorSubscriptions()
      bridge.disconnect()
      if (ownedBridgeRef.current === bridge) {
        ownedBridgeRef.current = null
      }
      const message = error instanceof Error ? error.message : String(error)
      setState((prev) => ({
        ...prev,
        connectionState: 'disconnected',
        connectionError: message,
      }))
      throw error
    }
  }, [
    disconnectOwnedBridge,
    externalBridge,
    externalConnectionError,
    externalConnectionState,
    externalUnsupportedReason,
    fullConfig.rosUrl,
    installSensorSubscriptions,
    removeSensorSubscriptions,
    usesExternalConnection,
  ])

  // Detach this hook's subscriptions in external mode; only an internally
  // owned bridge is actually disconnected.
  const disconnect = useCallback(() => {
    if (usesExternalConnection) {
      removeSensorSubscriptions()
      resetSensorActivity()
      if (fusionBackendAvailable) {
        void queueFusionMaintenance(clearTracks).catch((error) =>
          log.error('Failed to clear fusion tracks', { error })
        )
      }
      return
    }
    disconnectOwnedBridge()
  }, [
    disconnectOwnedBridge,
    fusionBackendAvailable,
    queueFusionMaintenance,
    removeSensorSubscriptions,
    resetSensorActivity,
    usesExternalConnection,
  ])

  // Set fusion algorithm
  const setAlgorithm = useCallback(
    async (algorithm: FilterAlgorithm) => {
      if (!fusionBackendAvailable) {
        setState((prev) => ({ ...prev, fusionError: NATIVE_FUSION_BACKEND_REQUIRED }))
        throw new Error(NATIVE_FUSION_BACKEND_REQUIRED)
      }

      fusionCycleGenerationRef.current += 1
      fusionCycleRequestedRef.current = false
      try {
        await queueFusionMaintenance(() =>
          setFusionConfig({
            algorithm,
            process_noise: fullConfig.processNoise,
            measurement_noise: fullConfig.measurementNoise,
            association_threshold: 11.345,
            max_missed_detections: 5,
            min_confirmation_hits: 3,
            particle_count: 100,
          })
        )
        setState((prev) => ({ ...prev, fusionError: null }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setState((prev) => ({ ...prev, fusionError: message }))
        throw error
      }
    },
    [
      fullConfig.processNoise,
      fullConfig.measurementNoise,
      fusionBackendAvailable,
      queueFusionMaintenance,
    ]
  )

  // Clear all tracks
  const clearAllTracks = useCallback(async () => {
    fusionCycleGenerationRef.current += 1
    measurementBufferRef.current = []
    fusionCycleRequestedRef.current = false
    if (fusionBackendAvailable) {
      await queueFusionMaintenance(clearTracks)
    }
    hasActiveTracksRef.current = false
    setState((prev) => ({ ...prev, tracks: [], fusionStats: null }))
  }, [fusionBackendAvailable, queueFusionMaintenance])

  // Add visual detection from CoreML/YOLO
  const addVisualDetection = useCallback(
    (
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
      appendMeasurements([{
        sensor_id: cameraId,
        modality: 'visual',
        timestamp_ms: Date.now(),
        position,
        covariance: [1, 1, 1],
        confidence,
        class_label: classLabel,
        metadata: {},
      }])
    },
    [appendMeasurements, markSensorActive]
  )

  // Follow an externally owned connection. Subscription cleanup is scoped to
  // this hook, and no lifecycle method is ever called on the supplied bridge.
  useEffect(() => {
    if (!usesExternalConnection) return

    const externalIsConnected =
      !externalUnsupportedReason && externalConnectionState === 'connected' && !!externalBridge
    const bridgeChanged =
      previousExternalBridgeRef.current !== null &&
      previousExternalBridgeRef.current !== externalBridge
    if (
      fusionBackendAvailable &&
      ((externalWasConnectedRef.current && !externalIsConnected) || bridgeChanged)
    ) {
      void queueFusionMaintenance(clearTracks).catch((error) =>
        log.error('Failed to clear tracks after ROS connection change', { error })
      )
    }
    previousExternalBridgeRef.current = externalBridge
    externalWasConnectedRef.current = externalIsConnected

    removeSensorSubscriptions()
    resetSensorActivity()

    const connectionError = externalUnsupportedReason ?? externalConnectionError
    setState((prev) => ({
      ...prev,
      connectionState: externalUnsupportedReason ? 'disconnected' : externalConnectionState,
      connectionError,
    }))

    if (externalUnsupportedReason || externalConnectionState !== 'connected' || !externalBridge) {
      return
    }

    try {
      installSensorSubscriptions(externalBridge)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState((prev) => ({ ...prev, connectionError: message }))
    }

    return removeSensorSubscriptions
  }, [
    externalBridge,
    externalConnectionError,
    externalConnectionState,
    externalUnsupportedReason,
    fusionBackendAvailable,
    installSensorSubscriptions,
    queueFusionMaintenance,
    removeSensorSubscriptions,
    resetSensorActivity,
    usesExternalConnection,
  ])

  // Preserve standalone compatibility: without an external connection, this
  // hook still owns and may auto-connect its own ROSBridge.
  useEffect(() => {
    if (usesExternalConnection) return

    if (fullConfig.autoConnect) {
      connect().catch((err) => log.error('Auto-connect failed', { error: err }))
    }

    return disconnectOwnedBridge
  }, [connect, disconnectOwnedBridge, fullConfig.autoConnect, usesExternalConnection])

  // Cleanup
  useEffect(() => {
    const sensorTimeouts = sensorTimeoutsRef.current
    return () => {
      // Clear all sensor timeouts
      for (const timeout of sensorTimeouts.values()) {
        clearTimeout(timeout)
      }
      sensorTimeouts.clear()
      fusionReadyRef.current = false
      fusionCycleGenerationRef.current += 1
      fusionCycleRequestedRef.current = false
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
