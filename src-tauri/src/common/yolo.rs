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
/// Upper bound for raw anchors traversed during postprocessing.
/// The fixed 640x640 Ultralytics export produces 8,400 anchors.
pub const MAX_YOLOV8_ANCHORS: usize = 16_384;
/// Maximum number of scalar values admitted from a YOLOv8 output tensor.
pub const MAX_YOLOV8_OUTPUT_VALUES: usize = YOLOV8_OUTPUT_FEATURES * MAX_YOLOV8_ANCHORS;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputLayout {
    ChannelsFirst,
    AnchorsFirst,
}

pub fn infer_yolov8_output_layout(shape_dims: &[usize]) -> Result<(OutputLayout, usize), String> {
    let (layout, anchors) = match shape_dims {
        [1, features, anchors] if *features == YOLOV8_OUTPUT_FEATURES && *anchors > 0 => {
            (OutputLayout::ChannelsFirst, *anchors)
        }
        [1, anchors, features] if *features == YOLOV8_OUTPUT_FEATURES && *anchors > 0 => {
            (OutputLayout::AnchorsFirst, *anchors)
        }
        _ => return Err(format!("Unexpected output shape: {:?}", shape_dims)),
    };
    validate_yolov8_anchor_count(anchors)?;
    Ok((layout, anchors))
}

pub fn validate_yolov8_anchor_count(num_anchors: usize) -> Result<(), String> {
    if !(1..=MAX_YOLOV8_ANCHORS).contains(&num_anchors) {
        return Err(format!(
            "YOLO output anchor count {num_anchors} is outside 1..={MAX_YOLOV8_ANCHORS}"
        ));
    }
    Ok(())
}

pub fn validate_yolov8_class_count(class_count: usize) -> Result<(), String> {
    if !(1..=YOLOV8_CLASS_COUNT).contains(&class_count) {
        return Err(format!(
            "YOLO class count {class_count} is outside 1..={YOLOV8_CLASS_COUNT}"
        ));
    }
    Ok(())
}

pub fn validate_yolov8_output_len(
    layout: OutputLayout,
    num_anchors: usize,
    output_len: usize,
) -> Result<(), String> {
    validate_yolov8_anchor_count(num_anchors)?;
    let feature_count = match layout {
        OutputLayout::ChannelsFirst | OutputLayout::AnchorsFirst => YOLOV8_OUTPUT_FEATURES,
    };
    let required_len = feature_count
        .checked_mul(num_anchors)
        .ok_or_else(|| format!("YOLO output shape overflows: {num_anchors} anchors"))?;

    if output_len > MAX_YOLOV8_OUTPUT_VALUES {
        return Err(format!(
            "YOLO output contains {output_len} values; maximum is {MAX_YOLOV8_OUTPUT_VALUES}"
        ));
    }

    if output_len < required_len {
        Err(format!(
            "YOLO output data too short: expected at least {} values, got {}",
            required_len, output_len
        ))
    } else if output_len > required_len {
        Err(format!(
            "YOLO output data length mismatch: expected exactly {required_len} values, got {output_len}"
        ))
    } else {
        Ok(())
    }
}

fn validate_anchor_index(num_anchors: usize, anchor_idx: usize) -> Result<(), String> {
    validate_yolov8_anchor_count(num_anchors)?;
    if anchor_idx >= num_anchors {
        return Err(format!(
            "YOLO anchor index {anchor_idx} out of range for {num_anchors} anchors"
        ));
    }
    Ok(())
}

fn checked_output_index(
    feature_idx: usize,
    num_anchors: usize,
    anchor_idx: usize,
) -> Result<usize, String> {
    feature_idx
        .checked_mul(num_anchors)
        .and_then(|base| base.checked_add(anchor_idx))
        .ok_or_else(|| "YOLO output index calculation overflowed".to_string())
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
    validate_anchor_index(num_anchors, anchor_idx)?;
    let bbox = match layout {
        // Layout: [1, 84, N]
        // Index [0, j, i] = j * N + i
        OutputLayout::ChannelsFirst => (
            read_output_value(
                output_data,
                checked_output_index(0, num_anchors, anchor_idx)?,
            )?,
            read_output_value(
                output_data,
                checked_output_index(1, num_anchors, anchor_idx)?,
            )?,
            read_output_value(
                output_data,
                checked_output_index(2, num_anchors, anchor_idx)?,
            )?,
            read_output_value(
                output_data,
                checked_output_index(3, num_anchors, anchor_idx)?,
            )?,
        ),
        // Layout: [1, N, 84]
        // Index [0, i, j] = i * 84 + j
        OutputLayout::AnchorsFirst => {
            let base = anchor_idx
                .checked_mul(YOLOV8_OUTPUT_FEATURES)
                .ok_or_else(|| "YOLO output index calculation overflowed".to_string())?;
            (
                read_output_value(output_data, base)?,
                read_output_value(output_data, base + 1)?,
                read_output_value(output_data, base + 2)?,
                read_output_value(output_data, base + 3)?,
            )
        }
    };

    let (cx, cy, width, height) = bbox;
    if !cx.is_finite() || !cy.is_finite() || !width.is_finite() || !height.is_finite() {
        return Err("YOLO bounding box contains a non-finite value".to_string());
    }
    if width <= 0.0 || height <= 0.0 {
        return Err("YOLO bounding box width and height must be positive".to_string());
    }
    Ok(bbox)
}

pub fn read_class_score(
    layout: OutputLayout,
    output_data: &[f32],
    num_anchors: usize,
    anchor_idx: usize,
    class_idx: usize,
) -> Result<f32, String> {
    validate_anchor_index(num_anchors, anchor_idx)?;
    if class_idx >= YOLOV8_CLASS_COUNT {
        return Err(format!(
            "YOLO class index {} out of range for {} classes",
            class_idx, YOLOV8_CLASS_COUNT
        ));
    }

    let score = match layout {
        OutputLayout::ChannelsFirst => read_output_value(
            output_data,
            checked_output_index(YOLOV8_BBOX_FEATURES + class_idx, num_anchors, anchor_idx)?,
        ),
        OutputLayout::AnchorsFirst => {
            let base = anchor_idx
                .checked_mul(YOLOV8_OUTPUT_FEATURES)
                .and_then(|value| value.checked_add(YOLOV8_BBOX_FEATURES + class_idx))
                .ok_or_else(|| "YOLO output index calculation overflowed".to_string())?;
            read_output_value(output_data, base)
        }
    }?;
    if !score.is_finite() {
        return Err("YOLO class score contains a non-finite value".to_string());
    }
    if !(0.0..=1.0).contains(&score) {
        return Err(format!(
            "YOLO class score {score} is outside the probability range 0..=1"
        ));
    }
    Ok(score)
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
    fn yolov8_layout_rejects_oversized_anchor_counts_for_both_layouts() {
        let oversized = MAX_YOLOV8_ANCHORS + 1;

        assert!(infer_yolov8_output_layout(&[1, YOLOV8_OUTPUT_FEATURES, oversized]).is_err());
        assert!(infer_yolov8_output_layout(&[1, oversized, YOLOV8_OUTPUT_FEATURES]).is_err());
    }

    #[test]
    fn yolov8_output_length_validation_rejects_trailing_values() {
        let error =
            validate_yolov8_output_len(OutputLayout::ChannelsFirst, 1, YOLOV8_OUTPUT_FEATURES + 1)
                .unwrap_err();

        assert!(error.contains("expected exactly"));
    }

    #[test]
    fn yolov8_output_length_validation_rejects_the_global_value_ceiling() {
        let error = validate_yolov8_output_len(
            OutputLayout::ChannelsFirst,
            1,
            MAX_YOLOV8_OUTPUT_VALUES + 1,
        )
        .unwrap_err();

        assert!(error.contains("maximum"));
    }

    #[test]
    fn yolov8_class_count_validation_rejects_zero_and_oversized_counts() {
        assert!(validate_yolov8_class_count(0).is_err());
        assert!(validate_yolov8_class_count(YOLOV8_CLASS_COUNT + 1).is_err());
    }

    #[test]
    fn yolov8_bbox_reader_rejects_non_finite_values_for_both_layouts() {
        for layout in [OutputLayout::ChannelsFirst, OutputLayout::AnchorsFirst] {
            let mut data = vec![0.0f32; YOLOV8_OUTPUT_FEATURES];
            data[0] = f32::NAN;
            data[1] = 1.0;
            data[2] = 1.0;
            data[3] = 1.0;

            assert!(read_bbox(layout, &data, 1, 0).is_err());
        }
    }

    #[test]
    fn yolov8_bbox_reader_rejects_non_positive_geometry_for_both_layouts() {
        for layout in [OutputLayout::ChannelsFirst, OutputLayout::AnchorsFirst] {
            let mut data = vec![0.0f32; YOLOV8_OUTPUT_FEATURES];
            data[0] = 1.0;
            data[1] = 1.0;
            data[2] = -1.0;
            data[3] = 1.0;

            assert!(read_bbox(layout, &data, 1, 0).is_err());
        }
    }

    #[test]
    fn yolov8_score_reader_rejects_invalid_probabilities_for_both_layouts() {
        for layout in [OutputLayout::ChannelsFirst, OutputLayout::AnchorsFirst] {
            for invalid_score in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
                let mut data = vec![0.0f32; YOLOV8_OUTPUT_FEATURES];
                data[YOLOV8_BBOX_FEATURES] = invalid_score;

                assert!(read_class_score(layout, &data, 1, 0, 0).is_err());
            }
        }
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
