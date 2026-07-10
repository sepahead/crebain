/**
 * CREBAIN Advanced Sensor Fusion Frontend
 * Adaptive Response & Awareness System (ARAS)
 *
 * TypeScript interface to the native Rust sensor fusion backend
 * Supports: Kalman, EKF, UKF, Particle Filter, IMM
 */

import { invoke } from '@tauri-apps/api/core'
import { TAURI_COMMANDS } from '../lib/tauriCommands'

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

/** Thermal-specific measurement */
export interface ThermalMeasurement extends SensorMeasurement {
  modality: 'thermal'
  /** Temperature in Kelvin */
  temperature_k: number
  /** Thermal signature area in m² */
  signature_area: number
  /** Emissivity estimate */
  emissivity: number
}

/** Acoustic-specific measurement */
export interface AcousticMeasurement extends SensorMeasurement {
  modality: 'acoustic'
  /** Sound pressure level in dB */
  spl_db: number
  /** Dominant frequency in Hz */
  frequency_hz: number
  /** Direction of arrival [azimuth, elevation] in radians */
  doa: [number, number]
  /** Doppler shift in Hz */
  doppler_hz?: number
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid fusion response: ${field} must be a finite number`)
  }
  return value
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string') {
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

function normalizeTrack(value: unknown, index: number): FusedTrack {
  const field = `tracks[${index}]`
  if (!isRecord(value)) {
    throw new Error(`Invalid fusion response: ${field} must be an object`)
  }
  if (
    !Array.isArray(value.sensor_sources) ||
    !value.sensor_sources.every((source) => SENSOR_MODALITIES.has(source as SensorModality))
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
    position_uncertainty: tuple3(value.position_uncertainty, `${field}.position_uncertainty`),
    velocity_uncertainty: tuple3(value.velocity_uncertainty, `${field}.velocity_uncertainty`),
    class_label: stringField(value.class_label, `${field}.class_label`),
    confidence: finiteNumber(value.confidence, `${field}.confidence`),
    sensor_sources: value.sensor_sources as SensorModality[],
    last_update_ms: finiteNumber(value.last_update_ms, `${field}.last_update_ms`),
    age: finiteNumber(value.age, `${field}.age`),
    state: value.state as TrackStateLabel,
    threat_level: finiteNumber(value.threat_level, `${field}.threat_level`),
  }
}

function normalizeTracks(value: unknown): FusedTrack[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid fusion response: tracks must be an array')
  }
  return value.map(normalizeTrack)
}

function normalizeFusionStats(value: unknown): FusionStats {
  if (!isRecord(value)) {
    throw new Error('Invalid fusion response: stats must be an object')
  }
  if (!FILTER_ALGORITHMS.has(value.algorithm as FilterAlgorithm)) {
    throw new Error('Invalid fusion response: stats.algorithm must be a known algorithm')
  }

  return {
    total_tracks: finiteNumber(value.total_tracks, 'stats.total_tracks'),
    confirmed_tracks: finiteNumber(value.confirmed_tracks, 'stats.confirmed_tracks'),
    tentative_tracks: finiteNumber(value.tentative_tracks, 'stats.tentative_tracks'),
    coasting_tracks: finiteNumber(value.coasting_tracks, 'stats.coasting_tracks'),
    multi_sensor_tracks: finiteNumber(value.multi_sensor_tracks, 'stats.multi_sensor_tracks'),
    algorithm: value.algorithm as FilterAlgorithm,
    frame_count: finiteNumber(value.frame_count, 'stats.frame_count'),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the sensor fusion engine
 */
export async function initFusion(config?: Partial<FusionConfig>): Promise<void> {
  const fullConfig: FusionConfig | undefined = config
    ? {
        algorithm: config.algorithm ?? 'ExtendedKalman',
        process_noise: config.process_noise ?? 1.0,
        measurement_noise: config.measurement_noise ?? 2.0,
        association_threshold: config.association_threshold ?? 11.345,
        max_missed_detections: config.max_missed_detections ?? 5,
        min_confirmation_hits: config.min_confirmation_hits ?? 3,
        confirmation_window: config.confirmation_window ?? 5,
        max_position_cov_volume: config.max_position_cov_volume ?? 1e6,
        particle_count: config.particle_count ?? 100,
      }
    : undefined

  await invoke(TAURI_COMMANDS.fusion.init, { config: fullConfig })
}

/**
 * Process sensor measurements and get fused tracks
 */
export async function processMeasurements(
  measurements: SensorMeasurement[],
  timestampMs?: number
): Promise<FusedTrack[]> {
  const ts = timestampMs ?? Date.now()
  const response = await invoke<unknown>(TAURI_COMMANDS.fusion.process, {
    measurements,
    timestampMs: ts,
  })
  return normalizeTracks(response)
}

/**
 * Get current tracks without processing new measurements
 */
export async function getTracks(): Promise<FusedTrack[]> {
  const response = await invoke<unknown>(TAURI_COMMANDS.fusion.getTracks)
  return normalizeTracks(response)
}

/**
 * Get fusion statistics
 */
export async function getFusionStats(): Promise<FusionStats> {
  const response = await invoke<unknown>(TAURI_COMMANDS.fusion.getStats)
  return normalizeFusionStats(response)
}

/**
 * Update fusion configuration
 */
export async function setFusionConfig(config: FusionConfig): Promise<void> {
  await invoke(TAURI_COMMANDS.fusion.setConfig, { config })
}

/**
 * Clear all tracks
 */
export async function clearTracks(): Promise<void> {
  await invoke(TAURI_COMMANDS.fusion.clear)
}

/**
 * Get available filter algorithms
 */
export async function getAlgorithms(): Promise<AlgorithmInfo[]> {
  return invoke<AlgorithmInfo[]>(TAURI_COMMANDS.fusion.getAlgorithms)
}

/**
 * Get available sensor modalities
 */
export async function getModalities(): Promise<ModalityInfo[]> {
  return invoke<ModalityInfo[]>(TAURI_COMMANDS.fusion.getModalities)
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a visual camera measurement from detection
 */
export function createVisualMeasurement(
  sensorId: string,
  position: [number, number, number],
  confidence: number,
  classLabel: string,
  covariance: [number, number, number] = [1, 1, 1]
): SensorMeasurement {
  return {
    sensor_id: sensorId,
    modality: 'visual',
    timestamp_ms: Date.now(),
    position,
    covariance,
    confidence,
    class_label: classLabel,
    metadata: {},
  }
}

/**
 * Create a thermal measurement
 */
export function createThermalMeasurement(
  sensorId: string,
  position: [number, number, number],
  confidence: number,
  classLabel: string,
  temperatureK: number,
  signatureArea: number = 0.5,
  emissivity: number = 0.9
): ThermalMeasurement {
  return {
    sensor_id: sensorId,
    modality: 'thermal',
    timestamp_ms: Date.now(),
    position,
    covariance: [2, 2, 2], // Thermal typically has higher uncertainty
    confidence,
    class_label: classLabel,
    metadata: {},
    temperature_k: temperatureK,
    signature_area: signatureArea,
    emissivity,
  }
}

/**
 * Create an acoustic measurement
 */
export function createAcousticMeasurement(
  sensorId: string,
  doa: [number, number], // [azimuth, elevation] in radians
  confidence: number,
  classLabel: string,
  splDb: number,
  frequencyHz: number,
  dopplerHz?: number
): AcousticMeasurement {
  // Convert DOA to approximate Cartesian (assume 50m range for initial estimate)
  const range = 50
  const x = range * Math.cos(doa[1]) * Math.cos(doa[0])
  const y = range * Math.cos(doa[1]) * Math.sin(doa[0])
  const z = range * Math.sin(doa[1])

  return {
    sensor_id: sensorId,
    modality: 'acoustic',
    timestamp_ms: Date.now(),
    position: [x, y, z],
    covariance: [10, 10, 10], // Acoustic has high position uncertainty
    confidence,
    class_label: classLabel,
    metadata: {},
    spl_db: splDb,
    frequency_hz: frequencyHz,
    doa,
    doppler_hz: dopplerHz,
  }
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

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

const AdvancedSensorFusion = {
  // Core API
  initFusion,
  processMeasurements,
  getTracks,
  getFusionStats,
  setFusionConfig,
  clearTracks,
  getAlgorithms,
  getModalities,

  // Measurement creators
  createVisualMeasurement,
  createThermalMeasurement,
  createAcousticMeasurement,

  // Helpers
  getThreatColor,
  getTrackStateColor,
  formatAlgorithmName,
  formatModality,
}

export default AdvancedSensorFusion
