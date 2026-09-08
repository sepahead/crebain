# CREBAIN agent contract

CREBAIN develops standalone 3D simulation, sensor models, visualization, and sensor-fusion research.
Its desktop, native environment, and protocol adapters have distinct ownership and evidence contracts.
Every completion claim must identify the tested scope and remaining limitations.

## Read before changing

Read [README.md](README.md) first.
Then read the document that owns the affected surface:

| Surface | Owning documents |
| --- | --- |
| Native city, actual observations, renderer lifetime, coupled forks | [Native environment](docs/NATIVE_ENVIRONMENT.md) |
| Rapier world, actions, time, complete CPU state, replay | [Deterministic dynamics](docs/DETERMINISTIC_DYNAMICS.md) |
| Local NCP body, numerical kernel, retained responses | [Local NCP body](docs/NATIVE_NCP_SIMULATION.md), [Numerical kernel](docs/NATIVE_SIMULATION_KERNEL.md) |
| Desktop, module ownership, camera delivery | [Desktop architecture](docs/ARCHITECTURE.md), [Desktop workflows](docs/WORKFLOWS.md) |
| Sensor fusion, association, covariance, evidence | [Sensor fusion](docs/SENSOR_FUSION.md), [Fusion validation](docs/FUSION_VALIDATION_PROTOCOL.md) |
| Models, inference, benchmarks | [Model contracts](docs/MODEL_CONTRACTS.md), [Detector benchmarks](docs/NATIVE_DETECTOR_BENCHMARK.md) |
| Scene files, downloads, settings, controls | [Configuration](docs/CONFIGURATION.md), [Controls](docs/CONTROLS.md) |
| ROS and Zenoh telemetry | [ROS reference](ros/README.md), [Desktop architecture](docs/ARCHITECTURE.md) |
| Retained wire-0.8 bridge or advisory producer | [Retained NCP bridge](docs/NCP_BRIDGE_HANDOFF.md), [Advisory producer](docs/GALADRIEL_PRODUCER.md) |
| Engram embedding | [Restricted embedding](integrations/engram/README.md) |
| Host API 2.0 package and recorded NEST work | [Host API package](integrations/engram/managed-simulation/README.md) |
| Inert plant components | The applicable `docs/PLANT_*.md` contract and [System context](docs/SYSTEM_CONTEXT.md) |
| Release or claim changes | [Release acceptance](docs/RELEASE_ACCEPTANCE.md), [0.9 release decision](docs/NARROWED_GO_0.9.0.md), [Security](SECURITY.md) |

Inspect the owning schema, implementation, tests, and current evidence before editing.
[docs/README.md](docs/README.md) indexes the complete contract set.
Historical records and proposed capabilities cannot override current executable boundaries.

## Working method

1. Inventory staged changes, unstaged changes, branches, and worktrees before recovery work.
2. Preserve unrelated changes and another contributor's active scope.
3. Compare five to ten credible approaches before each material decision.
4. State assumptions, benefits, failure modes, and a decisive experiment for each approach.
5. Use independent reviews for separable scientific, ownership, security, and release decisions.
6. Select a compatible design with explicit reasons and unresolved objections.
7. Implement generic, schema-driven behavior.
8. Add a negative control for each new accept path.
9. Add a positive control for each new rejection path.
10. Run the complete applicable gate before presenting a milestone for publication.

A majority vote cannot override a failed scientific or provenance requirement.
Do not branch on fixture names, expected outcomes, benchmark rows, or selected sample identities.
Freeze campaign inputs, source identities, rosters, seeds, exclusions, and unavailable inputs before inspecting outcomes.
Keep random samples separate from selected challenges and synthetic controls.
Retain failed trials and negative results. Do not replace difficult cases to improve scores.

Recover useful work at the hunk or component level.
Record retained, integrated, superseded, and rejected changes with reasons.
Remove a branch or worktree only after preserving its useful changes and audit evidence.
Follow the user's authorized publication workflow; do not create branches or publish another owner's changes by default.
Do not add AI co-author trailers or generated-by lines to commits or review descriptions.

## Runtime and scientific boundaries

### Native dynamics and environment

- Reuse the actual project dynamics. Do not substitute a duplicate simulator or fallback physics for a required Rapier run.
- Preserve explicit integer ticks and declared units. The city's positive-Y-up, positive-Z-forward frame is not ENU.
- An accepted future action is binding checkpoint state. Preserve order, pending actions, controller memory, motor state, battery, and random state.
- Direct snapshot equality is insufficient when future complete-state comparisons fail. Preserve the observed failures and reviewed replay boundary.
- CPU checkpoints are complete only for their admitted domain. Do not claim a desktop, sensor, fusion, or GPU checkpoint from a narrower owner.
- The coupled environment uses exact CPU reconstruction and fresh static renderers. Compare fresh matched siblings for controlled branch experiments.
- Privileged checkpoint and reference-label data must remain separate from ordinary predictor inputs.
- An owner-issued handle carries local authority. Copied JSON, hashes, declared source IDs, and audit strings cannot recreate that authority.
- Preserve negative zero, finite-number checks, exact frame/time meanings, and the closed plain-data admission policy.
- The audited copier bounds traversal and output. It does not isolate Proxy traps or descriptor allocation from arbitrary in-process objects.
- Reserve output and family capacity before execution or reconstruction. Keep unresolved cleanup charged to its original reservation.
- Separate actual CPU execution, accepted observations, and durable export. A post-transition failure cannot become rejection before execution.
- If CPU completion is unknown, report it as unknown. Preserve the last observed completed tick separately.
- Retire after uncertain required output. Do not silently roll back, resume, or publish an empty successful observation.
- Copy actual GPU readback before publication. A Promise timeout does not prove renderer termination.
- Signal only independently joined owned processes. Browser request routing is not operating-system network isolation.
- Preserve primary and cleanup failures separately. A later idempotent no-op cannot promote unresolved cleanup to confirmed.

The default city controller failed bounded attitude-tracking tests.
The one-drone force-ground profile reuses separately qualified, bounded force-attitude dynamics.
Coupled observations require their own qualification and gain no general tracking or stability credit.
The inspected Rapier free-rotation configuration omitted Euler gyroscopic evolution.
Determinism does not establish accurate aerodynamics, stable tracking, or delivery of requested acceleration.
Change physics or control behavior only through a separately reviewed profile or correction with decisive controls.

RGB, pressure, and thermal radiance must come from their declared actual observation implementations.
Do not relabel position truth, fabricated arrays, or RGB colors as measured sensor modalities.
The acoustic and thermal equations are explicit simulation models, without calibrated real-drone fidelity.
Their shared simulator causes and cloned noise streams do not establish independent measurements or replicates.
Raw modality output does not qualify fusion, tampering detection, or a completed Prisoma experiment.

### Separate integration contracts

| Surface | Boundary to preserve |
| --- | --- |
| Native city environment | Standalone, 1–256 admitted drones; no installed desktop/NCP environment profile |
| `crates/ncp-simulation` | Separate workspace, exact public `ncp-local` pin, 1–3-entity local kinematic/Kalman body |
| `crates/managed-simulation` | Host API 2.0, 1–3 simulator channels, independent fusion lanes; no NCP/Tauri/network/artifact/plant dependency |
| `crates/ncp-headless` | Separate opt-in wire-0.8 perception process; no translator or generic command capability |
| `src-tauri/src/ncp` | Off-by-default retained adapter; Tauri commands remain unregistered |
| `crates/plant-authority` | Inert, dependency-free, unwired foundation; no vehicle write or authority chain |

The native local body verifies the full retained neural response against its own source snapshot.
Preserve proposed acceleration, applied acceleration, saturation, availability, and genuine innovation provenance separately.
Clear missing innovation evidence each step. Birth or absence cannot become a numeric zero-NIS observation.
Zero acceleration permits existing velocity to continue.
A computed evidence-envelope failure after mutation is indeterminate and retires the generation.
Retain exact results until acknowledgement; an acknowledgement is separate from durable experiment capture.

Do not tunnel the historical Host API through NCP or silently substitute a sibling SDK dependency.
Every new composition needs an installed application contract and its own evidence.
Source pins, descriptor consistency, synthetic proposals, and component tests do not qualify installed ecosystem interoperability.
The host package's observed-build and pack receipts must retain exact clean-source and `scripts/engram_extension.py` joins.
Those receipts are not signatures or reproducible-build proof.

### Desktop, telemetry, models, and fusion

The normative native fusion engine is `src-tauri/src/sensor_fusion.rs`.
The browser geometric estimator has a different contract and cannot serve as its parity oracle.
Preserve modality/frame/timestamp, correlation, missingness, capacity-loss, and lifecycle rules before prediction or evidence mutation.
Registry transform declarations are not executed transforms or authenticated sensor provenance.
Component load tests are not deployment deadline evidence.

The product telemetry surface remains read-only.
Development rosbridge is excluded from production module graphs and finalized chunks.
The native rosbridge fallback is also subscription-only.
Neither path may publish vehicle setpoints, call ROS/Gazebo services, or change missions and modes.
Guidance remains a disabled-by-default local `NoAuthority` preview with generation retirement.
The Galadriel producer may write only its exact two advisory routes after every feature, runtime, registry, and configuration gate passes.
Local puts and secure configuration loading do not prove receiver delivery, TLS identities, ACLs, or end-to-end effects.

Restricted `engramHost=1` embedding cannot enable native IPC, telemetry, artifact exchange, physics, scene mutation, or the development command harness.
Preserve exact parent/origin/nonce, trusted-event parsing, heartbeat, message-rate, revocation, and unsupported-platform rules.
A nonce or browser probe does not attest process identity or native isolation.

No model weights ship with CREBAIN.
CoreML, ONNX, accelerated providers, and experimental Candle-on-Metal paths retain their exact model and platform contracts.
Synthetic detections, a successful forward, available hardware, and a latency artifact are different evidence scopes.
Validate source rights, model bytes, tensors, preprocessing, classes, thresholds, fixtures, and actual runtime before claiming model quality or performance.

## Code and resource discipline

Use functional React components and clean up effects, subscriptions, timers, and listeners.
Keep mutable non-render state in refs and use measured memoization where appropriate.
Use `src/lib/logger.ts` instead of production `console.*` calls.
Use named constants and bounded containers for high-frequency data.
Keep camera-feed updates at their documented 83-millisecond interval until profiling justifies a change.

Use Rust ownership and typed errors to make lifetime and failure states explicit.
Use `log::info/warn/error` instead of protocol-contaminating output.
Validate external paths, scene/model files, IPC payloads, ROS URLs, topics, and CDR metadata.
Move CPU-heavy work out of asynchronous executor threads with the owning bounded blocking-work policy.
Cancellation does not release reservations while detached work still owns them.

## Commands and gates

`package.json` is the executable command registry.
Use the repository's rustup toolchain and checked-in lockfiles.
Do not rewrite dependency policy or upgrade tools to bypass a failing gate.

| Change | Applicable checks |
| --- | --- |
| Documentation only | `bun run check:docs-visuals`, formatting, `git diff --check`; exercise changed command/status contracts |
| NCP manifests, locks, or normative prose | `bun run check:ncp-coherence`; native package changes also require `bun run validate:ncp-simulation` |
| Frontend behavior | `bun run validate` |
| Native environment, dynamics, Rust, IPC, transport, models, scenes, fusion, or cross-cutting behavior | `bun run validate:all` |
| Responsive UI or production graphics/bundle changes | Applicable source gate plus `bun run check:bundle` and `bun run test:responsive` |
| Installed, scientific, performance, or release claim | Every applicable target/runtime/model/receipt gate in [Release acceptance](docs/RELEASE_ACCEPTANCE.md) |

Focused commands include `bun run typecheck`, `bun run lint`, `bun run format:check`, and `bun run test:run`.
Rust commands include `bun run check:rust`, `bun run test:rust`, `bun run clippy:rust`, and `bun run fmt:rust:check`.
The complete local gate also covers managed simulation, native local NCP, retained NCP paths, and inert plant checks.
Hosted coverage, bundle, responsive-browser, feature, CodeQL, and supply-chain jobs remain separate where documented.
A partial command sequence is not a complete gate.

Use a bootstrap source gate before the exact publication commit.
Where qualification requires an immutable installed artifact, run the operational gate from that commit afterward.
The bootstrap commit grants no installed, model, field, authority, or scientific completion claim.

## Documentation language and consistency

Use a house style aligned with ASD-STE100 Issue 9.
Do not claim full controlled-dictionary compliance.
Use American English, active voice, one term per concept, and short connected paragraphs.
Limit procedural sentences to 20 words and descriptive sentences to 25 words when practical.
Give one instruction per numbered step. Put necessary conditions before their actions.
Define abbreviations, mathematical symbols, units, assumptions, and operating bounds.
Preserve exact identifiers, normative requirement words, protocol names, quotations, and legal terms.
Use `must` for requirements, `must not` for prohibitions, `may` for permission, and `can` for capability.
Use WARNING for injury or death and CAUTION for damage; explain the concrete applicable hazard.
Avoid slang, unnecessary jargon, Latin abbreviations, and decorative technical claims.

Keep requirements, historical observations, and proposed capabilities distinct.
Preserve frozen evidence, generated artifacts, vendored documentation, and failed trials without retroactive reinterpretation.
Keep equations, examples, diagrams, PDFs, and prose consistent.
Use self-contained SVGs, concise alt text, an adjacent text alternative, and direct original-asset links.
Inspect normal and enlarged renders, including mobile where relevant.
A scalable file does not prove that every host application supports interactive zoom.

Update the smallest owning document set.
Keep README, agent guides, contributing/security instructions, `docs/`, model/ROS guides, and executable workflows consistent when their contracts change.
Register changed Markdown/diagram coverage in `docs/markdown-visual-coverage.json`.
Do not add a second policy framework or hide a failed check with a broad exemption.
