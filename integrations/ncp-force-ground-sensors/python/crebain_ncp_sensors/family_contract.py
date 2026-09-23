"""Closed optional family roles; a decoded selector grants no native authority."""

from __future__ import annotations

import hashlib
import json
import math
import struct
import uuid

from ncp_local import modular_owner as owner, modular_wire as w

from . import codec as c, family_types as f, types as t
from .contract import SensorContract


DESCRIPTOR = c._resource("family.application.descriptor.v1.json")
_SCHEMA_BYTES = c._resource("family.application.schema.v1.json")
_SCHEMA = w.parse(_SCHEMA_BYTES)["$defs"]
_COMPOSITION = w.parse(c._resource("family.composition.v1.json"))
_TARGET = w.parse(c._resource("pressure-window-rms.semantic.v1.json"))
APPLICATION_DIGEST = w.typed_digest(w.PROFILE_DOMAIN, w.parse(DESCRIPTOR))
COMPOSITION_DIGEST = w.typed_digest(w.PROFILE_DOMAIN, _COMPOSITION)
TARGET_DIGEST = hashlib.sha256(json.dumps(
    _TARGET, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False,
).encode()).hexdigest()
c.require(w.parse(DESCRIPTOR)["types_schema_sha256"] == hashlib.sha256(_SCHEMA_BYTES).hexdigest(), "binding")
c.require(w.parse(DESCRIPTOR)["sensor_types_schema_sha256"] == hashlib.sha256(c._SCHEMA_BYTES).hexdigest(), "binding")
c.require(_COMPOSITION["application_schema_sha256"] == hashlib.sha256(_SCHEMA_BYTES).hexdigest(), "binding")
_CLASSES = {**c._CLASSES, **{name: getattr(f, name) for name in f._OBJECT_NAMES}}


def decode(name: str, value: object):
    """Decode only a fixed installed family type after unchanged NCP byte admission."""
    c.require(name in _SCHEMA)
    w.encode(value)
    return c._decode(_SCHEMA[name], value, name, definitions=_SCHEMA, classes=_CLASSES)


def new_binding() -> t.BufferBinding:
    """Create distinct run, endpoint, and generation IDs for one actual family peer."""
    result = t.BufferBinding(owner.profile_digest(), APPLICATION_DIGEST,
                             str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()))
    result.validate()
    return result


def plan_digest(plan: f.FamilyPlan, source_identity: str) -> str:
    decode("Digest", source_identity)
    return w.typed_digest(w.PROFILE_DOMAIN, {
        "schema": "crebain.live-checkpoint-family-plan-commitment.v1",
        "plan": c.raw(plan), "source_identity": source_identity,
    })


def validate_plan(plan: f.FamilyPlan) -> None:
    c.require(type(plan) is f.FamilyPlan)
    decode("FamilyPlan", c.raw(plan))
    c.require(plan.body.composition_digest == COMPOSITION_DIGEST, "binding")
    c.validate_specification(plan.body.specification)
    bindings = (plan.canonical_binding, *(branch.binding for branch in plan.branches))
    for binding in bindings:
        binding.validate()
        c.require(binding.profile_digest == owner.profile_digest()
                  and binding.application_digest == APPLICATION_DIGEST, "binding")
    for field in ("run_id", "endpoint_id", "generation"):
        c.require(len({getattr(binding, field) for binding in bindings}) == len(bindings), "binding")
    c.require(plan.limits.endpoint_count == len(bindings))
    c.require(plan.landmark_tick < plan.body.planned_ticks)
    cameras = (*plan.body.specification.scene.rgbCameras, *plan.body.specification.scene.thermalCameras)
    c.require(bool(cameras) and all(plan.landmark_tick % camera.periodTicks == 0
              and plan.body.planned_ticks % camera.periodTicks == 0 for camera in cameras))
    target = plan.evaluation
    c.require(target.first_tick > plan.landmark_tick and target.last_tick == plan.body.planned_ticks
              and target.first_tick + 2 == target.last_tick)
    c.require(target.last_tick * 16000 // 120 - (target.first_tick - 1) * 16000 // 120 == 400)
    c.require(target.target_function_digest == TARGET_DIGEST, "binding")
    c.require(target.sensor_id in {"pressure:" + mic.id for mic in plan.body.specification.scene.microphones})
    c.require(tuple(branch.slot for branch in plan.branches) == tuple(range(1, len(bindings))))
    c.require(len({branch.case_id for branch in plan.branches}) == len(plan.branches))
    for branch in plan.branches:
        c.validate_target(branch.target, plan.body.specification.controller)


def freeze_plan(plan: f.FamilyPlan) -> f.FamilyPlan:
    """Rebuild admitted immutable DTOs and reject mutable container substitutions."""
    c.require(type(plan) is f.FamilyPlan)
    frozen = decode("FamilyPlan", c.raw(plan))
    validate_plan(frozen)
    return frozen


def pressure_rms(payload: bytes) -> float:
    """Replay the source-owned ordered binary64 RMS; platform sqrt needs qualification."""
    c.require(type(payload) is bytes and len(payload) == 3200)
    values = tuple(value for (value,) in struct.iter_unpack("<d", payload))
    c.require(all(math.isfinite(value) for value in values))
    maximum = max(abs(value) for value in values)
    if maximum == 0:
        return 0.0
    total = correction = 0.0
    for value in values:
        scaled = value / maximum
        term = scaled * scaled
        updated = total + term
        if abs(total) >= abs(term):
            correction += (total - updated) + term
        else:
            correction += (term - updated) + total
        c.require(all(math.isfinite(item) for item in (scaled, term, updated, correction)))
        total = updated
    accumulated = total + correction
    scaled_mean = accumulated / 400
    c.require(math.isfinite(accumulated) and math.isfinite(scaled_mean) and scaled_mean >= 0)
    root = math.sqrt(scaled_mean)
    c.require(math.isfinite(root))
    result = maximum * root
    c.require(math.isfinite(result))
    return result


def stamp(response: w.Response) -> f.CommittedStamp:
    c.require(type(response) is w.Response and response.outcome is w.Outcome.COMMITTED)
    return f.CommittedStamp(response.binding, response.sequence, response.request_digest, response.result_digest)


class _Role:
    """Constructor-selected closed role; peers cannot supply decoder or operation names."""

    names: tuple[str, str, str, str, str]

    @staticmethod
    def descriptor() -> bytes:
        return DESCRIPTOR

    allows = staticmethod(SensorContract.allows)
    decode_import = staticmethod(SensorContract._uninhabited)
    decode_metadata = staticmethod(SensorContract._uninhabited)
    decode_imported = staticmethod(SensorContract._uninhabited)
    check_import_metadata = staticmethod(SensorContract._uninhabited)

    @classmethod
    def decode_prepare(cls, value):
        result = decode(cls.names[0], value)
        if type(result) is f.CanonicalPrepare:
            validate_plan(result.plan)
        return result

    @classmethod
    def decode_command(cls, value):
        return decode(cls.names[1], value)

    @classmethod
    def decode_result(cls, value):
        c.require(len(w.encode(value)) <= 32768, "capacity")
        return decode(cls.names[2], value)

    @classmethod
    def decode_finish(cls, value):
        return decode(cls.names[3], value)

    @classmethod
    def decode_terminal(cls, value):
        c.require(len(w.encode(value)) <= 32768, "capacity")
        return decode(cls.names[4], value)

    @classmethod
    def check_input(cls, operation):
        decoder = {w.Prepare: cls.decode_prepare, w.Application: cls.decode_command,
                   w.Finish: cls.decode_finish}.get(type(operation))
        if decoder is None:
            c.require(type(operation) in (w.Read, w.Release, w.Abort))
        else:
            actual = decoder(c.raw(operation.data))
            c.require(type(actual) is type(operation.data))


def _advance_response(operation, body, context):
    c.require(type(body.data) is f.FamilyAdvanced)
    SensorContract.check_response(operation, w.Body(body.kind, body.data.body), context)
    final = body.data.canonical_final_state
    if final is not None:
        c.require(final.body_tick == body.data.body.tick
                  and final.native_batch_sha256 == body.data.body.batch.engine_batch_sha256, "binding")


class CanonicalContract(_Role):
    """The original live parent's typed checkpoint and branch-reservation role."""

    names = ("CanonicalPrepare", "CanonicalCommand", "CanonicalResult", "CanonicalFinish", "CanonicalTerminal")

    @staticmethod
    def check_response(operation, body, context):
        result = body.data
        if type(operation) is w.Prepare:
            c.require(type(result) is f.FamilyPrepared)
            plan = operation.data.plan
            c.require(context.binding == plan.canonical_binding, "binding")
            c.validate_prepared(plan.body, result.body, context.binding)
            c.require(result.family_plan_digest == plan_digest(plan, result.body.source_identity)
                      and result.endpoint_count == plan.limits.endpoint_count, "binding")
        elif type(operation) is w.Application:
            command = operation.data
            if type(command) is t.Command:
                _advance_response(operation, body, context)
                c.require(result.ancestry is None, "binding")
            elif type(command) is f.CheckpointCommand:
                c.require(type(result) is f.Checkpointed)
                c.require(result.reference.tick == command.tick
                          and result.reference.parent_binding == context.binding
                          and result.accepted_sensor_batch_digest == command.expected_batch_digest, "binding")
            elif type(command) is f.CommitDecisionCommand:
                c.require(type(result) is f.DecisionCommitted)
                c.require(result.checkpoint == command.checkpoint
                          and result.forecast_commitment_digest == command.forecast_commitment_digest
                          and result.selected_case_id == command.selected_case_id, "binding")
            elif type(command) is f.ReserveBranchCommand:
                c.require(type(result) is f.BranchReserved)
                c.require(result.reference.checkpoint == command.checkpoint
                          and result.reference.case_id == command.case_id
                          and result.reference.reserving_request_digest == context.request_digest, "binding")
            elif type(command) is f.ReleaseCheckpointCommand:
                c.require(type(result) is f.CheckpointReleased and result.reference == command.checkpoint, "binding")
            else:
                raise w.ModularError("wire")
        elif type(operation) is w.Finish:
            c.require(type(result) is f.CanonicalTerminal)
            request = operation.data
            c.require(result.family_plan_digest == request.family_plan_digest
                      and result.last_batch_digest == request.body.last_batch_digest
                      and result.branch_terminals == request.expected_branch_terminals
                      and result.canonical_final_state.body_tick == request.body.completed_ticks, "binding")


class EvaluationContract(_Role):
    """One frozen evaluation endpoint; ordinary sensor clients do not install this role."""

    names = ("EvaluationPrepare", "EvaluationCommand", "EvaluationResultUnion", "EvaluationFinish", "EvaluationTerminal")

    @staticmethod
    def check_response(operation, body, context):
        result = body.data
        if type(operation) is w.Prepare:
            c.require(type(result) is f.Restored)
            request = operation.data
            c.require(result.family_plan_digest == request.expected_family_plan_digest
                      and result.ancestry.origin == request.reservation.checkpoint
                      and result.ancestry.case_id == request.reservation.case_id
                      and result.ancestry.execution_binding == request.reservation.branch_binding == context.binding, "binding")
            c.verify_commitment("catalog", result.sensor_catalog, 16384)
        elif type(operation) is w.Application:
            command = operation.data
            if type(command) is t.Command:
                _advance_response(operation, body, context)
                c.require(result.ancestry is not None and result.canonical_final_state is None, "binding")
                c.require(result.ancestry.execution_binding == context.binding, "binding")
            else:
                c.require(type(command) is f.EvaluateCommand and type(result) is f.EvaluationResult)
                c.require(result.final_sensor_batch_digest == command.expected_batch_digest
                          and result.target.target_function_digest == command.expected_target_function_digest
                          and result.ancestry.execution_binding == context.binding, "binding")
        elif type(operation) is w.Finish:
            c.require(type(result) is f.EvaluationTerminal)
            c.require(result.ancestry.execution_binding == context.binding
                      and result.last_batch_digest == operation.data.body.last_batch_digest
                      and result.evaluation_result_digest == operation.data.evaluation_result_digest, "binding")
