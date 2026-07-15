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
        PathBuf::from(home)
            .join(".cache")
            .join("crebain")
            .join("trt_cache")
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
        return Err(PathError::InvalidCharacters(
            "null byte in path".to_string(),
        ));
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
        let canonical_root = root
            .canonicalize()
            .map_err(|e| PathError::CanonicalizationFailed(format!("root path: {}", e)))?;

        let candidate_path = if path_buf.is_absolute() {
            path_buf
        } else {
            canonical_root.join(&path_buf)
        };

        // Try to canonicalize the target path. If it does not exist yet,
        // canonicalize the deepest EXISTING ancestor and re-join the remaining
        // components: a purely textual check on a non-existent prefix would let
        // a symlink in the existing part (e.g. root/link -> /outside, with
        // root/link/newdir/file not existing) validate as inside the root.
        let canonical_path = if candidate_path.exists() {
            candidate_path
                .canonicalize()
                .map_err(|e| PathError::CanonicalizationFailed(format!("target path: {}", e)))?
        } else {
            let mut ancestor = candidate_path.as_path();
            // Not-yet-existing trailing components, deepest first. Existence is
            // probed via symlink_metadata (not exists(), which follows links) so
            // a dangling symlink counts as the deepest existing ancestor and
            // fails canonicalization below (fail closed) instead of being
            // skipped and re-joined textually.
            let mut pending: Vec<std::ffi::OsString> = Vec::new();
            while ancestor.symlink_metadata().is_err() {
                match (ancestor.parent(), ancestor.file_name()) {
                    (Some(parent), Some(name)) => {
                        pending.push(name.to_os_string());
                        ancestor = parent;
                    }
                    // No existing ancestor at all (candidate_path is absolute,
                    // so on Unix the walk always terminates at "/"): fail closed
                    // via the canonicalize error below.
                    _ => break,
                }
            }
            let canonical_ancestor = ancestor.canonicalize().map_err(|e| {
                PathError::CanonicalizationFailed(format!("target ancestor: {}", e))
            })?;
            pending
                .into_iter()
                .rev()
                .fold(canonical_ancestor, |acc, name| acc.join(name))
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
/// - Rejects a symlink at the model boundary
/// - Requires a regular file, except for a compiled `.mlmodelc` directory
/// - Optionally validates extension
///
/// # Arguments
/// * `path` - The model path to validate
/// * `expected_extensions` - Optional list of allowed extensions (e.g., ["onnx", "mlmodelc"])
pub fn validate_model_path(
    path: &str,
    expected_extensions: Option<&[&str]>,
) -> Result<PathBuf, String> {
    // Basic security validation
    let validated = validate_path(path, None)?;

    // Use symlink_metadata so a dangling link is not confused with a missing
    // path and a live link is not followed before the boundary decision.
    let metadata = validated.symlink_metadata().map_err(|error| {
        format!(
            "Model path is unavailable or unreadable ({}): {error}",
            validated.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Model path must not be a symlink: {}",
            validated.display()
        ));
    }

    // Check extension if specified
    let extension = validated.extension().and_then(|e| e.to_str()).unwrap_or("");
    if let Some(extensions) = expected_extensions {
        let ext = extension;

        if !extensions.iter().any(|&e| e.eq_ignore_ascii_case(ext)) {
            return Err(format!(
                "Invalid model extension '{}', expected one of: {:?}",
                ext, extensions
            ));
        }
    }

    if extension.eq_ignore_ascii_case("mlmodelc") {
        if !metadata.file_type().is_dir() {
            return Err(format!(
                "Compiled CoreML model must be a directory: {}",
                validated.display()
            ));
        }
    } else if !metadata.file_type().is_file() {
        return Err(format!(
            "Model path must be a regular file: {}",
            validated.display()
        ));
    }

    validated
        .canonicalize()
        .map_err(|error| format!("Failed to canonicalize model path: {error}"))
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
        let model_path =
            std::env::temp_dir().join(format!("crebain-model-{}.onnx", std::process::id()));
        std::fs::write(&model_path, b"model").unwrap();

        assert!(validate_model_path(model_path.to_str().unwrap(), Some(&["onnx"])).is_ok());
        assert!(validate_model_path(model_path.to_str().unwrap(), Some(&["mlmodelc"])).is_err());

        let _ = std::fs::remove_file(model_path);
    }

    #[test]
    fn test_model_extension_validation_is_case_insensitive() {
        let model_path =
            std::env::temp_dir().join(format!("crebain-model-case-{}.ONNX", std::process::id()));
        std::fs::write(&model_path, b"model").unwrap();

        assert!(validate_model_path(model_path.to_str().unwrap(), Some(&["onnx"])).is_ok());

        let _ = std::fs::remove_file(model_path);
    }

    #[test]
    fn test_model_path_rejects_null_byte() {
        let error = validate_model_path("/tmp/model\0.onnx", Some(&["onnx"])).unwrap_err();

        assert!(error.contains("null byte"));
    }

    #[test]
    fn test_model_path_rejects_traversal_before_existence_check() {
        let error = validate_model_path("../models/model.onnx", Some(&["onnx"])).unwrap_err();

        assert!(error.contains("traversal") || error.contains("Traversal"));
    }

    #[test]
    fn test_model_path_rejects_existing_file_without_expected_extension() {
        let model_path =
            std::env::temp_dir().join(format!("crebain-model-no-ext-{}", std::process::id()));
        std::fs::write(&model_path, b"model").unwrap();

        let error = validate_model_path(model_path.to_str().unwrap(), Some(&["onnx"])).unwrap_err();

        assert!(error.contains("Invalid model extension"));

        let _ = std::fs::remove_file(model_path);
    }

    #[test]
    fn test_model_path_accepts_mlmodelc_directory() {
        let model_path =
            std::env::temp_dir().join(format!("crebain-model-dir-{}.mlmodelc", std::process::id()));
        std::fs::create_dir_all(&model_path).unwrap();

        assert!(validate_model_path(model_path.to_str().unwrap(), Some(&["mlmodelc"])).is_ok());

        let _ = std::fs::remove_dir_all(model_path);
    }

    #[test]
    fn test_regular_model_rejects_directory() {
        let model_path =
            std::env::temp_dir().join(format!("crebain-model-dir-{}.onnx", std::process::id()));
        std::fs::create_dir_all(&model_path).unwrap();

        let error = validate_model_path(model_path.to_str().unwrap(), Some(&["onnx"])).unwrap_err();
        assert!(error.contains("regular file"));

        let _ = std::fs::remove_dir_all(model_path);
    }

    #[cfg(unix)]
    #[test]
    fn test_model_path_rejects_symlink() {
        let base = std::env::temp_dir().join(format!("crebain-model-link-{}", std::process::id()));
        let target = base.with_extension("target.onnx");
        let link = base.with_extension("onnx");
        std::fs::write(&target, b"model").unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = validate_model_path(link.to_str().unwrap(), Some(&["onnx"])).unwrap_err();
        assert!(error.contains("symlink"));

        let _ = std::fs::remove_file(link);
        let _ = std::fs::remove_file(target);
    }

    #[cfg(unix)]
    #[test]
    fn test_model_path_rejects_socket() {
        use std::os::unix::net::UnixListener;

        let socket =
            std::env::temp_dir().join(format!("crebain-model-socket-{}.onnx", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).unwrap();

        let error = validate_model_path(socket.to_str().unwrap(), Some(&["onnx"])).unwrap_err();
        assert!(error.contains("regular file"));

        drop(listener);
        let _ = std::fs::remove_file(socket);
    }

    #[test]
    fn test_allowed_root_rejects_escaped_absolute_path() {
        let root = std::env::temp_dir().join(format!("crebain-root-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let outside =
            std::env::temp_dir().join(format!("crebain-outside-{}.json", std::process::id()));
        std::fs::write(&outside, "{}").unwrap();

        assert!(validate_path(outside.to_str().unwrap(), Some(&root)).is_err());

        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir(root);
    }

    #[cfg(unix)]
    #[test]
    fn test_allowed_root_rejects_symlink_escape_through_nonexistent_suffix() {
        // root/link -> outside; neither link/newdir nor link/newdir/file.txt
        // exists, so the old textual containment check passed. The deepest
        // existing ancestor (root/link) canonicalizes outside the root and must
        // be rejected.
        let root =
            std::env::temp_dir().join(format!("crebain-symlink-root-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("crebain-symlink-outside-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = root.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let result = validate_path("link/newdir/file.txt", Some(&root));
        assert!(
            result.is_err(),
            "symlinked prefix escaping the root must be rejected, got {result:?}"
        );

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir(&outside);
        let _ = std::fs::remove_dir(&root);
    }

    #[test]
    fn test_allowed_root_resolves_relative_nonexistent_path_under_root() {
        let root =
            std::env::temp_dir().join(format!("crebain-relative-root-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        let validated = validate_path("nested/scene.json", Some(&root)).unwrap();

        assert!(validated.starts_with(root.canonicalize().unwrap()));
        assert!(validated.ends_with("nested/scene.json"));

        let _ = std::fs::remove_dir(root);
    }
}
