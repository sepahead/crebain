# Inactive Captured-Read Vehicle-Health Age Classifier V1

Status: **inactive and unapproved**. This is an age-comparison component, not
an approved freshness policy, a health or safety verdict, an apply-time gate,
or authority evidence.

## Scope

`crebain-plant-authority::freshness` compares the eight ages already captured
inside one checked [`ObservedVehicleHealthV1`](../src-tauri/crates/plant-authority/src/health.rs)
read:

- local receipt;
- FCU state;
- estimator;
- local position;
- local velocity;
- battery;
- fence; and
- links.

The classifier does not read a clock, load health, authenticate a source,
interpret FCU state, transition lifecycle, classify a safe-action situation,
or call an adapter. A separate inert no-default candidate can look up an opaque
caller-supplied situation code, but it does not consume this assessment or
establish an approved state-to-action mapping; see
[`PLANT_SAFE_ACTION_V1.md`](PLANT_SAFE_ACTION_V1.md). The Tauri application does
not link the plant package. Nothing in either component can authorize or apply
motion.

The separate active deadline monitor does not consume this assessment. It can
detect and timestamp a validated command candidate's absolute
receipt-anchored deadline when its worker is scheduled, but it does not reload
health, interpret these relations, revoke output, or close the apply-time race;
see [`PLANT_WATCHDOG_V1.md`](PLANT_WATCHDOG_V1.md).

The separate apply-check observation first loads one generation-checked
coherent health snapshot and only then privately mints one plant-monotonic
reference instant for health-age and command receipt-age evaluation. It
preserves all eight relations from this classifier, plus a strict command
requested-lifetime relation and neutral lifecycle state/generation;
see [`PLANT_APPLY_OBSERVATION_V1.md`](PLANT_APPLY_OBSERVATION_V1.md). It does
not aggregate those facts or authorize an action.

## Structurally bound policy

`VehicleHealthCapturedAgePolicyV1` retains one exact `ProfileIdentity` and one
named exclusive limit for every age point. All eight limits must be nonzero;
configuration reports the first zero in the stable point order above. The
proposal has no default or positional constructor, so every duration remains
visibly attached to its semantic point.

This is structural binding only. Profile equality does not authenticate or
approve the profile, prove that its artifact contains these limits, or show
that any value is suitable for a vehicle or deployment. The component applies
no upper bound and supplies no built-in threshold.

The draft ODD currently states local position and velocity age `<=200 ms`.
This classifier deliberately does **not** implement or approve that condition:
its relation is exclusive, so an age equal to a proposed limit is outside it.
No `200 ms` value or inclusive-to-exclusive translation is encoded here. That
mapping requires a reviewed profile and ODD decision.

## Captured-read assessment

Assessment consumes one `ObservedVehicleHealthV1`. It rejects a different
exact profile identity before producing any comparison. A successful
`VehicleHealthCapturedAgeAssessmentV1` owns that coherent observed commit and
borrows the exact policy, preventing a caller from constructing an assessment
from bare ages or silently mixing a snapshot with another policy.

Each named comparison carries:

- the age point;
- the age frozen at the health-reader instant; and
- the exact exclusive limit.

Its only relation is:

- `WithinExclusiveLimitAtRead` when `age < exclusive_limit`; or
- `AtOrBeyondExclusiveLimitAtRead` when `age >= exclusive_limit`.

Equality is therefore outside the exclusive limit. The assessment exposes no
aggregate, boolean conversion, `all_fresh`, `healthy`, `safe`, `eligible`, or
`authorized` result.

## Temporal relation is not health

The health snapshot deliberately retains explicit `Unknown` and `Unavailable`
state. A recently observed unknown, rejected, or reset-in-progress value may be
within an age limit while remaining semantically unusable. Conversely, this
component does not interpret armed/landed/mode, estimator flags, battery,
fence, failsafe, link, position, or velocity state.

The comparison describes only its health-age reference instant. The apply-check
observation loads the coherent health snapshot before minting that reference,
then evaluates health ages and command age relative to it. This removes age-
reference skew but is not a write-adjacent atomic transaction; both sets of
facts can cease to describe current time immediately after the candidate is
returned. Lifecycle can also rotate and health can be replaced. The command
carries no `VehicleIdentity` or `LocalFrameInstanceIdentity`, so exact profile/
generation equality can compose it with health from another declared vehicle
or frame instance and adds no HAZ-005/HAZ-013 evidence. The observation is
remintable and not command-content-bound; matching retained IDs/TTL can describe
copyable candidates with different velocity and must never pair it to a command
as a checked token. A future governor must load or atomically consume health,
validate the current generation, apply an approved profile policy, and enforce
the result immediately before every FCU write.

## Deliberately deferred semantics

The following remain separate work:

- approved vehicle/profile limits and the ODD inclusive/exclusive decision;
- authenticated FCU collection and source-principal binding;
- real multi-message aggregation and oldest-constituent timestamps;
- local-frame reset issuance, suspend-clock qualification, and durable epoch
  anti-rollback;
- state interpretation and an aggregate health/safety policy;
- command admission, integration of the active deadline monitor with apply
  observation and apply-time enforcement,
  authoritative safe-action classification and approved/content-bound policy,
  governor, adapter, and independently attested FCU failsafes; and
- SITL, HIL, target-timing, and physical evidence.

This slice and its use by the inert observation are partial
CB-029/CB-030/CTL-005/HAZ-003/HAZ-006 component evidence only. CTL-003,
`TEST-PLANT-LOCAL-TTL`, and `TEST-ATOMIC-STATE-STALENESS` remain planned, and
CREBAIN remains L0.

## Verification

```bash
bun run check:plant-boundary
bun run test:plant
bun run clippy:plant
bun run fmt:plant:check
bun run self-check:plant
```

`TEST-PLANT-HEALTH-FRESHNESS-V1` identifies the focused component matrix for
zero-limit rejection, exact profile mismatch, all eight age mappings,
below/equal/above exclusive boundaries, captured observation ownership, and
the separation of temporal relation from unknown/unavailable health state.
`TEST-PLANT-APPLY-OBSERVATION-V1` separately proves that a coherent health
snapshot is loaded before the same later private reference instant supplies
command age and all eight captured health ages without creating an aggregate or
authorizing verdict. The complete plant suite has 123 unit/integration tests and
24 compile-fail doctests; the static checker has 231 fail-closed fixtures,
including 44 apply-observation mutations. These checks are not deployed,
apply-time, SITL, HIL, or flight evidence.
