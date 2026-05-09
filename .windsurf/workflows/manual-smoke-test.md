---
description: Run the CREBAIN manual smoke checklist
---

Use this workflow after automated validation passes and before tagging or presenting a release candidate.

1. Record the current commit hash.
// turbo
2. Run `git status --short` and confirm the working tree state you intend to test.
3. Open `docs/MANUAL_SMOKE_TEST.md` and fill in the Environment Record.
4. Start the relevant app mode:
   - Frontend-only: `bun run dev`
   - Full Tauri app: `bun run tauri:dev`
5. Execute each checklist row in `docs/MANUAL_SMOKE_TEST.md`.
6. For any detector or benchmark result, record model file, backend, hardware, threshold settings, and whether benchmark tests were explicitly enabled.
7. For ROS/Zenoh checks, record whether the test used rosbridge WebSocket mode or Zenoh transport mode.
8. Classify each finding as release-blocking, needs measurement, documentation follow-up, or non-blocking observation.
9. Stop the app and confirm no dev server or transport process remains unexpectedly active.
10. If any docs changed during the smoke test, run `bun run validate` for documentation/source-contract checks and `bun run validate:all` for Rust, IPC, transport, or integration-affecting changes.
