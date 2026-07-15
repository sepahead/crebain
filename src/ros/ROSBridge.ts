/**
 * CREBAIN ROS Bridge Client
 * Adaptive Response & Awareness System (ARAS)
 *
 * WebSocket client for rosbridge_suite with auto-reconnect
 */

import type {
  ROSBridgeMessage,
  ROSMessageCallback,
  ConnectionState,
  ModelStates,
  Odometry,
  Pose,
  PoseStamped,
  State,
  Twist,
  Vector3,
  Quaternion,
} from './types'
import { namespacedRosTopic } from './utils'
import { rosLogger as log } from '../lib/logger'
import { validateGazeboPose, validateGazeboTwist } from './gazeboValidation'
import {
  isValidTfFrameId,
  normalizeIngressTfTransform,
} from './tfValidation'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type { ConnectionState } from './types'

/** Raw renderer rosbridge is available only in Vite development and tests. */
export const RENDERER_ROSBRIDGE_AVAILABLE = true

export interface ROSBridgeConfig {
  url: string
  autoReconnect: boolean
  reconnectIntervalMs: number
  maxReconnectAttempts: number
  /** Inbound UTF-8 byte bound, capped by MAX_RENDERER_ROSBRIDGE_MESSAGE_BYTES. */
  maxIncomingMessageBytes: number
  onConnect?: () => void
  onDisconnect?: () => void
  onError?: (error: Error) => void
  onStateChange?: (state: ConnectionState) => void
}

interface Subscription {
  id: string
  topic: string
  type: string
  callback: ROSMessageCallback<unknown>
  validator: ROSMessageValidator
  throttleRate?: number
  queueLength?: number
}

export type ROSMessageValidator = (message: unknown) => boolean

// ─────────────────────────────────────────────────────────────────────────────
// ROS BRIDGE CLIENT
// ─────────────────────────────────────────────────────────────────────────────

// Allowed URL schemes for ROS bridge connections
const ALLOWED_SCHEMES = ['ws:', 'wss:']
const MAX_ROS_NAME_LENGTH = 256
const ROS_GRAPH_NAME_PATTERN = /^\/[A-Za-z0-9_/]+$/
const ROS_MESSAGE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*\/[A-Za-z][A-Za-z0-9_]*$/
/** Matches the native rosbridge bound: one 64 MiB image plus JSON overhead. */
export const MAX_RENDERER_ROSBRIDGE_MESSAGE_BYTES = Math.ceil((64 * 1024 * 1024) / 3) * 4 + 64 * 1024
const MAX_JSON_NESTING_DEPTH = 64
const MAX_JSON_CONTAINER_ENTRIES = 10_000
const MAX_SUBSCRIPTIONS_PER_TOPIC = 256
const MAX_SUBSCRIPTIONS = 1_024
const MAX_PROTOCOL_ID_LENGTH = 128
const MAX_STATUS_MESSAGE_LENGTH = 4_096
const MAX_SENSOR_MEASUREMENT_VARIANCE = 1_000_000_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateRosGraphName(name: string, kind: 'topic' | 'service'): void {
  if (name.length === 0 || name.trim() !== name) {
    throw new Error(`Invalid ROS ${kind}: name must not be empty or padded`)
  }
  if (name.length > MAX_ROS_NAME_LENGTH) {
    throw new Error(`Invalid ROS ${kind}: name exceeds ${MAX_ROS_NAME_LENGTH} characters`)
  }
  if (name === '/' || !name.startsWith('/')) {
    throw new Error(`Invalid ROS ${kind}: name must be absolute`)
  }
  if (name.includes('//') || name.includes('\0') || /\s/.test(name) || !ROS_GRAPH_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid ROS ${kind}: name contains invalid characters`)
  }
}

function validateRosMessageType(type: string): void {
  if (!ROS_MESSAGE_TYPE_PATTERN.test(type)) {
    throw new Error('Invalid ROS message type')
  }
}

function validateNonNegativeNumber(value: number | undefined, field: string): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff)
  ) {
    throw new Error(`Invalid ROS ${field}: value must be a non-negative int32`)
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed
): boolean {
  const allowedKeys = new Set(allowed)
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedString(value: unknown, maximumLength = MAX_ROS_NAME_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maximumLength && !value.includes('\0')
}

function isFiniteNumberArray(value: unknown, expectedLength?: number, maximumLength = 10_000): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumLength &&
    (expectedLength === undefined || value.length === expectedLength) &&
    value.every(isFiniteNumber)
  )
}

function isRosTime(value: unknown): boolean {
  if (!isRecord(value)) return false
  const ros1 = hasOnlyKeys(value, ['secs', 'nsecs'])
  const ros2 = hasOnlyKeys(value, ['sec', 'nanosec'])
  if (!ros1 && !ros2) return false
  const seconds = ros1 ? value.secs : value.sec
  const nanoseconds = ros1 ? value.nsecs : value.nanosec
  return (
    isSafeNonNegativeInteger(seconds) &&
    isSafeNonNegativeInteger(nanoseconds) &&
    nanoseconds < 1_000_000_000
  )
}

function isHeader(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['seq', 'stamp', 'frame_id'], ['stamp', 'frame_id']) &&
    (value.seq === undefined || isSafeNonNegativeInteger(value.seq)) &&
    isRosTime(value.stamp) &&
    isBoundedString(value.frame_id)
  )
}

function isVector3(value: unknown): value is Vector3 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['x', 'y', 'z']) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z)
  )
}

function isQuaternion(value: unknown): value is Quaternion {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['x', 'y', 'z', 'w']) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.z) &&
    isFiniteNumber(value.w)
  )
}

function isPose(value: unknown): value is Pose {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['position', 'orientation']) ||
    !isVector3(value.position) ||
    !isQuaternion(value.orientation)
  ) {
    return false
  }

  try {
    validateGazeboPose({
      position: value.position,
      orientation: value.orientation,
    })
    return true
  } catch {
    return false
  }
}

function isTwist(value: unknown): value is Twist {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['linear', 'angular']) ||
    !isVector3(value.linear) ||
    !isVector3(value.angular)
  ) {
    return false
  }

  try {
    validateGazeboTwist({
      linear: value.linear,
      angular: value.angular,
    })
    return true
  } catch {
    return false
  }
}

function isPoseWithCovariance(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['pose', 'covariance']) &&
    isPose(value.pose) &&
    isFiniteNumberArray(value.covariance, 36)
  )
}

function isTwistWithCovariance(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['twist', 'covariance']) &&
    isTwist(value.twist) &&
    isFiniteNumberArray(value.covariance, 36)
  )
}

function isBytePayload(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) &&
      value.length <= MAX_JSON_CONTAINER_ENTRIES &&
      value.every((byte) => Number.isSafeInteger(byte) && byte >= 0 && byte <= 255))
  )
}

function isRawImage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'header',
      'height',
      'width',
      'encoding',
      'is_bigendian',
      'step',
      'data',
    ]) &&
    isHeader(value.header) &&
    isSafeNonNegativeInteger(value.height) &&
    isSafeNonNegativeInteger(value.width) &&
    isBoundedString(value.encoding, 64) &&
    (value.is_bigendian === 0 || value.is_bigendian === 1) &&
    isSafeNonNegativeInteger(value.step) &&
    isBytePayload(value.data)
  )
}

function isCompressedImage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['header', 'format', 'data']) &&
    isHeader(value.header) &&
    isBoundedString(value.format, 64) &&
    isBytePayload(value.data)
  )
}

function isImu(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'header',
      'orientation',
      'orientation_covariance',
      'angular_velocity',
      'angular_velocity_covariance',
      'linear_acceleration',
      'linear_acceleration_covariance',
    ]) &&
    isHeader(value.header) &&
    isQuaternion(value.orientation) &&
    isFiniteNumberArray(value.orientation_covariance, 9) &&
    isVector3(value.angular_velocity) &&
    isFiniteNumberArray(value.angular_velocity_covariance, 9) &&
    isVector3(value.linear_acceleration) &&
    isFiniteNumberArray(value.linear_acceleration_covariance, 9)
  )
}

function isRegionOfInterest(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['x_offset', 'y_offset', 'height', 'width', 'do_rectify']) &&
    isSafeNonNegativeInteger(value.x_offset) &&
    isSafeNonNegativeInteger(value.y_offset) &&
    isSafeNonNegativeInteger(value.height) &&
    isSafeNonNegativeInteger(value.width) &&
    typeof value.do_rectify === 'boolean'
  )
}

function isCameraInfo(value: unknown): boolean {
  if (!isRecord(value)) return false
  const allowed = [
    'header',
    'height',
    'width',
    'distortion_model',
    'D',
    'K',
    'R',
    'P',
    'binning_x',
    'binning_y',
    'roi',
  ] as const
  const required = ['header', 'height', 'width', 'distortion_model', 'D', 'K', 'R', 'P'] as const
  return (
    hasOnlyKeys(value, allowed, required) &&
    isHeader(value.header) &&
    isSafeNonNegativeInteger(value.height) &&
    isSafeNonNegativeInteger(value.width) &&
    isBoundedString(value.distortion_model, 64) &&
    isFiniteNumberArray(value.D, undefined, 32) &&
    isFiniteNumberArray(value.K, 9) &&
    isFiniteNumberArray(value.R, 9) &&
    isFiniteNumberArray(value.P, 12) &&
    (value.binning_x === undefined || isSafeNonNegativeInteger(value.binning_x)) &&
    (value.binning_y === undefined || isSafeNonNegativeInteger(value.binning_y)) &&
    (value.roi === undefined || isRegionOfInterest(value.roi))
  )
}

function isTransformStamped(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['header', 'child_frame_id', 'transform']) &&
    isHeader(value.header) &&
    isRecord(value.header) &&
    isValidTfFrameId(value.header.frame_id) &&
    isValidTfFrameId(value.child_frame_id) &&
    normalizeIngressTfTransform(value.transform) !== null
  )
}

function isTFMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['transforms']) &&
    Array.isArray(value.transforms) &&
    value.transforms.length <= MAX_JSON_CONTAINER_ENTRIES &&
    value.transforms.every(isTransformStamped)
  )
}

function isModelStates(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['name', 'pose', 'twist']) ||
    !Array.isArray(value.name) ||
    !Array.isArray(value.pose) ||
    !Array.isArray(value.twist) ||
    value.name.length > MAX_JSON_CONTAINER_ENTRIES ||
    value.name.length !== value.pose.length ||
    value.name.length !== value.twist.length
  ) {
    return false
  }
  return (
    value.name.every((name) => isBoundedString(name)) &&
    value.pose.every(isPose) &&
    value.twist.every(isTwist)
  )
}

function isPoseStamped(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['header', 'pose']) &&
    isHeader(value.header) &&
    isPose(value.pose)
  )
}

function isOdometry(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['header', 'child_frame_id', 'pose', 'twist']) &&
    isHeader(value.header) &&
    isBoundedString(value.child_frame_id) &&
    isPoseWithCovariance(value.pose) &&
    isTwistWithCovariance(value.twist)
  )
}

function isMavrosState(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'header',
      'connected',
      'armed',
      'guided',
      'manual_input',
      'mode',
      'system_status',
    ]) &&
    isHeader(value.header) &&
    typeof value.connected === 'boolean' &&
    typeof value.armed === 'boolean' &&
    typeof value.guided === 'boolean' &&
    typeof value.manual_input === 'boolean' &&
    isBoundedString(value.mode, 64) &&
    isSafeNonNegativeInteger(value.system_status)
  )
}

function isConfidence(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 1
}

function isPositiveVarianceTuple(value: unknown): boolean {
  return (
    isFiniteNumberArray(value, 3) &&
    value.every((variance) => variance > 0 && variance <= MAX_SENSOR_MEASUREMENT_VARIANCE)
  )
}

function isThermalDetection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'header',
      'id',
      'position',
      'temperature_kelvin',
      'signature_area',
      'confidence',
      'classification',
    ]) &&
    isHeader(value.header) &&
    isBoundedString(value.id) &&
    isVector3(value.position) &&
    isFiniteNumber(value.temperature_kelvin) &&
    value.temperature_kelvin >= 0 &&
    isFiniteNumber(value.signature_area) &&
    value.signature_area >= 0 &&
    isConfidence(value.confidence) &&
    isBoundedString(value.classification)
  )
}

function isAcousticDetection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'header',
      'id',
      'azimuth',
      'elevation',
      'range_estimate',
      'spl_db',
      'dominant_frequency_hz',
      'doppler_hz',
      'confidence',
      'classification',
    ]) &&
    isHeader(value.header) &&
    isBoundedString(value.id) &&
    isFiniteNumber(value.azimuth) &&
    isFiniteNumber(value.elevation) &&
    isFiniteNumber(value.range_estimate) &&
    value.range_estimate >= 0 &&
    isFiniteNumber(value.spl_db) &&
    value.spl_db >= 0 &&
    isFiniteNumber(value.dominant_frequency_hz) &&
    value.dominant_frequency_hz >= 0 &&
    isFiniteNumber(value.doppler_hz) &&
    isConfidence(value.confidence) &&
    isBoundedString(value.classification)
  )
}

function isRadarDetection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'header',
      'id',
      'range',
      'azimuth',
      'elevation',
      'radial_velocity',
      'rcs_dbsm',
      'confidence',
      'classification',
    ]) &&
    isHeader(value.header) &&
    isBoundedString(value.id) &&
    isFiniteNumber(value.range) &&
    value.range >= 0 &&
    isFiniteNumber(value.azimuth) &&
    isFiniteNumber(value.elevation) &&
    isFiniteNumber(value.radial_velocity) &&
    isFiniteNumber(value.rcs_dbsm) &&
    isConfidence(value.confidence) &&
    isBoundedString(value.classification)
  )
}

function isLidarDetection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'header',
      'id',
      'centroid',
      'bbox_min',
      'bbox_max',
      'velocity',
      'covariance',
      'num_points',
      'confidence',
      'classification',
    ]) &&
    isHeader(value.header) &&
    isBoundedString(value.id) &&
    isVector3(value.centroid) &&
    isVector3(value.bbox_min) &&
    isVector3(value.bbox_max) &&
    isVector3(value.velocity) &&
    isPositiveVarianceTuple(value.covariance) &&
    isSafeNonNegativeInteger(value.num_points) &&
    isConfidence(value.confidence) &&
    isBoundedString(value.classification)
  )
}

function isDetectionArray(
  value: unknown,
  detectionValidator: ROSMessageValidator
): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['header', 'detections']) &&
    isHeader(value.header) &&
    Array.isArray(value.detections) &&
    value.detections.length <= MAX_JSON_CONTAINER_ENTRIES &&
    value.detections.every(detectionValidator)
  )
}

function isStringMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['data']) &&
    isBoundedString(value.data, 1024 * 1024)
  )
}

function isClockMessage(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ['clock']) && isRosTime(value.clock)
}

const BUILTIN_MESSAGE_VALIDATORS: Readonly<Record<string, ROSMessageValidator>> = {
  'sensor_msgs/Image': isRawImage,
  'sensor_msgs/CompressedImage': isCompressedImage,
  'sensor_msgs/CameraInfo': isCameraInfo,
  'sensor_msgs/Imu': isImu,
  'tf2_msgs/TFMessage': isTFMessage,
  'gazebo_msgs/ModelStates': isModelStates,
  'nav_msgs/Odometry': isOdometry,
  'geometry_msgs/PoseStamped': isPoseStamped,
  'mavros_msgs/State': isMavrosState,
  'crebain_msgs/ThermalDetectionArray': (value) =>
    isDetectionArray(value, isThermalDetection),
  'crebain_msgs/AcousticDetectionArray': (value) =>
    isDetectionArray(value, isAcousticDetection),
  'crebain_msgs/RadarDetectionArray': (value) => isDetectionArray(value, isRadarDetection),
  'crebain_msgs/LidarDetectionArray': (value) => isDetectionArray(value, isLidarDetection),
  'std_msgs/Header': isHeader,
  'std_msgs/String': isStringMessage,
  'rosgraph_msgs/Clock': isClockMessage,
}

/**
 * Scan JSON syntax before JSON.parse so duplicate keys cannot be erased by
 * last-key-wins parsing. The same pass caps nesting and every container.
 */
class StrictJsonScanner {
  private index = 0

  constructor(private readonly text: string) {}

  scan(): void {
    this.scanValue(0)
    this.skipWhitespace()
    if (this.index !== this.text.length) throw new Error('unexpected trailing JSON data')
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.text[this.index] ?? '')) this.index += 1
  }

  private scanValue(depth: number): void {
    if (depth > MAX_JSON_NESTING_DEPTH) throw new Error('JSON nesting limit exceeded')
    this.skipWhitespace()
    const character = this.text[this.index]
    if (character === '{') {
      this.scanObject(depth)
    } else if (character === '[') {
      this.scanArray(depth)
    } else if (character === '"') {
      this.scanString(false)
    } else if (character === 't') {
      this.scanLiteral('true')
    } else if (character === 'f') {
      this.scanLiteral('false')
    } else if (character === 'n') {
      this.scanLiteral('null')
    } else {
      this.scanNumber()
    }
  }

  private scanObject(depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.text[this.index] === '}') {
      this.index += 1
      return
    }

    const keys = new Set<string>()
    let entries = 0
    while (this.index < this.text.length) {
      this.skipWhitespace()
      if (this.text[this.index] !== '"') throw new Error('JSON object key must be a string')
      const key = this.scanString(true)
      if (keys.has(key)) throw new Error(`duplicate JSON object key: ${key}`)
      keys.add(key)
      entries += 1
      if (entries > MAX_JSON_CONTAINER_ENTRIES) throw new Error('JSON object field limit exceeded')

      this.skipWhitespace()
      if (this.text[this.index] !== ':') throw new Error('JSON object key lacks a value')
      this.index += 1
      this.scanValue(depth + 1)
      this.skipWhitespace()
      const delimiter = this.text[this.index]
      this.index += 1
      if (delimiter === '}') return
      if (delimiter !== ',') throw new Error('invalid JSON object delimiter')
    }
    throw new Error('unterminated JSON object')
  }

  private scanArray(depth: number): void {
    this.index += 1
    this.skipWhitespace()
    if (this.text[this.index] === ']') {
      this.index += 1
      return
    }

    let entries = 0
    while (this.index < this.text.length) {
      entries += 1
      if (entries > MAX_JSON_CONTAINER_ENTRIES) throw new Error('JSON array item limit exceeded')
      this.scanValue(depth + 1)
      this.skipWhitespace()
      const delimiter = this.text[this.index]
      this.index += 1
      if (delimiter === ']') return
      if (delimiter !== ',') throw new Error('invalid JSON array delimiter')
    }
    throw new Error('unterminated JSON array')
  }

  private scanString(decode: boolean): string {
    const start = this.index
    this.index += 1
    let escaped = false
    while (this.index < this.text.length) {
      const character = this.text[this.index]
      this.index += 1
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        return decode ? (JSON.parse(this.text.slice(start, this.index)) as string) : ''
      }
    }
    throw new Error('unterminated JSON string')
  }

  private scanLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      throw new Error('invalid JSON literal')
    }
    this.index += literal.length
  }

  private scanNumber(): void {
    const start = this.index
    while (/[0-9eE+\-.]/u.test(this.text[this.index] ?? '')) this.index += 1
    if (this.index === start) throw new Error('invalid JSON value')
  }
}

function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x7f) bytes += 1
    else if (codeUnit <= 0x7ff) bytes += 2
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else bytes += 3
    if (bytes > limit) return true
  }
  return false
}

function parseStrictBoundedJson(data: string, byteLimit: number): unknown {
  if (exceedsUtf8ByteLimit(data, byteLimit)) {
    throw new Error('ROS bridge message exceeds the inbound byte limit')
  }
  new StrictJsonScanner(data).scan()
  return JSON.parse(data) as unknown
}

// Validate ROS bridge URL for security
export function validateRosUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url)
    
    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      return { valid: false, error: `Invalid scheme: ${parsed.protocol}. Only ws:// and wss:// are allowed.` }
    }
    
    if (!parsed.hostname) {
      return { valid: false, error: 'Missing hostname in URL' }
    }
    
    // Block potentially dangerous hostnames
    if (parsed.hostname.includes('..') || parsed.hostname.startsWith('-')) {
      return { valid: false, error: 'Invalid hostname format' }
    }
    
    return { valid: true }
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }
}

export class ROSBridge {
  private static fallbackInstanceCounter = 0

  private ws: WebSocket | null = null
  private config: ROSBridgeConfig
  private state: ConnectionState = 'disconnected'
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false
  private pendingConnectReject: ((error: Error) => void) | null = null
  private subscriptions: Map<string, Subscription[]> = new Map()
  private messageIdCounter = 0
  private readonly clientInstanceId = ROSBridge.createClientInstanceId()

  constructor(config: Partial<ROSBridgeConfig> & { url: string }) {
    const validation = validateRosUrl(config.url)
    if (!validation.valid) {
      throw new Error(`Invalid ROS bridge URL: ${validation.error}`)
    }
    
    this.config = {
      autoReconnect: true,
      reconnectIntervalMs: 3000,
      maxReconnectAttempts: 10,
      maxIncomingMessageBytes: MAX_RENDERER_ROSBRIDGE_MESSAGE_BYTES,
      ...config,
    }
    if (
      !Number.isSafeInteger(this.config.maxIncomingMessageBytes) ||
      this.config.maxIncomingMessageBytes <= 0 ||
      this.config.maxIncomingMessageBytes > MAX_RENDERER_ROSBRIDGE_MESSAGE_BYTES
    ) {
      throw new Error(
        `Invalid ROS bridge message bound: expected an integer within [1, ${MAX_RENDERER_ROSBRIDGE_MESSAGE_BYTES}]`
      )
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  connect(): Promise<void> {
    // A manual (re)connect re-enables auto-reconnect after an intentional
    // disconnect() and starts with a fresh reconnect-attempt budget.
    this.intentionalClose = false
    this.reconnectAttempts = 0
    return this.openSocket()
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state === 'connected' && this.canSend()) {
        resolve()
        return
      }

      // Re-entry safety: cancel any pending reconnect and tear down a socket
      // that is still connecting/open so two live sockets never coexist and an
      // orphaned socket's events cannot clobber the state of a newer one.
      this.clearReconnectTimer()
      this.teardownSocket()

      this.setState('connecting')

      const ws = new WebSocket(this.config.url)
      this.ws = ws
      this.pendingConnectReject = reject

      ws.onopen = () => {
        if (this.ws !== ws) return
        this.pendingConnectReject = null
        this.reconnectAttempts = 0
        this.resubscribeAll()
        this.setState('connected')
        this.invokeExternalCallback('connect', this.config.onConnect)
        resolve()
      }

      ws.onclose = () => {
        if (this.ws !== ws) return
        this.ws = null
        const wasConnected = this.state === 'connected'
        this.setState('disconnected')

        // A socket that closed before opening is a failed connect attempt.
        const pendingReject = this.pendingConnectReject
        this.pendingConnectReject = null
        pendingReject?.(new Error('Connection closed before opening'))

        if (wasConnected) {
          this.invokeExternalCallback('disconnect', this.config.onDisconnect)
        }

        if (
          !this.intentionalClose &&
          this.config.autoReconnect &&
          this.reconnectAttempts < this.config.maxReconnectAttempts
        ) {
          this.scheduleReconnect()
        }
      }

      ws.onerror = (event) => {
        if (this.ws !== ws) return
        const error = new Error(`WebSocket error: ${event.type}`)
        this.notifyError(error)

        if (this.state === 'connecting') {
          this.pendingConnectReject = null
          reject(error)
        }
      }

      ws.onmessage = (event: MessageEvent<unknown>) => {
        if (this.ws !== ws) return
        if (typeof event.data === 'string') {
          this.handleMessage(event.data)
        }
      }
    })
  }

  disconnect(): void {
    // Mark the close as intentional so it does not trigger auto-reconnect;
    // the next manual connect() re-enables reconnection.
    this.intentionalClose = true
    this.clearReconnectTimer()
    this.teardownSocket('Disconnected from ROS bridge')
    this.setState('disconnected')
  }

  /**
   * Detach and close the current socket (if any) without firing its handlers,
   * rejecting any connect() promise still waiting on it.
   */
  private teardownSocket(reason: string = 'Connection attempt superseded'): void {
    const pendingReject = this.pendingConnectReject
    this.pendingConnectReject = null
    pendingReject?.(new Error(reason))

    const ws = this.ws
    if (!ws) return
    this.ws = null
    ws.onopen = null
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.invokeExternalCallback('state-change', this.config.onStateChange, state)
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()
    this.reconnectAttempts++
    this.setState('reconnecting')
    
    this.reconnectTimer = setTimeout(() => {
      // Use openSocket() directly so automatic retries do not reset the
      // reconnect-attempt budget the way a manual connect() does.
      this.openSocket().catch((error) => {
        this.notifyError(error instanceof Error ? error : new Error(String(error)))
      })
    }, this.config.reconnectIntervalMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  getState(): ConnectionState {
    return this.state
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.canSend()
  }

  private canSend(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MESSAGE HANDLING
  // ───────────────────────────────────────────────────────────────────────────

  private handleMessage(data: string): void {
    let message: unknown
    try {
      message = parseStrictBoundedJson(data, this.config.maxIncomingMessageBytes)
    } catch (error) {
      this.reportProtocolError('Rejected malformed ROS bridge JSON', error)
      return
    }

    if (!isRecord(message) || typeof message.op !== 'string') {
      this.reportProtocolError('Rejected a ROS bridge message without a valid operation')
      return
    }

    switch (message.op) {
      case 'publish': {
        if (
          !hasOnlyKeys(message, ['op', 'id', 'topic', 'msg'], ['op', 'topic', 'msg']) ||
          typeof message.topic !== 'string'
        ) {
          this.reportProtocolError('Rejected a malformed ROS bridge publish envelope')
          return
        }
        try {
          validateRosGraphName(message.topic, 'topic')
        } catch (error) {
          this.reportProtocolError('Rejected a publish with an invalid ROS topic', error)
          return
        }
        if (
          message.id !== undefined &&
          (typeof message.id !== 'string' || message.id.length > MAX_PROTOCOL_ID_LENGTH)
        ) {
          this.reportProtocolError('Rejected a publish with an invalid protocol ID')
          return
        }
        this.handleTopicMessage(message.topic, message.msg)
        break
      }
      case 'status':
        this.handleStatusMessage(message)
        break
      default:
        this.reportProtocolError(`Ignored unsupported ROS bridge operation: ${message.op}`)
        break
    }
  }

  private handleTopicMessage(topic: string, msg: unknown): void {
    const subs = this.subscriptions.get(topic)
    if (!subs || subs.length === 0) return

    for (const sub of [...subs]) {
      try {
        if (!sub.validator(msg)) {
          this.reportProtocolError(
            `Rejected ${sub.type} telemetry that did not match its runtime schema`
          )
          continue
        }
        const callbackResult = sub.callback(msg)
        void Promise.resolve(callbackResult).catch((error: unknown) =>
          this.reportProtocolError(`ROS callback failed for ${topic}`, error)
        )
      } catch (error) {
        // One consumer must never head-of-line block the remaining consumers.
        this.reportProtocolError(`ROS callback failed for ${topic}`, error)
      }
    }
  }

  private handleStatusMessage(message: Record<string, unknown>): void {
    if (
      !hasOnlyKeys(message, ['op', 'id', 'level', 'msg'], ['op', 'level', 'msg']) ||
      !['info', 'warning', 'error', 'none'].includes(String(message.level)) ||
      typeof message.msg !== 'string' ||
      message.msg.length > MAX_STATUS_MESSAGE_LENGTH ||
      (message.id !== undefined &&
        (typeof message.id !== 'string' || message.id.length > MAX_PROTOCOL_ID_LENGTH))
    ) {
      this.reportProtocolError('Rejected a malformed ROS bridge status envelope')
      return
    }

    // Attribute status only when its optional ID belongs to an active request.
    // An unknown ID may describe another operation on a shared server and must
    // not be reported as the result of one of this read-only adapter's requests.
    if (message.id !== undefined && !this.hasSubscriptionId(message.id)) return
    if (message.level === 'warning' || message.level === 'error') {
      const suffix = message.id === undefined ? '' : ` (${message.id})`
      this.reportProtocolError(`ROS bridge ${message.level}${suffix}: ${message.msg}`)
    }
  }

  private hasSubscriptionId(id: string): boolean {
    for (const subscriptions of this.subscriptions.values()) {
      if (subscriptions.some((subscription) => subscription.id === id)) return true
    }
    return false
  }

  private reportProtocolError(message: string, cause?: unknown): void {
    const detail = cause instanceof Error ? `: ${cause.message}` : ''
    this.notifyError(new Error(`${message}${detail}`))
  }

  /** External observers are diagnostic only and cannot control bridge state. */
  private invokeExternalCallback<T>(
    label: string,
    callback: ((value: T) => void) | undefined,
    value?: T
  ): void {
    if (!callback) return
    try {
      callback(value as T)
    } catch (error) {
      log.error(`ROS bridge ${label} callback failed`, { error })
    }
  }

  private notifyError(error: Error): void {
    this.invokeExternalCallback('error', this.config.onError, error)
  }

  #send(message: ROSBridgeMessage): boolean {
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
      return true
    }
    return false
  }

  private static createClientInstanceId(): string {
    const cryptoApi = globalThis.crypto
    if (typeof cryptoApi?.randomUUID === 'function') {
      return cryptoApi.randomUUID()
    }
    ROSBridge.fallbackInstanceCounter += 1
    return `${Date.now().toString(36)}_${ROSBridge.fallbackInstanceCounter.toString(36)}`
  }

  private generateId(): string {
    this.messageIdCounter += 1
    return `subscription_${this.clientInstanceId}_${this.messageIdCounter.toString(36)}`
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TOPIC OPERATIONS
  // ───────────────────────────────────────────────────────────────────────────

  subscribe<T>(
    topic: string,
    type: string,
    callback: ROSMessageCallback<T>,
    throttleRate?: number,
    queueLength?: number,
    validator?: ROSMessageValidator
  ): () => void {
    validateRosGraphName(topic, 'topic')
    validateRosMessageType(type)
    validateNonNegativeNumber(throttleRate, 'throttle rate')
    validateNonNegativeNumber(queueLength, 'queue length')

    const builtinValidator = BUILTIN_MESSAGE_VALIDATORS[type]
    if (!builtinValidator && !validator) {
      throw new Error(`No runtime schema is registered for ROS message type ${type}`)
    }

    const subs = this.subscriptions.get(topic) || []
    if (subs.length > 0 && subs[0].type !== type) {
      throw new Error(
        `ROS topic ${topic} is already subscribed as ${subs[0].type}; refusing conflicting type ${type}`
      )
    }
    if (subs.length >= MAX_SUBSCRIPTIONS_PER_TOPIC || this.subscriptionCount() >= MAX_SUBSCRIPTIONS) {
      throw new Error('ROS subscription limit exceeded')
    }

    const id = this.generateId()
    const resolvedValidator: ROSMessageValidator = (message) =>
      (builtinValidator?.(message) ?? true) && (validator?.(message) ?? true)
    const subscription: Subscription = {
      id,
      topic,
      type,
      callback: callback as ROSMessageCallback<unknown>,
      validator: resolvedValidator,
      throttleRate,
      queueLength,
    }

    subs.push(subscription)
    this.subscriptions.set(topic, subs)
    this.sendSubscribe(subscription)

    // Return unsubscribe function
    return () => this.unsubscribeById(topic, id)
  }

  unsubscribe(topic: string, callback: ROSMessageCallback<unknown>): void {
    validateRosGraphName(topic, 'topic')
    const subs = this.subscriptions.get(topic)
    if (!subs) return

    const idx = subs.findIndex(s => s.callback === callback)
    if (idx === -1) return

    this.unsubscribeById(topic, subs[idx].id)
  }

  private unsubscribeById(topic: string, id: string): void {
    const subs = this.subscriptions.get(topic)
    if (!subs) return
    const index = subs.findIndex((subscription) => subscription.id === id)
    if (index < 0) return

    subs.splice(index, 1)
    if (subs.length === 0) this.subscriptions.delete(topic)
    // Rosbridge defines the subscribe ID as the identity that must be echoed
    // by unsubscribe. A fresh request ID here would leave the old server-side
    // subscription alive.
    this.#send({ op: 'unsubscribe', id, topic })
  }

  private subscriptionCount(): number {
    let count = 0
    for (const subscriptions of this.subscriptions.values()) count += subscriptions.length
    return count
  }

  private sendSubscribe(subscription: Subscription): void {
    this.#send({
      op: 'subscribe',
      id: subscription.id,
      topic: subscription.topic,
      type: subscription.type,
      throttle_rate: subscription.throttleRate,
      queue_length: subscription.queueLength,
    })
  }

  private resubscribeAll(): void {
    for (const subs of this.subscriptions.values()) {
      for (const subscription of subs) this.sendSubscribe(subscription)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // GAZEBO SPECIFIC HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  subscribeToModelStates(
    callback: ROSMessageCallback<ModelStates>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      '/gazebo/model_states',
      'gazebo_msgs/ModelStates',
      callback,
      throttleRate
    )
  }

  subscribeToOdometry(
    namespace: string,
    callback: ROSMessageCallback<Odometry>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      namespacedRosTopic(namespace, 'mavros/local_position/odom'),
      'nav_msgs/Odometry',
      callback,
      throttleRate
    )
  }

  subscribeToPose(
    namespace: string,
    callback: ROSMessageCallback<PoseStamped>,
    throttleRate: number = 50
  ): () => void {
    return this.subscribe(
      namespacedRosTopic(namespace, 'mavros/local_position/pose'),
      'geometry_msgs/PoseStamped',
      callback,
      throttleRate
    )
  }

  subscribeToState(
    namespace: string,
    callback: ROSMessageCallback<State>
  ): () => void {
    return this.subscribe(
      namespacedRosTopic(namespace, 'mavros/state'),
      'mavros_msgs/State',
      callback
    )
  }

}
