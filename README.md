<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="CREBAIN logo" src="assets/logo-light.svg" width="200">
  </picture>
</p>

# CREBAIN

**Adaptive Response & Awareness System (ARAS)**
*DE: Adaptives Reaktions- und Aufklärungssystem*

[![CI](https://github.com/sepahead/crebain/actions/workflows/ci.yml/badge.svg)](https://github.com/sepahead/crebain/actions/workflows/ci.yml)
[![CodeQL](https://github.com/sepahead/crebain/actions/workflows/codeql.yml/badge.svg)](https://github.com/sepahead/crebain/actions/workflows/codeql.yml)
[![Supply chain audit](https://github.com/sepahead/crebain/actions/workflows/audit.yml/badge.svg)](https://github.com/sepahead/crebain/actions/workflows/audit.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](#license)

CREBAIN is a research prototype for tactical visualization and autonomy. This
Tauri desktop application:

- renders Gaussian-splat 3D scenes
- places simulated surveillance cameras in the scenes
- runs machine learning (ML) object detection through native backends
- fuses multi-modal sensor measurements into persistent 3D tracks
- connects to ROS and Gazebo for drone simulation

An off-by-default native Neuro-Cybernetic Protocol (NCP) feature can emit
narrowly scoped, Galadriel-compatible advisory evidence. CREBAIN uses Tauri 2,
React 19, SparkJS, Three.js, and Rust.

> **Project status.** This is a research prototype, not a product. No model
> weights ship with the repository. Capability statuses below are tracked here
> and are unverified until they are measured on target hardware. A performance
> claim requires a recorded model, fixture, backend, invocation, and hardware
> context. Experimental backends are opt-in. See the [Disclaimer](#disclaimer).

> **0.9.0 research-only scope.** The release is NARROWED_GO only for a
> research/source and automated-package review. It is NO_GO for operational,
> deployment, authority, model-accuracy, field, or cross-repository 1.0 claims.
> See the exact [release decision](docs/NARROWED_GO_0.9.0.md) and
> [task disposition](audit/candidate/README.md).

**Contents:**
[Quickstart](#quickstart) ·
[Using the app](#using-the-app) ·
[ML detection](#ml-detection) ·
[Sensor fusion](#sensor-fusion) ·
[Architecture](#architecture) ·
[ROS and Gazebo](#ros-and-gazebo-simulation) ·
[Configuration](#configuration-essentials) ·
[Documentation](#documentation) ·
[Development](#development-and-validation) ·
[Status and roadmap](#status-and-roadmap) ·
[Troubleshooting](#troubleshooting) ·
[Contributing](#contributing) ·
[Citing](#citing) ·
[Disclaimer](#disclaimer) ·
[License](#license)

| Capability | Description | Status |
| ---------- | ----------- | ------ |
| **3D Visualization** | Gaussian splatting and operator-supplied self-contained GLB models through Three.js (WebGL). No third-party 3D model is bundled. | Prototype |
| **Multi-Camera Surveillance** | Up to 64 placeable cameras (static, PTZ, or patrol). Live feed thumbnails for the first four cameras. | Prototype |
| **ML Detection** | Object detection pipeline with CoreML/ONNX paths and experimental backends | Prototype |
| **Sensor Fusion** | 5 filter algorithms (KF/EKF/UKF/PF/IMM) for multi-modal tracking | Prototype |
| **Drone Physics** | 120Hz quadcopter aerodynamics simulation | In Progress |
| **ROS Integration** | Read-only Zenoh product telemetry + development/native rosbridge telemetry fallback | In Progress |
| **Galadriel Evidence** | Feature-gated, exact-runtime-opt-in producer with immutable pinned registry, configuration, and executable. It has two bounded NCP evidence routes, strict time and projection eligibility, loss degradation, and heartbeat accounting. Deployed receiver and security evidence remains pending. | Component-tested |
| **Plant Authority** | Dependency-free headless lifecycle, channel, and passive-expiry foundation with inactive and unwired contract candidates. The self-check does not prove autonomous lifecycle observation, output invalidation, safe action, wake latency, command binding, or an FCU adapter. See the detailed plant documents. | L0 Foundation |
| **Cross-Platform** | macOS on Apple Silicon and Linux/Nix. The default Linux package uses ONNX Runtime and can fall back to the CPU. NVIDIA execution providers are optional. | In Progress |

---

## Quickstart

### macOS (Apple Silicon)

The 0.9.0 macOS application requires macOS 13.4 or later.

```bash
# Prerequisites (rustup honors the repo's pinned toolchain; a brew-installed
# rust does not)
xcode-select --install
brew install bun rustup

# Clone and setup
git clone https://github.com/sepahead/crebain.git
cd crebain

# From the repository root
bun install

# Optional: pre-build the release backend to verify the Rust toolchain
# (CoreML is used automatically on macOS; `tauri:dev` builds its own profile)
cargo build --locked --manifest-path src-tauri/Cargo.toml --release

# Run
bun run tauri:dev
```

### Linux/Nix (default, with optional NVIDIA acceleration)

```bash
# Clone
git clone https://github.com/sepahead/crebain.git
cd crebain

# Enter the default CPU-capable development environment
nix develop

# Optional on x86_64-linux with a separately qualified NVIDIA stack:
# nix develop .#cuda
# The explicit CUDA shell sets CUDA and ONNX Runtime paths; it does not
# infer hardware availability or attest that a GPU is present.

# Install frontend deps and run
bun install
bun run tauri:dev
```

### Model setup

This repository does **not** ship model weights. Provide your own model files.
Make sure that you have the right to use and redistribute them. The application
can start without a model. The scene, camera, and simulation features remain
available. The diagnostics interface reports the available detection backend.
This behavior is not a packaged-GUI or target-hardware qualification claim.

| Platform | Model Path | Format |
| -------- | ---------- | ------ |
| macOS | `CREBAIN_MODEL_PATH=/path/to/model.mlmodelc` | CoreML (`.mlmodelc` directory) |
| Linux | `CREBAIN_ONNX_MODEL=/path/to/model.onnx` | ONNX Runtime with CPU fallback and optional CUDA or TensorRT execution providers |

For local development you can also drop models into these paths (ignored by
git): `src-tauri/resources/yolov8s.mlmodelc/` (macOS) or
`src-tauri/resources/yolov8s.onnx` (Linux). The shared ONNX/TensorRT
postprocessor expects YOLOv8 COCO-80 output shaped `[1,84,N]` or `[1,N,84]`.
The CoreML path uses Vision and needs an NMS-wrapped `.mlmodelc`. See
[docs/MODEL_CONTRACTS.md](docs/MODEL_CONTRACTS.md) for what a model must
satisfy before its detections are trusted.

### First scene

Sample Gaussian-splat scenes (with download commands and licensing notes) are
listed in [public/splats/README.md](public/splats/README.md). Drag a scene
file onto the viewer or open it with `Ctrl/Cmd+O`.

---

## Using the app

1. Start the application with `bun run tauri:dev`.
2. Load a supported scene file with drag-and-drop or `Ctrl+O` (`Cmd+O` on
   macOS).
3. Press `1`, `2`, or `3` to enter a camera-placement mode.
4. Click to place the camera.
5. Press `Y` to enable or disable detection.
6. Press `P` to show or hide the performance panel.
7. Press `U` to show or hide the Sensor Fusion panel.
8. Press `N` to open the ROS connection panel.
9. Press `M` to enable or disable the 1.5-million-splat cap.

Essential keys — the full keymap lives in [docs/CONTROLS.md](docs/CONTROLS.md):

| Key | Action |
| --- | ------ |
| W/A/S/D + Q/E | Fly camera (Shift sprint, Ctrl/Cmd precision) |
| 1 / 2 / 3 | Place static / PTZ / patrol camera |
| Tab | Cycle cameras |
| V | Toggle camera feeds |
| T / Y | Toggle detection panel / detection on-off |
| U | Sensor Fusion panel |
| N | ROS connection panel |
| Esc | Cancel placement / clear selection (also emergency-disarms all drones) |

Scene JSON has a 10 MiB limit. Splat files have a 256 MiB limit. A GLB model
must be a self-contained GLB 2.0 file. It can contain embedded buffers and
PNG or JPEG textures. CREBAIN rejects standalone `.gltf` files and external
resource references. The full enforced limits are in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#scene-and-asset-limits).

The interface is German-first by design (camera types: SK = static camera,
PTZ = pan-tilt-zoom, PK = patrol camera) with a grayscale, tactical-signal
aesthetic and a project-specific 4-level threat scale (1=minimal, 2=guarded,
3=elevated, 4=severe).

---

## ML detection

- **Platform-native backends**: CoreML is the default on macOS. ONNX Runtime is
  the default on Linux. Linux prefers available TensorRT or CUDA providers and
  retains a CPU fallback. The default Nix package does not attest an NVIDIA
  runtime.
- **MLX is experimental, opt-in** (`CREBAIN_ENABLE_EXPERIMENTAL_MLX=1`,
  required even with `CREBAIN_BACKEND=mlx`): a Candle-on-Metal YOLOv8
  safetensors forward/postprocess path that still
  requires external model-contract validation before release claims.
- **Detection classes** (tactical mapping): `drone`, `bird`, `aircraft`,
  `helicopter`, `unknown`. These five labels are a downstream application
  taxonomy, not the native model tensor contract — a five-class exporter is
  not drop-in compatible. See
  [docs/MODEL_CONTRACTS.md](docs/MODEL_CONTRACTS.md).

## Sensor fusion

CREBAIN's normative multi-modal tracker is the native Rust engine in
`src-tauri/src/sensor_fusion.rs`. The Sensor Fusion panel displays its output.
The browser-only multi-camera module is a separate geometric estimator with a
different contract, not a second implementation or parity oracle.
Measurements from six modalities (visual, thermal, acoustic, radar, lidar,
radio-frequency) are associated to tracks with a Mahalanobis gate and fused
into persistent 3D tracks with a Tentative → Confirmed → Coasting → Lost
lifecycle (sliding-window M-of-N confirmation, default 3-of-5), using a
selectable filter: Kalman, Extended Kalman (default), Unscented Kalman,
Particle, or IMM (CV + Coordinated-Turn).

**Full design reference:** [docs/SENSOR_FUSION.md](docs/SENSOR_FUSION.md) —
the estimation math, the per-modality coordinate contract, data association,
tuning, validation, and a frank list of known limitations.

---

## Architecture

<p align="center">
  <img alt="CREBAIN system architecture: React frontend over Tauri IPC to the Rust backend (inference, sensor fusion, read-only Zenoh and rosbridge transports, feature-gated Galadriel producer), external Gazebo/ROS/Galadriel systems, and the unwired inert plant foundation with no authority path" src="assets/diagrams/system-architecture.svg" width="820">
</p>

The frontend captures camera-feed frames from WebGL render targets. It sends
the frames to the Rust detection backend through Tauri inter-process
communication (IPC) and overlays the results. Sensor measurements enter the
Rust fusion engine through the same interface. Gazebo runs headless and
provides physics and sensor data. Three.js provides the user-visible
rendering. Design rationale, transport trade-offs, the
backend-selection logic, and the annotated directory map live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```text
crebain/
├── src/               # React frontend (components, context, hooks, ros,
│                      #   detection, integrations, physics, simulation,
│                      #   state, neuro, lib)
├── src-tauri/         # Rust backend (inference, transport, sensor fusion,
│                      #   native CoreML/ONNX, NCP bridge + Galadriel producer)
│   └── crates/plant-authority/  # Inert headless plant foundation (unwired)
├── ros/               # ROS 1 reference package (crebain_msgs + launch files)
├── docs/              # Design docs, contracts, release gates
├── scripts/           # Version-coherence, bundle-size, perf-smoke checks
├── public/            # Static assets (models, splat samples)
└── flake.nix          # Nix dev shells and build configuration
```

---

## ROS and Gazebo simulation

```bash
# Terminal 1: Start Gazebo Classic and rosbridge with the packaged launch.
# See ros/README.md. gui:=false is the documented headless mode.
roslaunch crebain_msgs simulation.launch gui:=false

# ...or run your own world headless with a standalone rosbridge:
#   gzserver your_world.sdf
#   roslaunch rosbridge_server rosbridge_websocket.launch

# Terminal 2: CREBAIN development build — select the development-only
# rosbridge telemetry adapter and connect to ws://localhost:9090
bun run tauri:dev
```

Packaged builds expose only the native read-only telemetry path and default to
**Zenoh (Tauri)**.

- **Development rosbridge adapter.** Vite development builds may additionally
  select a TypeScript rosbridge WebSocket adapter for telemetry experiments.
  Production aliases that adapter to a network-free fail-closed stub. The
  packaged Content Security Policy (CSP) does not permit rosbridge sockets.
- **Native rosbridge fallback.** The native Rust rosbridge fallback selected
  with `CREBAIN_ZENOH=0` is also subscription-only.
- **No command path.** None of these ROS telemetry paths can publish
  pose/twist/setpoints, call ROS/Gazebo services, spawn models, or change
  MAVROS modes/missions.
- **Galadriel evidence.** A separate binary compiled with `ncp` may put strict
  evidence on `galadriel-pid` and `galadriel-monitor` named-perception keys.
  It may do so only when `CREBAIN_GALADRIEL_ENABLE=1` and every deployment pin
  validates. It is not a generic ROS/action/flight control unit (FCU)
  publisher.
- **Guidance preview.** The remaining guidance/interception calculation is a
  disabled-by-default, local `NoAuthority` preview. Disabling it,
  disconnecting, or toggling simulation off aborts and discards the preview
  generation.

Every packaged frontend build verifies the resolved Vite module graph, excludes
the development adapter, and content-hashes and scans every finalized JavaScript
chunk before it can succeed. Bounded renderer asset downloads remain confined
to the documented relative, HTTPS, and HTTP-loopback source policy. Passive
image URLs do not receive a general HTTPS CSP allowance.

The native Zenoh transport uses CREBAIN's plain-key scheme. Direct
interoperation with an `rmw_zenoh_cpp` ROS 2 graph requires an explicit re-keying
bridge. Topic templates, reference-only message/service definitions and launch
files, and the camera wire contract are documented in
[ros/README.md](ros/README.md).

An optional, off-by-default NCP (Engram) bridge exists behind the Rust `ncp`
feature. Its Tauri commands are not registered in the product runtime, and
there is no always-on CREBAIN↔Engram control loop. The same feature also contains
the separately gated Galadriel evidence producer. Its component wiring does not
prove a deployed Galadriel receiver, TLS/mTLS identities, ACLs, or delivery. See
[docs/NCP_BRIDGE_HANDOFF.md](docs/NCP_BRIDGE_HANDOFF.md) and
[docs/GALADRIEL_PRODUCER.md](docs/GALADRIEL_PRODUCER.md).

### Engram restricted embedding

Engram can embed the Vite interface as a restricted local web tab. The host
must add `engramHost=1`, `hostOrigin`, and `hostNonce` to the entry URL.
`hostOrigin` must be an exact loopback or Tauri origin. The nonce must be a
bounded URL-safe value.

Embedded mode keeps the browser visualization available. It disables these
paths:

- CREBAIN Tauri commands
- native detection, native fusion, and native Zenoh
- the development NCP command harness
- external telemetry and artifact exchange
- drone physics initialization
- simulation, sensor-placement, scene-editing, and deployment controls

View navigation, orbit, focus, grid, and read-only panels remain available.
Invalid host parameters do not restore disabled paths. The restriction remains
latched for the document lifetime after same-document URL changes.

The `engram.host.v1` bridge sends bounded readiness and read-only status. It
accepts only bounded `host.context` messages from the exact parent and origin.
It revokes after more than 32 expected-peer messages in one monotonic
one-second window.
Each loaded frame document must echo a fresh context nonce in its status. A
status from an older document cannot complete the current handshake. The
bridge does not accept commands. It cannot activate NCP or plant control.

Engram continues bounded health challenges after readiness. CREBAIN increments
a heartbeat sequence for each accepted challenge. Engram relocks the frame when
replies stop. CREBAIN also probes a harmless Engram Tauri command. On supported
Tauri targets, the local-window capability policy is the primary boundary. The
probe is an unattested peer report and a diagnostic canary. Browser readiness
proves no Tauri capability denial.

The nonce and challenge correlate one document. They do not authenticate or
attest the CREBAIN process, source revision, or build. Engram blocks this
remote iframe on Linux and Android. Tauri cannot isolate iframe IPC from the
parent window on those targets. CREBAIN accepts only user-agent-trusted
`postMessage` events. The parser copies exact primitive fields into a local
envelope before byte serialization. Browser message cloning occurs before
parsing and is not resource isolation.

The Performance and Sensor Fusion panels start collapsed in embedded mode.
Their standalone defaults remain expanded. The Performance disclosure is a
keyboard-operable button.
The digest-locked vector in
[`integrations/engram/engram.host.v1.vector.json`](integrations/engram/engram.host.v1.vector.json)
binds the exact cross-repository challenge and status exchange.

CREBAIN uses NCP wire `0.8`. This wire is incompatible with the Engram `1.0`
candidate. The embedded interface does not create an NCP closed loop. See
[`integrations/engram/manifest.json`](integrations/engram/manifest.json) for the
machine-readable boundary.

---

## Configuration essentials

| Variable | Purpose |
| -------- | ------- |
| `CREBAIN_MODEL_PATH` | CoreML model path (macOS) |
| `CREBAIN_ONNX_MODEL` | ONNX model path (Linux) |
| `CREBAIN_BACKEND` | Force a backend: `coreml`, `mlx`, `tensorrt`, `cuda`, `onnx` |
| `CREBAIN_ENABLE_EXPERIMENTAL_MLX` | Required gate for any MLX use |
| `CREBAIN_GALADRIEL_ENABLE` | Exact runtime gate (`1`) for a Galadriel producer compiled with `ncp`. Enabled startup also requires the documented registry, configuration, executable, and NCP pins. |
| `CREBAIN_GALADRIEL_EPOCH` | Required operator-provisioned, key-safe process-session identity. The deployment must make it unique for each process lifetime. |

The full environment-variable reference, detection/guidance settings, scene
and asset limits, and the platform matrix are in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Documentation

The full grouped index lives in [docs/README.md](docs/README.md).

| Document | What it covers |
| -------- | -------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design principles, transport trade-offs, backend selection, directory map |
| [docs/SYSTEM_CONTEXT.md](docs/SYSTEM_CONTEXT.md) | Current L0 system reality, controlled claim vocabulary, target L1 chain |
| [docs/COMPLETION_LEVELS.md](docs/COMPLETION_LEVELS.md) | L0-L4 completion-level definitions behind the status labels |
| [docs/SENSOR_FUSION.md](docs/SENSOR_FUSION.md) | Fusion math, coordinate contracts, tuning, known limitations |
| [docs/FUSION_VALIDATION_PROTOCOL.md](docs/FUSION_VALIDATION_PROTOCOL.md) | Preregistered, not-yet-run fusion metrics and experiment protocol |
| [docs/MODEL_CONTRACTS.md](docs/MODEL_CONTRACTS.md) | What a model must prove before its detections are trusted |
| [docs/NATIVE_DETECTOR_BENCHMARK.md](docs/NATIVE_DETECTOR_BENCHMARK.md) | Release-command native detector latency artifact and evidence limits |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Environment variables, settings, scene/asset limits |
| [docs/GALADRIEL_PRODUCER.md](docs/GALADRIEL_PRODUCER.md) | Optional live evidence routes, deployment pins, bounds, and claim limits |
| [docs/CONTROLS.md](docs/CONTROLS.md) | Full keyboard reference |
| [ros/README.md](ros/README.md) | ROS package, topics, launch files, camera wire contract |
| [docs/NCP_BRIDGE_HANDOFF.md](docs/NCP_BRIDGE_HANDOFF.md) | Optional NCP/Engram bridge status and boundaries |
| [integrations/engram/README.md](integrations/engram/README.md) | Restricted host startup, heartbeat, IPC isolation, and authority boundaries |
| [docs/PLANT_CONTRACT_V1.md](docs/PLANT_CONTRACT_V1.md) | Inactive draft command contract, frame corpus, and limits |
| [docs/PLANT_HEALTH_V1.md](docs/PLANT_HEALTH_V1.md) | Inactive typed vehicle-health snapshot and evidence limits |
| [docs/PLANT_FRESHNESS_V1.md](docs/PLANT_FRESHNESS_V1.md) | Inactive profile-bound captured-read health-age classifier |
| [docs/PLANT_SAFE_ACTION_V1.md](docs/PLANT_SAFE_ACTION_V1.md) | Inactive exact-profile safe-action situation-dispatch candidate |
| [docs/PLANT_WATCHDOG_V1.md](docs/PLANT_WATCHDOG_V1.md) | Unwired receipt-anchored active command deadline-monitor candidate |
| [docs/PLANT_APPLY_OBSERVATION_V1.md](docs/PLANT_APPLY_OBSERVATION_V1.md) | Unwired post-health-load single-reference-instant apply-check observation and association limits |
| [docs/RELEASE_ACCEPTANCE.md](docs/RELEASE_ACCEPTANCE.md) | Release-candidate evidence gates |
| [docs/MANUAL_SMOKE_TEST.md](docs/MANUAL_SMOKE_TEST.md) | Manual smoke checklist |
| [docs/RELEASE_EVIDENCE.md](docs/RELEASE_EVIDENCE.md) | Release evidence log |
| [docs/RELEASE_HISTORY.md](docs/RELEASE_HISTORY.md) | Version history and retired release identifiers |
| [docs/NARROWED_GO_0.9.0.md](docs/NARROWED_GO_0.9.0.md) | Exact 0.9 release scope, exclusions, and blockers |
| [docs/CROSS_REPOSITORY_REQUIREMENTS_0.9.0.md](docs/CROSS_REPOSITORY_REQUIREMENTS_0.9.0.md) | Frozen cross-repository requirements for the 0.9 decision |
| [docs/PHASE0_BASELINE.md](docs/PHASE0_BASELINE.md) | Frozen Phase 0 vocabulary, scope, and command-surface baseline |
| [docs/HAZARD_LOG.md](docs/HAZARD_LOG.md) | Tracked hazards and mitigation status |
| [docs/L1_ODD.md](docs/L1_ODD.md) | Draft, unapproved L1 operational design domain limits |
| [docs/BACKLOG.md](docs/BACKLOG.md) | Current engineering backlog |
| [SECURITY.md](SECURITY.md) | Security policy and threat model |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution workflow, prerequisites, validation matrix |
| [SUPPORT.md](SUPPORT.md) | Where to ask questions |
| [AGENTS.md](AGENTS.md) | Repository development instructions and the ASD-STE100-based documentation house style |
| [CLAUDE.md](CLAUDE.md) | Claude entry point for the repository instructions and documentation house style |

---

## Development and validation

Run `bun run dev` for the standalone browser interface. The server binds the
exact `http://127.0.0.1:5173` loopback origin used by the Engram host manifest.
Use `bun run tauri:dev` for the standalone desktop application.

```bash
# Frontend typecheck + lint + format check + Vitest
bun run validate

# Frontend validation + inert plant boundary/frame-corpus/fmt/check/test/clippy/self-check +
# Rust fmt/check/test/clippy, plus bridge/producer clippy and tests with the off-by-default `ncp` feature
bun run validate:all

# Focused checks
bun run check:ncp-coherence
bun run check:phase0-baseline
bun run check:product-profiles
bun run check:ipc-contracts
bun run check:vendor-compat
bun run check:ros-defs
bun run check:plant-boundary
bun run check:plant-frames
bun run test:plant
bun run self-check:plant
bun run check:rust
bun run test:rust
bun run clippy:rust

# Show the native detector benchmark contract; a real run needs an approved
# model, fixture, target profile, and private output path
bun run benchmark:native-detector -- --help
```

`bun run build` includes exact pinned Spark 0.1.10, Rapier 0.19.3, and Three
0.182.0 fail-closed transforms plus the production module-graph/chunk boundary
proof. Spark and Rapier retain their pinned embedded-byte WebAssembly paths.
Three rejects loader network paths while preserving validated bufferView and
canonical PNG/JPEG data-image GLB textures through its local `TextureLoader`
path. `bun run check:production-vendors` binds package/module/payload/AST
shapes, mutation failures, and those local-byte runtimes. It is included in
`validate` and `validate:all`. Tauri uses the same build command before
packaging. Validation does not run the hosted bundle-size, coverage,
feature-gate (`cuda,tensorrt` and `--no-default-features`), CodeQL, or
supply-chain-audit jobs. Release candidates require those hosted gates as
specified in [docs/RELEASE_ACCEPTANCE.md](docs/RELEASE_ACCEPTANCE.md). The
authoritative pass/fail status lives in the
[CI runs](https://github.com/sepahead/crebain/actions/workflows/ci.yml).

The benchmark command creates no repository-approved latency claim by itself.
Its artifact scope, trusted-baseline requirements, declaration limits, and
sharing precautions are defined in
[docs/NATIVE_DETECTOR_BENCHMARK.md](docs/NATIVE_DETECTOR_BENCHMARK.md).

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) (workflow, branch
naming, per-change validation matrix) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Agent-facing build and style notes are
in [AGENTS.md](AGENTS.md).

---

## Status and roadmap

CI document-synchronization tests enforce the verified engineering baseline.
See [CHANGELOG.md](CHANGELOG.md) for the full history.

- [x] Local no-authority guidance-preview tests and reset/hold checks
- [x] End-to-end detection/fusion smoke tests with mocked model outputs
- [x] CI backend alignment to package scripts
- [x] Release acceptance matrix, model contracts, security threat model, and manual smoke checklist
- [x] Executable negative guard tests for native detection, model path, scene path, and transport topic boundaries, including TensorRT build inputs, fusion, Zenoh CDR, and transport payloads
- [x] Component-tested Galadriel producer mechanics: exact opt-in/off-by-default behavior, immutable registry and actual config/executable pins, readiness-only active initialization, frozen envelope routes/codecs, deterministic exact-time fusion ledger, bounded measurement/track domains, upstream/capacity loss degradation, sparse assignment, heartbeat generation, and finite owned-task shutdown

Planned capability work:

- [ ] Hardware-in-the-loop (HIL) testing
- [ ] Real PX4/ArduPilot integration
- [ ] Multi-drone coordination
- [ ] Deployed Zenoh TLS/mTLS identities, certificate policy, exact-route ACLs, and negative topology evidence (secure-mode config loading alone is insufficient)
- [ ] Live Galadriel receiver tap/assembler, registry agreement, payload-size limits, heartbeat-deadline enforcement, restart/loss/reorder/saturation/clock campaigns, wire-visible upstream-loss detail, and receiver-side correlation evidence
- [ ] PID JSONL regular-file enforcement, active archive saturation/drop health, and blocked-writer cleanup beyond the current two-second exit wait
- [ ] Edge deployment (Jetson, Apple Silicon Mac Mini)
- [ ] Recorded flight replay
- [ ] Advisory-only threat-assessment research with no command/authority path

Near-term engineering tasks are tracked in [docs/BACKLOG.md](docs/BACKLOG.md).

---

## Troubleshooting

- **No detections appear** — detection needs the native Tauri app (not the
  browser-only dev server) plus a model you provide (see
  [Model setup](#model-setup)). Check the diagnostics panel for backend
  availability. Make sure that detection is enabled with `Y`.
- **ONNX Runtime load/version error on Linux** — point `ORT_DYLIB_PATH` at a
  compatible `libonnxruntime.so` (the Nix shells pre-set it).
- **ROS panel has no WebSocket option** — packaged builds intentionally expose
  Zenoh telemetry only. In `bun run tauri:dev`, verify rosbridge is listening
  on `ws://localhost:9090` before selecting the development-only adapter.
- **Low FPS on large splats** — press `M` to toggle splat performance mode
  (1.5-million-splat cap).
- **Labels are in German** — This is intentional. See the design note in
  [Using the app](#using-the-app).

---

## Contributing

1. Fork the repository and create a feature branch from `main`.
2. Keep the change focused and document the risk.
3. Run the relevant validation command (`bun run validate` for frontend-only
   changes, `bun run validate:all` otherwise).
4. Open a pull request using the template.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## Citing

CREBAIN 0.9.0 has no DOI or Zenodo record yet. If you use this research-only
release, cite the exact repository commit and the metadata in
[CITATION.cff](CITATION.cff). Use `git rev-parse HEAD` to record the commit
identifier. Do not infer a persistent identifier that has not been assigned.

## Author

CREBAIN 0.9.0 is authored and maintained by **Sepehr Mahmoudian**.

---

## Disclaimer

This software is provided for **research and educational purposes only**.
CREBAIN is a technical demonstration and research platform. It supports studies
of sensor fusion, multi-modal tracking, and autonomous-systems visualization.
The contributors do not endorse or encourage a specific use of this technology.
They assume no liability for actions taken with it. Users are responsible for
compliance with all applicable laws and regulations. These can include aviation
regulations, privacy laws, export controls, and restrictions on autonomous
systems or surveillance technology. By using this software, you accept full
responsibility for your use of it.

---

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in the work by you, as defined in the Apache-2.0
license, shall be dual licensed as above, without any additional terms or
conditions.
