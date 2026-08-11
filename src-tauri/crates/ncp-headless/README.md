# CREBAIN headless NCP perception runner

<!-- ncp-pin: v0.8.0 -->

`crebain-ncp-headless` is a dependency-isolated, opt-in workspace package. Its
default feature set is empty. Cargo feature `ncp` enables its binary and pinned
NCP wire-0.8 dependencies.

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

## Scope

The process runs one perception-only lifecycle. It opens a feature-neuron
session, performs 1–4,096 steps, and closes the session. Each handled path after
a confirmed open makes one bounded close attempt while the process runs.

The package has no dependency on Tauri, inference runtimes, image libraries, or
the plant-authority package. It has no command subscription, sensor put, action
callback, Tauri registration, or plant-authority path.

## Commands

Validate the isolated package with these locked command aliases:

```bash
bun run check:ncp-headless-boundary
bun run check:ncp-headless
bun run clippy:ncp-headless
bun run test:ncp-headless
bun run self-check:ncp-headless
```

The self-check alias runs this explicit process command:

```bash
cargo run --locked --manifest-path src-tauri/Cargo.toml \
  -p crebain-ncp-headless --features ncp \
  --bin crebain-ncp-headless -- self-check
```

The CLI requires an explicit subcommand:

| Command | Behavior |
|---|---|
| `self-check` | Reads no runner configuration and opens no Zenoh session |
| `validate --session-id <id>` | Validates bounded arguments and the strict client posture in `NCP_ZENOH_CONFIG`; opens no Zenoh session |
| `run --session-id <id>` | Accepts only the strict secure-client configuration posture and runs the bounded lifecycle against a compatible NCP wire-0.8 responder |

The CLI applies these limits before it opens a transport:

| Input | Default and limit |
|---|---|
| Realm | `engram/ncp`; safe NCP key segments; at most 128 bytes |
| Session ID | Required safe NCP key segment; at most 64 bytes |
| Model | `iaf_psc_alpha`; safe model name; at most 128 bytes |
| Drive | 500 pA; finite; from -1,000,000 through 1,000,000 pA |
| Advance | 10 ms; finite; greater than 0 and at most 10,000 ms |
| Steps | 1; from 1 through 4,096 |
| Operation timeout | 15,000 ms; from 10 through 15,000 ms |
| Lifecycle timeout | 60,000 ms; at least four operation-timeout budgets and at most 300,000 ms |
| `NCP_ZENOH_CONFIG` | Required for `validate` and `run`; strict client configuration in a regular file; at most 1 MiB |

`validate` and `run` each read the configuration once through one open file
handle. Each command validates its exact bounded snapshot. `run` passes that
parsed object to Zenoh. The gate requires client mode and disabled scouting. It
also requires only `tls/` connections, no listeners, certificate paths, and
peer-name verification. These checks do not attest Transport Layer Security
(TLS), an access control list (ACL), peer identity, or the deployment topology.

Each lifecycle query accepts exactly one reply. The client rejects a second
reply and rejects a payload larger than 1 MiB before payload materialization.
A successful open must contain a canonical server-issued session generation.
Step and close requests echo that exact generation. Observation and close
replies must return it. The shared client retains at most 256 session states.
It fails closed after an ambiguous open, step, or close outcome. An ambiguous
step permits only the bounded cleanup close.

## Compatibility and evidence boundary

The `engram/ncp` realm is only a routing default. It does not establish responder
compatibility. Current Engram/Paper2Brain native wire 1.0 is incompatible with
CREBAIN's wire 0.8 pin. No translator or live CREBAIN↔current-Engram loop exists.

An RPC reply shows that some responder replied. It does not identify that
responder as the intended deployment receiver. It does not prove an end-to-end
effect, TLS identity, access-control-list policy, deployment compatibility, or
scientific validity.
See [`../../../docs/NCP_BRIDGE_HANDOFF.md`](../../../docs/NCP_BRIDGE_HANDOFF.md)
for the repository-wide NCP boundary.
