# CREBAIN Release Acceptance Matrix

This matrix defines evidence required before a stabilization batch, demo build,
or release candidate is called ready. Numeric performance, accuracy, transport,
scientific, and safety claims require measurements from the candidate in its
target environment.

## Required evidence

| Area | Acceptance evidence | Blocking conditions |
|------|---------------------|---------------------|
| Local cross-language gate | `bun run validate:all` passes: frontend typecheck/lint/format/tests; Rust fmt/default check/test/clippy; NCP-feature clippy/tests | Any error, test failure, or clippy warning |
| Hosted frontend gates | CI `bun run validate`, `bun run check:bundle`, and `bun run test:coverage` pass | Bundle budget or coverage threshold fails, even if `validate:all` passed locally |
| Hosted Rust feature gates | Linux checks pass for `--features cuda,tensorrt` and `--no-default-features`; default and NCP jobs pass on Linux/macOS | Feature-gated code does not compile or NCP tests are skipped |
| Supply chain and static analysis | cargo-deny, `bun audit`, pinned-action policy, and CodeQL workflows pass for the candidate/dependency change | Advisory/policy failure or unresolved high-confidence finding |
| Documentation drift | README, AGENTS, CONTRIBUTING, SECURITY, ROS/model/NCP docs, and workflows agree on commands, status, limits, and boundaries | Stale command, unsupported capability, invented count/run, or mismatched protocol/model claim |
| Native launch | Tauri app launches on each release platform and diagnostics render actual backend availability | Crash, missing diagnostics, or misleading mode label |
| Models | Exact artifact digest, model path, input/output tensors, preprocessing, postprocessing, class map, fixtures, and rights are recorded; MLX safetensors inputs receive the same review | Assuming a five-class `[1,9,N]` exporter fits the native COCO-80 `[1,84,N]`/`[1,N,84]` parser; unverified model |
| Scene JSON | Browser and native paths reject a non-JSON, traversing, malformed, or >10 MiB scene file; migration precedes strict validation; bounds/references are enforced | Unbounded parse/read, schema bypass, path escape, or non-atomic native save |
| Scene asset restore | Only reloadable relative/HTTPS/loopback sources persist; GLB is self-contained; per-file/aggregate/pixel/time limits hold; superseded/partial restores are surfaced | External GLB fetch, hidden partial failure, stale load mutation, or any byte/pixel budget bypass |
| ROS 1 / Gazebo Classic | WebSocket UI is tested against the documented ROS 1 message packages and Gazebo Classic services; XML/name/pose policies hold | Claiming `/gazebo/spawn_entity`, accepting unsafe caller XML, or reporting mutation success without service success |
| Camera transport | Raw and compressed fixtures pass on rosbridge and native Zenoh; malformed base64/CDR, sizes, formats, timestamps, matrices, and distortion arrays fail | Suffix-inferred schema, JSON byte-array ingress, dimension/allocation bypass, or divergent transport behavior |
| Zenoh limitations | Every transport topic and plain-key topology is documented/tested; unsupported services/custom arrays remain explicit; a re-key bridge is present for direct `rmw_zenoh_cpp` claims | Treating `RMW_IMPLEMENTATION=rmw_zenoh_cpp` alone as interoperability or claiming Gazebo services over native Zenoh |
| Sensor fusion | Config/measurement/track bounds and deterministic lifecycle/filter scenarios pass; disconnect/coast/expiry behavior is exercised | Invalid config, unbounded growth, false hit credit, stale track, or overlapping fusion cycles |
| NCP opt-in | Default runtime remains independent; NCP feature compiles/tests; missing secure config fails closed; quiet development is explicit; lifecycle `ok`, payload/command bounds, subscriber cleanup, raw ESTOP, malformed dev-call HOLD, per-entity sequencing, TTL, and final-HOLD failure reporting are tested | Registering/invoking dormant paths accidentally, accepting inferred success, sharing action state across entities, or claiming a live/TLS-secure loop without deployment evidence |
| PID JSONL | Candidate proves local append/parser/basic NIS behavior and documents trusted-path/best-effort semantics | Claiming Galadriel correlation, PID control, ACL, versioned streaming, or live NCP from JSONL-only tests |
| Manual smoke | `docs/MANUAL_SMOKE_TEST.md` records target platform/model/topology and has no release blocker | Critical path incomplete, inconsistent diagnostics, data loss, or unsafe boundary behavior |
| Performance claims | Reproducible command, artifact digest, target hardware, thresholds, and raw result are archived | Any numeric claim without candidate-specific evidence |

| Error handling | External-boundary failures return structured error payloads or explicit typed failures | Silent fallback, ambiguous success, or leaking sensitive internals |

## Release Candidate Gate

A candidate may be tagged only when:

1. local and hosted gates above pass on the same commit;
2. the evidence log names that exact commit and hosted runs without placeholder counts;
3. manual smoke has no unresolved release blocker;
4. experimental and dormant paths cannot masquerade as validated product capability; and
5. every external input path is validated, tested, or explicitly ruled out of scope.
