# CREBAIN Manual Smoke Test

Run this checklist after automated validation when preparing a release candidate or reviewing a cross-cutting stabilization batch. Record the platform, commit hash, model files, and any deviations from expected behavior.

## Environment Record

| Field | Value |
|-------|-------|
| Commit |  |
| OS / Hardware |  |
| App Mode | `bun run dev` / `bun run tauri:dev` / packaged build |
| Model Files |  |
| ROS / Zenoh Setup |  |
| Validator |  |
| Date |  |

## Checklist

| Step | Expected Result | Result |
|------|-----------------|--------|
| Start app | App launches without crash; main viewer renders |  |
| Open diagnostics | `get_system_info` returns platform, backend, mode, available backends, and MLX opt-in status |  |
| Confirm diagnostic mode | Native raw path reports `raw-rgba`; no UI or logs describe it as `zero-copy` unless measuring a real zero-copy path |  |
| Add or select camera | Camera object appears in the scene and camera feed/export path remains usable |  |
| Run detector test | Success or failure is reported as a structured diagnostic message; missing model files do not crash the UI |  |
| Run benchmark then cancel | Benchmark progress updates; cancellation stops the run without leaving stale busy state |  |
| Save scene | Valid `.json` scene path saves successfully in Tauri mode |  |
| Load scene | Saved scene loads and malformed/non-JSON files are rejected |  |
| ROS websocket mode | URL field is used only for rosbridge mode; connection state and errors are visible |  |
| Zenoh transport mode | Zenoh mode does not require a rosbridge URL; connect/disconnect state is visible |  |
| Transport subscriptions | Expected topics map to deterministic safe Tauri event names |  |
| Fusion display | Tracks/stats render or show an explicit empty/disabled state |  |
| Keyboard shortcuts | Documented shortcuts work and do not conflict with browser/system shortcuts in the tested shell |  |
| Close app | App exits without panic or hanging transport tasks |  |

## Failure Triage

- **Release-blocking**: crash, panic, failed validation, data loss in scene persistence, unvalidated external input acceptance, or misleading backend/ML capability display.
- **Needs measurement**: latency, FPS, detection accuracy, fusion quality, transport throughput, or target-hardware performance claims.
- **Documentation follow-up**: UI behavior differs from README, SECURITY, model docs, or GitHub templates.
