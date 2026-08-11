/**
 * CREBAIN Advanced Sensor Fusion Frontend
 * Adaptive Response & Awareness System (ARAS)
 *
 * TypeScript interface to the native Rust sensor fusion backend
 * Supports: Kalman, EKF, UKF, Particle Filter, IMM
 */

import { invoke } from '@tauri-apps/api/core'
import { TAURI_COMMANDS } from '../lib/tauriCommands'
import { assertNativeBackendAllowed } from '../integrations/engramHost'

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** Sensor modality types */
export type SensorModality =
  'visual' | 'thermal' | 'acoustic' | 'radar' | 'lidar' | 'radiofrequency'

/** Filter algorithm selection */
export type FilterAlgorithm = 'Kalman' | 'ExtendedKalman' | 'UnscentedKalman' | 'Particle' | 'IMM'

/** Track state labels */
export type TrackStateLabel = 'Tentative' | 'Confirmed' | 'Coasting' | 'Lost'

/** Raw sensor measurement from any modality */
export interface SensorMeasurement {
  sensor_id: string
  modality: SensorModality
  timestamp_ms: number
  /**
   * Coordinate frame declared by the sensor ingress header. Legacy/browser
   * measurements may omit it, but omitted provenance cannot support a
   * producer-attested cross-modal consistency projection.
   */
  source_frame_id?: string
  /**
   * Target position in the sensor measurement frame, selected by `modality`:
   * - `radar` → polar `[range_m, azimuth_rad, elevation_rad]`
   * - `visual` / `thermal` / `acoustic` / `lidar` → Cartesian `[x, y, z]` meters
   */
  position: [number, number, number]
  /** Velocity seed if available, always Cartesian `[vx, vy, vz]` in m/s */
  velocity?: [number, number, number]
  /**
   * Measurement noise (diagonal of R), in the SAME frame as `position`:
   * `[m², m², m²]` for Cartesian modalities, `[m², rad², rad²]` for radar.
   */
  covariance: [number, number, number]
  /** Detection confidence [0, 1] */
  confidence: number
  /** Classification label */
  class_label: string
  /** Additional sensor-specific data */
  metadata: Record<string, number>
}

/** Fused track output from backend */
export interface FusedTrack {
  id: string
  position: [number, number, number]
  velocity: [number, number, number]
  position_uncertainty: [number, number, number]
  velocity_uncertainty: [number, number, number]
  class_label: string
  confidence: number
  sensor_sources: SensorModality[]
  last_update_ms: number
  age: number
  state: TrackStateLabel
  threat_level: number
}

/** Fusion engine configuration */
export interface FusionConfig {
  algorithm: FilterAlgorithm
  process_noise: number
  measurement_noise: number
  association_threshold: number
  max_missed_detections: number
  min_confirmation_hits: number
  /**
   * Sliding-window width N for M-of-N confirmation. Optional: the Rust backend
   * fills it via #[serde(default)] (= 5) when omitted, so existing callers that
   * build a full FusionConfig without it remain valid.
   */
  confirmation_window?: number
  /**
   * Position-covariance determinant ceiling (m^6) for divergence deletion.
   * Optional: backend default is 1e6 when omitted.
   */
  max_position_cov_volume?: number
  particle_count: number
}

/** Fusion statistics */
export interface FusionStats {
  total_tracks: number
  confirmed_tracks: number
  tentative_tracks: number
  coasting_tracks: number
  multi_sensor_tracks: number
  algorithm: FilterAlgorithm
  frame_count: number
}

/** Algorithm info */
export interface AlgorithmInfo {
  id: FilterAlgorithm
  name: string
  description: string
}

/** Modality info */
export interface ModalityInfo {
  id: SensorModality
  name: string
  icon: string
}

const FILTER_ALGORITHMS = new Set<FilterAlgorithm>([
  'Kalman',
  'ExtendedKalman',
  'UnscentedKalman',
  'Particle',
  'IMM',
])
const SENSOR_MODALITIES = new Set<SensorModality>([
  'visual',
  'thermal',
  'acoustic',
  'radar',
  'lidar',
  'radiofrequency',
])
const TRACK_STATES = new Set<TrackStateLabel>(['Tentative', 'Confirmed', 'Coasting', 'Lost'])
const MAX_FUSION_TRACKS = 1_024
const MAX_FUSION_MEASUREMENTS = 512
const MAX_TRACK_AGE = 0xffff_ffff
const MAX_FUSION_STRING_BYTES = 256
const MAX_FUSION_METADATA_ENTRIES = 64
const MAX_FUSION_NOISE = 10_000
const MAX_ASSOCIATION_THRESHOLD = 100_000
const MAX_MISSED_DETECTIONS = 1_000
const MAX_CONFIRMATION_HITS = 1_000
const MAX_CONFIRMATION_WINDOW = 32
const MAX_FUSION_PARTICLE_COUNT = 1_000
const MAX_MEASUREMENT_POSITION_ABS_M = 10_000_000
const MAX_MEASUREMENT_VELOCITY_ABS_MPS = 100_000
const MAX_MEASUREMENT_VARIANCE = 1_000_000_000_000
const MAX_MEASUREMENT_METADATA_ABS = 1_000_000_000_000
const MAX_RADAR_AZIMUTH_RAD = 2 * Math.PI
const MAX_RADAR_ELEVATION_RAD = Math.PI / 2
const FUSION_TEXT_ENCODER = new TextEncoder()
const FUSION_CONTROL_CHARACTER = /\p{Cc}/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function requestNumberInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid fusion request: ${field} must be finite and within [${minimum}, ${maximum}]`
    )
  }
  return value
}

function requestIntegerInRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(
      `Invalid fusion request: ${field} must be an integer within [${minimum}, ${maximum}]`
    )
  }
  return value as number
}

function boundedRequestString(value: unknown, field: string, frameId = false): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    FUSION_CONTROL_CHARACTER.test(value) ||
    FUSION_TEXT_ENCODER.encode(value).byteLength > MAX_FUSION_STRING_BYTES ||
    (frameId && Array.from(value).some((character) => /\s/u.test(character)))
  ) {
    throw new Error(
      `Invalid fusion request: ${field} must be a bounded non-empty string${frameId ? ' without whitespace or controls' : ''}`
    )
  }
  return value
}

function requestTuple3(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`Invalid fusion request: ${field} must be a 3-element array`)
  }
  return [
    requestNumberInRange(value[0], `${field}[0]`, -Number.MAX_VALUE, Number.MAX_VALUE),
    requestNumberInRange(value[1], `${field}[1]`, -Number.MAX_VALUE, Number.MAX_VALUE),
    requestNumberInRange(value[2], `${field}[2]`, -Number.MAX_VALUE, Number.MAX_VALUE),
  ]
}

function normalizeFusionConfigRequest(config: unknown): FusionConfig {
  if (
    !isRecord(config) ||
    !hasOnlyKeys(config, [
      'algorithm',
      'process_noise',
      'measurement_noise',
      'association_threshold',
      'max_missed_detections',
      'min_confirmation_hits',
      'confirmation_window',
      'max_position_cov_volume',
      'particle_count',
    ])
  ) {
    throw new Error('Invalid fusion request: config must match the public configuration schema')
  }
  const algorithm = config.algorithm ?? 'ExtendedKalman'
  if (!FILTER_ALGORITHMS.has(algorithm as FilterAlgorithm)) {
    throw new Error('Invalid fusion request: algorithm must be a known filter')
  }
  const processNoise = requestNumberInRange(
    config.process_noise ?? 1,
    'process_noise',
    Number.EPSILON,
    MAX_FUSION_NOISE
  )
  const measurementNoise = requestNumberInRange(
    config.measurement_noise ?? 2,
    'measurement_noise',
    Number.EPSILON,
    MAX_FUSION_NOISE
  )
  const associationThreshold = requestNumberInRange(
    config.association_threshold ?? 11.345,
    'association_threshold',
    Number.EPSILON,
    MAX_ASSOCIATION_THRESHOLD
  )
  const maxMissedDetections = requestIntegerInRange(
    config.max_missed_detections ?? 5,
    'max_missed_detections',
    1,
    MAX_MISSED_DETECTIONS
  )
  const minConfirmationHits = requestIntegerInRange(
    config.min_confirmation_hits ?? 3,
    'min_confirmation_hits',
    1,
    MAX_CONFIRMATION_HITS
  )
  const confirmationWindow = requestIntegerInRange(
    config.confirmation_window ?? 5,
    'confirmation_window',
    1,
    MAX_CONFIRMATION_WINDOW
  )
  if (minConfirmationHits > confirmationWindow) {
    throw new Error(
      'Invalid fusion request: min_confirmation_hits must not exceed confirmation_window'
    )
  }
  if (maxMissedDetections > confirmationWindow) {
    throw new Error(
      'Invalid fusion request: max_missed_detections must not exceed confirmation_window'
    )
  }
  const maxPositionCovVolume = requestNumberInRange(
    config.max_position_cov_volume ?? 1e6,
    'max_position_cov_volume',
    Number.EPSILON,
    Number.MAX_VALUE
  )
  const particleCount = requestIntegerInRange(
    config.particle_count ?? 100,
    'particle_count',
    1,
    MAX_FUSION_PARTICLE_COUNT
  )
  return {
    algorithm: algorithm as FilterAlgorithm,
    process_noise: processNoise,
    measurement_noise: measurementNoise,
    association_threshold: associationThreshold,
    max_missed_detections: maxMissedDetections,
    min_confirmation_hits: minConfirmationHits,
    confirmation_window: confirmationWindow,
    max_position_cov_volume: maxPositionCovVolume,
    particle_count: particleCount,
  }
}

function normalizeMeasurementRequest(value: unknown, index: number): SensorMeasurement {
  const field = `measurements[${index}]`
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'sensor_id',
      'modality',
      'timestamp_ms',
      'source_frame_id',
      'position',
      'velocity',
      'covariance',
      'confidence',
      'class_label',
      'metadata',
    ]) ||
    !SENSOR_MODALITIES.has(value.modality as SensorModality)
  ) {
    throw new Error(`Invalid fusion request: ${field} must match the measurement schema`)
  }

  const modality = value.modality as SensorModality
  const position = requestTuple3(value.position, `${field}.position`)
  if (modality === 'radar') {
    requestNumberInRange(position[0], `${field}.position[0]`, 0, MAX_MEASUREMENT_POSITION_ABS_M)
    requestNumberInRange(
      position[1],
      `${field}.position[1]`,
      -MAX_RADAR_AZIMUTH_RAD,
      MAX_RADAR_AZIMUTH_RAD
    )
    requestNumberInRange(
      position[2],
      `${field}.position[2]`,
      -MAX_RADAR_ELEVATION_RAD,
      MAX_RADAR_ELEVATION_RAD
    )
  } else {
    position.forEach((entry, axis) =>
      requestNumberInRange(
        entry,
        `${field}.position[${axis}]`,
        -MAX_MEASUREMENT_POSITION_ABS_M,
        MAX_MEASUREMENT_POSITION_ABS_M
      )
    )
  }

  const velocity =
    value.velocity === undefined ? undefined : requestTuple3(value.velocity, `${field}.velocity`)
  velocity?.forEach((entry, axis) =>
    requestNumberInRange(
      entry,
      `${field}.velocity[${axis}]`,
      -MAX_MEASUREMENT_VELOCITY_ABS_MPS,
      MAX_MEASUREMENT_VELOCITY_ABS_MPS
    )
  )
  const covariance = requestTuple3(value.covariance, `${field}.covariance`)
  covariance.forEach((entry, axis) =>
    requestNumberInRange(
      entry,
      `${field}.covariance[${axis}]`,
      Number.MIN_VALUE,
      MAX_MEASUREMENT_VARIANCE
    )
  )
  if (
    !isRecord(value.metadata) ||
    Object.keys(value.metadata).length > MAX_FUSION_METADATA_ENTRIES
  ) {
    throw new Error(`Invalid fusion request: ${field}.metadata exceeds its entry limit`)
  }
  const metadata: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value.metadata)) {
    const normalizedKey = boundedRequestString(key, `${field}.metadata key`)
    Object.defineProperty(metadata, normalizedKey, {
      configurable: true,
      enumerable: true,
      value: requestNumberInRange(
        entry,
        `${field}.metadata.${normalizedKey}`,
        -MAX_MEASUREMENT_METADATA_ABS,
        MAX_MEASUREMENT_METADATA_ABS
      ),
      writable: true,
    })
  }

  return {
    sensor_id: boundedRequestString(value.sensor_id, `${field}.sensor_id`),
    modality,
    timestamp_ms: requestTimestamp(value.timestamp_ms, `${field}.timestamp_ms`),
    ...(value.source_frame_id === undefined
      ? {}
      : {
          source_frame_id: boundedRequestString(
            value.source_frame_id,
            `${field}.source_frame_id`,
            true
          ),
        }),
    position,
    ...(velocity ? { velocity } : {}),
    covariance,
    confidence: requestNumberInRange(value.confidence, `${field}.confidence`, 0, 1),
    class_label: boundedRequestString(value.class_label, `${field}.class_label`),
    metadata,
  }
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid fusion response: ${field} must be a finite number`)
  }
  return value
}

function numberInRange(value: unknown, field: string, min: number, max: number): number {
  const number = finiteNumber(value, field)
  if (number < min || number > max) {
    throw new Error(`Invalid fusion response: ${field} must be between ${min} and ${max}`)
  }
  return number
}

function integerInRange(value: unknown, field: string, min: number, max: number): number {
  const number = finiteNumber(value, field)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(
      `Invalid fusion response: ${field} must be a safe integer between ${min} and ${max}`
    )
  }
  return number
}

function requestTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid fusion request: ${field} must be a non-negative safe integer`)
  }
  return value as number
}

function stringField(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    FUSION_CONTROL_CHARACTER.test(value) ||
    FUSION_TEXT_ENCODER.encode(value).byteLength > MAX_FUSION_STRING_BYTES
  ) {
    throw new Error(`Invalid fusion response: ${field} must be a string`)
  }
  return value
}

function tuple3(value: unknown, field: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`Invalid fusion response: ${field} must be a 3-element array`)
  }
  return [
    finiteNumber(value[0], `${field}[0]`),
    finiteNumber(value[1], `${field}[1]`),
    finiteNumber(value[2], `${field}[2]`),
  ]
}

function nonnegativeTuple3(value: unknown, field: string): [number, number, number] {
  const tuple = tuple3(value, field)
  if (tuple.some((entry) => entry < 0)) {
    throw new Error(`Invalid fusion response: ${field} entries must be non-negative`)
  }
  return tuple
}

function normalizeTrack(value: unknown, index: number): FusedTrack {
  const field = `tracks[${index}]`
  if (!isRecord(value)) {
    throw new Error(`Invalid fusion response: ${field} must be an object`)
  }
  const sensorSources: unknown[] | null = Array.isArray(value.sensor_sources)
    ? value.sensor_sources
    : null
  if (
    sensorSources === null ||
    sensorSources.length === 0 ||
    sensorSources.length > SENSOR_MODALITIES.size ||
    new Set(sensorSources).size !== sensorSources.length ||
    !sensorSources.every(
      (source): source is SensorModality =>
        typeof source === 'string' && SENSOR_MODALITIES.has(source as SensorModality)
    )
  ) {
    throw new Error(
      `Invalid fusion response: ${field}.sensor_sources must contain known modalities`
    )
  }
  if (!TRACK_STATES.has(value.state as TrackStateLabel)) {
    throw new Error(`Invalid fusion response: ${field}.state must be a known track state`)
  }

  return {
    id: stringField(value.id, `${field}.id`),
    position: tuple3(value.position, `${field}.position`),
    velocity: tuple3(value.velocity, `${field}.velocity`),
    position_uncertainty: nonnegativeTuple3(
      value.position_uncertainty,
      `${field}.position_uncertainty`
    ),
    velocity_uncertainty: nonnegativeTuple3(
      value.velocity_uncertainty,
      `${field}.velocity_uncertainty`
    ),
    class_label: stringField(value.class_label, `${field}.class_label`),
    confidence: numberInRange(value.confidence, `${field}.confidence`, 0, 1),
    sensor_sources: [...sensorSources],
    last_update_ms: integerInRange(
      value.last_update_ms,
      `${field}.last_update_ms`,
      0,
      Number.MAX_SAFE_INTEGER
    ),
    age: integerInRange(value.age, `${field}.age`, 0, MAX_TRACK_AGE),
    state: value.state as TrackStateLabel,
    threat_level: integerInRange(value.threat_level, `${field}.threat_level`, 1, 4),
  }
}

function normalizeTracks(value: unknown): FusedTrack[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid fusion response: tracks must be an array')
  }
  if (value.length > MAX_FUSION_TRACKS) {
    throw new Error(
      `Invalid fusion response: tracks must contain at most ${MAX_FUSION_TRACKS} entries`
    )
  }
  const tracks = value.map(normalizeTrack)
  if (new Set(tracks.map((track) => track.id)).size !== tracks.length) {
    throw new Error('Invalid fusion response: track IDs must be unique')
  }
  return tracks
}

function normalizeAlgorithms(value: unknown): AlgorithmInfo[] {
  if (!Array.isArray(value) || value.length > FILTER_ALGORITHMS.size) {
    throw new Error('Invalid fusion response: algorithms must be a bounded array')
  }
  const algorithms = value.map((entry, index): AlgorithmInfo => {
    if (!isRecord(entry) || !FILTER_ALGORITHMS.has(entry.id as FilterAlgorithm)) {
      throw new Error(`Invalid fusion response: algorithms[${index}] is malformed`)
    }
    return {
      id: entry.id as FilterAlgorithm,
      name: stringField(entry.name, `algorithms[${index}].name`),
      description: stringField(entry.description, `algorithms[${index}].description`),
    }
  })
  if (new Set(algorithms.map((algorithm) => algorithm.id)).size !== algorithms.length) {
    throw new Error('Invalid fusion response: algorithm IDs must be unique')
  }
  return algorithms
}

function normalizeModalities(value: unknown): ModalityInfo[] {
  if (!Array.isArray(value) || value.length > SENSOR_MODALITIES.size) {
    throw new Error('Invalid fusion response: modalities must be a bounded array')
  }
  const modalities = value.map((entry, index): ModalityInfo => {
    if (!isRecord(entry) || !SENSOR_MODALITIES.has(entry.id as SensorModality)) {
      throw new Error(`Invalid fusion response: modalities[${index}] is malformed`)
    }
    return {
      id: entry.id as SensorModality,
      name: stringField(entry.name, `modalities[${index}].name`),
      icon: stringField(entry.icon, `modalities[${index}].icon`),
    }
  })
  if (new Set(modalities.map((modality) => modality.id)).size !== modalities.length) {
    throw new Error('Invalid fusion response: modality IDs must be unique')
  }
  return modalities
}

function normalizeFusionStats(value: unknown): FusionStats {
  if (!isRecord(value)) {
    throw new Error('Invalid fusion response: stats must be an object')
  }
  if (!FILTER_ALGORITHMS.has(value.algorithm as FilterAlgorithm)) {
    throw new Error('Invalid fusion response: stats.algorithm must be a known algorithm')
  }

  const totalTracks = integerInRange(value.total_tracks, 'stats.total_tracks', 0, MAX_FUSION_TRACKS)
  const confirmedTracks = integerInRange(
    value.confirmed_tracks,
    'stats.confirmed_tracks',
    0,
    totalTracks
  )
  const tentativeTracks = integerInRange(
    value.tentative_tracks,
    'stats.tentative_tracks',
    0,
    totalTracks
  )
  const coastingTracks = integerInRange(
    value.coasting_tracks,
    'stats.coasting_tracks',
    0,
    totalTracks
  )
  const multiSensorTracks = integerInRange(
    value.multi_sensor_tracks,
    'stats.multi_sensor_tracks',
    0,
    totalTracks
  )
  if (confirmedTracks + tentativeTracks + coastingTracks > totalTracks) {
    throw new Error(
      'Invalid fusion response: stats state counts must not exceed stats.total_tracks'
    )
  }

  return {
    total_tracks: totalTracks,
    confirmed_tracks: confirmedTracks,
    tentative_tracks: tentativeTracks,
    coasting_tracks: coastingTracks,
    multi_sensor_tracks: multiSensorTracks,
    algorithm: value.algorithm as FilterAlgorithm,
    frame_count: integerInRange(value.frame_count, 'stats.frame_count', 0, Number.MAX_SAFE_INTEGER),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the sensor fusion engine
 */
export async function initFusion(config?: Partial<FusionConfig>): Promise<void> {
  assertNativeBackendAllowed()
  const fullConfig = config === undefined ? undefined : normalizeFusionConfigRequest(config)

  await invoke(TAURI_COMMANDS.fusion.init, { config: fullConfig })
}

/**
 * Process sensor measurements and get fused tracks
 */
export async function processMeasurements(
  measurements: SensorMeasurement[],
  timestampMs?: number,
  upstreamDroppedMeasurements = 0
): Promise<FusedTrack[]> {
  assertNativeBackendAllowed()
  if (!Array.isArray(measurements)) {
    throw new Error('Invalid fusion request: measurements must be an array')
  }
  if (measurements.length === 0 && timestampMs === undefined) {
    throw new Error(
      'Invalid fusion request: timestampMs is required when processing an empty measurement frame'
    )
  }
  if (measurements.length > MAX_FUSION_MEASUREMENTS) {
    throw new Error(
      `Invalid fusion request: measurements must contain at most ${MAX_FUSION_MEASUREMENTS} entries`
    )
  }

  const normalizedMeasurements = measurements.map(normalizeMeasurementRequest)

  const requestedTimestamp =
    timestampMs === undefined ? undefined : requestTimestamp(timestampMs, 'timestampMs')
  let measurementTimestamp: number | undefined
  for (let index = 0; index < normalizedMeasurements.length; index += 1) {
    const candidate = requestTimestamp(
      normalizedMeasurements[index].timestamp_ms,
      `measurements[${index}].timestamp_ms`
    )
    measurementTimestamp ??= candidate
    if (candidate !== measurementTimestamp) {
      throw new Error(
        'Invalid fusion request: all measurements in one frame must have the same timestamp_ms'
      )
    }
  }
  if (
    requestedTimestamp !== undefined &&
    measurementTimestamp !== undefined &&
    requestedTimestamp !== measurementTimestamp
  ) {
    throw new Error('Invalid fusion request: timestampMs must equal every measurement timestamp_ms')
  }
  const ts = requestedTimestamp ?? measurementTimestamp!
  const droppedMeasurements = requestTimestamp(
    upstreamDroppedMeasurements,
    'upstreamDroppedMeasurements'
  )
  const response = await invoke<unknown>(TAURI_COMMANDS.fusion.process, {
    measurements: normalizedMeasurements,
    timestampMs: ts,
    upstreamDroppedMeasurements: droppedMeasurements,
  })
  return normalizeTracks(response)
}

/**
 * Get current tracks without processing new measurements
 */
export async function getTracks(): Promise<FusedTrack[]> {
  assertNativeBackendAllowed()
  const response = await invoke<unknown>(TAURI_COMMANDS.fusion.getTracks)
  return normalizeTracks(response)
}

/**
 * Get fusion statistics
 */
export async function getFusionStats(): Promise<FusionStats> {
  assertNativeBackendAllowed()
  const response = await invoke<unknown>(TAURI_COMMANDS.fusion.getStats)
  return normalizeFusionStats(response)
}

/**
 * Update fusion configuration
 */
export async function setFusionConfig(config: FusionConfig): Promise<void> {
  assertNativeBackendAllowed()
  await invoke(TAURI_COMMANDS.fusion.setConfig, {
    config: normalizeFusionConfigRequest(config),
  })
}

/**
 * Clear all tracks
 */
export async function clearTracks(): Promise<void> {
  assertNativeBackendAllowed()
  await invoke(TAURI_COMMANDS.fusion.clear)
}

/**
 * Get available filter algorithms
 */
export async function getAlgorithms(): Promise<AlgorithmInfo[]> {
  assertNativeBackendAllowed()
  return normalizeAlgorithms(await invoke<unknown>(TAURI_COMMANDS.fusion.getAlgorithms))
}

/**
 * Get available sensor modalities
 */
export async function getModalities(): Promise<ModalityInfo[]> {
  assertNativeBackendAllowed()
  return normalizeModalities(await invoke<unknown>(TAURI_COMMANDS.fusion.getModalities))
}

/**
 * Get threat color based on level
 */
export function getThreatColor(level: number): string {
  switch (level) {
    case 1:
      return '#3a6b4a' // Green - low
    case 2:
      return '#6a8a4a' // Yellow-green - moderate
    case 3:
      return '#a08040' // Amber - elevated
    case 4:
      return '#8b4a4a' // Red - critical
    default:
      return '#606060' // Gray - unknown
  }
}

/**
 * Get track state color
 */
export function getTrackStateColor(state: TrackStateLabel): string {
  switch (state) {
    case 'Confirmed':
      return '#3a6b4a'
    case 'Tentative':
      return '#a08040'
    case 'Coasting':
      return '#6a6a6a'
    case 'Lost':
      return '#4a4a4a'
    default:
      return '#606060'
  }
}

/**
 * Format algorithm name for display
 */
export function formatAlgorithmName(algorithm: FilterAlgorithm): string {
  switch (algorithm) {
    case 'Kalman':
      return 'KF'
    case 'ExtendedKalman':
      return 'EKF'
    case 'UnscentedKalman':
      return 'UKF'
    case 'Particle':
      return 'PF'
    case 'IMM':
      return 'IMM'
    default:
      return algorithm
  }
}

/**
 * Format sensor modality for display
 */
export function formatModality(modality: SensorModality): string {
  const modalityMap: Record<SensorModality, string> = {
    visual: 'VIS',
    thermal: 'IR',
    acoustic: 'ACO',
    radar: 'RAD',
    lidar: 'LID',
    radiofrequency: 'RF',
  }
  return modalityMap[modality] ?? modality.slice(0, 3).toUpperCase()
}
