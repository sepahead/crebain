//! Zenoh Transport Implementation
//! Zenoh communication with CREBAIN's own peers
//!
//! Zenoh provides:
//! - Pub/sub/query data model
//! - Shared-memory-capable transport where supported by deployment topology
//! - Automatic discovery
//!
//! # Key expression scheme (known limitation)
//!
//! This bridge maps a ROS topic to a *plain-topic* key expression: the topic
//! minus its leading `/` (e.g. `/camera/image_raw` -> `camera/image_raw`).
//! That is compatible with CREBAIN's own zenoh peers, which use the same
//! scheme, but it is NOT the `rmw_zenoh_cpp` scheme, which keys topics as
//! `<domain_id>/<topic>/<type_name>/<type_hash>` and announces them via
//! liveliness tokens. Direct interop with an rmw_zenoh_cpp ROS graph
//! therefore requires a re-keying bridge between the two key spaces; it does
//! not work by pointing this transport at an rmw_zenoh_cpp router.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────┐     Zenoh Protocol      ┌─────────────────┐
//! │  CREBAIN peers  │◄──────────────────────►│   Tauri App     │
//! │  (plain keys)   │    pub/sub (CDR)       │   zenoh-rs      │
//! └─────────────────┘                         └─────────────────┘
//! ```

#[cfg(feature = "zenoh-transport")]
use super::{PoseData, VelocityCmd};
use super::{Result, Transport, TransportError, TransportStats};
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

#[cfg(feature = "zenoh-transport")]
use super::{CameraFrame, CameraFrameDelivery, CameraInfoData, ImuData, ModelStates};

#[cfg(feature = "zenoh-transport")]
use super::camera_work::{shared_camera_work_budget, CameraWorkBudget};

#[cfg(feature = "zenoh-transport")]
use base64::{engine::general_purpose, Engine as _};

#[cfg(feature = "zenoh-transport")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[cfg(feature = "zenoh-transport")]
use std::sync::Arc;

#[cfg(feature = "zenoh-transport")]
use std::panic::{catch_unwind, AssertUnwindSafe};

#[cfg(feature = "zenoh-transport")]
use {
    std::collections::{HashMap, HashSet},
    std::sync::Mutex,
    zenoh::Session,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CDR (Common Data Representation) DECODING
// ROS2 uses CDR for message serialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// CDR encapsulation header (4 bytes) per RTPS/DDS spec:
/// Bytes 0-1: representation identifier ([0x00, 0x00] = CDR_BE,
///            [0x00, 0x01] = CDR_LE — the endianness flag is byte 1)
/// Bytes 2-3: representation options
#[cfg(feature = "zenoh-transport")]
const CDR_HEADER_SIZE: usize = 4;

#[cfg(feature = "zenoh-transport")]
const CDR_BIG_ENDIAN: u8 = 0x00;

#[cfg(feature = "zenoh-transport")]
const CDR_LITTLE_ENDIAN: u8 = 0x01;

/// CDR_LE encapsulation used by decoder test fixtures.
#[cfg(all(feature = "zenoh-transport", test))]
const CDR_LE_ENCAPSULATION: [u8; 4] = [0x00, CDR_LITTLE_ENDIAN, 0x00, 0x00];

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_STRING_LEN: usize = 4096;

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_DATA_LEN: usize = crate::common::image::MAX_IMAGE_SIZE_BYTES;

/// Maximum fixed/aligned metadata around a 64 MiB image body. The image CDR
/// schemas carry at most two individually bounded strings; 64 extra bytes
/// cover their length fields, the encapsulation, scalar fields, and alignment.
/// Every subscriber shares this outer ceiling; non-image decoders apply their
/// tighter field and sequence limits after the bounded materialization.
#[cfg(feature = "zenoh-transport")]
const MAX_CDR_ENVELOPE_OVERHEAD: usize = (2 * MAX_CDR_STRING_LEN) + 64;

#[cfg(feature = "zenoh-transport")]
const MAX_ZENOH_CDR_PAYLOAD_LEN: usize = MAX_CDR_DATA_LEN + MAX_CDR_ENVELOPE_OVERHEAD;

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_SEQUENCE_LEN: usize = 10_000;

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_IMAGE_DIMENSION: u32 = 8192;

#[cfg(feature = "zenoh-transport")]
const MAX_CAMERA_SCHEMA_TOKEN_LEN: usize = 64;

#[cfg(feature = "zenoh-transport")]
const MAX_DISTORTION_COEFFICIENTS: usize = 32;

#[cfg(feature = "zenoh-transport")]
const MAX_POSITION_MAGNITUDE_M: f64 = 1_000_000.0;

#[cfg(feature = "zenoh-transport")]
const MAX_LINEAR_SPEED_MPS: f64 = 100.0;

#[cfg(feature = "zenoh-transport")]
const MAX_ANGULAR_SPEED_RAD_S: f64 = 50.0;

#[cfg(feature = "zenoh-transport")]
const ZENOH_CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CDR READING HELPERS - Bounds-checked primitive reads
// Only compiled when zenoh-transport feature is enabled
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(feature = "zenoh-transport")]
fn validate_cdr_payload_admission(payload_len: usize) -> Result<()> {
    if payload_len > MAX_ZENOH_CDR_PAYLOAD_LEN {
        return Err(TransportError::DecodingError(format!(
            "Zenoh CDR payload length {} exceeds maximum {}",
            payload_len, MAX_ZENOH_CDR_PAYLOAD_LEN
        )));
    }
    Ok(())
}

#[cfg(feature = "zenoh-transport")]
/// Parse the 4-byte CDR encapsulation header and return whether the payload
/// is little-endian. Per the RTPS/DDS spec the representation identifier is
/// bytes {0, 1}: byte 0 must be 0x00 and byte 1 carries the endianness flag
/// (0x00 = CDR_BE, 0x01 = CDR_LE).
fn parse_cdr_encapsulation(data: &[u8]) -> Result<bool> {
    if data.len() < CDR_HEADER_SIZE {
        return Err(TransportError::DecodingError(
            "CDR encapsulation header too short".to_string(),
        ));
    }
    if data[0] != 0x00 || (data[1] != CDR_BIG_ENDIAN && data[1] != CDR_LITTLE_ENDIAN) {
        return Err(TransportError::DecodingError(format!(
            "Unsupported CDR representation identifier [0x{:02X}, 0x{:02X}]",
            data[0], data[1]
        )));
    }
    Ok(data[1] == CDR_LITTLE_ENDIAN)
}

#[cfg(feature = "zenoh-transport")]
/// Clamp a decoded sequence length for pre-allocation: never reserve more
/// elements than the remaining bytes could possibly hold, so a tiny packet
/// with an inflated length prefix cannot force a large allocation.
#[inline]
fn clamped_capacity(len: usize, data_len: usize, offset: usize, min_element_size: usize) -> usize {
    len.min(data_len.saturating_sub(offset) / min_element_size.max(1))
}

#[cfg(feature = "zenoh-transport")]
#[inline]
fn align_cdr(offset: &mut usize, alignment: usize) {
    if alignment <= 1 {
        return;
    }
    // The 4-byte CDR encapsulation header is not part of the aligned payload.
    // Apply alignment relative to the payload start (after the header).
    let rel = offset.saturating_sub(CDR_HEADER_SIZE);
    let rem = rel % alignment;
    if rem != 0 {
        *offset += alignment - rem;
    }
}

#[cfg(feature = "zenoh-transport")]
/// Read a u32 with specified endianness from the buffer at the given offset, advancing the offset.
#[inline]
fn read_u32(data: &[u8], offset: &mut usize, is_little_endian: bool) -> Result<u32> {
    align_cdr(offset, 4);
    let end = *offset + 4;
    if data.len() < end {
        return Err(TransportError::DecodingError(format!(
            "Buffer underflow reading u32 at offset {}",
            *offset
        )));
    }
    let val = if is_little_endian {
        u32::from_le_bytes(data[*offset..end].try_into().map_err(|_| {
            TransportError::DecodingError("u32 slice conversion failed".to_string())
        })?)
    } else {
        u32::from_be_bytes(data[*offset..end].try_into().map_err(|_| {
            TransportError::DecodingError("u32 slice conversion failed".to_string())
        })?)
    };
    *offset = end;
    Ok(val)
}

#[cfg(feature = "zenoh-transport")]
/// Read a little-endian i32 from the buffer at the given offset, advancing the offset.
#[inline]
fn read_i32_le(data: &[u8], offset: &mut usize) -> Result<i32> {
    align_cdr(offset, 4);
    let end = *offset + 4;
    if data.len() < end {
        return Err(TransportError::DecodingError(format!(
            "Buffer underflow reading i32 at offset {}",
            *offset
        )));
    }
    let val =
        i32::from_le_bytes(data[*offset..end].try_into().map_err(|_| {
            TransportError::DecodingError("i32 slice conversion failed".to_string())
        })?);
    *offset = end;
    Ok(val)
}

#[cfg(feature = "zenoh-transport")]
/// Read an f64 with specified endianness from the buffer at the given offset, advancing the offset.
#[inline]
fn read_f64(data: &[u8], offset: &mut usize, is_little_endian: bool) -> Result<f64> {
    align_cdr(offset, 8);
    let end = *offset + 8;
    if data.len() < end {
        return Err(TransportError::DecodingError(format!(
            "Buffer underflow reading f64 at offset {}",
            *offset
        )));
    }
    let val = if is_little_endian {
        f64::from_le_bytes(data[*offset..end].try_into().map_err(|_| {
            TransportError::DecodingError("f64 slice conversion failed".to_string())
        })?)
    } else {
        f64::from_be_bytes(data[*offset..end].try_into().map_err(|_| {
            TransportError::DecodingError("f64 slice conversion failed".to_string())
        })?)
    };
    if !val.is_finite() {
        return Err(TransportError::DecodingError(format!(
            "Non-finite f64 at offset {}",
            *offset
        )));
    }
    *offset = end;
    Ok(val)
}

#[cfg(feature = "zenoh-transport")]
fn read_bounded_sequence_len(
    data: &[u8],
    offset: &mut usize,
    is_little_endian: bool,
    name: &str,
) -> Result<usize> {
    let len = read_u32(data, offset, is_little_endian)? as usize;
    if len > MAX_CDR_SEQUENCE_LEN {
        return Err(TransportError::DecodingError(format!(
            "{} length {} exceeds maximum {}",
            name, len, MAX_CDR_SEQUENCE_LEN
        )));
    }
    Ok(len)
}

#[cfg(feature = "zenoh-transport")]
/// Read a CDR string (length-prefixed, null-terminated) from the buffer.
/// Returns the string and advances the offset past it (including alignment).
fn read_cdr_string(data: &[u8], offset: &mut usize, is_little_endian: bool) -> Result<String> {
    let str_len_u32 = read_u32(data, offset, is_little_endian)?;

    // Reject unreasonable string lengths to prevent overflow
    if str_len_u32 > MAX_CDR_STRING_LEN as u32 {
        return Err(TransportError::DecodingError(format!(
            "CDR string length {} exceeds maximum {}",
            str_len_u32, MAX_CDR_STRING_LEN
        )));
    }
    let str_len = str_len_u32 as usize;
    if str_len == 0 {
        return Err(TransportError::DecodingError(
            "CDR string length must include a null terminator".to_string(),
        ));
    }

    // Check bounds safely: offset + str_len can still overflow on 32-bit
    let end_offset = offset.checked_add(str_len).ok_or_else(|| {
        TransportError::DecodingError(format!("String offset overflow at {}", *offset))
    })?;

    if data.len() < end_offset {
        return Err(TransportError::DecodingError(format!(
            "String truncated at offset {}, need {} bytes",
            *offset, str_len
        )));
    }

    let encoded = &data[*offset..end_offset];
    if encoded.last() != Some(&0) {
        return Err(TransportError::DecodingError(
            "CDR string is missing its null terminator".to_string(),
        ));
    }
    let string = std::str::from_utf8(&encoded[..encoded.len() - 1])
        .map_err(|error| {
            TransportError::DecodingError(format!("CDR string is not valid UTF-8: {error}"))
        })?
        .to_string();
    if string.contains('\0') || string.chars().any(char::is_control) {
        return Err(TransportError::DecodingError(
            "CDR string contains embedded null or control characters".to_string(),
        ));
    }
    *offset = end_offset;

    // No trailing alignment: per OMG CDR/XCDR1 (as emitted by FastCDR/rmw_zenoh),
    // a string is a 4-aligned u32 length + raw bytes with NO padding after it.
    // The next member applies its own leading alignment via read_u32/read_f64.
    // Padding here would skip bytes before a following uint8 (e.g. Image's
    // `is_bigendian`), silently desyncing decode of every real ROS2 frame whose
    // string length is not a multiple of 4.

    Ok(string)
}

#[cfg(feature = "zenoh-transport")]
/// Decode a ROS2 Header (std_msgs/Header) from CDR
/// Layout: stamp (sec: i32, nanosec: u32), frame_id (string)
fn decode_ros2_header(
    data: &[u8],
    offset: &mut usize,
    is_little_endian: bool,
) -> Result<(f64, String)> {
    // Timestamp: sec (i32) + nanosec (u32)
    let sec = if is_little_endian {
        read_i32_le(data, offset)?
    } else {
        read_i32_be(data, offset)?
    };
    let nanosec = read_u32(data, offset, is_little_endian)?;
    if sec < 0 || nanosec >= 1_000_000_000 {
        return Err(TransportError::DecodingError(format!(
            "Invalid ROS timestamp sec={sec}, nanosec={nanosec}"
        )));
    }
    let timestamp = sec as f64 + nanosec as f64 * 1e-9;

    // Frame ID: CDR string (length-prefixed, null-terminated)
    let frame_id = read_cdr_string(data, offset, is_little_endian)?;

    Ok((timestamp, frame_id))
}

#[cfg(feature = "zenoh-transport")]
fn normalize_camera_token(value: &str, field: &str, allow_empty: bool) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if value.chars().any(char::is_control)
        || (!allow_empty && normalized.is_empty())
        || normalized.len() > MAX_CAMERA_SCHEMA_TOKEN_LEN
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
    {
        return Err(TransportError::DecodingError(format!(
            "{field} must be a safe token up to {MAX_CAMERA_SCHEMA_TOKEN_LEN} characters"
        )));
    }
    Ok(normalized)
}

#[cfg(feature = "zenoh-transport")]
fn normalize_compressed_format(value: &str) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if value.chars().any(char::is_control)
        || normalized.len() > MAX_CAMERA_SCHEMA_TOKEN_LEN
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '-' | '.' | '/' | ';' | ' ')
        })
    {
        return Err(TransportError::DecodingError(format!(
            "CompressedImage.format must be safe and at most {MAX_CAMERA_SCHEMA_TOKEN_LEN} characters"
        )));
    }
    Ok(normalized)
}

#[cfg(feature = "zenoh-transport")]
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

#[cfg(feature = "zenoh-transport")]
fn min_bytes_per_pixel(encoding: &str) -> Option<usize> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "rgb8" | "bgr8" => Some(3),
        "rgba8" | "bgra8" => Some(4),
        "mono8" => Some(1),
        _ => None,
    }
}

#[cfg(feature = "zenoh-transport")]
fn validate_image_dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 {
        return Err(TransportError::DecodingError(
            "Image dimensions must be non-zero".to_string(),
        ));
    }
    if width > MAX_CDR_IMAGE_DIMENSION || height > MAX_CDR_IMAGE_DIMENSION {
        return Err(TransportError::DecodingError(format!(
            "Image dimensions {}x{} exceed maximum {}",
            width, height, MAX_CDR_IMAGE_DIMENSION
        )));
    }
    Ok(())
}

#[cfg(feature = "zenoh-transport")]
fn validate_image_step(width: u32, height: u32, step: u32, encoding: &str) -> Result<usize> {
    if step == 0 {
        return Err(TransportError::DecodingError(
            "Image step must be non-zero".to_string(),
        ));
    }

    let bytes_per_pixel = min_bytes_per_pixel(encoding).ok_or_else(|| {
        TransportError::DecodingError(format!("Unsupported raw image encoding: {encoding}"))
    })?;
    let min_row_bytes = (width as usize)
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| TransportError::DecodingError("Image row size overflow".to_string()))?;
    if (step as usize) < min_row_bytes {
        return Err(TransportError::DecodingError(format!(
            "Image step {} is smaller than minimum row size {} for encoding {}",
            step, min_row_bytes, encoding
        )));
    }

    let expected_len = (step as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| TransportError::DecodingError("Image data size overflow".to_string()))?;
    if expected_len > MAX_CDR_DATA_LEN {
        return Err(TransportError::DecodingError(format!(
            "Image data size {} exceeds maximum {}",
            expected_len, MAX_CDR_DATA_LEN
        )));
    }

    Ok(expected_len)
}

#[cfg(feature = "zenoh-transport")]
fn validate_unit_quaternion(quaternion: &[f64; 4], name: &str) -> Result<()> {
    let norm = quaternion
        .iter()
        .fold(0.0_f64, |accumulator, value| accumulator.hypot(*value));
    if !(0.99..=1.01).contains(&norm) {
        return Err(TransportError::DecodingError(format!(
            "{name} must be a unit quaternion, got norm {norm}"
        )));
    }
    Ok(())
}

#[cfg(feature = "zenoh-transport")]
fn validate_vector_magnitude(vector: &[f64; 3], name: &str, maximum_magnitude: f64) -> Result<()> {
    let magnitude = vector
        .iter()
        .fold(0.0_f64, |accumulator, value| accumulator.hypot(*value));
    if magnitude > maximum_magnitude {
        return Err(TransportError::DecodingError(format!(
            "{name} magnitude {magnitude} exceeds maximum {maximum_magnitude}"
        )));
    }
    Ok(())
}

#[cfg(feature = "zenoh-transport")]
/// Read a big-endian i32 from the buffer at the given offset, advancing the offset.
#[inline]
fn read_i32_be(data: &[u8], offset: &mut usize) -> Result<i32> {
    align_cdr(offset, 4);
    let end = *offset + 4;
    if data.len() < end {
        return Err(TransportError::DecodingError(format!(
            "Buffer underflow reading i32 at offset {}",
            *offset
        )));
    }
    let val =
        i32::from_be_bytes(data[*offset..end].try_into().map_err(|_| {
            TransportError::DecodingError("i32 slice conversion failed".to_string())
        })?);
    *offset = end;
    Ok(val)
}

#[cfg(feature = "zenoh-transport")]
/// Decode sensor_msgs/Image from CDR
/// Layout: header, height, width, encoding, is_bigendian, step, data
fn decode_image_cdr(data: &[u8]) -> Result<CameraFrame> {
    if data.len() < CDR_HEADER_SIZE + 20 {
        return Err(TransportError::DecodingError(
            "Image data too short".to_string(),
        ));
    }

    let is_little_endian = parse_cdr_encapsulation(data)?;
    let mut offset = CDR_HEADER_SIZE;

    // Decode header
    let (timestamp, frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    // Height and width
    let height = read_u32(data, &mut offset, is_little_endian)?;
    let width = read_u32(data, &mut offset, is_little_endian)?;
    validate_image_dimensions(width, height)?;

    // Encoding string (CDR string format)
    let encoding = read_cdr_string(data, &mut offset, is_little_endian)?;
    let encoding = normalize_camera_token(&encoding, "Image.encoding", false)?;

    // is_bigendian (1 byte)
    if data.len() <= offset {
        return Err(TransportError::DecodingError(
            "Missing is_bigendian".to_string(),
        ));
    }
    let is_bigendian = data[offset];
    if is_bigendian > 1 {
        return Err(TransportError::DecodingError(format!(
            "Invalid is_bigendian value {}",
            is_bigendian
        )));
    }
    offset += 1;
    // Align to 4-byte boundary (relative to CDR payload start)
    align_cdr(&mut offset, 4);

    // Step (row stride in bytes)
    let step = read_u32(data, &mut offset, is_little_endian)?;
    let expected_data_len = validate_image_step(width, height, step, &encoding)?;

    // Data array (length-prefixed)
    let data_len_u32 = read_u32(data, &mut offset, is_little_endian)?;

    // Reject unreasonable data lengths to prevent overflow
    if data_len_u32 > MAX_CDR_DATA_LEN as u32 {
        return Err(TransportError::DecodingError(format!(
            "CDR data length {} exceeds maximum {}",
            data_len_u32, MAX_CDR_DATA_LEN
        )));
    }
    let data_len = data_len_u32 as usize;
    if data_len != expected_data_len {
        return Err(TransportError::DecodingError(format!(
            "Image data length {} does not match height * step {}",
            data_len, expected_data_len
        )));
    }

    // Check bounds safely: offset + data_len can overflow
    let end_offset = offset.checked_add(data_len).ok_or_else(|| {
        TransportError::DecodingError(format!("Data offset overflow at offset {}", offset))
    })?;

    if data.len() < end_offset {
        return Err(TransportError::DecodingError(format!(
            "Image data truncated: need {} bytes at offset {}",
            data_len, offset
        )));
    }
    let image_data_b64 = general_purpose::STANDARD.encode(&data[offset..end_offset]);

    Ok(CameraFrame {
        data: image_data_b64,
        width,
        height,
        encoding,
        timestamp,
        frame_id,
        is_bigendian,
        step,
    })
}

#[cfg(feature = "zenoh-transport")]
/// Decode sensor_msgs/CompressedImage from CDR
/// Layout: header, format, data
/// The encoded image header is inspected so an oversized PNG/JPEG cannot defer
/// an unbounded pixel allocation to the frontend.
fn decode_compressed_image_cdr(data: &[u8]) -> Result<CameraFrame> {
    if data.len() < CDR_HEADER_SIZE + 16 {
        return Err(TransportError::DecodingError(
            "CompressedImage data too short".to_string(),
        ));
    }

    let is_little_endian = parse_cdr_encapsulation(data)?;
    let mut offset = CDR_HEADER_SIZE;

    // Decode header
    let (timestamp, frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    // Format string (CDR string format)
    let encoding = read_cdr_string(data, &mut offset, is_little_endian)?;
    let encoding = normalize_compressed_format(&encoding)?;

    // Data array (length-prefixed)
    let data_len_u32 = read_u32(data, &mut offset, is_little_endian)?;

    // Reject unreasonable data lengths to prevent overflow
    if data_len_u32 > MAX_CDR_DATA_LEN as u32 {
        return Err(TransportError::DecodingError(format!(
            "CDR data length {} exceeds maximum {}",
            data_len_u32, MAX_CDR_DATA_LEN
        )));
    }
    let data_len = data_len_u32 as usize;

    let end_offset = offset.checked_add(data_len).ok_or_else(|| {
        TransportError::DecodingError(format!("Data offset overflow at {}", offset))
    })?;
    if data.len() < end_offset {
        return Err(TransportError::DecodingError(format!(
            "Compressed image data truncated: need {} bytes at offset {}",
            data_len, offset
        )));
    }
    let image_data = &data[offset..end_offset];
    let (detected_format, width, height) = crate::common::image::inspect_encoded_image(image_data)
        .map_err(TransportError::DecodingError)?;
    if declared_compressed_format(&encoding) != Some(detected_format) {
        return Err(TransportError::DecodingError(format!(
            "CompressedImage format {encoding:?} does not match encoded image"
        )));
    }
    let image_data_b64 = general_purpose::STANDARD.encode(image_data);
    let encoding = if encoding.is_empty() {
        "jpeg".to_string()
    } else {
        encoding
    };

    Ok(CameraFrame {
        data: image_data_b64,
        width,
        height,
        encoding,
        timestamp,
        frame_id,
        is_bigendian: 0,
        step: 0,
    })
}

#[cfg(feature = "zenoh-transport")]
/// Decode sensor_msgs/CameraInfo from CDR.
///
/// Layout:
/// - header
/// - height, width
/// - distortion_model (string)
/// - D (float64[])
/// - K (float64[9])
/// - R (float64[9])
/// - P (float64[12])
/// - (binning_x, binning_y, roi...) are ignored
fn decode_camera_info_cdr(data: &[u8]) -> Result<CameraInfoData> {
    if data.len() < CDR_HEADER_SIZE + 24 {
        return Err(TransportError::DecodingError(
            "CameraInfo data too short".to_string(),
        ));
    }

    let is_little_endian = parse_cdr_encapsulation(data)?;
    let mut offset = CDR_HEADER_SIZE;

    let (timestamp, frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    let height = read_u32(data, &mut offset, is_little_endian)?;
    let width = read_u32(data, &mut offset, is_little_endian)?;
    validate_image_dimensions(width, height)?;
    let distortion_model = read_cdr_string(data, &mut offset, is_little_endian)?;
    let distortion_model =
        normalize_camera_token(&distortion_model, "CameraInfo.distortion_model", true)?;

    // D sequence (f64 elements: 8 bytes each)
    let d_len = read_bounded_sequence_len(data, &mut offset, is_little_endian, "CameraInfo.D")?;
    let expected_distortion_len = match distortion_model.as_str() {
        "plumb_bob" => Some(5),
        "rational_polynomial" => Some(8),
        "equidistant" => Some(4),
        _ => None,
    };
    if expected_distortion_len.is_some_and(|expected| d_len != expected) {
        return Err(TransportError::DecodingError(format!(
            "CameraInfo.D length {d_len} does not match distortion model {distortion_model}"
        )));
    }
    if expected_distortion_len.is_none() && d_len > MAX_DISTORTION_COEFFICIENTS {
        return Err(TransportError::DecodingError(format!(
            "CameraInfo.D length {d_len} exceeds custom-model maximum {MAX_DISTORTION_COEFFICIENTS}"
        )));
    }
    let mut d = Vec::with_capacity(clamped_capacity(d_len, data.len(), offset, 8));
    for _ in 0..d_len {
        d.push(read_f64(data, &mut offset, is_little_endian)?);
    }

    // K (9)
    let mut k = [0.0f64; 9];
    for v in &mut k {
        *v = read_f64(data, &mut offset, is_little_endian)?;
    }

    // R (9)
    let mut r = [0.0f64; 9];
    for v in &mut r {
        *v = read_f64(data, &mut offset, is_little_endian)?;
    }

    // P (12)
    let mut p = [0.0f64; 12];
    for v in &mut p {
        *v = read_f64(data, &mut offset, is_little_endian)?;
    }

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

#[cfg(feature = "zenoh-transport")]
/// Decode sensor_msgs/Imu from CDR
fn decode_imu_cdr(data: &[u8]) -> Result<ImuData> {
    if data.len() < CDR_HEADER_SIZE + 100 {
        return Err(TransportError::DecodingError(
            "IMU data too short".to_string(),
        ));
    }

    // Read CDR header for endianness
    let is_little_endian = parse_cdr_encapsulation(data)?;
    let mut offset = CDR_HEADER_SIZE;

    // Decode header
    let (timestamp, frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    // Orientation quaternion (x, y, z, w) - 4 * f64
    let orientation = [
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
    ];
    // A first covariance value of -1 is the ROS sentinel for an unavailable
    // orientation estimate. Preserve the finite wire quaternion in that case,
    // but require a unit quaternion whenever orientation is available.
    let mut orientation_covariance = [0.0; 9];
    for value in &mut orientation_covariance {
        *value = read_f64(data, &mut offset, is_little_endian)?;
    }
    if orientation_covariance[0] != -1.0 {
        validate_unit_quaternion(&orientation, "Imu.orientation")?;
    }

    // Angular velocity (x, y, z) - 3 * f64
    let angular_velocity = [
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
    ];

    let mut angular_velocity_covariance = [0.0; 9];
    for value in &mut angular_velocity_covariance {
        *value = read_f64(data, &mut offset, is_little_endian)?;
    }

    // Linear acceleration (x, y, z) - 3 * f64
    let linear_acceleration = [
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
    ];
    let mut linear_acceleration_covariance = [0.0; 9];
    for value in &mut linear_acceleration_covariance {
        *value = read_f64(data, &mut offset, is_little_endian)?;
    }

    Ok(ImuData {
        orientation,
        orientation_covariance,
        angular_velocity,
        angular_velocity_covariance,
        linear_acceleration,
        linear_acceleration_covariance,
        timestamp,
        frame_id,
    })
}

#[cfg(feature = "zenoh-transport")]
/// Decode geometry_msgs/PoseStamped from CDR
fn decode_pose_cdr(data: &[u8]) -> Result<PoseData> {
    if data.len() < CDR_HEADER_SIZE + 60 {
        return Err(TransportError::DecodingError(
            "Pose data too short".to_string(),
        ));
    }

    // Read CDR header for endianness
    let is_little_endian = parse_cdr_encapsulation(data)?;
    let mut offset = CDR_HEADER_SIZE;

    // Decode header
    let (timestamp, frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    // Position (x, y, z) - 3 * f64
    let position = [
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
    ];
    validate_vector_magnitude(&position, "Pose.position", MAX_POSITION_MAGNITUDE_M)?;

    // Orientation quaternion (x, y, z, w) - 4 * f64
    let orientation = [
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
    ];
    validate_unit_quaternion(&orientation, "Pose.orientation")?;

    Ok(PoseData {
        position,
        orientation,
        timestamp,
        frame_id,
    })
}

#[cfg(feature = "zenoh-transport")]
fn read_pose_from_stream(
    data: &[u8],
    offset: &mut usize,
    is_little_endian: bool,
) -> Result<PoseData> {
    // Position (x, y, z)
    let position = [
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
    ];
    validate_vector_magnitude(
        &position,
        "ModelStates.pose.position",
        MAX_POSITION_MAGNITUDE_M,
    )?;
    // Orientation (x, y, z, w)
    let orientation = [
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
    ];
    validate_unit_quaternion(&orientation, "ModelStates.pose.orientation")?;
    Ok(PoseData {
        position,
        orientation,
        timestamp: 0.0,
        frame_id: String::new(),
    })
}

#[cfg(feature = "zenoh-transport")]
fn read_twist_from_stream(
    data: &[u8],
    offset: &mut usize,
    is_little_endian: bool,
) -> Result<VelocityCmd> {
    // Linear
    let linear = [
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
    ];
    validate_vector_magnitude(&linear, "ModelStates.twist.linear", MAX_LINEAR_SPEED_MPS)?;
    // Angular
    let angular = [
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
    ];
    validate_vector_magnitude(
        &angular,
        "ModelStates.twist.angular",
        MAX_ANGULAR_SPEED_RAD_S,
    )?;
    Ok(VelocityCmd { linear, angular })
}

#[cfg(feature = "zenoh-transport")]
/// Decode gazebo_msgs/ModelStates from CDR
fn decode_model_states_cdr(data: &[u8]) -> Result<ModelStates> {
    if data.len() < CDR_HEADER_SIZE + 4 {
        return Err(TransportError::DecodingError(
            "ModelStates data too short".to_string(),
        ));
    }

    // Read CDR header for endianness
    let is_little_endian = parse_cdr_encapsulation(data)?;
    let mut offset = CDR_HEADER_SIZE;

    // name[] (each string is at least a 4-byte length prefix)
    let name_len =
        read_bounded_sequence_len(data, &mut offset, is_little_endian, "ModelStates.name")?;
    let mut name = Vec::with_capacity(clamped_capacity(name_len, data.len(), offset, 4));
    for _ in 0..name_len {
        name.push(read_cdr_string(data, &mut offset, is_little_endian)?);
    }

    // pose[] (7 * f64 = 56 bytes each)
    let pose_len =
        read_bounded_sequence_len(data, &mut offset, is_little_endian, "ModelStates.pose")?;
    let mut pose = Vec::with_capacity(clamped_capacity(pose_len, data.len(), offset, 56));
    for _ in 0..pose_len {
        pose.push(read_pose_from_stream(data, &mut offset, is_little_endian)?);
    }

    // twist[] (6 * f64 = 48 bytes each)
    let twist_len =
        read_bounded_sequence_len(data, &mut offset, is_little_endian, "ModelStates.twist")?;
    let mut twist = Vec::with_capacity(clamped_capacity(twist_len, data.len(), offset, 48));
    for _ in 0..twist_len {
        twist.push(read_twist_from_stream(data, &mut offset, is_little_endian)?);
    }

    if name_len != pose_len || name_len != twist_len {
        return Err(TransportError::DecodingError(format!(
            "ModelStates arrays must have equal lengths, got name={name_len}, pose={pose_len}, twist={twist_len}"
        )));
    }

    Ok(ModelStates { name, pose, twist })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ZENOH BRIDGE (Feature-gated)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Lock a mutex, recovering the guard if the mutex was poisoned by a panic in
/// another thread. The subscriber map only holds subscriber handles, so a
/// prior panic does not leave it logically inconsistent; recovering keeps the
/// map usable instead of silently dropping fresh subscribers on the floor.
#[cfg(feature = "zenoh-transport")]
fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(feature = "zenoh-transport")]
struct CameraTopicGuard {
    active_topics: Arc<Mutex<HashSet<String>>>,
    topic: String,
}

#[cfg(feature = "zenoh-transport")]
impl CameraTopicGuard {
    fn try_enter(active_topics: &Arc<Mutex<HashSet<String>>>, topic: &str) -> Option<Self> {
        if !lock_recover(active_topics).insert(topic.to_string()) {
            return None;
        }
        Some(Self {
            active_topics: Arc::clone(active_topics),
            topic: topic.to_string(),
        })
    }
}

#[cfg(feature = "zenoh-transport")]
impl Drop for CameraTopicGuard {
    fn drop(&mut self) {
        lock_recover(&self.active_topics).remove(&self.topic);
    }
}

#[cfg(feature = "zenoh-transport")]
fn invoke_camera_callback(
    callback: &Arc<dyn Fn(CameraFrameDelivery) + Send + Sync>,
    delivery: CameraFrameDelivery,
) -> bool {
    catch_unwind(AssertUnwindSafe(|| callback(delivery))).is_ok()
}

#[cfg(feature = "zenoh-transport")]
pub struct ZenohBridge {
    session: Arc<Session>,
    connected: Arc<AtomicBool>,
    /// Monotonic session generation used to fence declarations and callbacks
    /// that were in flight when the terminal close began.
    generation: Arc<AtomicU64>,
    start_time: Instant,

    // Active subscribers keyed by topic
    subscribers: Arc<Mutex<HashMap<String, zenoh::pubsub::Subscriber<()>>>>,
    active_camera_topics: Arc<Mutex<HashSet<String>>>,
    camera_work_budget: CameraWorkBudget,

    // Statistics
    messages_received: Arc<AtomicU64>,
    messages_sent: Arc<AtomicU64>,
    bytes_received: Arc<AtomicU64>,
    bytes_sent: Arc<AtomicU64>,

    // Latency tracking
    latency_sum_ns: Arc<AtomicU64>,
    latency_count: Arc<AtomicU64>,
}

#[cfg(feature = "zenoh-transport")]
impl ZenohBridge {
    /// Create a new Zenoh bridge with optimal configuration for ROS2
    pub async fn new() -> Result<Self> {
        log::info!("[Zenoh] Initializing Zenoh session...");

        // Use the default Zenoh configuration; tune per deployment topology.
        let config = zenoh::Config::default();

        // Open session
        let session = zenoh::open(config)
            .await
            .map_err(|e| TransportError::ConnectionFailed(format!("Zenoh open failed: {}", e)))?;

        log::info!("[Zenoh] Session opened successfully");
        log::info!("[Zenoh] ZID: {}", session.zid());

        Ok(Self {
            session: Arc::new(session),
            connected: Arc::new(AtomicBool::new(true)),
            generation: Arc::new(AtomicU64::new(1)),
            start_time: Instant::now(),
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            active_camera_topics: Arc::new(Mutex::new(HashSet::new())),
            camera_work_budget: shared_camera_work_budget(),
            messages_received: Arc::new(AtomicU64::new(0)),
            messages_sent: Arc::new(AtomicU64::new(0)),
            bytes_received: Arc::new(AtomicU64::new(0)),
            bytes_sent: Arc::new(AtomicU64::new(0)),
            latency_sum_ns: Arc::new(AtomicU64::new(0)),
            latency_count: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Convert a ROS topic to this bridge's plain-topic Zenoh key expression:
    /// "/camera/image_raw" becomes "camera/image_raw".
    ///
    /// NOTE: this is NOT the rmw_zenoh_cpp keying scheme
    /// (`<domain>/<topic>/<type>/<hash>`); see the module docs for the
    /// resulting interop limitation.
    fn ros_to_zenoh_key(topic: &str) -> String {
        topic.trim_start_matches('/').to_string()
    }

    fn ensure_connected(connected: &AtomicBool, key: &str) -> Result<()> {
        if connected.load(Ordering::Acquire) {
            return Ok(());
        }
        Err(TransportError::SubscriptionFailed(format!(
            "Transport disconnected; cannot subscribe to {key}"
        )))
    }

    fn ensure_session_open(connected: &AtomicBool) -> Result<()> {
        if connected.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(TransportError::ConnectionFailed(
                "Zenoh session is terminally closed; create a new ZenohBridge to reconnect"
                    .to_string(),
            ))
        }
    }

    fn ensure_generation_active(
        connected: &AtomicBool,
        generation: &AtomicU64,
        expected_generation: u64,
        key: &str,
    ) -> Result<()> {
        Self::ensure_connected(connected, key)?;
        if generation.load(Ordering::Acquire) == expected_generation {
            Ok(())
        } else {
            Err(TransportError::SubscriptionFailed(format!(
                "Stale transport generation; cannot subscribe to {key}"
            )))
        }
    }

    fn install_subscriber_if_current(
        connected: &AtomicBool,
        generation: &AtomicU64,
        expected_generation: u64,
        subscribers: &Mutex<HashMap<String, zenoh::pubsub::Subscriber<()>>>,
        key: String,
        subscriber: zenoh::pubsub::Subscriber<()>,
    ) -> Result<()> {
        let mut subscribers = lock_recover(subscribers);
        Self::ensure_generation_active(connected, generation, expected_generation, &key)?;
        subscribers.insert(key, subscriber);
        Ok(())
    }
}

#[cfg(feature = "zenoh-transport")]
impl Transport for ZenohBridge {
    fn connect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            // The session is opened by `new`; this call is idempotent only
            // while that original session remains open.
            Self::ensure_session_open(&self.connected)?;
            log::info!("[Zenoh] Connected");
            Ok(())
        })
    }

    fn disconnect(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            log::info!("[Zenoh] Disconnecting...");

            // Fence callbacks and in-flight declarations before taking the map
            // lock. A declaration either installs first and is cleared below,
            // or observes the new generation while holding the same map lock.
            if !self.connected.swap(false, Ordering::AcqRel) {
                return Ok(());
            }
            let _ =
                self.generation
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |generation| {
                        Some(generation.saturating_add(1))
                    });
            lock_recover(&self.subscribers).clear();

            // Close the session so its network resources are released now
            // rather than at the last Arc drop.
            match tokio::time::timeout(ZENOH_CLOSE_TIMEOUT, self.session.close()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    return Err(TransportError::ConnectionFailed(format!(
                        "Zenoh session close failed: {error}"
                    )));
                }
                Err(_) => return Err(TransportError::Timeout),
            }

            log::info!("[Zenoh] Disconnected");
            Ok(())
        })
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    fn subscribe_camera(
        &self,
        topic: &str,
        stream_kind: super::CameraStreamKind,
        callback: super::CameraCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_received = self.messages_received.clone();
        let bytes_received = self.bytes_received.clone();
        let latency_sum = self.latency_sum_ns.clone();
        let latency_count = self.latency_count.clone();
        let subscribers = self.subscribers.clone();
        let connected = self.connected.clone();
        let generation = self.generation.clone();
        let active_camera_topics = self.active_camera_topics.clone();
        let camera_work_budget = self.camera_work_budget.clone();
        let expected_generation = generation.load(Ordering::Acquire);
        let is_compressed = stream_kind == super::CameraStreamKind::Compressed;

        Box::pin(async move {
            Self::ensure_generation_active(&connected, &generation, expected_generation, &key)?;
            log::info!("[Zenoh] Subscribing to camera: {}", key);

            let callback: Arc<dyn Fn(CameraFrameDelivery) + Send + Sync> = Arc::from(callback);
            let callback_key = key.clone();

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    if !connected.load(Ordering::Acquire)
                        || generation.load(Ordering::Acquire) != expected_generation
                    {
                        return;
                    }
                    let payload = sample.payload();
                    let data_len = payload.len();
                    if let Err(error) = validate_cdr_payload_admission(data_len) {
                        log::warn!(
                            "[Zenoh] Rejected camera payload before materialization: {}",
                            error
                        );
                        return;
                    }
                    let Some(_topic_guard) =
                        CameraTopicGuard::try_enter(&active_camera_topics, &callback_key)
                    else {
                        log::debug!(
                            "[Zenoh] Dropping camera frame for busy topic {callback_key}"
                        );
                        return;
                    };
                    let Some(work_permit) = camera_work_budget.try_reserve_zenoh(data_len) else {
                        log::debug!(
                            "[Zenoh] Dropping camera frame because the shared camera-work budget is full"
                        );
                        return;
                    };
                    let payload = payload.to_bytes();

                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(data_len as u64, Ordering::Relaxed);

                    // Decode based on topic type
                    let frame_result = if is_compressed {
                        decode_compressed_image_cdr(&payload)
                    } else {
                        decode_image_cdr(&payload)
                    };

                    match frame_result {
                        Ok(frame) => {
                            // Track latency if timestamp available
                            if frame.timestamp > 0.0 {
                                let msg_time_ns = (frame.timestamp * 1e9) as u64;
                                let now_ns = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_nanos() as u64;
                                if now_ns > msg_time_ns {
                                    let latency_ns = now_ns - msg_time_ns;
                                    latency_sum.fetch_add(latency_ns, Ordering::Relaxed);
                                    latency_count.fetch_add(1, Ordering::Relaxed);
                                }
                            }

                            if !invoke_camera_callback(
                                &callback,
                                CameraFrameDelivery::new(frame, work_permit),
                            ) {
                                log::error!(
                                    "[Zenoh] Camera callback panicked; callback isolated"
                                );
                            }
                        }
                        Err(e) => {
                            log::warn!("[Zenoh] Failed to decode camera frame: {}", e);
                        }
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            Self::install_subscriber_if_current(
                &self.connected,
                &self.generation,
                expected_generation,
                &subscribers,
                key.clone(),
                subscriber,
            )?;

            log::info!("[Zenoh] Camera subscription active: {}", key);
            Ok(())
        })
    }

    fn subscribe_camera_info(
        &self,
        topic: &str,
        callback: super::CameraInfoCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_received = self.messages_received.clone();
        let bytes_received = self.bytes_received.clone();
        let subscribers = self.subscribers.clone();
        let connected = self.connected.clone();
        let generation = self.generation.clone();
        let expected_generation = generation.load(Ordering::Acquire);

        Box::pin(async move {
            Self::ensure_generation_active(&connected, &generation, expected_generation, &key)?;
            log::info!("[Zenoh] Subscribing to camera info: {}", key);

            let callback: Arc<dyn Fn(CameraInfoData) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    if !connected.load(Ordering::Acquire)
                        || generation.load(Ordering::Acquire) != expected_generation
                    {
                        return;
                    }
                    let payload = sample.payload();
                    let payload_len = payload.len();
                    if let Err(error) = validate_cdr_payload_admission(payload_len) {
                        log::warn!(
                            "[Zenoh] Rejected CameraInfo payload before materialization: {}",
                            error
                        );
                        return;
                    }
                    let payload = payload.to_bytes();
                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(payload_len as u64, Ordering::Relaxed);

                    match decode_camera_info_cdr(&payload) {
                        Ok(info) => callback(info),
                        Err(e) => log::warn!("[Zenoh] Failed to decode CameraInfo: {}", e),
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            Self::install_subscriber_if_current(
                &self.connected,
                &self.generation,
                expected_generation,
                &subscribers,
                key,
                subscriber,
            )?;

            Ok(())
        })
    }

    fn subscribe_imu(
        &self,
        topic: &str,
        callback: super::ImuCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_received = self.messages_received.clone();
        let bytes_received = self.bytes_received.clone();
        let subscribers = self.subscribers.clone();
        let connected = self.connected.clone();
        let generation = self.generation.clone();
        let expected_generation = generation.load(Ordering::Acquire);

        Box::pin(async move {
            Self::ensure_generation_active(&connected, &generation, expected_generation, &key)?;
            log::info!("[Zenoh] Subscribing to IMU: {}", key);

            let callback: Arc<dyn Fn(ImuData) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    if !connected.load(Ordering::Acquire)
                        || generation.load(Ordering::Acquire) != expected_generation
                    {
                        return;
                    }
                    let payload = sample.payload();
                    let payload_len = payload.len();
                    if let Err(error) = validate_cdr_payload_admission(payload_len) {
                        log::warn!(
                            "[Zenoh] Rejected IMU payload before materialization: {}",
                            error
                        );
                        return;
                    }
                    let payload = payload.to_bytes();
                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(payload_len as u64, Ordering::Relaxed);

                    match decode_imu_cdr(&payload) {
                        Ok(imu) => callback(imu),
                        Err(e) => log::warn!("[Zenoh] Failed to decode IMU: {}", e),
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            Self::install_subscriber_if_current(
                &self.connected,
                &self.generation,
                expected_generation,
                &subscribers,
                key,
                subscriber,
            )?;

            Ok(())
        })
    }

    fn subscribe_pose(
        &self,
        topic: &str,
        callback: super::PoseCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_received = self.messages_received.clone();
        let bytes_received = self.bytes_received.clone();
        let subscribers = self.subscribers.clone();
        let connected = self.connected.clone();
        let generation = self.generation.clone();
        let expected_generation = generation.load(Ordering::Acquire);

        Box::pin(async move {
            Self::ensure_generation_active(&connected, &generation, expected_generation, &key)?;
            log::info!("[Zenoh] Subscribing to pose: {}", key);

            let callback: Arc<dyn Fn(PoseData) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    if !connected.load(Ordering::Acquire)
                        || generation.load(Ordering::Acquire) != expected_generation
                    {
                        return;
                    }
                    let payload = sample.payload();
                    let payload_len = payload.len();
                    if let Err(error) = validate_cdr_payload_admission(payload_len) {
                        log::warn!(
                            "[Zenoh] Rejected pose payload before materialization: {}",
                            error
                        );
                        return;
                    }
                    let payload = payload.to_bytes();
                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(payload_len as u64, Ordering::Relaxed);

                    match decode_pose_cdr(&payload) {
                        Ok(pose) => callback(pose),
                        Err(e) => log::warn!("[Zenoh] Failed to decode pose: {}", e),
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            Self::install_subscriber_if_current(
                &self.connected,
                &self.generation,
                expected_generation,
                &subscribers,
                key,
                subscriber,
            )?;

            Ok(())
        })
    }

    fn subscribe_model_states(
        &self,
        topic: &str,
        callback: super::ModelStatesCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_received = self.messages_received.clone();
        let bytes_received = self.bytes_received.clone();
        let subscribers = self.subscribers.clone();
        let connected = self.connected.clone();
        let generation = self.generation.clone();
        let expected_generation = generation.load(Ordering::Acquire);

        Box::pin(async move {
            Self::ensure_generation_active(&connected, &generation, expected_generation, &key)?;
            log::info!("[Zenoh] Subscribing to model states: {}", key);

            let callback: Arc<dyn Fn(ModelStates) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    if !connected.load(Ordering::Acquire)
                        || generation.load(Ordering::Acquire) != expected_generation
                    {
                        return;
                    }
                    let payload = sample.payload();
                    let payload_len = payload.len();
                    if let Err(error) = validate_cdr_payload_admission(payload_len) {
                        log::warn!(
                            "[Zenoh] Rejected model-states payload before materialization: {}",
                            error
                        );
                        return;
                    }
                    let payload = payload.to_bytes();
                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(payload_len as u64, Ordering::Relaxed);

                    match decode_model_states_cdr(&payload) {
                        Ok(states) => callback(states),
                        Err(e) => log::warn!("[Zenoh] Failed to decode model states: {}", e),
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            Self::install_subscriber_if_current(
                &self.connected,
                &self.generation,
                expected_generation,
                &subscribers,
                key,
                subscriber,
            )?;

            Ok(())
        })
    }

    fn unsubscribe(&self, topic: &str) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let subscribers = self.subscribers.clone();

        Box::pin(async move {
            let mut subscribers = lock_recover(&subscribers);
            if subscribers.remove(&key).is_some() {
                log::info!("[Zenoh] Unsubscribed from: {}", key);
            } else {
                log::debug!("[Zenoh] No subscription found for: {}", key);
            }
            Ok(())
        })
    }

    fn stats(&self) -> TransportStats {
        let count = self.latency_count.load(Ordering::Relaxed);
        let sum_ns = self.latency_sum_ns.load(Ordering::Relaxed);
        let avg_latency_ms = if count > 0 {
            (sum_ns as f64 / count as f64) / 1_000_000.0
        } else {
            0.0
        };

        TransportStats {
            messages_received: self.messages_received.load(Ordering::Relaxed),
            messages_sent: self.messages_sent.load(Ordering::Relaxed),
            avg_latency_ms,
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
            bytes_sent: self.bytes_sent.load(Ordering::Relaxed),
            uptime_secs: self.start_time.elapsed().as_secs_f64(),
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STUB IMPLEMENTATION (when zenoh feature is disabled)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(not(feature = "zenoh-transport"))]
pub struct ZenohBridge {
    start_time: Instant,
}

#[cfg(not(feature = "zenoh-transport"))]
impl ZenohBridge {
    pub async fn new() -> Result<Self> {
        log::warn!("[Zenoh] Zenoh transport not enabled. Build with --features zenoh-transport");
        Ok(Self {
            start_time: Instant::now(),
        })
    }
}

#[cfg(not(feature = "zenoh-transport"))]
impl Transport for ZenohBridge {
    fn connect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::ConnectionFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
    }

    fn disconnect(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move { Ok(()) })
    }

    fn is_connected(&self) -> bool {
        false
    }

    fn subscribe_camera(
        &self,
        _topic: &str,
        _stream_kind: super::CameraStreamKind,
        _callback: super::CameraCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::SubscriptionFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
    }

    fn subscribe_camera_info(
        &self,
        _topic: &str,
        _callback: super::CameraInfoCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::SubscriptionFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
    }

    fn subscribe_imu(
        &self,
        _topic: &str,
        _callback: super::ImuCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::SubscriptionFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
    }

    fn subscribe_pose(
        &self,
        _topic: &str,
        _callback: super::PoseCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::SubscriptionFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
    }

    fn subscribe_model_states(
        &self,
        _topic: &str,
        _callback: super::ModelStatesCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::SubscriptionFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
    }

    fn unsubscribe(&self, _topic: &str) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move { Ok(()) })
    }

    fn stats(&self) -> TransportStats {
        TransportStats {
            messages_received: 0,
            messages_sent: 0,
            avg_latency_ms: 0.0,
            bytes_received: 0,
            bytes_sent: 0,
            uptime_secs: self.start_time.elapsed().as_secs_f64(),
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(test)]
mod tests {
    #[cfg(feature = "zenoh-transport")]
    use super::*;

    #[cfg(feature = "zenoh-transport")]
    fn push_aligned(data: &mut Vec<u8>, alignment: usize) {
        let rel = data.len().saturating_sub(CDR_HEADER_SIZE);
        let rem = rel % alignment;
        if rem != 0 {
            data.resize(data.len() + alignment - rem, 0);
        }
    }

    #[cfg(feature = "zenoh-transport")]
    fn push_u32_le(data: &mut Vec<u8>, value: u32) {
        push_aligned(data, 4);
        data.extend_from_slice(&value.to_le_bytes());
    }

    #[cfg(feature = "zenoh-transport")]
    fn push_i32_le(data: &mut Vec<u8>, value: i32) {
        push_aligned(data, 4);
        data.extend_from_slice(&value.to_le_bytes());
    }

    #[cfg(feature = "zenoh-transport")]
    fn push_f64_le(data: &mut Vec<u8>, value: f64) {
        push_aligned(data, 8);
        data.extend_from_slice(&value.to_le_bytes());
    }

    #[cfg(feature = "zenoh-transport")]
    fn push_cdr_string(data: &mut Vec<u8>, value: &str) {
        // Spec-correct CDR string: 4-aligned u32 length + bytes + null, with NO
        // trailing pad (mirrors read_cdr_string). The next pushed field aligns
        // itself, so this matches a real ROS2/FastCDR serialization.
        push_u32_le(data, value.len() as u32 + 1);
        data.extend_from_slice(value.as_bytes());
        data.push(0);
    }

    #[cfg(feature = "zenoh-transport")]
    fn image_cdr(
        width: u32,
        height: u32,
        encoding: &str,
        is_bigendian: u8,
        step: u32,
        payload_len: usize,
    ) -> Vec<u8> {
        let mut data = CDR_LE_ENCAPSULATION.to_vec();
        push_i32_le(&mut data, 0);
        push_u32_le(&mut data, 0);
        push_cdr_string(&mut data, "camera");
        push_u32_le(&mut data, height);
        push_u32_le(&mut data, width);
        push_cdr_string(&mut data, encoding);
        data.push(is_bigendian);
        push_aligned(&mut data, 4);
        push_u32_le(&mut data, step);
        push_u32_le(&mut data, payload_len as u32);
        data.resize(data.len() + payload_len, 0);
        data
    }

    #[cfg(feature = "zenoh-transport")]
    fn compressed_image_cdr(format: &str, image_format: image::ImageFormat) -> Vec<u8> {
        let image = image::DynamicImage::new_rgb8(2, 3);
        let mut image_bytes = Vec::new();
        image
            .write_to(&mut std::io::Cursor::new(&mut image_bytes), image_format)
            .unwrap();

        let mut data = CDR_LE_ENCAPSULATION.to_vec();
        push_i32_le(&mut data, 0);
        push_u32_le(&mut data, 0);
        push_cdr_string(&mut data, "camera");
        push_cdr_string(&mut data, format);
        push_u32_le(&mut data, image_bytes.len() as u32);
        data.extend_from_slice(&image_bytes);
        data
    }

    #[cfg(feature = "zenoh-transport")]
    fn callback_test_frame() -> CameraFrame {
        CameraFrame {
            data: "AQIDBA==".to_string(),
            width: 1,
            height: 1,
            encoding: "rgba8".to_string(),
            timestamp: 0.0,
            frame_id: "camera".to_string(),
            is_bigendian: 0,
            step: 4,
        }
    }

    #[cfg(feature = "zenoh-transport")]
    fn camera_info_prefix(distortion_model: &str, distortion_len: usize) -> Vec<u8> {
        let mut data = CDR_LE_ENCAPSULATION.to_vec();
        push_i32_le(&mut data, 0);
        push_u32_le(&mut data, 0);
        push_cdr_string(&mut data, "camera");
        push_u32_le(&mut data, 480);
        push_u32_le(&mut data, 640);
        push_cdr_string(&mut data, distortion_model);
        push_u32_le(&mut data, distortion_len as u32);
        data
    }

    #[cfg(feature = "zenoh-transport")]
    fn imu_cdr(orientation: [f64; 4], orientation_unavailable: bool) -> Vec<u8> {
        let mut data = CDR_LE_ENCAPSULATION.to_vec();
        push_i32_le(&mut data, 0);
        push_u32_le(&mut data, 0);
        push_cdr_string(&mut data, "imu");
        for value in orientation {
            push_f64_le(&mut data, value);
        }
        for index in 0..9 {
            push_f64_le(
                &mut data,
                if orientation_unavailable && index == 0 {
                    -1.0
                } else {
                    0.0
                },
            );
        }
        for value in [0.1, 0.2, 0.3] {
            push_f64_le(&mut data, value);
        }
        for _ in 0..9 {
            push_f64_le(&mut data, 0.0);
        }
        for value in [0.0, 0.0, 9.81] {
            push_f64_le(&mut data, value);
        }
        for _ in 0..9 {
            push_f64_le(&mut data, 0.0);
        }
        data
    }

    #[cfg(feature = "zenoh-transport")]
    fn pose_cdr(position: [f64; 3], orientation: [f64; 4]) -> Vec<u8> {
        let mut data = CDR_LE_ENCAPSULATION.to_vec();
        push_i32_le(&mut data, 0);
        push_u32_le(&mut data, 0);
        push_cdr_string(&mut data, "world");
        for value in position {
            push_f64_le(&mut data, value);
        }
        for value in orientation {
            push_f64_le(&mut data, value);
        }
        data
    }

    #[cfg(feature = "zenoh-transport")]
    fn model_states_cdr(
        position: [f64; 3],
        orientation: [f64; 4],
        linear: [f64; 3],
        angular: [f64; 3],
    ) -> Vec<u8> {
        let mut data = CDR_LE_ENCAPSULATION.to_vec();
        push_u32_le(&mut data, 1);
        push_cdr_string(&mut data, "drone");
        push_u32_le(&mut data, 1);
        for value in position {
            push_f64_le(&mut data, value);
        }
        for value in orientation {
            push_f64_le(&mut data, value);
        }
        push_u32_le(&mut data, 1);
        for value in linear {
            push_f64_le(&mut data, value);
        }
        for value in angular {
            push_f64_le(&mut data, value);
        }
        data
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn cdr_payload_admission_accepts_exact_shared_limit() {
        assert!(validate_cdr_payload_admission(MAX_ZENOH_CDR_PAYLOAD_LEN).is_ok());
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn cdr_payload_admission_rejects_one_byte_over_shared_limit() {
        let error = validate_cdr_payload_admission(MAX_ZENOH_CDR_PAYLOAD_LEN + 1).unwrap_err();

        assert!(error.to_string().contains("Zenoh CDR payload length"));
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn camera_callback_panics_are_isolated() {
        let callback: Arc<dyn Fn(CameraFrameDelivery) + Send + Sync> =
            Arc::new(|_| panic!("simulated camera callback panic"));
        let budget = CameraWorkBudget::test_with_capacity(16 * 1024 * 1024);
        let permit = budget.try_reserve_zenoh(1024).unwrap();
        let delivery = CameraFrameDelivery::new(callback_test_frame(), permit);

        assert!(!invoke_camera_callback(&callback, delivery));
        assert_eq!(budget.in_flight_bytes(), 0);
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn camera_topic_guard_drops_overlap_and_reopens_after_return() {
        let active_topics = Arc::new(Mutex::new(HashSet::new()));
        let first = CameraTopicGuard::try_enter(&active_topics, "camera/topic").unwrap();
        assert!(CameraTopicGuard::try_enter(&active_topics, "camera/topic").is_none());

        drop(first);

        assert!(CameraTopicGuard::try_enter(&active_topics, "camera/topic").is_some());
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn camera_info_rejects_oversized_distortion_sequence() {
        let data = camera_info_prefix("plumb_bob", MAX_CDR_SEQUENCE_LEN + 1);

        let error = decode_camera_info_cdr(&data).unwrap_err();

        assert!(error.to_string().contains("CameraInfo.D length"));
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn camera_info_preserves_standard_lengths_and_bounds_custom_models() {
        let standard = camera_info_prefix("plumb_bob", 4);
        let standard_error = decode_camera_info_cdr(&standard).unwrap_err();
        assert!(standard_error.to_string().contains("does not match"));

        let custom = camera_info_prefix("custom_model", MAX_DISTORTION_COEFFICIENTS + 1);
        let custom_error = decode_camera_info_cdr(&custom).unwrap_err();
        assert!(custom_error.to_string().contains("custom-model maximum"));
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn image_cdr_round_trip_reads_unpadded_string_fields() {
        // Regression: "rgb8" is 4 chars + null = 5 bytes, not a multiple of 4, so
        // a spurious trailing string pad would skip bytes and desync is_bigendian
        // and step. A spec-correct (unpadded) buffer must round-trip exactly.
        let width = 2u32;
        let height = 1u32;
        let step = 6u32; // rgb8 => 3 bytes/px * 2 px
        let payload = (height * step) as usize;
        let data = image_cdr(width, height, " RGB8 ", 1, step, payload);

        let frame = decode_image_cdr(&data).unwrap();

        assert_eq!(frame.width, width);
        assert_eq!(frame.height, height);
        assert_eq!(frame.encoding, "rgb8");
        assert_eq!(frame.is_bigendian, 1);
        assert_eq!(frame.step, step);
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn compressed_image_normalizes_format_and_applies_empty_jpeg_fallback() {
        let png = compressed_image_cdr(" RGB8; PNG compressed RGB8 ", image::ImageFormat::Png);
        let png_frame = decode_compressed_image_cdr(&png).unwrap();
        assert_eq!(png_frame.encoding, "rgb8; png compressed rgb8");

        let jpeg = compressed_image_cdr("", image::ImageFormat::Jpeg);
        let jpeg_frame = decode_compressed_image_cdr(&jpeg).unwrap();
        assert_eq!(jpeg_frame.encoding, "jpeg");

        let empty_png = compressed_image_cdr("", image::ImageFormat::Png);
        assert!(decode_compressed_image_cdr(&empty_png).is_err());
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn imu_accepts_unavailable_orientation_but_validates_present_orientation() {
        let unavailable = imu_cdr([0.0; 4], true);
        let imu = decode_imu_cdr(&unavailable).unwrap();
        assert_eq!(imu.orientation, [0.0; 4]);
        assert_eq!(imu.orientation_covariance[0], -1.0);
        assert_eq!(imu.angular_velocity_covariance, [0.0; 9]);
        assert_eq!(imu.linear_acceleration_covariance, [0.0; 9]);

        let invalid_present = imu_cdr([0.0; 4], false);
        assert!(decode_imu_cdr(&invalid_present).is_err());
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn pose_cdr_accepts_exact_position_and_quaternion_limits() {
        let data = pose_cdr([MAX_POSITION_MAGNITUDE_M, 0.0, 0.0], [0.0, 0.0, 0.0, 0.99]);

        let pose = decode_pose_cdr(&data).unwrap();

        assert_eq!(pose.position, [MAX_POSITION_MAGNITUDE_M, 0.0, 0.0]);
        assert_eq!(pose.orientation, [0.0, 0.0, 0.0, 0.99]);
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn pose_cdr_rejects_position_above_limit_and_extreme_finite_value() {
        for position_x in [MAX_POSITION_MAGNITUDE_M + 1e-6, f64::MAX] {
            let data = pose_cdr([position_x, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]);

            assert!(decode_pose_cdr(&data).is_err());
        }
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn model_states_cdr_accepts_exact_pose_and_twist_limits() {
        let data = model_states_cdr(
            [MAX_POSITION_MAGNITUDE_M, 0.0, 0.0],
            [0.0, 0.0, 0.0, 1.01],
            [MAX_LINEAR_SPEED_MPS, 0.0, 0.0],
            [0.0, 0.0, MAX_ANGULAR_SPEED_RAD_S],
        );

        let model_states = decode_model_states_cdr(&data).unwrap();

        assert_eq!(model_states.pose[0].position[0], MAX_POSITION_MAGNITUDE_M);
        assert_eq!(model_states.twist[0].linear[0], MAX_LINEAR_SPEED_MPS);
        assert_eq!(model_states.twist[0].angular[2], MAX_ANGULAR_SPEED_RAD_S);
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn model_states_cdr_rejects_over_limit_vectors_and_malformed_quaternion() {
        let cases = [
            model_states_cdr(
                [MAX_POSITION_MAGNITUDE_M + 1e-6, 0.0, 0.0],
                [0.0, 0.0, 0.0, 1.0],
                [0.0; 3],
                [0.0; 3],
            ),
            model_states_cdr(
                [0.0; 3],
                [0.0, 0.0, 0.0, 1.0],
                [MAX_LINEAR_SPEED_MPS + 1e-6, 0.0, 0.0],
                [0.0; 3],
            ),
            model_states_cdr(
                [0.0; 3],
                [0.0, 0.0, 0.0, 1.0],
                [0.0; 3],
                [0.0, 0.0, MAX_ANGULAR_SPEED_RAD_S + 1e-6],
            ),
            model_states_cdr([0.0; 3], [0.0, 0.0, 0.0, 0.98], [0.0; 3], [0.0; 3]),
        ];

        for data in cases {
            assert!(decode_model_states_cdr(&data).is_err());
        }
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn stale_generation_is_rejected_after_terminal_disconnect_fence() {
        let connected = AtomicBool::new(true);
        let generation = AtomicU64::new(7);
        let expected_generation = generation.load(Ordering::Acquire);

        connected.store(false, Ordering::Release);
        generation.store(8, Ordering::Release);

        assert!(ZenohBridge::ensure_generation_active(
            &connected,
            &generation,
            expected_generation,
            "camera"
        )
        .is_err());
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn poisoned_subscriber_state_remains_writable_after_recovery() {
        let subscribers = Arc::new(Mutex::new(HashMap::from([("existing".to_string(), 1_u8)])));
        let poison_target = Arc::clone(&subscribers);

        let poison_result = std::thread::spawn(move || {
            let _guard = poison_target.lock().unwrap();
            panic!("poison subscriber test mutex");
        })
        .join();
        assert!(poison_result.is_err());

        lock_recover(&subscribers).insert("fresh".to_string(), 2);

        let recovered = lock_recover(&subscribers);
        assert_eq!(recovered.get("existing"), Some(&1));
        assert_eq!(recovered.get("fresh"), Some(&2));
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn terminally_closed_session_cannot_be_marked_connected_again() {
        let connected = AtomicBool::new(false);

        let error = ZenohBridge::ensure_session_open(&connected).unwrap_err();

        assert!(error.to_string().contains("terminally closed"));
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn image_rejects_oversized_dimensions() {
        let data = image_cdr(MAX_CDR_IMAGE_DIMENSION + 1, 1, "mono8", 0, 1, 1);

        let error = decode_image_cdr(&data).unwrap_err();

        assert!(error.to_string().contains("Image dimensions"));
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn image_rejects_stride_smaller_than_encoding_width() {
        let data = image_cdr(2, 1, "rgb8", 0, 2, 2);

        let error = decode_image_cdr(&data).unwrap_err();

        assert!(error.to_string().contains("smaller than minimum row size"));
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn image_rejects_payload_length_mismatch() {
        let data = image_cdr(2, 2, "mono8", 0, 2, 3);

        let error = decode_image_cdr(&data).unwrap_err();

        assert!(error.to_string().contains("does not match height * step"));
    }

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn model_states_rejects_oversized_name_sequence() {
        let mut data = CDR_LE_ENCAPSULATION.to_vec();
        push_u32_le(&mut data, MAX_CDR_SEQUENCE_LEN as u32 + 1);

        let error = decode_model_states_cdr(&data).unwrap_err();

        assert!(error.to_string().contains("ModelStates.name length"));
    }

    #[test]
    fn test_ros_to_zenoh_key() {
        #[cfg(feature = "zenoh-transport")]
        {
            assert_eq!(
                ZenohBridge::ros_to_zenoh_key("/camera/image_raw"),
                "camera/image_raw"
            );
            assert_eq!(
                ZenohBridge::ros_to_zenoh_key("mavros/local_position/pose"),
                "mavros/local_position/pose"
            );
        }
    }
}
