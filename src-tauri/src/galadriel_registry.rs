//! Deployment-pinned frame and projection-context registry for Galadriel evidence.
//!
//! A [`DeploymentRegistry`] is immutable after construction. It is decoded with
//! unknown-field rejection, canonicalized, semantically validated, and assigned
//! a deterministic SHA-256 digest over its compact canonical JSON representation.
//! Operational callers should construct it with [`DeploymentRegistry::from_json_pinned`].

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::pid_observation::JSON_SAFE_INTEGER_MAX;
use crate::sensor_fusion::SensorModality;

/// Frozen registry document schema version.
pub const REGISTRY_SCHEMA_VERSION: &str = "1.0";

/// Largest encoded registry document accepted before JSON decoding.
pub const MAX_REGISTRY_BYTES: usize = 1024 * 1024;

/// Largest UTF-8 byte length accepted for a registry token.
pub const MAX_REGISTRY_TOKEN_BYTES: usize = 256;

/// Largest frame or context table accepted by one registry.
pub const MAX_REGISTRY_ENTRIES: usize = 256;

/// Largest source-frame table accepted by one frame entry.
pub const MAX_SOURCE_FRAMES_PER_FRAME: usize = 64;

/// Largest ordered transform chain accepted for one source frame.
pub const MAX_TRANSFORM_STEPS: usize = 32;

/// Galadriel monitor wire maximum for active tracks.
pub const MAX_ACTIVE_TRACKS: u32 = 1_024;

/// Galadriel monitor wire maximum for per-frame items.
pub const MAX_FRAME_ITEMS: u32 = 8_192;

/// Galadriel monitor wire maximum for producer queue events.
pub const MAX_MONITOR_QUEUE_EVENTS: u32 = 8_192;

const SHA256_HEX_LEN: usize = 64;
const MODALITY_COUNT: usize = 6;

/// A validated, canonical, deployment registry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentRegistry {
    document: RegistryDocument,
    canonical_json: Vec<u8>,
    digest: String,
}

impl DeploymentRegistry {
    /// Decode, canonicalize, and validate an unpinned registry document.
    ///
    /// This constructor is useful for tooling that computes a digest to pin.
    /// Operational producer startup should use [`Self::from_json_pinned`].
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError`] for an oversized or malformed document, an
    /// unknown field, or any failed semantic invariant.
    pub fn from_json(bytes: &[u8]) -> Result<Self, RegistryError> {
        if bytes.is_empty() || bytes.len() > MAX_REGISTRY_BYTES {
            return Err(RegistryError::DocumentSize {
                actual: bytes.len(),
                maximum: MAX_REGISTRY_BYTES,
            });
        }

        let mut document: RegistryDocument = serde_json::from_slice(bytes)
            .map_err(|error| RegistryError::Decode(error.to_string()))?;
        document.canonicalize();
        document.validate()?;

        let canonical_json = serde_json::to_vec(&document)
            .map_err(|error| RegistryError::Encode(error.to_string()))?;
        let digest = format!("{:x}", Sha256::digest(&canonical_json));

        Ok(Self {
            document,
            canonical_json,
            digest,
        })
    }

    /// Decode a registry and require its canonical digest to match a deployment pin.
    ///
    /// # Errors
    ///
    /// Returns [`RegistryError::InvalidDigest`] when `expected_digest` is not a
    /// lowercase SHA-256 digest and [`RegistryError::DigestMismatch`] when the
    /// validated canonical content does not match the pin.
    pub fn from_json_pinned(bytes: &[u8], expected_digest: &str) -> Result<Self, RegistryError> {
        validate_sha256("expected_registry_digest", expected_digest)?;
        let registry = Self::from_json(bytes)?;
        if registry.digest != expected_digest {
            return Err(RegistryError::DigestMismatch {
                expected: expected_digest.to_owned(),
                actual: registry.digest,
            });
        }
        Ok(registry)
    }

    /// Canonical registry version fixed by the deployment document.
    pub fn registry_version(&self) -> &str {
        &self.document.registry_version
    }

    /// Frozen registry document schema version.
    pub fn schema_version(&self) -> &str {
        &self.document.schema_version
    }

    /// Lowercase SHA-256 of [`Self::canonical_json`].
    pub fn digest(&self) -> &str {
        &self.digest
    }

    /// Compact canonical JSON bytes used to calculate [`Self::digest`].
    pub fn canonical_json(&self) -> &[u8] {
        &self.canonical_json
    }

    /// Canonically ordered frame entries.
    pub fn frames(&self) -> &[FrameDefinition] {
        &self.document.frames
    }

    /// Canonically ordered projection contexts.
    pub fn contexts(&self) -> &[ProjectionContext] {
        &self.document.contexts
    }

    /// Deterministic opportunity enumeration rule and bounded caps.
    pub fn opportunity_policy(&self) -> &OpportunityPolicy {
        &self.document.opportunity_policy
    }

    /// Find a frame definition by its immutable numeric identifier.
    pub fn frame(&self, frame_id: u64) -> Option<&FrameDefinition> {
        self.document
            .frames
            .binary_search_by_key(&frame_id, |frame| frame.frame_id)
            .ok()
            .map(|index| &self.document.frames[index])
    }

    /// Find a projection context by its immutable numeric identifier.
    pub fn context(&self, context_id: u64) -> Option<&ProjectionContext> {
        self.document
            .contexts
            .binary_search_by_key(&context_id, |context| context.context_id)
            .ok()
            .map(|index| &self.document.contexts[index])
    }

    /// Validate only the registry identity needed before attempting a projection.
    ///
    /// Success proves that the frame/context binding exists, the timestamp is in
    /// both applicability intervals, the modality is expected, and the source
    /// frame exactly matches its registered identity. It does **not** prove that
    /// calibration data was loaded, a transform was evaluated, or projected
    /// numeric values are finite; those checks remain mandatory before attesting
    /// a consistency projection.
    pub fn projection_binding(
        &self,
        identity: ProjectionIdentity<'_>,
    ) -> Result<ProjectionBinding<'_>, ProjectionIdentityError> {
        if identity.timestamp_ms > JSON_SAFE_INTEGER_MAX {
            return Err(ProjectionIdentityError::TimestampOutOfRange(
                identity.timestamp_ms,
            ));
        }
        let frame = self
            .frame(identity.frame_id)
            .ok_or(ProjectionIdentityError::UnknownFrame(identity.frame_id))?;
        let context = self
            .context(identity.context_id)
            .ok_or(ProjectionIdentityError::UnknownContext(identity.context_id))?;

        if context.frame_id != identity.frame_id {
            return Err(ProjectionIdentityError::ContextFrameMismatch {
                context_id: identity.context_id,
                expected_frame_id: context.frame_id,
                actual_frame_id: identity.frame_id,
            });
        }
        if !frame.applicability.contains(identity.timestamp_ms) {
            return Err(ProjectionIdentityError::FrameNotApplicable {
                frame_id: identity.frame_id,
                timestamp_ms: identity.timestamp_ms,
            });
        }
        if !context.applicability.contains(identity.timestamp_ms) {
            return Err(ProjectionIdentityError::ContextNotApplicable {
                context_id: identity.context_id,
                timestamp_ms: identity.timestamp_ms,
            });
        }

        let modality = context.modality(identity.modality).ok_or(
            ProjectionIdentityError::UnexpectedModality {
                context_id: identity.context_id,
                modality: identity.modality,
            },
        )?;
        if modality.canonical_source_frame != identity.source_frame {
            return Err(ProjectionIdentityError::SourceFrameMismatch {
                modality: identity.modality,
                expected: modality.canonical_source_frame.clone(),
                actual: identity.source_frame.to_owned(),
            });
        }

        let source_frame = frame.source_frame(identity.source_frame).ok_or_else(|| {
            ProjectionIdentityError::UnregisteredSourceFrame {
                frame_id: identity.frame_id,
                source_frame: identity.source_frame.to_owned(),
            }
        })?;

        Ok(ProjectionBinding {
            frame,
            context,
            modality,
            source_frame,
        })
    }
}

/// Borrowed identity asserted by a measurement before common-frame projection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectionIdentity<'a> {
    /// Immutable common-frame registry identifier.
    pub frame_id: u64,
    /// Immutable projection-context registry identifier.
    pub context_id: u64,
    /// Measurement modality.
    pub modality: SensorModality,
    /// Exact source-frame token from trusted ingress provenance.
    pub source_frame: &'a str,
    /// Measurement/fusion time used for applicability checks.
    pub timestamp_ms: u64,
}

/// Validated registry references for a projection attempt.
#[derive(Debug, Clone, Copy)]
pub struct ProjectionBinding<'a> {
    frame: &'a FrameDefinition,
    context: &'a ProjectionContext,
    modality: &'a ModalityProjection,
    source_frame: &'a SourceFrameDefinition,
}

impl<'a> ProjectionBinding<'a> {
    /// Common ENU frame selected by the registry.
    pub fn frame(&self) -> &'a FrameDefinition {
        self.frame
    }

    /// Projection context selected by the registry.
    pub fn context(&self) -> &'a ProjectionContext {
        self.context
    }

    /// Modality-specific calibration and aggregate extrinsic references.
    pub fn modality(&self) -> &'a ModalityProjection {
        self.modality
    }

    /// Registered ordered transform chain from the source frame to ENU.
    pub fn source_frame(&self) -> &'a SourceFrameDefinition {
        self.source_frame
    }
}

/// Strict serialized registry document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryDocument {
    schema_version: String,
    registry_version: String,
    opportunity_policy: OpportunityPolicy,
    frames: Vec<FrameDefinition>,
    contexts: Vec<ProjectionContext>,
}

impl RegistryDocument {
    fn canonicalize(&mut self) {
        self.frames.sort_by_key(|frame| frame.frame_id);
        for frame in &mut self.frames {
            frame.source_frames.sort_by(|left, right| {
                left.canonical_source_frame
                    .cmp(&right.canonical_source_frame)
            });
        }
        self.contexts.sort_by_key(|context| context.context_id);
        for context in &mut self.contexts {
            context
                .expected_modalities
                .sort_by_key(|entry| modality_rank(entry.modality));
        }
    }

    fn validate(&self) -> Result<(), RegistryError> {
        if self.schema_version != REGISTRY_SCHEMA_VERSION {
            return invalid(
                "schema_version",
                format!("must equal {REGISTRY_SCHEMA_VERSION}"),
            );
        }
        validate_token("registry_version", &self.registry_version)?;
        self.opportunity_policy.validate()?;
        validate_collection_len("frames", self.frames.len(), 1, MAX_REGISTRY_ENTRIES)?;
        validate_collection_len("contexts", self.contexts.len(), 1, MAX_REGISTRY_ENTRIES)?;

        for (index, frame) in self.frames.iter().enumerate() {
            frame.validate(&format!("frames[{index}]"))?;
            if index > 0 && self.frames[index - 1].frame_id == frame.frame_id {
                return Err(RegistryError::DuplicateIdentifier {
                    kind: "frame_id",
                    value: frame.frame_id,
                });
            }
        }

        for (index, context) in self.contexts.iter().enumerate() {
            let path = format!("contexts[{index}]");
            context.validate(&path)?;
            if index > 0 && self.contexts[index - 1].context_id == context.context_id {
                return Err(RegistryError::DuplicateIdentifier {
                    kind: "context_id",
                    value: context.context_id,
                });
            }

            let frame = self
                .frames
                .binary_search_by_key(&context.frame_id, |frame| frame.frame_id)
                .ok()
                .map(|frame_index| &self.frames[frame_index])
                .ok_or(RegistryError::UnknownFrame(context.frame_id))?;
            context.validate_against_frame(&path, frame)?;
        }
        self.validate_content_identifiers()
    }

    fn validate_content_identifiers(&self) -> Result<(), RegistryError> {
        let mut digests_by_identifier = BTreeMap::new();
        let mut versioned_digests_by_identity = BTreeMap::new();

        for frame in &self.frames {
            record_content_identity(&mut digests_by_identifier, &frame.origin)?;
            record_content_identity(&mut digests_by_identifier, &frame.datum)?;
            for source_frame in &frame.source_frames {
                record_content_identity(
                    &mut digests_by_identifier,
                    &source_frame.aggregate_extrinsic,
                )?;
                for step in &source_frame.transform_chain {
                    record_content_identity(&mut digests_by_identifier, &step.transform)?;
                }
            }
        }

        for context in &self.contexts {
            record_versioned_content_identity(
                &mut versioned_digests_by_identity,
                &context.projection_algorithm,
            )?;
            for modality in &context.expected_modalities {
                record_content_identity(&mut digests_by_identifier, &modality.calibration)?;
                record_content_identity(&mut digests_by_identifier, &modality.extrinsic)?;
            }
        }

        Ok(())
    }
}

/// A common Cartesian ENU/world frame and its registered source transforms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameDefinition {
    frame_id: u64,
    canonical_enu_frame: String,
    origin: ContentReference,
    datum: ContentReference,
    axis_order: [EnuAxis; 3],
    axis_directions: [AxisDirection; 3],
    handedness: Handedness,
    linear_unit: LinearUnit,
    applicability: ApplicabilityInterval,
    source_frames: Vec<SourceFrameDefinition>,
}

impl FrameDefinition {
    /// Immutable JSON-safe frame identifier.
    pub fn frame_id(&self) -> u64 {
        self.frame_id
    }

    /// Exact common Cartesian target-frame token.
    pub fn canonical_enu_frame(&self) -> &str {
        &self.canonical_enu_frame
    }

    /// Versioned origin reference with content digest.
    pub fn origin(&self) -> &ContentReference {
        &self.origin
    }

    /// Versioned datum reference with content digest.
    pub fn datum(&self) -> &ContentReference {
        &self.datum
    }

    /// Inclusive applicability interval for this frame definition.
    pub fn applicability(&self) -> ApplicabilityInterval {
        self.applicability
    }

    /// Fixed canonical axis order.
    pub fn axis_order(&self) -> [EnuAxis; 3] {
        self.axis_order
    }

    /// Fixed positive direction of the canonical axes.
    pub fn axis_directions(&self) -> [AxisDirection; 3] {
        self.axis_directions
    }

    /// Coordinate-system handedness.
    pub fn handedness(&self) -> Handedness {
        self.handedness
    }

    /// Common-frame linear unit.
    pub fn linear_unit(&self) -> LinearUnit {
        self.linear_unit
    }

    /// Canonically ordered registered source frames.
    pub fn source_frames(&self) -> &[SourceFrameDefinition] {
        &self.source_frames
    }

    /// Find an exact registered source-frame token.
    pub fn source_frame(&self, source_frame: &str) -> Option<&SourceFrameDefinition> {
        self.source_frames
            .binary_search_by(|entry| entry.canonical_source_frame.as_str().cmp(source_frame))
            .ok()
            .map(|index| &self.source_frames[index])
    }

    fn validate(&self, path: &str) -> Result<(), RegistryError> {
        validate_positive_json_id(&format!("{path}.frame_id"), self.frame_id)?;
        validate_token(
            &format!("{path}.canonical_enu_frame"),
            &self.canonical_enu_frame,
        )?;
        self.origin.validate(&format!("{path}.origin"))?;
        self.datum.validate(&format!("{path}.datum"))?;
        if self.axis_order != [EnuAxis::East, EnuAxis::North, EnuAxis::Up] {
            return invalid(
                format!("{path}.axis_order"),
                "must be the canonical [east, north, up] order",
            );
        }
        if self.axis_directions
            != [
                AxisDirection::PositiveEast,
                AxisDirection::PositiveNorth,
                AxisDirection::PositiveUp,
            ]
        {
            return invalid(
                format!("{path}.axis_directions"),
                "must be [positive_east, positive_north, positive_up]",
            );
        }
        if self.handedness != Handedness::RightHanded {
            return invalid(format!("{path}.handedness"), "must be right_handed");
        }
        if self.linear_unit != LinearUnit::Meter {
            return invalid(format!("{path}.linear_unit"), "must be meter");
        }
        self.applicability
            .validate(&format!("{path}.applicability"))?;
        validate_collection_len(
            &format!("{path}.source_frames"),
            self.source_frames.len(),
            1,
            MAX_SOURCE_FRAMES_PER_FRAME,
        )?;

        for (index, source) in self.source_frames.iter().enumerate() {
            let source_path = format!("{path}.source_frames[{index}]");
            source.validate(&source_path, &self.canonical_enu_frame)?;
            if index > 0
                && self.source_frames[index - 1].canonical_source_frame
                    == source.canonical_source_frame
            {
                return invalid(
                    format!("{path}.source_frames"),
                    format!(
                        "contains duplicate source frame {}",
                        source.canonical_source_frame
                    ),
                );
            }
        }
        Ok(())
    }
}

/// One exact source frame and its ordered path to the common frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceFrameDefinition {
    canonical_source_frame: String,
    transform_authority: String,
    aggregate_extrinsic: ContentReference,
    transform_chain: Vec<TransformStep>,
}

impl SourceFrameDefinition {
    /// Exact source-frame token required at ingress.
    pub fn canonical_source_frame(&self) -> &str {
        &self.canonical_source_frame
    }

    /// Authority that vouches for the ordered transform chain.
    pub fn transform_authority(&self) -> &str {
        &self.transform_authority
    }

    /// Digest-pinned aggregate extrinsic referenced by modality contexts.
    pub fn aggregate_extrinsic(&self) -> &ContentReference {
        &self.aggregate_extrinsic
    }

    /// Ordered, direction-sensitive transform chain to the common ENU frame.
    pub fn transform_chain(&self) -> &[TransformStep] {
        &self.transform_chain
    }

    fn validate(&self, path: &str, target_frame: &str) -> Result<(), RegistryError> {
        validate_token(
            &format!("{path}.canonical_source_frame"),
            &self.canonical_source_frame,
        )?;
        validate_token(
            &format!("{path}.transform_authority"),
            &self.transform_authority,
        )?;
        self.aggregate_extrinsic
            .validate(&format!("{path}.aggregate_extrinsic"))?;
        validate_collection_len(
            &format!("{path}.transform_chain"),
            self.transform_chain.len(),
            usize::from(self.canonical_source_frame != target_frame),
            MAX_TRANSFORM_STEPS,
        )?;

        if self.transform_chain.is_empty() {
            return Ok(());
        }

        let first = &self.transform_chain[0];
        if first.from_frame != self.canonical_source_frame {
            return invalid(
                format!("{path}.transform_chain[0].from_frame"),
                "must equal canonical_source_frame",
            );
        }
        for (index, step) in self.transform_chain.iter().enumerate() {
            step.validate(&format!("{path}.transform_chain[{index}]"))?;
            if index > 0 && self.transform_chain[index - 1].to_frame != step.from_frame {
                return invalid(
                    format!("{path}.transform_chain[{index}].from_frame"),
                    "must continue from the previous transform target",
                );
            }
        }
        if self
            .transform_chain
            .last()
            .map(|step| step.to_frame.as_str())
            != Some(target_frame)
        {
            return invalid(
                format!("{path}.transform_chain"),
                "must terminate at the canonical ENU frame",
            );
        }
        Ok(())
    }
}

/// One directed transform in an ordered source-to-ENU chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransformStep {
    from_frame: String,
    to_frame: String,
    transform: ContentReference,
}

impl TransformStep {
    /// Source frame for this directed step.
    pub fn from_frame(&self) -> &str {
        &self.from_frame
    }

    /// Target frame for this directed step.
    pub fn to_frame(&self) -> &str {
        &self.to_frame
    }

    /// Immutable transform identifier and digest.
    pub fn transform(&self) -> &ContentReference {
        &self.transform
    }

    fn validate(&self, path: &str) -> Result<(), RegistryError> {
        validate_token(&format!("{path}.from_frame"), &self.from_frame)?;
        validate_token(&format!("{path}.to_frame"), &self.to_frame)?;
        if self.from_frame == self.to_frame {
            return invalid(path, "directed transform endpoints must differ");
        }
        self.transform.validate(&format!("{path}.transform"))
    }
}

/// Projection semantics and expected modality bindings for one frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionContext {
    context_id: u64,
    frame_id: u64,
    applicability: ApplicabilityInterval,
    projection_algorithm: VersionedContentReference,
    output_dimensions: u8,
    axis_order: [EnuAxis; 3],
    covariance_semantics: CovarianceSemantics,
    linearization_semantics: LinearizationSemantics,
    expected_modalities: Vec<ModalityProjection>,
    producer_software_digest: String,
    producer_configuration_digest: String,
}

impl ProjectionContext {
    /// Immutable JSON-safe projection-context identifier.
    pub fn context_id(&self) -> u64 {
        self.context_id
    }

    /// Immutable common frame referenced by this context.
    pub fn frame_id(&self) -> u64 {
        self.frame_id
    }

    /// Inclusive applicability interval for this context.
    pub fn applicability(&self) -> ApplicabilityInterval {
        self.applicability
    }

    /// Versioned projection algorithm and content digest.
    pub fn projection_algorithm(&self) -> &VersionedContentReference {
        &self.projection_algorithm
    }

    /// Number of active common-frame output axes.
    pub fn output_dimensions(&self) -> u8 {
        self.output_dimensions
    }

    /// Fixed common-frame output axis order.
    pub fn axis_order(&self) -> [EnuAxis; 3] {
        self.axis_order
    }

    /// Covariance interpretation fixed by this context.
    pub fn covariance_semantics(&self) -> CovarianceSemantics {
        self.covariance_semantics
    }

    /// Linearization boundary fixed by this context.
    pub fn linearization_semantics(&self) -> LinearizationSemantics {
        self.linearization_semantics
    }

    /// Canonically ordered expected modality bindings.
    pub fn expected_modalities(&self) -> &[ModalityProjection] {
        &self.expected_modalities
    }

    /// Canonically ordered modality identities for frame-summary emission.
    pub fn expected_modality_ids(
        &self,
    ) -> impl ExactSizeIterator<Item = SensorModality> + DoubleEndedIterator + '_ {
        self.expected_modalities.iter().map(|entry| entry.modality)
    }

    /// Find an expected modality binding.
    pub fn modality(&self, modality: SensorModality) -> Option<&ModalityProjection> {
        self.expected_modalities
            .binary_search_by_key(&modality_rank(modality), |entry| {
                modality_rank(entry.modality)
            })
            .ok()
            .map(|index| &self.expected_modalities[index])
    }

    /// Producer software content digest that fixes these semantics.
    pub fn producer_software_digest(&self) -> &str {
        &self.producer_software_digest
    }

    /// Producer configuration content digest that fixes these semantics.
    pub fn producer_configuration_digest(&self) -> &str {
        &self.producer_configuration_digest
    }

    fn validate(&self, path: &str) -> Result<(), RegistryError> {
        validate_positive_json_id(&format!("{path}.context_id"), self.context_id)?;
        validate_positive_json_id(&format!("{path}.frame_id"), self.frame_id)?;
        self.applicability
            .validate(&format!("{path}.applicability"))?;
        self.projection_algorithm
            .validate(&format!("{path}.projection_algorithm"))?;
        if self.output_dimensions != 3 {
            return invalid(format!("{path}.output_dimensions"), "must equal 3");
        }
        if self.axis_order != [EnuAxis::East, EnuAxis::North, EnuAxis::Up] {
            return invalid(
                format!("{path}.axis_order"),
                "must be the canonical [east, north, up] order",
            );
        }
        validate_collection_len(
            &format!("{path}.expected_modalities"),
            self.expected_modalities.len(),
            1,
            MODALITY_COUNT,
        )?;
        for (index, modality) in self.expected_modalities.iter().enumerate() {
            modality.validate(&format!("{path}.expected_modalities[{index}]"))?;
            if index > 0 && self.expected_modalities[index - 1].modality == modality.modality {
                return invalid(
                    format!("{path}.expected_modalities"),
                    format!("contains duplicate modality {:?}", modality.modality),
                );
            }
        }
        validate_sha256(
            &format!("{path}.producer_software_digest"),
            &self.producer_software_digest,
        )?;
        validate_sha256(
            &format!("{path}.producer_configuration_digest"),
            &self.producer_configuration_digest,
        )
    }

    fn validate_against_frame(
        &self,
        path: &str,
        frame: &FrameDefinition,
    ) -> Result<(), RegistryError> {
        let starts_before_frame = !frame
            .applicability
            .contains(self.applicability.valid_from_timestamp_ms);
        let ends_after_frame = match (
            self.applicability.valid_until_timestamp_ms,
            frame.applicability.valid_until_timestamp_ms,
        ) {
            (None, Some(_)) => true,
            (Some(context_end), Some(frame_end)) => context_end > frame_end,
            (Some(_), None) | (None, None) => false,
        };
        if starts_before_frame || ends_after_frame {
            return invalid(
                format!("{path}.applicability"),
                "must be contained by the referenced frame applicability interval",
            );
        }

        for (index, modality) in self.expected_modalities.iter().enumerate() {
            let source = frame
                .source_frame(&modality.canonical_source_frame)
                .ok_or_else(|| RegistryError::InvalidField {
                    field: format!("{path}.expected_modalities[{index}].canonical_source_frame"),
                    reason: "is not registered by the referenced frame".to_owned(),
                })?;
            if modality.extrinsic != source.aggregate_extrinsic {
                return invalid(
                    format!("{path}.expected_modalities[{index}].extrinsic"),
                    "must exactly match the source frame aggregate_extrinsic",
                );
            }
        }
        Ok(())
    }
}

/// One expected modality with its source, calibration, and extrinsic identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModalityProjection {
    modality: SensorModality,
    canonical_source_frame: String,
    calibration: ContentReference,
    extrinsic: ContentReference,
}

impl ModalityProjection {
    /// Expected sensor modality.
    pub fn modality(&self) -> SensorModality {
        self.modality
    }

    /// Exact source frame required for this modality.
    pub fn canonical_source_frame(&self) -> &str {
        &self.canonical_source_frame
    }

    /// Calibration identifier and content digest.
    pub fn calibration(&self) -> &ContentReference {
        &self.calibration
    }

    /// Aggregate extrinsic identifier and content digest.
    pub fn extrinsic(&self) -> &ContentReference {
        &self.extrinsic
    }

    fn validate(&self, path: &str) -> Result<(), RegistryError> {
        validate_token(
            &format!("{path}.canonical_source_frame"),
            &self.canonical_source_frame,
        )?;
        self.calibration.validate(&format!("{path}.calibration"))?;
        self.extrinsic.validate(&format!("{path}.extrinsic"))
    }
}

/// Immutable content identifier and lowercase SHA-256 digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentReference {
    identifier: String,
    content_digest: String,
}

impl ContentReference {
    /// Stable identifier whose semantics may never be reassigned.
    pub fn identifier(&self) -> &str {
        &self.identifier
    }

    /// Lowercase SHA-256 of the referenced content.
    pub fn content_digest(&self) -> &str {
        &self.content_digest
    }

    fn validate(&self, path: &str) -> Result<(), RegistryError> {
        validate_token(&format!("{path}.identifier"), &self.identifier)?;
        validate_sha256(&format!("{path}.content_digest"), &self.content_digest)
    }
}

/// Versioned immutable content reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionedContentReference {
    identifier: String,
    version: String,
    content_digest: String,
}

impl VersionedContentReference {
    /// Stable algorithm/content identifier.
    pub fn identifier(&self) -> &str {
        &self.identifier
    }

    /// Explicit algorithm/content version.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Lowercase SHA-256 of the referenced implementation/specification.
    pub fn content_digest(&self) -> &str {
        &self.content_digest
    }

    fn validate(&self, path: &str) -> Result<(), RegistryError> {
        validate_token(&format!("{path}.identifier"), &self.identifier)?;
        validate_token(&format!("{path}.version"), &self.version)?;
        validate_sha256(&format!("{path}.content_digest"), &self.content_digest)
    }
}

/// Inclusive deployment applicability interval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicabilityInterval {
    valid_from_timestamp_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    valid_until_timestamp_ms: Option<u64>,
}

impl ApplicabilityInterval {
    /// Inclusive start timestamp in milliseconds.
    pub fn valid_from_timestamp_ms(self) -> u64 {
        self.valid_from_timestamp_ms
    }

    /// Optional inclusive end timestamp in milliseconds.
    pub fn valid_until_timestamp_ms(self) -> Option<u64> {
        self.valid_until_timestamp_ms
    }

    /// Whether `timestamp_ms` lies inside this inclusive interval.
    pub fn contains(self, timestamp_ms: u64) -> bool {
        timestamp_ms >= self.valid_from_timestamp_ms
            && self
                .valid_until_timestamp_ms
                .is_none_or(|until| timestamp_ms <= until)
    }

    fn validate(self, path: &str) -> Result<(), RegistryError> {
        validate_json_integer(
            &format!("{path}.valid_from_timestamp_ms"),
            self.valid_from_timestamp_ms,
        )?;
        if let Some(until) = self.valid_until_timestamp_ms {
            validate_json_integer(&format!("{path}.valid_until_timestamp_ms"), until)?;
            if until < self.valid_from_timestamp_ms {
                return invalid(
                    path,
                    "valid_until_timestamp_ms must not precede valid_from_timestamp_ms",
                );
            }
        }
        Ok(())
    }
}

/// Deterministic opportunity enumeration and bounded producer caps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpportunityPolicy {
    rule: OpportunityRule,
    max_active_tracks: u32,
    max_frame_inputs: u32,
    max_attempts_per_track_modality: u32,
    max_outcomes_per_frame: u32,
    max_monitor_queue_events: u32,
}

impl OpportunityPolicy {
    /// Frozen enumeration and aggregate-miss rule.
    pub fn rule(&self) -> OpportunityRule {
        self.rule
    }

    /// Maximum frozen pre-association tracks.
    pub fn max_active_tracks(&self) -> u32 {
        self.max_active_tracks
    }

    /// Maximum deterministic frame input records.
    pub fn max_frame_inputs(&self) -> u32 {
        self.max_frame_inputs
    }

    /// Maximum attempts emitted for one track/modality pair.
    pub fn max_attempts_per_track_modality(&self) -> u32 {
        self.max_attempts_per_track_modality
    }

    /// Maximum combined outcome/miss records emitted for a frame.
    pub fn max_outcomes_per_frame(&self) -> u32 {
        self.max_outcomes_per_frame
    }

    /// Maximum configured monitor queue events.
    pub fn max_monitor_queue_events(&self) -> u32 {
        self.max_monitor_queue_events
    }

    fn validate(&self) -> Result<(), RegistryError> {
        validate_cap(
            "opportunity_policy.max_active_tracks",
            self.max_active_tracks,
            MAX_ACTIVE_TRACKS,
        )?;
        validate_cap(
            "opportunity_policy.max_frame_inputs",
            self.max_frame_inputs,
            MAX_FRAME_ITEMS,
        )?;
        validate_cap(
            "opportunity_policy.max_attempts_per_track_modality",
            self.max_attempts_per_track_modality,
            MAX_FRAME_ITEMS,
        )?;
        validate_cap(
            "opportunity_policy.max_outcomes_per_frame",
            self.max_outcomes_per_frame,
            MAX_FRAME_ITEMS,
        )?;
        validate_cap(
            "opportunity_policy.max_monitor_queue_events",
            self.max_monitor_queue_events,
            MAX_MONITOR_QUEUE_EVENTS,
        )
    }
}

/// Frozen v1 opportunity enumeration and aggregate-miss policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpportunityRule {
    /// Freeze tracks after prediction; enumerate track IDs ascending, modalities
    /// in canonical enum order, and candidate inputs by ascending input index.
    /// Emit every bounded attempt, then the contract's deepest-stage aggregate
    /// miss unless an assigned/filter terminal disposition suppresses it.
    FrozenActiveTrackModalityInputOrderV1,
}

/// Common-frame axis identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnuAxis {
    /// East axis.
    East,
    /// North axis.
    North,
    /// Up axis.
    Up,
}

/// Positive direction of each ordered common-frame axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AxisDirection {
    /// Increasing values point east.
    PositiveEast,
    /// Increasing values point north.
    PositiveNorth,
    /// Increasing values point up.
    PositiveUp,
    /// Explicitly invalid for the frozen v1 ENU profile.
    NegativeEast,
    /// Explicitly invalid for the frozen v1 ENU profile.
    NegativeNorth,
    /// Explicitly invalid for the frozen v1 ENU profile.
    NegativeUp,
}

/// Coordinate-system handedness.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Handedness {
    /// Frozen v1 ENU profile.
    RightHanded,
    /// Parsed for a typed validation error, but rejected by frozen v1.
    LeftHanded,
}

/// Common-frame linear unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinearUnit {
    /// Meter.
    Meter,
    /// Parsed for a typed validation error, but rejected by frozen v1.
    Foot,
}

/// Frozen covariance semantics for common consistency projections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CovarianceSemantics {
    /// Covariance is projected from the same immutable pre-association prior.
    FrozenPriorProjectedObservationCovariance,
}

/// Frozen linearization boundary for common consistency projections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinearizationSemantics {
    /// Snapshot after prediction and before association, gating, or update.
    ImmutablePreAssociationPrior,
}

/// Registry decode, canonicalization, or semantic validation failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    /// Encoded document is empty or exceeds [`MAX_REGISTRY_BYTES`].
    DocumentSize {
        /// Actual input byte length.
        actual: usize,
        /// Maximum accepted input byte length.
        maximum: usize,
    },
    /// Strict JSON decoding failed.
    Decode(String),
    /// Canonical JSON encoding failed.
    Encode(String),
    /// A field failed a semantic invariant.
    InvalidField {
        /// JSON-style field path.
        field: String,
        /// Human-readable invariant.
        reason: String,
    },
    /// A SHA-256 field was not exactly 64 lowercase hexadecimal characters.
    InvalidDigest {
        /// JSON-style field path.
        field: String,
    },
    /// A numeric registry identifier was assigned more than once.
    DuplicateIdentifier {
        /// Identifier namespace.
        kind: &'static str,
        /// Reused numeric identifier.
        value: u64,
    },
    /// One immutable content identifier was associated with different digests.
    ConflictingContentIdentifier {
        /// Reused immutable content identifier.
        identifier: String,
        /// Digest observed first in canonical registry order.
        first_digest: String,
        /// Different digest observed later in canonical registry order.
        conflicting_digest: String,
    },
    /// One immutable versioned content identity was associated with different digests.
    ConflictingVersionedContentIdentifier {
        /// Stable algorithm/content family identifier.
        identifier: String,
        /// Exact version within that family.
        version: String,
        /// Digest observed first in canonical registry order.
        first_digest: String,
        /// Different digest observed later in canonical registry order.
        conflicting_digest: String,
    },
    /// A context references a missing frame.
    UnknownFrame(u64),
    /// Canonical registry content does not match the deployment pin.
    DigestMismatch {
        /// Deployment-pinned digest.
        expected: String,
        /// Digest of the validated canonical document.
        actual: String,
    },
}

impl fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DocumentSize { actual, maximum } => {
                write!(
                    formatter,
                    "registry document has {actual} bytes; expected 1..={maximum}"
                )
            }
            Self::Decode(error) => write!(formatter, "registry JSON decode failed: {error}"),
            Self::Encode(error) => write!(formatter, "registry canonical encoding failed: {error}"),
            Self::InvalidField { field, reason } => write!(formatter, "invalid {field}: {reason}"),
            Self::InvalidDigest { field } => {
                write!(
                    formatter,
                    "invalid {field}: expected 64 lowercase hexadecimal characters"
                )
            }
            Self::DuplicateIdentifier { kind, value } => {
                write!(formatter, "duplicate {kind} {value}")
            }
            Self::ConflictingContentIdentifier {
                identifier,
                first_digest,
                conflicting_digest,
            } => write!(
                formatter,
                "content identifier {identifier:?} has conflicting digests {first_digest} and {conflicting_digest}"
            ),
            Self::ConflictingVersionedContentIdentifier {
                identifier,
                version,
                first_digest,
                conflicting_digest,
            } => write!(
                formatter,
                "versioned content identity {identifier:?}@{version:?} has conflicting digests {first_digest} and {conflicting_digest}"
            ),
            Self::UnknownFrame(frame_id) => write!(formatter, "unknown frame_id {frame_id}"),
            Self::DigestMismatch { expected, actual } => write!(
                formatter,
                "registry digest mismatch: expected {expected}, calculated {actual}"
            ),
        }
    }
}

impl Error for RegistryError {}

/// Fail-closed reason that a measurement identity cannot attempt projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectionIdentityError {
    /// Timestamp cannot be represented exactly on the JSON monitor/sidecar wire.
    TimestampOutOfRange(u64),
    /// `frame_id` is absent from the pinned registry.
    UnknownFrame(u64),
    /// `context_id` is absent from the pinned registry.
    UnknownContext(u64),
    /// The context is bound to a different common frame.
    ContextFrameMismatch {
        /// Requested context.
        context_id: u64,
        /// Frame fixed by that context.
        expected_frame_id: u64,
        /// Frame asserted by the measurement/frame ledger.
        actual_frame_id: u64,
    },
    /// The common frame is not applicable at the measurement time.
    FrameNotApplicable {
        /// Requested frame.
        frame_id: u64,
        /// Requested timestamp.
        timestamp_ms: u64,
    },
    /// The projection context is not applicable at the measurement time.
    ContextNotApplicable {
        /// Requested context.
        context_id: u64,
        /// Requested timestamp.
        timestamp_ms: u64,
    },
    /// The modality is not in the context's expected set.
    UnexpectedModality {
        /// Requested context.
        context_id: u64,
        /// Unexpected modality.
        modality: SensorModality,
    },
    /// Ingress source identity differs from the modality binding.
    SourceFrameMismatch {
        /// Measurement modality.
        modality: SensorModality,
        /// Exact registered source frame.
        expected: String,
        /// Ingress source frame.
        actual: String,
    },
    /// The source-frame definition is absent from the referenced frame.
    UnregisteredSourceFrame {
        /// Requested frame.
        frame_id: u64,
        /// Missing source frame.
        source_frame: String,
    },
}

impl fmt::Display for ProjectionIdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TimestampOutOfRange(timestamp_ms) => write!(
                formatter,
                "timestamp {timestamp_ms} exceeds the exact JSON integer range"
            ),
            Self::UnknownFrame(frame_id) => write!(formatter, "unknown frame_id {frame_id}"),
            Self::UnknownContext(context_id) => write!(formatter, "unknown context_id {context_id}"),
            Self::ContextFrameMismatch {
                context_id,
                expected_frame_id,
                actual_frame_id,
            } => write!(
                formatter,
                "context_id {context_id} requires frame_id {expected_frame_id}, got {actual_frame_id}"
            ),
            Self::FrameNotApplicable {
                frame_id,
                timestamp_ms,
            } => write!(
                formatter,
                "frame_id {frame_id} is not applicable at timestamp {timestamp_ms}"
            ),
            Self::ContextNotApplicable {
                context_id,
                timestamp_ms,
            } => write!(
                formatter,
                "context_id {context_id} is not applicable at timestamp {timestamp_ms}"
            ),
            Self::UnexpectedModality {
                context_id,
                modality,
            } => write!(
                formatter,
                "modality {modality:?} is not expected by context_id {context_id}"
            ),
            Self::SourceFrameMismatch {
                modality,
                expected,
                actual,
            } => write!(
                formatter,
                "modality {modality:?} requires source frame {expected}, got {actual}"
            ),
            Self::UnregisteredSourceFrame {
                frame_id,
                source_frame,
            } => write!(
                formatter,
                "source frame {source_frame} is not registered by frame_id {frame_id}"
            ),
        }
    }
}

impl Error for ProjectionIdentityError {}

fn validate_token(field: &str, value: &str) -> Result<(), RegistryError> {
    if value.is_empty()
        || value.len() > MAX_REGISTRY_TOKEN_BYTES
        || !value.is_ascii()
        || value.bytes().any(|byte| {
            !(byte.is_ascii_alphanumeric()
                || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':' | b'+'))
        })
    {
        return invalid(
            field,
            format!("must be a 1..={MAX_REGISTRY_TOKEN_BYTES}-byte ASCII registry token"),
        );
    }
    Ok(())
}

fn validate_sha256(field: &str, value: &str) -> Result<(), RegistryError> {
    if value.len() != SHA256_HEX_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(RegistryError::InvalidDigest {
            field: field.to_owned(),
        });
    }
    Ok(())
}

fn record_content_identity<'a>(
    digests_by_identifier: &mut BTreeMap<&'a str, &'a str>,
    reference: &'a ContentReference,
) -> Result<(), RegistryError> {
    if let Some(first_digest) = digests_by_identifier.get(reference.identifier.as_str()) {
        if *first_digest != reference.content_digest {
            return Err(RegistryError::ConflictingContentIdentifier {
                identifier: reference.identifier.clone(),
                first_digest: (*first_digest).to_owned(),
                conflicting_digest: reference.content_digest.clone(),
            });
        }
        return Ok(());
    }

    digests_by_identifier.insert(
        reference.identifier.as_str(),
        reference.content_digest.as_str(),
    );
    Ok(())
}

fn record_versioned_content_identity<'a>(
    digests_by_identity: &mut BTreeMap<(&'a str, &'a str), &'a str>,
    reference: &'a VersionedContentReference,
) -> Result<(), RegistryError> {
    let identity = (reference.identifier.as_str(), reference.version.as_str());
    if let Some(first_digest) = digests_by_identity.get(&identity) {
        if *first_digest != reference.content_digest {
            return Err(RegistryError::ConflictingVersionedContentIdentifier {
                identifier: reference.identifier.clone(),
                version: reference.version.clone(),
                first_digest: (*first_digest).to_owned(),
                conflicting_digest: reference.content_digest.clone(),
            });
        }
        return Ok(());
    }

    digests_by_identity.insert(identity, reference.content_digest.as_str());
    Ok(())
}

fn validate_positive_json_id(field: &str, value: u64) -> Result<(), RegistryError> {
    if value == 0 || value > JSON_SAFE_INTEGER_MAX {
        return invalid(field, format!("must be within 1..={JSON_SAFE_INTEGER_MAX}"));
    }
    Ok(())
}

fn validate_json_integer(field: &str, value: u64) -> Result<(), RegistryError> {
    if value > JSON_SAFE_INTEGER_MAX {
        return invalid(field, format!("must not exceed {JSON_SAFE_INTEGER_MAX}"));
    }
    Ok(())
}

fn validate_collection_len(
    field: &str,
    actual: usize,
    minimum: usize,
    maximum: usize,
) -> Result<(), RegistryError> {
    if !(minimum..=maximum).contains(&actual) {
        return invalid(
            field,
            format!("length must be within {minimum}..={maximum}"),
        );
    }
    Ok(())
}

fn validate_cap(field: &str, value: u32, maximum: u32) -> Result<(), RegistryError> {
    if value == 0 || value > maximum {
        return invalid(field, format!("must be within 1..={maximum}"));
    }
    Ok(())
}

fn invalid<T>(field: impl Into<String>, reason: impl Into<String>) -> Result<T, RegistryError> {
    Err(RegistryError::InvalidField {
        field: field.into(),
        reason: reason.into(),
    })
}

fn modality_rank(modality: SensorModality) -> u8 {
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
    use serde_json::{json, Value};

    use super::*;

    const FRAME_ID: u64 = 17;
    const CONTEXT_ID: u64 = 23;
    const VALID_UNTIL_MS: u64 = 2_000;
    const RAW_GALADRIEL_FIXTURE: &[u8] =
        include_bytes!("../tests/fixtures/crebain_registry_v1.json");
    const RAW_GALADRIEL_FIXTURE_BYTES: usize = 3_053;
    const RAW_GALADRIEL_FIXTURE_SHA256: &str =
        "506ce1437acc20ee5d36fd1e3551dd020095cc4d30d22d959c5df3cca81715a6";
    const CANONICAL_GALADRIEL_FIXTURE_BYTES: usize = 3_052;
    const CANONICAL_GALADRIEL_FIXTURE_SHA256: &str =
        "7644ec2bbf0e400303aaad62c647eea36bd919913f1a28a81c52c13e00dd45ba";

    fn digest(character: char) -> String {
        character.to_string().repeat(SHA256_HEX_LEN)
    }

    fn content(identifier: &str, character: char) -> Value {
        json!({
            "identifier": identifier,
            "content_digest": digest(character),
        })
    }

    fn source_frame(
        source: &str,
        target: &str,
        extrinsic_identifier: &str,
        character: char,
    ) -> Value {
        json!({
            "canonical_source_frame": source,
            "transform_authority": "tf2_static",
            "aggregate_extrinsic": content(extrinsic_identifier, character),
            "transform_chain": [{
                "from_frame": source,
                "to_frame": target,
                "transform": content(extrinsic_identifier, character),
            }],
        })
    }

    fn modality(
        name: &str,
        source: &str,
        calibration_identifier: &str,
        calibration_digest: char,
        extrinsic_identifier: &str,
        extrinsic_digest: char,
    ) -> Value {
        json!({
            "modality": name,
            "canonical_source_frame": source,
            "calibration": content(calibration_identifier, calibration_digest),
            "extrinsic": content(extrinsic_identifier, extrinsic_digest),
        })
    }

    fn registry_value() -> Value {
        json!({
            "schema_version": REGISTRY_SCHEMA_VERSION,
            "registry_version": "deployment-2026.07.13",
            "opportunity_policy": {
                "rule": "frozen_active_track_modality_input_order_v1",
                "max_active_tracks": MAX_ACTIVE_TRACKS,
                "max_frame_inputs": MAX_FRAME_ITEMS,
                "max_attempts_per_track_modality": 8,
                "max_outcomes_per_frame": MAX_FRAME_ITEMS,
                "max_monitor_queue_events": MAX_MONITOR_QUEUE_EVENTS,
            },
            "frames": [{
                "frame_id": FRAME_ID,
                "canonical_enu_frame": "map_enu",
                "origin": content("site_alpha_origin_v1", '1'),
                "datum": content("wgs84_v1", '2'),
                "axis_order": ["east", "north", "up"],
                "axis_directions": ["positive_east", "positive_north", "positive_up"],
                "handedness": "right_handed",
                "linear_unit": "meter",
                "applicability": {
                    "valid_from_timestamp_ms": 1_000,
                    "valid_until_timestamp_ms": VALID_UNTIL_MS,
                },
                "source_frames": [
                    source_frame("radar_front", "map_enu", "radar_extrinsic_v3", '4'),
                    source_frame("camera_optical", "map_enu", "camera_extrinsic_v2", '3'),
                ],
            }],
            "contexts": [{
                "context_id": CONTEXT_ID,
                "frame_id": FRAME_ID,
                "applicability": {
                    "valid_from_timestamp_ms": 1_100,
                    "valid_until_timestamp_ms": 1_900,
                },
                "projection_algorithm": {
                    "identifier": "common_enu_residual",
                    "version": "1.0.0",
                    "content_digest": digest('5'),
                },
                "output_dimensions": 3,
                "axis_order": ["east", "north", "up"],
                "covariance_semantics": "frozen_prior_projected_observation_covariance",
                "linearization_semantics": "immutable_pre_association_prior",
                "expected_modalities": [
                    modality(
                        "radar",
                        "radar_front",
                        "radar_calibration_v5",
                        '7',
                        "radar_extrinsic_v3",
                        '4',
                    ),
                    modality(
                        "visual",
                        "camera_optical",
                        "camera_calibration_v4",
                        '6',
                        "camera_extrinsic_v2",
                        '3',
                    ),
                ],
                "producer_software_digest": digest('8'),
                "producer_configuration_digest": digest('9'),
            }],
        })
    }

    fn decode(value: &Value) -> Result<DeploymentRegistry, RegistryError> {
        DeploymentRegistry::from_json(&serde_json::to_vec(value).expect("fixture encodes"))
    }

    #[test]
    fn canonical_digest_is_stable_across_set_order_and_json_whitespace() {
        let first = registry_value();
        let mut reordered = registry_value();
        reordered["frames"][0]["source_frames"]
            .as_array_mut()
            .expect("source array")
            .reverse();
        reordered["contexts"][0]["expected_modalities"]
            .as_array_mut()
            .expect("modality array")
            .reverse();

        let first_registry = decode(&first).expect("first registry validates");
        let pretty = serde_json::to_vec_pretty(&reordered).expect("fixture encodes");
        let reordered_registry =
            DeploymentRegistry::from_json(&pretty).expect("reordered registry validates");

        assert_eq!(first_registry.digest(), reordered_registry.digest());
        assert_eq!(
            first_registry.canonical_json(),
            reordered_registry.canonical_json()
        );
    }

    #[test]
    fn semantic_content_change_changes_canonical_digest() {
        let first = decode(&registry_value()).expect("registry validates");
        let mut changed = registry_value();
        changed["contexts"][0]["expected_modalities"][0]["calibration"]["content_digest"] =
            Value::String(digest('a'));
        let changed = decode(&changed).expect("changed registry validates");

        assert_ne!(first.digest(), changed.digest());
    }

    #[test]
    fn conflicting_digest_for_one_content_identifier_is_rejected() {
        let mut value = registry_value();
        value["frames"][0]["datum"]["identifier"] =
            Value::String("site_alpha_origin_v1".to_owned());

        let error = decode(&value).expect_err("content identifiers must be immutable");

        assert!(matches!(
            error,
            RegistryError::ConflictingContentIdentifier {
                ref identifier,
                ..
            } if identifier == "site_alpha_origin_v1"
        ));
    }

    #[test]
    fn conflicting_transform_content_identifier_is_rejected() {
        let mut value = registry_value();
        value["frames"][0]["source_frames"][0]["transform_chain"][0]["transform"]["identifier"] =
            Value::String("site_alpha_origin_v1".to_owned());

        let error = decode(&value).expect_err("transform identifiers must be immutable");

        assert!(matches!(
            error,
            RegistryError::ConflictingContentIdentifier {
                ref identifier,
                ..
            } if identifier == "site_alpha_origin_v1"
        ));
    }

    #[test]
    fn conflicting_modality_calibration_identifier_is_rejected() {
        let mut value = registry_value();
        value["contexts"][0]["expected_modalities"][1]["calibration"]["identifier"] =
            Value::String("radar_calibration_v5".to_owned());

        let error = decode(&value).expect_err("calibration identifiers must be immutable");

        assert!(matches!(
            error,
            RegistryError::ConflictingContentIdentifier {
                ref identifier,
                ..
            } if identifier == "radar_calibration_v5"
        ));
    }

    #[test]
    fn conflicting_digest_for_one_projection_algorithm_version_is_rejected() {
        let mut value = registry_value();
        let mut second_context = value["contexts"][0].clone();
        second_context["context_id"] = Value::from(CONTEXT_ID + 1);
        second_context["projection_algorithm"]["content_digest"] = Value::String(digest('a'));
        value["contexts"]
            .as_array_mut()
            .expect("context array")
            .push(second_context);

        let error = decode(&value).expect_err("one algorithm version must have one digest");

        assert!(matches!(
            error,
            RegistryError::ConflictingVersionedContentIdentifier {
                ref identifier,
                ref version,
                ..
            } if identifier == "common_enu_residual" && version == "1.0.0"
        ));
    }

    #[test]
    fn new_projection_algorithm_version_may_use_a_new_digest() {
        let mut value = registry_value();
        let mut second_context = value["contexts"][0].clone();
        second_context["context_id"] = Value::from(CONTEXT_ID + 1);
        second_context["projection_algorithm"]["version"] = Value::String("1.1.0".to_owned());
        second_context["projection_algorithm"]["content_digest"] = Value::String(digest('a'));
        value["contexts"]
            .as_array_mut()
            .expect("context array")
            .push(second_context);

        let registry = decode(&value).expect("new algorithm versions are distinct identities");

        assert_eq!(registry.contexts().len(), 2);
    }

    #[test]
    fn output_dimensions_other_than_three_are_rejected() {
        let mut value = registry_value();
        value["contexts"][0]["output_dimensions"] = Value::from(2);

        let error = decode(&value).expect_err("frozen ENU projections must be three-dimensional");

        assert!(matches!(error, RegistryError::InvalidField { .. }));
    }

    #[test]
    fn committed_galadriel_fixture_raw_bytes_are_frozen() {
        let actual = (
            RAW_GALADRIEL_FIXTURE.len(),
            format!("{:x}", Sha256::digest(RAW_GALADRIEL_FIXTURE)),
        );

        assert_eq!(
            actual,
            (
                RAW_GALADRIEL_FIXTURE_BYTES,
                RAW_GALADRIEL_FIXTURE_SHA256.to_string(),
            )
        );
    }

    #[test]
    fn committed_galadriel_fixture_canonical_digest_is_frozen() {
        let registry = DeploymentRegistry::from_json(RAW_GALADRIEL_FIXTURE)
            .expect("committed Galadriel registry fixture validates");

        assert_eq!(
            (registry.canonical_json().len(), registry.digest()),
            (
                CANONICAL_GALADRIEL_FIXTURE_BYTES,
                CANONICAL_GALADRIEL_FIXTURE_SHA256,
            )
        );
    }

    #[test]
    fn committed_galadriel_fixture_has_exact_projection_dimensions_and_algorithm() {
        let registry = DeploymentRegistry::from_json_pinned(
            RAW_GALADRIEL_FIXTURE,
            CANONICAL_GALADRIEL_FIXTURE_SHA256,
        )
        .expect("committed Galadriel registry fixture matches its canonical pin");
        let context = registry
            .context(CONTEXT_ID)
            .expect("committed fixture contains context 23");
        let algorithm = context.projection_algorithm();

        assert_eq!(
            (
                context.output_dimensions(),
                algorithm.identifier(),
                algorithm.version(),
                algorithm.content_digest(),
            ),
            (
                3,
                "common_enu_residual",
                "1.0.0",
                "5555555555555555555555555555555555555555555555555555555555555555",
            )
        );
    }

    #[test]
    fn pinned_constructor_accepts_exact_canonical_digest() {
        let bytes = serde_json::to_vec(&registry_value()).expect("fixture encodes");
        let digest = DeploymentRegistry::from_json(&bytes)
            .expect("registry validates")
            .digest()
            .to_owned();

        let pinned = DeploymentRegistry::from_json_pinned(&bytes, &digest)
            .expect("exact deployment pin validates");

        assert_eq!(pinned.digest(), digest);
    }

    #[test]
    fn pinned_constructor_rejects_content_mismatch() {
        let bytes = serde_json::to_vec(&registry_value()).expect("fixture encodes");
        let error = DeploymentRegistry::from_json_pinned(&bytes, &digest('a'))
            .expect_err("wrong deployment pin must fail");

        assert!(matches!(error, RegistryError::DigestMismatch { .. }));
    }

    #[test]
    fn strict_decoder_rejects_unknown_fields() {
        let mut value = registry_value();
        value["unexpected"] = Value::Bool(true);

        let error = decode(&value).expect_err("unknown field must fail");

        assert!(matches!(error, RegistryError::Decode(_)));
    }

    #[test]
    fn positive_json_safe_identifier_boundary_is_accepted() {
        let mut value = registry_value();
        value["frames"][0]["frame_id"] = Value::from(JSON_SAFE_INTEGER_MAX);
        value["contexts"][0]["frame_id"] = Value::from(JSON_SAFE_INTEGER_MAX);

        let registry = decode(&value).expect("JSON-safe maximum validates");

        assert!(registry.frame(JSON_SAFE_INTEGER_MAX).is_some());
    }

    #[test]
    fn zero_registry_identifier_is_rejected() {
        let mut value = registry_value();
        value["contexts"][0]["context_id"] = Value::from(0);

        let error = decode(&value).expect_err("zero context id must fail");

        assert!(matches!(error, RegistryError::InvalidField { .. }));
    }

    #[test]
    fn identifier_above_json_safe_boundary_is_rejected() {
        let mut value = registry_value();
        value["contexts"][0]["context_id"] = Value::from(JSON_SAFE_INTEGER_MAX + 1);

        let error = decode(&value).expect_err("inexact JSON id must fail");

        assert!(matches!(error, RegistryError::InvalidField { .. }));
    }

    #[test]
    fn duplicate_expected_modality_is_rejected() {
        let mut value = registry_value();
        let duplicate = value["contexts"][0]["expected_modalities"][0].clone();
        value["contexts"][0]["expected_modalities"]
            .as_array_mut()
            .expect("modality array")
            .push(duplicate);

        let error = decode(&value).expect_err("duplicate expected modality must fail");

        assert!(matches!(error, RegistryError::InvalidField { .. }));
    }

    #[test]
    fn uppercase_content_digest_is_rejected() {
        let mut value = registry_value();
        value["frames"][0]["origin"]["content_digest"] = Value::String("A".repeat(64));

        let error = decode(&value).expect_err("uppercase digest must fail");

        assert!(matches!(error, RegistryError::InvalidDigest { .. }));
    }

    #[test]
    fn opportunity_cap_above_monitor_wire_limit_is_rejected() {
        let mut value = registry_value();
        value["opportunity_policy"]["max_outcomes_per_frame"] = Value::from(MAX_FRAME_ITEMS + 1);

        let error = decode(&value).expect_err("oversized opportunity cap must fail");

        assert!(matches!(error, RegistryError::InvalidField { .. }));
    }

    #[test]
    fn disconnected_transform_chain_is_rejected() {
        let mut value = registry_value();
        value["frames"][0]["source_frames"][0]["transform_chain"][0]["to_frame"] =
            Value::String("wrong_target".to_owned());

        let error = decode(&value).expect_err("wrong transform target must fail");

        assert!(matches!(error, RegistryError::InvalidField { .. }));
    }

    #[test]
    fn unbounded_context_inside_bounded_frame_is_rejected() {
        let mut value = registry_value();
        value["contexts"][0]["applicability"]
            .as_object_mut()
            .expect("applicability object")
            .remove("valid_until_timestamp_ms");

        let error = decode(&value).expect_err("context must not outlive its frame");

        assert!(matches!(error, RegistryError::InvalidField { .. }));
    }

    #[test]
    fn exact_projection_identity_returns_registered_binding() {
        let registry = decode(&registry_value()).expect("registry validates");

        let binding = registry
            .projection_binding(ProjectionIdentity {
                frame_id: FRAME_ID,
                context_id: CONTEXT_ID,
                modality: SensorModality::Radar,
                source_frame: "radar_front",
                timestamp_ms: 1_500,
            })
            .expect("exact identity is eligible");

        assert_eq!(binding.frame().canonical_enu_frame(), "map_enu");
        assert_eq!(
            binding.modality().calibration().identifier(),
            "radar_calibration_v5"
        );
    }

    #[test]
    fn projection_identity_rejects_source_frame_alias() {
        let registry = decode(&registry_value()).expect("registry validates");

        let error = registry
            .projection_binding(ProjectionIdentity {
                frame_id: FRAME_ID,
                context_id: CONTEXT_ID,
                modality: SensorModality::Radar,
                source_frame: "/radar_front",
                timestamp_ms: 1_500,
            })
            .expect_err("source frame aliases must fail closed");

        assert!(matches!(
            error,
            ProjectionIdentityError::SourceFrameMismatch { .. }
        ));
    }

    #[test]
    fn projection_identity_accepts_inclusive_context_end_boundary() {
        let registry = decode(&registry_value()).expect("registry validates");

        let result = registry.projection_binding(ProjectionIdentity {
            frame_id: FRAME_ID,
            context_id: CONTEXT_ID,
            modality: SensorModality::Visual,
            source_frame: "camera_optical",
            timestamp_ms: 1_900,
        });

        assert!(result.is_ok(), "inclusive end boundary failed: {result:?}");
    }

    #[test]
    fn projection_identity_rejects_expired_context() {
        let registry = decode(&registry_value()).expect("registry validates");

        let error = registry
            .projection_binding(ProjectionIdentity {
                frame_id: FRAME_ID,
                context_id: CONTEXT_ID,
                modality: SensorModality::Visual,
                source_frame: "camera_optical",
                timestamp_ms: VALID_UNTIL_MS,
            })
            .expect_err("expired context must fail closed");

        assert!(matches!(
            error,
            ProjectionIdentityError::ContextNotApplicable { .. }
        ));
    }

    #[test]
    fn projection_identity_rejects_timestamp_above_json_safe_boundary() {
        let registry = decode(&registry_value()).expect("registry validates");

        let error = registry
            .projection_binding(ProjectionIdentity {
                frame_id: FRAME_ID,
                context_id: CONTEXT_ID,
                modality: SensorModality::Visual,
                source_frame: "camera_optical",
                timestamp_ms: JSON_SAFE_INTEGER_MAX + 1,
            })
            .expect_err("inexact JSON timestamp must fail before applicability lookup");

        assert_eq!(
            error,
            ProjectionIdentityError::TimestampOutOfRange(JSON_SAFE_INTEGER_MAX + 1)
        );
    }

    #[test]
    fn registry_document_size_boundary_fails_before_decode() {
        let oversized = vec![b' '; MAX_REGISTRY_BYTES + 1];

        let error = DeploymentRegistry::from_json(&oversized)
            .expect_err("oversized registry must fail before decode");

        assert_eq!(
            error,
            RegistryError::DocumentSize {
                actual: MAX_REGISTRY_BYTES + 1,
                maximum: MAX_REGISTRY_BYTES,
            }
        );
    }
}
