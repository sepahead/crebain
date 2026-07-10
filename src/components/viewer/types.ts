/**
 * @fileoverview Shared type definitions for the CREBAIN 3D viewer system.
 * Includes types for rendering, cameras, assets, and UI state management.
 * @license MIT
 */

import type * as THREE from 'three'

// ─────────────────────────────────────────────────────────────────────────────
// RENDERER TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended renderer type with optional async methods for WebGPU compatibility.
 * The renderAsync method is available on WebGPURenderer but not WebGLRenderer.
 */
export type RendererWithAsync = THREE.WebGLRenderer & {
  /** Async render method (WebGPU only) */
  renderAsync?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<void>
}

/** Represents a loaded 3D asset (Gaussian splat or GLTF model) in the scene. */
export interface LoadedAsset {
  /** Unique identifier for the asset */
  id: string
  /** Display name (typically the filename) */
  name: string
  /** Asset format type */
  type: 'splat' | 'glb'
  /** The THREE.js object added to the scene */
  object: THREE.Object3D
  /** Reloadable source URL. Local File handles are intentionally not persisted. */
  source?: string
  /** Primary source bytes retained for aggregate scene-budget accounting. */
  byteSize?: number
}

/** A message displayed in the tactical console overlay. */
export interface ConsoleMessage {
  /** Unique identifier for message deduplication */
  id: string
  /** Message severity/category for styling */
  type: 'info' | 'success' | 'warning' | 'error' | 'tactical' | 'system'
  /** Human-readable message content */
  message: string
  /** Unix timestamp (ms) for display ordering */
  timestamp: number
}

/** Surveillance camera operational mode. */
export type CameraType = 'static' | 'ptz' | 'patrol'

/** Threat classification level (1=lowest, 4=highest). */
export type ThreatLevel = 1 | 2 | 3 | 4

/**
 * Complete state for a surveillance camera in the scene.
 * Includes both the visual representation and rendering resources.
 */
export interface SurveillanceCamera {
  /** Unique camera identifier (e.g., "SK-001") */
  id: string
  /** Human-readable camera name */
  name: string
  /** Camera operational mode */
  type: CameraType
  /** Perspective camera used for rendering the camera's view */
  camera: THREE.PerspectiveCamera
  /** Visual helper showing the camera's frustum in the scene */
  helper: THREE.CameraHelper
  /** 3D model representing the physical camera */
  mesh: THREE.Group
  /** Off-screen render target for camera feed */
  renderTarget: THREE.WebGLRenderTarget
  /** Horizontal rotation in radians */
  pan: number
  /** Vertical rotation in radians */
  tilt: number
  /** Zoom level (affects FOV) */
  zoom: number
  /** Waypoints for patrol mode cameras */
  patrolPoints?: THREE.Vector3[]
  /** Current patrol waypoint index */
  patrolIndex?: number
  /** Patrol movement speed in units/second */
  patrolSpeed?: number
  /** Patrol direction (1=forward, -1=reverse) */
  patrolDirection?: 1 | -1
  /** Whether the camera is currently active */
  isActive: boolean
  /** Whether the camera feed is being recorded */
  isRecording: boolean
}

/** Keyboard input state for first-person camera movement. */
export interface MovementState {
  forward: boolean
  backward: boolean
  left: boolean
  right: boolean
  up: boolean
  down: boolean
  /** Shift key held for faster movement */
  sprint: boolean
  /** Ctrl key held for slower, precise movement */
  precision: boolean
}

/** Configuration for camera movement behavior. */
export interface MovementParams {
  /** Base movement speed in units/second */
  baseSpeed: number
  /** Speed multiplier when sprinting */
  sprintMultiplier: number
  /** Speed multiplier for precision mode */
  precisionMultiplier: number
  /** Velocity smoothing factor (0-1, lower = more smoothing) */
  smoothing: number
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if a filename indicates a Gaussian splat format.
 * @param name - Filename to check
 * @returns True if the file is a supported splat format (.spz, .ply, .splat, .ksplat)
 */
export function isSplatFormat(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower.endsWith('.spz') ||
    lower.endsWith('.ply') ||
    lower.endsWith('.splat') ||
    lower.endsWith('.ksplat')
  )
}

/**
 * Checks if a filename indicates the self-contained GLB model format.
 * @param name - Filename to check
 * @returns True only for a GLB container; standalone .gltf resources are unsupported
 */
export function isGlbFormat(name: string): boolean {
  return name.toLowerCase().endsWith('.glb')
}

/**
 * Generates a military-style camera designation.
 * @param type - Camera type (static, ptz, patrol)
 * @param index - Camera index number
 * @returns Formatted designation (e.g., "SK-001", "PTZ-042", "PK-003")
 */
export function generateCameraDesignation(type: CameraType, index: number): string {
  const prefix = type === 'static' ? 'SK' : type === 'ptz' ? 'PTZ' : 'PK'
  return `${prefix}-${String(index).padStart(3, '0')}`
}

/**
 * Formats a Date as a Zulu (UTC) time string.
 * @param date - Date to format
 * @returns ISO-style string with 'Z' suffix (e.g., "2024-01-15 14:30:45Z")
 */
export function formatZuluTime(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19) + 'Z'
}

/**
 * Formats a decimal degree coordinate as degrees/minutes/seconds.
 * @param value - Coordinate in decimal degrees
 * @param isLat - True for latitude (N/S), false for longitude (E/W)
 * @returns Formatted coordinate string (e.g., "48°51'24.0\"N")
 */
export function formatCoordinate(value: number, isLat: boolean): string {
  const abs = Math.abs(value)
  const deg = Math.floor(abs)
  const min = Math.floor((abs - deg) * 60)
  const sec = ((abs - deg - min / 60) * 3600).toFixed(1)
  const dir = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W'
  return `${deg}°${String(min).padStart(2, '0')}'${sec}"${dir}`
}
