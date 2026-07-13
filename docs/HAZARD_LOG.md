# Phase 0 Hazard Log

The normative structured log is
[`baselines/phase0-hazards.json`](baselines/phase0-hazards.json). It uses an
STPA-style unsafe-control-action view: an action may be provided when unsafe,
omitted, mistimed/reordered, or applied too long.

## Status semantics

- **open:** required controls or evidence are absent.
- **partial:** some component controls exist, but system/topology evidence is
  incomplete.
- **controlled:** every referenced control is marked verified and covered by
  typed evidence whose test declaration names the same hazard/control IDs. The
  record and its content-hashed JSON artifact must agree on the exact hazard,
  controls, verification command/result, and non-placeholder candidate commit.
  Mere selector text or an existing unrelated path is insufficient.
- **accepted:** residual risk has named approval, rationale, scope, and expiry.

No hazard in this baseline is controlled or accepted. Every P0 entry blocks L1.

| ID | Hazard | Severity | Status | Primary control direction |
|---|---|---|---|---|
| HAZ-001 | Motion through an authority bypass | P0 | open | Sole native applier; exact Gate identity/route; bypass campaign |
| HAZ-002 | Required safe action is lost or omitted | P0 | open | Plant watchdog plus independent FCU failsafe |
| HAZ-003 | Delayed command remains active | P0 | partial | Passive generation-bound monotonic expiry mechanics exist; command admission, active scheduling, apply-time age check, and bounded TTL policy remain absent |
| HAZ-004 | Replay, duplicate, or cross-session command is accepted | P0 | partial | Boot/session/stream fencing and anti-rollback |
| HAZ-005 | Correct vector is applied in the wrong frame or unit | P0 | open | Typed frame/unit profile and golden transforms |
| HAZ-006 | Stale or inconsistent vehicle state authorizes motion | P0 | open | Atomic fresh health snapshot immediately before write |
| HAZ-007 | Generic Hold/ESTOP causes an unsafe physical action | P0 | open | ODD/vehicle safe-action matrix and guarded reset |
| HAZ-008 | Router, MAVROS, FCU, or data-link loss leaves unsafe output | P0 | open | Bounded loss detection and independent FCU fallback |
| HAZ-009 | Estimator/fusion divergence appears nominal | P1 | partial | Consistency metrics, divergence state, conservative invalidation |
| HAZ-010 | Model failure or miscalibration creates an unsafe decision | P1 | open | Signed model contract; calibrated advisory use only |
| HAZ-011 | Missing, censored, stale, or dropped evidence appears nominal | P0 | open | Explicit insufficiency/drop/heartbeat semantics |
| HAZ-012 | Resource exhaustion starves watchdog or emergency handling | P0 | partial | Inert kernel channel bounds/loss accounting exist; scheduler reservation and combined-load timing remain absent |
| HAZ-013 | Restart or reconnect resurrects stale authority | P0 | partial | Process-local generation guards exist; durable boot/session anti-rollback and topology restart tests remain absent |
| HAZ-014 | Operator confuses connected/delivered with applied/observed | P1 | open | Controlled vocabulary and distinct authority/effect UX |
| HAZ-015 | Gazebo/local mutation contaminates flight evidence | P1 | partial | Separate binaries, identities, profiles, and evidence labels |
| HAZ-016 | Mission, mode, arm, takeoff, land, or disarm bypasses policy | P0 | open | Typed hazardous-action transaction or exclusion from L1 |
| HAZ-017 | Geofence is crossed despite a numeric clamp | P0 | open | Braking envelope plus independently configured FCU fence |

Controls, causes, ODD clauses, evidence IDs, owners, and residual-risk notes are
kept in the JSON record and checked by the Phase 0 verifier.

The inert headless plant package adds component evidence only. It does not
control HAZ-001/002: there is no FCU write path, watchdog, safe-action table, or
independent failsafe evidence. HAZ-012/013 remain L1-blocking because fixed
channel semantics and process-local generation guards do not prove deadline
scheduling, process-restart uniqueness, or retained-network behavior.
The passive expiry guard narrows HAZ-003 mechanics only: exact-deadline,
generation-rotation, clock-regression, and invalid-TTL cases fail closed. It is
not an active watchdog and does not prove platform suspend behavior,
immediately-before-write coupling, scheduler jitter, or expiry-to-safe-action
latency.
