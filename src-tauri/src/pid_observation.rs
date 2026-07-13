//! The per-measurement innovation record and live envelope galadriel consumes.
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
//! directly — no mapping table. The naked [`PidObservation`] JSON shape remains
//! the diagnostic JSONL contract; live publication wraps it in a validated,
//! bounded [`SidecarEnvelope`].

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::sensor_fusion::SensorModality;

/// Maximum number of axes carried by Galadriel's producer-attested projection.
pub const MAX_CONSISTENCY_PROJECTION_AXES: usize = 3;

/// Relative symmetry tolerance used by Galadriel for innovation covariances.
pub const COVARIANCE_SYMMETRY_RELATIVE_TOLERANCE: f64 = 1e-9;

/// Largest integer represented exactly by every JSON/NCP peer.
pub const JSON_SAFE_INTEGER_MAX: u64 = 9_007_199_254_740_991;

/// Maximum bytes in a live sidecar identity segment.
pub const MAX_ID_SEGMENT_BYTES: usize = 64;

/// Maximum encoded live payload accepted by Galadriel's default live tap.
pub const MAX_SIDECAR_ENVELOPE_BYTES: usize = 64 * 1024;

/// Named NCP sensor carrying the frozen observation sidecar.
pub const SIDECAR_SENSOR_NAME: &str = "galadriel-pid";

/// Frozen observation-envelope discriminator.
pub const SIDECAR_KIND: &str = "galadriel_pid_observation";

/// Frozen Galadriel-owned observation-envelope schema version.
pub const SIDECAR_SCHEMA_VERSION: &str = "1.0";

/// NCP wire version pinned by both Crebain and Galadriel.
pub const SIDECAR_NCP_VERSION: &str = "0.8";

/// Advisory identity of the pinned NCP contract revision.
pub const SIDECAR_CONTRACT_HASH: &str = "d1b50a2d8a265276";

/// Project-neutral fallback realm used by NCP.
pub const SIDECAR_DEFAULT_REALM: &str = "ncp";

/// A signed residual projection that is comparable across sensor modalities.
///
/// The producer may populate this only when every value is expressed in the
/// declared common frame and was computed from the same immutable, pre-update
/// track prior. The numeric identifiers mirror Galadriel's frozen v1 contract;
/// transport authentication remains a separate concern.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsistencyProjection {
    /// Projected residual values. Only `[..dimensions]` is active.
    pub values: [f64; MAX_CONSISTENCY_PROJECTION_AXES],
    /// Number of active axes, in `1..=3`.
    pub dimensions: u8,
    /// Producer registry identifier for the common physical frame.
    pub frame_id: u64,
    /// Producer registry identifier for the projection/calibration context.
    pub context_id: u64,
    /// Globally unique frozen-prior snapshot identifier within the producer epoch.
    pub prior_id: u64,
}

impl ConsistencyProjection {
    /// Validate the same bounded semantics enforced by Galadriel before this
    /// producer attestation is allowed onto a sidecar route or capture.
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=MAX_CONSISTENCY_PROJECTION_AXES as u8).contains(&self.dimensions) {
            return Err(format!(
                "consistency projection dimensions must be in 1..={MAX_CONSISTENCY_PROJECTION_AXES}"
            ));
        }
        for (name, value) in [
            ("frame_id", self.frame_id),
            ("context_id", self.context_id),
            ("prior_id", self.prior_id),
        ] {
            if value == 0 || value > JSON_SAFE_INTEGER_MAX {
                return Err(format!(
                    "consistency projection {name} must be within 1..={JSON_SAFE_INTEGER_MAX}"
                ));
            }
        }
        if !self.values.iter().all(|value| value.is_finite()) {
            return Err("consistency projection values must be finite".to_string());
        }
        if self.values[self.dimensions as usize..]
            .iter()
            .any(|value| *value != 0.0)
        {
            return Err("inactive consistency projection axes must be zero".to_string());
        }
        Ok(())
    }
}

fn covariance_pair_scale(left_diagonal: f64, right_diagonal: f64) -> f64 {
    if left_diagonal == right_diagonal {
        return left_diagonal;
    }
    let scale = left_diagonal.sqrt() * right_diagonal.sqrt();
    if scale.is_finite() {
        scale
    } else {
        left_diagonal.max(right_diagonal)
    }
}

/// Validate a 3x3 innovation covariance using the frozen Galadriel semantics.
///
/// Small asymmetric floating-point roundoff is accepted relative to the
/// corresponding diagonal scale. The symmetrized matrix must then be positive
/// definite by Sylvester's criterion.
pub fn validate_and_symmetrize_covariance(
    mut covariance: [[f64; 3]; 3],
) -> Result<[[f64; 3]; 3], String> {
    if !covariance.iter().flatten().all(|value| value.is_finite()) {
        return Err("innovation covariance values must be finite".to_string());
    }
    if covariance.iter().enumerate().any(|(i, row)| row[i] <= 0.0) {
        return Err("innovation_cov diagonal must be strictly positive".to_string());
    }
    for i in 0..3 {
        for j in (i + 1)..3 {
            let pair_scale = covariance_pair_scale(covariance[i][i], covariance[j][j]);
            let normalized_difference =
                covariance[i][j] / pair_scale - covariance[j][i] / pair_scale;
            if !normalized_difference.is_finite()
                || normalized_difference.abs() > COVARIANCE_SYMMETRY_RELATIVE_TOLERANCE
            {
                return Err(
                    "innovation_cov must be symmetric within its per-pair covariance scale"
                        .to_string(),
                );
            }
            let symmetric = covariance[i][j] / 2.0 + covariance[j][i] / 2.0;
            covariance[i][j] = symmetric;
            covariance[j][i] = symmetric;
        }
    }

    let scale = covariance
        .iter()
        .flatten()
        .map(|value| value.abs())
        .fold(0.0_f64, f64::max);
    let a = covariance[0][0] / scale;
    let b = covariance[0][1] / scale;
    let c = covariance[0][2] / scale;
    let d = covariance[1][1] / scale;
    let e = covariance[1][2] / scale;
    let f = covariance[2][2] / scale;
    let det2 = a * d - b * b;
    let det3 = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
    if !(a > 0.0 && det2 > 0.0 && det3 > 0.0) {
        return Err("innovation_cov must be positive definite".to_string());
    }
    Ok(covariance)
}

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
#[serde(deny_unknown_fields)]
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
    /// Optional common-frame residual computed from one frozen pre-update prior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consistency_projection: Option<ConsistencyProjection>,
}

impl PidObservation {
    /// Validate producer-side wire invariants before serialization.
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("track_id", self.track_id),
            ("timestamp_ms", self.timestamp_ms),
            ("seq", self.seq),
        ] {
            if value > JSON_SAFE_INTEGER_MAX {
                return Err(format!("{name} exceeds the exact JSON integer range"));
            }
        }
        if !self.nis.is_finite() || self.nis < 0.0 {
            return Err("nis must be finite and nonnegative".to_string());
        }
        if self.dof == 0 {
            return Err("dof must be greater than zero".to_string());
        }
        if self.innovation.is_some() != self.innovation_cov.is_some() {
            return Err(
                "innovation and innovation_cov must both be present or both be absent".to_string(),
            );
        }
        if let Some(innovation) = self.innovation {
            if self.dof != 3 || !innovation.iter().all(|value| value.is_finite()) {
                return Err("research innovation requires dof 3 and finite values".to_string());
            }
        }
        if let Some(covariance) = self.innovation_cov {
            validate_and_symmetrize_covariance(covariance)?;
        }
        if let Some(projection) = self.consistency_projection {
            projection.validate()?;
        }
        Ok(())
    }
}

/// Advisory comparison of an envelope's canonical NCP contract hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarContractStatus {
    /// The envelope advertises Crebain's pinned contract revision.
    Match,
    /// The envelope advertises a different, but well-formed, contract revision.
    Mismatch { peer: String },
}

/// Semantic or encoding failure for a live [`SidecarEnvelope`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarEnvelopeError {
    /// The payload discriminator is not the frozen Galadriel sidecar kind.
    InvalidKind { received: String },
    /// The Galadriel-owned schema version is unsupported.
    UnsupportedSchemaVersion { received: String },
    /// The NCP wire version is not the pinned canonical version.
    IncompatibleNcpVersion(String),
    /// The NCP contract hash is not lowercase 64-bit hexadecimal.
    InvalidContractHash(String),
    /// The session cannot be used as one NCP key segment.
    InvalidSessionId(String),
    /// The producer cannot be used as one NCP key segment.
    InvalidProducerId(String),
    /// Claimed envelope provenance differs from an expected publication stream.
    ProvenanceMismatch {
        field: &'static str,
        expected: String,
        received: String,
    },
    /// The nested observation violates the frozen producer contract.
    InvalidObservation(String),
    /// JSON serialization failed.
    Json(String),
    /// The encoded envelope exceeds the configured transport ceiling.
    EncodedEnvelopeTooLarge { actual: usize, maximum: usize },
}

impl fmt::Display for SidecarEnvelopeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKind { received } => write!(
                formatter,
                "invalid sidecar kind: got {received:?}, want {SIDECAR_KIND:?}"
            ),
            Self::UnsupportedSchemaVersion { received } => write!(
                formatter,
                "unsupported sidecar schema version: got {received:?}, want {SIDECAR_SCHEMA_VERSION:?}"
            ),
            Self::IncompatibleNcpVersion(received) => write!(
                formatter,
                "incompatible NCP version in sidecar envelope: {received:?}"
            ),
            Self::InvalidContractHash(received) => write!(
                formatter,
                "invalid NCP contract hash in sidecar envelope: {received:?}"
            ),
            Self::InvalidSessionId(received) => {
                write!(formatter, "invalid sidecar session_id: {received:?}")
            }
            Self::InvalidProducerId(received) => {
                write!(formatter, "invalid sidecar producer_id: {received:?}")
            }
            Self::ProvenanceMismatch {
                field,
                expected,
                received,
            } => write!(
                formatter,
                "sidecar {field} mismatch: got {received:?}, expected {expected:?}"
            ),
            Self::InvalidObservation(error) => {
                write!(formatter, "invalid sidecar observation: {error}")
            }
            Self::Json(error) => write!(formatter, "invalid sidecar JSON: {error}"),
            Self::EncodedEnvelopeTooLarge { actual, maximum } => write!(
                formatter,
                "sidecar envelope has {actual} bytes, maximum {maximum}"
            ),
        }
    }
}

impl std::error::Error for SidecarEnvelopeError {}

/// Frozen live envelope for one validated [`PidObservation`].
///
/// `session_id` is the producer epoch and must change after a restart that
/// resets observation sequences. The identities are authenticated claims only
/// when the transport ACL binds the publisher to the route.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SidecarEnvelope {
    /// Stable discriminator, [`SIDECAR_KIND`].
    pub kind: String,
    /// Galadriel-owned schema version, [`SIDECAR_SCHEMA_VERSION`].
    pub schema_version: String,
    /// NCP wire version governing route construction.
    pub ncp_version: String,
    /// Advisory NCP contract revision identity.
    pub contract_hash: String,
    /// NCP session and producer epoch.
    pub session_id: String,
    /// Concrete producer identity.
    pub producer_id: String,
    /// Frozen per-measurement payload.
    pub observation: PidObservation,
}

impl SidecarEnvelope {
    /// Construct an envelope stamped with the frozen local identities.
    pub fn try_new(
        session_id: impl Into<String>,
        producer_id: impl Into<String>,
        observation: PidObservation,
    ) -> Result<Self, SidecarEnvelopeError> {
        let envelope = Self {
            kind: SIDECAR_KIND.to_string(),
            schema_version: SIDECAR_SCHEMA_VERSION.to_string(),
            ncp_version: SIDECAR_NCP_VERSION.to_string(),
            contract_hash: SIDECAR_CONTRACT_HASH.to_string(),
            session_id: session_id.into(),
            producer_id: producer_id.into(),
            observation,
        };
        envelope.validate()?;
        Ok(envelope)
    }

    /// Validate envelope identity, key-safe provenance, nested semantics, and
    /// cross-language exact-integer bounds.
    ///
    /// A different canonical contract hash remains advisory, matching the NCP
    /// handshake and Galadriel consumer policy.
    pub fn validate(&self) -> Result<SidecarContractStatus, SidecarEnvelopeError> {
        if self.kind != SIDECAR_KIND {
            return Err(SidecarEnvelopeError::InvalidKind {
                received: self.kind.clone(),
            });
        }
        if self.schema_version != SIDECAR_SCHEMA_VERSION {
            return Err(SidecarEnvelopeError::UnsupportedSchemaVersion {
                received: self.schema_version.clone(),
            });
        }
        if self.ncp_version != SIDECAR_NCP_VERSION {
            return Err(SidecarEnvelopeError::IncompatibleNcpVersion(
                self.ncp_version.clone(),
            ));
        }
        if self.contract_hash.len() != SIDECAR_CONTRACT_HASH.len()
            || !self
                .contract_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(SidecarEnvelopeError::InvalidContractHash(
                self.contract_hash.clone(),
            ));
        }
        if !valid_id_segment(&self.session_id) || self.session_id.len() > MAX_ID_SEGMENT_BYTES {
            return Err(SidecarEnvelopeError::InvalidSessionId(
                self.session_id.clone(),
            ));
        }
        if !valid_id_segment(&self.producer_id) || self.producer_id.len() > MAX_ID_SEGMENT_BYTES {
            return Err(SidecarEnvelopeError::InvalidProducerId(
                self.producer_id.clone(),
            ));
        }
        self.observation
            .validate()
            .map_err(SidecarEnvelopeError::InvalidObservation)?;

        if self.contract_hash == SIDECAR_CONTRACT_HASH {
            Ok(SidecarContractStatus::Match)
        } else {
            Ok(SidecarContractStatus::Mismatch {
                peer: self.contract_hash.clone(),
            })
        }
    }

    /// Validate and bind the claimed identities to one concrete publication.
    pub fn validate_for(
        &self,
        expected_session_id: &str,
        expected_producer_id: &str,
    ) -> Result<SidecarContractStatus, SidecarEnvelopeError> {
        let status = self.validate()?;
        if self.session_id != expected_session_id {
            return Err(SidecarEnvelopeError::ProvenanceMismatch {
                field: "session_id",
                expected: expected_session_id.to_string(),
                received: self.session_id.clone(),
            });
        }
        if self.producer_id != expected_producer_id {
            return Err(SidecarEnvelopeError::ProvenanceMismatch {
                field: "producer_id",
                expected: expected_producer_id.to_string(),
                received: self.producer_id.clone(),
            });
        }
        Ok(status)
    }

    /// Serialize a valid envelope under Galadriel's live payload ceiling.
    pub fn encode(&self) -> Result<Vec<u8>, SidecarEnvelopeError> {
        self.encode_with_limit(MAX_SIDECAR_ENVELOPE_BYTES)
    }

    /// Serialize under a caller-supplied ceiling no larger than the contract cap.
    ///
    /// This lets a publisher apply a tighter transport limit without weakening
    /// the shared maximum.
    pub fn encode_with_limit(&self, maximum: usize) -> Result<Vec<u8>, SidecarEnvelopeError> {
        self.validate()?;
        let maximum = maximum.min(MAX_SIDECAR_ENVELOPE_BYTES);
        let encoded = serde_json::to_vec(self)
            .map_err(|error| SidecarEnvelopeError::Json(error.to_string()))?;
        if encoded.len() > maximum {
            return Err(SidecarEnvelopeError::EncodedEnvelopeTooLarge {
                actual: encoded.len(),
                maximum,
            });
        }
        Ok(encoded)
    }
}

fn valid_id_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.chars().any(|character| {
            matches!(character, '/' | '*' | '$' | '#' | '?' | '\u{feff}')
                || character.is_whitespace()
                || character.is_control()
        })
}

fn valid_realm(realm: &str) -> bool {
    !realm.is_empty() && realm.split('/').all(valid_id_segment)
}

/// Build the named NCP sidecar route for a concrete realm and session.
pub fn sidecar_key(realm: &str, session_id: &str) -> Option<String> {
    if !valid_realm(realm) || !valid_id_segment(session_id) {
        return None;
    }
    Some(format!(
        "{realm}/session/{session_id}/sensor/{SIDECAR_SENSOR_NAME}"
    ))
}

/// Build the sidecar route in NCP's project-neutral default realm.
pub fn default_sidecar_key(session_id: &str) -> Option<String> {
    sidecar_key(SIDECAR_DEFAULT_REALM, session_id)
}

/// The numeric id behind a `"TRK-%05u"` track label (`{:05}` pads but never
/// truncates, so six-digit ids parse fine). `None` for foreign label shapes.
pub fn track_numeric_id(track_id: &str) -> Option<u64> {
    track_id.strip_prefix("TRK-")?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_observation() -> PidObservation {
        PidObservation {
            track_id: 42,
            timestamp_ms: 1_700_000_000_000,
            seq: 7,
            modality: SensorModality::Radar,
            nis: 2.75,
            dof: 3,
            innovation: None,
            innovation_cov: None,
            consistency_projection: None,
        }
    }

    fn envelope() -> SidecarEnvelope {
        SidecarEnvelope::try_new("uav3", "crebain", minimal_observation())
            .expect("test envelope is valid")
    }

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
            consistency_projection: Some(ConsistencyProjection {
                values: [1.0, -2.5, 0.25],
                dimensions: 3,
                frame_id: 17,
                context_id: 23,
                prior_id: 29,
            }),
        };
        let expect_full = concat!(
            r#"{"track_id":42,"timestamp_ms":1700000000000,"seq":7,"#,
            r#""modality":"radar","nis":2.75,"dof":3,"#,
            r#""innovation":[1.0,-2.5,0.25],"#,
            r#""innovation_cov":[[1.0,0.0,0.0],[0.0,1.0,0.0],[0.0,0.0,1.0]],"#,
            r#""consistency_projection":{"values":[1.0,-2.5,0.25],"dimensions":3,"#,
            r#""frame_id":17,"context_id":23,"prior_id":29}}"#
        );
        assert_eq!(serde_json::to_string(&full).unwrap(), expect_full);

        let minimal =
            r#"{"track_id":1,"timestamp_ms":0,"seq":0,"modality":"acoustic","nis":3.1,"dof":3}"#;
        let obs: PidObservation = serde_json::from_str(minimal).expect("minimal contract parses");
        assert!(obs.innovation.is_none() && obs.innovation_cov.is_none());
        assert!(obs.consistency_projection.is_none());
        assert_eq!(serde_json::to_string(&obs).unwrap(), minimal);
    }

    #[test]
    fn rejects_unknown_fields_like_the_galadriel_consumer() {
        let payload = r#"{"track_id":1,"timestamp_ms":0,"seq":0,"modality":"acoustic","nis":3.1,"dof":3,"unexpected":true}"#;

        assert!(serde_json::from_str::<PidObservation>(payload).is_err());
    }

    #[test]
    fn rejects_invalid_projection_attestations_before_serialization() {
        let valid = ConsistencyProjection {
            values: [1.0, -2.0, 0.0],
            dimensions: 2,
            frame_id: 1,
            context_id: 2,
            prior_id: 3,
        };
        assert!(valid.validate().is_ok());

        let invalid = [
            ConsistencyProjection {
                dimensions: 0,
                ..valid
            },
            ConsistencyProjection {
                frame_id: 0,
                ..valid
            },
            ConsistencyProjection {
                prior_id: JSON_SAFE_INTEGER_MAX + 1,
                ..valid
            },
            ConsistencyProjection {
                values: [1.0, f64::NAN, 0.0],
                ..valid
            },
            ConsistencyProjection {
                values: [1.0, -2.0, 1.0],
                ..valid
            },
        ];

        for projection in invalid {
            assert!(projection.validate().is_err());
        }
    }

    #[test]
    fn nested_projection_unknown_fields_are_rejected() {
        let payload = r#"{"track_id":1,"timestamp_ms":0,"seq":0,"modality":"acoustic","nis":3.1,"dof":3,"consistency_projection":{"values":[1.0,0.0,0.0],"dimensions":1,"frame_id":1,"context_id":2,"prior_id":3,"unexpected":true}}"#;

        assert!(serde_json::from_str::<PidObservation>(payload).is_err());
    }

    #[test]
    fn innovation_covariance_validation_matches_the_consumer() {
        let roundoff = [
            [
                1.588_373_458_602_466_3,
                8.673_617_379_884_035e-19,
                -4.336_808_689_942_018e-19,
            ],
            [
                0.0,
                0.001_170_253_521_333_416_1,
                -3.388_131_789_017_201_4e-21,
            ],
            [
                -4.336_808_689_942_018e-19,
                -3.388_131_789_017_201_4e-21,
                0.001_153_509_640_919_248_5,
            ],
        ];
        let symmetric = validate_and_symmetrize_covariance(roundoff)
            .expect("consumer-scale roundoff must remain valid");
        assert_eq!(symmetric[0][1], symmetric[1][0]);

        let materially_asymmetric = [[1e-12, 0.0, 0.0], [1e-18, 1e-12, 0.0], [0.0, 0.0, 1e-12]];
        assert!(validate_and_symmetrize_covariance(materially_asymmetric).is_err());

        let indefinite = [[1.0, 2.0, 0.0], [2.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        assert!(validate_and_symmetrize_covariance(indefinite).is_err());

        let mut observation = minimal_observation();
        observation.innovation = Some([0.0; 3]);
        observation.innovation_cov = Some(indefinite);
        assert!(observation.validate().is_err());
    }

    #[test]
    fn sidecar_envelope_exact_json_matches_galadriel() {
        let encoded = envelope().encode().expect("valid envelope encodes");
        let expected = concat!(
            r#"{"kind":"galadriel_pid_observation","schema_version":"1.0","#,
            r#""ncp_version":"0.8","contract_hash":"d1b50a2d8a265276","#,
            r#""session_id":"uav3","producer_id":"crebain","observation":{"#,
            r#""track_id":42,"timestamp_ms":1700000000000,"seq":7,"#,
            r#""modality":"radar","nis":2.75,"dof":3}}"#
        );

        assert_eq!(encoded, expected.as_bytes());
    }

    #[test]
    fn sidecar_envelope_rejects_wrong_identity_and_version() {
        let mut candidate = envelope();
        candidate.kind = "future_kind".to_string();
        assert!(matches!(
            candidate.validate(),
            Err(SidecarEnvelopeError::InvalidKind { .. })
        ));

        candidate = envelope();
        candidate.schema_version = "2.0".to_string();
        assert!(matches!(
            candidate.validate(),
            Err(SidecarEnvelopeError::UnsupportedSchemaVersion { .. })
        ));

        candidate = envelope();
        candidate.ncp_version = "0.7".to_string();
        assert!(matches!(
            candidate.validate(),
            Err(SidecarEnvelopeError::IncompatibleNcpVersion(_))
        ));
    }

    #[test]
    fn sidecar_envelope_surfaces_canonical_contract_drift() {
        let mut candidate = envelope();
        candidate.contract_hash = "deadbeefdeadbeef".to_string();

        assert_eq!(
            candidate.validate(),
            Ok(SidecarContractStatus::Mismatch {
                peer: "deadbeefdeadbeef".to_string()
            })
        );
    }

    #[test]
    fn sidecar_envelope_rejects_malformed_contract_hashes() {
        for malformed in ["deadbeef", "D1B50A2D8A265276", "gggggggggggggggg"] {
            let mut candidate = envelope();
            candidate.contract_hash = malformed.to_string();

            assert!(matches!(
                candidate.validate(),
                Err(SidecarEnvelopeError::InvalidContractHash(_))
            ));
        }
    }

    #[test]
    fn sidecar_envelope_binds_claimed_provenance() {
        let candidate = envelope();

        assert_eq!(
            candidate.validate_for("uav3", "crebain"),
            Ok(SidecarContractStatus::Match)
        );
        assert!(matches!(
            candidate.validate_for("uav4", "crebain"),
            Err(SidecarEnvelopeError::ProvenanceMismatch {
                field: "session_id",
                ..
            })
        ));
        assert!(matches!(
            candidate.validate_for("uav3", "other"),
            Err(SidecarEnvelopeError::ProvenanceMismatch {
                field: "producer_id",
                ..
            })
        ));
    }

    #[test]
    fn sidecar_envelope_identity_segments_are_key_safe_and_bounded() {
        let observation = minimal_observation();
        let at_bound = "x".repeat(MAX_ID_SEGMENT_BYTES);
        assert!(SidecarEnvelope::try_new(at_bound.clone(), at_bound, observation.clone()).is_ok());

        for invalid in [
            String::new(),
            "bad id".to_string(),
            "bad/id".to_string(),
            "bad*id".to_string(),
            "bad\u{feff}id".to_string(),
            "x".repeat(MAX_ID_SEGMENT_BYTES + 1),
        ] {
            assert!(matches!(
                SidecarEnvelope::try_new(invalid.clone(), "crebain", observation.clone()),
                Err(SidecarEnvelopeError::InvalidSessionId(_))
            ));
            assert!(matches!(
                SidecarEnvelope::try_new("uav3", invalid, observation.clone()),
                Err(SidecarEnvelopeError::InvalidProducerId(_))
            ));
        }
    }

    #[test]
    fn sidecar_envelope_rejects_unknown_outer_and_nested_fields() {
        let mut outer = serde_json::to_value(envelope()).expect("envelope serializes");
        outer["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<SidecarEnvelope>(outer).is_err());

        let mut nested = serde_json::to_value(envelope()).expect("envelope serializes");
        nested["observation"]["unexpected"] = serde_json::json!(true);
        assert!(serde_json::from_value::<SidecarEnvelope>(nested).is_err());

        let mut projection = serde_json::to_value(envelope()).expect("envelope serializes");
        projection["observation"]["consistency_projection"] = serde_json::json!({
            "values": [1.0, 0.0, 0.0],
            "dimensions": 1,
            "frame_id": 1,
            "context_id": 2,
            "prior_id": 3,
            "unexpected": true
        });
        assert!(serde_json::from_value::<SidecarEnvelope>(projection).is_err());
    }

    #[test]
    fn sidecar_envelope_rejects_null_required_fields() {
        for field in ["kind", "session_id", "observation"] {
            let mut value = serde_json::to_value(envelope()).expect("envelope serializes");
            value[field] = serde_json::Value::Null;

            assert!(serde_json::from_value::<SidecarEnvelope>(value).is_err());
        }
    }

    #[test]
    fn sidecar_envelope_accepts_null_optional_observation_fields_as_absent() {
        let mut value = serde_json::to_value(envelope()).expect("envelope serializes");
        value["observation"]["innovation"] = serde_json::Value::Null;
        value["observation"]["innovation_cov"] = serde_json::Value::Null;
        value["observation"]["consistency_projection"] = serde_json::Value::Null;

        let decoded: SidecarEnvelope =
            serde_json::from_value(value).expect("optional nulls map to absent fields");

        assert!(decoded.observation.innovation.is_none());
        assert!(decoded.observation.innovation_cov.is_none());
        assert!(decoded.observation.consistency_projection.is_none());
        assert_eq!(decoded.validate(), Ok(SidecarContractStatus::Match));
    }

    #[test]
    fn sidecar_envelope_rejects_invalid_nested_semantics() {
        let mut candidate = envelope();
        candidate.observation.consistency_projection = Some(ConsistencyProjection {
            values: [1.0, 0.0, 0.0],
            dimensions: 1,
            frame_id: 0,
            context_id: 2,
            prior_id: 3,
        });

        assert!(matches!(
            candidate.validate(),
            Err(SidecarEnvelopeError::InvalidObservation(_))
        ));
    }

    #[test]
    fn sidecar_envelope_enforces_json_safe_integer_boundaries() {
        let mut candidate = envelope();
        candidate.observation.track_id = JSON_SAFE_INTEGER_MAX;
        candidate.observation.timestamp_ms = JSON_SAFE_INTEGER_MAX;
        candidate.observation.seq = JSON_SAFE_INTEGER_MAX;
        candidate.observation.consistency_projection = Some(ConsistencyProjection {
            values: [1.0, 0.0, 0.0],
            dimensions: 1,
            frame_id: JSON_SAFE_INTEGER_MAX,
            context_id: JSON_SAFE_INTEGER_MAX,
            prior_id: JSON_SAFE_INTEGER_MAX,
        });
        assert_eq!(candidate.validate(), Ok(SidecarContractStatus::Match));

        candidate.observation.track_id = JSON_SAFE_INTEGER_MAX + 1;
        assert!(matches!(
            candidate.validate(),
            Err(SidecarEnvelopeError::InvalidObservation(_))
        ));
    }

    #[test]
    fn sidecar_envelope_encoding_honors_inclusive_byte_limit() {
        assert_eq!(MAX_SIDECAR_ENVELOPE_BYTES, 65_536);
        let candidate = envelope();
        let encoded = candidate.encode().expect("default cap accepts envelope");

        assert_eq!(
            candidate.encode_with_limit(encoded.len()),
            Ok(encoded.clone())
        );
        assert_eq!(
            candidate.encode_with_limit(encoded.len() - 1),
            Err(SidecarEnvelopeError::EncodedEnvelopeTooLarge {
                actual: encoded.len(),
                maximum: encoded.len() - 1,
            })
        );
        assert_eq!(candidate.encode_with_limit(usize::MAX), Ok(encoded));
    }

    #[test]
    fn sidecar_keys_match_the_ncp_named_sensor_scheme() {
        assert_eq!(
            sidecar_key("ncp", "uav3").as_deref(),
            Some("ncp/session/uav3/sensor/galadriel-pid")
        );
        assert_eq!(
            sidecar_key("engram/ncp", "uav3").as_deref(),
            Some("engram/ncp/session/uav3/sensor/galadriel-pid")
        );
        assert_eq!(
            default_sidecar_key("uav3").as_deref(),
            Some("ncp/session/uav3/sensor/galadriel-pid")
        );

        for (realm, session_id) in [
            ("", "uav3"),
            ("ncp/**", "uav3"),
            ("ncp//fleet", "uav3"),
            ("/ncp", "uav3"),
            ("ncp", "bad id"),
            ("ncp", "bad/id"),
        ] {
            assert!(sidecar_key(realm, session_id).is_none());
        }
    }

    #[test]
    fn sidecar_envelope_rejects_duplicate_identity_keys() {
        let json = String::from_utf8(envelope().encode().expect("valid envelope encodes"))
            .expect("JSON is UTF-8");
        let duplicated = json.replacen(
            r#""session_id":"uav3""#,
            r#""session_id":"mallory","session_id":"uav3""#,
            1,
        );

        assert!(serde_json::from_str::<SidecarEnvelope>(&duplicated).is_err());
    }

    #[cfg(feature = "ncp")]
    #[test]
    fn frozen_constants_match_the_pinned_ncp_sdk() {
        assert_eq!(SIDECAR_NCP_VERSION, ncp_core::NCP_VERSION);
        assert_eq!(SIDECAR_CONTRACT_HASH, ncp_core::CONTRACT_HASH);
        assert_eq!(SIDECAR_DEFAULT_REALM, ncp_core::DEFAULT_REALM);
        assert_eq!(
            JSON_SAFE_INTEGER_MAX,
            ncp_core::JSON_SAFE_INTEGER_MAX as u64
        );
        assert_eq!(
            sidecar_key("engram/ncp", "uav3"),
            ncp_core::Keys::try_new("engram/ncp")
                .expect("valid realm")
                .try_sensor_named("uav3", SIDECAR_SENSOR_NAME)
                .ok()
        );
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
