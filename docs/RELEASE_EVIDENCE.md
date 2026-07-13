# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does
not replace the acceptance matrix, model contract, security policy, or manual
smoke record.

## Current Candidate

No release candidate is currently sealed. The exact executable source under
evidence is `9b603d8509631cbca59f3fd78b28b45a5bff8698`; a later evidence-only
commit records results without changing that source. This source combines the
bounded Galadriel producer with the inert typed vehicle-health snapshot,
exact-profile-bound captured-read age classifier, opaque-situation safe-action
dispatch candidate, and receipt-anchored fixed-state deadline monitor. Its
component evidence does not promote the system beyond L0 or substitute for
deployed TLS/ACL/receiver, authenticated FCU collection, approved age/state,
TTL, or content-bound safe-action policy, authoritative currentness or state
classification, apply-time checks and output revocation, scheduler/suspend/
latency qualification, SITL, HIL, or field evidence.

| Field | Evidence |
|-------|----------|
| Candidate source commit | `9b603d8509631cbca59f3fd78b28b45a5bff8698` |
| Branch/tag | `main`; no release tag |
| GitHub Actions run | [CI 29265912057](https://github.com/sepahead/crebain/actions/runs/29265912057) passed on attempt 1; version/Phase-0 coherence, Linux feature gates, the inert plant boundary, frontend validation/bundle, frontend coverage, and Linux/macOS default plus NCP Rust jobs all succeeded |
| Hosted supply-chain audit | [Audit 29242246397](https://github.com/sepahead/crebain/actions/runs/29242246397) passed on `09dd5ec1556bd56e6934e1ef019f95de84cf9b4f`, the last dependency-manifest change; the candidate changes none of the workflow's manifest inputs |
| Hosted CodeQL | [CodeQL 29265911325](https://github.com/sepahead/crebain/actions/runs/29265911325) passed for Rust and JavaScript/TypeScript on the exact source on attempt 1 |
| Additional hosted policy | [OpenSSF Scorecard 29265913133](https://github.com/sepahead/crebain/actions/runs/29265913133) passed on the exact source on attempt 1 |
| Local `bun run validate:all` | Passed on the exact source: 305 frontend tests; 113 plant unit/integration tests plus 17 compile-fail doctests; 320 default all-target Rust tests plus 1 ignored generator; 411 NCP-feature all-target Rust tests plus 1 ignored generator; strict default/NCP/plant Clippy and Rustfmt; 133 inventoried surfaces, 17 hazards, 154 production files, 31 pinned configs, 114 Phase-0 fail-closed fixtures, 20 frame mutations, 187 plant-boundary mutations (64 health/freshness, 51 safe-action, and 72 deadline-monitor), and 29 production-boundary fixtures |
| Local MSRV check | Rust 1.88 plant `cargo check --all-targets`, 113 all-target tests, and 17 compile-fail doctests passed; Rust 1.89 application `cargo check --locked --all-targets` passed; development and CI remain pinned to 1.91.1 |
| Frontend test/coverage/bundle result | 45 files and 305 local tests passed; exact-source `bun run check:bundle` passed at 432.3/700.0 kB gzipped with 29 production-boundary fixtures; hosted frontend and coverage jobs passed inside CI 29265912057 |
| Rust default/NCP/feature result | Local default and NCP all-target suites passed with 320 and 411 tests respectively, each plus one ignored fixture generator; exact-source plant tests and self-check passed; hosted Linux/macOS default/NCP jobs and Linux feature gates passed |
| Hardware-WebGL performance smoke | Prior measurement is not candidate evidence; rerun if a numeric performance claim is proposed |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Pinned NCP wire 0.8, complete renderer command mediation, serialized negative IPC mechanics, native benchmark mechanics, and the generic renderer/ROS publish prohibition remain in source. The exact-opt-in Galadriel routes, immutable configuration, exact-time/projection eligibility, computational envelopes, and upstream/capacity degradation are inventoried, but the wire summary still lacks numeric upstream/cluster-loss detail. The inert plant package has a sealed closed immutable in-memory vehicle-health path bound to exact candidate profile, vehicle, declared source/stream epoch, runtime generation, local-frame instance, frame/unit, and plant-local observation-time context. Its non-cloneable publisher requires mutable commits and strictly increasing source sequence within one channel; explicit unknown/unavailable state replaces prior nominal state, and checked reads expose one coherent commit and exact ages. The separate classifier consumes that coherent observation, requires exact structural profile identity, and exposes only eight named strict-exclusive age relations captured at the read. It reads no clock, emits no aggregate/boolean health or safety verdict, does not make recent unknown/unavailable state nominal, and does not implement the draft ODD's inclusive `<=200 ms` position/velocity clause. Its limits and profile binding are caller-proposed structural assertions, not authentication or approval. A separate safe-action candidate copies caller-proposed unique nonzero opaque situation rows into an owned fixed 255-slot table, requires the full structural profile identity, has no default, and returns one of five closed plant intents distinct from ingress actions. The profile digest does not content-bind the supplied rows; the candidate does not classify state/triggers, resolve precedence, consume health/lifecycle/time, convert an intent into an action, run in the headless process, call an adapter, or establish a physical response. CTL-007 remains planned and HAZ-007 remains open. The separate fixed-state deadline component derives a private absolute deadline from a structurally validated candidate's opaque receipt instant and a bounded caller-proposed TTL; each monitor owns one named worker and one active slot with no queue, enforces exact profile/session/generation plus increasing sequence on replacement, and records one sticky terminal outcome. A copyable candidate can mint multiple tickets, and neither monitor uniqueness nor the global monitor count is enforced; HAZ-012 remains partial. The supported claim is only that the component detects and timestamps its receipt-anchored deadline when its worker is scheduled. Caller-reported generation mismatch is not autonomous currentness, a poisoned state cannot attest an active key, and start failure preserves context without running a worker. The component is unwired and does not admit or apply commands, revoke output, choose or execute a safe action, establish scheduling or suspend behavior, bound detection-to-effect latency, or prove an operational watchdog. It is partial CB-027/HAZ-003 evidence only; CTL-003 and `TEST-PLANT-LOCAL-TTL` remain planned. Source identity remains unauthenticated; recreated channels can reuse an epoch; real FCU sampling/aggregation and frame-reset attestation are unproved; and there is no parser/transport, durable command replay gate, durable restart anti-rollback, approved freshness/health gate, authoritative safe-action classifier or approved/content-bound policy, apply-time governor, adapter, or action path. The IPC harness is not packaged-origin/CSP/capability or positive smoke evidence; benchmark provider labels are not accelerator/per-operation attestation; and no approved model, target run, numeric claim, receiver/TLS/ACL/receive-size/deadline/combined-load evidence, or per-session action ownership exists. |

## Pre-producer frame-convention snapshot (`49d7b36`, not current evidence)

Immediately before the Galadriel producer commits, commit
`49d7b3614f24d21a40fe2af6dbeac082338ae9d7` passed
[CI 29234674954](https://github.com/sepahead/crebain/actions/runs/29234674954),
[Audit 29234675080](https://github.com/sepahead/crebain/actions/runs/29234675080),
[CodeQL 29234675050](https://github.com/sepahead/crebain/actions/runs/29234675050),
and [OpenSSF Scorecard 29234674958](https://github.com/sepahead/crebain/actions/runs/29234674958).
Its exact local validation covered 297 frontend tests, 273 default and 311
NCP-feature all-target Rust tests (including 22 benchmark tests in each total),
57 plant tests, 147 production files, 112 Phase-0 negative fixtures, and 20
frame-corpus mutations. Those results establish the inactive plant contract and
digest-bound 32-case JavaScript/Rust frame-convention corpus at that commit;
they do not cover the later producer source, routes, manifests, receiver, or
deployment boundary and are not current-candidate evidence.

## Pre-producer plant-contract snapshot (`33e5ef3a`, not current evidence)

Immediately before Galadriel producer integration changed executable source and
manifests, commit `33e5ef3a9a3e8239a7fea902f3122d307b8d8aee`
had the following exact evidence. These results preserve provenance for the
inert plant contract, native benchmark, and serialized IPC work, but none of
the runs or counts may be reused for the producer-integrated candidate.

| Field | Historical evidence |
|-------|---------------------|
| Branch/tag | `main`; no release tag |
| Hosted CI | [CI 29231759604](https://github.com/sepahead/crebain/actions/runs/29231759604) passed on the exact snapshot source |
| Supply chain | [Audit 29228207144](https://github.com/sepahead/crebain/actions/runs/29228207144) passed on `cf76017e9304f408561106f440496f39b745b8a5`, the last dependency-manifest change in that snapshot |
| Static/policy | [CodeQL 29231759633](https://github.com/sepahead/crebain/actions/runs/29231759633) passed for Rust and JavaScript/TypeScript, and [OpenSSF Scorecard 29231759534](https://github.com/sepahead/crebain/actions/runs/29231759534) passed |
| Local validation | `bun run validate:all` passed: 297 frontend tests; 273 default all-target Rust tests (251 library plus 22 benchmark) plus one ignored fixture generator; 311 NCP-feature all-target Rust tests (289 library plus 22 benchmark) plus one ignored fixture generator; 48 plant tests; strict default/NCP/plant Clippy and Rustfmt; 146 production files; 110 Phase-0 negative fixtures |
| MSRV | Rust 1.89 `cargo check --locked --all-targets` passed; development and CI remained pinned to 1.91.1 |
| Frontend/bundle | Local tests and `bun run check:bundle` passed; hosted validation, coverage thresholds, artifact scanner, and bundle budget passed; initial bundle 431.8/700 KiB |
| Rust feature matrix | Local default/NCP all-target suites passed; hosted Linux/macOS default/NCP jobs plus Linux `cuda,tensorrt` and `--no-default-features` checks passed |
| Evidence boundary | The one production Tauri handler list drove mock-runtime negative IPC tests for scene, detector, fusion, and transport inputs. The isolated inert plant package covered bounded command/output channels, retained whole-value snapshots, passive generation-bound monotonic expiry, and inactive contract-v1 validation for a closed ENU/NED profile kind and artifact digest, frame-retaining SI velocity, session/generation/sequence, producer correlation time, plant-local receipt time, draft speed/TTL limits, and rejection of unsupported action classes. The contract had no parser, transport, stateful replay gate, active expiry, trusted health gate, safe-action selector, governor, adapter, or action path; its profile and limits remained unapproved. Native benchmark mechanics covered bounded inputs, exact metric scope, content identity, trusted-baseline binding, and explicit report limits. No approved model, numeric result, target run, packaged-origin/CSP/capability proof, positive smoke, trusted health schema, active watchdog, apply-time governor, or per-session action ownership was established. |

## Pre-producer benchmark/IPC snapshot (`266ff810`, not current evidence)

Before Galadriel producer integration changed executable source and manifests,
commit `266ff810256d9a9563c3a3a1e976e81f81067aeb` had the following exact evidence.
It preserves provenance for the native benchmark and serialized IPC work, but
none of these runs or counts may be reused for the current candidate.

| Field | Historical evidence |
|-------|---------------------|
| Hosted CI | [CI 29229090775](https://github.com/sepahead/crebain/actions/runs/29229090775) passed on `266ff810256d9a9563c3a3a1e976e81f81067aeb` |
| Supply chain | [Audit 29228207144](https://github.com/sepahead/crebain/actions/runs/29228207144) passed on `cf76017e9304f408561106f440496f39b745b8a5`, the last dependency-manifest change in that snapshot |
| Static/policy | [CodeQL 29229090753](https://github.com/sepahead/crebain/actions/runs/29229090753) and [OpenSSF Scorecard 29229090763](https://github.com/sepahead/crebain/actions/runs/29229090763) passed |
| Local validation | 297 frontend tests; 273 default all-target Rust tests (251 library plus 22 benchmark) plus one ignored fixture generator; 311 NCP-feature all-target Rust tests (289 library plus 22 benchmark) plus one ignored fixture generator; 40 plant tests; strict default/NCP/plant Clippy and Rustfmt; 145 production files; 110 Phase-0 negative fixtures |
| MSRV | Rust 1.89 `cargo check --locked --all-targets` passed; development and CI were pinned to 1.91.1 |
| Frontend/bundle | Local tests and `bun run check:bundle` passed; hosted validation, coverage, artifact scanner, and bundle budget passed; initial bundle 431.8/700 KiB |
| Rust feature matrix | Local default/NCP all-target suites and hosted Linux/macOS default/NCP jobs passed; Linux `cuda,tensorrt` and `--no-default-features` checks passed |
| Evidence boundary | The production handler list drove negative mock-runtime IPC tests for scene, detector, fusion, and transport inputs. Native benchmark mechanics covered bounded inputs, model/fixture/runtime identity, raw samples, trusted-baseline digest binding, p95 comparison, and atomic no-overwrite reports. No approved model, target-hardware run, baseline, threshold, numeric result, packaged-origin/CSP/capability proof, positive path, or target-platform smoke was established. |
## Historical Snapshot (`e89de5a`, not current evidence)

The previous candidate passed [CI 29118711312](https://github.com/sepahead/crebain/actions/runs/29118711312),
[Audit 29104945725](https://github.com/sepahead/crebain/actions/runs/29104945725),
[CodeQL 29118711301](https://github.com/sepahead/crebain/actions/runs/29118711301),
and [OpenSSF Scorecard 29118711298](https://github.com/sepahead/crebain/actions/runs/29118711298).
Those results describe commit `e89de5acc2eb7d66b807f85dc407f3da0e35892c` and
must not be reused as evidence for the current dependency or source tree.

## Automated evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Version coherence | Metadata/tag guard on candidate | Local exact-source and hosted CI checks passed; no release tag exists |
| Frontend validation | Typecheck, lint, format, and tests | Local exact-source checks and hosted frontend job passed; 45 files / 305 tests |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Local bundle passed at 432.3/700.0 kB gzipped; hosted coverage and bundle jobs passed |
| Rust default | fmt, check, all-target tests, and clippy on Linux/macOS | Local exact-source suite and hosted Linux/macOS jobs passed |
| NCP bridge/producer feature | Locked NCP clippy and all-target tests on Linux/macOS, including registry/config/executable pins, readiness-only config immutability, exact-time/channel state, bounded measurement/track admission, invalid-gate refusal, sparse/all-infinite assignment, codecs, upstream/queue degradation, heartbeat, lifecycle, and JSONL archive failure semantics | Local 411-test suite plus one ignored generator and hosted Linux/macOS jobs passed; component complexity tests are not target deadline evidence |
| Inert plant foundation | Dependency boundary, exact crate-root/API inventory, sealed-health/freshness/safe-action/deadline-monitor static mutation checks, compile-fail endpoint/ownership/conversion/ticket/monitor checks, strict Clippy, property/stress/headless/retained-snapshot/expiry/contract/frame/health/freshness/safe-action/deadline tests, digest-bound cross-language frame corpus, and self-check | Exact source passed locally and in the hosted plant job: 113 unit/integration tests plus 17 compile-fail doctests, 187 plant-boundary mutations (64 health/freshness, 51 safe-action, and 72 deadline-monitor), 32 frame cases, and 20 frame mutations. The safe-action evidence is only an inert exact-profile, opaque-code, no-default lookup over caller-proposed rows; it is not profile content binding, authoritative state classification, an approved ODD matrix, action conversion, or a physical response. The deadline evidence is only an unwired per-monitor one-slot fixed-state worker that detects/timestamps an immutable receipt-anchored deadline when scheduled; copyable candidates can mint multiple tickets, and neither monitor uniqueness nor the global monitor count is enforced. It is not trusted admission/currentness, an operational watchdog, output revocation, an action/effect, scheduler/suspend/latency qualification, or SITL/HIL evidence. This is partial CB-027/CB-028/CB-030/CTL-005/HAZ-003/HAZ-006/HAZ-007/HAZ-012 component evidence only—CTL-003, CTL-007, and `TEST-PLANT-LOCAL-TTL` remain planned, while HAZ-003 and HAZ-012 remain partial and HAZ-007 remains open; no authenticated FCU state, real aggregation coherence, approved freshness/safety/TTL policy, current/apply-time checking, durable epoch ownership, operational watchdog, apply-time governor, adapter, or live authority exists |
| Serialized native IPC | Same production handler list plus negative structured invokes for scene, detector, fusion, and transport input boundaries | Exact-source local suite and hosted frontend/Rust checks passed; `InvokeRequest` mock-runtime evidence does not replace raw webview conversion, packaged-origin/CSP/capability, positive-path, or target-platform smoke evidence |
| Native detector benchmark mechanics | All-target/focused tests cover bounds, failure propagation, model/fixture identity, ONNX Runtime loading records and configured-Linux-library identity, raw-sample summaries, exact millisecond-to-FPS conversion, trusted-baseline digest binding/comparability, and no-overwrite report persistence | The exact-source default and NCP suites each passed all 22 logic tests; no approved model, target-hardware run, baseline, threshold, or numeric result exists |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Hosted exact-source Linux feature-gate job passed |
| Supply chain | cargo-deny and `bun audit` | Audit 29242246397 passed on the last dependency-manifest change `09dd5ec`; source `9b603d8` has no audit-workflow manifest diff |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Exact-source CodeQL 29265911325 passed for both languages on attempt 1 |
| Diff hygiene | `git diff --check` before commit and cached diff check | Passed on the source tree; evidence-only diff is checked separately before its commit |

## Manual evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Native launch | Packaged/dev Tauri launch and diagnostics on each target | Pending |
| Scene save/restore | Valid save plus migrated/partial/oversized asset paths | Serialized negative IPC cases passed; positive target-platform smoke remains pending |
| ROS 1 / Gazebo Classic | Read-only telemetry on the recorded Zenoh or development/native rosbridge topology; removed publish/service paths remain absent | Pending |
| Native Zenoh | Typed message surface plus explicit unsupported-path behavior | Pending |
| Galadriel producer deployment | Exact post-package executable/config/registry; two-key TLS principal/ACL allow+deny and CN→`producer_id` binding; router/receiver receive-size allow+oversize-deny; receiver decode/join; heartbeat/loss/reorder/restart/saturation/clock/combined-load/shutdown traces; producer logs for numeric upstream/track-cap loss | Pending external topology |
| Plant health and effect boundary | Authenticated FCU collector/source; multi-message coherence with oldest-constituent time; frame-reset identity; durable epoch ownership; approved freshness/TTL policy plus authoritative situation classification and a content-bound safe-action matrix; immediately-before-write generation/health checks and output revocation; operational watchdog, governor, adapter, and SITL/HIL traces | Pending external vehicle/profile/topology and later plant components; neither the opaque situation-dispatch candidate nor the unwired fixed-state deadline monitor satisfies these gates |
| Model contract | Approved artifact digest, tensors, class mapping, fixtures, and rights | Pending external artifact |
| Performance | Candidate-specific hardware/model/command evidence for every numeric claim | No numeric claim approved yet |

## External evidence boundaries

- Hardware-in-the-loop and real autopilot behavior need the target vehicle stack.
- Direct ROS 2 `rmw_zenoh_cpp` interoperability needs a deployed re-keying bridge.
- Zenoh TLS/ACL evidence needs the deployment certificates and topology.
- NCP's action bridge remains dormant and needs explicit runtime wiring plus a
  compatible Engram/realm/ACL deployment before any live action-loop claim.
- The Galadriel producer runtime is wired only under its two gates. It still
  needs an authenticated exact-route topology, verified receive-size policy, and
  compatible receiver-side assembler/registry/deadline/loss evidence before a
  live ecosystem claim. Sparse-assignment and bounded-admission component tests
  do not prove combined-process timing, and numeric upstream/cluster loss remains
  producer-log-only in the current wire contract.
- PID JSONL proves only local append/parser/basic NIS behavior; it is not evidence
  of Galadriel correlation, PID control, ACL, versioned streaming, or live NCP.
  Its active capacity-16 archive/drop/degradation behavior and blocked-writer
  shutdown limit still need candidate-specific storage evidence.
- The vehicle-health component has a closed immutable in-memory schema and
  coherent age mechanics, while the separate exact-profile-bound classifier
  compares only ages frozen at one read against caller-proposed exclusive
  limits. Neither component establishes current/apply-time freshness or health;
  the source, frame, and profile identities are declared, not authenticated or
  adapter-attested. They still need real FCU aggregation, durable epoch
  ownership, approved freshness/safe-action policy, apply-time checks,
  watchdog/governor/adapter mechanics, and SITL/HIL traces.
- The safe-action situation-dispatch candidate owns a bounded no-default table
  over caller-proposed opaque codes and a closed plant-intent vocabulary. The
  asserted profile identity does not content-bind those rows, and no
  authoritative state/trigger classifier, overlap precedence, health/time/
  lifecycle input, action conversion, runtime consumer, adapter transaction,
  FCU acknowledgement, or observed effect exists. It is not evidence that Hold,
  Land, RTL, inhibit, or ground disarm is safe in any operational state.
- The deadline-monitor candidate owns one fixed stream slot and derives an
  immutable deadline from opaque plant-local receipt time plus a bounded local
  TTL proposal. That slot is per monitor only: the copyable candidate can mint
  multiple tickets, and no global monitor-instance bound or uniqueness rule is
  enforced. It can timestamp deadline observation when its worker is scheduled,
  but it is unwired and neither authenticates admission/currentness nor revokes
  output or causes an action/effect. Caller-reported generation mismatch is not
  autonomous lifecycle observation. No scheduler reservation, suspend-inclusive
  clock qualification, latency bound, process-loss containment, or SITL/HIL
  evidence exists, so this is not an operational watchdog claim and HAZ-012
  remains partial.
- Model and accuracy evidence needs an approved immutable model plus fixture data.

## Related documents

- `docs/RELEASE_ACCEPTANCE.md`
- `docs/MODEL_CONTRACTS.md`
- `docs/NATIVE_DETECTOR_BENCHMARK.md`
- `docs/MANUAL_SMOKE_TEST.md`
- `docs/PLANT_FRESHNESS_V1.md`
- `docs/PLANT_HEALTH_V1.md`
- `docs/PLANT_SAFE_ACTION_V1.md`
- `docs/PLANT_WATCHDOG_V1.md`
- `SECURITY.md`
