# crebain ↔ NCP Bridge — Developer Handoff Prompt

> Copy-pasteable brief for a developer (or coding agent) bringing crebain's NCP
> bridge up to standard: a thin, non-invasive bridge onto the **standalone NCP
> SDK**, so crebain stays buildable and CI-green with *zero* NCP/Engram checkout
> on disk. Self-contained; read top to bottom before touching code. The
> protocol-level decisions (rename, hardening, commander model) live in the
> companion **Paper2Brain `NCP_EXTRACTION_AND_EVOLUTION_HANDOFF.md`** — this prompt
> only touches crebain.

## 1. Context (what this is and is not)

crebain is a Tauri (Rust) + React/TS counter-UAV surveillance/interception
prototype. Its **detection → sensor-fusion → interception** pipeline is fully
**standalone** and must stay that way: it depends on Engram/NCP for *no* core
result.

NCP — the **Neuro-Cybernetic Protocol** (renamed from "Neuro-Control"; cybernetics
= control *and* communication, i.e. the perception+action loop; see the Paper2Brain
handoff) and extracted into its own repo (`github.com/sepahead/NCP`) — is an
**optional, off-by-default bridge** that
lets crebain be one of the "bodies" an Engram/NEST brain coordinates: crebain
publishes pose/velocity on the **perception plane** and applies brain-issued
setpoints on the **action plane**. Two peers, one wire:

| Peer | Path | Role |
|---|---|---|
| **Rust** | `src-tauri/src/ncp/mod.rs` | Native Zenoh client: `NcpBridge`, `CommandPlant`, `sensor_frame_from_pose`, `velocity_from_command`, `observation_scalar`. Behind the off-by-default `ncp` Cargo feature. |
| **TypeScript** | `src/neuro/` (`ncp.ts`, `ws.ts`, `index.ts`) | Transport-agnostic NCP client (`NeuroSimClient`) + a WebSocket transport. Self-contained; imported by nothing in the app today. |

It is **not** on crebain's critical path. The default build, the frontend tests
(206), the Rust tests (150), and the running app all work with no NCP / Engram /
sibling SDK present. **Your job is to keep that true** while making the bridge
depend cleanly on the *extracted, standalone* NCP repo instead of the
`Paper2Brain/ncp` sibling path.

## 2. The bar to clear ("done")

1. A fresh `git clone` of crebain — **with no `Paper2Brain` / NCP tree on disk** —
   passes the full gate `bun run validate:all` (tsc, eslint, prettier, frontend
   tests, `cargo fmt --check`, `cargo check`, `cargo test`, `clippy -D warnings`),
   exit 0.
2. CI (`.github/workflows/ci.yml`) Rust jobs — `bun run check:rust` (line 122),
   `clippy:rust` (127), `test:rust` (132) — pass on a clean runner that never
   clones the sibling.
3. With the standalone NCP dependency resolvable, `cargo check --features ncp
   --manifest-path src-tauri/Cargo.toml` builds and `cargo test --features ncp
   --lib ncp` passes — against the **external** `ncp-core`/`ncp-zenoh`, not a path
   sibling.
4. Runtime standalone preserved: the `generate_handler!` list and the
   `backend_invoke_handler_lists_frontend_command_contract` test are **unchanged**;
   the app runs identically with NCP absent.

## 3. Current state

Already correct — **do not regress**:

- **Off-by-default & non-invasive.** `ncp` Cargo feature is off (`default =
  ["zenoh-transport"]`); the NCP Tauri commands (`ncp_connect`,
  `ncp_open_feature_neuron`, `ncp_step_feature_neuron`, `ncp_close`) are
  deliberately **not** registered in `lib.rs::run()`; `src/neuro` is imported by no
  component/hook; there is no NCP env config.
- **Action plane fails safe.** `velocity_from_command` returns zero velocity on
  `hold`/`estop`; `CommandPlant` replays a predictive horizon through dropouts and
  **HOLDs (zero velocity)** once `ttl_ms` expires — turning NCP's `ttl_ms` into a
  real deadline backstop. Covered by tests in `src-tauri/src/ncp/mod.rs`.
- **V↔command echo.** `sensor_frame_from_pose` stamps a `seq`; `CommandFrame`s echo
  it, so an action is paired with the sensor frame that produced it.
- **NCP WS-client liveness.** `src/neuro/ws.ts` settles every pending request on
  socket close/error and guards `JSON.parse` (fixed — no hung promises).

## 4. Workstreams (the gaps, in priority order)

### Gap 1 — the bridge breaks crebain's standalone build (DONE; was the live regression)

> **DONE:** the cut-over below has shipped. `src-tauri/Cargo.toml` now declares the
> NCP SDK as optional **git + tag** deps (`tag = "v0.3.0"`, fix (a) below); the
> sibling path deps are gone and a fresh clone builds with no `Paper2Brain`/NCP
> tree on disk. The historical analysis is kept for context.

`src-tauri/Cargo.toml` declared the NCP SDK as **optional path deps** to the sibling:

```toml
ncp-core  = { path = "../../Paper2Brain/ncp/ncp-core",  optional = true }
ncp-zenoh = { path = "../../Paper2Brain/ncp/ncp-zenoh", optional = true }
```

Cargo resolves **every** path dependency during resolution — even optional,
inactive ones — so a checkout without the sibling fails the **default** (ncp-off)
build (verified empirically):

```
error: failed to get `ncp-core` as a dependency of package `crebain`
  ... failed to read `.../ncp-core/Cargo.toml`: No such file or directory
```

CI never clones Paper2Brain, so its Rust jobs cannot pass on a clean runner, and a
plain `git clone` of crebain alone cannot `cargo check`. This violates the
standalone principle at **build/CI** time (runtime is fine).

- **Fix (choose one; (a) is the smaller change, (b) is the most decoupled):**
  - **(a) Git dependency on the extracted repo, optional and pinned:**
    ```toml
    ncp-core  = { git = "https://github.com/sepahead/NCP", tag = "v0.3.0", optional = true }
    ncp-zenoh = { git = "https://github.com/sepahead/NCP", tag = "v0.3.0", optional = true }
    ```
    The default build then resolves NCP's manifest from the pinned rev (CI has
    network); fresh clones build. Commit the resulting `Cargo.lock`. Trade-off: the
    default build clones NCP metadata over the network.
  - **(b) Excluded bridge crate (mirror pid_vla, truest standalone):** move the
    Rust bridge into its own crate `src-tauri/ncp-bridge/` and exclude it from the
    default workspace (`[workspace] exclude = ["ncp-bridge"]`), built explicitly
    only when the SDK is present. Then drop the `#[cfg(feature="ncp")] pub mod
    ncp;` from `lib.rs`, and add `cfg(feature, values("ncp"))` to the manifest's
    `[lints.rust] unexpected_cfgs` `check-cfg` allow-list so `clippy -D warnings`
    stays clean. The default dependency graph then references **nothing** external.
- **Acceptance:** §2 gates 1 and 2 pass with no sibling on disk; gate 3 passes when
  the SDK is available.

### Gap 2 — track the NCP rename + pin a version (MEDIUM)

The standard is renamed **NCP = "Neuro-Cybernetic Protocol"** (cybernetics = "the
study of control and communication in the animal and the machine" — the
perception+action feedback loop). The `NCP` initialism and the `ncp_version` wire
constant are stable, so the change is prose-only, and the crebain bridge's prose is
**already updated**. Remaining:

- Pin a **specific** NCP release (tag/version), and keep `ncp_version`
  compatibility strict: **reject on mismatch, never coerce** (lesson from MCP's
  weak versioning — see Paper2Brain handoff §B).
- **Acceptance:** no stale "Neuro-Control Protocol" prose remains; the bridge pins
  one NCP release; the TS `NCP_VERSION` and Rust `ncp_version` agree with the SDK.

### Gap 3 — (optional) make the bridge live (LOW; only if crebain should actually act as a body)

Today the bridge is inert by design. If/when crebain should be a live body under
the Engram commander: register the four `ncp_*` commands in `lib.rs::run()` (plus
the matching frontend registry entry and the command-contract test), and add a
hook that opens a session and runs the perception→action loop (publish
`SensorFrame`, drive MAVROS from `CommandPlant::velocity_at`). Keep it behind an
explicit user opt-in.
- **Acceptance:** enabling NCP is a deliberate, documented opt-in; the default
  command surface and default build are unchanged.

## 5. Hard constraints (do not violate)

1. **crebain stays standalone.** No core result may depend on Engram/NCP; the
   default build and CI must **never** require the SDK on disk.
2. **crebain is a body, not a commander.** It only *publishes perception* and
   *applies action*; it never commands Engram or another project. There is exactly
   one control plane — the Engram commander.
3. **Project-specific mapping stays here.** The pose/velocity ↔ NCP channel mapping
   lives in `src-tauri/src/ncp` / `src/neuro`, never in the NCP SDK.
4. **Action plane fails safe.** Preserve `hold`/`estop` → zero and `ttl_ms` → HOLD;
   never let a stale or missing command keep driving the plant.
5. **Off by default.** Do not add NCP to the default command surface or the default
   dependency graph.

## 6. Build & run

```bash
# Default crebain build — must pass with NO NCP/Engram checkout present:
bun run validate:all

# With the standalone NCP SDK resolvable (git dep or sibling), exercise the bridge:
cargo check --features ncp --manifest-path src-tauri/Cargo.toml
cargo test  --features ncp --lib ncp --manifest-path src-tauri/Cargo.toml
```

## 7. References

- `src-tauri/src/ncp/mod.rs`, `src-tauri/src/ncp/README.md` — the Rust bridge.
- `src/neuro/{ncp.ts,ws.ts,index.ts}`, `src/neuro/README.md` — the TS bridge.
- `src-tauri/Cargo.toml` (`[features] ncp`, the optional path deps) — Gap 1.
- `.github/workflows/ci.yml` — the Rust jobs that must stay green.
- Companion: `Paper2Brain/NCP_EXTRACTION_AND_EVOLUTION_HANDOFF.md` — the
  rename, the MCP/ACP-lesson hardening, the single-commander model, and the
  dependency coordinate (git URL + tag) you pin in Gap 1/2.

## 8. Out of scope

- Making crebain depend on Engram/NCP for any core result.
- Changing the NCP wire contract or `ncp.proto` (that is the NCP repo's job).
- Any commander / peer-to-peer behaviour originating from crebain.
