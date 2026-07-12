//! CREBAIN Tauri Backend
//! Adaptive Response & Awareness System (ARAS)
//!
//! Cross-platform native backend with multiple ML inference backends:
//! - macOS: CoreML via direct FFI (Neural Engine/Metal/GPU)
//! - Linux/Windows: ONNX Runtime with CUDA/TensorRT/CPU

// Core modules
pub mod common;
mod coreml;
mod onnx_detector;
pub mod pid_observation;
mod sensor_fusion;

// Inference backends (conditional compilation)
pub mod inference;
pub mod transport;

// Neuro-Cybernetic Protocol client (Engram) — opt-in via the `ncp`
// feature. Self-contained; does not alter the default command surface.
#[cfg(feature = "ncp")]
pub mod ncp;

use coreml::DetectionResult;
use sensor_fusion::{
    validate_fusion_config, validate_sensor_measurements, FusionConfig, FusionStats,
    MultiSensorFusion, SensorMeasurement, TrackOutput,
};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use std::sync::Once;
use std::sync::{LazyLock, Mutex};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
static INIT: Once = Once::new();

// Global sensor fusion engine (thread-safe)
static FUSION_ENGINE: LazyLock<Mutex<Option<MultiSensorFusion>>> =
    LazyLock::new(|| Mutex::new(None));
static NATIVE_DETECTION_ID: AtomicU64 = AtomicU64::new(0);

#[cfg(any(target_os = "macos", test))]
fn should_initialize_coreml(
    configured_backend: inference::Result<Option<inference::Backend>>,
) -> bool {
    matches!(
        configured_backend,
        Ok(None | Some(inference::Backend::CoreML))
    )
}

/// Initialize the native CoreML detector on app startup (macOS only)
#[cfg(target_os = "macos")]
fn init_coreml_detector(app: &tauri::App) {
    INIT.call_once(|| {
        // Try multiple model paths in order of preference
        let mut possible_paths: Vec<Option<std::path::PathBuf>> = vec![
            // Bundled resource path (production)
            app.path()
                .resource_dir()
                .map(|p| p.join("resources/yolov8s.mlmodelc"))
                .ok(),
            // Development path (relative to project root)
            std::env::current_dir()
                .map(|p| p.join("src-tauri/resources/yolov8s.mlmodelc"))
                .ok(),
        ];

        // Add user-specified model path from environment variable (for custom deployments)
        // Security: validate path to prevent traversal attacks
        if let Ok(custom_path) = std::env::var("CREBAIN_MODEL_PATH") {
            match common::path::validate_model_path(&custom_path, Some(&["mlmodelc"])) {
                Ok(validated_path) => {
                    possible_paths.insert(0, Some(validated_path));
                }
                Err(e) => {
                    log::warn!("Invalid CREBAIN_MODEL_PATH: {}", e);
                }
            }
        }

        for path_opt in possible_paths.into_iter().flatten() {
            if path_opt.exists() {
                let path_str = path_opt.to_string_lossy().to_string();
                log::info!(
                    "Initializing native CoreML detector with model: {}",
                    path_str
                );

                match coreml::init_detector(&path_str) {
                    Ok(()) => {
                        log::info!("Native CoreML detector initialized successfully");
                        return;
                    }
                    Err(e) => {
                        log::warn!("Failed to init CoreML with {}: {}", path_str, e);
                    }
                }
            }
        }

        log::error!("Could not find CoreML model at any expected path");
    });
}

/// Run CoreML detection on an image - NATIVE FFI (zero subprocess overhead)
#[tauri::command]
async fn detect_coreml(
    image_base64: String,
    confidence_threshold: Option<f64>,
    _iou_threshold: Option<f64>,
    max_detections: Option<i32>,
) -> Result<DetectionResult, String> {
    // Validate inputs
    common::image::validate_base64_image_len(image_base64.len())?;

    let conf = confidence_threshold.unwrap_or(0.25).clamp(0.0, 1.0);
    let max_det = max_detections.unwrap_or(100).clamp(1, 1000) as usize;

    // Spawn blocking task to avoid blocking the async runtime
    tauri::async_runtime::spawn_blocking(move || {
        coreml::detect_base64(&image_base64, conf, max_det)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Maximum allowed image dimension (8K resolution)
#[cfg(test)]
const MAX_IMAGE_DIMENSION: u32 = common::image::MAX_IMAGE_DIMENSION;
/// Maximum allowed image size in bytes (64MB)
#[cfg(test)]
const MAX_IMAGE_SIZE_BYTES: usize = common::image::MAX_IMAGE_SIZE_BYTES;
/// Maximum allowed serialized scene state size (10MB).
const MAX_SCENE_STATE_BYTES: usize = 10 * 1024 * 1024;
const CURRENT_SCENE_VERSION: &str = "1.0.0";

fn validate_rgba_input_len(rgba_len: usize, width: u32, height: u32) -> Result<usize, String> {
    common::image::validate_rgba_input_len(rgba_len, width, height)
}

fn validate_scene_file_path(
    path: &str,
    allowed_root: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let validated = common::path::validate_path(path, Some(allowed_root))?;
    match validated.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("json") => Ok(validated),
        _ => Err("Scene file path must end with .json".to_string()),
    }
}

fn migrate_scene_json(mut value: serde_json::Value) -> Result<serde_json::Value, String> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Scene JSON must be an object".to_string())?;

    match object.get("version").and_then(|version| version.as_str()) {
        Some(CURRENT_SCENE_VERSION) => {}
        Some("0.4.0" | "0.5.0") | None => {
            object.insert(
                "version".to_string(),
                serde_json::Value::String(CURRENT_SCENE_VERSION.to_string()),
            );
        }
        Some(version) => {
            return Err(format!("Unsupported scene version: {}", version));
        }
    }

    if !object.get("name").is_some_and(|name| name.is_string()) {
        return Err("Scene JSON must include a string name".to_string());
    }
    if !object
        .get("timestamp")
        .is_some_and(|timestamp| timestamp.is_number())
    {
        object.insert(
            "timestamp".to_string(),
            serde_json::Value::Number(serde_json::Number::from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            )),
        );
    }

    for key in [
        "cameras",
        "assets",
        "drones",
        "annotations",
        "recentDetections",
    ] {
        if !object.get(key).is_some_and(|entry| entry.is_array()) {
            object.insert(key.to_string(), serde_json::Value::Array(Vec::new()));
        }
    }

    if !object
        .get("settings")
        .is_some_and(|entry| entry.is_object())
    {
        object.insert(
            "settings".to_string(),
            serde_json::json!({
                "detectionEnabled": true,
                "showDetectionPanel": true,
                "showPerformancePanel": true,
                "renderQuality": "high",
                "physicsEnabled": true,
                "sensorSimulationEnabled": true
            }),
        );
    }
    if !object
        .get("viewCamera")
        .is_some_and(|entry| entry.is_object())
    {
        object.insert(
            "viewCamera".to_string(),
            serde_json::json!({
                "position": { "x": 0.0, "y": 5.0, "z": 10.0 },
                "target": { "x": 0.0, "y": 0.0, "z": 0.0 }
            }),
        );
    }

    Ok(value)
}

fn read_scene_file_bounded(path: &std::path::Path, max_bytes: usize) -> Result<String, String> {
    use std::io::Read;

    let read_limit = u64::try_from(max_bytes)
        .map_err(|_| "Scene size limit exceeds the supported range".to_string())?
        .checked_add(1)
        .ok_or_else(|| "Scene size limit exceeds the supported range".to_string())?;
    let file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open {}: {}", path.display(), e))?;
    let mut bytes = Vec::new();
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    if bytes.len() > max_bytes {
        return Err(format!(
            "Scene file too large: exceeds maximum {} bytes",
            max_bytes
        ));
    }

    String::from_utf8(bytes)
        .map_err(|e| format!("Scene file {} is not valid UTF-8: {}", path.display(), e))
}

#[cfg(unix)]
fn sync_directory(path: &std::path::Path) -> Result<(), String> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| format!("Failed to sync directory {}: {}", path.display(), e))
}

#[cfg(not(unix))]
fn sync_directory(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

fn persist_scene_contents_atomically(
    path: &std::path::Path,
    contents: &[u8],
) -> Result<(), String> {
    use std::io::Write;

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            format!(
                "Invalid scene path: {} has no parent directory",
                path.display()
            )
        })?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;

    let mut temporary = tempfile::Builder::new()
        .prefix(".crebain-scene-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| format!("Failed to create temporary scene file: {}", e))?;
    temporary
        .write_all(contents)
        .map_err(|e| format!("Failed to write temporary scene file: {}", e))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary scene file: {}", e))?;

    temporary.persist(path).map_err(|e| {
        format!(
            "Failed to atomically replace {}: {}",
            path.display(),
            e.error
        )
    })?;
    sync_directory(parent)
}

/// Run CoreML detection on raw RGBA data.
#[tauri::command]
async fn detect_coreml_raw(
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
    confidence_threshold: Option<f64>,
    max_detections: Option<i32>,
) -> Result<DetectionResult, String> {
    validate_rgba_input_len(rgba_data.len(), width, height)?;

    let conf = confidence_threshold.unwrap_or(0.25).clamp(0.0, 1.0);
    let max_det = max_detections.unwrap_or(100).clamp(1, 1000) as usize;

    // Spawn blocking task
    tauri::async_runtime::spawn_blocking(move || {
        coreml::detect_raw(&rgba_data, width, height, conf, max_det)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeBoundingBox {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDetection {
    id: String,
    class_label: String,
    class_index: u32,
    confidence: f32,
    bbox: NativeBoundingBox,
    timestamp: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDetectionResponse {
    success: bool,
    detections: Vec<NativeDetection>,
    inference_time_ms: f64,
    preprocess_time_ms: Option<f64>,
    postprocess_time_ms: Option<f64>,
    backend: String,
    error: Option<String>,
}

impl NativeDetectionResponse {
    fn failure(backend: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            success: false,
            detections: Vec::new(),
            inference_time_ms: 0.0,
            preprocess_time_ms: None,
            postprocess_time_ms: None,
            backend: backend.into(),
            error: Some(error.into()),
        }
    }
}

fn unix_timestamp_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn execute_native_detection(
    runtime: &inference::DetectorRuntime,
    rgba_data: &[u8],
    width: u32,
    height: u32,
    policy: inference::DetectionPolicy,
) -> NativeDetectionResponse {
    match runtime.detect(rgba_data, width, height, policy) {
        Ok(output) => {
            let timestamp = unix_timestamp_millis();
            let backend = output.backend_name;
            let detections = output
                .detections
                .into_iter()
                .map(|detection| {
                    let id = NATIVE_DETECTION_ID.fetch_add(1, Ordering::Relaxed);
                    NativeDetection {
                        id: format!("native-{timestamp}-{id}"),
                        class_label: detection.class_label,
                        class_index: detection.class_id,
                        confidence: detection.confidence,
                        bbox: NativeBoundingBox {
                            x1: detection.bbox[0],
                            y1: detection.bbox[1],
                            x2: detection.bbox[2],
                            y2: detection.bbox[3],
                        },
                        timestamp,
                    }
                })
                .collect();

            NativeDetectionResponse {
                success: true,
                detections,
                inference_time_ms: output.inference_time_ms,
                preprocess_time_ms: None,
                postprocess_time_ms: None,
                backend,
                error: None,
            }
        }
        Err(error) => {
            let backend = runtime.snapshot().active_backend.map_or_else(
                || "Inference Runtime".to_string(),
                |backend| backend.to_string(),
            );
            NativeDetectionResponse::failure(backend, error.to_string())
        }
    }
}

/// Run detection using the persistent factory-selected native backend.
#[tauri::command]
async fn detect_native_raw(
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
    confidence_threshold: Option<f64>,
    iou_threshold: Option<f64>,
    max_detections: Option<i32>,
) -> Result<NativeDetectionResponse, String> {
    validate_rgba_input_len(rgba_data.len(), width, height)?;

    let confidence = confidence_threshold
        .unwrap_or(f64::from(inference::BACKEND_MIN_CONFIDENCE_THRESHOLD))
        as f32;
    let iou = iou_threshold.unwrap_or(f64::from(inference::BACKEND_MAX_IOU_THRESHOLD)) as f32;
    let max_det =
        usize::try_from(max_detections.unwrap_or(inference::BACKEND_MAX_DETECTIONS as i32))
            .map_err(|_| "max detections must be a positive integer".to_string())?;
    let policy = inference::DetectionPolicy::new(confidence, iou, max_det)
        .map_err(|error| error.to_string())?;

    let task = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            execute_native_detection(
                inference::production_runtime(),
                &rgba_data,
                width,
                height,
                policy,
            )
        }))
        .unwrap_or_else(|_| {
            NativeDetectionResponse::failure(
                "Inference Runtime",
                "native detector panicked while processing the frame",
            )
        })
    })
    .await;

    Ok(task.unwrap_or_else(|error| {
        NativeDetectionResponse::failure(
            "Inference Runtime",
            format!("native detector task failed: {error}"),
        )
    }))
}

/// Run detection using ONNX Runtime (Linux primary backend)
#[tauri::command]
async fn detect_onnx(
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<onnx_detector::OnnxDetectionResult, String> {
    validate_rgba_input_len(rgba_data.len(), width, height)?;

    // Spawn blocking task
    tauri::async_runtime::spawn_blocking(move || {
        onnx_detector::detect_with_onnx(&rgba_data, width, height)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Get system info including detector availability
#[tauri::command]
fn get_system_info() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    let platform = "macos";
    #[cfg(target_os = "linux")]
    let platform = "linux";
    #[cfg(target_os = "windows")]
    let platform = "windows";
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let platform = "unknown";

    #[cfg(target_os = "macos")]
    let coreml_available = coreml::NativeCoreMLDetector::get_global().is_some();
    #[cfg(not(target_os = "macos"))]
    let coreml_available = false;

    let onnx_info = onnx_detector::get_onnx_detector_info();

    let fusion_info = FUSION_ENGINE
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|f| f.get_stats()));
    let runtime_snapshot = inference::production_runtime().snapshot();
    let (configured_backend, configuration_error) = match inference::configured_backend() {
        Ok(backend) => (backend.map(|backend| backend.to_string()), None),
        Err(error) => (None, Some(error.to_string())),
    };
    let candidate_backends: Vec<String> = inference::available_backends()
        .iter()
        .map(|backend| backend.to_string())
        .collect();

    let backend = runtime_snapshot
        .stats
        .as_ref()
        .map(|stats| stats.backend.clone())
        .filter(|backend| !backend.is_empty())
        .or_else(|| {
            runtime_snapshot
                .active_backend
                .map(|backend| backend.to_string())
        })
        .unwrap_or_else(|| match runtime_snapshot.status {
            inference::RuntimeStatus::Uninitialized => "Not Initialized".to_string(),
            inference::RuntimeStatus::Failed => "No Backend Available".to_string(),
            inference::RuntimeStatus::Ready => "Unknown Backend".to_string(),
        });

    let runtime_ready = runtime_snapshot.status == inference::RuntimeStatus::Ready;
    let runtime_error = runtime_snapshot.initialization_error.clone();

    let model_ready_backends: Vec<String> = if runtime_ready {
        runtime_snapshot
            .active_backend
            .iter()
            .map(ToString::to_string)
            .collect()
    } else {
        Vec::new()
    };

    serde_json::json!({
        "platform": platform,
        "arch": std::env::consts::ARCH,
        "coremlAvailable": coreml_available,
        "onnxAvailable": onnx_detector::is_onnx_detector_ready(),
        "backend": backend,
        "mode": "raw-rgba",
        "availableBackends": model_ready_backends,
        "candidateBackends": candidate_backends,
        "configuredBackend": configured_backend,
        "backendConfigurationError": configuration_error,
        "inferenceReady": runtime_ready,
        "inferenceInitializationError": runtime_error,
        "inferenceRuntime": runtime_snapshot,
        "experimentalMlxEnabled": inference::experimental_mlx_enabled(),
        "onnxDetector": onnx_info,
        "sensorFusion": fusion_info
    })
}

/// Save a scene state JSON file to disk (Tauri only).
///
/// Frontend calls this via `invoke('scene_save_file', { path, json })`.
#[tauri::command]
async fn scene_save_file<R: tauri::Runtime>(
    path: String,
    json: String,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    if json.is_empty() {
        return Err("Empty scene JSON".to_string());
    }
    if json.len() > MAX_SCENE_STATE_BYTES {
        return Err(format!(
            "Scene JSON too large: {} bytes exceeds maximum {} bytes",
            json.len(),
            MAX_SCENE_STATE_BYTES
        ));
    }

    let scenes_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("scenes");

    std::fs::create_dir_all(&scenes_dir)
        .map_err(|e| format!("Failed to create scenes directory: {}", e))?;

    let validated_path = validate_scene_file_path(&path, &scenes_dir)?;

    tauri::async_runtime::spawn_blocking(move || {
        // Validate JSON before writing.
        let value: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| format!("Invalid scene JSON: {}", e))?;
        let value = migrate_scene_json(value)?;
        let pretty = serde_json::to_string_pretty(&value)
            .map_err(|e| format!("JSON encode error: {}", e))?;

        if pretty.len() > MAX_SCENE_STATE_BYTES {
            return Err(format!(
                "Migrated scene JSON too large: {} bytes exceeds maximum {} bytes",
                pretty.len(),
                MAX_SCENE_STATE_BYTES
            ));
        }

        persist_scene_contents_atomically(&validated_path, pretty.as_bytes())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Load a scene state JSON file from disk (Tauri only).
///
/// Frontend calls this via `invoke<string>('scene_load_file', { path })`.
#[tauri::command]
async fn scene_load_file<R: tauri::Runtime>(
    path: String,
    app: tauri::AppHandle<R>,
) -> Result<String, String> {
    let scenes_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("scenes");

    // Ensure the scenes directory exists
    std::fs::create_dir_all(&scenes_dir)
        .map_err(|e| format!("Failed to create scenes directory: {}", e))?;

    let validated_path = validate_scene_file_path(&path, &scenes_dir)?;

    tauri::async_runtime::spawn_blocking(move || {
        let contents = read_scene_file_bounded(&validated_path, MAX_SCENE_STATE_BYTES)?;

        // Validate JSON so callers get consistent errors.
        let value: serde_json::Value =
            serde_json::from_str(&contents).map_err(|e| format!("Invalid scene JSON: {}", e))?;
        let value = migrate_scene_json(value)?;

        serde_json::to_string_pretty(&value).map_err(|e| format!("JSON encode error: {}", e))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ═══════════════════════════════════════════════════════════════════════════════
// SENSOR FUSION COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

/// Initialize the sensor fusion engine with configuration
#[tauri::command]
fn fusion_init(config: Option<FusionConfig>) -> Result<(), String> {
    let cfg = config.unwrap_or_default();
    validate_fusion_config(&cfg)?;
    let mut cfg = cfg;
    // CREBAIN_PID_JSONL turns on the galadriel innovation sidecar without a
    // frontend config round-trip: emission on, records streamed as JSONL to the
    // given path (directly consumable by galadriel-ncp's read_jsonl). The file is
    // truncated at process start — one file holds exactly one producer epoch.
    if std::env::var_os("CREBAIN_PID_JSONL").is_some() {
        cfg.emit_innovations = true;
    }
    let fusion = MultiSensorFusion::new(cfg);

    let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;
    *guard = Some(fusion);

    log::info!("Sensor fusion engine initialized");
    Ok(())
}

/// JSONL sink for the galadriel innovation sidecar (`CREBAIN_PID_JSONL`).
/// Best-effort instrumentation: write failures are logged and do not fail the
/// fusion result. Callers release `FUSION_ENGINE` before invoking this sink.
static PID_JSONL_SINK: LazyLock<Mutex<Option<std::io::BufWriter<std::fs::File>>>> =
    LazyLock::new(|| {
        let Some(path) = std::env::var_os("CREBAIN_PID_JSONL") else {
            return Mutex::new(None);
        };
        // One JSONL file = ONE producer epoch: galadriel's `read_jsonl` enforces
        // strictly increasing per-(track, modality) sequences, so records left over
        // from a previous crebain run (whose frame counter restarted) would poison
        // the whole file at parse time. Truncate at the first open of this process;
        // within the run every write appends through this single BufWriter. Point
        // CREBAIN_PID_JSONL at a fresh path per run to keep earlier captures.
        let writer = match std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
        {
            Ok(file) => Some(std::io::BufWriter::new(file)),
            Err(err) => {
                log::warn!("[pid-jsonl] cannot open {path:?}: {err}");
                None
            }
        };
        Mutex::new(writer)
    });

fn append_pid_observations(records: Vec<pid_observation::PidObservation>) {
    if records.is_empty() {
        return;
    }
    use std::io::Write;
    let Ok(mut guard) = PID_JSONL_SINK.lock() else {
        return;
    };
    let Some(writer) = guard.as_mut() else {
        return; // env var unset, or the file failed to open (warned once)
    };
    for record in &records {
        match serde_json::to_string(record) {
            Ok(line) => {
                if let Err(err) = writeln!(writer, "{line}") {
                    log::warn!("[pid-jsonl] write failed: {err}");
                    return;
                }
            }
            Err(err) => log::warn!("[pid-jsonl] serialize failed: {err}"),
        }
    }
    if let Err(err) = writer.flush() {
        log::warn!("[pid-jsonl] flush failed: {err}");
    }
}

fn process_fusion_batch_with_sink<F>(
    measurements: Vec<SensorMeasurement>,
    timestamp_ms: u64,
    sink: F,
) -> Result<Vec<TrackOutput>, String>
where
    F: FnOnce(Vec<pid_observation::PidObservation>),
{
    let (tracks, records) = {
        let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;
        let fusion = guard.as_mut().ok_or("Fusion engine not initialized")?;
        let tracks = fusion.process_measurements(measurements, timestamp_ms);
        let records = fusion.drain_pid_observations();
        (tracks, records)
    };

    sink(records);
    Ok(tracks)
}

/// Process sensor measurements and return fused tracks.
/// Uses `spawn_blocking` to avoid blocking the async runtime for fusion and sidecar I/O.
#[tauri::command]
async fn fusion_process(
    measurements: Vec<SensorMeasurement>,
    timestamp_ms: u64,
) -> Result<Vec<TrackOutput>, String> {
    validate_sensor_measurements(&measurements)?;
    tauri::async_runtime::spawn_blocking(move || {
        process_fusion_batch_with_sink(measurements, timestamp_ms, append_pid_observations)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Get current tracks without processing new measurements
#[tauri::command]
fn fusion_get_tracks() -> Result<Vec<TrackOutput>, String> {
    let guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;

    let fusion = guard.as_ref().ok_or("Fusion engine not initialized")?;
    Ok(fusion.get_tracks())
}

/// Get fusion statistics
#[tauri::command]
fn fusion_get_stats() -> Result<FusionStats, String> {
    let guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;

    let fusion = guard.as_ref().ok_or("Fusion engine not initialized")?;
    Ok(fusion.get_stats())
}

/// Update fusion configuration
#[tauri::command]
fn fusion_set_config(config: FusionConfig) -> Result<(), String> {
    validate_fusion_config(&config)?;
    let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;

    let fusion = guard.as_mut().ok_or("Fusion engine not initialized")?;
    fusion.set_config(config);

    log::info!("Sensor fusion configuration updated");
    Ok(())
}

/// Clear all tracks
#[tauri::command]
fn fusion_clear() -> Result<(), String> {
    let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;

    let fusion = guard.as_mut().ok_or("Fusion engine not initialized")?;
    fusion.clear();

    log::info!("Sensor fusion tracks cleared");
    Ok(())
}

/// Get available filter algorithms
#[tauri::command]
fn fusion_get_algorithms() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "id": "Kalman",
            "name": "Kalman Filter",
            "description": "Standard linear Kalman filter for constant velocity motion"
        }),
        serde_json::json!({
            "id": "ExtendedKalman",
            "name": "Extended Kalman Filter (EKF)",
            "description": "Handles non-linear measurement models via linearization"
        }),
        serde_json::json!({
            "id": "UnscentedKalman",
            "name": "Unscented Kalman Filter (UKF)",
            "description": "Sigma-point filter for highly non-linear systems"
        }),
        serde_json::json!({
            "id": "Particle",
            "name": "Particle Filter",
            "description": "Sequential Monte Carlo for multi-modal distributions"
        }),
        serde_json::json!({
            "id": "IMM",
            "name": "Interacting Multiple Model (IMM)",
            "description": "Adaptive filter for maneuvering target tracking"
        }),
    ]
}

/// Get available sensor modalities
#[tauri::command]
fn fusion_get_modalities() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({ "id": "visual", "name": "Visual/RGB Camera", "icon": "camera" }),
        serde_json::json!({ "id": "thermal", "name": "Thermal/IR Camera", "icon": "thermometer" }),
        serde_json::json!({ "id": "acoustic", "name": "Acoustic Sensor", "icon": "audio" }),
        serde_json::json!({ "id": "radar", "name": "RADAR", "icon": "radar" }),
        serde_json::json!({ "id": "lidar", "name": "LIDAR", "icon": "scan" }),
        serde_json::json!({ "id": "radiofrequency", "name": "RF Detection", "icon": "radio" }),
    ]
}

use transport::commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_coreml,
            detect_coreml_raw,
            detect_native_raw,
            detect_onnx,
            get_system_info,
            // Scene state persistence (filesystem)
            scene_save_file,
            scene_load_file,
            // Sensor fusion commands
            fusion_init,
            fusion_process,
            fusion_get_tracks,
            fusion_get_stats,
            fusion_set_config,
            fusion_clear,
            fusion_get_algorithms,
            fusion_get_modalities,
            // Transport commands
            transport_connect,
            transport_disconnect,
            transport_subscribe_camera,
            transport_subscribe_camera_info,
            transport_subscribe_imu,
            transport_subscribe_pose,
            transport_subscribe_model_states,
            transport_unsubscribe,
            transport_publish_velocity,
            transport_publish_twist_stamped,
            transport_publish_pose,
            transport_spawn_gazebo_model,
            transport_get_stats
        ])
        .setup(|app| {
            // Initialize logging in debug mode
            #[cfg(debug_assertions)]
            {
                let log_plugin = tauri_plugin_log::Builder::new()
                    .level(log::LevelFilter::Info)
                    .build();
                app.handle().plugin(log_plugin)?;
            }

            // Resolve bundled CoreML resources before the factory selects its backend.
            #[cfg(target_os = "macos")]
            {
                if should_initialize_coreml(inference::configured_backend()) {
                    init_coreml_detector(app);
                } else {
                    log::info!(
                        "Skipping CoreML resource initialization because the backend override does not select CoreML"
                    );
                }
            }

            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            {
                log::warn!("Running on unsupported platform - limited functionality");
            }

            match inference::production_runtime().initialize() {
                Ok(backend) => {
                    log::info!("Production inference runtime ready with {backend} backend");
                }
                Err(error) => {
                    // The cached failed state makes subsequent frame requests fail closed
                    // without repeating model or TensorRT engine initialization.
                    log::error!("Production inference runtime is unavailable: {error}");
                }
            }

            // Initialize sensor fusion with default config
            let fusion = MultiSensorFusion::new(FusionConfig::default());
            if let Ok(mut guard) = FUSION_ENGINE.lock() {
                *guard = Some(fusion);
                log::info!("Sensor fusion engine initialized with EKF");
            }

            Ok(())
        })
        .menu(|handle| {
            let menu = tauri::menu::Menu::new(handle)?;

            #[cfg(target_os = "macos")]
            {
                let app_menu = tauri::menu::Submenu::new(handle, "Crebain", true)?;

                let about_item = tauri::menu::MenuItem::with_id(
                    handle,
                    "about_crebain",
                    "About Crebain",
                    true,
                    None::<&str>,
                )?;

                app_menu.append(&about_item)?;
                app_menu.append(&tauri::menu::PredefinedMenuItem::separator(handle)?)?;
                app_menu.append(&tauri::menu::PredefinedMenuItem::services(handle, None)?)?;
                app_menu.append(&tauri::menu::PredefinedMenuItem::separator(handle)?)?;
                app_menu.append(&tauri::menu::PredefinedMenuItem::hide(handle, None)?)?;
                app_menu.append(&tauri::menu::PredefinedMenuItem::hide_others(handle, None)?)?;
                app_menu.append(&tauri::menu::PredefinedMenuItem::show_all(handle, None)?)?;
                app_menu.append(&tauri::menu::PredefinedMenuItem::separator(handle)?)?;
                app_menu.append(&tauri::menu::PredefinedMenuItem::quit(handle, None)?)?;

                let file_menu = tauri::menu::Submenu::new(handle, "File", true)?;
                file_menu.append(&tauri::menu::PredefinedMenuItem::close_window(
                    handle, None,
                )?)?;

                let edit_menu = tauri::menu::Submenu::new(handle, "Edit", true)?;
                edit_menu.append(&tauri::menu::PredefinedMenuItem::undo(handle, None)?)?;
                edit_menu.append(&tauri::menu::PredefinedMenuItem::redo(handle, None)?)?;
                edit_menu.append(&tauri::menu::PredefinedMenuItem::separator(handle)?)?;
                edit_menu.append(&tauri::menu::PredefinedMenuItem::cut(handle, None)?)?;
                edit_menu.append(&tauri::menu::PredefinedMenuItem::copy(handle, None)?)?;
                edit_menu.append(&tauri::menu::PredefinedMenuItem::paste(handle, None)?)?;
                edit_menu.append(&tauri::menu::PredefinedMenuItem::select_all(handle, None)?)?;

                let view_menu = tauri::menu::Submenu::new(handle, "View", true)?;
                view_menu.append(&tauri::menu::PredefinedMenuItem::fullscreen(handle, None)?)?;

                let window_menu = tauri::menu::Submenu::new(handle, "Window", true)?;
                window_menu.append(&tauri::menu::PredefinedMenuItem::minimize(handle, None)?)?;

                menu.append(&app_menu)?;
                menu.append(&file_menu)?;
                menu.append(&edit_menu)?;
                menu.append(&view_menu)?;
                menu.append(&window_menu)?;
            }

            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "about_crebain" {
                let _ = app.emit("show-about", ());
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Fatal error running Tauri application: {}", e);
            std::process::exit(1);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ResponseFakeDetector;

    impl inference::Detector for ResponseFakeDetector {
        fn backend(&self) -> inference::Backend {
            inference::Backend::ONNX
        }

        fn detect(
            &self,
            _data: &[u8],
            _width: u32,
            _height: u32,
        ) -> inference::Result<Vec<inference::Detection>> {
            Ok(vec![inference::Detection {
                bbox: [0.0, 0.0, 1.0, 1.0],
                confidence: 0.9,
                class_id: 7,
                class_label: "truck".to_string(),
            }])
        }
    }

    #[test]
    fn validate_rgba_input_len_accepts_exact_size() {
        let expected = validate_rgba_input_len(16, 2, 2).unwrap();
        assert_eq!(expected, 16);
    }

    #[test]
    fn coreml_resource_initialization_only_runs_for_auto_or_coreml_selection() {
        assert_eq!(
            (
                should_initialize_coreml(Ok(None)),
                should_initialize_coreml(Ok(Some(inference::Backend::CoreML))),
                should_initialize_coreml(Ok(Some(inference::Backend::ONNX))),
                should_initialize_coreml(Err(inference::InferenceError::InvalidBackend(
                    "invalid".to_string()
                ))),
            ),
            (true, true, false, false)
        );
    }

    #[test]
    fn system_info_available_backends_only_reports_model_ready_runtime() {
        let info = get_system_info();
        let expected = if info["inferenceRuntime"]["status"] == "ready" {
            serde_json::json!([info["inferenceRuntime"]["activeBackend"].clone()])
        } else {
            serde_json::json!([])
        };

        assert_eq!(info["availableBackends"], expected);
    }

    #[test]
    fn validate_rgba_input_len_rejects_zero_dimensions() {
        let error = validate_rgba_input_len(0, 0, 1).unwrap_err();
        assert!(error.contains("width and height must be > 0"));
    }

    #[test]
    fn validate_rgba_input_len_rejects_oversized_dimensions() {
        let error = validate_rgba_input_len(0, MAX_IMAGE_DIMENSION + 1, 1).unwrap_err();
        assert!(error.contains("exceeds maximum"));
    }

    #[test]
    fn validate_rgba_input_len_rejects_mismatched_size() {
        let error = validate_rgba_input_len(15, 2, 2).unwrap_err();
        assert!(error.contains("Invalid RGBA data size"));
    }

    #[test]
    fn validate_rgba_input_len_rejects_oversized_byte_count() {
        let error = validate_rgba_input_len(
            MAX_IMAGE_SIZE_BYTES + 4,
            MAX_IMAGE_DIMENSION,
            MAX_IMAGE_DIMENSION,
        )
        .unwrap_err();
        assert!(error.contains("exceeds maximum"));
    }

    #[test]
    fn detect_native_raw_rejects_invalid_rgba_before_backend_selection() {
        let error = tauri::async_runtime::block_on(detect_native_raw(
            vec![0, 1, 2],
            1,
            1,
            None,
            None,
            None,
        ))
        .unwrap_err();

        assert!(error.contains("Invalid RGBA data size"));
    }

    #[test]
    fn detect_native_raw_rejects_nonportable_policy_before_backend_selection() {
        let error = tauri::async_runtime::block_on(detect_native_raw(
            vec![0, 0, 0, 255],
            1,
            1,
            Some(0.24),
            Some(0.45),
            Some(100),
        ))
        .unwrap_err();

        assert!(error.contains("common backend envelope starts at 0.25"));
    }

    #[test]
    fn native_detection_response_serializes_the_stable_frontend_shape() {
        let runtime = inference::DetectorRuntime::new(|| Ok(Box::new(ResponseFakeDetector)));
        let response = execute_native_detection(
            &runtime,
            &[0, 0, 0, 255],
            1,
            1,
            inference::DetectionPolicy::new(0.25, 0.45, 100).unwrap(),
        );
        let value = serde_json::to_value(response).unwrap();
        let response_keys: std::collections::BTreeSet<_> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let detection_keys: std::collections::BTreeSet<_> = value["detections"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();

        assert_eq!(
            (response_keys, detection_keys),
            (
                std::collections::BTreeSet::from([
                    "backend",
                    "detections",
                    "error",
                    "inferenceTimeMs",
                    "postprocessTimeMs",
                    "preprocessTimeMs",
                    "success",
                ]),
                std::collections::BTreeSet::from([
                    "bbox",
                    "classIndex",
                    "classLabel",
                    "confidence",
                    "id",
                    "timestamp",
                ]),
            )
        );
    }

    #[test]
    fn native_detection_failure_is_structured_and_fail_closed() {
        let runtime = inference::DetectorRuntime::new(|| {
            Err(inference::InferenceError::ModelLoadError(
                "model unavailable".to_string(),
            ))
        });

        let response = execute_native_detection(
            &runtime,
            &[0, 0, 0, 255],
            1,
            1,
            inference::DetectionPolicy::new(0.25, 0.45, 100).unwrap(),
        );

        assert_eq!(
            (
                response.success,
                response.detections.len(),
                response.backend.as_str(),
                response.error.as_deref(),
            ),
            (
                false,
                0,
                "Inference Runtime",
                Some("Model load error: model unavailable"),
            )
        );
    }

    #[test]
    fn detect_coreml_raw_rejects_zero_dimensions_before_backend_selection() {
        let error = tauri::async_runtime::block_on(detect_coreml_raw(Vec::new(), 0, 1, None, None))
            .unwrap_err();

        assert!(error.contains("width and height must be > 0"));
    }

    #[test]
    fn detect_coreml_rejects_empty_base64_before_backend_selection() {
        let error = tauri::async_runtime::block_on(detect_coreml(String::new(), None, None, None))
            .unwrap_err();

        assert!(error.contains("Empty image data"));
    }

    #[test]
    fn detect_coreml_rejects_oversized_base64_before_backend_selection() {
        let image_base64 = "A".repeat(common::image::MAX_BASE64_IMAGE_CHARS + 1);
        let error = tauri::async_runtime::block_on(detect_coreml(image_base64, None, None, None))
            .unwrap_err();

        assert!(error.contains("Base64 image data too large"));
    }

    fn test_fusion_config() -> FusionConfig {
        FusionConfig::default()
    }

    fn test_sensor_measurement() -> SensorMeasurement {
        SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: sensor_fusion::SensorModality::Visual,
            timestamp_ms: 1000,
            position: [1.0, 2.0, 3.0],
            velocity: Some([0.0, 0.0, 0.0]),
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn fusion_init_rejects_invalid_config_before_engine_creation() {
        let mut config = test_fusion_config();
        config.particle_count = sensor_fusion::MAX_FUSION_PARTICLE_COUNT + 1;

        let error = fusion_init(Some(config)).unwrap_err();

        assert!(error.contains("particle_count"));
    }

    #[test]
    fn fusion_process_rejects_non_finite_measurement_before_locking_engine() {
        let mut measurement = test_sensor_measurement();
        measurement.position[1] = f64::NAN;

        let error =
            tauri::async_runtime::block_on(fusion_process(vec![measurement], 1000)).unwrap_err();

        assert!(error.contains("position[1] must be finite"));
    }

    #[test]
    fn fusion_process_rejects_oversized_measurement_batch() {
        let measurements =
            vec![test_sensor_measurement(); sensor_fusion::MAX_FUSION_MEASUREMENTS_PER_BATCH + 1];

        let error = tauri::async_runtime::block_on(fusion_process(measurements, 1000)).unwrap_err();

        assert!(error.contains("Too many sensor measurements"));
    }

    #[test]
    fn process_fusion_batch_releases_engine_lock_before_invoking_sink() {
        fusion_init(Some(test_fusion_config())).unwrap();

        process_fusion_batch_with_sink(vec![test_sensor_measurement()], 1000, |_| {
            assert!(
                FUSION_ENGINE.try_lock().is_ok(),
                "fusion engine lock remained held while invoking the PID sink"
            );
        })
        .unwrap();
    }

    #[test]
    fn migrate_scene_json_upgrades_legacy_scene_shape() {
        let migrated = migrate_scene_json(serde_json::json!({
            "version": "0.4.0",
            "name": "Legacy Scene"
        }))
        .unwrap();

        assert_eq!(migrated["version"], CURRENT_SCENE_VERSION);
        assert!(migrated["timestamp"].is_number());
        for key in [
            "cameras",
            "assets",
            "drones",
            "annotations",
            "recentDetections",
        ] {
            assert!(migrated[key].is_array());
        }
        assert!(migrated["settings"].is_object());
        assert!(migrated["viewCamera"].is_object());
    }

    #[test]
    fn migrate_scene_json_rejects_unsupported_version() {
        let error = migrate_scene_json(serde_json::json!({
            "version": "9.9.9",
            "name": "Future Scene"
        }))
        .unwrap_err();

        assert!(error.contains("Unsupported scene version"));
    }

    #[test]
    fn validate_scene_file_path_accepts_json_under_allowed_root() {
        let root = std::env::temp_dir().join(format!("crebain-scene-path-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let scene_path = root.join("scene.json");
        std::fs::write(&scene_path, "{}").unwrap();

        let validated = validate_scene_file_path(scene_path.to_str().unwrap(), &root).unwrap();

        assert!(validated.ends_with("scene.json"));
    }

    #[test]
    fn validate_scene_file_path_rejects_non_json_extension() {
        let root = std::env::temp_dir().join(format!("crebain-scene-ext-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let scene_path = root.join("scene.txt");
        std::fs::write(&scene_path, "{}").unwrap();

        let error = validate_scene_file_path(scene_path.to_str().unwrap(), &root).unwrap_err();

        assert!(error.contains("must end with .json"));
    }

    #[test]
    fn validate_scene_file_path_rejects_traversal() {
        let root =
            std::env::temp_dir().join(format!("crebain-scene-traversal-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        let error = validate_scene_file_path("../scene.json", &root).unwrap_err();

        assert!(error.contains("traversal") || error.contains("Traversal"));
    }

    #[test]
    fn validate_scene_file_path_rejects_absolute_path_outside_allowed_root() {
        let root = std::env::temp_dir().join(format!("crebain-scene-root-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let outside =
            std::env::temp_dir().join(format!("crebain-scene-outside-{}.json", std::process::id()));
        std::fs::write(&outside, "{}").unwrap();

        let error = validate_scene_file_path(outside.to_str().unwrap(), &root).unwrap_err();

        assert!(error.contains("escapes") || error.contains("traversal"));

        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir(root);
    }

    #[test]
    fn validate_scene_file_path_rejects_null_byte() {
        let root = std::env::temp_dir();
        let error = validate_scene_file_path("/tmp/scene\0.json", &root).unwrap_err();

        assert!(error.contains("null byte"));
    }

    #[test]
    fn read_scene_file_bounded_accepts_exact_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scene.json");
        std::fs::write(&path, b"1234").unwrap();

        let contents = read_scene_file_bounded(&path, 4).unwrap();

        assert_eq!(contents, "1234");
    }

    #[test]
    fn read_scene_file_bounded_rejects_limit_plus_one() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scene.json");
        std::fs::write(&path, b"12345").unwrap();

        let error = read_scene_file_bounded(&path, 4).unwrap_err();

        assert!(error.contains("exceeds maximum 4 bytes"));
    }

    #[test]
    fn persist_scene_contents_atomically_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scene.json");
        std::fs::write(&path, b"old scene").unwrap();

        persist_scene_contents_atomically(&path, b"new scene").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new scene");
    }

    #[test]
    fn persist_scene_contents_atomically_does_not_reuse_legacy_temp_name() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scene.json");
        let legacy_temp = directory.path().join("scene.json.tmp");
        std::fs::write(&legacy_temp, b"unrelated file").unwrap();

        persist_scene_contents_atomically(&path, b"new scene").unwrap();

        assert_eq!(std::fs::read(&legacy_temp).unwrap(), b"unrelated file");
    }

    #[test]
    fn persist_scene_contents_atomically_preserves_destination_on_replace_error() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("scene.json");
        std::fs::create_dir(&destination).unwrap();
        let sentinel = destination.join("keep.txt");
        std::fs::write(&sentinel, b"original").unwrap();

        let error = persist_scene_contents_atomically(&destination, b"replacement").unwrap_err();

        assert!(error.contains("Failed to atomically replace"));
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"original");
    }

    #[test]
    fn backend_invoke_handler_lists_frontend_command_contract() {
        let source = include_str!("lib.rs");
        let handler = source
            .split("generate_handler![")
            .nth(1)
            .and_then(|tail| tail.split("])").next())
            .unwrap();

        for command in [
            "detect_native_raw",
            "get_system_info",
            "scene_save_file",
            "scene_load_file",
            "fusion_init",
            "fusion_process",
            "fusion_get_tracks",
            "fusion_get_stats",
            "fusion_set_config",
            "fusion_clear",
            "fusion_get_algorithms",
            "fusion_get_modalities",
            "transport_connect",
            "transport_disconnect",
            "transport_subscribe_camera",
            "transport_subscribe_camera_info",
            "transport_subscribe_imu",
            "transport_subscribe_pose",
            "transport_subscribe_model_states",
            "transport_unsubscribe",
            "transport_publish_velocity",
            "transport_publish_twist_stamped",
            "transport_publish_pose",
            "transport_spawn_gazebo_model",
            "transport_get_stats",
        ] {
            assert!(handler.contains(command), "missing command {command}");
        }
    }

    #[test]
    fn backend_registered_commands_have_function_sources() {
        let sources = format!(
            "{}\n{}",
            include_str!("lib.rs"),
            include_str!("transport/commands.rs")
        );
        for command in [
            "detect_native_raw",
            "scene_save_file",
            "fusion_process",
            "transport_publish_twist_stamped",
        ] {
            assert!(
                sources.contains(&format!("fn {command}")),
                "missing source function for {command}"
            );
        }
    }

    #[test]
    fn transport_commands_reject_invalid_topics() {
        // Test topic validation directly (AppHandle not available in unit tests)
        let error = transport::commands::validate_topic_for_test("/valid\0topic");
        assert!(error.is_err());
    }

    #[test]
    fn transport_commands_reject_empty_topics() {
        let error = transport::commands::validate_topic_for_test("");
        assert!(error.is_err());
    }

    #[test]
    fn transport_commands_accept_valid_topics() {
        assert!(transport::commands::validate_topic_for_test("/drone1/camera").is_ok());
        assert!(transport::commands::validate_topic_for_test("/cmd_vel").is_ok());
    }

    #[test]
    fn transport_publish_validation_rejects_invalid_message_type() {
        let error = transport::commands::validate_message_type_for_test("InvalidType");
        assert!(error.is_err());
    }

    #[test]
    fn transport_publish_validation_accepts_valid_message_type() {
        assert!(transport::commands::validate_message_type_for_test("geometry_msgs/Twist").is_ok());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // AppHandle-backed IPC integration tests (Tauri mock runtime).
    //
    // These invoke the real `#[tauri::command]` async functions through a mock
    // `AppHandle`, exercising the IPC boundary end-to-end rather than only the
    // validation helpers, and confirm that malformed payloads return structured
    // errors instead of panicking. The empty/oversized cases short-circuit
    // before any filesystem access, so they have no side effects.
    // ─────────────────────────────────────────────────────────────────────────

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock Tauri app")
    }

    #[test]
    fn scene_save_file_rejects_empty_json_via_apphandle() {
        let app = mock_app();
        let err = tauri::async_runtime::block_on(scene_save_file(
            "scene.json".to_string(),
            String::new(),
            app.handle().clone(),
        ))
        .unwrap_err();
        assert!(err.contains("Empty scene JSON"), "unexpected error: {err}");
    }

    #[test]
    fn scene_save_file_rejects_oversized_json_via_apphandle() {
        let app = mock_app();
        let oversized = "x".repeat(MAX_SCENE_STATE_BYTES + 1);
        let err = tauri::async_runtime::block_on(scene_save_file(
            "scene.json".to_string(),
            oversized,
            app.handle().clone(),
        ))
        .unwrap_err();
        assert!(err.contains("too large"), "unexpected error: {err}");
    }
}
