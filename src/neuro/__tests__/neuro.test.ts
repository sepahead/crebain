/**
 * Contract tests for `src/neuro` — CREBAIN's NCP TypeScript peer.
 *
 * `src/neuro/index.ts` re-exports the canonical `@sepehrmn/ncp` package (the wire
 * is owned there, pinned by tag) and adds one piece of CREBAIN-specific glue: a
 * reply `ncp_version` guard. These tests assert the contract CREBAIN relies on —
 * the public surface exists, the WebSocket transport constructs and round-trips a
 * known frame shape against a mocked socket, and the version guard refuses a reply
 * that drifts off the pinned protocol version.
 *
 * Style mirrors `src/ros/__tests__/` (vitest + the shared `mockWebSocket` helper).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  NeuroSimClient,
  WebSocketNeuroSim,
  NCP_VERSION,
  guardReplyVersion,
  assertReplyVersion,
  NcpVersionMismatchError,
} from '../index'
import { installMockWebSocket, MockWebSocket, sentMessages } from '../../test/mockWebSocket'

let restoreWebSocket: () => void

/** Let the event loop drain queued microtasks (a few `await` hops) so the
 *  transport's `await ready` resolves and the request is enqueued/serialized. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  restoreWebSocket = installMockWebSocket()
})

afterEach(() => {
  restoreWebSocket()
})

describe('src/neuro public surface', () => {
  it('re-exports the canonical NCP client, transport, and version', () => {
    expect(typeof NeuroSimClient).toBe('function')
    expect(typeof WebSocketNeuroSim).toBe('function')
    // The protocol version this build speaks; CREBAIN pins NCP at v0.4.0 (wire 0.4).
    expect(NCP_VERSION).toBe('0.4')
  })

  it('exposes the CREBAIN reply-version guard glue', () => {
    expect(typeof guardReplyVersion).toBe('function')
    expect(typeof assertReplyVersion).toBe('function')
    expect(typeof NcpVersionMismatchError).toBe('function')
  })
})

describe('WebSocketNeuroSim (transport smoke + round-trip)', () => {
  it('constructs against the default endpoint', () => {
    const transport = new WebSocketNeuroSim()
    expect(transport).toBeInstanceOf(WebSocketNeuroSim)
    expect(MockWebSocket.last().url).toContain('/api/neurocontrol/ws')
  })

  it('round-trips a known close-session frame through a mocked socket', async () => {
    const transport = new WebSocketNeuroSim('ws://localhost/api/neurocontrol/ws')
    const ws = MockWebSocket.last()
    ws.open() // resolve the transport `ready` promise

    const client = new NeuroSimClient(transport.send)
    const pending = client.close('sess-1')
    // `send` awaits the `ready` promise before enqueuing; flush microtasks so the
    // request is queued (and serialized onto the socket) before we reply.
    await flushMicrotasks()

    // The peer replies in FIFO order; hand back a wire-shaped SessionClosed reply.
    const reply = {
      kind: 'session_closed',
      ncp_version: NCP_VERSION,
      session_id: 'sess-1',
    }
    ws.receive(reply)

    await expect(pending).resolves.toMatchObject({
      kind: 'session_closed',
      session_id: 'sess-1',
    })

    // The outbound request carries the stamped protocol version.
    const sent = sentMessages(ws)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'close_session',
      ncp_version: NCP_VERSION,
      session_id: 'sess-1',
    })
  })

  it('settles in-flight requests when the socket errors (disconnect path)', async () => {
    const transport = new WebSocketNeuroSim('ws://localhost/api/neurocontrol/ws')
    const ws = MockWebSocket.last()
    ws.open()

    const client = new NeuroSimClient(transport.send)
    const pending = client.close('sess-err')
    await flushMicrotasks()
    ws.error()

    await expect(pending).rejects.toThrow('NCP WebSocket error')
  })
})

describe('reply ncp_version guard', () => {
  it('passes a reply that matches the pinned version through unchanged', () => {
    const reply = { kind: 'session_closed', ncp_version: NCP_VERSION }
    expect(() => assertReplyVersion(reply)).not.toThrow()
  })

  it('throws on a mismatched reply version', () => {
    const reply = { kind: 'session_closed', ncp_version: '0.1' }
    expect(() => assertReplyVersion(reply)).toThrow(NcpVersionMismatchError)
  })

  it('throws on a reply that is missing ncp_version', () => {
    const reply = { kind: 'session_closed' }
    expect(() => assertReplyVersion(reply)).toThrow(/<absent>/)
  })

  it('leaves error frames to the package unwrap (no version check)', () => {
    const errorFrame = { kind: 'error', error: 'boom' }
    expect(() => assertReplyVersion(errorFrame)).not.toThrow()
  })

  it('warns instead of throwing in "warn" mode', () => {
    const reply = { kind: 'session_closed', ncp_version: '9.9' }
    expect(() => assertReplyVersion(reply, 'warn')).not.toThrow()
  })

  it('guardReplyVersion wraps a Send and rejects a drifted reply', async () => {
    const drifted = async () => ({ kind: 'session_closed', ncp_version: '0.1' })
    const guarded = guardReplyVersion(drifted)
    await expect(guarded({ kind: 'close_session' })).rejects.toThrow(NcpVersionMismatchError)
  })

  it('guardReplyVersion forwards a matching reply', async () => {
    const matching = async () => ({
      kind: 'session_closed',
      ncp_version: NCP_VERSION,
      session_id: 'ok',
    })
    const guarded = guardReplyVersion(matching)
    await expect(guarded({ kind: 'close_session' })).resolves.toMatchObject({
      session_id: 'ok',
    })
  })

  it('composes with NeuroSimClient over a mocked socket', async () => {
    const transport = new WebSocketNeuroSim('ws://localhost/api/neurocontrol/ws')
    const ws = MockWebSocket.last()
    ws.open()

    const client = new NeuroSimClient(guardReplyVersion(transport.send))
    const pending = client.close('sess-guarded')
    await flushMicrotasks()
    // Peer replies with a stale protocol version → the guard rejects it.
    ws.receive({ kind: 'session_closed', ncp_version: '0.1', session_id: 'x' })

    await expect(pending).rejects.toThrow(NcpVersionMismatchError)
  })
})
