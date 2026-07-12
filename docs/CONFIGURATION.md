# CREBAIN Configuration Reference

Environment variables, runtime settings, and enforced scene/asset limits.
Sensor-fusion tuning lives in [SENSOR_FUSION.md](SENSOR_FUSION.md); model
requirements in [MODEL_CONTRACTS.md](MODEL_CONTRACTS.md); security semantics of
the trust-sensitive variables in [../SECURITY.md](../SECURITY.md).

## Environment variables

| Variable | Description | Values |
| -------- | ----------- | ------ |
| `CREBAIN_MODEL_PATH` | ML model path | Path to `.mlmodelc` or `.onnx` |
| `CREBAIN_ONNX_MODEL` | ONNX model path (override) | Path to `.onnx` |
| `CREBAIN_BACKEND` | Force ML backend (`mlx` additionally requires the experimental gate below) | `coreml`, `mlx`, `tensorrt`, `cuda`, `onnx` |
| `CREBAIN_ENABLE_EXPERIMENTAL_MLX` | Required for any MLX use: gates both auto-selection on Apple Silicon and explicit `CREBAIN_BACKEND=mlx` | `1` / `true` / `yes` / `on` |
| `CREBAIN_MLX_MODEL` | MLX safetensors model path | Path to `.safetensors` |
| `CREBAIN_MLX_MODEL_SHA256` | Optional MLX model digest pin | 64-character SHA-256 hex digest |
| `CREBAIN_PROFILE_MLX` | Per-layer MLX latency logging | `1` |
| `CREBAIN_TRT_CACHE_DIR` | TensorRT engine cache dir | Directory path (Linux) |
| `CREBAIN_DISABLE_TRT_CACHE` | Disable TensorRT caching | `1` / `true` |
| `TENSORRT_ROOT` | TensorRT installation root, probed for `bin/trtexec` (Linux) | Directory path |
| `ORT_DYLIB_PATH` | ONNX Runtime library path (honored by `ort` only on Linux `load-dynamic` builds; the Nix shells pre-set it to the nixpkgs library) | Path to `libonnxruntime.so` |
| `CREBAIN_ZENOH` | Select the native Rust transport: unset/true-like uses Zenoh; any other value uses its rosbridge fallback. This does not choose the product UI transport. | `1` / `0` |
| `CREBAIN_ROSBRIDGE_URL` | URL used only by the native Rust rosbridge fallback (`CREBAIN_ZENOH=0`) | `ws://localhost:9090` (default) |
| `CREBAIN_ALLOW_UNSAFE_GAZEBO_XML` | Native Rust trusted-development bypass for caller-supplied Gazebo XML containing plugin/include/URI/external-resource directives | `1` only in an isolated trusted environment |
| `CREBAIN_PID_JSONL` | Native best-effort innovation-record append sink; the path is trusted operator configuration and may contain sensitive telemetry. Records are emitted per associated measurement that corrected a Kalman-family filter; Particle and IMM emit nothing (no single compatible innovation covariance). | Writable local path |

The frontend ROS connection panel defaults separately to WebSocket and uses its
own URL field. Frontend caller-supplied Gazebo XML always rejects privileged
directives; only the audited bundled Maverick helper has a fixed privileged
frontend path. The native environment bypass does not weaken that frontend rule.

## Detection settings

| Parameter | Default | Notes |
| --------- | ------- | ----- |
| Confidence Threshold | 0.25 | Clamped to 0.0–1.0 at the IPC boundary |
| IOU Threshold | 0.45 | Hardcoded on the native path (the IPC parameter is accepted but ignored); configurable in the browser `YOLODetector` and `CoreMLDetector` (RF-DETR/Moondream accept the option but ignore it) |
| Max Detections | 100 | Clamped to 1–1000 at the IPC boundary |

Individual browser backends override the confidence default (CoreML 0.3,
RF-DETR 0.35, Moondream 0.3); see `src/detection/*Detector.ts`.

## Sensor fusion settings

The full tuning table (algorithm choice, process/measurement noise, gating,
M-of-N confirmation, covariance ceilings, particle count) is maintained in
[SENSOR_FUSION.md](SENSOR_FUSION.md#configuration-and-tuning) — it is the
single source of truth for fusion defaults and per-parameter guidance.

## Guidance controller settings

| Parameter | Default | Description |
| --------- | ------- | ----------- |
| Rate | 20Hz | Control loop frequency (browser timers permitting) |
| Max Velocity | 15 m/s | Speed limit |
| Max Acceleration | 5 m/s² | Velocity ramp limit |
| kP | 1.5 | Proportional gain |
| kD | 0.5 | Derivative gain (on measured velocity) |
| Approach Distance | 10 m | Deceleration radius |
| Arrival Threshold | 0.5 m | Waypoint-reached distance |

Local drone physics simulation steps at 120 Hz (`src/physics/`).

## Scene and asset limits

All limits below are enforced in code; sources are `src/state/SceneState.ts`,
`src-tauri/src/lib.rs`, `src/components/CrebainViewer.tsx`, and
`src/lib/glbValidation.ts`.

### Scene files

Scene JSON is bounded to 10 MiB before browser or native parsing. Older
versions are migrated before the current schema is validated. The current
schema allows at most 64 cameras, 256 drones, 128 GLB assets, 10,000 recent
detections, 4,096 route points per route, and 16,777,216 aggregate camera
render-target pixels. Camera, drone, and asset IDs must be mutually unique
(detection IDs are not deduplicated), references must resolve, and drone
orientation quaternions must be approximately unit length (camera rotations
are finite Euler vectors bounded like other vector components). Numeric values
must be finite, with range bounds on most fields (vector components within
±1,000,000; bounding-box coordinates non-negative, at most 1,000,000, and
max ≥ min per axis; battery 0–100; confidence 0–1; threat level 0–4;
FOV strictly between 0 and 180; resolution 1–4096 per axis); a few fields are
only required to be finite (pan, tilt, target altitude) or positive (zoom,
near-plane).

Native saves use an atomic same-directory temporary file before replacement,
and native scene paths are confined to the app-data `scenes` directory, must
end in `.json`, and reject path traversal.

### Restorable external sources

Restorable sources are limited to app-relative paths, HTTPS URLs, and HTTP
loopback URLs (`localhost`, `127.0.0.1`, or `::1`) without URL credentials, at
most 2,048 characters, with NUL bytes rejected. Scene GLB entries must end in
`.glb`; browser-selected local files that have no reloadable source are
intentionally not serialized as restorable assets.

### Asset loading

| Asset | Boundary |
| ----- | -------- |
| Splat | 256 MiB source; remote download aborts after 30 s; renderer initialization aborts after 120 s |
| GLB | 128 MiB per source; remote download aborts after 30 s; 512 MiB aggregate loaded/pending GLB bytes; 128 assets |
| GLB contents | GLB 2.0 only; any buffer must use the single embedded binary chunk; no external buffers/images; embedded images must be PNG/JPEG with matching MIME bytes, at most 256 images, at most 8,192 px per image dimension, and at most 16,777,216 aggregate texture pixels |
| Floor texture | PNG/JPEG only; 32 MiB source; at most 8,192 px per dimension and 16,777,216 pixels; remote download aborts after 30 s |

Streaming byte ceilings are enforced even when `Content-Length` is missing or
dishonest. Scene restore waits for each asset result, ignores superseded loads,
and reports a partial restore instead of claiming success when an asset fails;
the whole restore is additionally bounded by a 120 s timeout that aborts all
in-flight asset loads.

## Platform matrix

| Component | macOS (Apple Silicon) | NixOS (NVIDIA) |
| --------- | --------------------- | -------------- |
| ML Inference | CoreML default / MLX experimental opt-in | CUDA / TensorRT |
| GPU Compute | Metal-family APIs where supported | CUDA where supported |
| 3D Rendering | Three.js WebGLRenderer | Three.js WebGLRenderer |
| Build System | Nix / Homebrew | Nix |
| Gazebo | Native / Docker | Native |
