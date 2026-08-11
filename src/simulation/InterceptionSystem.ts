/**
 * CREBAIN Interception System
 * Adaptive Response & Awareness System (ARAS)
 *
 * Intercept trajectory calculation and mission management
 * Optimized with squared distance comparisons to avoid sqrt overhead
 */

import type { Point, Vector3 } from '../ros/types'
import {
  distanceSquared,
  magnitude,
  magnitudeSquared,
  normalize,
  scale,
  subtract,
  dot,
  clampMagnitude,
  predictPosition,
} from '../lib/mathUtils'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type InterceptionStrategy = 'PURSUIT' | 'LEAD' | 'PARALLEL' | 'AMBUSH'
export type MissionStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'ABORTED' | 'FAILED'

export interface InterceptorConfig {
  maxSpeed: number // m/s
  maxAcceleration: number // m/s²
  maxTurnRate: number // rad/s
  engagementRadius: number // meters - distance at which target is considered intercepted
  safetyMargin: number // meters - minimum safe distance
}

export interface Target {
  id: string
  position: Point
  velocity: Vector3
  lastUpdate: number
}

export interface Interceptor {
  id: string
  position: Point
  velocity: Vector3
  config: InterceptorConfig
  currentMission: InterceptionMission | null
}

export interface InterceptionMission {
  id: string
  targetId: string
  interceptorId: string
  strategy: InterceptionStrategy
  status: MissionStatus
  startTime: number
  interceptPoint: Point | null
  timeToIntercept: number | null // seconds
  lastUpdate: number
}

interface InterceptionResultBase {
  interceptPoint: Point
  interceptorVelocity: Vector3
  strategy: InterceptionStrategy
}

export type InterceptionResult =
  | (InterceptionResultBase & {
      isPossible: true
      timeToIntercept: number // seconds
      reason?: never
    })
  | (InterceptionResultBase & {
      isPossible: false
      timeToIntercept: null
      reason: string
    })

export interface TrajectoryPoint {
  position: Point
  velocity: Vector3
  time: number // seconds from now
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_INTERCEPTOR_CONFIG: InterceptorConfig = {
  maxSpeed: 20, // 20 m/s (~72 km/h)
  maxAcceleration: 5, // 5 m/s²
  maxTurnRate: Math.PI, // 180°/s
  engagementRadius: 5, // 5 meters
  safetyMargin: 2, // 2 meters
}

// Pre-computed squared values for fast comparison
const SPEED_THRESHOLD_SQ = 0.01 // 0.1² for stationary detection
const MIN_LATERAL_SPEED_SQ = 0.01 // 0.1² minimum lateral speed

// Below this separation (meters) the interceptor is effectively on target;
// guards divisions by the interceptor-to-target distance.
const MIN_INTERCEPT_DISTANCE = 0.001
const QUADRATIC_ROUNDING_FACTOR = 16 * Number.EPSILON

/**
 * Hard allocation bound for predictive trajectories. Invalid requests fail
 * closed with an empty trajectory instead of returning a silently truncated
 * time horizon.
 */
export const MAX_TRAJECTORY_POINTS = 10_000
export const MAX_INTERCEPTION_TARGETS = 1_024
export const MAX_INTERCEPTION_INTERCEPTORS = 1_024
export const MAX_INTERCEPTION_MISSIONS = 4_096
const MAX_INTERCEPTION_ID_BYTES = 128
const MAX_KINEMATIC_COMPONENT = 1_000_000_000
const MAX_INTERCEPTOR_SPEED = 1_000
const MAX_INTERCEPTOR_ACCELERATION = 1_000
const MAX_INTERCEPTOR_TURN_RATE = 100 * Math.PI
const MAX_INTERCEPTOR_DISTANCE = 1_000_000
const INTERCEPTION_TEXT_ENCODER = new TextEncoder()

function validatedId(id: string, name: string): string {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.trim() !== id ||
    INTERCEPTION_TEXT_ENCODER.encode(id).byteLength > MAX_INTERCEPTION_ID_BYTES ||
    Array.from(id).some((character) => {
      const codePoint = character.codePointAt(0)
      return (
        codePoint === undefined || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      )
    })
  ) {
    throw new Error(`${name} must be a bounded, non-empty identity without control characters`)
  }
  return id
}

function snapshotVector(value: Vector3, name: string): Vector3 {
  if (
    typeof value !== 'object' ||
    value === null ||
    ![value.x, value.y, value.z].every(
      (component) => Number.isFinite(component) && Math.abs(component) <= MAX_KINEMATIC_COMPONENT
    )
  ) {
    throw new Error(`${name} must contain finite, bounded coordinates`)
  }
  return { x: value.x, y: value.y, z: value.z }
}

/** Extrapolate only inside the finite state envelope accepted by this system. */
function predictBoundedPosition(
  position: Point,
  velocity: Vector3,
  deltaTimeSeconds: number
): Point | null {
  if (!Number.isFinite(deltaTimeSeconds) || deltaTimeSeconds < 0) return null
  const predicted = predictPosition(position, velocity, deltaTimeSeconds)
  return [predicted.x, predicted.y, predicted.z].every(
    (component) => Number.isFinite(component) && Math.abs(component) <= MAX_KINEMATIC_COMPONENT
  )
    ? predicted
    : null
}

function boundedPositive(value: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be finite and within (0, ${maximum}]`)
  }
  return value
}

function boundedNonNegative(value: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be finite and within [0, ${maximum}]`)
  }
  return value
}

/**
 * Return the earliest non-negative solution to a*t^2 + b*t + c = 0.
 *
 * The conventional quadratic formula loses precision when `b` and the square
 * root have similar magnitudes. The `q` formulation keeps one root stable and
 * obtains the other from the product of the roots. A scale-aware tolerance
 * treats only floating-point roundoff as a zero coefficient or discriminant.
 */
function earliestNonNegativeQuadraticRoot(
  a: number,
  b: number,
  c: number,
  aTolerance = 0
): number | null {
  if (![a, b, c].every(Number.isFinite)) return null

  if (Math.abs(a) <= aTolerance) {
    if (b === 0) {
      return c === 0 ? 0 : null
    }
    const root = -c / b
    return Number.isFinite(root) && root >= 0 ? root : null
  }

  const bSquared = b * b
  const fourAC = 4 * a * c
  const discriminantScale = Math.max(bSquared, Math.abs(fourAC), 1)
  let discriminant = bSquared - fourAC
  if (discriminant < 0 && discriminant >= -QUADRATIC_ROUNDING_FACTOR * discriminantScale) {
    discriminant = 0
  }
  if (!Number.isFinite(discriminant) || discriminant < 0) return null

  const squareRoot = Math.sqrt(discriminant)
  const q = -0.5 * (b + (b >= 0 ? squareRoot : -squareRoot))
  const candidates = q === 0 ? [-b / (2 * a)] : [q / a, c / q]
  let earliest = Number.POSITIVE_INFINITY
  for (const root of candidates) {
    if (Number.isFinite(root) && root >= 0 && root < earliest) earliest = root
  }
  return Number.isFinite(earliest) ? earliest : null
}

function validatedInterceptorConfig(config: Partial<InterceptorConfig>): InterceptorConfig {
  const candidate = { ...DEFAULT_INTERCEPTOR_CONFIG, ...config }
  return {
    maxSpeed: boundedPositive(candidate.maxSpeed, MAX_INTERCEPTOR_SPEED, 'Interceptor maxSpeed'),
    maxAcceleration: boundedPositive(
      candidate.maxAcceleration,
      MAX_INTERCEPTOR_ACCELERATION,
      'Interceptor maxAcceleration'
    ),
    maxTurnRate: boundedPositive(
      candidate.maxTurnRate,
      MAX_INTERCEPTOR_TURN_RATE,
      'Interceptor maxTurnRate'
    ),
    engagementRadius: boundedPositive(
      candidate.engagementRadius,
      MAX_INTERCEPTOR_DISTANCE,
      'Interceptor engagementRadius'
    ),
    safetyMargin: boundedNonNegative(
      candidate.safetyMargin,
      MAX_INTERCEPTOR_DISTANCE,
      'Interceptor safetyMargin'
    ),
  }
}

function snapshotMission(mission: InterceptionMission): InterceptionMission {
  return {
    ...mission,
    interceptPoint: mission.interceptPoint ? { ...mission.interceptPoint } : null,
  }
}

function snapshotTarget(target: Target): Target {
  return {
    ...target,
    position: { ...target.position },
    velocity: { ...target.velocity },
  }
}

function snapshotInterceptor(interceptor: Interceptor): Interceptor {
  return {
    ...interceptor,
    position: { ...interceptor.position },
    velocity: { ...interceptor.velocity },
    config: { ...interceptor.config },
    currentMission: interceptor.currentMission ? snapshotMission(interceptor.currentMission) : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERCEPTION SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

export class InterceptionSystem {
  private targets: Map<string, Target> = new Map()
  private interceptors: Map<string, Interceptor> = new Map()
  private missions: Map<string, InterceptionMission> = new Map()
  private missionIdCounter = 0

  constructor() {}

  // ───────────────────────────────────────────────────────────────────────────
  // TARGET MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  updateTarget(id: string, position: Point, velocity: Vector3): void {
    const targetId = validatedId(id, 'Target ID')
    const nextPosition = snapshotVector(position, 'Target position')
    const nextVelocity = snapshotVector(velocity, 'Target velocity')
    if (!this.targets.has(targetId) && this.targets.size >= MAX_INTERCEPTION_TARGETS) {
      throw new Error(`Interception target limit of ${MAX_INTERCEPTION_TARGETS} exceeded`)
    }
    this.targets.set(targetId, {
      id: targetId,
      position: nextPosition,
      velocity: nextVelocity,
      lastUpdate: Date.now(),
    })
  }

  removeTarget(id: string): void {
    validatedId(id, 'Target ID')
    this.targets.delete(id)
    // Abort every nonterminal mission targeting the removed target. PENDING
    // missions already reserve their interceptor in createMission(), so limiting
    // cleanup to ACTIVE missions strands that interceptor indefinitely.
    for (const mission of this.missions.values()) {
      const terminal =
        mission.status === 'COMPLETED' ||
        mission.status === 'ABORTED' ||
        mission.status === 'FAILED'
      if (mission.targetId !== id || terminal) continue

      mission.status = 'ABORTED'
      mission.lastUpdate = Date.now()
      const interceptor = this.interceptors.get(mission.interceptorId)
      if (interceptor?.currentMission?.id === mission.id) {
        interceptor.currentMission = null
      }
    }
  }

  getTarget(id: string): Target | undefined {
    const target = this.targets.get(id)
    return target ? snapshotTarget(target) : undefined
  }

  getAllTargets(): Target[] {
    return Array.from(this.targets.values(), snapshotTarget)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INTERCEPTOR MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  registerInterceptor(
    id: string,
    position: Point,
    velocity: Vector3,
    config: Partial<InterceptorConfig> = {}
  ): void {
    const interceptorId = validatedId(id, 'Interceptor ID')
    const nextPosition = snapshotVector(position, 'Interceptor position')
    const nextVelocity = snapshotVector(velocity, 'Interceptor velocity')
    const nextConfig = validatedInterceptorConfig(config)
    const existing = this.interceptors.get(interceptorId)
    if (existing) {
      existing.position = nextPosition
      existing.velocity = nextVelocity
      existing.config = nextConfig
      return
    }
    if (this.interceptors.size >= MAX_INTERCEPTION_INTERCEPTORS) {
      throw new Error(`Interception interceptor limit of ${MAX_INTERCEPTION_INTERCEPTORS} exceeded`)
    }
    this.interceptors.set(interceptorId, {
      id: interceptorId,
      position: nextPosition,
      velocity: nextVelocity,
      config: nextConfig,
      currentMission: null,
    })
  }

  updateInterceptor(id: string, position: Point, velocity: Vector3): void {
    validatedId(id, 'Interceptor ID')
    const nextPosition = snapshotVector(position, 'Interceptor position')
    const nextVelocity = snapshotVector(velocity, 'Interceptor velocity')
    const interceptor = this.interceptors.get(id)
    if (interceptor) {
      interceptor.position = nextPosition
      interceptor.velocity = nextVelocity
    }
  }

  removeInterceptor(id: string): void {
    validatedId(id, 'Interceptor ID')
    const interceptor = this.interceptors.get(id)
    if (interceptor?.currentMission) {
      interceptor.currentMission.status = 'ABORTED'
      interceptor.currentMission.lastUpdate = Date.now()
    }
    this.interceptors.delete(id)
  }

  getInterceptor(id: string): Interceptor | undefined {
    const interceptor = this.interceptors.get(id)
    return interceptor ? snapshotInterceptor(interceptor) : undefined
  }

  getAvailableInterceptors(): Interceptor[] {
    return Array.from(this.interceptors.values())
      .filter((interceptor) => !interceptor.currentMission)
      .map(snapshotInterceptor)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TRAJECTORY PREDICTION
  // ───────────────────────────────────────────────────────────────────────────

  predictTargetPosition(targetId: string, deltaTimeSeconds: number): Point | null {
    const target = this.targets.get(targetId)
    if (!target) return null
    return predictBoundedPosition(target.position, target.velocity, deltaTimeSeconds)
  }

  predictTargetTrajectory(
    targetId: string,
    durationSeconds: number,
    stepSeconds: number = 0.5
  ): TrajectoryPoint[] {
    const target = this.targets.get(targetId)
    if (!target) return []

    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      !Number.isFinite(stepSeconds) ||
      stepSeconds <= 0
    ) {
      return []
    }

    const trajectory: TrajectoryPoint[] = []
    const intervalCount = Math.ceil(durationSeconds / stepSeconds)
    if (
      !Number.isSafeInteger(intervalCount) ||
      intervalCount < 1 ||
      intervalCount >= MAX_TRAJECTORY_POINTS
    ) {
      return []
    }
    const numSteps = intervalCount + 1

    for (let i = 0; i < numSteps; i++) {
      const t = Math.min(i * stepSeconds, durationSeconds)
      const position = predictBoundedPosition(target.position, target.velocity, t)
      if (!position) return []
      trajectory.push({
        position,
        velocity: { ...target.velocity },
        time: t,
      })
    }
    return trajectory
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INTERCEPTION CALCULATION
  // ───────────────────────────────────────────────────────────────────────────

  calculateIntercept(
    interceptorId: string,
    targetId: string,
    strategy: InterceptionStrategy = 'LEAD'
  ): InterceptionResult {
    const interceptor = this.interceptors.get(interceptorId)
    const target = this.targets.get(targetId)

    if (!interceptor) {
      return {
        interceptPoint: { x: 0, y: 0, z: 0 },
        timeToIntercept: null,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy,
        isPossible: false,
        reason: 'Interceptor not found',
      }
    }

    if (!target) {
      return {
        interceptPoint: { x: 0, y: 0, z: 0 },
        timeToIntercept: null,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy,
        isPossible: false,
        reason: 'Target not found',
      }
    }

    switch (strategy) {
      case 'PURSUIT':
        return this.calculatePursuitIntercept(interceptor, target)
      case 'LEAD':
        return this.calculateLeadIntercept(interceptor, target)
      case 'PARALLEL':
        return this.calculateParallelIntercept(interceptor, target)
      case 'AMBUSH':
        return this.calculateAmbushIntercept(interceptor, target)
      default:
        return this.calculateLeadIntercept(interceptor, target)
    }
  }

  /**
   * PURSUIT - Follow directly behind target (tail chase)
   * Optimized with vector utilities
   */
  private calculatePursuitIntercept(interceptor: Interceptor, target: Target): InterceptionResult {
    const toTarget = subtract(target.position, interceptor.position)
    const dir = normalize(toTarget)
    const interceptorVelocity = scale(dir, interceptor.config.maxSpeed)

    const dist = magnitude(toTarget)
    const closingSpeed = this.calculateClosingSpeed(interceptor, target, dir)

    if (closingSpeed <= 0) {
      return {
        interceptPoint: { ...target.position },
        timeToIntercept: null,
        interceptorVelocity,
        strategy: 'PURSUIT',
        isPossible: false,
        reason: 'Target is faster - cannot catch',
      }
    }

    const timeToIntercept = dist / closingSpeed
    const interceptPoint = predictBoundedPosition(target.position, target.velocity, timeToIntercept)
    if (!Number.isFinite(timeToIntercept) || !interceptPoint) {
      return {
        interceptPoint: { ...target.position },
        timeToIntercept: null,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy: 'PURSUIT',
        isPossible: false,
        reason: 'Pursuit intercept exceeds the finite prediction envelope',
      }
    }

    return {
      interceptPoint,
      timeToIntercept,
      interceptorVelocity,
      strategy: 'PURSUIT',
      isPossible: true,
    }
  }

  /** LEAD - Aim at the exact constant-velocity interception point. */
  private calculateLeadIntercept(interceptor: Interceptor, target: Target): InterceptionResult {
    const maxSpeed = interceptor.config.maxSpeed
    const relativePosition = subtract(target.position, interceptor.position)
    const distanceSq = magnitudeSquared(relativePosition)
    if (distanceSq < MIN_INTERCEPT_DISTANCE * MIN_INTERCEPT_DISTANCE) {
      return {
        interceptPoint: { ...target.position },
        timeToIntercept: 0,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy: 'LEAD',
        isPossible: true,
      }
    }

    // |relativePosition + target.velocity*t| = maxSpeed*t
    const targetSpeedSq = magnitudeSquared(target.velocity)
    const maxSpeedSq = maxSpeed * maxSpeed
    const a = targetSpeedSq - maxSpeedSq
    const b = 2 * dot(relativePosition, target.velocity)
    const aTolerance = QUADRATIC_ROUNDING_FACTOR * Math.max(targetSpeedSq, maxSpeedSq, 1)
    const timeToIntercept = earliestNonNegativeQuadraticRoot(a, b, distanceSq, aTolerance)
    const interceptPoint =
      timeToIntercept === null
        ? null
        : predictBoundedPosition(target.position, target.velocity, timeToIntercept)
    if (timeToIntercept === null || !interceptPoint) {
      return {
        interceptPoint: { ...target.position },
        timeToIntercept: null,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy: 'LEAD',
        isPossible: false,
        reason: 'No lead intercept exists inside the finite prediction envelope',
      }
    }

    const displacement = subtract(interceptPoint, interceptor.position)
    const interceptorVelocity = clampMagnitude(scale(displacement, 1 / timeToIntercept), maxSpeed)
    if (!Object.values(interceptorVelocity).every(Number.isFinite)) {
      return {
        interceptPoint: { ...target.position },
        timeToIntercept: null,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy: 'LEAD',
        isPossible: false,
        reason: 'Lead guidance exceeds the finite prediction envelope',
      }
    }

    return {
      interceptPoint,
      timeToIntercept,
      interceptorVelocity,
      strategy: 'LEAD',
      isPossible: true,
    }
  }

  /**
   * PARALLEL - Match target velocity and approach from the side
   * Optimized with squared comparisons
   */
  private calculateParallelIntercept(interceptor: Interceptor, target: Target): InterceptionResult {
    const targetSpeedSq = magnitudeSquared(target.velocity)

    if (targetSpeedSq < SPEED_THRESHOLD_SQ) {
      // Target stationary - use direct pursuit
      return this.calculatePursuitIntercept(interceptor, target)
    }

    const targetSpeed = Math.sqrt(targetSpeedSq)
    const targetDir = normalize(target.velocity)
    const toTarget = subtract(target.position, interceptor.position)

    // Side direction = the component of the line-of-sight that is PERPENDICULAR
    // to the target's heading. Using this (rather than the raw line-of-sight)
    // keeps the lateral component orthogonal to the forward velocity-matching
    // component, so the combined speed is exactly maxSpeed. If the target moves
    // almost directly along the line of sight there is no well-defined side, so
    // fall back to a lead intercept.
    const losAlongHeading = dot(toTarget, targetDir)
    const sidePerp = subtract(toTarget, scale(targetDir, losAlongHeading))
    const sidePerpMagSq = magnitudeSquared(sidePerp)

    if (sidePerpMagSq < 0.000001) {
      // 0.001²
      return this.calculateLeadIntercept(interceptor, target)
    }

    // Approach from the side while matching forward velocity
    const maxSpeedSq = interceptor.config.maxSpeed * interceptor.config.maxSpeed
    const lateralSpeedSq = Math.max(0, maxSpeedSq - targetSpeedSq)

    if (lateralSpeedSq < MIN_LATERAL_SPEED_SQ) {
      return {
        interceptPoint: { ...target.position },
        timeToIntercept: null,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy: 'PARALLEL',
        isPossible: false,
        reason: 'Target too fast for parallel intercept',
      }
    }

    // Close BOTH gap components. Matching the target's forward speed exactly
    // would leave the along-track gap constant forever (missions hang ACTIVE),
    // so the forward component must also include an along-track closing term.
    // Solve for the intercept time T at which flying at exactly maxSpeed
    // closes the along-track gap (gPar) and the perpendicular gap (gPerp)
    // simultaneously:
    //   (targetSpeed + gPar/T)² + (gPerp/T)² = maxSpeed²
    // which rearranges to a·T² − b·T − c = 0 with the positive root below.
    // a = lateralSpeedSq > 0 (checked above) and c ≥ gPerp² > 0 (checked
    // above), so the discriminant is positive and T > 0.
    const gPar = losAlongHeading
    const gPerp = Math.sqrt(sidePerpMagSq)
    const a = lateralSpeedSq // maxSpeed² − targetSpeed²
    const b = 2 * targetSpeed * gPar
    const c = gPar * gPar + gPerp * gPerp
    const discriminantRoot = Math.sqrt(b * b + 4 * a * c)
    const timeToIntercept =
      b >= 0 ? (b + discriminantRoot) / (2 * a) : (2 * c) / (discriminantRoot - b)
    const interceptPoint = predictBoundedPosition(target.position, target.velocity, timeToIntercept)
    if (!Number.isFinite(timeToIntercept) || timeToIntercept <= 0 || !interceptPoint) {
      return {
        interceptPoint: { ...target.position },
        timeToIntercept: null,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy: 'PARALLEL',
        isPossible: false,
        reason: 'Parallel intercept exceeds the finite prediction envelope',
      }
    }

    const alongSpeed = targetSpeed + gPar / timeToIntercept
    const lateralSpeed = gPerp / timeToIntercept
    const sideDir = normalize(sidePerp)

    // Forward (matches the target plus along-track closure) + lateral (closes
    // the perpendicular gap). The two components are orthogonal and sized so
    // |v| == maxSpeed by construction; clamp as a numerical safety net so
    // PARALLEL never commands above maxSpeed.
    const interceptorVelocity = clampMagnitude(
      {
        x: targetDir.x * alongSpeed + sideDir.x * lateralSpeed,
        y: targetDir.y * alongSpeed + sideDir.y * lateralSpeed,
        z: targetDir.z * alongSpeed + sideDir.z * lateralSpeed,
      },
      interceptor.config.maxSpeed
    )

    return {
      interceptPoint,
      timeToIntercept,
      interceptorVelocity,
      strategy: 'PARALLEL',
      isPossible: true,
    }
  }

  /**
   * AMBUSH - Position ahead of target's path and wait
   * Optimized with squared distance for travel time check
   */
  private calculateAmbushIntercept(interceptor: Interceptor, target: Target): InterceptionResult {
    const targetSpeedSq = magnitudeSquared(target.velocity)

    if (targetSpeedSq < SPEED_THRESHOLD_SQ) {
      // Target stationary - can't ambush
      return this.calculatePursuitIntercept(interceptor, target)
    }

    const maxSpeed = interceptor.config.maxSpeed
    const maxSpeedSq = maxSpeed * maxSpeed

    // Binary search for optimal ambush point
    let minTime = 0
    let maxTime = 60 // 60 seconds max
    let bestPoint: Point | null = null
    let bestTime: number | null = null

    for (let i = 0; i < 20; i++) {
      const midTime = (minTime + maxTime) / 2
      const predicted = predictBoundedPosition(target.position, target.velocity, midTime)
      if (!predicted) {
        maxTime = midTime
        continue
      }

      // Use squared distance for comparison
      const distSq = distanceSquared(interceptor.position, predicted)
      const travelTimeSq = distSq / maxSpeedSq

      if (travelTimeSq < midTime * midTime) {
        // Interceptor can arrive before target
        bestPoint = predicted
        bestTime = midTime
        maxTime = midTime
      } else {
        minTime = midTime
      }
    }

    if (bestPoint && bestTime !== null) {
      const toPoint = subtract(bestPoint, interceptor.position)
      const dir = normalize(toPoint)

      return {
        interceptPoint: bestPoint,
        timeToIntercept: bestTime,
        interceptorVelocity: scale(dir, maxSpeed),
        strategy: 'AMBUSH',
        isPossible: true,
      }
    }

    return {
      interceptPoint: { ...target.position },
      timeToIntercept: null,
      interceptorVelocity: { x: 0, y: 0, z: 0 },
      strategy: 'AMBUSH',
      isPossible: false,
      reason: 'Cannot reach any point ahead of target',
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MISSION MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  createMission(
    interceptorId: string,
    targetId: string,
    strategy: InterceptionStrategy = 'LEAD'
  ): InterceptionMission | null {
    const interceptor = this.interceptors.get(interceptorId)
    const target = this.targets.get(targetId)

    if (!interceptor || !target) return null
    if (interceptor.currentMission) return null // Already on a mission

    const result = this.calculateIntercept(interceptorId, targetId, strategy)
    if (!result.isPossible) return null
    if (!this.reserveMissionHistorySlot()) return null

    const mission: InterceptionMission = {
      id: `mission_${++this.missionIdCounter}`,
      targetId,
      interceptorId,
      strategy,
      status: 'PENDING',
      startTime: Date.now(),
      interceptPoint: result.interceptPoint,
      timeToIntercept: result.timeToIntercept,
      lastUpdate: Date.now(),
    }

    this.missions.set(mission.id, mission)
    interceptor.currentMission = mission

    return snapshotMission(mission)
  }

  activateMission(missionId: string): boolean {
    const mission = this.missions.get(missionId)
    if (!mission || mission.status !== 'PENDING') return false

    mission.status = 'ACTIVE'
    mission.lastUpdate = Date.now()
    return true
  }

  updateMission(missionId: string): InterceptionMission | null {
    const mission = this.missions.get(missionId)
    if (!mission || mission.status !== 'ACTIVE') return null

    const interceptor = this.interceptors.get(mission.interceptorId)
    const target = this.targets.get(mission.targetId)

    if (!interceptor || !target) {
      mission.status = 'FAILED'
      mission.lastUpdate = Date.now()
      if (interceptor?.currentMission?.id === mission.id) interceptor.currentMission = null
      return snapshotMission(mission)
    }

    // Check if target is intercepted using squared distance
    const completionRadius = Math.max(
      interceptor.config.engagementRadius,
      interceptor.config.safetyMargin
    )
    const engagementRadiusSq = completionRadius * completionRadius
    const distSq = distanceSquared(interceptor.position, target.position)

    if (distSq <= engagementRadiusSq) {
      mission.status = 'COMPLETED'
      mission.lastUpdate = Date.now()
      interceptor.currentMission = null
      return snapshotMission(mission)
    }

    // Recalculate intercept
    const result = this.calculateIntercept(
      mission.interceptorId,
      mission.targetId,
      mission.strategy
    )
    mission.interceptPoint = result.interceptPoint
    mission.timeToIntercept = result.timeToIntercept
    mission.lastUpdate = Date.now()

    if (!result.isPossible) {
      mission.status = 'FAILED'
      interceptor.currentMission = null
    }

    return snapshotMission(mission)
  }

  abortMission(missionId: string): boolean {
    const mission = this.missions.get(missionId)
    if (
      !mission ||
      mission.status === 'COMPLETED' ||
      mission.status === 'ABORTED' ||
      mission.status === 'FAILED'
    ) {
      return false
    }

    mission.status = 'ABORTED'
    mission.lastUpdate = Date.now()

    const interceptor = this.interceptors.get(mission.interceptorId)
    if (interceptor?.currentMission?.id === mission.id) {
      interceptor.currentMission = null
    }

    return true
  }

  abortAllMissions(): number {
    let aborted = 0
    for (const mission of this.missions.values()) {
      if (mission.status !== 'PENDING' && mission.status !== 'ACTIVE') continue
      if (this.abortMission(mission.id)) aborted += 1
    }
    return aborted
  }

  getMission(missionId: string): InterceptionMission | undefined {
    const mission = this.missions.get(missionId)
    return mission ? snapshotMission(mission) : undefined
  }

  getActiveMissions(): InterceptionMission[] {
    return Array.from(this.missions.values())
      .filter((mission) => mission.status === 'ACTIVE')
      .map(snapshotMission)
  }

  private reserveMissionHistorySlot(): boolean {
    if (this.missions.size < MAX_INTERCEPTION_MISSIONS) return true
    for (const [missionId, mission] of this.missions) {
      if (
        mission.status === 'COMPLETED' ||
        mission.status === 'ABORTED' ||
        mission.status === 'FAILED'
      ) {
        this.missions.delete(missionId)
        return true
      }
    }
    return false
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GUIDANCE
  // ───────────────────────────────────────────────────────────────────────────

  getGuidanceCommand(interceptorId: string): Vector3 | null {
    const interceptor = this.interceptors.get(interceptorId)
    if (!interceptor?.currentMission) return null

    const mission = interceptor.currentMission
    if (mission.status !== 'ACTIVE') return null

    const result = this.calculateIntercept(interceptorId, mission.targetId, mission.strategy)
    if (!result.isPossible) return null

    return result.interceptorVelocity
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HELPER METHODS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Calculate closing speed between interceptor and target
   * Uses dot product for efficiency
   */
  private calculateClosingSpeed(
    interceptor: Interceptor,
    target: Target,
    direction: Vector3
  ): number {
    const interceptorSpeed = interceptor.config.maxSpeed
    const targetVelocityToward = dot(target.velocity, direction)
    return interceptorSpeed - targetVelocityToward
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BEST STRATEGY SELECTION
  // ───────────────────────────────────────────────────────────────────────────

  findBestStrategy(interceptorId: string, targetId: string): InterceptionResult {
    const strategies: InterceptionStrategy[] = ['LEAD', 'PURSUIT', 'PARALLEL', 'AMBUSH']
    let bestResult: InterceptionResult | null = null

    for (const strategy of strategies) {
      const result = this.calculateIntercept(interceptorId, targetId, strategy)
      if (result.isPossible) {
        if (!bestResult || result.timeToIntercept < bestResult.timeToIntercept) {
          bestResult = result
        }
      }
    }

    return (
      bestResult || {
        interceptPoint: { x: 0, y: 0, z: 0 },
        timeToIntercept: null,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy: 'LEAD',
        isPossible: false,
        reason: 'No viable interception strategy found',
      }
    )
  }

  assignBestInterceptor(
    targetId: string,
    strategy?: InterceptionStrategy
  ): { interceptorId: string; result: InterceptionResult } | null {
    const availableInterceptors = this.getAvailableInterceptors()
    if (availableInterceptors.length === 0) return null

    let bestInterceptorId: string | null = null
    let bestResult: InterceptionResult | null = null

    for (const interceptor of availableInterceptors) {
      const result = strategy
        ? this.calculateIntercept(interceptor.id, targetId, strategy)
        : this.findBestStrategy(interceptor.id, targetId)
      if (result.isPossible) {
        if (!bestResult || result.timeToIntercept < bestResult.timeToIntercept) {
          bestInterceptorId = interceptor.id
          bestResult = result
        }
      }
    }

    if (bestInterceptorId && bestResult) {
      return { interceptorId: bestInterceptorId, result: bestResult }
    }

    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

export function createInterceptionSystem(): InterceptionSystem {
  return new InterceptionSystem()
}
