//! Frozen producer-side mirror of Galadriel's lifecycle-monitor wire contract.
//!
//! This module intentionally mirrors `galadriel-ncp` rather than depending on
//! it. CREBAIN owns event production; Galadriel owns the schema and consumes
//! the resulting NCP named-perception stream. Field order, serde attributes,
//! validation bounds, and route construction must move only in lockstep with
//! Galadriel's `monitor` module.

use std::fmt;

use ncp_core::{
    contract_status, valid_id_segment, ContractStatus, Keys, CONTRACT_HASH, DEFAULT_REALM,
    JSON_SAFE_INTEGER_MAX, NCP_VERSION,
};
use serde::{Deserialize, Serialize};

use crate::pid_observation::ConsistencyProjection;
use crate::sensor_fusion::SensorModality;

const MAX_ID_SEGMENT_BYTES: usize = 64;

/// Stable named-perception entity carrying producer-monitor envelopes.
pub const MONITOR_SENSOR_NAME: &str = "galadriel-monitor";

/// Producer-monitor payload discriminator.
pub const MONITOR_KIND: &str = "galadriel_producer_event";

/// Current Galadriel producer-monitor schema version.
pub const MONITOR_SCHEMA_VERSION: &str = "1.0";

/// Largest declared heartbeat interval or deadline, in milliseconds.
pub const MAX_HEARTBEAT_DURATION_MS: u64 = 300_000;

/// Largest bounded publisher queue represented on the wire.
pub const MAX_MONITOR_QUEUE_EVENTS: u32 = 8_192;

/// Largest active-track count represented by one producer event.
pub const MAX_ACTIVE_TRACKS: u32 = 1_024;

/// Largest per-frame input, outcome, or candidate count represented on the wire.
pub const MAX_FRAME_ITEMS: u32 = 8_192;

/// Largest encoded monitor envelope accepted after transport framing.
pub const MAX_MONITOR_EVENT_BYTES: usize = 64 * 1_024;

/// SHA-256 registry digest length in lowercase hexadecimal characters.
pub const REGISTRY_DIGEST_HEX_LEN: usize = 64;

/// A validated producer-monitor envelope.
///
/// `event_seq` is global across all event variants within one producer session,
/// starts at one, and must be assigned monotonically by the producer. A producer
/// that resets the counter must mint a fresh `session_id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MonitorEnvelope {
    /// Stable discriminator, [`MONITOR_KIND`].
    pub kind: String,
    /// Galadriel-owned monitor schema, [`MONITOR_SCHEMA_VERSION`].
    pub schema_version: String,
    /// NCP wire version governing the named-perception route.
    pub ncp_version: String,
    /// Advisory identity of the NCP contract revision used by the producer.
    pub contract_hash: String,
    /// NCP session and producer epoch.
    pub session_id: String,
    /// Concrete producer identifier.
    pub producer_id: String,
    /// Globally monotonic event sequence within this producer session.
    pub event_seq: u64,
    /// Typed producer event.
    pub event: ProducerEvent,
}

/// One producer-monitor event, adjacent-tagged as `{ "type", "data" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ProducerEvent {
    /// Periodic producer and publisher health declaration.
    Heartbeat(Heartbeat),
    /// Disposition of a measurement or association attempt.
    ModalityOutcome(ModalityOutcome),
    /// Explicit absence of a modality result for an active track.
    ModalityMiss(ModalityMiss),
    /// Bounded whole-frame accounting record.
    FrameSummary(FrameSummary),
}

/// Periodic producer liveness and bounded publisher health.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    /// Producer wall-clock timestamp in milliseconds.
    pub producer_timestamp_ms: u64,
    /// Monotonic producer uptime in milliseconds for restart diagnosis.
    pub uptime_ms: u64,
    /// Declared heartbeat emission interval in milliseconds.
    pub declared_interval_ms: u64,
    /// Declared receiver deadline in milliseconds.
    pub declared_deadline_ms: u64,
    /// Most recent fusion sequence observed by the publisher, when any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fusion_seq: Option<u64>,
    /// Number of currently active tracks.
    pub active_track_count: u32,
    /// Whether any loss or publication fault has degraded this epoch.
    pub degraded: bool,
    /// Current publisher queue state and cumulative counters.
    pub queue_health: QueueHealth,
}

/// Bounded publisher queue state and cumulative health counters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueHealth {
    /// Configured event capacity of the publisher queue.
    pub capacity: u32,
    /// Events currently waiting in the publisher queue.
    pub depth: u32,
    /// Cumulative events dropped during this producer session.
    pub dropped_event_count: u64,
    /// Cumulative events successfully published during this producer session.
    pub published_event_count: u64,
}

/// Disposition of a modality measurement or association attempt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalityOutcome {
    /// Fusion frame sequence assigned by the producer.
    pub fusion_seq: u64,
    /// Fusion frame timestamp in milliseconds.
    pub fusion_timestamp_ms: u64,
    /// Registered common physical frame for this fusion frame.
    pub frame_id: u64,
    /// Registered projection/calibration context for this fusion frame.
    pub context_id: u64,
    /// Globally unique frozen-prior identifier for this fusion frame.
    pub prior_id: u64,
    /// Numeric track identifier.
    pub track_id: u64,
    /// Sensor modality being accounted for.
    pub modality: SensorModality,
    /// Deterministic opportunity index for this track/modality/frame.
    pub attempt_index: u32,
    /// Zero-based index into the producer's bounded frame input, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measurement_index: Option<u32>,
    /// Typed disposition.
    pub outcome: ModalityOutcomeKind,
    /// Whether exactly one matching frozen-v1 observation must be published.
    pub v1_expected: bool,
    /// Aggregate candidate measurements considered for this track and modality.
    /// This pair-level count is repeated on every attempt outcome.
    pub candidate_count: u32,
    /// Aggregate candidates for this track and modality that passed the producer's
    /// gate. This may be nonzero on one `gate_rejected` attempt when a different
    /// candidate in the same pair passed.
    pub in_gate_count: u32,
    /// Gate score for the selected or nearest candidate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_evidence: Option<GateEvidence>,
    /// Common frozen-prior residual projection, when the producer can attest it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consistency_projection: Option<ConsistencyProjection>,
}

/// Measurement or association disposition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModalityOutcomeKind {
    /// The associated measurement updated the track.
    Updated,
    /// Candidate measurements existed, but none passed the gate.
    GateRejected,
    /// At least one candidate passed the gate, but assignment selected none.
    AssignmentRejected,
    /// Assignment succeeded, but the filter rejected the update.
    UpdateRejected,
    /// An unassigned measurement created this track.
    TrackBirth,
    /// The track/filter combination cannot safely gate or consume this modality.
    UnsupportedFilter,
    /// The baseline path updated, but no registered common-frame projection exists.
    IncomparableProjection,
}

/// Numeric evidence used by a producer's measurement gate.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateEvidence {
    /// Gate computation used by the producer.
    pub method: GateMethod,
    /// Squared distance or normalized-Euclidean fallback score.
    pub d2: f64,
    /// Acceptance threshold in the same score space as `d2`.
    pub threshold: f64,
}

/// Producer gate computation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GateMethod {
    /// Covariance-aware squared Mahalanobis distance.
    Mahalanobis,
    /// Normalized-Euclidean fallback when covariance gating is unavailable.
    NormalizedEuclideanFallback,
}

/// Explicit absence of a modality result for an active track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalityMiss {
    /// Fusion frame sequence assigned by the producer.
    pub fusion_seq: u64,
    /// Fusion frame timestamp in milliseconds.
    pub fusion_timestamp_ms: u64,
    /// Registered common physical frame for this fusion frame.
    pub frame_id: u64,
    /// Registered projection/calibration context for this fusion frame.
    pub context_id: u64,
    /// Globally unique frozen-prior identifier for this fusion frame.
    pub prior_id: u64,
    /// Numeric track identifier.
    pub track_id: u64,
    /// Missing sensor modality.
    pub modality: SensorModality,
    /// Typed explanation for the missing result.
    pub reason: ModalityMissReason,
}

/// Reason that an expected track/modality pair produced no outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModalityMissReason {
    /// The frame contained no measurement for this modality.
    NoMeasurement,
    /// Measurements existed, but none were candidates for this track.
    NoCandidate,
    /// Candidates existed, but none passed the gate.
    NoInGateCandidate,
    /// In-gate candidates existed, but assignment selected another track.
    NotAssigned,
    /// The track was not eligible for this modality in the current frame.
    TrackNotEligible,
}

/// Bounded accounting summary for one fusion frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameSummary {
    /// Fusion frame sequence assigned by the producer.
    pub fusion_seq: u64,
    /// Fusion frame timestamp in milliseconds.
    pub fusion_timestamp_ms: u64,
    /// Registered common physical frame for this fusion frame.
    pub frame_id: u64,
    /// Registered projection/calibration context for this fusion frame.
    pub context_id: u64,
    /// Globally unique frozen-prior identifier for this fusion frame.
    pub prior_id: u64,
    /// Lowercase SHA-256 digest of the pinned frame/context registry.
    pub registry_digest: String,
    /// Unique modalities configured as expected for this frame.
    pub expected_modalities: Vec<SensorModality>,
    /// Number of active tracks after processing this frame.
    pub active_track_count: u32,
    /// Number of input measurements accepted into bounded frame processing.
    pub input_count: u32,
    /// Number of outcome and miss events represented for this frame.
    pub outcome_count: u32,
    /// Number of outcome events requiring a matching frozen-v1 observation.
    pub v1_expected_count: u32,
    /// Whether any producer loss or accounting fault degraded this frame.
    pub degraded: bool,
    /// Whether producer-side bounds prevented complete frame accounting.
    pub truncated: bool,
}

/// Semantic failure in a producer-monitor envelope.
#[derive(Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum MonitorError {
    /// The payload discriminator does not identify the monitor sidecar.
    InvalidKind { received: String },
    /// The Galadriel-owned monitor schema is not supported.
    UnsupportedSchemaVersion { received: String },
    /// The NCP wire version is malformed or incompatible.
    IncompatibleNcpVersion(String),
    /// The advertised contract hash is not canonical lowercase 64-bit hex.
    InvalidContractHash(String),
    /// The declared session is unsafe as an NCP key segment.
    InvalidSessionId(String),
    /// The declared producer is unsafe as an NCP key segment.
    InvalidProducerId(String),
    /// A numeric value cannot round-trip through every NCP JSON peer.
    IntegerOutOfRange {
        /// Invalid field.
        field: &'static str,
        /// Invalid value.
        value: u64,
    },
    /// A registry/provenance identifier that must be positive was zero.
    ZeroIdentifier {
        /// Invalid field.
        field: &'static str,
    },
    /// The registry digest is not canonical lowercase SHA-256 hexadecimal.
    InvalidRegistryDigest(String),
    /// The encoded event exceeds the application contract bound.
    EncodedEventTooLarge {
        /// Encoded byte length.
        actual: usize,
        /// Contract ceiling.
        maximum: usize,
    },
    /// JSON encoding failed.
    Json(String),
    /// An event sequence must start at one.
    ZeroEventSequence,
    /// A heartbeat interval or deadline is zero or exceeds its fixed ceiling.
    HeartbeatDurationOutOfRange {
        /// Invalid duration field.
        field: &'static str,
        /// Invalid duration.
        value: u64,
    },
    /// A heartbeat deadline is shorter than its declared interval.
    HeartbeatDeadlineBeforeInterval {
        /// Declared interval.
        interval_ms: u64,
        /// Declared deadline.
        deadline_ms: u64,
    },
    /// A bounded count exceeds its contract ceiling.
    CountOutOfRange {
        /// Invalid count field.
        field: &'static str,
        /// Invalid count.
        value: u64,
        /// Contract ceiling.
        maximum: u64,
    },
    /// Queue depth exceeds the declared queue capacity.
    QueueDepthExceedsCapacity {
        /// Declared capacity.
        capacity: u32,
        /// Observed depth.
        depth: u32,
    },
    /// Gate evidence is non-finite or negative.
    InvalidGateValue {
        /// Invalid gate field.
        field: &'static str,
    },
    /// Event fields disagree with the typed outcome.
    EventCoherence(&'static str),
    /// A common-prior residual projection is invalid.
    InvalidConsistencyProjection(String),
    /// A frame summary declares no expected modalities.
    EmptyExpectedModalities,
    /// A frame summary repeats an expected modality.
    DuplicateExpectedModality {
        /// Repeated modality.
        modality: SensorModality,
    },
}

impl fmt::Display for MonitorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidKind { received } => write!(
                formatter,
                "invalid monitor kind: got {received:?}, want {MONITOR_KIND:?}"
            ),
            Self::UnsupportedSchemaVersion { received } => write!(
                formatter,
                "unsupported monitor schema version: got {received:?}, want {MONITOR_SCHEMA_VERSION:?}"
            ),
            Self::IncompatibleNcpVersion(error) => {
                write!(formatter, "incompatible NCP version in monitor envelope: {error}")
            }
            Self::InvalidContractHash(hash) => {
                write!(formatter, "invalid NCP contract hash in monitor envelope: {hash:?}")
            }
            Self::InvalidSessionId(identity) => {
                write!(formatter, "invalid monitor session_id: {identity:?}")
            }
            Self::InvalidProducerId(identity) => {
                write!(formatter, "invalid monitor producer_id: {identity:?}")
            }
            Self::IntegerOutOfRange { field, value } => write!(
                formatter,
                "monitor {field} exceeds the NCP exact JSON integer range: {value}"
            ),
            Self::ZeroIdentifier { field } => {
                write!(formatter, "monitor {field} must be greater than zero")
            }
            Self::InvalidRegistryDigest(digest) => {
                write!(formatter, "invalid monitor registry digest: {digest:?}")
            }
            Self::EncodedEventTooLarge { actual, maximum } => write!(
                formatter,
                "monitor event has {actual} bytes, maximum {maximum}"
            ),
            Self::Json(error) => write!(formatter, "invalid monitor JSON: {error}"),
            Self::ZeroEventSequence => write!(formatter, "monitor event_seq must be at least 1"),
            Self::HeartbeatDurationOutOfRange { field, value } => write!(
                formatter,
                "monitor {field} must be in 1..={MAX_HEARTBEAT_DURATION_MS} ms, got {value}"
            ),
            Self::HeartbeatDeadlineBeforeInterval {
                interval_ms,
                deadline_ms,
            } => write!(
                formatter,
                "monitor heartbeat deadline {deadline_ms} ms is shorter than interval {interval_ms} ms"
            ),
            Self::CountOutOfRange {
                field,
                value,
                maximum,
            } => write!(
                formatter,
                "monitor {field} exceeds maximum {maximum}: {value}"
            ),
            Self::QueueDepthExceedsCapacity { capacity, depth } => write!(
                formatter,
                "monitor queue depth {depth} exceeds capacity {capacity}"
            ),
            Self::InvalidGateValue { field } => write!(
                formatter,
                "monitor gate field {field} must be finite and nonnegative"
            ),
            Self::EventCoherence(message) => {
                write!(formatter, "incoherent monitor event: {message}")
            }
            Self::InvalidConsistencyProjection(error) => {
                write!(formatter, "invalid monitor consistency projection: {error}")
            }
            Self::EmptyExpectedModalities => {
                write!(formatter, "monitor frame summary must declare at least one expected modality")
            }
            Self::DuplicateExpectedModality { modality } => write!(
                formatter,
                "monitor frame summary repeats expected modality {modality:?}"
            ),
        }
    }
}

impl std::error::Error for MonitorError {}

impl MonitorEnvelope {
    /// Construct and validate an envelope stamped with local NCP identities.
    pub fn try_new(
        session_id: impl Into<String>,
        producer_id: impl Into<String>,
        event_seq: u64,
        event: ProducerEvent,
    ) -> Result<Self, MonitorError> {
        let envelope = Self {
            kind: MONITOR_KIND.to_string(),
            schema_version: MONITOR_SCHEMA_VERSION.to_string(),
            ncp_version: NCP_VERSION.to_string(),
            contract_hash: CONTRACT_HASH.to_string(),
            session_id: session_id.into(),
            producer_id: producer_id.into(),
            event_seq,
            event,
        };
        envelope.validate()?;
        Ok(envelope)
    }

    /// Validate identity, NCP compatibility, JSON-safe integers, and event semantics.
    ///
    /// A well-formed but different `contract_hash` remains advisory, matching
    /// Galadriel's monitor and the NCP handshake policy.
    pub fn validate(&self) -> Result<ContractStatus, MonitorError> {
        if self.kind != MONITOR_KIND {
            return Err(MonitorError::InvalidKind {
                received: self.kind.clone(),
            });
        }
        if self.schema_version != MONITOR_SCHEMA_VERSION {
            return Err(MonitorError::UnsupportedSchemaVersion {
                received: self.schema_version.clone(),
            });
        }
        if self.ncp_version != NCP_VERSION {
            return Err(MonitorError::IncompatibleNcpVersion(format!(
                "noncanonical ncp_version {:?}; expected {NCP_VERSION:?}",
                self.ncp_version
            )));
        }
        ncp_core::check_version(&self.ncp_version, true)
            .map_err(|error| MonitorError::IncompatibleNcpVersion(error.to_string()))?;
        validate_contract_hash(&self.contract_hash)?;
        validate_identity(&self.session_id, true)?;
        validate_identity(&self.producer_id, false)?;
        if self.event_seq == 0 {
            return Err(MonitorError::ZeroEventSequence);
        }
        validate_json_integer("event_seq", self.event_seq)?;
        self.event.validate()?;
        Ok(contract_status(Some(&self.contract_hash)))
    }

    /// Serialize a semantically valid envelope under the fixed encoded-size cap.
    pub fn encode(&self) -> Result<Vec<u8>, MonitorError> {
        self.validate()?;
        let encoded =
            serde_json::to_vec(self).map_err(|error| MonitorError::Json(error.to_string()))?;
        validate_encoded_size(encoded.len())?;
        Ok(encoded)
    }
}

impl ProducerEvent {
    /// Validate all semantic invariants of this event payload.
    pub fn validate(&self) -> Result<(), MonitorError> {
        match self {
            Self::Heartbeat(heartbeat) => heartbeat.validate(),
            Self::ModalityOutcome(outcome) => outcome.validate(),
            Self::ModalityMiss(miss) => miss.validate(),
            Self::FrameSummary(summary) => summary.validate(),
        }
    }
}

impl Heartbeat {
    /// Validate liveness durations, counters, and bounded queue state.
    pub fn validate(&self) -> Result<(), MonitorError> {
        validate_json_integer("event.producer_timestamp_ms", self.producer_timestamp_ms)?;
        validate_json_integer("event.uptime_ms", self.uptime_ms)?;
        validate_heartbeat_duration("event.declared_interval_ms", self.declared_interval_ms)?;
        validate_heartbeat_duration("event.declared_deadline_ms", self.declared_deadline_ms)?;
        if self.declared_deadline_ms < self.declared_interval_ms {
            return Err(MonitorError::HeartbeatDeadlineBeforeInterval {
                interval_ms: self.declared_interval_ms,
                deadline_ms: self.declared_deadline_ms,
            });
        }
        if let Some(last_fusion_seq) = self.last_fusion_seq {
            validate_json_integer("event.last_fusion_seq", last_fusion_seq)?;
        }
        validate_count(
            "event.active_track_count",
            self.active_track_count,
            MAX_ACTIVE_TRACKS,
        )?;
        self.queue_health.validate()?;
        if self.queue_health.dropped_event_count > 0 && !self.degraded {
            return Err(MonitorError::EventCoherence(
                "heartbeat with dropped events must be degraded",
            ));
        }
        Ok(())
    }
}

impl QueueHealth {
    /// Validate bounded queue occupancy and cumulative counters.
    pub fn validate(&self) -> Result<(), MonitorError> {
        if self.capacity == 0 || self.capacity > MAX_MONITOR_QUEUE_EVENTS {
            return Err(MonitorError::CountOutOfRange {
                field: "event.queue_health.capacity",
                value: u64::from(self.capacity),
                maximum: u64::from(MAX_MONITOR_QUEUE_EVENTS),
            });
        }
        if self.depth > self.capacity {
            return Err(MonitorError::QueueDepthExceedsCapacity {
                capacity: self.capacity,
                depth: self.depth,
            });
        }
        validate_json_integer(
            "event.queue_health.dropped_event_count",
            self.dropped_event_count,
        )?;
        validate_json_integer(
            "event.queue_health.published_event_count",
            self.published_event_count,
        )
    }
}

impl ModalityOutcome {
    /// Validate frame identities, bounded counts, gate evidence, and outcome coherence.
    pub fn validate(&self) -> Result<(), MonitorError> {
        validate_frame_identity(
            self.fusion_seq,
            self.fusion_timestamp_ms,
            self.frame_id,
            self.context_id,
            self.prior_id,
            Some(self.track_id),
        )?;
        if self.attempt_index >= MAX_FRAME_ITEMS {
            return Err(MonitorError::CountOutOfRange {
                field: "event.attempt_index",
                value: u64::from(self.attempt_index),
                maximum: u64::from(MAX_FRAME_ITEMS - 1),
            });
        }
        if let Some(measurement_index) = self.measurement_index {
            if measurement_index >= MAX_FRAME_ITEMS {
                return Err(MonitorError::CountOutOfRange {
                    field: "event.measurement_index",
                    value: u64::from(measurement_index),
                    maximum: u64::from(MAX_FRAME_ITEMS - 1),
                });
            }
        }
        validate_count(
            "event.candidate_count",
            self.candidate_count,
            MAX_FRAME_ITEMS,
        )?;
        validate_count("event.in_gate_count", self.in_gate_count, MAX_FRAME_ITEMS)?;
        if self.in_gate_count > self.candidate_count {
            return Err(MonitorError::EventCoherence(
                "in_gate_count cannot exceed candidate_count",
            ));
        }
        if let Some(evidence) = self.gate_evidence {
            evidence.validate()?;
        }
        if let Some(projection) = self.consistency_projection {
            validate_projection(&projection)?;
            if projection.frame_id != self.frame_id
                || projection.context_id != self.context_id
                || projection.prior_id != self.prior_id
            {
                return Err(MonitorError::EventCoherence(
                    "consistency projection provenance must match the outcome frame",
                ));
            }
        }
        if self.v1_expected
            && !matches!(
                self.outcome,
                ModalityOutcomeKind::Updated | ModalityOutcomeKind::IncomparableProjection
            )
        {
            return Err(MonitorError::EventCoherence(
                "only an updated or incomparable-projection outcome may require v1",
            ));
        }

        match self.outcome {
            ModalityOutcomeKind::Updated | ModalityOutcomeKind::UpdateRejected => {
                require_measurement_index(self.measurement_index, self.outcome)?;
                require_candidates(self.candidate_count, self.in_gate_count, self.outcome)?;
                require_accepted_gate(self.gate_evidence)?;
                if matches!(self.outcome, ModalityOutcomeKind::Updated)
                    && self.consistency_projection.is_none()
                {
                    return Err(MonitorError::EventCoherence(
                        "updated requires a consistency projection",
                    ));
                }
            }
            ModalityOutcomeKind::GateRejected => {
                if self.candidate_count == 0 {
                    return Err(MonitorError::EventCoherence(
                        "gate_rejected requires at least one pair-level candidate",
                    ));
                }
                let evidence = self.gate_evidence.ok_or(MonitorError::EventCoherence(
                    "gate_rejected requires gate_evidence",
                ))?;
                if evidence.d2 < evidence.threshold {
                    return Err(MonitorError::EventCoherence(
                        "gate_rejected evidence must meet or exceed its threshold",
                    ));
                }
            }
            ModalityOutcomeKind::AssignmentRejected => {
                if self.in_gate_count == 0 {
                    return Err(MonitorError::EventCoherence(
                        "assignment_rejected requires at least one in-gate candidate",
                    ));
                }
                require_accepted_gate(self.gate_evidence)?;
            }
            ModalityOutcomeKind::TrackBirth => {
                require_measurement_index(self.measurement_index, self.outcome)?;
                if self.candidate_count != 0
                    || self.in_gate_count != 0
                    || self.gate_evidence.is_some()
                    || self.consistency_projection.is_some()
                {
                    return Err(MonitorError::EventCoherence(
                        "track_birth requires zero gate counts and no gate or prior evidence",
                    ));
                }
            }
            ModalityOutcomeKind::UnsupportedFilter => {
                require_measurement_index(self.measurement_index, self.outcome)?;
                if self.gate_evidence.is_some() {
                    return Err(MonitorError::EventCoherence(
                        "unsupported_filter cannot claim gate evidence",
                    ));
                }
            }
            ModalityOutcomeKind::IncomparableProjection => {
                require_measurement_index(self.measurement_index, self.outcome)?;
                require_candidates(self.candidate_count, self.in_gate_count, self.outcome)?;
                require_accepted_gate(self.gate_evidence)?;
                if self.consistency_projection.is_some() {
                    return Err(MonitorError::EventCoherence(
                        "incomparable_projection cannot carry a consistency projection",
                    ));
                }
            }
        }
        Ok(())
    }
}

impl GateEvidence {
    /// Validate finite, nonnegative gate values.
    pub fn validate(self) -> Result<(), MonitorError> {
        validate_gate_value("event.gate_evidence.d2", self.d2)?;
        validate_gate_value("event.gate_evidence.threshold", self.threshold)
    }
}

impl ModalityMiss {
    /// Validate frame identities carried by a miss event.
    pub fn validate(&self) -> Result<(), MonitorError> {
        validate_frame_identity(
            self.fusion_seq,
            self.fusion_timestamp_ms,
            self.frame_id,
            self.context_id,
            self.prior_id,
            Some(self.track_id),
        )
    }
}

impl FrameSummary {
    /// Validate frame identities, bounded accounting, and modality uniqueness.
    pub fn validate(&self) -> Result<(), MonitorError> {
        validate_frame_identity(
            self.fusion_seq,
            self.fusion_timestamp_ms,
            self.frame_id,
            self.context_id,
            self.prior_id,
            None,
        )?;
        validate_registry_digest(&self.registry_digest)?;
        validate_count(
            "event.active_track_count",
            self.active_track_count,
            MAX_ACTIVE_TRACKS,
        )?;
        validate_count("event.input_count", self.input_count, MAX_FRAME_ITEMS)?;
        validate_count("event.outcome_count", self.outcome_count, MAX_FRAME_ITEMS)?;
        validate_count(
            "event.v1_expected_count",
            self.v1_expected_count,
            MAX_FRAME_ITEMS,
        )?;
        if self.v1_expected_count > self.outcome_count {
            return Err(MonitorError::EventCoherence(
                "v1_expected_count cannot exceed outcome_count",
            ));
        }
        if self.truncated && !self.degraded {
            return Err(MonitorError::EventCoherence(
                "a truncated frame summary must be degraded",
            ));
        }
        if self.expected_modalities.is_empty() {
            return Err(MonitorError::EmptyExpectedModalities);
        }
        let mut seen = [false; 6];
        for modality in &self.expected_modalities {
            let index = modality_index(*modality);
            if seen[index] {
                return Err(MonitorError::DuplicateExpectedModality {
                    modality: *modality,
                });
            }
            seen[index] = true;
        }
        Ok(())
    }
}

/// The named perception-plane monitor route:
/// `{realm}/session/{id}/sensor/galadriel-monitor`.
pub fn monitor_key(realm: &str, session_id: &str) -> Option<String> {
    if !valid_id_segment(session_id) || session_id.len() > MAX_ID_SEGMENT_BYTES {
        return None;
    }
    Keys::try_new(realm)
        .ok()?
        .try_sensor_named(session_id, MONITOR_SENSOR_NAME)
        .ok()
}

/// [`monitor_key`] on the default NCP realm.
pub fn default_monitor_key(session_id: &str) -> Option<String> {
    monitor_key(DEFAULT_REALM, session_id)
}

fn validate_contract_hash(contract_hash: &str) -> Result<(), MonitorError> {
    if contract_hash.len() != CONTRACT_HASH.len()
        || !contract_hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(MonitorError::InvalidContractHash(contract_hash.to_string()));
    }
    Ok(())
}

fn validate_identity(identity: &str, session: bool) -> Result<(), MonitorError> {
    if valid_id_segment(identity) && identity.len() <= MAX_ID_SEGMENT_BYTES {
        return Ok(());
    }
    if session {
        Err(MonitorError::InvalidSessionId(identity.to_string()))
    } else {
        Err(MonitorError::InvalidProducerId(identity.to_string()))
    }
}

fn validate_json_integer(field: &'static str, value: u64) -> Result<(), MonitorError> {
    if value > JSON_SAFE_INTEGER_MAX as u64 {
        return Err(MonitorError::IntegerOutOfRange { field, value });
    }
    Ok(())
}

fn validate_positive_json_integer(field: &'static str, value: u64) -> Result<(), MonitorError> {
    if value == 0 {
        return Err(MonitorError::ZeroIdentifier { field });
    }
    validate_json_integer(field, value)
}

fn validate_encoded_size(actual: usize) -> Result<(), MonitorError> {
    if actual > MAX_MONITOR_EVENT_BYTES {
        return Err(MonitorError::EncodedEventTooLarge {
            actual,
            maximum: MAX_MONITOR_EVENT_BYTES,
        });
    }
    Ok(())
}

fn validate_registry_digest(digest: &str) -> Result<(), MonitorError> {
    if digest.len() != REGISTRY_DIGEST_HEX_LEN
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(MonitorError::InvalidRegistryDigest(digest.to_string()));
    }
    Ok(())
}

fn validate_heartbeat_duration(field: &'static str, value: u64) -> Result<(), MonitorError> {
    if value == 0 || value > MAX_HEARTBEAT_DURATION_MS {
        return Err(MonitorError::HeartbeatDurationOutOfRange { field, value });
    }
    Ok(())
}

fn validate_count(field: &'static str, value: u32, maximum: u32) -> Result<(), MonitorError> {
    if value > maximum {
        return Err(MonitorError::CountOutOfRange {
            field,
            value: u64::from(value),
            maximum: u64::from(maximum),
        });
    }
    Ok(())
}

fn validate_frame_identity(
    fusion_seq: u64,
    fusion_timestamp_ms: u64,
    frame_id: u64,
    context_id: u64,
    prior_id: u64,
    track_id: Option<u64>,
) -> Result<(), MonitorError> {
    validate_json_integer("event.fusion_seq", fusion_seq)?;
    validate_json_integer("event.fusion_timestamp_ms", fusion_timestamp_ms)?;
    validate_positive_json_integer("event.frame_id", frame_id)?;
    validate_positive_json_integer("event.context_id", context_id)?;
    validate_positive_json_integer("event.prior_id", prior_id)?;
    if let Some(track_id) = track_id {
        validate_positive_json_integer("event.track_id", track_id)?;
    }
    Ok(())
}

fn validate_projection(projection: &ConsistencyProjection) -> Result<(), MonitorError> {
    projection
        .validate()
        .map_err(MonitorError::InvalidConsistencyProjection)?;
    validate_json_integer("event.consistency_projection.frame_id", projection.frame_id)?;
    validate_json_integer(
        "event.consistency_projection.context_id",
        projection.context_id,
    )?;
    validate_json_integer("event.consistency_projection.prior_id", projection.prior_id)
}

fn validate_gate_value(field: &'static str, value: f64) -> Result<(), MonitorError> {
    if !value.is_finite() || value < 0.0 {
        return Err(MonitorError::InvalidGateValue { field });
    }
    Ok(())
}

fn require_measurement_index(
    measurement_index: Option<u32>,
    outcome: ModalityOutcomeKind,
) -> Result<(), MonitorError> {
    if measurement_index.is_none() {
        return Err(MonitorError::EventCoherence(match outcome {
            ModalityOutcomeKind::Updated => "updated requires measurement_index",
            ModalityOutcomeKind::UpdateRejected => "update_rejected requires measurement_index",
            ModalityOutcomeKind::TrackBirth => "track_birth requires measurement_index",
            ModalityOutcomeKind::UnsupportedFilter => {
                "unsupported_filter requires measurement_index"
            }
            ModalityOutcomeKind::IncomparableProjection => {
                "incomparable_projection requires measurement_index"
            }
            ModalityOutcomeKind::GateRejected | ModalityOutcomeKind::AssignmentRejected => {
                "outcome requires measurement_index"
            }
        }));
    }
    Ok(())
}

fn require_candidates(
    candidate_count: u32,
    in_gate_count: u32,
    outcome: ModalityOutcomeKind,
) -> Result<(), MonitorError> {
    if candidate_count == 0 || in_gate_count == 0 {
        return Err(MonitorError::EventCoherence(match outcome {
            ModalityOutcomeKind::Updated => {
                "updated requires at least one candidate and in-gate candidate"
            }
            ModalityOutcomeKind::UpdateRejected => {
                "update_rejected requires at least one candidate and in-gate candidate"
            }
            ModalityOutcomeKind::GateRejected
            | ModalityOutcomeKind::AssignmentRejected
            | ModalityOutcomeKind::TrackBirth
            | ModalityOutcomeKind::UnsupportedFilter
            | ModalityOutcomeKind::IncomparableProjection => {
                "outcome requires at least one candidate and in-gate candidate"
            }
        }));
    }
    Ok(())
}

fn require_accepted_gate(gate_evidence: Option<GateEvidence>) -> Result<(), MonitorError> {
    let evidence = gate_evidence.ok_or(MonitorError::EventCoherence(
        "gate-dependent outcome requires gate_evidence",
    ))?;
    if evidence.d2 >= evidence.threshold {
        return Err(MonitorError::EventCoherence(
            "accepted gate evidence must be below its threshold",
        ));
    }
    Ok(())
}

fn modality_index(modality: SensorModality) -> usize {
    match modality {
        SensorModality::Visual => 0,
        SensorModality::Thermal => 1,
        SensorModality::Acoustic => 2,
        SensorModality::Radar => 3,
        SensorModality::Lidar => 4,
        SensorModality::RadioFrequency => 5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_health() -> QueueHealth {
        QueueHealth {
            capacity: 8,
            depth: 1,
            dropped_event_count: 1,
            published_event_count: 12,
        }
    }

    fn heartbeat() -> Heartbeat {
        Heartbeat {
            producer_timestamp_ms: 1_700_000_000_000,
            uptime_ms: 12_345,
            declared_interval_ms: 1_000,
            declared_deadline_ms: 3_000,
            last_fusion_seq: Some(41),
            active_track_count: 2,
            degraded: true,
            queue_health: queue_health(),
        }
    }

    fn gate_evidence() -> GateEvidence {
        GateEvidence {
            method: GateMethod::Mahalanobis,
            d2: 2.5,
            threshold: 7.815,
        }
    }

    fn projection() -> ConsistencyProjection {
        ConsistencyProjection {
            values: [1.0, -2.0, 0.0],
            dimensions: 2,
            frame_id: 17,
            context_id: 23,
            prior_id: 29,
        }
    }

    fn outcome(kind: ModalityOutcomeKind) -> ModalityOutcome {
        ModalityOutcome {
            fusion_seq: 41,
            fusion_timestamp_ms: 1_700_000_000_000,
            frame_id: 17,
            context_id: 23,
            prior_id: 29,
            track_id: 42,
            modality: SensorModality::Radar,
            attempt_index: 0,
            measurement_index: Some(3),
            outcome: kind,
            v1_expected: matches!(kind, ModalityOutcomeKind::Updated),
            candidate_count: 2,
            in_gate_count: 1,
            gate_evidence: Some(gate_evidence()),
            consistency_projection: Some(projection()),
        }
    }

    fn valid_outcome(kind: ModalityOutcomeKind) -> ModalityOutcome {
        let mut value = outcome(kind);
        value.v1_expected = matches!(
            kind,
            ModalityOutcomeKind::Updated | ModalityOutcomeKind::IncomparableProjection
        );
        match kind {
            ModalityOutcomeKind::Updated
            | ModalityOutcomeKind::AssignmentRejected
            | ModalityOutcomeKind::UpdateRejected => {}
            ModalityOutcomeKind::GateRejected => {
                // Pair-level counts may report a different in-gate candidate;
                // this attempt's own gate evidence still proves rejection.
                value.gate_evidence = Some(GateEvidence {
                    d2: 3.0,
                    threshold: 3.0,
                    ..gate_evidence()
                });
            }
            ModalityOutcomeKind::TrackBirth => {
                value.candidate_count = 0;
                value.in_gate_count = 0;
                value.gate_evidence = None;
                value.consistency_projection = None;
            }
            ModalityOutcomeKind::UnsupportedFilter => {
                value.gate_evidence = None;
            }
            ModalityOutcomeKind::IncomparableProjection => {
                value.consistency_projection = None;
            }
        }
        value
    }

    fn modality_miss(reason: ModalityMissReason) -> ModalityMiss {
        ModalityMiss {
            fusion_seq: 41,
            fusion_timestamp_ms: 1_700_000_000_000,
            frame_id: 17,
            context_id: 23,
            prior_id: 29,
            track_id: 42,
            modality: SensorModality::Visual,
            reason,
        }
    }

    fn frame_summary() -> FrameSummary {
        FrameSummary {
            fusion_seq: 41,
            fusion_timestamp_ms: 1_700_000_000_000,
            frame_id: 17,
            context_id: 23,
            prior_id: 29,
            registry_digest: "a".repeat(REGISTRY_DIGEST_HEX_LEN),
            expected_modalities: vec![SensorModality::Visual, SensorModality::Radar],
            active_track_count: 2,
            input_count: 3,
            outcome_count: 4,
            v1_expected_count: 1,
            degraded: false,
            truncated: false,
        }
    }

    #[test]
    fn updated_envelope_matches_galadriel_golden_bytes() {
        let envelope = MonitorEnvelope::try_new(
            "uav3",
            "crebain",
            8,
            ProducerEvent::ModalityOutcome(outcome(ModalityOutcomeKind::Updated)),
        )
        .unwrap();
        let expected = concat!(
            r#"{"kind":"galadriel_producer_event","schema_version":"1.0","#,
            r#""ncp_version":"0.8","contract_hash":"d1b50a2d8a265276","#,
            r#""session_id":"uav3","producer_id":"crebain","event_seq":8,"#,
            r#""event":{"type":"modality_outcome","data":{"fusion_seq":41,"#,
            r#""fusion_timestamp_ms":1700000000000,"frame_id":17,"context_id":23,"#,
            r#""prior_id":29,"track_id":42,"modality":"radar","attempt_index":0,"#,
            r#""measurement_index":3,"outcome":"updated","v1_expected":true,"candidate_count":2,"#,
            r#""in_gate_count":1,"gate_evidence":{"method":"mahalanobis","d2":2.5,"#,
            r#""threshold":7.815},"consistency_projection":{"values":[1.0,-2.0,0.0],"#,
            r#""dimensions":2,"frame_id":17,"context_id":23,"prior_id":29}}}}"#
        );

        assert_eq!(envelope.encode().unwrap(), expected.as_bytes());
    }

    #[test]
    fn remaining_event_variants_have_frozen_payload_bytes() {
        let cases = [
            (
                ProducerEvent::Heartbeat(heartbeat()),
                concat!(
                    r#"{"type":"heartbeat","data":{"producer_timestamp_ms":1700000000000,"#,
                    r#""uptime_ms":12345,"declared_interval_ms":1000,"declared_deadline_ms":3000,"#,
                    r#""last_fusion_seq":41,"active_track_count":2,"degraded":true,"#,
                    r#""queue_health":{"capacity":8,"depth":1,"dropped_event_count":1,"#,
                    r#""published_event_count":12}}}"#
                ),
            ),
            (
                ProducerEvent::ModalityMiss(modality_miss(ModalityMissReason::NoMeasurement)),
                concat!(
                    r#"{"type":"modality_miss","data":{"fusion_seq":41,"#,
                    r#""fusion_timestamp_ms":1700000000000,"frame_id":17,"context_id":23,"#,
                    r#""prior_id":29,"track_id":42,"modality":"visual","#,
                    r#""reason":"no_measurement"}}"#
                ),
            ),
            (
                ProducerEvent::FrameSummary(frame_summary()),
                concat!(
                    r#"{"type":"frame_summary","data":{"fusion_seq":41,"#,
                    r#""fusion_timestamp_ms":1700000000000,"frame_id":17,"context_id":23,"#,
                    r#""prior_id":29,"registry_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","#,
                    r#""expected_modalities":["visual","radar"],"active_track_count":2,"#,
                    r#""input_count":3,"outcome_count":4,"v1_expected_count":1,"#,
                    r#""degraded":false,"truncated":false}}"#
                ),
            ),
        ];

        for (event, expected) in cases {
            assert_eq!(serde_json::to_string(&event).unwrap(), expected);
        }
    }

    #[test]
    fn every_outcome_variant_has_a_valid_canonical_wire_value() {
        let cases = [
            (ModalityOutcomeKind::Updated, "updated"),
            (ModalityOutcomeKind::GateRejected, "gate_rejected"),
            (
                ModalityOutcomeKind::AssignmentRejected,
                "assignment_rejected",
            ),
            (ModalityOutcomeKind::UpdateRejected, "update_rejected"),
            (ModalityOutcomeKind::TrackBirth, "track_birth"),
            (ModalityOutcomeKind::UnsupportedFilter, "unsupported_filter"),
            (
                ModalityOutcomeKind::IncomparableProjection,
                "incomparable_projection",
            ),
        ];

        for (kind, tag) in cases {
            let value = valid_outcome(kind);
            value.validate().unwrap();
            let encoded = serde_json::to_value(value).unwrap();
            assert_eq!(encoded["outcome"], tag);
        }
    }

    #[test]
    fn gate_rejection_separates_attempt_evidence_from_pair_level_counts() {
        let mixed_pair = valid_outcome(ModalityOutcomeKind::GateRejected);
        assert_eq!(mixed_pair.in_gate_count, 1);
        assert!(mixed_pair.validate().is_ok());

        let mut no_pair_candidate = mixed_pair;
        no_pair_candidate.candidate_count = 0;
        no_pair_candidate.in_gate_count = 0;
        assert_eq!(
            no_pair_candidate.validate(),
            Err(MonitorError::EventCoherence(
                "gate_rejected requires at least one pair-level candidate"
            ))
        );
    }

    #[test]
    fn every_miss_reason_has_a_valid_canonical_wire_value() {
        let cases = [
            (ModalityMissReason::NoMeasurement, "no_measurement"),
            (ModalityMissReason::NoCandidate, "no_candidate"),
            (
                ModalityMissReason::NoInGateCandidate,
                "no_in_gate_candidate",
            ),
            (ModalityMissReason::NotAssigned, "not_assigned"),
            (ModalityMissReason::TrackNotEligible, "track_not_eligible"),
        ];

        for (reason, tag) in cases {
            let value = modality_miss(reason);
            value.validate().unwrap();
            let encoded = serde_json::to_value(value).unwrap();
            assert_eq!(encoded["reason"], tag);
        }
    }

    #[test]
    fn route_matches_galadriel_named_perception_contract() {
        assert_eq!(
            default_monitor_key("uav3").as_deref(),
            Some("ncp/session/uav3/sensor/galadriel-monitor")
        );
        assert_eq!(
            monitor_key("fleet/ncp", "uav3").as_deref(),
            Some("fleet/ncp/session/uav3/sensor/galadriel-monitor")
        );
        assert!(default_monitor_key("unsafe/id").is_none());
    }

    #[test]
    fn strict_wire_types_reject_unknown_fields() {
        let encoded = br#"{"kind":"galadriel_producer_event","schema_version":"1.0","ncp_version":"0.8","contract_hash":"d1b50a2d8a265276","session_id":"uav3","producer_id":"crebain","event_seq":1,"event":{"type":"heartbeat","data":{"producer_timestamp_ms":1,"uptime_ms":1,"declared_interval_ms":1,"declared_deadline_ms":1,"active_track_count":0,"degraded":false,"queue_health":{"capacity":1,"depth":0,"dropped_event_count":0,"published_event_count":0},"unexpected":true}}}"#;

        assert!(serde_json::from_slice::<MonitorEnvelope>(encoded).is_err());
    }
}
