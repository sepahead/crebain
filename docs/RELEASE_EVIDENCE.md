# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does
not replace the acceptance matrix, model contract, security policy, or manual
smoke record.

## Current Candidate

No release candidate is currently sealed. Galadriel producer integration changed
the executable source, feature surface, configuration inputs, command-surface
inventory, hazards, and manifests after the formerly named candidate. All local
counts and hosted runs must be recaptured on one exact clean commit. Component
tests do not promote the system beyond L0 or substitute for deployed
TLS/ACL/receiver, SITL, HIL, or field evidence.

| Field | Evidence |
|-------|----------|
| Candidate source commit | Pending clean producer-integration commit |
| Branch/tag | Pending |
| GitHub Actions run | Pending exact-commit run |
| Hosted supply-chain audit | Pending manifest-aware rerun or exact last-manifest-change binding |
| Hosted CodeQL | Pending exact-commit run |
| Additional hosted policy | Pending exact-commit run |
| Local `bun run validate:all` | Pending; do not reuse earlier test/file/fixture counts |
| Local MSRV check | Pending exact-commit Rust 1.89 `cargo check --locked --all-targets` |
| Frontend test/coverage/bundle result | Pending exact-commit local/hosted results |
| Rust default/NCP/feature result | Pending exact-commit default and bridge/producer results |
| Hardware-WebGL performance smoke | Prior measurement is not candidate evidence; rerun if a numeric performance claim is proposed |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Pinned NCP wire 0.8; complete renderer command mediation and serialized negative IPC mechanics remain in source; native benchmark mechanics retain bounded inputs, exact metric scope, content identity, trusted-baseline binding, and explicit report limits; generic renderer/ROS publish remains forbidden; exact opt-in Galadriel evidence routes and deployment pins are inventoried. The inert plant package retains inactive contract-v1 structural validation, bounded command/output channels, retained whole-value snapshot mechanics, and passive generation-bound monotonic expiry, but has no parser, transport, stateful replay gate, active expiry, trusted health gate, safe-action selector, governor, adapter, or action path, and its profile/limits remain unapproved. The IPC harness is not packaged-origin/CSP/capability or positive smoke evidence; benchmark provider labels are not accelerator/per-operation attestation; and no approved model, target run, numeric claim, receiver/TLS/ACL/deadline evidence, trusted health schema, active watchdog, apply-time governor, or per-session action ownership exists. |

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
| Version coherence | Metadata/tag guard on candidate | Pending recapture |
| Frontend validation | Typecheck, lint, format, and tests | Pending recapture |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Pending recapture |
| Rust default | fmt, check, all-target tests, and clippy on Linux/macOS | Pending recapture |
| NCP bridge/producer feature | NCP clippy and all-target tests on Linux/macOS, including registry/config/executable pins, codecs, queues, heartbeat, lifecycle, and JSONL archive failure semantics | Pending recapture |
| Inert plant foundation | Dependency boundary, strict Clippy, property/stress/headless/retained-snapshot/expiry/contract tests, self-check | Pending exact-commit rerun; the inactive contract passed in the `33e5ef3a` snapshot but validates structural semantics only, while retained snapshots and passive expiry remain component mechanics, not a trusted health contract, active watchdog, or live authority |
| Serialized native IPC | Same production handler list plus negative structured invokes for scene, detector, fusion, and transport input boundaries | Pending exact-commit rerun; the pre-producer snapshot passed, but its `InvokeRequest` mock-runtime evidence does not replace raw webview conversion, packaged-origin/CSP/capability, positive-path, or target-platform smoke evidence |
| Native detector benchmark mechanics | All-target/focused tests cover bounds, failure propagation, model/fixture identity, ONNX Runtime loading records and configured-Linux-library identity, raw-sample summaries, exact millisecond-to-FPS conversion, trusted-baseline digest binding/comparability, and no-overwrite report persistence | Pending exact-commit rerun; 22 focused logic tests and release `--help` passed only in the pre-producer snapshot, and no approved model, target-hardware run, baseline, threshold, or numeric result exists |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Pending recapture |
| Supply chain | cargo-deny and `bun audit` | Pending manifest-aware binding |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Pending recapture |
| Diff hygiene | `git diff --check` before commit and cached diff check | Pending on final tree |

## Manual evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Native launch | Packaged/dev Tauri launch and diagnostics on each target | Pending |
| Scene save/restore | Valid save plus migrated/partial/oversized asset paths | Serialized negative IPC cases passed; positive target-platform smoke remains pending |
| ROS 1 / Gazebo Classic | Read-only telemetry on the recorded Zenoh or development/native rosbridge topology; removed publish/service paths remain absent | Pending |
| Native Zenoh | Typed message surface plus explicit unsupported-path behavior | Pending |
| Galadriel producer deployment | Exact post-package executable/config/registry; two-key TLS principal/ACL allow+deny; receiver decode/join; heartbeat/loss/reorder/restart/saturation/shutdown traces | Pending external topology |
| Model contract | Approved artifact digest, tensors, class mapping, fixtures, and rights | Pending external artifact |
| Performance | Candidate-specific hardware/model/command evidence for every numeric claim | No numeric claim approved yet |

## External evidence boundaries

- Hardware-in-the-loop and real autopilot behavior need the target vehicle stack.
- Direct ROS 2 `rmw_zenoh_cpp` interoperability needs a deployed re-keying bridge.
- Zenoh TLS/ACL evidence needs the deployment certificates and topology.
- NCP's action bridge remains dormant and needs explicit runtime wiring plus a
  compatible Engram/realm/ACL deployment before any live action-loop claim.
- The Galadriel producer runtime is wired only under its two gates. It still
  needs an authenticated exact-route topology and compatible receiver-side
  assembler/registry/deadline evidence before a live ecosystem claim.
- PID JSONL proves only local append/parser/basic NIS behavior; it is not evidence
  of Galadriel correlation, PID control, ACL, versioned streaming, or live NCP.
  Its active capacity-16 archive/drop/degradation behavior and blocked-writer
  shutdown limit still need candidate-specific storage evidence.
- Model and accuracy evidence needs an approved immutable model plus fixture data.

## Related documents

- `docs/RELEASE_ACCEPTANCE.md`
- `docs/MODEL_CONTRACTS.md`
- `docs/NATIVE_DETECTOR_BENCHMARK.md`
- `docs/MANUAL_SMOKE_TEST.md`
- `SECURITY.md`
