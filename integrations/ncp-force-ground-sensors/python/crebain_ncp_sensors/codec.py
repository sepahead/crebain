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

APPLICATION_DIGEST = "0bb5870f3e20101877516fe7521b92c24c755e56d4da5cc62a7431892801052d"
COMPOSITION_DIGEST = "0e909a703feac1afce307e249cfa00fa89df04fc599bed871405959830840c98"
SENSOR_DIGESTS = {
    "rgba8": "b07ecbee4fc8e22e322971b0c4082cd54ac8d19b617c591ef2fc7451b066a93f",
    "radiance": "de342271b445443d44a5cecac93250951905ff2c9f3703127bf175d24d32eaac",
    "pressure": "972eddae20f42b6a002832aff4314207398458720a0b8089b372fc36b679a770",
}
MAX_BATCH_BYTES = 27_857_088
MAX_BATCH_CHUNKS = 856
_ROOT = Path(__file__).resolve().parents[2] / "contracts"


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
require(w.typed_digest(w.PROFILE_DOMAIN, w.parse(_DESCRIPTOR)) == APPLICATION_DIGEST, "binding")
require(w.parse(_DESCRIPTOR)["types_schema_sha256"] == hashlib.sha256(_SCHEMA_BYTES).hexdigest(), "binding")
_COMPOSITION = w.parse(_resource("standalone.composition.v1.json"))
require(w.typed_digest(w.PROFILE_DOMAIN, _COMPOSITION) == COMPOSITION_DIGEST, "binding")
require(_COMPOSITION["producer_application_digest"] == APPLICATION_DIGEST, "binding")
for _kind, _digest in SENSOR_DIGESTS.items():
    require(w.typed_digest(w.PROFILE_DOMAIN, w.parse(_resource(f"{_kind}.semantic.v1.json"))) == _digest, "binding")

_CLASSES = {
    name: getattr(t, name)
    for name in (
        "Camera", "Microphone", "Material", "Scene", "Acoustic", "Thermal",
        "Controller", "Drone", "Specification", "Prepare", "SetTarget", "Hold",
        "Command", "Finish", "PressureConfiguration", "CatalogEntry", "SensorCatalog",
        "SensorManifest", "BufferBinding", "BufferManifest", "SensorBatch", "Prepared",
        "Advanced", "Terminal",
    )
}
_VARIANTS = {
    "Tensor": {"rgba8": t.RgbaTensor, "radiance": t.RadianceTensor, "pressure": t.PressureTensor},
    "SensorSlot": {"due": t.Due, "not_due": t.NotDue},
}


def _decode(schema: Any, value: Any, name: str = "", depth: int = 0) -> Any:
    """Interpret only the fixed, closed subset used by the committed descriptor."""
    require(depth <= 32 and schema is not False)
    require(type(schema) is dict)
    if "$ref" in schema:
        target = schema["$ref"].removeprefix("#/$defs/")
        require(target in _SCHEMA)
        return _decode(_SCHEMA[target], value, target, depth + 1)
    for union in ("oneOf", "anyOf"):
        if union in schema:
            matches = []
            for option in schema[union]:
                try:
                    matches.append(_decode(option, value, name, depth + 1))
                except w.ModularError:
                    pass
            require(len(matches) == 1)
            return matches[0]
    if "const" in schema:
        expected = schema["const"]
        require(type(value) is type(expected) and value == expected)
        return value
    kind = schema.get("type")
    if kind == "object":
        properties = schema["properties"]
        require(schema.get("additionalProperties") is False)
        require(set(schema["required"]) == set(properties))
        w.closed(value, set(properties))
        decoded = {
            key: _decode(rule, value[key], "CaptureReservation" if key == "capture_reservation" else "", depth + 1)
            for key, rule in properties.items()
        }
        cls = t.CaptureReservation if name == "CaptureReservation" else _CLASSES.get(name)
        if name in _VARIANTS:
            cls = _VARIANTS[name].get(value.get("kind"))
        require(cls is not None)
        return cls(**decoded)
    if kind == "array":
        require(type(value) is list)
        require(schema["minItems"] <= len(value) <= schema["maxItems"])
        if "prefixItems" in schema:
            require(schema["items"] is False and len(value) == len(schema["prefixItems"]))
            return tuple(_decode(rule, item, depth=depth + 1) for rule, item in zip(schema["prefixItems"], value))
        return tuple(_decode(schema["items"], item, depth=depth + 1) for item in value)
    if kind in ("integer", "number"):
        require(type(value) is int if kind == "integer" else type(value) in (int, float))
        require(math.isfinite(value) and abs(value) <= 1e300)
        require(schema["minimum"] <= value <= schema["maximum"])
        return value
    if kind == "string":
        require(type(value) is str and len(value) <= schema.get("maxLength", 256))
        require(re.fullmatch(schema["pattern"], value) is not None)
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
    return w.typed_digest(w.PROFILE_DOMAIN, raw(left)) == w.typed_digest(w.PROFILE_DOMAIN, raw(right))


def commitment(kind: str, value: dict[str, Any]) -> str:
    fields = {"plan": None, "catalog": "catalog_digest", "manifest": "manifest_digest", "batch": "batch_digest"}
    require(kind in fields)
    omit = fields[kind]
    owned = {key: item for key, item in value.items() if key != omit}
    return w.typed_digest(w.PROFILE_DOMAIN, {
        "schema": f"crebain.sensor-{kind}-commitment.v1", "value": owned,
    })


def verify_commitment(kind: str, value: Any, maximum: int) -> None:
    owned = raw(value)
    require(len(w.encode(owned)) <= maximum, "capacity")
    require(owned[f"{kind}_digest"] == commitment(kind, owned), "binding")


def validate_specification(spec: t.Specification) -> None:
    for roster in (spec.scene.materials, spec.scene.rgbCameras, spec.scene.thermalCameras, spec.scene.microphones):
        require(all(left.id < right.id for left, right in zip(roster, roster[1:])))
    for camera in (*spec.scene.rgbCameras, *spec.scene.thermalCameras):
        require(camera.position != camera.target)
    for camera in spec.scene.thermalCameras:
        require(camera.width <= 320 and camera.height <= 320)
    require(spec.acoustic.referenceDistanceM <= spec.acoustic.maximumRangeM)


def validate_target(target: t.SetTarget, controller: t.Controller) -> None:
    decode("SetTarget", raw(target))
    delta = target.heading_rad - controller.referenceHeadingRad
    require(abs(math.atan2(math.sin(delta), math.cos(delta))) <= 0.2)
    require(abs(target.altitude_m - controller.referenceAltitudeM) <= 0.5)


def expected_catalog(spec: t.Specification) -> tuple[t.CatalogEntry, ...]:
    entries = []
    for kind, prefix, roster in (
        ("rgba8", "rgb", spec.scene.rgbCameras),
        ("radiance", "thermal", spec.scene.thermalCameras),
        ("pressure", "pressure", spec.scene.microphones),
    ):
        for source in sorted(roster, key=lambda item: item.id):
            config = t.PressureConfiguration(source.position, spec.acoustic) if kind == "pressure" else source
            entries.append(t.CatalogEntry(kind, f"{prefix}:{source.id}", source.id, SENSOR_DIGESTS[kind], config))
    return tuple(entries)


def validate_prepared(prepare: t.Prepare, result: t.Prepared, binding: t.BufferBinding) -> None:
    plan = {
        **raw(prepare), "engine_run_id": "ncp-" + binding.run_id,
        "source_identity": result.source_identity,
    }
    require(result.plan_digest == commitment("plan", plan), "binding")
    catalog = result.sensor_catalog
    verify_commitment("catalog", catalog, 16_384)
    require(catalog.plan_digest == result.plan_digest, "binding")
    require(equal_bits(catalog.entries, expected_catalog(prepare.specification)), "binding")


def validate_batch_envelope(batch: t.SensorBatch, context: Any) -> None:
    verify_commitment("batch", batch, 32_768)
    require(len({slot.sensor_id for slot in batch.slots}) == len(batch.slots), "binding")
    references = set()
    total_bytes = total_chunks = 0
    for slot in batch.slots:
        if type(slot) is t.NotDue:
            continue
        manifest, byte_manifest = slot.typed_manifest, slot.byte_manifest
        verify_commitment("manifest", manifest, 2_048)
        require(len(w.encode(raw(byte_manifest))) <= 1_200, "capacity")
        byte_manifest.verify(context.binding)
        require(byte_manifest.imported_manifest_digest is None, "binding")
        require(byte_manifest.creating_request_digest == context.request_digest, "binding")
        require(byte_manifest.causal_predecessor == context.predecessor, "binding")
        require(byte_manifest.buffer_id not in references, "binding")
        references.add(byte_manifest.buffer_id)
        require(manifest.sensor_id == slot.sensor_id, "binding")
        require(manifest.byte_manifest_digest == byte_manifest.manifest_digest, "binding")
        require(manifest.engine_batch_sha256 == batch.engine_batch_sha256, "binding")
        require(manifest.source_body_tick == manifest.available_after_body_tick == batch.body_tick, "binding")
        require(manifest.sensor_contract_digest == byte_manifest.semantic_digest == SENSOR_DIGESTS[manifest.tensor.kind], "binding")
        require(tensor_bytes(manifest.tensor) == byte_manifest.byte_length, "binding")
        total_bytes += byte_manifest.byte_length
        total_chunks += byte_manifest.chunk_count
    require(total_bytes <= MAX_BATCH_BYTES and total_chunks <= MAX_BATCH_CHUNKS, "capacity")


def validate_batch(prepare: t.Prepare, prepared: t.Prepared, command: t.Command, result: t.Advanced) -> None:
    batch = result.batch
    require(result.tick == batch.body_tick == command.tick <= prepare.planned_ticks, "binding")
    require(batch.previous_batch_digest == command.previous_batch_digest, "binding")
    require((batch.plan_digest, batch.source_identity, batch.engine_owner_id, batch.scene_sha256) ==
            (prepared.plan_digest, prepared.source_identity, prepared.engine_owner_id, prepared.scene_sha256), "binding")
    entries = prepared.sensor_catalog.entries
    require(tuple(slot.sensor_id for slot in batch.slots) == tuple(entry.sensor_id for entry in entries), "binding")
    for entry, slot in zip(entries, batch.slots):
        period = 1 if entry.kind == "pressure" else entry.configuration.periodTicks
        due = command.tick % period == 0
        require((type(slot) is t.Due) == due, "binding")
        if not due:
            next_tick = (command.tick // period + 1) * period
            require(slot.next_due_tick == (next_tick if next_tick <= prepare.planned_ticks else None), "binding")
            continue
        manifest = slot.typed_manifest
        require(manifest.sensor_contract_digest == entry.sensor_contract_digest, "binding")
        tensor = manifest.tensor
        require(tensor.kind == entry.kind, "binding")
        if entry.kind == "pressure":
            start, end = (command.tick - 1) * 16_000 // 120, command.tick * 16_000 // 120
            require((tensor.sample_start, tensor.sample_end, tensor.shape) == (start, end, (end - start,)), "binding")
        else:
            shape = (entry.configuration.height, entry.configuration.width)
            require(tensor.shape == (shape + (4,) if entry.kind == "rgba8" else shape), "binding")


def tensor_bytes(tensor: t.Tensor) -> int:
    decode("Tensor", raw(tensor))
    return math.prod(tensor.shape) * (8 if tensor.kind == "pressure" else 4 if tensor.kind == "radiance" else 1)


def validate_payload(manifest: t.SensorManifest, byte_manifest: t.BufferManifest, payload: bytes) -> t.SensorReading:
    require(type(payload) is bytes and len(payload) == tensor_bytes(manifest.tensor) == byte_manifest.byte_length, "binding")
    require(hashlib.sha256(payload).hexdigest() == byte_manifest.payload_sha256, "binding")
    kind = manifest.tensor.kind
    if kind != "rgba8":
        for (value,) in struct.iter_unpack("<d" if kind == "pressure" else "<f", payload):
            require(math.isfinite(value))
            if kind == "radiance":
                require(0 <= value <= 10_000)
    return t.SensorReading(manifest, byte_manifest, payload)
