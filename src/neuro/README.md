# `src/neuro` — Engram neuro-cybernetic (NCP) integration

Lets CREBAIN ask **Engram** (Paper2Brain) for a neural simulation and read back
membrane potential / spikes / population rate — for **perception, action, both,
or neither** (the rest stays classic ML in CREBAIN).

## Single source of truth — no replication here

The NCP wire (message types, enums, `NeuroSimClient`, the WebSocket transport) is
**owned by the canonical repo** [`sepahead/NCP`](https://github.com/sepahead/NCP)
and consumed here as the **`@sepehrmn/ncp`** package — a git dependency pinned by
tag in `package.json`, symmetric with how the Rust crates (`ncp-core` /
`ncp-zenoh`) are pinned in `src-tauri/Cargo.toml`. CREBAIN re-declares none of it.
**If the protocol has to change, it changes there via a pull request** and we bump
the pin. `index.ts` just re-exports the package as CREBAIN's local integration
point; this is also where any CREBAIN-specific TS glue would go.

## Use

```ts
import { NeuroSimClient, WebSocketNeuroSim } from './neuro'
import type { ObservationFrameReply } from './neuro'

const transport = new WebSocketNeuroSim('ws://127.0.0.1:28471/api/neurocontrol/ws')
const engram = new NeuroSimClient(transport.send)

// e.g. a per-UAV "feature neuron": drive it from a detection score, read its spikes
await engram.open(
  'uav3-percept',
  { kind: 'builtin', ref: 'iaf_psc_alpha', population_sizes: { feat: 1 } },
  [{ port: 'spk', target: 'feat', observable: 'spikes' }],
  [{ port: 'drive', target: 'feat', kind: 'current_pA' }],
)
const obs: ObservationFrameReply = await engram.step(
  'uav3-percept',
  { drive: { data: [500.0], unit: 'pA' } },
  50.0,
)
const spikeCount = obs.records.spk.times.length // feed into CREBAIN's logic
await engram.close('uav3-percept')
```

## Reply version guard (the one bit of CREBAIN glue)

The canonical `NeuroSimClient` stamps `ncp_version` on every *request* but does not
validate the version a peer returns on a *reply* (its `unwrap` only rejects
`error` frames). `index.ts` therefore re-exports a thin, transport-agnostic guard —
the only thing CREBAIN adds over the package — that refuses a reply whose
`ncp_version` is absent or differs from the version this build speaks (`NCP_VERSION`,
"0.5"). It changes no wire bytes (NCP stays pinned at v0.5.0); it just stops a peer
that has drifted off the protocol from masquerading as a success:

```ts
import { NeuroSimClient, WebSocketNeuroSim, guardReplyVersion } from './neuro'

const transport = new WebSocketNeuroSim()
// Wrap the transport `send`: every reply is checked against NCP_VERSION first.
const engram = new NeuroSimClient(guardReplyVersion(transport.send))
// `guardReplyVersion(send, 'warn')` logs instead of throwing (peer mid-migration).
```

## Transports (your choice; both non-invasive)

- **WebSocket** (`WebSocketNeuroSim` from `@sepehrmn/ncp`) — point at Engram's
  `/api/neurocontrol/ws`. Simplest; works from the Tauri webview.
- **Zenoh** — for a fully **decoupled** bus, implement the package's `Send` over
  CREBAIN's `ZenohBridge` (query `engram/ncp/rpc`; subscribe to
  `engram/ncp/session/{id}/observation`).
- **Native Rust + Zenoh** (recommended for performance) — the Rust NCP client at
  `src-tauri/src/ncp/` (behind the `ncp` Cargo feature), built on the canonical
  `ncp-core` + `ncp-zenoh` crates. Maps pose/velocity ↔ NCP frames in Rust. This TS
  path is the zero-extra-dependency browser/Tauri-webview path; the Rust client is
  the high-performance path. See `src-tauri/src/ncp/README.md`.

## Action (Engram as the brain)

For closed-loop control, Engram emits NCP `command_frame`s and **CREBAIN maps them
to its actuators** (e.g. publish a decoded `velocity_setpoint` to
`/mavros/<ns>/setpoint_velocity/cmd_vel` via the existing ROSBridge). Engram holds
no CREBAIN-specific topic knowledge — that mapping lives in CREBAIN (in the Rust
client today).

## Boundary

Returned `V_m`/spikes are **raw simulation outputs of a specified model**
(`calibrated_posterior=false`, `is_simulation_output=true`), never a validated
reproduction; a neuro-controller is a control artifact, not a scientific claim.
