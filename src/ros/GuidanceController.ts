/**
 * CREBAIN Guidance Controller
 * Adaptive Response & Awareness System (ARAS)
 *
 * Continuous setpoint publishing with PD control for smooth trajectory following
 * Default rate: 20Hz (50ms interval)
 */

import type { ROSBridge } from './ROSBridge'
import type { ZenohBridge } from './ZenohBridge'
import type { Point, Vector3, TwistStamped } from './types'
import { createTime } from './types'
import {
  subtract,
  normalize,
  scale,
  magnitude,
  clampMagnitude,
} from '../lib/mathUtils'
import { namespacedRosTopic, normalizeRosNamespace } from './utils'
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
  /** Last velocity command issued — feeds the acceleration ramp */
  lastCommandedVelocity: Vector3
  isActive: boolean
  lastUpdate: number
}

export interface GuidanceCommand {
  velocity: Vector3
  isEmergencyStop: boolean
  distanceToTarget: number
  estimatedTimeToArrival: number
}

export type GuidanceCallback = (command: GuidanceCommand) => void

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

const SETPOINT_VELOCITY_TOPIC_SUFFIX = 'mavros/setpoint_velocity/cmd_vel'
const SETPOINT_VELOCITY_MESSAGE_TYPE = 'geometry_msgs/TwistStamped'

// Clamp dt to a few nominal control periods so timer stalls or connection
// outages cannot inflate the acceleration-ramp budget (maxAcceleration · dt).
const MAX_DT_NOMINAL_PERIODS = 3

// ─────────────────────────────────────────────────────────────────────────────
// GUIDANCE CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

export class GuidanceController {
  private bridge: ROSBridge | ZenohBridge | null = null
  private config: GuidanceConfig
  private state: GuidanceState
  private intervalId: ReturnType<typeof setInterval> | null = null
  private namespace: string = ''
  private setpointTopic: string = namespacedRosTopic('', SETPOINT_VELOCITY_TOPIC_SUFFIX)
  private advertised: boolean = false
  private skippedUpdate: boolean = false
  private callbacks: Set<GuidanceCallback> = new Set()
  private sequenceNumber: number = 0

  constructor(config: Partial<GuidanceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.state = {
      targetPosition: null,
      targetVelocity: null,
      currentPosition: { x: 0, y: 0, z: 0 },
      currentVelocity: { x: 0, y: 0, z: 0 },
      lastCommandedVelocity: { x: 0, y: 0, z: 0 },
      isActive: false,
      lastUpdate: 0,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Start the guidance controller
   * @param bridge ROS bridge for publishing setpoints
   * @param namespace Drone namespace (e.g., '/drone1')
   */
  start(bridge: ROSBridge | ZenohBridge, namespace: string): void {
    if (this.intervalId) {
      this.stop()
    }

    this.bridge = bridge
    this.namespace = normalizeRosNamespace(namespace)
    // Build the setpoint topic up front: an empty namespace resolves to a
    // valid absolute topic instead of an invalid `//…` name.
    this.setpointTopic = namespacedRosTopic(namespace, SETPOINT_VELOCITY_TOPIC_SUFFIX)
    this.advertised = false

    // Advertise eagerly when the bridge is already connected so an invalid
    // topic throws before the control loop starts; otherwise advertise lazily
    // on the first publish while connected.
    if (this.bridge.isConnected()) {
      try {
        this.advertiseSetpointTopic()
      } catch (error) {
        this.bridge = null
        throw error
      }
    }

    this.state.isActive = true
    this.state.lastUpdate = Date.now()
    this.skippedUpdate = false

    // Start control loop at configured rate
    const intervalMs = 1000 / this.config.rateHz
    this.intervalId = setInterval(() => this.update(), intervalMs)
  }

  /**
   * Advertise the velocity setpoint topic once per start().
   * Zenoh transport needs no explicit advertisement.
   */
  private advertiseSetpointTopic(): void {
    if (this.advertised || !this.bridge) return
    if ('advertise' in this.bridge) {
      this.bridge.advertise(this.setpointTopic, SETPOINT_VELOCITY_MESSAGE_TYPE)
    }
    this.advertised = true
  }

  /**
   * Stop the guidance controller
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }

    // Send zero velocity command before stopping
    if (this.bridge?.isConnected()) {
      this.publishVelocity({ x: 0, y: 0, z: 0 })
    }

    this.state.isActive = false
    this.state.targetPosition = null
    this.state.targetVelocity = null
    this.state.currentPosition = { x: 0, y: 0, z: 0 }
    this.state.currentVelocity = { x: 0, y: 0, z: 0 }
    this.state.lastCommandedVelocity = { x: 0, y: 0, z: 0 }
    this.advertised = false
    this.bridge = null
  }

  /**
   * Emergency stop - immediately halt all movement
   */
  emergencyStop(): void {
    this.state.targetPosition = null
    this.state.targetVelocity = null
    this.state.lastCommandedVelocity = { x: 0, y: 0, z: 0 }

    if (this.bridge?.isConnected()) {
      this.publishVelocity({ x: 0, y: 0, z: 0 })
    }

    this.notifyCallbacks({
      velocity: { x: 0, y: 0, z: 0 },
      isEmergencyStop: true,
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
   * Set direct velocity command (bypasses PD control)
   */
  setDirectVelocity(velocity: Vector3): void {
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

  onCommand(callback: GuidanceCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  private notifyCallbacks(command: GuidanceCommand): void {
    for (const callback of this.callbacks) {
      try {
        callback(command)
      } catch (err) {
        log.error('Callback error', { error: err })
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CONTROL LOOP
  // ───────────────────────────────────────────────────────────────────────────

  private update(): void {
    if (!this.state.isActive || !this.bridge?.isConnected()) {
      // Mark the gap so dt does not span the outage once updates resume.
      this.skippedUpdate = true
      return
    }

    const now = Date.now()
    const nominalDtSec = 1 / this.config.rateHz
    let dt: number // seconds
    if (this.skippedUpdate) {
      // Resuming after early returns (e.g. a disconnect): restart timing from
      // a single nominal period instead of the whole outage.
      this.skippedUpdate = false
      dt = nominalDtSec
    } else {
      dt = Math.min((now - this.state.lastUpdate) / 1000, nominalDtSec * MAX_DT_NOMINAL_PERIODS)
    }
    this.state.lastUpdate = now

    let command: GuidanceCommand

    if (this.state.targetPosition) {
      // PD control to reach target position
      command = this.calculatePDControl(this.state.targetPosition, dt)
    } else if (this.state.targetVelocity) {
      // Direct velocity command with ramping
      command = this.calculateRampedVelocity(this.state.targetVelocity, dt)
    } else {
      // No target - decelerate to stop
      command = this.calculateDeceleration(dt)
    }

    // Publish velocity command. Track it separately from the measured
    // velocity so the odometry-fed D-term is not corrupted by our own output.
    this.publishVelocity(command.velocity)
    this.state.lastCommandedVelocity = command.velocity

    // Notify callbacks
    this.notifyCallbacks(command)
  }

  /**
   * PD control for position tracking
   */
  private calculatePDControl(target: Point, dt: number): GuidanceCommand {
    // Use actual tracked position from pose updates
    const currentPos = this.state.currentPosition

    // Position error
    const posError = subtract(target, currentPos)
    const distanceToTarget = magnitude(posError)

    // Check arrival
    if (distanceToTarget < this.config.arrivalThreshold) {
      return {
        velocity: { x: 0, y: 0, z: 0 },
        isEmergencyStop: false,
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

    // Apply velocity ramping (from the last command, not the measurement)
    const velocity = this.applyVelocityRamp(
      this.state.lastCommandedVelocity,
      desiredVelocity,
      dt
    )

    // Estimate time to arrival
    const speed = magnitude(velocity)
    const eta = speed > 0.1 ? distanceToTarget / speed : Infinity

    return {
      velocity,
      isEmergencyStop: false,
      distanceToTarget,
      estimatedTimeToArrival: eta,
    }
  }

  /**
   * Direct velocity command with smooth ramping
   */
  private calculateRampedVelocity(target: Vector3, dt: number): GuidanceCommand {
    const clamped = clampMagnitude(target, this.config.maxVelocity)
    const velocity = this.applyVelocityRamp(
      this.state.lastCommandedVelocity,
      clamped,
      dt
    )

    return {
      velocity,
      isEmergencyStop: false,
      distanceToTarget: 0,
      estimatedTimeToArrival: 0,
    }
  }

  /**
   * Smooth deceleration to stop
   */
  private calculateDeceleration(dt: number): GuidanceCommand {
    const velocity = this.applyVelocityRamp(
      this.state.lastCommandedVelocity,
      { x: 0, y: 0, z: 0 },
      dt
    )

    return {
      velocity,
      isEmergencyStop: false,
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
  // ROS PUBLISHING
  // ───────────────────────────────────────────────────────────────────────────

  private publishVelocity(velocity: Vector3): void {
    if (!this.bridge?.isConnected()) return

    // Advertise lazily so bridges that connect after start() are covered.
    try {
      this.advertiseSetpointTopic()
    } catch (error) {
      log.error('Failed to advertise guidance setpoint topic', { error })
      return
    }

    const twist = {
      linear: velocity,
      angular: { x: 0, y: 0, z: 0 },
    }

    const msg: TwistStamped = {
      header: {
        seq: this.sequenceNumber++,
        stamp: createTime(),
        frame_id: 'base_link',
      },
      twist,
    }

    Promise.resolve(this.bridge.publishSetpointVelocity(this.namespace, msg)).catch(error => {
      log.error('Failed to publish guidance velocity setpoint', { error })
    })
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
    // stop()/start() cycle would zero tracked position/velocity mid-flight.
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
