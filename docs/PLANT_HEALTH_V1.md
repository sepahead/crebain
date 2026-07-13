# Inactive Vehicle Health Contract V1

Status: **inactive and unapproved**. This is an in-memory component contract,
not authenticated FCU state or authority evidence.

## Scope

`crebain-plant-authority::health` defines the first closed, dependency-free
vehicle-health value validated in memory by the inert headless plant foundation. It is a
component contract and retained-register boundary only. It has no parser,
transport, FCU connection, source authentication, lifecycle transition,
approved age/state policy, safety verdict, integration with the active command
deadline monitor, governor, authoritative safe-action classifier or approved
policy, or adapter call. A separate
inactive component can compare ages already
captured by its checked reader; see
[`PLANT_FRESHNESS_V1.md`](PLANT_FRESHNESS_V1.md).

A separate safe-action component can look up a caller-proposed opaque situation
code under an exact profile identity; see
[`PLANT_SAFE_ACTION_V1.md`](PLANT_SAFE_ACTION_V1.md). It does not consume this
health report, classify state/triggers, prove that its proposed rows belong to
the profile, or select an operational action. Thus the authoritative
safe-action classifier and approved policy are still absent.

A separate fixed-state deadline component can detect and timestamp a validated
command candidate's absolute receipt-anchored deadline when its worker is
scheduled; see [`PLANT_WATCHDOG_V1.md`](PLANT_WATCHDOG_V1.md). It does not
consume this health report or captured-age assessment, observe lifecycle
autonomously, revoke output, select a safe action, or close the apply-time
health race.

The Tauri application does not link this package. Nothing in this contract can
authorize or apply motion.

## Provenance and lifecycle binding

One channel is fixed for its lifetime to all of the following:

- the exact candidate profile identity, including its ENU or NED semantics;
- one nonzero vehicle identity;
- one nonzero configured health-source identity;
- one nonzero source-stream epoch;
- one process-local runtime generation; and
- one nonzero local-frame-instance identity.

The source identity is a structural digest-sized value. Equality does not
authenticate the source or prove exclusive ownership of an FCU connection. The
local-frame-instance identity can fence silent reuse only when the deployment
supplies a new value after an origin, datum, or simulation-frame reset. This
component neither creates nor verifies that deployment identity.

The publisher is concrete, non-cloneable, and requires mutable access for every
commit. A caller must represent a lifecycle/source reset by constructing a new
context and channel instead of rebinding an existing publisher. Stream sequence
is strictly increasing within one publisher/channel instance bound to the
source epoch; gaps are accepted, rejected reports do not advance the high water
mark, and exhaustion fails closed without wrapping. The API
cannot globally prevent a caller from recreating another channel with the same
epoch identity. Exclusive construction, durable epoch uniqueness, and
anti-rollback across process restart remain unproved.

## Closed report state

Every report explicitly carries schema, profile, vehicle, source, epoch,
sequence, generation, local-frame instance, frame, position unit, velocity
unit, and plant-local observation times. It also carries:

- arming, landed, opaque profile mode, and FCU failsafe state;
- validity of attitude, height, local position, local velocity, global
  position, and home position estimates;
- local position and velocity observations;
- battery remaining fraction;
- fence state; and
- plant-to-FCU, FCU data-link, and offboard-control link state.

Safety-relevant fields are mandatory. Closed `Unknown` states and explicit
unavailability reasons (`NotReported`, `RejectedBySource`, or
`ResetInProgress`) replace older values instead of being rejected and leaving a
nominal-looking snapshot behind. The opaque numeric mode code is retained for a
future approved profile to interpret; this component does not assign generic
safe/unsafe mode names.

Available position and velocity values must be finite and use metres and
metres per second in the profile's exact local frame. Available battery values
must be finite and within `0.0..=1.0`. Signed zero is canonicalized to positive
zero. Health admission applies no telemetry plausibility, speed,
battery-critical, or age-policy limit. Large finite observations and contradictory but structurally
possible state are retained for a later conservative policy to assess.

## Plant-local time

Observation tokens and the internal receipt stamp use `std::time::Instant` and
the bound runtime generation. They are neither FCU time, producer time,
simulation time, nor wall time. Admission rejects an observation from another
generation or after the plant receipt instant. An old but well-formed report is
retained; its age is data for the future governor, not a reason to preserve an
even older snapshot.

One reader load returns a coherent immutable commit and exact ages for receipt,
FCU state, estimator, position, velocity, battery, fence, and links. Missing
state, poisoned storage, generation rotation, and monotonic-clock regression
are explicit errors. Loads never refresh an observation. The separate
captured-read classifier consumes that coherent result and can compare all
eight ages without rereading a clock, but it never establishes current or
apply-time freshness. Platform suspend behavior for the selected monotonic
clock is not yet qualified.

## Captured-read age comparison

`VehicleHealthCapturedAgePolicyV1` binds caller-proposed nonzero exclusive
limits to one exact profile identity. It refuses exact-profile mismatch before
classification. The resulting assessment owns the coherent observation and
borrows the exact policy.
For each age it reports only whether the captured value is strictly below or
at/beyond the exclusive limit; equality is outside.

Those limits are not approved or proven to belong to the profile artifact. The
assessment has no aggregate or boolean health/safety result. A recent
`Unknown` or `Unavailable` value can be within its age limit while remaining
semantically non-nominal. The draft ODD's inclusive local position/velocity
condition of `<=200 ms` is not implemented or translated by this component.

## Atomic boundary and remaining race

The validated snapshot contains only closed value types, fixed arrays, numeric
scalars, identities, and monotonic timestamps. Its fields are private and it
exposes no mutable access or interior-mutable container. One whole snapshot,
including declared context fields, source sequence, values, and all observation times,
replaces the retained commit atomically. A previously loaded commit keeps its
unchanged allocation after replacement.

The generic retained register remains available as low-level channel mechanics,
but the canonical `KernelChannels` health path is the specialized contract and
does not expose its raw sender or receiver. A separately-created generic
register is not the canonical vehicle-health path.

A lifecycle change can still occur after a reader load or captured-age
assessment. Only a future governor that reloads health and checks generation,
approved age/state limits, profile policy, and state
immediately before every FCU write can close that race. Consequently this slice
is partial CB-030/CTL-005/HAZ-006 component evidence; it is not
`TEST-ATOMIC-STATE-STALENESS`, active authority, or L1 completion.

## Deliberately deferred semantics

The following need separately reviewed profile, adapter, deployment, and live
evidence:

- the exact PX4 image, parameters, vehicle, source principal, and profile
  approval;
- FCU mode and estimator-flag interpretation;
- source authentication and proof that timestamps are captured at the real
  observation boundary;
- multi-message aggregation and oldest-constituent time rules;
- local-frame origin/datum issuance and reset detection;
- approved age, battery-critical, fence, failsafe, link, armed/landed, mode,
  aggregate health, and safe-action policy;
- covariance, attitude/quaternions, global coordinates, and transforms;
- current/apply-time generation, age, and state enforcement plus physical safe
  action;
- suspend-inclusive clock qualification and durable restart anti-rollback; and
- ingress, wire schema, evidence pipeline, integration of the active deadline
  monitor, governor, and FCU I/O.

## Verification

```bash
bun run check:plant-boundary
bun run test:plant
bun run clippy:plant
bun run fmt:plant:check
bun run self-check:plant
```

These commands prove component behavior and package isolation only. They do not
exercise SITL, HIL, an authenticated deployment, or a physical vehicle.
