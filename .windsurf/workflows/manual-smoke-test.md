---
description: Run the CREBAIN manual smoke checklist
---

Use this workflow after automated validation passes and before tagging, demoing, or presenting a release candidate.

1. Record the current commit hash and intended app mode.
// turbo
2. Run `git status --short` and confirm that the working tree state is intentional.
3. Open `docs/MANUAL_SMOKE_TEST.md` and fill in the Environment Record.
4. Start the relevant app mode:
   - Frontend-only: `bun run dev`
   - Full Tauri app: `bun run tauri:dev`
5. Execute each checklist row in `docs/MANUAL_SMOKE_TEST.md`.
6. For detector or benchmark results, record model file, digest, backend, hardware, fixture inputs, threshold settings, and the exact invocation or UI action.
7. For ROS/Zenoh checks, record whether the run used rosbridge WebSocket mode, Zenoh transport mode, or both.
8. Classify each finding as release-blocking, needs measurement, documentation follow-up, or non-blocking observation.
9. Stop the app and confirm no dev server, transport subscription, or simulator process remains unexpectedly active.
10. If docs changed during the smoke test, run `git diff --check`; run `bun run validate:all` for Rust, IPC, transport, model-loading, or integration-affecting changes.
