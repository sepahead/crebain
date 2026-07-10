//! Neuro-Cybernetic Protocol (NCP) — CREBAIN's Rust client + adapter.
//!
//! Lets CREBAIN ask **Engram** (Engram) for a neural simulation and/or be
//! steered as a controller, over the recommended decoupled **Zenoh** transport,
//! using the canonical Rust NCP SDK (`ncp-core` + `ncp-zenoh`). This is the
//! high-performance peer to the TypeScript WebSocket client in
//! `src/neuro/` — same wire contract, native Rust + Zenoh.
//!
//! **Project specifics stay here, not in Engram.** Engram speaks only NCP
//! (entity/channel-addressed); this module owns the CREBAIN-specific mapping
//! (pose/velocity ↔ NCP sensor/command channels) and the topic wiring. The
//! perception plane carries `SensorFrame`s CREBAIN publishes; the action plane
//! carries `CommandFrame`s CREBAIN maps to MAVROS setpoints.
//!
//! Feature-gated behind `ncp` (off by default) so the default CREBAIN build is
//! unchanged. To expose it to the frontend, register the commands at the bottom
//! of this file in `lib.rs::run()` (see the doc comment there) — a deliberate,
//! one-step opt-in that keeps the command-contract test green until you flip it.
//!
//! Boundary: returned `V_m`/spikes are raw simulation outputs
//! (`calibrated_posterior=false`, `is_simulation_output=true`), never a validated
//! reproduction; a neuro-controller is a control artifact, not a scientific claim.

use crate::transport::{PoseData, TwistStampedData, VelocityCmd};
use ncp_core::keys::Keys;
use ncp_core::{
    ChannelValue, CloseSession, CommandFrame, NetworkRef, NetworkRefKind, Observation,
    ObservationFrame, OpenSession, RecordSpec, RecordTarget, SensorFrame, SessionClosed, SimConfig,
    StepRequest, StimulusFrame, StimulusSpec, StimulusTarget,
};
use ncp_zenoh::ZenohBus;
use serde::{de::DeserializeOwned, Serialize};
use std::{
    collections::HashMap,
    fmt::Display,
    future::Future,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::{sync::oneshot, task::JoinHandle};

const MAX_REALM_BYTES: usize = 128;
const MAX_SESSION_ID_BYTES: usize = 128;
const MAX_MODEL_NAME_BYTES: usize = 128;
// Keep a single request within a generous experimental envelope while bounding
// backend work and preventing an accidental unit error from driving the model.
const MAX_ABS_DRIVE_PA: f64 = 1_000_000.0;
const MAX_ADVANCE_MS: f64 = 10_000.0;
const MAX_LINEAR_SPEED_MPS: f64 = 100.0;
const MAX_COMMAND_TTL_MS: f64 = 60_000.0;
const MAX_COMMAND_HORIZON_STEPS: usize = 1_000;
const NCP_RPC_TIMEOUT: Duration = Duration::from_secs(15);
const NCP_ACTION_PERIOD: Duration = Duration::from_millis(20);
const NCP_ACTION_STOP_TIMEOUT: Duration = Duration::from_secs(1);
const VELOCITY_SETPOINT_CHANNEL: &str = "velocity_setpoint";
const VELOCITY_SETPOINT_UNIT: &str = "m/s";

fn validate_realm(realm: &str) -> Result<(), String> {
    validate_bounded_text("realm", realm, MAX_REALM_BYTES)?;
    if realm.split('/').all(valid_key_segment) {
        Ok(())
    } else {
        Err("NCP realm contains an empty or unsafe key segment".into())
    }
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    validate_bounded_text("session id", session_id, MAX_SESSION_ID_BYTES)?;
    if valid_key_segment(session_id) {
        Ok(())
    } else {
        Err("NCP session id contains an unsafe key-expression character".into())
    }
}

fn valid_key_segment(value: &str) -> bool {
    ncp_core::keys::valid_id_segment(value)
        && !value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
}

fn validate_model_name(model: &str) -> Result<(), String> {
    validate_bounded_text("model name", model, MAX_MODEL_NAME_BYTES)?;
    let mut bytes = model.bytes();
    let starts_with_alphanumeric = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric());
    if starts_with_alphanumeric
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        Ok(())
    } else {
        Err("NCP model name must start with an ASCII letter or digit and contain only letters, digits, '_', '-', or '.'".into())
    }
}

fn validate_bounded_text(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("NCP {label} must not be empty"));
    }
    if value.len() > max_bytes {
        return Err(format!("NCP {label} exceeds the {max_bytes}-byte limit"));
    }
    Ok(())
}

fn validate_step_inputs(drive_pa: f64, advance_ms: f64) -> Result<(), String> {
    if !drive_pa.is_finite() || !(-MAX_ABS_DRIVE_PA..=MAX_ABS_DRIVE_PA).contains(&drive_pa) {
        return Err(format!(
            "NCP drive_pa must be finite and within +/-{MAX_ABS_DRIVE_PA} pA"
        ));
    }
    if !advance_ms.is_finite() || advance_ms <= 0.0 || advance_ms > MAX_ADVANCE_MS {
        return Err(format!(
            "NCP advance_ms must be finite, greater than zero, and at most {MAX_ADVANCE_MS} ms"
        ));
    }
    Ok(())
}

fn verify_reply_session(
    reply_kind: &str,
    requested_session_id: &str,
    returned_session_id: &str,
) -> Result<(), String> {
    if returned_session_id == requested_session_id {
        Ok(())
    } else {
        Err(format!(
            "NCP {reply_kind} session id does not match the request"
        ))
    }
}

fn spike_count(frame: &ObservationFrame, port: &str, target: &str) -> Result<f64, String> {
    let observation = frame
        .records
        .get(port)
        .ok_or_else(|| format!("NCP observation is missing required spike port {port:?}"))?;
    if observation.port != port {
        return Err(format!(
            "NCP observation record {port:?} declares mismatched port {:?}",
            observation.port
        ));
    }
    if observation.target != target {
        return Err(format!(
            "NCP observation port {port:?} declares target {:?}, expected {target:?}",
            observation.target
        ));
    }
    if observation.observable != ncp_core::Observable::Spikes {
        return Err(format!(
            "NCP observation port {port:?} returned {:?}, expected spikes",
            observation.observable
        ));
    }
    if observation.times.iter().any(|time| !time.is_finite()) {
        return Err(format!(
            "NCP observation port {port:?} contains a non-finite spike time"
        ));
    }
    Ok(observation.times.len() as f64)
}

fn ensure_close_succeeded(session_id: &str, closed: &SessionClosed) -> Result<(), String> {
    verify_reply_session("session_closed", session_id, &closed.session_id)?;
    if closed.ok {
        Ok(())
    } else {
        Err(format!("NCP close_session rejected session {session_id:?}"))
    }
}

async fn rpc_with_timeout<T, E, F>(
    operation: &str,
    timeout: Duration,
    future: F,
) -> Result<T, String>
where
    E: Display,
    F: Future<Output = Result<T, E>>,
{
    tokio::time::timeout(timeout, future)
        .await
        .map_err(|_| format!("NCP {operation} timed out after {} ms", timeout.as_millis()))?
        .map_err(|error| format!("NCP {operation} failed: {error}"))
}

fn decode_rpc_reply<T>(
    reply: &[u8],
    expected_kind: &str,
    required_bool_fields: &[&str],
) -> Result<T, String>
where
    T: DeserializeOwned,
{
    let value: serde_json::Value =
        serde_json::from_slice(reply).map_err(|error| format!("invalid JSON reply: {error}"))?;
    match ncp_core::message_kind(&value) {
        Some("error") => {
            let detail = value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown error");
            return Err(format!("NCP error reply: {detail}"));
        }
        Some(kind) if kind != expected_kind => {
            return Err(format!(
                "NCP reply kind mismatch: expected {expected_kind:?}, got {kind:?}"
            ));
        }
        Some(_) => {}
        None => return Err("NCP reply has no string `kind`".into()),
    }
    ncp_core::validate(&value).map_err(|error| format!("invalid NCP reply: {error}"))?;
    for field in required_bool_fields {
        if value
            .get(*field)
            .and_then(serde_json::Value::as_bool)
            .is_none()
        {
            return Err(format!(
                "NCP {expected_kind} reply must include boolean field {field:?}"
            ));
        }
    }
    serde_json::from_value(value).map_err(|error| format!("invalid NCP reply body: {error}"))
}

async fn request_rpc<Req, Resp>(
    bus: &ZenohBus,
    operation: &str,
    request: &Req,
    expected_kind: &str,
    required_bool_fields: &[&str],
) -> Result<Resp, String>
where
    Req: Serialize,
    Resp: DeserializeOwned,
{
    let request = serde_json::to_vec(request)
        .map_err(|error| format!("NCP {operation} request serialization failed: {error}"))?;
    let reply = rpc_with_timeout(operation, NCP_RPC_TIMEOUT, bus.request(&request)).await?;
    decode_rpc_reply(&reply, expected_kind, required_bool_fields)
        .map_err(|error| format!("NCP {operation} failed: {error}"))
}

// ───────────────────────── project mapping (CREBAIN-specific) ─────────────────────────

/// CREBAIN pose + body velocity → an NCP `SensorFrame` (perception plane).
/// Channels: `pose_position` (vec3, m), `pose_velocity` (vec3, m/s). `seq`/`t`
/// stamp the frame so the command computed from it can echo the same `seq`.
pub fn sensor_frame_from_pose(pose: &PoseData, vel: &VelocityCmd, seq: i64) -> SensorFrame {
    let mut channels = ncp_core::Map::new();
    channels.insert(
        "pose_position".to_string(),
        ChannelValue::vec3(
            pose.position[0],
            pose.position[1],
            pose.position[2],
            Some("m"),
        ),
    );
    channels.insert(
        "pose_velocity".to_string(),
        ChannelValue::vec3(vel.linear[0], vel.linear[1], vel.linear[2], Some("m/s")),
    );
    SensorFrame {
        seq,
        t: pose.timestamp,
        frame_id: pose.frame_id.clone(),
        channels,
        ..Default::default()
    }
}

/// An NCP `CommandFrame` → a CREBAIN `TwistStampedData` for
/// `/mavros/<ns>/setpoint_velocity/cmd_vel`. Reads the `velocity_setpoint`
/// channel (exactly three finite m/s values with a bounded vector norm). Only
/// `active` may actuate; every other mode yields zero velocity (fail-safe).
pub fn velocity_from_command(
    command: &CommandFrame,
    frame_id: &str,
) -> Result<TwistStampedData, String> {
    if !command.t.is_finite() {
        return Err("NCP command timestamp must be finite".into());
    }
    let linear = if command.mode == ncp_core::Mode::Active {
        validate_active_command(command)?;
        velocity_channels(&command.channels)?
    } else {
        [0.0, 0.0, 0.0]
    };
    Ok(twist_with_linear(frame_id, command.t, linear))
}

fn validate_active_command(command: &CommandFrame) -> Result<(), String> {
    if command.seq < 1 {
        return Err("NCP active command must have seq >= 1".into());
    }
    if !command.ttl_ms.is_finite() || command.ttl_ms <= 0.0 || command.ttl_ms > MAX_COMMAND_TTL_MS {
        return Err(format!(
            "NCP active command ttl_ms must be finite, greater than zero, and at most {MAX_COMMAND_TTL_MS} ms"
        ));
    }
    velocity_channels(&command.channels)?;
    if command.horizon.len() > MAX_COMMAND_HORIZON_STEPS {
        return Err(format!(
            "NCP command horizon exceeds the {MAX_COMMAND_HORIZON_STEPS}-step limit"
        ));
    }
    let horizon_dt_ms = match command.horizon_dt_ms {
        Some(value) if value.is_finite() && value > 0.0 => Some(value),
        Some(_) => {
            return Err(
                "NCP command horizon_dt_ms must be finite and greater than zero when present"
                    .into(),
            )
        }
        None => None,
    };
    if !command.horizon.is_empty() {
        let horizon_dt_ms = horizon_dt_ms
            .ok_or_else(|| "NCP command horizon requires horizon_dt_ms".to_string())?;
        let deadline_bound = ncp_core::max_horizon_len(command.ttl_ms, horizon_dt_ms);
        if command.horizon.len() > deadline_bound {
            return Err("NCP command horizon extends beyond the command ttl_ms deadline".into());
        }
        for channels in &command.horizon {
            velocity_channels(channels)?;
        }
    }
    Ok(())
}

fn velocity_channels(channels: &ncp_core::Map<ChannelValue>) -> Result<[f64; 3], String> {
    let channel = channels
        .get(VELOCITY_SETPOINT_CHANNEL)
        .ok_or_else(|| format!("NCP active command is missing {VELOCITY_SETPOINT_CHANNEL:?}"))?;
    if channel.unit.as_deref() != Some(VELOCITY_SETPOINT_UNIT) {
        return Err(format!(
            "NCP {VELOCITY_SETPOINT_CHANNEL:?} unit must be {VELOCITY_SETPOINT_UNIT:?}"
        ));
    }
    let linear: [f64; 3] = channel.data.as_slice().try_into().map_err(|_| {
        format!("NCP {VELOCITY_SETPOINT_CHANNEL:?} must contain exactly three values")
    })?;
    if linear.iter().any(|value| !value.is_finite()) {
        return Err(format!(
            "NCP {VELOCITY_SETPOINT_CHANNEL:?} values must all be finite"
        ));
    }
    let norm_squared = linear.iter().map(|value| value * value).sum::<f64>();
    if norm_squared > MAX_LINEAR_SPEED_MPS * MAX_LINEAR_SPEED_MPS {
        return Err(format!(
            "NCP {VELOCITY_SETPOINT_CHANNEL:?} norm exceeds {MAX_LINEAR_SPEED_MPS} m/s"
        ));
    }
    Ok(linear)
}

fn twist_with_linear(frame_id: &str, timestamp: f64, linear: [f64; 3]) -> TwistStampedData {
    TwistStampedData {
        twist: VelocityCmd {
            linear,
            angular: [0.0, 0.0, 0.0],
        },
        timestamp,
        frame_id: frame_id.to_string(),
    }
}

fn hold_twist(frame_id: &str, timestamp: f64) -> TwistStampedData {
    twist_with_linear(frame_id, timestamp, [0.0, 0.0, 0.0])
}

/// Decode a single-neuron / population observation into a scalar feature
/// (spike count, or last analog/rate value) for CREBAIN's detection logic.
pub fn observation_scalar(frame: &ObservationFrame, port: &str) -> Option<f64> {
    frame.records.get(port).map(|o: &Observation| {
        if !o.times.is_empty() && o.values.is_empty() {
            o.times.len() as f64 // spikes
        } else {
            o.values.last().copied().unwrap_or(0.0)
        }
    })
}

/// Plant-side action receiver with **packetized-predictive-control** replay and
/// `ttl_ms` enforcement (via `ncp_core::ActionBuffer`). Feed it `CommandFrame`s as
/// they arrive; the actuator loop calls [`CommandPlant::velocity_at`] each tick and
/// publishes the result to MAVROS. A single dropped command is a non-event (the
/// horizon is replayed); once the command expires or the horizon drains it **fails
/// safe to zero velocity (HOLD)** — turning NCP's previously-unenforced `ttl_ms`
/// into a real deadline backstop.
pub struct CommandPlant {
    buffer: ncp_core::ActionBuffer,
    frame_id: String,
}

impl CommandPlant {
    pub fn new(frame_id: impl Into<String>) -> Self {
        Self {
            buffer: ncp_core::ActionBuffer::new(),
            frame_id: frame_id.into(),
        }
    }

    /// Ingest a command received at local time `now_s` (monotonic seconds).
    pub fn on_command(&mut self, now_s: f64, command: CommandFrame) -> Result<(), String> {
        if !now_s.is_finite() || now_s < 0.0 {
            return Err("NCP command receive time must be finite and non-negative".into());
        }
        if command.mode == ncp_core::Mode::Active {
            validate_active_command(&command)?;
        }
        self.buffer.on_command(now_s, command);
        Ok(())
    }

    /// The `TwistStamped` to publish at `now_s` — the active (possibly replayed)
    /// setpoint, or **zero velocity** when the buffer says fail safe (HOLD).
    pub fn velocity_at(&self, now_s: f64) -> TwistStampedData {
        if !now_s.is_finite() || now_s < 0.0 {
            return hold_twist(&self.frame_id, 0.0);
        }
        let linear = match self.buffer.active(now_s) {
            Some(channels) => velocity_channels(&channels).unwrap_or([0.0, 0.0, 0.0]),
            None => [0.0, 0.0, 0.0], // HOLD: fail safe to zero velocity
        };
        twist_with_linear(&self.frame_id, now_s, linear)
    }

    /// True if the plant is failing safe (no usable command) at `now_s`.
    pub fn is_holding(&self, now_s: f64) -> bool {
        self.buffer.should_hold(now_s)
    }
}

// ───────────────────────── NCP bridge (async client over Zenoh) ─────────────────────────

type ActionOutput = Arc<dyn Fn(TwistStampedData) + Send + Sync>;

struct ActionTask {
    stop: Option<oneshot::Sender<()>>,
    handle: JoinHandle<()>,
}

#[derive(Default)]
struct NcpActionRuntime {
    // `None` reserves a session while its Zenoh subscription is being created.
    tasks: Mutex<HashMap<String, Option<ActionTask>>>,
}

impl NcpActionRuntime {
    fn reserve(&self, session_id: &str) -> Result<(), String> {
        let mut tasks = lock_unpoisoned(&self.tasks);
        if tasks.contains_key(session_id) {
            return Err(format!(
                "NCP action subscription already exists for session {session_id:?}"
            ));
        }
        tasks.insert(session_id.to_string(), None);
        Ok(())
    }

    fn cancel_reservation(&self, session_id: &str) {
        let mut tasks = lock_unpoisoned(&self.tasks);
        if tasks.get(session_id).is_some_and(Option::is_none) {
            tasks.remove(session_id);
        }
    }

    fn install(&self, session_id: &str, task: ActionTask) -> Result<(), ActionTask> {
        let mut tasks = lock_unpoisoned(&self.tasks);
        if let Some(slot) = tasks.get_mut(session_id) {
            if slot.is_none() {
                *slot = Some(task);
                return Ok(());
            }
        }
        Err(task)
    }

    async fn stop(&self, session_id: &str) {
        let task = lock_unpoisoned(&self.tasks).remove(session_id).flatten();
        let Some(mut task) = task else {
            return;
        };
        if let Some(stop) = task.stop.take() {
            let _ = stop.send(());
        }
        if tokio::time::timeout(NCP_ACTION_STOP_TIMEOUT, &mut task.handle)
            .await
            .is_err()
        {
            log::warn!(
                "ncp: action loop for session {session_id:?} did not stop in time; aborting it"
            );
            task.handle.abort();
            // Do not await again after abort: cancellation cannot pre-empt a
            // synchronous user callback, and close must remain bounded.
        }
    }
}

impl Drop for NcpActionRuntime {
    fn drop(&mut self) {
        let tasks = self
            .tasks
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for task in tasks.drain().filter_map(|(_, task)| task) {
            if let Some(stop) = task.stop {
                let _ = stop.send(());
            }
            // Dropping a Tokio JoinHandle detaches it. The stop signal lets the
            // detached task publish one final HOLD and exit on its next poll.
        }
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn run_action_loop(
    plant: Arc<Mutex<CommandPlant>>,
    started: Instant,
    frame_id: String,
    output: ActionOutput,
    mut stop: oneshot::Receiver<()>,
) {
    let mut interval = tokio::time::interval(NCP_ACTION_PERIOD);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut stop => {
                output(hold_twist(&frame_id, started.elapsed().as_secs_f64()));
                break;
            }
            _ = interval.tick() => {
                let now_s = started.elapsed().as_secs_f64();
                let command = lock_unpoisoned(&plant).velocity_at(now_s);
                output(command);
            }
        }
    }
}

/// CREBAIN's NCP bridge: a Zenoh-backed NCP client (perception/sim service via
/// RPC) plus the perception/action data-plane helpers.
#[derive(Clone)]
pub struct NcpBridge {
    bus: ZenohBus,
    actions: Arc<NcpActionRuntime>,
}

impl NcpBridge {
    /// Open a Zenoh session on the given NCP realm. crebain bridges to an Engram
    /// deployment, whose rendezvous realm is `engram/ncp` (see `ncp_connect`).
    pub async fn connect(realm: &str) -> Result<Self, String> {
        validate_realm(realm)?;
        let bus = rpc_with_timeout(
            "zenoh_connect",
            NCP_RPC_TIMEOUT,
            ZenohBus::open_realm(Keys::new(realm.to_string())),
        )
        .await?;
        Ok(Self {
            bus,
            actions: Arc::new(NcpActionRuntime::default()),
        })
    }

    /// Open a single-population perception session (e.g. a UAV "feature neuron"
    /// driven by a detection score; read its spikes back).
    pub async fn open_feature_neuron(&self, session_id: &str, model: &str) -> Result<(), String> {
        validate_session_id(session_id)?;
        validate_model_name(model)?;
        let mut population_sizes = ncp_core::Map::new();
        population_sizes.insert("feat".to_string(), 1);
        let open = OpenSession {
            session_id: session_id.to_string(),
            network: NetworkRef {
                kind: NetworkRefKind::Builtin,
                ref_: model.to_string(),
                population_sizes,
                ..Default::default()
            },
            record: RecordSpec {
                targets: vec![RecordTarget {
                    port: "spk".into(),
                    target: "feat".into(),
                    observable: ncp_core::Observable::Spikes,
                    ..Default::default()
                }],
            },
            stimulus: StimulusSpec {
                targets: vec![StimulusTarget {
                    port: "drive".into(),
                    target: "feat".into(),
                    kind: ncp_core::StimulusKind::CurrentPa,
                    ..Default::default()
                }],
            },
            sim: SimConfig::default(),
            ..Default::default()
        };
        let opened: ncp_core::SessionOpened =
            request_rpc(&self.bus, "open_session", &open, "session_opened", &["ok"]).await?;
        let contract_status =
            ncp_core::negotiate(&opened.ncp_version, opened.contract_hash.as_deref())
                .map_err(|error| format!("NCP session_opened version failed: {error}"))?;
        if let Some(advisory) = contract_status.advisory() {
            log::warn!("ncp: {advisory}");
        }
        verify_reply_session("session_opened", session_id, &opened.session_id)?;
        if !opened.ok {
            return Err(opened
                .error
                .unwrap_or_else(|| "open_session rejected".into()));
        }
        Ok(())
    }

    /// Step a session: inject `drive_pa` on the `drive` port, advance `advance_ms`,
    /// return the spike count on the `spk` port.
    pub async fn step_feature_neuron(
        &self,
        session_id: &str,
        drive_pa: f64,
        advance_ms: f64,
    ) -> Result<f64, String> {
        validate_session_id(session_id)?;
        validate_step_inputs(drive_pa, advance_ms)?;
        let mut values = ncp_core::Map::new();
        values.insert(
            "drive".to_string(),
            ChannelValue::scalar(drive_pa, Some("pA")),
        );
        let step = StepRequest {
            session_id: session_id.to_string(),
            advance_ms: Some(advance_ms),
            stimulus: Some(StimulusFrame {
                session_id: session_id.to_string(),
                values,
                ..Default::default()
            }),
            ..Default::default()
        };
        let observation: ObservationFrame =
            request_rpc(&self.bus, "step_request", &step, "observation_frame", &[]).await?;
        verify_reply_session("observation_frame", session_id, &observation.session_id)?;
        spike_count(&observation, "spk", "feat")
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        validate_session_id(session_id)?;
        // Stop local actuation before asking the remote peer to close. This emits
        // a final zero setpoint even when the control-plane RPC subsequently fails.
        self.actions.stop(session_id).await;
        let closed: SessionClosed = request_rpc(
            &self.bus,
            "close_session",
            &CloseSession {
                session_id: session_id.to_string(),
                ..Default::default()
            },
            "session_closed",
            &["ok"],
        )
        .await?;
        ensure_close_succeeded(session_id, &closed)
    }

    /// Publish a `SensorFrame` on the perception plane. The SDK configures this
    /// plane as `CongestionControl::Drop` + `Priority::DataHigh` + `express(false)`;
    /// reliability is left at Zenoh's default (the SDK does not set Best-Effort).
    pub async fn publish_sensor(
        &self,
        session_id: &str,
        frame: &SensorFrame,
    ) -> Result<(), String> {
        validate_session_id(session_id)?;
        let bytes = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
        self.bus
            .put_sensor(session_id, &bytes)
            .await
            .map_err(|e| e.to_string())
    }

    /// Subscribe to the action plane and emit a bounded 50 Hz actuator stream.
    /// Received commands pass through the wire gate and strict velocity-channel
    /// validation into [`CommandPlant`]. The loop then enforces monotonic sequence,
    /// horizon replay, TTL expiry, and fail-safe HOLD continuously rather than only
    /// when a packet arrives. The callback must be non-blocking.
    pub async fn subscribe_commands<F>(
        &self,
        session_id: &str,
        frame_id: String,
        on_command: F,
    ) -> Result<(), String>
    where
        F: Fn(TwistStampedData) + Send + Sync + 'static,
    {
        validate_session_id(session_id)?;
        self.actions.reserve(session_id)?;
        let started = Instant::now();
        let plant = Arc::new(Mutex::new(CommandPlant::new(frame_id.clone())));
        let command_plant = Arc::clone(&plant);
        let subscribe_result = self
            .bus
            .subscribe_commands(session_id, move |_key, bytes| {
                match ncp_core::decode_validated::<CommandFrame>(&bytes) {
                    Ok(command) => {
                        let now_s = started.elapsed().as_secs_f64();
                        if let Err(error) =
                            lock_unpoisoned(&command_plant).on_command(now_s, command)
                        {
                            log::warn!("ncp: dropped unsafe command frame: {error}");
                        }
                    }
                    // Drop a frame that fails the wire-0.6 contract; surface WHY so a
                    // version-incompatible or unstamped peer is observable, not silent.
                    Err(error) => match ncp_core::diagnose_version(&bytes) {
                        Some(version_error) => {
                            log::warn!("ncp: dropped command frame ({version_error})")
                        }
                        None => log::warn!("ncp: dropped command frame: {error}"),
                    },
                }
            })
            .await;
        if let Err(error) = subscribe_result {
            self.actions.cancel_reservation(session_id);
            return Err(error.to_string());
        }

        let output: ActionOutput = Arc::new(on_command);
        let (stop_sender, stop_receiver) = oneshot::channel();
        let handle = tokio::spawn(run_action_loop(
            plant,
            started,
            frame_id,
            output,
            stop_receiver,
        ));
        let task = ActionTask {
            stop: Some(stop_sender),
            handle,
        };
        if let Err(mut task) = self.actions.install(session_id, task) {
            if let Some(stop) = task.stop.take() {
                let _ = stop.send(());
            }
            task.handle.abort();
            return Err(format!(
                "NCP action subscription for session {session_id:?} was cancelled during setup"
            ));
        }
        Ok(())
    }
}

// ───────────────────────── Tauri commands (ready to register) ─────────────────────────
//
// Managed state holds the connected bridge. To expose these to the frontend, add
// in `lib.rs::run()`:
//
//     #[cfg(feature = "ncp")]
//     let builder = builder.manage(crate::ncp::NcpHandle::default());
//
// and append to the appropriate `generate_handler![...]` list:
//
//     #[cfg(feature = "ncp")] ncp_connect, ncp_open_feature_neuron,
//     #[cfg(feature = "ncp")] ncp_step_feature_neuron, ncp_close,
//
// (kept opt-in so the command-contract test stays green until you wire the
// matching entries into the frontend command registry).

/// Tauri-managed NCP state (lazily connected).
#[derive(Default)]
pub struct NcpHandle(pub tokio::sync::Mutex<Option<NcpBridge>>);

async fn connected_bridge(handle: &NcpHandle) -> Result<NcpBridge, String> {
    let bridge = {
        let guard = handle.0.lock().await;
        guard.clone()
    };
    bridge.ok_or_else(|| "NCP not connected (call ncp_connect)".into())
}

#[tauri::command]
pub async fn ncp_connect(
    state: tauri::State<'_, NcpHandle>,
    realm: Option<String>,
) -> Result<(), String> {
    // Default to the Engram deployment's rendezvous realm (an explicit DEPLOYMENT
    // choice), not ncp_core::DEFAULT_REALM — NCP the protocol is project-neutral
    // ("ncp"); crebain bridges specifically to Engram. Override via the `realm` arg.
    let bridge = NcpBridge::connect(realm.as_deref().unwrap_or("engram/ncp")).await?;
    *state.0.lock().await = Some(bridge);
    Ok(())
}

#[tauri::command]
pub async fn ncp_open_feature_neuron(
    state: tauri::State<'_, NcpHandle>,
    session_id: String,
    model: Option<String>,
) -> Result<(), String> {
    let bridge = connected_bridge(state.inner()).await?;
    bridge
        .open_feature_neuron(&session_id, model.as_deref().unwrap_or("iaf_psc_alpha"))
        .await
}

#[tauri::command]
pub async fn ncp_step_feature_neuron(
    state: tauri::State<'_, NcpHandle>,
    session_id: String,
    drive_pa: f64,
    advance_ms: f64,
) -> Result<f64, String> {
    let bridge = connected_bridge(state.inner()).await?;
    bridge
        .step_feature_neuron(&session_id, drive_pa, advance_ms)
        .await
}

#[tauri::command]
pub async fn ncp_close(
    state: tauri::State<'_, NcpHandle>,
    session_id: String,
) -> Result<(), String> {
    let bridge = connected_bridge(state.inner()).await?;
    bridge.close(&session_id).await
}

// The whole module is already `#[cfg(feature = "ncp")]`, but spelling the feature
// out on the test gate makes it explicit that these tests only build/run under
// `--features ncp` (the path CI exercises via `test:rust:ncp`).
#[cfg(all(test, feature = "ncp"))]
mod tests {
    use super::*;

    fn command_channels(values: Vec<f64>, unit: Option<&str>) -> ncp_core::Map<ChannelValue> {
        let mut channels = ncp_core::Map::new();
        channels.insert(
            VELOCITY_SETPOINT_CHANNEL.into(),
            ChannelValue {
                data: values,
                unit: unit.map(str::to_string),
            },
        );
        channels
    }

    fn active_command(values: Vec<f64>, unit: Option<&str>) -> CommandFrame {
        CommandFrame {
            seq: 1,
            mode: ncp_core::Mode::Active,
            ttl_ms: 200.0,
            channels: command_channels(values, unit),
            ..Default::default()
        }
    }

    #[test]
    fn ncp_identifiers_accept_expected_values() {
        assert!(validate_realm("engram/ncp").is_ok());
        assert!(validate_session_id("uav-01.alpha").is_ok());
        assert!(validate_model_name("iaf_psc_alpha").is_ok());
    }

    #[test]
    fn realm_rejects_key_expression_injection() {
        assert!(validate_realm("engram/**").is_err());
    }

    #[test]
    fn session_id_rejects_key_expression_injection() {
        assert!(validate_session_id("uav/01").is_err());
    }

    #[test]
    fn model_name_rejects_path_like_input() {
        assert!(validate_model_name("../../iaf_psc_alpha").is_err());
        assert!(validate_model_name("..").is_err());
    }

    #[test]
    fn identifiers_reject_oversized_values() {
        assert!(validate_realm(&"r".repeat(MAX_REALM_BYTES + 1)).is_err());
        assert!(validate_session_id(&"s".repeat(MAX_SESSION_ID_BYTES + 1)).is_err());
        assert!(validate_model_name(&"m".repeat(MAX_MODEL_NAME_BYTES + 1)).is_err());
    }

    #[test]
    fn step_inputs_accept_inclusive_safety_limits() {
        assert!(validate_step_inputs(-MAX_ABS_DRIVE_PA, f64::MIN_POSITIVE).is_ok());
        assert!(validate_step_inputs(MAX_ABS_DRIVE_PA, MAX_ADVANCE_MS).is_ok());
    }

    #[test]
    fn step_inputs_reject_non_finite_and_out_of_range_values() {
        for (drive_pa, advance_ms) in [
            (f64::NAN, 1.0),
            (f64::INFINITY, 1.0),
            (MAX_ABS_DRIVE_PA + 1.0, 1.0),
            (0.0, f64::NAN),
            (0.0, f64::INFINITY),
            (0.0, 0.0),
            (0.0, MAX_ADVANCE_MS + 1.0),
        ] {
            assert!(
                validate_step_inputs(drive_pa, advance_ms).is_err(),
                "drive_pa={drive_pa:?}, advance_ms={advance_ms:?} must be rejected"
            );
        }
    }

    #[test]
    fn reply_session_mismatch_is_rejected() {
        let error = verify_reply_session("observation_frame", "expected", "other")
            .expect_err("a reply for another session must fail closed");
        assert!(error.contains("observation_frame session id does not match"));
    }

    #[test]
    fn rejected_close_reply_is_an_error() {
        let closed = SessionClosed {
            session_id: "session-1".into(),
            ok: false,
            ..Default::default()
        };
        assert!(ensure_close_succeeded("session-1", &closed).is_err());
    }

    #[test]
    fn rpc_success_flag_must_be_explicitly_present_and_boolean() {
        let missing = serde_json::to_vec(&serde_json::json!({
            "kind": "session_opened",
            "ncp_version": ncp_core::NCP_VERSION,
            "session_id": "session-1"
        }))
        .unwrap();
        let error =
            decode_rpc_reply::<ncp_core::SessionOpened>(&missing, "session_opened", &["ok"])
                .expect_err("serde's default true must not turn a missing ok into success");
        assert!(error.contains("must include boolean field \"ok\""));

        let wrong_type = serde_json::to_vec(&serde_json::json!({
            "kind": "session_opened",
            "ncp_version": ncp_core::NCP_VERSION,
            "session_id": "session-1",
            "ok": "true"
        }))
        .unwrap();
        assert!(decode_rpc_reply::<ncp_core::SessionOpened>(
            &wrong_type,
            "session_opened",
            &["ok"]
        )
        .is_err());

        let explicit = serde_json::to_vec(&serde_json::json!({
            "kind": "session_opened",
            "ncp_version": ncp_core::NCP_VERSION,
            "session_id": "session-1",
            "ok": true
        }))
        .unwrap();
        let opened =
            decode_rpc_reply::<ncp_core::SessionOpened>(&explicit, "session_opened", &["ok"])
                .expect("an explicit boolean success flag is valid");
        assert!(opened.ok);
    }

    #[test]
    fn spike_count_requires_the_expected_port() {
        let error = spike_count(&ObservationFrame::default(), "spk", "feat")
            .expect_err("a missing spike record must not silently become zero");
        assert!(error.contains("missing required spike port"));
    }

    #[test]
    fn spike_count_requires_record_identity_to_match_the_map_key_and_target() {
        let frame_with = |port: &str, target: &str| {
            let mut records = ncp_core::Map::new();
            records.insert(
                "spk".into(),
                Observation {
                    port: port.into(),
                    target: target.into(),
                    observable: ncp_core::Observable::Spikes,
                    ..Default::default()
                },
            );
            ObservationFrame {
                records,
                ..Default::default()
            }
        };
        assert!(spike_count(&frame_with("other", "feat"), "spk", "feat").is_err());
        assert!(spike_count(&frame_with("spk", "other"), "spk", "feat").is_err());
    }

    #[test]
    fn spike_count_requires_spike_observable() {
        let mut records = ncp_core::Map::new();
        records.insert(
            "spk".into(),
            Observation {
                port: "spk".into(),
                target: "feat".into(),
                observable: ncp_core::Observable::Vm,
                values: vec![-65.0],
                ..Default::default()
            },
        );
        let error = spike_count(
            &ObservationFrame {
                records,
                ..Default::default()
            },
            "spk",
            "feat",
        )
        .expect_err("an analog record must not be interpreted as a spike count");
        assert!(error.contains("expected spikes"));
    }

    #[test]
    fn empty_spike_series_is_an_explicit_zero_count() {
        let mut records = ncp_core::Map::new();
        records.insert(
            "spk".into(),
            Observation {
                port: "spk".into(),
                target: "feat".into(),
                observable: ncp_core::Observable::Spikes,
                ..Default::default()
            },
        );
        let count = spike_count(
            &ObservationFrame {
                records,
                ..Default::default()
            },
            "spk",
            "feat",
        );
        assert_eq!(count, Ok(0.0));
    }

    #[tokio::test]
    async fn rpc_timeout_names_the_stalled_operation() {
        let stalled = std::future::pending::<Result<(), &'static str>>();
        let error = rpc_with_timeout("step_request", Duration::from_millis(1), stalled)
            .await
            .expect_err("a stalled RPC must time out");
        assert!(error.contains("step_request timed out"));
    }

    #[test]
    fn pose_maps_to_sensor_frame_channels() {
        let pose = PoseData {
            position: [1.0, 2.0, 3.0],
            orientation: [0.0, 0.0, 0.0, 1.0],
            timestamp: 12.5,
            frame_id: "map".into(),
        };
        let vel = VelocityCmd {
            linear: [0.1, 0.2, 0.3],
            angular: [0.0, 0.0, 0.0],
        };
        let f = sensor_frame_from_pose(&pose, &vel, 42);
        assert_eq!(f.seq, 42);
        assert_eq!(f.frame_id, "map");
        assert_eq!(f.channels["pose_position"].data, vec![1.0, 2.0, 3.0]);
        assert_eq!(f.channels["pose_velocity"].data, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn only_valid_active_commands_can_produce_nonzero_velocity() {
        let active = active_command(vec![5.0, 5.0, 5.0], Some("m/s"));
        assert_eq!(
            velocity_from_command(&active, "base").unwrap().twist.linear,
            [5.0, 5.0, 5.0]
        );
        for mode in [
            ncp_core::Mode::Init,
            ncp_core::Mode::Hold,
            ncp_core::Mode::Estop,
        ] {
            let safe = CommandFrame {
                mode,
                channels: command_channels(vec![90.0, 90.0, 90.0], Some("wrong")),
                ..Default::default()
            };
            assert_eq!(
                velocity_from_command(&safe, "base").unwrap().twist.linear,
                [0.0, 0.0, 0.0]
            );
        }
    }

    #[test]
    fn active_command_rejects_malformed_or_unbounded_velocity_channels() {
        let missing = CommandFrame {
            seq: 1,
            mode: ncp_core::Mode::Active,
            ttl_ms: 200.0,
            ..Default::default()
        };
        assert!(velocity_from_command(&missing, "base").is_err());

        for command in [
            active_command(vec![1.0, 2.0, 3.0], None),
            active_command(vec![1.0, 2.0, 3.0], Some("km/h")),
            active_command(vec![1.0, 2.0], Some("m/s")),
            active_command(vec![1.0, 2.0, 3.0, 4.0], Some("m/s")),
            active_command(vec![f64::NAN, 0.0, 0.0], Some("m/s")),
            active_command(vec![f64::INFINITY, 0.0, 0.0], Some("m/s")),
            active_command(vec![MAX_LINEAR_SPEED_MPS, 1.0, 0.0], Some("m/s")),
        ] {
            assert!(
                velocity_from_command(&command, "base").is_err(),
                "unsafe velocity channel must be rejected: {:?}",
                command.channels
            );
        }

        let at_limit = active_command(vec![MAX_LINEAR_SPEED_MPS, 0.0, 0.0], Some("m/s"));
        assert!(velocity_from_command(&at_limit, "base").is_ok());
    }

    #[test]
    fn active_command_rejects_invalid_ttl_and_horizon() {
        for ttl_ms in [0.0, -1.0, f64::NAN, f64::INFINITY, MAX_COMMAND_TTL_MS + 1.0] {
            let mut command = active_command(vec![1.0, 0.0, 0.0], Some("m/s"));
            command.ttl_ms = ttl_ms;
            assert!(velocity_from_command(&command, "base").is_err());
        }

        let mut missing_period = active_command(vec![1.0, 0.0, 0.0], Some("m/s"));
        missing_period.horizon = vec![command_channels(vec![0.5, 0.0, 0.0], Some("m/s"))];
        assert!(velocity_from_command(&missing_period, "base").is_err());

        let mut past_deadline = active_command(vec![1.0, 0.0, 0.0], Some("m/s"));
        past_deadline.ttl_ms = 20.0;
        past_deadline.horizon_dt_ms = Some(20.0);
        past_deadline.horizon = vec![
            command_channels(vec![0.5, 0.0, 0.0], Some("m/s")),
            command_channels(vec![0.25, 0.0, 0.0], Some("m/s")),
        ];
        assert!(velocity_from_command(&past_deadline, "base").is_err());

        let valid_channels = command_channels(vec![0.5, 0.0, 0.0], Some("m/s"));
        let mut oversized = active_command(vec![1.0, 0.0, 0.0], Some("m/s"));
        oversized.ttl_ms = MAX_COMMAND_TTL_MS;
        oversized.horizon_dt_ms = Some(1.0);
        oversized.horizon = vec![valid_channels; MAX_COMMAND_HORIZON_STEPS + 1];
        assert!(velocity_from_command(&oversized, "base").is_err());
    }

    #[test]
    fn rejected_active_command_does_not_refresh_the_plant_deadline() {
        let mut plant = CommandPlant::new("base");
        let mut first = active_command(vec![1.0, 0.0, 0.0], Some("m/s"));
        first.ttl_ms = 20.0;
        plant.on_command(0.0, first).unwrap();

        let mut unsafe_replacement =
            active_command(vec![MAX_LINEAR_SPEED_MPS + 1.0, 0.0, 0.0], Some("m/s"));
        unsafe_replacement.seq = 2;
        assert!(plant.on_command(0.01, unsafe_replacement).is_err());
        assert_eq!(plant.velocity_at(0.015).twist.linear, [1.0, 0.0, 0.0]);
        assert_eq!(plant.velocity_at(0.03).twist.linear, [0.0, 0.0, 0.0]);
    }

    #[tokio::test]
    async fn stopping_an_action_task_emits_a_final_hold() {
        assert_eq!(NCP_ACTION_PERIOD, Duration::from_millis(20));
        let outputs = Arc::new(Mutex::new(Vec::<TwistStampedData>::new()));
        let output_sink = Arc::clone(&outputs);
        let output: ActionOutput = Arc::new(move |command| {
            lock_unpoisoned(&output_sink).push(command);
        });
        let plant = Arc::new(Mutex::new(CommandPlant::new("base")));
        let runtime = NcpActionRuntime::default();
        runtime.reserve("session-1").unwrap();
        let (stop_sender, stop_receiver) = oneshot::channel();
        let task = ActionTask {
            stop: Some(stop_sender),
            handle: tokio::spawn(run_action_loop(
                plant,
                Instant::now(),
                "base".into(),
                output,
                stop_receiver,
            )),
        };
        assert!(runtime.install("session-1", task).is_ok());
        runtime.stop("session-1").await;

        let outputs = lock_unpoisoned(&outputs);
        assert_eq!(outputs.last().unwrap().twist.linear, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn observation_scalar_counts_spikes() {
        let mut records = ncp_core::Map::new();
        records.insert(
            "spk".into(),
            Observation {
                times: vec![1.0, 2.0, 3.0],
                ..Default::default()
            },
        );
        let frame = ObservationFrame {
            records,
            ..Default::default()
        };
        assert_eq!(observation_scalar(&frame, "spk"), Some(3.0));
        assert_eq!(observation_scalar(&frame, "missing"), None);
    }

    #[test]
    fn version_skew_is_rejected_on_session_open() {
        // `decode_rpc_reply` validates the reply before typed deserialization, and
        // `open_feature_neuron` additionally runs `negotiate` for the handshake.
        assert!(
            ncp_core::check_version(ncp_core::NCP_VERSION, true).unwrap(),
            "the wire version CREBAIN is pinned to must be self-compatible"
        );
        // Wire 0.6: the PREVIOUS wire (0.5) is now a breaking-minor skew, rejected
        // not coerced — a half-upgraded fleet fails closed.
        assert!(ncp_core::check_version("0.5", true).is_err());
        // A breaking-minor skew (pre-1.0 minors are breaking) is rejected, not coerced.
        assert!(ncp_core::check_version("0.1", true).is_err());
        // A different major is rejected.
        assert!(ncp_core::check_version("1.0", true).is_err());
        // A malformed version string is rejected rather than silently parsed.
        assert!(ncp_core::check_version("0.2.GARBAGE", true).is_err());
    }

    #[test]
    fn action_and_perception_with_crebain() {
        // PERCEPTION: crebain pose+velocity -> NCP SensorFrame (sensors → Engram).
        let pose = PoseData {
            position: [2.0, 0.0, 0.0],
            orientation: [0.0, 0.0, 0.0, 1.0],
            timestamp: 0.0,
            frame_id: "map".into(),
        };
        let vel = VelocityCmd {
            linear: [0.0, 0.0, 0.0],
            angular: [0.0, 0.0, 0.0],
        };
        let sf = sensor_frame_from_pose(&pose, &vel, 5);
        assert_eq!(sf.seq, 5);
        assert_eq!(sf.channels["pose_position"].data[0], 2.0);

        // ACTION: a predictive command (tick0 + 2-step horizon, 50 ms, ttl 200 ms)
        // drives crebain's plant; the horizon is replayed through "dropouts", then
        // it fails safe to zero velocity (HOLD) once ttl_ms expires (Engram → UAV).
        let mk = |x: f64| {
            let mut m = ncp_core::Map::new();
            m.insert(
                "velocity_setpoint".into(),
                ChannelValue::vec3(x, 0.0, 0.0, Some("m/s")),
            );
            m
        };
        let mut plant = CommandPlant::new("base_link");
        let cmd = CommandFrame {
            // Wire 0.6: a command MUST stamp seq >= 1 (echoing the sensor seq); the
            // ActionBuffer drops seq<1, so an unstamped fixture would HOLD.
            seq: 5,
            ttl_ms: 200.0,
            channels: mk(-0.5),
            horizon: vec![mk(-0.4), mk(-0.3)],
            horizon_dt_ms: Some(50.0),
            ..Default::default()
        };
        plant.on_command(10.0, cmd).unwrap();
        assert_eq!(plant.velocity_at(10.00).twist.linear[0], -0.5); // tick 0
        assert_eq!(plant.velocity_at(10.06).twist.linear[0], -0.4); // replay tick 1 (command dropped)
        assert_eq!(plant.velocity_at(10.11).twist.linear[0], -0.3); // replay tick 2
        assert!(plant.is_holding(10.30), "past ttl -> HOLD");
        assert_eq!(
            plant.velocity_at(10.30).twist.linear,
            [0.0, 0.0, 0.0],
            "fail safe to zero"
        );
    }
}
