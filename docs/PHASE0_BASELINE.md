# Phase 0 Baseline

Captured: 2026-07-12. This bundle freezes vocabulary and scope; it does not
promote CREBAIN beyond L0.

## Status

| Phase 0 outcome | Status |
|---|---|
| Target declared as secure deterministic single-vehicle SITL | Defined as L1; not achieved |
| Completion levels and claim vocabulary | Baseline established |
| L1 operational design domain | Draft with explicit blockers |
| System context and trust boundaries | Baseline established |
| Hazard log | Initial structured log; all P0 hazards remain open or partial |
| Command and state-mutation inventory | Machine-readable baseline established |
| External source/toolchain/config baseline | Exact local observations recorded; CREBAIN commit intentionally resolved by later release evidence |
| Tracked P0/P1 issues, owners, and dependencies | Pending project-governance work |
| Hermetic clean builds and signed release manifest | Pending |
| Headless plant-authority foundation | Inert package, lifecycle, bounded channels, and passive monotonic expiry component-tested; active watchdog and live plant controls absent |

Phase 0 exit has therefore **not** been reached. L1 remains blocked until every
P0 hazard is controlled with evidence and the live topology passes its negative
bypass, restart, timing, and resource tests.

## Artifacts

- [`COMPLETION_LEVELS.md`](COMPLETION_LEVELS.md)
- [`L1_ODD.md`](L1_ODD.md)
- [`SYSTEM_CONTEXT.md`](SYSTEM_CONTEXT.md)
- [`HAZARD_LOG.md`](HAZARD_LOG.md)
- [`baselines/phase0-hazards.json`](baselines/phase0-hazards.json)
- [`baselines/phase0-command-surfaces.json`](baselines/phase0-command-surfaces.json)
- [`baselines/ecosystem-baseline.json`](baselines/ecosystem-baseline.json)

## Read-only checks

```bash
node scripts/verify-phase0-baseline.mjs
node scripts/test-phase0-baseline.mjs
node scripts/check-plant-authority-boundary.mjs
```

The verifier validates schemas and cross-references and refuses a `controlled`
hazard unless every referenced control has typed evidence bound to that exact
hazard/control set, verification command/result, candidate commit, and a
content-hashed JSON artifact. Its test declaration must explicitly claim the
same hazard/control IDs. It compares the inventory to the registered Tauri
handler list after removing comments and test-only Rust, and requires exactly
one real `generate_handler!` registration. It manifest-locks the executable
Vite/Cargo/Tauri inputs (including root HTML, Cargo build input, public script
inputs, locks, and relevant build scripts). Root Cargo configuration and every
Vite environment variant used by build, development, or test are locked absent;
alternate Vite config modules and Tauri macOS/Linux/Windows/Android/iOS merge
configs are also locked absent. `.env.example` is the only permitted
non-executable root `.env*` file. Wildcard related-name checks reject undeclared
variants. Package, Tauri, and hosted release invocations reject `--config` and
`TAURI_CONFIG`, and the release workflow is content-hash pinned.
TypeScript AST evaluation covers literals, concatenation, constant templates,
array `join`, computed and aliased method names, direct development-adapter
imports, WebSocket construction, renderer `fetch` outside the bounded asset
adapter, and forbidden `Reflect.get` capability recovery. Rust and declarative
inputs receive token/route scanning. Balanced route-like Rust macros fail closed
when their literals, captured constants, separators, or unresolved segments can
construct a route; positional or named format reordering is not treated as a
trusted evaluator. The fail-closed
self-test contains source, comment-shadow, manifest, conditional-input,
computed-route/capability, network, hazard, evidence, and digest mutations.

`bun run validate` runs both checks; `validate:all` inherits them, and hosted CI
runs them as an explicit required baseline step. The verifier does not build the
product, contact external repositories, or claim runtime evidence. Every
`bun run build` (including Tauri's `beforeBuildCommand`) emits a deterministic
Vite module-graph report, rejects inclusion of the development adapter, hashes
every emitted JavaScript chunk, and scans the finalized chunks for WebSocket
or computed/reflective/descriptor/global-destructuring capability recovery and
callable-constructor dynamic code. A dedicated artifact self-test proves the
finalized-chunk scanner rejects split, aliased, bound, descriptor, destructured,
and dynamic variants. Direct `new Function` sites already supplied by pinned
Spark/Rapier dependency-only chunks are an explicit vendor exception; project-
bearing chunks and the artifact fixtures reject them, callable `.constructor()`
remains forbidden, and Tauri CSP omits `unsafe-eval`. `bun run check:bundle`
adds the initial-load size budget to that build.

The plant boundary check uses locked Cargo metadata and source inspection to
require a separate dependency-free `crebain-plant-authority` package, a single
`crebain-plantd` binary, no build script or feature-hidden dependency, no link
from the Tauri application, and no reference to renderer/model/simulation/
transport domains. It proves package isolation, not live authority or safety.
