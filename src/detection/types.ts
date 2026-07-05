/**
 * CREBAIN Detection System - Type Definitions
 * Adaptive Response & Awareness System (ARAS)
 */

import type * as THREE from 'three'

/**
 * Available detector types
 */
export type DetectorType = 'yolo' | 'rf-detr' | 'moondream' | 'coreml'

// Detection class types for drone/aerial object classification
export type DetectionClass = 'drone' | 'bird' | 'aircraft' | 'helicopter' | 'unknown'

// Track lifecycle states
export type TrackState = 'tentative' | 'confirmed' | 'lost'

// Project threat levels (1-4)
export type ThreatLevel = 1 | 2 | 3 | 4

/**
 * Bounding box format: [x1, y1, x2, y2] in pixel coordinates
 */
export type BoundingBox = [number, number, number, number]

/**
 * Single detection from a detector
 */
export interface Detection {
  id: string
  class: DetectionClass
  confidence: number // 0-1
  bbox: BoundingBox
  timestamp: number
  /** Source frame width in pixels (when known). */
  frameWidth?: number
  /** Source frame height in pixels (when known). */
  frameHeight?: number

  // Optional fields populated by sensor fusion
  worldPosition?: THREE.Vector3
  velocity?: THREE.Vector3
  trackId?: string
  sensorSources?: string[] // Camera IDs that detected this
  fusedConfidence?: number
  threatLevel?: ThreatLevel
}

/**
 * Track representing a persistent object across frames
 */
export interface Track {
  id: string
  state: TrackState
  class: DetectionClass
  confidence: number

  // Current position and motion
  position: THREE.Vector3
  velocity: THREE.Vector3
  heading: number // radians

  // Detection sources
  sensorSources: string[]
  lastDetection: Detection

  // History
  positionHistory: THREE.Vector3[]
  detectionHistory: Detection[]

  // Timing
  createdAt: number
  updatedAt: number
  lostAt?: number

  // Threat assessment
  threatLevel: ThreatLevel
}

/**
 * Fused track from multiple camera sources
 */
export interface FusedTrack extends Track {
  fusedConfidence: number
  triangulatedPosition: THREE.Vector3
  triangulationError: number // meters
  contributingCameras: string[]
}

/**
 * Camera parameters for 3D triangulation
 */
export interface CameraParams {
  id: string
  position: THREE.Vector3
  rotation: THREE.Euler
  fov: number // degrees
  aspectRatio: number
  near: number
  far: number

  // Intrinsic matrix (3x3)
  intrinsicMatrix?: number[][]

  // Extrinsic matrix (4x4)
  extrinsicMatrix?: number[][]
}

/**
 * Abstract detector interface - all detectors must implement this
 */
export interface ObjectDetector {
  name: string
  modelPath: string
  inputSize: { width: number; height: number }
  classes: DetectionClass[]

  // Lifecycle
  initialize(): Promise<void>
  detect(imageData: ImageData): Promise<Detection[]>
  /**
   * Release model resources. Async because ONNX Runtime Web sessions hold
   * WASM/GPU memory that is only freed by awaiting `session.release()`.
   */
  dispose(): Promise<void>

  // Status
  isReady(): boolean
  getAverageLatency(): number
}

/**
 * Detector configuration
 */
export interface DetectorConfig {
  modelPath: string
  confidenceThreshold: number // 0-1
  iouThreshold: number // 0-1 for NMS
  maxDetections: number
  useWebGPU: boolean
}

/**
 * Detection result from a single camera
 */
export interface CameraDetectionResult {
  cameraId: string
  timestamp: number
  inferenceTime: number // ms
  detections: Detection[]
  frameWidth: number
  frameHeight: number
}

/**
 * Sensor fusion configuration
 */
export interface FusionConfig {
  correlationThreshold: number // 0-1
  maxTrackAge: number // ms before track is lost
  minConfirmationFrames: number
  velocitySmoothing: number // 0-1
  positionSmoothing: number // 0-1
}

/**
 * Message types for Web Worker communication
 */
export interface DetectionWorkerMessage {
  type: 'init' | 'detect' | 'dispose' | 'status'
  /**
   * Monotonic id correlating a `detect` request with its `detections`/`error`
   * response. Required for correct results when multiple `detect()` calls are
   * in flight — responses may arrive out of order, so FIFO matching would swap
   * results between requests.
   */
  requestId?: number
  payload?: {
    detectorType?: DetectorType
    modelPath?: string
    config?: Partial<DetectorConfig>
    imageData?: ImageData
    imageWidth?: number
    imageHeight?: number
  }
  transferables?: Transferable[]
}

export interface DetectionWorkerResponse {
  type: 'ready' | 'detections' | 'error' | 'status'
  /** Echoes the originating request's id whenever the request carried one —
   *  `detect` correlation as described above, but also `init`/`dispose`/`status`
   *  and malformed-message errors. Absent only when the triggering request had
   *  no id (or for unsolicited worker messages). */
  requestId?: number
  payload?: {
    detections?: Detection[]
    inferenceTime?: number
    error?: string
    status?: {
      isReady: boolean
      modelLoaded: boolean
      averageLatency: number
    }
  }
}

/**
 * Surveillance camera with detection capabilities
 */
export interface SurveillanceCamera {
  id: string
  name: string
  position: THREE.Vector3
  target: THREE.Vector3
  fov: number
  aspectRatio: number

  // Status
  isActive: boolean
  isRecording: boolean

  // Detection
  detections: Detection[]
  lastInferenceTime: number
  inferenceLatency: number
  trackingEnabled: boolean
  fusionWeight: number // 0-1 contribution to sensor fusion

  // Rendering
  renderTarget?: THREE.WebGLRenderTarget
  videoElement?: HTMLVideoElement

  // PTZ controls
  pan: number // degrees
  tilt: number // degrees
  zoom: number // 1.0 = normal
}

/**
 * Detection overlay style configuration
 */
export interface DetectionOverlayStyle {
  boxColor: Record<DetectionClass, string>
  boxWidth: number
  labelBackground: boolean
  showConfidence: boolean
  showTrackId: boolean
  showVelocity: boolean
  confidenceFormat: 'percent' | 'decimal'
}

/**
 * Default detection overlay style (ARAS standard)
 */
export const DEFAULT_OVERLAY_STYLE: DetectionOverlayStyle = {
  boxColor: {
    drone: '#c04040', // Red - hostile
    bird: '#4a7a4a', // Green - neutral
    aircraft: '#4a6a8a', // Blue - potentially friendly
    helicopter: '#4a6a8a', // Blue - potentially friendly
    unknown: '#a08040', // Amber - unknown
  },
  boxWidth: 2,
  labelBackground: true,
  showConfidence: true,
  showTrackId: true,
  showVelocity: false,
  confidenceFormat: 'percent',
}

/**
 * Class colors mapped to project threat assessment
 */
export const THREAT_LEVEL_COLORS: Record<ThreatLevel, string> = {
  1: '#3a6b4a', // Green - minimal
  2: '#4a6a8a', // Blue - guarded
  3: '#a08040', // Amber - elevated
  4: '#8b4a4a', // Red - severe
}

/**
 * Map a class label string (from CoreML/ONNX) to a tactical DetectionClass.
 * Centralised so every call-site uses the same mapping rules.
 */
export function mapToDetectionClass(classLabel: string): DetectionClass {
  const label = classLabel.toLowerCase()

  if (label === 'drone' || label === 'quadcopter' || label === 'uav') {
    return 'drone'
  }
  if (label === 'bird' || label.includes('bird')) {
    return 'bird'
  }
  if (label === 'airplane' || label === 'aircraft' || label === 'aeroplane') {
    return 'aircraft'
  }
  if (label === 'helicopter' || label === 'chopper') {
    return 'helicopter'
  }
  // Heuristic remap for demo/testing: treat a few "flying-adjacent" COCO labels
  // as `drone` to exercise downstream tracking/UI.
  if (label === 'kite' || label === 'frisbee') {
    return 'drone'
  }

  return 'unknown'
}

/**
 * Get threat level from detection class
 */
// Canonical 1-4 threat level. MUST stay identical to the Rust
// `calculate_threat_level` in src-tauri/src/sensor_fusion.rs.
export function getThreatLevel(detClass: DetectionClass, confidence: number): ThreatLevel {
  if (detClass === 'drone') {
    // Graduated: a low-confidence single-sensor drone hypothesis stays "guarded"
    // until corroboration lifts it to "elevated" (3) / "severe" (4).
    return confidence > 0.8 ? 4 : confidence > 0.5 ? 3 : 2
  }
  if (detClass === 'helicopter' || detClass === 'aircraft') {
    return 2
  }
  if (detClass === 'bird') {
    return 1
  }
  // unknown / unrecognized
  return confidence > 0.7 ? 3 : 2
}

/**
 * Generate unique detection ID
 */
export function generateDetectionId(): string {
  return `DET-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase()
}

/**
 * Generate unique track ID
 */
export function generateTrackId(): string {
  return `TRK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
}

// ─────────────────────────────────────────────────────────────────────────────
// COREML TYPES (shared between useCoreMLDetection and useDetectionLoop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CoreML bounding box format (pixel coordinates)
 */
export interface CoreMLBoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * CoreML detection result from Tauri backend
 */
export interface CoreMLDetection {
  id: string
  classLabel: string
  classIndex: number
  confidence: number
  bbox: CoreMLBoundingBox
  timestamp: number
}

/**
 * CoreML detection response from Tauri command
 */
export interface CoreMLDetectionResult {
  success: boolean
  detections: CoreMLDetection[]
  inferenceTimeMs: number
  preprocessTimeMs: number | null
  postprocessTimeMs: number | null
  backend?: string | null
  error: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION CONFIGURATION CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** Default confidence threshold for detection filtering */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.25

/** Default IOU threshold for non-maximum suppression */
export const DEFAULT_IOU_THRESHOLD = 0.45

/** Maximum number of detections per frame */
export const DEFAULT_MAX_DETECTIONS = 100

/** Default detection loop interval in milliseconds */
export const DEFAULT_DETECTION_INTERVAL_MS = 100

/** Maximum track age before marking as lost (milliseconds) */
export const DEFAULT_MAX_TRACK_AGE_MS = 3000

/** Minimum frames required to confirm a track */
export const DEFAULT_MIN_CONFIRMATION_FRAMES = 3
