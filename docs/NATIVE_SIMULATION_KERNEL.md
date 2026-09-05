# Native simulation kernel

The project-local Rust kernel can serve a separately implemented native protocol adapter.
This document defines kernel reuse and diagnostic recording only.
It does not establish native NCP interoperability or release qualification.

## Ownership

`crebain-managed-simulation` exposes `MultiDroneSimulation` as a Rust library.
Its public states are `Unprepared`, `Prepared`, and `Finished`.
Preparation and stepping perform no I/O and start no server.
The kernel has no external Host API dependency, NCP dependency, or network dependency.

The existing managed binary explicitly calls `serve_managed_runtime`.
A native binary must call the kernel and its selected NCP server instead.
It must expose no generic Host API dispatch or fallback operation.
Importing the library alone does not invoke the historical server.

## Diagnostic selection

`prepare(request)` keeps innovation recording disabled.
The historical wire schemas contain no recording selector.
They reject a caller-supplied `innovation_recording` field.

Project-local callers can select this option before preparation:

```rust,ignore
let (mut simulation, initial) = MultiDroneSimulation::new()
    .prepare_with_recording(request, InnovationRecording::KalmanInnovationV1)?;
let result = simulation.step(step_request)?;
let diagnostic_frame = simulation.latest_innovations();
```

The caller must bind this selection in its own prepared native profile.
Historical request, state, and receipt digests do not include the diagnostic frame.
An unchanged historical digest therefore does not identify diagnostic content.

Recording enables the existing fusion implementation's innovation emission.
It adds no measurements and changes no body or filter arithmetic.
The default and recorded kernels retain identical historical response bytes for identical requests.

## Recorded meaning

The kernel retains only the latest committed interval.
Each interval has exactly one row per prepared entity, in roster order.
A successful step replaces every row.
A rejected step preserves the previous frame and its previous step index.

| Field | Meaning |
| --- | --- |
| `entity_id` | Exact prepared entity identity. |
| `sensor_id` | Actual configured simulator sensor label. It does not authenticate transport origin. |
| `fusion_track_id` | Lane-local track identifier from the accepted update. Different entities can reuse its number. |
| `fusion_sequence` | Actual fusion frame sequence. It differs from the simulator step index. |
| `measurement_timestamp_ms` | Original measurement time in simulation milliseconds. |
| `modality` | Actual admitted modality. The current kernel uses Visual. |
| `innovation_m` | Actual ENU measurement residual, in meters. |
| `innovation_covariance_m2` | Actual ENU innovation covariance, in square meters. Rows precede columns. |
| `nis` | Dimensionless normalized innovation squared from the existing Cholesky calculation. |
| `degrees_of_freedom` | Actual residual dimension. The current Kalman update uses three. |

The frame's interval endpoints describe body advancement.
The statistic belongs to the measurement at the interval end.
It is not an average over that interval.
Preparation has the zero-width interval `[0, 0]`.

`Observed` contains the actual accepted update.
`SensorUnavailable` means the step supplied no measurement for that entity.
`NoAcceptedUpdate` includes initial track birth and updates that emitted no statistic.
Neither absence contains a numeric substitute.
An observed zero remains an observed zero.

The collector drains each fusion buffer before committing the step.
It rejects stale timestamps, unexpected sequences, wrong tracks, wrong modalities, and multiple records.
It also rejects missing residual or covariance fields and incompatible evidence.
No historical innovation tail accumulates in the simulator.

## Mathematical scope

Let `r` be the three-component ENU residual, measured in meters.
Let `S` be its innovation covariance, measured in square meters.
The existing filter computes the dimensionless statistic `q = rᵀ S⁻¹ r` through Cholesky factorization.

For example, let `r = [0.1, -0.2, 0.3]` meters and `S = diag(2, 2, 2)` square meters.
Then `q = (0.01 + 0.04 + 0.09) / 2 = 0.07`.
This arithmetic example is not a retained simulator measurement.

A chi-square interpretation requires a correctly specified Gaussian innovation law and applicable dependence assumptions.
The recorded simulator values do not establish those assumptions or operational calibration.
They provide no common-prior cross-sensor projection.
Different drones remain different tracks, not different sensor modalities.

Galadriel can consume genuine scalar diagnostics through an explicitly selected subset profile.
Its adapter must preserve exploratory classification, insufficient evidence, and unavailable measurements.
No diagnostic value grants command authority.

## Verification

Run the complete managed package tests:

```bash
cargo test --locked --release --manifest-path src-tauri/Cargo.toml \
  -p crebain-managed-simulation --all-targets
```

The recording controls compare 160 steps for each one-, two-, and three-entity roster.
They compare complete historical responses, including every receipt digest.
They exercise sensor dropout, actuator hold, recovery, source identity, bounded retention, and exact observed zero.
Additional controls reject stale, ambiguous, incompatible, and missing diagnostic evidence.

These are local kernel tests.
They do not execute NEST, an NCP endpoint, Galadriel, or a physical plant.
