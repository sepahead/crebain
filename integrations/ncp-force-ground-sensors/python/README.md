# Independent sensor reader

This Python component reads the closed CREBAIN sensor application through the generic NCP SDK.
It does not launch the producer, install dependencies, or run a simulator.
The package construction tooling owns dependency checks and process cleanup.

Source imports use the installed `ncp_local` package.
Fixed contract files resolve relative to this integration directory.
The reader verifies their application, composition, semantic, and schema commitments before use.
No peer request accepts a filesystem path, executable, URL, or installation option.

## Calling contract

Call `run_session(reader, writer, binding, prepare, actions, recorder, deadline=deadline)` with trusted, already-open binary streams.
Both `run_session` and `SensorSession` accept an optional `exchange` function for host-selected capture.
The deadline is an absolute `time.monotonic()` value.
The host owns both streams, the engine, cancellation, and confirmed cleanup.
Frame operations use the unchanged SDK deadline checks.
Local validation work has declared size bounds; the callback requires separate host time and storage bounds.

`prepare` is the immutable `Prepare` type.
Use `decode("Prepare", plain_json)` to construct it from bounded configuration data.
The driver applies the remaining composition and relational checks before its first write.
Source rosters require unique IDs in ascending order, matching CREBAIN's existing scene owner.
The acoustic reference distance cannot exceed the declared maximum range.
Decoding alone grants no source, capture, or simulation authority.

`actions` is a bounded ordered sequence of `(tick, SetTarget)` pairs.
Tick one requires an explicit target.
Each target persists through a `hold` command until the next scheduled target.
The hold binds the accepted set-target request digest.
This digest differs from the preceding protocol result and preceding sensor batch digests.

The driver performs these operations in order:

1. Validate the complete schedule before the first protocol write.
2. Prepare the producer and verify its plan and catalog joins.
3. Request one completed body tick.
4. Verify the entire declared sensor roster before reading its buffers.
5. Acknowledge the retained result.
6. Read and validate every due payload.
7. Release every payload buffer explicitly.
8. Deliver one immutable `BatchObservation` to the local callback.
9. Finish only after every planned tick and explicit release completes.

Acknowledgement releases the retained protocol result, while sensor buffers remain live.
The callback receives original immutable bytes and validated metadata after the complete batch passes.
It receives no partial batch, privileged controller record, checkpoint, or reference label.
Callback retention is outside the driver's memory bound.
A callback failure cannot restore released buffers or authorize a durable capture claim.

The driver performs no retry or reconnection.
A channel failure stops the session and leaves engine cleanup to the host.
`SessionError` retains validated and callback-completed prefixes separately.
Its `advance_result_observed` field records an accepted advance response, not independent physics verification.
An unknown attempted tick remains separate from the last validated tick.
An accepted terminal response can confirm reported retirement even when its subsequent acknowledgement is lost.
That case still raises `SessionError` and returns no successful `SessionResult`.

## Adaptive steps and capture ordering

Use `SensorSession` when each action depends on the previous observation.
The host supplies the policy, streams, binding, prepared configuration, and absolute deadline.
This example uses a host-defined `choose_target` function:

```python
from crebain_ncp_sensors import SensorSession

with SensorSession(reader, writer, binding, prepare, deadline=deadline) as session:
    next_target = initial_target
    for _ in range(prepare.planned_ticks):
        with session.advance(next_target) as batch:
            next_target = choose_target(batch.observation)
        del batch
    result = session.finish()
```

Context entry prepares the producer.
`advance` returns only after every due payload passes the existing complete-batch checks.
The first advance requires a `SetTarget`.
Later calls can omit the target to hold the last accepted target.
The host can call other optional NCP peers between body steps.
This interface installs no policy, neural model, capture owner, or additional simulator.

Two [native runs](../README.md#observation-driven-steps) exercised this interface with actual RGB, thermal, and pressure outputs.
One retained the existing schedule; the other selected each next pitch target from the previous pressure window.
Both completed the planned 24 ticks. Separate capture and native lifetime-fault qualification remain open.

A `PendingBatch` exposes immutable observation data, original request bytes, and the verified typed response.
Its normal context exit releases the source buffers.
An explicit `release()` has the same effect and becomes a local no-op after success.
The session rejects another advance or finish while a batch remains live.
A copied Python handle cannot release the original batch.

If capture is required, reserve its capacity before dependent neural or body mutation.
Commit the complete batch durably before normal batch-context exit.
The host must verify that capture result through the capture owner's contract.
The body request still declares `capture_reservation.kind=absent` because the body does not verify a capture reservation.
Neither context exit nor a policy return proves durable capture.

An exception inside a batch context retires the client without releasing its source buffers.
The host must close its streams and confirm engine cleanup.
Session-context exit also retires only the client.
Call `finish()` explicitly after the complete planned prefix to obtain a terminal result.
Early finish and invalid local targets fail before a new write and allow correction.
Transport uncertainty retires the client and preserves the existing failure-prefix rules.

Manual calls do not advance `SessionError.last_recorded_tick` because this interface observes no recorder completion.
Use the capture owner's own receipt for captured progress.
The scheduled `run_session` helper preserves its original release-before-callback behavior and callback-completed prefix.

### Capture original NCP exchanges

The optional `exchange` function receives original request bytes, both streams, and the absolute deadline.
It returns one original response frame.
The SDK validates that response before the session accepts it.
The function also handles acknowledgements, buffer reads, releases, preparation, and finish.
Without a function, the session uses its existing SDK transport.
CREBAIN installs no capture package and requires no additional peer.

The following example selects the [Prisoma transcript package](https://github.com/sepahead/prisoma/tree/main/integrations/ncp-transcript).
It assumes the documented 24-tick M1 configuration, its target schedule, and host-owned streams.
The parent directory must already exist and remain trusted by the host.
The journal path must be new.

```python
from functools import partial

from crebain_ncp_sensors import SensorContract, run_session
from prisoma_ncp_transcript import Journal, Peer, verify

peers = (Peer(binding, SensorContract),)
with Journal(
    journal_path,
    peers,
    max_exchanges=512,
    quota_bytes=72 * 1024**2,
) as journal:
    result = run_session(
        reader,
        writer,
        binding,
        prepare,
        actions,
        recorder,
        deadline=deadline,
        exchange=partial(journal.exchange, binding.endpoint_id),
    )
    capture = journal.finish()

assert verify(journal_path, peers) == capture
```

The journal admits its logical limits before preparation or simulation actions.
Its quota is a byte ceiling, not reserved physical disk space.
For this M1 roster, 238 operations and their acknowledgements require 476 exchanges.
The 512-exchange example leaves bounded spare capacity within its 72 MiB quota.
Other workloads require their own exchange and storage bounds.

Prisoma synchronizes each request before dispatch and each response before returning it.
Thus, every sensor read reaches capture before its source buffer is released.
The scheduled recorder still receives each complete observation after release.
Its completion is independent of transcript completion.
The body still declares `capture_reservation.kind=absent`; it grants the host no capture authority.

A capture failure retires the session without retry or further release.
An executed action whose response never reaches the client remains unobserved.
The host owns stream closure and confirmed process retirement.
The exchange function is trusted caller code; arbitrary callback work and filesystem synchronization have no hard deadline guarantee.
Transcript verification checks stored exchanges, not physical fidelity or scientific validity.
Native CREBAIN capture qualification remains open.

## Bytes, clocks, and identity

| Modality | Exact tensor representation | Additional validation |
| --- | --- | --- |
| RGB | `u8[height,width,4]`, C order, bottom-left origin, `rgba8-srgb` | Exact catalog dimensions and byte count. |
| Thermal | `f32le[height,width]`, C order, bottom-left origin, `W/(m2 sr)` | Every value is finite and within `[0,10000]`. |
| Pressure | `f64le[samples]`, C order, `pascal` | Every value is finite, including finite values above `1e300`. |

Floating-point samples remain raw bytes throughout transport and recording.
Negative zero and subnormal values are preserved.
For example, float32 negative zero is `00 00 00 80` in little-endian byte order.
The reader rejects NaN and infinities after validating payload hashes.
Thermal negative subnormal values fail the nonnegative radiance bound.
Finite negative pressure remains admissible.

For completed body tick `k`, body time is `k/120` seconds.
Pressure sample indices occupy the half-open interval:

```text
start = floor((k - 1) × 16000 / 120)
end   = floor(k × 16000 / 120)
shape = [end - start]
```

Each sample index uses the 16,000 Hz pressure clock.
The first three blocks contain 133, 133, and 134 samples.
`source_body_tick` and `available_after_body_tick` both equal `k`.
Camera period `p` is due when `k mod p = 0`.
A non-due camera names its next due tick within the plan, or null beyond the horizon.
Every admitted scene requires pressure microphones, so every accepted tick has a nonempty payload roster.
Generic manifests require positive byte lengths and chunk counts.

The catalog fixes sensor IDs, source IDs, calibration, ordering, modality, and semantic digests.
Each typed manifest joins the generic byte manifest and existing engine batch SHA-256.
Each generic manifest joins its binding, generation, creating request, causal predecessor, size, and payload SHA-256.
Chunk checks also verify index, offset, final length, and complete payload hashing.

The reader compares source identity, engine owner, and scene SHA across the prepared generation.
These are declared local identities, not signatures or independent loaded-code attestations.
The scene and engine batch SHA values retain their engine-owned serialization meaning.
Python does not reconstruct engine JSON or substitute NCP canonicalization for those hashes.
Rehashing fabricated sensor data cannot prove that a renderer or physical model produced it.
Actual source-output comparison belongs to the separate installed campaign.

## Bounds and evidence

The schema admits 1–7200 planned ticks and up to four sensors per modality.
Logical raw batch storage is bounded by 27,857,088 bytes across twelve payloads.
A single payload copy adds at most 6,553,600 bytes during conversion to immutable bytes.
Chunk scratch, SDK overhead, bounded application metadata, and host retention are separate allocations.
The incremental session additionally retains two original request frames, each bounded by 65,536 bytes, and their schema-bounded typed response metadata.
Callers must bound policy work and retained batches independently.
These logical limits are not process RSS or renderer memory measurements.

The selected 24-tick roster carries 4,326,400 raw bytes across 44 payloads.
Its largest due batch contains 385,072 raw bytes and fourteen chunks.
Synthetic controls check those transfer counts using the real generic SDK.
They run no CREBAIN dynamics, graphics, provider, or sensor implementation.
They grant no installed interoperability, physical fidelity, capture, Prisoma experiment, or release completion claim.

The tests use only the standard library and the selected SDK.
Run them through the integration's checked dependency environment:

```sh
python -m unittest discover -s integrations/ncp-force-ground-sensors/python/tests -v
```

The integration's `python` directory and the checked SDK must be importable in that environment.
The client source contains no private dependency paths or fallback SDK selection.

## Design review

The selected design combines explicit immutable types, a bounded closed-schema decoder, independent semantic checks, and the existing SDK state machine.

| Considered approach | Benefit and failure mode | Decision and decisive control |
| --- | --- | --- |
| Untyped dictionaries | Short implementation; permits ambiguous mutation and field omission. | Reject. Recursive unknown-field controls must fail. |
| Generated Rust bindings | Exact structural reuse; shares decoder defects and adds build coupling. | Reject. Python must independently reject semantic drift. |
| New schema library | Mature general validation; expands the dependency closure. | Defer. The committed subset uses no external dependency. |
| Handwritten scalar checks only | Explicit local behavior; duplicates many schema bounds. | Reject alone. The decoder reads the committed schema. |
| Frozen types plus schema and semantic checks | Preserves independent interpretation and immutability. | Select. Dense bytes, clock, identity, and range controls must pass. |
| Frame acknowledgement as payload release | Fewer operations; invalidates retained sensor ownership. | Reject. Reading after acknowledgement must still succeed. |
| Streaming callbacks per chunk | Smaller temporary storage; exposes incomplete observations. | Reject for this slice. Corrupted later modalities expose no partial batch. |
| Complete batch validation with explicit release | Bounded complete observations; callback failure cannot recover released buffers. | Select. Validate and recorded prefixes must remain distinct. |

| Review lens | Enforced boundary or unresolved qualification |
| --- | --- |
| Type safety | Closed schema, exact integer types, frozen dataclasses, immutable tuples. |
| Numerical meaning | Declared little-endian bytes, signed zero, finite range, explicit units. |
| Causal time | Integer body ticks, pressure intervals, camera periods, no tick-zero capture. |
| Identity | Separate source, plan, sensor, manifest, request, generation, and batch joins. |
| Ownership | One batch, explicit releases, acknowledgement retains payloads. |
| Failure semantics | Complete prefix retained; unknown execution never becomes a completed tick. |
| Resource bounds | Products and metadata checked before reads; caller retention remains separate. |
| Independence | Python semantic decoder and SDK controls remain separate from the Rust producer. |
| Portability | Standard library, fixed relative resources, checked external SDK, trusted streams. |
| Scientific scope | Synthetic transfer controls do not qualify actual sensors or ecosystem experiments. |
