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
| `CREBAIN_ZENOH` | Select the native read-only Rust telemetry transport: unset or `1`/`true`/`yes`/`on` uses Zenoh; `0`/`false`/`no`/`off` uses its read-only rosbridge fallback. Any other value is a configuration error. This does not enable the development-only renderer client. | `1` / `0` |
| `CREBAIN_ROSBRIDGE_URL` | URL used only by the native read-only Rust rosbridge fallback (`CREBAIN_ZENOH=0`) | `ws://localhost:9090` (default) |
| `CREBAIN_PID_JSONL` | Native innovation-record sink; its presence also changes the effective Galadriel config pin. An `ncp` build preflights a configured sink. Without an active producer the fusion command waits for synchronous best-effort write/flush after releasing the fusion lock. With the producer active, copies use a capacity-16 drop-new archive worker; admission or worker I/O failure latches degradation, and worker failure terminates the worker. | Operator-approved regular local file; never a FIFO/device/socket or unbounded/remote mount |
| `CREBAIN_GALADRIEL_ENABLE` | Exact runtime opt-in for the Galadriel evidence producer in a binary compiled with Cargo feature `ncp`; a non-feature binary fails startup when set to `1` | Absent/`0` off; exactly `1` on |
| `CREBAIN_GALADRIEL_REALM` | Required enabled NCP realm for both evidence routes | Key-safe NCP realm |
| `CREBAIN_GALADRIEL_PRODUCER_ID` | Required declared producer identity in each envelope; this string is not by itself a TLS-principal binding | Key-safe identity segment |
| `CREBAIN_GALADRIEL_EPOCH` | Required operator-provisioned session identity used in both evidence keys; syntax validation does not prove uniqueness or anti-rollback | One key-safe UTF-8 segment, `1..=64` bytes; provision a new unique value for each process lifetime |
| `CREBAIN_GALADRIEL_REGISTRY_PATH` | Required enabled path to the strict, bounded deployment registry | Readable JSON file, at most 1 MiB |
| `CREBAIN_GALADRIEL_REGISTRY_DIGEST` | Required expected canonical registry digest | 64 lowercase SHA-256 hex characters |
| `CREBAIN_GALADRIEL_FRAME_ID` | Required selected frame in the registry | Decimal JSON-safe positive integer |
| `CREBAIN_GALADRIEL_CONTEXT_ID` | Required selected context bound to that frame | Decimal JSON-safe positive integer |
| `CREBAIN_GALADRIEL_SOFTWARE_DIGEST` | Required digest that must match both the running executable file and selected registry context | 64 lowercase SHA-256 hex characters |
| `CREBAIN_GALADRIEL_CONFIGURATION_DIGEST` | Required digest that must match both the effective canonical fusion configuration and selected registry context | 64 lowercase SHA-256 hex characters |
| `CREBAIN_GALADRIEL_FUSION_CONFIG_PATH` | Optional strict fusion-config input; absence uses `FusionConfig::default()` | Nonempty JSON file, at most 64 KiB |
| `CREBAIN_GALADRIEL_HEARTBEAT_INTERVAL_MS` | Producer heartbeat interval | `1..=300000`; default `1000` |
| `CREBAIN_GALADRIEL_HEARTBEAT_DEADLINE_MS` | Declared receiver deadline, no shorter than the interval | Interval through `300000`; default `3000` |
| `CREBAIN_GALADRIEL_OBSERVATION_QUEUE_CAPACITY` | Optional observation-lane override | Positive; bounded by registry/wire policy |
| `CREBAIN_GALADRIEL_OUTCOME_QUEUE_CAPACITY` | Optional outcome/miss-lane override | Positive; bounded by registry/wire policy |
| `CREBAIN_GALADRIEL_SUMMARY_QUEUE_CAPACITY` | Optional summary-lane override | Positive; bounded by registry/wire policy |
| `CREBAIN_GALADRIEL_HEARTBEAT_QUEUE_CAPACITY` | Optional heartbeat-lane override | Positive; bounded by registry/wire policy |
| `NCP_ZENOH_CONFIG` | Zenoh configuration required by the enabled producer's secure mode and by the optional native NCP bridge's secure connection mode | Readable deployment-controlled path |

Model paths reject a final symlink and require a regular file for ONNX and
safetensors or a real directory for `.mlmodelc`. The runtime subsequently
reopens the path, so an operator must keep the model and parent directories
immutable and access-controlled during loading; path validation is not a claim
against a concurrent privileged local replacement.

Packaged frontend builds default to Zenoh and do not contain a usable renderer
rosbridge client; their CSP also omits rosbridge WebSocket origins. Vite
development builds may select the read-only WebSocket adapter and use its URL
field. No environment variable enables removed renderer/native Gazebo mutation
or generic ROS publishing capabilities. The Galadriel switch is a separate
native, feature-gated exception limited to two named perception evidence routes;
it does not add a generic ROS, renderer, action, service, or FCU surface.

Production `connect-src` permits Tauri IPC plus only the source classes already
accepted by bounded scene-asset restoration: same-origin, HTTPS, and HTTP
loopback. Static analysis permits renderer `fetch` only in
`src/lib/boundedFetch.ts`; the production module graph must contain the disabled
rosbridge replacement and omit the development client. Before bundling, an
exact package/version/module-hash transform disables pinned Spark URL loading,
Spark/Rapier external WebAssembly inputs, and Three `FileLoader` and
`ImageBitmapLoader` network paths. Spark's exact embedded payload is decoded
directly to bytes, Rapier retains its exact public embedded-byte initializer,
and Spark's `fileBytes` scene path remains structurally pinned. Three's
`ImageLoader` admits only local `blob:` URLs or canonical PNG/JPEG base64 data
URIs, while transformed `GLTFLoader.parse` rejects every other manifest `uri`.
Both URI walks reserve each container against a 262,144-value visited-plus-
pending ceiling before pushing any children, and the loader selects
`TextureLoader` so validated embedded textures remain usable. Any
upstream digest, package entry, payload, call-shape, or replacement-count drift
stops the build; `bun run check:production-vendors` exercises both validated
local-texture GLB forms and the Spark/Rapier embedded-byte runtimes. `img-src`
is limited to same-origin, `blob:`, and `data:` because downloaded textures are
decoded from bounded bytes rather than loaded as arbitrary remote image URLs.
Navigation, forms, embedded objects, and framing are denied by explicit CSP
directives.

## Renderer TF boundary

The development-only renderer rosbridge validates `/tf` and `/tf_static`
before dispatch. Parent and child frame IDs must be nonempty, unpadded,
whitespace-free strings of at most 256 characters. Each transform translation
has a Euclidean norm of at most 1,000,000 m. Incoming rotations must be finite,
nonzero quaternions whose norm differs from one by no more than `1e-3`.

Accepted ingress quaternions are normalized to exact unit length before the
transform cache uses them; zero and materially non-unit inputs are rejected,
not repaired. Interpolation and composition normalize ordinary finite
floating-point drift, but reject zero/nonfinite rotations, nonfinite results,
and translations beyond the same operational bound. A multi-hop lookup fails
closed when any intermediate composed transform violates these rules.

An explicit-time lookup of a dynamic edge requires an exact or bracketing sample
and never extrapolates. A latest multi-hop lookup chooses the newest timestamp
in the intersection of all dynamic-edge histories and evaluates every dynamic
edge at that one common time; static edges are timeless. No common interval
fails closed.

## Galadriel deployment pins

Galadriel publication has two independent gates: the executable must be built
with Cargo feature `ncp`, then `CREBAIN_GALADRIEL_ENABLE` must be exactly `1`.
The standard release workflow currently omits that feature. An absent/`0` switch
opens no producer session; an ambiguous value or `1` in a non-feature binary
fails startup.

Enabled startup validates the explicit process epoch, registry, selected
identities, effective fusion configuration, and running executable before
opening the secure-mode NCP Zenoh session. The effective configuration is the
parsed/default `FusionConfig` after
the `CREBAIN_PID_JSONL` innovation-emission override. Its fully materialized
compact JSON SHA-256 must equal both the environment pin and selected registry
context. The actual running executable file SHA-256 must likewise equal the
environment and context software pins. Provision the latter from the final
post-signing/post-packaging executable.

CREBAIN does not mint the process epoch. Deployment orchestration must set
`CREBAIN_GALADRIEL_EPOCH` to a new unique value for every process lifetime and
must prevent reuse across restarts. The producer validates only that the value
is one key-safe `1..=64` byte segment; it cannot prove freshness, durable
uniqueness, or anti-rollback.

Once active, the startup-loaded fusion engine is immutable for the producer
epoch. Renderer `fusion_init` calls are readiness checks and their supplied
defaults are ignored; `fusion_set_config` accepts only the already pinned
canonical digest and does not replace the engine.

The registry is strict and canonically hashed, but its calibration, transform,
and projection-algorithm content references are not fetched or verified. Digest
matching also does not authenticate the operator-supplied environment or prove
software provenance. Protect the registry, digest source, fusion config,
executable, and `NCP_ZENOH_CONFIG` as one deployment manifest.

The active producer does not write JSONL on its ordered evidence workers. It
copies eligible observations into a separate capacity-16 frame channel with
nonblocking drop-new admission; full/disconnected admission marks the producer
degraded before its frame summary is admitted. An `ncp`-feature startup first
opens/truncates and preflights a configured sink. The archive worker validates
and serializes the whole batch before its first write; write or flush failure
degrades the epoch and terminates the worker. A later OS write failure can still
leave part of that already-validated batch on disk. The archive thread performs
blocking file I/O. Shutdown closes its sender and waits at most two seconds, but
a blocked standard thread cannot be forcibly aborted. The ordinary
no-producer path remains synchronous (inside `spawn_blocking`), so a slow or
special path can delay `fusion_process`. These archive semantics are separate
from the four NCP evidence lanes and the five-second NCP put bound.

See [GALADRIEL_PRODUCER.md](GALADRIEL_PRODUCER.md) for the exact routes, queue and
drop semantics, heartbeat/shutdown limits, projection restrictions, and the
component-versus-deployment evidence boundary.

## Detection settings

| Parameter | Default | Notes |
| --------- | ------- | ----- |
| Confidence Threshold | 0.25 | Must be finite and between 0.25 and 1.0, inclusive |
| IoU Threshold | 0.45 | Must be finite and between 0.0 and 0.45, inclusive; applied by the runtime's class-aware NMS |
| Max Detections | 100 | Must be an integer between 1 and 100, inclusive |

These limits are the common portable backend envelope. The runtime policy can
tighten confidence, IoU, and result-count limits, but it cannot recover a
candidate that a selected backend already discarded.

The standalone native detector benchmark accepts these same policy bounds. For
comparability it removes `CREBAIN_PROFILE_MLX` and forces
`CREBAIN_DISABLE_TRT_CACHE=1` inside its single-purpose process; initialization
is recorded separately. This does not change product-runtime configuration.
See [NATIVE_DETECTOR_BENCHMARK.md](NATIVE_DETECTOR_BENCHMARK.md).

## Sensor fusion settings

The full tuning table (algorithm choice, process/measurement noise, gating,
M-of-N confirmation, covariance ceilings, particle count) is maintained in
[SENSOR_FUSION.md](SENSOR_FUSION.md#configuration-and-tuning) — it is the
single source of truth for fusion defaults and per-parameter guidance.

The native input envelope is at most 512 measurements per call, 1,024 live
tracks, 256-byte measurement strings, and 64 metadata entries. Cartesian
position/radar range is bounded at 10,000,000 m, velocity components at
100,000 m/s, covariance diagonals at `(0, 1e12]`, and metadata magnitude at
`1e12`. A selected Galadriel registry may tighten the input/active-track limits.
Upstream and registry trimming keep the newest inputs and make the active frame
degraded/truncated; active-track overflow drops whole deterministic birth
clusters. See [GALADRIEL_PRODUCER.md](GALADRIEL_PRODUCER.md) for exact-time and
loss semantics.

## Local guidance-preview settings

These values configure disabled-by-default, renderer-local proposals only.
They do not configure a flight controller or create vehicle authority. Every
proposal is marked `NoAuthority`; the preview's local fallback label is `Hold`,
and boundary transitions discard the preview generation rather than resuming
it. That label is neither the plant safe-action candidate nor a claim that a
physical Hold is safe for any authoritative vehicle state.

| Parameter | Default | Description |
| --------- | ------- | ----------- |
| Rate | 20Hz | Local proposal frequency (browser timers permitting) |
| Max Velocity | 15 m/s | Preview-vector limit |
| Max Acceleration | 5 m/s² | Preview ramp limit |
| kP | 1.5 | Proportional gain |
| kD | 0.5 | Derivative gain (on measured velocity) |
| Approach Distance | 10 m | Deceleration radius |
| Arrival Threshold | 0.5 m | Waypoint-reached distance |

Local drone physics simulation steps at 120 Hz (`src/physics/`).

## Scene and asset limits

All limits below are enforced in code; sources are `src/state/SceneState.ts`,
`src/lib/routeLimits.ts`, `src/physics/DroneTypes.ts`, `src-tauri/src/lib.rs`,
`src/components/CrebainViewer.tsx`, and `src/lib/glbValidation.ts`.

### Scene files

Scene JSON is bounded to 10 MiB before browser or native parsing. Older
versions are migrated before the current schema is validated. The current
schema allows at most 64 cameras, 256 drones, 128 GLB assets, 10,000 recent
detections, 256 route points per route, and 16,777,216 aggregate camera
render-target pixels. Camera, drone, and asset IDs must be mutually unique
(detection IDs are not deduplicated), references must resolve, and drone
orientation quaternions must be approximately unit length (camera rotations
are finite Euler vectors bounded like other vector components). Numeric values
must be finite, with range bounds on most fields (vector components within
±1,000,000; route X/Z within that envelope; route Y, target altitude, and target
position Y from 0 through the selected built-in drone profile's declared ceiling,
or 4,500 m for an unknown profile; route speed multiplier 0–2; bounding-box
coordinates non-negative, at most 1,000,000, and max ≥ min per axis; battery
0–100; confidence 0–1; threat level 0–4; FOV strictly between 0 and 180;
resolution 1–4096 per axis). Pan and tilt are finite; zoom and near-plane are
positive.

Native saves use an atomic same-directory temporary file before replacement,
and native scene paths are confined to the app-data `scenes` directory, must
end in `.json`, and reject path traversal.

### Restorable external sources

Restorable and dropped string sources are limited to unambiguous app-relative
paths, explicit HTTPS URLs, and HTTP loopback URLs (`localhost`, `127.0.0.1`, or
`::1`) without URL credentials. Protocol-relative URLs, backslashes, ASCII
control characters, leading/trailing whitespace, and inputs longer than 2,048
characters are rejected before acquisition. Scene GLB entries must end in
`.glb`; splat entries must end in `.spz`, `.ply`, `.splat`, or `.ksplat` (before
any query or fragment). Browser-selected local files that have no reloadable
source are intentionally not serialized as restorable assets.

### Asset loading

| Asset | Boundary |
| ----- | -------- |
| Splat | 256 MiB source; a newer load/restore/unmount aborts both remote and browser-file acquisition; remote download aborts after 30 s; renderer initialization aborts after 120 s |
| GLB | 128 MiB per source; remote download aborts after 30 s; 512 MiB aggregate loaded/pending GLB bytes; 128 assets |
| GLB contents | GLB 2.0 only; one embedded buffer; validated bufferView/accessor/stride/sparse spans; at most 65,536 accessors, 16,777,216 elements per accessor, and 256 MiB decoded accessor data; bounded strict-tree scene/mesh/skin/animation work, 2,048 primitive instances, primitive modes 0-4 only, expanded draw/morph/node/mesh/camera/material/image-metadata budgets, and no strip/fan conversion or Draco/meshopt/GPU-instancing/punctual-light/texture-transform extensions; material texture references use texCoord 0; no external buffers/images; embedded PNG/JPEG dimensions, MIME bytes, non-overlapping distinct spans, sampler enums, 16 loader sampler-index identities per image, and decoded/resident pixel totals are bounded |
| Aggregate GLB resources | Loaded and concurrently parsing GLBs share the same decoded accessor/texture, resident texture, node, primitive, draw, morph, graph, animation, and cloneable-metadata ceilings as one accepted GLB; remote sources reserve 128 MiB before fetch and shrink to actual length; reservations are atomic before parsing and callback-only parse reservations remain until the parse settles even after reset/unmount, while removed/reset accepted assets release their retained budgets |
| Floor texture | PNG/JPEG only; 32 MiB source; at most 8,192 px per dimension and 16,777,216 pixels; remote download aborts after 30 s |

Streaming byte ceilings are enforced even when `Content-Length` is missing or
dishonest. Scene restore waits for each asset result and has one transactional
success boundary. Any ordinary loader/spawn error, returned-false aggregate
failure, or 120 s timeout invalidates nested work, aborts in-flight asset loads,
clears the partial cameras/drones/assets, rolls back applied UI settings, and
leaves physics paused before propagating the failure. A superseded generation
cannot clear or commit the newer restore.

## Platform matrix

The macOS application targets macOS 13.4 or later, matching the minimum of its
build-time-linked ONNX Runtime dependency. The Nix macOS package retains that
runtime as a store-managed closure dependency.

| Component | macOS (Apple Silicon) | Linux / Nix |
| --------- | --------------------- | ----------- |
| ML Inference | CoreML default / MLX experimental opt-in | ONNX Runtime with CPU fallback; CUDA/TensorRT execution providers are optional |
| GPU Compute | Metal-family APIs where supported | Optional CUDA where separately installed and qualified |
| 3D Rendering | Three.js WebGLRenderer | Three.js WebGLRenderer |
| Build System | Nix / Homebrew | Nix |
| Gazebo | Native / Docker | Native |
