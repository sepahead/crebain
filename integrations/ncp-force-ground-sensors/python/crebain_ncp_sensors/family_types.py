"""Generated immutable family DTOs; selectors do not create native authority."""

from __future__ import annotations

from dataclasses import dataclass

from .types import (
    Advanced,
    BufferBinding,
    Command,
    Finish,
    Prepare,
    Prepared,
    SensorCatalog,
    SetTarget,
)


@dataclass(frozen=True, slots=True)
class CommittedStamp:
    binding: BufferBinding
    sequence: int
    request_digest: Digest
    result_digest: Digest

@dataclass(frozen=True, slots=True)
class CheckpointReference:
    family_id: Uuid
    checkpoint_token: Uuid
    parent_binding: BufferBinding
    parent_native_owner_id: Uuid
    tick: int
    checkpoint_sha256: Digest

@dataclass(frozen=True, slots=True)
class PressureWindow:
    kind: str
    sensor_id: str
    first_tick: int
    last_tick: int
    sample_count: int
    unit: str
    target_function_digest: Digest

@dataclass(frozen=True, slots=True)
class BranchPlan:
    slot: int
    case_id: Token
    purpose: str
    binding: BufferBinding
    target: SetTarget

@dataclass(frozen=True, slots=True)
class FamilyLimits:
    total_wall_seconds: int
    endpoint_count: int
    max_active_native_owners: int
    public_checkpoint_slots: int
    temporary_checkpoint_slots: int
    evaluation_window_bytes: int

@dataclass(frozen=True, slots=True)
class FamilyPlan:
    family_id: Uuid
    canonical_binding: BufferBinding
    body: Prepare
    landmark_tick: int
    branches: tuple[BranchPlan, ...]
    evaluation: PressureWindow
    limits: FamilyLimits

@dataclass(frozen=True, slots=True)
class CanonicalPrepare:
    plan: FamilyPlan

@dataclass(frozen=True, slots=True)
class CheckpointCommand:
    kind: str
    tick: int
    expected_batch_digest: Digest

@dataclass(frozen=True, slots=True)
class CommitDecisionCommand:
    kind: str
    checkpoint: CheckpointReference
    forecast_commitment_digest: Digest
    selected_case_id: Token

@dataclass(frozen=True, slots=True)
class ReserveBranchCommand:
    kind: str
    checkpoint: CheckpointReference
    case_id: Token
    expected_selected_execution_result_digest: Digest

@dataclass(frozen=True, slots=True)
class ReleaseCheckpointCommand:
    kind: str
    checkpoint: CheckpointReference
    expected_last_branch_terminal_result_digest: Digest

@dataclass(frozen=True, slots=True)
class ReservationReference:
    family_id: Uuid
    reservation_token: Uuid
    case_id: Token
    branch_binding: BufferBinding
    checkpoint: CheckpointReference
    reserving_request_digest: Digest

@dataclass(frozen=True, slots=True)
class EvaluationPrepare:
    reservation: ReservationReference
    expected_family_plan_digest: Digest

@dataclass(frozen=True, slots=True)
class EvaluateCommand:
    kind: str
    expected_batch_digest: Digest
    expected_target_function_digest: Digest

@dataclass(frozen=True, slots=True)
class BranchAncestry:
    family_id: Uuid
    case_id: Token
    origin: CheckpointReference
    origin_plan_digest: Digest
    origin_engine_run_id: str
    origin_native_batch_sha256: Digest
    origin_sensor_batch_digest: Digest
    action_history_position: int
    selection: CommittedStamp
    selected_execution: CommittedStamp
    execution_binding: BufferBinding
    native_owner_id: Uuid
    graphics_generation: Uuid
    reconstruction: str

@dataclass(frozen=True, slots=True)
class PixelIdentity:
    sensor_id: str
    payload_sha256: Digest

@dataclass(frozen=True, slots=True)
class Checkpointed:
    kind: str
    reference: CheckpointReference
    cpu_state_sha256: Digest
    graphics_plan_sha256: Digest
    render_input_sha256: Digest
    pixels: tuple[PixelIdentity, ...]
    accepted_native_batch_sha256: Digest
    accepted_sensor_batch_digest: Digest
    accepted_action_position: int

@dataclass(frozen=True, slots=True)
class DecisionCommitted:
    kind: str
    checkpoint: CheckpointReference
    forecast_commitment_digest: Digest
    selected_case_id: Token
    selected_target: SetTarget

@dataclass(frozen=True, slots=True)
class BranchReserved:
    kind: str
    reference: ReservationReference
    family_plan_digest: Digest

@dataclass(frozen=True, slots=True)
class CheckpointReleased:
    kind: str
    reference: CheckpointReference
    native_release: str

@dataclass(frozen=True, slots=True)
class FamilyPrepared:
    kind: str
    family_plan_digest: Digest
    body: Prepared
    endpoint_count: int
    native_owner_count: int

@dataclass(frozen=True, slots=True)
class Restored:
    kind: str
    family_plan_digest: Digest
    sensor_catalog: SensorCatalog
    initial_observation: str
    ancestry: BranchAncestry
    cpu_state_sha256: Digest
    render_input_sha256: Digest
    pixels: tuple[PixelIdentity, ...]

@dataclass(frozen=True, slots=True)
class FamilyAdvanced:
    kind: str
    body: Advanced
    ancestry: BranchAncestry | None
    canonical_final_state: CanonicalFinalState | None

@dataclass(frozen=True, slots=True)
class PressureSegment:
    source_body_tick: int
    available_after_body_tick: int
    sample_start: int
    sample_end: int
    typed_manifest_digest: Digest
    byte_manifest_digest: Digest
    payload_sha256: Digest
    byte_length: int

@dataclass(frozen=True, slots=True)
class EvaluationResult:
    kind: str
    ancestry: BranchAncestry
    target: PressureWindow
    segments: tuple[PressureSegment, ...]
    window_payload_sha256: Digest
    value_pa: float
    final_cpu_state_sha256: Digest
    final_native_batch_sha256: Digest
    final_sensor_batch_digest: Digest
    accepted_action_request_digest: Digest
    scientific_validation: bool

@dataclass(frozen=True, slots=True)
class CanonicalFinish:
    body: Finish
    family_plan_digest: Digest
    expected_branch_terminals: tuple[CommittedStamp, ...]

@dataclass(frozen=True, slots=True)
class EvaluationFinish:
    body: Finish
    evaluation_result_digest: Digest

@dataclass(frozen=True, slots=True)
class EvaluationTerminal:
    family_id: Uuid
    case_id: Token
    ancestry: BranchAncestry
    last_batch_digest: Digest
    evaluation_result_digest: Digest
    native_owner_retirement: str
    graphics_retirement: str
    shared_family_process_retirement: str
    promised_sensor_output: str
    scientific_validation: bool

@dataclass(frozen=True, slots=True)
class CanonicalTerminal:
    family_id: Uuid
    family_plan_digest: Digest
    last_batch_digest: Digest
    branch_terminals: tuple[CommittedStamp, ...]
    checkpoint_release: str
    native_family_retirement: str
    bun_process_retirement: str
    sdk_host_process_retirement: str
    scientific_validation: bool
    canonical_final_state: CanonicalFinalState
    canonical_state_recheck: str

@dataclass(frozen=True, slots=True)
class CanonicalFinalState:
    body_tick: int
    native_batch_sha256: Digest
    cpu_state_sha256: Digest
    render_input_sha256: Digest
    pixels: tuple[PixelIdentity, ...]


Digest = str
Uuid = str
Token = str
CanonicalCommand = Command | CheckpointCommand | CommitDecisionCommand | ReserveBranchCommand | ReleaseCheckpointCommand
EvaluationCommand = Command | EvaluateCommand
CanonicalResult = FamilyPrepared | FamilyAdvanced | Checkpointed | DecisionCommitted | BranchReserved | CheckpointReleased
EvaluationResultUnion = Restored | FamilyAdvanced | EvaluationResult

_OBJECT_NAMES = (
    "CommittedStamp",
    "CheckpointReference",
    "PressureWindow",
    "BranchPlan",
    "FamilyLimits",
    "FamilyPlan",
    "CanonicalPrepare",
    "CheckpointCommand",
    "CommitDecisionCommand",
    "ReserveBranchCommand",
    "ReleaseCheckpointCommand",
    "ReservationReference",
    "EvaluationPrepare",
    "EvaluateCommand",
    "BranchAncestry",
    "PixelIdentity",
    "Checkpointed",
    "DecisionCommitted",
    "BranchReserved",
    "CheckpointReleased",
    "FamilyPrepared",
    "Restored",
    "FamilyAdvanced",
    "PressureSegment",
    "EvaluationResult",
    "CanonicalFinish",
    "EvaluationFinish",
    "EvaluationTerminal",
    "CanonicalTerminal",
    "CanonicalFinalState",
)
