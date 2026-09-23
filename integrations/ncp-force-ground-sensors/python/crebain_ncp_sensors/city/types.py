"""Closed immutable city records generated from the installed schema."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Never
from ncp_local.modular_buffer import BufferBinding as BufferBinding, BufferManifest

@dataclass(frozen=True, slots=True)
class Material:
    id: str
    linearRgb: tuple[float, ...]
    gaussianOpacity: float
    temperatureK: float
    emissivity: float

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
class Solid:
    id: str
    center: Vec3
    half_extents: tuple[float, ...]
    yaw: float
    friction: float
    restitution: float
    material_index: int

@dataclass(frozen=True, slots=True)
class World:
    profile: str
    engine_model: str
    frame: str
    horizon_ticks: int
    action_budget: int
    entity_ids: tuple[str, ...]
    initial_positions: tuple[Vec3, ...]
    controller_references: tuple[ControllerReference, ...]

@dataclass(frozen=True, slots=True)
class Scene:
    id: str
    materials: tuple[Material, ...]
    solids: tuple[Solid, ...]

@dataclass(frozen=True, slots=True)
class RGBRequest:
    request_id: str
    source_id: str
    entity_index: int
    scope: str
    position: Vec3
    publication_period_ticks: int
    kind: str
    target: Vec3
    width: int
    height: int
    fov_degrees: float
    rendering_mode: str

@dataclass(frozen=True, slots=True)
class ThermalRequest:
    request_id: str
    source_id: str
    entity_index: int
    scope: str
    position: Vec3
    publication_period_ticks: int
    kind: str
    target: Vec3
    width: int
    height: int
    fov_degrees: float
    rendering_mode: str

@dataclass(frozen=True, slots=True)
class PressureRequest:
    request_id: str
    source_id: str
    entity_index: int
    scope: str
    position: Vec3
    publication_period_ticks: int
    kind: str
    sample_rate_hz: int
    observation_model: str

@dataclass(frozen=True, slots=True)
class PrepareNoModels:
    schema: str
    composition_digest: str
    resource_plan_digest: str
    world: World
    scene: Scene
    sources: tuple[SourceRequest, ...]

@dataclass(frozen=True, slots=True)
class PrepareThermal:
    schema: str
    composition_digest: str
    resource_plan_digest: str
    world: World
    scene: Scene
    sources: tuple[SourceRequest, ...]
    thermal: Thermal

@dataclass(frozen=True, slots=True)
class PrepareAcoustic:
    schema: str
    composition_digest: str
    resource_plan_digest: str
    world: World
    scene: Scene
    sources: tuple[SourceRequest, ...]
    acoustic: Acoustic

@dataclass(frozen=True, slots=True)
class PrepareAcousticThermal:
    schema: str
    composition_digest: str
    resource_plan_digest: str
    world: World
    scene: Scene
    sources: tuple[SourceRequest, ...]
    acoustic: Acoustic
    thermal: Thermal

@dataclass(frozen=True, slots=True)
class Advance:
    kind: str
    plan_digest: str
    roster_digest: str
    tick: int
    previous_batch_digest: str | None
    rows: tuple[ControlRow, ...]

@dataclass(frozen=True, slots=True)
class ExportSource:
    request_id: str
    source_id: str
    entity_index: int
    kind: str
    plan_digest: str
    batch_digest: str
    source_body_tick: int
    source_production_digest: str
    original_payload_sha256: str

@dataclass(frozen=True, slots=True)
class ReleaseBatch:
    kind: str
    plan_digest: str
    batch_digest: str
    tick: int

@dataclass(frozen=True, slots=True)
class NotDue:
    request_id: str
    source_id: str
    entity_index: int
    status: str
    next_due_tick: int | None

@dataclass(frozen=True, slots=True)
class Produced:
    request_id: str
    source_id: str
    entity_index: int
    status: str
    source_config_digest: str
    source_body_tick: int
    available_after_body_tick: int
    source_production_digest: str
    original_payload_sha256: str
    byte_length: int
    tensor: Tensor

@dataclass(frozen=True, slots=True)
class Failed:
    request_id: str
    source_id: str
    entity_index: int
    status: str
    attempted_at_tick: int
    reason: str
    diagnostic: str

@dataclass(frozen=True, slots=True)
class Absent:
    request_id: str
    source_id: str
    entity_index: int
    status: str
    due_at_tick: int
    reason: str
    causal_failed_request_id: str

@dataclass(frozen=True, slots=True)
class ControlReceipt:
    tick: int
    execution: str
    before_state_sha256: str
    after_state_sha256: str
    native_transition_sha256: str
    all_motor_assignments_completed: bool
    rows: tuple[AppliedRow, ...]

@dataclass(frozen=True, slots=True)
class Batch:
    plan_digest: str
    roster_digest: str
    scene_sha256: str
    source_catalog_digest: str
    tick: int
    previous_batch_digest: str | None
    control: ControlReceipt
    slots: tuple[SourceOutcome, ...]
    batch_digest: str

@dataclass(frozen=True, slots=True)
class Prepared:
    kind: str
    plan_digest: str
    roster_digest: str
    scene_sha256: str
    source_catalog_digest: str
    resource_plan_digest: str
    source_identity: str
    engine_owner_id: str
    native_plan_sha256: str

@dataclass(frozen=True, slots=True)
class Advanced:
    kind: str
    batch: Batch

@dataclass(frozen=True, slots=True)
class AdvanceFailed:
    kind: str
    batch: Batch
    native_retirement: str
    physical_advance_allowed: bool
    successful_finish_allowed: bool

@dataclass(frozen=True, slots=True)
class SourceManifest:
    request_id: str
    source_id: str
    entity_index: int
    schema: str
    plan_digest: str
    scene_sha256: str
    source_catalog_digest: str
    source_config_digest: str
    batch_digest: str
    source_body_tick: int
    available_after_body_tick: int
    source_production_digest: str
    original_payload_sha256: str
    byte_manifest_digest: str
    tensor: Tensor
    manifest_digest: str

@dataclass(frozen=True, slots=True)
class Exported:
    kind: str
    typed_manifest: SourceManifest
    byte_manifest: BufferManifest

@dataclass(frozen=True, slots=True)
class BatchReleased:
    kind: str
    plan_digest: str
    batch_digest: str
    tick: int

@dataclass(frozen=True, slots=True)
class Finish:
    plan_digest: str
    completed_ticks: int
    last_released_batch_digest: str

@dataclass(frozen=True, slots=True)
class Terminal:
    plan_digest: str
    completed_ticks: int
    last_released_batch_digest: str
    native_retirement: str
    promised_source_output: str
    scientific_validation: bool

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
    shape: tuple[int, ...]
    layout: str
    row_origin: str
    unit: str

@dataclass(frozen=True, slots=True)
class PressureTensor:
    kind: str
    dtype: str
    shape: tuple[int, ...]
    layout: str
    sample_start: int
    sample_end: int
    sample_rate_hz: int
    unit: str

Vec3 = tuple[float, ...]
Tensor = RgbaTensor | RadianceTensor | PressureTensor
ControllerReference = tuple[float, float]
SourceRequest = RGBRequest | ThermalRequest | PressureRequest
Prepare = PrepareNoModels | PrepareThermal | PrepareAcoustic | PrepareAcousticThermal
Target = tuple[float, float, float, float]
SetRow = tuple[int, str, bool, Target]
HoldRow = tuple[int, str, str]
ControlRow = SetRow | HoldRow
Command = Advance | ExportSource | ReleaseBatch
SourceOutcome = NotDue | Produced | Failed | Absent
AppliedRow = tuple[int, str, str, bool]
Result = Prepared | Advanced | AdvanceFailed | Exported | BatchReleased
ImportDescriptor = Never
ImportMetadata = Never
Imported = Never
PREPARE_CLASSES = {(): PrepareNoModels, ('thermal',): PrepareThermal, ('acoustic',): PrepareAcoustic, ('acoustic', 'thermal'): PrepareAcousticThermal}
