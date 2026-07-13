# Plant Active Deadline Monitor V1 Candidate

Status: **inactive, unwired, and unapproved**. This is a fixed-state command
deadline component, not an operational watchdog, an apply-time authority gate,
or evidence of a safe physical response.

## Scope

`crebain-plant-authority::deadline_monitor` derives an immutable local deadline
ticket from a structurally validated `VelocityCommandCandidateV1` and can run
one owned worker around one active ticket slot. The Tauri application and
`crebain-plantd` runtime do not construct or consume the monitor. The headless
binary still accepts only `--self-check`.

The supported claim is deliberately narrow:

> The fixed-state component detects/timestamps an absolute receipt-anchored
> deadline when its worker is scheduled.

It does not admit, authorize, apply, or revoke a command. A terminal event is
evidence only: it does not classify vehicle state, choose a safe action, call
an adapter, or cause I/O or a physical effect.

## Receipt-anchored ticket

`CommandDeadlineTicketV1::try_from_candidate` accepts only:

- a previously validated velocity-command candidate;
- a caller-supplied expected lifecycle generation; and
- a nonzero local TTL proposal no greater than the candidate's structurally
  validated requested lifetime.

Generation mismatch is rejected before TTL checks. Equality with that expected
value is structural only: the component does not establish that the value is
authoritatively current. The private absolute deadline is the candidate's
opaque plant-local receipt instant plus the local TTL proposal. Monitor start
time never creates a fresh interval. An initial ticket already at or beyond its
deadline becomes terminal instead of being re-armed.

The ticket retains an exact key containing profile, command session, stream
sequence, and lifecycle generation. It exposes the key and scheduled TTL, but
not the receipt `Instant` or absolute deadline. There is no raw-clock
constructor, `Clone`, `Copy`, or `Default` implementation. Because the
validated candidate itself is copyable, a caller can derive multiple tickets
from the same candidate. Non-clone ticket ownership therefore proves only one
active slot per monitor; it is not global uniqueness or authoritative
admission. These mechanics do not approve the caller-proposed local TTL or
make validation a trusted ingress boundary.

## One fixed stream slot

`ActiveCommandDeadlineMonitorV1::start` creates one named, owned standard
thread, one mutex/condition-variable state object, and one active ticket slot.
There is no command queue. The worker waits for the current absolute deadline
and rechecks state when scheduled; condition-variable wakeups do not themselves
prove that the deadline has been reached.

`submit_next` can replace the active ticket only with a separately validated
ticket that:

- has the same exact profile, command session, and lifecycle generation;
- has a strictly greater stream sequence; and
- carries a receipt instant that does not precede the active ticket's receipt.

An accepted replacement records the previous and accepted keys, exact skipped
sequence count, and admission age. It installs the new ticket's own immutable
receipt-derived deadline; it does not mutate, refresh, or extend the prior
ticket. Duplicate or lower sequences and fixed-identity mismatches are local
slot rejections, not authenticated ingress or durable anti-replay evidence. A
strictly newer sequence with a receipt preceding the active receipt
terminalizes the monitor instead of leaving the older command armed. A newer
ticket already expired at submission likewise terminalizes the monitor rather
than preserving the older slot.

The monitor has no reset, refresh, extension, or rearm operation. A terminal
monitor must be consumed, and a new generation requires a distinct monitor.
`report_generation_mismatch` terminalizes the monitor only when its caller
supplies a generation differing from the fixed value. Both the method and its
terminal evidence describe a caller report, not an authenticated or autonomous
observation of lifecycle currentness.

## Terminal evidence and ownership

The first terminal outcome is sticky and cannot be overwritten. The closed
terminal reasons are:

- `DeadlineDetected`;
- `ReportedGenerationMismatch`;
- `ShutdownAcknowledged`;
- `ClockRegressed`;
- `SynchronizationFailed`;
- `WorkerPanicked`;
- `SupersedingReceiptRegressed`; and
- `SupersedingDeadlineAlreadyExpired`.

Deadline outcomes can carry the exact key, scheduled TTL, age when the ticket
entered the monitor, age when detection ran, and nonnegative detection
lateness. This timestamps component observation; it is not evidence that a
thread ran exactly at the deadline or that output stopped then. A due-deadline
check precedes replacement, generation-mismatch reporting, and shutdown, so an
already-due deadline wins those local races.

`wait` consumes the monitor, joins its worker, and returns the terminal event.
`shutdown` first requests terminal shutdown, then joins and returns whichever
deadline-or-shutdown event won. Dropping a live monitor also requests shutdown
and joins rather than detaching the worker. Synchronization poisoning and an
unexpected worker unwind become explicit terminal faults. None of these
mechanics bounds how long scheduling or joining can take. Because a poisoned
state cannot support an exact active-slot claim, `SynchronizationFailed`
exposes no active key; healthy terminal outcomes do. If worker creation itself
fails, the start error retains the initial key and any terminal reason already
computed before the spawn attempt.

## Deliberately deferred semantics

The following remain separate required work:

- authenticated command ingress, authoritative admission, and durable
  session/sequence anti-replay state;
- an approved profile-owned TTL policy and ownership of the caller-proposed
  local TTL;
- autonomous lifecycle observation and integration with current vehicle
  health, freshness, situation classification, and safe-action policy;
- immediately-before-write command-age checking, output revocation, an
  apply-time governor, typed FCU transaction, acknowledgement, and observed
  effect;
- reserved scheduler capacity, target WCET/jitter, overload and combined-load
  timing, and deadline-to-safe-action latency;
- suspend-inclusive monotonic-clock qualification, durable restart semantics,
  process-loss containment, and independently configured FCU failsafes; and
- SITL, HIL, target-platform, or physical-flight evidence.

This is partial CB-027/HAZ-003 component evidence only. HAZ-003 remains
partial, CTL-003 and `TEST-PLANT-LOCAL-TTL` remain planned, HAZ-002 remains
open, and CREBAIN remains L0.

## Verification

```bash
bun run check:plant-boundary
bun run test:plant
bun run clippy:plant
bun run fmt:plant:check
bun run self-check:plant
```

`TEST-PLANT-ACTIVE-DEADLINE-MONITOR-V1` identifies the focused component
matrix. The checks cover ticket construction and identity, receipt anchoring,
strict replacement and receipt ordering, exact-deadline precedence, already-
expired tickets, caller-reported generation mismatch, terminal immutability,
worker-start context, worker wake and join, clock regression, poisoned
synchronization without an exact-key claim, and worker panic. Public-path tests
also compose two validated candidates through ticket construction and strict
replacement. The one
real worker wake test is functional smoke, not a latency distribution or
target-scheduler qualification.
