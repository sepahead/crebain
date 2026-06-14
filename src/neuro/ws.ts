/**
 * WebSocket transport for the NCP client — connects to Engram's
 * `/api/neurocontrol/ws`. Engram replies to each message in order, so requests
 * are correlated FIFO. Use this `send` with `NeuroSimClient`, or wire NCP over
 * CREBAIN's ZenohBridge instead for a fully decoupled bus.
 */

import type { NcpReply, Send } from './ncp'

export class WebSocketNeuroSim {
  private readonly ws: WebSocket
  private readonly pending: Array<(reply: NcpReply) => void> = []
  private readonly ready: Promise<void>

  constructor(url = 'ws://127.0.0.1:28471/api/neurocontrol/ws') {
    this.ws = new WebSocket(url)
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.onopen = (): void => {
        resolve()
      }
      this.ws.onerror = (): void => {
        reject(new Error('NCP WebSocket error'))
      }
    })
    this.ws.onmessage = (event: MessageEvent): void => {
      const reply = JSON.parse(event.data as string) as NcpReply
      const resolve = this.pending.shift()
      if (resolve) {
        resolve(reply)
      }
    }
  }

  /** Transport-agnostic `send` for `NeuroSimClient`. */
  readonly send: Send = async (message: Record<string, unknown>): Promise<NcpReply> => {
    await this.ready
    return new Promise<NcpReply>((resolve) => {
      this.pending.push(resolve)
      this.ws.send(JSON.stringify(message))
    })
  }

  close(): void {
    this.ws.close()
  }
}
