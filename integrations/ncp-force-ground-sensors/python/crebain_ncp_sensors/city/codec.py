"""Closed application decoding and raw sensor validation, independent of Rust."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
import re
import struct
from typing import Any

from ncp_local import modular_wire as w

from . import types as t

from .identities import APPLICATION_DIGEST, COMPOSITION_DIGEST, SENSOR_DIGESTS

MAX_BATCH_BYTES = 27_857_088
_ROOT = Path(__file__).resolve().parent / "contracts"


def require(condition: bool, code: str = "wire") -> None:
    if not condition:
        raise w.ModularError(code)


def _resource(name: str) -> bytes:
    # These names are fixed by this module, never supplied by a peer or launcher.
    with (_ROOT / name).open("rb") as source:
        payload = source.read(65_537)
    require(0 < len(payload) <= 65_536, "capacity")
    return payload


_DESCRIPTOR = _resource("application.descriptor.v1.json")
_SCHEMA_BYTES = _resource("application.schema.v1.json")
_SCHEMA = w.parse(_SCHEMA_BYTES)["$defs"]
require(
    w.typed_digest(w.PROFILE_DOMAIN, w.parse(_DESCRIPTOR)) == APPLICATION_DIGEST,
    "binding",
)
require(
    w.parse(_DESCRIPTOR)["types_schema_sha256"]
    == hashlib.sha256(_SCHEMA_BYTES).hexdigest(),
    "binding",
)
_COMPOSITION = w.parse(_resource("standalone.composition.v1.json"))
require(w.typed_digest(w.PROFILE_DOMAIN, _COMPOSITION) == COMPOSITION_DIGEST, "binding")
require(_COMPOSITION["producer_application_digest"] == APPLICATION_DIGEST, "binding")
for _kind, _digest in SENSOR_DIGESTS.items():
    require(
        w.typed_digest(
            w.PROFILE_DOMAIN, w.parse(_resource(f"{_kind}.semantic.v1.json"))
        )
        == _digest,
        "binding",
    )

_CLASSES = {
    name: getattr(t, name)
    for name, rule in _SCHEMA.items()
    if type(rule) is dict and rule.get("type") == "object" and name != "Prepare"
}


def _decode(
    schema: Any,
    value: Any,
    name: str = "",
    depth: int = 0,
    *,
    definitions=None,
    classes=None,
) -> Any:
    """Interpret only the fixed, closed subset used by the committed descriptor."""
    require(depth <= 32 and schema is not False)
    require(type(schema) is dict)
    definitions = _SCHEMA if definitions is None else definitions
    classes = _CLASSES if classes is None else classes
    if "$ref" in schema:
        target = schema["$ref"].removeprefix("#/$defs/")
        require(target in definitions)
        return _decode(
            definitions[target],
            value,
            target,
            depth + 1,
            definitions=definitions,
            classes=classes,
        )
    for union in ("oneOf", "anyOf"):
        if union in schema:
            matches = []
            for option in schema[union]:
                try:
                    matches.append(
                        _decode(
                            option,
                            value,
                            name,
                            depth + 1,
                            definitions=definitions,
                            classes=classes,
                        )
                    )
                except w.ModularError:
                    pass
            require(len(matches) == 1)
            return matches[0]
    if "const" in schema:
        expected = schema["const"]
        require(type(value) is type(expected) and value == expected)
        return value
    if "enum" in schema:
        require(
            any(type(value) is type(item) and value == item for item in schema["enum"])
        )
        return value
    kind = schema.get("type")
    if kind == "object":
        properties = schema["properties"]
        require(schema.get("additionalProperties") is False)
        require(
            type(value) is dict
            and set(schema["required"]) <= set(value) <= set(properties)
        )
        decoded = {
            key: _decode(
                properties[key],
                item,
                depth=depth + 1,
                definitions=definitions,
                classes=classes,
            )
            for key, item in value.items()
        }
        cls = (
            t.PREPARE_CLASSES.get(
                tuple(key for key in ("acoustic", "thermal") if key in value)
            )
            if name == "Prepare"
            else classes.get(name)
        )
        require(cls is not None)
        return cls(**decoded)
    if kind == "array":
        require(type(value) is list)
        require(schema["minItems"] <= len(value) <= schema["maxItems"])
        if "prefixItems" in schema:
            require(
                schema["items"] is False and len(value) == len(schema["prefixItems"])
            )
            return tuple(
                _decode(
                    rule,
                    item,
                    depth=depth + 1,
                    definitions=definitions,
                    classes=classes,
                )
                for rule, item in zip(schema["prefixItems"], value)
            )
        return tuple(
            _decode(
                schema["items"],
                item,
                depth=depth + 1,
                definitions=definitions,
                classes=classes,
            )
            for item in value
        )
    if kind in ("integer", "number"):
        require(type(value) is int if kind == "integer" else type(value) is float)
        require(math.isfinite(value) and abs(value) <= 1e300)
        require(schema["minimum"] <= value <= schema["maximum"])
        return value
    if kind == "string":
        require(type(value) is str and len(value) <= schema.get("maxLength", 256))
        require(
            value.isascii()
            and (
                "pattern" not in schema
                or re.fullmatch(schema["pattern"], value) is not None
            )
        )
        return value
    if kind == "boolean":
        require(type(value) is bool)
        return value
    if kind == "null":
        require(value is None)
        return None
    raise w.ModularError("wire")


def decode(name: str, value: Any) -> Any:
    """Decode a bounded plain JSON value into closed immutable application types."""
    require(name in _SCHEMA)
    w.encode(value)  # Bounds traversal, scalar size, cycles, and encoded length first.
    return _decode(_SCHEMA[name], value, name)


def raw(value: Any) -> Any:
    return w.immutable_value(value)


def equal_bits(left: Any, right: Any) -> bool:
    """Compare the NCP typed representation, including floating-point signed zero."""
    return w.typed_digest(w.PROFILE_DOMAIN, raw(left)) == w.typed_digest(
        w.PROFILE_DOMAIN, raw(right)
    )


def commitment(kind: str, value: Any) -> str:
    omitted = {
        "plan": None,
        "roster": None,
        "resources": None,
        "catalog": "catalog_digest",
        "manifest": "manifest_digest",
        "batch": "batch_digest",
    }
    require(kind in omitted)
    owned = (
        {key: item for key, item in value.items() if key != omitted[kind]}
        if omitted[kind] is not None
        else value
    )
    return w.typed_digest(
        w.PROFILE_DOMAIN,
        {"schema": f"crebain.force-city-{kind}-commitment.v1", "value": owned},
    )


def resources(p: t.Prepare) -> dict:
    n = len(p.world.entity_ids)
    rgb = sum(4 * s.width * s.height for s in p.sources if type(s) is t.RGBRequest)
    thermal = sum(
        16 * s.width * s.height for s in p.sources if type(s) is t.ThermalRequest
    )
    scratch = max(
        (16 * s.width * s.height for s in p.sources if type(s) is t.ThermalRequest),
        default=0,
    )
    microphones = sum(type(s) is t.PressureRequest for s in p.sources)
    original = rgb + thermal // 4 + 134 * 8 * microphones
    require(original <= MAX_BATCH_BYTES, "capacity")
    acoustic = getattr(p, "acoustic", None)
    return {
        "schema": "crebain.force-city-resource-plan.v1",
        "native_original_bytes": original,
        "application_original_bytes": original,
        "native_receipt_bytes": 16384 + 256 * n + 4096 * len(p.sources),
        "native_control_bytes": 4096 + 32768 * n,
        "acoustic_history_bytes": 0
        if acoustic is None
        else 8
        * n
        * (math.ceil(acoustic.maximumRangeM / acoustic.soundSpeedMps * 16000.0) + 2),
        "acoustic_block_bytes": 134 * 8 * microphones,
        "rgb_readback_bytes": rgb,
        "thermal_readback_bytes": scratch,
        "render_target_color_bytes": rgb + thermal,
        "source_graphics_retention_bytes": max(
            (
                4 * s.width * s.height
                for s in p.sources
                if type(s) is not t.PressureRequest
            ),
            default=0,
        ),
        "maximum_public_live_payload_bytes": original,
        "maximum_public_live_buffers": len(p.sources),
        "private_frame_bytes": 65536,
        "private_value_nodes": 16384,
        "private_depth": 24,
        "chunk_bytes": 32768,
        "application_result_bytes": 49152,
        "opaque_runtime_memory_bound": False,
    }


def resource_digest(p: t.Prepare) -> str:
    return commitment("resources", resources(p))


def catalog_digest(p: t.Prepare) -> str:
    return commitment(
        "catalog",
        {
            "sources": raw(p.sources),
            "acoustic": raw(getattr(p, "acoustic", None)),
            "thermal": raw(getattr(p, "thermal", None)),
            "frame": p.world.frame,
        },
    )


def validate_prepare(p: t.Prepare) -> None:
    require(p.composition_digest == COMPOSITION_DIGEST, "binding")
    n = len(p.world.entity_ids)
    require(
        len(p.world.initial_positions) == len(p.world.controller_references) == n
        and p.world.action_budget >= n
    )
    for values in (
        p.world.entity_ids,
        tuple(m.id for m in p.scene.materials),
        tuple(s.id for s in p.scene.solids),
        tuple(s.request_id for s in p.sources),
    ):
        require(all(a < b for a, b in zip(values, values[1:])))
    require(all(position[1] > 0.05 for position in p.world.initial_positions))
    require(all(s.material_index < len(p.scene.materials) for s in p.scene.solids))
    require(len({s.source_id for s in p.sources}) == len(p.sources))
    require(all(s.entity_index < n for s in p.sources))
    for kind in (t.RGBRequest, t.ThermalRequest, t.PressureRequest):
        require(sum(type(s) is kind for s in p.sources) <= 4)
    require(
        any(type(s) is t.ThermalRequest for s in p.sources) == hasattr(p, "thermal")
    )
    require(
        any(type(s) is t.PressureRequest for s in p.sources) == hasattr(p, "acoustic")
    )
    require(
        all(
            s.position != s.target
            for s in p.sources
            if type(s) is not t.PressureRequest
        )
    )
    if hasattr(p, "acoustic"):
        require(p.acoustic.referenceDistanceM <= p.acoustic.maximumRangeM)
    require(p.resource_plan_digest == resource_digest(p), "binding")


def validate_prepared(
    p: t.Prepare, result: t.Prepared, binding: t.BufferBinding
) -> None:
    require(
        result.plan_digest
        == commitment(
            "plan",
            {
                "prepare": raw(p),
                "run_id": binding.run_id,
                "source_identity": result.source_identity,
            },
        ),
        "binding",
    )
    require(
        result.roster_digest == commitment("roster", raw(p.world.entity_ids)), "binding"
    )
    require(
        result.source_catalog_digest == catalog_digest(p)
        and result.resource_plan_digest == p.resource_plan_digest,
        "binding",
    )


def validate_rows(p: t.Prepare, rows: tuple, accepted: tuple, used: int) -> int:
    require(type(rows) is tuple and len(rows) == len(p.world.entity_ids))
    additions = 0
    for i, row in enumerate(rows):
        decode("ControlRow", raw(row))
        require(row[0] == i)
        if row[1] == "hold":
            require(i < len(accepted) and row[2] == accepted[i][1], "binding")
        else:
            delta = row[3][2] - p.world.controller_references[i][1]
            require(abs(math.atan2(math.sin(delta), math.cos(delta))) <= 0.2)
            require(abs(row[3][3] - p.world.controller_references[i][0]) <= 0.5)
            additions += 1
    require(used + additions <= p.world.action_budget, "capacity")
    return additions


def expected_tensor(source: t.SourceRequest, tick: int) -> t.Tensor:
    require(type(tick) is int and 1 <= tick <= 7200)
    if type(source) is t.RGBRequest:
        return t.RgbaTensor(
            "rgba8",
            "u8",
            (source.height, source.width, 4),
            "c_contiguous",
            "bottom-left",
            "rgba8-srgb",
        )
    if type(source) is t.ThermalRequest:
        return t.RadianceTensor(
            "radiance",
            "f32le",
            (source.height, source.width),
            "c_contiguous",
            "bottom-left",
            "W/(m2 sr)",
        )
    start, end = (tick - 1) * 16000 // 120, tick * 16000 // 120
    return t.PressureTensor(
        "pressure", "f64le", (end - start,), "c_contiguous", start, end, 16000, "pascal"
    )


def tensor_bytes(tensor: t.Tensor) -> int:
    return math.prod(tensor.shape) * (
        8 if tensor.kind == "pressure" else 4 if tensor.kind == "radiance" else 1
    )


def validate_batch(
    p: t.Prepare,
    prepared: t.Prepared,
    command: t.Advance,
    result: t.Advanced | t.AdvanceFailed,
    accepted: tuple,
) -> None:
    b = result.batch
    require(
        b.tick == b.control.tick == command.tick <= p.world.horizon_ticks, "binding"
    )
    require(
        (b.plan_digest, b.roster_digest, b.scene_sha256, b.source_catalog_digest)
        == (
            prepared.plan_digest,
            prepared.roster_digest,
            prepared.scene_sha256,
            prepared.source_catalog_digest,
        ),
        "binding",
    )
    require(
        b.previous_batch_digest == command.previous_batch_digest
        and len(b.slots) == len(p.sources),
        "binding",
    )
    require(
        len(b.control.rows) == len(command.rows) == len(p.world.entity_ids), "binding"
    )
    for i, (actual, requested) in enumerate(zip(b.control.rows, command.rows)):
        require(actual[0] == i and actual[2] == requested[1], "binding")
        if requested[1] == "set":
            require(actual[3] is requested[2], "binding")
        else:
            require(
                actual[1] == requested[2]
                and i < len(accepted)
                and actual[3] is accepted[i][3],
                "binding",
            )
    failed = None
    for kind in ("pressure", "rgb", "thermal"):
        for s, slot in zip(p.sources, b.slots):
            if s.kind != kind:
                continue
            require(
                (slot.request_id, slot.source_id, slot.entity_index)
                == (s.request_id, s.source_id, s.entity_index),
                "binding",
            )
            if command.tick % s.publication_period_ticks:
                next_tick = (
                    command.tick // s.publication_period_ticks + 1
                ) * s.publication_period_ticks
                require(
                    type(slot) is t.NotDue
                    and slot.next_due_tick
                    == (next_tick if next_tick <= p.world.horizon_ticks else None),
                    "binding",
                )
            elif failed is not None:
                require(
                    type(slot) is t.Absent
                    and slot.due_at_tick == command.tick
                    and slot.causal_failed_request_id == failed,
                    "binding",
                )
            elif type(slot) is t.Produced:
                require(
                    slot.source_body_tick
                    == slot.available_after_body_tick
                    == command.tick
                    and equal_bits(slot.tensor, expected_tensor(s, command.tick)),
                    "binding",
                )
                require(slot.byte_length == tensor_bytes(slot.tensor), "binding")
            else:
                require(
                    type(slot) is t.Failed
                    and kind != "pressure"
                    and slot.attempted_at_tick == command.tick,
                    "binding",
                )
                failed = s.request_id
    require((type(result) is t.AdvanceFailed) == (failed is not None), "binding")


def validate_export(result: t.Exported, command: t.ExportSource, context) -> None:
    t0, b = result.typed_manifest, result.byte_manifest
    b.verify(context.binding)
    require(
        b.imported_manifest_digest is None
        and b.creating_request_digest == context.request_digest
        and b.causal_predecessor == context.predecessor,
        "binding",
    )
    for field in (
        "request_id",
        "source_id",
        "entity_index",
        "plan_digest",
        "batch_digest",
        "source_body_tick",
        "source_production_digest",
        "original_payload_sha256",
    ):
        require(getattr(t0, field) == getattr(command, field), "binding")
    require(
        t0.available_after_body_tick == command.source_body_tick
        and t0.byte_manifest_digest == b.manifest_digest,
        "binding",
    )
    require(t0.manifest_digest == commitment("manifest", raw(t0)), "binding")
    require(
        t0.original_payload_sha256 == b.payload_sha256
        and tensor_bytes(t0.tensor) == b.byte_length
        and b.semantic_digest == SENSOR_DIGESTS[t0.tensor.kind],
        "binding",
    )


def validate_payload(
    manifest: t.SourceManifest, byte_manifest: t.BufferManifest, payload: bytes
) -> None:
    require(
        type(payload) is bytes
        and len(payload) == tensor_bytes(manifest.tensor) == byte_manifest.byte_length,
        "binding",
    )
    require(
        hashlib.sha256(payload).hexdigest()
        == byte_manifest.payload_sha256
        == manifest.original_payload_sha256,
        "binding",
    )
    kind = manifest.tensor.kind
    if kind != "rgba8":
        for (value,) in struct.iter_unpack(
            "<d" if kind == "pressure" else "<f", payload
        ):
            require(
                math.isfinite(value) and (kind != "radiance" or 0 <= value <= 10000)
            )
