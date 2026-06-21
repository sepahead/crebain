/**
 * Reply `ncp_version` guard — CREBAIN-specific TS glue over `@sepehrmn/ncp`.
 *
 * The canonical `NeuroSimClient` stamps `ncp_version` on every *request* but the
 * package does not validate the version carried on a *reply*: its `unwrap` only
 * rejects `{ kind: 'error', … }` frames. A peer (Engram/Paper2Brain) that drifts
 * to an incompatible protocol could therefore hand CREBAIN a reply whose shape no
 * longer matches the pinned bindings, and we would parse it as a success.
 *
 * This is the one place the `src/neuro` README reserves for CREBAIN-specific glue:
 * a thin, transport-agnostic wrapper that decorates any `Send` so that every
 * non-error reply must carry an `ncp_version` equal to the version this build
 * speaks (`NCP_VERSION`, "0.4"). It changes no wire bytes — NCP stays pinned at
 * v0.4.0 — it only refuses to trust a reply that claims a different protocol.
 *
 * Error frames (`{ kind: 'error', … }`) and primitive replies are passed through
 * untouched so the package's own `unwrap`/error handling keeps working; only a
 * reply object that *has* an `ncp_version` field (or is missing one when one is
 * expected) is checked.
 */
import { NCP_VERSION, type Send } from '@sepehrmn/ncp'

/** Thrown when a reply's `ncp_version` is absent or does not match `NCP_VERSION`. */
export class NcpVersionMismatchError extends Error {
  readonly expected: string
  readonly received: unknown

  constructor(received: unknown) {
    super(
      `NCP reply version mismatch: expected ncp_version "${NCP_VERSION}", got ` +
        `${received === undefined ? '<absent>' : JSON.stringify(received)}`
    )
    this.name = 'NcpVersionMismatchError'
    this.expected = NCP_VERSION
    this.received = received
  }
}

/** Behaviour when a reply fails the version check. */
export type OnVersionMismatch = 'throw' | 'warn'

/**
 * Wrap a `Send` so each reply is checked against `NCP_VERSION` before it reaches
 * `NeuroSimClient`. `mode: 'throw'` (default) rejects the call; `mode: 'warn'`
 * logs and passes the reply through (useful while a peer is mid-migration).
 *
 * @example
 *   const client = new NeuroSimClient(guardReplyVersion(transport.send))
 */
export function guardReplyVersion(send: Send, mode: OnVersionMismatch = 'throw'): Send {
  return async (message) => {
    const reply = await send(message)
    assertReplyVersion(reply, mode)
    return reply
  }
}

/**
 * Validate one already-parsed reply. Pass-through for error frames and
 * non-object/primitive replies; otherwise the reply must carry an `ncp_version`
 * equal to `NCP_VERSION`.
 */
export function assertReplyVersion(reply: unknown, mode: OnVersionMismatch = 'throw'): void {
  // Error frames are handled by the package's `unwrap`; leave them alone.
  if (!isRecord(reply)) return
  if (reply.kind === 'error') return

  const received = reply.ncp_version
  if (received === NCP_VERSION) return

  if (mode === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(
      `NCP reply version mismatch: expected "${NCP_VERSION}", got ` +
        `${received === undefined ? '<absent>' : JSON.stringify(received)}`
    )
    return
  }

  throw new NcpVersionMismatchError(received)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
