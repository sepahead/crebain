//! Explicit runtime lifecycle with generation-guarded events.

use std::fmt;
use std::num::NonZeroU64;

/// Nonzero generation guarding all lifecycle events for one runtime epoch.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct RuntimeGeneration(NonZeroU64);

impl RuntimeGeneration {
    /// Creates a generation from a nonzero integer.
    #[must_use]
    pub const fn new(value: NonZeroU64) -> Self {
        Self(value)
    }

    /// Returns the integer representation.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0.get()
    }

    fn checked_next(self) -> Option<Self> {
        self.get()
            .checked_add(1)
            .and_then(NonZeroU64::new)
            .map(Self)
    }
}

/// Explicit plant lifecycle state.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PlantState {
    /// Process-local foundations are being initialized.
    Boot,
    /// No authority may be exercised.
    NoAuthority,
    /// Foundations are ready but no preflight is in progress.
    Standby,
    /// Preconditions are being evaluated by future profile-specific code.
    Preflight,
    /// Authority exists only for a physical hold, not motion.
    AuthorizedHold,
    /// Future typed actions may be applied after all later gates exist.
    Active,
    /// A degraded condition requires narrowed or inhibited behavior.
    Degraded,
    /// A sticky safety condition requires future profile-specific handling.
    Emergency,
    /// Terminal process state.
    Shutdown,
}

/// Input to the lifecycle machine.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum LifecycleEvent {
    /// Inert process initialization completed.
    BootCompleted,
    /// A future authority component requested standby.
    StandbyRequested,
    /// A future authority component requested preflight evaluation.
    PreflightRequested,
    /// A future authority path completed all preflight authorization.
    AuthorizationGranted,
    /// A future authority path requested transition from hold to active.
    ActivationRequested,
    /// Trusted health became degraded.
    HealthDegraded,
    /// Degraded conditions cleared but fresh authorization is still required.
    DegradationCleared,
    /// Authority was revoked; queued events from the old generation become stale.
    AuthorityRevoked,
    /// A sticky safety cause was raised.
    EmergencyLatched,
    /// Headless shutdown was requested.
    ShutdownRequested,
}

/// Lifecycle event paired with its required runtime generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GuardedEvent {
    /// Generation observed by the event producer.
    pub generation: RuntimeGeneration,
    /// Requested lifecycle transition.
    pub event: LifecycleEvent,
}

/// Successful lifecycle transition receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Transition {
    /// State before the event.
    pub from: PlantState,
    /// State after the event.
    pub to: PlantState,
    /// Generation that admitted the event.
    pub admitted_generation: RuntimeGeneration,
    /// Generation guarding the next event.
    pub next_generation: RuntimeGeneration,
}

/// Lifecycle transition rejection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleError {
    /// The event was produced for an invalidated runtime generation.
    StaleGeneration {
        /// Generation expected by the machine.
        expected: RuntimeGeneration,
        /// Generation supplied with the event.
        received: RuntimeGeneration,
    },
    /// The event is not permitted from the current state.
    InvalidTransition {
        /// Current state.
        state: PlantState,
        /// Rejected event.
        event: LifecycleEvent,
        /// State selected by the fail-closed transition.
        fail_closed_state: PlantState,
        /// Generation guarding recovery after the rejection.
        next_generation: RuntimeGeneration,
    },
    /// The generation counter cannot rotate without reusing an old value.
    GenerationExhausted {
        /// State in which rotation was required.
        state: PlantState,
        /// Event that required rotation.
        event: LifecycleEvent,
    },
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StaleGeneration { expected, received } => write!(
                formatter,
                "stale lifecycle generation {}; expected {}",
                received.get(),
                expected.get()
            ),
            Self::InvalidTransition {
                state,
                event,
                fail_closed_state,
                ..
            } => {
                write!(
                    formatter,
                    "event {event:?} is invalid from {state:?}; failed closed to {fail_closed_state:?}"
                )
            }
            Self::GenerationExhausted { state, event } => write!(
                formatter,
                "event {event:?} exhausted lifecycle generations from {state:?}; latched Emergency"
            ),
        }
    }
}

impl std::error::Error for LifecycleError {}

/// Deterministic lifecycle machine. It performs no I/O and owns no adapter.
#[derive(Debug)]
pub struct LifecycleMachine {
    state: PlantState,
    generation: RuntimeGeneration,
}

impl LifecycleMachine {
    /// Creates a machine in [`PlantState::Boot`].
    #[must_use]
    pub const fn new(generation: RuntimeGeneration) -> Self {
        Self {
            state: PlantState::Boot,
            generation,
        }
    }

    /// Returns the current lifecycle state.
    #[must_use]
    pub const fn state(&self) -> PlantState {
        self.state
    }

    /// Returns the generation required by the next event.
    #[must_use]
    pub const fn generation(&self) -> RuntimeGeneration {
        self.generation
    }

    /// Applies one event when its generation and transition are valid.
    ///
    /// Revocation and shutdown rotate the generation when a successor is
    /// representable, invalidating already queued events from the previous
    /// process-local epoch. [`PlantState::Shutdown`] is terminal and immutable;
    /// at the maximum generation it remains terminal without wrapping.
    ///
    /// # Errors
    ///
    /// Returns [`LifecycleError::StaleGeneration`] for a generation mismatch or
    /// [`LifecycleError::InvalidTransition`] for a disallowed state edge.
    /// Returns [`LifecycleError::GenerationExhausted`] when a nonterminal
    /// fail-closed transition cannot rotate without reusing a generation.
    pub fn apply(&mut self, guarded: GuardedEvent) -> Result<Transition, LifecycleError> {
        if guarded.generation != self.generation {
            return Err(LifecycleError::StaleGeneration {
                expected: self.generation,
                received: guarded.generation,
            });
        }

        let from = self.state;
        let Some((to, rotate_generation)) = transition(from, guarded.event) else {
            if from == PlantState::Shutdown {
                return Err(LifecycleError::InvalidTransition {
                    state: from,
                    event: guarded.event,
                    fail_closed_state: PlantState::Shutdown,
                    next_generation: self.generation,
                });
            }
            let mut fail_closed_state = match from {
                PlantState::Emergency => PlantState::Emergency,
                _ => PlantState::NoAuthority,
            };
            self.state = fail_closed_state;
            if let Some(next_generation) = self.generation.checked_next() {
                self.generation = next_generation;
            } else {
                fail_closed_state = PlantState::Emergency;
                self.state = fail_closed_state;
            }
            return Err(LifecycleError::InvalidTransition {
                state: from,
                event: guarded.event,
                fail_closed_state,
                next_generation: self.generation,
            });
        };
        self.state = to;
        let admitted_generation = self.generation;
        if rotate_generation {
            if let Some(next_generation) = self.generation.checked_next() {
                self.generation = next_generation;
            } else if to != PlantState::Shutdown {
                self.state = PlantState::Emergency;
                return Err(LifecycleError::GenerationExhausted {
                    state: from,
                    event: guarded.event,
                });
            }
        }
        Ok(Transition {
            from,
            to,
            admitted_generation,
            next_generation: self.generation,
        })
    }
}

const fn transition(state: PlantState, event: LifecycleEvent) -> Option<(PlantState, bool)> {
    use LifecycleEvent::{
        ActivationRequested, AuthorityRevoked, AuthorizationGranted, BootCompleted,
        DegradationCleared, EmergencyLatched, HealthDegraded, PreflightRequested,
        ShutdownRequested, StandbyRequested,
    };
    use PlantState::{
        Active, AuthorizedHold, Boot, Degraded, Emergency, NoAuthority, Preflight, Shutdown,
        Standby,
    };

    match (state, event) {
        (Shutdown, _) => None,
        (_, ShutdownRequested) => Some((Shutdown, true)),
        (_, EmergencyLatched) => Some((Emergency, false)),
        (Boot, BootCompleted) => Some((NoAuthority, false)),
        (NoAuthority, StandbyRequested) => Some((Standby, false)),
        (Standby, PreflightRequested) => Some((Preflight, false)),
        (Preflight, AuthorizationGranted) => Some((AuthorizedHold, false)),
        (AuthorizedHold, ActivationRequested) => Some((Active, false)),
        (AuthorizedHold | Active, HealthDegraded) => Some((Degraded, false)),
        (Degraded, DegradationCleared) => Some((NoAuthority, true)),
        (Standby | Preflight | AuthorizedHold | Active | Degraded, AuthorityRevoked) => {
            Some((NoAuthority, true))
        }
        _ => None,
    }
}
