# CREBAIN Release Evidence Log

This log records release-readiness evidence for stabilization batches. It does not replace the acceptance matrix, model contracts, manual smoke checklist, or security policy.

## Current Candidate

| Field | Evidence |
|-------|----------|
| Validated code baseline | Current MLX/rosbridge/fusion hardening candidate |
| Branch | `main` |
| Remote CI run | GitHub Actions run `25701811000` for `sepehrmn/crebain` passed before the final evidence-pointer doc update |
| Local validation | `bun run validate:all` passed locally on this candidate |
| Frontend local result | 200 tests passed, 8 benchmark tests skipped by default |
| Rust local result | 138 tests passed, 0 failed; clippy passed with `-D warnings` |
| Boundary focus | MLX safetensors checksum validation + forward profiling, rosbridge WebSocket fallback/service calls, Gazebo spawn IPC validation, scene schema migration, radar/lidar polar fusion, benchmark budgets, transport/model/fusion guardrails |

## Automated Evidence Required

| Area | Required Evidence | Current Status |
|------|-------------------|----------------|
| Hosted CI | Frontend and Rust matrix jobs pass on GitHub Actions | Passed in run `25701811000` |
| Frontend validation | `bun run validate` passes | Passed locally; CI summary records test counts |
| Full local validation | `bun run validate:all` passes | Passed locally |
| Diff hygiene | `git diff --check` and `git diff --cached --check` pass | Passed before commit |

## Manual Evidence Required

| Area | Required Evidence | Current Status |
|------|-------------------|----------------|
| Native app launch | Tauri app launches and diagnostics render | Requires manual smoke execution |
| Scene save/load | Valid scene saves/loads and malformed scenes are rejected | Automated boundary tests exist; manual smoke still required |
| ROS/Zenoh topology | Target deployment topics, events, publish paths, and disconnect behavior are exercised | Requires target ROS/Gazebo/Zenoh environment |
| Model contract | At least one externally supplied model has provenance, tensor contract, fixture detections, and benchmark context | Requires selected model artifact and fixture frames |
| Performance claims | Latency/FPS/accuracy claims cite target hardware and command context | Not claimed without measurements |

## Blocked External Evidence

The following roadmap items cannot be honestly completed from repository files alone:

- Hardware-in-the-loop validation requires target vehicles/simulation hardware.
- Real PX4/ArduPilot integration requires a configured autopilot stack.
- Zenoh-TLS/encrypted deployment evidence requires certificate and topology configuration.
- Full model-contract validation requires an approved model file, rights/provenance, and fixture frames.
- Manual smoke results require an operator to launch and inspect the app in the target shell.

## Related Documents

- `docs/RELEASE_ACCEPTANCE.md`
- `docs/MODEL_CONTRACTS.md`
- `docs/MANUAL_SMOKE_TEST.md`
- `SECURITY.md`
