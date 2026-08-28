use serde::{Deserialize, Serialize};

pub(crate) const PROFILE: &str = "engram.reviewed-native-development.v1";
pub(crate) const IPC_PROTOCOL: &str = "engram.managed-runtime-ipc.v1";
pub(crate) const LAUNCH_ABI: &str = "engram.managed-runtime-stdio.v1";
pub(crate) const CONFIGURATION_SCHEMA_ID: &str = "crebain.simulation.configuration.v1";
pub(crate) const PREPARE_OPERATION_ID: &str = "crebain.simulation.prepare.v1";
pub(crate) const PREPARE_REQUEST_SCHEMA_ID: &str = "crebain.simulation.prepare-request.v1";
pub(crate) const PREPARE_RESPONSE_SCHEMA_ID: &str = "crebain.simulation.prepare-response.v1";
pub(crate) const STEP_OPERATION_ID: &str = "crebain.simulation.step.v1";
pub(crate) const STEP_REQUEST_SCHEMA_ID: &str = "crebain.simulation.step-request.v1";
pub(crate) const STEP_RESPONSE_SCHEMA_ID: &str = "crebain.simulation.step-response.v1";
pub(crate) const FINISH_OPERATION_ID: &str = "crebain.simulation.finish.v1";
pub(crate) const FINISH_REQUEST_SCHEMA_ID: &str = "crebain.simulation.finish-request.v1";
pub(crate) const FINISH_RESPONSE_SCHEMA_ID: &str = "crebain.simulation.finish-response.v1";
pub(crate) const STANDARD_PREPARE_OPERATION_ID: &str = "crebain.simulation.prepare.v3";
pub(crate) const STANDARD_PREPARE_REQUEST_SCHEMA_ID: &str =
    "engram.closed-loop-simulator.prepare-request.v3";
pub(crate) const STANDARD_PREPARE_RESPONSE_SCHEMA_ID: &str =
    "engram.closed-loop-simulator.prepare-response.v3";
pub(crate) const STANDARD_STEP_OPERATION_ID: &str = "crebain.simulation.step.v3";
pub(crate) const STANDARD_STEP_REQUEST_SCHEMA_ID: &str =
    "engram.closed-loop-simulator.step-request.v3";
pub(crate) const STANDARD_STEP_RESPONSE_SCHEMA_ID: &str =
    "engram.closed-loop-simulator.step-response.v3";
pub(crate) const STANDARD_FINISH_OPERATION_ID: &str = "crebain.simulation.finish.v3";
pub(crate) const STANDARD_FINISH_REQUEST_SCHEMA_ID: &str =
    "engram.closed-loop-simulator.finish-request.v3";
pub(crate) const STANDARD_FINISH_RESPONSE_SCHEMA_ID: &str =
    "engram.closed-loop-simulator.finish-response.v3";

pub(crate) const CONFIGURATION_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/configuration.schema.json"
);
pub(crate) const IPC_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/managed-runtime-ipc.schema.json"
);
pub(crate) const PREPARE_REQUEST_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/prepare-request.schema.json"
);
pub(crate) const PREPARE_RESPONSE_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/prepare-response.schema.json"
);
pub(crate) const STEP_REQUEST_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/step-request.schema.json"
);
pub(crate) const STEP_RESPONSE_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/step-response.schema.json"
);
pub(crate) const FINISH_REQUEST_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/finish-request.schema.json"
);
pub(crate) const FINISH_RESPONSE_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/finish-response.schema.json"
);
pub(crate) const STANDARD_PREPARE_REQUEST_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/standard-v3-prepare-request.schema.json"
);
pub(crate) const STANDARD_PREPARE_RESPONSE_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/standard-v3-prepare-response.schema.json"
);
pub(crate) const STANDARD_STEP_REQUEST_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/standard-v3-step-request.schema.json"
);
pub(crate) const STANDARD_STEP_RESPONSE_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/standard-v3-step-response.schema.json"
);
pub(crate) const STANDARD_FINISH_REQUEST_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/standard-v3-finish-request.schema.json"
);
pub(crate) const STANDARD_FINISH_RESPONSE_SCHEMA_BYTES: &[u8] = include_bytes!(
    "../../../../integrations/engram/managed-simulation/contracts/standard-v3-finish-response.schema.json"
);

pub(crate) const MAX_DRONES: usize = 3;
pub(crate) const MAX_TICKS: u64 = 1_024;
pub(crate) const MAX_TICK_MS: u64 = 1_000;
pub(crate) const MAX_ACCELERATION_MPS2: f64 = 50.0;
pub(crate) const MAX_SPEED_MPS: f64 = 100.0;
pub(crate) const MAX_POSITION_ABS_M: f64 = 100_000.0;
pub(crate) const MAX_SENSOR_OFFSET_ABS_M: f64 = 50.0;
pub(crate) const MAX_SENSOR_VARIANCE_M2: f64 = 1_000_000.0;
pub(crate) const MAX_FRAME_BYTES: usize = 65_536;
pub(crate) const MAX_OPERATIONS_PER_GENERATION: u64 = MAX_TICKS + 2;
pub(crate) const MAX_GENERATION_CPU_TIME_MS: u64 = 600_000;
pub(crate) const AUTHORITY: &str = "simulator-only";
pub(crate) const STANDARD_PROFILE_SCHEMA_ID: &str = "crebain.standard-simulator-profile.v3";
pub(crate) const STANDARD_ROSTER_RULE: &str =
    "sorted-channel-order-to-contiguous-internal-drone-ids.v1";
pub(crate) const STANDARD_VECTOR_FLATTENING_RULE: &str =
    "channel-roster-order-then-declared-component-order.v1";
pub(crate) const STANDARD_TIC_UNIT: &str = "microsecond";
pub(crate) const STANDARD_CAUSALITY_POLICY: &str = "sample-runtime-run-controller-apply-zoh-v1";
pub(crate) const STANDARD_STEP_DURATION_TICS: u64 = 20_000;
pub(crate) const STANDARD_SUBJECT_KIND: &str = "simulated.drone";
pub(crate) const STANDARD_OBSERVATION_SPACE_ID: &str = "kinematics.position-velocity-enu-si";
pub(crate) const STANDARD_ACTION_SPACE_ID: &str = "kinematics.acceleration-enu-si";
pub(crate) const STANDARD_OBSERVATION_WIDTH: u64 = 6;
pub(crate) const STANDARD_ACTION_WIDTH: u64 = 3;
pub(crate) const MAX_STANDARD_FAULT_SCHEDULE_ENTRIES: usize = 64;
pub(crate) const STANDARD_OBSERVATION_COMPONENT_IDS: [&str; 6] = [
    "position.east",
    "position.north",
    "position.up",
    "velocity.east",
    "velocity.north",
    "velocity.up",
];
pub(crate) const STANDARD_OBSERVATION_UNIT_IDS: [&str; 6] = [
    "si.metre",
    "si.metre",
    "si.metre",
    "si.metre-per-second",
    "si.metre-per-second",
    "si.metre-per-second",
];
pub(crate) const STANDARD_ACTION_COMPONENT_IDS: [&str; 3] =
    ["acceleration.east", "acceleration.north", "acceleration.up"];
pub(crate) const STANDARD_ACTION_UNIT_IDS: [&str; 3] = [
    "si.metre-per-second-squared",
    "si.metre-per-second-squared",
    "si.metre-per-second-squared",
];

/// One recoverable simulator fault selected by the sealed standard profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StandardScheduledFault {
    SensorUnavailable,
}

/// One exact logical-step and channel-ordinal fault schedule entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardFaultScheduleEntry {
    pub step_index: u64,
    pub channel_ordinal: u64,
    pub fault_disposition: StandardScheduledFault,
}

/// Sealed deterministic defaults for the generic closed-loop simulator surface.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardSimulatorProfile {
    pub schema_version: String,
    pub tick_ms: u64,
    pub tic_unit: String,
    pub step_duration_tics: u64,
    pub causality_policy: String,
    pub roster_rule: String,
    pub vector_flattening_rule: String,
    pub internal_drone_id_prefix: String,
    pub internal_drone_id_start: u64,
    pub internal_drone_id_decimal_width: u64,
    pub initial_position_origin_m: Vec<f64>,
    pub initial_position_stride_m: Vec<f64>,
    pub initial_velocity_mps: Vec<f64>,
    pub sensor_variance_m2: Vec<f64>,
    pub safe_hold_output_acceleration_mps2: Vec<f64>,
    pub recoverable_fault_schedule: Vec<StandardFaultScheduleEntry>,
    pub subject_kind: String,
    pub observation_space_id: String,
    pub action_space_id: String,
    pub observation_width: u64,
    pub action_width: u64,
    pub observation_component_ids: Vec<String>,
    pub observation_unit_ids: Vec<String>,
    pub action_component_ids: Vec<String>,
    pub action_unit_ids: Vec<String>,
    pub simulator_only: bool,
}

impl StandardSimulatorProfile {
    pub(crate) fn validate(&self) -> bool {
        self.schema_version == STANDARD_PROFILE_SCHEMA_ID
            && self.tick_ms == 20
            && self.tic_unit == STANDARD_TIC_UNIT
            && self.step_duration_tics == STANDARD_STEP_DURATION_TICS
            && self
                .tick_ms
                .checked_mul(1_000)
                .is_some_and(|value| value == self.step_duration_tics)
            && self.causality_policy == STANDARD_CAUSALITY_POLICY
            && self.roster_rule == STANDARD_ROSTER_RULE
            && self.vector_flattening_rule == STANDARD_VECTOR_FLATTENING_RULE
            && self.internal_drone_id_prefix == "drone-"
            && self.internal_drone_id_start == 1
            && self.internal_drone_id_decimal_width == 2
            && finite_bounded(&self.initial_position_origin_m, MAX_POSITION_ABS_M)
            && self.initial_position_origin_m == [0.0, 0.0, 100.0]
            && finite_bounded(&self.initial_position_stride_m, MAX_POSITION_ABS_M)
            && self.initial_position_stride_m == [500.0, 0.0, 0.0]
            && finite_bounded(&self.initial_velocity_mps, MAX_SPEED_MPS)
            && self.initial_velocity_mps == [0.0, 0.0, 0.0]
            && finite_positive_bounded(&self.sensor_variance_m2, MAX_SENSOR_VARIANCE_M2)
            && self.sensor_variance_m2 == [1.0, 1.0, 1.0]
            && finite_bounded(
                &self.safe_hold_output_acceleration_mps2,
                MAX_ACCELERATION_MPS2,
            )
            && self.safe_hold_output_acceleration_mps2 == [0.0, 0.0, 0.0]
            && valid_standard_fault_schedule(&self.recoverable_fault_schedule)
            && self.subject_kind == STANDARD_SUBJECT_KIND
            && self.observation_space_id == STANDARD_OBSERVATION_SPACE_ID
            && self.action_space_id == STANDARD_ACTION_SPACE_ID
            && self.observation_width == STANDARD_OBSERVATION_WIDTH
            && self.action_width == STANDARD_ACTION_WIDTH
            && strings_equal(
                &self.observation_component_ids,
                &STANDARD_OBSERVATION_COMPONENT_IDS,
            )
            && strings_equal(&self.observation_unit_ids, &STANDARD_OBSERVATION_UNIT_IDS)
            && strings_equal(&self.action_component_ids, &STANDARD_ACTION_COMPONENT_IDS)
            && strings_equal(&self.action_unit_ids, &STANDARD_ACTION_UNIT_IDS)
            && self.simulator_only
    }
}

fn valid_standard_fault_schedule(entries: &[StandardFaultScheduleEntry]) -> bool {
    !entries.is_empty()
        && entries.len() <= MAX_STANDARD_FAULT_SCHEDULE_ENTRIES
        && entries.iter().all(|entry| {
            (1..=MAX_TICKS).contains(&entry.step_index)
                && (1..=MAX_DRONES as u64).contains(&entry.channel_ordinal)
        })
        && entries.windows(2).all(|pair| {
            (pair[0].step_index, pair[0].channel_ordinal)
                < (pair[1].step_index, pair[1].channel_ordinal)
        })
}

fn strings_equal<const N: usize>(actual: &[String], expected: &[&str; N]) -> bool {
    actual.len() == N
        && actual
            .iter()
            .zip(expected)
            .all(|(actual, expected)| actual == expected)
}

/// Fixed host-provided configuration for the simulation runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeConfiguration {
    pub schema_version: String,
    pub max_drones: u64,
    pub max_ticks: u64,
    pub max_tick_ms: u64,
    pub max_acceleration_mps2: f64,
    pub max_speed_mps: f64,
    pub max_position_abs_m: f64,
    pub max_sensor_offset_abs_m: f64,
    pub max_sensor_variance_m2: f64,
    pub standard_simulator_profile: StandardSimulatorProfile,
}

impl RuntimeConfiguration {
    pub(crate) fn validate(&self) -> bool {
        self.schema_version == CONFIGURATION_SCHEMA_ID
            && self.max_drones == MAX_DRONES as u64
            && self.max_ticks == MAX_TICKS
            && self.max_tick_ms == MAX_TICK_MS
            && self.max_acceleration_mps2 == MAX_ACCELERATION_MPS2
            && self.max_speed_mps == MAX_SPEED_MPS
            && self.max_position_abs_m == MAX_POSITION_ABS_M
            && self.max_sensor_offset_abs_m == MAX_SENSOR_OFFSET_ABS_M
            && self.max_sensor_variance_m2 == MAX_SENSOR_VARIANCE_M2
            && self.standard_simulator_profile.validate()
    }
}

/// Simulator-only fault behavior applied to one drone during one tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FaultCode {
    None,
    SensorDropout,
    ActuatorHold,
    Combined,
    Overload,
}

impl FaultCode {
    pub(crate) fn sensor_available(self) -> bool {
        !matches!(self, Self::SensorDropout | Self::Combined | Self::Overload)
    }

    pub(crate) fn actuator_available(self) -> bool {
        !matches!(self, Self::ActuatorHold | Self::Combined | Self::Overload)
    }
}

/// Prepare one deterministic simulation session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest {
    pub schema_version: String,
    pub run_id: String,
    pub drone_ids: Vec<String>,
    pub tick_ms: u64,
    pub max_ticks: u64,
    pub initial_position_m: Vec<f64>,
    pub initial_velocity_mps: Vec<f64>,
    pub sensor_variance_m2: Vec<f64>,
}

/// Advance every declared drone by one deterministic tick.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepRequest {
    pub schema_version: String,
    pub run_id: String,
    pub tick_index: u64,
    pub drone_ids: Vec<String>,
    pub actuator_intent_acceleration_mps2: Vec<f64>,
    pub sensor_offset_m: Vec<f64>,
    pub fault_codes: Vec<FaultCode>,
}

/// Finish the active domain session and clear all retained simulation state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinishRequest {
    pub schema_version: String,
    pub run_id: String,
    pub tick_index: u64,
    pub reason: String,
}

/// Project-level result classification inside a generic operation response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Succeeded,
    Rejected,
    Failed,
}

impl Outcome {
    pub(crate) fn ipc_status(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Rejected => "rejected",
            Self::Failed => "failed",
        }
    }
}

/// Complete finite output for a prepare or step operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SimulationFrameResponse {
    pub schema_version: String,
    pub outcome: Outcome,
    pub reason: String,
    pub authority: String,
    pub run_id: String,
    pub tick_index: u64,
    pub terminal: bool,
    pub drone_ids: Vec<String>,
    pub run_digest: String,
    pub prior_state_digest: String,
    pub state_digest: String,
    pub request_digest: String,
    pub receipt_digest: String,
    pub transcript_digest: String,
    pub simulated_position_m: Vec<f64>,
    pub simulated_velocity_mps: Vec<f64>,
    pub sensor_input_admitted: Vec<bool>,
    pub sensor_input_position_m: Vec<f64>,
    pub fused_estimate_available: Vec<bool>,
    pub fused_track_ids: Vec<String>,
    pub fused_position_m: Vec<f64>,
    pub fused_velocity_mps: Vec<f64>,
    pub actuator_intent_acceleration_mps2: Vec<f64>,
    pub actuator_output_acceleration_mps2: Vec<f64>,
    pub actuator_saturated: Vec<bool>,
    pub fault_codes: Vec<FaultCode>,
}

/// Prepare response alias with the prepare schema discriminator.
pub type PrepareResponse = SimulationFrameResponse;

/// Step response alias with the step schema discriminator.
pub type StepResponse = SimulationFrameResponse;

/// Terminal domain receipt emitted before the runtime clears session state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinishResponse {
    pub schema_version: String,
    pub outcome: Outcome,
    pub reason: String,
    pub authority: String,
    pub run_id: String,
    pub tick_index: u64,
    pub terminal: bool,
    pub drone_ids: Vec<String>,
    pub run_digest: String,
    pub state_digest: String,
    pub request_digest: String,
    pub receipt_digest: String,
    pub transcript_digest: String,
    pub step_count: u64,
    pub cleaned_up: bool,
}

pub(crate) fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && characters.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
}

pub(crate) fn finite_bounded(values: &[f64], bound: f64) -> bool {
    values
        .iter()
        .all(|value| value.is_finite() && value.abs() <= bound && !is_negative_zero(*value))
}

pub(crate) fn finite_positive_bounded(values: &[f64], bound: f64) -> bool {
    values.iter().all(|value| {
        value.is_finite() && *value > 0.0 && *value <= bound && !is_negative_zero(*value)
    })
}

fn is_negative_zero(value: f64) -> bool {
    value == 0.0 && value.is_sign_negative()
}
