# CREBAIN manual smoke test

For a release candidate, demo, or cross-cutting stabilization batch, first run
the automated validation. Then, run this checklist. Do not reuse results from a
different commit, model, platform, or ROS or Zenoh topology.

## Environment record

| Field | Value |
|-------|-------|
| Commit |  |
| OS / hardware |  |
| App mode | `bun run tauri:dev` / packaged build |
| Model file + digest |  |
| Detection backend | CoreML / ONNX / CUDA / TensorRT / MLX |
| Native benchmark report/baseline digests, if claimed |  |
| ROS 1 / Gazebo Classic topology |  |
| Zenoh peer/re-key bridge, if used |  |
| Cargo features / Galadriel switch | Default / `ncp`; absent / `0` / `1` |
| Galadriel realm, producer ID, epoch |  |
| Registry path + canonical digest + frame/context |  |
| Fusion config source + effective canonical digest |  |
| Final executable path + SHA-256 |  |
| NCP config / router / receiver / TLS-ACL evidence IDs |  |
| Local validation command/result |  |
| Hosted CI/audit runs |  |
| Validator/date |  |

## Checklist

The **Automated** field describes repository coverage, not a result for this
candidate:

- ✅ deterministic automated boundary coverage exists;
- 🟡 partial coverage exists, but the live path still needs observation.
- ⬜ target environment/operator evidence only.

### Start app

- **Expected result:** Native app launches; viewer and diagnostics render without crash

- **Automated:** 🟡 component/IPC smoke; GPU launch manual

- **Result:**

### Diagnostics

- **Expected result:** Platform, backend, mode, availability, and MLX opt-in state match the environment; raw path is not mislabeled zero-copy

- **Automated:** 🟡 value/label guards; live values manual

- **Result:**

### Camera lifecycle

- **Expected result:** Add/select/remove cameras; feed/export works; total cameras/render pixels stop at documented limits

- **Automated:** 🟡 state/detection-loop coverage

- **Result:**

### Detection

- **Expected result:** Valid model returns structured detections; missing/wrong model returns a structured error without UI crash

- **Automated:** 🟡 backend error tests; real model manual

- **Result:**

### Native detector benchmark (only when retaining a numeric claim)

- **Expected result:** Archive clean commit, exact command/report and digest, approved model/fixture digests, external target-runtime context, trusted baseline digest, and pre-approved threshold per `NATIVE_DETECTOR_BENCHMARK.md`

- **Automated:** 🟡 harness logic tests only; real target run manual

- **Result:**

### Save scene

- **Expected result:** Valid `.json` saves in Tauri mode and replacement is atomic from the user's perspective

- **Automated:** 🟡 negative native IPC tests; valid filesystem path manual

- **Result:**

### Load/migrate scene

- **Expected result:** Valid current and older fixture restore; malformed/non-JSON/>10 MiB/schema-invalid files fail before mutating live state

- **Automated:** ✅ schema/migration/bounds; live UI observation manual

- **Result:**

### Restore assets

- **Expected result:** Relative/HTTPS/loopback sources restore sequentially; self-contained GLBs and splats appear with transforms; one bad asset produces an explicit failure, clears every partial restored object, and leaves physics paused

- **Automated:** 🟡 loader/transaction tests; renderer/network manual

- **Result:**

### Asset ceilings

- **Expected result:** Oversized splat, GLB, aggregate GLB source/decoded/resident/render/expanded-metadata work, embedded image, and floor PNG/JPEG are rejected; loader-expanded primitive/texture paths fail preflight; rapid splat replacement cancels acquisition; remote GLB capacity is reserved before fetch; stale GLB parse capacity remains held until settlement; remote download timeout is visible

- **Automated:** ✅ parser/fetch/resource-reservation/cancellation bounds; real timeout/render manual

- **Result:**

### Production transport boundary

- **Expected result:** Packaged UI defaults/stays on Zenoh; fusion connection UI cannot select the disabled adapter; no WebSocket option/client or rosbridge socket origin is present; exposed ROS bridge is telemetry-only; any Galadriel output is the separately inventoried two-key feature/runtime exception

- **Automated:** ✅ production-profile interaction plus module-graph/chunk/CSP/API guards; live peers manual

- **Result:**

### Development rosbridge telemetry

- **Expected result:** Vite development can select rosbridge, uses its URL field, and shares a read-only telemetry facade with fusion sensors

- **Automated:** 🟡 hook/integration coverage; live bridge manual

- **Result:**

### ROS 1 / Gazebo Classic telemetry

- **Expected result:** Connect to the recorded graph; ModelStates, pose, and applicable development sensor arrays are observable without a publish/service path

- **Automated:** ⬜

- **Result:**

### Removed command surfaces

- **Expected result:** Renderer/native generic publish, pose/twist/setpoint, MAVROS mode/mission, Gazebo spawn/reset/delete/service APIs and the old XML bypass variable remain absent

- **Automated:** ✅ executable-input manifest, AST/token scan, and computed-route/capability fixtures

- **Result:**

### Raw camera schema

- **Expected result:** `rgba8`/`bgra8`/`rgb8`/`bgr8`/`mono8` valid fixture renders; invalid dimensions, step, exact length, timestamp, or >64 MiB frame fails safely; concurrent worst-case topics trigger drop-new backpressure under the shared 384 MiB native camera-work envelope; only a canonical nonzero-u64 delivery/lifecycle/subscription readiness descriptor is emitted and the large pull remains reserved through exact acknowledgement or a 30-second monotonic native lease; event-listener registration plus native declaration share a 12-second setup deadline with late-handle cleanup, while pull/listener/acknowledgement deadlines are 10/8/4 seconds; one topic runs one complete delivery at a time with at most one prevalidated descriptor pending, a non-settling listener is quarantined without removing healthy peers, and malformed readiness or IPC failure deactivates the exact topic; expiry attempts bounded exact undeclaration and retains quarantine on failure; unsubscribe/reopen rejects superseded callbacks and cleanup, and reopen removes a quarantined declaration before installing a new identity

- **Automated:** ✅ transport parser, weighted-admission, pull/ack/expiry, paused-time setup/delivery timeout and teardown, exact setup cleanup, u64-boundary, serialized-delivery, and stale/reopened-listener tests; live rendering manual

- **Result:**

### Compressed camera schema

- **Expected result:** Valid PNG/JPEG renders; format/signature mismatch, invalid base64, JSON byte array, or oversized decoded dimensions fails safely

- **Automated:** ✅ transport parser tests; live rendering manual

- **Result:**

### CameraInfo

- **Expected result:** Finite K9/R9/P12 and correct standard/custom D lengths work; malformed arrays are rejected on both transports

- **Automated:** ✅ rosbridge/CDR parser tests

- **Result:**

### Native Zenoh

- **Expected result:** Connection state is visible; only typed camera/CameraInfo/IMU/Pose/ModelStates subscriptions are used

- **Automated:** 🟡 bridge tests; real peer manual

- **Result:**

### Zenoh narrow surface

- **Expected result:** Gazebo services, MAVROS command/state helpers, and custom fusion arrays are absent from the exposed production interface

- **Automated:** ✅ frontend capability/API guards

- **Result:**

### ROS 2 re-keying

- **Expected result:** Any direct `rmw_zenoh_cpp` claim uses and records an explicit key-rewriting bridge; env selection alone is not accepted

- **Automated:** ⬜

- **Result:**

### Fusion reconnect

- **Expected result:** Disconnect clears/ages native and UI state as documented; reconnect recovers without overlapping batches or stale tracks

- **Automated:** 🟡 hook/native lifecycle tests; live transport manual

- **Result:**

### Local preview reset

- **Expected result:** Preview is `NoAuthority`/`Hold`; disable, disconnect, transport switch, and off→on abort and clear missions, trajectories, proposals, and controller snapshots with no resurrection

- **Automated:** ✅ hook regression

- **Result:**

### PID JSONL

- **Expected result:** `ncp` startup preflights the configured regular local sink; an invalid record writes none of its batch; no-producer storage latency delays the blocking fusion job; active producer drops newest at the capacity-16 archive boundary, and admission/write/flush failure latches degradation (worker I/O failure also stops the worker); exit waits at most two seconds; FIFO/device/socket/slow-mount cases are excluded operationally

- **Automated:** 🟡 batch-validation/flush-failure component tests; queue saturation, filesystem type/latency, partial OS write, and shutdown observation manual

- **Result:**

### NCP action/control feature

- **Expected result:** Default UI exposes no NCP control; missing `NCP_ZENOH_CONFIG` fails secure connect; quiet development is explicit; lifecycle replies require `ok`; stale/invalid commands HOLD; raw ESTOP latches; stop drops the subscriber and requests final HOLD

- **Automated:** ✅ feature/unit contract; live Engram/TLS/ACL evidence absent by default

- **Result:**

### Galadriel off-by-default gates

- **Expected result:** Default release lacks `ncp`; a non-feature binary with `ENABLE=1` fails; an `ncp` build with switch absent/`0` opens no producer; any ambiguous switch fails

- **Automated:** ✅ component startup-policy tests; inspect exact artifact/features manually

- **Result:**

### Galadriel pin preflight

- **Expected result:** Empty/oversized/unknown-field fusion config, registry/config/software digest mismatch, absent frame/context, invalid capacity/deadline, or missing secure config fails before a producer session; exact post-package executable/effective config/registry pins succeed; active `fusion_init` ignores renderer defaults as readiness-only and config replacement accepts only the same digest

- **Automated:** ✅ parser/digest/identity/config-immutability component tests; post-package artifact manual

- **Result:**

### Galadriel exact routes / ACL

- **Expected result:** Producer principal can put only `{realm}/session/{epoch}/sensor/galadriel-pid` and `.../galadriel-monitor`; wildcard, command, action, service, final-route, and wrong-principal writes are denied

- **Automated:** 🟡 route golden tests; live TLS/principal/router allow+deny campaign required

- **Result:**

### Galadriel frame/time evidence

- **Expected result:** Matching already-canonical ENU `source_frame_id` with an empty transform chain and an advancing frame-equal/per-channel-newer sensor timestamp can carry v1/projection; duplicate, OOSM, mixed-old, missing/different identity, or any transform chain remains explicitly incomparable; zero initializes the clock and deleted tracks lose timestamp state

- **Automated:** ✅ identity/exact-time/component purge tests; sensor provenance/calibration remain external

- **Result:**

### Galadriel renderer clock/input loss

- **Expected result:** One detector pass gives every visual track one stamp; nonempty/empty/mixed cycles remain on the monotonic sensor high-water, committed only after native success. Malformed or buffer-trimmed input and native registry trimming retain newest entries and close a degraded/truncated frame

- **Automated:** ✅ renderer/native regression tests; record upstream counts in logs because the frozen summary has no numeric field

- **Result:**

### Galadriel computational envelope

- **Expected result:** Reject >512 inputs, >1,024 live-track growth, excessive position/range/velocity/covariance/metadata/string values, non-wire-safe loss counts, and invalid internal gate scores before evidence mutation; track-cap overflow discards whole clusters and the next bounded frame recovers

- **Automated:** ✅ input/capacity/invalid-gate component tests; target combined-load/deadline trace pending

- **Result:**

### Galadriel queue/degradation

- **Expected result:** Saturate each lane independently; drop-new counts, sequence gaps, summary truncated/degraded state, sticky epoch degradation, and system diagnostics agree

- **Automated:** ✅ deterministic component queue tests; combined-process load manual

- **Result:**

### Galadriel assignment/load

- **Expected result:** Exercise disconnected sparse components and the maximum all-infinite matrix, then run 512-input/1,024-track fusion together with saturated evidence lanes, slow puts, receiver decode, and optional JSONL

- **Automated:** 🟡 sparse/all-infinite component tests; combined process/topology deadline evidence manual

- **Result:**

### Galadriel heartbeat/liveness

- **Expected result:** A zero-input producer generates monitor heartbeats; receiver observes declared interval/deadline or records violation; older-event/slow-put backlog is tested rather than assumed timely

- **Automated:** 🟡 heartbeat lane/generation component tests; receiver deadline and impairment manual

- **Result:**

### Galadriel receiver correlation

- **Expected result:** Receiver pins the same registry and reports envelope decode, producer/session identity, both-route join, misses/outcomes/summaries, gaps, restart epoch, duplicates/reorder/loss, and acceptance separately from local put success; router/receiver size limits accept every permitted envelope and reject oversized payloads

- **Automated:** ⬜ external Galadriel tap/assembler/topology/receive-size evidence

- **Result:**

### Vite-dev NCP harness

- **Expected result:** Manual `window.__ncpDrone` active command uses exact finite m/s vec3 and bounded horizon; malformed/null calls do not move; drone streams stay independent; ESTOP reset requires a fresh command

- **Automated:** ✅ unit contract; transport-free browser injection only

- **Result:**

### Engram restricted view

- **Expected result:** Start the reviewed loopback frame. Confirm a fresh context and heartbeat. Confirm native Engram IPC is inaccessible. Stop replies and confirm Engram relocks the frame. Confirm Performance and Sensor Fusion start collapsed while standalone defaults stay expanded.

- **Automated:** 🟡 shared vector/unit coverage; packaged hostile-frame test required

- **Result:**

### Keyboard/simulated disarm

- **Expected result:** Documented shortcuts work; Escape changes simulated state only and emits no NCP, ROS/MAVROS, FCU, or plant command; keys reset on blur/visibility loss

- **Automated:** 🟡 keyboard tests; shell behavior manual

- **Result:**

### Close app

- **Expected result:** App exits without panic, hung service futures, lingering transport subscriptions, or Galadriel NCP producer tasks; when JSONL is enabled, separately verify the archive writer finishes its two-second wait (a blocked standard thread is not forcibly aborted); do not infer queued evidence reached a receiver

- **Automated:** 🟡 producer task/shutdown component tests; process/network/storage observation manual

- **Result:**

## Failure triage

- **Release-blocking:** crash, panic, failed required gate, scene data loss, hidden
  partial restore, unsafe external input acceptance, stale actuation, or misleading
  backend/transport/model capability.
- **Needs measurement:** latency, FPS, accuracy, fusion quality, throughput,
  scientific validity, or target-hardware safety.
- **Documentation follow-up:** UI behavior or a wire/file/model contract differs
  from README, SECURITY, ROS/NCP/model docs, or this checklist.
