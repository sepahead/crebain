# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does
not replace the acceptance matrix, model contract, security policy, or manual
smoke record.

## Current Candidate

No release candidate is currently sealed. The final hardening tree is committed,
pushed, and has current automated evidence, but the target-platform manual smoke,
approved model artifact, live transport topology, and release tag remain pending.
The evidence below supports the named source tree only; it does not promote the
system beyond L0 or substitute component CI for SITL, HIL, or field evidence.
Later evidence-log-only commits do not change the executable candidate source.

| Field | Evidence |
|-------|----------|
| Candidate source commit | `49d7b3614f24d21a40fe2af6dbeac082338ae9d7` |
| Branch/tag | `main`; tag pending |
| GitHub Actions run | [CI 29234674954](https://github.com/sepahead/crebain/actions/runs/29234674954) passed on the exact candidate source |
| Hosted supply-chain audit | [Audit 29234675080](https://github.com/sepahead/crebain/actions/runs/29234675080) passed on the exact candidate source; this batch changes no dependency manifest or lockfile |
| Hosted CodeQL | [CodeQL 29234675050](https://github.com/sepahead/crebain/actions/runs/29234675050) passed for Rust and JavaScript/TypeScript on the exact candidate source |
| Additional hosted policy | [OpenSSF Scorecard 29234674958](https://github.com/sepahead/crebain/actions/runs/29234674958) passed on the exact candidate source |
| Local `bun run validate:all` | Passed with the exact executable candidate source: 297 frontend tests; 273 default all-target Rust tests (251 library plus 22 benchmark) plus one ignored fixture generator; 311 NCP-feature all-target Rust tests (289 library plus 22 benchmark) plus one ignored fixture generator; 57 plant tests; strict default/NCP/plant Clippy and Rustfmt; 147 production files; 112 Phase-0 negative fixtures; 20 frame-corpus negative mutations |
| Local MSRV check | Rust 1.88 `cargo check` and all-target plant tests passed; Rust 1.89 `cargo check --locked --all-targets` passed for the application and plant package; development and CI remain pinned to 1.91.1 |
| Frontend test/coverage/bundle result | Local tests and `bun run check:bundle` passed; hosted validation, coverage thresholds, artifact scanner, and bundle budget passed in CI 29234674954; initial bundle 431.8/700 KiB |
| Rust default/NCP/feature result | Local default and NCP-feature all-target suites passed; hosted Linux/macOS default and NCP jobs plus Linux `cuda,tensorrt` and `--no-default-features` checks passed in CI 29234674954 |
| Hardware-WebGL performance smoke | Prior measurement is not candidate evidence; rerun if a numeric performance claim is proposed |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Pinned NCP wire 0.8; complete renderer command mediation; passive inference diagnostics return a truthful busy state instead of waiting on initialization; the one production Tauri handler list is reused by mock-runtime negative IPC tests for scene, detector, fusion, and topic validation; inert headless plant package isolation, bounded command/output channels, retained whole-value health snapshot mechanics, and passive generation-bound monotonic expiry; an inactive contract-v1 validator binds a closed ENU/NED profile kind and artifact digest, frame-retaining SI velocity, session/generation/sequence, producer correlation time, plant-local receipt time, and draft instantaneous speed/TTL limits while rejecting unsupported action classes; a separate profile-neutral kernel and digest-bound 32-case JavaScript/Rust corpus prove bit-exact ENU/NED and FLU/FRD velocity-axis convention changes for one unchanged physical frame instance, canonical positive zero and restricted shortest-round-trip numbers, and rejection of every local/body route without attitude; generic ONNX provider labels require successful provider registration, and exact CoreML benchmark initialization is serialized against normal singleton initialization; native benchmark mechanics have bounded inputs, exact metric scope, content identity, trusted-baseline binding, and explicit report limits. The frame value carries no origin/datum/body-point identity, so caller-assumed coincidence is not proof; the contract and frame kernel have no parser, transport, stateful replay gate, active expiry, health gate, safe-action selector, governor, adapter, or action path, and neither selects an approved profile. The IPC harness starts after platform webview conversion and is not packaged-origin/CSP/capability or positive manual-smoke evidence. A benchmark provider label is selected session configuration, not accelerator/per-operation placement proof; crate-linked/search-loaded runtime bytes are unattested; no approved model, numeric result, target run, or performance claim exists. The generic snapshot does not prevent interior mutation or validate caller-supplied generation freshness/order. A trusted health schema, active watchdog, apply-time governor, and per-session action ownership remain pending; secure-by-default Zenoh posture; isolated development harness state |

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
| Version coherence | Metadata/tag guard on candidate | HEAD and NCP consumer coherence passed; release-tag guard remains pending until a tag exists |
| Frontend validation | Typecheck, lint, format, and tests | Passed locally and in CI 29234674954 |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Passed locally and in CI 29234674954 |
| Rust default | fmt, check, all-target tests, and clippy on Linux/macOS | Passed locally and in CI 29234674954 |
| NCP feature | NCP clippy and all-target tests on Linux/macOS | Passed locally and in CI 29234674954 |
| Inert plant foundation | Dependency boundary, strict Clippy, property/stress/headless/retained-snapshot/expiry/contract/frame tests, digest-bound cross-language frame corpus, and self-check | Passed locally and in CI 29234674954; the inactive contract validates structural semantics and the frame corpus proves only same-instance axis conventions. Frame-instance identity, retained snapshots, and passive expiry remain component prerequisites rather than an approved profile, trusted health contract, active watchdog, or live authority |
| Serialized native IPC | Same production handler list plus negative structured invokes for scene, detector, fusion, and transport input boundaries | Passed locally and in CI 29234674954; starts with `InvokeRequest` under the mock runtime and does not replace raw webview-conversion, packaged-origin/CSP/capability, positive path, or target-platform smoke evidence |
| Native detector benchmark mechanics | All-target/focused tests cover bounds, failure propagation, model/fixture identity, ONNX Runtime loading records and configured-Linux-library identity, raw-sample summaries, exact millisecond-to-FPS conversion, trusted-baseline digest binding/comparability, and no-overwrite report persistence | 22 focused logic tests passed locally in default and NCP all-target suites and in CI 29234674954; release `--help` invocation passed; no approved model, target-hardware run, baseline, threshold, or numeric result |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Passed on Linux in CI 29234674954 |
| Supply chain | cargo-deny and `bun audit` | Passed in Audit 29234675080 on the exact candidate source; this batch has no dependency-manifest or lockfile drift |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Passed in CodeQL 29234675050 |
| Diff hygiene | `git diff --check` before commit and cached diff check | Passed for the executable candidate and this evidence-only update |

## Manual evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Native launch | Packaged/dev Tauri launch and diagnostics on each target | Pending |
| Scene save/restore | Valid save plus migrated/partial/oversized asset paths | Serialized negative IPC cases passed; positive target-platform smoke remains pending |
| ROS 1 / Gazebo Classic | Read-only telemetry on the recorded Zenoh or development/native rosbridge topology; removed publish/service paths remain absent | Pending |
| Native Zenoh | Typed message surface plus explicit unsupported-path behavior | Pending |
| Model contract | Approved artifact digest, tensors, class mapping, fixtures, and rights | Pending external artifact |
| Performance | Candidate-specific hardware/model/command evidence for every numeric claim | No numeric claim approved yet |

## External evidence boundaries

- Hardware-in-the-loop and real autopilot behavior need the target vehicle stack.
- Direct ROS 2 `rmw_zenoh_cpp` interoperability needs a deployed re-keying bridge.
- Zenoh TLS/ACL evidence needs the deployment certificates and topology.
- NCP's default-dormant bridge needs explicit runtime wiring plus a compatible
  Engram/realm/ACL deployment before any live-loop claim.
- PID JSONL proves only local append/parser/basic NIS behavior; it is not evidence
  of Galadriel correlation, PID control, ACL, versioned streaming, or live NCP.
- Model and accuracy evidence needs an approved immutable model plus fixture data.

## Related documents

- `docs/RELEASE_ACCEPTANCE.md`
- `docs/MODEL_CONTRACTS.md`
- `docs/NATIVE_DETECTOR_BENCHMARK.md`
- `docs/MANUAL_SMOKE_TEST.md`
- `SECURITY.md`
