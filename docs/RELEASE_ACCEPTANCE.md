# CREBAIN Release Acceptance Matrix

This matrix defines evidence required before a stabilization batch, demo build,
or release candidate is called ready. Numeric performance, accuracy, transport,
scientific, and safety claims require measurements from the candidate in its
target environment.

## Required evidence

| Area | Acceptance evidence | Blocking conditions |
|------|---------------------|---------------------|
| Local cross-language gate | `bun run validate:all` passes: Phase 0 baseline plus fail-closed self-test; NCP manifest/lock/doc coherence; frontend typecheck/lint/format/tests; inert plant dependency boundary/scoped-rustfmt/check/test/strict-clippy/headless self-check; Rust fmt/default check/test/clippy; NCP-feature clippy/tests | Any error, inventory/config/pin drift, stale normative NCP version, plant-boundary drift, test failure, or clippy warning |
| Hosted frontend gates | CI `bun run validate`, `bun run check:bundle`, and `bun run test:coverage` pass; every build emits a module graph, excludes the development rosbridge module, hashes/scans every finalized JavaScript chunk, runs split/aliased/reflective artifact rejection fixtures, and `check:bundle` then applies the size budget | Module graph, chunk hash/capability scan, artifact self-test, bundle budget, or coverage threshold fails, even if `validate:all` passed locally |
| Hosted Rust feature gates | Linux checks pass for `--features cuda,tensorrt` and `--no-default-features`; default and NCP jobs pass on Linux/macOS | Feature-gated code does not compile or NCP tests are skipped |
| Supply chain and static analysis | cargo-deny, `bun audit`, pinned-action policy, and CodeQL workflows pass for the candidate/dependency change | Advisory/policy failure or unresolved high-confidence finding |
| Documentation drift | README, AGENTS, CONTRIBUTING, SECURITY, ROS/model/NCP docs, and workflows agree on commands, status, limits, and boundaries | Stale command, unsupported capability, invented count/run, or mismatched protocol/model claim |
| Native launch | Tauri app launches on each release platform and diagnostics render actual backend availability | Crash, missing diagnostics, or misleading mode label |
| Models | Exact artifact digest, model path, input/output tensors, preprocessing, postprocessing, class map, fixtures, and rights are recorded; MLX safetensors inputs receive the same review | Assuming a five-class `[1,9,N]` exporter fits the native COCO-80 `[1,84,N]`/`[1,N,84]` parser; unverified model |
| Scene JSON | Browser paths and serialized production-handler native IPC tests reject a non-JSON, traversing, outside-root, missing, malformed, invalid-UTF-8, or >10 MiB scene file; migration precedes strict validation; bounds/references are enforced | Unbounded parse/read, schema bypass, path escape, or non-atomic native save |
| Scene asset restore | Only reloadable relative/HTTPS/loopback sources persist; GLB is self-contained; per-file/aggregate/pixel/time limits hold; superseded/partial restores are surfaced | External GLB fetch, hidden partial failure, stale load mutation, or any byte/pixel budget bypass |
| ROS 1 / Gazebo Classic | Packaged UI is Zenoh/read-only; development and native rosbridge fallbacks are telemetry-only and tested against the documented ROS 1 message packages | Any renderer/native publish, setpoint, service, MAVROS mode/mission, or Gazebo mutation capability; claiming reference definitions are product commands |
| Camera transport | Raw and compressed fixtures pass on rosbridge and native Zenoh; malformed base64/CDR, sizes, formats, timestamps, matrices, and distortion arrays fail | Suffix-inferred schema, JSON byte-array ingress, dimension/allocation bypass, or divergent transport behavior |
| Transport authority boundary | Present executable Vite/Cargo/Tauri inputs and the release workflow are pinned; root Cargo config, Vite environment/config alternatives, and Tauri platform merge configs are explicitly locked absent; tracked build/release invocations reject `--config` and `TAURI_CONFIG`; comment-stripped Rust must contain exactly one real Tauri handler list; AST/token checks cover literal, split, template, array-joined, aliased, reflective, descriptor/global destructuring, dynamic-constructor, and conservative macro routes/capabilities; dependency-only Spark/Rapier `new Function` sites are explicit locked vendor exceptions under CSP without `unsafe-eval`; development network modules and the single bounded production fetch adapter are explicit; registered IPC and native transport methods are compared | New public/build/conditional input or explicit config override, handler comment shadow or second list, unresolved route macro, global capability recovery, project dynamic constructor, undeclared renderer network module, generic publish/service method, direct actuator route, packaged rosbridge client, or inventory drift |
| Inert plant foundation | `crebain-plant-authority` remains a separate zero-dependency workspace package; the Tauri application does not link it; `crebain-plantd --self-check`, lifecycle properties, channel/snapshot stress, passive monotonic-expiry boundaries, and strict Clippy pass | Treating self-check, generic snapshot storage, or the passive expiry guard as trusted health/live authority/watchdog evidence; adding renderer/Tauri/model/simulation/transport dependencies, action ingress, or an adapter without the later profile/governor/watchdog gates |
| Hazard promotion evidence | A controlled hazard has exact hazard/control-bound test declarations plus a typed content-hashed JSON artifact recording the passing command/result and candidate commit | Status-only promotion, unrelated selector/path, missing control coverage, failed command, placeholder commit, or artifact/hash/binding mismatch |
| Zenoh limitations | Every telemetry topic and plain-key topology is documented/tested; unsupported services/custom arrays remain explicit; a re-key bridge is present for direct `rmw_zenoh_cpp` claims | Treating `RMW_IMPLEMENTATION=rmw_zenoh_cpp` alone as interoperability or claiming publish/service authority over native Zenoh |
| Sensor fusion | Config/measurement/track bounds and deterministic lifecycle/filter scenarios pass; disconnect/coast/expiry behavior is exercised | Invalid config, unbounded growth, false hit credit, stale track, or overlapping fusion cycles |
| NCP opt-in | Default runtime remains independent; NCP feature compiles/tests; missing secure config fails closed; quiet development is explicit; lifecycle `ok`, payload/command bounds, subscriber cleanup, raw ESTOP, malformed dev-call HOLD, per-entity sequencing, TTL, and final-HOLD failure reporting are tested | Registering/invoking dormant paths accidentally, accepting inferred success, sharing action state across entities, or claiming a live/TLS-secure loop without deployment evidence |
| PID JSONL | Candidate proves local append/parser/basic NIS behavior and documents trusted-path/best-effort semantics | Claiming Galadriel correlation, PID control, ACL, versioned streaming, or live NCP from JSONL-only tests |
| Manual smoke | `docs/MANUAL_SMOKE_TEST.md` records target platform/model/topology and has no release blocker | Critical path incomplete, inconsistent diagnostics, data loss, or unsafe boundary behavior |
| Performance claims | Reproducible command, artifact digest, target hardware, thresholds, and raw result are archived | Any numeric claim without candidate-specific evidence |

| Error handling | External-boundary failures return structured error payloads or explicit typed failures; serialized production-handler IPC negatives exercise Tauri argument decoding plus scene, detector, fusion, and topic validation | Silent fallback, ambiguous success, or leaking sensitive internals |

## Release Candidate Gate

A candidate may be tagged only when:

1. local and hosted gates above pass on the same commit;
2. the evidence log names that exact commit and hosted runs without placeholder counts;
3. manual smoke has no unresolved release blocker;
4. experimental and dormant paths cannot masquerade as validated product capability; and
5. every external input path is validated, tested, or explicitly ruled out of scope.
