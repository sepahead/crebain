//! Inert kernel composition and headless self-check.

use std::fmt;
use std::num::{NonZeroU64, NonZeroUsize};

use crate::{
    AdapterError, ChannelError, GuardedEvent, InertAdapter, KernelChannels, LifecycleError,
    LifecycleEvent, LifecycleMachine, PlantState, RuntimeGeneration, SafetyCause, SafetyNotice,
};

const SELF_CHECK_GENERATION: NonZeroU64 = NonZeroU64::MIN;
const LIFECYCLE_QUEUE_CAPACITY: NonZeroUsize = NonZeroUsize::MIN;
const EVIDENCE_QUEUE_CAPACITY: NonZeroUsize = match NonZeroUsize::new(4) {
    Some(value) => value,
    None => NonZeroUsize::MIN,
};
type SelfCheckChannels = KernelChannels<u64, u64, u64, u64>;

/// Error returned by the inert self-check.
#[derive(Debug)]
pub enum KernelError {
    /// Inert adapter lifecycle failed.
    Adapter(AdapterError),
    /// Lifecycle transition failed.
    Lifecycle(LifecycleError),
    /// A bounded-channel invariant failed.
    ChannelInvariant(&'static str),
}

impl fmt::Display for KernelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Adapter(error) => write!(formatter, "adapter self-check failed: {error}"),
            Self::Lifecycle(error) => write!(formatter, "lifecycle self-check failed: {error}"),
            Self::ChannelInvariant(message) => {
                write!(formatter, "channel self-check failed: {message}")
            }
        }
    }
}

impl std::error::Error for KernelError {}

impl From<AdapterError> for KernelError {
    fn from(error: AdapterError) -> Self {
        Self::Adapter(error)
    }
}

impl From<LifecycleError> for KernelError {
    fn from(error: LifecycleError) -> Self {
        Self::Lifecycle(error)
    }
}

/// Successful result of the inert headless self-check.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SelfCheckReport {
    /// Final lifecycle state.
    pub final_state: PlantState,
    /// Terminal generation after shutdown (rotated when representable).
    pub final_generation: RuntimeGeneration,
    /// Whether overwrite accounting was exercised.
    pub latest_overwritten: u64,
    /// Whether evidence loss accounting was exercised.
    pub evidence_dropped: u64,
    /// Safety cause retained independently of normal queues.
    pub safety_cause: SafetyCause,
}

fn check_latest_paths(channels: &SelfCheckChannels) -> Result<u64, KernelError> {
    channels
        .latest_command
        .sender
        .replace(1_u64)
        .map_err(|_| KernelError::ChannelInvariant("latest receiver closed unexpectedly"))?;
    channels
        .latest_command
        .sender
        .replace(2_u64)
        .map_err(|_| KernelError::ChannelInvariant("latest receiver closed unexpectedly"))?;
    let latest = channels
        .latest_command
        .receiver
        .take_latest()
        .map_err(|_| KernelError::ChannelInvariant("latest channel state was poisoned"))?
        .ok_or(KernelError::ChannelInvariant(
            "latest value was not retained",
        ))?;
    if latest.value != 2 || latest.overwritten != 1 {
        return Err(KernelError::ChannelInvariant(
            "latest channel did not retain only the newest value",
        ));
    }

    channels
        .latest_health
        .sender
        .replace(1_u64)
        .map_err(|_| KernelError::ChannelInvariant("health receiver closed unexpectedly"))?;
    channels
        .latest_adapter_output
        .sender
        .replace(1_u64)
        .map_err(|_| KernelError::ChannelInvariant("output receiver closed unexpectedly"))?;
    let health = channels
        .latest_health
        .receiver
        .take_latest()
        .map_err(|_| KernelError::ChannelInvariant("health channel state was poisoned"))?;
    let output = channels
        .latest_adapter_output
        .receiver
        .take_latest()
        .map_err(|_| KernelError::ChannelInvariant("output channel state was poisoned"))?;
    if health.is_none() || output.is_none() {
        return Err(KernelError::ChannelInvariant(
            "typed latest-value path did not retain its value",
        ));
    }
    Ok(latest.overwritten)
}

fn check_lifecycle_path(
    lifecycle: &mut LifecycleMachine,
    channels: &SelfCheckChannels,
) -> Result<SafetyNotice, KernelError> {
    channels
        .lifecycle
        .sender
        .try_send(GuardedEvent {
            generation: lifecycle.generation(),
            event: LifecycleEvent::StandbyRequested,
        })
        .map_err(|_| KernelError::ChannelInvariant("empty lifecycle queue rejected work"))?;
    let rejected = channels.lifecycle.sender.try_send(GuardedEvent {
        generation: lifecycle.generation(),
        event: LifecycleEvent::PreflightRequested,
    });
    let Err(ChannelError::Full(_)) = rejected else {
        return Err(KernelError::ChannelInvariant(
            "full lifecycle queue did not reject new work",
        ));
    };
    channels
        .safety
        .latch(SafetyNotice {
            generation: lifecycle.generation(),
            cause: SafetyCause::LifecycleQueueSaturated,
        })
        .map_err(|_| KernelError::ChannelInvariant("safety latch state was poisoned"))?;

    let guarded_event = channels
        .lifecycle
        .receiver
        .try_receive()
        .map_err(|_| KernelError::ChannelInvariant("lifecycle queue state was poisoned"))?
        .ok_or(KernelError::ChannelInvariant(
            "lifecycle queue did not retain its first event",
        ))?
        .0;
    lifecycle.apply(guarded_event)?;
    channels
        .safety
        .get()
        .map_err(|_| KernelError::ChannelInvariant("safety latch state was poisoned"))?
        .ok_or(KernelError::ChannelInvariant(
            "lifecycle saturation did not latch safety",
        ))
}

fn check_evidence_path(channels: &SelfCheckChannels) -> Result<u64, KernelError> {
    for evidence_id in 0_u64..=EVIDENCE_QUEUE_CAPACITY.get() as u64 {
        channels
            .evidence
            .sender
            .try_send(evidence_id)
            .map_err(|_| KernelError::ChannelInvariant("evidence queue closed unexpectedly"))?;
    }
    let (_, accounting) = channels
        .evidence
        .receiver
        .try_receive()
        .map_err(|_| KernelError::ChannelInvariant("evidence queue state was poisoned"))?
        .ok_or(KernelError::ChannelInvariant("evidence queue became empty"))?;
    if accounting.dropped_oldest != 1 {
        return Err(KernelError::ChannelInvariant(
            "evidence queue did not account for its oldest drop",
        ));
    }
    Ok(accounting.dropped_oldest)
}

/// Runs a deterministic self-check without opening any transport or adapter.
///
/// # Errors
///
/// Returns [`KernelError`] if a lifecycle or bounded-channel invariant fails.
pub fn run_self_check() -> Result<SelfCheckReport, KernelError> {
    let initial_generation = RuntimeGeneration::new(SELF_CHECK_GENERATION);
    let mut lifecycle = LifecycleMachine::new(initial_generation);
    let mut adapter = InertAdapter::new();
    adapter.start()?;

    lifecycle.apply(GuardedEvent {
        generation: initial_generation,
        event: LifecycleEvent::BootCompleted,
    })?;

    let channels = KernelChannels::<u64, u64, u64, u64>::new(
        LIFECYCLE_QUEUE_CAPACITY,
        EVIDENCE_QUEUE_CAPACITY,
    )
    .map_err(|_| KernelError::ChannelInvariant("kernel channel capacity was rejected"))?;

    let latest_overwritten = check_latest_paths(&channels)?;
    let retained = check_lifecycle_path(&mut lifecycle, &channels)?;
    let evidence_dropped = check_evidence_path(&channels)?;
    let repeated = channels
        .safety
        .latch(SafetyNotice {
            generation: lifecycle.generation(),
            cause: SafetyCause::ShutdownRequested,
        })
        .map_err(|_| KernelError::ChannelInvariant("safety latch state was poisoned"))?;
    if retained != repeated {
        return Err(KernelError::ChannelInvariant(
            "safety latch allowed a later cause to overwrite the first",
        ));
    }

    let shutdown = lifecycle.apply(GuardedEvent {
        generation: lifecycle.generation(),
        event: LifecycleEvent::ShutdownRequested,
    })?;
    adapter.stop();

    Ok(SelfCheckReport {
        final_state: shutdown.to,
        final_generation: shutdown.next_generation,
        latest_overwritten,
        evidence_dropped,
        safety_cause: retained.cause,
    })
}
