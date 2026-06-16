/**
 * CREBAIN Gazebo Drones Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * React hook for tracking drones from Gazebo simulation via ROS
 * Uses O(1) position history updates for high-frequency tracking data
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { ROSBridge } from '../ros/ROSBridge'
import type { ZenohBridge } from '../ros/ZenohBridge'
import type { Pose, Twist, ModelStates, Point } from '../ros/types'
import { quaternionToEuler as quatToEuler } from '../ros/types'
import { CircularBuffer } from '../lib/CircularBuffer'
import {
  magnitude,
  distanceSquared,
  predictPosition as mathPredictPosition,
} from '../lib/mathUtils'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type DroneType = 'friendly' | 'hostile' | 'unknown'
export type DroneStatus = 'airborne' | 'landed' | 'takeoff' | 'landing' | 'crashed'

/**
 * Internal drone state with CircularBuffer for position history
 */
interface DroneStateInternal {
  id: string
  name: string
  type: DroneType
  status: DroneStatus
  pose: Pose
  velocity: Twist
  speed: number
  heading: number
  altitude: number
  lastUpdate: number
  isArmed: boolean
  mode: string
  batteryPercent: number
  positionHistory: CircularBuffer<Point>
}

/**
 * External drone state with array for compatibility
 */
export interface DroneState {
  id: string
  name: string
  type: DroneType
  status: DroneStatus
  pose: Pose
  velocity: Twist
  speed: number
  heading: number // radians
  altitude: number
  lastUpdate: number
  isArmed: boolean
  mode: string
  batteryPercent: number
  positionHistory: Point[]
}

export interface UseGazeboDronesConfig {
  bridge: ROSBridge | ZenohBridge | null
  droneNamePatterns: string[]
  friendlyPatterns: string[]
  hostilePatterns: string[]
  throttleRateMs: number
  maxHistoryLength: number
}

export interface UseGazeboDronesReturn {
  drones: Map<string, DroneState>
  friendlyDrones: DroneState[]
  hostileDrones: DroneState[]
  unknownDrones: DroneState[]
  getDrone: (id: string) => DroneState | undefined
  getClosestHostile: (position: Point) => DroneState | null
  predictPosition: (droneId: string, deltaTimeMs: number) => Point | null
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<UseGazeboDronesConfig, 'bridge'> = {
  droneNamePatterns: ['iris', 'typhoon', 'solo', 'drone', 'uav', 'quad', 'maverick'],
  friendlyPatterns: ['interceptor', 'friendly', 'ally', 'blue'],
  hostilePatterns: ['target', 'hostile', 'enemy', 'red', 'intruder'],
  throttleRateMs: 50, // 20 Hz
  maxHistoryLength: 100,
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function matchesPattern(name: string, patterns: string[]): boolean {
  const lowerName = name.toLowerCase()
  return patterns.some((pattern) => lowerName.includes(pattern.toLowerCase()))
}

function classifyDrone(
  name: string,
  friendlyPatterns: string[],
  hostilePatterns: string[]
): DroneType {
  if (matchesPattern(name, friendlyPatterns)) return 'friendly'
  if (matchesPattern(name, hostilePatterns)) return 'hostile'
  return 'unknown'
}

function determineStatus(pose: Pose, velocity: Twist, speed: number): DroneStatus {
  const altitude = pose.position.z
  const verticalVelocity = velocity.linear.z

  if (altitude < 0.1 && speed < 0.1) return 'landed'
  if (altitude < 2 && verticalVelocity > 0.5) return 'takeoff'
  if (verticalVelocity < -0.5 && altitude < 5) return 'landing'
  return 'airborne'
}

function createDefaultDroneStateInternal(
  id: string,
  name: string,
  type: DroneType,
  historyCapacity: number
): DroneStateInternal {
  return {
    id,
    name,
    type,
    status: 'landed',
    pose: {
      position: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
    velocity: {
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
    },
    speed: 0,
    heading: 0,
    altitude: 0,
    lastUpdate: Date.now(),
    isArmed: false,
    mode: 'UNKNOWN',
    batteryPercent: 100,
    positionHistory: new CircularBuffer<Point>(historyCapacity),
  }
}

/**
 * Convert internal state to external state
 * Only converts positionHistory when needed (lazy)
 */
function toExternalState(internal: DroneStateInternal): DroneState {
  return {
    id: internal.id,
    name: internal.name,
    type: internal.type,
    status: internal.status,
    pose: internal.pose,
    velocity: internal.velocity,
    speed: internal.speed,
    heading: internal.heading,
    altitude: internal.altitude,
    lastUpdate: internal.lastUpdate,
    isArmed: internal.isArmed,
    mode: internal.mode,
    batteryPercent: internal.batteryPercent,
    positionHistory: internal.positionHistory.toArray(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useGazeboDrones(
  config: Partial<UseGazeboDronesConfig> & { bridge: ROSBridge | ZenohBridge | null }
): UseGazeboDronesReturn {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config }
  const { bridge } = mergedConfig
  const bridgeConnected = bridge?.isConnected() ?? false

  // Internal state uses CircularBuffer for O(1) history updates
  const [dronesInternal, setDronesInternal] = useState<Map<string, DroneStateInternal>>(new Map())
  const unsubscribesRef = useRef<Array<() => void>>([])

  // Stable config refs to avoid effect re-runs
  const configRef = useRef(mergedConfig)
  configRef.current = mergedConfig

  // Client-side throttle timestamp (works for both ROSBridge and ZenohBridge)
  const lastUpdateRef = useRef(0)

  // Stale drone timeout in milliseconds
  const STALE_DRONE_MS = 5000

  // Subscribe to Gazebo model states
  useEffect(() => {
    if (!bridge || !bridgeConnected) return

    const handleModelStates = (msg: ModelStates) => {
      const cfg = configRef.current
      const now = performance.now()

      // Client-side throttle: skip updates that are too frequent
      // This ensures consistent 20Hz updates regardless of transport (ROSBridge or ZenohBridge)
      if (now - lastUpdateRef.current < cfg.throttleRateMs) {
        return
      }
      lastUpdateRef.current = now

      const timestamp = Date.now()

      setDronesInternal((prevDrones) => {
        const newDrones = new Map(prevDrones)
        const seenIds = new Set<string>()

        // name/pose/twist are independent parallel arrays from external CDR/ROS
        // data; bound by the shortest so a truncated or malformed message cannot
        // index past the end and throw inside the subscription callback.
        const entryCount = Math.min(msg.name.length, msg.pose.length, msg.twist.length)
        for (let i = 0; i < entryCount; i++) {
          const name = msg.name[i]
          const pose = msg.pose[i]
          const twist = msg.twist[i]

          // Check if this is a drone based on name patterns
          if (!matchesPattern(name, cfg.droneNamePatterns)) continue

          const id = name
          seenIds.add(id)
          const type = classifyDrone(name, cfg.friendlyPatterns, cfg.hostilePatterns)

          let drone = newDrones.get(id)
          if (!drone) {
            drone = createDefaultDroneStateInternal(id, name, type, cfg.maxHistoryLength)
          }

          // Calculate derived values
          const euler = quatToEuler(pose.orientation)
          const speed = magnitude(twist.linear)
          const status = determineStatus(pose, twist, speed)

          // O(1) position history update via circular buffer
          drone.positionHistory.push(pose.position)

          // Update drone state (mutate the existing object for performance)
          drone.pose = pose
          drone.velocity = twist
          drone.speed = speed
          drone.heading = euler.yaw
          drone.altitude = pose.position.z
          drone.status = status
          drone.lastUpdate = timestamp

          newDrones.set(id, drone)
        }

        // Cleanup stale drones that haven't been seen for STALE_DRONE_MS
        // Prevents unbounded Map growth in long-running sessions with dynamic spawning
        for (const [id, drone] of newDrones) {
          if (!seenIds.has(id) && timestamp - drone.lastUpdate > STALE_DRONE_MS) {
            newDrones.delete(id)
          }
        }

        return newDrones
      })
    }

    const unsubscribe = bridge.subscribeToModelStates(
      handleModelStates,
      configRef.current.throttleRateMs
    )
    unsubscribesRef.current.push(unsubscribe)

    return () => {
      unsubscribesRef.current.forEach((unsub) => unsub())
      unsubscribesRef.current = []
    }
  }, [bridge, bridgeConnected]) // Re-subscribe when bridge connects/disconnects

  // Convert internal Map to external Map (memoized)
  const drones = useMemo(() => {
    const external = new Map<string, DroneState>()
    for (const [id, internal] of dronesInternal) {
      external.set(id, toExternalState(internal))
    }
    return external
  }, [dronesInternal])

  // Memoized drone filtering - only recalculate when drones change
  const { friendlyDrones, hostileDrones, unknownDrones } = useMemo(() => {
    const friendly: DroneState[] = []
    const hostile: DroneState[] = []
    const unknown: DroneState[] = []

    for (const drone of drones.values()) {
      switch (drone.type) {
        case 'friendly':
          friendly.push(drone)
          break
        case 'hostile':
          hostile.push(drone)
          break
        default:
          unknown.push(drone)
      }
    }

    return {
      friendlyDrones: friendly,
      hostileDrones: hostile,
      unknownDrones: unknown,
    }
  }, [drones])

  // Get drone by ID
  const getDrone = useCallback(
    (id: string): DroneState | undefined => {
      return drones.get(id)
    },
    [drones]
  )

  // Get closest hostile drone using squared distance (O(n), no sqrt until final)
  const getClosestHostile = useCallback(
    (position: Point): DroneState | null => {
      let closest: DroneState | null = null
      let minDistSq = Infinity

      for (const drone of drones.values()) {
        if (drone.type !== 'hostile') continue

        const distSq = distanceSquared(position, drone.pose.position)
        if (distSq < minDistSq) {
          minDistSq = distSq
          closest = drone
        }
      }

      return closest
    },
    [drones]
  )

  // Predict future position using optimized math utility
  const predictPosition = useCallback(
    (droneId: string, deltaTimeMs: number): Point | null => {
      const drone = drones.get(droneId)
      if (!drone) return null

      return mathPredictPosition(drone.pose.position, drone.velocity.linear, deltaTimeMs / 1000)
    },
    [drones]
  )

  return {
    drones,
    friendlyDrones,
    hostileDrones,
    unknownDrones,
    getDrone,
    getClosestHostile,
    predictPosition,
  }
}

export default useGazeboDrones
