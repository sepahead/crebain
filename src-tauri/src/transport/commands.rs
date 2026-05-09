use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use super::{
    create_bridge, CameraFrame, CameraInfoData, ImuData, ModelStates, PoseData, Transport,
    TransportStats, TwistStampedData, VelocityCmd,
};

// Global transport instance
lazy_static::lazy_static! {
    static ref TRANSPORT_ENGINE: Mutex<Option<Box<dyn Transport>>> = Mutex::new(None);
}

const MAX_TOPIC_LEN: usize = 512;
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
pub async fn transport_subscribe_camera(
    app: AppHandle,
    topic: String,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    let event_name = transport_event_name(&topic);
    log::debug!("Subscribing transport topic '{}' as event '{}'", topic, event_name);
    
    // Create callback that emits event to frontend
    // Note: This callback runs on the transport thread
    let callback = Box::new(move |frame: CameraFrame| {
        // Emit event to all windows
        // We might want to optimize this to only emit to specific windows or reduce frequency
        if let Err(e) = app.emit(&event_name, frame) {
            log::warn!("Failed to emit camera frame: {}", e);
        }
    });
    
    bridge.subscribe_camera(&topic, callback).await.map_err(|e| e.to_string())?;
    
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
    log::debug!("Subscribing transport topic '{}' as event '{}'", topic, event_name);

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
pub async fn transport_subscribe_imu(
    app: AppHandle,
    topic: String,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    let event_name = transport_event_name(&topic);
    log::debug!("Subscribing transport topic '{}' as event '{}'", topic, event_name);
    
    let callback = Box::new(move |data: ImuData| {
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit IMU data: {}", e);
        }
    });
    
    bridge.subscribe_imu(&topic, callback).await.map_err(|e| e.to_string())?;
    
    Ok(())
}

/// Subscribe to a Pose topic
#[tauri::command]
pub async fn transport_subscribe_pose(
    app: AppHandle,
    topic: String,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    let event_name = transport_event_name(&topic);
    log::debug!("Subscribing transport topic '{}' as event '{}'", topic, event_name);
    
    let callback = Box::new(move |data: PoseData| {
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit Pose data: {}", e);
        }
    });
    
    bridge.subscribe_pose(&topic, callback).await.map_err(|e| e.to_string())?;
    
    Ok(())
}

/// Subscribe to Model States
#[tauri::command]
pub async fn transport_subscribe_model_states(
    app: AppHandle,
    topic: String,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    let event_name = transport_event_name(&topic);
    log::debug!("Subscribing transport topic '{}' as event '{}'", topic, event_name);
    
    let callback = Box::new(move |data: ModelStates| {
        if let Err(e) = app.emit(&event_name, data) {
            log::warn!("Failed to emit ModelStates: {}", e);
        }
    });
    
    bridge.subscribe_model_states(&topic, callback).await.map_err(|e| e.to_string())?;
    
    Ok(())
}

/// Unsubscribe from a topic
#[tauri::command]
pub async fn transport_unsubscribe(topic: String) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let Some(bridge) = guard.as_ref() else {
        log::debug!("Ignoring unsubscribe for '{}' because transport is disconnected", topic);
        return Ok(());
    };
    bridge.unsubscribe(&topic).await.map_err(|e| e.to_string())
}

/// Publish velocity command
#[tauri::command]
pub async fn transport_publish_velocity(
    topic: String,
    cmd: VelocityCmd,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    bridge.publish_velocity(&topic, cmd).await.map_err(|e| e.to_string())?;
    
    Ok(())
}

/// Publish stamped velocity command (geometry_msgs/TwistStamped)
#[tauri::command]
pub async fn transport_publish_twist_stamped(topic: String, cmd: TwistStampedData) -> Result<(), String> {
    validate_topic(&topic)?;
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
pub async fn transport_publish_pose(
    topic: String,
    pose: PoseData,
) -> Result<(), String> {
    validate_topic(&topic)?;
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    bridge.publish_pose(&topic, pose).await.map_err(|e| e.to_string())?;
    
    Ok(())
}

/// Get transport statistics
#[tauri::command]
pub async fn transport_get_stats() -> Result<TransportStats, String> {
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    Ok(bridge.stats())
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
        assert!(validate_topic("").unwrap_err().contains("must not be empty"));
        assert!(validate_topic("   ").unwrap_err().contains("must not be empty"));
        assert!(validate_topic("/camera\0/image").unwrap_err().contains("null bytes"));
        let oversized = format!("/{}", "a".repeat(MAX_TOPIC_LEN));
        assert!(validate_topic(&oversized).unwrap_err().contains("too long"));
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
