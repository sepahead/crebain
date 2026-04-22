/**
 * Optimized math utilities for real-time drone tracking
 * Focus on avoiding expensive operations (sqrt, trig) where possible
 */

import type { Point, Vector3, Quaternion, Twist } from '../ros/types'

// ─────────────────────────────────────────────────────────────────────────────
// DISTANCE CALCULATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Squared distance between two points
 * Use for comparisons to avoid sqrt overhead
 * O(1), ~3x faster than distance()
 */
export function distanceSquared(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const dz = p2.z - p1.z
  return dx * dx + dy * dy + dz * dz
}

/**
 * Squared distance in XY plane only (ignores altitude)
 */
export function distanceSquared2D(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  return dx * dx + dy * dy
}

/**
 * Full 3D distance (use only when actual value needed)
 */
export function distance(p1: Point, p2: Point): number {
  return Math.sqrt(distanceSquared(p1, p2))
}

/**
 * Horizontal distance (XY plane)
 */
export function distance2D(p1: Point, p2: Point): number {
  return Math.sqrt(distanceSquared2D(p1, p2))
}

// ─────────────────────────────────────────────────────────────────────────────
// VECTOR OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Squared magnitude of a vector
 */
export function magnitudeSquared(v: Vector3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z
}

/**
 * Vector magnitude
 */
export function magnitude(v: Vector3): number {
  return Math.sqrt(magnitudeSquared(v))
}

/**
 * Normalize vector to unit length
 * Returns zero vector if input is zero
 */
export function normalize(v: Vector3): Vector3 {
  const mag = magnitude(v)
  if (mag < 1e-10) {
    return { x: 0, y: 0, z: 0 }
  }
  return {
    x: v.x / mag,
    y: v.y / mag,
    z: v.z / mag,
  }
}

/**
 * Scale vector by scalar
 */
export function scale(v: Vector3, s: number): Vector3 {
  return {
    x: v.x * s,
    y: v.y * s,
    z: v.z * s,
  }
}

/**
 * Add two vectors
 */
export function add(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  }
}

/**
 * Subtract vectors (a - b)
 */
export function subtract(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  }
}

/**
 * Dot product
 */
export function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/**
 * Cross product
 */
export function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

/**
 * Linear interpolation between two vectors
 */
export function lerp(a: Vector3, b: Vector3, t: number): Vector3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  }
}

/**
 * Clamp vector magnitude
 */
export function clampMagnitude(v: Vector3, maxMag: number): Vector3 {
  const magSq = magnitudeSquared(v)
  if (magSq <= maxMag * maxMag) {
    return v
  }
  const mag = Math.sqrt(magSq)
  return scale(v, maxMag / mag)
}

// ─────────────────────────────────────────────────────────────────────────────
// POINT / POSITION OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Offset point by vector
 */
export function offsetPoint(p: Point, v: Vector3): Point {
  return {
    x: p.x + v.x,
    y: p.y + v.y,
    z: p.z + v.z,
  }
}

/**
 * Direction vector from p1 to p2 (normalized)
 */
export function direction(from: Point, to: Point): Vector3 {
  return normalize(subtract(to, from))
}

/**
 * Vector from p1 to p2 (not normalized)
 */
export function vectorBetween(from: Point, to: Point): Vector3 {
  return subtract(to, from)
}

/**
 * Midpoint between two points
 */
export function midpoint(p1: Point, p2: Point): Point {
  return {
    x: (p1.x + p2.x) * 0.5,
    y: (p1.y + p2.y) * 0.5,
    z: (p1.z + p2.z) * 0.5,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VELOCITY / MOTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Speed from twist (magnitude of linear velocity)
 */
export function speedFromTwist(twist: Twist): number {
  return magnitude(twist.linear)
}

/**
 * Squared speed from twist
 */
export function speedSquaredFromTwist(twist: Twist): number {
  return magnitudeSquared(twist.linear)
}

/**
 * Predict position after time delta
 * Linear extrapolation: position + velocity * dt
 */
export function predictPosition(position: Point, velocity: Vector3, dtSeconds: number): Point {
  return {
    x: position.x + velocity.x * dtSeconds,
    y: position.y + velocity.y * dtSeconds,
    z: position.z + velocity.z * dtSeconds,
  }
}

/**
 * Predict position with acceleration
 * position + velocity * dt + 0.5 * acceleration * dt^2
 */
export function predictPositionWithAcceleration(
  position: Point,
  velocity: Vector3,
  acceleration: Vector3,
  dtSeconds: number
): Point {
  const dt2 = dtSeconds * dtSeconds * 0.5
  return {
    x: position.x + velocity.x * dtSeconds + acceleration.x * dt2,
    y: position.y + velocity.y * dtSeconds + acceleration.y * dt2,
    z: position.z + velocity.z * dtSeconds + acceleration.z * dt2,
  }
}

/**
 * Calculate closing speed between two objects
 * Positive = approaching, Negative = separating
 */
export function closingSpeed(
  pos1: Point,
  vel1: Vector3,
  pos2: Point,
  vel2: Vector3
): number {
  // Direction from 1 to 2
  const dir = direction(pos1, pos2)
  // Relative velocity (2 relative to 1)
  const relVel = subtract(vel2, vel1)
  // Negative because closing means moving toward each other
  return -dot(relVel, dir)
}

/**
 * Time to closest approach (TCA)
 * Returns -1 if objects are diverging
 */
export function timeToClosestApproach(
  pos1: Point,
  vel1: Vector3,
  pos2: Point,
  vel2: Vector3
): number {
  const relPos = subtract(pos2, pos1)
  const relVel = subtract(vel2, vel1)
  const velMagSq = magnitudeSquared(relVel)

  if (velMagSq < 1e-10) {
    // Effectively stationary relative to each other
    return 0
  }

  const tca = -dot(relPos, relVel) / velMagSq
  return tca > 0 ? tca : -1
}

/**
 * Distance at closest approach (DCA)
 */
export function distanceAtClosestApproach(
  pos1: Point,
  vel1: Vector3,
  pos2: Point,
  vel2: Vector3
): number {
  const tca = timeToClosestApproach(pos1, vel1, pos2, vel2)
  if (tca < 0) {
    // Diverging, return current distance
    return distance(pos1, pos2)
  }

  const futurePos1 = predictPosition(pos1, vel1, tca)
  const futurePos2 = predictPosition(pos2, vel2, tca)
  return distance(futurePos1, futurePos2)
}

// ─────────────────────────────────────────────────────────────────────────────
// QUATERNION OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identity quaternion
 */
export function identityQuaternion(): Quaternion {
  return { x: 0, y: 0, z: 0, w: 1 }
}

/**
 * Quaternion multiplication (q1 * q2)
 */
export function multiplyQuaternions(q1: Quaternion, q2: Quaternion): Quaternion {
  return {
    w: q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z,
    x: q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
    y: q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
    z: q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,
  }
}

/**
 * Quaternion inverse (conjugate for unit quaternions)
 */
export function inverseQuaternion(q: Quaternion): Quaternion {
  return {
    x: -q.x,
    y: -q.y,
    z: -q.z,
    w: q.w,
  }
}

/**
 * Rotate vector by quaternion
 */
export function rotateVectorByQuaternion(v: Vector3, q: Quaternion): Vector3 {
  // Optimized quaternion-vector rotation
  const qv = { x: q.x, y: q.y, z: q.z }
  const uv = cross(qv, v)
  const uuv = cross(qv, uv)
  return {
    x: v.x + 2 * (q.w * uv.x + uuv.x),
    y: v.y + 2 * (q.w * uv.y + uuv.y),
    z: v.z + 2 * (q.w * uv.z + uuv.z),
  }
}

/**
 * Spherical linear interpolation (SLERP) for quaternions
 */
export function slerpQuaternion(q1: Quaternion, q2: Quaternion, t: number): Quaternion {
  let cosHalfTheta = q1.w * q2.w + q1.x * q2.x + q1.y * q2.y + q1.z * q2.z

  // If q1=q2 or q1=-q2, return q1
  if (Math.abs(cosHalfTheta) >= 1.0) {
    return { ...q1 }
  }

  // Ensure shortest path
  let q2Adj = q2
  if (cosHalfTheta < 0) {
    q2Adj = { x: -q2.x, y: -q2.y, z: -q2.z, w: -q2.w }
    cosHalfTheta = -cosHalfTheta
  }

  const halfTheta = Math.acos(cosHalfTheta)
  const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta)

  // If theta is 180 degrees, result is not fully defined
  if (Math.abs(sinHalfTheta) < 0.001) {
    return {
      w: q1.w * 0.5 + q2Adj.w * 0.5,
      x: q1.x * 0.5 + q2Adj.x * 0.5,
      y: q1.y * 0.5 + q2Adj.y * 0.5,
      z: q1.z * 0.5 + q2Adj.z * 0.5,
    }
  }

  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta

  return {
    w: q1.w * ratioA + q2Adj.w * ratioB,
    x: q1.x * ratioA + q2Adj.x * ratioB,
    y: q1.y * ratioA + q2Adj.y * ratioB,
    z: q1.z * ratioA + q2Adj.z * ratioB,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARISON UTILITIES (for sorting / selection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare two distances without computing sqrt
 * Returns negative if d1 < d2, positive if d1 > d2, 0 if equal
 */
export function compareDistances(
  p1: Point,
  p2: Point,
  ref: Point
): number {
  return distanceSquared(p1, ref) - distanceSquared(p2, ref)
}

/**
 * Find closest point to reference from array
 * Uses squared distance for efficiency
 */
export function findClosest<T extends { position: Point }>(
  items: T[],
  reference: Point
): T | undefined {
  if (items.length === 0) return undefined

  let closest = items[0]
  let minDistSq = distanceSquared(closest.position, reference)

  for (let i = 1; i < items.length; i++) {
    const distSq = distanceSquared(items[i].position, reference)
    if (distSq < minDistSq) {
      minDistSq = distSq
      closest = items[i]
    }
  }

  return closest
}

/**
 * Check if point is within radius of reference
 * Uses squared comparison for efficiency
 */
export function isWithinRadius(point: Point, reference: Point, radius: number): boolean {
  return distanceSquared(point, reference) <= radius * radius
}

/**
 * Check if point is within 2D radius (ignores altitude)
 */
export function isWithinRadius2D(point: Point, reference: Point, radius: number): boolean {
  return distanceSquared2D(point, reference) <= radius * radius
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAMPING & LIMITS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp value to range
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Wrap angle to [-PI, PI]
 */
export function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0
  angle = angle % (2 * Math.PI)
  if (angle > Math.PI) angle -= 2 * Math.PI
  if (angle < -Math.PI) angle += 2 * Math.PI
  return angle
}

/**
 * Smallest angle difference (always positive)
 */
export function angleDifference(a: number, b: number): number {
  let diff = wrapAngle(a - b)
  return Math.abs(diff)
}

/**
 * Signed angle difference (shortest path)
 */
export function signedAngleDifference(from: number, to: number): number {
  return wrapAngle(to - from)
}
