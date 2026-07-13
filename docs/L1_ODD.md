# L1 Operational Design Domain

Status: **draft and unapproved**. The limits below are target constraints, not
measured capability. Missing evidence keeps CREBAIN at L0.

## Scope and exclusions

L1 covers one simulated electric multirotor, one controller, one Gate, one
router, one native plant, one PX4 SITL instance, one MAVROS link, and optional
read-only Galadriel observation on an isolated test network. CREBAIN now has a
component-tested, feature/runtime-gated producer for two advisory evidence keys,
but no qualified receiver, identity/ACL topology, registry agreement, deadline,
or impairment evidence; that does not satisfy this ODD. It excludes
physical propulsion, HIL, multiple vehicles, fixed-wing flight, payload release,
formation flight, public networks, arbitrary missions, and field operation.

ArduPilot requires a separate adapter, parameter set, scenario suite, and
evidence bundle. Its success cannot be inferred from PX4.

## ODD clauses

| ID | Constraint or assumption | L1 limit | Evidence/status |
|---|---|---|---|
| ODD-01 | Vehicle | One quadrotor SITL model; simulated mass 1.5–2.5 kg; no payload | Provisional; exact model/image digest pending |
| ODD-02 | FCU | PX4 SITL with named image, parameters, estimator, geofence, data-link and offboard failsafes | Exact version and parameter attestation pending |
| ODD-03 | Flight volume | Cylinder centered at launch: 100 m radius, 2–50 m AGL, with 15 m braking buffer | Plant and FCU fence tests pending |
| ODD-04 | Motion envelope | Horizontal speed ≤5 m/s; vertical speed ≤2 m/s; acceleration ≤2 m/s²; jerk ≤4 m/s³ | Inactive contract v1 checks finite velocity bounds; profile approval, acceleration/jerk state, and dynamics/fault verification remain pending |
| ODD-05 | Commands | Velocity plus state-dependent Hold/Land/RTL only; no mission upload, set-current, `AUTO.MISSION`, arbitrary mode, raw motor, or in-air disarm | General contract-v1 candidate admits velocity only and rejects the other named proposals. A separate inert candidate can dispatch a caller-supplied opaque situation code under an exact profile identity to a closed inhibit/hold/land/RTL/ground-disarm intent, but it does not classify authoritative state/triggers, bind rows into the profile, approve this matrix, convert intent to action, or prove a bypass denial |
| ODD-06 | Timing | Nominal command rate 20 Hz; command age ≤150 ms at apply; plant watchdog safe transition ≤250 ms | Contract v1 structurally bounds requested TTL and separates producer/local time; apply-time, WCET/jitter/fault evidence remains pending |
| ODD-07 | Localization | FCU estimator healthy; local pose/velocity age ≤200 ms; consistent ENU↔NED/FLU↔FRD transforms; simulation epoch monotonic | Profile-neutral same-frame-instance velocity-axis corpus and profile-bound captured-read age-comparison mechanics are component-tested. The classifier uses caller-proposed exclusive limits (`age < limit`), so it does not implement or approve this clause's inclusive `≤200 ms` condition. Frame-instance identity and same-origin/datum/body-point proof, profile selection/approval, attitude/yaw/quaternions, points/covariance, reset/current/apply-time staleness, and live FCU interpretation remain pending |
| ODD-08 | Required state | Armed/landed/mode, estimator health, battery, fence, link, position and velocity are one atomic plant snapshot | Closed immutable in-memory candidate and eight coherent ages from one read are component-tested; the separate classifier keeps the observation attached to an exact profile and named exclusive limits but supplies no aggregate health/safety verdict. Authenticated FCU collection, aggregation coherence, approved age/state policy, current/apply-time checking, and consumption remain pending |
| ODD-09 | Sensors/models | FCU state and pose are mandatory; perception/fusion/ML may inform intent but cannot alone authorize motion | Advisory isolation tests pending |
| ODD-10 | Network | Isolated virtual network; authenticated identities and exact ACLs; one-way p99 ≤50 ms; partition/reorder/loss are fail-safe | Live mTLS/ACL and impairment evidence pending |
| ODD-11 | Operator | One trained test operator; explicit start/abort; no unattended recovery; authority and observed-state displays are distinct | Usability and recovery drill pending |
| ODD-12 | Environment | Deterministic SITL world; no weather, lighting, RF, airspace, aerodynamic, or obstacle-avoidance claim | Simulation fixtures pending pin |
| ODD-13 | Controller | Signed typed intent only; controller cannot publish the final route or reach FCU interfaces | Live Haldir denial proof pending |
| ODD-14 | Evidence | Accepted, rejected, authorized, attempted, FCU-accepted, observed, expired and safe-state stages are bounded and replayable | Joined evidence pipeline pending |
| ODD-15 | Recovery | Every boot creates a new epoch/session; reconnect never resumes a target, mission, lease, or command | Restart matrix pending |

The numeric limits are intentionally narrower than generic protocol ceilings.
They must be replaced only by reviewed vehicle-specific values and revalidated
as one set.

## Safe-action matrix

This matrix remains a draft requirement. The current safe-action candidate does
not encode these rows or their ordering: it accepts opaque situation codes from
its caller and performs only exact-profile, no-default lookup over a
caller-proposed table. It has no health, lifecycle, time, landed/armed, airborne,
battery, fence, link, navigation, reset, or emergency inputs and therefore
cannot establish any trigger, precondition, precedence, or physical action.

| Trigger and authoritative state | Primary action | Preconditions | Fallback/containment | Required proof |
|---|---|---|---|---|
| Ground, landed, disarmed | Inhibit all plant output; remain disarmed | FCU landed and armed state fresh | FCU motor interlock | No motion under all ingress faults |
| Ground, landed, armed, no takeoff authorization | Request a guarded ground-disarm transaction | FCU confirms landed and disarm is permitted | Output inhibit plus FCU timeout | FCU-accepted disarm and observed state |
| Airborne, local position healthy, battery/fence nominal, brief authority loss | FCU position/altitude hold | Hold mode available and estimator fresh | Controlled land if loss exceeds approved dwell | Watchdog deadline and stable observed hold |
| Airborne, local position lost, global navigation and home valid | RTL | Home/fence/RTL health fresh | Controlled land if RTL unavailable | Stack-specific mode acceptance and trajectory |
| Airborne, navigation lost, attitude/height estimate usable | Controlled land | Land mode available | FCU configured emergency failsafe | Descent and landed-state observation |
| Critical battery | Controlled land at safe reachable site | Attitude/height estimate usable | FCU battery failsafe | Battery threshold and landing evidence |
| Fence/braking boundary imminent | Brake inward, then hold | Fresh pose/velocity and braking solution | FCU geofence action | Worst-case boundary tests |
| FCU link lost or plant process unavailable | No further plant output | None | Independent FCU data-link/offboard failsafe | Kill/partition evidence from FCU state |
| Authenticated emergency request while airborne | State-dependent Land or RTL; never raw disarm | Emergency identity, route, latch and state fresh | FCU failsafe/manual channel | Unauthorized/reset denials and emergency drill |
| Simulation pause/reset/time rewind | Invalidate session and authority; no output | New simulation epoch required | NoAuthority until fresh preflight | No stale command/evidence after reset |

NCP `hold` is a protocol mode, not a universal physical action. Total plant loss
is contained only by independently configured FCU behavior. Inhibiting plant
output is absence of output, not a Hold command. Ground disarm remains a
hazardous typed transaction under CTL-018 and must never become an airborne
fallback.

## L1 blockers

The exact PX4 image/parameters, SITL vehicle/world, Haldir deployment, NCP ACL,
plant governor, adapter, timing results, safe-action transitions, and evidence
schema are not yet qualified. Physical flight remains prohibited.
