//! CREBAIN ONNX Runtime Detector
//! Cross-platform ML inference using ONNX Runtime
//!
//! Supports multiple execution providers:
//! - CoreML (macOS with Apple Silicon/Neural Engine)
//! - CUDA (Linux/Windows with NVIDIA GPU)
//! - TensorRT (optimized NVIDIA inference)
//! - CPU (fallback for all platforms)
//!
//! This serves as the universal fallback when the native CoreML FFI backend is unavailable

#[cfg(target_os = "linux")]
use crate::common::path;
use crate::common::{coco, image, yolo};
use ort::{session::Session, value::Value};

#[cfg(target_os = "linux")]
use ort::execution_providers::{
    CUDAExecutionProvider, ExecutionProvider, TensorRTExecutionProvider,
};

#[cfg(target_os = "macos")]
use ort::execution_providers::{CoreMLExecutionProvider, ExecutionProvider};

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION TYPES
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub id: String,
    pub class_label: String,
    pub class_index: i32,
    pub confidence: f32,
    pub bbox: BoundingBox,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnnxDetectionResult {
    pub success: bool,
    pub detections: Vec<Detection>,
    pub inference_time_ms: f64,
    pub preprocess_time_ms: f64,
    pub postprocess_time_ms: f64,
    pub backend: String,
    pub error: Option<String>,
}

// COCO labels and YOLO output helpers are provided by `crate::common`.

// ─────────────────────────────────────────────────────────────────────────────
// ONNX DETECTOR (Cross-platform)
// ─────────────────────────────────────────────────────────────────────────────

pub struct OnnxDetector {
    session: Mutex<Session>,
    input_width: u32,
    input_height: u32,
    num_classes: usize,
    confidence_threshold: f32,
    iou_threshold: f32,
    detection_counter: std::sync::atomic::AtomicU64,
    backend_name: String,
}

static DETECTOR: OnceLock<Result<OnnxDetector, String>> = OnceLock::new();

impl OnnxDetector {
    /// Create a new ONNX detector with the given model path
    pub fn new(
        model_path: &str,
        confidence_threshold: f32,
        iou_threshold: f32,
    ) -> Result<Self, String> {
        let (session, backend_name) = Self::create_session(model_path)?;

        log::info!("ONNX: Model loaded successfully from {}", model_path);
        log::info!("ONNX: Backend: {}", backend_name);

        Ok(Self {
            session: Mutex::new(session),
            input_width: 640,
            input_height: 640,
            num_classes: coco::NUM_CLASSES,
            confidence_threshold,
            iou_threshold,
            detection_counter: std::sync::atomic::AtomicU64::new(0),
            backend_name,
        })
    }

    /// Create ONNX session with platform-specific execution providers
    #[cfg(target_os = "linux")]
    fn create_session(model_path: &str) -> Result<(Session, String), String> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Prefer TensorRT when available, then fall back to CUDA, then CPU.
            let trt_available = TensorRTExecutionProvider::default()
                .is_available()
                .unwrap_or(false);
            if trt_available {
                log::info!("ONNX: TensorRT execution provider available, attempting to use it");

                // Configure TensorRT EP with a reasonable default for interactive use.
                // Engine caching avoids rebuilding on every launch when a writable cache
                // directory is available.
                let mut trt_ep = TensorRTExecutionProvider::default()
                    .with_fp16(true)
                    .with_int8(false)
                    .with_engine_cache(false);

                if let Some(cache_dir) = path::tensorrt_engine_cache_dir() {
                    trt_ep = trt_ep
                        .with_engine_cache(true)
                        .with_engine_cache_path(cache_dir.to_string_lossy().to_string());
                }

                match Session::builder()
                    .map_err(|e| format!("Failed to create session builder: {}", e))?
                    .with_execution_providers([trt_ep.build()])
                    .map_err(|e| format!("Failed to set execution providers: {}", e))?
                    .commit_from_file(model_path)
                {
                    Ok(session) => return Ok((session, "ONNX Runtime (TensorRT)".to_string())),
                    Err(e) => {
                        log::warn!(
                            "ONNX: Failed to use TensorRT EP (falling back to CUDA/CPU): {}",
                            e
                        );
                    }
                }
            }

            let cuda_available = CUDAExecutionProvider::default()
                .is_available()
                .unwrap_or(false);

            if cuda_available {
                log::info!("ONNX: CUDA execution provider available, attempting to use it");

                match Session::builder()
                    .map_err(|e| format!("Failed to create session builder: {}", e))?
                    .with_execution_providers([CUDAExecutionProvider::default().build()])
                    .map_err(|e| format!("Failed to set execution providers: {}", e))?
                    .commit_from_file(model_path)
                {
                    Ok(session) => return Ok((session, "ONNX Runtime (CUDA)".to_string())),
                    Err(e) => {
                        log::warn!("ONNX: Failed to use CUDA EP (falling back to CPU): {}", e);
                    }
                }
            }

            log::info!("ONNX: Using CPU execution provider");
            let session = Session::builder()
                .map_err(|e| format!("Failed to create session builder: {}", e))?
                .commit_from_file(model_path)
                .map_err(|e| format!("Failed to load model: {}", e))?;
            Ok((session, "ONNX Runtime (CPU)".to_string()))
        }));

        match result {
            Ok(inner) => inner,
            Err(_) => Err(
                "ONNX Runtime panicked while initializing (check ORT_DYLIB_PATH/LD_LIBRARY_PATH and NVIDIA driver libraries)".to_string(),
            ),
        }
    }

    /// Create ONNX session with CoreML on macOS
    #[cfg(target_os = "macos")]
    fn create_session(model_path: &str) -> Result<(Session, String), String> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Try CoreML first (uses Neural Engine on Apple Silicon), fall back to CPU.
            let coreml_available = CoreMLExecutionProvider::default()
                .is_available()
                .unwrap_or(false);

            if coreml_available {
                log::info!("ONNX: CoreML execution provider available, using Neural Engine/GPU");
                match Session::builder()
                    .map_err(|e| format!("Failed to create session builder: {}", e))?
                    .with_execution_providers([CoreMLExecutionProvider::default().build()])
                    .map_err(|e| format!("Failed to set execution providers: {}", e))?
                    .commit_from_file(model_path)
                {
                    Ok(session) => return Ok((session, "ONNX Runtime (CoreML)".to_string())),
                    Err(e) => {
                        log::warn!("ONNX: Failed to use CoreML EP (falling back to CPU): {}", e);
                    }
                }
            }

            log::info!("ONNX: Using CPU execution provider");
            let session = Session::builder()
                .map_err(|e| format!("Failed to create session builder: {}", e))?
                .commit_from_file(model_path)
                .map_err(|e| format!("Failed to load model: {}", e))?;
            Ok((session, "ONNX Runtime (CPU)".to_string()))
        }));

        match result {
            Ok(inner) => inner,
            Err(_) => Err(
                "ONNX Runtime panicked while initializing (check ORT_DYLIB_PATH/LD_LIBRARY_PATH)"
                    .to_string(),
            ),
        }
    }

    /// Fallback for other platforms
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn create_session(model_path: &str) -> Result<(Session, String), String> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            log::info!("ONNX: Using CPU execution provider");
            let session = Session::builder()
                .map_err(|e| format!("Failed to create session builder: {}", e))?
                .commit_from_file(model_path)
                .map_err(|e| format!("Failed to load model: {}", e))?;
            Ok((session, "ONNX Runtime (CPU)".to_string()))
        }));

        match result {
            Ok(inner) => inner,
            Err(_) => Err(
                "ONNX Runtime panicked while initializing (check ORT_DYLIB_PATH/LD_LIBRARY_PATH)"
                    .to_string(),
            ),
        }
    }

    /// Preprocess RGBA image to NCHW float tensor
    fn preprocess(&self, rgba_data: &[u8], width: u32, height: u32) -> Vec<f32> {
        let target_w = self.input_width as usize;
        let target_h = self.input_height as usize;
        let src_w = width as usize;
        let src_h = height as usize;

        let mut output = vec![0.0f32; 3 * target_h * target_w];

        // Bilinear resize and normalize
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

                // Channel offsets for NCHW layout (batch=1, channels=3)
                let channel_stride = target_h * target_w;
                let pixel_offset = y * target_w + x;
                output[pixel_offset] = r; // Channel 0 (R)
                output[channel_stride + pixel_offset] = g; // Channel 1 (G)
                output[2 * channel_stride + pixel_offset] = b; // Channel 2 (B)
            }
        }

        output
    }

    /// Run inference on RGBA pixel data
    pub fn detect(
        &self,
        rgba_data: &[u8],
        width: u32,
        height: u32,
    ) -> Result<OnnxDetectionResult, String> {
        image::validate_rgba_input_len(rgba_data.len(), width, height)?;

        // Preprocess
        let preprocess_start = Instant::now();
        let input_tensor = self.preprocess(rgba_data, width, height);
        let preprocess_time = preprocess_start.elapsed();

        // Create input tensor
        let inference_start = Instant::now();

        let input_shape = [1_i64, 3, self.input_height as i64, self.input_width as i64];
        let input = Value::from_array((input_shape, input_tensor.into_boxed_slice()))
            .map_err(|e| format!("Failed to create input tensor: {}", e))?;

        // Run inference
        let mut session = self
            .session
            .lock()
            .map_err(|e| format!("Failed to lock session: {}", e))?;
        let outputs = session
            .run(ort::inputs![input])
            .map_err(|e| format!("Inference failed: {}", e))?;

        let inference_time = inference_start.elapsed();

        // Postprocess
        let postprocess_start = Instant::now();

        // YOLOv8 output is typically either:
        // - [1, 84, N] where 84 = 4 (box) + 80 (classes)
        // - [1, N, 84]
        // Get first output tensor
        let output = outputs.iter().next().ok_or("No output tensor found")?.1;

        let (shape, output_data) = output
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract output tensor: {}", e))?;

        let shape_dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        let (layout, num_anchors) = yolo::infer_yolov8_output_layout(&shape_dims)?;
        yolo::validate_yolov8_output_len(layout, num_anchors, output_data.len())?;

        // Pre-allocate with reasonable capacity to avoid reallocations
        // Typical YOLO models produce 100-500 raw detections before NMS
        let mut detections = Vec::with_capacity(256);
        let img_w = width as f32;
        let img_h = height as f32;

        for i in 0..num_anchors {
            let (cx, cy, w, h) = yolo::read_bbox(layout, output_data, num_anchors, i)?;

            // Find best class
            let mut max_score = 0.0f32;
            let mut max_class = 0i32;
            for c in 0..self.num_classes {
                let score = yolo::read_class_score(layout, output_data, num_anchors, i, c)?;
                if score > max_score {
                    max_score = score;
                    max_class = c as i32;
                }
            }

            if max_score < self.confidence_threshold {
                continue;
            }

            // Convert to corner format and scale to image dimensions
            let x1 = ((cx - w / 2.0) * img_w / self.input_width as f32).max(0.0);
            let y1 = ((cy - h / 2.0) * img_h / self.input_height as f32).max(0.0);
            let x2 = ((cx + w / 2.0) * img_w / self.input_width as f32).min(img_w);
            let y2 = ((cy + h / 2.0) * img_h / self.input_height as f32).min(img_h);

            let det_id = self
                .detection_counter
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            detections.push(Detection {
                id: format!("DET-{:08X}", det_id),
                class_label: coco::get_class_name(max_class.max(0) as usize),
                class_index: max_class,
                confidence: max_score,
                bbox: BoundingBox { x1, y1, x2, y2 },
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64,
            });
        }

        // Apply NMS
        detections = self.nms(detections);

        let postprocess_time = postprocess_start.elapsed();

        Ok(OnnxDetectionResult {
            success: true,
            detections,
            inference_time_ms: inference_time.as_secs_f64() * 1000.0,
            preprocess_time_ms: preprocess_time.as_secs_f64() * 1000.0,
            postprocess_time_ms: postprocess_time.as_secs_f64() * 1000.0,
            backend: self.backend_name.clone(),
            error: None,
        })
    }

    /// Non-maximum suppression
    fn nms(&self, mut detections: Vec<Detection>) -> Vec<Detection> {
        // Sort by confidence (descending)
        detections.sort_by(|a, b| {
            b.confidence
                .partial_cmp(&a.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut keep = vec![true; detections.len()];

        for i in 0..detections.len() {
            if !keep[i] {
                continue;
            }

            for j in (i + 1)..detections.len() {
                if !keep[j] {
                    continue;
                }

                // Only suppress same-class detections
                if detections[i].class_index != detections[j].class_index {
                    continue;
                }

                let iou = self.compute_iou(&detections[i].bbox, &detections[j].bbox);
                if iou > self.iou_threshold {
                    keep[j] = false;
                }
            }
        }

        detections
            .into_iter()
            .enumerate()
            .filter(|(i, _)| keep[*i])
            .map(|(_, d)| d)
            .collect()
    }

    /// Compute IoU between two bounding boxes
    fn compute_iou(&self, a: &BoundingBox, b: &BoundingBox) -> f32 {
        let inter_x1 = a.x1.max(b.x1);
        let inter_y1 = a.y1.max(b.y1);
        let inter_x2 = a.x2.min(b.x2);
        let inter_y2 = a.y2.min(b.y2);

        let inter_w = (inter_x2 - inter_x1).max(0.0);
        let inter_h = (inter_y2 - inter_y1).max(0.0);
        let inter_area = inter_w * inter_h;

        let area_a = (a.x2 - a.x1) * (a.y2 - a.y1);
        let area_b = (b.x2 - b.x1) * (b.y2 - b.y1);
        let union_area = area_a + area_b - inter_area;

        if union_area <= 0.0 {
            0.0
        } else {
            inter_area / union_area
        }
    }

    /// Get backend name
    pub fn get_backend_name(&self) -> &str {
        &self.backend_name
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL API (Cross-platform)
// ─────────────────────────────────────────────────────────────────────────────

/// Find ONNX model path (cross-platform)
fn find_onnx_model_path() -> Option<PathBuf> {
    use crate::common::path::validate_model_path;

    // Check environment variable first (highest priority)
    // Security: validate path to prevent traversal attacks
    if let Ok(custom_path) = std::env::var("CREBAIN_ONNX_MODEL") {
        match validate_model_path(&custom_path, Some(&["onnx"])) {
            Ok(path) => return Some(path),
            Err(e) => log::warn!("[ONNX] Invalid CREBAIN_ONNX_MODEL path: {}", e),
        }
    }

    // Also check CREBAIN_MODEL_PATH for compatibility
    if let Ok(custom_path) = std::env::var("CREBAIN_MODEL_PATH") {
        match validate_model_path(&custom_path, Some(&["onnx"])) {
            Ok(path) => return Some(path),
            Err(e) => log::warn!("[ONNX] Invalid CREBAIN_MODEL_PATH: {}", e),
        }
    }

    let mut possible_paths: Vec<Option<PathBuf>> = vec![
        // Bundled in app resources (macOS .app bundle)
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.join("../Resources/yolov8s.onnx"))),
        // Nix-style install layout: $out/bin/<exe> and $out/share/crebain/models/yolov8s.onnx
        std::env::current_exe().ok().and_then(|p| {
            p.parent()
                .map(|p| p.join("../share/crebain/models/yolov8s.onnx"))
        }),
        // Development paths
        std::env::current_dir()
            .ok()
            .map(|p| p.join("src-tauri/resources/yolov8s.onnx")),
        std::env::current_dir()
            .ok()
            .map(|p| p.join("resources/yolov8s.onnx")),
    ];

    // Add platform-specific paths
    #[cfg(target_os = "linux")]
    {
        possible_paths.push(Some(PathBuf::from(
            "/usr/share/crebain/models/yolov8s.onnx",
        )));
        possible_paths.push(Some(PathBuf::from("/opt/crebain/models/yolov8s.onnx")));
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            possible_paths.push(Some(PathBuf::from(format!(
                "{}/Library/Application Support/crebain/models/yolov8s.onnx",
                home
            ))));
        }
        possible_paths.push(Some(PathBuf::from(
            "/usr/local/share/crebain/models/yolov8s.onnx",
        )));
    }

    possible_paths.into_iter().flatten().find(|p| p.exists())
}

/// Initialize the global ONNX detector
pub fn init_global_detector() -> Result<(), String> {
    let init_result = DETECTOR.get_or_init(|| {
        let model_path = match find_onnx_model_path() {
            Some(p) => p,
            None => {
                let msg = "ONNX model not found (set CREBAIN_ONNX_MODEL or place yolov8s.onnx in src-tauri/resources)"
                    .to_string();
                log::warn!("[ONNX] {}", msg);
                return Err(msg);
            }
        };

        log::info!("ONNX: Loading model from {:?}", model_path);

        OnnxDetector::new(&model_path.to_string_lossy(), 0.25, 0.45).map_err(|e| {
            let msg = format!("ONNX detector init failed: {}", e);
            log::error!("[ONNX] {}", msg);
            msg
        })
    });

    match init_result {
        Ok(_) => Ok(()),
        Err(e) => Err(e.clone()),
    }
}

/// Get the global ONNX detector
pub fn get_global_detector() -> Option<&'static OnnxDetector> {
    DETECTOR.get().and_then(|res| res.as_ref().ok())
}

/// Run detection using the global ONNX detector
pub fn detect_with_onnx(
    pixels: &[u8],
    width: u32,
    height: u32,
) -> Result<OnnxDetectionResult, String> {
    match DETECTOR.get() {
        Some(Ok(detector)) => detector.detect(pixels, width, height),
        Some(Err(e)) => Err(e.clone()),
        None => Err("ONNX detector not initialized".to_string()),
    }
}

/// Check if ONNX detector is available
pub fn is_onnx_detector_ready() -> bool {
    get_global_detector().is_some()
}

/// Get info about the ONNX detector
pub fn get_onnx_detector_info() -> serde_json::Value {
    #[cfg(target_os = "linux")]
    let providers = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        serde_json::json!({
            "cuda": CUDAExecutionProvider::default().is_available().unwrap_or(false),
            "tensorrt": TensorRTExecutionProvider::default().is_available().unwrap_or(false),
        })
    }))
    .unwrap_or_else(|_| serde_json::json!({ "error": "ORT panic while probing providers" }));

    #[cfg(target_os = "macos")]
    let providers = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        serde_json::json!({
            "coreml": CoreMLExecutionProvider::default().is_available().unwrap_or(false),
        })
    }))
    .unwrap_or_else(|_| serde_json::json!({ "error": "ORT panic while probing providers" }));

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let providers = serde_json::json!({});

    match DETECTOR.get() {
        Some(Ok(detector)) => serde_json::json!({
            "available": true,
            "ready": true,
            "backend": detector.get_backend_name(),
            "providers": providers,
        }),
        Some(Err(e)) => serde_json::json!({
            "available": true,
            "ready": false,
            "backend": "Init Failed",
            "providers": providers,
            "error": e,
        }),
        None => serde_json::json!({
            "available": true,
            "ready": false,
            "backend": "Not Loaded",
            "providers": providers,
        }),
    }
}
