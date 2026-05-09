//! Path validation utilities for security.
//!
//! Provides functions to validate file paths from untrusted sources
//! (e.g., environment variables, user input) to prevent path traversal attacks.

use super::error::{PathError, PathResult};
use std::path::{Path, PathBuf};

fn env_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "y" | "on"
    )
}

/// Determine a writable TensorRT engine cache directory.
///
/// The ONNX Runtime TensorRT execution provider can cache built engines on disk
/// to avoid rebuilds on every launch. On Linux this should be a user-writable
/// path (CWD is often read-only in packaged apps).
///
/// Environment variables:
/// - `CREBAIN_DISABLE_TRT_CACHE`: disables caching when truthy
/// - `CREBAIN_TRT_CACHE_DIR`: overrides cache directory path
pub fn tensorrt_engine_cache_dir() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("CREBAIN_DISABLE_TRT_CACHE") {
        if env_truthy(&value) {
            return None;
        }
    }

    let candidate = if let Ok(custom) = std::env::var("CREBAIN_TRT_CACHE_DIR") {
        let trimmed = custom.trim();
        if trimmed.is_empty() {
            return None;
        }
        PathBuf::from(trimmed)
    } else if let Ok(xdg_cache) = std::env::var("XDG_CACHE_HOME") {
        PathBuf::from(xdg_cache).join("crebain").join("trt_cache")
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".cache").join("crebain").join("trt_cache")
    } else {
        std::env::temp_dir().join("crebain").join("trt_cache")
    };

    if let Err(e) = std::fs::create_dir_all(&candidate) {
        log::warn!(
            "Failed to create TensorRT engine cache dir {}: {} (caching disabled)",
            candidate.display(),
            e
        );
        return None;
    }

    Some(candidate)
}

/// Validate a path for security issues.
///
/// # Checks performed:
/// - No null bytes (prevents truncation attacks on C FFI)
/// - No path traversal sequences (`..` or `./..`)
/// - Path must be within allowed root (if specified)
///
/// # Arguments
/// * `path` - The path to validate
/// * `allowed_root` - Optional root directory the path must be under
///
/// # Returns
/// * `Ok(PathBuf)` - Canonicalized path if valid
/// * `Err(PathError)` - Structured error if validation fails
pub fn validate_path_strict(path: &str, allowed_root: Option<&Path>) -> PathResult<PathBuf> {
    // Check for null bytes (C string truncation attack)
    if path.contains('\0') {
        return Err(PathError::InvalidCharacters("null byte in path".to_string()));
    }

    // Check for empty path
    if path.is_empty() {
        return Err(PathError::InvalidCharacters("empty path".to_string()));
    }

    let path_buf = PathBuf::from(path);

    // Check for path traversal attempts
    for component in path_buf.components() {
        use std::path::Component;
        match component {
            Component::ParentDir => {
                return Err(PathError::TraversalAttempt(path.to_string()));
            }
            Component::Normal(s) => {
                // Check for hidden traversal in component names
                if let Some(name) = s.to_str() {
                    if name.contains('\0') {
                        return Err(PathError::InvalidCharacters(
                            "null byte in path component".to_string(),
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    // If allowed_root is specified, ensure path is under it
    if let Some(root) = allowed_root {
        // Canonicalize both paths for comparison
        let canonical_root = root.canonicalize().map_err(|e| {
            PathError::CanonicalizationFailed(format!("root path: {}", e))
        })?;

        // Try to canonicalize the target path
        // If it doesn't exist, construct what it would be
        let canonical_path = if path_buf.exists() {
            path_buf.canonicalize().map_err(|e| {
                PathError::CanonicalizationFailed(format!("target path: {}", e))
            })?
        } else {
            // For non-existent paths, resolve relative to current dir
            std::env::current_dir()
                .map_err(|e| PathError::CanonicalizationFailed(format!("current dir: {}", e)))?
                .join(&path_buf)
        };

        // Check if the path is under the allowed root
        if !canonical_path.starts_with(&canonical_root) {
            return Err(PathError::TraversalAttempt(format!(
                "{} escapes {}",
                canonical_path.display(),
                canonical_root.display()
            )));
        }

        Ok(canonical_path)
    } else {
        // No root restriction, just return the path
        Ok(path_buf)
    }
}

/// Validate a path for security issues.
///
/// Wrapper that returns String errors for backwards compatibility.
pub fn validate_path(path: &str, allowed_root: Option<&Path>) -> Result<PathBuf, String> {
    validate_path_strict(path, allowed_root).map_err(|e| e.to_string())
}

/// Validate a model file path.
///
/// Convenience wrapper for model paths that:
/// - Validates path security
/// - Checks file exists
/// - Optionally validates extension
///
/// # Arguments
/// * `path` - The model path to validate
/// * `expected_extensions` - Optional list of allowed extensions (e.g., ["onnx", "mlmodelc"])
pub fn validate_model_path(path: &str, expected_extensions: Option<&[&str]>) -> Result<PathBuf, String> {
    // Basic security validation
    let validated = validate_path(path, None)?;

    // Check file exists
    if !validated.exists() {
        return Err(format!("Model file does not exist: {}", validated.display()));
    }

    // Check extension if specified
    if let Some(extensions) = expected_extensions {
        let ext = validated
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        if !extensions.iter().any(|&e| e.eq_ignore_ascii_case(ext)) {
            return Err(format!(
                "Invalid model extension '{}', expected one of: {:?}",
                ext, extensions
            ));
        }
    }

    Ok(validated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_null_byte_rejected() {
        assert!(validate_path("/tmp/test\0.txt", None).is_err());
    }

    #[test]
    fn test_parent_dir_rejected() {
        assert!(validate_path("../etc/passwd", None).is_err());
        assert!(validate_path("/tmp/../etc/passwd", None).is_err());
        assert!(validate_path("models/../../../etc/passwd", None).is_err());
    }

    #[test]
    fn test_empty_path_rejected() {
        assert!(validate_path("", None).is_err());
    }

    #[test]
    fn test_valid_path_accepted() {
        assert!(validate_path("/tmp/model.onnx", None).is_ok());
        assert!(validate_path("resources/yolov8s.onnx", None).is_ok());
    }

    #[test]
    fn test_model_extension_validation() {
        // This will fail if file doesn't exist, which is expected in tests
        let result = validate_model_path("/nonexistent/model.txt", Some(&["onnx"]));
        assert!(result.is_err());
    }

    #[test]
    fn test_existing_model_extension_validation() {
        let model_path = std::env::temp_dir().join(format!(
            "crebain-model-{}.onnx",
            std::process::id()
        ));
        std::fs::write(&model_path, b"model").unwrap();

        assert!(validate_model_path(model_path.to_str().unwrap(), Some(&["onnx"])).is_ok());
        assert!(validate_model_path(model_path.to_str().unwrap(), Some(&["mlmodelc"])).is_err());

        let _ = std::fs::remove_file(model_path);
    }

    #[test]
    fn test_model_extension_validation_is_case_insensitive() {
        let model_path = std::env::temp_dir().join(format!(
            "crebain-model-case-{}.ONNX",
            std::process::id()
        ));
        std::fs::write(&model_path, b"model").unwrap();

        assert!(validate_model_path(model_path.to_str().unwrap(), Some(&["onnx"])).is_ok());

        let _ = std::fs::remove_file(model_path);
    }

    #[test]
    fn test_allowed_root_rejects_escaped_absolute_path() {
        let root = std::env::temp_dir().join(format!(
            "crebain-root-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let outside = std::env::temp_dir().join(format!(
            "crebain-outside-{}.json",
            std::process::id()
        ));
        std::fs::write(&outside, "{}").unwrap();

        assert!(validate_path(outside.to_str().unwrap(), Some(&root)).is_err());

        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir(root);
    }
}
