/**
 * CREBAIN Gazebo Drones Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * React hook for tracking drones from Gazebo simulation via ROS
 * Uses O(1) position history updates for high-frequency tracking data
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { TelemetryBridge } from '../ros/TelemetryBridge'
import type { Pose, Twist, ModelStates, Point } from '../ros/types'
import { quaternionToEuler as quatToEuler } from '../ros/types'
import { CircularBuffer } from '../lib/CircularBuffer'
import {
  magnitude,
  distanceSquared,
  predictPosition as mathPredictPosition,
} from '../lib/mathUtils'
import { logger } from '../lib/logger'

const log = logger.scope('GazeboDrones')

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
  lastSeenMonotonicMs: number
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
  bridge: TelemetryBridge | null
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

/** Maximum age of a Gazebo observation before it is unsafe to act on. */
export const GAZEBO_DRONE_STALE_MS = 5000
const GAZEBO_STALE_SWEEP_INTERVAL_MS = 1000
export const MAX_TRACKED_GAZEBO_DRONES = 1_024
export const MAX_GAZEBO_HISTORY_LENGTH = 1_000
const MAX_GAZEBO_PATTERN_COUNT = 32
const MAX_GAZEBO_PATTERN_LENGTH = 32
const MAX_GAZEBO_THROTTLE_MS = 60_000
const MAX_GAZEBO_PREDICTION_MS = 3_600_000

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function matchesPattern(name: string, patterns: readonly string[]): boolean {
  const tokens = name.toLowerCase().match(/[a-z0-9]+/gu) ?? []
  return patterns.some((pattern) => tokens.some((token) => token.startsWith(pattern)))
}

function classifyDrone(
  name: string,
  friendlyPatterns: readonly string[],
  hostilePatterns: readonly string[]
): DroneType {
  const friendly = matchesPattern(name, friendlyPatterns)
  const hostile = matchesPattern(name, hostilePatterns)
  if (friendly === hostile) return 'unknown'
  if (friendly) return 'friendly'
  if (hostile) return 'hostile'
  return 'unknown'
}

function validatedPatterns(patterns: string[], name: string): string[] {
  if (
    !Array.isArray(patterns) ||
    patterns.length === 0 ||
    patterns.length > MAX_GAZEBO_PATTERN_COUNT
  ) {
    throw new Error(`${name} must contain 1-${MAX_GAZEBO_PATTERN_COUNT} patterns`)
  }
  const normalized = patterns.map((pattern) => pattern.toLowerCase())
  if (
    normalized.some(
      (pattern) =>
        pattern.length === 0 ||
        pattern.length > MAX_GAZEBO_PATTERN_LENGTH ||
        !/^[a-z0-9]+$/u.test(pattern)
    ) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error(`${name} must contain unique ASCII alphanumeric patterns`)
  }
  return normalized
}

function validatedConfig(
  config: Partial<UseGazeboDronesConfig> & { bridge: TelemetryBridge | null }
): UseGazeboDronesConfig {
  const candidate = { ...DEFAULT_CONFIG, ...config }
  if (
    !Number.isSafeInteger(candidate.throttleRateMs) ||
    candidate.throttleRateMs < 0 ||
    candidate.throttleRateMs > MAX_GAZEBO_THROTTLE_MS
  ) {
    throw new Error(`Gazebo throttleRateMs must be within 0-${MAX_GAZEBO_THROTTLE_MS}`)
  }
  if (
    !Number.isSafeInteger(candidate.maxHistoryLength) ||
    candidate.maxHistoryLength < 1 ||
    candidate.maxHistoryLength > MAX_GAZEBO_HISTORY_LENGTH
  ) {
    throw new Error(`Gazebo maxHistoryLength must be within 1-${MAX_GAZEBO_HISTORY_LENGTH}`)
  }
  return {
    ...candidate,
    droneNamePatterns: validatedPatterns(candidate.droneNamePatterns, 'Gazebo droneNamePatterns'),
    friendlyPatterns: validatedPatterns(candidate.friendlyPatterns, 'Gazebo friendlyPatterns'),
    hostilePatterns: validatedPatterns(candidate.hostilePatterns, 'Gazebo hostilePatterns'),
  }
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
    lastSeenMonotonicMs: performance.now(),
    isArmed: false,
    mode: 'UNKNOWN',
    batteryPercent: 100,
    positionHistory: new CircularBuffer<Point>(historyCapacity),
  }
}

/**
 * Convert the mutable internal store entry to an isolated React snapshot.
 */
function toExternalState(internal: DroneStateInternal): DroneState {
  return {
    id: internal.id,
    name: internal.name,
    type: internal.type,
    status: internal.status,
    pose: {
      position: { ...internal.pose.position },
      orientation: { ...internal.pose.orientation },
    },
    velocity: {
      linear: { ...internal.velocity.linear },
      angular: { ...internal.velocity.angular },
    },
    speed: internal.speed,
    heading: internal.heading,
    altitude: internal.altitude,
    lastUpdate: internal.lastUpdate,
    isArmed: internal.isArmed,
    mode: internal.mode,
    batteryPercent: internal.batteryPercent,
    positionHistory: internal.positionHistory.map((position) => ({ ...position })),
  }
}

function toExternalMap(internal: ReadonlyMap<string, DroneStateInternal>): Map<string, DroneState> {
  const external = new Map<string, DroneState>()
  for (const [id, drone] of internal) external.set(id, toExternalState(drone))
  return external
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useGazeboDrones(
  config: Partial<UseGazeboDronesConfig> & { bridge: TelemetryBridge | null }
): UseGazeboDronesReturn {
  const mergedConfig = validatedConfig(config)
  const { bridge } = mergedConfig
  const bridgeConnected = bridge?.isConnected() ?? false

  // Internal state uses CircularBuffer for O(1) history updates
  const [drones, setDrones] = useState<Map<string, DroneState>>(new Map())
  // Mirror of `dronesInternal` so message handling can compute the next Map
  // outside the setState updater. Updaters must be pure: StrictMode
  // double-invokes them, which would duplicate positionHistory samples.
  const dronesInternalRef = useRef<Map<string, DroneStateInternal>>(new Map())
  const unsubscribesRef = useRef<Array<() => void>>([])

  // Stable config refs to avoid effect re-runs
  const configRef = useRef(mergedConfig)
  configRef.current = mergedConfig

  // Client-side throttle timestamp (works for both ROSBridge and ZenohBridge)
  const lastUpdateRef = useRef<number | null>(null)

  // Subscribe to Gazebo model states
  useEffect(() => {
    if (!bridge || !bridgeConnected) {
      // A disconnected transport cannot keep its last snapshot authoritative.
      // Clear it here instead of waiting for another model-states message that
      // may never arrive after the connection has gone away.
      if (dronesInternalRef.current.size > 0) {
        const emptyDrones = new Map<string, DroneStateInternal>()
        dronesInternalRef.current = emptyDrones
        setDrones(new Map())
      }
      lastUpdateRef.current = null
      return
    }

    // A transport replacement starts a new telemetry generation. Do not let a
    // snapshot or timestamp from the previous bridge remain authoritative.
    if (dronesInternalRef.current.size > 0) {
      dronesInternalRef.current = new Map()
      setDrones(new Map())
    }
    lastUpdateRef.current = null

    const handleModelStates = (msg: ModelStates) => {
      const cfg = configRef.current
      const now = performance.now()

      // Client-side throttle: skip updates that are too frequent
      // This ensures consistent 20Hz updates regardless of transport (ROSBridge or ZenohBridge)
      if (lastUpdateRef.current !== null && now - lastUpdateRef.current < cfg.throttleRateMs) {
        return
      }

      if (!Array.isArray(msg?.name) || !Array.isArray(msg.pose) || !Array.isArray(msg.twist)) {
        log.warn('Rejected malformed Gazebo model-state arrays')
        return
      }

      const timestamp = Date.now()

      // Compute the next Map here (NOT inside the setState updater) so all
      // work — especially the CircularBuffer push — runs exactly once per
      // message; StrictMode double-invokes updaters. Updated drone entries are
      // shallow clones so previous state objects are never mutated.
      const prevDrones = dronesInternalRef.current
      const newDrones = new Map(prevDrones)
      const seenIds = new Set<string>()

      // name/pose/twist are independent parallel arrays from external CDR/ROS
      // data; bound by the shortest so a truncated or malformed message cannot
      // index past the end and throw inside the subscription callback.
      if (msg.name.length !== msg.pose.length || msg.name.length !== msg.twist.length) {
        log.warn('Rejected misaligned Gazebo model-state arrays')
        return
      }
      const candidates: Array<{ name: string; pose: Pose; twist: Twist }> = []
      const candidateIds = new Set<string>()
      for (let i = 0; i < msg.name.length; i++) {
        const name = msg.name[i]
        const pose = msg.pose[i]
        const twist = msg.twist[i]

        // Check if this is a drone based on name patterns
        if (!matchesPattern(name, cfg.droneNamePatterns)) continue
        if (candidateIds.has(name)) {
          log.warn('Rejected Gazebo model states with a duplicate drone identity', { name })
          return
        }
        candidateIds.add(name)
        candidates.push({ name, pose, twist })
        if (candidates.length > MAX_TRACKED_GAZEBO_DRONES) {
          log.warn('Rejected Gazebo model states above the tracked-drone limit', {
            limit: MAX_TRACKED_GAZEBO_DRONES,
          })
          return
        }
      }
      lastUpdateRef.current = now

      for (const { name, pose, twist } of candidates) {
        const id = name
        seenIds.add(id)
        const type = classifyDrone(name, cfg.friendlyPatterns, cfg.hostilePatterns)

        const existing = newDrones.get(id)
        // Clone the mutable store entry. External React state receives a deep
        // snapshot after the full message commits.
        const drone = existing
          ? { ...existing }
          : createDefaultDroneStateInternal(id, name, type, cfg.maxHistoryLength)
        if (drone.positionHistory.size !== cfg.maxHistoryLength) {
          const resized = new CircularBuffer<Point>(cfg.maxHistoryLength)
          for (const position of drone.positionHistory.toArray().slice(-cfg.maxHistoryLength)) {
            resized.push(position)
          }
          drone.positionHistory = resized
        }

        // Calculate derived values
        const euler = quatToEuler(pose.orientation)
        const speed = magnitude(twist.linear)
        const status = determineStatus(pose, twist, speed)

        // O(1) position history update via circular buffer — exactly once per
        // message because this runs outside the setState updater.
        drone.positionHistory.push({ ...pose.position })

        drone.name = name
        drone.type = type
        drone.pose = {
          position: { ...pose.position },
          orientation: { ...pose.orientation },
        }
        drone.velocity = {
          linear: { ...twist.linear },
          angular: { ...twist.angular },
        }
        drone.speed = speed
        drone.heading = euler.yaw
        drone.altitude = pose.position.z
        drone.status = status
        drone.lastUpdate = timestamp
        drone.lastSeenMonotonicMs = now

        newDrones.set(id, drone)
      }

      // Cleanup stale drones that haven't been seen for GAZEBO_DRONE_STALE_MS
      // Prevents unbounded Map growth in long-running sessions with dynamic spawning
      for (const [id, drone] of newDrones) {
        if (!seenIds.has(id) && now - drone.lastSeenMonotonicMs >= GAZEBO_DRONE_STALE_MS) {
          newDrones.delete(id)
        }
      }

      dronesInternalRef.current = newDrones
      setDrones(toExternalMap(newDrones))
    }

    const unsubscribe = bridge.subscribeToModelStates(
      handleModelStates,
      configRef.current.throttleRateMs
    )
    unsubscribesRef.current.push(unsubscribe)

    return () => {
      for (const unsubscribe of unsubscribesRef.current) {
        try {
          unsubscribe()
        } catch (error) {
          log.error('Gazebo model-state unsubscribe callback failed', { error })
        }
      }
      unsubscribesRef.current = []
    }
  }, [bridge, bridgeConnected, mergedConfig.throttleRateMs])

  // A connected socket can remain open while the publisher freezes. Sweep by
  // monotonic age so stale targets disappear even when no later message
  // arrives to trigger the message-driven cleanup above.
  useEffect(() => {
    if (!bridgeConnected) return

    const sweep = () => {
      const timestamp = performance.now()
      const current = dronesInternalRef.current
      let next: Map<string, DroneStateInternal> | null = null
      for (const [id, drone] of current) {
        if (timestamp - drone.lastSeenMonotonicMs >= GAZEBO_DRONE_STALE_MS) {
          next ??= new Map(current)
          next.delete(id)
        }
      }
      if (next) {
        dronesInternalRef.current = next
        setDrones(toExternalMap(next))
      }
    }

    const interval = setInterval(sweep, GAZEBO_STALE_SWEEP_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [bridgeConnected])

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
      if (
        !drone ||
        !Number.isFinite(deltaTimeMs) ||
        deltaTimeMs < 0 ||
        deltaTimeMs > MAX_GAZEBO_PREDICTION_MS
      ) {
        return null
      }

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
