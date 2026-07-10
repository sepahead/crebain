# Changelog

All notable changes to CREBAIN are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is a research prototype; capability statuses are tracked in the
README and treated as unverified until measured on target hardware.

## [Unreleased]

Open-source readiness and quality hardening.

### Added
- **Galadriel-oriented local innovation JSONL.** `update_track` can emit a minimal
  observation after an associated measurement actually corrects a Kalman-family
  filter (`FusionConfig.emit_innovations`). `CREBAIN_PID_JSONL=<trusted-path>`
  enables best-effort local JSONL append at fusion initialization. Repository
  tests cover local serialization/parsing and basic NIS consistency; they do not
  claim live Galadriel correlation, PID actuation, NCP, ACL, or versioned-stream
  interoperability. Track birth and skipped updates emit nothing; Particle and
  IMM are excluded because they have no single compatible innovation covariance.

### Fixed
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
- **Optional NCP boundaries now fail closed without unreleased wire-0.7 APIs.**
  The pinned wire-0.6 bridge caps command payloads, retains only bounded actuator
  data, latches a minimal raw ESTOP, serializes start/open/close per session,
  drops dedicated subscriber handles, and requires explicit lifecycle `ok`
  fields. The Vite-dev harness now validates complete active frames, isolates
  sequence/deadline state per drone, derives motion from local elapsed time,
  applies HOLD on malformed calls, and clears buffered freshness on reset.

### Changed
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
  ROS-definition validation, and scheduled benchmarks.
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
