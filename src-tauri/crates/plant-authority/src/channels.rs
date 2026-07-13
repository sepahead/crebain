//! Bounded communication primitives for the headless authority kernel.

use std::collections::VecDeque;
use std::fmt;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use crate::{GuardedEvent, RuntimeGeneration};

/// Largest logical FIFO capacity accepted by this component foundation.
pub const MAX_BOUNDED_QUEUE_CAPACITY: usize = 65_536;

/// Error returned when a channel cannot read trustworthy shared state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelReadError {
    /// A panic occurred while another operation held the state lock.
    Poisoned,
}

impl fmt::Display for ChannelReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("channel state is poisoned")
    }
}

impl std::error::Error for ChannelReadError {}

/// Error returned when a bounded channel configuration is unsafe.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelConfigurationError {
    /// The requested logical capacity exceeds the audited component limit.
    CapacityTooLarge {
        /// Rejected capacity.
        requested: usize,
        /// Largest accepted capacity.
        maximum: usize,
    },
}

impl fmt::Display for ChannelConfigurationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CapacityTooLarge { requested, maximum } => write!(
                formatter,
                "bounded channel capacity {requested} exceeds maximum {maximum}"
            ),
        }
    }
}

impl std::error::Error for ChannelConfigurationError {}

/// Error returned when a channel cannot admit a submitted value.
#[derive(Debug, Eq, PartialEq)]
pub enum ChannelError<T> {
    /// All receivers were dropped.
    Closed(T),
    /// The bounded queue rejected a new item because it was full.
    Full(T),
    /// A panic poisoned shared state; the value was not admitted.
    Poisoned(T),
    /// Memory for the next queue slot could not be reserved.
    AllocationFailed(T),
    /// Exact monotonic sequence or loss accounting was exhausted.
    CounterExhausted(T),
}

impl<T> fmt::Display for ChannelError<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed(_) => formatter.write_str("channel is closed"),
            Self::Full(_) => formatter.write_str("bounded channel is full"),
            Self::Poisoned(_) => formatter.write_str("channel state is poisoned"),
            Self::AllocationFailed(_) => {
                formatter.write_str("bounded channel could not reserve memory")
            }
            Self::CounterExhausted(_) => formatter.write_str("channel counter is exhausted"),
        }
    }
}

/// Full-queue behavior selected explicitly for each bounded channel.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FullPolicy {
    /// Reject the new item. Used for lifecycle work so loss becomes fail-closed.
    RejectNew,
    /// Remove the oldest item and retain the new one. Used only for evidence.
    DropOldest,
}

#[derive(Debug)]
struct LatestState<T> {
    value: Option<T>,
    sequence: u64,
    overwritten: u64,
    receiver_open: bool,
}

/// Sending endpoint for a capacity-one latest-value channel.
#[derive(Debug)]
pub struct LatestSender<T> {
    shared: Arc<Mutex<LatestState<T>>>,
}

/// Receiving endpoint for a capacity-one latest-value channel.
#[derive(Debug)]
pub struct LatestReceiver<T> {
    shared: Arc<Mutex<LatestState<T>>>,
}

/// Metadata observed while taking the newest value.
#[derive(Debug, Eq, PartialEq)]
pub struct LatestSnapshot<T> {
    /// Most recently submitted value.
    pub value: T,
    /// Exact monotonic per-channel submission sequence.
    pub sequence: u64,
    /// Exact number of unread values overwritten since channel creation.
    pub overwritten: u64,
}

/// Creates a latest-value channel with exactly one retained item.
#[must_use]
pub fn latest_value<T>() -> (LatestSender<T>, LatestReceiver<T>) {
    let shared = Arc::new(Mutex::new(LatestState {
        value: None,
        sequence: 0,
        overwritten: 0,
        receiver_open: true,
    }));
    (
        LatestSender {
            shared: Arc::clone(&shared),
        },
        LatestReceiver { shared },
    )
}

/// Owned endpoints for one typed latest-value path.
#[derive(Debug)]
pub struct LatestChannel<T> {
    /// Producer endpoint. New values replace any unread value.
    pub sender: LatestSender<T>,
    /// Consumer endpoint. At most one value is retained.
    pub receiver: LatestReceiver<T>,
}

impl<T> LatestChannel<T> {
    fn new() -> Self {
        let (sender, receiver) = latest_value();
        Self { sender, receiver }
    }
}

impl<T> LatestSender<T> {
    /// Replaces any unread value and returns the assigned sequence.
    ///
    /// State and accounting are committed under the lock. Any displaced value
    /// is destroyed only after the lock is released.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelError`] with ownership of `value` when the receiver is
    /// closed, shared state is poisoned, or exact counters are exhausted.
    pub fn replace(&self, value: T) -> Result<u64, ChannelError<T>> {
        let (displaced, sequence) = {
            let Ok(mut state) = self.shared.lock() else {
                return Err(ChannelError::Poisoned(value));
            };
            if !state.receiver_open {
                return Err(ChannelError::Closed(value));
            }
            if state.sequence == u64::MAX
                || (state.value.is_some() && state.overwritten == u64::MAX)
            {
                return Err(ChannelError::CounterExhausted(value));
            }

            let displaced = state.value.replace(value);
            if displaced.is_some() {
                state.overwritten += 1;
            }
            state.sequence += 1;
            (displaced, state.sequence)
        };

        // A destructor is arbitrary user code and may unwind. The mutex is no
        // longer held, so committed state cannot be poisoned by that unwind.
        drop(displaced);
        Ok(sequence)
    }
}

impl<T> Clone for LatestSender<T> {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl<T> LatestReceiver<T> {
    /// Takes the newest retained value, if one is present.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelReadError::Poisoned`] when shared state is not
    /// trustworthy.
    pub fn take_latest(&self) -> Result<Option<LatestSnapshot<T>>, ChannelReadError> {
        let mut state = self.shared.lock().map_err(|_| ChannelReadError::Poisoned)?;
        Ok(state.value.take().map(|value| LatestSnapshot {
            value,
            sequence: state.sequence,
            overwritten: state.overwritten,
        }))
    }

    /// Returns whether an unread value is present.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelReadError::Poisoned`] when shared state is not
    /// trustworthy.
    pub fn has_value(&self) -> Result<bool, ChannelReadError> {
        self.shared
            .lock()
            .map(|state| state.value.is_some())
            .map_err(|_| ChannelReadError::Poisoned)
    }
}

impl<T> Drop for LatestReceiver<T> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.lock() {
            state.receiver_open = false;
        }
    }
}

#[derive(Debug)]
struct QueueState<T> {
    values: VecDeque<T>,
    capacity: NonZeroUsize,
    policy: FullPolicy,
    dropped_oldest: u64,
    receiver_open: bool,
}

/// Sending endpoint for a bounded channel with an explicit full policy.
#[derive(Debug)]
pub struct BoundedSender<T> {
    shared: Arc<Mutex<QueueState<T>>>,
    capacity: NonZeroUsize,
}

/// Receiving endpoint for a bounded channel with an explicit full policy.
#[derive(Debug)]
pub struct BoundedReceiver<T> {
    shared: Arc<Mutex<QueueState<T>>>,
}

/// Queue loss accounting returned with each received item.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DropAccounting {
    /// Exact number of oldest items discarded by this channel.
    pub dropped_oldest: u64,
}

/// Creates a bounded queue without eagerly allocating its logical capacity.
///
/// # Errors
///
/// Returns [`ChannelConfigurationError::CapacityTooLarge`] when `capacity`
/// exceeds [`MAX_BOUNDED_QUEUE_CAPACITY`].
pub fn bounded_queue<T>(
    capacity: NonZeroUsize,
    policy: FullPolicy,
) -> Result<(BoundedSender<T>, BoundedReceiver<T>), ChannelConfigurationError> {
    if capacity.get() > MAX_BOUNDED_QUEUE_CAPACITY {
        return Err(ChannelConfigurationError::CapacityTooLarge {
            requested: capacity.get(),
            maximum: MAX_BOUNDED_QUEUE_CAPACITY,
        });
    }
    let shared = Arc::new(Mutex::new(QueueState {
        values: VecDeque::new(),
        capacity,
        policy,
        dropped_oldest: 0,
        receiver_open: true,
    }));
    Ok((
        BoundedSender {
            shared: Arc::clone(&shared),
            capacity,
        },
        BoundedReceiver { shared },
    ))
}

/// Owned endpoints for one typed bounded FIFO path.
#[derive(Debug)]
pub struct QueueChannel<T> {
    /// Producer endpoint.
    pub sender: BoundedSender<T>,
    /// Consumer endpoint.
    pub receiver: BoundedReceiver<T>,
}

impl<T> QueueChannel<T> {
    fn new(capacity: NonZeroUsize, policy: FullPolicy) -> Result<Self, ChannelConfigurationError> {
        let (sender, receiver) = bounded_queue(capacity, policy)?;
        Ok(Self { sender, receiver })
    }
}

impl<T> BoundedSender<T> {
    /// Enqueues `value` according to the channel's declared full policy.
    ///
    /// A displaced drop-oldest value is destroyed only after state, loss
    /// accounting, and the replacement value are committed and unlocked.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelError`] with ownership of `value` when the receiver is
    /// closed, the queue rejects new work, shared state is poisoned, memory
    /// cannot be reserved, or exact loss accounting is exhausted.
    pub fn try_send(&self, value: T) -> Result<DropAccounting, ChannelError<T>> {
        let (displaced, accounting) = {
            let Ok(mut state) = self.shared.lock() else {
                return Err(ChannelError::Poisoned(value));
            };
            if !state.receiver_open {
                return Err(ChannelError::Closed(value));
            }

            let displaced = if state.values.len() == state.capacity.get() {
                match state.policy {
                    FullPolicy::RejectNew => return Err(ChannelError::Full(value)),
                    FullPolicy::DropOldest => {
                        if state.dropped_oldest == u64::MAX {
                            return Err(ChannelError::CounterExhausted(value));
                        }
                        let displaced = state.values.pop_front();
                        state.dropped_oldest += 1;
                        displaced
                    }
                }
            } else {
                if state.values.len() == state.values.capacity()
                    && state.values.try_reserve(1).is_err()
                {
                    return Err(ChannelError::AllocationFailed(value));
                }
                None
            };

            state.values.push_back(value);
            let accounting = DropAccounting {
                dropped_oldest: state.dropped_oldest,
            };
            (displaced, accounting)
        };

        // A destructor is arbitrary user code and may unwind. The mutex is no
        // longer held, so committed state cannot be poisoned by that unwind.
        drop(displaced);
        Ok(accounting)
    }

    /// Returns the declared fixed logical capacity.
    #[must_use]
    pub const fn capacity(&self) -> NonZeroUsize {
        self.capacity
    }
}

impl<T> Clone for BoundedSender<T> {
    fn clone(&self) -> Self {
        Self {
            shared: Arc::clone(&self.shared),
            capacity: self.capacity,
        }
    }
}

impl<T> BoundedReceiver<T> {
    /// Removes the oldest queued value.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelReadError::Poisoned`] when shared state is not
    /// trustworthy.
    pub fn try_receive(&self) -> Result<Option<(T, DropAccounting)>, ChannelReadError> {
        let mut state = self.shared.lock().map_err(|_| ChannelReadError::Poisoned)?;
        let Some(value) = state.values.pop_front() else {
            return Ok(None);
        };
        Ok(Some((
            value,
            DropAccounting {
                dropped_oldest: state.dropped_oldest,
            },
        )))
    }

    /// Returns the number of currently retained values.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelReadError::Poisoned`] when shared state is not
    /// trustworthy.
    pub fn len(&self) -> Result<usize, ChannelReadError> {
        self.shared
            .lock()
            .map(|state| state.values.len())
            .map_err(|_| ChannelReadError::Poisoned)
    }

    /// Returns whether no values are currently retained.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelReadError::Poisoned`] when shared state is not
    /// trustworthy.
    pub fn is_empty(&self) -> Result<bool, ChannelReadError> {
        self.len().map(|length| length == 0)
    }
}

impl<T> Drop for BoundedReceiver<T> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.shared.lock() {
            state.receiver_open = false;
        }
    }
}

/// Cause recorded by the kernel's non-overwritable safety path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafetyCause {
    /// Lifecycle work could not be retained by its fail-closed queue.
    LifecycleQueueSaturated,
    /// An internal invariant failed during the inert kernel self-check.
    InternalInvariant,
    /// Headless shutdown was requested.
    ShutdownRequested,
}

/// Sticky safety notice that is separate from normal latest-value traffic.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SafetyNotice {
    /// Runtime generation in which the process-lifetime first cause occurred.
    pub generation: RuntimeGeneration,
    /// First safety cause retained for the lifetime of this latch/process.
    pub cause: SafetyCause,
}

/// Process-lifetime first-cause safety latch. Normal traffic cannot clear it.
#[derive(Debug, Default)]
pub struct SafetyLatch {
    notice: Mutex<Option<SafetyNotice>>,
}

impl SafetyLatch {
    /// Creates an empty safety latch.
    #[must_use]
    pub const fn new() -> Self {
        Self {
            notice: Mutex::new(None),
        }
    }

    /// Latches `notice` if this is the first cause and returns the retained one.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelReadError::Poisoned`] when the latch state is not
    /// trustworthy. It never recovers poisoned state silently.
    pub fn latch(&self, notice: SafetyNotice) -> Result<SafetyNotice, ChannelReadError> {
        let mut retained = self.notice.lock().map_err(|_| ChannelReadError::Poisoned)?;
        Ok(*retained.get_or_insert(notice))
    }

    /// Returns the retained first cause.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelReadError::Poisoned`] when the latch state is not
    /// trustworthy.
    pub fn get(&self) -> Result<Option<SafetyNotice>, ChannelReadError> {
        self.notice
            .lock()
            .map(|retained| *retained)
            .map_err(|_| ChannelReadError::Poisoned)
    }

    /// Returns whether a safety cause is latched.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelReadError::Poisoned`] when the latch state is not
    /// trustworthy.
    pub fn is_latched(&self) -> Result<bool, ChannelReadError> {
        self.get().map(|notice| notice.is_some())
    }
}

/// Typed channel set for the future headless plant runtime.
///
/// Command, health, and adapter-output paths retain only their newest value.
/// Lifecycle ingress rejects new work at capacity. Evidence drops its oldest
/// item with accounting. Safety has a separate first-cause latch and therefore
/// cannot be displaced by saturation of any normal path.
#[derive(Debug)]
pub struct KernelChannels<CommandValue, Health, AdapterOutput, Evidence> {
    /// Latest validated-command foundation. No command schema exists yet.
    pub latest_command: LatestChannel<CommandValue>,
    /// Latest atomic-health foundation. No trusted health schema exists yet.
    pub latest_health: LatestChannel<Health>,
    /// Latest adapter-output foundation. The current adapter is inert.
    pub latest_adapter_output: LatestChannel<AdapterOutput>,
    /// Bounded lifecycle ingress using [`FullPolicy::RejectNew`].
    pub lifecycle: QueueChannel<GuardedEvent>,
    /// Bounded noncritical evidence path using [`FullPolicy::DropOldest`].
    pub evidence: QueueChannel<Evidence>,
    /// Independent sticky safety path.
    pub safety: Arc<SafetyLatch>,
}

impl<CommandValue, Health, AdapterOutput, Evidence>
    KernelChannels<CommandValue, Health, AdapterOutput, Evidence>
{
    /// Creates typed kernel channels with explicit nonzero queue capacities.
    ///
    /// # Errors
    ///
    /// Returns [`ChannelConfigurationError::CapacityTooLarge`] when either
    /// queue capacity exceeds [`MAX_BOUNDED_QUEUE_CAPACITY`].
    pub fn new(
        lifecycle_capacity: NonZeroUsize,
        evidence_capacity: NonZeroUsize,
    ) -> Result<Self, ChannelConfigurationError> {
        Ok(Self {
            latest_command: LatestChannel::new(),
            latest_health: LatestChannel::new(),
            latest_adapter_output: LatestChannel::new(),
            lifecycle: QueueChannel::new(lifecycle_capacity, FullPolicy::RejectNew)?,
            evidence: QueueChannel::new(evidence_capacity, FullPolicy::DropOldest)?,
            safety: Arc::new(SafetyLatch::new()),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::Arc;

    use super::{bounded_queue, latest_value, ChannelError, ChannelReadError, FullPolicy};

    #[derive(Debug)]
    struct DropBomb(bool);

    impl Drop for DropBomb {
        fn drop(&mut self) {
            assert!(!self.0, "adversarial destructor panic");
        }
    }

    #[test]
    fn latest_drop_panic_should_not_poison_committed_replacement() {
        let (sender, receiver) = latest_value();
        sender
            .replace(DropBomb(true))
            .expect("first value admitted");

        let unwind = catch_unwind(AssertUnwindSafe(|| sender.replace(DropBomb(false))));
        let snapshot = receiver
            .take_latest()
            .expect("latest state must not be poisoned")
            .expect("replacement was committed before displaced drop");

        assert!(unwind.is_err() && snapshot.sequence == 2 && snapshot.overwritten == 1);
    }

    #[test]
    fn drop_oldest_panic_should_not_poison_committed_replacement() {
        let capacity = NonZeroUsize::MIN;
        let (sender, receiver) =
            bounded_queue(capacity, FullPolicy::DropOldest).expect("valid queue capacity");
        sender
            .try_send(DropBomb(true))
            .expect("first value admitted");

        let unwind = catch_unwind(AssertUnwindSafe(|| sender.try_send(DropBomb(false))));
        let (_, accounting) = receiver
            .try_receive()
            .expect("queue state must not be poisoned")
            .expect("replacement was committed before displaced drop");

        assert!(unwind.is_err() && accounting.dropped_oldest == 1);
    }

    #[test]
    fn poisoned_latest_state_should_fail_closed_for_reads_and_writes() {
        let (sender, receiver) = latest_value::<u8>();
        let shared = Arc::clone(&sender.shared);
        let _ = std::thread::spawn(move || {
            let _guard = shared.lock().expect("new mutex is healthy");
            panic!("intentional poison");
        })
        .join();

        assert!(
            matches!(sender.replace(7), Err(ChannelError::Poisoned(7)))
                && matches!(receiver.take_latest(), Err(ChannelReadError::Poisoned))
        );
    }

    #[test]
    fn latest_counter_exhaustion_should_reject_without_duplicate_sequence() {
        let (sender, receiver) = latest_value();
        {
            let mut state = sender.shared.lock().expect("new mutex is healthy");
            state.sequence = u64::MAX;
        }

        let result = sender.replace(42_u8);

        assert!(
            matches!(result, Err(ChannelError::CounterExhausted(42)))
                && !receiver.has_value().expect("state remains healthy")
        );
    }

    #[test]
    fn drop_counter_exhaustion_should_preserve_existing_value() {
        let (sender, receiver) =
            bounded_queue(NonZeroUsize::MIN, FullPolicy::DropOldest).expect("valid queue capacity");
        sender.try_send(1_u8).expect("first value admitted");
        {
            let mut state = sender.shared.lock().expect("new mutex is healthy");
            state.dropped_oldest = u64::MAX;
        }

        let result = sender.try_send(2_u8);
        let (retained, accounting) = receiver
            .try_receive()
            .expect("state remains healthy")
            .expect("original value remains queued");

        assert!(
            matches!(result, Err(ChannelError::CounterExhausted(2)))
                && retained == 1
                && accounting.dropped_oldest == u64::MAX
        );
    }
}
