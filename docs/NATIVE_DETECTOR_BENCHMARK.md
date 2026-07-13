# Native Detector Benchmark

CREBAIN provides a release-command, single-fixture, sequential microbenchmark
for the native detector runtime. It produces a content-identified JSON report;
the repository contains no approved model, fixture, baseline, threshold, or
numeric result.

## Run

Use a clean checkout and an approved model/fixture pair:

```bash
bun run benchmark:native-detector -- \
  --backend onnx \
  --model /trusted/models/model.onnx \
  --fixture /trusted/fixtures/frame.png \
  --output /private/evidence/native-detector.json \
  --hardware target-profile-id \
  --source-commit "$(git rev-parse HEAD)"
```

The output path must be a new `.json` file. Backend/model pairs are exact at
the CREBAIN factory boundary: CoreML uses `.mlmodelc`, MLX uses
`.safetensors`, and ONNX/CUDA/TensorRT use `.onnx`. The supported command uses
Cargo's release profile; the artifact records only that debug assertions were
disabled, not an independently attested build profile.

Defaults are 5 warmups, 100 measured iterations, confidence `0.25`, IoU `0.45`,
and 100 maximum detections. Use `--help` for the bounded ranges.

## Measurement scope

- `callLatencyMs` measures one `DetectorRuntime::detect` call.
- `runtimeReportedLatencyMs` is the latency returned by that runtime.
- p50/p90/p95/p99 use nearest-rank quantiles over every raw call sample.
- `sequentialDetectorThroughputFps` is `1000 * iterations` divided by the sum
  of `callLatencyMs`, converting the millisecond samples to frames per second.
- `evidenceLoopWallMs` also includes timers, first-output cloning, detection
  serialization/digests, and sample recording.
- `initializationMs` includes detector construction and its trait warmup.

Fixture decoding, Tauri IPC, `spawn_blocking` queueing, camera transport,
renderer/UI work, concurrency, batching, and sustained thermal behavior are
excluded. This is not an accuracy, end-to-end FPS, SITL, HIL, or field test.

## Identity and controls

The tool hashes the encoded and decoded fixture, the model file or deterministic
CoreML directory tree, and—when configured on Linux—the `ORT_DYLIB_PATH`
library. Model and fixture identities are checked again after every run. The
recorded ONNX Runtime loading mode is also checked again, as is the configured
Linux library digest when that mode applies. Crate-linked and search-loaded
runtime bytes are not hashed or attested. These checks detect stable accidental
mutation; they are not attestation against a hostile writer racing the
filesystem.

MLX layer profiling and the persistent TensorRT engine cache are forced off.
TensorRT initialization is therefore cold only with respect to CREBAIN's
persistent engine cache and remains separate from steady-state call samples;
the harness does not attest OS page cache, driver/JIT/module caches, or GPU
state. On Linux, a run without a configured, hashable `ORT_DYLIB_PATH` may
produce a standalone report, but it cannot be used for baseline gating.

`providerLabel` means that CREBAIN selected the backend or successfully
registered the named ONNX execution provider and created the session. It does
not prove accelerator utilization, exclusive graph placement, or that every
operation ran on that provider. A CoreML label does not prove Neural Engine
placement.

`declaredSourceCommit` and `hardwareLabel` are operator declarations. The tool
validates their shape but does not bind the commit to the executable, detect a
dirty worktree, inventory drivers/clocks/power/thermal state, or establish that
the label describes the machine. Candidate evidence therefore also requires a
clean checkout and an external target-runtime record.

## Compare with a baseline

At baseline approval time, a trusted pipeline can hash the archived report and
publish that value to an evidence store separate from the report:

```bash
shasum -a 256 /private/evidence/native-detector-baseline.json
```

At comparison time, retrieve the approved value independently; do not recompute
it from the baseline file being checked:

```bash
APPROVED_BASELINE_SHA256=<value-from-trusted-evidence-store>

bun run benchmark:native-detector -- \
  --backend onnx \
  --model /trusted/models/model.onnx \
  --fixture /trusted/fixtures/frame.png \
  --output /private/evidence/native-detector-current.json \
  --hardware target-profile-id \
  --source-commit "$(git rev-parse HEAD)" \
  --baseline /private/evidence/native-detector-baseline.json \
  --baseline-sha256 "$APPROVED_BASELINE_SHA256" \
  --max-regression-percent 5
```

All three baseline flags are required together. The trusted digest is checked
before JSON parsing. The comparison also requires matching schema, target
label/platform, enabled package features, forced performance controls, runtime
loading mode and—for configured Linux `ORT_DYLIB_PATH`—library identity,
model/fixture content, policy, run configuration, requested backend, selected
backend, and provider label. It gates p95 only. If the predeclared percentage is
exceeded, the failing report is preserved and the command exits nonzero.

A digest identifies bytes but does not authenticate who approved them; the
digest must come from trusted CI/configuration rather than the file being
checked. A passing local comparison is not a repository-approved threshold or
a performance claim.

## Handling reports

Local paths, working directory, raw environment values, and path arguments are
redacted from the report. It still contains the operator hardware label,
model/fixture digests, ONNX Runtime loading record, the configured Linux runtime
digest when applicable, raw timings, detection counts, and first-frame
detections. Review it before sharing and preserve the private original because
editing or redaction changes its artifact digest.

For a numeric claim, archive the clean source commit, exact command/report and
report digest, trusted baseline digest, pre-approved threshold, model contract,
fixture rights, and external hardware/OS/driver/runtime/load context. The
latency report does not satisfy model provenance, tensor/class mapping,
golden-fixture accuracy, or false-positive acceptance.
