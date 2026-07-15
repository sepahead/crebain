use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use crate::common::image::{MAX_BASE64_IMAGE_CHARS, MAX_IMAGE_SIZE_BYTES};

/// Weighted process-memory envelope for native camera ingress. A single
/// maximum-size frame needs substantially more than its decoded 64 MiB while
/// the transport retains wire, parsed/materialized, and IPC-base64 forms.
const CAMERA_WORK_BUDGET_BYTES: usize = 384 * 1024 * 1024;
/// Bounded serde `Value` containers and camera metadata are small beside the
/// image string, but charging them explicitly keeps the estimate conservative.
const ROSBRIDGE_JSON_BOOKKEEPING_BYTES: usize = 1024 * 1024;
const CAMERA_CALLBACK_BOOKKEEPING_BYTES: usize = 64 * 1024;

#[derive(Debug)]
struct CameraWorkBudgetInner {
    capacity_bytes: usize,
    in_flight_bytes: AtomicUsize,
}

/// Shared nonblocking admission control for native camera work.
///
/// A permit is held from before payload materialization through the renderer's
/// exact pull acknowledgement or bounded delivery cleanup. Admission drops a
/// new frame when its conservative weight would exceed the envelope; camera
/// ingress never waits while retaining wire bytes.
#[derive(Clone, Debug)]
pub(crate) struct CameraWorkBudget {
    inner: Arc<CameraWorkBudgetInner>,
}

impl Default for CameraWorkBudget {
    fn default() -> Self {
        Self::with_capacity(CAMERA_WORK_BUDGET_BYTES)
    }
}

/// Return the process-wide native camera-work budget shared by both transport
/// backends and by overlapping connection generations during teardown.
pub(crate) fn shared_camera_work_budget() -> CameraWorkBudget {
    static BUDGET: OnceLock<CameraWorkBudget> = OnceLock::new();
    BUDGET.get_or_init(CameraWorkBudget::default).clone()
}

impl CameraWorkBudget {
    fn with_capacity(capacity_bytes: usize) -> Self {
        Self {
            inner: Arc::new(CameraWorkBudgetInner {
                capacity_bytes,
                in_flight_bytes: AtomicUsize::new(0),
            }),
        }
    }

    /// Charge retained WebSocket text, its parsed JSON representation, a
    /// worst-case decoded image, the base64 output carried into the callback,
    /// and bounded container metadata.
    pub(crate) fn try_reserve_rosbridge(&self, wire_bytes: usize) -> Option<CameraWorkPermit> {
        let encoded_bytes = wire_bytes.min(MAX_BASE64_IMAGE_CHARS);
        let decoded_bytes = decoded_upper_bound(encoded_bytes)?.min(MAX_IMAGE_SIZE_BYTES);
        let weight = wire_bytes
            .checked_mul(2)?
            .checked_add(decoded_bytes)?
            .checked_add(encoded_bytes)?
            .checked_add(ROSBRIDGE_JSON_BOOKKEEPING_BYTES)?
            .checked_add(CAMERA_CALLBACK_BOOKKEEPING_BYTES)?;
        self.try_reserve(weight)
    }

    /// Charge the retained Zenoh payload, its materialized CDR bytes, the
    /// embedded image bytes, the frame plus callback-serialization base64
    /// forms, and metadata.
    #[cfg(any(feature = "zenoh-transport", test))]
    pub(crate) fn try_reserve_zenoh(&self, cdr_bytes: usize) -> Option<CameraWorkPermit> {
        let image_bytes = cdr_bytes.min(MAX_IMAGE_SIZE_BYTES);
        let base64_bytes = base64_encoded_len(image_bytes)?;
        let weight = cdr_bytes
            .checked_mul(2)?
            .checked_add(image_bytes)?
            .checked_add(base64_bytes.checked_mul(2)?)?
            .checked_add(CAMERA_CALLBACK_BOOKKEEPING_BYTES)?;
        self.try_reserve(weight)
    }

    fn try_reserve(&self, weight_bytes: usize) -> Option<CameraWorkPermit> {
        if weight_bytes > self.inner.capacity_bytes {
            return None;
        }

        let mut current = self.inner.in_flight_bytes.load(Ordering::Acquire);
        loop {
            let next = current.checked_add(weight_bytes)?;
            if next > self.inner.capacity_bytes {
                return None;
            }
            match self.inner.in_flight_bytes.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(CameraWorkPermit {
                        inner: Arc::clone(&self.inner),
                        weight_bytes,
                    });
                }
                Err(observed) => current = observed,
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn test_with_capacity(capacity_bytes: usize) -> Self {
        Self::with_capacity(capacity_bytes)
    }

    #[cfg(test)]
    pub(crate) fn in_flight_bytes(&self) -> usize {
        self.inner.in_flight_bytes.load(Ordering::Acquire)
    }
}

/// Owned reservation released when its delivery is rejected, acknowledged,
/// retired or expired, or dropped during panic unwinding.
#[derive(Debug)]
pub(crate) struct CameraWorkPermit {
    inner: Arc<CameraWorkBudgetInner>,
    weight_bytes: usize,
}

impl Drop for CameraWorkPermit {
    fn drop(&mut self) {
        let previous = self
            .inner
            .in_flight_bytes
            .fetch_sub(self.weight_bytes, Ordering::AcqRel);
        debug_assert!(previous >= self.weight_bytes);
    }
}

fn decoded_upper_bound(base64_bytes: usize) -> Option<usize> {
    base64_bytes.div_ceil(4).checked_mul(3)
}

#[cfg(any(feature = "zenoh-transport", test))]
fn base64_encoded_len(binary_bytes: usize) -> Option<usize> {
    binary_bytes.div_ceil(3).checked_mul(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_weight_is_admitted_and_one_byte_less_capacity_is_rejected() {
        let probe = CameraWorkBudget::with_capacity(usize::MAX);
        let permit = probe.try_reserve_rosbridge(4096).unwrap();
        let exact_weight = probe.in_flight_bytes();
        drop(permit);

        let exact = CameraWorkBudget::with_capacity(exact_weight);
        assert!(exact.try_reserve_rosbridge(4096).is_some());

        let under = CameraWorkBudget::with_capacity(exact_weight - 1);
        assert!(under.try_reserve_rosbridge(4096).is_none());
    }

    #[test]
    fn two_maximum_rosbridge_topics_cannot_run_together() {
        let budget = CameraWorkBudget::default();
        let maximum_wire_bytes = MAX_BASE64_IMAGE_CHARS + 64 * 1024;
        let first_topic = budget.try_reserve_rosbridge(maximum_wire_bytes).unwrap();

        assert!(budget.try_reserve_rosbridge(maximum_wire_bytes).is_none());
        drop(first_topic);
        assert!(budget.try_reserve_rosbridge(maximum_wire_bytes).is_some());
    }

    #[test]
    fn two_maximum_zenoh_topics_cannot_run_together() {
        let budget = CameraWorkBudget::default();
        let maximum_cdr_bytes = MAX_IMAGE_SIZE_BYTES + 2 * 4096 + 64;
        let first_topic = budget.try_reserve_zenoh(maximum_cdr_bytes).unwrap();

        assert!(budget.try_reserve_zenoh(maximum_cdr_bytes).is_none());
        drop(first_topic);
        assert!(budget.try_reserve_zenoh(maximum_cdr_bytes).is_some());
    }

    #[test]
    fn rosbridge_and_zenoh_clones_share_one_envelope() {
        let rosbridge_budget = CameraWorkBudget::default();
        let zenoh_budget = rosbridge_budget.clone();
        let maximum_wire_bytes = MAX_BASE64_IMAGE_CHARS + 64 * 1024;
        let _rosbridge_permit = rosbridge_budget
            .try_reserve_rosbridge(maximum_wire_bytes)
            .unwrap();

        assert!(zenoh_budget
            .try_reserve_zenoh(MAX_IMAGE_SIZE_BYTES + 2 * 4096 + 64)
            .is_none());
    }

    #[test]
    fn panic_unwinding_releases_weight() {
        let budget = CameraWorkBudget::default();
        let panic_budget = budget.clone();

        let result = std::panic::catch_unwind(move || {
            let _permit = panic_budget.try_reserve_zenoh(1024).unwrap();
            panic!("simulated camera callback panic");
        });

        assert!(result.is_err());
        assert_eq!(budget.in_flight_bytes(), 0);
    }

    #[test]
    fn arithmetic_overflow_fails_closed() {
        let budget = CameraWorkBudget::with_capacity(usize::MAX);

        assert!(budget.try_reserve_rosbridge(usize::MAX).is_none());
        assert!(budget.try_reserve_zenoh(usize::MAX).is_none());
    }
}
