//! CREBAIN Native CoreML Module
//! Adaptive Response & Awareness System (ARAS)
//!
//! Direct Rust-to-CoreML FFI for zero-latency ML inference
//! No subprocess, no JSON serialization, minimal overhead

#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl, runtime::Object};
#[cfg(target_os = "macos")]
use std::ffi::CString;

use std::sync::OnceLock;
use std::time::Instant;
use base64::Engine;

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// DETECTION TYPES
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BoundingBox {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub id: String,
    pub class_label: String,
    pub class_index: i32,
    pub confidence: f64,
    pub bbox: BoundingBox,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionResult {
    pub success: bool,
    pub detections: Vec<Detection>,
    pub inference_time_ms: f64,
    pub preprocess_time_ms: Option<f64>,
    pub postprocess_time_ms: Option<f64>,
    pub error: Option<String>,
}

// COCO class labels are provided by `crate::common::coco`.

// ─────────────────────────────────────────────────────────────────────────────
// NATIVE COREML DETECTOR (macOS only)
// ─────────────────────────────────────────────────────────────────────────────

/// Wrapper for thread-safe Objective-C object pointers.
///
/// # Safety Invariants
///
/// This type wraps a pointer to a VNCoreMLModel, which is documented by Apple
/// to be thread-safe for concurrent inference operations.
///
/// References:
/// - VNCoreMLModel is immutable after creation
/// - VNCoreMLRequest objects are created per-operation (not shared)
/// - Vision framework handles internal synchronization for model access
/// - CoreML models support concurrent prediction requests
///
/// The wrapped object MUST be:
/// 1. A valid, retained Objective-C object
/// 2. Thread-safe for the access pattern (read-only model inference)
/// 3. Released when this wrapper is dropped
#[cfg(target_os = "macos")]
struct ThreadSafeVNModel(*mut Object);

#[cfg(target_os = "macos")]
impl ThreadSafeVNModel {
    /// Create a new thread-safe VNCoreMLModel wrapper.
    ///
    /// # Safety
    ///
    /// The caller MUST ensure:
    /// 1. `ptr` points to a valid, retained VNCoreMLModel instance
    /// 2. The object will remain valid for the lifetime of this wrapper
    /// 3. The object is only used for read-only inference operations
    unsafe fn new(ptr: *mut Object) -> Self {
        debug_assert!(!ptr.is_null(), "VNCoreMLModel pointer must not be null");
        Self(ptr)
    }

    fn as_ptr(&self) -> *mut Object {
        self.0
    }
}

// SAFETY: VNCoreMLModel is documented to be thread-safe for concurrent inference.
// We only use the model for read-only prediction operations via VNCoreMLRequest.
// Each inference creates its own VNCoreMLRequest and VNImageRequestHandler,
// and Vision framework handles all internal synchronization.
#[cfg(target_os = "macos")]
unsafe impl Send for ThreadSafeVNModel {}

// SAFETY: See Send implementation. The model is immutable after creation and
// Vision framework synchronizes concurrent access internally.
#[cfg(target_os = "macos")]
unsafe impl Sync for ThreadSafeVNModel {}

#[cfg(target_os = "macos")]
impl Drop for ThreadSafeVNModel {
    fn drop(&mut self) {
        // SAFETY: We retained the object in NativeCoreMLDetector::new(),
        // so we must release it here to avoid memory leaks.
        unsafe {
            let _: () = msg_send![self.0, release];
        }
    }
}

#[cfg(target_os = "macos")]
pub struct NativeCoreMLDetector {
    vn_model: ThreadSafeVNModel,
    detection_counter: std::sync::atomic::AtomicU64,
}

// NativeCoreMLDetector is Send+Sync because:
// - vn_model: ThreadSafeVNModel is Send+Sync (see above)
// - detection_counter: AtomicU64 is Send+Sync

#[cfg(target_os = "macos")]
static DETECTOR: OnceLock<NativeCoreMLDetector> = OnceLock::new();

#[cfg(target_os = "macos")]
static INIT_ERROR: OnceLock<String> = OnceLock::new();

#[cfg(target_os = "macos")]
impl NativeCoreMLDetector {
    /// Initialize the global detector with model path
    pub fn init_global(model_path: &str) -> Result<(), String> {
        // Check if already initialized
        if DETECTOR.get().is_some() {
            return Ok(());
        }
        
        // Check if previous init failed
        if let Some(err) = INIT_ERROR.get() {
            return Err(err.clone());
        }
        
        // Try to initialize
        match Self::new(model_path) {
            Ok(detector) => {
                let _ = DETECTOR.set(detector);
                Ok(())
            }
            Err(e) => {
                let _ = INIT_ERROR.set(e.clone());
                Err(e)
            }
        }
    }
    
    /// Get the global detector instance
    pub fn get_global() -> Option<&'static NativeCoreMLDetector> {
        DETECTOR.get()
    }
    
    /// Create a new detector with the given model path
    ///
    /// # Safety
    ///
    /// This function uses Objective-C runtime FFI. Safety is ensured by:
    /// - All Objective-C objects are properly retained/released
    /// - Error pointers are checked before dereferencing
    /// - Null checks on all returned objects
    /// - The VNCoreMLModel is retained and wrapped in ThreadSafeVNModel for safe concurrent access
    fn new(model_path: &str) -> Result<Self, String> {
        // SAFETY: This entire block uses Objective-C FFI via the objc crate.
        // Each msg_send! call is safe because:
        // 1. We check return values for null before use
        // 2. We handle NSError objects properly
        // 3. We retain objects we need to keep and release in Drop
        // 4. All pointer lifetimes are contained within this function except
        //    vn_model which is retained and stored in ThreadSafeVNModel
        unsafe {
            // Create NSURL for model path
            let path_str = CString::new(model_path).map_err(|e| e.to_string())?;
            let ns_string: *mut Object = msg_send![class!(NSString), stringWithUTF8String: path_str.as_ptr()];
            let url: *mut Object = msg_send![class!(NSURL), fileURLWithPath: ns_string];
            
            if url.is_null() {
                return Err(format!("Failed to create URL for path: {}", model_path));
            }
            
            // Load MLModel with configuration for maximum performance
            let config: *mut Object = msg_send![class!(MLModelConfiguration), new];
            
            // Set compute units to cpuAndNeuralEngine for optimal ANE utilization
            // MLComputeUnits: .all = 0, .cpuOnly = 1, .cpuAndGPU = 2, .cpuAndNeuralEngine = 3
            let _: () = msg_send![config, setComputeUnits: 3_i64]; // cpuAndNeuralEngine
            
            // Enable low precision for faster GPU ops
            let _: () = msg_send![config, setAllowLowPrecisionAccumulationOnGPU: true];
            
            // Load compiled model
            let mut error: *mut Object = std::ptr::null_mut();
            let model: *mut Object = msg_send![class!(MLModel), modelWithContentsOfURL: url configuration: config error: &mut error];
            
            if model.is_null() || !error.is_null() {
                let error_desc: *mut Object = msg_send![error, localizedDescription];
                let error_cstr: *const i8 = msg_send![error_desc, UTF8String];
                let error_str = if error_cstr.is_null() {
                    "Unknown error".to_string()
                } else {
                    std::ffi::CStr::from_ptr(error_cstr).to_string_lossy().to_string()
                };
                return Err(format!("Failed to load CoreML model: {}", error_str));
            }
            
            // Create VNCoreMLModel for Vision framework
            let mut vn_error: *mut Object = std::ptr::null_mut();
            let vn_model: *mut Object = msg_send![class!(VNCoreMLModel), modelForMLModel: model error: &mut vn_error];
            
            if vn_model.is_null() || !vn_error.is_null() {
                return Err("Failed to create VNCoreMLModel".to_string());
            }
            
            // Retain the model so it's not deallocated
            // NOTE: The ThreadSafeVNModel Drop impl will release this
            let _: () = msg_send![vn_model, retain];

            log::info!("Warming up CoreML model...");
            // SAFETY: vn_model is a valid, retained VNCoreMLModel instance
            // that will be used only for read-only inference operations.
            let detector = Self {
                vn_model: ThreadSafeVNModel::new(vn_model),
                detection_counter: std::sync::atomic::AtomicU64::new(0),
            };
            
            // Create a small dummy image for warmup
            let warmup_data = vec![128u8; 64 * 64 * 4]; // Small RGBA image
            let _ = detector.detect_raw(&warmup_data, 64, 64, 0.5, 100);
            let _ = detector.detect_raw(&warmup_data, 64, 64, 0.5, 100);
            let _ = detector.detect_raw(&warmup_data, 64, 64, 0.5, 100);
            log::info!("CoreML warmup complete");
            
            Ok(detector)
        }
    }
    
    /// Run detection on raw RGBA pixel data (zero-copy path)
    ///
    /// # Safety
    ///
    /// This function uses Core Graphics and Vision FFI. Safety is ensured by:
    /// - All CG/Vision objects are properly created and released
    /// - The rgba_data slice is valid for the duration of the function call
    /// - CGImage is created with a data provider that references rgba_data
    /// - All intermediate objects are released before returning
    /// - Bounds on iteration are checked (max_detections, result_count)
    pub fn detect_raw(
        &self,
        rgba_data: &[u8],
        width: u32,
        height: u32,
        confidence_threshold: f64,
        max_detections: usize,
    ) -> Result<DetectionResult, String> {

        // SAFETY: This block uses Core Graphics and Vision FFI.
        // Key safety invariants:
        // 1. rgba_data is borrowed and valid for the entire function
        // 2. CGDataProvider does not take ownership (no release callback)
        // 3. All CG objects (color space, provider, image) are released
        // 4. All Vision objects (request, handler) are released
        // 5. We check for null returns from all CF/NS creation functions
        // 6. Iteration bounds are respected (min of result_count and max_detections)
        unsafe {
            // Create CGImage from raw RGBA data
            let preprocess_start = Instant::now();

            // Use CGImageCreate via FFI - it's a C function, not exposed nicely in core-graphics crate
            // We'll use the raw Core Graphics C API
            extern "C" {
                fn CGColorSpaceCreateDeviceRGB() -> *mut std::ffi::c_void;
                fn CGDataProviderCreateWithData(
                    info: *mut std::ffi::c_void,
                    data: *const u8,
                    size: usize,
                    release_callback: *const std::ffi::c_void,
                ) -> *mut std::ffi::c_void;
                fn CGImageCreate(
                    width: usize,
                    height: usize,
                    bits_per_component: usize,
                    bits_per_pixel: usize,
                    bytes_per_row: usize,
                    color_space: *mut std::ffi::c_void,
                    bitmap_info: u32,
                    provider: *mut std::ffi::c_void,
                    decode: *const f64,
                    should_interpolate: bool,
                    intent: i32,
                ) -> *mut std::ffi::c_void;
                fn CGColorSpaceRelease(color_space: *mut std::ffi::c_void);
                fn CGDataProviderRelease(provider: *mut std::ffi::c_void);
                fn CGImageRelease(image: *mut std::ffi::c_void);
            }
            
            let color_space = CGColorSpaceCreateDeviceRGB();
            if color_space.is_null() {
                return Err("Failed to create color space".to_string());
            }
            
            let data_provider = CGDataProviderCreateWithData(
                std::ptr::null_mut(),
                rgba_data.as_ptr(),
                rgba_data.len(),
                std::ptr::null(),
            );
            if data_provider.is_null() {
                CGColorSpaceRelease(color_space);
                return Err("Failed to create data provider".to_string());
            }
            
            let bits_per_component: usize = 8;
            let bits_per_pixel: usize = 32;
            let bytes_per_row: usize = (width as usize) * 4;
            // kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
            let bitmap_info: u32 = 1; // kCGImageAlphaLast
            
            let cg_image = CGImageCreate(
                width as usize,
                height as usize,
                bits_per_component,
                bits_per_pixel,
                bytes_per_row,
                color_space,
                bitmap_info,
                data_provider,
                std::ptr::null(),
                false,
                0, // kCGRenderingIntentDefault
            );
            
            // Release intermediate objects
            CGColorSpaceRelease(color_space);
            CGDataProviderRelease(data_provider);
            
            if cg_image.is_null() {
                return Err("Failed to create CGImage from raw data".to_string());
            }
            
            let preprocess_time = preprocess_start.elapsed();
            
            // Create Vision request
            let inference_start = Instant::now();
            
            let request: *mut Object = msg_send![class!(VNCoreMLRequest), alloc];
            let request: *mut Object = msg_send![request, initWithModel: self.vn_model.as_ptr()];
            
            // Set request options for best performance
            let _: () = msg_send![request, setImageCropAndScaleOption: 2_i64]; // scaleFill = 2
            let _: () = msg_send![request, setPreferBackgroundProcessing: false];
            let _: () = msg_send![request, setUsesCPUOnly: false];
            
            // Create request handler with CGImage
            let handler: *mut Object = msg_send![class!(VNImageRequestHandler), alloc];
            let handler: *mut Object = msg_send![
                handler,
                initWithCGImage: cg_image
                options: std::ptr::null::<Object>()
            ];
            
            if handler.is_null() {
                // Release the request
                let _: () = msg_send![request, release];
                return Err("Failed to create VNImageRequestHandler".to_string());
            }
            
            let requests: *mut Object = msg_send![class!(NSArray), arrayWithObject: request];
            
            let mut error: *mut Object = std::ptr::null_mut();
            let success: bool = msg_send![handler, performRequests: requests error: &mut error];
            
            let inference_time = inference_start.elapsed();
            
            if !success {
                let error_msg = if !error.is_null() {
                    let error_desc: *mut Object = msg_send![error, localizedDescription];
                    let error_cstr: *const i8 = msg_send![error_desc, UTF8String];
                    if error_cstr.is_null() {
                        "Unknown Vision error".to_string()
                    } else {
                        std::ffi::CStr::from_ptr(error_cstr).to_string_lossy().to_string()
                    }
                } else {
                    "Vision request failed".to_string()
                };
                
                // Release objects
                let _: () = msg_send![request, release];
                let _: () = msg_send![handler, release];
                
                return Err(error_msg);
            }
            
            // Process results
            let postprocess_start = Instant::now();
            
            let results: *mut Object = msg_send![request, results];
            let result_count: usize = if results.is_null() { 0 } else { msg_send![results, count] };
            
            let mut detections = Vec::with_capacity(result_count.min(max_detections));
            let image_width = width as f64;
            let image_height = height as f64;
            
            for i in 0..result_count.min(max_detections) {
                let observation: *mut Object = msg_send![results, objectAtIndex: i];
                
                // Get confidence
                let confidence: f32 = msg_send![observation, confidence];
                if (confidence as f64) < confidence_threshold {
                    continue;
                }
                
                // Get bounding box (Vision coords: origin bottom-left, normalized)
                let bbox_struct: CGRect = msg_send![observation, boundingBox];
                
                // Convert to pixel coordinates (origin top-left)
                let x1 = bbox_struct.origin.x * image_width;
                let y1 = (1.0 - bbox_struct.origin.y - bbox_struct.size.height) * image_height;
                let x2 = (bbox_struct.origin.x + bbox_struct.size.width) * image_width;
                let y2 = (1.0 - bbox_struct.origin.y) * image_height;
                
                // Get class label
                let labels: *mut Object = msg_send![observation, labels];
                let label_count: usize = if labels.is_null() { 0 } else { msg_send![labels, count] };
                
                let (class_label, class_index) = if label_count > 0 {
                    let top_label: *mut Object = msg_send![labels, objectAtIndex: 0_usize];
                    let identifier: *mut Object = msg_send![top_label, identifier];
                    let id_cstr: *const i8 = msg_send![identifier, UTF8String];
                    
                    let label = if id_cstr.is_null() {
                        "unknown".to_string()
                    } else {
                        std::ffi::CStr::from_ptr(id_cstr).to_string_lossy().to_string()
                    };
                    
                    let idx = crate::common::coco::COCO_CLASSES
                        .iter()
                        .position(|&c| c == label.as_str())
                        .map(|i| i as i32)
                        .unwrap_or(-1);
                    (label, idx)
                } else {
                    ("unknown".to_string(), -1)
                };
                
                let det_id = self.detection_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                
                detections.push(Detection {
                    id: format!("DET-{:08X}", det_id),
                    class_label,
                    class_index,
                    confidence: confidence as f64,
                    bbox: BoundingBox { x1, y1, x2, y2 },
                    timestamp: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64,
                });
            }
            
            // Release objects
            let _: () = msg_send![request, release];
            let _: () = msg_send![handler, release];
            CGImageRelease(cg_image);
            
            // Sort by confidence
            detections.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
            
            let postprocess_time = postprocess_start.elapsed();
            
            Ok(DetectionResult {
                success: true,
                detections,
                inference_time_ms: inference_time.as_secs_f64() * 1000.0,
                preprocess_time_ms: Some(preprocess_time.as_secs_f64() * 1000.0),
                postprocess_time_ms: Some(postprocess_time.as_secs_f64() * 1000.0),
                error: None,
            })
        }
    }
}

// CGRect struct for Vision framework
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK FOR NON-MACOS PLATFORMS
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(not(target_os = "macos"))]
pub struct NativeCoreMLDetector;

#[cfg(not(target_os = "macos"))]
impl NativeCoreMLDetector {
    pub fn init_global(_model_path: &str) -> Result<(), String> {
        Err("CoreML is only available on macOS. Consider using MPS/MLX backend.".to_string())
    }
    
    pub fn get_global() -> Option<&'static NativeCoreMLDetector> {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/// Initialize the native CoreML detector
pub fn init_detector(model_path: &str) -> Result<(), String> {
    NativeCoreMLDetector::init_global(model_path)
}

/// Run detection on base64-encoded image (convenience function)
pub fn detect_base64(
    image_base64: &str,
    confidence_threshold: f64,
    max_detections: usize,
) -> Result<DetectionResult, String> {
    let start = Instant::now();
    
    // Decode base64 using the Engine trait correctly
    let image_data = base64::engine::general_purpose::STANDARD
        .decode(image_base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    
    // Decode PNG/JPEG to raw RGBA
    let img = image::load_from_memory(&image_data)
        .map_err(|e| format!("Image decode error: {}", e))?;
    
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let raw_data = rgba.into_raw();
    
    let decode_time = start.elapsed();
    log::debug!("Image decode took: {:?}", decode_time);
    
    // Run detection
    #[cfg(target_os = "macos")]
    {
        let detector = NativeCoreMLDetector::get_global()
            .ok_or("CoreML detector not initialized")?;
        detector.detect_raw(&raw_data, width, height, confidence_threshold, max_detections)
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (raw_data, width, height, confidence_threshold, max_detections);
        Err("CoreML is only available on macOS".to_string())
    }
}

/// Run detection on raw RGBA data (zero-copy path)
pub fn detect_raw(
    rgba_data: &[u8],
    width: u32,
    height: u32,
    confidence_threshold: f64,
    max_detections: usize,
) -> Result<DetectionResult, String> {
    #[cfg(target_os = "macos")]
    {
        let detector = NativeCoreMLDetector::get_global()
            .ok_or("CoreML detector not initialized")?;
        detector.detect_raw(rgba_data, width, height, confidence_threshold, max_detections)
    }
    
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (rgba_data, width, height, confidence_threshold, max_detections);
        Err("CoreML is only available on macOS".to_string())
    }
}
