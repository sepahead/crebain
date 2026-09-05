use std::collections::HashMap;
use std::marker::PhantomData;

use serde::Serialize;
use thiserror::Error;

use crate::canonical::{canonical_json, sha256_domain, to_value};
use crate::contract::{
    finite_bounded, finite_positive_bounded, valid_identifier, FaultCode, FinishRequest,
    FinishResponse, Outcome, PrepareRequest, PrepareResponse, SimulationFrameResponse, StepRequest,
    StepResponse, AUTHORITY, FINISH_REQUEST_SCHEMA_ID, FINISH_RESPONSE_SCHEMA_ID,
    MAX_ACCELERATION_MPS2, MAX_DRONES, MAX_POSITION_ABS_M, MAX_SENSOR_OFFSET_ABS_M,
    MAX_SENSOR_VARIANCE_M2, MAX_SPEED_MPS, MAX_TICKS, MAX_TICK_MS, PREPARE_REQUEST_SCHEMA_ID,
    PREPARE_RESPONSE_SCHEMA_ID, STEP_REQUEST_SCHEMA_ID, STEP_RESPONSE_SCHEMA_ID,
};
use crate::sensor_fusion::{
    validate_fusion_config, validate_sensor_measurements, FilterAlgorithm, FusionConfig,
    MultiSensorFusion, SensorMeasurement, SensorModality, TrackOutput,
};

const SOURCE_FRAME_ID: &str = "crebain.simulation.enu.v1";
const ABSENT_STATE_DOMAIN: &str = "crebain-simulation-absent-state-v1";
const EMPTY_TRANSCRIPT_DOMAIN: &str = "crebain-simulation-empty-transcript-v1";
const RUN_DIGEST_DOMAIN: &str = "crebain-simulation-run-v1";
const REQUEST_DIGEST_DOMAIN: &str = "crebain-simulation-request-v1";
const STATE_DIGEST_DOMAIN: &str = "crebain-simulation-state-v1";
const RECEIPT_DIGEST_DOMAIN: &str = "crebain-simulation-receipt-v1";
const TRANSCRIPT_DIGEST_DOMAIN: &str = "crebain-simulation-transcript-v1";

/// Marker for a simulation before preparation.
#[derive(Debug)]
pub struct Unprepared;

/// Marker for a prepared, mutable simulation.
#[derive(Debug)]
pub struct Prepared;

/// Marker for a finished simulation with no retained fusion or drone state.
#[derive(Debug)]
pub struct Finished;

/// Immutable diagnostic selection for one project-local simulation generation.
///
/// This selection changes no body or fusion arithmetic. It is not a transport
/// profile and grants no authority to operate the historical Host API server.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum InnovationRecording {
    /// Preserve the historical simulator behavior without diagnostic retention.
    #[default]
    Disabled,
    /// Retain actual Kalman innovation statistics for the latest committed step.
    KalmanInnovationV1,
}

/// Why one current simulator measurement has no accepted innovation statistic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InnovationAbsence {
    /// The declared sensor supplied no measurement in this step.
    SensorUnavailable,
    /// No accepted filter update emitted a statistic, including initial birth.
    NoAcceptedUpdate,
}

/// Actual statistics emitted by one accepted Kalman measurement update.
///
/// The residual uses ENU meters and the covariance uses square meters. NIS is
/// dimensionless. These diagnostics do not establish a calibrated null law or
/// a common-prior cross-sensor consistency projection.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KalmanInnovation {
    /// Lane-local track identifier from the accepted filter update.
    pub fusion_track_id: u64,
    /// Actual fusion frame sequence, distinct from the simulator step index.
    pub fusion_sequence: u64,
    /// Original measurement time in simulation milliseconds.
    pub measurement_timestamp_ms: u64,
    /// Actual sensor modality admitted by the fusion lane.
    pub modality: SensorModality,
    /// Normalized innovation squared from the existing Cholesky calculation.
    pub nis: f64,
    /// Residual dimension of the actual Kalman update.
    pub degrees_of_freedom: u8,
    /// Actual measurement residual, in ENU meters.
    pub innovation_m: [f64; 3],
    /// Actual innovation covariance in ENU square meters, stored row-major.
    pub innovation_covariance_m2: [[f64; 3]; 3],
}

/// Current evidence for one entity; absence never supplies a numeric substitute.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum InnovationEvidence {
    /// The current step contains an accepted, source-bound update.
    Observed { sample: KalmanInnovation },
    /// This step contains no accepted update for the stated reason.
    Unavailable { reason: InnovationAbsence },
}

/// One immutable entity-to-sensor association in the current diagnostic frame.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EntityInnovation {
    /// Exact prepared entity identity, independent of lane-local track numbers.
    pub entity_id: String,
    /// Configured simulated sensor label, not authenticated transport origin.
    pub sensor_id: String,
    /// Current accepted innovation or explicit absence.
    pub evidence: InnovationEvidence,
}

/// Bounded diagnostics for exactly one committed simulator interval.
///
/// The interval endpoints describe body advancement. Each observed statistic
/// comes from the measurement at `interval_end_ms`, not an average over time.
/// Preparation has the zero-width interval `[0, 0]` and usually a birth absence.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InnovationFrame {
    /// Exact local diagnostic meaning. This is not an external wire schema.
    pub profile: &'static str,
    /// Exact prepared run identity.
    pub run_id: String,
    /// Simulator step index, independent of the fusion frame sequence.
    pub tick_index: u64,
    /// Previous committed body time in milliseconds.
    pub interval_start_ms: u64,
    /// Current committed body and measurement time in milliseconds.
    pub interval_end_ms: u64,
    /// Configured physical frame for the simulated visual measurement.
    pub source_frame_id: &'static str,
    /// Exactly one row per prepared entity, in the immutable roster order.
    pub entities: Vec<EntityInnovation>,
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SimulationError {
    #[error("simulation input is invalid")]
    InvalidInput,
    #[error("a simulation run is already active")]
    RunAlreadyActive,
    #[error("there is no active simulation run")]
    NoActiveRun,
    #[error("run identity differs from the active run")]
    RunIdMismatch,
    #[error("tick identity is out of order")]
    TickOutOfOrder,
    #[error("tick budget is exhausted")]
    TickBudgetExhausted,
    #[error("drone roster differs from the prepared roster")]
    RosterMismatch,
    #[error("deterministic overload fault was injected")]
    OverloadInjected,
    #[error("simulation state crossed a configured boundary")]
    SimulationBoundary,
    #[error("sensor fusion rejected the frame")]
    FusionFailed,
    #[error("a panic was contained at the stable adapter boundary")]
    InternalPanicContained,
}

impl SimulationError {
    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::InvalidInput => "invalid-input",
            Self::RunAlreadyActive => "run-already-active",
            Self::NoActiveRun => "no-active-run",
            Self::RunIdMismatch => "run-id-mismatch",
            Self::TickOutOfOrder => "tick-out-of-order",
            Self::TickBudgetExhausted => "tick-budget-exhausted",
            Self::RosterMismatch => "roster-mismatch",
            Self::OverloadInjected => "overload-injected",
            Self::SimulationBoundary => "simulation-boundary",
            Self::FusionFailed => "fusion-failed",
            Self::InternalPanicContained => "internal-panic-contained",
        }
    }

    fn outcome(self) -> Outcome {
        match self {
            Self::OverloadInjected
            | Self::SimulationBoundary
            | Self::FusionFailed
            | Self::InternalPanicContained => Outcome::Failed,
            _ => Outcome::Rejected,
        }
    }

    fn terminal(self) -> bool {
        matches!(
            self,
            Self::OverloadInjected
                | Self::SimulationBoundary
                | Self::FusionFailed
                | Self::InternalPanicContained
        )
    }
}

#[derive(Debug, Clone, Serialize)]
struct DroneState {
    id: String,
    position_m: [f64; 3],
    velocity_mps: [f64; 3],
    sensor_variance_m2: [f64; 3],
    fused_track_id: String,
    fusion_lane_track_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FrameEvidence {
    tick_index: u64,
    drone_ids: Vec<String>,
    simulated_position_m: Vec<f64>,
    simulated_velocity_mps: Vec<f64>,
    sensor_input_admitted: Vec<bool>,
    sensor_input_position_m: Vec<f64>,
    fused_estimate_available: Vec<bool>,
    fused_track_ids: Vec<String>,
    fused_position_m: Vec<f64>,
    fused_velocity_mps: Vec<f64>,
    actuator_intent_acceleration_mps2: Vec<f64>,
    actuator_output_acceleration_mps2: Vec<f64>,
    actuator_saturated: Vec<bool>,
    fault_codes: Vec<FaultCode>,
}

#[derive(Debug, Serialize)]
struct StateDigestInput<'a> {
    schema_version: &'static str,
    run_digest: &'a str,
    prior_state_digest: &'a str,
    frame: &'a FrameEvidence,
}

#[derive(Debug, Serialize)]
struct ReceiptDigestInput<'a> {
    schema_version: &'static str,
    operation_schema: &'a str,
    outcome: Outcome,
    reason: &'a str,
    run_id: &'a str,
    tick_index: u64,
    terminal: bool,
    run_digest: &'a str,
    prior_state_digest: &'a str,
    state_digest: &'a str,
    request_digest: &'a str,
    frame: Option<&'a FrameEvidence>,
}

struct SimulationCore {
    run_id: String,
    tick_ms: u64,
    max_ticks: u64,
    tick_index: u64,
    drones: Vec<DroneState>,
    fusion_lanes: Vec<MultiSensorFusion>,
    run_digest: String,
    state_digest: String,
    transcript_digest: String,
    last_frame: FrameEvidence,
    innovation_recording: InnovationRecording,
    last_innovations: Option<InnovationFrame>,
}

impl Drop for SimulationCore {
    fn drop(&mut self) {
        for lane in &mut self.fusion_lanes {
            lane.clear();
        }
        self.fusion_lanes.clear();
        self.drones.clear();
        self.last_frame = empty_frame(self.tick_index);
        self.last_innovations = None;
    }
}

#[derive(Debug, Clone)]
struct TerminalSummary {
    tick_index: u64,
    drone_ids: Vec<String>,
    run_digest: String,
    state_digest: String,
    transcript_digest: String,
}

/// Type-state simulation handle.
pub struct MultiDroneSimulation<State> {
    core: Option<SimulationCore>,
    terminal: Option<TerminalSummary>,
    _state: PhantomData<State>,
}

impl MultiDroneSimulation<Unprepared> {
    /// Construct an empty simulator. This operation performs no I/O.
    pub fn new() -> Self {
        Self {
            core: None,
            terminal: None,
            _state: PhantomData,
        }
    }

    /// Validate and prepare a deterministic one-to-three-drone simulation.
    ///
    /// # Errors
    ///
    /// Returns [`SimulationError::InvalidInput`] for any shape, identity, or
    /// finite-range violation. Fusion admission failures return
    /// [`SimulationError::FusionFailed`].
    pub fn prepare(
        self,
        request: PrepareRequest,
    ) -> Result<(MultiDroneSimulation<Prepared>, PrepareResponse), SimulationError> {
        self.prepare_with_recording(request, InnovationRecording::Disabled)
    }

    /// Prepare the same simulator with an explicit immutable diagnostic option.
    ///
    /// Historical request, state, and receipt digests remain unchanged. The
    /// caller must bind this selection separately in its prepared native profile.
    /// This function starts no server and performs no I/O.
    ///
    /// # Errors
    ///
    /// Returns the same admission errors as [`Self::prepare`]. Malformed or
    /// unexpectedly ambiguous innovation output returns [`SimulationError::FusionFailed`].
    pub fn prepare_with_recording(
        self,
        request: PrepareRequest,
        recording: InnovationRecording,
    ) -> Result<(MultiDroneSimulation<Prepared>, PrepareResponse), SimulationError> {
        validate_prepare(&request)?;
        let request_digest = digest_request(&request)?;
        let request_bytes = canonical_request_bytes(&request)?;
        let run_digest = sha256_domain(RUN_DIGEST_DOMAIN, &[&request_bytes]);
        let absent_state_digest = absent_state_digest();

        let mut drones = Vec::with_capacity(request.drone_ids.len());
        for (index, id) in request.drone_ids.iter().enumerate() {
            drones.push(DroneState {
                id: id.clone(),
                position_m: vector_at(&request.initial_position_m, index),
                velocity_mps: vector_at(&request.initial_velocity_mps, index),
                sensor_variance_m2: vector_at(&request.sensor_variance_m2, index),
                fused_track_id: format!("TRK-{:05}", index + 1),
                fusion_lane_track_id: None,
            });
        }

        let config = FusionConfig {
            algorithm: FilterAlgorithm::Kalman,
            process_noise: 1.0,
            measurement_noise: 2.0,
            association_threshold: 11.345,
            max_missed_detections: 5,
            min_confirmation_hits: 3,
            confirmation_window: 5,
            // The wire admits at most 1e6 m² per axis. Keep the canonical
            // divergence guard above the corresponding bounded 3-D volume.
            max_position_cov_volume: 8.0e18,
            particle_count: 100,
            emit_innovations: recording == InnovationRecording::KalmanInnovationV1,
            emit_innovation_research: recording == InnovationRecording::KalmanInnovationV1,
        };
        validate_fusion_config(&config).map_err(|_| SimulationError::FusionFailed)?;
        let mut fusion_lanes: Vec<MultiSensorFusion> = (0..drones.len())
            .map(|_| MultiSensorFusion::new(config.clone()))
            .collect();
        let drone_count = drones.len();
        let zero_offsets = vec![[0.0; 3]; drone_count];
        let admitted = vec![true; drone_count];
        let lane_tracks =
            process_fusion_lanes(&mut fusion_lanes, &mut drones, 0, &zero_offsets, &admitted)?;
        if lane_tracks.iter().any(Option::is_none) {
            return Err(SimulationError::FusionFailed);
        }
        let last_innovations = collect_innovations(
            recording,
            &mut fusion_lanes,
            &drones,
            &admitted,
            &request.run_id,
            0,
            request.tick_ms,
        )?;

        let frame = frame_from_tracks(
            0,
            &drones,
            &lane_tracks,
            vec![true; drones.len()],
            flatten_vectors(drones.iter().map(|drone| drone.position_m)),
            vec![0.0; drones.len() * 3],
            vec![0.0; drones.len() * 3],
            vec![false; drones.len()],
            vec![FaultCode::None; drones.len()],
        )?;
        let state_digest = digest_state(&run_digest, &absent_state_digest, &frame)?;
        let receipt_digest = digest_receipt(
            PREPARE_REQUEST_SCHEMA_ID,
            Outcome::Succeeded,
            "prepared",
            &request.run_id,
            0,
            false,
            &run_digest,
            &absent_state_digest,
            &state_digest,
            &request_digest,
            Some(&frame),
        )?;
        let transcript_digest = advance_transcript(&empty_transcript_digest(), &receipt_digest);
        let response = response_from_frame(
            PREPARE_RESPONSE_SCHEMA_ID,
            Outcome::Succeeded,
            "prepared",
            &request.run_id,
            false,
            &run_digest,
            &absent_state_digest,
            &state_digest,
            &request_digest,
            &receipt_digest,
            &transcript_digest,
            &frame,
        );
        let core = SimulationCore {
            run_id: request.run_id,
            tick_ms: request.tick_ms,
            max_ticks: request.max_ticks,
            tick_index: 0,
            drones,
            fusion_lanes,
            run_digest,
            state_digest,
            transcript_digest,
            last_frame: frame,
            innovation_recording: recording,
            last_innovations,
        };
        Ok((
            MultiDroneSimulation {
                core: Some(core),
                terminal: None,
                _state: PhantomData,
            },
            response,
        ))
    }
}

impl Default for MultiDroneSimulation<Unprepared> {
    fn default() -> Self {
        Self::new()
    }
}

/// Check the existing kernel preparation contract without creating state or I/O.
///
/// # Errors
///
/// Returns [`SimulationError::InvalidInput`] for an invalid request.
pub fn validate_prepare_request(request: &PrepareRequest) -> Result<(), SimulationError> {
    validate_prepare(request)
}

impl MultiDroneSimulation<Prepared> {
    /// Check request admission without advancing body or fusion state.
    ///
    /// This does not promise that subsequent computation cannot fail.
    ///
    /// # Errors
    ///
    /// Returns the existing identity, order, shape, bound, or overload error.
    pub fn validate_step(&self, request: &StepRequest) -> Result<(), SimulationError> {
        validate_step(
            self.core.as_ref().ok_or(SimulationError::NoActiveRun)?,
            request,
        )
    }

    /// Check finish admission without consuming or clearing this generation.
    ///
    /// # Errors
    ///
    /// Returns the existing run, step, or request-shape error.
    pub fn validate_finish(&self, request: &FinishRequest) -> Result<(), SimulationError> {
        validate_finish(
            self.core.as_ref().ok_or(SimulationError::NoActiveRun)?,
            request,
        )
    }

    /// Return only the latest committed diagnostic interval, when enabled.
    ///
    /// A rejected step leaves this frame unchanged, including its old index.
    /// A successful step replaces every entity row, including explicit absence.
    /// No history accumulates and this accessor performs no I/O or mutation.
    pub fn latest_innovations(&self) -> Option<&InnovationFrame> {
        self.core.as_ref()?.last_innovations.as_ref()
    }

    /// Advance the exact prepared roster by one tick.
    ///
    /// # Errors
    ///
    /// The method rejects replay, roster drift, non-finite input, and bounds
    /// before fusion. Terminal errors require the caller to discard this handle.
    pub fn step(&mut self, request: StepRequest) -> Result<StepResponse, SimulationError> {
        let core = self.core.as_mut().ok_or(SimulationError::NoActiveRun)?;
        validate_step(core, &request)?;
        let request_digest = digest_request(&request)?;
        let prior_state_digest = core.state_digest.clone();
        let next_tick = request.tick_index;
        let dt = core.tick_ms as f64 / 1_000.0;

        let mut proposed_drones = core.drones.clone();
        let mut applied_acceleration = Vec::with_capacity(proposed_drones.len() * 3);
        let mut saturated = Vec::with_capacity(proposed_drones.len());
        let mut sensor_positions = Vec::with_capacity(proposed_drones.len() * 3);
        let mut sensor_admitted = Vec::with_capacity(proposed_drones.len());
        for (index, drone) in proposed_drones.iter_mut().enumerate() {
            let intent = vector_at(&request.actuator_intent_acceleration_mps2, index);
            let fault = request.fault_codes[index];
            let available_intent = if fault.actuator_available() {
                intent
            } else {
                [0.0; 3]
            };
            let (next_velocity, applied, was_saturated) =
                apply_speed_bound(drone.velocity_mps, available_intent, dt);
            let next_position = [
                drone.position_m[0] + (drone.velocity_mps[0] + next_velocity[0]) * 0.5 * dt,
                drone.position_m[1] + (drone.velocity_mps[1] + next_velocity[1]) * 0.5 * dt,
                drone.position_m[2] + (drone.velocity_mps[2] + next_velocity[2]) * 0.5 * dt,
            ];
            if !finite_bounded(&next_position, MAX_POSITION_ABS_M)
                || !finite_bounded(&next_velocity, MAX_SPEED_MPS)
                || !finite_bounded(&applied, MAX_ACCELERATION_MPS2)
            {
                return Err(SimulationError::SimulationBoundary);
            }
            drone.position_m = next_position;
            drone.velocity_mps = next_velocity;
            applied_acceleration.extend_from_slice(&applied);
            saturated.push(was_saturated);
            let offset = vector_at(&request.sensor_offset_m, index);
            let sensor_position = [
                next_position[0] + offset[0],
                next_position[1] + offset[1],
                next_position[2] + offset[2],
            ];
            if !finite_bounded(&sensor_position, MAX_POSITION_ABS_M) {
                return Err(SimulationError::SimulationBoundary);
            }
            sensor_positions.extend_from_slice(&sensor_position);
            sensor_admitted.push(fault.sensor_available());
        }

        let timestamp_ms = next_tick
            .checked_mul(core.tick_ms)
            .ok_or(SimulationError::SimulationBoundary)?;
        let offsets: Vec<[f64; 3]> = (0..proposed_drones.len())
            .map(|index| vector_at(&request.sensor_offset_m, index))
            .collect();
        let mut proposed_fusion_lanes = core.fusion_lanes.clone();
        let lane_tracks = process_fusion_lanes(
            &mut proposed_fusion_lanes,
            &mut proposed_drones,
            timestamp_ms,
            &offsets,
            &sensor_admitted,
        )?;
        let last_innovations = collect_innovations(
            core.innovation_recording,
            &mut proposed_fusion_lanes,
            &proposed_drones,
            &sensor_admitted,
            &core.run_id,
            next_tick,
            core.tick_ms,
        )?;

        let frame = frame_from_tracks(
            next_tick,
            &proposed_drones,
            &lane_tracks,
            sensor_admitted,
            sensor_positions,
            request.actuator_intent_acceleration_mps2.clone(),
            applied_acceleration,
            saturated,
            request.fault_codes.clone(),
        )?;
        let state_digest = digest_state(&core.run_digest, &prior_state_digest, &frame)?;
        let receipt_digest = digest_receipt(
            STEP_REQUEST_SCHEMA_ID,
            Outcome::Succeeded,
            "stepped",
            &core.run_id,
            next_tick,
            false,
            &core.run_digest,
            &prior_state_digest,
            &state_digest,
            &request_digest,
            Some(&frame),
        )?;
        let transcript_digest = advance_transcript(&core.transcript_digest, &receipt_digest);
        let response = response_from_frame(
            STEP_RESPONSE_SCHEMA_ID,
            Outcome::Succeeded,
            "stepped",
            &core.run_id,
            false,
            &core.run_digest,
            &prior_state_digest,
            &state_digest,
            &request_digest,
            &receipt_digest,
            &transcript_digest,
            &frame,
        );
        core.tick_index = next_tick;
        core.drones = proposed_drones;
        core.fusion_lanes = proposed_fusion_lanes;
        core.state_digest = state_digest;
        core.transcript_digest = transcript_digest;
        core.last_frame = frame;
        core.last_innovations = last_innovations;
        Ok(response)
    }

    /// Finish and consume the active simulation.
    ///
    /// # Errors
    ///
    /// The method rejects a mismatched run or tick. Any returned error consumes
    /// and clears this simulation handle.
    pub fn finish(
        mut self,
        request: FinishRequest,
    ) -> Result<(MultiDroneSimulation<Finished>, FinishResponse), SimulationError> {
        let core = self.core.as_mut().ok_or(SimulationError::NoActiveRun)?;
        validate_finish(core, &request)?;
        let response = finish_response(core, &request)?;
        let terminal = TerminalSummary {
            tick_index: core.tick_index,
            drone_ids: core.drones.iter().map(|drone| drone.id.clone()).collect(),
            run_digest: core.run_digest.clone(),
            state_digest: core.state_digest.clone(),
            transcript_digest: response.transcript_digest.clone(),
        };
        self.core.take();
        Ok((
            MultiDroneSimulation {
                core: None,
                terminal: Some(terminal),
                _state: PhantomData,
            },
            response,
        ))
    }

    fn failure_frame(
        &mut self,
        request: FailureFrameRequest<'_>,
        error: SimulationError,
    ) -> Result<SimulationFrameResponse, SimulationError> {
        let core = self.core.as_mut().ok_or(SimulationError::NoActiveRun)?;
        let mut evidence = core.last_frame.clone();
        evidence.tick_index = request.tick_index;
        if let Some(fault_codes) = request.requested_fault_codes {
            if fault_codes.len() != evidence.drone_ids.len() {
                return Err(SimulationError::InvalidInput);
            }
            evidence.fault_codes = fault_codes.to_vec();
        }
        let receipt_digest = digest_receipt(
            request.request_schema,
            error.outcome(),
            error.reason(),
            request.run_id,
            request.tick_index,
            error.terminal(),
            &core.run_digest,
            &core.state_digest,
            &core.state_digest,
            request.request_digest,
            Some(&evidence),
        )?;
        let transcript_digest = advance_transcript(&core.transcript_digest, &receipt_digest);
        core.transcript_digest = transcript_digest.clone();
        Ok(response_from_frame(
            request.response_schema,
            error.outcome(),
            error.reason(),
            request.run_id,
            error.terminal(),
            &core.run_digest,
            &core.state_digest,
            &core.state_digest,
            request.request_digest,
            &receipt_digest,
            &transcript_digest,
            &evidence,
        ))
    }
}

impl MultiDroneSimulation<Finished> {
    /// Return true only after the active fusion and drone state was cleared.
    pub fn cleaned_up(&self) -> bool {
        self.core.is_none() && self.terminal.is_some()
    }
}

enum RuntimeState {
    Idle,
    Active(Box<MultiDroneSimulation<Prepared>>),
    Terminal(TerminalSummary),
}

struct FailureFrameRequest<'a> {
    response_schema: &'static str,
    request_schema: &'static str,
    run_id: &'a str,
    tick_index: u64,
    request_digest: &'a str,
    requested_fault_codes: Option<&'a [FaultCode]>,
}

/// Dynamic operation dispatcher used by the generic managed-runtime protocol.
pub struct SimulationRuntime {
    state: RuntimeState,
}

impl SimulationRuntime {
    /// Construct an idle, transport-independent runtime.
    pub fn new() -> Self {
        Self {
            state: RuntimeState::Idle,
        }
    }

    pub(crate) fn prepare(
        &mut self,
        request: PrepareRequest,
    ) -> Result<PrepareResponse, SimulationError> {
        let request_digest = digest_request(&request)?;
        if matches!(self.state, RuntimeState::Active(_)) {
            return self.active_prepare_failure(&request, &request_digest);
        }
        if matches!(self.state, RuntimeState::Terminal(_)) {
            return empty_failure_frame(
                PREPARE_RESPONSE_SCHEMA_ID,
                &request.run_id,
                0,
                &request_digest,
                SimulationError::RunAlreadyActive,
            );
        }
        match MultiDroneSimulation::<Unprepared>::new().prepare(request.clone()) {
            Ok((simulation, response)) => {
                self.state = RuntimeState::Active(Box::new(simulation));
                Ok(response)
            }
            Err(error) => empty_failure_frame(
                PREPARE_RESPONSE_SCHEMA_ID,
                &request.run_id,
                0,
                &request_digest,
                error,
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn active_actuation_for_tests(
        &self,
    ) -> Option<(Vec<f64>, Vec<f64>, Vec<FaultCode>)> {
        let RuntimeState::Active(simulation) = &self.state else {
            return None;
        };
        let frame = &simulation.core.as_ref()?.last_frame;
        Some((
            frame.actuator_intent_acceleration_mps2.clone(),
            frame.actuator_output_acceleration_mps2.clone(),
            frame.fault_codes.clone(),
        ))
    }

    pub(crate) fn step(&mut self, request: StepRequest) -> Result<StepResponse, SimulationError> {
        let request_digest = digest_request(&request)?;
        let RuntimeState::Active(simulation) = &mut self.state else {
            return empty_failure_frame(
                STEP_RESPONSE_SCHEMA_ID,
                &request.run_id,
                request.tick_index,
                &request_digest,
                SimulationError::NoActiveRun,
            );
        };
        match simulation.step(request.clone()) {
            Ok(response) => Ok(response),
            Err(error) => {
                let response = simulation.failure_frame(
                    FailureFrameRequest {
                        response_schema: STEP_RESPONSE_SCHEMA_ID,
                        request_schema: STEP_REQUEST_SCHEMA_ID,
                        run_id: &request.run_id,
                        tick_index: request.tick_index,
                        request_digest: &request_digest,
                        requested_fault_codes: Some(&request.fault_codes),
                    },
                    error,
                )?;
                let should_terminal = error.terminal();
                if should_terminal {
                    self.abort_to_terminal();
                }
                Ok(response)
            }
        }
    }

    pub(crate) fn finish(
        &mut self,
        request: FinishRequest,
    ) -> Result<FinishResponse, SimulationError> {
        let request_digest = digest_request(&request)?;
        let validation = match &self.state {
            RuntimeState::Active(simulation) => simulation
                .core
                .as_ref()
                .ok_or(SimulationError::NoActiveRun)
                .and_then(|core| validate_finish(core, &request)),
            _ => Err(SimulationError::NoActiveRun),
        };
        if let Err(error) = validation {
            return self.finish_failure(&request, &request_digest, error);
        }
        let state = std::mem::replace(&mut self.state, RuntimeState::Idle);
        let RuntimeState::Active(simulation) = state else {
            return empty_finish_failure(&request, &request_digest, SimulationError::NoActiveRun);
        };
        match (*simulation).finish(request.clone()) {
            Ok((finished, response)) => {
                if let Some(terminal) = finished.terminal {
                    self.state = RuntimeState::Terminal(terminal);
                }
                Ok(response)
            }
            Err(error) => {
                self.state = RuntimeState::Idle;
                empty_finish_failure(&request, &request_digest, error)
            }
        }
    }

    pub(crate) fn contain_panic_frame(
        &mut self,
        schema_version: &'static str,
        request_schema: &'static str,
        run_id: &str,
        tick_index: u64,
        request_digest: &str,
    ) -> Result<SimulationFrameResponse, SimulationError> {
        let response = match &mut self.state {
            RuntimeState::Active(simulation) => simulation.failure_frame(
                FailureFrameRequest {
                    response_schema: schema_version,
                    request_schema,
                    run_id,
                    tick_index,
                    request_digest,
                    requested_fault_codes: None,
                },
                SimulationError::InternalPanicContained,
            ),
            _ => Err(SimulationError::NoActiveRun),
        };
        let response = match response {
            Ok(response) => Ok(response),
            Err(_) => empty_failure_frame(
                schema_version,
                run_id,
                tick_index,
                request_digest,
                SimulationError::InternalPanicContained,
            ),
        };
        self.abort_to_terminal();
        response
    }

    pub(crate) fn contain_panic_finish(
        &mut self,
        request: &FinishRequest,
        request_digest: &str,
    ) -> Result<FinishResponse, SimulationError> {
        let response = self.finish_failure(
            request,
            request_digest,
            SimulationError::InternalPanicContained,
        );
        self.abort_to_terminal();
        response
    }

    pub(crate) fn abort(&mut self) {
        self.state = RuntimeState::Idle;
    }

    #[cfg(test)]
    fn active(&self) -> bool {
        matches!(self.state, RuntimeState::Active(_))
    }

    fn active_prepare_failure(
        &mut self,
        request: &PrepareRequest,
        request_digest: &str,
    ) -> Result<PrepareResponse, SimulationError> {
        let RuntimeState::Active(simulation) = &mut self.state else {
            return empty_failure_frame(
                PREPARE_RESPONSE_SCHEMA_ID,
                &request.run_id,
                0,
                request_digest,
                SimulationError::RunAlreadyActive,
            );
        };
        simulation.failure_frame(
            FailureFrameRequest {
                response_schema: PREPARE_RESPONSE_SCHEMA_ID,
                request_schema: PREPARE_REQUEST_SCHEMA_ID,
                run_id: &request.run_id,
                tick_index: 0,
                request_digest,
                requested_fault_codes: None,
            },
            SimulationError::RunAlreadyActive,
        )
    }

    fn finish_failure(
        &mut self,
        request: &FinishRequest,
        request_digest: &str,
        error: SimulationError,
    ) -> Result<FinishResponse, SimulationError> {
        let RuntimeState::Active(simulation) = &mut self.state else {
            if let RuntimeState::Terminal(summary) = &self.state {
                return terminal_finish_failure(summary, request, request_digest, error);
            }
            return empty_finish_failure(request, request_digest, error);
        };
        let Some(core) = simulation.core.as_mut() else {
            return empty_finish_failure(request, request_digest, error);
        };
        let receipt_digest = digest_receipt(
            FINISH_REQUEST_SCHEMA_ID,
            error.outcome(),
            error.reason(),
            &request.run_id,
            request.tick_index,
            error.terminal(),
            &core.run_digest,
            &core.state_digest,
            &core.state_digest,
            request_digest,
            None,
        )?;
        let transcript_digest = advance_transcript(&core.transcript_digest, &receipt_digest);
        core.transcript_digest = transcript_digest.clone();
        Ok(FinishResponse {
            schema_version: FINISH_RESPONSE_SCHEMA_ID.to_string(),
            outcome: error.outcome(),
            reason: error.reason().to_string(),
            authority: AUTHORITY.to_string(),
            run_id: request.run_id.clone(),
            tick_index: request.tick_index,
            terminal: error.terminal(),
            drone_ids: core.drones.iter().map(|drone| drone.id.clone()).collect(),
            run_digest: core.run_digest.clone(),
            state_digest: core.state_digest.clone(),
            request_digest: request_digest.to_string(),
            receipt_digest,
            transcript_digest,
            step_count: core.tick_index,
            cleaned_up: false,
        })
    }

    fn abort_to_terminal(&mut self) {
        let state = std::mem::replace(&mut self.state, RuntimeState::Idle);
        if let RuntimeState::Active(mut simulation) = state {
            if let Some(core) = simulation.core.take() {
                let summary = TerminalSummary {
                    tick_index: core.tick_index,
                    drone_ids: core.drones.iter().map(|drone| drone.id.clone()).collect(),
                    run_digest: core.run_digest.clone(),
                    state_digest: core.state_digest.clone(),
                    transcript_digest: core.transcript_digest.clone(),
                };
                drop(core);
                self.state = RuntimeState::Terminal(summary);
            }
        }
    }
}

impl Default for SimulationRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SimulationRuntime {
    fn drop(&mut self) {
        self.abort();
    }
}

fn validate_prepare(request: &PrepareRequest) -> Result<(), SimulationError> {
    let drone_count = request.drone_ids.len();
    if request.schema_version != PREPARE_REQUEST_SCHEMA_ID
        || !valid_identifier(&request.run_id)
        || !(1..=MAX_DRONES).contains(&drone_count)
        || request.tick_ms == 0
        || request.tick_ms > MAX_TICK_MS
        || request.max_ticks == 0
        || request.max_ticks > MAX_TICKS
        || request.initial_position_m.len() != drone_count * 3
        || request.initial_velocity_mps.len() != drone_count * 3
        || request.sensor_variance_m2.len() != drone_count * 3
        || !finite_bounded(&request.initial_position_m, MAX_POSITION_ABS_M)
        || !finite_bounded(&request.initial_velocity_mps, MAX_SPEED_MPS)
        || request
            .initial_velocity_mps
            .chunks_exact(3)
            .any(|velocity| vector_norm_squared(velocity) > MAX_SPEED_MPS * MAX_SPEED_MPS)
        || !finite_positive_bounded(&request.sensor_variance_m2, MAX_SENSOR_VARIANCE_M2)
        || request.drone_ids.iter().any(|id| !valid_identifier(id))
        || !strictly_sorted_unique(&request.drone_ids)
    {
        return Err(SimulationError::InvalidInput);
    }
    Ok(())
}

fn validate_step(core: &SimulationCore, request: &StepRequest) -> Result<(), SimulationError> {
    if request.schema_version != STEP_REQUEST_SCHEMA_ID
        || !valid_identifier(&request.run_id)
        || request.drone_ids.iter().any(|id| !valid_identifier(id))
    {
        return Err(SimulationError::InvalidInput);
    }
    if request.run_id != core.run_id {
        return Err(SimulationError::RunIdMismatch);
    }
    if request.tick_index != core.tick_index + 1 {
        return Err(SimulationError::TickOutOfOrder);
    }
    if request.tick_index > core.max_ticks {
        return Err(SimulationError::TickBudgetExhausted);
    }
    let expected_ids: Vec<&str> = core.drones.iter().map(|drone| drone.id.as_str()).collect();
    let actual_ids: Vec<&str> = request.drone_ids.iter().map(String::as_str).collect();
    if actual_ids != expected_ids {
        return Err(SimulationError::RosterMismatch);
    }
    let vector_length = core.drones.len() * 3;
    if request.actuator_intent_acceleration_mps2.len() != vector_length
        || request.sensor_offset_m.len() != vector_length
        || request.fault_codes.len() != core.drones.len()
        || !finite_bounded(
            &request.actuator_intent_acceleration_mps2,
            MAX_ACCELERATION_MPS2,
        )
        || !finite_bounded(&request.sensor_offset_m, MAX_SENSOR_OFFSET_ABS_M)
    {
        return Err(SimulationError::InvalidInput);
    }
    if request.fault_codes.contains(&FaultCode::Overload) {
        return Err(SimulationError::OverloadInjected);
    }
    Ok(())
}

fn validate_finish(core: &SimulationCore, request: &FinishRequest) -> Result<(), SimulationError> {
    if request.schema_version != FINISH_REQUEST_SCHEMA_ID
        || !valid_identifier(&request.run_id)
        || request.reason != "completed"
    {
        return Err(SimulationError::InvalidInput);
    }
    if request.run_id != core.run_id {
        return Err(SimulationError::RunIdMismatch);
    }
    if request.tick_index != core.tick_index {
        return Err(SimulationError::TickOutOfOrder);
    }
    Ok(())
}

fn strictly_sorted_unique(values: &[String]) -> bool {
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn vector_at(values: &[f64], index: usize) -> [f64; 3] {
    let start = index * 3;
    [values[start], values[start + 1], values[start + 2]]
}

fn vector_norm_squared(values: &[f64]) -> f64 {
    values.iter().map(|value| value * value).sum()
}

fn measurement_for(drone: &DroneState, timestamp_ms: u64, offset: [f64; 3]) -> SensorMeasurement {
    SensorMeasurement {
        sensor_id: simulation_sensor_id(drone),
        modality: SensorModality::Visual,
        timestamp_ms,
        source_frame_id: Some(SOURCE_FRAME_ID.to_string()),
        position: [
            drone.position_m[0] + offset[0],
            drone.position_m[1] + offset[1],
            drone.position_m[2] + offset[2],
        ],
        velocity: Some(drone.velocity_mps),
        covariance: drone.sensor_variance_m2,
        confidence: 1.0,
        class_label: "drone".to_string(),
        metadata: HashMap::new(),
    }
}

fn simulation_sensor_id(drone: &DroneState) -> String {
    format!("sim.{}", drone.id)
}

fn collect_innovations(
    recording: InnovationRecording,
    lanes: &mut [MultiSensorFusion],
    drones: &[DroneState],
    admitted: &[bool],
    run_id: &str,
    tick_index: u64,
    tick_ms: u64,
) -> Result<Option<InnovationFrame>, SimulationError> {
    if recording == InnovationRecording::Disabled {
        return Ok(None);
    }
    if lanes.len() != drones.len() || admitted.len() != drones.len() || drones.len() > MAX_DRONES {
        return Err(SimulationError::FusionFailed);
    }
    let interval_end_ms = tick_index
        .checked_mul(tick_ms)
        .ok_or(SimulationError::SimulationBoundary)?;
    let interval_start_ms = tick_index
        .saturating_sub(1)
        .checked_mul(tick_ms)
        .ok_or(SimulationError::SimulationBoundary)?;
    let expected_fusion_sequence = tick_index
        .checked_add(1)
        .ok_or(SimulationError::SimulationBoundary)?;
    let mut entities = Vec::with_capacity(drones.len());
    for ((lane, drone), admitted) in lanes.iter_mut().zip(drones).zip(admitted) {
        let records = lane.drain_pid_observations();
        let evidence = match records.as_slice() {
            [] => InnovationEvidence::Unavailable {
                reason: if *admitted {
                    InnovationAbsence::NoAcceptedUpdate
                } else {
                    InnovationAbsence::SensorUnavailable
                },
            },
            [record] if *admitted => {
                record
                    .validate()
                    .map_err(|_| SimulationError::FusionFailed)?;
                if record.timestamp_ms != interval_end_ms
                    || record.seq != expected_fusion_sequence
                    || record.modality != SensorModality::Visual
                    || record.dof != 3
                    || drone
                        .fusion_lane_track_id
                        .as_deref()
                        .and_then(crate::pid_observation::track_numeric_id)
                        != Some(record.track_id)
                    || record.consistency_projection.is_some()
                {
                    return Err(SimulationError::FusionFailed);
                }
                InnovationEvidence::Observed {
                    sample: KalmanInnovation {
                        fusion_track_id: record.track_id,
                        fusion_sequence: record.seq,
                        measurement_timestamp_ms: record.timestamp_ms,
                        modality: record.modality,
                        nis: record.nis,
                        degrees_of_freedom: record.dof,
                        innovation_m: record.innovation.ok_or(SimulationError::FusionFailed)?,
                        innovation_covariance_m2: record
                            .innovation_cov
                            .ok_or(SimulationError::FusionFailed)?,
                    },
                }
            }
            _ => return Err(SimulationError::FusionFailed),
        };
        entities.push(EntityInnovation {
            entity_id: drone.id.clone(),
            sensor_id: simulation_sensor_id(drone),
            evidence,
        });
    }
    Ok(Some(InnovationFrame {
        profile: "crebain.kalman-innovation.v1",
        run_id: run_id.to_owned(),
        tick_index,
        interval_start_ms,
        interval_end_ms,
        source_frame_id: SOURCE_FRAME_ID,
        entities,
    }))
}

fn process_fusion_lanes(
    lanes: &mut [MultiSensorFusion],
    drones: &mut [DroneState],
    timestamp_ms: u64,
    offsets: &[[f64; 3]],
    admitted: &[bool],
) -> Result<Vec<Option<TrackOutput>>, SimulationError> {
    if lanes.len() != drones.len()
        || offsets.len() != drones.len()
        || admitted.len() != drones.len()
    {
        return Err(SimulationError::FusionFailed);
    }
    lanes
        .iter_mut()
        .zip(drones)
        .zip(offsets)
        .zip(admitted)
        .map(|(((lane, drone), offset), admitted)| {
            let measurements = if *admitted {
                vec![measurement_for(drone, timestamp_ms, *offset)]
            } else {
                Vec::new()
            };
            validate_sensor_measurements(&measurements)
                .map_err(|_| SimulationError::FusionFailed)?;
            let mut tracks = lane
                .try_process_measurements(measurements, timestamp_ms)
                .map_err(|_| SimulationError::FusionFailed)?;
            tracks.sort_by(|left, right| left.id.cmp(&right.id));
            let current_track_id = drone.fusion_lane_track_id.as_deref();
            let selected = if *admitted {
                tracks
                    .iter()
                    .find(|track| track.last_update_ms == timestamp_ms)
                    .or_else(|| {
                        current_track_id.and_then(|id| tracks.iter().find(|track| track.id == id))
                    })
                    .or_else(|| tracks.first())
                    .cloned()
            } else {
                current_track_id
                    .and_then(|id| tracks.iter().find(|track| track.id == id))
                    .cloned()
            };
            if let Some(track) = &selected {
                drone.fusion_lane_track_id = Some(track.id.clone());
            }
            Ok(selected)
        })
        .collect()
}

fn apply_speed_bound(
    prior_velocity: [f64; 3],
    requested_acceleration: [f64; 3],
    dt: f64,
) -> ([f64; 3], [f64; 3], bool) {
    let requested_velocity = [
        prior_velocity[0] + requested_acceleration[0] * dt,
        prior_velocity[1] + requested_acceleration[1] * dt,
        prior_velocity[2] + requested_acceleration[2] * dt,
    ];
    let speed_squared = requested_velocity
        .iter()
        .map(|value| value * value)
        .sum::<f64>();
    if speed_squared <= MAX_SPEED_MPS * MAX_SPEED_MPS {
        return (requested_velocity, requested_acceleration, false);
    }
    let scale = MAX_SPEED_MPS / speed_squared.sqrt();
    let bounded_velocity = [
        requested_velocity[0] * scale,
        requested_velocity[1] * scale,
        requested_velocity[2] * scale,
    ];
    let applied = [
        (bounded_velocity[0] - prior_velocity[0]) / dt,
        (bounded_velocity[1] - prior_velocity[1]) / dt,
        (bounded_velocity[2] - prior_velocity[2]) / dt,
    ];
    (bounded_velocity, applied, true)
}

#[expect(
    clippy::too_many_arguments,
    reason = "the frame receipt closes every simulation lane"
)]
fn frame_from_tracks(
    tick_index: u64,
    drones: &[DroneState],
    lane_tracks: &[Option<TrackOutput>],
    sensor_input_admitted: Vec<bool>,
    sensor_input_position_m: Vec<f64>,
    actuator_intent_acceleration_mps2: Vec<f64>,
    actuator_output_acceleration_mps2: Vec<f64>,
    actuator_saturated: Vec<bool>,
    fault_codes: Vec<FaultCode>,
) -> Result<FrameEvidence, SimulationError> {
    if lane_tracks.len() != drones.len() {
        return Err(SimulationError::FusionFailed);
    }
    let mut fused_estimate_available = Vec::with_capacity(drones.len());
    let mut fused_position_m = Vec::with_capacity(drones.len() * 3);
    let mut fused_velocity_mps = Vec::with_capacity(drones.len() * 3);
    for track in lane_tracks {
        if let Some(track) = track {
            let position = track.position.map(normalize_zero);
            let velocity = track.velocity.map(normalize_zero);
            if !finite_bounded(&position, MAX_POSITION_ABS_M)
                || !finite_bounded(&velocity, MAX_SPEED_MPS)
            {
                return Err(SimulationError::FusionFailed);
            }
            fused_estimate_available.push(true);
            fused_position_m.extend(position);
            fused_velocity_mps.extend(velocity);
        } else {
            fused_estimate_available.push(false);
            fused_position_m.extend_from_slice(&[0.0; 3]);
            fused_velocity_mps.extend_from_slice(&[0.0; 3]);
        }
    }
    Ok(FrameEvidence {
        tick_index,
        drone_ids: drones.iter().map(|drone| drone.id.clone()).collect(),
        simulated_position_m: flatten_vectors(drones.iter().map(|drone| drone.position_m)),
        simulated_velocity_mps: flatten_vectors(drones.iter().map(|drone| drone.velocity_mps)),
        sensor_input_admitted,
        sensor_input_position_m,
        fused_estimate_available,
        fused_track_ids: drones
            .iter()
            .map(|drone| drone.fused_track_id.clone())
            .collect(),
        fused_position_m,
        fused_velocity_mps,
        actuator_intent_acceleration_mps2,
        actuator_output_acceleration_mps2,
        actuator_saturated,
        fault_codes,
    })
}

fn normalize_zero(value: f64) -> f64 {
    if value == 0.0 {
        0.0
    } else {
        value
    }
}

fn flatten_vectors(values: impl Iterator<Item = [f64; 3]>) -> Vec<f64> {
    values.flat_map(|value| value.into_iter()).collect()
}

fn canonical_request_bytes<T: Serialize>(request: &T) -> Result<Vec<u8>, SimulationError> {
    let value = to_value(request).map_err(|_| SimulationError::InvalidInput)?;
    canonical_json(&value).map_err(|_| SimulationError::InvalidInput)
}

fn digest_request<T: Serialize>(request: &T) -> Result<String, SimulationError> {
    let bytes = canonical_request_bytes(request)?;
    Ok(sha256_domain(REQUEST_DIGEST_DOMAIN, &[&bytes]))
}

pub(crate) fn request_digest<T: Serialize>(request: &T) -> Result<String, SimulationError> {
    digest_request(request)
}

fn digest_state(
    run_digest: &str,
    prior_state_digest: &str,
    frame: &FrameEvidence,
) -> Result<String, SimulationError> {
    let input = StateDigestInput {
        schema_version: "crebain.simulation.state-digest-input.v1",
        run_digest,
        prior_state_digest,
        frame,
    };
    let bytes = canonical_json(&to_value(&input).map_err(|_| SimulationError::InvalidInput)?)
        .map_err(|_| SimulationError::InvalidInput)?;
    Ok(sha256_domain(STATE_DIGEST_DOMAIN, &[&bytes]))
}

#[expect(
    clippy::too_many_arguments,
    reason = "the receipt joins every causal digest"
)]
fn digest_receipt(
    operation_schema: &str,
    outcome: Outcome,
    reason: &str,
    run_id: &str,
    tick_index: u64,
    terminal: bool,
    run_digest: &str,
    prior_state_digest: &str,
    state_digest: &str,
    request_digest: &str,
    frame: Option<&FrameEvidence>,
) -> Result<String, SimulationError> {
    let input = ReceiptDigestInput {
        schema_version: "crebain.simulation.receipt-digest-input.v1",
        operation_schema,
        outcome,
        reason,
        run_id,
        tick_index,
        terminal,
        run_digest,
        prior_state_digest,
        state_digest,
        request_digest,
        frame,
    };
    let bytes = canonical_json(&to_value(&input).map_err(|_| SimulationError::InvalidInput)?)
        .map_err(|_| SimulationError::InvalidInput)?;
    Ok(sha256_domain(RECEIPT_DIGEST_DOMAIN, &[&bytes]))
}

fn advance_transcript(prior: &str, receipt: &str) -> String {
    sha256_domain(
        TRANSCRIPT_DIGEST_DOMAIN,
        &[prior.as_bytes(), receipt.as_bytes()],
    )
}

fn absent_state_digest() -> String {
    sha256_domain(ABSENT_STATE_DOMAIN, &[])
}

fn empty_transcript_digest() -> String {
    sha256_domain(EMPTY_TRANSCRIPT_DOMAIN, &[])
}

#[expect(
    clippy::too_many_arguments,
    reason = "the response projects the complete frame receipt"
)]
fn response_from_frame(
    schema_version: &str,
    outcome: Outcome,
    reason: &str,
    run_id: &str,
    terminal: bool,
    run_digest: &str,
    prior_state_digest: &str,
    state_digest: &str,
    request_digest: &str,
    receipt_digest: &str,
    transcript_digest: &str,
    frame: &FrameEvidence,
) -> SimulationFrameResponse {
    SimulationFrameResponse {
        schema_version: schema_version.to_string(),
        outcome,
        reason: reason.to_string(),
        authority: AUTHORITY.to_string(),
        run_id: run_id.to_string(),
        tick_index: frame.tick_index,
        terminal,
        drone_ids: frame.drone_ids.clone(),
        run_digest: run_digest.to_string(),
        prior_state_digest: prior_state_digest.to_string(),
        state_digest: state_digest.to_string(),
        request_digest: request_digest.to_string(),
        receipt_digest: receipt_digest.to_string(),
        transcript_digest: transcript_digest.to_string(),
        simulated_position_m: frame.simulated_position_m.clone(),
        simulated_velocity_mps: frame.simulated_velocity_mps.clone(),
        sensor_input_admitted: frame.sensor_input_admitted.clone(),
        sensor_input_position_m: frame.sensor_input_position_m.clone(),
        fused_estimate_available: frame.fused_estimate_available.clone(),
        fused_track_ids: frame.fused_track_ids.clone(),
        fused_position_m: frame.fused_position_m.clone(),
        fused_velocity_mps: frame.fused_velocity_mps.clone(),
        actuator_intent_acceleration_mps2: frame.actuator_intent_acceleration_mps2.clone(),
        actuator_output_acceleration_mps2: frame.actuator_output_acceleration_mps2.clone(),
        actuator_saturated: frame.actuator_saturated.clone(),
        fault_codes: frame.fault_codes.clone(),
    }
}

fn empty_frame(tick_index: u64) -> FrameEvidence {
    FrameEvidence {
        tick_index,
        drone_ids: Vec::new(),
        simulated_position_m: Vec::new(),
        simulated_velocity_mps: Vec::new(),
        sensor_input_admitted: Vec::new(),
        sensor_input_position_m: Vec::new(),
        fused_estimate_available: Vec::new(),
        fused_track_ids: Vec::new(),
        fused_position_m: Vec::new(),
        fused_velocity_mps: Vec::new(),
        actuator_intent_acceleration_mps2: Vec::new(),
        actuator_output_acceleration_mps2: Vec::new(),
        actuator_saturated: Vec::new(),
        fault_codes: Vec::new(),
    }
}

fn empty_failure_frame(
    schema_version: &'static str,
    run_id: &str,
    tick_index: u64,
    request_digest: &str,
    error: SimulationError,
) -> Result<SimulationFrameResponse, SimulationError> {
    let run_digest = sha256_domain(RUN_DIGEST_DOMAIN, &[run_id.as_bytes()]);
    let state_digest = absent_state_digest();
    let frame = empty_frame(tick_index);
    let receipt_digest = digest_receipt(
        if schema_version == PREPARE_RESPONSE_SCHEMA_ID {
            PREPARE_REQUEST_SCHEMA_ID
        } else {
            STEP_REQUEST_SCHEMA_ID
        },
        error.outcome(),
        error.reason(),
        run_id,
        tick_index,
        error.terminal(),
        &run_digest,
        &state_digest,
        &state_digest,
        request_digest,
        Some(&frame),
    )?;
    let transcript_digest = advance_transcript(&empty_transcript_digest(), &receipt_digest);
    Ok(response_from_frame(
        schema_version,
        error.outcome(),
        error.reason(),
        run_id,
        error.terminal(),
        &run_digest,
        &state_digest,
        &state_digest,
        request_digest,
        &receipt_digest,
        &transcript_digest,
        &frame,
    ))
}

fn finish_response(
    core: &SimulationCore,
    request: &FinishRequest,
) -> Result<FinishResponse, SimulationError> {
    let request_digest = digest_request(request)?;
    let receipt_digest = digest_receipt(
        FINISH_REQUEST_SCHEMA_ID,
        Outcome::Succeeded,
        "finished",
        &core.run_id,
        core.tick_index,
        true,
        &core.run_digest,
        &core.state_digest,
        &core.state_digest,
        &request_digest,
        None,
    )?;
    let transcript_digest = advance_transcript(&core.transcript_digest, &receipt_digest);
    Ok(FinishResponse {
        schema_version: FINISH_RESPONSE_SCHEMA_ID.to_string(),
        outcome: Outcome::Succeeded,
        reason: "finished".to_string(),
        authority: AUTHORITY.to_string(),
        run_id: core.run_id.clone(),
        tick_index: core.tick_index,
        terminal: true,
        drone_ids: core.drones.iter().map(|drone| drone.id.clone()).collect(),
        run_digest: core.run_digest.clone(),
        state_digest: core.state_digest.clone(),
        request_digest,
        receipt_digest,
        transcript_digest,
        step_count: core.tick_index,
        cleaned_up: true,
    })
}

fn empty_finish_failure(
    request: &FinishRequest,
    request_digest: &str,
    error: SimulationError,
) -> Result<FinishResponse, SimulationError> {
    let run_digest = sha256_domain(RUN_DIGEST_DOMAIN, &[request.run_id.as_bytes()]);
    let state_digest = absent_state_digest();
    let receipt_digest = digest_receipt(
        FINISH_REQUEST_SCHEMA_ID,
        error.outcome(),
        error.reason(),
        &request.run_id,
        request.tick_index,
        error.terminal(),
        &run_digest,
        &state_digest,
        &state_digest,
        request_digest,
        None,
    )?;
    Ok(FinishResponse {
        schema_version: FINISH_RESPONSE_SCHEMA_ID.to_string(),
        outcome: error.outcome(),
        reason: error.reason().to_string(),
        authority: AUTHORITY.to_string(),
        run_id: request.run_id.clone(),
        tick_index: request.tick_index,
        terminal: error.terminal(),
        drone_ids: Vec::new(),
        run_digest,
        state_digest,
        request_digest: request_digest.to_string(),
        receipt_digest: receipt_digest.clone(),
        transcript_digest: advance_transcript(&empty_transcript_digest(), &receipt_digest),
        step_count: 0,
        cleaned_up: true,
    })
}

fn terminal_finish_failure(
    summary: &TerminalSummary,
    request: &FinishRequest,
    request_digest: &str,
    error: SimulationError,
) -> Result<FinishResponse, SimulationError> {
    let receipt_digest = digest_receipt(
        FINISH_REQUEST_SCHEMA_ID,
        error.outcome(),
        error.reason(),
        &request.run_id,
        request.tick_index,
        error.terminal(),
        &summary.run_digest,
        &summary.state_digest,
        &summary.state_digest,
        request_digest,
        None,
    )?;
    Ok(FinishResponse {
        schema_version: FINISH_RESPONSE_SCHEMA_ID.to_string(),
        outcome: error.outcome(),
        reason: error.reason().to_string(),
        authority: AUTHORITY.to_string(),
        run_id: request.run_id.clone(),
        tick_index: request.tick_index,
        terminal: error.terminal(),
        drone_ids: summary.drone_ids.clone(),
        run_digest: summary.run_digest.clone(),
        state_digest: summary.state_digest.clone(),
        request_digest: request_digest.to_string(),
        receipt_digest: receipt_digest.clone(),
        transcript_digest: advance_transcript(&summary.transcript_digest, &receipt_digest),
        step_count: summary.tick_index,
        cleaned_up: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track_output(position: [f64; 3], velocity: [f64; 3]) -> TrackOutput {
        TrackOutput {
            id: "lane-track".to_string(),
            position,
            velocity,
            position_uncertainty: [1.0; 3],
            velocity_uncertainty: [1.0; 3],
            class_label: "drone".to_string(),
            confidence: 1.0,
            sensor_sources: vec![SensorModality::Visual],
            last_update_ms: 0,
            age: 1,
            state: crate::sensor_fusion::TrackStateLabel::Tentative,
            threat_level: 0,
        }
    }

    fn drone_state(velocity_mps: [f64; 3]) -> DroneState {
        DroneState {
            id: "drone-01".to_string(),
            position_m: [10.0, 20.0, 30.0],
            velocity_mps,
            sensor_variance_m2: [1.0; 3],
            fused_track_id: "TRK-00001".to_string(),
            fusion_lane_track_id: Some("lane-track".to_string()),
        }
    }

    fn prepare_request(drone_count: usize) -> PrepareRequest {
        let drone_ids: Vec<String> = (1..=drone_count)
            .map(|index| format!("drone-{index:02}"))
            .collect();
        let mut positions = Vec::new();
        for index in 0..drone_count {
            positions.extend_from_slice(&[index as f64 * 500.0, 0.0, 100.0]);
        }
        PrepareRequest {
            schema_version: PREPARE_REQUEST_SCHEMA_ID.to_string(),
            run_id: "run-deterministic-01".to_string(),
            drone_ids,
            tick_ms: 20,
            max_ticks: 8,
            initial_position_m: positions,
            initial_velocity_mps: vec![0.0; drone_count * 3],
            sensor_variance_m2: vec![1.0; drone_count * 3],
        }
    }

    fn step_request(drone_count: usize, tick_index: u64) -> StepRequest {
        StepRequest {
            schema_version: STEP_REQUEST_SCHEMA_ID.to_string(),
            run_id: "run-deterministic-01".to_string(),
            tick_index,
            drone_ids: (1..=drone_count)
                .map(|index| format!("drone-{index:02}"))
                .collect(),
            actuator_intent_acceleration_mps2: (0..drone_count)
                .flat_map(|index| [1.0 + index as f64, 0.25, 0.0])
                .collect(),
            sensor_offset_m: vec![0.0; drone_count * 3],
            fault_codes: vec![FaultCode::None; drone_count],
        }
    }

    #[test]
    fn simulation_supports_data_driven_one_two_and_three_drone_runs() {
        for drone_count in 1..=3 {
            let (mut simulation, prepared) = MultiDroneSimulation::new()
                .prepare(prepare_request(drone_count))
                .expect("valid scenario prepares");
            let stepped = simulation
                .step(step_request(drone_count, 1))
                .expect("valid scenario steps");

            assert_eq!(
                (prepared.drone_ids.len(), stepped.drone_ids.len()),
                (drone_count, drone_count)
            );
            assert_eq!(prepared.fused_velocity_mps.len(), drone_count * 3);
            assert_eq!(stepped.fused_velocity_mps.len(), drone_count * 3);
        }
    }

    #[test]
    fn innovation_recording_preserves_exact_responses_for_one_two_and_three_entities() {
        for entity_count in 1..=3 {
            let mut request = prepare_request(entity_count);
            request.max_ticks = 160;
            let (mut baseline, baseline_prepared) = MultiDroneSimulation::new()
                .prepare(request.clone())
                .expect("historical profile prepares");
            let (mut recorded, recorded_prepared) = MultiDroneSimulation::new()
                .prepare_with_recording(request, InnovationRecording::KalmanInnovationV1)
                .expect("explicit diagnostic selection prepares");
            assert_eq!(
                serde_json::to_vec(&baseline_prepared).unwrap(),
                serde_json::to_vec(&recorded_prepared).unwrap()
            );
            assert!(baseline.latest_innovations().is_none());
            for tick_index in 1..=160 {
                let mut step = step_request(entity_count, tick_index);
                if tick_index % 17 == 3 {
                    step.fault_codes[0] = FaultCode::SensorDropout;
                }
                if tick_index % 23 == 5 {
                    step.fault_codes[entity_count - 1] = FaultCode::ActuatorHold;
                }
                let expected = baseline.step(step.clone()).expect("baseline step");
                let actual = recorded.step(step).expect("recorded step");
                assert_eq!(
                    serde_json::to_vec(&expected).unwrap(),
                    serde_json::to_vec(&actual).unwrap(),
                    "all numerical values and historical receipts remain exact"
                );
                let frame = recorded.latest_innovations().expect("enabled frame");
                assert_eq!(frame.tick_index, tick_index);
                assert_eq!(frame.entities.len(), entity_count);
                assert_eq!(frame.interval_start_ms, (tick_index - 1) * 20);
                assert_eq!(frame.interval_end_ms, tick_index * 20);
                assert!(baseline.latest_innovations().is_none());
                for lane in &mut recorded.core.as_mut().unwrap().fusion_lanes {
                    assert!(lane.drain_pid_observations().is_empty());
                }
            }
            let finish = FinishRequest {
                schema_version: FINISH_REQUEST_SCHEMA_ID.to_owned(),
                run_id: baseline_prepared.run_id.clone(),
                tick_index: 160,
                reason: "completed".to_owned(),
            };
            let (baseline_finished, expected) = baseline.finish(finish.clone()).expect("finish");
            let (recorded_finished, actual) = recorded.finish(finish).expect("recorded finish");
            assert!(baseline_finished.cleaned_up() && recorded_finished.cleaned_up());
            assert_eq!(
                serde_json::to_vec(&expected).unwrap(),
                serde_json::to_vec(&actual).unwrap()
            );
        }
    }

    #[test]
    fn innovation_recording_distinguishes_birth_zero_dropout_and_recovery() {
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare_with_recording(prepare_request(3), InnovationRecording::KalmanInnovationV1)
            .expect("prepare");
        let initial = simulation.latest_innovations().expect("initial frame");
        assert_eq!((initial.interval_start_ms, initial.interval_end_ms), (0, 0));
        assert!(initial.entities.iter().all(|entity| matches!(
            entity.evidence,
            InnovationEvidence::Unavailable {
                reason: InnovationAbsence::NoAcceptedUpdate
            }
        )));

        let mut stationary = step_request(3, 1);
        stationary.actuator_intent_acceleration_mps2.fill(0.0);
        simulation.step(stationary).expect("stationary update");
        let observed = simulation.latest_innovations().expect("observed zero");
        for (index, entity) in observed.entities.iter().enumerate() {
            let InnovationEvidence::Observed { sample } = &entity.evidence else {
                panic!("accepted zero is observed, not absent");
            };
            assert_eq!(entity.entity_id, format!("drone-{:02}", index + 1));
            assert_eq!(entity.sensor_id, format!("sim.{}", entity.entity_id));
            assert_eq!(sample.nis, 0.0);
            assert_eq!(sample.innovation_m, [0.0; 3]);
            assert_eq!(sample.degrees_of_freedom, 3);
            assert_eq!(sample.modality, SensorModality::Visual);
            assert_eq!(sample.fusion_sequence, 2);
            assert_eq!(sample.measurement_timestamp_ms, 20);
        }

        let mut dropout = step_request(3, 2);
        dropout.fault_codes[0] = FaultCode::SensorDropout;
        simulation.step(dropout).expect("per-entity dropout");
        let absent = simulation.latest_innovations().expect("current frame");
        assert_eq!(absent.tick_index, 2);
        assert!(matches!(
            absent.entities[0].evidence,
            InnovationEvidence::Unavailable {
                reason: InnovationAbsence::SensorUnavailable
            }
        ));
        assert!(absent.entities[1..]
            .iter()
            .all(|entity| matches!(entity.evidence, InnovationEvidence::Observed { .. })));
        simulation.step(step_request(3, 3)).expect("recovery");
        assert!(simulation
            .latest_innovations()
            .unwrap()
            .entities
            .iter()
            .all(|entity| matches!(entity.evidence, InnovationEvidence::Observed { .. })));
    }

    #[test]
    fn innovation_recording_preserves_actual_residual_covariance_and_nis() {
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare_with_recording(prepare_request(1), InnovationRecording::KalmanInnovationV1)
            .expect("prepare");
        let mut step = step_request(1, 1);
        step.actuator_intent_acceleration_mps2.fill(0.0);
        step.sensor_offset_m = vec![0.1, -0.2, 0.3];
        simulation.step(step).expect("nonzero innovation");
        let InnovationEvidence::Observed { sample } =
            &simulation.latest_innovations().unwrap().entities[0].evidence
        else {
            panic!("small accepted displacement emits a statistic");
        };
        assert!(sample.nis > 0.0);
        assert!((sample.innovation_m[0] - 0.1).abs() < 1e-12);
        assert!((sample.innovation_m[1] + 0.2).abs() < 1e-12);
        assert!((sample.innovation_m[2] - 0.3).abs() < 1e-12);
        let mut direct_nis = 0.0;
        for axis in 0..3 {
            let variance = sample.innovation_covariance_m2[axis][axis];
            assert!(variance > 0.0);
            for other in 0..3 {
                if axis != other {
                    assert_eq!(sample.innovation_covariance_m2[axis][other], 0.0);
                }
            }
            direct_nis += sample.innovation_m[axis].powi(2) / variance;
        }
        assert!((sample.nis - direct_nis).abs() <= 1e-12 * direct_nis);
    }

    #[test]
    fn rejected_step_preserves_prior_innovation_identity_without_refreshing_it() {
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare_with_recording(prepare_request(2), InnovationRecording::KalmanInnovationV1)
            .expect("prepare");
        simulation.step(step_request(2, 1)).expect("first step");
        let previous = simulation.latest_innovations().unwrap().clone();
        assert_eq!(
            simulation.step(step_request(2, 1)).unwrap_err(),
            SimulationError::TickOutOfOrder
        );
        assert_eq!(simulation.latest_innovations(), Some(&previous));
        let mut malformed = step_request(2, 2);
        malformed.actuator_intent_acceleration_mps2[0] = f64::NAN;
        assert_eq!(
            simulation.step(malformed).unwrap_err(),
            SimulationError::InvalidInput
        );
        assert_eq!(simulation.latest_innovations(), Some(&previous));
        simulation.step(step_request(2, 2)).expect("valid retry");
        assert_eq!(simulation.latest_innovations().unwrap().tick_index, 2);
    }

    #[test]
    fn historical_prepare_wire_cannot_enable_local_innovation_recording() {
        let mut wire = serde_json::to_value(prepare_request(1)).unwrap();
        wire.as_object_mut().unwrap().insert(
            "innovation_recording".to_owned(),
            serde_json::json!("kalman_innovation_v1"),
        );
        assert!(serde_json::from_value::<PrepareRequest>(wire).is_err());
        let request: PrepareRequest =
            serde_json::from_value(serde_json::to_value(prepare_request(1)).unwrap()).unwrap();
        let (simulation, _) = MultiDroneSimulation::new()
            .prepare(request)
            .expect("old wire");
        assert!(simulation.latest_innovations().is_none());
    }

    #[test]
    fn public_preflight_delegates_admission_without_mutation() {
        let request = prepare_request(1);
        validate_prepare_request(&request).expect("valid preparation preflight");
        let mut invalid = request.clone();
        invalid.sensor_variance_m2[0] = 0.0;
        assert_eq!(
            validate_prepare_request(&invalid),
            Err(SimulationError::InvalidInput)
        );
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare_with_recording(request, InnovationRecording::KalmanInnovationV1)
            .expect("prepare");
        let initial = simulation.latest_innovations().unwrap().clone();
        let step = step_request(1, 1);
        simulation
            .validate_step(&step)
            .expect("valid step preflight");
        assert_eq!(simulation.latest_innovations(), Some(&initial));
        let mut invalid_step = step.clone();
        invalid_step.tick_index = 2;
        assert_eq!(
            simulation.validate_step(&invalid_step),
            Err(SimulationError::TickOutOfOrder)
        );
        assert_eq!(simulation.latest_innovations(), Some(&initial));
        let mut finish = FinishRequest {
            schema_version: FINISH_REQUEST_SCHEMA_ID.to_owned(),
            run_id: "run-deterministic-01".to_owned(),
            tick_index: 1,
            reason: "completed".to_owned(),
        };
        assert_eq!(
            simulation.validate_finish(&finish),
            Err(SimulationError::TickOutOfOrder)
        );
        finish.tick_index = 0;
        simulation
            .validate_finish(&finish)
            .expect("valid finish preflight");
        assert_eq!(simulation.latest_innovations(), Some(&initial));
        simulation
            .step(step)
            .expect("preflight did not consume the step");
    }

    #[test]
    fn innovation_collection_rejects_stale_ambiguous_and_incompatible_evidence() {
        let (simulation, _) = MultiDroneSimulation::new()
            .prepare_with_recording(prepare_request(1), InnovationRecording::KalmanInnovationV1)
            .expect("prepare");
        let core = simulation.core.as_ref().unwrap();
        for fault in 0..6 {
            let mut lanes = core.fusion_lanes.clone();
            let mut drones = core.drones.clone();
            let mut admitted = vec![true];
            let mut measurement = measurement_for(&drones[0], 20, [0.1, 0.0, 0.0]);
            if fault == 2 {
                measurement.modality = SensorModality::Thermal;
            }
            if fault == 3 {
                lanes[0].set_config(FusionConfig {
                    algorithm: FilterAlgorithm::Kalman,
                    emit_innovations: true,
                    emit_innovation_research: false,
                    ..FusionConfig::default()
                });
            }
            lanes[0]
                .try_process_measurements(vec![measurement.clone()], 20)
                .expect("actual update");
            if fault == 0 {
                measurement.timestamp_ms = 40;
                lanes[0]
                    .try_process_measurements(vec![measurement], 40)
                    .expect("second unconsumed update");
            }
            if fault == 4 {
                admitted[0] = false;
            }
            if fault == 5 {
                drones[0].fusion_lane_track_id = Some("TRK-00002".to_owned());
            }
            let tick_index = if fault == 1 { 2 } else { 1 };
            assert_eq!(
                collect_innovations(
                    InnovationRecording::KalmanInnovationV1,
                    &mut lanes,
                    &drones,
                    &admitted,
                    &core.run_id,
                    tick_index,
                    core.tick_ms,
                ),
                Err(SimulationError::FusionFailed),
                "fault {fault} cannot become current accepted evidence"
            );
        }
    }

    #[test]
    fn frame_evidence_uses_fused_track_velocity_not_simulator_truth() {
        let drones = vec![drone_state([90.0, 80.0, 70.0])];
        let lane_tracks = vec![Some(track_output([-0.0, 2.0, 3.0], [4.0, -0.0, -6.0]))];

        let frame = frame_from_tracks(
            0,
            &drones,
            &lane_tracks,
            vec![true],
            vec![10.0, 20.0, 30.0],
            vec![0.0; 3],
            vec![0.0; 3],
            vec![false],
            vec![FaultCode::None],
        )
        .expect("bounded fused output is admitted");

        assert_eq!(frame.simulated_velocity_mps, vec![90.0, 80.0, 70.0]);
        assert_eq!(frame.fused_position_m, vec![0.0, 2.0, 3.0]);
        assert_eq!(frame.fused_velocity_mps, vec![4.0, 0.0, -6.0]);
        assert_eq!(frame.fused_velocity_mps[1].to_bits(), 0.0_f64.to_bits());
    }

    #[test]
    fn frame_evidence_rejects_out_of_bound_fused_velocity() {
        let drones = vec![drone_state([0.0; 3])];
        let lane_tracks = vec![Some(track_output(
            [1.0, 2.0, 3.0],
            [MAX_SPEED_MPS + 1.0, 0.0, 0.0],
        ))];

        let result = frame_from_tracks(
            0,
            &drones,
            &lane_tracks,
            vec![true],
            vec![10.0, 20.0, 30.0],
            vec![0.0; 3],
            vec![0.0; 3],
            vec![false],
            vec![FaultCode::None],
        );

        assert!(matches!(result, Err(SimulationError::FusionFailed)));
    }

    #[test]
    fn identical_runs_have_identical_cross_run_digest_chains() {
        let execute = || {
            let (mut simulation, prepared) = MultiDroneSimulation::new()
                .prepare(prepare_request(3))
                .expect("valid scenario prepares");
            let first = simulation.step(step_request(3, 1)).expect("first step");
            let second = simulation.step(step_request(3, 2)).expect("second step");
            (
                prepared.run_digest,
                first.state_digest,
                second.receipt_digest,
                second.transcript_digest,
            )
        };

        assert_eq!(execute(), execute());
    }

    #[test]
    fn prepare_rejects_four_drone_overload() {
        let result = MultiDroneSimulation::new().prepare(prepare_request(4));

        assert!(matches!(result, Err(SimulationError::InvalidInput)));
    }

    #[test]
    fn prepare_rejects_unsorted_stable_identity_roster() {
        let mut request = prepare_request(2);
        request.drone_ids.swap(0, 1);
        let result = MultiDroneSimulation::new().prepare(request);

        assert!(matches!(result, Err(SimulationError::InvalidInput)));
    }

    #[test]
    fn independent_fusion_lanes_preserve_co_located_drone_identities() {
        let mut request = prepare_request(3);
        request.initial_position_m = [0.0, 0.0, 100.0].repeat(3);
        request.sensor_variance_m2 = vec![MAX_SENSOR_VARIANCE_M2; 9];

        let (_, response) = MultiDroneSimulation::new()
            .prepare(request)
            .expect("known drone channels use independent fusion lanes");

        assert_eq!(
            response.fused_track_ids,
            vec!["TRK-00001", "TRK-00002", "TRK-00003"]
        );
        assert_eq!(response.fused_estimate_available, vec![true; 3]);
    }

    #[test]
    fn prepare_rejects_vector_speed_above_the_norm_bound() {
        let mut request = prepare_request(1);
        request.initial_velocity_mps = vec![MAX_SPEED_MPS, MAX_SPEED_MPS, 0.0];

        let result = MultiDroneSimulation::new().prepare(request);

        assert!(matches!(result, Err(SimulationError::InvalidInput)));
    }

    #[test]
    fn step_rejects_replayed_tick_without_state_mutation() {
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare(prepare_request(1))
            .expect("valid scenario prepares");
        let first = simulation.step(step_request(1, 1)).expect("first step");
        let replay = simulation.step(step_request(1, 1));

        assert!(matches!(replay, Err(SimulationError::TickOutOfOrder)));
        assert_eq!(
            simulation
                .core
                .as_ref()
                .map(|core| core.state_digest.as_str()),
            Some(first.state_digest.as_str())
        );
    }

    #[test]
    fn actuator_hold_fault_applies_zero_acceleration() {
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare(prepare_request(1))
            .expect("valid scenario prepares");
        let mut request = step_request(1, 1);
        request.fault_codes[0] = FaultCode::ActuatorHold;
        let response = simulation.step(request).expect("fault is bounded");

        assert_eq!(response.actuator_output_acceleration_mps2, vec![0.0; 3]);
    }

    #[test]
    fn sensor_dropout_is_explicit_and_does_not_block_other_drones() {
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare(prepare_request(3))
            .expect("valid scenario prepares");
        let mut request = step_request(3, 1);
        request.fault_codes[1] = FaultCode::SensorDropout;
        let response = simulation.step(request).expect("dropout is bounded");

        assert_eq!(response.sensor_input_admitted, vec![true, false, true]);
    }

    #[test]
    fn fusion_lane_recovers_with_the_same_external_identity_after_long_dropout() {
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare(prepare_request(1))
            .expect("valid scenario prepares");
        for tick_index in 1..=6 {
            let mut request = step_request(1, tick_index);
            request.fault_codes[0] = FaultCode::SensorDropout;
            simulation.step(request).expect("dropout stays bounded");
        }

        let response = simulation
            .step(step_request(1, 7))
            .expect("sensor recovery is admitted");

        assert_eq!(response.fused_track_ids, vec!["TRK-00001"]);
        assert_eq!(response.fused_estimate_available, vec![true]);
        assert_eq!(response.sensor_input_admitted, vec![true]);
    }

    #[test]
    fn overload_fault_terminalizes_and_cleans_runtime() {
        let mut runtime = SimulationRuntime::new();
        let _ = runtime.prepare(prepare_request(1));
        let mut request = step_request(1, 1);
        request.fault_codes[0] = FaultCode::Overload;
        let response = runtime.step(request).expect("fault receipt canonicalizes");

        assert_eq!(
            (response.outcome, response.terminal),
            (Outcome::Failed, true)
        );
        assert_eq!(response.fault_codes, vec![FaultCode::Overload]);
        assert!(!runtime.active());
    }

    #[test]
    fn rejected_tick_receipt_echoes_the_requested_tick_without_advancing_state() {
        let mut runtime = SimulationRuntime::new();
        let prepared = runtime
            .prepare(prepare_request(1))
            .expect("prepare receipt canonicalizes");
        let response = runtime
            .step(step_request(1, 2))
            .expect("rejection receipt canonicalizes");

        assert_eq!(response.tick_index, 2);
        assert_eq!(response.reason, "tick-out-of-order");
        assert_eq!(response.state_digest, prepared.state_digest);
        assert!(runtime.active());
    }

    #[test]
    fn explicit_abort_clears_an_active_runtime() {
        let mut runtime = SimulationRuntime::new();
        let _ = runtime.prepare(prepare_request(2));

        runtime.abort();

        assert!(!runtime.active());
    }

    #[test]
    fn finish_consumes_and_cleans_active_state() {
        let (simulation, _) = MultiDroneSimulation::new()
            .prepare(prepare_request(1))
            .expect("valid scenario prepares");
        let request = FinishRequest {
            schema_version: FINISH_REQUEST_SCHEMA_ID.to_string(),
            run_id: "run-deterministic-01".to_string(),
            tick_index: 0,
            reason: "completed".to_string(),
        };
        let (finished, receipt) = simulation.finish(request).expect("finish succeeds");

        assert!(finished.cleaned_up() && receipt.cleaned_up && receipt.terminal);
    }

    #[test]
    fn direct_input_rejects_nonfinite_actuator_values() {
        let (mut simulation, _) = MultiDroneSimulation::new()
            .prepare(prepare_request(1))
            .expect("valid scenario prepares");
        let mut request = step_request(1, 1);
        request.actuator_intent_acceleration_mps2[0] = f64::NAN;
        let result = simulation.step(request);

        assert!(matches!(result, Err(SimulationError::InvalidInput)));
    }

    #[test]
    fn state_and_receipt_hashing_reject_internal_negative_zero() {
        let digest = "0".repeat(64);
        let mut frame = empty_frame(0);
        frame.simulated_position_m.push(-0.0);

        let state = digest_state(&digest, &digest, &frame);
        let receipt = digest_receipt(
            PREPARE_REQUEST_SCHEMA_ID,
            Outcome::Succeeded,
            "prepared",
            "run-deterministic-01",
            0,
            false,
            &digest,
            &digest,
            &digest,
            &digest,
            Some(&frame),
        );

        assert!(matches!(state, Err(SimulationError::InvalidInput)));
        assert!(matches!(receipt, Err(SimulationError::InvalidInput)));
    }
}
