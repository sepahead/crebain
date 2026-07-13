# Changelog

All notable changes to CREBAIN are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is a research prototype; capability statuses are tracked in the
README and treated as unverified until measured on target hardware.

## [Unreleased]

Open-source readiness and quality hardening.

### Added
- **Unwired single-reference-instant apply-check observation candidate.** One
  generation-checked coherent health snapshot is loaded first. Only then is a
  private plant-monotonic reference instant minted, with health ages computed
  before command receipt age relative to that same instant. The retained
  observation records the command's strict requested-lifetime relation
  (equality is outside), neutral lifecycle state/generation, and all eight
  profile-bound health-age relations from one check. Exact profile or
  command/lifecycle generation mismatch precedes the health load;
  missing/poisoned/wrong-generation health and health clock regression precede
  command clock regression, followed by health-policy mismatch.
  Success is evidence only and can still contain an expired command, any
  `PlantState` including `Emergency` or `Shutdown`, stale ages, and
  unknown/unavailable health. The result has no direct boolean accessor or
  `From` conversion to `bool` and supplies no aggregate/authorizing verdict,
  permit, authorization token, command content, velocity, action, output
  revocation, safe action, adapter operation, I/O, or runtime wiring, although
  callers can compare its facts. It can become stale immediately and is not a
  write-adjacent atomic transaction. The command carries no `VehicleIdentity`
  or `LocalFrameInstanceIdentity`, so profile/generation equality can compose
  it with health from another declared vehicle/frame instance and supplies no
  HAZ-005/HAZ-013 evidence. The observation is remintable and not content-bound:
  the same retained IDs/TTL can describe copyable commands with different
  velocity, so IDs must never pair it to a command as a checked token. This is
  partial CB-029/CTL-005/HAZ-003/HAZ-006 component evidence only. CTL-003,
  `TEST-PLANT-LOCAL-TTL`, and `TEST-ATOMIC-STATE-STALENESS` remain planned, and
  CREBAIN remains L0.
- **Profile-neutral plant frame conventions.** The dependency-free plant
  package and JavaScript verifier independently evaluate one digest-bound
  32-case m/s corpus for identity, ENU↔NED, and FLU↔FRD velocity-axis
  conventions. Every local↔body route fails with `AttitudeRequired`. The
  shared number encoding is a restricted canonical shortest-round-trip decimal;
  matching-hash underflow/rounding aliases fail closed. The
  component is not connected to admission and does not select a profile or
  prove same frame-instance/origin/datum/body-point identity, or cover attitude,
  yaw/quaternions, points/translation, covariance, Three.js, time, apply-time
  enforcement, or live FCU interpretation.
- **Inactive plant contract-v1 candidate.** The isolated zero-dependency plant
  package now has closed profile/action/frame/unit types, fixed-width nonzero
  identities, distinct producer and plant-local time domains, and fail-closed
  validation for the draft L1 instantaneous velocity and TTL limits. Non-velocity actions,
  wrong version/profile/session/frame/unit, zero or oversized lifetime,
  nonfinite values, and vectors outside the instantaneous speed limits are rejected by stable typed
  reasons. The profile and canonical local frame remain unapproved; there is no
  serializer, ingress, anti-replay state, watchdog, health gate, adapter, or
  action path.
- **Content-identified native detector microbenchmark.** A release-command Rust
  example records bounded single-fixture `DetectorRuntime::detect` samples,
  nearest-rank latency summaries, a separately scoped evidence-loop wall time,
  model/fixture digests, the recorded ONNX Runtime loading mode, a digest for an
  explicitly configured Linux `ORT_DYLIB_PATH`, forced
  MLX-profiling/TensorRT-cache controls, and an optional p95 gate bound to a
  caller-supplied trusted baseline digest. Reports redact local paths and
  environment values, refuse overwrite, preserve a failing comparison, and
  carry their claim/sensitivity limits. The harness has logic tests but no
  repository-approved model, target run, baseline, threshold, or numeric
  result.
- **Serialized Tauri IPC negative-boundary coverage.** The production command
  handler is now reusable with Tauri's mock runtime, so tests pass JSON invoke
  requests through the real handler dispatch and argument deserializer instead
  of calling command functions directly. The suite covers scene traversal,
  outside-root, extension, missing, malformed, invalid-UTF-8, and 10 MiB limits;
  detector and fusion type/range rejection before runtime use; and every
  topic-bearing transport command rejecting invalid ROS names before connection
  lookup. Transport subscription handlers are runtime-generic solely so the
  same production handler list can be exercised; their product behavior and
  registered surface are unchanged.
- **Non-consuming retained plant snapshot mechanics.** The isolated plant
  foundation can atomically replace one whole `Arc`-backed value together with
  a caller-supplied lifecycle generation and exact per-register sequence.
  Repeated loads do not consume or deep-clone the value; previously loaded
  handles keep their prior allocation after replacement; poisoning, closure,
  and counter exhaustion fail closed; and concurrency/adversarial-destructor
  tests cover coherent commits. This generic API remains disconnected storage
  mechanics and by itself does not prevent interior mutation exposed by `T` or
  validate generation freshness/order.
- **Inactive typed vehicle-health snapshot contract.** The canonical kernel
  health path now validates a closed immutable in-memory report against an
  exact candidate profile, vehicle/source/stream-epoch identity, runtime
  generation, local-frame instance, source sequence that is strictly increasing
  within one publisher instance,
  local frame, SI units, plant-local observation times, finite vectors, and
  bounded battery fraction. Its sealed channel retains coherent state and
  exposes exact ages without a healthy/safe verdict. Source identities are
  declared rather than authenticated; no FCU collector, approved freshness
  policy, durable exclusive epoch/channel ownership, authorizing
  immediately-before-write consumer/governor, failsafe, or adapter exists. This is
  partial CB-030/CTL-005/HAZ-006 component evidence only.
- **Inactive profile-bound captured-read health-age classifier.** A separate
  dependency-free component consumes one coherent observed health commit,
  rejects zero limits and exact-profile mismatch, and compares receipt plus all
  seven observation ages against named exclusive limits. Only an age strictly
  below its limit is within it; equality is outside. The assessment keeps the
  exact observation and policy together and exposes no boolean or aggregate
  fresh/healthy/safe/eligible/authorized result. Limits are caller-proposed and
  unapproved, recent unknown/unavailable state remains non-nominal, the draft
  ODD's inclusive `<=200 ms` position/velocity condition is not implemented,
  and the classifier itself reads no clock. The separate apply-check observation
  still provides no active-monitor integration, authorizing
  immediately-before-write governor, or adapter.
  HAZ-006 and CTL-005 remain partial and CREBAIN remains L0.
- **Inactive safe-action situation-dispatch candidate.** A separate plant-side
  vocabulary distinguishes output inhibit, profile-defined physical Hold,
  controlled Land, RTL, and guarded ground-disarm requests from untrusted
  command ingress. Candidate policies copy borrowed rows into a fixed 255-slot
  table without heap allocation and bind it to an exact `ProfileIdentity`; zero
  situation codes, empty/oversized/duplicate proposals, profile mismatch, and
  unmapped codes fail without a default. The opaque code is caller-asserted,
  the profile identity does not content-bind the supplied rows, and there is no
  state/trigger classifier, health or time input, action conversion, runtime
  consumer or deadline-monitor coupling, governor, adapter, or FCU effect. This is partial
  structural CB-028 mechanics only; CTL-007 remains planned and HAZ-007 open.
- **Unwired receipt-anchored active command deadline monitor candidate.** A
  validated command can mint a ticket whose immutable deadline is exactly its
  opaque plant receipt time plus a nonzero caller-proposed local TTL no greater
  than the requested TTL. The ticket itself is non-cloneable, but the copyable
  candidate can mint another, so ownership is per monitor rather than global
  admission. One named worker owns one active slot and no queue. A replacement
  must carry the same exact profile, session, and generation with a strictly
  greater sequence; current clock/deadline failure wins before replacement,
  shutdown, or a caller-reported generation mismatch, and a newer sequence with
  an older receipt terminalizes the monitor. Exact/late deadline detection,
  poison, worker panic, shutdown, and reported mismatch produce sticky terminal
  evidence; synchronization failure omits an exact active-key claim. Worker-start
  failure retains the initial key and any precomputed terminal reason. The component is unwired and does not
  authenticate admission, autonomously observe lifecycle rotation, revoke an
  output, select/apply a safe action, qualify suspend behavior, reserve scheduler
  capacity, or prove wake/effect latency. CB-027 and HAZ-003 remain partial;
  CTL-003 and `TEST-PLANT-LOCAL-TTL` remain planned.
- **Passive plant-local monotonic expiry mechanics.** The isolated zero-dependency
  plant foundation can classify one immutable, generation-bound local interval;
  zero TTL or an unrepresentable deadline, clock regression, generation rotation, and the
  exact deadline fail closed. It has no command payload, refresh, timer,
  safe-action selection, adapter hook, or I/O and is not an active watchdog.
- **Opt-in Galadriel live evidence producer.** A binary compiled with the
  off-by-default `ncp` feature can, only when
  `CREBAIN_GALADRIEL_ENABLE=1`, start a managed producer that writes frozen
  sidecar and producer-monitor envelopes to the exact `galadriel-pid` and
  `galadriel-monitor` named-perception keys. Enabled startup fails closed on a
  strict canonical registry mismatch, selected frame/context mismatch, actual
  effective-fusion-config digest mismatch, actual running-executable digest
  mismatch, malformed queue/heartbeat policy, or secure-mode Zenoh open error.
  Fusion processing now builds one deterministic frozen-prior ledger with
  explicit outcomes/misses/frame summaries. Active initialization is a
  readiness-only check over the startup-loaded immutable config; later config
  calls cannot replace that engine. Strict exact-time/channel-monotonic rules
  prevent duplicate, out-of-order, or mixed-old inputs from claiming v1, while
  bounded renderer/native admission preserves the newest inputs and reports
  malformed, buffer, registry-trim, and active-track-capacity loss as sticky
  degraded/truncated frame state. Position, velocity, covariance, metadata,
  string, batch, and live-track limits bound filter work; sparse finite-edge
  assignment and an all-infinite short circuit bound component behavior. Four
  bounded drop-new lanes expose loss, sticky degradation, periodic heartbeats,
  five-second put bounds, and finite task shutdown. Active JSONL copies use a separate capacity-16 drop-new
  archive worker; configured sinks are startup-preflighted, batches are
  validated/serialized before writing, and admission or writer failure degrades
  the epoch (writer failure also stops that worker). A blocked writer can outlive
  its two-second shutdown wait. Common projection is
  identity-only: the source frame
  must already equal the registry's canonical ENU frame and the transform chain
  must be empty. Component tests pin codecs/routes, ordering, drops, degradation,
  heartbeat admission, sequence exhaustion, and task ownership. They do not
  prove TLS/mTLS identities, ACLs, a deployed Galadriel tap/assembler, receiver
  delivery/deadlines, router/receiver payload limits, combined-load timing,
  calibration, PID actuation, or authority. Numeric upstream/cluster loss is not
  yet carried by the frozen wire summary. Default release artifacts still omit
  the `ncp` feature. All default and NCP Rust package acceptance scripts now use
  the locked dependency graph.
- **Galadriel-oriented local innovation JSONL.** `update_track` can emit a minimal
  observation after an associated measurement actually corrects a Kalman-family
  filter (`FusionConfig.emit_innovations`). `CREBAIN_PID_JSONL=<trusted-path>`
  enables best-effort local JSONL append at fusion initialization. Repository
  tests cover local serialization/parsing and basic NIS consistency; they do not
  claim live Galadriel correlation, PID actuation, NCP, ACL, or versioned-stream
  interoperability. This local sink remains separate from the new live producer.
  Track birth and skipped updates emit nothing; Particle and IMM are excluded
  because they have no single compatible innovation covariance. Without an
  active producer, the blocking fusion job still waits for synchronous local
  append/flush after releasing the fusion lock.

### Removed
- **Production-unreachable inference prototypes.** Removed the unrendered browser
  camera-feed/worker detector chain, its browser ONNX and placeholder Moondream
  implementations, exclusive tests and benchmark workflow, unused React hooks,
  `comlink`/`onnxruntime-web`, and unbuilt Swift CoreML packages. The active
  Tauri `useDetectionLoop` path and native CoreML/ONNX backends remain.

### Fixed
- **Declared Rust MSRV matches the locked graph.** The manifest and contributor
  guide now require Rust 1.89 because the existing locked `nalgebra`/`wide`
  dependency path no longer compiles on 1.88; development and CI remain pinned
  to 1.91.1.
- **Native provider identities no longer survive failed registration.** Generic
  ONNX TensorRT/CUDA/CoreML attempts now require execution-provider
  registration to succeed before assigning that provider label, while retaining
  ordered fallback to the next provider or CPU. The label records selected
  session configuration, not exclusive accelerator graph placement. Exact
  CoreML benchmark initialization is serialized against normal singleton
  initialization so a concurrent different model cannot win unnoticed.
- **Passive inference diagnostics no longer wait behind backend initialization.**
  Runtime snapshots use a nonblocking lock attempt and report an explicit
  `busy` state while provider discovery, model loading, or warmup owns the
  runtime state. A deterministic barrier test covers the initialization race.
- **Local lateral control now follows the documented +Z-forward/+X-right body
  frame.** Positive logical roll is a right bank, the FL/FR/RL/RR motor fields
  now match their physical rotor positions and diagonal spin pairs, and attitude
  feedback uses the same sign convention. Motion-level regressions prove that a
  right-bank target accelerates toward local +X and that hands-off lateral
  braking reduces +X drift instead of reinforcing it.
- **Unit-correct "lowest-noise" selection across modalities.** The birth-representative
  and first-update orderings summed each measurement's raw covariance triple, comparing
  radar's `[m², rad², rad²]` against Cartesian `[m², m², m²]` — radar's tiny rad² terms
  made it look near-noiseless and win seeding/linearization slots over genuinely tighter
  sensors. Both sites now compare the **Cartesian R trace**. And the degenerate-geometry
  fallback in `measurement_r_cartesian` (singular polar Jacobian at/near the origin) no
  longer installs the raw polar diagonal as Cartesian — it falls back to isotropic range
  variance with a warning. Regression tests cover both (a 100 m radar with tight angular
  variances must lose the seed to a 0.5 m² visual; an origin radar return gets isotropic
  m² fallback).
- **Multi-second dropouts are now fully integrated by prediction.** The predict step
  clamped `dt` to 1 s while advancing the clock by the whole gap, so a 5 s dropout moved
  the state only 1 s with no covariance inflation for the remainder — the next
  association then gated against a mis-timed, overconfident prior (a real re-acquisition
  hazard after 1–2 s occlusions). Prediction now integrates the whole gap in ≤1 s
  substeps (exactly equivalent for ≤1 s gaps; the CV transition composes exactly and Q
  accumulates per substep), capped at 60 s — beyond which a coasting track's covariance
  has inflated toward the divergence gate anyway, and the cap bounds work under
  wall-clock jumps. Regression test: one 2 s dropout and two explicit 1 s coasts produce
  identical post-gap state and covariance.
- **Skipped updates no longer count as track hits.** A frame whose every associated
  measurement update was skipped (non-positive-definite innovation covariance) previously
  still refreshed `last_update_ms`, reset `missed_detections`, and boosted confidence — a
  track could stay Confirmed on "hits" that never corrected its state. `update_track` now
  withholds hit credit and the frame registers as a miss in the lifecycle pass.
- **`clear()` resets the predict clock** (`last_predict_ms`): a stale value made any
  post-clear replay whose timestamps were at or before the old wall-clock see `dt = 0` on
  every frame — no prediction, frozen covariances, mis-sized gates — until timestamps
  caught up. Regression test replays an earlier-timestamp stream after a clear.
- **Scene and asset restoration is bounded and completion-aware.** Browser and
  native scene reads enforce the 10 MiB ceiling before parsing, migration precedes
  strict schema validation, native saves replace atomically, and restore now
  cancels stale work and reports partial asset failure. Splat, self-contained GLB,
  embedded texture, aggregate-scene, and floor-image byte/pixel/time budgets are
  enforced during streaming and parsing.
- **ROS/Gazebo boundaries are consistent across the Tauri camera command and its
  native rosbridge/Zenoh transports.** Camera subscriptions carry an explicit
  raw/compressed schema, validate bounded base64/CDR data and CameraInfo matrices,
  and inspect PNG/JPEG headers. ROS 1
  Gazebo Classic service replies are ID-correlated, timed out, and require
  mutation success; caller XML is bounded and privileged directives are rejected
  except for the fixed bundled frontend model or explicit trusted native opt-in.
- **The optional NCP action receiver now enforces fail-safe output continuously.**
  Wire-valid commands feed a bounded 50 Hz `CommandPlant`; sequence, TTL, horizon,
  unit, and speed failures HOLD at zero, and stop/close emits a final HOLD. The
  feature and Tauri commands remain off/unregistered, so this is not a live
  product loop.
- **Optional NCP boundaries now fail closed on the published wire-0.8 contract.**
  The native bridge caps command payloads, retains only bounded actuator data,
  latches a minimal raw ESTOP, serializes start/open/close per session, drops
  dedicated subscriber handles, and delegates lifecycle reply validation to the
  SDK's typed `ZenohNcpClient`. The Vite-dev harness validates complete active
  frames, preserves additive modes without granting them actuation authority,
  isolates sequence/deadline state per drone, derives motion from local elapsed
  time, applies HOLD on malformed calls, and clears buffered freshness on reset.

### Changed
- **Re-pinned NCP to `v0.8.0` and adopted stream/source identity plus session
  fencing.** Cargo and npm manifests and lockfiles resolve the immutable release;
  post-open frames carry their own stream position, correlation-only source
  identity, session ID, and server-issued generation. The development ingress and
  native adapter validate those wire-0.8 identities through the canonical SDK.
- **Historical NCP 0.7 repin:** re-pinned to `v0.7.1` and adopted the complete
  typed reply contract.
  The `v0.7.1` SDK is a wire-identical patch over `v0.7.0`; Cargo and npm
  manifests plus both lockfiles now resolve the immutable patch release
  commit. Native lifecycle RPCs use `ZenohNcpClient`, typed/versioned error frames
  are bound to request and session identity, forward enum values stay lossless but
  cannot actuate, and the TypeScript guard delegates complete message validation
  to the canonical SDK. Wire `0.6` peers are rejected fail closed.
- **SPD covariance solves use Cholesky instead of explicit inversion** at the six
  innovation/association sites (KF, EKF, UKF gains; IMM likelihoods; association gate;
  measurement clustering): cheaper, better conditioned, and failure is a principled
  positive-definiteness guard rather than a hard-singularity-only one. The
  polar→Cartesian Jacobian inverse (non-SPD) correctly keeps `try_inverse`.

- **Re-pinned NCP to `v0.6.0` (wire `0.5` → `0.6`, the enforcement cut) and adopted
  the SDK's version/boundary/safety helpers.** Wire 0.6 is a semantic break with an
  unchanged serialization (`CONTRACT_HASH` still `24e8e6e31e1dec8a`): every success
  and data-plane message must carry a compatible `ncp_version` (v0.6 error replies
  remain unversioned), and `sensor_frame`/`command_frame` must stamp `seq >= 1` (the
  `seq == 0` escape hatch is gone). Bumped `ncp-core`/
  `ncp-zenoh` (Cargo.toml + Cargo.lock) and the npm dependency (package.json +
  bun.lock), and **renamed the npm scope `@sepehrmn/ncp` → `@sepahead/ncp`** to
  complete the org rename (all `src/**` imports updated).
  - `src/neuro/versionGuard.ts` now delegates to the SDK's `checkVersion`
    (major/minor compatibility, shared with every peer) instead of a bespoke exact
    string compare, and applies the SDK's `assertScientificBoundary` to inbound
    replies — CREBAIN now refuses a frame claiming calibrated / non-simulation
    status (it previously never enforced the boundary). New vitest coverage for the
    0.5-rejected and boundary-violation cases; the `NCP_VERSION` pin assertion → `0.6`.
  - The DEV-only `__ncpDrone` bridge (`useDroneController.ts`) now delegates its
    safety-critical decision to the SDK's `ActionBuffer` — `seq >= 1` discipline,
    the `ttl_ms` deadline, the active-mode allowlist, and a **latching ESTOP**
    (with a supervisor `reset()`) — keeping only CREBAIN's kinematic velocity/dt
    clamps and altitude floor on top.
  - The native Rust command tap (`src-tauri/src/ncp/mod.rs`) now accepts frames
    through `ncp_core::decode_validated`, dropping a version-less / incompatible /
    unstamped non-ESTOP frame with a diagnostic instead of actuating on it. A
    recognizable ESTOP deliberately latches first and is reduced to a minimal
    payload.
  - Native connection now defaults to the SDK's secure config path:
    `NCP_ZENOH_CONFIG` is required or connect fails closed. An explicit
    `quiet_development` mode remains available for unauthenticated local work;
    loading either config is not proof that deployment TLS/ACL policy is sound.

- Re-pinned NCP to `v0.5.0` (wire `0.4` -> `0.5`, the stable-wire cut: the command/sim `mode` strings are now proto enums (`Mode`/`SimMode`), `CONTRACT_HASH` recomputed). Bumped `ncp-core`/`ncp-zenoh` (Cargo.toml + Cargo.lock) and `@sepehrmn/ncp` (package.json + bun.lock); the reply-`ncp_version` guard now speaks `0.5`.

- Re-pinned NCP to `v0.4.0` (wire `0.3` -> `0.4`, the decoupling+robustness release: consumer-neutral proto package, advisory contract handshake, additive-is-non-breaking). The reply-`ncp_version` guard now speaks `0.4`; feature compilation, clippy, and local neuro contract tests passed (no live Engram loop was claimed).

- Re-pinned NCP to `v0.3.0` (wire `0.2` → `0.3`): the symmetric contract-hash
  handshake. Bumped `ncp-core`/`ncp-zenoh` (Cargo.toml + Cargo.lock) and
  `@sepehrmn/ncp` (package.json + bun.lock), and the reply-`ncp_version` guard now
  speaks `0.3` (`@sepehrmn/ncp` exports `NCP_VERSION = "0.3"`). A `0.2` NCP peer is
  now fail-closed rejected.
- Renamed the Rust crate `app` → `crebain` (lib `crebain_lib`).
- Replaced `lazy_static` with `std::sync::LazyLock`; made rosbridge mutex locking
  panic/poison tolerant.
- Began decomposing `CrebainViewer` (extracted `HeaderBar` and `DetectionPanel`);
  added a typed three.js traversal/disposal helper and removed duplicated logic.
- Corrected repository URLs and metadata; fixed the stale `index.html` title.
- Bumped `rustls-webpki` to a patched release.

### Added

- Sensor fusion — **sliding-window M-of-N track confirmation** (default 3-of-5) plus a
  position-covariance-volume deletion guard, replacing the prior age-based confirmation
  and consecutive-miss-only deletion. Each track carries a `hit_history` bitmask of its
  last `N` association opportunities; new `FusionConfig` fields `confirmation_window`
  (N) and `max_position_cov_volume` are `#[serde(default)]` so existing configs
  deserialize unchanged. `max_missed_detections` is now interpreted as misses *within
  the window* (must be ≤ `confirmation_window`).
- Sensor fusion — **CV + Coordinated-Turn IMM**: the IMM's second mode is now a real
  coordinated-turn model (fixed turn-rate magnitude `OMEGA_CT ≈ 0.3 rad/s`, degenerating
  exactly to constant-velocity below a small `|ω·dt|` guard), replacing the prior
  two-constant-velocity bank, so the filter tracks turning targets with lower position
  error. Both IMM modes now apply the same per-measurement `R` for scoring and update.
- ESLint (typescript-eslint type-checked + react-hooks) and Prettier, wired into
  `bun run validate`; `.editorconfig`.
- Frontend coverage via `@vitest/coverage-istanbul` with regression-ratchet
  thresholds; an initial-bundle size budget guard (`bun run check:bundle`).
- `rust-toolchain.toml` pinning the toolchain; enforced `cargo fmt` and the
  `clippy::undocumented_unsafe_blocks` lint.
- AppHandle-backed IPC integration tests (Tauri mock runtime) and a
  constant-velocity fusion tracking scenario; render smoke tests for the viewer
  panels.
- CI hardening (least-privilege permissions, concurrency, rust-cache, bundle and
  coverage gates) plus new workflows: CodeQL, OpenSSF Scorecard, supply-chain
  audit (cargo-deny + bun audit), tag-triggered Tauri release, Nix flake check,
  and ROS-definition validation.
- Supply-chain policy via `src-tauri/deny.toml` (advisories/licenses/bans/
  sources), enforced in CI. Dependencies are reviewed and updated periodically
  rather than via automated Dependabot PRs.
- Governance: `CODEOWNERS`, structured issue forms, `SUPPORT.md`, `CHANGELOG.md`,
  `CITATION.cff`, and a committed `flake.lock`.
- NCP TypeScript peer (`src/neuro`): local contract tests for the re-exported
  `@sepahead/ncp` surface and a thin `guardReplyVersion` transport wrapper. On the
  current wire it applies the SDK's compatibility rule plus scientific-boundary
  checks before a success reply reaches `NeuroSimClient`. The directory remains
  unimported by the product runtime.
- NCP native bridge: feature-gated tests cover the pinned SDK compatibility rule,
  malformed/kind-mismatched control replies, required result fields, and session
  identity. Incompatible or malformed replies are rejected rather than coerced.
- `docs/SENSOR_FUSION.md`: a full sensor-fusion design reference (estimation math,
  the per-modality coordinate/covariance contract, data association and gating,
  multi-sensor fusion semantics, track lifecycle, tuning, validation metrics, and
  known limitations), with an expanded and corrected README section.

### Fixed

- **Transport events could never reach the frontend.** Generated event names used
  `.` and `%XX` escapes, which Tauri 2 rejects (`IllegalEventName`) on every emit;
  the scheme is now `crebain:transport:` + `_XX` hex escaping on both the Rust and
  TypeScript sides.
- **CDR encapsulation endianness.** Decoders read the endianness flag from byte 0
  instead of byte 1 of the RTPS representation identifier (byte-swapping every real
  little-endian ROS 2 message); encoders emitted an invalid identifier. Both now
  follow the spec (`[0x00, 0x01, 0x00, 0x00]` for CDR_LE).
- **Sensor fusion:** true per-frame association-opportunity counting for M-of-N
  window deletion (intermittent clutter tracks are now deleted); radar measurement
  clustering uses Jacobian-converted Cartesian covariances; non-increasing
  timestamps no longer trigger phantom predictions; measurement covariances must be
  strictly positive and radar ranges non-negative; class-gated assignment with
  track class refresh; EKF polar Jacobian clamped at the origin.
- **CoreML FFI:** autorelease pools around init/detect (long-lived worker threads
  no longer accumulate autoreleased ObjC objects); nil-checks on `VNCoreMLRequest`;
  failed model init is no longer cached forever, so model-path fallbacks work.
- **MLX:** BatchNorm now runs in inference mode (it was mutating running stats on
  every frame); BF16 weights convert instead of being silently dropped.
- **ROS bridge (TS):** reconnect no longer leaks sockets or clobbers live
  connections; pending service calls reject on close; ImageBitmaps are closed
  (previously leaked ~30/s per camera); TF cache is indexed by header stamps so
  sim-time lookups work; guidance controller no longer commands from the origin
  after a config change, separates measured from commanded velocity for the D-term,
  and clamps dt after outages.
- **Rust transport:** rosbridge disconnect actually closes the socket and aborts
  its tasks (previous Arc-cycle leaked them); zenoh disconnect closes the session
  and operations are gated on connection state; transport commands time out instead
  of blocking the command surface forever; fusion IPC recovers from lock poisoning.
- **Physics:** Rapier user forces are reset each step (they accumulated unboundedly,
  causing runaway acceleration); rotor torque was scaled by thrust twice; disarmed
  drones now fall instead of freezing mid-air; all PID integrals are clamped and
  reset on disarm.
- **Detection (browser):** worker messages are serialized (concurrent `detect`
  threw "Session already started"); ONNX sessions are released on dispose; the 5+C
  output layout read class scores off by one; NMS is per-class; scenario-fixture
  camera yaws were inverted (the expected triangulation point was behind both
  cameras) and the cheirality gate now rejects both-behind intersections.
- **Keyboard collisions:** `P` toggled the performance panel *and* splat
  performance mode (with a full splat reload) — splat mode moved to `M`; object
  Z-rotation moved off `U`/`O` (fusion panel / file-open); viewer navigation and
  `R` are suppressed while a drone is selected.
- **Interception:** PARALLEL intercepts now close the along-track gap instead of
  hanging missions; lead-pursuit guards a division by zero.
- **Scene files:** version migration runs before strict validation (older saves
  were rejected before migration could run).
- Licensing metadata unified to `MIT OR Apache-2.0` (package.json said MIT-only,
  ros/package.xml said Proprietary, flake.nix said MIT-only); `nix build` no longer
  references a nonexistent `zig-detector` component and installs the correct
  binary; the version-coherence guard now also checks `tauri.conf.json` and runs on
  tag pushes; CI pins the Rust toolchain from `rust-toolchain.toml`.
- **Sensor fusion — radar/lidar coordinate frame.** Radar measurements are now kept
  in native polar `[range, azimuth, elevation]` end-to-end (consumed by the EKF
  polar model), and lidar is treated as a Cartesian centroid. Previously the
  TypeScript bridge converted both to Cartesian while the Rust core re-interpreted
  them as polar — a double conversion that corrupted every radar and lidar track on
  the default EKF path. Radar measurement noise is now specified in polar units.
- **Sensor fusion — covariance numerical stability.** The KF and EKF covariance
  updates use the Joseph stabilized form `(I−KH)P(I−KH)ᵀ + KRKᵀ`, and the UKF
  symmetrizes its covariance after each update, keeping `P` symmetric and
  positive-semidefinite under round-off (preventing the UKF Cholesky failures the
  diagonal fallback was masking).
- **Sensor fusion — ROS timestamp deserialization.** Per-measurement `timestamp_ms`
  is rounded to an integer at the bridge; a sub-millisecond ROS nanosecond remainder
  (the common case) previously produced a fractional value that failed `u64`
  deserialization and rejected the entire fusion batch.
- **Sensor fusion — IMM likelihood normalizer** corrected to the 3-D
  multivariate-Gaussian form `√((2π)³·det S)` (was the 1-D form).
- **Sensor fusion — coasting velocity spike.** The browser multi-camera tracker now
  records the predicted position during coasting, so velocity on re-acquisition is no
  longer inflated by dividing a multi-frame displacement by a single-frame `dt`.
- **Sensor fusion — χ²-calibrated association gate.** Association now gates on the
  squared Mahalanobis distance against a χ²(3) threshold (default `11.345` ≈ 99 %
  gate) instead of a non-squared distance versus a magic `10.0`; the singular-
  covariance fallback is squared and normalized to the same scale. Defaults updated
  across the Rust core and the TS config sites.
- **Sensor fusion — track-birth velocity prior.** A track born from a single
  position-only measurement now seeds a wide velocity prior (σ_v ≈ 20 m/s, Bar-Shalom
  single-point initiation) instead of an over-confident σ_v ≈ 3 m/s. Previously a
  genuinely moving target could fall outside the (correctly tightened) χ²(3) gate on
  its second frame and fragment into a duplicate track.
- **Sensor fusion — radar association frame consistency.** The association gate now
  expresses radar's polar measurement noise in the Cartesian gate frame via the
  polar→Cartesian Jacobian (`R_cart = J⁻¹ R J⁻ᵀ`) rather than adding polar
  `[m², rad², rad²]` directly to a Cartesian position covariance, which had badly
  under-estimated cross-range uncertainty (an angular σ at range R spans ≈ R·σ).
- **Sensor fusion — unified threat formula.** `calculate_threat_level` (Rust) and
  `getThreatLevel` (TS) now share one graduated 1–4 formula over a shared label
  mapping (`map_to_detection_class` mirrors `mapToDetectionClass`): drone threat
  graduates 2 → 3 → 4 with confidence and unknowns escalate to 3 above 0.7
  confidence, removing the engines' prior divergence in both the formula and the
  label bucketing.
- **Docs.** Corrected the README threat-level scale (1–4, no level 0), the track
  state-machine transitions (to match the Rust implementation), and the association
  threshold description (a unitless Mahalanobis distance, not meters).

### Removed

- Unused `core-graphics` and `core-foundation` Rust dependencies.

## [0.4.0] - 2026-06-13

Stabilization baseline.

### Added

- Backend IPC and transport boundary hardening: native detection ingress, scene
  path/JSON validation and schema migration, sensor-fusion config/measurement
  validation, ROSBridge graph/service validation, and Zenoh CDR/topic/payload
  validation.
- Experimental MLX YOLOv8 safetensors forward pass (opt-in) with DFL
  postprocessing; rosbridge WebSocket fallback transport.
- Release-readiness artifacts: acceptance matrix, model contracts, manual smoke
  checklist, release evidence log, and the security threat model.

## [0.3.0] - 2025

- Sensor fusion engine (KF/EKF/UKF/PF/IMM), guidance controller, and interception
  system; ROS/Gazebo and Zenoh transport paths.

## [0.2.0] - 2025

- Multi-camera surveillance, ML detection pipeline with platform-native backends,
  and drone physics simulation.

## [0.1.0] - 2025

- Initial Tauri + React + Three.js prototype with Gaussian Splatting scene
  rendering.

[Unreleased]: https://github.com/sepahead/crebain/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/sepahead/crebain/releases/tag/v0.4.0
