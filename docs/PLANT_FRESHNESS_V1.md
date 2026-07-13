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
interpret FCU state, transition lifecycle, select a safe action, or call an
adapter. The Tauri application does not link the plant package. Nothing in this
component can authorize or apply motion.

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

The comparison describes only the instant previously used by the checked
health reader. It can cease to describe current time immediately. Lifecycle
can also rotate after that read. A future governor must load health, validate
the current generation, apply an approved profile policy, and enforce the
result immediately before every FCU write.

## Deliberately deferred semantics

The following remain separate work:

- approved vehicle/profile limits and the ODD inclusive/exclusive decision;
- authenticated FCU collection and source-principal binding;
- real multi-message aggregation and oldest-constituent timestamps;
- local-frame reset issuance, suspend-clock qualification, and durable epoch
  anti-rollback;
- state interpretation and an aggregate health/safety policy;
- command admission, apply-time enforcement, watchdog scheduling, safe-action
  selection, governor, adapter, and independently attested FCU failsafes; and
- SITL, HIL, target-timing, and physical evidence.

This slice is partial CB-030/CTL-005/HAZ-006 component evidence only.
`TEST-ATOMIC-STATE-STALENESS` remains planned, and CREBAIN remains L0.

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
These checks are not deployed, apply-time, SITL, HIL, or flight evidence.
