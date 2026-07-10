//! The per-measurement innovation record galadriel consumes.
//!
//! This is crebain's side of the **frozen sidecar contract**: the struct
//! mirrors `galadriel_core::PidObservation` field-for-field (names, order,
//! serde attributes), and the golden tests below assert byte-equality with the
//! exact JSON shapes galadriel's own `sidecar_payload_contract_is_frozen` test
//! pins. We deliberately do **not** depend on galadriel-core (wrong dependency
//! direction for the ecosystem); the mirrored-frozen-contract pattern is the
//! intended seam, and galadriel's live tap counts (rather than silently drops)
//! anything that stops matching.
//!
//! `SensorModality`'s lowercase serde tags (`"visual"` … `"radiofrequency"`)
//! are already byte-identical to galadriel's `Modality`, so the enum is used
//! directly — no mapping table.

use crate::sensor_fusion::SensorModality;
use serde::{Deserialize, Serialize};

/// One per-measurement filter-innovation record, emitted by fusion
/// `update_track` (one per associated measurement that actually updated the
/// filter) and consumed by galadriel's baseline (`nis` + `dof`) and PID engine
/// (`innovation` / `innovation_cov`, research mode).
///
/// `nis = yᵀ S⁻¹ y` is formed against the state as it stood entering that
/// measurement's update — the a-priori state for the first measurement of a
/// frame, the sequentially-conditioned prior for co-located follow-ups
/// (standard sequential fusion). Frames: Cartesian `[x, y, z]` metres for
/// visual/thermal/acoustic/lidar; under the EKF, radar records are the polar
/// residual `[range m, az rad, el rad]` with azimuth wrapped to `[-π, π]`
/// (under non-EKF algorithms radar is fused — and therefore recorded — in the
/// Cartesian conversion frame; `nis`/`dof` are frame-agnostic either way).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PidObservation {
    /// Numeric track id — the `u64` behind the `"TRK-%05u"` label.
    pub track_id: u64,
    /// Measurement time, ms since epoch (`SensorMeasurement.timestamp_ms`).
    pub timestamp_ms: u64,
    /// Monotonic fusion frame counter at emit time.
    pub seq: u64,
    /// Modality of the measurement that produced this residual.
    pub modality: SensorModality,
    /// Scalar whitened innovation: `NIS = yᵀ S⁻¹ y ~ χ²(dof)`.
    pub nis: f64,
    /// Innovation dimension / χ² degrees of freedom (3 for this fusion core).
    pub dof: u8,
    /// Raw innovation `y` (research mode; omitted from the wire when `None`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub innovation: Option<[f64; 3]>,
    /// Innovation covariance `S`, row-major 3×3, same frame as `innovation`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub innovation_cov: Option<[[f64; 3]; 3]>,
}

/// The numeric id behind a `"TRK-%05u"` track label (`{:05}` pads but never
/// truncates, so six-digit ids parse fine). `None` for foreign label shapes.
pub fn track_numeric_id(track_id: &str) -> Option<u64> {
    track_id.strip_prefix("TRK-")?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte-for-byte the same golden strings galadriel-ncp's
    /// `sidecar_payload_contract_is_frozen` pins. If either side changes shape,
    /// its own golden test fails first — the contract can only move deliberately
    /// and in lockstep.
    #[test]
    fn matches_galadriel_frozen_sidecar_contract() {
        let full = PidObservation {
            track_id: 42,
            timestamp_ms: 1_700_000_000_000,
            seq: 7,
            modality: SensorModality::Radar,
            nis: 2.75,
            dof: 3,
            innovation: Some([1.0, -2.5, 0.25]),
            innovation_cov: Some([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        };
        let expect_full = concat!(
            r#"{"track_id":42,"timestamp_ms":1700000000000,"seq":7,"#,
            r#""modality":"radar","nis":2.75,"dof":3,"#,
            r#""innovation":[1.0,-2.5,0.25],"#,
            r#""innovation_cov":[[1.0,0.0,0.0],[0.0,1.0,0.0],[0.0,0.0,1.0]]}"#
        );
        assert_eq!(serde_json::to_string(&full).unwrap(), expect_full);

        let minimal =
            r#"{"track_id":1,"timestamp_ms":0,"seq":0,"modality":"acoustic","nis":3.1,"dof":3}"#;
        let obs: PidObservation = serde_json::from_str(minimal).expect("minimal contract parses");
        assert!(obs.innovation.is_none() && obs.innovation_cov.is_none());
        assert_eq!(serde_json::to_string(&obs).unwrap(), minimal);
    }

    #[test]
    fn track_ids_round_trip_through_the_label_format() {
        assert_eq!(track_numeric_id("TRK-00042"), Some(42));
        assert_eq!(track_numeric_id("TRK-123456"), Some(123_456));
        assert_eq!(track_numeric_id("track-1"), None);
        assert_eq!(track_numeric_id("TRK-"), None);
        assert_eq!(track_numeric_id("TRK-abc"), None);
    }
}
