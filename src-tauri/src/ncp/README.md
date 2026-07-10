# `src-tauri/src/ncp` — optional native NCP adapter

This module is CREBAIN's Rust + Zenoh adapter for the Neuro-Cybernetic Protocol
(NCP). Project-specific pose/velocity/channel mapping stays here; the canonical
wire types and key construction come from pinned `ncp-core` and `ncp-zenoh`
dependencies in [`src-tauri/Cargo.toml`](../../Cargo.toml).

It is **dormant in the product runtime**:

- the `ncp` Cargo feature is off by default;
- `NcpHandle` is not managed by the Tauri builder;
- `ncp_connect`, `ncp_open_feature_neuron`, `ncp_step_feature_neuron`, and
  `ncp_close` are not registered in `generate_handler!`; and
- no frontend hook runs a perception/action loop.

Compiling this module does not make CREBAIN an always-on Engram body.

## Build and test

The SDK is pinned to tag `v0.6.0` in both Cargo and npm manifests. A sibling
checkout is not required, but the pinned Git dependency must be resolvable when
Cargo resolves/builds the feature.

```bash
bun run check:rust:ncp
bun run clippy:rust:ncp
bun run test:rust:ncp
```

Keep `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `package.json`, and `bun.lock`
on one compatible NCP release. Do not copy a wire version from an external
example: some Engram examples/profiles still describe older wire `0.5` or
`std_msgs` conventions and must be updated in their owning repository before use
as deployment evidence.

## Available library surface

- `sensor_frame_from_pose`: pose + body velocity to NCP `SensorFrame`.
- `velocity_from_command`: strict one-frame conversion to
  `TwistStampedData`; only a valid active `velocity_setpoint` in `m/s` can
  actuate, while HOLD/ESTOP produce zero velocity.
- `CommandPlant`: wraps the SDK `ActionBuffer`, validates active commands, replays
  a bounded predictive horizon, enforces monotonic sequence and TTL, and returns
  zero velocity after expiry/drain/invalid state.
- `NcpBridge`: bounded Zenoh connect/control RPC, sensor publish, and action
  subscription helpers.
- `open_feature_neuron` / `step_feature_neuron` / `close`: the current
  single-population perception example.

`subscribe_commands` now owns a 50 Hz local action loop. Wire-valid commands pass
through `CommandPlant`; invalid/incompatible frames are logged and dropped. Close
stops local actuation first and emits a final zero-velocity HOLD even when the
remote close RPC later fails. The output callback must be non-blocking. This is
library behavior only until a deliberate integration calls it.

## Input and reply boundaries

- realm, session ID, and model name are limited to 128 bytes and safe key/name
  characters;
- `drive_pa` is finite and within ±1,000,000 pA;
- `advance_ms` is finite and within `(0, 10,000]`;
- active velocity norm is at most 100 m/s;
- command TTL is finite and within `(0, 60,000]` ms;
- horizon length is at most 1,000, requires a positive finite interval, and may
  not extend beyond TTL;
- Zenoh connect and each control RPC time out after 15 seconds;
- action-loop stop waits at most 1 second before aborting the task;
- RPC replies must be valid NCP, have the expected `kind`, include required
  boolean result fields, and return the requested session ID; and
- feature-neuron observations must provide the expected `spk` port/target,
  `spikes` observable, and finite spike times.

The wire/version/scientific-boundary validation is delegated to the pinned SDK;
contract-hash advisory output is logged. Do not weaken version errors into a
successful response.

## Deliberate product integration

Exposing the four Tauri control commands requires managing `NcpHandle`, adding
the commands to `generate_handler!`, updating the frontend command registry and
contract tests, and adding an explicit opt-in UI/hook. Closed-loop action also
requires a separate caller to subscribe to commands and publish the callback's
validated `TwistStampedData` to the intended actuator path. Registration alone is
not that loop.

Before a live deployment claim, also prove the target NCP realm/key ACL allows
the CREBAIN participant. Repository unit tests do not validate an external
Engram/Galadriel ACL or network topology.

## Scientific boundary

Returned membrane potential/spikes are raw simulation outputs
(`calibrated_posterior=false`, `is_simulation_output=true`), not a validated
biological reproduction. A neuro-controller is a control artifact, not a
scientific or safety claim.
