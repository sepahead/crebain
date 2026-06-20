# `src/ncp` — Engram neuro-cybernetic (NCP), Rust client

CREBAIN's **native Rust + Zenoh** client for the Neuro-Cybernetic Protocol (NCP) —
the high-performance peer to the TypeScript WebSocket client in
[`../../../src/neuro/`](../../../src/neuro). It lets CREBAIN ask **Engram**
(Paper2Brain) for a neural simulation and/or be steered as a controller, for
**perception, action, both, or neither**, over the recommended decoupled Zenoh
bus.

It uses the canonical NCP SDK (`ncp-core` + `ncp-zenoh`) from the published
**[`sepahead/NCP`](https://github.com/sepahead/NCP)** repo, so the wire is
identical across the Rust, Python and TS peers. Spec:
`NEURO_CYBERNETIC_PROTOCOL.md` in that repo.

## Opt-in (feature-gated)

This module is behind the **`ncp` Cargo feature** (off by default) so the default
CREBAIN build and the command-contract test are unchanged:

```bash
cargo check  --features ncp --manifest-path src-tauri/Cargo.toml
cargo test   --features ncp --lib ncp --manifest-path src-tauri/Cargo.toml
```

It depends on the published NCP SDK via a git + tag dependency (tag `v0.3.0`)
on https://github.com/sepahead/NCP, declared in `src-tauri/Cargo.toml`; no
sibling checkout is required.

## What it provides

- **Project mapping (CREBAIN-specific, stays here):** `sensor_frame_from_pose`
  (pose + body velocity → NCP `SensorFrame`), `velocity_from_command` (NCP
  `CommandFrame` → `TwistStampedData` for `/mavros/<ns>/setpoint_velocity/cmd_vel`,
  failing safe to zero on `hold`/`estop`), and `observation_scalar` (a population
  observation → a scalar feature).
- **`NcpBridge`** — a Zenoh-backed client: `connect`, `open_feature_neuron` /
  `step_feature_neuron` / `close` (perception/sim service via control-plane RPC),
  `publish_sensor` (perception plane), `subscribe_commands` (action plane → MAVROS).
- **Tauri commands** (`ncp_connect`, `ncp_open_feature_neuron`,
  `ncp_step_feature_neuron`, `ncp_close`) — ready to register.

## Exposing it to the frontend (one deliberate step)

The commands compile but are **not** registered by default (so the
`generate_handler!` command-contract test stays green). To turn them on, in
`src-tauri/src/lib.rs::run()`:

```rust
// after `tauri::Builder::default()`:
#[cfg(feature = "ncp")] let builder = builder.manage(crate::ncp::NcpHandle::default());
// and add to the generate_handler![] list:
//   ncp_connect, ncp_open_feature_neuron, ncp_step_feature_neuron, ncp_close,
```

then add the matching entries to the frontend command registry. Until then, the
TS WebSocket client (`src/neuro`) remains the shipped path.

## Compatibility & versioning

Pinned to NCP **`v0.3.0`** (`src-tauri/Cargo.toml`, behind the `ncp` feature).
NCP's `#10` neuron-family extension (`RecordTarget.recordables`, the
`binary_state` / `rate_inject` enum values, `StimulusTarget.params`) is purely
**additive** to the wire and shipped in the `v0.2.x` line, so this client already
consumes it: an `observable:"binary_state"` observation deserializes (the enums
gained the value, not a `serde(other)` fallback). **To adopt a newer NCP wire:**
bump the `ncp-core`/`ncp-zenoh` tag in `src-tauri/Cargo.toml` (the send path —
`Observable::Spikes` / `StimulusKind::CurrentPa` — is unaffected by additive
changes). The TypeScript client (`@sepehrmn/ncp`, `package.json`) pins the same
release (`#v0.3.0`); run `bun install` to refresh a stale snapshot. **Keep the
typed enums** — NCP's architecture review confirmed they are abstract SNN concepts
(compile-checked), *not* to be flattened to strings.

## Simulator-agnostic by design

CREBAIN talks to the **abstract NCP wire**, not to NEST. The typed vocabulary
(`V_m`/`spikes`/`current_pA`/…) are simulator-neutral SNN concepts the Engram
backend maps to NEST; backend-specific names live in the generic
`recordables`/`params` escape hatches. If Engram ever runs a different simulator
(NEURON / Brian2 / GeNN) behind the same wire, CREBAIN needs **no change** — it
speaks the contract, not the simulator. (NEST is NCP's only implemented backend
today; others are a documented future direction in the NCP repo.)

## Boundary

Returned `V_m`/spikes are raw simulation outputs (`calibrated_posterior=false`,
`is_simulation_output=true`), never a validated reproduction; a neuro-controller
is a control artifact, not a scientific claim. Engram holds no CREBAIN-specific
topic knowledge — the mapping lives here, in CREBAIN.
