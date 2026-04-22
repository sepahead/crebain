//! Zenoh Transport Implementation
//! Low-latency communication with ROS2/Gazebo
//!
//! Zenoh provides:
//! - Shared memory transport (same-machine, ~2-5ms latency)
//! - Zero-copy where possible
//! - Automatic discovery
//! - Works with ROS2 via rmw_zenoh_cpp
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────┐     Zenoh Protocol      ┌─────────────────┐
//! │  Gazebo/ROS2    │◄──────────────────────►│   Tauri App     │
//! │  RMW=zenoh      │   shared memory/UDP    │   zenoh-rs      │
//! └─────────────────┘                         └─────────────────┘
//! ```

use super::{
    CameraInfoData, PoseData, Result, Transport, TransportError, TransportStats, TwistStampedData,
    VelocityCmd,
};
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

#[cfg(feature = "zenoh-transport")]
use super::{CameraFrame, ImuData, ModelStates};

#[cfg(feature = "zenoh-transport")]
use base64::{engine::general_purpose, Engine as _};

#[cfg(feature = "zenoh-transport")]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[cfg(feature = "zenoh-transport")]
use std::sync::Arc;

#[cfg(feature = "zenoh-transport")]
use {
    std::collections::HashMap,
    std::sync::Mutex,
    zenoh::Session,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CDR (Common Data Representation) DECODING
// ROS2 uses CDR for message serialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// CDR encapsulation header (4 bytes) per RTPS/DDS spec:
/// Byte 0: Encoding (0x00 = big-endian, 0x01 = little-endian)
/// Byte 1: Options / protocol version
/// Bytes 2-3: Reserved
#[cfg(feature = "zenoh-transport")]
const CDR_HEADER_SIZE: usize = 4;

#[cfg(feature = "zenoh-transport")]
const CDR_LITTLE_ENDIAN: u8 = 0x01;

#[allow(dead_code)]
#[cfg(feature = "zenoh-transport")]
const CDR_BIG_ENDIAN: u8 = 0x00;

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_STRING_LEN: usize = 1024 * 1024; // 1MB max string length

#[cfg(feature = "zenoh-transport")]
const MAX_CDR_DATA_LEN: usize = 100 * 1024 * 1024; // 100MB max data array length

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CDR READING HELPERS - Bounds-checked primitive reads
// Only compiled when zenoh-transport feature is enabled
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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
        return Err(TransportError::DecodingError(
            format!("Buffer underflow reading u32 at offset {}", *offset),
        ));
    }
    let val = if is_little_endian {
        u32::from_le_bytes(
            data[*offset..end]
                .try_into()
                .map_err(|_| TransportError::DecodingError("u32 slice conversion failed".to_string()))?,
        )
    } else {
        u32::from_be_bytes(
            data[*offset..end]
                .try_into()
                .map_err(|_| TransportError::DecodingError("u32 slice conversion failed".to_string()))?,
        )
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
        return Err(TransportError::DecodingError(
            format!("Buffer underflow reading i32 at offset {}", *offset),
        ));
    }
    let val = i32::from_le_bytes(
        data[*offset..end]
            .try_into()
            .map_err(|_| TransportError::DecodingError("i32 slice conversion failed".to_string()))?,
    );
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
        return Err(TransportError::DecodingError(
            format!("Buffer underflow reading f64 at offset {}", *offset),
        ));
    }
    let val = if is_little_endian {
        f64::from_le_bytes(
            data[*offset..end]
                .try_into()
                .map_err(|_| TransportError::DecodingError("f64 slice conversion failed".to_string()))?,
        )
    } else {
        f64::from_be_bytes(
            data[*offset..end]
                .try_into()
                .map_err(|_| TransportError::DecodingError("f64 slice conversion failed".to_string()))?,
        )
    };
    *offset = end;
    Ok(val)
}



#[cfg(feature = "zenoh-transport")]
/// Read a CDR string (length-prefixed, null-terminated) from the buffer.
/// Returns the string and advances the offset past it (including alignment).
fn read_cdr_string(data: &[u8], offset: &mut usize, is_little_endian: bool) -> Result<String> {
    let str_len_u32 = read_u32(data, offset, is_little_endian)?;

    // Reject unreasonable string lengths to prevent overflow
    if str_len_u32 > MAX_CDR_STRING_LEN as u32 {
        return Err(TransportError::DecodingError(
            format!("CDR string length {} exceeds maximum {}", str_len_u32, MAX_CDR_STRING_LEN),
        ));
    }
    let str_len = str_len_u32 as usize;

    // Check bounds safely: offset + str_len can still overflow on 32-bit
    let end_offset = offset.checked_add(str_len)
        .ok_or_else(|| TransportError::DecodingError(
            format!("String offset overflow at {}", *offset),
        ))?;
    
    if data.len() < end_offset {
        return Err(TransportError::DecodingError(
            format!("String truncated at offset {}, need {} bytes", *offset, str_len),
        ));
    }

    // CDR strings include null terminator in length — strip it
    let string = String::from_utf8_lossy(&data[*offset..end_offset])
        .trim_end_matches('\0')
        .to_string();
    *offset = end_offset;

    align_cdr(offset, 4);

    Ok(string)
}

#[cfg(feature = "zenoh-transport")]
/// Decode a ROS2 Header (std_msgs/Header) from CDR
/// Layout: stamp (sec: i32, nanosec: u32), frame_id (string)
fn decode_ros2_header(data: &[u8], offset: &mut usize, is_little_endian: bool) -> Result<(f64, String)> {
    // Timestamp: sec (i32) + nanosec (u32)
    let sec = if is_little_endian {
        read_i32_le(data, offset)?
    } else {
        read_i32_be(data, offset)?
    };
    let nanosec = read_u32(data, offset, is_little_endian)?;
    let timestamp = sec as f64 + nanosec as f64 * 1e-9;

    // Frame ID: CDR string (length-prefixed, null-terminated)
    let frame_id = read_cdr_string(data, offset, is_little_endian)?;

    Ok((timestamp, frame_id))
}

#[cfg(feature = "zenoh-transport")]
/// Read a big-endian i32 from the buffer at the given offset, advancing the offset.
#[inline]
fn read_i32_be(data: &[u8], offset: &mut usize) -> Result<i32> {
    align_cdr(offset, 4);
    let end = *offset + 4;
    if data.len() < end {
        return Err(TransportError::DecodingError(
            format!("Buffer underflow reading i32 at offset {}", *offset),
        ));
    }
    let val = i32::from_be_bytes(
        data[*offset..end]
            .try_into()
            .map_err(|_| TransportError::DecodingError("i32 slice conversion failed".to_string()))?,
    );
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

    // Read and verify CDR header for endianness
    if data.len() < CDR_HEADER_SIZE {
        return Err(TransportError::DecodingError(
            "CDR header too short".to_string(),
        ));
    }
    
    // Validate RTPS protocol version (bytes 1-3)
    // RTPS 2.x uses version format: byte 1 = major, byte 2 = minor
    let protocol_version = data[1];
    if !(1..=2).contains(&protocol_version) {
        return Err(TransportError::DecodingError(
            format!("Unsupported RTPS protocol version: {}", protocol_version),
        ));
    }
    
    let is_little_endian = data[0] == CDR_LITTLE_ENDIAN;
    let mut offset = CDR_HEADER_SIZE;

    // Decode header
    let (timestamp, frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    // Height and width
    let height = read_u32(data, &mut offset, is_little_endian)?;
    let width = read_u32(data, &mut offset, is_little_endian)?;

    // Encoding string (CDR string format)
    let encoding = read_cdr_string(data, &mut offset, is_little_endian)?;

    // is_bigendian (1 byte)
    if data.len() <= offset {
        return Err(TransportError::DecodingError("Missing is_bigendian".to_string()));
    }
    let is_bigendian = data[offset];
    offset += 1;
    // Align to 4-byte boundary
    offset = (offset + 3) & !3;

    // Step (row stride in bytes)
    let step = read_u32(data, &mut offset, is_little_endian)?;

    // Data array (length-prefixed)
    let data_len_u32 = read_u32(data, &mut offset, is_little_endian)?;
    
    // Reject unreasonable data lengths to prevent overflow
    if data_len_u32 > MAX_CDR_DATA_LEN as u32 {
        return Err(TransportError::DecodingError(
            format!("CDR data length {} exceeds maximum {}", data_len_u32, MAX_CDR_DATA_LEN),
        ));
    }
    let data_len = data_len_u32 as usize;

    // Check bounds safely: offset + data_len can overflow
    let end_offset = offset.checked_add(data_len)
        .ok_or_else(|| TransportError::DecodingError(
            format!("Data offset overflow at offset {}", offset),
        ))?;
    
    if data.len() < end_offset {
        return Err(TransportError::DecodingError(
            format!("Image data truncated: need {} bytes at offset {}", data_len, offset),
        ));
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
/// Note: Compressed images must be decompressed to get dimensions.
/// This function reads the compressed data but dimensions remain 0.
/// Caller should decompress the image to get actual dimensions.
fn decode_compressed_image_cdr(data: &[u8]) -> Result<CameraFrame> {
    if data.len() < CDR_HEADER_SIZE + 16 {
        return Err(TransportError::DecodingError(
            "CompressedImage data too short".to_string(),
        ));
    }

    // Read and verify CDR header for endianness
    if data.len() < CDR_HEADER_SIZE {
        return Err(TransportError::DecodingError(
            "CDR header too short".to_string(),
        ));
    }
    let is_little_endian = data[0] == CDR_LITTLE_ENDIAN;
    let mut offset = CDR_HEADER_SIZE;

    // Decode header
    let (timestamp, frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    // Format string (CDR string format)
    let encoding = read_cdr_string(data, &mut offset, is_little_endian)?;

    // Data array (length-prefixed)
    let data_len = read_u32(data, &mut offset, is_little_endian)? as usize;

    if data.len() < offset + data_len {
        return Err(TransportError::DecodingError(
            format!("Compressed image data truncated: need {} bytes at offset {}", data_len, offset),
        ));
    }
    let image_data_b64 = general_purpose::STANDARD.encode(&data[offset..offset + data_len]);

    // For compressed images, dimensions/step are 0 until decompressed.
    // The caller (CrebainViewer) should decompress using image::codecs to get real dimensions.
    Ok(CameraFrame {
        data: image_data_b64,
        width: 0,
        height: 0,
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

    let is_little_endian = data[0] == CDR_LITTLE_ENDIAN;
    let mut offset = CDR_HEADER_SIZE;

    let (timestamp, frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    let height = read_u32(data, &mut offset, is_little_endian)?;
    let width = read_u32(data, &mut offset, is_little_endian)?;
    let distortion_model = read_cdr_string(data, &mut offset, is_little_endian)?;

    // D sequence
    let d_len = read_u32(data, &mut offset, is_little_endian)? as usize;
    let mut d = Vec::with_capacity(d_len);
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
        return Err(TransportError::DecodingError("IMU data too short".to_string()));
    }

    // Read CDR header for endianness
    let is_little_endian = data[0] == CDR_LITTLE_ENDIAN;
    let mut offset = CDR_HEADER_SIZE;

    // Decode header
    let (timestamp, _frame_id) = decode_ros2_header(data, &mut offset, is_little_endian)?;

    // Orientation quaternion (x, y, z, w) - 4 * f64
    let orientation = [
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
    ];

    // Skip orientation covariance (9 * f64 = 72 bytes)
    if data.len() < offset + 72 {
        return Err(TransportError::DecodingError("Orientation covariance truncated".to_string()));
    }
    offset += 72;

    // Angular velocity (x, y, z) - 3 * f64
    let angular_velocity = [
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
        read_f64(data, &mut offset, is_little_endian)?,
    ];

    // Skip angular velocity covariance (72 bytes)
    if data.len() < offset + 72 {
        return Err(TransportError::DecodingError("Angular velocity covariance truncated".to_string()));
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
    })
}

#[cfg(feature = "zenoh-transport")]
/// Decode geometry_msgs/PoseStamped from CDR
fn decode_pose_cdr(data: &[u8]) -> Result<PoseData> {
    if data.len() < CDR_HEADER_SIZE + 60 {
        return Err(TransportError::DecodingError("Pose data too short".to_string()));
    }

    // Read CDR header for endianness
    let is_little_endian = data[0] == CDR_LITTLE_ENDIAN;
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

    Ok(PoseData {
        position,
        orientation,
        timestamp,
        frame_id,
    })
}

#[cfg(feature = "zenoh-transport")]
fn read_pose_from_stream(data: &[u8], offset: &mut usize, is_little_endian: bool) -> Result<PoseData> {
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
    Ok(PoseData {
        position,
        orientation,
        timestamp: 0.0,
        frame_id: String::new(),
    })
}

#[cfg(feature = "zenoh-transport")]
fn read_twist_from_stream(data: &[u8], offset: &mut usize, is_little_endian: bool) -> Result<VelocityCmd> {
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
        return Err(TransportError::DecodingError("ModelStates data too short".to_string()));
    }

    // Read CDR header for endianness
    let is_little_endian = data[0] == CDR_LITTLE_ENDIAN;
    let mut offset = CDR_HEADER_SIZE;

    // name[]
    let name_len = read_u32(data, &mut offset, is_little_endian)? as usize;
    let mut name = Vec::with_capacity(name_len);
    for _ in 0..name_len {
        name.push(read_cdr_string(data, &mut offset, is_little_endian)?);
    }

    // pose[]
    let pose_len = read_u32(data, &mut offset, is_little_endian)? as usize;
    let mut pose = Vec::with_capacity(pose_len);
    for _ in 0..pose_len {
        pose.push(read_pose_from_stream(data, &mut offset, is_little_endian)?);
    }

    // twist[]
    let twist_len = read_u32(data, &mut offset, is_little_endian)? as usize;
    let mut twist = Vec::with_capacity(twist_len);
    for _ in 0..twist_len {
        twist.push(read_twist_from_stream(data, &mut offset, is_little_endian)?);
    }

    Ok(ModelStates { name, pose, twist })
}

#[cfg(feature = "zenoh-transport")]
/// Encode geometry_msgs/Twist to CDR
fn encode_twist_cdr(cmd: &VelocityCmd) -> Vec<u8> {
    let mut data = Vec::with_capacity(CDR_HEADER_SIZE + 48);

    // CDR header (little-endian): byte 0 = encoding (0x01 = LE), bytes 1-3 = options
    data.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]);

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

    // CDR encapsulation header (little-endian): byte 0 = encoding (0x01 = LE)
    data.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]);

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

    // CDR header (little-endian): byte 0 = encoding (0x01 = LE)
    data.extend_from_slice(&[0x01, 0x00, 0x00, 0x00]);

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

        // Configure for low-latency
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

    /// Convert ROS topic to Zenoh key expression
    /// ROS2 topics like "/camera/image_raw" become "camera/image_raw"
    fn ros_to_zenoh_key(topic: &str) -> String {
        topic.trim_start_matches('/').to_string()
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

    fn disconnect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            log::info!("[Zenoh] Disconnecting...");

            // Clear subscribers
            if let Ok(mut subs) = self.subscribers.lock() {
                subs.clear();
            }

            self.connected.store(false, Ordering::SeqCst);
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
        callback: super::CameraCallback,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        let key = Self::ros_to_zenoh_key(topic);
        let session = self.session.clone();
        let messages_received = self.messages_received.clone();
        let bytes_received = self.bytes_received.clone();
        let latency_sum = self.latency_sum_ns.clone();
        let latency_count = self.latency_count.clone();
        let subscribers = self.subscribers.clone();
        let is_compressed = topic.contains("compressed");

        Box::pin(async move {
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

    fn disconnect(&mut self) -> Pin<Box<dyn Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move { Ok(()) })
    }

    fn is_connected(&self) -> bool {
        false
    }

    fn subscribe_camera(
        &self,
        _topic: &str,
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
        assert_eq!(&data[0..4], &[0x01, 0x00, 0x00, 0x00]);

        // Check first linear value
        let val = f64::from_le_bytes(data[4..12].try_into().unwrap());
        assert!((val - 1.0).abs() < f64::EPSILON);
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
