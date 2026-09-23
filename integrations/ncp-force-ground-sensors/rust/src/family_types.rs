//! Fixed application DTOs generated from `contracts/family.application.schema.v1.json`.
use crate::types::*;
use crate::Finite64;
use ncp_local::modular_buffer::BufferBinding;
use serde::{Deserialize, Serialize};

/// Closed installed `Digest` value; semantic bounds remain in the owning schema.
pub type Digest = String;

/// Closed installed `Uuid` value; semantic bounds remain in the owning schema.
pub type Uuid = String;

/// Closed installed `Token` value; semantic bounds remain in the owning schema.
pub type Token = String;

/// Closed installed `CommittedStamp` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CommittedStamp {
    /// Closed schema member `binding`.
    pub binding: BufferBinding,
    /// Closed schema member `sequence`.
    pub sequence: u64,
    /// Closed schema member `request_digest`.
    pub request_digest: Digest,
    /// Closed schema member `result_digest`.
    pub result_digest: Digest,
}

/// Closed installed `CheckpointReference` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CheckpointReference {
    /// Closed schema member `family_id`.
    pub family_id: Uuid,
    /// Closed schema member `checkpoint_token`.
    pub checkpoint_token: Uuid,
    /// Closed schema member `parent_binding`.
    pub parent_binding: BufferBinding,
    /// Closed schema member `parent_native_owner_id`.
    pub parent_native_owner_id: Uuid,
    /// Closed schema member `tick`.
    pub tick: u64,
    /// Closed schema member `checkpoint_sha256`.
    pub checkpoint_sha256: Digest,
}

/// Closed installed `PressureWindow` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PressureWindow {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `sensor_id`.
    pub sensor_id: String,
    /// Closed schema member `first_tick`.
    pub first_tick: u64,
    /// Closed schema member `last_tick`.
    pub last_tick: u64,
    /// Closed schema member `sample_count`.
    pub sample_count: u64,
    /// Closed schema member `unit`.
    pub unit: String,
    /// Closed schema member `target_function_digest`.
    pub target_function_digest: Digest,
}

/// Closed installed `BranchPlan` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BranchPlan {
    /// Closed schema member `slot`.
    pub slot: u64,
    /// Closed schema member `case_id`.
    pub case_id: Token,
    /// Closed schema member `purpose`.
    pub purpose: BranchPlanPurpose,
    /// Closed schema member `binding`.
    pub binding: BufferBinding,
    /// Closed schema member `target`.
    pub target: SetTarget,
}

/// Closed installed `FamilyLimits` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FamilyLimits {
    /// Closed schema member `total_wall_seconds`.
    pub total_wall_seconds: u64,
    /// Closed schema member `endpoint_count`.
    pub endpoint_count: u64,
    /// Closed schema member `max_active_native_owners`.
    pub max_active_native_owners: u64,
    /// Closed schema member `public_checkpoint_slots`.
    pub public_checkpoint_slots: u64,
    /// Closed schema member `temporary_checkpoint_slots`.
    pub temporary_checkpoint_slots: u64,
    /// Closed schema member `evaluation_window_bytes`.
    pub evaluation_window_bytes: u64,
}

/// Closed installed `FamilyPlan` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FamilyPlan {
    /// Closed schema member `family_id`.
    pub family_id: Uuid,
    /// Closed schema member `canonical_binding`.
    pub canonical_binding: BufferBinding,
    /// Closed schema member `body`.
    pub body: Prepare,
    /// Closed schema member `landmark_tick`.
    pub landmark_tick: u64,
    /// Closed schema member `branches`.
    pub branches: Vec<BranchPlan>,
    /// Closed schema member `evaluation`.
    pub evaluation: PressureWindow,
    /// Closed schema member `limits`.
    pub limits: FamilyLimits,
}

/// Closed installed `CanonicalPrepare` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CanonicalPrepare {
    /// Closed schema member `plan`.
    pub plan: FamilyPlan,
}

/// Closed installed `CheckpointCommand` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CheckpointCommand {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `tick`.
    pub tick: u64,
    /// Closed schema member `expected_batch_digest`.
    pub expected_batch_digest: Digest,
}

/// Closed installed `CommitDecisionCommand` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CommitDecisionCommand {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `checkpoint`.
    pub checkpoint: CheckpointReference,
    /// Closed schema member `forecast_commitment_digest`.
    pub forecast_commitment_digest: Digest,
    /// Closed schema member `selected_case_id`.
    pub selected_case_id: Token,
}

/// Closed installed `ReserveBranchCommand` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReserveBranchCommand {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `checkpoint`.
    pub checkpoint: CheckpointReference,
    /// Closed schema member `case_id`.
    pub case_id: Token,
    /// Closed schema member `expected_selected_execution_result_digest`.
    pub expected_selected_execution_result_digest: Digest,
}

/// Closed installed `ReleaseCheckpointCommand` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReleaseCheckpointCommand {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `checkpoint`.
    pub checkpoint: CheckpointReference,
    /// Closed schema member `expected_last_branch_terminal_result_digest`.
    pub expected_last_branch_terminal_result_digest: Digest,
}

/// Closed installed `CanonicalCommand` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum CanonicalCommand {
    /// Closed `advance_tick` variant.
    #[serde(rename = "advance_tick")]
    AdvanceTick {
        /// Closed schema member `tick`.
        tick: u64,
        /// Closed schema member `previous_batch_digest`.
        previous_batch_digest: Option<String>,
        /// Closed schema member `action`.
        action: Box<Action>,
        /// Closed schema member `capture_reservation`.
        capture_reservation: Box<CanonicalCommandAdvanceTickCaptureReservation>,
    },
    /// Closed `checkpoint` variant.
    #[serde(rename = "checkpoint")]
    Checkpoint {
        /// Closed schema member `tick`.
        tick: u64,
        /// Closed schema member `expected_batch_digest`.
        expected_batch_digest: Digest,
    },
    /// Closed `commit_decision` variant.
    #[serde(rename = "commit_decision")]
    CommitDecision {
        /// Closed schema member `checkpoint`.
        checkpoint: Box<CheckpointReference>,
        /// Closed schema member `forecast_commitment_digest`.
        forecast_commitment_digest: Digest,
        /// Closed schema member `selected_case_id`.
        selected_case_id: Token,
    },
    /// Closed `reserve_branch` variant.
    #[serde(rename = "reserve_branch")]
    ReserveBranch {
        /// Closed schema member `checkpoint`.
        checkpoint: Box<CheckpointReference>,
        /// Closed schema member `case_id`.
        case_id: Token,
        /// Closed schema member `expected_selected_execution_result_digest`.
        expected_selected_execution_result_digest: Digest,
    },
    /// Closed `release_checkpoint` variant.
    #[serde(rename = "release_checkpoint")]
    ReleaseCheckpoint {
        /// Closed schema member `checkpoint`.
        checkpoint: Box<CheckpointReference>,
        /// Closed schema member `expected_last_branch_terminal_result_digest`.
        expected_last_branch_terminal_result_digest: Digest,
    },
}

/// Closed installed `ReservationReference` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReservationReference {
    /// Closed schema member `family_id`.
    pub family_id: Uuid,
    /// Closed schema member `reservation_token`.
    pub reservation_token: Uuid,
    /// Closed schema member `case_id`.
    pub case_id: Token,
    /// Closed schema member `branch_binding`.
    pub branch_binding: BufferBinding,
    /// Closed schema member `checkpoint`.
    pub checkpoint: CheckpointReference,
    /// Closed schema member `reserving_request_digest`.
    pub reserving_request_digest: Digest,
}

/// Closed installed `EvaluationPrepare` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluationPrepare {
    /// Closed schema member `reservation`.
    pub reservation: ReservationReference,
    /// Closed schema member `expected_family_plan_digest`.
    pub expected_family_plan_digest: Digest,
}

/// Closed installed `EvaluateCommand` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluateCommand {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `expected_batch_digest`.
    pub expected_batch_digest: Digest,
    /// Closed schema member `expected_target_function_digest`.
    pub expected_target_function_digest: Digest,
}

/// Closed installed `EvaluationCommand` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum EvaluationCommand {
    /// Closed `advance_tick` variant.
    #[serde(rename = "advance_tick")]
    AdvanceTick {
        /// Closed schema member `tick`.
        tick: u64,
        /// Closed schema member `previous_batch_digest`.
        previous_batch_digest: Option<String>,
        /// Closed schema member `action`.
        action: Box<Action>,
        /// Closed schema member `capture_reservation`.
        capture_reservation: Box<EvaluationCommandAdvanceTickCaptureReservation>,
    },
    /// Closed `evaluate_pressure_window` variant.
    #[serde(rename = "evaluate_pressure_window")]
    EvaluatePressureWindow {
        /// Closed schema member `expected_batch_digest`.
        expected_batch_digest: Digest,
        /// Closed schema member `expected_target_function_digest`.
        expected_target_function_digest: Digest,
    },
}

/// Closed installed `BranchAncestry` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BranchAncestry {
    /// Closed schema member `family_id`.
    pub family_id: Uuid,
    /// Closed schema member `case_id`.
    pub case_id: Token,
    /// Closed schema member `origin`.
    pub origin: CheckpointReference,
    /// Closed schema member `origin_plan_digest`.
    pub origin_plan_digest: Digest,
    /// Closed schema member `origin_engine_run_id`.
    pub origin_engine_run_id: String,
    /// Closed schema member `origin_native_batch_sha256`.
    pub origin_native_batch_sha256: Digest,
    /// Closed schema member `origin_sensor_batch_digest`.
    pub origin_sensor_batch_digest: Digest,
    /// Closed schema member `action_history_position`.
    pub action_history_position: u64,
    /// Closed schema member `selection`.
    pub selection: CommittedStamp,
    /// Closed schema member `selected_execution`.
    pub selected_execution: CommittedStamp,
    /// Closed schema member `execution_binding`.
    pub execution_binding: BufferBinding,
    /// Closed schema member `native_owner_id`.
    pub native_owner_id: Uuid,
    /// Closed schema member `graphics_generation`.
    pub graphics_generation: Uuid,
    /// Closed schema member `reconstruction`.
    pub reconstruction: String,
}

/// Closed installed `PixelIdentity` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PixelIdentity {
    /// Closed schema member `sensor_id`.
    pub sensor_id: String,
    /// Closed schema member `payload_sha256`.
    pub payload_sha256: Digest,
}

/// Closed installed `Checkpointed` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Checkpointed {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `reference`.
    pub reference: CheckpointReference,
    /// Closed schema member `cpu_state_sha256`.
    pub cpu_state_sha256: Digest,
    /// Closed schema member `graphics_plan_sha256`.
    pub graphics_plan_sha256: Digest,
    /// Closed schema member `render_input_sha256`.
    pub render_input_sha256: Digest,
    /// Closed schema member `pixels`.
    pub pixels: Vec<PixelIdentity>,
    /// Closed schema member `accepted_native_batch_sha256`.
    pub accepted_native_batch_sha256: Digest,
    /// Closed schema member `accepted_sensor_batch_digest`.
    pub accepted_sensor_batch_digest: Digest,
    /// Closed schema member `accepted_action_position`.
    pub accepted_action_position: u64,
}

/// Closed installed `DecisionCommitted` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DecisionCommitted {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `checkpoint`.
    pub checkpoint: CheckpointReference,
    /// Closed schema member `forecast_commitment_digest`.
    pub forecast_commitment_digest: Digest,
    /// Closed schema member `selected_case_id`.
    pub selected_case_id: Token,
    /// Closed schema member `selected_target`.
    pub selected_target: SetTarget,
}

/// Closed installed `BranchReserved` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BranchReserved {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `reference`.
    pub reference: ReservationReference,
    /// Closed schema member `family_plan_digest`.
    pub family_plan_digest: Digest,
}

/// Closed installed `CheckpointReleased` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CheckpointReleased {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `reference`.
    pub reference: CheckpointReference,
    /// Closed schema member `native_release`.
    pub native_release: String,
}

/// Closed installed `FamilyPrepared` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FamilyPrepared {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `family_plan_digest`.
    pub family_plan_digest: Digest,
    /// Closed schema member `body`.
    pub body: Prepared,
    /// Closed schema member `endpoint_count`.
    pub endpoint_count: u64,
    /// Closed schema member `native_owner_count`.
    pub native_owner_count: u64,
}

/// Closed installed `Restored` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Restored {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `family_plan_digest`.
    pub family_plan_digest: Digest,
    /// Closed schema member `sensor_catalog`.
    pub sensor_catalog: SensorCatalog,
    /// Closed schema member `initial_observation`.
    pub initial_observation: String,
    /// Closed schema member `ancestry`.
    pub ancestry: BranchAncestry,
    /// Closed schema member `cpu_state_sha256`.
    pub cpu_state_sha256: Digest,
    /// Closed schema member `render_input_sha256`.
    pub render_input_sha256: Digest,
    /// Closed schema member `pixels`.
    pub pixels: Vec<PixelIdentity>,
}

/// Closed installed `FamilyAdvanced` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FamilyAdvanced {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `body`.
    pub body: Advanced,
    /// Closed schema member `ancestry`.
    pub ancestry: Option<BranchAncestry>,
    /// Closed schema member `canonical_final_state`.
    pub canonical_final_state: Option<CanonicalFinalState>,
}

/// Closed installed `PressureSegment` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PressureSegment {
    /// Closed schema member `source_body_tick`.
    pub source_body_tick: u64,
    /// Closed schema member `available_after_body_tick`.
    pub available_after_body_tick: u64,
    /// Closed schema member `sample_start`.
    pub sample_start: u64,
    /// Closed schema member `sample_end`.
    pub sample_end: u64,
    /// Closed schema member `typed_manifest_digest`.
    pub typed_manifest_digest: Digest,
    /// Closed schema member `byte_manifest_digest`.
    pub byte_manifest_digest: Digest,
    /// Closed schema member `payload_sha256`.
    pub payload_sha256: Digest,
    /// Closed schema member `byte_length`.
    pub byte_length: u64,
}

/// Closed installed `EvaluationResult` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluationResult {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `ancestry`.
    pub ancestry: BranchAncestry,
    /// Closed schema member `target`.
    pub target: PressureWindow,
    /// Closed schema member `segments`.
    pub segments: [PressureSegment; 3],
    /// Closed schema member `window_payload_sha256`.
    pub window_payload_sha256: Digest,
    /// Closed schema member `value_pa`.
    pub value_pa: Finite64,
    /// Closed schema member `final_cpu_state_sha256`.
    pub final_cpu_state_sha256: Digest,
    /// Closed schema member `final_native_batch_sha256`.
    pub final_native_batch_sha256: Digest,
    /// Closed schema member `final_sensor_batch_digest`.
    pub final_sensor_batch_digest: Digest,
    /// Closed schema member `accepted_action_request_digest`.
    pub accepted_action_request_digest: Digest,
    /// Closed schema member `scientific_validation`.
    pub scientific_validation: bool,
}

/// Closed installed `CanonicalResult` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum CanonicalResult {
    /// Closed `family_prepared` variant.
    #[serde(rename = "family_prepared")]
    FamilyPrepared {
        /// Closed schema member `family_plan_digest`.
        family_plan_digest: Digest,
        /// Closed schema member `body`.
        body: Box<Prepared>,
        /// Closed schema member `endpoint_count`.
        endpoint_count: u64,
        /// Closed schema member `native_owner_count`.
        native_owner_count: u64,
    },
    /// Closed `family_advanced` variant.
    #[serde(rename = "family_advanced")]
    FamilyAdvanced {
        /// Closed schema member `body`.
        body: Box<Advanced>,
        /// Closed schema member `ancestry`.
        ancestry: Option<Box<BranchAncestry>>,
        /// Closed schema member `canonical_final_state`.
        canonical_final_state: Option<Box<CanonicalFinalState>>,
    },
    /// Closed `checkpointed` variant.
    #[serde(rename = "checkpointed")]
    Checkpointed {
        /// Closed schema member `reference`.
        reference: Box<CheckpointReference>,
        /// Closed schema member `cpu_state_sha256`.
        cpu_state_sha256: Digest,
        /// Closed schema member `graphics_plan_sha256`.
        graphics_plan_sha256: Digest,
        /// Closed schema member `render_input_sha256`.
        render_input_sha256: Digest,
        /// Closed schema member `pixels`.
        pixels: Vec<PixelIdentity>,
        /// Closed schema member `accepted_native_batch_sha256`.
        accepted_native_batch_sha256: Digest,
        /// Closed schema member `accepted_sensor_batch_digest`.
        accepted_sensor_batch_digest: Digest,
        /// Closed schema member `accepted_action_position`.
        accepted_action_position: u64,
    },
    /// Closed `decision_committed` variant.
    #[serde(rename = "decision_committed")]
    DecisionCommitted {
        /// Closed schema member `checkpoint`.
        checkpoint: Box<CheckpointReference>,
        /// Closed schema member `forecast_commitment_digest`.
        forecast_commitment_digest: Digest,
        /// Closed schema member `selected_case_id`.
        selected_case_id: Token,
        /// Closed schema member `selected_target`.
        selected_target: Box<SetTarget>,
    },
    /// Closed `branch_reserved` variant.
    #[serde(rename = "branch_reserved")]
    BranchReserved {
        /// Closed schema member `reference`.
        reference: Box<ReservationReference>,
        /// Closed schema member `family_plan_digest`.
        family_plan_digest: Digest,
    },
    /// Closed `checkpoint_released` variant.
    #[serde(rename = "checkpoint_released")]
    CheckpointReleased {
        /// Closed schema member `reference`.
        reference: Box<CheckpointReference>,
        /// Closed schema member `native_release`.
        native_release: String,
    },
}

/// Closed installed `EvaluationResultUnion` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum EvaluationResultUnion {
    /// Closed `restored` variant.
    #[serde(rename = "restored")]
    Restored {
        /// Closed schema member `family_plan_digest`.
        family_plan_digest: Digest,
        /// Closed schema member `sensor_catalog`.
        sensor_catalog: Box<SensorCatalog>,
        /// Closed schema member `initial_observation`.
        initial_observation: String,
        /// Closed schema member `ancestry`.
        ancestry: Box<BranchAncestry>,
        /// Closed schema member `cpu_state_sha256`.
        cpu_state_sha256: Digest,
        /// Closed schema member `render_input_sha256`.
        render_input_sha256: Digest,
        /// Closed schema member `pixels`.
        pixels: Vec<PixelIdentity>,
    },
    /// Closed `family_advanced` variant.
    #[serde(rename = "family_advanced")]
    FamilyAdvanced {
        /// Closed schema member `body`.
        body: Box<Advanced>,
        /// Closed schema member `ancestry`.
        ancestry: Option<Box<BranchAncestry>>,
        /// Closed schema member `canonical_final_state`.
        canonical_final_state: Option<Box<CanonicalFinalState>>,
    },
    /// Closed `pressure_window_evaluated` variant.
    #[serde(rename = "pressure_window_evaluated")]
    PressureWindowEvaluated {
        /// Closed schema member `ancestry`.
        ancestry: Box<BranchAncestry>,
        /// Closed schema member `target`.
        target: Box<PressureWindow>,
        /// Closed schema member `segments`.
        segments: Box<[PressureSegment; 3]>,
        /// Closed schema member `window_payload_sha256`.
        window_payload_sha256: Digest,
        /// Closed schema member `value_pa`.
        value_pa: Finite64,
        /// Closed schema member `final_cpu_state_sha256`.
        final_cpu_state_sha256: Digest,
        /// Closed schema member `final_native_batch_sha256`.
        final_native_batch_sha256: Digest,
        /// Closed schema member `final_sensor_batch_digest`.
        final_sensor_batch_digest: Digest,
        /// Closed schema member `accepted_action_request_digest`.
        accepted_action_request_digest: Digest,
        /// Closed schema member `scientific_validation`.
        scientific_validation: bool,
    },
}

/// Closed installed `CanonicalFinish` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CanonicalFinish {
    /// Closed schema member `body`.
    pub body: Finish,
    /// Closed schema member `family_plan_digest`.
    pub family_plan_digest: Digest,
    /// Closed schema member `expected_branch_terminals`.
    pub expected_branch_terminals: Vec<CommittedStamp>,
}

/// Closed installed `EvaluationFinish` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluationFinish {
    /// Closed schema member `body`.
    pub body: Finish,
    /// Closed schema member `evaluation_result_digest`.
    pub evaluation_result_digest: Digest,
}

/// Closed installed `EvaluationTerminal` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluationTerminal {
    /// Closed schema member `family_id`.
    pub family_id: Uuid,
    /// Closed schema member `case_id`.
    pub case_id: Token,
    /// Closed schema member `ancestry`.
    pub ancestry: BranchAncestry,
    /// Closed schema member `last_batch_digest`.
    pub last_batch_digest: Digest,
    /// Closed schema member `evaluation_result_digest`.
    pub evaluation_result_digest: Digest,
    /// Closed schema member `native_owner_retirement`.
    pub native_owner_retirement: String,
    /// Closed schema member `graphics_retirement`.
    pub graphics_retirement: String,
    /// Closed schema member `shared_family_process_retirement`.
    pub shared_family_process_retirement: String,
    /// Closed schema member `promised_sensor_output`.
    pub promised_sensor_output: String,
    /// Closed schema member `scientific_validation`.
    pub scientific_validation: bool,
}

/// Closed installed `CanonicalTerminal` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CanonicalTerminal {
    /// Closed schema member `family_id`.
    pub family_id: Uuid,
    /// Closed schema member `family_plan_digest`.
    pub family_plan_digest: Digest,
    /// Closed schema member `last_batch_digest`.
    pub last_batch_digest: Digest,
    /// Closed schema member `branch_terminals`.
    pub branch_terminals: Vec<CommittedStamp>,
    /// Closed schema member `checkpoint_release`.
    pub checkpoint_release: String,
    /// Closed schema member `native_family_retirement`.
    pub native_family_retirement: String,
    /// Closed schema member `bun_process_retirement`.
    pub bun_process_retirement: String,
    /// Closed schema member `sdk_host_process_retirement`.
    pub sdk_host_process_retirement: String,
    /// Closed schema member `scientific_validation`.
    pub scientific_validation: bool,
    /// Closed schema member `canonical_final_state`.
    pub canonical_final_state: CanonicalFinalState,
    /// Closed schema member `canonical_state_recheck`.
    pub canonical_state_recheck: String,
}

/// Closed installed `CanonicalFinalState` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CanonicalFinalState {
    /// Closed schema member `body_tick`.
    pub body_tick: u64,
    /// Closed schema member `native_batch_sha256`.
    pub native_batch_sha256: Digest,
    /// Closed schema member `cpu_state_sha256`.
    pub cpu_state_sha256: Digest,
    /// Closed schema member `render_input_sha256`.
    pub render_input_sha256: Digest,
    /// Closed schema member `pixels`.
    pub pixels: Vec<PixelIdentity>,
}

/// Closed installed `BranchPlanPurpose` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum BranchPlanPurpose {
    /// Closed `label` value.
    #[serde(rename = "label")]
    Label,
    /// Closed `same_action_control` value.
    #[serde(rename = "same_action_control")]
    SameActionControl,
}

/// Closed installed `CanonicalCommandAdvanceTickCaptureReservation` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CanonicalCommandAdvanceTickCaptureReservation {
    /// Closed schema member `kind`.
    pub kind: String,
}

/// Closed installed `EvaluationCommandAdvanceTickCaptureReservation` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluationCommandAdvanceTickCaptureReservation {
    /// Closed schema member `kind`.
    pub kind: String,
}
