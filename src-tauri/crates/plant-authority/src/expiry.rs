//! Passive, process-local monotonic expiry mechanics.
//!
//! This module does not schedule work, accept a command, refresh authority,
//! choose a safe action, or call an adapter. It only classifies one locally
//! armed interval against the process monotonic clock and lifecycle generation.

use std::fmt;
use std::time::{Duration, Instant};

use crate::RuntimeGeneration;

/// Configuration failure while creating a passive expiry guard.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExpiryConfigurationError {
    /// A zero-length interval cannot authorize even an instantaneous use.
    ZeroTtl,
    /// The locally approved interval cannot be represented by the monotonic clock.
    UnrepresentableDeadline,
}

impl fmt::Display for ExpiryConfigurationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroTtl => formatter.write_str("expiry interval must be nonzero"),
            Self::UnrepresentableDeadline => {
                formatter.write_str("expiry deadline is not representable by the monotonic clock")
            }
        }
    }
}

impl std::error::Error for ExpiryConfigurationError {}

/// Result of evaluating one passive monotonic expiry guard.
///
/// Every variant other than [`Self::Fresh`] is fail-closed input for future
/// policy code. This type deliberately carries no safe-action selection.
#[must_use = "expiry status must be handled explicitly"]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExpiryStatus {
    /// The interval remains valid for the returned local duration.
    Fresh {
        /// Time remaining before the exclusive deadline.
        remaining: Duration,
    },
    /// The exclusive deadline has been reached or passed.
    Expired,
    /// The lifecycle generation that armed the interval is no longer current.
    StaleGeneration {
        /// Generation captured when the interval was armed.
        expected: RuntimeGeneration,
        /// Generation supplied by the evaluator.
        received: RuntimeGeneration,
    },
    /// The observed monotonic instant precedes the arming instant.
    ClockRegressed,
}

/// One immutable, process-local monotonic expiry interval.
///
/// The valid interval is half-open: `[armed_at, deadline)`. The guard has no
/// refresh or extension operation; a future caller must create a distinct guard
/// only after separately validating a new command and locally approved TTL.
#[derive(Debug)]
pub struct MonotonicExpiryGuard {
    generation: RuntimeGeneration,
    armed_at: Instant,
    deadline: Instant,
}

impl MonotonicExpiryGuard {
    /// Arms a passive interval from the current process monotonic instant.
    ///
    /// # Errors
    ///
    /// Returns [`ExpiryConfigurationError::ZeroTtl`] for an empty interval or
    /// [`ExpiryConfigurationError::UnrepresentableDeadline`] when adding the
    /// interval would exceed the platform monotonic clock representation.
    pub fn arm(
        generation: RuntimeGeneration,
        locally_approved_ttl: Duration,
    ) -> Result<Self, ExpiryConfigurationError> {
        Self::arm_at(generation, locally_approved_ttl, Instant::now())
    }

    /// Classifies the interval at the current process monotonic instant.
    pub fn evaluate(&self, current_generation: RuntimeGeneration) -> ExpiryStatus {
        self.evaluate_at(current_generation, Instant::now())
    }

    fn arm_at(
        generation: RuntimeGeneration,
        locally_approved_ttl: Duration,
        armed_at: Instant,
    ) -> Result<Self, ExpiryConfigurationError> {
        if locally_approved_ttl.is_zero() {
            return Err(ExpiryConfigurationError::ZeroTtl);
        }
        let deadline = armed_at
            .checked_add(locally_approved_ttl)
            .ok_or(ExpiryConfigurationError::UnrepresentableDeadline)?;
        Ok(Self {
            generation,
            armed_at,
            deadline,
        })
    }

    fn evaluate_at(
        &self,
        current_generation: RuntimeGeneration,
        observed_at: Instant,
    ) -> ExpiryStatus {
        if current_generation != self.generation {
            return ExpiryStatus::StaleGeneration {
                expected: self.generation,
                received: current_generation,
            };
        }
        if observed_at < self.armed_at {
            return ExpiryStatus::ClockRegressed;
        }
        if observed_at >= self.deadline {
            return ExpiryStatus::Expired;
        }
        ExpiryStatus::Fresh {
            remaining: self.deadline.duration_since(observed_at),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use super::*;

    fn generation(value: u64) -> RuntimeGeneration {
        RuntimeGeneration::new(NonZeroU64::new(value).expect("test generation is nonzero"))
    }

    #[test]
    fn expiry_guard_should_reject_zero_ttl() {
        let result = MonotonicExpiryGuard::arm_at(generation(1), Duration::ZERO, Instant::now());

        assert_eq!(result.unwrap_err(), ExpiryConfigurationError::ZeroTtl);
    }

    #[test]
    fn expiry_guard_should_reject_unrepresentable_deadline() {
        let result = MonotonicExpiryGuard::arm_at(generation(1), Duration::MAX, Instant::now());

        assert_eq!(
            result.unwrap_err(),
            ExpiryConfigurationError::UnrepresentableDeadline
        );
    }

    #[test]
    fn expiry_guard_should_treat_exact_deadline_as_expired() {
        let armed_at = Instant::now();
        let ttl = Duration::from_nanos(10);
        let guard = MonotonicExpiryGuard::arm_at(generation(3), ttl, armed_at)
            .expect("test interval should be representable");

        assert_eq!(
            guard.evaluate_at(generation(3), armed_at),
            ExpiryStatus::Fresh { remaining: ttl }
        );
        assert_eq!(
            guard.evaluate_at(generation(3), armed_at + Duration::from_nanos(9)),
            ExpiryStatus::Fresh {
                remaining: Duration::from_nanos(1)
            }
        );
        assert_eq!(
            guard.evaluate_at(generation(3), armed_at + ttl),
            ExpiryStatus::Expired
        );
        assert_eq!(
            guard.evaluate_at(generation(3), armed_at + ttl + Duration::from_secs(1)),
            ExpiryStatus::Expired
        );
    }

    #[test]
    fn expiry_guard_should_fail_closed_on_clock_regression() {
        let armed_at = Instant::now();
        let guard = MonotonicExpiryGuard::arm_at(generation(5), Duration::from_secs(1), armed_at)
            .expect("test interval should be representable");
        let earlier = armed_at
            .checked_sub(Duration::from_nanos(1))
            .expect("current instant should have a predecessor");

        assert_eq!(
            guard.evaluate_at(generation(5), earlier),
            ExpiryStatus::ClockRegressed
        );
    }

    #[test]
    fn expiry_guard_should_reject_rotated_generation_before_time_checks() {
        let armed_at = Instant::now();
        let guard = MonotonicExpiryGuard::arm_at(generation(7), Duration::from_secs(1), armed_at)
            .expect("test interval should be representable");
        let earlier = armed_at
            .checked_sub(Duration::from_nanos(1))
            .expect("current instant should have a predecessor");

        assert_eq!(
            guard.evaluate_at(generation(8), earlier),
            ExpiryStatus::StaleGeneration {
                expected: generation(7),
                received: generation(8)
            }
        );
    }

    #[test]
    fn repeated_evaluation_should_never_extend_the_deadline() {
        let armed_at = Instant::now();
        let guard = MonotonicExpiryGuard::arm_at(generation(9), Duration::from_secs(2), armed_at)
            .expect("test interval should be representable");

        assert_eq!(
            guard.evaluate_at(generation(9), armed_at + Duration::from_secs(1)),
            ExpiryStatus::Fresh {
                remaining: Duration::from_secs(1)
            }
        );
        assert_eq!(
            guard.evaluate_at(generation(9), armed_at + Duration::from_secs(2)),
            ExpiryStatus::Expired
        );
        assert_eq!(
            guard.evaluate_at(generation(9), armed_at + Duration::from_secs(3)),
            ExpiryStatus::Expired
        );
    }
}
