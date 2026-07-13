//! Inert foundations for CREBAIN's future headless plant authority.
//!
//! This crate deliberately has no renderer, Tauri, transport, inference,
//! simulation, or vehicle-adapter dependency. It supplies an inactive draft
//! command validator, closed immutable in-memory vehicle-health candidate,
//! inert profile-bound captured-read age classifier, lifecycle,
//! bounded-channel, and passive monotonic-expiry primitives plus an inert
//! kernel self-check. It does not parse or accept a command, authenticate FCU
//! state, establish current freshness, transition authority, or cause a
//! physical action.

#![deny(missing_docs)]
#![forbid(unsafe_code)]

mod adapter;
mod channels;
mod contract;
mod expiry;
mod frame_conventions;
mod freshness;
mod health;
mod lifecycle;
mod runtime;

pub use adapter::{AdapterError, AdapterState, InertAdapter};
pub use channels::{
    bounded_queue, latest_value, snapshot_value, BoundedReceiver, BoundedSender,
    ChannelConfigurationError, ChannelError, ChannelReadError, DropAccounting, FullPolicy,
    KernelChannels, LatestChannel, LatestReceiver, LatestSender, LatestSnapshot, QueueChannel,
    SafetyCause, SafetyLatch, SafetyNotice, SnapshotChannel, SnapshotCommit, SnapshotReceiver,
    SnapshotSender, MAX_BOUNDED_QUEUE_CAPACITY,
};
pub use contract::{
    Axis, CandidateProfileKind, CandidateProfileV1, CommandMetadataV1, CommandProposalV1,
    CommandSessionIdentity, CommandStreamSequence, ContractRejection, ContractVersion,
    FramedVelocityMetresPerSecond, IdentifierError, IdentifierKind, PlantReceiptTime,
    ProducerEpochIdentity, ProducerTime, ProfileIdentity, ProposedActionKind, ProposedActionV1,
    RawVelocityV1, RequestedCommandTtl, SequenceError, VelocityCommandCandidateV1, VelocityFrame,
    VelocityUnit, DRAFT_L1_MAX_COMMAND_TTL, DRAFT_L1_MAX_HORIZONTAL_SPEED_MPS,
    DRAFT_L1_MAX_VERTICAL_SPEED_MPS, PLANT_CONTRACT_V1,
};
pub use expiry::{ExpiryConfigurationError, ExpiryStatus, MonotonicExpiryGuard};
pub use frame_conventions::{FiniteFramedVelocityMpsV1, FrameConventionError};
pub use freshness::{
    VehicleHealthAgeAssessmentErrorV1, VehicleHealthAgeComparisonAtReadV1,
    VehicleHealthAgeLimitsProposalV1, VehicleHealthAgePointV1,
    VehicleHealthAgePolicyConfigurationErrorV1, VehicleHealthAgeRelationAtReadV1,
    VehicleHealthCapturedAgeAssessmentV1, VehicleHealthCapturedAgePolicyV1,
};
pub use health::{
    vehicle_health_channel, ArmingStateV1, BatteryObservationV1, EstimateValidityV1,
    EstimatorStateV1, FcuFailsafeStateV1, FcuHealthSourceIdentity, FcuLinksV1, FcuModeStateV1,
    FcuStateV1, FenceStateV1, HealthAxisV1, HealthIdentityError, HealthIdentityKind,
    HealthObservationGroupV1, HealthObservationTimesV1, HealthSequenceError,
    HealthStreamEpochIdentity, HealthStreamSequence, HealthVectorKindV1, LandedStateV1,
    LinkStateV1, LocalFrameInstanceIdentity, MeasurementUnavailableReasonV1,
    ObservedVehicleHealthV1, PlantObservationTime, PositionObservationV1, PositionUnitV1,
    ProfileModeCode, VehicleHealthAgesV1, VehicleHealthCommitError, VehicleHealthCommitReceiptV1,
    VehicleHealthContextV1, VehicleHealthDomainV1, VehicleHealthMetadataV1,
    VehicleHealthPublisherV1, VehicleHealthReadError, VehicleHealthReaderV1, VehicleHealthReportV1,
    VehicleHealthSnapshotV1, VehicleHealthStateV1, VehicleHealthTimePointV1, VehicleHealthUnitsV1,
    VehicleIdentity, VelocityObservationV1, VEHICLE_HEALTH_SCHEMA_V1,
};
pub use lifecycle::{
    GuardedEvent, LifecycleError, LifecycleEvent, LifecycleMachine, PlantState, RuntimeGeneration,
    Transition,
};
pub use runtime::{run_self_check, KernelError, SelfCheckReport};
