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
mod sensor_fusion;

// Inference backends (conditional compilation)
pub mod inference;
pub mod transport;

use coreml::DetectionResult;
use sensor_fusion::{
    validate_fusion_config, validate_sensor_measurements, FusionConfig, FusionStats,
    MultiSensorFusion, SensorMeasurement, TrackOutput,
};
#[cfg(target_os = "macos")]
use std::sync::Once;
use std::sync::{LazyLock, Mutex};
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
static INIT: Once = Once::new();

// Global sensor fusion engine (thread-safe)
static FUSION_ENGINE: LazyLock<Mutex<Option<MultiSensorFusion>>> =
    LazyLock::new(|| Mutex::new(None));

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

/// Initialize ONNX Runtime detector (cross-platform fallback)
fn init_onnx_detector() {
    log::info!("Initializing ONNX Runtime detector");

    match onnx_detector::init_global_detector() {
        Ok(()) => {
            log::info!("ONNX Runtime detector initialized successfully");
        }
        Err(e) => {
            log::warn!("Failed to initialize ONNX detector: {}", e);
        }
    }
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

    for key in ["cameras", "assets", "drones", "annotations"] {
        if !object.get(key).is_some_and(|entry| entry.is_array()) {
            object.insert(key.to_string(), serde_json::Value::Array(Vec::new()));
        }
    }

    Ok(value)
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

/// Run detection using the best available native backend (cross-platform).
///
/// This provides a single IPC entry point for the frontend:
/// - macOS: native CoreML FFI
/// - Linux/others: ONNX Runtime (TensorRT/CUDA/CPU execution providers)
#[tauri::command]
async fn detect_native_raw(
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
    confidence_threshold: Option<f64>,
    _iou_threshold: Option<f64>,
    max_detections: Option<i32>,
) -> Result<serde_json::Value, String> {
    validate_rgba_input_len(rgba_data.len(), width, height)?;

    let conf = confidence_threshold.unwrap_or(0.25).clamp(0.0, 1.0);
    let max_det = max_detections.unwrap_or(100).clamp(1, 1000) as usize;

    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        // Helper for consistent error payloads (avoid throwing on the JS side).
        let failure = |backend: &str, error: String| {
            serde_json::json!({
                "success": false,
                "detections": [],
                "inferenceTimeMs": 0.0,
                "preprocessTimeMs": 0.0,
                "postprocessTimeMs": 0.0,
                "backend": backend,
                "error": error,
            })
        };

        #[cfg(target_os = "macos")]
        {
            match coreml::detect_raw(&rgba_data, width, height, conf, max_det) {
                Ok(result) => {
                    let mut value = serde_json::to_value(&result)
                        .map_err(|e| format!("Failed to serialize CoreML result: {}", e))?;
                    if let serde_json::Value::Object(ref mut map) = value {
                        map.insert(
                            "backend".to_string(),
                            serde_json::Value::String(
                                "CoreML Native FFI (Metal/Neural Engine)".to_string(),
                            ),
                        );
                    }
                    Ok(value)
                }
                Err(coreml_err) => {
                    // If CoreML isn't available/initialized, fall back to ONNX if present.
                    if onnx_detector::is_onnx_detector_ready() {
                        match onnx_detector::detect_with_onnx(&rgba_data, width, height) {
                            Ok(mut result) => {
                                let conf_f32 = conf as f32;
                                if conf_f32 > 0.0 {
                                    result.detections.retain(|d| d.confidence >= conf_f32);
                                }
                                if result.detections.len() > max_det {
                                    result.detections.truncate(max_det);
                                }
                                let mut value = serde_json::to_value(&result).map_err(|e| {
                                    format!("Failed to serialize ONNX result: {}", e)
                                })?;
                                if let serde_json::Value::Object(ref mut map) = value {
                                    map.insert(
                                        "backend".to_string(),
                                        serde_json::Value::String(format!(
                                            "{} (CoreML fallback)",
                                            result.backend
                                        )),
                                    );
                                }
                                Ok(value)
                            }
                            Err(onnx_err) => Ok(failure(
                                "CoreML/ONNX",
                                format!("CoreML failed: {}; ONNX failed: {}", coreml_err, onnx_err),
                            )),
                        }
                    } else {
                        Ok(failure("CoreML Native FFI", coreml_err))
                    }
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            if !onnx_detector::is_onnx_detector_ready() {
                return Ok(failure(
                    "No Backend Available",
                    "No detector initialized (missing model or backend unavailable)".to_string(),
                ));
            }

            let mut result = match onnx_detector::detect_with_onnx(&rgba_data, width, height) {
                Ok(result) => result,
                Err(e) => {
                    return Ok(failure("ONNX Runtime", format!("ONNX Runtime: {}", e)));
                }
            };
            let conf_f32 = conf as f32;
            if conf_f32 > 0.0 {
                result.detections.retain(|d| d.confidence >= conf_f32);
            }
            if result.detections.len() > max_det {
                result.detections.truncate(max_det);
            }
            serde_json::to_value(&result)
                .map_err(|e| format!("Failed to serialize ONNX result: {}", e))
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
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
    let available_backends: Vec<String> = inference::available_backends()
        .iter()
        .map(|backend| backend.to_string())
        .collect();

    // Determine primary backend based on platform and availability
    let onnx_backend = onnx_info
        .get("backend")
        .and_then(|v| v.as_str())
        .unwrap_or("ONNX Runtime");

    #[cfg(target_os = "macos")]
    let backend = if coreml_available {
        "CoreML Native FFI (Metal/Neural Engine)".to_string()
    } else if onnx_detector::is_onnx_detector_ready() {
        onnx_backend.to_string()
    } else {
        "No Backend Available".to_string()
    };

    #[cfg(not(target_os = "macos"))]
    let backend = if onnx_detector::is_onnx_detector_ready() {
        onnx_backend.to_string()
    } else {
        "No Backend Available".to_string()
    };

    serde_json::json!({
        "platform": platform,
        "arch": std::env::consts::ARCH,
        "coremlAvailable": coreml_available,
        "onnxAvailable": onnx_detector::is_onnx_detector_ready(),
        "backend": backend,
        "mode": "raw-rgba",
        "availableBackends": available_backends,
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

        if let Some(parent) = validated_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
        }

        let file_name = validated_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid scene path: missing file name".to_string())?;
        let tmp_path = validated_path.with_file_name(format!("{}.tmp", file_name));

        {
            use std::io::Write;
            let mut file = std::fs::File::create(&tmp_path)
                .map_err(|e| format!("Failed to create {}: {}", tmp_path.display(), e))?;
            file.write_all(pretty.as_bytes())
                .map_err(|e| format!("Failed to write {}: {}", tmp_path.display(), e))?;
            let _ = file.sync_all();
        }

        // Replace destination. On Unix, `rename` overwrites atomically; on Windows it
        // fails if the destination exists, so we fall back to remove+rename.
        if let Err(rename_err) = std::fs::rename(&tmp_path, &validated_path) {
            if validated_path.exists() {
                std::fs::remove_file(&validated_path).map_err(|e| {
                    format!(
                        "Failed to remove existing {}: {}",
                        validated_path.display(),
                        e
                    )
                })?;
                std::fs::rename(&tmp_path, &validated_path).map_err(|e| {
                    format!(
                        "Failed to move {} -> {}: {}",
                        tmp_path.display(),
                        validated_path.display(),
                        e
                    )
                })?;
            } else {
                return Err(format!(
                    "Failed to move {} -> {}: {}",
                    tmp_path.display(),
                    validated_path.display(),
                    rename_err
                ));
            }
        }

        Ok(())
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
        let meta = std::fs::metadata(&validated_path)
            .map_err(|e| format!("Failed to stat {}: {}", validated_path.display(), e))?;
        if meta.len() as usize > MAX_SCENE_STATE_BYTES {
            return Err(format!(
                "Scene file too large: {} bytes exceeds maximum {} bytes",
                meta.len(),
                MAX_SCENE_STATE_BYTES
            ));
        }

        let contents = std::fs::read_to_string(&validated_path)
            .map_err(|e| format!("Failed to read {}: {}", validated_path.display(), e))?;

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
    let fusion = MultiSensorFusion::new(cfg);

    let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;
    *guard = Some(fusion);

    log::info!("Sensor fusion engine initialized");
    Ok(())
}

/// Process sensor measurements and return fused tracks
/// Uses spawn_blocking to avoid blocking the async runtime for heavy fusion operations
#[tauri::command]
async fn fusion_process(
    measurements: Vec<SensorMeasurement>,
    timestamp_ms: u64,
) -> Result<Vec<TrackOutput>, String> {
    validate_sensor_measurements(&measurements)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = FUSION_ENGINE.lock().map_err(|e| e.to_string())?;
        let fusion = guard.as_mut().ok_or("Fusion engine not initialized")?;
        let tracks = fusion.process_measurements(measurements, timestamp_ms);
        Ok(tracks)
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

            // Platform-specific detector initialization
            #[cfg(target_os = "macos")]
            {
                // Initialize the native CoreML detector (primary on macOS)
                init_coreml_detector(app);

                // Try ONNX as secondary fallback (uses CoreML execution provider)
                init_onnx_detector();
            }

            #[cfg(target_os = "linux")]
            {
                // Initialize ONNX Runtime detector (primary on Linux, uses CUDA if available)
                init_onnx_detector();
            }

            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            {
                // On other platforms, try ONNX with CPU fallback
                init_onnx_detector();
                log::warn!("Running on unsupported platform - limited functionality");
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

    #[test]
    fn validate_rgba_input_len_accepts_exact_size() {
        let expected = validate_rgba_input_len(16, 2, 2).unwrap();
        assert_eq!(expected, 16);
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
    fn migrate_scene_json_upgrades_legacy_scene_shape() {
        let migrated = migrate_scene_json(serde_json::json!({
            "version": "0.4.0",
            "name": "Legacy Scene"
        }))
        .unwrap();

        assert_eq!(migrated["version"], CURRENT_SCENE_VERSION);
        assert!(migrated["timestamp"].is_number());
        for key in ["cameras", "assets", "drones", "annotations"] {
            assert!(migrated[key].is_array());
        }
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
