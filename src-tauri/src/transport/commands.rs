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
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    let event_name = topic.clone();
    
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
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;

    let event_name = topic.clone();

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
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    let event_name = topic.clone();
    
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
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    let event_name = topic.clone();
    
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
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    let event_name = topic.clone();
    
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
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    bridge.unsubscribe(&topic).await.map_err(|e| e.to_string())
}

/// Publish velocity command
#[tauri::command]
pub async fn transport_publish_velocity(
    topic: String,
    cmd: VelocityCmd,
) -> Result<(), String> {
    let guard = TRANSPORT_ENGINE.lock().await;
    let bridge = guard.as_ref().ok_or("Transport not connected")?;
    
    bridge.publish_velocity(&topic, cmd).await.map_err(|e| e.to_string())?;
    
    Ok(())
}

/// Publish stamped velocity command (geometry_msgs/TwistStamped)
#[tauri::command]
pub async fn transport_publish_twist_stamped(topic: String, cmd: TwistStampedData) -> Result<(), String> {
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
