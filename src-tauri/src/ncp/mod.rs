//! Neuro-Cybernetic Protocol (NCP) — CREBAIN's Rust client + adapter.
//!
//! Lets CREBAIN ask **Engram** (Paper2Brain) for a neural simulation and/or be
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
    ObservationFrame, OpenSession, RecordSpec, RecordTarget, SensorFrame, SimConfig, StepRequest,
    StimulusFrame, StimulusSpec, StimulusTarget,
};
use ncp_zenoh::{ZenohBus, ZenohNcpClient};
use std::sync::Arc;

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
/// channel (m/s); a `hold`/`estop` command yields zero velocity (fail-safe).
pub fn velocity_from_command(command: &CommandFrame, frame_id: &str) -> TwistStampedData {
    let linear = match command.mode {
        ncp_core::Mode::Hold | ncp_core::Mode::Estop => [0.0, 0.0, 0.0],
        _ => command
            .channels
            .get("velocity_setpoint")
            .map(|cv| {
                let mut v = [0.0; 3];
                for (i, slot) in v.iter_mut().enumerate() {
                    *slot = cv.data.get(i).copied().unwrap_or(0.0);
                }
                v
            })
            .unwrap_or([0.0, 0.0, 0.0]),
    };
    TwistStampedData {
        twist: VelocityCmd {
            linear,
            angular: [0.0, 0.0, 0.0],
        },
        timestamp: command.t,
        frame_id: frame_id.to_string(),
    }
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
    pub fn on_command(&mut self, now_s: f64, command: CommandFrame) {
        self.buffer.on_command(now_s, command);
    }

    /// The `TwistStamped` to publish at `now_s` — the active (possibly replayed)
    /// setpoint, or **zero velocity** when the buffer says fail safe (HOLD).
    pub fn velocity_at(&self, now_s: f64) -> TwistStampedData {
        let linear = match self.buffer.active(now_s) {
            Some(ch) => channels_linear(&ch),
            None => [0.0, 0.0, 0.0], // HOLD: fail safe to zero velocity
        };
        TwistStampedData {
            twist: VelocityCmd {
                linear,
                angular: [0.0, 0.0, 0.0],
            },
            timestamp: now_s,
            frame_id: self.frame_id.clone(),
        }
    }

    /// True if the plant is failing safe (no usable command) at `now_s`.
    pub fn is_holding(&self, now_s: f64) -> bool {
        self.buffer.should_hold(now_s)
    }
}

fn channels_linear(channels: &ncp_core::Map<ChannelValue>) -> [f64; 3] {
    let mut v = [0.0; 3];
    if let Some(cv) = channels.get("velocity_setpoint") {
        for (i, slot) in v.iter_mut().enumerate() {
            *slot = cv.data.get(i).copied().unwrap_or(0.0);
        }
    }
    v
}

// ───────────────────────── NCP bridge (async client over Zenoh) ─────────────────────────

/// CREBAIN's NCP bridge: a Zenoh-backed NCP client (perception/sim service via
/// RPC) plus the perception/action data-plane helpers.
#[derive(Clone)]
pub struct NcpBridge {
    bus: ZenohBus,
    client: Arc<ZenohNcpClient>,
}

impl NcpBridge {
    /// Open a Zenoh session on the NCP realm (default `engram/ncp`).
    pub async fn connect(realm: &str) -> Result<Self, String> {
        let bus = ZenohBus::open_realm(Keys::new(realm.to_string()))
            .await
            .map_err(|e| format!("NCP Zenoh connect failed: {e}"))?;
        let client = Arc::new(ZenohNcpClient::new(bus.clone()));
        Ok(Self { bus, client })
    }

    /// Open a single-population perception session (e.g. a UAV "feature neuron"
    /// driven by a detection score; read its spikes back).
    pub async fn open_feature_neuron(&self, session_id: &str, model: &str) -> Result<(), String> {
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
        let opened = self.client.open(&open).await.map_err(|e| e.to_string())?;
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
        let obs = self.client.step(&step).await.map_err(|e| e.to_string())?;
        Ok(observation_scalar(&obs, "spk").unwrap_or(0.0))
    }

    pub async fn close(&self, session_id: &str) -> Result<(), String> {
        self.client
            .close(&CloseSession {
                session_id: session_id.to_string(),
                ..Default::default()
            })
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Publish a `SensorFrame` on the perception plane. The SDK configures this
    /// plane as `CongestionControl::Drop` + `Priority::DataHigh` + `express(false)`;
    /// reliability is left at Zenoh's default (the SDK does not set Best-Effort).
    pub async fn publish_sensor(
        &self,
        session_id: &str,
        frame: &SensorFrame,
    ) -> Result<(), String> {
        let bytes = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
        self.bus
            .put_sensor(session_id, &bytes)
            .await
            .map_err(|e| e.to_string())
    }

    /// Subscribe to the action plane: `on_command` receives decoded
    /// `TwistStampedData` ready to publish to MAVROS. `frame_id` stamps the twist.
    pub async fn subscribe_commands<F>(
        &self,
        session_id: &str,
        frame_id: String,
        on_command: F,
    ) -> Result<(), String>
    where
        F: Fn(TwistStampedData) + Send + Sync + 'static,
    {
        self.bus
            .subscribe_commands(session_id, move |_key, bytes| {
                if let Ok(cmd) = serde_json::from_slice::<CommandFrame>(&bytes) {
                    on_command(velocity_from_command(&cmd, &frame_id));
                }
            })
            .await
            .map_err(|e| e.to_string())
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

#[tauri::command]
pub async fn ncp_connect(
    state: tauri::State<'_, NcpHandle>,
    realm: Option<String>,
) -> Result<(), String> {
    let bridge = NcpBridge::connect(realm.as_deref().unwrap_or(ncp_core::DEFAULT_REALM)).await?;
    *state.0.lock().await = Some(bridge);
    Ok(())
}

#[tauri::command]
pub async fn ncp_open_feature_neuron(
    state: tauri::State<'_, NcpHandle>,
    session_id: String,
    model: Option<String>,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    let bridge = guard
        .as_ref()
        .ok_or("NCP not connected (call ncp_connect)")?;
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
    let guard = state.0.lock().await;
    let bridge = guard
        .as_ref()
        .ok_or("NCP not connected (call ncp_connect)")?;
    bridge
        .step_feature_neuron(&session_id, drive_pa, advance_ms)
        .await
}

#[tauri::command]
pub async fn ncp_close(
    state: tauri::State<'_, NcpHandle>,
    session_id: String,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    let bridge = guard
        .as_ref()
        .ok_or("NCP not connected (call ncp_connect)")?;
    bridge.close(&session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn hold_and_estop_commands_fail_safe_to_zero() {
        let mut channels = ncp_core::Map::new();
        channels.insert(
            "velocity_setpoint".into(),
            ChannelValue::vec3(5.0, 5.0, 5.0, Some("m/s")),
        );
        let active = CommandFrame {
            mode: ncp_core::Mode::Active,
            channels: channels.clone(),
            ..Default::default()
        };
        assert_eq!(
            velocity_from_command(&active, "base").twist.linear,
            [5.0, 5.0, 5.0]
        );
        let hold = CommandFrame {
            mode: ncp_core::Mode::Hold,
            channels,
            ..Default::default()
        };
        assert_eq!(
            velocity_from_command(&hold, "base").twist.linear,
            [0.0, 0.0, 0.0]
        );
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
            ttl_ms: 200.0,
            channels: mk(-0.5),
            horizon: vec![mk(-0.4), mk(-0.3)],
            horizon_dt_ms: Some(50.0),
            ..Default::default()
        };
        plant.on_command(10.0, cmd);
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
