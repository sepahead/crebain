# CREBAIN Release Acceptance Matrix

This matrix defines the evidence required before a stabilization batch, demo build, or release candidate can be treated as ready. It is intentionally conservative: performance, ML accuracy, transport latency, and safety claims require measurements from the target environment before they can be promoted from assumptions to release claims.

## Required Evidence

| Area | Acceptance Evidence | Blocking Conditions |
|------|---------------------|---------------------|
| Automated Validation | `bun run validate:all` passes on the release candidate | TypeScript errors, failed frontend tests, failed Rust tests, or clippy warnings with `-D warnings` |
| Documentation Drift | README, AGENTS, CONTRIBUTING, SECURITY, ROS/model docs, GitHub templates, and workflows agree on validation commands, backend status, roadmap items, and security boundaries | Stale backend status, stale validation counts, unsupported performance claims, or broken command names |
| Native App Launch | Tauri app launches on the target platform and the diagnostics panel renders system information | Startup crash, missing diagnostics, or unhandled IPC error |
| Detection Diagnostics | Backend availability is reported through `get_system_info`; native detection failures return structured error payloads instead of uncaught frontend exceptions | Missing backend health, uncaught detection error, or misleading diagnostic mode label |
| Model Loading | Model paths are validated; model files, preprocessing, output layout, class mapping, TensorRT build inputs, MLX safetensors inputs, and NMS expectations are documented for the tested model | Unvalidated model path, unknown output tensor contract, unsupported INT8/build mode, invalid MLX safetensors path, or unverified class mapping |
| MLX Status | MLX remains opt-in and documented as experimental until the implemented YOLOv8 safetensors path is validated with an approved external model contract and target-hardware benchmarks | Auto-selecting MLX as a normal backend or claiming production inference support without model-contract and benchmark evidence |
| Scene Persistence | Scene file path and scene save/load handling reject traversal, non-JSON paths, oversized JSON, and malformed JSON | Path escape, unbounded file size, or malformed scene accepted silently |
| ROS/Zenoh Transport | ROS graph inputs, transport topic names, Zenoh topics, transport publish payloads, event names, and CDR payload metadata are validated before use | Null/empty/oversized topics, malformed CDR metadata, non-finite publish payloads, or unsafe event names accepted |
| Sensor Fusion | Fusion config, measurement batches, track output, and stats pass deterministic smoke/unit coverage | Invalid config accepted, unbounded track/measurement growth, or stale track lifecycle regressions |
| Manual Smoke | Manual smoke checklist is executed for native launch, camera setup, diagnostics, scene save/load, and ROS/Zenoh connection states | Any critical path cannot be completed or produces inconsistent diagnostics |
| Security Boundaries | Threat model remains aligned with local files, model loading, ROS URLs, Zenoh topics, CDR payloads, and IPC command/event boundaries | New external input path without validation or documentation |
| Performance Claims | Benchmarks are run on the target hardware and model files before any numeric claim is made | Numeric latency/FPS/accuracy claim without reproducible measurement context |

## Release Candidate Gate

A release candidate can be considered for tagging only when:

1. Required automated validation passes.
2. The manual smoke checklist has no unresolved release-blocking findings.
3. Known experimental paths are clearly labeled and do not masquerade as validated capability.
4. Any performance or ML behavior claim cites measured evidence from the release candidate environment.
5. Security-relevant input paths are covered by validation, tests, or an explicit documented limitation.
