/**
 * CREBAIN Sensor Fusion System
 * Adaptive Response & Awareness System (ARAS)
 *
 * Multi-camera detection correlation and track management
 */

import * as THREE from 'three'
import type {
  Detection,
  FusedTrack,
  CameraParams,
  FusionConfig,
  DetectionClass,
  ThreatLevel,
} from './types'
import {
  generateTrackId,
  getThreatLevel,
  DEFAULT_MAX_TRACK_AGE_MS,
  DEFAULT_MIN_CONFIRMATION_FRAMES,
} from './types'

const DEFAULT_FUSION_CONFIG: FusionConfig = {
  correlationThreshold: 0.5,
  maxTrackAge: DEFAULT_MAX_TRACK_AGE_MS,
  minConfirmationFrames: DEFAULT_MIN_CONFIRMATION_FRAMES,
  velocitySmoothing: 0.3,
  positionSmoothing: 0.5,
}

// Heuristic used by the triangulation fallback implementation.
// Treat this as "scene units" (meters in our default sim scale).
const DEFAULT_ASSUMED_TARGET_RANGE_M = 20

// Cross-camera correspondence gate (scene units / meters). Two detections from
// different cameras are only merged if their back-projected rays pass within this
// closest-approach distance — class + confidence + timestamp alone produce phantom
// triangulations from two different same-class targets.
const DEFAULT_RAY_GATE_DISTANCE_M = 3.0
// Camera-depth tolerance combines a small numerical floor with a scale-aware
// allowance, capped so a large far plane cannot make the visibility gate loose.
const MIN_RAY_DEPTH_TOLERANCE_M = 0.01
const MAX_RAY_DEPTH_TOLERANCE_M = 0.5
const RAY_DEPTH_TOLERANCE_RATIO = 1e-4
// Below this stereo parallax the least-squares depth is too ill-conditioned to
// promote as a physical measurement. Fixed-range fallbacks remain UI-only.
const MIN_TRIANGULATION_PARALLAX_RADIANS = THREE.MathUtils.degToRad(0.5)
// Range (m) at which the spatial term of the track-match score decays to zero.
const SPATIAL_MATCH_SCALE_M = 15
const FORBIDDEN_ASSIGNMENT_COST = 1_000_000

// Browser fusion is a visualization/research path, not the native authority.
// Keep every pre-assignment dimension bounded so hostile or accidentally
// retained UI input cannot create an unbounded dense Hungarian matrix.
export const MAX_BROWSER_FUSION_CAMERAS = 64
export const MAX_BROWSER_FUSION_DETECTIONS = 512
export const MAX_BROWSER_FUSION_GROUPS = 128
export const MAX_BROWSER_FUSION_TRACKS = 128
export const MAX_BROWSER_FUSION_FRAME_ID_BYTES = 128
export const MAX_BROWSER_FUSION_FRAME_AGE_MS = 3_000
export const MAX_BROWSER_FUSION_FUTURE_SKEW_MS = 250
export const MAX_BROWSER_FUSION_MEASUREMENT_SKEW_MS = 500
export const MAX_BROWSER_FUSION_INPUT_ID_BYTES = 256
export const MAX_BROWSER_FUSION_IMAGE_DIMENSION = 8_192

const MAX_BROWSER_FUSION_SCENE_MAGNITUDE = 1_000_000
const MAX_BROWSER_FUSION_CAMERA_ASPECT_RATIO = 100
const VALID_DETECTION_CLASSES: ReadonlySet<string> = new Set<DetectionClass>([
  'drone',
  'bird',
  'aircraft',
  'helicopter',
  'unknown',
])
const VALID_EULER_ORDERS: ReadonlySet<string> = new Set(['XYZ', 'YZX', 'ZXY', 'XZY', 'YXZ', 'ZYX'])

export interface FusionFrameContext {
  /** Unique within one viewer generation. */
  frameId: string
  /** Strictly increasing within one viewer generation. */
  epoch: number
  /** Coherent measurement time for every observation in this batch. */
  timestampMs: number
}

/**
 * True only when a browser track carries an actual finite multi-camera
 * triangulation. Single-camera tracks retain an origin placeholder for the
 * local tracker UI and must never be promoted as spatial measurements.
 */
export function hasFiniteMultiCameraTriangulation(track: FusedTrack): boolean {
  return (
    track.contributingCameras.length >= 2 &&
    Number.isFinite(track.triangulationError) &&
    track.triangulationError >= 0 &&
    track.triangulatedPosition.toArray().every(Number.isFinite)
  )
}

export type FusionFrameStatus =
  | 'idle'
  | 'ok'
  | 'degraded_capacity'
  | 'degraded_input'
  | 'rejected_identity'
  | 'rejected_timestamp'

type Ray = { origin: THREE.Vector3; direction: THREE.Vector3 }

function cameraDepthTolerance(camera: CameraParams): number {
  return Math.min(
    MAX_RAY_DEPTH_TOLERANCE_M,
    Math.max(MIN_RAY_DEPTH_TOLERANCE_M, camera.far * RAY_DEPTH_TOLERANCE_RATIO)
  )
}

function isVisibleRayDepth(depth: number, camera: CameraParams): boolean {
  if (!Number.isFinite(depth)) return false
  const tolerance = cameraDepthTolerance(camera)
  return depth >= Math.max(0, camera.near - tolerance) && depth <= camera.far + tolerance
}

function hasStableTriangulationParallax(rays: Ray[]): boolean {
  const minimumCrossMagnitude = Math.sin(MIN_TRIANGULATION_PARALLAX_RADIANS)
  for (let left = 0; left < rays.length; left++) {
    for (let right = left + 1; right < rays.length; right++) {
      if (
        rays[left].direction.clone().cross(rays[right].direction).length() >= minimumCrossMagnitude
      ) {
        return true
      }
    }
  }
  return false
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_BROWSER_FUSION_INPUT_ID_BYTES &&
    new TextEncoder().encode(value).byteLength <= MAX_BROWSER_FUSION_INPUT_ID_BYTES
  )
}

function normalizeCameraForFusion(cameraId: string, camera: CameraParams): CameraParams | null {
  if (
    !isBoundedIdentifier(cameraId) ||
    !camera ||
    camera.id !== cameraId ||
    !(camera.position instanceof THREE.Vector3) ||
    !(camera.rotation instanceof THREE.Euler) ||
    !VALID_EULER_ORDERS.has(camera.rotation.order)
  ) {
    return null
  }

  const position = camera.position.toArray()
  const rotation = [camera.rotation.x, camera.rotation.y, camera.rotation.z]
  if (
    !position.every(
      (value) => Number.isFinite(value) && Math.abs(value) <= MAX_BROWSER_FUSION_SCENE_MAGNITUDE
    ) ||
    !rotation.every(
      (value) => Number.isFinite(value) && Math.abs(value) <= MAX_BROWSER_FUSION_SCENE_MAGNITUDE
    ) ||
    !Number.isFinite(camera.fov) ||
    camera.fov <= 0 ||
    camera.fov >= 180 ||
    !Number.isFinite(camera.aspectRatio) ||
    camera.aspectRatio <= 0 ||
    camera.aspectRatio > MAX_BROWSER_FUSION_CAMERA_ASPECT_RATIO ||
    !Number.isFinite(camera.near) ||
    camera.near <= 0 ||
    !Number.isFinite(camera.far) ||
    camera.far <= camera.near ||
    camera.far > MAX_BROWSER_FUSION_SCENE_MAGNITUDE
  ) {
    return null
  }

  return {
    id: cameraId,
    position: camera.position.clone(),
    rotation: camera.rotation.clone(),
    fov: camera.fov,
    aspectRatio: camera.aspectRatio,
    near: camera.near,
    far: camera.far,
  }
}

function normalizeDetectionForFusion(cameraId: string, detection: Detection): Detection | null {
  if (
    !detection ||
    !isBoundedIdentifier(detection.id) ||
    !VALID_DETECTION_CLASSES.has(detection.class) ||
    !Number.isFinite(detection.confidence) ||
    detection.confidence < 0 ||
    detection.confidence > 1 ||
    !Number.isSafeInteger(detection.timestamp) ||
    detection.timestamp < 0 ||
    !Array.isArray(detection.bbox) ||
    detection.bbox.length !== 4
  ) {
    return null
  }

  const [x1, y1, x2, y2] = detection.bbox
  if (!detection.bbox.every(Number.isFinite) || x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1) {
    return null
  }

  const hasFrameWidth = detection.frameWidth !== undefined
  const hasFrameHeight = detection.frameHeight !== undefined
  if (hasFrameWidth !== hasFrameHeight) return null

  if (hasFrameWidth && hasFrameHeight) {
    if (
      !Number.isSafeInteger(detection.frameWidth) ||
      !Number.isSafeInteger(detection.frameHeight) ||
      detection.frameWidth! < 1 ||
      detection.frameWidth! > MAX_BROWSER_FUSION_IMAGE_DIMENSION ||
      detection.frameHeight! < 1 ||
      detection.frameHeight! > MAX_BROWSER_FUSION_IMAGE_DIMENSION ||
      x2 > detection.frameWidth! ||
      y2 > detection.frameHeight!
    ) {
      return null
    }
  } else if (x2 > MAX_BROWSER_FUSION_IMAGE_DIMENSION || y2 > MAX_BROWSER_FUSION_IMAGE_DIMENSION) {
    return null
  }

  return {
    id: detection.id,
    class: detection.class,
    confidence: detection.confidence,
    bbox: [x1, y1, x2, y2],
    timestamp: detection.timestamp,
    ...(hasFrameWidth
      ? { frameWidth: detection.frameWidth, frameHeight: detection.frameHeight }
      : {}),
    sensorSources: [cameraId],
    threatLevel: getThreatLevel(detection.class, detection.confidence),
  }
}

function solve3x3(A: number[][], b: number[]): THREE.Vector3 | null {
  const m = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ]

  const EPS = 1e-8

  for (let col = 0; col < 3; col++) {
    let pivotRow = col
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivotRow][col])) {
        pivotRow = row
      }
    }
    if (Math.abs(m[pivotRow][col]) < EPS) return null
    if (pivotRow !== col) {
      const tmp = m[col]
      m[col] = m[pivotRow]
      m[pivotRow] = tmp
    }

    const pivot = m[col][col]
    for (let c = col; c < 4; c++) {
      m[col][c] /= pivot
    }

    for (let row = 0; row < 3; row++) {
      if (row === col) continue
      const factor = m[row][col]
      for (let c = col; c < 4; c++) {
        m[row][c] -= factor * m[col][c]
      }
    }
  }

  return new THREE.Vector3(m[0][3], m[1][3], m[2][3])
}

function rayFromDetection(camera: CameraParams, detection: Detection): Ray {
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation).normalize()

  const frameWidth = detection.frameWidth
  const frameHeight = detection.frameHeight
  if (!frameWidth || !frameHeight || frameWidth <= 0 || frameHeight <= 0) {
    return { origin: camera.position.clone(), direction: forward }
  }

  const [x1, y1, x2, y2] = detection.bbox
  const centerX = (x1 + x2) / 2
  const centerY = (y1 + y2) / 2

  const ndcX = (centerX / frameWidth) * 2 - 1
  const ndcY = 1 - (centerY / frameHeight) * 2

  const halfFovRad = (camera.fov * Math.PI) / 360
  const tanHalfFov = Math.tan(halfFovRad)
  const dirCamera = new THREE.Vector3(
    ndcX * tanHalfFov * camera.aspectRatio,
    ndcY * tanHalfFov,
    -1
  ).normalize()

  const dirWorld = dirCamera.applyEuler(camera.rotation).normalize()
  return { origin: camera.position.clone(), direction: dirWorld }
}

/**
 * Closest approach between two (skew) rays. Returns the minimum distance between
 * the lines and the ray parameters `t1, t2` of the closest points (distance along
 * each unit direction from its origin). For two cross-camera rays of a true
 * correspondence the distance is near zero and `t1, t2 > 0` (target in front of
 * both cameras); for two different targets the rays miss and the distance is large.
 */
function rayClosestApproach(r1: Ray, r2: Ray): { distance: number; t1: number; t2: number } {
  const d1 = r1.direction
  const d2 = r2.direction
  const w0 = r1.origin.clone().sub(r2.origin) // o1 - o2
  const a = d1.dot(d1)
  const b = d1.dot(d2)
  const c = d2.dot(d2)
  const d = d1.dot(w0)
  const e = d2.dot(w0)
  const denom = a * c - b * b
  const EPS = 1e-8
  let t1: number
  let t2: number
  if (denom < EPS) {
    // Near-parallel: pin t1, project onto the other ray (point-to-line distance).
    t1 = 0
    t2 = b > c ? d / b : e / c
  } else {
    t1 = (b * e - c * d) / denom
    t2 = (a * e - b * d) / denom
  }
  const p1 = r1.origin.clone().add(d1.clone().multiplyScalar(t1))
  const p2 = r2.origin.clone().add(d2.clone().multiplyScalar(t2))
  return { distance: p1.distanceTo(p2), t1, t2 }
}

/**
 * Rectangular minimum-cost assignment for rows <= columns (Hungarian algorithm).
 * Every row receives one unique column; callers add per-row dummy columns when
 * leaving a row unmatched is allowed.
 */
function solveMinimumCostAssignment(cost: number[][]): number[] {
  const rowCount = cost.length
  if (rowCount === 0) return []
  const columnCount = cost[0]?.length ?? 0
  if (columnCount < rowCount) {
    throw new Error('Assignment matrix must have at least as many columns as rows')
  }

  const rowPotential = new Array<number>(rowCount + 1).fill(0)
  const columnPotential = new Array<number>(columnCount + 1).fill(0)
  const matchedRowByColumn = new Array<number>(columnCount + 1).fill(0)
  const previousColumn = new Array<number>(columnCount + 1).fill(0)

  for (let row = 1; row <= rowCount; row++) {
    matchedRowByColumn[0] = row
    let column = 0
    const minReducedCost = new Array<number>(columnCount + 1).fill(Infinity)
    const usedColumn = new Array<boolean>(columnCount + 1).fill(false)

    do {
      usedColumn[column] = true
      const currentRow = matchedRowByColumn[column]
      let delta = Infinity
      let nextColumn = 0

      for (let candidateColumn = 1; candidateColumn <= columnCount; candidateColumn++) {
        if (usedColumn[candidateColumn]) continue
        const reducedCost =
          cost[currentRow - 1][candidateColumn - 1] -
          rowPotential[currentRow] -
          columnPotential[candidateColumn]
        if (reducedCost < minReducedCost[candidateColumn]) {
          minReducedCost[candidateColumn] = reducedCost
          previousColumn[candidateColumn] = column
        }
        if (minReducedCost[candidateColumn] < delta) {
          delta = minReducedCost[candidateColumn]
          nextColumn = candidateColumn
        }
      }

      for (let candidateColumn = 0; candidateColumn <= columnCount; candidateColumn++) {
        if (usedColumn[candidateColumn]) {
          rowPotential[matchedRowByColumn[candidateColumn]] += delta
          columnPotential[candidateColumn] -= delta
        } else {
          minReducedCost[candidateColumn] -= delta
        }
      }
      column = nextColumn
    } while (matchedRowByColumn[column] !== 0)

    do {
      const priorColumn = previousColumn[column]
      matchedRowByColumn[column] = matchedRowByColumn[priorColumn]
      column = priorColumn
    } while (column !== 0)
  }

  const assignedColumnByRow = new Array<number>(rowCount).fill(-1)
  for (let column = 1; column <= columnCount; column++) {
    const row = matchedRowByColumn[column]
    if (row !== 0) assignedColumnByRow[row - 1] = column - 1
  }
  return assignedColumnByRow
}

/**
 * Sensor Fusion Engine
 *
 * Correlates detections from multiple cameras, manages persistent tracks,
 * triangulates 3D positions, and provides fused confidence scores.
 */
export class SensorFusion {
  private tracks: Map<string, FusedTrack> = new Map()
  private config: FusionConfig
  private frameCount = 0
  private lastExplicitEpoch = -1
  private lastExplicitFrameId: string | null = null
  private lastMeasurementTimestampMs: number | null = null
  private lastFrameStatus: FusionFrameStatus = 'idle'
  private lastFrameId: string | null = null
  private lastFrameDroppedDetections = 0
  private lastFrameRejectedDetections = 0
  private lastFrameDroppedGroups = 0
  private lastFrameEvictedTracks = 0
  private lastFrameDroppedCameras = 0
  private lastFrameRejectedCameras = 0
  private readonly lastFrameObservedTrackIds = new Set<string>()

  constructor(config: Partial<FusionConfig> = {}) {
    this.config = { ...DEFAULT_FUSION_CONFIG, ...config }
  }

  /**
   * Process detections from all cameras for a single frame
   */
  processFrame(
    detections: Map<string, Detection[]>,
    cameras: Map<string, CameraParams>,
    context?: FusionFrameContext
  ): FusedTrack[] {
    const candidateFrameId = context?.frameId
    const boundedFrameId =
      typeof candidateFrameId === 'string' &&
      candidateFrameId.length <= MAX_BROWSER_FUSION_FRAME_ID_BYTES &&
      new TextEncoder().encode(candidateFrameId).byteLength <= MAX_BROWSER_FUSION_FRAME_ID_BYTES
        ? candidateFrameId
        : null
    this.resetFrameAccounting(boundedFrameId)
    const inputDetectionCount = this.countDetections(detections)
    const wallClockNow = Date.now()

    if (context && !this.acceptFrameContext(context, wallClockNow)) {
      this.lastFrameDroppedDetections = inputDetectionCount
      return this.activeTracksForOutput()
    }

    const currentTime = context?.timestampMs ?? wallClockNow
    this.frameCount++
    const boundedCameras = this.boundCameras(cameras)
    const boundedDetections = this.boundDetections(
      detections,
      boundedCameras,
      context ? currentTime : null
    )

    // Enforce the live-track cap before allocating scores/costs. This is mostly
    // defensive because creation below also observes the cap, but it makes the
    // invariant explicit for upgraded/persisted instances as well.
    this.enforceLiveTrackCapacity()

    // Step 1: Correlate detections across cameras
    const allCorrelatedGroups = this.correlateDetections(boundedDetections, boundedCameras)
    const correlatedGroups = allCorrelatedGroups.slice(0, MAX_BROWSER_FUSION_GROUPS)
    this.lastFrameDroppedGroups += allCorrelatedGroups.length - correlatedGroups.length

    // Step 2: globally score group/track pairs against the pre-frame track set.
    // The assignment is one-to-one, so a track can receive at most one update in
    // this frame and a newly created track cannot absorb a later group.
    const groupAssignments = this.assignGroupsToTracks(correlatedGroups, boundedCameras)
    const matchedTrackIds = new Set<string>()

    for (let groupIndex = 0; groupIndex < correlatedGroups.length; groupIndex++) {
      const group = correlatedGroups[groupIndex]
      const matchedTrack = groupAssignments.get(groupIndex)

      if (matchedTrack) {
        // Update existing track
        this.updateTrack(matchedTrack, group, boundedCameras, currentTime)
        matchedTrackIds.add(matchedTrack.id)
        this.lastFrameObservedTrackIds.add(matchedTrack.id)
      } else {
        if (this.activeTrackCount() >= MAX_BROWSER_FUSION_TRACKS) {
          this.lastFrameDroppedGroups += 1
          continue
        }
        // Create new track
        const newTrack = this.createTrack(group, boundedCameras, currentTime)
        newTrack.id = this.uniqueTrackId(newTrack.id)
        this.tracks.set(newTrack.id, newTrack)
        matchedTrackIds.add(newTrack.id)
        this.lastFrameObservedTrackIds.add(newTrack.id)
      }
    }

    // Step 3: Age unmatched tracks
    for (const [trackId, track] of this.tracks) {
      if (!matchedTrackIds.has(trackId)) {
        this.ageTrack(track, currentTime)
      }
    }

    // Step 4: Remove dead tracks
    this.pruneDeadTracks(currentTime)

    if (this.lastFrameRejectedDetections > 0 || this.lastFrameRejectedCameras > 0) {
      this.lastFrameStatus = 'degraded_input'
    } else if (
      this.lastFrameDroppedDetections > 0 ||
      this.lastFrameDroppedGroups > 0 ||
      this.lastFrameEvictedTracks > 0 ||
      this.lastFrameDroppedCameras > 0
    ) {
      this.lastFrameStatus = 'degraded_capacity'
    } else {
      this.lastFrameStatus = 'ok'
    }

    // Step 5: Return active tracks
    return this.activeTracksForOutput()
  }

  private resetFrameAccounting(frameId: string | null): void {
    this.lastFrameStatus = 'ok'
    this.lastFrameId = frameId
    this.lastFrameDroppedDetections = 0
    this.lastFrameRejectedDetections = 0
    this.lastFrameDroppedGroups = 0
    this.lastFrameEvictedTracks = 0
    this.lastFrameDroppedCameras = 0
    this.lastFrameRejectedCameras = 0
    this.lastFrameObservedTrackIds.clear()
  }

  private countDetections(detections: Map<string, Detection[]>): number {
    let count = 0
    for (const cameraDetections of detections.values()) {
      count = Math.min(Number.MAX_SAFE_INTEGER, count + cameraDetections.length)
    }
    return count
  }

  private acceptFrameContext(context: FusionFrameContext, wallClockNow: number): boolean {
    const hasStringFrameId = typeof context.frameId === 'string'
    const frameIdBytes =
      hasStringFrameId && context.frameId.length <= MAX_BROWSER_FUSION_FRAME_ID_BYTES
        ? new TextEncoder().encode(context.frameId).byteLength
        : MAX_BROWSER_FUSION_FRAME_ID_BYTES + 1
    const hasValidIdentity =
      hasStringFrameId &&
      context.frameId.length > 0 &&
      frameIdBytes <= MAX_BROWSER_FUSION_FRAME_ID_BYTES &&
      Number.isSafeInteger(context.epoch) &&
      context.epoch >= 0
    if (
      !hasValidIdentity ||
      context.epoch <= this.lastExplicitEpoch ||
      context.frameId === this.lastExplicitFrameId
    ) {
      this.lastFrameStatus = 'rejected_identity'
      return false
    }

    // Consume an observed epoch even when its timestamp is rejected. Retrying a
    // previously rejected frame under the same identity must not make it fresh.
    this.lastExplicitEpoch = context.epoch
    this.lastExplicitFrameId = context.frameId

    const timestampIsValid =
      Number.isSafeInteger(context.timestampMs) &&
      context.timestampMs >= 0 &&
      context.timestampMs >= wallClockNow - MAX_BROWSER_FUSION_FRAME_AGE_MS &&
      context.timestampMs <= wallClockNow + MAX_BROWSER_FUSION_FUTURE_SKEW_MS &&
      (this.lastMeasurementTimestampMs === null ||
        context.timestampMs >= this.lastMeasurementTimestampMs)
    if (!timestampIsValid) {
      this.lastFrameStatus = 'rejected_timestamp'
      return false
    }
    this.lastMeasurementTimestampMs = context.timestampMs
    return true
  }

  private boundCameras(cameras: Map<string, CameraParams>): Map<string, CameraParams> {
    const bounded = new Map<string, CameraParams>()
    let dropped = 0
    for (const [cameraId, camera] of cameras) {
      if (bounded.size >= MAX_BROWSER_FUSION_CAMERAS) {
        dropped += 1
        continue
      }
      const normalized = normalizeCameraForFusion(cameraId, camera)
      if (!normalized) {
        this.lastFrameRejectedCameras += 1
        continue
      }
      bounded.set(cameraId, normalized)
    }
    this.lastFrameDroppedCameras = dropped
    return bounded
  }

  private boundDetections(
    detections: Map<string, Detection[]>,
    cameras: Map<string, CameraParams>,
    measurementTimestampMs: number | null
  ): Map<string, Detection[]> {
    const bounded = new Map<string, Detection[]>()
    const seenCameraDetectionIds = new Map<string, Set<string>>()
    let accepted = 0
    let observed = 0

    for (const [cameraId, cameraDetections] of detections) {
      observed = Math.min(Number.MAX_SAFE_INTEGER, observed + cameraDetections.length)
      if (!cameras.has(cameraId)) continue

      const acceptedForCamera: Detection[] = []
      const seenIds = seenCameraDetectionIds.get(cameraId) ?? new Set<string>()
      seenCameraDetectionIds.set(cameraId, seenIds)
      for (const detection of cameraDetections) {
        if (accepted >= MAX_BROWSER_FUSION_DETECTIONS) break
        const normalized = normalizeDetectionForFusion(cameraId, detection)
        if (!normalized) {
          this.lastFrameRejectedDetections += 1
          continue
        }
        if (seenIds.has(normalized.id)) {
          this.lastFrameRejectedDetections += 1
          continue
        }
        if (
          measurementTimestampMs !== null &&
          (normalized.timestamp < measurementTimestampMs - MAX_BROWSER_FUSION_MEASUREMENT_SKEW_MS ||
            normalized.timestamp > measurementTimestampMs + MAX_BROWSER_FUSION_FUTURE_SKEW_MS)
        ) {
          this.lastFrameRejectedDetections += 1
          continue
        }
        seenIds.add(normalized.id)
        acceptedForCamera.push(normalized)
        accepted += 1
      }
      if (acceptedForCamera.length > 0 || cameraDetections.length === 0) {
        bounded.set(cameraId, acceptedForCamera)
      }
    }

    this.lastFrameDroppedDetections += Math.max(
      0,
      observed - accepted - this.lastFrameRejectedDetections
    )
    return bounded
  }

  private activeTrackCount(): number {
    let count = 0
    for (const track of this.tracks.values()) {
      if (track.state !== 'lost') count += 1
    }
    return count
  }

  private uniqueTrackId(candidate: string): string {
    if (!this.tracks.has(candidate)) return candidate
    for (let suffix = 1; suffix <= MAX_BROWSER_FUSION_TRACKS; suffix += 1) {
      const disambiguated = `${candidate}-${suffix.toString(36).toUpperCase()}`
      if (!this.tracks.has(disambiguated)) return disambiguated
    }
    throw new Error('Browser fusion track ID space is exhausted')
  }

  private enforceLiveTrackCapacity(): void {
    const active = Array.from(this.tracks.values())
      .filter((track) => track.state !== 'lost')
      .sort(
        (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)
      )
    for (const track of active.slice(MAX_BROWSER_FUSION_TRACKS)) {
      this.tracks.delete(track.id)
      this.lastFrameEvictedTracks += 1
    }
  }

  private activeTracksForOutput(): FusedTrack[] {
    return Array.from(this.tracks.values())
      .filter((track) => track.state !== 'lost')
      .sort(
        (a, b) =>
          b.threatLevel - a.threatLevel || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
      )
  }

  /**
   * Correlate detections across cameras
   * Groups detections that likely represent the same object
   */
  private correlateDetections(
    detections: Map<string, Detection[]>,
    cameras: Map<string, CameraParams>
  ): CorrelatedGroup[] {
    const groups: CorrelatedGroup[] = []
    // Detector IDs are commonly scoped to one camera. Keep the camera namespace
    // explicit so equal IDs from two cameras remain distinct observations.
    const usedDetections = new Map<string, Set<string>>()
    const isUsed = (cameraId: string, detectionId: string): boolean =>
      usedDetections.get(cameraId)?.has(detectionId) ?? false
    const markUsed = (cameraId: string, detectionId: string): void => {
      const cameraDetections = usedDetections.get(cameraId) ?? new Set<string>()
      cameraDetections.add(detectionId)
      usedDetections.set(cameraId, cameraDetections)
    }

    // Convert to flat list with camera info
    const allDetections: { det: Detection; cameraId: string }[] = []
    for (const [cameraId, dets] of detections) {
      for (const det of dets) {
        allDetections.push({ det, cameraId })
      }
    }

    // Greedy correlation by class and confidence
    for (let i = 0; i < allDetections.length; i++) {
      const { det: det1, cameraId: cam1 } = allDetections[i]
      if (isUsed(cam1, det1.id)) continue

      const group: CorrelatedGroup = {
        detections: [det1],
        cameraIds: [cam1],
        primaryClass: det1.class,
        maxConfidence: det1.confidence,
      }
      markUsed(cam1, det1.id)

      // Find correlating detections from other cameras
      for (let j = i + 1; j < allDetections.length; j++) {
        const { det: det2, cameraId: cam2 } = allDetections[j]
        if (isUsed(cam2, det2.id)) continue
        if (cam2 === cam1) continue // Same camera as the seed
        // Skip a camera already represented in this group: two detections from
        // one camera would contribute two rays sharing an origin, biasing the
        // least-squares triangulation toward that camera.
        if (group.cameraIds.includes(cam2)) continue

        // A group must be a pairwise-consistent correspondence clique. Comparing
        // only with the seed is insufficient because geometric correlation is not
        // transitive: two rays can each pass the seed gate while failing each
        // other, producing a finite but physically unsupported least-squares point.
        const correlatesWithGroup = group.detections.every((groupDetection, groupIndex) =>
          this.detectionsCorrelate(groupDetection, group.cameraIds[groupIndex], det2, cam2, cameras)
        )
        if (correlatesWithGroup) {
          group.detections.push(det2)
          group.cameraIds.push(cam2)
          group.maxConfidence = Math.max(group.maxConfidence, det2.confidence)
          markUsed(cam2, det2.id)
        }
      }

      groups.push(group)
    }

    return groups
  }

  /**
   * Check if two detections from different cameras likely represent the same object
   */
  private detectionsCorrelate(
    det1: Detection,
    cam1Id: string,
    det2: Detection,
    cam2Id: string,
    cameras: Map<string, CameraParams>
  ): boolean {
    // Same class requirement
    if (det1.class !== det2.class) return false

    // Similar confidence (within 40%)
    const confDiff = Math.abs(det1.confidence - det2.confidence)
    if (confDiff > 0.4) return false

    // Temporal proximity (within 500ms)
    if (Math.abs(det1.timestamp - det2.timestamp) > 500) return false

    // Geometric gate: the two back-projected rays must nearly intersect (closest
    // approach within DEFAULT_RAY_GATE_DISTANCE_M) and meet within both cameras'
    // finite near/far depth interval. Without this, two different same-class targets
    // can correlate into a finite phantom far outside the visible frusta. Only
    // applied when geometry is available; otherwise use the class/temporal heuristic.
    const cam1 = cameras.get(cam1Id)
    const cam2 = cameras.get(cam2Id)
    if (!cam1 || !cam2) return true
    const hasGeometry = Boolean(
      det1.frameWidth && det1.frameHeight && det2.frameWidth && det2.frameHeight
    )
    if (!hasGeometry) return true

    const ray1 = rayFromDetection(cam1, det1)
    const ray2 = rayFromDetection(cam2, det2)
    const { distance, t1, t2 } = rayClosestApproach(ray1, ray2)
    if (distance > DEFAULT_RAY_GATE_DISTANCE_M) return false
    if (!isVisibleRayDepth(t1, cam1) || !isVisibleRayDepth(t2, cam2)) return false

    return true
  }

  /**
   * Build a global, score-ordered one-to-one assignment between correlated
   * groups and tracks that existed at the beginning of this frame.
   */
  private assignGroupsToTracks(
    groups: CorrelatedGroup[],
    cameras: Map<string, CameraParams>
  ): Map<number, FusedTrack> {
    const tracks = Array.from(this.tracks.values()).filter((track) => track.state !== 'lost')
    if (groups.length === 0 || tracks.length === 0) return new Map()
    const scores: Array<Array<number | null>> = []

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex]
      const groupPosition = this.computeGroupPosition(group, cameras)
      const groupScores = new Array<number | null>(tracks.length).fill(null)

      for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
        const track = tracks[trackIndex]
        if (track.class !== group.primaryClass) continue

        // Apply a hard spatial gate only when both sides carry actual
        // multi-camera geometry. Single-camera fixed-range projections are useful
        // as a scoring hint, but are not reliable enough to reject a track.
        const hasReliableTrackPosition =
          Number.isFinite(track.triangulationError) &&
          track.triangulatedPosition.toArray().every(Number.isFinite)
        if (
          group.cameraIds.length >= 2 &&
          groupPosition !== null &&
          hasReliableTrackPosition &&
          groupPosition.distanceTo(track.triangulatedPosition) >= SPATIAL_MATCH_SCALE_M
        ) {
          continue
        }

        const score = this.calculateMatchScore(track, group, groupPosition)
        if (score > this.config.correlationThreshold) {
          groupScores[trackIndex] = score
        }
      }
      scores.push(groupScores)
    }

    // A real candidate has cost 1-score; every group also receives its own dummy
    // column at cost 1. Minimizing total cost therefore maximizes the complete
    // frame's association score while allowing unmatched groups.
    const cost = scores.map((groupScores) => [
      ...groupScores.map((score) => (score === null ? FORBIDDEN_ASSIGNMENT_COST : 1 - score)),
      ...new Array<number>(groups.length).fill(1),
    ])
    const assignedColumns = solveMinimumCostAssignment(cost)
    const assignments = new Map<number, FusedTrack>()
    for (let groupIndex = 0; groupIndex < assignedColumns.length; groupIndex++) {
      const trackIndex = assignedColumns[groupIndex]
      if (
        trackIndex >= 0 &&
        trackIndex < tracks.length &&
        scores[groupIndex][trackIndex] !== null
      ) {
        assignments.set(groupIndex, tracks[trackIndex])
      }
    }

    return assignments
  }

  /**
   * Calculate match score between track and detection group
   */
  private calculateMatchScore(
    track: FusedTrack,
    group: CorrelatedGroup,
    groupPos: THREE.Vector3 | null
  ): number {
    // Class establishes a candidate, but does not by itself clear the default
    // threshold. Spatial proximity carries the largest discriminating weight.
    let score = 0.4

    // Boost for overlapping camera sources
    const sharedCameras = track.contributingCameras.filter((c) => group.cameraIds.includes(c))
    score +=
      (sharedCameras.length / Math.max(track.contributingCameras.length, group.cameraIds.length)) *
      0.2

    // Boost for similar confidence
    const confDiff = Math.abs(track.confidence - group.maxConfidence)
    score += Math.max(0, 1 - confDiff) * 0.1

    // Boost for 3D proximity: prefer the track nearest the group's triangulated
    // position, decaying to 0 at SPATIAL_MATCH_SCALE_M. When geometry is unavailable,
    // use neutral half-credit so a geometry-less continuation can still match.
    if (groupPos) {
      const dist = groupPos.distanceTo(track.triangulatedPosition)
      score += Math.max(0, 1 - dist / SPATIAL_MATCH_SCALE_M) * 0.3
    } else {
      score += 0.15
    }

    return Math.min(1, score)
  }

  /**
   * Create a new track from a correlated group
   */
  private createTrack(
    group: CorrelatedGroup,
    cameras: Map<string, CameraParams>,
    timestamp: number
  ): FusedTrack {
    const primaryDetection = group.detections.reduce((max, det) =>
      det.confidence > max.confidence ? det : max
    )

    // Try to triangulate position if we have multiple cameras
    let position = new THREE.Vector3(0, 0, 0)
    let triangulationError = Infinity

    if (group.cameraIds.length >= 2) {
      const result = this.triangulatePosition(group, cameras)
      if (result) {
        position = result.position
        triangulationError = result.error
      }
    }

    // Fused confidence - boost for multi-camera detection
    const detectionCount = group.detections.length
    const baseConfidence =
      detectionCount > 0
        ? group.detections.reduce((sum, d) => sum + d.confidence, 0) / detectionCount
        : 0
    const fusionBoost = Math.min(0.2, group.cameraIds.length * 0.05)
    const fusedConfidence = Math.min(1, baseConfidence + fusionBoost)

    const track: FusedTrack = {
      id: generateTrackId(),
      state: 'tentative',
      class: group.primaryClass,
      confidence: fusedConfidence,
      position,
      velocity: new THREE.Vector3(),
      heading: 0,
      sensorSources: group.cameraIds,
      lastDetection: primaryDetection,
      positionHistory: [position.clone()],
      detectionHistory: [primaryDetection],
      createdAt: timestamp,
      updatedAt: timestamp,
      threatLevel: getThreatLevel(group.primaryClass, fusedConfidence),
      fusedConfidence,
      triangulatedPosition: position.clone(),
      triangulationError,
      contributingCameras: [...group.cameraIds],
    }

    return track
  }

  /**
   * Update an existing track with new detections
   */
  private updateTrack(
    track: FusedTrack,
    group: CorrelatedGroup,
    cameras: Map<string, CameraParams>,
    timestamp: number
  ): void {
    const primaryDetection = group.detections.reduce((max, det) =>
      det.confidence > max.confidence ? det : max
    )

    // Update position with smoothing
    if (group.cameraIds.length >= 2) {
      const result = this.triangulatePosition(group, cameras)
      if (result) {
        const alpha = this.config.positionSmoothing
        track.position.lerp(result.position, alpha)
        track.triangulatedPosition = result.position
        track.triangulationError = result.error
      } else {
        track.triangulationError = Number.POSITIVE_INFINITY
      }
    } else {
      // A single-camera continuation updates class/confidence/lifecycle only.
      // Any older 3D estimate is stale for this observation timestamp.
      track.triangulationError = Number.POSITIVE_INFINITY
    }

    // Update velocity estimate
    if (track.positionHistory.length > 0) {
      const lastPos = track.positionHistory[track.positionHistory.length - 1]
      const dt = (timestamp - track.updatedAt) / 1000 // seconds
      if (dt > 0) {
        const newVelocity = track.position.clone().sub(lastPos).divideScalar(dt)
        track.velocity.lerp(newVelocity, this.config.velocitySmoothing)
      }
    }

    // Update heading from velocity
    if (track.velocity.length() > 0.1) {
      track.heading = Math.atan2(track.velocity.x, track.velocity.z)
    }

    // Update confidence
    const detectionCount = group.detections.length
    const baseConfidence =
      detectionCount > 0
        ? group.detections.reduce((sum, d) => sum + d.confidence, 0) / detectionCount
        : 0
    const fusionBoost = Math.min(0.2, group.cameraIds.length * 0.05)
    track.fusedConfidence = Math.min(1, baseConfidence + fusionBoost)
    track.confidence = track.fusedConfidence

    // Update state
    track.detectionHistory.push(primaryDetection)
    if (track.detectionHistory.length >= this.config.minConfirmationFrames) {
      track.state = 'confirmed'
    }

    // Update metadata
    track.lastDetection = primaryDetection
    track.sensorSources = group.cameraIds
    track.contributingCameras = [...new Set([...track.contributingCameras, ...group.cameraIds])]
    track.updatedAt = timestamp
    track.lostAt = undefined
    track.threatLevel = getThreatLevel(track.class, track.confidence)

    // Update history (keep last 30 positions)
    track.positionHistory.push(track.position.clone())
    if (track.positionHistory.length > 30) {
      track.positionHistory.shift()
    }
    if (track.detectionHistory.length > 30) {
      track.detectionHistory.shift()
    }
  }

  /**
   * Age a track that wasn't matched this frame
   */
  private ageTrack(track: FusedTrack, timestamp: number): void {
    if (track.state === 'lost') return

    // Mark as lost if too old
    if (!track.lostAt) {
      track.lostAt = timestamp
    }

    // Predict position based on velocity using time since last update.
    // Clamp dt to prevent unbounded drift when frames are missed or
    // the track goes unmatched for many consecutive frames.
    const dt = Math.min((timestamp - track.updatedAt) / 1000, 1.0)
    if (dt > 0) {
      track.position.x += track.velocity.x * dt
      track.position.y += track.velocity.y * dt
      track.position.z += track.velocity.z * dt
    }
    track.updatedAt = timestamp

    // Record the coasted position. updateTrack derives velocity as
    // (position − positionHistory[last]) / (timestamp − updatedAt); without this
    // push the history would stay frozen at the pre-coast position while updatedAt
    // advances each frame, so on re-acquisition a multi-frame displacement gets
    // divided by a single-frame dt — a velocity spike that corrupts heading and
    // the next dead-reckoning prediction. Keep the history bounded (cap 30).
    track.positionHistory.push(track.position.clone())
    if (track.positionHistory.length > 30) {
      track.positionHistory.shift()
    }

    // Decay confidence
    track.confidence *= 0.95
    track.fusedConfidence *= 0.95

    // Recompute threat from the decayed confidence so a coasting track does not
    // keep reporting an overstated (last-detected) threat level until pruned.
    track.threatLevel = getThreatLevel(track.class, track.confidence)
  }

  /**
   * Remove tracks that are too old
   */
  private pruneDeadTracks(timestamp: number): void {
    for (const [trackId, track] of this.tracks) {
      if (track.lostAt && timestamp - track.lostAt > this.config.maxTrackAge) {
        track.state = 'lost'
      }
      // Remove very old lost tracks
      if (
        track.state === 'lost' &&
        track.lostAt &&
        timestamp - track.lostAt > this.config.maxTrackAge * 2
      ) {
        this.tracks.delete(trackId)
      }
    }
  }

  /**
   * Estimate a group's 3D position for track matching: triangulate when ≥2 cameras
   * are available, otherwise project the single ray to the assumed range. Returns
   * `null` when no camera geometry is available.
   */
  private computeGroupPosition(
    group: CorrelatedGroup,
    cameras: Map<string, CameraParams>
  ): THREE.Vector3 | null {
    if (group.cameraIds.length >= 2) {
      return this.triangulatePosition(group, cameras)?.position ?? null
    }
    if (group.cameraIds.length === 1) {
      const cam = cameras.get(group.cameraIds[0])
      if (!cam) return null
      const ray = rayFromDetection(cam, group.detections[0])
      const displayRange = THREE.MathUtils.clamp(DEFAULT_ASSUMED_TARGET_RANGE_M, cam.near, cam.far)
      return ray.origin.clone().add(ray.direction.clone().multiplyScalar(displayRange))
    }
    return null
  }

  /**
   * Triangulate a 3D position from multiple camera detections.
   *
   * Uses a least-squares ray intersection when enough information is available:
   * - Derives per-camera rays from the bbox center using camera FOV + aspect.
   * - Requires `Detection.frameWidth/frameHeight` to interpret bbox pixels.
   *
   * Fallbacks:
   * - If frame dimensions are missing, uses the camera forward axis as the ray.
   * - If the least-squares system is ill-conditioned, falls back to an assumed
   *   fixed range along each ray for local visualization, while retaining an
   *   infinite error so it cannot be promoted as a measured 3D observation.
   *
   * For best results, populate camera intrinsics/extrinsics and use calibrated
   * projection instead of FOV-based approximation.
   */
  private triangulatePosition(
    group: CorrelatedGroup,
    cameras: Map<string, CameraParams>
  ): { position: THREE.Vector3; error: number } | null {
    const rays: Ray[] = []
    const rayCameras: CameraParams[] = []
    const fallbackPositions: THREE.Vector3[] = []
    const assumedRangeM = DEFAULT_ASSUMED_TARGET_RANGE_M

    const count = Math.min(group.cameraIds.length, group.detections.length)
    for (let i = 0; i < count; i++) {
      const camera = cameras.get(group.cameraIds[i])
      if (!camera) continue

      const detection = group.detections[i]
      const ray = rayFromDetection(camera, detection)
      rays.push(ray)
      rayCameras.push(camera)
      const displayRange = THREE.MathUtils.clamp(assumedRangeM, camera.near, camera.far)
      fallbackPositions.push(
        ray.origin.clone().add(ray.direction.clone().multiplyScalar(displayRange))
      )
    }

    if (rays.length === 0) return null

    if (rays.length >= 2 && hasStableTriangulationParallax(rays)) {
      // Least-squares intersection of rays: solve (Σ(I - ddᵀ)) x = Σ(I - ddᵀ) p
      const A = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ]
      const b = [0, 0, 0]

      for (const { origin, direction } of rays) {
        const dx = direction.x
        const dy = direction.y
        const dz = direction.z

        const m00 = 1 - dx * dx
        const m01 = -dx * dy
        const m02 = -dx * dz
        const m10 = -dy * dx
        const m11 = 1 - dy * dy
        const m12 = -dy * dz
        const m20 = -dz * dx
        const m21 = -dz * dy
        const m22 = 1 - dz * dz

        A[0][0] += m00
        A[0][1] += m01
        A[0][2] += m02
        A[1][0] += m10
        A[1][1] += m11
        A[1][2] += m12
        A[2][0] += m20
        A[2][1] += m21
        A[2][2] += m22

        b[0] += m00 * origin.x + m01 * origin.y + m02 * origin.z
        b[1] += m10 * origin.x + m11 * origin.y + m12 * origin.z
        b[2] += m20 * origin.x + m21 * origin.y + m22 * origin.z
      }

      const intersection = solve3x3(A, b)
      if (
        intersection &&
        Number.isFinite(intersection.x) &&
        Number.isFinite(intersection.y) &&
        Number.isFinite(intersection.z)
      ) {
        // Error as max perpendicular distance from intersection to each ray.
        let maxDist = 0
        let visibleToEveryCamera = true
        for (let index = 0; index < rays.length; index++) {
          const { origin, direction } = rays[index]
          const v = intersection.clone().sub(origin)
          const depth = v.dot(direction)
          if (!isVisibleRayDepth(depth, rayCameras[index])) {
            visibleToEveryCamera = false
            break
          }
          const dist = v.clone().cross(direction).length()
          maxDist = Math.max(maxDist, dist)
        }

        // Promote only a well-conditioned point inside every contributing camera's
        // finite depth interval and within the same geometric residual used for
        // pairwise correspondence. All other cases use an infinite-error fallback.
        if (
          visibleToEveryCamera &&
          Number.isFinite(maxDist) &&
          maxDist <= DEFAULT_RAY_GATE_DISTANCE_M
        ) {
          return { position: intersection, error: maxDist }
        }
      }
    }

    // Fallback: assumed range along each camera ray.
    if (fallbackPositions.length === 0) return null

    const avgPos = new THREE.Vector3()
    for (const pos of fallbackPositions) {
      avgPos.add(pos)
    }
    avgPos.divideScalar(fallbackPositions.length)

    return { position: avgPos, error: Number.POSITIVE_INFINITY }
  }

  /**
   * Get all active tracks
   */
  getActiveTracks(): FusedTrack[] {
    return Array.from(this.tracks.values()).filter((t) => t.state !== 'lost')
  }

  /**
   * Tracks that received at least one accepted detection in the last frame.
   * Coasting predictions deliberately stay out of this set so callers cannot
   * republish them as newly measured observations.
   */
  getLastFrameObservedTracks(): FusedTrack[] {
    return this.activeTracksForOutput().filter((track) =>
      this.lastFrameObservedTrackIds.has(track.id)
    )
  }

  /**
   * Get confirmed tracks only
   */
  getConfirmedTracks(): FusedTrack[] {
    return Array.from(this.tracks.values()).filter((t) => t.state === 'confirmed')
  }

  /**
   * Get high-threat tracks
   */
  getHighThreatTracks(minLevel: ThreatLevel = 3): FusedTrack[] {
    return this.getConfirmedTracks().filter((t) => t.threatLevel >= minLevel)
  }

  /**
   * Clear all tracks
   */
  clearTracks(): void {
    this.tracks.clear()
    this.frameCount = 0
    this.lastExplicitEpoch = -1
    this.lastExplicitFrameId = null
    this.lastMeasurementTimestampMs = null
    this.lastFrameStatus = 'idle'
    this.lastFrameId = null
    this.lastFrameDroppedDetections = 0
    this.lastFrameRejectedDetections = 0
    this.lastFrameDroppedGroups = 0
    this.lastFrameEvictedTracks = 0
    this.lastFrameDroppedCameras = 0
    this.lastFrameRejectedCameras = 0
    this.lastFrameObservedTrackIds.clear()
  }

  /**
   * Get fusion statistics
   */
  getStats(): FusionStats {
    const tracks = Array.from(this.tracks.values())
    return {
      totalTracks: tracks.length,
      confirmedTracks: tracks.filter((t) => t.state === 'confirmed').length,
      tentativeTracks: tracks.filter((t) => t.state === 'tentative').length,
      lostTracks: tracks.filter((t) => t.state === 'lost').length,
      avgFusedConfidence:
        tracks.length > 0
          ? tracks.reduce((sum, t) => sum + t.fusedConfidence, 0) / tracks.length
          : 0, // Safe: division only occurs when length > 0
      multiCameraTracks: tracks.filter((t) => t.contributingCameras.length > 1).length,
      highThreatCount: tracks.filter((t) => t.threatLevel >= 3).length,
      frameCount: this.frameCount,
      lastFrameStatus: this.lastFrameStatus,
      lastFrameId: this.lastFrameId,
      lastFrameDroppedDetections: this.lastFrameDroppedDetections,
      lastFrameRejectedDetections: this.lastFrameRejectedDetections,
      lastFrameDroppedGroups: this.lastFrameDroppedGroups,
      lastFrameEvictedTracks: this.lastFrameEvictedTracks,
      lastFrameDroppedCameras: this.lastFrameDroppedCameras,
      lastFrameRejectedCameras: this.lastFrameRejectedCameras,
    }
  }
}

/**
 * Internal type for correlated detection groups
 */
interface CorrelatedGroup {
  detections: Detection[]
  cameraIds: string[]
  primaryClass: DetectionClass
  maxConfidence: number
}

/**
 * Fusion system statistics
 */
export interface FusionStats {
  totalTracks: number
  confirmedTracks: number
  tentativeTracks: number
  lostTracks: number
  avgFusedConfidence: number
  multiCameraTracks: number
  highThreatCount: number
  frameCount: number
  lastFrameStatus: FusionFrameStatus
  lastFrameId: string | null
  lastFrameDroppedDetections: number
  lastFrameRejectedDetections: number
  lastFrameDroppedGroups: number
  lastFrameEvictedTracks: number
  lastFrameDroppedCameras: number
  lastFrameRejectedCameras: number
}

/**
 * Create a SensorFusion instance with default configuration
 */
export function createSensorFusion(config?: Partial<FusionConfig>): SensorFusion {
  return new SensorFusion(config)
}
