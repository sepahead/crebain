# CREBAIN Engineering Backlog

The next high-leverage engineering tasks after the current stabilization
baseline. Shipped work is recorded in [../CHANGELOG.md](../CHANGELOG.md);
release gates live in [RELEASE_ACCEPTANCE.md](RELEASE_ACCEPTANCE.md).

## Open

| # | Next Step | Primary Outcome |
| - | --------- | --------------- |
| 1 | Validate the experimental MLX YOLOv8 safetensors path with an approved model contract, fixture detections, class mapping, and target-hardware benchmarks | Trustworthy Apple Silicon model evidence |
| 2 | Extend AppHandle-backed negative IPC integration tests beyond `scene_save_file` (mock-runtime tests exist for empty/oversized scene JSON) to `scene_load_file`, scene-path negatives, and the model, transport, and fusion boundaries | Stronger end-to-end IPC evidence |
| 3 | Run ROS/Gazebo/Zenoh multi-frame smoke tests against a target topology | Deployment-specific transport confidence |
| 4 | Add a native detector regression benchmark harness, then extend it to sensor fusion, transport event routing, and position history | Better latency visibility |
| 5 | Execute and archive manual smoke-test results for native launch, diagnostics, scene save/load, and ROS/Zenoh modes | Repeatable release checks |
| 6 | Validate at least one full model contract with fixture frames, class mapping, thresholds, and benchmark context | Trustworthy demo/model evidence |
| 7 | Extract reusable hook-test harness utilities for React root setup, `act`, IPC mocks, and cleanup | Less duplicated test code |
| 8 | Keep tracked Markdown docs synchronized after each behavior, validation, or security-boundary change | Lower onboarding friction |

## Recently completed

- Multi-frame scenario tests for track confirmation (sliding-window M-of-N),
  target motion, and stale-track cleanup.
- CI test-count summaries: the CI workflow writes frontend and Rust test-count
  step summaries.
