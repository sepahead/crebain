# CREBAIN ↔ NCP bridge handoff

<!-- ncp-pin: v0.8.0 -->

This is the current implementation handoff for CREBAIN's optional
Neuro-Cybernetic Protocol integration. It replaces the former extraction plan;
the sibling-path dependency problem is historical and already fixed.

## Product boundary

CREBAIN's detection, fusion, visualization, and interception prototype remains
standalone. NCP is not on the default runtime path:

| Surface | Current state |
|---------|---------------|
| Rust `src-tauri/src/ncp/mod.rs` | Compiles only with the off-by-default `ncp` feature; provides `NcpBridge`, validated feature-neuron RPCs, and a wired fail-closed `CommandPlant` action loop as library APIs |
| Rust Tauri commands | Defined, but `NcpHandle` is not managed and the four `ncp_*` commands are not registered |
| TypeScript `src/neuro` | Thin guarded re-export of `@sepahead/ncp`; imported by no product component/hook |
| Vite-dev `window.__ncpDrone` | Manual in-browser wire-shaped command injection; no NCP transport/session; absent from production builds |
| Live CREBAIN↔Engram loop | Not implemented or enabled |

No Engram process or sibling checkout is required to run CREBAIN. Cargo's pinned
Git dependencies must still be network/cache-resolvable when resolving or building
the NCP feature; “no sibling checkout” does not mean “no dependency resolution.”

## Current dependency contract

The canonical NCP SDK lives at `github.com/sepahead/NCP`. CREBAIN pins tag
`v0.8.0` in:

- `ncp-core` and `ncp-zenoh` in `src-tauri/Cargo.toml` / `Cargo.lock`; and
- `@sepahead/ncp` in `package.json` / `bun.lock`.

All four files must move together. Wire compatibility is validated by the SDK;
CREBAIN does not coerce incompatible or missing versions into success. External
Engram examples that show an older incompatible wire contract, old package scopes,
or `std_msgs` profiles are stale integration material and must be corrected in their owning
repository rather than copied here.

The audited external ACL/profile set also does not currently establish an
authorized Galadriel-sidecar identity in CREBAIN's intended realm. That is an
external deployment blocker, not permission to widen CREBAIN or NCP ACLs here.
Resolve and test it in the owning NCP/Engram deployment before a live ecosystem
claim.

## Implemented Rust safety path

The current native adapter validates realm/session/model names, feature-neuron
inputs, RPC kind/version/body/session identity, required spike records, command
units/shapes/speeds, sequence, TTL, and horizon bounds. Connect and control RPCs
are bounded by 15-second timeouts.

Native connect defaults to `Secure`: `NCP_ZENOH_CONFIG` must name a readable
Zenoh configuration or startup fails closed. `QuietDevelopment` is an explicit
unauthenticated development choice. Loading either configuration is not proof
that the target TLS identities, ACL policy, certificates, or topology are
correct.

`NcpBridge::subscribe_commands` feeds wire-validated frames into `CommandPlant`
and runs a 50 Hz output loop. A recognizable raw ESTOP latches first; every other
frame passes the wire gate. The plant stores only its bounded actuator channel and
horizon, enforces SDK sequence/TTL semantics, and emits zero velocity when no
usable command remains. Each loop owns subscriber handles that are dropped on
stop/close/cancellation. Lifecycle operations are serialized per session, so a
loop cannot install after close without a successful reopen. Stop/close requests
a final HOLD before remote close; a stuck or panicked callback is reported after
the one-second stop bound instead of claiming success. Reconnect drains the old
runtime's action loops before replacing the managed bridge.
Action reservations and persistent close tombstones are cardinality-bounded;
tombstone saturation fails closed until reconnect rather than evicting safety
state.

Lifecycle RPCs use the pinned SDK's `ZenohNcpClient` typed gates. Wire 0.8 checks
the raw envelope before deserialization, requires explicit lifecycle result
fields, binds reply kind/session to the originating request, and validates
versioned typed-error attribution. CREBAIN accepts no local permissive reply
path.

This remains a library guarantee, not a product deployment claim: no registered
command or frontend hook calls the loop, and no callback is wired to MAVROS by
default.

## Validation

```bash
# Default product and full local gate
bun run validate:all

# Read-only Cargo/npm pin, lockfile, and normative-doc guard
bun run check:ncp-coherence

# Focused optional bridge gates
bun run check:rust:ncp
bun run clippy:rust:ncp
bun run test:rust:ncp
```

CI must run NCP clippy/tests on clean Linux and macOS checkouts. The default
command-registry contract must continue to exclude `ncp_*` until a deliberate
product integration updates the registry, Tauri handler, tests, and UI together.

## Work required before a live integration

1. Add an explicit user/deployment opt-in and manage `NcpHandle`.
2. Register the four control-plane Tauri commands and synchronize the frontend
   registry/contract tests.
3. Decide whether the product uses native Rust or TypeScript WebSocket control;
   do not run two competing control planes.
4. Wire pose/velocity input and the validated action callback to the intended
   actuator publisher with a documented ownership/stop lifecycle.
5. Prove the external Engram realm, key ACL, version, session behavior, and
   failure recovery in the target network.
6. Supply and audit the secure Zenoh configuration, identities, and certificates;
   loading `NCP_ZENOH_CONFIG` alone is insufficient evidence.
7. Reconcile stale external Engram examples/profiles before treating them as
   executable integration documentation.

## Non-goals and evidence limits

- CREBAIN must not become an NCP commander or depend on Engram for a core result.
- Protocol changes belong in the NCP repository; project mapping remains here.
- Raw simulation outputs are not calibrated biological/scientific results.
- The Galadriel PID JSONL sidecar is separate from NCP. Its local parser/NIS tests
  do not prove Galadriel correlation, PID actuation, realm ACLs, or a live NCP
  session.
