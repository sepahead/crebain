# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does
not replace the acceptance matrix, model contract, security policy, or manual
smoke record.

## Current Candidate

The automated hardening candidate is green. Runtime/deployment evidence remains
pending where the repository cannot provide the required hardware, model,
network topology, credentials, or operator acceptance record.

| Field | Evidence |
|-------|----------|
| Candidate commit | `5dec6037fe1fa461fae76083d682be35ae5352ab` |
| Branch/tag | `main`; tag pending |
| GitHub Actions run | [CI 29104945626](https://github.com/sepahead/crebain/actions/runs/29104945626): success on Linux/macOS |
| Hosted supply-chain audit | [Audit 29104945725](https://github.com/sepahead/crebain/actions/runs/29104945725): Bun audit and cargo-deny success |
| Hosted CodeQL | [CodeQL 29104945672](https://github.com/sepahead/crebain/actions/runs/29104945672): JavaScript/TypeScript and Rust success |
| Additional hosted policy | [ROS definitions 29104945665](https://github.com/sepahead/crebain/actions/runs/29104945665) and [OpenSSF Scorecard 29104945793](https://github.com/sepahead/crebain/actions/runs/29104945793): success |
| Local `bun run validate:all` | Success: 318 frontend tests (8 skipped), 252 default Rust tests (1 ignored), 276 NCP Rust tests (1 ignored), clean fmt/check/clippy |
| Frontend test/coverage/bundle result | 318 passed / 8 skipped; 37.91% statements and 39.06% lines; 438.4 KiB initial gzip against 700 KiB |
| Rust default/NCP/feature result | Default and NCP suites above; `--no-default-features`, `cuda,tensorrt`, and extra no-default CUDA/TensorRT checks passed locally; hosted feature gates passed |
| Hardware-WebGL performance smoke | 60.0 FPS empty, 39.5 FPS splat, 37.2 FPS splat plus feeds against unchanged 50/25/12 floors; Apple M4 Max Chromium Metal |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Scene/asset bounds and restore lifecycle; unified camera schemas; ROS service correlation; Gazebo XML policy; transport disconnects; fusion/NCP fail-safe behavior |

## Automated evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Version coherence | Metadata/tag guard on candidate | Passed in CI 29104945626 |
| Frontend validation | Typecheck, lint, format, and tests | Passed locally and in CI 29104945626 |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Passed in CI 29104945626 |
| Rust default | fmt, check, tests, and clippy on Linux/macOS | Passed in CI 29104945626 |
| NCP feature | NCP clippy and tests on Linux/macOS | Passed in CI 29104945626 |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Passed locally and in CI 29104945626 |
| Supply chain | cargo-deny and `bun audit` | Passed in audit 29104945725 |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Passed in CodeQL 29104945672 |
| Diff hygiene | `git diff --check` before commit and cached diff check | Passed before `5dec603` |

## Manual evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Native launch | Packaged/dev Tauri launch and diagnostics on each target | Pending |
| Scene save/restore | Valid save plus migrated/partial/oversized asset paths | Pending |
| ROS 1 / Gazebo Classic | WebSocket custom messages and mutation services in recorded topology | Pending |
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
