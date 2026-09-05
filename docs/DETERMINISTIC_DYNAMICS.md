# Deterministic drone dynamics

`DeterministicDroneWorld` owns an explicit-clock use of CREBAIN's existing Rapier dynamics.
It reuses `DronePhysicsWorld`, the quadcopter force model, and `FlightController`.
The desktop retains its existing wall-clock scheduler and defaults.
This component has no network, NCP, sensor, fusion, or external vehicle authority.

![Deterministic dynamics ownership and exact replay forks](../assets/diagrams/deterministic-dynamics.svg)

Text alternative: One owner admits a frozen plan and scheduled actions.
It advances the existing dynamics by integer ticks.
A checkpoint retains complete reference state and action history.
A fresh owner reconstructs that history before a full-state comparison permits an independent fork.
Presentation reads cannot advance the simulation.

## Admitted scope

The exact profile is `crebain.rapier-dynamics.v1`.
Its closed plan admits only `dynamics` and `attitude_controller` capabilities.
It uses existing ground and drone cuboids, with the default quadcopter and controller parameters.
Unknown fields, alternative geometry, sensors, fusion, and unsupported capabilities fail before preparation.
Admission copies plain data descriptors once, freezes that owned value, then validates it.
Accessors, symbol keys, hidden record fields, sparse arrays, array extras, cycles, and non-data values reject without evaluating getters.
Validation, retained action history, and pending execution use the same accepted action value.
The copy bounds depth to eight, nodes to 8,192, record fields to sixteen, and strings to 256 characters.
Each admitted array has at most 256 entries.
These checks do not isolate proxy traps or arbitrary code in the same JavaScript realm.
Descriptor enumeration allocates its property map before the later key-count checks.
The copy limits bound traversal and output, not memory allocation for arbitrary caller objects.
Future process ingress needs its own bounded primitive JSON contract.

Both source-policy checkers permit only the copier's exact reviewed descriptor-call node.
The import-free helper is byte-bound, and changed guards or added reflection fail the policy gate.
This explicit policy extension leaves global capability recovery and all other descriptor references forbidden.

This checkpoint is complete for the admitted dynamics domain.
It is not a checkpoint of the full desktop scene or a future multimodal environment.
City collision, camera capture, acoustic and thermal models, and fusion attachment need separate state contracts.
No physical accuracy, cross-platform numerical parity, or real-time throughput follows from this component gate.

## Public interface

The implementation is `src/physics/DeterministicDroneWorld.ts`.

| Method | Contract |
| --- | --- |
| `prepare(plan)` | Validate and copy the exact plan, initialize actual Rapier, and construct the sorted drone roster. Reject fallback physics. |
| `schedule(action)` | Copy one supported future action. Reject unknown drones, duplicates, stale ticks, non-finite values, and exhausted budgets. |
| `advance(ticks)` | Apply due actions, update controllers, and execute the existing fixed dynamics step. Return detached simulator truth. |
| `observe()` | Return detached current truth and rational simulation time. It cannot change simulation state. |
| `checkpoint()` | Retain canonical reference state and return an immutable, owner-issued handle with its SHA-256. |
| `checkpointState(handle)` | Return the retained canonical reference-state string. This is privileged reference data, not sensor input. |
| `restore(handle)` | Reconstruct the exact prefix in a fresh owner. Compare all state before replacing the current world. |
| `fork(handle)` | Perform the same verified reconstruction in an independent speculative owner. Preserve the canonical owner. |
| `releaseCheckpoint(handle)` | Revoke that handle and release its retained capacity. |
| `retire()` | Release physics resources, commands, controllers, and retained checkpoints. Later operations reject. |

A handle is an in-process capability.
Copied, forged, foreign, modified, released, and retired handles cannot authorize restoration.
The serializable reference string supplies no restore authority.
A branch's checkpoint cannot replace its parent's canonical world.
No arbitrary serialized bytes enter Rapier deserialization on this interface.

The caller's `sourceIdentity` is a declared digest, not loaded-code attestation.
The checkpoint also binds the exact plan, geometry name, parameters, controller configuration, and actual Rapier version.
Installed source and artifact qualification remain separate gates.
A future process adapter must separate observation access from privileged checkpoint and reference-label access.
In-process TypeScript ownership is not an operating-system sandbox.

## Time and action meaning

Let `k` be the nonnegative integer physics tick.
Simulation time is `t = k / 120` seconds.
Each advance uses `Δt = 1 / 120` seconds, without wall-clock clipping or display-frame accumulation.
For example, three ticks span exactly 25 milliseconds at the interface.
The internal integrator uses the existing floating-point representation of `1 / 120`.

An action for tick `k` applies before that tick's controller and physics update.
An attitude action contains roll and pitch in radians, yaw rate in radians per second, and altitude in meters.
The controller retains its existing angle clamp, integral clamp, motor mixer, and saturation behavior.
A motor action contains four normalized commands in `[0, 1]`, in named rotor order.
Selecting direct motors clears inactive controller memory.
Disarming retains the existing rotor and battery semantics.
The record distinguishes the selected control, actual motor target, rotor response, and resulting motion.

Coordinates use the existing Three.js world: positive Y is up.
Local positive Z is forward and positive X is right.
These coordinates are not silently relabeled ENU.
An external adapter must declare and test its frame conversion.

The existing motor response updates rotor speed toward its target on each tick.
Thrust follows `T = k_t ω²`, with angular speed `ω` in radians per second.
`k_t` is the configured thrust coefficient, and `T` is thrust in newtons.
The existing Rapier path applies rotor thrust and torque, gravity, and its configured damping.
This extraction does not add a new aerodynamic model or change the fallback's distinct force model.

### Observed controller and angular-model limits

A frozen campaign used seven actual-Rapier configurations, two repeats each, and 360 ticks per repeat.
Each repeat covered three simulated seconds.
Exact repeats and direct-world comparisons passed, but the default attitude controller failed the frozen tracking bounds.
With ±0.03-radian targets, 82.5–92.5% of motor commands reached zero or one during ticks 241–360.
Maximum altitude loss was approximately 10.9–12.2 meters in those cases.
These observations do not qualify stable tracking or delivery of commanded acceleration.
The public city example retains attitude commands and tests one second of observations and export, without tracking-quality credit.

A separate pinned-runtime free-rotation probe used eight configurations, two repeats, and twelve ticks per repeat.
With damping zero, the inspected mixed-axis angular velocity stayed exactly constant despite unequal principal inertias.
With damping 0.5, its components decayed proportionally in the inspected configurations.
The measured configuration omitted Euler gyroscopic evolution.
This bounded observation does not characterize every Rapier mode or establish physical fidelity.
The controller and physics remain unchanged by this milestone.
Private raw traces and source-bound analyses are retained; this summary is not a public replay or installed-runtime receipt.

## Complete state and replay

The canonical checkpoint includes:

- the complete Rapier snapshot bytes, body and collider handles;
- body parameters, poses, velocities, acceleration field, orientations, and angular velocities;
- every rotor's geometry, direction, speed, thrust, and torque;
- battery, armed state, motor targets, and active control selection;
- all controller gains, integral values, and previous errors;
- logical time, pending actions, and the complete accepted action history;
- the declared plan, ground geometry, runtime version, and deterministic placement generator state.

Negative zero uses `{"float64":"negative-zero"}` in canonical JSON.
Other finite numbers retain JavaScript's round-trippable JSON representation.
Non-finite checkpoint values reject.
Initial random placement uses a named 32-bit linear congruential generator.
Its state update is `s_next = (1664525 s + 1013904223) mod 2^32`.
Dividing that state by `2^32` supplies a value in `[0, 1)` for a declared spawn box.
This generator serves placement only. It does not claim physical sensor-noise fidelity.

Direct Rapier snapshot restoration matched immediate bytes but failed later full-byte equality in inspected larger-body cases.
Visible bodies initially remained equal, which did not satisfy the required complete fork contract.
The selected implementation therefore replays the frozen plan and accepted actions through a fresh instance of the same dynamics.
It compares the entire reconstructed reference state, including engine bytes, before accepting restore or fork.
A mismatch destroys the candidate and preserves the current owner.
Reconstruction cost grows with the recorded prefix.
This is not a constant-time checkpoint restoration claim.

Let `S_0` be the complete initial state from the bound plan.
Let `u_k` contain the controls selected for tick `k`, including explicit absence of a new action.
The existing transition computes `S_k = F(S_(k-1), u_k)`.
Reconstruction repeats the same initialization, object insertion order, ticks, and accepted actions under the same runtime.
The complete accepted history includes future actions already queued when the checkpoint was created.
Replaying this history also reconstructs transient engine state that direct snapshot loading failed to preserve.
Exact reference-state comparison is an additional acceptance guard, not a proof of cross-platform determinism.
The collision and future-action controls test this principle within their recorded bounds.

## Operating bounds

| Quantity | Bound |
| --- | --- |
| Drones | 1 through 256, sorted unique identifiers |
| Plan horizon | 7,200 ticks, or 60 simulated seconds |
| One advance | 1 through 2,400 ticks |
| Accepted actions | 4,096 per complete owner history, including pending actions |
| Retained checkpoints | Eight across a fork family |
| Live owners | Eight across a fork family, including its canonical owner |
| Serialized physics checkpoint | 4 MiB |
| Complete canonical checkpoint | 5 MiB |
| Position or altitude magnitude | 100,000 meters at admission |

Each active reconstruction can temporarily allocate one additional candidate world and checkpoint.
At most eight owners can reconstruct concurrently within one family.
Checkpoint creation and reconstruction block mutations on their requesting owner.
A physics failure after mutation retires that owner.
Hash or reconstruction failure preserves the current owner and releases the failed reservation.
These are admission bounds, not measured application throughput or memory-performance claims.

## Component gate

Run the complete repository gate before publication:

```bash
bun run validate:all
```

The focused actual-Rapier controls are:

```bash
bun run test:run src/physics/__tests__/DeterministicDroneWorld.test.ts src/physics/__tests__/DronePhysics.test.ts
```

They compare direct existing dynamics, controller memory, motor and battery state, pending actions, random placement, and complete checkpoint bytes.
They also exercise collisions, branch ordering, changed actions, presentation schedules, forged handles, capacity limits, and post-mutation failures.
The gate qualifies the tested same-runtime dynamics scope only.
It does not complete the standalone many-drone city product, installed Prisoma integration, or scientific sensor validation.

The current desktop bundle excludes the audited copier.
The production module gate rejects its inclusion until finalized-call provenance receives separate qualification.
This source allowance grants no future bundle exception.
