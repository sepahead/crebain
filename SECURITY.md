# CREBAIN Security Policy

CREBAIN handles local files, model and asset paths, Tauri IPC, ROS/rosbridge,
Zenoh CDR, optional telemetry sinks, deployment registries/configuration, and a
feature-gated raw NCP evidence producer. Treat every external boundary as
untrusted unless this document identifies a narrower trusted-operator contract.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.9.x prereleases | Supported for research-source security fixes |
| < 0.9 | Unsupported / retired |

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
- Keep Rust dependency audits enabled. The root lock pins patched `openssl`
  0.10.81, `serde_with` 3.21.0, `rustls-webpki` 0.103.13, and `rand` 0.8.6/0.9.3
  where their dependency constraints permit it. Two upstream-constrained
  advisories remain: `glib` 0.18.5 in Tauri's GTK3 runtime path and `rand` 0.7.3
  in Tauri's legacy `phf` build path. CREBAIN does not call the affected
  `VariantStrIter` API, and the legacy `phf` chain does not enable `rand`'s `log`
  feature or use its affected thread-RNG/custom-logger path. Neither chain
  currently accepts a patched version; reassess when Tauri migrates its GTK and
  HTML-selector dependencies. Lockfiles nested under `vendor-compat/` are frozen
  upstream provenance snapshots and are not used for workspace resolution;
  dependency scanners can report their historical versions even when the root
  lock resolves patched or absent crates. Legacy transitive GUI/build crates can
  also produce unmaintained warnings, so review the complete current audit rather
  than treating the two named constraints as the whole warning set.
- Model validation rejects a final symlink, directory for regular-file formats,
  and special file. ONNX/CoreML/safetensors runtimes still reopen a validated
  path, so keep the model and every parent directory on a trusted,
  access-controlled immutable filesystem; CREBAIN does not claim resistance to
  a concurrent privileged local path-swap attacker.
- Keep native benchmark reports in an approved evidence location and review
  their hardware label, content digests, ONNX Runtime loading record, raw
  timings, and first-frame detections before sharing. Only an explicitly
  configured Linux `ORT_DYLIB_PATH` carries a runtime-library digest.
- Treat scene JSON, GLB/splat/image assets, ROS graph names, CDR, and IPC
  payloads as untrusted.
- Point `CREBAIN_PID_JSONL` only at an operator-approved local path. It is a
  best-effort append sink, not an authenticated/version-negotiated stream, and its
  track/timing/innovation telemetry may be sensitive. Use a regular local file,
  not a FIFO, device, socket, or unbounded/remote mount. Without an active
  Galadriel producer, fusion command completion waits for its synchronous
  write/flush; with the producer active, a separate bounded archive worker can
  still remain blocked after its finite shutdown wait. An `ncp`-feature startup
  preflights a configured sink, but a special path can itself block during open.
- For a Galadriel-enabled build, deploy the final post-signing executable, fusion
  config, registry, expected digests, and `NCP_ZENOH_CONFIG` as one protected,
  immutable manifest. Do not use a mutable developer checkout or an intermediate
  executable digest.
- Grant the producer principal `put` access only to its two
  `{realm}/session/{epoch}/sensor/galadriel-*` evidence keys and deny command,
  service, action, final-route, and wildcard write capabilities. Test both allow
  and deny cases against the actual router.
- Bind the authenticated Zenoh principal to the expected deployment producer.
  The envelope's `producer_id` is a declared JSON string and is not itself that
  cryptographic binding. Treat sidecar, monitor, registry, and queue-health data
  as potentially sensitive operational telemetry.
- Configure and negatively test router/receiver payload-size limits against the
  largest permitted frozen envelope; local validation does not prove a remote
  peer will accept that payload.

## Threat model summary

<!-- ncp-pin: v0.8.0 -->

| Boundary | Untrusted inputs | Current controls | Required review before release claims |
|----------|------------------|------------------|---------------------------------------|
| Model loading | Backend environment paths, model files, TensorRT build/cache inputs | Allowed-path/extension checks, MLX `.safetensors` checks and optional SHA-256 pin, missing-model errors, unsupported build-mode rejection | Provenance, rights, exact tensor/class contract, golden fixtures, and target-hardware evidence |
| Native detector benchmark | Model/fixture/baseline/output paths; policy/count inputs; operator source/hardware declarations | Bounded validated inputs; no-overwrite atomic report; model/fixture pre/post digests; recorded ONNX Runtime loading mode plus a pre/post digest only for configured Linux `ORT_DYLIB_PATH`; trusted baseline-digest check; forced profiling/cache controls; local paths/environment values redacted | Report remains sensitive; declarations are not executable/hardware attestation; crate-linked or search-loaded runtime bytes are not attested; provider label is not per-operation placement proof; pre/post hashes are not hostile-filesystem attestation |
| Scene persistence (native) | Scene path and JSON | Allowed-root `.json` path checks; open-once bounded 10 MiB read; parse then migration; atomic same-directory temp-file save and sync | Serialized production-handler IPC negatives for traversal, outside-root, extension, absence, malformed JSON, invalid UTF-8, and size; valid save/load remains a manual smoke |
| Browser scene state | File/blob/localStorage JSON and referenced state | 10 MiB pre-read/UTF-8 bounds; migration before strict schema; unique/referential IDs; finite values; 64 cameras, 256 drones, 128 assets, 10,000 detections, route and render-target caps; transactional all-or-empty restore rollback, physics-paused failure, and lifecycle-generation fencing | Positive target-platform restore plus representative older-version fixtures |
| Browser assets | Splat, GLB, embedded images, floor PNG/JPEG, remote URLs | Renderer `fetch` is statically confined to the bounded adapter; an exact package/version/source-hash Vite pre-transform binds Spark 0.1.10, Rapier 0.19.3, and Three 0.182.0 across four transformed modules and leaves zero vendor `fetch` references; Spark URL loading and Spark/Rapier external WebAssembly initialization fail closed while their pinned embedded-byte paths and Spark `fileBytes` path remain bound; Three `FileLoader`/`ImageBitmapLoader` fail closed, `ImageLoader` admits only local `blob:` or canonical PNG/JPEG base64 data URLs, and an iterative 262,144-value GLTF URI work ceiling rejects a container before bulk push and selects `TextureLoader` so product-validated bufferView/data-image textures remain usable without admitting external URI loading; mutation tests bind manifests, modules, payloads, AST/call/replacement shapes, guard narrowing/wide-array rejection, and both local-texture runtimes; direct drop and restore apply the same length/control/credential/scheme/format policy before acquisition; protocol-relative and backslash-ambiguous URLs fail closed; CSP connect sources match relative/HTTPS/HTTP-loopback restoration; passive images are self/blob/data only; streamed byte ceilings despite absent/dishonest `Content-Length`; remote GLBs reserve worst-case bytes before acquisition; splat URL/File reads are supersession-abortable; distinct embedded-image spans cannot overlap; texture transforms/nonzero texture coordinates and loader-expanded primitives are rejected; node/mesh/camera/material copies share an expanded-metadata ceiling; timeout/source/content checks plus atomic loaded-and-pending decoded/resident/render-work reservations retained until non-abortable parses settle | Decode/render smoke with malformed/truncated/oversized fixtures, rapid load supersession, and packaged CSP behavior |
| Native detection IPC | Base64 or RGBA image, dimensions, thresholds, limits | PNG/JPEG inspection; `1..=8192` dimensions; 64 MiB decoded allocation budget; exact raw length; structured failures | Confirm malformed images fail without a frontend crash |
| Renderer ROS telemetry | Development-only WebSocket URL, topic names, and messages | Build-command-only alias selects the real client; every production mode resolves the network-free stub; module graph plus finalized chunk hashes/socket scan and production CSP exclude rosbridge; exposed bridge is frozen/read-only | Restrict development rosbridge exposure and exercise the recorded telemetry graph |
| Local guidance preview | Telemetry observations and operator preview toggles | Disabled by default; `NoAuthority`/`Hold`; no transport capability; disable/disconnect/transport-change/off transitions abort missions and clear all derived preview snapshots | Never treat preview output as vehicle authority or release evidence for a plant |
| Camera transport | Raw/compressed image CDR or rosbridge JSON and CameraInfo | Explicit raw/compressed schema; base64-only rosbridge bytes; exact row/data sizes; PNG/JPEG signature-format check; dimension/allocation caps; exact matrices and bounded distortion; validated headers; process-wide 384 MiB weighted native ingress envelope acquired before JSON/CDR expansion with drop-new multi-topic backpressure; small readiness events plus exact one-shot pull and identity-matched acknowledgement retain the native byte permit and per-topic slot until renderer listeners settle or an offending listener reaches its bounded quarantine deadline; a separate 12-second renderer setup bound precedes delivery, while the 10/8/4-second pull/listener/acknowledgement path fits inside a 30-second native monotonic lease that atomically releases a lost or unacknowledged delivery and quarantines only its exact live declaration; lifecycle rotation or proven exact unsubscribe releases an untaken matching frame but retains pulled frames through exact acknowledgement or expiry; exact per-subscription identities fence late callbacks and stale cleanup, failed or stale setup performs bounded exact-ID cleanup, and reopen removes a quarantined declaration before installing a new identity; malformed readiness, duplicate/stale pulls or acknowledgements, and IPC deadline failures fail closed; browser latest-pending single-flight decode, two-worker stale/current bound, lifecycle fencing, stale-bitmap close, and callback isolation | Live decode/render smoke on target platforms; keep both transports on the same malformed and multi-topic saturation corpus |
| Native rosbridge telemetry fallback | WebSocket URL, subscribed topics, and incoming JSON | Subscription-only `Transport` trait; bounded write queue and JSON/base64/schema validation; no publish/service/Gazebo methods | Target-server compatibility and authentication/network policy |
| Zenoh transport | Plain keys, CDR payloads, subscribed topics, event names | Subscription-only `Transport` trait; topic and deterministic event-name validation; bounded CDR strings/sequences/data; explicit camera schema | Namespace/ACL/topology review; direct `rmw_zenoh_cpp` requires a re-keying bridge |
| Sensor fusion / PID JSONL | Config, renderer/ROS-derived measurements and frame-name provenance, track state, operator-selected output path | Strict config plus finite/cardinality/magnitude/string/batch/live-track bounds; sensor-clock high-water commits only after native success; renderer/native trimming keeps newest inputs and latches degradation; `ncp` startup preflights a configured sink; legacy/default path releases the fusion lock before synchronous best-effort append; active producer uses a capacity-16 drop-new archive channel; every batch is validated/serialized before its first write; admission failure or worker write/flush failure permanently degrades the epoch, and worker failure terminates that worker | A slow/special path can block startup/open, delay a legacy fusion call, or block the active writer beyond its two-second shutdown wait; a mid-write OS failure can still leave a partial already-validated batch; archive drops lack a dedicated counter or receiver semantics; a matching `source_frame_id` string is not authenticated sensor provenance; JSONL parser/NIS smoke is not end-to-end Galadriel PID, correlation, ACL, or live NCP evidence |
| Galadriel evidence producer | Feature/runtime switches; registry/config paths and JSON; environment pins; executable path; realm/identity; bounded fusion measurements and upstream-loss claims; Zenoh configuration and failures | `ncp` compile gate plus exact `1` runtime gate; disabled/default-off opens no producer; strict bounded registry and startup-loaded immutable fusion config; canonical registry and effective-config SHA-256; actual executable-file SHA-256; frame/context/software/config three-way agreement; active `fusion_init` is readiness-only and config replacement requires the same digest; exact-time/per-channel monotonic v1 eligibility; secure-mode-only open; exact two evidence keys; frozen bounded envelopes; newest-preserving upstream/registry admission and whole-cluster track-cap rejection; independent bounded drop-new lanes; sequence gaps, counters, sticky degradation, heartbeats, put timeouts, and finite owned-task shutdown (the JSONL writer is separate) | Digest equality is not signature/provenance and the executable hash omits libraries/resources; registry calibration/transform/projection references are not loaded or verified; the wire summary lacks numeric upstream/cluster-loss detail; sparse assignment component tests are not combined-load/deadline evidence; audit TLS/mTLS identities, certificate policy, principal↔`producer_id` binding, exact ACL/router topology and receive-size limits, receiver registry agreement, loss/reorder/restart/saturation/clock/deadline behavior, and live Galadriel decode/correlation before deployment claims |
| Native NCP action/control opt-in | Realm/session/model text, Zenoh configuration, RPC replies, command frames | Off-by-default feature and unregistered commands; secure mode requires `NCP_ZENOH_CONFIG`; bounded inputs/timeouts; explicit `ok` plus kind/session/version checks; per-session lifecycle/subscriber cleanup; timeout warnings omit external session identifiers; sanitized `CommandPlant`, sequence, TTL/horizon, raw ESTOP, and bounded final-HOLD attempt | Audit actual TLS identities, ACLs, certificates, and topology; config loading is not policy evidence; no always-on Engram/action loop exists. The separately integrated evidence producer does not activate these commands |
| Headless plant foundation | In-memory command/health reports, captured-read age, apply-check inputs, health-age policy proposals, safe-action-row and local-TTL proposals, exact-profile opaque situation candidates, finite frame vectors, lifecycle events, and typed channel/deadline values | Separate dependency-free package; inactive contract validation, digest-bound same-instance frame corpus, sealed coherent health/captured-age path, and fixed no-default safe-action dispatch remain as previously bounded. The active deadline-monitor candidate borrows a validated command, checks a caller-supplied expected generation and zero/over-request local TTL, derives an immutable deadline through opaque receipt operations, and exposes no raw clock. One named worker owns one active slot/no queue; replacement requires exact profile/session/generation and a strictly greater sequence. Current clock regression or `now >= deadline` wins before replacement/shutdown/caller-reported generation mismatch; a newer sequence with an older receipt terminalizes; terminal deadline age/lateness, poison, panic, reported-mismatch, and shutdown evidence is sticky. Poisoned synchronization carries no exact active key, and worker-start failure retains the initial key plus any terminal reason computed before spawn. The apply-check observation candidate first loads one generation-checked coherent health snapshot, then mints one private monotonic reference instant and evaluates health ages followed by command receipt age relative to it. It records the strict requested-lifetime relation with equality outside, neutral lifecycle state/generation, and all eight health-age relations. Exact profile or command/lifecycle generation mismatch fails before the health snapshot load; missing/poisoned/wrong-generation health and health clock regression fail before command clock regression, followed by health-policy mismatch. Its private-field result has no direct boolean accessor or `From` conversion to `bool` and supplies no aggregate/authorizing verdict, permit, authorization token, command content, velocity, action, adapter conversion, or runtime call; callers can compare retained facts. Static mutations and compile-fail checks seal ticket and observation construction, fixed monitor identity/slot/worker, due precedence, no refresh/rearm, health-before-reference order, one shared age-reference instant, and no runtime/action/adapter conversion. Generation guards, bounded channels, passive expiry, inert adapter, and the no-I/O/no-external-source package boundary remain | Candidate profiles, age/TTL limits, situation codes, safe-action rows, local TTL, expected generation, and reported lifecycle values are caller-proposed and unapproved. Captured-read relations are not current/apply-time health; profile equality does not content-bind safe-action rows; frame/source identities are not authenticated; a copyable candidate can remint a deadline ticket; real FCU sampling and aggregation are unproved. A successful apply-check observation can still contain an expired command, any `PlantState` including `Emergency` or `Shutdown`, stale ages, and unknown/unavailable health. The command carries no `VehicleIdentity` or `LocalFrameInstanceIdentity`, so exact profile/generation equality can compose it with health from another declared vehicle/frame instance and provides no HAZ-005/HAZ-013 evidence. The observation is remintable and not content-bound to one command: the same retained IDs/TTL can describe copyable candidates with different velocity, so it must never be paired to a command by those fields as a checked token. It can stale immediately, is not a write-adjacent atomic transaction, and does not authorize, revoke, select, or apply anything. The deadline monitor is not authenticated admission or durable anti-replay, does not globally prevent multiple monitors, cannot establish lifecycle currentness from a caller report, and neither revokes output nor selects/applies a safe action. `Instant` is not suspend-qualified; one worker per instance is not scheduler reservation or a global bound; Drop/join is not bounded under starvation; no wake-to-effect/combined-load latency, crash/power-loss containment, operational watchdog, CTL-003 immediately-before-write governor, FCU adapter/failsafe, SITL/HIL, or physical evidence exists. Self-check and component mechanics are not release-authority evidence |
| Vite-dev NCP harness | Manual `window.__ncpDrone` calls with wire-shaped commands | Development-only/no transport; per-entity buffers; strict wire-0.8 active vec3/horizon bounds; local elapsed-time integration; malformed-call HOLD; raw ESTOP latch and freshness-reset | Not a live NCP/action-plane test; absent from production builds; never treat browser injection as Engram/ACL evidence |
| Tauri commands/events | IPC arguments, event names, and serialized payloads | Command-specific input validation, bounded payloads, deterministic event names, and structured failures | Verify every registered command and emitted event remains covered by boundary tests |

Camera readiness is bound to canonical nonzero-u64 delivery, subscription, and
lifecycle-generation decimal strings at both pull and acknowledgement. The
renderer prevalidates
that identity, runs only one complete pull/listener/acknowledgement cycle per
topic, and retains at most one small pending descriptor; a stale descriptor
cannot occupy that slot, and a pending descriptor is never pulled before the
active acknowledgement settles. Native lease expiry attempts a bounded exact
undeclaration after releasing the delivery registry lock. It rechecks the
quarantined identity under the serialized camera-operation boundary, retains
quarantine when cleanup fails, and cannot remove a lifecycle-rotated or reopened
identity.

Event-listener registration and native camera declaration share one
twelve-second renderer setup deadline. A listener handle returned after that
deadline is immediately released and cannot attach to a reopened topic.

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

## Demo, operational, and 1.0 release security gate

Before a demo, operational-readiness, deployment, or 1.0 claim:

1. `bun run validate:all` passes on the candidate.
2. Hosted bundle, coverage, backend-feature, CodeQL, and supply-chain-audit gates pass.
3. `docs/MANUAL_SMOKE_TEST.md` has no unresolved release blocker.
4. Every new external input has validation and documentation or an explicit limitation.
5. Performance, ML accuracy, transport latency, scientific, and safety claims cite target-environment evidence.
6. Any Galadriel deployment claim binds the exact post-package executable,
   canonical fusion config, canonical registry, and protected Zenoh configuration
   to receiver-side TLS/ACL, receive-size, delivery, heartbeat, restart, clock,
   and loss artifacts.

The research-only `v0.9.0` prerelease is governed separately by
[`docs/NARROWED_GO_0.9.0.md`](docs/NARROWED_GO_0.9.0.md). It may proceed only
after that document's automated source/package conditions pass, with manual and
deployment evidence still marked pending and with no operational, accuracy,
performance, scientific, safety, or 1.0 readiness claim.
