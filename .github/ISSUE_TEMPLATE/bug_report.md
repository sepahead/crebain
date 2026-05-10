---
name: Bug Report
about: Report a reproducible defect in CREBAIN
title: "[BUG] "
labels: bug
assignees: ""
---

## Summary

Describe the defect clearly and concisely.

## Impact

- [ ] Crash, panic, or app hang
- [ ] Incorrect UI behavior
- [ ] Incorrect ML/detection behavior
- [ ] ROS, Zenoh, or transport regression
- [ ] Scene persistence or data-loss risk
- [ ] Security or validation boundary issue

## Steps to Reproduce

1. Open CREBAIN in:
2. Configure:
3. Perform:
4. Observe:

## Expected Behavior

What should happen?

## Actual Behavior

What happened instead?

## Environment

- **Commit / version**:
- **App mode**: `bun run dev` / `bun run tauri:dev` / packaged build
- **OS / hardware**:
- **Frontend shell**: browser / Tauri webview
- **Backend(s)**: CoreML / ONNX / CUDA / TensorRT / MLX
- **Model file(s)**:
- **ROS / Zenoh topology**:

## Logs and Screenshots

```text
Paste relevant logs, panic messages, screenshots, or console output here.
```

## Validation

- **Command(s) run**: `bun run validate` / `bun run validate:all` / other
- **Result**: pass / fail / not run

## Evidence Notes

If the report involves performance, ML output quality, ROS/Gazebo behavior, transport latency, or safety/security boundaries, include measurements, model/backend details, topology, or authoritative references where applicable.
