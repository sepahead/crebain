//! CREBAIN Advanced Sensor Fusion Module
//! Adaptive Response & Awareness System (ARAS)
//!
//! Multi-modal sensor fusion with advanced filtering algorithms:
//! - Kalman Filter (KF) - Linear systems
//! - Extended Kalman Filter (EKF) - Non-linear systems with linearization
//! - Unscented Kalman Filter (UKF) - Non-linear without linearization
//! - Particle Filter (PF) - Non-Gaussian, multi-modal distributions
//! - Interacting Multiple Model (IMM) - Maneuvering target tracking

use nalgebra::{DMatrix, DVector, Matrix3, Matrix6, Vector3, Vector6};
use rand::Rng;
use rand_distr::{Distribution, StandardNormal};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::f64::consts::PI;

/// Upper bound on the timestamp gap (seconds) integrated by substepped
/// prediction in one frame. Beyond this a coasting track's covariance has
/// long since inflated toward the divergence gate; the cap also bounds the
/// substep loop under wall-clock jumps (suspend/resume, replays).
const MAX_PREDICT_GAP_S: f64 = 60.0;

pub const MAX_FUSION_MEASUREMENTS_PER_BATCH: usize = 512;
pub const MAX_FUSION_TRACKS: usize = 1024;
pub const MAX_FUSION_PARTICLE_COUNT: usize = 1000;
const MAX_FUSION_STRING_LEN: usize = 256;
const MAX_FUSION_METADATA_ENTRIES: usize = 64;
const MAX_FUSION_NOISE: f64 = 10_000.0;
const MAX_ASSOCIATION_THRESHOLD: f64 = 100_000.0;
/// Radar azimuth validation bound (rad): accepts both atan2-style [-π, π] and
/// unwrapped [0, 2π) producers, i.e. anything within ±2π.
const MAX_RADAR_AZIMUTH_RAD: f64 = 2.0 * PI;
/// Radar elevation validation bound (rad): asin-style [-π/2, π/2].
const MAX_RADAR_ELEVATION_RAD: f64 = PI / 2.0;
const MAX_MISSED_DETECTIONS: u32 = 1_000;
const MAX_CONFIRMATION_HITS: u32 = 1_000;
/// Sliding-window M-of-N confirmation: the window width N is stored as a u32
/// bitmask, so it is hard-capped at 32 bits (`1u32 << 32` would overflow).
const MAX_CONFIRMATION_WINDOW: u32 = 32;
/// Minimum sliding-window width N (a single association opportunity).
const MIN_CONFIRMATION_WINDOW: u32 = 1;
/// Nominal per-axis position sigma (meters) used to normalize the Euclidean
/// association distance when the innovation covariance is singular, keeping the
/// gate on the same unitless scale as the Mahalanobis branch.
const NOMINAL_ASSOCIATION_SIGMA_M: f64 = 1.0;
/// Initial per-axis velocity variance for a single-point track birth (m²/s²).
/// A track born from a single position-only measurement carries no velocity
/// information, so the velocity prior must be wide (Bar-Shalom single-point
/// initiation): σ_v = 20 m/s covers plausible UAS speeds. This lets the
/// constant-velocity predict cover one frame of real target motion inside the
/// χ²(3) association gate without loosening the gate itself.
const INITIAL_VELOCITY_VARIANCE_M2_S2: f64 = 400.0;
/// χ²(3) 0.99 quantile used as the pairwise gate when clustering co-located,
/// same-class returns from different sensors into one "super-measurement" (so a
/// target seen by N sensors in one frame still updates a single track).
const MEAS_CLUSTER_GATE: f64 = 11.345;
/// Cluster↔track assignment costs are integer-quantized (d² × this, rounded) so
/// the Kuhn–Munkres solver is exact and free of float-equality hazards.
const ASSIGNMENT_QUANTIZE_SCALE: f64 = 1000.0;
/// Out-of-gate sentinel for the assignment cost matrix. A *finite* value with
/// guaranteed headroom over any achievable total assignment cost: the largest
/// quantized in-gate cell is MAX_ASSOCIATION_THRESHOLD × ASSIGNMENT_QUANTIZE_SCALE
/// (1e8, NOT the default χ²(3) threshold), so the sentinel is that ceiling × the
/// maximum matrix dimension (MAX_FUSION_TRACKS) × a 4× safety margin ≈ 4.1e11 —
/// the solver can never trade a full set of real assignments for one out-of-gate
/// cell. It stays small enough that the Kuhn–Munkres dual potentials `u[i] + v[j]`
/// cannot overflow `i64` when many tracks are simultaneously out-of-gate (all-INF
/// rows accumulate ~INF per row; bounded above by max-tracks × INF ≈ 4e14 ≪
/// i64::MAX).
const ASSIGNMENT_INF: i64 =
    (MAX_ASSOCIATION_THRESHOLD * ASSIGNMENT_QUANTIZE_SCALE) as i64 * (MAX_FUSION_TRACKS as i64) * 4;
/// Fixed turn-rate magnitude (rad/s) for the IMM's single Coordinated-Turn mode.
/// 0.3 rad/s (~17 deg/s) is a moderate maneuver: a standard-rate turn for aircraft
/// is ~3 deg/s, while agile drones/aircraft maneuver well above that. At a typical
/// 10 Hz frame rate (dt=0.1) this yields a clearly non-CV turn (0.03 rad/step,
/// full circle ~21 s) while staying within small-angle linearization comfort.
const OMEGA_CT: f64 = 0.3;

// ═══════════════════════════════════════════════════════════════════════════════
// SENSOR TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/// Sensor modality types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SensorModality {
    /// Visual/RGB camera
    Visual,
    /// Thermal/IR camera
    Thermal,
    /// Acoustic/audio sensor
    Acoustic,
    /// RADAR
    Radar,
    /// LIDAR
    Lidar,
    /// RF detection
    RadioFrequency,
}

/// Raw sensor measurement
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorMeasurement {
    pub sensor_id: String,
    pub modality: SensorModality,
    pub timestamp_ms: u64,
    /// Target position in the sensor measurement frame, selected by `modality`:
    /// - `Radar`: polar `[range_m, azimuth_rad, elevation_rad]`
    /// - `Visual` / `Thermal` / `Acoustic` / `Lidar`: Cartesian `[x, y, z]` in
    ///   meters (common world/ENU frame).
    ///
    /// The frame is interpreted by [`measurement_position_cartesian`] (used for
    /// association and track initialization) and [`measurement_position_polar`]
    /// (used by the EKF polar update). Producers MUST emit the frame that
    /// matches their modality — see `src/ros/useROSSensors.ts`.
    pub position: [f64; 3],
    /// Velocity seed if available, always Cartesian `[vx, vy, vz]` in m/s.
    /// Radar producers project radial velocity onto the line of sight.
    pub velocity: Option<[f64; 3]>,
    /// Measurement noise (diagonal of R), in the SAME frame as `position`:
    /// `[m², m², m²]` for Cartesian modalities, `[m², rad², rad²]` for radar.
    pub covariance: [f64; 3],
    /// Detection confidence [0, 1]
    pub confidence: f64,
    /// Classification label
    pub class_label: String,
    /// Additional sensor-specific data
    pub metadata: HashMap<String, f64>,
}

fn polar_to_cartesian(range: f64, azimuth: f64, elevation: f64) -> Vector3<f64> {
    let cos_el = elevation.cos();
    Vector3::new(
        range * cos_el * azimuth.cos(),
        range * cos_el * azimuth.sin(),
        range * elevation.sin(),
    )
}

fn measurement_position_cartesian(measurement: &SensorMeasurement) -> Vector3<f64> {
    match measurement.modality {
        // Only radar reports polar [range, azimuth, elevation]. Lidar reports a
        // metric Cartesian centroid, so it must NOT be re-converted here.
        SensorModality::Radar => polar_to_cartesian(
            measurement.position[0],
            measurement.position[1],
            measurement.position[2],
        ),
        _ => Vector3::new(
            measurement.position[0],
            measurement.position[1],
            measurement.position[2],
        ),
    }
}

fn measurement_position_polar(measurement: &SensorMeasurement) -> Option<Vector3<f64>> {
    match measurement.modality {
        // Radar is the only polar modality; its position is already
        // [range, azimuth, elevation] and feeds the EKF polar update directly.
        SensorModality::Radar => Some(Vector3::new(
            measurement.position[0],
            measurement.position[1],
            measurement.position[2],
        )),
        _ => None,
    }
}

/// Measurement-noise covariance `R` expressed in the **Cartesian** position
/// frame, used by the (Cartesian) association gate and to seed the position block
/// of a track's birth covariance in `create_track`.
///
/// Cartesian modalities (lidar / visual / thermal / acoustic) use their diagonal
/// `covariance` directly. Radar reports polar noise `[m², rad², rad²]`, so adding
/// it straight to a Cartesian position covariance would mix units and badly
/// under-estimate cross-range uncertainty (an angular 1σ at range `R` spans
/// ≈ `R · σ_angle` in cross-range). We therefore propagate radar noise into
/// Cartesian via the polar→Cartesian Jacobian: with `J = ∂(range,az,el)/∂(x,y,z)`
/// (the position block of the EKF measurement Jacobian) and `δpolar = J · δcart`,
/// `R_cart = J⁻¹ R_polar J⁻ᵀ`, linearized at the measurement position.
fn measurement_r_cartesian(meas: &SensorMeasurement, meas_pos: &Vector3<f64>) -> Matrix3<f64> {
    let r_diag = Matrix3::from_diagonal(&Vector3::new(
        meas.covariance[0],
        meas.covariance[1],
        meas.covariance[2],
    ));
    match meas.modality {
        SensorModality::Radar => {
            let pseudo_state = Vector6::new(meas_pos[0], meas_pos[1], meas_pos[2], 0.0, 0.0, 0.0);
            let h = ExtendedKalmanFilter::measurement_jacobian(&pseudo_state);
            // Position block ∂(range,az,el)/∂(x,y,z).
            let j = Matrix3::new(
                h[(0, 0)],
                h[(0, 1)],
                h[(0, 2)],
                h[(1, 0)],
                h[(1, 1)],
                h[(1, 2)],
                h[(2, 0)],
                h[(2, 1)],
                h[(2, 2)],
            );
            match j.try_inverse() {
                Some(j_inv) => j_inv * r_diag * j_inv.transpose(),
                // Degenerate geometry (target at/near the origin, where the
                // polar Jacobian is singular): the old fallback installed the
                // RAW polar diagonal [m², rad², rad²] as Cartesian m² — the
                // very unit mixing this function exists to fix. Near the
                // origin the angular uncertainties contribute ~r² ≈ 0 lateral
                // variance, so the honest conservative fallback is isotropic
                // range variance.
                None => {
                    log::warn!(
                        "[fusion] degenerate radar geometry: isotropic range-variance fallback"
                    );
                    Matrix3::from_diagonal_element(r_diag[(0, 0)])
                }
            }
        }
        _ => r_diag,
    }
}

/// Thermal-specific measurement for IR camera integration.
/// Roadmap: v0.6.0 - Hardware-in-the-loop testing with FLIR cameras
#[expect(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThermalMeasurement {
    pub base: SensorMeasurement,
    /// Temperature in Kelvin
    pub temperature_k: f64,
    /// Thermal signature area in m²
    pub signature_area: f64,
    /// Emissivity estimate
    pub emissivity: f64,
}

/// Acoustic-specific measurement for audio sensor arrays.
/// Roadmap: v0.6.0 - Multi-sensor hardware integration
#[expect(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcousticMeasurement {
    pub base: SensorMeasurement,
    /// Sound pressure level in dB
    pub spl_db: f64,
    /// Dominant frequency in Hz
    pub frequency_hz: f64,
    /// Direction of arrival [azimuth, elevation] in radians
    pub doa: [f64; 2],
    /// Doppler shift in Hz (for velocity estimation)
    pub doppler_hz: Option<f64>,
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRACK STATE
// ═══════════════════════════════════════════════════════════════════════════════

/// Track state vector: [x, y, z, vx, vy, vz]
#[derive(Debug, Clone)]
pub struct TrackState {
    /// State vector [x, y, z, vx, vy, vz]
    pub state: Vector6<f64>,
    /// State covariance matrix (6x6)
    pub covariance: Matrix6<f64>,
    /// Track ID
    pub id: String,
    /// Classification
    pub class_label: String,
    /// Fused confidence from all sensors
    pub confidence: f64,
    /// Contributing sensor modalities
    pub sensor_sources: Vec<SensorModality>,
    /// Last update timestamp
    pub last_update_ms: u64,
    /// Track age in frames
    pub age: u32,
    /// Consecutive missed detections
    pub missed_detections: u32,
    /// Bitmask of the last N association opportunities (bit0 = most recent frame; 1=hit, 0=miss). Drives sliding-window M-of-N confirmation/deletion.
    pub hit_history: u32,
    /// Total association opportunities since birth: incremented once per frame
    /// alongside the `hit_history` shift (Step 4.5), saturating. Sets the
    /// sliding window's fill so misses are only counted over observed slots.
    /// (`age` counts hits only and `missed_detections` resets on every hit, so
    /// neither can reconstruct this for intermittent hit patterns.)
    pub opportunities: u32,
    /// Track state
    pub state_label: TrackStateLabel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrackStateLabel {
    Tentative,
    Confirmed,
    Coasting,
    Lost,
}

/// Serializable track for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackOutput {
    pub id: String,
    pub position: [f64; 3],
    pub velocity: [f64; 3],
    pub position_uncertainty: [f64; 3],
    pub velocity_uncertainty: [f64; 3],
    pub class_label: String,
    pub confidence: f64,
    pub sensor_sources: Vec<SensorModality>,
    pub last_update_ms: u64,
    pub age: u32,
    pub state: TrackStateLabel,
    pub threat_level: u8,
}

impl From<&TrackState> for TrackOutput {
    fn from(track: &TrackState) -> Self {
        // Invalid covariance is quarantined by the lifecycle pass before normal
        // output. Keep this conversion conservative as a final boundary guard:
        // an invalid variance must never be presented as zero uncertainty.
        let uncertainty = |variance: f64| {
            if variance.is_finite() && variance >= 0.0 {
                variance.sqrt()
            } else {
                f64::MAX.sqrt()
            }
        };
        let pos_unc = [
            uncertainty(track.covariance[(0, 0)]),
            uncertainty(track.covariance[(1, 1)]),
            uncertainty(track.covariance[(2, 2)]),
        ];
        let vel_unc = [
            uncertainty(track.covariance[(3, 3)]),
            uncertainty(track.covariance[(4, 4)]),
            uncertainty(track.covariance[(5, 5)]),
        ];

        let threat_level = calculate_threat_level(&track.class_label, track.confidence);

        TrackOutput {
            id: track.id.clone(),
            position: [track.state[0], track.state[1], track.state[2]],
            velocity: [track.state[3], track.state[4], track.state[5]],
            position_uncertainty: pos_unc,
            velocity_uncertainty: vel_unc,
            class_label: track.class_label.clone(),
            confidence: track.confidence,
            sensor_sources: track.sensor_sources.clone(),
            last_update_ms: track.last_update_ms,
            age: track.age,
            state: track.state_label,
            threat_level,
        }
    }
}

/// Tactical detection class. Mirrors the TypeScript `DetectionClass` and the
/// `mapToDetectionClass` label mapping in `src/detection/types.ts` so the native
/// and browser engines bucket the same raw label identically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetectionClassKind {
    Drone,
    Bird,
    Aircraft,
    Helicopter,
    Unknown,
}

/// Map a raw classification label to the canonical tactical class. A 1:1 mirror of
/// `mapToDetectionClass` in `src/detection/types.ts` (the same exact-match rules,
/// the demo `kite`/`frisbee` remap, and the `bird` substring) — keep the two in
/// lockstep so threat levels agree across the two fusion engines.
fn map_to_detection_class(label: &str) -> DetectionClassKind {
    let label = label.to_lowercase();
    if label == "drone" || label == "quadcopter" || label == "uav" {
        DetectionClassKind::Drone
    } else if label == "bird" || label.contains("bird") {
        DetectionClassKind::Bird
    } else if label == "airplane" || label == "aircraft" || label == "aeroplane" {
        DetectionClassKind::Aircraft
    } else if label == "helicopter" || label == "chopper" {
        DetectionClassKind::Helicopter
    } else if label == "kite" || label == "frisbee" {
        // Demo/testing remap, mirrored from the TS UI path.
        DetectionClassKind::Drone
    } else {
        DetectionClassKind::Unknown
    }
}

/// Canonical 1-4 threat level. MUST stay identical to the TypeScript
/// `getThreatLevel` in src/detection/types.ts — both the [`map_to_detection_class`]
/// bucketing above and the per-class confidence graduation below.
fn calculate_threat_level(class: &str, confidence: f64) -> u8 {
    match map_to_detection_class(class) {
        // Graduated: a low-confidence single-sensor drone hypothesis stays
        // "guarded" (2) until corroboration lifts it to "elevated" (3) / "severe" (4).
        DetectionClassKind::Drone => {
            if confidence > 0.8 {
                4
            } else if confidence > 0.5 {
                3
            } else {
                2
            }
        }
        DetectionClassKind::Aircraft | DetectionClassKind::Helicopter => 2,
        DetectionClassKind::Bird => 1,
        // A confidently-tracked but unidentified object warrants elevated (3)
        // attention; a low-confidence one stays guarded (2).
        DetectionClassKind::Unknown => {
            if confidence > 0.7 {
                3
            } else {
                2
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// KALMAN FILTER
// ═══════════════════════════════════════════════════════════════════════════════

/// Pre-update innovation statistics from one filter measurement update:
/// `y = z − h(x̂⁻)` against the state as it stood entering the update (the
/// a-priori state for the first measurement of a frame; the sequentially
/// conditioned prior for co-located follow-ups), and `S = H P⁻ Hᵀ + R` in the
/// same frame as `y`. Returned `None` means the update was **skipped**
/// (singular innovation covariance) and the state was not corrected.
#[derive(Debug, Clone, Copy)]
pub struct InnovationStats {
    /// Innovation `y` (Cartesian metres, or polar `[m, rad, rad]` for the
    /// EKF radar path with azimuth wrapped to `[-π, π]`).
    pub innovation: Vector3<f64>,
    /// Innovation covariance `S`, same frame as `innovation`.
    pub innovation_cov: Matrix3<f64>,
}

impl InnovationStats {
    /// `NIS = yᵀ S⁻¹ y`, via a Cholesky solve (S is SPD by construction;
    /// cheaper and better-conditioned than forming `S⁻¹`). `None` if `S` is
    /// not positive-definite at machine precision.
    pub fn nis(&self) -> Option<f64> {
        let chol = self.innovation_cov.cholesky()?;
        let solved = chol.solve(&self.innovation);
        Some(self.innovation.dot(&solved))
    }
}

/// Standard Kalman Filter for linear systems
#[derive(Debug)]
pub struct KalmanFilter {
    /// Process noise covariance
    q: Matrix6<f64>,
    /// Measurement noise covariance (position only)
    r: Matrix3<f64>,
}

impl KalmanFilter {
    pub fn new(process_noise: f64, measurement_noise: f64) -> Self {
        // Process noise - affects velocity more than position
        let q = Matrix6::from_diagonal(&Vector6::new(
            process_noise * 0.1,
            process_noise * 0.1,
            process_noise * 0.1,
            process_noise,
            process_noise,
            process_noise,
        ));

        let r = Matrix3::from_diagonal(&Vector3::new(
            measurement_noise,
            measurement_noise,
            measurement_noise,
        ));

        Self { q, r }
    }

    /// State transition matrix for constant velocity model
    fn transition_matrix(dt: f64) -> Matrix6<f64> {
        #[rustfmt::skip]
        let f = Matrix6::new(
            1.0, 0.0, 0.0, dt,  0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, dt,  0.0,
            0.0, 0.0, 1.0, 0.0, 0.0, dt,
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        );
        f
    }

    /// Measurement matrix (we only observe position)
    fn measurement_matrix() -> nalgebra::Matrix3x6<f64> {
        #[rustfmt::skip]
        let h = nalgebra::Matrix3x6::new(
            1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
        );
        h
    }

    /// Predict step (operates on TrackState)
    pub fn predict(&self, state: &mut TrackState, dt: f64) {
        self.predict_raw(&mut state.state, &mut state.covariance, dt);
    }

    /// Raw predict step - operates directly on state/covariance without TrackState overhead
    #[inline]
    pub fn predict_raw(&self, state: &mut Vector6<f64>, covariance: &mut Matrix6<f64>, dt: f64) {
        let f = Self::transition_matrix(dt);

        // State prediction: x' = F * x
        *state = f * *state;

        // Covariance prediction: P' = F * P * F^T + Q
        *covariance = f * *covariance * f.transpose() + self.q * dt;
    }

    /// Update step with measurement (operates on TrackState)
    pub fn update(
        &self,
        state: &mut TrackState,
        measurement: &Vector3<f64>,
        r_override: Option<&Matrix3<f64>>,
    ) -> Option<InnovationStats> {
        self.update_raw(
            &mut state.state,
            &mut state.covariance,
            measurement,
            r_override,
        )
    }

    /// Raw update step - operates directly on state/covariance without TrackState overhead
    #[inline]
    pub fn update_raw(
        &self,
        state: &mut Vector6<f64>,
        covariance: &mut Matrix6<f64>,
        measurement: &Vector3<f64>,
        r_override: Option<&Matrix3<f64>>,
    ) -> Option<InnovationStats> {
        let h = Self::measurement_matrix();
        let r = r_override.unwrap_or(&self.r);

        // Innovation: y = z - H * x
        let predicted_measurement = h * *state;
        let innovation = measurement - predicted_measurement;

        // Innovation covariance: S = H * P * H^T + R
        let s = h * *covariance * h.transpose() + r;

        // Kalman gain via Cholesky solve: S is SPD by construction (R > 0), a
        // solve is cheaper and better conditioned than forming S⁻¹, and its
        // failure is a principled positive-definiteness guard (try_inverse only
        // failed at hard singularity and returned garbage for merely
        // ill-conditioned S). K = P Hᵀ S⁻¹  ⇔  Kᵀ = S⁻¹ (H P), P symmetric.
        let Some(chol) = s.cholesky() else {
            log::warn!(
                "[KalmanFilter] Innovation covariance not positive-definite (det={:.2e}), skipping update",
                s.determinant()
            );
            return None; // Skip this update rather than corrupt state
        };
        let k = chol.solve(&(h * *covariance)).transpose();

        // State update: x = x + K * y
        *state += k * innovation;

        // Covariance update: Joseph stabilized form
        //   P = (I - K H) P (I - K H)ᵀ + K R Kᵀ
        // This is algebraically equal to (I - K H) P for the optimal gain, but
        // is a sum of two symmetric PSD terms, so it preserves symmetry and
        // positive-semidefiniteness under finite-precision arithmetic. R must be
        // the SAME matrix used to form S above (the override when present).
        let i = Matrix6::identity();
        let ikh = i - k * h;
        *covariance = ikh * *covariance * ikh.transpose() + k * *r * k.transpose();
        Some(InnovationStats {
            innovation,
            innovation_cov: s,
        })
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COORDINATED-TURN FILTER
// ═══════════════════════════════════════════════════════════════════════════════

/// Fixed-turn-rate Coordinated-Turn (CT) filter for the IMM's maneuver mode.
///
/// The horizontal (x, y, vx, vy) block follows a discrete coordinated-turn model
/// (Bar-Shalom, *Estimation with Applications to Tracking and Navigation*,
/// Eq. 11.7.1-4; MATLAB `constturn`); z and vz stay constant-velocity. The linear
/// position update is delegated verbatim to an embedded [`KalmanFilter`] (the
/// measurement model H = [I_3 | 0_3] is unchanged), so the Joseph-stabilized
/// update math is never duplicated.
#[derive(Debug)]
pub struct CoordinatedTurnFilter {
    /// Process noise covariance.
    q: Matrix6<f64>,
    /// Measurement noise covariance (position only).
    #[allow(dead_code)] // R lives in the embedded KalmanFilter; kept for parity/inspection.
    r: Matrix3<f64>,
    /// Signed turn rate (rad/s).
    omega: f64,
    /// Embedded linear filter that performs the position update (H = [I_3 | 0_3]).
    kf_update: KalmanFilter,
}

impl CoordinatedTurnFilter {
    pub fn new(process_noise: f64, measurement_noise: f64, omega: f64) -> Self {
        let kf_update = KalmanFilter::new(process_noise, measurement_noise);
        let q = Matrix6::from_diagonal(&Vector6::new(
            process_noise * 0.1,
            process_noise * 0.1,
            process_noise * 0.1,
            process_noise,
            process_noise,
            process_noise,
        ));
        let r = Matrix3::from_diagonal(&Vector3::new(
            measurement_noise,
            measurement_noise,
            measurement_noise,
        ));
        Self {
            q,
            r,
            omega,
            kf_update,
        }
    }

    /// Discrete coordinated-turn transition matrix F(omega, dt) in state order
    /// [x, y, z, vx, vy, vz]. With s = sin(omega*dt), c = cos(omega*dt):
    ///   row0 (x):  [1, 0, 0,  s/w,      (c-1)/w,  0 ]
    ///   row1 (y):  [0, 1, 0,  (1-c)/w,  s/w,      0 ]
    ///   row2 (z):  [0, 0, 1,  0,        0,        dt]
    ///   row3 (vx): [0, 0, 0,  c,        -s,       0 ]
    ///   row4 (vy): [0, 0, 0,  s,        c,        0 ]
    ///   row5 (vz): [0, 0, 0,  0,        0,        1 ]
    /// As omega -> 0 this degenerates exactly to the CV transition; the
    /// |omega*dt| < 1e-4 guard falls back to [`KalmanFilter::transition_matrix`]
    /// to avoid the 0/0 in s/w and (1-c)/w.
    fn ct_transition_matrix(omega: f64, dt: f64) -> Matrix6<f64> {
        const CV_FALLBACK_THRESHOLD: f64 = 1e-4;
        if (omega * dt).abs() < CV_FALLBACK_THRESHOLD {
            return KalmanFilter::transition_matrix(dt);
        }
        let w = omega;
        let wt = w * dt;
        let s = wt.sin();
        let c = wt.cos();
        #[rustfmt::skip]
        let f = Matrix6::new(
            1.0, 0.0, 0.0, s / w,           (c - 1.0) / w,   0.0,
            0.0, 1.0, 0.0, (1.0 - c) / w,   s / w,           0.0,
            0.0, 0.0, 1.0, 0.0,             0.0,             dt,
            0.0, 0.0, 0.0, c,               -s,              0.0,
            0.0, 0.0, 0.0, s,               c,               0.0,
            0.0, 0.0, 0.0, 0.0,             0.0,             1.0,
        );
        f
    }

    /// Raw predict step: x' = F x; P' = F P Fᵀ + Q*dt (same structure as the CV
    /// predict, only F differs).
    #[inline]
    pub fn predict_raw(&self, state: &mut Vector6<f64>, covariance: &mut Matrix6<f64>, dt: f64) {
        let f = Self::ct_transition_matrix(self.omega, dt);
        *state = f * *state;
        *covariance = f * *covariance * f.transpose() + self.q * dt;
    }

    /// Raw update step — delegated verbatim to the embedded linear filter (the
    /// position-only measurement model is identical to the CV filter's).
    #[inline]
    pub fn update_raw(
        &self,
        state: &mut Vector6<f64>,
        covariance: &mut Matrix6<f64>,
        measurement: &Vector3<f64>,
        r_override: Option<&Matrix3<f64>>,
    ) -> Option<InnovationStats> {
        self.kf_update
            .update_raw(state, covariance, measurement, r_override)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXTENDED KALMAN FILTER
// ═══════════════════════════════════════════════════════════════════════════════

/// Extended Kalman Filter for non-linear measurement models
/// Used when sensors provide polar coordinates (range, azimuth, elevation)
#[derive(Debug)]
pub struct ExtendedKalmanFilter {
    kf: KalmanFilter,
}

impl ExtendedKalmanFilter {
    pub fn new(process_noise: f64, measurement_noise: f64) -> Self {
        Self {
            kf: KalmanFilter::new(process_noise, measurement_noise),
        }
    }

    /// Convert Cartesian state to polar measurement
    fn cartesian_to_polar(state: &Vector6<f64>) -> Vector3<f64> {
        let x = state[0];
        let y = state[1];
        let z = state[2];

        let range = (x * x + y * y + z * z).sqrt();
        let azimuth = y.atan2(x);
        let elevation = if range > 1e-6 {
            (z / range).asin()
        } else {
            0.0
        };

        Vector3::new(range, azimuth, elevation)
    }

    /// Jacobian of polar measurement function
    fn measurement_jacobian(state: &Vector6<f64>) -> nalgebra::Matrix3x6<f64> {
        let x = state[0];
        let y = state[1];
        let z = state[2];

        // Clamp r2 as well as r_xy2: the elevation row divides by r2, so an
        // unclamped r2 at the origin would yield NaN/inf entries.
        let r2 = (x * x + y * y + z * z).max(1e-12);
        let r = r2.sqrt();
        let r_xy2 = (x * x + y * y).max(1e-12);
        let r_xy = r_xy2.sqrt();

        // Jacobian H = d(h(x))/dx
        #[rustfmt::skip]
        let h = nalgebra::Matrix3x6::new(
            // d(range)/d(x,y,z,vx,vy,vz)
            x / r, y / r, z / r, 0.0, 0.0, 0.0,
            // d(azimuth)/d(x,y,z,vx,vy,vz)
            -y / r_xy2, x / r_xy2, 0.0, 0.0, 0.0, 0.0,
            // d(elevation)/d(x,y,z,vx,vy,vz)
            -x * z / (r2 * r_xy), -y * z / (r2 * r_xy), r_xy / r2, 0.0, 0.0, 0.0,
        );
        h
    }

    /// Predict step (operates on TrackState)
    pub fn predict(&self, state: &mut TrackState, dt: f64) {
        self.kf.predict(state, dt);
    }

    /// Update with polar measurement [range, azimuth, elevation]
    pub fn update_polar(
        &self,
        state: &mut TrackState,
        measurement: &Vector3<f64>,
        r: &Matrix3<f64>,
    ) -> Option<InnovationStats> {
        let h = Self::measurement_jacobian(&state.state);

        // Predicted measurement in polar
        let predicted = Self::cartesian_to_polar(&state.state);

        // Innovation with angle wrapping for azimuth
        let mut innovation = measurement - predicted;
        // Wrap azimuth difference to [-π, π]
        while innovation[1] > PI {
            innovation[1] -= 2.0 * PI;
        }
        while innovation[1] < -PI {
            innovation[1] += 2.0 * PI;
        }

        // Innovation covariance
        let s = h * state.covariance * h.transpose() + r;
        // Cholesky solve — same rationale as the KF update.
        let Some(chol) = s.cholesky() else {
            log::warn!(
                "[EKF] Innovation covariance not positive-definite (det={:.2e}), skipping polar update",
                s.determinant()
            );
            return None; // Skip this update rather than corrupt state
        };

        // Kalman gain: K = P Hᵀ S⁻¹  ⇔  Kᵀ = S⁻¹ (H P), P symmetric.
        let k = chol.solve(&(h * state.covariance)).transpose();

        // State update
        state.state += k * innovation;

        // Covariance update: Joseph stabilized form (symmetric + PSD for any
        // gain). H here is the polar measurement Jacobian, so this is the
        // linearized analogue of the KF Joseph update.
        let i = Matrix6::identity();
        let ikh = i - k * h;
        state.covariance = ikh * state.covariance * ikh.transpose() + k * *r * k.transpose();
        Some(InnovationStats {
            innovation,
            innovation_cov: s,
        })
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNSCENTED KALMAN FILTER
// ═══════════════════════════════════════════════════════════════════════════════

/// Unscented Kalman Filter - better for highly non-linear systems
#[derive(Debug)]
pub struct UnscentedKalmanFilter {
    /// State dimension
    n: usize,
    /// UKF parameters
    alpha: f64,
    beta: f64,
    kappa: f64,
    /// Process noise
    q: DMatrix<f64>,
    /// Measurement noise
    r: DMatrix<f64>,
}

impl UnscentedKalmanFilter {
    pub fn new(process_noise: f64, measurement_noise: f64) -> Self {
        let n = 6; // State dimension

        let q = DMatrix::from_diagonal(&DVector::from_vec(vec![
            process_noise * 0.1,
            process_noise * 0.1,
            process_noise * 0.1,
            process_noise,
            process_noise,
            process_noise,
        ]));

        let r = DMatrix::from_diagonal(&DVector::from_vec(vec![
            measurement_noise,
            measurement_noise,
            measurement_noise,
        ]));

        Self {
            n,
            alpha: 1e-3,
            beta: 2.0,
            kappa: 0.0,
            q,
            r,
        }
    }

    /// Generate sigma points
    fn generate_sigma_points(&self, mean: &DVector<f64>, cov: &DMatrix<f64>) -> Vec<DVector<f64>> {
        let lambda = self.alpha.powi(2) * (self.n as f64 + self.kappa) - self.n as f64;
        let scale = ((self.n as f64 + lambda) * cov.clone()).cholesky();

        let mut sigma_points = vec![mean.clone()];

        if let Some(l) = scale {
            let l_matrix = l.l();
            for i in 0..self.n {
                let col = l_matrix.column(i);
                sigma_points.push(mean + col);
                sigma_points.push(mean - col);
            }
        } else {
            // Cholesky decomposition failed - covariance may not be positive definite
            // Fall back to diagonal approximation with warning
            log::warn!(
                "[UKF] Cholesky decomposition failed, using diagonal approximation. \
                 This may indicate numerical issues with the covariance matrix."
            );
            for i in 0..self.n {
                let variance = cov[(i, i)];
                // Ensure non-negative variance
                let std = if variance > 0.0 { variance.sqrt() } else { 1.0 };
                let mut delta = DVector::zeros(self.n);
                delta[i] = std * (self.n as f64 + lambda).sqrt();
                sigma_points.push(mean + &delta);
                sigma_points.push(mean - delta);
            }
        }

        sigma_points
    }

    /// Calculate weights for sigma points
    fn calculate_weights(&self) -> (Vec<f64>, Vec<f64>) {
        let lambda = self.alpha.powi(2) * (self.n as f64 + self.kappa) - self.n as f64;
        let num_points = 2 * self.n + 1;

        let mut wm = vec![lambda / (self.n as f64 + lambda)];
        let mut wc =
            vec![lambda / (self.n as f64 + lambda) + (1.0 - self.alpha.powi(2) + self.beta)];

        let weight = 1.0 / (2.0 * (self.n as f64 + lambda));
        for _ in 1..num_points {
            wm.push(weight);
            wc.push(weight);
        }

        (wm, wc)
    }

    /// State transition function (constant velocity)
    fn state_transition(state: &DVector<f64>, dt: f64) -> DVector<f64> {
        let mut new_state = state.clone();
        new_state[0] += state[3] * dt;
        new_state[1] += state[4] * dt;
        new_state[2] += state[5] * dt;
        new_state
    }

    /// Measurement function (extract Cartesian position from state)
    /// The fusion engine passes Cartesian position measurements, so the
    /// measurement function is simply the identity on the position components.
    fn measurement_function(state: &DVector<f64>) -> DVector<f64> {
        DVector::from_vec(vec![state[0], state[1], state[2]])
    }

    pub fn predict(&self, state: &mut Vector6<f64>, cov: &mut Matrix6<f64>, dt: f64) {
        let state_dyn = DVector::from_column_slice(state.as_slice());
        let cov_dyn = DMatrix::from_fn(6, 6, |i, j| cov[(i, j)]);

        let sigma_points = self.generate_sigma_points(&state_dyn, &cov_dyn);
        let (wm, wc) = self.calculate_weights();

        // Transform sigma points through state transition
        let transformed: Vec<DVector<f64>> = sigma_points
            .iter()
            .map(|sp| Self::state_transition(sp, dt))
            .collect();

        // Calculate predicted mean
        let mut predicted_mean = DVector::zeros(self.n);
        for (sp, w) in transformed.iter().zip(wm.iter()) {
            predicted_mean += sp * *w;
        }

        // Calculate predicted covariance
        let mut predicted_cov = self.q.clone() * dt;
        for (sp, w) in transformed.iter().zip(wc.iter()) {
            let diff = sp - &predicted_mean;
            predicted_cov += &diff * diff.transpose() * *w;
        }

        // Update state
        for i in 0..6 {
            state[i] = predicted_mean[i];
        }
        for i in 0..6 {
            for j in 0..6 {
                cov[(i, j)] = predicted_cov[(i, j)];
            }
        }
    }

    pub fn update(
        &self,
        state: &mut Vector6<f64>,
        cov: &mut Matrix6<f64>,
        measurement: &Vector3<f64>,
        r_override: Option<&DMatrix<f64>>,
    ) -> Option<InnovationStats> {
        let state_dyn = DVector::from_column_slice(state.as_slice());
        let cov_dyn = DMatrix::from_fn(6, 6, |i, j| cov[(i, j)]);
        let meas_dyn = DVector::from_column_slice(measurement.as_slice());

        let sigma_points = self.generate_sigma_points(&state_dyn, &cov_dyn);
        let (wm, wc) = self.calculate_weights();

        // Transform sigma points through measurement function
        let meas_sigma: Vec<DVector<f64>> = sigma_points
            .iter()
            .map(Self::measurement_function)
            .collect();

        // Predicted measurement mean
        let mut meas_mean = DVector::zeros(3);
        for (ms, w) in meas_sigma.iter().zip(wm.iter()) {
            meas_mean += ms * *w;
        }

        // Measurement covariance (per-measurement R when provided, else self.r)
        let mut s = r_override.cloned().unwrap_or_else(|| self.r.clone());
        for (ms, w) in meas_sigma.iter().zip(wc.iter()) {
            let diff = ms - &meas_mean;
            s += &diff * diff.transpose() * *w;
        }

        // Cross-covariance
        let mut pxz = DMatrix::zeros(6, 3);
        for ((sp, ms), w) in sigma_points.iter().zip(meas_sigma.iter()).zip(wc.iter()) {
            let state_diff = sp - &state_dyn;
            let meas_diff = ms - &meas_mean;
            pxz += &state_diff * meas_diff.transpose() * *w;
        }

        // Kalman gain via Cholesky solve: K = Pxz S⁻¹  ⇔  Kᵀ = S⁻¹ Pxzᵀ.
        let Some(chol) = s.clone().cholesky() else {
            log::warn!("[UKF] Measurement covariance not positive-definite, skipping update");
            return None; // Skip this update rather than corrupt state
        };
        let k = chol.solve(&pxz.transpose()).transpose();

        // Innovation
        let innovation = meas_dyn - meas_mean;
        let stats = InnovationStats {
            innovation: Vector3::new(innovation[0], innovation[1], innovation[2]),
            innovation_cov: Matrix3::from_fn(|i, j| s[(i, j)]),
        };

        // Update state
        let state_update = &k * innovation;
        for i in 0..6 {
            state[i] += state_update[i];
        }

        // Update covariance
        let cov_update = &k * s * k.transpose();
        for i in 0..6 {
            for j in 0..6 {
                cov[(i, j)] -= cov_update[(i, j)];
            }
        }

        // Force symmetry to counter round-off drift: the P - K S Kᵀ update is
        // not guaranteed symmetric in finite precision, which is what makes the
        // Cholesky in generate_sigma_points fail. Averaging the off-diagonals
        // restores symmetry; the Cholesky fallback remains the PSD safety net.
        for i in 0..6 {
            for j in (i + 1)..6 {
                let avg = 0.5 * (cov[(i, j)] + cov[(j, i)]);
                cov[(i, j)] = avg;
                cov[(j, i)] = avg;
            }
        }
        Some(stats)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARTICLE FILTER
// ═══════════════════════════════════════════════════════════════════════════════

/// Particle for Sequential Monte Carlo
#[derive(Debug, Clone)]
struct Particle {
    state: Vector6<f64>,
    weight: f64,
}

/// Particle Filter for non-Gaussian, multi-modal distributions
#[derive(Debug)]
pub struct ParticleFilter {
    particles: Vec<Particle>,
    num_particles: usize,
    process_noise: f64,
    measurement_noise: f64,
    // Note: We don't store RNG - create new one each time for thread safety
}

impl ParticleFilter {
    pub fn new(num_particles: usize, process_noise: f64, measurement_noise: f64) -> Self {
        Self {
            particles: Vec::new(),
            num_particles,
            process_noise,
            measurement_noise,
        }
    }

    /// Initialize particles around an initial state
    pub fn initialize(&mut self, initial_state: &Vector6<f64>, initial_cov: &Matrix6<f64>) {
        self.particles.clear();
        let weight = 1.0 / self.num_particles as f64;
        let mut rng = rand::rng();

        // Precompute standard deviations for each state dimension
        // Use fallback std=1.0 if variance is invalid (negative or NaN)
        let stds: Vec<f64> = (0..6)
            .map(|i| {
                let variance = initial_cov[(i, i)];
                if variance > 0.0 && variance.is_finite() {
                    variance.sqrt()
                } else {
                    1.0 // Fallback for invalid variance
                }
            })
            .collect();

        for _p in 0..self.num_particles {
            let mut state = *initial_state;
            for i in 0..6 {
                let sample: f64 = StandardNormal.sample(&mut rng);
                state[i] += sample * stds[i];
            }
            self.particles.push(Particle { state, weight });
        }
    }

    /// Predict step - propagate particles
    pub fn predict(&mut self, dt: f64) {
        // Ensure process_noise is valid for standard-normal scaling
        let noise_std = if self.process_noise > 0.0 && self.process_noise.is_finite() {
            self.process_noise
        } else {
            log::warn!(
                "[ParticleFilter] Invalid process_noise {}, using 1.0",
                self.process_noise
            );
            1.0
        };
        let mut rng = rand::rng();

        for particle in &mut self.particles {
            // Constant velocity motion model with noise
            let position_noise_x: f64 = StandardNormal.sample(&mut rng);
            let position_noise_y: f64 = StandardNormal.sample(&mut rng);
            let position_noise_z: f64 = StandardNormal.sample(&mut rng);
            let velocity_noise_x: f64 = StandardNormal.sample(&mut rng);
            let velocity_noise_y: f64 = StandardNormal.sample(&mut rng);
            let velocity_noise_z: f64 = StandardNormal.sample(&mut rng);
            particle.state[0] += particle.state[3] * dt + position_noise_x * noise_std * dt * 0.1;
            particle.state[1] += particle.state[4] * dt + position_noise_y * noise_std * dt * 0.1;
            particle.state[2] += particle.state[5] * dt + position_noise_z * noise_std * dt * 0.1;
            particle.state[3] += velocity_noise_x * noise_std * dt;
            particle.state[4] += velocity_noise_y * noise_std * dt;
            particle.state[5] += velocity_noise_z * noise_std * dt;
        }
    }

    /// Update step - weight particles based on measurement likelihood
    /// Weight particles by a diagonal-Gaussian likelihood. `r_override` carries the
    /// per-axis measurement *variances* `[vx, vy, vz]`; when `None`, the isotropic
    /// `measurement_noise²` is used (equivalent to the previous behavior).
    pub fn update(&mut self, measurement: &Vector3<f64>, r_override: Option<&Vector3<f64>>) {
        let mn = self.measurement_noise;
        let var = r_override
            .copied()
            .unwrap_or_else(|| Vector3::new(mn * mn, mn * mn, mn * mn));
        // Guard each per-axis variance to a finite positive value.
        let vx = if var[0].is_finite() && var[0] > 1e-9 {
            var[0]
        } else {
            1.0
        };
        let vy = if var[1].is_finite() && var[1] > 1e-9 {
            var[1]
        } else {
            1.0
        };
        let vz = if var[2].is_finite() && var[2] > 1e-9 {
            var[2]
        } else {
            1.0
        };

        for particle in &mut self.particles {
            let dx = particle.state[0] - measurement[0];
            let dy = particle.state[1] - measurement[1];
            let dz = particle.state[2] - measurement[2];

            let dist_sq = dx * dx / vx + dy * dy / vy + dz * dz / vz;
            let likelihood = (-0.5 * dist_sq).exp();
            particle.weight *= likelihood;
        }

        // Normalize weights
        let weight_sum: f64 = self.particles.iter().map(|p| p.weight).sum();
        if weight_sum > 1e-10 {
            for particle in &mut self.particles {
                particle.weight /= weight_sum;
            }
        } else {
            // Reset to uniform if all weights are near zero
            let uniform = 1.0 / self.num_particles as f64;
            for particle in &mut self.particles {
                particle.weight = uniform;
            }
        }
    }

    /// Resample particles using systematic resampling
    pub fn resample(&mut self) {
        // Calculate effective sample size
        let weight_sq_sum: f64 = self.particles.iter().map(|p| p.weight * p.weight).sum();
        let n_eff = 1.0 / weight_sq_sum;

        // Only resample if effective sample size is too low
        if n_eff < self.num_particles as f64 / 2.0 {
            let mut rng = rand::rng();
            let mut cumulative = Vec::with_capacity(self.num_particles);
            let mut sum = 0.0;
            for particle in &self.particles {
                sum += particle.weight;
                cumulative.push(sum);
            }

            let step = 1.0 / self.num_particles as f64;
            let start: f64 = rng.random::<f64>() * step;

            let mut new_particles = Vec::with_capacity(self.num_particles);
            let uniform_weight = 1.0 / self.num_particles as f64;

            for i in 0..self.num_particles {
                let target = start + i as f64 * step;
                let idx = cumulative
                    .partition_point(|&x| x < target)
                    .min(self.num_particles - 1);
                new_particles.push(Particle {
                    state: self.particles[idx].state,
                    weight: uniform_weight,
                });
            }

            self.particles = new_particles;
        }
    }

    /// Get estimated state (weighted mean)
    pub fn get_estimate(&self) -> (Vector6<f64>, Matrix6<f64>) {
        let mut mean = Vector6::zeros();
        for particle in &self.particles {
            mean += particle.state * particle.weight;
        }

        // Calculate covariance
        let mut cov = Matrix6::zeros();
        for particle in &self.particles {
            let diff = particle.state - mean;
            cov += diff * diff.transpose() * particle.weight;
        }

        (mean, cov)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERACTING MULTIPLE MODEL (IMM) FILTER
// ═══════════════════════════════════════════════════════════════════════════════

/// Motion model types for IMM
#[expect(dead_code)]
#[derive(Debug, Clone, Copy)]
pub enum MotionModel {
    /// Constant velocity (CV)
    ConstantVelocity,
    /// Constant acceleration (CA)
    ConstantAcceleration,
    /// Coordinated turn (CT)
    CoordinatedTurn,
}

/// IMM Filter for maneuvering target tracking
#[derive(Debug)]
pub struct IMMFilter {
    /// Constant-velocity model (mode 0).
    kf_cv: KalmanFilter,
    /// Coordinated-turn model (mode 1).
    ct: CoordinatedTurnFilter,
    /// Model probabilities [CV, CT]
    model_probs: [f64; 2],
    /// Markov transition matrix
    transition_matrix: [[f64; 2]; 2],
    /// State estimates for each model
    states: [Vector6<f64>; 2],
    /// Covariances for each model
    covariances: [Matrix6<f64>; 2],
}

impl IMMFilter {
    pub fn new(process_noise: f64, measurement_noise: f64) -> Self {
        // CV is the low-maneuver hypothesis (tighter Q); CT captures the turn
        // structurally via F, so it only needs a modest 1.0x Q (slightly above CV)
        // to absorb the gap between the true and assumed turn rate.
        let kf_cv = KalmanFilter::new(process_noise * 0.5, measurement_noise);
        let ct = CoordinatedTurnFilter::new(process_noise * 1.0, measurement_noise, OMEGA_CT);

        Self {
            kf_cv,
            ct,
            model_probs: [0.8, 0.2], // Start with high probability of CV
            transition_matrix: [
                [0.95, 0.05], // CV -> CV, CV -> CT
                [0.10, 0.90], // CT -> CV, CT -> CT
            ],
            states: [Vector6::zeros(), Vector6::zeros()],
            covariances: [Matrix6::identity() * 10.0, Matrix6::identity() * 10.0],
        }
    }

    /// Initialize with a state
    pub fn initialize(&mut self, state: &Vector6<f64>, cov: &Matrix6<f64>) {
        self.states[0] = *state;
        self.states[1] = *state;
        self.covariances[0] = *cov;
        self.covariances[1] = *cov;
    }

    /// IMM mixing step
    fn mix(&mut self) {
        // Calculate mixing probabilities
        let mut c = [0.0; 2];
        for (j, c_j) in c.iter_mut().enumerate() {
            for (prob, trans_row) in self.model_probs.iter().zip(self.transition_matrix.iter()) {
                *c_j += trans_row[j] * prob;
            }
        }

        // Calculate mixed states and covariances
        let mut mixed_states = [Vector6::zeros(), Vector6::zeros()];
        let mut mixed_covs = [Matrix6::zeros(), Matrix6::zeros()];

        for j in 0..2 {
            if c[j] < 1e-10 {
                // Degenerate mixing weight: no probability flows into mode j
                // this step, so keep its prior state/covariance instead of
                // overwriting the mode with the zeroed accumulator.
                mixed_states[j] = self.states[j];
                mixed_covs[j] = self.covariances[j];
                continue;
            }

            for i in 0..2 {
                let mu = self.transition_matrix[i][j] * self.model_probs[i] / c[j];
                mixed_states[j] += self.states[i] * mu;
            }

            for i in 0..2 {
                let mu = self.transition_matrix[i][j] * self.model_probs[i] / c[j];
                let diff = self.states[i] - mixed_states[j];
                mixed_covs[j] += (self.covariances[i] + diff * diff.transpose()) * mu;
            }
        }

        self.states = mixed_states;
        self.covariances = mixed_covs;
    }

    /// Predict step
    pub fn predict(&mut self, dt: f64) {
        self.mix();

        // Predict each model using raw methods (zero allocation)
        self.kf_cv
            .predict_raw(&mut self.states[0], &mut self.covariances[0], dt);
        self.ct
            .predict_raw(&mut self.states[1], &mut self.covariances[1], dt);
    }

    /// Update step
    pub fn update(&mut self, measurement: &Vector3<f64>, r: Option<&Matrix3<f64>>) -> bool {
        let h = KalmanFilter::measurement_matrix();
        // Per-measurement R when provided, else the shared CV-model R.
        let rr = r.unwrap_or(&self.kf_cv.r);

        // Calculate likelihoods for each model
        let mut likelihoods = [0.0; 2];

        for ((likelihood, state), cov) in likelihoods
            .iter_mut()
            .zip(self.states.iter())
            .zip(self.covariances.iter())
        {
            let predicted = h * state;
            let innovation = measurement - predicted;
            let s = h * cov * h.transpose() + *rr;

            if let Some(chol) = s.cholesky() {
                let mahalanobis = innovation.dot(&chol.solve(&innovation));
                let det = s.determinant().max(1e-10);
                // Correct normalizer for a 3-D innovation is sqrt((2π)^3 · det(S)).
                // The previous (2π·det)^½ was the 1-D form; it is a model-independent
                // constant that cancels in the IMM probability normalization, so this
                // is a correctness/clarity fix that also future-proofs per-model R.
                let norm = ((2.0 * PI).powi(3) * det).sqrt();
                *likelihood = (-0.5 * mahalanobis).exp() / norm;
            }
        }

        // Update model probabilities
        let mut c_bar = 0.0;
        for (j, &likelihood) in likelihoods.iter().enumerate() {
            let c: f64 = self
                .model_probs
                .iter()
                .zip(self.transition_matrix.iter())
                .map(|(prob, trans_row)| trans_row[j] * prob)
                .sum();
            c_bar += likelihood * c;
        }

        if c_bar > 1e-10 {
            let old_probs = self.model_probs;
            for (j, (&likelihood, prob_out)) in likelihoods
                .iter()
                .zip(self.model_probs.iter_mut())
                .enumerate()
            {
                let c: f64 = old_probs
                    .iter()
                    .zip(self.transition_matrix.iter())
                    .map(|(prob, trans_row)| trans_row[j] * prob)
                    .sum();
                *prob_out = likelihood * c / c_bar;
            }
        }

        // Update each filter using raw methods (zero allocation)
        let cv_applied = self
            .kf_cv
            .update_raw(
                &mut self.states[0],
                &mut self.covariances[0],
                measurement,
                Some(rr),
            )
            .is_some();
        // Update the CT mode with the SAME per-measurement R used for its
        // likelihood (line above) and for the CV mode — otherwise a per-measurement
        // R override would score the CT mode with one R but update it with the
        // embedded static R, an IMM cross-mode inconsistency.
        let ct_applied = self
            .ct
            .update_raw(
                &mut self.states[1],
                &mut self.covariances[1],
                measurement,
                Some(rr),
            )
            .is_some();

        cv_applied || ct_applied
    }

    /// Get combined state estimate
    pub fn get_estimate(&self) -> (Vector6<f64>, Matrix6<f64>) {
        let mut combined_state = Vector6::zeros();
        for i in 0..2 {
            combined_state += self.states[i] * self.model_probs[i];
        }

        let mut combined_cov = Matrix6::zeros();
        for i in 0..2 {
            let diff = self.states[i] - combined_state;
            combined_cov += (self.covariances[i] + diff * diff.transpose()) * self.model_probs[i];
        }

        (combined_state, combined_cov)
    }

    /// Get model probabilities [CV, CT]
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn get_model_probabilities(&self) -> [f64; 2] {
        self.model_probs
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-SENSOR FUSION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

/// Filter algorithm selection
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[allow(clippy::upper_case_acronyms)] // IMM is standard acronym for Interacting Multiple Model
pub enum FilterAlgorithm {
    Kalman,
    ExtendedKalman,
    UnscentedKalman,
    Particle,
    IMM,
}

/// Multi-sensor fusion configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FusionConfig {
    pub algorithm: FilterAlgorithm,
    pub process_noise: f64,
    pub measurement_noise: f64,
    pub association_threshold: f64,
    pub max_missed_detections: u32,
    pub min_confirmation_hits: u32,
    /// Sliding-window width N for M-of-N confirmation/deletion.
    #[serde(default = "default_confirmation_window")]
    pub confirmation_window: u32,
    /// Position-block covariance determinant ceiling (m⁶); tracks whose volume
    /// exceeds this are deleted as diverged.
    #[serde(default = "default_max_position_cov_volume")]
    pub max_position_cov_volume: f64,
    pub particle_count: usize,
    /// Emit one `PidObservation` per associated measurement that actually
    /// updated the filter (the galadriel sidecar contract); drained via
    /// `drain_pid_observations`. Off by default — instrumentation must be
    /// asked for. Not emitted under Particle (no innovation covariance
    /// exists) or IMM (per-model updates only; a combined-estimate record is
    /// future work) — see `docs/SENSOR_FUSION.md`.
    #[serde(default)]
    pub emit_innovations: bool,
    /// Also attach the raw innovation `y` and covariance `S` (research mode)
    /// to emitted records. Radar carries the polar frame under the EKF and
    /// the Cartesian conversion frame otherwise; `nis`/`dof` are
    /// frame-agnostic either way.
    #[serde(default)]
    pub emit_innovation_research: bool,
}

fn default_confirmation_window() -> u32 {
    5
}

fn default_max_position_cov_volume() -> f64 {
    1e6
}

impl Default for FusionConfig {
    fn default() -> Self {
        Self {
            algorithm: FilterAlgorithm::ExtendedKalman,
            process_noise: 1.0,
            measurement_noise: 2.0,
            association_threshold: 11.345, // χ²(3) gate on squared Mahalanobis distance (≈99%)
            max_missed_detections: 5,
            min_confirmation_hits: 3,
            confirmation_window: 5,
            max_position_cov_volume: 1e6,
            particle_count: 100,
            emit_innovations: false,
            emit_innovation_research: false,
        }
    }
}

fn validate_finite_range(name: &str, value: f64, min: f64, max: f64) -> Result<(), String> {
    if !value.is_finite() || value < min || value > max {
        return Err(format!(
            "{} must be finite and within [{}, {}], got {}",
            name, min, max, value
        ));
    }
    Ok(())
}

fn validate_finite_array(name: &str, values: &[f64; 3]) -> Result<(), String> {
    for (index, value) in values.iter().enumerate() {
        if !value.is_finite() {
            return Err(format!("{}[{}] must be finite", name, index));
        }
    }
    Ok(())
}

fn validate_bounded_text(name: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{} must not be empty", name));
    }
    if value.len() > MAX_FUSION_STRING_LEN {
        return Err(format!(
            "{} too long: {} bytes exceeds maximum {}",
            name,
            value.len(),
            MAX_FUSION_STRING_LEN
        ));
    }
    if value.contains('\0') {
        return Err(format!("{} must not contain null bytes", name));
    }
    Ok(())
}

pub fn validate_fusion_config(config: &FusionConfig) -> Result<(), String> {
    validate_finite_range(
        "process_noise",
        config.process_noise,
        f64::EPSILON,
        MAX_FUSION_NOISE,
    )?;
    validate_finite_range(
        "measurement_noise",
        config.measurement_noise,
        f64::EPSILON,
        MAX_FUSION_NOISE,
    )?;
    validate_finite_range(
        "association_threshold",
        config.association_threshold,
        f64::EPSILON,
        MAX_ASSOCIATION_THRESHOLD,
    )?;
    if config.max_missed_detections == 0 || config.max_missed_detections > MAX_MISSED_DETECTIONS {
        return Err(format!(
            "max_missed_detections must be within [1, {}], got {}",
            MAX_MISSED_DETECTIONS, config.max_missed_detections
        ));
    }
    if config.min_confirmation_hits == 0 || config.min_confirmation_hits > MAX_CONFIRMATION_HITS {
        return Err(format!(
            "min_confirmation_hits must be within [1, {}], got {}",
            MAX_CONFIRMATION_HITS, config.min_confirmation_hits
        ));
    }
    if config.confirmation_window < MIN_CONFIRMATION_WINDOW
        || config.confirmation_window > MAX_CONFIRMATION_WINDOW
    {
        return Err(format!(
            "confirmation_window must be within [{}, {}], got {}",
            MIN_CONFIRMATION_WINDOW, MAX_CONFIRMATION_WINDOW, config.confirmation_window
        ));
    }
    if config.min_confirmation_hits > config.confirmation_window {
        return Err(format!(
            "min_confirmation_hits must be <= confirmation_window, got {} > {}",
            config.min_confirmation_hits, config.confirmation_window
        ));
    }
    if config.max_missed_detections > config.confirmation_window {
        return Err(format!(
            "max_missed_detections must be <= confirmation_window, got {} > {}",
            config.max_missed_detections, config.confirmation_window
        ));
    }
    validate_finite_range(
        "max_position_cov_volume",
        config.max_position_cov_volume,
        f64::EPSILON,
        f64::MAX,
    )?;
    if config.particle_count == 0 || config.particle_count > MAX_FUSION_PARTICLE_COUNT {
        return Err(format!(
            "particle_count must be within [1, {}], got {}",
            MAX_FUSION_PARTICLE_COUNT, config.particle_count
        ));
    }
    Ok(())
}

pub fn validate_sensor_measurements(measurements: &[SensorMeasurement]) -> Result<(), String> {
    if measurements.len() > MAX_FUSION_MEASUREMENTS_PER_BATCH {
        return Err(format!(
            "Too many sensor measurements: {} exceeds maximum {}",
            measurements.len(),
            MAX_FUSION_MEASUREMENTS_PER_BATCH
        ));
    }

    for (index, measurement) in measurements.iter().enumerate() {
        validate_bounded_text(
            &format!("measurements[{}].sensor_id", index),
            &measurement.sensor_id,
        )?;
        validate_bounded_text(
            &format!("measurements[{}].class_label", index),
            &measurement.class_label,
        )?;
        validate_finite_array(
            &format!("measurements[{}].position", index),
            &measurement.position,
        )?;
        validate_finite_array(
            &format!("measurements[{}].covariance", index),
            &measurement.covariance,
        )?;
        // Zero/negative variances are not physical and break the PSD guarantee
        // of the Joseph-form update (R must be positive-definite).
        for (axis, &variance) in measurement.covariance.iter().enumerate() {
            if variance <= 0.0 {
                return Err(format!(
                    "measurements[{}].covariance[{}] must be > 0, got {}",
                    index, axis, variance
                ));
            }
        }
        if measurement.modality == SensorModality::Radar {
            // Radar position is polar [range m, azimuth rad, elevation rad];
            // enforce the polar domain the EKF update linearizes around.
            validate_finite_range(
                &format!("measurements[{}].position[0] (radar range)", index),
                measurement.position[0],
                0.0,
                f64::MAX,
            )?;
            validate_finite_range(
                &format!("measurements[{}].position[1] (radar azimuth)", index),
                measurement.position[1],
                -MAX_RADAR_AZIMUTH_RAD,
                MAX_RADAR_AZIMUTH_RAD,
            )?;
            validate_finite_range(
                &format!("measurements[{}].position[2] (radar elevation)", index),
                measurement.position[2],
                -MAX_RADAR_ELEVATION_RAD,
                MAX_RADAR_ELEVATION_RAD,
            )?;
        }
        if let Some(velocity) = &measurement.velocity {
            validate_finite_array(&format!("measurements[{}].velocity", index), velocity)?;
        }
        validate_finite_range(
            &format!("measurements[{}].confidence", index),
            measurement.confidence,
            0.0,
            1.0,
        )?;
        if measurement.metadata.len() > MAX_FUSION_METADATA_ENTRIES {
            return Err(format!(
                "measurements[{}].metadata has {} entries, maximum {}",
                index,
                measurement.metadata.len(),
                MAX_FUSION_METADATA_ENTRIES
            ));
        }
        for (key, value) in &measurement.metadata {
            validate_bounded_text(&format!("measurements[{}].metadata key", index), key)?;
            if !value.is_finite() {
                return Err(format!(
                    "measurements[{}].metadata['{}'] must be finite",
                    index, key
                ));
            }
        }
    }

    Ok(())
}

/// Multi-sensor fusion engine
pub struct MultiSensorFusion {
    config: FusionConfig,
    tracks: HashMap<String, TrackState>,
    kf: KalmanFilter,
    ekf: ExtendedKalmanFilter,
    ukf: UnscentedKalmanFilter,
    particle_filters: HashMap<String, ParticleFilter>,
    imm_filters: HashMap<String, IMMFilter>,
    next_track_id: u64,
    frame_count: u64,
    last_predict_ms: u64,
    /// Per-measurement innovation records pending collection
    /// (`config.emit_innovations`); drained by `drain_pid_observations`.
    pid_buffer: Vec<crate::pid_observation::PidObservation>,
}

impl MultiSensorFusion {
    pub fn new(config: FusionConfig) -> Self {
        Self {
            kf: KalmanFilter::new(config.process_noise, config.measurement_noise),
            ekf: ExtendedKalmanFilter::new(config.process_noise, config.measurement_noise),
            ukf: UnscentedKalmanFilter::new(config.process_noise, config.measurement_noise),
            particle_filters: HashMap::new(),
            imm_filters: HashMap::new(),
            config,
            tracks: HashMap::new(),
            next_track_id: 1,
            frame_count: 0,
            last_predict_ms: 0,
            pid_buffer: Vec::new(),
        }
    }

    /// Process a batch of measurements from multiple sensors
    pub fn process_measurements(
        &mut self,
        measurements: Vec<SensorMeasurement>,
        timestamp_ms: u64,
    ) -> Vec<TrackOutput> {
        self.frame_count = self.frame_count.saturating_add(1);

        // Step 1: Predict all tracks forward.
        // dt comes from real timestamps. Non-increasing timestamps (first frame,
        // duplicates, out-of-order replays) yield dt = 0: no phantom predict / Q
        // inflation, and the predict clock only ever advances monotonically.
        //
        // A gap longer than one frame is integrated in ≤1 s SUBSTEPS rather than
        // truncated: the old `min(gap, 1.0)` clamp advanced the clock by the full
        // gap but the state by at most 1 s, leaving the covariance uninflated for
        // the unmodeled remainder — after a multi-second dropout the next
        // association then gated against a mis-timed, overconfident prior.
        // Substepping keeps each linearization step small while covering the
        // whole gap (for the linear CV model the transition composes exactly and
        // Q accumulates per substep). The total is capped: a track coasting
        // longer than MAX_PREDICT_GAP_S has Q-inflated toward the
        // covariance-volume divergence gate anyway, and the cap bounds work on
        // wall-clock jumps (suspend/resume).
        let gap_s = if self.last_predict_ms > 0 && timestamp_ms > self.last_predict_ms {
            ((timestamp_ms - self.last_predict_ms) as f64 / 1000.0).min(MAX_PREDICT_GAP_S)
        } else {
            0.0
        };
        self.last_predict_ms = self.last_predict_ms.max(timestamp_ms);
        let mut remaining_s = gap_s;
        while remaining_s > 0.0 {
            let dt = remaining_s.min(1.0);
            self.predict_all(dt);
            remaining_s -= dt;
        }

        // Step 2: Associate measurements to tracks
        let (associations, unassociated) = self.associate_measurements(&measurements);

        // Snapshot the pre-existing track IDs so that tracks BORN this frame can be
        // distinguished from carried-over tracks below.
        let preexisting_ids: std::collections::HashSet<String> =
            self.tracks.keys().cloned().collect();

        // Step 3: Update associated tracks. Record only IDs whose filter actually
        // accepted at least one update THIS frame, so a singular/rejected update
        // cannot become lifecycle evidence. The explicit per-frame set remains
        // robust when consecutive frames reuse a timestamp.
        let mut hit_this_frame: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for (track_id, meas_indices) in associations {
            if self.update_track(&track_id, &measurements, &meas_indices, timestamp_ms) {
                hit_this_frame.insert(track_id);
            }
        }

        // Step 4: Create new tracks from unassociated measurements
        for meas_idx in unassociated {
            if self.tracks.len() >= MAX_FUSION_TRACKS {
                break;
            }
            self.create_track(&measurements[meas_idx], timestamp_ms);
        }

        // A track born this frame (an ID not present before Step 3) registers its
        // birth as a hit, so its initial window bit is set exactly once.
        for id in self.tracks.keys() {
            if !preexisting_ids.contains(id) {
                hit_this_frame.insert(id.clone());
            }
        }

        // Step 4.5: Update each track's sliding M-of-N hit window. This runs once
        // per track per frame, AFTER association (so the per-frame hit/miss is
        // known) and BEFORE confirm/delete decisions in the lifecycle pass.
        self.update_hit_history(&hit_this_frame);

        // Step 5: Handle missed detections and prune dead tracks
        self.handle_missed_detections(timestamp_ms);

        // Step 6: Return track outputs
        self.tracks.values().map(TrackOutput::from).collect()
    }

    fn predict_all(&mut self, dt: f64) {
        for track in self.tracks.values_mut() {
            match self.config.algorithm {
                FilterAlgorithm::Kalman => {
                    self.kf.predict(track, dt);
                }
                FilterAlgorithm::ExtendedKalman => {
                    self.ekf.predict(track, dt);
                }
                FilterAlgorithm::UnscentedKalman => {
                    self.ukf
                        .predict(&mut track.state, &mut track.covariance, dt);
                }
                FilterAlgorithm::Particle => {
                    if let Some(pf) = self.particle_filters.get_mut(&track.id) {
                        pf.predict(dt);
                        let (mean, cov) = pf.get_estimate();
                        track.state = mean;
                        track.covariance = cov;
                    }
                }
                FilterAlgorithm::IMM => {
                    if let Some(imm) = self.imm_filters.get_mut(&track.id) {
                        imm.predict(dt);
                        let (mean, cov) = imm.get_estimate();
                        track.state = mean;
                        track.covariance = cov;
                    }
                }
            }
        }
    }

    /// Squared Mahalanobis distance d² = diffᵀ S⁻¹ diff between a measurement and a
    /// track, gated against the χ²(3) `association_threshold`. Returns `Some(d²)` when
    /// in-gate, `None` otherwise. `r_cart` is the measurement noise already expressed
    /// in the Cartesian frame (see [`measurement_r_cartesian`]). This is the single
    /// gate seam shared by clustering, the assignment cost matrix, and the χ² gate.
    fn gated_sq_mahalanobis(
        &self,
        track: &TrackState,
        meas_pos: &Vector3<f64>,
        r_cart: &Matrix3<f64>,
    ) -> Option<f64> {
        let track_pos = Vector3::new(track.state[0], track.state[1], track.state[2]);
        let diff = meas_pos - track_pos;
        let pos_cov = Matrix3::new(
            track.covariance[(0, 0)],
            track.covariance[(0, 1)],
            track.covariance[(0, 2)],
            track.covariance[(1, 0)],
            track.covariance[(1, 1)],
            track.covariance[(1, 2)],
            track.covariance[(2, 0)],
            track.covariance[(2, 1)],
            track.covariance[(2, 2)],
        );
        let s = pos_cov + r_cart;
        let d2 = match s.cholesky() {
            Some(chol) => diff.dot(&chol.solve(&diff)),
            None => {
                diff.norm_squared() / (NOMINAL_ASSOCIATION_SIGMA_M * NOMINAL_ASSOCIATION_SIGMA_M)
            }
        };
        (d2 < self.config.association_threshold).then_some(d2)
    }

    /// Cluster co-located, same-class measurements into "super-measurements" via
    /// union-find, so that N sensors observing one target in a frame produce ONE
    /// cluster (and thus all update one track). The pairwise gate is the squared
    /// Mahalanobis distance vs `MEAS_CLUSTER_GATE`, built from the caller-supplied
    /// Jacobian-converted **Cartesian** covariances (`r_carts`, see
    /// [`measurement_r_cartesian`]) — the distances are Cartesian metres, so radar's
    /// raw polar `[m², rad², rad²]` noise would mix units and make radar returns
    /// effectively never merge. Output is deterministic: member indices ascending,
    /// clusters ordered by smallest member.
    fn cluster_measurements(
        &self,
        measurements: &[SensorMeasurement],
        meas_pos: &[Vector3<f64>],
        r_carts: &[Matrix3<f64>],
    ) -> Vec<Vec<usize>> {
        let n = measurements.len();
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(p: &mut [usize], mut x: usize) -> usize {
            while p[x] != x {
                p[x] = p[p[x]];
                x = p[x];
            }
            x
        }
        for i in 0..n {
            for j in (i + 1)..n {
                if measurements[i].class_label != measurements[j].class_label {
                    continue;
                }
                let diff = meas_pos[i] - meas_pos[j];
                let s = r_carts[i] + r_carts[j];
                let d2 = match s.cholesky() {
                    Some(chol) => diff.dot(&chol.solve(&diff)),
                    None => {
                        diff.norm_squared()
                            / (NOMINAL_ASSOCIATION_SIGMA_M * NOMINAL_ASSOCIATION_SIGMA_M)
                    }
                };
                if d2 <= MEAS_CLUSTER_GATE {
                    let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                    if ri != rj {
                        parent[ri] = rj;
                    }
                }
            }
        }
        let mut groups: std::collections::BTreeMap<usize, Vec<usize>> =
            std::collections::BTreeMap::new();
        for idx in 0..n {
            let root = find(&mut parent, idx);
            groups.entry(root).or_default().push(idx);
        }
        let mut clusters: Vec<Vec<usize>> = groups.into_values().collect();
        clusters.sort_by_key(|c| c[0]);
        clusters
    }

    /// Global nearest-neighbour association. Replaces the old order-dependent greedy
    /// per-measurement loop with: (1) cluster co-located same-class returns, (2) solve
    /// a one-to-one cluster↔track assignment minimizing total gated d² (Kuhn–Munkres),
    /// class-gated so a cluster only competes for tracks of a compatible tactical
    /// class, (3) emit each assigned cluster's in-gate member indices to its track.
    /// Unassigned
    /// clusters become new tracks; unassigned tracks coast. The
    /// `(HashMap<track, Vec<idx>>, Vec<idx>)` contract is unchanged.
    fn associate_measurements(
        &self,
        measurements: &[SensorMeasurement],
    ) -> (HashMap<String, Vec<usize>>, Vec<usize>) {
        let mut associations: HashMap<String, Vec<usize>> = HashMap::new();
        let mut unassociated: Vec<usize> = Vec::new();

        let meas_pos: Vec<Vector3<f64>> = measurements
            .iter()
            .map(measurement_position_cartesian)
            .collect();
        let r_carts: Vec<Matrix3<f64>> = measurements
            .iter()
            .zip(&meas_pos)
            .map(|(m, p)| measurement_r_cartesian(m, p))
            .collect();

        let clusters = self.cluster_measurements(measurements, &meas_pos, &r_carts);
        if clusters.is_empty() {
            return (associations, unassociated);
        }

        // Canonical tactical class per cluster (every member shares one raw label
        // by construction of the clustering class gate), used to class-gate the
        // cluster↔track assignment below.
        let cluster_kinds: Vec<DetectionClassKind> = clusters
            .iter()
            .map(|cl| map_to_detection_class(&measurements[cl[0]].class_label))
            .collect();

        // An unassigned cluster seeds ONE new track from its lowest-noise member (the
        // rest re-associate next frame), so a brand-new target seen by several sensors
        // at once does not spawn a duplicate track per sensor. Caveat: if an EXISTING
        // target's cluster is gated out of all tracks (e.g. the track drifted), the
        // non-representative members are dropped for that frame rather than seeding —
        // an accepted v1 trade-off (no over-spawning) revisited with adaptive gating.
        let cluster_representative = |cl: &[usize]| -> usize {
            // Unit-correct "lowest noise": the CARTESIAN R trace, not the raw
            // covariance triple (radar's [m², rad², rad²] summed against
            // Cartesian [m², m², m²] made radar look near-noiseless and win
            // birth-representative slots over genuinely tighter sensors).
            *cl.iter()
                .min_by(|&&a, &&b| {
                    let ta = {
                        let pos = measurement_position_cartesian(&measurements[a]);
                        measurement_r_cartesian(&measurements[a], &pos).trace()
                    };
                    let tb = {
                        let pos = measurement_position_cartesian(&measurements[b]);
                        measurement_r_cartesian(&measurements[b], &pos).trace()
                    };
                    ta.partial_cmp(&tb)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(a.cmp(&b))
                })
                .expect("clusters are non-empty")
        };

        // Deterministic row order (sorted, live track ids).
        let mut track_ids: Vec<String> = self
            .tracks
            .iter()
            .filter(|(_, t)| t.state_label != TrackStateLabel::Lost)
            .map(|(id, _)| id.clone())
            .collect();
        track_ids.sort();

        if track_ids.is_empty() {
            for cl in &clusters {
                unassociated.push(cluster_representative(cl));
            }
            return (associations, unassociated);
        }

        // Cost[r][c] = min gated d² over cluster c's in-gate members for track r,
        // quantized; ASSIGNMENT_INF if the cluster's tactical class is incompatible
        // with the track's (mirroring the clustering class gate, so e.g. a 'bird'
        // cluster can never be assigned to a 'drone' track) or no member is in-gate.
        let cost: Vec<Vec<i64>> = track_ids
            .iter()
            .map(|tid| {
                let track = &self.tracks[tid];
                let track_kind = map_to_detection_class(&track.class_label);
                clusters
                    .iter()
                    .zip(&cluster_kinds)
                    .map(|(cl, &cluster_kind)| {
                        if cluster_kind != track_kind {
                            return ASSIGNMENT_INF;
                        }
                        cl.iter()
                            .filter_map(|&m| {
                                self.gated_sq_mahalanobis(track, &meas_pos[m], &r_carts[m])
                            })
                            .map(|d2| (d2 * ASSIGNMENT_QUANTIZE_SCALE).round() as i64)
                            .min()
                            .unwrap_or(ASSIGNMENT_INF)
                    })
                    .collect()
            })
            .collect();

        let assignment = solve_assignment(&cost, ASSIGNMENT_INF);
        let mut cluster_used = vec![false; clusters.len()];
        for (r, opt_c) in assignment.iter().enumerate() {
            if let Some(c) = *opt_c {
                if cost[r][c] < ASSIGNMENT_INF {
                    // Hand the track only the cluster members that individually
                    // pass ITS gate — a member can sit inside the pairwise cluster
                    // gate yet be far outside this track's gate, and fusing it
                    // would drag the estimate. A finite cost guarantees at least
                    // one in-gate member; the representative fallback is belt and
                    // braces.
                    let track = &self.tracks[&track_ids[r]];
                    let mut members: Vec<usize> = clusters[c]
                        .iter()
                        .copied()
                        .filter(|&m| {
                            self.gated_sq_mahalanobis(track, &meas_pos[m], &r_carts[m])
                                .is_some()
                        })
                        .collect();
                    if members.is_empty() {
                        members.push(cluster_representative(&clusters[c]));
                    }
                    associations
                        .entry(track_ids[r].clone())
                        .or_default()
                        .extend(members);
                    cluster_used[c] = true;
                }
            }
        }
        for (c, cl) in clusters.iter().enumerate() {
            if !cluster_used[c] {
                unassociated.push(cluster_representative(cl));
            }
        }

        (associations, unassociated)
    }

    fn update_track(
        &mut self,
        track_id: &str,
        measurements: &[SensorMeasurement],
        meas_indices: &[usize],
        timestamp_ms: u64,
    ) -> bool {
        let track = match self.tracks.get_mut(track_id) {
            Some(t) => t,
            None => return false,
        };

        // Sequential per-sensor information-form fusion. Apply each associated
        // measurement ONE AT A TIME through the active filter, each with its OWN
        // measurement noise R — not a single confidence-weighted average. Detector
        // confidence is no longer a fusion weight (confidence ≠ precision): a
        // centimetre-accurate lidar and a coarse acoustic return are now combined by
        // their covariances, not by which detector was more confident. For the
        // linear-Gaussian case, sequentially applying conditionally-independent
        // measurements equals the batch information-form fuse and is order-independent;
        // we still order lowest-noise-first for deterministic, well-linearized results.
        let mut sensor_sources: Vec<SensorModality> = Vec::new();
        let mut max_confidence: f64 = 0.0;
        let mut best_label: Option<&str> = None;
        for &idx in meas_indices {
            let meas = &measurements[idx];
            if !sensor_sources.contains(&meas.modality) {
                sensor_sources.push(meas.modality);
            }
            if best_label.is_none() || meas.confidence > max_confidence {
                best_label = Some(&meas.class_label);
            }
            max_confidence = max_confidence.max(meas.confidence);
        }

        let mut ordered = meas_indices.to_vec();
        // Order lowest-noise-first by the CARTESIAN R trace: summing the raw
        // covariance triple compared radar's [m², rad², rad²] against Cartesian
        // [m², m², m²], making radar look near-noiseless and win the
        // first-update (best-linearization) slot over genuinely tighter sensors.
        let cartesian_trace = |idx: usize| -> f64 {
            let meas = &measurements[idx];
            let pos = measurement_position_cartesian(meas);
            measurement_r_cartesian(meas, &pos).trace()
        };
        let traces: std::collections::HashMap<usize, f64> = meas_indices
            .iter()
            .map(|&idx| (idx, cartesian_trace(idx)))
            .collect();
        ordered.sort_by(|&a, &b| {
            traces[&a]
                .partial_cmp(&traces[&b])
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // For the Kalman family, `InnovationStats` doubles as the update-success
        // signal. PF/IMM do not expose innovation stats, so their map/update path
        // reports success separately. Missing per-track state is a failed update,
        // never evidence for the lifecycle hit window.
        let mut any_applied = false;
        // The galadriel sidecar contract keys per-channel streams by (track,
        // modality) with strictly increasing `seq`, and `seq` is stamped with the
        // fusion frame count — so at most ONE record per modality may be emitted
        // per frame. Association clusters by class label and gate (not modality),
        // so one cluster can carry several same-modality returns; emit only the
        // first (lowest-noise, best-linearized, measured against the frame's
        // incoming prior) and keep applying the rest to the filter without
        // emitting — a second record would carry a duplicate (track, modality,
        // seq) identity that galadriel rejects as a replay.
        let mut emitted_modalities: Vec<SensorModality> = Vec::new();
        for &idx in &ordered {
            let meas = &measurements[idx];
            let pos = measurement_position_cartesian(meas);
            // Innovation statistics of THIS measurement's update, when the
            // active filter exposes them and the update was actually applied
            // (None = singular-S skip, or a PF/IMM path — see the emission
            // note on `FusionConfig::emit_innovations`).
            let (stats, applied): (Option<InnovationStats>, bool) = match self.config.algorithm {
                FilterAlgorithm::Kalman => {
                    let r = measurement_r_cartesian(meas, &pos);
                    let stats = self.kf.update(track, &pos, Some(&r));
                    (stats, stats.is_some())
                }
                FilterAlgorithm::ExtendedKalman => {
                    let stats = if let Some(polar) = measurement_position_polar(meas) {
                        // Radar polar update consumes the raw polar R directly.
                        let r = Matrix3::from_diagonal(&Vector3::new(
                            meas.covariance[0],
                            meas.covariance[1],
                            meas.covariance[2],
                        ));
                        self.ekf.update_polar(track, &polar, &r)
                    } else {
                        let r = measurement_r_cartesian(meas, &pos);
                        self.kf.update(track, &pos, Some(&r))
                    };
                    (stats, stats.is_some())
                }
                FilterAlgorithm::UnscentedKalman => {
                    let rc = measurement_r_cartesian(meas, &pos);
                    let r_dyn = DMatrix::from_fn(3, 3, |i, j| rc[(i, j)]);
                    let stats = self.ukf.update(
                        &mut track.state,
                        &mut track.covariance,
                        &pos,
                        Some(&r_dyn),
                    );
                    (stats, stats.is_some())
                }
                FilterAlgorithm::Particle => {
                    let applied = if let Some(pf) = self.particle_filters.get_mut(track_id) {
                        let rc = measurement_r_cartesian(meas, &pos);
                        let var = Vector3::new(rc[(0, 0)], rc[(1, 1)], rc[(2, 2)]);
                        pf.update(&pos, Some(&var));
                        true
                    } else {
                        false
                    };
                    (None, applied)
                }
                FilterAlgorithm::IMM => {
                    // NOTE: each call re-runs the IMM mode-probability update, so
                    // fusing many co-located returns in one frame can over-concentrate
                    // the model probabilities (the per-model KF states stay correct).
                    // Acceptable for the common 1-2 returns/track; a per-frame single
                    // mode update is future work.
                    let applied = if let Some(imm) = self.imm_filters.get_mut(track_id) {
                        let rc = measurement_r_cartesian(meas, &pos);
                        imm.update(&pos, Some(&rc))
                    } else {
                        false
                    };
                    (None, applied)
                }
            };

            any_applied |= applied;

            // The galadriel sidecar record: one per associated measurement that
            // actually corrected the filter. Singular-S skips emit nothing (the
            // Option conveys it) — never a fabricated NIS.
            if self.config.emit_innovations && !emitted_modalities.contains(&meas.modality) {
                if let (Some(st), Some(numeric_id)) =
                    (stats, crate::pid_observation::track_numeric_id(track_id))
                {
                    if let Some(nis) = st.nis() {
                        emitted_modalities.push(meas.modality);
                        let research = self.config.emit_innovation_research;
                        // nalgebra is column-major: serialize S row-major by
                        // explicit (row, col) indexing (symmetry would mask a
                        // transposed bug here).
                        let cov = st.innovation_cov;
                        self.pid_buffer
                            .push(crate::pid_observation::PidObservation {
                                track_id: numeric_id,
                                timestamp_ms: meas.timestamp_ms,
                                seq: self.frame_count,
                                modality: meas.modality,
                                nis,
                                dof: 3,
                                innovation: research.then(|| {
                                    [st.innovation[0], st.innovation[1], st.innovation[2]]
                                }),
                                innovation_cov: research.then(|| {
                                    [
                                        [cov[(0, 0)], cov[(0, 1)], cov[(0, 2)]],
                                        [cov[(1, 0)], cov[(1, 1)], cov[(1, 2)]],
                                        [cov[(2, 0)], cov[(2, 1)], cov[(2, 2)]],
                                    ]
                                }),
                            });
                    }
                }
            }
        }

        // PF/IMM hold the canonical filter state internally; sync the track estimate
        // ONCE after all measurements are applied (resample/get_estimate are per-frame
        // operations, not per-measurement).
        match self.config.algorithm {
            FilterAlgorithm::Particle => {
                if let Some(pf) = self.particle_filters.get_mut(track_id) {
                    pf.resample();
                    let (mean, cov) = pf.get_estimate();
                    track.state = mean;
                    track.covariance = cov;
                }
            }
            FilterAlgorithm::IMM => {
                if let Some(imm) = self.imm_filters.get_mut(track_id) {
                    let (mean, cov) = imm.get_estimate();
                    track.state = mean;
                    track.covariance = cov;
                }
            }
            _ => {}
        }

        // Update track metadata — ONLY if at least one associated measurement
        // actually corrected the filter. A frame whose every update was skipped
        // (non-positive-definite S) contributed no evidence: crediting it with a
        // hit (fresh last_update_ms, missed_detections = 0, a confidence boost)
        // would let a track stay Confirmed on "hits" that never touched its
        // state. Ungated, it now registers as a miss in the lifecycle pass,
        // exactly like a frame with no associated measurements at all.
        if !any_applied {
            log::warn!(
                "[fusion] track {track_id}: every associated update was unavailable or rejected; withholding hit credit this frame"
            );
            return false;
        }
        track.sensor_sources = sensor_sources;
        track.last_update_ms = timestamp_ms;
        track.age += 1;
        track.missed_detections = 0;

        // Refresh the class label from the highest-confidence associated
        // measurement. The assignment class gate guarantees canonical-class
        // compatibility, so this only refines the raw label within the same
        // tactical class (e.g. "quadcopter" → "drone"), never flips it.
        if let Some(label) = best_label {
            if track.class_label != label {
                track.class_label = label.to_string();
            }
        }

        // Multi-sensor confidence boost. Confidence is derived AFTER fusion (not used
        // as a fusion weight): the strongest detector confidence plus a per-extra-
        // modality corroboration bump.
        // TODO: future work — derive track confidence from the posterior covariance
        // trace (track quality) rather than detector confidence.
        let sensor_boost = (track.sensor_sources.len() as f64 - 1.0) * 0.1;
        track.confidence = (max_confidence + sensor_boost).min(1.0);

        // Confirmation is decided uniformly for ALL tracks in the lifecycle pass
        // (handle_missed_detections) AFTER the sliding window is current, so the
        // age-based promotion that used to live here has moved out.
        true
    }

    fn create_track(&mut self, measurement: &SensorMeasurement, timestamp_ms: u64) {
        if self.tracks.len() >= MAX_FUSION_TRACKS {
            return;
        }

        let track_id = format!("TRK-{:05}", self.next_track_id);
        self.next_track_id = self.next_track_id.saturating_add(1);

        let initial_position = measurement_position_cartesian(measurement);
        let initial_state = Vector6::new(
            initial_position[0],
            initial_position[1],
            initial_position[2],
            measurement.velocity.map(|v| v[0]).unwrap_or(0.0),
            measurement.velocity.map(|v| v[1]).unwrap_or(0.0),
            measurement.velocity.map(|v| v[2]).unwrap_or(0.0),
        );

        // Single-point initiation. The position block uses the measurement noise
        // expressed in the Cartesian state frame, so a radar birth gets the same
        // polar→Cartesian Jacobian treatment as the association gate rather than raw
        // polar variances installed as metres². The velocity block uses a wide prior
        // because a single position-only measurement carries no velocity information.
        let pos_cov = measurement_r_cartesian(measurement, &initial_position);
        let mut initial_cov = Matrix6::zeros();
        for r in 0..3 {
            for c in 0..3 {
                initial_cov[(r, c)] = pos_cov[(r, c)];
            }
        }
        initial_cov[(3, 3)] = INITIAL_VELOCITY_VARIANCE_M2_S2;
        initial_cov[(4, 4)] = INITIAL_VELOCITY_VARIANCE_M2_S2;
        initial_cov[(5, 5)] = INITIAL_VELOCITY_VARIANCE_M2_S2;

        let track = TrackState {
            id: track_id.clone(),
            state: initial_state,
            covariance: initial_cov,
            class_label: measurement.class_label.clone(),
            confidence: measurement.confidence,
            sensor_sources: vec![measurement.modality],
            last_update_ms: timestamp_ms,
            age: 1,
            missed_detections: 0,
            // Step 4.5 (update_hit_history) is the SOLE writer of the window and
            // the opportunity counter; it runs this same frame and sets bit0 for
            // the birth hit, so both start at 0 to avoid double-counting the
            // birth frame.
            hit_history: 0,
            opportunities: 0,
            state_label: TrackStateLabel::Tentative,
        };

        // Initialize algorithm-specific filters
        match self.config.algorithm {
            FilterAlgorithm::Particle => {
                let mut pf = ParticleFilter::new(
                    self.config.particle_count,
                    self.config.process_noise,
                    self.config.measurement_noise,
                );
                pf.initialize(&initial_state, &initial_cov);
                self.particle_filters.insert(track_id.clone(), pf);
            }
            FilterAlgorithm::IMM => {
                let mut imm =
                    IMMFilter::new(self.config.process_noise, self.config.measurement_noise);
                imm.initialize(&initial_state, &initial_cov);
                self.imm_filters.insert(track_id.clone(), imm);
            }
            _ => {}
        }

        self.tracks.insert(track_id, track);
    }

    /// Bitmask of the N low bits for the configured sliding window. Computed via a
    /// right-shift (rather than `(1 << N) - 1`) so it is overflow-free at the
    /// hard cap N = MAX_CONFIRMATION_WINDOW = 32, where `1u32 << 32` would panic.
    /// Requires N in [1, 32] (enforced by validate_fusion_config).
    fn window_mask(&self) -> u32 {
        u32::MAX >> (MAX_CONFIRMATION_WINDOW - self.config.confirmation_window)
    }

    /// Step 4.5: advance every live track's sliding M-of-N hit window by one
    /// frame. Shift each bitmask left, mask to the N low bits, and OR in the
    /// per-frame hit; the per-track opportunity counter advances in lockstep so
    /// the window fill is exact. A track counts as hit iff at least one associated
    /// filter update applied, or it was born this frame (`hit_this_frame`), which
    /// is robust even when consecutive frames reuse a timestamp.
    fn update_hit_history(&mut self, hit_this_frame: &std::collections::HashSet<String>) {
        let n_mask: u32 = self.window_mask(); // N low bits
        for track in self.tracks.values_mut() {
            if track.state_label == TrackStateLabel::Lost {
                continue;
            }
            let hit = hit_this_frame.contains(&track.id);
            track.hit_history = ((track.hit_history << 1) | (hit as u32)) & n_mask;
            track.opportunities = track.opportunities.saturating_add(1);
        }
    }

    /// Return the position-block (3×3) covariance determinant when the complete
    /// state covariance is finite, has non-negative marginal variances, and the
    /// position determinant is finite/non-negative. `None` quarantines corrupted
    /// filter state instead of allowing `NaN.max(0.0)` to masquerade as certainty.
    fn position_cov_volume(track: &TrackState) -> Option<f64> {
        let c = &track.covariance;
        if c.iter().any(|value| !value.is_finite()) || (0..6).any(|axis| c[(axis, axis)] < 0.0) {
            return None;
        }
        let p = Matrix3::new(
            c[(0, 0)],
            c[(0, 1)],
            c[(0, 2)],
            c[(1, 0)],
            c[(1, 1)],
            c[(1, 2)],
            c[(2, 0)],
            c[(2, 1)],
            c[(2, 2)],
        );
        let determinant = p.determinant();
        (determinant.is_finite() && determinant >= 0.0).then_some(determinant)
    }

    /// Unified lifecycle pass: applies the sliding-window M-of-N confirmation and
    /// deletion rules plus the covariance-volume deletion guard, and prunes dead
    /// tracks. Runs AFTER update_hit_history so the window is current.
    fn handle_missed_detections(&mut self, timestamp_ms: u64) {
        let mut tracks_to_remove = Vec::new();

        let n = self.config.confirmation_window;
        let n_mask: u32 = self.window_mask(); // N low bits

        for (track_id, track) in &mut self.tracks {
            if track.state_label == TrackStateLabel::Lost {
                tracks_to_remove.push(track_id.clone());
                continue;
            }

            // Only increment missed_detections (CONSECUTIVE-miss count) for tracks
            // that were NOT updated this frame. update_track resets it to 0 and sets
            // last_update_ms = timestamp_ms, so any track with a different
            // last_update_ms was not successfully updated this frame. (This consecutive-miss
            // counter — which only drives Coasting — intentionally keys off
            // last_update_ms, NOT the sliding window's per-frame hit set; the two
            // agree for all monotonic-timestamp frames and differ only under
            // degenerate same-timestamp replays, where Coasting timing follows
            // last_update_ms while the M-of-N window stays robust.)
            if track.last_update_ms != timestamp_ms {
                track.missed_detections += 1;
            }

            // Count hits over the window's N low bits.
            let hits = (track.hit_history & n_mask).count_ones();

            // Young-track edge case: count misses only over the FILLED slots, never
            // the not-yet-observed high bits — otherwise a brand-new track (whose
            // high bits are still 0) would be deleted on frame 1. The fill is the
            // track's true per-frame opportunity counter (advanced in lockstep with
            // the window shift in update_hit_history), capped at N. Deriving it
            // from `age + missed_detections` would undercount for intermittent hit
            // patterns (age counts hits only; missed_detections resets on every
            // hit), letting clutter that blips every few frames coast forever.
            let window_fill = track.opportunities.min(n);
            let misses_in_window = window_fill.saturating_sub(hits);

            let covariance_diverged = match Self::position_cov_volume(track) {
                Some(volume) => volume > self.config.max_position_cov_volume,
                None => {
                    log::error!(
                        "[fusion] track {track_id}: invalid covariance; quarantining track"
                    );
                    true
                }
            };

            // DELETE first (overrides everything). Then COAST on consecutive misses
            // (a live "predicting forward" state that overrides Confirmed, matching
            // the prior lifecycle semantics). Then CONFIRM as a one-way latch: when
            // none of the branches fire the state is left unchanged, so a Confirmed
            // track that drops below M hits but has < 2 consecutive misses STAYS
            // Confirmed (track confirmation does not flicker).
            if misses_in_window >= self.config.max_missed_detections || covariance_diverged {
                track.state_label = TrackStateLabel::Lost;
                tracks_to_remove.push(track_id.clone());
            } else if track.missed_detections >= 2 {
                track.state_label = TrackStateLabel::Coasting;
            } else if hits >= self.config.min_confirmation_hits {
                track.state_label = TrackStateLabel::Confirmed;
            }
        }

        // Remove lost tracks
        for track_id in tracks_to_remove {
            self.tracks.remove(&track_id);
            self.particle_filters.remove(&track_id);
            self.imm_filters.remove(&track_id);
        }
    }

    /// Get all active tracks
    pub fn get_tracks(&self) -> Vec<TrackOutput> {
        self.tracks.values().map(TrackOutput::from).collect()
    }

    /// Get fusion statistics
    pub fn get_stats(&self) -> FusionStats {
        let tracks: Vec<&TrackState> = self.tracks.values().collect();

        FusionStats {
            total_tracks: tracks.len(),
            confirmed_tracks: tracks
                .iter()
                .filter(|t| t.state_label == TrackStateLabel::Confirmed)
                .count(),
            tentative_tracks: tracks
                .iter()
                .filter(|t| t.state_label == TrackStateLabel::Tentative)
                .count(),
            coasting_tracks: tracks
                .iter()
                .filter(|t| t.state_label == TrackStateLabel::Coasting)
                .count(),
            multi_sensor_tracks: tracks.iter().filter(|t| t.sensor_sources.len() > 1).count(),
            algorithm: self.config.algorithm,
            frame_count: self.frame_count,
        }
    }

    /// Clear all tracks
    pub fn clear(&mut self) {
        self.tracks.clear();
        self.particle_filters.clear();
        self.imm_filters.clear();
        self.next_track_id = 1;
        self.frame_count = 0;
        // Reset the prediction clock too: a stale value would make any replay/sim
        // feed whose timestamps are at or before the old clock see `dt = 0` on
        // every frame after a clear — no prediction, no process-noise inflation,
        // association gates sized off frozen covariances — silently, until
        // wall-clock timestamps catch up.
        self.last_predict_ms = 0;
        self.pid_buffer.clear();
    }

    /// Take the per-measurement innovation records accumulated since the last
    /// drain (empty unless `config.emit_innovations`). One record per
    /// associated measurement that actually corrected the filter; bounded per
    /// frame by the measurement batch cap.
    pub fn drain_pid_observations(&mut self) -> Vec<crate::pid_observation::PidObservation> {
        std::mem::take(&mut self.pid_buffer)
    }

    /// Update configuration
    pub fn set_config(&mut self, config: FusionConfig) {
        let algorithm_changed = self.config.algorithm != config.algorithm;
        let active_filter_requires_reseed = algorithm_changed
            || match config.algorithm {
                FilterAlgorithm::Particle => {
                    self.config.particle_count != config.particle_count
                        || self.config.process_noise != config.process_noise
                        || self.config.measurement_noise != config.measurement_noise
                }
                FilterAlgorithm::IMM => {
                    self.config.process_noise != config.process_noise
                        || self.config.measurement_noise != config.measurement_noise
                }
                _ => false,
            };
        self.kf = KalmanFilter::new(config.process_noise, config.measurement_noise);
        self.ekf = ExtendedKalmanFilter::new(config.process_noise, config.measurement_noise);
        self.ukf = UnscentedKalmanFilter::new(config.process_noise, config.measurement_noise);
        self.config = config;

        // When the algorithm changes, per-track filter state (particles, IMM
        // mode probabilities) from the old algorithm is invalid. Drop it AND
        // re-seed filters for the NEW algorithm from each existing track's
        // current state. create_track only seeds filters for brand-new tracks,
        // so without this re-seed every pre-existing track would silently freeze
        // (predict/update find no filter and no-op) while still being counted as
        // alive and Confirmed.
        if active_filter_requires_reseed {
            self.particle_filters.clear();
            self.imm_filters.clear();
            self.reinitialize_track_filters();
        }
    }

    /// Seed per-track Particle/IMM filters from existing tracks' current state.
    /// No-op for the closed-form (KF/EKF/UKF) algorithms, which hold no per-track
    /// filter state.
    fn reinitialize_track_filters(&mut self) {
        let seeds: Vec<(String, Vector6<f64>, Matrix6<f64>)> = self
            .tracks
            .iter()
            .map(|(id, t)| (id.clone(), t.state, t.covariance))
            .collect();

        match self.config.algorithm {
            FilterAlgorithm::Particle => {
                for (id, state, cov) in seeds {
                    let mut pf = ParticleFilter::new(
                        self.config.particle_count,
                        self.config.process_noise,
                        self.config.measurement_noise,
                    );
                    pf.initialize(&state, &cov);
                    self.particle_filters.insert(id, pf);
                }
            }
            FilterAlgorithm::IMM => {
                for (id, state, cov) in seeds {
                    let mut imm =
                        IMMFilter::new(self.config.process_noise, self.config.measurement_noise);
                    imm.initialize(&state, &cov);
                    self.imm_filters.insert(id, imm);
                }
            }
            _ => {}
        }
    }
}

/// Fusion statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FusionStats {
    pub total_tracks: usize,
    pub confirmed_tracks: usize,
    pub tentative_tracks: usize,
    pub coasting_tracks: usize,
    pub multi_sensor_tracks: usize,
    pub algorithm: FilterAlgorithm,
    pub frame_count: u64,
}

/// Minimum-cost one-to-one assignment (Kuhn–Munkres / Hungarian, O(n³)) over an
/// integer cost matrix `cost[row][col]`. Returns, for each row, `Some(col)` of its
/// assigned column or `None` if the row's assigned cell is the `inf` sentinel
/// (out-of-gate) — that row stays unmatched. Dependency-free (no external crate).
///
/// Uses the rectangular potentials/augmenting-path form which requires rows ≤ cols;
/// when there are more rows than columns the matrix is transposed and the result
/// mapped back, so callers may pass any rectangular matrix.
fn solve_assignment(cost: &[Vec<i64>], inf: i64) -> Vec<Option<usize>> {
    let rows = cost.len();
    let cols = if rows == 0 { 0 } else { cost[0].len() };
    if rows == 0 || cols == 0 {
        return vec![None; rows];
    }
    let transposed = rows > cols;
    let (r, c) = if transposed {
        (cols, rows)
    } else {
        (rows, cols)
    };

    // 1-based working matrix a[1..=r][1..=c], with r <= c.
    let mut a = vec![vec![0i64; c + 1]; r + 1];
    for (i, row) in a.iter_mut().enumerate().skip(1) {
        for (j, cell) in row.iter_mut().enumerate().skip(1) {
            *cell = if transposed {
                cost[j - 1][i - 1]
            } else {
                cost[i - 1][j - 1]
            };
        }
    }

    let mut u = vec![0i64; r + 1];
    let mut v = vec![0i64; c + 1];
    let mut p = vec![0usize; c + 1]; // p[col] = row matched to col (0 = none)
    let mut way = vec![0usize; c + 1];
    for i in 1..=r {
        p[0] = i;
        let mut j0 = 0usize;
        let mut minv = vec![i64::MAX; c + 1];
        let mut used = vec![false; c + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = i64::MAX;
            let mut j1 = 0usize;
            for j in 1..=c {
                if !used[j] {
                    let cur = a[i0][j] - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=c {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }

    // Map p[col] = row back to result[row] = col, dropping inf (out-of-gate) cells.
    let mut result = vec![None; rows];
    for (col, &row) in p.iter().enumerate().take(c + 1).skip(1) {
        if row == 0 {
            continue;
        }
        let (orig_r, orig_c) = if transposed {
            (col - 1, row - 1)
        } else {
            (row - 1, col - 1)
        };
        if orig_r < rows && orig_c < cols && cost[orig_r][orig_c] < inf {
            result[orig_r] = Some(orig_c);
        }
    }
    result
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kalman_update_skips_and_reports_none_on_non_pd_innovation_covariance() {
        // P = 0 and R = 0 give S = 0: not positive-definite. The update must
        // skip (None) and leave the state untouched — and, downstream, a frame
        // whose every update skips withholds hit credit (update_track gate).
        let kf = KalmanFilter::new(1.0, 2.0);
        let mut state = Vector6::zeros();
        let mut cov = Matrix6::zeros();
        let r = Matrix3::zeros();
        let before = state;
        let stats = kf.update_raw(&mut state, &mut cov, &Vector3::new(1.0, 2.0, 3.0), Some(&r));
        assert!(stats.is_none(), "non-PD S must skip the update");
        assert_eq!(state, before, "skipped update must not touch the state");

        // And a healthy update reports self-consistent innovation statistics.
        let mut cov = Matrix6::identity();
        let st = kf
            .update_raw(&mut state, &mut cov, &Vector3::new(1.0, 2.0, 3.0), None)
            .expect("healthy update applies");
        assert!(st.nis().expect("SPD") > 0.0);
    }

    #[test]
    fn test_kalman_filter_predict() {
        let kf = KalmanFilter::new(1.0, 1.0);
        let mut track = TrackState {
            id: "test".to_string(),
            state: Vector6::new(0.0, 0.0, 0.0, 1.0, 0.0, 0.0),
            covariance: Matrix6::identity(),
            class_label: "drone".to_string(),
            confidence: 0.9,
            sensor_sources: vec![SensorModality::Visual],
            last_update_ms: 0,
            age: 1,
            missed_detections: 0,
            hit_history: 0b111,
            opportunities: 3,
            state_label: TrackStateLabel::Confirmed,
        };

        kf.predict(&mut track, 1.0);

        // Position should have moved by velocity * dt
        assert!((track.state[0] - 1.0).abs() < 0.01);
    }

    #[test]
    fn test_particle_filter() {
        let mut pf = ParticleFilter::new(100, 1.0, 1.0);
        let initial_state = Vector6::new(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        let initial_cov = Matrix6::identity();

        pf.initialize(&initial_state, &initial_cov);
        pf.predict(1.0);

        let (mean, _cov) = pf.get_estimate();

        // Mean should be approximately at predicted position
        assert!(mean[0] > 0.5 && mean[0] < 1.5);
    }

    #[test]
    fn algorithm_switch_reseeds_filters_for_existing_tracks() {
        // Regression: switching to Particle/IMM at runtime must re-seed per-track
        // filters from existing tracks, otherwise those tracks freeze (predict /
        // update silently no-op) while still being counted as alive.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default()); // EKF default
        let measurement = SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [10.0, 0.0, 5.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        fusion.process_measurements(vec![measurement], 1000);
        assert_eq!(fusion.tracks.len(), 1);
        assert!(fusion.particle_filters.is_empty());

        let config = FusionConfig {
            algorithm: FilterAlgorithm::Particle,
            ..FusionConfig::default()
        };
        fusion.set_config(config);

        assert_eq!(fusion.particle_filters.len(), fusion.tracks.len());
        for id in fusion.tracks.keys() {
            assert!(
                fusion.particle_filters.contains_key(id),
                "existing track {id} has no particle filter after switch"
            );
        }

        // And switching to IMM re-seeds IMM filters too.
        let config = FusionConfig {
            algorithm: FilterAlgorithm::IMM,
            ..FusionConfig::default()
        };
        fusion.set_config(config);
        assert!(fusion.particle_filters.is_empty());
        assert_eq!(fusion.imm_filters.len(), fusion.tracks.len());
    }

    #[test]
    fn same_particle_algorithm_config_change_reseeds_existing_tracks() {
        let mut fusion = MultiSensorFusion::new(FusionConfig {
            algorithm: FilterAlgorithm::Particle,
            particle_count: 8,
            process_noise: 0.5,
            measurement_noise: 1.5,
            ..FusionConfig::default()
        });
        fusion.process_measurements(m_of_n_meas(1000, [10.0, 0.0, 5.0]), 1000);
        let track_id = fusion.tracks.keys().next().expect("track created").clone();

        fusion.set_config(FusionConfig {
            algorithm: FilterAlgorithm::Particle,
            particle_count: 16,
            process_noise: 2.5,
            measurement_noise: 3.5,
            ..FusionConfig::default()
        });

        let particle_filter = fusion
            .particle_filters
            .get(&track_id)
            .expect("existing track reseeded");
        assert_eq!(particle_filter.num_particles, 16);
        assert_eq!(particle_filter.particles.len(), 16);
        assert_eq!(particle_filter.process_noise, 2.5);
        assert_eq!(particle_filter.measurement_noise, 3.5);

        let tracks = fusion.process_measurements(m_of_n_meas(1000, [10.0, 0.0, 5.0]), 1000);
        assert_eq!(
            tracks.len(),
            1,
            "reseeded particle track must keep updating"
        );
    }

    #[test]
    fn same_imm_algorithm_noise_change_reseeds_existing_tracks() {
        let mut fusion = MultiSensorFusion::new(FusionConfig {
            algorithm: FilterAlgorithm::IMM,
            process_noise: 1.0,
            measurement_noise: 2.0,
            ..FusionConfig::default()
        });
        fusion.process_measurements(m_of_n_meas(1000, [10.0, 0.0, 5.0]), 1000);
        let track_id = fusion.tracks.keys().next().expect("track created").clone();
        fusion
            .imm_filters
            .get_mut(&track_id)
            .expect("IMM exists")
            .model_probs = [0.1, 0.9];

        fusion.set_config(FusionConfig {
            algorithm: FilterAlgorithm::IMM,
            process_noise: 6.0,
            measurement_noise: 7.0,
            ..FusionConfig::default()
        });

        let imm = fusion
            .imm_filters
            .get(&track_id)
            .expect("existing track reseeded");
        assert_eq!(imm.model_probs, [0.8, 0.2]);
        assert_eq!(imm.kf_cv.q[(3, 3)], 3.0);
        assert_eq!(imm.kf_cv.r[(0, 0)], 7.0);
        assert_eq!(imm.ct.q[(3, 3)], 6.0);
        assert_eq!(imm.ct.r[(0, 0)], 7.0);

        let tracks = fusion.process_measurements(m_of_n_meas(1000, [10.0, 0.0, 5.0]), 1000);
        assert_eq!(tracks.len(), 1, "reseeded IMM track must keep updating");
    }

    #[test]
    fn process_does_not_credit_a_hit_when_every_filter_update_fails() {
        let mut fusion = MultiSensorFusion::new(FusionConfig {
            algorithm: FilterAlgorithm::Kalman,
            ..FusionConfig::default()
        });
        fusion.process_measurements(m_of_n_meas(1000, [10.0, 0.0, 5.0]), 1000);
        let track_id = fusion.tracks.keys().next().expect("track created").clone();
        fusion
            .tracks
            .get_mut(&track_id)
            .expect("track exists")
            .covariance = Matrix6::zeros();

        // Fault injection below intentionally bypasses IPC validation: P = 0 and
        // R = 0 make S singular, exercising the process-level skipped-update path.
        let mut singular_measurement = m_of_n_meas(1000, [10.0, 0.0, 5.0]);
        singular_measurement[0].covariance = [0.0; 3];
        fusion.process_measurements(singular_measurement, 1000);

        let track = fusion.tracks.get(&track_id).expect("track remains live");
        assert_eq!(
            track.hit_history & 0b11,
            0b10,
            "the failed association must append a miss bit"
        );
        assert_eq!(track.opportunities, 2);
        assert_eq!(
            track.age, 1,
            "failed updates must not age the track as a hit"
        );
    }

    #[test]
    fn process_quarantines_nonfinite_covariance_and_output_never_claims_zero_uncertainty() {
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        fusion.process_measurements(m_of_n_meas(1000, [10.0, 0.0, 5.0]), 1000);
        let track_id = fusion.tracks.keys().next().expect("track created").clone();
        let track = fusion.tracks.get_mut(&track_id).expect("track exists");
        track.covariance[(0, 0)] = f64::NAN;

        let guarded_output = TrackOutput::from(&*track);
        assert!(guarded_output.position_uncertainty[0].is_finite());
        assert!(
            guarded_output.position_uncertainty[0] > 1.0,
            "invalid variance must be conservative, never zero"
        );

        let outputs = fusion.process_measurements(Vec::new(), 1000);
        assert!(outputs.is_empty(), "corrupted track must be quarantined");
        assert!(!fusion.tracks.contains_key(&track_id));
    }

    #[test]
    fn test_multi_sensor_fusion() {
        let config = FusionConfig::default();
        let mut fusion = MultiSensorFusion::new(config);

        let measurements = vec![
            SensorMeasurement {
                sensor_id: "cam1".to_string(),
                modality: SensorModality::Visual,
                timestamp_ms: 1000,
                position: [10.0, 0.0, 5.0],
                velocity: None,
                covariance: [1.0, 1.0, 1.0],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            },
            SensorMeasurement {
                sensor_id: "thermal1".to_string(),
                modality: SensorModality::Thermal,
                timestamp_ms: 1000,
                position: [10.5, 0.5, 5.0],
                velocity: None,
                covariance: [2.0, 2.0, 2.0],
                confidence: 0.8,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            },
        ];

        let tracks = fusion.process_measurements(measurements, 1000);

        // Should create one fused track
        assert!(!tracks.is_empty());
    }

    #[test]
    fn test_multi_frame_track_lifecycle() {
        let config = FusionConfig::default();
        let mut fusion = MultiSensorFusion::new(config);

        // Frame 1: Create tentative track
        let m1 = vec![SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [10.0, 0.0, 5.0],
            velocity: Some([1.0, 0.0, 0.0]),
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        }];
        let tracks = fusion.process_measurements(m1, 1000);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].state, TrackStateLabel::Tentative);

        // Frame 2: Confirm track (hit #2)
        let m2 = vec![SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1100,
            position: [11.0, 0.1, 5.0],
            velocity: Some([1.0, 0.0, 0.0]),
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.85,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        }];
        let tracks = fusion.process_measurements(m2, 1100);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].age, 2);

        // Frame 3: Confirm track (hit #3)
        let m3 = vec![SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1200,
            position: [12.0, 0.2, 5.0],
            velocity: Some([1.0, 0.0, 0.0]),
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.88,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        }];
        let tracks = fusion.process_measurements(m3, 1200);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].state, TrackStateLabel::Confirmed);
    }

    #[test]
    fn test_constant_velocity_estimate_tracks_moving_target() {
        // A target moving at a constant 2 m/s along +X should be tracked so that
        // the filter's position estimate converges near the true position and the
        // estimated velocity converges near the true velocity over several frames.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());

        let dt_ms: u64 = 100;
        let speed = 2.0; // m/s
        let mut last = None;
        for frame in 0..10u64 {
            let t_ms = 1000 + frame * dt_ms;
            let true_x = 5.0 + speed * (frame as f64) * (dt_ms as f64) / 1000.0;
            let m = vec![SensorMeasurement {
                sensor_id: "cam1".to_string(),
                modality: SensorModality::Visual,
                timestamp_ms: t_ms,
                position: [true_x, 0.0, 3.0],
                velocity: Some([speed, 0.0, 0.0]),
                covariance: [0.5, 0.5, 0.5],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }];
            let tracks = fusion.process_measurements(m, t_ms);
            assert_eq!(
                tracks.len(),
                1,
                "frame {frame} should yield exactly one track"
            );
            last = Some((tracks[0].clone(), true_x));
        }

        let (track, true_x) = last.expect("expected a track after the run");
        assert_eq!(track.state, TrackStateLabel::Confirmed);
        // Position estimate converges to the moving target (within 1.5 m).
        assert!(
            (track.position[0] - true_x).abs() < 1.5,
            "estimated x {} should track true x {}",
            track.position[0],
            true_x
        );
        // Velocity estimate converges toward the true +X speed.
        assert!(
            track.velocity[0] > 1.0 && track.velocity[0] < 3.0,
            "estimated vx {} should converge near {}",
            track.velocity[0],
            speed
        );
        // Lateral axes stay near zero (no spurious motion introduced).
        assert!(track.position[1].abs() < 1.0);
    }

    #[test]
    fn test_ct_transition_degenerates_to_cv_at_zero_omega() {
        // As omega -> 0, F(omega, dt) must equal the CV transition exactly (the
        // |omega*dt| < 1e-4 guard routes through KalmanFilter::transition_matrix).
        let dt = 0.1;
        let ct = CoordinatedTurnFilter::ct_transition_matrix(1e-6, dt);
        let cv = KalmanFilter::transition_matrix(dt);
        for i in 0..6 {
            for j in 0..6 {
                assert!(
                    (ct[(i, j)] - cv[(i, j)]).abs() < 1e-6,
                    "F[{i},{j}] CT {} vs CV {}",
                    ct[(i, j)],
                    cv[(i, j)]
                );
            }
        }
    }

    #[test]
    fn test_ct_transition_rotates_velocity() {
        // A quarter turn (omega = PI/2 over dt = 1.0) rotates (vx=1, vy=0) to
        // (vx'~0, vy'~1): a 90 deg CCW rotation. Guards the rotation block sign.
        let f = CoordinatedTurnFilter::ct_transition_matrix(PI / 2.0, 1.0);
        let state = Vector6::new(0.0, 0.0, 0.0, 1.0, 0.0, 0.0);
        let next = f * state;
        assert!((next[3] - 0.0).abs() < 1e-9, "vx' {} should be ~0", next[3]);
        assert!((next[4] - 1.0).abs() < 1e-9, "vy' {} should be ~1", next[4]);
    }

    #[test]
    fn test_ct_transition_preserves_speed() {
        // A coordinated turn conserves speed: sqrt(vx'^2 + vy'^2) is invariant.
        // Catches a wrong sign in the rotation 2x2.
        let dt = 0.1;
        let vx: f64 = 3.0;
        let vy: f64 = -1.5;
        let speed = (vx * vx + vy * vy).sqrt();
        for &omega in &[0.1_f64, 0.3, 1.0] {
            let f = CoordinatedTurnFilter::ct_transition_matrix(omega, dt);
            let state = Vector6::new(0.0, 0.0, 0.0, vx, vy, 0.0);
            let next = f * state;
            let speed_out = (next[3] * next[3] + next[4] * next[4]).sqrt();
            assert!(
                (speed_out - speed).abs() < 1e-9,
                "omega {omega}: speed {speed_out} should equal {speed}"
            );
        }
    }

    #[test]
    fn test_ct_z_axis_is_constant_velocity() {
        // z and vz must stay constant-velocity, untouched by the horizontal turn.
        let f = CoordinatedTurnFilter::ct_transition_matrix(0.3, 0.5);
        let state = Vector6::new(0.0, 0.0, 5.0, 0.0, 0.0, 2.0);
        let next = f * state;
        assert!(
            (next[2] - 6.0).abs() < 1e-12,
            "z' {} should be 6.0",
            next[2]
        );
        assert!(
            (next[5] - 2.0).abs() < 1e-12,
            "vz' {} should be 2.0",
            next[5]
        );
    }

    /// Generate a circular (coordinated-turn) ground-truth trajectory in the x-y
    /// plane: constant `speed`, true turn rate `omega`, sampled at `dt` for
    /// `frames` steps. Returns `(true_x, true_y)` per frame.
    fn turning_trajectory(speed: f64, omega: f64, dt: f64, frames: usize) -> Vec<(f64, f64)> {
        // Circle of radius speed/omega; start at the rightmost point moving +y.
        let radius = speed / omega;
        (0..frames)
            .map(|k| {
                let theta = omega * (k as f64) * dt;
                let x = radius * theta.cos();
                let y = radius * theta.sin();
                (x, y)
            })
            .collect()
    }

    #[test]
    fn test_imm_ct_beats_cv_cv_on_turning_target() {
        // Headline comparative test: on a turning target, the CV+CT IMM should
        // track strictly better (lower position RMSE over the last 10 frames) than
        // a pure-CV baseline (FilterAlgorithm::Kalman, constant-velocity model).
        let speed = 5.0;
        let omega = 0.3; // matches OMEGA_CT so the CT mode is the right hypothesis
        let dt = 0.1;
        let frames = 40usize;
        let traj = turning_trajectory(speed, omega, dt, frames);

        // Deterministic small "measurement noise" so both engines see identical
        // inputs; a fixed pseudo-random perturbation keeps the test reproducible.
        let noisy = |i: usize, base: f64, axis: usize| -> f64 {
            let seed = (i as f64) * 12.9898 + (axis as f64) * 78.233;
            let frac = (seed.sin() * 43758.547).fract();
            base + (frac - 0.5) * 0.1 // +/- 0.05 m
        };

        // Both engines lean on their motion model: a deliberately loose assumed
        // measurement covariance smooths the (clean) measurements, so the CV
        // model's structural turn lag is exposed and the CT model's matching turn
        // structure wins. Both engines see the identical config and inputs, so the
        // comparison isolates the CV-vs-CT motion model.
        let assumed_cov = [4.0, 4.0, 4.0];
        let mut imm_engine = MultiSensorFusion::new(FusionConfig {
            algorithm: FilterAlgorithm::IMM,
            ..FusionConfig::default()
        });
        let mut cv_engine = MultiSensorFusion::new(FusionConfig {
            algorithm: FilterAlgorithm::Kalman,
            ..FusionConfig::default()
        });

        let mut imm_sq_err = 0.0;
        let mut cv_sq_err = 0.0;
        let mut counted = 0usize;

        for (i, &(tx, ty)) in traj.iter().enumerate() {
            let t_ms = 1000 + (i as u64) * 100;
            let mx = noisy(i, tx, 0);
            let my = noisy(i, ty, 1);
            let make_meas = || {
                vec![SensorMeasurement {
                    sensor_id: "cam1".to_string(),
                    modality: SensorModality::Visual,
                    timestamp_ms: t_ms,
                    position: [mx, my, 3.0],
                    velocity: None,
                    covariance: assumed_cov,
                    confidence: 0.9,
                    class_label: "drone".to_string(),
                    metadata: HashMap::new(),
                }]
            };
            let imm_tracks = imm_engine.process_measurements(make_meas(), t_ms);
            let cv_tracks = cv_engine.process_measurements(make_meas(), t_ms);

            // Accumulate position error over the last 10 frames once both engines
            // have a single track to read.
            if i >= frames - 10 && imm_tracks.len() == 1 && cv_tracks.len() == 1 {
                let ie = (imm_tracks[0].position[0] - tx).powi(2)
                    + (imm_tracks[0].position[1] - ty).powi(2);
                let ce = (cv_tracks[0].position[0] - tx).powi(2)
                    + (cv_tracks[0].position[1] - ty).powi(2);
                imm_sq_err += ie;
                cv_sq_err += ce;
                counted += 1;
            }
        }

        assert!(
            counted > 0,
            "expected error samples over the last 10 frames"
        );
        let imm_rmse = (imm_sq_err / counted as f64).sqrt();
        let cv_rmse = (cv_sq_err / counted as f64).sqrt();
        assert!(
            imm_rmse < cv_rmse * 0.9,
            "CV+CT IMM RMSE {imm_rmse} should be < 0.9 * CV baseline RMSE {cv_rmse}"
        );
    }

    #[test]
    fn test_imm_ct_mode_probability_rises_during_turn() {
        // On a turning trajectory the CT mode probability should rise well above
        // its 0.2 prior; on a straight line it should stay near/below the prior.
        // A tight measurement noise makes the innovation likelihood discriminate
        // sharply between the lagging CV prediction and the on-track CT prediction.
        let dt = 0.1;
        let mut turn_imm = IMMFilter::new(1.0, 0.25);
        let mut straight_imm = IMMFilter::new(1.0, 0.25);

        let speed = 12.0;
        let omega = 0.3;
        let frames = 40usize;
        let traj = turning_trajectory(speed, omega, dt, frames);
        let seed_state = Vector6::new(traj[0].0, traj[0].1, 0.0, 0.0, speed, 0.0);
        turn_imm.initialize(&seed_state, &(Matrix6::identity() * 10.0));

        for &(tx, ty) in traj.iter().skip(1) {
            turn_imm.predict(dt);
            turn_imm.update(&Vector3::new(tx, ty, 0.0), None);
        }
        let turn_probs = turn_imm.get_model_probabilities();
        assert!(
            turn_probs[1] > 0.4,
            "CT mode prob {} should rise above its 0.2 prior during a turn",
            turn_probs[1]
        );

        // Straight line along +x at constant speed.
        let straight_seed = Vector6::new(0.0, 0.0, 0.0, speed, 0.0, 0.0);
        straight_imm.initialize(&straight_seed, &(Matrix6::identity() * 10.0));
        for k in 1..frames {
            let x = speed * (k as f64) * dt; // straight line along +x
            straight_imm.predict(dt);
            straight_imm.update(&Vector3::new(x, 0.0, 0.0), None);
        }
        let straight_probs = straight_imm.get_model_probabilities();
        // On a straight line the CV model fits perfectly, so the CT mode should
        // stay near/below its 0.2 prior and well below the turning case.
        assert!(
            straight_probs[1] < 0.3,
            "straight-line CT prob {} should stay near its 0.2 prior",
            straight_probs[1]
        );
        assert!(
            straight_probs[1] < turn_probs[1],
            "straight-line CT prob {} should be below turning CT prob {}",
            straight_probs[1],
            turn_probs[1]
        );
    }

    #[test]
    fn test_imm_straight_line_still_tracked_by_ct_mode() {
        // Regression: adding the CT mode must not degrade the straight-line case.
        // Mirrors test_constant_velocity_estimate_tracks_moving_target but on the
        // CV+CT IMM engine.
        let mut fusion = MultiSensorFusion::new(FusionConfig {
            algorithm: FilterAlgorithm::IMM,
            ..FusionConfig::default()
        });

        let dt_ms: u64 = 100;
        let speed = 2.0; // m/s
        let mut last = None;
        for frame in 0..12u64 {
            let t_ms = 1000 + frame * dt_ms;
            let true_x = 5.0 + speed * (frame as f64) * (dt_ms as f64) / 1000.0;
            let m = vec![SensorMeasurement {
                sensor_id: "cam1".to_string(),
                modality: SensorModality::Visual,
                timestamp_ms: t_ms,
                position: [true_x, 0.0, 3.0],
                velocity: None,
                covariance: [0.5, 0.5, 0.5],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }];
            let tracks = fusion.process_measurements(m, t_ms);
            assert_eq!(tracks.len(), 1, "frame {frame} should yield one track");
            last = Some((tracks[0].clone(), true_x));
        }

        let (track, true_x) = last.expect("expected a track after the run");
        assert_eq!(track.state, TrackStateLabel::Confirmed);
        assert!(
            (track.position[0] - true_x).abs() < 1.5,
            "estimated x {} should track true x {}",
            track.position[0],
            true_x
        );
        assert!(
            track.position[1].abs() < 1.0,
            "lateral drift {} should stay near zero",
            track.position[1]
        );
    }

    #[test]
    fn test_stale_track_cleanup() {
        let config = FusionConfig {
            max_missed_detections: 3,
            ..Default::default()
        };
        let mut fusion = MultiSensorFusion::new(config);

        // Create a track
        let m1 = vec![SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [10.0, 0.0, 5.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        }];
        let tracks = fusion.process_measurements(m1, 1000);
        assert_eq!(tracks.len(), 1);

        // Miss 3 frames - track should become Lost and be removed
        let empty: Vec<SensorMeasurement> = Vec::new();
        fusion.process_measurements(empty.clone(), 1100);
        fusion.process_measurements(empty.clone(), 1200);
        let tracks = fusion.process_measurements(empty, 1300);

        // Track should be removed after max_missed_detections
        assert!(tracks.is_empty());
    }

    #[test]
    fn test_track_coasting_state() {
        let config = FusionConfig {
            max_missed_detections: 5,
            ..Default::default()
        };
        let mut fusion = MultiSensorFusion::new(config);

        // Create and confirm a track
        for frame in 0..3 {
            let m = vec![SensorMeasurement {
                sensor_id: "cam1".to_string(),
                modality: SensorModality::Visual,
                timestamp_ms: 1000 + frame * 100,
                position: [10.0 + frame as f64, 0.0, 5.0],
                velocity: Some([1.0, 0.0, 0.0]),
                covariance: [1.0, 1.0, 1.0],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }];
            fusion.process_measurements(m, 1000 + frame * 100);
        }

        // Miss 2 frames - should be coasting
        let empty: Vec<SensorMeasurement> = Vec::new();
        fusion.process_measurements(empty.clone(), 1300);
        let tracks = fusion.process_measurements(empty, 1400);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].state, TrackStateLabel::Coasting);
    }

    #[test]
    fn test_polar_measurement_integration() {
        let ekf = ExtendedKalmanFilter::new(1.0, 0.1);
        let mut track = TrackState {
            id: "test".to_string(),
            state: Vector6::new(10.0, 0.0, 5.0, 1.0, 0.0, 0.0),
            covariance: Matrix6::identity() * 0.1,
            class_label: "drone".to_string(),
            confidence: 0.9,
            sensor_sources: vec![SensorModality::Radar],
            last_update_ms: 1000,
            age: 1,
            missed_detections: 0,
            hit_history: 0b111,
            opportunities: 3,
            state_label: TrackStateLabel::Confirmed,
        };

        // Simulate radar measurement: range=11.18, azimuth=0, elevation=0.463
        let polar_meas = Vector3::new(11.18, 0.0, 0.463);
        let r = Matrix3::from_diagonal(&Vector3::new(0.1, 0.01, 0.01));

        ekf.update_polar(&mut track, &polar_meas, &r);

        // Position should be updated toward the measurement
        assert!(track.state[0] > 9.0 && track.state[0] < 12.0);
        assert!(track.state[2] > 4.0 && track.state[2] < 6.0);
    }

    #[test]
    fn radar_measurement_creates_cartesian_track_from_polar_input() {
        let config = FusionConfig::default();
        let mut fusion = MultiSensorFusion::new(config);

        let tracks = fusion.process_measurements(
            vec![SensorMeasurement {
                sensor_id: "radar1".to_string(),
                modality: SensorModality::Radar,
                timestamp_ms: 1000,
                position: [10.0, std::f64::consts::FRAC_PI_2, 0.0],
                velocity: None,
                covariance: [1.0, 0.01, 0.01],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }],
            1000,
        );

        assert_eq!(tracks.len(), 1);
        assert!(tracks[0].position[0].abs() < 1e-6);
        assert!((tracks[0].position[1] - 10.0).abs() < 1e-6);
        assert!(tracks[0].position[2].abs() < 1e-6);
    }

    #[test]
    fn lidar_centroid_is_treated_as_cartesian_not_polar() {
        // Regression: lidar reports a metric Cartesian centroid. It must NOT be
        // run through polar_to_cartesian. A centroid of (3, 4, 0) interpreted as
        // polar [range=3, az=4 rad, el=0] would land near (-1.96, -2.27, 0).
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let tracks = fusion.process_measurements(
            vec![SensorMeasurement {
                sensor_id: "lidar1".to_string(),
                modality: SensorModality::Lidar,
                timestamp_ms: 1000,
                position: [3.0, 4.0, 0.0],
                velocity: None,
                covariance: [0.1, 0.1, 0.1],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }],
            1000,
        );

        assert_eq!(tracks.len(), 1);
        assert!(
            (tracks[0].position[0] - 3.0).abs() < 1e-6,
            "x={}",
            tracks[0].position[0]
        );
        assert!(
            (tracks[0].position[1] - 4.0).abs() < 1e-6,
            "y={}",
            tracks[0].position[1]
        );
        assert!(
            tracks[0].position[2].abs() < 1e-6,
            "z={}",
            tracks[0].position[2]
        );
    }

    #[test]
    fn joseph_update_keeps_covariance_symmetric_and_psd() {
        // The Joseph-form covariance update must keep P symmetric and its
        // diagonal non-negative across many update steps.
        let kf = KalmanFilter::new(1.0, 2.0);
        let mut state = Vector6::new(0.0, 0.0, 0.0, 1.0, 0.5, 0.0);
        let mut cov = Matrix6::identity() * 5.0;

        for step in 0..50 {
            kf.predict_raw(&mut state, &mut cov, 0.1);
            let meas = Vector3::new(0.1 * step as f64, 0.05 * step as f64, 0.0);
            kf.update_raw(&mut state, &mut cov, &meas, None);

            for i in 0..6 {
                assert!(
                    cov[(i, i)] >= -1e-9,
                    "diag[{i}] negative at step {step}: {}",
                    cov[(i, i)]
                );
                for j in 0..6 {
                    assert!(
                        (cov[(i, j)] - cov[(j, i)]).abs() < 1e-9,
                        "asymmetry at ({i},{j}) step {step}"
                    );
                }
            }
        }
    }

    #[test]
    fn extended_kalman_pipeline_updates_radar_track_with_polar_measurement() {
        let config = FusionConfig {
            algorithm: FilterAlgorithm::ExtendedKalman,
            ..FusionConfig::default()
        };
        let mut fusion = MultiSensorFusion::new(config);

        let first = SensorMeasurement {
            sensor_id: "radar1".to_string(),
            modality: SensorModality::Radar,
            timestamp_ms: 1000,
            position: [10.0, 0.0, 0.0],
            // Position-only radar return (no Doppler velocity) — the realistic
            // production case. The track is born with a wide single-point velocity
            // prior (INITIAL_VELOCITY_VARIANCE_M2_S2), so the constant-velocity
            // predict still carries it into the χ²(3) gate on frame 2.
            velocity: None,
            covariance: [0.1, 0.01, 0.01],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        fusion.process_measurements(vec![first], 1000);

        let second = SensorMeasurement {
            sensor_id: "radar1".to_string(),
            modality: SensorModality::Radar,
            timestamp_ms: 1100,
            position: [12.0, 0.0, 0.0],
            velocity: None,
            covariance: [0.1, 0.01, 0.01],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let tracks = fusion.process_measurements(vec![second], 1100);

        assert_eq!(tracks.len(), 1);
        assert!(tracks[0].position[0] > 10.0);
    }

    #[test]
    fn create_track_seeds_wide_single_point_velocity_prior() {
        // A track born from a single position-only measurement must seed a WIDE
        // velocity prior (Bar-Shalom single-point initiation), not an over-confident
        // one — otherwise the constant-velocity predict cannot carry the track into
        // the χ²(3) gate on the next frame. Locks the birth-covariance contract so a
        // future association/lifecycle rewrite (roadmap #5/#6) cannot silently
        // re-tighten it.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        fusion.process_measurements(
            vec![SensorMeasurement {
                sensor_id: "radar1".to_string(),
                modality: SensorModality::Radar,
                timestamp_ms: 1000,
                position: [10.0, 0.0, 0.0],
                velocity: None,
                covariance: [0.1, 0.01, 0.01],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }],
            1000,
        );

        let track = fusion.tracks.values().next().expect("one track born");
        for i in 3..6 {
            assert_eq!(
                track.covariance[(i, i)],
                INITIAL_VELOCITY_VARIANCE_M2_S2,
                "velocity-block diag[{i}] must be the wide single-point prior"
            );
        }
        // Position block: the radar birth covariance is the polar R mapped into the
        // Cartesian frame (boresight here, so diagonal). Range var 0.1 m² is kept;
        // each angular var 0.01 rad² becomes (range·σ)² = 10²·0.01 = 1.0 m² — NOT the
        // raw 0.01 used verbatim as metres² before this fix.
        assert!((track.covariance[(0, 0)] - 0.1).abs() < 1e-9, "range var");
        assert!(
            (track.covariance[(1, 1)] - 1.0).abs() < 1e-9,
            "cross-range y var"
        );
        assert!(
            (track.covariance[(2, 2)] - 1.0).abs() < 1e-9,
            "cross-range z var"
        );
    }

    #[test]
    fn far_radar_return_spawns_second_track_not_masked_by_birth_prior() {
        // The wide birth velocity prior must NOT turn the gate into a no-op: a return
        // far outside the χ²(3) gate must still spawn a separate track (d² ≈ 214 for a
        // 30 m jump in 100 ms ≫ 11.345).
        let mut fusion = MultiSensorFusion::new(FusionConfig {
            algorithm: FilterAlgorithm::ExtendedKalman,
            ..FusionConfig::default()
        });
        let make = |range: f64, ts: u64| SensorMeasurement {
            sensor_id: "radar1".to_string(),
            modality: SensorModality::Radar,
            timestamp_ms: ts,
            position: [range, 0.0, 0.0],
            velocity: None,
            covariance: [0.1, 0.01, 0.01],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        fusion.process_measurements(vec![make(10.0, 1000)], 1000);
        let tracks = fusion.process_measurements(vec![make(40.0, 1100)], 1100);
        assert_eq!(tracks.len(), 2, "a 30 m jump in 100 ms must not associate");
    }

    #[test]
    fn radar_association_noise_is_converted_to_cartesian() {
        // Radar reports polar noise [m², rad², rad²]. In the Cartesian association
        // gate it must be transformed by the polar→Cartesian Jacobian, so an angular
        // 1σ maps to a cross-range 1σ of ≈ range·σ_angle — NOT used verbatim as m².
        let range = 100.0;
        let sigma_az = 0.01_f64; // rad
        let sigma_el = 0.02_f64; // rad
        let radar = SensorMeasurement {
            sensor_id: "radar1".to_string(),
            modality: SensorModality::Radar,
            timestamp_ms: 0,
            position: [range, 0.0, 0.0], // boresight: az = el = 0
            velocity: None,
            covariance: [0.5, sigma_az * sigma_az, sigma_el * sigma_el],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let radar_pos = measurement_position_cartesian(&radar); // (100, 0, 0)
        let r_cart = measurement_r_cartesian(&radar, &radar_pos);
        // Range (x) variance is unchanged at boresight.
        assert!(
            (r_cart[(0, 0)] - 0.5).abs() < 1e-9,
            "range var {}",
            r_cart[(0, 0)]
        );
        // Cross-range (y, z) variance ≈ (range·σ_angle)² — the raw rad² scaled by
        // range², vastly larger than the buggy verbatim use of rad² as m².
        let expect_y = (range * sigma_az).powi(2);
        let expect_z = (range * sigma_el).powi(2);
        assert!(
            (r_cart[(1, 1)] - expect_y).abs() < 1e-6,
            "cross-range y {}",
            r_cart[(1, 1)]
        );
        assert!(
            (r_cart[(2, 2)] - expect_z).abs() < 1e-6,
            "cross-range z {}",
            r_cart[(2, 2)]
        );

        // A Cartesian modality's diagonal noise is passed through unchanged.
        let lidar = SensorMeasurement {
            sensor_id: "lidar1".to_string(),
            modality: SensorModality::Lidar,
            timestamp_ms: 0,
            position: [1.0, 2.0, 3.0],
            velocity: None,
            covariance: [0.1, 0.2, 0.3],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let lidar_pos = measurement_position_cartesian(&lidar);
        let r_lidar = measurement_r_cartesian(&lidar, &lidar_pos);
        assert!((r_lidar[(0, 0)] - 0.1).abs() < 1e-12);
        assert!((r_lidar[(1, 1)] - 0.2).abs() < 1e-12);
        assert!((r_lidar[(2, 2)] - 0.3).abs() < 1e-12);
    }

    #[test]
    fn radar_r_cartesian_off_boresight_is_symmetric_pd_and_grows_cross_range() {
        // Off-boresight, the polar→Cartesian position Jacobian has cross terms, so
        // R_cart = J⁻¹ R J⁻ᵀ is a full (non-diagonal) congruence transform. It must
        // stay symmetric and positive-definite, and the angular variances must blow up
        // toward range²·σ² in cross-range — exercising the real off-diagonal wiring
        // the boresight test cannot.
        let radar = SensorMeasurement {
            sensor_id: "radar1".to_string(),
            modality: SensorModality::Radar,
            timestamp_ms: 0,
            position: [50.0, 0.6, 0.3], // polar [range m, az rad, el rad]
            velocity: None,
            covariance: [0.5, 0.01, 0.0025], // [m², (0.1 rad)², (0.05 rad)²]
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let pos = measurement_position_cartesian(&radar);
        let r = measurement_r_cartesian(&radar, &pos);

        for i in 0..3 {
            for j in 0..3 {
                assert!(
                    (r[(i, j)] - r[(j, i)]).abs() < 1e-9,
                    "asymmetry at ({i},{j})"
                );
            }
        }
        // Positive-definite (Cholesky succeeds) ⇒ a valid covariance.
        assert!(r.cholesky().is_some(), "R_cart must be PD: {r}");
        // Raw polar trace was 0.5125 m²; the converted trace is dominated by
        // range²·σ_angle² and is far larger, proving the angular→cross-range blow-up.
        assert!(
            r.trace() > 5.0,
            "cross-range did not grow: trace={}",
            r.trace()
        );
    }

    #[test]
    fn sequential_fusion_weights_by_covariance_not_confidence() {
        // Two measurements on one target in one frame: a PRECISE low-confidence return
        // and a COARSE high-confidence return offset in y. Information-form sequential
        // fusion must land near the precise one. The old confidence-weighted average
        // ((0.5·0 + 0.95·4)/1.45 ≈ 2.6) would be dragged toward the coarse return.
        let config = FusionConfig {
            algorithm: FilterAlgorithm::Kalman,
            ..FusionConfig::default()
        };
        let mut fusion = MultiSensorFusion::new(config);
        // Birth a track near the precise location.
        fusion.process_measurements(
            vec![SensorMeasurement {
                sensor_id: "lidar1".to_string(),
                modality: SensorModality::Lidar,
                timestamp_ms: 1000,
                position: [10.0, 0.0, 0.0],
                velocity: None,
                covariance: [0.05, 0.05, 0.05],
                confidence: 0.6,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }],
            1000,
        );
        let precise = SensorMeasurement {
            sensor_id: "lidar1".to_string(),
            modality: SensorModality::Lidar,
            timestamp_ms: 1100,
            position: [10.0, 0.0, 0.0],
            velocity: None,
            covariance: [0.01, 0.01, 0.01], // tiny R (precise)
            confidence: 0.5,                // ...but LOW detector confidence
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let coarse = SensorMeasurement {
            sensor_id: "acoustic1".to_string(),
            modality: SensorModality::Acoustic,
            timestamp_ms: 1100,
            position: [10.0, 4.0, 0.0],
            velocity: None,
            covariance: [100.0, 100.0, 100.0], // huge R (coarse)
            confidence: 0.95,                  // ...but HIGH detector confidence
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        // Pass coarse first to prove the result is order-independent (update_track
        // orders by covariance, not input order, and certainly not by confidence).
        let tracks = fusion.process_measurements(vec![coarse, precise], 1100);
        assert_eq!(tracks.len(), 1, "both returns fuse into one track");
        assert!(
            tracks[0].position[1].abs() < 0.5,
            "fused y should track the precise return (≈0), got {}",
            tracks[0].position[1]
        );
        assert!(
            (tracks[0].position[0] - 10.0).abs() < 0.5,
            "x={}",
            tracks[0].position[0]
        );
    }

    #[test]
    fn calculate_threat_level_matches_canonical_table() {
        // Canonical graduated 1-4 threat scale, mirrored bit-for-bit by the TS
        // getThreatLevel(mapToDetectionClass(label), conf) chain. Strict `>` at every
        // threshold (0.8, 0.7, 0.5).
        // drone (graduated)
        assert_eq!(calculate_threat_level("drone", 0.9), 4);
        assert_eq!(calculate_threat_level("drone", 0.8), 3); // boundary, strict >
        assert_eq!(calculate_threat_level("drone", 0.6), 3);
        assert_eq!(calculate_threat_level("drone", 0.5), 2); // boundary
        assert_eq!(calculate_threat_level("drone", 0.3), 2);
        assert_eq!(calculate_threat_level("DRONE", 0.9), 4); // case-insensitive
        assert_eq!(calculate_threat_level("uav", 0.9), 4);
        assert_eq!(calculate_threat_level("quadcopter", 0.9), 4); // remap parity
        assert_eq!(calculate_threat_level("kite", 0.9), 4); // demo remap parity
                                                            // aircraft / helicopter (flat 2)
        assert_eq!(calculate_threat_level("aircraft", 0.99), 2);
        assert_eq!(calculate_threat_level("airplane", 0.99), 2); // exact-match parity
        assert_eq!(calculate_threat_level("helicopter", 0.99), 2);
        // bird (flat 1)
        assert_eq!(calculate_threat_level("bird", 0.9), 1);
        assert_eq!(calculate_threat_level("blackbird", 0.9), 1); // 'bird' substring
                                                                 // unknown (graduated). Compound labels bucket as unknown, matching
                                                                 // mapToDetectionClass's exact match (e.g. "fpv-drone" → unknown).
        assert_eq!(calculate_threat_level("balloon", 0.8), 3);
        assert_eq!(calculate_threat_level("balloon", 0.7), 2); // boundary
        assert_eq!(calculate_threat_level("fpv-drone", 0.9), 3);
        assert_eq!(calculate_threat_level("", 0.9), 3);
        assert_eq!(calculate_threat_level("clutter", 0.5), 2);
    }

    #[test]
    fn test_fusion_stats_accuracy() {
        let config = FusionConfig::default();
        let mut fusion = MultiSensorFusion::new(config);

        // Create tracks in different states
        for i in 0..5 {
            let m = vec![SensorMeasurement {
                sensor_id: format!("cam{}", i),
                modality: SensorModality::Visual,
                timestamp_ms: 1000,
                position: [i as f64 * 100.0, 0.0, 5.0],
                velocity: None,
                covariance: [1.0, 1.0, 1.0],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }];
            fusion.process_measurements(m, 1000);
        }

        let stats = fusion.get_stats();
        assert_eq!(stats.total_tracks, 5);
        assert_eq!(stats.tentative_tracks, 5);
        assert_eq!(stats.confirmed_tracks, 0);
        assert_eq!(stats.frame_count, 5);
    }

    #[test]
    fn test_fusion_clear_removes_all_tracks() {
        let config = FusionConfig::default();
        let mut fusion = MultiSensorFusion::new(config);

        let m = vec![SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [10.0, 0.0, 5.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        }];
        fusion.process_measurements(m, 1000);
        assert_eq!(fusion.get_tracks().len(), 1);

        fusion.clear();
        assert!(fusion.get_tracks().is_empty());
        assert_eq!(fusion.get_stats().frame_count, 0);
        // Regression: the predict clock must reset with everything else, or a
        // post-clear replay whose timestamps are at or before the old clock sees
        // dt = 0 on every frame (no prediction, frozen covariances, mis-sized
        // association gates) until wall-clock time catches up.
        assert_eq!(fusion.last_predict_ms, 0);

        // And a replayed stream with earlier timestamps must actually predict:
        // two frames 100 ms apart re-establish a track after the clear.
        for (t, x) in [(100u64, 10.0f64), (200, 10.5)] {
            let m = vec![SensorMeasurement {
                sensor_id: "cam1".to_string(),
                modality: SensorModality::Visual,
                timestamp_ms: t,
                position: [x, 0.0, 5.0],
                velocity: None,
                covariance: [1.0, 1.0, 1.0],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }];
            fusion.process_measurements(m, t);
        }
        assert_eq!(
            fusion.get_tracks().len(),
            1,
            "replay after clear must track"
        );
        assert_eq!(fusion.last_predict_ms, 200, "clock must follow the replay");
    }

    /// Fixture generator for the cross-repo integration proof (not a test of
    /// crebain itself, hence `#[ignore]`): writes a deterministic clean-capture
    /// JSONL of emitted `PidObservation`s to `CREBAIN_PID_FIXTURE_PATH`. The
    /// output is checked into galadriel as
    /// `crates/galadriel-ncp/tests/fixtures/crebain_clean_capture.jsonl`, where
    /// an integration test proves genuine crebain output parses and does not
    /// false-alarm the detector. Regenerate with:
    ///
    /// ```text
    /// CREBAIN_PID_FIXTURE_PATH=/tmp/capture.jsonl \
    ///   cargo test generate_galadriel_pid_fixture -- --ignored
    /// ```
    #[test]
    #[ignore = "fixture generator; run manually with CREBAIN_PID_FIXTURE_PATH set"]
    fn generate_galadriel_pid_fixture() {
        let Some(path) = std::env::var_os("CREBAIN_PID_FIXTURE_PATH") else {
            eprintln!("CREBAIN_PID_FIXTURE_PATH not set; nothing to do");
            return;
        };
        // Deterministic pseudo-noise: xorshift64*, Irwin–Hall(4) ≈ N(0,1).
        let mut rng_state: u64 = 0x9E37_79B9_7F4A_7C15 ^ 0xC0FF_EE00;
        let mut next_unit = move || -> f64 {
            let mut x = rng_state;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            rng_state = x;
            (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut gauss = move || -> f64 {
            // Irwin–Hall(4): mean 2, var 4/12; scaled to unit variance.
            ((next_unit() + next_unit() + next_unit() + next_unit()) - 2.0) / (1.0 / 3.0f64).sqrt()
        };

        let config = FusionConfig {
            emit_innovations: true,
            emit_innovation_research: true,
            ..FusionConfig::default()
        };
        let mut fusion = MultiSensorFusion::new(config);
        let mut records = Vec::new();
        for frame in 0..160u64 {
            let t = 1_000 + frame * 100;
            let dt = frame as f64 * 0.1;
            // One true target, constant velocity.
            let truth = [50.0 + 2.0 * dt, 30.0 + 1.0 * dt, 20.0];
            let mut ms = Vec::new();
            // Visual + acoustic: Cartesian, noise matched to the declared R.
            for (sensor, modality, std) in [
                ("cam1", SensorModality::Visual, 1.0f64),
                ("mic1", SensorModality::Acoustic, 2.0f64.sqrt()),
            ] {
                ms.push(SensorMeasurement {
                    sensor_id: sensor.to_string(),
                    modality,
                    timestamp_ms: t,
                    position: [
                        truth[0] + std * gauss(),
                        truth[1] + std * gauss(),
                        truth[2] + std * gauss(),
                    ],
                    velocity: None,
                    covariance: [std * std, std * std, std * std],
                    confidence: 0.9,
                    class_label: "drone".to_string(),
                    metadata: HashMap::new(),
                });
            }
            // Radar: polar [range m, az rad, el rad], noise matched to R.
            let range = (truth[0] * truth[0] + truth[1] * truth[1] + truth[2] * truth[2]).sqrt();
            let az = truth[1].atan2(truth[0]);
            let el = (truth[2] / range).asin();
            ms.push(SensorMeasurement {
                sensor_id: "radar1".to_string(),
                modality: SensorModality::Radar,
                timestamp_ms: t,
                position: [
                    range + 1.0 * gauss(),
                    az + 0.0316 * gauss(),
                    el + 0.0316 * gauss(),
                ],
                velocity: None,
                covariance: [1.0, 0.001, 0.001],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            });
            fusion.process_measurements(ms, t);
            records.extend(fusion.drain_pid_observations());
        }
        assert!(
            records.len() > 400,
            "expected a rich capture, got {} records",
            records.len()
        );
        let mut out = String::new();
        for record in &records {
            out.push_str(&serde_json::to_string(record).unwrap());
            out.push('\n');
        }
        std::fs::write(&path, out).expect("write fixture");
        eprintln!("wrote {} records to {path:?}", records.len());
    }

    #[test]
    fn degenerate_radar_geometry_falls_back_to_isotropic_cartesian() {
        // A radar return at the origin makes the polar Jacobian singular; the
        // fallback must be isotropic RANGE variance in m² — not the raw polar
        // diagonal, whose rad² entries reintroduce the unit mixing this
        // function exists to fix.
        let meas = SensorMeasurement {
            sensor_id: "radar1".to_string(),
            modality: SensorModality::Radar,
            timestamp_ms: 1_000,
            position: [0.0, 0.0, 0.0], // range 0: degenerate
            velocity: None,
            covariance: [4.0, 0.001, 0.001],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let pos = measurement_position_cartesian(&meas);
        let r = measurement_r_cartesian(&meas, &pos);
        for i in 0..3 {
            assert!(
                (r[(i, i)] - 4.0).abs() < 1e-12,
                "diag[{i}] = {} — expected isotropic range variance",
                r[(i, i)]
            );
        }
    }

    #[test]
    fn lowest_noise_ordering_is_unit_correct_across_modalities() {
        // Radar at 100 m with tight ANGULAR variances has a large Cartesian
        // lateral spread (r²·σ_ang² = 10 m² per angle); a 0.5 m² visual is the
        // genuinely tighter sensor. Under the old raw-triple sum radar "won"
        // (4.0+0.001+0.001 ≈ 4.0 < 1.5) and seeded the track; unit-correct
        // ordering must seed from the visual measurement instead.
        let radar = SensorMeasurement {
            sensor_id: "radar1".to_string(),
            modality: SensorModality::Radar,
            timestamp_ms: 1_000,
            position: [100.0, 0.0, 0.0], // polar: range 100, az 0, el 0
            velocity: None,
            covariance: [4.0, 0.001, 0.001],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let visual = SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1_000,
            position: [100.4, 0.3, 0.2], // same cluster, distinct location
            velocity: None,
            covariance: [0.5, 0.5, 0.5],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        // Sanity: Cartesian traces order visual < radar.
        let rt = measurement_r_cartesian(&radar, &measurement_position_cartesian(&radar)).trace();
        let vt = measurement_r_cartesian(&visual, &measurement_position_cartesian(&visual)).trace();
        assert!(vt < rt, "visual ({vt}) must be tighter than radar ({rt})");

        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        fusion.process_measurements(vec![radar, visual.clone()], 1_000);
        let track = fusion.tracks.values().next().expect("one track");
        // The born track is seeded from the cluster representative: with
        // unit-correct ordering that is the visual measurement's position.
        for (axis, expect) in [(0, 100.4), (1, 0.3), (2, 0.2)] {
            assert!(
                (track.state[axis] - expect).abs() < 1e-9,
                "state[{axis}] = {} — track must be seeded from the visual \
                 measurement, not the unit-mixed radar pick",
                track.state[axis]
            );
        }
    }

    #[test]
    fn long_gap_prediction_integrates_the_whole_interval() {
        // One engine sees a single 2 s dropout; its twin coasts through the
        // same interval as two empty 1 s frames. The substepped predictor must
        // make both walk the identical predict sequence, so the post-gap
        // covariance (and state) must match exactly — the old min(gap, 1.0)
        // clamp integrated only 1 s of the dropout and left the prior
        // overconfident by the unmodeled remainder.
        let meas = |t: u64, x: f64| SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: t,
            position: [x, 0.0, 5.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let mut gap = MultiSensorFusion::new(FusionConfig::default());
        let mut stepped = MultiSensorFusion::new(FusionConfig::default());
        // Identical hit history (4 hits: confirmed, and 2 misses keep 3-of-5).
        for k in 0..4u64 {
            let t = 1_000 + k * 1_000;
            let x = 10.0 + k as f64;
            gap.process_measurements(vec![meas(t, x)], t);
            stepped.process_measurements(vec![meas(t, x)], t);
        }
        // Dropout: one 2 s jump vs two explicit empty 1 s frames.
        gap.process_measurements(vec![], 6_000);
        stepped.process_measurements(vec![], 5_000);
        stepped.process_measurements(vec![], 6_000);

        let (gt, st) = (
            gap.tracks.values().next().expect("gap track"),
            stepped.tracks.values().next().expect("stepped track"),
        );
        for i in 0..6 {
            assert!(
                (gt.state[i] - st.state[i]).abs() < 1e-12,
                "state[{i}] diverged: {} vs {}",
                gt.state[i],
                st.state[i]
            );
            for j in 0..6 {
                assert!(
                    (gt.covariance[(i, j)] - st.covariance[(i, j)]).abs() < 1e-9,
                    "cov[({i},{j})] diverged: {} vs {} - the gap's remainder \
                     was not integrated",
                    gt.covariance[(i, j)],
                    st.covariance[(i, j)]
                );
            }
        }
    }

    #[test]
    fn emit_innovations_produces_contract_records_with_consistent_nis() {
        let config = FusionConfig {
            emit_innovations: true,
            emit_innovation_research: true,
            ..FusionConfig::default()
        };
        let mut fusion = MultiSensorFusion::new(config);

        // Three frames, one visual measurement each. Frame 1 BIRTHS the track
        // (the measurement seeds the state; no filter update, hence no record —
        // an innovation only exists against a prior), frames 2 and 3 associate
        // and update, one record each.
        for (t, x) in [(1000u64, 10.0f64), (1100, 10.4), (1200, 10.8)] {
            let m = vec![SensorMeasurement {
                sensor_id: "cam1".to_string(),
                modality: SensorModality::Visual,
                timestamp_ms: t,
                position: [x, 0.0, 5.0],
                velocity: None,
                covariance: [1.0, 1.0, 1.0],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }];
            fusion.process_measurements(m, t);
        }

        let records = fusion.drain_pid_observations();
        assert_eq!(
            records.len(),
            2,
            "one record per ASSOCIATED measurement (track birth emits none)"
        );
        assert!(
            fusion.drain_pid_observations().is_empty(),
            "drain empties the buffer"
        );
        for record in &records {
            assert_eq!(record.dof, 3);
            assert_eq!(record.modality, SensorModality::Visual);
            assert!(record.nis.is_finite() && record.nis >= 0.0);
            // Research mode: y and S present, and NIS must be exactly the
            // whitened norm of the emitted pair — the record is self-consistent.
            let y = record.innovation.expect("research innovation");
            let cov = record.innovation_cov.expect("research covariance");
            let yv = Vector3::new(y[0], y[1], y[2]);
            let sm = Matrix3::from_fn(|i, j| cov[i][j]);
            let recomputed = yv.dot(&sm.cholesky().expect("SPD").solve(&yv));
            assert!(
                (record.nis - recomputed).abs() < 1e-9,
                "nis {} vs recomputed {recomputed}",
                record.nis
            );
            // And the wire line parses back (the galadriel-ingestible shape).
            let line = serde_json::to_string(record).unwrap();
            let back: crate::pid_observation::PidObservation = serde_json::from_str(&line).unwrap();
            assert_eq!(back.track_id, record.track_id);
        }
        assert_eq!(records[0].seq, 2, "first ASSOCIATED fusion frame");
        assert_eq!(records[1].seq, 3);
        assert_eq!(records[0].timestamp_ms, 1100);
        assert_eq!(records[1].timestamp_ms, 1200);

        // Off by default: no records without the flag.
        let mut silent = MultiSensorFusion::new(FusionConfig::default());
        silent.process_measurements(
            vec![SensorMeasurement {
                sensor_id: "cam1".to_string(),
                modality: SensorModality::Visual,
                timestamp_ms: 1000,
                position: [1.0, 0.0, 5.0],
                velocity: None,
                covariance: [1.0, 1.0, 1.0],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }],
            1000,
        );
        assert!(silent.drain_pid_observations().is_empty());
    }

    /// The sidecar stamps `seq` with the fusion frame count, and galadriel keys
    /// per-channel streams by (track, modality) with strictly increasing `seq`.
    /// Association clusters by class label + gate (not modality), so one cluster
    /// can carry several same-modality returns in one frame — only the FIRST may
    /// emit; a second record would be a duplicate (track, modality, seq) identity
    /// that galadriel rejects as a replay and that poisons JSONL parsing.
    #[test]
    fn emit_innovations_dedupes_same_modality_within_a_frame() {
        let config = FusionConfig {
            emit_innovations: true,
            ..FusionConfig::default()
        };
        let mut fusion = MultiSensorFusion::new(config);
        let meas = |sensor: &str, modality, x: f64, t: u64| SensorMeasurement {
            sensor_id: sensor.to_string(),
            modality,
            timestamp_ms: t,
            position: [x, 0.0, 5.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };

        // Frame 1 births the track (no record — an innovation needs a prior).
        fusion.process_measurements(vec![meas("cam1", SensorModality::Visual, 10.0, 1000)], 1000);
        // Frame 2: TWO visual returns (different cameras) plus one thermal
        // return, all inside one association cluster for the same track.
        fusion.process_measurements(
            vec![
                meas("cam1", SensorModality::Visual, 10.4, 1100),
                meas("cam2", SensorModality::Visual, 10.5, 1100),
                meas("ir1", SensorModality::Thermal, 10.45, 1100),
            ],
            1100,
        );

        let records = fusion.drain_pid_observations();
        let visual = records
            .iter()
            .filter(|r| r.modality == SensorModality::Visual)
            .count();
        let thermal = records
            .iter()
            .filter(|r| r.modality == SensorModality::Thermal)
            .count();
        assert_eq!(
            visual, 1,
            "a second same-modality return in one frame must not emit a \
             duplicate (track, modality, seq) record"
        );
        assert_eq!(thermal, 1, "distinct modalities in one frame each emit");
        assert_eq!(records.len(), 2);
        assert_eq!(
            records[0].seq, records[1].seq,
            "one fusion frame stamps one seq across modalities"
        );
    }

    #[test]
    fn test_fusion_max_track_limit() {
        let config = FusionConfig::default();
        let mut fusion = MultiSensorFusion::new(config);

        let mut measurements = Vec::new();
        for i in 0..MAX_FUSION_TRACKS + 10 {
            measurements.push(SensorMeasurement {
                sensor_id: format!("cam{}", i),
                modality: SensorModality::Visual,
                timestamp_ms: 1000,
                position: [i as f64 * 100.0, 0.0, 5.0],
                velocity: None,
                covariance: [1.0, 1.0, 1.0],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            });
        }

        let tracks = fusion.process_measurements(measurements, 1000);
        assert!(tracks.len() <= MAX_FUSION_TRACKS);
    }

    #[test]
    fn solve_assignment_finds_global_optimum() {
        // Min-cost 1:1 assignment of this matrix is row0→1, row1→0, row2→2
        // (total 1+2+2=5), the unique optimum — a global, not greedy, result.
        let cost = vec![vec![4, 1, 3], vec![2, 0, 5], vec![3, 2, 2]];
        assert_eq!(
            solve_assignment(&cost, ASSIGNMENT_INF),
            vec![Some(1), Some(0), Some(2)]
        );
    }

    #[test]
    fn solve_assignment_more_rows_than_cols_leaves_one_unmatched() {
        // 3 rows, 2 cols → exactly one row unmatched; exercises the transpose branch.
        let cost = vec![vec![1, 5], vec![5, 1], vec![3, 3]];
        assert_eq!(
            solve_assignment(&cost, ASSIGNMENT_INF),
            vec![Some(0), Some(1), None]
        );
    }

    #[test]
    fn solve_assignment_inf_cell_yields_none() {
        // A row whose only reachable cell is the INF sentinel must stay unmatched.
        let cost = vec![vec![5, 8], vec![ASSIGNMENT_INF, ASSIGNMENT_INF]];
        let r = solve_assignment(&cost, ASSIGNMENT_INF);
        assert_eq!(r[0], Some(0));
        assert_eq!(r[1], None);
    }

    #[test]
    fn solve_assignment_many_all_inf_rows_no_overflow() {
        // Many simultaneously out-of-gate tracks (all-INF rows) accumulate INF-scale
        // dual potentials. With the finite ASSIGNMENT_INF sentinel this must neither
        // overflow nor force-match: the two finite rows take the two columns and every
        // all-INF row resolves to None.
        let inf = ASSIGNMENT_INF;
        let cost = vec![
            vec![10, 20],
            vec![30, 5],
            vec![inf, inf],
            vec![inf, inf],
            vec![inf, inf],
            vec![inf, inf],
        ];
        let r = solve_assignment(&cost, inf);
        // Rows 0 and 1 are matched to the two distinct columns; the four all-INF rows
        // coast (None).
        assert!(r[0].is_some() && r[1].is_some());
        assert_ne!(r[0], r[1]);
        for row in r.iter().skip(2) {
            assert_eq!(*row, None);
        }
    }

    #[test]
    fn gnn_assigns_each_separated_target_its_own_measurement() {
        // Two well-separated tracks; a frame with one return near each. Global
        // assignment updates BOTH (count stays 2) — no stealing, no duplicates.
        let mk = |id: &str, x: f64, ts: u64| SensorMeasurement {
            sensor_id: id.to_string(),
            modality: SensorModality::Lidar,
            timestamp_ms: ts,
            position: [x, 0.0, 0.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let born = fusion.process_measurements(vec![mk("a", 0.0, 1000), mk("b", 10.0, 1000)], 1000);
        assert_eq!(born.len(), 2, "two separated births");
        let tracks =
            fusion.process_measurements(vec![mk("a", 0.3, 1100), mk("b", 9.7, 1100)], 1100);
        assert_eq!(
            tracks.len(),
            2,
            "each return associates to its track; no duplicates"
        );
        let mut xs: Vec<f64> = tracks.iter().map(|t| t.position[0]).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!(
            xs[0] < 5.0 && xs[1] > 5.0,
            "tracks stayed separated: {xs:?}"
        );
    }

    #[test]
    fn multi_sensor_cluster_still_fuses_into_one_track() {
        // A co-located visual+thermal pair must cluster and update a SINGLE existing
        // track with both modalities (GNN must not break N-sensors→1-target fusion).
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let visual = SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [10.0, 0.0, 5.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.8,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        // Birth a single track first.
        fusion.process_measurements(vec![visual.clone()], 1000);
        let thermal = SensorMeasurement {
            sensor_id: "ir1".to_string(),
            modality: SensorModality::Thermal,
            position: [10.4, 0.4, 5.0],
            covariance: [2.0, 2.0, 2.0],
            confidence: 0.7,
            timestamp_ms: 1100,
            ..visual.clone()
        };
        let visual2 = SensorMeasurement {
            timestamp_ms: 1100,
            ..visual.clone()
        };
        let tracks = fusion.process_measurements(vec![visual2, thermal], 1100);
        assert_eq!(tracks.len(), 1, "co-located returns fuse into one track");
        assert_eq!(
            tracks[0].sensor_sources.len(),
            2,
            "both modalities contributed"
        );
    }

    #[test]
    fn new_co_located_multi_sensor_target_births_single_track() {
        // Two co-located, same-class returns with NO existing track must seed ONE new
        // track (the cluster representative), not one per sensor.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let a = SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [3.0, 0.0, 2.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.8,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let b = SensorMeasurement {
            sensor_id: "ir1".to_string(),
            modality: SensorModality::Thermal,
            position: [3.2, 0.2, 2.0],
            ..a.clone()
        };
        let tracks = fusion.process_measurements(vec![a, b], 1000);
        assert_eq!(
            tracks.len(),
            1,
            "co-located new target births one track, not two"
        );
    }

    #[test]
    fn cluster_separates_different_classes() {
        // Co-located returns of different class must NOT cluster → two tracks.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let drone = SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [5.0, 0.0, 3.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.8,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let bird = SensorMeasurement {
            sensor_id: "cam2".to_string(),
            class_label: "bird".to_string(),
            ..drone.clone()
        };
        let tracks = fusion.process_measurements(vec![drone, bird], 1000);
        assert_eq!(tracks.len(), 2, "different classes do not cluster");
    }

    /// Build a single visual measurement at `pos`, for sliding-window tests.
    fn m_of_n_meas(t_ms: u64, pos: [f64; 3]) -> Vec<SensorMeasurement> {
        vec![SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: t_ms,
            position: pos,
            velocity: Some([0.0, 0.0, 0.0]),
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        }]
    }

    #[test]
    fn test_m_of_n_confirms_with_intermittent_hits() {
        // M=3, N=5. Pattern hit, miss, hit, miss, hit over 5 frames: 3 hits in the
        // window => confirm, even though the hits are not consecutive.
        let config = FusionConfig::default(); // M=3, N=5
        let mut fusion = MultiSensorFusion::new(config);
        let pos = [10.0, 0.0, 5.0];
        let empty: Vec<SensorMeasurement> = Vec::new();

        fusion.process_measurements(m_of_n_meas(1000, pos), 1000); // hit
        fusion.process_measurements(empty.clone(), 1100); // miss
        fusion.process_measurements(m_of_n_meas(1200, pos), 1200); // hit
        fusion.process_measurements(empty.clone(), 1300); // miss
        let tracks = fusion.process_measurements(m_of_n_meas(1400, pos), 1400); // hit

        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].state, TrackStateLabel::Confirmed);
    }

    #[test]
    fn test_intermittent_track_not_deleted_prematurely() {
        // M=3, N=5, max_missed_detections=4. Pattern hit, miss, hit, miss, hit, miss
        // over 6 frames: misses-in-window never reaches 4 and hits reach 3 => the
        // track survives and is Confirmed.
        let config = FusionConfig {
            max_missed_detections: 4,
            ..Default::default()
        };
        let mut fusion = MultiSensorFusion::new(config);
        let pos = [10.0, 0.0, 5.0];
        let empty: Vec<SensorMeasurement> = Vec::new();

        fusion.process_measurements(m_of_n_meas(1000, pos), 1000); // hit
        fusion.process_measurements(empty.clone(), 1100); // miss
        fusion.process_measurements(m_of_n_meas(1200, pos), 1200); // hit
        fusion.process_measurements(empty.clone(), 1300); // miss
        fusion.process_measurements(m_of_n_meas(1400, pos), 1400); // hit
        let tracks = fusion.process_measurements(empty, 1500); // miss

        assert_eq!(tracks.len(), 1, "track must survive intermittent misses");
        assert_eq!(tracks[0].state, TrackStateLabel::Confirmed);
    }

    #[test]
    fn test_m_of_n_deletes_on_window_misses() {
        // M=3, N=5, max_missed_detections=4. One hit then 4 misses fills the window
        // as 0b10000 (hits=1, misses=4>=4) => deleted. A 3-miss prefix survives.
        let config = FusionConfig {
            max_missed_detections: 4,
            ..Default::default()
        };
        let mut fusion = MultiSensorFusion::new(config);
        let pos = [10.0, 0.0, 5.0];
        let empty: Vec<SensorMeasurement> = Vec::new();

        fusion.process_measurements(m_of_n_meas(1000, pos), 1000); // hit
        fusion.process_measurements(empty.clone(), 1100); // miss 1
        fusion.process_measurements(empty.clone(), 1200); // miss 2
        let survivors = fusion.process_measurements(empty.clone(), 1300); // miss 3
        assert_eq!(survivors.len(), 1, "3 window-misses (<4) must survive");
        assert_eq!(survivors[0].state, TrackStateLabel::Coasting);

        let tracks = fusion.process_measurements(empty, 1400); // miss 4
        assert!(tracks.is_empty(), "4 window-misses (>=4) must be deleted");
    }

    #[test]
    fn clutter_blipping_every_third_frame_is_deleted() {
        // Regression (window-fill undercount): with max_missed=4, N=5, a track on
        // an H,M,M,H,M,M,... pattern accumulates 4 misses in the 5-slot window by
        // frame 6 and MUST be deleted. The old `age + missed_detections` fill
        // (age counts hits only; missed resets on every hit) never reached the
        // true fill, so clutter blipping every 3rd frame survived forever.
        let config = FusionConfig {
            max_missed_detections: 4,
            ..Default::default()
        };
        let mut fusion = MultiSensorFusion::new(config);
        let pos = [10.0, 0.0, 5.0];
        let empty: Vec<SensorMeasurement> = Vec::new();

        fusion.process_measurements(m_of_n_meas(1000, pos), 1000); // hit
        fusion.process_measurements(empty.clone(), 1100); // miss
        fusion.process_measurements(empty.clone(), 1200); // miss
        fusion.process_measurements(m_of_n_meas(1300, pos), 1300); // hit
        let survivors = fusion.process_measurements(empty.clone(), 1400); // miss
        assert_eq!(survivors.len(), 1, "only 3 misses in the window so far");
        let tracks = fusion.process_measurements(empty, 1500); // miss -> 4 in window
        assert!(
            tracks.is_empty(),
            "H,M,M,H,M,M reaches 4 misses in the 5-slot window and must delete"
        );
    }

    #[test]
    fn out_of_order_timestamp_does_not_phantom_predict_or_rewind_clock() {
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        fusion.process_measurements(
            vec![SensorMeasurement {
                sensor_id: "cam1".to_string(),
                modality: SensorModality::Visual,
                timestamp_ms: 2000,
                position: [10.0, 0.0, 5.0],
                velocity: Some([10.0, 0.0, 0.0]),
                covariance: [1.0, 1.0, 1.0],
                confidence: 0.9,
                class_label: "drone".to_string(),
                metadata: HashMap::new(),
            }],
            2000,
        );
        let before = fusion.tracks.values().next().expect("track born").state;

        // Older and duplicate timestamps must not predict (the old dt = 0.1
        // fallback moved x by 1 m per frame at vx = 10) nor rewind the clock.
        fusion.process_measurements(Vec::new(), 1500);
        assert_eq!(fusion.last_predict_ms, 2000, "clock must not rewind");
        let after = fusion.tracks.values().next().expect("track alive").state;
        assert_eq!(before, after, "no phantom predict on out-of-order frame");

        fusion.process_measurements(Vec::new(), 2000);
        let after = fusion.tracks.values().next().expect("track alive").state;
        assert_eq!(before, after, "no phantom predict on duplicate timestamp");
    }

    /// Base valid visual measurement for validation tests.
    fn valid_meas() -> SensorMeasurement {
        SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [10.0, 0.0, 5.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        }
    }

    #[test]
    fn validation_rejects_non_positive_covariance() {
        let mut zero = valid_meas();
        zero.covariance = [0.0, 1.0, 1.0];
        let err = validate_sensor_measurements(&[zero]).expect_err("zero variance must fail");
        assert!(err.contains("covariance"), "got: {err}");

        let mut negative = valid_meas();
        negative.covariance = [1.0, -0.5, 1.0];
        let err =
            validate_sensor_measurements(&[negative]).expect_err("negative variance must fail");
        assert!(err.contains("covariance"), "got: {err}");
    }

    #[test]
    fn validation_rejects_radar_polar_domain_violations() {
        let radar = |position: [f64; 3]| SensorMeasurement {
            sensor_id: "radar1".to_string(),
            modality: SensorModality::Radar,
            position,
            covariance: [0.5, 0.01, 0.01],
            ..valid_meas()
        };
        assert!(validate_sensor_measurements(&[radar([100.0, 0.5, 0.2])]).is_ok());
        // Negative range.
        assert!(validate_sensor_measurements(&[radar([-1.0, 0.0, 0.0])]).is_err());
        // Azimuth beyond ±2π.
        assert!(validate_sensor_measurements(&[radar([100.0, 7.0, 0.0])]).is_err());
        // Elevation beyond ±π/2.
        assert!(validate_sensor_measurements(&[radar([100.0, 0.0, 2.0])]).is_err());
        // The polar domain checks must not apply to Cartesian modalities.
        let mut cartesian = valid_meas();
        cartesian.position = [-50.0, 7.0, 2.0];
        assert!(validate_sensor_measurements(&[cartesian]).is_ok());
    }

    #[test]
    fn radar_returns_cluster_with_cartesian_converted_covariance() {
        // Two same-class radar returns ~2 m apart in cross-range at 100 m with
        // σ_az = 0.01 rad: with the Jacobian-converted Cartesian covariance the
        // pairwise gate sees d² ≈ 2 (merge → one birth); the raw polar
        // [m², rad², rad²] covariance against Cartesian metres saw d² ≈ 2e4, so
        // radar returns never merged.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let radar = |azimuth: f64| SensorMeasurement {
            sensor_id: format!("radar-{azimuth}"),
            modality: SensorModality::Radar,
            timestamp_ms: 1000,
            position: [100.0, azimuth, 0.0],
            velocity: None,
            covariance: [0.5, 1e-4, 1e-4],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let tracks = fusion.process_measurements(vec![radar(0.0), radar(0.02)], 1000);
        assert_eq!(
            tracks.len(),
            1,
            "co-located radar returns must cluster into one birth"
        );
    }

    #[test]
    fn class_gate_blocks_cross_class_assignment() {
        // A co-located 'bird' return must not update a 'drone' track: the spatial
        // cost is near zero, so only the class gate keeps them apart.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let drone = SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [5.0, 0.0, 3.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        fusion.process_measurements(vec![drone.clone()], 1000);

        let bird = SensorMeasurement {
            class_label: "bird".to_string(),
            timestamp_ms: 1100,
            ..drone
        };
        let tracks = fusion.process_measurements(vec![bird], 1100);
        assert_eq!(tracks.len(), 2, "the bird return must spawn its own track");
        let mut labels: Vec<&str> = tracks.iter().map(|t| t.class_label.as_str()).collect();
        labels.sort_unstable();
        assert_eq!(labels, ["bird", "drone"], "drone track keeps its label");
    }

    #[test]
    fn track_class_label_refreshes_from_associated_measurement() {
        // Same canonical class ('quadcopter' and 'drone' both map to Drone): the
        // return associates and the raw label refreshes to the newest evidence.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let quad = SensorMeasurement {
            sensor_id: "cam1".to_string(),
            modality: SensorModality::Visual,
            timestamp_ms: 1000,
            position: [5.0, 0.0, 3.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "quadcopter".to_string(),
            metadata: HashMap::new(),
        };
        fusion.process_measurements(vec![quad.clone()], 1000);

        let drone = SensorMeasurement {
            class_label: "drone".to_string(),
            timestamp_ms: 1100,
            ..quad
        };
        let tracks = fusion.process_measurements(vec![drone], 1100);
        assert_eq!(tracks.len(), 1, "same canonical class must associate");
        assert_eq!(tracks[0].class_label, "drone");
    }

    #[test]
    fn assigned_cluster_contributes_only_in_gate_members() {
        // A cluster can contain a member that pairs with another member inside
        // the pairwise cluster gate yet individually fails the assigned track's
        // gate; that member must NOT be handed to the track's update.
        let mut fusion = MultiSensorFusion::new(FusionConfig::default());
        let track = TrackState {
            id: "TRK-00001".to_string(),
            state: Vector6::zeros(),
            covariance: Matrix6::identity() * 0.01,
            class_label: "drone".to_string(),
            confidence: 0.9,
            sensor_sources: vec![SensorModality::Lidar],
            last_update_ms: 1000,
            age: 3,
            missed_detections: 0,
            hit_history: 0b111,
            opportunities: 3,
            state_label: TrackStateLabel::Confirmed,
        };
        fusion.tracks.insert(track.id.clone(), track);

        let near = SensorMeasurement {
            sensor_id: "lidar1".to_string(),
            modality: SensorModality::Lidar,
            timestamp_ms: 1100,
            position: [0.2, 0.0, 0.0],
            velocity: None,
            covariance: [1.0, 1.0, 1.0],
            confidence: 0.9,
            class_label: "drone".to_string(),
            metadata: HashMap::new(),
        };
        let far = SensorMeasurement {
            sensor_id: "lidar2".to_string(),
            position: [3.0, 0.0, 0.0],
            covariance: [0.5, 0.5, 0.5],
            ..near.clone()
        };
        // near↔far cluster gate: d² = 2.8²/1.5 ≈ 5.2 < 11.345 → one cluster.
        // far vs track: d² = 3²/0.51 ≈ 17.6 > 11.345 → individually out of gate.
        let (associations, unassociated) = fusion.associate_measurements(&[near, far]);
        assert_eq!(
            associations["TRK-00001"],
            vec![0],
            "only the in-gate member is handed to the track"
        );
        assert!(unassociated.is_empty(), "the cluster itself was assigned");
    }

    #[test]
    fn assignment_inf_headroom_covers_max_threshold_and_matrix_dim() {
        // The sentinel must exceed the worst-case TOTAL real assignment cost:
        // the largest quantized in-gate cell times the maximum matrix dimension.
        let max_cell = (MAX_ASSOCIATION_THRESHOLD * ASSIGNMENT_QUANTIZE_SCALE) as i64;
        assert!(ASSIGNMENT_INF / max_cell >= MAX_FUSION_TRACKS as i64);
        // ...while staying far from i64 overflow when every row is out-of-gate.
        assert!(ASSIGNMENT_INF
            .checked_mul(MAX_FUSION_TRACKS as i64)
            .is_some_and(|total| total < i64::MAX / 8));
    }

    #[test]
    fn measurement_jacobian_is_finite_at_origin() {
        // The elevation row divides by r2; unclamped it was NaN/inf at the origin.
        let h = ExtendedKalmanFilter::measurement_jacobian(&Vector6::zeros());
        assert!(h.iter().all(|v| v.is_finite()), "Jacobian at origin: {h}");
    }

    #[test]
    fn test_covariance_volume_deletion() {
        // A small covariance-volume ceiling deletes a track once predict_all inflates
        // its position-block determinant past the limit. max_missed_detections is set
        // to the window size (so the config also satisfies validate_fusion_config's
        // max_missed_detections <= confirmation_window rule); with one early hit,
        // misses_in_window stays below 32 for the few frames before the covariance
        // ceiling fires, so the deletion is attributable to covariance volume.
        let config = FusionConfig {
            max_position_cov_volume: 50.0,
            max_missed_detections: 32,
            confirmation_window: 32,
            ..Default::default()
        };
        let mut fusion = MultiSensorFusion::new(config);
        let pos = [10.0, 0.0, 5.0];
        fusion.process_measurements(m_of_n_meas(1000, pos), 1000);

        let empty: Vec<SensorMeasurement> = Vec::new();
        let mut deleted = false;
        for frame in 1..=50u64 {
            let t_ms = 1000 + frame * 100;
            let tracks = fusion.process_measurements(empty.clone(), t_ms);
            if tracks.is_empty() {
                deleted = true;
                break;
            }
        }
        assert!(
            deleted,
            "track must be deleted once its covariance volume exceeds the ceiling"
        );
    }

    #[test]
    fn test_covariance_volume_does_not_delete_tight_track() {
        // With the default 1e6 ceiling, a well-observed track over 5 confirming
        // frames keeps a small position-block determinant and is NOT deleted.
        let config = FusionConfig::default();
        let mut fusion = MultiSensorFusion::new(config);
        let pos = [10.0, 0.0, 5.0];
        let mut tracks = Vec::new();
        for frame in 0..5u64 {
            let t_ms = 1000 + frame * 100;
            tracks = fusion.process_measurements(m_of_n_meas(t_ms, pos), t_ms);
        }
        assert_eq!(tracks.len(), 1, "tight track must not be deleted");
        assert_eq!(tracks[0].state, TrackStateLabel::Confirmed);
    }

    #[test]
    fn fusion_init_rejects_window_smaller_than_confirm_hits() {
        // M (min_confirmation_hits) must be <= N (confirmation_window).
        let config = FusionConfig {
            min_confirmation_hits: 6,
            confirmation_window: 5,
            ..Default::default()
        };
        let err = validate_fusion_config(&config).expect_err("M > N must be rejected");
        assert!(
            err.contains("confirmation_window"),
            "error must mention confirmation_window, got: {err}"
        );
    }

    #[test]
    fn fusion_init_rejects_window_above_max() {
        let config = FusionConfig {
            confirmation_window: 33,
            ..Default::default()
        };
        let err = validate_fusion_config(&config).expect_err("N > 32 must be rejected");
        assert!(
            err.contains("confirmation_window"),
            "error must mention confirmation_window, got: {err}"
        );
    }

    #[test]
    fn fusion_init_rejects_non_positive_cov_volume() {
        let config = FusionConfig {
            max_position_cov_volume: 0.0,
            ..Default::default()
        };
        assert!(
            validate_fusion_config(&config).is_err(),
            "zero max_position_cov_volume must be rejected"
        );

        let config = FusionConfig {
            max_position_cov_volume: f64::NAN,
            ..Default::default()
        };
        assert!(
            validate_fusion_config(&config).is_err(),
            "NaN max_position_cov_volume must be rejected"
        );
    }

    #[test]
    fn fusion_config_deserializes_without_new_fields() {
        // Back-compat: a serialized config WITHOUT confirmation_window /
        // max_position_cov_volume must deserialize with the serde defaults.
        let json = r#"{
            "algorithm": "ExtendedKalman",
            "process_noise": 1.0,
            "measurement_noise": 2.0,
            "association_threshold": 11.345,
            "max_missed_detections": 5,
            "min_confirmation_hits": 3,
            "particle_count": 100
        }"#;
        let config: FusionConfig =
            serde_json::from_str(json).expect("legacy config must deserialize");
        assert_eq!(config.confirmation_window, 5);
        assert_eq!(config.max_position_cov_volume, 1e6);
    }
}
