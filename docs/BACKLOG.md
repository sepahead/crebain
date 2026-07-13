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
number. An inactive contract-v1 candidate now defines closed command/frame/unit/time/profile
types and draft instantaneous-speed/TTL rejection, but the profile artifact and canonical
local frame remain unapproved. A profile-neutral digest-bound corpus now covers
the exact same-frame-instance ENU/NED and FLU/FRD velocity-axis prerequisite
but carries no origin/datum/body-point identity and deliberately omits profile
selection and attitude-dependent conversion. Approve and pin the full
profile first; add a typed
non-consuming atomic health snapshot (CB-030); then monotonic receipt and
deadline primitives (CB-027), the profile-driven safe-action selector (CB-028),
and the apply-time governor (CB-029). CB-032 can follow only as a bounded,
observable mock transaction. A process cannot guarantee a final action after
`SIGKILL`, power loss, or total scheduler starvation; the eventual live claim
must combine repeated bounded attempts while alive, immediate output cessation,
and independently attested FCU failsafe behavior.

| ID | Scope | Current disposition |
|---|---|---|
| CB-025 | Small native Rust plant-authority crate/process independent of renderer lifecycle | Implemented and component-tested for this inert slice: separate dependency-free package, inactive contract-v1 candidate, typed generic channel/status boundary, and headless self-check; profile approval, a wire schema, and integration topology remain pending later phases |
| CB-026 | Explicit Boot, NoAuthority, Standby, Preflight, AuthorizedHold, Active, Degraded, Emergency, Shutdown state machine | Implemented and transition-tested with process-local generation guards and fail-closed invalid transitions; restart epoch sourcing and ODD/FCU transition preconditions remain pending |
| CB-027 | Plant-local monotonic command-expiry watchdog | Partial component mechanics only: contract v1 structurally bounds requested TTL and separates producer from local receipt time; an immutable generation-bound local `Instant` guard rejects zero TTL, an unrepresentable deadline, clock regression, stale generation, and the exact deadline. The ticket remains pending behind profile approval and CB-030; no command admission, active scheduling, apply-time write coupling, suspend qualification, scheduler-jitter, or kill/freeze evidence exists |
| CB-028 | Vehicle/ODD/state-specific safe-action table | Pending; the first-cause latch records a component safety cause but selects no physical response |
| CB-029 | Apply-time profile/frame/unit/envelope/health safety governor | Pending |
| CB-030 | Atomic typed vehicle-health snapshot | Partial component mechanics only: a generic non-consuming retained register atomically associates one whole `Arc`-backed value with caller-supplied lifecycle generation and exact sequence; repeated loads preserve prior allocations, concurrent replacements stay coherent for the tested plain-data value, and poison/closure/counter exhaustion fail closed. The generic API neither prevents interior mutation exposed by `T` nor validates generation order. The ticket remains pending because no authoritative FCU health schema, provenance, frame/unit/time contract, freshness policy, or apply-time check exists |
| CB-031 | Bounded ingress/latest-command/health/output/evidence paths and overflow policies | Implemented and component-tested: validated non-eager capacities, latest-value, reject-new lifecycle, drop-oldest evidence, exact loss accounting, poison/counter fail-closed behavior, post-unlock destruction, and a separate non-overwritable safety path; this does not prove future watchdog scheduling under integrated load |
| CB-032 | Cancellation-safe, deadline-bounded callbacks/shutdown/final safe action | Pending; inert adapter stop is idempotent but there is no external call, repeated bounded safe transaction, FCU observation, or independent process-loss fallback; do not claim an in-process final action after process death |

| # | Next Step | Primary Outcome |
| - | --------- | --------------- |
| 1 | Validate the experimental MLX YOLOv8 safetensors path with an approved model contract, fixture detections, class mapping, and target-hardware benchmarks | Trustworthy Apple Silicon model evidence |
| 3 | Run ROS/Gazebo/Zenoh multi-frame smoke tests against a target topology | Deployment-specific transport confidence |
| 4 | Establish approved native-detector target baselines/thresholds, then extend the harness to sensor fusion, transport event routing, and position history | Harness mechanics exist; target evidence and wider coverage remain open |
| 5 | Execute and archive manual smoke-test results for native launch, diagnostics, scene save/load, and ROS/Zenoh modes | Repeatable release checks |
| 6 | Validate at least one full model contract with fixture frames, class mapping, thresholds, and benchmark context | Trustworthy demo/model evidence |
| 7 | Extract reusable hook-test harness utilities for React root setup, `act`, IPC mocks, and cleanup | Less duplicated test code |
| 8 | Keep tracked Markdown docs synchronized after each behavior, validation, or security-boundary change | Lower onboarding friction |
| 9 | Deploy a Galadriel tap/monitor/cross-route assembler that pins the same registry and proves decode, identity, sequence-gap, and heartbeat-deadline behavior | Receiver-side evidence rather than producer-only puts |
| 10 | Audit real NCP TLS/mTLS identities, certificates, router topology, principal↔`producer_id` binding, and exact allow/deny ACLs for both evidence keys | Deployment security evidence |
| 11 | Run multi-process loss/reorder/duplicate/restart/partition/queue-saturation/slow-put/shutdown campaigns and archive both producer and receiver traces | HAZ-011/012/013 evidence and heartbeat-timeliness bounds |
| 12 | Implement and verify registry calibration/transform/projection artifacts before allowing non-identity common projection | Frame/calibration evidence beyond string equality |
| 13 | Qualify PID JSONL storage: enforce/verify regular-local-file policy, test the active capacity-16 archive boundary, expose archive-specific drop health, and define cleanup for a writer blocked beyond the two-second exit wait | Bounded archival behavior without confusing producer degradation or task shutdown claims |
| 14 | Extend the frozen monitor contract and receiver to carry/validate numeric malformed, renderer-buffer, registry-trim, and track-capacity loss without weakening degraded/truncated semantics | Receiver-visible upstream-loss attribution rather than log-only counts |
| 15 | Establish router/receiver sidecar and monitor receive-size ceilings, then run oversize allow/deny tests with the exact deployment topology | Proof that every permitted envelope is accepted or explicitly rejected before operation |
| 16 | Benchmark sparse-assignment, maximum-batch/live-track, lane-saturation, slow-put, and JSONL interaction under one candidate process and receiver | Combined-load deadline evidence beyond component complexity tests |

## Recently completed

- Profile-neutral frame-conventions v1: dependency-free Rust and JavaScript
  independently evaluate one digest-bound 32-case m/s corpus for identity,
  ENU↔NED, and FLU↔FRD velocity axes; all local↔body routes reject without
  attitude. Exact permutations require the same local origin/datum or body
  point, which the values do not carry or prove. This is partial HAZ-005
  component evidence, not profile approval, complete CTL-006 coverage,
  admission, or live FCU interpretation.
- Inactive plant contract-v1 candidate: closed profile/action/frame/unit types,
  distinct producer/local time, draft TTL and instantaneous-speed validation, and
  stable negative reasons. It has no parser, ingress, approval, health gate,
  watchdog, adapter, or action authority.
- Native detector benchmark mechanics: bounded release-command inputs,
  content-identified model/fixture/runtime context, raw sequential call samples,
  trusted-baseline digest binding, p95 comparison, atomic no-overwrite reports,
  and all-target logic tests. No approved model, target run, baseline, threshold,
  or numeric claim exists.
- Backlog item 2: the production Tauri handler list is reused by a serialized
  mock-runtime IPC harness. Negative invoke requests now cover scene save/load
  payload, path, UTF-8, parse, absence, and size failures; detector/fusion
  deserialization and bounds; and validation-before-connection for every
  topic-bearing transport command.
- Feature/runtime-gated Galadriel producer component: strict canonical registry,
  immutable actual effective-config and executable digest pins, readiness-only
  active initialization, frozen sidecar/monitor codecs, deterministic exact-time
  frozen-prior ledger, bounded measurement/track domains, newest-preserving
  upstream admission, whole-cluster track-cap rejection, sparse assignment,
  bounded drop/degradation lanes, heartbeats, finite task shutdown, and a
  preflighted capacity-16 JSONL archive whose batches validate/serialize before
  writing and whose I/O failure degrades the epoch and stops the worker. This is
  not a deployed receiver, TLS/ACL/receive-size, deadline, combined-load,
  calibration, or authority claim.
- Multi-frame scenario tests for track confirmation (sliding-window M-of-N),
  target motion, and stale-track cleanup.
- CI test-count summaries: the CI workflow writes frontend and Rust test-count
  step summaries.
