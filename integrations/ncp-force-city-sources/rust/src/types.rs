//! Closed records generated from the installed city schema.
use crate::Finite64;
use ncp_local::modular_buffer::BufferManifest;
use serde::{Deserialize, Serialize};
/// No import capability exists in this application.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Never {}
/// Installed `Vec3` record; relational admission remains separate.
pub type Vec3 = [Finite64; 3];

/// Installed `Material` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Material {
    /// Closed member `id`.
    pub id: String,
    /// Closed member `linearRgb`.
    #[serde(rename = "linearRgb")]
    pub linear_rgb: [Finite64; 3],
    /// Closed member `gaussianOpacity`.
    #[serde(rename = "gaussianOpacity")]
    pub gaussian_opacity: Finite64,
    /// Closed member `temperatureK`.
    #[serde(rename = "temperatureK")]
    pub temperature_k: Finite64,
    /// Closed member `emissivity`.
    pub emissivity: Finite64,
}

/// Installed `Acoustic` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Acoustic {
    /// Closed member `profile`.
    #[serde(deserialize_with = "decode_acoustic_profile")]
    pub profile: String,
    /// Closed member `sampleRateHz`.
    #[serde(rename = "sampleRateHz")]
    #[serde(deserialize_with = "decode_acoustic_sample_rate_hz")]
    pub sample_rate_hz: u64,
    /// Closed member `soundSpeedMps`.
    #[serde(rename = "soundSpeedMps")]
    pub sound_speed_mps: Finite64,
    /// Closed member `maximumRangeM`.
    #[serde(rename = "maximumRangeM")]
    pub maximum_range_m: Finite64,
    /// Closed member `referenceDistanceM`.
    #[serde(rename = "referenceDistanceM")]
    pub reference_distance_m: Finite64,
    /// Closed member `referencePressurePa`.
    #[serde(rename = "referencePressurePa")]
    pub reference_pressure_pa: Finite64,
    /// Closed member `bladeCount`.
    #[serde(rename = "bladeCount")]
    #[serde(deserialize_with = "decode_acoustic_blade_count")]
    pub blade_count: u64,
    /// Closed member `blockedGain`.
    #[serde(rename = "blockedGain")]
    pub blocked_gain: Finite64,
    /// Closed member `noiseStdPa`.
    #[serde(rename = "noiseStdPa")]
    pub noise_std_pa: Finite64,
    /// Closed member `seed`.
    pub seed: u64,
}

/// Installed `Thermal` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Thermal {
    /// Closed member `profile`.
    #[serde(deserialize_with = "decode_thermal_profile")]
    pub profile: String,
    /// Closed member `ambientK`.
    #[serde(rename = "ambientK")]
    pub ambient_k: Finite64,
    /// Closed member `initialK`.
    #[serde(rename = "initialK")]
    pub initial_k: Finite64,
    /// Closed member `capacityJPerK`.
    #[serde(rename = "capacityJPerK")]
    pub capacity_jper_k: Finite64,
    /// Closed member `areaM2`.
    #[serde(rename = "areaM2")]
    pub area_m2: Finite64,
    /// Closed member `convectionWPerM2K`.
    #[serde(rename = "convectionWPerM2K")]
    pub convection_wper_m2_k: Finite64,
    /// Closed member `emissivity`.
    pub emissivity: Finite64,
    /// Closed member `motorEfficiency`.
    #[serde(rename = "motorEfficiency")]
    pub motor_efficiency: Finite64,
}

/// Installed `Tensor` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Tensor {
    /// The closed `RgbaTensor` variant.
    RgbaTensor(Box<RgbaTensor>),
    /// The closed `RadianceTensor` variant.
    RadianceTensor(Box<RadianceTensor>),
    /// The closed `PressureTensor` variant.
    PressureTensor(Box<PressureTensor>),
}

/// Installed `ControllerReference` record; relational admission remains separate.
pub type ControllerReference = [Finite64; 2];

/// Installed `Solid` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Solid {
    /// Closed member `id`.
    pub id: String,
    /// Closed member `center`.
    pub center: Vec3,
    /// Closed member `half_extents`.
    pub half_extents: [Finite64; 3],
    /// Closed member `yaw`.
    pub yaw: Finite64,
    /// Closed member `friction`.
    pub friction: Finite64,
    /// Closed member `restitution`.
    pub restitution: Finite64,
    /// Closed member `material_index`.
    pub material_index: u64,
}

/// Installed `World` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct World {
    /// Closed member `profile`.
    #[serde(deserialize_with = "decode_world_profile")]
    pub profile: String,
    /// Closed member `engine_model`.
    #[serde(deserialize_with = "decode_world_engine_model")]
    pub engine_model: String,
    /// Closed member `frame`.
    #[serde(deserialize_with = "decode_world_frame")]
    pub frame: String,
    /// Closed member `horizon_ticks`.
    pub horizon_ticks: u64,
    /// Closed member `action_budget`.
    pub action_budget: u64,
    /// Closed member `entity_ids`.
    pub entity_ids: Vec<String>,
    /// Closed member `initial_positions`.
    pub initial_positions: Vec<Vec3>,
    /// Closed member `controller_references`.
    pub controller_references: Vec<ControllerReference>,
}

/// Installed `Scene` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    /// Closed member `id`.
    pub id: String,
    /// Closed member `materials`.
    pub materials: Vec<Material>,
    /// Closed member `solids`.
    pub solids: Vec<Solid>,
}

/// Installed `RGBRequest` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RGBRequest {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `scope`.
    #[serde(deserialize_with = "decode_rgbrequest_scope")]
    pub scope: String,
    /// Closed member `position`.
    pub position: Vec3,
    /// Closed member `publication_period_ticks`.
    pub publication_period_ticks: u64,
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_rgbrequest_kind")]
    pub kind: String,
    /// Closed member `target`.
    pub target: Vec3,
    /// Closed member `width`.
    pub width: u64,
    /// Closed member `height`.
    pub height: u64,
    /// Closed member `fov_degrees`.
    pub fov_degrees: Finite64,
    /// Closed member `rendering_mode`.
    #[serde(deserialize_with = "decode_rgbrequest_rendering_mode")]
    pub rendering_mode: String,
}

/// Installed `ThermalRequest` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ThermalRequest {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `scope`.
    #[serde(deserialize_with = "decode_thermal_request_scope")]
    pub scope: String,
    /// Closed member `position`.
    pub position: Vec3,
    /// Closed member `publication_period_ticks`.
    pub publication_period_ticks: u64,
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_thermal_request_kind")]
    pub kind: String,
    /// Closed member `target`.
    pub target: Vec3,
    /// Closed member `width`.
    pub width: u64,
    /// Closed member `height`.
    pub height: u64,
    /// Closed member `fov_degrees`.
    pub fov_degrees: Finite64,
    /// Closed member `rendering_mode`.
    #[serde(deserialize_with = "decode_thermal_request_rendering_mode")]
    pub rendering_mode: String,
}

/// Installed `PressureRequest` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PressureRequest {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `scope`.
    #[serde(deserialize_with = "decode_pressure_request_scope")]
    pub scope: String,
    /// Closed member `position`.
    pub position: Vec3,
    /// Closed member `publication_period_ticks`.
    pub publication_period_ticks: u64,
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_pressure_request_kind")]
    pub kind: String,
    /// Closed member `sample_rate_hz`.
    #[serde(deserialize_with = "decode_pressure_request_sample_rate_hz")]
    pub sample_rate_hz: u64,
    /// Closed member `observation_model`.
    #[serde(deserialize_with = "decode_pressure_request_observation_model")]
    pub observation_model: String,
}

/// Installed `SourceRequest` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum SourceRequest {
    /// The closed `RGBRequest` variant.
    RGBRequest(Box<RGBRequest>),
    /// The closed `ThermalRequest` variant.
    ThermalRequest(Box<ThermalRequest>),
    /// The closed `PressureRequest` variant.
    PressureRequest(Box<PressureRequest>),
}

/// Installed `Prepare` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Prepare {
    /// Closed member `schema`.
    #[serde(deserialize_with = "decode_prepare_schema")]
    pub schema: String,
    /// Closed member `composition_digest`.
    pub composition_digest: String,
    /// Closed member `resource_plan_digest`.
    pub resource_plan_digest: String,
    /// Closed member `world`.
    pub world: World,
    /// Closed member `scene`.
    pub scene: Scene,
    /// Closed member `sources`.
    pub sources: Vec<SourceRequest>,
    /// Closed member `acoustic`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acoustic: Option<Acoustic>,
    /// Closed member `thermal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thermal: Option<Thermal>,
}

/// Installed `Target` record; relational admission remains separate.
pub type Target = [Finite64; 4];

/// Installed `SetRow` record; relational admission remains separate.
pub type SetRow = (u64, String, bool, Target);

/// Installed `HoldRow` record; relational admission remains separate.
pub type HoldRow = (u64, String, String);

/// Installed `ControlRow` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ControlRow {
    /// The closed `SetRow` variant.
    SetRow(SetRow),
    /// The closed `HoldRow` variant.
    HoldRow(HoldRow),
}

/// Installed `Advance` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Advance {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_advance_kind")]
    pub kind: String,
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `roster_digest`.
    pub roster_digest: String,
    /// Closed member `tick`.
    pub tick: u64,
    /// Closed member `previous_batch_digest`.
    pub previous_batch_digest: Option<String>,
    /// Closed member `rows`.
    pub rows: Vec<ControlRow>,
}

/// Installed `ExportSource` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ExportSource {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_export_source_kind")]
    pub kind: String,
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `batch_digest`.
    pub batch_digest: String,
    /// Closed member `source_body_tick`.
    pub source_body_tick: u64,
    /// Closed member `source_production_digest`.
    pub source_production_digest: String,
    /// Closed member `original_payload_sha256`.
    pub original_payload_sha256: String,
}

/// Installed `ReleaseBatch` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ReleaseBatch {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_release_batch_kind")]
    pub kind: String,
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `batch_digest`.
    pub batch_digest: String,
    /// Closed member `tick`.
    pub tick: u64,
}

/// Installed `Command` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum CityCommand {
    /// The closed `Advance` variant.
    Advance(Box<Advance>),
    /// The closed `ExportSource` variant.
    ExportSource(Box<ExportSource>),
    /// The closed `ReleaseBatch` variant.
    ReleaseBatch(Box<ReleaseBatch>),
}

/// Installed `NotDue` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NotDue {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `status`.
    #[serde(deserialize_with = "decode_not_due_status")]
    pub status: String,
    /// Closed member `next_due_tick`.
    pub next_due_tick: Option<u64>,
}

/// Installed `Produced` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Produced {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `status`.
    #[serde(deserialize_with = "decode_produced_status")]
    pub status: String,
    /// Closed member `source_config_digest`.
    pub source_config_digest: String,
    /// Closed member `source_body_tick`.
    pub source_body_tick: u64,
    /// Closed member `available_after_body_tick`.
    pub available_after_body_tick: u64,
    /// Closed member `source_production_digest`.
    pub source_production_digest: String,
    /// Closed member `original_payload_sha256`.
    pub original_payload_sha256: String,
    /// Closed member `byte_length`.
    pub byte_length: u64,
    /// Closed member `tensor`.
    pub tensor: Tensor,
}

/// Installed `Failed` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Failed {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `status`.
    #[serde(deserialize_with = "decode_failed_status")]
    pub status: String,
    /// Closed member `attempted_at_tick`.
    pub attempted_at_tick: u64,
    /// Closed member `reason`.
    #[serde(deserialize_with = "decode_failed_reason")]
    pub reason: String,
    /// Closed member `diagnostic`.
    pub diagnostic: String,
}

/// Installed `Absent` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Absent {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `status`.
    #[serde(deserialize_with = "decode_absent_status")]
    pub status: String,
    /// Closed member `due_at_tick`.
    pub due_at_tick: u64,
    /// Closed member `reason`.
    #[serde(deserialize_with = "decode_absent_reason")]
    pub reason: String,
    /// Closed member `causal_failed_request_id`.
    pub causal_failed_request_id: String,
}

/// Installed `SourceOutcome` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum SourceOutcome {
    /// The closed `NotDue` variant.
    NotDue(Box<NotDue>),
    /// The closed `Produced` variant.
    Produced(Box<Produced>),
    /// The closed `Failed` variant.
    Failed(Box<Failed>),
    /// The closed `Absent` variant.
    Absent(Box<Absent>),
}

/// Installed `AppliedRow` record; relational admission remains separate.
pub type AppliedRow = (u64, String, String, bool);

/// Installed `ControlReceipt` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ControlReceipt {
    /// Closed member `tick`.
    pub tick: u64,
    /// Closed member `execution`.
    #[serde(deserialize_with = "decode_control_receipt_execution")]
    pub execution: String,
    /// Closed member `before_state_sha256`.
    pub before_state_sha256: String,
    /// Closed member `after_state_sha256`.
    pub after_state_sha256: String,
    /// Closed member `native_transition_sha256`.
    pub native_transition_sha256: String,
    /// Closed member `all_motor_assignments_completed`.
    #[serde(deserialize_with = "decode_control_receipt_all_motor_assignments_completed")]
    pub all_motor_assignments_completed: bool,
    /// Closed member `rows`.
    pub rows: Vec<AppliedRow>,
}

/// Installed `Batch` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `roster_digest`.
    pub roster_digest: String,
    /// Closed member `scene_sha256`.
    pub scene_sha256: String,
    /// Closed member `source_catalog_digest`.
    pub source_catalog_digest: String,
    /// Closed member `tick`.
    pub tick: u64,
    /// Closed member `previous_batch_digest`.
    pub previous_batch_digest: Option<String>,
    /// Closed member `control`.
    pub control: ControlReceipt,
    /// Closed member `slots`.
    pub slots: Vec<SourceOutcome>,
    /// Closed member `batch_digest`.
    pub batch_digest: String,
}

/// Installed `Prepared` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_prepared_kind")]
    pub kind: String,
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `roster_digest`.
    pub roster_digest: String,
    /// Closed member `scene_sha256`.
    pub scene_sha256: String,
    /// Closed member `source_catalog_digest`.
    pub source_catalog_digest: String,
    /// Closed member `resource_plan_digest`.
    pub resource_plan_digest: String,
    /// Closed member `source_identity`.
    pub source_identity: String,
    /// Closed member `engine_owner_id`.
    pub engine_owner_id: String,
    /// Closed member `native_plan_sha256`.
    pub native_plan_sha256: String,
}

/// Installed `Advanced` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Advanced {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_advanced_kind")]
    pub kind: String,
    /// Closed member `batch`.
    pub batch: Batch,
}

/// Installed `AdvanceFailed` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AdvanceFailed {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_advance_failed_kind")]
    pub kind: String,
    /// Closed member `batch`.
    pub batch: Batch,
    /// Closed member `native_retirement`.
    #[serde(deserialize_with = "decode_advance_failed_native_retirement")]
    pub native_retirement: String,
    /// Closed member `physical_advance_allowed`.
    #[serde(deserialize_with = "decode_advance_failed_physical_advance_allowed")]
    pub physical_advance_allowed: bool,
    /// Closed member `successful_finish_allowed`.
    #[serde(deserialize_with = "decode_advance_failed_successful_finish_allowed")]
    pub successful_finish_allowed: bool,
}

/// Installed `SourceManifest` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SourceManifest {
    /// Closed member `request_id`.
    pub request_id: String,
    /// Closed member `source_id`.
    pub source_id: String,
    /// Closed member `entity_index`.
    pub entity_index: u64,
    /// Closed member `schema`.
    #[serde(deserialize_with = "decode_source_manifest_schema")]
    pub schema: String,
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `scene_sha256`.
    pub scene_sha256: String,
    /// Closed member `source_catalog_digest`.
    pub source_catalog_digest: String,
    /// Closed member `source_config_digest`.
    pub source_config_digest: String,
    /// Closed member `batch_digest`.
    pub batch_digest: String,
    /// Closed member `source_body_tick`.
    pub source_body_tick: u64,
    /// Closed member `available_after_body_tick`.
    pub available_after_body_tick: u64,
    /// Closed member `source_production_digest`.
    pub source_production_digest: String,
    /// Closed member `original_payload_sha256`.
    pub original_payload_sha256: String,
    /// Closed member `byte_manifest_digest`.
    pub byte_manifest_digest: String,
    /// Closed member `tensor`.
    pub tensor: Tensor,
    /// Closed member `manifest_digest`.
    pub manifest_digest: String,
}

/// Installed `Exported` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Exported {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_exported_kind")]
    pub kind: String,
    /// Closed member `typed_manifest`.
    pub typed_manifest: SourceManifest,
    /// Closed member `byte_manifest`.
    pub byte_manifest: BufferManifest,
}

/// Installed `BatchReleased` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BatchReleased {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_batch_released_kind")]
    pub kind: String,
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `batch_digest`.
    pub batch_digest: String,
    /// Closed member `tick`.
    pub tick: u64,
}

/// Installed `Result` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum CityResult {
    /// The closed `Prepared` variant.
    Prepared(Box<Prepared>),
    /// The closed `Advanced` variant.
    Advanced(Box<Advanced>),
    /// The closed `AdvanceFailed` variant.
    AdvanceFailed(Box<AdvanceFailed>),
    /// The closed `Exported` variant.
    Exported(Box<Exported>),
    /// The closed `BatchReleased` variant.
    BatchReleased(Box<BatchReleased>),
}

/// Installed `Finish` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `completed_ticks`.
    pub completed_ticks: u64,
    /// Closed member `last_released_batch_digest`.
    pub last_released_batch_digest: String,
}

/// Installed `Terminal` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Terminal {
    /// Closed member `plan_digest`.
    pub plan_digest: String,
    /// Closed member `completed_ticks`.
    pub completed_ticks: u64,
    /// Closed member `last_released_batch_digest`.
    pub last_released_batch_digest: String,
    /// Closed member `native_retirement`.
    #[serde(deserialize_with = "decode_terminal_native_retirement")]
    pub native_retirement: String,
    /// Closed member `promised_source_output`.
    #[serde(deserialize_with = "decode_terminal_promised_source_output")]
    pub promised_source_output: String,
    /// Closed member `scientific_validation`.
    #[serde(deserialize_with = "decode_terminal_scientific_validation")]
    pub scientific_validation: bool,
}

/// Installed `ImportDescriptor` record; relational admission remains separate.
pub type ImportDescriptor = Never;

/// Installed `ImportMetadata` record; relational admission remains separate.
pub type ImportMetadata = Never;

/// Installed `Imported` record; relational admission remains separate.
pub type Imported = Never;

/// Installed `RgbaTensor` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RgbaTensor {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_rgba_tensor_kind")]
    pub kind: String,
    /// Closed member `dtype`.
    #[serde(deserialize_with = "decode_rgba_tensor_dtype")]
    pub dtype: String,
    /// Closed member `shape`.
    pub shape: [u64; 3],
    /// Closed member `layout`.
    #[serde(deserialize_with = "decode_rgba_tensor_layout")]
    pub layout: String,
    /// Closed member `row_origin`.
    #[serde(deserialize_with = "decode_rgba_tensor_row_origin")]
    pub row_origin: String,
    /// Closed member `encoding`.
    #[serde(deserialize_with = "decode_rgba_tensor_encoding")]
    pub encoding: String,
}

/// Installed `RadianceTensor` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RadianceTensor {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_radiance_tensor_kind")]
    pub kind: String,
    /// Closed member `dtype`.
    #[serde(deserialize_with = "decode_radiance_tensor_dtype")]
    pub dtype: String,
    /// Closed member `shape`.
    pub shape: [u64; 2],
    /// Closed member `layout`.
    #[serde(deserialize_with = "decode_radiance_tensor_layout")]
    pub layout: String,
    /// Closed member `row_origin`.
    #[serde(deserialize_with = "decode_radiance_tensor_row_origin")]
    pub row_origin: String,
    /// Closed member `unit`.
    #[serde(deserialize_with = "decode_radiance_tensor_unit")]
    pub unit: String,
}

/// Installed `PressureTensor` record; relational admission remains separate.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PressureTensor {
    /// Closed member `kind`.
    #[serde(deserialize_with = "decode_pressure_tensor_kind")]
    pub kind: String,
    /// Closed member `dtype`.
    #[serde(deserialize_with = "decode_pressure_tensor_dtype")]
    pub dtype: String,
    /// Closed member `shape`.
    pub shape: [u64; 1],
    /// Closed member `layout`.
    #[serde(deserialize_with = "decode_pressure_tensor_layout")]
    pub layout: String,
    /// Closed member `sample_start`.
    pub sample_start: u64,
    /// Closed member `sample_end`.
    pub sample_end: u64,
    /// Closed member `sample_rate_hz`.
    #[serde(deserialize_with = "decode_pressure_tensor_sample_rate_hz")]
    pub sample_rate_hz: u64,
    /// Closed member `unit`.
    #[serde(deserialize_with = "decode_pressure_tensor_unit")]
    pub unit: String,
}

fn decode_acoustic_profile<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "crebain.discrete-direct-acoustic.v1" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_acoustic_sample_rate_hz<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<u64, D::Error> {
    let value = <u64 as Deserialize>::deserialize(input)?;
    if value == 16000 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_acoustic_blade_count<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<u64, D::Error> {
    let value = <u64 as Deserialize>::deserialize(input)?;
    if value == 2 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_thermal_profile<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "crebain.lumped-gray-thermal.v1" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_world_profile<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "crebain.rapier-force-city.v1" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_world_engine_model<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "rapier-0.19.3-observed-no-gyro-v1" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_world_frame<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "three-y-up-z-forward-m" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_rgbrequest_scope<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "entity_requested_world_fixed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_rgbrequest_kind<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "rgb" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_rgbrequest_rendering_mode<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "mesh_and_authored_gaussians" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_thermal_request_scope<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "entity_requested_world_fixed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_thermal_request_kind<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "thermal" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_thermal_request_rendering_mode<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "bolometric_mesh" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_request_scope<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "entity_requested_world_fixed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_request_kind<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "pressure" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_request_sample_rate_hz<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<u64, D::Error> {
    let value = <u64 as Deserialize>::deserialize(input)?;
    if value == 16000 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_request_observation_model<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "crebain.discrete-direct-acoustic.v1" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_prepare_schema<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "crebain.force-city-prepare.v1" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_advance_kind<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "advance" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_export_source_kind<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "export_source" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_release_batch_kind<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "release_batch" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_not_due_status<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "not_due" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_produced_status<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "produced" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_failed_status<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "failed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_failed_reason<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "acquisition_failed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_absent_status<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "absent" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_absent_reason<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "not_attempted_after_failure" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_control_receipt_execution<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "known_completed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_control_receipt_all_motor_assignments_completed<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<bool, D::Error> {
    let value = <bool as Deserialize>::deserialize(input)?;
    if value {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_prepared_kind<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "prepared" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_advanced_kind<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "advanced" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_advance_failed_kind<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "advance_failed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_advance_failed_native_retirement<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "confirmed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_advance_failed_physical_advance_allowed<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<bool, D::Error> {
    let value = <bool as Deserialize>::deserialize(input)?;
    if !value {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_advance_failed_successful_finish_allowed<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<bool, D::Error> {
    let value = <bool as Deserialize>::deserialize(input)?;
    if !value {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_source_manifest_schema<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "crebain.force-city-source-manifest.v1" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_exported_kind<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "source_exported" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_batch_released_kind<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "batch_released" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_terminal_native_retirement<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "confirmed" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_terminal_promised_source_output<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "complete" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_terminal_scientific_validation<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<bool, D::Error> {
    let value = <bool as Deserialize>::deserialize(input)?;
    if !value {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_rgba_tensor_kind<'de, D: serde::Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "rgba8" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_rgba_tensor_dtype<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "u8" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_rgba_tensor_layout<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "c_contiguous" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_rgba_tensor_row_origin<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "bottom-left" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_rgba_tensor_encoding<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "rgba8-srgb" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_radiance_tensor_kind<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "radiance" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_radiance_tensor_dtype<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "f32le" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_radiance_tensor_layout<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "c_contiguous" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_radiance_tensor_row_origin<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "bottom-left" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_radiance_tensor_unit<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "W/(m2 sr)" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_tensor_kind<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "pressure" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_tensor_dtype<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "f64le" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_tensor_layout<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "c_contiguous" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_tensor_sample_rate_hz<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<u64, D::Error> {
    let value = <u64 as Deserialize>::deserialize(input)?;
    if value == 16000 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}

fn decode_pressure_tensor_unit<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> Result<String, D::Error> {
    let value = <String as Deserialize>::deserialize(input)?;
    if value == "pascal" {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("closed city constant"))
    }
}
