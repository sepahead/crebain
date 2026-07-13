# `src-tauri/src/ncp` — optional native NCP adapter

<!-- ncp-pin: v0.8.0 -->

This module is CREBAIN's Rust + Zenoh adapter for the Neuro-Cybernetic Protocol
(NCP). Project-specific pose/velocity/channel mapping stays here; the canonical
wire types and key construction come from pinned `ncp-core` and `ncp-zenoh`
dependencies in [`src-tauri/Cargo.toml`](../../Cargo.toml).

This action/control adapter is **dormant in the product runtime**:

- the `ncp` Cargo feature is off by default;
- `NcpHandle` is not managed by the Tauri builder;
- `ncp_connect`, `ncp_open_feature_neuron`, `ncp_step_feature_neuron`, and
  `ncp_close` are not registered in `generate_handler!`; and
- no frontend hook runs a perception/action loop.

Compiling this module does not make CREBAIN an always-on Engram body.
The same Cargo feature also compiles sibling Galadriel registry, envelope, and
producer modules. Those are not this action adapter: the application may manage
the evidence producer after its separate exact runtime opt-in and deployment-pin
preflight while all four `ncp_*` commands here remain unregistered.

## Build and test

The SDK is pinned to tag `v0.8.0` in both Cargo and npm manifests. A sibling
checkout is not required, but the pinned Git dependency must be resolvable when
Cargo resolves/builds the feature.

```bash
bun run check:rust:ncp
bun run clippy:rust:ncp
bun run test:rust:ncp
```

Keep `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `package.json`, and `bun.lock`
on one compatible NCP release. Do not copy a wire version from an external
example: Engram examples/profiles describing an older incompatible contract or
`std_msgs` conventions must be updated in their owning repository before use
as deployment evidence.

## Available library surface

- `sensor_frame_from_pose`: pose + body velocity to NCP `SensorFrame`.
  It returns `Result` and rejects a wire-invalid sequence.
- `velocity_from_command`: strict one-frame conversion to
  `VelocitySetpointProposal`; only a valid active `velocity_setpoint` in `m/s`
  can produce a nonzero local proposal, while HOLD/ESTOP produce zero velocity.
- `CommandPlant`: wraps the SDK `ActionBuffer`, validates active commands, replays
  a bounded predictive horizon, enforces monotonic sequence and TTL, and returns
  zero velocity after expiry/drain/invalid state.
- `NcpBridge`: bounded Zenoh connect/control RPC, sensor publish, and action
  subscription helpers.
- `open_feature_neuron` / `step_feature_neuron` / `close`: the current
  single-population perception example.

`subscribe_commands` now owns a 50 Hz local action loop. Wire-valid commands pass
through `CommandPlant`; a recognizable raw ESTOP is reduced to a minimal command
and latched before the receive-time/wire gate. Other invalid/incompatible frames
are logged and dropped. Every action loop owns a dedicated subscriber container;
stop, close, setup cancellation, and runtime drop release that container without
closing the shared Zenoh session. Reconnect drains the previous runtime's action
loops before replacement. Close requests a final zero-velocity local HOLD
proposal before the remote RPC. A nonblocking, nonpanicking proposal callback is
required; callback failure/timeout is surfaced because final local notification
cannot then be guaranteed. The callback has no transport or actuator capability.

## Connection posture

`NcpBridge::connect` and the dormant `ncp_connect` command default to `Secure`.
That path requires `NCP_ZENOH_CONFIG` to name a readable Zenoh configuration;
missing or malformed configuration fails closed. `QuietDevelopment` is an
explicit unauthenticated/scouting-off development choice and must not be used as
deployment evidence.

Successfully loading a configuration proves only startup posture. CREBAIN cannot
prove that its TLS identities, ACL rules, router topology, or certificate policy
are sufficient; those remain target-deployment evidence.

The sibling Galadriel producer has no `QuietDevelopment` option: enabled startup
always requests secure mode. That remains a configuration request, not evidence
that the supplied file actually establishes TLS/mTLS, an ACL, or a binding
between its authenticated principal and the envelope's declared `producer_id`.

## Input and reply boundaries

- realm, session ID, and model name are limited to 128 bytes and safe key/name
  characters;
- `drive_pa` is finite and within ±1,000,000 pA;
- `advance_ms` is finite and within `(0, 10,000]`;
- active velocity norm is at most 100 m/s;
- command TTL is finite and within `(0, 60,000]` ms;
- horizon length is at most 1,000, requires a positive finite interval, and may
  not extend beyond TTL;
- inbound command JSON is capped at 256 KiB, and accepted commands retain only
  the required bounded velocity channel/horizon in the action buffer;
- Zenoh connect and each control RPC time out after 15 seconds;
- each action subscription setup times out after 15 seconds and close prevents a
  new loop until an explicit successful reopen;
- at most 64 action loops/reservations and 256 closed-session tombstones are
  retained; tombstone saturation rejects all new opens/actions until reconnect;
- action-loop stop waits at most 1 second before aborting the task;
- RPC replies must be valid NCP, have the expected `kind`, include required
  explicit boolean result fields (`ok` is never inferred from an SDK default),
  report success, and return the requested session ID; and
- feature-neuron observations must provide the expected `spk` port/target,
  `spikes` observable, and finite spike times.

The wire/version/scientific-boundary validation is delegated to the pinned SDK;
contract-hash advisory output is logged. Do not weaken version errors into a
successful response.

## Deliberate product integration

Exposing the four Tauri control commands requires managing `NcpHandle`, adding
the commands to `generate_handler!`, updating the frontend command registry and
contract tests, and adding an explicit opt-in UI/hook. Closed-loop action would
also require a separately reviewed narrow plant adapter, exclusive authority,
fresh-state and expiry gates, and FCU evidence. The current callback only emits
a `VelocitySetpointProposal`; registration alone is not a plant or actuator loop.

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
