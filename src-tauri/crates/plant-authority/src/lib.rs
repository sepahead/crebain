//! Inert foundations for CREBAIN's future headless plant authority.
//!
//! This crate deliberately has no renderer, Tauri, transport, inference,
//! simulation, or vehicle-adapter dependency. It supplies an inactive draft
//! contract validator, lifecycle, bounded-channel, and passive monotonic-expiry
//! primitives plus an inert kernel self-check. It does not parse or accept a
//! command, transition authority, or cause a physical action.

#![deny(missing_docs)]
#![forbid(unsafe_code)]

mod adapter;
mod channels;
mod contract;
mod expiry;
mod frame_conventions;
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
pub use lifecycle::{
    GuardedEvent, LifecycleError, LifecycleEvent, LifecycleMachine, PlantState, RuntimeGeneration,
    Transition,
};
pub use runtime::{run_self_check, KernelError, SelfCheckReport};
