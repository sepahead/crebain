# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does
not replace the acceptance matrix, model contract, security policy, or manual
smoke record.

## Current Candidate

The current hardening batch is **pending**. Populate immutable identifiers and
results only after the final commit is created and every required gate runs on
that exact commit.

| Field | Evidence |
|-------|----------|
| Candidate commit | Pending final commit |
| Branch/tag | `main`; tag pending |
| GitHub Actions run | Pending |
| Hosted supply-chain audit | Pending if dependency inputs changed |
| Hosted CodeQL | Pending/current scheduled evidence must be linked before a release claim |
| Local `bun run validate:all` | Pending final candidate run |
| Frontend test/coverage/bundle result | Pending; copy exact output/run links, do not estimate counts |
| Rust default/NCP/feature result | Pending; copy exact output/run links, do not estimate counts |
| Manual smoke | Pending target-platform execution |
| Boundary focus | Scene/asset bounds and restore lifecycle; unified camera schemas; ROS service correlation; Gazebo XML policy; transport disconnects; fusion/NCP fail-safe behavior |

## Automated evidence required

| Area | Required evidence | Current status |
|------|-------------------|----------------|
| Version coherence | Metadata/tag guard on candidate | Pending |
| Frontend validation | Typecheck, lint, format, and tests | Pending final candidate |
| Bundle and coverage | Hosted bundle budget and coverage thresholds | Pending final candidate |
| Rust default | fmt, check, tests, and clippy on Linux/macOS | Pending final candidate |
| NCP feature | NCP clippy and tests on Linux/macOS | Pending final candidate |
| Rust feature gates | `cuda,tensorrt` and `--no-default-features` checks | Pending final candidate |
| Supply chain | cargo-deny and `bun audit` | Pending final candidate/dependency run |
| Static analysis | CodeQL JavaScript/TypeScript and Rust | Pending linked evidence |
| Diff hygiene | `git diff --check` before commit and cached diff check | Pending final candidate |

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
