# Inactive Safe-Action Situation Dispatch Candidate V1

Status: **inactive and unapproved**. This is bounded structural dispatch
mechanics, not a vehicle-state classifier, an approved safe-action table, an
apply-time decision, or authority evidence.

## Scope

`crebain-plant-authority::safe_action` defines a separate closed vocabulary for
future plant-selected safety intents and a deterministic lookup over opaque
profile-owned situation codes. It does not reuse the untrusted
`ProposedActionV1` ingress variants and has no conversion into a command,
adapter operation, zero-velocity vector, or physical effect.

The five candidate intents are:

- inhibit plant output;
- request the exact profile's physical Hold behavior;
- request a controlled-land transaction;
- request a return-to-launch transaction; and
- request a separately guarded ground-disarm transaction.

These names do not make any intent safe in a particular state. Inhibit is the
absence of plant output, not proof of FCU containment. Hold is neither zero
velocity nor a universal physical fallback. Land, RTL, and disarm still require
typed FCU-specific transactions, acknowledgements, observed effects, and
independently configured failsafes.

The Tauri application and headless runtime do not consume this component.
Nothing in it can transition lifecycle, authorize motion, or affect a vehicle.

The separate active deadline monitor emits terminal evidence only. It can
detect and timestamp a validated command candidate's absolute
receipt-anchored deadline when its worker is scheduled, but no conversion from
that terminal event to a situation code or safe-action intent exists; see
[`PLANT_WATCHDOG_V1.md`](PLANT_WATCHDOG_V1.md).

## Opaque situation vocabulary

`SafeActionSituationCodeV1` is a nonzero `u8`. Zero is rejected as unset, so
one candidate policy can contain at most the complete 255-code nonzero space.
That limit is a mechanically derived storage/code-space bound, not an ODD,
timing, vehicle, or safety threshold.

The code is intentionally opaque. Its meaning, state predicates, trigger
precedence, and proof obligations belong to a future approved profile artifact.
This component does not infer a code from `VehicleHealthStateV1`, the safety
latch, lifecycle, command expiry, or an emergency request. A caller-supplied
code can therefore be false, stale, unauthenticated, or produced under another
generation even when it is structurally well formed.

Each lookup request carries the full `ProfileIdentity` plus its code. A bare
code cannot be passed to the selector. Exact semantic kind and artifact digest
must match the candidate policy before lookup begins.

## Bounded candidate table

`SafeActionPolicyCandidateV1::try_from_rows` borrows a proposal slice and
copies it into an owned fixed `[Option<SafeActionIntentV1>; 255]` table. The
policy retains no reference to caller storage and performs no heap allocation.
It rejects, in stable order:

1. more than 255 submitted rows;
2. an empty table; and
3. the first duplicate code in proposal order.

Missing codes remain missing. Lookup returns an explicit error and never
defaults to Hold, inhibit, or any other intent. The selection result owns the
exact profile-bound situation and selected intent while borrowing the exact
immutable policy object; it is not cloneable or directly constructible.

This is structural binding only. `ProfileIdentity` identifies a candidate
profile artifact but does not prove that a separately supplied table came from
that artifact. Two different in-memory candidate tables can currently claim
the same identity. An approved design must include the canonical table in the
profile artifact covered by the existing digest, or bind a separately
canonicalized table digest into the approved profile.

## Deliberately deferred semantics

The following remain outside this component:

- an approved PX4/vehicle/ODD profile and canonical safe-action table;
- authenticated trigger and vehicle-state classification;
- priority for overlapping authority, battery, fence, navigation, link,
  emergency, expiry, reset, and shutdown conditions;
- approved age, dwell, battery, braking, fence, and navigation limits;
- interpretation of opaque FCU mode codes and proof that Hold, Land, RTL, or
  ground disarm is available and permitted;
- current/apply-time health, generation, freshness, and command checks;
- integration of the active deadline monitor with authoritative trigger
  classification, an apply-time governor, typed hazardous-action transaction,
  FCU adapter, acknowledgement/observation evidence, and independently
  attested FCU failsafes; and
- SITL, HIL, target-timing, process-loss, or physical evidence.

Accordingly, this is only partial structural CB-028 component mechanics.
CTL-007 remains planned, HAZ-002 and HAZ-007 remain open, HAZ-006 remains
partial for the separate health mechanics, and the planned
`TEST-SAFE-ACTION-STATE-MATRIX` is not satisfied. The focused component test is
`TEST-PLANT-SAFE-ACTION-POLICY-V1`.

## Verification

```bash
bun run check:plant-boundary
bun run test:plant
bun run clippy:plant
bun run fmt:plant:check
```

These commands prove only type, lookup, ownership, error-order, and package
isolation mechanics. They do not classify authoritative state or establish a
safe physical response.
