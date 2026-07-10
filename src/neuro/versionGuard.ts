/**
 * Reply `ncp_version` + scientific-boundary guard — CREBAIN-specific TS glue over
 * `@sepahead/ncp`.
 *
 * The canonical `NeuroSimClient` stamps `ncp_version` on every request and
 * validates success versions internally. CREBAIN also gates the transport
 * boundary so reply shape, scientific claims, and request attribution fail closed
 * before the canonical client consumes them.
 *
 * NCP stays pinned at immutable release v0.6.0. Wire-0.6 error frames are
 * deliberately unversioned and may omit session identity; a present session must
 * still match the request.
 */
import {
  NCP_VERSION,
  assertWireFrame,
  checkVersion,
  assertScientificBoundary,
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
        `${received === undefined ? '<absent>' : JSON.stringify(received)}`
    )
    this.name = 'NcpVersionMismatchError'
    this.expected = NCP_VERSION
    this.received = received
  }
}

/**
 * Wrap a `Send` so each reply is checked before it reaches
 * `NeuroSimClient`: compatible version, scientific boundary, exact success
 * kind/session attribution, and optional error-session consistency.
 */
export function guardReplyVersion(send: Send): Send {
  return async (message) => {
    const reply = await send(message)
    assertReplyVersion(reply)
    assertReplyAttribution(reply, message)
    return reply
  }
}

/**
 * Validate one parsed reply. Successes must be complete and version-compatible.
 * Wire-0.6 error frames have no mandatory version but must carry a non-empty
 * error and can never pass as success.
 */
export function assertReplyVersion(reply: unknown): void {
  if (!isRecord(reply)) throw new Error('NCP reply is not an object')

  if (reply.kind === 'error') {
    if (typeof reply.error !== 'string' || reply.error.length === 0) {
      throw new Error('NCP error reply must include a non-empty string error')
    }
    if (
      reply.session_id !== undefined &&
      reply.session_id !== null &&
      (typeof reply.session_id !== 'string' || reply.session_id.length === 0)
    ) {
      throw new Error('NCP error reply session_id must be a string or null')
    }
    return
  }

  const received = reply.ncp_version
  try {
    if (typeof received !== 'string') throw new NcpVersionMismatchError(received)
    checkVersion(received, true)
    if (reply.kind === 'observation_frame') {
      assertWireFrame(reply, 'observation_frame')
      if (typeof reply.session_id !== 'string' || reply.session_id.length === 0) {
        throw new Error('NCP observation_frame reply must include a non-empty string session_id')
      }
      if (!isRecord(reply.records)) {
        throw new Error('NCP observation_frame reply must include a records object')
      }
    } else if (reply.kind === 'session_opened' || reply.kind === 'session_closed') {
      if (typeof reply.session_id !== 'string' || reply.session_id.length === 0) {
        throw new Error(`NCP ${reply.kind} reply must include a non-empty string session_id`)
      }
      if (typeof reply.ok !== 'boolean') {
        throw new Error(`NCP ${reply.kind} reply must include a boolean ok field`)
      }
      if (!reply.ok) {
        const detail =
          typeof reply.error === 'string' && reply.error.length > 0 ? `: ${reply.error}` : ''
        throw new Error(`NCP ${reply.kind} reply rejected the request${detail}`)
      }
    } else {
      throw new Error(`unsupported NCP reply kind ${JSON.stringify(reply.kind)}`)
    }
  } catch (error) {
    if (error instanceof NcpVersionError) throw new NcpVersionMismatchError(received)
    throw error
  }
  assertScientificBoundary(reply)
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
  if (typeof requestKind !== 'string' || EXPECTED_REPLY_KIND[requestKind] === undefined) {
    throw new Error(`unsupported NCP request kind ${JSON.stringify(requestKind)}`)
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('NCP lifecycle request carries no non-empty string session_id')
  }
  if (reply.kind === 'error') {
    if (reply.session_id != null && reply.session_id !== sessionId) {
      throw new Error(
        `NCP error session mismatch: expected ${JSON.stringify(sessionId)}, got ${JSON.stringify(reply.session_id)}`
      )
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
