//! Unwired receipt-anchored active command deadline monitor candidate.
//!
//! One monitor owns one worker and one active deadline slot. A later command
//! can replace that slot only when it is a separately validated candidate in
//! the same exact profile, session, and lifecycle generation with a strictly
//! greater stream sequence. The monitor emits terminal evidence only. It does
//! not revoke output, classify vehicle state, choose a safe action, call an
//! adapter, or perform I/O.

use std::fmt;
use std::panic::{self, AssertUnwindSafe};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::contract::{
    CommandSessionIdentity, CommandStreamSequence, PlantReceiptTime, ProfileIdentity,
    VelocityCommandCandidateV1,
};
use crate::lifecycle::RuntimeGeneration;

const DEADLINE_WORKER_NAME: &str = "crebain-command-deadline-v1";

/// Exact stream identity retained by one command deadline ticket.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandDeadlineKeyV1 {
    profile: ProfileIdentity,
    session: CommandSessionIdentity,
    stream_sequence: CommandStreamSequence,
    generation: RuntimeGeneration,
}

impl CommandDeadlineKeyV1 {
    /// Returns the exact structural profile identity.
    #[must_use]
    pub const fn profile(self) -> ProfileIdentity {
        self.profile
    }

    /// Returns the exact command-session identity.
    #[must_use]
    pub const fn session(self) -> CommandSessionIdentity {
        self.session
    }

    /// Returns the command stream sequence.
    #[must_use]
    pub const fn stream_sequence(self) -> CommandStreamSequence {
        self.stream_sequence
    }

    /// Returns the lifecycle generation captured by validation.
    #[must_use]
    pub const fn generation(self) -> RuntimeGeneration {
        self.generation
    }
}

/// Failure while deriving a receipt-anchored deadline ticket.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandDeadlineTicketErrorV1 {
    /// The candidate generation differs from the caller's expected value.
    GenerationMismatch {
        /// Generation retained by the validated candidate.
        candidate: RuntimeGeneration,
        /// Expected generation supplied at ticket construction.
        expected: RuntimeGeneration,
    },
    /// A zero local proposal cannot authorize an interval.
    ZeroLocalTtlProposal,
    /// The local proposal would extend the candidate's requested lifetime.
    LocalTtlExceedsRequested {
        /// Structurally validated requested lifetime.
        requested: Duration,
        /// Caller-proposed local lifetime.
        proposed: Duration,
    },
    /// Receipt plus the local proposal is not representable by the clock.
    UnrepresentableDeadline,
}

impl fmt::Display for CommandDeadlineTicketErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GenerationMismatch { .. } => {
                formatter.write_str("command candidate lifecycle generation was not expected")
            }
            Self::ZeroLocalTtlProposal => {
                formatter.write_str("local command TTL proposal must be nonzero")
            }
            Self::LocalTtlExceedsRequested { .. } => {
                formatter.write_str("local command TTL proposal exceeds the candidate request")
            }
            Self::UnrepresentableDeadline => {
                formatter.write_str("receipt-anchored command deadline is not representable")
            }
        }
    }
}

impl std::error::Error for CommandDeadlineTicketErrorV1 {}

/// Immutable capability to submit one validated receipt-derived deadline.
///
/// The ticket deliberately has no raw-clock constructor, clone, copy, or
/// default implementation. Because the validated candidate is copyable, a
/// caller can mint another ticket from the same candidate; ticket ownership
/// therefore proves capacity only within one monitor, not global admission or
/// uniqueness:
///
/// ```compile_fail
/// use crebain_plant_authority::CommandDeadlineTicketV1;
///
/// fn duplicate(ticket: CommandDeadlineTicketV1) {
///     let _copy = ticket.clone();
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::CommandDeadlineTicketV1;
/// use std::time::{Duration, Instant};
///
/// let _ticket = CommandDeadlineTicketV1::from_raw_clock(
///     Instant::now(),
///     Duration::from_millis(1),
/// );
/// ```
pub struct CommandDeadlineTicketV1 {
    key: CommandDeadlineKeyV1,
    received_at: PlantReceiptTime,
    scheduled_ttl: Duration,
    deadline: Instant,
}

impl fmt::Debug for CommandDeadlineTicketV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandDeadlineTicketV1")
            .field("key", &self.key)
            .field("scheduled_ttl", &self.scheduled_ttl)
            .finish_non_exhaustive()
    }
}

impl CommandDeadlineTicketV1 {
    /// Derives an immutable deadline from a validated candidate's opaque plant
    /// receipt time and a nonzero local TTL proposal.
    ///
    /// The local proposal may narrow the candidate request but may never extend
    /// it. The expected-generation equality check precedes TTL checks. The
    /// expected value is caller-provided structural data; this component does
    /// not observe authoritative lifecycle currentness.
    ///
    /// # Errors
    ///
    /// Returns [`CommandDeadlineTicketErrorV1`] for a generation mismatch, zero
    /// or over-request TTL, or an unrepresentable receipt-derived deadline.
    pub fn try_from_candidate(
        candidate: &VelocityCommandCandidateV1,
        expected_generation: RuntimeGeneration,
        local_ttl_proposal: Duration,
    ) -> Result<Self, CommandDeadlineTicketErrorV1> {
        let candidate_generation = candidate.generation();
        if expected_generation != candidate_generation {
            return Err(CommandDeadlineTicketErrorV1::GenerationMismatch {
                candidate: candidate_generation,
                expected: expected_generation,
            });
        }
        if local_ttl_proposal.is_zero() {
            return Err(CommandDeadlineTicketErrorV1::ZeroLocalTtlProposal);
        }
        let requested = candidate.requested_ttl().get();
        if local_ttl_proposal > requested {
            return Err(CommandDeadlineTicketErrorV1::LocalTtlExceedsRequested {
                requested,
                proposed: local_ttl_proposal,
            });
        }
        let received_at = candidate.received_at();
        let deadline = received_at
            .checked_deadline(local_ttl_proposal)
            .ok_or(CommandDeadlineTicketErrorV1::UnrepresentableDeadline)?;
        Ok(Self {
            key: CommandDeadlineKeyV1 {
                profile: candidate.profile().identity(),
                session: candidate.session(),
                stream_sequence: candidate.stream_sequence(),
                generation: candidate_generation,
            },
            received_at,
            scheduled_ttl: local_ttl_proposal,
            deadline,
        })
    }

    /// Returns the fixed stream identity retained by this ticket.
    #[must_use]
    pub const fn key(&self) -> CommandDeadlineKeyV1 {
        self.key
    }

    /// Returns the locally proposed lifetime used for this ticket.
    #[must_use]
    pub const fn scheduled_ttl(&self) -> Duration {
        self.scheduled_ttl
    }
}

/// Exact terminal reason published by an active deadline monitor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlineMonitorTerminalKindV1 {
    /// The active ticket reached or passed its exclusive deadline.
    DeadlineDetected,
    /// A caller reported a generation differing from the fixed monitor.
    ReportedGenerationMismatch,
    /// Explicit shutdown won before the active deadline.
    ShutdownAcknowledged,
    /// A monotonic observation preceded the monitor's last observation.
    ClockRegressed,
    /// Internal synchronization became poisoned.
    SynchronizationFailed,
    /// The owned worker unwound unexpectedly.
    WorkerPanicked,
    /// A strictly newer sequence carried a receipt preceding the active one.
    SupersedingReceiptRegressed,
    /// A valid newer stream ticket was already expired when submitted.
    SupersedingDeadlineAlreadyExpired,
}

/// Timing evidence for one detected receipt-anchored deadline.
#[derive(Debug, Eq, PartialEq)]
pub struct DeadlineDetectionEvidenceV1 {
    key: CommandDeadlineKeyV1,
    scheduled_ttl: Duration,
    admission_age: Duration,
    detected_age: Duration,
    late_by: Duration,
}

impl DeadlineDetectionEvidenceV1 {
    /// Returns the exact key whose deadline was detected.
    #[must_use]
    pub const fn key(&self) -> CommandDeadlineKeyV1 {
        self.key
    }

    /// Returns the immutable local lifetime scheduled by the ticket.
    #[must_use]
    pub const fn scheduled_ttl(&self) -> Duration {
        self.scheduled_ttl
    }

    /// Returns command age when the ticket entered this monitor.
    #[must_use]
    pub const fn admission_age(&self) -> Duration {
        self.admission_age
    }

    /// Returns command age at deadline detection.
    #[must_use]
    pub const fn detected_age(&self) -> Duration {
        self.detected_age
    }

    /// Returns detection lateness beyond the scheduled lifetime.
    #[must_use]
    pub const fn late_by(&self) -> Duration {
        self.late_by
    }
}

/// One sticky terminal event produced by the monitor.
///
/// This value is evidence only and cannot be converted into an ingress or
/// safe-action capability:
///
/// ```compile_fail
/// use crebain_plant_authority::{DeadlineMonitorTerminalV1, SafeActionIntentV1};
///
/// fn turn_into_intent(event: DeadlineMonitorTerminalV1) -> SafeActionIntentV1 {
///     event.into()
/// }
/// ```
#[derive(Debug, Eq, PartialEq)]
pub struct DeadlineMonitorTerminalV1 {
    kind: DeadlineMonitorTerminalKindV1,
    active_key: Option<CommandDeadlineKeyV1>,
    deadline_detection: Option<DeadlineDetectionEvidenceV1>,
    reported_generation: Option<RuntimeGeneration>,
    superseding_key: Option<CommandDeadlineKeyV1>,
}

impl DeadlineMonitorTerminalV1 {
    /// Returns the closed terminal reason.
    #[must_use]
    pub const fn kind(&self) -> DeadlineMonitorTerminalKindV1 {
        self.kind
    }

    /// Returns the exact active key when terminalization completed from healthy
    /// synchronized state.
    ///
    /// Synchronization failure returns `None` because a poisoned state cannot
    /// support an exact active-slot claim.
    #[must_use]
    pub const fn active_key(&self) -> Option<CommandDeadlineKeyV1> {
        self.active_key
    }

    /// Returns timing evidence when a receipt-derived deadline was detected.
    #[must_use]
    pub const fn deadline_detection(&self) -> Option<&DeadlineDetectionEvidenceV1> {
        self.deadline_detection.as_ref()
    }

    /// Returns the differing generation reported by a caller, when present.
    ///
    /// This value is not an autonomous or authenticated lifecycle observation.
    #[must_use]
    pub const fn reported_generation(&self) -> Option<RuntimeGeneration> {
        self.reported_generation
    }

    /// Returns the newer key whose receipt or already-expired deadline
    /// terminalized the monitor, when present.
    #[must_use]
    pub const fn superseding_key(&self) -> Option<CommandDeadlineKeyV1> {
        self.superseding_key
    }

    fn simple(kind: DeadlineMonitorTerminalKindV1, active_key: CommandDeadlineKeyV1) -> Self {
        Self {
            kind,
            active_key: Some(active_key),
            deadline_detection: None,
            reported_generation: None,
            superseding_key: None,
        }
    }

    fn deadline(
        kind: DeadlineMonitorTerminalKindV1,
        active_key: CommandDeadlineKeyV1,
        ticket: &CommandDeadlineTicketV1,
        admission_age: Duration,
        detected_age: Duration,
        superseding_key: Option<CommandDeadlineKeyV1>,
    ) -> Self {
        Self {
            kind,
            active_key: Some(active_key),
            deadline_detection: Some(DeadlineDetectionEvidenceV1 {
                key: ticket.key,
                scheduled_ttl: ticket.scheduled_ttl,
                admission_age,
                detected_age,
                late_by: detected_age.saturating_sub(ticket.scheduled_ttl),
            }),
            reported_generation: None,
            superseding_key,
        }
    }

    fn reported_generation_mismatch(
        active_key: CommandDeadlineKeyV1,
        reported_generation: RuntimeGeneration,
    ) -> Self {
        Self {
            kind: DeadlineMonitorTerminalKindV1::ReportedGenerationMismatch,
            active_key: Some(active_key),
            deadline_detection: None,
            reported_generation: Some(reported_generation),
            superseding_key: None,
        }
    }

    fn superseding_fault(
        kind: DeadlineMonitorTerminalKindV1,
        active_key: CommandDeadlineKeyV1,
        superseding_key: CommandDeadlineKeyV1,
    ) -> Self {
        Self {
            kind,
            active_key: Some(active_key),
            deadline_detection: None,
            reported_generation: None,
            superseding_key: Some(superseding_key),
        }
    }

    fn synchronization_failed() -> Self {
        Self {
            kind: DeadlineMonitorTerminalKindV1::SynchronizationFailed,
            active_key: None,
            deadline_detection: None,
            reported_generation: None,
            superseding_key: None,
        }
    }
}

/// Failure to start the monitor's sole owned worker.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DeadlineMonitorStartErrorV1 {
    initial_key: CommandDeadlineKeyV1,
    initial_terminal_kind: Option<DeadlineMonitorTerminalKindV1>,
}

impl DeadlineMonitorStartErrorV1 {
    /// Returns the initial ticket key whose worker could not be started.
    #[must_use]
    pub const fn initial_key(&self) -> CommandDeadlineKeyV1 {
        self.initial_key
    }

    /// Returns a terminal reason computed before worker creation failed, when
    /// the initial ticket was already terminal.
    #[must_use]
    pub const fn initial_terminal_kind(&self) -> Option<DeadlineMonitorTerminalKindV1> {
        self.initial_terminal_kind
    }
}

impl fmt::Display for DeadlineMonitorStartErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("failed to start the command deadline monitor worker")
    }
}

impl std::error::Error for DeadlineMonitorStartErrorV1 {}

/// Failure while advancing the monitor's single active stream slot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlineAdvanceErrorV1 {
    /// The monitor is already terminal, including terminalization during this call.
    MonitorTerminal,
    /// The newer ticket asserted another exact profile.
    ProfileMismatch {
        /// Profile fixed at monitor start.
        expected: ProfileIdentity,
        /// Profile carried by the proposed replacement.
        received: ProfileIdentity,
    },
    /// The newer ticket asserted another command session.
    SessionMismatch {
        /// Session fixed at monitor start.
        expected: CommandSessionIdentity,
        /// Session carried by the proposed replacement.
        received: CommandSessionIdentity,
    },
    /// The newer ticket asserted another lifecycle generation.
    GenerationMismatch {
        /// Generation fixed at monitor start.
        expected: RuntimeGeneration,
        /// Generation carried by the proposed replacement.
        received: RuntimeGeneration,
    },
    /// The proposed sequence was not strictly greater than the active sequence.
    SequenceNotAdvanced {
        /// Sequence currently occupying the slot.
        current: CommandStreamSequence,
        /// Sequence carried by the proposed replacement.
        received: CommandStreamSequence,
    },
}

impl fmt::Display for DeadlineAdvanceErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MonitorTerminal => formatter.write_str("deadline monitor is terminal"),
            Self::ProfileMismatch { .. } => {
                formatter.write_str("deadline ticket profile does not match the fixed monitor")
            }
            Self::SessionMismatch { .. } => {
                formatter.write_str("deadline ticket session does not match the fixed monitor")
            }
            Self::GenerationMismatch { .. } => {
                formatter.write_str("deadline ticket generation does not match the fixed monitor")
            }
            Self::SequenceNotAdvanced { .. } => {
                formatter.write_str("deadline ticket sequence did not advance")
            }
        }
    }
}

impl std::error::Error for DeadlineAdvanceErrorV1 {}

/// Evidence that one strict stream advancement replaced the active slot.
#[derive(Debug, Eq, PartialEq)]
pub struct DeadlineAdvanceReceiptV1 {
    previous_key: CommandDeadlineKeyV1,
    accepted_key: CommandDeadlineKeyV1,
    skipped_sequences: u64,
    admission_age: Duration,
}

impl DeadlineAdvanceReceiptV1 {
    /// Returns the key that previously occupied the slot.
    #[must_use]
    pub const fn previous_key(&self) -> CommandDeadlineKeyV1 {
        self.previous_key
    }

    /// Returns the accepted replacement key.
    #[must_use]
    pub const fn accepted_key(&self) -> CommandDeadlineKeyV1 {
        self.accepted_key
    }

    /// Returns the exact number of skipped sequence values.
    #[must_use]
    pub const fn skipped_sequences(&self) -> u64 {
        self.skipped_sequences
    }

    /// Returns command age when the replacement entered the monitor.
    #[must_use]
    pub const fn admission_age(&self) -> Duration {
        self.admission_age
    }
}

/// Failure while controlling the fixed-generation monitor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeadlineControlErrorV1 {
    /// The monitor is already terminal, including terminalization during this call.
    MonitorTerminal,
    /// The supplied generation equals the fixed generation and is not a mismatch.
    SameGeneration {
        /// Structurally matching fixed generation.
        generation: RuntimeGeneration,
    },
}

impl fmt::Display for DeadlineControlErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MonitorTerminal => formatter.write_str("deadline monitor is terminal"),
            Self::SameGeneration { .. } => formatter
                .write_str("the fixed generation cannot be reported as a generation mismatch"),
        }
    }
}

impl std::error::Error for DeadlineControlErrorV1 {}

#[derive(Debug)]
struct ActiveDeadline {
    ticket: CommandDeadlineTicketV1,
    admission_age: Duration,
}

#[derive(Debug)]
enum MonitorPhase {
    Armed(ActiveDeadline),
    Terminal(Option<DeadlineMonitorTerminalV1>),
}

#[derive(Debug)]
struct MonitorState {
    fixed_profile: ProfileIdentity,
    fixed_session: CommandSessionIdentity,
    fixed_generation: RuntimeGeneration,
    last_active_key: CommandDeadlineKeyV1,
    last_observed: Instant,
    phase: MonitorPhase,
}

impl MonitorState {
    fn from_initial_at(ticket: CommandDeadlineTicketV1, observed_at: Instant) -> Self {
        let key = ticket.key;
        let mut state = Self {
            fixed_profile: key.profile,
            fixed_session: key.session,
            fixed_generation: key.generation,
            last_active_key: key,
            last_observed: observed_at,
            phase: MonitorPhase::Armed(ActiveDeadline {
                ticket,
                admission_age: Duration::ZERO,
            }),
        };
        let receipt = match &state.phase {
            MonitorPhase::Armed(active) => active.ticket.received_at,
            MonitorPhase::Terminal(_) => return state,
        };
        let Some(admission_age) = receipt.elapsed_at(observed_at) else {
            state.terminalize(DeadlineMonitorTerminalV1::simple(
                DeadlineMonitorTerminalKindV1::ClockRegressed,
                key,
            ));
            return state;
        };
        if let MonitorPhase::Armed(active) = &mut state.phase {
            active.admission_age = admission_age;
        }
        state.observe_at(observed_at);
        state
    }

    fn observe_at(&mut self, observed_at: Instant) -> Option<Duration> {
        if matches!(self.phase, MonitorPhase::Terminal(_)) {
            return None;
        }
        if observed_at < self.last_observed {
            self.terminalize(DeadlineMonitorTerminalV1::simple(
                DeadlineMonitorTerminalKindV1::ClockRegressed,
                self.last_active_key,
            ));
            return None;
        }
        self.last_observed = observed_at;
        let due_evidence = match &self.phase {
            MonitorPhase::Armed(active) if observed_at >= active.ticket.deadline => {
                let detected_age = active
                    .ticket
                    .received_at
                    .elapsed_at(observed_at)
                    .unwrap_or(Duration::ZERO);
                Some(DeadlineMonitorTerminalV1::deadline(
                    DeadlineMonitorTerminalKindV1::DeadlineDetected,
                    active.ticket.key,
                    &active.ticket,
                    active.admission_age,
                    detected_age,
                    None,
                ))
            }
            MonitorPhase::Armed(_) | MonitorPhase::Terminal(_) => None,
        };
        if let Some(terminal) = due_evidence {
            self.terminalize(terminal);
            return None;
        }
        match &self.phase {
            MonitorPhase::Armed(active) => Some(active.ticket.deadline.duration_since(observed_at)),
            MonitorPhase::Terminal(_) => None,
        }
    }

    fn advance_at(
        &mut self,
        next: CommandDeadlineTicketV1,
        observed_at: Instant,
    ) -> Result<DeadlineAdvanceReceiptV1, DeadlineAdvanceErrorV1> {
        if self.observe_at(observed_at).is_none() {
            return Err(DeadlineAdvanceErrorV1::MonitorTerminal);
        }
        let next_key = next.key;
        if next_key.profile != self.fixed_profile {
            return Err(DeadlineAdvanceErrorV1::ProfileMismatch {
                expected: self.fixed_profile,
                received: next_key.profile,
            });
        }
        if next_key.session != self.fixed_session {
            return Err(DeadlineAdvanceErrorV1::SessionMismatch {
                expected: self.fixed_session,
                received: next_key.session,
            });
        }
        if next_key.generation != self.fixed_generation {
            return Err(DeadlineAdvanceErrorV1::GenerationMismatch {
                expected: self.fixed_generation,
                received: next_key.generation,
            });
        }
        let (current_key, current_receipt) = match &self.phase {
            MonitorPhase::Armed(active) => (active.ticket.key, active.ticket.received_at),
            MonitorPhase::Terminal(_) => return Err(DeadlineAdvanceErrorV1::MonitorTerminal),
        };
        if next_key.stream_sequence <= current_key.stream_sequence {
            return Err(DeadlineAdvanceErrorV1::SequenceNotAdvanced {
                current: current_key.stream_sequence,
                received: next_key.stream_sequence,
            });
        }
        if next.received_at.is_before(current_receipt) {
            self.terminalize(DeadlineMonitorTerminalV1::superseding_fault(
                DeadlineMonitorTerminalKindV1::SupersedingReceiptRegressed,
                current_key,
                next_key,
            ));
            return Err(DeadlineAdvanceErrorV1::MonitorTerminal);
        }
        let Some(admission_age) = next.received_at.elapsed_at(observed_at) else {
            self.terminalize(DeadlineMonitorTerminalV1::simple(
                DeadlineMonitorTerminalKindV1::ClockRegressed,
                current_key,
            ));
            return Err(DeadlineAdvanceErrorV1::MonitorTerminal);
        };
        if observed_at >= next.deadline {
            let terminal = DeadlineMonitorTerminalV1::deadline(
                DeadlineMonitorTerminalKindV1::SupersedingDeadlineAlreadyExpired,
                current_key,
                &next,
                admission_age,
                admission_age,
                Some(next_key),
            );
            self.terminalize(terminal);
            return Err(DeadlineAdvanceErrorV1::MonitorTerminal);
        }
        let skipped_sequences =
            next_key.stream_sequence.get() - current_key.stream_sequence.get() - 1;
        self.phase = MonitorPhase::Armed(ActiveDeadline {
            ticket: next,
            admission_age,
        });
        self.last_active_key = next_key;
        Ok(DeadlineAdvanceReceiptV1 {
            previous_key: current_key,
            accepted_key: next_key,
            skipped_sequences,
            admission_age,
        })
    }

    fn report_generation_mismatch_at(
        &mut self,
        reported_generation: RuntimeGeneration,
        observed_at: Instant,
    ) -> Result<(), DeadlineControlErrorV1> {
        if self.observe_at(observed_at).is_none() {
            return Err(DeadlineControlErrorV1::MonitorTerminal);
        }
        if reported_generation == self.fixed_generation {
            return Err(DeadlineControlErrorV1::SameGeneration {
                generation: reported_generation,
            });
        }
        self.terminalize(DeadlineMonitorTerminalV1::reported_generation_mismatch(
            self.last_active_key,
            reported_generation,
        ));
        Ok(())
    }

    fn shutdown_at(&mut self, observed_at: Instant) {
        if self.observe_at(observed_at).is_some() {
            self.terminalize(DeadlineMonitorTerminalV1::simple(
                DeadlineMonitorTerminalKindV1::ShutdownAcknowledged,
                self.last_active_key,
            ));
        }
    }

    fn terminalize_worker_panicked(&mut self) {
        self.terminalize(DeadlineMonitorTerminalV1::simple(
            DeadlineMonitorTerminalKindV1::WorkerPanicked,
            self.last_active_key,
        ));
    }

    fn terminalize_synchronization_failure(&mut self) {
        self.terminalize(DeadlineMonitorTerminalV1::synchronization_failed());
    }

    fn terminalize(&mut self, terminal: DeadlineMonitorTerminalV1) {
        if matches!(self.phase, MonitorPhase::Armed(_)) {
            self.phase = MonitorPhase::Terminal(Some(terminal));
        }
    }

    fn take_terminal(&mut self) -> Option<DeadlineMonitorTerminalV1> {
        match &mut self.phase {
            MonitorPhase::Armed(_) => None,
            MonitorPhase::Terminal(terminal) => terminal.take(),
        }
    }

    fn terminal_kind(&self) -> Option<DeadlineMonitorTerminalKindV1> {
        match &self.phase {
            MonitorPhase::Armed(_) | MonitorPhase::Terminal(None) => None,
            MonitorPhase::Terminal(Some(terminal)) => Some(terminal.kind),
        }
    }
}

#[derive(Debug)]
struct SharedMonitor {
    state: Mutex<MonitorState>,
    wake: Condvar,
    #[cfg(test)]
    panic_worker: AtomicBool,
}

impl SharedMonitor {
    fn new(state: MonitorState) -> Self {
        Self {
            state: Mutex::new(state),
            wake: Condvar::new(),
            #[cfg(test)]
            panic_worker: AtomicBool::new(false),
        }
    }
}

fn lock_recovering_synchronization_failure(
    shared: &SharedMonitor,
) -> (MutexGuard<'_, MonitorState>, bool) {
    match shared.state.lock() {
        Ok(state) => (state, false),
        Err(poisoned) => {
            let mut state = poisoned.into_inner();
            state.terminalize_synchronization_failure();
            (state, true)
        }
    }
}

fn publish_worker_panicked(shared: &SharedMonitor) {
    let mut state = match shared.state.lock() {
        Ok(state) => state,
        Err(poisoned) => {
            let mut state = poisoned.into_inner();
            state.terminalize_synchronization_failure();
            drop(state);
            shared.wake.notify_all();
            return;
        }
    };
    state.terminalize_worker_panicked();
    drop(state);
    shared.wake.notify_all();
}

#[cfg(test)]
#[cold]
fn panic_injected_worker() -> ! {
    panic!("injected command deadline worker panic")
}

fn run_worker(shared: &SharedMonitor) {
    let (mut state, poisoned) = lock_recovering_synchronization_failure(shared);
    if poisoned {
        drop(state);
        shared.wake.notify_all();
        return;
    }
    loop {
        #[cfg(test)]
        if shared.panic_worker.swap(false, Ordering::SeqCst) {
            drop(state);
            panic_injected_worker();
        }
        let Some(wait_for) = state.observe_at(Instant::now()) else {
            drop(state);
            shared.wake.notify_all();
            return;
        };
        match shared.wake.wait_timeout(state, wait_for) {
            Ok((next_state, _wait_result)) => state = next_state,
            Err(poisoned_wait) => {
                let (mut poisoned_state, _wait_result) = poisoned_wait.into_inner();
                poisoned_state.terminalize_synchronization_failure();
                drop(poisoned_state);
                shared.wake.notify_all();
                return;
            }
        }
    }
}

/// Unwired one-worker monitor for one fixed command stream.
///
/// The monitor has no reset, refresh, extension, or rearm operation. A terminal
/// monitor must be consumed, and a new generation requires a distinct monitor:
///
/// ```compile_fail
/// use crebain_plant_authority::ActiveCommandDeadlineMonitorV1;
///
/// fn rearm(monitor: &mut ActiveCommandDeadlineMonitorV1) {
///     monitor.rearm();
/// }
/// ```
pub struct ActiveCommandDeadlineMonitorV1 {
    shared: Arc<SharedMonitor>,
    worker: Option<JoinHandle<()>>,
}

impl ActiveCommandDeadlineMonitorV1 {
    /// Starts exactly one named worker around the initial active ticket.
    ///
    /// A ticket already due at startup becomes terminal deadline evidence; the
    /// monitor never starts a fresh interval from worker-start time.
    ///
    /// # Errors
    ///
    /// Returns [`DeadlineMonitorStartErrorV1`] if the owned worker cannot be
    /// created. The error retains the initial key and any terminal reason
    /// computed before the spawn attempt.
    pub fn start(initial: CommandDeadlineTicketV1) -> Result<Self, DeadlineMonitorStartErrorV1> {
        let latest_key = initial.key;
        let state = MonitorState::from_initial_at(initial, Instant::now());
        let initial_terminal_kind = state.terminal_kind();
        let shared = Arc::new(SharedMonitor::new(state));
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name(DEADLINE_WORKER_NAME.to_owned())
            .spawn(move || {
                let outcome = panic::catch_unwind(AssertUnwindSafe(|| run_worker(&worker_shared)));
                if outcome.is_err() {
                    publish_worker_panicked(&worker_shared);
                }
            })
            .map_err(|_| DeadlineMonitorStartErrorV1 {
                initial_key: latest_key,
                initial_terminal_kind,
            })?;
        Ok(Self {
            shared,
            worker: Some(worker),
        })
    }

    /// Replaces the active slot with a separately validated newer ticket.
    ///
    /// Existing terminal/fault and current-deadline checks happen before any
    /// replacement validation. Accepted replacement never changes the fixed
    /// profile, session, or generation.
    ///
    /// # Errors
    ///
    /// Returns [`DeadlineAdvanceErrorV1`] for a terminal monitor or a ticket
    /// that violates fixed identity, strict sequence, or receipt ordering.
    pub fn submit_next(
        &mut self,
        next: CommandDeadlineTicketV1,
    ) -> Result<DeadlineAdvanceReceiptV1, DeadlineAdvanceErrorV1> {
        let (mut state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        let result = state.advance_at(next, Instant::now());
        drop(state);
        self.shared.wake.notify_all();
        result
    }

    /// Terminalizes this fixed monitor when a caller reports a different
    /// lifecycle generation.
    ///
    /// The report is neither authenticated nor an autonomous observation of
    /// lifecycle currentness.
    ///
    /// # Errors
    ///
    /// Returns [`DeadlineControlErrorV1`] when already terminal or when the
    /// supplied generation equals the fixed generation.
    pub fn report_generation_mismatch(
        &mut self,
        reported_generation: RuntimeGeneration,
    ) -> Result<(), DeadlineControlErrorV1> {
        let (mut state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        let result = state.report_generation_mismatch_at(reported_generation, Instant::now());
        drop(state);
        self.shared.wake.notify_all();
        result
    }

    /// Waits until the worker publishes one terminal event and joins it.
    ///
    /// Scheduling starvation can delay this call indefinitely; no latency or
    /// worst-case execution-time claim follows.
    #[must_use = "terminal deadline evidence must be handled explicitly"]
    pub fn wait(mut self) -> DeadlineMonitorTerminalV1 {
        self.join_worker();
        self.take_terminal_or_fault()
    }

    /// Requests terminal shutdown, wakes the worker, joins it, and returns the
    /// event that won the deadline-versus-shutdown race.
    #[must_use = "terminal deadline evidence must be handled explicitly"]
    pub fn shutdown(mut self) -> DeadlineMonitorTerminalV1 {
        self.request_shutdown();
        self.join_worker();
        self.take_terminal_or_fault()
    }

    fn request_shutdown(&self) {
        let (mut state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        state.shutdown_at(Instant::now());
        drop(state);
        self.shared.wake.notify_all();
    }

    fn join_worker(&mut self) {
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                publish_worker_panicked(&self.shared);
            }
        }
    }

    fn take_terminal_or_fault(&self) -> DeadlineMonitorTerminalV1 {
        let (mut state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        let terminal = state.take_terminal();
        drop(state);
        terminal.unwrap_or_else(DeadlineMonitorTerminalV1::synchronization_failed)
    }

    #[cfg(test)]
    fn inject_worker_panic(&self) {
        let (state, _poisoned) = lock_recovering_synchronization_failure(&self.shared);
        self.shared.panic_worker.store(true, Ordering::SeqCst);
        drop(state);
        self.shared.wake.notify_all();
    }
}

impl Drop for ActiveCommandDeadlineMonitorV1 {
    fn drop(&mut self) {
        if self.worker.is_some() {
            self.request_shutdown();
            self.join_worker();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;
    use std::sync::Weak;

    use super::*;
    use crate::contract::{
        CandidateProfileKind, CandidateProfileV1, CommandMetadataV1, CommandProposalV1,
        ProducerEpochIdentity, ProducerTime, ProfileIdentity, ProposedActionV1, RawVelocityV1,
        VelocityFrame, VelocityUnit, DRAFT_L1_MAX_COMMAND_TTL, PLANT_CONTRACT_V1,
    };

    fn generation(value: u64) -> RuntimeGeneration {
        RuntimeGeneration::new(NonZeroU64::new(value).expect("test generation is nonzero"))
    }

    fn profile(byte: u8) -> ProfileIdentity {
        ProfileIdentity::new(CandidateProfileKind::DraftL1SitlLocalNed, [byte; 32])
            .expect("test profile digest is nonzero")
    }

    fn session(byte: u8) -> CommandSessionIdentity {
        CommandSessionIdentity::new([byte; 16]).expect("test session is nonzero")
    }

    fn sequence(value: u64) -> CommandStreamSequence {
        CommandStreamSequence::new(value).expect("test sequence is nonzero")
    }

    fn ticket(
        profile: ProfileIdentity,
        session: CommandSessionIdentity,
        sequence: u64,
        generation: RuntimeGeneration,
        received_at: Instant,
        ttl: Duration,
    ) -> CommandDeadlineTicketV1 {
        CommandDeadlineTicketV1 {
            key: CommandDeadlineKeyV1 {
                profile,
                session,
                stream_sequence: self::sequence(sequence),
                generation,
            },
            received_at: PlantReceiptTime::from_monotonic_test_instant(received_at),
            scheduled_ttl: ttl,
            deadline: received_at
                .checked_add(ttl)
                .expect("test deadline is representable"),
        }
    }

    fn default_ticket(
        sequence: u64,
        received_at: Instant,
        ttl: Duration,
    ) -> CommandDeadlineTicketV1 {
        ticket(
            profile(1),
            session(2),
            sequence,
            generation(3),
            received_at,
            ttl,
        )
    }

    fn with_test_receipt(
        mut ticket: CommandDeadlineTicketV1,
        received_at: Instant,
    ) -> CommandDeadlineTicketV1 {
        ticket.received_at = PlantReceiptTime::from_monotonic_test_instant(received_at);
        ticket.deadline = received_at
            .checked_add(ticket.scheduled_ttl)
            .expect("test deadline is representable");
        ticket
    }

    fn terminal(state: &mut MonitorState) -> DeadlineMonitorTerminalV1 {
        state.take_terminal().expect("test state must be terminal")
    }

    fn validated_candidate_with_sequence(stream_sequence: u64) -> VelocityCommandCandidateV1 {
        let profile_identity = profile(1);
        let candidate_profile = CandidateProfileV1::from_identity(profile_identity);
        let producer_epoch =
            ProducerEpochIdentity::new([7; 16]).expect("test producer epoch is nonzero");
        let metadata = CommandMetadataV1::new(
            PLANT_CONTRACT_V1,
            profile_identity,
            session(2),
            sequence(stream_sequence),
            ProducerTime::new(producer_epoch, Duration::from_secs(1)),
            DRAFT_L1_MAX_COMMAND_TTL,
        );
        let proposal = CommandProposalV1::new(
            metadata,
            ProposedActionV1::Velocity(RawVelocityV1::new(
                VelocityFrame::LocalNed,
                VelocityUnit::MetresPerSecond,
                [0.0; 3],
            )),
        );
        candidate_profile
            .validate_velocity_candidate(&proposal, session(2), generation(3))
            .expect("test command candidate should validate")
    }

    fn validated_candidate() -> VelocityCommandCandidateV1 {
        validated_candidate_with_sequence(1)
    }

    #[test]
    fn ticket_constructor_checks_generation_before_ttl_and_never_extends_request() {
        let candidate = validated_candidate();

        assert_eq!(
            CommandDeadlineTicketV1::try_from_candidate(&candidate, generation(4), Duration::ZERO,)
                .unwrap_err(),
            CommandDeadlineTicketErrorV1::GenerationMismatch {
                candidate: generation(3),
                expected: generation(4),
            }
        );
        assert_eq!(
            CommandDeadlineTicketV1::try_from_candidate(&candidate, generation(3), Duration::ZERO,)
                .unwrap_err(),
            CommandDeadlineTicketErrorV1::ZeroLocalTtlProposal
        );
        let oversized = DRAFT_L1_MAX_COMMAND_TTL + Duration::from_nanos(1);
        assert_eq!(
            CommandDeadlineTicketV1::try_from_candidate(&candidate, generation(3), oversized,)
                .unwrap_err(),
            CommandDeadlineTicketErrorV1::LocalTtlExceedsRequested {
                requested: DRAFT_L1_MAX_COMMAND_TTL,
                proposed: oversized,
            }
        );
    }

    #[test]
    fn ticket_deadline_is_exactly_candidate_receipt_plus_local_proposal() {
        let candidate = validated_candidate();
        let local_proposal = Duration::from_millis(25);
        let receipt = candidate.received_at();
        let ticket =
            CommandDeadlineTicketV1::try_from_candidate(&candidate, generation(3), local_proposal)
                .expect("valid local proposal should create a ticket");

        assert_eq!(ticket.received_at, receipt);
        assert_eq!(
            ticket.deadline,
            receipt.checked_deadline(local_proposal).unwrap()
        );
        assert_eq!(ticket.scheduled_ttl(), local_proposal);
        assert_eq!(ticket.key().stream_sequence(), sequence(1));
    }

    #[test]
    fn public_candidate_tickets_compose_into_strict_replacement() {
        let shared_receipt = Instant::now();
        let initial_candidate = validated_candidate_with_sequence(1);
        let initial = with_test_receipt(
            CommandDeadlineTicketV1::try_from_candidate(
                &initial_candidate,
                generation(3),
                DRAFT_L1_MAX_COMMAND_TTL,
            )
            .expect("initial public ticket should validate"),
            shared_receipt,
        );
        let next_candidate = validated_candidate_with_sequence(2);
        let next = with_test_receipt(
            CommandDeadlineTicketV1::try_from_candidate(
                &next_candidate,
                generation(3),
                DRAFT_L1_MAX_COMMAND_TTL,
            )
            .expect("replacement public ticket should validate"),
            shared_receipt,
        );
        let mut state = MonitorState::from_initial_at(initial, shared_receipt);

        let receipt = state
            .advance_at(next, shared_receipt)
            .expect("public-path replacement should advance the slot");

        assert_eq!(receipt.previous_key().stream_sequence(), sequence(1));
        assert_eq!(receipt.accepted_key().stream_sequence(), sequence(2));
    }

    #[test]
    fn initial_deadline_is_anchored_to_receipt_not_monitor_start() {
        let received_at = Instant::now();
        let ttl = Duration::from_millis(10);
        let started_at = received_at + Duration::from_millis(6);
        let mut state =
            MonitorState::from_initial_at(default_ticket(1, received_at, ttl), started_at);

        assert_eq!(state.observe_at(started_at), Some(Duration::from_millis(4)));
        assert_eq!(state.observe_at(received_at + ttl), None);
        let event = terminal(&mut state);
        let evidence = event
            .deadline_detection()
            .expect("deadline evidence exists");
        assert_eq!(
            event.kind(),
            DeadlineMonitorTerminalKindV1::DeadlineDetected
        );
        assert_eq!(evidence.admission_age(), Duration::from_millis(6));
        assert_eq!(evidence.detected_age(), ttl);
        assert_eq!(evidence.late_by(), Duration::ZERO);
    }

    #[test]
    fn already_expired_initial_ticket_is_immediately_terminal() {
        let received_at = Instant::now();
        let ttl = Duration::from_millis(5);
        let detected_at = received_at + Duration::from_millis(9);
        let mut state =
            MonitorState::from_initial_at(default_ticket(1, received_at, ttl), detected_at);

        let event = terminal(&mut state);
        let evidence = event
            .deadline_detection()
            .expect("deadline evidence exists");
        assert_eq!(evidence.detected_age(), Duration::from_millis(9));
        assert_eq!(evidence.late_by(), Duration::from_millis(4));
    }

    #[test]
    fn initial_clock_regression_is_terminal() {
        let received_at = Instant::now();
        let earlier = received_at
            .checked_sub(Duration::from_nanos(1))
            .expect("test clock has a predecessor");
        let mut state = MonitorState::from_initial_at(
            default_ticket(1, received_at, Duration::from_secs(1)),
            earlier,
        );

        assert_eq!(
            terminal(&mut state).kind(),
            DeadlineMonitorTerminalKindV1::ClockRegressed
        );
    }

    #[test]
    fn observation_clock_regression_is_terminal() {
        let received_at = Instant::now();
        let mut state = MonitorState::from_initial_at(
            default_ticket(1, received_at, Duration::from_secs(1)),
            received_at,
        );
        let earlier = received_at
            .checked_sub(Duration::from_nanos(1))
            .expect("test clock has a predecessor");

        assert_eq!(state.observe_at(earlier), None);
        assert_eq!(
            terminal(&mut state).kind(),
            DeadlineMonitorTerminalKindV1::ClockRegressed
        );
    }

    #[test]
    fn duplicate_or_lower_sequence_cannot_replace_deadline() {
        let received_at = Instant::now();
        let ttl = Duration::from_secs(1);
        let mut duplicate_state =
            MonitorState::from_initial_at(default_ticket(2, received_at, ttl), received_at);
        let duplicate = duplicate_state.advance_at(
            default_ticket(2, received_at + Duration::from_millis(1), ttl),
            received_at + Duration::from_millis(2),
        );
        assert_eq!(
            duplicate.unwrap_err(),
            DeadlineAdvanceErrorV1::SequenceNotAdvanced {
                current: sequence(2),
                received: sequence(2),
            }
        );
        assert_eq!(duplicate_state.observe_at(received_at + ttl), None);

        let mut lower_state =
            MonitorState::from_initial_at(default_ticket(2, received_at, ttl), received_at);
        let lower = lower_state.advance_at(
            default_ticket(1, received_at + Duration::from_millis(1), ttl),
            received_at + Duration::from_millis(2),
        );
        assert!(matches!(
            lower,
            Err(DeadlineAdvanceErrorV1::SequenceNotAdvanced { .. })
        ));
    }

    #[test]
    fn newer_ticket_replaces_one_slot_and_records_gap() {
        let received_at = Instant::now();
        let mut state = MonitorState::from_initial_at(
            default_ticket(1, received_at, Duration::from_millis(20)),
            received_at,
        );
        let next_receipt = received_at + Duration::from_millis(5);
        let receipt = state
            .advance_at(
                default_ticket(4, next_receipt, Duration::from_millis(30)),
                next_receipt + Duration::from_millis(2),
            )
            .expect("strictly newer ticket should advance");

        assert_eq!(receipt.previous_key().stream_sequence(), sequence(1));
        assert_eq!(receipt.accepted_key().stream_sequence(), sequence(4));
        assert_eq!(receipt.skipped_sequences(), 2);
        assert_eq!(receipt.admission_age(), Duration::from_millis(2));
        assert_eq!(
            state.observe_at(next_receipt + Duration::from_millis(29)),
            Some(Duration::from_millis(1))
        );
    }

    #[test]
    fn fixed_identity_mismatches_are_rejected_without_replacement() {
        let now = Instant::now();
        let ttl = Duration::from_secs(1);
        let mut profile_state = MonitorState::from_initial_at(default_ticket(1, now, ttl), now);
        assert!(matches!(
            profile_state.advance_at(
                ticket(profile(9), session(2), 2, generation(3), now, ttl),
                now
            ),
            Err(DeadlineAdvanceErrorV1::ProfileMismatch { .. })
        ));

        let mut session_state = MonitorState::from_initial_at(default_ticket(1, now, ttl), now);
        assert!(matches!(
            session_state.advance_at(
                ticket(profile(1), session(9), 2, generation(3), now, ttl),
                now
            ),
            Err(DeadlineAdvanceErrorV1::SessionMismatch { .. })
        ));

        let mut generation_state = MonitorState::from_initial_at(default_ticket(1, now, ttl), now);
        assert!(matches!(
            generation_state.advance_at(
                ticket(profile(1), session(2), 2, generation(9), now, ttl),
                now
            ),
            Err(DeadlineAdvanceErrorV1::GenerationMismatch { .. })
        ));
    }

    #[test]
    fn newer_sequence_with_regressing_receipt_terminalizes() {
        let received_at = Instant::now();
        let earlier = received_at
            .checked_sub(Duration::from_millis(1))
            .expect("test clock has a predecessor");
        let mut state = MonitorState::from_initial_at(
            default_ticket(1, received_at, Duration::from_secs(1)),
            received_at,
        );

        assert_eq!(
            state
                .advance_at(
                    default_ticket(2, earlier, Duration::from_secs(1)),
                    received_at
                )
                .unwrap_err(),
            DeadlineAdvanceErrorV1::MonitorTerminal
        );
        let event = terminal(&mut state);
        assert_eq!(
            event.kind(),
            DeadlineMonitorTerminalKindV1::SupersedingReceiptRegressed
        );
        assert_eq!(
            event
                .active_key()
                .expect("healthy terminalization retains the active key")
                .stream_sequence(),
            sequence(1)
        );
        assert_eq!(
            event
                .superseding_key()
                .expect("regressing replacement key is retained")
                .stream_sequence(),
            sequence(2)
        );
    }

    #[test]
    fn newer_sequence_with_future_receipt_terminalizes_clock_regression() {
        let observed_at = Instant::now();
        let future_receipt = observed_at + Duration::from_millis(1);
        let mut state = MonitorState::from_initial_at(
            default_ticket(1, observed_at, Duration::from_secs(1)),
            observed_at,
        );

        assert_eq!(
            state
                .advance_at(
                    default_ticket(2, future_receipt, Duration::from_secs(1)),
                    observed_at,
                )
                .unwrap_err(),
            DeadlineAdvanceErrorV1::MonitorTerminal
        );
        assert_eq!(
            terminal(&mut state).kind(),
            DeadlineMonitorTerminalKindV1::ClockRegressed
        );
    }

    #[test]
    fn already_expired_newer_ticket_terminalizes_instead_of_preserving_old_slot() {
        let received_at = Instant::now();
        let mut state = MonitorState::from_initial_at(
            default_ticket(1, received_at, Duration::from_secs(1)),
            received_at,
        );
        let next_receipt = received_at + Duration::from_millis(1);
        let detected_at = next_receipt + Duration::from_millis(10);

        assert_eq!(
            state
                .advance_at(
                    default_ticket(2, next_receipt, Duration::from_millis(5)),
                    detected_at
                )
                .unwrap_err(),
            DeadlineAdvanceErrorV1::MonitorTerminal
        );
        let event = terminal(&mut state);
        assert_eq!(
            event.kind(),
            DeadlineMonitorTerminalKindV1::SupersedingDeadlineAlreadyExpired
        );
        assert_eq!(
            event
                .active_key()
                .expect("healthy terminalization retains the active key")
                .stream_sequence(),
            sequence(1)
        );
        assert_eq!(
            event
                .superseding_key()
                .expect("superseding key exists")
                .stream_sequence(),
            sequence(2)
        );
    }

    #[test]
    fn due_check_precedes_replacement_shutdown_and_generation_report() {
        let received_at = Instant::now();
        let ttl = Duration::from_millis(10);
        let due_at = received_at + ttl;

        let mut replacement =
            MonitorState::from_initial_at(default_ticket(1, received_at, ttl), received_at);
        assert_eq!(
            replacement
                .advance_at(default_ticket(2, due_at, ttl), due_at)
                .unwrap_err(),
            DeadlineAdvanceErrorV1::MonitorTerminal
        );
        assert_eq!(
            terminal(&mut replacement).kind(),
            DeadlineMonitorTerminalKindV1::DeadlineDetected
        );

        let mut shutdown =
            MonitorState::from_initial_at(default_ticket(1, received_at, ttl), received_at);
        shutdown.shutdown_at(due_at);
        assert_eq!(
            terminal(&mut shutdown).kind(),
            DeadlineMonitorTerminalKindV1::DeadlineDetected
        );

        let mut generation_report =
            MonitorState::from_initial_at(default_ticket(1, received_at, ttl), received_at);
        assert_eq!(
            generation_report
                .report_generation_mismatch_at(generation(4), due_at)
                .unwrap_err(),
            DeadlineControlErrorV1::MonitorTerminal
        );
        assert_eq!(
            terminal(&mut generation_report).kind(),
            DeadlineMonitorTerminalKindV1::DeadlineDetected
        );
    }

    #[test]
    fn reported_generation_mismatch_is_terminal_and_same_generation_is_not() {
        let now = Instant::now();
        let mut state =
            MonitorState::from_initial_at(default_ticket(1, now, Duration::from_secs(1)), now);
        assert_eq!(
            state
                .report_generation_mismatch_at(generation(3), now)
                .unwrap_err(),
            DeadlineControlErrorV1::SameGeneration {
                generation: generation(3)
            }
        );
        state
            .report_generation_mismatch_at(generation(4), now)
            .expect("a differing caller report should terminalize");
        let event = terminal(&mut state);
        assert_eq!(
            event.kind(),
            DeadlineMonitorTerminalKindV1::ReportedGenerationMismatch
        );
        assert_eq!(event.reported_generation(), Some(generation(4)));
    }

    #[test]
    fn terminal_state_is_immutable() {
        let now = Instant::now();
        let mut state =
            MonitorState::from_initial_at(default_ticket(1, now, Duration::from_secs(1)), now);
        state.shutdown_at(now);
        state.terminalize_worker_panicked();

        assert_eq!(
            terminal(&mut state).kind(),
            DeadlineMonitorTerminalKindV1::ShutdownAcknowledged
        );
    }

    #[test]
    fn start_error_retains_initial_key_and_precomputed_terminal_kind() {
        let now = Instant::now();
        let key = default_ticket(1, now, Duration::from_millis(1)).key();
        let error = DeadlineMonitorStartErrorV1 {
            initial_key: key,
            initial_terminal_kind: Some(DeadlineMonitorTerminalKindV1::DeadlineDetected),
        };

        assert_eq!(error.initial_key(), key);
        assert_eq!(
            error.initial_terminal_kind(),
            Some(DeadlineMonitorTerminalKindV1::DeadlineDetected)
        );
    }

    #[test]
    fn real_worker_detects_deadline_without_polling() {
        let candidate = validated_candidate();
        let ticket = CommandDeadlineTicketV1::try_from_candidate(
            &candidate,
            generation(3),
            Duration::from_millis(2),
        )
        .expect("public candidate path should create a ticket");
        let monitor =
            ActiveCommandDeadlineMonitorV1::start(ticket).expect("test worker should start");

        assert_eq!(
            monitor.wait().kind(),
            DeadlineMonitorTerminalKindV1::DeadlineDetected
        );
    }

    #[test]
    fn replacement_wakes_worker_and_moves_detection_to_new_ticket() {
        let now = Instant::now();
        let mut monitor =
            ActiveCommandDeadlineMonitorV1::start(default_ticket(1, now, Duration::from_secs(60)))
                .expect("test worker should start");
        let next_receipt = Instant::now();
        monitor
            .submit_next(default_ticket(2, next_receipt, Duration::from_secs(1)))
            .expect("newer ticket should replace the active slot");

        let event = monitor.wait();
        assert_eq!(
            event.kind(),
            DeadlineMonitorTerminalKindV1::DeadlineDetected
        );
        assert_eq!(
            event
                .deadline_detection()
                .expect("replacement deadline evidence exists")
                .key()
                .stream_sequence(),
            sequence(2)
        );
    }

    #[test]
    fn shutdown_wakes_and_joins_long_waiting_worker() {
        let now = Instant::now();
        let monitor =
            ActiveCommandDeadlineMonitorV1::start(default_ticket(1, now, Duration::from_secs(60)))
                .expect("test worker should start");

        assert_eq!(
            monitor.shutdown().kind(),
            DeadlineMonitorTerminalKindV1::ShutdownAcknowledged
        );
    }

    #[test]
    fn reported_generation_mismatch_wakes_worker() {
        let now = Instant::now();
        let mut monitor =
            ActiveCommandDeadlineMonitorV1::start(default_ticket(1, now, Duration::from_secs(60)))
                .expect("test worker should start");
        monitor
            .report_generation_mismatch(generation(4))
            .expect("a differing caller report should terminalize");

        assert_eq!(
            monitor.wait().kind(),
            DeadlineMonitorTerminalKindV1::ReportedGenerationMismatch
        );
    }

    #[test]
    fn drop_wakes_and_joins_without_detaching_worker() {
        let now = Instant::now();
        let monitor =
            ActiveCommandDeadlineMonitorV1::start(default_ticket(1, now, Duration::from_secs(60)))
                .expect("test worker should start");
        let weak: Weak<SharedMonitor> = Arc::downgrade(&monitor.shared);

        drop(monitor);

        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn poisoned_state_becomes_explicit_terminal_fault() {
        let now = Instant::now();
        let monitor =
            ActiveCommandDeadlineMonitorV1::start(default_ticket(1, now, Duration::from_secs(60)))
                .expect("test worker should start");
        let shared = Arc::clone(&monitor.shared);
        let poisoner = thread::spawn(move || {
            let _guard = shared.state.lock().expect("test lock should start healthy");
            panic!("intentional test poison");
        });
        assert!(poisoner.join().is_err());
        monitor.shared.wake.notify_all();

        let event = monitor.wait();
        assert_eq!(
            event.kind(),
            DeadlineMonitorTerminalKindV1::SynchronizationFailed
        );
        assert_eq!(event.active_key(), None);
    }

    #[test]
    fn worker_panic_becomes_explicit_terminal_fault() {
        let now = Instant::now();
        let monitor =
            ActiveCommandDeadlineMonitorV1::start(default_ticket(1, now, Duration::from_secs(60)))
                .expect("test worker should start");
        monitor.inject_worker_panic();

        let event = monitor.wait();
        assert_eq!(event.kind(), DeadlineMonitorTerminalKindV1::WorkerPanicked);
        assert!(event.active_key().is_some());
    }
}
