//! The CREBAIN simulation kernel as an NCP 2 owner, a reference controller, and a closed-loop
//! host that couples controllers, for example neural networks, with simulated drones.
//!
//! - [`body`]: the `crebain.body` owner over the managed-simulation kernel: 1 to 3 drones in one
//!   world, a frozen configuration and schedule, and steps that apply only actions computed from
//!   the current state.
//! - [`controller`]: the `crebain.controller` contract and a deterministic reference controller.
//! - [`host`]: the loop of N controllers and K worlds, with one transcript for each session.
//! - [`verify`]: an offline check, from the transcripts alone, that every applied action came
//!   from the controller response that the step names, computed from the observation that the
//!   world reported.
//!
//! The body is simulator-only. It opens no network listener and supplies no physical authority.

#![forbid(unsafe_code)]

pub mod body;
pub mod controller;
pub mod host;
pub mod verify;

use serde::{Deserialize, Serialize};

/// The exact bytes of the `crebain.body` contract, version 1.
pub const BODY_CONTRACT: &[u8] = include_bytes!("../contracts/crebain.body.v1.json");
/// The exact bytes of the `crebain.controller` contract, version 1.
pub const CONTROLLER_CONTRACT: &[u8] = include_bytes!("../contracts/crebain.controller.v1.json");
/// The application name of the body contract.
pub const BODY_APPLICATION: &str = "crebain.body";
/// The application name of the controller contract.
pub const CONTROLLER_APPLICATION: &str = "crebain.controller";

/// The parsed body contract.
pub fn body_contract() -> ncp::Contract {
    ncp::Contract::from_bytes(BODY_CONTRACT.to_vec()).expect("the body contract is an NCP contract")
}

/// The parsed controller contract.
pub fn controller_contract() -> ncp::Contract {
    ncp::Contract::from_bytes(CONTROLLER_CONTRACT.to_vec())
        .expect("the controller contract is an NCP contract")
}

/// Whether `value` is an identity: 64 lowercase hexadecimal characters.
pub fn is_identity(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// What a world reports after each step: the filter's estimate of each drone.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    /// The step of the observation; 0 after `prepare`.
    pub tick_index: u64,
    /// The kernel's state digest after the step.
    pub state_digest: String,
    /// The world's drones, in order.
    pub drone_ids: Vec<String>,
    /// For each drone, whether its sensor was admitted and its estimate is available.
    pub estimate_available: Vec<bool>,
    /// 3 estimated position components for each drone; zeros without an estimate.
    pub position_m: Vec<f64>,
    /// 3 estimated velocity components for each drone; zeros without an estimate.
    pub velocity_mps: Vec<f64>,
}

impl Observation {
    /// The controller request that this observation gives for the drones `drone_ids`, in their
    /// order, and the step `tick_index`.
    pub fn controller_step(
        &self,
        tick_index: u64,
        drone_ids: &[String],
    ) -> Result<controller::ControllerStep, String> {
        let mut step = controller::ControllerStep {
            tick_index,
            source_state_digest: self.state_digest.clone(),
            drone_ids: drone_ids.to_vec(),
            estimate_available: Vec::with_capacity(drone_ids.len()),
            position_m: Vec::with_capacity(drone_ids.len() * 3),
            velocity_mps: Vec::with_capacity(drone_ids.len() * 3),
        };
        for drone in drone_ids {
            let index = self
                .drone_ids
                .iter()
                .position(|id| id == drone)
                .ok_or_else(|| format!("drone {drone} is not in the world"))?;
            step.estimate_available.push(self.estimate_available[index]);
            step.position_m
                .extend_from_slice(&self.position_m[index * 3..index * 3 + 3]);
            step.velocity_mps
                .extend_from_slice(&self.velocity_mps[index * 3..index * 3 + 3]);
        }
        Ok(step)
    }
}
