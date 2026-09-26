# Installed city evidence, September 23, 2026

The installed city application completed the selected 256-entity sensor cases through typed NCP.
Seven ordinary operations completed.
Three deliberately faulted operations remained failures and passed their separate failure assertions.
The tracking campaign passed every available numerical and mechanical check.
The original report left continuous contact unverified.
A [September 26 certificate](#derived-integration-law-separation-september-26-2026) separately proves integration-law hull separation for the frozen trajectories.
General tracking qualification stays open.

Both campaigns used published CREBAIN [`3fe34a1c`](https://github.com/sepahead/crebain/tree/3fe34a1c9dd5b4cd575f6f1c3950e8ba8e51521c).
Each case used one shared Rapier world, unchanged force-controller gains, and the frozen sixteen-cuboid scene.
The [machine-readable record](native-city-2026-09-23.json) binds the selected installation, frozen plans, original terminal results, and independent reviews.
This documentation does not advance the installed source to a later repository commit.

## Original sensor delivery

Each selected request declares a distinct world-fixed source and one recipient entity.
These shared-scene observations are neither mounted measurements nor isolated observations of one emitter.
The roster uses one default physical drone model with different positions and controller references.
It does not establish heterogeneous physical models.

| Case | Entities | Sources | Last acknowledged tick | Originals | Original bytes | Capture |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| CPU only | 256 | 0 | 3 | 0 | 0 | Unselected |
| Pressure pair | 1 | 2 | 6 | 9 | 9,600 | Complete |
| Mixed, recorded | 2 | 3 | 6 | 11 | 125,184 | Complete |
| Mixed, unrecorded | 2 | 3 | 6 | 11 | 125,184 | Unselected |
| Four sources | 3 | 4 | 12 | 25 | 683,136 | Complete |
| Maximum dimensions | 256 | 12 | 1 | 12 | 27,857,056 | Complete |
| Sparse periods | 256 | 12 | 12 | 75 | 1,050,688 | Complete |
| Acquisition fault | 3 | 4 | 2 | 4 | 114,688 | Aborted |
| Integrity fault | 3 | 4 | 1 | 3 | 77,824 | Aborted |
| Browser loss | 3 | 4 | 1 | 3 | 77,824 | Aborted |

The audit reopened all 153 originals, totaling 30,121,184 bytes, and their original typed manifests.
It rejoined source, recipient, scene, configuration, tick, buffer, chunk, release, and terminal identities.
The recorded and unrecorded mixed cases had identical complete payload bytes.
Unrequested modalities produced no fabricated payloads.

The maximum-dimension case selected four 1280-by-1280 RGB sources, four 320-by-320 thermal sources, and four 16 kHz pressure sources.
Its first pressure windows contained 133 samples each.
Its observed total is 32 bytes below the admitted 27,857,088-byte batch ceiling for 134-sample windows.
This observation does not measure that larger window or every possible combination of field maxima.
A separate [September 26 boundary case](NATIVE_CITY_BOUNDARY_2026-09-26.md) later reached the exact batch ceiling without changing this original result.

## Fault observations

The private acquisition fixture threw after one real RGB readback at tick two.
The application retained that original and returned ordered produced, failed, absent, and not-due slots.
It rejected another advance and successful Finish.
Its receipt confirmed native retirement and process cleanup while preserving the failed operation.

The integrity fixture changed a receipt identity after the second actual readback.
The browser-loss fixture joined the owned browser's birth, parent, user, and executable before sending its selected SIGTERM.
Both retained the validated tick-one prefix and reported the attempted tick two as indeterminate at the public boundary.
Neither supplied a successful terminal acknowledgment or confirmed native retirement.
Both original process receipts retained `cleanup_confirmed=false`.

An independent observer replayed 103 recorded process births and confirmed retirement of those observed identities.
That observation does not upgrade the two false cleanup receipts or prove complete descendant containment.
All three fault commands exited nonzero.
The successful outer campaign means their expected failure assertions were satisfied.
No peer-accessible fault option was added to the application.

## Tracking observations

The frozen plan selected 44 cases, two repetitions, and direct-world and installed-NCP routes.
All 176 commands exited successfully and completed 360 ticks at 120 Hz, or three simulated seconds each.
Tracking selected zero sensor sources.
The separate sensor campaign owns the delivery evidence above.

| Entities per world | Selected cases | Direct/NCP pairs | Commands | Paired entity-case records |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 13 | 26 | 52 | 26 |
| 2 | 14 | 28 | 56 | 56 |
| 3 | 14 | 28 | 56 | 84 |
| 256 | 3 | 6 | 12 | 1,536 |
| Total | 44 | 88 | 176 | 1,702 |

The verifier rejoined 127,072 original public exchange pairs, 31,768 distinct reference states, and 31,680 accepted transitions.
All 88 direct/NCP comparisons passed.
The 44 unique cases also passed exact repeat comparisons after the frozen identity-only projection.
The two routes reuse the same physics implementation.
This comparison supplies no independent physical-model oracle.

Every entity passed its applicable frozen criteria.
Averages across entities did not decide acceptance.
Numerical criteria use the 120 samples at ticks 241 through 360.
Mechanical checks cover every transition, including rotor equations, feedback, allocation, motor bounds, and the existing state envelope.

| Criterion | Applicable records | Frozen bound | Worst observed value |
| --- | ---: | ---: | ---: |
| Full rotation root-mean-square error | 1,702 | At most 0.05 rad | 0.008338 rad |
| Maximum altitude error in the selected window | 1,702 | At most 2 m | 0.786660 m |
| Mean absolute vertical velocity | 1,702 | At most 0.5 m/s | 0.373385 m/s |
| Motor-command endpoint fraction | 1,702 | At most 0.1 | 0 |
| Original signed-axis root-mean-square error | 368 | At most 0.015 rad | 0.002225 rad |
| Original signed mean velocity | 368 | At least 0.02 m/s | 0.406043 m/s |
| Signed altitude contrast against matched hold | 176 | At least 0.1 m | 0.265020 m |

Displayed maxima round upward and minima round downward.
The JSON retains the original numeric ranges.
The original four signed roll/pitch families retain both their angle and velocity criteria.
The hold-attitude check also passed all 612 applicable records.
All target families, geometry, controller bytes, thresholds, and exclusions were selected before execution.

Stored narrow-phase contact observations were clear in all 88 paired records.
They observe stored manifolds at selected states and cannot prove absence of contact between those states.
The original record therefore retains `continuous_contact_absence=null`, `tracking_qualified=false`, and `release_qualified=false`.
The separately derived result below does not rewrite those fields.
Shared-host execution supplies no timing qualification or general stability proof.

## Derived integration-law separation, September 26, 2026

A separate read-only checker proved integration-law hull separation for all 88 original direct/NCP pairs.
It restored retained snapshots without advancing a world.
Original NCP control commitments rejoined the corresponding direct-world state and transition digests.
The [derived machine-readable record](integrator-hull-2026-09-26.json) binds the frozen checker, proof, source inputs, controls, actual exits, and independent terminal review.

| Accounted quantity | Count |
| --- | ---: |
| Original executions joined | 176 |
| Paired trajectories | 88 |
| Paired intervals | 31,680 |
| Restored snapshot admissions | 31,768 |
| Body-intervals | 612,720 |
| Unordered body-pair checks | 70,542,720 |
| Body pairs excluded by exact axis separation | 66,494,946 |
| Body pairs requiring exact squared-distance checks | 4,047,774 |
| Body-solid checks | 9,803,520 |
| Body-ground checks | 612,720 |

The totals count each paired trajectory once across both routes.
Every interval includes all bodies, the ground, and all sixteen original solids.
Both bodies contribute their complete motion envelopes to each body-pair check.
Strict comparisons reject touching.

The selected JavaScript Rapier 0.19.3 package uses Rust Rapier 0.30.1.
The reviewed solver advances translation through four constant-velocity substeps per tick.
Let `h` denote the tick duration, rounded to binary32 from 1/120 seconds.
Each solver substep lasts `h/4` seconds.
The admitted start speed is at most 5 m/s, and each retained user-force component is at most 250 N.
All admitted drone bodies have mass 1.5 kg and the selected gravity, damping, inertia, and inverse-mass values.
The source-derived acceleration envelope is 200 m/s² per axis.
Each intermediate velocity component stays below 7 m/s.

Each start coordinate has magnitude at most 100,000 m.
Four position additions each contribute at most `2^-8` m of rounding per axis.
The full translation bound stays below 0.129 m.
The checker uses a conservative 0.25 m center-motion radius.
The nominal collider half-extents are 0.20, 0.05, and 0.20 m.
Their enclosing radius is `sqrt(0.0825)` m.
A fixed 0.30 m collider radius includes shape, rotation, and coordinate-rounding allowances.
The complete envelope radius is therefore 0.55 m around each interval's initial center.
These bounds were frozen before clearance evaluation.

Restored-state admission checked centered colliders, zero local center of mass, complete rosters, and the exact solver profile.
It rejected joints, kinematic bodies, continuous collision detection, extra solver iterations, and retained contact manifolds.
Snapshot zero starts the first interval.
Snapshot 360 closes the last interval.
The retained narrow-phase data in snapshot `k` belongs to the solver interval from state `k-1` to state `k`.
The proof follows each selected solver translation segment, not an arbitrary path between whole-tick endpoints.

All 88 restore-only children and the outer replay command exited zero.
An independent terminal review verified the selected records, complete roster, and count formulas.
The expected Rapier initialization warning remained in each child stream.
No simulator rerun, input replacement, threshold adjustment, or original-result edit occurred.

This dependency-source interpretation is not reproducible-build or loaded-code attestation.
General tracking, complete 256-entity profile, timing, runtime-memory, and release qualification remain open.
The result supplies no physical-flight safety claim.
Original captures and detailed checker artifacts remain in private operator custody.

## Custody and limits

The source milestone passed its complete city construction gate before publication.
Installation checks joined the exact archive, wheel, installed modules, and city runtime selection.
The scalar and checkpoint-family selectors retained their separate contracts.
Each operational campaign then used its reviewed frozen tools and selected installed bytes.
Terminal verification reopened originals after execution.
It did not rerun the simulators.

The independent sensor review rehashed 280 retained original and receipt files before and after readback.
Their 77,393,776 logical bytes include the freeze and audit receipts.
Case outputs alone occupied 76,959,079 logical bytes within the frozen 534,280,560-byte aggregate capacity.
Tracking retained 95,216 direct exports totaling 5,797,548,796 bytes and 343,397,862 bytes of original captures.
Its observer confirmed retirement of 440 observed process births.
These file extents do not bound opaque engine, browser, driver, allocator, or operating-system memory.

The earlier failed CPU construction attempts and their false cleanup receipts remain retained separately.
The unchanged legacy attitude-controller failures also remain part of the scientific record.
Selected file inventories describe observed local bytes, not response-bound loaded-code attestation or scientific signatures.
Original captures and detailed audit artifacts remain in private operator custody.
This public summary does not include them.

These campaigns do not qualify a neural controller, external monitor, mounted sensor, physical calibration, general stability, or a complete product release.
The [application contract](../README.md) defines the implemented behavior and admission bounds.
The [release criteria](../../../docs/RELEASE_ACCEPTANCE.md) retain the separate deployment and product-release requirements.
