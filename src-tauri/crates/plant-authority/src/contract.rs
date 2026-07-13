//! Inactive, versioned semantic contract for future plant command admission.
//!
//! The types in this module make the draft L1 instantaneous velocity limits explicit while
//! keeping the plant package inert. They perform no serialization, transport,
//! scheduling, state transition, or adapter call. The profile is a candidate
//! until its operational-design-domain limits and canonical local frame are
//! approved together.

use std::fmt;
use std::num::NonZeroU64;
use std::time::{Duration, Instant};

use crate::RuntimeGeneration;

/// Wire-independent numeric identifier for the first plant contract.
pub const PLANT_CONTRACT_V1: u16 = 1;

/// Draft L1 maximum horizontal velocity magnitude in metres per second.
///
/// This is a candidate constraint, not a measured or approved capability.
pub const DRAFT_L1_MAX_HORIZONTAL_SPEED_MPS: f64 = 5.0;

/// Draft L1 maximum absolute vertical velocity in metres per second.
///
/// This is a candidate constraint, not a measured or approved capability.
pub const DRAFT_L1_MAX_VERTICAL_SPEED_MPS: f64 = 2.0;

/// Draft L1 maximum requested command lifetime.
///
/// This bounds admission data only. It is not an active watchdog or evidence
/// that a future adapter checks age immediately before a write.
pub const DRAFT_L1_MAX_COMMAND_TTL: Duration = Duration::from_millis(150);

/// Kind of fixed-width identifier rejected as an unset all-zero value.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentifierKind {
    /// Candidate profile identity.
    Profile,
    /// Authenticated command-session identity.
    Session,
    /// Producer clock-epoch identity.
    ProducerEpoch,
}

/// Error returned when a fixed-width identity is structurally invalid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IdentifierError {
    kind: IdentifierKind,
}

impl IdentifierError {
    /// Returns the kind of identifier that was rejected.
    #[must_use]
    pub const fn kind(self) -> IdentifierKind {
        self.kind
    }
}

impl fmt::Display for IdentifierError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?} identity must not be all zero", self.kind)
    }
}

impl std::error::Error for IdentifierError {}

/// Compound identity of one reviewed plant profile artifact and its semantics.
///
/// The closed profile kind is part of equality, so the same artifact digest
/// cannot identify both ENU and NED interpretations.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ProfileIdentity {
    kind: CandidateProfileKind,
    artifact_digest: [u8; 32],
}

impl ProfileIdentity {
    /// Creates an identity from closed profile semantics and a nonzero digest.
    ///
    /// # Errors
    ///
    /// Returns [`IdentifierError`] when every byte is zero.
    pub fn new(
        kind: CandidateProfileKind,
        artifact_digest: [u8; 32],
    ) -> Result<Self, IdentifierError> {
        if artifact_digest.iter().all(|byte| *byte == 0) {
            return Err(IdentifierError {
                kind: IdentifierKind::Profile,
            });
        }
        Ok(Self {
            kind,
            artifact_digest,
        })
    }

    /// Returns the closed semantic profile kind.
    #[must_use]
    pub const fn kind(self) -> CandidateProfileKind {
        self.kind
    }

    /// Returns the exact reviewed-artifact digest bytes.
    #[must_use]
    pub const fn artifact_digest(&self) -> &[u8; 32] {
        &self.artifact_digest
    }
}

/// Identity of one authenticated command session.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct CommandSessionIdentity([u8; 16]);

impl CommandSessionIdentity {
    /// Creates a session identity from a nonzero 128-bit value.
    ///
    /// # Errors
    ///
    /// Returns [`IdentifierError`] when every byte is zero.
    pub fn new(bytes: [u8; 16]) -> Result<Self, IdentifierError> {
        if bytes.iter().all(|byte| *byte == 0) {
            return Err(IdentifierError {
                kind: IdentifierKind::Session,
            });
        }
        Ok(Self(bytes))
    }

    /// Returns the exact session identity bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// Identity of the producer-local clock epoch used for correlation only.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ProducerEpochIdentity([u8; 16]);

impl ProducerEpochIdentity {
    /// Creates a producer epoch identity from a nonzero 128-bit value.
    ///
    /// # Errors
    ///
    /// Returns [`IdentifierError`] when every byte is zero.
    pub fn new(bytes: [u8; 16]) -> Result<Self, IdentifierError> {
        if bytes.iter().all(|byte| *byte == 0) {
            return Err(IdentifierError {
                kind: IdentifierKind::ProducerEpoch,
            });
        }
        Ok(Self(bytes))
    }

    /// Returns the exact producer epoch identity bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// Producer-local timestamp retained for correlation and replay evidence.
///
/// This value cannot be converted into [`PlantReceiptTime`]. A future plant
/// must calculate command age only from its own monotonic clock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProducerTime {
    epoch: ProducerEpochIdentity,
    offset: Duration,
}

impl ProducerTime {
    /// Creates a timestamp within one explicit producer epoch.
    #[must_use]
    pub const fn new(epoch: ProducerEpochIdentity, offset: Duration) -> Self {
        Self { epoch, offset }
    }

    /// Returns the producer clock epoch.
    #[must_use]
    pub const fn epoch(self) -> ProducerEpochIdentity {
        self.epoch
    }

    /// Returns the duration since the producer epoch.
    #[must_use]
    pub const fn offset(self) -> Duration {
        self.offset
    }
}

/// Plant-local monotonic receipt timestamp.
///
/// The wrapped instant is intentionally opaque. It is distinct from producer
/// time and is the only time domain from which later expiry code may derive
/// local command age.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlantReceiptTime(Instant);

/// Exact monotonic sequence within one authenticated command session.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CommandStreamSequence(NonZeroU64);

impl CommandStreamSequence {
    /// Creates a nonzero stream sequence.
    ///
    /// # Errors
    ///
    /// Returns [`SequenceError`] when `value` is zero.
    pub fn new(value: u64) -> Result<Self, SequenceError> {
        NonZeroU64::new(value).map(Self).ok_or(SequenceError)
    }

    /// Returns the integer sequence value.
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

/// Error returned for an invalid command stream sequence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SequenceError;

impl fmt::Display for SequenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("command stream sequence must be nonzero")
    }
}

impl std::error::Error for SequenceError {}

/// Candidate plant profile kind.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum CandidateProfileKind {
    /// Draft single-quadrotor PX4 SITL L1 profile using local NED velocity.
    DraftL1SitlLocalNed,
    /// Draft single-quadrotor PX4 SITL L1 profile using local ENU velocity.
    DraftL1SitlLocalEnu,
}

impl CandidateProfileKind {
    /// Returns the local frame inseparably bound to this profile kind.
    #[must_use]
    pub const fn velocity_frame(self) -> VelocityFrame {
        match self {
            Self::DraftL1SitlLocalNed => VelocityFrame::LocalNed,
            Self::DraftL1SitlLocalEnu => VelocityFrame::LocalEnu,
        }
    }
}

/// Explicit linear-velocity reference frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VelocityFrame {
    /// Local North-East-Down frame.
    LocalNed,
    /// Local East-North-Up frame.
    LocalEnu,
    /// Body-forward-right-down frame.
    BodyFrd,
    /// Body-forward-left-up frame.
    BodyFlu,
}

/// Explicit unit carried by an untrusted velocity proposal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VelocityUnit {
    /// Metres per second, the sole unit accepted by contract v1.
    MetresPerSecond,
    /// Centimetres per second, represented only so it can be rejected.
    CentimetresPerSecond,
    /// Feet per second, represented only so it can be rejected.
    FeetPerSecond,
}

/// Inactive candidate profile for contract-v1 structural validation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CandidateProfileV1 {
    identity: ProfileIdentity,
}

impl CandidateProfileV1 {
    /// Selects the draft L1 SITL profile bound by its compound identity.
    ///
    /// The identity includes the closed ENU/NED semantic kind plus the reviewed
    /// artifact digest. Selecting it does not approve or activate the profile.
    #[must_use]
    pub const fn from_identity(identity: ProfileIdentity) -> Self {
        Self { identity }
    }

    /// Returns the candidate profile kind.
    #[must_use]
    pub const fn kind(self) -> CandidateProfileKind {
        self.identity.kind()
    }

    /// Returns the identity of the reviewed profile artifact.
    #[must_use]
    pub const fn identity(self) -> ProfileIdentity {
        self.identity
    }

    /// Returns the exact local velocity frame selected for this profile.
    #[must_use]
    pub const fn velocity_frame(self) -> VelocityFrame {
        self.kind().velocity_frame()
    }

    /// Validates an untrusted proposal into an inactive velocity candidate.
    ///
    /// Validation is deterministic and fail-closed. It binds the accepted data
    /// to the current lifecycle generation and a plant-local receipt timestamp,
    /// but it does not compare stream sequences, authorize the sender, schedule
    /// expiry, or cause any lifecycle transition or physical action.
    ///
    /// # Errors
    ///
    /// Returns [`ContractRejection`] for a version, profile, session, action,
    /// lifetime, frame, unit, numeric, or draft speed-limit mismatch.
    pub fn validate_velocity_candidate(
        self,
        proposal: &CommandProposalV1,
        expected_session: CommandSessionIdentity,
        generation: RuntimeGeneration,
    ) -> Result<VelocityCommandCandidateV1, ContractRejection> {
        let received_at = PlantReceiptTime(Instant::now());
        let metadata = proposal.metadata;
        if metadata.contract_version != PLANT_CONTRACT_V1 {
            return Err(ContractRejection::UnsupportedVersion {
                expected: PLANT_CONTRACT_V1,
                received: metadata.contract_version,
            });
        }
        if metadata.profile != self.identity {
            return Err(ContractRejection::ProfileMismatch);
        }
        if metadata.session != expected_session {
            return Err(ContractRejection::SessionMismatch);
        }

        let ProposedActionV1::Velocity(raw_velocity) = proposal.action else {
            return Err(ContractRejection::UnsupportedAction {
                action: proposal.action.kind(),
            });
        };

        if metadata.requested_ttl.is_zero() {
            return Err(ContractRejection::ZeroTtl);
        }
        if metadata.requested_ttl > DRAFT_L1_MAX_COMMAND_TTL {
            return Err(ContractRejection::TtlExceedsDraftLimit {
                maximum: DRAFT_L1_MAX_COMMAND_TTL,
                received: metadata.requested_ttl,
            });
        }
        if raw_velocity.frame != self.velocity_frame() {
            return Err(ContractRejection::FrameMismatch {
                expected: self.velocity_frame(),
                received: raw_velocity.frame,
            });
        }
        if raw_velocity.unit != VelocityUnit::MetresPerSecond {
            return Err(ContractRejection::UnsupportedVelocityUnit {
                received: raw_velocity.unit,
            });
        }

        for (index, component) in raw_velocity.components.iter().enumerate() {
            if !component.is_finite() {
                return Err(ContractRejection::NonFiniteVelocity {
                    axis: Axis::from_index(index),
                });
            }
        }

        let horizontal_squared = raw_velocity.components[0].mul_add(
            raw_velocity.components[0],
            raw_velocity.components[1] * raw_velocity.components[1],
        );
        let maximum_horizontal_squared =
            DRAFT_L1_MAX_HORIZONTAL_SPEED_MPS * DRAFT_L1_MAX_HORIZONTAL_SPEED_MPS;
        if !horizontal_squared.is_finite() || horizontal_squared > maximum_horizontal_squared {
            return Err(ContractRejection::HorizontalSpeedExceedsDraftLimit);
        }
        if raw_velocity.components[2].abs() > DRAFT_L1_MAX_VERTICAL_SPEED_MPS {
            return Err(ContractRejection::VerticalSpeedExceedsDraftLimit);
        }

        Ok(VelocityCommandCandidateV1 {
            contract_version: ContractVersion::V1,
            profile: self,
            session: metadata.session,
            stream_sequence: metadata.stream_sequence,
            producer_time: metadata.producer_time,
            requested_ttl: RequestedCommandTtl(metadata.requested_ttl),
            generation,
            received_at,
            velocity: FramedVelocityMetresPerSecond {
                frame: self.velocity_frame(),
                components: raw_velocity.components,
            },
        })
    }
}

/// Version stored by a validated command candidate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractVersion {
    /// Plant contract version 1.
    V1,
}

/// Command metadata that is untrusted until validated against a local profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CommandMetadataV1 {
    contract_version: u16,
    profile: ProfileIdentity,
    session: CommandSessionIdentity,
    stream_sequence: CommandStreamSequence,
    producer_time: ProducerTime,
    requested_ttl: Duration,
}

impl CommandMetadataV1 {
    /// Creates untrusted command metadata without granting authority.
    #[must_use]
    pub const fn new(
        contract_version: u16,
        profile: ProfileIdentity,
        session: CommandSessionIdentity,
        stream_sequence: CommandStreamSequence,
        producer_time: ProducerTime,
        requested_ttl: Duration,
    ) -> Self {
        Self {
            contract_version,
            profile,
            session,
            stream_sequence,
            producer_time,
            requested_ttl,
        }
    }
}

/// Unvalidated velocity vector with explicit frame and unit labels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RawVelocityV1 {
    frame: VelocityFrame,
    unit: VelocityUnit,
    components: [f64; 3],
}

impl RawVelocityV1 {
    /// Creates an unvalidated vector. Nonfinite values remain representable so
    /// the contract validator can reject them explicitly.
    #[must_use]
    pub const fn new(frame: VelocityFrame, unit: VelocityUnit, components: [f64; 3]) -> Self {
        Self {
            frame,
            unit,
            components,
        }
    }
}

/// Action kind presented to the candidate contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposedActionKind {
    /// Linear velocity proposal.
    Velocity,
    /// Generic protocol hold request.
    Hold,
    /// Land request.
    Land,
    /// Return-to-launch request.
    ReturnToLaunch,
    /// Arm request.
    Arm,
    /// Disarm request.
    Disarm,
    /// Takeoff request.
    Takeoff,
    /// Mission operation.
    Mission,
    /// Arbitrary mode change.
    ModeChange,
    /// Raw motor command.
    RawMotor,
}

/// Untrusted proposed action.
///
/// Contract v1 accepts only [`Self::Velocity`]. Hold, Land, and RTL are
/// reserved for a future state-dependent plant safe-action selector; the other
/// operations are outside the draft L1 command set.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ProposedActionV1 {
    /// Proposed linear velocity.
    Velocity(RawVelocityV1),
    /// Generic protocol hold request.
    Hold,
    /// Land request.
    Land,
    /// Return-to-launch request.
    ReturnToLaunch,
    /// Arm request.
    Arm,
    /// Disarm request.
    Disarm,
    /// Takeoff request.
    Takeoff,
    /// Mission operation.
    Mission,
    /// Arbitrary mode change.
    ModeChange,
    /// Raw motor command.
    RawMotor,
}

impl ProposedActionV1 {
    /// Returns the action discriminator without interpreting its payload.
    #[must_use]
    pub const fn kind(self) -> ProposedActionKind {
        match self {
            Self::Velocity(_) => ProposedActionKind::Velocity,
            Self::Hold => ProposedActionKind::Hold,
            Self::Land => ProposedActionKind::Land,
            Self::ReturnToLaunch => ProposedActionKind::ReturnToLaunch,
            Self::Arm => ProposedActionKind::Arm,
            Self::Disarm => ProposedActionKind::Disarm,
            Self::Takeoff => ProposedActionKind::Takeoff,
            Self::Mission => ProposedActionKind::Mission,
            Self::ModeChange => ProposedActionKind::ModeChange,
            Self::RawMotor => ProposedActionKind::RawMotor,
        }
    }
}

/// Complete untrusted command proposal for contract-v1 validation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CommandProposalV1 {
    metadata: CommandMetadataV1,
    action: ProposedActionV1,
}

impl CommandProposalV1 {
    /// Creates an untrusted proposal without granting authority.
    #[must_use]
    pub const fn new(metadata: CommandMetadataV1, action: ProposedActionV1) -> Self {
        Self { metadata, action }
    }
}

/// Axis of a rejected nonfinite velocity component.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Axis {
    /// First component of the declared frame.
    X,
    /// Second component of the declared frame.
    Y,
    /// Third component of the declared frame.
    Z,
}

impl Axis {
    const fn from_index(index: usize) -> Self {
        match index {
            0 => Self::X,
            1 => Self::Y,
            _ => Self::Z,
        }
    }
}

/// Stable fail-closed reason for rejecting a command proposal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContractRejection {
    /// Contract version is not the sole supported version.
    UnsupportedVersion {
        /// Required version.
        expected: u16,
        /// Rejected version.
        received: u16,
    },
    /// Proposal profile identity does not match the selected local profile.
    ProfileMismatch,
    /// Proposal session identity does not match the authenticated local session.
    SessionMismatch,
    /// Action is not admitted through the general velocity-command path.
    UnsupportedAction {
        /// Rejected action.
        action: ProposedActionKind,
    },
    /// Requested lifetime was zero.
    ZeroTtl,
    /// Requested lifetime exceeded the draft L1 bound.
    TtlExceedsDraftLimit {
        /// Maximum draft lifetime.
        maximum: Duration,
        /// Rejected lifetime.
        received: Duration,
    },
    /// Vector frame did not match the exact frame selected by the profile.
    FrameMismatch {
        /// Required frame.
        expected: VelocityFrame,
        /// Rejected frame.
        received: VelocityFrame,
    },
    /// Vector used a unit other than metres per second.
    UnsupportedVelocityUnit {
        /// Rejected unit.
        received: VelocityUnit,
    },
    /// Vector contained a NaN or infinity.
    NonFiniteVelocity {
        /// Component containing the invalid value.
        axis: Axis,
    },
    /// Horizontal magnitude exceeded the draft L1 bound.
    HorizontalSpeedExceedsDraftLimit,
    /// Absolute vertical value exceeded the draft L1 bound.
    VerticalSpeedExceedsDraftLimit,
}

impl fmt::Display for ContractRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion { expected, received } => write!(
                formatter,
                "unsupported plant contract version {received}; expected {expected}"
            ),
            Self::ProfileMismatch => formatter.write_str("command profile identity mismatch"),
            Self::SessionMismatch => formatter.write_str("command session identity mismatch"),
            Self::UnsupportedAction { action } => {
                write!(
                    formatter,
                    "action {action:?} is not admitted by contract v1"
                )
            }
            Self::ZeroTtl => formatter.write_str("requested command lifetime must be nonzero"),
            Self::TtlExceedsDraftLimit { maximum, received } => write!(
                formatter,
                "requested command lifetime {received:?} exceeds draft maximum {maximum:?}"
            ),
            Self::FrameMismatch { expected, received } => write!(
                formatter,
                "velocity frame {received:?} does not match profile frame {expected:?}"
            ),
            Self::UnsupportedVelocityUnit { received } => write!(
                formatter,
                "velocity unit {received:?} is not metres per second"
            ),
            Self::NonFiniteVelocity { axis } => {
                write!(formatter, "velocity component {axis:?} is not finite")
            }
            Self::HorizontalSpeedExceedsDraftLimit => {
                formatter.write_str("horizontal speed exceeds draft L1 limit")
            }
            Self::VerticalSpeedExceedsDraftLimit => {
                formatter.write_str("vertical speed exceeds draft L1 limit")
            }
        }
    }
}

impl std::error::Error for ContractRejection {}

/// Validated draft command lifetime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RequestedCommandTtl(Duration);

impl RequestedCommandTtl {
    /// Returns the structurally validated requested lifetime.
    #[must_use]
    pub const fn get(self) -> Duration {
        self.0
    }
}

/// Finite velocity in metres per second within the draft instantaneous speed limits.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FramedVelocityMetresPerSecond {
    frame: VelocityFrame,
    components: [f64; 3],
}

impl FramedVelocityMetresPerSecond {
    /// Returns the local frame retained with the validated vector.
    #[must_use]
    pub const fn frame(self) -> VelocityFrame {
        self.frame
    }

    /// Returns the components in the candidate profile's declared local frame.
    #[must_use]
    pub const fn components(self) -> [f64; 3] {
        self.components
    }
}

/// Structurally validated but inactive command candidate.
///
/// Possession of this value proves only contract-v1 structural validation. It
/// does not prove authentication, anti-replay admission, fresh vehicle health,
/// authorization, watchdog arming, apply-time validation, or adapter success.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VelocityCommandCandidateV1 {
    contract_version: ContractVersion,
    profile: CandidateProfileV1,
    session: CommandSessionIdentity,
    stream_sequence: CommandStreamSequence,
    producer_time: ProducerTime,
    requested_ttl: RequestedCommandTtl,
    generation: RuntimeGeneration,
    received_at: PlantReceiptTime,
    velocity: FramedVelocityMetresPerSecond,
}

impl VelocityCommandCandidateV1 {
    /// Returns the validated contract version.
    #[must_use]
    pub const fn contract_version(self) -> ContractVersion {
        self.contract_version
    }

    /// Returns the candidate profile used for validation.
    #[must_use]
    pub const fn profile(self) -> CandidateProfileV1 {
        self.profile
    }

    /// Returns the authenticated session identity expected by the validator.
    #[must_use]
    pub const fn session(self) -> CommandSessionIdentity {
        self.session
    }

    /// Returns the proposal stream sequence.
    ///
    /// Contract validation does not compare this value with retained state.
    #[must_use]
    pub const fn stream_sequence(self) -> CommandStreamSequence {
        self.stream_sequence
    }

    /// Returns the producer timestamp retained for correlation only.
    #[must_use]
    pub const fn producer_time(self) -> ProducerTime {
        self.producer_time
    }

    /// Returns the bounded requested command lifetime.
    #[must_use]
    pub const fn requested_ttl(self) -> RequestedCommandTtl {
        self.requested_ttl
    }

    /// Returns the lifecycle generation bound at local validation time.
    #[must_use]
    pub const fn generation(self) -> RuntimeGeneration {
        self.generation
    }

    /// Returns the opaque plant-local receipt timestamp.
    #[must_use]
    pub const fn received_at(self) -> PlantReceiptTime {
        self.received_at
    }

    /// Returns the finite, bounded SI velocity.
    #[must_use]
    pub const fn velocity(self) -> FramedVelocityMetresPerSecond {
        self.velocity
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_identity(byte: u8) -> ProfileIdentity {
        ProfileIdentity::new(CandidateProfileKind::DraftL1SitlLocalNed, [byte; 32])
            .expect("test profile identity is nonzero")
    }

    fn enu_profile_identity(byte: u8) -> ProfileIdentity {
        ProfileIdentity::new(CandidateProfileKind::DraftL1SitlLocalEnu, [byte; 32])
            .expect("test profile identity is nonzero")
    }

    fn session_identity(byte: u8) -> CommandSessionIdentity {
        CommandSessionIdentity::new([byte; 16]).expect("test session identity is nonzero")
    }

    fn producer_time() -> ProducerTime {
        let epoch = ProducerEpochIdentity::new([3; 16]).expect("test epoch identity is nonzero");
        ProducerTime::new(epoch, Duration::from_secs(7))
    }

    fn generation() -> RuntimeGeneration {
        RuntimeGeneration::new(NonZeroU64::new(11).expect("test generation is nonzero"))
    }

    fn metadata(
        version: u16,
        profile: ProfileIdentity,
        session: CommandSessionIdentity,
        ttl: Duration,
    ) -> CommandMetadataV1 {
        CommandMetadataV1::new(
            version,
            profile,
            session,
            CommandStreamSequence::new(9).expect("test sequence is nonzero"),
            producer_time(),
            ttl,
        )
    }

    fn velocity_action(
        frame: VelocityFrame,
        unit: VelocityUnit,
        components: [f64; 3],
    ) -> ProposedActionV1 {
        ProposedActionV1::Velocity(RawVelocityV1::new(frame, unit, components))
    }

    fn validate(
        profile: CandidateProfileV1,
        proposal: &CommandProposalV1,
        session: CommandSessionIdentity,
    ) -> Result<VelocityCommandCandidateV1, ContractRejection> {
        profile.validate_velocity_candidate(proposal, session, generation())
    }

    #[test]
    fn plant_contract_v1_should_accept_only_exact_draft_boundaries() {
        let profile_id = profile_identity(1);
        let session = session_identity(2);
        let profile = CandidateProfileV1::from_identity(profile_id);
        let proposal = CommandProposalV1::new(
            metadata(
                PLANT_CONTRACT_V1,
                profile_id,
                session,
                DRAFT_L1_MAX_COMMAND_TTL,
            ),
            velocity_action(
                VelocityFrame::LocalNed,
                VelocityUnit::MetresPerSecond,
                [3.0, 4.0, -DRAFT_L1_MAX_VERTICAL_SPEED_MPS],
            ),
        );

        let candidate = validate(profile, &proposal, session).expect("boundary should be valid");

        assert_eq!(candidate.contract_version(), ContractVersion::V1);
        assert_eq!(candidate.profile(), profile);
        assert_eq!(candidate.session(), session);
        assert_eq!(candidate.stream_sequence().get(), 9);
        assert_eq!(candidate.producer_time(), producer_time());
        assert_eq!(candidate.requested_ttl().get(), DRAFT_L1_MAX_COMMAND_TTL);
        assert_eq!(candidate.generation(), generation());
        assert_eq!(candidate.velocity().frame(), VelocityFrame::LocalNed);
        assert_eq!(
            candidate.velocity().components().map(f64::to_bits),
            [3.0_f64, 4.0, -2.0].map(f64::to_bits)
        );
    }

    #[test]
    fn plant_contract_v1_should_reject_identity_and_version_mismatches() {
        let profile_id = profile_identity(1);
        let other_profile_id = profile_identity(4);
        let session = session_identity(2);
        let other_session = session_identity(5);
        let profile = CandidateProfileV1::from_identity(profile_id);
        let valid_action = velocity_action(
            VelocityFrame::LocalNed,
            VelocityUnit::MetresPerSecond,
            [0.0; 3],
        );

        let cases = [
            (
                CommandProposalV1::new(
                    metadata(2, profile_id, session, Duration::from_millis(1)),
                    valid_action,
                ),
                session,
                ContractRejection::UnsupportedVersion {
                    expected: PLANT_CONTRACT_V1,
                    received: 2,
                },
            ),
            (
                CommandProposalV1::new(
                    metadata(
                        PLANT_CONTRACT_V1,
                        other_profile_id,
                        session,
                        Duration::from_millis(1),
                    ),
                    valid_action,
                ),
                session,
                ContractRejection::ProfileMismatch,
            ),
            (
                CommandProposalV1::new(
                    metadata(
                        PLANT_CONTRACT_V1,
                        profile_id,
                        other_session,
                        Duration::from_millis(1),
                    ),
                    valid_action,
                ),
                session,
                ContractRejection::SessionMismatch,
            ),
        ];

        for (proposal, expected_session, expected_error) in cases {
            assert_eq!(
                validate(profile, &proposal, expected_session),
                Err(expected_error)
            );
        }
    }

    #[test]
    fn plant_contract_v1_should_reject_ttl_frame_and_unit_mismatches() {
        let profile_id = profile_identity(1);
        let session = session_identity(2);
        let profile = CandidateProfileV1::from_identity(profile_id);
        let valid_action = velocity_action(
            VelocityFrame::LocalNed,
            VelocityUnit::MetresPerSecond,
            [0.0; 3],
        );
        let cases = [
            (
                CommandProposalV1::new(
                    metadata(PLANT_CONTRACT_V1, profile_id, session, Duration::ZERO),
                    valid_action,
                ),
                session,
                ContractRejection::ZeroTtl,
            ),
            (
                CommandProposalV1::new(
                    metadata(
                        PLANT_CONTRACT_V1,
                        profile_id,
                        session,
                        DRAFT_L1_MAX_COMMAND_TTL + Duration::from_nanos(1),
                    ),
                    valid_action,
                ),
                session,
                ContractRejection::TtlExceedsDraftLimit {
                    maximum: DRAFT_L1_MAX_COMMAND_TTL,
                    received: DRAFT_L1_MAX_COMMAND_TTL + Duration::from_nanos(1),
                },
            ),
            (
                CommandProposalV1::new(
                    metadata(
                        PLANT_CONTRACT_V1,
                        profile_id,
                        session,
                        Duration::from_millis(1),
                    ),
                    velocity_action(
                        VelocityFrame::LocalEnu,
                        VelocityUnit::MetresPerSecond,
                        [0.0; 3],
                    ),
                ),
                session,
                ContractRejection::FrameMismatch {
                    expected: VelocityFrame::LocalNed,
                    received: VelocityFrame::LocalEnu,
                },
            ),
            (
                CommandProposalV1::new(
                    metadata(
                        PLANT_CONTRACT_V1,
                        profile_id,
                        session,
                        Duration::from_millis(1),
                    ),
                    velocity_action(
                        VelocityFrame::LocalNed,
                        VelocityUnit::CentimetresPerSecond,
                        [0.0; 3],
                    ),
                ),
                session,
                ContractRejection::UnsupportedVelocityUnit {
                    received: VelocityUnit::CentimetresPerSecond,
                },
            ),
        ];

        for (proposal, expected_session, expected_error) in cases {
            assert_eq!(
                validate(profile, &proposal, expected_session),
                Err(expected_error)
            );
        }
    }

    #[test]
    fn plant_contract_v1_should_reject_body_relative_frames() {
        let profile_id = profile_identity(1);
        let session = session_identity(2);
        let profile = CandidateProfileV1::from_identity(profile_id);

        for frame in [VelocityFrame::BodyFrd, VelocityFrame::BodyFlu] {
            let proposal = CommandProposalV1::new(
                metadata(
                    PLANT_CONTRACT_V1,
                    profile_id,
                    session,
                    Duration::from_millis(1),
                ),
                velocity_action(frame, VelocityUnit::MetresPerSecond, [0.0; 3]),
            );
            assert_eq!(
                validate(profile, &proposal, session),
                Err(ContractRejection::FrameMismatch {
                    expected: VelocityFrame::LocalNed,
                    received: frame,
                })
            );
        }
    }

    #[test]
    fn plant_contract_v1_should_reject_every_non_si_velocity_unit() {
        let profile_id = profile_identity(1);
        let session = session_identity(2);
        let profile = CandidateProfileV1::from_identity(profile_id);

        for unit in [
            VelocityUnit::CentimetresPerSecond,
            VelocityUnit::FeetPerSecond,
        ] {
            let proposal = CommandProposalV1::new(
                metadata(
                    PLANT_CONTRACT_V1,
                    profile_id,
                    session,
                    Duration::from_millis(1),
                ),
                velocity_action(VelocityFrame::LocalNed, unit, [0.0; 3]),
            );
            assert_eq!(
                validate(profile, &proposal, session),
                Err(ContractRejection::UnsupportedVelocityUnit { received: unit })
            );
        }
    }

    #[test]
    fn plant_contract_v1_should_reject_nonfinite_and_out_of_speed_limit_velocity() {
        let profile_id = enu_profile_identity(1);
        let session = session_identity(2);
        let profile = CandidateProfileV1::from_identity(profile_id);
        let above_horizontal_limit =
            f64::from_bits(DRAFT_L1_MAX_HORIZONTAL_SPEED_MPS.to_bits() + 1);
        let above_vertical_limit = f64::from_bits(DRAFT_L1_MAX_VERTICAL_SPEED_MPS.to_bits() + 1);
        let cases = [
            (
                [f64::NAN, 0.0, 0.0],
                ContractRejection::NonFiniteVelocity { axis: Axis::X },
            ),
            (
                [0.0, f64::INFINITY, 0.0],
                ContractRejection::NonFiniteVelocity { axis: Axis::Y },
            ),
            (
                [0.0, 0.0, f64::NEG_INFINITY],
                ContractRejection::NonFiniteVelocity { axis: Axis::Z },
            ),
            (
                [above_horizontal_limit, 0.0, 0.0],
                ContractRejection::HorizontalSpeedExceedsDraftLimit,
            ),
            (
                [0.0, 0.0, above_vertical_limit],
                ContractRejection::VerticalSpeedExceedsDraftLimit,
            ),
        ];

        for (components, expected_error) in cases {
            let proposal = CommandProposalV1::new(
                metadata(
                    PLANT_CONTRACT_V1,
                    profile_id,
                    session,
                    Duration::from_millis(1),
                ),
                velocity_action(
                    VelocityFrame::LocalEnu,
                    VelocityUnit::MetresPerSecond,
                    components,
                ),
            );
            assert_eq!(validate(profile, &proposal, session), Err(expected_error));
        }
    }

    #[test]
    fn plant_contract_v1_should_reject_every_non_velocity_action() {
        let profile_id = profile_identity(1);
        let session = session_identity(2);
        let profile = CandidateProfileV1::from_identity(profile_id);
        let actions = [
            ProposedActionV1::Hold,
            ProposedActionV1::Land,
            ProposedActionV1::ReturnToLaunch,
            ProposedActionV1::Arm,
            ProposedActionV1::Disarm,
            ProposedActionV1::Takeoff,
            ProposedActionV1::Mission,
            ProposedActionV1::ModeChange,
            ProposedActionV1::RawMotor,
        ];

        for action in actions {
            let proposal = CommandProposalV1::new(
                metadata(
                    PLANT_CONTRACT_V1,
                    profile_id,
                    session,
                    Duration::from_millis(1),
                ),
                action,
            );
            assert_eq!(
                validate(profile, &proposal, session),
                Err(ContractRejection::UnsupportedAction {
                    action: action.kind()
                })
            );
        }
    }

    #[test]
    fn candidate_profile_and_ids_should_reject_ambiguous_values() {
        assert_eq!(
            ProfileIdentity::new(CandidateProfileKind::DraftL1SitlLocalNed, [0; 32])
                .unwrap_err()
                .kind(),
            IdentifierKind::Profile
        );
        assert_eq!(
            CommandSessionIdentity::new([0; 16]).unwrap_err().kind(),
            IdentifierKind::Session
        );
        assert_eq!(
            ProducerEpochIdentity::new([0; 16]).unwrap_err().kind(),
            IdentifierKind::ProducerEpoch
        );
        assert_eq!(CommandStreamSequence::new(0), Err(SequenceError));

        let ned_identity = profile_identity(1);
        let enu_identity = enu_profile_identity(1);
        assert_ne!(ned_identity, enu_identity);
        assert_eq!(
            CandidateProfileV1::from_identity(ned_identity).velocity_frame(),
            VelocityFrame::LocalNed
        );
        assert_eq!(
            CandidateProfileV1::from_identity(enu_identity).velocity_frame(),
            VelocityFrame::LocalEnu
        );
    }
}
