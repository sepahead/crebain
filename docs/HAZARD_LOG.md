# Phase 0 Hazard Log

The normative structured log is
[`baselines/phase0-hazards.json`](baselines/phase0-hazards.json). It uses an
STPA-style unsafe-control-action view: an action may be provided when unsafe,
omitted, mistimed/reordered, or applied too long.

## Status semantics

- **open:** required controls or evidence are absent.
- **partial:** some component controls exist, but system/topology evidence is
  incomplete.
- **controlled:** every referenced control is marked verified and covered by
  typed evidence whose test declaration names the same hazard/control IDs. The
  record and its content-hashed JSON artifact must agree on the exact hazard,
  controls, verification command/result, and non-placeholder candidate commit.
  Mere selector text or an existing unrelated path is insufficient.
- **accepted:** residual risk has named approval, rationale, scope, and expiry.

No hazard in this baseline is controlled or accepted. Every P0 entry blocks L1.

| ID | Hazard | Severity | Status | Primary control direction |
|---|---|---|---|---|
| HAZ-001 | Motion through an authority bypass | P0 | open | Sole native applier; exact Gate identity/route; bypass campaign |
| HAZ-002 | Required safe action is lost or omitted | P0 | open | Plant watchdog plus independent FCU failsafe |
| HAZ-003 | Delayed command remains active | P0 | partial | Passive generation-bound monotonic expiry mechanics exist; command admission, active scheduling, apply-time age check, and bounded TTL policy remain absent |
| HAZ-004 | Replay, duplicate, or cross-session command is accepted | P0 | partial | Boot/session/stream fencing and anti-rollback |
| HAZ-005 | Correct vector is applied in the wrong frame or unit | P0 | partial | Profile-neutral same-frame-instance ENU/NED and FLU/FRD velocity-axis corpus exists; frame-instance proof, approved profile, remaining semantics, and live interpretation are absent |
| HAZ-006 | Stale or inconsistent vehicle state authorizes motion | P0 | partial | Closed immutable context-bound snapshot plus profile-bound captured-read exclusive age comparisons exist; authenticated collection, approved limits/state policy, current/apply-time checking, and an aggregate verdict remain absent |
| HAZ-007 | Generic Hold/ESTOP causes an unsafe physical action | P0 | open | ODD/vehicle safe-action matrix and guarded reset |
| HAZ-008 | Router, MAVROS, FCU, or data-link loss leaves unsafe output | P0 | open | Bounded loss detection and independent FCU fallback |
| HAZ-009 | Estimator/fusion divergence appears nominal | P1 | partial | Immutable effective config, exact-time frozen-prior ledger, bounded inputs, invalid-gate refusal, divergence state, conservative invalidation |
| HAZ-010 | Model failure or miscalibration creates an unsafe decision | P1 | open | Signed model contract; calibrated advisory use only |
| HAZ-011 | Missing, censored, stale, or dropped evidence appears nominal | P0 | partial | Producer outcomes/misses/summaries, strict time eligibility, upstream/track-cap loss degradation, sequence gaps, lane counters, and heartbeat semantics exist; wire numeric attribution and receiver enforcement remain absent |
| HAZ-012 | Resource exhaustion starves watchdog or emergency handling | P0 | partial | Inert kernel plus measurement/live-track/assignment/NCP/archive admission bounds exist; JSONL writer blocking, scheduler reservation, and combined-load/deadline timing remain unresolved |
| HAZ-013 | Restart or reconnect resurrects stale authority | P0 | partial | Process-local generation guards and fresh producer epochs exist; durable boot/session anti-rollback and topology restart tests remain absent |
| HAZ-014 | Operator confuses connected/delivered with applied/observed | P1 | open | Controlled vocabulary and distinct authority/effect UX |
| HAZ-015 | Gazebo/local mutation contaminates flight evidence | P1 | partial | Separate binaries, identities, profiles, and evidence labels |
| HAZ-016 | Mission, mode, arm, takeoff, land, or disarm bypasses policy | P0 | open | Typed hazardous-action transaction or exclusion from L1 |
| HAZ-017 | Geofence is crossed despite a numeric clamp | P0 | open | Braking envelope plus independently configured FCU fence |

Controls, causes, ODD clauses, evidence IDs, owners, and residual-risk notes are
kept in the JSON record and checked by the Phase 0 verifier.

The inert headless plant package adds component evidence only. It does not
control HAZ-001/002: there is no FCU write path, watchdog, safe-action table, or
independent failsafe evidence. HAZ-012/013 remain L1-blocking because fixed
channel semantics and process-local generation guards do not prove deadline
scheduling, process-restart uniqueness, or retained-network behavior.
The passive expiry guard narrows HAZ-003 mechanics only: exact-deadline,
generation-rotation, clock-regression, and invalid-TTL cases fail closed. It is
not an active watchdog and does not prove platform suspend behavior,
immediately-before-write coupling, scheduler jitter, or expiry-to-safe-action
latency.

The inactive contract-v1 candidate narrows input ambiguity only. It rejects a
profile/session/version mismatch, non-velocity actions, wrong frame or unit,
invalid requested lifetime, nonfinite components, and draft speed-limit excess.
The profile-neutral frame-convention kernel and digest-bound golden corpus now
cover exact ENU↔NED and FLU↔FRD velocity-axis mappings and reject every
local↔body route without attitude. The canonical local frame and profile remain
unapproved; frame-instance identity and same-origin/datum/body-point proof,
attitude/yaw/quaternions, points/translation, covariance, Three.js,
degrees/radians, time units, authenticated ingress, apply-time enforcement, and
live FCU interpretation remain absent. HAZ-005 is therefore partial, CTL-006
remains planned, and HAZ-016 remains open.

The canonical kernel health path now seals a closed immutable in-memory report,
validates declared profile/vehicle/source/stream-epoch/generation/frame-instance
identity, strict sequence within one publisher/channel instance, local frame,
SI units, plant-local observation times, finite vectors, and battery range, and
atomically exposes one coherent commit plus eight exact ages. A separate
profile-bound classifier consumes that observation, rejects zero limits and
exact-profile mismatch, and reports whether each captured age is strictly below
or at/beyond its caller-proposed exclusive limit. Equality is outside. It does
not read a clock, aggregate the results, interpret unknown/unavailable state,
or implement the draft ODD's inclusive `<=200 ms` position/velocity condition.
Source identity remains
a caller-supplied structural assertion rather than authenticated provenance;
real FCU sampling and aggregation coherence are unproved; channel/epoch
uniqueness across recreation is not enforced; and no approved age/state
policy, current/apply-time freshness, healthy/safe verdict, apply-time consumer, governor, adapter, or FCU
failsafe evidence exists. HAZ-006 and CTL-005 are therefore partial, while
`TEST-PLANT-HEALTH-FRESHNESS-V1` is partial component evidence and
`TEST-ATOMIC-STATE-STALENESS` remains planned.

The Galadriel producer adds component evidence only. It pins one effective
fusion configuration and executable, makes active initialization readiness-only,
freezes one prior per frame, requires exact advancing/per-channel-monotonic time
for v1, bounds measurement magnitudes/cardinalities and live tracks, rejects
invalid internal gate math without fabricated numeric evidence, records ordered
outcomes/misses/summaries, and bounds four drop-new lanes. Renderer/native input
loss retains the newest bounded inputs; registry trimming and whole-cluster
track-capacity rejection latch degraded/truncated frame state. Sparse finite-edge
assignment and maximum all-infinite short-circuit behavior are component-tested.
The producer also exposes sequence gaps and sticky degradation, generates
heartbeats, and uses a fresh randomized process epoch. This narrows
HAZ-009/011/012/013 mechanics, but no P0 hazard is
controlled: there is no deployed Galadriel tap/assembler, registry agreement,
authenticated principal binding, proven router/receiver receive-size policy,
receiver heartbeat deadline, impairment or restart campaign, reserved scheduler
capacity, or combined-load timing trace. The frozen summary also lacks the
numeric upstream/cluster-loss count, so producer logs remain necessary.
Successful local puts are not receiver delivery. Identity-only source-frame
matching does not verify transform/calibration artifacts, and none of this path
joins authority or FCU effect evidence. Active JSONL admission has a separate
capacity-16 drop-new channel; configured `ncp` sinks are startup-preflighted;
batches validate/serialize before their first write; and admission or writer
failure permanently degrades the epoch (writer failure terminates that worker).
Its blocking standard writer can still outlive the two-second exit wait on a
FIFO/device/socket/slow mount, a mid-write OS failure can leave a partial batch,
and archive drops do not have a dedicated health counter. Without an active
producer the blocking fusion job waits for synchronous append/flush.
