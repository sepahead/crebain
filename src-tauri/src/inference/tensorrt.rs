//! TensorRT Backend (Linux with NVIDIA GPU)
//! NVIDIA TensorRT for optimized inference
//!
//! This module provides two approaches:
//! 1. ONNX Runtime with TensorRT Execution Provider (recommended)
//! 2. Native TensorRT engine files built with trtexec
//!
//! # Engine Building
//!
//! TensorRT engines are GPU-specific and must be built for each GPU architecture.
//! Use `build_engine()` to convert ONNX models to optimized TensorRT engines.
//!
//! ```bash
//! # Build engine manually (recommended for production)
//! trtexec --onnx=yolov8s.onnx --saveEngine=yolov8s.engine --fp16 --workspace=4096
//! ```

#[cfg(target_os = "linux")]
use super::{validate_rgba_input_len, InferenceStats};
use super::{Backend, Detection, Detector, InferenceError, Result};
use crate::common::path;
#[cfg(target_os = "linux")]
use crate::common::{coco, yolo};
use std::io::{self, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "linux")]
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use std::time::Instant;

const TRTEXEC_DIAGNOSTIC_LIMIT_BYTES: usize = 64 * 1024;

#[cfg(target_os = "linux")]
use ort::{
    execution_providers::{ExecutionProvider, TensorRTExecutionProvider},
    session::Session,
    value::Value,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TENSORRT DETECTOR
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// TensorRT detector using ONNX Runtime's TensorRT execution provider
#[cfg(target_os = "linux")]
pub struct TensorRtDetector {
    session: Mutex<Session>,
    input_width: u32,
    input_height: u32,
    num_classes: usize,
    confidence_threshold: f32,
    inference_count: AtomicU64,
    total_inference_ms: AtomicU64,
    model_load_ms: f64,
}

#[cfg(target_os = "linux")]
impl TensorRtDetector {
    /// Create a new TensorRT detector
    ///
    /// This requires the TensorRT execution provider. Backend fallback is owned
    /// by the inference factory so an explicit TensorRT override remains exact.
    pub fn new() -> Result<Self> {
        if !is_available() {
            return Err(InferenceError::BackendNotAvailable(Backend::TensorRT));
        }

        let load_start = Instant::now();

        // Find ONNX model (TensorRT EP can use ONNX directly)
        let model_path = find_model_path()
            .ok_or_else(|| InferenceError::ModelLoadError("Model not found".to_string()))?;

        log::info!("[TensorRT] Loading model: {:?}", model_path);

        let session = Self::create_session(&model_path)?;

        let model_load_ms = load_start.elapsed().as_secs_f64() * 1000.0;
        log::info!("[TensorRT] Model loaded in {:.1}ms", model_load_ms);

        Ok(Self {
            session: Mutex::new(session),
            input_width: 640,
            input_height: 640,
            num_classes: coco::NUM_CLASSES,
            confidence_threshold: 0.25,
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms,
        })
    }

    fn create_session(model_path: &PathBuf) -> Result<Session> {
        if !TensorRTExecutionProvider::default()
            .is_available()
            .unwrap_or(false)
        {
            return Err(InferenceError::BackendNotAvailable(Backend::TensorRT));
        }

        log::info!("[TensorRT] TensorRT execution provider available");

        // Configure TensorRT EP with optimizations. Enable caching if we have a
        // writable cache directory.
        let mut trt_ep = TensorRTExecutionProvider::default()
            .with_fp16(true)
            .with_int8(false)
            .with_engine_cache(false);

        if let Some(cache_dir) = path::tensorrt_engine_cache_dir() {
            trt_ep = trt_ep
                .with_engine_cache(true)
                .with_engine_cache_path(cache_dir.to_string_lossy().to_string());
        }

        Session::builder()
            .map_err(|e| InferenceError::ModelLoadError(e.to_string()))?
            .with_execution_providers([trt_ep.build().error_on_failure()])
            .map_err(|e| InferenceError::ModelLoadError(e.to_string()))?
            .commit_from_file(model_path)
            .map_err(|e| {
                InferenceError::ModelLoadError(format!(
                    "failed to create strict TensorRT session: {e}"
                ))
            })
    }

    /// Preprocess RGBA image to NCHW float tensor
    fn preprocess(&self, rgba_data: &[u8], width: u32, height: u32) -> Vec<f32> {
        let target_w = self.input_width as usize;
        let target_h = self.input_height as usize;
        let src_w = width as usize;
        let src_h = height as usize;

        let mut output = vec![0.0f32; 3 * target_h * target_w];
        let plane_size = target_h * target_w;

        // Nearest-neighbor resize and normalize
        for y in 0..target_h {
            for x in 0..target_w {
                let src_x = (x as f32 * src_w as f32 / target_w as f32) as usize;
                let src_y = (y as f32 * src_h as f32 / target_h as f32) as usize;
                let src_x = src_x.min(src_w - 1);
                let src_y = src_y.min(src_h - 1);
                let idx = (src_y * src_w + src_x) * 4;

                // RGBA to normalized RGB (NCHW format)
                let r = rgba_data[idx] as f32 / 255.0;
                let g = rgba_data[idx + 1] as f32 / 255.0;
                let b = rgba_data[idx + 2] as f32 / 255.0;

                let pixel_idx = y * target_w + x;
                output[pixel_idx] = r;
                output[plane_size + pixel_idx] = g;
                output[2 * plane_size + pixel_idx] = b;
            }
        }

        output
    }
}

// COCO class names
// COCO class labels are provided by `crate::common::coco`.

#[cfg(target_os = "linux")]
impl Detector for TensorRtDetector {
    fn backend(&self) -> Backend {
        Backend::TensorRT
    }

    fn warmup(&mut self) -> Result<()> {
        log::info!("[TensorRT] Warming up (running dummy inference)...");

        // Run a dummy inference to warm up TensorRT
        let dummy_data = vec![0u8; (self.input_width * self.input_height * 4) as usize];
        self.detect(&dummy_data, self.input_width, self.input_height)?;

        Ok(())
    }

    fn detect(&self, data: &[u8], width: u32, height: u32) -> Result<Vec<Detection>> {
        let start = Instant::now();

        validate_rgba_input_len(data.len(), width, height)?;

        // Preprocess
        let input_tensor = self.preprocess(data, width, height);

        // Run inference
        let input_shape = [1_i64, 3, self.input_height as i64, self.input_width as i64];
        let input = Value::from_array((input_shape, input_tensor.into_boxed_slice()))
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

        let mut session = self
            .session
            .lock()
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

        let outputs = session
            .run(ort::inputs![input])
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

        // Get output tensor
        let output = outputs
            .iter()
            .next()
            .ok_or_else(|| InferenceError::InferenceError("No output".to_string()))?
            .1;

        let (shape, output_data) = output
            .try_extract_tensor::<f32>()
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

        let shape_dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        let (layout, num_anchors) = yolo::infer_yolov8_output_layout(&shape_dims)
            .map_err(InferenceError::InferenceError)?;
        yolo::validate_yolov8_output_len(layout, num_anchors, output_data.len())
            .map_err(InferenceError::InferenceError)?;
        yolo::validate_yolov8_class_count(self.num_classes)
            .map_err(InferenceError::InferenceError)?;

        let mut detections = Vec::new();
        let img_w = width as f32;
        let img_h = height as f32;

        for i in 0..num_anchors {
            let (cx, cy, w, h) = yolo::read_bbox(layout, output_data, num_anchors, i)
                .map_err(InferenceError::InferenceError)?;

            let mut max_score = 0.0f32;
            let mut max_class = 0u32;
            for c in 0..self.num_classes {
                let score = yolo::read_class_score(layout, output_data, num_anchors, i, c)
                    .map_err(InferenceError::InferenceError)?;
                if score > max_score {
                    max_score = score;
                    max_class = c as u32;
                }
            }

            if max_score < self.confidence_threshold {
                continue;
            }

            let x1 = ((cx - w / 2.0) * img_w / self.input_width as f32).max(0.0);
            let y1 = ((cy - h / 2.0) * img_h / self.input_height as f32).max(0.0);
            let x2 = ((cx + w / 2.0) * img_w / self.input_width as f32).min(img_w);
            let y2 = ((cy + h / 2.0) * img_h / self.input_height as f32).min(img_h);

            let detection = Detection {
                bbox: [x1, y1, x2, y2],
                confidence: max_score,
                class_id: max_class,
                class_label: coco::get_class_name(max_class as usize),
            };
            super::validate_backend_detection(&detection, width, height)?;
            detections.push(detection);
        }

        detections = super::apply_common_nms(detections, 0.45)?;

        let elapsed_ms = start.elapsed().as_millis() as u64;
        self.inference_count.fetch_add(1, Ordering::Relaxed);
        self.total_inference_ms
            .fetch_add(elapsed_ms, Ordering::Relaxed);

        Ok(detections)
    }

    fn stats(&self) -> InferenceStats {
        let count = self.inference_count.load(Ordering::Relaxed);
        let total_ms = self.total_inference_ms.load(Ordering::Relaxed);

        InferenceStats {
            avg_inference_ms: if count > 0 {
                total_ms as f64 / count as f64
            } else {
                0.0
            },
            total_inferences: count,
            model_load_ms: self.model_load_ms,
            backend: "TensorRT".to_string(),
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ENGINE BUILDING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Build a TensorRT engine from an ONNX model using trtexec
///
/// # Arguments
/// * `onnx_path` - Path to the ONNX model
/// * `engine_path` - Output path for the TensorRT engine
/// * `fp16` - Enable FP16 precision (faster, slightly less accurate)
/// * `int8` - Enable INT8 precision (requires calibration)
///
/// # Returns
/// Result indicating success or failure
pub fn build_engine(onnx_path: &str, engine_path: &str, fp16: bool, int8: bool) -> Result<()> {
    if int8 {
        return Err(InferenceError::BackendError(
            "TensorRT INT8 engine building requires calibration data and is not supported by this command".to_string(),
        ));
    }

    let onnx_path = path::validate_model_path(onnx_path, Some(&["onnx"]))
        .map_err(|e| InferenceError::BackendError(format!("Invalid ONNX model path: {}", e)))?;
    let engine_path = validate_tensorrt_engine_output_path(engine_path)?;

    log::info!(
        "[TensorRT] Building engine: {} -> {} (FP16: {}, INT8: {})",
        onnx_path.display(),
        engine_path.display(),
        fp16,
        int8
    );

    // Find trtexec
    let trtexec = find_trtexec()
        .ok_or_else(|| InferenceError::BackendError("trtexec not found".to_string()))?;

    let mut cmd = Command::new(&trtexec);
    cmd.arg(format!("--onnx={}", onnx_path.display()))
        .arg(format!("--saveEngine={}", engine_path.display()))
        .arg("--workspace=4096"); // 4GB workspace

    if fp16 {
        cmd.arg("--fp16");
    }

    // Add optimization flags
    cmd.arg("--tacticSources=+CUDNN,+CUBLAS,+CUBLAS_LT");

    log::info!("[TensorRT] Running: {:?}", cmd);

    cmd.stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| InferenceError::BackendError(format!("Failed to run trtexec: {e}")))?;
    let stderr = child.stderr.take().ok_or_else(|| {
        InferenceError::BackendError("Failed to capture trtexec diagnostics".to_string())
    })?;
    let stderr_reader = std::thread::spawn(move || read_bounded_diagnostics(stderr));
    let status = child
        .wait()
        .map_err(|e| InferenceError::BackendError(format!("Failed to wait for trtexec: {e}")))?;
    let diagnostics = stderr_reader
        .join()
        .map_err(|_| {
            InferenceError::BackendError("trtexec diagnostic reader panicked".to_string())
        })?
        .map_err(|e| {
            InferenceError::BackendError(format!("Failed to read trtexec diagnostics: {e}"))
        })?;

    if !status.success() {
        return Err(InferenceError::BackendError(format!(
            "trtexec failed: {}",
            diagnostics.render()
        )));
    }

    log::info!(
        "[TensorRT] Engine built successfully: {}",
        engine_path.display()
    );
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct BoundedDiagnostics {
    bytes: Vec<u8>,
    truncated: bool,
}

impl BoundedDiagnostics {
    fn render(&self) -> String {
        let mut rendered = String::from_utf8_lossy(&self.bytes).into_owned();
        if self.truncated {
            rendered.push_str(&format!(
                "\n[trtexec diagnostics truncated after {TRTEXEC_DIAGNOSTIC_LIMIT_BYTES} bytes]"
            ));
        }
        rendered
    }
}

fn read_bounded_diagnostics(mut reader: impl Read) -> io::Result<BoundedDiagnostics> {
    let mut bytes = Vec::with_capacity(TRTEXEC_DIAGNOSTIC_LIMIT_BYTES);
    let mut buffer = [0_u8; 8 * 1024];
    let mut truncated = false;

    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = TRTEXEC_DIAGNOSTIC_LIMIT_BYTES.saturating_sub(bytes.len());
        let retained = remaining.min(read);
        bytes.extend_from_slice(&buffer[..retained]);
        truncated |= retained < read;
    }

    Ok(BoundedDiagnostics { bytes, truncated })
}

fn validate_tensorrt_engine_output_path(engine_path: &str) -> Result<PathBuf> {
    let path = path::validate_path(engine_path, None).map_err(|e| {
        InferenceError::BackendError(format!("Invalid TensorRT engine output path: {}", e))
    })?;

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("engine") {
        return Err(InferenceError::BackendError(format!(
            "Invalid TensorRT engine extension '{}', expected 'engine'",
            ext
        )));
    }

    if path.exists() && path.is_dir() {
        return Err(InferenceError::BackendError(format!(
            "TensorRT engine output path is a directory: {}",
            path.display()
        )));
    }

    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if !parent.exists() {
            return Err(InferenceError::BackendError(format!(
                "TensorRT engine output parent does not exist: {}",
                parent.display()
            )));
        }
        if !parent.is_dir() {
            return Err(InferenceError::BackendError(format!(
                "TensorRT engine output parent is not a directory: {}",
                parent.display()
            )));
        }
    }

    Ok(path)
}

/// Find the trtexec binary
fn find_trtexec() -> Option<PathBuf> {
    // Check TensorRT installation paths
    let paths = [
        "/usr/bin/trtexec",
        "/usr/local/bin/trtexec",
        "/opt/TensorRT/bin/trtexec",
    ];

    for path in paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    // Check TENSORRT_ROOT
    if let Ok(root) = std::env::var("TENSORRT_ROOT") {
        let p = PathBuf::from(root).join("bin/trtexec");
        if p.exists() {
            return Some(p);
        }
    }

    // Check PATH without launching another process or buffering its output.
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join("trtexec");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UTILITY FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Find ONNX model path
#[cfg(target_os = "linux")]
fn find_model_path() -> Option<PathBuf> {
    if let Ok(custom_path) = std::env::var("CREBAIN_ONNX_MODEL") {
        if let Some(path) = validate_tensorrt_model_path("CREBAIN_ONNX_MODEL", &custom_path) {
            return Some(path);
        }
    }

    if let Ok(custom_path) = std::env::var("CREBAIN_MODEL_PATH") {
        if let Some(path) = validate_tensorrt_model_path("CREBAIN_MODEL_PATH", &custom_path) {
            return Some(path);
        }
    }

    let paths = [
        "resources/yolov8s.onnx",
        "src-tauri/resources/yolov8s.onnx",
        "../resources/yolov8s.onnx",
        "/usr/share/crebain/models/yolov8s.onnx",
        "/opt/crebain/models/yolov8s.onnx",
    ];

    for candidate in paths {
        if let Some(path) = validate_tensorrt_model_path("candidate", candidate) {
            return Some(path);
        }
    }

    None
}

fn validate_tensorrt_model_path(source: &str, model_path: &str) -> Option<PathBuf> {
    match path::validate_model_path(model_path, Some(&["onnx"])) {
        Ok(path) => Some(path),
        Err(e) => {
            if source == "candidate" {
                log::debug!("[TensorRT] Skipping model candidate {}: {}", model_path, e);
            } else {
                log::warn!("[TensorRT] Invalid {} path: {}", source, e);
            }
            None
        }
    }
}

/// Check if TensorRT is available
pub fn is_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        // Prefer checking ONNX Runtime execution provider availability since
        // `nvidia-smi` may not be present in minimal/containerized deployments.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            TensorRTExecutionProvider::default()
                .is_available()
                .unwrap_or(false)
        }))
        .unwrap_or(false)
    }

    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STUB FOR NON-LINUX
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(not(target_os = "linux"))]
pub struct TensorRtDetector {
    _phantom: std::marker::PhantomData<()>,
}

#[cfg(not(target_os = "linux"))]
impl TensorRtDetector {
    pub fn new() -> Result<Self> {
        Err(InferenceError::BackendNotAvailable(Backend::TensorRT))
    }
}

#[cfg(not(target_os = "linux"))]
impl Detector for TensorRtDetector {
    fn backend(&self) -> Backend {
        Backend::TensorRT
    }

    fn detect(&self, _data: &[u8], _width: u32, _height: u32) -> Result<Vec<Detection>> {
        Err(InferenceError::BackendNotAvailable(Backend::TensorRT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_tensorrt_model_path_extension_and_security() {
        let model_path = std::env::temp_dir().join(format!(
            "crebain-tensorrt-model-{}.onnx",
            std::process::id()
        ));
        std::fs::write(&model_path, b"model").unwrap();

        let valid = validate_tensorrt_model_path("test", model_path.to_str().unwrap());

        assert_eq!(
            valid.as_deref(),
            Some(model_path.canonicalize().unwrap().as_path())
        );

        let _ = std::fs::remove_file(model_path);
    }

    #[test]
    fn rejects_invalid_tensorrt_model_paths() {
        let wrong_ext =
            std::env::temp_dir().join(format!("crebain-tensorrt-model-{}.txt", std::process::id()));
        std::fs::write(&wrong_ext, b"model").unwrap();

        assert!(validate_tensorrt_model_path("test", wrong_ext.to_str().unwrap()).is_none());
        assert!(validate_tensorrt_model_path("test", "../models/model.onnx").is_none());
        assert!(validate_tensorrt_model_path("test", "/tmp/model\0.onnx").is_none());

        let _ = std::fs::remove_file(wrong_ext);
    }

    #[test]
    fn build_engine_rejects_int8_without_calibration_before_path_checks() {
        let error = build_engine("", "", false, true).unwrap_err().to_string();

        assert!(error.contains("INT8"));
        assert!(error.contains("calibration"));
    }

    #[test]
    fn trtexec_diagnostics_are_drained_but_retained_within_the_limit() {
        let source = vec![b'x'; TRTEXEC_DIAGNOSTIC_LIMIT_BYTES + 17];

        let diagnostics = read_bounded_diagnostics(source.as_slice()).unwrap();

        assert_eq!(diagnostics.bytes.len(), TRTEXEC_DIAGNOSTIC_LIMIT_BYTES);
        assert!(diagnostics.truncated);
        assert!(diagnostics.render().contains("diagnostics truncated"));
    }

    #[test]
    fn validates_tensorrt_engine_output_path() {
        let engine_path = std::env::temp_dir().join(format!(
            "crebain-tensorrt-engine-{}.engine",
            std::process::id()
        ));

        let valid = validate_tensorrt_engine_output_path(engine_path.to_str().unwrap()).unwrap();

        assert_eq!(valid.as_path(), engine_path.as_path());
    }

    #[test]
    fn rejects_invalid_tensorrt_engine_output_paths() {
        let wrong_ext = std::env::temp_dir().join(format!(
            "crebain-tensorrt-engine-{}.txt",
            std::process::id()
        ));
        let missing_parent = std::env::temp_dir()
            .join(format!("crebain-missing-{}", std::process::id()))
            .join("model.engine");

        let wrong_ext_error =
            validate_tensorrt_engine_output_path(wrong_ext.to_str().unwrap()).unwrap_err();
        let traversal_error = validate_tensorrt_engine_output_path("../model.engine").unwrap_err();
        let missing_parent_error =
            validate_tensorrt_engine_output_path(missing_parent.to_str().unwrap()).unwrap_err();

        assert!(wrong_ext_error.to_string().contains("extension"));
        assert!(traversal_error.to_string().contains("traversal"));
        assert!(missing_parent_error
            .to_string()
            .contains("parent does not exist"));
    }
}
