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
mod scene_contract;
mod sensor_fusion;

// Inference backends (conditional compilation)
pub mod inference;
pub mod transport;

// Neuro-Cybernetic Protocol client (Engram) — opt-in via the `ncp`
// feature. Self-contained; does not alter the default command surface.
#[cfg(feature = "ncp")]
pub mod ncp;

use scene_contract::migrate_scene_json;
#[cfg(test)]
use scene_contract::CURRENT_SCENE_VERSION;
use sensor_fusion::{
    validate_fusion_config, validate_sensor_measurements, FusionConfig, FusionStats,
    MultiSensorFusion, SensorMeasurement, TrackOutput,
};
#[cfg(feature = "ncp")]
use sha2::{Digest, Sha256};
#[cfg(feature = "ncp")]
use std::sync::atomic::AtomicU8;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{Emitter, Manager};

// Global sensor fusion engine (thread-safe)
static FUSION_ENGINE: LazyLock<Mutex<Option<MultiSensorFusion>>> =
    LazyLock::new(|| Mutex::new(None));
#[cfg(feature = "ncp")]
static GALADRIEL_RUNTIME: LazyLock<Mutex<Option<galadriel_producer::GaladrielRuntime>>> =
    LazyLock::new(|| Mutex::new(None));
#[cfg(feature = "ncp")]
static GALADRIEL_STARTUP_ERROR: LazyLock<Mutex<Option<String>>> =
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
const GALADRIEL_LIFECYCLE_STARTING: u8 = 1;
#[cfg(feature = "ncp")]
const GALADRIEL_LIFECYCLE_ACTIVE: u8 = 2;
#[cfg(feature = "ncp")]
const GALADRIEL_LIFECYCLE_FAILED: u8 = 3;
#[cfg(feature = "ncp")]
const GALADRIEL_LIFECYCLE_STOPPED: u8 = 4;
#[cfg(feature = "ncp")]
const GALADRIEL_STARTUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
#[cfg(feature = "ncp")]
const GALADRIEL_STARTING_ERROR: &str = "FUSION_INITIALIZING: Galadriel producer is still starting";

/// Maximum allowed image dimension (8K resolution)
#[cfg(test)]
const MAX_IMAGE_DIMENSION: u32 = common::image::MAX_IMAGE_DIMENSION;
/// Maximum allowed image size in bytes (64MB)
#[cfg(test)]
const MAX_IMAGE_SIZE_BYTES: usize = common::image::MAX_IMAGE_SIZE_BYTES;
/// Maximum allowed serialized scene state size (10MB).
const MAX_SCENE_STATE_BYTES: usize = 10 * 1024 * 1024;
/// Reject overlapping work so a waiting frame cannot become stale behind inference.
const MAX_CONCURRENT_NATIVE_DETECTION_JOBS: usize = 1;
/// Retain at most one maximum-size RGBA input across all admitted jobs.
const MAX_ADMITTED_NATIVE_DETECTION_BYTES: usize = common::image::MAX_IMAGE_SIZE_BYTES;
const NATIVE_DETECTION_BUSY_BACKEND: &str = "Inference Runtime";
const NATIVE_DETECTION_BUSY_ERROR: &str =
    "NATIVE_DETECTION_BUSY: native inference capacity is full; retry a later frame";
const FUSION_PROCESS_BUSY_ERROR: &str =
    "FUSION_BUSY: sensor fusion is processing another batch; retry after it completes";

static NATIVE_DETECTION_ADMISSION: LazyLock<NativeDetectionAdmission> = LazyLock::new(|| {
    NativeDetectionAdmission::new(
        MAX_CONCURRENT_NATIVE_DETECTION_JOBS,
        MAX_ADMITTED_NATIVE_DETECTION_BYTES,
    )
});
static FUSION_PROCESS_ADMISSION: LazyLock<FusionProcessAdmission> =
    LazyLock::new(FusionProcessAdmission::default);

/// Fail-fast ownership for the single mutable fusion engine. Without this
/// admission gate, concurrent IPC calls occupy blocking workers and retain
/// decoded batches while waiting on the same engine mutex.
#[derive(Clone, Debug, Default)]
struct FusionProcessAdmission {
    active: Arc<AtomicBool>,
}

impl FusionProcessAdmission {
    fn try_reserve(&self) -> Option<FusionProcessPermit> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| FusionProcessPermit {
                active: Arc::clone(&self.active),
            })
    }

    fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
}

#[derive(Debug)]
struct FusionProcessPermit {
    active: Arc<AtomicBool>,
}

impl Drop for FusionProcessPermit {
    fn drop(&mut self) {
        let was_active = self.active.swap(false, Ordering::AcqRel);
        debug_assert!(was_active);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeDetectionAdmissionRejection {
    ConcurrentJobLimit,
    ByteLimit,
}

/// Nonblocking process-wide admission for expensive native detector work.
///
/// The permit moves into the blocking task. It therefore retains both charges
/// if the command future is cancelled after spawn and releases them when the
/// task returns, fails to start, or unwinds.
#[derive(Debug)]
struct NativeDetectionAdmissionInner {
    max_jobs: usize,
    max_bytes: usize,
    in_flight_jobs: AtomicUsize,
    in_flight_bytes: AtomicUsize,
}

#[derive(Clone, Debug)]
struct NativeDetectionAdmission {
    inner: Arc<NativeDetectionAdmissionInner>,
}

impl NativeDetectionAdmission {
    fn new(max_jobs: usize, max_bytes: usize) -> Self {
        Self {
            inner: Arc::new(NativeDetectionAdmissionInner {
                max_jobs,
                max_bytes,
                in_flight_jobs: AtomicUsize::new(0),
                in_flight_bytes: AtomicUsize::new(0),
            }),
        }
    }

    fn try_reserve(
        &self,
        input_bytes: usize,
    ) -> Result<NativeDetectionAdmissionPermit, NativeDetectionAdmissionRejection> {
        if input_bytes > self.inner.max_bytes {
            return Err(NativeDetectionAdmissionRejection::ByteLimit);
        }

        let mut jobs = self.inner.in_flight_jobs.load(Ordering::Acquire);
        loop {
            if jobs >= self.inner.max_jobs {
                return Err(NativeDetectionAdmissionRejection::ConcurrentJobLimit);
            }
            match self.inner.in_flight_jobs.compare_exchange_weak(
                jobs,
                jobs + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(observed) => jobs = observed,
            }
        }

        let mut bytes = self.inner.in_flight_bytes.load(Ordering::Acquire);
        loop {
            let Some(next_bytes) = bytes.checked_add(input_bytes) else {
                self.release_job();
                return Err(NativeDetectionAdmissionRejection::ByteLimit);
            };
            if next_bytes > self.inner.max_bytes {
                self.release_job();
                return Err(NativeDetectionAdmissionRejection::ByteLimit);
            }
            match self.inner.in_flight_bytes.compare_exchange_weak(
                bytes,
                next_bytes,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Ok(NativeDetectionAdmissionPermit {
                        inner: Arc::clone(&self.inner),
                        input_bytes,
                    });
                }
                Err(observed) => bytes = observed,
            }
        }
    }

    fn release_job(&self) {
        let previous = self.inner.in_flight_jobs.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0);
    }

    #[cfg(test)]
    fn in_flight(&self) -> (usize, usize) {
        (
            self.inner.in_flight_jobs.load(Ordering::Acquire),
            self.inner.in_flight_bytes.load(Ordering::Acquire),
        )
    }
}

#[derive(Debug)]
struct NativeDetectionAdmissionPermit {
    inner: Arc<NativeDetectionAdmissionInner>,
    input_bytes: usize,
}

impl Drop for NativeDetectionAdmissionPermit {
    fn drop(&mut self) {
        let previous = self
            .inner
            .in_flight_bytes
            .fetch_sub(self.input_bytes, Ordering::AcqRel);
        debug_assert!(previous >= self.input_bytes);
        let previous = self.inner.in_flight_jobs.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0);
    }
}

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

    fn busy() -> Self {
        Self::failure(NATIVE_DETECTION_BUSY_BACKEND, NATIVE_DETECTION_BUSY_ERROR)
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

async fn execute_admitted_native_detection<F>(
    admission: &NativeDetectionAdmission,
    input_bytes: usize,
    operation: F,
) -> NativeDetectionResponse
where
    F: FnOnce() -> NativeDetectionResponse + Send + 'static,
{
    let admission_permit = match admission.try_reserve(input_bytes) {
        Ok(permit) => permit,
        Err(_) => return NativeDetectionResponse::busy(),
    };

    let task = tauri::async_runtime::spawn_blocking(move || {
        // Keep the owned permit in the blocking closure. Dropping or cancelling
        // the command future must not admit a replacement while this task runs.
        let _admission_permit = admission_permit;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation)).unwrap_or_else(|_| {
            NativeDetectionResponse::failure(
                "Inference Runtime",
                "native detector panicked while processing the frame",
            )
        })
    })
    .await;

    task.unwrap_or_else(|error| {
        NativeDetectionResponse::failure(
            "Inference Runtime",
            format!("native detector task failed: {error}"),
        )
    })
}

/// Run detection using the persistent factory-selected native backend.
///
/// Admission starts after Tauri decodes the IPC arguments. It bounds retained
/// detector inputs and inference work, not transient request-body decoding.
#[tauri::command]
async fn detect_native_raw(
    rgba_data: Vec<u8>,
    width: u32,
    height: u32,
    confidence_threshold: Option<f64>,
    iou_threshold: Option<f64>,
    max_detections: Option<i32>,
) -> Result<NativeDetectionResponse, String> {
    let input_bytes = validate_rgba_input_len(rgba_data.len(), width, height)?;

    let confidence =
        confidence_threshold.unwrap_or(f64::from(inference::BACKEND_MIN_CONFIDENCE_THRESHOLD));
    let iou = iou_threshold.unwrap_or(f64::from(inference::BACKEND_MAX_IOU_THRESHOLD));
    let max_det =
        usize::try_from(max_detections.unwrap_or(inference::BACKEND_MAX_DETECTIONS as i32))
            .map_err(|_| "max detections must be a positive integer".to_string())?;
    let policy = inference::DetectionPolicy::new_from_f64(confidence, iou, max_det)
        .map_err(|error| error.to_string())?;

    Ok(
        execute_admitted_native_detection(&NATIVE_DETECTION_ADMISSION, input_bytes, move || {
            execute_native_detection(
                inference::production_runtime(),
                &rgba_data,
                width,
                height,
                policy,
            )
        })
        .await,
    )
}

#[cfg(feature = "ncp")]
fn galadriel_system_info() -> serde_json::Value {
    let lifecycle = GALADRIEL_LIFECYCLE.load(Ordering::Acquire);
    match lifecycle {
        GALADRIEL_LIFECYCLE_NEVER_ACTIVE => {
            return serde_json::json!({
                "compiled": true,
                "enabled": false,
                "status": "disabled"
            });
        }
        GALADRIEL_LIFECYCLE_STARTING => {
            return serde_json::json!({
                "compiled": true,
                "enabled": true,
                "status": "starting"
            });
        }
        GALADRIEL_LIFECYCLE_FAILED => {
            let error = GALADRIEL_STARTUP_ERROR
                .lock()
                .ok()
                .and_then(|guard| guard.clone())
                .unwrap_or_else(|| "Galadriel startup failed without a recorded cause".to_string());
            return serde_json::json!({
                "compiled": true,
                "enabled": true,
                "status": "failed",
                "error": error
            });
        }
        GALADRIEL_LIFECYCLE_STOPPED => {
            return serde_json::json!({
                "compiled": true,
                "enabled": true,
                "status": "stopped"
            });
        }
        GALADRIEL_LIFECYCLE_ACTIVE => {}
        invalid => {
            return serde_json::json!({
                "compiled": true,
                "enabled": false,
                "status": "failed",
                "error": format!("invalid Galadriel lifecycle state {invalid}")
            });
        }
    }

    let Ok(guard) = GALADRIEL_RUNTIME.lock() else {
        return serde_json::json!({
            "compiled": true,
            "enabled": true,
            "status": "failed",
            "error": "runtime status lock poisoned"
        });
    };
    let Some(runtime) = guard.as_ref() else {
        return serde_json::json!({
            "compiled": true,
            "enabled": true,
            "status": "failed",
            "error": "active lifecycle has no Galadriel runtime"
        });
    };
    let handle = runtime.handle();
    let status = handle.status();
    serde_json::json!({
        "compiled": true,
        "enabled": true,
        "status": "ready",
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
    serde_json::json!({ "compiled": false, "enabled": false, "status": "not-compiled" })
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
    match GALADRIEL_LIFECYCLE.load(Ordering::Acquire) {
        GALADRIEL_LIFECYCLE_NEVER_ACTIVE => return Ok(None),
        GALADRIEL_LIFECYCLE_STARTING => {
            return Err(GALADRIEL_STARTING_ERROR.to_string());
        }
        GALADRIEL_LIFECYCLE_FAILED => {
            let cause = GALADRIEL_STARTUP_ERROR
                .lock()
                .ok()
                .and_then(|guard| guard.clone())
                .unwrap_or_else(|| "startup failed without a recorded cause".to_string());
            return Err(format!("Galadriel producer startup failed: {cause}"));
        }
        GALADRIEL_LIFECYCLE_STOPPED => {
            return Err("Galadriel runtime is shutting down or stopped".to_string());
        }
        GALADRIEL_LIFECYCLE_ACTIVE => {}
        invalid => return Err(format!("invalid Galadriel lifecycle state {invalid}")),
    }

    let guard = GALADRIEL_RUNTIME
        .lock()
        .map_err(|error| format!("Galadriel runtime lock poisoned: {error}"))?;
    let runtime = guard
        .as_ref()
        .ok_or_else(|| "active Galadriel lifecycle has no runtime".to_string())?;
    Ok(Some(runtime.handle()))
}

#[cfg(feature = "ncp")]
fn lock_galadriel_frame_pipeline(
    handle: &galadriel_producer::GaladrielHandle,
) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    let guard = GALADRIEL_FRAME_PIPELINE.lock().map_err(|error| {
        handle.mark_degraded();
        format!("Galadriel frame pipeline lock poisoned: {error}")
    })?;
    if GALADRIEL_LIFECYCLE.load(Ordering::Acquire) != GALADRIEL_LIFECYCLE_ACTIVE {
        return Err("Galadriel runtime is not active".to_string());
    }
    Ok(guard)
}

#[cfg(feature = "ncp")]
fn try_lock_galadriel_frame_pipeline(
    handle: &galadriel_producer::GaladrielHandle,
) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    if FUSION_PROCESS_ADMISSION.is_active() {
        return Err(FUSION_PROCESS_BUSY_ERROR.to_string());
    }
    let guard = match GALADRIEL_FRAME_PIPELINE.try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::WouldBlock) => {
            return Err(FUSION_PROCESS_BUSY_ERROR.to_string());
        }
        Err(std::sync::TryLockError::Poisoned(error)) => {
            handle.mark_degraded();
            drop(error.into_inner());
            return Err("Galadriel frame pipeline lock poisoned".to_string());
        }
    };
    if GALADRIEL_LIFECYCLE.load(Ordering::Acquire) != GALADRIEL_LIFECYCLE_ACTIVE {
        return Err("Galadriel runtime is not active".to_string());
    }
    Ok(guard)
}

fn try_lock_fusion_engine(
) -> Result<std::sync::MutexGuard<'static, Option<MultiSensorFusion>>, String> {
    if FUSION_PROCESS_ADMISSION.is_active() {
        return Err(FUSION_PROCESS_BUSY_ERROR.to_string());
    }
    match FUSION_ENGINE.try_lock() {
        Ok(guard) if FUSION_PROCESS_ADMISSION.is_active() => {
            drop(guard);
            Err(FUSION_PROCESS_BUSY_ERROR.to_string())
        }
        Ok(guard) => Ok(guard),
        Err(std::sync::TryLockError::WouldBlock) => Err(FUSION_PROCESS_BUSY_ERROR.to_string()),
        Err(std::sync::TryLockError::Poisoned(error)) => {
            Err(format!("Fusion engine lock poisoned: {error}"))
        }
    }
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
    Ok(common::lower_hex(hasher.finalize()))
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

#[cfg(feature = "ncp")]
fn fail_galadriel_startup(error: impl Into<String>) {
    let error = error.into();
    if let Ok(mut guard) = GALADRIEL_STARTUP_ERROR.lock() {
        *guard = Some(error.clone());
    }
    if GALADRIEL_LIFECYCLE
        .compare_exchange(
            GALADRIEL_LIFECYCLE_STARTING,
            GALADRIEL_LIFECYCLE_FAILED,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok()
    {
        log::error!("Galadriel producer startup failed: {error}");
    } else {
        log::warn!("Discarded a late Galadriel startup failure after shutdown: {error}");
    }
}

#[cfg(feature = "ncp")]
enum GaladrielInstallOutcome {
    Active,
    Rejected(galadriel_producer::GaladrielRuntime),
}

#[cfg(feature = "ncp")]
fn install_galadriel_runtime(
    fusion: MultiSensorFusion,
    runtime: galadriel_producer::GaladrielRuntime,
) -> Result<GaladrielInstallOutcome, (String, galadriel_producer::GaladrielRuntime)> {
    let pipeline_guard = match GALADRIEL_FRAME_PIPELINE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            runtime.handle().mark_degraded();
            drop(poisoned.into_inner());
            return Err((
                "frame pipeline lock was poisoned during startup".to_string(),
                runtime,
            ));
        }
    };
    if GALADRIEL_LIFECYCLE.load(Ordering::Acquire) != GALADRIEL_LIFECYCLE_STARTING {
        drop(pipeline_guard);
        return Ok(GaladrielInstallOutcome::Rejected(runtime));
    }

    let mut fusion_guard = match FUSION_ENGINE.lock() {
        Ok(guard) => guard,
        Err(error) => {
            drop(pipeline_guard);
            return Err((format!("fusion engine lock poisoned: {error}"), runtime));
        }
    };
    let mut runtime_guard = match GALADRIEL_RUNTIME.lock() {
        Ok(guard) => guard,
        Err(error) => {
            drop(fusion_guard);
            drop(pipeline_guard);
            return Err((format!("runtime lock poisoned: {error}"), runtime));
        }
    };
    if runtime_guard.is_some() || fusion_guard.is_some() {
        drop(runtime_guard);
        drop(fusion_guard);
        drop(pipeline_guard);
        return Err((
            "producer runtime or fusion engine was initialized more than once".to_string(),
            runtime,
        ));
    }

    *fusion_guard = Some(fusion);
    *runtime_guard = Some(runtime);
    let activated = GALADRIEL_LIFECYCLE
        .compare_exchange(
            GALADRIEL_LIFECYCLE_STARTING,
            GALADRIEL_LIFECYCLE_ACTIVE,
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .is_ok();
    let outcome = if activated {
        GaladrielInstallOutcome::Active
    } else {
        // Shutdown can change STARTING to STOPPED while it waits for the
        // pipeline lock. Remove both values before shutdown can observe them.
        *fusion_guard = None;
        GaladrielInstallOutcome::Rejected(
            runtime_guard
                .take()
                .unwrap_or_else(|| unreachable!("startup installed the runtime")),
        )
    };
    drop(runtime_guard);
    drop(fusion_guard);
    drop(pipeline_guard);
    Ok(outcome)
}

#[cfg(feature = "ncp")]
fn spawn_galadriel_startup() {
    GALADRIEL_LIFECYCLE.store(GALADRIEL_LIFECYCLE_STARTING, Ordering::Release);
    if let Ok(mut guard) = GALADRIEL_STARTUP_ERROR.lock() {
        *guard = None;
    }

    let startup_task = tauri::async_runtime::spawn(async {
        let prepared = tokio::time::timeout(
            GALADRIEL_STARTUP_TIMEOUT,
            tauri::async_runtime::spawn_blocking(|| {
                let config = preflight_galadriel_fusion_config()?;
                Ok::<_, String>(MultiSensorFusion::new(config))
            }),
        )
        .await;
        let fusion = match prepared {
            Ok(Ok(Ok(fusion))) => fusion,
            Ok(Ok(Err(error))) => {
                fail_galadriel_startup(error);
                return;
            }
            Ok(Err(error)) => {
                fail_galadriel_startup(format!(
                    "configuration preflight task did not complete: {error}"
                ));
                return;
            }
            Err(_) => {
                fail_galadriel_startup(format!(
                    "configuration preflight exceeded {} seconds",
                    GALADRIEL_STARTUP_TIMEOUT.as_secs()
                ));
                return;
            }
        };

        // Shutdown can win while the read-only configuration preflight is
        // running. Do not open a transport after the process has denied new
        // Galadriel work. The optional JSONL archive opens on the first active
        // frame under the same pipeline guard as frame admission.
        if GALADRIEL_LIFECYCLE.load(Ordering::Acquire) != GALADRIEL_LIFECYCLE_STARTING {
            return;
        }

        let runtime = match tokio::time::timeout(
            GALADRIEL_STARTUP_TIMEOUT,
            galadriel_producer::start_from_env(),
        )
        .await
        {
            Ok(Ok(Some(runtime))) => runtime,
            Ok(Ok(None)) => {
                fail_galadriel_startup(
                    "enabled startup unexpectedly resolved to a disabled producer",
                );
                return;
            }
            Ok(Err(error)) => {
                fail_galadriel_startup(error.to_string());
                return;
            }
            Err(_) => {
                fail_galadriel_startup(format!(
                    "secure transport startup exceeded {} seconds",
                    GALADRIEL_STARTUP_TIMEOUT.as_secs()
                ));
                return;
            }
        };

        let status = runtime.handle().status();
        match install_galadriel_runtime(fusion, runtime) {
            Ok(GaladrielInstallOutcome::Active) => {
                log::info!(
                    "Galadriel producer ready for epoch {} with pinned fusion configuration",
                    status.epoch
                );
            }
            Ok(GaladrielInstallOutcome::Rejected(runtime)) => runtime.shutdown().await,
            Err((error, runtime)) => {
                fail_galadriel_startup(error);
                runtime.shutdown().await;
            }
        }
    });

    // Do not let an unexpected panic or runtime cancellation strand the public
    // lifecycle in STARTING. All expected failures above report their specific
    // cause. This supervisor is the final fail-closed guard for the task itself.
    tauri::async_runtime::spawn(async move {
        if let Err(error) = startup_task.await {
            fail_galadriel_startup(format!("Galadriel startup task did not complete: {error}"));
        }
    });
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
        .map(try_lock_galadriel_frame_pipeline)
        .transpose()?;
    #[cfg(feature = "ncp")]
    if let Some(handle) = handle.as_ref() {
        let initialized = try_lock_fusion_engine()?.is_some();
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

    let mut guard = try_lock_fusion_engine()?;
    *guard = Some(fusion);

    log::info!("Sensor fusion engine initialized");
    Ok(())
}

/// JSONL sink for the galadriel innovation sidecar (`CREBAIN_PID_JSONL`).
///
/// Legacy, non-NCP use remains best-effort. An enabled Galadriel runtime opens
/// the file on its first active frame and permanently degrades its epoch if the
/// bounded archive later loses a record. Callers release `FUSION_ENGINE` before
/// invoking this sink.
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
fn ensure_pid_jsonl_sink_available() -> Result<(), String> {
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
        let archive_result = ensure_pid_jsonl_sink_available()
            .and_then(|()| enqueue_pid_jsonl_archive(observations.clone(), &handle));
        if let Err(error) = archive_result {
            handle.mark_degraded();
            summary.degraded = true;
            summary.truncated = true;
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
    let admission_permit = FUSION_PROCESS_ADMISSION
        .try_reserve()
        .ok_or_else(|| FUSION_PROCESS_BUSY_ERROR.to_string())?;
    let task = tauri::async_runtime::spawn_blocking(move || {
        // Cancellation of the command future must not admit a second batch
        // while this blocking operation still owns the mutable engine.
        let _admission_permit = admission_permit;
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
    let guard = try_lock_fusion_engine()?;

    let fusion = guard.as_ref().ok_or("Fusion engine not initialized")?;
    Ok(fusion.get_tracks())
}

/// Get fusion statistics
#[tauri::command]
fn fusion_get_stats() -> Result<FusionStats, String> {
    let guard = try_lock_fusion_engine()?;

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
        .map(try_lock_galadriel_frame_pipeline)
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
    let mut guard = try_lock_fusion_engine()?;

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
        .map(try_lock_galadriel_frame_pipeline)
        .transpose()?;
    {
        let mut guard = try_lock_fusion_engine()?;

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

            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            {
                log::warn!("Running on unsupported platform - limited functionality");
            }

            #[cfg(target_os = "macos")]
            match app.path().resource_dir() {
                Ok(resource_dir) => inference::coreml::register_packaged_model_path(
                    resource_dir.join("resources/yolov8s.mlmodelc"),
                ),
                Err(error) => log::warn!(
                    "Could not resolve the packaged CoreML resource directory: {error}"
                ),
            }

            // Model discovery, provider initialization, and warmup can take seconds.
            // Keep Tauri setup responsive so diagnostics and scene IPC remain usable.
            tauri::async_runtime::spawn(async move {
                let initialized = tauri::async_runtime::spawn_blocking(|| {
                    inference::production_runtime().initialize()
                })
                .await;

                match initialized {
                    Ok(Ok(backend)) => {
                        log::info!("Production inference runtime ready with {backend} backend");
                    }
                    Ok(Err(inference::InferenceError::RuntimeBusy)) => {
                        log::info!(
                            "Production inference initialization is already owned by another admitted request"
                        );
                    }
                    Ok(Err(error)) => {
                        // The cached failed state makes subsequent frame requests fail closed
                        // without repeating model or TensorRT engine initialization.
                        log::error!("Production inference runtime is unavailable: {error}");
                    }
                    Err(error) => {
                        log::error!("Production inference startup task did not complete: {error}");
                    }
                }
            });

            #[cfg(feature = "ncp")]
            let galadriel_enabled =
                galadriel_enabled_from_env().map_err(std::io::Error::other)?;

            #[cfg(not(feature = "ncp"))]
            let fusion_config = {
                reject_galadriel_enable_without_feature()
                    .map_err(std::io::Error::other)?;
                prepared_fusion_config(FusionConfig::default())
                    .map_err(std::io::Error::other)?
            };

            #[cfg(feature = "ncp")]
            if galadriel_enabled {
                spawn_galadriel_startup();
                log::info!("Galadriel producer configuration accepted; startup is asynchronous");
            } else {
                let fusion = MultiSensorFusion::new(
                    prepared_fusion_config(FusionConfig::default())
                        .map_err(std::io::Error::other)?,
                );
                let runtime_guard = GALADRIEL_RUNTIME
                    .lock()
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                if runtime_guard.is_some() {
                    return Err(std::io::Error::other(
                        "Galadriel producer runtime was initialized more than once",
                    )
                    .into());
                }
                drop(runtime_guard);
                let mut fusion_guard = FUSION_ENGINE
                    .lock()
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                *fusion_guard = Some(fusion);
                log::info!("Sensor fusion engine initialized without Galadriel publication");
            }

            #[cfg(not(feature = "ncp"))]
            {
                let fusion = MultiSensorFusion::new(fusion_config);
                let mut fusion_guard = FUSION_ENGINE
                    .lock()
                    .map_err(|error| std::io::Error::other(error.to_string()))?;
                *fusion_guard = Some(fusion);
                log::info!("Sensor fusion engine initialized with deployment configuration");
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
    fn fusion_process_admission_is_single_flight_and_recovers() {
        let admission = FusionProcessAdmission::default();
        let first = admission.try_reserve().expect("first batch must enter");
        assert!(admission.try_reserve().is_none());
        drop(first);
        assert!(admission.try_reserve().is_some());
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
    fn native_detection_admission_fails_fast_without_running_a_second_job() {
        use std::sync::mpsc;

        let admission = NativeDetectionAdmission::new(1, 8);
        let first_admission = admission.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let second_called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let second_called_from_task = Arc::clone(&second_called);

        let (first, second, third, admitted_while_blocked) =
            tauri::async_runtime::block_on(async {
                let first = tauri::async_runtime::spawn(async move {
                    execute_admitted_native_detection(&first_admission, 4, move || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        NativeDetectionResponse::failure("Fixture", "first completed")
                    })
                    .await
                });
                entered_rx
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap();

                let admitted_while_blocked = admission.in_flight();
                let second = execute_admitted_native_detection(&admission, 4, move || {
                    second_called_from_task.store(true, Ordering::Release);
                    NativeDetectionResponse::failure("Fixture", "second ran")
                })
                .await;

                release_tx.send(()).unwrap();
                let first = first.await.unwrap();
                let third = execute_admitted_native_detection(&admission, 8, || {
                    NativeDetectionResponse::failure("Fixture", "third completed")
                })
                .await;
                (first, second, third, admitted_while_blocked)
            });

        assert_eq!(admitted_while_blocked, (1, 4));
        assert_eq!(first.error.as_deref(), Some("first completed"));
        assert_eq!(second.error.as_deref(), Some(NATIVE_DETECTION_BUSY_ERROR));
        assert!(!second_called.load(Ordering::Acquire));
        assert_eq!(third.error.as_deref(), Some("third completed"));
        assert_eq!(admission.in_flight(), (0, 0));
    }

    #[test]
    fn native_detection_admission_bounds_bytes_and_rolls_back_job_charge() {
        let admission = NativeDetectionAdmission::new(3, 8);
        let first = admission.try_reserve(6).unwrap();

        assert_eq!(
            admission.try_reserve(3).unwrap_err(),
            NativeDetectionAdmissionRejection::ByteLimit
        );
        assert_eq!(admission.in_flight(), (1, 6));

        let second = admission.try_reserve(2).unwrap();
        assert_eq!(admission.in_flight(), (2, 8));
        drop((first, second));
        assert_eq!(admission.in_flight(), (0, 0));
    }

    #[test]
    fn native_detection_admission_recovers_after_detector_panic_and_error() {
        let admission = NativeDetectionAdmission::new(1, 4);
        let panic_response = tauri::async_runtime::block_on(execute_admitted_native_detection(
            &admission,
            4,
            || panic!("detector fixture panic"),
        ));

        assert_eq!(
            panic_response.error.as_deref(),
            Some("native detector panicked while processing the frame")
        );
        assert_eq!(admission.in_flight(), (0, 0));

        let error_response = tauri::async_runtime::block_on(execute_admitted_native_detection(
            &admission,
            4,
            || NativeDetectionResponse::failure("Fixture", "backend error"),
        ));
        assert_eq!(error_response.error.as_deref(), Some("backend error"));
        assert_eq!(admission.in_flight(), (0, 0));
    }

    #[test]
    fn native_detection_admission_outlives_cancelled_command_future() {
        use std::sync::mpsc;

        let admission = NativeDetectionAdmission::new(1, 4);
        let task_admission = admission.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let (cancelled, rejected_while_blocking, released) =
            tauri::async_runtime::block_on(async {
                let task = tauri::async_runtime::spawn(async move {
                    execute_admitted_native_detection(&task_admission, 4, move || {
                        entered_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        NativeDetectionResponse::failure("Fixture", "completed after cancellation")
                    })
                    .await
                });
                entered_rx
                    .recv_timeout(std::time::Duration::from_secs(2))
                    .unwrap();

                task.abort();
                let rejected_while_blocking = matches!(
                    admission.try_reserve(1),
                    Err(NativeDetectionAdmissionRejection::ConcurrentJobLimit)
                );
                release_tx.send(()).unwrap();
                let cancelled = task.await.is_err();
                let released = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    while admission.in_flight() != (0, 0) {
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                })
                .await
                .is_ok();
                (cancelled, rejected_while_blocking, released)
            });

        assert!(cancelled);
        assert!(rejected_while_blocking);
        assert!(released);
        assert!(admission.try_reserve(4).is_ok());
    }

    #[test]
    fn native_detection_busy_response_is_structured_and_stable() {
        let response = NativeDetectionResponse::busy();

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
                NATIVE_DETECTION_BUSY_BACKEND,
                Some(NATIVE_DETECTION_BUSY_ERROR),
            )
        );
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
        for key in ["cameras", "assets", "drones", "recentDetections"] {
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
        for invalid in ["/valid\0topic", "/camera/", "/camera//raw"] {
            assert!(transport::commands::validate_topic_for_test(invalid).is_err());
        }
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

    fn current_scene_fixture() -> serde_json::Value {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/state/__fixtures__/sceneContractCases.json"
        ))
        .expect("shared scene-contract corpus must parse");
        corpus["current"].clone()
    }

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
        let valid_json = current_scene_fixture();
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
    fn serialized_ipc_round_trips_the_complete_scene_contract() {
        let app = MockIpcApp::new();
        let scene = current_scene_fixture();

        let response = app
            .invoke(
                "scene_save_file",
                serde_json::json!({ "path": "round-trip.json", "json": scene.to_string() }),
            )
            .expect("complete scene must save");
        assert!(response.is_null());

        let response = app
            .invoke(
                "scene_load_file",
                serde_json::json!({ "path": "round-trip.json" }),
            )
            .expect("saved scene must load");
        let loaded: serde_json::Value = serde_json::from_str(
            response
                .as_str()
                .expect("scene load response must contain JSON text"),
        )
        .expect("loaded scene text must parse");
        assert_eq!(loaded, scene);
    }

    #[test]
    fn serialized_ipc_rejects_incomplete_current_scenes_before_writing() {
        let app = MockIpcApp::new();
        let mut cases = Vec::new();

        let mut missing_settings = current_scene_fixture();
        missing_settings
            .as_object_mut()
            .expect("fixture must be an object")
            .remove("settings");
        cases.push(("missing-settings.json", missing_settings));

        let mut incomplete_view = current_scene_fixture();
        incomplete_view["viewCamera"] = serde_json::json!({});
        cases.push(("incomplete-view.json", incomplete_view));

        let mut unknown_drone = current_scene_fixture();
        unknown_drone["drones"][0]["type"] = serde_json::json!("not-installed");
        cases.push(("unknown-drone.json", unknown_drone));

        let mut duplicate_id = current_scene_fixture();
        let camera_id = duplicate_id["cameras"][0]["id"].clone();
        duplicate_id["assets"][0]["id"] = camera_id;
        cases.push(("duplicate-id.json", duplicate_id));

        for (path, scene) in cases {
            app.assert_error_contains(
                "scene_save_file",
                serde_json::json!({ "path": path, "json": scene.to_string() }),
                "scene",
            );
            assert!(
                !app.scenes_dir.join(path).exists(),
                "invalid current scene was persisted at {path}"
            );
        }
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
                "transport_subscribe_camera_info"
                    | "transport_subscribe_imu"
                    | "transport_subscribe_pose"
                    | "transport_subscribe_model_states"
                    | "transport_unsubscribe"
            ) {
                body["subscriptionId"] = serde_json::Value::String("1".to_string());
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
