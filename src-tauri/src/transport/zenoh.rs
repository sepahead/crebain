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

use super::{
    PoseData, Result, Transport, TransportError, TransportStats, TwistStampedData, VelocityCmd,
};
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

#[cfg(feature = "zenoh-transport")]
use super::{CameraFrame, CameraInfoData, ImuData, ModelStates};

#[cfg(feature = "zenoh-transport")]
use base64::{engine::general_purpose, Engine as _};

#[cfg(feature = "zenoh-transport")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[cfg(feature = "zenoh-transport")]
use std::sync::Arc;

#[cfg(feature = "zenoh-transport")]
use {std::collections::HashMap, std::sync::Mutex, zenoh::Session};

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

/// The encapsulation emitted by the encoders: CDR_LE with zeroed options.
#[cfg(feature = "zenoh-transport")]
const CDR_LE_ENCAPSULATION: [u8; 4] = [0x00, CDR_LITTLE_ENDIAN, 0x00, 0x00];

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_STRING_LEN: usize = 4096;

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_DATA_LEN: usize = crate::common::image::MAX_IMAGE_SIZE_BYTES;

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_SEQUENCE_LEN: usize = 10_000;

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_IMAGE_DIMENSION: u32 = 8192;

#[cfg(feature = "zenoh-transport")]
const MAX_CAMERA_SCHEMA_TOKEN_LEN: usize = 64;

#[cfg(feature = "zenoh-transport")]
const MAX_DISTORTION_COEFFICIENTS: usize = 32;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CDR READING HELPERS - Bounds-checked primitive reads
// Only compiled when zenoh-transport feature is enabled
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

    // Skip angular velocity covariance (72 bytes)
    if data.len() < offset + 72 {
        return Err(TransportError::DecodingError(
            "Angular velocity covariance truncated".to_string(),
        ));
    }
    offset += 72;

    // Linear acceleration (x, y, z) - 3 * f64
    let linear_acceleration = [
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
    ];

    Ok(ImuData {
        orientation,
        angular_velocity,
        linear_acceleration,
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
    // Angular
    let angular = [
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
        read_f64(data, offset, is_little_endian)?,
    ];
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

#[cfg(feature = "zenoh-transport")]
/// Encode geometry_msgs/Twist to CDR
fn encode_twist_cdr(cmd: &VelocityCmd) -> Vec<u8> {
    let mut data = Vec::with_capacity(CDR_HEADER_SIZE + 48);

    // CDR_LE encapsulation: representation identifier [0x00, 0x01] + options
    data.extend_from_slice(&CDR_LE_ENCAPSULATION);

    // Linear velocity (x, y, z)
    for v in &cmd.linear {
        data.extend_from_slice(&v.to_le_bytes());
    }

    // Angular velocity (x, y, z)
    for v in &cmd.angular {
        data.extend_from_slice(&v.to_le_bytes());
    }

    data
}

#[cfg(feature = "zenoh-transport")]
/// Encode geometry_msgs/TwistStamped to CDR
fn encode_twist_stamped_cdr(cmd: &TwistStampedData) -> Vec<u8> {
    // Header + string + padding + 6*f64. Conservatively reserve ~128 bytes.
    let mut data = Vec::with_capacity(CDR_HEADER_SIZE + 128);

    // CDR_LE encapsulation: representation identifier [0x00, 0x01] + options
    data.extend_from_slice(&CDR_LE_ENCAPSULATION);

    // Header timestamp
    let sec = cmd.timestamp as i32;
    let nanosec = ((cmd.timestamp - sec as f64) * 1e9) as u32;
    data.extend_from_slice(&sec.to_le_bytes());
    data.extend_from_slice(&nanosec.to_le_bytes());

    // Header frame_id (CDR string)
    let frame_id_bytes = cmd.frame_id.as_bytes();
    data.extend_from_slice(&(frame_id_bytes.len() as u32 + 1).to_le_bytes());
    data.extend_from_slice(frame_id_bytes);
    data.push(0);
    // Safe: data always has CDR_HEADER_SIZE bytes at this point
    while (data.len().saturating_sub(CDR_HEADER_SIZE)) % 4 != 0 {
        data.push(0);
    }

    // Align to 8 for f64 fields (relative to payload start).
    while (data.len().saturating_sub(CDR_HEADER_SIZE)) % 8 != 0 {
        data.push(0);
    }

    // Twist: linear then angular (x, y, z) as f64
    for v in &cmd.twist.linear {
        data.extend_from_slice(&v.to_le_bytes());
    }
    for v in &cmd.twist.angular {
        data.extend_from_slice(&v.to_le_bytes());
    }

    data
}

#[cfg(feature = "zenoh-transport")]
/// Encode geometry_msgs/PoseStamped to CDR
fn encode_pose_cdr(pose: &PoseData) -> Vec<u8> {
    let mut data = Vec::with_capacity(CDR_HEADER_SIZE + 100);

    // CDR_LE encapsulation: representation identifier [0x00, 0x01] + options
    data.extend_from_slice(&CDR_LE_ENCAPSULATION);

    // Header timestamp
    let sec = pose.timestamp as i32;
    let nanosec = ((pose.timestamp - sec as f64) * 1e9) as u32;
    data.extend_from_slice(&sec.to_le_bytes());
    data.extend_from_slice(&nanosec.to_le_bytes());

    // Frame ID
    let frame_bytes = pose.frame_id.as_bytes();
    let frame_len = (frame_bytes.len() + 1) as u32; // Include null terminator
    data.extend_from_slice(&frame_len.to_le_bytes());
    data.extend_from_slice(frame_bytes);
    data.push(0); // Null terminator

    // Align to 4 bytes (relative to payload start)
    while (data.len().saturating_sub(CDR_HEADER_SIZE)) % 4 != 0 {
        data.push(0);
    }

    // Align to 8 for f64 fields (relative to payload start)
    while (data.len().saturating_sub(CDR_HEADER_SIZE)) % 8 != 0 {
        data.push(0);
    }

    // Position
    for v in &pose.position {
        data.extend_from_slice(&v.to_le_bytes());
    }

    // Orientation
    for v in &pose.orientation {
        data.extend_from_slice(&v.to_le_bytes());
    }

    data
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
pub struct ZenohBridge {
    session: Arc<Session>,
    connected: Arc<AtomicBool>,
    start_time: Instant,

    // Active subscribers keyed by topic
    subscribers: Arc<Mutex<HashMap<String, zenoh::pubsub::Subscriber<()>>>>,

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
            start_time: Instant::now(),
            subscribers: Arc::new(Mutex::new(HashMap::new())),
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

    fn ensure_connected(connected: &AtomicBool, action: &str, key: &str) -> Result<()> {
        if connected.load(Ordering::SeqCst) {
            return Ok(());
        }
        let message = format!("Transport disconnected; cannot {} {}", action, key);
        if action == "publish to" {
            Err(TransportError::PublishFailed(message))
        } else {
            Err(TransportError::SubscriptionFailed(message))
        }
    }
}

#[cfg(feature = "zenoh-transport")]
impl Transport for ZenohBridge {
    fn connect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            // Session is already connected on creation
            self.connected.store(true, Ordering::SeqCst);
            log::info!("[Zenoh] Connected");
            Ok(())
        })
    }

    fn disconnect(&self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            log::info!("[Zenoh] Disconnecting...");

            // Clear subscribers (dropping them undeclares the zenoh subscriptions).
            lock_recover(&self.subscribers).clear();

            self.connected.store(false, Ordering::SeqCst);

            // Close the session so its network resources are released now
            // rather than at the last Arc drop.
            if let Err(e) = self.session.close().await {
                log::warn!("[Zenoh] Session close error: {}", e);
            }

            log::info!("[Zenoh] Disconnected");
            Ok(())
        })
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
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
        let is_compressed = stream_kind == super::CameraStreamKind::Compressed;

        Box::pin(async move {
            Self::ensure_connected(&self.connected, "subscribe to", &key)?;
            log::info!("[Zenoh] Subscribing to camera: {}", key);

            let callback: Arc<dyn Fn(CameraFrame) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    let payload = sample.payload().to_bytes();
                    let data_len = payload.len();

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

                            callback(frame);
                        }
                        Err(e) => {
                            log::warn!("[Zenoh] Failed to decode camera frame: {}", e);
                        }
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            // Store subscriber keyed by topic to keep it alive
            if let Ok(mut subs) = subscribers.lock() {
                subs.insert(key.clone(), subscriber);
            }

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

        Box::pin(async move {
            Self::ensure_connected(&self.connected, "subscribe to", &key)?;
            log::info!("[Zenoh] Subscribing to camera info: {}", key);

            let callback: Arc<dyn Fn(CameraInfoData) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    let payload = sample.payload().to_bytes();
                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(payload.len() as u64, Ordering::Relaxed);

                    match decode_camera_info_cdr(&payload) {
                        Ok(info) => callback(info),
                        Err(e) => log::warn!("[Zenoh] Failed to decode CameraInfo: {}", e),
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            if let Ok(mut subs) = subscribers.lock() {
                subs.insert(key.clone(), subscriber);
            }

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

        Box::pin(async move {
            Self::ensure_connected(&self.connected, "subscribe to", &key)?;
            log::info!("[Zenoh] Subscribing to IMU: {}", key);

            let callback: Arc<dyn Fn(ImuData) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    let payload = sample.payload().to_bytes();
                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(payload.len() as u64, Ordering::Relaxed);

                    match decode_imu_cdr(&payload) {
                        Ok(imu) => callback(imu),
                        Err(e) => log::warn!("[Zenoh] Failed to decode IMU: {}", e),
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            if let Ok(mut subs) = subscribers.lock() {
                subs.insert(key.clone(), subscriber);
            }

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

        Box::pin(async move {
            Self::ensure_connected(&self.connected, "subscribe to", &key)?;
            log::info!("[Zenoh] Subscribing to pose: {}", key);

            let callback: Arc<dyn Fn(PoseData) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    let payload = sample.payload().to_bytes();
                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(payload.len() as u64, Ordering::Relaxed);

                    match decode_pose_cdr(&payload) {
                        Ok(pose) => callback(pose),
                        Err(e) => log::warn!("[Zenoh] Failed to decode pose: {}", e),
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            if let Ok(mut subs) = subscribers.lock() {
                subs.insert(key.clone(), subscriber);
            }

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

        Box::pin(async move {
            Self::ensure_connected(&self.connected, "subscribe to", &key)?;
            log::info!("[Zenoh] Subscribing to model states: {}", key);

            let callback: Arc<dyn Fn(ModelStates) + Send + Sync> = Arc::from(callback);

            let subscriber = session
                .declare_subscriber(&key)
                .callback(move |sample| {
                    let payload = sample.payload().to_bytes();
                    messages_received.fetch_add(1, Ordering::Relaxed);
                    bytes_received.fetch_add(payload.len() as u64, Ordering::Relaxed);

                    match decode_model_states_cdr(&payload) {
                        Ok(states) => callback(states),
                        Err(e) => log::warn!("[Zenoh] Failed to decode model states: {}", e),
                    }
                })
                .await
                .map_err(|e| TransportError::SubscriptionFailed(e.to_string()))?;

            if let Ok(mut subs) = subscribers.lock() {
                subs.insert(key.clone(), subscriber);
            }

            Ok(())
        })
    }

    fn unsubscribe(&self, topic: &str) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let subscribers = self.subscribers.clone();

        Box::pin(async move {
            if let Ok(mut subs) = subscribers.lock() {
                if subs.remove(&key).is_some() {
                    log::info!("[Zenoh] Unsubscribed from: {}", key);
                } else {
                    log::debug!("[Zenoh] No subscription found for: {}", key);
                }
            }
            Ok(())
        })
    }

    fn publish_velocity(
        &self,
        topic: &str,
        cmd: VelocityCmd,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_sent = self.messages_sent.clone();
        let bytes_sent = self.bytes_sent.clone();

        Box::pin(async move {
            Self::ensure_connected(&self.connected, "publish to", &key)?;
            let data = encode_twist_cdr(&cmd);
            let data_len = data.len();

            session
                .put(&key, data)
                .await
                .map_err(|e| TransportError::PublishFailed(e.to_string()))?;

            messages_sent.fetch_add(1, Ordering::Relaxed);
            bytes_sent.fetch_add(data_len as u64, Ordering::Relaxed);

            Ok(())
        })
    }

    fn publish_twist_stamped(
        &self,
        topic: &str,
        cmd: TwistStampedData,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_sent = self.messages_sent.clone();
        let bytes_sent = self.bytes_sent.clone();

        Box::pin(async move {
            Self::ensure_connected(&self.connected, "publish to", &key)?;
            let data = encode_twist_stamped_cdr(&cmd);
            let data_len = data.len();

            session
                .put(&key, data)
                .await
                .map_err(|e| TransportError::PublishFailed(e.to_string()))?;

            messages_sent.fetch_add(1, Ordering::Relaxed);
            bytes_sent.fetch_add(data_len as u64, Ordering::Relaxed);

            Ok(())
        })
    }

    fn publish_pose(
        &self,
        topic: &str,
        pose: PoseData,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_sent = self.messages_sent.clone();
        let bytes_sent = self.bytes_sent.clone();

        Box::pin(async move {
            Self::ensure_connected(&self.connected, "publish to", &key)?;
            let data = encode_pose_cdr(&pose);
            let data_len = data.len();

            session
                .put(&key, data)
                .await
                .map_err(|e| TransportError::PublishFailed(e.to_string()))?;

            messages_sent.fetch_add(1, Ordering::Relaxed);
            bytes_sent.fetch_add(data_len as u64, Ordering::Relaxed);

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

    fn publish_velocity(
        &self,
        _topic: &str,
        _cmd: VelocityCmd,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::PublishFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
    }

    fn publish_twist_stamped(
        &self,
        _topic: &str,
        _cmd: TwistStampedData,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::PublishFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
    }

    fn publish_pose(
        &self,
        _topic: &str,
        _pose: PoseData,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            Err(TransportError::PublishFailed(
                "Zenoh transport not enabled".to_string(),
            ))
        })
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

    #[test]
    #[cfg(feature = "zenoh-transport")]
    fn test_encode_twist_cdr() {
        let cmd = VelocityCmd {
            linear: [1.0, 2.0, 3.0],
            angular: [0.1, 0.2, 0.3],
        };

        let data = encode_twist_cdr(&cmd);

        // CDR header + 6 * f64 = 4 + 48 = 52 bytes
        assert_eq!(data.len(), 52);

        // Check CDR header (little-endian: byte 0 = 0x01)
        assert_eq!(&data[0..4], &CDR_LE_ENCAPSULATION);

        // Check first linear value
        let val = f64::from_le_bytes(data[4..12].try_into().unwrap());
        assert!((val - 1.0).abs() < f64::EPSILON);
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

        let invalid_present = imu_cdr([0.0; 4], false);
        assert!(decode_imu_cdr(&invalid_present).is_err());
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
