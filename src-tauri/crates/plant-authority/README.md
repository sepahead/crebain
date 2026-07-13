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

## Channel policy

| Path | Capacity policy | Saturation behavior |
|---|---|---|
| Latest command/output foundations | One retained value | Newest replaces unread old value; overwrite count is explicit |
| Health-snapshot foundation | One retained `Arc`-backed commit | Loads are non-consuming; replacement atomically associates the whole value, caller-supplied lifecycle generation, and exact sequence |
| Lifecycle | Fixed bounded FIFO | Reject new work; the runtime must latch a safety cause |
| Evidence | Fixed bounded FIFO | Drop oldest so noncritical storage cannot block safety work; drop count is explicit |
| Safety | Separate process-lifetime first-cause latch | First notice records its originating generation and cannot be overwritten by normal traffic |

FIFO capacities are nonzero and capped at 65,536 without eager logical-capacity
allocation. Poisoned state, allocation failure, and exact sequence/loss-counter
exhaustion fail closed. Replaced values are destroyed only after committed
state and accounting have been unlocked, so an adversarial destructor cannot
poison the channel mutex.

`SnapshotChannel` is generic storage mechanics for the future health path. It
stores each complete value behind `Arc`, so repeated loads never consume or
deep-clone it and a previously loaded handle keeps its prior allocation after
replacement. The generic API does not prevent interior mutation exposed by `T`
and does not validate the freshness or order of a caller-supplied generation. A
future health type must close both contracts. The register also does not define
FCU fields, authoritative provenance, frame/unit semantics, freshness, or an
apply-time check. CB-030 therefore remains pending.

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
vehicle-health schema, safety governor, approved safe-action profile,
authenticated ingress, and FCU adapter remain intentionally absent.

Production sources also reject subprocess, network, filesystem/device I/O,
external `#[path]`/`include!` reachability, symlinks, custom builds, and any
Cargo target outside the inventoried library, daemon, and integration tests.
Future adapter I/O requires an explicit boundary-policy change and review.

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml -p crebain-plant-authority
cargo run --locked --manifest-path src-tauri/Cargo.toml -p crebain-plant-authority \
  --bin crebain-plantd -- --self-check
```
