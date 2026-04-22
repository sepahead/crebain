/**
 * CREBAIN Interception System
 * Adaptive Response & Awareness System (ARAS)
 *
 * Intercept trajectory calculation and mission management
 * Optimized with squared distance comparisons to avoid sqrt overhead
 */

import type { Point, Vector3 } from '../ros/types'
import {
  distance,
  distanceSquared,
  magnitude,
  magnitudeSquared,
  normalize,
  scale,
  subtract,
  dot,
  cross,
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

export interface InterceptionResult {
  interceptPoint: Point
  timeToIntercept: number // seconds
  interceptorVelocity: Vector3
  strategy: InterceptionStrategy
  isPossible: boolean
  reason?: string
}

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
    this.targets.set(id, {
      id,
      position,
      velocity,
      lastUpdate: Date.now(),
    })
  }

  removeTarget(id: string): void {
    this.targets.delete(id)
    // Abort any missions targeting this target
    for (const mission of this.missions.values()) {
      if (mission.targetId === id && mission.status === 'ACTIVE') {
        mission.status = 'ABORTED'
      }
    }
  }

  getTarget(id: string): Target | undefined {
    return this.targets.get(id)
  }

  getAllTargets(): Target[] {
    return Array.from(this.targets.values())
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
    this.interceptors.set(id, {
      id,
      position,
      velocity,
      config: { ...DEFAULT_INTERCEPTOR_CONFIG, ...config },
      currentMission: null,
    })
  }

  updateInterceptor(id: string, position: Point, velocity: Vector3): void {
    const interceptor = this.interceptors.get(id)
    if (interceptor) {
      interceptor.position = position
      interceptor.velocity = velocity
    }
  }

  removeInterceptor(id: string): void {
    const interceptor = this.interceptors.get(id)
    if (interceptor?.currentMission) {
      interceptor.currentMission.status = 'ABORTED'
    }
    this.interceptors.delete(id)
  }

  getInterceptor(id: string): Interceptor | undefined {
    return this.interceptors.get(id)
  }

  getAvailableInterceptors(): Interceptor[] {
    return Array.from(this.interceptors.values()).filter(i => !i.currentMission)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TRAJECTORY PREDICTION
  // ───────────────────────────────────────────────────────────────────────────

  predictTargetPosition(targetId: string, deltaTimeSeconds: number): Point | null {
    const target = this.targets.get(targetId)
    if (!target) return null
    return predictPosition(target.position, target.velocity, deltaTimeSeconds)
  }

  predictTargetTrajectory(targetId: string, durationSeconds: number, stepSeconds: number = 0.5): TrajectoryPoint[] {
    const target = this.targets.get(targetId)
    if (!target) return []

    const trajectory: TrajectoryPoint[] = []
    const numSteps = Math.ceil(durationSeconds / stepSeconds) + 1

    for (let i = 0; i < numSteps; i++) {
      const t = Math.min(i * stepSeconds, durationSeconds)
      trajectory.push({
        position: predictPosition(target.position, target.velocity, t),
        velocity: target.velocity, // Reference, not copy (immutable)
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
        timeToIntercept: Infinity,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy,
        isPossible: false,
        reason: 'Interceptor not found',
      }
    }

    if (!target) {
      return {
        interceptPoint: { x: 0, y: 0, z: 0 },
        timeToIntercept: Infinity,
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
        interceptPoint: target.position,
        timeToIntercept: Infinity,
        interceptorVelocity,
        strategy: 'PURSUIT',
        isPossible: false,
        reason: 'Target is faster - cannot catch',
      }
    }

    const timeToIntercept = dist / closingSpeed

    return {
      interceptPoint: this.predictTargetPosition(target.id, timeToIntercept) || target.position,
      timeToIntercept,
      interceptorVelocity,
      strategy: 'PURSUIT',
      isPossible: true,
    }
  }

  /**
   * LEAD - Aim ahead of target (lead pursuit)
   * Optimized with squared distance for convergence check
   */
  private calculateLeadIntercept(interceptor: Interceptor, target: Target): InterceptionResult {
    const maxIterations = 10
    const maxSpeed = interceptor.config.maxSpeed
    const convergenceThresholdSq = 0.0001 // 0.01² seconds

    let timeGuess = distance(interceptor.position, target.position) / maxSpeed

    for (let i = 0; i < maxIterations; i++) {
      const predicted = predictPosition(target.position, target.velocity, timeGuess)
      const toPredict = subtract(predicted, interceptor.position)
      const distToPredict = magnitude(toPredict)
      const newTimeGuess = distToPredict / maxSpeed

      const timeDiff = newTimeGuess - timeGuess
      if (timeDiff * timeDiff < convergenceThresholdSq) {
        // Converged - use pre-computed direction
        const dir = scale(toPredict, 1 / distToPredict) // normalize inline

        return {
          interceptPoint: predicted,
          timeToIntercept: newTimeGuess,
          interceptorVelocity: scale(dir, maxSpeed),
          strategy: 'LEAD',
          isPossible: true,
        }
      }

      timeGuess = newTimeGuess
    }

    // Did not converge - target too fast
    return {
      interceptPoint: target.position,
      timeToIntercept: Infinity,
      interceptorVelocity: { x: 0, y: 0, z: 0 },
      strategy: 'LEAD',
      isPossible: false,
      reason: 'Could not calculate lead intercept - target may be too fast',
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

    // Cross product to get perpendicular direction
    const perpendicular = normalize(cross(targetDir, toTarget))
    const perpMagSq = magnitudeSquared(perpendicular)

    if (perpMagSq < 0.000001) { // 0.001²
      return this.calculateLeadIntercept(interceptor, target)
    }

    // Approach from the side while matching forward velocity
    const maxSpeedSq = interceptor.config.maxSpeed * interceptor.config.maxSpeed
    const lateralSpeedSq = Math.max(0, maxSpeedSq - targetSpeedSq)

    if (lateralSpeedSq < MIN_LATERAL_SPEED_SQ) {
      return {
        interceptPoint: target.position,
        timeToIntercept: Infinity,
        interceptorVelocity: { x: 0, y: 0, z: 0 },
        strategy: 'PARALLEL',
        isPossible: false,
        reason: 'Target too fast for parallel intercept',
      }
    }

    const lateralSpeed = Math.sqrt(lateralSpeedSq)
    const sideDir = normalize(toTarget)

    // Calculate intercept velocity: targetDir * targetSpeed + sideDir * lateralSpeed
    const interceptorVelocity = {
      x: targetDir.x * targetSpeed + sideDir.x * lateralSpeed,
      y: targetDir.y * targetSpeed + sideDir.y * lateralSpeed,
      z: targetDir.z * targetSpeed + sideDir.z * lateralSpeed,
    }

    const lateralDistance = magnitude(toTarget)
    const timeToIntercept = lateralDistance / lateralSpeed

    return {
      interceptPoint: predictPosition(target.position, target.velocity, timeToIntercept),
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
    let bestTime = Infinity

    for (let i = 0; i < 20; i++) {
      const midTime = (minTime + maxTime) / 2
      const predicted = predictPosition(target.position, target.velocity, midTime)

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

    if (bestPoint) {
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
      interceptPoint: target.position,
      timeToIntercept: Infinity,
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

    return mission
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
      return mission
    }

    // Check if target is intercepted using squared distance
    const engagementRadiusSq = interceptor.config.engagementRadius * interceptor.config.engagementRadius
    const distSq = distanceSquared(interceptor.position, target.position)

    if (distSq <= engagementRadiusSq) {
      mission.status = 'COMPLETED'
      interceptor.currentMission = null
      return mission
    }

    // Recalculate intercept
    const result = this.calculateIntercept(mission.interceptorId, mission.targetId, mission.strategy)
    mission.interceptPoint = result.interceptPoint
    mission.timeToIntercept = result.timeToIntercept
    mission.lastUpdate = Date.now()

    if (!result.isPossible) {
      mission.status = 'FAILED'
      interceptor.currentMission = null
    }

    return mission
  }

  abortMission(missionId: string): boolean {
    const mission = this.missions.get(missionId)
    if (!mission) return false

    mission.status = 'ABORTED'
    
    const interceptor = this.interceptors.get(mission.interceptorId)
    if (interceptor) {
      interceptor.currentMission = null
    }

    return true
  }

  getMission(missionId: string): InterceptionMission | undefined {
    return this.missions.get(missionId)
  }

  getActiveMissions(): InterceptionMission[] {
    return Array.from(this.missions.values()).filter(m => m.status === 'ACTIVE')
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
  private calculateClosingSpeed(interceptor: Interceptor, target: Target, direction: Vector3): number {
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

    return bestResult || {
      interceptPoint: { x: 0, y: 0, z: 0 },
      timeToIntercept: Infinity,
      interceptorVelocity: { x: 0, y: 0, z: 0 },
      strategy: 'LEAD',
      isPossible: false,
      reason: 'No viable interception strategy found',
    }
  }

  assignBestInterceptor(targetId: string): { interceptorId: string; result: InterceptionResult } | null {
    const availableInterceptors = this.getAvailableInterceptors()
    if (availableInterceptors.length === 0) return null

    let bestInterceptorId: string | null = null
    let bestResult: InterceptionResult | null = null

    for (const interceptor of availableInterceptors) {
      const result = this.findBestStrategy(interceptor.id, targetId)
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
// SINGLETON INSTANCE
// ─────────────────────────────────────────────────────────────────────────────

let instance: InterceptionSystem | null = null

export function getInterceptionSystem(): InterceptionSystem {
  if (!instance) {
    instance = new InterceptionSystem()
  }
  return instance
}
