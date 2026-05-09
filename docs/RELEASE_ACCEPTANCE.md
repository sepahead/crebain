# CREBAIN Release Acceptance Matrix

This matrix defines evidence required before treating a stabilization batch or release candidate as ready. It is intentionally conservative: performance, ML accuracy, transport latency, and safety claims require measurements from the target environment before they can be promoted from assumptions to release claims.

## Required Evidence

| Area | Acceptance Evidence | Blocking Conditions |
|------|---------------------|---------------------|
| Validation | `bun run validate:all` passes on the release candidate | TypeScript errors, failed frontend tests, failed Rust tests, or clippy warnings with `-D warnings` |
| Documentation Drift | README, AGENTS, CONTRIBUTING, SECURITY, ROS/model docs, and GitHub templates agree on validation commands, backend status, roadmap items, and security boundaries | Stale backend status, stale validation counts, unsupported performance claims, or broken command names |
| Native App Launch | Tauri app launches on the target platform and the diagnostics panel renders system information | Startup crash, missing diagnostics, or unhandled IPC error |
| Detection Diagnostics | Backend availability is reported through `get_system_info`; native detection failures return structured error payloads instead of uncaught frontend exceptions | Missing backend health, uncaught detection error, or misleading diagnostic mode label |
| Model Loading | Model paths are validated; model files, preprocessing, output layout, class mapping, and NMS expectations are documented for the tested model | Unvalidated model path, unknown output tensor contract, or unverified class mapping |
| MLX Status | MLX remains opt-in and documented as experimental until a real YOLOv8 forward pass is implemented and tested | Auto-selecting the scaffold as a normal backend or claiming production inference support |
| Scene Persistence | Scene file path and scene save/load handling reject traversal, non-JSON paths, oversized JSON, and malformed JSON | Path escape, unbounded file size, or malformed scene accepted silently |
| ROS/Zenoh Transport | Transport topic names are validated before backend transport use; event names are deterministic and safe for Tauri event routing | Null/empty/oversized topics accepted or unsafe topic names emitted as raw event names |
| Sensor Fusion | Fusion filters and scenario fixtures pass deterministic smoke/unit coverage | Track lifecycle, fusion stats, or fixture expectations regress |
| Manual Smoke | Manual smoke checklist is executed for native launch, camera setup, diagnostics, scene save/load, and ROS/Zenoh connection states | Any critical path cannot be completed or produces inconsistent diagnostics |
| Security Boundaries | Threat model remains aligned with local files, model loading, ROS URLs, Zenoh topics, and IPC command/event boundaries | New external input path without validation or documentation |
| Performance Claims | Benchmarks are run on the target hardware and model files before any numeric claim is made | Numeric latency/FPS/accuracy claim without reproducible measurement context |

## Release Candidate Gate

A release candidate can be considered for tagging only when:

1. The required automated validation passes.
2. The manual smoke checklist has no unresolved release-blocking findings.
3. Known experimental paths are clearly labeled and do not masquerade as validated capability.
4. Any performance or ML behavior claims cite measured evidence from the release candidate environment.
5. Security-relevant input paths are covered by validation, tests, or an explicit documented limitation.
