//! Inactive, closed vehicle-health contract and retained snapshot boundary.
//!
//! This module validates one in-memory report into a deeply immutable snapshot.
//! It performs no parsing, transport, authentication, freshness classification,
//! lifecycle transition, authority decision, adapter call, or I/O.

use std::fmt;
use std::num::NonZeroU64;
use std::time::{Duration, Instant};

use crate::channels::{
    snapshot_value, ChannelError, ChannelReadError, SnapshotCommit, SnapshotReceiver,
    SnapshotSender,
};
use crate::{CandidateProfileV1, ProfileIdentity, RuntimeGeneration, VelocityFrame, VelocityUnit};

/// Sole schema version accepted by the inactive vehicle-health contract.
pub const VEHICLE_HEALTH_SCHEMA_V1: u16 = 1;

/// Kind of health identity rejected as an unset all-zero value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HealthIdentityKind {
    /// One vehicle instance.
    Vehicle,
    /// Configured FCU health source or source-configuration digest.
    Source,
    /// One source stream epoch.
    StreamEpoch,
    /// One local-frame origin/datum instance.
    LocalFrameInstance,
}

/// Error returned when a health identity is structurally unset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HealthIdentityError {
    kind: HealthIdentityKind,
}

impl HealthIdentityError {
    /// Returns the rejected identity kind.
    #[must_use]
    pub const fn kind(self) -> HealthIdentityKind {
        self.kind
    }
}

impl fmt::Display for HealthIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{:?} health identity must not be all zero",
            self.kind
        )
    }
}

impl std::error::Error for HealthIdentityError {}

/// Identity of the single vehicle represented by one health channel.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct VehicleIdentity([u8; 16]);

impl VehicleIdentity {
    /// Creates a nonzero vehicle identity.
    ///
    /// # Errors
    ///
    /// Returns [`HealthIdentityError`] when every byte is zero.
    pub fn new(bytes: [u8; 16]) -> Result<Self, HealthIdentityError> {
        nonzero_identity(bytes, HealthIdentityKind::Vehicle).map(Self)
    }

    /// Returns the exact identity bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// Declared identity of one configured FCU health source.
///
/// Equality is structural. This value does not authenticate its producer.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct FcuHealthSourceIdentity([u8; 32]);

impl FcuHealthSourceIdentity {
    /// Creates a nonzero source identity or configuration digest.
    ///
    /// # Errors
    ///
    /// Returns [`HealthIdentityError`] when every byte is zero.
    pub fn new(bytes: [u8; 32]) -> Result<Self, HealthIdentityError> {
        if bytes.iter().all(|byte| *byte == 0) {
            return Err(HealthIdentityError {
                kind: HealthIdentityKind::Source,
            });
        }
        Ok(Self(bytes))
    }

    /// Returns the exact identity bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Identity of one monotonic sequence epoch for a configured health source.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct HealthStreamEpochIdentity([u8; 16]);

impl HealthStreamEpochIdentity {
    /// Creates a nonzero source-stream epoch identity.
    ///
    /// # Errors
    ///
    /// Returns [`HealthIdentityError`] when every byte is zero.
    pub fn new(bytes: [u8; 16]) -> Result<Self, HealthIdentityError> {
        nonzero_identity(bytes, HealthIdentityKind::StreamEpoch).map(Self)
    }

    /// Returns the exact identity bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// Identity of one local-frame origin and datum instance.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct LocalFrameInstanceIdentity([u8; 16]);

impl LocalFrameInstanceIdentity {
    /// Creates a nonzero local-frame-instance identity.
    ///
    /// # Errors
    ///
    /// Returns [`HealthIdentityError`] when every byte is zero.
    pub fn new(bytes: [u8; 16]) -> Result<Self, HealthIdentityError> {
        nonzero_identity(bytes, HealthIdentityKind::LocalFrameInstance).map(Self)
    }

    /// Returns the exact identity bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

fn nonzero_identity<const N: usize>(
    bytes: [u8; N],
    kind: HealthIdentityKind,
) -> Result<[u8; N], HealthIdentityError> {
    if bytes.iter().all(|byte| *byte == 0) {
        Err(HealthIdentityError { kind })
    } else {
        Ok(bytes)
    }
}

/// Exact nonzero sequence within one health source stream epoch.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct HealthStreamSequence(NonZeroU64);

impl HealthStreamSequence {
    /// Creates a nonzero health stream sequence.
    ///
    /// # Errors
    ///
    /// Returns [`HealthSequenceError`] for zero.
    pub fn new(value: u64) -> Result<Self, HealthSequenceError> {
        NonZeroU64::new(value).map(Self).ok_or(HealthSequenceError)
    }

    /// Returns the integer sequence value.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

/// Error returned for a zero health stream sequence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HealthSequenceError;

impl fmt::Display for HealthSequenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("health stream sequence must be nonzero")
    }
}

impl std::error::Error for HealthSequenceError {}

/// Plant-local monotonic observation token bound to one runtime generation.
///
/// It is neither FCU, producer, simulation, nor wall time. Its instant is
/// intentionally opaque and can only be minted from the local monotonic clock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlantObservationTime {
    generation: RuntimeGeneration,
    instant: Instant,
}

impl PlantObservationTime {
    /// Captures the current plant-local monotonic instant.
    #[must_use]
    pub fn now(generation: RuntimeGeneration) -> Self {
        Self {
            generation,
            instant: Instant::now(),
        }
    }

    /// Returns the lifecycle generation attached to the observation.
    #[must_use]
    pub const fn generation(self) -> RuntimeGeneration {
        self.generation
    }

    #[cfg(test)]
    pub(crate) const fn at(generation: RuntimeGeneration, instant: Instant) -> Self {
        Self {
            generation,
            instant,
        }
    }
}

/// Explicit position unit carried by an untrusted health report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PositionUnitV1 {
    /// Metres, the sole unit admitted by health contract v1.
    Metres,
    /// Centimetres, represented only so it can be rejected.
    Centimetres,
    /// Feet, represented only so it can be rejected.
    Feet,
}

/// Closed FCU arming observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArmingStateV1 {
    /// FCU reports armed.
    Armed,
    /// FCU reports disarmed.
    Disarmed,
    /// The arming state is unknown.
    Unknown,
}

/// Closed landed-state observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LandedStateV1 {
    /// Vehicle reports on ground.
    OnGround,
    /// Vehicle reports airborne.
    InAir,
    /// Vehicle reports taking off.
    TakingOff,
    /// Vehicle reports landing.
    Landing,
    /// The landed state is unknown.
    Unknown,
}

/// Opaque mode code whose meaning belongs to an approved profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProfileModeCode(u32);

impl ProfileModeCode {
    /// Retains an uninterpreted profile-specific mode code.
    #[must_use]
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    /// Returns the uninterpreted numeric mode code.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Closed FCU mode observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FcuModeStateV1 {
    /// A profile-specific code was reported without interpretation.
    Reported(ProfileModeCode),
    /// The current mode is unknown.
    Unknown,
}

/// Closed FCU failsafe observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FcuFailsafeStateV1 {
    /// FCU reports its failsafe inactive.
    Inactive,
    /// FCU reports its failsafe active.
    Active,
    /// The failsafe state is unknown.
    Unknown,
}

/// Structural validity reported for one estimator output.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EstimateValidityV1 {
    /// Source reports the estimate valid.
    Valid,
    /// Source reports the estimate invalid.
    Invalid,
    /// Validity is unknown.
    Unknown,
}

/// Explicit reason that a measurement is unavailable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MeasurementUnavailableReasonV1 {
    /// The source did not report the measurement.
    NotReported,
    /// The source rejected the measurement.
    RejectedBySource,
    /// The measurement is unavailable during a reset.
    ResetInProgress,
}

/// Local position observation in the report's declared frame and unit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PositionObservationV1 {
    /// A three-axis position is available.
    Available([f64; 3]),
    /// No position value is available.
    Unavailable(MeasurementUnavailableReasonV1),
}

/// Local velocity observation in the report's declared frame and unit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum VelocityObservationV1 {
    /// A three-axis velocity is available.
    Available([f64; 3]),
    /// No velocity value is available.
    Unavailable(MeasurementUnavailableReasonV1),
}

/// Battery remaining-fraction observation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BatteryObservationV1 {
    /// A fraction in the inclusive range zero through one is available.
    Available {
        /// Uninterpreted remaining-energy fraction.
        remaining_fraction: f64,
    },
    /// No battery value is available.
    Unavailable(MeasurementUnavailableReasonV1),
}

/// Closed fence-state observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FenceStateV1 {
    /// Source reports the vehicle inside its fence.
    Inside,
    /// Source reports a fence breach.
    Breached,
    /// Source reports fencing disabled.
    Disabled,
    /// Fence state is unknown.
    Unknown,
}

/// Closed connectivity observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LinkStateV1 {
    /// Source reports the link connected.
    Connected,
    /// Source reports the link disconnected.
    Disconnected,
    /// Link state is unknown.
    Unknown,
}

/// Reported FCU state group.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FcuStateV1 {
    arming: ArmingStateV1,
    landed: LandedStateV1,
    mode: FcuModeStateV1,
    failsafe: FcuFailsafeStateV1,
}

impl FcuStateV1 {
    /// Creates an explicit FCU state group without assigning a safety verdict.
    #[must_use]
    pub const fn new(
        arming: ArmingStateV1,
        landed: LandedStateV1,
        mode: FcuModeStateV1,
        failsafe: FcuFailsafeStateV1,
    ) -> Self {
        Self {
            arming,
            landed,
            mode,
            failsafe,
        }
    }

    /// Returns the arming observation.
    #[must_use]
    pub const fn arming(self) -> ArmingStateV1 {
        self.arming
    }

    /// Returns the landed-state observation.
    #[must_use]
    pub const fn landed(self) -> LandedStateV1 {
        self.landed
    }

    /// Returns the opaque mode observation.
    #[must_use]
    pub const fn mode(self) -> FcuModeStateV1 {
        self.mode
    }

    /// Returns the FCU failsafe observation.
    #[must_use]
    pub const fn failsafe(self) -> FcuFailsafeStateV1 {
        self.failsafe
    }
}

/// Reported estimator-validity group.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EstimatorStateV1 {
    attitude: EstimateValidityV1,
    height: EstimateValidityV1,
    local_position: EstimateValidityV1,
    local_velocity: EstimateValidityV1,
    global_position: EstimateValidityV1,
    home_position: EstimateValidityV1,
}

impl EstimatorStateV1 {
    /// Creates a complete estimator-validity group.
    #[must_use]
    pub const fn new(
        attitude: EstimateValidityV1,
        height: EstimateValidityV1,
        local_position: EstimateValidityV1,
        local_velocity: EstimateValidityV1,
        global_position: EstimateValidityV1,
        home_position: EstimateValidityV1,
    ) -> Self {
        Self {
            attitude,
            height,
            local_position,
            local_velocity,
            global_position,
            home_position,
        }
    }

    /// Returns attitude-estimate validity.
    #[must_use]
    pub const fn attitude(self) -> EstimateValidityV1 {
        self.attitude
    }

    /// Returns height-estimate validity.
    #[must_use]
    pub const fn height(self) -> EstimateValidityV1 {
        self.height
    }

    /// Returns local-position-estimate validity.
    #[must_use]
    pub const fn local_position(self) -> EstimateValidityV1 {
        self.local_position
    }

    /// Returns local-velocity-estimate validity.
    #[must_use]
    pub const fn local_velocity(self) -> EstimateValidityV1 {
        self.local_velocity
    }

    /// Returns global-position-estimate validity.
    #[must_use]
    pub const fn global_position(self) -> EstimateValidityV1 {
        self.global_position
    }

    /// Returns home-position-estimate validity.
    #[must_use]
    pub const fn home_position(self) -> EstimateValidityV1 {
        self.home_position
    }
}

/// Reported FCU link-state group.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FcuLinksV1 {
    plant_to_fcu: LinkStateV1,
    fcu_data_link: LinkStateV1,
    offboard_control: LinkStateV1,
}

impl FcuLinksV1 {
    /// Creates a complete link-state group.
    #[must_use]
    pub const fn new(
        plant_to_fcu: LinkStateV1,
        fcu_data_link: LinkStateV1,
        offboard_control: LinkStateV1,
    ) -> Self {
        Self {
            plant_to_fcu,
            fcu_data_link,
            offboard_control,
        }
    }

    /// Returns the plant-to-FCU link observation.
    #[must_use]
    pub const fn plant_to_fcu(self) -> LinkStateV1 {
        self.plant_to_fcu
    }

    /// Returns the FCU data-link observation.
    #[must_use]
    pub const fn fcu_data_link(self) -> LinkStateV1 {
        self.fcu_data_link
    }

    /// Returns the offboard-control link observation.
    #[must_use]
    pub const fn offboard_control(self) -> LinkStateV1 {
        self.offboard_control
    }
}

/// Fixed group identifier for deterministic observation-time failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HealthObservationGroupV1 {
    /// FCU arming, landed, mode, and failsafe state.
    FcuState,
    /// Estimator validity.
    Estimator,
    /// Local position.
    Position,
    /// Local velocity.
    Velocity,
    /// Battery.
    Battery,
    /// Fence.
    Fence,
    /// Link state.
    Links,
}

/// Plant-local observation times for all health groups.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HealthObservationTimesV1 {
    fcu_state: PlantObservationTime,
    estimator: PlantObservationTime,
    position: PlantObservationTime,
    velocity: PlantObservationTime,
    battery: PlantObservationTime,
    fence: PlantObservationTime,
    links: PlantObservationTime,
}

impl HealthObservationTimesV1 {
    /// Creates a complete set of group observation times.
    #[must_use]
    pub const fn new(
        fcu_state: PlantObservationTime,
        estimator: PlantObservationTime,
        position: PlantObservationTime,
        velocity: PlantObservationTime,
        battery: PlantObservationTime,
        fence: PlantObservationTime,
        links: PlantObservationTime,
    ) -> Self {
        Self {
            fcu_state,
            estimator,
            position,
            velocity,
            battery,
            fence,
            links,
        }
    }

    /// Uses one captured time for every explicitly constructed group.
    #[must_use]
    pub const fn all(observed_at: PlantObservationTime) -> Self {
        Self::new(
            observed_at,
            observed_at,
            observed_at,
            observed_at,
            observed_at,
            observed_at,
            observed_at,
        )
    }

    /// Returns the FCU-state observation time.
    #[must_use]
    pub const fn fcu_state(self) -> PlantObservationTime {
        self.fcu_state
    }

    /// Returns the estimator observation time.
    #[must_use]
    pub const fn estimator(self) -> PlantObservationTime {
        self.estimator
    }

    /// Returns the position observation time.
    #[must_use]
    pub const fn position(self) -> PlantObservationTime {
        self.position
    }

    /// Returns the velocity observation time.
    #[must_use]
    pub const fn velocity(self) -> PlantObservationTime {
        self.velocity
    }

    /// Returns the battery observation time.
    #[must_use]
    pub const fn battery(self) -> PlantObservationTime {
        self.battery
    }

    /// Returns the fence observation time.
    #[must_use]
    pub const fn fence(self) -> PlantObservationTime {
        self.fence
    }

    /// Returns the link-state observation time.
    #[must_use]
    pub const fn links(self) -> PlantObservationTime {
        self.links
    }

    const fn entries(self) -> [(HealthObservationGroupV1, PlantObservationTime); 7] {
        [
            (HealthObservationGroupV1::FcuState, self.fcu_state),
            (HealthObservationGroupV1::Estimator, self.estimator),
            (HealthObservationGroupV1::Position, self.position),
            (HealthObservationGroupV1::Velocity, self.velocity),
            (HealthObservationGroupV1::Battery, self.battery),
            (HealthObservationGroupV1::Fence, self.fence),
            (HealthObservationGroupV1::Links, self.links),
        ]
    }
}

/// Complete declared identity domain carried by a health report.
///
/// These values are structural assertions and are not authentication evidence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthDomainV1 {
    profile: ProfileIdentity,
    vehicle: VehicleIdentity,
    source: FcuHealthSourceIdentity,
    stream_epoch: HealthStreamEpochIdentity,
    runtime_generation: RuntimeGeneration,
    local_frame_instance: LocalFrameInstanceIdentity,
}

impl VehicleHealthDomainV1 {
    /// Creates the declared identity domain for one report or channel.
    #[must_use]
    pub const fn new(
        profile: ProfileIdentity,
        vehicle: VehicleIdentity,
        source: FcuHealthSourceIdentity,
        stream_epoch: HealthStreamEpochIdentity,
        runtime_generation: RuntimeGeneration,
        local_frame_instance: LocalFrameInstanceIdentity,
    ) -> Self {
        Self {
            profile,
            vehicle,
            source,
            stream_epoch,
            runtime_generation,
            local_frame_instance,
        }
    }

    /// Returns the exact candidate-profile identity.
    #[must_use]
    pub const fn profile(self) -> ProfileIdentity {
        self.profile
    }

    /// Returns the vehicle identity.
    #[must_use]
    pub const fn vehicle(self) -> VehicleIdentity {
        self.vehicle
    }

    /// Returns the declared source identity.
    #[must_use]
    pub const fn source(self) -> FcuHealthSourceIdentity {
        self.source
    }

    /// Returns the source-stream epoch.
    #[must_use]
    pub const fn stream_epoch(self) -> HealthStreamEpochIdentity {
        self.stream_epoch
    }

    /// Returns the bound runtime generation.
    #[must_use]
    pub const fn runtime_generation(self) -> RuntimeGeneration {
        self.runtime_generation
    }

    /// Returns the local-frame-instance identity.
    #[must_use]
    pub const fn local_frame_instance(self) -> LocalFrameInstanceIdentity {
        self.local_frame_instance
    }
}

/// Immutable configuration binding one health channel to one declared domain.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthContextV1 {
    profile: CandidateProfileV1,
    domain: VehicleHealthDomainV1,
}

impl VehicleHealthContextV1 {
    /// Binds a new inactive health channel to one exact declared domain.
    #[must_use]
    pub const fn new(
        profile: CandidateProfileV1,
        vehicle: VehicleIdentity,
        source: FcuHealthSourceIdentity,
        stream_epoch: HealthStreamEpochIdentity,
        runtime_generation: RuntimeGeneration,
        local_frame_instance: LocalFrameInstanceIdentity,
    ) -> Self {
        Self {
            profile,
            domain: VehicleHealthDomainV1::new(
                profile.identity(),
                vehicle,
                source,
                stream_epoch,
                runtime_generation,
                local_frame_instance,
            ),
        }
    }

    /// Returns the exact inactive candidate profile.
    #[must_use]
    pub const fn profile(self) -> CandidateProfileV1 {
        self.profile
    }

    /// Returns the complete bound identity domain.
    #[must_use]
    pub const fn domain(self) -> VehicleHealthDomainV1 {
        self.domain
    }
}

/// Version and provenance metadata carried by an untrusted report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthMetadataV1 {
    schema_version: u16,
    domain: VehicleHealthDomainV1,
    stream_sequence: HealthStreamSequence,
}

impl VehicleHealthMetadataV1 {
    /// Creates untrusted metadata without admitting it to a channel.
    #[must_use]
    pub const fn new(
        schema_version: u16,
        domain: VehicleHealthDomainV1,
        stream_sequence: HealthStreamSequence,
    ) -> Self {
        Self {
            schema_version,
            domain,
            stream_sequence,
        }
    }

    /// Returns the submitted schema version.
    #[must_use]
    pub const fn schema_version(self) -> u16 {
        self.schema_version
    }

    /// Returns the submitted identity domain.
    #[must_use]
    pub const fn domain(self) -> VehicleHealthDomainV1 {
        self.domain
    }

    /// Returns the submitted source-stream sequence.
    #[must_use]
    pub const fn stream_sequence(self) -> HealthStreamSequence {
        self.stream_sequence
    }
}

/// Frame and unit labels carried by an untrusted report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthUnitsV1 {
    frame: VelocityFrame,
    position_unit: PositionUnitV1,
    velocity_unit: VelocityUnit,
}

impl VehicleHealthUnitsV1 {
    /// Creates explicit frame and unit labels.
    #[must_use]
    pub const fn new(
        frame: VelocityFrame,
        position_unit: PositionUnitV1,
        velocity_unit: VelocityUnit,
    ) -> Self {
        Self {
            frame,
            position_unit,
            velocity_unit,
        }
    }

    /// Returns the local frame label.
    #[must_use]
    pub const fn frame(self) -> VelocityFrame {
        self.frame
    }

    /// Returns the position unit label.
    #[must_use]
    pub const fn position_unit(self) -> PositionUnitV1 {
        self.position_unit
    }

    /// Returns the velocity unit label.
    #[must_use]
    pub const fn velocity_unit(self) -> VelocityUnit {
        self.velocity_unit
    }
}

/// Complete health-state payload carried by one report or snapshot.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VehicleHealthStateV1 {
    fcu: FcuStateV1,
    estimator: EstimatorStateV1,
    position: PositionObservationV1,
    velocity: VelocityObservationV1,
    battery: BatteryObservationV1,
    fence: FenceStateV1,
    links: FcuLinksV1,
}

impl VehicleHealthStateV1 {
    /// Creates a complete state payload with no implicit defaults.
    #[must_use]
    pub const fn new(
        fcu: FcuStateV1,
        estimator: EstimatorStateV1,
        position: PositionObservationV1,
        velocity: VelocityObservationV1,
        battery: BatteryObservationV1,
        fence: FenceStateV1,
        links: FcuLinksV1,
    ) -> Self {
        Self {
            fcu,
            estimator,
            position,
            velocity,
            battery,
            fence,
            links,
        }
    }

    /// Returns the FCU state group.
    #[must_use]
    pub const fn fcu(self) -> FcuStateV1 {
        self.fcu
    }

    /// Returns the estimator state group.
    #[must_use]
    pub const fn estimator(self) -> EstimatorStateV1 {
        self.estimator
    }

    /// Returns the local position observation.
    #[must_use]
    pub const fn position(self) -> PositionObservationV1 {
        self.position
    }

    /// Returns the local velocity observation.
    #[must_use]
    pub const fn velocity(self) -> VelocityObservationV1 {
        self.velocity
    }

    /// Returns the battery observation.
    #[must_use]
    pub const fn battery(self) -> BatteryObservationV1 {
        self.battery
    }

    /// Returns the fence observation.
    #[must_use]
    pub const fn fence(self) -> FenceStateV1 {
        self.fence
    }

    /// Returns the link-state group.
    #[must_use]
    pub const fn links(self) -> FcuLinksV1 {
        self.links
    }
}

/// Complete untrusted in-memory vehicle-health report.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VehicleHealthReportV1 {
    metadata: VehicleHealthMetadataV1,
    units: VehicleHealthUnitsV1,
    observation_times: HealthObservationTimesV1,
    state: VehicleHealthStateV1,
}

impl VehicleHealthReportV1 {
    /// Creates an untrusted report without authenticating or admitting it.
    #[must_use]
    pub const fn new(
        metadata: VehicleHealthMetadataV1,
        units: VehicleHealthUnitsV1,
        observation_times: HealthObservationTimesV1,
        state: VehicleHealthStateV1,
    ) -> Self {
        Self {
            metadata,
            units,
            observation_times,
            state,
        }
    }

    /// Returns the submitted metadata.
    #[must_use]
    pub const fn metadata(self) -> VehicleHealthMetadataV1 {
        self.metadata
    }

    /// Returns the submitted frame and unit labels.
    #[must_use]
    pub const fn units(self) -> VehicleHealthUnitsV1 {
        self.units
    }

    /// Returns the submitted observation times.
    #[must_use]
    pub const fn observation_times(self) -> HealthObservationTimesV1 {
        self.observation_times
    }

    /// Returns the submitted state payload.
    #[must_use]
    pub const fn state(self) -> VehicleHealthStateV1 {
        self.state
    }
}

/// Axis associated with a rejected numeric observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HealthAxisV1 {
    /// First axis.
    X,
    /// Second axis.
    Y,
    /// Third axis.
    Z,
}

impl HealthAxisV1 {
    const fn from_index(index: usize) -> Self {
        match index {
            0 => Self::X,
            1 => Self::Y,
            _ => Self::Z,
        }
    }
}

/// Numeric vector kind associated with a rejection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HealthVectorKindV1 {
    /// Local position.
    Position,
    /// Local velocity.
    Velocity,
}

/// Deterministic fail-closed health report rejection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VehicleHealthCommitError {
    /// The schema version is not the sole supported version.
    UnsupportedSchema {
        /// Required version.
        expected: u16,
        /// Submitted version.
        received: u16,
    },
    /// Candidate profile identity differs from the channel context.
    ProfileMismatch,
    /// Vehicle identity differs from the channel context.
    VehicleMismatch,
    /// Declared source identity differs from the channel context.
    SourceMismatch,
    /// Source stream epoch differs from the channel context.
    StreamEpochMismatch,
    /// Runtime generation differs from the channel context.
    RuntimeGenerationMismatch,
    /// Local-frame-instance identity differs from the channel context.
    LocalFrameInstanceMismatch,
    /// The last admitted source sequence reached its maximum value.
    SourceSequenceExhausted,
    /// Source sequence was a duplicate or rollback.
    SourceSequenceNotIncreasing {
        /// Last successfully committed source sequence.
        last: HealthStreamSequence,
        /// Rejected sequence.
        received: HealthStreamSequence,
    },
    /// Frame differs from the exact local frame selected by the profile.
    FrameMismatch {
        /// Required local frame.
        expected: VelocityFrame,
        /// Submitted frame.
        received: VelocityFrame,
    },
    /// Position unit is not metres.
    UnsupportedPositionUnit {
        /// Submitted unit.
        received: PositionUnitV1,
    },
    /// Velocity unit is not metres per second.
    UnsupportedVelocityUnit {
        /// Submitted unit.
        received: VelocityUnit,
    },
    /// An observation token belongs to another runtime generation.
    ObservationGenerationMismatch {
        /// Observation group checked in deterministic order.
        group: HealthObservationGroupV1,
    },
    /// An observation token is after the internal plant receipt time.
    ObservationAfterReceipt {
        /// Observation group checked in deterministic order.
        group: HealthObservationGroupV1,
    },
    /// A position or velocity component is NaN or infinite.
    NonFiniteVector {
        /// Rejected vector kind.
        vector: HealthVectorKindV1,
        /// Rejected axis.
        axis: HealthAxisV1,
    },
    /// Available battery fraction is NaN or infinite.
    NonFiniteBattery,
    /// Available battery fraction is outside zero through one inclusive.
    BatteryOutOfRange,
    /// The retained reader was dropped.
    StorageClosed,
    /// The retained register is poisoned.
    StoragePoisoned,
    /// The retained register sequence is exhausted.
    StorageCounterExhausted,
    /// The retained register could not allocate required state.
    StorageAllocationFailed,
    /// The capacity-one register unexpectedly reported full.
    StorageInvariant,
}

impl fmt::Display for VehicleHealthCommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchema { expected, received } => {
                write!(
                    formatter,
                    "health schema {received} is unsupported; expected {expected}"
                )
            }
            Self::ProfileMismatch => formatter.write_str("health profile identity mismatch"),
            Self::VehicleMismatch => formatter.write_str("health vehicle identity mismatch"),
            Self::SourceMismatch => formatter.write_str("health source identity mismatch"),
            Self::StreamEpochMismatch => formatter.write_str("health stream epoch mismatch"),
            Self::RuntimeGenerationMismatch => {
                formatter.write_str("health runtime generation mismatch")
            }
            Self::LocalFrameInstanceMismatch => {
                formatter.write_str("health local-frame-instance mismatch")
            }
            Self::SourceSequenceExhausted => {
                formatter.write_str("health source sequence is exhausted")
            }
            Self::SourceSequenceNotIncreasing { .. } => {
                formatter.write_str("health source sequence is not increasing")
            }
            Self::FrameMismatch { .. } => formatter.write_str("health local frame mismatch"),
            Self::UnsupportedPositionUnit { .. } => {
                formatter.write_str("health position unit is unsupported")
            }
            Self::UnsupportedVelocityUnit { .. } => {
                formatter.write_str("health velocity unit is unsupported")
            }
            Self::ObservationGenerationMismatch { .. } => {
                formatter.write_str("health observation generation mismatch")
            }
            Self::ObservationAfterReceipt { .. } => {
                formatter.write_str("health observation is after plant receipt")
            }
            Self::NonFiniteVector { .. } => {
                formatter.write_str("health vector contains a nonfinite component")
            }
            Self::NonFiniteBattery => formatter.write_str("battery fraction is nonfinite"),
            Self::BatteryOutOfRange => formatter.write_str("battery fraction is outside 0..=1"),
            Self::StorageClosed => formatter.write_str("health snapshot storage is closed"),
            Self::StoragePoisoned => formatter.write_str("health snapshot storage is poisoned"),
            Self::StorageCounterExhausted => {
                formatter.write_str("health snapshot storage sequence is exhausted")
            }
            Self::StorageAllocationFailed => {
                formatter.write_str("health snapshot storage allocation failed")
            }
            Self::StorageInvariant => {
                formatter.write_str("health snapshot storage invariant failed")
            }
        }
    }
}

impl std::error::Error for VehicleHealthCommitError {}

/// Deeply immutable validated vehicle-health snapshot.
///
/// All fields are private. The concrete value contains no user-provided heap
/// container, callback, trait object, synchronization primitive, or interior
/// mutability. It deliberately exposes no healthy, safe, or authorized verdict.
#[derive(Debug)]
pub struct VehicleHealthSnapshotV1 {
    metadata: VehicleHealthMetadataV1,
    units: VehicleHealthUnitsV1,
    observation_times: HealthObservationTimesV1,
    state: VehicleHealthStateV1,
    received_at: Instant,
}

// This positive type proof is transitive: each direct snapshot component can
// implement `Copy` only while every nested field remains a closed value. The
// snapshot itself intentionally stays non-Copy and is retained behind one Arc.
const _: fn() = || {
    fn assert_closed_value<T: Copy + Send + Sync>() {}
    assert_closed_value::<VehicleHealthMetadataV1>();
    assert_closed_value::<VehicleHealthUnitsV1>();
    assert_closed_value::<HealthObservationTimesV1>();
    assert_closed_value::<VehicleHealthStateV1>();
    assert_closed_value::<Instant>();
};

impl VehicleHealthSnapshotV1 {
    /// Returns validated metadata and declared provenance.
    #[must_use]
    pub const fn metadata(&self) -> VehicleHealthMetadataV1 {
        self.metadata
    }

    /// Returns validated frame and SI unit labels.
    #[must_use]
    pub const fn units(&self) -> VehicleHealthUnitsV1 {
        self.units
    }

    /// Returns the coherent plant-local observation times.
    #[must_use]
    pub const fn observation_times(&self) -> HealthObservationTimesV1 {
        self.observation_times
    }

    /// Returns the complete validated state payload.
    #[must_use]
    pub const fn state(&self) -> VehicleHealthStateV1 {
        self.state
    }
}

/// Receipt from a successfully committed health report.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthCommitReceiptV1 {
    register_sequence: u64,
    source_sequence: HealthStreamSequence,
    runtime_generation: RuntimeGeneration,
}

impl VehicleHealthCommitReceiptV1 {
    /// Returns the exact retained-register commit sequence.
    #[must_use]
    pub const fn register_sequence(self) -> u64 {
        self.register_sequence
    }

    /// Returns the exact admitted source sequence.
    #[must_use]
    pub const fn source_sequence(self) -> HealthStreamSequence {
        self.source_sequence
    }

    /// Returns the runtime generation bound to the commit.
    #[must_use]
    pub const fn runtime_generation(self) -> RuntimeGeneration {
        self.runtime_generation
    }
}

/// Single-writer publishing endpoint for validated vehicle health.
///
/// This type intentionally does not implement [`Clone`]. Each commit requires
/// mutable access so one source high-water mark serializes the channel.
///
/// ```compile_fail
/// use crebain_plant_authority::VehicleHealthPublisherV1;
///
/// fn duplicate_writer(publisher: VehicleHealthPublisherV1) {
///     let _duplicate = publisher.clone();
/// }
/// ```
#[derive(Debug)]
pub struct VehicleHealthPublisherV1 {
    context: VehicleHealthContextV1,
    sender: SnapshotSender<VehicleHealthSnapshotV1>,
    last_source_sequence: Option<HealthStreamSequence>,
}

impl VehicleHealthPublisherV1 {
    #[cfg(test)]
    pub(crate) fn poison_for_test(&self) {
        self.sender.poison_for_test();
    }

    /// Validates and atomically commits one complete report.
    ///
    /// The structural source identity is compared but not authenticated. Failed
    /// validation or storage admission never advances the source high-water mark.
    ///
    /// # Errors
    ///
    /// Returns [`VehicleHealthCommitError`] in a deterministic validation order
    /// for schema, provenance, sequence, frame/unit, time, numeric, or storage
    /// failure.
    pub fn commit(
        &mut self,
        report: &VehicleHealthReportV1,
    ) -> Result<VehicleHealthCommitReceiptV1, VehicleHealthCommitError> {
        self.commit_at(report, Instant::now())
    }

    #[cfg(test)]
    pub(crate) fn commit_for_test_at(
        &mut self,
        report: &VehicleHealthReportV1,
        received_at: Instant,
    ) -> Result<VehicleHealthCommitReceiptV1, VehicleHealthCommitError> {
        self.commit_at(report, received_at)
    }

    fn commit_at(
        &mut self,
        report: &VehicleHealthReportV1,
        received_at: Instant,
    ) -> Result<VehicleHealthCommitReceiptV1, VehicleHealthCommitError> {
        self.validate_identity_and_sequence(report)?;
        self.validate_frame_units_and_time(report, received_at)?;
        let state = canonicalize_state(report.state)?;
        let source_sequence = report.metadata.stream_sequence;
        let generation = self.context.domain.runtime_generation;
        let snapshot = VehicleHealthSnapshotV1 {
            metadata: report.metadata,
            units: report.units,
            observation_times: report.observation_times,
            state,
            received_at,
        };
        let register_sequence =
            self.sender
                .commit(generation, snapshot)
                .map_err(|error| match error {
                    ChannelError::Closed(_) => VehicleHealthCommitError::StorageClosed,
                    ChannelError::Poisoned(_) => VehicleHealthCommitError::StoragePoisoned,
                    ChannelError::CounterExhausted(_) => {
                        VehicleHealthCommitError::StorageCounterExhausted
                    }
                    ChannelError::AllocationFailed(_) => {
                        VehicleHealthCommitError::StorageAllocationFailed
                    }
                    ChannelError::Full(_) => VehicleHealthCommitError::StorageInvariant,
                })?;
        self.last_source_sequence = Some(source_sequence);
        Ok(VehicleHealthCommitReceiptV1 {
            register_sequence,
            source_sequence,
            runtime_generation: generation,
        })
    }

    fn validate_identity_and_sequence(
        &self,
        report: &VehicleHealthReportV1,
    ) -> Result<(), VehicleHealthCommitError> {
        if report.metadata.schema_version != VEHICLE_HEALTH_SCHEMA_V1 {
            return Err(VehicleHealthCommitError::UnsupportedSchema {
                expected: VEHICLE_HEALTH_SCHEMA_V1,
                received: report.metadata.schema_version,
            });
        }
        let expected = self.context.domain;
        let received = report.metadata.domain;
        if received.profile != expected.profile {
            return Err(VehicleHealthCommitError::ProfileMismatch);
        }
        if received.vehicle != expected.vehicle {
            return Err(VehicleHealthCommitError::VehicleMismatch);
        }
        if received.source != expected.source {
            return Err(VehicleHealthCommitError::SourceMismatch);
        }
        if received.stream_epoch != expected.stream_epoch {
            return Err(VehicleHealthCommitError::StreamEpochMismatch);
        }
        if received.runtime_generation != expected.runtime_generation {
            return Err(VehicleHealthCommitError::RuntimeGenerationMismatch);
        }
        if received.local_frame_instance != expected.local_frame_instance {
            return Err(VehicleHealthCommitError::LocalFrameInstanceMismatch);
        }
        if let Some(last) = self.last_source_sequence {
            if last.get() == u64::MAX {
                return Err(VehicleHealthCommitError::SourceSequenceExhausted);
            }
            if report.metadata.stream_sequence <= last {
                return Err(VehicleHealthCommitError::SourceSequenceNotIncreasing {
                    last,
                    received: report.metadata.stream_sequence,
                });
            }
        }
        Ok(())
    }

    fn validate_frame_units_and_time(
        &self,
        report: &VehicleHealthReportV1,
        received_at: Instant,
    ) -> Result<(), VehicleHealthCommitError> {
        let expected_frame = self.context.profile.velocity_frame();
        if report.units.frame != expected_frame {
            return Err(VehicleHealthCommitError::FrameMismatch {
                expected: expected_frame,
                received: report.units.frame,
            });
        }
        if report.units.position_unit != PositionUnitV1::Metres {
            return Err(VehicleHealthCommitError::UnsupportedPositionUnit {
                received: report.units.position_unit,
            });
        }
        if report.units.velocity_unit != VelocityUnit::MetresPerSecond {
            return Err(VehicleHealthCommitError::UnsupportedVelocityUnit {
                received: report.units.velocity_unit,
            });
        }
        let generation = self.context.domain.runtime_generation;
        for (group, observation) in report.observation_times.entries() {
            if observation.generation != generation {
                return Err(VehicleHealthCommitError::ObservationGenerationMismatch { group });
            }
        }
        for (group, observation) in report.observation_times.entries() {
            if observation.instant > received_at {
                return Err(VehicleHealthCommitError::ObservationAfterReceipt { group });
            }
        }
        Ok(())
    }
}

fn canonicalize_state(
    state: VehicleHealthStateV1,
) -> Result<VehicleHealthStateV1, VehicleHealthCommitError> {
    let position = match state.position {
        PositionObservationV1::Available(components) => PositionObservationV1::Available(
            validate_and_canonicalize_vector(components, HealthVectorKindV1::Position)?,
        ),
        PositionObservationV1::Unavailable(reason) => PositionObservationV1::Unavailable(reason),
    };
    let velocity = match state.velocity {
        VelocityObservationV1::Available(components) => VelocityObservationV1::Available(
            validate_and_canonicalize_vector(components, HealthVectorKindV1::Velocity)?,
        ),
        VelocityObservationV1::Unavailable(reason) => VelocityObservationV1::Unavailable(reason),
    };
    let battery = match state.battery {
        BatteryObservationV1::Available { remaining_fraction } => {
            if !remaining_fraction.is_finite() {
                return Err(VehicleHealthCommitError::NonFiniteBattery);
            }
            if !(0.0..=1.0).contains(&remaining_fraction) {
                return Err(VehicleHealthCommitError::BatteryOutOfRange);
            }
            BatteryObservationV1::Available {
                remaining_fraction: canonical_zero(remaining_fraction),
            }
        }
        BatteryObservationV1::Unavailable(reason) => BatteryObservationV1::Unavailable(reason),
    };
    Ok(VehicleHealthStateV1 {
        fcu: state.fcu,
        estimator: state.estimator,
        position,
        velocity,
        battery,
        fence: state.fence,
        links: state.links,
    })
}

fn validate_and_canonicalize_vector(
    mut components: [f64; 3],
    vector: HealthVectorKindV1,
) -> Result<[f64; 3], VehicleHealthCommitError> {
    for (index, component) in components.iter_mut().enumerate() {
        if !component.is_finite() {
            return Err(VehicleHealthCommitError::NonFiniteVector {
                vector,
                axis: HealthAxisV1::from_index(index),
            });
        }
        *component = canonical_zero(*component);
    }
    Ok(components)
}

fn canonical_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

/// Exact plant-monotonic ages computed from one reader instant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VehicleHealthAgesV1 {
    receipt: Duration,
    fcu_state: Duration,
    estimator: Duration,
    position: Duration,
    velocity: Duration,
    battery: Duration,
    fence: Duration,
    links: Duration,
}

impl VehicleHealthAgesV1 {
    /// Returns age since local receipt was stamped and validation began.
    #[must_use]
    pub const fn receipt(self) -> Duration {
        self.receipt
    }

    /// Returns FCU-state observation age.
    #[must_use]
    pub const fn fcu_state(self) -> Duration {
        self.fcu_state
    }

    /// Returns estimator observation age.
    #[must_use]
    pub const fn estimator(self) -> Duration {
        self.estimator
    }

    /// Returns position observation age.
    #[must_use]
    pub const fn position(self) -> Duration {
        self.position
    }

    /// Returns velocity observation age.
    #[must_use]
    pub const fn velocity(self) -> Duration {
        self.velocity
    }

    /// Returns battery observation age.
    #[must_use]
    pub const fn battery(self) -> Duration {
        self.battery
    }

    /// Returns fence observation age.
    #[must_use]
    pub const fn fence(self) -> Duration {
        self.fence
    }

    /// Returns link-state observation age.
    #[must_use]
    pub const fn links(self) -> Duration {
        self.links
    }
}

/// One immutable retained commit paired with exact observation ages.
#[derive(Debug)]
pub struct ObservedVehicleHealthV1 {
    commit: SnapshotCommit<VehicleHealthSnapshotV1>,
    ages: VehicleHealthAgesV1,
}

impl ObservedVehicleHealthV1 {
    /// Returns the deeply immutable validated snapshot.
    #[must_use]
    pub fn snapshot(&self) -> &VehicleHealthSnapshotV1 {
        self.commit.value()
    }

    /// Returns the exact retained-register sequence.
    #[must_use]
    pub const fn register_sequence(&self) -> u64 {
        self.commit.sequence()
    }

    /// Returns all ages computed from one monotonic read instant.
    #[must_use]
    pub const fn ages(&self) -> VehicleHealthAgesV1 {
        self.ages
    }
}

/// Time point associated with a clock-regression read failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VehicleHealthTimePointV1 {
    /// Internal report receipt.
    Receipt,
    /// One observation group.
    Observation(HealthObservationGroupV1),
}

/// Fail-closed retained health read error.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VehicleHealthReadError {
    /// The retained register is poisoned.
    StoragePoisoned,
    /// No report has been committed.
    NoSnapshot,
    /// The retained snapshot belongs to another lifecycle generation.
    RuntimeGenerationMismatch {
        /// Generation required by the reader caller.
        expected: RuntimeGeneration,
        /// Generation stored with the retained commit.
        received: RuntimeGeneration,
    },
    /// The monotonic clock appears earlier than a stored time.
    ClockRegression {
        /// Stored time that was later than the read instant.
        point: VehicleHealthTimePointV1,
    },
}

impl fmt::Display for VehicleHealthReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StoragePoisoned => formatter.write_str("health snapshot storage is poisoned"),
            Self::NoSnapshot => formatter.write_str("no vehicle-health snapshot is retained"),
            Self::RuntimeGenerationMismatch { expected, received } => write!(
                formatter,
                "vehicle-health generation {} does not match current generation {}",
                received.get(),
                expected.get()
            ),
            Self::ClockRegression { point } => {
                write!(
                    formatter,
                    "plant monotonic clock regressed before {point:?}"
                )
            }
        }
    }
}

impl std::error::Error for VehicleHealthReadError {}

/// Checked non-consuming reader for retained vehicle health.
///
/// The raw retained-register reader cannot be recovered through conversion:
///
/// ```compile_fail
/// use crebain_plant_authority::{
///     SnapshotReceiver, VehicleHealthReaderV1, VehicleHealthSnapshotV1,
/// };
///
/// fn bypass_checked_load(reader: VehicleHealthReaderV1) {
///     let _: SnapshotReceiver<VehicleHealthSnapshotV1> = reader.into();
/// }
/// ```
#[derive(Debug)]
pub struct VehicleHealthReaderV1 {
    receiver: SnapshotReceiver<VehicleHealthSnapshotV1>,
}

impl VehicleHealthReaderV1 {
    /// Loads one coherent snapshot and computes exact ages.
    ///
    /// No age is classified as fresh. A future apply-time governor must compare
    /// these values with an approved profile immediately before every write.
    ///
    /// # Errors
    ///
    /// Returns [`VehicleHealthReadError`] for poisoned or empty storage,
    /// lifecycle-generation mismatch, or monotonic-clock regression.
    pub fn load(
        &self,
        current_generation: RuntimeGeneration,
    ) -> Result<ObservedVehicleHealthV1, VehicleHealthReadError> {
        let commit = self.load_commit(current_generation)?;
        observe_commit(commit, Instant::now())
    }

    /// Loads one coherent snapshot, then mints the private apply-observation
    /// instant used to compute every returned age.
    ///
    /// Loading before timestamp capture prevents a concurrently published
    /// snapshot from carrying a receipt time later than the observation
    /// reference merely because it won the retained-register lock after an
    /// earlier timestamp was captured. The raw instant remains crate-private.
    pub(crate) fn load_for_apply_observation(
        &self,
        current_generation: RuntimeGeneration,
    ) -> Result<(ObservedVehicleHealthV1, Instant), VehicleHealthReadError> {
        let commit = self.load_commit(current_generation)?;
        let observed_at = Instant::now();
        let observed = observe_commit(commit, observed_at)?;
        Ok((observed, observed_at))
    }

    #[cfg(test)]
    pub(crate) fn load_at(
        &self,
        current_generation: RuntimeGeneration,
        now: Instant,
    ) -> Result<ObservedVehicleHealthV1, VehicleHealthReadError> {
        let commit = self.load_commit(current_generation)?;
        observe_commit(commit, now)
    }

    fn load_commit(
        &self,
        current_generation: RuntimeGeneration,
    ) -> Result<SnapshotCommit<VehicleHealthSnapshotV1>, VehicleHealthReadError> {
        let commit = self
            .receiver
            .load()
            .map_err(|ChannelReadError::Poisoned| VehicleHealthReadError::StoragePoisoned)?
            .ok_or(VehicleHealthReadError::NoSnapshot)?;
        if commit.generation() != current_generation {
            return Err(VehicleHealthReadError::RuntimeGenerationMismatch {
                expected: current_generation,
                received: commit.generation(),
            });
        }
        Ok(commit)
    }
}

fn observe_commit(
    commit: SnapshotCommit<VehicleHealthSnapshotV1>,
    now: Instant,
) -> Result<ObservedVehicleHealthV1, VehicleHealthReadError> {
    let snapshot = commit.value();
    let receipt = checked_age(now, snapshot.received_at, VehicleHealthTimePointV1::Receipt)?;
    let times = snapshot.observation_times;
    let fcu_state =
        checked_observation_age(now, times.fcu_state, HealthObservationGroupV1::FcuState)?;
    let estimator =
        checked_observation_age(now, times.estimator, HealthObservationGroupV1::Estimator)?;
    let position =
        checked_observation_age(now, times.position, HealthObservationGroupV1::Position)?;
    let velocity =
        checked_observation_age(now, times.velocity, HealthObservationGroupV1::Velocity)?;
    let battery = checked_observation_age(now, times.battery, HealthObservationGroupV1::Battery)?;
    let fence = checked_observation_age(now, times.fence, HealthObservationGroupV1::Fence)?;
    let links = checked_observation_age(now, times.links, HealthObservationGroupV1::Links)?;
    Ok(ObservedVehicleHealthV1 {
        commit,
        ages: VehicleHealthAgesV1 {
            receipt,
            fcu_state,
            estimator,
            position,
            velocity,
            battery,
            fence,
            links,
        },
    })
}

fn checked_observation_age(
    now: Instant,
    observation: PlantObservationTime,
    group: HealthObservationGroupV1,
) -> Result<Duration, VehicleHealthReadError> {
    checked_age(
        now,
        observation.instant,
        VehicleHealthTimePointV1::Observation(group),
    )
}

fn checked_age(
    now: Instant,
    earlier: Instant,
    point: VehicleHealthTimePointV1,
) -> Result<Duration, VehicleHealthReadError> {
    now.checked_duration_since(earlier)
        .ok_or(VehicleHealthReadError::ClockRegression { point })
}

/// Creates one empty, context-bound vehicle-health retained channel.
///
/// The returned publisher is the sole non-cloneable writer. The reader can be
/// shared by reference (for example behind [`std::sync::Arc`]) without exposing
/// the raw retained-register endpoints.
#[must_use]
pub fn vehicle_health_channel(
    context: VehicleHealthContextV1,
) -> (VehicleHealthPublisherV1, VehicleHealthReaderV1) {
    let (sender, receiver) = snapshot_value();
    (
        VehicleHealthPublisherV1 {
            context,
            sender,
            last_source_sequence: None,
        },
        VehicleHealthReaderV1 { receiver },
    )
}

/// Sealed canonical health path retained by [`crate::KernelChannels`].
///
/// The typed endpoints stay paired and cannot be replaced independently with
/// endpoints created for another profile, vehicle, source, epoch, generation,
/// or frame instance.
#[derive(Debug)]
pub(crate) struct VehicleHealthChannelV1 {
    publisher: VehicleHealthPublisherV1,
    reader: VehicleHealthReaderV1,
}

impl VehicleHealthChannelV1 {
    pub(crate) fn commit(
        &mut self,
        report: &VehicleHealthReportV1,
    ) -> Result<VehicleHealthCommitReceiptV1, VehicleHealthCommitError> {
        self.publisher.commit(report)
    }

    pub(crate) fn load(
        &self,
        current_generation: RuntimeGeneration,
    ) -> Result<ObservedVehicleHealthV1, VehicleHealthReadError> {
        self.reader.load(current_generation)
    }
}

pub(crate) fn vehicle_health_channel_set(
    context: VehicleHealthContextV1,
) -> VehicleHealthChannelV1 {
    let (publisher, reader) = vehicle_health_channel(context);
    VehicleHealthChannelV1 { publisher, reader }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU64;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Barrier};

    use super::*;
    use crate::{CandidateProfileKind, ProfileIdentity};

    fn generation(value: u64) -> RuntimeGeneration {
        RuntimeGeneration::new(NonZeroU64::new(value).expect("test generation is nonzero"))
    }

    fn profile(kind: CandidateProfileKind, digest: u8) -> CandidateProfileV1 {
        CandidateProfileV1::from_identity(
            ProfileIdentity::new(kind, [digest; 32]).expect("test profile digest is nonzero"),
        )
    }

    fn context(runtime_generation: RuntimeGeneration) -> VehicleHealthContextV1 {
        VehicleHealthContextV1::new(
            profile(CandidateProfileKind::DraftL1SitlLocalNed, 1),
            VehicleIdentity::new([2; 16]).expect("test vehicle identity is nonzero"),
            FcuHealthSourceIdentity::new([3; 32]).expect("test source identity is nonzero"),
            HealthStreamEpochIdentity::new([4; 16]).expect("test stream epoch is nonzero"),
            runtime_generation,
            LocalFrameInstanceIdentity::new([5; 16]).expect("test frame instance is nonzero"),
        )
    }

    fn nominal_state(marker: f64) -> VehicleHealthStateV1 {
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
            PositionObservationV1::Available([marker, marker, marker]),
            VelocityObservationV1::Available([-marker, -marker, -marker]),
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

    fn unavailable_state(reason: MeasurementUnavailableReasonV1) -> VehicleHealthStateV1 {
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
            PositionObservationV1::Unavailable(reason),
            VelocityObservationV1::Unavailable(reason),
            BatteryObservationV1::Unavailable(reason),
            FenceStateV1::Unknown,
            FcuLinksV1::new(
                LinkStateV1::Unknown,
                LinkStateV1::Unknown,
                LinkStateV1::Unknown,
            ),
        )
    }

    fn report_at(
        health_context: VehicleHealthContextV1,
        sequence: u64,
        observation_times: HealthObservationTimesV1,
        state: VehicleHealthStateV1,
    ) -> VehicleHealthReportV1 {
        VehicleHealthReportV1::new(
            VehicleHealthMetadataV1::new(
                VEHICLE_HEALTH_SCHEMA_V1,
                health_context.domain(),
                HealthStreamSequence::new(sequence).expect("test sequence is nonzero"),
            ),
            VehicleHealthUnitsV1::new(
                health_context.profile().velocity_frame(),
                PositionUnitV1::Metres,
                VelocityUnit::MetresPerSecond,
            ),
            observation_times,
            state,
        )
    }

    fn report_now(
        health_context: VehicleHealthContextV1,
        sequence: u64,
        state: VehicleHealthStateV1,
    ) -> VehicleHealthReportV1 {
        let observed_at = PlantObservationTime::now(health_context.domain().runtime_generation());
        report_at(
            health_context,
            sequence,
            HealthObservationTimesV1::all(observed_at),
            state,
        )
    }

    fn exact_test_marker(value: u64) -> f64 {
        f64::from(u32::try_from(value).expect("small test sequence fits u32 exactly"))
    }

    fn run_coherent_health_reader(
        reader: &VehicleHealthReaderV1,
        runtime_generation: RuntimeGeneration,
        stop: &AtomicBool,
        observations: &AtomicUsize,
        first_replacement_tx: &mpsc::Sender<()>,
        second_replacement_tx: &mpsc::Sender<()>,
        start: &Barrier,
    ) {
        start.wait();
        let mut reported_first_replacement = false;
        let mut reported_second_replacement = false;
        loop {
            let observed = reader
                .load(runtime_generation)
                .expect("health storage should remain coherent");
            let source_sequence = observed.snapshot().metadata().stream_sequence().get();
            let marker = exact_test_marker(source_sequence);
            assert_eq!(
                observed.snapshot().state().position(),
                PositionObservationV1::Available([marker, marker, marker])
            );
            assert_eq!(
                observed.snapshot().state().velocity(),
                VelocityObservationV1::Available([-marker, -marker, -marker])
            );
            observations.fetch_add(1, Ordering::Relaxed);
            if source_sequence >= 2 && !reported_first_replacement {
                reported_first_replacement = true;
                if first_replacement_tx.send(()).is_err() {
                    return;
                }
            }
            if source_sequence >= 3 && !reported_second_replacement {
                reported_second_replacement = true;
                if second_replacement_tx.send(()).is_err() {
                    return;
                }
            }
            if stop.load(Ordering::Acquire) {
                break;
            }
        }
    }

    #[test]
    fn health_identity_and_sequence_types_should_reject_every_zero_value() {
        assert_eq!(
            VehicleIdentity::new([0; 16]).map_err(HealthIdentityError::kind),
            Err(HealthIdentityKind::Vehicle)
        );
        assert_eq!(
            FcuHealthSourceIdentity::new([0; 32]).map_err(HealthIdentityError::kind),
            Err(HealthIdentityKind::Source)
        );
        assert_eq!(
            HealthStreamEpochIdentity::new([0; 16]).map_err(HealthIdentityError::kind),
            Err(HealthIdentityKind::StreamEpoch)
        );
        assert_eq!(
            LocalFrameInstanceIdentity::new([0; 16]).map_err(HealthIdentityError::kind),
            Err(HealthIdentityKind::LocalFrameInstance)
        );
        assert_eq!(HealthStreamSequence::new(0), Err(HealthSequenceError));
    }

    #[test]
    fn typed_health_snapshot_v1_should_commit_coherent_immutable_state() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let base = Instant::now();
        let observed = |millis| {
            PlantObservationTime::at(
                runtime_generation,
                base.checked_sub(Duration::from_millis(millis))
                    .expect("test instant has enough range"),
            )
        };
        let times = HealthObservationTimesV1::new(
            observed(10),
            observed(20),
            observed(30),
            observed(40),
            observed(50),
            observed(60),
            observed(70),
        );
        let state = VehicleHealthStateV1::new(
            FcuStateV1::new(
                ArmingStateV1::Disarmed,
                LandedStateV1::InAir,
                FcuModeStateV1::Reported(ProfileModeCode::new(7)),
                FcuFailsafeStateV1::Active,
            ),
            nominal_state(1.0).estimator(),
            PositionObservationV1::Available([-0.0, 2.0, 3.0]),
            VelocityObservationV1::Available([4.0, -0.0, 6.0]),
            BatteryObservationV1::Available {
                remaining_fraction: -0.0,
            },
            FenceStateV1::Breached,
            FcuLinksV1::new(
                LinkStateV1::Disconnected,
                LinkStateV1::Unknown,
                LinkStateV1::Connected,
            ),
        );
        let report = report_at(health_context, 9, times, state);
        let (mut publisher, reader) = vehicle_health_channel(health_context);

        let receipt = publisher
            .commit_at(&report, base)
            .expect("valid health report should commit");
        let observed = reader
            .load_at(runtime_generation, base + Duration::from_millis(100))
            .expect("committed health should load");
        let snapshot = observed.snapshot();

        assert_eq!(receipt.register_sequence(), 1);
        assert_eq!(receipt.source_sequence().get(), 9);
        assert_eq!(snapshot.metadata(), report.metadata());
        assert_eq!(snapshot.units(), report.units());
        assert_eq!(snapshot.state().fcu(), state.fcu());
        assert_eq!(snapshot.state().estimator(), state.estimator());
        assert_eq!(snapshot.state().fence(), FenceStateV1::Breached);
        assert_eq!(snapshot.state().links(), state.links());
        let PositionObservationV1::Available(position) = snapshot.state().position() else {
            panic!("validated position should remain available");
        };
        let VelocityObservationV1::Available(velocity) = snapshot.state().velocity() else {
            panic!("validated velocity should remain available");
        };
        let BatteryObservationV1::Available { remaining_fraction } = snapshot.state().battery()
        else {
            panic!("validated battery should remain available");
        };
        assert_eq!(position[0].to_bits(), 0.0_f64.to_bits());
        assert_eq!(velocity[1].to_bits(), 0.0_f64.to_bits());
        assert_eq!(remaining_fraction.to_bits(), 0.0_f64.to_bits());
        assert_eq!(observed.ages().receipt(), Duration::from_millis(100));
        assert_eq!(observed.ages().fcu_state(), Duration::from_millis(110));
        assert_eq!(observed.ages().estimator(), Duration::from_millis(120));
        assert_eq!(observed.ages().position(), Duration::from_millis(130));
        assert_eq!(observed.ages().velocity(), Duration::from_millis(140));
        assert_eq!(observed.ages().battery(), Duration::from_millis(150));
        assert_eq!(observed.ages().fence(), Duration::from_millis(160));
        assert_eq!(observed.ages().links(), Duration::from_millis(170));
    }

    #[test]
    fn health_admission_should_reject_identity_mismatches_in_fixed_order() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let now = Instant::now();
        let times =
            HealthObservationTimesV1::all(PlantObservationTime::at(runtime_generation, now));
        let mut report = report_at(health_context, 1, times, nominal_state(1.0));
        let (mut publisher, _reader) = vehicle_health_channel(health_context);
        let expected = health_context.domain();

        report.metadata.schema_version = 2;
        report.metadata.domain.profile =
            profile(CandidateProfileKind::DraftL1SitlLocalEnu, 9).identity();
        assert!(matches!(
            publisher.commit_at(&report, now),
            Err(VehicleHealthCommitError::UnsupportedSchema { .. })
        ));
        report.metadata.schema_version = VEHICLE_HEALTH_SCHEMA_V1;
        assert_eq!(
            publisher.commit_at(&report, now),
            Err(VehicleHealthCommitError::ProfileMismatch)
        );
        report.metadata.domain.profile = expected.profile;
        report.metadata.domain.vehicle =
            VehicleIdentity::new([9; 16]).expect("alternate vehicle is nonzero");
        assert_eq!(
            publisher.commit_at(&report, now),
            Err(VehicleHealthCommitError::VehicleMismatch)
        );
        report.metadata.domain.vehicle = expected.vehicle;
        report.metadata.domain.source =
            FcuHealthSourceIdentity::new([9; 32]).expect("alternate source is nonzero");
        assert_eq!(
            publisher.commit_at(&report, now),
            Err(VehicleHealthCommitError::SourceMismatch)
        );
        report.metadata.domain.source = expected.source;
        report.metadata.domain.stream_epoch =
            HealthStreamEpochIdentity::new([9; 16]).expect("alternate epoch is nonzero");
        assert_eq!(
            publisher.commit_at(&report, now),
            Err(VehicleHealthCommitError::StreamEpochMismatch)
        );
        report.metadata.domain.stream_epoch = expected.stream_epoch;
        report.metadata.domain.runtime_generation = generation(2);
        assert_eq!(
            publisher.commit_at(&report, now),
            Err(VehicleHealthCommitError::RuntimeGenerationMismatch)
        );
        report.metadata.domain.runtime_generation = expected.runtime_generation;
        report.metadata.domain.local_frame_instance =
            LocalFrameInstanceIdentity::new([9; 16]).expect("alternate frame instance is nonzero");
        assert_eq!(
            publisher.commit_at(&report, now),
            Err(VehicleHealthCommitError::LocalFrameInstanceMismatch)
        );

        report.metadata.domain = expected;
        publisher
            .commit_at(&report, now)
            .expect("restored report should commit");
        let mut wrong_source_and_rollback = report;
        wrong_source_and_rollback.metadata.domain.source =
            FcuHealthSourceIdentity::new([8; 32]).expect("alternate source is nonzero");
        assert_eq!(
            publisher.commit_at(&wrong_source_and_rollback, now),
            Err(VehicleHealthCommitError::SourceMismatch)
        );
        let mut wrong_frame_and_duplicate = report;
        wrong_frame_and_duplicate.units.frame = VelocityFrame::LocalEnu;
        assert!(matches!(
            publisher.commit_at(&wrong_frame_and_duplicate, now),
            Err(VehicleHealthCommitError::SourceSequenceNotIncreasing { .. })
        ));
    }

    #[test]
    fn health_admission_should_reject_frames_and_units_even_when_values_are_unavailable() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let now = Instant::now();
        let times =
            HealthObservationTimesV1::all(PlantObservationTime::at(runtime_generation, now));
        let base = report_at(
            health_context,
            1,
            times,
            unavailable_state(MeasurementUnavailableReasonV1::NotReported),
        );
        let (mut publisher, _reader) = vehicle_health_channel(health_context);

        for frame in [
            VelocityFrame::LocalEnu,
            VelocityFrame::BodyFrd,
            VelocityFrame::BodyFlu,
        ] {
            let mut report = base;
            report.units.frame = frame;
            assert!(matches!(
                publisher.commit_at(&report, now),
                Err(VehicleHealthCommitError::FrameMismatch { received, .. }) if received == frame
            ));
        }
        for unit in [PositionUnitV1::Centimetres, PositionUnitV1::Feet] {
            let mut report = base;
            report.units.position_unit = unit;
            assert_eq!(
                publisher.commit_at(&report, now),
                Err(VehicleHealthCommitError::UnsupportedPositionUnit { received: unit })
            );
        }
        for unit in [
            VelocityUnit::CentimetresPerSecond,
            VelocityUnit::FeetPerSecond,
        ] {
            let mut report = base;
            report.units.velocity_unit = unit;
            assert_eq!(
                publisher.commit_at(&report, now),
                Err(VehicleHealthCommitError::UnsupportedVelocityUnit { received: unit })
            );
        }

        let domain = health_context.domain();
        let enu_context = VehicleHealthContextV1::new(
            profile(CandidateProfileKind::DraftL1SitlLocalEnu, 8),
            domain.vehicle(),
            domain.source(),
            domain.stream_epoch(),
            runtime_generation,
            domain.local_frame_instance(),
        );
        let mut enu_report = report_at(
            enu_context,
            1,
            times,
            unavailable_state(MeasurementUnavailableReasonV1::NotReported),
        );
        let (mut enu_publisher, _reader) = vehicle_health_channel(enu_context);
        enu_publisher
            .commit_at(&enu_report, now)
            .expect("ENU profile should admit only its exact ENU frame");
        enu_report.metadata.stream_sequence =
            HealthStreamSequence::new(2).expect("test sequence is nonzero");
        enu_report.units.frame = VelocityFrame::LocalNed;
        assert!(matches!(
            enu_publisher.commit_at(&enu_report, now),
            Err(VehicleHealthCommitError::FrameMismatch {
                expected: VelocityFrame::LocalEnu,
                received: VelocityFrame::LocalNed,
            })
        ));
    }

    #[test]
    fn health_source_sequence_should_accept_gaps_and_fail_closed_on_rollback_or_exhaustion() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let first = report_now(health_context, 10, nominal_state(10.0));
        let gap = report_now(health_context, 12, nominal_state(12.0));
        let duplicate = report_now(health_context, 12, nominal_state(12.0));
        let rollback = report_now(health_context, 11, nominal_state(11.0));
        let (mut publisher, _reader) = vehicle_health_channel(health_context);

        publisher
            .commit(&first)
            .expect("first sequence should commit");
        publisher.commit(&gap).expect("sequence gap should commit");
        assert!(matches!(
            publisher.commit(&duplicate),
            Err(VehicleHealthCommitError::SourceSequenceNotIncreasing { .. })
        ));
        assert!(matches!(
            publisher.commit(&rollback),
            Err(VehicleHealthCommitError::SourceSequenceNotIncreasing { .. })
        ));

        let (mut maximum_publisher, _reader) = vehicle_health_channel(health_context);
        let maximum = report_now(health_context, u64::MAX, nominal_state(1.0));
        maximum_publisher
            .commit(&maximum)
            .expect("maximum sequence should commit once");
        assert_eq!(
            maximum_publisher.commit(&maximum),
            Err(VehicleHealthCommitError::SourceSequenceExhausted)
        );
    }

    #[test]
    fn rejected_validation_and_storage_should_not_consume_source_sequence() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let mut invalid = report_now(health_context, 1, nominal_state(1.0));
        invalid.units.frame = VelocityFrame::LocalEnu;
        let valid = report_now(health_context, 1, nominal_state(1.0));
        let (mut publisher, reader) = vehicle_health_channel(health_context);

        assert!(matches!(
            publisher.commit(&invalid),
            Err(VehicleHealthCommitError::FrameMismatch { .. })
        ));
        publisher.sender.set_receiver_open_for_test(false);
        assert_eq!(
            publisher.commit(&valid),
            Err(VehicleHealthCommitError::StorageClosed)
        );
        publisher.sender.set_receiver_open_for_test(true);
        let receipt = publisher
            .commit(&valid)
            .expect("same source sequence should remain available after failures");
        assert_eq!(receipt.source_sequence().get(), 1);
        assert_eq!(
            reader
                .load(runtime_generation)
                .expect("committed snapshot should load")
                .snapshot()
                .metadata()
                .stream_sequence()
                .get(),
            1
        );
    }

    #[test]
    fn storage_counter_exhaustion_should_preserve_snapshot_and_source_high_water() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let first = report_now(health_context, 1, nominal_state(1.0));
        let second = report_now(health_context, 2, nominal_state(2.0));
        let (mut publisher, reader) = vehicle_health_channel(health_context);
        publisher
            .commit(&first)
            .expect("first report should commit");
        publisher.sender.set_sequence_for_test(u64::MAX);

        assert_eq!(
            publisher.commit(&second),
            Err(VehicleHealthCommitError::StorageCounterExhausted)
        );
        assert_eq!(
            reader
                .load(runtime_generation)
                .expect("prior snapshot should remain")
                .snapshot()
                .metadata()
                .stream_sequence()
                .get(),
            1
        );
        publisher.sender.set_sequence_for_test(1);
        publisher
            .commit(&second)
            .expect("failed storage commit must not consume source sequence two");
    }

    #[test]
    fn poisoned_health_storage_should_fail_closed_for_publish_and_read() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let report = report_now(health_context, 1, nominal_state(1.0));
        let (mut publisher, reader) = vehicle_health_channel(health_context);
        publisher.sender.poison_for_test();

        assert_eq!(
            publisher.commit(&report),
            Err(VehicleHealthCommitError::StoragePoisoned)
        );
        assert_eq!(
            reader
                .load(runtime_generation)
                .expect_err("poisoned health read must fail"),
            VehicleHealthReadError::StoragePoisoned
        );
    }

    #[test]
    fn observation_times_should_be_generation_bound_and_not_after_receipt() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let receipt = Instant::now();
        let wrong_generation = PlantObservationTime::at(generation(2), receipt);
        let correct = PlantObservationTime::at(runtime_generation, receipt);
        let mut report = report_at(
            health_context,
            1,
            HealthObservationTimesV1::all(wrong_generation),
            nominal_state(1.0),
        );
        let (mut publisher, _reader) = vehicle_health_channel(health_context);
        assert_eq!(
            publisher.commit_at(&report, receipt),
            Err(VehicleHealthCommitError::ObservationGenerationMismatch {
                group: HealthObservationGroupV1::FcuState,
            })
        );

        report.observation_times = HealthObservationTimesV1::new(
            correct,
            wrong_generation,
            wrong_generation,
            wrong_generation,
            wrong_generation,
            wrong_generation,
            wrong_generation,
        );
        assert_eq!(
            publisher.commit_at(&report, receipt),
            Err(VehicleHealthCommitError::ObservationGenerationMismatch {
                group: HealthObservationGroupV1::Estimator,
            })
        );

        let future =
            PlantObservationTime::at(runtime_generation, receipt + Duration::from_nanos(1));
        report.observation_times = HealthObservationTimesV1::all(future);
        assert_eq!(
            publisher.commit_at(&report, receipt),
            Err(VehicleHealthCommitError::ObservationAfterReceipt {
                group: HealthObservationGroupV1::FcuState,
            })
        );

        report.observation_times = HealthObservationTimesV1::all(correct);
        publisher
            .commit_at(&report, receipt)
            .expect("observation exactly at receipt should commit");
    }

    #[test]
    fn every_nonfinite_vector_component_and_invalid_battery_should_be_rejected() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let now = Instant::now();
        let times =
            HealthObservationTimesV1::all(PlantObservationTime::at(runtime_generation, now));
        let (mut publisher, _reader) = vehicle_health_channel(health_context);
        let bad_values = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY];
        for vector in [HealthVectorKindV1::Position, HealthVectorKindV1::Velocity] {
            for axis_index in 0..3 {
                for value in bad_values {
                    let mut state = nominal_state(1.0);
                    let mut components = [1.0, 2.0, 3.0];
                    components[axis_index] = value;
                    match vector {
                        HealthVectorKindV1::Position => {
                            state.position = PositionObservationV1::Available(components);
                        }
                        HealthVectorKindV1::Velocity => {
                            state.velocity = VelocityObservationV1::Available(components);
                        }
                    }
                    let report = report_at(health_context, 1, times, state);
                    assert_eq!(
                        publisher.commit_at(&report, now),
                        Err(VehicleHealthCommitError::NonFiniteVector {
                            vector,
                            axis: HealthAxisV1::from_index(axis_index),
                        })
                    );
                }
            }
        }

        for value in bad_values {
            let mut state = nominal_state(1.0);
            state.battery = BatteryObservationV1::Available {
                remaining_fraction: value,
            };
            let report = report_at(health_context, 1, times, state);
            assert_eq!(
                publisher.commit_at(&report, now),
                Err(VehicleHealthCommitError::NonFiniteBattery)
            );
        }
        for value in [-f64::MIN_POSITIVE, 1.0 + f64::EPSILON] {
            let mut state = nominal_state(1.0);
            state.battery = BatteryObservationV1::Available {
                remaining_fraction: value,
            };
            let report = report_at(health_context, 1, times, state);
            assert_eq!(
                publisher.commit_at(&report, now),
                Err(VehicleHealthCommitError::BatteryOutOfRange)
            );
        }
    }

    #[test]
    fn structural_validation_should_accept_large_finite_and_contradictory_observations() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let mut state = nominal_state(1.0);
        state.fcu = FcuStateV1::new(
            ArmingStateV1::Disarmed,
            LandedStateV1::InAir,
            FcuModeStateV1::Unknown,
            FcuFailsafeStateV1::Active,
        );
        state.position = PositionObservationV1::Available([f64::MAX, -f64::MAX, 0.0]);
        state.velocity = VelocityObservationV1::Available([f64::MAX, -f64::MAX, -0.0]);
        state.battery = BatteryObservationV1::Available {
            remaining_fraction: 1.0,
        };
        let report = report_now(health_context, 1, state);
        let (mut publisher, reader) = vehicle_health_channel(health_context);

        publisher
            .commit(&report)
            .expect("policy-free structural validation should retain finite contradictions");
        let retained = reader
            .load(runtime_generation)
            .expect("retained contradiction should load")
            .snapshot()
            .state();
        assert_eq!(retained.fcu(), state.fcu());
        assert_eq!(retained.position(), state.position());
    }

    #[test]
    fn unknown_and_every_unavailable_reason_should_replace_prior_nominal_state() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let (mut publisher, reader) = vehicle_health_channel(health_context);
        publisher
            .commit(&report_now(health_context, 1, nominal_state(1.0)))
            .expect("nominal report should commit");

        for (index, reason) in [
            MeasurementUnavailableReasonV1::NotReported,
            MeasurementUnavailableReasonV1::RejectedBySource,
            MeasurementUnavailableReasonV1::ResetInProgress,
        ]
        .into_iter()
        .enumerate()
        {
            let sequence = u64::try_from(index).expect("small index fits u64") + 2;
            let state = unavailable_state(reason);
            publisher
                .commit(&report_now(health_context, sequence, state))
                .expect("explicit unavailable state should replace prior state");
            let retained = reader
                .load(runtime_generation)
                .expect("replacement should load")
                .snapshot()
                .state();
            assert_eq!(retained, state);
        }
    }

    #[test]
    fn health_reader_should_fail_closed_on_missing_generation_and_clock_regression() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let receipt = Instant::now();
        let old_observation = receipt
            .checked_sub(Duration::from_secs(86_400))
            .expect("test instant has one day of range");
        let report = report_at(
            health_context,
            1,
            HealthObservationTimesV1::all(PlantObservationTime::at(
                runtime_generation,
                old_observation,
            )),
            nominal_state(1.0),
        );
        let (mut publisher, reader) = vehicle_health_channel(health_context);
        assert_eq!(
            reader
                .load(runtime_generation)
                .expect_err("empty health read must fail"),
            VehicleHealthReadError::NoSnapshot
        );
        publisher
            .commit_at(&report, receipt)
            .expect("old but structurally valid report should commit");
        assert_eq!(
            reader
                .load_at(generation(2), receipt)
                .expect_err("rotated generation must fail"),
            VehicleHealthReadError::RuntimeGenerationMismatch {
                expected: generation(2),
                received: runtime_generation,
            }
        );
        assert_eq!(
            reader
                .load_at(
                    runtime_generation,
                    receipt
                        .checked_sub(Duration::from_nanos(1))
                        .expect("test instant has one nanosecond of range"),
                )
                .expect_err("clock regression must fail"),
            VehicleHealthReadError::ClockRegression {
                point: VehicleHealthTimePointV1::Receipt,
            }
        );
        assert_eq!(
            reader
                .load_at(runtime_generation, receipt)
                .expect("old report should expose age without freshness classification")
                .ages()
                .position(),
            Duration::from_secs(86_400)
        );
        assert_eq!(
            reader
                .load_at(runtime_generation, receipt + Duration::from_secs(5))
                .expect("repeated loads should not refresh observation time")
                .ages()
                .position(),
            Duration::from_secs(86_405)
        );
    }

    #[test]
    fn previously_loaded_snapshot_should_remain_unchanged_after_replacement() {
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let (mut publisher, reader) = vehicle_health_channel(health_context);
        publisher
            .commit(&report_now(health_context, 1, nominal_state(1.0)))
            .expect("first report should commit");
        let first = reader
            .load(runtime_generation)
            .expect("first snapshot should load");
        publisher
            .commit(&report_now(health_context, 2, nominal_state(2.0)))
            .expect("replacement should commit");
        let second = reader
            .load(runtime_generation)
            .expect("replacement should load");

        assert_eq!(first.snapshot().metadata().stream_sequence().get(), 1);
        assert_eq!(second.snapshot().metadata().stream_sequence().get(), 2);
        assert_eq!(first.register_sequence(), 1);
        assert_eq!(second.register_sequence(), 2);
    }

    #[test]
    fn typed_health_channel_should_never_expose_torn_concurrent_state() {
        const READERS: usize = 4;
        const COMMITS: u64 = 1_000;
        const READER_PHASE_TIMEOUT: Duration = Duration::from_secs(5);
        let runtime_generation = generation(1);
        let health_context = context(runtime_generation);
        let (mut publisher, reader) = vehicle_health_channel(health_context);
        publisher
            .commit(&report_now(health_context, 1, nominal_state(1.0)))
            .expect("initial report should commit");
        let reader = Arc::new(reader);
        let stop = Arc::new(AtomicBool::new(false));
        let observations = Arc::new(AtomicUsize::new(0));
        let (first_replacement_tx, first_replacement_rx) = mpsc::channel();
        let (second_replacement_tx, second_replacement_rx) = mpsc::channel();
        let start = Arc::new(Barrier::new(READERS + 1));
        let handles: Vec<_> = (0..READERS)
            .map(|_| {
                let reader = Arc::clone(&reader);
                let stop = Arc::clone(&stop);
                let observations = Arc::clone(&observations);
                let first_replacement_tx = first_replacement_tx.clone();
                let second_replacement_tx = second_replacement_tx.clone();
                let start = Arc::clone(&start);
                std::thread::spawn(move || {
                    run_coherent_health_reader(
                        reader.as_ref(),
                        runtime_generation,
                        stop.as_ref(),
                        observations.as_ref(),
                        &first_replacement_tx,
                        &second_replacement_tx,
                        start.as_ref(),
                    );
                })
            })
            .collect();
        drop(first_replacement_tx);
        drop(second_replacement_tx);

        start.wait();
        publisher
            .commit(&report_now(health_context, 2, nominal_state(2.0)))
            .expect("second report should begin concurrent replacement");
        for _ in 0..READERS {
            if let Err(error) = first_replacement_rx.recv_timeout(READER_PHASE_TIMEOUT) {
                stop.store(true, Ordering::Release);
                for handle in handles {
                    let _ = handle.join();
                }
                panic!("readers did not verify the first replacement: {error}");
            }
        }
        publisher
            .commit(&report_now(health_context, 3, nominal_state(3.0)))
            .expect("third report should establish the replacement campaign");
        for _ in 0..READERS {
            if let Err(error) = second_replacement_rx.recv_timeout(READER_PHASE_TIMEOUT) {
                stop.store(true, Ordering::Release);
                for handle in handles {
                    let _ = handle.join();
                }
                panic!("readers did not verify the second replacement: {error}");
            }
        }
        for sequence in 4..=COMMITS {
            publisher
                .commit(&report_now(
                    health_context,
                    sequence,
                    nominal_state(exact_test_marker(sequence)),
                ))
                .expect("single writer should commit increasing sequence");
        }
        stop.store(true, Ordering::Release);
        for handle in handles {
            handle.join().expect("health reader should not panic");
        }
        assert!(observations.load(Ordering::Relaxed) >= READERS * 2);
        assert_eq!(
            reader
                .load(runtime_generation)
                .expect("final snapshot should load")
                .snapshot()
                .metadata()
                .stream_sequence()
                .get(),
            COMMITS
        );
    }

    #[test]
    fn health_contract_v1_should_fail_closed_across_validation_and_reachable_storage_classes() {
        health_identity_and_sequence_types_should_reject_every_zero_value();
        health_admission_should_reject_identity_mismatches_in_fixed_order();
        health_admission_should_reject_frames_and_units_even_when_values_are_unavailable();
        health_source_sequence_should_accept_gaps_and_fail_closed_on_rollback_or_exhaustion();
        rejected_validation_and_storage_should_not_consume_source_sequence();
        storage_counter_exhaustion_should_preserve_snapshot_and_source_high_water();
        poisoned_health_storage_should_fail_closed_for_publish_and_read();
        observation_times_should_be_generation_bound_and_not_after_receipt();
        every_nonfinite_vector_component_and_invalid_battery_should_be_rejected();
        structural_validation_should_accept_large_finite_and_contradictory_observations();
        unknown_and_every_unavailable_reason_should_replace_prior_nominal_state();
    }

    #[test]
    fn validated_snapshot_should_be_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<VehicleHealthSnapshotV1>();
    }
}
