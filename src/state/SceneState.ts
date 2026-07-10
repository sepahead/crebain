/**
 * CREBAIN Scene State Management
 * Save and load complete scene state including cameras, drones, detections, and settings
 */

import * as THREE from 'three'
import { sceneLogger as log } from '../lib/logger'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { TAURI_COMMANDS } from '../lib/tauriCommands'

// ─────────────────────────────────────────────────────────────────────────────
// STATE TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface Vector3State {
  x: number
  y: number
  z: number
}

export interface QuaternionState {
  x: number
  y: number
  z: number
  w: number
}

export interface CameraState {
  id: string
  name: string
  type: 'static' | 'ptz' | 'patrol'
  position: Vector3State
  rotation: Vector3State
  fov: number
  near: number
  far: number
  isActive: boolean
  resolution: [number, number]
  // PTZ specific
  pan?: number
  tilt?: number
  zoom?: number
  // Patrol specific
  patrolPoints?: Vector3State[]
  patrolSpeed?: number
}

export interface DroneState {
  id: string
  name?: string
  type: string // e.g., 'maverick', 'shahed', 'fpv_racer'
  position: Vector3State
  orientation: QuaternionState
  velocity: Vector3State
  angularVelocity: Vector3State
  armed: boolean
  battery: number
  // Flight controller state
  targetAltitude?: number
  targetPosition?: Vector3State
  flightMode?: 'manual' | 'stabilized' | 'altitude_hold' | 'position_hold' | 'waypoint'
  waypoints?: Vector3State[]
  routeMode?: 'none' | 'once' | 'patrol'
  routeActive?: boolean
  routeCurrentWaypointIndex?: number
}

export interface DetectionState {
  id: string
  cameraId: string
  class: string
  confidence: number
  bbox: [number, number, number, number]
  timestamp: number
  threatLevel: number
}

export interface SplatSceneState {
  url: string
  localPath?: string
  position: Vector3State
  rotation: Vector3State
  scale: Vector3State
}

export interface SceneAssetState {
  id: string
  name: string
  type: 'glb'
  source: string
  position: Vector3State
  rotation: Vector3State
  scale: Vector3State
}

export interface ViewerSettingsState {
  detectionEnabled: boolean
  showDetectionPanel: boolean
  showPerformancePanel: boolean
  renderQuality: 'low' | 'medium' | 'high' | 'ultra'
  physicsEnabled: boolean
  sensorSimulationEnabled: boolean
}

export interface SceneState {
  version: string
  timestamp: number
  name: string
  description?: string

  // Core scene
  splatScene?: SplatSceneState
  assets?: SceneAssetState[]

  // Cameras
  cameras: CameraState[]
  activeCameraId?: string

  // Drones
  drones: DroneState[]

  // Detections (recent)
  recentDetections: DetectionState[]

  // Viewer settings
  settings: ViewerSettingsState

  // Camera view state
  viewCamera: {
    position: Vector3State
    target: Vector3State
  }

  // Custom metadata
  metadata?: Record<string, unknown>
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSION UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export function vector3ToState(v: THREE.Vector3): Vector3State {
  return { x: v.x, y: v.y, z: v.z }
}

export function stateToVector3(s: Vector3State): THREE.Vector3 {
  return new THREE.Vector3(s.x, s.y, s.z)
}

export function quaternionToState(q: THREE.Quaternion): QuaternionState {
  return { x: q.x, y: q.y, z: q.z, w: q.w }
}

export function stateToQuaternion(s: QuaternionState): THREE.Quaternion {
  return new THREE.Quaternion(s.x, s.y, s.z, s.w)
}

export function eulerToState(e: THREE.Euler): Vector3State {
  return { x: e.x, y: e.y, z: e.z }
}

export function stateToEuler(s: Vector3State): THREE.Euler {
  return new THREE.Euler(s.x, s.y, s.z)
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE MANAGER
// ─────────────────────────────────────────────────────────────────────────────

const CURRENT_VERSION = '1.0.0'
const STORAGE_KEY = 'crebain_scene_state'
const AUTOSAVE_KEY = 'crebain_autosave'
export const MAX_SCENE_STATE_BYTES = 10 * 1024 * 1024
const MAX_SCENE_CAMERAS = 64
const MAX_SCENE_DRONES = 256
export const MAX_SCENE_ASSETS = 128
const MAX_SCENE_DETECTIONS = 10_000
const MAX_ROUTE_POINTS = 4096
const MAX_NAME_LENGTH = 256
const MAX_CAMERA_RENDER_PIXELS = 16_777_216
const MAX_VECTOR_COMPONENT = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value)
}

function isVector3State(value: unknown): value is Vector3State {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    Math.abs(value.x) <= MAX_VECTOR_COMPONENT &&
    isFiniteNumber(value.y) &&
    Math.abs(value.y) <= MAX_VECTOR_COMPONENT &&
    isFiniteNumber(value.z) &&
    Math.abs(value.z) <= MAX_VECTOR_COMPONENT
  )
}

function isQuaternionState(value: unknown): value is QuaternionState {
  if (!(
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z) &&
    isFiniteNumber(value.w)
  ))
    return false
  const normSquared = value.x ** 2 + value.y ** 2 + value.z ** 2 + value.w ** 2
  return Number.isFinite(normSquared) && Math.abs(Math.sqrt(normSquared) - 1) <= 0.01
}

function isCameraType(value: unknown): value is CameraState['type'] {
  return value === 'static' || value === 'ptz' || value === 'patrol'
}

function isRenderQuality(value: unknown): value is ViewerSettingsState['renderQuality'] {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'ultra'
}

function isFlightMode(value: unknown): value is NonNullable<DroneState['flightMode']> {
  return (
    value === 'manual' ||
    value === 'stabilized' ||
    value === 'altitude_hold' ||
    value === 'position_hold' ||
    value === 'waypoint'
  )
}

function isResolution(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    Number.isSafeInteger(value[1]) &&
    value[0] > 0 &&
    value[1] > 0 &&
    value[0] <= 4096 &&
    value[1] <= 4096
  )
}

function isFiniteTuple4(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber)
}

function isOptionalVector3Array(value: unknown): value is Vector3State[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.length <= MAX_ROUTE_POINTS && value.every(isVector3State))
  )
}

function isCameraState(value: unknown): value is CameraState {
  if (!isRecord(value)) return false
  if (
    !isString(value.id) ||
    value.id.length === 0 ||
    value.id.length > MAX_NAME_LENGTH ||
    !isString(value.name) ||
    value.name.length === 0 ||
    value.name.length > MAX_NAME_LENGTH
  )
    return false
  if (!isCameraType(value.type)) return false
  if (!isVector3State(value.position) || !isVector3State(value.rotation)) return false
  if (!isFiniteNumber(value.fov) || value.fov <= 0 || value.fov >= 180) return false
  if (!isFiniteNumber(value.near) || value.near <= 0) return false
  if (!isFiniteNumber(value.far) || value.far <= value.near) return false
  if (!isBoolean(value.isActive)) return false
  if (!isResolution(value.resolution)) return false
  if (value.pan !== undefined && !isFiniteNumber(value.pan)) return false
  if (value.tilt !== undefined && !isFiniteNumber(value.tilt)) return false
  if (value.zoom !== undefined && (!isFiniteNumber(value.zoom) || value.zoom <= 0)) return false
  if (!isOptionalVector3Array(value.patrolPoints)) return false
  if (
    value.patrolSpeed !== undefined &&
    (!isFiniteNumber(value.patrolSpeed) || value.patrolSpeed < 0 || value.patrolSpeed > 1)
  )
    return false
  return true
}

function isDroneState(value: unknown): value is DroneState {
  if (!isRecord(value)) return false
  if (
    !isString(value.id) ||
    value.id.length === 0 ||
    value.id.length > MAX_NAME_LENGTH ||
    !isString(value.type) ||
    value.type.length === 0 ||
    value.type.length > MAX_NAME_LENGTH
  )
    return false
  if (!isOptionalString(value.name)) return false
  if (value.name !== undefined && (value.name.length === 0 || value.name.length > MAX_NAME_LENGTH))
    return false
  if (!isVector3State(value.position)) return false
  if (!isQuaternionState(value.orientation)) return false
  if (!isVector3State(value.velocity) || !isVector3State(value.angularVelocity)) return false
  if (!isBoolean(value.armed)) return false
  if (!isFiniteNumber(value.battery) || value.battery < 0 || value.battery > 100) return false
  if (value.targetAltitude !== undefined && !isFiniteNumber(value.targetAltitude)) return false
  if (value.targetPosition !== undefined && !isVector3State(value.targetPosition)) return false
  if (value.flightMode !== undefined && !isFlightMode(value.flightMode)) return false
  if (!isOptionalVector3Array(value.waypoints)) return false
  if (
    value.routeMode !== undefined &&
    value.routeMode !== 'none' &&
    value.routeMode !== 'once' &&
    value.routeMode !== 'patrol'
  )
    return false
  if (value.routeActive !== undefined && !isBoolean(value.routeActive)) return false
  if (
    value.routeCurrentWaypointIndex !== undefined &&
    (!isFiniteNumber(value.routeCurrentWaypointIndex) ||
      !Number.isSafeInteger(value.routeCurrentWaypointIndex) ||
      value.routeCurrentWaypointIndex < 0)
  )
    return false
  if (
    value.routeCurrentWaypointIndex !== undefined &&
    (value.waypoints?.length ?? 0) > 0 &&
    value.routeCurrentWaypointIndex >= (value.waypoints?.length ?? 0)
  )
    return false
  return true
}

function isDetectionState(value: unknown): value is DetectionState {
  if (!isRecord(value)) return false
  if (
    !isString(value.id) ||
    value.id.length === 0 ||
    value.id.length > MAX_NAME_LENGTH ||
    !isString(value.cameraId) ||
    value.cameraId.length === 0 ||
    value.cameraId.length > MAX_NAME_LENGTH ||
    !isString(value.class) ||
    value.class.length === 0 ||
    value.class.length > MAX_NAME_LENGTH
  )
    return false
  if (!isFiniteNumber(value.confidence) || value.confidence < 0 || value.confidence > 1)
    return false
  if (
    !isFiniteTuple4(value.bbox) ||
    value.bbox.some((coordinate) => coordinate < 0 || coordinate > MAX_VECTOR_COMPONENT) ||
    value.bbox[2] < value.bbox[0] ||
    value.bbox[3] < value.bbox[1]
  )
    return false
  if (!isFiniteNumber(value.timestamp) || value.timestamp < 0) return false
  if (!isFiniteNumber(value.threatLevel) || value.threatLevel < 0 || value.threatLevel > 4)
    return false
  return true
}

function isSplatSceneState(value: unknown): value is SplatSceneState {
  if (!isRecord(value)) return false
  if (!isString(value.url) || !isReloadableSceneSource(value.url)) return false
  if (!isOptionalString(value.localPath)) return false
  if (
    !isVector3State(value.position) ||
    !isVector3State(value.rotation) ||
    !isVector3State(value.scale)
  )
    return false
  return value.scale.x > 0 && value.scale.y > 0 && value.scale.z > 0
}

export function isReloadableSceneSource(value: string): boolean {
  if (value.length === 0 || value.length > 2048 || value.includes('\0')) return false
  if (/^(\/|\.\/|\.\.\/)/.test(value)) return true
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '::1' ||
        url.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

function isSceneAssetState(value: unknown): value is SceneAssetState {
  if (!isRecord(value)) return false
  if (
    !isString(value.id) ||
    value.id.length === 0 ||
    value.id.length > MAX_NAME_LENGTH ||
    !isString(value.name) ||
    value.name.length === 0 ||
    value.name.length > MAX_NAME_LENGTH ||
    value.type !== 'glb'
  )
    return false
  if (!isString(value.source) || !isReloadableSceneSource(value.source)) return false
  if (!value.source.split('?')[0].toLowerCase().endsWith('.glb')) return false
  if (
    !isVector3State(value.position) ||
    !isVector3State(value.rotation) ||
    !isVector3State(value.scale)
  )
    return false
  return value.scale.x > 0 && value.scale.y > 0 && value.scale.z > 0
}

function isViewerSettingsState(value: unknown): value is ViewerSettingsState {
  return (
    isRecord(value) &&
    isBoolean(value.detectionEnabled) &&
    isBoolean(value.showDetectionPanel) &&
    isBoolean(value.showPerformancePanel) &&
    isRenderQuality(value.renderQuality) &&
    isBoolean(value.physicsEnabled) &&
    isBoolean(value.sensorSimulationEnabled)
  )
}

function isSceneState(value: unknown): value is SceneState {
  if (!isRecord(value)) return false
  if (typeof value.version !== 'string') return false
  if (!isFiniteNumber(value.timestamp)) return false
  if (
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.length > MAX_NAME_LENGTH
  )
    return false
  if (!isOptionalString(value.description)) return false
  if (value.splatScene !== undefined && !isSplatSceneState(value.splatScene)) return false
  if (
    value.assets !== undefined &&
    (!Array.isArray(value.assets) ||
      value.assets.length > MAX_SCENE_ASSETS ||
      !value.assets.every(isSceneAssetState))
  )
    return false
  if (
    !Array.isArray(value.cameras) ||
    value.cameras.length > MAX_SCENE_CAMERAS ||
    !value.cameras.every(isCameraState)
  )
    return false
  const renderPixels = value.cameras.reduce(
    (total, camera) => total + camera.resolution[0] * camera.resolution[1],
    0
  )
  if (!Number.isSafeInteger(renderPixels) || renderPixels > MAX_CAMERA_RENDER_PIXELS) return false
  if (!isOptionalString(value.activeCameraId)) return false
  if (
    !Array.isArray(value.drones) ||
    value.drones.length > MAX_SCENE_DRONES ||
    !value.drones.every(isDroneState)
  )
    return false
  if (
    !Array.isArray(value.recentDetections) ||
    value.recentDetections.length > MAX_SCENE_DETECTIONS ||
    !value.recentDetections.every(isDetectionState)
  )
    return false
  if (!isViewerSettingsState(value.settings)) return false
  if (!isRecord(value.viewCamera)) return false
  if (!isVector3State(value.viewCamera.position) || !isVector3State(value.viewCamera.target))
    return false
  if (value.metadata !== undefined && !isRecord(value.metadata)) return false
  const allIds = [
    ...value.cameras.map((camera) => camera.id),
    ...value.drones.map((drone) => drone.id),
    ...(value.assets ?? []).map((asset) => asset.id),
  ]
  if (new Set(allIds).size !== allIds.length) return false
  if (
    value.activeCameraId !== undefined &&
    !value.cameras.some((camera) => camera.id === value.activeCameraId)
  )
    return false
  const cameraIds = new Set(value.cameras.map((camera) => camera.id))
  if (value.recentDetections.some((detection) => !cameraIds.has(detection.cameraId))) return false
  return true
}

export class SceneStateManager {
  private currentState: SceneState | null = null
  private autosaveInterval: number | null = null
  private onStateChange?: (state: SceneState) => void

  constructor() {
    // Try to load autosaved state on init
    this.loadAutosave()
  }

  /**
   * Create a new empty state
   */
  createNew(name: string = 'Neue Szene'): SceneState {
    this.currentState = {
      version: CURRENT_VERSION,
      timestamp: Date.now(),
      name,
      cameras: [],
      drones: [],
      recentDetections: [],
      settings: {
        detectionEnabled: true,
        showDetectionPanel: true,
        showPerformancePanel: true,
        renderQuality: 'high',
        physicsEnabled: true,
        sensorSimulationEnabled: true,
      },
      viewCamera: {
        position: { x: 0, y: 5, z: 10 },
        target: { x: 0, y: 0, z: 0 },
      },
    }
    return this.currentState
  }

  /**
   * Get current state
   */
  getState(): SceneState | null {
    return this.currentState
  }

  /**
   * Update current state
   */
  updateState(partial: Partial<SceneState>): void {
    if (this.currentState) {
      this.currentState = {
        ...this.currentState,
        ...partial,
        timestamp: Date.now(),
      }
      this.onStateChange?.(this.currentState)
    }
  }

  /**
   * Add a camera to state
   */
  addCamera(camera: CameraState): void {
    if (this.currentState) {
      this.currentState.cameras.push(camera)
      this.currentState.timestamp = Date.now()
    }
  }

  /**
   * Update a camera in state
   */
  updateCamera(id: string, updates: Partial<CameraState>): void {
    if (this.currentState) {
      const idx = this.currentState.cameras.findIndex((c) => c.id === id)
      if (idx >= 0) {
        this.currentState.cameras[idx] = { ...this.currentState.cameras[idx], ...updates }
        this.currentState.timestamp = Date.now()
      }
    }
  }

  /**
   * Remove a camera from state
   */
  removeCamera(id: string): void {
    if (this.currentState) {
      this.currentState.cameras = this.currentState.cameras.filter((c) => c.id !== id)
      this.currentState.timestamp = Date.now()
    }
  }

  /**
   * Add a drone to state
   */
  addDrone(drone: DroneState): void {
    if (this.currentState) {
      this.currentState.drones.push(drone)
      this.currentState.timestamp = Date.now()
    }
  }

  /**
   * Update a drone in state
   */
  updateDrone(id: string, updates: Partial<DroneState>): void {
    if (this.currentState) {
      const idx = this.currentState.drones.findIndex((d) => d.id === id)
      if (idx >= 0) {
        this.currentState.drones[idx] = { ...this.currentState.drones[idx], ...updates }
        this.currentState.timestamp = Date.now()
      }
    }
  }

  /**
   * Remove a drone from state
   */
  removeDrone(id: string): void {
    if (this.currentState) {
      this.currentState.drones = this.currentState.drones.filter((d) => d.id !== id)
      this.currentState.timestamp = Date.now()
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SAVE/LOAD
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Save state to JSON string
   */
  serialize(): string {
    if (!this.currentState) {
      throw new Error('No state to serialize')
    }
    if (!isSceneState(this.currentState)) {
      throw new Error('Current scene state is invalid and cannot be saved')
    }
    const json = JSON.stringify(this.currentState, null, 2)
    if (new TextEncoder().encode(json).byteLength > MAX_SCENE_STATE_BYTES) {
      throw new Error(`Scene state exceeds ${MAX_SCENE_STATE_BYTES} bytes`)
    }
    return json
  }

  /**
   * Load state from JSON string.
   *
   * Parses leniently, dispatches version migration on the raw object first
   * (older files may not satisfy the current strict schema until migrated),
   * then validates the migrated result against the current schema.
   */
  deserialize(json: string): SceneState {
    if (json.length > MAX_SCENE_STATE_BYTES) {
      throw new Error(`Scene state exceeds ${MAX_SCENE_STATE_BYTES} bytes`)
    }
    const encodedLength = new TextEncoder().encode(json).byteLength
    if (encodedLength > MAX_SCENE_STATE_BYTES) {
      throw new Error(`Scene state exceeds ${MAX_SCENE_STATE_BYTES} bytes`)
    }
    const raw: unknown = JSON.parse(json)
    if (!isRecord(raw)) {
      throw new Error('Invalid scene state file')
    }

    const migrated = this.migrateState(raw)
    if (!isSceneState(migrated)) {
      throw new Error('Invalid scene state file')
    }

    this.currentState = migrated
    return migrated
  }

  /**
   * Save state to file (via download)
   */
  saveToFile(filename?: string): void {
    if (!this.currentState) return

    const json = this.serialize()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)

    const link = document.createElement('a')
    link.href = url
    link.download = filename || `crebain_scene_${Date.now()}.json`
    link.click()

    URL.revokeObjectURL(url)
  }

  /**
   * Load state from file
   */
  async loadFromFile(file: File): Promise<SceneState> {
    if (!file.name.toLowerCase().endsWith('.json')) {
      throw new Error('Scene file must end with .json')
    }
    if (file.size > MAX_SCENE_STATE_BYTES) {
      throw new Error(`Scene state exceeds ${MAX_SCENE_STATE_BYTES} bytes`)
    }
    const text = await file.text()
    return this.deserialize(text)
  }

  /**
   * Save to localStorage
   */
  saveToLocalStorage(key: string = STORAGE_KEY): boolean {
    if (!this.currentState) return false
    try {
      localStorage.setItem(key, this.serialize())
      return true
    } catch (e) {
      log.warn('Failed to save to localStorage', { error: e })
      return false
    }
  }

  /**
   * Load from localStorage
   */
  loadFromLocalStorage(key: string = STORAGE_KEY): SceneState | null {
    try {
      const json = localStorage.getItem(key)
      if (json) {
        return this.deserialize(json)
      }
    } catch (e) {
      log.warn('Failed to load from localStorage', { error: e })
    }
    return null
  }

  /**
   * Enable autosave every N seconds
   */
  enableAutosave(
    intervalSeconds: number = 30,
    createSnapshot?: () => SceneState,
    onError?: (error: Error) => void
  ): void {
    this.disableAutosave()
    this.autosaveInterval = window.setInterval(() => {
      if (createSnapshot) {
        try {
          const snapshot = createSnapshot()
          if (!isSceneState(snapshot)) {
            throw new Error('Autosave snapshot failed validation')
          }
          this.currentState = snapshot
        } catch (error) {
          log.warn('Failed to capture live autosave snapshot', { error })
          return
        }
      }
      if (!this.saveToLocalStorage(AUTOSAVE_KEY)) {
        const error = new Error('Autosave storage is unavailable or full')
        this.disableAutosave()
        onError?.(error)
      }
    }, intervalSeconds * 1000)
  }

  /**
   * Disable autosave
   */
  disableAutosave(): void {
    if (this.autosaveInterval !== null) {
      clearInterval(this.autosaveInterval)
      this.autosaveInterval = null
    }
  }

  /**
   * Whether autosave is currently running.
   */
  isAutosaveEnabled(): boolean {
    return this.autosaveInterval !== null
  }

  /**
   * Load autosaved state
   */
  loadAutosave(): SceneState | null {
    return this.loadFromLocalStorage(AUTOSAVE_KEY)
  }

  /**
   * Clear autosaved state
   */
  clearAutosave(): void {
    try {
      localStorage.removeItem(AUTOSAVE_KEY)
    } catch {
      // Ignore: clearing autosave is best-effort.
    }
  }

  /**
   * List saved states in localStorage
   */
  listSavedStates(): { key: string; name: string; timestamp: number }[] {
    const states: { key: string; name: string; timestamp: number }[] = []

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith('crebain_scene_') || key === AUTOSAVE_KEY) {
          const json = localStorage.getItem(key)
          if (json) {
            try {
              const raw: unknown = JSON.parse(json)
              if (!isRecord(raw)) continue
              const state = this.migrateState(raw)
              if (isSceneState(state)) {
                states.push({
                  key,
                  name: state.name,
                  timestamp: state.timestamp,
                })
              }
            } catch {
              // Ignore malformed or unsupported entries without hiding later saves.
            }
          }
        }
      }
    } catch (e) {
      log.warn('Failed to list saved states', { error: e })
    }

    return states.sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * Delete a saved state
   */
  deleteSavedState(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch (e) {
      log.warn('Failed to delete saved state', { error: e })
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TAURI FILE SYSTEM (if available)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Save state to the host filesystem (Tauri builds).
   *
   * Current behavior is a browser-safe fallback: this triggers a download and
   * only uses the basename of `path` (directory components are ignored).
   *
   * In Tauri, this calls the backend command `scene_save_file` to write JSON to
   * the requested path.
   */
  async saveToFileSystem(path: string): Promise<void> {
    if (!this.currentState) return
    try {
      await invoke(TAURI_COMMANDS.scene.saveFile, { path, json: this.serialize() })
    } catch (e) {
      if (isTauri()) {
        log.warn('Failed to save via Tauri filesystem', { error: e, path })
        throw e
      }
      log.warn('Failed to save via Tauri; falling back to download', { error: e, path })
      // Browser fallback: trigger a download; ignore directory components.
      this.saveToFile(path.split('/').pop())
    }
  }

  /**
   * Load state from the host filesystem (Tauri builds).
   *
   * In Tauri, this calls the backend command `scene_load_file` and then
   * `deserialize()` on the returned JSON.
   */
  async loadFromFileSystem(path: string): Promise<SceneState | null> {
    try {
      const json = await invoke<string>(TAURI_COMMANDS.scene.loadFile, { path })
      return this.deserialize(json)
    } catch (e) {
      log.warn('Failed to load via Tauri', { error: e, path })
      return null
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STATE MIGRATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Migrate a raw (pre-validation) state object to the current schema version.
   *
   * Dispatches on the file's own version string. Known older versions get a
   * transformation to the current schema; anything else (including future
   * versions) is rejected with a clear error instead of being silently
   * relabelled as the current version.
   */
  private migrateState(state: Record<string, unknown>): Record<string, unknown> {
    const version = typeof state.version === 'string' ? state.version : 'missing'

    switch (version) {
      case CURRENT_VERSION:
        return state
      case '0.4.0':
      case '0.5.0':
      case 'missing': {
        const migrated: Record<string, unknown> = {
          ...state,
          version: CURRENT_VERSION,
          timestamp: isFiniteNumber(state.timestamp) ? state.timestamp : Date.now(),
          cameras: Array.isArray(state.cameras) ? state.cameras : [],
          assets: Array.isArray(state.assets) ? state.assets : [],
          drones: Array.isArray(state.drones) ? state.drones : [],
          recentDetections: Array.isArray(state.recentDetections) ? state.recentDetections : [],
          settings: isRecord(state.settings)
            ? state.settings
            : {
                detectionEnabled: true,
                showDetectionPanel: true,
                showPerformancePanel: true,
                renderQuality: 'high',
                physicsEnabled: true,
                sensorSimulationEnabled: true,
              },
          viewCamera: isRecord(state.viewCamera)
            ? state.viewCamera
            : {
                position: { x: 0, y: 5, z: 10 },
                target: { x: 0, y: 0, z: 0 },
              },
        }
        return migrated
      }
      default:
        throw new Error(
          `Unsupported scene state version "${version}" (expected "${CURRENT_VERSION}")`
        )
    }
  }

  /**
   * Set callback for state changes
   */
  onStateChanged(callback: (state: SceneState) => void): void {
    this.onStateChange = callback
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLETON EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export const sceneStateManager = new SceneStateManager()

export default SceneStateManager
