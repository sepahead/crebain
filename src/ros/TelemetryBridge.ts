import type { ConnectionState, ModelStates, ROSMessageCallback } from './types'

/** Read-only transport capability exposed to renderer consumers. */
export interface TelemetryBridge {
  getState(): ConnectionState
  isConnected(): boolean
  subscribe<T>(
    topic: string,
    type: string,
    callback: ROSMessageCallback<T>,
    throttleRate?: number,
    queueLength?: number
  ): () => void
  subscribeToModelStates(
    callback: ROSMessageCallback<ModelStates>,
    throttleRate?: number
  ): () => void
}
