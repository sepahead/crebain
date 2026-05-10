//! YOLO model output helpers.
//!
//! CREBAIN currently expects Ultralytics-style YOLOv8 outputs with 84 features:
//! 4 bbox coords (cx, cy, w, h) + 80 class scores (COCO).
//!
//! Different export paths may produce either:
//! - `[1, 84, N]` (channels-first)
//! - `[1, N, 84]` (anchors-first)

/// YOLOv8 COCO output features: 4 box coords + 80 class scores.
pub const YOLOV8_OUTPUT_FEATURES: usize = 84;
pub const YOLOV8_BBOX_FEATURES: usize = 4;
pub const YOLOV8_CLASS_COUNT: usize = YOLOV8_OUTPUT_FEATURES - YOLOV8_BBOX_FEATURES;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputLayout {
    ChannelsFirst,
    AnchorsFirst,
}

pub fn infer_yolov8_output_layout(shape_dims: &[usize]) -> Result<(OutputLayout, usize), String> {
    match shape_dims {
        [1, features, anchors] if *features == YOLOV8_OUTPUT_FEATURES && *anchors > 0 => {
            Ok((OutputLayout::ChannelsFirst, *anchors))
        }
        [1, anchors, features] if *features == YOLOV8_OUTPUT_FEATURES && *anchors > 0 => {
            Ok((OutputLayout::AnchorsFirst, *anchors))
        }
        _ => Err(format!("Unexpected output shape: {:?}", shape_dims)),
    }
}

pub fn validate_yolov8_output_len(
    layout: OutputLayout,
    num_anchors: usize,
    output_len: usize,
) -> Result<(), String> {
    let required_len = match layout {
        OutputLayout::ChannelsFirst | OutputLayout::AnchorsFirst => YOLOV8_OUTPUT_FEATURES
            .checked_mul(num_anchors)
            .ok_or_else(|| format!("YOLO output shape overflows: {} anchors", num_anchors))?,
    };

    if output_len < required_len {
        Err(format!(
            "YOLO output data too short: expected at least {} values, got {}",
            required_len, output_len
        ))
    } else {
        Ok(())
    }
}

fn read_output_value(output_data: &[f32], index: usize) -> Result<f32, String> {
    output_data.get(index).copied().ok_or_else(|| {
        format!(
            "YOLO output index {} out of bounds for {} values",
            index,
            output_data.len()
        )
    })
}

pub fn read_bbox(
    layout: OutputLayout,
    output_data: &[f32],
    num_anchors: usize,
    anchor_idx: usize,
) -> Result<(f32, f32, f32, f32), String> {
    match layout {
        // Layout: [1, 84, N]
        // Index [0, j, i] = j * N + i
        OutputLayout::ChannelsFirst => Ok((
            read_output_value(output_data, anchor_idx)?,
            read_output_value(output_data, num_anchors + anchor_idx)?,
            read_output_value(output_data, 2 * num_anchors + anchor_idx)?,
            read_output_value(output_data, 3 * num_anchors + anchor_idx)?,
        )),
        // Layout: [1, N, 84]
        // Index [0, i, j] = i * 84 + j
        OutputLayout::AnchorsFirst => {
            let base = anchor_idx * YOLOV8_OUTPUT_FEATURES;
            Ok((
                read_output_value(output_data, base)?,
                read_output_value(output_data, base + 1)?,
                read_output_value(output_data, base + 2)?,
                read_output_value(output_data, base + 3)?,
            ))
        }
    }
}

pub fn read_class_score(
    layout: OutputLayout,
    output_data: &[f32],
    num_anchors: usize,
    anchor_idx: usize,
    class_idx: usize,
) -> Result<f32, String> {
    if class_idx >= YOLOV8_CLASS_COUNT {
        return Err(format!(
            "YOLO class index {} out of range for {} classes",
            class_idx, YOLOV8_CLASS_COUNT
        ));
    }

    match layout {
        OutputLayout::ChannelsFirst => read_output_value(
            output_data,
            (YOLOV8_BBOX_FEATURES + class_idx) * num_anchors + anchor_idx,
        ),
        OutputLayout::AnchorsFirst => read_output_value(
            output_data,
            anchor_idx * YOLOV8_OUTPUT_FEATURES + YOLOV8_BBOX_FEATURES + class_idx,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yolov8_layout_channels_first_indexes_correctly() {
        let num_anchors = 2usize;
        let shape = [1, YOLOV8_OUTPUT_FEATURES, num_anchors];
        let (layout, anchors) = infer_yolov8_output_layout(&shape).unwrap();
        assert_eq!(layout, OutputLayout::ChannelsFirst);
        assert_eq!(anchors, num_anchors);

        let mut data = vec![0.0f32; YOLOV8_OUTPUT_FEATURES * num_anchors];
        // bbox for anchor 1
        data[1] = 11.0;
        data[num_anchors + 1] = 21.0;
        data[2 * num_anchors + 1] = 31.0;
        data[3 * num_anchors + 1] = 41.0;
        // class score (class 5) for anchor 0
        data[(4 + 5) * num_anchors] = 0.9;

        validate_yolov8_output_len(layout, anchors, data.len()).unwrap();

        let (cx, cy, w, h) = read_bbox(layout, &data, anchors, 1).unwrap();
        assert_eq!((cx, cy, w, h), (11.0, 21.0, 31.0, 41.0));
        assert_eq!(read_class_score(layout, &data, anchors, 0, 5).unwrap(), 0.9);
    }

    #[test]
    fn yolov8_layout_anchors_first_indexes_correctly() {
        let num_anchors = 2usize;
        let shape = [1, num_anchors, YOLOV8_OUTPUT_FEATURES];
        let (layout, anchors) = infer_yolov8_output_layout(&shape).unwrap();
        assert_eq!(layout, OutputLayout::AnchorsFirst);
        assert_eq!(anchors, num_anchors);

        let mut data = vec![0.0f32; YOLOV8_OUTPUT_FEATURES * num_anchors];
        // bbox for anchor 1
        let base = YOLOV8_OUTPUT_FEATURES;
        data[base] = 11.0;
        data[base + 1] = 21.0;
        data[base + 2] = 31.0;
        data[base + 3] = 41.0;
        // class score (class 5) for anchor 0
        data[4 + 5] = 0.9;

        validate_yolov8_output_len(layout, anchors, data.len()).unwrap();

        let (cx, cy, w, h) = read_bbox(layout, &data, anchors, 1).unwrap();
        assert_eq!((cx, cy, w, h), (11.0, 21.0, 31.0, 41.0));
        assert_eq!(read_class_score(layout, &data, anchors, 0, 5).unwrap(), 0.9);
    }

    #[test]
    fn yolov8_layout_rejects_unexpected_shapes() {
        assert!(infer_yolov8_output_layout(&[1, 85, 8400]).is_err());
        assert!(infer_yolov8_output_layout(&[1, 8400]).is_err());
        assert!(infer_yolov8_output_layout(&[2, YOLOV8_OUTPUT_FEATURES, 8400]).is_err());
        assert!(infer_yolov8_output_layout(&[1, YOLOV8_OUTPUT_FEATURES, 0]).is_err());
    }

    #[test]
    fn yolov8_output_length_validation_rejects_short_data() {
        let (layout, anchors) =
            infer_yolov8_output_layout(&[1, YOLOV8_OUTPUT_FEATURES, 2]).unwrap();

        let error =
            validate_yolov8_output_len(layout, anchors, YOLOV8_OUTPUT_FEATURES - 1).unwrap_err();

        assert!(error.contains("too short"));
    }

    #[test]
    fn yolov8_read_helpers_reject_out_of_bounds_access() {
        let data = vec![0.0f32; YOLOV8_OUTPUT_FEATURES];

        assert!(read_bbox(OutputLayout::AnchorsFirst, &data, 1, 1).is_err());
        assert!(
            read_class_score(OutputLayout::AnchorsFirst, &data, 1, 0, YOLOV8_CLASS_COUNT).is_err()
        );
    }
}
