# Typed force-city sources

This separate application uses one actual force-city world and one NCP endpoint.
It admits 1–256 ordered entities and zero through twelve exclusive world-fixed source requests.
Installed cases exercised 256 entities, including twelve selected sources, through typed NCP.
The [dated evidence](evidence/NATIVE_CITY_2026-09-23.md) separates delivery, expected failures, tracking observations, and remaining qualification limits.
The separate [three-tick boundary case](evidence/NATIVE_CITY_BOUNDARY_2026-09-26.md) delivered the exact 27,857,088-byte maximum original batch with complete capture and confirmed owner cleanup.

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

### Trusted composition admission

Twelve [installed resource sessions](evidence/native-city-resource-2026-09-26.md) passed across legacy, budgeted, and recorded routes.
The selected one- and 256-entity groups preserved identical pressure bytes and completed owner cleanup.

Use `budgeted_city_session` when selecting complete body or body-plus-transcript logical allowances.
Its `ResourceBudget` supplies aggregate logical, graphics-color, and selected storage limits in bytes.
All limits require exact nonnegative integers.
The launcher independently derives the complete plan costs before constructing a recorder or process.
It validates the actual public Prepare frame, runtime selection, timeout, and required camera launcher before capture creation.
The process owner rechecks the admission before launch.
Copied totals and the peer resource digest grant no capacity authority.

| Allowance | Included extent |
| --- | --- |
| Source | Originals, receipt, retained control, separate CPU return, acoustic history, pressure block |
| Application and NCP | Separate original arena, bounded result, public payload, actual endpoint-owner overhead |
| Graphics | Readbacks, thermal scratch, single-source retention, logical color targets |
| Canonical encoding | Public projection, native plan, native receipt/control, selected graphics input |
| Host retention | Every due original across the horizon, batch/manifest encodings, current transfer copies |
| Optional capture | Independent frame/projection staging and the transcript owner's exact file capacity |

Pressure intervals use the actual integer 16,000-sample/120-tick partition.
Three ticks therefore include 133, 133, and 134 samples per due microphone.
Canonical encoding allowances describe byte representations, not a canonical experiment.
Canonical experiment storage remains unselected at zero; requesting that mode rejects before effects.

These calculations allocate no physical resources and do not bound opaque process or GPU memory.
Native and application arenas retain their separate actual reservation contracts.
The finite host allowance covers unique originals and encoded metadata, excluding Python object overhead and arbitrary caller copies.
The caller remains responsible for downstream consumers and additional storage.
The historical `city_session` path remains available but lacks this aggregate composition admission.

Selected capture uses the existing optional Prisoma `Journal`, without an arbitrary exchange callback or another recorder.
Its actual capacity API admits the full planned exchange count plus one Abort-and-ACK contingency.
The current transcript limits remain 8,190 exchange pairs and 1 GiB per file.
An excessive capture horizon rejects before file or process creation, even when body-only execution admits that horizon.
A free-disk observation supplies an additional precondition, not a physical reservation.
Later I/O failures retain original errors and available retirement facts.
Failure closes the existing journal without inventing a successful terminal or retrying the producer.
Successful capture completion does not prove scientific validity.

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

For capture coverage, select a Python environment with the actual optional transcript package:

```sh
CREBAIN_SENSOR_NCP_SOURCE=/operator/selected/NCP \
CREBAIN_CITY_TRANSCRIPT_PYTHON=/operator/capture-environment/bin/python \
  bun run validate:with-ncp-city
```

The city gate also accepts `--transcript-python` with that absolute interpreter path.
Missing selected packages fail; no capture test skips an unavailable owner.
The default body-only command does not claim capture coverage.
The hosted city job installs Prisoma transcript source `7a1730e4cc1c7a62fa207e2baa0d6f231454bd3f` with normal dependency resolution.
It retains the installation report, selected module identities, and actual optional-owner control results.
The sensor job retains its independent dependency boundary.

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
from crebain_ncp_sensors.city import (
    InstalledCityRuntime, ResourceBudget, budgeted_city_session,
)

runtime = InstalledCityRuntime.open("/operator/runtimes/crebain-city")
budget = ResourceBudget(
    logical_bytes=host_logical_limit,
    graphics_color_bytes=host_color_limit,
    storage_bytes=host_capture_limit,
)
with budgeted_city_session(runtime, prepare, budget=budget, timeout_s=600) as city:
    for rows in whole_roster_schedule:
        with city.advance(rows) as pending:
            consume(pending.observation)
    result = city.finish()

assert city.retirement.process_exit["cleanup_confirmed"]
```

The caller supplies trusted byte limits, a validated `Prepare`, complete ordered row batches, and a bounded observation consumer.
Use `CityContract.decode_prepare` for closed typed configuration decoding.
Use `composition_resources(prepare, binding)` to inspect the derived body-only allowances before selecting limits.
Add `capture_path` to select the budgeted transcript route; use `capture=True` when calculating its allowances.
The peer cannot select code, runtime paths, or host limits.
The historical launcher retains its trusted `exchange` hook outside the budgeted contract.

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
The [installed campaign](evidence/NATIVE_CITY_2026-09-23.md) retained those gains and exercised selected 256-entity sensor and tracking cases.
The original tracking report left continuous contact unverified.
A separate [read-only certificate](evidence/NATIVE_CITY_2026-09-23.md#derived-integration-law-separation-september-26-2026) proves integration-law hull separation for those frozen trajectories.
General tracking qualification stays open.
Literal source failures must preserve earlier actual originals without relabeling shared-renderer loss as a known acquisition failure.
Privileged fault injection requires separately frozen test fixtures; no peer-accessible fault option exists.

## What the trajectory checker establishes

The checker certifies body separation under the selected solver's four-substep integration law.
It does not replace Rapier's collision detector, change the controller, or execute a new physics simulation.
NCP byte transfer does not require this checker.
It addresses a separate gap in CREBAIN's trajectory evidence.

The original tracking runs found no contact at sampled states.
Those observations alone could not establish separation throughout each interval.
Sampling has a related limitation in robotics: Drake's [edge collision checker](https://drake.mit.edu/doxygen_cxx/classdrake_1_1planning_1_1_collision_checker.html) explicitly describes approximate checks along sampled paths.
That reference explains the general problem, not qualification of this checker.

The checker encloses each body's motion and shape in a conservative region.
It checks separation from every other admitted body, each scene solid, and the ground.
The bound includes solver substeps and numerical rounding.
Strict comparisons reject touching.
Disjoint regions certify separation under the checked assumptions.
Overlapping regions mean that this method cannot certify separation.
They do not prove an actual collision.

The current [certificate](evidence/NATIVE_CITY_2026-09-23.md#derived-integration-law-separation-september-26-2026) covers 88 frozen direct/NCP trajectory pairs and their original execution joins.
Its 0.55 m envelope follows the selected drone shape, dynamics, force limits, and rounding bounds.
That radius is not a general robot clearance setting.

### Reuse and current limits

The geometry and interval reasoning do not depend on an expected experiment outcome.
The current tooling still binds a specific solver profile, snapshot format, and evidence roster.
It remains an offline audit tool in private evidence custody, not an installed public verification API.
The public record supplies the result, assumptions, and artifact identities.

A different body, solver, timestep, force range, or coordinate range requires new bounds and admission controls.
Articulated robots also require link geometry, joint motion, and self-collision rules.
A proposed trajectory and a recorded execution are different claims.
Checking one does not qualify the other.

### NCP, Zenoh, and robotics

NCP supplies typed control, observation, identity, and lifecycle records for the selected execution.
The checker joins those records to simulator states before applying its geometric argument.
A received message or digest alone does not prove correct physics or physical execution.

Zenoh provides [publish/subscribe and query abstractions](https://zenoh.io/docs/manual/abstractions/).
A future adapter could transport suitable evidence, but this checker has no implemented or tested Zenoh adapter.
Such an adapter would need explicit schema, units, ordering, timing, identity, missing-data, and provenance checks.
Transport compatibility does not supply those application meanings automatically.

The following uses are design applications of the verification pattern, not qualified CREBAIN robotics features.

| Potential use | Useful result | Additional requirement |
| --- | --- | --- |
| Simulation regression | Identify trajectories that no longer satisfy the certificate's assumptions or separation checks | Versioned models, frozen inputs, complete traces, and paired failure controls |
| Planner or learned-policy evaluation | Check geometric constraints separately from task reward | Bounds for the proposed or executed motion, plus distinct task-quality tests |
| Mobile robots or robot arms | Check body, link, obstacle, and self-separation over motion intervals | Robot-specific geometry, dynamics, joint limits, and numerical bounds |
| Recorded failure analysis | Locate an unsupported assumption or interval without a certificate | Complete command/state ancestry and explicit unavailable evidence |

Walking, grasping, and assembly can require intended contact.
They need separate rules for permitted contacts, forces, friction, and task constraints.
A contact-free certificate cannot evaluate those tasks by itself.

Physical deployment additionally needs validated state estimation, model-error bounds, latency, actuator behavior, and environment uncertainty.
The current checker supplies no hardware safety guarantee, online intervention, learned policy, or real-time deadline qualification.

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
