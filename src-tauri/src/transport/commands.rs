use super::{
    create_bridge, CameraFrame, CameraInfoData, CameraStreamKind, ImuData, ModelStates, PoseData,
    Transport, TransportError, TransportStats, TwistStampedData, VelocityCmd,
};
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

// Global transport instance. The mutex is only held briefly to swap or clone
// the Arc, never across a transport operation, so a stalled operation cannot
// wedge every other command (including transport_disconnect).
static TRANSPORT_ENGINE: LazyLock<Mutex<Option<Arc<dyn Transport>>>> =
    LazyLock::new(|| Mutex::new(None));

const MAX_TOPIC_LEN: usize = 256;
const MAX_FRAME_ID_LEN: usize = 256;
const MAX_GAZEBO_MODEL_NAME_LEN: usize = 128;
const MAX_GAZEBO_MODEL_XML_BYTES: usize = 256 * 1024;
// These are command-surface safety ceilings, not flight-controller tuning.
// They deliberately sit above every bundled airframe's envelope while still
// rejecting finite-but-dangerous values before they reach ROS actuators.
const MAX_LINEAR_SPEED_MPS: f64 = 100.0;
const MAX_ANGULAR_SPEED_RAD_S: f64 = 50.0;
const MAX_POSITION_MAGNITUDE_M: f64 = 1_000_000.0;
const QUATERNION_NORM_TOLERANCE: f64 = 0.01;
const TRANSPORT_EVENT_PREFIX: &str = "crebain:transport:";
const TRANSPORT_OP_TIMEOUT: Duration = Duration::from_secs(10);

/// Clone the active bridge out of a briefly-held lock.
async fn current_bridge() -> Result<Arc<dyn Transport>, String> {
    TRANSPORT_ENGINE
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Transport not connected".to_string())
}

/// Run a transport operation with a timeout so a stalled transport cannot
/// block the command surface forever.
async fn with_timeout<T>(op: impl Future<Output = super::Result<T>>) -> Result<T, String> {
    match tokio::time::timeout(TRANSPORT_OP_TIMEOUT, op).await {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(_) => Err(TransportError::Timeout.to_string()),
    }
}

fn validate_topic(topic: &str) -> Result<(), String> {
    if topic.is_empty() || topic.trim() != topic {
        return Err("Transport topic must not be empty or padded".to_string());
    }
    if topic.contains('\0') {
        return Err("Transport topic must not contain null bytes".to_string());
    }
    if topic.len() > MAX_TOPIC_LEN {
        return Err(format!(
            "Transport topic is too long: {} bytes exceeds {}",
            topic.len(),
            MAX_TOPIC_LEN
        ));
    }
    if topic == "/" || !topic.starts_with('/') {
        return Err("Transport topic must be an absolute ROS name".to_string());
    }
    if topic.contains("//") {
        return Err("Transport topic must not contain empty path segments".to_string());
    }
    // ROS-graph character whitelist. This also keeps Zenoh key-expression
    // metacharacters (`*`, `?`, `#`, `$`, ...) out of topics passed verbatim as
    // key expressions.
    if !topic
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '/'))
    {
        return Err("Transport topic contains unsupported characters".to_string());
    }
    Ok(())
}

fn validate_frame_id(name: &str, frame_id: &str) -> Result<(), String> {
    if frame_id.is_empty() || frame_id.trim() != frame_id {
        return Err(format!("{} must not be empty or padded", name));
    }
    if frame_id.contains('\0') {
        return Err(format!("{} must not contain null bytes", name));
    }
    if frame_id.len() > MAX_FRAME_ID_LEN {
        return Err(format!(
            "{} is too long: {} bytes exceeds {}",
            name,
            frame_id.len(),
            MAX_FRAME_ID_LEN
        ));
    }
    if frame_id.contains("//")
        || !frame_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '/'))
    {
        return Err(format!("{} contains unsupported characters", name));
    }
    Ok(())
}

fn validate_finite_array(name: &str, values: &[f64]) -> Result<(), String> {
    for (index, value) in values.iter().enumerate() {
        if !value.is_finite() {
            return Err(format!("{}[{}] must be finite", name, index));
        }
    }
    Ok(())
}

fn validate_vector_magnitude(name: &str, values: &[f64], maximum: f64) -> Result<(), String> {
    validate_finite_array(name, values)?;
    let magnitude = values
        .iter()
        .fold(0.0_f64, |accumulator, value| accumulator.hypot(*value));
    if magnitude > maximum {
        return Err(format!(
            "{} magnitude must not exceed {}, got {}",
            name, maximum, magnitude
        ));
    }
    Ok(())
}

fn validate_timestamp(name: &str, timestamp: f64) -> Result<(), String> {
    if !timestamp.is_finite() || timestamp < 0.0 || timestamp > i32::MAX as f64 {
        return Err(format!(
            "{} must be finite and within [0, {}], got {}",
            name,
            i32::MAX,
            timestamp
        ));
    }
    Ok(())
}

fn validate_velocity_cmd(name: &str, cmd: &VelocityCmd) -> Result<(), String> {
    validate_vector_magnitude(
        &format!("{}.linear", name),
        &cmd.linear,
        MAX_LINEAR_SPEED_MPS,
    )?;
    validate_vector_magnitude(
        &format!("{}.angular", name),
        &cmd.angular,
        MAX_ANGULAR_SPEED_RAD_S,
    )
}

fn validate_twist_stamped(cmd: &TwistStampedData) -> Result<(), String> {
    validate_velocity_cmd("cmd.twist", &cmd.twist)?;
    validate_timestamp("cmd.timestamp", cmd.timestamp)?;
    validate_frame_id("cmd.frame_id", &cmd.frame_id)
}

fn validate_pose_data(pose: &PoseData) -> Result<(), String> {
    validate_vector_magnitude("pose.position", &pose.position, MAX_POSITION_MAGNITUDE_M)?;
    validate_finite_array("pose.orientation", &pose.orientation)?;
    let orientation_norm = pose
        .orientation
        .iter()
        .fold(0.0_f64, |accumulator, value| accumulator.hypot(*value));
    if (orientation_norm - 1.0).abs() > QUATERNION_NORM_TOLERANCE {
        return Err(format!(
            "pose.orientation must be a unit quaternion within {} tolerance, got norm {}",
            QUATERNION_NORM_TOLERANCE, orientation_norm
        ));
    }
    validate_timestamp("pose.timestamp", pose.timestamp)?;
    validate_frame_id("pose.frame_id", &pose.frame_id)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GazeboSpawnModelRequest {
    pub name: String,
    pub xml: String,
    pub robot_namespace: Option<String>,
    pub initial_pose: PoseData,
    pub reference_frame: Option<String>,
}

fn validate_gazebo_spawn_request_with_policy(
    request: &GazeboSpawnModelRequest,
    allow_unsafe_xml: bool,
) -> Result<(), String> {
    validate_bounded_graph_name("model name", &request.name, MAX_GAZEBO_MODEL_NAME_LEN)?;
    if request.xml.trim().is_empty() {
        return Err("model XML must not be empty".to_string());
    }
    if request.xml.contains('\0') {
        return Err("model XML must not contain null bytes".to_string());
    }
    if request.xml.len() > MAX_GAZEBO_MODEL_XML_BYTES {
        return Err(format!(
            "model XML too large: {} bytes exceeds maximum {}",
            request.xml.len(),
            MAX_GAZEBO_MODEL_XML_BYTES
        ));
    }
    let normalized_xml = request.xml.to_ascii_lowercase();
    const PRIVILEGED_XML_MARKERS: [&str; 9] = [
        "<!doctype",
        "<!entity",
        "<include",
        "<plugin",
        "<uri",
        "filename=",
        "file://",
        "http://",
        "https://",
    ];
    if !allow_unsafe_xml
        && PRIVILEGED_XML_MARKERS
            .iter()
            .any(|marker| normalized_xml.contains(marker))
    {
        return Err(
            "model XML contains external-resource or plugin directives; set CREBAIN_ALLOW_UNSAFE_GAZEBO_XML=1 only in a trusted development environment"
                .to_string(),
        );
    }
    if let Some(namespace) = &request.robot_namespace {
        validate_bounded_graph_name("robot namespace", namespace, MAX_FRAME_ID_LEN)?;
    }
    if let Some(reference_frame) = &request.reference_frame {
        validate_frame_id("reference_frame", reference_frame)?;
    }
    validate_pose_data(&request.initial_pose)
}

fn validate_gazebo_spawn_request(request: &GazeboSpawnModelRequest) -> Result<(), String> {
    let allow_unsafe_xml = std::env::var("CREBAIN_ALLOW_UNSAFE_GAZEBO_XML")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false);
    validate_gazebo_spawn_request_with_policy(request, allow_unsafe_xml)
}

fn validate_bounded_graph_name(name: &str, value: &str, max_len: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{} must not be empty", name));
    }
    if value.contains('\0') {
        return Err(format!("{} must not contain null bytes", name));
    }
    if value.len() > max_len {
        return Err(format!(
            "{} too long: {} bytes exceeds maximum {}",
            name,
            value.len(),
            max_len
        ));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.'))
    {
        return Err(format!("{} contains unsupported characters", name));
    }
    Ok(())
}

/// Map a ROS topic to a Tauri event name.
///
/// Tauri 2.x (`EventName::new`) rejects event names containing anything
/// outside alphanumerics, `-`, `/`, `:` and `_`, so an emit with an illegal
/// name fails and the frontend never receives the payload. ASCII
/// alphanumerics, `-` and `/` pass through; every other byte is escaped as
/// `_` + two uppercase hex digits (`_` itself becomes `_5F`, keeping the
/// mapping bijective). Must stay byte-identical with `getTransportEventName`
/// in `src/lib/transportEvents.ts`.
fn transport_event_name(topic: &str) -> String {
    let mut event_name = String::from(TRANSPORT_EVENT_PREFIX);
    for byte in topic.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '/') {
            event_name.push(c);
        } else {
            event_name.push_str(&format!("_{:02X}", byte));
        }
    }
    event_name
}

/// Connect to the transport layer (Zenoh or fallback)
#[tauri::command]
pub async fn transport_connect() -> Result<(), String> {
    log::info!("Connecting to transport layer...");

    // Create bridge (will pick Zenoh if enabled/configured)
    let mut bridge = with_timeout(create_bridge()).await?;

    // Connect
    with_timeout(bridge.connect()).await?;

    // Swap in the new transport, then disconnect the old one outside the lock
    let old_bridge = TRANSPORT_ENGINE.lock().await.replace(Arc::from(bridge));
    if let Some(old_bridge) = old_bridge {
        if let Err(e) = with_timeout(old_bridge.disconnect()).await {
            log::warn!("Failed to disconnect old transport: {}", e);
        }
    }

    log::info!("Transport connected successfully");
    Ok(())
}

/// Disconnect from the transport layer
#[tauri::command]
pub async fn transport_disconnect() -> Result<(), String> {
    log::info!("Disconnecting transport...");

    // Take the bridge out first so the engine is cleared (and new connects
    // are possible) even if the disconnect itself stalls.
    let bridge = TRANSPORT_ENGINE.lock().await.take();
    if let Some(bridge) = bridge {
        with_timeout(bridge.disconnect()).await?;
    }
    Ok(())
}

/// Subscribe to a camera topic
/// frames will be emitted as events with the same name as the topic
#[tauri::command]
pub async fn transport_subscribe_camera(
    app: AppHandle,
    topic: String,
    compressed: Option<bool>,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let bridge = current_bridge().await?;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    // Create callback that emits event to frontend
    // Note: This callback runs on the transport thread
    let callback = Box::new(move |frame: CameraFrame| {
        // Emit event to all windows
        // We might want to optimize this to only emit to specific windows or reduce frequency
        if let Err(e) = app.emit(&event_name, frame) {
            log::warn!("Failed to emit camera frame: {}", e);
        }
    });

    let stream_kind = if compressed.unwrap_or(false) {
        CameraStreamKind::Compressed
    } else {
        CameraStreamKind::Raw
    };
    with_timeout(bridge.subscribe_camera(&topic, stream_kind, callback)).await
}

/// Subscribe to a CameraInfo topic
/// messages will be emitted as events with the same name as the topic
#[tauri::command]
pub async fn transport_subscribe_camera_info(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let bridge = current_bridge().await?;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback = Box::new(move |info: CameraInfoData| {
        if let Err(e) = app.emit(&event_name, info) {
            log::warn!("Failed to emit CameraInfo: {}", e);
        }
    });

    with_timeout(bridge.subscribe_camera_info(&topic, callback)).await
}

/// Subscribe to an IMU topic
#[tauri::command]
pub async fn transport_subscribe_imu(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let bridge = current_bridge().await?;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback = Box::new(move |data: ImuData| {
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit IMU data: {}", e);
        }
    });

    with_timeout(bridge.subscribe_imu(&topic, callback)).await
}

/// Subscribe to a Pose topic
#[tauri::command]
pub async fn transport_subscribe_pose(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let bridge = current_bridge().await?;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback = Box::new(move |data: PoseData| {
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit Pose data: {}", e);
        }
    });

    with_timeout(bridge.subscribe_pose(&topic, callback)).await
}

/// Subscribe to Model States
#[tauri::command]
pub async fn transport_subscribe_model_states(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let bridge = current_bridge().await?;

    let event_name = transport_event_name(&topic);
    log::debug!(
        "Subscribing transport topic '{}' as event '{}'",
        topic,
        event_name
    );

    let callback = Box::new(move |data: ModelStates| {
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit ModelStates: {}", e);
        }
    });

    with_timeout(bridge.subscribe_model_states(&topic, callback)).await
}

/// Unsubscribe from a topic
#[tauri::command]
pub async fn transport_unsubscribe(topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let bridge = TRANSPORT_ENGINE.lock().await.clone();
    let Some(bridge) = bridge else {
        log::debug!(
            "Ignoring unsubscribe for '{}' because transport is disconnected",
            topic
        );
        return Ok(());
    };
    with_timeout(bridge.unsubscribe(&topic)).await
}

/// Publish velocity command
#[tauri::command]
pub async fn transport_publish_velocity(topic: String, cmd: VelocityCmd) -> Result<(), String> {
    validate_topic(&topic)?;
    validate_velocity_cmd("cmd", &cmd)?;
    let bridge = current_bridge().await?;

    with_timeout(bridge.publish_velocity(&topic, cmd)).await
}

/// Publish stamped velocity command (geometry_msgs/TwistStamped)
#[tauri::command]
pub async fn transport_publish_twist_stamped(
    topic: String,
    cmd: TwistStampedData,
) -> Result<(), String> {
    validate_topic(&topic)?;
    validate_twist_stamped(&cmd)?;
    let bridge = current_bridge().await?;

    with_timeout(bridge.publish_twist_stamped(&topic, cmd)).await
}

/// Publish pose setpoint
#[tauri::command]
pub async fn transport_publish_pose(topic: String, pose: PoseData) -> Result<(), String> {
    validate_topic(&topic)?;
    validate_pose_data(&pose)?;
    let bridge = current_bridge().await?;

    with_timeout(bridge.publish_pose(&topic, pose)).await
}

#[tauri::command]
pub async fn transport_spawn_gazebo_model(request: GazeboSpawnModelRequest) -> Result<(), String> {
    validate_gazebo_spawn_request(&request)?;
    let bridge = current_bridge().await?;
    let pose = request.initial_pose;
    let args = serde_json::json!({
        "model_name": request.name,
        "model_xml": request.xml,
        "robot_namespace": request.robot_namespace.unwrap_or_default(),
        "initial_pose": {
            "position": {
                "x": pose.position[0],
                "y": pose.position[1],
                "z": pose.position[2]
            },
            "orientation": {
                "x": pose.orientation[0],
                "y": pose.orientation[1],
                "z": pose.orientation[2],
                "w": pose.orientation[3]
            }
        },
        "reference_frame": request.reference_frame.unwrap_or_else(|| pose.frame_id.clone())
    });
    // The rosbridge fallback intentionally follows the documented Gazebo
    // Classic / ROS 1 deployment contract. Native Zenoh currently rejects
    // service calls explicitly rather than pretending ROS 2 services work.
    with_timeout(bridge.call_service("/gazebo/spawn_sdf_model", "gazebo_msgs/SpawnModel", args))
        .await
}

/// Get transport statistics
#[tauri::command]
pub async fn transport_get_stats() -> Result<TransportStats, String> {
    let bridge = current_bridge().await?;

    Ok(bridge.stats())
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST HELPERS - public validation functions callable from lib.rs tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

pub fn validate_topic_for_test(topic: &str) -> Result<(), String> {
    validate_topic(topic)
}

pub fn validate_message_type_for_test(msg_type: &str) -> Result<(), String> {
    validate_message_type(msg_type)
}

pub fn validate_gazebo_spawn_request_for_test(
    request: &GazeboSpawnModelRequest,
) -> Result<(), String> {
    validate_gazebo_spawn_request(request)
}

fn validate_message_type(msg_type: &str) -> Result<(), String> {
    if msg_type.is_empty() || msg_type.trim() != msg_type {
        return Err("Message type must not be empty or padded".to_string());
    }
    if msg_type.contains('\0') {
        return Err("Message type must not contain null bytes".to_string());
    }
    let segments: Vec<_> = msg_type.split('/').collect();
    let valid_segment = |segment: &&str| {
        segment
            .chars()
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
            && segment
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
    };
    if !(segments.len() == 2 || segments.len() == 3) || !segments.iter().all(valid_segment) {
        return Err(format!("Invalid message type: {}", msg_type));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_topic_accepts_common_ros_topics() {
        assert!(validate_topic("/camera/image_raw").is_ok());
    }

    #[test]
    fn validate_topic_accepts_exact_length_limit() {
        let exact = format!("/{}", "a".repeat(MAX_TOPIC_LEN - 1));
        assert_eq!(exact.len(), MAX_TOPIC_LEN);
        assert!(validate_topic(&exact).is_ok());
    }

    #[test]
    fn validate_topic_rejects_empty_null_and_oversized_topics() {
        assert!(validate_topic("")
            .unwrap_err()
            .contains("must not be empty"));
        assert!(validate_topic("   ")
            .unwrap_err()
            .contains("must not be empty or padded"));
        assert!(validate_topic("/camera\0/image")
            .unwrap_err()
            .contains("null bytes"));
        let oversized = format!("/{}", "a".repeat(MAX_TOPIC_LEN));
        assert!(validate_topic(&oversized).unwrap_err().contains("too long"));
    }

    #[test]
    fn validate_topic_rejects_wildcards_and_metacharacters() {
        for topic in [
            "/**",
            "/camera/*",
            "/cam?era",
            "/cam#era",
            "/cam$era",
            "/cam-era",
            "/cam.era",
        ] {
            assert!(
                validate_topic(topic)
                    .unwrap_err()
                    .contains("unsupported characters"),
                "expected rejection for {}",
                topic
            );
        }
    }

    #[test]
    fn validate_topic_rejects_non_canonical_ros_names() {
        for topic in ["relative/topic", "/", "/double//slash", "/padded "] {
            assert!(
                validate_topic(topic).is_err(),
                "expected rejection for {topic}"
            );
        }
    }

    #[test]
    fn transport_unsubscribe_rejects_invalid_topic_before_connection_check() {
        let error =
            tauri::async_runtime::block_on(transport_unsubscribe(" ".to_string())).unwrap_err();

        assert!(error.contains("must not be empty"));
    }

    #[test]
    fn transport_publish_velocity_rejects_invalid_topic_before_connection_check() {
        let cmd = VelocityCmd {
            linear: [0.0, 0.0, 0.0],
            angular: [0.0, 0.0, 0.0],
        };
        let error = tauri::async_runtime::block_on(transport_publish_velocity(
            "/cmd\0vel".to_string(),
            cmd,
        ))
        .unwrap_err();

        assert!(error.contains("null bytes"));
    }

    #[test]
    fn transport_publish_pose_rejects_oversized_topic_before_connection_check() {
        let pose = PoseData {
            position: [0.0, 0.0, 0.0],
            orientation: [0.0, 0.0, 0.0, 1.0],
            timestamp: 0.0,
            frame_id: "map".to_string(),
        };
        let oversized = format!("/{}", "a".repeat(MAX_TOPIC_LEN));
        let error =
            tauri::async_runtime::block_on(transport_publish_pose(oversized, pose)).unwrap_err();

        assert!(error.contains("too long"));
    }

    #[test]
    fn transport_publish_velocity_rejects_non_finite_payload_before_connection_check() {
        let cmd = VelocityCmd {
            linear: [0.0, f64::NAN, 0.0],
            angular: [0.0, 0.0, 0.0],
        };
        let error =
            tauri::async_runtime::block_on(transport_publish_velocity("/cmd_vel".to_string(), cmd))
                .unwrap_err();

        assert!(error.contains("cmd.linear[1] must be finite"));
    }

    #[test]
    fn transport_publish_velocity_rejects_excessive_finite_payload_before_connection_check() {
        let cmd = VelocityCmd {
            linear: [MAX_LINEAR_SPEED_MPS + 1.0, 0.0, 0.0],
            angular: [0.0, 0.0, 0.0],
        };
        let error =
            tauri::async_runtime::block_on(transport_publish_velocity("/cmd_vel".to_string(), cmd))
                .unwrap_err();

        assert!(error.contains("cmd.linear magnitude must not exceed"));
    }

    #[test]
    fn transport_publish_twist_stamped_rejects_invalid_header_before_connection_check() {
        let cmd = TwistStampedData {
            twist: VelocityCmd {
                linear: [0.0, 0.0, 0.0],
                angular: [0.0, 0.0, 0.0],
            },
            timestamp: f64::INFINITY,
            frame_id: "map".to_string(),
        };
        let error = tauri::async_runtime::block_on(transport_publish_twist_stamped(
            "/cmd_vel".to_string(),
            cmd,
        ))
        .unwrap_err();

        assert!(error.contains("cmd.timestamp must be finite"));
    }

    #[test]
    fn transport_publish_pose_rejects_invalid_frame_id_before_connection_check() {
        let pose = PoseData {
            position: [0.0, 0.0, 0.0],
            orientation: [0.0, 0.0, 0.0, 1.0],
            timestamp: 0.0,
            frame_id: "map\0bad".to_string(),
        };
        let error =
            tauri::async_runtime::block_on(transport_publish_pose("/setpoint".to_string(), pose))
                .unwrap_err();

        assert!(error.contains("pose.frame_id must not contain null bytes"));
    }

    #[test]
    fn transport_publish_pose_rejects_malformed_frame_id_before_connection_check() {
        let pose = PoseData {
            position: [0.0, 0.0, 0.0],
            orientation: [0.0, 0.0, 0.0, 1.0],
            timestamp: 0.0,
            frame_id: "bad frame".to_string(),
        };
        let error =
            tauri::async_runtime::block_on(transport_publish_pose("/setpoint".to_string(), pose))
                .unwrap_err();

        assert!(error.contains("pose.frame_id contains unsupported characters"));
    }

    #[test]
    fn transport_publish_pose_rejects_non_unit_orientation_before_connection_check() {
        let pose = PoseData {
            position: [0.0, 0.0, 0.0],
            orientation: [0.0, 0.0, 0.0, 0.0],
            timestamp: 0.0,
            frame_id: "map".to_string(),
        };
        let error =
            tauri::async_runtime::block_on(transport_publish_pose("/setpoint".to_string(), pose))
                .unwrap_err();

        assert!(error.contains("must be a unit quaternion"));
    }

    #[test]
    fn gazebo_spawn_rejects_excessive_position() {
        let mut request = valid_spawn_request();
        request.initial_pose.position = [MAX_POSITION_MAGNITUDE_M + 1.0, 0.0, 0.0];

        let error = validate_gazebo_spawn_request(&request).unwrap_err();

        assert!(error.contains("pose.position magnitude must not exceed"));
    }

    fn valid_spawn_request() -> GazeboSpawnModelRequest {
        GazeboSpawnModelRequest {
            name: "drone_1".to_string(),
            xml: "<sdf version=\"1.7\"><model name=\"drone_1\" /></sdf>".to_string(),
            robot_namespace: Some("/drone_1".to_string()),
            initial_pose: PoseData {
                position: [0.0, 0.0, 1.0],
                orientation: [0.0, 0.0, 0.0, 1.0],
                timestamp: 0.0,
                frame_id: "world".to_string(),
            },
            reference_frame: Some("world".to_string()),
        }
    }

    #[test]
    fn gazebo_spawn_validation_accepts_valid_request() {
        assert!(validate_gazebo_spawn_request(&valid_spawn_request()).is_ok());
    }

    #[test]
    fn gazebo_spawn_rejects_invalid_name_before_connection_check() {
        let mut request = valid_spawn_request();
        request.name = "bad model!".to_string();

        let error =
            tauri::async_runtime::block_on(transport_spawn_gazebo_model(request)).unwrap_err();

        assert!(error.contains("unsupported characters"));
    }

    #[test]
    fn gazebo_spawn_rejects_oversized_xml() {
        let mut request = valid_spawn_request();
        request.xml = "x".repeat(MAX_GAZEBO_MODEL_XML_BYTES + 1);

        let error = validate_gazebo_spawn_request(&request).unwrap_err();

        assert!(error.contains("model XML too large"));
    }

    #[test]
    fn gazebo_spawn_rejects_plugins_and_external_resources_by_default() {
        let mut request = valid_spawn_request();
        request.xml =
            "<sdf><model><plugin filename=\"libmalicious.so\" /></model></sdf>".to_string();

        let error = validate_gazebo_spawn_request_with_policy(&request, false).unwrap_err();

        assert!(error.contains("external-resource or plugin directives"));
        assert!(validate_gazebo_spawn_request_with_policy(&request, true).is_ok());
    }

    #[test]
    fn transport_event_name_preserves_safe_ascii() {
        assert_eq!(
            transport_event_name("camera/image-raw1"),
            "crebain:transport:camera/image-raw1"
        );
    }

    #[test]
    fn transport_event_name_escapes_underscores_and_utf8() {
        assert_eq!(
            transport_event_name("/camera/image_raw"),
            "crebain:transport:/camera/image_5Fraw"
        );
        assert_eq!(
            transport_event_name("/über/image"),
            "crebain:transport:/_C3_BCber/image"
        );
    }

    #[test]
    fn transport_event_name_emits_only_tauri_legal_characters() {
        // Tauri 2.x EventName::new accepts only [a-zA-Z0-9-/:_]; anything else
        // makes every emit fail and no transport data reaches the frontend.
        let name = transport_event_name("/cam era/image_raw%~");
        assert_eq!(name, "crebain:transport:/cam_20era/image_5Fraw_25_7E");
        assert!(name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')));
    }
}
