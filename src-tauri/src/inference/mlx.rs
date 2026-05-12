//! MLX Backend (macOS Apple Silicon)
//!
//! High-performance ML inference using Candle with Metal GPU backend.
//! Provides MLX-style tensor operations on Apple Silicon.
//!
//! ## Status
//! This backend is a scaffold: preprocessing/postprocessing are implemented, but
//! the YOLOv8 forward pass is not yet wired up. `detect()` returns an explicit
//! backend error instead of reporting fake empty detections.
//! See `README.md` "Development Roadmap" for the current MLX status.
//!
//! # Model Format
//! Models are loaded from safetensors format (compatible with MLX/PyTorch).
//! Convert ONNX/PyTorch models using:
//! ```bash
//! python -c "from safetensors.torch import save_file; import torch; \
//!   model = torch.load('yolov8s.pt'); save_file(model, 'yolov8s.safetensors')"
//! ```

use super::{Backend, Detection, Detector, InferenceError, InferenceStats, Result, validate_rgba_input_len};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::common::{coco, path};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use candle_core::{Device, Tensor, DType, Module, ModuleT};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use candle_nn::{Conv2dConfig, VarBuilder};

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
        let vb = VarBuilder::from_tensors(
            self.model_weights.clone(),
            DType::F32,
            &self.device,
        );
        let (p3, p4, p5) = self.yolov8_forward(input, &vb)?;
        detect_head(&vb.pp("model.22"), &p3, &p4, &p5)
    }

    /// YOLOv8 forward pass with optional per-layer timing.
    /// Set CREBAIN_PROFILE_MLX=1 to enable per-layer latency logging.
    fn yolov8_forward(&self, x: &Tensor, vb: &VarBuilder) -> Result<(Tensor, Tensor, Tensor)> {
        if x.dims().len() != 4 {
            return Err(InferenceError::InvalidInput("Expected 4D input tensor".to_string()));
        }

        let profile = std::env::var("CREBAIN_PROFILE_MLX").unwrap_or_default() == "1";
        let mut layer_times: Vec<(&str, f64)> = Vec::new();

        let prefix = |name: &str| vb.pp(name);

        macro_rules! timed {
            ($label:expr, $expr:expr) => {{
                let start = if profile { Some(Instant::now()) } else { None };
                let result = $expr;
                if let Some(s) = start {
                    layer_times.push(($label, s.elapsed().as_secs_f64() * 1000.0));
                }
                result
            }};
        }

        // ── Backbone ──────────────────────────────────────────────────
        // model.0: Conv(3->64, k=3, s=2)
        let x = timed!("model.0", conv_block(&prefix("model.0"), x, 64, 3, 2)?);
        // model.1: Conv(64->128, k=3, s=2)
        let x = timed!("model.1", conv_block(&prefix("model.1"), &x, 128, 3, 2)?);
        // model.2: C2f(128->128, n=3, shortcut=True)
        let x = timed!("model.2", c2f_block(&prefix("model.2"), &x, 128, 128, 3, true)?);
        // model.3: Conv(128->256, k=3, s=2)
        let x = timed!("model.3", conv_block(&prefix("model.3"), &x, 256, 3, 2)?);
        // model.4: C2f(256->256, n=6, shortcut=True)
        let p4_in = timed!("model.4", c2f_block(&prefix("model.4"), &x, 256, 256, 6, true)?);
        // model.5: Conv(256->512, k=3, s=2)
        let x = timed!("model.5", conv_block(&prefix("model.5"), &p4_in, 512, 3, 2)?);
        // model.6: C2f(512->512, n=6, shortcut=True)
        let p3_in = timed!("model.6", c2f_block(&prefix("model.6"), &x, 512, 512, 6, true)?);
        // model.7: Conv(512->1024, k=3, s=2)
        let x = timed!("model.7", conv_block(&prefix("model.7"), &p3_in, 1024, 3, 2)?);
        // model.8: C2f(1024->1024, n=3, shortcut=True)
        let x = timed!("model.8", c2f_block(&prefix("model.8"), &x, 1024, 1024, 3, true)?);
        // model.9: SPPF(1024->1024, k=5)
        let p5_in = timed!("model.9", sppf_block(&prefix("model.9"), &x, 1024, 1024, 5)?);

        // ── Head (PAN-FPN) ───────────────────────────────────────────
        // model.10: Upsample(2x) + model.11: Concat with p3_in
        let up = timed!("model.10", upsample_2x(&p5_in)?);
        let cat = timed!("model.11", Tensor::cat(&[&up, &p3_in], 1)
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?);
        // model.12: C2f(cat_channels->512, n=3, shortcut=False)
        let cat_channels = cat.dims()[1];
        let x = timed!("model.12", c2f_block(&prefix("model.12"), &cat, cat_channels, 512, 3, false)?);

        // model.13: Upsample(2x) + model.14: Concat with p4_in
        let up = timed!("model.13", upsample_2x(&x)?);
        let cat = timed!("model.14", Tensor::cat(&[&up, &p4_in], 1)
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?);
        // model.15: C2f(cat_channels->256, n=3, shortcut=False) -> P3
        let cat_channels = cat.dims()[1];
        let p3 = timed!("model.15", c2f_block(&prefix("model.15"), &cat, cat_channels, 256, 3, false)?);

        // model.16: Conv(256->256, k=3, s=2) + model.17: Concat
        let down = timed!("model.16", conv_block(&prefix("model.16"), &p3, 256, 3, 2)?);
        let cat = timed!("model.17", Tensor::cat(&[&down, &x], 1)
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?);
        // model.18: C2f(cat_channels->512, n=3, shortcut=False) -> P4
        let cat_channels = cat.dims()[1];
        let p4 = timed!("model.18", c2f_block(&prefix("model.18"), &cat, cat_channels, 512, 3, false)?);

        // model.19: Conv(512->512, k=3, s=2) + model.20: Concat
        let down = timed!("model.19", conv_block(&prefix("model.19"), &p4, 512, 3, 2)?);
        let cat = timed!("model.20", Tensor::cat(&[&down, &p5_in], 1)
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?);
        // model.21: C2f(cat_channels->1024, n=3, shortcut=False) -> P5
        let cat_channels = cat.dims()[1];
        let p5 = timed!("model.21", c2f_block(&prefix("model.21"), &cat, cat_channels, 1024, 3, false)?);

        if profile {
            let total: f64 = layer_times.iter().map(|(_, t)| t).sum();
            log::info!("[MLX Profile] Total forward: {:.2}ms", total);
            for (layer, ms) in &layer_times {
                if *ms > 1.0 {
                    log::info!("[MLX Profile]   {}: {:.2}ms", layer, ms);
                }
            }
        }

        Ok((p3, p4, p5))
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

        validate_rgba_input_len(data.len(), width, height)?;

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
            Err(InferenceError::BackendNotAvailable(Backend::MLX))
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
// YOLOv8 BUILDING BLOCKS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn conv_block(vb: &VarBuilder, x: &Tensor, out_channels: usize, k: usize, s: usize) -> Result<Tensor> {
    let conv_cfg = Conv2dConfig {
        stride: s,
        padding: k / 2,
        ..Default::default()
    };
    let conv = candle_nn::conv2d(x.dims()[1], out_channels, k, conv_cfg, vb.pp("conv"))
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    let bn = candle_nn::batch_norm(out_channels, 1e-5, vb.pp("bn"))
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    let x = conv.forward(x).map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    let x = bn.forward_t(&x, true).map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    let sigmoid = candle_nn::ops::sigmoid(&x)
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    x.mul(&sigmoid).map_err(|e| InferenceError::InferenceError(e.to_string()))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn bottleneck_block(vb: &VarBuilder, x: &Tensor, c1: usize, c2: usize, shortcut: bool) -> Result<Tensor> {
    let hidden = if c1 != c2 { c2 } else { c1 };
    let cv1 = conv_block(&vb.pp("cv1"), x, hidden, 3, 1)?;
    let cv2 = conv_block(&vb.pp("cv2"), &cv1, c2, 3, 1)?;
    if shortcut && c1 == c2 {
        (x + &cv2).map_err(|e| InferenceError::InferenceError(e.to_string()))
    } else {
        Ok(cv2)
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn c2f_block(vb: &VarBuilder, x: &Tensor, _c1: usize, c2: usize, n: usize, shortcut: bool) -> Result<Tensor> {
    let hidden = c2 / 2;
    let cv1 = conv_block(&vb.pp("cv1"), x, 2 * hidden, 1, 1)?;
    let mut ys = Vec::with_capacity(n + 1);
    let splits = cv1.chunk(2, 1).map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    ys.push(splits[0].clone());
    let mut current = splits[1].clone();
    for i in 0..n {
        let m_vb = vb.pp(format!("m.{}", i));
        current = bottleneck_block(&m_vb, &current, hidden, hidden, shortcut)?;
        ys.push(current.clone());
    }
    let cat = Tensor::cat(&ys.iter().collect::<Vec<&Tensor>>(), 1)
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    conv_block(&vb.pp("cv2"), &cat, c2, 1, 1)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn sppf_block(vb: &VarBuilder, x: &Tensor, c1: usize, c2: usize, k: usize) -> Result<Tensor> {
    let cv1 = conv_block(&vb.pp("cv1"), x, c1 / 2, 1, 1)?;
    let pool = |x: &Tensor| {
        x.max_pool2d_with_stride(k, k)
            .map_err(|e| InferenceError::InferenceError(e.to_string()))
    };
    let y1 = pool(&cv1)?;
    let y2 = pool(&y1)?;
    let y3 = pool(&y2)?;
    let cat = Tensor::cat(&[&cv1, &y1, &y2, &y3], 1)
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    conv_block(&vb.pp("cv2"), &cat, c2, 1, 1)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn upsample_2x(x: &Tensor) -> Result<Tensor> {
    let dims = x.dims();
    let (h, w) = (dims[2], dims[3]);
    x.upsample_nearest2d(h * 2, w * 2)
        .map_err(|e| InferenceError::InferenceError(e.to_string()))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn detect_head(vb: &VarBuilder, p3: &Tensor, p4: &Tensor, p5: &Tensor) -> Result<Tensor> {
    let nc = 80; // COCO classes
    let reg_max = 16;
    let no = nc + reg_max * 4; // 80 + 64 = 144 output channels per anchor

    // cv2: box regression branches (reg_max*4 outputs per scale)
    // cv3: class scores (nc outputs per scale)
    let detect_layer = |vb: &VarBuilder, feat: &Tensor, idx: usize| -> Result<Tensor> {
        let cv2_0 = conv_block(&vb.pp(format!("cv2.{}.0", idx)), feat, no, 3, 1)?;
        let cv2_1 = conv_block(&vb.pp(format!("cv2.{}.1", idx)), &cv2_0, no, 3, 1)?;
        let cv2 = conv_block_detect(&vb.pp(format!("cv2.{}.2", idx)), &cv2_1, reg_max * 4, 1, 1)?;

        let cv3_0 = conv_block(&vb.pp(format!("cv3.{}.0", idx)), feat, no, 3, 1)?;
        let cv3_1 = conv_block(&vb.pp(format!("cv3.{}.1", idx)), &cv3_0, no, 3, 1)?;
        let cv3 = conv_block_detect(&vb.pp(format!("cv3.{}.2", idx)), &cv3_1, nc, 1, 1)?;

        let (b, _c, h, w) = (cv2.dims()[0], cv2.dims()[1], cv2.dims()[2], cv2.dims()[3]);
        let cv2_r = cv2.reshape(&[b, reg_max * 4, h * w])
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
        let cv3_r = cv3.reshape(&[b, nc, h * w])
            .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

        Tensor::cat(&[&cv2_r, &cv3_r], 1)
            .map_err(|e| InferenceError::InferenceError(e.to_string()))
    };

    let d0 = detect_layer(vb, p3, 0)?;
    let d1 = detect_layer(vb, p4, 1)?;
    let d2 = detect_layer(vb, p5, 2)?;

    // Concatenate all detections along last dim: [1, reg_max*4+nc, total_anchors]
    Tensor::cat(&[&d0, &d1, &d2], 2)
        .map_err(|e| InferenceError::InferenceError(e.to_string()))
}

/// Conv block without batch_norm (used for Detect head output projections).
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn conv_block_detect(vb: &VarBuilder, x: &Tensor, out_channels: usize, k: usize, s: usize) -> Result<Tensor> {
    let conv_cfg = Conv2dConfig {
        stride: s,
        padding: k / 2,
        ..Default::default()
    };
    let conv = candle_nn::conv2d(x.dims()[1], out_channels, k, conv_cfg, vb.pp("conv"))
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;
    conv.forward(x).map_err(|e| InferenceError::InferenceError(e.to_string()))
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
        return validate_mlx_model_path("CREBAIN_MLX_MODEL", &path);
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
        if let Ok(validated) = validate_mlx_model_path("default MLX model path", &expanded) {
            return Ok(validated);
        }
    }

    Err(InferenceError::ModelLoadError(
        "No validated MLX safetensors model found; set CREBAIN_MLX_MODEL to a .safetensors file".to_string(),
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn validate_mlx_model_path(name: &str, model_path: &str) -> Result<String> {
    path::validate_model_path(model_path, Some(&["safetensors"]))
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| InferenceError::ModelLoadError(format!("Invalid {name}: {error}")))
}

/// Load safetensors model weights
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn load_safetensors(path: &str, device: &Device) -> Result<std::collections::HashMap<String, Tensor>> {
    use safetensors::SafeTensors;
    use std::collections::HashMap;

    // Check if file exists
    if !std::path::Path::new(path).exists() {
        return Err(InferenceError::ModelLoadError(format!(
            "MLX model file not found: {}",
            path
        )));
    }

    // Load file
    let data = std::fs::read(path)
        .map_err(|e| InferenceError::ModelLoadError(format!("Failed to read model: {}", e)))?;
    validate_model_checksum(path, &data)?;

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

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn validate_model_checksum(path: &str, data: &[u8]) -> Result<()> {
    use sha2::{Digest, Sha256};

    let expected = match std::env::var("CREBAIN_MLX_MODEL_SHA256") {
        Ok(value) if !value.trim().is_empty() => value.trim().to_ascii_lowercase(),
        _ => return Ok(()),
    };
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(InferenceError::ModelLoadError(
            "CREBAIN_MLX_MODEL_SHA256 must be a 64-character hexadecimal SHA-256 digest"
                .to_string(),
        ));
    }

    let actual = format!("{:x}", Sha256::digest(data));
    if actual != expected {
        return Err(InferenceError::ModelLoadError(format!(
            "MLX model checksum mismatch for {}: expected {}, got {}",
            path, expected, actual
        )));
    }
    Ok(())
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

/// Postprocess YOLOv8 output to detections.
///
/// The Detect head produces: [1, reg_max*4 + nc, total_anchors]
/// where reg_max=16 (distribution-focused bounding box regression).
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn postprocess_output(output: &Tensor, orig_width: f32, orig_height: f32) -> Result<Vec<Detection>> {
    const REG_MAX: usize = 16;
    const NC: usize = 80;
    const OUTPUT_CHANNELS: usize = REG_MAX * 4 + NC; // 64 + 80 = 144

    let dims = output.dims();
    if dims.len() != 3 || dims[1] != OUTPUT_CHANNELS {
        return Ok(Vec::new());
    }

    let num_anchors = dims[2];

    let data = output.flatten_all()
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?
        .to_vec1::<f32>()
        .map_err(|e| InferenceError::InferenceError(e.to_string()))?;

    // Precompute the DFL (Distribution Focal Loss) integration constants
    let dfl_proj: Vec<f32> = (0..REG_MAX).map(|i| i as f32).collect();

    let mut detections: Vec<Detection> = Vec::new();

    let scale_x = orig_width / INPUT_SIZE as f32;
    let scale_y = orig_height / INPUT_SIZE as f32;

    // Anchor grid strides for P3/8, P4/16, P5/32
    let strides: [(f32, usize); 3] = [(8.0, 80 * 80), (16.0, 40 * 40), (32.0, 20 * 20)];

    let mut anchor_offset: usize = 0;
    for &(stride, grid_cells) in &strides {
        let end = anchor_offset + grid_cells;
        if end > num_anchors {
            break;
        }

        let grid_size = (grid_cells as f32).sqrt() as usize;

        for i in anchor_offset..end {
            let local_idx = i - anchor_offset;
            let gy = (local_idx / grid_size) as f32;
            let gx = (local_idx % grid_size) as f32;

            // Decode bounding box via DFL
            let decode_coord = |base: usize| -> f32 {
                let mut sum = 0.0f32;
                let mut max_val = -1e9f32;
                for k in 0..REG_MAX {
                    let val = data[(base + k) * num_anchors + i];
                    if val > max_val {
                        max_val = val;
                    }
                }
                // Softmax over the reg_max distribution
                let mut exp_vals = [0.0f32; REG_MAX];
                let mut exp_sum = 0.0f32;
                for k in 0..REG_MAX {
                    let v = (data[(base + k) * num_anchors + i] - max_val).exp();
                    exp_vals[k] = v;
                    exp_sum += v;
                }
                if exp_sum > 0.0 {
                    for k in 0..REG_MAX {
                        sum += (exp_vals[k] / exp_sum) * dfl_proj[k];
                    }
                }
                sum
            };

            let l = decode_coord(0);
            let t = decode_coord(REG_MAX);
            let r = decode_coord(2 * REG_MAX);
            let b = decode_coord(3 * REG_MAX);

            // Convert to cx, cy, w, h
            let cx = (gx + 0.5 - l) * stride;
            let cy = (gy + 0.5 - t) * stride;
            let w = (l + r) * stride;
            let h = (t + b) * stride;

            // Find max class score (sigmoid applied)
            let mut max_score = 0.0f32;
            let mut max_class = 0usize;
            let box_base = REG_MAX * 4;

            for c in 0..NC {
                let raw = data[(box_base + c) * num_anchors + i];
                let score = 1.0 / (1.0 + (-raw).exp()); // sigmoid
                if score > max_score {
                    max_score = score;
                    max_class = c;
                }
            }

            if max_score < CONF_THRESHOLD {
                continue;
            }

            let x1 = ((cx - w / 2.0) * scale_x).max(0.0).min(orig_width);
            let y1 = ((cy - h / 2.0) * scale_y).max(0.0).min(orig_height);
            let x2 = ((cx + w / 2.0) * scale_x).max(0.0).min(orig_width);
            let y2 = ((cy + h / 2.0) * scale_y).max(0.0).min(orig_height);

            if x2 <= x1 || y2 <= y1 {
                continue;
            }

            detections.push(Detection {
                bbox: [x1, y1, x2, y2],
                confidence: max_score,
                class_id: max_class as u32,
                class_label: coco::get_class_name_ref(max_class)
                    .unwrap_or("unknown")
                    .to_string(),
            });
        }

        anchor_offset = end;
    }

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

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    static MLX_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn restore_env_var(name: &str, value: Option<String>) {
        if let Some(value) = value {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }

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
    fn mlx_model_path_validation_rejects_wrong_extension_and_traversal() {
        let wrong_ext = std::env::temp_dir().join(format!(
            "crebain-mlx-model-{}.onnx",
            std::process::id()
        ));
        std::fs::write(&wrong_ext, b"model").unwrap();

        let wrong_ext_error =
            validate_mlx_model_path("test", wrong_ext.to_str().unwrap()).unwrap_err();
        let traversal_error = validate_mlx_model_path("test", "../model.safetensors").unwrap_err();

        assert!(wrong_ext_error.to_string().contains("Invalid test"));
        assert!(wrong_ext_error.to_string().contains("extension"));
        assert!(traversal_error.to_string().contains("Traversal") || traversal_error.to_string().contains("traversal"));

        let _ = std::fs::remove_file(wrong_ext);
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn mlx_model_path_validation_accepts_existing_safetensors() {
        let model_path = std::env::temp_dir().join(format!(
            "crebain-mlx-model-{}.safetensors",
            std::process::id()
        ));
        std::fs::write(&model_path, b"model").unwrap();

        let validated = validate_mlx_model_path("test", model_path.to_str().unwrap()).unwrap();

        assert!(validated.ends_with(".safetensors"));

        let _ = std::fs::remove_file(model_path);
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn test_iou_computation() {
        let box1 = [0.0, 0.0, 10.0, 10.0];
        assert!((compute_iou(&box1, &box1) - 1.0).abs() < 0.001);

        let box2 = [20.0, 20.0, 30.0, 30.0];
        assert!(compute_iou(&box1, &box2) < 0.001);

        let box3 = [5.0, 0.0, 15.0, 10.0];
        let iou = compute_iou(&box1, &box3);
        assert!(iou > 0.3 && iou < 0.4);
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn mlx_forward_rejects_3d_input() {
        let device = Device::Cpu;
        let weights = std::collections::HashMap::new();
        let detector = MlxDetector {
            device,
            model_weights: weights,
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms: 0.0,
        };
        let input = Tensor::zeros(&[1, 3, 640], DType::F32, &detector.device).unwrap();
        let vb = VarBuilder::from_tensors(std::collections::HashMap::new(), DType::F32, &detector.device);
        let result = detector.yolov8_forward(&input, &vb);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("4D"));
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn mlx_forward_rejects_empty_weights() {
        let device = Device::Cpu;
        let weights = std::collections::HashMap::new();
        let detector = MlxDetector {
            device,
            model_weights: weights,
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms: 0.0,
        };
        let input = Tensor::zeros(&[1, 3, 640, 640], DType::F32, &detector.device).unwrap();
        let vb = VarBuilder::from_tensors(std::collections::HashMap::new(), DType::F32, &detector.device);
        let result = detector.yolov8_forward(&input, &vb);
        assert!(result.is_err());
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn mlx_detect_rejects_invalid_rgba_size() {
        let device = Device::Cpu;
        let weights = std::collections::HashMap::new();
        let detector = MlxDetector {
            device,
            model_weights: weights,
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms: 0.0,
        };
        let result = detector.detect(&[0u8; 10], 640, 480);
        assert!(result.is_err());
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn mlx_checksum_accepts_expected_digest() {
        let _guard = MLX_ENV_LOCK.lock().unwrap();
        let original = std::env::var("CREBAIN_MLX_MODEL_SHA256").ok();
        std::env::set_var(
            "CREBAIN_MLX_MODEL_SHA256",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );

        let result = validate_model_checksum("model.safetensors", b"abc");

        restore_env_var("CREBAIN_MLX_MODEL_SHA256", original);
        assert!(result.is_ok());
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn mlx_checksum_rejects_mismatch() {
        let _guard = MLX_ENV_LOCK.lock().unwrap();
        let original = std::env::var("CREBAIN_MLX_MODEL_SHA256").ok();
        std::env::set_var(
            "CREBAIN_MLX_MODEL_SHA256",
            "0000000000000000000000000000000000000000000000000000000000000000",
        );

        let error = validate_model_checksum("model.safetensors", b"abc").unwrap_err();

        restore_env_var("CREBAIN_MLX_MODEL_SHA256", original);
        assert!(error.to_string().contains("checksum mismatch"));
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn postprocess_rejects_wrong_output_channels() {
        let device = Device::Cpu;
        let output = Tensor::zeros(&[1, 84, 8400], DType::F32, &device).unwrap();
        let detections = postprocess_output(&output, 640.0, 480.0).unwrap();
        assert!(detections.is_empty());
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn postprocess_handles_empty_anchors() {
        let device = Device::Cpu;
        let output = Tensor::zeros(&[1, 144, 0], DType::F32, &device).unwrap();
        let detections = postprocess_output(&output, 640.0, 480.0).unwrap();
        assert!(detections.is_empty());
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn nms_handles_empty_input() {
        let result = non_max_suppression(Vec::new(), 0.45);
        assert!(result.is_empty());
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn nms_handles_single_detection() {
        let det = Detection {
            bbox: [0.0, 0.0, 10.0, 10.0],
            confidence: 0.9,
            class_id: 0,
            class_label: "person".to_string(),
        };
        let result = non_max_suppression(vec![det], 0.45);
        assert_eq!(result.len(), 1);
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn e2e_mlx_smoke_test_with_minimal_model() {
        let device = Device::Cpu;
        let model_path = std::env::temp_dir().join(format!(
            "crebain-e2e-mlx-{}.safetensors",
            std::process::id()
        ));

        let mut weights = std::collections::HashMap::new();
        let conv_weight = Tensor::ones(&[64, 3, 3, 3], DType::F32, &device).unwrap();
        let conv_bias = Tensor::zeros(&[64], DType::F32, &device).unwrap();
        let bn_weight = Tensor::ones(&[64], DType::F32, &device).unwrap();
        let bn_bias = Tensor::zeros(&[64], DType::F32, &device).unwrap();
        let bn_mean = Tensor::zeros(&[64], DType::F32, &device).unwrap();
        let bn_var = Tensor::ones(&[64], DType::F32, &device).unwrap();

        weights.insert("model.0.conv.weight".to_string(), conv_weight);
        weights.insert("model.0.conv.bias".to_string(), conv_bias);
        weights.insert("model.0.bn.weight".to_string(), bn_weight);
        weights.insert("model.0.bn.bias".to_string(), bn_bias);
        weights.insert("model.0.bn.running_mean".to_string(), bn_mean);
        weights.insert("model.0.bn.running_var".to_string(), bn_var);

        candle_core::safetensors::save(&weights, &model_path).unwrap();

        let loaded = load_safetensors(model_path.to_str().unwrap(), &device).unwrap();
        assert!(!loaded.is_empty());

        let detector = MlxDetector {
            device,
            model_weights: loaded,
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms: 0.0,
        };

        let input = Tensor::zeros(&[1, 3, 640, 640], DType::F32, &detector.device).unwrap();
        let vb = VarBuilder::from_tensors(detector.model_weights.clone(), DType::F32, &detector.device);
        let result = detector.yolov8_forward(&input, &vb);
        assert!(result.is_err());

        let _ = std::fs::remove_file(model_path);
    }

    #[test]
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn e2e_mlx_detect_validates_rgba_and_runs_pipeline() {
        let device = Device::Cpu;
        let weights = std::collections::HashMap::new();
        let detector = MlxDetector {
            device,
            model_weights: weights,
            inference_count: AtomicU64::new(0),
            total_inference_ms: AtomicU64::new(0),
            model_load_ms: 0.0,
        };
        let rgba = vec![0u8; 640 * 480 * 4];
        let result = detector.detect(&rgba, 640, 480);
        assert!(result.is_err());
        assert!(!result.unwrap_err().to_string().contains("Invalid input"));
    }
}
