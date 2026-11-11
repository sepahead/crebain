//! An offline check of a loop's transcripts.
//!
//! For every step of every world, it checks the chain: the world's previous observation, the
//! controller requests that carry exactly that observation of their drones, the controller
//! responses that the step names, and the step's accelerations, which must equal the responses'
//! accelerations bit for bit. It also checks each transcript with the NCP 2 transcript verifier.
//!
//! Transcripts are not signed: the check finds damaged or inconsistent records and mismatched
//! sessions, not a complete, consistent forgery of every file.

use crate::body::{FinishBody, PrepareBody, StepBody};
use crate::controller::{ControllerResult, ControllerStep};
use crate::host::Manifest;
use crate::{body_contract, controller_contract, Observation};
use ncp::frame::{decode, MAX_BOUND};
use ncp::transcript::{read, verify as verify_transcript, RECEIVED, SENT};
use ncp::Decoded;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// What the check covered.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Report {
    /// The number of worlds.
    pub worlds: usize,
    /// The number of controllers.
    pub controllers: usize,
    /// The number of steps of each world.
    pub steps: u64,
    /// The number of controller responses whose actions a world applied.
    pub proposals: u64,
}

/// One exchange of a transcript: the request that the client sent and the response it received.
struct Exchange {
    request: Decoded,
    response: Decoded,
}

fn exchanges(path: &Path, application: &str, contract: &str) -> Result<Vec<Exchange>, String> {
    let name = path.display();
    let sessions = verify_transcript(path).map_err(|error| format!("{name}: {error}"))?;
    if sessions.len() != 1 {
        return Err(format!(
            "{name}: {} sessions instead of one",
            sessions.len()
        ));
    }
    for (session, report) in &sessions {
        if !report.problems.is_empty() || report.role != "client" {
            return Err(format!("{name}: session {session}: {:?}", report.problems));
        }
    }
    let mut out = Vec::new();
    let mut pending: Option<Decoded> = None;
    for record in read(path).map_err(|error| format!("{name}: {error}"))? {
        let decoded =
            decode(record.frame, MAX_BOUND).map_err(|error| format!("{name}: {error}"))?;
        match (record.kind, pending.take()) {
            (SENT, None) => pending = Some(decoded),
            (RECEIVED, Some(request)) => out.push(Exchange {
                request,
                response: decoded,
            }),
            _ => return Err(format!("{name}: requests and responses do not alternate")),
        }
    }
    if pending.is_some() {
        return Err(format!("{name}: the last request has no response"));
    }
    for exchange in &out {
        let (request, response) = (&exchange.request.message, &exchange.response.message);
        if response["outcome"] != "ok" || response["request"] != exchange.request.identity.as_str()
        {
            return Err(format!(
                "{name}: seq {}: not an ok response to its request",
                request["seq"]
            ));
        }
    }
    let open = out.first().ok_or_else(|| format!("{name}: empty"))?;
    if open.request.message["op"] != "open"
        || open.request.message["body"]["application"] != application
        || open.request.message["body"]["contract"] != contract
    {
        return Err(format!(
            "{name}: the session does not open {application} with its contract"
        ));
    }
    if out
        .last()
        .map(|e| e.request.message["op"] != "close")
        .unwrap_or(true)
    {
        return Err(format!("{name}: the session does not end with close"));
    }
    Ok(out)
}

fn body<T: serde::de::DeserializeOwned>(decoded: &Decoded, what: &str) -> Result<T, String> {
    serde_json::from_value(decoded.message["body"].clone())
        .map_err(|error| format!("{what}: {error}"))
}

/// Check the transcripts in `dir`, which [`crate::host::run`] wrote.
pub fn verify(dir: &Path) -> Result<Report, String> {
    let manifest: Manifest = serde_json::from_slice(
        &fs::read(dir.join("manifest.json")).map_err(|error| format!("manifest.json: {error}"))?,
    )
    .map_err(|error| format!("manifest.json: {error}"))?;
    let body_identity = body_contract().identity;
    let controller_identity = controller_contract().identity;
    if manifest.body_contract != body_identity
        || manifest.controller_contract != controller_identity
    {
        return Err("the manifest names other contracts".into());
    }

    // Every controller step response, by identity: its controller, request, and result.
    let mut responses: BTreeMap<String, (usize, ControllerStep, ControllerResult)> =
        BTreeMap::new();
    let mut used: BTreeMap<String, bool> = BTreeMap::new();
    for (index, controller) in manifest.controllers.iter().enumerate() {
        let path = dir.join(&controller.transcript);
        let list = exchanges(&path, crate::CONTROLLER_APPLICATION, &controller_identity)?;
        let steps = &list[2..list.len() - 1];
        if list[1].request.message["op"] != "prepare" || steps.len() as u64 != manifest.steps {
            return Err(format!(
                "controller {index}: prepare, {} steps, close expected",
                manifest.steps
            ));
        }
        for (tick, exchange) in (1..).zip(steps) {
            let step: ControllerStep = body(&exchange.request, "controller step")?;
            let result: ControllerResult = body(&exchange.response, "controller result")?;
            if exchange.request.message["op"] != "step"
                || step.tick_index != tick
                || step.drone_ids != controller.drone_ids
            {
                return Err(format!(
                    "controller {index}: step {tick} out of order or for other drones"
                ));
            }
            result
                .answers(&step)
                .map_err(|error| format!("controller {index}: step {tick}: {error}"))?;
            used.insert(exchange.response.identity.clone(), false);
            responses.insert(exchange.response.identity.clone(), (index, step, result));
        }
    }

    let mut proposals = 0;
    for (w, world) in manifest.worlds.iter().enumerate() {
        let path = dir.join(&world.transcript);
        let list = exchanges(&path, crate::BODY_APPLICATION, &body_identity)?;
        if list.len() as u64 != manifest.steps + 4 {
            return Err(format!(
                "world {w}: open, prepare, {} steps, finish, close expected",
                manifest.steps
            ));
        }
        let prepare: PrepareBody = body(&list[1].request, "prepare")?;
        if list[1].request.message["op"] != "prepare"
            || prepare.drone_ids != world.drone_ids
            || prepare.planned_steps != manifest.steps
            || prepare.tick_ms != manifest.tick_ms
        {
            return Err(format!(
                "world {w}: the prepare request does not match the manifest"
            ));
        }
        let mut observation: Observation =
            serde_json::from_value(list[1].response.message["body"]["observation"].clone())
                .map_err(|error| format!("world {w}: prepare observation: {error}"))?;
        for (tick, exchange) in (1..).zip(&list[2..list.len() - 2]) {
            let step: StepBody = body(&exchange.request, "world step")?;
            if exchange.request.message["op"] != "step"
                || step.tick_index != tick
                || step.source_state_digest != observation.state_digest
            {
                return Err(format!(
                    "world {w}: step {tick} is out of order or not from the current state"
                ));
            }
            let mut covered = vec![false; world.drone_ids.len()];
            for proposal in &step.proposals {
                let (controller, request, result) =
                    responses.get(&proposal.response).ok_or_else(|| {
                        format!(
                            "world {w}: step {tick}: no controller response {}",
                            proposal.response
                        )
                    })?;
                if manifest.controllers[*controller].world != w
                    || request.tick_index != tick
                    || request.source_state_digest != observation.state_digest
                    || request.drone_ids != proposal.drone_ids
                {
                    return Err(format!("world {w}: step {tick}: the response {} answers another step, state, or drone set", proposal.response));
                }
                if *request != observation.controller_step(tick, &request.drone_ids)? {
                    return Err(format!("world {w}: step {tick}: controller {controller} received another observation"));
                }
                for (k, drone) in request.drone_ids.iter().enumerate() {
                    let at = world
                        .drone_ids
                        .iter()
                        .position(|d| d == drone)
                        .ok_or("drone")?;
                    if std::mem::replace(&mut covered[at], true) {
                        return Err(format!("world {w}: step {tick}: drone {drone} moved twice"));
                    }
                    if step.actuator_intent_acceleration_mps2[at * 3..at * 3 + 3]
                        != result.acceleration_mps2[k * 3..k * 3 + 3]
                    {
                        return Err(format!("world {w}: step {tick}: drone {drone} got another acceleration than controller {controller} proposed"));
                    }
                }
                if used.insert(proposal.response.clone(), true) != Some(false) {
                    return Err(format!(
                        "world {w}: step {tick}: the response {} is applied twice",
                        proposal.response
                    ));
                }
                proposals += 1;
            }
            if !covered.iter().all(|c| *c) {
                return Err(format!("world {w}: step {tick}: a drone has no proposal"));
            }
            observation =
                serde_json::from_value(exchange.response.message["body"]["observation"].clone())
                    .map_err(|error| format!("world {w}: step {tick}: observation: {error}"))?;
            if observation.tick_index != tick {
                return Err(format!(
                    "world {w}: step {tick}: observation of another step"
                ));
            }
        }
        let finish = &list[list.len() - 2];
        let request: FinishBody = body(&finish.request, "finish")?;
        let record: Value = finish.response.message["body"].clone();
        if finish.request.message["op"] != "finish"
            || request.completed_steps != manifest.steps
            || record["finish"]["cleaned_up"] != true
            || record["finish"]["state_digest"] != observation.state_digest.as_str()
        {
            return Err(format!(
                "world {w}: the run does not finish cleanly from its last state"
            ));
        }
    }
    if let Some((identity, _)) = used.iter().find(|(_, applied)| !**applied) {
        return Err(format!(
            "the controller response {identity} was never applied"
        ));
    }
    Ok(Report {
        worlds: manifest.worlds.len(),
        controllers: manifest.controllers.len(),
        steps: manifest.steps,
        proposals,
    })
}
