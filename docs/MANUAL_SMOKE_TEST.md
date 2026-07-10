# CREBAIN Manual Smoke Test

Run this checklist after automated validation for a release candidate, demo, or
cross-cutting stabilization batch. Do not reuse results from another commit,
model, platform, or ROS/Zenoh topology.

## Environment Record

| Field | Value |
|-------|-------|
| Commit |  |
| OS / hardware |  |
| App mode | `bun run tauri:dev` / packaged build |
| Model file + digest |  |
| Detection backend | CoreML / ONNX / CUDA / TensorRT / MLX |
| ROS 1 / Gazebo Classic topology |  |
| Zenoh peer/re-key bridge, if used |  |
| Local validation command/result |  |
| Hosted CI/audit runs |  |
| Validator/date |  |

## Checklist

The **Automated** column describes repository coverage, not a result for this
candidate:

- ✅ deterministic automated boundary coverage exists;
- 🟡 partial coverage exists, but the live path still needs observation; and
- ⬜ target environment/operator evidence only.

| Step | Expected result | Automated | Result |
|------|-----------------|-----------|--------|
| Start app | Native app launches; viewer and diagnostics render without crash | 🟡 component/IPC smoke; GPU launch manual |  |
| Diagnostics | Platform, backend, mode, availability, and MLX opt-in state match the environment; raw path is not mislabeled zero-copy | 🟡 value/label guards; live values manual |  |
| Camera lifecycle | Add/select/remove cameras; feed/export works; total cameras/render pixels stop at documented limits | 🟡 state/detection-loop coverage |  |
| Detection | Valid model returns structured detections; missing/wrong model returns a structured error without UI crash | 🟡 backend error tests; real model manual |  |
| Benchmark/cancel | Progress updates and cancel clears busy state; record command/hardware/model if retaining numbers | ⬜ |  |
| Save scene | Valid `.json` saves in Tauri mode and replacement is atomic from the user's perspective | 🟡 negative native IPC tests; valid filesystem path manual |  |
| Load/migrate scene | Valid current and older fixture restore; malformed/non-JSON/>10 MiB/schema-invalid files fail before mutating live state | ✅ schema/migration/bounds; live UI observation manual |  |
| Restore assets | Relative/HTTPS/loopback sources restore sequentially; self-contained GLBs and splats appear with transforms; one bad asset produces an explicit partial failure | 🟡 loader/scene tests; renderer/network manual |  |
| Asset ceilings | Oversized splat, GLB, aggregate GLB, embedded image, and floor PNG/JPEG are rejected; remote download timeout is visible | ✅ parser/fetch bounds; real timeout/render manual |  |
| WebSocket default | ROS panel defaults to rosbridge WebSocket, uses its URL field, and shares that bridge with fusion sensors | 🟡 hook/integration coverage; live bridge manual |  |
| ROS 1 / Gazebo Classic | Connect to the recorded ROS 1 graph; ModelStates, pose, custom fusion arrays, and documented Gazebo Classic services behave | ⬜ |  |
| Gazebo mutation | Invalid names/poses/>256 KiB/privileged caller XML fail; bundled Maverick fixed path works only in trusted test topology; spawn/delete require `success=true` | 🟡 validation/reply tests; live service manual |  |
| Unsafe XML opt-in | With variable unset, native privileged XML fails; if deliberately tested with `CREBAIN_ALLOW_UNSAFE_GAZEBO_XML=1`, record isolated topology and restore it to unset | ✅ native policy tests; bypass deployment manual |  |
| Raw camera schema | `rgba8`/`bgra8`/`rgb8`/`bgr8`/`mono8` valid fixture renders; invalid dimensions, step, exact length, timestamp, or >64 MiB frame fails safely | ✅ transport parser tests; live rendering manual |  |
| Compressed camera schema | Valid PNG/JPEG renders; format/signature mismatch, invalid base64, JSON byte array, or oversized decoded dimensions fails safely | ✅ transport parser tests; live rendering manual |  |
| CameraInfo | Finite K9/R9/P12 and correct standard/custom D lengths work; malformed arrays are rejected on both transports | ✅ rosbridge/CDR parser tests |  |
| Native Zenoh | Connection state is visible; only typed camera/CameraInfo/IMU/Pose/ModelStates and pose/twist publishing are used | 🟡 bridge tests; real peer manual |  |
| Zenoh unsupported paths | Gazebo services, MAVROS state/odometry helpers, and custom fusion arrays report unsupported instead of silently doing nothing | ✅ frontend capability guards |  |
| ROS 2 re-keying | Any direct `rmw_zenoh_cpp` claim uses and records an explicit key-rewriting bridge; env selection alone is not accepted | ⬜ |  |
| Fusion reconnect | Disconnect clears/ages native and UI state as documented; reconnect recovers without overlapping batches or stale tracks | 🟡 hook/native lifecycle tests; live transport manual |  |
| PID JSONL | Operator-approved path appends parseable lines; I/O failure does not block fusion; result is labeled local parser/NIS smoke only | 🟡 serialization/sink tests; filesystem permissions manual |  |
| NCP feature | Default UI exposes no NCP control; feature tests pass; if integration wiring is under test, stale/invalid commands end in zero-velocity HOLD | ✅ feature/unit contract; live Engram path absent by default |  |
| Keyboard/emergency | Documented shortcuts work; Escape emergency disarm remains active; keys reset on blur/visibility loss | 🟡 keyboard tests; shell behavior manual |  |
| Close app | App exits without panic, hung service futures, or lingering transport tasks | ⬜ |  |

## Failure triage

- **Release-blocking:** crash, panic, failed required gate, scene data loss, hidden
  partial restore, unsafe external input acceptance, stale actuation, or misleading
  backend/transport/model capability.
- **Needs measurement:** latency, FPS, accuracy, fusion quality, throughput,
  scientific validity, or target-hardware safety.
- **Documentation follow-up:** UI behavior or a wire/file/model contract differs
  from README, SECURITY, ROS/NCP/model docs, or this checklist.
