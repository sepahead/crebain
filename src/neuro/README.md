# `src/neuro` — dormant TypeScript NCP glue

<!-- ncp-pin: v0.8.0 -->

This directory re-exports the pinned `@sepahead/ncp` package and adds
`guardReplyVersion`, CREBAIN's strict transport wrapper for compatible reply
versions, success kind/session attribution, explicit success status, typed-error
request/session attribution, and NCP scientific-boundary fields.

It is **not imported by any product component or hook today**. No WebSocket is
opened, no session is created, and no always-on CREBAIN↔Engram loop ships from
this directory. The example below is integration guidance, not current product
behavior or performance evidence. A separately gated native Galadriel evidence
producer does not import or activate this TypeScript glue and is not an Engram
action/control loop.

## Single source of truth

NCP wire types, enums, `NeuroSimClient`, and `WebSocketNeuroSim` are owned by
[`sepahead/NCP`](https://github.com/sepahead/NCP). CREBAIN consumes the
`@sepahead/ncp` Git tag pinned in `package.json`; Rust pins `ncp-core` and
`ncp-zenoh` to the same tag in `src-tauri/Cargo.toml`.

Keep `package.json`, `bun.lock`, `src-tauri/Cargo.toml`, and
`src-tauri/Cargo.lock` coherent when upgrading. Do not use incompatible older
external Engram examples as the version source; the current CREBAIN pin is `v0.8.0`.

## Guarded example

```ts
import {
  NeuroSimClient,
  WebSocketNeuroSim,
  guardReplyVersion,
  type ObservationFrameReply,
} from './neuro'

const transport = new WebSocketNeuroSim('ws://127.0.0.1:28471/api/neurocontrol/ws')
const engram = new NeuroSimClient(guardReplyVersion(transport.send))

await engram.open(
  'uav3-percept',
  { kind: 'builtin', ref: 'iaf_psc_alpha', population_sizes: { feat: 1 } },
  [{ port: 'spk', target: 'feat', observable: 'spikes' }],
  [{ port: 'drive', target: 'feat', kind: 'current_pA' }]
)
const obs: ObservationFrameReply = await engram.step(
  'uav3-percept',
  { drive: { data: [500], unit: 'pA' } },
  50
)
const spikeCount = obs.records.spk.times.length
await engram.close('uav3-percept')
```

The guard always throws when a success reply lacks a compatible `ncp_version`,
the expected kind/session, an explicit successful boolean `ok` where applicable,
or valid carried scientific-boundary fields. Wire-0.8 typed errors are versioned;
their optional `request_kind` and `session_id` must match the originating request
when present, and the SDK then surfaces the denial. There is no permissive or
warning-only mode.

## Transport choices are integration work

- `WebSocketNeuroSim` can target Engram's WebSocket endpoint once a product
  integration explicitly constructs it.
- A TypeScript Zenoh `Send` adapter is not implemented here. CREBAIN's robotics
  `ZenohBridge` cannot be assumed to implement NCP query/reply merely because both
  use Zenoh.
- The native Rust NCP module provides a separate feature-gated Zenoh adapter; its
  action/control Tauri commands also remain unregistered. The same Cargo feature
  contains an independently gated two-route Galadriel evidence producer. See
  [`src-tauri/src/ncp/README.md`](../../src-tauri/src/ncp/README.md).
- Vite development builds separately expose `window.__ncpDrone`, a manual
  in-browser injection harness for wire-shaped command frames. It opens no NCP
  transport or session and is absent from production builds.

For action, a deliberate integration must add a separately reviewed narrow
native plant adapter for the validated `CommandPlant` proposal. The current
callback and TS re-export have no actuator publisher and do not map command
frames to MAVROS.

## Scientific boundary

Returned membrane potential/spikes are raw simulation outputs
(`calibrated_posterior=false`, `is_simulation_output=true`), not a validated
reproduction. A neuro-controller is a control artifact, not a scientific or
safety claim.
