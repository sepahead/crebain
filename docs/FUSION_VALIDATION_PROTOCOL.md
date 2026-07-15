# Fusion validation protocol 0.9.0

Status: **preregistered, not run**. This protocol fixes the measures and minimum
experiment structure before any CREBAIN fusion accuracy, calibration, identity,
latency, or resource claim. Component tests are not results under this protocol.

## Scope and identity

The subject is the Rust `MultiSensorFusion` engine at one exact commit, Cargo
lock, `FusionConfig` canonical digest, filter selection, compiler/toolchain,
platform, and build profile. Every run must also bind the truth-generator
version and digest, scenario ID, sensor models, units, source-frame identities,
random seed, sample rate, duration, warm-up interval, and raw output digest.

The browser camera estimator is a separate subject and must be reported in a
separate stratum. Its result must never be pooled with or described as parity
evidence for the native engine.

## Fixed experiment design

- Use at least 200 independently seeded trials per scenario/configuration cell.
  Seeds are the unsigned integers 0 through 199 unless a protocol revision is
  committed before observing results.
- Include stationary, constant-velocity, accelerating, coordinated-turn,
  crossing-target, merge/split proximity, entry/exit, and stop/restart truth.
- Cross those trajectories with low/nominal/high measurement noise, missed
  detections, clutter/false detections, duplicate measurements, short and long
  occlusion, mixed modality availability, capacity pressure, and timestamp
  rejection cases.
- Use identical truth and admitted measurements for filter comparisons. Record
  rejected inputs separately; do not silently delete a failed trial.
- Include paired correlation controls: a near-duplicate return with the same
  sensor/modality/timestamp/frame identity must produce the same state,
  covariance, and (for IMM) mode probabilities as its one selected effective
  return, while otherwise identical returns from distinct sensor identities must
  remain independent contributors.
- Preserve every raw trial. Aggregate only after per-trial validation, and
  report the number and reason of all exclusions. No outlier may be removed
  solely because it worsens the result.

An approved model and operational design domain are not present in 0.9.0, so
application-specific pass limits for RMSE, missed tracks, or latency are not
invented here. Such limits must be added in a versioned profile before the first
candidate run and cannot be selected from observed CREBAIN results.

## Preregistered measures

| Measure | Definition and reporting rule |
|---|---|
| Position RMSE | Square root of the mean squared Euclidean truth error in metres, per trial and pooled with median, mean, 5th/95th percentiles, and bootstrap 95% interval. |
| Velocity RMSE | Same rule for Euclidean velocity error in m/s. |
| NEES | `eᵀP⁻¹e` over the six-state error when complete state truth and a positive-definite covariance exist. Report invalid inversions; never replace them with zero. |
| NIS | `yᵀS⁻¹y` for each admitted innovation with its actual measurement dimension. Report empirical central 95% chi-square coverage by modality and filter. |
| Truth coverage | Fraction of truth states inside preregistered 50%, 90%, 95%, and 99% covariance regions, with binomial intervals. |
| Identity switches | Count whenever an estimated identity changes its matched truth identity after both existed in consecutive scored frames. |
| Fragmentation | Number of interruptions in an otherwise matched truth trajectory, excluding truth absence outside the scenario window. |
| False tracks | Estimated tracks unmatched to truth under the fixed scoring gate, reported per minute and per trial. |
| Missed tracks | Truth objects without a matched estimate under the same gate, reported per frame and per truth trajectory. |
| Track latency | Time from the first admissible truth-linked measurement to Tentative and Confirmed output, including never-confirmed censoring. |
| Processing latency | Wall and CPU time per fusion cycle after warm-up; report p50, p95, p99, maximum, and over-deadline count. |
| Resource maxima | Peak resident memory, live tracks, admitted/rejected measurements, assignment component size, queue depth, and dropped/truncated counts. |

The truth-to-track scoring gate, assignment algorithm, and maximum match distance
must be fixed in the truth fixture before results. Report cardinality and
localization error separately (GOSPA or an equivalently versioned definition);
do not let a favorable localization average hide false or missed tracks.

## Decisions and multiplicity

Primary comparisons are declared before execution and reported with effect size
and uncertainty, not only a p-value. When more than one filter, scenario, or
metric is used to support one superiority claim, control the family-wise error
with Holm correction. Negative, inconclusive, capacity-failed, and numerically
invalid results remain in the archive. Exploratory analyses must be labeled
post hoc and cannot satisfy a preregistered acceptance limit.

## Evidence required for a result

A result package must contain the exact source/config/truth identities; raw
measurements, truth, tracks, and timing/resource records; deterministic replay
command; environment and hardware description; trial/exclusion ledger;
calculation code and tests; aggregate tables/plots; checksums; and a review by a
person independent of the implementation. Until that package exists, CREBAIN
makes no numeric fusion-quality or deployment-timing claim.
