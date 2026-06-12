//! Common error types for CREBAIN.
//!
//! This module provides a unified error handling approach to replace
//! scattered `Result<T, String>` patterns throughout the codebase.

use std::error::Error;
use std::fmt;

/// Common errors for detector operations.
#[derive(Debug)]
pub enum DetectorError {
    /// Detector not initialized
    NotInitialized,
    /// Model file not found or invalid
    ModelNotFound(String),
    /// Model loading failed
    ModelLoadFailed(String),
    /// Invalid input dimensions or format
    InvalidInput(String),
    /// Inference failed
    InferenceFailed(String),
    /// Backend not available on this platform
    BackendNotAvailable(String),
    /// FFI/library loading error
    LibraryError(String),
    /// Configuration error
    ConfigError(String),
}

impl fmt::Display for DetectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DetectorError::NotInitialized => write!(f, "Detector not initialized"),
            DetectorError::ModelNotFound(path) => write!(f, "Model not found: {}", path),
            DetectorError::ModelLoadFailed(msg) => write!(f, "Model load failed: {}", msg),
            DetectorError::InvalidInput(msg) => write!(f, "Invalid input: {}", msg),
            DetectorError::InferenceFailed(msg) => write!(f, "Inference failed: {}", msg),
            DetectorError::BackendNotAvailable(msg) => write!(f, "Backend not available: {}", msg),
            DetectorError::LibraryError(msg) => write!(f, "Library error: {}", msg),
            DetectorError::ConfigError(msg) => write!(f, "Configuration error: {}", msg),
        }
    }
}

impl Error for DetectorError {}

// Allow conversion from String for backwards compatibility
impl From<String> for DetectorError {
    fn from(s: String) -> Self {
        DetectorError::InferenceFailed(s)
    }
}

impl From<&str> for DetectorError {
    fn from(s: &str) -> Self {
        DetectorError::InferenceFailed(s.to_string())
    }
}

/// Convenience type alias for detector results
pub type DetectorResult<T> = Result<T, DetectorError>;

/// Common errors for path operations.
#[derive(Debug)]
pub enum PathError {
    /// Path contains forbidden characters (null bytes, etc.)
    InvalidCharacters(String),
    /// Path traversal attempt detected
    TraversalAttempt(String),
    /// Path does not exist
    NotFound(String),
    /// Invalid file extension
    InvalidExtension { expected: Vec<String>, got: String },
    /// Canonicalization failed
    CanonicalizationFailed(String),
}

impl fmt::Display for PathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathError::InvalidCharacters(msg) => write!(f, "Invalid path characters: {}", msg),
            PathError::TraversalAttempt(path) => write!(f, "Path traversal detected: {}", path),
            PathError::NotFound(path) => write!(f, "Path not found: {}", path),
            PathError::InvalidExtension { expected, got } => {
                write!(
                    f,
                    "Invalid extension '{}', expected one of: {:?}",
                    got, expected
                )
            }
            PathError::CanonicalizationFailed(msg) => write!(f, "Path resolution failed: {}", msg),
        }
    }
}

impl Error for PathError {}

/// Convenience type alias for path results
pub type PathResult<T> = Result<T, PathError>;

/// Common errors for sensor fusion operations.
#[derive(Debug)]
pub enum FusionError {
    /// Filter not initialized
    NotInitialized,
    /// Numerical error (singular matrix, etc.)
    NumericalError(String),
    /// Invalid measurement data
    InvalidMeasurement(String),
    /// Track not found
    TrackNotFound(String),
    /// Configuration error
    ConfigError(String),
}

impl fmt::Display for FusionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FusionError::NotInitialized => write!(f, "Fusion engine not initialized"),
            FusionError::NumericalError(msg) => write!(f, "Numerical error: {}", msg),
            FusionError::InvalidMeasurement(msg) => write!(f, "Invalid measurement: {}", msg),
            FusionError::TrackNotFound(id) => write!(f, "Track not found: {}", id),
            FusionError::ConfigError(msg) => write!(f, "Configuration error: {}", msg),
        }
    }
}

impl Error for FusionError {}

/// Convenience type alias for fusion results
pub type FusionResult<T> = Result<T, FusionError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detector_error_display() {
        let err = DetectorError::NotInitialized;
        assert_eq!(err.to_string(), "Detector not initialized");

        let err = DetectorError::ModelNotFound("/path/to/model".to_string());
        assert!(err.to_string().contains("/path/to/model"));
    }

    #[test]
    fn test_error_from_string() {
        let err: DetectorError = "test error".into();
        assert!(matches!(err, DetectorError::InferenceFailed(_)));
    }
}
