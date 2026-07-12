# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does
not replace the acceptance matrix, model contract, security policy, or manual
smoke record.

## Current Candidate

No release candidate is currently sealed. The hardening work on `main` changes
source, dependency manifests, and lockfiles, so previous hosted runs are
historical context only. A new candidate commit and its hosted gates must be
recorded here after the working tree is committed and pushed.

| Field | Evidence |
|-------|----------|
| Candidate commit | Pending final hardening commit |
| Branch/tag | `main`; tag pending |
| GitHub Actions run | Pending for the new candidate |
| Hosted supply-chain audit | Required: `package.json` and `bun.lock` changed |
| Hosted CodeQL | Pending for the new candidate |
| Additional hosted policy | Pending for the new candidate |
| Local `bun run validate:all` | Pending final combined-tree run |
| Frontend test/coverage/bundle result | Pending final combined-tree and hosted runs |
| Rust default/NCP/feature result | Pending final combined-tree and hosted runs |
| Hardware-WebGL performance smoke | Prior measurement is not candidate evidence; rerun if a numeric performance claim is proposed |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Pinned NCP wire 0.8; complete command mediation; bounded ingress; per-session lifecycle/action ownership; secure-by-default Zenoh posture; isolated development harness state |

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
| Version coherence | Metadata/tag guard on candidate | Pending new candidate |
| Frontend validation | Typecheck, lint, format, and tests | Pending final combined-tree run |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Pending new candidate |
| Rust default | fmt, check, tests, and clippy on Linux/macOS | Pending final combined-tree and hosted runs |
| NCP feature | NCP clippy and tests on Linux/macOS | Pending final combined-tree and hosted runs |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Pending new candidate |
| Supply chain | cargo-deny and `bun audit` | Pending because dependency manifests changed |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Pending new candidate |
| Diff hygiene | `git diff --check` before commit and cached diff check | Pending final commit |

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
