# Phase 0 Baseline

Recaptured: 2026-07-13 09:53:43 +02:00. This bundle freezes vocabulary and
scope; it does not promote CREBAIN beyond L0.

## Status

| Phase 0 outcome | Status |
|---|---|
| Target declared as secure deterministic single-vehicle SITL | Defined as L1; not achieved |
| Completion levels and claim vocabulary | Baseline established |
| L1 operational design domain | Draft with explicit blockers |
| System context and trust boundaries | Baseline established |
| Hazard log | Initial structured log; all P0 hazards remain open or partial |
| Command and state-mutation inventory | Machine-readable baseline established |
| External source/toolchain/config baseline | Remote `main` identities and exact commit-object configuration digests recorded; dirty sibling working-tree bytes were excluded; CREBAIN commit is intentionally resolved by later release evidence |
| Tracked P0/P1 issues, owners, and dependencies | Pending project-governance work |
| Hermetic clean builds and signed release manifest | Pending |
| Headless plant-authority foundation | Inactive draft command validation, profile-neutral digest-bound ENU/NED + FLU/FRD velocity-axis conventions, closed immutable context-bound vehicle-health validation with plant-monotonic ages, lifecycle, bounded channels, and passive monotonic expiry are component-tested in an inert package; approved profile, authenticated FCU collection, freshness/apply-time policy, attitude-dependent transforms, active watchdog, and live plant controls are absent |
| Inactive vehicle-health contract | [`PLANT_HEALTH_V1.md`](PLANT_HEALTH_V1.md) defines the closed in-memory schema, per-channel sequence and plant-local age mechanics, atomic boundary, and explicit limits; it is not authenticated FCU state, freshness policy, or authority evidence |
| Galadriel evidence producer | Feature/runtime-gated component integrated with immutable strict registry and actual config/executable pins, readiness-only active initialization, two exact evidence routes, exact-time/projection eligibility, bounded measurement/live-track/assignment behavior, upstream/capacity/NCP loss degradation, heartbeat generation, and finite owned-task shutdown; numeric upstream loss is not wire-visible, receiver/TLS/ACL/receive-size/deadline/combined-load/calibration evidence is absent, and an optional JSONL writer blocked beyond its separate two-second wait is not forcibly abortable |

Phase 0 exit has therefore **not** been reached. L1 remains blocked until every
P0 hazard is controlled with evidence and the live topology passes its negative
bypass, restart, timing, and resource tests.

## Artifacts

- [`COMPLETION_LEVELS.md`](COMPLETION_LEVELS.md)
- [`L1_ODD.md`](L1_ODD.md)
- [`SYSTEM_CONTEXT.md`](SYSTEM_CONTEXT.md)
- [`GALADRIEL_PRODUCER.md`](GALADRIEL_PRODUCER.md)
- [`HAZARD_LOG.md`](HAZARD_LOG.md)
- [`PLANT_HEALTH_V1.md`](PLANT_HEALTH_V1.md)
- [`baselines/phase0-hazards.json`](baselines/phase0-hazards.json)
- [`baselines/phase0-command-surfaces.json`](baselines/phase0-command-surfaces.json)
- [`baselines/ecosystem-baseline.json`](baselines/ecosystem-baseline.json)
- [`baselines/plant-frame-conventions-v1.json`](baselines/plant-frame-conventions-v1.json)
- [`baselines/plant-frame-golden-v1.tsv`](baselines/plant-frame-golden-v1.tsv)

The 13 July ecosystem capture resolved each required sibling with
`git ls-remote origin refs/heads/main` and hashed named files from those exact
commit objects. It did not hash Haldir, Galadriel, or Engram working-tree bytes;
Galadriel's live `main` was used instead of its local feature-branch checkout.
The local verifier checks the recorded schema, identities, and CREBAIN artifact
bytes but deliberately does not contact those remotes, so this is an immutable
capture statement rather than continuous remote-freshness or runtime evidence.

## Read-only checks

```bash
node scripts/verify-phase0-baseline.mjs
node scripts/test-phase0-baseline.mjs
node scripts/check-plant-authority-boundary.mjs
bun run check:plant-frames
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
trusted evaluator. The generic `publish` capability remains forbidden. The
inventory separately requires the two exact feature/runtime-gated Galadriel NCP
evidence routes and their pin/config-immutability/time/input/capacity/queue/
heartbeat tests; it does not create a generic publisher exception. The fail-closed
self-test contains source, comment-shadow, manifest, conditional-input,
computed-route/capability, network, hazard, evidence, and digest mutations.

`bun run validate` runs both checks; `validate:all` inherits them, and hosted CI
runs them as an explicit required baseline step. The verifier does not build the
product, contact external repositories, inspect deployment certificates/ACLs,
or claim receiver/runtime evidence. Every
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
transport domains. It also locks the canonical kernel to one concrete sealed
health endpoint pair, private immutable snapshot fields, a non-cloneable
single-writer publisher, and no raw snapshot endpoint in the runtime. These are
source-boundary and component properties, not authenticated FCU state, an
approved freshness verdict, live authority, or safety.
The frame checker independently evaluates the same digest-bound finite m/s TSV
with JavaScript and Rust. It proves exact ENU/NED and FLU/FRD velocity-axis
conventions for one unchanged local origin/datum or rigid-body reference point,
plus explicit no-attitude rejection only; it does not carry or prove that
frame-instance precondition, select an approved profile, or prove attitude,
quaternion/yaw, point/translation, covariance, Three.js, time-unit, apply-time,
or FCU semantics. Treating caller-assumed coincidence as evidence blocks L1.
