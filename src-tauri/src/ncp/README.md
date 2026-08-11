# `src-tauri/src/ncp` — optional native NCP adapter

<!-- ncp-pin: v0.8.0 -->

This module is CREBAIN's Rust + Zenoh adapter for the Neuro-Cybernetic Protocol
(NCP). Project-specific pose/velocity/channel mapping stays here. The canonical
wire types and key construction come from pinned `ncp-core` and `ncp-zenoh`
dependencies in [`src-tauri/Cargo.toml`](../../Cargo.toml).

<p align="center">
  <img alt="CREBAIN headless NCP and Engram host boundaries" src="../../../assets/diagrams/engram-ncp-boundary.svg" width="900">
</p>

Text alternative: The feature-gated `crebain-ncp-headless` process uses
strict-client-config NCP wire 0.8 without Tauri, inference, image, or plant dependencies.
It bounds open, 1–4,096 steps, and close against a compatible external responder.
Self-check and validation do not cross the transport boundary. The separate
Engram UI host is read-only and has no NCP path. Current Engram wire 1.0 is
incompatible, and no translator or live loop exists. A successful, validated
RPC reply shows that one compatible responder replied. It does not prove
receiver identity, end-to-end effect, TLS, ACL, scientific validity, or
deployment readiness.

The adapter requires a compatible NCP wire-0.8 responder. The default
`engram/ncp` realm is only a routing address. Current Engram native-1.0 material
is incompatible with this adapter. CREBAIN has no 0.8-to-1.0 translator.

This action/control adapter is **dormant in the product runtime**:

- the `ncp` Cargo feature is off by default
- `NcpHandle` is not managed by the Tauri builder
- `ncp_connect`, `ncp_open_feature_neuron`, `ncp_step_feature_neuron`, and
  `ncp_close` are not registered in `generate_handler!`
- no frontend hook runs a perception/action loop

The workspace also contains the dependency-isolated `crebain-ncp-headless`
package. Its default feature set is empty. Feature `ncp` builds a separate,
perception-only process. The process does not register Tauri commands, subscribe
to actions, publish sensor frames, or construct plant authority.

Compiling this module does not create a live integration with current Engram.
The same Cargo feature also compiles sibling Galadriel registry, envelope, and
producer modules. Those are not this action adapter: the application may manage
the evidence producer after its separate exact runtime opt-in and deployment-pin
preflight while all four `ncp_*` commands here remain unregistered.

## Build and test

The SDK is pinned to tag `v0.8.0` in both Cargo and npm manifests. The Bun lock
uses the annotated tag-object abbreviation `54008b1`. The Cargo lock uses the
peeled commit `2f5bd586d4bb20c90362bb6f5698b7f64057ba4e`. These identities differ
by Git object type. The offline coherence check binds both to the full tag object
in `scripts/ncp-release-identities.tsv`. A sibling checkout is not required, but
the pinned dependency must be resolvable when Cargo builds the feature.

```bash
# Dormant bridge and Galadriel producer
bun run check:rust:ncp
bun run clippy:rust:ncp
bun run test:rust:ncp

# Separate headless perception package
bun run check:ncp-headless-boundary
bun run check:ncp-headless
bun run clippy:ncp-headless
bun run test:ncp-headless
bun run self-check:ncp-headless
```

Keep `src-tauri/Cargo.toml`, `src-tauri/crates/ncp-headless/Cargo.toml`,
`src-tauri/Cargo.lock`, `package.json`, and `bun.lock` on one compatible NCP
release. Do not copy a wire version from an external example. Current
Engram/Paper2Brain native wire-1.0 material is newer and incompatible with
CREBAIN wire 0.8. Stale `std_msgs` conventions must also be corrected in their
owning repository before use as deployment evidence.

## Headless perception process

Use an explicit command. No argument opens a network connection.

```bash
cargo run --locked --manifest-path src-tauri/Cargo.toml \
  -p crebain-ncp-headless --features ncp \
  --bin crebain-ncp-headless -- self-check
NCP_ZENOH_CONFIG=/trusted/ncp.json \
  cargo run --locked --manifest-path src-tauri/Cargo.toml \
  -p crebain-ncp-headless --features ncp \
  --bin crebain-ncp-headless -- validate --session-id <id>
```

`self-check` reads no runner configuration and opens no Zenoh session. `validate`
requires `NCP_ZENOH_CONFIG`. It validates the bounded strict client configuration
and opens no Zenoh session. This preflight does not prove Transport Layer Security (TLS), access
control list (ACL), identity, certificate, topology, or peer compatibility.

Only `run` opens transport. It accepts only the strict secure-client
configuration posture and requires a compatible wire-0.8 responder. It accepts
at most 4,096 steps. Each operation is limited to 15 seconds. The whole
lifecycle is limited to 300 seconds and reserves a close window. Output contains
at most 4,096 finite, nonnegative spike counts.

After a confirmed open, every handled failure path makes a bounded close
attempt. An open timeout leaves remote state unconfirmed. Closing that identifier
could terminate an unrelated session, so the process reports the ambiguity and
makes no remote-cleanup claim. A reply proves that some responder replied. It
does not identify that responder as the intended deployment receiver or prove
an end-to-end effect. It also does not prove deployment security.

## Available library surface

- `sensor_frame_from_pose`: pose + body velocity to NCP `SensorFrame`.
  It returns `Result` and rejects a wire-invalid sequence.
- `velocity_from_command`: strict one-frame conversion to
  `VelocitySetpointProposal`. Only a valid active `velocity_setpoint` in `m/s`
  can produce a nonzero local proposal, while HOLD/ESTOP produce zero velocity.
- `CommandPlant`: wraps the SDK `ActionBuffer`, validates active commands, replays
  a bounded predictive horizon, enforces monotonic sequence and TTL, and returns
  zero velocity after expiry/drain/invalid state.
- `NcpBridge`: bounded Zenoh connect/control RPC, sensor publish, and action
  subscription helpers.
- `open_feature_neuron` / `step_feature_neuron` / `close`: the current
  single-population perception example.
- `crebain-ncp-headless`: the external secure-configuration-only
  open-step-close process. It uses the same CREBAIN feature-neuron client as
  `NcpBridge`. That shared client uses bounded Zenoh queries and pinned NCP
  validation. It does not delegate lifecycle queries to `ZenohNcpClient`.

`subscribe_commands` now owns a 50 Hz local action loop. Wire-valid commands pass
through `CommandPlant`. A recognizable raw ESTOP is reduced to a minimal command
and latched before the receive-time/wire gate. Other invalid/incompatible frames
are logged and dropped. Every action loop owns a dedicated subscriber container;
stop, close, setup cancellation, and runtime drop release that container without
closing the shared Zenoh session. Reconnect drains the previous runtime's action
loops before replacement. Close requests a final zero-velocity local HOLD
proposal before the remote RPC. A nonblocking, nonpanicking proposal callback is
required. Callback failure/timeout is surfaced because final local notification
cannot then be guaranteed. The callback has no transport or actuator capability.

## Connection posture

`NcpBridge::connect` and the dormant `ncp_connect` command default to `Secure`.
That path requires `NCP_ZENOH_CONFIG` to name a readable Zenoh configuration;
missing or malformed configuration fails closed. `QuietDevelopment` selects the
pinned SDK's generic `open_realm` path. If `NCP_ZENOH_CONFIG` is unset, that path
uses the scouting-off default and does not establish authentication. If the
variable is set, the path loads an arbitrary configuration without the strict
secure-client validation. Neither outcome is deployment-security evidence.

Successfully loading a configuration proves only startup posture. CREBAIN cannot
prove that its Transport Layer Security (TLS) identities, access control list
(ACL) rules, router topology, or certificate policy are sufficient. Those remain
target-deployment evidence.

The sibling Galadriel producer has no `QuietDevelopment` option: enabled startup
always requests secure mode. That remains a configuration request, not evidence
that the supplied file actually establishes TLS/mTLS, an ACL, or a binding
between its authenticated principal and the envelope's declared `producer_id`.

The headless process also has no `QuietDevelopment` option. `validate` and `run`
each read and validate one bounded configuration snapshot. `run` applies the
pinned v0.8 secure-client admission rules to its parsed snapshot. It then passes
the snapshot to `ZenohBus::with_config`. It does not reopen the configuration
path. Admission requires client mode, disabled scouting, only `tls/` connect
endpoints, no listeners, certificate paths, and peer-name verification. These
checks do not attest TLS, an ACL, peer identity, or topology.

## Input and reply boundaries

- realm and model names are limited to 128 bytes and safe key/name characters;
- session IDs are limited to 64 bytes and safe key characters in both clients;
- `drive_pa` is finite and within ±1,000,000 pA;
- `advance_ms` is finite and within `(0, 10,000]`;
- active velocity norm is at most 100 m/s;
- command TTL is finite and within `(0, 60,000]` ms;
- horizon length is at most 1,000, requires a positive finite interval, and may
  not extend beyond TTL;
- inbound command JSON is capped at 256 KiB, and accepted commands retain only
  the required bounded velocity channel/horizon in the action buffer;
- sensor payload session IDs must equal the requested route; normal command
  payload session IDs and concrete callback keys must equal the subscribed
  route. The legacy raw ESTOP exception is callback-key-bound but still accepts
  an omitted or malformed payload session field;
- Zenoh connect and each control RPC time out after 15 seconds;
- each lifecycle query accepts one reply and rejects a second reply;
- a reply larger than 1 MiB is rejected before payload materialization;
- each action subscription setup times out after 15 seconds and close prevents a
  new loop until an explicit successful reopen;
- at most 64 action loops/reservations and 256 closed-session tombstones are
  retained. Tombstone saturation rejects all new opens/actions until reconnect;
- action-loop stop waits at most 1 second before aborting the task;
- a successful open must return a canonical server-issued generation. Step and
  close requests echo it, and observation and close replies must match it;
- at most 256 feature-session states are retained. Ambiguous open and close
  outcomes remain fail closed until reconnect;
- RPC replies must be valid NCP, have the expected `kind`, include required
  explicit boolean result fields (`ok` is never inferred from an SDK default),
  report success, and return the requested session ID.
- feature-neuron observations must provide the expected `spk` port/target,
  `spikes` observable, and finite spike times.

The shared client delegates wire, version, and scientific-boundary validation
to pinned `ncp-core`. Contract-hash differences remain advisory. Version errors
remain hard failures.

## Deliberate product integration

Exposing the four Tauri control commands requires managing `NcpHandle`, adding
the commands to `generate_handler!`, updating the frontend command registry and
contract tests, and adding an explicit opt-in UI/hook. Closed-loop action would
also require a separately reviewed narrow plant adapter, exclusive authority,
fresh-state and expiry gates, and FCU evidence. The current callback only emits
a `VelocitySetpointProposal`. Registration alone is not a plant or actuator loop.

Before a live deployment claim, also prove the target NCP realm/key ACL allows
the CREBAIN participant. Repository unit tests do not validate an external
Engram/Galadriel ACL or network topology.

The Galadriel evidence path is documented separately in
[`docs/GALADRIEL_PRODUCER.md`](../../../docs/GALADRIEL_PRODUCER.md). Its two
advisory output keys do not register these Tauri commands, activate
`CommandPlant`, or provide an actuator callback.

## Scientific boundary

Returned membrane potential/spikes are raw simulation outputs
(`calibrated_posterior=false`, `is_simulation_output=true`), not a validated
biological reproduction. A neuro-controller is a control artifact, not a
scientific or safety claim.
