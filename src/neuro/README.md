# `src/neuro` — dormant TypeScript NCP glue

This directory re-exports the pinned `@sepahead/ncp` package and adds
`guardReplyVersion`, CREBAIN's transport wrapper for compatible reply versions
and NCP scientific-boundary fields.

It is **not imported by any product component or hook today**. No WebSocket is
opened, no session is created, and no always-on CREBAIN↔Engram loop ships from
this directory. The example below is integration guidance, not current product
behavior or performance evidence.

## Single source of truth

NCP wire types, enums, `NeuroSimClient`, and `WebSocketNeuroSim` are owned by
[`sepahead/NCP`](https://github.com/sepahead/NCP). CREBAIN consumes the
`@sepahead/ncp` Git tag pinned in `package.json`; Rust pins `ncp-core` and
`ncp-zenoh` to the same tag in `src-tauri/Cargo.toml`.

Keep `package.json`, `bun.lock`, `src-tauri/Cargo.toml`, and
`src-tauri/Cargo.lock` coherent when upgrading. Do not use stale external Engram
wire-0.5 examples as the version source; the current CREBAIN pin is `v0.6.0`.

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

The default guard mode throws when an object success reply lacks a compatible
`ncp_version` or violates carried scientific-boundary fields. NCP error frames
remain for the SDK's own unwrap/error path. A `'warn'` mode exists for controlled
migrations but passes the suspect reply through and must not be used for
actuation or release evidence.

## Transport choices are integration work

- `WebSocketNeuroSim` can target Engram's WebSocket endpoint once a product
  integration explicitly constructs it.
- A TypeScript Zenoh `Send` adapter is not implemented here. CREBAIN's robotics
  `ZenohBridge` cannot be assumed to implement NCP query/reply merely because both
  use Zenoh.
- The native Rust NCP module provides a separate feature-gated Zenoh adapter; its
  Tauri commands also remain unregistered. See
  [`src-tauri/src/ncp/README.md`](../../src-tauri/src/ncp/README.md).

For action, a deliberate integration must connect a validated native
`CommandPlant` output to the intended actuator publisher. The TS re-export alone
does not map command frames to MAVROS.

## Scientific boundary

Returned membrane potential/spikes are raw simulation outputs
(`calibrated_posterior=false`, `is_simulation_output=true`), not a validated
reproduction. A neuro-controller is a control artifact, not a scientific or
safety claim.
