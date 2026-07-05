//! Shared detection types for internal detector utilities (e.g. `common::nms`).
//!
//! # WARNING: not the IPC wire types
//!
//! `Detection` and `DetectionResult` here serialize with snake_case field
//! names and lack the `id`, `timestamp`, and `success` fields that the
//! TypeScript contract expects (see `normalizeNativeDetectionResult` in
//! `src/detection/nativeDetectionResult.ts`). Do NOT serialize these types
//! across the Tauri IPC boundary. The real IPC wire types are:
//! - `crate::coreml::{Detection, DetectionResult}`
//! - `crate::onnx_detector::{Detection, OnnxDetectionResult}`
//!
//! both of which serialize camelCase and carry the full contract.

use serde::{Deserialize, Serialize};

/// Bounding box in pixel coordinates.
///
/// Coordinates are in the format [x1, y1, x2, y2] where:
/// - (x1, y1) is the top-left corner
/// - (x2, y2) is the bottom-right corner
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
}

impl BBox {
    /// Create a new bounding box from corner coordinates.
    #[inline]
    pub fn new(x1: f32, y1: f32, x2: f32, y2: f32) -> Self {
        Self { x1, y1, x2, y2 }
    }

    /// Create a bounding box from center coordinates and dimensions.
    #[inline]
    pub fn from_center(cx: f32, cy: f32, width: f32, height: f32) -> Self {
        let half_w = width / 2.0;
        let half_h = height / 2.0;
        Self {
            x1: cx - half_w,
            y1: cy - half_h,
            x2: cx + half_w,
            y2: cy + half_h,
        }
    }

    /// Get the width of the bounding box.
    #[inline]
    pub fn width(&self) -> f32 {
        self.x2 - self.x1
    }

    /// Get the height of the bounding box.
    #[inline]
    pub fn height(&self) -> f32 {
        self.y2 - self.y1
    }

    /// Get the area of the bounding box.
    #[inline]
    pub fn area(&self) -> f32 {
        self.width() * self.height()
    }

    /// Get the center point of the bounding box.
    #[inline]
    pub fn center(&self) -> (f32, f32) {
        ((self.x1 + self.x2) / 2.0, (self.y1 + self.y2) / 2.0)
    }

    /// Clamp the bounding box to image dimensions.
    #[inline]
    pub fn clamp(&self, width: f32, height: f32) -> Self {
        Self {
            x1: self.x1.max(0.0).min(width),
            y1: self.y1.max(0.0).min(height),
            x2: self.x2.max(0.0).min(width),
            y2: self.y2.max(0.0).min(height),
        }
    }

    /// Scale the bounding box by given factors.
    #[inline]
    pub fn scale(&self, scale_x: f32, scale_y: f32) -> Self {
        Self {
            x1: self.x1 * scale_x,
            y1: self.y1 * scale_y,
            x2: self.x2 * scale_x,
            y2: self.y2 * scale_y,
        }
    }

    /// Convert to array format [x1, y1, x2, y2].
    #[inline]
    pub fn to_array(&self) -> [f32; 4] {
        [self.x1, self.y1, self.x2, self.y2]
    }

    /// Create from array format [x1, y1, x2, y2].
    #[inline]
    pub fn from_array(arr: [f32; 4]) -> Self {
        Self {
            x1: arr[0],
            y1: arr[1],
            x2: arr[2],
            y2: arr[3],
        }
    }
}

impl From<[f32; 4]> for BBox {
    fn from(arr: [f32; 4]) -> Self {
        Self::from_array(arr)
    }
}

impl From<BBox> for [f32; 4] {
    fn from(bbox: BBox) -> Self {
        bbox.to_array()
    }
}

/// A single object detection result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Detection {
    /// Bounding box in pixel coordinates.
    pub bbox: BBox,
    /// Confidence score (0.0 - 1.0).
    pub confidence: f32,
    /// Class index (0-79 for COCO).
    pub class_id: u32,
    /// Human-readable class label.
    pub class_label: String,
}

impl Detection {
    /// Create a new detection.
    pub fn new(bbox: BBox, confidence: f32, class_id: u32, class_label: impl Into<String>) -> Self {
        Self {
            bbox,
            confidence,
            class_id,
            class_label: class_label.into(),
        }
    }

    /// Create a detection with automatic class label lookup.
    pub fn with_class_id(bbox: BBox, confidence: f32, class_id: u32) -> Self {
        let class_label = super::coco::get_class_name(class_id as usize);
        Self {
            bbox,
            confidence,
            class_id,
            class_label,
        }
    }
}

/// Detection result from inference.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionResult {
    /// List of detections.
    pub detections: Vec<Detection>,
    /// Inference time in milliseconds.
    pub inference_time_ms: f64,
    /// Preprocessing time in milliseconds.
    pub preprocess_time_ms: f64,
    /// Postprocessing time in milliseconds (includes NMS).
    pub postprocess_time_ms: f64,
    /// Backend used for inference.
    pub backend: String,
}

impl DetectionResult {
    /// Create an empty result.
    pub fn empty(backend: impl Into<String>) -> Self {
        Self {
            detections: Vec::new(),
            inference_time_ms: 0.0,
            preprocess_time_ms: 0.0,
            postprocess_time_ms: 0.0,
            backend: backend.into(),
        }
    }

    /// Total time for detection pipeline.
    pub fn total_time_ms(&self) -> f64 {
        self.inference_time_ms + self.preprocess_time_ms + self.postprocess_time_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bbox_from_center() {
        let bbox = BBox::from_center(100.0, 100.0, 50.0, 30.0);
        assert_eq!(bbox.x1, 75.0);
        assert_eq!(bbox.y1, 85.0);
        assert_eq!(bbox.x2, 125.0);
        assert_eq!(bbox.y2, 115.0);
    }

    #[test]
    fn test_bbox_dimensions() {
        let bbox = BBox::new(10.0, 20.0, 110.0, 70.0);
        assert_eq!(bbox.width(), 100.0);
        assert_eq!(bbox.height(), 50.0);
        assert_eq!(bbox.area(), 5000.0);
    }

    #[test]
    fn test_bbox_clamp() {
        let bbox = BBox::new(-10.0, -10.0, 200.0, 200.0);
        let clamped = bbox.clamp(100.0, 100.0);
        assert_eq!(clamped.x1, 0.0);
        assert_eq!(clamped.y1, 0.0);
        assert_eq!(clamped.x2, 100.0);
        assert_eq!(clamped.y2, 100.0);
    }
}
