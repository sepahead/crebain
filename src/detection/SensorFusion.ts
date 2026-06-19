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
// Cheirality margin (m): a correspondence whose closest-approach point is clearly
// in FRONT of one camera but BEHIND the other (opposite-sign ray parameters beyond
// this margin) is geometrically inconsistent and rejected. Same-sign approaches are
// accepted — both in front for forward-facing cameras, or both behind for the line-
// intersection convention of uncalibrated FOV-derived rays.
const RAY_CHEIRALITY_MARGIN_M = 0.5
// Range (m) at which the spatial term of the track-match score decays to zero.
const SPATIAL_MATCH_SCALE_M = 15

type Ray = { origin: THREE.Vector3; direction: THREE.Vector3 }

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
 * Sensor Fusion Engine
 *
 * Correlates detections from multiple cameras, manages persistent tracks,
 * triangulates 3D positions, and provides fused confidence scores.
 */
export class SensorFusion {
  private tracks: Map<string, FusedTrack> = new Map()
  private config: FusionConfig
  private frameCount = 0

  constructor(config: Partial<FusionConfig> = {}) {
    this.config = { ...DEFAULT_FUSION_CONFIG, ...config }
  }

  /**
   * Process detections from all cameras for a single frame
   */
  processFrame(
    detections: Map<string, Detection[]>,
    cameras: Map<string, CameraParams>
  ): FusedTrack[] {
    this.frameCount++
    const currentTime = Date.now()

    // Step 1: Correlate detections across cameras
    const correlatedGroups = this.correlateDetections(detections, cameras)

    // Step 2: Match to existing tracks or create new ones
    const matchedTrackIds = new Set<string>()

    for (const group of correlatedGroups) {
      const matchedTrack = this.matchToTrack(group, cameras)

      if (matchedTrack) {
        // Update existing track
        this.updateTrack(matchedTrack, group, cameras, currentTime)
        matchedTrackIds.add(matchedTrack.id)
      } else {
        // Create new track
        const newTrack = this.createTrack(group, cameras, currentTime)
        this.tracks.set(newTrack.id, newTrack)
        matchedTrackIds.add(newTrack.id)
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

    // Step 5: Return active tracks
    return Array.from(this.tracks.values())
      .filter((t) => t.state !== 'lost')
      .sort((a, b) => b.threatLevel - a.threatLevel)
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
    const usedDetections = new Set<string>()

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
      if (usedDetections.has(det1.id)) continue

      const group: CorrelatedGroup = {
        detections: [det1],
        cameraIds: [cam1],
        primaryClass: det1.class,
        maxConfidence: det1.confidence,
      }
      usedDetections.add(det1.id)

      // Find correlating detections from other cameras
      for (let j = i + 1; j < allDetections.length; j++) {
        const { det: det2, cameraId: cam2 } = allDetections[j]
        if (usedDetections.has(det2.id)) continue
        if (cam2 === cam1) continue // Same camera as the seed
        // Skip a camera already represented in this group: two detections from
        // one camera would contribute two rays sharing an origin, biasing the
        // least-squares triangulation toward that camera.
        if (group.cameraIds.includes(cam2)) continue

        // Check if detections correlate
        if (this.detectionsCorrelate(det1, cam1, det2, cam2, cameras)) {
          group.detections.push(det2)
          group.cameraIds.push(cam2)
          group.maxConfidence = Math.max(group.maxConfidence, det2.confidence)
          usedDetections.add(det2.id)
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
    // approach within DEFAULT_RAY_GATE_DISTANCE_M) and meet in front of both cameras
    // (cheirality). Without this, two different same-class targets seen by two
    // cameras correlate into one phantom triangulation. Only applied when the
    // geometry is available; otherwise fall back to the class/temporal heuristic.
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
    const front1 = t1 > RAY_CHEIRALITY_MARGIN_M
    const front2 = t2 > RAY_CHEIRALITY_MARGIN_M
    const behind1 = t1 < -RAY_CHEIRALITY_MARGIN_M
    const behind2 = t2 < -RAY_CHEIRALITY_MARGIN_M
    if ((front1 && behind2) || (front2 && behind1)) return false

    return true
  }

  /**
   * Match a correlated group to an existing track
   */
  private matchToTrack(
    group: CorrelatedGroup,
    cameras: Map<string, CameraParams>
  ): FusedTrack | null {
    const groupPos = this.computeGroupPosition(group, cameras)
    let bestMatch: FusedTrack | null = null
    let bestScore = 0

    for (const track of this.tracks.values()) {
      if (track.state === 'lost') continue

      // Check class match
      if (track.class !== group.primaryClass) continue

      // Match score: class + camera overlap + confidence + 3D proximity
      const score = this.calculateMatchScore(track, group, groupPos)

      if (score > this.config.correlationThreshold && score > bestScore) {
        bestMatch = track
        bestScore = score
      }
    }

    return bestMatch
  }

  /**
   * Calculate match score between track and detection group
   */
  private calculateMatchScore(
    track: FusedTrack,
    group: CorrelatedGroup,
    groupPos: THREE.Vector3 | null
  ): number {
    // Base score from class match (already checked). Kept at 0.5 so a same-class
    // continuation with similar confidence clears the default correlationThreshold
    // (0.5) even when far/geometry-less — the 3D-proximity term is an additive
    // *preference* among candidates, never a penalty that breaks continuation.
    let score = 0.5

    // Boost for overlapping camera sources
    const sharedCameras = track.contributingCameras.filter((c) => group.cameraIds.includes(c))
    score +=
      (sharedCameras.length / Math.max(track.contributingCameras.length, group.cameraIds.length)) *
      0.1

    // Boost for similar confidence
    const confDiff = Math.abs(track.confidence - group.maxConfidence)
    score += (1 - confDiff) * 0.2

    // Boost for 3D proximity: prefer the track nearest the group's triangulated
    // position, decaying to 0 at SPATIAL_MATCH_SCALE_M. When geometry is unavailable
    // (single camera / no frame dims) fall back to a neutral mid-weight. This
    // re-ranks candidate tracks by position; it does not gate matching by itself.
    if (groupPos) {
      const dist = groupPos.distanceTo(track.triangulatedPosition)
      score += Math.max(0, 1 - dist / SPATIAL_MATCH_SCALE_M) * 0.2
    } else {
      score += 0.1
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
      }
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
      return ray.origin
        .clone()
        .add(ray.direction.clone().multiplyScalar(DEFAULT_ASSUMED_TARGET_RANGE_M))
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
   *   fixed range along each ray and averages those points.
   *
   * For best results, populate camera intrinsics/extrinsics and use calibrated
   * projection instead of FOV-based approximation.
   */
  private triangulatePosition(
    group: CorrelatedGroup,
    cameras: Map<string, CameraParams>
  ): { position: THREE.Vector3; error: number } | null {
    const rays: Ray[] = []
    const fallbackPositions: THREE.Vector3[] = []
    const assumedRangeM = DEFAULT_ASSUMED_TARGET_RANGE_M

    const count = Math.min(group.cameraIds.length, group.detections.length)
    for (let i = 0; i < count; i++) {
      const camera = cameras.get(group.cameraIds[i])
      if (!camera) continue

      const detection = group.detections[i]
      const ray = rayFromDetection(camera, detection)
      rays.push(ray)
      fallbackPositions.push(
        ray.origin.clone().add(ray.direction.clone().multiplyScalar(assumedRangeM))
      )
    }

    if (rays.length === 0) return null

    if (rays.length >= 2) {
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
        for (const { origin, direction } of rays) {
          const v = intersection.clone().sub(origin)
          const dist = v.clone().cross(direction).length()
          maxDist = Math.max(maxDist, dist)
        }

        // If rays are near-parallel, the least-squares system becomes ill-conditioned.
        // Fall back to the assumed-range estimate when error explodes.
        if (Number.isFinite(maxDist) && maxDist <= assumedRangeM * 2) {
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

    let maxDist = 0
    for (const pos of fallbackPositions) {
      maxDist = Math.max(maxDist, pos.distanceTo(avgPos))
    }

    return { position: avgPos, error: maxDist }
  }

  /**
   * Get all active tracks
   */
  getActiveTracks(): FusedTrack[] {
    return Array.from(this.tracks.values()).filter((t) => t.state !== 'lost')
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
}

/**
 * Create a SensorFusion instance with default configuration
 */
export function createSensorFusion(config?: Partial<FusionConfig>): SensorFusion {
  return new SensorFusion(config)
}
