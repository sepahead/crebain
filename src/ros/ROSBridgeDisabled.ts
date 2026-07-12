import type { ConnectionState, ModelStates, ROSMessageCallback } from './types'

export type { ConnectionState } from './types'

/** Production profile marker consumed by the connection panel. */
export const RENDERER_ROSBRIDGE_AVAILABLE = false

const DISABLED_MESSAGE =
  'Renderer rosbridge is disabled in the production profile; use the native telemetry transport.'

/**
 * Network-free production replacement for the development rosbridge client.
 *
 * Keeping this replacement API-compatible makes a stale renderer preference
 * fail closed without placing WebSocket construction code in the product
 * bundle.
 */
export class ROSBridge {
  constructor(_config: unknown) {}

  connect(): Promise<void> {
    return Promise.reject(new Error(DISABLED_MESSAGE))
  }

  disconnect(): void {}

  getState(): ConnectionState {
    return 'disconnected'
  }

  isConnected(): boolean {
    return false
  }

  subscribe<T>(
    _topic: string,
    _type: string,
    _callback: ROSMessageCallback<T>,
    _throttleRate?: number,
    _queueLength?: number
  ): () => void {
    throw new Error(DISABLED_MESSAGE)
  }

  subscribeToModelStates(
    callback: ROSMessageCallback<ModelStates>,
    throttleRate?: number
  ): () => void {
    return this.subscribe('/gazebo/model_states', 'gazebo_msgs/ModelStates', callback, throttleRate)
  }
}
