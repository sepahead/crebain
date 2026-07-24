---
description: Run the CREBAIN manual smoke checklist
---

Use this workflow after automated validation passes. Use it before a demo or an
operational, deployment, field, or 1.0 readiness claim. The 0.9 research
prerelease can have pending rows only under the exclusions in
`docs/NARROWED_GO_0.9.0.md`.

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
6. For detector or benchmark results, record:
   - the model file and digest
   - the backend and hardware
   - the fixture inputs and threshold settings
   - the exact invocation or user-interface action
7. For ROS or Zenoh checks, record the transport mode. Use one of these values:
   - rosbridge WebSocket
   - Zenoh telemetry
   - Galadriel NCP
8. For the Galadriel producer, also record:
   - the two exact keys and producer epoch or identity
   - the registry and effective-configuration digests
   - the sensor-clock behavior
   - the upstream limit, track limit, queue state, drop state, and degraded state
   - the heartbeat observations
   - the receiver and topology receive-size limits
   - the positive and negative ACL and oversize results
9. Do not treat a local put as receiver delivery. Numeric upstream loss is
   currently available only in logs.
10. Classify each finding as release-blocking, needs measurement,
    documentation follow-up, or a non-blocking observation.
11. Stop the app.
12. Make sure that no related process remains unexpectedly active. This check
    includes the dev server, transport subscription, producer, archive writer,
    and simulator.
13. Record each writer that exceeds its two-second exit wait.
14. If documentation changed during the test, run `git diff --check`.
15. For Rust, IPC, transport, model-loading, or integration changes, run
    `bun run validate:all`.
