/**
 * CREBAIN Waypoint Manager
 * Adaptive Response & Awareness System (ARAS)
 *
 * MAVROS waypoint mission management
 * Supports mission upload, progress tracking, and geofencing
 */

import type { ROSBridge } from './ROSBridge'
import type { Waypoint, WaypointList, NavSatFix } from './types'
import { rosLogger as log } from '../lib/logger'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface MissionItem {
  /** Sequence number */
  seq: number
  /** Coordinate frame (see MAV_FRAME) */
  frame: WaypointFrame
  /** Command (see MAV_CMD) */
  command: WaypointCommand
  /** Is current waypoint */
  isCurrent: boolean
  /** Auto-continue to next waypoint */
  autoContinue: boolean
  /** Hold time in seconds (loiter) */
  holdTime?: number
  /** Acceptance radius in meters */
  acceptRadius?: number
  /** Pass radius (0 = through, >0 = orbit) */
  passRadius?: number
  /** Yaw angle in degrees */
  yaw?: number
  /** Latitude or X position */
  latitude: number
  /** Longitude or Y position */
  longitude: number
  /** Altitude in meters */
  altitude: number
}

export interface Mission {
  id: string
  name: string
  items: MissionItem[]
  isUploaded: boolean
  isActive: boolean
  currentIndex: number
}

export interface MissionProgress {
  missionId: string
  currentWaypoint: number
  totalWaypoints: number
  distanceToNext: number
  isComplete: boolean
}

export interface GeofencePoint {
  latitude: number
  longitude: number
}

export interface Geofence {
  enabled: boolean
  type: 'circle' | 'polygon'
  center?: { latitude: number; longitude: number }
  radius?: number
  polygon?: GeofencePoint[]
  action: 'report' | 'rtl' | 'land' | 'hold'
}

// Coordinate frames
export enum WaypointFrame {
  GLOBAL = 0,
  LOCAL_NED = 1,
  MISSION = 2,
  GLOBAL_RELATIVE_ALT = 3,
  LOCAL_ENU = 4,
  GLOBAL_INT = 5,
  GLOBAL_RELATIVE_ALT_INT = 6,
  LOCAL_OFFSET_NED = 7,
  BODY_NED = 8,
  BODY_OFFSET_NED = 9,
  GLOBAL_TERRAIN_ALT = 10,
  GLOBAL_TERRAIN_ALT_INT = 11,
}

// MAVLink commands
export enum WaypointCommand {
  NAV_WAYPOINT = 16,
  NAV_LOITER_UNLIM = 17,
  NAV_LOITER_TURNS = 18,
  NAV_LOITER_TIME = 19,
  NAV_RETURN_TO_LAUNCH = 20,
  NAV_LAND = 21,
  NAV_TAKEOFF = 22,
  NAV_LOITER_TO_ALT = 31,
  NAV_ROI = 80,
  NAV_PATHPLANNING = 81,
  NAV_SPLINE_WAYPOINT = 82,
  NAV_VTOL_TAKEOFF = 84,
  NAV_VTOL_LAND = 85,
  CONDITION_DELAY = 112,
  CONDITION_CHANGE_ALT = 113,
  CONDITION_DISTANCE = 114,
  CONDITION_YAW = 115,
  DO_SET_MODE = 176,
  DO_JUMP = 177,
  DO_CHANGE_SPEED = 178,
  DO_SET_HOME = 179,
  DO_SET_RELAY = 181,
  DO_REPEAT_RELAY = 182,
  DO_SET_SERVO = 183,
  DO_REPEAT_SERVO = 184,
  DO_CONTROL_VIDEO = 200,
  DO_SET_ROI = 201,
  DO_MOUNT_CONTROL = 205,
}

export type MissionCallback = (progress: MissionProgress) => void

// ─────────────────────────────────────────────────────────────────────────────
// MAVROS SERVICES
// ─────────────────────────────────────────────────────────────────────────────

const MAVROS_SERVICES = {
  WP_PUSH: '/mavros/mission/push',
  WP_PULL: '/mavros/mission/pull',
  WP_CLEAR: '/mavros/mission/clear',
  WP_SET_CURRENT: '/mavros/mission/set_current',
  SET_MODE: '/mavros/set_mode',
} as const

const MAVROS_TOPICS = {
  WP_REACHED: '/mavros/mission/reached',
  WP_WAYPOINTS: '/mavros/mission/waypoints',
  CURRENT_WP: '/mavros/mission/current',
  GLOBAL_POS: '/mavros/global_position/global',
} as const

const MISSION_DOWNLOAD_TIMEOUT_MS = 5_000

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate Haversine distance between two points in meters
 */
function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371e3 // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180
  const phi2 = (lat2 * Math.PI) / 180
  const dPhi = ((lat2 - lat1) * Math.PI) / 180
  const dLambda = ((lon2 - lon1) * Math.PI) / 180

  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return R * c
}

// ─────────────────────────────────────────────────────────────────────────────
// WAYPOINT MANAGER
// ─────────────────────────────────────────────────────────────────────────────

export class WaypointManager {
  private bridge: ROSBridge | null = null
  private namespace: string = ''
  private missions: Map<string, Mission> = new Map()
  private activeMission: Mission | null = null
  private currentWaypoint: number = 0
  private currentPosition: { latitude: number; longitude: number; altitude: number } | null = null
  private callbacks: Set<MissionCallback> = new Set()
  private unsubscribes: Array<() => void> = []
  private missionIdCounter: number = 0

  // ───────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Connect to MAVROS
   */
  connect(bridge: ROSBridge, namespace: string = ''): void {
    this.bridge = bridge
    this.namespace = namespace

    // Subscribe to waypoint reached
    const unsubReached = bridge.subscribe<{ wp_seq: number }>(
      this.prefixTopic(MAVROS_TOPICS.WP_REACHED),
      'mavros_msgs/WaypointReached',
      (msg) => this.handleWaypointReached(msg.wp_seq)
    )
    this.unsubscribes.push(unsubReached)

    // Subscribe to current waypoint
    const unsubCurrent = bridge.subscribe<{ data: number }>(
      this.prefixTopic(MAVROS_TOPICS.CURRENT_WP),
      'std_msgs/UInt16',
      (msg) => {
        this.currentWaypoint = msg.data
        this.notifyProgress()
      }
    )
    this.unsubscribes.push(unsubCurrent)

    // Subscribe to global position for distance calculations
    const unsubGlobalPos = bridge.subscribe<NavSatFix>(
      this.prefixTopic(MAVROS_TOPICS.GLOBAL_POS),
      'sensor_msgs/NavSatFix',
      (msg) => {
        this.currentPosition = {
          latitude: msg.latitude,
          longitude: msg.longitude,
          altitude: msg.altitude,
        }
        // Only notify progress periodically or if we're moving?
        // For now, let's not spam callbacks on every GPS update unless needed.
        // But the UI expects distance updates.
        this.notifyProgress()
      }
    )
    this.unsubscribes.push(unsubGlobalPos)
  }

  /**
   * Disconnect from MAVROS
   */
  disconnect(): void {
    for (const unsub of this.unsubscribes) {
      unsub()
    }
    this.unsubscribes = []
    this.bridge = null
    this.activeMission = null
    this.currentPosition = null
  }

  private prefixTopic(topic: string): string {
    return this.namespace ? `${this.namespace}${topic}` : topic
  }

  private prefixService(service: string): string {
    return this.namespace ? `${this.namespace}${service}` : service
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MISSION CREATION
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create a new mission
   */
  createMission(name: string, items?: MissionItem[]): Mission {
    const mission: Mission = {
      id: `mission_${++this.missionIdCounter}`,
      name,
      items: items || [],
      isUploaded: false,
      isActive: false,
      currentIndex: 0,
    }

    this.missions.set(mission.id, mission)
    return mission
  }

  /**
   * Add a waypoint to a mission
   */
  addWaypoint(
    missionId: string,
    latitude: number,
    longitude: number,
    altitude: number,
    options: Partial<MissionItem> = {}
  ): boolean {
    const mission = this.missions.get(missionId)
    if (!mission) return false

    const item: MissionItem = {
      seq: mission.items.length,
      frame: options.frame ?? WaypointFrame.GLOBAL_RELATIVE_ALT,
      command: options.command ?? WaypointCommand.NAV_WAYPOINT,
      isCurrent: mission.items.length === 0,
      autoContinue: options.autoContinue ?? true,
      holdTime: options.holdTime,
      acceptRadius: options.acceptRadius,
      passRadius: options.passRadius,
      yaw: options.yaw,
      latitude,
      longitude,
      altitude,
    }

    mission.items.push(item)
    mission.isUploaded = false
    return true
  }

  /**
   * Add a takeoff waypoint
   */
  addTakeoff(
    missionId: string,
    altitude: number,
    latitude?: number,
    longitude?: number
  ): boolean {
    return this.addWaypoint(missionId, latitude || 0, longitude || 0, altitude, {
      command: WaypointCommand.NAV_TAKEOFF,
    })
  }

  /**
   * Add a landing waypoint
   */
  addLanding(
    missionId: string,
    latitude: number,
    longitude: number,
    altitude: number = 0
  ): boolean {
    return this.addWaypoint(missionId, latitude, longitude, altitude, {
      command: WaypointCommand.NAV_LAND,
    })
  }

  /**
   * Add a loiter (hold) waypoint
   */
  addLoiter(
    missionId: string,
    latitude: number,
    longitude: number,
    altitude: number,
    durationSeconds: number
  ): boolean {
    return this.addWaypoint(missionId, latitude, longitude, altitude, {
      command: WaypointCommand.NAV_LOITER_TIME,
      holdTime: durationSeconds,
    })
  }

  /**
   * Add return to launch
   */
  addReturnToLaunch(missionId: string): boolean {
    return this.addWaypoint(missionId, 0, 0, 0, {
      command: WaypointCommand.NAV_RETURN_TO_LAUNCH,
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MISSION UPLOAD / DOWNLOAD
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Upload mission to drone
   */
  async uploadMission(missionId: string): Promise<boolean> {
    if (!this.bridge) return false

    const mission = this.missions.get(missionId)
    if (!mission || mission.items.length === 0) return false

    const waypoints: Waypoint[] = mission.items.map((item, index) => ({
      frame: item.frame,
      command: item.command,
      is_current: index === 0,
      autocontinue: item.autoContinue,
      param1: item.holdTime || 0,
      param2: item.acceptRadius || 0,
      param3: item.passRadius || 0,
      param4: item.yaw || 0,
      x_lat: item.latitude,
      y_long: item.longitude,
      z_alt: item.altitude,
    }))

    try {
      const response = await this.bridge.callService<
        { start_index: number; waypoints: Waypoint[] },
        { success: boolean; wp_transfered: number }
      >(this.prefixService(MAVROS_SERVICES.WP_PUSH), {
        start_index: 0,
        waypoints,
      })

      if (response.success) {
        mission.isUploaded = true
        return true
      }
      return false
    } catch (error) {
      log.error('Failed to upload mission', { error })
      return false
    }
  }

  /**
   * Download current mission from drone
   */
  async downloadMission(): Promise<Mission | null> {
    if (!this.bridge) return null

    const waypointSubscription: { unsubscribe?: () => void; timeout?: ReturnType<typeof setTimeout> } = {}
    try {
      let resolveWaypoints: (waypoints: Waypoint[]) => void = () => {}
      const waypointListPromise = new Promise<Waypoint[]>((resolve) => {
        resolveWaypoints = resolve
      })
      waypointSubscription.timeout = setTimeout(() => resolveWaypoints([]), MISSION_DOWNLOAD_TIMEOUT_MS)
      waypointSubscription.unsubscribe = this.bridge.subscribe<WaypointList>(
        this.prefixTopic(MAVROS_TOPICS.WP_WAYPOINTS),
        'mavros_msgs/WaypointList',
        (msg) => {
          if (waypointSubscription.timeout) {
            clearTimeout(waypointSubscription.timeout)
            waypointSubscription.timeout = undefined
          }
          resolveWaypoints(msg.waypoints)
        }
      )

      const response = await this.bridge.callService<
        Record<string, never>,
        { success: boolean; wp_received: number }
      >(this.prefixService(MAVROS_SERVICES.WP_PULL), {})

      if (!response.success) return null
      if (!Number.isSafeInteger(response.wp_received) || response.wp_received < 0) {
        log.warn('Mission download received invalid waypoint count', { received: response.wp_received })
        return null
      }

      const waypoints = response.wp_received > 0 ? await waypointListPromise : []
      if (waypoints.length < response.wp_received) {
        log.warn('Mission download did not receive the expected waypoint list before timeout', {
          expected: response.wp_received,
          received: waypoints.length,
        })
        return null
      }

      const mission = this.createMission(
        'Downloaded Mission',
        waypoints.map((waypoint, index) => this.waypointToMissionItem(waypoint, index))
      )
      mission.isUploaded = true
      return mission
    } catch (error) {
      log.error('Failed to download mission', { error })
      return null
    } finally {
      if (waypointSubscription.timeout) {
        clearTimeout(waypointSubscription.timeout)
      }
      waypointSubscription.unsubscribe?.()
    }
  }

  private waypointToMissionItem(waypoint: Waypoint, index: number): MissionItem {
    return {
      seq: index,
      frame: waypoint.frame as WaypointFrame,
      command: waypoint.command as WaypointCommand,
      isCurrent: waypoint.is_current,
      autoContinue: waypoint.autocontinue,
      holdTime: waypoint.param1,
      acceptRadius: waypoint.param2,
      passRadius: waypoint.param3,
      yaw: waypoint.param4,
      latitude: waypoint.x_lat,
      longitude: waypoint.y_long,
      altitude: waypoint.z_alt,
    }
  }

  /**
   * Clear mission on drone
   */
  async clearMission(): Promise<boolean> {
    if (!this.bridge) return false

    try {
      const response = await this.bridge.callService<
        Record<string, never>,
        { success: boolean }
      >(this.prefixService(MAVROS_SERVICES.WP_CLEAR), {})

      return response.success
    } catch (error) {
      log.error('Failed to clear mission', { error })
      return false
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MISSION EXECUTION
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Start mission execution
   */
  async startMission(missionId: string): Promise<boolean> {
    if (!this.bridge) return false

    const mission = this.missions.get(missionId)
    if (!mission) return false

    // Upload if not already uploaded
    if (!mission.isUploaded) {
      const uploaded = await this.uploadMission(missionId)
      if (!uploaded) return false
    }

    // Set mode to AUTO
    try {
      await this.bridge.callService(this.prefixService(MAVROS_SERVICES.SET_MODE), {
        custom_mode: 'AUTO.MISSION',
      })

      mission.isActive = true
      this.activeMission = mission
      this.notifyProgress()
      return true
    } catch (error) {
      log.error('Failed to start mission', { error })
      return false
    }
  }

  /**
   * Jump to a specific waypoint
   */
  async setCurrentWaypoint(waypointIndex: number): Promise<boolean> {
    if (!this.bridge) return false

    try {
      const response = await this.bridge.callService<
        { wp_seq: number },
        { success: boolean }
      >(this.prefixService(MAVROS_SERVICES.WP_SET_CURRENT), {
        wp_seq: waypointIndex,
      })

      return response.success
    } catch (error) {
      log.error('Failed to set current waypoint', { error })
      return false
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PROGRESS TRACKING
  // ───────────────────────────────────────────────────────────────────────────

  private handleWaypointReached(waypointSeq: number): void {
    if (!this.activeMission) return

    this.activeMission.currentIndex = waypointSeq

    // Check if mission complete
    if (waypointSeq >= this.activeMission.items.length - 1) {
      this.activeMission.isActive = false
    }

    this.notifyProgress()
  }

  /**
   * Register a progress callback
   */
  onProgress(callback: MissionCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  private notifyProgress(): void {
    if (!this.activeMission) return

    let distanceToNext = 0
    if (this.currentPosition && this.activeMission.items.length > this.currentWaypoint) {
      const targetWp = this.activeMission.items[this.currentWaypoint]
      
      // Check if target is in a compatible frame (Lat/Lon)
      // Most MAVROS missions use GLOBAL or GLOBAL_RELATIVE_ALT
      if (
        targetWp.frame === WaypointFrame.GLOBAL || 
        targetWp.frame === WaypointFrame.GLOBAL_RELATIVE_ALT ||
        targetWp.frame === WaypointFrame.GLOBAL_INT ||
        targetWp.frame === WaypointFrame.GLOBAL_RELATIVE_ALT_INT
      ) {
        distanceToNext = calculateHaversineDistance(
          this.currentPosition.latitude,
          this.currentPosition.longitude,
          targetWp.latitude,
          targetWp.longitude
        )
      }
    }

    const progress: MissionProgress = {
      missionId: this.activeMission.id,
      currentWaypoint: this.currentWaypoint,
      totalWaypoints: this.activeMission.items.length,
      distanceToNext,
      isComplete: this.currentWaypoint >= this.activeMission.items.length - 1,
    }

    for (const callback of this.callbacks) {
      try {
        callback(progress)
      } catch (error) {
        log.error('Callback error', { error })
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ACCESSORS
  // ───────────────────────────────────────────────────────────────────────────

  getMission(id: string): Mission | undefined {
    return this.missions.get(id)
  }

  getAllMissions(): Mission[] {
    return Array.from(this.missions.values())
  }

  getActiveMission(): Mission | null {
    return this.activeMission
  }

  getCurrentWaypoint(): number {
    return this.currentWaypoint
  }

  deleteMission(id: string): boolean {
    const mission = this.missions.get(id)
    if (!mission) return false

    if (mission === this.activeMission) {
      this.activeMission = null
    }

    return this.missions.delete(id)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

export function createWaypointManager(): WaypointManager {
  return new WaypointManager()
}
