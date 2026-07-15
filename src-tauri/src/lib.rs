//! CREBAIN Tauri Backend
//! Adaptive Response & Awareness System (ARAS)
//!
//! Cross-platform native backend with multiple ML inference backends:
//! - macOS: CoreML via direct FFI (framework-managed device placement)
//! - Linux/Windows: ONNX Runtime with CUDA/TensorRT/CPU

// Core modules
pub mod common;
#[cfg(target_os = "macos")]
mod coreml;
#[cfg(feature = "ncp")]
mod galadriel_producer;
pub mod galadriel_registry;
mod onnx_detector;
pub mod pid_observation;
#[cfg(feature = "ncp")]
pub mod producer_monitor;
mod sensor_fusion;

// Inference backends (conditional compilation)
pub mod inference;
pub mod transport;

// Neuro-Cybernetic Protocol client (Engram) — opt-in via the `ncp`
// feature. Self-contained; does not alter the default command surface.
#[cfg(feature = "ncp")]
pub mod ncp;

use sensor_fusion::{
    validate_fusion_config, validate_sensor_measurements, FusionConfig, FusionStats,
    MultiSensorFusion, SensorMeasurement, TrackOutput,
};
#[cfg(feature = "ncp")]
use sha2::{Digest, Sha256};
#[cfg(feature = "ncp")]
use std::sync::atomic::{AtomicBool, AtomicU8};
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
#[cfg(feature = "ncp")]
static GALADRIEL_RUNTIME: LazyLock<Mutex<Option<galadriel_producer::GaladrielRuntime>>> =
    LazyLock::new(|| Mutex::new(None));
#[cfg(feature = "ncp")]
static GALADRIEL_FRAME_PIPELINE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
#[cfg(feature = "ncp")]
static GALADRIEL_LIFECYCLE: AtomicU8 = AtomicU8::new(GALADRIEL_LIFECYCLE_NEVER_ACTIVE);
static NATIVE_DETECTION_ID: AtomicU64 = AtomicU64::new(0);

#[cfg(feature = "ncp")]
const GALADRIEL_FUSION_CONFIG_PATH_ENV: &str = "CREBAIN_GALADRIEL_FUSION_CONFIG_PATH";
#[cfg(feature = "ncp")]
const MAX_GALADRIEL_FUSION_CONFIG_BYTES: usize = 64 * 1024;
#[cfg(feature = "ncp")]
const GALADRIEL_LIFECYCLE_NEVER_ACTIVE: u8 = 0;
#[cfg(feature = "ncp")]
const GALADRIEL_LIFECYCLE_ACTIVE: u8 = 1;
#[cfg(feature = "ncp")]
const GALADRIEL_LIFECYCLE_STOPPED: u8 = 2;

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

#[cfg(feature = "ncp")]
fn galadriel_system_info() -> serde_json::Value {
    let Ok(guard) = GALADRIEL_RUNTIME.lock() else {
        return serde_json::json!({
            "compiled": true,
            "enabled": false,
            "error": "runtime status lock poisoned"
        });
    };
    let Some(runtime) = guard.as_ref() else {
        return serde_json::json!({ "compiled": true, "enabled": false });
    };
    let handle = runtime.handle();
    let status = handle.status();
    serde_json::json!({
        "compiled": true,
        "enabled": true,
        "realm": handle.realm(),
        "producerId": handle.producer_id(),
        "epoch": status.epoch,
        "frameId": handle.frame_id(),
        "contextId": handle.context_id(),
        "configurationDigest": handle.configuration_digest(),
        "softwareDigest": handle.software_digest(),
        "lastFusionSeq": status.last_fusion_seq,
        "activeTrackCount": status.active_track_count,
        "degraded": status.degraded,
        "nextEventSeq": status.next_event_seq,
        "shutdownRequested": status.shutdown_requested,
        "queueDepths": {
            "observations": status.queue_depths.observations,
            "outcomes": status.queue_depths.outcomes,
            "summaries": status.queue_depths.summaries,
            "heartbeats": status.queue_depths.heartbeats
        },
        "counters": {
            "admittedObservations": status.counters.admitted_observations,
            "admittedMonitorEvents": status.counters.admitted_monitor_events,
            "publishedObservations": status.counters.published_observations,
            "publishedMonitorEvents": status.counters.published_monitor_events,
            "droppedObservations": status.counters.dropped_observations,
            "droppedMonitorEvents": status.counters.dropped_monitor_events,
            "failedObservationPublishes": status.counters.failed_observation_publishes,
            "failedMonitorPublishes": status.counters.failed_monitor_publishes
        }
    })
}

#[cfg(not(feature = "ncp"))]
fn galadriel_system_info() -> serde_json::Value {
    serde_json::json!({ "compiled": false, "enabled": false })
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
            inference::RuntimeStatus::Busy => "Inference Runtime Busy".to_string(),
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
        "sensorFusion": fusion_info,
        "galadrielProducer": galadriel_system_info()
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

fn prepared_fusion_config(mut config: FusionConfig) -> Result<FusionConfig, String> {
    if std::env::var_os("CREBAIN_PID_JSONL").is_some() {
        config.emit_innovations = true;
    }
    validate_fusion_config(&config)?;
    Ok(config)
}

#[cfg(feature = "ncp")]
fn galadriel_handle() -> Result<Option<galadriel_producer::GaladrielHandle>, String> {
    let guard = GALADRIEL_RUNTIME
        .lock()
        .map_err(|error| format!("Galadriel runtime lock poisoned: {error}"))?;
    if GALADRIEL_LIFECYCLE.load(Ordering::Acquire) == GALADRIEL_LIFECYCLE_STOPPED {
        return Err("Galadriel runtime is shutting down or stopped".to_string());
    }
    Ok(guard
        .as_ref()
        .map(galadriel_producer::GaladrielRuntime::handle))
}

#[cfg(feature = "ncp")]
fn lock_galadriel_frame_pipeline(
    handle: &galadriel_producer::GaladrielHandle,
) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    let guard = GALADRIEL_FRAME_PIPELINE.lock().map_err(|error| {
        handle.mark_degraded();
        format!("Galadriel frame pipeline lock poisoned: {error}")
    })?;
    if GALADRIEL_LIFECYCLE.load(Ordering::Acquire) == GALADRIEL_LIFECYCLE_STOPPED {
        return Err("Galadriel runtime is shutting down or stopped".to_string());
    }
    Ok(guard)
}

#[cfg(feature = "ncp")]
fn read_fusion_config_bounded(path: &std::path::Path) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let file = std::fs::File::open(path).map_err(|error| {
        format!(
            "failed to open {GALADRIEL_FUSION_CONFIG_PATH_ENV} {}: {error}",
            path.display()
        )
    })?;
    let limit = u64::try_from(MAX_GALADRIEL_FUSION_CONFIG_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).map_err(|error| {
        format!(
            "failed to read {GALADRIEL_FUSION_CONFIG_PATH_ENV} {}: {error}",
            path.display()
        )
    })?;
    if bytes.is_empty() || bytes.len() > MAX_GALADRIEL_FUSION_CONFIG_BYTES {
        return Err(format!(
            "{GALADRIEL_FUSION_CONFIG_PATH_ENV} must contain 1..={MAX_GALADRIEL_FUSION_CONFIG_BYTES} bytes"
        ));
    }
    Ok(bytes)
}

#[cfg(feature = "ncp")]
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("failed to open {} for hashing: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to hash {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(feature = "ncp")]
fn galadriel_enabled_from_env() -> Result<bool, String> {
    match std::env::var(galadriel_producer::ENABLE_ENV) {
        Err(std::env::VarError::NotPresent) => Ok(false),
        Ok(value) if value == "0" => Ok(false),
        Ok(value) if value == "1" => Ok(true),
        Ok(value) => Err(format!(
            "{} must be exactly 0 or 1, got {value:?}",
            galadriel_producer::ENABLE_ENV
        )),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!(
            "{} contains non-UTF-8 data",
            galadriel_producer::ENABLE_ENV
        )),
    }
}

#[cfg(feature = "ncp")]
fn verify_galadriel_artifact_pins(
    config: &FusionConfig,
    expected_configuration_digest: &str,
    executable: &std::path::Path,
    expected_software_digest: &str,
) -> Result<(), String> {
    let actual_configuration_digest = config.canonical_digest()?;
    if actual_configuration_digest != expected_configuration_digest {
        return Err(format!(
            "running fusion configuration digest {actual_configuration_digest} does not match {} {expected_configuration_digest}",
            galadriel_producer::CONFIGURATION_DIGEST_ENV
        ));
    }
    let actual_software_digest = sha256_file(executable)?;
    if actual_software_digest != expected_software_digest {
        return Err(format!(
            "running executable digest {actual_software_digest} does not match {} {expected_software_digest}",
            galadriel_producer::SOFTWARE_DIGEST_ENV
        ));
    }
    Ok(())
}

#[cfg(feature = "ncp")]
fn preflight_galadriel_fusion_config() -> Result<FusionConfig, String> {
    if !galadriel_enabled_from_env()? {
        return prepared_fusion_config(FusionConfig::default());
    }

    let config = match std::env::var_os(GALADRIEL_FUSION_CONFIG_PATH_ENV) {
        Some(path) => {
            let bytes = read_fusion_config_bounded(std::path::Path::new(&path))?;
            serde_json::from_slice::<FusionConfig>(&bytes).map_err(|error| {
                format!("invalid {GALADRIEL_FUSION_CONFIG_PATH_ENV} JSON: {error}")
            })?
        }
        None => FusionConfig::default(),
    };
    let config = prepared_fusion_config(config)?;
    let expected_configuration_digest = std::env::var(galadriel_producer::CONFIGURATION_DIGEST_ENV)
        .map_err(|error| {
            format!(
                "enabled deployment requires valid {}: {error}",
                galadriel_producer::CONFIGURATION_DIGEST_ENV
            )
        })?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("failed to locate running executable: {error}"))?;
    let expected_software_digest =
        std::env::var(galadriel_producer::SOFTWARE_DIGEST_ENV).map_err(|error| {
            format!(
                "enabled deployment requires valid {}: {error}",
                galadriel_producer::SOFTWARE_DIGEST_ENV
            )
        })?;
    verify_galadriel_artifact_pins(
        &config,
        &expected_configuration_digest,
        &executable,
        &expected_software_digest,
    )?;

    Ok(config)
}

#[cfg(not(feature = "ncp"))]
fn reject_galadriel_enable_without_feature() -> Result<(), String> {
    match std::env::var("CREBAIN_GALADRIEL_ENABLE") {
        Err(std::env::VarError::NotPresent) => Ok(()),
        Ok(value) if value == "0" => Ok(()),
        Ok(value) if value == "1" => Err(
            "CREBAIN_GALADRIEL_ENABLE=1 requires a build compiled with the `ncp` feature"
                .to_string(),
        ),
        Ok(value) => Err(format!(
            "CREBAIN_GALADRIEL_ENABLE must be exactly 0 or 1, got {value:?}"
        )),
        Err(std::env::VarError::NotUnicode(_)) => {
            Err("CREBAIN_GALADRIEL_ENABLE contains non-UTF-8 data".to_string())
        }
    }
}

/// Initialize the sensor fusion engine with configuration
#[tauri::command]
fn fusion_init(config: Option<FusionConfig>) -> Result<(), String> {
    #[cfg(feature = "ncp")]
    let handle = galadriel_handle()?;
    #[cfg(feature = "ncp")]
    let _pipeline_guard = handle
        .as_ref()
        .map(lock_galadriel_frame_pipeline)
        .transpose()?;
    #[cfg(feature = "ncp")]
    if let Some(handle) = handle.as_ref() {
        let initialized = FUSION_ENGINE
            .lock()
            .map_err(|error| error.to_string())?
            .is_some();
        if !initialized {
            handle.mark_degraded();
            return Err("active Galadriel deployment lost its fusion engine".to_string());
        }
        // Setup owns the epoch's one engine. Frontend initialization is an
        // idempotent readiness check only. The effective config was loaded and
        // hash-pinned before the runtime opened; UI defaults are intentionally
        // ignored because replacing the engine could both reject a valid custom
        // deployment and reuse frame/prior/track identities.
        let _ignored_ui_config = config;
        log::info!("Pinned Galadriel fusion engine is ready");
        return Ok(());
    }
    let cfg = prepared_fusion_config(config.unwrap_or_default())?;
    let fusion = MultiSensorFusion::new(cfg);

    let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;
    *guard = Some(fusion);

    log::info!("Sensor fusion engine initialized");
    Ok(())
}

/// JSONL sink for the galadriel innovation sidecar (`CREBAIN_PID_JSONL`).
///
/// Legacy, non-NCP use remains best-effort. An enabled Galadriel runtime
/// preflights the file and permanently degrades its epoch if its bounded archive
/// worker later loses a record. Callers release `FUSION_ENGINE` before invoking
/// this sink.
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

#[cfg(feature = "ncp")]
const PID_JSONL_ARCHIVE_QUEUE_CAPACITY: usize = 16;

#[cfg(feature = "ncp")]
struct PidJsonlArchive {
    sender: Option<std::sync::mpsc::SyncSender<Vec<pid_observation::PidObservation>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

#[cfg(feature = "ncp")]
static PID_JSONL_ARCHIVE: LazyLock<Mutex<Option<PidJsonlArchive>>> =
    LazyLock::new(|| Mutex::new(None));
#[cfg(feature = "ncp")]
static PID_JSONL_ARCHIVE_CLOSED: AtomicBool = AtomicBool::new(false);

fn write_pid_observations<W: std::io::Write>(
    writer: &mut W,
    records: &[pid_observation::PidObservation],
) -> Result<(), String> {
    let mut lines = Vec::with_capacity(records.len());
    for record in records {
        record.validate().map_err(|error| {
            format!("invalid observation rejected before serialization: {error}")
        })?;
        lines.push(
            serde_json::to_string(record)
                .map_err(|error| format!("observation serialization failed: {error}"))?,
        );
    }
    for line in lines {
        writeln!(writer, "{line}").map_err(|error| format!("write failed: {error}"))?;
    }
    writer
        .flush()
        .map_err(|error| format!("flush failed: {error}"))
}

fn append_pid_observations(records: Vec<pid_observation::PidObservation>) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let mut guard = PID_JSONL_SINK
        .lock()
        .map_err(|error| format!("sink lock poisoned: {error}"))?;
    let Some(writer) = guard.as_mut() else {
        return if std::env::var_os("CREBAIN_PID_JSONL").is_none() {
            Ok(())
        } else {
            Err("configured sink is unavailable after its open failed".to_string())
        };
    };
    write_pid_observations(writer, &records)
}

fn append_pid_observations_best_effort(records: Vec<pid_observation::PidObservation>) {
    if let Err(error) = append_pid_observations(records) {
        log::warn!("[pid-jsonl] {error}");
    }
}

#[cfg(feature = "ncp")]
fn preflight_pid_jsonl_sink() -> Result<(), String> {
    if std::env::var_os("CREBAIN_PID_JSONL").is_none() {
        return Ok(());
    }
    let guard = PID_JSONL_SINK
        .lock()
        .map_err(|error| format!("PID JSONL sink lock poisoned: {error}"))?;
    guard
        .as_ref()
        .map(|_| ())
        .ok_or_else(|| "configured PID JSONL sink could not be opened".to_string())
}

#[cfg(feature = "ncp")]
fn enqueue_pid_jsonl_archive(
    records: Vec<pid_observation::PidObservation>,
    handle: &galadriel_producer::GaladrielHandle,
) -> Result<(), String> {
    if records.is_empty() || std::env::var_os("CREBAIN_PID_JSONL").is_none() {
        return Ok(());
    }
    if PID_JSONL_ARCHIVE_CLOSED.load(Ordering::Acquire) {
        return Err("PID JSONL archive is permanently closed".to_string());
    }
    let mut guard = PID_JSONL_ARCHIVE
        .lock()
        .map_err(|error| format!("PID JSONL archive lock poisoned: {error}"))?;
    if PID_JSONL_ARCHIVE_CLOSED.load(Ordering::Acquire) {
        return Err("PID JSONL archive is permanently closed".to_string());
    }
    if guard.is_none() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(PID_JSONL_ARCHIVE_QUEUE_CAPACITY);
        let worker_handle = handle.clone();
        let worker = std::thread::Builder::new()
            .name("crebain-pid-jsonl".to_string())
            .spawn(move || {
                while let Ok(records) = receiver.recv() {
                    if let Err(error) = append_pid_observations(records) {
                        worker_handle.mark_degraded();
                        log::error!(
                            "[pid-jsonl] archive worker failed; epoch is permanently degraded: {error}"
                        );
                        break;
                    }
                }
            })
            .map_err(|error| format!("failed to start PID JSONL archive worker: {error}"))?;
        *guard = Some(PidJsonlArchive {
            sender: Some(sender),
            worker: Some(worker),
        });
    }
    let archive = guard
        .as_ref()
        .unwrap_or_else(|| unreachable!("archive was initialized"));
    archive
        .sender
        .as_ref()
        .unwrap_or_else(|| unreachable!("running archive owns its sender"))
        .try_send(records)
        .map_err(|error| match error {
            std::sync::mpsc::TrySendError::Full(_) => {
                "PID JSONL archive queue is full; dropped newest frame".to_string()
            }
            std::sync::mpsc::TrySendError::Disconnected(_) => {
                "PID JSONL archive worker disconnected".to_string()
            }
        })
}

#[cfg(feature = "ncp")]
fn shutdown_pid_jsonl_archive() {
    PID_JSONL_ARCHIVE_CLOSED.store(true, Ordering::Release);
    let archive = PID_JSONL_ARCHIVE
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    let Some(mut archive) = archive else {
        return;
    };
    drop(archive.sender.take());
    let Some(worker) = archive.worker.take() else {
        return;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !worker.is_finished() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if worker.is_finished() {
        if worker.join().is_err() {
            log::error!("PID JSONL archive worker panicked during shutdown");
        }
    } else {
        log::error!("PID JSONL archive worker exceeded its shutdown deadline");
    }
}

#[cfg(any(feature = "ncp", test))]
fn retain_newest_measurements_for_limit(
    measurements: &mut Vec<SensorMeasurement>,
    limit: usize,
) -> Result<u64, String> {
    if measurements.len() <= limit {
        return Ok(0);
    }
    let dropped = measurements.len() - limit;
    let mut newest_first = (0..measurements.len()).collect::<Vec<_>>();
    newest_first.sort_by(|left, right| {
        measurements[*right]
            .timestamp_ms
            .cmp(&measurements[*left].timestamp_ms)
            .then_with(|| left.cmp(right))
    });
    let mut retained = vec![false; measurements.len()];
    for index in newest_first.into_iter().take(limit) {
        retained[index] = true;
    }
    let mut index = 0_usize;
    measurements.retain(|_| {
        let keep = retained[index];
        index += 1;
        keep
    });
    u64::try_from(dropped).map_err(|_| "registry input-drop count exceeds u64".to_string())
}

#[cfg(feature = "ncp")]
fn normalize_neutral_empty_frame_timestamp(timestamp_ms: u64, applicability_floor_ms: u64) -> u64 {
    if timestamp_ms == 0 {
        applicability_floor_ms
    } else {
        timestamp_ms
    }
}

fn process_fusion_batch_with_sink<F>(
    measurements: Vec<SensorMeasurement>,
    timestamp_ms: u64,
    upstream_dropped_measurements: u64,
    sink: F,
) -> Result<Vec<TrackOutput>, String>
where
    F: FnOnce(Vec<pid_observation::PidObservation>),
{
    let (measurements, duplicate_count) =
        sensor_fusion::deduplicate_sensor_measurements(measurements);
    if duplicate_count > 0 {
        log::warn!(
            "Ignored {duplicate_count} bit-exact duplicate measurements before fusion admission"
        );
    }

    #[cfg(feature = "ncp")]
    if let Some(handle) = galadriel_handle()? {
        let mut measurements = measurements;
        let mut upstream_dropped_measurements = upstream_dropped_measurements;
        let _pipeline_guard = lock_galadriel_frame_pipeline(&handle)?;
        // Before the first sensor stamp, the renderer sends the neutral sensor
        // epoch (0) for explicit empty closure frames. Clamp only those empty
        // frames to the selected deployment's applicability floor; inventing a
        // wall-clock stamp would strand simulation/header timestamps behind the
        // predictor high-water mark.
        let timestamp_ms = if measurements.is_empty() {
            let frame = handle
                .registry()
                .frame(handle.frame_id())
                .unwrap_or_else(|| unreachable!("startup validated selected frame"));
            let context = handle
                .registry()
                .context(handle.context_id())
                .unwrap_or_else(|| unreachable!("startup validated selected context"));
            normalize_neutral_empty_frame_timestamp(
                timestamp_ms,
                frame
                    .applicability()
                    .valid_from_timestamp_ms()
                    .max(context.applicability().valid_from_timestamp_ms()),
            )
        } else {
            timestamp_ms
        };
        let registry_limit = handle.registry().opportunity_policy().max_frame_inputs() as usize;
        let dropped_for_registry =
            retain_newest_measurements_for_limit(&mut measurements, registry_limit)?;
        if dropped_for_registry > 0 {
            upstream_dropped_measurements = upstream_dropped_measurements
                .checked_add(dropped_for_registry)
                .ok_or_else(|| "upstream input-drop count overflow".to_string())?;
        }
        if upstream_dropped_measurements > pid_observation::JSON_SAFE_INTEGER_MAX {
            handle.mark_degraded();
            return Err(
                "upstream input-drop count exceeds the exact JSON integer range".to_string(),
            );
        }
        if upstream_dropped_measurements > 0 {
            handle.mark_degraded();
            log::warn!(
                "Galadriel frame lost {upstream_dropped_measurements} upstream measurements; keeping the newest bounded inputs"
            );
        }
        let assembled = (|| -> Result<_, String> {
            let mut guard = FUSION_ENGINE.lock().map_err(|error| error.to_string())?;
            let fusion = guard.as_mut().ok_or("Fusion engine not initialized")?;
            let prior_id = fusion.next_evidence_prior_id()?;
            let evidence = fusion.process_frame(
                measurements,
                timestamp_ms,
                handle.registry(),
                handle.frame_id(),
                handle.context_id(),
                prior_id,
            )?;
            let typed_event_count = evidence
                .modality_outcomes
                .len()
                .checked_add(evidence.modality_misses.len())
                .ok_or_else(|| "fusion evidence event count overflow".to_string())?;
            if typed_event_count != evidence.monitor_events.len() {
                return Err(
                    "fusion evidence typed ledger diverged from canonical event order".to_string(),
                );
            }
            let drained = fusion.drain_pid_observations();
            let returned = serde_json::to_vec(&evidence.pid_observations)
                .map_err(|error| format!("failed to compare returned evidence: {error}"))?;
            let buffered = serde_json::to_vec(&drained)
                .map_err(|error| format!("failed to compare buffered evidence: {error}"))?;
            if returned != buffered {
                return Err(
                    "fusion evidence return value diverged from its epoch buffer".to_string(),
                );
            }
            Ok((
                evidence.tracks,
                evidence.frozen_track_ids,
                evidence.frozen_opportunity_tracks,
                evidence.opportunity_inputs,
                drained,
                evidence.monitor_events,
                evidence.frame_summary,
            ))
        })();

        let (
            tracks,
            frozen_track_ids,
            frozen_opportunity_tracks,
            opportunity_inputs,
            observations,
            events,
            mut summary,
        ) = match assembled {
            Ok(assembled) => assembled,
            Err(error) => {
                handle.mark_degraded();
                return Err(error);
            }
        };
        if upstream_dropped_measurements > 0 {
            summary.degraded = true;
            summary.truncated = true;
        }
        if let Err(error) = enqueue_pid_jsonl_archive(observations.clone(), &handle) {
            handle.mark_degraded();
            log::warn!("[pid-jsonl] {error}");
        }
        let report = handle
            .admit_frame(galadriel_producer::FusionFrameBatch {
                frozen_track_ids,
                frozen_opportunity_tracks,
                opportunity_inputs,
                observations,
                events,
                summary,
            })
            .map_err(|error| {
                handle.mark_degraded();
                error.to_string()
            })?;
        if report.frame_degraded {
            log::warn!(
                "Galadriel frame admitted with bounded evidence loss: observations dropped={}, events dropped={}, summary admitted={}",
                report.dropped_observations,
                report.dropped_events,
                report.summary_admitted
            );
        }
        return Ok(tracks);
    }

    if upstream_dropped_measurements > 0 {
        log::warn!(
            "Dropped {upstream_dropped_measurements} ROS measurements before non-Galadriel fusion"
        );
    }

    let (tracks, records) = {
        let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;
        let fusion = guard.as_mut().ok_or("Fusion engine not initialized")?;
        let tracks = fusion.try_process_measurements(measurements, timestamp_ms)?;
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
    upstream_dropped_measurements: Option<u64>,
) -> Result<Vec<TrackOutput>, String> {
    validate_sensor_measurements(&measurements)?;
    let upstream_dropped_measurements = upstream_dropped_measurements.unwrap_or(0);
    if upstream_dropped_measurements > pid_observation::JSON_SAFE_INTEGER_MAX {
        #[cfg(feature = "ncp")]
        if let Ok(Some(handle)) = galadriel_handle() {
            handle.mark_degraded();
        }
        return Err("upstream input-drop count exceeds the exact JSON integer range".to_string());
    }
    let task = tauri::async_runtime::spawn_blocking(move || {
        process_fusion_batch_with_sink(
            measurements,
            timestamp_ms,
            upstream_dropped_measurements,
            append_pid_observations_best_effort,
        )
    })
    .await;
    match task {
        Ok(result) => result,
        Err(error) => {
            #[cfg(feature = "ncp")]
            if let Ok(Some(handle)) = galadriel_handle() {
                handle.mark_degraded();
            }
            Err(format!("Task join error: {error}"))
        }
    }
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
    let config = prepared_fusion_config(config)?;
    #[cfg(feature = "ncp")]
    let handle = galadriel_handle()?;
    #[cfg(feature = "ncp")]
    let _pipeline_guard = handle
        .as_ref()
        .map(lock_galadriel_frame_pipeline)
        .transpose()?;
    #[cfg(feature = "ncp")]
    if let Some(handle) = handle.as_ref() {
        let actual = config.canonical_digest()?;
        if actual != handle.configuration_digest() {
            return Err(format!(
                "fusion configuration digest {actual} does not match the active Galadriel deployment pin {}",
                handle.configuration_digest()
            ));
        }
        log::info!("Pinned Galadriel fusion configuration unchanged");
        return Ok(());
    }
    let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;

    let fusion = guard.as_mut().ok_or("Fusion engine not initialized")?;
    fusion.set_config(config);

    log::info!("Sensor fusion configuration updated");
    Ok(())
}

/// Clear all tracks
#[tauri::command]
fn fusion_clear() -> Result<(), String> {
    #[cfg(feature = "ncp")]
    let handle = galadriel_handle()?;
    #[cfg(feature = "ncp")]
    let _pipeline_guard = handle
        .as_ref()
        .map(lock_galadriel_frame_pipeline)
        .transpose()?;
    {
        let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;

        let fusion = guard.as_mut().ok_or("Fusion engine not initialized")?;
        fusion.clear();
    }

    #[cfg(feature = "ncp")]
    if let Some(handle) = handle {
        let last_fusion_seq = handle.status().last_fusion_seq;
        if let Err(error) = handle.update_fusion_status(last_fusion_seq, 0) {
            handle.mark_degraded();
            return Err(error.to_string());
        }
    }

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

fn with_invoke_handler<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        detect_native_raw,
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
        transport_take_camera_frame,
        transport_ack_camera_frame,
        transport_subscribe_camera_info,
        transport_subscribe_imu,
        transport_subscribe_pose,
        transport_subscribe_model_states,
        transport_unsubscribe,
        transport_get_stats
    ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = with_invoke_handler(tauri::Builder::default())
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

            #[cfg(feature = "ncp")]
            let (fusion_config, galadriel_runtime) = {
                let config = preflight_galadriel_fusion_config()
                    .map_err(std::io::Error::other)?;
                preflight_pid_jsonl_sink().map_err(std::io::Error::other)?;
                let runtime = tauri::async_runtime::block_on(
                    galadriel_producer::start_from_env(),
                )
                .map_err(|error| std::io::Error::other(error.to_string()))?;
                (config, runtime)
            };

            #[cfg(not(feature = "ncp"))]
            let fusion_config = {
                reject_galadriel_enable_without_feature()
                    .map_err(std::io::Error::other)?;
                prepared_fusion_config(FusionConfig::default())
                    .map_err(std::io::Error::other)?
            };

            let fusion = MultiSensorFusion::new(fusion_config);
            let mut fusion_guard = FUSION_ENGINE
                .lock()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            *fusion_guard = Some(fusion);
            drop(fusion_guard);
            log::info!("Sensor fusion engine initialized with deployment configuration");

            #[cfg(feature = "ncp")]
            if let Some(runtime) = galadriel_runtime {
                let status = runtime.handle().status();
                log::info!(
                    "Galadriel producer enabled for epoch {}",
                    status.epoch
                );
                let mut runtime_guard = GALADRIEL_RUNTIME
                    .lock()
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                if runtime_guard.is_some() {
                    return Err(std::io::Error::other(
                        "Galadriel producer runtime was initialized more than once",
                    )
                    .into());
                }
                *runtime_guard = Some(runtime);
                GALADRIEL_LIFECYCLE.store(GALADRIEL_LIFECYCLE_ACTIVE, Ordering::Release);
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
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("Fatal error running Tauri application: {}", e);
            std::process::exit(1);
        });

    app.run(|_handle, _event| {
        #[cfg(feature = "ncp")]
        if matches!(_event, tauri::RunEvent::Exit) {
            // Deny new command lookups first, then serialize behind any frame
            // that already owns the pipeline. Keep this guard through runtime
            // and archive shutdown so stale cloned handles cannot process or
            // reopen resources after the exit sequence passes them.
            GALADRIEL_LIFECYCLE.store(GALADRIEL_LIFECYCLE_STOPPED, Ordering::Release);
            let _pipeline_guard = match GALADRIEL_FRAME_PIPELINE.lock() {
                Ok(guard) => guard,
                Err(poisoned) => {
                    log::error!("Galadriel frame pipeline lock poisoned during shutdown");
                    poisoned.into_inner()
                }
            };
            let runtime = match GALADRIEL_RUNTIME.lock() {
                Ok(mut guard) => guard.take(),
                Err(poisoned) => {
                    log::error!(
                        "Galadriel runtime lock poisoned during shutdown; recovering ownership"
                    );
                    poisoned.into_inner().take()
                }
            };
            if let Some(runtime) = runtime {
                tauri::async_runtime::block_on(runtime.shutdown());
            }
            shutdown_pid_jsonl_archive();
        }
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

    fn test_fusion_config() -> FusionConfig {
        FusionConfig::default()
    }

    #[cfg(feature = "ncp")]
    #[test]
    fn galadriel_artifact_preflight_accepts_exact_config_and_executable_pins() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("crebain-fixture");
        std::fs::write(&executable, b"abc").unwrap();
        let config = FusionConfig::default();
        let configuration_digest = config.canonical_digest().unwrap();
        let software_digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

        verify_galadriel_artifact_pins(
            &config,
            &configuration_digest,
            &executable,
            software_digest,
        )
        .unwrap();

        assert!(verify_galadriel_artifact_pins(
            &config,
            &"0".repeat(64),
            &executable,
            software_digest,
        )
        .unwrap_err()
        .contains("configuration digest"));
        assert!(verify_galadriel_artifact_pins(
            &config,
            &configuration_digest,
            &executable,
            &"0".repeat(64),
        )
        .unwrap_err()
        .contains("executable digest"));
    }

    #[cfg(feature = "ncp")]
    #[test]
    fn galadriel_fusion_config_file_is_bounded_and_unknown_fields_fail() {
        let directory = tempfile::tempdir().unwrap();
        let oversized = directory.path().join("oversized.json");
        std::fs::write(
            &oversized,
            vec![b' '; MAX_GALADRIEL_FUSION_CONFIG_BYTES + 1],
        )
        .unwrap();
        assert!(read_fusion_config_bounded(&oversized)
            .unwrap_err()
            .contains("must contain"));

        let mut value = serde_json::to_value(FusionConfig::default()).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("unregistered_knob".to_string(), serde_json::json!(true));
        assert!(serde_json::from_value::<FusionConfig>(value).is_err());
    }

    fn test_sensor_measurement() -> SensorMeasurement {
        SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: sensor_fusion::SensorModality::Visual,
            timestamp_ms: 1000,
            source_frame_id: None,
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

        let error = tauri::async_runtime::block_on(fusion_process(vec![measurement], 1000, None))
            .unwrap_err();

        assert!(error.contains("position[1] must be finite"));
    }

    #[test]
    fn fusion_process_rejects_oversized_measurement_batch() {
        let measurements =
            vec![test_sensor_measurement(); sensor_fusion::MAX_FUSION_MEASUREMENTS_PER_BATCH + 1];

        let error =
            tauri::async_runtime::block_on(fusion_process(measurements, 1000, None)).unwrap_err();

        assert!(error.contains("Too many sensor measurements"));
    }

    #[test]
    fn fusion_process_rejects_non_wire_safe_upstream_drop_count() {
        let error = tauri::async_runtime::block_on(fusion_process(
            Vec::new(),
            1000,
            Some(pid_observation::JSON_SAFE_INTEGER_MAX + 1),
        ))
        .unwrap_err();

        assert!(error.contains("upstream input-drop count"));
    }

    #[test]
    fn registry_input_limit_keeps_newest_measurements_and_counts_loss() {
        let mut measurements = (0..3)
            .map(|index| {
                let mut measurement = test_sensor_measurement();
                measurement.sensor_id = format!("sensor-{index}");
                measurement.timestamp_ms = [1_200, 1_000, 1_100][index];
                measurement
            })
            .collect::<Vec<_>>();

        let dropped = retain_newest_measurements_for_limit(&mut measurements, 2).unwrap();

        assert_eq!(dropped, 1);
        assert_eq!(
            measurements
                .iter()
                .map(|measurement| measurement.sensor_id.as_str())
                .collect::<Vec<_>>(),
            ["sensor-0", "sensor-2"]
        );
    }

    #[test]
    fn registry_input_limit_breaks_timestamp_ties_by_original_order() {
        let mut measurements = (0..4)
            .map(|index| {
                let mut measurement = test_sensor_measurement();
                measurement.sensor_id = format!("sensor-{index}");
                measurement.timestamp_ms = [1_000, 1_200, 1_200, 1_100][index];
                measurement
            })
            .collect::<Vec<_>>();

        let dropped = retain_newest_measurements_for_limit(&mut measurements, 2).unwrap();

        assert_eq!(dropped, 2);
        assert_eq!(
            measurements
                .iter()
                .map(|measurement| measurement.sensor_id.as_str())
                .collect::<Vec<_>>(),
            ["sensor-1", "sensor-2"]
        );
    }

    #[cfg(feature = "ncp")]
    #[test]
    fn only_neutral_empty_frame_timestamp_is_normalized_to_registry_floor() {
        assert_eq!(normalize_neutral_empty_frame_timestamp(0, 1_000), 1_000);
        assert_eq!(normalize_neutral_empty_frame_timestamp(1, 1_000), 1);
        assert_eq!(normalize_neutral_empty_frame_timestamp(1_001, 1_000), 1_001);
    }

    #[test]
    fn process_fusion_batch_releases_engine_lock_before_invoking_sink() {
        fusion_init(Some(test_fusion_config())).unwrap();

        process_fusion_batch_with_sink(vec![test_sensor_measurement()], 1000, 0, |_| {
            assert!(
                FUSION_ENGINE.try_lock().is_ok(),
                "fusion engine lock remained held while invoking the PID sink"
            );
        })
        .unwrap();
    }

    fn test_pid_observation() -> pid_observation::PidObservation {
        pid_observation::PidObservation {
            track_id: 42,
            timestamp_ms: 1_700_000_000_000,
            seq: 7,
            modality: sensor_fusion::SensorModality::Radar,
            nis: 2.75,
            dof: 3,
            innovation: None,
            innovation_cov: None,
            consistency_projection: None,
        }
    }

    #[test]
    fn pid_jsonl_writer_validates_entire_batch_before_writing() {
        let valid = test_pid_observation();
        let mut invalid = valid.clone();
        invalid.nis = f64::NAN;
        let mut bytes = Vec::new();

        let error = write_pid_observations(&mut bytes, &[valid, invalid]).unwrap_err();

        assert!(error.contains("nis must be finite"));
        assert!(bytes.is_empty());
    }

    #[test]
    fn pid_jsonl_writer_reports_flush_failure() {
        struct FlushFailure(Vec<u8>);

        impl std::io::Write for FlushFailure {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.extend_from_slice(bytes);
                Ok(bytes.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::other("synthetic flush failure"))
            }
        }

        let error =
            write_pid_observations(&mut FlushFailure(Vec::new()), &[test_pid_observation()])
                .unwrap_err();

        assert!(error.contains("synthetic flush failure"));
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
            "transport_take_camera_frame",
            "transport_ack_camera_frame",
            "transport_subscribe_camera_info",
            "transport_subscribe_imu",
            "transport_subscribe_pose",
            "transport_subscribe_model_states",
            "transport_unsubscribe",
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
            "transport_subscribe_model_states",
        ] {
            assert!(
                sources.contains(&format!("fn {command}")),
                "missing source function for {command}"
            );
        }
    }

    #[test]
    fn backend_invoke_handler_excludes_direct_mutation_and_inference_bypasses() {
        let source = include_str!("lib.rs");
        let handler = source
            .split("generate_handler![")
            .nth(1)
            .and_then(|tail| tail.split("])").next())
            .unwrap();

        for forbidden in [
            "detect_coreml",
            "detect_coreml_raw",
            "detect_onnx",
            "transport_publish_velocity",
            "transport_publish_twist_stamped",
            "transport_publish_pose",
            "transport_spawn_gazebo_model",
        ] {
            assert!(
                !handler.contains(forbidden),
                "registered forbidden command {forbidden}"
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
        assert!(transport::commands::validate_topic_for_test("/drone1/pose").is_ok());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Serialized IPC integration tests (Tauri mock runtime).
    //
    // These build the production handler list and pass JSON InvokeRequest values
    // through Tauri's real argument deserialization and command dispatch. Each
    // app uses a unique data directory that is removed after the test.
    // ─────────────────────────────────────────────────────────────────────────

    static NEXT_MOCK_APP_ID: AtomicU64 = AtomicU64::new(1);

    struct MockIpcApp {
        _app: tauri::App<tauri::test::MockRuntime>,
        webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
        data_dir: std::path::PathBuf,
        scenes_dir: std::path::PathBuf,
    }

    impl MockIpcApp {
        fn new() -> Self {
            let app_id = NEXT_MOCK_APP_ID.fetch_add(1, Ordering::Relaxed);
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().identifier = format!(
                "com.sepahead.crebain.test.{}.{}",
                std::process::id(),
                app_id
            );
            let app = with_invoke_handler(tauri::test::mock_builder())
                .build(context)
                .expect("failed to build mock Tauri app");
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("mock app data directory must resolve");
            let scenes_dir = data_dir.join("scenes");
            std::fs::create_dir_all(&scenes_dir).expect("mock scenes directory must be creatable");
            let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .expect("failed to build mock Tauri webview");

            Self {
                _app: app,
                webview,
                data_dir,
                scenes_dir,
            }
        }

        fn invoke(
            &self,
            command: &str,
            body: serde_json::Value,
        ) -> Result<serde_json::Value, serde_json::Value> {
            tauri::test::get_ipc_response(
                &self.webview,
                tauri::webview::InvokeRequest {
                    cmd: command.to_string(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .expect("static mock invoke URL must parse"),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
            )
            .map(|body| {
                body.deserialize()
                    .expect("command response must be valid JSON")
            })
        }

        fn assert_error_contains(&self, command: &str, body: serde_json::Value, expected: &str) {
            let error = self
                .invoke(command, body)
                .expect_err("negative IPC case unexpectedly succeeded");
            let rendered = error
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string());
            assert!(
                rendered
                    .to_ascii_lowercase()
                    .contains(&expected.to_ascii_lowercase()),
                "unexpected {command} error: {rendered}"
            );
        }
    }

    impl Drop for MockIpcApp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.data_dir);
        }
    }

    #[test]
    fn serialized_ipc_rejects_scene_save_payload_and_path_failures() {
        let app = MockIpcApp::new();
        let valid_json = serde_json::json!({ "version": "1.0.0", "name": "IPC test" });
        let outside_path = std::env::temp_dir().join("crebain-ipc-outside.json");

        app.assert_error_contains(
            "scene_save_file",
            serde_json::json!({ "path": "scene.json", "json": "" }),
            "Empty scene JSON",
        );
        app.assert_error_contains(
            "scene_save_file",
            serde_json::json!({
                "path": "scene.json",
                "json": "x".repeat(MAX_SCENE_STATE_BYTES + 1),
            }),
            "too large",
        );
        app.assert_error_contains(
            "scene_save_file",
            serde_json::json!({ "path": "../outside.json", "json": valid_json.to_string() }),
            "traversal",
        );
        app.assert_error_contains(
            "scene_save_file",
            serde_json::json!({ "path": "wrong.txt", "json": valid_json.to_string() }),
            "must end with .json",
        );
        app.assert_error_contains(
            "scene_save_file",
            serde_json::json!({
                "path": outside_path.to_string_lossy(),
                "json": valid_json.to_string(),
            }),
            "traversal",
        );
        app.assert_error_contains(
            "scene_save_file",
            serde_json::json!({ "path": "malformed.json", "json": "{" }),
            "Invalid scene JSON",
        );
    }

    #[test]
    fn serialized_ipc_rejects_scene_load_path_and_content_failures() {
        let app = MockIpcApp::new();
        let outside_path = std::env::temp_dir().join("crebain-ipc-outside.json");
        std::fs::write(app.scenes_dir.join("malformed.json"), b"{")
            .expect("malformed scene fixture must be writable");
        std::fs::write(app.scenes_dir.join("invalid-utf8.json"), [0xff])
            .expect("UTF-8 fixture must be writable");
        let oversized_path = app.scenes_dir.join("oversized.json");
        let oversized = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&oversized_path)
            .expect("oversized scene fixture must be creatable");
        oversized
            .set_len((MAX_SCENE_STATE_BYTES + 1) as u64)
            .expect("oversized scene fixture must be resizable");

        for (path, expected) in [
            ("../outside.json", "traversal"),
            ("wrong.txt", "must end with .json"),
            ("missing.json", "Failed to open"),
            ("malformed.json", "Invalid scene JSON"),
            ("invalid-utf8.json", "not valid UTF-8"),
            ("oversized.json", "too large"),
        ] {
            app.assert_error_contains(
                "scene_load_file",
                serde_json::json!({ "path": path }),
                expected,
            );
        }
        app.assert_error_contains(
            "scene_load_file",
            serde_json::json!({ "path": outside_path.to_string_lossy() }),
            "traversal",
        );
    }

    #[test]
    fn serialized_ipc_rejects_detector_and_fusion_inputs_before_runtime_use() {
        let app = MockIpcApp::new();
        app.assert_error_contains(
            "detect_native_raw",
            serde_json::json!({
                "rgbaData": [0, 1, 2],
                "width": 1,
                "height": 1,
                "confidenceThreshold": null,
                "iouThreshold": null,
                "maxDetections": null,
            }),
            "Invalid RGBA data size",
        );
        app.assert_error_contains(
            "detect_native_raw",
            serde_json::json!({
                "rgbaData": [0, 0, 0, 255],
                "width": 1,
                "height": 1,
                "confidenceThreshold": 0.24,
                "iouThreshold": 0.45,
                "maxDetections": 100,
            }),
            "common backend envelope starts at 0.25",
        );
        app.assert_error_contains(
            "detect_native_raw",
            serde_json::json!({
                "rgbaData": [],
                "width": "not-a-number",
                "height": 1,
            }),
            "invalid args `width`",
        );

        let mut invalid_config = test_fusion_config();
        invalid_config.particle_count = sensor_fusion::MAX_FUSION_PARTICLE_COUNT + 1;
        let invalid_config =
            serde_json::to_value(invalid_config).expect("fusion config must serialize");
        for command in ["fusion_init", "fusion_set_config"] {
            app.assert_error_contains(
                command,
                serde_json::json!({ "config": invalid_config.clone() }),
                "particle_count",
            );
        }

        let mut invalid_measurement = test_sensor_measurement();
        invalid_measurement.covariance[1] = 0.0;
        app.assert_error_contains(
            "fusion_process",
            serde_json::json!({
                "measurements": [invalid_measurement],
                "timestampMs": 1000,
            }),
            "covariance[1] must be within",
        );
        app.assert_error_contains(
            "fusion_process",
            serde_json::json!({ "measurements": [], "timestampMs": "not-a-number" }),
            "invalid args `timestampMs`",
        );
        app.assert_error_contains(
            "fusion_process",
            serde_json::json!({
                "measurements": [],
                "timestampMs": 1000,
                "upstreamDroppedMeasurements": pid_observation::JSON_SAFE_INTEGER_MAX + 1,
            }),
            "upstream input-drop count",
        );
    }

    #[test]
    fn serialized_ipc_rejects_all_transport_topic_commands_before_connection_lookup() {
        let app = MockIpcApp::new();
        for command in [
            "transport_subscribe_camera",
            "transport_take_camera_frame",
            "transport_ack_camera_frame",
            "transport_subscribe_camera_info",
            "transport_subscribe_imu",
            "transport_subscribe_pose",
            "transport_subscribe_model_states",
            "transport_unsubscribe",
        ] {
            let mut body = serde_json::json!({ "topic": "relative/topic" });
            if command == "transport_subscribe_camera" {
                body["compressed"] = serde_json::Value::Bool(false);
                body["cameraSubscriptionId"] = serde_json::Value::String("1".to_string());
            }
            if matches!(
                command,
                "transport_take_camera_frame" | "transport_ack_camera_frame"
            ) {
                body["deliveryId"] = serde_json::Value::String("1".to_string());
                body["cameraSubscriptionId"] = serde_json::Value::String("1".to_string());
                body["generation"] = serde_json::Value::String("1".to_string());
            }
            app.assert_error_contains(command, body, "absolute ROS name");
        }
    }

    #[test]
    fn serialized_ipc_accepts_maximum_canonical_lifecycle_generation_string() {
        let app = MockIpcApp::new();

        let response = app
            .invoke(
                "transport_disconnect",
                serde_json::json!({ "generation": "18446744073709551615" }),
            )
            .expect("maximum canonical u64 generation must cross IPC exactly");

        assert_eq!(response, serde_json::Value::Null);
    }

    #[test]
    fn serialized_ipc_rejects_numeric_lifecycle_generations() {
        let app = MockIpcApp::new();
        for generation in [
            serde_json::json!(7),
            serde_json::json!(9_007_199_254_740_992_u64),
        ] {
            app.assert_error_contains(
                "transport_disconnect",
                serde_json::json!({ "generation": generation }),
                "invalid args `generation`",
            );
        }
    }

    #[test]
    fn serialized_ipc_rejects_noncanonical_lifecycle_generation_strings() {
        let app = MockIpcApp::new();
        for generation in ["", "0", "01", "+1", "18446744073709551616"] {
            app.assert_error_contains(
                "transport_disconnect",
                serde_json::json!({ "generation": generation }),
                "Transport lifecycle generation",
            );
        }
    }
}
