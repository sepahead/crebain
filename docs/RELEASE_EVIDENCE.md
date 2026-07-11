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
| Candidate commit | `e89de5acc2eb7d66b807f85dc407f3da0e35892c` |
| Branch/tag | `main`; tag pending |
| GitHub Actions run | [CI 29118711312](https://github.com/sepahead/crebain/actions/runs/29118711312): success on Linux/macOS, including NCP and feature gates |
| Hosted supply-chain audit | Dependency manifests are unchanged; [Audit 29104945725](https://github.com/sepahead/crebain/actions/runs/29104945725) remains the applicable hosted Bun audit/cargo-deny success, and both checks passed locally on this candidate |
| Hosted CodeQL | [CodeQL 29118711301](https://github.com/sepahead/crebain/actions/runs/29118711301): JavaScript/TypeScript and Rust success |
| Additional hosted policy | [OpenSSF Scorecard 29118711298](https://github.com/sepahead/crebain/actions/runs/29118711298): success; unchanged ROS definitions remain covered by [run 29104945665](https://github.com/sepahead/crebain/actions/runs/29104945665) |
| Local `bun run validate:all` | Success: 333 frontend tests (8 skipped), 252 default Rust tests (1 ignored), 290 NCP Rust tests (1 ignored), clean fmt/check/clippy |
| Frontend test/coverage/bundle result | Hosted: 333 passed / 8 skipped; 38.55% statements, 36.69% branches, 41% functions, and 39.72% lines; 440.9 KiB initial gzip against 700 KiB |
| Rust default/NCP/feature result | Local default/NCP suites above; hosted macOS passed 252 default and 290 NCP tests, Linux passed 234 default and 272 NCP tests, and `--no-default-features` plus `cuda,tensorrt` feature checks passed |
| Hardware-WebGL performance smoke | 60.0 FPS empty, 39.5 FPS splat, 37.2 FPS splat plus feeds against unchanged 50/25/12 floors; Apple M4 Max Chromium Metal |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Pinned NCP wire-0.7 typed reply validation; raw ESTOP latching; bounded command ingress; per-session lifecycle/action ownership; secure-by-default Zenoh posture; isolated Vite-dev harness state |

## Automated evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Version coherence | Metadata/tag guard on candidate | Passed in CI 29118711312 |
| Frontend validation | Typecheck, lint, format, and tests | Passed locally and in CI 29118711312 |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Passed in CI 29118711312 |
| Rust default | fmt, check, tests, and clippy on Linux/macOS | Passed in CI 29118711312 |
| NCP feature | NCP clippy and tests on Linux/macOS | Passed in CI 29118711312 |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Passed locally and in CI 29118711312 |
| Supply chain | cargo-deny and `bun audit` | Current-candidate local checks passed; unchanged manifests retain hosted audit 29104945725 |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Passed in CodeQL 29118711301 |
| Diff hygiene | `git diff --check` before commit and cached diff check | Passed before `e89de5a` |

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
