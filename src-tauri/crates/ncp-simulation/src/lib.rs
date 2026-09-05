//! Native local NCP body ownership over the existing CREBAIN numerical kernel.
//!
//! The endpoint performs no Host API dispatch, network access, process launch,
//! or external store access. A supervisor supplies one immutable local binding.
//! The implemented body is simulator-only and provides no physical authority.

use crebain_managed_simulation::{
    validate_prepare_request, FaultCode, FinishRequest, InnovationEvidence, InnovationFrame,
    InnovationRecording, MultiDroneSimulation, PrepareRequest, Prepared, SimulationFrameResponse,
    StepRequest,
};
use ncp_local::local::{
    LocalBackend, LocalBinding, LocalCode, LocalError, LocalOperation, LocalOutcome, LocalRequest,
    LocalRole,
};
use ncp_local::local_data::{
    BodyResult, BodyStep, InnovationSource, InnovationStatus, NeuralProposal, NeuralStep,
    PrepareData, RunPlan, ScalarInnovation, Snapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Exact installed simulator application profile.
pub const APPLICATION_PROFILE: &str = "crebain.local-kinematic-kalman.v1";
/// Maximum frozen schedule rows admitted by this application profile.
pub const MAX_SCHEDULE_ROWS: usize = 256;

/// One frozen environmental or actuator availability input.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScheduledInput {
    /// Positive logical body step, within the declared plan.
    pub step: u64,
    /// Exact prepared entity identity.
    pub entity_id: String,
    /// Declared simulated sensor offset in ENU meters.
    pub sensor_offset_m: [f64; 3],
    /// Whether the simulator supplies its visual measurement at this step.
    pub sensor_available: bool,
    /// Whether the simulator applies the proposed acceleration at this step.
    pub actuator_available: bool,
}

/// Closed application data, fixed before body state creation.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BodyConfiguration {
    /// Explicit entity-major initial ENU position, in meters.
    pub initial_position_m: Vec<f64>,
    /// Explicit entity-major initial ENU velocity, in meters per second.
    pub initial_velocity_mps: Vec<f64>,
    /// Explicit entity-major visual variance, in square meters.
    pub sensor_variance_m2: Vec<f64>,
    /// Supervisor-established neural endpoint generation.
    pub expected_neural_generation: String,
    /// Sorted unique `(step, entity_id)` inputs. No runtime fault override exists.
    pub schedule: Vec<ScheduledInput>,
}

/// Exact terminal request, independent of historical managed receipts.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FinishData {
    /// Exact complete prepared plan digest.
    pub plan_digest: String,
    /// Must equal both the current body step and the declared full plan.
    pub completed_steps: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyData {}

struct ActiveBody {
    plan: RunPlan,
    configuration: BodyConfiguration,
    kernel: MultiDroneSimulation<Prepared>,
    snapshot: Snapshot,
}

/// Single owner of a locally prepared body generation.
pub struct BodyBackend {
    binding: LocalBinding,
    active: Option<ActiveBody>,
    retired: bool,
}

fn invalid() -> LocalError {
    LocalError(LocalCode::InvalidInput)
}

fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, LocalError> {
    serde_json::from_value(value.clone()).map_err(|_| invalid())
}

impl BodyBackend {
    /// Bind an endpoint whose installed role is exactly `Body`.
    pub fn new(binding: LocalBinding) -> Result<Self, LocalError> {
        binding.validate()?;
        if binding.role != LocalRole::Body {
            return Err(LocalError(LocalCode::Role));
        }
        Ok(Self {
            binding,
            active: None,
            retired: false,
        })
    }

    fn prepare_input(
        &self,
        body: &Value,
    ) -> Result<(RunPlan, BodyConfiguration, PrepareRequest), LocalError> {
        let data: PrepareData = decode(body)?;
        data.plan.validate()?;
        if data.application_profile != APPLICATION_PROFILE {
            return Err(invalid());
        }
        let configuration: BodyConfiguration = decode(&data.configuration)?;
        self.neural_binding(&configuration).validate()?;
        if configuration.expected_neural_generation == self.binding.generation
            || configuration.schedule.len() > MAX_SCHEDULE_ROWS
            || !configuration
                .schedule
                .windows(2)
                .all(|rows| (rows[0].step, &rows[0].entity_id) < (rows[1].step, &rows[1].entity_id))
            || configuration.schedule.iter().any(|row| {
                row.step == 0
                    || row.step > data.plan.planned_steps
                    || data.plan.entity_ids.binary_search(&row.entity_id).is_err()
                    || row
                        .sensor_offset_m
                        .iter()
                        .any(|value| !value.is_finite() || value.abs() > 50.0)
            })
        {
            return Err(invalid());
        }
        let request = PrepareRequest {
            schema_version: "crebain.simulation.prepare-request.v1".to_owned(),
            run_id: format!("ncp.{}", self.binding.run_id),
            drone_ids: data.plan.entity_ids.clone(),
            tick_ms: data.plan.step_us / 1_000,
            max_ticks: data.plan.planned_steps,
            initial_position_m: configuration.initial_position_m.clone(),
            initial_velocity_mps: configuration.initial_velocity_mps.clone(),
            sensor_variance_m2: configuration.sensor_variance_m2.clone(),
        };
        validate_prepare_request(&request).map_err(|_| invalid())?;
        Ok((data.plan, configuration, request))
    }

    fn neural_binding(&self, configuration: &BodyConfiguration) -> LocalBinding {
        LocalBinding {
            profile_digest: self.binding.profile_digest.clone(),
            run_id: self.binding.run_id.clone(),
            generation: configuration.expected_neural_generation.clone(),
            role: LocalRole::Neural,
        }
    }

    fn step_input(
        &self,
        body: &Value,
    ) -> Result<(BodyStep, NeuralProposal, StepRequest), LocalError> {
        let active = self.active.as_ref().ok_or(LocalError(LocalCode::State))?;
        let step: BodyStep = decode(body)?;
        let expected_binding = self.neural_binding(&active.configuration);
        let mut expected_request = LocalRequest {
            schema: "ncp.local.request.v1".to_owned(),
            profile_digest: expected_binding.profile_digest.clone(),
            run_id: expected_binding.run_id.clone(),
            generation: expected_binding.generation.clone(),
            sequence: active.snapshot.step + 2,
            operation: LocalOperation::Step,
            body: serde_json::to_value(NeuralStep {
                source_snapshot: active.snapshot.clone(),
            })
            .map_err(|_| invalid())?,
            request_digest: String::new(),
        };
        expected_request.seal()?;
        step.neural_response
            .verify(&expected_binding, &expected_request)?;
        if step.neural_response.outcome != LocalOutcome::Committed {
            return Err(invalid());
        }
        let proposal: NeuralProposal = decode(&step.neural_response.body)?;
        proposal.validate(&active.plan, &active.snapshot)?;
        let count = active.plan.entity_ids.len();
        let mut request = StepRequest {
            schema_version: "crebain.simulation.step-request.v1".to_owned(),
            run_id: format!("ncp.{}", self.binding.run_id),
            tick_index: proposal.step,
            drone_ids: active.plan.entity_ids.clone(),
            actuator_intent_acceleration_mps2: proposal.values.clone(),
            sensor_offset_m: vec![0.0; count * 3],
            fault_codes: vec![FaultCode::None; count],
        };
        for row in active
            .configuration
            .schedule
            .iter()
            .filter(|row| row.step == proposal.step)
        {
            let index = active
                .plan
                .entity_ids
                .binary_search(&row.entity_id)
                .map_err(|_| invalid())?;
            request.sensor_offset_m[index * 3..(index + 1) * 3]
                .copy_from_slice(&row.sensor_offset_m);
            request.fault_codes[index] = match (row.sensor_available, row.actuator_available) {
                (true, true) => FaultCode::None,
                (false, true) => FaultCode::SensorDropout,
                (true, false) => FaultCode::ActuatorHold,
                (false, false) => FaultCode::Combined,
            };
        }
        active
            .kernel
            .validate_step(&request)
            .map_err(|_| invalid())?;
        Ok((step, proposal, request))
    }

    fn finish_input(&self, body: &Value) -> Result<FinishRequest, LocalError> {
        let active = self.active.as_ref().ok_or(LocalError(LocalCode::State))?;
        let data: FinishData = decode(body)?;
        if data.plan_digest != active.plan.digest()?
            || data.completed_steps != active.plan.planned_steps
            || data.completed_steps != active.snapshot.step
        {
            return Err(invalid());
        }
        let request = FinishRequest {
            schema_version: "crebain.simulation.finish-request.v1".to_owned(),
            run_id: format!("ncp.{}", self.binding.run_id),
            tick_index: data.completed_steps,
            reason: "completed".to_owned(),
        };
        active
            .kernel
            .validate_finish(&request)
            .map_err(|_| invalid())?;
        Ok(request)
    }
}

impl LocalBackend for BodyBackend {
    fn validate(&self, operation: LocalOperation, body: &Value) -> Result<(), LocalError> {
        if self.retired {
            return Err(LocalError(LocalCode::Retired));
        }
        match operation {
            LocalOperation::Prepare if self.active.is_none() => {
                self.prepare_input(body).map(|_| ())
            }
            LocalOperation::Step => self.step_input(body).map(|_| ()),
            LocalOperation::Finish => self.finish_input(body).map(|_| ()),
            LocalOperation::Abort => decode::<EmptyData>(body).map(|_| ()),
            _ => Err(LocalError(LocalCode::State)),
        }
    }

    fn execute(&mut self, operation: LocalOperation, body: &Value) -> Result<Value, LocalError> {
        // Admission failures preserve state. Any failure after admission retires
        // the backend, including when a caller uses this trait directly.
        self.validate(operation, body)?;
        let result =
            (|| match operation {
                LocalOperation::Prepare => {
                    let (plan, configuration, request) = self.prepare_input(body)?;
                    let (kernel, frame) = MultiDroneSimulation::new()
                        .prepare_with_recording(request, InnovationRecording::KalmanInnovationV1)
                        .map_err(|_| LocalError(LocalCode::ExecutionUnknown))?;
                    let snapshot = snapshot_from_kernel(
                        &plan,
                        &frame,
                        kernel
                            .latest_innovations()
                            .ok_or(LocalError(LocalCode::ExecutionUnknown))?,
                    )?;
                    let result = json!({
                        "application_profile": APPLICATION_PROFILE,
                        "plan_digest": plan.digest()?,
                        "snapshot": snapshot,
                    });
                    self.active = Some(ActiveBody {
                        plan,
                        configuration,
                        kernel,
                        snapshot,
                    });
                    Ok(result)
                }
                LocalOperation::Step => {
                    let (step, proposal, request) = self.step_input(body)?;
                    let active = self.active.as_mut().ok_or(LocalError(LocalCode::State))?;
                    let frame = active
                        .kernel
                        .step(request)
                        .map_err(|_| LocalError(LocalCode::ExecutionUnknown))?;
                    let snapshot = snapshot_from_kernel(
                        &active.plan,
                        &frame,
                        active
                            .kernel
                            .latest_innovations()
                            .ok_or(LocalError(LocalCode::ExecutionUnknown))?,
                    )?;
                    let result = BodyResult {
                        schema: "ncp.local.body-result.v1".to_owned(),
                        plan_digest: active.plan.digest()?,
                        step: proposal.step,
                        source_snapshot_digest: active.snapshot.snapshot_digest.clone(),
                        neural_result_digest: step.neural_response.result_digest,
                        selected_modes: proposal.selected_modes,
                        proposed_values: proposal.values,
                        applied_values: frame.actuator_output_acceleration_mps2,
                        saturated: frame.actuator_saturated,
                        snapshot: snapshot.clone(),
                    };
                    result.validate(&active.plan)?;
                    let body = serde_json::to_value(result)
                        .map_err(|_| LocalError(LocalCode::ExecutionUnknown))?;
                    active.snapshot = snapshot;
                    Ok(body)
                }
                LocalOperation::Finish => {
                    let request = self.finish_input(body)?;
                    let active = self.active.take().ok_or(LocalError(LocalCode::State))?;
                    let (finished, _) = active
                        .kernel
                        .finish(request)
                        .map_err(|_| LocalError(LocalCode::ExecutionUnknown))?;
                    self.retired = true;
                    Ok(json!({
                        "plan_digest": active.plan.digest()?,
                        "planned_steps": active.plan.planned_steps,
                        "completed_steps": active.snapshot.step,
                        "snapshot_digest": active.snapshot.snapshot_digest,
                        "cleaned_up": finished.cleaned_up(),
                    }))
                }
                LocalOperation::Abort => {
                    let result = self.active.as_ref().map_or_else(
                    || json!({"completed_steps": 0, "snapshot_digest": null, "cleaned_up": true}),
                    |active| json!({
                        "completed_steps": active.snapshot.step,
                        "snapshot_digest": active.snapshot.snapshot_digest,
                        "cleaned_up": true,
                    }),
                );
                    self.retire();
                    Ok(result)
                }
                _ => Err(LocalError(LocalCode::State)),
            })();
        if result.is_err() {
            self.retire();
        }
        result
    }

    fn retire(&mut self) {
        self.active = None;
        self.retired = true;
    }
}

fn snapshot_from_kernel(
    plan: &RunPlan,
    frame: &SimulationFrameResponse,
    diagnostics: &InnovationFrame,
) -> Result<Snapshot, LocalError> {
    let count = plan.entity_ids.len();
    if frame.drone_ids != plan.entity_ids
        || diagnostics.run_id != frame.run_id
        || diagnostics.tick_index != frame.tick_index
        || diagnostics.entities.len() != count
        || diagnostics.interval_end_ms.checked_mul(1_000) != Some(plan.time_us(frame.tick_index)?)
        || frame.fused_position_m.len() != count * 3
        || frame.fused_velocity_mps.len() != count * 3
        || frame.sensor_input_admitted.len() != count
        || frame.fused_estimate_available.len() != count
    {
        return Err(LocalError(LocalCode::ExecutionUnknown));
    }
    let available: Vec<bool> = frame
        .sensor_input_admitted
        .iter()
        .zip(&frame.fused_estimate_available)
        .map(|(sensor, fused)| *sensor && *fused)
        .collect();
    let mut values = Vec::with_capacity(count * 6);
    let mut innovations = Vec::with_capacity(count);
    for (index, diagnostic) in diagnostics.entities.iter().enumerate() {
        if diagnostic.entity_id != plan.entity_ids[index] {
            return Err(LocalError(LocalCode::ExecutionUnknown));
        }
        if available[index] {
            values.extend_from_slice(&frame.fused_position_m[index * 3..(index + 1) * 3]);
            values.extend_from_slice(&frame.fused_velocity_mps[index * 3..(index + 1) * 3]);
        } else {
            values.extend_from_slice(&[0.0; 6]);
        }
        let (status, nis, source) = match &diagnostic.evidence {
            InnovationEvidence::Observed { sample } => (
                InnovationStatus::Observed,
                Some(sample.nis),
                Some(InnovationSource {
                    sensor_id: diagnostic.sensor_id.clone(),
                    fusion_track_id: sample.fusion_track_id,
                    fusion_sequence: sample.fusion_sequence,
                    measurement_time_us: sample
                        .measurement_timestamp_ms
                        .checked_mul(1_000)
                        .ok_or(LocalError(LocalCode::ExecutionUnknown))?,
                    residual_m: sample.innovation_m,
                    covariance_m2: sample.innovation_covariance_m2,
                }),
            ),
            InnovationEvidence::Unavailable { .. } => (
                if frame.tick_index == 0 && available[index] {
                    InnovationStatus::Birth
                } else {
                    InnovationStatus::Unavailable
                },
                None,
                None,
            ),
        };
        innovations.push(ScalarInnovation {
            entity_id: diagnostic.entity_id.clone(),
            modality: "visual".to_owned(),
            dof: 3,
            status,
            nis,
            source,
        });
    }
    let mut snapshot = Snapshot {
        schema: "ncp.local.snapshot.v1".to_owned(),
        plan_digest: plan.digest()?,
        step: frame.tick_index,
        time_us: plan.time_us(frame.tick_index)?,
        entity_ids: plan.entity_ids.clone(),
        available,
        values,
        innovations,
        snapshot_digest: String::new(),
    };
    snapshot.seal(plan)?;
    Ok(snapshot)
}
