# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does
not replace the acceptance matrix, model contract, security policy, or manual
smoke record.

## Current Candidate

No release candidate is currently sealed. The exact executable source under
evidence is `8a30b367e5574671ccbe1e030a0aa254804ffe38`; a later evidence-only
commit records results without changing that source. This source combines the
bounded Galadriel producer with the inert typed vehicle-health snapshot. Its
component evidence does not promote the system beyond L0 or substitute for
deployed TLS/ACL/receiver, authenticated FCU collection, SITL, HIL, or field
evidence.

| Field | Evidence |
|-------|----------|
| Candidate source commit | `8a30b367e5574671ccbe1e030a0aa254804ffe38` |
| Branch/tag | `main`; no release tag |
| GitHub Actions run | [CI 29243068759](https://github.com/sepahead/crebain/actions/runs/29243068759) passed on attempt 3. Attempts 1 and 2 were canceled only after isolated Ubuntu package-install stalls; every completed job was green, and attempt 3 reran the Ubuntu backend and Linux feature gate successfully |
| Hosted supply-chain audit | [Audit 29242246397](https://github.com/sepahead/crebain/actions/runs/29242246397) passed on `09dd5ec1556bd56e6934e1ef019f95de84cf9b4f`, the last dependency-manifest change; the candidate changes none of the workflow's manifest inputs |
| Hosted CodeQL | [CodeQL 29243068800](https://github.com/sepahead/crebain/actions/runs/29243068800) passed for Rust and JavaScript/TypeScript on the exact source |
| Additional hosted policy | [OpenSSF Scorecard 29243068803](https://github.com/sepahead/crebain/actions/runs/29243068803) passed on the exact source |
| Local `bun run validate:all` | Passed on the exact source: 305 frontend tests; 74 plant unit/integration tests plus 2 compile-fail doctests; 320 default all-target Rust tests plus 1 ignored generator; 411 NCP-feature all-target Rust tests plus 1 ignored generator; strict default/NCP/plant Clippy and Rustfmt; 133 inventoried surfaces, 17 hazards, 151 production files, 31 pinned configs, 114 Phase-0 fail-closed fixtures, 20 frame mutations, and 24 health-boundary mutations |
| Local MSRV check | Rust 1.88 plant `cargo check` and 74 all-target tests passed; Rust 1.89 application `cargo check --locked --all-targets` passed; development and CI remain pinned to 1.91.1 |
| Frontend test/coverage/bundle result | 45 files and 305 local tests passed; exact-source `bun run check:bundle` passed at 432.3/700.0 kB gzipped with 29 production-boundary fixtures; hosted frontend and coverage jobs passed inside CI 29243068759 |
| Rust default/NCP/feature result | Local default and NCP all-target suites passed with 320 and 411 tests respectively, each plus one ignored fixture generator; exact-source plant tests and self-check passed; hosted Linux/macOS default/NCP jobs and Linux feature gates passed |
| Hardware-WebGL performance smoke | Prior measurement is not candidate evidence; rerun if a numeric performance claim is proposed |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Pinned NCP wire 0.8, complete renderer command mediation, serialized negative IPC mechanics, native benchmark mechanics, and the generic renderer/ROS publish prohibition remain in source. The exact-opt-in Galadriel routes, immutable configuration, exact-time/projection eligibility, computational envelopes, and upstream/capacity degradation are inventoried, but the wire summary still lacks numeric upstream/cluster-loss detail. The inert plant package now has a sealed closed immutable in-memory vehicle-health path bound to exact candidate profile, vehicle, declared source/stream epoch, runtime generation, local-frame instance, frame/unit, and plant-local observation-time context. Its non-cloneable publisher requires mutable commits and strictly increasing source sequence within one channel; explicit unknown/unavailable state replaces prior nominal state, and checked reads expose one coherent commit and exact ages without a freshness or safety verdict. Source identity remains unauthenticated; recreated channels can reuse an epoch; real FCU sampling/aggregation and frame-reset attestation are unproved; and there is no parser/transport, command replay gate, durable restart anti-rollback, active watchdog, approved freshness/health gate, safe-action selector, apply-time governor, adapter, or action path. The IPC harness is not packaged-origin/CSP/capability or positive smoke evidence; benchmark provider labels are not accelerator/per-operation attestation; and no approved model, target run, numeric claim, receiver/TLS/ACL/receive-size/deadline/combined-load evidence, or per-session action ownership exists. |

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
| Inert plant foundation | Dependency boundary, exact crate-root/API inventory, sealed-health/static mutation checks, compile-fail endpoint checks, strict Clippy, property/stress/headless/retained-snapshot/expiry/contract/frame/health tests, digest-bound cross-language frame corpus, and self-check | Exact source passed locally and in the hosted plant job: 74 unit/integration tests plus 2 compile-fail doctests, 24 health-boundary mutations, 32 frame cases, and 20 frame mutations. This is partial CB-030/CTL-005/HAZ-006 component evidence only—not authenticated FCU state, real aggregation coherence, approved freshness/safety policy, durable epoch ownership, an active watchdog, apply-time governor, adapter, or live authority |
| Serialized native IPC | Same production handler list plus negative structured invokes for scene, detector, fusion, and transport input boundaries | Exact-source local suite and hosted frontend/Rust checks passed; `InvokeRequest` mock-runtime evidence does not replace raw webview conversion, packaged-origin/CSP/capability, positive-path, or target-platform smoke evidence |
| Native detector benchmark mechanics | All-target/focused tests cover bounds, failure propagation, model/fixture identity, ONNX Runtime loading records and configured-Linux-library identity, raw-sample summaries, exact millisecond-to-FPS conversion, trusted-baseline digest binding/comparability, and no-overwrite report persistence | The exact-source default and NCP suites each passed all 22 logic tests; no approved model, target-hardware run, baseline, threshold, or numeric result exists |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Hosted exact-source Linux feature-gate job passed |
| Supply chain | cargo-deny and `bun audit` | Audit 29242246397 passed on the last dependency-manifest change `09dd5ec`; the candidate has no audit-workflow manifest diff |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Exact-source CodeQL 29243068800 passed for both languages |
| Diff hygiene | `git diff --check` before commit and cached diff check | Passed on the source tree; evidence-only diff is checked separately before its commit |

## Manual evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Native launch | Packaged/dev Tauri launch and diagnostics on each target | Pending |
| Scene save/restore | Valid save plus migrated/partial/oversized asset paths | Serialized negative IPC cases passed; positive target-platform smoke remains pending |
| ROS 1 / Gazebo Classic | Read-only telemetry on the recorded Zenoh or development/native rosbridge topology; removed publish/service paths remain absent | Pending |
| Native Zenoh | Typed message surface plus explicit unsupported-path behavior | Pending |
| Galadriel producer deployment | Exact post-package executable/config/registry; two-key TLS principal/ACL allow+deny and CN→`producer_id` binding; router/receiver receive-size allow+oversize-deny; receiver decode/join; heartbeat/loss/reorder/restart/saturation/clock/combined-load/shutdown traces; producer logs for numeric upstream/track-cap loss | Pending external topology |
| Plant health and effect boundary | Authenticated FCU collector/source; multi-message coherence with oldest-constituent time; frame-reset identity; durable epoch ownership; approved freshness and safe-action policy; immediately-before-write generation/health checks; watchdog, governor, adapter, and SITL/HIL traces | Pending external vehicle/profile/topology and later inert policy components |
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
  coherent age mechanics, but its source and frame identities are declared, not
  authenticated or adapter-attested. It still needs real FCU aggregation,
  durable epoch ownership, approved freshness/safe-action policy, apply-time
  checks, watchdog/governor/adapter mechanics, and SITL/HIL traces.
- Model and accuracy evidence needs an approved immutable model plus fixture data.

## Related documents

- `docs/RELEASE_ACCEPTANCE.md`
- `docs/MODEL_CONTRACTS.md`
- `docs/NATIVE_DETECTOR_BENCHMARK.md`
- `docs/MANUAL_SMOKE_TEST.md`
- `docs/PLANT_HEALTH_V1.md`
- `SECURITY.md`
