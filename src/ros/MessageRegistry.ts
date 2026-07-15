/**
 * Registry for the raw telemetry payloads emitted by the native Tauri
 * transport. It deliberately owns only command selection and raw-payload
 * validation; ROS message mapping remains in ZenohBridge.
 */

import { rosLogger as log } from '../lib/logger'
import { TAURI_COMMANDS } from '../lib/tauriCommands'
import {
  MAX_GAZEBO_ANGULAR_SPEED_RAD_S,
  MAX_GAZEBO_LINEAR_SPEED_MPS,
  MAX_GAZEBO_POSITION_MAGNITUDE_M,
  MAX_GAZEBO_QUATERNION_NORM,
  MIN_GAZEBO_QUATERNION_NORM,
} from './gazeboValidation'

interface MessageTypeHandler<TRaw = unknown> {
  command: string
  validator: (data: TRaw) => boolean
}

type UnknownRecord = Record<string, unknown>

interface StoredMessageHandler {
  command: string
  validator: (data: unknown) => boolean
}

const MAX_NATIVE_STRING_LENGTH = 4096
const MAX_NATIVE_SEQUENCE_LENGTH = 10_000
const MAX_NATIVE_IMAGE_DIMENSION = 8192
const MAX_NATIVE_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_BASE64_IMAGE_LENGTH = Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3) * 4
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

function isRecord(data: unknown): data is UnknownRecord {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

function hasOnlyKeys(
  value: UnknownRecord,
  expectedKeys: readonly string[]
): boolean {
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedString(value: unknown, maximum = MAX_NATIVE_STRING_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximum &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint === 0 || (codePoint < 0x20 && character !== '\t')
    })
  )
}

function isFiniteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(isFiniteNumber)
}

function isUnitQuaternion(value: unknown): value is number[] {
  if (!isFiniteTuple(value, 4)) return false
  const norm = Math.hypot(...value)
  return norm >= MIN_GAZEBO_QUATERNION_NORM && norm <= MAX_GAZEBO_QUATERNION_NORM
}

function isBoundedVector(value: unknown, maximumMagnitude: number): value is number[] {
  return isFiniteTuple(value, 3) && Math.hypot(...value) <= maximumMagnitude
}

function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function isBase64Image(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_BASE64_IMAGE_LENGTH &&
    value.length % 4 === 0 &&
    BASE64_PATTERN.test(value)
  )
}

function decodedBase64Length(value: string): number {
  if (value.length === 0) return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function isRawCameraFrame(data: unknown, compressed: boolean): boolean {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      'data',
      'width',
      'height',
      'encoding',
      'timestamp',
      'frame_id',
      'is_bigendian',
      'step',
    ]) ||
    !isBase64Image(data.data) ||
    !isSafeNonNegativeInteger(data.width) ||
    data.width === 0 ||
    data.width > MAX_NATIVE_IMAGE_DIMENSION ||
    !isSafeNonNegativeInteger(data.height) ||
    data.height === 0 ||
    data.height > MAX_NATIVE_IMAGE_DIMENSION ||
    !isBoundedString(data.encoding, 64) ||
    data.encoding.length === 0 ||
    !isTimestamp(data.timestamp) ||
    !isBoundedString(data.frame_id, 256) ||
    (data.is_bigendian !== 0 && data.is_bigendian !== 1) ||
    !isSafeNonNegativeInteger(data.step)
  ) {
    return false
  }

  if (compressed) return decodedBase64Length(data.data) > 0
  const expectedLength = data.height * data.step
  return (
    Number.isSafeInteger(expectedLength) &&
    expectedLength <= MAX_NATIVE_IMAGE_BYTES &&
    decodedBase64Length(data.data) === expectedLength
  )
}

function isRawCameraInfo(data: unknown): boolean {
  return (
    isRecord(data) &&
    hasOnlyKeys(data, [
      'height',
      'width',
      'distortion_model',
      'd',
      'k',
      'r',
      'p',
      'timestamp',
      'frame_id',
    ]) &&
    isSafeNonNegativeInteger(data.height) &&
    data.height > 0 &&
    data.height <= MAX_NATIVE_IMAGE_DIMENSION &&
    isSafeNonNegativeInteger(data.width) &&
    data.width > 0 &&
    data.width <= MAX_NATIVE_IMAGE_DIMENSION &&
    isBoundedString(data.distortion_model, 64) &&
    Array.isArray(data.d) &&
    data.d.length <= 32 &&
    data.d.every(isFiniteNumber) &&
    isFiniteTuple(data.k, 9) &&
    isFiniteTuple(data.r, 9) &&
    isFiniteTuple(data.p, 12) &&
    isTimestamp(data.timestamp) &&
    isBoundedString(data.frame_id, 256)
  )
}

function isRawImu(data: unknown): boolean {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, [
      'orientation',
      'orientation_covariance',
      'angular_velocity',
      'angular_velocity_covariance',
      'linear_acceleration',
      'linear_acceleration_covariance',
      'timestamp',
      'frame_id',
    ]) ||
    !isFiniteTuple(data.orientation_covariance, 9) ||
    !isFiniteTuple(data.angular_velocity, 3) ||
    !isFiniteTuple(data.angular_velocity_covariance, 9) ||
    !isFiniteTuple(data.linear_acceleration, 3) ||
    !isFiniteTuple(data.linear_acceleration_covariance, 9) ||
    !isTimestamp(data.timestamp) ||
    !isBoundedString(data.frame_id, 256)
  ) {
    return false
  }

  const orientationUnavailable = data.orientation_covariance[0] === -1
  return orientationUnavailable
    ? isFiniteTuple(data.orientation, 4)
    : isUnitQuaternion(data.orientation)
}

function isRawPose(data: unknown): boolean {
  return (
    isRecord(data) &&
    hasOnlyKeys(data, ['position', 'orientation', 'timestamp', 'frame_id']) &&
    isBoundedVector(data.position, MAX_GAZEBO_POSITION_MAGNITUDE_M) &&
    isUnitQuaternion(data.orientation) &&
    isTimestamp(data.timestamp) &&
    isBoundedString(data.frame_id, 256)
  )
}

function isRawVelocity(data: unknown): boolean {
  return (
    isRecord(data) &&
    hasOnlyKeys(data, ['linear', 'angular']) &&
    isBoundedVector(data.linear, MAX_GAZEBO_LINEAR_SPEED_MPS) &&
    isBoundedVector(data.angular, MAX_GAZEBO_ANGULAR_SPEED_RAD_S)
  )
}

function isRawModelStates(data: unknown): boolean {
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, ['name', 'pose', 'twist']) ||
    !Array.isArray(data.name) ||
    !Array.isArray(data.pose) ||
    !Array.isArray(data.twist) ||
    data.name.length > MAX_NATIVE_SEQUENCE_LENGTH ||
    data.name.length !== data.pose.length ||
    data.name.length !== data.twist.length
  ) {
    return false
  }

  return (
    data.name.every((name) => isBoundedString(name, 256)) &&
    data.pose.every(isRawPose) &&
    data.twist.every(isRawVelocity)
  )
}

class MessageRegistry {
  private handlers = new Map<string, StoredMessageHandler>()

  private readonly builtinTypes = [
    'sensor_msgs/Image',
    'sensor_msgs/CompressedImage',
    'sensor_msgs/CameraInfo',
    'sensor_msgs/Imu',
    'geometry_msgs/PoseStamped',
    'gazebo_msgs/ModelStates',
  ] as const

  constructor() {
    this.register('sensor_msgs/Image', {
      command: TAURI_COMMANDS.transport.subscribeCamera,
      validator: (data) => isRawCameraFrame(data, false),
    })
    this.register('sensor_msgs/CompressedImage', {
      command: TAURI_COMMANDS.transport.subscribeCamera,
      validator: (data) => isRawCameraFrame(data, true),
    })
    this.register('sensor_msgs/CameraInfo', {
      command: TAURI_COMMANDS.transport.subscribeCameraInfo,
      validator: isRawCameraInfo,
    })
    this.register('sensor_msgs/Imu', {
      command: TAURI_COMMANDS.transport.subscribeImu,
      validator: isRawImu,
    })
    this.register('geometry_msgs/PoseStamped', {
      command: TAURI_COMMANDS.transport.subscribePose,
      validator: isRawPose,
    })
    this.register('gazebo_msgs/ModelStates', {
      command: TAURI_COMMANDS.transport.subscribeModelStates,
      validator: isRawModelStates,
    })
  }

  private register<TRaw>(type: string, handler: MessageTypeHandler<TRaw>): void {
    if (this.handlers.has(type)) log.warn(`Type ${type} already registered`)
    this.handlers.set(type, {
      command: handler.command,
      validator: handler.validator as (data: unknown) => boolean,
    })
  }

  isRegistered(type: string): boolean {
    return this.handlers.has(type)
  }

  getCommand(type: string): string | null {
    return this.handlers.get(type)?.command ?? null
  }

  validate(type: string, data: unknown): boolean {
    const handler = this.handlers.get(type)
    if (!handler) return false
    try {
      return Boolean(handler.validator(data))
    } catch {
      return false
    }
  }

  listTypes(): string[] {
    return Array.from(this.handlers.keys())
  }

  getBuiltinTypes(): string[] {
    return [...this.builtinTypes]
  }
}

let instance: MessageRegistry | null = null

export function getMessageRegistry(): MessageRegistry {
  instance ??= new MessageRegistry()
  return instance
}

export function createMessageRegistry(): MessageRegistry {
  return new MessageRegistry()
}

export default MessageRegistry
