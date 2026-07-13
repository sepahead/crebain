# CREBAIN Plant Authority Foundation

`crebain-plant-authority` is an inert, headless Rust package. It establishes a
process and dependency boundary for the future L1 plant without enabling a
command route or vehicle adapter. The `crebain-plantd` binary currently accepts
only `--self-check` and exits.

## Inactive contract-v1 candidate

The dependency-free `contract` module makes the draft L1 velocity semantics
explicit without creating an ingress path. It uses closed action/frame/unit
types, nonzero profile/session/producer-epoch identities, distinct producer and
plant-local time domains, a nonzero stream sequence, and an immutable validated
candidate bound to the current lifecycle generation. Validation rejects a
version/profile/session mismatch, every non-velocity action, zero or greater-
than-150-ms requested lifetime, a frame other than the exact identity-bound
local ENU or NED frame, non-SI units, nonfinite components, horizontal magnitude
above 5 m/s, or absolute vertical speed above 2 m/s.

The profile, limits, and canonical local frame remain unapproved. The module
has no serialization, transport, stateful replay admission, timer, health gate,
authoritative state-to-safe-action selection, adapter operation, or lifecycle
transition. The separate opaque situation-dispatch candidate described below
does not satisfy that missing gate. See
[`docs/PLANT_CONTRACT_V1.md`](../../../docs/PLANT_CONTRACT_V1.md).

## Profile-neutral frame conventions

`frame_conventions` provides a finite m/s value type and exact ENU↔NED and
FLU↔FRD velocity-axis permutations. It rejects every local↔body route because
that conversion requires authoritative attitude and canonicalizes every signed
zero to positive zero. The digest-bound TSV corpus is
evaluated independently by JavaScript and Rust from a restricted canonical
shortest-round-trip decimal encoding. Underflow/rounding aliases and other
noncanonical numeric lexemes fail closed. The corpus is checked by
`bun run check:plant-frames`.

The exact permutations require one unchanged physical frame instance: the same
local tangent origin/datum or the same rigid-body reference point. The value
does not carry or prove that identity; a future caller must do so separately.

The component is not connected to contract admission and does not select a
canonical profile, convert a wrong-frame proposal, accept attitude, or prove
frame-instance coincidence, Three.js, quaternion/yaw, point/translation,
covariance, degree/radian, time, or FCU semantics. It is partial HAZ-005
evidence only; CTL-006 remains planned.

## Inactive vehicle-health contract v1

`health` validates a closed immutable in-memory report into the canonical
kernel health path. One sealed channel pair is bound to an exact candidate
profile, vehicle identity, declared source identity, source stream epoch,
runtime generation, and local-frame instance. Its non-cloneable publisher
requires mutable access and admits only source sequences that strictly increase
within that publisher instance.
It validates the exact profile-local frame, metres, metres per second,
generation-bound plant-local observation times, finite position/velocity, and
an inclusive zero-to-one battery fraction. Unknown and unavailable state is
explicit and can replace a prior nominal report.

The retained commit atomically carries declared context fields, arming/landed/opaque
mode/failsafe state, estimator validity, position, velocity, battery, fence,
links, and all group times. Checked readers expose exact ages computed from one
monotonic instant. The source identity is not
authenticated; real FCU sampling and multi-message coherence, exclusive epoch
construction, approved age/state policy, apply-time checking, watchdog,
governor, authoritative safe-action classification and approved policy, and
adapter remain absent. See
[`docs/PLANT_HEALTH_V1.md`](../../../docs/PLANT_HEALTH_V1.md).

## Inactive captured-read health-age classifier v1

`freshness` consumes one coherent `ObservedVehicleHealthV1` and binds it to one
exact profile plus named caller-proposed limits for receipt, FCU state,
estimator, position, velocity, battery, fence, and links. Every limit must be
nonzero. Exact-profile mismatch fails before classification, and the resulting
assessment owns the observation while borrowing the exact policy so bare ages
cannot be silently mixed with another snapshot or policy.

Each relation describes only the health-reader instant: an age strictly below
its exclusive limit is `WithinExclusiveLimitAtRead`, while equality or a larger
age is `AtOrBeyondExclusiveLimitAtRead`. The component does not read a clock or
expose a boolean/aggregate fresh, healthy, safe, eligible, or authorized
result. A recent `Unknown` or `Unavailable` value remains semantically
non-nominal. The limits and profile are not approved or authenticated, and the
exclusive relation does not implement the draft ODD's inclusive `<=200 ms`
position/velocity condition. See
[`docs/PLANT_FRESHNESS_V1.md`](../../../docs/PLANT_FRESHNESS_V1.md).

## Inactive safe-action situation dispatch candidate v1

`safe_action` defines five plant-side candidate intents independently of the
untrusted command-ingress action enum: inhibit output, request a
profile-defined physical Hold, request controlled Land, request RTL, or request
a separately guarded ground-disarm transaction. A nonzero opaque `u8`
situation code is inseparably paired with the full candidate `ProfileIdentity`.

Policy construction copies a borrowed proposal into a fixed owned 255-slot
table without allocation. Empty, oversized, or duplicate-code proposals fail;
exact-profile mismatch and missing rows fail before any intent is returned.
There is no default or implicit Hold. A selection owns the asserted situation
and intent while borrowing the exact immutable policy candidate.

This is situation-dispatch mechanics only. It does not derive a situation from
health, lifecycle, expiry, or a trusted trigger; the profile identity does not
content-bind the separately supplied rows; and no conversion to ingress,
velocity, adapter, or FCU action exists. See
[`docs/PLANT_SAFE_ACTION_V1.md`](../../../docs/PLANT_SAFE_ACTION_V1.md).

## Channel policy

| Path | Capacity policy | Saturation behavior |
|---|---|---|
| Latest command/output foundations | One retained value | Newest replaces unread old value; overwrite count is explicit |
| Generic snapshot mechanics | One retained `Arc`-backed commit | Disconnected low-level register; loads are non-consuming and replacement atomically associates one generic value, caller-supplied generation, and register sequence |
| Canonical health snapshot | One sealed typed publisher/reader pair | Validates the closed immutable context-bound report and per-channel source sequence before coherent replacement; checked loads expose ages without a freshness verdict |
| Captured-read age assessment | One owned coherent observation plus one borrowed exact policy | Compares eight captured ages with named nonzero exclusive limits; does not refresh time, aggregate health, or authorize action |
| Safe-action situation dispatch candidate | Fixed 255-slot owned table plus one borrowed exact policy per selection | Rejects zero codes, empty/oversized/duplicate proposals, exact-profile mismatch, and missing rows; does not classify state, default an intent, or produce an adapter action |
| Active command deadline monitor candidate | One owned worker, one fixed profile/session/generation, one active ticket slot, and one sticky terminal outcome | Accepts only a separately validated higher-sequence ticket with non-regressing receipt time; has no queue, reset, refresh, extension, rearm, output revocation, safe-action conversion, or adapter effect |
| Lifecycle | Fixed bounded FIFO | Reject new work; the runtime must latch a safety cause |
| Evidence | Fixed bounded FIFO | Drop oldest so noncritical storage cannot block safety work; drop count is explicit |
| Safety | Separate process-lifetime first-cause latch | First notice records its originating generation and cannot be overwritten by normal traffic |

FIFO capacities are nonzero and capped at 65,536 without eager logical-capacity
allocation. Poisoned state, allocation failure, and exact sequence/loss-counter
exhaustion fail closed. Replaced values are destroyed only after committed
state and accounting have been unlocked, so an adversarial destructor cannot
poison the channel mutex.

`SnapshotChannel` remains disconnected generic storage mechanics. It
stores each complete value behind `Arc`, so repeated loads never consume or
deep-clone it and a previously loaded handle keeps its prior allocation after
replacement. The generic API does not prevent interior mutation exposed by `T`
and does not validate the freshness or order of a caller-supplied generation.
The canonical `KernelChannels` path no longer accepts a substitutable generic
health type or exposes raw snapshot endpoints; it uses the concrete health
candidate above. The separate age classifier does not change that endpoint or
create a runtime consumer. CB-030 remains partial because the component still
lacks authenticated/attested FCU provenance, real aggregation coherence,
approved age/state semantics, durable epoch ownership, and an apply-time
consumer.

## Passive expiry mechanics

`MonotonicExpiryGuard` binds one immutable, locally armed interval to the
process monotonic clock and a lifecycle generation. Its half-open validity
window expires exactly at the deadline; clock regression, generation rotation,
zero TTL, and unrepresentable deadlines fail closed. The guard has no refresh,
timer, callback, command payload, raw timestamp, state-to-safe-action
classification, adapter
hook, or I/O. It is component mechanics only—not the CB-027 watchdog—and does
not prove suspend behavior, apply-time coupling, scheduler latency, or expiry to
FCU-safe-action timing.

## Unwired active command deadline monitor v1

`CommandDeadlineTicketV1::try_from_candidate` derives a private absolute
deadline from a validated command candidate's opaque plant-local receipt time
plus a caller-proposed nonzero TTL that may narrow, but never exceed, the
candidate's requested lifetime. It rejects a mismatch with a caller-supplied
expected generation before TTL checks and does not establish authoritative
currentness. The ticket exposes its exact profile/session/sequence/generation
key and scheduled
TTL, but no raw receipt instant or absolute deadline, and it cannot be cloned,
copied, defaulted, or built from a raw clock. The candidate is copyable and can
mint another ticket, so ticket ownership is per monitor rather than global
admission.

`ActiveCommandDeadlineMonitorV1` owns one named worker and one active ticket
slot with no queue. A separately validated ticket can replace that slot only
under the same exact profile, session, and lifecycle generation, with a
strictly greater sequence and non-regressing receipt time. An already-expired
initial or superseding ticket becomes terminal; monitor start never grants a
fresh interval. A newer sequence with a regressing receipt also terminalizes.
There is no reset, refresh, extension, or rearm operation.

The fixed-state component detects/timestamps an absolute receipt-anchored
deadline when its worker is scheduled. Its first terminal result is sticky and
can report deadline detection, a caller-reported generation mismatch, shutdown,
clock regression, synchronization failure, worker panic, or an already-expired
or receipt-regressing superseding ticket. A synchronization failure exposes no
exact active key because the state is poisoned; worker-start failure retains the
initial key and any precomputed terminal reason. `wait`, `shutdown`, and `Drop`
join the owned worker; scheduling starvation can still delay completion
indefinitely. A reported generation is caller-provided rather than observed or
authenticated autonomously.

This component is not linked to command ingress, lifecycle, health,
safe-action dispatch, an output path, or an adapter. Its terminal value is
evidence only and cannot revoke a command or convert into a safe-action intent.
It does not prove suspend behavior, scheduler reservation/jitter, apply-time
coupling, process-loss containment, or deadline-to-FCU-effect latency. It is
partial CB-027/HAZ-003 component evidence only; CTL-003 and
`TEST-PLANT-LOCAL-TTL` remain planned. See
[`docs/PLANT_WATCHDOG_V1.md`](../../../docs/PLANT_WATCHDOG_V1.md).

The package has no dependencies and the boundary checker rejects links or
source references to the application library, Tauri, NCP/Zenoh, transport,
inference, fusion, simulation, ROS, Gazebo, or MAVROS. An operational watchdog, trusted
FCU health source/collector, approved age/state policy, safety governor,
approved/content-bound safe-action profile, authoritative situation classifier,
authenticated ingress, and FCU adapter remain
intentionally absent.

Production sources also reject subprocess, network, filesystem/device I/O,
external `#[path]`/`include!` reachability, symlinks, custom builds, and any
Cargo target outside the inventoried library, daemon, and integration tests.
The boundary mutation checker and compile-fail API checks also lock the concrete
non-mixable health endpoint pair, private snapshot fields, non-cloneable
publisher, captured-read observation/policy ownership, strict exclusive
comparison, safe-action profile/code binding, fixed no-default dispatch table,
non-cloneable selection, validated-candidate-only deadline tickets, fixed
single-slot monitor identity and strict replacement, terminal evidence
separation, absence of a boolean/aggregate verdict, and absence of raw retained
endpoints, implicit conversions, or runtime consumption. Future
adapter I/O requires an explicit boundary-policy change and review.

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml -p crebain-plant-authority
cargo run --locked --manifest-path src-tauri/Cargo.toml -p crebain-plant-authority \
  --bin crebain-plantd -- --self-check
bun run check:plant-frames
```
