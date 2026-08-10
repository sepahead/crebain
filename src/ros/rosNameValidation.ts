export const MAX_ROS_GRAPH_NAME_LENGTH = 256

const ROS_GRAPH_NAME_PATTERN = /^\/[A-Za-z0-9_/]+$/

export function isValidRosGraphName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_ROS_GRAPH_NAME_LENGTH &&
    name.trim() === name &&
    name !== '/' &&
    name.startsWith('/') &&
    !name.includes('//') &&
    !name.includes('\0') &&
    !/\s/.test(name) &&
    ROS_GRAPH_NAME_PATTERN.test(name)
  )
}

export function validateRosGraphName(name: string, kind: 'topic' | 'service'): void {
  if (name.length === 0 || name.trim() !== name) {
    throw new Error(`Invalid ROS ${kind}: name must not be empty or padded`)
  }
  if (name.length > MAX_ROS_GRAPH_NAME_LENGTH) {
    throw new Error(
      `Invalid ROS ${kind}: name exceeds ${MAX_ROS_GRAPH_NAME_LENGTH} characters`
    )
  }
  if (name === '/' || !name.startsWith('/')) {
    throw new Error(`Invalid ROS ${kind}: name must be absolute`)
  }
  if (!isValidRosGraphName(name)) {
    throw new Error(`Invalid ROS ${kind}: name contains invalid characters`)
  }
}
