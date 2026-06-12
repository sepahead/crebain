//! CoreML Backend (macOS)
//!
//! This module provides the Detector trait implementation that delegates to
//! the real CoreML FFI implementation in `src/coreml.rs`.

use super::{
    validate_rgba_input_len, Backend, Detection, Detector, InferenceError, InferenceStats, Result,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// CoreML detector using Vision framework
///
/// This delegates to the native CoreML implementation for actual inference.
pub struct CoreMlDetector {
    inference_count: AtomicU64,
    total_inference_ms: AtomicU64,
    model_load_ms: f64,
}

impl CoreMlDetector {
    /// Create a new CoreML detector
    pub fn new() -> Result<Self> {
        let start = Instant::now();

        // Try to use the real CoreML detector
        #[cfg(target_os = "macos")]
        {
            // Check if the real detector is already initialized
            if crate::coreml::NativeCoreMLDetector::get_global().is_none() {
                // Try common model paths
                // Check CREBAIN_MODEL_PATH env var first (validated for security)
                let mut model_paths: Vec<String> = Vec::new();
                if let Ok(env_path) = std::env::var("CREBAIN_MODEL_PATH") {
                    let trimmed = env_path.trim();
                    if !trimmed.is_empty() {
                        if let Ok(validated) =
                            crate::common::path::validate_model_path(trimmed, Some(&["mlmodelc"]))
                        {
                            model_paths.push(validated.to_string_lossy().to_string());
                        } else {
                            log::warn!(
                                "[CoreML] CREBAIN_MODEL_PATH '{}' failed validation, falling back to defaults",
                                trimmed
                            );
                        }
                    }
                }

                // Fall back to common default locations (validated for security)
                for fallback in &[
                    "resources/yolov8s.mlmodelc",
                    "../resources/yolov8s.mlmodelc",
                    "src-tauri/resources/yolov8s.mlmodelc",
                ] {
                    if let Ok(validated) =
                        crate::common::path::validate_model_path(fallback, Some(&["mlmodelc"]))
                    {
                        model_paths.push(validated.to_string_lossy().to_string());
                    }
                }

                let mut initialized = false;
                for path in &model_paths {
                    if std::path::Path::new(path).exists()
                        && crate::coreml::init_detector(path).is_ok()
                    {
                        initialized = true;
                        log::info!("[CoreML] Initialized with model: {}", path);
                        break;
                    }
                }

                if !initialized {
                    return Err(InferenceError::ModelLoadError(
                        "CoreML model not found. Set CREBAIN_MODEL_PATH or place model in resources/".to_string()
                    ));
                }
            }
        }

        #[cfg(not(target_os = "macos"))]
        {
            return Err(InferenceError::BackendNotAvailable(Backend::CoreML));
        }

        let model_load_ms = start.elapsed().as_secs_f64() * 1000.0;

        Ok(Self {
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms,
        })
    }
}

impl Detector for CoreMlDetector {
    fn backend(&self) -> Backend {
        Backend::CoreML
    }

    fn warmup(&mut self) -> Result<()> {
        log::info!("[CoreML] Warmup already done during init");
        Ok(())
    }

    fn detect(&self, data: &[u8], width: u32, height: u32) -> Result<Vec<Detection>> {
        let start = Instant::now();

        validate_rgba_input_len(data.len(), width, height)?;

        // Delegate to the real CoreML implementation
        #[cfg(target_os = "macos")]
        let result = {
            crate::coreml::detect_raw(data, width, height, 0.25, 100)
                .map(|res| {
                    res.detections
                        .into_iter()
                        .map(|d| Detection {
                            bbox: [
                                d.bbox.x1 as f32,
                                d.bbox.y1 as f32,
                                d.bbox.x2 as f32,
                                d.bbox.y2 as f32,
                            ],
                            confidence: d.confidence as f32,
                            class_id: d.class_index.max(0) as u32,
                            class_label: d.class_label,
                        })
                        .collect()
                })
                .map_err(InferenceError::InferenceError)
        };

        #[cfg(not(target_os = "macos"))]
        let result: Result<Vec<Detection>> =
            Err(InferenceError::BackendNotAvailable(Backend::CoreML));

        let elapsed_ms = start.elapsed().as_millis() as u64;
        self.inference_count.fetch_add(1, Ordering::Relaxed);
        self.total_inference_ms
            .fetch_add(elapsed_ms, Ordering::Relaxed);

        result
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
            backend: "CoreML".to_string(),
        }
    }
}

/// Check if CoreML is available
pub fn is_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}
