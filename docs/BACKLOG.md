# CREBAIN Engineering Backlog

The next high-leverage engineering tasks after the current stabilization
baseline. Shipped work is recorded in [../CHANGELOG.md](../CHANGELOG.md);
release gates live in [RELEASE_ACCEPTANCE.md](RELEASE_ACCEPTANCE.md).

## Open

### Phase 2 — native plant authority

The first component slice is present, but the system remains L0. “Implemented”
below means source plus local component tests, not integrated authority or
hazard closure.

| ID | Scope | Current disposition |
|---|---|---|
| CB-025 | Small native Rust plant-authority crate/process independent of renderer lifecycle | Implemented and component-tested for this inert slice: separate dependency-free package, typed generic channel/status boundary, and headless self-check; a real command schema and integration topology remain pending later phases |
| CB-026 | Explicit Boot, NoAuthority, Standby, Preflight, AuthorizedHold, Active, Degraded, Emergency, Shutdown state machine | Implemented and transition-tested with process-local generation guards and fail-closed invalid transitions; restart epoch sourcing and ODD/FCU transition preconditions remain pending |
| CB-027 | Plant-local monotonic command-expiry watchdog | Pending; no command clock, apply-time write, deadline, or kill/freeze evidence exists |
| CB-028 | Vehicle/ODD/state-specific safe-action table | Pending; the first-cause latch records a component safety cause but selects no physical response |
| CB-029 | Apply-time profile/frame/unit/envelope/health safety governor | Pending |
| CB-030 | Atomic typed vehicle-health snapshot | Pending; the typed latest-health channel is storage plumbing only |
| CB-031 | Bounded ingress/latest-command/health/output/evidence paths and overflow policies | Implemented and component-tested: validated non-eager capacities, latest-value, reject-new lifecycle, drop-oldest evidence, exact loss accounting, poison/counter fail-closed behavior, post-unlock destruction, and a separate non-overwritable safety path; this does not prove future watchdog scheduling under integrated load |
| CB-032 | Cancellation-safe, deadline-bounded callbacks/shutdown/final safe action | Pending; inert adapter stop is idempotent but there is no external call, repeated safe transaction, FCU observation, or process-loss fallback |

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
