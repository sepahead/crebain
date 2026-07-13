# Phase 0 Baseline

Recaptured: 2026-07-13T14:05:44+02:00. This bundle freezes vocabulary and
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
| Headless plant-authority foundation | Inactive draft command validation, profile-neutral digest-bound ENU/NED + FLU/FRD velocity-axis conventions, closed context-bound vehicle-health/captured-age mechanics, exact-profile opaque-situation safe-action dispatch, lifecycle, bounded channels, passive expiry, an unwired receipt-anchored active deadline monitor, and a non-authorizing apply-check observation are component-tested in an inert package. The observation first loads one generation-checked coherent health snapshot, then mints one private monotonic reference instant and computes health ages followed by command receipt age relative to it while retaining neutral lifecycle state/generation. It is remintable, lacks command-content and command-to-health vehicle/frame-instance binding, is not a write-adjacent atomic transaction, and can stale immediately. One monitor owns one worker/slot and accepts only exact-stream strictly increasing tickets, but does not authenticate admission, observe lifecycle autonomously, invalidate output, select/apply a safe action, or prove scheduler/latency behavior; approved profile/age/state/safe-action/TTL policy, authenticated FCU collection, current/apply-time enforcement, attitude-dependent transforms, and live plant controls remain absent |
| Inactive vehicle-health contract | [`PLANT_HEALTH_V1.md`](PLANT_HEALTH_V1.md) defines the closed in-memory schema, per-channel sequence and plant-local age mechanics, atomic boundary, and explicit limits; it is not authenticated FCU state, an approved health policy, or authority evidence |
| Inactive captured-read age classifier | [`PLANT_FRESHNESS_V1.md`](PLANT_FRESHNESS_V1.md) defines exact-profile binding, eight named nonzero exclusive limits, and per-point exclusive relations tested below, at, and above each boundary while retaining the coherent observed commit; it does not read current time, implement the draft ODD's inclusive `<=200 ms` condition, aggregate health, or enforce anything at apply time |
| Inactive safe-action dispatch candidate | [`PLANT_SAFE_ACTION_V1.md`](PLANT_SAFE_ACTION_V1.md) defines an owned fixed table from nonzero opaque situation codes to a closed intent vocabulary, exact full-profile matching, duplicate rejection, and no fallback/default. It is caller-proposed, not content-bound or approved, and has no health/state/trigger classifier, precedence, lifecycle/time input, action conversion, adapter call, or physical-effect evidence |
| Active deadline-monitor candidate | [`PLANT_WATCHDOG_V1.md`](PLANT_WATCHDOG_V1.md) defines receipt-derived immutable tickets, one named worker, one active slot/no queue, strict same-profile/session/generation sequence advancement, due-before-control precedence, caller-reported generation mismatch, sticky terminal evidence, and fail-closed poison/panic/shutdown handling. Poisoned synchronization carries no exact active key, and start failure retains its initial context. It is unwired and is not an operational watchdog, apply-time output invalidator, safe action, suspend qualification, or latency proof |
| Inactive apply-check observation candidate | [`PLANT_APPLY_OBSERVATION_V1.md`](PLANT_APPLY_OBSERVATION_V1.md) defines one coherent health snapshot loaded before one private plant-monotonic reference instant is minted for health-age and command receipt-age evaluation, strict requested-lifetime equality-outside relation, neutral lifecycle state/generation, and all eight existing health-age relations. `Ok` can retain an expired command, any lifecycle state, stale ages, and unknown/unavailable health; it has no direct boolean accessor or `From` conversion to `bool` and supplies no aggregate/authorizing verdict, permit, command content, action, adapter conversion, I/O, or runtime consumer, although callers can compare facts. Its command has no vehicle/frame-instance identity, it is remintable rather than command-content-bound, retained IDs/TTL must never pair it as a checked token, and it is not a write-adjacent atomic transaction |
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
- [`PLANT_FRESHNESS_V1.md`](PLANT_FRESHNESS_V1.md)
- [`PLANT_SAFE_ACTION_V1.md`](PLANT_SAFE_ACTION_V1.md)
- [`PLANT_WATCHDOG_V1.md`](PLANT_WATCHDOG_V1.md)
- [`PLANT_APPLY_OBSERVATION_V1.md`](PLANT_APPLY_OBSERVATION_V1.md)
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
single-writer publisher, and no raw snapshot endpoint in the runtime. It also
locks one private freshness module, exact profile/observation ownership, eight
nonzero named exclusive limits, the strict `<` comparator, and the absence of a
boolean or aggregate verdict. The same check locks one private safe-action
module, the closed intent vocabulary, owned fixed 255-slot table, nonzero opaque
situation codes, full-profile match, duplicate/empty/oversize rejection, no
default row, and the absence of state/trigger classification or action/adapter
conversion. It additionally seals one private active deadline-monitor module:
ticket construction borrows a validated candidate and derives an immutable
deadline through opaque receipt operations; one named worker owns one active
slot/no queue; replacement requires the exact profile/session/generation and a
strictly greater sequence; regression/due checks precede replacement/control;
terminal evidence is sticky; and polling, detach, callbacks, action conversion,
or runtime wiring remain forbidden. The checker also seals one private
apply-observation module. Exact profile and generation checks precede one
coherent health snapshot load; only then is one private plant-monotonic
reference instant minted, with health ages computed before command receipt age
relative to it. Requested-lifetime equality is outside; lifecycle remains
neutral; and the observation retains all eight existing captured health-age
relations. It has no direct boolean accessor or `From` conversion to `bool` and
supplies no aggregate/authorizing verdict, permit, command content,
velocity/action/adapter conversion, output revocation, safe action, I/O, or
runtime wiring, although callers can compare facts. It is remintable and lacks
command-content and command-to-health vehicle/frame-instance binding; retained
IDs/TTL must never pair it as a checked token, and it supplies no HAZ-005 or
HAZ-013 evidence. The 123 plant unit/integration tests, 24
compile-fail doctests, and 231 static fixtures (64 health/freshness, 51 safe
action, 72 deadline monitor, and 44 apply observation) remain component/source
evidence only. The apply matrix is prerequisite/component evidence for its
declared CTL-003/CTL-005 links; CB-029, CTL-005, HAZ-003, and HAZ-006 are
partial, while CTL-003 and the planned write-adjacent tests remain unmet. These are source-boundary and
component properties, not authenticated FCU state, an approved freshness/
health/safe-action policy, content binding of caller-proposed rows,
current/apply-time enforcement, live authority, scheduler/latency
qualification, or safety.
The frame checker independently evaluates the same digest-bound finite m/s TSV
with JavaScript and Rust. It proves exact ENU/NED and FLU/FRD velocity-axis
conventions for one unchanged local origin/datum or rigid-body reference point,
plus explicit no-attitude rejection only; it does not carry or prove that
frame-instance precondition, select an approved profile, or prove attitude,
quaternion/yaw, point/translation, covariance, Three.js, time-unit, apply-time,
or FCU semantics. Treating caller-assumed coincidence as evidence blocks L1.
