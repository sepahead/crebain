//! Deterministic CREBAIN multi-drone simulation for a managed host runtime.
//!
//! The crate has no NCP, Tauri, network, filesystem, process-spawn, or plant
//! dependency. It reuses CREBAIN's normative sensor-fusion source directly.
//! All actuator values are simulator-only inputs and outputs.

#[path = "../../../src/pid_observation.rs"]
#[allow(dead_code)]
mod pid_observation;
#[path = "../../../src/sensor_fusion.rs"]
#[allow(dead_code)]
mod sensor_fusion;

mod canonical;
mod contract;
mod protocol;
mod simulation;
mod standard;

pub use contract::{
    FaultCode, FinishRequest, FinishResponse, Outcome, PrepareRequest, PrepareResponse,
    RuntimeConfiguration, SimulationFrameResponse, StandardFaultScheduleEntry,
    StandardScheduledFault, StandardSimulatorProfile, StepRequest, StepResponse,
};
pub use protocol::{
    ipc_schema_sha256, operation_roster_sha256, serve_managed_runtime, ProtocolError,
    RuntimeSessionReceipt,
};
pub use sensor_fusion::SensorModality as InnovationModality;
pub use simulation::{
    validate_prepare_request, EntityInnovation, Finished, InnovationAbsence, InnovationEvidence,
    InnovationFrame, InnovationRecording, KalmanInnovation, MultiDroneSimulation, Prepared,
    SimulationError, SimulationRuntime, Unprepared,
};
pub use standard::{
    StandardActionDisposition, StandardFaultDisposition, StandardFinishRequest,
    StandardFinishResponse, StandardPrepareRequest, StandardPrepareResponse,
    StandardSimulationError, StandardSimulationRuntime, StandardStepRequest, StandardStepResponse,
};
