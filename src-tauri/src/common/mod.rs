//! Common types and constants shared across CREBAIN modules.
//!
//! This module provides centralized definitions for:
//! - COCO class labels used by all detectors
//! - Shared detection types
//! - Common utility functions
//! - Path validation for security
//! - Error types for consistent error handling

pub mod coco;
pub mod detection;
pub mod error;
pub mod image;
pub mod nms;
pub mod path;
pub mod yolo;

/// Encode bytes as lowercase hexadecimal without allocating per byte.
pub fn lower_hex(bytes: impl AsRef<[u8]>) -> String {
    const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

    let bytes = bytes.as_ref();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        encoded.push(HEX_DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(HEX_DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}
