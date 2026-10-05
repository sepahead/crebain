/**
 * Contract tests for `src/neuro` — CREBAIN's NCP TypeScript peer.
 *
 * `src/neuro/index.ts` re-exports the canonical `@sepahead/ncp` package (the wire
 * is owned there, pinned to an exact commit) and adds one piece of CREBAIN-specific
 * glue: a reply guard. These tests assert the contract CREBAIN relies on — the
 * public surface exists, the WebSocket transport round-trips a known frame shape
 * against a mocked socket, and the guard refuses a reply that drifts off the pinned
 * protocol version or its request attribution.
 *
 * Request and reply fixtures follow NCP's wire-1.0 conformance vectors at the
 * pinned commit (`conformance/vectors/*.json`).
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
import type { ClientNegotiation, MutationInput } from '../index'
import { installMockWebSocket, MockWebSocket, sentMessages } from '../../test/mockWebSocket'

// Wire-1.0 identity fixtures: the conformance session, its live generation, a stale
// generation, and a stream epoch. All are canonical lowercase UUIDv4 values.
const SESSION_ID = 'vec-open-1'
const GEN = '293279f3-d459-4bfd-aeeb-604799e96925'
const STALE_GEN = '00000000-0000-4000-8000-0000000000a3'
const EPOCH = '00000000-0000-4000-8000-000000000001'
const SESSION = { generation: GEN }
const ENDPOINT = 'ws://127.0.0.1:28471/api/neurocontrol/ws'

/** The conformance controller's negotiated identity and security profile. */
const NEGOTIATION: ClientNegotiation = {
  identity: {
    principal_id: 'controller-principal-1',
    entity_id: 'pid-controller-1',
    role: 'commander',
    plane: 'control',
  },
  security_profile: 'dev-loopback-insecure',
  security_state_digest: '8b65c88deecefc922a191ea646b1a2b9602f733c61d7649e778d0d7087bc15ab',
  gateway_permitted: false,
}

/** The conformance `close_session` request: a sealed wire-1.0 mutation with its
 *  operation context, request digest, and authority lease. */
const CLOSE_REQUEST = {
  ncp_version: '1.0',
  kind: 'close_session',
  session_id: SESSION_ID,
  session: SESSION,
  operation: {
    operation_id: '10000000-0000-4000-8000-000000000003',
    request_digest: 'd1195d90bc7d7050ce67192430210460ff7cea0414bdc5c45b458a7dcb039afb',
    session_epoch: GEN,
    expected_state_version: 3,
    deadline_utc_ms: 1700000030000,
    retry: false,
  },
  authority: {
    session_epoch: GEN,
    term: 1,
    lease_id: '20000000-0000-4000-8000-000000000001',
    issuer_principal_id: 'controller-principal-1',
    holder_principal_id: 'controller-principal-1',
    holder_entity_id: 'pid-controller-1',
    issued_at_utc_ms: 1700000000000,
    expires_at_utc_ms: 1700000030000,
  },
}

const RECEIPT = {
  operation_id: '10000000-0000-4000-8000-000000000003',
  request_digest: '64942aa9644979798b559f3aaeacd53a9fff597afb8782cde70f48568f5dfb8d',
  result_digest: '82bfecaa6d47a3ec4cc56b948f511e641d186d19545b9a0c697b825ecaff5241',
  outcome: 'succeeded',
  state_version: 4,
  committed_at_utc_ms: 1700000001000,
  responder_principal_id: 'body-principal-1',
  responder_entity_id: 'simulator-1',
}

function sessionClosed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'session_closed',
    ncp_version: NCP_VERSION,
    session_id: SESSION_ID,
    ok: true,
    session: SESSION,
    receipt: RECEIPT,
    ...overrides,
  }
}

function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'observation_frame',
    ncp_version: NCP_VERSION,
    session_id: SESSION_ID,
    session: SESSION,
    stream: { epoch: EPOCH, seq: 1 },
    records: {},
    is_simulation_output: true,
    calibrated_posterior: false,
    ...overrides,
  }
}

function typedError(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'error',
    ncp_version: NCP_VERSION,
    code: 'NCP-WIRE-001',
    error: 'boom',
    ...overrides,
  }
}

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record }
  delete copy[key]
  return copy
}

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
    expect(NCP_VERSION).toBe('1.0')
  })

  it('exposes the CREBAIN reply-version guard glue', () => {
    expect(typeof guardReplyVersion).toBe('function')
    expect(typeof assertReplyVersion).toBe('function')
    expect(typeof NcpVersionMismatchError).toBe('function')
  })
})

describe('WebSocketNeuroSim (transport smoke + round-trip)', () => {
  it('constructs against an explicit endpoint', () => {
    const transport = new WebSocketNeuroSim(ENDPOINT)
    expect(transport).toBeInstanceOf(WebSocketNeuroSim)
    expect(MockWebSocket.last().url).toBe(ENDPOINT)
  })

  it('round-trips a known close-session frame through a mocked socket', async () => {
    const transport = new WebSocketNeuroSim(ENDPOINT)
    const ws = MockWebSocket.last()
    ws.open() // resolve the transport `ready` promise

    const pending = transport.send(CLOSE_REQUEST)
    // `send` awaits the `ready` promise before enqueuing; flush microtasks so the
    // request is queued (and serialized onto the socket) before we reply.
    await flushMicrotasks()

    // The peer replies in FIFO order; hand back a wire-shaped SessionClosed reply.
    ws.receive(sessionClosed())

    await expect(pending).resolves.toMatchObject({
      kind: 'session_closed',
      session_id: SESSION_ID,
    })

    // The outbound request carries the stamped protocol version.
    const sent = sentMessages(ws)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      kind: 'close_session',
      ncp_version: NCP_VERSION,
      session_id: SESSION_ID,
    })
  })

  it('settles in-flight requests when the socket errors (disconnect path)', async () => {
    const transport = new WebSocketNeuroSim(ENDPOINT)
    const ws = MockWebSocket.last()
    ws.open()

    const pending = transport.send(CLOSE_REQUEST)
    await flushMicrotasks()
    ws.error()

    await expect(pending).rejects.toThrow('NCP WebSocket error')
  })
})

describe('NeuroSimClient wire-1.0 mutations', () => {
  it('refuses a close for a session this client instance never opened', async () => {
    // Wire 1.0 binds every step, run, and close to a live generation from a
    // successful open. CREBAIN implements no lifecycle role, so it never opens one.
    const client = new NeuroSimClient(async () => sessionClosed(), NEGOTIATION)
    const mutation: MutationInput = {
      operation: without(CLOSE_REQUEST.operation, 'request_digest') as MutationInput['operation'],
      authority: CLOSE_REQUEST.authority,
    }
    await expect(client.close(SESSION_ID, mutation)).rejects.toThrow(/no live generation/)
  })
})

describe('reply ncp_version guard', () => {
  it('passes a reply that matches the pinned version through unchanged', () => {
    expect(() => assertReplyVersion(sessionClosed())).not.toThrow()
  })

  it('throws on a mismatched reply version', () => {
    expect(() => assertReplyVersion(sessionClosed({ ncp_version: '0.1' }))).toThrow(
      NcpVersionMismatchError
    )
    expect(() => assertReplyVersion(sessionClosed({ ncp_version: '2.0' }))).toThrow(
      NcpVersionMismatchError
    )
  })

  it('rejects the retired wire (0.8) via the SDK compatibility gate', () => {
    expect(() => assertReplyVersion(sessionClosed({ ncp_version: '0.8' }))).toThrow(
      NcpVersionMismatchError
    )
  })

  it('throws on a reply that is missing ncp_version', () => {
    expect(() => assertReplyVersion(without(sessionClosed(), 'ncp_version'))).toThrow(/<absent>/)
  })

  it('reports hostile non-string versions through the stable mismatch error', () => {
    for (const ncpVersion of [1n, Symbol('wire'), {}, null]) {
      expect(() => assertReplyVersion({ kind: 'session_closed', ncp_version: ncpVersion })).toThrow(
        NcpVersionMismatchError
      )
    }
  })

  it('rejects a reply that violates the scientific boundary', () => {
    // A peer must not hand CREBAIN a frame claiming calibrated / non-simulation
    // status; the guard applies the SDK's scientific-boundary checks on inbound
    // replies.
    expect(() => assertReplyVersion(observation({ is_simulation_output: false }))).toThrow()
    expect(() => assertReplyVersion(observation({ calibrated_posterior: true }))).toThrow()
    // An honest observation frame passes.
    expect(() => assertReplyVersion(observation())).not.toThrow()
  })

  it('accepts a complete typed wire-1.0 error frame', () => {
    // Wire 1.0 requires `session_id` and `session` to be present or null together.
    expect(() =>
      assertReplyVersion(
        typedError({ session_id: 'session-1', session: SESSION, request_kind: 'close_session' })
      )
    ).not.toThrow()
  })

  it('rejects malformed errors, malformed successes, and primitive replies', () => {
    expect(() => assertReplyVersion(without(typedError(), 'ncp_version'))).toThrow(
      NcpVersionMismatchError
    )
    expect(() => assertReplyVersion(without(typedError(), 'code'))).toThrow(/code/)
    expect(() => assertReplyVersion(typedError({ error: '' }))).toThrow(/non-empty/)
    expect(() => assertReplyVersion(typedError({ session_id: 7 }))).toThrow(/session_id/)
    expect(() => assertReplyVersion(typedError({ session_id: '' }))).toThrow(/session_id/)
    expect(() => assertReplyVersion(without(sessionClosed(), 'ok'))).toThrow(/required field "ok"/)
    expect(() =>
      assertReplyVersion(sessionClosed({ ok: false, receipt: null, error: 'denied' }))
    ).toThrow()
    expect(() => assertReplyVersion('error')).toThrow()
  })

  it('requires complete observation identity and a map-shaped records field', () => {
    expect(() => assertReplyVersion(without(observation(), 'session_id'))).toThrow(/session_id/)
    expect(() => assertReplyVersion(observation({ records: [] }))).toThrow(/records/)
  })

  it('enforces the wire-1.0 observation stream.seq gate', () => {
    // An observation carries its OWN stream position (`stream.seq >= 1`); the
    // pull/RPC-reply form is distinguished by `source` ABSENCE, not a `seq == 0`
    // sentinel. So `stream.seq` 1 is valid and 0 is rejected.
    const withSeq = (seq: number) => observation({ stream: { epoch: EPOCH, seq } })
    expect(() => assertReplyVersion(withSeq(1))).not.toThrow()
    expect(() => assertReplyVersion(withSeq(0))).toThrow(/seq/)
    expect(() => assertReplyVersion(withSeq(-1))).toThrow(/seq/)
    expect(() => assertReplyVersion(withSeq(1.5))).toThrow(/seq/)
  })

  it('guardReplyVersion wraps a Send and rejects a drifted reply', async () => {
    const guarded = guardReplyVersion(async () => sessionClosed({ ncp_version: '0.1' }))
    await expect(guarded(CLOSE_REQUEST)).rejects.toThrow(NcpVersionMismatchError)
  })

  it('guardReplyVersion forwards a matching reply', async () => {
    const guarded = guardReplyVersion(async () => sessionClosed())
    await expect(guarded(CLOSE_REQUEST)).resolves.toMatchObject({ session_id: SESSION_ID })
  })

  it('rejects success replies and errors attributed to another session', async () => {
    const wrongSession = guardReplyVersion(async () =>
      typedError({ session_id: 'other', session: SESSION, request_kind: 'close_session' })
    )
    await expect(wrongSession(CLOSE_REQUEST)).rejects.toThrow(/session mismatch/)

    const wrongKind = guardReplyVersion(async () => observation())
    await expect(wrongKind(CLOSE_REQUEST)).rejects.toThrow(/kind mismatch/)

    const wrongSuccessSession = guardReplyVersion(async () =>
      sessionClosed({ session_id: 'other' })
    )
    await expect(wrongSuccessSession(CLOSE_REQUEST)).rejects.toThrow(/session mismatch/)
  })

  it('rejects an error attributed to a different request kind', async () => {
    const wrongRequest = guardReplyVersion(async () => typedError({ request_kind: 'open_session' }))
    await expect(wrongRequest(CLOSE_REQUEST)).rejects.toThrow(/request_kind mismatch/)
  })

  it('rejects a typed error attributed to a stale session generation', async () => {
    const staleError = guardReplyVersion(async () =>
      typedError({
        error: 'stale session',
        request_kind: 'close_session',
        session_id: SESSION_ID,
        session: { generation: STALE_GEN },
      })
    )
    await expect(staleError(CLOSE_REQUEST)).rejects.toThrow(/error generation mismatch/)
  })

  it('rejects a success reply from a stale session generation', async () => {
    const staleGeneration = guardReplyVersion(async () =>
      sessionClosed({ session: { generation: STALE_GEN } })
    )
    await expect(staleGeneration(CLOSE_REQUEST)).rejects.toThrow(/generation mismatch/)
  })

  it('passes a sessionless typed error through the guard unchanged', async () => {
    const guarded = guardReplyVersion(async () => typedError({ request_kind: 'close_session' }))
    await expect(guarded(CLOSE_REQUEST)).resolves.toMatchObject({ kind: 'error', error: 'boom' })
  })

  it('composes with WebSocketNeuroSim over a mocked socket', async () => {
    const transport = new WebSocketNeuroSim(ENDPOINT)
    const ws = MockWebSocket.last()
    ws.open()

    const pending = guardReplyVersion(transport.send)(CLOSE_REQUEST)
    await flushMicrotasks()
    // Peer replies with a stale protocol version → the guard rejects it.
    ws.receive({ kind: 'session_closed', ncp_version: '0.1', session_id: 'x', ok: true })

    await expect(pending).rejects.toThrow(NcpVersionMismatchError)
  })
})
