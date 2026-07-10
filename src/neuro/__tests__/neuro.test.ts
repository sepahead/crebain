/**
 * Contract tests for `src/neuro` — CREBAIN's NCP TypeScript peer.
 *
 * `src/neuro/index.ts` re-exports the canonical `@sepahead/ncp` package (the wire
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
    expect(NCP_VERSION).toBe('0.6')
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
      ok: true,
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
    const reply = {
      kind: 'session_closed',
      ncp_version: NCP_VERSION,
      session_id: 'session-1',
      ok: true,
    }
    expect(() => assertReplyVersion(reply)).not.toThrow()
  })

  it('throws on a mismatched reply version', () => {
    const reply = {
      kind: 'session_closed',
      ncp_version: '0.1',
      session_id: 'session-1',
      ok: true,
    }
    expect(() => assertReplyVersion(reply)).toThrow(NcpVersionMismatchError)
  })

  it('rejects the previous wire (0.5) via the SDK compatibility gate', () => {
    const reply = {
      kind: 'session_closed',
      ncp_version: '0.5',
      session_id: 'session-1',
      ok: true,
    }
    expect(() => assertReplyVersion(reply)).toThrow(NcpVersionMismatchError)
  })

  it('throws on a reply that is missing ncp_version', () => {
    const reply = { kind: 'session_closed', session_id: 'session-1', ok: true }
    expect(() => assertReplyVersion(reply)).toThrow(/<absent>/)
  })

  it('rejects a reply that violates the scientific boundary', () => {
    // A peer must not hand CREBAIN a frame claiming calibrated / non-simulation
    // status; the guard applies the SDK's assertScientificBoundary on inbound
    // replies (which crebain previously never enforced).
    const lie = {
      kind: 'observation_frame',
      ncp_version: NCP_VERSION,
      session_id: 's',
      seq: 1,
      records: {},
      is_simulation_output: false,
      calibrated_posterior: false,
    }
    expect(() => assertReplyVersion(lie)).toThrow()
    const calibrated = {
      kind: 'observation_frame',
      ncp_version: NCP_VERSION,
      session_id: 's',
      seq: 1,
      records: {},
      is_simulation_output: true,
      calibrated_posterior: true,
    }
    expect(() => assertReplyVersion(calibrated)).toThrow()
    // An honest observation frame passes.
    const honest = {
      kind: 'observation_frame',
      ncp_version: NCP_VERSION,
      session_id: 's',
      seq: 1,
      records: {},
      is_simulation_output: true,
      calibrated_posterior: false,
    }
    expect(() => assertReplyVersion(honest)).not.toThrow()
  })

  it('accepts the published unversioned wire-0.6 error frame', () => {
    const errorFrame = {
      kind: 'error',
      error: 'boom',
      session_id: 'session-1',
    }
    expect(() => assertReplyVersion(errorFrame)).not.toThrow()
  })

  it('rejects malformed errors, malformed successes, and primitive replies', () => {
    expect(() => assertReplyVersion({ kind: 'error', error: '' })).toThrow(/non-empty/)
    expect(() =>
      assertReplyVersion({
        kind: 'error',
        error: 'boom',
        session_id: 7,
      })
    ).toThrow(/session_id/)
    expect(() =>
      assertReplyVersion({
        kind: 'error',
        error: 'boom',
        session_id: '',
      })
    ).toThrow(/session_id/)
    expect(() =>
      assertReplyVersion({
        kind: 'session_closed',
        ncp_version: NCP_VERSION,
        session_id: 'session-1',
      })
    ).toThrow(/boolean ok/)
    expect(() =>
      assertReplyVersion({
        kind: 'session_opened',
        ncp_version: NCP_VERSION,
        session_id: 'session-1',
        ok: false,
        backend: 'nest',
        resolved: {},
        error: 'denied',
        provenance: null,
      })
    ).toThrow('denied')
    expect(() => assertReplyVersion('error')).toThrow()
  })

  it('requires complete observation identity and a map-shaped records field', () => {
    expect(() =>
      assertReplyVersion({
        kind: 'observation_frame',
        ncp_version: NCP_VERSION,
        seq: 0,
        records: {},
        is_simulation_output: true,
        calibrated_posterior: false,
      })
    ).toThrow(/session_id/)
    expect(() =>
      assertReplyVersion({
        kind: 'observation_frame',
        ncp_version: NCP_VERSION,
        session_id: 'session-1',
        seq: 0,
        records: [],
        is_simulation_output: true,
        calibrated_posterior: false,
      })
    ).toThrow(/records/)
  })

  it('enforces the wire-0.6 observation sequence gate', () => {
    const observation = (seq: number) => ({
      kind: 'observation_frame',
      ncp_version: NCP_VERSION,
      session_id: 'session-1',
      seq,
      records: {},
      is_simulation_output: true,
      calibrated_posterior: false,
    })
    expect(() => assertReplyVersion(observation(0))).not.toThrow()
    expect(() => assertReplyVersion(observation(-1))).toThrow(/seq/)
    expect(() => assertReplyVersion(observation(1.5))).toThrow(/seq/)
  })

  it('guardReplyVersion wraps a Send and rejects a drifted reply', async () => {
    const drifted = async () => ({
      kind: 'session_closed',
      ncp_version: '0.1',
      session_id: 'session-1',
      ok: true,
    })
    const guarded = guardReplyVersion(drifted)
    await expect(
      guarded({ kind: 'close_session', ncp_version: NCP_VERSION, session_id: 'session-1' })
    ).rejects.toThrow(NcpVersionMismatchError)
  })

  it('guardReplyVersion forwards a matching reply', async () => {
    const matching = async () => ({
      kind: 'session_closed',
      ncp_version: NCP_VERSION,
      session_id: 'ok',
      ok: true,
    })
    const guarded = guardReplyVersion(matching)
    await expect(
      guarded({ kind: 'close_session', ncp_version: NCP_VERSION, session_id: 'ok' })
    ).resolves.toMatchObject({ session_id: 'ok' })
  })

  it('rejects success replies and errors attributed to another session', async () => {
    const wrongSession = guardReplyVersion(async () => ({
      kind: 'error',
      error: 'boom',
      session_id: 'other',
    }))
    await expect(
      wrongSession({
        kind: 'close_session',
        ncp_version: NCP_VERSION,
        session_id: 'session-1',
      })
    ).rejects.toThrow(/session mismatch/)

    const wrongKind = guardReplyVersion(async () => ({
      kind: 'observation_frame',
      ncp_version: NCP_VERSION,
      session_id: 'session-1',
      seq: 0,
      records: {},
      is_simulation_output: true,
      calibrated_posterior: false,
    }))
    await expect(
      wrongKind({
        kind: 'close_session',
        ncp_version: NCP_VERSION,
        session_id: 'session-1',
      })
    ).rejects.toThrow(/kind mismatch/)

    const wrongSuccessSession = guardReplyVersion(async () => ({
      kind: 'session_closed',
      ncp_version: NCP_VERSION,
      session_id: 'other',
      ok: true,
    }))
    await expect(
      wrongSuccessSession({
        kind: 'close_session',
        ncp_version: NCP_VERSION,
        session_id: 'session-1',
      })
    ).rejects.toThrow(/session mismatch/)
  })

  it('passes a sessionless wire-0.6 error to the canonical client denial path', async () => {
    const client = new NeuroSimClient(
      guardReplyVersion(async () => ({
        kind: 'error',
        error: 'boom',
      }))
    )
    await expect(client.close('session-1')).rejects.toThrow('NCP error: boom')
  })

  it('composes with NeuroSimClient over a mocked socket', async () => {
    const transport = new WebSocketNeuroSim('ws://localhost/api/neurocontrol/ws')
    const ws = MockWebSocket.last()
    ws.open()

    const client = new NeuroSimClient(guardReplyVersion(transport.send))
    const pending = client.close('sess-guarded')
    await flushMicrotasks()
    // Peer replies with a stale protocol version → the guard rejects it.
    ws.receive({ kind: 'session_closed', ncp_version: '0.1', session_id: 'x', ok: true })

    await expect(pending).rejects.toThrow(NcpVersionMismatchError)
  })
})
