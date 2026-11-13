//! The owner side of one `crebain.body` session: the CREBAIN simulation kernel behind NCP 2.
//!
//! NCP 2 gives each request its identity, executes it at most once, and keeps its response
//! until the next request acknowledges it. This module adds the application rules: a frozen
//! configuration and schedule, steps in order, and actions only from the current state.

use crate::{is_identity, Observation};
use crebain_managed_simulation::{
    validate_prepare_request, FaultCode, FinishRequest, InnovationRecording, MultiDroneSimulation,
    Outcome, PrepareRequest, Prepared, SimulationFrameResponse, StepRequest,
};
use ncp::{declined, AppError, Handler, Invalid, Reply, Request};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

/// The most schedule rows that one preparation admits.
pub const MAX_SCHEDULE_ROWS: usize = 256;
/// The largest magnitude of a scheduled sensor offset component, in meters.
pub const MAX_SENSOR_OFFSET_ABS_M: f64 = 50.0;
/// The kernel's run label. It is the same for every session, so that equal inputs give equal
/// state digests in every run; the NCP session identifier distinguishes the runs.
pub const KERNEL_RUN_ID: &str = "crebain.ncp2-body";

const PREPARE_SCHEMA: &str = "crebain.simulation.prepare-request.v1";
const STEP_SCHEMA: &str = "crebain.simulation.step-request.v1";
const FINISH_SCHEMA: &str = "crebain.simulation.finish-request.v1";

/// One frozen sensor or actuator input of one drone at one step.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScheduledInput {
    /// The step at which the row applies, from 1 to `planned_steps`.
    pub step: u64,
    /// A prepared drone.
    pub drone_id: String,
    /// The offset of the simulated visual measurement, in ENU meters.
    pub sensor_offset_m: [f64; 3],
    /// Whether the sensor supplies its measurement at this step.
    pub sensor_available: bool,
    /// Whether the simulator applies the proposed acceleration at this step.
    pub actuator_available: bool,
}

/// The body of a `prepare` request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PrepareBody {
    /// 1 to 3 sorted, unique drone identifiers.
    pub drone_ids: Vec<String>,
    /// Milliseconds of simulated time for each step.
    pub tick_ms: u64,
    /// The number of steps of the run.
    pub planned_steps: u64,
    /// 3 ENU components for each drone, in meters.
    pub initial_position_m: Vec<f64>,
    /// 3 ENU components for each drone, in meters per second.
    pub initial_velocity_mps: Vec<f64>,
    /// 3 variances of the visual sensor for each drone, in square meters.
    pub sensor_variance_m2: Vec<f64>,
    /// Frozen sensor and actuator inputs; steps without a row use neither offset nor fault.
    #[serde(default)]
    pub schedule: Vec<ScheduledInput>,
}

/// One controller response that a step applies, and the drones that it moves.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Proposal {
    /// The identity of the controller's response frame.
    pub response: String,
    /// The drones that this response moves.
    pub drone_ids: Vec<String>,
}

/// The body of a `step` request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StepBody {
    /// The next step.
    pub tick_index: u64,
    /// The state digest of the observation from which the actions were computed.
    pub source_state_digest: String,
    /// 3 components for each drone, in drone order, in meters per second squared.
    pub actuator_intent_acceleration_mps2: Vec<f64>,
    /// The controller responses that this step applies.
    pub proposals: Vec<Proposal>,
}

/// The body of a `finish` request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FinishBody {
    /// The number of steps run; it must equal `planned_steps`.
    pub completed_steps: u64,
}

struct Active {
    prepare: PrepareBody,
    kernel: MultiDroneSimulation<Prepared>,
    tick: u64,
    state_digest: String,
}

/// The application side of one `crebain.body` session.
#[derive(Default)]
pub struct Body {
    active: Option<Active>,
    finished: bool,
}

fn parse<T: DeserializeOwned>(body: &Value) -> Result<T, String> {
    serde_json::from_value(body.clone()).map_err(|error| error.to_string())
}

fn prepare_request(body: &PrepareBody) -> Result<PrepareRequest, String> {
    let ids = &body.drone_ids;
    if ids.is_empty() || !ids.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err("drone_ids must be non-empty, sorted, and unique".into());
    }
    if body.schedule.len() > MAX_SCHEDULE_ROWS
        || !body
            .schedule
            .windows(2)
            .all(|rows| (rows[0].step, &rows[0].drone_id) < (rows[1].step, &rows[1].drone_id))
    {
        return Err(
            "the schedule must have at most 256 rows sorted by (step, drone_id), without repeats"
                .into(),
        );
    }
    for row in &body.schedule {
        if row.step == 0
            || row.step > body.planned_steps
            || ids.binary_search(&row.drone_id).is_err()
            || row
                .sensor_offset_m
                .iter()
                .any(|value| !value.is_finite() || value.abs() > MAX_SENSOR_OFFSET_ABS_M)
        {
            return Err(format!(
                "schedule row of step {} for {}: step, drone, or offset out of range",
                row.step, row.drone_id
            ));
        }
    }
    let request = PrepareRequest {
        schema_version: PREPARE_SCHEMA.to_owned(),
        run_id: KERNEL_RUN_ID.to_owned(),
        drone_ids: ids.clone(),
        tick_ms: body.tick_ms,
        max_ticks: body.planned_steps,
        initial_position_m: body.initial_position_m.clone(),
        initial_velocity_mps: body.initial_velocity_mps.clone(),
        sensor_variance_m2: body.sensor_variance_m2.clone(),
    };
    validate_prepare_request(&request).map_err(|error| format!("kernel: {error}"))?;
    Ok(request)
}

fn step_request(active: &Active, body: &StepBody) -> Result<StepRequest, String> {
    let ids = &active.prepare.drone_ids;
    if body.tick_index != active.tick + 1 {
        return Err(format!("tick_index must be {}", active.tick + 1));
    }
    if body.source_state_digest != active.state_digest {
        return Err("source_state_digest is not the current state digest".into());
    }
    if body.actuator_intent_acceleration_mps2.len() != ids.len() * 3 {
        return Err("actuator_intent_acceleration_mps2 needs 3 components for each drone".into());
    }
    let mut covered = vec![false; ids.len()];
    let mut responses: Vec<&str> = Vec::with_capacity(body.proposals.len());
    for proposal in &body.proposals {
        if !is_identity(&proposal.response) || responses.contains(&proposal.response.as_str()) {
            return Err("each proposal names a distinct response identity".into());
        }
        responses.push(&proposal.response);
        if proposal.drone_ids.is_empty() {
            return Err("a proposal moves at least one drone".into());
        }
        for drone in &proposal.drone_ids {
            let index = ids
                .binary_search(drone)
                .map_err(|_| format!("unknown drone {drone}"))?;
            if std::mem::replace(&mut covered[index], true) {
                return Err(format!("drone {drone} is in two proposals"));
            }
        }
    }
    if !covered.iter().all(|done| *done) {
        return Err("every drone needs exactly one proposal".into());
    }
    let count = ids.len();
    let mut request = StepRequest {
        schema_version: STEP_SCHEMA.to_owned(),
        run_id: KERNEL_RUN_ID.to_owned(),
        tick_index: body.tick_index,
        drone_ids: ids.clone(),
        actuator_intent_acceleration_mps2: body.actuator_intent_acceleration_mps2.clone(),
        sensor_offset_m: vec![0.0; count * 3],
        fault_codes: vec![FaultCode::None; count],
    };
    for row in active
        .prepare
        .schedule
        .iter()
        .filter(|row| row.step == body.tick_index)
    {
        let index = ids
            .binary_search(&row.drone_id)
            .map_err(|_| "schedule drone".to_owned())?;
        request.sensor_offset_m[index * 3..index * 3 + 3].copy_from_slice(&row.sensor_offset_m);
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
        .map_err(|error| format!("kernel: {error}"))?;
    Ok(request)
}

fn finish_request(active: &Active, body: &FinishBody) -> Result<FinishRequest, String> {
    if body.completed_steps != active.prepare.planned_steps || body.completed_steps != active.tick {
        return Err(format!(
            "completed_steps must equal planned_steps ({}) and the steps run ({})",
            active.prepare.planned_steps, active.tick
        ));
    }
    let request = FinishRequest {
        schema_version: FINISH_SCHEMA.to_owned(),
        run_id: KERNEL_RUN_ID.to_owned(),
        tick_index: active.tick,
        reason: "completed".to_owned(),
    };
    active
        .kernel
        .validate_finish(&request)
        .map_err(|error| format!("kernel: {error}"))?;
    Ok(request)
}

/// The observation of a frame: the filter's estimate of each drone whose sensor the step
/// admitted and whose estimate is available, and zeros otherwise.
pub fn observe(frame: &SimulationFrameResponse) -> Result<Observation, String> {
    let count = frame.drone_ids.len();
    if frame.sensor_input_admitted.len() != count
        || frame.fused_estimate_available.len() != count
        || frame.fused_position_m.len() != count * 3
        || frame.fused_velocity_mps.len() != count * 3
    {
        return Err("frame lengths".into());
    }
    let available: Vec<bool> = frame
        .sensor_input_admitted
        .iter()
        .zip(&frame.fused_estimate_available)
        .map(|(sensor, estimate)| *sensor && *estimate)
        .collect();
    let mut position_m = vec![0.0; count * 3];
    let mut velocity_mps = vec![0.0; count * 3];
    for (index, _) in available.iter().enumerate().filter(|(_, a)| **a) {
        let range = index * 3..index * 3 + 3;
        position_m[range.clone()].copy_from_slice(&frame.fused_position_m[range.clone()]);
        velocity_mps[range.clone()].copy_from_slice(&frame.fused_velocity_mps[range]);
    }
    Ok(Observation {
        tick_index: frame.tick_index,
        state_digest: frame.state_digest.clone(),
        drone_ids: frame.drone_ids.clone(),
        estimate_available: available,
        position_m,
        velocity_mps,
    })
}

fn result(
    frame: &SimulationFrameResponse,
    kernel: &MultiDroneSimulation<Prepared>,
) -> Result<Value, String> {
    if frame.outcome != Outcome::Succeeded {
        return Err(format!(
            "kernel outcome {:?}: {}",
            frame.outcome, frame.reason
        ));
    }
    Ok(json!({
        "frame": frame,
        "innovations": kernel.latest_innovations().ok_or("no innovation frame")?,
        "observation": observe(frame)?,
    }))
}

impl Body {
    fn check(&self, op: &str, body: &Value) -> Result<(), String> {
        if self.finished {
            return Err("the run is finished".into());
        }
        match (op, &self.active) {
            ("prepare", None) => prepare_request(&parse(body)?).map(|_| ()),
            ("step", Some(active)) => step_request(active, &parse(body)?).map(|_| ()),
            ("finish", Some(active)) => finish_request(active, &parse(body)?).map(|_| ()),
            ("prepare", Some(_)) => Err("the run is prepared".into()),
            _ => Err("prepare first".into()),
        }
    }

    fn run(&mut self, op: &str, body: &Value) -> Result<Value, String> {
        self.check(op, body)?;
        match op {
            "prepare" => {
                let body: PrepareBody = parse(body)?;
                let (kernel, frame) = MultiDroneSimulation::new()
                    .prepare_with_recording(
                        prepare_request(&body)?,
                        InnovationRecording::KalmanInnovationV1,
                    )
                    .map_err(|error| format!("kernel: {error}"))?;
                let value = result(&frame, &kernel)?;
                self.active = Some(Active {
                    prepare: body,
                    kernel,
                    tick: 0,
                    state_digest: frame.state_digest,
                });
                Ok(value)
            }
            "step" => {
                let active = self.active.as_mut().ok_or("prepare first")?;
                let step = step_request(active, &parse(body)?)?;
                let frame = active
                    .kernel
                    .step(step)
                    .map_err(|error| format!("kernel: {error}"))?;
                let value = result(&frame, &active.kernel)?;
                active.tick = frame.tick_index;
                active.state_digest = frame.state_digest;
                Ok(value)
            }
            "finish" => {
                let active = self.active.take().ok_or("prepare first")?;
                let finish = finish_request(&active, &parse(body)?)?;
                self.finished = true;
                let (finished, record) = active
                    .kernel
                    .finish(finish)
                    .map_err(|error| format!("kernel: {error}"))?;
                if record.outcome != Outcome::Succeeded || !finished.cleaned_up() {
                    return Err("the kernel did not finish cleanly".into());
                }
                Ok(json!({"finish": record, "completed_steps": active.tick}))
            }
            _ => Err(format!("unknown operation {op}")),
        }
    }
}

impl Handler for Body {
    /// A request that breaks a rule of the body is declined: it never runs, and the session
    /// goes on (NCP 2, rule 7.3.12).
    fn validate(&mut self, request: &Request<'_>) -> Result<(), Invalid> {
        self.check(request.op, request.body).map_err(declined)
    }

    fn execute(&mut self, request: &Request<'_>) -> Result<Reply, AppError> {
        // A failure after validation ends the session with owner_failure; the body then keeps
        // no state that a later session could use.
        self.run(request.op, request.body)
            .map(Reply::from)
            .map_err(|error| {
                self.active = None;
                self.finished = true;
                error.into()
            })
    }
}
