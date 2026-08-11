use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

const TELEMETRY_WORK_BUDGET_BYTES: usize = 32 * 1024 * 1024;
const MAX_CONCURRENT_TELEMETRY_JOBS: usize = 8;
const TELEMETRY_CALLBACK_BOOKKEEPING_BYTES: usize = 64 * 1024;

#[derive(Debug)]
struct TelemetryWorkBudgetInner {
    capacity_bytes: usize,
    max_jobs: usize,
    in_flight_bytes: AtomicUsize,
    in_flight_jobs: AtomicUsize,
}

/// Process-wide, fail-fast admission for non-camera Zenoh materialization,
/// decoding, and callback work.
#[derive(Clone, Debug)]
pub(crate) struct TelemetryWorkBudget {
    inner: Arc<TelemetryWorkBudgetInner>,
}

impl Default for TelemetryWorkBudget {
    fn default() -> Self {
        Self::with_limits(TELEMETRY_WORK_BUDGET_BYTES, MAX_CONCURRENT_TELEMETRY_JOBS)
    }
}

pub(crate) fn shared_telemetry_work_budget() -> TelemetryWorkBudget {
    static BUDGET: OnceLock<TelemetryWorkBudget> = OnceLock::new();
    BUDGET.get_or_init(TelemetryWorkBudget::default).clone()
}

impl TelemetryWorkBudget {
    fn with_limits(capacity_bytes: usize, max_jobs: usize) -> Self {
        Self {
            inner: Arc::new(TelemetryWorkBudgetInner {
                capacity_bytes,
                max_jobs,
                in_flight_bytes: AtomicUsize::new(0),
                in_flight_jobs: AtomicUsize::new(0),
            }),
        }
    }

    pub(crate) fn try_reserve(&self, payload_bytes: usize) -> Option<TelemetryWorkPermit> {
        let weight_bytes = payload_bytes
            .checked_mul(2)?
            .checked_add(TELEMETRY_CALLBACK_BOOKKEEPING_BYTES)?;
        if weight_bytes > self.inner.capacity_bytes {
            return None;
        }

        let mut jobs = self.inner.in_flight_jobs.load(Ordering::Acquire);
        loop {
            if jobs >= self.inner.max_jobs {
                return None;
            }
            match self.inner.in_flight_jobs.compare_exchange_weak(
                jobs,
                jobs + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => jobs = observed,
            }
        }

        let mut current = self.inner.in_flight_bytes.load(Ordering::Acquire);
        loop {
            let Some(next) = current.checked_add(weight_bytes) else {
                self.inner.in_flight_jobs.fetch_sub(1, Ordering::AcqRel);
                return None;
            };
            if next > self.inner.capacity_bytes {
                self.inner.in_flight_jobs.fetch_sub(1, Ordering::AcqRel);
                return None;
            }
            match self.inner.in_flight_bytes.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(TelemetryWorkPermit {
                        inner: Arc::clone(&self.inner),
                        weight_bytes,
                    });
                }
                Err(observed) => current = observed,
            }
        }
    }

    #[cfg(test)]
    fn in_flight(&self) -> (usize, usize) {
        (
            self.inner.in_flight_bytes.load(Ordering::Acquire),
            self.inner.in_flight_jobs.load(Ordering::Acquire),
        )
    }
}

#[derive(Debug)]
pub(crate) struct TelemetryWorkPermit {
    inner: Arc<TelemetryWorkBudgetInner>,
    weight_bytes: usize,
}

impl Drop for TelemetryWorkPermit {
    fn drop(&mut self) {
        let previous_bytes = self
            .inner
            .in_flight_bytes
            .fetch_sub(self.weight_bytes, Ordering::AcqRel);
        debug_assert!(previous_bytes >= self.weight_bytes);
        let previous_jobs = self.inner.in_flight_jobs.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous_jobs > 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_and_job_limits_fail_fast_and_recover() {
        let budget = TelemetryWorkBudget::with_limits(132 * 1024, 2);
        let first = budget.try_reserve(100).unwrap();
        let second = budget.try_reserve(100).unwrap();
        assert!(budget.try_reserve(1).is_none());
        drop(first);
        assert!(budget.try_reserve(40 * 1024).is_none());
        drop(second);
        assert_eq!(budget.in_flight(), (0, 0));
        assert!(budget.try_reserve(20 * 1024).is_some());
    }

    #[test]
    fn arithmetic_overflow_and_panic_release_fail_closed() {
        let budget = TelemetryWorkBudget::default();
        assert!(budget.try_reserve(usize::MAX).is_none());

        let panic_budget = budget.clone();
        let result = std::panic::catch_unwind(move || {
            let _permit = panic_budget.try_reserve(1024).unwrap();
            panic!("synthetic callback panic");
        });
        assert!(result.is_err());
        assert_eq!(budget.in_flight(), (0, 0));
    }
}
