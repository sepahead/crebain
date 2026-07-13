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
| Candidate source commit | `2b46b926c3b15345733c5645a3acd02c684af03e` |
| Branch/tag | `main`; tag pending |
| GitHub Actions run | [CI 29218466701](https://github.com/sepahead/crebain/actions/runs/29218466701) passed on the exact candidate source |
| Hosted supply-chain audit | [Audit 29215667661](https://github.com/sepahead/crebain/actions/runs/29215667661) passed on `d2f169f59694a32e3536d2fbe27ad938b66fc341`, the last dependency-manifest change; later candidate commits did not change dependency manifests or lockfiles |
| Hosted CodeQL | [CodeQL 29218466715](https://github.com/sepahead/crebain/actions/runs/29218466715) passed for Rust and JavaScript/TypeScript on the exact candidate source |
| Additional hosted policy | [OpenSSF Scorecard 29218466748](https://github.com/sepahead/crebain/actions/runs/29218466748) passed on the exact candidate source |
| Local `bun run validate:all` | Passed with the exact executable candidate source: 297 frontend tests; 248 default Rust tests plus one ignored fixture generator; 286 NCP-feature Rust tests plus one ignored fixture generator; 34 plant tests; strict default/NCP/plant Clippy and Rustfmt; 145 production files; 110 Phase-0 negative fixtures |
| Frontend test/coverage/bundle result | Local tests and `bun run check:bundle` passed; hosted validation, coverage thresholds, artifact scanner, and bundle budget passed in CI 29218466701; initial bundle 431.8/700 KiB |
| Rust default/NCP/feature result | Local default and NCP-feature suites passed; hosted Linux/macOS default and NCP jobs plus Linux `cuda,tensorrt` and `--no-default-features` checks passed in CI 29218466701 |
| Hardware-WebGL performance smoke | Prior measurement is not candidate evidence; rerun if a numeric performance claim is proposed |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Pinned NCP wire 0.8; complete renderer command mediation; inert headless plant package isolation, bounded channels, and passive generation-bound monotonic expiry; active watchdog, apply-time governor, and per-session action ownership remain pending; secure-by-default Zenoh posture; isolated development harness state |

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
| Frontend validation | Typecheck, lint, format, and tests | Passed locally and in CI 29218466701 |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Passed in CI 29218466701 |
| Rust default | fmt, check, tests, and clippy on Linux/macOS | Passed locally and in CI 29218466701 |
| NCP feature | NCP clippy and tests on Linux/macOS | Passed locally and in CI 29218466701 |
| Inert plant foundation | Dependency boundary, strict Clippy, property/stress/headless/expiry tests, self-check | Passed locally and in CI 29218466701; passive expiry remains component mechanics, not an active watchdog or live authority |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Passed on Linux in CI 29218466701 |
| Supply chain | cargo-deny and `bun audit` | Passed in Audit 29215667661 on the last dependency-manifest change; no later dependency drift |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Passed in CodeQL 29218466715 |
| Diff hygiene | `git diff --check` before commit and cached diff check | Passed for the hardening commits; must be rerun for any later evidence-only update |

## Manual evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Native launch | Packaged/dev Tauri launch and diagnostics on each target | Pending |
| Scene save/restore | Valid save plus migrated/partial/oversized asset paths | Pending |
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
- `docs/MANUAL_SMOKE_TEST.md`
- `SECURITY.md`
