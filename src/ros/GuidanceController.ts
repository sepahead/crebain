/**
 * CREBAIN Guidance Controller
 * Adaptive Response & Awareness System (ARAS)
 *
 * Local, no-authority guidance preview with PD control for trajectory evaluation.
 * It has no transport dependency and cannot publish a vehicle setpoint.
 */

import type { Point, Vector3 } from './types'
import {
  subtract,
  normalize,
  scale,
  magnitude,
  clampMagnitude,
} from '../lib/mathUtils'
import { rosLogger as log } from '../lib/logger'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface GuidanceConfig {
  /** Control loop rate in Hz (default: 20) */
  rateHz: number
  /** Maximum velocity in m/s */
  maxVelocity: number
  /** Maximum acceleration in m/s² */
  maxAcceleration: number
  /** Proportional gain for position error */
  kP: number
  /** Derivative gain for velocity error */
  kD: number
  /** Distance at which to start decelerating */
  approachDistance: number
  /** Minimum distance to target before stopping */
  arrivalThreshold: number
}

export interface GuidanceState {
  targetPosition: Point | null
  targetVelocity: Vector3 | null
  currentPosition: Point
  /** Measured velocity from odometry/pose updates — feeds the D-term */
  currentVelocity: Vector3
  /** Last local velocity proposal — feeds the acceleration ramp */
  lastProposedVelocity: Vector3
  isActive: boolean
  lastUpdate: number
}

export interface GuidanceProposal {
  authority: 'NoAuthority'
  action: 'Hold' | 'PreviewVelocity'
  velocity: Vector3
  distanceToTarget: number
  estimatedTimeToArrival: number
}

export type GuidanceCallback = (proposal: GuidanceProposal) => void

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: GuidanceConfig = {
  rateHz: 20, // 50ms interval
  maxVelocity: 15, // m/s
  maxAcceleration: 5, // m/s²
  kP: 1.5, // Position proportional gain
  kD: 0.5, // Velocity derivative gain
  approachDistance: 10, // Start deceleration at 10m
  arrivalThreshold: 0.5, // Stop within 0.5m
}

// Clamp dt to a few nominal control periods so timer stalls or connection
// outages cannot inflate the acceleration-ramp budget (maxAcceleration · dt).
const MAX_DT_NOMINAL_PERIODS = 3

// ─────────────────────────────────────────────────────────────────────────────
// GUIDANCE CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

export class GuidanceController {
  private config: GuidanceConfig
  private state: GuidanceState
  private intervalId: ReturnType<typeof setInterval> | null = null
  private callbacks: Set<GuidanceCallback> = new Set()

  constructor(config: Partial<GuidanceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.state = {
      targetPosition: null,
      targetVelocity: null,
      currentPosition: { x: 0, y: 0, z: 0 },
      currentVelocity: { x: 0, y: 0, z: 0 },
      lastProposedVelocity: { x: 0, y: 0, z: 0 },
      isActive: false,
      lastUpdate: 0,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Start local proposal generation. No transport capability is accepted.
   */
  startPreview(): void {
    if (this.intervalId) {
      this.stop()
    }

    this.state.isActive = true
    this.state.lastUpdate = Date.now()

    const intervalMs = 1000 / this.config.rateHz
    this.intervalId = setInterval(() => this.update(), intervalMs)
  }

  /**
   * Stop the guidance controller
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    this.state.isActive = false
    this.state.targetPosition = null
    this.state.targetVelocity = null
    this.state.currentPosition = { x: 0, y: 0, z: 0 }
    this.state.currentVelocity = { x: 0, y: 0, z: 0 }
    this.state.lastProposedVelocity = { x: 0, y: 0, z: 0 }
  }

  /**
   * Emergency stop - immediately halt all movement
   */
  hold(): void {
    this.state.targetPosition = null
    this.state.targetVelocity = null
    this.state.lastProposedVelocity = { x: 0, y: 0, z: 0 }

    this.notifyCallbacks({
      authority: 'NoAuthority',
      action: 'Hold',
      velocity: { x: 0, y: 0, z: 0 },
      distanceToTarget: 0,
      estimatedTimeToArrival: 0,
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TARGET MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Set target position for guidance
   * The controller will continuously update velocity to reach this position
   */
  setTargetPosition(position: Point, targetVelocity?: Vector3): void {
    this.state.targetPosition = position
    this.state.targetVelocity = targetVelocity || null
  }

  /**
   * Set a direct local velocity proposal (bypasses PD preview control).
   */
  setPreviewVelocity(velocity: Vector3): void {
    this.state.targetPosition = null
    this.state.targetVelocity = velocity
  }

  /**
   * Clear current target
   */
  clearTarget(): void {
    this.state.targetPosition = null
    this.state.targetVelocity = null
  }

  /**
   * Update current drone position and velocity for PD control
   * This should be called with pose updates from MAVROS or Gazebo
   */
  updateCurrentPosition(position: Point, velocity: Vector3): void {
    this.state.currentPosition = position
    this.state.currentVelocity = velocity
  }

  /**
   * Get current tracked position
   */
  getCurrentPosition(): Point {
    return this.state.currentPosition
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CALLBACKS
  // ───────────────────────────────────────────────────────────────────────────

  onProposal(callback: GuidanceCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  private notifyCallbacks(proposal: GuidanceProposal): void {
    for (const callback of this.callbacks) {
      try {
        callback(proposal)
      } catch (err) {
        log.error('Callback error', { error: err })
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CONTROL LOOP
  // ───────────────────────────────────────────────────────────────────────────

  private update(): void {
    if (!this.state.isActive) return

    const now = Date.now()
    const nominalDtSec = 1 / this.config.rateHz
    const dt = Math.min(
      (now - this.state.lastUpdate) / 1000,
      nominalDtSec * MAX_DT_NOMINAL_PERIODS
    )
    this.state.lastUpdate = now

    let proposal: GuidanceProposal

    if (this.state.targetPosition) {
      proposal = this.calculatePDControl(this.state.targetPosition, dt)
    } else if (this.state.targetVelocity) {
      proposal = this.calculateRampedVelocity(this.state.targetVelocity, dt)
    } else {
      proposal = this.calculateDeceleration(dt)
    }

    this.state.lastProposedVelocity = proposal.velocity
    this.notifyCallbacks(proposal)
  }

  /**
   * PD control for position tracking
   */
  private calculatePDControl(target: Point, dt: number): GuidanceProposal {
    // Use actual tracked position from pose updates
    const currentPos = this.state.currentPosition

    // Position error
    const posError = subtract(target, currentPos)
    const distanceToTarget = magnitude(posError)

    // Check arrival
    if (distanceToTarget < this.config.arrivalThreshold) {
      return {
        authority: 'NoAuthority',
        action: 'Hold',
        velocity: { x: 0, y: 0, z: 0 },
        distanceToTarget,
        estimatedTimeToArrival: 0,
      }
    }

    // Proportional term: direction to target scaled by distance
    const pTerm = scale(posError, this.config.kP)

    // Derivative term: damping based on current velocity
    const dTerm = scale(this.state.currentVelocity, -this.config.kD)

    // Combined PD output
    let desiredVelocity = {
      x: pTerm.x + dTerm.x,
      y: pTerm.y + dTerm.y,
      z: pTerm.z + dTerm.z,
    }

    // Apply approach slowdown
    if (distanceToTarget < this.config.approachDistance) {
      const slowdownFactor = distanceToTarget / this.config.approachDistance
      desiredVelocity = scale(desiredVelocity, slowdownFactor)
    }

    // Add target velocity prediction if available
    if (this.state.targetVelocity) {
      desiredVelocity = {
        x: desiredVelocity.x + this.state.targetVelocity.x,
        y: desiredVelocity.y + this.state.targetVelocity.y,
        z: desiredVelocity.z + this.state.targetVelocity.z,
      }
    }

    // Clamp to max velocity
    desiredVelocity = clampMagnitude(desiredVelocity, this.config.maxVelocity)

    // Apply velocity ramping from the last local proposal, not the measurement.
    const velocity = this.applyVelocityRamp(
      this.state.lastProposedVelocity,
      desiredVelocity,
      dt
    )

    // Estimate time to arrival
    const speed = magnitude(velocity)
    const eta = speed > 0.1 ? distanceToTarget / speed : Infinity

    return {
      authority: 'NoAuthority',
      action: 'PreviewVelocity',
      velocity,
      distanceToTarget,
      estimatedTimeToArrival: eta,
    }
  }

  /**
   * Direct local velocity proposal with smooth ramping.
   */
  private calculateRampedVelocity(target: Vector3, dt: number): GuidanceProposal {
    const clamped = clampMagnitude(target, this.config.maxVelocity)
    const velocity = this.applyVelocityRamp(
      this.state.lastProposedVelocity,
      clamped,
      dt
    )

    return {
      authority: 'NoAuthority',
      action: 'PreviewVelocity',
      velocity,
      distanceToTarget: 0,
      estimatedTimeToArrival: 0,
    }
  }

  /**
   * Smooth deceleration to stop
   */
  private calculateDeceleration(dt: number): GuidanceProposal {
    const velocity = this.applyVelocityRamp(
      this.state.lastProposedVelocity,
      { x: 0, y: 0, z: 0 },
      dt
    )

    return {
      authority: 'NoAuthority',
      action: 'Hold',
      velocity,
      distanceToTarget: 0,
      estimatedTimeToArrival: 0,
    }
  }

  /**
   * Apply velocity ramping for smooth acceleration/deceleration
   */
  private applyVelocityRamp(current: Vector3, target: Vector3, dt: number): Vector3 {
    // Bound the per-update velocity change by the acceleration limit (m/s² · s).
    const maxChange = this.config.maxAcceleration * dt

    const diff = subtract(target, current)
    const diffMag = magnitude(diff)

    if (diffMag <= maxChange) {
      return target
    }

    // Move toward target at max rate
    const step = scale(normalize(diff), maxChange)
    return {
      x: current.x + step.x,
      y: current.y + step.y,
      z: current.z + step.z,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ACCESSORS
  // ───────────────────────────────────────────────────────────────────────────

  isActive(): boolean {
    return this.state.isActive
  }

  getState(): Readonly<GuidanceState> {
    return this.state
  }

  getConfig(): Readonly<GuidanceConfig> {
    return this.config
  }

  setConfig(config: Partial<GuidanceConfig>): void {
    this.config = { ...this.config, ...config }

    // Recreate only the control-loop interval on a rate change; a full
    // A full stop/start cycle would discard the current preview state.
    if (config.rateHz && this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = setInterval(() => this.update(), 1000 / this.config.rateHz)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new guidance controller instance
 */
export function createGuidanceController(config?: Partial<GuidanceConfig>): GuidanceController {
  return new GuidanceController(config)
}
