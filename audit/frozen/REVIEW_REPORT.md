# Frozen-source review report

This report records the exhaustive static review of frozen CREBAIN commit
`4c311900ade5668200a48d56fb191be1916b884a` performed on 2026-07-14. It is
source-review evidence only. The three lanes were separate agent contexts under
one coordinator; they are **not** human, organizational, or release-independent
reviewers.

## Accounting

| Lane | Files | Text lines | Opaque assets | Result |
|---|---:|---:|---:|---|
| lane-1 | 117 | 38,944 | 19 / 5,481,194 bytes | 14 P1, 5 P2, no P0 |
| lane-2 | 98 | 38,944 | 0 | 15 P1, 1 P2, no P0 |
| lane-3 | 99 | 38,944 | 0 | 10 P1, secondary findings, no P0 |
| **Total** | **314** | **116,832** | **19 / 5,481,194 bytes** | **38 distinct P1, no P0** |

Every packet path was read fully from frozen Git objects. Generated lockfiles
were structurally parsed. JSON was checked with duplicate-key detection. Binary
containers were structurally inspected and hashed. `PASS` in the per-file
ledger means that this review found no concrete P0/P1 defect; it is not formal
verification or deployment evidence.

Baseline reproduction at the same frozen commit passed `bun run validate:all`,
`bun run check:bundle`, `bun run test:coverage`, the ROS definition validator,
and the supported release-only native-detector CLI help build. The initial
bundle was 432.3/700 KiB gzipped and Vitest ran 45 files / 305 tests. `bun audit`
reported no vulnerabilities. A later crates.io index update yanked the two
transitive `spin` versions selected by Zenoh 1.9, causing a new `cargo-deny`
failure; that post-freeze supply-chain condition is tracked separately and must
be remediated on the candidate rather than hidden.

## P1 defect register

These IDs are stable references for the frozen review. Completion requires a
tested fix or removal/narrowing of every contradicted release claim.

| ID | Frozen defect and decisive counterexample |
|---|---|
| F001 | `src/lib/glbValidation.ts` validates the first GLB JSON chunk while Three.js consumes the last; a safe first manifest plus an external-URI second manifest is accepted. |
| F002 | The production artifact scanner accepts direct `fetch`, XHR, EventSource, `sendBeacon`, and WebTransport even though it claims a renderer network-boundary proof and CSP permits HTTPS. |
| F003 | Native rosbridge runs callbacks on its only reader task; a slow callback blocks all topics and a panic can bypass disconnected-state cleanup. |
| F004 | Native rosbridge JSON parsing silently accepts duplicate keys with last-value-wins semantics at every object depth. |
| F005 | ROS's legal IMU orientation-unavailable sentinel is erased, making unavailable orientation indistinguishable from measured orientation. |
| F006 | ONNX postprocessing traverses unbounded anchors/classes before candidate limits and admits non-finite/domain-invalid scores and geometry. |
| F007 | Removing a target aborts only active missions; a pending mission can strand its interceptor permanently. |
| F008 | GPS dropout readings bypass the latency buffer, so delayed output can remain a valid fix throughout an outage. |
| F009 | Native transport connect/disconnect/subscribe operations lack generation fencing; a cancelled connect can install a live bridge after disconnect. |
| F010 | Unknown `CREBAIN_ZENOH` values silently select rosbridge instead of failing configuration. |
| F011 | Reference simulation launches a generic unauthenticated rosbridge on an empty/default bind address. |
| F012 | Version/authorship/evidence sources remain at 0.4.0/generic attribution instead of the requested 0.9.0 and Sepehr Mahmoudian. |
| F013 | ROS threat constants use 0–3 while canonical TypeScript uses 1–4; interception strategy is numeric on ROS and a string union in TypeScript. |
| F014 | The shipped 3.2 MiB GLB has no creator/source/license/retrieval/modification evidence, so redistribution rights are unproved. |
| F015 | Baseline native fusion combines equal numeric coordinates from unequal or absent frame identities without a transform. |
| F016 | Baseline fusion applies stale/future/nonmonotonic measurements at the frame time and awards fresh hit/state mutation. |
| F017 | Exact repeated/correlated measurements update sequentially as independent evidence and can collapse uncertainty/confidence. |
| F018 | Gaps above 60 seconds discard elapsed prediction time but still advance the track clock to the full timestamp. |
| F019 | Galadriel observation admission does not bind observation time/content to the claimed fusion-frame attempt. |
| F020 | “Newest” native admission keeps vector tail without a timestamp-order invariant and can discard the newest measurement. |
| F021 | Transform lookup chooses nearest samples independently per edge and labels a temporally incoherent multi-hop chain with the requested time. |
| F022 | Renderer camera ingress has unbounded async decode concurrency and lacks common encoded-byte, decoded-pixel, signature, raw-allocation, and restart-generation controls. |
| F023 | Renderer rosbridge does not retain subscription IDs, so reconfiguration/unsubscribe uses unmatched IDs and can leak duplicate subscriptions; same-topic type conflicts are pooled. |
| F024 | Renderer rosbridge parses unbounded JSON, lacks message schemas, and lets one throwing callback prevent later consumers. |
| F025 | The Nix package does not build the frontend from a clean source, omits Darwin package inputs, and CI only evaluates rather than builds it. |
| F026 | Generic model path validation accepts special files/directories/symlinks for regular-file models and has reopen/TOCTOU exposure. |
| F027 | Drone reaction torque/inertia handling is not orientation-equivariant in local or Rapier dynamics. |
| F028 | Reusing a drone ID overwrites the map after allocating a new Rapier body, leaking the prior body. |
| F029 | Any `v*` tag can create release artifacts without the documented validation, coverage, security, version/tag, evidence, or approval gates. |
| F031 | Browser triangulation accepts intersections where both rays point behind their cameras. |
| F032 | Browser tracking lacks a spatial gate and one-to-one assignment; two groups can update one track and `(camera,id)` collisions discard observations. |
| F033 | Scene-restore timeout sets flags but does not bound never-settling loaders/spawn calls, so restore and cleanup can hang indefinitely. |
| F034 | Diagnostics map backend “Not Initialized”/“Busy” and disconnected rosbridge states to ready. |
| F035 | Phase-0 production scanning silently omits tracked symlinks that a build tool may resolve. |
| F036 | Native Zenoh `disconnect → connect` marks a permanently closed session connected instead of reopening or rejecting reconnect. |
| F037 | Owned ROS sensor sessions retain buffers, tracks, timestamps, and modality health across involuntary disconnect/reconnect. |
| F038 | ROS performance “rolling” metrics are lifetime averages, so an old burst can make a frozen stream look healthy. |
| F039 | Version/tag checking compares two equivalent peels, accepts lightweight/wrong-commit tags, and treats repository-required sources as optional. |

## Secondary defect register

The following remain real candidate work even where they do not contradict the
narrow 0.9 source-review claim:

- S001: GLB root arrays and signature-only fake PNGs pass a validator described
  too strongly.
- S002: barometer `updateRate`, `temperatureDrift`, and `latencyMs` are declared
  but ignored.
- S003: multi-drone launch cardinality arguments do not generally control the
  number of spawned models.
- S004: the ROS package omits its runtime `mavlink_sitl_gazebo` dependency.
- S005: detection overlay clamps the origin but not both endpoints, and accepts
  inverted/non-finite boxes.
- S006: `src/neuro/versionGuard.ts` still describes NCP wire 0.7 while enforcing
  the frozen 0.8 contract.
- S007: MLX model-contract mismatches silently become zero detections.
- S008: TensorRT and frontend native-result boundaries insufficiently reject
  malformed scores/boxes/classes/timestamps.
- S009: production MLX/TensorRT NMS implementations lack parity evidence with
  the tested common NMS.
- S010: `AdvancedSensorFusion` can replace sensor time with wall time and lacks
  strict response count/integer/range limits.
- S011: Zenoh browser subscription policy/callback iteration/error isolation is
  inconsistent and ignores `queueLength`.
- S012: MessageRegistry advertises validation/mapping that the live event path
  bypasses; its image validator conflicts with the base64-only contract.
- S013: React updater callbacks contain scene/control side effects and selection
  rings use local positions for nested objects.
- S014: guidance time regression can increase speed away from zero and `Hold`
  can carry nonzero velocity.
- S015: 3D dragging mixes world/local coordinates and may leak pointer/orbit
  lifecycle on failure or unmount.
- S016: keyboard output is frame-rate dependent.
- S017: route editing rewrites valid zero altitude, accepts non-finite values,
  and has no waypoint cap.
- S018: ROS controls allow overlapping operations during reconnect.
- S019: native Zenoh poison recovery can return subscription success after
  dropping the subscriber.
- S020: malformed sensor traffic marks modalities active before validation.
- S021: custom `trtexec` output is buffered without a bound.
- S022: standalone reference rosbridge also defaults to an exposed insecure
  bind/rosapi configuration.
- S023: transform shortcut help disagrees with its implementation and hidden
  controls retain handlers.
- S024: changelog text contradicts active Dependabot configuration.
- S025: the bundle checker tolerates missing graph references and measures only
  the first entry.

## Binary evidence

The shipped GLB is structurally valid GLB 2.0 with one JSON and one BIN chunk,
20,974 vertices, 89,178 indices, an embedded 2048×2048 JPEG, and SHA-256
`7530a17e1a4a2c3bc1c364c7defce0f656f82af2b0e888aec68faf1bfd9937db`.
That structural result does not establish redistribution rights (F014).

All Tauri icon PNGs, ICO/ICNS containers, and contained PNGs passed structural
bounds/CRC/decompression checks. `public/crebain-logo.png` and
`public/crebain.png` are identical valid 1024×1024 images with SHA-256
`ff61865def6411c20d5566905d49c93359e3f76cb7a8834918245d7574b00eaa`.
Their C2PA metadata labels trained-algorithmic/GPT-4o media; external trust-chain
validation was not performed.

## Evidence limits

No live ROS/Gazebo/Zenoh topology, Tauri GUI/device launch, model accuracy,
target GPU/CoreML behavior, TLS/ACL/PKI, Haldir/Engram/Prisoma integration,
Galadriel receiver delivery, SITL/HIL, field behavior, independent clean-room
build, human critical-file review, or cryptographic release signature was
established by this frozen review. Those claims remain removed or open.
