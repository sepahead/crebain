# Typed force-city sources

This separate application uses one actual force-city world and one NCP endpoint.
It admits 1–256 ordered entities and zero through twelve exclusive world-fixed source requests.
The required native qualification target is 256 entities.
Installed qualification, GPU qualification, and the frozen 256-entity campaign have not run.

The Rust owner supplies closed NCP types and application admission.
A private Bun process owns the actual `ForceCityEnvironment` and optional graphics process.
The independent Python client installs as the optional `crebain_ncp_sensors.city` module.
It starts no simulator during import.

## Ownership and measurement meaning

Every control batch contains one ordered set or hold row for every prepared entity.
The explicitly selected trusted host owns that complete control roster.
Observation recipients, recorders, and buffers acquire no motor authority.
This profile does not authorize an external controller from a caller-written identity string.

Each request has its own declared native source and one recipient entity.
Cameras and microphones remain world-fixed and observe the shared scene.
Recipient identity does not make a measurement body-local or isolate one emitter.
Unsupported mounted, radar, inertial, and range observations reject before effects.
Unrequested modalities have no synthetic payload or required empty modality list.

## Retention and failure

Prepare admits complete geometry, controller references, sensor configuration, and capacity before the first transition.
Advance admits all entity rows and retains actual original sensor bytes.
Export seals one already produced original into one reserved NCP buffer.
The caller reads and releases each buffer, then releases the complete batch.
Another advance requires every promised export and release.
Acknowledgment releases the retained result, independently of buffer and batch release.

A known source failure can retain earlier complete originals for export.
A committed failure requires known CPU completion, complete valid metadata, and confirmed native process retirement.
An unknown effect, changed metadata, transfer failure, or unresolved cleanup retires indeterminately.
No failed generation can advance or finish successfully.

The complete native mechanical record stays privileged and outside ordinary sensor data.
World and transition digests describe locally observed bytes; they are not scientific signatures.
Installed file inventories do not attest loaded code or opaque runtime memory.

![Typed source production, original-byte transfer, and explicit buffer release](../../assets/diagrams/ncp-sensor-transfer.svg)

Text alternative: The native owner produces an original sensor payload, and Rust retains its bytes.
NCP seals and transfers those bytes with their typed manifest.
The city application repeats this flow for each produced source, then requires release of the complete batch.
This shared transfer diagram does not imply scalar control or mandatory modalities for the city profile.

[Open the original SVG](../../assets/diagrams/ncp-sensor-transfer.svg?raw=true)

## Admission and resource bounds

The installed schema owns all counts, units, closed variants, and field lengths.
Relational admission joins the complete roster, accepted geometry, source recipients, models, and resource digest before native construction.
Each set row consumes one action-history slot; a hold consumes none.
The total initial and later set rows must fit 4,096 slots before an advance.
Each tick advances one shared world at 120 Hz, with a maximum horizon of 7,200 ticks.

Let `N` denote admitted entities and `S` denote requested sources.
Let `B` denote their maximum aggregate original bytes per batch.
RGB and thermal originals use four bytes per pixel; pressure uses at most 134 binary64 samples per source.
The aggregate ceiling is `B = 27,857,088` bytes at four maximum-size sources per modality.
Native retention and Rust application retention each reserve `B` independently.
Native metadata reserves `16,384 + 256N + 4,096S` bytes.
The privileged complete transition reserves `4,096 + 32,768N` bytes; it is not a public NCP buffer.
Acoustic history reserves `8N(ceil(range / sound_speed * 16,000) + 2)` bytes.
At the schema's admitted extrema, that history bound is 13,985,792 bytes.
The resource commitment separately includes actual graphics scratch, target, and source-retention bounds from the native owner.
These logical capacities do not bound opaque Rapier, JavaScript, browser, driver, or allocator memory.

An application result reserves at most `4,096 + 96N + 1,024S` bytes within its 49,152-byte capacity.
The header allowance includes the sole possible failed-source diagnostic and conservative JSON escaping.
No response repeats the entire world for each entity.
Both public and private frames must independently fit 65,536 bytes before effects.
Long identifiers and larger geometry can exhaust encoded capacity before a count ceiling.
The construction controls serialize 256 entities, sixteen cuboids, and twelve sources, including complete state and action replies.
That selected case does not imply every combination of admitted field maxima fits one Prepare frame.

Each private advance uses one absolute deadline across execution, all original chunks, and native lease release.
Framing drains available bytes and accepts a final short fragment without waiting for EOF.
Truncation, duplicate keys, changed sequence, noncanonical tokens, or capacity overflow cannot become a successful empty observation.

## Construct, install, and call

Select the exact NCP source recorded in `contracts/dependency-source.v1.json`.
Run the complete city source gate from a clean, explicitly prepared dependency environment:

```sh
CREBAIN_SENSOR_NCP_SOURCE=/operator/selected/NCP bun run validate:with-ncp-city
```

The gate checks generated records, the shared Python package, public Rust transactions, actual CPU source processes, and synthetic graphics boundaries.
It includes the existing scalar/family construction and complete repository gates.
It neither downloads dependencies nor executes a native GPU campaign.
The [hosted workflow](../../.github/workflows/ncp-sensors.yml) runs separate city and sensor construction jobs on Linux.
Prepare locked Cargo dependencies through the existing [sensor construction procedure](../ncp-force-ground-sensors/README.md#construction-and-qualification).

After publishing the gated source, install into fresh operator-selected locations:

```sh
python -m pip install ./integrations/ncp-force-ground-sensors/python
python3 integrations/ncp-force-city-sources/install_runtime.py \
  --ncp-source /operator/selected/NCP \
  --output /operator/runtimes/crebain-city \
  --bun /absolute/path/to/bun
```

For selected cameras, add the explicit Node executable and Playwright browser root described by the [shared installer](../ncp-force-ground-sensors/python/README.md).
CPU-only and pressure-only selections require neither Node nor a browser.
The city selector preserves the scalar and checkpoint-family selectors and their independent contracts.

```python
from crebain_ncp_sensors.city import InstalledCityRuntime, city_session

runtime = InstalledCityRuntime.open("/operator/runtimes/crebain-city")
with city_session(runtime, prepare, timeout_s=600) as city:
    for rows in whole_roster_schedule:
        with city.advance(rows) as pending:
            consume(pending.observation)
    result = city.finish()

assert city.retirement.process_exit["cleanup_confirmed"]
```

The caller supplies a validated `Prepare`, complete ordered row batches, and a bounded observation consumer.
Use `CityContract.decode_prepare` for closed typed configuration decoding.
Host-retained observations require host-owned memory limits after their application batch is released.
The caller may select a trusted `exchange` hook for original-frame capture; the peer cannot select code or runtime paths.

Context exit requires the full prepared horizon and no outstanding batch.
`failure_retirement(error)` retrieves available retirement facts, including failures before the context yields.
The receipt preserves the last validated COMMITTED response before ACK and separates observed execution from acknowledged progress.
Unknown ACK delivery retires the channel; it never grants retry or a synthetic successful Finish.
An unreturned process constructor supplies no process-exit evidence.
Bounded advisory failure summaries preserve native primary, secondary, and cleanup causes separately.
They reuse the existing eight-node, eight-edge formatter with a 4,096-byte output limit and one-second delivery deadline.
Truncated or unavailable diagnostics cannot upgrade execution or cleanup authority.
The shared guardian's independent cleanup grace and process-observation limits still apply.
Session deadlines do not bound installation verification or interrupt an arbitrary trusted callback.

## Qualification scope

Construction controls exercise actual Rapier dynamics through Rust, Bun, and typed Python NCP calls.
Pressure controls use actual native microphones; graphics controls use declared synthetic source implementations.
They establish neither installed-source identity nor native GPU delivery, tracking, memory performance, or physical sensor calibration.
The required operational target remains 256 entities with unchanged force-controller gains.
Literal source failures must preserve earlier actual originals without relabeling shared-renderer loss as a known acquisition failure.
Privileged fault injection requires separately frozen test fixtures; no peer-accessible fault option exists.

## Implementation decision

| Approach | Benefit | Failure mode and decisive control |
| --- | --- | --- |
| Widen the scalar profile | Small public surface | Breaks force-ground and family meaning; reject with unchanged-profile controls |
| One endpoint per entity | Reuses scalar owners | Exceeds fixed endpoint limits and loses shared physics; reject |
| Implement a new simulator | Convenient interface | Cannot establish actual Rapier behavior; reject |
| Duplicate client and installer packages | Independent release surface | Duplicates identity checks and creates another dependency; reject |
| New city contract with existing-wheel client | Separates semantics and reuses installation checks | Requires distinct selectors and old-path parity; select |

The selected contract retains the exact NCP `c0465d40f1f2b9df2caf9793183d11e65ac9ec74` construction dependency.
All 41 consumed files match the reviewed `58fe8aea81498d2c89c76c0602385cc7a6f08397` source.
The older scalar and family installation selectors remain separate.
This source comparison supplies no installed qualification.

Scientific review preserves actual source meaning and the existing force-controller gains.
Protocol review separates effects, acknowledgments, retained originals, and explicit releases.
Security review checks selected source bytes, closed input shapes, and process ownership.
Statistical review treats shared channels and entities as dependent simulator observations.
Maintenance review keeps the new profile separate and reuses generic installation mechanisms.
