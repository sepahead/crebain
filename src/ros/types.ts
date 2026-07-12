/**
 * CREBAIN ROS Message Types
 * Adaptive Response & Awareness System (ARAS)
 *
 * TypeScript definitions for ROS message types used in drone simulation
 */

// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface Vector3 {
  x: number
  y: number
  z: number
}

export interface Point {
  x: number
  y: number
  z: number
}

export interface Quaternion {
  x: number
  y: number
  z: number
  w: number
}

export interface Pose {
  position: Point
  orientation: Quaternion
}

export interface PoseStamped {
  header: Header
  pose: Pose
}

export interface Twist {
  linear: Vector3
  angular: Vector3
}

export interface TwistStamped {
  header: Header
  twist: Twist
}

export interface Accel {
  linear: Vector3
  angular: Vector3
}

export interface Transform {
  translation: Vector3
  rotation: Quaternion
}

export interface TransformStamped {
  header: Header
  child_frame_id: string
  transform: Transform
}

// ─────────────────────────────────────────────────────────────────────────────
// TF2 MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface TFMessage {
  transforms: TransformStamped[]
}

export interface TF2Error {
  error: number
  error_string: string
}

// TF2 lookup constants
export const TF2_NO_ERROR = 0
export const TF2_LOOKUP_ERROR = 1
export const TF2_CONNECTIVITY_ERROR = 2
export const TF2_EXTRAPOLATION_ERROR = 3
export const TF2_INVALID_ARGUMENT_ERROR = 4
export const TF2_TIMEOUT_ERROR = 5
export const TF2_TRANSFORM_ERROR = 6

// ─────────────────────────────────────────────────────────────────────────────
// STANDARD MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface Header {
  seq?: number
  stamp: Time
  frame_id: string
}

export interface Time {
  secs: number
  nsecs: number
}

export interface Duration {
  secs: number
  nsecs: number
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface Odometry {
  header: Header
  child_frame_id: string
  pose: PoseWithCovariance
  twist: TwistWithCovariance
}

export interface PoseWithCovariance {
  pose: Pose
  covariance: number[] // 36 elements (6x6 matrix)
}

export interface TwistWithCovariance {
  twist: Twist
  covariance: number[] // 36 elements (6x6 matrix)
}

export interface Path {
  header: Header
  poses: PoseStamped[]
}

// ─────────────────────────────────────────────────────────────────────────────
// SENSOR MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface NavSatFix {
  header: Header
  status: NavSatStatus
  latitude: number
  longitude: number
  altitude: number
  position_covariance: number[] // 9 elements (3x3 matrix)
  position_covariance_type: number
}

export interface NavSatStatus {
  status: number // -1: no fix, 0: fix, 1: SBAS, 2: GBAS
  service: number // 1: GPS, 2: GLONASS, 4: COMPASS, 8: GALILEO
}

export interface Imu {
  header: Header
  orientation: Quaternion
  orientation_covariance: number[]
  angular_velocity: Vector3
  angular_velocity_covariance: number[]
  linear_acceleration: Vector3
  linear_acceleration_covariance: number[]
}

export interface BatteryState {
  header: Header
  voltage: number
  current: number
  charge: number
  capacity: number
  design_capacity: number
  percentage: number
  power_supply_status: number
  power_supply_health: number
  power_supply_technology: number
  present: boolean
  cell_voltage: number[]
  location: string
  serial_number: string
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE / CAMERA MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface Image {
  header: Header
  height: number
  width: number
  encoding: string // "rgb8", "rgba8", "bgr8", "mono8", "16UC1", etc.
  is_bigendian: number
  step: number // row length in bytes
  data: number[] | Uint8Array | string // base64 encoded or raw bytes
}

export interface CompressedImage {
  header: Header
  format: string // "jpeg", "png"
  data: number[] | Uint8Array | string // base64 encoded
}

export interface CameraInfo {
  header: Header
  height: number
  width: number
  distortion_model: string
  D: number[] // distortion coefficients
  K: number[] // 3x3 intrinsic camera matrix
  R: number[] // 3x3 rectification matrix
  P: number[] // 3x4 projection matrix
}

// ─────────────────────────────────────────────────────────────────────────────
// THERMAL SENSOR MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface ThermalImage {
  header: Header
  height: number
  width: number
  encoding: string // "16UC1" for raw temperature, "mono8" for normalized
  min_temp_kelvin: number
  max_temp_kelvin: number
  data: number[] | Uint8Array | string
}

export interface ThermalDetection {
  header: Header
  id: string
  position: Point
  temperature_kelvin: number
  signature_area: number // estimated size in m²
  confidence: number
  classification: string
}

export interface ThermalDetectionArray {
  header: Header
  detections: ThermalDetection[]
}

// ─────────────────────────────────────────────────────────────────────────────
// ACOUSTIC SENSOR MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface AudioData {
  header: Header
  sample_rate: number
  channels: number
  bits_per_sample: number
  data: number[] | Uint8Array | string
}

export interface AcousticDetection {
  header: Header
  id: string
  azimuth: number // radians from sensor forward
  elevation: number // radians from horizontal
  range_estimate: number // estimated range in meters
  spl_db: number // sound pressure level in dB
  dominant_frequency_hz: number
  doppler_hz: number // doppler shift for velocity estimation
  confidence: number
  classification: string
}

export interface AcousticDetectionArray {
  header: Header
  detections: AcousticDetection[]
}

export interface MicrophoneArrayInfo {
  header: Header
  num_microphones: number
  sample_rate: number
  positions: Point[] // microphone positions relative to array center
}

// ─────────────────────────────────────────────────────────────────────────────
// RADAR MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface RadarDetection {
  header: Header
  id: string
  range: number // meters
  azimuth: number // radians
  elevation: number // radians
  radial_velocity: number // m/s (positive = approaching)
  rcs_dbsm: number // radar cross section in dBsm
  confidence: number
  classification: string
}

export interface RadarDetectionArray {
  header: Header
  detections: RadarDetection[]
}

export interface RadarTrack {
  header: Header
  id: string
  position: Point
  velocity: Vector3
  position_covariance: number[] // 9 elements
  velocity_covariance: number[] // 9 elements
  rcs_dbsm: number
  classification: string
  track_status: 'tentative' | 'confirmed' | 'coasting' | 'lost'
}

// ─────────────────────────────────────────────────────────────────────────────
// LIDAR MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface PointCloud2 {
  header: Header
  height: number
  width: number
  fields: PointField[]
  is_bigendian: boolean
  point_step: number
  row_step: number
  data: number[] | Uint8Array | string
  is_dense: boolean
}

export interface PointField {
  name: string
  offset: number
  datatype: number
  count: number
}

export interface LidarDetection {
  header: Header
  id: string
  centroid: Point
  bbox_min: Point
  bbox_max: Point
  velocity: Vector3
  num_points: number
  confidence: number
  classification: string
}

export interface LidarDetectionArray {
  header: Header
  detections: LidarDetection[]
}

// ─────────────────────────────────────────────────────────────────────────────
// GAZEBO SPECIFIC MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelState {
  model_name: string
  pose: Pose
  twist: Twist
  reference_frame: string
}

export interface ModelStates {
  name: string[]
  pose: Pose[]
  twist: Twist[]
}

export interface LinkState {
  link_name: string
  pose: Pose
  twist: Twist
  reference_frame: string
}

export interface LinkStates {
  name: string[]
  pose: Pose[]
  twist: Twist[]
}

// ─────────────────────────────────────────────────────────────────────────────
// MAVROS / PX4 MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface State {
  header: Header
  connected: boolean
  armed: boolean
  guided: boolean
  manual_input: boolean
  mode: string
  system_status: number
}

export interface ExtendedState {
  header: Header
  vtol_state: number
  landed_state: number
}

export interface WaypointList {
  waypoints: Waypoint[]
}

export interface Waypoint {
  frame: number
  command: number
  is_current: boolean
  autocontinue: boolean
  param1: number
  param2: number
  param3: number
  param4: number
  x_lat: number
  y_long: number
  z_alt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// CREBAIN CUSTOM MESSAGES
// ─────────────────────────────────────────────────────────────────────────────

export interface DroneTarget {
  id: string
  header: Header
  pose: Pose
  velocity: Twist
  classification: string
  confidence: number
  threat_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  is_hostile: boolean
}

export interface InterceptionCommand {
  header: Header
  target_id: string
  interceptor_id: string
  intercept_point: Point
  time_to_intercept: Duration
  strategy: 'PURSUIT' | 'LEAD' | 'PARALLEL' | 'AMBUSH'
}

export interface InterceptionStatus {
  header: Header
  command: InterceptionCommand
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'ABORTED' | 'FAILED'
  distance_to_target: number
  estimated_time_remaining: Duration
}

// ─────────────────────────────────────────────────────────────────────────────
// ROSBRIDGE PROTOCOL TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface ROSBridgeMessage {
  op: string
  id?: string
  topic?: string
  type?: string
  msg?: unknown
  compression?: string
  throttle_rate?: number
  queue_length?: number
  fragment_size?: number
}

export interface ROSBridgeSubscribe {
  op: 'subscribe'
  id?: string
  topic: string
  type?: string
  throttle_rate?: number
  queue_length?: number
  fragment_size?: number
  compression?: string
}

export interface ROSBridgeUnsubscribe {
  op: 'unsubscribe'
  id?: string
  topic: string
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export type ROSMessageCallback<T> = (message: T) => void

export interface TopicSubscription<T = unknown> {
  topic: string
  type: string
  callback: ROSMessageCallback<T>
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

export function createTime(date: Date = new Date()): Time {
  const ms = date.getTime()
  return {
    secs: Math.floor(ms / 1000),
    nsecs: (ms % 1000) * 1000000,
  }
}

export function timeToDate(time: Time): Date {
  return new Date(time.secs * 1000 + time.nsecs / 1000000)
}

export function createHeader(frameId: string, seq?: number): Header {
  return {
    seq,
    stamp: createTime(),
    frame_id: frameId,
  }
}

export function quaternionToEuler(q: Quaternion): { roll: number; pitch: number; yaw: number } {
  const { x, y, z, w } = q

  // Roll (x-axis rotation)
  const sinr_cosp = 2 * (w * x + y * z)
  const cosr_cosp = 1 - 2 * (x * x + y * y)
  const roll = Math.atan2(sinr_cosp, cosr_cosp)

  // Pitch (y-axis rotation)
  const sinp = 2 * (w * y - z * x)
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp)

  // Yaw (z-axis rotation)
  const siny_cosp = 2 * (w * z + x * y)
  const cosy_cosp = 1 - 2 * (y * y + z * z)
  const yaw = Math.atan2(siny_cosp, cosy_cosp)

  return { roll, pitch, yaw }
}

export function eulerToQuaternion(roll: number, pitch: number, yaw: number): Quaternion {
  const cy = Math.cos(yaw * 0.5)
  const sy = Math.sin(yaw * 0.5)
  const cp = Math.cos(pitch * 0.5)
  const sp = Math.sin(pitch * 0.5)
  const cr = Math.cos(roll * 0.5)
  const sr = Math.sin(roll * 0.5)

  return {
    w: cr * cp * cy + sr * sp * sy,
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
  }
}

export function distanceBetweenPoints(p1: Point, p2: Point): number {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const dz = p2.z - p1.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export function velocityMagnitude(twist: Twist): number {
  const { x, y, z } = twist.linear
  return Math.sqrt(x * x + y * y + z * z)
}
