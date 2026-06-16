/**
 * WebSocket transport for the NCP client — connects to Engram's
 * `/api/neurocontrol/ws`. Engram replies to each message in order, so requests
 * are correlated FIFO. Use this `send` with `NeuroSimClient`, or wire NCP over
 * CREBAIN's ZenohBridge instead for a fully decoupled bus.
 */

import type { NcpReply, Send } from './ncp'

interface PendingRequest {
  resolve: (reply: NcpReply) => void
  reject: (error: Error) => void
}

export class WebSocketNeuroSim {
  private readonly ws: WebSocket
  private readonly pending: PendingRequest[] = []
  private readonly ready: Promise<void>
  private closedError: Error | null = null

  constructor(url = 'ws://127.0.0.1:28471/api/neurocontrol/ws') {
    this.ws = new WebSocket(url)

    let rejectReady!: (error: Error) => void
    this.ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject
      this.ws.onopen = (): void => resolve()
    })

    this.ws.onmessage = (event: MessageEvent): void => {
      const pending = this.pending.shift()
      if (!pending) return
      try {
        // Parse inside the handler so one malformed frame rejects exactly the
        // request it was dequeued for, keeping FIFO correlation in sync.
        pending.resolve(JSON.parse(event.data as string) as NcpReply)
      } catch (error) {
        pending.reject(
          new Error(`NCP reply was not valid JSON: ${WebSocketNeuroSim.messageOf(error)}`)
        )
      }
    }

    // A close or error after connection must settle every in-flight request,
    // otherwise awaiting NeuroSimClient calls would hang forever. The same
    // handler rejects the `ready` promise if the socket never opened.
    this.ws.onerror = (): void => {
      const error = new Error('NCP WebSocket error')
      rejectReady(error) // no-op once `ready` has resolved
      this.failAll(error)
    }
    this.ws.onclose = (): void => {
      this.failAll(new Error('NCP WebSocket closed'))
    }
  }

  private static messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** Reject and drop every queued request; new sends fail fast afterwards. */
  private failAll(error: Error): void {
    if (!this.closedError) {
      this.closedError = error
    }
    while (this.pending.length > 0) {
      this.pending.shift()!.reject(this.closedError)
    }
  }

  /** Transport-agnostic `send` for `NeuroSimClient`. */
  readonly send: Send = async (message: Record<string, unknown>): Promise<NcpReply> => {
    await this.ready
    if (this.closedError) {
      throw this.closedError
    }
    return new Promise<NcpReply>((resolve, reject) => {
      const request: PendingRequest = { resolve, reject }
      this.pending.push(request)
      try {
        this.ws.send(JSON.stringify(message))
      } catch (error) {
        const index = this.pending.indexOf(request)
        if (index !== -1) this.pending.splice(index, 1)
        reject(new Error(`NCP send failed: ${WebSocketNeuroSim.messageOf(error)}`))
      }
    })
  }

  close(): void {
    this.failAll(new Error('NCP WebSocket closed by client'))
    this.ws.close()
  }
}
