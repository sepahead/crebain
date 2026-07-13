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
| `CREBAIN_GALADRIEL_REGISTRY_PATH` | Path to the bounded deployment-registry JSON |
| `CREBAIN_GALADRIEL_REGISTRY_DIGEST` | Lowercase SHA-256 of the registry's canonical JSON form |
| `CREBAIN_GALADRIEL_FRAME_ID` | Positive JSON-safe frame identifier present in the registry |
| `CREBAIN_GALADRIEL_CONTEXT_ID` | Positive JSON-safe projection-context identifier bound to that frame |
| `CREBAIN_GALADRIEL_SOFTWARE_DIGEST` | Lowercase SHA-256 expected for the running executable file and selected registry context |
| `CREBAIN_GALADRIEL_CONFIGURATION_DIGEST` | Lowercase SHA-256 expected for the effective fusion configuration and selected registry context |
| `NCP_ZENOH_CONFIG` | Readable NCP Zenoh configuration used by secure mode |

`CREBAIN_GALADRIEL_FUSION_CONFIG_PATH` is optional. When present, it names a
nonempty JSON file of at most 64 KiB. `FusionConfig` rejects unknown and duplicate
fields, validates numeric and cardinality bounds, materializes serde defaults,
and is then serialized as compact struct-ordered JSON for SHA-256. When the path
is absent, `FusionConfig::default()` is the effective input. If
`CREBAIN_PID_JSONL` is present, CREBAIN enables `emit_innovations` before
validating and hashing, so changing the JSONL setting changes the configuration
pin. No later `fusion_init` or `fusion_set_config` call may install a configuration
with a different canonical digest while the producer is active.

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
expected modalities, opportunity policy, and queue ceilings. Content references
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
ledger. It can write only these named-perception keys for its fresh process
epoch:

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
- loss, reorder, duplicate, restart, partition, queue-saturation, clock, and
  shutdown campaigns with receiver-side artifacts; and
- scientific calibration/accuracy evidence if any claim goes beyond advisory raw
  consistency telemetry.

None of this producer wiring establishes Engram control, PID actuation, Haldir
authorization, plant authority, FCU acceptance, or observed vehicle effect.
CREBAIN remains L0, and the action/control APIs in `src-tauri/src/ncp/mod.rs`
remain dormant and unregistered.
