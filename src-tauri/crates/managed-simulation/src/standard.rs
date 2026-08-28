//! Standard Host API closed-loop mapping for the CREBAIN simulation core.
//!
//! The mapping is transport-independent. It keeps Engram channel and subject
//! identifiers opaque, derives an internal stable drone roster from sorted
//! channel order, and applies only the sealed simulator profile.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::canonical::{canonical_json, sha256_bytes, sha256_domain, to_value};
use crate::contract::{
    finite_bounded, FaultCode, FinishRequest, Outcome, PrepareRequest, SimulationFrameResponse,
    StandardScheduledFault, StandardSimulatorProfile, StepRequest, MAX_ACCELERATION_MPS2,
    MAX_DRONES, MAX_POSITION_ABS_M, MAX_SPEED_MPS, MAX_TICKS, PREPARE_REQUEST_SCHEMA_ID,
    STANDARD_ACTION_WIDTH, STANDARD_CAUSALITY_POLICY, STANDARD_FINISH_REQUEST_SCHEMA_ID,
    STANDARD_FINISH_RESPONSE_SCHEMA_ID, STANDARD_OBSERVATION_WIDTH,
    STANDARD_PREPARE_REQUEST_SCHEMA_ID, STANDARD_PREPARE_RESPONSE_SCHEMA_ID,
    STANDARD_STEP_REQUEST_SCHEMA_ID, STANDARD_STEP_RESPONSE_SCHEMA_ID, STANDARD_TIC_UNIT,
};
use crate::simulation::{SimulationError, SimulationRuntime};

const STANDARD_INTERNAL_RUN_DOMAIN: &str = "crebain-standard-internal-run-v1";

/// One action disposition admitted by the generic host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StandardActionDisposition {
    BoundedNeuralProposal,
    SafeHold,
}

/// One simulator fault disposition returned to the generic host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StandardFaultDisposition {
    None,
    SensorUnavailable,
    ActuatorHold,
    Overload,
    Fatal,
}

/// Exact standard prepare request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardPrepareRequest {
    pub schema_version: String,
    pub study_run_id: String,
    pub closed_loop_definition_sha256: String,
    pub runtime_adapter_configuration_sha256: String,
    pub step_count: u64,
    pub tic_unit: String,
    pub causality_policy: String,
    pub step_duration_tics: u64,
    pub channel_ids: Vec<String>,
    pub subject_kinds: Vec<String>,
    pub subject_ids: Vec<String>,
    pub observation_space_ids: Vec<String>,
    pub action_space_ids: Vec<String>,
    pub observation_widths: Vec<u64>,
    pub action_widths: Vec<u64>,
    pub observation_component_ids: Vec<String>,
    pub observation_unit_ids: Vec<String>,
    pub action_component_ids: Vec<String>,
    pub action_unit_ids: Vec<String>,
    pub action_min_values: Vec<f64>,
    pub action_max_values: Vec<f64>,
    pub safe_action_values: Vec<f64>,
}

/// Exact standard prepare response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardPrepareResponse {
    pub schema_version: String,
    pub status: Outcome,
    pub reason: String,
    pub terminal: bool,
    pub study_run_id: String,
    pub closed_loop_definition_sha256: String,
    pub runtime_adapter_configuration_sha256: String,
    pub step_index: u64,
    pub tic_unit: String,
    pub causality_policy: String,
    pub step_duration_tics: u64,
    pub simulation_time_tics: u64,
    pub channel_ids: Vec<String>,
    pub subject_ids: Vec<String>,
    pub observation_widths: Vec<u64>,
    pub observation_present: Vec<bool>,
    pub observation_values: Vec<f64>,
    pub fault_dispositions: Vec<StandardFaultDisposition>,
    pub fault_codes: Vec<String>,
    pub run_state_active: bool,
}

/// Exact standard step request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardStepRequest {
    pub schema_version: String,
    pub study_run_id: String,
    pub step_index: u64,
    pub step_id: String,
    pub source_snapshot_sha256: String,
    pub runtime_request_sha256: String,
    pub tic_unit: String,
    pub causality_policy: String,
    pub step_duration_tics: u64,
    pub source_simulation_time_tics: u64,
    pub target_simulation_time_tics: u64,
    pub channel_ids: Vec<String>,
    pub subject_ids: Vec<String>,
    pub action_widths: Vec<u64>,
    pub action_values: Vec<f64>,
    pub saturated_values: Vec<bool>,
    pub action_dispositions: Vec<StandardActionDisposition>,
}

/// Exact standard step response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardStepResponse {
    pub schema_version: String,
    pub status: Outcome,
    pub reason: String,
    pub terminal: bool,
    pub study_run_id: String,
    pub step_index: u64,
    pub step_id: String,
    pub source_snapshot_sha256: String,
    pub runtime_request_sha256: String,
    pub tic_unit: String,
    pub causality_policy: String,
    pub step_duration_tics: u64,
    pub simulation_time_tics: u64,
    pub channel_ids: Vec<String>,
    pub subject_ids: Vec<String>,
    pub observation_widths: Vec<u64>,
    pub observation_present: Vec<bool>,
    pub observation_values: Vec<f64>,
    pub fault_dispositions: Vec<StandardFaultDisposition>,
    pub fault_codes: Vec<String>,
    pub run_state_active: bool,
}

/// Exact standard finish request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardFinishRequest {
    pub schema_version: String,
    pub study_run_id: String,
    pub final_step_index: u64,
    pub final_snapshot_sha256: String,
    pub tic_unit: String,
    pub causality_policy: String,
    pub step_duration_tics: u64,
    pub final_simulation_time_tics: u64,
    pub reason: String,
}

/// Exact standard finish response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StandardFinishResponse {
    pub schema_version: String,
    pub status: Outcome,
    pub reason: String,
    pub terminal: bool,
    pub study_run_id: String,
    pub final_step_index: u64,
    pub final_snapshot_sha256: String,
    pub tic_unit: String,
    pub causality_policy: String,
    pub step_duration_tics: u64,
    pub final_simulation_time_tics: u64,
    pub run_state_cleared: bool,
}

/// Fail-closed mapping error before any standard response is framed.
#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum StandardSimulationError {
    #[error("the sealed standard simulator profile is invalid")]
    InvalidProfile,
    #[error("the standard simulator request is invalid")]
    InvalidInput,
    #[error("a standard simulator run is already active or terminal")]
    RunAlreadyActive,
    #[error("there is no active standard simulator run")]
    NoActiveRun,
    #[error("standard simulator lineage differs from the active run")]
    LineageMismatch,
    #[error("standard simulator roster differs from the active run")]
    RosterMismatch,
    #[error("standard simulator vector width is unsupported")]
    WidthMismatch,
    #[error("standard simulator component or unit semantics differ from the sealed profile")]
    SemanticMismatch,
    #[error("standard simulator logical time differs from the sealed schedule")]
    ClockMismatch,
    #[error("standard simulator action is outside the prepared bounds")]
    ActionBounds,
    #[error("standard simulator safe hold differs from the prepared safe action")]
    SafeHoldMismatch,
    #[error("the CREBAIN simulation core rejected the mapped request")]
    CoreRejected,
}

impl StandardSimulationError {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::InvalidProfile => "standard.invalid-profile",
            Self::InvalidInput => "standard.invalid-input",
            Self::RunAlreadyActive => "standard.run-already-active",
            Self::NoActiveRun => "standard.no-active-run",
            Self::LineageMismatch => "standard.lineage-mismatch",
            Self::RosterMismatch => "standard.roster-mismatch",
            Self::WidthMismatch => "standard.width-mismatch",
            Self::SemanticMismatch => "standard.semantic-mismatch",
            Self::ClockMismatch => "standard.clock-mismatch",
            Self::ActionBounds => "standard.action-bounds",
            Self::SafeHoldMismatch => "standard.safe-hold-mismatch",
            Self::CoreRejected => "standard.core-rejected",
        }
    }
}

#[derive(Debug)]
struct StandardSession {
    study_run_id: String,
    internal_run_id: String,
    internal_drone_ids: Vec<String>,
    step_count: u64,
    step_index: u64,
    step_duration_tics: u64,
    channel_ids: Vec<String>,
    subject_ids: Vec<String>,
    observation_widths: Vec<u64>,
    action_widths: Vec<u64>,
    action_min_values: Vec<f64>,
    action_max_values: Vec<f64>,
    safe_action_values: Vec<f64>,
    seen_step_ids: HashSet<String>,
    seen_runtime_request_sha256: HashSet<String>,
    seen_source_snapshot_sha256: HashSet<String>,
}

/// Transport-independent standard adapter over the deterministic CREBAIN core.
pub struct StandardSimulationRuntime {
    profile: StandardSimulatorProfile,
    configuration_sha256: String,
    core: SimulationRuntime,
    session: Option<StandardSession>,
    terminal: bool,
}

impl StandardSimulationRuntime {
    /// Construct one idle adapter from the exact sealed profile identity.
    ///
    /// # Errors
    ///
    /// Returns [`StandardSimulationError::InvalidProfile`] when the profile or
    /// configuration identity differs from the supported closed contract.
    pub fn new(
        profile: StandardSimulatorProfile,
        configuration_sha256: String,
    ) -> Result<Self, StandardSimulationError> {
        if !profile.validate() || !valid_sha256(&configuration_sha256) {
            return Err(StandardSimulationError::InvalidProfile);
        }
        Ok(Self {
            profile,
            configuration_sha256,
            core: SimulationRuntime::new(),
            session: None,
            terminal: false,
        })
    }

    /// Prepare a deterministic one-to-three-channel simulation.
    ///
    /// # Errors
    ///
    /// Rejects unsupported spaces, widths, rosters, bounds, and lineage before
    /// it creates any simulator state.
    pub fn prepare(
        &mut self,
        request: StandardPrepareRequest,
    ) -> Result<StandardPrepareResponse, StandardSimulationError> {
        if self.session.is_some() || self.terminal {
            return Err(StandardSimulationError::RunAlreadyActive);
        }
        validate_prepare(&request, &self.profile, &self.configuration_sha256)?;
        let internal_run_id = internal_run_id(&request.study_run_id);
        let internal_drone_ids = internal_drone_ids(&self.profile, request.channel_ids.len())?;
        let positions = initial_positions(&self.profile, request.channel_ids.len());
        let internal = PrepareRequest {
            schema_version: PREPARE_REQUEST_SCHEMA_ID.to_string(),
            run_id: internal_run_id.clone(),
            drone_ids: internal_drone_ids.clone(),
            tick_ms: self.profile.tick_ms,
            max_ticks: request.step_count,
            initial_position_m: positions,
            initial_velocity_mps: self
                .profile
                .initial_velocity_mps
                .repeat(request.channel_ids.len()),
            sensor_variance_m2: self
                .profile
                .sensor_variance_m2
                .repeat(request.channel_ids.len()),
        };
        let frame = self
            .core
            .prepare(internal)
            .map_err(|_| StandardSimulationError::CoreRejected)?;
        if frame.outcome != Outcome::Succeeded {
            return Err(StandardSimulationError::CoreRejected);
        }
        let response = prepare_response(&request, &frame)?;
        self.session = Some(StandardSession {
            study_run_id: request.study_run_id,
            internal_run_id,
            internal_drone_ids,
            step_count: request.step_count,
            step_index: 0,
            step_duration_tics: request.step_duration_tics,
            channel_ids: request.channel_ids,
            subject_ids: request.subject_ids,
            observation_widths: request.observation_widths,
            action_widths: request.action_widths,
            action_min_values: request.action_min_values,
            action_max_values: request.action_max_values,
            safe_action_values: request.safe_action_values,
            seen_step_ids: HashSet::new(),
            seen_runtime_request_sha256: HashSet::new(),
            seen_source_snapshot_sha256: HashSet::new(),
        });
        Ok(response)
    }

    /// Advance the exact prepared roster by one deterministic tick.
    ///
    /// # Errors
    ///
    /// Rejects lineage, roster, vector, bounds, replay, and safe-hold drift
    /// before the CREBAIN core mutates its state.
    pub fn step(
        &mut self,
        request: StandardStepRequest,
    ) -> Result<StandardStepResponse, StandardSimulationError> {
        let session = self
            .session
            .as_mut()
            .ok_or(StandardSimulationError::NoActiveRun)?;
        validate_step(&request, session)?;
        // Host action disposition is not simulator fault authority. Only the
        // sealed, configuration-bound schedule can create a standard fault.
        let fault_codes = scheduled_fault_codes(
            &self.profile,
            request.step_index,
            request.action_dispositions.len(),
        );
        let internal = StepRequest {
            schema_version: crate::contract::STEP_REQUEST_SCHEMA_ID.to_string(),
            run_id: session.internal_run_id.clone(),
            tick_index: request.step_index,
            drone_ids: session.internal_drone_ids.clone(),
            actuator_intent_acceleration_mps2: request.action_values.clone(),
            sensor_offset_m: vec![0.0; request.action_values.len()],
            fault_codes,
        };
        let frame = self
            .core
            .step(internal)
            .map_err(|_| StandardSimulationError::CoreRejected)?;
        if frame.outcome != Outcome::Succeeded {
            self.terminal = frame.terminal;
            return Err(StandardSimulationError::CoreRejected);
        }
        let response = step_response(&request, session, &frame)?;
        session.step_index = request.step_index;
        session.seen_step_ids.insert(request.step_id);
        session
            .seen_runtime_request_sha256
            .insert(request.runtime_request_sha256);
        session
            .seen_source_snapshot_sha256
            .insert(request.source_snapshot_sha256);
        Ok(response)
    }

    /// Finish the exact active standard run and clear its retained state.
    ///
    /// # Errors
    ///
    /// Rejects run, step, snapshot-shape, or completion drift before cleanup.
    pub fn finish(
        &mut self,
        request: StandardFinishRequest,
    ) -> Result<StandardFinishResponse, StandardSimulationError> {
        let session = self
            .session
            .as_ref()
            .ok_or(StandardSimulationError::NoActiveRun)?;
        validate_finish(&request, session)?;
        let internal = FinishRequest {
            schema_version: crate::contract::FINISH_REQUEST_SCHEMA_ID.to_string(),
            run_id: session.internal_run_id.clone(),
            tick_index: request.final_step_index,
            reason: "completed".to_string(),
        };
        let response = self
            .core
            .finish(internal)
            .map_err(|_| StandardSimulationError::CoreRejected)?;
        if response.outcome != Outcome::Succeeded || !response.cleaned_up {
            return Err(StandardSimulationError::CoreRejected);
        }
        self.session = None;
        self.terminal = true;
        Ok(StandardFinishResponse {
            schema_version: STANDARD_FINISH_RESPONSE_SCHEMA_ID.to_string(),
            status: Outcome::Succeeded,
            reason: "finished".to_string(),
            terminal: true,
            study_run_id: request.study_run_id,
            final_step_index: request.final_step_index,
            final_snapshot_sha256: request.final_snapshot_sha256,
            tic_unit: request.tic_unit,
            causality_policy: request.causality_policy,
            step_duration_tics: request.step_duration_tics,
            final_simulation_time_tics: request.final_simulation_time_tics,
            run_state_cleared: true,
        })
    }

    /// Clear all retained adapter and simulation state.
    pub fn abort(&mut self) {
        self.core.abort();
        self.session = None;
        self.terminal = true;
    }
}

impl Drop for StandardSimulationRuntime {
    fn drop(&mut self) {
        self.abort();
    }
}

fn validate_prepare(
    request: &StandardPrepareRequest,
    profile: &StandardSimulatorProfile,
    configuration_sha256: &str,
) -> Result<(), StandardSimulationError> {
    let count = request.channel_ids.len();
    if request.schema_version != STANDARD_PREPARE_REQUEST_SCHEMA_ID
        || !valid_entity_id(&request.study_run_id)
        || !valid_sha256(&request.closed_loop_definition_sha256)
        || request.runtime_adapter_configuration_sha256 != configuration_sha256
        || !(1..=MAX_TICKS).contains(&request.step_count)
        || !(1..=MAX_DRONES).contains(&count)
        || !sorted_unique_entity_ids(&request.channel_ids)
        || request.subject_kinds.len() != count
        || request.subject_ids.len() != count
        || request.observation_space_ids.len() != count
        || request.action_space_ids.len() != count
        || request.observation_widths.len() != count
        || request.action_widths.len() != count
        || request
            .subject_ids
            .iter()
            .any(|value| !valid_entity_id(value))
        || !unique_subjects(&request.subject_kinds, &request.subject_ids)
    {
        return Err(StandardSimulationError::InvalidInput);
    }
    if request.tic_unit != profile.tic_unit
        || request.causality_policy != profile.causality_policy
        || request.step_duration_tics != profile.step_duration_tics
    {
        return Err(StandardSimulationError::ClockMismatch);
    }
    if request
        .subject_kinds
        .iter()
        .any(|value| value != &profile.subject_kind)
        || request
            .observation_space_ids
            .iter()
            .any(|value| value != &profile.observation_space_id)
        || request
            .action_space_ids
            .iter()
            .any(|value| value != &profile.action_space_id)
        || !repeated_strings_equal(
            &request.observation_component_ids,
            &profile.observation_component_ids,
            count,
        )
        || !repeated_strings_equal(
            &request.observation_unit_ids,
            &profile.observation_unit_ids,
            count,
        )
        || !repeated_strings_equal(
            &request.action_component_ids,
            &profile.action_component_ids,
            count,
        )
        || !repeated_strings_equal(&request.action_unit_ids, &profile.action_unit_ids, count)
    {
        return Err(StandardSimulationError::SemanticMismatch);
    }
    if request
        .observation_widths
        .iter()
        .any(|width| *width != profile.observation_width)
        || request
            .action_widths
            .iter()
            .any(|width| *width != profile.action_width)
    {
        return Err(StandardSimulationError::WidthMismatch);
    }
    let action_scalar_count = count
        .checked_mul(profile.action_width as usize)
        .ok_or(StandardSimulationError::WidthMismatch)?;
    let observation_scalar_count = count
        .checked_mul(profile.observation_width as usize)
        .ok_or(StandardSimulationError::WidthMismatch)?;
    if request.observation_component_ids.len() != observation_scalar_count
        || request.observation_unit_ids.len() != observation_scalar_count
        || request.action_component_ids.len() != action_scalar_count
        || request.action_unit_ids.len() != action_scalar_count
        || request.action_min_values.len() != action_scalar_count
        || request.action_max_values.len() != action_scalar_count
        || request.safe_action_values.len() != action_scalar_count
        || !finite_bounded(&request.action_min_values, MAX_ACCELERATION_MPS2)
        || !finite_bounded(&request.action_max_values, MAX_ACCELERATION_MPS2)
        || !finite_bounded(&request.safe_action_values, MAX_ACCELERATION_MPS2)
    {
        return Err(StandardSimulationError::WidthMismatch);
    }
    for ((lower, upper), safe) in request
        .action_min_values
        .iter()
        .zip(&request.action_max_values)
        .zip(&request.safe_action_values)
    {
        if lower >= upper || safe < lower || safe > upper {
            return Err(StandardSimulationError::ActionBounds);
        }
    }
    let expected_safe = profile.safe_hold_output_acceleration_mps2.repeat(count);
    if request.safe_action_values != expected_safe {
        return Err(StandardSimulationError::SafeHoldMismatch);
    }
    Ok(())
}

fn validate_step(
    request: &StandardStepRequest,
    session: &StandardSession,
) -> Result<(), StandardSimulationError> {
    if request.schema_version != STANDARD_STEP_REQUEST_SCHEMA_ID
        || !valid_entity_id(&request.study_run_id)
        || !valid_sha256(&request.source_snapshot_sha256)
        || !valid_sha256(&request.runtime_request_sha256)
    {
        return Err(StandardSimulationError::InvalidInput);
    }
    if request.step_id != standard_step_id(&request.study_run_id, request.step_index)?
        || request.study_run_id != session.study_run_id
        || request.step_index != session.step_index + 1
        || request.step_index > session.step_count
        || session.seen_step_ids.contains(&request.step_id)
        || session
            .seen_runtime_request_sha256
            .contains(&request.runtime_request_sha256)
        || session
            .seen_source_snapshot_sha256
            .contains(&request.source_snapshot_sha256)
    {
        return Err(StandardSimulationError::LineageMismatch);
    }
    let expected_source_time =
        simulation_time_tics(session.step_index, session.step_duration_tics)?;
    let expected_target_time =
        simulation_time_tics(request.step_index, session.step_duration_tics)?;
    if request.tic_unit != STANDARD_TIC_UNIT
        || request.causality_policy != STANDARD_CAUSALITY_POLICY
        || request.step_duration_tics != session.step_duration_tics
        || request.source_simulation_time_tics != expected_source_time
        || request.target_simulation_time_tics != expected_target_time
    {
        return Err(StandardSimulationError::ClockMismatch);
    }
    if request.channel_ids != session.channel_ids || request.subject_ids != session.subject_ids {
        return Err(StandardSimulationError::RosterMismatch);
    }
    if request.action_widths != session.action_widths
        || request.action_values.len() != session.action_min_values.len()
        || request.saturated_values.len() != request.action_values.len()
        || request.action_dispositions.len() != session.channel_ids.len()
    {
        return Err(StandardSimulationError::WidthMismatch);
    }
    if !finite_bounded(&request.action_values, MAX_ACCELERATION_MPS2) {
        return Err(StandardSimulationError::ActionBounds);
    }
    for (index, ((value, lower), upper)) in request
        .action_values
        .iter()
        .zip(&session.action_min_values)
        .zip(&session.action_max_values)
        .enumerate()
    {
        if value < lower || value > upper {
            return Err(StandardSimulationError::ActionBounds);
        }
        let channel = index / STANDARD_ACTION_WIDTH as usize;
        if session.action_disposition_is_safe_hold(request, channel)
            && (*value != session.safe_action_values[index] || request.saturated_values[index])
        {
            return Err(StandardSimulationError::SafeHoldMismatch);
        }
    }
    Ok(())
}

impl StandardSession {
    fn action_disposition_is_safe_hold(
        &self,
        request: &StandardStepRequest,
        channel: usize,
    ) -> bool {
        request.action_dispositions[channel] == StandardActionDisposition::SafeHold
    }
}

fn validate_finish(
    request: &StandardFinishRequest,
    session: &StandardSession,
) -> Result<(), StandardSimulationError> {
    if request.schema_version != STANDARD_FINISH_REQUEST_SCHEMA_ID
        || !valid_entity_id(&request.study_run_id)
        || request.reason != "completed"
        || !valid_sha256(&request.final_snapshot_sha256)
    {
        return Err(StandardSimulationError::InvalidInput);
    }
    let expected_final_time =
        simulation_time_tics(request.final_step_index, session.step_duration_tics)?;
    if request.tic_unit != STANDARD_TIC_UNIT
        || request.causality_policy != STANDARD_CAUSALITY_POLICY
        || request.step_duration_tics != session.step_duration_tics
        || request.final_simulation_time_tics != expected_final_time
    {
        return Err(StandardSimulationError::ClockMismatch);
    }
    if request.study_run_id != session.study_run_id
        || request.final_step_index != session.step_index
        || request.final_step_index != session.step_count
    {
        return Err(StandardSimulationError::LineageMismatch);
    }
    Ok(())
}

fn simulation_time_tics(
    step_index: u64,
    step_duration_tics: u64,
) -> Result<u64, StandardSimulationError> {
    step_index
        .checked_mul(step_duration_tics)
        .ok_or(StandardSimulationError::ClockMismatch)
}

fn repeated_strings_equal(actual: &[String], expected: &[String], count: usize) -> bool {
    !expected.is_empty()
        && expected
            .len()
            .checked_mul(count)
            .is_some_and(|length| length == actual.len())
        && actual
            .chunks_exact(expected.len())
            .all(|chunk| chunk == expected)
}

#[cfg(test)]
fn repeat_strings(values: &[String], count: usize) -> Vec<String> {
    (0..count).flat_map(|_| values.iter().cloned()).collect()
}

fn prepare_response(
    request: &StandardPrepareRequest,
    frame: &SimulationFrameResponse,
) -> Result<StandardPrepareResponse, StandardSimulationError> {
    let observation = project_observations(frame, request.channel_ids.len())?;
    Ok(StandardPrepareResponse {
        schema_version: STANDARD_PREPARE_RESPONSE_SCHEMA_ID.to_string(),
        status: frame.outcome,
        reason: frame.reason.clone(),
        terminal: frame.terminal,
        study_run_id: request.study_run_id.clone(),
        closed_loop_definition_sha256: request.closed_loop_definition_sha256.clone(),
        runtime_adapter_configuration_sha256: request.runtime_adapter_configuration_sha256.clone(),
        step_index: 0,
        tic_unit: request.tic_unit.clone(),
        causality_policy: request.causality_policy.clone(),
        step_duration_tics: request.step_duration_tics,
        simulation_time_tics: 0,
        channel_ids: request.channel_ids.clone(),
        subject_ids: request.subject_ids.clone(),
        observation_widths: request.observation_widths.clone(),
        observation_present: observation.present,
        observation_values: observation.values,
        fault_dispositions: observation.dispositions,
        fault_codes: observation.codes,
        run_state_active: frame.outcome == Outcome::Succeeded && !frame.terminal,
    })
}

fn step_response(
    request: &StandardStepRequest,
    session: &StandardSession,
    frame: &SimulationFrameResponse,
) -> Result<StandardStepResponse, StandardSimulationError> {
    let observation = project_observations(frame, session.channel_ids.len())?;
    Ok(StandardStepResponse {
        schema_version: STANDARD_STEP_RESPONSE_SCHEMA_ID.to_string(),
        status: frame.outcome,
        reason: frame.reason.clone(),
        terminal: frame.terminal,
        study_run_id: request.study_run_id.clone(),
        step_index: request.step_index,
        step_id: request.step_id.clone(),
        source_snapshot_sha256: request.source_snapshot_sha256.clone(),
        runtime_request_sha256: request.runtime_request_sha256.clone(),
        tic_unit: request.tic_unit.clone(),
        causality_policy: request.causality_policy.clone(),
        step_duration_tics: request.step_duration_tics,
        simulation_time_tics: request.target_simulation_time_tics,
        channel_ids: session.channel_ids.clone(),
        subject_ids: session.subject_ids.clone(),
        observation_widths: session.observation_widths.clone(),
        observation_present: observation.present,
        observation_values: observation.values,
        fault_dispositions: observation.dispositions,
        fault_codes: observation.codes,
        run_state_active: frame.outcome == Outcome::Succeeded && !frame.terminal,
    })
}

struct ObservationProjection {
    present: Vec<bool>,
    values: Vec<f64>,
    dispositions: Vec<StandardFaultDisposition>,
    codes: Vec<String>,
}

fn project_observations(
    frame: &SimulationFrameResponse,
    channel_count: usize,
) -> Result<ObservationProjection, StandardSimulationError> {
    if frame.drone_ids.len() != channel_count
        || frame.fused_estimate_available.len() != channel_count
        || frame.fused_position_m.len() != channel_count * 3
        || frame.fused_velocity_mps.len() != channel_count * 3
        || frame.fault_codes.len() != channel_count
        || !finite_bounded(&frame.fused_position_m, MAX_POSITION_ABS_M)
        || !finite_bounded(&frame.fused_velocity_mps, MAX_SPEED_MPS)
    {
        return Err(StandardSimulationError::CoreRejected);
    }
    let mut values = Vec::with_capacity(channel_count * STANDARD_OBSERVATION_WIDTH as usize);
    for index in 0..channel_count {
        let offset = index * 3;
        values.extend_from_slice(&frame.fused_position_m[offset..offset + 3]);
        values.extend_from_slice(&frame.fused_velocity_mps[offset..offset + 3]);
    }
    let mut dispositions = Vec::with_capacity(channel_count);
    let mut codes = Vec::with_capacity(channel_count);
    for fault in &frame.fault_codes {
        let (disposition, code) = match fault {
            FaultCode::None => (StandardFaultDisposition::None, "none"),
            FaultCode::SensorDropout | FaultCode::Combined => (
                StandardFaultDisposition::SensorUnavailable,
                "sensor-unavailable",
            ),
            FaultCode::ActuatorHold => {
                (StandardFaultDisposition::ActuatorHold, "actuator.safe-hold")
            }
            FaultCode::Overload => (StandardFaultDisposition::Overload, "overload"),
        };
        dispositions.push(disposition);
        codes.push(code.to_string());
    }
    let present = frame
        .fused_estimate_available
        .iter()
        .zip(&frame.fault_codes)
        .map(|(available, fault)| {
            *available
                && !matches!(
                    fault,
                    FaultCode::SensorDropout | FaultCode::Combined | FaultCode::Overload
                )
        })
        .collect();
    Ok(ObservationProjection {
        present,
        values,
        dispositions,
        codes,
    })
}

fn scheduled_fault_codes(
    profile: &StandardSimulatorProfile,
    step_index: u64,
    channel_count: usize,
) -> Vec<FaultCode> {
    let mut faults = vec![FaultCode::None; channel_count];
    for entry in profile
        .recoverable_fault_schedule
        .iter()
        .filter(|entry| entry.step_index == step_index)
    {
        let Some(channel_index) = entry
            .channel_ordinal
            .checked_sub(1)
            .and_then(|value| usize::try_from(value).ok())
        else {
            continue;
        };
        if channel_index >= channel_count {
            continue;
        }
        faults[channel_index] = match entry.fault_disposition {
            StandardScheduledFault::SensorUnavailable => FaultCode::SensorDropout,
        };
    }
    faults
}

fn valid_entity_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn sorted_unique_entity_ids(values: &[String]) -> bool {
    values.iter().all(|value| valid_entity_id(value))
        && values.windows(2).all(|pair| pair[0] < pair[1])
}

fn unique_subjects(kinds: &[String], ids: &[String]) -> bool {
    let subjects: HashSet<(&str, &str)> = kinds
        .iter()
        .zip(ids)
        .map(|(kind, id)| (kind.as_str(), id.as_str()))
        .collect();
    subjects.len() == kinds.len()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn internal_run_id(study_run_id: &str) -> String {
    let digest = sha256_domain(STANDARD_INTERNAL_RUN_DOMAIN, &[study_run_id.as_bytes()]);
    format!("s{}", &digest[..63])
}

pub(crate) fn standard_step_id(
    study_run_id: &str,
    step_index: u64,
) -> Result<String, StandardSimulationError> {
    #[derive(Serialize)]
    struct StepIdentity<'a> {
        domain: &'static str,
        run_id: &'a str,
        step_index: u64,
    }

    let value = to_value(&StepIdentity {
        domain: "engram-extension-closed-loop-step-v2",
        run_id: study_run_id,
        step_index,
    })
    .map_err(|_| StandardSimulationError::InvalidInput)?;
    let canonical = canonical_json(&value).map_err(|_| StandardSimulationError::InvalidInput)?;
    let digest = sha256_bytes(&canonical);
    Ok(format!("step_{}", &digest[..32]))
}

fn internal_drone_ids(
    profile: &StandardSimulatorProfile,
    count: usize,
) -> Result<Vec<String>, StandardSimulationError> {
    (0..count)
        .map(|index| {
            let ordinal = profile
                .internal_drone_id_start
                .checked_add(index as u64)
                .ok_or(StandardSimulationError::InvalidProfile)?;
            Ok(format!(
                "{}{:0width$}",
                profile.internal_drone_id_prefix,
                ordinal,
                width = profile.internal_drone_id_decimal_width as usize
            ))
        })
        .collect()
}

fn initial_positions(profile: &StandardSimulatorProfile, count: usize) -> Vec<f64> {
    (0..count)
        .flat_map(|index| {
            let index = index as f64;
            (0..3).map(move |axis| {
                profile.initial_position_origin_m[axis]
                    + profile.initial_position_stride_m[axis] * index
            })
        })
        .collect()
}

impl From<SimulationError> for StandardSimulationError {
    fn from(_: SimulationError) -> Self {
        Self::CoreRejected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{
        StandardFaultScheduleEntry, STANDARD_ACTION_COMPONENT_IDS, STANDARD_ACTION_SPACE_ID,
        STANDARD_ACTION_UNIT_IDS, STANDARD_CAUSALITY_POLICY, STANDARD_OBSERVATION_COMPONENT_IDS,
        STANDARD_OBSERVATION_SPACE_ID, STANDARD_OBSERVATION_UNIT_IDS, STANDARD_PROFILE_SCHEMA_ID,
        STANDARD_ROSTER_RULE, STANDARD_STEP_DURATION_TICS, STANDARD_SUBJECT_KIND,
        STANDARD_TIC_UNIT, STANDARD_VECTOR_FLATTENING_RULE,
    };

    fn profile() -> StandardSimulatorProfile {
        StandardSimulatorProfile {
            schema_version: STANDARD_PROFILE_SCHEMA_ID.to_string(),
            tick_ms: 20,
            tic_unit: STANDARD_TIC_UNIT.to_string(),
            step_duration_tics: STANDARD_STEP_DURATION_TICS,
            causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
            roster_rule: STANDARD_ROSTER_RULE.to_string(),
            vector_flattening_rule: STANDARD_VECTOR_FLATTENING_RULE.to_string(),
            internal_drone_id_prefix: "drone-".to_string(),
            internal_drone_id_start: 1,
            internal_drone_id_decimal_width: 2,
            initial_position_origin_m: vec![0.0, 0.0, 100.0],
            initial_position_stride_m: vec![500.0, 0.0, 0.0],
            initial_velocity_mps: vec![0.0; 3],
            sensor_variance_m2: vec![1.0; 3],
            safe_hold_output_acceleration_mps2: vec![0.0; 3],
            recoverable_fault_schedule: vec![StandardFaultScheduleEntry {
                step_index: 3,
                channel_ordinal: 1,
                fault_disposition: StandardScheduledFault::SensorUnavailable,
            }],
            subject_kind: STANDARD_SUBJECT_KIND.to_string(),
            observation_space_id: STANDARD_OBSERVATION_SPACE_ID.to_string(),
            action_space_id: STANDARD_ACTION_SPACE_ID.to_string(),
            observation_width: STANDARD_OBSERVATION_WIDTH,
            action_width: STANDARD_ACTION_WIDTH,
            observation_component_ids: STANDARD_OBSERVATION_COMPONENT_IDS
                .map(str::to_string)
                .to_vec(),
            observation_unit_ids: STANDARD_OBSERVATION_UNIT_IDS.map(str::to_string).to_vec(),
            action_component_ids: STANDARD_ACTION_COMPONENT_IDS.map(str::to_string).to_vec(),
            action_unit_ids: STANDARD_ACTION_UNIT_IDS.map(str::to_string).to_vec(),
            simulator_only: true,
        }
    }

    fn prepare_request(count: usize) -> StandardPrepareRequest {
        StandardPrepareRequest {
            schema_version: STANDARD_PREPARE_REQUEST_SCHEMA_ID.to_string(),
            study_run_id: "study-run-standard-01".to_string(),
            closed_loop_definition_sha256: "a".repeat(64),
            runtime_adapter_configuration_sha256: "b".repeat(64),
            step_count: 2,
            tic_unit: STANDARD_TIC_UNIT.to_string(),
            causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
            step_duration_tics: STANDARD_STEP_DURATION_TICS,
            channel_ids: (1..=count)
                .map(|index| format!("channel-{index:02}"))
                .collect(),
            subject_kinds: vec![STANDARD_SUBJECT_KIND.to_string(); count],
            subject_ids: (1..=count)
                .map(|index| format!("subject-{index:02}"))
                .collect(),
            observation_space_ids: vec![STANDARD_OBSERVATION_SPACE_ID.to_string(); count],
            action_space_ids: vec![STANDARD_ACTION_SPACE_ID.to_string(); count],
            observation_widths: vec![STANDARD_OBSERVATION_WIDTH; count],
            action_widths: vec![STANDARD_ACTION_WIDTH; count],
            observation_component_ids: repeat_strings(&profile().observation_component_ids, count),
            observation_unit_ids: repeat_strings(&profile().observation_unit_ids, count),
            action_component_ids: repeat_strings(&profile().action_component_ids, count),
            action_unit_ids: repeat_strings(&profile().action_unit_ids, count),
            action_min_values: vec![-10.0; count * 3],
            action_max_values: vec![10.0; count * 3],
            safe_action_values: vec![0.0; count * 3],
        }
    }

    fn step_request(count: usize, step_index: u64) -> StandardStepRequest {
        StandardStepRequest {
            schema_version: STANDARD_STEP_REQUEST_SCHEMA_ID.to_string(),
            study_run_id: "study-run-standard-01".to_string(),
            step_index,
            step_id: standard_step_id("study-run-standard-01", step_index)
                .expect("fixture step identity derives"),
            source_snapshot_sha256: format!("{step_index:064x}"),
            runtime_request_sha256: format!("{:064x}", step_index + 2_048),
            tic_unit: STANDARD_TIC_UNIT.to_string(),
            causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
            step_duration_tics: STANDARD_STEP_DURATION_TICS,
            source_simulation_time_tics: (step_index - 1) * STANDARD_STEP_DURATION_TICS,
            target_simulation_time_tics: step_index * STANDARD_STEP_DURATION_TICS,
            channel_ids: (1..=count)
                .map(|index| format!("channel-{index:02}"))
                .collect(),
            subject_ids: (1..=count)
                .map(|index| format!("subject-{index:02}"))
                .collect(),
            action_widths: vec![STANDARD_ACTION_WIDTH; count],
            action_values: vec![1.0; count * 3],
            saturated_values: vec![false; count * 3],
            action_dispositions: vec![StandardActionDisposition::BoundedNeuralProposal; count],
        }
    }

    fn runtime() -> StandardSimulationRuntime {
        StandardSimulationRuntime::new(profile(), "b".repeat(64)).expect("fixture profile is valid")
    }

    const TRAJECTORY_STEPS: u64 = 160;
    const FAULT_STEP: u64 = 3;
    const HOLD_STEP: u64 = FAULT_STEP + 1;
    const RECOVERY_WASHOUT_STEP: u64 = HOLD_STEP + 1;
    const RESUME_STEP: u64 = HOLD_STEP + 2;

    #[derive(Debug, Clone, PartialEq)]
    struct TrajectoryFrame {
        step_index: u64,
        requested_action: Vec<f64>,
        admitted_action: Vec<f64>,
        applied_action: Vec<f64>,
        observations: Vec<f64>,
        observation_present: Vec<bool>,
        action_dispositions: Vec<StandardActionDisposition>,
        fault_dispositions: Vec<StandardFaultDisposition>,
        fault_codes: Vec<String>,
        core_fault_codes: Vec<FaultCode>,
    }

    fn normalized(value: f64) -> f64 {
        if value == 0.0 {
            0.0
        } else {
            value
        }
    }

    fn controller_actions(observations: &[f64], channel_count: usize) -> Vec<f64> {
        let mut actions = Vec::with_capacity(channel_count * STANDARD_ACTION_WIDTH as usize);
        for channel in observations.chunks_exact(STANDARD_OBSERVATION_WIDTH as usize) {
            for axis in 0..3 {
                let proportional = -0.02 * channel[axis];
                let damping = -0.10 * channel[axis + 3];
                actions.push(normalized((proportional + damping).clamp(-40.0, 40.0)));
            }
        }
        actions
    }

    fn run_trajectory(
        channel_count: usize,
        lane_a_hold_and_washout: bool,
    ) -> (Vec<f64>, Vec<TrajectoryFrame>, Vec<f64>) {
        let mut runtime = runtime();
        let mut prepare = prepare_request(channel_count);
        prepare.step_count = TRAJECTORY_STEPS;
        prepare.action_min_values.fill(-40.0);
        prepare.action_max_values.fill(40.0);
        let prepared = runtime.prepare(prepare).expect("trajectory prepares");
        let initial = prepared.observation_values.clone();
        let mut observations = initial.clone();
        let mut frames = Vec::with_capacity(TRAJECTORY_STEPS as usize);

        for step_index in 1..=TRAJECTORY_STEPS {
            let mut request = step_request(channel_count, step_index);
            request.action_values = controller_actions(&observations, channel_count);
            if lane_a_hold_and_washout && step_index == HOLD_STEP {
                request.action_values[..3].fill(0.0);
                request.action_dispositions[0] = StandardActionDisposition::SafeHold;
            } else if lane_a_hold_and_washout && step_index == RECOVERY_WASHOUT_STEP {
                request.action_values[..3].fill(0.0);
            }
            let requested_action = request.action_values.clone();
            let action_dispositions = request.action_dispositions.clone();
            let response = runtime.step(request).expect("trajectory step succeeds");
            let (admitted_action, applied_action, core_fault_codes) = runtime
                .core
                .active_actuation_for_tests()
                .expect("active core retains exact actuation evidence");
            assert_eq!(admitted_action, requested_action);
            observations = response.observation_values.clone();
            frames.push(TrajectoryFrame {
                step_index,
                requested_action,
                admitted_action,
                applied_action,
                observations: observations.clone(),
                observation_present: response.observation_present,
                action_dispositions,
                fault_dispositions: response.fault_dispositions,
                fault_codes: response.fault_codes,
                core_fault_codes,
            });
        }

        let finished = runtime
            .finish(StandardFinishRequest {
                schema_version: STANDARD_FINISH_REQUEST_SCHEMA_ID.to_string(),
                study_run_id: "study-run-standard-01".to_string(),
                final_step_index: TRAJECTORY_STEPS,
                final_snapshot_sha256: "f".repeat(64),
                tic_unit: STANDARD_TIC_UNIT.to_string(),
                causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
                step_duration_tics: STANDARD_STEP_DURATION_TICS,
                final_simulation_time_tics: TRAJECTORY_STEPS * STANDARD_STEP_DURATION_TICS,
                reason: "completed".to_string(),
            })
            .expect("trajectory exact plan finishes");
        assert!(finished.run_state_cleared);
        (initial, frames, observations)
    }

    fn position_distance_squared(observations: &[f64], channel: usize) -> f64 {
        let offset = channel * STANDARD_OBSERVATION_WIDTH as usize;
        observations[offset..offset + 3]
            .iter()
            .map(|value| value * value)
            .sum()
    }

    fn float_bits(values: &[f64]) -> Vec<u64> {
        values.iter().map(|value| value.to_bits()).collect()
    }

    #[test]
    fn standard_surface_supports_data_driven_one_two_and_three_channel_runs() {
        for count in 1..=3 {
            let mut runtime = runtime();
            let prepared = runtime
                .prepare(prepare_request(count))
                .expect("standard profile prepares");
            let stepped = runtime
                .step(step_request(count, 1))
                .expect("standard profile steps");
            runtime
                .step(step_request(count, 2))
                .expect("standard profile completes its step plan");
            let finished = runtime
                .finish(StandardFinishRequest {
                    schema_version: STANDARD_FINISH_REQUEST_SCHEMA_ID.to_string(),
                    study_run_id: "study-run-standard-01".to_string(),
                    final_step_index: 2,
                    final_snapshot_sha256: "f".repeat(64),
                    tic_unit: STANDARD_TIC_UNIT.to_string(),
                    causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
                    step_duration_tics: STANDARD_STEP_DURATION_TICS,
                    final_simulation_time_tics: 2 * STANDARD_STEP_DURATION_TICS,
                    reason: "completed".to_string(),
                })
                .expect("standard profile finishes");

            assert_eq!(prepared.observation_values.len(), count * 6);
            assert_eq!(prepared.simulation_time_tics, 0);
            assert_eq!(stepped.channel_ids.len(), count);
            assert_eq!(stepped.simulation_time_tics, STANDARD_STEP_DURATION_TICS);
            assert_eq!(
                stepped.fault_dispositions,
                vec![StandardFaultDisposition::None; count]
            );
            assert!(finished.run_state_cleared);
        }
    }

    #[test]
    fn standard_surface_has_identical_cross_run_observations() {
        let execute = || {
            let mut runtime = runtime();
            let prepared = runtime.prepare(prepare_request(3)).expect("prepare");
            let stepped = runtime.step(step_request(3, 1)).expect("step");
            (prepared.observation_values, stepped.observation_values)
        };

        assert_eq!(execute(), execute());
    }

    #[test]
    fn standard_two_and_three_drone_long_trajectories_reduce_each_distance() {
        for channel_count in [2, 3] {
            let (initial, frames, final_observations) = run_trajectory(channel_count, false);
            assert_eq!(frames.len(), TRAJECTORY_STEPS as usize);
            for channel in 0..channel_count {
                assert!(
                    position_distance_squared(&final_observations, channel)
                        < position_distance_squared(&initial, channel),
                    "channel {channel} must move closer to the test-only origin reference"
                );
            }
        }
    }

    #[test]
    fn standard_three_drone_hold_recovery_is_bitwise_lane_isolated_and_replayable() {
        let (_, baseline, _) = run_trajectory(3, false);
        let (_, held, _) = run_trajectory(3, true);
        let (_, replay, _) = run_trajectory(3, true);

        assert_eq!(
            held, replay,
            "the complete held trajectory must replay exactly"
        );
        for (baseline_frame, held_frame) in baseline.iter().zip(&held) {
            assert_eq!(baseline_frame.step_index, held_frame.step_index);
            assert_eq!(
                float_bits(&baseline_frame.requested_action[3..]),
                float_bits(&held_frame.requested_action[3..]),
                "lane B/C requested actions drifted at step {}",
                held_frame.step_index
            );
            assert_eq!(
                float_bits(&baseline_frame.admitted_action[3..]),
                float_bits(&held_frame.admitted_action[3..]),
                "lane B/C admitted actions drifted at step {}",
                held_frame.step_index
            );
            assert_eq!(
                float_bits(&baseline_frame.applied_action[3..]),
                float_bits(&held_frame.applied_action[3..]),
                "lane B/C applied actions drifted at step {}",
                held_frame.step_index
            );
            assert_eq!(
                float_bits(&baseline_frame.observations[6..]),
                float_bits(&held_frame.observations[6..]),
                "lane B/C observations drifted at step {}",
                held_frame.step_index
            );
            if held_frame.step_index == FAULT_STEP {
                assert_eq!(
                    held_frame.fault_dispositions,
                    vec![
                        StandardFaultDisposition::SensorUnavailable,
                        StandardFaultDisposition::None,
                        StandardFaultDisposition::None,
                    ]
                );
                assert_eq!(
                    held_frame.fault_codes,
                    vec!["sensor-unavailable", "none", "none"]
                );
                assert_eq!(
                    held_frame.core_fault_codes,
                    vec![FaultCode::SensorDropout, FaultCode::None, FaultCode::None]
                );
                assert_eq!(held_frame.observation_present, vec![false, true, true]);
            } else {
                assert_eq!(
                    held_frame.fault_dispositions,
                    vec![StandardFaultDisposition::None; 3]
                );
                assert_eq!(held_frame.fault_codes, vec!["none"; 3]);
                assert_eq!(held_frame.core_fault_codes, vec![FaultCode::None; 3]);
                assert_eq!(held_frame.observation_present, vec![true; 3]);
            }
        }

        let fault = &held[(FAULT_STEP - 1) as usize];
        assert_eq!(
            fault.fault_dispositions[0],
            StandardFaultDisposition::SensorUnavailable
        );
        assert!(!fault.observation_present[0]);

        let hold = &held[(HOLD_STEP - 1) as usize];
        assert_eq!(
            hold.action_dispositions[0],
            StandardActionDisposition::SafeHold
        );
        assert_eq!(float_bits(&hold.requested_action[..3]), vec![0; 3]);
        assert_eq!(float_bits(&hold.admitted_action[..3]), vec![0; 3]);
        assert_eq!(float_bits(&hold.applied_action[..3]), vec![0; 3]);
        assert_ne!(
            float_bits(&baseline[(HOLD_STEP - 1) as usize].applied_action[..3]),
            vec![0; 3]
        );

        let washout = &held[(RECOVERY_WASHOUT_STEP - 1) as usize];
        assert_eq!(
            washout.action_dispositions[0],
            StandardActionDisposition::BoundedNeuralProposal
        );
        assert_eq!(float_bits(&washout.applied_action[..3]), vec![0; 3]);

        let resumed = &held[(RESUME_STEP - 1) as usize];
        assert_eq!(
            resumed.action_dispositions[0],
            StandardActionDisposition::BoundedNeuralProposal
        );
        assert!(resumed.applied_action[..3]
            .iter()
            .any(|value| *value != 0.0));
        assert!(held.iter().all(|frame| {
            frame.applied_action[3..6].iter().any(|value| *value != 0.0)
                && frame.applied_action[6..9].iter().any(|value| *value != 0.0)
        }));
    }

    #[test]
    fn standard_prepare_rejects_roster_drift() {
        let mut request = prepare_request(2);
        request.channel_ids.swap(0, 1);

        assert!(matches!(
            runtime().prepare(request),
            Err(StandardSimulationError::InvalidInput)
        ));
    }

    #[test]
    fn standard_prepare_rejects_non_six_dimensional_observation_width() {
        let mut request = prepare_request(1);
        request.observation_widths[0] = 2;

        assert!(matches!(
            runtime().prepare(request),
            Err(StandardSimulationError::WidthMismatch)
        ));
    }

    #[test]
    fn standard_prepare_rejects_missing_reordered_and_wrong_unit_rosters() {
        let mutations: [fn(&mut StandardPrepareRequest); 3] = [
            |request| {
                request.observation_component_ids.pop();
            },
            |request| request.observation_component_ids.swap(0, 1),
            |request| request.observation_unit_ids[3] = "si.metre".to_string(),
        ];

        for mutate in mutations {
            let mut request = prepare_request(2);
            mutate(&mut request);
            let mut runtime = runtime();

            assert_eq!(
                runtime.prepare(request),
                Err(StandardSimulationError::SemanticMismatch)
            );
            assert!(runtime.prepare(prepare_request(2)).is_ok());
        }
    }

    #[test]
    fn standard_prepare_rejects_clock_drift_without_creating_state() {
        let mut drift = prepare_request(1);
        drift.step_duration_tics += 1;
        let mut runtime = runtime();

        assert_eq!(
            runtime.prepare(drift),
            Err(StandardSimulationError::ClockMismatch)
        );
        assert!(runtime.prepare(prepare_request(1)).is_ok());
    }

    #[test]
    fn standard_step_rejects_lineage_drift_without_state_mutation() {
        let mut runtime = runtime();
        runtime.prepare(prepare_request(2)).expect("prepare");
        let mut drift = step_request(2, 1);
        drift.study_run_id = "different-study".to_string();

        assert!(matches!(
            runtime.step(drift),
            Err(StandardSimulationError::LineageMismatch)
        ));
        assert!(runtime.step(step_request(2, 1)).is_ok());
    }

    #[test]
    fn standard_step_rejects_clock_drift_without_state_mutation() {
        let mut runtime = runtime();
        runtime.prepare(prepare_request(2)).expect("prepare");
        let mut drift = step_request(2, 1);
        drift.target_simulation_time_tics += 1;

        assert_eq!(
            runtime.step(drift),
            Err(StandardSimulationError::ClockMismatch)
        );
        assert!(runtime.step(step_request(2, 1)).is_ok());
    }

    #[test]
    fn standard_safe_hold_is_per_channel_and_preserves_other_lanes() {
        let mut runtime = runtime();
        runtime.prepare(prepare_request(3)).expect("prepare");
        let mut request = step_request(3, 1);
        request.action_values[3..6].fill(0.0);
        request.action_dispositions[1] = StandardActionDisposition::SafeHold;

        let response = runtime.step(request).expect("safe hold is valid");

        assert_eq!(
            response.fault_dispositions,
            vec![StandardFaultDisposition::None; 3]
        );
        assert_eq!(response.fault_codes, vec!["none"; 3]);
        assert_eq!(response.observation_present, vec![true; 3]);
    }

    #[test]
    fn standard_safe_hold_rejects_non_safe_action() {
        let mut runtime = runtime();
        runtime.prepare(prepare_request(1)).expect("prepare");
        let mut request = step_request(1, 1);
        request.action_dispositions[0] = StandardActionDisposition::SafeHold;

        assert!(matches!(
            runtime.step(request),
            Err(StandardSimulationError::SafeHoldMismatch)
        ));
    }

    #[test]
    fn standard_safe_hold_rejects_a_saturated_safe_vector() {
        let mut runtime = runtime();
        runtime.prepare(prepare_request(1)).expect("prepare");
        let mut request = step_request(1, 1);
        request.action_values.fill(0.0);
        request.action_dispositions[0] = StandardActionDisposition::SafeHold;
        request.saturated_values[0] = true;

        assert_eq!(
            runtime.step(request),
            Err(StandardSimulationError::SafeHoldMismatch)
        );
        let mut valid = step_request(1, 1);
        valid.action_values.fill(0.0);
        valid.action_dispositions[0] = StandardActionDisposition::SafeHold;
        assert!(runtime.step(valid).is_ok());
    }

    #[test]
    fn standard_finish_requires_the_complete_step_budget_and_clears_state() {
        let mut runtime = runtime();
        runtime.prepare(prepare_request(1)).expect("prepare");
        runtime.step(step_request(1, 1)).expect("first step");
        runtime.step(step_request(1, 2)).expect("second step");

        let response = runtime
            .finish(StandardFinishRequest {
                schema_version: STANDARD_FINISH_REQUEST_SCHEMA_ID.to_string(),
                study_run_id: "study-run-standard-01".to_string(),
                final_step_index: 2,
                final_snapshot_sha256: "f".repeat(64),
                tic_unit: STANDARD_TIC_UNIT.to_string(),
                causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
                step_duration_tics: STANDARD_STEP_DURATION_TICS,
                final_simulation_time_tics: 2 * STANDARD_STEP_DURATION_TICS,
                reason: "completed".to_string(),
            })
            .expect("finish succeeds");

        assert!(response.run_state_cleared);
        assert!(response.terminal);
    }

    #[test]
    fn standard_finish_rejects_a_premature_completed_reason_without_cleanup() {
        let mut runtime = runtime();
        runtime.prepare(prepare_request(1)).expect("prepare");
        runtime.step(step_request(1, 1)).expect("first step");

        let error = runtime
            .finish(StandardFinishRequest {
                schema_version: STANDARD_FINISH_REQUEST_SCHEMA_ID.to_string(),
                study_run_id: "study-run-standard-01".to_string(),
                final_step_index: 1,
                final_snapshot_sha256: "f".repeat(64),
                tic_unit: STANDARD_TIC_UNIT.to_string(),
                causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
                step_duration_tics: STANDARD_STEP_DURATION_TICS,
                final_simulation_time_tics: STANDARD_STEP_DURATION_TICS,
                reason: "completed".to_string(),
            })
            .expect_err("completed requires the exact declared step plan");

        assert_eq!(error, StandardSimulationError::LineageMismatch);
        assert!(runtime.step(step_request(1, 2)).is_ok());
    }

    #[test]
    fn standard_finish_rejects_final_clock_drift_without_cleanup() {
        let mut runtime = runtime();
        runtime.prepare(prepare_request(1)).expect("prepare");
        runtime.step(step_request(1, 1)).expect("first step");
        runtime.step(step_request(1, 2)).expect("second step");
        let mut drift = StandardFinishRequest {
            schema_version: STANDARD_FINISH_REQUEST_SCHEMA_ID.to_string(),
            study_run_id: "study-run-standard-01".to_string(),
            final_step_index: 2,
            final_snapshot_sha256: "f".repeat(64),
            tic_unit: STANDARD_TIC_UNIT.to_string(),
            causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
            step_duration_tics: STANDARD_STEP_DURATION_TICS,
            final_simulation_time_tics: 2 * STANDARD_STEP_DURATION_TICS,
            reason: "completed".to_string(),
        };
        drift.final_simulation_time_tics += 1;

        assert_eq!(
            runtime.finish(drift),
            Err(StandardSimulationError::ClockMismatch)
        );
        assert!(runtime
            .finish(StandardFinishRequest {
                schema_version: STANDARD_FINISH_REQUEST_SCHEMA_ID.to_string(),
                study_run_id: "study-run-standard-01".to_string(),
                final_step_index: 2,
                final_snapshot_sha256: "f".repeat(64),
                tic_unit: STANDARD_TIC_UNIT.to_string(),
                causality_policy: STANDARD_CAUSALITY_POLICY.to_string(),
                step_duration_tics: STANDARD_STEP_DURATION_TICS,
                final_simulation_time_tics: 2 * STANDARD_STEP_DURATION_TICS,
                reason: "completed".to_string(),
            })
            .is_ok());
    }

    #[test]
    fn standard_step_id_matches_the_host_canonical_derivation() {
        assert_eq!(
            standard_step_id("study-run-standard-01", 1).expect("step identity derives"),
            "step_8098dd359dd39e2cc335c686ad0fc52d"
        );
    }

    #[test]
    fn standard_profile_rejects_internal_negative_zero() {
        let mut invalid = profile();
        invalid.initial_velocity_mps[0] = -0.0;

        assert!(matches!(
            StandardSimulationRuntime::new(invalid, "b".repeat(64)),
            Err(StandardSimulationError::InvalidProfile)
        ));
    }

    #[test]
    fn standard_profile_rejects_invalid_fault_schedule_order_and_bounds() {
        let mut unsorted = profile();
        unsorted.recoverable_fault_schedule = vec![
            StandardFaultScheduleEntry {
                step_index: 3,
                channel_ordinal: 2,
                fault_disposition: StandardScheduledFault::SensorUnavailable,
            },
            StandardFaultScheduleEntry {
                step_index: 3,
                channel_ordinal: 1,
                fault_disposition: StandardScheduledFault::SensorUnavailable,
            },
        ];
        assert!(matches!(
            StandardSimulationRuntime::new(unsorted, "b".repeat(64)),
            Err(StandardSimulationError::InvalidProfile)
        ));

        let mut out_of_bounds = profile();
        out_of_bounds.recoverable_fault_schedule[0].channel_ordinal = 4;
        assert!(matches!(
            StandardSimulationRuntime::new(out_of_bounds, "b".repeat(64)),
            Err(StandardSimulationError::InvalidProfile)
        ));
    }
}
