//! Fixed application DTOs generated from `contracts/application.schema.v1.json`.
use crate::Finite64;
use ncp_local::modular_buffer::BufferManifest;
use serde::{Deserialize, Serialize};

/// Uninhabited import and forbidden scene-solid payload.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum Never {}

/// Closed installed `Vec3` value; semantic bounds remain in the owning schema.
pub type Vec3 = [Finite64; 3];

/// Closed installed `Camera` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Camera {
    /// Closed schema member `id`.
    pub id: String,
    /// Closed schema member `position`.
    pub position: Vec3,
    /// Closed schema member `target`.
    pub target: Vec3,
    /// Closed schema member `width`.
    pub width: u64,
    /// Closed schema member `height`.
    pub height: u64,
    /// Closed schema member `fovDegrees`.
    #[serde(rename = "fovDegrees")]
    pub fov_degrees: Finite64,
    /// Closed schema member `periodTicks`.
    #[serde(rename = "periodTicks")]
    pub period_ticks: u64,
}

/// Closed installed `Microphone` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Microphone {
    /// Closed schema member `id`.
    pub id: String,
    /// Closed schema member `position`.
    pub position: Vec3,
}

/// Closed installed `Material` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Material {
    /// Closed schema member `id`.
    pub id: String,
    /// Closed schema member `linearRgb`.
    #[serde(rename = "linearRgb")]
    pub linear_rgb: [Finite64; 3],
    /// Closed schema member `gaussianOpacity`.
    #[serde(rename = "gaussianOpacity")]
    pub gaussian_opacity: Finite64,
    /// Closed schema member `temperatureK`.
    #[serde(rename = "temperatureK")]
    pub temperature_k: Finite64,
    /// Closed schema member `emissivity`.
    pub emissivity: Finite64,
}

/// Closed installed `Scene` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    /// Closed schema member `profile`.
    pub profile: String,
    /// Closed schema member `id`.
    pub id: String,
    /// Closed schema member `frame`.
    pub frame: String,
    /// Closed schema member `solids`.
    pub solids: Vec<Never>,
    /// Closed schema member `materials`.
    pub materials: Vec<Material>,
    /// Closed schema member `rgbCameras`.
    #[serde(rename = "rgbCameras")]
    pub rgb_cameras: Vec<Camera>,
    /// Closed schema member `thermalCameras`.
    #[serde(rename = "thermalCameras")]
    pub thermal_cameras: Vec<Camera>,
    /// Closed schema member `microphones`.
    pub microphones: Vec<Microphone>,
}

/// Closed installed `Acoustic` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Acoustic {
    /// Closed schema member `profile`.
    pub profile: String,
    /// Closed schema member `sampleRateHz`.
    #[serde(rename = "sampleRateHz")]
    pub sample_rate_hz: u64,
    /// Closed schema member `soundSpeedMps`.
    #[serde(rename = "soundSpeedMps")]
    pub sound_speed_mps: Finite64,
    /// Closed schema member `maximumRangeM`.
    #[serde(rename = "maximumRangeM")]
    pub maximum_range_m: Finite64,
    /// Closed schema member `referenceDistanceM`.
    #[serde(rename = "referenceDistanceM")]
    pub reference_distance_m: Finite64,
    /// Closed schema member `referencePressurePa`.
    #[serde(rename = "referencePressurePa")]
    pub reference_pressure_pa: Finite64,
    /// Closed schema member `bladeCount`.
    #[serde(rename = "bladeCount")]
    pub blade_count: u64,
    /// Closed schema member `blockedGain`.
    #[serde(rename = "blockedGain")]
    pub blocked_gain: Finite64,
    /// Closed schema member `noiseStdPa`.
    #[serde(rename = "noiseStdPa")]
    pub noise_std_pa: Finite64,
    /// Closed schema member `seed`.
    pub seed: u64,
}

/// Closed installed `Thermal` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Thermal {
    /// Closed schema member `profile`.
    pub profile: String,
    /// Closed schema member `ambientK`.
    #[serde(rename = "ambientK")]
    pub ambient_k: Finite64,
    /// Closed schema member `initialK`.
    #[serde(rename = "initialK")]
    pub initial_k: Finite64,
    /// Closed schema member `capacityJPerK`.
    #[serde(rename = "capacityJPerK")]
    pub capacity_j_per_k: Finite64,
    /// Closed schema member `areaM2`.
    #[serde(rename = "areaM2")]
    pub area_m2: Finite64,
    /// Closed schema member `convectionWPerM2K`.
    #[serde(rename = "convectionWPerM2K")]
    pub convection_w_per_m2_k: Finite64,
    /// Closed schema member `emissivity`.
    pub emissivity: Finite64,
    /// Closed schema member `motorEfficiency`.
    #[serde(rename = "motorEfficiency")]
    pub motor_efficiency: Finite64,
}

/// Closed installed `Controller` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Controller {
    /// Closed schema member `engineModel`.
    #[serde(rename = "engineModel")]
    pub engine_model: String,
    /// Closed schema member `referenceAltitudeM`.
    #[serde(rename = "referenceAltitudeM")]
    pub reference_altitude_m: Finite64,
    /// Closed schema member `referenceHeadingRad`.
    #[serde(rename = "referenceHeadingRad")]
    pub reference_heading_rad: Finite64,
}

/// Closed installed `Drone` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Drone {
    /// Closed schema member `id`.
    pub id: String,
    /// Closed schema member `position`.
    pub position: Vec3,
}

/// Closed installed `Specification` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Specification {
    /// Closed schema member `profile`.
    pub profile: String,
    /// Closed schema member `seed`.
    pub seed: u64,
    /// Closed schema member `drones`.
    pub drones: [Drone; 1],
    /// Closed schema member `scene`.
    pub scene: Scene,
    /// Closed schema member `acoustic`.
    pub acoustic: Acoustic,
    /// Closed schema member `thermal`.
    pub thermal: Thermal,
    /// Closed schema member `controller`.
    pub controller: Controller,
}

/// Closed installed `Prepare` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Prepare {
    /// Closed schema member `specification`.
    pub specification: Specification,
    /// Closed schema member `planned_ticks`.
    pub planned_ticks: u64,
    /// Closed schema member `composition_digest`.
    pub composition_digest: String,
}

/// Closed installed `SetTarget` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SetTarget {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `armed`.
    pub armed: bool,
    /// Closed schema member `roll_rad`.
    pub roll_rad: Finite64,
    /// Closed schema member `pitch_rad`.
    pub pitch_rad: Finite64,
    /// Closed schema member `heading_rad`.
    pub heading_rad: Finite64,
    /// Closed schema member `altitude_m`.
    pub altitude_m: Finite64,
}

/// Closed installed `Hold` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Hold {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `accepted_action_request_digest`.
    pub accepted_action_request_digest: String,
}

/// Closed installed `Action` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Action {
    /// Closed `set_target` variant.
    #[serde(rename = "set_target")]
    SetTarget {
        /// Closed schema member `armed`.
        armed: bool,
        /// Closed schema member `roll_rad`.
        roll_rad: Finite64,
        /// Closed schema member `pitch_rad`.
        pitch_rad: Finite64,
        /// Closed schema member `heading_rad`.
        heading_rad: Finite64,
        /// Closed schema member `altitude_m`.
        altitude_m: Finite64,
    },
    /// Closed `hold` variant.
    #[serde(rename = "hold")]
    Hold {
        /// Closed schema member `accepted_action_request_digest`.
        accepted_action_request_digest: String,
    },
}

/// Closed installed `AdvanceTick` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AdvanceTick {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `tick`.
    pub tick: u64,
    /// Closed schema member `previous_batch_digest`.
    pub previous_batch_digest: Option<String>,
    /// Closed schema member `action`.
    pub action: Action,
    /// Closed schema member `capture_reservation`.
    pub capture_reservation: AdvanceTickCaptureReservation,
}

/// Closed installed `Finish` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Finish {
    /// Closed schema member `plan_digest`.
    pub plan_digest: String,
    /// Closed schema member `completed_ticks`.
    pub completed_ticks: u64,
    /// Closed schema member `last_batch_digest`.
    pub last_batch_digest: String,
}

/// Closed installed `PressureConfiguration` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PressureConfiguration {
    /// Closed schema member `position`.
    pub position: Vec3,
    /// Closed schema member `acoustic`.
    pub acoustic: Acoustic,
}

/// Closed installed `CatalogEntry` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum CatalogEntry {
    /// Closed `rgba8` variant.
    #[serde(rename = "rgba8")]
    Rgba8 {
        /// Closed schema member `sensor_id`.
        sensor_id: String,
        /// Closed schema member `source_id`.
        source_id: String,
        /// Closed schema member `sensor_contract_digest`.
        sensor_contract_digest: String,
        /// Closed schema member `configuration`.
        configuration: Camera,
    },
    /// Closed `radiance` variant.
    #[serde(rename = "radiance")]
    Radiance {
        /// Closed schema member `sensor_id`.
        sensor_id: String,
        /// Closed schema member `source_id`.
        source_id: String,
        /// Closed schema member `sensor_contract_digest`.
        sensor_contract_digest: String,
        /// Closed schema member `configuration`.
        configuration: Camera,
    },
    /// Closed `pressure` variant.
    #[serde(rename = "pressure")]
    Pressure {
        /// Closed schema member `sensor_id`.
        sensor_id: String,
        /// Closed schema member `source_id`.
        source_id: String,
        /// Closed schema member `sensor_contract_digest`.
        sensor_contract_digest: String,
        /// Closed schema member `configuration`.
        configuration: PressureConfiguration,
    },
}

/// Closed installed `SensorCatalog` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SensorCatalog {
    /// Closed schema member `schema`.
    pub schema: String,
    /// Closed schema member `plan_digest`.
    pub plan_digest: String,
    /// Closed schema member `entries`.
    pub entries: Vec<CatalogEntry>,
    /// Closed schema member `catalog_digest`.
    pub catalog_digest: String,
}

/// Closed installed `Tensor` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Tensor {
    /// Closed `rgba8` variant.
    #[serde(rename = "rgba8")]
    Rgba8 {
        /// Closed schema member `dtype`.
        dtype: String,
        /// Closed schema member `shape`.
        shape: [u64; 3],
        /// Closed schema member `layout`.
        layout: String,
        /// Closed schema member `row_origin`.
        row_origin: String,
        /// Closed schema member `encoding`.
        encoding: String,
    },
    /// Closed `radiance` variant.
    #[serde(rename = "radiance")]
    Radiance {
        /// Closed schema member `dtype`.
        dtype: String,
        /// Closed schema member `shape`.
        shape: [u64; 2],
        /// Closed schema member `layout`.
        layout: String,
        /// Closed schema member `row_origin`.
        row_origin: String,
        /// Closed schema member `unit`.
        unit: String,
    },
    /// Closed `pressure` variant.
    #[serde(rename = "pressure")]
    Pressure {
        /// Closed schema member `dtype`.
        dtype: String,
        /// Closed schema member `shape`.
        shape: [u64; 1],
        /// Closed schema member `layout`.
        layout: String,
        /// Closed schema member `sample_start`.
        sample_start: u64,
        /// Closed schema member `sample_end`.
        sample_end: u64,
        /// Closed schema member `sample_rate_hz`.
        sample_rate_hz: u64,
        /// Closed schema member `unit`.
        unit: String,
    },
}

/// Closed installed `SensorManifest` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SensorManifest {
    /// Closed schema member `schema`.
    pub schema: String,
    /// Closed schema member `sensor_contract_digest`.
    pub sensor_contract_digest: String,
    /// Closed schema member `sensor_id`.
    pub sensor_id: String,
    /// Closed schema member `byte_manifest_digest`.
    pub byte_manifest_digest: String,
    /// Closed schema member `engine_batch_sha256`.
    pub engine_batch_sha256: String,
    /// Closed schema member `source_body_tick`.
    pub source_body_tick: u64,
    /// Closed schema member `available_after_body_tick`.
    pub available_after_body_tick: u64,
    /// Closed schema member `tensor`.
    pub tensor: Tensor,
    /// Closed schema member `manifest_digest`.
    pub manifest_digest: String,
}

/// Closed installed `SensorSlot` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SensorSlot {
    /// Closed `due` variant.
    #[serde(rename = "due")]
    Due {
        /// Closed schema member `sensor_id`.
        sensor_id: String,
        /// Closed schema member `typed_manifest`.
        typed_manifest: Box<SensorManifest>,
        /// Closed schema member `byte_manifest`.
        byte_manifest: Box<BufferManifest>,
    },
    /// Closed `not_due` variant.
    #[serde(rename = "not_due")]
    NotDue {
        /// Closed schema member `sensor_id`.
        sensor_id: String,
        /// Closed schema member `next_due_tick`.
        next_due_tick: Option<u64>,
    },
}

/// Closed installed `SensorBatch` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SensorBatch {
    /// Closed schema member `schema`.
    pub schema: String,
    /// Closed schema member `plan_digest`.
    pub plan_digest: String,
    /// Closed schema member `engine_owner_id`.
    pub engine_owner_id: String,
    /// Closed schema member `engine_batch_sha256`.
    pub engine_batch_sha256: String,
    /// Closed schema member `source_identity`.
    pub source_identity: String,
    /// Closed schema member `scene_sha256`.
    pub scene_sha256: String,
    /// Closed schema member `body_tick`.
    pub body_tick: u64,
    /// Closed schema member `previous_batch_digest`.
    pub previous_batch_digest: Option<String>,
    /// Closed schema member `slots`.
    pub slots: Vec<SensorSlot>,
    /// Closed schema member `batch_digest`.
    pub batch_digest: String,
}

/// Closed installed `Prepared` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Prepared {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `plan_digest`.
    pub plan_digest: String,
    /// Closed schema member `sensor_catalog`.
    pub sensor_catalog: SensorCatalog,
    /// Closed schema member `initial_observation`.
    pub initial_observation: String,
    /// Closed schema member `source_identity`.
    pub source_identity: String,
    /// Closed schema member `engine_owner_id`.
    pub engine_owner_id: String,
    /// Closed schema member `scene_sha256`.
    pub scene_sha256: String,
}

/// Closed installed `Advanced` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Advanced {
    /// Closed schema member `kind`.
    pub kind: String,
    /// Closed schema member `tick`.
    pub tick: u64,
    /// Closed schema member `accepted_action_request_digest`.
    pub accepted_action_request_digest: String,
    /// Closed schema member `batch`.
    pub batch: SensorBatch,
}

/// Closed installed `SensorResult` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SensorResult {
    /// Closed `prepared` variant.
    #[serde(rename = "prepared")]
    Prepared {
        /// Closed schema member `plan_digest`.
        plan_digest: String,
        /// Closed schema member `sensor_catalog`.
        sensor_catalog: SensorCatalog,
        /// Closed schema member `initial_observation`.
        initial_observation: String,
        /// Closed schema member `source_identity`.
        source_identity: String,
        /// Closed schema member `engine_owner_id`.
        engine_owner_id: String,
        /// Closed schema member `scene_sha256`.
        scene_sha256: String,
    },
    /// Closed `advanced` variant.
    #[serde(rename = "advanced")]
    Advanced {
        /// Closed schema member `tick`.
        tick: u64,
        /// Closed schema member `accepted_action_request_digest`.
        accepted_action_request_digest: String,
        /// Closed schema member `batch`.
        batch: SensorBatch,
    },
}

/// Closed installed `Terminal` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Terminal {
    /// Closed schema member `plan_digest`.
    pub plan_digest: String,
    /// Closed schema member `planned_ticks`.
    pub planned_ticks: u64,
    /// Closed schema member `completed_ticks`.
    pub completed_ticks: u64,
    /// Closed schema member `last_batch_digest`.
    pub last_batch_digest: String,
    /// Closed schema member `engine_retirement`.
    pub engine_retirement: String,
    /// Closed schema member `promised_sensor_output`.
    pub promised_sensor_output: String,
    /// Closed schema member `scientific_validation`.
    pub scientific_validation: bool,
}

/// Closed installed `ImportDescriptor` value; semantic bounds remain in the owning schema.
pub type ImportDescriptor = Never;

/// Closed installed `ImportMetadata` value; semantic bounds remain in the owning schema.
pub type ImportMetadata = Never;

/// Closed installed `Imported` value; semantic bounds remain in the owning schema.
pub type Imported = Never;

/// Closed installed `AdvanceTickCaptureReservation` value; semantic bounds remain in the owning schema.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AdvanceTickCaptureReservation {
    /// Closed schema member `kind`.
    pub kind: String,
}
