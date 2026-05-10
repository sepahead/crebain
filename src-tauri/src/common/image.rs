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

pub fn validate_rgba_input_len(rgba_len: usize, width: u32, height: u32) -> Result<usize, String> {
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
    if rgba_len != expected_size {
        return Err(format!(
            "Invalid RGBA data size: expected {} bytes for {}x{}, got {}",
            expected_size, width, height, rgba_len
        ));
    }

    Ok(expected_size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_exact_rgba_size() {
        assert_eq!(validate_rgba_input_len(16, 2, 2).unwrap(), 16);
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
