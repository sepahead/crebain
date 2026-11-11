//! The `crebain.controller` contract and a reference controller.
//!
//! A controller receives the world's observation of its drones and proposes one acceleration for
//! each. Any program that implements the contract can fly the drones, for example a spiking
//! network in NEST. The reference controller here is a deterministic proportional-derivative
//! law, for tests and as a baseline; it is not a neural network.

use ncp::{Decoded, Handler, Reply};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The largest proposed acceleration component that the body admits, in m/s^2.
pub const MAX_ACCELERATION_MPS2: f64 = 50.0;

/// The body of a controller `prepare` request.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ControllerPrepare {
    /// 1 to 3 sorted, unique drone identifiers of one world.
    pub drone_ids: Vec<String>,
    /// Milliseconds of simulated time for each step.
    pub tick_ms: u64,
    /// 3 target position components for each drone, in meters.
    pub targets_m: Vec<f64>,
    /// The controller's own settings.
    #[serde(default)]
    pub parameters: Value,
}

/// The body of a controller `step` request: the world's observation of the controller's drones.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ControllerStep {
    /// The step that the proposed actions will drive.
    pub tick_index: u64,
    /// The state digest of the world's observation.
    pub source_state_digest: String,
    /// The controller's drones.
    pub drone_ids: Vec<String>,
    /// For each drone, whether the world has an estimate of it.
    pub estimate_available: Vec<bool>,
    /// 3 estimated position components for each drone, in meters.
    pub position_m: Vec<f64>,
    /// 3 estimated velocity components for each drone, in meters per second.
    pub velocity_mps: Vec<f64>,
}

/// The result of a controller `step`.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ControllerResult {
    /// The request's `tick_index`.
    pub tick_index: u64,
    /// The request's `source_state_digest`.
    pub source_state_digest: String,
    /// The request's `drone_ids`.
    pub drone_ids: Vec<String>,
    /// 3 proposed acceleration components for each drone, in m/s^2.
    pub acceleration_mps2: Vec<f64>,
}

impl ControllerResult {
    /// Check that the result answers `step` and holds finite, bounded accelerations.
    pub fn answers(&self, step: &ControllerStep) -> Result<(), String> {
        if self.tick_index != step.tick_index
            || self.source_state_digest != step.source_state_digest
            || self.drone_ids != step.drone_ids
        {
            return Err("the controller result does not echo its request".into());
        }
        if self.acceleration_mps2.len() != step.drone_ids.len() * 3
            || self.acceleration_mps2.iter().any(|a| {
                !a.is_finite()
                    || a.abs() > MAX_ACCELERATION_MPS2
                    || (*a == 0.0 && a.is_sign_negative())
            })
        {
            return Err("acceleration_mps2 needs 3 finite components of at most 50, without negative zero, for each drone".into());
        }
        Ok(())
    }
}

/// Settings of the reference controller, from the `parameters` of `prepare`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Gains {
    /// Proportional gain, in 1/s^2.
    #[serde(default = "Gains::default_kp")]
    pub kp: f64,
    /// Derivative gain, in 1/s.
    #[serde(default = "Gains::default_kd")]
    pub kd: f64,
    /// The largest acceleration component that the controller proposes, in m/s^2.
    #[serde(default = "Gains::default_max")]
    pub max_acceleration_mps2: f64,
}

impl Gains {
    fn default_kp() -> f64 {
        1.0
    }
    fn default_kd() -> f64 {
        2.0
    }
    fn default_max() -> f64 {
        5.0
    }

    fn valid(&self) -> bool {
        self.kp.is_finite()
            && self.kd.is_finite()
            && self.kp >= 0.0
            && self.kd >= 0.0
            && self.max_acceleration_mps2 > 0.0
            && self.max_acceleration_mps2 <= MAX_ACCELERATION_MPS2
    }
}

/// Check a controller `prepare` body: 1 to 3 sorted unique drones and finite targets.
pub fn check_prepare(prepare: &ControllerPrepare) -> Result<(), String> {
    let ids = &prepare.drone_ids;
    if !(1..=3).contains(&ids.len()) || !ids.windows(2).all(|pair| pair[0] < pair[1]) {
        return Err("drone_ids must be 1 to 3 sorted, unique identifiers".into());
    }
    if prepare.tick_ms == 0
        || prepare.targets_m.len() != ids.len() * 3
        || prepare.targets_m.iter().any(|value| !value.is_finite())
    {
        return Err(
            "tick_ms must be positive and targets_m needs 3 finite components for each drone"
                .into(),
        );
    }
    Ok(())
}

/// Check a controller `step` body against the prepared drones and the previous step.
pub fn check_step(
    prepare: &ControllerPrepare,
    last: u64,
    step: &ControllerStep,
) -> Result<(), String> {
    let count = prepare.drone_ids.len();
    if step.tick_index != last + 1 {
        return Err(format!("tick_index must be {}", last + 1));
    }
    if step.drone_ids != prepare.drone_ids
        || step.estimate_available.len() != count
        || step.position_m.len() != count * 3
        || step.velocity_mps.len() != count * 3
        || step
            .position_m
            .iter()
            .chain(&step.velocity_mps)
            .any(|value| !value.is_finite())
        || !crate::is_identity(&step.source_state_digest)
    {
        return Err(
            "the step must name the prepared drones with finite values and a state digest".into(),
        );
    }
    Ok(())
}

/// A deterministic proportional-derivative controller: for each drone with an estimate,
/// `a = clamp(kp (target - position) - kd velocity)`; for a drone without one, `a = 0`.
#[derive(Default)]
pub struct Reference {
    prepared: Option<(ControllerPrepare, Gains)>,
    last: u64,
}

impl Reference {
    fn gains(prepare: &ControllerPrepare) -> Result<Gains, String> {
        let parameters = if prepare.parameters.is_null() {
            json!({})
        } else {
            prepare.parameters.clone()
        };
        let gains: Gains = serde_json::from_value(parameters).map_err(|error| error.to_string())?;
        if gains.valid() {
            Ok(gains)
        } else {
            Err("kp and kd must be finite and non-negative; max_acceleration_mps2 from above 0 to 50".into())
        }
    }

    fn check(&self, op: &str, request: &Decoded) -> Result<(), String> {
        let body = request.message["body"].clone();
        match (op, &self.prepared) {
            ("prepare", None) => {
                let prepare: ControllerPrepare =
                    serde_json::from_value(body).map_err(|error| error.to_string())?;
                check_prepare(&prepare)?;
                Self::gains(&prepare).map(|_| ())
            }
            ("step", Some((prepare, _))) => {
                let step: ControllerStep =
                    serde_json::from_value(body).map_err(|error| error.to_string())?;
                check_step(prepare, self.last, &step)
            }
            ("prepare", Some(_)) => Err("the controller is prepared".into()),
            _ => Err("prepare first".into()),
        }
    }

    /// The proposed accelerations for one observation.
    pub fn propose(prepare: &ControllerPrepare, gains: &Gains, step: &ControllerStep) -> Vec<f64> {
        let mut acceleration = vec![0.0; step.position_m.len()];
        for (index, available) in step.estimate_available.iter().enumerate() {
            if !available {
                continue;
            }
            for axis in 0..3 {
                let at = index * 3 + axis;
                let error = prepare.targets_m[at] - step.position_m[at];
                let value = gains.kp * error - gains.kd * step.velocity_mps[at];
                // `+ 0.0` turns a negative zero into zero, which the world requires.
                acceleration[at] =
                    value.clamp(-gains.max_acceleration_mps2, gains.max_acceleration_mps2) + 0.0;
            }
        }
        acceleration
    }
}

impl Handler for Reference {
    fn validate(&mut self, op: &str, request: &Decoded) -> Result<(), String> {
        self.check(op, request)
    }

    fn execute(
        &mut self,
        op: &str,
        request: &Decoded,
    ) -> Result<Reply, Box<dyn std::error::Error + Send + Sync>> {
        self.check(op, request)?;
        let body = request.message["body"].clone();
        if op == "prepare" {
            let prepare: ControllerPrepare = serde_json::from_value(body)?;
            let gains = Self::gains(&prepare)?;
            let reply = json!({
                "controller": {"kind": "reference proportional-derivative law", "gains": gains},
                "drone_ids": prepare.drone_ids,
            });
            self.prepared = Some((prepare, gains));
            return Ok(reply.into());
        }
        let step: ControllerStep = serde_json::from_value(body)?;
        let (prepare, gains) = self.prepared.as_ref().ok_or("prepare first")?;
        let result = ControllerResult {
            tick_index: step.tick_index,
            source_state_digest: step.source_state_digest.clone(),
            drone_ids: step.drone_ids.clone(),
            acceleration_mps2: Self::propose(prepare, gains, &step),
        };
        self.last = step.tick_index;
        Ok(serde_json::to_value(result)?.into())
    }
}
