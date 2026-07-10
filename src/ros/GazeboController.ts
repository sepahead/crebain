/**
 * CREBAIN Gazebo Controller
 * Adaptive Response & Awareness System (ARAS)
 *
 * Gazebo simulation control via ROS services
 * Supports pause/unpause, reset, model spawning, and time control
 */

import type { ROSBridge } from './ROSBridge'
import type { ZenohBridge } from './ZenohBridge'
import type { Pose, Twist, ModelState, Point, Quaternion } from './types'
import { gazeboLogger as log } from '../lib/logger'
import { MAVERICK_SDF } from './models'
import {
  validateGazeboFrameId,
  validateGazeboModelName,
  validateGazeboPose,
  validateGazeboSpawn,
  validateGazeboTwist,
} from './gazeboValidation'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface SpawnModelRequest {
  model_name: string
  model_xml: string
  robot_namespace: string
  initial_pose: Pose
  reference_frame: string
}

export interface SpawnModelResponse {
  success: boolean
  status_message: string
}

export interface DeleteModelRequest {
  model_name: string
}

export interface DeleteModelResponse {
  success: boolean
  status_message: string
}

export interface SetModelStateRequest {
  model_state: ModelState
}

export interface SetModelStateResponse {
  success: boolean
  status_message: string
}

export interface GetModelStateRequest {
  model_name: string
  relative_entity_name: string
}

export interface GetModelStateResponse {
  pose: Pose
  twist: Twist
  success: boolean
  status_message: string
}

export interface GazeboPhysicsProperties {
  time_step: number
  pause: boolean
  max_update_rate: number
  gravity: { x: number; y: number; z: number }
}

export interface SetPhysicsPropertiesRequest {
  time_step: number
  max_update_rate: number
  gravity: { x: number; y: number; z: number }
  ode_config?: unknown
}

export interface GazeboControllerState {
  isConnected: boolean
  isPaused: boolean
  simulationTime: number
  realTimeFactor: number
}

export type StateChangeCallback = (state: GazeboControllerState) => void

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

const GAZEBO_SERVICES = {
  PAUSE: '/gazebo/pause_physics',
  UNPAUSE: '/gazebo/unpause_physics',
  RESET_WORLD: '/gazebo/reset_world',
  RESET_SIMULATION: '/gazebo/reset_simulation',
  SPAWN_URDF: '/gazebo/spawn_urdf_model',
  SPAWN_SDF: '/gazebo/spawn_sdf_model',
  DELETE_MODEL: '/gazebo/delete_model',
  GET_MODEL_STATE: '/gazebo/get_model_state',
  SET_MODEL_STATE: '/gazebo/set_model_state',
  GET_PHYSICS: '/gazebo/get_physics_properties',
  SET_PHYSICS: '/gazebo/set_physics_properties',
} as const

// ─────────────────────────────────────────────────────────────────────────────
// GAZEBO CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

export class GazeboController {
  private bridge: ROSBridge | ZenohBridge | null = null
  private state: GazeboControllerState = {
    isConnected: false,
    isPaused: false,
    simulationTime: 0,
    realTimeFactor: 1.0,
  }
  private callbacks: Set<StateChangeCallback> = new Set()
  private clockUnsubscribe: (() => void) | null = null

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Connect to Gazebo via ROS bridge
   */
  connect(bridge: ROSBridge | ZenohBridge): void {
    // Always clear any existing clock subscription to avoid duplicates.
    if (this.clockUnsubscribe) {
      this.clockUnsubscribe()
      this.clockUnsubscribe = null
    }

    this.bridge = bridge
    this.state.isConnected = bridge.isConnected()

    // Subscribe to simulation clock for time tracking
    // Note: ZenohBridge may not support rosgraph_msgs/Clock yet; subscription is best-effort.
    if (typeof (bridge as unknown as { subscribe?: unknown }).subscribe === 'function') {
      this.clockUnsubscribe = bridge.subscribe<{ clock: { secs: number; nsecs: number } }>(
        '/clock',
        'rosgraph_msgs/Clock',
        (msg) => {
          this.state.simulationTime = msg.clock.secs + msg.clock.nsecs / 1e9
          this.notifyStateChange()
        },
        100 // 10 Hz for clock updates
      )
    }

    this.notifyStateChange()
  }

  /**
   * Disconnect from Gazebo
   */
  disconnect(): void {
    if (this.clockUnsubscribe) {
      this.clockUnsubscribe()
      this.clockUnsubscribe = null
    }

    this.bridge = null
    this.state.isConnected = false
    this.notifyStateChange()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SIMULATION CONTROL
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Pause the simulation
   */
  async pause(): Promise<boolean> {
    if (!this.bridge) return false

    try {
      await this.bridge.callService(GAZEBO_SERVICES.PAUSE, {})
      this.state.isPaused = true
      this.notifyStateChange()
      return true
    } catch (error) {
      log.error('Failed to pause', { error })
      return false
    }
  }

  /**
   * Unpause (resume) the simulation
   */
  async unpause(): Promise<boolean> {
    if (!this.bridge) return false

    try {
      await this.bridge.callService(GAZEBO_SERVICES.UNPAUSE, {})
      this.state.isPaused = false
      this.notifyStateChange()
      return true
    } catch (error) {
      log.error('Failed to unpause', { error })
      return false
    }
  }

  /**
   * Toggle pause state
   */
  async togglePause(): Promise<boolean> {
    return this.state.isPaused ? this.unpause() : this.pause()
  }

  /**
   * Reset the world (resets models to initial poses, keeps time)
   */
  async resetWorld(): Promise<boolean> {
    if (!this.bridge) return false

    try {
      await this.bridge.callService(GAZEBO_SERVICES.RESET_WORLD, {})
      return true
    } catch (error) {
      log.error('Failed to reset world', { error })
      return false
    }
  }

  /**
   * Reset simulation (full reset including time)
   */
  async resetSimulation(): Promise<boolean> {
    if (!this.bridge) return false

    try {
      await this.bridge.callService(GAZEBO_SERVICES.RESET_SIMULATION, {})
      this.state.simulationTime = 0
      this.notifyStateChange()
      return true
    } catch (error) {
      log.error('Failed to reset simulation', { error })
      return false
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MODEL MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Spawn a model from URDF XML
   */
  async spawnURDF(
    name: string,
    urdfXml: string,
    pose: Pose,
    namespace: string = '',
    referenceFrame: string = 'world'
  ): Promise<boolean> {
    if (!this.bridge) return false

    try {
      validateGazeboSpawn(name, urdfXml, pose, namespace, referenceFrame)
      const request: SpawnModelRequest = {
        model_name: name,
        model_xml: urdfXml,
        robot_namespace: namespace,
        initial_pose: pose,
        reference_frame: referenceFrame,
      }
      const response = await this.bridge.callService<SpawnModelRequest, SpawnModelResponse>(
        GAZEBO_SERVICES.SPAWN_URDF,
        request
      )
      if (!response.success) {
        log.warn('Spawn URDF failed', { message: response.status_message })
      }
      return response.success === true
    } catch (error) {
      log.error('Failed to spawn URDF', { error })
      return false
    }
  }

  /**
   * Spawn a model from SDF XML
   */
  async spawnSDF(
    name: string,
    sdfXml: string,
    pose: Pose,
    namespace: string = '',
    referenceFrame: string = 'world'
  ): Promise<boolean> {
    if (!this.bridge) return false

    return this.spawnSdfWithPolicy(name, sdfXml, pose, namespace, referenceFrame, false)
  }

  /** Spawn the audited, built-in Maverick model without accepting caller-supplied privileged XML. */
  async spawnBundledMaverick(name: string, pose: Pose): Promise<boolean> {
    const namespacedSdf = MAVERICK_SDF.split('cmd/motor_speed/').join(`${name}/cmd/motor_speed/`)
    return this.spawnSdfWithPolicy(name, namespacedSdf, pose, '', 'world', true)
  }

  private async spawnSdfWithPolicy(
    name: string,
    sdfXml: string,
    pose: Pose,
    namespace: string,
    referenceFrame: string,
    allowBundledPrivilegedXml: boolean
  ): Promise<boolean> {
    if (!this.bridge) return false
    try {
      validateGazeboSpawn(
        name,
        sdfXml,
        pose,
        namespace,
        referenceFrame,
        allowBundledPrivilegedXml
      )
      const request: SpawnModelRequest = {
        model_name: name,
        model_xml: sdfXml,
        robot_namespace: namespace,
        initial_pose: pose,
        reference_frame: referenceFrame,
      }
      const response = await this.bridge.callService<SpawnModelRequest, SpawnModelResponse>(
        GAZEBO_SERVICES.SPAWN_SDF,
        request
      )
      if (!response.success) {
        log.warn('Spawn SDF failed', { message: response.status_message })
      }
      return response.success === true
    } catch (error) {
      log.error('Failed to spawn SDF', { error })
      return false
    }
  }

  /**
   * Delete a model from the simulation
   */
  async deleteModel(name: string): Promise<boolean> {
    if (!this.bridge) return false

    try {
      validateGazeboModelName(name)
      const response = await this.bridge.callService<DeleteModelRequest, DeleteModelResponse>(
        GAZEBO_SERVICES.DELETE_MODEL,
        { model_name: name }
      )
      if (!response.success) {
        log.warn('Delete model failed', { message: response.status_message })
      }
      return response.success === true
    } catch (error) {
      log.error('Failed to delete model', { error })
      return false
    }
  }

  /**
   * Get model state (pose and velocity)
   */
  async getModelState(
    modelName: string,
    relativeTo: string = 'world'
  ): Promise<{ pose: Pose; twist: Twist } | null> {
    if (!this.bridge) return null

    try {
      validateGazeboModelName(modelName)
      validateGazeboFrameId(relativeTo, 'Gazebo relative entity')
      const response = await this.bridge.callService<GetModelStateRequest, GetModelStateResponse>(
        GAZEBO_SERVICES.GET_MODEL_STATE,
        { model_name: modelName, relative_entity_name: relativeTo }
      )

      if (!response.success) {
        log.warn('Get model state failed', { status: response.status_message })
        return null
      }

      return { pose: response.pose, twist: response.twist }
    } catch (error) {
      log.error('Failed to get model state', { error })
      return null
    }
  }

  /**
   * Set model state (position and velocity)
   */
  async setModelState(
    modelName: string,
    pose: Pose,
    twist?: Twist,
    referenceFrame: string = 'world'
  ): Promise<boolean> {
    if (!this.bridge) return false

    const modelState: ModelState = {
      model_name: modelName,
      pose,
      twist: twist || {
        linear: { x: 0, y: 0, z: 0 },
        angular: { x: 0, y: 0, z: 0 },
      },
      reference_frame: referenceFrame,
    }

    try {
      validateGazeboModelName(modelName)
      validateGazeboPose(pose)
      validateGazeboTwist(modelState.twist)
      validateGazeboFrameId(referenceFrame)
      const response = await this.bridge.callService<SetModelStateRequest, SetModelStateResponse>(
        GAZEBO_SERVICES.SET_MODEL_STATE,
        { model_state: modelState }
      )
      if (!response.success) {
        log.warn('Set model state failed', { status: response.status_message })
      }
      return response.success === true
    } catch (error) {
      log.error('Failed to set model state', { error })
      return false
    }
  }

  /**
   * Teleport a model to a new position
   */
  async teleportModel(
    modelName: string,
    position: Point,
    orientation?: Quaternion
  ): Promise<boolean> {
    const pose: Pose = {
      position,
      orientation: orientation || { x: 0, y: 0, z: 0, w: 1 },
    }

    return this.setModelState(modelName, pose)
  }

  /**
   * Set model velocity
   */
  async setModelVelocity(
    modelName: string,
    linear: { x: number; y: number; z: number },
    angular?: { x: number; y: number; z: number }
  ): Promise<boolean> {
    // Get current pose first
    const state = await this.getModelState(modelName)
    if (!state) return false

    const twist: Twist = {
      linear,
      angular: angular || { x: 0, y: 0, z: 0 },
    }

    return this.setModelState(modelName, state.pose, twist)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STATE CALLBACKS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Register a state change callback
   */
  onStateChange(callback: StateChangeCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  private notifyStateChange(): void {
    for (const callback of this.callbacks) {
      try {
        callback({ ...this.state })
      } catch (error) {
        log.error('Callback error', { error })
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ACCESSORS
  // ───────────────────────────────────────────────────────────────────────────

  getState(): Readonly<GazeboControllerState> {
    return this.state
  }

  isConnected(): boolean {
    return this.state.isConnected
  }

  isPaused(): boolean {
    return this.state.isPaused
  }

  getSimulationTime(): number {
    return this.state.simulationTime
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

let instance: GazeboController | null = null

export function getGazeboController(): GazeboController {
  if (!instance) {
    instance = new GazeboController()
  }
  return instance
}

export function createGazeboController(): GazeboController {
  return new GazeboController()
}
