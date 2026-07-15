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
| Native detector benchmark (only when retaining a numeric claim) | Archive clean commit, exact command/report and digest, approved model/fixture digests, external target-runtime context, trusted baseline digest, and pre-approved threshold per `NATIVE_DETECTOR_BENCHMARK.md` | 🟡 harness logic tests only; real target run manual |  |
| Save scene | Valid `.json` saves in Tauri mode and replacement is atomic from the user's perspective | 🟡 negative native IPC tests; valid filesystem path manual |  |
| Load/migrate scene | Valid current and older fixture restore; malformed/non-JSON/>10 MiB/schema-invalid files fail before mutating live state | ✅ schema/migration/bounds; live UI observation manual |  |
| Restore assets | Relative/HTTPS/loopback sources restore sequentially; self-contained GLBs and splats appear with transforms; one bad asset produces an explicit failure, clears every partial restored object, and leaves physics paused | 🟡 loader/transaction tests; renderer/network manual |  |
| Asset ceilings | Oversized splat, GLB, aggregate GLB source/decoded/resident/render/expanded-metadata work, embedded image, and floor PNG/JPEG are rejected; loader-expanded primitive/texture paths fail preflight; rapid splat replacement cancels acquisition; remote GLB capacity is reserved before fetch; stale GLB parse capacity remains held until settlement; remote download timeout is visible | ✅ parser/fetch/resource-reservation/cancellation bounds; real timeout/render manual |  |
| Production transport boundary | Packaged UI defaults/stays on Zenoh; fusion connection UI cannot select the disabled adapter; no WebSocket option/client or rosbridge socket origin is present; exposed ROS bridge is telemetry-only; any Galadriel output is the separately inventoried two-key feature/runtime exception | ✅ production-profile interaction plus module-graph/chunk/CSP/API guards; live peers manual |  |
| Development rosbridge telemetry | Vite development can select rosbridge, uses its URL field, and shares a read-only telemetry facade with fusion sensors | 🟡 hook/integration coverage; live bridge manual |  |
| ROS 1 / Gazebo Classic telemetry | Connect to the recorded graph; ModelStates, pose, and applicable development sensor arrays are observable without a publish/service path | ⬜ |  |
| Removed command surfaces | Renderer/native generic publish, pose/twist/setpoint, MAVROS mode/mission, Gazebo spawn/reset/delete/service APIs and the old XML bypass variable remain absent | ✅ executable-input manifest, AST/token scan, and computed-route/capability fixtures |  |
| Raw camera schema | `rgba8`/`bgra8`/`rgb8`/`bgr8`/`mono8` valid fixture renders; invalid dimensions, step, exact length, timestamp, or >64 MiB frame fails safely; concurrent worst-case topics trigger drop-new backpressure under the shared 384 MiB native camera-work envelope; only a canonical nonzero-u64 delivery/lifecycle/subscription readiness descriptor is emitted and the large pull remains reserved through exact acknowledgement or a 30-second monotonic native lease; event-listener registration plus native declaration share a 12-second setup deadline with late-handle cleanup, while pull/listener/acknowledgement deadlines are 10/8/4 seconds; one topic runs one complete delivery at a time with at most one prevalidated descriptor pending, a non-settling listener is quarantined without removing healthy peers, and malformed readiness or IPC failure deactivates the exact topic; expiry attempts bounded exact undeclaration and retains quarantine on failure; unsubscribe/reopen rejects superseded callbacks and cleanup, and reopen removes a quarantined declaration before installing a new identity | ✅ transport parser, weighted-admission, pull/ack/expiry, paused-time setup/delivery timeout and teardown, exact setup cleanup, u64-boundary, serialized-delivery, and stale/reopened-listener tests; live rendering manual |  |
| Compressed camera schema | Valid PNG/JPEG renders; format/signature mismatch, invalid base64, JSON byte array, or oversized decoded dimensions fails safely | ✅ transport parser tests; live rendering manual |  |
| CameraInfo | Finite K9/R9/P12 and correct standard/custom D lengths work; malformed arrays are rejected on both transports | ✅ rosbridge/CDR parser tests |  |
| Native Zenoh | Connection state is visible; only typed camera/CameraInfo/IMU/Pose/ModelStates subscriptions are used | 🟡 bridge tests; real peer manual |  |
| Zenoh narrow surface | Gazebo services, MAVROS command/state helpers, and custom fusion arrays are absent from the exposed production interface | ✅ frontend capability/API guards |  |
| ROS 2 re-keying | Any direct `rmw_zenoh_cpp` claim uses and records an explicit key-rewriting bridge; env selection alone is not accepted | ⬜ |  |
| Fusion reconnect | Disconnect clears/ages native and UI state as documented; reconnect recovers without overlapping batches or stale tracks | 🟡 hook/native lifecycle tests; live transport manual |  |
| Local preview reset | Preview is `NoAuthority`/`Hold`; disable, disconnect, transport switch, and off→on abort and clear missions, trajectories, proposals, and controller snapshots with no resurrection | ✅ hook regression |  |
| PID JSONL | `ncp` startup preflights the configured regular local sink; an invalid record writes none of its batch; no-producer storage latency delays the blocking fusion job; active producer drops newest at the capacity-16 archive boundary, and admission/write/flush failure latches degradation (worker I/O failure also stops the worker); exit waits at most two seconds; FIFO/device/socket/slow-mount cases are excluded operationally | 🟡 batch-validation/flush-failure component tests; queue saturation, filesystem type/latency, partial OS write, and shutdown observation manual |  |
| NCP action/control feature | Default UI exposes no NCP control; missing `NCP_ZENOH_CONFIG` fails secure connect; quiet development is explicit; lifecycle replies require `ok`; stale/invalid commands HOLD; raw ESTOP latches; stop drops the subscriber and requests final HOLD | ✅ feature/unit contract; live Engram/TLS/ACL evidence absent by default |  |
| Galadriel default-off gates | Default release lacks `ncp`; a non-feature binary with `ENABLE=1` fails; an `ncp` build with switch absent/`0` opens no producer; any ambiguous switch fails | ✅ component startup-policy tests; inspect exact artifact/features manually |  |
| Galadriel pin preflight | Empty/oversized/unknown-field fusion config, registry/config/software digest mismatch, absent frame/context, invalid capacity/deadline, or missing secure config fails before a producer session; exact post-package executable/effective config/registry pins succeed; active `fusion_init` ignores renderer defaults as readiness-only and config replacement accepts only the same digest | ✅ parser/digest/identity/config-immutability component tests; post-package artifact manual |  |
| Galadriel exact routes / ACL | Producer principal can put only `{realm}/session/{epoch}/sensor/galadriel-pid` and `.../galadriel-monitor`; wildcard, command, action, service, final-route, and wrong-principal writes are denied | 🟡 route golden tests; live TLS/principal/router allow+deny campaign required |  |
| Galadriel frame/time evidence | Matching already-canonical ENU `source_frame_id` with an empty transform chain and an advancing frame-equal/per-channel-newer sensor timestamp can carry v1/projection; duplicate, OOSM, mixed-old, missing/different identity, or any transform chain remains explicitly incomparable; zero initializes the clock and deleted tracks lose timestamp state | ✅ identity/exact-time/component purge tests; sensor provenance/calibration remain external |  |
| Galadriel renderer clock/input loss | One detector pass gives every visual track one stamp; nonempty/empty/mixed cycles remain on the monotonic sensor high-water, committed only after native success. Malformed or buffer-trimmed input and native registry trimming retain newest entries and close a degraded/truncated frame | ✅ renderer/native regression tests; record upstream counts in logs because the frozen summary has no numeric field |  |
| Galadriel computational envelope | Reject >512 inputs, >1,024 live-track growth, excessive position/range/velocity/covariance/metadata/string values, non-wire-safe loss counts, and invalid internal gate scores before evidence mutation; track-cap overflow discards whole clusters and the next bounded frame recovers | ✅ input/capacity/invalid-gate component tests; target combined-load/deadline trace pending |  |
| Galadriel queue/degradation | Saturate each lane independently; drop-new counts, sequence gaps, summary truncated/degraded state, sticky epoch degradation, and system diagnostics agree | ✅ deterministic component queue tests; combined-process load manual |  |
| Galadriel assignment/load | Exercise disconnected sparse components and the maximum all-infinite matrix, then run 512-input/1,024-track fusion together with saturated evidence lanes, slow puts, receiver decode, and optional JSONL | 🟡 sparse/all-infinite component tests; combined process/topology deadline evidence manual |  |
| Galadriel heartbeat/liveness | A zero-input producer generates monitor heartbeats; receiver observes declared interval/deadline or records violation; older-event/slow-put backlog is tested rather than assumed timely | 🟡 heartbeat lane/generation component tests; receiver deadline and impairment manual |  |
| Galadriel receiver correlation | Receiver pins the same registry and reports envelope decode, producer/session identity, both-route join, misses/outcomes/summaries, gaps, restart epoch, duplicates/reorder/loss, and acceptance separately from local put success; router/receiver size limits accept every permitted envelope and reject oversized payloads | ⬜ external Galadriel tap/assembler/topology/receive-size evidence |  |
| Vite-dev NCP harness | Manual `window.__ncpDrone` active command uses exact finite m/s vec3 and bounded horizon; malformed/null calls do not move; drone streams stay independent; ESTOP reset requires a fresh command | ✅ unit contract; transport-free browser injection only |  |
| Keyboard/emergency | Documented shortcuts work; Escape emergency disarm remains active; keys reset on blur/visibility loss | 🟡 keyboard tests; shell behavior manual |  |
| Close app | App exits without panic, hung service futures, lingering transport subscriptions, or Galadriel NCP producer tasks; when JSONL is enabled, separately verify the archive writer finishes its two-second wait (a blocked standard thread is not forcibly aborted); do not infer queued evidence reached a receiver | 🟡 producer task/shutdown component tests; process/network/storage observation manual |  |

## Failure triage

- **Release-blocking:** crash, panic, failed required gate, scene data loss, hidden
  partial restore, unsafe external input acceptance, stale actuation, or misleading
  backend/transport/model capability.
- **Needs measurement:** latency, FPS, accuracy, fusion quality, throughput,
  scientific validity, or target-hardware safety.
- **Documentation follow-up:** UI behavior or a wire/file/model contract differs
  from README, SECURITY, ROS/NCP/model docs, or this checklist.
