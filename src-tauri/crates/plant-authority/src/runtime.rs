//! Inert kernel composition and headless self-check.

use std::fmt;
use std::num::{NonZeroU64, NonZeroUsize};

use crate::{
    AdapterError, ArmingStateV1, BatteryObservationV1, CandidateProfileKind, CandidateProfileV1,
    ChannelError, EstimateValidityV1, EstimatorStateV1, FcuFailsafeStateV1,
    FcuHealthSourceIdentity, FcuLinksV1, FcuModeStateV1, FcuStateV1, FenceStateV1, GuardedEvent,
    HealthObservationTimesV1, HealthStreamEpochIdentity, HealthStreamSequence, InertAdapter,
    KernelChannels, LandedStateV1, LifecycleError, LifecycleEvent, LifecycleMachine, LinkStateV1,
    LocalFrameInstanceIdentity, MeasurementUnavailableReasonV1, PlantObservationTime, PlantState,
    PositionObservationV1, PositionUnitV1, ProfileIdentity, RuntimeGeneration, SafetyCause,
    SafetyNotice, VehicleHealthContextV1, VehicleHealthMetadataV1, VehicleHealthReportV1,
    VehicleHealthStateV1, VehicleHealthUnitsV1, VehicleIdentity, VelocityObservationV1,
    VelocityUnit, VEHICLE_HEALTH_SCHEMA_V1,
};

const SELF_CHECK_GENERATION: NonZeroU64 = NonZeroU64::MIN;
const LIFECYCLE_QUEUE_CAPACITY: NonZeroUsize = NonZeroUsize::MIN;
const EVIDENCE_QUEUE_CAPACITY: NonZeroUsize = match NonZeroUsize::new(4) {
    Some(value) => value,
    None => NonZeroUsize::MIN,
};
type SelfCheckChannels = KernelChannels<u64, u64, u64>;

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

fn check_latest_paths(
    channels: &mut SelfCheckChannels,
    generation: RuntimeGeneration,
) -> Result<u64, KernelError> {
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

    let report = self_check_health_report(generation)?;
    channels
        .commit_vehicle_health(&report)
        .map_err(|_| KernelError::ChannelInvariant("health receiver closed unexpectedly"))?;
    channels
        .latest_adapter_output
        .sender
        .replace(1_u64)
        .map_err(|_| KernelError::ChannelInvariant("output receiver closed unexpectedly"))?;
    let health = channels
        .load_vehicle_health(generation)
        .map_err(|_| KernelError::ChannelInvariant("health snapshot state was poisoned"))?;
    let repeated_health = channels
        .load_vehicle_health(generation)
        .map_err(|_| KernelError::ChannelInvariant("health snapshot state was poisoned"))?;
    let output = channels
        .latest_adapter_output
        .receiver
        .take_latest()
        .map_err(|_| KernelError::ChannelInvariant("output channel state was poisoned"))?;
    if health.register_sequence() != 1
        || repeated_health.register_sequence() != 1
        || health.snapshot().metadata().stream_sequence().get() != 1
        || output.is_none()
    {
        return Err(KernelError::ChannelInvariant(
            "typed snapshot/latest-value path did not retain its value",
        ));
    }
    Ok(latest.overwritten)
}

fn self_check_health_context(
    generation: RuntimeGeneration,
) -> Result<VehicleHealthContextV1, KernelError> {
    let profile_identity =
        ProfileIdentity::new(CandidateProfileKind::DraftL1SitlLocalNed, [1_u8; 32]).map_err(
            |_| KernelError::ChannelInvariant("fixed health profile identity was invalid"),
        )?;
    let vehicle = VehicleIdentity::new([2_u8; 16])
        .map_err(|_| KernelError::ChannelInvariant("fixed vehicle identity was invalid"))?;
    let source = FcuHealthSourceIdentity::new([3_u8; 32])
        .map_err(|_| KernelError::ChannelInvariant("fixed health source identity was invalid"))?;
    let stream_epoch = HealthStreamEpochIdentity::new([4_u8; 16])
        .map_err(|_| KernelError::ChannelInvariant("fixed health epoch was invalid"))?;
    let frame_instance = LocalFrameInstanceIdentity::new([5_u8; 16])
        .map_err(|_| KernelError::ChannelInvariant("fixed frame instance was invalid"))?;
    Ok(VehicleHealthContextV1::new(
        CandidateProfileV1::from_identity(profile_identity),
        vehicle,
        source,
        stream_epoch,
        generation,
        frame_instance,
    ))
}

fn self_check_health_report(
    generation: RuntimeGeneration,
) -> Result<VehicleHealthReportV1, KernelError> {
    let context = self_check_health_context(generation)?;
    let sequence = HealthStreamSequence::new(1)
        .map_err(|_| KernelError::ChannelInvariant("fixed health sequence was invalid"))?;
    let observed_at = PlantObservationTime::now(generation);
    Ok(VehicleHealthReportV1::new(
        VehicleHealthMetadataV1::new(VEHICLE_HEALTH_SCHEMA_V1, context.domain(), sequence),
        VehicleHealthUnitsV1::new(
            context.profile().velocity_frame(),
            PositionUnitV1::Metres,
            VelocityUnit::MetresPerSecond,
        ),
        HealthObservationTimesV1::all(observed_at),
        VehicleHealthStateV1::new(
            FcuStateV1::new(
                ArmingStateV1::Unknown,
                LandedStateV1::Unknown,
                FcuModeStateV1::Unknown,
                FcuFailsafeStateV1::Unknown,
            ),
            EstimatorStateV1::new(
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
            ),
            PositionObservationV1::Unavailable(MeasurementUnavailableReasonV1::NotReported),
            VelocityObservationV1::Unavailable(MeasurementUnavailableReasonV1::NotReported),
            BatteryObservationV1::Unavailable(MeasurementUnavailableReasonV1::NotReported),
            FenceStateV1::Unknown,
            FcuLinksV1::new(
                LinkStateV1::Unknown,
                LinkStateV1::Unknown,
                LinkStateV1::Unknown,
            ),
        ),
    ))
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

    let health_context = self_check_health_context(initial_generation)?;
    let mut channels = KernelChannels::<u64, u64, u64>::new(
        LIFECYCLE_QUEUE_CAPACITY,
        EVIDENCE_QUEUE_CAPACITY,
        health_context,
    )
    .map_err(|_| KernelError::ChannelInvariant("kernel channel capacity was rejected"))?;

    let latest_overwritten = check_latest_paths(&mut channels, initial_generation)?;
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
