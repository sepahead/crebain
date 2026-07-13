use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crebain_lib::common::image::{
    decode_image_with_limits, inspect_encoded_image, MAX_IMAGE_SIZE_BYTES,
};
use crebain_lib::inference::{
    create_detector_with_backend, Backend, Detection, DetectionPolicy, Detector, DetectorRuntime,
    InferenceError,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

const SCHEMA_VERSION: &str = "crebain.native-detector-benchmark.v1";
const MEASUREMENT_SCOPE: &str = "callLatencyMs measures one DetectorRuntime::detect call; runtimeReportedLatencyMs is the latency returned by that runtime; sequentialDetectorThroughputFps is iterations divided by the sum of callLatencyMs; evidenceLoopWallMs additionally includes timing, first-output cloning, detection JSON serialization/digesting, and sample recording; initializationMs includes detector construction and Detector::warmup; fixture decoding, Tauri IPC, spawn_blocking queueing, camera transport, renderer load, and UI work are excluded";
const PROVIDER_LABEL_SCOPE: &str = "providerLabel identifies the backend or successfully registered execution provider selected by CREBAIN; it does not attest accelerator placement or prove that every graph operation ran on that provider";
const REPORT_SENSITIVITY_NOTICE: &str = "local file paths and environment values are redacted, but this report contains an operator-supplied hardware label, model/fixture digests, the ONNX Runtime loading record and—only for a configured Linux library—a runtime digest, raw timings, detection counts, and first-frame detections; review it before sharing";
const FORCED_MLX_PROFILING_POLICY: &str = "forced-disabled";
const FORCED_TENSORRT_CACHE_POLICY: &str = "forced-persistent-engine-cache-disabled";
const TREE_HASH_DOMAIN: &[u8] = b"CREBAIN-MLMODELC-TREE-SHA256-V1\0";
const MAX_WARMUPS: usize = 100;
const MAX_ITERATIONS: usize = 1_000;
const MAX_MODEL_ENTRIES: usize = 10_000;
const MAX_MODEL_DEPTH: usize = 64;
const MAX_MODEL_BYTES: u64 = 4 * 1024 * 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_RUNTIME_LIBRARY_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_BASELINE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_REPORT_BYTES: usize = 16 * 1024 * 1024;
const MAX_LABEL_CHARS: usize = 256;
const MAX_PROVIDER_CHARS: usize = 256;
const MAX_REGRESSION_PERCENT: f64 = 1_000.0;

const USAGE: &str = "\
CREBAIN native detector benchmark (supported command uses Cargo --release)\n\
\n\
Required:\n\
  --backend <coreml|mlx|cuda|tensorrt|onnx>\n\
  --model <path>\n\
  --fixture <png-or-jpeg>\n\
  --output <new-json-path>\n\
  --hardware <stable-target-label>\n\
  --source-commit <40-hex-git-commit>\n\
\n\
Optional:\n\
  --warmups <1..100>                 default: 5\n\
  --iterations <1..1000>             default: 100\n\
  --confidence <0.25..1.0>           default: 0.25\n\
  --iou <0.0..0.45>                  default: 0.45\n\
  --max-detections <1..100>          default: 100\n\
  --baseline <prior-json> --baseline-sha256 <trusted-64-hex>\n\
  --max-regression-percent <0..1000>\n";

type BenchResult<T> = Result<T, BenchmarkError>;

#[derive(Debug, Clone, PartialEq, Eq)]
enum BenchmarkError {
    InvalidConfiguration(String),
    InvalidArtifact(String),
    IdentityMismatch(String),
    Regression(String),
    Inference(String),
    Io(String),
    Serialization(String),
}

impl fmt::Display for BenchmarkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (kind, message) = match self {
            Self::InvalidConfiguration(message) => ("invalid configuration", message),
            Self::InvalidArtifact(message) => ("invalid benchmark artifact", message),
            Self::IdentityMismatch(message) => ("baseline identity mismatch", message),
            Self::Regression(message) => ("benchmark regression", message),
            Self::Inference(message) => ("inference failure", message),
            Self::Io(message) => ("I/O failure", message),
            Self::Serialization(message) => ("serialization failure", message),
        };
        write!(formatter, "{kind}: {message}")
    }
}

impl Error for BenchmarkError {}

impl From<InferenceError> for BenchmarkError {
    fn from(error: InferenceError) -> Self {
        Self::Inference(error.to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PolicyRecord {
    confidence_threshold: f32,
    iou_threshold: f32,
    max_detections: usize,
}

impl PolicyRecord {
    fn new(
        confidence_threshold: f32,
        iou_threshold: f32,
        max_detections: usize,
    ) -> BenchResult<Self> {
        DetectionPolicy::new(confidence_threshold, iou_threshold, max_detections)
            .map_err(BenchmarkError::from)?;
        Ok(Self {
            confidence_threshold,
            iou_threshold,
            max_detections,
        })
    }

    fn runtime_policy(self) -> BenchResult<DetectionPolicy> {
        DetectionPolicy::new(
            self.confidence_threshold,
            self.iou_threshold,
            self.max_detections,
        )
        .map_err(BenchmarkError::from)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RunConfig {
    warmups: usize,
    iterations: usize,
}

impl RunConfig {
    fn new(warmups: usize, iterations: usize) -> BenchResult<Self> {
        if !(1..=MAX_WARMUPS).contains(&warmups) {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "warmups must be between 1 and {MAX_WARMUPS}"
            )));
        }
        if !(1..=MAX_ITERATIONS).contains(&iterations) {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "iterations must be between 1 and {MAX_ITERATIONS}"
            )));
        }
        Ok(Self {
            warmups,
            iterations,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LatencySummary {
    sample_count: usize,
    method: String,
    min_ms: f64,
    mean_ms: f64,
    p50_ms: f64,
    p90_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

impl LatencySummary {
    fn from_samples(samples: &[f64]) -> BenchResult<Self> {
        if samples.is_empty() {
            return Err(BenchmarkError::InvalidArtifact(
                "latency samples must not be empty".to_string(),
            ));
        }
        if samples
            .iter()
            .any(|sample| !sample.is_finite() || *sample < 0.0)
        {
            return Err(BenchmarkError::InvalidArtifact(
                "latency samples must be finite and non-negative".to_string(),
            ));
        }

        let mut sorted = samples.to_vec();
        sorted.sort_by(f64::total_cmp);
        let sum: f64 = samples.iter().sum();
        if !sum.is_finite() {
            return Err(BenchmarkError::InvalidArtifact(
                "latency sample sum is not finite".to_string(),
            ));
        }

        Ok(Self {
            sample_count: samples.len(),
            method: "nearest-rank".to_string(),
            min_ms: sorted[0],
            mean_ms: sum / samples.len() as f64,
            p50_ms: nearest_rank(&sorted, 0.50),
            p90_ms: nearest_rank(&sorted, 0.90),
            p95_ms: nearest_rank(&sorted, 0.95),
            p99_ms: nearest_rank(&sorted, 0.99),
            max_ms: sorted[sorted.len() - 1],
        })
    }
}

fn nearest_rank(sorted: &[f64], quantile: f64) -> f64 {
    let rank = (quantile * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ModelIdentity {
    kind: String,
    digest_algorithm: String,
    sha256: String,
    entry_count: usize,
    byte_count: u64,
}

#[derive(Debug, Clone)]
struct ValidatedModel {
    path: PathBuf,
    identity: ModelIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FixtureIdentity {
    format: String,
    width: u32,
    height: u32,
    encoded_byte_count: usize,
    rgba_byte_count: usize,
    encoded_sha256: String,
    rgba_sha256: String,
}

#[derive(Debug, Clone)]
struct FixtureData {
    path: PathBuf,
    identity: FixtureIdentity,
    rgba: Vec<u8>,
}

#[derive(Debug, Clone)]
enum TreeEntryKind {
    Directory,
    File { byte_count: u64 },
}

#[derive(Debug, Clone)]
struct TreeEntry {
    path: PathBuf,
    relative: String,
    kind: TreeEntryKind,
}

fn validate_model(path: &Path, backend: Backend) -> BenchResult<ValidatedModel> {
    reject_symlink(path, "model")?;
    let canonical = canonicalize_existing(path, "model")?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to inspect model {}: {error}",
            canonical.display()
        ))
    })?;
    let extension = canonical
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            BenchmarkError::InvalidConfiguration(
                "model path must have a supported UTF-8 extension".to_string(),
            )
        })?;

    let (expected_extension, expect_directory) = match backend {
        Backend::CoreML => ("mlmodelc", true),
        Backend::MLX => ("safetensors", false),
        Backend::CUDA | Backend::TensorRT | Backend::ONNX => ("onnx", false),
    };
    if !extension.eq_ignore_ascii_case(expected_extension) {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "{backend} requires a .{expected_extension} model"
        )));
    }
    if expect_directory != metadata.is_dir() || (!expect_directory && !metadata.is_file()) {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            ".{expected_extension} model must be a {}",
            if expect_directory {
                "directory"
            } else {
                "regular file"
            }
        )));
    }

    let identity = if expect_directory {
        hash_model_tree(&canonical)?
    } else {
        let (sha256, byte_count) = hash_regular_file(&canonical, MAX_MODEL_BYTES, "model")?;
        ModelIdentity {
            kind: "regular-file".to_string(),
            digest_algorithm: "sha256".to_string(),
            sha256,
            entry_count: 1,
            byte_count,
        }
    };

    Ok(ValidatedModel {
        path: canonical,
        identity,
    })
}

fn hash_model_tree(root: &Path) -> BenchResult<ModelIdentity> {
    let mut entries = Vec::new();
    let mut byte_count = 0_u64;
    collect_tree_entries(root, root, 0, &mut entries, &mut byte_count)?;
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));

    let mut hasher = Sha256::new();
    hasher.update(TREE_HASH_DOMAIN);
    for entry in &entries {
        match entry.kind {
            TreeEntryKind::Directory => {
                hasher.update(b"D");
                hash_framed_bytes(&mut hasher, entry.relative.as_bytes());
            }
            TreeEntryKind::File { byte_count } => {
                hasher.update(b"F");
                hash_framed_bytes(&mut hasher, entry.relative.as_bytes());
                hasher.update(byte_count.to_be_bytes());
                hash_file_contents(&entry.path, byte_count, MAX_MODEL_BYTES, &mut hasher)?;
            }
        }
    }

    Ok(ModelIdentity {
        kind: "directory-tree".to_string(),
        digest_algorithm: "sha256-tree-v1".to_string(),
        sha256: format!("{:x}", hasher.finalize()),
        entry_count: entries.len(),
        byte_count,
    })
}

fn collect_tree_entries(
    root: &Path,
    directory: &Path,
    depth: usize,
    entries: &mut Vec<TreeEntry>,
    aggregate_bytes: &mut u64,
) -> BenchResult<()> {
    if depth > MAX_MODEL_DEPTH {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "model tree exceeds {MAX_MODEL_DEPTH} nested directories"
        )));
    }
    let iterator = fs::read_dir(directory).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to read model directory {}: {error}",
            directory.display()
        ))
    })?;

    for item in iterator {
        let item = item.map_err(|error| {
            BenchmarkError::Io(format!(
                "failed to enumerate model directory {}: {error}",
                directory.display()
            ))
        })?;
        let path = item.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            BenchmarkError::Io(format!(
                "failed to inspect model entry {}: {error}",
                path.display()
            ))
        })?;
        if metadata.file_type().is_symlink() {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "model tree must not contain symlink {}",
                path.display()
            )));
        }
        let relative = normalized_relative_path(root, &path)?;
        let kind = if metadata.is_dir() {
            TreeEntryKind::Directory
        } else if metadata.is_file() {
            let file_bytes = metadata.len();
            *aggregate_bytes = aggregate_bytes.checked_add(file_bytes).ok_or_else(|| {
                BenchmarkError::InvalidConfiguration(
                    "model tree aggregate byte count overflowed".to_string(),
                )
            })?;
            if *aggregate_bytes > MAX_MODEL_BYTES {
                return Err(BenchmarkError::InvalidConfiguration(format!(
                    "model tree exceeds {MAX_MODEL_BYTES} bytes"
                )));
            }
            TreeEntryKind::File {
                byte_count: file_bytes,
            }
        } else {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "model tree contains non-file, non-directory entry {}",
                path.display()
            )));
        };

        entries.push(TreeEntry {
            path: path.clone(),
            relative,
            kind: kind.clone(),
        });
        if entries.len() > MAX_MODEL_ENTRIES {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "model tree exceeds {MAX_MODEL_ENTRIES} entries"
            )));
        }
        if matches!(kind, TreeEntryKind::Directory) {
            collect_tree_entries(root, &path, depth + 1, entries, aggregate_bytes)?;
        }
    }
    Ok(())
}

fn normalized_relative_path(root: &Path, path: &Path) -> BenchResult<String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        BenchmarkError::InvalidConfiguration(format!(
            "model entry {} escaped root {}",
            path.display(),
            root.display()
        ))
    })?;
    let mut components = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => components.push(value.to_str().ok_or_else(|| {
                BenchmarkError::InvalidConfiguration(format!(
                    "model entry path must be UTF-8: {}",
                    path.display()
                ))
            })?),
            _ => {
                return Err(BenchmarkError::InvalidConfiguration(format!(
                    "model entry path is not canonical: {}",
                    path.display()
                )))
            }
        }
    }
    Ok(components.join("/"))
}

fn hash_framed_bytes(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

fn hash_regular_file(path: &Path, max_bytes: u64, label: &str) -> BenchResult<(String, u64)> {
    reject_symlink(path, label)?;
    let metadata = fs::metadata(path).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to inspect {label} {}: {error}",
            path.display()
        ))
    })?;
    if !metadata.is_file() {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "{label} must be a regular file"
        )));
    }
    if metadata.len() > max_bytes {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "{label} exceeds {max_bytes} bytes"
        )));
    }
    let mut hasher = Sha256::new();
    let byte_count = hash_file_contents(path, metadata.len(), max_bytes, &mut hasher)?;
    Ok((format!("{:x}", hasher.finalize()), byte_count))
}

fn hash_file_contents(
    path: &Path,
    expected_bytes: u64,
    max_bytes: u64,
    hasher: &mut Sha256,
) -> BenchResult<u64> {
    let mut file = File::open(path).map_err(|error| {
        BenchmarkError::Io(format!("failed to open {}: {error}", path.display()))
    })?;
    let mut buffer = [0_u8; 64 * 1024];
    let mut observed = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            BenchmarkError::Io(format!("failed to hash {}: {error}", path.display()))
        })?;
        if read == 0 {
            break;
        }
        observed = observed.checked_add(read as u64).ok_or_else(|| {
            BenchmarkError::InvalidConfiguration("hashed byte count overflowed".to_string())
        })?;
        if observed > max_bytes {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "file changed while hashing or exceeds {max_bytes} bytes"
            )));
        }
        hasher.update(&buffer[..read]);
    }
    if observed != expected_bytes {
        return Err(BenchmarkError::InvalidArtifact(format!(
            "{} changed size while it was being hashed",
            path.display()
        )));
    }
    Ok(observed)
}

fn read_file_bounded(
    path: &Path,
    expected_bytes: u64,
    max_bytes: u64,
    label: &str,
) -> BenchResult<Vec<u8>> {
    let capacity = usize::try_from(expected_bytes).map_err(|_| {
        BenchmarkError::InvalidConfiguration(format!(
            "{label} size does not fit in process address space"
        ))
    })?;
    let read_limit = max_bytes.checked_add(1).ok_or_else(|| {
        BenchmarkError::InvalidConfiguration(format!("{label} size limit overflowed"))
    })?;
    let mut bytes = Vec::with_capacity(capacity);
    File::open(path)
        .map_err(|error| {
            BenchmarkError::Io(format!(
                "failed to open {label} {}: {error}",
                path.display()
            ))
        })?
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            BenchmarkError::Io(format!(
                "failed to read {label} {}: {error}",
                path.display()
            ))
        })?;
    if bytes.len() as u64 > max_bytes {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "{label} exceeds {max_bytes} bytes"
        )));
    }
    if bytes.len() as u64 != expected_bytes {
        return Err(BenchmarkError::InvalidArtifact(format!(
            "{label} changed size while it was being read"
        )));
    }
    Ok(bytes)
}

fn load_fixture(path: &Path) -> BenchResult<FixtureData> {
    reject_symlink(path, "fixture")?;
    let canonical = canonicalize_existing(path, "fixture")?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to inspect fixture {}: {error}",
            canonical.display()
        ))
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_SIZE_BYTES as u64 {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "fixture must be a non-empty regular file no larger than {MAX_IMAGE_SIZE_BYTES} bytes"
        )));
    }
    let encoded = read_file_bounded(
        &canonical,
        metadata.len(),
        MAX_IMAGE_SIZE_BYTES as u64,
        "fixture",
    )?;
    let (format, inspected_width, inspected_height) =
        inspect_encoded_image(&encoded).map_err(BenchmarkError::InvalidConfiguration)?;
    let decoded = decode_image_with_limits(&encoded)
        .map_err(BenchmarkError::InvalidConfiguration)?
        .to_rgba8();
    let (width, height) = decoded.dimensions();
    if (width, height) != (inspected_width, inspected_height) {
        return Err(BenchmarkError::InvalidArtifact(
            "fixture dimensions changed between inspection and decode".to_string(),
        ));
    }
    let rgba = decoded.into_raw();
    let identity = FixtureIdentity {
        format: format_name(format).to_string(),
        width,
        height,
        encoded_byte_count: encoded.len(),
        rgba_byte_count: rgba.len(),
        encoded_sha256: sha256_bytes(&encoded),
        rgba_sha256: sha256_bytes(&rgba),
    };
    Ok(FixtureData {
        path: canonical,
        identity,
        rgba,
    })
}

fn format_name(format: image::ImageFormat) -> &'static str {
    match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::Jpeg => "jpeg",
        _ => "unsupported",
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn reject_symlink(path: &Path, label: &str) -> BenchResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to inspect {label} {}: {error}",
            path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "{label} path must not be a symlink"
        )));
    }
    Ok(())
}

fn canonicalize_existing(path: &Path, label: &str) -> BenchResult<PathBuf> {
    path.canonicalize().map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to canonicalize {label} {}: {error}",
            path.display()
        ))
    })
}

fn utf8_path(path: &Path, label: &str) -> BenchResult<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        BenchmarkError::InvalidConfiguration(format!("{label} path must be valid UTF-8"))
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleRecord {
    call_latency_ms: f64,
    runtime_reported_latency_ms: f64,
    detection_count: usize,
    detections_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeasurementRecord {
    requested_backend: Backend,
    selected_backend: Backend,
    provider_label: String,
    initialization_ms: f64,
    evidence_loop_wall_ms: f64,
    sequential_detector_throughput_fps: f64,
    latency: LatencySummary,
    samples: Vec<SampleRecord>,
    first_output: Vec<Detection>,
}

fn run_benchmark(
    runtime: &DetectorRuntime,
    requested_backend: Backend,
    fixture: &FixtureData,
    policy: PolicyRecord,
    run: RunConfig,
) -> BenchResult<MeasurementRecord> {
    let runtime_policy = policy.runtime_policy()?;
    let initialization_started = Instant::now();
    let initialized_backend = runtime.initialize()?;
    let initialization_ms = initialization_started.elapsed().as_secs_f64() * 1_000.0;
    if initialized_backend != requested_backend {
        return Err(BenchmarkError::Inference(format!(
            "requested {requested_backend}, initialized {initialized_backend}"
        )));
    }

    let mut provider_label: Option<String> = None;
    for warmup_index in 0..run.warmups {
        let output = runtime
            .detect(
                &fixture.rgba,
                fixture.identity.width,
                fixture.identity.height,
                runtime_policy,
            )
            .map_err(|error| {
                BenchmarkError::Inference(format!(
                    "warmup {} of {} failed: {error}",
                    warmup_index + 1,
                    run.warmups
                ))
            })?;
        observe_output_identity(&output, requested_backend, &mut provider_label)?;
    }

    let measured_started = Instant::now();
    let mut samples = Vec::with_capacity(run.iterations);
    let mut first_output = None;
    for iteration in 0..run.iterations {
        let call_started = Instant::now();
        let output = runtime
            .detect(
                &fixture.rgba,
                fixture.identity.width,
                fixture.identity.height,
                runtime_policy,
            )
            .map_err(|error| {
                BenchmarkError::Inference(format!(
                    "measured iteration {} of {} failed: {error}",
                    iteration + 1,
                    run.iterations
                ))
            })?;
        let call_latency_ms = call_started.elapsed().as_secs_f64() * 1_000.0;
        observe_output_identity(&output, requested_backend, &mut provider_label)?;
        if !call_latency_ms.is_finite()
            || call_latency_ms < 0.0
            || !output.inference_time_ms.is_finite()
            || output.inference_time_ms < 0.0
        {
            return Err(BenchmarkError::InvalidArtifact(
                "detector returned a non-finite or negative timing sample".to_string(),
            ));
        }

        let serialized_detections = serde_json::to_vec(&output.detections).map_err(|error| {
            BenchmarkError::Serialization(format!(
                "failed to serialize detections from iteration {}: {error}",
                iteration + 1
            ))
        })?;
        if first_output.is_none() {
            first_output = Some(output.detections.clone());
        }
        samples.push(SampleRecord {
            call_latency_ms,
            runtime_reported_latency_ms: output.inference_time_ms,
            detection_count: output.detections.len(),
            detections_sha256: sha256_bytes(&serialized_detections),
        });
    }
    let evidence_loop_wall_ms = measured_started.elapsed().as_secs_f64() * 1_000.0;
    if !evidence_loop_wall_ms.is_finite() || evidence_loop_wall_ms <= 0.0 {
        return Err(BenchmarkError::InvalidArtifact(
            "evidence-loop wall time must be finite and positive".to_string(),
        ));
    }
    let call_latencies: Vec<f64> = samples
        .iter()
        .map(|sample| sample.call_latency_ms)
        .collect();
    let latency = LatencySummary::from_samples(&call_latencies)?;
    let detector_call_ms: f64 = call_latencies.iter().sum();
    let sequential_detector_throughput_fps = run.iterations as f64 * 1_000.0 / detector_call_ms;
    if !sequential_detector_throughput_fps.is_finite() || sequential_detector_throughput_fps <= 0.0
    {
        return Err(BenchmarkError::InvalidArtifact(
            "sequential detector throughput must be finite and positive".to_string(),
        ));
    }

    Ok(MeasurementRecord {
        requested_backend,
        selected_backend: initialized_backend,
        provider_label: provider_label.ok_or_else(|| {
            BenchmarkError::InvalidArtifact(
                "benchmark completed without a provider identity".to_string(),
            )
        })?,
        initialization_ms,
        evidence_loop_wall_ms,
        sequential_detector_throughput_fps,
        latency,
        samples,
        first_output: first_output.ok_or_else(|| {
            BenchmarkError::InvalidArtifact(
                "benchmark completed without a measured output".to_string(),
            )
        })?,
    })
}

fn observe_output_identity(
    output: &crebain_lib::inference::InferenceOutput,
    requested_backend: Backend,
    provider_label: &mut Option<String>,
) -> BenchResult<()> {
    if output.backend != requested_backend {
        return Err(BenchmarkError::Inference(format!(
            "requested {requested_backend}, detector returned {}",
            output.backend
        )));
    }
    validate_label(&output.backend_name, "provider label", MAX_PROVIDER_CHARS)?;
    match provider_label {
        Some(observed) if observed != &output.backend_name => {
            Err(BenchmarkError::IdentityMismatch(format!(
                "provider changed from {observed} to {} during one run",
                output.backend_name
            )))
        }
        Some(_) => Ok(()),
        slot @ None => {
            *slot = Some(output.backend_name.clone());
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlatformRecord {
    os: String,
    architecture: String,
    debug_assertions: bool,
    available_parallelism: usize,
    enabled_package_features: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum OrtRuntimeMode {
    NotUsedByRequestedBackend,
    CrateLinked,
    LinuxDynamicConfiguredFile,
    LinuxDynamicUnattestedSearch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct OrtRuntimeRecord {
    mode: OrtRuntimeMode,
    configured_library_sha256: Option<String>,
    configured_library_byte_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeEnvironmentRecord {
    mlx_profiling_policy: String,
    tensorrt_engine_cache_policy: String,
    ort_runtime: OrtRuntimeRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkArtifact {
    schema_version: String,
    declared_source_commit: String,
    crate_version: String,
    generated_at_unix_ms: u64,
    measurement_scope: String,
    redacted_invocation: Vec<String>,
    hardware_label: String,
    provider_label_scope: String,
    sensitivity_notice: String,
    platform: PlatformRecord,
    runtime_environment: RuntimeEnvironmentRecord,
    model: ModelIdentity,
    fixture: FixtureIdentity,
    policy: PolicyRecord,
    run: RunConfig,
    measurement: MeasurementRecord,
    baseline_comparison: Option<BaselineComparison>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaselineComparison {
    baseline_artifact_sha256: String,
    baseline_source_commit: String,
    baseline_p95_ms: f64,
    current_p95_ms: f64,
    p95_change_percent: f64,
    max_regression_percent: f64,
    passed: bool,
}

impl BenchmarkArtifact {
    fn new(
        cli: &Cli,
        runtime_environment: RuntimeEnvironmentRecord,
        model: ModelIdentity,
        fixture: FixtureIdentity,
        measurement: MeasurementRecord,
    ) -> BenchResult<Self> {
        validate_source_commit(&cli.source_commit)?;
        validate_label(&cli.hardware, "hardware label", MAX_LABEL_CHARS)?;
        validate_measurement(&measurement, cli.run, cli.policy)?;
        let generated_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| {
                BenchmarkError::InvalidArtifact(format!(
                    "system clock is before the Unix epoch: {error}"
                ))
            })?
            .as_millis()
            .try_into()
            .map_err(|_| {
                BenchmarkError::InvalidArtifact(
                    "Unix timestamp does not fit in u64 milliseconds".to_string(),
                )
            })?;
        Ok(Self {
            schema_version: SCHEMA_VERSION.to_string(),
            declared_source_commit: cli.source_commit.to_ascii_lowercase(),
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
            generated_at_unix_ms,
            measurement_scope: MEASUREMENT_SCOPE.to_string(),
            redacted_invocation: redacted_invocation(cli),
            hardware_label: cli.hardware.trim().to_string(),
            provider_label_scope: PROVIDER_LABEL_SCOPE.to_string(),
            sensitivity_notice: REPORT_SENSITIVITY_NOTICE.to_string(),
            platform: current_platform(),
            runtime_environment,
            model,
            fixture,
            policy: cli.policy,
            run: cli.run,
            measurement,
            baseline_comparison: None,
        })
    }
}

fn current_platform() -> PlatformRecord {
    let mut enabled_package_features = Vec::new();
    for (name, enabled) in [
        ("cuda", cfg!(feature = "cuda")),
        ("tensorrt", cfg!(feature = "tensorrt")),
        ("zenoh-transport", cfg!(feature = "zenoh-transport")),
        ("ncp", cfg!(feature = "ncp")),
        ("pyo3-bindings", cfg!(feature = "pyo3-bindings")),
        ("ts-export", cfg!(feature = "ts-export")),
    ] {
        if enabled {
            enabled_package_features.push(name.to_string());
        }
    }
    PlatformRecord {
        os: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        debug_assertions: cfg!(debug_assertions),
        available_parallelism: std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(0),
        enabled_package_features,
    }
}

fn current_runtime_environment(backend: Backend) -> BenchResult<RuntimeEnvironmentRecord> {
    let uses_ort = matches!(backend, Backend::CUDA | Backend::TensorRT | Backend::ONNX);
    let ort_runtime = if !uses_ort {
        OrtRuntimeRecord {
            mode: OrtRuntimeMode::NotUsedByRequestedBackend,
            configured_library_sha256: None,
            configured_library_byte_count: None,
        }
    } else {
        #[cfg(target_os = "linux")]
        {
            match std::env::var_os("ORT_DYLIB_PATH") {
                Some(path) => {
                    let path = path.into_string().map_err(|_| {
                        BenchmarkError::InvalidConfiguration(
                            "ORT_DYLIB_PATH must be valid UTF-8 for benchmark identity".to_string(),
                        )
                    })?;
                    let canonical = canonicalize_existing(Path::new(&path), "ORT_DYLIB_PATH")?;
                    let (sha256, byte_count) = hash_regular_file(
                        &canonical,
                        MAX_RUNTIME_LIBRARY_BYTES,
                        "ONNX Runtime library",
                    )?;
                    OrtRuntimeRecord {
                        mode: OrtRuntimeMode::LinuxDynamicConfiguredFile,
                        configured_library_sha256: Some(sha256),
                        configured_library_byte_count: Some(byte_count),
                    }
                }
                None => OrtRuntimeRecord {
                    mode: OrtRuntimeMode::LinuxDynamicUnattestedSearch,
                    configured_library_sha256: None,
                    configured_library_byte_count: None,
                },
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            OrtRuntimeRecord {
                mode: OrtRuntimeMode::CrateLinked,
                configured_library_sha256: None,
                configured_library_byte_count: None,
            }
        }
    };
    Ok(RuntimeEnvironmentRecord {
        mlx_profiling_policy: FORCED_MLX_PROFILING_POLICY.to_string(),
        tensorrt_engine_cache_policy: FORCED_TENSORRT_CACHE_POLICY.to_string(),
        ort_runtime,
    })
}

fn redacted_invocation(cli: &Cli) -> Vec<String> {
    let mut invocation = vec![
        "native_detector_benchmark".to_string(),
        "--backend".to_string(),
        backend_cli_name(cli.backend).to_string(),
        "--model".to_string(),
        "<MODEL_PATH>".to_string(),
        "--fixture".to_string(),
        "<FIXTURE_PATH>".to_string(),
        "--output".to_string(),
        "<NEW_REPORT_PATH>".to_string(),
        "--hardware".to_string(),
        "<HARDWARE_LABEL>".to_string(),
        "--source-commit".to_string(),
        cli.source_commit.to_ascii_lowercase(),
        "--warmups".to_string(),
        cli.run.warmups.to_string(),
        "--iterations".to_string(),
        cli.run.iterations.to_string(),
        "--confidence".to_string(),
        cli.policy.confidence_threshold.to_string(),
        "--iou".to_string(),
        cli.policy.iou_threshold.to_string(),
        "--max-detections".to_string(),
        cli.policy.max_detections.to_string(),
    ];
    if let Some(max_regression_percent) = cli.max_regression_percent {
        invocation.extend([
            "--baseline".to_string(),
            "<BASELINE_REPORT_PATH>".to_string(),
            "--baseline-sha256".to_string(),
            cli.baseline_sha256
                .clone()
                .unwrap_or_else(|| "<MISSING_BASELINE_SHA256>".to_string()),
            "--max-regression-percent".to_string(),
            max_regression_percent.to_string(),
        ]);
    }
    invocation
}

fn backend_cli_name(backend: Backend) -> &'static str {
    match backend {
        Backend::CoreML => "coreml",
        Backend::MLX => "mlx",
        Backend::CUDA => "cuda",
        Backend::TensorRT => "tensorrt",
        Backend::ONNX => "onnx",
    }
}

fn validate_measurement(
    measurement: &MeasurementRecord,
    run: RunConfig,
    policy: PolicyRecord,
) -> BenchResult<()> {
    validate_label(
        &measurement.provider_label,
        "provider label",
        MAX_PROVIDER_CHARS,
    )?;
    if measurement.requested_backend != measurement.selected_backend {
        return Err(BenchmarkError::InvalidArtifact(
            "requested and selected backends differ".to_string(),
        ));
    }
    if measurement.samples.len() != run.iterations {
        return Err(BenchmarkError::InvalidArtifact(format!(
            "expected {} samples, found {}",
            run.iterations,
            measurement.samples.len()
        )));
    }
    let call_latencies: Vec<f64> = measurement
        .samples
        .iter()
        .map(|sample| sample.call_latency_ms)
        .collect();
    let recomputed = LatencySummary::from_samples(&call_latencies)?;
    if recomputed != measurement.latency {
        return Err(BenchmarkError::InvalidArtifact(
            "latency summary does not match raw samples".to_string(),
        ));
    }
    let detector_call_ms: f64 = call_latencies.iter().sum();
    let recomputed_throughput = run.iterations as f64 * 1_000.0 / detector_call_ms;
    if !recomputed_throughput.is_finite()
        || recomputed_throughput <= 0.0
        || recomputed_throughput != measurement.sequential_detector_throughput_fps
    {
        return Err(BenchmarkError::InvalidArtifact(
            "sequential detector throughput does not match raw samples".to_string(),
        ));
    }
    for sample in &measurement.samples {
        if !sample.runtime_reported_latency_ms.is_finite()
            || sample.runtime_reported_latency_ms < 0.0
        {
            return Err(BenchmarkError::InvalidArtifact(
                "runtime-reported latency sample is not finite and non-negative".to_string(),
            ));
        }
        if sample.detection_count > policy.max_detections {
            return Err(BenchmarkError::InvalidArtifact(format!(
                "sample detection count exceeds policy maximum {}",
                policy.max_detections
            )));
        }
        validate_sha256(&sample.detections_sha256, "detection digest")?;
    }
    let serialized_first_output =
        serde_json::to_vec(&measurement.first_output).map_err(|error| {
            BenchmarkError::Serialization(format!(
                "failed to serialize first output while validating artifact: {error}"
            ))
        })?;
    let first_sample = measurement.samples.first().ok_or_else(|| {
        BenchmarkError::InvalidArtifact("measurement has no first sample".to_string())
    })?;
    if first_sample.detection_count != measurement.first_output.len()
        || first_sample.detections_sha256 != sha256_bytes(&serialized_first_output)
    {
        return Err(BenchmarkError::InvalidArtifact(
            "first output does not match the first raw sample".to_string(),
        ));
    }
    if !measurement.initialization_ms.is_finite()
        || measurement.initialization_ms < 0.0
        || !measurement.evidence_loop_wall_ms.is_finite()
        || measurement.evidence_loop_wall_ms <= 0.0
    {
        return Err(BenchmarkError::InvalidArtifact(
            "measurement contains invalid aggregate timing".to_string(),
        ));
    }
    Ok(())
}

fn compare_to_baseline(
    current: &BenchmarkArtifact,
    baseline: &BenchmarkArtifact,
    baseline_artifact_sha256: String,
    max_regression_percent: f64,
) -> BenchResult<BaselineComparison> {
    if !max_regression_percent.is_finite()
        || !(0.0..=MAX_REGRESSION_PERCENT).contains(&max_regression_percent)
    {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "max regression percent must be between 0 and {MAX_REGRESSION_PERCENT}"
        )));
    }
    validate_artifact(baseline)?;
    validate_comparable_identity(current, baseline)?;
    let baseline_p95_ms = baseline.measurement.latency.p95_ms;
    let current_p95_ms = current.measurement.latency.p95_ms;
    if baseline_p95_ms <= 0.0 {
        return Err(BenchmarkError::InvalidArtifact(
            "baseline p95 must be positive".to_string(),
        ));
    }
    let p95_change_percent = (current_p95_ms / baseline_p95_ms - 1.0) * 100.0;
    if !p95_change_percent.is_finite() {
        return Err(BenchmarkError::InvalidArtifact(
            "p95 comparison is not finite".to_string(),
        ));
    }
    Ok(BaselineComparison {
        baseline_artifact_sha256,
        baseline_source_commit: baseline.declared_source_commit.clone(),
        baseline_p95_ms,
        current_p95_ms,
        p95_change_percent,
        max_regression_percent,
        passed: p95_change_percent <= max_regression_percent,
    })
}

fn validate_comparable_identity(
    current: &BenchmarkArtifact,
    baseline: &BenchmarkArtifact,
) -> BenchResult<()> {
    if matches!(
        current.runtime_environment.ort_runtime.mode,
        OrtRuntimeMode::LinuxDynamicUnattestedSearch
    ) || matches!(
        baseline.runtime_environment.ort_runtime.mode,
        OrtRuntimeMode::LinuxDynamicUnattestedSearch
    ) {
        return Err(BenchmarkError::IdentityMismatch(
            "Linux ONNX Runtime library identity is unattested; set ORT_DYLIB_PATH to a regular file before using a baseline"
                .to_string(),
        ));
    }
    macro_rules! require_equal {
        ($field:expr, $left:expr, $right:expr) => {
            if $left != $right {
                return Err(BenchmarkError::IdentityMismatch(format!(
                    "{} differs",
                    $field
                )));
            }
        };
    }
    require_equal!(
        "schema version",
        current.schema_version,
        baseline.schema_version
    );
    require_equal!(
        "hardware label",
        current.hardware_label,
        baseline.hardware_label
    );
    require_equal!("platform", current.platform, baseline.platform);
    require_equal!(
        "runtime environment",
        current.runtime_environment,
        baseline.runtime_environment
    );
    require_equal!("model kind", current.model.kind, baseline.model.kind);
    require_equal!(
        "model digest algorithm",
        current.model.digest_algorithm,
        baseline.model.digest_algorithm
    );
    require_equal!("model digest", current.model.sha256, baseline.model.sha256);
    require_equal!(
        "model entry count",
        current.model.entry_count,
        baseline.model.entry_count
    );
    require_equal!(
        "model byte count",
        current.model.byte_count,
        baseline.model.byte_count
    );
    require_equal!(
        "fixture format",
        current.fixture.format,
        baseline.fixture.format
    );
    require_equal!(
        "fixture width",
        current.fixture.width,
        baseline.fixture.width
    );
    require_equal!(
        "fixture height",
        current.fixture.height,
        baseline.fixture.height
    );
    require_equal!(
        "fixture encoded digest",
        current.fixture.encoded_sha256,
        baseline.fixture.encoded_sha256
    );
    require_equal!(
        "fixture RGBA digest",
        current.fixture.rgba_sha256,
        baseline.fixture.rgba_sha256
    );
    require_equal!("policy", current.policy, baseline.policy);
    require_equal!("run configuration", current.run, baseline.run);
    require_equal!(
        "requested backend",
        current.measurement.requested_backend,
        baseline.measurement.requested_backend
    );
    require_equal!(
        "selected backend",
        current.measurement.selected_backend,
        baseline.measurement.selected_backend
    );
    require_equal!(
        "provider label",
        current.measurement.provider_label,
        baseline.measurement.provider_label
    );
    Ok(())
}

fn validate_artifact(artifact: &BenchmarkArtifact) -> BenchResult<()> {
    if artifact.schema_version != SCHEMA_VERSION {
        return Err(BenchmarkError::InvalidArtifact(format!(
            "unsupported schema version {}",
            artifact.schema_version
        )));
    }
    validate_source_commit(&artifact.declared_source_commit)?;
    validate_label(&artifact.hardware_label, "hardware label", MAX_LABEL_CHARS)?;
    validate_label(&artifact.crate_version, "crate version", 64)?;
    validate_label(&artifact.platform.os, "platform OS", 64)?;
    validate_label(&artifact.platform.architecture, "platform architecture", 64)?;
    if artifact.measurement_scope != MEASUREMENT_SCOPE {
        return Err(BenchmarkError::InvalidArtifact(
            "measurement scope does not match this schema implementation".to_string(),
        ));
    }
    if artifact.provider_label_scope != PROVIDER_LABEL_SCOPE {
        return Err(BenchmarkError::InvalidArtifact(
            "provider-label scope does not match this schema implementation".to_string(),
        ));
    }
    if artifact.sensitivity_notice != REPORT_SENSITIVITY_NOTICE {
        return Err(BenchmarkError::InvalidArtifact(
            "report sensitivity notice does not match this schema implementation".to_string(),
        ));
    }
    if artifact.platform.debug_assertions {
        return Err(BenchmarkError::InvalidArtifact(
            "benchmark artifact was produced with debug assertions enabled".to_string(),
        ));
    }
    if artifact.runtime_environment.mlx_profiling_policy != FORCED_MLX_PROFILING_POLICY
        || artifact.runtime_environment.tensorrt_engine_cache_policy != FORCED_TENSORRT_CACHE_POLICY
    {
        return Err(BenchmarkError::InvalidArtifact(
            "benchmark performance-control policy is not the required forced configuration"
                .to_string(),
        ));
    }
    match artifact.runtime_environment.ort_runtime.mode {
        OrtRuntimeMode::LinuxDynamicConfiguredFile => {
            let digest = artifact
                .runtime_environment
                .ort_runtime
                .configured_library_sha256
                .as_deref()
                .ok_or_else(|| {
                    BenchmarkError::InvalidArtifact(
                        "configured ONNX Runtime library has no digest".to_string(),
                    )
                })?;
            validate_sha256(digest, "ONNX Runtime library digest")?;
            if artifact
                .runtime_environment
                .ort_runtime
                .configured_library_byte_count
                .is_none_or(|byte_count| byte_count == 0)
            {
                return Err(BenchmarkError::InvalidArtifact(
                    "configured ONNX Runtime library has no positive byte count".to_string(),
                ));
            }
        }
        OrtRuntimeMode::NotUsedByRequestedBackend
        | OrtRuntimeMode::CrateLinked
        | OrtRuntimeMode::LinuxDynamicUnattestedSearch => {
            if artifact
                .runtime_environment
                .ort_runtime
                .configured_library_sha256
                .is_some()
                || artifact
                    .runtime_environment
                    .ort_runtime
                    .configured_library_byte_count
                    .is_some()
            {
                return Err(BenchmarkError::InvalidArtifact(
                    "ONNX Runtime identity fields conflict with the recorded loading mode"
                        .to_string(),
                ));
            }
        }
    }
    if artifact.redacted_invocation.first().map(String::as_str) != Some("native_detector_benchmark")
    {
        return Err(BenchmarkError::InvalidArtifact(
            "redacted invocation has an unexpected executable label".to_string(),
        ));
    }
    validate_sha256(&artifact.model.sha256, "model digest")?;
    match (
        artifact.model.kind.as_str(),
        artifact.model.digest_algorithm.as_str(),
        artifact.model.entry_count,
    ) {
        ("regular-file", "sha256", 1) => {}
        ("directory-tree", "sha256-tree-v1", 1..) => {}
        _ => {
            return Err(BenchmarkError::InvalidArtifact(
                "model kind, digest algorithm, and entry count are inconsistent".to_string(),
            ));
        }
    }
    if artifact.model.byte_count == 0 || artifact.model.byte_count > MAX_MODEL_BYTES {
        return Err(BenchmarkError::InvalidArtifact(format!(
            "model byte count must be between 1 and {MAX_MODEL_BYTES}"
        )));
    }
    validate_sha256(&artifact.fixture.encoded_sha256, "encoded fixture digest")?;
    validate_sha256(&artifact.fixture.rgba_sha256, "RGBA fixture digest")?;
    if !matches!(artifact.fixture.format.as_str(), "png" | "jpeg")
        || artifact.fixture.width == 0
        || artifact.fixture.height == 0
        || artifact.fixture.encoded_byte_count == 0
        || artifact.fixture.encoded_byte_count > MAX_IMAGE_SIZE_BYTES
    {
        return Err(BenchmarkError::InvalidArtifact(
            "fixture format, dimensions, or encoded byte count are invalid".to_string(),
        ));
    }
    let expected_rgba_bytes = (artifact.fixture.width as usize)
        .checked_mul(artifact.fixture.height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| {
            BenchmarkError::InvalidArtifact("fixture RGBA byte count overflowed".to_string())
        })?;
    if artifact.fixture.rgba_byte_count != expected_rgba_bytes {
        return Err(BenchmarkError::InvalidArtifact(
            "fixture RGBA byte count does not match its dimensions".to_string(),
        ));
    }
    PolicyRecord::new(
        artifact.policy.confidence_threshold,
        artifact.policy.iou_threshold,
        artifact.policy.max_detections,
    )?;
    RunConfig::new(artifact.run.warmups, artifact.run.iterations)?;
    validate_measurement(&artifact.measurement, artifact.run, artifact.policy)?;
    if let Some(comparison) = &artifact.baseline_comparison {
        validate_baseline_comparison(comparison, artifact.measurement.latency.p95_ms)?;
    }
    Ok(())
}

fn validate_baseline_comparison(
    comparison: &BaselineComparison,
    expected_current_p95_ms: f64,
) -> BenchResult<()> {
    validate_sha256(
        &comparison.baseline_artifact_sha256,
        "baseline artifact digest",
    )?;
    validate_source_commit(&comparison.baseline_source_commit)?;
    if !comparison.baseline_p95_ms.is_finite()
        || comparison.baseline_p95_ms <= 0.0
        || !comparison.current_p95_ms.is_finite()
        || comparison.current_p95_ms < 0.0
        || !comparison.p95_change_percent.is_finite()
        || !comparison.max_regression_percent.is_finite()
        || !(0.0..=MAX_REGRESSION_PERCENT).contains(&comparison.max_regression_percent)
    {
        return Err(BenchmarkError::InvalidArtifact(
            "baseline comparison contains invalid numeric values".to_string(),
        ));
    }
    let recomputed_change = (comparison.current_p95_ms / comparison.baseline_p95_ms - 1.0) * 100.0;
    if comparison.current_p95_ms != expected_current_p95_ms
        || recomputed_change != comparison.p95_change_percent
        || comparison.passed != (comparison.p95_change_percent <= comparison.max_regression_percent)
    {
        return Err(BenchmarkError::InvalidArtifact(
            "baseline comparison result does not match its recorded inputs".to_string(),
        ));
    }
    Ok(())
}

fn read_baseline(path: &Path, expected_sha256: &str) -> BenchResult<(BenchmarkArtifact, String)> {
    reject_symlink(path, "baseline")?;
    let canonical = canonicalize_existing(path, "baseline")?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to inspect baseline {}: {error}",
            canonical.display()
        ))
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BASELINE_BYTES {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "baseline must be a non-empty regular file no larger than {MAX_BASELINE_BYTES} bytes"
        )));
    }
    let bytes = read_file_bounded(&canonical, metadata.len(), MAX_BASELINE_BYTES, "baseline")?;
    let actual_sha256 = sha256_bytes(&bytes);
    if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(BenchmarkError::IdentityMismatch(format!(
            "baseline SHA-256 mismatch: expected {}, observed {}",
            expected_sha256.to_ascii_lowercase(),
            actual_sha256
        )));
    }
    let artifact: BenchmarkArtifact = serde_json::from_slice(&bytes).map_err(|error| {
        BenchmarkError::Serialization(format!("failed to parse baseline JSON: {error}"))
    })?;
    validate_artifact(&artifact)?;
    Ok((artifact, actual_sha256))
}

fn validate_source_commit(value: &str) -> BenchResult<()> {
    if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(BenchmarkError::InvalidConfiguration(
            "source commit must be exactly 40 hexadecimal characters".to_string(),
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> BenchResult<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(BenchmarkError::InvalidArtifact(format!(
            "{label} must be a 64-character hexadecimal SHA-256 value"
        )));
    }
    Ok(())
}

fn validate_label(value: &str, label: &str, max_chars: usize) -> BenchResult<()> {
    let trimmed = value.trim();
    let count = trimmed.chars().count();
    if count == 0 || count > max_chars || trimmed.chars().any(char::is_control) {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "{label} must contain 1 to {max_chars} non-control characters"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct Cli {
    backend: Backend,
    model: PathBuf,
    fixture: PathBuf,
    output: PathBuf,
    hardware: String,
    source_commit: String,
    policy: PolicyRecord,
    run: RunConfig,
    baseline: Option<PathBuf>,
    baseline_sha256: Option<String>,
    max_regression_percent: Option<f64>,
}

enum ParsedCli {
    Help,
    Run(Box<Cli>),
}

fn parse_cli(arguments: impl IntoIterator<Item = String>) -> BenchResult<ParsedCli> {
    let arguments: Vec<String> = arguments.into_iter().collect();
    if arguments.len() == 1 && matches!(arguments[0].as_str(), "--help" | "-h") {
        return Ok(ParsedCli::Help);
    }
    let allowed = [
        "--backend",
        "--model",
        "--fixture",
        "--output",
        "--hardware",
        "--source-commit",
        "--warmups",
        "--iterations",
        "--confidence",
        "--iou",
        "--max-detections",
        "--baseline",
        "--baseline-sha256",
        "--max-regression-percent",
    ];
    let mut values = BTreeMap::new();
    let mut iterator = arguments.into_iter();
    while let Some(flag) = iterator.next() {
        if !allowed.contains(&flag.as_str()) {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "unknown argument {flag}"
            )));
        }
        let value = iterator.next().ok_or_else(|| {
            BenchmarkError::InvalidConfiguration(format!("{flag} requires a value"))
        })?;
        if values.insert(flag.clone(), value).is_some() {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "duplicate argument {flag}"
            )));
        }
    }

    let backend = required(&values, "--backend")?.parse::<Backend>()?;
    let model = PathBuf::from(required(&values, "--model")?);
    let fixture = PathBuf::from(required(&values, "--fixture")?);
    let output = PathBuf::from(required(&values, "--output")?);
    let hardware = required(&values, "--hardware")?.to_string();
    let source_commit = required(&values, "--source-commit")?.to_string();
    validate_label(&hardware, "hardware label", MAX_LABEL_CHARS)?;
    validate_source_commit(&source_commit)?;

    let warmups = parse_value::<usize>(&values, "--warmups", 5)?;
    let iterations = parse_value::<usize>(&values, "--iterations", 100)?;
    let confidence = parse_value::<f32>(&values, "--confidence", 0.25)?;
    let iou = parse_value::<f32>(&values, "--iou", 0.45)?;
    let max_detections = parse_value::<usize>(&values, "--max-detections", 100)?;
    let run = RunConfig::new(warmups, iterations)?;
    let policy = PolicyRecord::new(confidence, iou, max_detections)?;

    let baseline = values.get("--baseline").map(PathBuf::from);
    let baseline_sha256 = values
        .get("--baseline-sha256")
        .map(|value| value.to_ascii_lowercase());
    let max_regression_percent = values
        .get("--max-regression-percent")
        .map(|value| {
            value.parse::<f64>().map_err(|error| {
                BenchmarkError::InvalidConfiguration(format!(
                    "--max-regression-percent has invalid value {value}: {error}"
                ))
            })
        })
        .transpose()?;
    let baseline_option_count = [
        baseline.is_some(),
        baseline_sha256.is_some(),
        max_regression_percent.is_some(),
    ]
    .into_iter()
    .filter(|present| *present)
    .count();
    if !matches!(baseline_option_count, 0 | 3) {
        return Err(BenchmarkError::InvalidConfiguration(
            "--baseline, --baseline-sha256, and --max-regression-percent must be supplied together"
                .to_string(),
        ));
    }
    if let Some(digest) = &baseline_sha256 {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(BenchmarkError::InvalidConfiguration(
                "baseline SHA-256 must be exactly 64 hexadecimal characters".to_string(),
            ));
        }
    }
    if let Some(percent) = max_regression_percent {
        if !percent.is_finite() || !(0.0..=MAX_REGRESSION_PERCENT).contains(&percent) {
            return Err(BenchmarkError::InvalidConfiguration(format!(
                "max regression percent must be between 0 and {MAX_REGRESSION_PERCENT}"
            )));
        }
    }

    Ok(ParsedCli::Run(Box::new(Cli {
        backend,
        model,
        fixture,
        output,
        hardware,
        source_commit,
        policy,
        run,
        baseline,
        baseline_sha256,
        max_regression_percent,
    })))
}

fn required<'a>(values: &'a BTreeMap<String, String>, flag: &str) -> BenchResult<&'a str> {
    values.get(flag).map(String::as_str).ok_or_else(|| {
        BenchmarkError::InvalidConfiguration(format!("missing required argument {flag}"))
    })
}

fn parse_value<T>(values: &BTreeMap<String, String>, flag: &str, default: T) -> BenchResult<T>
where
    T: std::str::FromStr,
    T::Err: fmt::Display,
{
    values.get(flag).map_or(Ok(default), |value| {
        value.parse::<T>().map_err(|error| {
            BenchmarkError::InvalidConfiguration(format!(
                "{flag} has invalid value {value}: {error}"
            ))
        })
    })
}

fn validate_output_path(
    output: &Path,
    model: &ValidatedModel,
    fixture: &FixtureData,
) -> BenchResult<PathBuf> {
    if output
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(BenchmarkError::InvalidConfiguration(
            "output path must not contain parent traversal".to_string(),
        ));
    }
    if output
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("json"))
    {
        return Err(BenchmarkError::InvalidConfiguration(
            "output path must end in .json".to_string(),
        ));
    }
    if fs::symlink_metadata(output).is_ok() {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "output already exists or is a symlink: {}",
            output.display()
        )));
    }
    let file_name = output.file_name().ok_or_else(|| {
        BenchmarkError::InvalidConfiguration("output path must name a file".to_string())
    })?;
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let canonical_parent = canonicalize_existing(parent, "output parent")?;
    let parent_metadata = fs::metadata(&canonical_parent).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to inspect output parent {}: {error}",
            canonical_parent.display()
        ))
    })?;
    if !parent_metadata.is_dir() {
        return Err(BenchmarkError::InvalidConfiguration(
            "output parent must be a directory".to_string(),
        ));
    }
    let canonical_output = canonical_parent.join(file_name);
    if canonical_output == model.path || canonical_output == fixture.path {
        return Err(BenchmarkError::InvalidConfiguration(
            "output must not replace the model or fixture".to_string(),
        ));
    }
    if model.path.is_dir() && canonical_output.starts_with(&model.path) {
        return Err(BenchmarkError::InvalidConfiguration(
            "output must not be written inside the model directory".to_string(),
        ));
    }
    if fs::symlink_metadata(&canonical_output).is_ok() {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "output already exists or is a symlink: {}",
            canonical_output.display()
        )));
    }
    Ok(canonical_output)
}

fn write_artifact_atomically(path: &Path, artifact: &BenchmarkArtifact) -> BenchResult<()> {
    let mut bytes = serde_json::to_vec_pretty(artifact).map_err(|error| {
        BenchmarkError::Serialization(format!("failed to serialize benchmark report: {error}"))
    })?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REPORT_BYTES {
        return Err(BenchmarkError::InvalidArtifact(format!(
            "benchmark report exceeds {MAX_REPORT_BYTES} bytes"
        )));
    }
    if fs::symlink_metadata(path).is_ok() {
        return Err(BenchmarkError::InvalidConfiguration(format!(
            "output already exists or is a symlink: {}",
            path.display()
        )));
    }
    let parent = path.parent().ok_or_else(|| {
        BenchmarkError::InvalidConfiguration("output path has no parent directory".to_string())
    })?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to create temporary report in {}: {error}",
            parent.display()
        ))
    })?;
    temporary.write_all(&bytes).map_err(|error| {
        BenchmarkError::Io(format!("failed to write temporary report: {error}"))
    })?;
    temporary.flush().map_err(|error| {
        BenchmarkError::Io(format!("failed to flush temporary report: {error}"))
    })?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| BenchmarkError::Io(format!("failed to sync temporary report: {error}")))?;
    temporary.persist_noclobber(path).map_err(|error| {
        BenchmarkError::Io(format!(
            "failed to atomically persist report {}: {}",
            path.display(),
            error.error
        ))
    })?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            BenchmarkError::Io(format!(
                "failed to sync output directory {}: {error}",
                parent.display()
            ))
        })?;
    Ok(())
}

fn configure_model_environment(model: &ValidatedModel, backend: Backend) -> BenchResult<()> {
    // Make steady-state comparisons independent of optional MLX logging and
    // CREBAIN's persistent TensorRT engine-cache state. Initialization remains
    // recorded separately; this does not attest OS, driver, JIT, module, or GPU
    // cache/state coldness.
    std::env::remove_var("CREBAIN_PROFILE_MLX");
    std::env::set_var("CREBAIN_DISABLE_TRT_CACHE", "1");
    let path = utf8_path(&model.path, "model")?;
    match backend {
        Backend::MLX => {
            std::env::set_var("CREBAIN_ENABLE_EXPERIMENTAL_MLX", "1");
            std::env::set_var("CREBAIN_MLX_MODEL", &path);
            std::env::set_var("CREBAIN_MLX_MODEL_SHA256", &model.identity.sha256);
        }
        Backend::CUDA | Backend::TensorRT | Backend::ONNX => {
            std::env::set_var("CREBAIN_ONNX_MODEL", &path);
        }
        Backend::CoreML => {}
    }
    Ok(())
}

fn create_exact_detector(
    backend: Backend,
    model_path: &Path,
) -> crebain_lib::inference::Result<Box<dyn Detector>> {
    #[cfg(target_os = "macos")]
    if backend == Backend::CoreML {
        return crebain_lib::inference::coreml::CoreMlDetector::new_with_model_path(model_path)
            .map(|detector| Box::new(detector) as Box<dyn Detector>);
    }
    let _ = model_path;
    create_detector_with_backend(backend)
}

fn execute(cli: Cli) -> BenchResult<()> {
    if cfg!(debug_assertions) {
        return Err(BenchmarkError::InvalidConfiguration(
            "benchmark must disable debug assertions; use the supported --release command"
                .to_string(),
        ));
    }
    let model = validate_model(&cli.model, cli.backend)?;
    let fixture = load_fixture(&cli.fixture)?;
    let output = validate_output_path(&cli.output, &model, &fixture)?;
    configure_model_environment(&model, cli.backend)?;
    let runtime_environment = current_runtime_environment(cli.backend)?;

    let backend = cli.backend;
    let model_path = model.path.clone();
    let runtime = DetectorRuntime::new(move || create_exact_detector(backend, &model_path));
    let measurement = run_benchmark(&runtime, cli.backend, &fixture, cli.policy, cli.run)?;

    let post_run_model = validate_model(&model.path, cli.backend)?;
    if post_run_model.identity != model.identity {
        return Err(BenchmarkError::InvalidArtifact(
            "model changed during the benchmark; report was not published".to_string(),
        ));
    }
    let post_run_fixture = load_fixture(&fixture.path)?;
    if post_run_fixture.identity != fixture.identity {
        return Err(BenchmarkError::InvalidArtifact(
            "fixture changed during the benchmark; report was not published".to_string(),
        ));
    }
    let post_run_runtime_environment = current_runtime_environment(cli.backend)?;
    if post_run_runtime_environment != runtime_environment {
        return Err(BenchmarkError::InvalidArtifact(
            "runtime-library identity or forced performance controls changed during the benchmark; report was not published"
                .to_string(),
        ));
    }

    let mut artifact = BenchmarkArtifact::new(
        &cli,
        runtime_environment,
        model.identity,
        fixture.identity,
        measurement,
    )?;
    if let (Some(baseline_path), Some(baseline_sha256), Some(max_regression_percent)) = (
        &cli.baseline,
        &cli.baseline_sha256,
        cli.max_regression_percent,
    ) {
        let (baseline, baseline_sha256) = read_baseline(baseline_path, baseline_sha256)?;
        artifact.baseline_comparison = Some(compare_to_baseline(
            &artifact,
            &baseline,
            baseline_sha256,
            max_regression_percent,
        )?);
    }

    validate_artifact(&artifact)?;
    write_artifact_atomically(&output, &artifact)?;
    if let Some(comparison) = &artifact.baseline_comparison {
        if !comparison.passed {
            return Err(BenchmarkError::Regression(format!(
                "p95 increased by {:.3}% (allowed {:.3}%); failing report preserved at {}",
                comparison.p95_change_percent,
                comparison.max_regression_percent,
                output.display()
            )));
        }
    }
    Ok(())
}

fn utf8_process_arguments() -> BenchResult<Vec<String>> {
    std::env::args_os()
        .enumerate()
        .map(|(index, argument)| {
            argument.into_string().map_err(|_| {
                BenchmarkError::InvalidConfiguration(format!(
                    "process argument {} must be valid UTF-8",
                    index + 1
                ))
            })
        })
        .collect()
}

fn main() -> Result<(), Box<dyn Error>> {
    let argv = utf8_process_arguments()?;
    match parse_cli(argv.iter().skip(1).cloned())? {
        ParsedCli::Help => {
            std::io::stdout().write_all(USAGE.as_bytes())?;
            Ok(())
        }
        ParsedCli::Run(cli) => execute(*cli).map_err(Into::into),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use crebain_lib::inference::{InferenceStats, Result as InferenceResult};
    use image::{DynamicImage, ImageFormat};

    use super::*;

    struct ScriptedDetector {
        calls: AtomicUsize,
        fail_on_call: Option<usize>,
    }

    impl Detector for ScriptedDetector {
        fn backend(&self) -> Backend {
            Backend::ONNX
        }

        fn detect(
            &self,
            _data: &[u8],
            _width: u32,
            _height: u32,
        ) -> InferenceResult<Vec<Detection>> {
            let call = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
            if self.fail_on_call == Some(call) {
                return Err(InferenceError::InferenceError(format!(
                    "scripted failure on call {call}"
                )));
            }
            Ok(vec![Detection {
                bbox: [0.0, 0.0, 1.0, 1.0],
                confidence: 0.9,
                class_id: 0,
                class_label: "person".to_string(),
            }])
        }

        fn stats(&self) -> InferenceStats {
            InferenceStats {
                backend: "ONNX Runtime (test CPU)".to_string(),
                ..InferenceStats::default()
            }
        }
    }

    fn fixture_data() -> FixtureData {
        let rgba = vec![0_u8; 16];
        FixtureData {
            path: PathBuf::from("/fixture.png"),
            identity: FixtureIdentity {
                format: "png".to_string(),
                width: 2,
                height: 2,
                encoded_byte_count: 1,
                rgba_byte_count: rgba.len(),
                encoded_sha256: "a".repeat(64),
                rgba_sha256: sha256_bytes(&rgba),
            },
            rgba,
        }
    }

    fn runtime(fail_on_call: Option<usize>) -> DetectorRuntime {
        DetectorRuntime::new(move || {
            Ok(Box::new(ScriptedDetector {
                calls: AtomicUsize::new(0),
                fail_on_call,
            }))
        })
    }

    fn sample_artifact(provider: &str) -> BenchmarkArtifact {
        let first_output = Vec::<Detection>::new();
        let samples = vec![SampleRecord {
            call_latency_ms: 1.0,
            runtime_reported_latency_ms: 0.9,
            detection_count: 0,
            detections_sha256: sha256_bytes(&serde_json::to_vec(&first_output).unwrap()),
        }];
        BenchmarkArtifact {
            schema_version: SCHEMA_VERSION.to_string(),
            declared_source_commit: "c".repeat(40),
            crate_version: env!("CARGO_PKG_VERSION").to_string(),
            generated_at_unix_ms: 1,
            measurement_scope: MEASUREMENT_SCOPE.to_string(),
            redacted_invocation: vec!["native_detector_benchmark".to_string()],
            hardware_label: "test-hardware".to_string(),
            provider_label_scope: PROVIDER_LABEL_SCOPE.to_string(),
            sensitivity_notice: REPORT_SENSITIVITY_NOTICE.to_string(),
            platform: PlatformRecord {
                os: "test-os".to_string(),
                architecture: "test-arch".to_string(),
                debug_assertions: false,
                available_parallelism: 1,
                enabled_package_features: Vec::new(),
            },
            runtime_environment: RuntimeEnvironmentRecord {
                mlx_profiling_policy: FORCED_MLX_PROFILING_POLICY.to_string(),
                tensorrt_engine_cache_policy: FORCED_TENSORRT_CACHE_POLICY.to_string(),
                ort_runtime: OrtRuntimeRecord {
                    mode: OrtRuntimeMode::CrateLinked,
                    configured_library_sha256: None,
                    configured_library_byte_count: None,
                },
            },
            model: ModelIdentity {
                kind: "regular-file".to_string(),
                digest_algorithm: "sha256".to_string(),
                sha256: "d".repeat(64),
                entry_count: 1,
                byte_count: 1,
            },
            fixture: FixtureIdentity {
                format: "png".to_string(),
                width: 2,
                height: 2,
                encoded_byte_count: 1,
                rgba_byte_count: 16,
                encoded_sha256: "e".repeat(64),
                rgba_sha256: "f".repeat(64),
            },
            policy: PolicyRecord::new(0.25, 0.45, 100).unwrap(),
            run: RunConfig::new(1, 1).unwrap(),
            measurement: MeasurementRecord {
                requested_backend: Backend::ONNX,
                selected_backend: Backend::ONNX,
                provider_label: provider.to_string(),
                initialization_ms: 1.0,
                evidence_loop_wall_ms: 1.1,
                sequential_detector_throughput_fps: 1_000.0,
                latency: LatencySummary::from_samples(&[1.0]).unwrap(),
                samples,
                first_output,
            },
            baseline_comparison: None,
        }
    }

    #[test]
    fn latency_summary_should_use_nearest_rank_quantiles() {
        let summary = LatencySummary::from_samples(&[4.0, 1.0, 3.0, 2.0]).unwrap();

        assert_eq!(
            (
                summary.min_ms,
                summary.mean_ms,
                summary.p50_ms,
                summary.p95_ms,
                summary.max_ms
            ),
            (1.0, 2.5, 2.0, 4.0, 4.0)
        );
    }

    #[test]
    fn run_config_should_reject_unbounded_iterations() {
        let error = RunConfig::new(1, MAX_ITERATIONS + 1).unwrap_err();

        assert!(error.to_string().contains("iterations must be between"));
    }

    #[test]
    fn parse_cli_should_reject_duplicate_arguments() {
        let error = parse_cli(["--backend", "onnx", "--backend", "onnx"].map(str::to_string))
            .err()
            .expect("duplicate arguments must fail");

        assert!(error.to_string().contains("duplicate argument --backend"));
    }

    #[test]
    fn parse_cli_should_require_baseline_threshold_pair() {
        let arguments = [
            "--backend",
            "onnx",
            "--model",
            "model.onnx",
            "--fixture",
            "fixture.png",
            "--output",
            "report.json",
            "--hardware",
            "test",
            "--source-commit",
            "0123456789012345678901234567890123456789",
            "--baseline",
            "baseline.json",
        ];
        let error = parse_cli(arguments.map(str::to_string))
            .err()
            .expect("unpaired baseline must fail");

        assert!(error
            .to_string()
            .contains("--baseline, --baseline-sha256, and --max-regression-percent"));
    }

    #[test]
    fn benchmark_should_fail_on_any_measured_inference_error() {
        let error = run_benchmark(
            &runtime(Some(3)),
            Backend::ONNX,
            &fixture_data(),
            PolicyRecord::new(0.25, 0.45, 100).unwrap(),
            RunConfig::new(1, 2).unwrap(),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("measured iteration 2 of 2 failed"));
    }

    #[test]
    fn benchmark_should_fail_on_any_warmup_inference_error() {
        let error = run_benchmark(
            &runtime(Some(2)),
            Backend::ONNX,
            &fixture_data(),
            PolicyRecord::new(0.25, 0.45, 100).unwrap(),
            RunConfig::new(2, 1).unwrap(),
        )
        .unwrap_err();

        assert!(error.to_string().contains("warmup 2 of 2 failed"));
    }

    #[test]
    fn benchmark_should_record_every_successful_sample() {
        let measurement = run_benchmark(
            &runtime(None),
            Backend::ONNX,
            &fixture_data(),
            PolicyRecord::new(0.25, 0.45, 100).unwrap(),
            RunConfig::new(1, 3).unwrap(),
        )
        .unwrap();

        assert_eq!(
            (
                measurement.samples.len(),
                measurement.provider_label.as_str(),
                measurement.first_output.len()
            ),
            (3, "ONNX Runtime (test CPU)", 1)
        );
    }

    #[test]
    fn model_tree_hash_should_ignore_creation_order() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_model = first.path().join("model.mlmodelc");
        let second_model = second.path().join("model.mlmodelc");
        fs::create_dir_all(first_model.join("sub")).unwrap();
        fs::write(first_model.join("z.bin"), b"z").unwrap();
        fs::write(first_model.join("sub/a.bin"), b"a").unwrap();
        fs::create_dir_all(second_model.join("sub")).unwrap();
        fs::write(second_model.join("sub/a.bin"), b"a").unwrap();
        fs::write(second_model.join("z.bin"), b"z").unwrap();

        let first_identity = validate_model(&first_model, Backend::CoreML)
            .unwrap()
            .identity;
        let second_identity = validate_model(&second_model, Backend::CoreML)
            .unwrap()
            .identity;

        assert_eq!(
            (
                first_identity.sha256,
                first_identity.entry_count,
                first_identity.byte_count
            ),
            (
                second_identity.sha256,
                second_identity.entry_count,
                second_identity.byte_count
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn model_tree_hash_should_reject_symlink_entries() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let model = temporary.path().join("model.mlmodelc");
        fs::create_dir(&model).unwrap();
        fs::write(temporary.path().join("outside.bin"), b"outside").unwrap();
        symlink(temporary.path().join("outside.bin"), model.join("link.bin")).unwrap();

        let error = validate_model(&model, Backend::CoreML).unwrap_err();

        assert!(error.to_string().contains("must not contain symlink"));
    }

    #[test]
    fn fixture_loader_should_hash_encoded_and_decoded_bytes() {
        let temporary = tempfile::tempdir().unwrap();
        let fixture_path = temporary.path().join("fixture.png");
        let image = DynamicImage::new_rgba8(2, 3);
        let mut encoded = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
            .unwrap();
        fs::write(&fixture_path, &encoded).unwrap();

        let fixture = load_fixture(&fixture_path).unwrap();

        assert_eq!(
            (
                fixture.identity.width,
                fixture.identity.height,
                fixture.identity.encoded_sha256,
                fixture.identity.rgba_sha256
            ),
            (2, 3, sha256_bytes(&encoded), sha256_bytes(&fixture.rgba))
        );
    }

    #[test]
    fn bounded_reader_should_reject_file_growth_past_limit() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("growing.bin");
        fs::write(&path, b"abcdef").unwrap();

        let error = read_file_bounded(&path, 3, 4, "test file").unwrap_err();

        assert!(error.to_string().contains("exceeds 4 bytes"));
    }

    #[test]
    fn baseline_reader_should_require_the_trusted_digest() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("baseline.json");
        let bytes = serde_json::to_vec(&sample_artifact("ONNX Runtime (CPU)")).unwrap();
        fs::write(&path, &bytes).unwrap();

        let error = read_baseline(&path, &"0".repeat(64)).unwrap_err();

        assert!(error.to_string().contains("baseline SHA-256 mismatch"));
    }

    #[test]
    fn baseline_comparison_should_reject_provider_mismatch() {
        let current = sample_artifact("ONNX Runtime (CPU)");
        let baseline = sample_artifact("ONNX Runtime (CUDA)");

        let error = compare_to_baseline(&current, &baseline, "a".repeat(64), 5.0).unwrap_err();

        assert!(error.to_string().contains("provider label differs"));
    }

    #[test]
    fn baseline_comparison_should_reject_unattested_dynamic_ort() {
        let mut current = sample_artifact("ONNX Runtime (CPU)");
        let baseline = sample_artifact("ONNX Runtime (CPU)");
        current.runtime_environment.ort_runtime.mode = OrtRuntimeMode::LinuxDynamicUnattestedSearch;

        let error = compare_to_baseline(&current, &baseline, "a".repeat(64), 5.0).unwrap_err();

        assert!(error
            .to_string()
            .contains("ONNX Runtime library identity is unattested"));
    }

    #[test]
    fn artifact_validation_should_reject_tampered_latency_summary() {
        let mut artifact = sample_artifact("ONNX Runtime (CPU)");
        artifact.measurement.latency.p95_ms = 99.0;

        let error = validate_artifact(&artifact).unwrap_err();

        assert!(error
            .to_string()
            .contains("latency summary does not match raw samples"));
    }

    #[test]
    fn artifact_validation_should_link_comparison_to_measurement() {
        let mut artifact = sample_artifact("ONNX Runtime (CPU)");
        artifact.baseline_comparison = Some(BaselineComparison {
            baseline_artifact_sha256: "a".repeat(64),
            baseline_source_commit: "b".repeat(40),
            baseline_p95_ms: 1.0,
            current_p95_ms: 2.0,
            p95_change_percent: 100.0,
            max_regression_percent: 5.0,
            passed: false,
        });

        let error = validate_artifact(&artifact).unwrap_err();

        assert!(error
            .to_string()
            .contains("baseline comparison result does not match"));
    }

    #[test]
    fn atomic_writer_should_refuse_to_replace_existing_report() {
        let temporary = tempfile::tempdir().unwrap();
        let output = temporary.path().join("report.json");
        let artifact = sample_artifact("ONNX Runtime (CPU)");
        write_artifact_atomically(&output, &artifact).unwrap();
        let original = fs::read(&output).unwrap();

        let error = write_artifact_atomically(&output, &artifact).unwrap_err();

        assert!(error.to_string().contains("output already exists"));
        assert_eq!(fs::read(&output).unwrap(), original);
    }

    #[test]
    fn output_validation_should_reject_path_inside_model_tree() {
        let temporary = tempfile::tempdir().unwrap();
        let model_path = temporary.path().join("model.mlmodelc");
        fs::create_dir(&model_path).unwrap();
        let model_path = model_path.canonicalize().unwrap();
        let fixture_path = temporary.path().join("fixture.png");
        fs::write(&fixture_path, b"fixture").unwrap();
        let model = ValidatedModel {
            path: model_path.clone(),
            identity: sample_artifact("provider").model,
        };
        let fixture = FixtureData {
            path: fixture_path,
            identity: fixture_data().identity,
            rgba: Vec::new(),
        };

        let error =
            validate_output_path(&model_path.join("report.json"), &model, &fixture).unwrap_err();

        assert!(error.to_string().contains("inside the model directory"));
    }

    #[test]
    fn model_rehash_should_detect_content_mutation() {
        let temporary = tempfile::tempdir().unwrap();
        let model_path = temporary.path().join("model.onnx");
        fs::write(&model_path, b"first").unwrap();
        let first = validate_model(&model_path, Backend::ONNX).unwrap().identity;
        fs::write(&model_path, b"second").unwrap();

        let second = validate_model(&model_path, Backend::ONNX).unwrap().identity;

        assert_ne!(first.sha256, second.sha256);
    }

    #[test]
    fn measurement_validation_should_reject_missing_raw_sample() {
        let mut artifact = sample_artifact("ONNX Runtime (CPU)");
        artifact.measurement.samples.clear();

        let error = validate_artifact(&artifact).unwrap_err();

        assert!(error.to_string().contains("expected 1 samples, found 0"));
    }

    #[test]
    fn regression_comparison_should_fail_at_exact_exceeded_threshold() {
        let current = sample_artifact("ONNX Runtime (CPU)");
        let mut baseline = sample_artifact("ONNX Runtime (CPU)");
        baseline.measurement.samples[0].call_latency_ms = 0.5;
        baseline.measurement.latency = LatencySummary::from_samples(&[0.5]).unwrap();
        baseline.measurement.sequential_detector_throughput_fps = 2_000.0;

        let comparison = compare_to_baseline(&current, &baseline, "a".repeat(64), 99.0).unwrap();

        assert!(!comparison.passed);
    }

    #[test]
    fn provider_identity_should_remain_stable_across_observations() {
        let provider = Arc::new("ONNX Runtime (CPU)".to_string());
        let output = crebain_lib::inference::InferenceOutput {
            backend: Backend::ONNX,
            backend_name: (*provider).clone(),
            detections: Vec::new(),
            inference_time_ms: 1.0,
        };
        let mut observed = None;
        observe_output_identity(&output, Backend::ONNX, &mut observed).unwrap();

        assert_eq!(observed.as_deref(), Some(provider.as_str()));
    }
}
