//! MLX Backend (macOS Apple Silicon)
//!
//! High-performance ML inference using Candle with Metal GPU backend.
//! Provides MLX-style tensor operations on Apple Silicon.
//!
//! ## Status
//! This backend is a scaffold: preprocessing/postprocessing are implemented, but
//! the YOLOv8 forward pass is not yet wired up. `detect()` currently returns an
//! empty set of detections (the forward pass returns a zeroed output tensor).
//! See `README.md` "Development Roadmap" for the current MLX status.
//!
//! # Model Format
//! Models are loaded from safetensors format (compatible with MLX/PyTorch).
//! Convert ONNX/PyTorch models using:
//! ```bash
//! python -c "from safetensors.torch import save_file; import torch; \
//!   model = torch.load('yolov8s.pt'); save_file(model, 'yolov8s.safetensors')"
//! ```

use super::{Backend, Detection, Detector, InferenceError, InferenceStats, Result};
use crate::common::coco;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use candle_core::{Device, Tensor, DType};

// Model configuration
const INPUT_SIZE: usize = 640;
const CONF_THRESHOLD: f32 = 0.25;
const IOU_THRESHOLD: f32 = 0.45;

/// MLX detector for Apple Silicon using Candle Metal backend
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub struct MlxDetector {
    device: Device,
    model_weights: std::collections::HashMap<String, Tensor>,
    inference_count: AtomicU64,
    total_inference_ms: AtomicU64,
    model_load_ms: f64,
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub struct MlxDetector {
    inference_count: AtomicU64,
    total_inference_ms: AtomicU64,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl MlxDetector {
    /// Create a new MLX detector with Metal GPU acceleration
    pub fn new() -> Result<Self> {
        let start = Instant::now();

        // Initialize Metal device
        let device = Device::new_metal(0).map_err(|e| {
            InferenceError::BackendError(format!("Failed to initialize Metal device: {}", e))
        })?;

        log::info!("[MLX] Metal device initialized on Apple Silicon");

        // Find model file
        let model_path = find_model_path()?;
        log::info!("[MLX] Loading model from: {}", model_path);

        // Load safetensors weights
        let model_weights = load_safetensors(&model_path, &device)?;

        let model_load_ms = start.elapsed().as_secs_f64() * 1000.0;
        log::info!("[MLX] Model loaded in {:.2}ms ({} tensors)",
            model_load_ms, model_weights.len());

        Ok(Self {
            device,
            model_weights,
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms,
        })
    }

    /// Run YOLOv8 inference
    fn run_inference(&self, input: &Tensor) -> Result<Tensor> {
        // NOTE: The MLX backend is currently a scaffold; the full YOLOv8 forward
        // pass is not implemented yet. We return a shape-correct output tensor
        // (postprocess -> empty detections) so the rest of the pipeline can be
        // exercised without panicking.
        if self.model_weights.is_empty() {
            log::debug!("[MLX] No model weights loaded, returning empty detections");
            // Return dummy output shape [1, 84, 8400] for YOLOv8
            let output = Tensor::zeros((1, 84, 8400), DType::F32, &self.device)
                .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
            return Ok(output);
        }

        // Optional wiring test (first conv+SiLU), then a zeroed YOLOv8 output.
        self.yolov8_forward(input)
    }

    /// YOLOv8 forward pass (simplified)
    fn yolov8_forward(&self, x: &Tensor) -> Result<Tensor> {
        // YOLOv8s has:
        // - CSPDarknet backbone
        // - PAFPN neck
        // - Detection head
        //
        // NOTE: Minimal wiring only. This is not a real YOLOv8 forward pass yet:
        // we optionally apply the first conv+SiLU, then return a zeroed tensor
        // shaped like YOLOv8 output ([B, 84, 8400]).

        let mut out = x.clone();

        // Apply first conv if available
        if let Some(conv0_w) = self.model_weights.get("model.0.conv.weight") {
            if let Some(conv0_b) = self.model_weights.get("model.0.conv.bias") {
                out = self.conv2d(&out, conv0_w, Some(conv0_b), 1, 1)?;
                out = self.silu(&out)?;
            }
        }

        // Return zeros: postprocessing yields no detections. Use the CoreML
        // backend on macOS for real inference until MLX forward pass lands.
        let batch_size = out.dim(0).unwrap_or(1);
        let output = Tensor::zeros((batch_size, 84, 8400), DType::F32, &self.device)
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

        Ok(output)
    }

    /// 2D convolution
    fn conv2d(&self, x: &Tensor, _weight: &Tensor, bias: Option<&Tensor>, _stride: usize, _padding: usize) -> Result<Tensor> {
        // Get dimensions
        let x_shape = x.dims();
        if x_shape.len() != 4 {
            return Err(InferenceError::InvalidInput("Expected 4D input tensor".to_string()));
        }

        // NOTE: Placeholder implementation. We do not perform a convolution yet;
        // we only validate shape and optionally add a bias tensor. A real
        // implementation would use Candle's conv2d (where available) or a Metal
        // kernel (e.g. MPS) and honor stride/padding.
        let result = x.clone();

        // Apply bias if present
        if let Some(b) = bias {
            let b_reshaped = b.reshape((1, b.dim(0).unwrap_or(1), 1, 1))
                .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
            return result.broadcast_add(&b_reshaped)
                .map_err(|e| InferenceError::InferenceError(e.to_string()));
        }

        Ok(result)
    }

    /// SiLU activation (x * sigmoid(x))
    fn silu(&self, x: &Tensor) -> Result<Tensor> {
        let sigmoid = (x.neg().map_err(|e| InferenceError::InferenceError(e.to_string()))?
            .exp().map_err(|e| InferenceError::InferenceError(e.to_string()))?
            + 1.0).map_err(|e| InferenceError::InferenceError(e.to_string()))?
            .recip().map_err(|e| InferenceError::InferenceError(e.to_string()))?;

        x.mul(&sigmoid).map_err(|e| InferenceError::InferenceError(e.to_string()))
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
impl MlxDetector {
    pub fn new() -> Result<Self> {
        Err(InferenceError::BackendNotAvailable(Backend::MLX))
    }
}

impl Detector for MlxDetector {
    fn backend(&self) -> Backend {
        Backend::MLX
    }

    fn warmup(&mut self) -> Result<()> {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            log::info!("[MLX] Warming up Metal GPU pipeline...");

            // Create dummy input
            let dummy = Tensor::zeros((1, 3, INPUT_SIZE, INPUT_SIZE), DType::F32, &self.device)
                .map_err(|e| InferenceError::BackendError(e.to_string()))?;

            // Run warmup inference
            let _ = self.run_inference(&dummy)?;

            // Sync Metal device
            self.device.synchronize()
                .map_err(|e| InferenceError::BackendError(format!("Metal sync failed: {}", e)))?;

            log::info!("[MLX] Metal GPU warmed up");
        }
        Ok(())
    }

    fn detect(&self, data: &[u8], width: u32, height: u32) -> Result<Vec<Detection>> {
        let start = Instant::now();

        let expected_size = (width * height * 4) as usize;
        if data.len() != expected_size {
            return Err(InferenceError::InvalidInput(format!(
                "Expected {} bytes ({}x{}x4), got {}",
                expected_size, width, height, data.len()
            )));
        }

        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            // Preprocess: RGBA -> RGB, normalize, resize
            let input = preprocess_image(data, width, height, &self.device)?;

            // Run inference
            let output = self.run_inference(&input)?;

            // Postprocess: parse detections, NMS
            let detections = postprocess_output(&output, width as f32, height as f32)?;

            let elapsed_ms = start.elapsed().as_millis() as u64;
            self.inference_count.fetch_add(1, Ordering::Relaxed);
            self.total_inference_ms.fetch_add(elapsed_ms, Ordering::Relaxed);

            log::debug!("[MLX] Inference completed in {}ms, {} detections",
                elapsed_ms, detections.len());

            Ok(detections)
        }

        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        {
            let _ = (data, width, height);
            Ok(Vec::new())
        }
    }

    fn stats(&self) -> InferenceStats {
        let count = self.inference_count.load(Ordering::Relaxed);
        let total_ms = self.total_inference_ms.load(Ordering::Relaxed);

        InferenceStats {
            avg_inference_ms: if count > 0 { total_ms as f64 / count as f64 } else { 0.0 },
            total_inferences: count,
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            model_load_ms: self.model_load_ms,
            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            model_load_ms: 0.0,
            backend: "MLX (Candle Metal)".to_string(),
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPER FUNCTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/// Check if MLX is available (Apple Silicon only)
pub fn is_available() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        // Check for Metal support.
        // Candle's Metal initialization can panic on some configurations (e.g. no
        // Metal devices available), so guard this probe to avoid crashing.
        std::panic::catch_unwind(|| Device::new_metal(0).is_ok()).unwrap_or(false)
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        false
    }
}

/// Find model file path
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn find_model_path() -> Result<String> {
    // Check environment variable first
    if let Ok(path) = std::env::var("CREBAIN_MLX_MODEL") {
        if std::path::Path::new(&path).exists() {
            return Ok(path);
        }
    }

    // Search common locations
    let search_paths = [
        "resources/yolov8s.safetensors",
        "models/yolov8s.safetensors",
        "../resources/yolov8s.safetensors",
        "~/.crebain/models/yolov8s.safetensors",
        "/opt/crebain/models/yolov8s.safetensors",
    ];

    for path in &search_paths {
        let expanded = shellexpand::tilde(path).to_string();
        if std::path::Path::new(&expanded).exists() {
            return Ok(expanded);
        }
    }

    // Return default path (model may not exist yet)
    Ok("resources/yolov8s.safetensors".to_string())
}

/// Load safetensors model weights
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn load_safetensors(path: &str, device: &Device) -> Result<std::collections::HashMap<String, Tensor>> {
    use safetensors::SafeTensors;
    use std::collections::HashMap;

    // Check if file exists
    if !std::path::Path::new(path).exists() {
        log::warn!("[MLX] Model file not found: {}", path);
        log::warn!("[MLX] Running without model weights (will return empty detections)");
        return Ok(HashMap::new());
    }

    // Load file
    let data = std::fs::read(path)
        .map_err(|e| InferenceError::ModelLoadError(format!("Failed to read model: {}", e)))?;

    // Parse safetensors
    let tensors = SafeTensors::deserialize(&data)
        .map_err(|e| InferenceError::ModelLoadError(format!("Failed to parse safetensors: {}", e)))?;

    let mut weights = HashMap::new();

    for (name, tensor_view) in tensors.tensors() {
        let shape: Vec<usize> = tensor_view.shape().to_vec();
        let dtype = match tensor_view.dtype() {
            safetensors::Dtype::F32 => DType::F32,
            safetensors::Dtype::F16 => DType::F16,
            safetensors::Dtype::BF16 => DType::BF16,
            _ => continue, // Skip unsupported dtypes
        };

        // Get raw bytes and convert to tensor
        let bytes = tensor_view.data();

        // Create tensor from bytes
        let tensor = match dtype {
            DType::F32 => {
                let floats: Vec<f32> = bytes.chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect();
                Tensor::from_vec(floats, shape.as_slice(), device)
            }
            DType::F16 => {
                let halfs: Vec<half::f16> = bytes.chunks_exact(2)
                    .map(|b| half::f16::from_le_bytes([b[0], b[1]]))
                    .collect();
                // Convert to f32 for processing
                let floats: Vec<f32> = halfs.iter().map(|h| h.to_f32()).collect();
                Tensor::from_vec(floats, shape.as_slice(), device)
            }
            _ => continue,
        };

        if let Ok(t) = tensor {
            weights.insert(name.to_string(), t);
        }
    }

    Ok(weights)
}

/// Preprocess image for YOLOv8 input
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn preprocess_image(data: &[u8], width: u32, height: u32, device: &Device) -> Result<Tensor> {
    // RGBA to RGB, normalize to [0, 1]
    let mut rgb_data: Vec<f32> = Vec::with_capacity((width * height * 3) as usize);

    for chunk in data.chunks_exact(4) {
        rgb_data.push(chunk[0] as f32 / 255.0); // R
        rgb_data.push(chunk[1] as f32 / 255.0); // G
        rgb_data.push(chunk[2] as f32 / 255.0); // B
    }

    // Create tensor [H, W, C]
    let tensor = Tensor::from_vec(
        rgb_data,
        &[height as usize, width as usize, 3],
        device,
    ).map_err(|e| InferenceError::InvalidInput(e.to_string()))?;

    // Transpose to [C, H, W]
    let tensor = tensor.permute((2, 0, 1))
        .map_err(|e| InferenceError::InvalidInput(e.to_string()))?;

    // Resize to INPUT_SIZE x INPUT_SIZE using bilinear interpolation
    let tensor = resize_tensor(&tensor, INPUT_SIZE, INPUT_SIZE, device)?;

    // Add batch dimension [1, C, H, W]
    let tensor = tensor.unsqueeze(0)
        .map_err(|e| InferenceError::InvalidInput(e.to_string()))?;

    Ok(tensor)
}

/// Resize tensor using nearest neighbor (fast approximation)
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn resize_tensor(tensor: &Tensor, target_h: usize, target_w: usize, device: &Device) -> Result<Tensor> {
    let dims = tensor.dims();
    if dims.len() != 3 {
        return Err(InferenceError::InvalidInput("Expected 3D tensor [C, H, W]".to_string()));
    }

    let (channels, src_h, src_w) = (dims[0], dims[1], dims[2]);

    // If already target size, return clone
    if src_h == target_h && src_w == target_w {
        return Ok(tensor.clone());
    }

    // Simple nearest neighbor resize
    let scale_y = src_h as f32 / target_h as f32;
    let scale_x = src_w as f32 / target_w as f32;

    // Get tensor data as Vec<f32>
    let data = tensor.flatten_all()
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?
        .to_vec1::<f32>()
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

    let mut resized = vec![0.0f32; channels * target_h * target_w];

    for c in 0..channels {
        for y in 0..target_h {
            for x in 0..target_w {
                let src_y = ((y as f32 * scale_y) as usize).min(src_h - 1);
                let src_x = ((x as f32 * scale_x) as usize).min(src_w - 1);

                let src_idx = c * src_h * src_w + src_y * src_w + src_x;
                let dst_idx = c * target_h * target_w + y * target_w + x;

                resized[dst_idx] = data[src_idx];
            }
        }
    }

    Tensor::from_vec(resized, &[channels, target_h, target_w], device)
        .map_err(|e| InferenceError::InferenceError(e.to_string()))
}

/// Postprocess YOLOv8 output to detections
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn postprocess_output(output: &Tensor, orig_width: f32, orig_height: f32) -> Result<Vec<Detection>> {
    // YOLOv8 output shape: [1, 84, 8400]
    // 84 = 4 (bbox) + 80 (classes)
    // 8400 = number of anchor boxes

    let dims = output.dims();
    if dims.len() != 3 || dims[1] != 84 {
        return Ok(Vec::new());
    }

    let num_anchors = dims[2];

    // Flatten and get data
    let data = output.flatten_all()
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?
        .to_vec1::<f32>()
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

    // Parse detections
    let mut detections: Vec<Detection> = Vec::new();

    // Scale factors
    let scale_x = orig_width / INPUT_SIZE as f32;
    let scale_y = orig_height / INPUT_SIZE as f32;

    for i in 0..num_anchors {
        // Get bbox: [cx, cy, w, h] at positions 0-3
        let cx = data[i];
        let cy = data[num_anchors + i];
        let w = data[2 * num_anchors + i];
        let h = data[3 * num_anchors + i];

        // Find max class score
        let mut max_score = 0.0f32;
        let mut max_class = 0usize;

        for c in 0..80 {
            let score = data[(4 + c) * num_anchors + i];
            if score > max_score {
                max_score = score;
                max_class = c;
            }
        }

        // Filter by confidence
        if max_score < CONF_THRESHOLD {
            continue;
        }

        // Convert to [x1, y1, x2, y2]
        let x1 = (cx - w / 2.0) * scale_x;
        let y1 = (cy - h / 2.0) * scale_y;
        let x2 = (cx + w / 2.0) * scale_x;
        let y2 = (cy + h / 2.0) * scale_y;

        // Clamp to image bounds
        let x1 = x1.max(0.0).min(orig_width);
        let y1 = y1.max(0.0).min(orig_height);
        let x2 = x2.max(0.0).min(orig_width);
        let y2 = y2.max(0.0).min(orig_height);

        detections.push(Detection {
            bbox: [x1, y1, x2, y2],
            confidence: max_score,
            class_id: max_class as u32,
            class_label: coco::get_class_name_ref(max_class)
                .unwrap_or("unknown")
                .to_string(),
        });
    }

    // Apply NMS
    let detections = non_max_suppression(detections, IOU_THRESHOLD);

    Ok(detections)
}

/// Non-maximum suppression
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn non_max_suppression(mut detections: Vec<Detection>, iou_threshold: f32) -> Vec<Detection> {
    // Sort by confidence (descending)
    // Use unwrap_or for NaN-safe comparison (NaN treated as less than any value)
    detections.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut keep = Vec::new();
    let mut suppressed = vec![false; detections.len()];

    for i in 0..detections.len() {
        if suppressed[i] {
            continue;
        }

        keep.push(detections[i].clone());

        for j in (i + 1)..detections.len() {
            if suppressed[j] {
                continue;
            }

            // Only suppress same class
            if detections[i].class_id != detections[j].class_id {
                continue;
            }

            let iou = compute_iou(&detections[i].bbox, &detections[j].bbox);
            if iou > iou_threshold {
                suppressed[j] = true;
            }
        }
    }

    keep
}

/// Compute IoU between two bboxes
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn compute_iou(box1: &[f32; 4], box2: &[f32; 4]) -> f32 {
    let x1 = box1[0].max(box2[0]);
    let y1 = box1[1].max(box2[1]);
    let x2 = box1[2].min(box2[2]);
    let y2 = box1[3].min(box2[3]);

    let inter_w = (x2 - x1).max(0.0);
    let inter_h = (y2 - y1).max(0.0);
    let inter_area = inter_w * inter_h;

    let area1 = (box1[2] - box1[0]) * (box1[3] - box1[1]);
    let area2 = (box2[2] - box2[0]) * (box2[3] - box2[1]);
    let union_area = area1 + area2 - inter_area;

    if union_area > 0.0 {
        inter_area / union_area
    } else {
        0.0
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TESTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_available() {
        let result = std::panic::catch_unwind(is_available);
        assert!(result.is_ok());
        let _available = result.unwrap();
        #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
        assert!(!_available);
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn test_iou_computation() {
        // Same box = IoU of 1.0
        let box1 = [0.0, 0.0, 10.0, 10.0];
        assert!((compute_iou(&box1, &box1) - 1.0).abs() < 0.001);

        // Non-overlapping boxes = IoU of 0.0
        let box2 = [20.0, 20.0, 30.0, 30.0];
        assert!(compute_iou(&box1, &box2) < 0.001);

        // 50% overlap
        let box3 = [5.0, 0.0, 15.0, 10.0];
        let iou = compute_iou(&box1, &box3);
        assert!(iou > 0.3 && iou < 0.4); // Should be ~1/3
    }
}
