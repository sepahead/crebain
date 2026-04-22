//! CREBAIN Tauri Backend
//! Adaptive Response & Awareness System (ARAS)
//!
//! Cross-platform native backend with multiple ML inference backends:
//! - macOS: CoreML via direct FFI (Neural Engine/Metal/GPU)
//! - Linux/Windows: ONNX Runtime with CUDA/TensorRT/CPU

// Core modules
pub mod common;
mod coreml;
mod sensor_fusion;
mod onnx_detector;

// Inference backends (conditional compilation)
pub mod inference;
pub mod transport;

use coreml::DetectionResult;
use sensor_fusion::{
    FusionConfig, FusionStats, MultiSensorFusion, SensorMeasurement, TrackOutput,
};
use std::sync::{Mutex, Once};
use tauri::{Manager, Emitter};

static INIT: Once = Once::new();

// Global sensor fusion engine (thread-safe)
lazy_static::lazy_static! {
    static ref FUSION_ENGINE: Mutex<Option<MultiSensorFusion>> = Mutex::new(None);
}

/// Initialize the native CoreML detector on app startup (macOS only)
#[cfg(target_os = "macos")]
fn init_coreml_detector(app: &tauri::App) {
    INIT.call_once(|| {
        // Try multiple model paths in order of preference
        let mut possible_paths: Vec<Option<std::path::PathBuf>> = vec![
            // Bundled resource path (production)
            app.path().resource_dir()
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
                log::info!("Initializing native CoreML detector with model: {}", path_str);
                
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

/// No-op detector init for other platforms
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn init_platform_detector() {
    log::warn!("No native detector available for this platform");
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
    if image_base64.is_empty() {
        return Err("Empty image data".to_string());
    }
    
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
const MAX_IMAGE_DIMENSION: u32 = 8192;
/// Maximum allowed image size in bytes (64MB)
const MAX_IMAGE_SIZE_BYTES: usize = 64 * 1024 * 1024;
/// Maximum allowed serialized scene state size (10MB).
const MAX_SCENE_STATE_BYTES: usize = 10 * 1024 * 1024;

fn validate_scene_file_path(path: &str, allowed_root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let validated = common::path::validate_path(path, Some(allowed_root))?;
    match validated.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("json") => Ok(validated),
        _ => Err("Scene file path must end with .json".to_string()),
    }
}

/// Run CoreML detection on raw RGBA data - ZERO COPY PATH
#[tauri::command]
async fn detect_coreml_raw(
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
    confidence_threshold: Option<f64>,
    max_detections: Option<i32>,
) -> Result<DetectionResult, String> {
    // Validate dimensions to prevent DoS via memory exhaustion
    if width == 0 || height == 0 {
        return Err("Invalid image dimensions: width and height must be > 0".to_string());
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(format!(
            "Image dimensions too large: {}x{} exceeds maximum {}x{}",
            width, height, MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION
        ));
    }
    
    let expected_size = (width as usize)
        .checked_mul(height as usize)
        .and_then(|s| s.checked_mul(4))
        .ok_or_else(|| "Image dimensions too large (overflow)".to_string())?;
    if expected_size > MAX_IMAGE_SIZE_BYTES {
        return Err(format!(
            "Image too large: {} bytes exceeds maximum {} bytes",
            expected_size, MAX_IMAGE_SIZE_BYTES
        ));
    }
    if rgba_data.len() != expected_size {
        return Err(format!(
            "Invalid RGBA data size: expected {} bytes for {}x{}, got {}",
            expected_size, width, height, rgba_data.len()
        ));
    }
    
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
    // Reuse the same DoS/memory limits as the CoreML raw path.
    if width == 0 || height == 0 {
        return Err("Invalid image dimensions: width and height must be > 0".to_string());
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(format!(
            "Image dimensions too large: {}x{} exceeds maximum {}x{}",
            width, height, MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION
        ));
    }

    let expected_size = (width as usize)
        .checked_mul(height as usize)
        .and_then(|s| s.checked_mul(4))
        .ok_or_else(|| format!("Image dimensions overflow: {}x{}", width, height))?;
    if expected_size > MAX_IMAGE_SIZE_BYTES {
        return Err(format!(
            "Image too large: {} bytes exceeds maximum {} bytes",
            expected_size, MAX_IMAGE_SIZE_BYTES
        ));
    }
    if rgba_data.len() != expected_size {
        return Err(format!(
            "Invalid RGBA data size: expected {} bytes for {}x{}, got {}",
            expected_size, width, height, rgba_data.len()
        ));
    }

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
                            serde_json::Value::String("CoreML Native FFI (Metal/Neural Engine)".to_string()),
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
                                serde_json::to_value(&result)
                                    .map_err(|e| format!("Failed to serialize ONNX result: {}", e))
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

            let mut result = onnx_detector::detect_with_onnx(&rgba_data, width, height)
                .map_err(|e| failure("ONNX Runtime", e))?;
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
    // Validate inputs
    let expected_size = (width as usize)
        .checked_mul(height as usize)
        .and_then(|s| s.checked_mul(4))
        .ok_or_else(|| format!("Image dimensions overflow: {}x{}", width, height))?;
    if rgba_data.len() != expected_size {
        return Err(format!(
            "Invalid RGBA data size: expected {} bytes, got {}",
            expected_size, rgba_data.len()
        ));
    }
    
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
    
    let fusion_info = FUSION_ENGINE.lock().ok().and_then(|guard| {
        guard.as_ref().map(|f| f.get_stats())
    });
    
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
        "mode": "zero-copy",
        "onnxDetector": onnx_info,
        "sensorFusion": fusion_info
    })
}

/// Save a scene state JSON file to disk (Tauri only).
///
/// Frontend calls this via `invoke('scene_save_file', { path, json })`.
#[tauri::command]
async fn scene_save_file(path: String, json: String, app: tauri::AppHandle) -> Result<(), String> {
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

    let scenes_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("scenes");
    
    std::fs::create_dir_all(&scenes_dir)
        .map_err(|e| format!("Failed to create scenes directory: {}", e))?;
    
    let validated_path = validate_scene_file_path(&path, &scenes_dir)?;

    tauri::async_runtime::spawn_blocking(move || {
        // Validate JSON before writing.
        let value: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| format!("Invalid scene JSON: {}", e))?;
        let pretty =
            serde_json::to_string_pretty(&value).map_err(|e| format!("JSON encode error: {}", e))?;

        if let Some(parent) = validated_path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!("Failed to create directory {}: {}", parent.display(), e)
            })?;
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
async fn scene_load_file(path: String, app: tauri::AppHandle) -> Result<String, String> {
    let scenes_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?
        .join("scenes");
    
    // Ensure the scenes directory exists
    std::fs::create_dir_all(&scenes_dir)
        .map_err(|e| format!("Failed to create scenes directory: {}", e))?;
    
    let validated_path = validate_scene_file_path(&path, &scenes_dir)?;

    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&validated_path).map_err(|e| {
            format!(
                "Failed to stat {}: {}",
                validated_path.display(),
                e
            )
        })?;
        if meta.len() as usize > MAX_SCENE_STATE_BYTES {
            return Err(format!(
                "Scene file too large: {} bytes exceeds maximum {} bytes",
                meta.len(),
                MAX_SCENE_STATE_BYTES
            ));
        }

        let contents = std::fs::read_to_string(&validated_path).map_err(|e| {
            format!(
                "Failed to read {}: {}",
                validated_path.display(),
                e
            )
        })?;

        // Validate JSON so callers get consistent errors.
        let _: serde_json::Value =
            serde_json::from_str(&contents).map_err(|e| format!("Invalid scene JSON: {}", e))?;

        Ok(contents)
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
                let app_menu = tauri::menu::Submenu::new(
                    handle,
                    "Crebain",
                    true
                )?;
                
                let about_item = tauri::menu::MenuItem::with_id(handle, "about_crebain", "About Crebain", true, None::<&str>)?;
                
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
                file_menu.append(&tauri::menu::PredefinedMenuItem::close_window(handle, None)?)?;

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
    #[test]
    fn placeholder_backend_test() {
        // Backend selection tests were removed along with the Zig detector.
        // ONNX is now the sole non-macOS backend.
        assert!(true);
    }
}
