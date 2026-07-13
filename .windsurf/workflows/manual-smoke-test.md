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
   - Galadriel producer: an `ncp`-feature Tauri build with the exact documented
     runtime env, registry/config/executable pins, and deployment-controlled
     `NCP_ZENOH_CONFIG` (never reuse placeholder values from `.env.example`)
5. Execute each checklist row in `docs/MANUAL_SMOKE_TEST.md`.
6. For detector or benchmark results, record model file, digest, backend, hardware, fixture inputs, threshold settings, and the exact invocation or UI action.
7. For ROS/Zenoh checks, record whether the run used rosbridge WebSocket mode,
   telemetry Zenoh mode, or Galadriel NCP mode. For the producer also record the
   exact two keys, producer epoch/identity, registry and effective-config digests,
   sensor-clock behavior, upstream/track-cap and queue/drop/degraded state,
   heartbeat observations, receiver/topology receive-size limits, and
   positive/negative ACL and oversize results. A local put is not receiver
   delivery, and numeric upstream loss is currently log-only.
8. Classify each finding as release-blocking, needs measurement, documentation follow-up, or non-blocking observation.
9. Stop the app and confirm no dev server, transport subscription, Galadriel
   producer task, PID JSONL archive writer, or simulator process remains
   unexpectedly active; record any writer that exceeds its two-second exit wait.
10. If docs changed during the smoke test, run `git diff --check`; run `bun run validate:all` for Rust, IPC, transport, model-loading, or integration-affecting changes.
