use super::{
    create_bridge, CameraFrame, CameraInfoData, ImuData, ModelStates, PoseData, Transport,
    TransportStats, TwistStampedData, VelocityCmd,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

// Global transport instance
lazy_static::lazy_static! {
    static ref TRANSPORT_ENGINE: Mutex<Option<Box<dyn Transport>>> = Mutex::new(None);
}

const MAX_TOPIC_LEN: usize = 512;
const MAX_FRAME_ID_LEN: usize = 256;
const MAX_GAZEBO_MODEL_NAME_LEN: usize = 128;
const MAX_GAZEBO_MODEL_XML_BYTES: usize = 2 * 1024 * 1024;
const TRANSPORT_EVENT_PREFIX: &str = "crebain.transport.";

fn validate_topic(topic: &str) -> Result<(), String> {
    if topic.trim().is_empty() {
        return Err("Transport topic must not be empty".to_string());
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
    Ok(())
}

fn validate_frame_id(name: &str, frame_id: &str) -> Result<(), String> {
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
    validate_finite_array(&format!("{}.linear", name), &cmd.linear)?;
    validate_finite_array(&format!("{}.angular", name), &cmd.angular)
}

fn validate_twist_stamped(cmd: &TwistStampedData) -> Result<(), String> {
    validate_velocity_cmd("cmd.twist", &cmd.twist)?;
    validate_timestamp("cmd.timestamp", cmd.timestamp)?;
    validate_frame_id("cmd.frame_id", &cmd.frame_id)
}

fn validate_pose_data(pose: &PoseData) -> Result<(), String> {
    validate_finite_array("pose.position", &pose.position)?;
    validate_finite_array("pose.orientation", &pose.orientation)?;
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

fn validate_gazebo_spawn_request(request: &GazeboSpawnModelRequest) -> Result<(), String> {
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
    if let Some(namespace) = &request.robot_namespace {
        validate_bounded_graph_name("robot namespace", namespace, MAX_FRAME_ID_LEN)?;
    }
    if let Some(reference_frame) = &request.reference_frame {
        validate_frame_id("reference_frame", reference_frame)?;
    }
    validate_pose_data(&request.initial_pose)
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

fn transport_event_name(topic: &str) -> String {
    let mut event_name = String::from(TRANSPORT_EVENT_PREFIX);
    for byte in topic.as_bytes() {
        let c = *byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            event_name.push(c);
        } else {
            event_name.push_str(&format!("%{:02X}", byte));
        }
    }
    event_name
}

/// Connect to the transport layer (Zenoh or fallback)
#[tauri::command]
pub async fn transport_connect() -> Result<(), String> {
    log::info!("Connecting to transport layer...");

    // Create bridge (will pick Zenoh if enabled/configured)
    let mut bridge = create_bridge().await.map_err(|e| e.to_string())?;

    // Connect
    bridge.connect().await.map_err(|e| e.to_string())?;

    // Disconnect any existing transport before replacing it
    let mut guard = TRANSPORT_ENGINE.lock().await;
    if let Some(old_bridge) = guard.as_mut() {
        if let Err(e) = old_bridge.disconnect().await {
            log::warn!("Failed to disconnect old transport: {}", e);
        }
    }
    *guard = Some(bridge);

    log::info!("Transport connected successfully");
    Ok(())
}

/// Disconnect from the transport layer
#[tauri::command]
pub async fn transport_disconnect() -> Result<(), String> {
    log::info!("Disconnecting transport...");

    let mut guard = TRANSPORT_ENGINE.lock().await;

    if let Some(bridge) = guard.as_mut() {
        bridge.disconnect().await.map_err(|e| e.to_string())?;
    }

    *guard = None;
    Ok(())
}

/// Subscribe to a camera topic
/// frames will be emitted as events with the same name as the topic
#[tauri::command]
pub async fn transport_subscribe_camera(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

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

    bridge
        .subscribe_camera(&topic, callback)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Subscribe to a CameraInfo topic
/// messages will be emitted as events with the same name as the topic
#[tauri::command]
pub async fn transport_subscribe_camera_info(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

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

    bridge
        .subscribe_camera_info(&topic, callback)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Subscribe to an IMU topic
#[tauri::command]
pub async fn transport_subscribe_imu(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

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

    bridge
        .subscribe_imu(&topic, callback)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Subscribe to a Pose topic
#[tauri::command]
pub async fn transport_subscribe_pose(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

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

    bridge
        .subscribe_pose(&topic, callback)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Subscribe to Model States
#[tauri::command]
pub async fn transport_subscribe_model_states(app: AppHandle, topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

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

    bridge
        .subscribe_model_states(&topic, callback)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Unsubscribe from a topic
#[tauri::command]
pub async fn transport_unsubscribe(topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let Some(bridge) = guard.as_ref() else {
        log::debug!(
            "Ignoring unsubscribe for '{}' because transport is disconnected",
            topic
        );
        return Ok(());
    };
    bridge.unsubscribe(&topic).await.map_err(|e| e.to_string())
}

/// Publish velocity command
#[tauri::command]
pub async fn transport_publish_velocity(topic: String, cmd: VelocityCmd) -> Result<(), String> {
    validate_topic(&topic)?;
    validate_velocity_cmd("cmd", &cmd)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

    bridge
        .publish_velocity(&topic, cmd)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Publish stamped velocity command (geometry_msgs/TwistStamped)
#[tauri::command]
pub async fn transport_publish_twist_stamped(
    topic: String,
    cmd: TwistStampedData,
) -> Result<(), String> {
    validate_topic(&topic)?;
    validate_twist_stamped(&cmd)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

    bridge
        .publish_twist_stamped(&topic, cmd)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Publish pose setpoint
#[tauri::command]
pub async fn transport_publish_pose(topic: String, pose: PoseData) -> Result<(), String> {
    validate_topic(&topic)?;
    validate_pose_data(&pose)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

    bridge
        .publish_pose(&topic, pose)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn transport_spawn_gazebo_model(request: GazeboSpawnModelRequest) -> Result<(), String> {
    validate_gazebo_spawn_request(&request)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    let pose = request.initial_pose;
    let args = serde_json::json!({
        "name": request.name,
        "xml": request.xml,
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
    bridge
        .call_service("/gazebo/spawn_entity", "gazebo_msgs/SpawnEntity", args)
        .await
        .map_err(|e| e.to_string())
}

/// Get transport statistics
#[tauri::command]
pub async fn transport_get_stats() -> Result<TransportStats, String> {
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

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
    if msg_type.trim().is_empty() {
        return Err("Message type must not be empty".to_string());
    }
    if msg_type.contains('\0') {
        return Err("Message type must not contain null bytes".to_string());
    }
    if !msg_type.contains('/') {
        return Err(format!("Message type must contain '/': {}", msg_type));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_topic_accepts_common_ros_topics() {
        assert!(validate_topic("/camera/image_raw").is_ok());
        assert!(validate_topic("mavros/local_position/pose").is_ok());
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
            .contains("must not be empty"));
        assert!(validate_topic("/camera\0/image")
            .unwrap_err()
            .contains("null bytes"));
        let oversized = format!("/{}", "a".repeat(MAX_TOPIC_LEN));
        assert!(validate_topic(&oversized).unwrap_err().contains("too long"));
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
    fn transport_event_name_preserves_safe_ascii() {
        assert_eq!(
            transport_event_name("camera.image-raw_1"),
            "crebain.transport.camera.image-raw_1"
        );
    }

    #[test]
    fn transport_event_name_encodes_ros_separators_spaces_and_utf8() {
        assert_eq!(
            transport_event_name("/camera/image raw"),
            "crebain.transport.%2Fcamera%2Fimage%20raw"
        );
        assert_eq!(
            transport_event_name("/über/image"),
            "crebain.transport.%2F%C3%BCber%2Fimage"
        );
    }
}
