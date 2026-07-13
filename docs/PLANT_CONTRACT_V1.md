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
separate required gates.

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
| General action | Velocity only | Hold/Land/RTL are reserved for a future state-dependent plant selector; arm/disarm/takeoff/mission/mode/raw-motor proposals are rejected |
| Frame | Exactly the local frame inseparably bound to the compound profile identity: `LocalNed` or `LocalEnu` | The deployment's canonical profile is not approved; body frames are rejected and transforms are absent |
| Unit | Metres per second only | Cross-system golden transforms remain pending |
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

## Rejection order

Validation fails closed in this deterministic order: contract version, profile
identity, session identity, action, requested lifetime, frame, unit, finite
components, horizontal envelope, and vertical envelope. Rejection values are
closed Rust variants so later evidence does not depend on free-form strings.

## Required next decisions

Before this candidate can be called an approved profile, the project must name
the exact PX4 SITL image/parameters, canonical local frame, transform corpus,
profile artifact digest, owner, approver, approval scope, and expiry/review
condition. The next implementation dependency remains a typed immutable
vehicle-health snapshot with provenance and freshness; command ingress and FCU
I/O remain out of order until the later watchdog, safe-action, governor, and
adapter gates exist.

## Component verification

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml -p crebain-plant-authority
cargo clippy --locked --manifest-path src-tauri/Cargo.toml \
  -p crebain-plant-authority --all-targets -- -D warnings
node scripts/check-plant-authority-boundary.mjs
```

The tests cover exact draft boundaries, version/profile/session mismatch, zero
and oversized lifetime, wrong local frame, non-SI units, every excluded action,
nonfinite components, vectors outside the instantaneous speed limits, all-zero identities, zero
sequence, and body-frame profile rejection. These are component tests, not
live-topology or flight evidence.
