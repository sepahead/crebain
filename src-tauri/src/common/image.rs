use std::io::Cursor;

use image::{DynamicImage, ImageFormat, ImageReader, Limits};

pub const MAX_IMAGE_DIMENSION: u32 = 8192;
pub const MAX_IMAGE_SIZE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_BASE64_IMAGE_CHARS: usize = MAX_IMAGE_SIZE_BYTES.div_ceil(3) * 4;

pub fn validate_base64_image_len(base64_len: usize) -> Result<usize, String> {
    if base64_len == 0 {
        return Err("Empty image data".to_string());
    }
    if base64_len > MAX_BASE64_IMAGE_CHARS {
        return Err(format!(
            "Base64 image data too large: {} characters exceeds maximum {} characters",
            base64_len, MAX_BASE64_IMAGE_CHARS
        ));
    }
    Ok(base64_len)
}

pub fn validate_rgba_dimensions(width: u32, height: u32) -> Result<usize, String> {
    if width == 0 || height == 0 {
        return Err("Invalid image dimensions: width and height must be > 0".to_string());
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(format!(
            "Image dimensions too large: {}x{} exceeds maximum {}x{}",
            width, height, MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION
        ));
    }

    let expected_size = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| format!("Image dimensions overflow: {}x{}", width, height))?;
    if expected_size > MAX_IMAGE_SIZE_BYTES {
        return Err(format!(
            "Image too large: {} bytes exceeds maximum {} bytes",
            expected_size, MAX_IMAGE_SIZE_BYTES
        ));
    }
    Ok(expected_size)
}

pub fn validate_rgba_input_len(rgba_len: usize, width: u32, height: u32) -> Result<usize, String> {
    let expected_size = validate_rgba_dimensions(width, height)?;
    if rgba_len != expected_size {
        return Err(format!(
            "Invalid RGBA data size: expected {} bytes for {}x{}, got {}",
            expected_size, width, height, rgba_len
        ));
    }

    Ok(expected_size)
}

/// Inspect an untrusted encoded image without decoding its pixel buffer.
/// Only PNG/JPEG are accepted and their declared dimensions must fit the same
/// RGBA allocation budget used by the full decoder.
pub fn inspect_encoded_image(encoded: &[u8]) -> Result<(ImageFormat, u32, u32), String> {
    if encoded.is_empty() {
        return Err("Image data is empty".to_string());
    }

    let probe = ImageReader::new(Cursor::new(encoded))
        .with_guessed_format()
        .map_err(|e| format!("Image format detection error: {e}"))?;
    let format = probe
        .format()
        .filter(|format| matches!(format, ImageFormat::Png | ImageFormat::Jpeg))
        .ok_or_else(|| "Unsupported image format: expected PNG or JPEG".to_string())?;
    let (width, height) = probe
        .into_dimensions()
        .map_err(|e| format!("Image dimension decode error: {e}"))?;
    validate_rgba_dimensions(width, height)?;

    Ok((format, width, height))
}

/// Decode an untrusted PNG/JPEG while enforcing CREBAIN's dimensions and
/// decoded-RGBA byte budget before allocating the full pixel buffer.
pub fn decode_image_with_limits(encoded: &[u8]) -> Result<DynamicImage, String> {
    let (format, _, _) = inspect_encoded_image(encoded)?;

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_SIZE_BYTES as u64);

    let mut reader = ImageReader::with_format(Cursor::new(encoded), format);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|e| format!("Image decode error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_exact_rgba_size() {
        assert_eq!(validate_rgba_input_len(16, 2, 2).unwrap(), 16);
    }

    #[test]
    fn rejects_dimensions_whose_rgba_buffer_exceeds_budget() {
        assert!(validate_rgba_dimensions(4096, 4096).is_ok());
        assert!(validate_rgba_dimensions(4097, 4097).is_err());
    }

    #[test]
    fn rejects_unknown_encoded_image_formats() {
        let error = decode_image_with_limits(b"not an image").unwrap_err();
        assert!(error.contains("Unsupported image format"));
    }

    #[test]
    fn inspects_encoded_dimensions_without_decoding_pixels() {
        let image = DynamicImage::new_rgba8(2, 3);
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .unwrap();

        assert_eq!(
            inspect_encoded_image(&png).unwrap(),
            (ImageFormat::Png, 2, 3)
        );
    }

    #[test]
    fn validates_base64_payload_boundaries() {
        assert!(validate_base64_image_len(1).is_ok());
        assert!(validate_base64_image_len(0).is_err());
        assert!(validate_base64_image_len(MAX_BASE64_IMAGE_CHARS + 1).is_err());
    }

    #[test]
    fn rejects_invalid_boundaries() {
        assert!(validate_rgba_input_len(0, 0, 1).is_err());
        assert!(validate_rgba_input_len(15, 2, 2).is_err());
        assert!(validate_rgba_input_len(0, MAX_IMAGE_DIMENSION + 1, 1).is_err());
        assert!(validate_rgba_input_len(0, u32::MAX, u32::MAX).is_err());
    }
}
