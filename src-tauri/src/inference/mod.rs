//! CREBAIN Inference Abstraction Layer
//! Adaptive Response & Awareness System (ARAS)
//!
//! Platform-agnostic ML inference with automatic backend selection:
//! - macOS: CoreML / MLX
//! - Linux: CUDA / TensorRT / ONNX Runtime
//!
//! # Usage
//! ```rust,ignore
//! use crate::inference::{create_detector, Detector, Detection};
//!
//! let detector = create_detector()?;
//! let detections = detector.detect(&image_data, width, height)?;
//! ```

use std::error::Error;
use std::fmt;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PLATFORM-SPECIFIC MODULES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(target_os = "macos")]
pub mod coreml;

#[cfg(target_os = "macos")]
pub mod mlx;

#[cfg(target_os = "linux")]
pub mod cuda;

#[cfg(any(target_os = "linux", test))]
pub mod tensorrt;

// ONNX is available on all platforms as fallback
pub mod onnx;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Detection result from ML inference
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Detection {
    /// Bounding box [x1, y1, x2, y2] in pixels
    pub bbox: [f32; 4],
    /// Confidence score 0.0-1.0
    pub confidence: f32,
    /// Class index
    pub class_id: u32,
    /// Class label
    pub class_label: String,
}

/// Backend type for inference
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Backend {
    /// Apple CoreML (macOS)
    CoreML,
    /// Apple MLX (macOS, Apple Silicon)
    MLX,
    /// NVIDIA CUDA (Linux)
    CUDA,
    /// NVIDIA TensorRT (Linux)
    TensorRT,
    /// ONNX Runtime (cross-platform fallback)
    ONNX,
}

const SUPPORTED_BACKEND_NAMES: &str = "coreml, mlx, cuda, tensorrt, onnx";

impl fmt::Display for Backend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Backend::CoreML => write!(f, "CoreML"),
            Backend::MLX => write!(f, "MLX"),
            Backend::CUDA => write!(f, "CUDA"),
            Backend::TensorRT => write!(f, "TensorRT"),
            Backend::ONNX => write!(f, "ONNX"),
        }
    }
}

/// Inference error
#[derive(Debug)]
pub enum InferenceError {
    /// Backend not available on this platform
    BackendNotAvailable(Backend),
    /// Unknown backend name requested by configuration
    InvalidBackend(String),
    /// Model loading failed
    ModelLoadError(String),
    /// Inference failed
    InferenceError(String),
    /// Invalid input
    InvalidInput(String),
    /// Backend-specific error
    BackendError(String),
}

impl fmt::Display for InferenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InferenceError::BackendNotAvailable(b) => write!(f, "Backend not available: {}", b),
            InferenceError::InvalidBackend(s) if s.is_empty() => write!(
                f,
                "Invalid backend: empty value; expected one of: {}",
                SUPPORTED_BACKEND_NAMES
            ),
            InferenceError::InvalidBackend(s) => write!(
                f,
                "Invalid backend '{}'; expected one of: {}",
                s, SUPPORTED_BACKEND_NAMES
            ),
            InferenceError::ModelLoadError(s) => write!(f, "Model load error: {}", s),
            InferenceError::InferenceError(s) => write!(f, "Inference error: {}", s),
            InferenceError::InvalidInput(s) => write!(f, "Invalid input: {}", s),
            InferenceError::BackendError(s) => write!(f, "Backend error: {}", s),
        }
    }
}

impl Error for InferenceError {}

pub type Result<T> = std::result::Result<T, InferenceError>;

pub(crate) fn validate_rgba_input_len(rgba_len: usize, width: u32, height: u32) -> Result<usize> {
    crate::common::image::validate_rgba_input_len(rgba_len, width, height)
        .map_err(InferenceError::InvalidInput)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DETECTOR TRAIT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Trait for object detection backends
pub trait Detector: Send + Sync {
    /// Get the backend type
    fn backend(&self) -> Backend;

    /// Warm up the model (optional, for JIT compilation)
    fn warmup(&mut self) -> Result<()> {
        Ok(())
    }

    /// Run detection on image data
    ///
    /// # Arguments
    /// * `data` - RGBA image data
    /// * `width` - Image width in pixels
    /// * `height` - Image height in pixels
    ///
    /// # Returns
    /// Vector of detections
    fn detect(&self, data: &[u8], width: u32, height: u32) -> Result<Vec<Detection>>;

    /// Run detection on image data (async)
    fn detect_async(
        &self,
        data: &[u8],
        width: u32,
        height: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Detection>>> + Send + '_>>
    {
        let data = data.to_vec();
        Box::pin(async move { self.detect(&data, width, height) })
    }

    /// Get inference statistics
    fn stats(&self) -> InferenceStats {
        InferenceStats::default()
    }
}

/// Inference statistics
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct InferenceStats {
    /// Average inference time in milliseconds
    pub avg_inference_ms: f64,
    /// Total inferences run
    pub total_inferences: u64,
    /// Model load time in milliseconds
    pub model_load_ms: f64,
    /// Backend name
    pub backend: String,
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FACTORY FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Create a detector for the current platform
///
/// # Selection Order
///
/// **macOS:**
/// 1. CoreML
/// 2. MLX (experimental, only when `CREBAIN_ENABLE_EXPERIMENTAL_MLX=1`)
/// 3. ONNX (fallback)
///
/// **Linux:**
/// 1. TensorRT (if NVIDIA GPU and available)
/// 2. CUDA (if NVIDIA GPU)
/// 3. ONNX (fallback)
pub fn create_detector() -> Result<Box<dyn Detector>> {
    // Check environment variable for forced backend
    if let Ok(backend) = std::env::var("CREBAIN_BACKEND") {
        return create_detector_with_backend(parse_backend_name(&backend)?);
    }

    // Auto-select based on platform
    #[cfg(target_os = "macos")]
    {
        // Fall back to CoreML
        if coreml::is_available() {
            if let Ok(detector) = coreml::CoreMlDetector::new() {
                log::info!("[Inference] Using CoreML backend");
                return Ok(Box::new(detector));
            }
        }

        if experimental_mlx_enabled() && mlx::is_available() {
            if let Ok(detector) = mlx::MlxDetector::new() {
                log::info!("[Inference] Using experimental MLX backend (Apple Silicon)");
                return Ok(Box::new(detector));
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Try TensorRT first
        if tensorrt::is_available() {
            if let Ok(detector) = tensorrt::TensorRtDetector::new() {
                log::info!("[Inference] Using TensorRT backend");
                return Ok(Box::new(detector));
            }
        }

        // Fall back to CUDA
        if cuda::is_available() {
            if let Ok(detector) = cuda::CudaDetector::new() {
                log::info!("[Inference] Using CUDA backend");
                return Ok(Box::new(detector));
            }
        }
    }

    // Final fallback: ONNX Runtime
    log::info!("[Inference] Using ONNX Runtime backend (fallback)");
    let detector = onnx::OnnxDetector::new()?;
    Ok(Box::new(detector))
}

/// Create a detector with a specific backend
pub fn create_detector_with_backend(backend: Backend) -> Result<Box<dyn Detector>> {
    match backend {
        #[cfg(target_os = "macos")]
        Backend::CoreML => {
            let detector = coreml::CoreMlDetector::new()?;
            Ok(Box::new(detector))
        }
        #[cfg(target_os = "macos")]
        Backend::MLX => {
            let detector = mlx::MlxDetector::new()?;
            Ok(Box::new(detector))
        }
        #[cfg(target_os = "linux")]
        Backend::CUDA => {
            let detector = cuda::CudaDetector::new()?;
            Ok(Box::new(detector))
        }
        #[cfg(target_os = "linux")]
        Backend::TensorRT => {
            let detector = tensorrt::TensorRtDetector::new()?;
            Ok(Box::new(detector))
        }
        Backend::ONNX => {
            let detector = onnx::OnnxDetector::new()?;
            Ok(Box::new(detector))
        }
        #[allow(unreachable_patterns)]
        _ => Err(InferenceError::BackendNotAvailable(backend)),
    }
}

/// Get available backends on the current platform
pub fn available_backends() -> Vec<Backend> {
    let mut backends = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if coreml::is_available() {
            backends.push(Backend::CoreML);
        }
        if experimental_mlx_enabled() && mlx::is_available() {
            backends.push(Backend::MLX);
        }
    }

    #[cfg(target_os = "linux")]
    {
        if tensorrt::is_available() {
            backends.push(Backend::TensorRT);
        }
        if cuda::is_available() {
            backends.push(Backend::CUDA);
        }
    }

    // ONNX is always available
    backends.push(Backend::ONNX);

    backends
}

fn is_truthy_env_value(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn experimental_mlx_enabled() -> bool {
    is_truthy_env_value(&std::env::var("CREBAIN_ENABLE_EXPERIMENTAL_MLX").unwrap_or_default())
}

fn parse_backend_name(value: &str) -> Result<Backend> {
    let trimmed = value.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "coreml" => Ok(Backend::CoreML),
        "mlx" => Ok(Backend::MLX),
        "cuda" => Ok(Backend::CUDA),
        "tensorrt" => Ok(Backend::TensorRT),
        "onnx" => Ok(Backend::ONNX),
        _ => Err(InferenceError::InvalidBackend(trimmed.to_string())),
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_available_backends() {
        let backends = available_backends();
        assert!(!backends.is_empty());
        assert!(backends.contains(&Backend::ONNX)); // ONNX always available
    }

    #[test]
    fn test_backend_display() {
        assert_eq!(format!("{}", Backend::CoreML), "CoreML");
        assert_eq!(format!("{}", Backend::CUDA), "CUDA");
    }

    #[test]
    fn test_truthy_env_value_parsing() {
        assert!(is_truthy_env_value("1"));
        assert!(is_truthy_env_value("true"));
        assert!(is_truthy_env_value("YES"));
        assert!(is_truthy_env_value(" on "));
        assert!(is_truthy_env_value("on"));
        assert!(!is_truthy_env_value(""));
        assert!(!is_truthy_env_value("0"));
        assert!(!is_truthy_env_value("false"));
    }

    #[test]
    fn test_rgba_input_len_validation() {
        assert_eq!(validate_rgba_input_len(16, 2, 2).unwrap(), 16);
        assert!(validate_rgba_input_len(0, 0, 1).is_err());
        assert!(validate_rgba_input_len(15, 2, 2).is_err());
        assert!(validate_rgba_input_len(0, u32::MAX, u32::MAX).is_err());
    }

    #[test]
    fn test_parse_backend_name() {
        assert_eq!(parse_backend_name("coreml").unwrap(), Backend::CoreML);
        assert_eq!(parse_backend_name(" MLX ").unwrap(), Backend::MLX);
        assert_eq!(parse_backend_name("cuda").unwrap(), Backend::CUDA);
        assert_eq!(parse_backend_name("tensorrt").unwrap(), Backend::TensorRT);
        assert_eq!(parse_backend_name("onnx").unwrap(), Backend::ONNX);
        let error = parse_backend_name("zig").unwrap_err().to_string();
        assert!(error.contains("Invalid backend 'zig'"));
        assert!(error.contains(SUPPORTED_BACKEND_NAMES));
    }
}
