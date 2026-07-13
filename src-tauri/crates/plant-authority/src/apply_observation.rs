//! Inert same-instant command, lifecycle, and health-age observation.
//!
//! This module captures component evidence at one plant-local monotonic instant.
//! It does not decide eligibility, authorize a command, return command content,
//! mutate lifecycle, call an adapter, or perform a write.

use std::fmt;
use std::time::{Duration, Instant};

use crate::contract::{
    CommandSessionIdentity, CommandStreamSequence, ProfileIdentity, RequestedCommandTtl,
    VelocityCommandCandidateV1,
};
use crate::freshness::{
    VehicleHealthAgeAssessmentErrorV1, VehicleHealthCapturedAgeAssessmentV1,
    VehicleHealthCapturedAgePolicyV1,
};
use crate::health::{ObservedVehicleHealthV1, VehicleHealthReadError, VehicleHealthReaderV1};
use crate::lifecycle::{LifecycleMachine, PlantState, RuntimeGeneration};

/// Closed comparison between command age and its structurally requested lifetime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommandRequestedLifetimeRelationAtCheckV1 {
    /// Command age was strictly less than its requested lifetime at the check.
    WithinRequestedLifetimeAtCheck,
    /// Command age equaled or exceeded its requested lifetime at the check.
    AtOrBeyondRequestedLifetimeAtCheck,
}

/// Neutral lifecycle fact captured while the lifecycle machine is immutably borrowed.
///
/// This value deliberately exposes no `is_active`, eligibility, authorization,
/// or boolean conversion.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LifecycleObservationAtCheckV1 {
    state: PlantState,
    generation: RuntimeGeneration,
}

impl LifecycleObservationAtCheckV1 {
    /// Returns the exact lifecycle state captured at the check.
    #[must_use]
    pub const fn state(self) -> PlantState {
        self.state
    }

    /// Returns the lifecycle generation captured at the check.
    #[must_use]
    pub const fn generation(self) -> RuntimeGeneration {
        self.generation
    }
}

/// Failure to form one coherent apply-check observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApplyCheckObservationErrorV1 {
    /// Command and age policy are bound to different exact profiles.
    CommandPolicyProfileMismatch {
        /// Exact profile carried by the structurally validated command.
        command_profile: ProfileIdentity,
        /// Exact profile bound to the captured-age policy.
        policy_profile: ProfileIdentity,
    },
    /// Command and lifecycle machine belong to different runtime generations.
    CommandLifecycleGenerationMismatch {
        /// Generation carried by the structurally validated command.
        command_generation: RuntimeGeneration,
        /// Generation captured from the lifecycle machine.
        lifecycle_generation: RuntimeGeneration,
    },
    /// The private monotonic check instant preceded command receipt.
    CommandClockRegression,
    /// Vehicle-health storage could not produce a generation-current observation.
    VehicleHealthRead(VehicleHealthReadError),
    /// Captured vehicle health and the age policy use different exact profiles.
    HealthPolicyProfileMismatch {
        /// Exact profile bound to the captured-age policy.
        policy_profile: ProfileIdentity,
        /// Exact profile retained by the observed health snapshot.
        observed_profile: ProfileIdentity,
    },
}

impl fmt::Display for ApplyCheckObservationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CommandPolicyProfileMismatch { .. } => {
                formatter.write_str("command profile does not match captured-age policy profile")
            }
            Self::CommandLifecycleGenerationMismatch { .. } => {
                formatter.write_str("command generation does not match lifecycle generation")
            }
            Self::CommandClockRegression => {
                formatter.write_str("plant monotonic clock regressed before command receipt")
            }
            Self::VehicleHealthRead(error) => {
                write!(formatter, "vehicle-health read failed: {error}")
            }
            Self::HealthPolicyProfileMismatch { .. } => formatter
                .write_str("captured vehicle-health profile does not match age policy profile"),
        }
    }
}

impl std::error::Error for ApplyCheckObservationErrorV1 {}

/// Non-authorizing evidence candidate captured at one private monotonic instant.
///
/// `Ok(Self)` means only that the observation was formed coherently. The
/// command may already be at or beyond its requested lifetime, lifecycle may be
/// `Emergency` or any other non-`Active` state, captured health ages may be at
/// or beyond their proposed limits, and health state may be unknown or
/// unavailable. This value cannot be cloned, directly constructed, converted
/// directly into a boolean, or converted into command content or an adapter
/// action. Its exposed facts can still be compared by a caller; those derived
/// booleans are not aggregate or authorizing verdicts.
///
/// This observation is not a uniquely or content-bound checked-command token.
/// The command candidate is copyable and does not carry vehicle or local-frame-
/// instance identity, so the retained command IDs and requested lifetime can be
/// reminted or associated with different command content, and exact profile plus
/// generation can compose with health from another declared vehicle/frame
/// domain. Callers must not pair this evidence to a command by its accessors.
///
/// ```compile_fail
/// use crebain_plant_authority::ApplyCheckObservationCandidateV1;
///
/// fn duplicate(observation: ApplyCheckObservationCandidateV1<'_>) {
///     let _copy = observation.clone();
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{
///     ApplyCheckObservationCandidateV1, CommandRequestedLifetimeRelationAtCheckV1,
///     LifecycleObservationAtCheckV1, ProfileIdentity, RequestedCommandTtl,
///     RuntimeGeneration, VehicleHealthCapturedAgeAssessmentV1,
/// };
/// use std::time::Duration;
///
/// fn construct<'a>(
///     profile: ProfileIdentity,
///     generation: RuntimeGeneration,
///     lifecycle: LifecycleObservationAtCheckV1,
///     ttl: RequestedCommandTtl,
///     health: VehicleHealthCapturedAgeAssessmentV1<'a>,
/// ) -> ApplyCheckObservationCandidateV1<'a> {
///     ApplyCheckObservationCandidateV1 {
///         profile,
///         session: todo!(),
///         stream_sequence: todo!(),
///         generation,
///         lifecycle,
///         command_age: Duration::ZERO,
///         requested_ttl: ttl,
///         health,
///     }
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::ApplyCheckObservationCandidateV1;
///
/// fn to_boolean(observation: ApplyCheckObservationCandidateV1<'_>) -> bool {
///     observation.into()
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::ApplyCheckObservationCandidateV1;
/// use std::time::Instant;
///
/// fn raw_check_time(observation: &ApplyCheckObservationCandidateV1<'_>) -> Instant {
///     observation.checked_at()
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{
///     ApplyCheckObservationCandidateV1, FramedVelocityMetresPerSecond,
/// };
///
/// fn command_velocity(
///     observation: ApplyCheckObservationCandidateV1<'_>,
/// ) -> FramedVelocityMetresPerSecond {
///     observation.into()
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{ApplyCheckObservationCandidateV1, ProposedActionV1};
///
/// fn proposed_action(observation: ApplyCheckObservationCandidateV1<'_>) -> ProposedActionV1 {
///     observation.into()
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{AdapterState, ApplyCheckObservationCandidateV1};
///
/// fn adapter_action(observation: ApplyCheckObservationCandidateV1<'_>) -> AdapterState {
///     observation.into()
/// }
/// ```
#[derive(Debug)]
pub struct ApplyCheckObservationCandidateV1<'policy> {
    profile: ProfileIdentity,
    session: CommandSessionIdentity,
    stream_sequence: CommandStreamSequence,
    generation: RuntimeGeneration,
    lifecycle: LifecycleObservationAtCheckV1,
    command_age: Duration,
    requested_ttl: RequestedCommandTtl,
    health: VehicleHealthCapturedAgeAssessmentV1<'policy>,
}

impl<'policy> ApplyCheckObservationCandidateV1<'policy> {
    /// Loads one coherent health snapshot, then captures command age and all
    /// health ages at one private process-local monotonic reference instant.
    ///
    /// Validation order is exact command/policy profile, command/lifecycle
    /// generation, vehicle-health read, command clock, then health/policy
    /// profile. A successful result is evidence only, never a permit or verdict.
    ///
    /// # Errors
    ///
    /// Returns [`ApplyCheckObservationErrorV1`] when the inputs cannot form one
    /// coherent single-reference-instant observation.
    pub fn capture(
        command: &VelocityCommandCandidateV1,
        lifecycle: &LifecycleMachine,
        health_reader: &VehicleHealthReaderV1,
        age_policy: &'policy VehicleHealthCapturedAgePolicyV1,
    ) -> Result<Self, ApplyCheckObservationErrorV1> {
        let lifecycle_observation = precheck(command, lifecycle, age_policy)?;
        let (observed, checked_at) = health_reader
            .load_for_apply_observation(lifecycle_observation.generation)
            .map_err(ApplyCheckObservationErrorV1::VehicleHealthRead)?;
        Self::capture_prechecked_observation(
            command,
            lifecycle_observation,
            observed,
            age_policy,
            checked_at,
        )
    }

    /// Returns the exact command profile retained by this observation.
    #[must_use]
    pub const fn profile(&self) -> ProfileIdentity {
        self.profile
    }

    /// Returns the command session identity retained by this observation.
    #[must_use]
    pub const fn session(&self) -> CommandSessionIdentity {
        self.session
    }

    /// Returns the command stream sequence retained by this observation.
    #[must_use]
    pub const fn stream_sequence(&self) -> CommandStreamSequence {
        self.stream_sequence
    }

    /// Returns the command runtime generation retained by this observation.
    #[must_use]
    pub const fn generation(&self) -> RuntimeGeneration {
        self.generation
    }

    /// Returns the neutral lifecycle fact captured at the check.
    #[must_use]
    pub const fn lifecycle(&self) -> LifecycleObservationAtCheckV1 {
        self.lifecycle
    }

    /// Returns command age frozen at the private check instant.
    #[must_use]
    pub const fn command_age(&self) -> Duration {
        self.command_age
    }

    /// Returns the structurally validated requested command lifetime.
    #[must_use]
    pub const fn requested_ttl(&self) -> RequestedCommandTtl {
        self.requested_ttl
    }

    /// Compares captured command age with the requested lifetime.
    ///
    /// Equality is outside. This closed relation is not a fresh, safe, eligible,
    /// authorized, or write-valid verdict.
    #[must_use]
    pub fn requested_lifetime_relation(&self) -> CommandRequestedLifetimeRelationAtCheckV1 {
        if self.command_age < self.requested_ttl.get() {
            CommandRequestedLifetimeRelationAtCheckV1::WithinRequestedLifetimeAtCheck
        } else {
            CommandRequestedLifetimeRelationAtCheckV1::AtOrBeyondRequestedLifetimeAtCheck
        }
    }

    /// Returns the owned coherent vehicle-health observation and its proposed
    /// profile-bound captured-age comparisons.
    #[must_use]
    pub const fn health(&self) -> &VehicleHealthCapturedAgeAssessmentV1<'policy> {
        &self.health
    }

    #[cfg(test)]
    fn capture_at_for_test(
        command: &VelocityCommandCandidateV1,
        lifecycle: &LifecycleMachine,
        health_reader: &VehicleHealthReaderV1,
        age_policy: &'policy VehicleHealthCapturedAgePolicyV1,
        checked_at: Instant,
    ) -> Result<Self, ApplyCheckObservationErrorV1> {
        let lifecycle_observation = precheck(command, lifecycle, age_policy)?;
        let observed = health_reader
            .load_at(lifecycle_observation.generation, checked_at)
            .map_err(ApplyCheckObservationErrorV1::VehicleHealthRead)?;
        Self::capture_prechecked_observation(
            command,
            lifecycle_observation,
            observed,
            age_policy,
            checked_at,
        )
    }

    fn capture_prechecked_observation(
        command: &VelocityCommandCandidateV1,
        lifecycle: LifecycleObservationAtCheckV1,
        observed: ObservedVehicleHealthV1,
        age_policy: &'policy VehicleHealthCapturedAgePolicyV1,
        checked_at: Instant,
    ) -> Result<Self, ApplyCheckObservationErrorV1> {
        let command_age = command
            .received_at()
            .elapsed_at(checked_at)
            .ok_or(ApplyCheckObservationErrorV1::CommandClockRegression)?;
        let health = age_policy.assess(observed).map_err(map_assessment_error)?;

        Ok(Self {
            profile: command.profile().identity(),
            session: command.session(),
            stream_sequence: command.stream_sequence(),
            generation: command.generation(),
            lifecycle,
            command_age,
            requested_ttl: command.requested_ttl(),
            health,
        })
    }
}

fn precheck(
    command: &VelocityCommandCandidateV1,
    lifecycle: &LifecycleMachine,
    age_policy: &VehicleHealthCapturedAgePolicyV1,
) -> Result<LifecycleObservationAtCheckV1, ApplyCheckObservationErrorV1> {
    let command_profile = command.profile().identity();
    let policy_profile = age_policy.profile();
    if command_profile != policy_profile {
        return Err(ApplyCheckObservationErrorV1::CommandPolicyProfileMismatch {
            command_profile,
            policy_profile,
        });
    }

    let lifecycle_observation = LifecycleObservationAtCheckV1 {
        state: lifecycle.state(),
        generation: lifecycle.generation(),
    };
    let command_generation = command.generation();
    if command_generation != lifecycle_observation.generation {
        return Err(
            ApplyCheckObservationErrorV1::CommandLifecycleGenerationMismatch {
                command_generation,
                lifecycle_generation: lifecycle_observation.generation,
            },
        );
    }
    Ok(lifecycle_observation)
}

fn map_assessment_error(error: VehicleHealthAgeAssessmentErrorV1) -> ApplyCheckObservationErrorV1 {
    ApplyCheckObservationErrorV1::HealthPolicyProfileMismatch {
        policy_profile: error.policy_profile(),
        observed_profile: error.observed_profile(),
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;

    use super::*;
    use crate::contract::{
        CandidateProfileKind, CandidateProfileV1, CommandMetadataV1, CommandProposalV1,
        ProducerEpochIdentity, ProducerTime, ProposedActionV1, RawVelocityV1, VelocityFrame,
        VelocityUnit, PLANT_CONTRACT_V1,
    };
    use crate::freshness::{VehicleHealthAgeLimitsProposalV1, VehicleHealthAgeRelationAtReadV1};
    use crate::health::{
        vehicle_health_channel, ArmingStateV1, BatteryObservationV1, EstimateValidityV1,
        EstimatorStateV1, FcuFailsafeStateV1, FcuHealthSourceIdentity, FcuLinksV1, FcuModeStateV1,
        FcuStateV1, FenceStateV1, HealthObservationTimesV1, HealthStreamEpochIdentity,
        HealthStreamSequence, LandedStateV1, LinkStateV1, LocalFrameInstanceIdentity,
        MeasurementUnavailableReasonV1, PlantObservationTime, PositionObservationV1,
        PositionUnitV1, ProfileModeCode, VehicleHealthContextV1, VehicleHealthMetadataV1,
        VehicleHealthReportV1, VehicleHealthStateV1, VehicleHealthUnitsV1, VehicleIdentity,
        VelocityObservationV1, VEHICLE_HEALTH_SCHEMA_V1,
    };
    use crate::lifecycle::{GuardedEvent, LifecycleEvent};

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

    fn command_at(
        exact_profile: ProfileIdentity,
        runtime_generation: RuntimeGeneration,
        received_at: Instant,
        requested_ttl: Duration,
    ) -> VelocityCommandCandidateV1 {
        command_at_with_velocity(
            exact_profile,
            runtime_generation,
            received_at,
            requested_ttl,
            [0.0; 3],
        )
    }

    fn command_at_with_velocity(
        exact_profile: ProfileIdentity,
        runtime_generation: RuntimeGeneration,
        received_at: Instant,
        requested_ttl: Duration,
        velocity: [f64; 3],
    ) -> VelocityCommandCandidateV1 {
        let producer_epoch =
            ProducerEpochIdentity::new([7; 16]).expect("test producer epoch is nonzero");
        let metadata = CommandMetadataV1::new(
            PLANT_CONTRACT_V1,
            exact_profile,
            session(8),
            CommandStreamSequence::new(9).expect("test stream sequence is nonzero"),
            ProducerTime::new(producer_epoch, Duration::from_secs(1)),
            requested_ttl,
        );
        let proposal = CommandProposalV1::new(
            metadata,
            ProposedActionV1::Velocity(RawVelocityV1::new(
                VelocityFrame::LocalNed,
                VelocityUnit::MetresPerSecond,
                velocity,
            )),
        );
        CandidateProfileV1::from_identity(exact_profile)
            .validate_velocity_candidate(&proposal, session(8), runtime_generation)
            .expect("test command candidate should validate")
            .with_received_at_for_test(received_at)
    }

    fn apply_lifecycle_event(lifecycle: &mut LifecycleMachine, event: LifecycleEvent) {
        let runtime_generation = lifecycle.generation();
        lifecycle
            .apply(GuardedEvent {
                generation: runtime_generation,
                event,
            })
            .expect("test lifecycle transition should succeed");
    }

    fn lifecycle_in_state(
        runtime_generation: RuntimeGeneration,
        target: PlantState,
    ) -> LifecycleMachine {
        let mut lifecycle = LifecycleMachine::new(runtime_generation);
        if target == PlantState::Boot {
            return lifecycle;
        }
        if target == PlantState::Emergency {
            apply_lifecycle_event(&mut lifecycle, LifecycleEvent::EmergencyLatched);
            return lifecycle;
        }
        if target == PlantState::Shutdown {
            apply_lifecycle_event(&mut lifecycle, LifecycleEvent::ShutdownRequested);
            return lifecycle;
        }
        apply_lifecycle_event(&mut lifecycle, LifecycleEvent::BootCompleted);
        if target == PlantState::NoAuthority {
            return lifecycle;
        }
        apply_lifecycle_event(&mut lifecycle, LifecycleEvent::StandbyRequested);
        if target == PlantState::Standby {
            return lifecycle;
        }
        apply_lifecycle_event(&mut lifecycle, LifecycleEvent::PreflightRequested);
        if target == PlantState::Preflight {
            return lifecycle;
        }
        apply_lifecycle_event(&mut lifecycle, LifecycleEvent::AuthorizationGranted);
        if target == PlantState::AuthorizedHold {
            return lifecycle;
        }
        apply_lifecycle_event(&mut lifecycle, LifecycleEvent::ActivationRequested);
        if target == PlantState::Degraded {
            apply_lifecycle_event(&mut lifecycle, LifecycleEvent::HealthDegraded);
        }
        assert_eq!(
            lifecycle.state(),
            target,
            "test lifecycle target must be closed"
        );
        lifecycle
    }

    fn lifecycle_active(runtime_generation: RuntimeGeneration) -> LifecycleMachine {
        lifecycle_in_state(runtime_generation, PlantState::Active)
    }

    fn health_context(
        exact_profile: ProfileIdentity,
        runtime_generation: RuntimeGeneration,
    ) -> VehicleHealthContextV1 {
        health_context_with_markers(exact_profile, runtime_generation, 2, 5)
    }

    fn health_context_with_markers(
        exact_profile: ProfileIdentity,
        runtime_generation: RuntimeGeneration,
        vehicle_marker: u8,
        frame_instance_marker: u8,
    ) -> VehicleHealthContextV1 {
        VehicleHealthContextV1::new(
            CandidateProfileV1::from_identity(exact_profile),
            VehicleIdentity::new([vehicle_marker; 16]).expect("test vehicle identity is nonzero"),
            FcuHealthSourceIdentity::new([3; 32]).expect("test source identity is nonzero"),
            HealthStreamEpochIdentity::new([4; 16]).expect("test epoch identity is nonzero"),
            runtime_generation,
            LocalFrameInstanceIdentity::new([frame_instance_marker; 16])
                .expect("test frame-instance identity is nonzero"),
        )
    }

    fn nominal_state() -> VehicleHealthStateV1 {
        VehicleHealthStateV1::new(
            FcuStateV1::new(
                ArmingStateV1::Armed,
                LandedStateV1::InAir,
                FcuModeStateV1::Reported(ProfileModeCode::new(42)),
                FcuFailsafeStateV1::Inactive,
            ),
            EstimatorStateV1::new(
                EstimateValidityV1::Valid,
                EstimateValidityV1::Valid,
                EstimateValidityV1::Valid,
                EstimateValidityV1::Valid,
                EstimateValidityV1::Valid,
                EstimateValidityV1::Valid,
            ),
            PositionObservationV1::Available([1.0, 2.0, 3.0]),
            VelocityObservationV1::Available([4.0, 5.0, 6.0]),
            BatteryObservationV1::Available {
                remaining_fraction: 0.75,
            },
            FenceStateV1::Inside,
            FcuLinksV1::new(
                LinkStateV1::Connected,
                LinkStateV1::Connected,
                LinkStateV1::Connected,
            ),
        )
    }

    fn adverse_unknown_state() -> VehicleHealthStateV1 {
        let unavailable = MeasurementUnavailableReasonV1::ResetInProgress;
        VehicleHealthStateV1::new(
            FcuStateV1::new(
                ArmingStateV1::Unknown,
                LandedStateV1::Unknown,
                FcuModeStateV1::Unknown,
                FcuFailsafeStateV1::Active,
            ),
            EstimatorStateV1::new(
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
                EstimateValidityV1::Unknown,
            ),
            PositionObservationV1::Unavailable(unavailable),
            VelocityObservationV1::Unavailable(unavailable),
            BatteryObservationV1::Unavailable(unavailable),
            FenceStateV1::Unknown,
            FcuLinksV1::new(
                LinkStateV1::Disconnected,
                LinkStateV1::Unknown,
                LinkStateV1::Disconnected,
            ),
        )
    }

    fn health_reader_at(
        exact_profile: ProfileIdentity,
        runtime_generation: RuntimeGeneration,
        receipt_at: Instant,
        observation_times: HealthObservationTimesV1,
        state: VehicleHealthStateV1,
    ) -> VehicleHealthReaderV1 {
        let context = health_context(exact_profile, runtime_generation);
        health_reader_at_in_context(context, receipt_at, observation_times, state)
    }

    fn health_reader_at_in_context(
        context: VehicleHealthContextV1,
        receipt_at: Instant,
        observation_times: HealthObservationTimesV1,
        state: VehicleHealthStateV1,
    ) -> VehicleHealthReaderV1 {
        let report = VehicleHealthReportV1::new(
            VehicleHealthMetadataV1::new(
                VEHICLE_HEALTH_SCHEMA_V1,
                context.domain(),
                HealthStreamSequence::new(1).expect("test source sequence is nonzero"),
            ),
            VehicleHealthUnitsV1::new(
                context.profile().velocity_frame(),
                PositionUnitV1::Metres,
                VelocityUnit::MetresPerSecond,
            ),
            observation_times,
            state,
        );
        let (mut publisher, reader) = vehicle_health_channel(context);
        publisher
            .commit_for_test_at(&report, receipt_at)
            .expect("controlled test health report should commit");
        reader
    }

    fn policy(exact_profile: ProfileIdentity, limit: Duration) -> VehicleHealthCapturedAgePolicyV1 {
        VehicleHealthCapturedAgePolicyV1::try_new(
            exact_profile,
            VehicleHealthAgeLimitsProposalV1 {
                receipt: limit,
                fcu_state: limit,
                estimator: limit,
                position: limit,
                velocity: limit,
                battery: limit,
                fence: limit,
                links: limit,
            },
        )
        .expect("test age limits are nonzero")
    }

    fn health_reader_with_ages(
        exact_profile: ProfileIdentity,
        runtime_generation: RuntimeGeneration,
        checked_at: Instant,
        ages: [Duration; 8],
        state: VehicleHealthStateV1,
    ) -> VehicleHealthReaderV1 {
        health_reader_with_ages_in_context(
            health_context(exact_profile, runtime_generation),
            checked_at,
            ages,
            state,
        )
    }

    fn health_reader_with_ages_in_context(
        context: VehicleHealthContextV1,
        checked_at: Instant,
        ages: [Duration; 8],
        state: VehicleHealthStateV1,
    ) -> VehicleHealthReaderV1 {
        let runtime_generation = context.domain().runtime_generation();
        assert!(ages[1..].iter().all(|age| *age >= ages[0]));
        let observed = |age: Duration| {
            PlantObservationTime::at(
                runtime_generation,
                checked_at
                    .checked_sub(age)
                    .expect("test instant has enough subtraction range"),
            )
        };
        health_reader_at_in_context(
            context,
            checked_at
                .checked_sub(ages[0])
                .expect("test instant has enough receipt range"),
            HealthObservationTimesV1::new(
                observed(ages[1]),
                observed(ages[2]),
                observed(ages[3]),
                observed(ages[4]),
                observed(ages[5]),
                observed(ages[6]),
                observed(ages[7]),
            ),
            state,
        )
    }

    const fn test_plant_apply_observation_v1_matrix_anchor() {}

    #[test]
    fn apply_observation_should_share_one_exact_instant_across_every_age() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let runtime_generation = generation(2);
        let checked_at = Instant::now();
        let command = command_at(
            exact_profile,
            runtime_generation,
            checked_at
                .checked_sub(Duration::from_millis(5))
                .expect("test instant has enough command-age range"),
            Duration::from_millis(100),
        );
        let ages = [10, 11, 12, 13, 14, 15, 16, 17].map(Duration::from_millis);
        let reader = health_reader_with_ages(
            exact_profile,
            runtime_generation,
            checked_at,
            ages,
            nominal_state(),
        );
        let lifecycle = lifecycle_active(runtime_generation);
        let age_policy = policy(exact_profile, Duration::from_millis(50));

        let observation = ApplyCheckObservationCandidateV1::capture_at_for_test(
            &command,
            &lifecycle,
            &reader,
            &age_policy,
            checked_at,
        )
        .expect("coherent same-instant observation should form");
        let observed_ages = observation.health().observed().ages();

        assert_eq!(observation.command_age(), Duration::from_millis(5));
        assert_eq!(observed_ages.receipt(), ages[0]);
        assert_eq!(observed_ages.fcu_state(), ages[1]);
        assert_eq!(observed_ages.estimator(), ages[2]);
        assert_eq!(observed_ages.position(), ages[3]);
        assert_eq!(observed_ages.velocity(), ages[4]);
        assert_eq!(observed_ages.battery(), ages[5]);
        assert_eq!(observed_ages.fence(), ages[6]);
        assert_eq!(observed_ages.links(), ages[7]);
        assert_eq!(observation.profile(), exact_profile);
        assert_eq!(observation.session(), session(8));
        assert_eq!(observation.stream_sequence().get(), 9);
        assert_eq!(observation.generation(), runtime_generation);
        assert_eq!(observation.lifecycle().state(), PlantState::Active);
        assert_eq!(observation.lifecycle().generation(), runtime_generation);
    }

    #[test]
    fn requested_lifetime_relation_should_put_equality_outside() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let runtime_generation = generation(2);
        let checked_at = Instant::now();
        let reader = health_reader_with_ages(
            exact_profile,
            runtime_generation,
            checked_at,
            [Duration::from_millis(10); 8],
            nominal_state(),
        );
        let lifecycle = lifecycle_active(runtime_generation);
        let age_policy = policy(exact_profile, Duration::from_secs(1));

        for (age, expected) in [
            (
                Duration::from_millis(99),
                CommandRequestedLifetimeRelationAtCheckV1::WithinRequestedLifetimeAtCheck,
            ),
            (
                Duration::from_millis(100),
                CommandRequestedLifetimeRelationAtCheckV1::AtOrBeyondRequestedLifetimeAtCheck,
            ),
            (
                Duration::from_millis(101),
                CommandRequestedLifetimeRelationAtCheckV1::AtOrBeyondRequestedLifetimeAtCheck,
            ),
        ] {
            let command = command_at(
                exact_profile,
                runtime_generation,
                checked_at
                    .checked_sub(age)
                    .expect("test instant has enough command-age range"),
                Duration::from_millis(100),
            );
            let observation = ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &reader,
                &age_policy,
                checked_at,
            )
            .expect("expired command remains an observation");
            assert_eq!(
                observation.requested_ttl().get(),
                Duration::from_millis(100)
            );
            assert_eq!(observation.requested_lifetime_relation(), expected);
        }
    }

    #[test]
    fn profile_and_generation_prechecks_should_have_stable_precedence() {
        test_plant_apply_observation_v1_matrix_anchor();
        let checked_at = Instant::now();
        let command = command_at(
            profile(1),
            generation(1),
            checked_at,
            Duration::from_millis(100),
        );
        let (_publisher, empty_reader) =
            vehicle_health_channel(health_context(profile(1), generation(1)));
        let wrong_policy = policy(profile(2), Duration::from_secs(1));
        let wrong_lifecycle = LifecycleMachine::new(generation(2));

        assert!(matches!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &wrong_lifecycle,
                &empty_reader,
                &wrong_policy,
                checked_at,
            ),
            Err(ApplyCheckObservationErrorV1::CommandPolicyProfileMismatch { .. })
        ));

        let exact_policy = policy(profile(1), Duration::from_secs(1));
        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &wrong_lifecycle,
                &empty_reader,
                &exact_policy,
                checked_at,
            )
            .expect_err("generation mismatch must precede empty health"),
            ApplyCheckObservationErrorV1::CommandLifecycleGenerationMismatch {
                command_generation: generation(1),
                lifecycle_generation: generation(2),
            }
        );
    }

    #[test]
    fn health_read_should_precede_command_clock_regression() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let runtime_generation = generation(1);
        let checked_at = Instant::now();
        let command = command_at(
            exact_profile,
            runtime_generation,
            checked_at + Duration::from_millis(1),
            Duration::from_millis(100),
        );
        let lifecycle = LifecycleMachine::new(runtime_generation);
        let (_publisher, empty_reader) =
            vehicle_health_channel(health_context(exact_profile, runtime_generation));
        let age_policy = policy(exact_profile, Duration::from_secs(1));

        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &empty_reader,
                &age_policy,
                checked_at,
            )
            .expect_err("health read must fail before command clock evaluation"),
            ApplyCheckObservationErrorV1::VehicleHealthRead(VehicleHealthReadError::NoSnapshot)
        );

        let reader = health_reader_with_ages(
            exact_profile,
            runtime_generation,
            checked_at,
            [Duration::ZERO; 8],
            nominal_state(),
        );
        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &reader,
                &age_policy,
                checked_at,
            )
            .expect_err("command clock regression must fail after a coherent health read"),
            ApplyCheckObservationErrorV1::CommandClockRegression
        );
    }

    #[test]
    fn missing_poisoned_and_wrong_generation_health_should_fail_closed() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let runtime_generation = generation(1);
        let checked_at = Instant::now();
        let command = command_at(
            exact_profile,
            runtime_generation,
            checked_at,
            Duration::from_millis(100),
        );
        let lifecycle = LifecycleMachine::new(runtime_generation);
        let age_policy = policy(exact_profile, Duration::from_secs(1));

        let (publisher, empty_reader) =
            vehicle_health_channel(health_context(exact_profile, runtime_generation));
        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &empty_reader,
                &age_policy,
                checked_at,
            )
            .expect_err("empty health must fail closed"),
            ApplyCheckObservationErrorV1::VehicleHealthRead(VehicleHealthReadError::NoSnapshot)
        );

        publisher.poison_for_test();
        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &empty_reader,
                &age_policy,
                checked_at,
            )
            .expect_err("poisoned health must fail closed"),
            ApplyCheckObservationErrorV1::VehicleHealthRead(
                VehicleHealthReadError::StoragePoisoned
            )
        );

        let wrong_generation = generation(2);
        let wrong_reader = health_reader_with_ages(
            exact_profile,
            wrong_generation,
            checked_at,
            [Duration::from_millis(10); 8],
            nominal_state(),
        );
        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &wrong_reader,
                &age_policy,
                checked_at,
            )
            .expect_err("retained health generation mismatch must fail"),
            ApplyCheckObservationErrorV1::VehicleHealthRead(
                VehicleHealthReadError::RuntimeGenerationMismatch {
                    expected: runtime_generation,
                    received: wrong_generation,
                }
            )
        );
    }

    #[test]
    fn health_clock_regression_should_identify_the_first_future_time() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let runtime_generation = generation(1);
        let checked_at = Instant::now();
        let future = checked_at + Duration::from_millis(1);
        let reader = health_reader_at(
            exact_profile,
            runtime_generation,
            future,
            HealthObservationTimesV1::all(PlantObservationTime::at(runtime_generation, future)),
            nominal_state(),
        );
        let command = command_at(
            exact_profile,
            runtime_generation,
            checked_at,
            Duration::from_millis(100),
        );
        let lifecycle = LifecycleMachine::new(runtime_generation);
        let age_policy = policy(exact_profile, Duration::from_secs(1));

        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &reader,
                &age_policy,
                checked_at,
            )
            .expect_err("future health receipt must fail"),
            ApplyCheckObservationErrorV1::VehicleHealthRead(
                VehicleHealthReadError::ClockRegression {
                    point: crate::health::VehicleHealthTimePointV1::Receipt,
                }
            )
        );
    }

    fn assert_unbound_domain_and_content_reminting(
        exact_profile: ProfileIdentity,
        runtime_generation: RuntimeGeneration,
        checked_at: Instant,
        command: &VelocityCommandCandidateV1,
        lifecycle: &LifecycleMachine,
        age_policy: &VehicleHealthCapturedAgePolicyV1,
    ) {
        let alternate_vehicle =
            VehicleIdentity::new([9; 16]).expect("alternate test vehicle identity is nonzero");
        let alternate_frame = LocalFrameInstanceIdentity::new([10; 16])
            .expect("alternate test frame identity is nonzero");
        let alternate_context =
            health_context_with_markers(exact_profile, runtime_generation, 9, 10);
        let alternate_reader = health_reader_with_ages_in_context(
            alternate_context,
            checked_at,
            [Duration::from_millis(10); 8],
            nominal_state(),
        );
        let observation = ApplyCheckObservationCandidateV1::capture_at_for_test(
            command,
            lifecycle,
            &alternate_reader,
            age_policy,
            checked_at,
        )
        .expect("command carries no vehicle or frame-instance identity to compare");
        let observed_domain = observation
            .health()
            .observed()
            .snapshot()
            .metadata()
            .domain();
        assert_eq!(observed_domain.vehicle(), alternate_vehicle);
        assert_eq!(observed_domain.local_frame_instance(), alternate_frame);

        let different_content_command = command_at_with_velocity(
            exact_profile,
            runtime_generation,
            checked_at,
            Duration::from_millis(100),
            [0.5, 0.0, 0.0],
        );
        assert_ne!(
            command.velocity().components().map(f64::to_bits),
            different_content_command
                .velocity()
                .components()
                .map(f64::to_bits)
        );
        let reminted = ApplyCheckObservationCandidateV1::capture_at_for_test(
            &different_content_command,
            lifecycle,
            &alternate_reader,
            age_policy,
            checked_at,
        )
        .expect("a stateless observation does not content-bind equal command identifiers");
        assert_eq!(reminted.profile(), observation.profile());
        assert_eq!(reminted.session(), observation.session());
        assert_eq!(reminted.stream_sequence(), observation.stream_sequence());
        assert_eq!(reminted.generation(), observation.generation());
        assert_eq!(reminted.requested_ttl(), observation.requested_ttl());
    }

    #[test]
    fn profile_mismatch_and_unbound_command_health_domains_should_remain_explicit() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let observed_profile = profile(2);
        let runtime_generation = generation(1);
        let checked_at = Instant::now();
        let reader = health_reader_with_ages(
            observed_profile,
            runtime_generation,
            checked_at,
            [Duration::from_millis(10); 8],
            nominal_state(),
        );
        let command = command_at(
            exact_profile,
            runtime_generation,
            checked_at,
            Duration::from_millis(100),
        );
        let lifecycle = LifecycleMachine::new(runtime_generation);
        let age_policy = policy(exact_profile, Duration::from_secs(1));

        let wrong_generation = generation(2);
        let wrong_generation_and_profile_reader = health_reader_with_ages(
            observed_profile,
            wrong_generation,
            checked_at,
            [Duration::from_millis(10); 8],
            nominal_state(),
        );
        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &wrong_generation_and_profile_reader,
                &age_policy,
                checked_at,
            )
            .expect_err("health generation mismatch must precede health/policy profile mismatch"),
            ApplyCheckObservationErrorV1::VehicleHealthRead(
                VehicleHealthReadError::RuntimeGenerationMismatch {
                    expected: runtime_generation,
                    received: wrong_generation,
                }
            )
        );

        assert_eq!(
            ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &reader,
                &age_policy,
                checked_at,
            )
            .expect_err("health/policy profile mismatch must fail"),
            ApplyCheckObservationErrorV1::HealthPolicyProfileMismatch {
                policy_profile: exact_profile,
                observed_profile,
            }
        );

        assert_unbound_domain_and_content_reminting(
            exact_profile,
            runtime_generation,
            checked_at,
            &command,
            &lifecycle,
            &age_policy,
        );
    }

    #[test]
    fn every_lifecycle_state_should_remain_an_observation_not_a_verdict() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let checked_at = Instant::now();
        let age_policy = policy(exact_profile, Duration::from_millis(5));

        for expected_state in [
            PlantState::Boot,
            PlantState::NoAuthority,
            PlantState::Standby,
            PlantState::Preflight,
            PlantState::AuthorizedHold,
            PlantState::Active,
            PlantState::Degraded,
            PlantState::Emergency,
            PlantState::Shutdown,
        ] {
            let lifecycle = lifecycle_in_state(generation(1), expected_state);
            let runtime_generation = lifecycle.generation();
            let reader = health_reader_with_ages(
                exact_profile,
                runtime_generation,
                checked_at,
                [Duration::from_millis(10); 8],
                nominal_state(),
            );
            let command = command_at(
                exact_profile,
                runtime_generation,
                checked_at
                    .checked_sub(Duration::from_millis(200))
                    .expect("test instant has enough command-age range"),
                Duration::from_millis(100),
            );
            let observation = ApplyCheckObservationCandidateV1::capture_at_for_test(
                &command,
                &lifecycle,
                &reader,
                &age_policy,
                checked_at,
            )
            .expect("adverse facts remain successful observations");
            assert_eq!(observation.lifecycle().state(), expected_state);
            assert_eq!(
                observation.requested_lifetime_relation(),
                CommandRequestedLifetimeRelationAtCheckV1::AtOrBeyondRequestedLifetimeAtCheck
            );
            assert_eq!(
                observation.health().receipt().relation_at_read(),
                VehicleHealthAgeRelationAtReadV1::AtOrBeyondExclusiveLimitAtRead
            );
        }
    }

    #[test]
    fn recent_unknown_and_unavailable_health_should_not_become_nominal() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let runtime_generation = generation(1);
        let checked_at = Instant::now();
        let reader = health_reader_with_ages(
            exact_profile,
            runtime_generation,
            checked_at,
            [Duration::from_millis(1); 8],
            adverse_unknown_state(),
        );
        let command = command_at(
            exact_profile,
            runtime_generation,
            checked_at,
            Duration::from_millis(100),
        );
        let lifecycle = lifecycle_active(runtime_generation);
        let age_policy = policy(exact_profile, Duration::from_secs(1));

        let observation = ApplyCheckObservationCandidateV1::capture_at_for_test(
            &command,
            &lifecycle,
            &reader,
            &age_policy,
            checked_at,
        )
        .expect("recent adverse health remains observable");
        let state = observation.health().observed().snapshot().state();

        assert_eq!(state.fcu().arming(), ArmingStateV1::Unknown);
        assert!(matches!(
            state.position(),
            PositionObservationV1::Unavailable(MeasurementUnavailableReasonV1::ResetInProgress)
        ));
        assert_eq!(
            observation.health().position().relation_at_read(),
            VehicleHealthAgeRelationAtReadV1::WithinExclusiveLimitAtRead
        );
    }

    #[test]
    fn production_capture_should_form_evidence_without_returning_command_content() {
        test_plant_apply_observation_v1_matrix_anchor();
        let exact_profile = profile(1);
        let runtime_generation = generation(1);
        let observed_at = PlantObservationTime::now(runtime_generation);
        let reader = health_reader_at(
            exact_profile,
            runtime_generation,
            Instant::now(),
            HealthObservationTimesV1::all(observed_at),
            nominal_state(),
        );
        let command = command_at(
            exact_profile,
            runtime_generation,
            Instant::now(),
            Duration::from_millis(100),
        );
        let lifecycle = lifecycle_active(runtime_generation);
        let age_policy = policy(exact_profile, Duration::from_secs(1));

        let observation =
            ApplyCheckObservationCandidateV1::capture(&command, &lifecycle, &reader, &age_policy)
                .expect("current coherent inputs should form an observation");

        assert_eq!(observation.profile(), exact_profile);
        assert_eq!(observation.lifecycle().state(), PlantState::Active);
    }
}
