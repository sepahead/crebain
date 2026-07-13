# CREBAIN ROS 1 / Gazebo Classic references

This directory is a catkin package named `crebain_msgs`. It contains ROS 1
message/service definitions plus Gazebo Classic, MAVROS, and rosbridge launch
references. It is not a ROS 2 package and does not make CREBAIN's native Zenoh
keys directly compatible with an `rmw_zenoh_cpp` graph.

## Structure

```text
ros/
├── CMakeLists.txt
├── package.xml
├── msg/                     # Detection, target, and interception messages
├── srv/                     # InitiateIntercept and AbortMission
└── launch/
    ├── simulation.launch    # Gazebo Classic + rosbridge + multi-drone include
    ├── rosbridge.launch     # Standalone rosbridge/rosapi configuration
    ├── multi_drone.launch   # Interceptor/target groups
    └── single_drone.launch  # Gazebo model + MAVROS + static TF
```

## Build

Copy or symlink this directory into a ROS 1 catkin workspace, then install the
runtime packages referenced by `package.xml`:

```bash
ln -s /path/to/crebain/ros ~/catkin_ws/src/crebain_msgs
cd ~/catkin_ws
catkin_make
source devel/setup.bash
```

The multi-drone launch files also expect PX4/MAVROS and
`mavlink_sitl_gazebo` model assets. They are reference topology, not a bundled
autopilot distribution.

## Topic templates

Standard topics the product telemetry UI subscribes to (replace `<ns>`; the
literal `*` is not accepted):

| Topic template | Type | Direction / path |
|----------------|------|------------------|
| `/gazebo/model_states` | `gazebo_msgs/ModelStates` | Subscribe |
| `/<ns>/mavros/local_position/pose` | `geometry_msgs/PoseStamped` | Subscribe |
| `/<ns>/mavros/local_position/odom` | `nav_msgs/Odometry` | Subscribe; Vite-development WebSocket only (Zenoh reports unsupported) |
| `/<ns>/mavros/state` | `mavros_msgs/State` | Subscribe; Vite-development WebSocket only |
| `/<ns>/camera/image_raw` | `sensor_msgs/Image` | Subscribe; caller explicitly selects the raw schema |
| `/<ns>/camera/image_raw/compressed` | `sensor_msgs/CompressedImage` | Subscribe; caller explicitly selects the compressed schema |
| `/<ns>/camera/camera_info` | `sensor_msgs/CameraInfo` | Subscribe |

`sensor_msgs/Imu` subscriptions are part of the **Zenoh (Tauri)** native typed
surface only — there is no fixed topic template and the TypeScript WebSocket
bridge has no IMU support. Visual measurements come from the local detection
pipeline, not a ROS topic.

## Custom messages and services

| Topic template | Type | Path |
|----------------|------|------|
| `/crebain/thermal/detections` | `crebain_msgs/ThermalDetectionArray` | Vite-development WebSocket sensor-fusion path |
| `/crebain/acoustic/detections` | `crebain_msgs/AcousticDetectionArray` | Vite-development WebSocket sensor-fusion path |
| `/crebain/radar/detections` | `crebain_msgs/RadarDetectionArray` | Vite-development WebSocket sensor-fusion path |
| `/crebain/lidar/detections` | `crebain_msgs/LidarDetectionArray` | Vite-development WebSocket sensor-fusion path |
| `/crebain/targets` | `crebain_msgs/DroneTarget` | Reference output contract |

Reference service definitions (not registered product commands):

| Service | Type |
|---------|------|
| `/crebain/initiate_intercept` | `crebain_msgs/InitiateIntercept` |
| `/crebain/abort_mission` | `crebain_msgs/AbortMission` |

The following ROS 1 Gazebo Classic services are reference contracts for
external tools only. CREBAIN no longer ships a Gazebo controller or any
renderer/native service-call method:

| Service | Type |
|---------|------|
| `/gazebo/spawn_sdf_model` | `gazebo_msgs/SpawnModel` |
| `/gazebo/spawn_urdf_model` | `gazebo_msgs/SpawnModel` |
| `/gazebo/delete_model` | `gazebo_msgs/DeleteModel` |
| `/gazebo/get_model_state` | `gazebo_msgs/GetModelState` |
| `/gazebo/set_model_state` | `gazebo_msgs/SetModelState` |
| `/gazebo/pause_physics`, `/gazebo/unpause_physics`, `/gazebo/reset_world`, `/gazebo/reset_simulation` | `std_srvs/Empty` |

`/gazebo/spawn_entity` / `gazebo_msgs/SpawnEntity` is a different Gazebo/ROS 2
contract and likewise is not a CREBAIN product path.

## Launch

The full launch defaults to `gui:=true`. Set `gui:=false` for the documented
headless server mode:

```bash
# Terminal 1
roslaunch crebain_msgs simulation.launch gui:=false

# Terminal 2, from the CREBAIN repository
bun run tauri:dev
```

Alternatively launch `rosbridge.launch` against an already-running ROS 1 /
Gazebo Classic graph. A Vite development build may select its read-only
rosbridge telemetry adapter and connect to `ws://localhost:9090`; packaged
builds do not expose that option.

## Transport boundary

The packaged product UI defaults to **Zenoh (Tauri)** and exposes a fixed
read-only surface: camera, CameraInfo, IMU, PoseStamped, and ModelStates. The
TypeScript rosbridge client is available only to Vite development builds;
production substitutes a network-free stub and its CSP omits rosbridge socket
origins. The native Rust rosbridge fallback (`CREBAIN_ZENOH=0`) is also
subscription-only. No renderer-facing ROS telemetry transport has generic
publish, pose/twist setpoint, ROS service, MAVROS mode/mission, or Gazebo
mutation methods. A separately feature/runtime-gated native producer can put
only Galadriel sidecar/monitor evidence to two NCP named-perception keys; it is
not a ROS transport, re-keying bridge, service, setpoint, or actuator surface.

The native Zenoh adapter maps ROS-looking topic strings to CREBAIN plain keys.
An `rmw_zenoh_cpp` graph uses DDS/RMW-qualified keys, so setting
`RMW_IMPLEMENTATION=rmw_zenoh_cpp` is insufficient; deploy an explicit re-keying
bridge.

## Camera contract

The caller explicitly selects `sensor_msgs/Image` or
`sensor_msgs/CompressedImage`; a `/compressed` suffix is not used for schema
inference. The native Rust rosbridge fallback and native Zenoh transport enforce:

- raw encodings `rgba8`, `bgra8`, `rgb8`, `bgr8`, or `mono8`; dimensions
  `1..=8192`; `step >= width * bytes_per_pixel`; exact `height * step`; maximum
  decoded data 64 MiB (the native rosbridge fallback additionally bounds raw
  dimensions by the decoded-RGBA budget, `width * height * 4` ≤ 64 MiB, so it
  is slightly stricter than the Zenoh path for sub-4-byte-per-pixel
  encodings);
- compressed PNG/JPEG bytes only, with declared format matching the bytes (empty
  format is the JPEG fallback) and the same dimension/RGBA allocation budget;
- base64 text for rosbridge image data and base64 `CameraFrame.data` over Tauri;
- CameraInfo `K[9]`, `R[9]`, `P[12]`; `D[5]` for `plumb_bob`, `D[8]` for
  `rational_polynomial`, `D[4]` for `equidistant`, or at most 32 coefficients for
  a custom model; and
- finite/non-negative header time with nanoseconds below `1,000,000,000` plus a
  bounded, control-character-free frame ID.

ROS sensor header frame IDs are forwarded into fusion as source-frame
provenance. In the optional Galadriel producer, matching the configured
canonical ENU frame plus an empty registry transform chain is necessary for a
common projection. CREBAIN does not evaluate a transform chain, and a matching
frame-name string is not authenticated sensor origin or calibration evidence.

## Removed mutation boundary

`GazeboController`, `WaypointManager`, renderer service/publish APIs, native
pose/twist/spawn commands, and the former unsafe-XML environment bypass are
removed. The SDF strings in `src/ros/models.ts`, launch files, and service
definitions in this reference package are not callable product capabilities.
The Phase 0 verifier covers the executable Vite/Cargo/Tauri inputs, including
root HTML, Cargo build input, public scripts, locks, and relevant build scripts.
Its TypeScript AST checks literal, concatenated, constant-template,
array-joined, and computed MAVROS/Gazebo routes and generic command method
names. The real subscription-only renderer adapter remains explicitly
classified as development-only; production must resolve to the network-free
replacement and prove that resolution in the emitted Vite module graph.

Camera byte fields remain base64-only; JSON byte arrays are rejected.

Do not expose rosbridge or Zenoh endpoints to untrusted networks without
deployment-specific authentication, network policy, and transport security.
