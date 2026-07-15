# Historical Sensor-Fusion Agent Transcript (Do Not Implement)

> [!CAUTION]
> **Historical and superseded. Do not use this file as an implementation plan.**
> It preserves recovered agent output for provenance only. Several snippets encode
> pre-fix behavior, including an incorrect Mahalanobis-distance interpretation and
> obsolete assignment sentinels. The shipped code, tests, and
> [current sensor-fusion documentation](../SENSOR_FUSION.md) are authoritative.
> Reintroducing any recommendation from this transcript requires a new design review
> against the current implementation and regression suite.

> **Provenance.** These are the verbatim final structured outputs of the spec-research
> agents from workflow `wf_10b1c47f-d0a`, recovered from their transcripts after the run's
> aggregated return was lost to an interruption. They were proposals against an older
> code snapshot, not current specifications. See
> **[SENSOR_FUSION.md → Known limitations and roadmap](../SENSOR_FUSION.md#known-limitations-and-roadmap)**
> for current status and constraints.
>
> **STATUS AT ARCHIVAL.** Items #2 and #3 (threat unification, χ²-calibrated gating),
> #4 (sequential per-sensor / information-form update), #5 (sliding-window M-of-N
> confirmation + covariance-volume deletion), #6 (global nearest-neighbour /
> Hungarian assignment), #7 (CV + Coordinated-Turn IMM) and #8 (geometric cross-camera
> gate) had been implemented. These transcript sections are not valid cross-checks. At
> archival time, only
> per-measurement timestamps / out-of-sequence-measurement (OOSM) handling and full
> 3×3 measurement covariances remain open; see the
> **[SENSOR_FUSION.md roadmap](../SENSOR_FUSION.md#known-limitations-and-roadmap)** for
> the authoritative status table.
> **Item #9 (OOSM) is absent** — that agent was still researching when the run was
> interrupted (`[Request interrupted by user]`) and never emitted a structured spec; see
> the OOSM note in SENSOR_FUSION.md's roadmap instead.


---

## #2 — Threat unification  *(IMPLEMENTED; cross-check)*

- **Feasibility (agent):** now-full

**Recommended approach.** Adopt the TypeScript getThreatLevel behavior as the single canonical formula, and rewrite Rust calculate_threat_level to match it bit-for-bit. Rationale (counter-UAS threat prioritization): the TS formula is the richer, confidence-graduated one and is the more defensible posture on both ends of the spectrum.

(1) DRONE/UAV low-confidence (conf <= 0.5): keep TS behavior = level 2, NOT Rust's flat 3. A drone hypothesis asserted with <=50% confidence is barely-better-than-coin-flip; pinning it at "elevated" (3) the moment any sensor whispers "drone" floods the operator with amber tracks and degrades trust/triage. Graduating 2 -> 3 -> 4 with confidence keeps the alert ladder meaningful (guarded -> elevated -> severe). Multi-sensor cross-validation is explicitly the mechanism C-UAS systems use to suppress single-sensor false positives, so a low-confidence single assertion should sit at "guarded" until corroboration raises confidence (warquants/skylarklabs sources).

(2) UNKNOWN/unclassified: keep TS behavior = level 3 if conf > 0.7 else 2, NOT Rust's flat 2. A high-confidence track that resists classification (good track quality, no class match) is exactly the 'pending-identification' case air-defense doctrine treats cautiously: a confidently-tracked-but-unidentified object near protected airspace warrants elevated (3) attention, not the same baseline as a positively-classified manned aircraft. A low-confidence unknown stays at 2 to avoid noise. This makes "unknown" outrank a known benign manned aircraft only when the track is confident, which is the correct triage ordering.

(3) Manned AIRCRAFT/HELICOPTER: level 2 (both already agree). Birds: level 1 (both agree).

Net: the only behavioral changes are on the Rust side - low-confidence drones drop 3->2 and confident unknowns rise 2->3 - bringing Rust into line with TS. The TS function and all its callers (mapToDetectionClass -> getThreatLevel chain in detectors and SensorFusion.ts) are unchanged, so no TS-side regressions. The class-string normalization asymmetry is handled by keeping Rust's substring matcher (Rust receives RAW ROS classification strings that never pass through mapToDetectionClass) but reordering/extending it so its class buckets are exactly the 5 DetectionClass values and the per-class confidence thresholds match TS. Define a single shared threshold spec in a comment block referencing types.ts so future drift is caught in review.

**Math / equations.**
- `Canonical threat(class, c): drone/uav -> (c>0.8 ? 4 : c>0.5 ? 3 : 2); aircraft/helicopter -> 2; bird -> 1; unknown/else -> (c>0.7 ? 3 : 2).`
- `All comparisons are strict greater-than (>). Boundary cases pinned: drone c=0.8 -> 3; drone c=0.5 -> 2; unknown c=0.7 -> 2.`
- `Behavioral delta vs current Rust: only two regions change. drone with c in [0, 0.5]: 3 -> 2. unknown with c in (0.7, 1]: 2 -> 3. All other (class, c) pairs unchanged.`
- `Behavioral delta vs current TS: none (TS is canonical).`

**Rust changes.**

File: src-tauri/src/sensor_fusion.rs, function calculate_threat_level (lines 241-258). Replace the body so the per-class confidence graduation matches TS exactly. Keep the signature fn calculate_threat_level(class: &str, confidence: f64) -> u8 and keep the .to_lowercase() substring matching (Rust receives raw ROS classification strings, e.g. from useROSSensors det.classification, that are NOT run through mapToDetectionClass; substring matching is the Rust-side normalization and must stay).

New body (drone/uav graduated; unknown/else graduated; aircraft/helicopter flat 2; bird flat 1):

fn calculate_threat_level(class: &str, confidence: f64) -> u8 {
    // CANONICAL threat-level definition. Mirrors
    // src/detection/types.ts::getThreatLevel - keep the two in sync.
    // Buckets correspond to the 5 DetectionClass values. Note: Rust matches
    // raw sensor classification substrings (these strings never pass through
    // mapToDetectionClass), whereas TS receives the already-normalized enum.
    let class_lower = class.to_lowercase();
    if class_lower.contains(\"drone\") || class_lower.contains(\"uav\") {
        // drone
        if confidence > 0.8 { 4 } else if confidence > 0.5 { 3 } else { 2 }
    } else if class_lower.contains(\"aircraft\") || class_lower.contains(\"helicopter\") {
        // manned aircraft / helicopter
        2
    } else if class_lower.contains(\"bird\") {
        // bird
        1
    } else {
        // unknown / unclassified
        if confidence > 0.7 { 3 } else { 2 }
    }
}

Ordering note for matcher correctness: drone/uav check FIRST, then aircraft/helicopter, then bird, else=unknown. This matches mapToDetectionClass precedence and avoids a future label like \"uav-aircraft\" being misbucketed. Do not add the word \"quadcopter\"/\"kite\"/\"frisbee\" handling here - those remap to 'drone' only in the TS UI/demo path (mapToDetectionClass) before TS calls getThreatLevel; the Rust engine is fed already-tactical classification strings from ROS, so adding demo remaps here would be scope creep and is unnecessary for parity on the canonical enum values.

> **Editor's note (superseded):** the shipped `map_to_detection_class` *does* include the `kite`/`frisbee` remap, so it is byte-for-byte identical to `mapToDetectionClass` for **all** labels (not only the canonical enum values). Full parity was preferred over minimizing the Rust match arms, and is locked by the `calculate_threat_level_matches_canonical_table` Rust test and `threatLevel.test.ts`.

This is the only Rust code change. The call site (line 222) and TrackOutput.threat_level: u8 (line 204) are unchanged.

**TS changes.**

NONE required to behavior. src/detection/types.ts getThreatLevel (lines ~308-319) is the canonical reference and stays as-is:
  drone   -> conf>0.8 ?4 : conf>0.5 ?3 : 2
  unknown -> conf>0.7 ?3 : 2
  aircraft/helicopter -> 2
  bird -> 1
Recommended (optional, low-cost) doc-only edit: above getThreatLevel add a comment "// CANONICAL threat-level definition. Mirrored in src-tauri/src/sensor_fusion.rs::calculate_threat_level - keep in sync." so the two sites are cross-referenced. Do NOT change thresholds or branch order; doing so would break the existing assertions in src/hooks/__tests__/useDetectionLoop.test.ts (unknown@0.8 -> 3 at line 124-142; airplane@0.99 -> 2; kite@0.9 -> drone -> 4).

Note the boundary semantics that Rust MUST replicate exactly: strict greater-than (>) at every threshold (0.8, 0.7, 0.5), so conf==0.8 for a drone yields 3 (not 4), conf==0.5 yields 2, conf==0.7 for unknown yields 2.

**Parameters.**
- `drone high-confidence threshold` = `confidence > 0.8 -> level 4` — Matches existing TS drone branch and existing Rust conf>0.8 escalation; strict >, so 0.8 exactly stays at 3.
- `drone mid-confidence threshold` = `0.5 < confidence <= 0.8 -> level 3` — Both implementations already agree here; preserved.
- `drone low-confidence floor` = `confidence <= 0.5 -> level 2` — CHANGE on Rust side (was flat 3). Avoids amber-flooding from uncorroborated single-sensor drone hypotheses; lets multi-sensor confidence raise the level.
- `unknown high-confidence threshold` = `confidence > 0.7 -> level 3` — CHANGE on Rust side (was flat 2). A confidently-tracked but unidentified object near protected airspace warrants elevated attention (pending-identification doctrine).
- `unknown low-confidence floor` = `confidence <= 0.7 -> level 2` — Keeps noisy low-confidence unidentified returns at guarded, not elevated.
- `aircraft/helicopter` = `level 2 (flat)` — Manned/cooperative platforms; both implementations already agree.
- `bird` = `level 1 (flat)` — Benign clutter; both implementations already agree.

**Test cases.**
- RUST (add #[test] fn calculate_threat_level_matches_canonical_table in sensor_fusion.rs tests module): assert_eq!(calculate_threat_level("drone", 0.9), 4); ("drone", 0.8) -> 3 (boundary, strict >); ("drone", 0.6) -> 3; ("drone", 0.5) -> 2 (boundary); ("drone", 0.3) -> 2 (REGRESSION GUARD: previously 3).
- RUST uav alias: ("uav", 0.95) -> 4; ("uav", 0.4) -> 2.
- RUST substring/normalization: ("DRONE", 0.9) -> 4 (case-insensitive); ("fpv-drone", 0.9) -> 4 (substring); ("Fixed-wing UAV", 0.4) -> 2.
- RUST aircraft/helicopter: ("aircraft", 0.99) -> 2; ("helicopter", 0.99) -> 2; ("commercial aircraft", 0.2) -> 2.
- RUST bird: ("bird", 0.99) -> 1; ("flock of birds", 0.1) -> 1.
- RUST unknown/else: ("balloon", 0.8) -> 3 (REGRESSION GUARD: previously 2); ("balloon", 0.7) -> 2 (boundary); ("", 0.9) -> 3; ("clutter", 0.5) -> 2.
- RUST precedence: ("uav aircraft", 0.9) -> 4 (drone/uav bucket wins, matches mapToDetectionClass drone-first precedence).
- TS (extend src/hooks/__tests__/useDetectionLoop.test.ts OR add a dedicated getThreatLevel unit test in src/detection/__tests__/): getThreatLevel('drone',0.9)===4; getThreatLevel('drone',0.8)===3; getThreatLevel('drone',0.6)===3; getThreatLevel('drone',0.5)===2; getThreatLevel('drone',0.3)===2.
- TS unknown: getThreatLevel('unknown',0.8)===3; getThreatLevel('unknown',0.7)===2; getThreatLevel('unknown',0.5)===2.
- TS aircraft/helicopter/bird: getThreatLevel('aircraft',0.99)===2; getThreatLevel('helicopter',0.99)===2; getThreatLevel('bird',0.99)===1.
- CROSS-PARITY (documentation/optional harness): for the 5 enum classes x confidences {0.3,0.5,0.6,0.7,0.8,0.9}, the Rust table and TS getThreatLevel produce identical levels (with Rust fed the lowercase enum string, e.g. "drone","aircraft","helicopter","bird","unknown" -> Rust 'unknown' falls into else branch).
- VERIFY existing TS tests stay green: useDetectionLoop.test.ts kite@0.9->drone->threatLevel 4 (line 100), airplane@0.99->aircraft->2 (line 122), balloon@0.8->unknown->3 (line 139) all still pass because TS is unchanged.

**Risks.**
- LOW overall risk - pure scalar function, no state, no covariance/matrix math touched.
- Behavioral change is operator-visible: low-confidence drone tracks will display T2 (blue/guarded) instead of T3 (amber/elevated), and confident unknowns will display T3 instead of T2. SensorFusionPanel.tsx sorts/colors by threat_level and CrebainViewer.tsx escalates global posture when threatLevel>=3 - so a previously-amber low-confidence drone will no longer auto-escalate the global indicator until its confidence exceeds 0.5. This is the INTENDED behavior change; flag it in the PR description so it is not mistaken for a regression.
- Rust unknowns now reach level 3, but TrackOutput.threat_level is u8 and THREAT_LEVEL_COLORS covers 1-4, so no out-of-range/color-map gap.
- Substring-precedence subtlety: an exotic raw classification containing both 'uav' and 'aircraft' now buckets as drone (4-capable) rather than the old aircraft-flat-2. Acceptable and arguably safer for C-UAS, but call out in review.
- If other roadmap items (the coordinated single-pass edit) also touch lines 222 / TrackOutput / the tests module of sensor_fusion.rs, expect merge adjacency. This change is confined to fn calculate_threat_level (241-258) plus a new #[test]; it does not touch association gating, IMM, track lifecycle, or the information-form update, so there are no logical conflicts with items #3-#9 - only textual proximity in the same file's tests module (#5 M-of-N confirmation and #10 verification may add tests in the same module; keep test fn names unique).
- No conflict with class-string handling elsewhere: do NOT 'fix' the Rust/TS normalization asymmetry by routing Rust through a port of mapToDetectionClass - the Rust engine is intentionally fed raw ROS classification strings and substring matching is correct there. Porting mapToDetectionClass would be a larger, out-of-scope change and risks breaking ROS classification strings that are not COCO labels.

**Depends on:** Independent of items #3 (chi-square gating), #4 (information-form update), #6 (GNN assignment), #7 (IMM), #8 (cross-camera gate), #9 (OOSM) - none read or write threat_level., Textual-only adjacency with #5 (M-of-N confirmation) and #10 (verify/document) if they add #[test] functions to the same sensor_fusion.rs test module - ensure unique test fn names; no logic overlap., Sequence within the coordinated pass: this item can be applied first (smallest, lowest-risk) to de-risk the diff; it has no ordering prerequisite on any other item.

**Citations.**
- The War Quants Counter-UAS Primer: Sensing — https://www.warquants.com/p/the-war-quants-counter-uas-primer-c54
- Counter-UAS: AI Software for Unmanned Aerial Threat Detection (Skylark Labs) — https://skylarklabs.ai/use-cases/counter-uas.html
- Counter-Unmanned Aerial Systems (C-UAS / Counter-Drone) - Sentrycs glossary — https://sentrycs.com/glossary/counter-unmanned-aerial-systems-c-uas-counter-drone/
- Guidelines on Counter Unmanned Aircraft Systems (UN Peacekeeping, 2025) — https://resourcehub01.blob.core.windows.net/$web/Policy%20and%20Guidance/corepeacekeepingguidance/Thematic%20Operational%20Activities/Military/2025.16%20Guidelines%20on%20Counter%20Unmanned%20Aircraft%20Systems.pdf

---

## #3 — Chi-square gating  *(IMPLEMENTED; cross-check)*

- **Feasibility (agent):** now-full

**Recommended approach.** RECOMMENDED: Option (b) with a renamed field. Gate on the SQUARED Mahalanobis distance (NIS = d2 = diff^T S^-1 diff) against a chi-square(dof=3) quantile, and rename the config field association_threshold -> gate_chi2 (or keep the name but redefine its semantics as a d2-gate). Because the squared form is a strict monotonic transform of the current sqrt form, gating logic and the greedy "best track" selection are unchanged in spirit; only the comparison value's units change (unitless d, default 10.0, becomes unitless d2, default 11.345 = chi2 0.99/dof3).

Why squared + chi-square: the normalized innovation squared NIS = v^T S^-1 v with v = z - Hx and S = H P H^T + R is, under the linear-Gaussian/correct-association assumption, chi-square distributed with dof = measurement dimension (here position dim = 3). The standard tracking validation gate accepts a measurement iff NIS <= gamma where gamma is the upper-alpha chi-square quantile, giving a calibrated gate probability P_G = 1 - alpha. The current code takes a sqrt and compares against 10.0, which has NO probabilistic meaning (10.0 in d-units corresponds to d2=100, far outside any reasonable gate for dof=3 — effectively no gate). Removing the sqrt and using a chi2 quantile makes the gate statistically principled. See Bar-Shalom; the NIS/chi-square gate is textbook.

EXACT chi-square(dof=3) quantiles to document in code as named constants:
  0.90 -> 6.251
  0.95 -> 7.815
  0.975 -> 9.348
  0.99 -> 11.345
DEFAULT: 11.345 (P_G = 0.99). This is intentionally loose to avoid dropping valid measurements on confident tracks; the team can tighten to 9.348 (0.975) or 7.815 (0.95) later. 11.345 is also the closest principled value to the legacy 10.0 magnitude, minimizing behavioral surprise.

Naming decision: I recommend KEEPING the field name association_threshold to avoid touching the FusionConfig serde shape / TS interface / 5 call sites' key names, but changing its DEFAULT value 10.0 -> 11.345 and its documentation/semantics to "squared Mahalanobis (NIS) chi-square gate, dof=3". This is the smallest, most verifiable change and avoids a serde-field rename that would ripple into Tauri command payloads and the TS FusionConfig interface. (If a rename is later desired for clarity, do it as a separate, isolated commit.)

Singular-covariance fallback: currently diff.norm() / NOMINAL_ASSOCIATION_SIGMA_M (a Euclidean d in sigma-units). To keep it on the SAME (now squared) scale, square it: (diff.norm() / NOMINAL_ASSOCIATION_SIGMA_M)^2, i.e. diff.dot(diff) / (NOMINAL_ASSOCIATION_SIGMA_M^2). With NOMINAL_ASSOCIATION_SIGMA_M = 1.0 this is just diff.dot(diff). Keep the constant for clarity.

**Math / equations.**
- `Innovation: v = z - H x_pred, with H = [I3 | 0] selecting the position block, so H x_pred = (x,y,z).`
- `Innovation covariance: S = H P H^T + R. In code, H P H^T = pos_cov (top-left 3x3 of track.covariance) and R = diag(meas.covariance[0..3]); innovation_cov = pos_cov + r (line 1448).`
- `Squared Mahalanobis distance / Normalized Innovation Squared: d2 = NIS = v^T S^-1 v (drop the sqrt at line 1457).`
- `Gate rule: accept association iff d2 <= gamma, where gamma = chi-square upper-alpha quantile with dof = measurement dimension = 3.`
- `Gate probability: P_G = 1 - alpha = P(chi2_3 <= gamma).`
- `Chi-square(3) quantiles: gamma(P_G=0.90)=6.251; gamma(0.95)=7.815; gamma(0.975)=9.348; gamma(0.99)=11.345. Default gamma = 11.345.`
- `Singular-S fallback (squared): d2_fallback = (||v|| / NOMINAL_ASSOCIATION_SIGMA_M)^2 = v.v / sigma^2; with sigma = 1.0 this is v.v.`
- `Monotonicity note: since sqrt is strictly increasing, argmin over tracks of d2 equals argmin of d, so greedy nearest-neighbour assignment is unchanged; only the gate CUTOFF's units change from d (was 10.0) to d2 (now 11.345).`

**Rust changes.**

All in src-tauri/src/sensor_fusion.rs.

1) Add chi-square constants near the existing constants block (after line 30, NOMINAL_ASSOCIATION_SIGMA_M). Add a doc comment giving dof=3 = position measurement dimension:
   /// Chi-square upper quantiles for dof = 3 (position measurement dimension).
   /// The squared Mahalanobis distance (NIS) d2 = v^T S^-1 v is chi-square(3)
   /// under correct association, so gating d2 <= one of these gives a calibrated
   /// gate probability P_G. Values from standard chi-square tables.
   pub const CHI2_DOF3_P90: f64 = 6.251;
   pub const CHI2_DOF3_P95: f64 = 7.815;
   pub const CHI2_DOF3_P975: f64 = 9.348;
   pub const CHI2_DOF3_P99: f64 = 11.345;

2) Line 1157 (FusionConfig::Default): change
     association_threshold: 10.0, // Mahalanobis distance threshold
   to
     association_threshold: CHI2_DOF3_P99, // squared-Mahalanobis (NIS) chi-square gate, dof=3 (P_G=0.99)

3) Line 1145 (struct field doc): add/repurpose a doc comment on `pub association_threshold: f64,` reading: "Squared Mahalanobis distance (NIS) gate threshold; compared against d2 = v^T S^-1 v which is chi-square(dof=3). Defaults to chi2(0.99,3)=11.345."

4) associate_measurements, line 1456-1460: REMOVE the .sqrt() and square the fallback. Replace
        let distance = if let Some(inv) = innovation_cov.try_inverse() {
            (diff.transpose() * inv * diff)[0].sqrt()
        } else {
            diff.norm() / NOMINAL_ASSOCIATION_SIGMA_M
        };
   with
        // Squared Mahalanobis distance (NIS): d2 = diff^T S^-1 diff, chi-square(dof=3).
        let distance_sq = if let Some(inv) = innovation_cov.try_inverse() {
            (diff.transpose() * inv * diff)[0]
        } else {
            // Singular S: fall back to squared, sigma-normalized Euclidean distance
            // so the gate stays on the same (squared) scale.
            let d = diff.norm() / NOMINAL_ASSOCIATION_SIGMA_M;
            d * d
        };

5) Line 1462: change
        if distance < best_distance && distance < self.config.association_threshold {
            best_distance = distance;
   to
        if distance_sq < best_distance && distance_sq < self.config.association_threshold {
            best_distance = distance_sq;
   (best_distance initialized to f64::MAX at line 1414 still works; comparison is now in d2-units. Greedy nearest-neighbour selection is preserved: minimizing d2 == minimizing d.)

6) Update the comment block at lines 1421 and 1450-1455 to say "squared Mahalanobis (NIS) chi-square(3) gate" instead of "Mahalanobis distance".

7) validate_fusion_config (lines 1215-1220): MAX_ASSOCIATION_THRESHOLD = 100_000.0 (line 24) already accommodates 11.345, so the bound does NOT block the change — confirmed. RECOMMENDED tightening for sanity: lower MAX_ASSOCIATION_THRESHOLD to 1000.0 (well above chi2(0.999,3)=16.27 yet rejecting absurd values), since d2 for dof=3 has no legitimate use above ~30. This is optional; if kept at 100_000.0 the change is still correct. Lower bound f64::EPSILON is fine. Update the inline default comment at line 1157 accordingly. NOTE: lowering MAX coordinates with item #6 (Hungarian) which will reuse the same threshold as a per-cell gate; agree the value before that item lands.

**TS changes.**

No structural/interface change to src/detection/AdvancedSensorFusion.ts: the FusionConfig interface field `association_threshold: number` (line 102) stays. Only the DEFAULT numeric value changes, plus a doc comment, across 3 default sites + 2 tests.

1) src/detection/AdvancedSensorFusion.ts line 251: change
       association_threshold: config.association_threshold ?? 10.0,
   to
       association_threshold: config.association_threshold ?? 11.345,
   Add a comment above the field (line 102) in the interface: "// Squared-Mahalanobis (NIS) chi-square(dof=3) gate; default 11.345 = chi2(0.99,3)."

2) src/ros/useROSSensors.ts line 655 (setAlgorithm): change association_threshold: 10.0 -> 11.345.

3) src/components/SensorFusionPanel.tsx line 188 (handleAlgorithmChange): change association_threshold: 10.0 -> 11.345.

Migrate the 2 test sites in src/detection/__tests__/AdvancedSensorFusion.test.ts WITHOUT breaking:
4) Line 42 (the initFusion default-injection assertion): the test asserts initFusion({algorithm:'IMM'}) injects association_threshold: 10. Since initFusion's default now becomes 11.345, change the EXPECTED value at line 42 from `association_threshold: 10,` to `association_threshold: 11.345,`. This is the correct migration: the test pins initFusion's default-filling behavior, so the expectation must track the new default.
5) Line 151 (a hand-built FusionConfig passed to setFusionConfig in a command-routing test): this value is supplied by the test author, not defaulted. It can stay 10 (the routing test only checks the command name sequence, not the numeric value) OR be updated to 11.345 for consistency. RECOMMEND update to 11.345 to keep the codebase's example configs coherent and avoid a stray legacy value. Verify by reading the assertion block following line 159 — it asserts invokeMock call NAMES (line 164 onward: `.map((call)=>call[0])`), not payloads, so changing 10->11.345 here is safe.

Run `npm test -- AdvancedSensorFusion` (vitest) to confirm both tests pass after migration.

**Parameters.**
- `association_threshold (default)` = `11.345` — chi-square(0.99, dof=3); calibrated gate probability P_G=0.99. Loosest principled default, closest in magnitude to the legacy 10.0, minimizes risk of dropping valid measurements on confident tracks. Field name kept; semantics changed from d-gate to d2(NIS)-gate.
- `CHI2_DOF3_P95` = `7.815` — chi2(0.95,3). Tighter alternative (P_G=0.95) if duplicate/spurious tracks appear; named constant for easy tuning.
- `CHI2_DOF3_P975` = `9.348` — chi2(0.975,3). Middle-ground gate (P_G=0.975).
- `CHI2_DOF3_P99` = `11.345` — chi2(0.99,3). The chosen default.
- `CHI2_DOF3_P90` = `6.251` — chi2(0.90,3). Tightest listed option for noisy/dense scenes.
- `NOMINAL_ASSOCIATION_SIGMA_M` = `1.0 (unchanged)` — Per-axis sigma for the singular-S fallback; now used as d2_fallback = (||v||/sigma)^2. Kept at 1.0.
- `MAX_ASSOCIATION_THRESHOLD` = `100_000.0 (unchanged) OR optionally 1000.0` — Current 100_000.0 already permits 11.345, so no change is REQUIRED for correctness. Optional tightening to 1000.0 rejects nonsensical d2 values (legitimate chi2(3) gates are < ~30) while leaving headroom; coordinate this value with item #6 (Hungarian) which reuses the same gate.

**Test cases.**
- Rust unit test (new) gate_accepts_within_chi2_gate: build MultiSensorFusion::default (EKF), process one measurement at [10,0,5] cov [1,1,1] at t=1000 to seed a track, then frame 2 a measurement offset so that d2 is just BELOW 11.345 (e.g. offset chosen so NIS ~ 8). Assert tracks.len()==1 (associated, not a new track).
- Rust unit test (new) gate_rejects_outside_chi2_gate: same seed, then a measurement offset so d2 is clearly ABOVE 11.345 (e.g. position [40,0,5] with cov [1,1,1] -> NIS ~ 900/(P+R) >> 11.345). Assert tracks.len()==2 (a NEW track spawned, original coasted/missed).
- Rust unit test (new) gate_threshold_is_squared_units: regression guard documenting the units change. Construct a scenario where the OLD d-gate (10.0) would associate (d between sqrt(11.345)=3.37 and 10) but the NEW d2-gate (11.345) would reject (d2 between 11.345 and 100). Assert the measurement is NOT associated. This pins the semantic change so a future revert is caught.
- Rust unit test (new) chi2_constants_values: assert CHI2_DOF3_P95==7.815, P975==9.348, P99==11.345, P90==6.251 (cheap guard against typos in the literature values).
- Rust: confirm test_multi_sensor_fusion (line 1870) and test_multi_frame_track_lifecycle (line 1906) still pass — the cam/thermal pair at [10,0,5]/[10.5,0.5,5] has tiny d2 and must still fuse into one track under the new gate.
- Rust: confirm validate_fusion_config accepts association_threshold=11.345 and rejects <=0 / non-finite; if MAX lowered to 1000.0, add a case asserting 2000.0 is rejected.
- TS vitest: src/detection/__tests__/AdvancedSensorFusion.test.ts line 42 expectation updated to 11.345 and passes (initFusion default injection).
- TS vitest: the command-routing test around line 147-164 passes with association_threshold updated to 11.345 (or unchanged 10) — it asserts call NAMES, not payload values.

**Risks.**
- UNITS SILENT-CHANGE: removing sqrt changes the meaning of association_threshold from d to d2. Any external config, saved preset, or operator who set a numeric value expecting d-units will now be interpreting it as d2. Mitigated by changing all in-repo defaults together and documenting the field. Flag in release notes.
- GATE TIGHTENS RELATIVE TO LEGACY: the OLD effective gate was d<10 i.e. d2<100 (essentially no gate). The NEW gate d2<11.345 i.e. d<3.37 is MUCH tighter. This is the intended correctness fix, but it will reject far-offset measurements that previously associated, potentially spawning more new tracks in noisy data. Validate against representative ROS playback; if over-fragmenting, loosen to a higher chi2 quantile, NOT back to d-units.
- ORDERING/CONFLICT with item #6 (Global nearest-neighbour Hungarian/auction): #6 will REWRITE associate_measurements to build a cost matrix. The chi-square gate must be applied there too: set cost = d2 and forbid (INF cost) any cell with d2 > association_threshold. If #3 lands first, #6 must preserve the squared-d2 + chi2 cutoff (do NOT reintroduce sqrt). Coordinate so both use the SAME association_threshold field in d2-units. Recommend landing #3 first (smaller) so #6 builds on the correct units.
- CONFLICT-LOW with item #4 (sequential per-sensor information-form update): #4 touches update_track (line 1481+), not the gate. No code overlap, but #4 changes how P shrinks after updates, which changes S and therefore d2 for subsequent frames — purely behavioral, no merge conflict.
- CONFLICT-LOW with item #9 (per-measurement timestamps/OOSM): touches predict/dt, not the gate math; no overlap.
- MAX_ASSOCIATION_THRESHOLD: if left at 100_000.0 a misconfigured huge value disables gating silently. Optional tightening to 1000.0 mitigates but must be agreed with #6.
- TEST line 151 legacy 10: if left as 10 it becomes an inconsistent example value in the repo (harmless to the assertion, which checks names). Recommend updating to 11.345 to avoid confusion; verify the assertion block does not check payloads before changing.

**Depends on:** #6 Global nearest-neighbour (Hungarian/auction): SHARED FILE + SHARED FUNCTION (associate_measurements). Land #3 first; #6 must consume d2 + chi2 cutoff in its cost matrix and keep the association_threshold field in d2-units. Highest conflict risk of the pass., #4 Sequential per-sensor information-form update: same file (update_track), no code overlap; behavioral coupling via P->S->d2 only., #9 Per-measurement timestamps/OOSM: same file (predict path), no overlap., #2 Unify threat-level formula: unrelated code path; no conflict.

**Citations.**
- Validation Gating for Non-Linear Non-Gaussian Target Tracking (Bailey et al., Fusion 2006) — NIS is chi-square; gate threshold is upper-alpha chi-square quantile — https://www-personal.acfr.usyd.edu.au/tbailey/papers/fusion06.pdf
- Mahalanobis distance (Wikipedia) — squared Mahalanobis distance follows chi-square; used to set gate thresholds — https://en.wikipedia.org/wiki/Mahalanobis_distance
- Chi-squared distribution (Wikipedia) — sum of squared standard normals; quantiles define gate cutoffs — https://en.wikipedia.org/wiki/Chi-squared_distribution
- Critical Values of the Chi-Square Distribution (UIUC PHYS 598) — dof=3 quantiles: 0.05=7.815, 0.025=9.348, 0.01=11.345, 0.10=6.251 — https://courses.physics.illinois.edu/phys598aem/fa2014/Software/Critical_Values_of_the_Chi-Squared_Distribution.pdf
- Chi-Square Probabilities table (Richland) — confirms dof=3 critical values 6.251 / 7.815 / 9.348 / 11.345 — https://people.richland.edu/james/lecture/m170/tbl-chi.html
- Probabilistic data association filter (Wikipedia) — validation gate / ellipsoidal gating context (Bar-Shalom) — https://en.wikipedia.org/wiki/Probabilistic_data_association_filter

---

## #4 — Sequential per-sensor / information-form update

- **Feasibility (agent):** now-full

**Recommended approach.** Replace the confidence-weighted spatial averaging in `update_track` (src-tauri/src/sensor_fusion.rs, currently lines ~1493-1558) with a loop that applies EACH associated measurement SEQUENTIALLY through the active filter, each using its own R = diag(meas.covariance). The prediction step (predict_all) already ran once for this frame; the sequential updates all operate on the SAME predicted prior, conditioning on one measurement at a time — this is the standard one-at-a-time / iterated update.

WHY THIS IS CORRECT (linear-Gaussian, KF/EKF-Cartesian/UKF/IMM paths): For conditionally independent measurements z_i with z_i = H x + v_i, v_i ~ N(0, R_i), the joint likelihood factorizes, so the batch update with stacked z=[z_1;...;z_m], stacked H, and block-diagonal R=blkdiag(R_1,...,R_m) is mathematically IDENTICAL to applying the m updates sequentially (each on the posterior of the previous). In information form the posterior is x_post = (P_prior^-1 + Σ_i H^T R_i^-1 H)^-1 (P_prior^-1 x_prior + Σ_i H^T R_i^-1 z_i). Because H is the identity on the position block here, the position-marginal of the fully-updated posterior equals the inverse-variance (information) blend x̂ = (Σ_i C_i^-1)^-1 Σ_i C_i^-1 x_i with C_i = R_i, fused with the prior — exactly the optimal MLE fusion the item references. The old code instead used a SCALAR confidence weight (meas.confidence) and discarded R entirely on the KF/UKF/PF/IMM paths, so a low-noise lidar return and a high-noise acoustic return were blended by confidence rather than by their actual covariances, and the single fused update folded in only ONE R (self.kf.r / self.ukf.r / kf_cv.r) regardless of how many measurements contributed — systematically over- or under-confident.

ORDERING: For the linear-Gaussian KF/Cartesian-EKF/UKF/IMM paths the result is ORDER-INDEPENDENT (exactly, in exact arithmetic; to round-off in practice). For the nonlinear EKF polar path order matters slightly because each update re-linearizes H at the new state; process measurements in a deterministic order (sort meas_indices, e.g. by ascending trace(R_i) so the most-informative/lowest-noise measurement is applied first, which best linearizes subsequent ones). Determinism also keeps tests reproducible.

CONFIDENCE / MULTI-SENSOR BOOST: Derive AFTER all sequential updates. Keep max_confidence = max over contributing meas.confidence and the existing additive boost (sensor_sources.len()-1)*0.1 clamped to 1.0 (unchanged semantics, just computed in the same pre-pass loop). Do NOT tie track.confidence to the trace of the posterior covariance in this item — that is a larger semantic change; leave a // TODO noting posterior-covariance-based confidence as future work. sensor_sources should be the DEDUPLICATED set of modalities that actually contributed an update (built in the same loop).

EKF POLAR (radar) INTERACTION: Radar measurements are polar; only `measurement_position_polar` returns Some for Radar, and `ekf.update_polar` already takes a per-measurement R built from meas.covariance ([m², rad², rad²]). In the sequential loop, for the ExtendedKalman algorithm, dispatch PER MEASUREMENT: if measurement_position_polar(meas) is Some, call ekf.update_polar with R=diag(meas.covariance); else call kf.update with measurement_position_cartesian(meas) and r_override=diag(meas.covariance). This removes the current meas_indices.len()==1 special case and lets a radar + camera pair on the same track each update through its correct measurement model. NOTE the frame mismatch hazard: update_polar R must be in polar units while the Cartesian KF override R is in m²; both already come straight from meas.covariance which is documented (lines 73-75) to be in the same frame as the modality, so no conversion is needed — but add an assertion/comment so the global-assignment item does not accidentally route a polar covariance into the Cartesian path.

NEW r_override PLUMBING:
- UKF::update (line 667): add `r_override: Option<&DMatrix<f64>>` param; replace `let mut s = self.r.clone();` (line 693) with `let mut s = r_override.cloned().unwrap_or_else(|| self.r.clone());`. Callers build a 3x3 DMatrix from meas.covariance.
- ParticleFilter::update (line 840): add `r_override: Option<&Vector3<f64>>` (per-axis variances). Replace the isotropic `sigma2` Gaussian with a diagonal Mahalanobis likelihood: dist_sq = dx²/σx² + dy²/σy² + dz²/σz² using the override variances (fall back to self.measurement_noise on each axis when None). This fixes the PF ignoring R and makes anisotropic R (e.g. acoustic [10,10,10] vs lidar [0.1,0.1,0.1]) weight particles correctly.
- IMM::update (line 1031): add `r: Option<&Matrix3<f64>>`; use it both in the likelihood S (line 1044, currently self.kf_cv.r) AND in the two kf_cv/kf_ca.update_raw calls (lines 1087-1098) via r_override. Both models share the same R per measurement.
- KalmanFilter::update / update_raw already accept r_override — no change.

The TS bridge (src/detection/AdvancedSensorFusion.ts) needs NO change: it already constructs SensorMeasurement with per-modality covariance (lines 339, 363 [2,2,2] thermal, 396 [10,10,10] acoustic, default [1,1,1]) and useROSSensors.ts feeds them. This item is Rust-engine-only.

**Math / equations.**
- `Information-form posterior (all paths with linear H): P_post^-1 = P_prior^-1 + sum_i H^T R_i^-1 H ; P_post^-1 x_post = P_prior^-1 x_prior + sum_i H^T R_i^-1 z_i.`
- `Position-marginal optimal fusion (H = identity on position, vacuous prior): x_hat = (sum_i R_i^-1)^-1 sum_i R_i^-1 z_i ; this is the item's target x_hat = (sum C_i^-1)^-1 sum C_i^-1 x_i with C_i = R_i.`
- `Sequential = batch identity: stacked z=[z_1;..;z_m], H_stack=[H;..;H], R=blkdiag(R_1,..,R_m) gives the SAME posterior as applying KF update m times one measurement at a time (each on the previous posterior). Holds exactly for linear-Gaussian; to round-off for EKF-Cartesian/UKF; approximately for EKF-polar due to re-linearization.`
- `Per-axis particle likelihood (replaces isotropic): w_i *= exp(-0.5 * ((dx^2/var_x) + (dy^2/var_y) + (dz^2/var_z))) with var = diag(meas.covariance) override.`
- `Joseph covariance update reused per measurement: P <- (I-KH) P (I-KH)^T + K R K^T, with R the per-measurement override (already implemented in KalmanFilter::update_raw and EKF::update_polar).`

**Rust changes.**

All in src-tauri/src/sensor_fusion.rs.

1) update_track (lines ~1481-1574): Replace the fused_position averaging block (1493-1558) with a single deterministic pre-pass + sequential update loop:
   - Pre-pass over meas_indices to compute max_confidence and the deduped sensor_sources (keep existing logic, lines 1499-1509, but DROP fused_position/total_weight accumulation).
   - Build an ordered list of indices: `let mut ordered: Vec<usize> = meas_indices.to_vec(); ordered.sort_by(|&a,&b| trace_r(&measurements[a]).partial_cmp(&trace_r(&measurements[b])).unwrap_or(Equal));` where trace_r sums meas.covariance. (Ascending: lowest-noise first.)
   - For each idx in `ordered`, build `let r = Matrix3::from_diagonal(&Vector3::new(c[0],c[1],c[2]))` from meas.covariance and dispatch on self.config.algorithm:
       Kalman => self.kf.update(track, &measurement_position_cartesian(meas), Some(&r));
       ExtendedKalman => if let Some(polar)=measurement_position_polar(meas) { self.ekf.update_polar(track,&polar,&r) } else { self.kf.update(track,&measurement_position_cartesian(meas),Some(&r)) };
       UnscentedKalman => { let r_dyn = DMatrix::from_diagonal(&DVector::from_vec(vec![c[0],c[1],c[2]])); self.ukf.update(&mut track.state,&mut track.covariance,&measurement_position_cartesian(meas),Some(&r_dyn)); }
       Particle => pf.update(&measurement_position_cartesian(meas), Some(&Vector3::new(c[0],c[1],c[2]))); then pf.resample() ONCE after the loop (resampling per-measurement is wasteful and degrades the particle set; keep a single resample + get_estimate after all updates).
       IMM => imm.update(&measurement_position_cartesian(meas), Some(&r)); then get_estimate ONCE after the loop.
   - NOTE the borrow: `track` is `&mut` from self.tracks; the PF/IMM filters live in self.particle_filters/self.imm_filters keyed by track_id. The current code already updates track.state/covariance from pf/imm get_estimate at the end — preserve that structure but move get_estimate/resample out of the per-measurement loop to keep the &mut self borrows non-overlapping (you cannot hold `track: &mut` from self.tracks and `pf: &mut` from self.particle_filters simultaneously if both borrow self mutably — they don't, they are disjoint fields, but get_mut on each must be sequenced; keep the same pattern as today where the match arm scopes each get_mut).
   - After the loop: keep track.sensor_sources/last_update_ms/age/missed_detections updates (1561-1564), the boost (1566-1568), and confirmation (1571-1573) unchanged.

2) UKF::update (line 667-745): add `r_override: Option<&DMatrix<f64>>`; line 693 becomes `let mut s = r_override.cloned().unwrap_or_else(|| self.r.clone());`.

3) ParticleFilter::update (line 840-868): add `r_override: Option<&Vector3<f64>>`; replace lines 841-852 with per-axis variances v = r_override.copied().unwrap_or(Vector3::new(mn,mn,mn)) where mn=self.measurement_noise (guard each axis >0, finite, else 1.0); likelihood = exp(-0.5*(dx*dx/v[0] + dy*dy/v[1] + dz*dz/v[2])).

4) IMMFilter::update (line 1031-1099): add `r: Option<&Matrix3<f64>>`; line 1044 use `let rr = r.unwrap_or(&self.kf_cv.r); let s = h*cov*h.transpose()+rr;` and pass `Some(rr)` (or the owned matrix) as r_override to both update_raw calls (1087-1098).

5) Add a private helper near update_track: `fn trace_r(m:&SensorMeasurement)->f64 { m.covariance.iter().sum() }`.

6) Imports: DMatrix/DVector already imported (used by UKF). No new crates — satisfies deny.toml supply-chain policy.

Update the two existing direct callers if any are outside the engine: grep shows ukf.update only called at line 1539 (replaced) and in tests; imm.update at 1552 (replaced) and tests; pf.update at 1543 (replaced) and tests. Update test call sites to pass None to preserve old behavior, OR pass explicit R in new tests below.

**Test cases.**
- test_sequential_update_equals_information_form: KF path. Predict a track to prior x0 with P0=I*100 (near-vacuous prior). Feed two Cartesian Visual measurements at same timestamp: z1=[10,0,0] R1=diag(1,1,1), z2=[12,0,0] R2=diag(9,9,9). Assert posterior x≈ inverse-variance blend ~ (10/1+12/9)/(1/1+1/9) along x within 1e-6 after accounting for the (large) prior, and that the result is the SAME whether measurements are passed [z1,z2] or [z2,z1] (order independence) within 1e-9.
- test_sequential_update_order_independent_kf: same two measurements, two orderings via process_measurements with reversed Vec; assert identical track.state and track.covariance within 1e-9 (KF/Cartesian path).
- test_per_measurement_R_respected_kf: single low-noise lidar z=[5,0,0] R=diag(0.01,0.01,0.01) vs single high-noise acoustic z=[5,0,0] R=diag(10,10,10) on identical priors; assert the lidar case collapses P[0,0] far more than the acoustic case (posterior trace strictly smaller), proving R is used (old averaging used a fixed self.kf.r and would give equal results).
- test_ukf_r_override_used: call UnscentedKalmanFilter::update with Some(diag(0.01,0.01,0.01)) vs None (self.r from measurement_noise=2.0); assert the override yields a tighter posterior covariance trace.
- test_particle_filter_anisotropic_r: initialize PF, call update with r_override=Some([0.01, 100.0, 0.01]); assert weights are dominated by x/z agreement and nearly insensitive to y mismatch (a particle offset only in y keeps high weight; offset in x collapses). Confirms diagonal Mahalanobis likelihood replaced isotropic sigma.
- test_imm_per_measurement_r: IMM::update with Some(diag(0.5,0.5,0.5)); assert combined estimate moves toward measurement and that passing a much larger R moves it less (R reaches both the likelihood and the update_raw gain).
- test_radar_plus_camera_same_track_sequential: ExtendedKalman algorithm. Confirm a track, then in ONE frame feed a Radar polar meas (covariance [1,0.01,0.01]) AND a Visual Cartesian meas of the same target; assert both update the track (no panic, removes the old meas_indices.len()==1 restriction), polar path used for radar (state pulled toward polar-implied position), and final state is a sensible fusion of both.
- test_multi_sensor_confidence_boost_after_fusion: two modalities (Visual+Lidar) on one track; assert track.confidence == min(max(conf_i)+0.1, 1.0) and sensor_sources deduped to exactly [Visual,Lidar] (order of first appearance).
- Regression: existing test_polar_measurement_integration (line 2077) and radar_measurement_creates_cartesian_track_from_polar_input (line 2104) must still pass unchanged.
- Regression: existing coasting test (line ~2040) must still pass (lifecycle untouched).

**Risks.**
- Ordering dependency / CONFLICT with the global-assignment item (#6, Hungarian/auction): that item changes associate_measurements so a track may receive a DIFFERENT set of meas_indices (and 1-best vs multi). This item assumes meas_indices may contain >1 measurement and processes all of them. They edit the SAME function boundary (associate -> update_track). Coordinate: global-assignment decides WHICH measurements map to a track; this item decides HOW multiple mapped measurements are fused. Keep update_track's signature (track_id, measurements, meas_indices, ts) stable so item #6 only changes the producer of meas_indices, not the consumer.
- CONFLICT with chi2-gating item (#3): #3 recalibrates association_threshold to a chi-square quantile and may compute per-measurement gating distances using S=HPH^T+R_i. Both items read meas.covariance as R_i — ensure ONE shared helper builds R=diag(meas.covariance) (and the polar-vs-Cartesian frame check) so gating and update agree on R. If #3 introduces a gate that rejects some of a track's candidate measurements, the surviving subset is what this item fuses — fine, but the two must share the R-construction code to avoid drift.
- EKF polar re-linearization: sequential polar updates re-linearize H at each intermediate state; with a poor prior the first update can swing the state and degrade later Jacobians. Mitigated by lowest-trace-R-first ordering. Multiple polar (radar) measurements on one track in a single frame is the worst case — acceptable for now; flag for the OOSM item (#9) which may reorder by timestamp instead of by R.
- Particle filter likelihood change alters resampling cadence: switching from isotropic sigma to per-axis variances changes weight magnitudes; with very small R the weights can collapse (near-zero sum) more easily — the existing weight_sum>1e-10 uniform-reset guard (line 857) covers this, but verify N_eff/resample threshold still triggers sanely. Moving resample to once-per-frame (not per-measurement) is a behavior change that must be reflected in any PF test asserting particle counts.
- IMM kf_cv.r and kf_ca.r are constructed from the SAME measurement_noise; passing per-measurement R to both models is correct (both observe the same z with the same R), but if the IMM motion-models item (#7, CV+CT) changes model count from 2 to 3, the r-threading loop over models must not hardcode index 0/1 — write it as a loop. Coordinate array sizing with #7.
- Numerical: sequential updates accumulate Joseph-form covariance updates; for many measurements per frame this is more matrix products than the old single update. With H=identity on position this is cheap (3x3 inversions), and MAX_FUSION_TRACKS=1024 caps total cost. No perf concern at expected sensor counts.
- track.confidence still NOT derived from posterior covariance (kept as max-confidence + boost). This is intentional scope-limiting but means a track fused from many low-noise sensors does not get a higher confidence than its best single detection — note as future work so a reviewer does not flag it as an omission.

**Depends on:** #6 Global nearest-neighbour assignment: produces the meas_indices this item consumes; share update_track signature., #3 Chi-square association gating: must share the R=diag(meas.covariance) construction helper and the polar/Cartesian frame distinction., #7 CV+CT IMM models: r-threading must loop over models, not hardcode 2., #9 OOSM / per-measurement timestamps: may override the lowest-R-first ordering with timestamp ordering.

**Citations.**
- Kalman filter — Wikipedia (states multiple update procedures may be performed when independent observations are available at the same time; lists the information filter form) — https://en.wikipedia.org/wiki/Kalman_filter
- Sensor fusion — Wikipedia (inverse-variance / information-form fusion: x3 = sigma3^2 (sigma1^-2 x1 + sigma2^-2 x2), sigma3^2 = (sigma1^-2 + sigma2^-2)^-1) — https://en.wikipedia.org/wiki/Sensor_fusion
- Covariance intersection — Wikipedia (conventional optimal Kalman update is valid only when cross-correlation is known/zero; contrast for the linear-Gaussian assumption used here) — https://en.wikipedia.org/wiki/Covariance_intersection

---

## #5 — Sliding-window M-of-N confirmation

- **Feasibility (agent):** now-full

**Recommended approach.** Replace the monotonic age-based confirmation and consecutive-miss deletion with a true sliding-window M-of-N rule plus a covariance-volume deletion guard. Store the last N association opportunities per track as a u32 bitmask (`hit_history: u32`, bit0 = most recent frame: 1=hit, 0=miss) — dependency-free, Copy, trivially serde-friendly, and N<=32 is far more than needed. This is preferred over VecDeque<bool> (heap alloc per track, 1024 tracks) and matches the textbook "M plots in the last N updates" definition.

Window update must happen exactly ONCE per track per frame, AFTER association is known and BEFORE confirm/delete decisions. The cleanest seam is a new Step 4.5 in process_measurements (sensor_fusion.rs ~line 1350-1364) that runs over ALL tracks: shift each track's bitmask left by 1, mask to N bits, and OR in 1 if the track was associated this frame. Determine "associated this frame" the same way handle_missed_detections already does: `track.last_update_ms == timestamp_ms` (update_track sets last_update_ms = timestamp_ms and create_track sets it to the creation timestamp). This reuses the existing, already-documented invariant and avoids threading the associations map around.

Keep `age` and `missed_detections` as-is (age still increments on hit in update_track; missed_detections still tracks the CONSECUTIVE-miss count) so TrackOutput.age and the TS bridge are unchanged. The M-of-N window drives state transitions; missed_detections is retained only for Coasting (which is intentionally a consecutive-miss concept: a track that is being predicted forward right now), and age is retained as a display/telemetry field. This keeps the change minimal and the public TrackOutput/FusionConfig serde contract backward compatible except for the two new optional config fields.

Confirm: Tentative -> Confirmed when popcount(hit_history & N_mask) >= M. Delete (Lost): when popcount of MISSES in the window >= max_missed_detections-equivalent M-of-N miss count, OR when the position-covariance volume exceeds a limit. Coasting stays keyed on consecutive missed_detections >= 2 (unchanged semantics).

Defaults: confirm 3-of-5 (M_confirm=3, N=5), the textbook radar value; delete on 4-of-5 misses (i.e. <=1 hit in last 5) which is slightly more forgiving than the current 5-consecutive default but evidence-based; covariance-volume limit = position-block determinant > 1e6 (sigma ~100 m per axis as a sanity ceiling, well above any realistic track). Map M_confirm onto the existing min_confirmation_hits field (reused as M), and add two new FusionConfig fields with serde defaults so old configs deserialize: confirmation_window: u32 (=N, default 5) and max_position_cov_volume: f64 (default 1e6). The miss-delete count maps onto existing max_missed_detections but reinterpreted as "misses within the window" (default kept at 5, clamped to N).

**Rust changes.**

FILE: src-tauri/src/sensor_fusion.rs

1) TrackState struct (~line 158-180): add field after `missed_detections: u32,`:
   `/// Bitmask of the last N association opportunities (bit0 = most recent frame; 1=hit, 0=miss). Drives sliding-window M-of-N confirmation/deletion.`
   `pub hit_history: u32,`
   Keep `age` and `missed_detections`.

2) FusionConfig struct (~line 1141-1149): add two fields:
   `#[serde(default = "default_confirmation_window")] pub confirmation_window: u32,` (= N)
   `#[serde(default = "default_max_position_cov_volume")] pub max_position_cov_volume: f64,`
   Add free fns:
   `fn default_confirmation_window() -> u32 { 5 }`
   `fn default_max_position_cov_volume() -> f64 { 1e6 }`
   The #[serde(default)] attributes make pre-existing serialized configs (without these keys) deserialize cleanly — required because lib.rs fusion_init receives configs from the TS bridge.

3) impl Default for FusionConfig (~line 1151-1163): add `confirmation_window: 5,` and `max_position_cov_volume: 1e6,`. Keep min_confirmation_hits: 3 (now read as M) and max_missed_detections: 5 (now read as window-miss count).

4) Add constants near line 25-26:
   `const MAX_CONFIRMATION_WINDOW: u32 = 32;` (bitmask is u32)
   `const MIN_CONFIRMATION_WINDOW: u32 = 1;`

5) validate_fusion_config (~line 1202-1239): add checks:
   - confirmation_window within [1, 32].
   - min_confirmation_hits (M) <= confirmation_window (N) — reject otherwise ("min_confirmation_hits must be <= confirmation_window"). The existing [1, MAX_CONFIRMATION_HITS] check stays but the upper bound is now effectively N.
   - max_missed_detections <= confirmation_window (miss count cannot exceed window) OR clamp it in code; recommend rejecting for explicitness.
   - validate_finite_range("max_position_cov_volume", value, f64::EPSILON, f64::MAX) — must be finite and positive.

6) create_track (~line 1603-1614): initialize `hit_history: 1,` (the creation frame is a hit, bit0 set). Keep age:1, missed_detections:0, state_label: Tentative.

7) NEW method `fn update_hit_history(&mut self, timestamp_ms: u64)` called as Step 4.5 in process_measurements, inserted between the create_track loop (line 1361) and handle_missed_detections (line 1364):
   ```
   let n_mask: u32 = (1u32 << self.config.confirmation_window) - 1; // N low bits
   for track in self.tracks.values_mut() {
       if track.state_label == TrackStateLabel::Lost { continue; }
       let hit = track.last_update_ms == timestamp_ms;
       track.hit_history = ((track.hit_history << 1) | (hit as u32)) & n_mask;
   }
   ```
   Note: create_track already set last_update_ms == timestamp_ms for tracks born this frame, so they correctly register a hit; their initial bitmask=1 then shifts to ...11 — acceptable (still one hit credited). To avoid double-counting the birth frame, alternatively init hit_history:0 in create_track and let Step 4.5 set bit0 — RECOMMENDED: init 0, let the window update be the single source of truth. (Pick one and state it in the doc; spec recommends init 0.)

8) update_track (~line 1570-1573): REMOVE `if track.age >= self.config.min_confirmation_hits { Confirmed }`. Confirmation now happens in handle_missed_detections (renamed conceptually to lifecycle update) after the window is current, so all tracks are evaluated uniformly. Keep `track.age += 1;` and `track.missed_detections = 0;`.

9) handle_missed_detections (~line 1639-1670): becomes the unified lifecycle pass. Add helper:
   `fn position_cov_volume(track: &TrackState) -> f64` returning the 3x3 position-block determinant:
   ```
   let p = Matrix3::new(c[(0,0)],c[(0,1)],c[(0,2)], c[(1,0)],c[(1,1)],c[(1,2)], c[(2,0)],c[(2,1)],c[(2,2)]);
   p.determinant().max(0.0)
   ```
   (Reuse the same 3x3 extraction pattern already in associate_measurements ~line 1425-1435; det() on Matrix3 exists — confirmed by existing s.determinant() calls at lines 377/492/1048.)
   New logic per live track:
   ```
   let n = self.config.confirmation_window;
   let n_mask = (1u32 << n) - 1;
   let hits = (track.hit_history & n_mask).count_ones();
   let misses = n - hits; // opportunities = N once window full; for young tracks count_zeros over filled bits
   // consecutive miss bookkeeping unchanged:
   if track.last_update_ms != timestamp_ms { track.missed_detections += 1; }
   // DELETE conditions:
   let cov_volume = Self::position_cov_volume(track);
   if misses >= self.config.max_missed_detections || cov_volume > self.config.max_position_cov_volume {
       track.state_label = TrackStateLabel::Lost; tracks_to_remove.push(...); continue;
   }
   // CONFIRM:
   if hits >= self.config.min_confirmation_hits { track.state_label = TrackStateLabel::Confirmed; }
   else if track.missed_detections >= 2 { track.state_label = TrackStateLabel::Coasting; }
   ```
   IMPORTANT ordering subtlety for young tracks: with init hit_history:0 + Step4.5, after frame1 a freshly created track has hit_history=0b1 (1 bit). Define `misses` over only the FILLED slots, or simpler: count misses as `max_missed_detections` consecutive only when the window has been observed long enough. RECOMMENDED concrete rule: misses_in_window = (the count of 0-bits within the min(frames_seen, N) low bits). Track frames_seen via existing `age + missed_detections` (total opportunities) — no new field needed: opportunities = age + missed_detections, window_fill = opportunities.min(N). misses_in_window = window_fill - hits. This prevents a brand-new track from being deleted on frame 1 because of unfilled (zero) high bits.

10) The three TrackState literal constructions that must add `hit_history`:
    - create_track (line 1603) — set per item 6/7.
    - test_kalman_filter_predict (line 1790) — add `hit_history: 0b111,` (Confirmed-looking).
    - test_polar_measurement_integration (line 2080) — add `hit_history: 0b111,`.
    grep confirms these are the ONLY `TrackState {` literals (struct def at 159 excluded).

FILE: src/detection/AdvancedSensorFusion.ts
11) FusionConfig interface (~line 98-106): add `confirmation_window: number` and `max_position_cov_volume: number`.
12) initFusion defaults (~line 247-255): add `confirmation_window: config.confirmation_window ?? 5,` and `max_position_cov_volume: config.max_position_cov_volume ?? 1e6,`.
    TrackOutput / FusedTrack / normalizeTrack are UNCHANGED (hit_history is engine-internal, not exposed on TrackOutput) — keep it that way to minimize the bridge surface.

FILE: src-tauri/src/lib.rs
13) test_fusion_config() helper (line 911) uses FusionConfig::default() — no change needed (new fields have defaults).

FILE: docs/SENSOR_FUSION.md
14) Update Track lifecycle section (~line 304-339): replace the age>=3 transitions with M-of-N (3-of-5) confirm, M-of-N miss + covariance-volume delete; remove the "Implementation note" that calls M-of-N a known simplification; update the config table (~line 428-430) to add confirmation_window and max_position_cov_volume rows; update roadmap-limitations row #4 (~line 483).

**Test cases.**
- MIGRATE test_multi_frame_track_lifecycle (line 1906): default M=3,N=5. Frame1 -> Tentative (hits_in_window=1). Frame2 -> still Tentative, assert tracks[0].age==2 (age field retained, unchanged assertion passes). Frame3 -> 3 consecutive hits => hits_in_window=3>=M => assert Confirmed. Net: the three existing assertions (Tentative@f1, age==2@f2, Confirmed@f3) ALL still hold under 3-of-5 because three consecutive hits trivially satisfy M-of-N. No edit needed beyond confirming it still passes.
- MIGRATE test_stale_track_cleanup (line 2013): config max_missed_detections=3 (now = misses-in-window to delete), confirmation_window default 5. 1 hit then 3 misses. After 3 misses window=0b1000 over 4 filled slots => hits=1, misses_in_window=3>=3 => Lost+removed => assert tracks.is_empty() still holds. Verify the window-fill logic (opportunities=4, fill=4) so misses counts to 3 on the 3rd empty frame, matching the old consecutive-3 behavior in this scenario.
- MIGRATE test_track_coasting_state (line 2046): config max_missed_detections=5. Confirm over 3 hits, then 2 misses. After 2 misses missed_detections==2 and misses_in_window=2<5 => assert Coasting still holds. Coasting still keys on consecutive missed_detections>=2 — unchanged.
- ADD test_m_of_n_confirms_with_intermittent_hits: M=3,N=5. Feed hit, miss, hit, miss, hit (interleaved over 5 frames, same target position within gate, empty meas on miss frames). After frame 5 hits_in_window=3 => assert Confirmed. Proves the NEW behavior the old monotonic rule could not satisfy (old age would only be 3 after 3 hits but would also have promoted; the discriminating case is the next test).
- ADD test_intermittent_track_not_deleted_prematurely: M=3,N=5,max_missed_detections=4. Pattern hit,miss,hit,miss,hit,miss over 6 frames. Misses-in-window never reaches 4, hits reach 3 => assert track survives and is Confirmed (would be fine under old logic too, but verifies misses-in-window counting over the sliding window, not consecutive).
- ADD test_m_of_n_deletes_on_window_misses: M=3,N=5,max_missed_detections=4. One hit then 4 misses (window 0b10000 over 5 slots, hits=1, misses=4>=4) => assert removed. Compare to a 3-miss case where it survives (misses=3<4) => still present as Coasting.
- ADD test_covariance_volume_deletion: set max_position_cov_volume to a small value (e.g. 50.0). Create one track, then process empty frames so predict_all inflates the covariance each frame; assert the track is deleted (tracks empty) once position-block det exceeds 50.0, and that it is removed via the Lost path. Use FusionConfig{ max_position_cov_volume: 50.0, max_missed_detections: 100, ..default } so the deletion is attributable to covariance volume, not miss count.
- ADD test_covariance_volume_does_not_delete_tight_track: default max_position_cov_volume=1e6; a well-observed track over 5 confirming frames must NOT be deleted (det stays small). Assert still present and Confirmed.
- ADD validation test fusion_init_rejects_window_smaller_than_confirm_hits: min_confirmation_hits=6, confirmation_window=5 => validate_fusion_config returns Err containing 'confirmation_window'. Mirror the existing pattern in lib.rs fusion_init_rejects_invalid_config_before_engine_creation (line 930).
- ADD validation test rejects confirmation_window>32 and rejects non-positive/NaN max_position_cov_volume.
- ADD serde back-compat test: deserialize a FusionConfig JSON literal WITHOUT confirmation_window/max_position_cov_volume keys and assert it succeeds with defaults 5 and 1e6 (guards the #[serde(default=...)] attributes).

**Risks.**
- ORDERING/CONFLICT with item #3 (chi-square calibrated gating) and #6 (Hungarian/GNN assignment): both rewrite associate_measurements and how 'associated this frame' is determined. This item deliberately determines hit/miss via the existing `track.last_update_ms == timestamp_ms` invariant rather than the associations map, so it is decoupled from how association is computed — but if #6 changes update_track to NOT set last_update_ms (e.g. batch assignment writing elsewhere), the window update breaks. MITIGATION: in the coordinated pass, keep update_track/create_track setting last_update_ms=timestamp_ms, or have #6 expose an explicit per-frame associated-track-id set that Step 4.5 consumes. Flag to the #6 implementer.
- ORDERING/CONFLICT with item #4 (sequential per-sensor information-form update): #4 rewrites the body of update_track. The ONLY lines this item touches in update_track are the removal of the age>=min_confirmation_hits confirmation block (lines 1571-1573) and retaining `track.age += 1; track.missed_detections = 0;`. Coordinate so #4 preserves those two bookkeeping lines and does not re-add confirmation logic inside update_track (confirmation moves to handle_missed_detections).
- CONFLICT with item #2 (threat-level) and item #10 (docs): docs/SENSOR_FUSION.md lifecycle section is edited here; #2 edits the threat section of the same doc. Non-overlapping sections, but both touch the config table — coordinate the single config-table edit.
- Young-track edge case: if hit_history high bits (representing not-yet-observed frames) are counted as misses, a brand-new track could be deleted on frame 1. MITIGATION (in spec item 9): count misses only over min(opportunities, N) filled slots using opportunities = age + missed_detections; add the test_covariance/test_stale cases to lock this in. This is the single most error-prone part of the implementation.
- Double-counting the birth frame: create_track sets last_update_ms=timestamp_ms, and Step 4.5 also runs that frame. Spec resolves by initializing hit_history:0 in create_track and letting Step 4.5 be the sole writer. If the implementer instead inits hit_history:1, the birth frame is counted twice (shifted to 0b11), inflating early hit counts — pick init 0.
- max_missed_detections semantics change: it now means 'misses within the N-window' rather than 'consecutive misses'. For the existing tests these coincide (purely consecutive miss patterns), but operators with tuned configs will see slightly different deletion timing. Document the reinterpretation in SENSOR_FUSION.md config table; default value unchanged (5, clamped to N=5).
- Covariance-volume metric choice: determinant of the 3x3 position block is scale^6 in meters^6 and can underflow/overflow; det is clamped with .max(0.0) to avoid NaN from numerical drift (mirrors the existing TrackOutput sqrt guard at lines 209-215). Default 1e6 m^6 == ~100 m per-axis sigma; if axes are correlated the det can be tiny even with large variances — acceptable as a sanity ceiling, but note trace (sum of the three position variances) is an alternative that is monotonic and harder to fool. Spec chooses det per the prompt's primary suggestion; trace is a one-line swap if preferred.
- Bitmask width: confirmation_window is hard-capped at 32 (u32). Validation must reject larger N; otherwise (1u32 << 32) is UB/overflow in Rust (panics in debug). Use checked shift or cap at 32 and rely on validate_fusion_config running before engine construction (it does, via fusion_init in lib.rs).

**Citations.**
- Radar tracker - track confirmation (M-of-N, M=3/N=5) and deletion (M-of-N misses, covariance grown beyond threshold) — https://en.wikipedia.org/wiki/Radar_tracker
- Track algorithm - tentative/confirmed track states and M-of-N confirmation — https://en.wikipedia.org/wiki/Track_algorithm
- CREBAIN sensor fusion design doc - existing track lifecycle and documented M-of-N roadmap limitation — [`docs/SENSOR_FUSION.md`](../SENSOR_FUSION.md)

---

## #6 — Global nearest-neighbour assignment

- **Feasibility (agent):** now-full

**Recommended approach.** Replace the greedy loop in `associate_measurements` (sensor_fusion.rs lines 1403-1479) with a global one-to-one assignment solved by a dependency-free rectangular Hungarian (Kuhn-Munkres, O(n^3) potentials/augmenting-path variant). DO NOT add a crate: the well-audited candidates (`pathfinding`, `hungarian`, `lapjv`) pull in extra trees and conflict with the supply-chain posture in src-tauri/deny.toml; a self-contained ~60-line solver over an integer cost matrix is small and fully testable.

CRITICAL design decision on multi-sensor fusion: do NOT make the assignment "measurement-to-track allowing duplicates" — that is just greedy again and reintroduces the order/coalescing problem. Instead CLUSTER same-target measurements first, then assign one cluster to at most one track. Concretely:
  Phase A (cluster): group the frame's measurements into measurement-clusters where members are mutually gateable and (recommended) share class_label. Cheap union-find over pairwise position gates. Each cluster represents "one physical target this frame, seen by N sensors."
  Phase B (assign): build a rectangular cost matrix rows=tracks (non-Lost), cols=clusters, entry = min over the cluster's members of the squared Mahalanobis distance d^2(track, meas) (NOT averaged — use the best-fitting member so a precise lidar return is not diluted by a coarse acoustic one), with out-of-gate -> +inf (sentinel). Solve Hungarian for the optimal one-to-one track<->cluster matching.
  Phase C (emit): for each matched (track, cluster) whose cost is finite/in-gate, emit `associations[track_id] = cluster.member_indices` (the EXISTING `HashMap<String, Vec<usize>>` shape, so update_track at 1481 still receives all N measurements for that target and the multi-sensor confidence boost path is unchanged). Unmatched clusters -> `unassociated` (new tracks). Unmatched tracks -> no update (coast). This satisfies "one measurement reaches exactly one track, but a target seen by N sensors delivers all N measurements to its track."

Keep the change confined to `associate_measurements` plus one private free function `solve_assignment` and one private `cluster_measurements`. The public signature `(&self, &[SensorMeasurement]) -> (HashMap<String, Vec<usize>>, Vec<usize>)` is preserved, so process_measurements (1347-1361) and update_track are untouched — minimal blast radius.

Recommendation summary asked for in the prompt: choose Hungarian over Bertsekas auction (auction needs epsilon-scaling tuning to terminate cleanly and is fiddly to get bit-exact/deterministic; Hungarian is deterministic and the matrix form is ~60 lines). Choose CLUSTER-FIRST over allow-duplicates-per-track, because duplicates-per-track is order-dependent and produces the very coalescing GNN is meant to remove.

**Math / equations.**
- `Squared Mahalanobis distance for cost matrix entry: d2(track r, meas m) = (z_m - x_r)^T S^{-1} (z_m - x_r), where x_r = track position [x,y,z], z_m = measurement_position_cartesian(m), and S = H P H^T + R = pos_cov(r) + diag(R_m) (H is identity on the position block). Reuses existing innovation_cov at line 1448.`
- `Singular-S fallback (existing line 1459, squared form): d2 = (||z_m - x_r|| / NOMINAL_ASSOCIATION_SIGMA_M)^2, NOMINAL_ASSOCIATION_SIGMA_M = 1.0.`
- `Gate predicate kept for this item: in-gate iff sqrt(d2) < association_threshold (default 10.0). Out-of-gate -> cost sentinel INF.`
- `Cluster pair gate (symmetric, summed covariance): d2_ij = (p_i - p_j)^T (diag(R_i) + diag(R_j))^{-1} (p_i - p_j) <= MEAS_CLUSTER_GATE. MEAS_CLUSTER_GATE = 11.345 = chi^2 inverse CDF at p=0.99 with 3 dof (3D position). This is the standard chi-square gating quantile (Mahalanobis distance / Bar-Shalom gating).`
- `Integer quantization for exact Hungarian: c_rc = round(d2 * 1000) as i64 for in-gate; INF = i64::MAX/4 for out-of-gate (avoids overflow when potentials u[i]+v[j] accumulate).`
- `Hungarian objective: minimize sum_r cost[r, assign(r)] subject to one-to-one (each row <= one col, each col <= one row). Optimality vs greedy: greedy minimizes each row independently and can be arbitrarily worse; Hungarian is globally optimal (this is the GNN definition).`
- `Rectangular handling: pad to square by treating missing rows/cols as the implicit unassigned outcome; rows>cols => transpose then solve so internal matrix has rows<=cols; assignments landing on INF cells are reported as None (track coasts / cluster initiates a new track).`

**Rust changes.**

FILE: src-tauri/src/sensor_fusion.rs

1) ADD a deterministic ordering helper. The current code iterates `&self.tracks` (a HashMap) in nondeterministic order — that order-dependence is part of the bug. Collect tracks into a Vec sorted by id (`let mut track_ids: Vec<&String> = self.tracks.keys().filter(|id| self.tracks[*id].state_label != TrackStateLabel::Lost).collect(); track_ids.sort();`). Index tracks by row position.

2) REWRITE `associate_measurements` (replace lines 1403-1479). Pseudocode:
   - Build `track_ids` (sorted, non-Lost) as above. If empty -> all measurements unassociated, return early.
   - Phase A clustering: `cluster_measurements(measurements)` -> `Vec<Vec<usize>>`. Use union-find: for each unordered pair (i,j), join if same class_label AND euclidean ||pos_i - pos_j|| within a fusion radius. Recommend gating the pair with a symmetric Mahalanobis-style test using R_i+R_j: d2_ij = diff^T (R_i+R_j)^{-1} diff <= GATE_CHI2_3DOF. To stay decoupled from item #3 this session, add `const MEAS_CLUSTER_GATE: f64 = 11.345;` (chi2 0.99 quantile, 3 dof) — see math.
   - Phase B cost matrix: rows R = track_ids.len(), cols C = clusters.len(). `cost[r][c]` = min over members m in cluster c of squared Mahalanobis d2(track r, meas m), reusing the EXISTING gate math at lines 1422-1460 (S = pos_cov + R_m; d2 = diff^T S^{-1} diff; singular fallback (||diff||/NOMINAL_ASSOCIATION_SIGMA_M)^2). NOTE: the existing code gates on non-squared d < association_threshold (10.0). Keep that exact gate semantics for THIS item: out-of-gate iff sqrt(d2) >= association_threshold -> set entry to sentinel. (Item #3 will later swap the predicate to d2 vs chi2 — see conflict note.)
   - Quantize to i64 for an integer Hungarian: `let q = (d2 * 1000.0).round() as i64` for in-gate, and `const INF: i64 = i64::MAX / 4;` for out-of-gate (divide to avoid overflow when potentials add). Integer costs make the solver exact and avoid float-equality bugs in the potential updates.
   - Call `solve_assignment(&cost, INF)` -> `Vec<Option<usize>>` (length R, each Some(col) or None).
   - Phase C: for each row r with Some(c) AND cost[r][c] < INF: `associations.entry(track_ids[r].clone()).or_default().extend(clusters[c].iter().copied())`. Track every assigned cluster index. Any cluster not assigned (or assigned to a row whose cost was INF) -> push all its member indices into `unassociated`.

3) ADD private fn `solve_assignment(cost: &[Vec<i64>], inf: i64) -> Vec<Option<usize>>`. Use the O(n^3) potentials/augmenting-path Kuhn-Munkres on an n x m matrix internally padded so rows<=cols (if rows>cols, transpose, solve, untranspose the result mapping). Standard `u`, `v`, `p`, `way` arrays with a Dijkstra-like inner loop using `minv`/`used`. After solving on the (possibly padded) square-or-wide matrix, map col->row, drop any pair whose underlying entry == inf by returning None for that row. This is the e-maxx/cp-algorithms form (deterministic, integer, ~60 lines). Keep it a free fn (no &self) so it is unit-testable in isolation.

4) ADD `const MEAS_CLUSTER_GATE: f64 = 11.345;` near line 30 (next to NOMINAL_ASSOCIATION_SIGMA_M). Document it.

NO changes to: SensorMeasurement, TrackState, FusionConfig, update_track, create_track, handle_missed_detections, process_measurements. The HashMap<String, Vec<usize>> contract is preserved end-to-end. No TS changes (the bridge src/detection/AdvancedSensorFusion.ts and src/ros/useROSSensors.ts only exchange SensorMeasurement/TrackOutput which are unchanged).

**TS changes.**

None. The Rust public API (process_measurements, TrackOutput, SensorMeasurement, FusionConfig) is unchanged, so src/detection/AdvancedSensorFusion.ts and src/ros/useROSSensors.ts need no edits. The browser-only engine src/detection/SensorFusion.ts is a separate code path and is out of scope for this item.

**Test cases.**
- solve_assignment_square_optimal: 3x3 integer cost where greedy row-min would mis-pick; assert the solver returns the known minimum-total-cost permutation (e.g. cost [[1,2,3],[2,4,6],[3,6,9]] -> assignment 0->0? use a matrix with a clear non-greedy optimum like [[4,1,3],[2,0,5],[3,2,2]] optimum cols [1,0,2] = 1+2+2). 
- solve_assignment_more_cols_than_rows (2 tracks, 3 clusters): every row gets a distinct col, exactly one col left unassigned; assert no col used twice.
- solve_assignment_more_rows_than_cols (3 tracks, 2 clusters): exactly one row returns None; the two assigned rows pick the two lowest-cost feasible cols.
- solve_assignment_inf_blocks_pair: a row whose only finite entry is INF returns None and is NOT force-matched into an out-of-gate cell.
- gnn_resolves_crossing_targets: two confirmed tracks A=(0,0,0) B=(10,0,0); two measurements near-swapped m1=(9.5,0,0) m2=(0.5,0,0). Greedy in HashMap order can give both to one track; assert GNN yields A<-m2, B<-m1 (one meas each) and track count stays 2 (regression for the order-dependent steal).
- gnn_one_measurement_one_track_no_duplicate: one track, two DISTINCT-target measurements far apart but both gated to the track via a loose threshold; assert only ONE is associated and the other spawns a new track (forbids many-to-one of different targets).
- multi_sensor_cluster_still_fuses: one track, two SAME-target measurements (visual (10,0,5) + thermal (10.4,0.4,5), same class_label) within fusion radius; assert clustering groups them, both indices reach update_track for the one track, sensor_sources.len()==2 and the multi-sensor confidence boost still fires (regression that GNN did NOT break legitimate N-sensors-to-1-target).
- deterministic_assignment_repeatability: run the same crossing-target frame 50 times (or with shuffled measurement/track insertion order) and assert identical association result every time (proves HashMap-order nondeterminism is gone).
- empty_inputs: zero tracks -> all measurements unassociated; zero measurements -> empty associations, no panic.
- max_track_limit_unaffected: re-run existing test_fusion_max_track_limit semantics (MAX_FUSION_TRACKS) with GNN path to confirm Step-4 cap still holds.

**Risks.**
- See ordering notes in dependencies_on_other_items.

**Depends on:** Item #3 (chi2 calibrated gating): CONFLICT — both touch the gate predicate inside the association step (lines 1456-1465). Resolution/ordering: factor the per-(track,meas) distance+gate into ONE shared helper `fn gated_sq_mahalanobis(track, meas) -> Option<f64>` (Some(d2) if in-gate, None if out). Item #6 builds the cost matrix from it; item #3 sets the gate threshold inside it (swap `sqrt(d2) < association_threshold` for `d2 < chi2_quantile(3dof, p_gate)`). If both land this pass, implement the shared helper FIRST, then #6 consumes it. The squared-Mahalanobis cost the Hungarian needs is exactly the d2 #3 computes — they compose cleanly., Item #4 (sequential per-sensor information-form update): NO conflict with assignment math, but interacts in update_track. #6 deliberately keeps the HashMap<String, Vec<usize>> output so update_track still gets all clustered measurements. #4 will replace the confidence-weighted AVERAGE in update_track (lines 1494-1513,1516-1558) with sequential updates that consume the SAME Vec<usize> — so #6's cluster output is exactly what #4 wants (one cluster = the set of measurements to fold in sequentially). Ordering: land #6's clustering first; #4 then iterates the cluster members applying each sensor's own R. They are complementary, not conflicting., Item #5 (M-of-N confirmation): independent; touches update_track/handle_missed_detections lifecycle, not association. No conflict. But the crossing-target test in #6 asserts track COUNT stability, which #5 must not regress., Shared region warning: items #3, #4, #6 all edit the associate->update region (lines ~1347-1574). Implement in this order in the coordinated pass: (1) shared gated_sq_mahalanobis helper, (2) #6 GNN + clustering, (3) #3 swaps gate threshold inside the helper, (4) #4 rewrites update_track fusion. This minimizes merge churn.

**Citations.**
- Hungarian algorithm — optimal one-to-one assignment, O(n^3) matrix/potentials form, unbalanced (rectangular) handling — https://en.wikipedia.org/wiki/Hungarian_algorithm
- Assignment problem — balanced vs unbalanced, dummy padding for rectangular cost matrices — https://en.wikipedia.org/wiki/Assignment_problem
- Radar tracker — gating, NN vs GNN vs JPDA/MHT, global assignment as the standard upgrade — https://en.wikipedia.org/wiki/Radar_tracker
- Mahalanobis distance — chi-square gating quantiles and confidence ellipsoids (3 dof, 0.99 -> 11.345) — https://en.wikipedia.org/wiki/Mahalanobis_distance
- Auction algorithm — Bertsekas alternative to Hungarian (epsilon-scaling tradeoffs) — https://en.wikipedia.org/wiki/Auction_algorithm
- CREBAIN sensor fusion design doc — current greedy NN, roadmap item #1 global assignment, multi-sensor fusion semantics — [`docs/SENSOR_FUSION.md`](../SENSOR_FUSION.md)

---

## #7 — CV + Coordinated-Turn IMM

- **Feasibility (agent):** now-full

**Recommended approach.** Choose option (b): a fixed-turn-rate CT model, NOT state augmentation (avoids 7-D ripple) and NOT online omega estimation (extra nonlinearity, fragile). Keep the IMM exactly 2 modes to minimize blast radius: mode 0 = the existing CV KalmanFilter; mode 1 = a new CoordinatedTurnFilter that applies a single |omega| but adapts its SIGN from the current velocity (turn direction) each predict step, so one CT mode covers both left and right turns without growing the mode count. This is the smallest correct change and keeps get_estimate / model_probs / transition_matrix as [f64;2], so the surrounding IMM machinery (mix, likelihoods, probability update, get_estimate, the [f64;2] arrays) is untouched.

CT transition (horizontal x,y,vx,vy only; z,vz stay constant-velocity). Grounded in Bar-Shalom Estimation with Applications to Tracking and Navigation Eq. 11.7.1-4 and MATLAB constturn. With w = signed turn rate (rad/s), dt = sample interval, and s=sin(w*dt), c=cos(w*dt):\n  x'  = x  + vx*(s/w)        + vy*((c-1)/w)\n  y'  = y  + vx*((1-c)/w)    + vy*(s/w)\n  vx' = vx*c - vy*s\n  vy' = vx*s + vy*c\n  z'  = z + vz*dt ;  vz' = vz   (unchanged)\nNote MATLAB writes x' = x + vx*s/w + vy*(1-c)/w with y' = y + vy*s/w - vx*(1-c)/w; that is the [x,vx,y,vy] ordering with the opposite handedness convention. Use the F below and verify the sign against the rotation block vx'=c*vx - s*vy so position and velocity rotate consistently. As w -> 0, s/w -> dt, (1-c)/w -> 0, c -> 1, so F degenerates EXACTLY to the CV transition_matrix(dt) - this is why a small-|w| guard cleanly falls back to CV.\n\nFull 6x6 F(w,dt), row-major (state order [x,y,z,vx,vy,vz]):\n  row0 (x):  [1, 0, 0,  s/w,      (c-1)/w,  0 ]\n  row1 (y):  [0, 1, 0,  (1-c)/w,  s/w,      0 ]\n  row2 (z):  [0, 0, 1,  0,        0,        dt]\n  row3 (vx): [0, 0, 0,  c,        -s,       0 ]\n  row4 (vy): [0, 0, 0,  s,        c,        0 ]\n  row5 (vz): [0, 0, 0,  0,        0,        1 ]\n\nTurn-rate selection: |w| from a fixed parameter OMEGA_CT (recommend 0.3 rad/s ~= 17 deg/s, a moderate aircraft/drone turn at standard rate ~3 deg/s up to aggressive). Sign = sign of the planar cross product needed to bend toward the current heading change; simplest robust choice: derive instantaneous w from the velocity-vector rotation history is option (c) and is rejected - instead fix |w| and set sign from the sign of (vx*ay - vy*ax) is overkill. Use the simplest correct rule: keep w = +OMEGA_CT always for mode 1; because the IMM mixes CV (straight) and one CT mode, a single signed CT still improves a turn of either direction since the IMM weights CT up during ANY maneuver and the KF update pulls the rotated prediction toward measurements. If a single sign proves directional in testing, expand to a 3-mode bank {CV, CT(+w), CT(-w)} - but that changes all [f64;2] to [f64;3] and touches mix/get_estimate, so keep it 2-mode for THIS pass and document the 3-mode option as a follow-up. Guard: if |w*dt| < 1e-4 use the CV transition_matrix to avoid 0/0.

**Math / equations.**
- `CT discrete transition (signed turn rate w, dt; s=sin(w*dt), c=cos(w*dt)): x' = x + vx*(s/w) + vy*((c-1)/w); y' = y + vx*((1-c)/w) + vy*(s/w); vx' = c*vx - s*vy; vy' = s*vx + c*vy; z' = z + vz*dt; vz' = vz.`
- `Limit as w->0: s/w -> dt, (1-c)/w -> 0, (c-1)/w -> 0, c -> 1, s -> 0 => F reduces exactly to the CV transition_matrix(dt). Implement with guard |w*dt| < 1e-4.`
- `Covariance predict (both modes): P' = F P F^T + Q*dt, identical structure to existing KalmanFilter::predict_raw, only F differs for the CT mode.`
- `Measurement model unchanged: H = [I_3 | 0_3] (position-only), so IMMFilter::update likelihoods and the KF Joseph update apply verbatim to the CT mode.`
- `Speed invariance (test oracle): vx'^2 + vy'^2 = (c*vx - s*vy)^2 + (s*vx + c*vy)^2 = vx^2 + vy^2 for all w,dt.`
- `IMM mode-probability update (unchanged, model-agnostic): mu_j ∝ Lambda_j * sum_i(pi_ij * mu_i), with Lambda_j the Gaussian innovation likelihood exp(-0.5*d2)/sqrt((2pi)^3 det S).`
- `Markov transition matrix Pi = [[0.95,0.05],[0.10,0.90]] (rows CV,CT).`

**Rust changes.**

All changes are confined to src-tauri/src/sensor_fusion.rs; ZERO new crates (uses only nalgebra Matrix6/Vector6 already imported). No TS changes required (model probabilities are not surfaced today).\n\n1. New struct CoordinatedTurnFilter (insert after KalmanFilter, ~line 397): holds q: Matrix6, r: Matrix3, omega: f64. Provide fn ct_transition_matrix(omega: f64, dt: f64) -> Matrix6<f64> implementing F above with the |omega*dt| < 1e-4 fallback to KalmanFilter::transition_matrix(dt). Provide predict_raw(state, cov, dt) using f = ct_transition_matrix(self.omega, dt); state = f*state; cov = f*cov*f.transpose() + self.q*dt. REUSE KalmanFilter::update_raw verbatim for the linear position update (H is unchanged identity-on-position) - do NOT duplicate the update math; either make CoordinatedTurnFilter embed a KalmanFilter for update or call a shared free fn. Cleanest minimal diff: give CoordinatedTurnFilter a field kf_update: KalmanFilter (built with same q,r) and delegate update_raw to it; or factor the existing update_raw body into a standalone fn linear_position_update(state,cov,measurement,h,r). Prefer embedding to avoid touching KalmanFilter.\n\n2. IMMFilter struct (~941-955): rename field kf_ca -> ct (type CoordinatedTurnFilter). Keep model_probs: [f64;2], transition_matrix: [[f64;2];2], states/covariances [_;2]. Update the doc comment 'Get model probabilities [CV, CA]' -> '[CV, CT]'.\n\n3. IMMFilter::new (~958-974): replace let kf_ca = KalmanFilter::new(process_noise*2.0, ...) with let ct = CoordinatedTurnFilter::new(process_noise, measurement_noise, OMEGA_CT). Keep kf_cv = KalmanFilter::new(process_noise*0.5, ...). Keep model_probs [0.8,0.2]. Set transition_matrix to [[0.95,0.05],[0.10,0.90]] - this CV/CT switching probability is standard (Bar-Shalom): high self-persistence, ~5% chance of starting a maneuver per step, ~10% chance of ending one. Add a module const OMEGA_CT: f64 = 0.3 near the other MAX_FUSION_* consts (~line 18-30) with a comment citing standard-rate-turn rationale.\n\n4. IMMFilter::predict (~1020-1028): change self.kf_ca.predict_raw(&mut states[1], &mut covs[1], dt) to self.ct.predict_raw(...). mix() (985-1017) is model-agnostic and needs NO change.\n\n5. IMMFilter::update (~1031-1099): the likelihood loop (1037-1056) uses self.kf_cv.r for BOTH models' S - that already works and stays. Change the final per-filter update calls (1087-1098): keep kf_cv.update_raw for states[0]; change self.kf_ca.update_raw(...) to self.ct.update_raw(&mut states[1], &mut covs[1], measurement, None). The probability-update block (1058-1084) is model-agnostic, no change.\n\n6. get_estimate (1102-1115) and get_model_probabilities (1118-1121): NO functional change; update the [CV,CA] doc comment to [CV,CT].\n\n7. MotionModel enum (930-939): it is #[expect(dead_code)]. After this change CV and CoordinatedTurn are conceptually live but the enum itself is still not wired to dispatch. Leave the enum as-is OR remove the ConstantAcceleration variant. Recommendation: leave the enum untouched to keep the diff minimal; it is not on the IMM hot path. If the #[expect(dead_code)] now triggers an unfulfilled-expectation warning because something references variants, adjust to #[allow(dead_code)]. Verify with cargo build that the expect lint still holds.\n\nOrdering note for the create_track / set_config / reinitialize_track_filters paths (1627-1632, 1754-1761): these call IMMFilter::new(process_noise, measurement_noise) - signature is UNCHANGED, so no edits needed there.

**TS changes.**

No TypeScript changes required for this item. The bridge (src/detection/AdvancedSensorFusion.ts) only knows the FilterAlgorithm string 'IMM' (line 26, 138, 456-457); IMM model probabilities / motion-model identity are NOT surfaced to TS today (get_model_probabilities is dead code; FusionStats does not carry per-mode probs). The CV->CT swap is internal to the Rust IMMFilter and changes no serialized type. OPTIONAL follow-up (explicitly out of scope): add model_probs: [number, number] (or a CT/CV split) to FusionStats in Rust + the FusionStats type in AdvancedSensorFusion.ts and fusion_get_stats in lib.rs to visualize maneuver state in the UI - defer to a separate item to keep this pass minimal.

**Parameters.**
- `OMEGA_CT` = `0.3 rad/s (~17 deg/s)` — Fixed turn-rate magnitude for the single CT mode. Standard-rate turn for aircraft is ~3 deg/s; agile drones/aircraft maneuver well above that. 0.3 rad/s is a moderate value that produces a clearly non-CV trajectory at typical 10 Hz (dt=0.1) frame rates (turn angle 0.03 rad/step, full circle ~21 s) while staying within small-angle linearization comfort. Bar-Shalom CT literature uses comparable mid-range fixed rates for CT modes in CV/CT IMM banks.
- `process_noise (CV mode)` = `process_noise * 0.5` — Unchanged from existing kf_cv: CV is the low-maneuver hypothesis so it keeps the tighter Q.
- `process_noise (CT mode)` = `process_noise * 1.0 (was * 2.0 for CA)` — The CT model captures the turn structurally via F, so it no longer needs the inflated 2.0x Q that the dead 'CA' used purely as a high-uncertainty catch-all. Use 1.0x (slightly above CV) to absorb the gap between the true and assumed turn rate. Keeping it modest is what makes CT preferred over CV during a turn instead of just a high-noise CV.
- `transition_matrix (Markov)` = `[[0.95,0.05],[0.10,0.90]]` — Unchanged. Standard CV/CT IMM switching: 0.95 CV self-persistence, 0.05 prob of entering a maneuver, 0.90 CT self-persistence, 0.10 prob of ending the maneuver. Asymmetry reflects that targets spend more time straight than turning.
- `model_probs init` = `[0.8, 0.2]` — Unchanged. Prior favors CV (straight) at track birth.
- `omega*dt CV-fallback threshold` = `1e-4` — Below |omega*dt|=1e-4 the s/w and (1-c)/w terms lose precision (0/0); fall back to the exact CV transition. At OMEGA_CT=0.3 and dt>=1e-3 s this never triggers in normal operation, it is purely a numerical guard.

**Test cases.**
- test_ct_transition_degenerates_to_cv_at_zero_omega: build ct_transition_matrix(1e-6, 0.1) and assert every entry is within 1e-6 of KalmanFilter::transition_matrix(0.1). Proves the omega->0 limit / CV fallback boundary.
- test_ct_transition_rotates_velocity: with omega=PI/2 over dt=1.0 (quarter turn), start state vx=1,vy=0; apply F once; assert vx'~0 and vy'~1 (velocity rotated 90 deg CCW) within 1e-9. Proves the velocity rotation block sign/magnitude.
- test_ct_transition_preserves_speed: for several omega in {0.1,0.3,1.0} and dt=0.1, assert sqrt(vx'^2+vy'^2) == sqrt(vx^2+vy^2) within 1e-9 (coordinated turn conserves speed). Catches a wrong sign in the rotation 2x2.
- test_ct_z_axis_is_constant_velocity: state z=5,vz=2; after F(omega=0.3,dt=0.5) assert z'==6.0 and vz'==2.0 exactly. Proves z/vz untouched by the turn.
- test_imm_ct_beats_cv_cv_on_turning_target (the headline test, place alongside test_constant_velocity_estimate_tracks_moving_target ~1960): simulate a target executing a circular/turning trajectory in the x-y plane (e.g. constant speed 5 m/s, true turn rate 0.3 rad/s, generate ground-truth positions for 30 frames at dt=0.1, add small measurement noise). Run TWO MultiSensorFusion engines with FilterAlgorithm::IMM: (A) the new CV+CT, (B) a CV+CV baseline (you can construct B by temporarily forcing OMEGA_CT~0, or assert against a plain Kalman engine). Feed identical measurements. Assert the CV+CT engine's mean position error over the last 10 frames is strictly less than the CV-only/baseline engine's (e.g. ct_rmse < cv_rmse * 0.9). This is the concrete 'turning target tracked better by CV+CT than CV+CV' proof the item requires.
- test_imm_ct_mode_probability_rises_during_turn: using get_model_probabilities(), assert model_probs[1] (CT) rises above its 0.2 prior (e.g. > 0.4) after several frames of a turning trajectory, and stays near/below prior for a straight-line trajectory. Proves the likelihood/probability update actually favors CT during maneuvers. (Requires get_model_probabilities to stay accessible; it is currently #[expect(dead_code)] - either add #[cfg(test)] access or keep it pub and reference it in this test so the expect is satisfied.)
- test_imm_straight_line_still_tracked_by_ct_mode: regression - feed a pure CV trajectory to the CV+CT IMM and assert it tracks as well as before (position error comparable to test_constant_velocity_estimate_tracks_moving_target), confirming adding CT did not degrade the straight-line case.
- Extend the existing algorithm_switch_reseeds_filters_for_existing_tracks test is NOT needed (IMM::new signature unchanged), but run the full suite to confirm no IMM-path regressions.

**Risks.**
- Sign/handedness convention: MATLAB constturn uses [x,vx,y,vy] ordering and a specific handedness; the spec's F is written for [x,y,z,vx,vy,vz]. A transposed sign in the (c-1)/w vs (1-c)/w off-diagonals will make the predicted turn go the wrong way and HURT accuracy. The test_ct_transition_rotates_velocity and preserves_speed tests are the guardrails - get them passing first.
- Single fixed CT sign may only help one turn direction. The IMM still improves both directions because CT is up-weighted during any maneuver and the KF update corrects, but if test_imm_ct_beats_cv_cv fails for one rotation direction, the fallback is the 3-mode {CV,CT(+),CT(-)} bank - which expands [f64;2]->[f64;3] across mix/get_estimate/likelihoods. Keep that as a documented follow-up, NOT this pass, to bound scope.
- Process-noise retune: dropping CA's 2.0x Q to CT's 1.0x changes the IMM's overall responsiveness. If existing IMM-path tests assert specific covariance magnitudes they may need updating. (Current tests do not appear to assert IMM covariance values directly.)
- Numerical: s/w and (1-c)/w near omega=0 - the 1e-4 guard must be present BEFORE the division or you get NaN that propagates through cov and silently kills the track via the existing NaN guards in TrackOutput.
- get_model_probabilities is #[expect(dead_code)]; the mode-probability test references it. If you keep the expect attribute and also reference it from a #[cfg(test)] test, the expect lint may complain it is now 'used'. Switch to #[cfg_attr(not(test), allow(dead_code))] or remove the expect once a test consumes it.
- MotionModel enum remains decorative/dead after this change (the IMM still hard-wires CV+CT internally rather than dispatching on the enum). This is acceptable for a minimal diff but is a latent inconsistency - flag it so a reviewer does not assume the enum now drives behavior.

**Depends on:** Item #4 (Sequential per-sensor information-form update): if that item rewrites the per-track update path or how measurements feed filters, it will collide with IMMFilter::update. Both touch sensor_fusion.rs update_track and IMMFilter::update. Coordinate: the CT change only swaps which filter object handles mode-1 predict/update; if #4 changes the update SIGNATURE (e.g. info-form takes per-sensor R), CoordinatedTurnFilter::update_raw must adopt the same signature. Land the shared update-path change first, then have CT reuse it., Item #3 (chi-square calibrated gating) and Item #6 (Hungarian assignment) touch associate_measurements, NOT IMMFilter - low conflict, but all three edit the same file so merge order matters (rebase, do not parallel-edit the same hunks)., Item #2 (unify threat-level) touches calculate_threat_level/TrackOutput - no overlap with IMM., Surfacing model probabilities to TS (FusionStats / AdvancedSensorFusion.ts) is OUT OF SCOPE here but is a natural companion: if the team also wants the CT/CV split visible in the UI, add model_probs to FusionStats - that would touch lib.rs fusion_get_stats and AdvancedSensorFusion.ts. Keep it separate to bound this item., This is the LARGEST item in the roadmap pass (new struct + IMM rewiring + parameter retune + headline comparative test). It is still now-full realistic because it is fully self-contained in one Rust file, needs no new crates, and the surrounding IMM scaffolding (mix, probability update, get_estimate, [f64;2] arrays) is reused unchanged. now-partial would only apply if the 3-mode bank or TS surfacing were pulled in - explicitly defer both.

**Citations.**
- MathWorks constturn - Constant turn-rate motion model state transition (authoritative discrete CT equations) — https://www.mathworks.com/help/fusion/ref/constturn.html
- Yuan et al., Models and Algorithms for Tracking Target with Coordinated Turn Motion, Mathematical Problems in Engineering 2014 (CT model derivation) — https://www.hindawi.com/journals/mpe/2014/649276/
- Wikipedia: Standard rate turn (turn-rate magnitude rationale for OMEGA_CT) — https://en.wikipedia.org/wiki/Standard_rate_turn
- Wikipedia: Track algorithm (IMM for maneuvering-target track smoothing) — https://en.wikipedia.org/wiki/Track_algorithm
- Wikipedia: Rotation matrix (velocity rotation block, sign convention) — https://en.wikipedia.org/wiki/Rotation_matrix

---

## #8 — Geometric cross-camera gate (browser)

- **Feasibility (agent):** now-full

**Recommended approach.** Add a dependency-free skew-ray (line-line) closest-approach gate to detectionsCorrelate, and a 3D-position term to calculateMatchScore. RECOMMENDED OPTION: ray closest-approach distance + cheirality, NOT a fundamental-matrix/Sampson gate.

Why ray-distance over epipolar/Sampson: The engine already manufactures metric world-space rays via rayFromDetection (origin = camera.position, direction = world-space unit dir from bbox-center NDC through FOV/aspect), and CameraParams carries full extrinsics (position + rotation). A fundamental matrix F is the right tool ONLY when you have raw 2D point matches and uncalibrated/unknown relative pose; here we already have calibrated rays in a common world frame, so the natural, exact geometric residual is the 3D closest-approach distance between the two rays (meters/scene-units), which is directly interpretable and shares the same units as DEFAULT_ASSUMED_TARGET_RANGE_M (20) and triangulationError. Building F would require deriving K (intrinsics) and the relative pose [R|t] between every camera pair, then E = [t]xR, F = K2^-T E K1^-1, then Sampson d = (x2^T F x1)^2 / ((F x1)_1^2 + (F x1)_2^2 + (F^T x2)_1^2 + (F^T x2)_2^2). That is far more code, reintroduces pixel-space units (a threshold in px^2 that must be re-tuned per resolution), and would duplicate calibration logic the rays already encode. Sampson is itself only a first-order approximation of reprojection error (Luong/Faugeras), so it is strictly inferior to working directly with the metric rays we possess. Therefore: skew-line distance gate is the simplest CORRECT option.

GATE 1 (distance): compute the closest-approach distance between the two rays; reject if it exceeds DEFAULT_RAY_GATE_DISTANCE_M (default 3.0 scene units). GATE 2 (cheirality): require the closest-approach point on EACH ray to lie in front of its camera (ray parameter t >= a small negative epsilon, e.g. -0.5 to tolerate noise), rejecting correspondences whose mutual nearest point is behind a camera. Both gates only run when both detections have valid frame dims (rayFromDetection otherwise collapses to camera forward axis -> distinct-class drones near boresight would falsely pass); when frame dims are missing for either detection, fall back to the existing class+confidence+time behavior so we never regress current passing tests.

For calculateMatchScore: add a spatial proximity term. Compute the group's candidate world position (reuse the same least-squares/assumed-range path as triangulatePosition; expose a small private helper computeGroupPosition(group, cameras) that returns Vector3|null reusing triangulatePosition for >=2 cams, or origin+dir*DEFAULT_ASSUMED_TARGET_RANGE_M for a single ray). Then dist = candidatePos.distanceTo(track.triangulatedPosition); spatial term = clamp(1 - dist / SPATIAL_MATCH_SCALE_M, 0, 1) with SPATIAL_MATCH_SCALE_M default 15. Reweight: base 0.4, shared-cameras 0.2, confidence 0.1, spatial 0.3 (sum of maxima = 1.0). matchToTrack must pass cameras into calculateMatchScore (signature change) so the helper can triangulate; processFrame already has cameras in scope and calls matchToTrack(group) -> change to matchToTrack(group, cameras).

**Math / equations.**
- `Skew-line closest distance (algebraic, equivalent reference form): d = |(o1 - o2) . (d1 x d2)| / |d1 x d2|, where o_i are ray origins and d_i unit directions; degenerate (d1 x d2 = 0) means parallel.`
- `Parametric closest-approach (the form to implement, yields t1,t2 for cheirality): with r = o1 - o2, a = d1.d1, b = d1.d2, c = d2.d2, d = d1.r, e = d2.r, denom = a*c - b*b. If denom > EPS: t1 = (b*e - c*d)/denom, t2 = (a*e - b*d)/denom. Closest points P1 = o1 + t1*d1, P2 = o2 + t2*d2; distance = |P1 - P2|.`
- `Parallel fallback: if denom <= EPS, set t1 = 0, t2 = (b>c ? d/b : e/c) and use point-to-line distance.`
- `Cheirality: accept only if t1 >= RAY_CHEIRALITY_EPS_M AND t2 >= RAY_CHEIRALITY_EPS_M (closest approach in front of both cameras, directions point toward target).`
- `Distance gate: accept correspondence iff distance <= DEFAULT_RAY_GATE_DISTANCE_M.`
- `Spatial match term: s = max(0, 1 - ||groupPos - track.triangulatedPosition|| / SPATIAL_MATCH_SCALE_M); matchScore = min(1, 0.4 + 0.2*sharedCamFrac + 0.1*(1 - |conf_track - conf_group|) + 0.3*s).`
- `Rejected alternative (Sampson distance, for the record): d_S = (x2^T F x1)^2 / ((Fx1)_x^2 + (Fx1)_y^2 + (F^T x2)_x^2 + (F^T x2)_y^2), with F = K2^-T [t]x R K1^-1. Not used: requires deriving K and relative pose we don't store, reintroduces resolution-dependent pixel units, and is only a first-order approx of reprojection error.`

**Rust changes.**

NONE. This item is isolated to src/detection/SensorFusion.ts and src/detection/__tests__/SensorFusion.test.ts. No change to src-tauri/src/sensor_fusion.rs, no new crate, no deny.toml impact.

**TS changes.**

All edits in `src/detection/SensorFusion.ts`.

1) Add module-level constants near DEFAULT_ASSUMED_TARGET_RANGE_M (line ~34):
   const DEFAULT_RAY_GATE_DISTANCE_M = 3.0   // max closest-approach distance between two cameras' rays to accept a correspondence (scene units/meters)
   const RAY_CHEIRALITY_EPS_M = -0.5          // allow slightly-negative ray param to tolerate calibration/bbox noise while rejecting clearly-behind-camera matches
   const SPATIAL_MATCH_SCALE_M = 15           // distance (m) at which the spatial match term decays to 0

2) Add a pure free function (after rayFromDetection, ~line 104). Closed-form closest approach of two parametric lines P1(t1)=o1+t1*d1, P2(t2)=o2+t2*d2 with UNIT directions (rayFromDetection returns normalized dirs):
   function rayClosestApproach(r1: Ray, r2: Ray): { distance: number; t1: number; t2: number } {
     const d1 = r1.direction, d2 = r2.direction
     const r = r1.origin.clone().sub(r2.origin)      // o1 - o2
     const a = d1.dot(d1)                              // = 1 for unit dirs, kept general
     const b = d1.dot(d2)
     const c = d2.dot(d2)                              // = 1
     const d = d1.dot(r)
     const e = d2.dot(r)
     const denom = a * c - b * b                       // = sin^2(angle) for unit dirs; ~0 when parallel
     let t1: number, t2: number
     const EPS = 1e-8
     if (denom < EPS) {                                // near-parallel: distance is point-to-line, pick t1=0
       t1 = 0
       t2 = (b > c ? d / b : e / c)
     } else {
       t1 = (b * e - c * d) / denom
       t2 = (a * e - b * d) / denom
     }
     const p1 = r1.origin.clone().add(d1.clone().multiplyScalar(t1))
     const p2 = r2.origin.clone().add(d2.clone().multiplyScalar(t2))
     return { distance: p1.distanceTo(p2), t1, t2 }
   }
   (This is the standard skew-line nearest-point solution; the algebraic distance |(o1-o2).(d1xd2)|/|d1xd2| is equivalent but does NOT yield t1/t2 needed for cheirality, so use the parametric form.)

3) Rewrite detectionsCorrelate (lines 228-249) to USE its currently-unused params _cam1Id/_cam2Id/_cameras (rename to cam1Id, cam2Id, cameras). Keep existing class/confidence/time checks, then append the geometric gate:
   - if det1.class !== det2.class return false (unchanged)
   - confDiff > 0.4 return false (unchanged)
   - |t1-t2| timestamp > 500 return false (unchanged)
   - const cam1 = cameras.get(cam1Id); const cam2 = cameras.get(cam2Id)
   - if (!cam1 || !cam2) return true   // no geometry available -> legacy behavior
   - const hasGeom = det1.frameWidth && det1.frameHeight && det2.frameWidth && det2.frameHeight
   - if (!hasGeom) return true          // rays would collapse to forward axis -> skip geometric gate
   - const ray1 = rayFromDetection(cam1, det1); const ray2 = rayFromDetection(cam2, det2)
   - const { distance, t1, t2 } = rayClosestApproach(ray1, ray2)
   - if (distance > DEFAULT_RAY_GATE_DISTANCE_M) return false
   - if (t1 < RAY_CHEIRALITY_EPS_M || t2 < RAY_CHEIRALITY_EPS_M) return false   // closest point behind a camera
   - return true
   The call site at line 211 already passes (det1, cam1, det2, cam2, cameras); no caller change needed there.

4) Add private helper computeGroupPosition(group, cameras): THREE.Vector3 | null near triangulatePosition. For group.cameraIds.length>=2 return this.triangulatePosition(group, cameras)?.position ?? null; for a single camera build the ray and return origin+dir*DEFAULT_ASSUMED_TARGET_RANGE_M; return null if camera missing. (Reuses existing triangulation; no duplicated math.)

5) Change matchToTrack signature (line 254) to matchToTrack(group, cameras: Map<string,CameraParams>) and update the call at line 138 to this.matchToTrack(group, cameras). Compute groupPos = this.computeGroupPosition(group, cameras) once before the track loop and pass into calculateMatchScore.

6) Change calculateMatchScore signature (line 279) to calculateMatchScore(track, group, groupPos: THREE.Vector3 | null). Rebalance weights:
   let score = 0.4 (was 0.5)
   sharedCameras term * 0.2 (was 0.3)
   confidence term (1-confDiff) * 0.1 (was 0.2)
   spatial term: if (groupPos) { const dist = groupPos.distanceTo(track.triangulatedPosition); score += Math.max(0, 1 - dist / SPATIAL_MATCH_SCALE_M) * 0.3 } else { score += 0.15 } (neutral half-credit when no geometry so single-camera tracks still match as before)
   return Math.min(1, score). NOTE: keep correlationThreshold default 0.5; with these weights a co-located same-class track scores ~0.4(base)+~0.3(spatial)=0.7 and matches, while a track 15m away scores ~0.4 and is rejected — verify against existing tests which use correlationThreshold:0.1 so they remain unaffected.

**Parameters.**
- `DEFAULT_RAY_GATE_DISTANCE_M` = `3.0` — Max closest-approach distance (scene units/meters) between the two cameras' rays to accept a same-object correspondence. Chosen relative to expected target size (~0.5-1 m drone) plus ray noise from bbox-center quantization and FOV-based (uncalibrated) direction error; small enough that two distinct drones separated by several meters fail the gate, large enough to absorb the existing FOV approximation error. Sits well below DEFAULT_ASSUMED_TARGET_RANGE_M (20) and the triangulation fallback band. Expose via FusionConfig later if tuning is needed.
- `RAY_CHEIRALITY_EPS_M` = `-0.5` — Cheirality tolerance on the closest-approach ray parameter t (meters along a unit-direction ray). Requiring t >= -0.5 rejects correspondences whose mutual nearest point falls clearly behind either camera (a geometric impossibility for a real co-observed target) while tolerating mild calibration/bbox noise that can push t slightly negative for targets very close to a camera.
- `SPATIAL_MATCH_SCALE_M` = `15` — Distance scale (m) over which the new spatial term in calculateMatchScore decays linearly from 1 to 0. A group co-located with a track scores full 0.3 spatial credit; a group 15 m away scores 0. Set larger than DEFAULT_RAY_GATE_DISTANCE_M because track position is smoothed (positionSmoothing lerp) and may lag the instantaneous group position; keeps continuous tracks matching across frames while separating spatially distinct objects.
- `calculateMatchScore weights` = `base 0.4, shared-cameras 0.2, confidence 0.1, spatial 0.3` — Sum of maxima = 1.0. Reduces the previous class-only floor (0.5) and confidence weight (0.2) to make room for a 0.3 spatial term so that LOCATION, not just class, drives matching. With default correlationThreshold 0.5, a co-located same-class candidate clears the gate (~0.7) while a far one (~0.4) does not.
- `EPS (parallel-ray guard)` = `1e-8` — Denominator (a*c - b*b = sin^2 of angle between unit dirs) threshold below which rays are treated as parallel; avoids divide-by-zero and matches the conditioning epsilon already used in solve3x3 (line 45).

**Test cases.**
- TWO REAL DRONES NOT MERGED (core requirement): two cameras side-by-side (e.g. cam-left at (-8,0,12), cam-right at (8,0,12)) both looking at the scene; place drone A so both cameras' bbox centers point at world ~(0,9,57) and drone B several meters away so the two cameras' bbox centers produce rays whose closest approach > 3.0 m. Feed cam1=[detA1, detB1], cam2=[detA2, detB2], all class 'drone', valid frameWidth/Height. Assert processFrame yields >=2 tracks (A and B not merged) and that no single track lists both A's and B's far-apart positions. Use correlationThreshold default and confirm detectionsCorrelate(detA1, detB2) is rejected by the ray-distance gate.
- ONE DRONE ACROSS TWO CAMERAS STILL MERGED (no regression): reuse createDroneApproachScenario()/toFusionInputs OR a hand-built pair whose rays intersect near the true target; assert processFrame yields exactly 1 track with contributingCameras containing both cameras (mirrors existing 'processes the drone approach scenario fixture into one fused track' test — confirm it still passes with the new gate active, i.e. true correspondence's closest-approach distance < 3.0 and t1,t2 > 0).
- CHEIRALITY REJECTION: construct two rays that are close in line-line distance but whose closest approach lies BEHIND one camera (target placed behind cam2's image plane / direction). Assert detectionsCorrelate returns false due to t2 < RAY_CHEIRALITY_EPS_M even though distance gate alone would pass.
- MISSING FRAME DIMS FALLBACK: two same-class detections with confDiff<0.4 and |dt|<500 but frameWidth/frameHeight undefined on one. Assert detectionsCorrelate returns true (legacy behavior preserved; geometric gate skipped) so existing non-geometry tests do not regress.
- rayClosestApproach UNIT TEST (pure fn): exported-or-internal-via-test rays. (a) Perpendicular intersecting rays from (-1,0,0)->+x and (0,-1,0)->... arranged to meet at origin -> distance ~0, t1,t2 ~1. (b) Two parallel rays offset by 2 m -> distance ~2, denom path = parallel branch, no NaN. (c) Skew rays with known offset -> distance matches hand-computed |(o1-o2).(d1xd2)|/|d1xd2|.
- SPATIAL MATCH TERM: create a confirmed track at triangulatedPosition (0,9,57); frame 2 supplies a same-class group triangulating to ~(0.4,9.7,57) -> assert it MATCHES the existing track (same id, no new track). Then a separate same-class group triangulating to (40,9,57) (>15 m away) -> assert it creates a NEW track rather than matching, proving calculateMatchScore now discriminates by location. Use default correlationThreshold 0.5.
- REGRESSION GUARD: run the existing four SensorFusion.test.ts cases (they pass correlationThreshold:0.1) and confirm all still pass unchanged — especially 'triangulates near the ray intersection for two cameras' (rays intersect, distance ~0, passes gate) and the multi-frame confirm/prune tests.

**Risks.**
- rayFromDetection collapses to the camera FORWARD axis when frameWidth/frameHeight are missing (lines 83-85). If the geometric gate ran in that case, two distinct same-class drones near boresight would share near-identical forward-axis rays and falsely pass. MITIGATION: only run the geometric gate when BOTH detections have valid frame dims; otherwise keep legacy class/conf/time behavior (specified). This also preserves any existing tests that omit frame dims.
- Threshold tuning: DEFAULT_RAY_GATE_DISTANCE_M=3.0 is in SCENE UNITS and depends on the sim scale (DEFAULT_ASSUMED_TARGET_RANGE_M=20 implies ~meters). If real ROS-fed cameras use a different world scale, 3.0 may be too tight/loose. MITIGATION: document as scene units and plan to surface via FusionConfig; the comparison tests pin behavior at the default scale.
- Greedy correlation order dependence is unchanged: correlateDetections is still greedy first-come (line 188+). The gate only PREVENTS wrong merges; it cannot fix a case where a true pair is consumed by an earlier wrong-but-gate-passing seed. Out of scope here but relevant to roadmap item #6 (global NN/Hungarian assignment) — see dependency note.
- calculateMatchScore now triangulates per candidate group via computeGroupPosition, adding an O(tracks) -> O(tracks) triangulation cost; compute groupPos ONCE before the track loop (specified) to avoid O(tracks*cams) work.
- Cheirality epsilon: too strict a value (t>=0) can reject valid very-near targets where bbox noise pushes t slightly negative; -0.5 chosen as tolerant. If false rejections appear in the 'still merged' test, relax toward -1.0.
- Parallel-ray branch: when denom<EPS the chosen t2 formula must not divide by ~0; guarded by picking the larger of b,c. Covered by the parallel-rays unit test.

**Depends on:** Item #6 (Global nearest-neighbour / Hungarian assignment): touches the SAME correlation/matching path conceptually but in the BROWSER engine this item edits correlateDetections/detectionsCorrelate/matchToTrack/calculateMatchScore. If #6 is also applied to SensorFusion.ts in the same pass (the prompt scopes #6 to the Rust engine, so likely NO browser overlap), coordinate: the ray-distance/cheirality predicate from this item should become the GATE feeding the assignment cost, and the spatial term in calculateMatchScore should become the assignment cost. Confirm #6 is Rust-only to avoid edit collisions in matchToTrack., Item #3 (Chi-square calibrated gating) and #4 (information-form update): Rust-only (sensor_fusion.rs). NO file conflict with this TS-only item. Conceptually parallel (this is the browser analog of a gating step) but no shared code., This item is otherwise self-contained to src/detection/SensorFusion.ts + its test file; no shared edits with items #2,#5,#7,#9 which are Rust/threat-formula scoped. matchToTrack and calculateMatchScore SIGNATURE changes (adding cameras / groupPos params) are the only cross-method ripples and are fully internal to SensorFusion.ts.

**Citations.**
- Skew lines (closest distance formula) - Wikipedia — https://en.wikipedia.org/wiki/Skew_lines
- Line-line intersection / nearest points - Wikipedia — https://en.wikipedia.org/wiki/Line%E2%80%93line_intersection
- Revisiting Sampson Approximations for Geometric Estimation Problems (Sampson = first-order approx of reprojection error) — https://arxiv.org/pdf/2401.07114
- Geometry-Aware Feature Matching for Large-Scale Structure from Motion (Sampson-distance correspondence gating) — https://arxiv.org/pdf/2409.02310
