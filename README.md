# CREBAIN

**Adaptive Response & Awareness System (ARAS)**

*DE: Adaptives Reaktions- und Aufklärungssystem (ARAS)*

**Version:** 0.4.0

[![CI](https://github.com/sepahead/crebain/actions/workflows/ci.yml/badge.svg)](https://github.com/sepahead/crebain/actions/workflows/ci.yml)
[![CodeQL](https://github.com/sepahead/crebain/actions/workflows/codeql.yml/badge.svg)](https://github.com/sepahead/crebain/actions/workflows/codeql.yml)
[![Supply chain audit](https://github.com/sepahead/crebain/actions/workflows/audit.yml/badge.svg)](https://github.com/sepahead/crebain/actions/workflows/audit.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-blue.svg)](#license)

<p align="center">
  <img src="public/crebain-logo.png" alt="CREBAIN Logo" width="120" />
</p>

A research-oriented tactical visualization and autonomy prototype with 3D scene rendering, multi-camera surveillance, ML-assisted detection, multi-modal sensor fusion, drone physics simulation, and ROS/Gazebo integration. Built with Tauri 2, React 19, SparkJS/Three.js, Rust, and optional platform-native inference backends.

---

## Table of Contents

- [Features](#features)
- [Architecture Overview](#architecture-overview)
- [Design Philosophy](#design-philosophy)
- [Technology Stack](#technology-stack)
- [Installation](#installation)
  - [macOS (Apple Silicon)](#macos-apple-silicon)
  - [NixOS (NVIDIA CUDA)](#nixos-nvidia-cuda)
- [Usage](#usage)
- [Keyboard Controls](#keyboard-controls)
- [System Architecture](#system-architecture)
  - [Frontend Architecture](#frontend-architecture)
  - [Backend Architecture](#backend-architecture)
  - [Communication Layer](#communication-layer)
- [ML Inference Pipeline](#ml-inference-pipeline)
- [Sensor Fusion System](#sensor-fusion-system)
- [ROS-Gazebo Integration](#ros-gazebo-integration)
- [Communication Protocols](#communication-protocols)
- [Cross-Platform Support](#cross-platform-support)
- [Performance Optimizations](#performance-optimizations)
- [Evidence and Sources](#evidence-and-sources)
- [Configuration](#configuration)
- [Project Structure](#project-structure)
- [Validation](#validation)
- [Development Roadmap](#development-roadmap)
- [Current Engineering Backlog](#current-engineering-backlog)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## Features

### Core Capabilities

| Capability | Description | Status |
|------------|-------------|--------|
| **3D Visualization** | Gaussian Splatting + self-contained GLB models via Three.js | Prototype |
| **Multi-Camera Surveillance** | Up to 4 simultaneous camera feeds with PTZ control | Prototype |
| **ML Detection** | Object detection pipeline with CoreML/ONNX paths and experimental backends | Prototype |
| **Sensor Fusion** | 5 filter algorithms (KF/EKF/UKF/PF/IMM) for multi-modal tracking | Prototype |
| **Drone Physics** | 120Hz quadcopter aerodynamics simulation | In Progress |
| **ROS Integration** | rosbridge WebSocket + Zenoh-oriented transport paths | In Progress |
| **Cross-Platform** | macOS (Apple Silicon) + NixOS (CUDA) | In Progress |

### 3D Visualization
- **Gaussian Splatting**: Load and view 3D Gaussian Splat scenes (.spz, .ply, .splat, .ksplat)
- **Self-contained GLB support**: Import GLB 2.0 models whose buffers and PNG/JPEG textures are embedded; standalone `.gltf` and external-resource references are rejected
- **Rendering**: Three.js-based rendering; WebGPU/WebGL behavior depends on runtime support and renderer configuration
- **First-Person Navigation**: WASD movement, Q/E for vertical, Shift to sprint
- **Drone Visualization**: Live 3D drone models with rotor animation

### Multi-Camera Surveillance System
- **Camera Types**:
  - `SK` (Statische Kamera): Fixed surveillance position
  - `PTZ` (Pan-Tilt-Zoom): Full PTZ control with sliders
  - `PK` (Patrouillenkamera): Automated waypoint patrol
- **Live Feeds**: Up to 4 camera feed thumbnails; feeds refresh on an 83 ms tick (~12 Hz) rendered round-robin across active cameras, with an adaptive frame-budget governor that stretches the interval under load
- **Feed Export**: Download individual camera captures as PNG
- **Detection Overlay**: Bounding boxes on camera feeds
- **Camera Management**: Place, rename, and remove cameras via UI

### ML Detection Pipeline
- **Platform-Native Acceleration**:
  - macOS: CoreML by default; MLX is experimental, opt-in, and implements a YOLOv8 safetensors forward/postprocess path that still requires external model-contract validation before release claims
  - Linux: CUDA / TensorRT (NVIDIA GPU)
  - Fallback: ONNX Runtime (CPU)
- **YOLO-Family Models**: The shared native ONNX/TensorRT postprocessor currently accepts YOLOv8 COCO-80 output shaped `[1,84,N]` or `[1,N,84]`; model weights are not shipped in this repository
- **Detection Classes** (tactical mapping):
  - `drone` - project-specific high-priority class
  - `bird` - environmental
  - `aircraft` - potentially friendly
  - `helicopter` - potentially friendly
  - `unknown` - requires analysis

The five tactical labels are a downstream application taxonomy, not the native
model tensor contract. A five-class exporter such as Manwe's `[1,9,N]` output is
not drop-in compatible: it requires an explicit adapter, class map, and golden
fixture coverage before it can be selected as a native backend. See
[the model contract](docs/MODEL_CONTRACTS.md).

### Advanced Sensor Fusion

| Algorithm | Use Case | Notes |
|-----------|----------|-------|
| **Kalman Filter (KF)** | Linear constant-velocity tracking | Baseline linear filter |
| **Extended Kalman Filter (EKF)** | Non-linear with linearization | Uses local linearization |
| **Unscented Kalman Filter (UKF)** | Highly non-linear systems | Avoids explicit Jacobian calculation |
| **Particle Filter (PF)** | Multi-modal distributions | Sampling-based approximation |
| **IMM** | Maneuvering targets | CV + Coordinated-Turn model bank mixed via a Markov chain |

Multi-modal measurements (visual, thermal, acoustic, radar, lidar, RF) are
associated to tracks with a Mahalanobis gate and fused into persistent 3D tracks
with a Tentative → Confirmed → Coasting → Lost lifecycle (sliding-window M-of-N
confirmation, default 3-of-5). See
**[docs/SENSOR_FUSION.md](docs/SENSOR_FUSION.md)** for the full design: the math, the
per-modality coordinate contract, tuning, and known limitations.

### UI/UX
- **Classification UI**: VS-NfD-style label for research UI context; this is not an accreditation claim
- **Threat Level Indicators**: Project-specific 4-level system (1=minimal, 2=guarded, 3=elevated, 4=severe)
- **Austere UI Aesthetic**: Grayscale with tactical color meaning only
- **German Localization**: German-first interface labels
- **Draggable Panels**: All panels can be repositioned with edge snapping
- **Responsive Design**: All text uses em-based scaling for consistency

---

## Architecture Overview

```mermaid
graph TB
    subgraph Frontend["Frontend (React 19 + TypeScript)"]
        ThreeJS["SparkJS/Three.js<br/>(3D Scene)"]
        CameraFeeds["Camera Feeds<br/>(Overlays)"]
        FusionUI["Sensor Fusion UI<br/>(Tracks)"]
        ROSControls["ROS Controls<br/>(Bridge)"]
    end

    subgraph IPC["Tauri IPC"]
        Invoke["invoke/events"]
    end

    subgraph Backend["Rust Backend (Tauri)"]
        Inference["Inference<br/>Abstraction Layer"]
        SensorFusion["Sensor Fusion<br/>Engine"]
        Zenoh["Transport<br/>(Zenoh)"]
        ROSBridge["ROS Bridge<br/>(WebSocket)"]
        
        subgraph Platform["Platform Abstraction"]
            macOS["macOS<br/>CoreML default<br/>MLX experimental<br/>Metal GPU<br/>Neural Engine"]
            Linux["Linux (NixOS)<br/>CUDA / TensorRT<br/>NVIDIA GPU<br/>Vulkan"]
        end
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

---

## Design Philosophy

### 1. Measurement-Driven Communication Architecture

**Problem**: Robotics UIs often mix control, perception, telemetry, and diagnostics data with very different latency, throughput, and debuggability needs.

**Solution**: Use rosbridge where dynamic JSON/WebSocket integration is useful, use Zenoh-oriented transport paths for typed robotics data where available, and measure end-to-end latency in the target deployment before making performance claims.

```mermaid
flowchart LR
    subgraph Zenoh["Zenoh-oriented transport<br/>(pub/sub/query data model)"]
        Z1["Camera Streams"]
        Z2["Point Clouds"]
        Z3["IMU @ 200Hz"]
        Z4["Control Commands"]
    end

    subgraph ROS["rosbridge<br/>(JSON over WebSocket)"]
        R1["Sensor Detections"]
        R2["TF Transforms"]
        R3["MAVROS State"]
        R4["Service Calls"]
    end

    Sensors["Sensors"] --> Zenoh
    Sensors --> ROS
    
    Zenoh --> App["CREBAIN App"]
    ROS --> App
```

**Zenoh-oriented transport**: Use for typed robotics data and deployments where its pub/sub/query model fits the system design.

**rosbridge**: Use for flexible ROS integration, diagnostics, and JavaScript/WebSocket clients.

**Tauri events**: Use for small frontend/backend notifications. Tauri’s own documentation notes that events are JSON and are not intended for low-latency or high-throughput streaming; use measured alternatives before treating an event path as a high-bandwidth data plane.

### 2. Platform-Native Performance

**Problem**: Different deployment targets expose different inference accelerators, model formats, and runtime constraints.

**Solution**: Prefer the validated backend for the host platform, report backend availability in diagnostics, and keep experimental backends opt-in until their behavior is measured and complete.

```rust
// Automatic backend selection (simplified from src-tauri/src/inference/mod.rs)
pub fn create_detector() -> Result<Box<dyn Detector>> {
    // Explicit override first: CREBAIN_BACKEND=coreml|mlx|onnx|cuda|tensorrt
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
    // Universal fallback: ONNX Runtime (CPU)
}
```

**Justification**:
- CoreML is Apple’s supported framework for integrating machine-learning models into Apple-platform apps
- MLX stays experimental and opt-in until an approved safetensors model contract, fixture detections, and target-hardware benchmarks are recorded
- TensorRT is NVIDIA’s SDK for optimizing inference engines on NVIDIA GPUs
- ONNX Runtime provides a cross-platform inference fallback and supports multiple hardware/OS targets

### 3. Headless Simulation, Rich Visualization

**Problem**: Gazebo's GUI competes for GPU resources and does not integrate with custom UIs.

**Solution**: Run Gazebo headless; render everything in SparkJS/Three.js.

```mermaid
flowchart TB
    subgraph Gazebo["Gazebo (Headless)"]
        G1["❌ No GUI Rendering"]
        G2["✅ Physics Simulation"]
        G3["✅ Sensor Data Generation"]
        G4["✅ Camera Image Rendering"]
    end

    subgraph ThreeJS["Three.js / SparkJS"]
        T1["✅ 3D Tactical Map"]
        T2["✅ Drone Position Icons"]
        T3["✅ Trajectory Visualization"]
        T4["✅ Detection Overlays"]
        T5["✅ Threat Indicators"]
        T6["✅ User Interaction"]
    end

    G4 -->|"Stream to Frontend"| T4
    G2 -->|"Position Data"| T2
    G3 -->|"Sensor Data"| T5
```

**Gazebo**: GPU not wasted on 3D viewport - focused on physics and sensors  
**Three.js**: Full control over UX with 60fps interactive UI

### 4. Sim2Real Awareness

**Problem**: Simulated sensor data does not transfer perfectly to real hardware.

**Solution**: Use simulation for logic testing, not perception training.

| Use Gazebo For | Do Not Use Gazebo For |
|----------------|---------------------|
| UI/UX development | Final detection model training |
| Integration testing | Control loop tuning |
| Mission state machines | Aerodynamic performance |
| Multi-drone coordination | Real sensor noise modeling |
| Safe failure mode testing | Production deployment |

### 5. Reproducible Builds

**Problem**: "Works on my machine" - different CUDA versions, missing dependencies.

**Solution**: Nix flake for hermetic, reproducible builds across platforms.

```bash
# Same command works on macOS and NixOS
nix develop   # Enter dev environment with all dependencies
nix build     # Build for current platform
```

---

## Technology Stack

| Layer | Technology | Justification |
|-------|------------|---------------|
| **Frontend** | React 19, TypeScript, Tailwind 4 | Typed UI with current React/Tailwind releases |
| **3D Rendering** | Three.js, @sparkjsdev/spark | 3D scene rendering and Gaussian Splatting support |
| **Desktop Framework** | Tauri 2.11 (Rust) | Rust-backed desktop shell with documented command/event IPC |
| **ML Inference** | CoreML + experimental MLX (macOS), TensorRT/CUDA (Linux), ONNX fallback | Platform-native acceleration paths with measured fallback behavior |
| **Sensor Fusion** | nalgebra (Rust) | Linear algebra support for Rust fusion filters |
| **Transport** | Zenoh-oriented Rust transport, rosbridge WebSocket, Tauri commands/events | Typed robotics data + flexible diagnostics + desktop IPC |
| **Build System** | Nix, Cargo, Vite, Bun | Reproducible shell/build support and package-script automation |

---

## Installation

### macOS (Apple Silicon)

```bash
# Prerequisites
xcode-select --install
brew install bun rust

# Clone and setup
git clone https://github.com/sepahead/crebain.git

# From the repository root
bun install

# Build backend (CoreML is used automatically on macOS)
cargo build --manifest-path src-tauri/Cargo.toml --release

# Run
bun run tauri:dev
```

### NixOS (NVIDIA CUDA)

```bash
# Clone
git clone https://github.com/sepahead/crebain.git

# Enter Nix dev environment (auto-detects CUDA on NixOS with NVIDIA drivers)
nix develop
#
# If CUDA is not detected (or you are on a non-standard setup), force the CUDA shell:
# nix develop .#cuda
#
# The Nix shells set `LD_LIBRARY_PATH` for CUDA/TensorRT and driver libraries.
# If you hit an ONNX Runtime load/version error, set `ORT_DYLIB_PATH` to a compatible `libonnxruntime.so`.

# Install frontend deps and run
bun install
bun run tauri:dev
```

### Model Setup

Place your ML model in the appropriate format:

| Platform | Model Path | Format |
|----------|-----------|--------|
| macOS | `CREBAIN_MODEL_PATH=/path/to/model.mlmodelc` | CoreML (`.mlmodelc` directory) |
| Linux (NVIDIA) | `CREBAIN_ONNX_MODEL=/path/to/model.onnx` | ONNX (CUDA/TensorRT via ONNX Runtime) |

This repo does **not** ship model weights. Provide your own model files and ensure you have the rights to redistribute them.

For local development you can also drop models into these paths (ignored by git):

- `src-tauri/resources/yolov8s.mlmodelc/` (macOS)
- `src-tauri/resources/yolov8s.onnx` (Linux)

Or set environment variables:
```bash
export CREBAIN_MODEL_PATH=/path/to/your/model
export CREBAIN_ONNX_MODEL=/path/to/your/model.onnx
```

---

## Usage

1. **Launch the app**: `bun run tauri:dev`
2. **Load a scene**: Drag and drop a .spz/.ply/.splat file, or use Ctrl+O (Cmd+O on macOS)
3. **Place cameras**: Press 1/2/3 to enter camera placement mode, click to place
4. **Enable detection**: Detection runs automatically on camera feeds
5. **View performance**: Press P to toggle the performance panel
6. **Sensor fusion**: Press U to expand/collapse the sensor fusion panel
7. **Connect ROS**: Press N to open the ROS connection panel
8. **Splat performance mode**: Press M to cap the splat count (1.5M) and reload the scene

### Scene and asset import contract

Scene JSON is bounded to 10 MiB before browser or native parsing. Older versions
are migrated before the current schema is validated. The current schema allows at
most 64 cameras, 256 drones, 128 GLB assets, 10,000 recent detections, 4,096 route
points per route, and 16,777,216 aggregate camera render-target pixels. IDs must be
unique, references must resolve, numeric values must be finite and bounded, and
camera/drone quaternions must be approximately unit length. Native saves use an
atomic same-directory temporary file before replacement.

Restorable external sources are limited to app-relative paths, HTTPS URLs, and
HTTP loopback URLs (`localhost`, `127.0.0.1`, or `::1`) without URL credentials.
Scene GLB entries must end in `.glb`; browser-selected local files that have no
reloadable source are intentionally not serialized as restorable assets.

Asset loading is bounded independently from the scene JSON:

| Asset | Boundary |
|-------|----------|
| Splat | 256 MiB source; remote download aborts after 30 s; renderer initialization aborts after 120 s |
| GLB | 128 MiB per source; 512 MiB aggregate loaded/pending GLB bytes; 128 assets |
| GLB contents | GLB 2.0 only; any buffer must use the single embedded binary chunk; no external buffers/images; embedded images must be PNG/JPEG with matching MIME bytes and at most 16,777,216 aggregate texture pixels |
| Floor texture | PNG/JPEG only; 32 MiB source; at most 8,192 px per dimension and 16,777,216 pixels; remote download aborts after 30 s |

Streaming byte ceilings are enforced even when `Content-Length` is missing or
dishonest. Scene restore waits for each asset result, ignores superseded loads,
and reports a partial restore instead of claiming success when an asset fails.

---

## Keyboard Controls

### Navigation (free-fly camera)
| Key | Action |
|-----|--------|
| W/A/S/D | Move forward/left/back/right |
| Q/E | Move down/up |
| Z/X or ←/→ | Rotate camera left/right |
| Shift | Sprint (3x speed) |
| Ctrl | Precision mode (0.2x speed) |
| Space | Emergency stop (zero velocity) |
| R | Reset camera to origin |

Navigation keys are suppressed while a drone is selected — the drone control
scheme below owns them.

### Camera System
| Key | Action |
|-----|--------|
| 1 | Place Static Camera (SK) |
| 2 | Place PTZ Camera |
| 3 | Place Patrol Camera (PK) |
| Tab | Cycle through cameras |
| V | Toggle camera feeds |

### Panels & UI
| Key | Action |
|-----|--------|
| P | Toggle Performance Panel |
| F | Focus scene content |
| G | Toggle 3D grid |
| N | Toggle ROS Connection Panel |
| U | Expand/collapse Sensor Fusion Panel |
| T | Toggle detection panel |
| Y | Toggle detection on/off |
| M | Toggle splat performance mode (cap 1.5M splats, reloads scene) |
| Ctrl/Cmd+O | Open scene file |
| Esc | Cancel placement / clear selection |

### Drone Control (drone selected)
| Key | Action |
|-----|--------|
| W/S/A/D | Horizontal flight |
| Q/E | Yaw left/right |
| Space | Throttle up |
| Shift | Throttle down |
| C | Switch camera view |
| R | Arm/disarm |
| Esc | Emergency disarm (all drones) |

### Object Transform (object selected)
| Key | Action |
|-----|--------|
| I/K | Rotate around X |
| J/L | Rotate around Y |
| ,/. | Rotate around Z |
| +/- | Scale up/down |
| Del/Backspace | Delete object |

---

## System Architecture

### Frontend Architecture

```
src/
├── components/
│   ├── CrebainViewer.tsx      # Main 3D viewer (scene, cameras, feeds, splats)
│   ├── DetectionOverlay.tsx   # Bounding box rendering
│   └── *Panel.tsx             # Draggable UI panels
│
├── hooks/
│   ├── useGazeboDrones.ts     # Drone state from ROS (CircularBuffer, memoized)
│   ├── useGazeboSimulation.ts # Continuous guidance controller
│   ├── useDroneController.ts  # Local drone spawning, physics loop, keyboard flight
│   └── useDraggable.ts        # Shared panel drag logic
│
├── ros/
│   ├── ROSBridge.ts           # WebSocket client (rosbridge)
│   ├── ROSCameraStream.ts     # Camera frame decoding
│   ├── GuidanceController.ts  # 20Hz PD control loop
│   ├── TransformManager.ts    # TF tree with caching
│   ├── WaypointManager.ts     # MAVROS mission support
│   └── useROSSensors.ts       # Multi-modal sensor fusion integration
│
└── lib/
    ├── CircularBuffer.ts      # O(1) position history
    └── mathUtils.ts           # Optimized vector math (distanceSquared)
```

### Backend Architecture

```
src-tauri/src/
├── lib.rs                # Tauri commands (IPC entry points)
├── main.rs               # Native app entry
│
├── coreml.rs             # macOS CoreML/Vision FFI (native detect path)
├── onnx_detector.rs      # Global ONNX Runtime detector singleton
│
├── common/               # Shared detection, NMS, YOLO, error, path utils
│
├── inference/            # ML abstraction layer (Detector trait + backends)
│   ├── mod.rs            # Detector trait + factory
│   ├── coreml.rs         # CoreML Detector adapter (delegates to ../coreml.rs)
│   ├── mlx.rs            # macOS MLX backend (experimental)
│   ├── cuda.rs           # Linux CUDA backend
│   ├── tensorrt.rs       # Linux TensorRT backend
│   └── onnx.rs           # Cross-platform fallback
│
├── transport/            # Communication layer
│   ├── mod.rs            # Transport trait + types
│   ├── zenoh.rs          # Zenoh implementation
│   ├── rosbridge.rs      # rosbridge WebSocket fallback
│   └── commands.rs       # Tauri transport commands
│
├── ncp/                  # NCP (Engram) client — off-by-default `ncp` feature
│
└── sensor_fusion.rs      # KF/EKF/UKF/PF/IMM filters
```

### Communication Layer

```mermaid
flowchart TB
    subgraph Tauri["TAURI APP"]
        Frontend["Frontend<br/>(React/Three.js)"]
        
        subgraph Transport["Transport Layer"]
            RustZenoh["Rust Transport<br/>(zenoh-rs)"]
            TSBridge["TypeScript ROSBridge<br/>(rosbridge client)"]
        end
        
        Frontend -->|"Tauri commands/events<br/>(JSON IPC)"| RustZenoh
        Frontend -->|"WebSocket<br/>(JSON, flexible)"| TSBridge
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

The NCP integrations are separate, dormant opt-in surfaces: the Rust module is
compiled only with `--features ncp`, its Tauri commands are not registered, and
`src/neuro` is not imported by the product runtime. There is no always-on
CREBAIN↔Engram loop. See [the current bridge handoff](docs/NCP_BRIDGE_HANDOFF.md).

---

## ML Inference Pipeline

### Detection Flow

```mermaid
flowchart TB
    CameraFeed["Camera Feed<br/>(Three.js)"]
    
    subgraph Capture["Frame Capture"]
        WebGL["WebGL RenderTarget"]
        ReadPixels["readPixels()"]
        RGBA["RGBA Buffer"]
        WebGL --> ReadPixels --> RGBA
    end
    
    subgraph Backend["Rust Backend: create_detector()"]
        subgraph Backends["Platform Backends"]
            macOS["macOS<br/>CoreML default<br/>MLX opt-in experimental"]
            Linux["Linux<br/>TensorRT/CUDA candidates"]
            Fallback["Fallback<br/>ONNX"]
        end
        Preprocess["Preprocess<br/>(resize 640×640, normalize)"]
        Inference["Inference<br/>(GPU/Neural Engine)"]
        Postprocess["Postprocess<br/>(NMS, filter confidence)"]
        
        Backends --> Preprocess --> Inference --> Postprocess
    end
    
    subgraph Overlay["Detection Overlay (Canvas 2D)"]
        BBox["Bounding Boxes"]
        Threat["Threat Level Coloring"]
        TrackID["Track IDs"]
    end
    
    CameraFeed --> Capture
    Capture -->|"Tauri IPC (invoke)"| Backend
    Backend -->|"JSON Detections"| Overlay
```

### Performance Measurement

Performance depends on hardware, model format, model size, runtime provider, image size, batching, and whether the native Tauri app or browser-only path is being used. Treat any latency target as invalid until it is reproduced with the benchmark scripts on the deployment hardware.

Use:

```bash
bun run test:benchmark
```

The default validation suite skips benchmark tests unless `RUN_BENCHMARKS=1` is set.

---

## Sensor Fusion System

CREBAIN runs **two fusion engines**: a native Rust multi-modal tracker
(`src-tauri/src/sensor_fusion.rs`) reached over Tauri IPC, and a browser-only
multi-camera triangulation engine (`src/detection/SensorFusion.ts`). The native
engine is the default and is what the **Sensor Fusion panel** (`U`) displays.

> **Full design reference:** **[docs/SENSOR_FUSION.md](docs/SENSOR_FUSION.md)** —
> the estimation math, filter internals, data association, multi-sensor fusion
> semantics, tuning, validation, and a frank list of known limitations.

### Pipeline

Each fusion cycle: **predict** every track to the current time (constant-velocity
model) → **associate** measurements to tracks via a Mahalanobis gate → **update**
the matched tracks → **initiate** new tracks from unmatched measurements →
**lifecycle** (age, confirm, coast, delete). The state vector is
`[x, y, z, vx, vy, vz]`; only position is observed, and velocity is inferred.

### Measurement coordinate contract

`position` and `covariance` are interpreted **by modality** — getting this wrong
silently corrupts a modality's tracks:

| Modality | `position` frame | `covariance` units |
|----------|------------------|--------------------|
| `radar` | polar `[range_m, azimuth_rad, elevation_rad]` | `[m², rad², rad²]` |
| `lidar` | Cartesian `[x, y, z]` m | `[m², m², m²]` |
| `visual` / `thermal` / `acoustic` | Cartesian `[x, y, z]` m | `[m², m², m²]` |

Radar stays polar end-to-end so the EKF models its angular error correctly; lidar is
a precise Cartesian centroid and is never routed through a polar conversion.
Covariance entries must be strictly positive and radar ranges non-negative —
measurements failing validation are rejected at the IPC boundary.

### Filter Selection Guide

| Scenario | Recommended Filter | Why |
|----------|-------------------|-----|
| Constant velocity targets | Kalman Filter | Standard linear Gaussian baseline |
| Radar (polar, non-linear) | Extended Kalman *(default)* | Linearizes the polar measurement model |
| Highly non-linear dynamics | Unscented Kalman | Sigma points; no Jacobian needed |
| Multi-modal distributions | Particle Filter | Handles non-Gaussian posteriors |
| Maneuvering targets | IMM | Mixes a CV and a Coordinated-Turn model via a Markov chain |

### Track State Machine

Confirmation is a **sliding-window M-of-N** rule: each track carries a `hit_history`
bitmask of its last `N` association opportunities and is confirmed once it has at
least M hits in that window. Defaults: confirm at 3 hits in the last 5
(`min_confirmation_hits` = M, `confirmation_window` = N, so **3-of-5**); coast at 2
consecutive misses; delete (`Lost`) at `max_missed_detections` = 5 misses *within the
window* (must be ≤ `confirmation_window`), **or** when the position-block covariance
volume exceeds `max_position_cov_volume` (default `1e6`). A `Lost` track is removed
from the table.

```mermaid
stateDiagram-v2
    [*] --> Tentative: unassociated measurement

    Tentative --> Confirmed: ≥ M hits in the last N (3-of-5)
    Tentative --> Coasting: 2 consecutive misses
    Tentative --> Lost: ≥ max_missed misses in window<br/>or covariance volume too large

    Confirmed --> Coasting: 2 consecutive misses
    Coasting --> Confirmed: ≥ M hits in window
    Coasting --> Lost: ≥ max_missed misses in window<br/>or covariance volume too large

    Lost --> [*]: removed
```

---

## ROS-Gazebo Integration

### Supported Topics

```yaml
# Topic templates: replace <ns>; the literal `*` is not accepted.
# Drone state (subscribe)
/gazebo/model_states:                         gazebo_msgs/ModelStates
/<ns>/mavros/local_position/pose:             geometry_msgs/PoseStamped
/<ns>/mavros/state:                           mavros_msgs/State  # WebSocket UI only

# Camera (subscribe; caller explicitly selects raw or compressed schema)
/<ns>/camera/image_raw:                       sensor_msgs/Image
/<ns>/camera/image_raw/compressed:            sensor_msgs/CompressedImage
/<ns>/camera/camera_info:                     sensor_msgs/CameraInfo

# Control (publish)
/<ns>/mavros/setpoint_position/local:         geometry_msgs/PoseStamped
/<ns>/mavros/setpoint_velocity/cmd_vel:       geometry_msgs/TwistStamped

# Custom fusion arrays (WebSocket UI path only)
/crebain/thermal/detections:                  crebain_msgs/ThermalDetectionArray
/crebain/acoustic/detections:                 crebain_msgs/AcousticDetectionArray
/crebain/radar/detections:                    crebain_msgs/RadarDetectionArray
/crebain/lidar/detections:                    crebain_msgs/LidarDetectionArray
# (visual measurements come from the local detection pipeline, not a ROS topic)

# Gazebo Classic services (rosbridge fallback)
/gazebo/spawn_urdf_model:          gazebo_msgs/SpawnModel
/gazebo/spawn_sdf_model:           gazebo_msgs/SpawnModel
/gazebo/delete_model:              gazebo_msgs/DeleteModel
/gazebo/pause_physics, /gazebo/unpause_physics, /gazebo/reset_world
```

These are topic templates, not wildcard subscriptions. The shipped product UI
defaults to the TypeScript rosbridge WebSocket path, which supports the Gazebo
Classic service calls and custom fusion arrays above. Selecting **Zenoh (Tauri)**
switches to the native transport's fixed typed surface: raw/compressed camera,
CameraInfo, IMU, PoseStamped, ModelStates, and pose/twist publishing. It does not
implement ROS service calls, MAVROS state/odometry helpers, or the custom fusion
arrays; the UI surfaces those operations as unsupported.

### Camera wire contract

Both native transports use the same explicit camera schema; topic suffixes do not
select a decoder. The Tauri command carries `compressed: true|false`, and emitted
`CameraFrame.data` is base64 text in both cases.

- Raw `sensor_msgs/Image`: `rgba8`, `bgra8`, `rgb8`, `bgr8`, or `mono8`; width
  and height each `1..=8192`; `step` must cover the encoded row; decoded data must
  equal `height * step` and remain within 64 MiB.
- `sensor_msgs/CompressedImage`: PNG or JPEG only. The declared format must match
  the encoded bytes; an empty format is accepted only as the ROS JPEG fallback.
  Encoded dimensions must fit the same `1..=8192` / 64 MiB decoded-RGBA budget.
- `sensor_msgs/CameraInfo`: finite `K[9]`, `R[9]`, and `P[12]`; `D` is exactly 5
  for `plumb_bob`, 8 for `rational_polynomial`, 4 for `equidistant`, or at most
  32 finite coefficients for a custom model.
- Headers require a non-negative finite timestamp (`nsec < 1,000,000,000`) and a
  bounded, control-character-free frame ID.

### Quick Start

```bash
# Terminal 1: Gazebo Classic server (headless by design; the GUI is gzclient)
gzserver your_world.sdf

# Terminal 2: rosbridge WebSocket server (the service names above are
# Gazebo Classic / ROS 1-style; run the matching rosbridge setup)
roslaunch rosbridge_server rosbridge_websocket.launch

# Terminal 3: CREBAIN
bun run tauri:dev
```

The native Zenoh transport speaks CREBAIN's own plain-key topic scheme. Direct
interop with an `rmw_zenoh_cpp` ROS 2 graph (which keys topics as
`<domain>/<topic>/<type>/<hash>`) requires a re-keying bridge and is not
provided out of the box. Setting `RMW_IMPLEMENTATION=rmw_zenoh_cpp` alone does
not make the two key schemes compatible.

---

## Communication Protocols

### Protocol Comparison

| Factor | rosbridge (WebSocket) | Zenoh (Native) |
|--------|----------------------|----------------|
| **Latency** | Deployment-dependent | Deployment-dependent |
| **Throughput** | Deployment-dependent | Deployment-dependent |
| **CPU Usage** | JSON parsing overhead applies | Depends on topology and payload path |
| **Setup** | rosbridge server + matching ROS message packages | Zenoh peer using CREBAIN keys, or an explicit ROS 2 re-keying bridge |
| **Add Sensors** | Dynamic JSON messages | Needs Rust-side topic/type handling |
| **ROS1 Support** | Yes | No |
| **Debugging** | Browser DevTools | Harder |

### When to Use Each

**rosbridge**: The shipped UI default and the required path for the documented
Gazebo Classic services and custom fusion messages.

**Zenoh-oriented transport**: A native typed pub/sub path for its fixed message
surface. Benchmark in your topology, and provide a re-keying bridge for direct
`rmw_zenoh_cpp` graph interoperability.

---

## Cross-Platform Support

### Platform Matrix

| Component | macOS (Apple Silicon) | NixOS (NVIDIA) |
|-----------|----------------------|----------------|
| ML Inference | CoreML default / MLX experimental opt-in | CUDA / TensorRT |
| GPU Compute | Metal-family APIs where supported | CUDA where supported |
| 3D Rendering | Runtime-dependent WebGPU/WebGL behavior | Runtime-dependent WebGPU/WebGL behavior |
| Build System | Nix / Homebrew | Nix |
| Gazebo | Native / Docker | Native |

### Environment Variables

| Variable | Description | Values |
|----------|-------------|--------|
| `CREBAIN_MODEL_PATH` | ML model path | Path to `.mlmodelc` or `.onnx` |
| `CREBAIN_ONNX_MODEL` | ONNX model path (override) | Path to `.onnx` |
| `CREBAIN_BACKEND` | Force ML backend | `coreml`, `mlx`, `tensorrt`, `cuda`, `onnx` |
| `CREBAIN_ENABLE_EXPERIMENTAL_MLX` | Allow experimental MLX auto-selection on Apple Silicon after model-contract validation | `1` / `true` |
| `CREBAIN_MLX_MODEL` | MLX safetensors model path | Path to `.safetensors` |
| `CREBAIN_MLX_MODEL_SHA256` | Optional MLX model digest pin | 64-character SHA-256 hex digest |
| `CREBAIN_PROFILE_MLX` | Per-layer MLX latency logging | `1` |
| `CREBAIN_TRT_CACHE_DIR` | TensorRT engine cache dir | Directory path (Linux) |
| `CREBAIN_DISABLE_TRT_CACHE` | Disable TensorRT caching | `1` / `true` |
| `ORT_DYLIB_PATH` | ONNX Runtime library path (honored by `ort` only on Linux `load-dynamic` builds) | Path to `libonnxruntime.so` |
| `CREBAIN_ZENOH` | Select the native Rust transport: unset/true-like uses Zenoh; any other value uses its rosbridge fallback. This does not choose the product UI transport. | `1` / `0` |
| `CREBAIN_ROSBRIDGE_URL` | URL used only by the native Rust rosbridge fallback (`CREBAIN_ZENOH=0`) | `ws://localhost:9090` (default) |
| `CREBAIN_ALLOW_UNSAFE_GAZEBO_XML` | Native Rust trusted-development bypass for caller-supplied Gazebo XML containing plugin/include/URI/external-resource directives | `1` only in an isolated trusted environment |
| `CREBAIN_PID_JSONL` | Native best-effort innovation-record append sink; the path is trusted operator configuration and may contain sensitive telemetry | Writable local path |

The frontend ROS connection panel defaults separately to WebSocket and uses its
own URL field. Frontend caller-supplied Gazebo XML always rejects privileged
directives; only the audited bundled Maverick helper has a fixed privileged
frontend path. The native environment bypass does not weaken that frontend rule.

---

## Performance Optimizations

### Implemented Optimizations

| Optimization | Location | Impact |
|--------------|----------|--------|
| CircularBuffer for position history | `useGazeboDrones.ts` | O(n) → O(1) |
| Memoized derived state | `useGazeboDrones.ts` | No recompute on every render |
| Squared distance comparisons | `InterceptionSystem.ts` | Avoids sqrt() |
| Selective trajectory prediction | `useGazeboSimulation.ts` | Avoids unnecessary prediction work |
| 20Hz continuous guidance | `GuidanceController.ts` | Smooth control |
| Stable config refs | Various hooks | Avoids effect re-runs |
| ImageBitmap decoding + explicit close() | `ROSCameraStream.ts` | Browser-native decode without bitmap leaks |
| Round-robin camera feed rendering | `CrebainViewer.tsx` | One render-to-target per 83 ms tick |
| Frame-budget feed governor | `CrebainViewer.tsx` | Stretches feed cadence under load (EMA-based stride) |
| Splat performance mode (`M`) | `CrebainViewer.tsx` | Caps splat count at 1.5M for weak GPUs |
| Pooled feed buffers | `CrebainViewer.tsx` | No per-tick ImageData/array allocations |

### Benchmarking

| Metric | Value |
|--------|-------|
| ML Inference | Measure with `bun run test:benchmark` and backend diagnostics |
| Sensor Fusion | Covered by unit/smoke tests; add target-hardware benchmarks before release claims |
| Camera Render | Measure in browser/native performance tooling |
| Physics Step | Validate against the simulation rate used in the active scenario |
| Total Frame Time | Measure end-to-end on target hardware |

---

## Evidence and Sources

This README distinguishes project-owned implementation claims from external technology claims:

- **Project-owned claims**: Backed by source code, tests, or the latest `bun run validate:all` result in this repository.
- **Performance claims**: Not treated as release guarantees unless reproduced with repository benchmarks on the target hardware and model files.
- **External technology claims**: Cross-checked against primary documentation where possible.

Primary references used for external claims:

| Topic | Source |
|-------|--------|
| Tauri commands and frontend-to-Rust IPC | [Tauri: Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/) |
| Tauri event limitations and Rust-to-frontend events | [Tauri: Calling the Frontend from Rust](https://v2.tauri.app/develop/calling-frontend/) |
| React 19 availability | [React v19 release notes](https://react.dev/blog/2024/12/05/react-19) |
| Three.js WebGPU/WebGL fallback behavior | [Three.js WebGPURenderer docs](https://threejs.org/docs/pages/WebGPURenderer.html) |
| Spark Gaussian Splatting integration with Three.js | [Spark getting started docs](https://sparkjs.dev/docs/) |
| Zenoh pub/sub/query model | [Zenoh: What is Zenoh?](https://zenoh.io/docs/overview/what-is-zenoh/) |
| rosbridge JSON/WebSocket bridge behavior | [RobotWebTools rosbridge_suite](https://github.com/RobotWebTools/rosbridge_suite) |
| ROS 2 topics model | [ROS 2: Understanding topics](https://docs.ros.org/en/humble/Tutorials/Beginner-CLI-Tools/Understanding-ROS2-Topics/Understanding-ROS2-Topics.html) |
| Gazebo sensors and simulation plugins | [Gazebo sensors tutorial](https://gazebosim.org/docs/latest/sensors/) |
| Core ML purpose | [Apple Core ML documentation](https://developer.apple.com/documentation/coreml) |
| TensorRT purpose | [NVIDIA TensorRT documentation](https://docs.nvidia.com/deeplearning/tensorrt/latest/index.html) |
| ONNX Runtime cross-platform inference | [ONNX Runtime documentation](https://onnxruntime.ai/docs/) |
| YOLOv8 model family | [Ultralytics YOLOv8 documentation](https://docs.ultralytics.com/models/yolov8/) |
| nalgebra Rust linear algebra | [nalgebra documentation](https://www.nalgebra.rs/docs/) |
| Rapier physics engine | [Rapier documentation](https://rapier.rs/docs/) |
| Vite build tooling | [Vite getting started docs](https://vite.dev/guide/) |
| Vitest test runner | [Vitest getting started docs](https://vitest.dev/guide/) |
| Bun runtime/package/test tooling | [Bun documentation](https://bun.com/docs) |
| Tailwind CSS v4 status | [Tailwind CSS v4.0 release notes](https://tailwindcss.com/blog/tailwindcss-v4) |
| Nix declarative development environments | [Nix/NixOS documentation](https://nixos.org/) |

---

## Configuration

### Detection Settings

| Parameter | Default | Range |
|-----------|---------|-------|
| Confidence Threshold | 0.25 | 0.0-1.0 |
| IOU Threshold | 0.45 | 0.0-1.0 |
| Max Detections | 100 | 1-1000 |

Individual browser backends override the confidence default (CoreML 0.3,
RF-DETR 0.35, Moondream 0.3); see `src/detection/*Detector.ts`.

### Sensor Fusion Settings

| Parameter | Default | Description |
|-----------|---------|-------------|
| Algorithm | EKF | Filter algorithm (KF/EKF/UKF/PF/IMM) |
| Process Noise (Q) | 1.0 | Un-modeled dynamics / maneuver intensity |
| Measurement Noise (R) | 2.0 | Default sensor uncertainty (overridden per-modality) |
| Association Threshold | 11.345 | χ²(3) gate on squared Mahalanobis distance (≈99%) |
| Max Missed Detections | 5 | Misses within the confirmation window before a track is deleted (must be ≤ confirmation window) |
| Min Confirmation Hits | 3 | Hits within the window (M) before Tentative → Confirmed |
| Confirmation Window | 5 | Sliding-window size N for the M-of-N rule (default 3-of-5) |
| Max Position Cov Volume | 1e6 | Position-block covariance-determinant ceiling; a track exceeding it is deleted |
| Particle Count | 100 | Particles per track (PF only) |

See [docs/SENSOR_FUSION.md](docs/SENSOR_FUSION.md) for per-parameter tuning guidance.

### Guidance Controller Settings

| Parameter | Default | Description |
|-----------|---------|-------------|
| Rate | 20Hz | Control loop frequency (browser timers permitting) |
| Max Velocity | 15 m/s | Speed limit |
| Max Acceleration | 5 m/s² | Velocity ramp limit |
| kP | 1.5 | Proportional gain |
| kD | 0.5 | Derivative gain (on measured velocity) |
| Approach Distance | 10 m | Deceleration radius |
| Arrival Threshold | 0.5 m | Waypoint-reached distance |

---

## Project Structure

```
crebain/
├── src/                          # React frontend
│   ├── components/               # UI components
│   ├── hooks/                    # React hooks
│   ├── ros/                      # ROS integration
│   ├── detection/                # Detection pipeline + browser fusion
│   ├── physics/                  # Drone physics
│   ├── simulation/               # Interception system
│   ├── state/                    # Scene serialization/persistence
│   ├── context/                  # React contexts (UI scaling)
│   ├── neuro/                    # Dormant NCP TypeScript glue (version guard)
│   └── lib/                      # Utilities
│
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── common/               # Shared detection/NMS/YOLO/path utils
│   │   ├── inference/            # ML abstraction layer
│   │   ├── transport/            # Zenoh + rosbridge transport
│   │   ├── ncp/                  # Dormant NCP client (off-by-default feature)
│   │   └── sensor_fusion.rs      # Filter algorithms
│   ├── native/
│   │   └── coreml-ffi/           # Swift CoreML bridge
│   ├── sidecar/                  # Swift sidecar package
│   └── resources/                # ML models (you create this; gitignored)
│
├── ros/                          # ROS reference files (crebain_msgs)
│   ├── msg/                      # Message definitions
│   ├── srv/                      # Service definitions
│   └── launch/                   # Launch files
│
├── flake.nix                     # Nix build configuration
├── package.json                  # Frontend dependencies
└── README.md                     # This file
```

---

## Validation

Use the same commands in local development, CI, and PR review:

```bash
# Frontend typecheck + lint + format check + Vitest
bun run validate

# Local cross-language gate: frontend validation + Rust fmt/check/test/clippy,
# plus clippy and tests with the off-by-default `ncp` feature
bun run validate:all
```

Useful focused checks:

```bash
bun run typecheck
bun run lint            # ESLint
bun run format:check    # Prettier
bun run test:run
bun run test:coverage   # Vitest coverage (enforces thresholds)
bun run check:bundle    # build + initial-bundle size budget
bun run check:rust
bun run fmt:rust:check
bun run test:rust
bun run clippy:rust
bun run check:rust:ncp
bun run clippy:rust:ncp
bun run test:rust:ncp
```

The authoritative pass/fail status and test counts are the
[CI runs](https://github.com/sepahead/crebain/actions/workflows/ci.yml); see
`CHANGELOG.md` for what changed per release. `bun run validate:all` runs the full
frontend/default-Rust/NCP-Rust gate locally. It does **not** run the hosted
bundle-size, coverage, feature-gate (`cuda,tensorrt` and `--no-default-features`),
CodeQL, or supply-chain-audit jobs; release candidates require those hosted gates
as specified in [the acceptance matrix](docs/RELEASE_ACCEPTANCE.md).

Current backend boundary hardening covers:

- Native detection image ingress and structured failure payloads
- Scene path/JSON validation, bounded open-once native reads, atomic saves,
  browser pre-read bounds, migration, schema/cardinality guards, and bounded
  self-contained asset restore
- Sensor-fusion config, measurement, track, and stats validation
- ROSBridge graph/service validation, bounded base64-only image parsing,
  correlated service replies, queue/time limits, and fail-closed mutation results
- Unified raw/compressed camera schemas across rosbridge and Zenoh; Zenoh
  topic/event naming, bounded CDR strings/sequences/image metadata, and finite
  transport publish payloads
- TensorRT model path and engine-build input validation, including unsupported INT8 build rejection without calibration data

Release readiness artifacts:

- **Acceptance matrix**: `docs/RELEASE_ACCEPTANCE.md`
- **Model contracts**: `docs/MODEL_CONTRACTS.md`
- **Manual smoke checklist**: `docs/MANUAL_SMOKE_TEST.md`
- **Release evidence log**: `docs/RELEASE_EVIDENCE.md`
- **Security threat model**: `SECURITY.md`

---

## Development Roadmap

### Stabilization Baseline (v0.4.x)

- [x] Centralized keyboard shortcut constants and tests
- [x] Centralized Tauri IPC command constants and registration-drift tests
- [x] Detection, diagnostics, scene state, sensor fusion, ROS, Zenoh, and Gazebo mocked test coverage
- [x] ROS namespace normalization and shared WebSocket test helpers
- [x] Frontend validation script and full frontend/Rust validation script
- [x] Runtime diagnostics, benchmark cancellation, backend availability UI, and transport event-name guardrails
- [x] Calibrated detection/fusion scenario fixture and smoke coverage
- [x] Source-contract guardrails for transport topic validation and scene file path/JSON checks
- [x] Backend IPC and transport boundary hardening for native detection, scene files, fusion, ROSBridge, Zenoh CDR, transport publish payloads, and TensorRT paths/build inputs

### Near-Term Engineering Focus (v0.5.x)

- [x] Guidance controller loop tests and safety envelope checks
- [x] Backend command registration/source tests in Rust
- [x] End-to-end detection/fusion smoke tests with mocked model outputs
- [x] CI backend alignment to package scripts
- [x] MLX remains experimental/opt-in while the YOLOv8 safetensors path awaits external model-contract evidence
- [x] Release acceptance matrix, model contracts, security threat model, and manual smoke checklist
- [x] Executable negative guard tests for native detection, model path, scene path, and transport topic boundaries, including TensorRT build inputs, fusion, Zenoh CDR, and transport payloads
- [x] Experimental MLX YOLOv8 forward pass implementation with DFL postprocessing and profiling
- [ ] Full Tauri AppHandle-backed negative IPC integration tests for scene/model/transport boundaries
- [x] Multi-frame scenario tests for track confirmation and motion

### Planned Capability Work (v0.6.x)

- [ ] Hardware-in-the-loop (HIL) testing
- [ ] Real PX4/ArduPilot integration
- [ ] Multi-drone coordination
- [ ] Encrypted communication (Zenoh-TLS)

### Future

- [ ] Edge deployment (Jetson, Apple Silicon Mac Mini)
- [ ] Recorded flight replay
- [ ] AI-assisted threat assessment
- [ ] Integration with C2 systems

---

## Current Engineering Backlog

These are the next high-leverage engineering tasks after the current stabilization baseline:

| # | Perspective | Next Step | Primary Outcome |
|---|-------------|-----------|-----------------|
| 1 | **ML Engineer** | Validate the experimental MLX YOLOv8 safetensors path with an approved model contract, fixture detections, class mapping, and target-hardware benchmarks | Trustworthy Apple Silicon model evidence |
| 2 | **Rust Backend Engineer** | Add AppHandle-backed negative IPC integration tests for scene, model, transport, and fusion boundaries | Stronger end-to-end IPC evidence |
| 3 | **Robotics Engineer** | ✅ Done — multi-frame scenario tests for track confirmation (sliding-window M-of-N), target motion, and stale-track cleanup | More realistic perception/fusion checks |
| 4 | **Transport Engineer** | Run ROS/Gazebo/Zenoh multi-frame smoke tests against a target topology | Deployment-specific transport confidence |
| 5 | **Performance Engineer** | Add regression benchmarks for detection conversion, NMS, sensor fusion, transport event routing, and position history | Better latency visibility |
| 6 | **QA Engineer** | Execute and archive manual smoke-test results for native launch, diagnostics, scene save/load, and ROS/Zenoh modes | Repeatable release checks |
| 7 | **Model Engineer** | Validate at least one full model contract with fixture frames, class mapping, thresholds, and benchmark context | Trustworthy demo/model evidence |
| 8 | **Frontend Engineer** | Extract reusable hook-test harness utilities for React root setup, `act`, IPC mocks, and cleanup | Less duplicated test code |
| 9 | **DevOps Engineer** | Add CI artifacts or summaries for frontend/Rust test counts and skipped benchmark tests | Faster PR review |
| 10 | **Technical Writer** | Keep tracked Markdown docs synchronized after each behavior, validation, or security-boundary change | Lower onboarding friction |

---

## Contributing

1. Fork the repository.
2. Create a feature branch from `main`.
3. Keep the change focused and document the risk.
4. Run the relevant validation command.
5. Open a pull request using the template.

### Code Quality Requirements

- TypeScript strict mode
- Rust clippy clean
- Use the centralized logger instead of `console.*` in production
- Validate external inputs at IPC, file, model, ROS, Zenoh, and CDR boundaries
- Memoize expensive computations
- Use CircularBuffer for high-frequency data
- Prefer squared distance for comparisons

---

## Disclaimer

This software is provided for **research and educational purposes only**. CREBAIN is intended as a technical demonstration and research platform for studying sensor fusion, multi-modal tracking, and autonomous systems visualization.

**The contributors and maintainers of this project:**

- Make no representations or warranties of any kind concerning the fitness, safety, or suitability of this software for any purpose
- Are not responsible for any direct, indirect, incidental, special, exemplary, or consequential damages arising from the use or misuse of this software
- Do not endorse or encourage any specific application of this technology
- Assume no liability for any actions taken with this software, whether lawful or unlawful

Users are solely responsible for ensuring compliance with all applicable laws, regulations, and ethical guidelines in their jurisdiction. This includes but is not limited to aviation regulations, privacy laws, export controls, and any restrictions on autonomous systems or surveillance technology.

**By using this software, you acknowledge that you understand these terms and accept full responsibility for your use of the software.**

---

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

---

**CREBAIN — Adaptive Response & Awareness System**

*Adaptives Reaktions- und Aufklärungssystem*
