//! Inert profile-bound classification of vehicle-health ages captured at one read.
//!
//! This module does not read a clock and does not establish that health is
//! fresh at assessment or apply time. It compares only the ages already frozen
//! inside one [`ObservedVehicleHealthV1`] against structurally bound,
//! unapproved exclusive limits.

use std::fmt;
use std::time::Duration;

use crate::contract::ProfileIdentity;
use crate::health::{ObservedVehicleHealthV1, VehicleHealthAgesV1};

/// One captured-read age point classified by the inert policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VehicleHealthAgePointV1 {
    /// Age since the report was received and validation began.
    Receipt,
    /// Age of the FCU-state observation group.
    FcuState,
    /// Age of the estimator observation group.
    Estimator,
    /// Age of the local-position observation group.
    Position,
    /// Age of the local-velocity observation group.
    Velocity,
    /// Age of the battery observation group.
    Battery,
    /// Age of the fence observation group.
    Fence,
    /// Age of the link-state observation group.
    Links,
}

/// Named, untrusted exclusive age limits proposed for one policy.
///
/// Every field must be nonzero. Construct this value with a struct literal so
/// each duration remains visibly attached to its semantic point. The proposal
/// is consumed during validation and deliberately has no positional
/// constructor or default.
#[derive(Debug)]
pub struct VehicleHealthAgeLimitsProposalV1 {
    /// Exclusive maximum age since local receipt at the captured read.
    pub receipt: Duration,
    /// Exclusive maximum FCU-state observation age at the captured read.
    pub fcu_state: Duration,
    /// Exclusive maximum estimator observation age at the captured read.
    pub estimator: Duration,
    /// Exclusive maximum local-position observation age at the captured read.
    pub position: Duration,
    /// Exclusive maximum local-velocity observation age at the captured read.
    pub velocity: Duration,
    /// Exclusive maximum battery observation age at the captured read.
    pub battery: Duration,
    /// Exclusive maximum fence observation age at the captured read.
    pub fence: Duration,
    /// Exclusive maximum link-state observation age at the captured read.
    pub links: Duration,
}

/// Error returned when a proposed captured-read age policy is invalid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthAgePolicyConfigurationErrorV1 {
    point: VehicleHealthAgePointV1,
}

impl VehicleHealthAgePolicyConfigurationErrorV1 {
    /// Returns the point whose proposed exclusive limit was zero.
    #[must_use]
    pub const fn point(self) -> VehicleHealthAgePointV1 {
        self.point
    }
}

impl fmt::Display for VehicleHealthAgePolicyConfigurationErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "captured-read health-age limit for {:?} must be nonzero",
            self.point
        )
    }
}

impl std::error::Error for VehicleHealthAgePolicyConfigurationErrorV1 {}

/// Structurally profile-bound captured-read age policy.
///
/// The exact [`ProfileIdentity`] is retained, including semantic kind and
/// artifact digest. This binding does not authenticate the profile, prove the
/// limits came from that artifact, or approve any limit for deployment.
#[derive(Debug)]
pub struct VehicleHealthCapturedAgePolicyV1 {
    profile: ProfileIdentity,
    limits: VehicleHealthAgeLimitsProposalV1,
}

impl VehicleHealthCapturedAgePolicyV1 {
    /// Validates nonzero named limits and binds them to one exact profile.
    ///
    /// # Errors
    ///
    /// Returns [`VehicleHealthAgePolicyConfigurationErrorV1`] for the first
    /// zero limit in stable point order.
    pub fn try_new(
        profile: ProfileIdentity,
        limits: VehicleHealthAgeLimitsProposalV1,
    ) -> Result<Self, VehicleHealthAgePolicyConfigurationErrorV1> {
        for (point, limit) in [
            (VehicleHealthAgePointV1::Receipt, limits.receipt),
            (VehicleHealthAgePointV1::FcuState, limits.fcu_state),
            (VehicleHealthAgePointV1::Estimator, limits.estimator),
            (VehicleHealthAgePointV1::Position, limits.position),
            (VehicleHealthAgePointV1::Velocity, limits.velocity),
            (VehicleHealthAgePointV1::Battery, limits.battery),
            (VehicleHealthAgePointV1::Fence, limits.fence),
            (VehicleHealthAgePointV1::Links, limits.links),
        ] {
            if limit.is_zero() {
                return Err(VehicleHealthAgePolicyConfigurationErrorV1 { point });
            }
        }
        Ok(Self { profile, limits })
    }

    /// Returns the exact structurally bound profile identity.
    #[must_use]
    pub const fn profile(&self) -> ProfileIdentity {
        self.profile
    }

    /// Returns the exclusive limit for one named age point.
    #[must_use]
    pub const fn exclusive_limit(&self, point: VehicleHealthAgePointV1) -> Duration {
        match point {
            VehicleHealthAgePointV1::Receipt => self.limits.receipt,
            VehicleHealthAgePointV1::FcuState => self.limits.fcu_state,
            VehicleHealthAgePointV1::Estimator => self.limits.estimator,
            VehicleHealthAgePointV1::Position => self.limits.position,
            VehicleHealthAgePointV1::Velocity => self.limits.velocity,
            VehicleHealthAgePointV1::Battery => self.limits.battery,
            VehicleHealthAgePointV1::Fence => self.limits.fence,
            VehicleHealthAgePointV1::Links => self.limits.links,
        }
    }

    /// Consumes one coherent captured read and binds its classifications to
    /// this exact policy.
    ///
    /// This function does not read a clock. A classification can cease to
    /// describe the current time or generation immediately after the health
    /// reader produced `observed`. A future apply-time governor must reload
    /// health and recheck lifecycle generation immediately before every write.
    ///
    /// # Errors
    ///
    /// Returns [`VehicleHealthAgeAssessmentErrorV1`] when the observed
    /// snapshot is bound to a different exact profile identity.
    pub fn assess(
        &self,
        observed: ObservedVehicleHealthV1,
    ) -> Result<VehicleHealthCapturedAgeAssessmentV1<'_>, VehicleHealthAgeAssessmentErrorV1> {
        let observed_profile = observed.snapshot().metadata().domain().profile();
        if observed_profile != self.profile {
            return Err(VehicleHealthAgeAssessmentErrorV1 {
                policy_profile: self.profile,
                observed_profile,
            });
        }
        Ok(VehicleHealthCapturedAgeAssessmentV1 {
            policy: self,
            observed,
        })
    }
}

/// Exact-profile mismatch returned before captured ages are classified.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthAgeAssessmentErrorV1 {
    policy_profile: ProfileIdentity,
    observed_profile: ProfileIdentity,
}

impl VehicleHealthAgeAssessmentErrorV1 {
    /// Returns the profile identity bound to the policy.
    #[must_use]
    pub const fn policy_profile(self) -> ProfileIdentity {
        self.policy_profile
    }

    /// Returns the profile identity retained in the observed snapshot.
    #[must_use]
    pub const fn observed_profile(self) -> ProfileIdentity {
        self.observed_profile
    }
}

impl fmt::Display for VehicleHealthAgeAssessmentErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("captured-read health-age policy profile does not match observation")
    }
}

impl std::error::Error for VehicleHealthAgeAssessmentErrorV1 {}

/// Exclusive-limit relation for an age frozen at the health-reader instant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VehicleHealthAgeRelationAtReadV1 {
    /// The captured age was strictly below the exclusive limit at that read.
    WithinExclusiveLimitAtRead,
    /// The captured age equaled or exceeded the exclusive limit at that read.
    AtOrBeyondExclusiveLimitAtRead,
}

/// One named captured age and its exact exclusive comparison limit.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthAgeComparisonAtReadV1 {
    point: VehicleHealthAgePointV1,
    age: Duration,
    exclusive_limit: Duration,
}

impl VehicleHealthAgeComparisonAtReadV1 {
    /// Returns the semantic age point.
    #[must_use]
    pub const fn point(self) -> VehicleHealthAgePointV1 {
        self.point
    }

    /// Returns the age frozen at the checked health-reader instant.
    #[must_use]
    pub const fn age(self) -> Duration {
        self.age
    }

    /// Returns the policy's exact exclusive limit.
    #[must_use]
    pub const fn exclusive_limit(self) -> Duration {
        self.exclusive_limit
    }

    /// Compares the captured age directly with the exclusive limit.
    ///
    /// Equality is outside the limit. This is an age-only relation at the read
    /// instant, not a healthy, safe, eligible, or authorized verdict.
    #[must_use]
    pub fn relation_at_read(self) -> VehicleHealthAgeRelationAtReadV1 {
        if self.age < self.exclusive_limit {
            VehicleHealthAgeRelationAtReadV1::WithinExclusiveLimitAtRead
        } else {
            VehicleHealthAgeRelationAtReadV1::AtOrBeyondExclusiveLimitAtRead
        }
    }
}

/// One observed health snapshot owned together with classifications tied to an
/// exact borrowed policy.
///
/// It cannot be cloned, directly constructed, decomposed, converted to a
/// boolean, or created from bare ages:
///
/// ```compile_fail
/// use crebain_plant_authority::VehicleHealthCapturedAgeAssessmentV1;
///
/// fn duplicate(assessment: VehicleHealthCapturedAgeAssessmentV1<'_>) {
///     let _copy = assessment.clone();
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{
///     ObservedVehicleHealthV1, VehicleHealthCapturedAgeAssessmentV1,
///     VehicleHealthCapturedAgePolicyV1,
/// };
///
/// fn construct<'a>(
///     policy: &'a VehicleHealthCapturedAgePolicyV1,
///     observed: ObservedVehicleHealthV1,
/// ) -> VehicleHealthCapturedAgeAssessmentV1<'a> {
///     VehicleHealthCapturedAgeAssessmentV1 { policy, observed }
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{VehicleHealthAgesV1, VehicleHealthCapturedAgePolicyV1};
///
/// fn assess_bare_ages(
///     policy: &VehicleHealthCapturedAgePolicyV1,
///     ages: VehicleHealthAgesV1,
/// ) {
///     let _ = policy.assess(ages);
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::VehicleHealthAgeComparisonAtReadV1;
///
/// fn convert_to_boolean(comparison: VehicleHealthAgeComparisonAtReadV1) -> bool {
///     comparison.into()
/// }
/// ```
///
/// ```compile_fail
/// use crebain_plant_authority::{
///     ObservedVehicleHealthV1, VehicleHealthCapturedAgeAssessmentV1,
/// };
///
/// fn decompose(
///     assessment: VehicleHealthCapturedAgeAssessmentV1<'_>,
/// ) -> ObservedVehicleHealthV1 {
///     assessment.into_observed()
/// }
/// ```
#[derive(Debug)]
pub struct VehicleHealthCapturedAgeAssessmentV1<'policy> {
    policy: &'policy VehicleHealthCapturedAgePolicyV1,
    observed: ObservedVehicleHealthV1,
}

impl<'policy> VehicleHealthCapturedAgeAssessmentV1<'policy> {
    /// Returns the exact policy borrowed by this assessment.
    #[must_use]
    pub const fn policy(&self) -> &'policy VehicleHealthCapturedAgePolicyV1 {
        self.policy
    }

    /// Returns the exact owned coherent observation without decomposing it.
    #[must_use]
    pub const fn observed(&self) -> &ObservedVehicleHealthV1 {
        &self.observed
    }

    /// Returns the receipt-age comparison at the captured read.
    #[must_use]
    pub fn receipt(&self) -> VehicleHealthAgeComparisonAtReadV1 {
        self.comparison(VehicleHealthAgePointV1::Receipt)
    }

    /// Returns the FCU-state-age comparison at the captured read.
    #[must_use]
    pub fn fcu_state(&self) -> VehicleHealthAgeComparisonAtReadV1 {
        self.comparison(VehicleHealthAgePointV1::FcuState)
    }

    /// Returns the estimator-age comparison at the captured read.
    #[must_use]
    pub fn estimator(&self) -> VehicleHealthAgeComparisonAtReadV1 {
        self.comparison(VehicleHealthAgePointV1::Estimator)
    }

    /// Returns the position-age comparison at the captured read.
    #[must_use]
    pub fn position(&self) -> VehicleHealthAgeComparisonAtReadV1 {
        self.comparison(VehicleHealthAgePointV1::Position)
    }

    /// Returns the velocity-age comparison at the captured read.
    #[must_use]
    pub fn velocity(&self) -> VehicleHealthAgeComparisonAtReadV1 {
        self.comparison(VehicleHealthAgePointV1::Velocity)
    }

    /// Returns the battery-age comparison at the captured read.
    #[must_use]
    pub fn battery(&self) -> VehicleHealthAgeComparisonAtReadV1 {
        self.comparison(VehicleHealthAgePointV1::Battery)
    }

    /// Returns the fence-age comparison at the captured read.
    #[must_use]
    pub fn fence(&self) -> VehicleHealthAgeComparisonAtReadV1 {
        self.comparison(VehicleHealthAgePointV1::Fence)
    }

    /// Returns the link-state-age comparison at the captured read.
    #[must_use]
    pub fn links(&self) -> VehicleHealthAgeComparisonAtReadV1 {
        self.comparison(VehicleHealthAgePointV1::Links)
    }

    fn comparison(&self, point: VehicleHealthAgePointV1) -> VehicleHealthAgeComparisonAtReadV1 {
        let ages = self.observed.ages();
        let age = age_for_point(ages, point);
        VehicleHealthAgeComparisonAtReadV1 {
            point,
            age,
            exclusive_limit: self.policy.exclusive_limit(point),
        }
    }
}

const fn age_for_point(ages: VehicleHealthAgesV1, point: VehicleHealthAgePointV1) -> Duration {
    match point {
        VehicleHealthAgePointV1::Receipt => ages.receipt(),
        VehicleHealthAgePointV1::FcuState => ages.fcu_state(),
        VehicleHealthAgePointV1::Estimator => ages.estimator(),
        VehicleHealthAgePointV1::Position => ages.position(),
        VehicleHealthAgePointV1::Velocity => ages.velocity(),
        VehicleHealthAgePointV1::Battery => ages.battery(),
        VehicleHealthAgePointV1::Fence => ages.fence(),
        VehicleHealthAgePointV1::Links => ages.links(),
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;
    use std::time::Instant;

    use super::*;
    use crate::contract::{CandidateProfileKind, CandidateProfileV1, VelocityUnit};
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
    use crate::lifecycle::RuntimeGeneration;

    const POINTS: [VehicleHealthAgePointV1; 8] = [
        VehicleHealthAgePointV1::Receipt,
        VehicleHealthAgePointV1::FcuState,
        VehicleHealthAgePointV1::Estimator,
        VehicleHealthAgePointV1::Position,
        VehicleHealthAgePointV1::Velocity,
        VehicleHealthAgePointV1::Battery,
        VehicleHealthAgePointV1::Fence,
        VehicleHealthAgePointV1::Links,
    ];

    fn generation(value: u64) -> RuntimeGeneration {
        RuntimeGeneration::new(NonZeroU64::new(value).expect("test generation is nonzero"))
    }

    fn profile(kind: CandidateProfileKind, digest: u8) -> ProfileIdentity {
        ProfileIdentity::new(kind, [digest; 32]).expect("test profile digest is nonzero")
    }

    fn context(
        profile: ProfileIdentity,
        runtime_generation: RuntimeGeneration,
    ) -> VehicleHealthContextV1 {
        VehicleHealthContextV1::new(
            CandidateProfileV1::from_identity(profile),
            VehicleIdentity::new([2; 16]).expect("test vehicle identity is nonzero"),
            FcuHealthSourceIdentity::new([3; 32]).expect("test source identity is nonzero"),
            HealthStreamEpochIdentity::new([4; 16]).expect("test epoch identity is nonzero"),
            runtime_generation,
            LocalFrameInstanceIdentity::new([5; 16])
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
            FenceStateV1::Breached,
            FcuLinksV1::new(
                LinkStateV1::Disconnected,
                LinkStateV1::Unknown,
                LinkStateV1::Disconnected,
            ),
        )
    }

    fn observed_with_ages(
        profile: ProfileIdentity,
        ages: [Duration; 8],
        state: VehicleHealthStateV1,
        source_sequence: u64,
    ) -> ObservedVehicleHealthV1 {
        assert!(
            ages[1..].iter().all(|age| *age >= ages[0]),
            "test observations must not occur after receipt"
        );
        let runtime_generation = generation(1);
        let health_context = context(profile, runtime_generation);
        let read_at = Instant::now();
        let at_age = |age: Duration| {
            PlantObservationTime::at(
                runtime_generation,
                read_at
                    .checked_sub(age)
                    .expect("test instant has enough subtraction range"),
            )
        };
        let report = VehicleHealthReportV1::new(
            VehicleHealthMetadataV1::new(
                VEHICLE_HEALTH_SCHEMA_V1,
                health_context.domain(),
                HealthStreamSequence::new(source_sequence)
                    .expect("test source sequence is nonzero"),
            ),
            VehicleHealthUnitsV1::new(
                health_context.profile().velocity_frame(),
                PositionUnitV1::Metres,
                VelocityUnit::MetresPerSecond,
            ),
            HealthObservationTimesV1::new(
                at_age(ages[1]),
                at_age(ages[2]),
                at_age(ages[3]),
                at_age(ages[4]),
                at_age(ages[5]),
                at_age(ages[6]),
                at_age(ages[7]),
            ),
            state,
        );
        let receipt_at = read_at
            .checked_sub(ages[0])
            .expect("test instant has enough receipt subtraction range");
        let (mut publisher, reader) = vehicle_health_channel(health_context);
        publisher
            .commit_for_test_at(&report, receipt_at)
            .expect("controlled test report should commit");
        reader
            .load_at(runtime_generation, read_at)
            .expect("controlled test observation should load")
    }

    fn proposed_limits(values: [Duration; 8]) -> VehicleHealthAgeLimitsProposalV1 {
        VehicleHealthAgeLimitsProposalV1 {
            receipt: values[0],
            fcu_state: values[1],
            estimator: values[2],
            position: values[3],
            velocity: values[4],
            battery: values[5],
            fence: values[6],
            links: values[7],
        }
    }

    fn comparisons(
        assessment: &VehicleHealthCapturedAgeAssessmentV1<'_>,
    ) -> [VehicleHealthAgeComparisonAtReadV1; 8] {
        [
            assessment.receipt(),
            assessment.fcu_state(),
            assessment.estimator(),
            assessment.position(),
            assessment.velocity(),
            assessment.battery(),
            assessment.fence(),
            assessment.links(),
        ]
    }

    #[test]
    fn vehicle_health_freshness_v1_should_fail_closed_across_policy_and_age_boundaries() {
        let exact_profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 1);
        let limit_values = [
            Duration::from_nanos(101),
            Duration::from_nanos(202),
            Duration::from_nanos(303),
            Duration::from_nanos(404),
            Duration::from_nanos(505),
            Duration::from_nanos(606),
            Duration::from_nanos(707),
            Duration::from_nanos(808),
        ];

        for (index, point) in POINTS.into_iter().enumerate() {
            let mut zero_case = limit_values;
            zero_case[index] = Duration::ZERO;
            let error = VehicleHealthCapturedAgePolicyV1::try_new(
                exact_profile,
                proposed_limits(zero_case),
            )
            .expect_err("every zero limit must fail closed");
            assert_eq!(error.point(), point);
        }

        for (index, point) in POINTS.into_iter().enumerate() {
            let limit = limit_values[index];
            let below_limit = limit
                .checked_sub(Duration::from_nanos(1))
                .expect("test limits are greater than one nanosecond");
            for (age, expected) in [
                (
                    below_limit,
                    VehicleHealthAgeRelationAtReadV1::WithinExclusiveLimitAtRead,
                ),
                (
                    limit,
                    VehicleHealthAgeRelationAtReadV1::AtOrBeyondExclusiveLimitAtRead,
                ),
                (
                    limit + Duration::from_nanos(1),
                    VehicleHealthAgeRelationAtReadV1::AtOrBeyondExclusiveLimitAtRead,
                ),
            ] {
                let mut captured_ages = [Duration::from_nanos(1); 8];
                captured_ages[index] = age;
                if point == VehicleHealthAgePointV1::Receipt {
                    for other_age in &mut captured_ages[1..] {
                        *other_age = age;
                    }
                }
                let policy = VehicleHealthCapturedAgePolicyV1::try_new(
                    exact_profile,
                    proposed_limits(limit_values),
                )
                .expect("all named limits are nonzero");
                let assessment = policy
                    .assess(observed_with_ages(
                        exact_profile,
                        captured_ages,
                        nominal_state(),
                        1,
                    ))
                    .expect("exact profile should assess");
                let comparison = comparisons(&assessment)[index];
                assert_eq!(comparison.point(), point);
                assert_eq!(comparison.age(), age);
                assert_eq!(comparison.exclusive_limit(), limit);
                assert_eq!(comparison.relation_at_read(), expected);
            }
        }
    }

    #[test]
    fn exact_profile_kind_and_digest_should_be_required_before_assessment() {
        let observed_profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 1);
        let ages = [Duration::from_nanos(1); 8];
        let limits = [Duration::from_secs(1); 8];

        for policy_profile in [
            profile(CandidateProfileKind::DraftL1SitlLocalNed, 2),
            profile(CandidateProfileKind::DraftL1SitlLocalEnu, 1),
        ] {
            let policy =
                VehicleHealthCapturedAgePolicyV1::try_new(policy_profile, proposed_limits(limits))
                    .expect("all named limits are nonzero");
            let error = policy
                .assess(observed_with_ages(
                    observed_profile,
                    ages,
                    nominal_state(),
                    1,
                ))
                .expect_err("kind or digest mismatch must fail before classification");
            assert_eq!(error.policy_profile(), policy_profile);
            assert_eq!(error.observed_profile(), observed_profile);
        }
    }

    #[test]
    fn assessment_should_retain_exact_observation_policy_and_field_mapping() {
        let exact_profile = profile(CandidateProfileKind::DraftL1SitlLocalEnu, 9);
        let captured_ages = [
            Duration::from_nanos(1),
            Duration::from_nanos(11),
            Duration::from_nanos(22),
            Duration::from_nanos(33),
            Duration::from_nanos(44),
            Duration::from_nanos(55),
            Duration::from_nanos(66),
            Duration::from_nanos(77),
        ];
        let limit_values = [
            Duration::from_nanos(101),
            Duration::from_nanos(211),
            Duration::from_nanos(322),
            Duration::from_nanos(433),
            Duration::from_nanos(544),
            Duration::from_nanos(655),
            Duration::from_nanos(766),
            Duration::from_nanos(877),
        ];
        let policy =
            VehicleHealthCapturedAgePolicyV1::try_new(exact_profile, proposed_limits(limit_values))
                .expect("all named limits are nonzero");
        let assessment = policy
            .assess(observed_with_ages(
                exact_profile,
                captured_ages,
                nominal_state(),
                41,
            ))
            .expect("exact profile should assess");

        assert!(std::ptr::eq(assessment.policy(), &raw const policy));
        assert_eq!(assessment.policy().profile(), exact_profile);
        assert_eq!(assessment.observed().register_sequence(), 1);
        assert_eq!(
            assessment
                .observed()
                .snapshot()
                .metadata()
                .stream_sequence()
                .get(),
            41
        );
        for (index, comparison) in comparisons(&assessment).into_iter().enumerate() {
            assert_eq!(comparison.point(), POINTS[index]);
            assert_eq!(comparison.age(), captured_ages[index]);
            assert_eq!(comparison.exclusive_limit(), limit_values[index]);
        }
    }

    #[test]
    fn duration_max_should_compare_directly_without_overflow() {
        let exact_profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 1);
        let policy = VehicleHealthCapturedAgePolicyV1::try_new(
            exact_profile,
            proposed_limits([Duration::MAX; 8]),
        )
        .expect("maximum finite Duration is a nonzero limit");
        let assessment = policy
            .assess(observed_with_ages(
                exact_profile,
                [Duration::from_secs(1); 8],
                nominal_state(),
                1,
            ))
            .expect("exact profile should assess");

        for comparison in comparisons(&assessment) {
            assert_eq!(
                comparison.relation_at_read(),
                VehicleHealthAgeRelationAtReadV1::WithinExclusiveLimitAtRead
            );
        }
    }

    #[test]
    fn adverse_and_unknown_state_can_be_within_age_limit_without_health_verdict() {
        let exact_profile = profile(CandidateProfileKind::DraftL1SitlLocalNed, 1);
        let policy = VehicleHealthCapturedAgePolicyV1::try_new(
            exact_profile,
            proposed_limits([Duration::from_secs(1); 8]),
        )
        .expect("all named limits are nonzero");
        let assessment = policy
            .assess(observed_with_ages(
                exact_profile,
                [Duration::from_nanos(1); 8],
                adverse_unknown_state(),
                1,
            ))
            .expect("exact profile should assess");

        for comparison in comparisons(&assessment) {
            assert_eq!(
                comparison.relation_at_read(),
                VehicleHealthAgeRelationAtReadV1::WithinExclusiveLimitAtRead
            );
        }
        let state = assessment.observed().snapshot().state();
        assert_eq!(state.fcu().failsafe(), FcuFailsafeStateV1::Active);
        assert_eq!(
            state.position(),
            PositionObservationV1::Unavailable(MeasurementUnavailableReasonV1::ResetInProgress)
        );
        assert_eq!(state.fence(), FenceStateV1::Breached);
        assert_eq!(state.links().plant_to_fcu(), LinkStateV1::Disconnected);
    }
}
