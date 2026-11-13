//! The closed loop: N controllers and K worlds, each a separate process with its own NCP 2
//! session over a pipe pair.
//!
//! Each step, every controller receives the latest observation of its drones and proposes their
//! accelerations; the controllers work at the same time (`call_all`). Then every world applies
//! the proposals of its controllers and names, for each, the identity of the controller response
//! and the state digest that the response was computed from. A world rejects actions computed
//! from another state. Every session writes a transcript, which [`crate::verify`] checks.

use crate::body::{FinishBody, PrepareBody, Proposal, ScheduledInput, StepBody};
use crate::controller::{ControllerPrepare, ControllerResult, ControllerStep};
use crate::{body_contract, controller_contract, Observation};
use ncp::binding::PipeChild;
use ncp::{call_all, Client, Contract, Decoded, Tap};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

/// The largest number of controllers, and of worlds, in one loop.
pub const MAX_PROCESSES: usize = 64;

/// One drone of a world.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DroneConfig {
    /// The drone identifier.
    pub id: String,
    /// The initial ENU position, in meters.
    pub initial_position_m: [f64; 3],
    /// The initial ENU velocity, in meters per second.
    #[serde(default)]
    pub initial_velocity_mps: [f64; 3],
    /// The variances of the drone's visual sensor, in square meters.
    pub sensor_variance_m2: [f64; 3],
    /// The target position that its controller receives, in meters.
    pub target_m: [f64; 3],
}

/// One world: 1 to 3 drones, listed in the order of their identifiers.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorldConfig {
    /// The drones.
    pub drones: Vec<DroneConfig>,
    /// Frozen sensor and actuator inputs, as in the body's `prepare`.
    #[serde(default)]
    pub schedule: Vec<ScheduledInput>,
}

/// One controller process and the drones of one world that it flies.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ControllerConfig {
    /// The program and its arguments. It serves one `crebain.controller` session on its standard
    /// input and output.
    pub command: Vec<String>,
    /// The index of the controller's world.
    pub world: usize,
    /// The drones that it flies, sorted.
    pub drone_ids: Vec<String>,
    /// The controller's own settings.
    #[serde(default)]
    pub parameters: Value,
}

/// A complete loop.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LoopConfig {
    /// Milliseconds of simulated time for each step.
    pub tick_ms: u64,
    /// The number of steps.
    pub steps: u64,
    /// The body program and its arguments; it serves one `crebain.body` session on its standard
    /// input and output.
    pub body_command: Vec<String>,
    /// The worlds.
    pub worlds: Vec<WorldConfig>,
    /// The controllers. Each drone of each world has exactly one controller.
    pub controllers: Vec<ControllerConfig>,
}

impl LoopConfig {
    /// Check the assignment of drones to controllers and the sizes.
    pub fn check(&self) -> Result<(), String> {
        if self.worlds.is_empty() || self.worlds.len() > MAX_PROCESSES {
            return Err("a loop has 1 to 64 worlds".into());
        }
        if self.controllers.is_empty() || self.controllers.len() > MAX_PROCESSES {
            return Err("a loop has 1 to 64 controllers".into());
        }
        if self.body_command.is_empty() || self.controllers.iter().any(|c| c.command.is_empty()) {
            return Err("every command needs a program".into());
        }
        let mut owner: Vec<Vec<Option<usize>>> = Vec::new();
        for (index, world) in self.worlds.iter().enumerate() {
            if !world.drones.windows(2).all(|pair| pair[0].id < pair[1].id) {
                return Err(format!(
                    "world {index}: list the drones in the order of their unique identifiers"
                ));
            }
            owner.push(vec![None; world.drones.len()]);
        }
        for (index, controller) in self.controllers.iter().enumerate() {
            let world = self
                .worlds
                .get(controller.world)
                .ok_or_else(|| format!("controller {index}: no world {}", controller.world))?;
            if controller.drone_ids.is_empty()
                || !controller
                    .drone_ids
                    .windows(2)
                    .all(|pair| pair[0] < pair[1])
            {
                return Err(format!(
                    "controller {index}: drone_ids must be sorted and unique"
                ));
            }
            for drone in &controller.drone_ids {
                let at = world
                    .drones
                    .iter()
                    .position(|d| &d.id == drone)
                    .ok_or_else(|| {
                        format!(
                            "controller {index}: no drone {drone} in world {}",
                            controller.world
                        )
                    })?;
                if owner[controller.world][at].replace(index).is_some() {
                    return Err(format!(
                        "drone {drone} of world {} has two controllers",
                        controller.world
                    ));
                }
            }
        }
        for (index, drones) in owner.iter().enumerate() {
            if drones.iter().any(Option::is_none) {
                return Err(format!("world {index}: every drone needs a controller"));
            }
        }
        Ok(())
    }
}

/// The result of one drone.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct DroneSummary {
    /// The drone identifier.
    pub id: String,
    /// The target, in meters.
    pub target_m: [f64; 3],
    /// The distance between the true initial position and the target, in meters.
    pub initial_error_m: f64,
    /// The distance between the true final position and the target, in meters.
    pub final_error_m: f64,
    /// The true final position, which the controller never receives.
    pub final_position_m: [f64; 3],
}

/// The result of one world.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct WorldSummary {
    /// The kernel's state digest after the last step.
    pub final_state_digest: String,
    /// The drones.
    pub drones: Vec<DroneSummary>,
}

/// The result of a loop.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Summary {
    /// The number of steps.
    pub steps: u64,
    /// Milliseconds of simulated time for each step.
    pub tick_ms: u64,
    /// The worlds.
    pub worlds: Vec<WorldSummary>,
    /// Each controller's description of itself, from its `prepare` result.
    pub controllers: Vec<Value>,
    /// The number of exchanges, `open` and `close` included.
    pub exchanges: u64,
}

/// The files of a loop's output directory that [`crate::verify`] reads.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// Milliseconds of simulated time for each step.
    pub tick_ms: u64,
    /// The number of steps.
    pub steps: u64,
    /// The identity of the body contract.
    pub body_contract: String,
    /// The identity of the controller contract.
    pub controller_contract: String,
    /// For each world, its transcript and drones.
    pub worlds: Vec<ManifestWorld>,
    /// For each controller, its transcript, world, and drones.
    pub controllers: Vec<ManifestController>,
}

/// One world in the manifest.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManifestWorld {
    /// The transcript file name.
    pub transcript: String,
    /// The drones.
    pub drone_ids: Vec<String>,
}

/// One controller in the manifest.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ManifestController {
    /// The transcript file name.
    pub transcript: String,
    /// The index of its world.
    pub world: usize,
    /// Its drones.
    pub drone_ids: Vec<String>,
}

/// A program name without a path is looked up next to the running executable first, so that
/// `crebain-ncp-simulation` and `crebain-ncp-controller` find their installed siblings.
fn program(name: &str) -> PathBuf {
    let path = Path::new(name);
    if path.components().count() == 1 {
        if let Some(sibling) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
            .filter(|sibling| sibling.is_file())
        {
            return sibling;
        }
    }
    path.to_path_buf()
}

/// Start a program and open its session. The channel owns the child process: closing or
/// dropping it ends the child, also when the loop stops early.
fn start(
    command: &[String],
    transcript: &Path,
    contract: &Contract,
) -> Result<Client<PipeChild>, String> {
    let mut process = Command::new(program(&command[0]));
    process.args(&command[1..]);
    let channel = ncp::spawn(process).map_err(|error| format!("{}: {error}", command[0]))?;
    let tap =
        Tap::create(transcript).map_err(|error| format!("{}: {error}", transcript.display()))?;
    let mut client = Client::new(channel.with_tap(Arc::new(tap)), contract);
    client
        .open()
        .map_err(|error| format!("{}: open: {error}", command[0]))?;
    Ok(client)
}

fn bodies<T: for<'de> Deserialize<'de>>(
    results: Vec<Result<Decoded, ncp::Error>>,
    what: &str,
) -> Result<Vec<(String, T)>, String> {
    results
        .into_iter()
        .enumerate()
        .map(|(index, result)| {
            let decoded = result.map_err(|error| format!("{what} {index}: {error}"))?;
            let value = serde_json::from_value(decoded.message["body"].clone())
                .map_err(|error| format!("{what} {index}: result: {error}"))?;
            Ok((decoded.identity, value))
        })
        .collect()
}

#[derive(Deserialize)]
struct WorldResult {
    frame: Value,
    observation: Observation,
}

fn distance(a: &[f64], b: &[f64; 3]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f64>()
        .sqrt()
}

fn position(frame: &Value, index: usize) -> Result<[f64; 3], String> {
    let values = frame["simulated_position_m"]
        .as_array()
        .ok_or("frame without simulated_position_m")?;
    let mut out = [0.0; 3];
    for (axis, slot) in out.iter_mut().enumerate() {
        *slot = values
            .get(index * 3 + axis)
            .and_then(Value::as_f64)
            .ok_or("frame position")?;
    }
    Ok(out)
}

/// Run a loop and write its transcripts, `manifest.json`, `trajectory.jsonl`, and
/// `summary.json` into `out`, which must not exist.
pub fn run(config: &LoopConfig, out: &Path) -> Result<Summary, String> {
    config.check()?;
    fs::create_dir(out).map_err(|error| format!("{}: {error}", out.display()))?;
    let body = body_contract();
    let controller = controller_contract();
    let mut worlds = Vec::new();
    for index in 0..config.worlds.len() {
        let path = out.join(format!("world-{index}.ncpt"));
        worlds.push(start(&config.body_command, &path, &body)?);
    }
    let mut controllers = Vec::new();
    for (index, c) in config.controllers.iter().enumerate() {
        let path = out.join(format!("controller-{index}.ncpt"));
        controllers.push(start(&c.command, &path, &controller)?);
    }
    let mut exchanges = (worlds.len() + controllers.len()) as u64;

    let prepares: Vec<Value> = config
        .worlds
        .iter()
        .map(|world| {
            serde_json::to_value(PrepareBody {
                drone_ids: world.drones.iter().map(|d| d.id.clone()).collect(),
                tick_ms: config.tick_ms,
                planned_steps: config.steps,
                initial_position_m: world
                    .drones
                    .iter()
                    .flat_map(|d| d.initial_position_m)
                    .collect(),
                initial_velocity_mps: world
                    .drones
                    .iter()
                    .flat_map(|d| d.initial_velocity_mps)
                    .collect(),
                sensor_variance_m2: world
                    .drones
                    .iter()
                    .flat_map(|d| d.sensor_variance_m2)
                    .collect(),
                schedule: world.schedule.clone(),
            })
            .map_err(|error| error.to_string())
        })
        .collect::<Result<_, _>>()?;
    let prepared: Vec<(String, WorldResult)> =
        bodies(call_all(&mut worlds, "prepare", prepares), "world")?;
    let initial: Vec<Value> = prepared.iter().map(|(_, r)| r.frame.clone()).collect();
    let mut observations: Vec<Observation> =
        prepared.into_iter().map(|(_, r)| r.observation).collect();

    let controller_prepares: Vec<Value> = config
        .controllers
        .iter()
        .map(|c| {
            let world = &config.worlds[c.world];
            let targets: Vec<f64> = c
                .drone_ids
                .iter()
                .flat_map(|id| {
                    world
                        .drones
                        .iter()
                        .find(|d| &d.id == id)
                        .map(|d| d.target_m)
                        .unwrap_or_default()
                })
                .collect();
            serde_json::to_value(ControllerPrepare {
                drone_ids: c.drone_ids.clone(),
                tick_ms: config.tick_ms,
                targets_m: targets,
                parameters: c.parameters.clone(),
            })
            .map_err(|error| error.to_string())
        })
        .collect::<Result<_, _>>()?;
    let descriptions: Vec<(String, Value)> = bodies(
        call_all(&mut controllers, "prepare", controller_prepares),
        "controller",
    )?;
    exchanges += (worlds.len() + controllers.len()) as u64;

    let mut trajectory =
        fs::File::create(out.join("trajectory.jsonl")).map_err(|error| error.to_string())?;
    let mut last_frames = initial.clone();
    for tick in 1..=config.steps {
        let steps: Vec<ControllerStep> = config
            .controllers
            .iter()
            .map(|c| observations[c.world].controller_step(tick, &c.drone_ids))
            .collect::<Result<_, String>>()?;
        let requests: Vec<Value> = steps
            .iter()
            .map(|s| serde_json::to_value(s).map_err(|error| error.to_string()))
            .collect::<Result<_, _>>()?;
        let proposals: Vec<(String, ControllerResult)> =
            bodies(call_all(&mut controllers, "step", requests), "controller")?;
        for ((_, result), step) in proposals.iter().zip(&steps) {
            result.answers(step)?;
        }

        let mut world_requests = Vec::with_capacity(worlds.len());
        for (index, world) in config.worlds.iter().enumerate() {
            let mut acceleration = vec![0.0; world.drones.len() * 3];
            let mut named = Vec::new();
            for (c, (identity, result)) in config.controllers.iter().zip(&proposals) {
                if c.world != index {
                    continue;
                }
                for (k, drone) in c.drone_ids.iter().enumerate() {
                    let at = world
                        .drones
                        .iter()
                        .position(|d| &d.id == drone)
                        .ok_or("drone")?;
                    acceleration[at * 3..at * 3 + 3]
                        .copy_from_slice(&result.acceleration_mps2[k * 3..k * 3 + 3]);
                }
                named.push(Proposal {
                    response: identity.clone(),
                    drone_ids: c.drone_ids.clone(),
                });
            }
            world_requests.push(
                serde_json::to_value(StepBody {
                    tick_index: tick,
                    source_state_digest: observations[index].state_digest.clone(),
                    actuator_intent_acceleration_mps2: acceleration,
                    proposals: named,
                })
                .map_err(|error| error.to_string())?,
            );
        }
        let results: Vec<(String, WorldResult)> =
            bodies(call_all(&mut worlds, "step", world_requests), "world")?;
        for (index, (_, result)) in results.into_iter().enumerate() {
            let line = json!({
                "tick_index": tick,
                "world": index,
                "position_m": result.frame["simulated_position_m"],
                "estimate_available": result.observation.estimate_available,
                "estimate_m": result.observation.position_m,
                "applied_acceleration_mps2": result.frame["actuator_output_acceleration_mps2"],
            });
            writeln!(trajectory, "{line}").map_err(|error| error.to_string())?;
            last_frames[index] = result.frame;
            observations[index] = result.observation;
        }
        exchanges += (worlds.len() + controllers.len()) as u64;
    }

    let finishes = vec![
        json!(FinishBody {
            completed_steps: config.steps
        });
        worlds.len()
    ];
    let finished: Vec<(String, Value)> =
        bodies(call_all(&mut worlds, "finish", finishes), "world")?;
    exchanges += worlds.len() as u64;
    for (index, (_, record)) in finished.iter().enumerate() {
        if record["finish"]["cleaned_up"] != true {
            return Err(format!("world {index} did not clean up"));
        }
    }
    for client in worlds.iter_mut().chain(controllers.iter_mut()) {
        // Closing the session closes the channel, which ends the child process.
        client.close().map_err(|error| format!("close: {error}"))?;
        exchanges += 1;
        match client.channel_mut().exit_status() {
            Some(status) if status.success() => {}
            Some(status) => return Err(format!("a process exited with {status}")),
            None => return Err("a process did not exit".into()),
        }
    }

    let summary = Summary {
        steps: config.steps,
        tick_ms: config.tick_ms,
        worlds: config
            .worlds
            .iter()
            .enumerate()
            .map(|(w, world)| {
                Ok(WorldSummary {
                    final_state_digest: observations[w].state_digest.clone(),
                    drones: world
                        .drones
                        .iter()
                        .enumerate()
                        .map(|(i, drone)| {
                            let start = position(&initial[w], i)?;
                            let end = position(&last_frames[w], i)?;
                            Ok(DroneSummary {
                                id: drone.id.clone(),
                                target_m: drone.target_m,
                                initial_error_m: distance(&start, &drone.target_m),
                                final_error_m: distance(&end, &drone.target_m),
                                final_position_m: end,
                            })
                        })
                        .collect::<Result<_, String>>()?,
                })
            })
            .collect::<Result<_, String>>()?,
        controllers: descriptions
            .into_iter()
            .map(|(_, d)| d["controller"].clone())
            .collect(),
        exchanges,
    };
    let manifest = Manifest {
        tick_ms: config.tick_ms,
        steps: config.steps,
        body_contract: body.identity,
        controller_contract: controller.identity,
        worlds: config
            .worlds
            .iter()
            .enumerate()
            .map(|(w, world)| ManifestWorld {
                transcript: format!("world-{w}.ncpt"),
                drone_ids: world.drones.iter().map(|d| d.id.clone()).collect(),
            })
            .collect(),
        controllers: config
            .controllers
            .iter()
            .enumerate()
            .map(|(c, controller)| ManifestController {
                transcript: format!("controller-{c}.ncpt"),
                world: controller.world,
                drone_ids: controller.drone_ids.clone(),
            })
            .collect(),
    };
    let write = |name: &str, value: Value| {
        fs::write(out.join(name), format!("{value:#}\n"))
            .map_err(|error| format!("{name}: {error}"))
    };
    write(
        "manifest.json",
        serde_json::to_value(&manifest).map_err(|e| e.to_string())?,
    )?;
    write(
        "summary.json",
        serde_json::to_value(&summary).map_err(|e| e.to_string())?,
    )?;
    Ok(summary)
}
