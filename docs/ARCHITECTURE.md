# CREBAIN Architecture

Design rationale and system structure for CREBAIN. For the sensor-fusion
deep-dive see [SENSOR_FUSION.md](SENSOR_FUSION.md); for model requirements see
[MODEL_CONTRACTS.md](MODEL_CONTRACTS.md); for runtime settings and limits see
[CONFIGURATION.md](CONFIGURATION.md).

## System overview

```mermaid
graph TB
    subgraph Frontend["Frontend (React 19 + TypeScript)"]
        ThreeJS["SparkJS/Three.js<br/>(3D Scene)"]
        CameraFeeds["Camera Feeds<br/>(Overlays)"]
        FusionUI["Sensor Fusion UI<br/>(Tracks)"]
        ROSControls["ROS Telemetry<br/>(Bridge)"]
    end

    subgraph IPC["Tauri IPC"]
        Invoke["invoke/events"]
    end

    subgraph Backend["Rust Backend (Tauri)"]
        Inference["Inference<br/>Abstraction Layer"]
        SensorFusion["Sensor Fusion<br/>Engine"]
        Zenoh["Transport<br/>(Zenoh)"]
        ROSBridge["ROS Telemetry Fallback<br/>(WebSocket, read-only)"]

        subgraph Platform["Platform Abstraction"]
            macOS["macOS<br/>CoreML default<br/>MLX experimental<br/>Metal GPU<br/>Neural Engine"]
            Linux["Linux (NixOS)<br/>CUDA / TensorRT<br/>NVIDIA GPU<br/>Vulkan"]
        end
    end

    subgraph PlantFoundation["Separate headless package (L0, inert)"]
        Plantd["crebain-plantd<br/>Lifecycle + bounded channels<br/>Self-check only"]
    end

    subgraph External["External Systems"]
        Gazebo["Gazebo (Headless)<br/>Physics Engine<br/>Sensor Plugins"]
        Hardware["Real Hardware<br/>PX4/ArduPilot<br/>Cameras & Sensors"]
    end

    ThreeJS --> Invoke
    CameraFeeds --> Invoke
    FusionUI --> Invoke
    ROSControls --> Invoke

    Invoke --> Inference
    Invoke --> SensorFusion
    Invoke --> Zenoh
    Invoke --> ROSBridge

    Inference --> Platform

    Zenoh --> External
    ROSBridge --> External
```

### Inert headless plant foundation

`src-tauri/crates/plant-authority` is a separate dependency-free workspace
package with the `crebain-plantd` binary. It does not link `crebain_lib`, Tauri,
the renderer, inference, fusion, simulation, the dormant NCP module, or the
generic telemetry transports. Its only executable mode is `--self-check`.

The package establishes the nine explicit lifecycle states, generation-guarded
events, capacity-one latest-value paths, bounded reject-new lifecycle ingress,
bounded drop-oldest evidence with loss accounting, and a separate sticky
first-cause safety latch. The current adapter is deliberately inert and exposes
no action operation.

This is a component foundation, not an authority chain. It has no authenticated
ingress, NCP UAV profile, trusted vehicle-health snapshot, monotonic command
watchdog, apply-time governor, ODD safe-action table, PX4/FCU adapter, deadline
measurement, or staged live evidence. CREBAIN therefore remains L0.

## Design principles

### 1. Measurement-driven communication

**Problem**: Robotics UIs often mix control, perception, telemetry, and
diagnostics data with very different latency, throughput, and debuggability
needs.

**Solution**: Keep the product transport surface read-only, use the native
Zenoh-oriented path for packaged builds, reserve rosbridge for explicit
development/native telemetry fallback, and measure end-to-end latency in the
target deployment before making performance claims.

The three paths and when to use them:

- **rosbridge (JSON over WebSocket)** — a telemetry-only fallback. The
  TypeScript client is selectable only in Vite development; production builds
  substitute a network-free stub and remove rosbridge WebSocket origins from
  the CSP. Every build records the resolved project-module graph and hashes and
  scans the finalized JavaScript chunks, so `build --mode test` cannot select
  the development adapter. The native Rust fallback (`CREBAIN_ZENOH=0`) is also
  subscription-only. JSON parsing overhead applies on every message.
- **Zenoh-oriented transport (native Rust)** — the packaged-build default, with
  a fixed typed read surface (raw/compressed camera, CameraInfo, IMU,
  PoseStamped, ModelStates). It has no generic publish, setpoint, service, or
  Gazebo mutation method. It speaks CREBAIN's own plain-key topic scheme — direct interop
  with an `rmw_zenoh_cpp` ROS 2 graph (which keys topics as
  `<domain>/<topic>/<type>/<hash>`) requires an explicit re-keying bridge.
- **Tauri commands/events** — small frontend/backend notifications only.
  Tauri's own documentation notes that events are JSON and are not intended for
  low-latency or high-throughput streaming.

Latency and throughput for either transport depend on topology, payload path,
and hardware; benchmark in your deployment before relying on numbers.

Renderer network access is deny-by-default in the source inventory: WebSocket
code is confined to the explicitly development-only adapter, while ordinary
asset downloads are confined to the bounded fetch module and the documented
same-origin/HTTPS/HTTP-loopback source classes. Passive remote image URLs are
not allowed by the packaged CSP.

`GuidanceController` and `InterceptionSystem` remain only as local visualization
and proposal machinery. Preview generation is disabled by default, exposes
`NoAuthority`/`Hold`, and accepts no transport object. Disabling preview,
disconnecting telemetry, changing transport, or toggling simulation off aborts
the active singleton missions and clears trajectories, proposals, and
controller snapshots so reconnection cannot resume an earlier generation.

```mermaid
flowchart TB
    subgraph Tauri["TAURI APP"]
        Frontend["Frontend<br/>(React/Three.js)"]

        subgraph Transport["Transport Layer"]
            RustZenoh["Rust Transport<br/>(zenoh-rs)"]
            TSBridge["TypeScript ROSBridge<br/>(development telemetry only)"]
        end

        Frontend -->|"Tauri commands/events<br/>(JSON IPC)"| RustZenoh
        Frontend -.->|"Vite development only<br/>(JSON telemetry)"| TSBridge
    end

    subgraph ROS["GAZEBO / ROS (Headless)"]
        Peers["Zenoh peers<br/>(CREBAIN key scheme)"]
        Camera["Camera Plugins"]
        Physics["Physics Engine"]
        MAVROS["MAVROS Bridge"]
    end

    RustZenoh -->|"Zenoh Protocol<br/>(plain-topic keys)"| ROS
    TSBridge -->|"WebSocket<br/>(TCP port 9090)"| ROS
```

### 2. Platform-native inference

**Problem**: Different deployment targets expose different inference
accelerators, model formats, and runtime constraints.

**Solution**: Prefer the validated backend for the host platform, report
backend availability in diagnostics, and keep experimental backends opt-in
until their behavior is measured and complete.

```rust
// Automatic backend selection (simplified from src-tauri/src/inference/mod.rs)
pub fn create_detector() -> Result<Box<dyn Detector>> {
    // Explicit override first: CREBAIN_BACKEND=coreml|mlx|onnx|cuda|tensorrt
    // (mlx additionally requires CREBAIN_ENABLE_EXPERIMENTAL_MLX=1 — the
    // explicit override cannot bypass the experimental gate)
    if let Ok(backend) = std::env::var("CREBAIN_BACKEND") {
        return create_detector_with_backend(backend.parse()?);
    }
    #[cfg(target_os = "macos")]
    {
        // Apple Silicon: CoreML > experimental MLX (opt-in) > ONNX
        if coreml::is_available() { /* CoreML detector */ }
        if experimental_mlx_enabled() && mlx::is_available() { /* MLX detector */ }
    }
    #[cfg(target_os = "linux")]
    {
        // NVIDIA: TensorRT > CUDA > ONNX
        if tensorrt::is_available() { /* TensorRT detector */ }
        if cuda::is_available() { /* CUDA detector */ }
    }
    // Universal fallback: ONNX Runtime — prefers accelerated execution
    // providers where available (TensorRT/CUDA on Linux, CoreML on macOS),
    // with CPU as the last resort.
}
```

Notes:

- CoreML is Apple's supported framework for integrating machine-learning models
  into Apple-platform apps.
- The "MLX" backend is implemented with Candle (Metal GPU backend) providing
  MLX-style tensor operations over a YOLOv8 safetensors path. It stays
  experimental and opt-in until an approved model contract, fixture detections,
  and target-hardware benchmarks are recorded.
- TensorRT is NVIDIA's SDK for optimizing inference engines on NVIDIA GPUs.
- ONNX Runtime provides the cross-platform fallback and registers accelerated
  execution providers when present.

### Detection flow

```mermaid
flowchart TB
    CameraViews["Camera Views<br/>(CrebainViewer)"]

    subgraph Capture["Frame Capture"]
        WebGL["WebGL RenderTarget"]
        ReadPixels["readPixels()"]
        RGBA["RGBA Buffer"]
        WebGL --> ReadPixels --> RGBA
    end

    subgraph Backend["Rust Backend: create_detector()"]
        Preprocess["Preprocess<br/>(resize 640×640, normalize)"]
        Inference["Inference<br/>(GPU/Neural Engine)"]
        Postprocess["Postprocess<br/>(NMS, filter confidence)"]

        Preprocess --> Inference --> Postprocess
    end

    subgraph Overlay["Detection Overlay (Canvas 2D)"]
        BBox["Bounding Boxes"]
        Threat["Threat Level Coloring"]
        TrackID["Track IDs"]
    end

    CameraViews --> Capture
    Capture -->|"Tauri IPC (invoke)"| Backend
    Backend -->|"JSON Detections"| Overlay
```

Performance depends on hardware, model format, model size, runtime provider,
image size, and batching. Treat any latency target as invalid until reproduced
through the native Tauri path on deployment hardware with the exact model
digest, thresholds, fixture frames, and invocation recorded.

### 3. Headless simulation, rich visualization

**Problem**: Gazebo's GUI competes for GPU resources and does not integrate
with custom UIs.

**Solution**: Run Gazebo headless — physics, sensor data generation, and camera
image rendering only — and render everything user-facing (tactical map, drone
icons, trajectories, detection overlays, threat indicators) in SparkJS/Three.js,
where the app has full control over the interactive UI.

### 4. Sim2Real awareness

**Problem**: Simulated sensor data does not transfer perfectly to real
hardware.

**Solution**: Use simulation for logic testing, not perception training.

| Use Gazebo For             | Do Not Use Gazebo For          |
| -------------------------- | ------------------------------ |
| UI/UX development          | Final detection model training |
| Integration testing        | Control loop tuning            |
| Mission state machines     | Aerodynamic performance        |
| Multi-drone coordination   | Real sensor noise modeling     |
| Safe failure mode testing  | Production deployment          |

### 5. Reproducible builds

**Problem**: "Works on my machine" — different CUDA versions, missing
dependencies.

**Solution**: A Nix flake provides pinned development shells:

```bash
nix develop            # default dev shell
nix develop .#cuda     # force the CUDA/TensorRT shell (NixOS + NVIDIA)
nix develop .#cpu-only # Linux shell without CUDA
```

Honest caveats: the flake's CUDA auto-detection probes host paths
(`/dev/nvidia0`, …) that pure flake evaluation cannot see, so plain
`nix develop` only auto-detects CUDA under `--impure` — NixOS CUDA users should
use `nix develop .#cuda` directly. `nix build` currently builds only the Rust
backend crate (no frontend build, no Tauri bundle) and is not exercised in CI
(the Nix workflow runs `nix flake check --no-build`). The Linux shells pre-set
`ORT_DYLIB_PATH` (and `ORT_SKIP_DOWNLOAD=1`) to the nixpkgs
`libonnxruntime.so`; override `ORT_DYLIB_PATH` if that version mismatches.

## Directory map

Key files, not an exhaustive listing.

### Frontend (`src/`)

```
src/
├── components/
│   ├── CrebainViewer.tsx      # Main 3D viewer (scene, cameras, feeds, splats)
│   ├── DetectionOverlay.tsx   # Bounding box rendering
│   └── *Panel.tsx             # Draggable UI panels
│
├── hooks/
│   ├── useGazeboDrones.ts     # Drone state from ROS (CircularBuffer, memoized)
│   ├── useGazeboSimulation.ts # Telemetry + disabled-by-default local preview
│   ├── useDroneController.ts  # Local drone spawning, physics loop, keyboard flight
│   └── useDraggable.ts        # Shared panel drag logic
│
├── ros/
│   ├── ROSBridge.ts           # Development-only read-only WebSocket client
│   ├── ROSBridgeDisabled.ts   # Network-free packaged-build replacement
│   ├── TelemetryBridge.ts     # Narrow read-only frontend interface
│   ├── ZenohBridge.ts         # Native read-only Zenoh transport adapter
│   ├── ROSCameraStream.ts     # Camera frame decoding
│   ├── GuidanceController.ts  # Local NoAuthority proposal preview
│   ├── TransformManager.ts    # TF tree with caching
│   └── useROSSensors.ts       # Multi-modal sensor fusion integration
│
├── detection/                 # Shared detection types + browser fusion engine
├── physics/                   # Drone physics simulation (120 Hz)
├── simulation/                # Interception system
├── state/                     # Scene serialization/persistence
├── neuro/                     # Dormant NCP TypeScript glue (version guard)
└── lib/                       # Utilities (CircularBuffer, mathUtils, shortcuts, logger)
```

### Backend (`src-tauri/src/`)

```
src-tauri/src/
├── lib.rs                # Tauri commands (IPC entry points)
├── main.rs               # Native app entry
│
├── coreml.rs             # macOS CoreML/Vision FFI (native detect path)
├── onnx_detector.rs      # Global ONNX Runtime detector singleton
├── sensor_fusion.rs      # KF/EKF/UKF/PF/IMM filters
├── pid_observation.rs    # Innovation-record (JSONL) observation support
│
├── common/               # Shared detection, NMS, YOLO, error, path utils
│
├── inference/            # ML abstraction layer (Detector trait + backends)
│   ├── mod.rs            # Detector trait + factory
│   ├── coreml.rs         # CoreML Detector adapter (delegates to ../coreml.rs)
│   ├── mlx.rs            # Experimental Candle-on-Metal backend ("MLX")
│   ├── cuda.rs           # Linux CUDA backend
│   ├── tensorrt.rs       # Linux TensorRT backend
│   └── onnx.rs           # Cross-platform fallback
│
├── transport/            # Communication layer
│   ├── mod.rs            # Telemetry-only Transport trait + types
│   ├── zenoh.rs          # Read-only Zenoh implementation
│   ├── rosbridge.rs      # Read-only rosbridge WebSocket fallback
│   └── commands.rs       # Lifecycle + typed subscription Tauri commands
│
└── ncp/                  # NCP (Engram) client — off-by-default `ncp` feature
```

The native macOS CoreML/Vision bridge is implemented directly in
`src-tauri/src/coreml.rs`; there is no separately built Swift package or
bundled inference sidecar. AGENTS.md carries the contributor-facing
architecture notes and performance guidelines for the trees above.
