# Galadriel Evidence Producer

CREBAIN contains an optional native producer for Galadriel-compatible fusion
evidence. It is an advisory evidence path, not a controller, plant, actuator, or
proof that a Galadriel process received or accepted anything.

## Two independent opt-ins

The producer exists only in a binary compiled with the off-by-default Cargo
feature `ncp`. In such a binary, runtime publication is still disabled unless
`CREBAIN_GALADRIEL_ENABLE` is exactly `1`:

| Build/runtime state | Result |
|---|---|
| Binary without `ncp`; switch absent or `0` | Producer is not compiled and no producer session is opened |
| Binary without `ncp`; switch `1` | Application startup fails closed |
| Binary without `ncp`; switch other than `0` or `1` | Application startup fails closed |
| Binary with `ncp`; switch absent or `0` | Producer is compiled but no registry/config files are read and no producer session is opened |
| Binary with `ncp`; switch other than `0` or `1` | Application startup fails closed |
| Binary with `ncp`; switch `1` | All deployment pins must validate before the secure-mode NCP Zenoh session is opened |

The standard release workflow currently builds the default feature set and does
not include `ncp`. A deployment must record whether its exact executable was
built with the feature; setting an environment variable cannot add it later.

## Enabled deployment configuration

Every enabled deployment requires:

| Variable | Meaning |
|---|---|
| `CREBAIN_GALADRIEL_REALM` | NCP realm used to construct both evidence keys |
| `CREBAIN_GALADRIEL_PRODUCER_ID` | Declared, key-safe producer identity carried in envelopes |
| `CREBAIN_GALADRIEL_EPOCH` | Operator-provisioned `1..=64` byte key-safe UTF-8 session segment used in both evidence keys |
| `CREBAIN_GALADRIEL_REGISTRY_PATH` | Path to the bounded deployment-registry JSON |
| `CREBAIN_GALADRIEL_REGISTRY_DIGEST` | Lowercase SHA-256 of the registry's canonical JSON form |
| `CREBAIN_GALADRIEL_FRAME_ID` | Positive JSON-safe frame identifier present in the registry |
| `CREBAIN_GALADRIEL_CONTEXT_ID` | Positive JSON-safe projection-context identifier bound to that frame |
| `CREBAIN_GALADRIEL_SOFTWARE_DIGEST` | Lowercase SHA-256 expected for the running executable file and selected registry context |
| `CREBAIN_GALADRIEL_CONFIGURATION_DIGEST` | Lowercase SHA-256 expected for the effective fusion configuration and selected registry context |
| `NCP_ZENOH_CONFIG` | Readable NCP Zenoh configuration used by secure mode |

CREBAIN does not mint or persist the epoch. Deployment orchestration must
provision a new unique `CREBAIN_GALADRIEL_EPOCH` for every process lifetime and
prevent reuse across restarts. Startup proves only that the supplied value is a
single key-safe segment; it does not prove freshness, durable uniqueness, or
anti-rollback.

`CREBAIN_GALADRIEL_FUSION_CONFIG_PATH` is optional. When present, it names a
nonempty JSON file of at most 64 KiB. `FusionConfig` rejects unknown and duplicate
fields, validates numeric and cardinality bounds, materializes serde defaults,
and is then serialized as compact struct-ordered JSON for SHA-256. When the path
is absent, `FusionConfig::default()` is the effective input. If
`CREBAIN_PID_JSONL` is present, CREBAIN enables `emit_innovations` before
validating and hashing, so changing the JSONL setting changes the configuration
pin. While the producer is active, `fusion_init` is an idempotent readiness check:
it deliberately ignores renderer-supplied defaults because startup already
loaded the immutable pinned engine. `fusion_set_config` accepts only the same
canonical digest and does not replace that engine.

For this source baseline, the literal default configuration with no JSONL
override has canonical digest
`7f297598c2419b659fad9f74edcf580feecb4530b8d01ecd82d005e206966076`.
That value is component-test pinned. It is not the effective digest when
`CREBAIN_PID_JSONL` is present or any configuration field differs; provision the
digest of the actual fully materialized effective configuration in those cases.
When the live producer is active, JSONL copies enter a separate capacity-16
frame archive channel through nonblocking drop-new admission. Queue-full,
disconnected, or initialization failure marks the producer degraded before its
frame summary is admitted. An `ncp`-feature startup preflights a configured sink
before opening the producer session. The writer validates and serializes a whole
batch before its first write; write or flush failure permanently degrades the
epoch and terminates the archive worker. This archive path is not one of the four
NCP lanes, and a later OS write failure can still leave a partial already-
validated batch.

An enabled startup requires both three-way equalities:

```text
actual canonical fusion config
  = CREBAIN_GALADRIEL_CONFIGURATION_DIGEST
  = registry context producer_configuration_digest

actual running executable file SHA-256
  = CREBAIN_GALADRIEL_SOFTWARE_DIGEST
  = registry context producer_software_digest
```

All checks occur before the NCP session opens. Provision the executable digest
from the final post-signing/post-packaging executable, not an intermediate build.
The executable pin covers that one file only; it does not cover dynamic
libraries, models, resources, firmware, the operating system, or every byte
already mapped into a process. The digest equalities prove consistency, not
provenance or signature validity. The environment/registry digest becomes a
trust anchor only when the deployment protects it independently.

The registry itself is limited to 1 MiB, rejects unknown fields, is normalized
and hashed canonically, and fixes the selected frame/context, applicability,
expected modalities, opportunity policy, and queue ceilings. Repeated immutable
content identifiers must retain one digest globally, and repeated projection
algorithm identifier/version pairs must retain one digest. Content references
inside it are declarations: CREBAIN does not fetch or hash referenced
calibration, transform, or projection-algorithm artifacts. The executable and
effective fusion configuration are the only referenced deployment artifacts
verified against actual local bytes by this startup path.

Optional runtime bounds are:

| Variable | Default/source | Constraint |
|---|---|---|
| `CREBAIN_GALADRIEL_HEARTBEAT_INTERVAL_MS` | `1000` | `1..=300000` ms |
| `CREBAIN_GALADRIEL_HEARTBEAT_DEADLINE_MS` | `3000` | interval through `300000` ms |
| `CREBAIN_GALADRIEL_OBSERVATION_QUEUE_CAPACITY` | Registry policy | Positive and no greater than the registry/wire cap |
| `CREBAIN_GALADRIEL_OUTCOME_QUEUE_CAPACITY` | Registry policy | Positive and no greater than the registry/wire cap |
| `CREBAIN_GALADRIEL_SUMMARY_QUEUE_CAPACITY` | Registry policy | Positive and no greater than the registry/wire cap |
| `CREBAIN_GALADRIEL_HEARTBEAT_QUEUE_CAPACITY` | Registry policy | Positive and no greater than the registry/wire cap |

The four lane capacities must also fit the aggregate monitor-event cap of 8,192.

## Evidence and projection behavior

The registered `fusion_process` command remains the fusion entry point. In an
enabled deployment it additionally constructs and admits one immutable frame
ledger. It can write only these named-perception keys for its explicitly
configured process epoch:

```text
{realm}/session/{epoch}/sensor/galadriel-pid
{realm}/session/{epoch}/sensor/galadriel-monitor
```

The first carries frozen Galadriel sidecar envelopes. The second carries ordered
modality outcomes, aggregate misses, frame summaries, and periodic producer
heartbeats. The envelope codecs, bounds, and golden bytes mirror the pinned NCP
and Galadriel component contracts. This is a narrow raw NCP `put` path; it does
not restore a generic renderer, ROS, service, setpoint, action, or FCU publisher.

CREBAIN does not execute registry transform chains. A common consistency
projection is present only when the measurement's `source_frame_id` already
equals the selected registry frame's canonical ENU identity and that modality's
transform chain is empty. Otherwise the observation/outcome remains explicitly
incomparable. A matching frame-name string is provenance supplied through the
fusion input; it is not cryptographic sensor authentication or evidence that a
calibration was applied.

Time eligibility is equally strict. Every measurement in a nonempty native frame
must exactly equal the frame timestamp, which must advance the fusion prior.
Future, lagged, mixed-time, replayed/nonadvancing, and out-of-order inputs reject the whole
frame before prediction or evidence mutation; there is no time-inexact baseline
update. A frozen-v1 observation or common projection additionally requires that
timestamp to be strictly newer for the same track/modality channel. Timestamp zero
explicitly initializes the fusion clock; it is not confused with an uninitialized
clock. Per-channel high-water state is removed when its track leaves the live set.

Inside an assigned co-located cluster, one `(sensor_id, modality, timestamp_ms,
source_frame_id)` correlation identity can correct the track only once. The
deterministic lowest-Cartesian-noise representative is effective; independent
sensor identities remain separate observations. This applies before optional
Galadriel selection, so repeated processing of one sensor capture cannot
artificially tighten the native posterior or IMM mode probabilities.

Renderer ingestion stays in the sensor/header clock domain. One visual detector
pass stamps all of its tracks once. Each fusion frame uses the maximum of the
previous successfully admitted clock and its newest input stamp; an empty frame
reuses that high-water. Before any data, an empty frame uses neutral zero, which
the active native path clamps to the selected frame/context applicability floor.
The renderer commits its high-water only after native success, so a rejected
future input cannot poison later valid sensor time. Wall time is not substituted
for empty or mixed-stamp frames.

Native validation also bounds the computational domain before filter work:

| Input | Bound |
|---|---|
| Frame batch | At most 512 measurements before the stricter registry limit |
| Cartesian position / radar range | Magnitude at most 10,000,000 m (radar range is non-negative) |
| Cartesian velocity component | Magnitude at most 100,000 m/s |
| Covariance diagonal | Finite and within `(0, 1e12]` |
| Metadata | At most 64 entries; each finite value has magnitude at most `1e12` |
| IDs, labels, source frames, metadata keys | At most 256 bytes plus their existing nonempty/control-character rules |

If internal gate math is not finite/valid despite those boundaries, the monitor
ledger emits `unsupported_filter` without fabricated numeric gate evidence or a
v1 observation.

`FusionConfig::default()` has `emit_innovations=false`. That flag controls the
legacy automatic innovation buffer/local JSONL path; it does not suppress the
explicit live `process_frame` evidence API. An enabled producer using the literal
default can therefore construct compatible frozen-v1 sidecar observations as
well as monitor evidence. Setting `CREBAIN_PID_JSONL` still forces the legacy flag
before config hashing because it requests a local archive copy. Live and local
paths both retain the Kalman-family limitation: Particle and IMM currently have
no compatible v1 innovation record.

## Queue, liveness, and shutdown semantics

Observations, outcomes/misses, summaries, and heartbeats use independent bounded
lanes. A full lane drops the newest item, increments saturating loss counters,
and permanently latches the producer epoch degraded; affected frame summaries
are marked degraded/truncated when they can be admitted. Ordered monitor sequence
numbers are reserved before lane admission, so a dropped event leaves an
observable sequence gap rather than being silently renumbered.

Loss before those four lanes is explicit but has different accounting. The
renderer counts malformed detections and buffer trimming; native admission adds
any trimming required by the registry's `max_frame_inputs`. Both retain the
newest bounded inputs. A nonzero upstream count permanently degrades the epoch
and marks the admitted frame summary degraded/truncated. At the active-track cap,
fusion deterministically discards whole overflow birth clusters before mutation,
builds one final bounded association plan, and likewise closes a
degraded/truncated frame instead of wedging the epoch. The current wire summary
does not carry the numeric upstream/cluster-drop count; deployments must retain
producer logs as well as receiver evidence.

The assignment solver decomposes sparse finite components and short-circuits a
maximum-size all-infinite matrix. Component tests bound the 512-input/1,024-track
case, but this is not deployed combined-load or deadline evidence.

Each Zenoh `put` is bounded by five seconds. A failed or timed-out put is counted
as a drop and permanently degrades the epoch. Heartbeats have a separate
admission lane, but all monitor events are sent in global sequence order by one
worker. Consequently a backlog of older outcomes or repeated five-second puts
can delay a heartbeat beyond its declared deadline. Component tests prove lane
and accounting behavior, not deployed heartbeat timeliness.

Application exit requests producer shutdown and gives each owned task up to five
seconds before aborting it. Dropping the runtime also aborts owned tasks. This is
a finite cleanup guarantee, not proof that queued evidence or a final heartbeat
reached a receiver.

If `CREBAIN_PID_JSONL` is enabled, exit separately closes the archive sender and
waits up to two seconds for its standard writer thread. A thread blocked opening,
writing, or flushing a FIFO/device/socket/slow mount cannot be forcibly aborted
and may outlive that wait. Use only an operator-approved regular local file. In
the no-producer path JSONL append remains synchronous inside the blocking fusion
job, after the fusion lock is released, so storage latency can delay
`fusion_process`. Neither path inherits the five-second NCP `put` timeout.

`get_system_info` reports compiled/enabled state, the selected identities and
digests, epoch, queue depths, counters, and the sticky degraded bit. A successful
local `put` increments protocol-named `published` counters; it does not mean a
Galadriel receiver delivered, decoded, accepted, correlated, or acted on the
event.

## Deployment claim boundary

Repository component evidence supports only the behavior described above. A
deployed integration claim additionally needs, for the exact executable,
configuration, registry, and topology:

- an audited `NCP_ZENOH_CONFIG`, identities, certificates, TLS/mTLS behavior,
  router configuration, and positive and negative ACL tests restricted to the two
  keys;
- a documented binding between the authenticated transport principal and the
  envelope's declared `producer_id` (the JSON field alone is not that binding);
- a live Galadriel tap/monitor/cross-route assembler that pins the same registry,
  observes sequence gaps, enforces heartbeat deadlines, and reports decode and
  identity mismatches;
- verified router and receiver payload-size limits at least as large as every
  permitted sidecar/monitor envelope, with oversize negative tests;
- loss, reorder, duplicate, restart, partition, queue-saturation, clock, and
  shutdown campaigns with receiver-side artifacts; and
- scientific calibration/accuracy evidence if any claim goes beyond advisory raw
  consistency telemetry.

None of this producer wiring establishes Engram control, PID actuation, Haldir
authorization, plant authority, FCU acceptance, or observed vehicle effect.
CREBAIN remains L0, and the action/control APIs in `src-tauri/src/ncp/mod.rs`
remain dormant and unregistered.
