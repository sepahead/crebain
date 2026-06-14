# `src/neuro` — Engram neuro-control (NCP) client

Lets CREBAIN ask **Engram** (Paper2Brain) for a neural simulation and read back
membrane potential / spikes / population rate — for **perception, action, both,
or neither** (the rest stays classic ML in CREBAIN). Self-contained and
**non-invasive**: this directory adds no dependencies and touches no existing
CREBAIN code. Protocol spec + JSON Schemas live in the Paper2Brain repo
(`NEURO_CONTROL_PROTOCOL.md`, `backend/neurocontrol/`).

## Use

```ts
import { NeuroSimClient, WebSocketNeuroSim } from './neuro'

const transport = new WebSocketNeuroSim('ws://127.0.0.1:28471/api/neurocontrol/ws')
const engram = new NeuroSimClient(transport.send)

// e.g. a per-UAV "feature neuron": drive it from a detection score, read its spikes
await engram.open(
  'uav3-percept',
  { kind: 'builtin', ref: 'iaf_psc_alpha', population_sizes: { feat: 1 } },
  [{ port: 'spk', target: 'feat', observable: 'spikes' }],
  [{ port: 'drive', target: 'feat', kind: 'current_pA' }],
)
const obs = await engram.step('uav3-percept', { drive: { data: [500.0], unit: 'pA' } }, 50.0)
const spikeCount = obs.records.spk.times.length // feed into CREBAIN's logic
await engram.close('uav3-percept')
```

## Wiring (your choice; both are non-invasive)

- **WebSocket** (`ws.ts`) — point at Engram's `/api/neurocontrol/ws`. Simplest;
  works from the Tauri webview.
- **Zenoh** — for a fully **decoupled** bus, implement `Send` over CREBAIN's
  existing `ZenohBridge` (query the `engram/ncp/rpc` key; subscribe to
  `engram/ncp/session/{id}/observation`). Engram recommends Zenoh as the default
  decoupled transport precisely to avoid binding CREBAIN to a server address.

## Action (Engram as the brain)

For closed-loop control, Engram emits NCP `command_frame`s and **CREBAIN maps them
to its actuators** (e.g. publish a decoded `velocity_setpoint` to
`/mavros/<ns>/setpoint_velocity/cmd_vel` via the existing ROSBridge). Engram holds
no CREBAIN-specific topic knowledge — the mapping lives here, in CREBAIN.

## Boundary

Returned `V_m`/spikes are **raw simulation outputs of a specified model**
(`calibrated_posterior=false`, `is_simulation_output=true`), never a validated
reproduction; a neuro-controller is a control artifact, not a scientific claim.
