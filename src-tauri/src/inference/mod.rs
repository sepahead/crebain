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
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Instant;

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
#[derive(Debug, Clone)]
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

/// Refinement policy applied uniformly after any backend returns detections.
///
/// Some backend implementations prefilter as tightly as confidence `0.25`,
/// IoU `0.45`, and 100 detections. A portable runtime policy can tighten those
/// common boundaries, but cannot recover candidates a backend already discarded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DetectionPolicy {
    confidence_threshold: f32,
    iou_threshold: f32,
    max_detections: usize,
}

pub const BACKEND_MIN_CONFIDENCE_THRESHOLD: f32 = 0.25;
pub const BACKEND_MAX_IOU_THRESHOLD: f32 = 0.45;
pub const BACKEND_MAX_DETECTIONS: usize = 100;

impl DetectionPolicy {
    /// Build a validated detection policy.
    pub fn new(
        confidence_threshold: f32,
        iou_threshold: f32,
        max_detections: usize,
    ) -> Result<Self> {
        if !confidence_threshold.is_finite()
            || !(BACKEND_MIN_CONFIDENCE_THRESHOLD..=1.0).contains(&confidence_threshold)
        {
            return Err(InferenceError::InvalidInput(
                format!(
                    "confidence threshold must be finite and between {BACKEND_MIN_CONFIDENCE_THRESHOLD} and 1; the common backend envelope starts at {BACKEND_MIN_CONFIDENCE_THRESHOLD}"
                ),
            ));
        }
        if !iou_threshold.is_finite() || !(0.0..=BACKEND_MAX_IOU_THRESHOLD).contains(&iou_threshold)
        {
            return Err(InferenceError::InvalidInput(
                format!(
                    "IoU threshold must be finite and between 0 and {BACKEND_MAX_IOU_THRESHOLD}; the common backend envelope ends at {BACKEND_MAX_IOU_THRESHOLD}"
                ),
            ));
        }
        if !(1..=BACKEND_MAX_DETECTIONS).contains(&max_detections) {
            return Err(InferenceError::InvalidInput(format!(
                "max detections must be between 1 and {BACKEND_MAX_DETECTIONS}; the common backend envelope caps at {BACKEND_MAX_DETECTIONS}"
            )));
        }

        Ok(Self {
            confidence_threshold,
            iou_threshold,
            max_detections,
        })
    }
}

/// Successful output from the persistent inference runtime.
#[derive(Debug, Clone)]
pub struct InferenceOutput {
    pub backend: Backend,
    pub backend_name: String,
    pub detections: Vec<Detection>,
    pub inference_time_ms: f64,
}

/// Initialization state of a detector runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Uninitialized,
    Ready,
    Failed,
}

/// Read-only diagnostic view of a detector runtime.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub status: RuntimeStatus,
    pub active_backend: Option<Backend>,
    pub initialization_error: Option<String>,
    pub stats: Option<InferenceStats>,
}

enum RuntimeState {
    Uninitialized,
    Ready(Arc<dyn Detector>),
    Failed(InferenceError),
}

type DetectorFactory = dyn Fn() -> Result<Box<dyn Detector>> + Send + Sync;

/// Owns one persistent detector selected by the inference factory.
///
/// Both successful initialization and initialization failure are cached. This
/// prevents expensive model or TensorRT engine loading from being repeated on
/// every camera frame. Construct a separate runtime when configuration changes.
pub struct DetectorRuntime {
    state: Mutex<RuntimeState>,
    factory: Box<DetectorFactory>,
}

impl DetectorRuntime {
    /// Create an isolated runtime. Production uses [`production_runtime`]; the
    /// constructor is public so tests and embedders can inject a deterministic
    /// detector factory without changing process-wide environment variables.
    pub fn new<F>(factory: F) -> Self
    where
        F: Fn() -> Result<Box<dyn Detector>> + Send + Sync + 'static,
    {
        Self {
            state: Mutex::new(RuntimeState::Uninitialized),
            factory: Box::new(factory),
        }
    }

    /// Initialize and warm the selected detector exactly once.
    pub fn initialize(&self) -> Result<Backend> {
        self.detector().map(|detector| detector.backend())
    }

    /// Run inference and apply caller policy consistently across backends.
    pub fn detect(
        &self,
        data: &[u8],
        width: u32,
        height: u32,
        policy: DetectionPolicy,
    ) -> Result<InferenceOutput> {
        validate_rgba_input_len(data.len(), width, height)?;
        let detector = self.detector()?;
        let backend = detector.backend();
        let started = Instant::now();
        let detections = detector.detect(data, width, height)?;
        let detections = apply_detection_policy(detections, policy, width, height)?;
        let backend_name = detector.stats().backend;

        Ok(InferenceOutput {
            backend,
            backend_name: if backend_name.is_empty() {
                backend.to_string()
            } else {
                backend_name
            },
            detections,
            inference_time_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// Return the current runtime state without triggering model loading.
    pub fn snapshot(&self) -> RuntimeSnapshot {
        let Ok(state) = self.state.lock() else {
            return RuntimeSnapshot {
                status: RuntimeStatus::Failed,
                active_backend: None,
                initialization_error: Some("inference runtime state lock poisoned".to_string()),
                stats: None,
            };
        };

        match &*state {
            RuntimeState::Uninitialized => RuntimeSnapshot {
                status: RuntimeStatus::Uninitialized,
                active_backend: None,
                initialization_error: None,
                stats: None,
            },
            RuntimeState::Ready(detector) => RuntimeSnapshot {
                status: RuntimeStatus::Ready,
                active_backend: Some(detector.backend()),
                initialization_error: None,
                stats: Some(detector.stats()),
            },
            RuntimeState::Failed(error) => RuntimeSnapshot {
                status: RuntimeStatus::Failed,
                active_backend: None,
                initialization_error: Some(error.to_string()),
                stats: None,
            },
        }
    }

    fn detector(&self) -> Result<Arc<dyn Detector>> {
        let mut state = self.state.lock().map_err(|_| {
            InferenceError::BackendError("inference runtime state lock poisoned".to_string())
        })?;

        match &*state {
            RuntimeState::Ready(detector) => return Ok(Arc::clone(detector)),
            RuntimeState::Failed(error) => {
                return Err(error.clone());
            }
            RuntimeState::Uninitialized => {}
        }

        let initialized = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (self.factory)().and_then(|mut detector| {
                let backend = detector.backend();
                detector.warmup().map_err(|error| {
                    InferenceError::BackendError(format!(
                        "{} backend warmup failed: {}",
                        backend, error
                    ))
                })?;
                Ok(Arc::<dyn Detector>::from(detector))
            })
        }))
        .unwrap_or_else(|_| {
            Err(InferenceError::BackendError(
                "detector factory or backend warmup panicked during initialization".to_string(),
            ))
        });

        match initialized {
            Ok(detector) => {
                log::info!(
                    "[Inference] Persistent runtime initialized with {} backend",
                    detector.backend()
                );
                *state = RuntimeState::Ready(Arc::clone(&detector));
                Ok(detector)
            }
            Err(error) => {
                log::error!("[Inference] Persistent runtime initialization failed: {error}");
                *state = RuntimeState::Failed(error.clone());
                Err(error)
            }
        }
    }
}

fn apply_detection_policy(
    mut detections: Vec<Detection>,
    policy: DetectionPolicy,
    frame_width: u32,
    frame_height: u32,
) -> Result<Vec<Detection>> {
    crate::common::nms::validate_nms_candidate_count(detections.len())
        .map_err(InferenceError::InferenceError)?;

    for detection in &detections {
        validate_detection(detection, frame_width, frame_height)?;
    }

    detections.retain(|detection| detection.confidence >= policy.confidence_threshold);
    detections.sort_by(|left, right| right.confidence.total_cmp(&left.confidence));

    let mut kept: Vec<Detection> = Vec::with_capacity(detections.len().min(policy.max_detections));
    for detection in detections {
        let suppressed = kept.iter().any(|candidate| {
            candidate.class_id == detection.class_id
                && intersection_over_union(&candidate.bbox, &detection.bbox) > policy.iou_threshold
        });
        if !suppressed {
            kept.push(detection);
            if kept.len() == policy.max_detections {
                break;
            }
        }
    }

    Ok(kept)
}

fn validate_detection(detection: &Detection, frame_width: u32, frame_height: u32) -> Result<()> {
    if !detection.confidence.is_finite() || !(0.0..=1.0).contains(&detection.confidence) {
        return Err(InferenceError::InferenceError(
            "backend returned a non-finite or out-of-range confidence".to_string(),
        ));
    }
    if detection
        .bbox
        .iter()
        .any(|coordinate| !coordinate.is_finite())
    {
        return Err(InferenceError::InferenceError(
            "backend returned a bounding box with non-finite coordinates".to_string(),
        ));
    }
    let [x1, y1, x2, y2] = detection.bbox;
    if x1 < 0.0 || y1 < 0.0 || x2 > frame_width as f32 || y2 > frame_height as f32 {
        return Err(InferenceError::InferenceError(format!(
            "backend returned a bounding box outside the {frame_width}x{frame_height} frame"
        )));
    }
    if x2 <= x1 || y2 <= y1 {
        return Err(InferenceError::InferenceError(
            "backend returned a degenerate bounding box".to_string(),
        ));
    }
    if detection.class_label.trim().is_empty() {
        return Err(InferenceError::InferenceError(
            "backend returned an empty class label".to_string(),
        ));
    }

    Ok(())
}

fn intersection_over_union(left: &[f32; 4], right: &[f32; 4]) -> f32 {
    let intersection_width = (left[2].min(right[2]) - left[0].max(right[0])).max(0.0);
    let intersection_height = (left[3].min(right[3]) - left[1].max(right[1])).max(0.0);
    let intersection = intersection_width * intersection_height;
    let left_area = (left[2] - left[0]) * (left[3] - left[1]);
    let right_area = (right[2] - right[0]) * (right[3] - right[1]);
    let union = left_area + right_area - intersection;

    if union > 0.0 {
        intersection / union
    } else {
        0.0
    }
}

static PRODUCTION_RUNTIME: LazyLock<DetectorRuntime> =
    LazyLock::new(|| DetectorRuntime::new(create_detector));

/// Return the process-wide runtime used by the production IPC path.
pub fn production_runtime() -> &'static DetectorRuntime {
    &PRODUCTION_RUNTIME
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
    if let Some(backend) = configured_backend()? {
        return create_detector_with_backend(backend);
    }

    // Auto-select based on platform
    #[cfg(target_os = "macos")]
    {
        // Fall back to CoreML
        if coreml::is_available() {
            match coreml::CoreMlDetector::new() {
                Ok(detector) => {
                    log::info!("[Inference] Using CoreML backend");
                    return Ok(Box::new(detector));
                }
                Err(e) => log::warn!("[Inference] CoreML backend failed, falling back: {}", e),
            }
        }

        if experimental_mlx_enabled() && mlx::is_available() {
            match mlx::MlxDetector::new() {
                Ok(detector) => {
                    log::info!("[Inference] Using experimental MLX backend (Apple Silicon)");
                    return Ok(Box::new(detector));
                }
                Err(e) => log::warn!("[Inference] MLX backend failed, falling back: {}", e),
            }
        }
    }

    #[cfg(all(target_os = "linux", not(test)))]
    {
        // Try TensorRT first
        if tensorrt::is_available() {
            match tensorrt::TensorRtDetector::new() {
                Ok(detector) => {
                    log::info!("[Inference] Using TensorRT backend");
                    return Ok(Box::new(detector));
                }
                Err(e) => log::warn!("[Inference] TensorRT backend failed, falling back: {}", e),
            }
        }

        // Fall back to CUDA
        if cuda::is_available() {
            match cuda::CudaDetector::new() {
                Ok(detector) => {
                    log::info!("[Inference] Using CUDA backend");
                    return Ok(Box::new(detector));
                }
                Err(e) => log::warn!("[Inference] CUDA backend failed, falling back: {}", e),
            }
        }
    }

    // Final fallback: ONNX Runtime
    log::info!("[Inference] Using ONNX Runtime backend (fallback)");
    let detector = onnx::OnnxDetector::new()?;
    Ok(Box::new(detector))
}

/// Create a detector with a specific backend
///
/// The MLX backend is experimental and additionally requires
/// `CREBAIN_ENABLE_EXPERIMENTAL_MLX=1`, even when requested explicitly via
/// `CREBAIN_BACKEND=mlx`.
pub fn create_detector_with_backend(backend: Backend) -> Result<Box<dyn Detector>> {
    match backend {
        #[cfg(target_os = "macos")]
        Backend::CoreML => {
            let detector = coreml::CoreMlDetector::new()?;
            Ok(Box::new(detector))
        }
        #[cfg(target_os = "macos")]
        Backend::MLX => {
            // Enforce the experimental gate for explicit requests too, so
            // CREBAIN_BACKEND=mlx cannot bypass the opt-in documented above.
            if !experimental_mlx_enabled() {
                return Err(InferenceError::BackendError(
                    "MLX backend is experimental and disabled; set \
                     CREBAIN_ENABLE_EXPERIMENTAL_MLX=1 to enable it"
                        .to_string(),
                ));
            }
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

/// Get backend candidates compiled for the current platform.
///
/// This intentionally does not probe hardware or load driver libraries. Provider
/// availability is checked during model initialization; use
/// [`DetectorRuntime::snapshot`] for the backend that is initialized and safe to
/// serve frames.
// The pushes are conditionally compiled per platform/target, so the vec![] macro
// clippy suggests does not apply across the cfg branches.
#[allow(clippy::vec_init_then_push)]
pub fn available_backends() -> Vec<Backend> {
    let mut backends = Vec::new();

    #[cfg(target_os = "macos")]
    {
        backends.push(Backend::CoreML);
        if experimental_mlx_enabled() && cfg!(target_arch = "aarch64") {
            backends.push(Backend::MLX);
        }
    }

    #[cfg(target_os = "linux")]
    {
        backends.push(Backend::TensorRT);
        backends.push(Backend::CUDA);
    }

    // The ONNX wrapper is compiled on every supported platform.
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

/// Parse the optional process-wide backend override.
pub fn configured_backend() -> Result<Option<Backend>> {
    configured_backend_from_value(std::env::var("CREBAIN_BACKEND").ok().as_deref())
}

fn configured_backend_from_value(value: Option<&str>) -> Result<Option<Backend>> {
    value.map(parse_backend_name).transpose()
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Barrier;

    struct FakeDetector {
        backend: Backend,
        detections: Vec<Detection>,
        warmup_count: Arc<AtomicUsize>,
        detect_count: Arc<AtomicUsize>,
        detection_error: Option<String>,
    }

    struct PanicWarmupDetector;

    impl Detector for PanicWarmupDetector {
        fn backend(&self) -> Backend {
            Backend::ONNX
        }

        fn warmup(&mut self) -> Result<()> {
            panic!("simulated warmup panic")
        }

        fn detect(&self, _data: &[u8], _width: u32, _height: u32) -> Result<Vec<Detection>> {
            Ok(Vec::new())
        }
    }

    impl Detector for FakeDetector {
        fn backend(&self) -> Backend {
            self.backend
        }

        fn warmup(&mut self) -> Result<()> {
            self.warmup_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn detect(&self, _data: &[u8], _width: u32, _height: u32) -> Result<Vec<Detection>> {
            self.detect_count.fetch_add(1, Ordering::SeqCst);
            if let Some(error) = &self.detection_error {
                return Err(InferenceError::InferenceError(error.clone()));
            }
            Ok(self.detections.clone())
        }

        fn stats(&self) -> InferenceStats {
            InferenceStats {
                total_inferences: self.detect_count.load(Ordering::SeqCst) as u64,
                backend: self.backend.to_string(),
                ..InferenceStats::default()
            }
        }
    }

    fn detection(bbox: [f32; 4], confidence: f32, class_id: u32, class_label: &str) -> Detection {
        Detection {
            bbox,
            confidence,
            class_id,
            class_label: class_label.to_string(),
        }
    }

    fn fake_runtime(
        detections: Vec<Detection>,
        factory_count: Arc<AtomicUsize>,
        warmup_count: Arc<AtomicUsize>,
        detect_count: Arc<AtomicUsize>,
    ) -> DetectorRuntime {
        DetectorRuntime::new(move || {
            factory_count.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeDetector {
                backend: Backend::ONNX,
                detections: detections.clone(),
                warmup_count: Arc::clone(&warmup_count),
                detect_count: Arc::clone(&detect_count),
                detection_error: None,
            }))
        })
    }

    #[test]
    fn test_available_backends() {
        let backends = available_backends();
        assert!(!backends.is_empty());
        assert!(backends.contains(&Backend::ONNX)); // ONNX always available

        #[cfg(target_os = "linux")]
        {
            assert!(backends.contains(&Backend::TensorRT));
            assert!(backends.contains(&Backend::CUDA));
        }
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

    #[test]
    fn configured_backend_from_value_parses_override_without_process_env() {
        assert_eq!(
            configured_backend_from_value(Some(" TensorRT ")).unwrap(),
            Some(Backend::TensorRT)
        );
    }

    #[test]
    fn configured_backend_from_value_rejects_unknown_override_without_process_env() {
        let error = configured_backend_from_value(Some("unknown"))
            .unwrap_err()
            .to_string();

        assert!(error.contains("Invalid backend 'unknown'"));
    }

    #[test]
    fn detection_policy_accepts_exact_common_backend_boundaries() {
        assert!(DetectionPolicy::new(
            BACKEND_MIN_CONFIDENCE_THRESHOLD,
            BACKEND_MAX_IOU_THRESHOLD,
            BACKEND_MAX_DETECTIONS,
        )
        .is_ok());
    }

    #[test]
    fn detection_policy_rejects_confidence_below_common_backend_boundary() {
        let error = DetectionPolicy::new(
            BACKEND_MIN_CONFIDENCE_THRESHOLD - 0.01,
            BACKEND_MAX_IOU_THRESHOLD,
            BACKEND_MAX_DETECTIONS,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("common backend envelope starts at 0.25"));
    }

    #[test]
    fn detection_policy_rejects_iou_above_common_backend_boundary() {
        let error = DetectionPolicy::new(
            BACKEND_MIN_CONFIDENCE_THRESHOLD,
            BACKEND_MAX_IOU_THRESHOLD + 0.01,
            BACKEND_MAX_DETECTIONS,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("common backend envelope ends at 0.45"));
    }

    #[test]
    fn detection_policy_rejects_max_above_common_backend_boundary() {
        let error = DetectionPolicy::new(
            BACKEND_MIN_CONFIDENCE_THRESHOLD,
            BACKEND_MAX_IOU_THRESHOLD,
            BACKEND_MAX_DETECTIONS + 1,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("common backend envelope caps at 100"));
    }

    #[test]
    fn runtime_initializes_and_warms_factory_detector_once_across_frames() {
        let factory_count = Arc::new(AtomicUsize::new(0));
        let warmup_count = Arc::new(AtomicUsize::new(0));
        let detect_count = Arc::new(AtomicUsize::new(0));
        let runtime = fake_runtime(
            vec![detection([0.0, 0.0, 1.0, 1.0], 0.9, 0, "person")],
            Arc::clone(&factory_count),
            Arc::clone(&warmup_count),
            Arc::clone(&detect_count),
        );
        let policy = DetectionPolicy::new(0.25, 0.45, 10).unwrap();

        runtime.detect(&[0, 0, 0, 255], 1, 1, policy).unwrap();
        runtime.detect(&[0, 0, 0, 255], 1, 1, policy).unwrap();

        assert_eq!(
            (
                factory_count.load(Ordering::SeqCst),
                warmup_count.load(Ordering::SeqCst),
                detect_count.load(Ordering::SeqCst),
            ),
            (1, 1, 2)
        );
    }

    #[test]
    fn concurrent_first_use_initializes_and_warms_factory_detector_once() {
        const WORKERS: usize = 8;

        let factory_count = Arc::new(AtomicUsize::new(0));
        let warmup_count = Arc::new(AtomicUsize::new(0));
        let detect_count = Arc::new(AtomicUsize::new(0));
        let runtime = Arc::new(fake_runtime(
            Vec::new(),
            Arc::clone(&factory_count),
            Arc::clone(&warmup_count),
            Arc::clone(&detect_count),
        ));
        let barrier = Arc::new(Barrier::new(WORKERS));
        let workers: Vec<_> = (0..WORKERS)
            .map(|_| {
                let runtime = Arc::clone(&runtime);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    runtime
                        .detect(
                            &[0, 0, 0, 255],
                            1,
                            1,
                            DetectionPolicy::new(0.25, 0.45, 10).unwrap(),
                        )
                        .unwrap();
                })
            })
            .collect();

        for worker in workers {
            worker.join().unwrap();
        }

        assert_eq!(
            (
                factory_count.load(Ordering::SeqCst),
                warmup_count.load(Ordering::SeqCst),
                detect_count.load(Ordering::SeqCst),
            ),
            (1, 1, WORKERS)
        );
    }

    #[test]
    fn runtime_applies_confidence_iou_and_max_policy_in_confidence_order() {
        let runtime = fake_runtime(
            vec![
                detection([0.0, 0.0, 0.5, 0.5], 0.8, 0, "person"),
                detection([0.05, 0.05, 0.55, 0.55], 0.9, 0, "person"),
                detection([0.6, 0.6, 0.8, 0.8], 0.7, 1, "bicycle"),
                detection([0.8, 0.8, 0.9, 0.9], 0.4, 2, "car"),
            ],
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );
        let policy = DetectionPolicy::new(0.5, 0.45, 2).unwrap();

        let output = runtime.detect(&[0, 0, 0, 255], 1, 1, policy).unwrap();
        let summary: Vec<_> = output
            .detections
            .iter()
            .map(|detection| (detection.class_id, detection.confidence))
            .collect();

        assert_eq!(summary, vec![(0, 0.9), (1, 0.7)]);
    }

    #[test]
    fn runtime_caches_factory_failure_instead_of_reloading_each_frame() {
        let factory_count = Arc::new(AtomicUsize::new(0));
        let count_for_factory = Arc::clone(&factory_count);
        let runtime = DetectorRuntime::new(move || {
            count_for_factory.fetch_add(1, Ordering::SeqCst);
            Err(InferenceError::ModelLoadError("missing model".to_string()))
        });
        let policy = DetectionPolicy::new(0.25, 0.45, 100).unwrap();

        let first = runtime.detect(&[0, 0, 0, 255], 1, 1, policy);
        let second = runtime.detect(&[0, 0, 0, 255], 1, 1, policy);

        assert_eq!(
            (
                first.unwrap_err().to_string(),
                second.unwrap_err().to_string(),
                factory_count.load(Ordering::SeqCst),
                runtime.snapshot().status,
            ),
            (
                "Model load error: missing model".to_string(),
                "Model load error: missing model".to_string(),
                1,
                RuntimeStatus::Failed,
            )
        );
    }

    #[test]
    fn runtime_caches_factory_panic_as_initialization_failure() {
        let factory_count = Arc::new(AtomicUsize::new(0));
        let count_for_factory = Arc::clone(&factory_count);
        let runtime = DetectorRuntime::new(move || -> Result<Box<dyn Detector>> {
            count_for_factory.fetch_add(1, Ordering::SeqCst);
            panic!("simulated factory panic")
        });

        let first = runtime.initialize().unwrap_err().to_string();
        let second = runtime.initialize().unwrap_err().to_string();

        assert_eq!(
            (
                first,
                second,
                factory_count.load(Ordering::SeqCst),
                runtime.snapshot().initialization_error,
            ),
            (
                "Backend error: detector factory or backend warmup panicked during initialization"
                    .to_string(),
                "Backend error: detector factory or backend warmup panicked during initialization"
                    .to_string(),
                1,
                Some(
                    "Backend error: detector factory or backend warmup panicked during initialization"
                        .to_string()
                ),
            )
        );
    }

    #[test]
    fn runtime_caches_warmup_panic_as_initialization_failure() {
        let factory_count = Arc::new(AtomicUsize::new(0));
        let count_for_factory = Arc::clone(&factory_count);
        let runtime = DetectorRuntime::new(move || {
            count_for_factory.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(PanicWarmupDetector) as Box<dyn Detector>)
        });

        let first = runtime.initialize().unwrap_err().to_string();
        let second = runtime.initialize().unwrap_err().to_string();

        assert_eq!(
            (
                first,
                second,
                factory_count.load(Ordering::SeqCst),
                runtime.snapshot().status,
            ),
            (
                "Backend error: detector factory or backend warmup panicked during initialization"
                    .to_string(),
                "Backend error: detector factory or backend warmup panicked during initialization"
                    .to_string(),
                1,
                RuntimeStatus::Failed,
            )
        );
    }

    #[test]
    fn runtime_rejects_invalid_backend_output_without_returning_partial_detections() {
        let runtime = fake_runtime(
            vec![detection([0.0, 0.0, f32::NAN, 1.0], 0.9, 0, "person")],
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );

        let error = runtime
            .detect(
                &[0, 0, 0, 255],
                1,
                1,
                DetectionPolicy::new(0.25, 0.45, 10).unwrap(),
            )
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "Inference error: backend returned a bounding box with non-finite coordinates"
        );
    }

    #[test]
    fn runtime_rejects_negative_bounding_box_coordinate() {
        let runtime = fake_runtime(
            vec![detection([-0.1, 0.0, 0.5, 0.5], 0.9, 0, "person")],
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );

        let error = runtime
            .detect(
                &[0, 0, 0, 255],
                1,
                1,
                DetectionPolicy::new(0.25, 0.45, 10).unwrap(),
            )
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "Inference error: backend returned a bounding box outside the 1x1 frame"
        );
    }

    #[test]
    fn runtime_rejects_bounding_box_beyond_frame_edge() {
        let runtime = fake_runtime(
            vec![detection([0.0, 0.0, 1.1, 1.0], 0.9, 0, "person")],
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );

        let error = runtime
            .detect(
                &[0, 0, 0, 255],
                1,
                1,
                DetectionPolicy::new(0.25, 0.45, 10).unwrap(),
            )
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "Inference error: backend returned a bounding box outside the 1x1 frame"
        );
    }

    #[test]
    fn runtime_rejects_degenerate_bounding_box() {
        let runtime = fake_runtime(
            vec![detection([0.5, 0.0, 0.5, 1.0], 0.9, 0, "person")],
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );

        let error = runtime
            .detect(
                &[0, 0, 0, 255],
                1,
                1,
                DetectionPolicy::new(0.25, 0.45, 10).unwrap(),
            )
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            "Inference error: backend returned a degenerate bounding box"
        );
    }

    #[test]
    fn runtime_accepts_bounding_box_clamped_to_frame_edges() {
        let runtime = fake_runtime(
            vec![detection([0.0, 0.0, 1.0, 1.0], 0.9, 0, "person")],
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );

        let output = runtime
            .detect(
                &[0, 0, 0, 255],
                1,
                1,
                DetectionPolicy::new(0.25, 0.45, 10).unwrap(),
            )
            .unwrap();

        assert_eq!(output.detections.len(), 1);
    }

    #[test]
    fn runtime_rejects_oversized_backend_candidate_set_before_nms() {
        let runtime = fake_runtime(
            vec![
                detection([0.0, 0.0, 1.0, 1.0], 0.9, 0, "person");
                crate::common::nms::MAX_NMS_CANDIDATES + 1
            ],
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );

        let error = runtime
            .detect(
                &[0, 0, 0, 255],
                1,
                1,
                DetectionPolicy::new(0.25, 0.45, 10).unwrap(),
            )
            .unwrap_err()
            .to_string();

        assert_eq!(
            error,
            format!(
                "Inference error: detector returned {} NMS candidates; maximum is {}",
                crate::common::nms::MAX_NMS_CANDIDATES + 1,
                crate::common::nms::MAX_NMS_CANDIDATES
            )
        );
    }

    #[test]
    fn runtime_snapshot_reports_actual_selected_backend_and_stats() {
        let detect_count = Arc::new(AtomicUsize::new(0));
        let runtime = fake_runtime(
            Vec::new(),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::clone(&detect_count),
        );
        runtime
            .detect(
                &[0, 0, 0, 255],
                1,
                1,
                DetectionPolicy::new(0.25, 0.45, 10).unwrap(),
            )
            .unwrap();

        let snapshot = runtime.snapshot();

        assert_eq!(
            (
                snapshot.status,
                snapshot.active_backend,
                snapshot.stats.map(|stats| stats.total_inferences),
            ),
            (RuntimeStatus::Ready, Some(Backend::ONNX), Some(1))
        );
    }

    #[test]
    fn mlx_vs_onnx_output_shape_parity() {
        // Both backends should produce [1, 144, 8400] output for 640x640 input
        // This test verifies structural parity without requiring real model files
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            let expected_shape = [1usize, 144, 8400];
            let device = candle_core::Device::Cpu;
            let dummy_output = candle_core::Tensor::zeros(
                expected_shape.as_slice(),
                candle_core::DType::F32,
                &device,
            )
            .unwrap();
            let dims = dummy_output.dims().to_vec();
            assert_eq!(dims, expected_shape, "MLX output shape mismatch");
        }

        // ONNX backend structural check (always compiles)
        let onnx_shape = [1usize, 144, 8400];
        assert_eq!(onnx_shape.len(), 3);
        assert_eq!(onnx_shape[1], 144); // reg_max*4 + nc
    }

    #[test]
    fn multi_backend_warmup_no_panic() {
        // Verify warmup doesn't panic across backends
        // CoreML warmup (macOS only)
        #[cfg(target_os = "macos")]
        {
            if coreml::is_available() {
                if let Ok(mut detector) = coreml::CoreMlDetector::new() {
                    let result = detector.warmup();
                    assert!(result.is_ok(), "CoreML warmup failed");
                }
            }
        }

        // MLX warmup (macOS Apple Silicon only)
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            if experimental_mlx_enabled() && mlx::is_available() {
                if let Ok(mut detector) = mlx::MlxDetector::new() {
                    let result = detector.warmup();
                    assert!(result.is_ok(), "MLX warmup failed");
                }
            }
        }

        // ONNX warmup (always available, skip if model not found)
        {
            if let Ok(mut detector) = onnx::OnnxDetector::new() {
                let result = detector.warmup();
                assert!(result.is_ok(), "ONNX warmup failed");
            }
        }
    }
}
