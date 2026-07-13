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
| HAZ-003 | Delayed command remains active | P0 | partial | Passive expiry, an unwired receipt-anchored one-worker/one-slot active deadline monitor, and a post-health-load single-reference-instant requested-lifetime observation exist; trusted admission, command-content binding, output invalidation, approved TTL policy, an immediately-before-write check, scheduler/latency evidence, and safe action remain absent |
| HAZ-004 | Replay, duplicate, or cross-session command is accepted | P0 | partial | Boot/session/stream fencing and anti-rollback |
| HAZ-005 | Correct vector is applied in the wrong frame or unit | P0 | partial | Profile-neutral same-frame-instance ENU/NED and FLU/FRD velocity-axis corpus exists; the apply observation adds no evidence because its command has no local-frame-instance identity; frame-instance proof, approved profile, remaining semantics, and live interpretation are absent |
| HAZ-006 | Stale or inconsistent vehicle state authorizes motion | P0 | partial | Closed immutable context-bound snapshot, profile-bound captured-read exclusive age comparisons, and an unwired post-health-load single-reference-instant command/health age observation exist; authenticated collection, same-vehicle/frame and command-content binding, approved limits/state policy, an immediately-before-write check, and an aggregate/authorizing verdict remain absent |
| HAZ-007 | Generic Hold/ESTOP causes an unsafe physical action | P0 | open | ODD/vehicle safe-action matrix and guarded reset; an opaque no-default dispatch candidate exists but does not classify state or approve a physical response |
| HAZ-008 | Router, MAVROS, FCU, or data-link loss leaves unsafe output | P0 | open | Bounded loss detection and independent FCU fallback |
| HAZ-009 | Estimator/fusion divergence appears nominal | P1 | partial | Immutable effective config, exact-time frozen-prior ledger, bounded inputs, invalid-gate refusal, divergence state, conservative invalidation |
| HAZ-010 | Model failure or miscalibration creates an unsafe decision | P1 | open | Signed model contract; calibrated advisory use only |
| HAZ-011 | Missing, censored, stale, or dropped evidence appears nominal | P0 | partial | Producer outcomes/misses/summaries, strict time eligibility, upstream/track-cap loss degradation, sequence gaps, lane counters, and heartbeat semantics exist; wire numeric attribution and receiver enforcement remain absent |
| HAZ-012 | Resource exhaustion starves watchdog or emergency handling | P0 | partial | One monitor owns one worker/slot, and other kernel/data bounds exist; global monitor count, JSONL blocking, scheduler reservation, and combined-load/deadline timing remain unresolved |
| HAZ-013 | Restart or reconnect resurrects stale authority | P0 | partial | Process-local generation guards, caller-reported monitor generation mismatch, and fresh producer epochs exist; the apply observation adds no evidence because generation equality neither binds its command to the health vehicle/frame instance nor proves durable currentness; autonomous rotation observation, durable boot/session anti-rollback, and topology restart tests remain absent |
| HAZ-014 | Operator confuses connected/delivered with applied/observed | P1 | open | Controlled vocabulary and distinct authority/effect UX |
| HAZ-015 | Gazebo/local mutation contaminates flight evidence | P1 | partial | Separate binaries, identities, profiles, and evidence labels |
| HAZ-016 | Mission, mode, arm, takeoff, land, or disarm bypasses policy | P0 | open | Typed hazardous-action transaction or exclusion from L1 |
| HAZ-017 | Geofence is crossed despite a numeric clamp | P0 | open | Braking envelope plus independently configured FCU fence |

Controls, causes, ODD clauses, evidence IDs, owners, and residual-risk notes are
kept in the JSON record and checked by the Phase 0 verifier.

The inert headless plant package adds component evidence only. It does not
control HAZ-001/002: there is no FCU write path, output-coupled operational
watchdog, authoritative safe-action classifier, approved/content-bound policy,
or independent failsafe evidence. HAZ-012/013 remain L1-blocking because one
worker per monitor and process-local generation guards do not prove globally
bounded instances, reserved scheduling, autonomous lifecycle observation,
process-restart uniqueness, or retained-network behavior.
The passive expiry guard narrows HAZ-003 mechanics only: exact-deadline,
generation-rotation, clock-regression, and invalid-TTL cases fail closed. It is
not an active watchdog and does not prove platform suspend behavior,
immediately-before-write coupling, scheduler jitter, or expiry-to-safe-action
latency.

The separate active deadline-monitor candidate narrows HAZ-003 further. A
ticket derives its immutable absolute deadline from the validated command's
opaque receipt time and a nonzero local TTL proposal no greater than the
request. One named worker owns one active slot/no queue; replacement requires
the same exact profile/session/generation and a strictly greater sequence.
Current clock regression or exact/past deadline wins before replacement,
shutdown, or a caller-reported generation mismatch; a newer sequence with an
older receipt terminalizes rather than leaving the active command armed. The
copyable candidate can mint another non-cloneable ticket, so ownership is local
to a monitor rather than global admission. Deadline age/lateness, poison,
worker panic, reported mismatch, and shutdown become sticky terminal evidence;
poisoned synchronization makes no exact active-key claim. The
component is unwired: it does not authenticate admission,
prevent multiple monitor instances, observe lifecycle rotation autonomously,
invalidate output at apply time, select/apply a safe action, qualify suspend
behavior, reserve scheduler capacity, or prove wake-to-effect latency. Thus
CB-027 and HAZ-003 remain partial, CTL-003 remains planned, and
`TEST-PLANT-LOCAL-TTL` remains planned.

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
policy, healthy/safe verdict, authorizing immediately-before-write
consumer/governor, adapter, or FCU failsafe evidence exists. HAZ-006 and
CTL-005 are therefore partial, while
`TEST-PLANT-HEALTH-FRESHNESS-V1` is partial component evidence and
`TEST-ATOMIC-STATE-STALENESS` remains planned.

The unwired apply-check observation candidate advances only the composition
prerequisite shared by HAZ-003 and HAZ-006. After the profile and generation
prechecks it loads one generation-checked coherent health snapshot, then mints
one private plant-monotonic reference instant. Health ages and command receipt
age are evaluated relative to that same instant, in that order. The evidence
retains a strict requested-lifetime relation with equality outside, lifecycle
state/generation without interpreting that state, and all eight health-age
relations. Exact profile or command/lifecycle
generation mismatch precedes the health load; missing/poisoned/wrong-generation
health and health clock regression precede command clock regression, followed
by health-policy mismatch. An
`Ok` observation is deliberately not a safety result: it may contain an expired
command, any `PlantState` including `Emergency` or `Shutdown`, stale ages, and
unknown/unavailable health. It has no direct boolean accessor or `From`
conversion to `bool` and supplies no aggregate/authorizing verdict, permit,
authorization token, command content, velocity, action, output revocation, safe
action, adapter operation, I/O, or runtime wiring, although callers can compare
its facts. The command carries no `VehicleIdentity` or
`LocalFrameInstanceIdentity`; matching profile/generation can therefore compose
with health from another declared vehicle/frame instance and supplies no
HAZ-005/HAZ-013 evidence. The observation is remintable, and matching retained
IDs/TTL do not content-bind it to a command because copyable candidates can
carry different velocity. It must never be paired by those fields as a checked
token. Because it can stale immediately and is not a write-adjacent atomic
transaction, it does not satisfy CTL-003 or either planned end-to-end test.
CB-029, CTL-005, HAZ-003, and HAZ-006 remain partial;
`TEST-PLANT-APPLY-OBSERVATION-V1` is prerequisite/component evidence for the
declared CTL-003/CTL-005 links, but CTL-003 remains planned and unsatisfied;
`TEST-PLANT-LOCAL-TTL` and `TEST-ATOMIC-STATE-STALENESS` remain planned.

The separate safe-action situation-dispatch candidate narrows only part of the
CB-028 representation mechanics. It owns a fixed table copied from
caller-proposed unique nonzero opaque codes, requires an exact full profile
match, has no default row, and returns a closed plant intent rather than a
contract action. That profile identity does not content-bind the supplied
rows. The candidate has no authoritative state or trigger classifier, overlap
precedence, health/lifecycle/time input, approval, action conversion, adapter,
or effect observation. It therefore cannot establish that Hold, Land, RTL,
inhibit, or ground disarm is safe in a situation. HAZ-007 and HAZ-002 remain
open, HAZ-016 remains open, CTL-007 remains planned, and
`TEST-PLANT-SAFE-ACTION-POLICY-V1` is partial component evidence only.

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
