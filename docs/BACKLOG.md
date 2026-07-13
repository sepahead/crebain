# CREBAIN Engineering Backlog

The next high-leverage engineering tasks after the current stabilization
baseline. Shipped work is recorded in [../CHANGELOG.md](../CHANGELOG.md);
release gates live in [RELEASE_ACCEPTANCE.md](RELEASE_ACCEPTANCE.md).

## Open

### Phase 2 — native plant authority

The first component slice is present, but the system remains L0. “Implemented”
below means source plus local component tests, not integrated authority or
hazard closure.

The remaining rows are dependency-ordered by safety semantics, not by ticket
number: define versioned command/frame/unit/time/profile types first; add a
typed non-consuming atomic health snapshot (CB-030); then monotonic receipt and
deadline primitives (CB-027), the profile-driven safe-action selector (CB-028),
and the apply-time governor (CB-029). CB-032 can follow only as a bounded,
observable mock transaction. A process cannot guarantee a final action after
`SIGKILL`, power loss, or total scheduler starvation; the eventual live claim
must combine repeated bounded attempts while alive, immediate output cessation,
and independently attested FCU failsafe behavior.

| ID | Scope | Current disposition |
|---|---|---|
| CB-025 | Small native Rust plant-authority crate/process independent of renderer lifecycle | Implemented and component-tested for this inert slice: separate dependency-free package, typed generic channel/status boundary, and headless self-check; a real command schema and integration topology remain pending later phases |
| CB-026 | Explicit Boot, NoAuthority, Standby, Preflight, AuthorizedHold, Active, Degraded, Emergency, Shutdown state machine | Implemented and transition-tested with process-local generation guards and fail-closed invalid transitions; restart epoch sourcing and ODD/FCU transition preconditions remain pending |
| CB-027 | Plant-local monotonic command-expiry watchdog | Partial component mechanics only: an immutable generation-bound local `Instant` guard rejects zero TTL, an unrepresentable deadline, clock regression, stale generation, and the exact deadline. The ticket remains pending behind versioned command/time/profile types and CB-030; no command admission, active scheduling, apply-time write coupling, suspend qualification, scheduler-jitter, or kill/freeze evidence exists |
| CB-028 | Vehicle/ODD/state-specific safe-action table | Pending; the first-cause latch records a component safety cause but selects no physical response |
| CB-029 | Apply-time profile/frame/unit/envelope/health safety governor | Pending |
| CB-030 | Atomic typed vehicle-health snapshot | Partial component mechanics only: a generic non-consuming retained register atomically associates one whole `Arc`-backed value with caller-supplied lifecycle generation and exact sequence; repeated loads preserve prior allocations, concurrent replacements stay coherent for the tested plain-data value, and poison/closure/counter exhaustion fail closed. The generic API neither prevents interior mutation exposed by `T` nor validates generation order. The ticket remains pending because no authoritative FCU health schema, provenance, frame/unit/time contract, freshness policy, or apply-time check exists |
| CB-031 | Bounded ingress/latest-command/health/output/evidence paths and overflow policies | Implemented and component-tested: validated non-eager capacities, latest-value, reject-new lifecycle, drop-oldest evidence, exact loss accounting, poison/counter fail-closed behavior, post-unlock destruction, and a separate non-overwritable safety path; this does not prove future watchdog scheduling under integrated load |
| CB-032 | Cancellation-safe, deadline-bounded callbacks/shutdown/final safe action | Pending; inert adapter stop is idempotent but there is no external call, repeated bounded safe transaction, FCU observation, or independent process-loss fallback; do not claim an in-process final action after process death |

| # | Next Step | Primary Outcome |
| - | --------- | --------------- |
| 1 | Validate the experimental MLX YOLOv8 safetensors path with an approved model contract, fixture detections, class mapping, and target-hardware benchmarks | Trustworthy Apple Silicon model evidence |
| 3 | Run ROS/Gazebo/Zenoh multi-frame smoke tests against a target topology | Deployment-specific transport confidence |
| 4 | Add a native detector regression benchmark harness, then extend it to sensor fusion, transport event routing, and position history | Better latency visibility |
| 5 | Execute and archive manual smoke-test results for native launch, diagnostics, scene save/load, and ROS/Zenoh modes | Repeatable release checks |
| 6 | Validate at least one full model contract with fixture frames, class mapping, thresholds, and benchmark context | Trustworthy demo/model evidence |
| 7 | Extract reusable hook-test harness utilities for React root setup, `act`, IPC mocks, and cleanup | Less duplicated test code |
| 8 | Keep tracked Markdown docs synchronized after each behavior, validation, or security-boundary change | Lower onboarding friction |

## Recently completed

- Backlog item 2: the production Tauri handler list is reused by a serialized
  mock-runtime IPC harness. Negative invoke requests now cover scene save/load
  payload, path, UTF-8, parse, absence, and size failures; detector/fusion
  deserialization and bounds; and validation-before-connection for every
  topic-bearing transport command.
- Multi-frame scenario tests for track confirmation (sliding-window M-of-N),
  target motion, and stale-track cleanup.
- CI test-count summaries: the CI workflow writes frontend and Rust test-count
  step summaries.
