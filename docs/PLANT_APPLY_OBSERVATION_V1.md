# Inactive Apply-Check Observation Candidate V1

Status: **inactive, unwired, and unapproved**. This is a single-reference-
instant age observation, not an immediately-before-write governor, an authority
decision, or evidence of an FCU effect.

## Scope

`crebain-plant-authority::apply_observation` can form one
`ApplyCheckObservationCandidateV1` from:

- a structurally validated `VelocityCommandCandidateV1`;
- an immutably borrowed `LifecycleMachine`;
- the canonical checked `VehicleHealthReaderV1`; and
- one exact-profile `VehicleHealthCapturedAgePolicyV1`.

After the profile and generation prechecks, the component first loads one
generation-checked coherent health snapshot. Only after that load succeeds does
it privately mint one plant-local monotonic reference instant. Command age and
all eight health ages are then evaluated relative to that same instant. The raw
instant is not exposed. Loading the snapshot before the reference instant does
not make the command, lifecycle, and health load one atomic capture. Lifecycle
state and generation are retained as neutral facts while the lifecycle machine
is immutably borrowed; the component does not claim that lifecycle is a
separately timestamped atomic source.

`Ok` means only that those facts were captured without a structural or clock
error. It can contain a command already at or beyond its requested lifetime,
every closed `PlantState` including `Emergency` and `Shutdown`, health ages at
or beyond every proposed limit, and recent `Unknown` or `Unavailable` health
state. Success is therefore evidence, never permission to write.

The Tauri application and `crebain-plantd` runtime do not construct or consume
this candidate. Nothing in it can authorize motion or affect a vehicle.

## Capture and error order

`ApplyCheckObservationCandidateV1::capture` fails closed in this stable order:

1. the command profile must exactly equal the age-policy profile;
2. the command generation must equal the lifecycle machine's captured
   generation;
3. the health reader must first load one coherent snapshot for that lifecycle
   generation;
4. only after that load succeeds, the component mints one private monotonic
   reference instant and computes all health ages relative to it;
5. the same reference instant must not precede command receipt; and
6. the observed health profile must exactly equal the age-policy profile.

The corresponding closed errors distinguish command/policy profile mismatch,
command/lifecycle generation mismatch, the complete typed vehicle-health read
failure, command clock regression, and health/policy profile mismatch. The
health load/age step precedes command-clock validation and continues to
distinguish missing or poisoned storage, generation mismatch, and receipt or
observation clock regression. No failure falls back to an older snapshot or a
nominal result.

## Retained evidence and lifetime relation

The candidate retains only:

- the command profile, session, stream sequence, and generation;
- the neutral lifecycle state and generation captured for this observation;
- command age and the structurally validated requested lifetime; and
- the owned coherent health observation with all eight borrowed-policy age
  comparisons.

The requested-lifetime relation is closed and strict:

- `WithinRequestedLifetimeAtCheck` when `command_age < requested_ttl`; or
- `AtOrBeyondRequestedLifetimeAtCheck` when `command_age >= requested_ttl`.

Equality is outside. This relation uses the command's requested lifetime, not
an approved profile-owned local TTL, and it is not integrated with the active
deadline monitor. Each health comparison preserves the existing
`WithinExclusiveLimitAtRead` or `AtOrBeyondExclusiveLimitAtRead` relation and
its exact age/limit pair. There is no aggregate or authorizing combination of
command, lifecycle, or health state. Callers can still compare the exposed
facts and manufacture their own booleans; those caller interpretations are
outside this component's claim.

## Identity and command-association limits

`VelocityCommandCandidateV1` carries neither `VehicleIdentity` nor
`LocalFrameInstanceIdentity`. Exact command/policy/health `ProfileIdentity`
equality and `RuntimeGeneration` equality therefore do not prove that the
command and health snapshot describe the same declared vehicle or the same
local-frame instance. A caller can compose a command with health retained for
another declared vehicle or frame instance while every implemented equality
check passes. This observation is no evidence for HAZ-005 or HAZ-013.

The observation is also neither unique nor content-bound to one command. The
validated command candidate is copyable and `capture` can be called repeatedly,
so observations can be reminted. The retained profile/session/sequence/
generation identifiers and requested TTL do not bind command velocity or the
complete command body: copyable candidates with those same values can carry
different velocity. A caller can therefore misassociate an observation with a
different command. Never pair an observation to a command by those identifiers
or TTL as though the observation were a checked token. The observation's own
non-cloneable API does not repair that missing command-content binding.

## Neutral lifecycle observation

`LifecycleObservationAtCheckV1` exposes the closed `PlantState` and
`RuntimeGeneration` without a direct `is_active`/eligibility/authorization
accessor or a `From` conversion to `bool`. Callers can compare those facts and
produce a boolean themselves; the component supplies no aggregate or
authorizing verdict. `Active` does not make the candidate a permit, and
`Emergency` or `Shutdown` does not turn successful capture into an error. This
preserves the state needed for a future reviewed policy without encoding that
policy in an inert observation component.

The immutable borrow prevents a lifecycle transition during the capture call,
but it does not prevent a transition immediately after the candidate is
returned. The component has no durable generation authority or restart
anti-rollback state.

## Deliberate API exclusions

The candidate is not cloneable or directly constructible. It exposes no raw
check instant, direct boolean accessor, `From` conversion to `bool`, aggregate
or authorizing verdict, permit, authorization token, command content, velocity,
proposed action, safe-action intent, output-revocation operation, or adapter
conversion. Its exposed facts remain comparable by callers. It performs no
lifecycle mutation, channel publication, callback, thread creation, timer
scheduling, serialization, transport, filesystem/network/device I/O, or runtime
wiring.

It also does not consume deadline-monitor terminal evidence or the safe-action
dispatch candidate. A caller cannot use the type itself to make a monitor event
revoke output, classify a situation, select a safe action, or call an FCU
adapter.

## Atomic boundary and remaining race

One coherent health snapshot is loaded first; the subsequently minted private
monotonic reference instant removes skew between command receipt-age and
health-age evaluation inside this component. The lifecycle machine remains
immutably borrowed during capture. These are useful prerequisites for CB-029,
planned CTL-003, partial CTL-005, HAZ-003, and HAZ-006, but they supply no
HAZ-005 or HAZ-013 evidence.

They are not a write-adjacent atomic transaction across command admission,
lifecycle, health publication, the deadline monitor, an adapter, and the FCU.
The observation can become stale immediately after return, health can be
replaced, lifecycle can transition, a deadline can become due, and a later
write can use unrelated data. No operation consumes this candidate and a
command in one indivisible checked write. Because the observation is remintable
and lacks command-content binding, a later consumer could also pair it with the
wrong command even when retained identifiers and TTL appear to match.

Accordingly CB-029, CTL-005, HAZ-003, and HAZ-006 remain **partial**. CTL-003,
`TEST-PLANT-LOCAL-TTL`, and `TEST-ATOMIC-STATE-STALENESS` remain planned, and
CREBAIN remains L0.

## Deliberately deferred semantics

The following remain separate required work:

- an approved profile-owned requested-lifetime and health age/state policy;
- authenticated command admission, source provenance, session/sequence state,
  and durable lifecycle generation ownership;
- authoritative interpretation and aggregation of health, lifecycle, and
  deadline conditions;
- an immediately-before-every-write governor that cannot be bypassed and
  rechecks or atomically consumes current inputs;
- authoritative safe-action classification, an approved content-bound policy,
  output invalidation, and typed FCU transactions;
- adapter acknowledgement, observed physical effect, process-loss containment,
  and independently configured FCU failsafes;
- suspend-inclusive monotonic-clock and target timing qualification; and
- SITL, HIL, target-platform, and physical-flight evidence.

## Verification

```bash
bun run check:plant-boundary
bun run test:plant
bun run clippy:plant
bun run fmt:plant:check
bun run self-check:plant
```

`TEST-PLANT-APPLY-OBSERVATION-V1` identifies the focused component matrix. It
covers a coherent health load before one exact reference instant is minted for
all eight health ages and then command receipt age; command lifetime below,
equal to, and above its boundary; profile/generation
error order; command and health clock regressions; missing, poisoned, and
wrong-generation health; health-policy mismatch; every neutral lifecycle
state; stale ages; and unknown/unavailable health. Compile-fail checks seal
construction, cloning, direct boolean conversion/raw-clock access, and
velocity/action/adapter conversions.

Its Phase 0 declaration binds this component matrix to HAZ-003/HAZ-006 and
CTL-003/CTL-005. That binding records prerequisite/component relevance; it does
not satisfy the planned immediately-before-write CTL-003 control.

The plant suite contains 123 unit/integration tests and 24 compile-fail
doctests. The static boundary checker exercises 231 fail-closed fixtures: 64
health/freshness, 51 safe-action, 72 deadline-monitor, and 44 apply-observation
mutations. These are component and source-boundary checks only, not deployed,
apply-time, SITL, HIL, or flight evidence.
