//! ONNX Runtime Backend
//!
//! This module provides the Detector trait implementation that delegates to
//! the real ONNX Runtime implementation in `src/onnx_detector.rs`.

use super::{
    validate_rgba_input_len, Backend, Detection, Detector, InferenceError, InferenceStats, Result,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// ONNX Runtime detector
///
/// This delegates to the real ONNX implementation for actual inference.
pub struct OnnxDetector {
    inference_count: AtomicU64,
    total_inference_ms: AtomicU64,
    model_load_ms: f64,
}

impl OnnxDetector {
    /// Create a new ONNX detector
    pub fn new() -> Result<Self> {
        let start = Instant::now();

        // Initialize the global ONNX detector if not already done
        if !crate::onnx_detector::is_onnx_detector_ready() {
            crate::onnx_detector::init_global_detector().map_err(InferenceError::ModelLoadError)?;
        }

        let model_load_ms = start.elapsed().as_secs_f64() * 1000.0;

        Ok(Self {
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms,
        })
    }
}

impl Detector for OnnxDetector {
    fn backend(&self) -> Backend {
        Backend::ONNX
    }

    fn warmup(&mut self) -> Result<()> {
        log::info!("[ONNX] Warmup already done during init");
        Ok(())
    }

    fn detect(&self, data: &[u8], width: u32, height: u32) -> Result<Vec<Detection>> {
        let start = Instant::now();

        validate_rgba_input_len(data.len(), width, height)?;

        // Delegate to the real ONNX implementation
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
            .map_err(InferenceError::InferenceError);

        // Update stats
        let elapsed_ms = start.elapsed().as_millis() as u64;
        self.inference_count.fetch_add(1, Ordering::Relaxed);
        self.total_inference_ms
            .fetch_add(elapsed_ms, Ordering::Relaxed);

        result
    }

    fn stats(&self) -> InferenceStats {
        let count = self.inference_count.load(Ordering::Relaxed);
        let total_ms = self.total_inference_ms.load(Ordering::Relaxed);
        let avg_ms = if count > 0 {
            total_ms as f64 / count as f64
        } else {
            0.0
        };

        InferenceStats {
            avg_inference_ms: avg_ms,
            total_inferences: count,
            model_load_ms: self.model_load_ms,
            backend: "ONNX".to_string(),
        }
    }
}

/// Check if ONNX Runtime is available
pub fn is_available() -> bool {
    // ONNX Runtime is always available as a fallback
    true
}
