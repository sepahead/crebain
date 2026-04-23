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
use rand_distr::{Distribution, Normal};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::f64::consts::PI;

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
    /// Position in sensor frame [x, y, z] or [azimuth, elevation, range]
    pub position: [f64; 3],
    /// Velocity if available [vx, vy, vz]
    pub velocity: Option<[f64; 3]>,
    /// Measurement covariance (diagonal elements)
    pub covariance: [f64; 3],
    /// Detection confidence [0, 1]
    pub confidence: f64,
    /// Classification label
    pub class_label: String,
    /// Additional sensor-specific data
    pub metadata: HashMap<String, f64>,
}

/// Thermal-specific measurement for IR camera integration.
/// Roadmap: v0.6.0 - Hardware-in-the-loop testing with FLIR cameras
#[allow(dead_code)]
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
#[allow(dead_code)]
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
        // Guard against negative covariance diagonals (numerical drift)
        // which would produce NaN from sqrt and break JSON serialization.
        let pos_unc = [
            track.covariance[(0, 0)].max(0.0).sqrt(),
            track.covariance[(1, 1)].max(0.0).sqrt(),
            track.covariance[(2, 2)].max(0.0).sqrt(),
        ];
        let vel_unc = [
            track.covariance[(3, 3)].max(0.0).sqrt(),
            track.covariance[(4, 4)].max(0.0).sqrt(),
            track.covariance[(5, 5)].max(0.0).sqrt(),
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

fn calculate_threat_level(class: &str, confidence: f64) -> u8 {
    let class_lower = class.to_lowercase();
    let base_threat = if class_lower.contains("drone") || class_lower.contains("uav") {
        3
    } else if class_lower.contains("aircraft") || class_lower.contains("helicopter") {
        2
    } else if class_lower.contains("bird") {
        1
    } else {
        2
    };

    if confidence > 0.8 && base_threat >= 3 {
        4
    } else {
        base_threat
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// KALMAN FILTER
// ═══════════════════════════════════════════════════════════════════════════════

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
    ) {
        self.update_raw(
            &mut state.state,
            &mut state.covariance,
            measurement,
            r_override,
        );
    }

    /// Raw update step - operates directly on state/covariance without TrackState overhead
    #[inline]
    pub fn update_raw(
        &self,
        state: &mut Vector6<f64>,
        covariance: &mut Matrix6<f64>,
        measurement: &Vector3<f64>,
        r_override: Option<&Matrix3<f64>>,
    ) {
        let h = Self::measurement_matrix();
        let r = r_override.unwrap_or(&self.r);

        // Innovation: y = z - H * x
        let predicted_measurement = h * *state;
        let innovation = measurement - predicted_measurement;

        // Innovation covariance: S = H * P * H^T + R
        let s = h * *covariance * h.transpose() + r;

        // Kalman gain: K = P * H^T * S^(-1)
        // If innovation covariance is singular, skip update (measurement is redundant)
        let s_inv = match s.try_inverse() {
            Some(inv) => inv,
            None => {
                log::warn!(
                    "[KalmanFilter] Innovation covariance singular (det={:.2e}), skipping update",
                    s.determinant()
                );
                return; // Skip this update rather than corrupt state
            }
        };
        let k = *covariance * h.transpose() * s_inv;

        // State update: x = x + K * y
        *state += k * innovation;

        // Covariance update: P = (I - K * H) * P
        let i = Matrix6::identity();
        let kh = k * h;
        *covariance = (i - kh) * *covariance;
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
    #[allow(dead_code)] // Used by update_polar for radar/lidar fusion
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
    #[allow(dead_code)] // Used by update_polar for radar/lidar fusion
    fn measurement_jacobian(state: &Vector6<f64>) -> nalgebra::Matrix3x6<f64> {
        let x = state[0];
        let y = state[1];
        let z = state[2];

        let r2 = x * x + y * y + z * z;
        let r = r2.sqrt().max(1e-6);
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
    #[allow(dead_code)] // Placeholder for radar/lidar sensor integration
    pub fn update_polar(
        &self,
        state: &mut TrackState,
        measurement: &Vector3<f64>,
        r: &Matrix3<f64>,
    ) {
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
        let s_inv = match s.try_inverse() {
            Some(inv) => inv,
            None => {
                log::warn!(
                    "[EKF] Innovation covariance singular (det={:.2e}), skipping polar update",
                    s.determinant()
                );
                return; // Skip this update rather than corrupt state
            }
        };

        // Kalman gain
        let k = state.covariance * h.transpose() * s_inv;

        // State update
        state.state += k * innovation;

        // Covariance update
        let i = Matrix6::identity();
        state.covariance = (i - k * h) * state.covariance;
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
    ) {
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

        // Measurement covariance
        let mut s = self.r.clone();
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

        // Kalman gain
        let s_inv = match s.clone().try_inverse() {
            Some(inv) => inv,
            None => {
                log::warn!("[UKF] Measurement covariance singular, skipping update");
                return; // Skip this update rather than corrupt state
            }
        };
        let k = &pxz * s_inv;

        // Innovation
        let innovation = meas_dyn - meas_mean;

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

        // Pre-create normal distributions for each state dimension
        // Use fallback std=1.0 if variance is invalid (negative or NaN)
        let normals: Vec<Normal<f64>> = (0..6)
            .map(|i| {
                let variance = initial_cov[(i, i)];
                let std = if variance > 0.0 && variance.is_finite() {
                    variance.sqrt()
                } else {
                    1.0 // Fallback for invalid variance
                };
                // SAFETY: std is guaranteed positive and finite here
                Normal::new(0.0, std).unwrap_or_else(|_| {
                    Normal::new(0.0, 1.0).unwrap_or_else(|_| Normal::new(0.0, 1e-10).unwrap())
                })
            })
            .collect();

        for _p in 0..self.num_particles {
            let mut state = *initial_state;
            for i in 0..6 {
                state[i] += normals[i].sample(&mut rng);
            }
            self.particles.push(Particle { state, weight });
        }
    }

    /// Predict step - propagate particles
    pub fn predict(&mut self, dt: f64) {
        // Ensure process_noise is valid for Normal distribution
        let noise_std = if self.process_noise > 0.0 && self.process_noise.is_finite() {
            self.process_noise
        } else {
            log::warn!(
                "[ParticleFilter] Invalid process_noise {}, using 1.0",
                self.process_noise
            );
            1.0
        };
        let noise = Normal::new(0.0, noise_std).unwrap_or_else(|_| {
            Normal::new(0.0, 1.0).unwrap_or_else(|_| Normal::new(0.0, 1e-10).unwrap())
        });
        let mut rng = rand::rng();

        for particle in &mut self.particles {
            // Constant velocity motion model with noise
            particle.state[0] += particle.state[3] * dt + noise.sample(&mut rng) * dt * 0.1;
            particle.state[1] += particle.state[4] * dt + noise.sample(&mut rng) * dt * 0.1;
            particle.state[2] += particle.state[5] * dt + noise.sample(&mut rng) * dt * 0.1;
            particle.state[3] += noise.sample(&mut rng) * dt;
            particle.state[4] += noise.sample(&mut rng) * dt;
            particle.state[5] += noise.sample(&mut rng) * dt;
        }
    }

    /// Update step - weight particles based on measurement likelihood
    pub fn update(&mut self, measurement: &Vector3<f64>) {
        let sigma = self.measurement_noise;
        let sigma2 = sigma * sigma;

        // Calculate weights based on Gaussian likelihood
        for particle in &mut self.particles {
            let dx = particle.state[0] - measurement[0];
            let dy = particle.state[1] - measurement[1];
            let dz = particle.state[2] - measurement[2];

            let dist_sq = dx * dx + dy * dy + dz * dz;
            let likelihood = (-dist_sq / (2.0 * sigma2)).exp();
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
#[allow(dead_code)] // CoordinatedTurn to be implemented for maneuvering targets
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
    /// Kalman filters for each model
    kf_cv: KalmanFilter,
    kf_ca: KalmanFilter,
    /// Model probabilities
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
        // CV model has lower process noise, CA has higher
        let kf_cv = KalmanFilter::new(process_noise * 0.5, measurement_noise);
        let kf_ca = KalmanFilter::new(process_noise * 2.0, measurement_noise);

        Self {
            kf_cv,
            kf_ca,
            model_probs: [0.8, 0.2], // Start with high probability of CV
            transition_matrix: [
                [0.95, 0.05], // CV -> CV, CV -> CA
                [0.10, 0.90], // CA -> CV, CA -> CA
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
        self.kf_ca
            .predict_raw(&mut self.states[1], &mut self.covariances[1], dt);
    }

    /// Update step
    pub fn update(&mut self, measurement: &Vector3<f64>) {
        let h = KalmanFilter::measurement_matrix();

        // Calculate likelihoods for each model
        let mut likelihoods = [0.0; 2];

        for ((likelihood, state), cov) in likelihoods
            .iter_mut()
            .zip(self.states.iter())
            .zip(self.covariances.iter())
        {
            let predicted = h * state;
            let innovation = measurement - predicted;
            let s = h * cov * h.transpose() + self.kf_cv.r;

            if let Some(s_inv) = s.try_inverse() {
                let mahalanobis = (innovation.transpose() * s_inv * innovation)[0];
                let det = s.determinant().max(1e-10);
                *likelihood = (-0.5 * mahalanobis).exp() / (2.0 * PI * det).sqrt();
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
        self.kf_cv.update_raw(
            &mut self.states[0],
            &mut self.covariances[0],
            measurement,
            None,
        );
        self.kf_ca.update_raw(
            &mut self.states[1],
            &mut self.covariances[1],
            measurement,
            None,
        );
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

    /// Get model probabilities [CV, CA]
    #[allow(dead_code)] // Public API for diagnostics
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
    pub particle_count: usize,
}

impl Default for FusionConfig {
    fn default() -> Self {
        Self {
            algorithm: FilterAlgorithm::ExtendedKalman,
            process_noise: 1.0,
            measurement_noise: 2.0,
            association_threshold: 10.0, // Mahalanobis distance threshold
            max_missed_detections: 5,
            min_confirmation_hits: 3,
            particle_count: 100,
        }
    }
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
        }
    }

    /// Process a batch of measurements from multiple sensors
    pub fn process_measurements(
        &mut self,
        measurements: Vec<SensorMeasurement>,
        timestamp_ms: u64,
    ) -> Vec<TrackOutput> {
        self.frame_count += 1;

        // Step 1: Predict all tracks forward
        // Compute dt from actual timestamps; fall back to 0.1s (10 Hz) on first frame
        let dt = if self.last_predict_ms > 0 && timestamp_ms > self.last_predict_ms {
            ((timestamp_ms - self.last_predict_ms) as f64 / 1000.0).min(1.0)
        } else {
            0.1
        };
        self.last_predict_ms = timestamp_ms;
        self.predict_all(dt);

        // Step 2: Associate measurements to tracks
        let (associations, unassociated) = self.associate_measurements(&measurements);

        // Step 3: Update associated tracks
        for (track_id, meas_indices) in associations {
            self.update_track(&track_id, &measurements, &meas_indices, timestamp_ms);
        }

        // Step 4: Create new tracks from unassociated measurements
        for meas_idx in unassociated {
            self.create_track(&measurements[meas_idx], timestamp_ms);
        }

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

    fn associate_measurements(
        &self,
        measurements: &[SensorMeasurement],
    ) -> (HashMap<String, Vec<usize>>, Vec<usize>) {
        let mut associations: HashMap<String, Vec<usize>> = HashMap::new();
        let mut unassociated: Vec<usize> = Vec::new();

        for (meas_idx, meas) in measurements.iter().enumerate() {
            let meas_pos = Vector3::new(meas.position[0], meas.position[1], meas.position[2]);

            let mut best_track: Option<&str> = None;
            let mut best_distance = f64::MAX;

            for (track_id, track) in &self.tracks {
                if track.state_label == TrackStateLabel::Lost {
                    continue;
                }

                // Calculate Mahalanobis distance
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

                // Mahalanobis distance if covariance is invertible, otherwise Euclidean
                let distance = if let Some(inv) = pos_cov.try_inverse() {
                    (diff.transpose() * inv * diff)[0].sqrt()
                } else {
                    // Covariance singular - fall back to Euclidean distance
                    // This is acceptable for association as it's a heuristic
                    diff.norm()
                };

                if distance < best_distance && distance < self.config.association_threshold {
                    best_distance = distance;
                    best_track = Some(track_id);
                }
            }

            if let Some(track_id) = best_track {
                associations
                    .entry(track_id.to_string())
                    .or_default()
                    .push(meas_idx);
            } else {
                unassociated.push(meas_idx);
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
    ) {
        let track = match self.tracks.get_mut(track_id) {
            Some(t) => t,
            None => return,
        };

        // Fuse multiple measurements if available
        let mut fused_position = Vector3::zeros();
        let mut total_weight: f64 = 0.0;
        let mut sensor_sources = Vec::new();
        let mut max_confidence: f64 = 0.0;

        for &idx in meas_indices {
            let meas = &measurements[idx];
            let weight = meas.confidence;
            fused_position +=
                Vector3::new(meas.position[0], meas.position[1], meas.position[2]) * weight;
            total_weight += weight;

            if !sensor_sources.contains(&meas.modality) {
                sensor_sources.push(meas.modality);
            }
            max_confidence = max_confidence.max(meas.confidence);
        }

        if total_weight > 0.0 {
            fused_position /= total_weight;
        }

        // Update with fused measurement
        match self.config.algorithm {
            FilterAlgorithm::Kalman => {
                self.kf.update(track, &fused_position, None);
            }
            FilterAlgorithm::ExtendedKalman => {
                // Use Cartesian update for simplicity
                self.kf.update(track, &fused_position, None);
            }
            FilterAlgorithm::UnscentedKalman => {
                self.ukf
                    .update(&mut track.state, &mut track.covariance, &fused_position);
            }
            FilterAlgorithm::Particle => {
                if let Some(pf) = self.particle_filters.get_mut(track_id) {
                    pf.update(&fused_position);
                    pf.resample();
                    let (mean, cov) = pf.get_estimate();
                    track.state = mean;
                    track.covariance = cov;
                }
            }
            FilterAlgorithm::IMM => {
                if let Some(imm) = self.imm_filters.get_mut(track_id) {
                    imm.update(&fused_position);
                    let (mean, cov) = imm.get_estimate();
                    track.state = mean;
                    track.covariance = cov;
                }
            }
        }

        // Update track metadata
        track.sensor_sources = sensor_sources;
        track.last_update_ms = timestamp_ms;
        track.age += 1;
        track.missed_detections = 0;

        // Multi-sensor confidence boost
        let sensor_boost = (track.sensor_sources.len() as f64 - 1.0) * 0.1;
        track.confidence = (max_confidence + sensor_boost).min(1.0);

        // Update track state
        if track.age >= self.config.min_confirmation_hits {
            track.state_label = TrackStateLabel::Confirmed;
        }
    }

    fn create_track(&mut self, measurement: &SensorMeasurement, timestamp_ms: u64) {
        let track_id = format!("TRK-{:05}", self.next_track_id);
        self.next_track_id += 1;

        let initial_state = Vector6::new(
            measurement.position[0],
            measurement.position[1],
            measurement.position[2],
            measurement.velocity.map(|v| v[0]).unwrap_or(0.0),
            measurement.velocity.map(|v| v[1]).unwrap_or(0.0),
            measurement.velocity.map(|v| v[2]).unwrap_or(0.0),
        );

        let initial_cov = Matrix6::from_diagonal(&Vector6::new(
            measurement.covariance[0],
            measurement.covariance[1],
            measurement.covariance[2],
            10.0,
            10.0,
            10.0, // Initial velocity uncertainty
        ));

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

    fn handle_missed_detections(&mut self, timestamp_ms: u64) {
        let mut tracks_to_remove = Vec::new();

        for (track_id, track) in &mut self.tracks {
            if track.state_label == TrackStateLabel::Lost {
                tracks_to_remove.push(track_id.clone());
                continue;
            }

            // Only increment missed_detections for tracks that were NOT
            // updated this frame. update_track resets missed_detections = 0
            // and sets last_update_ms = timestamp_ms, so any track with a
            // different last_update_ms was not associated this frame.
            if track.last_update_ms != timestamp_ms {
                track.missed_detections += 1;
            }

            if track.missed_detections >= self.config.max_missed_detections {
                track.state_label = TrackStateLabel::Lost;
                tracks_to_remove.push(track_id.clone());
            } else if track.missed_detections >= 2 {
                track.state_label = TrackStateLabel::Coasting;
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
    }

    /// Update configuration
    pub fn set_config(&mut self, config: FusionConfig) {
        let algorithm_changed = self.config.algorithm != config.algorithm;
        self.config = config.clone();
        self.kf = KalmanFilter::new(config.process_noise, config.measurement_noise);
        self.ekf = ExtendedKalmanFilter::new(config.process_noise, config.measurement_noise);
        self.ukf = UnscentedKalmanFilter::new(config.process_noise, config.measurement_noise);

        // When the algorithm changes, per-track filter state (particles, IMM
        // mode probabilities) from the old algorithm is invalid.  Clear them
        // so they get re-created on the next update_track / create_track call.
        if algorithm_changed {
            self.particle_filters.clear();
            self.imm_filters.clear();
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

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

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
}
