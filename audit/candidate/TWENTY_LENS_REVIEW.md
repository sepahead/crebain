# Lead twenty-lens review — 0.9 candidate

Review basis: frozen commit `4c311900ade5668200a48d56fb191be1916b884a`,
the 314-file frozen ledger, the F001–F039/S001–S025 defect register, and the
0.9 candidate diff. This is a lead/coordinator review supported by separate
agent contexts, not independent human review. “Resolved” below means fixed or
removed from the narrow 0.9 claim; it does not close the supplied 1.0 ledger.

| Lens | Candidate finding and disposition | Evidence | 0.9 status |
|---|---|---|---|
| L01 Claims and scope | Prior language could imply operational, secure, accurate, or converged capability. The product profiles and release decision limit 0.9 to a research-only source and package claim. | `docs/NARROWED_GO_0.9.0.md`; product profiles; release body | Resolved by narrowing |
| L02 First-principles semantics | Authority, mutation, transport, fusion-engine, timestamp, frame, lifecycle, and error roles are now stated as contracts rather than inferred from names. | product profiles; IPC registry; `SENSOR_FUSION.md`; transport/scene tests | Resolved for 0.9 |
| L03 Mathematics and statistics | Physics torque, browser assignment/cheirality, native measurement time/frame/dedup/gap semantics, and NMS/numeric bounds were repaired. No numeric quality result is inferred; the future metric protocol is preregistered. | physics/fusion tests; `FUSION_VALIDATION_PROTOCOL.md` | Resolved by fix plus no-result claim |
| L04 Type and state integrity | Invalid profiles remain unreachable; transport generations, diagnostics states, model file kinds, native results, schemas, and duplicate IDs/keys fail closed. | profile/IPC mutation tests; path/transport/diagnostic tests | Resolved for covered 0.9 surfaces |
| L05 Time, ordering, and replay | Fusion rejects future/replayed/stale inputs before mutation; TF chains use one common time; transport/scene/camera generations fence late work; reconnect clears retained sensor state. | native fusion, TF, transport, camera, scene deadline tests | Resolved for component claim; deployment clocks open |
| L06 Identity and provenance | Frozen inputs/files and upstream compatibility crates are digest-bound. Unlicensed GLB was removed. Release packages receive checksums, SBOM, manifest, and workflow attestation. No model provenance is invented. | input/file manifests; vendor provenance; release workflow | Resolved for source/release identity; external models open |
| L07 Authentication and cryptography | No TLS/ACL/principal, receiver, signed-tag, or independent-signature evidence exists. Those claims are explicitly NO_GO; workflow attestations do not substitute. | NARROWED_GO; security/deployment docs | Resolved only by claim removal |
| L08 Authority and safety | All 0.9 profiles have `authority: none`; packaged IPC has no plant apply/publish/service route; the zero-dependency plant package remains unwired. Haldir/ExternalAuthority are unavailable. | product profile verifier; IPC registry; plant/production boundary gates | Resolved for NoAuthority |
| L09 Hostile inputs and parsers | GLB/PNG/JSON, ONNX/YOLO/native-result, paths, scenes, transport messages, and release/evidence manifests receive duplicate, numeric, structure, type, and size checks with negative fixtures. | parser/path/IPC/transport tests and mutation self-tests | Resolved for tested surfaces |
| L10 Resource and denial of service | Camera bytes/pixels/decode concurrency, native pull/ack work and topic slots, fusion inputs/tracks/dedup, callbacks, native outputs, JSON, trtexec output, GLB/PNG, bundle size, and evidence reads are bounded before or during costly work. | constants and boundary tests; bundle gate | Resolved for component bounds; long-duration deployment open |
| L11 Concurrency and lifecycle | Callback panic/HOL, reconnect races, stale generations, exact camera subscription reopen identities, in-flight camera work, pending mission removal, scene deadlines, and start idempotence were addressed with cleanup tests. | transport/camera/scene/physics/monitor tests | Resolved for component lifecycle |
| L12 Determinism and reproducibility | Locks, pinned actions/toolchains, deterministic inventories, Bun dependency Nix expression, clean Nix frontend+Tauri package, version/tag guard, and release evidence workflow are defined. Independent clean-room reproduction is absent. | `bun.nix`; Nix/release workflows; verifier scripts | Partial; independent reproduction NO_GO |
| L13 API, FFI, and SemVer | 0.9 metadata is coherent across npm/Cargo/Tauri/CFF/ROS/Nix; IPC commands/events are registered; only an annotated exact `v0.9.0` tag may release; retired 0.4 identity is not reused. | version/IPC tests; `RELEASE_HISTORY.md` | Resolved for 0.9 metadata/API inventory |
| L14 Schema, wire, and language parity | ROS threat/strategy contracts match canonical ranges/types; transport camera/IMU schemas preserve sentinels; native/frontend IPC and event sets are checked. Full external final-wire parity remains unavailable. | ROS definitions; transport tests; IPC registry | Resolved locally; external final contracts NO_GO |
| L15 Configuration and deployment | Ambiguous Zenoh selection fails; model final symlinks/special files fail; local rosbridge defaults loopback with rosapi off; deployment security and remote topology are not claimed. | config/path/ROS launch tests/docs | Resolved for local config; deployment NO_GO |
| L16 Observability and forensics | Busy, not initialized, disconnected, degraded, stale, unavailable, truncated, and unsupported states are no longer collapsed into ready/success where reviewed. | diagnostics, monitor, transport, fusion response tests | Resolved for reviewed component states |
| L17 Verification and evidence quality | Baseline and candidate gates, mutation fixtures, hostile parsers, exact manifests, and separate review lanes exist. The lanes are same-team agents; no theorem, field campaign, or independent reproduction is asserted. | frozen review report; task disposition; hosted evidence workflow | Partial; independent/physical evidence open |
| L18 Ecosystem composition | NCP/Galadriel paths remain dormant/exactly gated and non-authoritative; Haldir/Engram/Prisoma/final five-repo convergence is unavailable and blocks 1.0. | product profiles; NCP/Galadriel docs; task T144–T156 dispositions | Resolved by explicit 0.9 boundary |
| L19 Human factors and governance | Author/version/citation/copyright are coherent; 0.4 draft retirement is recorded; release is labeled research-only and prerelease; vulnerability/withdrawal paths remain documented. | metadata; release history/workflow; SECURITY | Resolved for 0.9 governance |
| L20 Counterfactual and quirky cases | Tests now cover contradictory GLBs, duplicate keys, behind-camera rays, identity collisions, stale/reordered time, long gaps, special paths, slow/panicking callbacks, never-settling loads, reconnect, missing graphs, and mutated evidence. | F/S regression tests and verifier mutation suites | Resolved for enumerated 0.9 counterexamples |

## Lead conclusion

No reviewed P1 counterexample is accepted as an undocumented 0.9 behavior or an
inflated claim. Residual live-topology, hardware, accuracy, security, authority,
independence, and cross-repository gaps are terminal NO_GO conditions for 1.0
and operational use. Subject to the exact automated release gates passing, the
candidate is NARROWED_GO only in the sense defined by
`docs/NARROWED_GO_0.9.0.md`.
