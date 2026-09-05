# Native local NCP simulation

The `crebain-ncp-simulation` process owns a bounded CREBAIN body through the native NCP local profile.
Its application profile is `crebain.local-kinematic-kalman.v1`.
It serves one supervisor-owned run through inherited standard input and standard output.
The process opens no network listener and supplies no physical command authority.

![Native NCP simulation ownership and evidence](../assets/diagrams/native-ncp-simulation.svg)

Text alternative: The supervisor supplies one immutable binding and plan.
The native owner verifies each retained neural response against its current snapshot.
It advances the project-local kernel once and returns actual application and innovation evidence.
The owner retains the exact response until acknowledgement.
An uncertain execution retires the generation.

## Build and launch

The package has a separate workspace and lockfile.
It uses the standalone `ncp-local` SDK from `NCP/local/rust`.
Its manifest selects version `=1.0.0` at immutable NCP revision `de751d499b5e07d1c95a072e08255083d77cb38b`.
Its lockfile resolves that same public Git revision and SDK version.
The native package does not permit a sibling SDK fallback.
Dependency resolution and component tests do not replace the installed artifact gate.

<!-- ncp-local-pin: 1.0.0 de751d499b5e07d1c95a072e08255083d77cb38b -->

```bash
cargo build --locked --release \
  --manifest-path src-tauri/crates/ncp-simulation/Cargo.toml
```

A supervisor launches the resulting binary with `--binding '<JSON>'`.
The binding contains the exact profile digest, run UUID, endpoint generation UUID, and `body` role.
The binary rejects other arguments.
The binding establishes local context; it is not a signature or executable attestation.

NCP owns the length framing, request digests, sequencing, result retention, and acknowledgement.
The body exposes only `prepare`, `step`, `finish`, and `abort` application operations.
The binary does not invoke historical Host API dispatch.
The [kernel document](NATIVE_SIMULATION_KERNEL.md) defines the reused numerical implementation.

## Prepare contract

The shared `PrepareData` contains the complete `RunPlan`, exact application profile, and closed `BodyConfiguration`.
Preparation admits one to three entities and one to 1024 planned steps.
Each step spans one to 1000 integral milliseconds.
The body requires entity identifiers that start with a lowercase letter.
Remaining characters are lowercase letters, digits, underscores, or hyphens.
The common plan can admit identifiers that this body application rejects.

| Configuration field | Required meaning |
| --- | --- |
| `initial_position_m` | Three ENU position components per entity; absolute component limit: 100000 meters. |
| `initial_velocity_mps` | Three ENU velocity components per entity; vector speed limit: 100 meters per second. |
| `sensor_variance_m2` | Three positive visual variances per entity; component limit: 1000000 square meters. |
| `expected_neural_generation` | Exact supervisor-installed neural generation, distinct from this body generation. |
| `schedule` | At most 256 unique rows, sorted by `(step, entity_id)`. |

Each schedule row fixes a step, entity, sensor offset, sensor availability, and actuator availability.
Offsets have a component limit of 50 meters.
A row applies only at its declared step.
Unlisted steps admit the sensor and actuator with zero sensor offset.
The step operation accepts no environment or fault override.

The internal kernel label is `ncp.` followed by the external run UUID.
This deterministic local label satisfies the kernel grammar.
It does not replace any external NCP identity or rename entities.

Preparation returns the plan digest, application profile, and actual initial snapshot.
The retained prepare response binds the complete configuration through its request digest.
The initial filter track has no prior innovation and reports `birth` without a numeric NIS.

## Coupled step

A step contains the complete retained neural response.
The body reconstructs the expected neural request from its own retained source snapshot.
It verifies the response digest, request digest, role, generation, sequence, and committed outcome.
It then verifies the proposal's source, plan, time, roster, units, modes, and numeric bounds.

For logical step `k`, the expected neural sequence is `k + 1`.
Sequence one belongs to preparation.
Result queries and acknowledgements do not consume application sequence positions.
The source snapshot is the completed body boundary `k - 1`.

Each available entity supplies ENU position followed by ENU velocity.
An unavailable entity supplies an explicit false availability value and six inert zeros.
Only that entity requires `zero_acceleration` on its next proposal.
Other entities can remain active.
Zero acceleration permits existing velocity to continue.

The kernel applies frozen actuator availability and its existing numerical bounds.
The body result preserves proposed acceleration, actual applied acceleration, and actuator saturation separately.
It reports the next snapshot and genuine Kalman innovation evidence.
It never infers successful application from the proposal alone.

## Evidence and failure limits

Observed innovations include actual sensor labels, track IDs, fusion sequences, measurement times, residuals, covariance, NIS, and dimension.
Missing measurements clear numeric innovation evidence for that step.
The profile's numerical evidence limits can reject a computed result after kernel advancement.
Such a failure is indeterminate and retires the generation.
The process never drops evidence silently to return success.

Admission failure preserves the source snapshot and kernel state.
A failure after admitted execution clears the backend and prevents further execution.
NCP retains the terminal outcome when it can construct one.
A supervisor must distinguish a closed captured prefix from a complete run.

`finish` requires the exact plan digest and complete planned step count.
Premature completion fails before cleanup.
`abort` accepts an empty object and clears the current body state.
Both terminal operations report cleanup and permit no later body preparation in that generation.

## Verification

```bash
bun run check:ncp-coherence
bun run validate:ncp-simulation
```

The offline coherence check joins the native manifest, lock version, exact Git source, and documentation marker.
It separately preserves the historical wire-0.8 dependency checks.
The native aggregate checks formatting, release compilation, all-target tests, doctests, strict Clippy, and Rust documentation.
Both `validate:all` and the existing Rust CI job invoke this aggregate.
The existing supply-chain job separately audits this package with `src-tauri/deny.toml`.
It uses the pinned cargo-deny action, including version 0.20.2, without a native policy exception.

The native tests run the actual kernel for one-, two-, and three-entity rosters.
They compare trajectories with direct kernel execution and test source drift, missingness, application differences, exact recovery, and execution failure.
A separate process test exchanges framed NCP bytes through private standard I/O.
The controlled neural proposals in these tests are synthetic test inputs.
These tests do not establish real NEST execution, installed ecosystem interoperability, calibrated inference, or physical safety.
