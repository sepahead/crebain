//! CREBAIN Transport Layer
//! Adaptive Response & Awareness System (ARAS)
//!
//! Read-only telemetry ingestion from CREBAIN's own peers. Zenoh is the
//! product transport and native rosbridge remains a backend-only fallback.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────┐                     ┌─────────────────┐
//! │  CREBAIN peers  │     Zenoh           │   Tauri App     │
//! │  (plain-topic   │◄──────────────────►│                 │
//! │   key exprs)    │   pub/sub data     │   zenoh-rs      │
//! └─────────────────┘                     └─────────────────┘
//! ```
//!
//! NOTE: the Zenoh transport uses a plain-topic key scheme (topic minus the
//! leading `/`), not the `rmw_zenoh_cpp` keying scheme. Talking directly to
//! an rmw_zenoh_cpp ROS graph requires a re-keying bridge; see the
//! `zenoh` module docs for details. The fallback (`CREBAIN_ZENOH=0`) exposes
//! the same subscription-only interface; it cannot publish or call services.
//!
//! # Usage
//!
//! ```rust,ignore
//! use crate::transport::{ZenohBridge, create_bridge};
//!
//! let bridge = create_bridge().await?;
//!
//! // Subscribe to camera feed
//! bridge.subscribe_camera("/drone1/camera/image_raw", CameraStreamKind::Raw, |delivery| {
//!     // Forward the owned delivery to the bounded IPC pull/ack state.
//!     consume_delivery(delivery);
//! }).await?;
//!
//! ```

mod camera_work;
pub mod commands;
pub mod rosbridge;
pub mod zenoh;

use std::future::Future;
use std::pin::Pin;

use self::camera_work::CameraWorkPermit;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Camera frame normalized from the native ROS/Zenoh transport.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CameraFrame {
    /// Image bytes, base64-encoded for Tauri IPC.
    ///
    /// NOTE: Sending `Vec<u8>` through Tauri events would serialize as a JSON
    /// array of numbers, which is extremely large and slow for camera frames.
    pub data: String,
    /// Image width
    pub width: u32,
    /// Image height
    pub height: u32,
    /// Encoding (rgb8, bgr8, compressed)
    pub encoding: String,
    /// Timestamp (seconds since epoch)
    pub timestamp: f64,
    /// Frame ID
    pub frame_id: String,
    /// Whether pixel data is big-endian (0 = little, 1 = big)
    pub is_bigendian: u8,
    /// Row stride in bytes
    pub step: u32,
}

/// Internal camera frame plus its weighted native ingress reservation.
///
/// This type is public only because it crosses the object-safe [`Transport`]
/// callback boundary. Product code hands it directly to the bounded IPC
/// delivery state; the reservation is not serialized to the renderer.
#[doc(hidden)]
#[derive(Debug)]
pub struct CameraFrameDelivery {
    frame: CameraFrame,
    permit: CameraWorkPermit,
}

impl CameraFrameDelivery {
    pub(crate) fn new(frame: CameraFrame, permit: CameraWorkPermit) -> Self {
        Self { frame, permit }
    }

    pub(crate) fn into_parts(self) -> (CameraFrame, CameraWorkPermit) {
        (self.frame, self.permit)
    }
}

/// Camera calibration and projection parameters
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CameraInfoData {
    pub height: u32,
    pub width: u32,
    pub distortion_model: String,
    pub d: Vec<f64>,
    pub k: [f64; 9],
    pub r: [f64; 9],
    pub p: [f64; 12],
    pub timestamp: f64,
    pub frame_id: String,
}

/// IMU data normalized from the native ROS/Zenoh transport.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImuData {
    pub orientation: [f64; 4], // Quaternion [x, y, z, w]
    /// ROS covariance matrix. A first value of `-1` means that orientation is
    /// unavailable; preserving that sentinel prevents a zero wire quaternion
    /// from being misrepresented as a measured orientation.
    pub orientation_covariance: [f64; 9],
    pub angular_velocity: [f64; 3], // rad/s
    pub angular_velocity_covariance: [f64; 9],
    pub linear_acceleration: [f64; 3], // m/s²
    pub linear_acceleration_covariance: [f64; 9],
    pub timestamp: f64,
    pub frame_id: String,
}

/// Pose data (position + orientation)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PoseData {
    pub position: [f64; 3],    // [x, y, z] meters
    pub orientation: [f64; 4], // Quaternion [x, y, z, w]
    pub timestamp: f64,
    pub frame_id: String,
}

/// Velocity command
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VelocityCmd {
    pub linear: [f64; 3],  // [x, y, z] m/s
    pub angular: [f64; 3], // [x, y, z] rad/s
}

/// Model states from Gazebo
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelStates {
    pub name: Vec<String>,
    pub pose: Vec<PoseData>,
    pub twist: Vec<VelocityCmd>,
}

/// Transport error
#[derive(Debug)]
pub enum TransportError {
    ConnectionFailed(String),
    SubscriptionFailed(String),
    SendFailed(String),
    DecodingError(String),
    Timeout,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::ConnectionFailed(s) => write!(f, "Connection failed: {}", s),
            TransportError::SubscriptionFailed(s) => write!(f, "Subscription failed: {}", s),
            TransportError::SendFailed(s) => write!(f, "Transport send failed: {}", s),
            TransportError::DecodingError(s) => write!(f, "Decoding error: {}", s),
            TransportError::Timeout => write!(f, "Operation timed out"),
        }
    }
}

impl std::error::Error for TransportError {}

pub type Result<T> = std::result::Result<T, TransportError>;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TRANSPORT TRAIT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Callback type aliases for object safety
pub type CameraCallback = Box<dyn Fn(CameraFrameDelivery) + Send + Sync>;
pub type CameraInfoCallback = Box<dyn Fn(CameraInfoData) + Send + Sync>;
pub type ImuCallback = Box<dyn Fn(ImuData) + Send + Sync>;
pub type PoseCallback = Box<dyn Fn(PoseData) + Send + Sync>;
pub type ModelStatesCallback = Box<dyn Fn(ModelStates) + Send + Sync>;

/// Wire schema for camera subscriptions. This is explicit because compressed
/// image topics are not required to end in `/compressed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraStreamKind {
    Raw,
    Compressed,
}

/// Object-safe, telemetry-only transport abstraction.
///
/// This trait deliberately has no generic publish, service, setpoint, or
/// actuator method. A future plant integration must use a separate narrow,
/// typed adapter with its own authority checks.
pub trait Transport: Send + Sync {
    /// Connect to the transport
    fn connect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;

    /// Disconnect from the transport.
    ///
    /// Takes `&self` so a shared handle (`Arc<dyn Transport>`) can disconnect
    /// without holding a global lock across the await; implementations use
    /// interior mutability.
    fn disconnect(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;

    /// Check if connected
    fn is_connected(&self) -> bool;

    /// Subscribe to camera topic
    fn subscribe_camera(
        &self,
        topic: &str,
        stream_kind: CameraStreamKind,
        callback: CameraCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;

    /// Subscribe to camera info topic
    fn subscribe_camera_info(
        &self,
        topic: &str,
        callback: CameraInfoCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;

    /// Subscribe to IMU topic
    fn subscribe_imu(
        &self,
        topic: &str,
        callback: ImuCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;

    /// Subscribe to pose topic
    fn subscribe_pose(
        &self,
        topic: &str,
        callback: PoseCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;

    /// Subscribe to model states
    fn subscribe_model_states(
        &self,
        topic: &str,
        callback: ModelStatesCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;

    /// Unsubscribe from a topic
    fn unsubscribe(&self, topic: &str) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>>;

    /// Get transport statistics
    fn stats(&self) -> TransportStats;
}

/// Transport statistics
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct TransportStats {
    /// Messages received
    pub messages_received: u64,
    /// Messages sent
    pub messages_sent: u64,
    /// Average latency in milliseconds
    pub avg_latency_ms: f64,
    /// Bytes received
    pub bytes_received: u64,
    /// Bytes sent
    pub bytes_sent: u64,
    /// Connection uptime in seconds
    pub uptime_secs: f64,
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Create the optimal transport for the current environment
pub async fn create_bridge() -> Result<Box<dyn Transport>> {
    let use_zenoh = match std::env::var("CREBAIN_ZENOH") {
        Ok(value) => parse_zenoh_enabled(&value)?,
        Err(std::env::VarError::NotPresent) => true,
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(TransportError::ConnectionFailed(
                "CREBAIN_ZENOH must contain valid UTF-8".to_string(),
            ));
        }
    };

    if use_zenoh {
        log::info!("[Transport] Using Zenoh transport");
        let bridge = zenoh::ZenohBridge::new().await?;
        Ok(Box::new(bridge))
    } else {
        log::info!("[Transport] Zenoh disabled, using rosbridge WebSocket fallback");
        let rosbridge_url = std::env::var("CREBAIN_ROSBRIDGE_URL").ok();
        let bridge = rosbridge::RosbridgeTransport::connect(rosbridge_url.as_deref()).await?;
        Ok(Box::new(bridge))
    }
}

fn parse_zenoh_enabled(value: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(TransportError::ConnectionFailed(format!(
            "Invalid CREBAIN_ZENOH value {value:?}; expected one of 1/true/yes/on or 0/false/no/off"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn restore_env_var(name: &str, value: Option<String>) {
        if let Some(value) = value {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }

    #[test]
    fn test_parse_zenoh_enabled() {
        for value in ["1", "true", " YES ", "on"] {
            assert!(parse_zenoh_enabled(value).unwrap(), "{value}");
        }
        for value in ["0", "false", " NO ", "off"] {
            assert!(!parse_zenoh_enabled(value).unwrap(), "{value}");
        }
    }

    #[test]
    fn malformed_zenoh_selection_is_rejected_instead_of_selecting_fallback() {
        for value in ["", "enabled", "2", "tru"] {
            let error = parse_zenoh_enabled(value).unwrap_err();
            assert!(error.to_string().contains("Invalid CREBAIN_ZENOH"));
        }
    }

    #[test]
    fn bridge_creation_rejects_malformed_zenoh_selection_before_network_access() {
        let _guard = ENV_LOCK.lock().unwrap();
        let original_zenoh = std::env::var("CREBAIN_ZENOH").ok();
        std::env::set_var("CREBAIN_ZENOH", "automatic");

        let result = tauri::async_runtime::block_on(create_bridge());
        restore_env_var("CREBAIN_ZENOH", original_zenoh);
        let error = match result {
            Ok(_) => panic!("malformed selector unexpectedly created a bridge"),
            Err(error) => error,
        };

        assert!(error.to_string().contains("Invalid CREBAIN_ZENOH"));
    }

    #[test]
    fn test_transport_error_display() {
        let err = TransportError::ConnectionFailed("missing zenoh router".to_string());
        assert_eq!(err.to_string(), "Connection failed: missing zenoh router");
        assert_eq!(TransportError::Timeout.to_string(), "Operation timed out");
    }

    #[test]
    fn zenoh_fallback_switches_to_rosbridge_when_disabled() {
        let _guard = ENV_LOCK.lock().unwrap();
        // Save original
        let original_zenoh = std::env::var("CREBAIN_ZENOH").ok();
        let original_url = std::env::var("CREBAIN_ROSBRIDGE_URL").ok();

        // Disable Zenoh
        std::env::set_var("CREBAIN_ZENOH", "0");
        std::env::remove_var("CREBAIN_ROSBRIDGE_URL");

        // create_bridge should attempt rosbridge (will fail without server, but shouldn't panic)
        let result = tauri::async_runtime::block_on(create_bridge());
        assert!(result.is_err());

        // Restore
        restore_env_var("CREBAIN_ZENOH", original_zenoh);
        restore_env_var("CREBAIN_ROSBRIDGE_URL", original_url);
    }

    #[test]
    fn rosbridge_transport_connect_fails_without_server() {
        let result = tauri::async_runtime::block_on(rosbridge::RosbridgeTransport::connect(Some(
            "ws://127.0.0.1:19999",
        )));
        assert!(result.is_err());
    }

    #[test]
    fn rosbridge_transport_trait_methods_no_panic() {
        let result = tauri::async_runtime::block_on(rosbridge::RosbridgeTransport::connect(Some(
            "ws://127.0.0.1:19999",
        )));
        assert!(result.is_err());
    }

    #[test]
    fn rosbridge_topic_validation_accepts_standard_ros_topics() {
        assert!(rosbridge::validate_topic_for_test("/drone1/camera").is_ok());
        assert!(rosbridge::validate_topic_for_test("").is_err());
        assert!(rosbridge::validate_topic_for_test("no_leading_slash").is_err());
        assert!(rosbridge::validate_topic_for_test("/double//slash").is_err());
        assert!(rosbridge::validate_topic_for_test("/null\0byte").is_err());
    }
}
