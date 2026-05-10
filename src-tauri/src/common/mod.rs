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
