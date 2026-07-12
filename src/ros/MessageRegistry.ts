/**
 * CREBAIN Message Type Registry
 * Centralized type-safe message handler registration for ROS/Zenoh
 *
 * Provides:
 * - Type-safe message type identification
 * - Automatic mapper selection
 * - Validation and error handling
 * - Support for custom message types
 */

import { rosLogger as log } from '../lib/logger'
import { TAURI_COMMANDS } from '../lib/tauriCommands'

// Import types for reference only (used in JSDoc, not runtime)

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type MessageMapper<T, R> = (data: T) => R

export interface MessageTypeHandler<TRaw, TMapped> {
  type: string
  mapper: MessageMapper<TRaw, TMapped>
  command?: string // Tauri command for backend
  validator?: (data: TRaw) => boolean
}

type UnknownRecord = Record<string, unknown>

type StoredMessageHandler = {
  mapper: MessageMapper<unknown, unknown>
  command?: string
  validator?: (data: unknown) => boolean
}

function isRecord(data: unknown): data is UnknownRecord {
  return typeof data === 'object' && data !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE TYPE REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

class MessageRegistry {
  private handlers = new Map<string, StoredMessageHandler>()

  // Built-in types
  private builtinTypes = [
    'sensor_msgs/Image',
    'sensor_msgs/CompressedImage',
    'sensor_msgs/CameraInfo',
    'sensor_msgs/Imu',
    'geometry_msgs/PoseStamped',
    'gazebo_msgs/ModelStates',
    'std_msgs/Header',
    'std_msgs/String',
    'rosgraph_msgs/Clock',
  ]

  constructor() {
    this.registerBuiltins()
  }

  private registerBuiltins() {
    // Note: Actual mappers are implemented in ZenohBridge
    // This registry just defines which types are supported

    this.register('sensor_msgs/Image', {
      mapper: (data: unknown) => data,
      command: TAURI_COMMANDS.transport.subscribeCamera,
      validator: (data: unknown) => {
        if (!isRecord(data)) return false
        return (
          (typeof data.data === 'string' || Array.isArray(data.data)) &&
          typeof data.width === 'number' &&
          typeof data.height === 'number' &&
          typeof data.encoding === 'string'
        )
      },
    })

    this.register('sensor_msgs/CompressedImage', {
      mapper: (data: unknown) => data,
      command: TAURI_COMMANDS.transport.subscribeCamera,
      validator: (data: unknown) => {
        if (!isRecord(data)) return false
        return (
          (typeof data.data === 'string' || Array.isArray(data.data)) &&
          typeof data.format === 'string'
        )
      },
    })

    this.register('sensor_msgs/CameraInfo', {
      mapper: (data: unknown) => data,
      command: TAURI_COMMANDS.transport.subscribeCameraInfo,
      validator: (data: unknown) => {
        if (!isRecord(data)) return false
        return (
          typeof data.height === 'number' &&
          typeof data.width === 'number' &&
          typeof data.distortion_model === 'string' &&
          Array.isArray(data.d) &&
          Array.isArray(data.k) &&
          Array.isArray(data.r) &&
          Array.isArray(data.p)
        )
      },
    })

    this.register('sensor_msgs/Imu', {
      mapper: (data: unknown) => data,
      command: TAURI_COMMANDS.transport.subscribeImu,
      validator: (data: unknown) => {
        if (!isRecord(data)) return false
        return (
          Array.isArray(data.orientation) &&
          Array.isArray(data.angular_velocity) &&
          Array.isArray(data.linear_acceleration)
        )
      },
    })

    this.register('geometry_msgs/PoseStamped', {
      mapper: (data: unknown) => data,
      command: TAURI_COMMANDS.transport.subscribePose,
      validator: (data: unknown) => {
        if (!isRecord(data)) return false
        return Boolean(
          isRecord(data.header) &&
          isRecord(data.pose) &&
          data.pose.position &&
          data.pose.orientation
        )
      },
    })

    this.register('gazebo_msgs/ModelStates', {
      mapper: (data: unknown) => data,
      command: TAURI_COMMANDS.transport.subscribeModelStates,
      validator: (data: unknown) => {
        if (!isRecord(data)) return false
        return (
          Array.isArray(data.name) &&
          Array.isArray(data.pose) &&
          Array.isArray(data.twist)
        )
      },
    })

    this.register('rosgraph_msgs/Clock', {
      mapper: (data: unknown) => data,
      validator: (data: unknown) => {
        if (!isRecord(data) || !isRecord(data.clock)) return false
        return (
          typeof data.clock.secs === 'number' &&
          typeof data.clock.nsecs === 'number'
        )
      },
    })

    this.register('std_msgs/Header', {
      mapper: (data: unknown) => data,
      validator: (data: unknown) => {
        if (!isRecord(data) || !isRecord(data.stamp)) return false
        return (
          typeof data.stamp.secs === 'number' &&
          typeof data.stamp.nsecs === 'number' &&
          typeof data.frame_id === 'string'
        )
      },
    })

    this.register('std_msgs/String', {
      mapper: (data: unknown) => data,
      validator: (data: unknown) => {
        if (!isRecord(data)) return false
        return typeof data.data === 'string'
      },
    })
  }

  /**
   * Register a custom message type
   */
  register<TRaw, TMapped>(
    type: string,
    handler: Omit<MessageTypeHandler<TRaw, TMapped>, 'type'>
  ): void {
    if (this.handlers.has(type)) {
      log.warn(`Type ${type} already registered`)
    }

    this.handlers.set(type, {
      mapper: handler.mapper as MessageMapper<unknown, unknown>,
      command: handler.command,
      validator: handler.validator as ((data: unknown) => boolean) | undefined,
    })
  }

  /**
   * Check if a type is registered
   */
  isRegistered(type: string): boolean {
    return this.handlers.has(type)
  }

  /**
   * Get the mapper for a type
   */
  getMapper<TRaw = unknown, TMapped = unknown>(type: string): MessageMapper<TRaw, TMapped> | null {
    const handler = this.handlers.get(type)
    return handler ? handler.mapper as MessageMapper<TRaw, TMapped> : null
  }

  /**
   * Get the Tauri command for a type
   */
  getCommand(type: string): string | null {
    const handler = this.handlers.get(type)
    return handler?.command ?? null
  }

  /**
   * Validate data against a registered type
   */
  validate(type: string, data: unknown): boolean {
    const handler = this.handlers.get(type)
    if (!handler) return false
    if (!handler.validator) return true // No validator, assume valid
    try {
      return Boolean(handler.validator(data))
    } catch {
      return false
    }
  }

  /**
   * List all registered types
   */
  listTypes(): string[] {
    return Array.from(this.handlers.keys())
  }

  /**
   * Get all builtin types
   */
  getBuiltinTypes(): string[] {
    return [...this.builtinTypes]
  }
}

// Singleton instance
let instance: MessageRegistry | null = null

/**
 * Get the global message registry
 */
export function getMessageRegistry(): MessageRegistry {
  if (!instance) {
    instance = new MessageRegistry()
  }
  return instance
}

/**
 * Create a new registry instance (for testing)
 */
export function createMessageRegistry(): MessageRegistry {
  return new MessageRegistry()
}

export default MessageRegistry
