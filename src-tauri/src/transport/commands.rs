use super::{
    create_bridge, CameraFrame, CameraInfoData, CameraStreamKind, ImuData, ModelStates, PoseData,
    Transport, TransportError, TransportStats,
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
