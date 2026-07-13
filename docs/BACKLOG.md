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
profile first. The typed non-consuming health-snapshot candidate and its
profile-bound classifier for eight ages captured at one read (CB-030), plus
monotonic receipt/deadline mechanics (CB-027), now exist as inactive component
prerequisites. The classifier's exclusive caller-proposed limits are not an
approved profile policy and do not implement the draft ODD's inclusive
`<=200 ms` condition. An inert CB-028 candidate now provides only exact-profile
lookup from caller-proposed opaque situation codes to a closed intent
vocabulary; its rows are neither profile-content-bound nor an approved
state/trigger matrix. An unwired CB-027 active deadline-monitor candidate now
derives immutable deadlines from validated receipt time, owns one worker and
one active stream slot, and records sticky terminal detection evidence. An
unwired CB-029 observation candidate now loads one coherent health snapshot
before minting one private reference instant for health ages and command receipt
age, but returns no aggregate or authorizing verdict. It also lacks command-to-
health vehicle/frame-instance and content binding. Next define trusted admission/lifecycle
integration and extend that evidence into the immediately-before-write governor;
do not activate either candidate as command authority before the approved
profile, health, state, and TTL policies exist. CB-032 can follow only as a bounded,
observable mock adapter transaction. A process cannot guarantee a final action after
`SIGKILL`, power loss, or total scheduler starvation; the eventual live claim
must combine repeated bounded attempts while alive, immediate output cessation,
and independently attested FCU failsafe behavior.

| ID | Scope | Current disposition |
|---|---|---|
| CB-025 | Small native Rust plant-authority crate/process independent of renderer lifecycle | Implemented and component-tested for this inert slice: separate dependency-free package, inactive command/health/captured-age/apply-observation/safe-action-dispatch candidates, an unwired active deadline-monitor candidate, typed channel/status boundary, and headless self-check; profile approval, wire schemas, and integration topology remain pending later phases |
| CB-026 | Explicit Boot, NoAuthority, Standby, Preflight, AuthorizedHold, Active, Degraded, Emergency, Shutdown state machine | Implemented and transition-tested with process-local generation guards and fail-closed invalid transitions; restart epoch sourcing and ODD/FCU transition preconditions remain pending |
| CB-027 | Plant-local monotonic command-expiry watchdog | Partial component mechanics only: passive expiry remains separate, while a validated candidate can now mint a non-cloneable ticket whose deadline is exactly opaque receipt time plus a nonzero local TTL proposal no greater than the request. The copyable candidate can mint another ticket, so ownership is one slot per monitor rather than global admission. One unwired named worker owns that slot/no queue; replacement requires exact profile/session/generation and a strictly greater sequence, while clock/deadline failure wins before replacement or control and a newer sequence with an older receipt terminalizes. Exact/late deadline, caller-reported generation mismatch, shutdown, poison, and worker-panic terminal evidence is component-tested; poisoned synchronization exposes no exact active key, and worker-start failure retains the initial key plus any precomputed terminal reason. No authenticated admission, global single-monitor enforcement, autonomous lifecycle observation, approved TTL policy, runtime/output coupling, immediately-before-write invalidation, safe action, suspend qualification, reserved scheduler capacity, combined-load timing, or wake-to-effect bound exists. `TEST-PLANT-ACTIVE-DEADLINE-MONITOR-V1` is partial HAZ-003 evidence; CTL-003 and `TEST-PLANT-LOCAL-TTL` remain planned |
| CB-028 | Vehicle/ODD/state-specific safe-action table | Partial structural mechanics only: an inert candidate copies a caller-proposed nonempty unique mapping of opaque nonzero situation codes into an owned fixed 255-slot table, requires an exact full-profile match, returns no default, and exposes only a closed plant-intent vocabulary. The rows are not bound into the supplied profile digest; no authoritative health/state/trigger classifier, precedence, approved vehicle/ODD mapping, lifecycle/time input, action conversion, adapter, or physical-response evidence exists. `TEST-PLANT-SAFE-ACTION-POLICY-V1` is component evidence only; CTL-007 remains planned and HAZ-007 remains open |
| CB-029 | Apply-time profile/frame/unit/envelope/health safety governor | Partial observation mechanics only: after exact-profile and command/lifecycle-generation prechecks, an unwired candidate loads one generation-checked coherent health snapshot, then mints one private plant-monotonic reference instant, computes health ages, and computes command receipt age relative to that instant. It retains the command's strict requested-lifetime relation (equality outside), neutral lifecycle state/generation, and all eight health-age relations. Missing/poisoned/wrong-generation health and health clock regression precede command clock regression; health-policy mismatch follows. Success is evidence only and may contain an expired command, any `PlantState` including `Emergency` or `Shutdown`, stale ages, and unknown/unavailable health. The result has no direct boolean accessor or `From` conversion to `bool` and supplies no aggregate/authorizing verdict, permit, authorization token, command content, velocity, action, output revocation, safe action, adapter operation, I/O, or runtime wiring, though callers can compare facts. The command has no `VehicleIdentity` or `LocalFrameInstanceIdentity`, so matching profile/generation can compose with health for another declared vehicle/frame instance; this is no HAZ-005/HAZ-013 evidence. The observation is remintable and not command-content-bound: matching retained IDs/TTL can describe copyable candidates with different velocity, so they must never pair it to a command as a checked token. It can stale immediately and is not a write-adjacent atomic transaction. `TEST-PLANT-APPLY-OBSERVATION-V1` is prerequisite/component evidence for its declared CTL-003/CTL-005 and HAZ-003/HAZ-006 links, but CTL-003, `TEST-PLANT-LOCAL-TTL`, and `TEST-ATOMIC-STATE-STALENESS` remain planned |
| CB-030 | Atomic typed vehicle-health snapshot | Partial component implementation: the canonical kernel path seals a deeply immutable closed report, validates declared profile/vehicle/source/stream-epoch/generation/frame-instance identity, strict per-channel source sequence, local frame, SI units, plant-local observation times, finite vectors, and battery range, then atomically retains the coherent state and exposes eight exact ages from one read. A separate profile-bound classifier consumes that observation, rejects zero limits or exact-profile mismatch, and applies caller-proposed exclusive limits without an aggregate verdict. Generic snapshot mechanics remain disconnected. The separate apply-check observation candidate now loads one coherent health snapshot before minting the common reference instant for its health and command ages, but the ticket stays partial because the limits/profile are unapproved and do not implement the draft ODD's inclusive `<=200 ms` condition; the command carries no vehicle or frame-instance identity to bind it to that snapshot; source identity is unauthenticated; real FCU collection and multi-message coherence are unproved; channel recreation/durable epoch uniqueness are not enforced; and no approved state policy, authorizing immediately-before-write governor, or adapter exists |
| CB-031 | Bounded ingress/latest-command/health/output/evidence paths and overflow policies | Implemented and component-tested: validated non-eager capacities, latest-value, reject-new lifecycle, drop-oldest evidence, exact loss accounting, poison/counter fail-closed behavior, post-unlock destruction, and a separate non-overwritable safety path; the one-worker deadline monitor is unwired and does not prove globally bounded monitor count, reserved scheduling, or integrated-load timing |
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

- Unwired single-reference-instant apply-check observation candidate: one
  generation-checked coherent health snapshot is loaded before one private
  plant-monotonic reference instant is minted. Health ages and then command age
  are evaluated relative to that instant. Exact context mismatch, clock
  regression, and unavailable or invalid health reads fail. Lifecycle state
  remains neutral, and successful evidence can contain an expired command,
  `Emergency` or `Shutdown`, stale ages, and unknown/unavailable health. There
  is no direct boolean accessor/`From` conversion or aggregate/authorizing
  verdict, permit, authority, command content, output operation, adapter, or
  runtime coupling, although callers can compare facts. The command lacks
  vehicle/frame-instance identity, and the remintable observation is not
  command-content-bound; matching retained IDs/TTL must never pair it to a
  command as a checked token. It can stale immediately and is not a write-
  adjacent atomic transaction. This is partial CB-029/CTL-005/HAZ-003/HAZ-006
  component evidence and a prerequisite link to CTL-003; CTL-003,
  `TEST-PLANT-LOCAL-TTL`, and `TEST-ATOMIC-STATE-STALENESS` remain planned.
- Unwired receipt-anchored active deadline-monitor candidate: a validated
  command can mint an immutable non-cloneable ticket with a local TTL no greater
  than its request; the copyable candidate can remint one, so ownership is local
  to each monitor. One long-lived worker owns one active slot and accepts only
  exact-profile/session/generation, strictly increasing replacements; deadline
  and fault terminal evidence is sticky. This is partial CB-027/HAZ-003
  component evidence, not trusted admission, an operational watchdog, apply-time
  output invalidation, safe action, scheduling/latency qualification, or CTL-003.
- Inactive safe-action situation-dispatch candidate: caller-proposed opaque
  nonzero codes can be copied into a fixed owned no-default table whose lookup
  requires an exact full profile identity and returns one of five closed plant
  intents. Empty, oversized, duplicate, missing, and cross-profile cases fail
  closed. The profile does not content-bind the rows, and callers still supply
  the situation classification. This is partial CB-028 component evidence, not
  an approved state/trigger matrix, precedence policy, current health decision,
  operational action, adapter transaction, or closure of CTL-007/HAZ-007.
- Inactive vehicle-health contract v1: a closed immutable in-memory report and
  non-cloneable single-writer channel bind declared context identity, strict
  per-channel sequence, local frame/SI values, explicit unknown/unavailable state, and
  plant-monotonic ages into one retained commit. A separate profile-bound
  captured-read classifier now keeps that observation attached to named
  nonzero exclusive limits and classifies all eight ages without a boolean or
  aggregate verdict. The limits are unapproved, equality is outside, and this
  does not implement the draft ODD's inclusive `<=200 ms` condition. This is partial
  CB-030/CTL-005/HAZ-006 component evidence, not authenticated FCU state,
  an approved state policy, an immediately-before-write check, apply-time safety,
  or L1 authority.
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
  deadline-monitor runtime integration, adapter, or action authority.
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
