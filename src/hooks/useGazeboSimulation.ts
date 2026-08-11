/**
 * CREBAIN Gazebo Simulation Hook
 * Adaptive Response & Awareness System (ARAS)
 *
 * Combined telemetry hook for ROS-Gazebo drone observations and local
 * no-authority interception previews.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRosBridge, type UseRosBridgeReturn } from './useRosBridge'
import { GAZEBO_DRONE_STALE_MS, useGazeboDrones, type DroneState } from './useGazeboDrones'
import {
  type InterceptionSystem,
  type InterceptionMission,
  type InterceptionStrategy,
  type TrajectoryPoint,
  createInterceptionSystem,
} from '../simulation/InterceptionSystem'
import {
  type GuidanceController,
  createGuidanceController,
  MAX_GUIDANCE_RATE_HZ,
  type GuidanceProposal,
} from '../ros/GuidanceController'
import type { ConnectionState } from '../ros/ROSBridge'
import { logger } from '../lib/logger'

const log = logger.scope('GazeboSim')

function isFreshDroneObservation(drone: DroneState, timestamp: number = Date.now()): boolean {
  const ageMs = timestamp - drone.lastUpdate
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= GAZEBO_DRONE_STALE_MS
}

function missionsEqual(left: InterceptionMission, right: InterceptionMission): boolean {
  const leftPoint = left.interceptPoint
  const rightPoint = right.interceptPoint
  const pointsEqual =
    leftPoint === null || rightPoint === null
      ? leftPoint === rightPoint
      : leftPoint.x === rightPoint.x && leftPoint.y === rightPoint.y && leftPoint.z === rightPoint.z
  return (
    left.id === right.id &&
    left.targetId === right.targetId &&
    left.interceptorId === right.interceptorId &&
    left.strategy === right.strategy &&
    left.status === right.status &&
    left.startTime === right.startTime &&
    left.timeToIntercept === right.timeToIntercept &&
    left.lastUpdate === right.lastUpdate &&
    pointsEqual
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface UseGazeboSimulationConfig {
  /** Transport layer to use (development default: websocket; production: zenoh). */
  transport: 'websocket' | 'zenoh'
  rosUrl: string
  autoConnect: boolean
  updateIntervalMs: number
  trajectoryDurationSec: number
  /** Enable local guidance preview generation (default: false). */
  enableGuidancePreview: boolean
  /** Local guidance preview rate in Hz (default: 20). */
  guidancePreviewRateHz: number
}

export interface UseGazeboSimulationReturn {
  // Connection
  connectionState: ConnectionState
  /** Active transport instance owned by this hook. */
  bridge: UseRosBridgeReturn['bridge']
  transport: 'websocket' | 'zenoh'
  setTransport: (transport: 'websocket' | 'zenoh') => void
  rosUrl: string
  setRosUrl: (url: string) => void
  connect: () => Promise<void>
  disconnect: () => void
  connectionError: string | null

  // Drones
  allDrones: DroneState[]
  friendlyDrones: DroneState[]
  hostileDrones: DroneState[]
  getDrone: (id: string) => DroneState | undefined

  // Interception
  activeMissions: InterceptionMission[]
  trajectoryPredictions: Map<string, TrajectoryPoint[]>
  initiateIntercept: (
    targetId: string,
    strategy?: InterceptionStrategy
  ) => InterceptionMission | null
  abortMission: (missionId: string) => boolean

  // Guidance
  guidancePreviews: Map<string, GuidanceController>
  lastGuidanceProposals: Map<string, GuidanceProposal>

  // Authority posture
  authority: 'NoAuthority'
  safeAction: 'Hold'

  // Simulation control
  isSimulationActive: boolean
  toggleSimulation: () => void
  holdAllGuidancePreviews: () => void
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: UseGazeboSimulationConfig = {
  // rosbridge is a development-only telemetry adapter. Production defaults to
  // the native, read-only Zenoh path even if a caller omits the transport.
  transport: import.meta.env.DEV ? 'websocket' : 'zenoh',
  rosUrl: 'ws://localhost:9090',
  autoConnect: false,
  updateIntervalMs: 100,
  trajectoryDurationSec: 10,
  enableGuidancePreview: false,
  guidancePreviewRateHz: 20,
}

const MIN_SIMULATION_UPDATE_INTERVAL_MS = 10
const MAX_SIMULATION_UPDATE_INTERVAL_MS = 60_000
const MAX_TRAJECTORY_DURATION_SECONDS = 3_600

function validatedSimulationConfig(
  config: Partial<UseGazeboSimulationConfig>
): UseGazeboSimulationConfig {
  const candidate = { ...DEFAULT_CONFIG, ...config }
  if (candidate.transport !== 'websocket' && candidate.transport !== 'zenoh') {
    throw new Error('Gazebo transport must be websocket or zenoh')
  }
  if (typeof candidate.rosUrl !== 'string' || candidate.rosUrl.length === 0) {
    throw new Error('Gazebo ROS URL must not be empty')
  }
  if (
    typeof candidate.autoConnect !== 'boolean' ||
    typeof candidate.enableGuidancePreview !== 'boolean'
  ) {
    throw new Error('Gazebo simulation flags must be boolean')
  }
  if (
    !Number.isSafeInteger(candidate.updateIntervalMs) ||
    candidate.updateIntervalMs < MIN_SIMULATION_UPDATE_INTERVAL_MS ||
    candidate.updateIntervalMs > MAX_SIMULATION_UPDATE_INTERVAL_MS
  ) {
    throw new Error(
      `Gazebo updateIntervalMs must be within ${MIN_SIMULATION_UPDATE_INTERVAL_MS}-${MAX_SIMULATION_UPDATE_INTERVAL_MS}`
    )
  }
  if (
    !Number.isFinite(candidate.trajectoryDurationSec) ||
    candidate.trajectoryDurationSec <= 0 ||
    candidate.trajectoryDurationSec > MAX_TRAJECTORY_DURATION_SECONDS
  ) {
    throw new Error(
      `Gazebo trajectoryDurationSec must be within (0, ${MAX_TRAJECTORY_DURATION_SECONDS}]`
    )
  }
  if (
    !Number.isFinite(candidate.guidancePreviewRateHz) ||
    candidate.guidancePreviewRateHz < 1 ||
    candidate.guidancePreviewRateHz > MAX_GUIDANCE_RATE_HZ
  ) {
    throw new Error(`Gazebo guidancePreviewRateHz must be within 1-${MAX_GUIDANCE_RATE_HZ}`)
  }
  return candidate
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useGazeboSimulation(
  config: Partial<UseGazeboSimulationConfig> = {}
): UseGazeboSimulationReturn {
  const mergedConfig = validatedSimulationConfig(config)

  // State
  const [transport, setTransport] = useState<'websocket' | 'zenoh'>(mergedConfig.transport)
  const [rosUrl, setRosUrl] = useState(mergedConfig.rosUrl)
  const [isSimulationActive, setIsSimulationActive] = useState(false)
  const [activeMissions, setActiveMissions] = useState<InterceptionMission[]>([])
  const [trajectoryPredictions, setTrajectoryPredictions] = useState<
    Map<string, TrajectoryPoint[]>
  >(new Map())
  const [lastGuidanceProposals, setLastGuidanceProposals] = useState<Map<string, GuidanceProposal>>(
    new Map()
  )
  const [guidancePreviews, setGuidancePreviews] = useState<Map<string, GuidanceController>>(
    new Map()
  )

  // Refs
  const [interceptionSystem] = useState(createInterceptionSystem)
  const interceptionSystemRef = useRef<InterceptionSystem>(interceptionSystem)
  const updateIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const guidancePreviewsRef = useRef<Map<string, GuidanceController>>(new Map())
  const guidancePreviewRateRef = useRef(mergedConfig.guidancePreviewRateHz)
  const syncedTargetIdsRef = useRef<Set<string>>(new Set())
  const syncedInterceptorIdsRef = useRef<Set<string>>(new Set())
  const configRef = useRef(mergedConfig)
  configRef.current = mergedConfig

  // ROS Bridge
  const rosBridge = useRosBridge({
    transport,
    url: rosUrl,
    autoConnect: mergedConfig.autoConnect,
  })
  const disconnectBridge = rosBridge.disconnect

  // Gazebo Drones
  const gazeboDrones = useGazeboDrones({
    bridge: rosBridge.bridge,
  })

  // Publish the interception system's active missions to React state.
  // The system mutates mission objects in place, so published missions are
  // shallow clones; the compare (length + ids + status + lastUpdate) then
  // detects real changes and returns `prev` otherwise, so the idle update loop
  // does not re-render the whole App at 10 Hz with fresh array identities.
  const publishActiveMissions = useCallback(() => {
    const next = interceptionSystemRef.current
      .getActiveMissions()
      .map((mission) => ({ ...mission }))
    setActiveMissions((prev) => {
      const unchanged =
        prev.length === next.length &&
        next.every((mission, i) => {
          const previous = prev[i]
          return missionsEqual(previous, mission)
        })
      if (unchanged) return prev
      return next
    })
  }, [])

  /**
   * Irreversibly discard the current local preview generation.
   *
   * The hook owns its interception system, which retains mission history during
   * the mount. Merely stopping controller timers would let an old ACTIVE mission
   * reappear when simulation or telemetry comes back. Every authority-boundary
   * transition aborts those missions first, then clears every derived snapshot.
   */
  const discardGuidancePreviewGeneration = useCallback(() => {
    const system = interceptionSystemRef.current
    system.abortAllMissions()

    for (const controller of guidancePreviewsRef.current.values()) {
      controller.stop()
    }
    guidancePreviewsRef.current.clear()

    setActiveMissions((previous) => (previous.length === 0 ? previous : []))
    setGuidancePreviews((previous) => (previous.size === 0 ? previous : new Map()))
    setTrajectoryPredictions((previous) => (previous.size === 0 ? previous : new Map()))
    setLastGuidanceProposals((previous) => (previous.size === 0 ? previous : new Map()))
  }, [])

  // Sync the current, fresh Gazebo snapshot with the interception system.
  // Tracking IDs explicitly lets us remove models that disappear instead of
  // leaving actionable ghost targets/interceptors in the singleton system.
  useEffect(() => {
    const system = interceptionSystemRef.current
    const timestamp = Date.now()
    const bridgeIsConnected = rosBridge.isConnected && (rosBridge.bridge?.isConnected() ?? false)
    const isFresh = (drone: DroneState) => isFreshDroneObservation(drone, timestamp)
    const hostileDrones = bridgeIsConnected ? gazeboDrones.hostileDrones.filter(isFresh) : []
    const friendlyDrones = bridgeIsConnected ? gazeboDrones.friendlyDrones.filter(isFresh) : []
    const activeTargetIds = new Set(hostileDrones.map((drone) => drone.id))
    const activeInterceptorIds = new Set(friendlyDrones.map((drone) => drone.id))
    let removedEntity = false

    for (const targetId of syncedTargetIdsRef.current) {
      if (!activeTargetIds.has(targetId)) {
        system.removeTarget(targetId)
        removedEntity = true
      }
    }
    for (const interceptorId of syncedInterceptorIdsRef.current) {
      if (!activeInterceptorIds.has(interceptorId)) {
        system.removeInterceptor(interceptorId)
        removedEntity = true
      }
    }

    for (const drone of hostileDrones) {
      system.updateTarget(drone.id, drone.pose.position, drone.velocity.linear)
    }

    for (const drone of friendlyDrones) {
      const existingInterceptor = system.getInterceptor(drone.id)
      if (existingInterceptor) {
        system.updateInterceptor(drone.id, drone.pose.position, drone.velocity.linear)
      } else {
        system.registerInterceptor(drone.id, drone.pose.position, drone.velocity.linear)
      }
    }

    syncedTargetIdsRef.current.clear()
    activeTargetIds.forEach((id) => syncedTargetIdsRef.current.add(id))
    syncedInterceptorIdsRef.current.clear()
    activeInterceptorIds.forEach((id) => syncedInterceptorIdsRef.current.add(id))

    if (removedEntity) {
      publishActiveMissions()
    }
  }, [
    gazeboDrones.hostileDrones,
    gazeboDrones.friendlyDrones,
    publishActiveMissions,
    rosBridge.bridge,
    rosBridge.isConnected,
  ])

  // Release this hook's models on unmount as well as on ordinary
  // disconnect/model-removal transitions.
  useEffect(() => {
    const system = interceptionSystemRef.current
    const targetIds = syncedTargetIdsRef.current
    const interceptorIds = syncedInterceptorIdsRef.current

    return () => {
      for (const targetId of targetIds) {
        system.removeTarget(targetId)
      }
      for (const interceptorId of interceptorIds) {
        system.removeInterceptor(interceptorId)
      }
      targetIds.clear()
      interceptorIds.clear()
    }
  }, [])

  // Manage guidance controllers for active missions.
  // This effect only diffs controllers against the current active interceptor
  // ids — it must NOT stop all controllers on dep change, because
  // `activeMissions` refreshes at the update-loop rate while missions run.
  // Stop-all lives in a separate unmount-only effect below.
  useEffect(() => {
    const cfg = configRef.current
    const controllers = guidancePreviewsRef.current
    let snapshotChanged = false

    if (guidancePreviewRateRef.current !== cfg.guidancePreviewRateHz) {
      for (const controller of controllers.values()) {
        controller.setConfig({ rateHz: cfg.guidancePreviewRateHz })
      }
      guidancePreviewRateRef.current = cfg.guidancePreviewRateHz
    }

    if (
      !isSimulationActive ||
      !rosBridge.bridge ||
      !rosBridge.isConnected ||
      !cfg.enableGuidancePreview
    ) {
      discardGuidancePreviewGeneration()
      return
    }

    // Get current active mission interceptor IDs
    const activeInterceptorIds = new Set(
      activeMissions.filter((m) => m.status === 'ACTIVE').map((m) => m.interceptorId)
    )

    // Create controllers for new missions
    for (const mission of activeMissions) {
      if (mission.status !== 'ACTIVE') continue

      const interceptorId = mission.interceptorId
      if (!controllers.has(interceptorId)) {
        const controller = createGuidanceController({
          rateHz: cfg.guidancePreviewRateHz,
        })

        // Store local proposals for inspection; this callback has no transport.
        controller.onProposal((proposal) => {
          setLastGuidanceProposals((prev) => {
            const updated = new Map(prev)
            updated.set(interceptorId, proposal)
            return updated
          })
        })

        controller.startPreview()
        controllers.set(interceptorId, controller)
        snapshotChanged = true
      }
    }

    // Stop controllers for completed/aborted missions
    for (const [interceptorId, controller] of controllers) {
      if (!activeInterceptorIds.has(interceptorId)) {
        controller.stop()
        controllers.delete(interceptorId)
        snapshotChanged = true
      }
    }

    if (snapshotChanged) setGuidancePreviews(new Map(controllers))
  }, [
    activeMissions,
    discardGuidancePreviewGeneration,
    isSimulationActive,
    mergedConfig.enableGuidancePreview,
    mergedConfig.guidancePreviewRateHz,
    rosBridge.bridge,
    rosBridge.isConnected,
  ])

  // Stop all guidance previews on unmount only.
  useEffect(() => {
    // Stable ref Map; captured once so cleanup avoids reading ref.current.
    const controllers = guidancePreviewsRef.current
    return () => {
      for (const controller of controllers.values()) {
        controller.stop()
      }
      controllers.clear()
    }
  }, [])

  // Update local guidance previews with the latest observation data.
  useEffect(() => {
    const system = interceptionSystemRef.current

    for (const mission of activeMissions) {
      if (mission.status !== 'ACTIVE') continue

      const controller = guidancePreviewsRef.current.get(mission.interceptorId)
      if (!controller) continue

      // Get guidance command from interception system
      const guidance = system.getGuidanceCommand(mission.interceptorId)
      if (guidance) {
        controller.setPreviewVelocity(guidance)
      }

      // Update controller with current drone position for PD feedback
      const drone = gazeboDrones.getDrone(mission.interceptorId)
      if (drone) {
        controller.updateCurrentPosition(drone.pose.position, drone.velocity.linear)
      }
    }
  }, [activeMissions, gazeboDrones])

  // Update loop for missions and trajectories
  useEffect(() => {
    if (!isSimulationActive) {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current)
        updateIntervalRef.current = null
      }
      return
    }

    const updateSimulation = () => {
      const system = interceptionSystemRef.current
      const cfg = configRef.current

      // Update active missions
      const missionsBeforeUpdate = system.getActiveMissions()
      for (const mission of missionsBeforeUpdate) {
        system.updateMission(mission.id)
      }
      publishActiveMissions()

      // Selective trajectory prediction - only for active mission targets
      // This reduces computation by ~80% compared to predicting all hostiles
      const activeTargetIds = new Set(system.getActiveMissions().map((mission) => mission.targetId))

      const newPredictions = new Map<string, TrajectoryPoint[]>()
      for (const targetId of activeTargetIds) {
        const trajectory = system.predictTargetTrajectory(targetId, cfg.trajectoryDurationSec)
        if (trajectory.length > 0) {
          newPredictions.set(targetId, trajectory)
        }
      }
      // Trajectories are recomputed from live drone state, so any non-empty
      // prediction set is genuinely new; only the (common, idle) empty→empty
      // transition keeps the previous Map identity to avoid 10 Hz re-renders.
      setTrajectoryPredictions((prev) =>
        prev.size === 0 && newPredictions.size === 0 ? prev : newPredictions
      )
    }

    updateIntervalRef.current = setInterval(updateSimulation, configRef.current.updateIntervalMs)

    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current)
        updateIntervalRef.current = null
      }
    }
  }, [isSimulationActive, mergedConfig.updateIntervalMs, publishActiveMissions])

  // Initiate intercept
  const initiateIntercept = useCallback(
    (targetId: string, strategy: InterceptionStrategy = 'LEAD'): InterceptionMission | null => {
      const system = interceptionSystemRef.current

      if (!isSimulationActive) {
        log.warn('Cannot initiate a local intercept preview while simulation is inactive', {
          targetId,
        })
        return null
      }

      if (!rosBridge.bridge || !rosBridge.isConnected || !rosBridge.bridge.isConnected()) {
        log.warn('Cannot initiate intercept while ROS is disconnected', { targetId })
        return null
      }

      const target = gazeboDrones.hostileDrones.find((drone) => drone.id === targetId)
      if (!target || !isFreshDroneObservation(target)) {
        log.warn('Cannot initiate intercept for missing or stale target', { targetId })
        return null
      }

      // Find best available interceptor
      const assignment = system.assignBestInterceptor(targetId, strategy)
      if (!assignment) {
        log.warn('No available interceptor for target', { targetId })
        return null
      }

      // Create and activate mission
      const mission = system.createMission(assignment.interceptorId, targetId, strategy)

      if (mission) {
        if (!system.activateMission(mission.id)) return null
        publishActiveMissions()
        // Guidance controller will be created automatically by the effect
        // when activeMissions state updates
        return system.getMission(mission.id) ?? null
      }

      return null
    },
    [
      gazeboDrones.hostileDrones,
      isSimulationActive,
      publishActiveMissions,
      rosBridge.bridge,
      rosBridge.isConnected,
    ]
  )

  // Abort mission
  const abortMission = useCallback(
    (missionId: string): boolean => {
      const system = interceptionSystemRef.current
      const success = system.abortMission(missionId)
      if (success) {
        publishActiveMissions()
      }
      return success
    },
    [publishActiveMissions]
  )

  // Toggle simulation
  const toggleSimulation = useCallback(() => {
    if (isSimulationActive) discardGuidancePreviewGeneration()
    setIsSimulationActive((previous) => !previous)
  }, [discardGuidancePreviewGeneration, isSimulationActive])

  const disconnect = useCallback(() => {
    discardGuidancePreviewGeneration()
    disconnectBridge()
  }, [discardGuidancePreviewGeneration, disconnectBridge])

  const selectTransport = useCallback(
    (nextTransport: 'websocket' | 'zenoh') => {
      if (nextTransport !== transport) discardGuidancePreviewGeneration()
      setTransport(nextTransport)
    },
    [discardGuidancePreviewGeneration, transport]
  )

  const selectRosUrl = useCallback(
    (nextUrl: string) => {
      if (nextUrl !== rosUrl) discardGuidancePreviewGeneration()
      setRosUrl(nextUrl)
    },
    [discardGuidancePreviewGeneration, rosUrl]
  )

  const holdAllGuidancePreviews = useCallback(() => {
    for (const controller of guidancePreviewsRef.current.values()) {
      controller.hold()
    }
  }, [])

  return {
    // Connection
    connectionState: rosBridge.state,
    bridge: rosBridge.bridge,
    transport,
    setTransport: selectTransport,
    rosUrl,
    setRosUrl: selectRosUrl,
    connect: rosBridge.connect,
    disconnect,
    connectionError: rosBridge.error,

    // Drones
    allDrones: Array.from(gazeboDrones.drones.values()),
    friendlyDrones: gazeboDrones.friendlyDrones,
    hostileDrones: gazeboDrones.hostileDrones,
    getDrone: gazeboDrones.getDrone,

    // Interception
    activeMissions,
    trajectoryPredictions,
    initiateIntercept,
    abortMission,

    // Guidance
    guidancePreviews,
    lastGuidanceProposals,

    // Authority posture
    authority: 'NoAuthority',
    safeAction: 'Hold',

    // Simulation control
    isSimulationActive,
    toggleSimulation,
    holdAllGuidancePreviews,
  }
}

export default useGazeboSimulation
