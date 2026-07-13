//! Inert foundations for CREBAIN's future headless plant authority.
//!
//! This crate deliberately has no renderer, Tauri, transport, inference,
//! simulation, or vehicle-adapter dependency. It supplies only lifecycle and
//! bounded-channel primitives plus an inert kernel self-check. It does not
//! accept a command or cause a physical action.

#![deny(missing_docs)]
#![forbid(unsafe_code)]

mod adapter;
mod channels;
mod lifecycle;
mod runtime;

pub use adapter::{AdapterError, AdapterState, InertAdapter};
pub use channels::{
    bounded_queue, latest_value, BoundedReceiver, BoundedSender, ChannelConfigurationError,
    ChannelError, ChannelReadError, DropAccounting, FullPolicy, KernelChannels, LatestChannel,
    LatestReceiver, LatestSender, LatestSnapshot, QueueChannel, SafetyCause, SafetyLatch,
    SafetyNotice, MAX_BOUNDED_QUEUE_CAPACITY,
};
pub use lifecycle::{
    GuardedEvent, LifecycleError, LifecycleEvent, LifecycleMachine, PlantState, RuntimeGeneration,
    Transition,
};
pub use runtime::{run_self_check, KernelError, SelfCheckReport};
