import type { Pose, Twist } from './types'

export const MAX_GAZEBO_MODEL_XML_BYTES = 256 * 1024
export const MAX_GAZEBO_POSITION_MAGNITUDE_M = 1_000_000
export const MAX_GAZEBO_LINEAR_SPEED_MPS = 100
export const MAX_GAZEBO_ANGULAR_SPEED_RAD_S = 50
export const MIN_GAZEBO_QUATERNION_NORM = 0.99
export const MAX_GAZEBO_QUATERNION_NORM = 1.01
const MAX_MODEL_NAME_BYTES = 128
const MAX_GRAPH_NAME_BYTES = 256
const SAFE_GRAPH_NAME = /^[A-Za-z0-9_./-]+$/
const SAFE_FRAME_ID = /^[A-Za-z0-9_/]+$/
const PRIVILEGED_XML_MARKERS = [
  '<!doctype',
  '<!entity',
  '<include',
  '<plugin',
  '<uri',
  'filename=',
  'file://',
  'http://',
  'https://',
]

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function validateGraphName(value: string, label: string, maxBytes: number): void {
  if (!value || value.trim() !== value) throw new Error(`${label} must not be empty or padded`)
  if (value.includes('\0') || !SAFE_GRAPH_NAME.test(value)) {
    throw new Error(`${label} contains unsupported characters`)
  }
  if (byteLength(value) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
}

export function validateGazeboModelName(value: string): void {
  validateGraphName(value, 'Gazebo model name', MAX_MODEL_NAME_BYTES)
}

export function validateGazeboFrameId(value: string, label = 'Gazebo reference frame'): void {
  if (!value || value.trim() !== value) throw new Error(`${label} must not be empty or padded`)
  if (
    value.includes('\0') ||
    value.includes('//') ||
    !SAFE_FRAME_ID.test(value) ||
    byteLength(value) > MAX_GRAPH_NAME_BYTES
  ) {
    throw new Error(`${label} contains unsupported characters or exceeds its byte limit`)
  }
}

function validateVector(
  vector: { x: number; y: number; z: number },
  label: string,
  maximum: number
): void {
  const values = [vector.x, vector.y, vector.z]
  if (!values.every(Number.isFinite)) throw new Error(`${label} must contain only finite values`)
  const magnitude = Math.hypot(...values)
  if (magnitude > maximum) throw new Error(`${label} magnitude exceeds ${maximum}`)
}

export function validateGazeboPose(pose: Pose): void {
  validateVector(
    pose.position,
    'Gazebo position',
    MAX_GAZEBO_POSITION_MAGNITUDE_M
  )
  const quaternion = [
    pose.orientation.x,
    pose.orientation.y,
    pose.orientation.z,
    pose.orientation.w,
  ]
  if (!quaternion.every(Number.isFinite)) {
    throw new Error('Gazebo orientation must contain only finite values')
  }
  const norm = Math.hypot(...quaternion)
  if (
    norm < MIN_GAZEBO_QUATERNION_NORM ||
    norm > MAX_GAZEBO_QUATERNION_NORM
  ) {
    throw new Error('Gazebo orientation must be a unit quaternion')
  }
}

export function validateGazeboTwist(twist: Twist): void {
  validateVector(
    twist.linear,
    'Gazebo linear velocity',
    MAX_GAZEBO_LINEAR_SPEED_MPS
  )
  validateVector(
    twist.angular,
    'Gazebo angular velocity',
    MAX_GAZEBO_ANGULAR_SPEED_RAD_S
  )
}

export function validateGazeboSpawn(
  name: string,
  xml: string,
  pose: Pose,
  namespace: string,
  referenceFrame: string,
  allowBundledPrivilegedXml = false
): void {
  validateGazeboModelName(name)
  if (!xml.trim()) throw new Error('Gazebo model XML must not be empty')
  if (xml.includes('\0')) throw new Error('Gazebo model XML must not contain null bytes')
  if (byteLength(xml) > MAX_GAZEBO_MODEL_XML_BYTES) {
    throw new Error(`Gazebo model XML exceeds ${MAX_GAZEBO_MODEL_XML_BYTES} bytes`)
  }
  if (
    !allowBundledPrivilegedXml &&
    PRIVILEGED_XML_MARKERS.some((marker) => xml.toLowerCase().includes(marker))
  ) {
    throw new Error('Gazebo model XML contains external-resource or plugin directives')
  }
  if (namespace) validateGraphName(namespace, 'Gazebo robot namespace', MAX_GRAPH_NAME_BYTES)
  validateGazeboFrameId(referenceFrame)
  validateGazeboPose(pose)
}
