//! CUDA Backend (Linux with NVIDIA GPU)
//!
//! This module provides CUDA-accelerated inference by delegating to the ONNX
//! Runtime with CUDA execution provider. For more optimized NVIDIA inference,
//! use the TensorRT backend instead.

use super::{
    validate_rgba_input_len, Backend, Detection, Detector, InferenceError, InferenceStats, Result,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// CUDA detector using ONNX Runtime with CUDA execution provider
///
/// This provides CUDA execution-provider inference on NVIDIA hardware via ONNX Runtime.
/// TensorRT may be preferred when deployment-specific benchmarking supports it.
pub struct CudaDetector {
    inference_count: AtomicU64,
    total_inference_ms: AtomicU64,
    model_load_ms: f64,
}

impl CudaDetector {
    /// Create a new CUDA detector
    pub fn new() -> Result<Self> {
        if !is_available() {
            return Err(InferenceError::BackendNotAvailable(Backend::CUDA));
        }

        let start = Instant::now();

        // Initialize the global ONNX detector which uses CUDA on Linux
        if !crate::onnx_detector::is_onnx_detector_ready() {
            crate::onnx_detector::init_global_detector()
                .map_err(|e| InferenceError::ModelLoadError(e))?;
        }

        let model_load_ms = start.elapsed().as_secs_f64() * 1000.0;
        log::info!("[CUDA] Initialized via ONNX Runtime with CUDA execution provider");

        Ok(Self {
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms,
        })
    }
}

impl Detector for CudaDetector {
    fn backend(&self) -> Backend {
        Backend::CUDA
    }

    fn warmup(&mut self) -> Result<()> {
        log::info!("[CUDA] Warmup already done during init");
        Ok(())
    }

    fn detect(&self, data: &[u8], width: u32, height: u32) -> Result<Vec<Detection>> {
        let start = Instant::now();

        validate_rgba_input_len(data.len(), width, height)?;

        // Delegate to ONNX Runtime (which uses CUDA on Linux)
        let result = crate::onnx_detector::detect_with_onnx(data, width, height)
            .map(|res| {
                res.detections
                    .into_iter()
                    .map(|d| Detection {
                        bbox: [d.bbox.x1, d.bbox.y1, d.bbox.x2, d.bbox.y2],
                        confidence: d.confidence,
                        class_id: d.class_index.max(0) as u32,
                        class_label: d.class_label,
                    })
                    .collect()
            })
            .map_err(|e| InferenceError::InferenceError(e));

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
            backend: "CUDA (ONNX Runtime)".to_string(),
        }
    }
}

/// Check if CUDA is available
pub fn is_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        // Prefer checking ONNX Runtime execution provider availability since
        // `nvidia-smi` may not be present in minimal/containerized deployments.
        use ort::execution_providers::{CUDAExecutionProvider, ExecutionProvider};

        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            CUDAExecutionProvider::default()
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
