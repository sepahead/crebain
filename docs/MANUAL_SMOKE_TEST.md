# CREBAIN Manual Smoke Test

Run this checklist after automated validation when preparing a release candidate, demo build, or cross-cutting stabilization batch. Record platform details, commit hash, model files, transport mode, and any deviation from expected behavior.

## Environment Record

| Field | Value |
|-------|-------|
| Commit |  |
| OS / Hardware |  |
| App Mode | `bun run dev` / `bun run tauri:dev` / packaged build |
| Model Files |  |
| Detection Backend | CoreML / ONNX / CUDA / TensorRT / MLX |
| ROS / Zenoh Setup |  |
| Validation Command |  |
| Validator |  |
| Date |  |

## Checklist

The **Automated** column records whether the row has automated-test backing:
- ✅ covered by `bun run validate:all` (no manual run needed unless investigating a regression)
- 🟡 partially covered (the listed tests reduce, but do not replace, the manual check)
- ⬜ manual only (requires a real app/GPU/network/model and an operator)

| Step | Expected Result | Automated | Result |
|------|-----------------|-----------|--------|
| Start app | App launches without crash; main viewer renders | 🟡 viewer panel render smoke (`viewer/__tests__/viewerPanels.test.tsx`); full GPU launch is manual |  |
| Open diagnostics | `get_system_info` returns platform, backend, mode, available backends, and MLX opt-in status | 🟡 `get_system_info`/diagnostics unit tests; live values manual |  |
| Confirm diagnostic mode | Native raw path reports `raw-rgba`; no UI or logs describe it as `zero-copy` unless measuring a real zero-copy path | ✅ `ciWorkflow.test.ts` honesty guardrails |  |
| Add or select camera | Camera object appears in the scene and camera feed/export path remains usable | ⬜ |  |
| Run detector test | Success or failure is reported as a structured diagnostic message; missing model files do not crash the UI | 🟡 detector error-path unit tests; live model run manual |  |
| Run benchmark then cancel | Benchmark progress updates; cancellation stops the run without leaving stale busy state | ⬜ |  |
| Save scene | Valid `.json` scene path saves successfully in Tauri mode | 🟡 `scene_save_file` AppHandle-backed negative tests; valid write is manual |  |
| Load scene | Saved scene loads and malformed/non-JSON files are rejected | ✅ scene path/JSON validation + migration tests |  |
| ROS websocket mode | URL field is used only for rosbridge mode; connection state and errors are visible | 🟡 rosbridge URL/connection unit tests; live bridge manual |  |
| Zenoh transport mode | Zenoh mode does not require a rosbridge URL; connect/disconnect state is visible | ⬜ |  |
| Transport subscriptions | Expected topics map to deterministic safe Tauri event names | ✅ transport topic/event-name tests |  |
| Transport publish path | Invalid topics, non-finite numeric payloads, invalid timestamps, and invalid frame IDs are rejected before publish | ✅ transport publish validation tests |  |
| Gazebo spawn service path | Invalid spawn names/XML/poses are rejected; successful spawn is only claimed when a target Gazebo/rosbridge setup is connected | 🟡 spawn-payload validation tests; live spawn manual |  |
| Raw image transport | Malformed raw image metadata does not crash the app and is surfaced as a controlled transport error | ✅ CDR/image-metadata validation tests |  |
| Fusion display | Tracks/stats render or show an explicit empty/disabled state | ✅ `DetectionPanel` render smoke + fusion scenario tests |  |
| Keyboard shortcuts | Documented shortcuts work and do not conflict with browser/system shortcuts in the tested shell | 🟡 shortcut constant/registration tests; live keys manual |  |
| Close app | App exits without panic or hanging transport tasks | ⬜ |  |

## Failure Triage

- **Release-blocking**: crash, panic, failed validation, data loss in scene persistence, unvalidated external input acceptance, or misleading backend/ML capability display.
- **Needs measurement**: latency, FPS, detection accuracy, fusion quality, transport throughput, or target-hardware performance claims.
- **Documentation follow-up**: UI behavior differs from README, SECURITY, model docs, or GitHub templates.
