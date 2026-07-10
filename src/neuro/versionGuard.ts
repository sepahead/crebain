/**
 * Reply `ncp_version` + scientific-boundary guard — CREBAIN-specific TS glue over
 * `@sepahead/ncp`.
 *
 * The canonical `NeuroSimClient` stamps `ncp_version` on every *request*, and
 * since wire 0.6 the package validates the version on a *reply* internally — but
 * CREBAIN wraps the transport so the check happens at the `Send` boundary, using
 * the SAME compatibility semantics as every other NCP peer and additionally
 * pinning the scientific-boundary discriminators. A peer (Engram) that drifts to
 * an incompatible protocol, or hands back a frame claiming calibrated /
 * non-simulation status, is refused before it reaches `NeuroSimClient`.
 *
 * This is the one place the `src/neuro` README reserves for CREBAIN-specific glue:
 * a thin, transport-agnostic wrapper that decorates any `Send`. It changes no wire
 * bytes — NCP stays pinned at v0.6.0 — it only refuses to trust an incompatible or
 * boundary-violating reply.
 *
 * Version compatibility uses the SDK's `checkVersion` (the hard `(major, minor)`
 * pre-1.0 gate — identical to the Rust/Python/C++ peers), NOT a bespoke exact
 * string compare, so it stays correct across a future `1.x` where the minor is no
 * longer breaking. Error frames (`{ kind: 'error', … }`) and primitive replies
 * pass through so the package's own `unwrap`/error handling keeps working.
 */
import {
  NCP_VERSION,
  checkVersion,
  assertScientificBoundary,
  NcpVersionError,
  type Send,
} from '@sepahead/ncp'
import { logger } from '../lib/logger'

const log = logger.scope('NCP')

/** Thrown when a reply's `ncp_version` is absent or not wire-compatible with this
 *  build. Kept as a stable CREBAIN type while the underlying compatibility rule is
 *  now the canonical SDK one (`checkVersion`). */
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

/** Behaviour when a reply fails a check. */
export type OnVersionMismatch = 'throw' | 'warn'

/**
 * Wrap a `Send` so each reply is checked against the wire contract before it
 * reaches `NeuroSimClient`: (1) a compatible `ncp_version` (SDK `checkVersion`),
 * and (2) the scientific-boundary discriminators (SDK `assertScientificBoundary`
 * — `is_simulation_output === true`, `calibrated_posterior === false`). `mode:
 * 'throw'` (default) rejects the call; `mode: 'warn'` logs and passes through
 * (useful while a peer is mid-migration).
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
 * wire-compatible with this build AND satisfy the scientific-boundary pins.
 */
export function assertReplyVersion(reply: unknown, mode: OnVersionMismatch = 'throw'): void {
  // Error frames are handled by the package's `unwrap`; leave them alone.
  if (!isRecord(reply)) return
  if (reply.kind === 'error') return

  const received = reply.ncp_version
  // The version must be present and wire-compatible. `checkVersion` throws
  // NcpVersionError on an unparseable/absent version; treat that and an
  // incompatible (returns false) version identically — a mismatch.
  let compatible: boolean
  try {
    compatible = typeof received === 'string' && checkVersion(received, false)
  } catch (e) {
    if (!(e instanceof NcpVersionError)) throw e
    compatible = false
  }
  if (!compatible) {
    if (mode === 'warn') {
      log.warn('NCP reply version mismatch', {
        expected: NCP_VERSION,
        received: received === undefined ? '<absent>' : received,
      })
    } else {
      throw new NcpVersionMismatchError(received)
    }
  }

  // Scientific boundary: a reply asserting calibrated / non-simulation status is
  // refused, never trusted (mirrors ncp_core::validate's boundary pins). Only
  // frames that CARRY the discriminators are checked; others pass through.
  try {
    assertScientificBoundary(reply)
  } catch (e) {
    if (mode === 'warn') {
      log.warn('NCP reply boundary violation', {
        error: e instanceof Error ? e.message : String(e),
      })
    } else {
      throw e
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
