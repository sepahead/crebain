"""Immutable application values. Buffer ownership remains with the NCP SDK."""

from dataclasses import dataclass

from ncp_local.modular_buffer import BufferBinding, BufferManifest

Vec3 = tuple[float, float, float]


@dataclass(frozen=True, slots=True)
class Camera:
    id: str
    position: Vec3
    target: Vec3
    width: int
    height: int
    fovDegrees: float
    periodTicks: int


@dataclass(frozen=True, slots=True)
class Microphone:
    id: str
    position: Vec3


@dataclass(frozen=True, slots=True)
class Material:
    id: str
    linearRgb: Vec3
    gaussianOpacity: float
    temperatureK: float
    emissivity: float


@dataclass(frozen=True, slots=True)
class Scene:
    profile: str
    id: str
    frame: str
    solids: tuple[()]
    materials: tuple[Material, ...]
    rgbCameras: tuple[Camera, ...]
    thermalCameras: tuple[Camera, ...]
    microphones: tuple[Microphone, ...]


@dataclass(frozen=True, slots=True)
class Acoustic:
    profile: str
    sampleRateHz: int
    soundSpeedMps: float
    maximumRangeM: float
    referenceDistanceM: float
    referencePressurePa: float
    bladeCount: int
    blockedGain: float
    noiseStdPa: float
    seed: int


@dataclass(frozen=True, slots=True)
class Thermal:
    profile: str
    ambientK: float
    initialK: float
    capacityJPerK: float
    areaM2: float
    convectionWPerM2K: float
    emissivity: float
    motorEfficiency: float


@dataclass(frozen=True, slots=True)
class Controller:
    engineModel: str
    referenceAltitudeM: float
    referenceHeadingRad: float


@dataclass(frozen=True, slots=True)
class Drone:
    id: str
    position: Vec3


@dataclass(frozen=True, slots=True)
class Specification:
    profile: str
    seed: int
    drones: tuple[Drone, ...]
    scene: Scene
    acoustic: Acoustic
    thermal: Thermal
    controller: Controller


@dataclass(frozen=True, slots=True)
class Prepare:
    specification: Specification
    planned_ticks: int
    composition_digest: str


@dataclass(frozen=True, slots=True)
class SetTarget:
    kind: str
    armed: bool
    roll_rad: float
    pitch_rad: float
    heading_rad: float
    altitude_m: float


@dataclass(frozen=True, slots=True)
class Hold:
    kind: str
    accepted_action_request_digest: str


@dataclass(frozen=True, slots=True)
class CaptureReservation:
    kind: str = "absent"


@dataclass(frozen=True, slots=True)
class Command:
    kind: str
    tick: int
    previous_batch_digest: str | None
    action: SetTarget | Hold
    capture_reservation: CaptureReservation


@dataclass(frozen=True, slots=True)
class Finish:
    plan_digest: str
    completed_ticks: int
    last_batch_digest: str


@dataclass(frozen=True, slots=True)
class PressureConfiguration:
    position: Vec3
    acoustic: Acoustic


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    kind: str
    sensor_id: str
    source_id: str
    sensor_contract_digest: str
    configuration: Camera | PressureConfiguration


@dataclass(frozen=True, slots=True)
class SensorCatalog:
    schema: str
    plan_digest: str
    entries: tuple[CatalogEntry, ...]
    catalog_digest: str


@dataclass(frozen=True, slots=True)
class RgbaTensor:
    kind: str
    dtype: str
    shape: tuple[int, int, int]
    layout: str
    row_origin: str
    encoding: str


@dataclass(frozen=True, slots=True)
class RadianceTensor:
    kind: str
    dtype: str
    shape: tuple[int, int]
    layout: str
    row_origin: str
    unit: str


@dataclass(frozen=True, slots=True)
class PressureTensor:
    kind: str
    dtype: str
    shape: tuple[int]
    layout: str
    sample_start: int
    sample_end: int
    sample_rate_hz: int
    unit: str


Tensor = RgbaTensor | RadianceTensor | PressureTensor


@dataclass(frozen=True, slots=True)
class SensorManifest:
    schema: str
    sensor_contract_digest: str
    sensor_id: str
    byte_manifest_digest: str
    engine_batch_sha256: str
    source_body_tick: int
    available_after_body_tick: int
    tensor: Tensor
    manifest_digest: str


@dataclass(frozen=True, slots=True)
class Due:
    kind: str
    sensor_id: str
    typed_manifest: SensorManifest
    byte_manifest: BufferManifest


@dataclass(frozen=True, slots=True)
class NotDue:
    kind: str
    sensor_id: str
    next_due_tick: int | None


@dataclass(frozen=True, slots=True)
class SensorBatch:
    schema: str
    plan_digest: str
    engine_owner_id: str
    engine_batch_sha256: str
    source_identity: str
    scene_sha256: str
    body_tick: int
    previous_batch_digest: str | None
    slots: tuple[Due | NotDue, ...]
    batch_digest: str


@dataclass(frozen=True, slots=True)
class Prepared:
    kind: str
    plan_digest: str
    sensor_catalog: SensorCatalog
    initial_observation: str
    source_identity: str
    engine_owner_id: str
    scene_sha256: str


@dataclass(frozen=True, slots=True)
class Advanced:
    kind: str
    tick: int
    accepted_action_request_digest: str
    batch: SensorBatch


@dataclass(frozen=True, slots=True)
class Terminal:
    plan_digest: str
    planned_ticks: int
    completed_ticks: int
    last_batch_digest: str
    engine_retirement: str
    promised_sensor_output: str
    scientific_validation: bool


@dataclass(frozen=True, slots=True)
class SensorReading:
    """Validated metadata and the original immutable payload bytes."""

    manifest: SensorManifest
    byte_manifest: BufferManifest
    payload: bytes


@dataclass(frozen=True, slots=True)
class BatchObservation:
    """A local reading, without durable capture or scientific authority."""

    batch: SensorBatch
    readings: tuple[SensorReading, ...]


@dataclass(frozen=True, slots=True)
class SessionResult:
    prepared: Prepared
    terminal: Terminal
    raw_bytes: int
    payload_count: int
    protocol_predecessor: str
