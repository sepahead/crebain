# CREBAIN Completion Levels

## Current and target claims

- **Current:** L0 research application.
- **Next target:** L1 secure deterministic single-vehicle SITL.
- **Not claimed:** live secure authority, HIL, physical-flight safety, field
  validity, operational readiness, or certification.

No component-level success promotes the system. Promotion requires all evidence
for one exact topology, source/configuration manifest, and ODD.

## Levels

| Level | Permitted claim | Minimum evidence | Still prohibited |
|---|---|---|---|
| L0 — Research application | Visualization, algorithms, local physics, Gazebo integration, developer bridges | Reproducible component tests and explicit limitations | Secure authority, HIL, physical safety, field validity |
| L1 — Secure SITL authority chain | One fully mediated authenticated vehicle-command chain in pinned SITL | Live Haldir/NCP/plant/FCU topology; sole-applier proof; bypass denial; plant-local expiry; safe-action, fault, restart, replay, overload, and staged evidence | HIL or physical-flight safety |
| L2 — Target-hardware HIL | The L1 chain on named compute/network/FCU hardware inside a declared HIL envelope | Timing/WCET, power-cycle, overload, link, FCU, geofence, and emergency evidence on exact hardware | Safety outside the tested HIL envelope |
| L3 — Supervised field experiment | Bounded experiment under an approved ODD | L2 exit, permits/range containment, trained operator, rehearsed abort, independent go/no-go, flight and incident records | General operational or certified use |
| L4 — Named operational/certification target | Configuration-controlled product under a named regulatory and assurance basis | Domain-specific safety/security case, independent verification, continued airworthiness/security | Generic “certified” claims |

## L1 definition of done

L1 means one controller, one live Haldir Gate, one authenticated NCP 0.8 final
route, one native CREBAIN plant authority, and one separately qualified FCU
adapter. The renderer has no generic command capability. Every command is fresh,
session-bound, apply-time checked, and followed through accepted, attempted,
FCU-accepted, and observed evidence. Galadriel, if enabled, is advisory only.
CREBAIN's feature/runtime-gated producer is component-tested, but a local NCP
put is not accepted/correlated Galadriel evidence and does not satisfy the live
L1 topology, security, heartbeat, or joined-stage requirements.

All L1 checks apply to the ODD in [`L1_ODD.md`](L1_ODD.md). PX4 is the initial
adapter target; ArduPilot is a separate qualification and is outside the initial
claim unless its own complete evidence bundle passes.

## Promotion and demotion

- Unknown, skipped, stale, or unavailable critical evidence is a failure, not a
  waiver.
- Any unresolved P0 hazard blocks L1 and command-enabled release.
- Any new actuator surface invalidates the baseline until classified, traced,
  and negatively tested.
- A changed source commit, lockfile, ACL, FCU image/parameters, model, launch
  profile, or safety limit creates a new configuration requiring re-evidence.
- A discovered bypass or unsafe failure demotes the affected configuration
  immediately to L0 until independently closed.
