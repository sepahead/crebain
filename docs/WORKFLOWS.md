# Desktop and retained integration workflows

This guide retains detailed desktop setup, models, telemetry, and older integration procedures.
The [project overview](../README.md) introduces the standalone native city environment and the separate local NCP body.
Run commands from the repository root unless a section says otherwise.

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
[docs/MODEL_CONTRACTS.md](../docs/MODEL_CONTRACTS.md) for what a model must
satisfy before its detections are trusted.

### First scene

Sample Gaussian-splat scenes (with download commands and licensing notes) are
listed in [public/splats/README.md](../public/splats/README.md). Drag a scene
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

Essential keys — the full keymap lives in [docs/CONTROLS.md](../docs/CONTROLS.md):

| Key | Action |
| --- | ------ |
| W/A/S/D + Q/E | Fly camera (Shift sprint, Ctrl/Cmd precision) |
| 1 / 2 / 3 | Place static / PTZ / patrol camera |
| Tab | Cycle cameras |
| V | Toggle camera feeds |
| T / Y | Toggle detection panel / detection on-off |
| U | Sensor Fusion panel |
| N | ROS connection panel |
| Esc | Cancel placement / clear selection; in local simulation, disarm all simulated drones |

Scene JSON has a 10 MiB limit. Splat files have a 256 MiB limit. A GLB model
must be a self-contained GLB 2.0 file. It can contain embedded buffers and
PNG or JPEG textures. CREBAIN rejects standalone `.gltf` files and external
resource references. The full enforced limits are in
[docs/CONFIGURATION.md](../docs/CONFIGURATION.md#scene-and-asset-limits).

The interface is German-first by design (camera types: SK = static camera,
PTZ = pan-tilt-zoom, PK = patrol camera) with a project-specific 4-level threat scale (1=minimal, 2=guarded,
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
  [docs/MODEL_CONTRACTS.md](../docs/MODEL_CONTRACTS.md).

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

**Full design reference:** [docs/SENSOR_FUSION.md](../docs/SENSOR_FUSION.md) —
the estimation math, the per-modality coordinate contract, data association,
tuning, validation, and a frank list of known limitations.

---

## Architecture

<p align="center">
  <img alt="CREBAIN current system architecture" src="../assets/diagrams/system-architecture.svg" width="820">
</p>

Text alternative: The React frontend uses Tauri inter-process communication
(IPC) to reach Rust inference, sensor fusion, and read-only telemetry transports.
A feature-gated producer can make local puts to two advisory NCP routes. Those
puts do not prove receiver delivery. The separate plant foundation is inert and
has no vehicle-authority path.

The frontend captures camera-feed frames from WebGL render targets. It sends
the frames to the Rust detection backend through Tauri inter-process
communication (IPC) and overlays the results. Sensor measurements enter the
Rust fusion engine through the same interface. Gazebo runs headless and
provides physics and sensor data. Three.js provides the user-visible
rendering. Design rationale, transport trade-offs, the
backend-selection logic, and the annotated directory map live in
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

```text
crebain/
├── src/               # React frontend (components, context, hooks, ros,
│                      #   detection, integrations, physics, simulation,
│                      #   state, neuro, lib)
├── src-tauri/         # Rust backend (inference, transport, sensor fusion,
│                      #   native CoreML/ONNX, NCP bridge + Galadriel producer)
│   ├── crates/managed-simulation/ # Host API 2.0 simulator-only runtime
│   ├── crates/ncp-headless/       # Opt-in wire-0.8 perception runner
│   └── crates/plant-authority/    # Inert plant foundation (unwired)
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
- **Exact native subscription identity.** Every typed topic uses a
  renderer-issued canonical positive-u64 token. Non-camera events carry that
  token and the transport generation in a closed envelope. Camera delivery,
  topic replacement, and unsubscribe use the same exact ownership rule.
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
[ros/README.md](../ros/README.md).

An optional, off-by-default native NCP action adapter exists behind the Rust
`ncp` feature. Its Tauri commands are not registered in the product runtime, and
there is no always-on CREBAIN↔Engram control loop. A separate
dependency-isolated workspace package supplies the external
`crebain-ncp-headless` perception process. It has explicit `self-check`,
no-Zenoh `validate`, and networked `run` commands. `validate` checks the bounded
strict client configuration and does not open a Zenoh session. `run` accepts only the strict
secure-client configuration posture and requires `NCP_ZENOH_CONFIG` plus a
compatible NCP wire-0.8 responder. This posture does not attest TLS, an ACL, or
peer identity. The
default `engram/ncp` realm is only a routing default. It does not make the
current Engram native wire-1.0 candidate compatible.
This wire-0.8 path has no translator or NCP action loop.
The separate managed simulation runtime does not use NCP.
The newer local NCP body has its own [contract](NATIVE_NCP_SIMULATION.md).

The same feature contains the separately gated Galadriel evidence producer. Its
component wiring does not prove a deployed Galadriel receiver, TLS/mTLS
identities, ACLs, or delivery. See
[docs/NCP_BRIDGE_HANDOFF.md](../docs/NCP_BRIDGE_HANDOFF.md) and
[docs/GALADRIEL_PRODUCER.md](../docs/GALADRIEL_PRODUCER.md).

### Drone information-decomposition fixture

CREBAIN also generates a deterministic research fixture for an offline
Galadriel study. It is not emitted by the live producer. The fixture binds
external drone truth, ordered pre-fusion visual/radar/acoustic symbols, one
fresh fusion episode per row, and a complete frozen-prior receipt.

<p align="center">
  <img alt="Drone truth-to-PID evidence chain with a Haldir control-authority firewall" src="../assets/diagrams/drone-mgw-study.svg" width="1000">
</p>

Text alternative: External ENU truth defines horizontal and volumetric
incursion targets before fusion. Three ordered sensor symbols enter a
source-derived row with an exact receipt. Galadriel can evaluate categorical
MGW shared-exclusions PID2 and PID3 offline. KSG and continuous Ehrlich PID must
abstain on this repeated atomic law. Every result remains advisory and cannot
authorize Haldir or the plant.

See the full equations, method-eligibility matrix, twenty-lens review, hostile
controls, and evidence ladder in
[docs/DRONE_MGW_PID_STUDY.md](../docs/DRONE_MGW_PID_STUDY.md).

### Engram managed simulation

Engram Host API 2.0 can launch `crebain-managed-simulation` through inherited private pipes.
The runtime supports one to three sorted drone identifiers.

The package retains the native CREBAIN v1 operations.
It also binds the exact standard v3 schema pairs to project-owned CREBAIN v3 operations.
Engram discovers each standard role from its schema pair.
The standard surface needs no CREBAIN-specific host adapter.

Each tick accepts per-drone acceleration intents, sensor offsets, and deterministic fault codes.
It returns simulator state, fused observations, bounded actuator output, and exact digest receipts.

The standard surface returns fused ENU position and velocity at width six.
It accepts ENU acceleration at width three.
Its sealed profile fixes the clock, causality, vector components, units, and lane mapping.
The host owns references, gains, damping, and neural control axes.
Its declared `step_count` is an exact completion plan.

Tracked operational inputs cover one, two, and three drones.
Each drone maps to six signed NEST populations across three acceleration axes.
The release proof joins the installed bundle, seal, package generation, and store observation.
It also joins one clean-main observed build and its package-stage receipt.
The build receipt binds exact Git inputs, Rust tools, arguments, target, and output bytes.
Fresh Rust dep-info must match its embedded-source roster.
It is not a signature or reproducibility claim.

The sealed profile emits one recoverable sensor-unavailable event.
It affects sorted channel ordinal one at logical step three.

A standard safe hold admits the exact configured zero action.
It does not create a simulator fault or latch the next step.

Every actuator label is simulator-only.
The runtime has no Tauri, network, artifact, NCP, or plant dependency.
It does not qualify any NCP 1.0 role.

See [`integrations/engram/managed-simulation/README.md`](../integrations/engram/managed-simulation/README.md) for the exact contract and gates.

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
[`integrations/engram/engram.host.v1.vector.json`](../integrations/engram/engram.host.v1.vector.json)
binds the exact cross-repository challenge and status exchange.

The retained TypeScript and feature-gated native bridge pin NCP `v0.8.0`, with wire `0.8`.
Their historical `1.0.0-rc.1` comparison uses wire `1.0` and compact proto contract hash `163acc57d8a62b66`.
These surfaces are incompatible and have no translator.
The embedded interface creates no NCP control loop.
Its [manifest](../integrations/engram/manifest.json) describes that retained boundary.

The newer [local NCP body](NATIVE_NCP_SIMULATION.md) uses a separate package and immutable public `ncp-local` pin.
That source component does not migrate the retained bridge or qualify an installed ecosystem release.

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
[docs/CONFIGURATION.md](../docs/CONFIGURATION.md).

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
