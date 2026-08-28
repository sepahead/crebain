# CREBAIN managed simulation

This package exposes deterministic CREBAIN simulation through Engram Host API 2.0.
It supports one, two, or three declared drone channels.

The runtime has simulator authority only.
It has no Neuro-Cybernetic Protocol (NCP), network, Tauri, artifact, or physical-plant capability.
It coordinates one CREBAIN simulator process.
It does not implement shared-clock multi-simulator coupling or replace MUSIC.

## Runtime boundary

The `crebain-managed-simulation` binary uses inherited private pipes.
Each frame contains a big-endian `uint32` length and one strict JSON object.

The adapter implements `engram.managed-runtime-stdio.v1`.
The envelope schema is `engram.managed-runtime-ipc.v1`.
Deterministic synchronization writes exact provenance to `contracts/PROVENANCE.json`.
Release provenance uses `crebain.contract-provenance.v2`.
It binds each copy to one non-null Git blob from clean Engram `origin/main`.

Engram owns these controls:

- process launch and termination
- handshake and readiness authority
- one-shot compute grants
- deadlines and cancellation
- generation limits and restart policy

CREBAIN owns these controls:

- bounded simulator state
- one independent Kalman fusion lane for each declared drone
- deterministic tick ordering
- simulator-only actuator output
- local request, state, receipt, and transcript digests

## Operations

| Operation | Purpose | CPU grant | Request / response limit |
| --- | --- | ---: | ---: |
| `crebain.simulation.prepare.v1` | Validate the roster and create fusion lanes. | 5,000 ms | 16,384 / 32,768 bytes |
| `crebain.simulation.step.v1` | Advance all drones by one exact tick. | 500 ms | 16,384 / 32,768 bytes |
| `crebain.simulation.finish.v1` | Emit a terminal receipt and clear state. | 100 ms | 4,096 / 8,192 bytes |
| `crebain.simulation.prepare.v3` | Prepare the standard channel, clock, and vector semantics. | 5,000 ms | 16,384 / 32,768 bytes |
| `crebain.simulation.step.v3` | Apply one standard acceleration vector at the next logical time. | 500 ms | 16,384 / 32,768 bytes |
| `crebain.simulation.finish.v3` | Finish the exact standard step and time plan. | 100 ms | 4,096 / 8,192 bytes |

All operations use a 5,000 ms timeout.
The manifest permits one in-flight operation.
It permits no runtime restart.

The request and response schemas are in `contracts/`.
The manifest binds each schema to its exact SHA-256 digest.

The original `crebain.simulation.*.v1` operations remain compatible.
The second surface implements the six exact `engram.closed-loop-simulator.*.v3` schemas.
The manifest binds those schemas to project-owned `crebain.simulation.*.v3` operations.
Engram discovers each role from its exact schema pair without project-specific host code.

The copied standard v1 and v2 schemas are audit-only migration records.
The package and runnable manifest exclude those older schemas.

One process generation can activate only one operation surface.
Cross-surface preparation fails closed.

The legacy `max_ticks` field is a hard execution ceiling.
Legacy callers can finish at the current admitted tick.
The standard `step_count` field is an exact plan and permits no early completion.

## Standard simulator profile

The sealed configuration owns every standard-surface default.

| Setting | Exact value |
| --- | --- |
| Channel count | One to three sorted, unique channel identifiers |
| Internal roster | Channel order maps to `drone-01` through `drone-03` |
| Subject kind | `simulated.drone` |
| Tick | 20 ms, exactly 20,000 `microsecond` tics |
| Causality | `sample-runtime-run-controller-apply-zoh-v1` |
| Initial position | `[index * 500, 0, 100]` m |
| Initial velocity | `[0, 0, 0]` m/s |
| Sensor variance | `[1, 1, 1]` m² |
| Observation space | `kinematics.position-velocity-enu-si`, width 6 |
| Observation components | `position.east`, `position.north`, `position.up`, then matching velocity components |
| Observation units | Three `si.metre` values, then three `si.metre-per-second` values |
| Action space | `kinematics.acceleration-enu-si`, width 3 |
| Action components | `acceleration.east`, `acceleration.north`, `acceleration.up` |
| Action units | Three `si.metre-per-second-squared` values |
| Safe hold | Zero acceleration on the selected channel |
| Recoverable fault schedule | Step 3, sorted channel ordinal 1, `sensor-unavailable` |

Channel and subject identifiers remain opaque host identities.
They never become CREBAIN drone identifiers.

Prepare requires exact parallel rosters, spaces, components, units, widths, bounds, and safe values.
Flattening uses channel-roster order, then declared component order for each channel.
Step requires the next index, exact roster, and exact source and target times.
Finish requires the exact declared `step_count` and final simulation time.

The standard response returns fused ENU position and fused velocity in channel order.
Both values come from each fusion lane's `TrackOutput`.
The response never substitutes simulator ground truth for fused velocity.
Each `observation_present` value identifies whether its fixed-width slice is usable.

The sealed configuration owns a bounded, sorted recoverable-fault schedule.
Each entry selects a logical step and one-based sorted channel ordinal.
The installed profile selects `sensor-unavailable` on ordinal one at step three.
That response marks the selected observation absent.
Its finite fixed-width values remain non-authoritative while absent.
An ordinal outside a shorter prepared roster has no effect.

The host owns target references, neural gains, damping, and control-axis mappings.
The runtime embeds none of those controller choices.

The host owns snapshot and request lineage identities.
CREBAIN checks lowercase SHA-256 shape, binds the values to its local run, and echoes them exactly.
These local observations are receipts, not signatures or external attestations.

CREBAIN independently derives each `step_id` from the study run and step index.
The derivation uses domain `engram-extension-closed-loop-step-v2`.
This derivation matches Engram's project-neutral canonical function.

## Tick order

`prepare` applies this order:

1. Validate the finite schema and stable identifier roster.
2. Require one to three sorted and unique drone identifiers.
3. Create one isolated fusion lane for each drone.
4. Admit one initial sensor observation for each lane.
5. Emit the initial state and receipt digest chain.

`step` applies this order:

1. Validate the run, next tick, exact roster, shapes, and finite bounds.
2. Apply an overload fault before state mutation.
3. Apply actuator availability and the acceleration intent.
4. Bound velocity and integrate position with the trapezoidal rule.
5. Apply the sensor offset and sensor availability.
6. Advance every fusion lane at the exact simulation timestamp.
7. Build the state, receipt, and transcript digests.
8. Commit the new state after all checks succeed.

`finish` validates the current run and tick.
It emits the terminal receipt before it clears fusion and drone state.

## Fault controls

| Fault code | Sensor input | Actuator output | Result |
| --- | --- | --- | --- |
| `none` | admitted | requested and bounded | continue |
| `sensor-dropout` | omitted | requested and bounded | continue |
| `actuator-hold` | admitted | zero | continue |
| `combined` | omitted | zero | continue |
| `overload` | omitted | zero | terminal failure before mutation |

Fault controls are deterministic simulator inputs.
They do not represent hardware faults or physical commands.

The standard surface exposes only `bounded-neural-proposal` and `safe-hold` actions.
`safe-hold` must equal the prepared zero vector with every saturation flag false.
It is an action disposition and does not manufacture or latch an actuator fault.
Standard v3 has no request-side simulator fault-injection field.
Only the sealed configuration can produce its recoverable standard fault.
Standard response fault codes use a closed vocabulary and a 128-byte UTF-8 ceiling.
The project-specific surface retains the deterministic dropout and overload controls.

## Behavioral controls

The Rust gate runs 160-tick trajectories for two and three drones.
Each drone reduces its distance to a test-owned reference outside the runtime.

A paired three-drone control observes the scheduled lane-A fault at step three.
The host-side control then selects one safe hold and one bounded zero washout.
Lanes B and C retain bitwise-identical requested, admitted, and applied actions.
Their fused observations also remain bitwise identical at every tick.
Lane A then resumes a bounded nonzero action, and the complete held trace replays exactly.

This evidence covers deterministic CREBAIN fault reachability and simulator isolation.
It does not claim identical stochastic output from Engram or NEST.

The release tree does not retain INDEX v1 or capture v1 evidence.
A current operational publication uses capture v2 and INDEX v2 only.
Each INDEX capture row has exactly 16 members.
The release verifier rejects every INDEX v1 root.
Its provider-free self-test includes an exact INDEX v1 negative control.
The default bootstrap boundary does not open tracked capture files.
A release capture uses the tracked `operational-inputs/real-nest-3.9-v1/` suite.
The suite contains exact plans for one, two, and three drones.
It also contains one shared NEST 3.9 configuration.

After capture v2 publication, verify the two-revision evidence:

```bash
bun run check:managed-simulation-operational-v2 -- \
  --expected-crebain-source-revision <C0> \
  --expected-crebain-publication-revision <C1>
```

This command requires tracked capture v2 files and an INDEX v2 root.
It rejoins them to the tracked operational input context.
Revision C0 is the clean source and bootstrap commit.
Revision C1 must be the sole direct child of C0.
The C0-to-C1 diff must add only the four evidence JSON files.
Each added Git entry must be a regular `100644` blob.
The verifier reads the raw C1 commit parent header.
It does not use revision-walk parent overrides.
The verifier repeats all Git, directory, blob, and worktree checks after semantic validation.

Each run creates exactly one reviewed runtime session and one NEST controller.
The suite gives Engram an absent receipt-store path.
Engram publishes the complete store and writer lock atomically.
The population topology contains exactly six signed populations for each drone.
The suite requires 6N populations, 48N neurons, 12N devices, and 96N connections.
Each run records nonzero NEST proposals before the fault and after recovery.
Each capture binds both washouts, population resets, guardians, stores, and terminal cleanup.

Create the complete replacement suite with this command:

```bash
/path/to/engram-python scripts/run-managed-simulation-real-nest-suite.py \
  --engram-root /absolute/path/to/reviewed/engram \
  --engram-commit <immutable-origin-main-object-id> \
  --store /path/to/fresh/installed/package/store \
  --installed-proof /path/to/crebain-standard-v3-installed-proof.json \
  --receipt-lock-timeout-ms 30000 \
  --output-directory \
    integrations/engram/managed-simulation/operational-evidence/real-nest-3.9-v2
```

Fetch and review Engram before this command.
The command does not fetch or choose a commit.
It requires clean Engram `HEAD` and local `origin/main` at the supplied object ID.
Run the suite from clean CREBAIN revision C0.
CREBAIN `HEAD` and local `origin/main` must both equal C0.
The installed proof must bind the same C0 repository identity.

The suite runner verifies all tracked inputs before execution.
It creates a separate private receipt store for each run.
It sends frozen plan and configuration copies to Engram.
It removes each transient receipt-store directory after closure validation.
It publishes exactly `INDEX.json` and three capture JSON files.
It checks every input and tool again before publication.
It repeats the source and byte checks after the directory rename.

Each capture contains its complete plan, configuration, receipts, and neural results.
It records every loaded host-side Engram Python module.
It rejoins the NEST worker's runtime module roster to committed checkout bytes.
This join also supports Engram's frozen worker-source generations.
It binds the NEST guardian through the worker launch and session receipts.
It binds the reviewed-runtime guardian through handshake and termination receipts.
It catalogs every bounded receipt-store file and its exact hash.
Every source path must resolve to one tracked Git blob with identical raw bytes.

The suite index binds all captures to one installed package and Engram commit.
It requires distinct receipt, evidence, and receipt-store identities.
Each capture embeds its terminal receipt and evidence document.
Each capture also records the complete bounded store file roster and digests.
The four-file publication does not retain the transient receipt-store directories.

Commit the four evidence files as revision C1 after the suite succeeds.
Do not include another path in C1.
Push C1 to `origin/main` before operational verification.

The command fails on source drift, dirty Git state, untracked source, or lineage drift.
It also fails if nonzero recovery, lane isolation, washout, or reset checks fail.
The receipt-lock timeout accepts 1 through 300,000 milliseconds.

## Digests and receipts

Every request uses canonical, sorted-key JSON before hashing.
Each digest uses a separate domain string.

The state digest joins the run digest, prior state digest, and complete frame.
The receipt digest joins the request, result, state, and frame.
The transcript digest joins every accepted or rejected operation receipt.

Runtime generation identifiers do not change simulation digests.
The generic Host API envelope separately binds the installation and generation.

## Build and verify

Run these commands from the CREBAIN repository:

```bash
bun run check:managed-simulation-inputs
bun run check:managed-simulation-boundary
bun run check:managed-simulation-contract
bun run fmt:managed-simulation:check
bun run check:managed-simulation-rust
bun run test:managed-simulation
bun run clippy:managed-simulation
bun run doc:managed-simulation
```

These bootstrap commands do not require historical or operational captures.
The boundary self-test uses only provider-free synthetic capture v2 data.

The contract gate also builds a provider-free synthetic installation.
It runs the exact built binary with one, two, and three channels.
It tests active-session `SIGTERM` and a fresh generation after cancellation.
It rejects linked installation paths and receipt replacement.
The synthetic seal tests the checker only.
It is not an Engram installation or an operational receipt.

Synchronize Engram contract copies before the release boundary gate:

```bash
/path/to/engram-python scripts/sync-managed-simulation-engram-contracts.py \
  --engram-root /absolute/path/to/clean/engram \
  --engram-commit <immutable-origin-main-object-id> \
  --write
/path/to/engram-python scripts/sync-managed-simulation-engram-contracts.py \
  --engram-root /absolute/path/to/clean/engram \
  --engram-commit <immutable-origin-main-object-id> \
  --check
```

The sync command requires clean Engram `HEAD` and local `origin/main`.
It verifies each working-tree file against its committed Git blob.
It replaces copied contracts before it replaces the provenance document.

Create the bootstrap code-and-documentation commit before the observed build.
Push that exact commit to `main`.

Build the target-native executable from that clean immutable commit:

```bash
python3 scripts/build-managed-simulation-bootstrap.py \
  --commit <exact-crebain-origin-main-object-id>
python3 scripts/stage-managed-simulation-package.py
```

The build command requires clean `HEAD` and local `origin/main` at the supplied commit.
It rejects nonignored untracked files and build override environment variables.
It binds each managed source to its exact Git blob and raw bytes.
The source roster includes all fourteen contract schemas embedded by the release binary.
Fresh Cargo dep-info must match the exact compile-input subset of that roster.
It records the Cargo manifests, lock, toolchain, arguments, profile, and target.
It parses the complete load-command envelope, executable `__TEXT`, and `LC_MAIN` entry.
It records the observed thin Mach-O arm64 executable bytes and source mode.
The receipt makes no reproducibility, signature, dependency-byte, or environment claim.

The staging command fails if `package/` already exists.
It never replaces an existing package.
It requires owner-executable, structurally valid Mach-O arm64 source bytes.
It never promotes text or another executable format with `chmod`.
It preserves every source-file mode.
It creates the staged package with owner-private modes.
It emits `package-stage-receipt.json` only after the complete inventory passes.

The evidence schemas are in `evidence-schemas/`.
They close build, stage, pack, installed-proof v3, capture v2, and INDEX v2 roots.
The static boundary also enforces sorted and unique nested rosters.
INDEX v2 binds a four-file suite, capture, receipt-validation, and atomic-I/O source roster.

Run Engram's `seal` command against the exact authoring recipe:

```bash
/path/to/engram-python /absolute/path/to/engram/scripts/engram_extension.py \
  seal integrations/engram/managed-simulation/authoring.macos-aarch64-darwin.json
```

Engram creates the reviewed package lock and seal receipt.

Use the CREBAIN wrapper to run Engram's unchanged `pack` command:

```bash
/path/to/engram-python scripts/pack-managed-simulation-package.py \
  --engram-root /absolute/path/to/engram \
  --engram-commit <immutable-origin-main-object-id> \
  --build-receipt integrations/engram/managed-simulation/build/observed-build-receipt.json \
  --stage-receipt integrations/engram/managed-simulation/package-stage-receipt.json \
  --output /private/tmp/crebain-managed-simulation-package
```

The wrapper requires clean Engram `HEAD` and local `origin/main` at the supplied commit.
It binds `scripts/engram_extension.py` to that commit's exact Git blob.
It runs Engram's unchanged `pack` and `check` commands with isolated Python startup.
It joins the stage inventory to Engram's package lock and seal receipt.
It atomically publishes one owner-private envelope after every recheck passes.
The envelope contains `bundle/` and `engram-pack-receipt.json`.

Install the exact checked bundle into a fresh store:

```bash
/path/to/engram-python /absolute/path/to/engram/scripts/engram_extension.py \
  --store /private/tmp/crebain-extension-store \
  install /private/tmp/crebain-managed-simulation-package/bundle
```

Then run the installed-binary gate against that exact generation:

```bash
python3 scripts/check-installed-managed-simulation-v3.py \
  --generation-root /path/to/store/generations/xx/pkggen_<digest> \
  --seal-receipt \
    integrations/engram/managed-simulation/sealed/macos-aarch64-darwin/seal-receipt.json \
  --build-receipt \
    integrations/engram/managed-simulation/build/observed-build-receipt.json \
  --stage-receipt \
    integrations/engram/managed-simulation/package-stage-receipt.json \
  --pack-receipt \
    /private/tmp/crebain-managed-simulation-package/engram-pack-receipt.json \
  --write-receipt /private/tmp/crebain-standard-v3-installed-proof.json
```

The gate reopens the store observation, bundle receipt, seal receipt, and complete package inventory.
It recomputes the package generation ID from the exact generation core.
The generation core excludes the display name and static-admission flag, as Engram specifies.
The gate validates both excluded fields independently.
It joins the bundle, seal, installation, package lock, configuration, and schema rosters.
It reopens the sealed executable and configuration by digest.
It exercises one, two, and three drones through canonical private-pipe frames.
It proves the configured fault, safe hold, washout, resume, replay, and lane isolation.
It also sends a wrong-clock negative request before state creation.
The emitted v3 receipt binds the installed store and complete package lineage.
It also embeds the exact Engram pack receipt and source identity.
It embeds the exact observed-build and package-stage receipts.
It parses the installed executable as thin Mach-O arm64 before execution.
It is local operational evidence, not NEST evidence or a signature.

The wrapper copies the sealed candidate into an owner-private temporary workspace.
It never changes repository file modes.
It removes the workspace after success, rejection, timeout, or interruption.
The package-envelope path must not exist before packing.

The manifest template contains zero package digests.
Those values are authoring placeholders and grant no launch authority.

## Interoperability fixture

`sample-transcript.json` contains one decoded three-drone standard v3 session.
It records each canonical payload length, prefix, digest, and envelope.
The session contains one simulation step.
It is wire interoperability evidence, not long-loop behavior evidence.

The fixture identity uses repeated digit digests.
It is not an installation identity.

Regenerate and compare the fixture with this command:

```bash
python3 scripts/generate-managed-simulation-transcript.py \
  --binary src-tauri/target/release/crebain-managed-simulation \
  --verify integrations/engram/managed-simulation/sample-transcript.json
```

## Finite-float differential

`contracts/engram.managed-runtime-finite-float.v1.json` is a generic IEEE-754 corpus.
It covers zero signs, subnormals, notation thresholds, round-trip tails, and finite bounds.
It also binds a 4,096-value deterministic SplitMix64 transcript.
The corpus is a test artifact, not a runtime schema or package payload.

The Rust test requires the fixed cases and complete randomized transcript.
The Python verifier loads Engram's host and child renderers by exact source digest.
The provenance sidecar binds the copied corpus and both Python implementations.

Run the cross-repository gate against the reviewed Engram checkout:

```bash
python3 scripts/verify-managed-simulation-float-differential.py \
  --engram-root /path/to/engram
```

The verifier executes only the two digest-bound function definitions.
It does not import Engram or require Engram's Python dependencies.

## NCP separation

This runtime does not import or implement NCP.
It does not translate NCP wire 0.8 or wire 1.0.
It makes no native NCP 1.0 qualification claim.

The existing wire-0.8 integration remains separate and unchanged.
No managed-simulation operation can publish an NCP message or control a plant.
