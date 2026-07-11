# CREBAIN Security Policy

CREBAIN handles local files, model and asset paths, Tauri IPC, ROS/rosbridge,
Zenoh CDR, and optional telemetry sinks. Treat every external boundary as
untrusted unless this document identifies a narrower trusted-operator contract.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.4.x | Supported |
| < 0.4 | Unsupported |

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's
[private vulnerability reporting flow](https://github.com/sepahead/crebain/security/advisories/new)
or the repository's Security Advisories page.

Include the impact, reproduction steps, affected commit/platform/app mode,
backend or transport path, and a suggested fix if known. The project targets an
acknowledgment within 48 hours and an initial assessment within 7 days; remediation
timing depends on severity.

## Deployment practices

- Restrict rosbridge and Zenoh to trusted networks with deployment-appropriate
  authentication, policy, and transport encryption.
- Run the desktop app and simulator with least privilege.
- Verify model provenance, rights, immutable digest, tensor contract, and fixtures.
- Treat scene JSON, GLB/splat/image assets, Gazebo XML, ROS graph names, CDR, and
  IPC payloads as untrusted.
- Keep `CREBAIN_ALLOW_UNSAFE_GAZEBO_XML` unset outside an isolated,
  trusted-development topology.
- Point `CREBAIN_PID_JSONL` only at an operator-approved local path. It is a
  best-effort append sink, not an authenticated/version-negotiated stream, and its
  track/timing/innovation telemetry may be sensitive.

## Threat model summary

| Boundary | Untrusted inputs | Current controls | Required review before release claims |
|----------|------------------|------------------|---------------------------------------|
| Model loading | Backend environment paths, model files, TensorRT build/cache inputs | Allowed-path/extension checks, MLX `.safetensors` checks and optional SHA-256 pin, missing-model errors, unsupported build-mode rejection | Provenance, rights, exact tensor/class contract, golden fixtures, and target-hardware evidence |
| Scene persistence (native) | Scene path and JSON | Allowed-root `.json` path checks; open-once bounded 10 MiB read; parse then migration; atomic same-directory temp-file save and sync | AppHandle-backed negative paths plus valid save/load smoke |
| Browser scene state | File/blob/localStorage JSON and referenced state | 10 MiB pre-read/UTF-8 bounds; migration before strict schema; unique/referential IDs; finite values; 64 cameras, 256 drones, 128 assets, 10,000 detections, route and render-target caps | Restore cancellation, partial failure, and representative older-version fixtures |
| Browser assets | Splat, GLB, embedded images, floor PNG/JPEG, remote URLs | Streamed byte ceilings despite absent/dishonest `Content-Length`; 30 s remote timeout; source allowlist; GLB 2.0/self-contained manifest checks; embedded image signatures/dimensions; aggregate budgets | Decode/render smoke with malicious/truncated/oversized fixtures and CSP review |
| Native detection IPC | Base64 or RGBA image, dimensions, thresholds, limits | PNG/JPEG inspection; `1..=8192` dimensions; 64 MiB decoded allocation budget; exact raw length; structured failures | Confirm malformed images fail without a frontend crash |
| ROS bridge product UI | WebSocket URL, topic/service names, messages, Gazebo mutations | URL/name/payload validation; visible connection errors; frontend spawn XML cap and privileged-directive rejection; only the fixed bundled Maverick helper may use privileged XML | Restrict network exposure and exercise the target ROS 1 / Gazebo Classic graph |
| Native Gazebo commands | Names, poses/twists, XML, service replies | Finite/magnitude/unit-quaternion guards; 256 KiB XML cap; privileged directives rejected unless the trusted operator explicitly sets `CREBAIN_ALLOW_UNSAFE_GAZEBO_XML=1`; bounded/correlated services and mutation success checks | Keep the bypass disabled for untrusted callers; audit any enabled model/plugin source |
| Camera transport | Raw/compressed image CDR or rosbridge JSON and CameraInfo | Explicit raw/compressed schema; base64-only rosbridge bytes; exact row/data sizes; PNG/JPEG signature-format check; dimension/allocation caps; exact matrices and bounded distortion; validated headers | Test both transports with the same malformed corpus |
| Native rosbridge services | Request bodies and asynchronous replies | 256-message write queue, 16 pending services, 8 s timeout, unique IDs, service-name/ID correlation, `result` validation, and required `values.success` for spawn/delete | Target-server compatibility and authentication/network policy |
| Zenoh transport | Plain keys, CDR payloads, publish payloads, event names | Topic and deterministic event-name validation; bounded CDR strings/sequences/data; finite payloads; explicit camera schema | Namespace/ACL/topology review; direct `rmw_zenoh_cpp` requires a re-keying bridge |
| Sensor fusion / PID JSONL | Config, measurements, track state, operator-selected output path | Bounded/finiteness checks; lock released before best-effort file append; write failures do not block fusion | JSONL parser/NIS smoke is not end-to-end Galadriel PID, correlation, ACL, or live NCP evidence |
| Native NCP opt-in | Realm/session/model text, Zenoh configuration, RPC replies, command frames | Off-by-default feature and unregistered commands; secure mode requires `NCP_ZENOH_CONFIG`; bounded inputs/timeouts; explicit `ok` plus kind/session/version checks; per-session lifecycle/subscriber cleanup; sanitized `CommandPlant`, sequence, TTL/horizon, raw ESTOP, and bounded final-HOLD attempt | Audit actual TLS identities, ACLs, certificates, and topology; config loading is not policy evidence; no always-on loop exists |
| Vite-dev NCP harness | Manual `window.__ncpDrone` calls with wire-shaped commands | Development-only/no transport; per-entity buffers; strict wire-0.7 active vec3/horizon bounds; local elapsed-time integration; malformed-call HOLD; raw ESTOP latch and freshness-reset | Not a live NCP/action-plane test; absent from production builds; never treat browser injection as Engram/ACL evidence |
| Tauri commands/events | IPC arguments, event names, and serialized payloads | Command-specific input validation, bounded payloads, deterministic event names, and structured failures | Verify every registered command and emitted event remains covered by boundary tests |

## Unified camera schema

Both native transports enforce the same contract:

- raw `rgba8`, `bgra8`, `rgb8`, `bgr8`, or `mono8`, with dimensions
  `1..=8192`, sufficient `step`, exact `height * step`, and at most 64 MiB;
- compressed PNG/JPEG whose declared format matches the bytes; empty format means
  the JPEG fallback; encoded dimensions must fit the same decoded-RGBA budget;
- CameraInfo finite `K[9]`, `R[9]`, `P[12]`, and `D` length 5/8/4 for standard
  models or at most 32 for a custom model; and
- finite, non-negative timestamps with nanoseconds `< 1e9` and bounded frame IDs.

The rosbridge ingress accepts image bytes only as bounded base64 strings. Tauri
`CameraFrame.data` is also base64, including frames decoded from native Zenoh CDR.

## Release security gate

Before a release-readiness claim:

1. `bun run validate:all` passes on the candidate.
2. Hosted bundle, coverage, backend-feature, CodeQL, and supply-chain-audit gates pass.
3. `docs/MANUAL_SMOKE_TEST.md` has no unresolved release blocker.
4. Every new external input has validation and documentation or an explicit limitation.
5. Performance, ML accuracy, transport latency, scientific, and safety claims cite target-environment evidence.
