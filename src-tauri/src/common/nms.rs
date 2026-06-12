//! Non-Maximum Suppression (NMS) algorithm.
//!
//! This module provides a single, well-tested NMS implementation
//! to be used by all detector backends.

use super::detection::{BBox, Detection};

/// Compute Intersection over Union (IoU) between two bounding boxes.
///
/// Returns a value between 0.0 (no overlap) and 1.0 (identical boxes).
#[inline]
pub fn compute_iou(a: &BBox, b: &BBox) -> f32 {
    // Compute intersection
    let x1 = a.x1.max(b.x1);
    let y1 = a.y1.max(b.y1);
    let x2 = a.x2.min(b.x2);
    let y2 = a.y2.min(b.y2);

    let inter_width = (x2 - x1).max(0.0);
    let inter_height = (y2 - y1).max(0.0);
    let inter_area = inter_width * inter_height;

    // Compute union
    let area_a = a.area();
    let area_b = b.area();
    let union_area = area_a + area_b - inter_area;

    if union_area > 0.0 {
        inter_area / union_area
    } else {
        0.0
    }
}

/// Compute IoU using raw coordinate arrays.
///
/// Format: [x1, y1, x2, y2]
#[inline]
pub fn compute_iou_array(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let bbox_a = BBox::from_array(*a);
    let bbox_b = BBox::from_array(*b);
    compute_iou(&bbox_a, &bbox_b)
}

/// Apply Non-Maximum Suppression to filter overlapping detections.
///
/// # Arguments
///
/// * `detections` - Input detections (will be consumed and sorted)
/// * `iou_threshold` - Maximum IoU allowed between kept detections
///
/// # Returns
///
/// Filtered list of detections with overlapping boxes removed.
///
/// # Algorithm
///
/// 1. Sort detections by confidence (descending)
/// 2. For each detection (highest confidence first):
///    - Keep it if not suppressed
///    - Suppress all lower-confidence detections of the same class
///      that have IoU > threshold
///
/// Time complexity: O(n² * c) where n = detections, c = classes
/// Space complexity: O(n)
pub fn non_max_suppression(mut detections: Vec<Detection>, iou_threshold: f32) -> Vec<Detection> {
    if detections.is_empty() {
        return detections;
    }

    // Sort by confidence (descending)
    detections.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let n = detections.len();
    let mut suppressed = vec![false; n];
    let mut kept = Vec::with_capacity(n);

    for i in 0..n {
        if suppressed[i] {
            continue;
        }

        kept.push(detections[i].clone());

        // Suppress overlapping detections of the same class
        for j in (i + 1)..n {
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

    kept
}

/// Apply class-agnostic NMS (suppresses across all classes).
///
/// Use this when you want to limit total detections regardless of class.
pub fn non_max_suppression_agnostic(
    mut detections: Vec<Detection>,
    iou_threshold: f32,
) -> Vec<Detection> {
    if detections.is_empty() {
        return detections;
    }

    // Sort by confidence (descending)
    detections.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let n = detections.len();
    let mut suppressed = vec![false; n];
    let mut kept = Vec::with_capacity(n);

    for i in 0..n {
        if suppressed[i] {
            continue;
        }

        kept.push(detections[i].clone());

        for j in (i + 1)..n {
            if suppressed[j] {
                continue;
            }

            let iou = compute_iou(&detections[i].bbox, &detections[j].bbox);
            if iou > iou_threshold {
                suppressed[j] = true;
            }
        }
    }

    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_detection(
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        confidence: f32,
        class_id: u32,
    ) -> Detection {
        Detection {
            bbox: BBox::new(x1, y1, x2, y2),
            confidence,
            class_id,
            class_label: format!("class_{}", class_id),
        }
    }

    #[test]
    fn test_iou_identical() {
        let bbox = BBox::new(0.0, 0.0, 10.0, 10.0);
        assert!((compute_iou(&bbox, &bbox) - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_iou_no_overlap() {
        let a = BBox::new(0.0, 0.0, 10.0, 10.0);
        let b = BBox::new(20.0, 20.0, 30.0, 30.0);
        assert!(compute_iou(&a, &b) < 0.001);
    }

    #[test]
    fn test_iou_partial_overlap() {
        let a = BBox::new(0.0, 0.0, 10.0, 10.0);
        let b = BBox::new(5.0, 0.0, 15.0, 10.0);
        // Overlap: 5x10 = 50, Union: 100 + 100 - 50 = 150
        let expected = 50.0 / 150.0;
        assert!((compute_iou(&a, &b) - expected).abs() < 0.001);
    }

    #[test]
    fn test_nms_empty() {
        let result = non_max_suppression(vec![], 0.5);
        assert!(result.is_empty());
    }

    #[test]
    fn test_nms_single() {
        let det = make_detection(0.0, 0.0, 10.0, 10.0, 0.9, 0);
        let result = non_max_suppression(vec![det.clone()], 0.5);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_nms_no_overlap() {
        let detections = vec![
            make_detection(0.0, 0.0, 10.0, 10.0, 0.9, 0),
            make_detection(20.0, 20.0, 30.0, 30.0, 0.8, 0),
        ];
        let result = non_max_suppression(detections, 0.5);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_nms_high_overlap_same_class() {
        let detections = vec![
            make_detection(0.0, 0.0, 10.0, 10.0, 0.9, 0),
            make_detection(1.0, 1.0, 11.0, 11.0, 0.8, 0), // High overlap, same class
        ];
        let result = non_max_suppression(detections, 0.5);
        assert_eq!(result.len(), 1);
        assert!((result[0].confidence - 0.9).abs() < 0.001); // Higher confidence kept
    }

    #[test]
    fn test_nms_high_overlap_different_class() {
        let detections = vec![
            make_detection(0.0, 0.0, 10.0, 10.0, 0.9, 0),
            make_detection(1.0, 1.0, 11.0, 11.0, 0.8, 1), // High overlap, different class
        ];
        let result = non_max_suppression(detections, 0.5);
        assert_eq!(result.len(), 2); // Both kept because different classes
    }

    #[test]
    fn test_nms_ordering() {
        // Ensure results are sorted by confidence
        let detections = vec![
            make_detection(0.0, 0.0, 10.0, 10.0, 0.5, 0),
            make_detection(20.0, 20.0, 30.0, 30.0, 0.9, 1),
            make_detection(40.0, 40.0, 50.0, 50.0, 0.7, 2),
        ];
        let result = non_max_suppression(detections, 0.5);
        assert_eq!(result.len(), 3);
        assert!((result[0].confidence - 0.9).abs() < 0.001);
        assert!((result[1].confidence - 0.7).abs() < 0.001);
        assert!((result[2].confidence - 0.5).abs() < 0.001);
    }
}
