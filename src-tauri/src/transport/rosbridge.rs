//! Rosbridge WebSocket Transport
//!
//! Fallback transport when Zenoh is unavailable. Connects to a
//! rosbridge_server via WebSocket and provides pub/sub for ROS topics.
//!
//! # Protocol
//! rosbridge v2.0 protocol using JSON messages over WebSocket.
//! See: https://github.com/RobotWebTools/rosbridge_suite

use super::{
    CameraFrame, CameraInfoData, CameraStreamKind, ImuData, ModelStates, PoseData, Result,
    Transport, TransportError, TransportStats, TwistStampedData, VelocityCmd,
};
use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

const MAX_TOPIC_LEN: usize = 256;
const MAX_MESSAGE_TYPE_LEN: usize = 128;
const DEFAULT_ROSBRIDGE_URL: &str = "ws://localhost:9090";
/// Maximum queued outgoing messages before publishes fail fast instead of
/// buffering without bound against a slow/stalled server.
const WRITE_QUEUE_CAPACITY: usize = 256;
// Service requests can contain model XML and are much larger than ordinary
// publishes. Keep their in-flight set small so the message-count queue cannot
// retain hundreds of megabytes of request bodies.
const MAX_PENDING_SERVICE_CALLS: usize = 16;
/// How long disconnect() waits for the write task to flush a Close frame.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(1);
/// Shorter than the command-layer timeout so this transport can remove its
/// pending responder before the outer command future is cancelled.
const SERVICE_CALL_TIMEOUT: Duration = Duration::from_secs(8);
/// Camera models use a variable number of distortion coefficients. Bound the
/// sequence while still covering the standard ROS distortion models.
const MAX_DISTORTION_COEFFICIENTS: usize = 32;
const MAX_SERVICE_ERROR_LEN: usize = 512;
const MAX_CAMERA_ENCODING_LEN: usize = 64;
const MAX_FRAME_ID_LEN: usize = 256;
const MAX_MODEL_STATES: usize = 10_000;
const MAX_MODEL_NAME_LEN: usize = 256;
const MAX_POSITION_MAGNITUDE_M: f64 = 1_000_000.0;
const MAX_LINEAR_SPEED_MPS: f64 = 100.0;
const MAX_ANGULAR_SPEED_RAD_S: f64 = 50.0;
const MAX_INCOMING_WS_MESSAGE_BYTES: usize =
    crate::common::image::MAX_BASE64_IMAGE_CHARS + 64 * 1024;
const MAX_INCOMING_JSON_SEQUENCE_ITEMS: usize = 10_000;
const MAX_INCOMING_JSON_OBJECT_FIELDS: usize = 1_024;

/// Read a ROS2 `builtin_interfaces/Time` header stamp as seconds.
///
/// ROS2 names the fields `sec` (int32) and `nanosec` (uint32); ROS1 used
/// `secs`/`nsecs`. Every topic here is declared as a ROS2 (`/msg/`) type, so a
/// real rosbridge_server serializes `sec`/`nanosec` — reading only `secs` made
/// every timestamp fall back to 0 and dropped the sub-second part. We read the
/// ROS2 names first and fall back to the ROS1 names for compatibility.
#[cfg(test)]
fn ros2_stamp_seconds(msg: &serde_json::Value) -> f64 {
    let Some(stamp) = msg.get("header").and_then(|h| h.get("stamp")) else {
        return 0.0;
    };
    let sec = stamp
        .get("sec")
        .or_else(|| stamp.get("secs"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let nanosec = stamp
        .get("nanosec")
        .or_else(|| stamp.get("nsecs"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    sec + nanosec * 1e-9
}

/// Build the ROS 1 time shape used by the documented rosbridge fallback,
/// preserving the sub-second component instead of hardcoding nanoseconds to 0.
fn rosbridge_stamp_json(timestamp: f64) -> serde_json::Value {
    let sec = timestamp.trunc();
    let nanosec = ((timestamp - sec) * 1e9).round().clamp(0.0, 999_999_999.0) as u32;
    serde_json::json!({ "secs": sec as i64, "nsecs": nanosec })
}

fn parse_ros_header(msg: &serde_json::Value) -> Result<(f64, String)> {
    let header = msg
        .get("header")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| TransportError::DecodingError("Missing ROS header".to_string()))?;
    let stamp = header
        .get("stamp")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| TransportError::DecodingError("Missing ROS header.stamp".to_string()))?;
    let seconds = stamp
        .get("sec")
        .or_else(|| stamp.get("secs"))
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value >= 0 && *value <= i32::MAX as i64)
        .ok_or_else(|| {
            TransportError::DecodingError(
                "ROS header seconds must be a non-negative int32".to_string(),
            )
        })?;
    let nanoseconds = stamp
        .get("nanosec")
        .or_else(|| stamp.get("nsecs"))
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value < 1_000_000_000)
        .ok_or_else(|| {
            TransportError::DecodingError(
                "ROS header nanoseconds must be within [0, 1000000000)".to_string(),
            )
        })?;
    let frame_id = header
        .get("frame_id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if frame_id.len() > MAX_FRAME_ID_LEN
        || frame_id.contains('\0')
        || frame_id.chars().any(char::is_control)
    {
        return Err(TransportError::DecodingError(
            "ROS header.frame_id is invalid or too long".to_string(),
        ));
    }

    Ok((
        seconds as f64 + nanoseconds as f64 * 1e-9,
        frame_id.to_string(),
    ))
}

fn parse_json_f64(msg: &serde_json::Value, pointer: &str) -> Result<f64> {
    msg.pointer(pointer)
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite())
        .ok_or_else(|| TransportError::DecodingError(format!("{pointer} must be a finite number")))
}

struct RosbridgeValueSeed;

impl<'de> DeserializeSeed<'de> for RosbridgeValueSeed {
    type Value = serde_json::Value;

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(RosbridgeValueVisitor)
    }
}

struct RosbridgeValueVisitor;

impl<'de> Visitor<'de> for RosbridgeValueVisitor {
    type Value = serde_json::Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded rosbridge JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> std::result::Result<Self::Value, E> {
        Ok(serde_json::Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> std::result::Result<Self::Value, E> {
        Ok(serde_json::Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E> {
        Ok(serde_json::Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(serde_json::Value::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E> {
        Ok(serde_json::Value::String(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E> {
        Ok(serde_json::Value::String(value))
    }

    fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(serde_json::Value::Null)
    }

    fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(serde_json::Value::Null)
    }

    fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(RosbridgeValueSeed)? {
            if values.len() >= MAX_INCOMING_JSON_SEQUENCE_ITEMS {
                return Err(serde::de::Error::custom(format!(
                    "JSON sequence exceeds {MAX_INCOMING_JSON_SEQUENCE_ITEMS} items"
                )));
            }
            values.push(value);
        }
        Ok(serde_json::Value::Array(values))
    }

    fn visit_map<A>(self, mut object: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = serde_json::Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.len() >= MAX_INCOMING_JSON_OBJECT_FIELDS {
                return Err(serde::de::Error::custom(format!(
                    "JSON object exceeds {MAX_INCOMING_JSON_OBJECT_FIELDS} fields"
                )));
            }
            let value = if key == "data" {
                object.next_value_seed(Base64DataSeed)?
            } else {
                object.next_value_seed(RosbridgeValueSeed)?
            };
            values.insert(key, value);
        }
        Ok(serde_json::Value::Object(values))
    }
}

struct Base64DataSeed;

impl<'de> DeserializeSeed<'de> for Base64DataSeed {
    type Value = serde_json::Value;

    fn deserialize<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_str(Base64DataVisitor)
    }
}

struct Base64DataVisitor;

impl Visitor<'_> for Base64DataVisitor {
    type Value = serde_json::Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("bounded base64 text for a rosbridge data field")
    }

    fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        crate::common::image::validate_base64_image_len(value.len()).map_err(E::custom)?;
        Ok(serde_json::Value::String(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E>
    where
        E: serde::de::Error,
    {
        crate::common::image::validate_base64_image_len(value.len()).map_err(E::custom)?;
        Ok(serde_json::Value::String(value))
    }
}

fn parse_incoming_rosbridge_json(text: &str) -> serde_json::Result<serde_json::Value> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = RosbridgeValueSeed.deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(value)
}

pub fn validate_topic_for_test(topic: &str) -> Result<()> {
    validate_topic(topic)
}

pub fn validate_message_type_for_test(msg_type: &str) -> Result<()> {
    validate_message_type(msg_type)
}

fn validate_topic(topic: &str) -> Result<()> {
    if topic.is_empty() || topic.trim() != topic || topic.len() > MAX_TOPIC_LEN {
        return Err(TransportError::SubscriptionFailed(format!(
            "Invalid topic length: {}",
            topic.len()
        )));
    }
    if topic == "/" || !topic.starts_with('/') {
        return Err(TransportError::SubscriptionFailed(
            "Topic must start with '/'".to_string(),
        ));
    }
    if topic.contains("//")
        || topic.contains('\0')
        || !topic
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '/'))
    {
        return Err(TransportError::SubscriptionFailed(format!(
            "Invalid topic: {}",
            topic
        )));
    }
    Ok(())
}

fn validate_message_type(msg_type: &str) -> Result<()> {
    if msg_type.is_empty() || msg_type.trim() != msg_type || msg_type.len() > MAX_MESSAGE_TYPE_LEN {
        return Err(TransportError::PublishFailed(format!(
            "Invalid message type length: {}",
            msg_type.len()
        )));
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
        return Err(TransportError::PublishFailed(format!(
            "Invalid message type: {}",
            msg_type
        )));
    }
    Ok(())
}

/// Shared so the read task can clone a callback out of the subscriptions map
/// and invoke it without holding the map's lock across the call.
type SubscriptionCallback = Arc<dyn Fn(serde_json::Value) + Send + Sync>;

#[derive(Debug)]
enum ServiceReply {
    Response(serde_json::Value),
    ProtocolError(String),
}

type ServiceResponder = oneshot::Sender<ServiceReply>;

struct PendingServiceResponder {
    service: String,
    responder: ServiceResponder,
}

/// Lock a mutex, recovering the guard if the mutex was poisoned by a panic in
/// another thread. The subscription map only holds callback handles, so a prior
/// panic does not leave it logically inconsistent; recovering keeps the transport
/// alive instead of cascading the panic across every later `lock()`.
fn lock_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn bounded_error_message(message: &str) -> String {
    let mut chars = message.chars();
    let bounded: String = chars.by_ref().take(MAX_SERVICE_ERROR_LEN).collect();
    if chars.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}

fn error_value_message(field: &serde_json::Value) -> Option<String> {
    match field {
        serde_json::Value::String(message) if !message.trim().is_empty() => {
            Some(bounded_error_message(message))
        }
        serde_json::Value::Null | serde_json::Value::Bool(false) => None,
        other => Some(bounded_error_message(&other.to_string())),
    }
}

fn service_error_field(value: &serde_json::Value) -> Option<String> {
    ["/error", "/msg", "/values/error", "/values/status_message"]
        .iter()
        .filter_map(|pointer| value.pointer(pointer))
        .find_map(error_value_message)
}

fn validate_service_response_with_policy(
    response: &serde_json::Value,
    require_service_success: bool,
) -> Result<()> {
    if response.get("op").and_then(serde_json::Value::as_str) != Some("service_response") {
        return Err(TransportError::DecodingError(
            "Expected rosbridge service_response".to_string(),
        ));
    }

    if let Some(detail) = response.get("error").and_then(error_value_message) {
        return Err(TransportError::PublishFailed(format!(
            "Service call failed: {detail}"
        )));
    }

    let result = response
        .get("result")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| {
            TransportError::DecodingError(
                "rosbridge service_response is missing boolean result".to_string(),
            )
        })?;

    if !result {
        let detail = service_error_field(response)
            .unwrap_or_else(|| "rosbridge reported result=false".to_string());
        return Err(TransportError::PublishFailed(format!(
            "Service call failed: {detail}"
        )));
    }

    if let Some(success) = response.pointer("/values/success") {
        let success = success.as_bool().ok_or_else(|| {
            TransportError::DecodingError(
                "rosbridge service_response values.success must be boolean".to_string(),
            )
        })?;
        if !success {
            let detail = service_error_field(response)
                .unwrap_or_else(|| "service reported success=false".to_string());
            return Err(TransportError::PublishFailed(format!(
                "Service call failed: {detail}"
            )));
        }
    } else if require_service_success {
        return Err(TransportError::DecodingError(
            "rosbridge service response is missing values.success".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
fn validate_service_response(response: &serde_json::Value) -> Result<()> {
    validate_service_response_with_policy(response, false)
}

fn service_type_requires_success(service_type: &str) -> bool {
    matches!(
        service_type.rsplit('/').next(),
        Some("SpawnModel" | "SpawnEntity" | "DeleteModel")
    )
}

fn normalize_camera_token(value: &str, field: &str, allow_empty: bool) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if value.chars().any(char::is_control)
        || (!allow_empty && normalized.is_empty())
        || normalized.len() > MAX_CAMERA_ENCODING_LEN
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return Err(TransportError::DecodingError(format!(
            "{field} must be a safe token up to {MAX_CAMERA_ENCODING_LEN} characters"
        )));
    }
    Ok(normalized)
}

fn normalize_compressed_format(value: &str) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if value.chars().any(char::is_control)
        || normalized.len() > MAX_CAMERA_ENCODING_LEN
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '-' | '.' | '/' | ';' | ' ')
        })
    {
        return Err(TransportError::DecodingError(format!(
            "CompressedImage.format must be safe and at most {MAX_CAMERA_ENCODING_LEN} characters"
        )));
    }
    Ok(normalized)
}

fn declared_compressed_format(format: &str) -> Option<image::ImageFormat> {
    if format.is_empty() {
        return Some(image::ImageFormat::Jpeg);
    }
    format
        .split(|character: char| !character.is_ascii_alphanumeric())
        .find_map(|token| match token {
            "png" => Some(image::ImageFormat::Png),
            "jpeg" | "jpg" => Some(image::ImageFormat::Jpeg),
            _ => None,
        })
}

fn parse_finite_vec(
    msg: &serde_json::Value,
    field: &str,
    expected_len: Option<usize>,
) -> Result<Vec<f64>> {
    let values = msg
        .get(field)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            TransportError::DecodingError(format!("CameraInfo.{field} must be an array"))
        })?;

    if let Some(expected_len) = expected_len {
        if values.len() != expected_len {
            return Err(TransportError::DecodingError(format!(
                "CameraInfo.{field} must contain exactly {expected_len} values, got {}",
                values.len()
            )));
        }
    } else if values.len() > MAX_DISTORTION_COEFFICIENTS {
        return Err(TransportError::DecodingError(format!(
            "CameraInfo.{field} contains {} values, maximum is {MAX_DISTORTION_COEFFICIENTS}",
            values.len()
        )));
    }

    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            value
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| {
                    TransportError::DecodingError(format!(
                        "CameraInfo.{field}[{index}] must be a finite number"
                    ))
                })
        })
        .collect()
}

fn parse_finite_array<const N: usize>(msg: &serde_json::Value, field: &str) -> Result<[f64; N]> {
    let values = parse_finite_vec(msg, field, Some(N))?;
    values.try_into().map_err(|values: Vec<f64>| {
        TransportError::DecodingError(format!(
            "CameraInfo.{field} must contain exactly {N} values, got {}",
            values.len()
        ))
    })
}

fn parse_camera_info(msg: &serde_json::Value) -> Result<CameraInfoData> {
    let (timestamp, frame_id) = parse_ros_header(msg)?;
    let height = msg
        .get("height")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| {
            TransportError::DecodingError("CameraInfo.height must be a uint32".to_string())
        })?;
    let width = msg
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| {
            TransportError::DecodingError("CameraInfo.width must be a uint32".to_string())
        })?;
    if width == 0
        || height == 0
        || width > crate::common::image::MAX_IMAGE_DIMENSION
        || height > crate::common::image::MAX_IMAGE_DIMENSION
    {
        return Err(TransportError::DecodingError(format!(
            "CameraInfo dimensions must be within 1..={}, got {width}x{height}",
            crate::common::image::MAX_IMAGE_DIMENSION
        )));
    }
    let distortion_model = msg
        .get("distortion_model")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            TransportError::DecodingError(
                "CameraInfo.distortion_model must be a string".to_string(),
            )
        })?;
    let distortion_model =
        normalize_camera_token(distortion_model, "CameraInfo.distortion_model", true)?;
    // D is variable-length in sensor_msgs/CameraInfo, but the standard
    // distortion models define exact coefficient counts. Custom models remain
    // supported with the bounded, all-finite validation above.
    let distortion_len = match distortion_model.as_str() {
        "plumb_bob" => Some(5),
        "rational_polynomial" => Some(8),
        "equidistant" => Some(4),
        _ => None,
    };
    let d = parse_finite_vec(msg, "d", distortion_len)?;
    let k = parse_finite_array(msg, "k")?;
    let r = parse_finite_array(msg, "r")?;
    let p = parse_finite_array(msg, "p")?;

    Ok(CameraInfoData {
        height,
        width,
        distortion_model,
        d,
        k,
        r,
        p,
        timestamp,
        frame_id,
    })
}

fn parse_rosbridge_bytes(msg: &serde_json::Value, field: &str) -> Result<Vec<u8>> {
    let value = msg.get(field).ok_or_else(|| {
        TransportError::DecodingError(format!("Missing byte array field {field}"))
    })?;

    let encoded = value.as_str().ok_or_else(|| {
        TransportError::DecodingError(format!(
            "{field} must be bounded base64 text; JSON byte arrays are not accepted"
        ))
    })?;
    crate::common::image::validate_base64_image_len(encoded.len())
        .map_err(TransportError::DecodingError)?;
    let decoded = general_purpose::STANDARD.decode(encoded).map_err(|error| {
        TransportError::DecodingError(format!("Invalid base64 {field}: {error}"))
    })?;
    if decoded.len() > crate::common::image::MAX_IMAGE_SIZE_BYTES {
        return Err(TransportError::DecodingError(format!(
            "{field} exceeds maximum decoded size {}",
            crate::common::image::MAX_IMAGE_SIZE_BYTES
        )));
    }
    Ok(decoded)
}

fn parse_camera_dimensions(msg: &serde_json::Value) -> Result<(u32, u32)> {
    let width = msg
        .get("width")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| TransportError::DecodingError("Image.width must be uint32".to_string()))?;
    let height = msg
        .get("height")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| TransportError::DecodingError("Image.height must be uint32".to_string()))?;
    crate::common::image::validate_rgba_dimensions(width, height)
        .map_err(TransportError::DecodingError)?;
    Ok((width, height))
}

fn raw_bytes_per_pixel(encoding: &str) -> Option<usize> {
    match encoding {
        "rgba8" | "bgra8" => Some(4),
        "rgb8" | "bgr8" => Some(3),
        "mono8" => Some(1),
        _ => None,
    }
}

fn parse_raw_camera_frame(msg: &serde_json::Value) -> Result<CameraFrame> {
    let (timestamp, frame_id) = parse_ros_header(msg)?;
    let (width, height) = parse_camera_dimensions(msg)?;
    let encoding = msg
        .get("encoding")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            TransportError::DecodingError("Image.encoding must be a string".to_string())
        })?;
    let encoding = normalize_camera_token(encoding, "Image.encoding", false)?;
    let bytes_per_pixel = raw_bytes_per_pixel(&encoding).ok_or_else(|| {
        TransportError::DecodingError(format!("Unsupported raw image encoding: {encoding}"))
    })?;
    let is_bigendian = msg
        .get("is_bigendian")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u8::try_from(value).ok())
        .filter(|value| *value <= 1)
        .ok_or_else(|| {
            TransportError::DecodingError("Image.is_bigendian must be 0 or 1".to_string())
        })?;
    let step = msg
        .get("step")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| TransportError::DecodingError("Image.step must be uint32".to_string()))?;
    let minimum_step = (width as usize)
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| TransportError::DecodingError("Image row size overflow".to_string()))?;
    if (step as usize) < minimum_step {
        return Err(TransportError::DecodingError(format!(
            "Image.step {step} is smaller than minimum row size {minimum_step}"
        )));
    }
    let expected_len = (step as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| TransportError::DecodingError("Image data size overflow".to_string()))?;
    if expected_len > crate::common::image::MAX_IMAGE_SIZE_BYTES {
        return Err(TransportError::DecodingError(format!(
            "Image data size {expected_len} exceeds maximum {}",
            crate::common::image::MAX_IMAGE_SIZE_BYTES
        )));
    }
    let bytes = parse_rosbridge_bytes(msg, "data")?;
    if bytes.len() != expected_len {
        return Err(TransportError::DecodingError(format!(
            "Image data length {} does not match height * step {expected_len}",
            bytes.len()
        )));
    }

    Ok(CameraFrame {
        data: general_purpose::STANDARD.encode(bytes),
        width,
        height,
        encoding,
        timestamp,
        frame_id,
        is_bigendian,
        step,
    })
}

fn parse_compressed_camera_frame(msg: &serde_json::Value) -> Result<CameraFrame> {
    let (timestamp, frame_id) = parse_ros_header(msg)?;
    let format = msg
        .get("format")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            TransportError::DecodingError("CompressedImage.format must be a string".to_string())
        })?;
    let format = normalize_compressed_format(format)?;
    let bytes = parse_rosbridge_bytes(msg, "data")?;
    let (detected_format, width, height) = crate::common::image::inspect_encoded_image(&bytes)
        .map_err(TransportError::DecodingError)?;
    if declared_compressed_format(&format) != Some(detected_format) {
        return Err(TransportError::DecodingError(format!(
            "CompressedImage.format {format:?} does not match encoded image"
        )));
    }
    let encoding = if format.is_empty() {
        "jpeg".to_string()
    } else {
        format
    };

    Ok(CameraFrame {
        data: general_purpose::STANDARD.encode(bytes),
        width,
        height,
        encoding,
        timestamp,
        frame_id,
        is_bigendian: 0,
        step: 0,
    })
}

fn validate_magnitude(name: &str, values: &[f64], maximum: f64) -> Result<()> {
    let magnitude = values
        .iter()
        .fold(0.0_f64, |accumulator, value| accumulator.hypot(*value));
    if magnitude > maximum {
        return Err(TransportError::DecodingError(format!(
            "{name} magnitude {magnitude} exceeds maximum {maximum}"
        )));
    }
    Ok(())
}

fn parse_vector3(value: &serde_json::Value, name: &str) -> Result<[f64; 3]> {
    let vector = [
        parse_json_f64(value, "/x")?,
        parse_json_f64(value, "/y")?,
        parse_json_f64(value, "/z")?,
    ];
    if vector.iter().any(|component| !component.is_finite()) {
        return Err(TransportError::DecodingError(format!(
            "{name} must contain finite components"
        )));
    }
    Ok(vector)
}

fn parse_quaternion(value: &serde_json::Value, name: &str) -> Result<[f64; 4]> {
    let quaternion = parse_quaternion_components(value)?;
    let norm = quaternion.iter().fold(0.0_f64, |accumulator, component| {
        accumulator.hypot(*component)
    });
    if !(0.99..=1.01).contains(&norm) {
        return Err(TransportError::DecodingError(format!(
            "{name} must be a unit quaternion, got norm {norm}"
        )));
    }
    Ok(quaternion)
}

fn parse_quaternion_components(value: &serde_json::Value) -> Result<[f64; 4]> {
    Ok([
        parse_json_f64(value, "/x")?,
        parse_json_f64(value, "/y")?,
        parse_json_f64(value, "/z")?,
        parse_json_f64(value, "/w")?,
    ])
}

fn parse_pose_value(
    value: &serde_json::Value,
    timestamp: f64,
    frame_id: String,
) -> Result<PoseData> {
    let position = parse_vector3(
        value.get("position").unwrap_or(&serde_json::Value::Null),
        "pose.position",
    )?;
    validate_magnitude("pose.position", &position, MAX_POSITION_MAGNITUDE_M)?;
    let orientation = parse_quaternion(
        value.get("orientation").unwrap_or(&serde_json::Value::Null),
        "pose.orientation",
    )?;
    Ok(PoseData {
        position,
        orientation,
        timestamp,
        frame_id,
    })
}

fn parse_twist_value(value: &serde_json::Value) -> Result<VelocityCmd> {
    let linear = parse_vector3(
        value.get("linear").unwrap_or(&serde_json::Value::Null),
        "twist.linear",
    )?;
    let angular = parse_vector3(
        value.get("angular").unwrap_or(&serde_json::Value::Null),
        "twist.angular",
    )?;
    validate_magnitude("twist.linear", &linear, MAX_LINEAR_SPEED_MPS)?;
    validate_magnitude("twist.angular", &angular, MAX_ANGULAR_SPEED_RAD_S)?;
    Ok(VelocityCmd { linear, angular })
}

fn parse_imu(msg: &serde_json::Value) -> Result<ImuData> {
    let (timestamp, frame_id) = parse_ros_header(msg)?;
    let orientation_value = msg.get("orientation").unwrap_or(&serde_json::Value::Null);
    let orientation_covariance = msg
        .get("orientation_covariance")
        .and_then(serde_json::Value::as_array)
        .filter(|covariance| covariance.len() == 9)
        .ok_or_else(|| {
            TransportError::DecodingError(
                "imu.orientation_covariance must contain exactly 9 values".to_string(),
            )
        })?;
    for (index, value) in orientation_covariance.iter().enumerate() {
        if !value
            .as_f64()
            .is_some_and(|component| component.is_finite())
        {
            return Err(TransportError::DecodingError(format!(
                "imu.orientation_covariance[{index}] must be a finite number"
            )));
        }
    }
    let orientation_unavailable = orientation_covariance[0].as_f64() == Some(-1.0);
    let orientation = if orientation_unavailable {
        parse_quaternion_components(orientation_value)?
    } else {
        parse_quaternion(orientation_value, "imu.orientation")?
    };
    let angular_velocity = parse_vector3(
        msg.get("angular_velocity")
            .unwrap_or(&serde_json::Value::Null),
        "imu.angular_velocity",
    )?;
    let linear_acceleration = parse_vector3(
        msg.get("linear_acceleration")
            .unwrap_or(&serde_json::Value::Null),
        "imu.linear_acceleration",
    )?;
    Ok(ImuData {
        orientation,
        angular_velocity,
        linear_acceleration,
        timestamp,
        frame_id,
    })
}

fn parse_pose_stamped(msg: &serde_json::Value) -> Result<PoseData> {
    let (timestamp, frame_id) = parse_ros_header(msg)?;
    parse_pose_value(
        msg.get("pose").unwrap_or(&serde_json::Value::Null),
        timestamp,
        frame_id,
    )
}

fn parse_model_states(msg: &serde_json::Value) -> Result<ModelStates> {
    let names = msg
        .get("name")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TransportError::DecodingError("ModelStates.name must be an array".into()))?;
    let poses = msg
        .get("pose")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| TransportError::DecodingError("ModelStates.pose must be an array".into()))?;
    let twists = msg
        .get("twist")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            TransportError::DecodingError("ModelStates.twist must be an array".into())
        })?;
    if names.len() > MAX_MODEL_STATES || names.len() != poses.len() || names.len() != twists.len() {
        return Err(TransportError::DecodingError(format!(
            "ModelStates arrays must have equal lengths up to {MAX_MODEL_STATES}"
        )));
    }

    let mut parsed_names = Vec::with_capacity(names.len());
    let mut parsed_poses = Vec::with_capacity(poses.len());
    let mut parsed_twists = Vec::with_capacity(twists.len());
    for (index, name) in names.iter().enumerate() {
        let name = name
            .as_str()
            .filter(|name| !name.is_empty() && name.len() <= MAX_MODEL_NAME_LEN)
            .ok_or_else(|| {
                TransportError::DecodingError(format!(
                    "ModelStates.name[{index}] is invalid or too long"
                ))
            })?;
        if name.contains('\0') || name.chars().any(char::is_control) {
            return Err(TransportError::DecodingError(format!(
                "ModelStates.name[{index}] contains control characters"
            )));
        }
        parsed_names.push(name.to_string());
        parsed_poses.push(parse_pose_value(&poses[index], 0.0, String::new())?);
        parsed_twists.push(parse_twist_value(&twists[index])?);
    }

    Ok(ModelStates {
        name: parsed_names,
        pose: parsed_poses,
        twist: parsed_twists,
    })
}

struct RosbridgeInner {
    /// Only sender for the write task's queue; taken (dropped) on shutdown so
    /// the write task's `recv()` returns `None` and the task exits.
    write_tx: Mutex<Option<mpsc::Sender<String>>>,
    connected: AtomicBool,
    messages_received: AtomicU64,
    messages_sent: AtomicU64,
    bytes_received: AtomicU64,
    bytes_sent: AtomicU64,
    next_service_request_id: AtomicU64,
    connect_time: Instant,
    subscriptions: Mutex<HashMap<String, SubscriptionCallback>>,
    pending_service_calls: Mutex<HashMap<String, PendingServiceResponder>>,
    service_call_timeout: Duration,
}

impl RosbridgeInner {
    fn next_service_request_id(&self) -> String {
        let sequence = self.next_service_request_id.fetch_add(1, Ordering::Relaxed);
        format!("crebain-service-{sequence}")
    }

    fn mark_disconnected(&self) {
        self.connected.store(false, Ordering::Relaxed);
        lock_recover(&self.subscriptions).clear();
        // Dropping the senders wakes every in-flight call immediately instead
        // of making callers wait for their individual timeout.
        lock_recover(&self.pending_service_calls).clear();
    }

    fn dispatch_service_message(&self, value: serde_json::Value) -> Option<serde_json::Value> {
        let Some(operation) = value
            .get("op")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
        else {
            return Some(value);
        };
        let id = value_id(&value).map(str::to_owned);

        let Some(id) = id else {
            log::warn!("[Rosbridge] Ignoring {operation} without an id");
            return None;
        };

        let reply = match operation.as_str() {
            "service_response" => {
                let Some(service) = value.get("service").and_then(serde_json::Value::as_str) else {
                    log::warn!("[Rosbridge] Ignoring service_response without a service");
                    return None;
                };
                let pending = lock_recover(&self.pending_service_calls);
                let Some(expected) = pending.get(&id) else {
                    log::debug!("[Rosbridge] Ignoring response for unknown service call id");
                    return None;
                };
                if service != expected.service.as_str() {
                    log::warn!(
                        "[Rosbridge] Ignoring service_response whose service does not match its id"
                    );
                    return None;
                }
                ServiceReply::Response(value)
            }
            "status"
                if matches!(
                    value.get("level").and_then(serde_json::Value::as_str),
                    Some("error" | "fatal")
                ) =>
            {
                let detail = service_error_field(&value)
                    .unwrap_or_else(|| "rosbridge reported a protocol error".to_string());
                ServiceReply::ProtocolError(detail)
            }
            _ => return Some(value),
        };

        let pending = lock_recover(&self.pending_service_calls).remove(&id);
        if let Some(pending) = pending {
            let _ = pending.responder.send(reply);
        } else {
            log::debug!("[Rosbridge] Ignoring response for unknown service call id");
        }
        None
    }
}

fn value_id(value: &serde_json::Value) -> Option<&str> {
    value.get("id").and_then(serde_json::Value::as_str)
}

struct PendingServiceCall {
    inner: Arc<RosbridgeInner>,
    id: String,
}

impl Drop for PendingServiceCall {
    fn drop(&mut self) {
        lock_recover(&self.inner.pending_service_calls).remove(&self.id);
    }
}

pub struct RosbridgeTransport {
    inner: Arc<RosbridgeInner>,
    write_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    read_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl RosbridgeTransport {
    pub async fn connect(url: Option<&str>) -> Result<Self> {
        let ws_url = url.unwrap_or(DEFAULT_ROSBRIDGE_URL);

        let websocket_config = WebSocketConfig::default()
            .max_message_size(Some(MAX_INCOMING_WS_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_INCOMING_WS_MESSAGE_BYTES))
            .max_write_buffer_size(4 * 1024 * 1024);
        let (ws_stream, _) = connect_async_with_config(ws_url, Some(websocket_config), false)
            .await
            .map_err(|e| {
                TransportError::ConnectionFailed(format!("WebSocket connect failed: {}", e))
            })?;

        let (mut write, mut read) = ws_stream.split();
        let (write_tx, mut write_rx) = mpsc::channel::<String>(WRITE_QUEUE_CAPACITY);

        let inner = Arc::new(RosbridgeInner {
            write_tx: Mutex::new(Some(write_tx)),
            connected: AtomicBool::new(true),
            messages_received: AtomicU64::new(0),
            messages_sent: AtomicU64::new(0),
            bytes_received: AtomicU64::new(0),
            bytes_sent: AtomicU64::new(0),
            next_service_request_id: AtomicU64::new(1),
            connect_time: Instant::now(),
            subscriptions: Mutex::new(HashMap::new()),
            pending_service_calls: Mutex::new(HashMap::new()),
            service_call_timeout: SERVICE_CALL_TIMEOUT,
        });

        // Weak: the write task must not keep `inner` (which owns the only
        // `write_tx`) alive, or `recv()` below would never return `None` and
        // the task, socket, and inner state would leak per connection.
        let inner_weak = Arc::downgrade(&inner);

        // Write task
        let write_task = tokio::spawn(async move {
            while let Some(msg) = write_rx.recv().await {
                let len = msg.len() as u64;
                if let Err(e) = write.send(Message::Text(msg.into())).await {
                    log::error!("[Rosbridge] Write error: {}", e);
                    if let Some(inner) = inner_weak.upgrade() {
                        inner.mark_disconnected();
                    }
                    break;
                }
                let Some(inner) = inner_weak.upgrade() else {
                    break;
                };
                inner.bytes_sent.fetch_add(len, Ordering::Relaxed);
                inner.messages_sent.fetch_add(1, Ordering::Relaxed);
            }
            // Graceful teardown: tell the server we are done, then close the
            // socket instead of leaving it half-open.
            if let Err(e) = write.send(Message::Close(None)).await {
                log::debug!("[Rosbridge] Close frame send failed: {}", e);
            }
            let _ = write.close().await;
            if let Some(inner) = inner_weak.upgrade() {
                inner.mark_disconnected();
            }
        });

        let inner_clone = Arc::clone(&inner);

        // Read task
        let read_task = tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        let len = text.len() as u64;
                        inner_clone.bytes_received.fetch_add(len, Ordering::Relaxed);
                        inner_clone
                            .messages_received
                            .fetch_add(1, Ordering::Relaxed);

                        match parse_incoming_rosbridge_json(&text) {
                            Ok(value) => {
                                let Some(value) = inner_clone.dispatch_service_message(value)
                                else {
                                    continue;
                                };
                                if let Some(topic) = value.get("topic").and_then(|v| v.as_str()) {
                                    // Clone the callback out so the subscriptions
                                    // lock is not held while the (potentially
                                    // slow) callback runs.
                                    let callback = lock_recover(&inner_clone.subscriptions)
                                        .get(topic)
                                        .cloned();
                                    if let Some(callback) = callback {
                                        callback(value);
                                    }
                                }
                            }
                            Err(error) => {
                                log::warn!("[Rosbridge] Rejected inbound JSON: {error}");
                            }
                        }
                    }
                    Ok(Message::Close(_)) => {
                        log::info!("[Rosbridge] Connection closed by server");
                        break;
                    }
                    Err(e) => {
                        log::error!("[Rosbridge] Read error: {}", e);
                        break;
                    }
                    _ => {}
                }
            }
            inner_clone.mark_disconnected();
        });

        Ok(Self {
            inner,
            write_task: Mutex::new(Some(write_task)),
            read_task: Mutex::new(Some(read_task)),
        })
    }

    fn send_json(&self, msg: serde_json::Value) -> Result<()> {
        if !self.inner.connected.load(Ordering::Relaxed) {
            return Err(TransportError::PublishFailed("Not connected".to_string()));
        }
        let text = serde_json::to_string(&msg)
            .map_err(|e| TransportError::PublishFailed(format!("JSON encode: {}", e)))?;
        let guard = lock_recover(&self.inner.write_tx);
        if !self.inner.connected.load(Ordering::Relaxed) {
            return Err(TransportError::PublishFailed("Not connected".to_string()));
        }
        let Some(write_tx) = guard.as_ref() else {
            return Err(TransportError::PublishFailed("Not connected".to_string()));
        };
        write_tx.try_send(text).map_err(|e| match e {
            mpsc::error::TrySendError::Full(_) => TransportError::PublishFailed(format!(
                "Write queue full ({} messages)",
                WRITE_QUEUE_CAPACITY
            )),
            mpsc::error::TrySendError::Closed(_) => {
                TransportError::PublishFailed("Not connected".to_string())
            }
        })?;
        Ok(())
    }

    fn install_subscription(
        &self,
        topic: String,
        message_type: &'static str,
        callback: SubscriptionCallback,
    ) -> Result<()> {
        let subscribe_msg = serde_json::json!({
            "op": "subscribe",
            "topic": topic,
            "type": message_type
        });
        self.register_subscription_before_send(topic, callback, |_| self.send_json(subscribe_msg))
    }

    fn register_subscription_before_send<F>(
        &self,
        topic: String,
        callback: SubscriptionCallback,
        send: F,
    ) -> Result<()>
    where
        F: FnOnce(&HashMap<String, SubscriptionCallback>) -> Result<()>,
    {
        // Keep the registration lock across the non-blocking queue send so
        // concurrent subscriptions for the same topic cannot corrupt rollback.
        let mut subscriptions = lock_recover(&self.inner.subscriptions);
        let previous = subscriptions.insert(topic.clone(), callback);

        if let Err(error) = send(&subscriptions) {
            if let Some(previous) = previous {
                subscriptions.insert(topic, previous);
            } else {
                subscriptions.remove(&topic);
            }
            return Err(error);
        }

        Ok(())
    }

    /// Stop callback delivery and close the write channel. Dropping the only
    /// sender makes the write task send a WebSocket Close frame, close the
    /// socket, and exit.
    fn begin_shutdown(&self) {
        self.inner.mark_disconnected();
        lock_recover(&self.inner.write_tx).take();
    }
}

impl Drop for RosbridgeTransport {
    fn drop(&mut self) {
        self.begin_shutdown();
        // Drop cannot await the graceful close; abort both tasks so the
        // socket halves and inner state are released.
        if let Some(task) = lock_recover(&self.write_task).take() {
            task.abort();
        }
        if let Some(task) = lock_recover(&self.read_task).take() {
            task.abort();
        }
    }
}

impl Transport for RosbridgeTransport {
    fn connect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            if self.inner.connected.load(Ordering::Relaxed) {
                return Ok(());
            }
            Err(TransportError::ConnectionFailed(
                "Reconnection not supported; create a new RosbridgeTransport".to_string(),
            ))
        })
    }

    fn disconnect(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            self.begin_shutdown();
            // Let the write task flush a Close frame and close the socket;
            // abort it if an in-flight send is stalled by the peer.
            let write_task = lock_recover(&self.write_task).take();
            if let Some(mut task) = write_task {
                if tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut task)
                    .await
                    .is_err()
                {
                    task.abort();
                }
            }
            // The read task exits when the socket closes; abort it as a
            // fallback so a silent peer cannot keep it alive forever.
            if let Some(task) = lock_recover(&self.read_task).take() {
                task.abort();
            }
            Ok(())
        })
    }

    fn is_connected(&self) -> bool {
        self.inner.connected.load(Ordering::Relaxed)
    }

    fn subscribe_camera(
        &self,
        topic: &str,
        stream_kind: CameraStreamKind,
        callback: super::CameraCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            let message_type = match stream_kind {
                CameraStreamKind::Raw => "sensor_msgs/Image",
                CameraStreamKind::Compressed => "sensor_msgs/CompressedImage",
            };
            self.install_subscription(
                topic,
                message_type,
                Arc::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        let result = match stream_kind {
                            CameraStreamKind::Raw => parse_raw_camera_frame(msg),
                            CameraStreamKind::Compressed => parse_compressed_camera_frame(msg),
                        };
                        match result {
                            Ok(frame) => callback(frame),
                            Err(error) => {
                                log::warn!("[Rosbridge] Failed to decode camera frame: {error}")
                            }
                        }
                    }
                }),
            )
        })
    }

    fn subscribe_camera_info(
        &self,
        topic: &str,
        callback: super::CameraInfoCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            self.install_subscription(
                topic,
                "sensor_msgs/CameraInfo",
                Arc::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        match parse_camera_info(msg) {
                            Ok(info) => callback(info),
                            Err(error) => {
                                log::warn!("[Rosbridge] Failed to decode CameraInfo: {error}")
                            }
                        }
                    }
                }),
            )
        })
    }

    fn subscribe_imu(
        &self,
        topic: &str,
        callback: super::ImuCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            self.install_subscription(
                topic,
                "sensor_msgs/Imu",
                Arc::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        match parse_imu(msg) {
                            Ok(imu) => callback(imu),
                            Err(error) => log::warn!("[Rosbridge] Failed to decode IMU: {error}"),
                        }
                    }
                }),
            )
        })
    }

    fn subscribe_pose(
        &self,
        topic: &str,
        callback: super::PoseCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            self.install_subscription(
                topic,
                "geometry_msgs/PoseStamped",
                Arc::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        match parse_pose_stamped(msg) {
                            Ok(pose) => callback(pose),
                            Err(error) => log::warn!("[Rosbridge] Failed to decode pose: {error}"),
                        }
                    }
                }),
            )
        })
    }

    fn subscribe_model_states(
        &self,
        topic: &str,
        callback: super::ModelStatesCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            self.install_subscription(
                topic,
                "gazebo_msgs/ModelStates",
                Arc::new(move |value: serde_json::Value| {
                    if let Some(msg) = value.get("msg") {
                        match parse_model_states(msg) {
                            Ok(states) => callback(states),
                            Err(error) => {
                                log::warn!("[Rosbridge] Failed to decode ModelStates: {error}")
                            }
                        }
                    }
                }),
            )
        })
    }

    fn unsubscribe(&self, topic: &str) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            let unsubscribe_msg = serde_json::json!({
                "op": "unsubscribe",
                "topic": topic
            });
            self.send_json(unsubscribe_msg)?;
            let mut subs = lock_recover(&self.inner.subscriptions);
            subs.remove(&topic);
            Ok(())
        })
    }

    fn publish_velocity(
        &self,
        topic: &str,
        cmd: VelocityCmd,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            validate_message_type("geometry_msgs/Twist")?;
            let publish_msg = serde_json::json!({
                "op": "publish",
                "topic": topic,
                "msg": {
                    "linear": { "x": cmd.linear[0], "y": cmd.linear[1], "z": cmd.linear[2] },
                    "angular": { "x": cmd.angular[0], "y": cmd.angular[1], "z": cmd.angular[2] }
                }
            });
            self.send_json(publish_msg)
        })
    }

    fn publish_twist_stamped(
        &self,
        topic: &str,
        cmd: TwistStampedData,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            validate_message_type("geometry_msgs/TwistStamped")?;
            let publish_msg = serde_json::json!({
                "op": "publish",
                "topic": topic,
                "msg": {
                    "header": {
                        "stamp": rosbridge_stamp_json(cmd.timestamp),
                        "frame_id": cmd.frame_id
                    },
                    "twist": {
                        "linear": { "x": cmd.twist.linear[0], "y": cmd.twist.linear[1], "z": cmd.twist.linear[2] },
                        "angular": { "x": cmd.twist.angular[0], "y": cmd.twist.angular[1], "z": cmd.twist.angular[2] }
                    }
                }
            });
            self.send_json(publish_msg)
        })
    }

    fn publish_pose(
        &self,
        topic: &str,
        pose: PoseData,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let topic = topic.to_string();
        Box::pin(async move {
            validate_topic(&topic)?;
            validate_message_type("geometry_msgs/PoseStamped")?;
            let publish_msg = serde_json::json!({
                "op": "publish",
                "topic": topic,
                "msg": {
                    "header": {
                        "stamp": rosbridge_stamp_json(pose.timestamp),
                        "frame_id": pose.frame_id
                    },
                    "pose": {
                        "position": { "x": pose.position[0], "y": pose.position[1], "z": pose.position[2] },
                        "orientation": { "x": pose.orientation[0], "y": pose.orientation[1], "z": pose.orientation[2], "w": pose.orientation[3] }
                    }
                }
            });
            self.send_json(publish_msg)
        })
    }

    fn call_service<'a>(
        &'a self,
        service: &'a str,
        service_type: &'a str,
        args: serde_json::Value,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        let service = service.to_string();
        let service_type = service_type.to_string();
        Box::pin(async move {
            validate_topic(&service)?;
            validate_message_type(&service_type)?;
            let id = self.inner.next_service_request_id();
            let (responder, response) = oneshot::channel();
            {
                let mut pending = lock_recover(&self.inner.pending_service_calls);
                if pending.len() >= MAX_PENDING_SERVICE_CALLS {
                    return Err(TransportError::PublishFailed(format!(
                        "Too many pending service calls (maximum {MAX_PENDING_SERVICE_CALLS})"
                    )));
                }
                if pending.contains_key(&id) {
                    return Err(TransportError::PublishFailed(
                        "Service request id collision".to_string(),
                    ));
                }
                pending.insert(
                    id.clone(),
                    PendingServiceResponder {
                        service: service.clone(),
                        responder,
                    },
                );
            }
            // The guard also handles cancellation by the command-layer timeout.
            let _pending_call = PendingServiceCall {
                inner: Arc::clone(&self.inner),
                id: id.clone(),
            };
            let require_success = service_type_requires_success(&service_type);
            let call_msg = serde_json::json!({
                "op": "call_service",
                "id": id,
                "service": service,
                "type": service_type,
                "args": args
            });
            self.send_json(call_msg)?;

            let reply = tokio::time::timeout(self.inner.service_call_timeout, response)
                .await
                .map_err(|_| TransportError::Timeout)?
                .map_err(|_| {
                    TransportError::ConnectionFailed(
                        "Connection closed before service response".to_string(),
                    )
                })?;

            match reply {
                ServiceReply::Response(response) => {
                    validate_service_response_with_policy(&response, require_success)
                }
                ServiceReply::ProtocolError(message) => Err(TransportError::PublishFailed(
                    format!("Service call failed: {message}"),
                )),
            }
        })
    }

    fn stats(&self) -> TransportStats {
        TransportStats {
            messages_received: self.inner.messages_received.load(Ordering::Relaxed),
            messages_sent: self.inner.messages_sent.load(Ordering::Relaxed),
            avg_latency_ms: 0.0,
            bytes_received: self.inner.bytes_received.load(Ordering::Relaxed),
            bytes_sent: self.inner.bytes_sent.load(Ordering::Relaxed),
            uptime_secs: self.inner.connect_time.elapsed().as_secs_f64(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::join;
    use std::io::Cursor;

    fn test_transport(
        service_call_timeout: Duration,
    ) -> (RosbridgeTransport, mpsc::Receiver<String>) {
        let (write_tx, write_rx) = mpsc::channel(WRITE_QUEUE_CAPACITY);
        let inner = Arc::new(RosbridgeInner {
            write_tx: Mutex::new(Some(write_tx)),
            connected: AtomicBool::new(true),
            messages_received: AtomicU64::new(0),
            messages_sent: AtomicU64::new(0),
            bytes_received: AtomicU64::new(0),
            bytes_sent: AtomicU64::new(0),
            next_service_request_id: AtomicU64::new(1),
            connect_time: Instant::now(),
            subscriptions: Mutex::new(HashMap::new()),
            pending_service_calls: Mutex::new(HashMap::new()),
            service_call_timeout,
        });
        (
            RosbridgeTransport {
                inner,
                write_task: Mutex::new(None),
                read_task: Mutex::new(None),
            },
            write_rx,
        )
    }

    fn valid_camera_info_message() -> serde_json::Value {
        serde_json::json!({
            "header": {
                "stamp": { "sec": 42, "nanosec": 125_000_000u64 },
                "frame_id": "camera_optical"
            },
            "height": 480,
            "width": 640,
            "distortion_model": "plumb_bob",
            "d": [0.1, -0.2, 0.003, 0.004, 0.0],
            "k": [500.0, 0.0, 320.0, 0.0, 501.0, 240.0, 0.0, 0.0, 1.0],
            "r": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            "p": [500.0, 0.0, 320.0, 0.0, 0.0, 501.0, 240.0, 0.0, 0.0, 0.0, 1.0, 0.0]
        })
    }

    fn tiny_png_base64() -> String {
        let image = image::DynamicImage::new_rgba8(2, 3);
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
            .unwrap();
        general_purpose::STANDARD.encode(bytes)
    }

    fn tiny_jpeg_base64() -> String {
        let image = image::DynamicImage::new_rgb8(2, 3);
        let mut bytes = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Jpeg)
            .unwrap();
        general_purpose::STANDARD.encode(bytes)
    }

    fn valid_imu_message() -> serde_json::Value {
        serde_json::json!({
            "header": { "stamp": { "sec": 2, "nanosec": 0 }, "frame_id": "imu" },
            "orientation": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 },
            "orientation_covariance": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "angular_velocity": { "x": 0.1, "y": 0.2, "z": 0.3 },
            "linear_acceleration": { "x": 0.0, "y": 0.0, "z": 9.81 }
        })
    }

    #[test]
    fn validate_topic_accepts_valid() {
        assert!(validate_topic("/drone1/camera").is_ok());
        assert!(validate_topic("/a").is_ok());
    }

    #[test]
    fn ros2_stamp_seconds_reads_sec_nanosec() {
        let msg = serde_json::json!({
            "header": { "stamp": { "sec": 12, "nanosec": 500_000_000u64 } }
        });
        assert!((ros2_stamp_seconds(&msg) - 12.5).abs() < 1e-9);
    }

    #[test]
    fn ros2_stamp_seconds_falls_back_to_ros1_names() {
        let msg = serde_json::json!({
            "header": { "stamp": { "secs": 3, "nsecs": 250_000_000u64 } }
        });
        assert!((ros2_stamp_seconds(&msg) - 3.25).abs() < 1e-9);
    }

    #[test]
    fn ros2_stamp_seconds_defaults_to_zero_when_missing() {
        assert_eq!(ros2_stamp_seconds(&serde_json::json!({})), 0.0);
    }

    #[test]
    fn rosbridge_stamp_json_emits_ros1_secs_and_nsecs() {
        let stamp = rosbridge_stamp_json(12.5);
        assert_eq!(stamp["secs"], 12);
        assert_eq!(stamp["nsecs"], 500_000_000u64);
        // Round-trips back through the reader.
        let msg = serde_json::json!({ "header": { "stamp": stamp } });
        assert!((ros2_stamp_seconds(&msg) - 12.5).abs() < 1e-6);
    }

    #[test]
    fn validate_topic_rejects_empty() {
        assert!(validate_topic("").is_err());
    }

    #[test]
    fn validate_topic_rejects_no_leading_slash() {
        assert!(validate_topic("drone1/camera").is_err());
    }

    #[test]
    fn validate_topic_rejects_double_slash() {
        assert!(validate_topic("/drone1//camera").is_err());
    }

    #[test]
    fn validate_topic_rejects_null_byte() {
        assert!(validate_topic("/drone\0").is_err());
    }

    #[test]
    fn validate_topic_rejects_non_ros_characters_and_root() {
        for topic in ["/", "/bad-topic", "/bad.topic", "/padded "] {
            assert!(
                validate_topic(topic).is_err(),
                "expected rejection for {topic}"
            );
        }
    }

    #[test]
    fn validate_message_type_accepts_valid() {
        assert!(validate_message_type("sensor_msgs/Image").is_ok());
        assert!(validate_message_type("sensor_msgs/msg/Image").is_ok());
    }

    #[test]
    fn validate_message_type_rejects_no_slash() {
        assert!(validate_message_type("Image").is_err());
    }

    #[test]
    fn validate_message_type_rejects_malformed_segments() {
        for message_type in [
            "/sensor_msgs/Image",
            "sensor-msgs/Image",
            "sensor_msgs//Image",
            "sensor_msgs/msg/Image/Extra",
            "sensor_msgs/1Image",
        ] {
            assert!(
                validate_message_type(message_type).is_err(),
                "expected rejection for {message_type}"
            );
        }
    }

    #[test]
    fn parse_camera_info_preserves_calibration_matrices() {
        let info = parse_camera_info(&valid_camera_info_message()).unwrap();

        assert_eq!(
            (info.k, info.r, info.p),
            (
                [500.0, 0.0, 320.0, 0.0, 501.0, 240.0, 0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                [500.0, 0.0, 320.0, 0.0, 0.0, 501.0, 240.0, 0.0, 0.0, 0.0, 1.0, 0.0,],
            )
        );
    }

    #[test]
    fn parse_camera_info_rejects_wrong_matrix_length() {
        let mut message = valid_camera_info_message();
        message["k"] = serde_json::json!([1.0, 2.0]);

        let error = parse_camera_info(&message).unwrap_err();

        assert!(error.to_string().contains("exactly 9"), "{error}");
    }

    #[test]
    fn parse_camera_info_rejects_non_numeric_distortion_value() {
        let mut message = valid_camera_info_message();
        message["d"][2] = serde_json::Value::String("not-a-number".to_string());

        let error = parse_camera_info(&message).unwrap_err();

        assert!(error.to_string().contains("d[2]"), "{error}");
    }

    #[test]
    fn parse_camera_info_rejects_wrong_standard_distortion_length() {
        let mut message = valid_camera_info_message();
        message["d"] = serde_json::json!([0.1, 0.2, 0.3, 0.4]);

        let error = parse_camera_info(&message).unwrap_err();

        assert!(error.to_string().contains("exactly 5"), "{error}");
    }

    #[test]
    fn parse_camera_info_normalizes_safe_model_and_bounds_custom_distortion() {
        let mut message = valid_camera_info_message();
        message["distortion_model"] = serde_json::Value::String(" Custom-Model ".to_string());
        message["d"] = serde_json::json!(vec![0.0; MAX_DISTORTION_COEFFICIENTS]);

        let info = parse_camera_info(&message).unwrap();
        assert_eq!(info.distortion_model, "custom-model");

        message["d"] = serde_json::json!(vec![0.0; MAX_DISTORTION_COEFFICIENTS + 1]);
        assert!(parse_camera_info(&message).is_err());
    }

    #[test]
    fn parse_raw_camera_frame_validates_shape_and_normalizes_bytes() {
        let message = serde_json::json!({
            "header": { "stamp": { "secs": 1, "nsecs": 500_000_000u64 }, "frame_id": "camera" },
            "height": 1,
            "width": 2,
            "encoding": " RGB8 ",
            "is_bigendian": 0,
            "step": 6,
            "data": general_purpose::STANDARD.encode([1, 2, 3, 4, 5, 6])
        });

        let frame = parse_raw_camera_frame(&message).unwrap();

        assert_eq!((frame.width, frame.height, frame.step), (2, 1, 6));
        assert_eq!(
            general_purpose::STANDARD.decode(frame.data).unwrap(),
            [1, 2, 3, 4, 5, 6]
        );
        assert_eq!(frame.encoding, "rgb8");
        assert!((frame.timestamp - 1.5).abs() < 1e-9);
    }

    #[test]
    fn parse_raw_camera_frame_rejects_inconsistent_data_length() {
        let message = serde_json::json!({
            "header": { "stamp": { "secs": 0, "nsecs": 0 }, "frame_id": "camera" },
            "height": 1,
            "width": 2,
            "encoding": "rgb8",
            "is_bigendian": 0,
            "step": 6,
            "data": general_purpose::STANDARD.encode([1, 2, 3])
        });

        let error = parse_raw_camera_frame(&message).unwrap_err();

        assert!(error.to_string().contains("does not match"), "{error}");
    }

    #[test]
    fn parse_camera_frame_rejects_json_byte_arrays() {
        let message = serde_json::json!({ "data": [1, 2, 3] });

        let error = parse_rosbridge_bytes(&message, "data").unwrap_err();

        assert!(error.to_string().contains("JSON byte arrays"), "{error}");
    }

    #[test]
    fn inbound_json_rejects_data_arrays_before_building_a_value_tree() {
        for message in [
            r#"{"op":"publish","msg":{"data":[1,2,3]}}"#,
            r#"{"op":"publish","msg":{"d\u0061ta":[1,2,3]}}"#,
        ] {
            let error = parse_incoming_rosbridge_json(message).unwrap_err();
            assert!(error.to_string().contains("base64 text"), "{error}");
        }

        let accepted =
            parse_incoming_rosbridge_json(r#"{"op":"publish","msg":{"data":"AQID"}}"#).unwrap();
        assert_eq!(
            accepted.pointer("/msg/data").and_then(|v| v.as_str()),
            Some("AQID")
        );
    }

    #[test]
    fn parse_compressed_camera_frame_checks_declared_codec_and_dimensions() {
        let message = serde_json::json!({
            "header": { "stamp": { "sec": 2, "nanosec": 0 }, "frame_id": "camera" },
            "format": "rgb8; png compressed rgb8",
            "data": tiny_png_base64()
        });

        let frame = parse_compressed_camera_frame(&message).unwrap();

        assert_eq!((frame.width, frame.height), (2, 3));
        assert_eq!(frame.encoding, "rgb8; png compressed rgb8");

        let mut mismatch = message;
        mismatch["format"] = serde_json::Value::String("jpeg".to_string());
        assert!(parse_compressed_camera_frame(&mismatch).is_err());
    }

    #[test]
    fn empty_compressed_format_uses_jpeg_fallback_but_not_png() {
        let mut message = serde_json::json!({
            "header": { "stamp": { "sec": 2, "nanosec": 0 }, "frame_id": "camera" },
            "format": "",
            "data": tiny_jpeg_base64()
        });

        let frame = parse_compressed_camera_frame(&message).unwrap();
        assert_eq!(frame.encoding, "jpeg");

        message["data"] = serde_json::Value::String(tiny_png_base64());
        assert!(parse_compressed_camera_frame(&message).is_err());
    }

    #[test]
    fn parse_imu_accepts_unavailable_orientation_but_validates_present_orientation() {
        let mut message = valid_imu_message();
        message["orientation"] = serde_json::json!({ "x": 0.0, "y": 0.0, "z": 0.0, "w": 0.0 });
        message["orientation_covariance"][0] = serde_json::json!(-1.0);

        let imu = parse_imu(&message).unwrap();
        assert_eq!(imu.orientation, [0.0; 4]);

        message["orientation_covariance"][0] = serde_json::json!(0.0);
        assert!(parse_imu(&message).is_err());
    }

    #[test]
    fn camera_subscription_declares_the_explicit_wire_schema() {
        let (transport, mut write_rx) = test_transport(Duration::from_millis(20));

        tauri::async_runtime::block_on(transport.subscribe_camera(
            "/camera/custom_feed",
            CameraStreamKind::Compressed,
            Box::new(|_| {}),
        ))
        .unwrap();
        let request: serde_json::Value =
            serde_json::from_str(&write_rx.try_recv().unwrap()).unwrap();

        assert_eq!(request["type"], "sensor_msgs/CompressedImage");
    }

    #[test]
    fn register_subscription_installs_callback_before_send() {
        let (transport, _write_rx) = test_transport(Duration::from_millis(20));
        let topic = "/camera".to_string();
        let callback: SubscriptionCallback = Arc::new(|_| {});

        let result = transport.register_subscription_before_send(topic.clone(), callback, |subs| {
            assert!(subs.contains_key(&topic));
            Ok(())
        });

        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn register_subscription_rolls_back_when_send_fails() {
        let (transport, _write_rx) = test_transport(Duration::from_millis(20));
        let topic = "/camera".to_string();
        let callback: SubscriptionCallback = Arc::new(|_| {});

        let result = transport.register_subscription_before_send(topic.clone(), callback, |_| {
            Err(TransportError::PublishFailed("send failed".to_string()))
        });

        assert!(
            result.is_err() && !lock_recover(&transport.inner.subscriptions).contains_key(&topic)
        );
    }

    #[test]
    fn service_request_ids_are_unique() {
        let (transport, _write_rx) = test_transport(Duration::from_millis(20));

        let first = transport.inner.next_service_request_id();
        let second = transport.inner.next_service_request_id();

        assert_ne!(first, second);
    }

    #[test]
    fn validate_service_response_rejects_error_field() {
        let response = serde_json::json!({
            "op": "service_response",
            "id": "crebain-service-1",
            "result": true,
            "error": "permission denied"
        });

        let error = validate_service_response(&response).unwrap_err();

        assert!(error.to_string().contains("permission denied"), "{error}");
    }

    #[test]
    fn validate_service_response_rejects_service_success_false() {
        let response = serde_json::json!({
            "op": "service_response",
            "id": "crebain-service-1",
            "result": true,
            "values": {
                "success": false,
                "status_message": "entity rejected"
            }
        });

        let error = validate_service_response(&response).unwrap_err();

        assert!(error.to_string().contains("entity rejected"), "{error}");
    }

    #[test]
    fn typed_mutating_service_requires_explicit_success_field() {
        let response = serde_json::json!({
            "op": "service_response",
            "id": "crebain-service-1",
            "result": true,
            "values": { "status_message": "ambiguous response" }
        });

        assert!(validate_service_response(&response).is_ok());
        let error = validate_service_response_with_policy(&response, true).unwrap_err();

        assert!(
            error.to_string().contains("missing values.success"),
            "{error}"
        );
    }

    #[test]
    fn call_service_waits_for_matching_response() {
        let (transport, mut write_rx) = test_transport(Duration::from_millis(100));
        let inner = Arc::clone(&transport.inner);

        let result = tauri::async_runtime::block_on(async {
            let call = transport.call_service(
                "/gazebo/spawn_entity",
                "gazebo_msgs/SpawnEntity",
                serde_json::json!({}),
            );
            let respond = async move {
                let request: serde_json::Value =
                    serde_json::from_str(&write_rx.recv().await.unwrap()).unwrap();
                assert!(inner
                    .dispatch_service_message(serde_json::json!({
                        "op": "service_response",
                        "id": "different-request",
                        "service": "/gazebo/spawn_entity",
                        "result": true
                    }))
                    .is_none());
                let id = request["id"].as_str().unwrap();
                assert!(inner
                    .dispatch_service_message(serde_json::json!({
                        "op": "service_response",
                        "id": id,
                        "service": "/gazebo/spawn_entity",
                        "result": true,
                        "values": { "success": true }
                    }))
                    .is_none());
            };
            join(call, respond).await.0
        });

        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn call_service_ignores_matching_id_for_the_wrong_service() {
        let (transport, mut write_rx) = test_transport(Duration::from_millis(100));
        let inner = Arc::clone(&transport.inner);

        let result = tauri::async_runtime::block_on(async {
            let call = transport.call_service(
                "/gazebo/spawn_entity",
                "gazebo_msgs/SpawnEntity",
                serde_json::json!({}),
            );
            let respond = async move {
                let request: serde_json::Value =
                    serde_json::from_str(&write_rx.recv().await.unwrap()).unwrap();
                let id = request["id"].as_str().unwrap();
                inner.dispatch_service_message(serde_json::json!({
                    "op": "service_response",
                    "id": id,
                    "service": "/gazebo/delete_model",
                    "result": true,
                    "values": { "success": true }
                }));
                assert!(lock_recover(&inner.pending_service_calls).contains_key(id));
                inner.dispatch_service_message(serde_json::json!({
                    "op": "service_response",
                    "id": id,
                    "service": "/gazebo/spawn_entity",
                    "result": true,
                    "values": { "success": true }
                }));
            };
            join(call, respond).await.0
        });

        assert!(result.is_ok(), "{result:?}");
    }

    #[test]
    fn call_service_rejects_result_false() {
        let (transport, mut write_rx) = test_transport(Duration::from_millis(100));
        let inner = Arc::clone(&transport.inner);

        let error = tauri::async_runtime::block_on(async {
            let call = transport.call_service(
                "/gazebo/spawn_entity",
                "gazebo_msgs/SpawnEntity",
                serde_json::json!({}),
            );
            let respond = async move {
                let request: serde_json::Value =
                    serde_json::from_str(&write_rx.recv().await.unwrap()).unwrap();
                let id = request["id"].as_str().unwrap();
                inner.dispatch_service_message(serde_json::json!({
                    "op": "service_response",
                    "id": id,
                    "service": "/gazebo/spawn_entity",
                    "result": false,
                    "values": { "status_message": "model already exists" }
                }));
            };
            join(call, respond).await.0.unwrap_err()
        });

        assert!(
            error.to_string().contains("model already exists"),
            "{error}"
        );
    }

    #[test]
    fn call_service_rejects_matching_protocol_error() {
        let (transport, mut write_rx) = test_transport(Duration::from_millis(100));
        let inner = Arc::clone(&transport.inner);

        let error = tauri::async_runtime::block_on(async {
            let call = transport.call_service(
                "/gazebo/spawn_entity",
                "gazebo_msgs/SpawnEntity",
                serde_json::json!({}),
            );
            let respond = async move {
                let request: serde_json::Value =
                    serde_json::from_str(&write_rx.recv().await.unwrap()).unwrap();
                let id = request["id"].as_str().unwrap();
                inner.dispatch_service_message(serde_json::json!({
                    "op": "status",
                    "id": id,
                    "level": "error",
                    "msg": "service unavailable"
                }));
            };
            join(call, respond).await.0.unwrap_err()
        });

        assert!(error.to_string().contains("service unavailable"), "{error}");
    }

    #[test]
    fn call_service_removes_responder_after_timeout() {
        let (transport, _write_rx) = test_transport(Duration::from_millis(5));

        let error = tauri::async_runtime::block_on(transport.call_service(
            "/gazebo/spawn_entity",
            "gazebo_msgs/SpawnEntity",
            serde_json::json!({}),
        ))
        .unwrap_err();

        assert!(
            matches!(error, TransportError::Timeout)
                && lock_recover(&transport.inner.pending_service_calls).is_empty()
        );
    }

    #[test]
    fn call_service_removes_responder_when_send_fails() {
        let (transport, write_rx) = test_transport(Duration::from_millis(20));
        drop(write_rx);

        let result = tauri::async_runtime::block_on(transport.call_service(
            "/gazebo/spawn_entity",
            "gazebo_msgs/SpawnEntity",
            serde_json::json!({}),
        ));

        assert!(result.is_err() && lock_recover(&transport.inner.pending_service_calls).is_empty());
    }

    #[test]
    fn disconnect_wakes_pending_service_call() {
        let (transport, mut write_rx) = test_transport(Duration::from_secs(1));
        let inner = Arc::clone(&transport.inner);

        let error = tauri::async_runtime::block_on(async {
            let call = transport.call_service(
                "/gazebo/spawn_entity",
                "gazebo_msgs/SpawnEntity",
                serde_json::json!({}),
            );
            let disconnect = async move {
                write_rx.recv().await.unwrap();
                inner.mark_disconnected();
            };
            join(call, disconnect).await.0.unwrap_err()
        });

        assert!(
            matches!(error, TransportError::ConnectionFailed(_))
                && lock_recover(&transport.inner.pending_service_calls).is_empty()
        );
    }
}
