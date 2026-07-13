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
safe-action selection, adapter operation, or lifecycle transition. See
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
monotonic instant, not a fresh/healthy/safe verdict. The source identity is not
authenticated; real FCU sampling and multi-message coherence, exclusive epoch
construction, approved freshness policy, apply-time checking, watchdog,
governor, safe action, and adapter remain absent. See
[`docs/PLANT_HEALTH_V1.md`](../../../docs/PLANT_HEALTH_V1.md).

## Channel policy

| Path | Capacity policy | Saturation behavior |
|---|---|---|
| Latest command/output foundations | One retained value | Newest replaces unread old value; overwrite count is explicit |
| Generic snapshot mechanics | One retained `Arc`-backed commit | Disconnected low-level register; loads are non-consuming and replacement atomically associates one generic value, caller-supplied generation, and register sequence |
| Canonical health snapshot | One sealed typed publisher/reader pair | Validates the closed immutable context-bound report and per-channel source sequence before coherent replacement; checked loads expose ages without a freshness verdict |
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
candidate above. CB-030 remains partial because the component still lacks
authenticated/attested FCU provenance, real aggregation coherence, approved
freshness semantics, durable epoch ownership, and an apply-time consumer.

## Passive expiry mechanics

`MonotonicExpiryGuard` binds one immutable, locally armed interval to the
process monotonic clock and a lifecycle generation. Its half-open validity
window expires exactly at the deadline; clock regression, generation rotation,
zero TTL, and unrepresentable deadlines fail closed. The guard has no refresh,
timer, callback, command payload, raw timestamp, safe-action selection, adapter
hook, or I/O. It is component mechanics only—not the CB-027 watchdog—and does
not prove suspend behavior, apply-time coupling, scheduler latency, or expiry to
FCU-safe-action timing.

The package has no dependencies and the boundary checker rejects links or
source references to the application library, Tauri, NCP/Zenoh, transport,
inference, fusion, simulation, ROS, Gazebo, or MAVROS. A real watchdog, trusted
FCU health source/collector, approved freshness policy, safety governor,
approved safe-action profile, authenticated ingress, and FCU adapter remain
intentionally absent.

Production sources also reject subprocess, network, filesystem/device I/O,
external `#[path]`/`include!` reachability, symlinks, custom builds, and any
Cargo target outside the inventoried library, daemon, and integration tests.
The boundary mutation checker and compile-fail API checks also lock the concrete
non-mixable health endpoint pair, private snapshot fields, non-cloneable
publisher, and absence of raw retained endpoints or reader conversion in the
runtime. Future adapter I/O requires an explicit boundary-policy change and
review.

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml -p crebain-plant-authority
cargo run --locked --manifest-path src-tauri/Cargo.toml -p crebain-plant-authority \
  --bin crebain-plantd -- --self-check
bun run check:plant-frames
```
