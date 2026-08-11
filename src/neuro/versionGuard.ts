/**
 * Reply `ncp_version` + scientific-boundary guard — CREBAIN-specific TS glue over
 * `@sepahead/ncp`.
 *
 * The canonical `NeuroSimClient` stamps `ncp_version` on every request and wire
 * 0.8 validates success and typed-error replies internally. CREBAIN also gates
 * the transport boundary so reply shape, scientific claims, and request
 * attribution fail closed before the canonical client consumes them.
 *
 * NCP stays pinned by its release tag and lockfile identities. Typed errors pass
 * the same canonical version/message gate as successes. Optional request and
 * session attribution must match when present.
 */
import {
  NCP_VERSION,
  assertNcpMessage,
  checkVersion,
  NcpVersionError,
  type Send,
} from '@sepahead/ncp'

/** Stable CREBAIN error type for an absent or incompatible reply version. */
export class NcpVersionMismatchError extends Error {
  readonly expected: string
  readonly received: unknown

  constructor(received: unknown) {
    super(
      `NCP reply version mismatch: expected wire-compatible with "${NCP_VERSION}", got ` +
        describeVersionValue(received)
    )
    this.name = 'NcpVersionMismatchError'
    this.expected = NCP_VERSION
    this.received = received
  }
}

function describeVersionValue(value: unknown): string {
  if (value === undefined) return '<absent>'
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  return `<${typeof value}>`
}

/**
 * Wrap a `Send` so each reply is checked before it reaches
 * `NeuroSimClient`: compatible version, scientific boundary, exact success
 * kind/session attribution, post-open generation attribution, and optional
 * error-session consistency.
 */
export function guardReplyVersion(send: Send): Send {
  return async (message) => {
    assertNcpMessage(message)
    const reply = await send(message)
    assertReplyVersion(reply)
    assertReplyAttribution(reply, message)
    return reply
  }
}

/**
 * Validate one parsed reply. Successes and typed errors must both be complete
 * and wire-compatible; an unversioned error is not a safe escape hatch.
 */
export function assertReplyVersion(reply: unknown): void {
  if (!isRecord(reply)) throw new Error('NCP reply is not an object')
  const received = reply.ncp_version
  if (typeof received !== 'string') throw new NcpVersionMismatchError(received)
  try {
    checkVersion(received, true)
    assertNcpMessage(reply)
  } catch (error) {
    if (error instanceof NcpVersionError) throw new NcpVersionMismatchError(received)
    throw error
  }

  if (reply.kind === 'error' || reply.kind === 'observation_frame') return
  if (reply.kind === 'session_opened' || reply.kind === 'session_closed') {
    if (reply.ok !== true) {
      const detail =
        typeof reply.error === 'string' && reply.error.length > 0 ? `: ${reply.error}` : ''
      throw new Error(`NCP ${reply.kind} reply rejected the request${detail}`)
    }
    return
  }
  throw new Error(`unsupported NCP reply kind ${JSON.stringify(reply.kind)}`)
}

const EXPECTED_REPLY_KIND: Readonly<Record<string, string>> = {
  open_session: 'session_opened',
  step_request: 'observation_frame',
  run_request: 'observation_frame',
  close_session: 'session_closed',
}

function assertReplyAttribution(
  reply: unknown,
  request: Record<string, unknown>
): asserts reply is Record<string, unknown> {
  if (!isRecord(reply)) throw new Error('NCP reply is not an object')
  const requestKind = request.kind
  const sessionId = request.session_id
  if (typeof requestKind !== 'string' || !Object.hasOwn(EXPECTED_REPLY_KIND, requestKind)) {
    throw new Error(`unsupported NCP request kind ${JSON.stringify(requestKind)}`)
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('NCP lifecycle request carries no non-empty string session_id')
  }
  if (reply.kind === 'error') {
    if (reply.request_kind != null && reply.request_kind !== requestKind) {
      throw new Error(
        `NCP error request_kind mismatch: expected ${JSON.stringify(requestKind)}, got ${JSON.stringify(reply.request_kind)}`
      )
    }
    if (reply.session_id != null && reply.session_id !== sessionId) {
      throw new Error(
        `NCP error session mismatch: expected ${JSON.stringify(sessionId)}, got ${JSON.stringify(reply.session_id)}`
      )
    }
    if (requestKind !== 'open_session' && reply.session != null) {
      const requestGeneration = sessionGeneration(request)
      const replyGeneration = sessionGeneration(reply)
      if (requestGeneration !== replyGeneration) {
        throw new Error(
          `NCP error generation mismatch: expected ${JSON.stringify(requestGeneration)}, got ${JSON.stringify(replyGeneration)}`
        )
      }
    }
    return
  }
  const expectedKind = EXPECTED_REPLY_KIND[requestKind]
  if (reply.kind !== expectedKind) {
    throw new Error(
      `NCP reply kind mismatch: expected ${JSON.stringify(expectedKind)}, got ${JSON.stringify(reply.kind)}`
    )
  }
  if (reply.session_id !== sessionId) {
    throw new Error(
      `NCP reply session mismatch: expected ${JSON.stringify(sessionId)}, got ${JSON.stringify(reply.session_id)}`
    )
  }

  if (requestKind !== 'open_session') {
    const requestGeneration = sessionGeneration(request)
    const replyGeneration = sessionGeneration(reply)
    if (requestGeneration !== replyGeneration) {
      throw new Error(
        `NCP reply generation mismatch: expected ${JSON.stringify(requestGeneration)}, got ${JSON.stringify(replyGeneration)}`
      )
    }
  }
}

function sessionGeneration(message: Record<string, unknown>): string {
  const session = message.session
  if (
    !isRecord(session) ||
    typeof session.generation !== 'string' ||
    session.generation.length === 0
  ) {
    throw new Error('NCP session-scoped message carries no non-empty session generation')
  }
  return session.generation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
