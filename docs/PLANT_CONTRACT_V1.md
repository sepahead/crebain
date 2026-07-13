# Plant Contract V1 Candidate

Status: **inactive and unapproved**. This document records component semantics
for review; it does not authorize a deployment, enable command ingress, or
change CREBAIN's L0 claim.

## Purpose

`crebain-plant-authority::contract` removes stringly typed and unit-ambiguous
inputs from the dependency path toward the native plant. It validates an
in-memory proposal into an immutable `VelocityCommandCandidateV1`. Possession of
that candidate proves only structural validation. Authentication, anti-replay,
fresh vehicle health, authorization, active expiry, safe-action selection,
apply-time checks, adapter acceptance, and observed vehicle effect remain
separate required gates. Here, “safe-action selection” means authoritative
state/trigger classification plus an approved content-bound policy; the inert
opaque-code dispatch candidate does not satisfy that gate.

The module has no serializer, parser, transport, timer, filesystem/network I/O,
adapter operation, or lifecycle transition. The `crebain-plantd` executable
still accepts only `--self-check`.

## Candidate profile

| Field | Contract-v1 candidate rule | Limit of the evidence |
|---|---|---|
| Version | Numeric version must equal `1` | No wire encoding is defined |
| Profile | Compound identity (closed ENU/NED semantic kind plus nonzero 256-bit artifact digest) must equal the locally selected profile | The profile artifact and approver are not yet pinned |
| Session | Nonzero 128-bit identity must equal the authenticated local session | No authenticator or live session exists |
| Sequence | Nonzero `u64` carried unchanged | Stateful monotonic/replay admission is not implemented |
| General action | Velocity only | Hold/Land/RTL remain reserved for a future approved state-dependent plant policy; a separate inert candidate can return closed safe-action intents from opaque caller-supplied situation codes but cannot admit or convert them here; arm/disarm/takeoff/mission/mode/raw-motor proposals are rejected |
| Frame | Exactly the local frame inseparably bound to the compound profile identity: `LocalNed` or `LocalEnu` | The deployment's canonical profile is not approved; wrong-frame proposals still fail instead of being converted automatically |
| Unit | Metres per second only | The v1 corpus covers velocity axes in m/s only, not other physical quantities or time units |
| Horizontal speed | Finite magnitude at most 5 m/s | Draft ODD constraint, not measured capability |
| Vertical speed | Finite absolute value at most 2 m/s | Draft ODD constraint, not measured capability |
| Requested lifetime | Greater than zero and at most 150 ms | Structural bound only; no active watchdog or immediately-before-write check |
| Producer time | Epoch-qualified duration retained only for correlation | Never used as plant command age |
| Plant receipt time | Opaque local monotonic `Instant` minted inside validation, not by its caller | Validation must eventually be the trusted ingress boundary; no scheduler, deadline, or suspend qualification exists |
| Lifecycle | Candidate is bound to the current process-local generation | Durable boot/session anti-rollback remains pending |

The closed profile kind binds the local frame into `ProfileIdentity`, so the
same identity value cannot mean ENU in one plant and NED in another. There is no
default guess between them. The nonzero artifact digest must bind all other
reviewed limits before later integration work.

## Profile-neutral frame prerequisite

`frame_conventions` is a separate, non-authoritative component prerequisite.
It maps ENU↔NED velocity axes as `[x, y, z] → [y, x, -z]` and FLU↔FRD as
`[x, y, z] → [x, -y, -z]`. Identity routes preserve the value, and every
signed zero is canonicalized to positive zero. Every
local↔body route returns `AttitudeRequired`; the component accepts no attitude
and is not called by contract admission. `FiniteFramedVelocityMpsV1` proves
only finite m/s components and an explicit frame—not a profile match, command
envelope, session, freshness, authorization, or authority. Its exact
permutation is valid only when ENU/NED share one tangent origin and datum, or
FLU/FRD share one rigid-body reference point. The value carries no frame-instance
identity, so its caller must prove that precondition separately.

The exact shared corpus is
[`baselines/plant-frame-golden-v1.tsv`](baselines/plant-frame-golden-v1.tsv),
bound by SHA-256
`4ebe6e287f8d094716065292b2c7614c807c19a7573c47b655f70e7e853cd578`
in
[`baselines/plant-frame-conventions-v1.json`](baselines/plant-frame-conventions-v1.json).
JavaScript and dependency-free Rust evaluate the same 32 vectors. This does
so from canonical shortest-round-trip plain decimals with at most three integer
and six fractional digits. Exponents, noncanonical leading or fractional
trailing zeros, negative zero, and underflow/rounding aliases fail closed. This does
not cover frame-instance identity/coincidence proof, attitude, yaw/quaternions,
points/translation, covariance, Three.js, degrees/radians, time, profile
selection, or live FCU interpretation.

## Rejection order

Validation fails closed in this deterministic order: contract version, profile
identity, session identity, action, requested lifetime, frame, unit, finite
components, horizontal envelope, and vertical envelope. Rejection values are
closed Rust variants so later evidence does not depend on free-form strings.

## Required next decisions

Before this candidate can be called an approved profile, the project must name
the exact PX4 SITL image/parameters and canonical local frame; review and bind
the exact v1 corpus digest plus remaining transform semantics into the profile
artifact; and record its owner, approver, approval scope, and expiry/review
condition. A separate typed immutable vehicle-health snapshot candidate now
binds declared context identity and exposes plant-monotonic ages. Its
profile-bound captured-read classifier rejects zero limits and profile mismatch
and applies named exclusive comparisons to all eight ages, but does not read
current time, authenticate an FCU source, approve any limit/state policy,
implement the draft ODD's inclusive `<=200 ms` condition, or close the
apply-time race. A separate safe-action candidate now proves only fixed,
no-default, exact-profile dispatch mechanics over caller-proposed opaque
situation codes. Its rows are not profile-content-bound, it does not classify
authoritative state/triggers, and it cannot convert an intent into an action.
Command ingress and FCU I/O remain out of order until the profile, active
watchdog, approved safe-action classifier/policy, governor, and adapter gates
exist. See
[`PLANT_HEALTH_V1.md`](PLANT_HEALTH_V1.md) and
[`PLANT_FRESHNESS_V1.md`](PLANT_FRESHNESS_V1.md), and
[`PLANT_SAFE_ACTION_V1.md`](PLANT_SAFE_ACTION_V1.md).

## Component verification

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml -p crebain-plant-authority
cargo clippy --locked --manifest-path src-tauri/Cargo.toml \
  -p crebain-plant-authority --all-targets -- -D warnings
node scripts/check-plant-authority-boundary.mjs
bun run check:plant-frames
```

The tests cover exact draft boundaries, version/profile/session mismatch, zero
and oversized lifetime, wrong local frame, non-SI units, every excluded action,
nonfinite components, vectors outside the instantaneous speed limits, all-zero identities, zero
sequence, body-frame profile rejection, exact ENU/NED and FLU/FRD axes,
round trips, finite-value rejection, and every local/body no-attitude route.
These are component tests, not profile approval, live-topology, or flight
evidence.
