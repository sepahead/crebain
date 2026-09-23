"""Derive the optional live-family contract from its two owned schema sources."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess

APP = Path(__file__).resolve().parent.parent
CONTRACTS = APP / "contracts"


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()


def ts_type(schema):
    if schema is False:
        return "never"
    if "$ref" in schema:
        return schema["$ref"].removeprefix("#/$defs/")
    if "const" in schema:
        return json.dumps(schema["const"])
    if "enum" in schema:
        return " | ".join(json.dumps(item) for item in schema["enum"])
    for choice in ("oneOf", "anyOf"):
        if choice in schema:
            return " | ".join(ts_type(item) for item in schema[choice])
    kind = schema["type"]
    if kind in ("integer", "number"):
        return "number"
    if kind in ("string", "boolean", "null"):
        return kind
    if kind == "array":
        if "prefixItems" in schema:
            return "readonly [" + ", ".join(map(ts_type, schema["prefixItems"])) + "]"
        return "ReadonlyArray<" + ts_type(schema["items"]) + ">"
    if kind == "object":
        if schema.get("additionalProperties") is not False or set(schema["required"]) != set(schema["properties"]):
            raise ValueError("family DTOs require closed objects with no optional members")
        return "{ " + "; ".join(
            f"readonly {json.dumps(name)}: {ts_type(value)}"
            for name, value in schema["properties"].items()
        ) + " }"
    raise ValueError("unsupported owned schema type: " + kind)


def py_type(schema):
    if schema is False:
        return "Never"
    if "$ref" in schema:
        return schema["$ref"].removeprefix("#/$defs/")
    if "const" in schema:
        value = schema["const"]
        return "bool" if type(value) is bool else "int" if type(value) is int else "str"
    if "enum" in schema:
        return "str"
    for choice in ("oneOf", "anyOf"):
        if choice in schema:
            return " | ".join(py_type(item) for item in schema[choice])
    kind = schema["type"]
    if kind == "array":
        if "prefixItems" in schema:
            return "tuple[" + ", ".join(map(py_type, schema["prefixItems"])) + "]"
        return "tuple[" + py_type(schema["items"]) + ", ...]"
    return {"integer": "int", "number": "float", "string": "str", "boolean": "bool", "null": "None"}[kind]


def python_types(base, additions):
    needed = set()

    def references(value):
        if type(value) is dict:
            if "$ref" in value:
                name = value["$ref"].removeprefix("#/$defs/")
                if name in base:
                    needed.add(name)
            for item in value.values():
                references(item)
        elif type(value) is list:
            for item in value:
                references(item)

    references(additions)
    text = '"""Generated immutable family DTOs; selectors do not create native authority."""\n\n'
    text += "from __future__ import annotations\n\nfrom dataclasses import dataclass\n\n"
    text += "from .types import (\n" + "".join(f"    {name},\n" for name in sorted(needed)) + ")\n\n"
    aliases = []
    objects = []
    for name, definition in additions.items():
        if definition.get("type") == "object":
            # The same closed-object assertion governs both language projections.
            ts_type(definition)
            objects.append(name)
            text += f"\n@dataclass(frozen=True, slots=True)\nclass {name}:\n"
            text += "".join(f"    {field}: {py_type(value)}\n" for field, value in definition["properties"].items())
        else:
            aliases.append(f"{name} = {py_type(definition)}\n")
    text += "\n\n" + "".join(aliases)
    text += "\n_OBJECT_NAMES = (\n" + "".join(f'    "{name}",\n' for name in objects) + ")\n"
    return text.encode()


def products():
    base_raw = (CONTRACTS / "application.schema.v1.json").read_bytes()
    base = json.loads(base_raw)
    additions = json.loads((CONTRACTS / "family.additions.schema.v1.json").read_bytes())
    if set(base["$defs"]) & set(additions["$defs"]):
        raise ValueError("family definitions cannot override sensor definitions")
    schema = {
        "$schema": base["$schema"],
        "$id": "crebain.force-ground-checkpoint-family.types.v1",
        "$comment": "Generated from the unchanged sensor schema and family.additions.schema.v1.json. Native authority remains in the originating live owner; schema validity is not execution admission.",
        "$defs": {**base["$defs"], **additions["$defs"]},
    }
    raw = encoded(schema)
    if len(raw) > 65_536:
        raise ValueError("family schema exceeds installed resource bound")
    descriptor = {
        "schema": "crebain.ncp-force-ground-checkpoint-family.v1",
        "status": "construction-candidate",
        "types_schema_sha256": hashlib.sha256(raw).hexdigest(),
        "sensor_types_schema_sha256": hashlib.sha256(base_raw).hexdigest(),
        "roles": {
            "canonical": {"Prepare": "CanonicalPrepare", "Command": "CanonicalCommand", "Result": "CanonicalResult", "Finish": "CanonicalFinish", "Terminal": "CanonicalTerminal"},
            "evaluation": {"Prepare": "EvaluationPrepare", "Command": "EvaluationCommand", "Result": "EvaluationResultUnion", "Finish": "EvaluationFinish", "Terminal": "EvaluationTerminal"},
        },
        "imports": "uninhabited",
        "checkpoint_authority": "actual-originating-native-owner-and-retained-handle",
        "maximum_endpoints": 16,
        "maximum_evaluation_slots": 15,
        "maximum_active_native_owners": 2,
        "maximum_encoded_application_result_bytes": 32768,
        "maximum_family_wall_seconds": 600,
        "shared_process_retirement": "pending-until-actual-host-exit",
        "qualified_scope": "none until exact source and installed family gates pass",
    }
    composition = {
        "schema": "crebain.live-checkpoint-family-composition.v1",
        "application_schema_sha256": descriptor["types_schema_sha256"],
        "roles": ["canonical", "evaluation"],
        "endpoint_construction": "one-separate-sdk-owner-and-private-channel-per-frozen-binding",
        "execution": "serialized-native-parent-and-at-most-one-child",
        "checkpoint_export": "absent",
        "capture": "optional-external",
        "monitor": "absent",
        "neural": "absent",
        "experiment": "optional-external",
        "predictor_checkpoint_capability": "absent",
    }
    text = "// Generated from the owned family schema. Semantic and state bounds remain separate.\n"
    for name, definition in schema["$defs"].items():
        text += f"export type {name} = {ts_type(definition)}\n"
    text = subprocess.run(
        ["bun", "x", "--no-install", "prettier", "--stdin-filepath", "bridge/family-types.ts"],
        cwd=APP.parents[1], input=text, text=True, capture_output=True, check=True,
    ).stdout
    generated = {
        CONTRACTS / "family.application.schema.v1.json": raw,
        CONTRACTS / "family.application.descriptor.v1.json": encoded(descriptor),
        CONTRACTS / "family.composition.v1.json": encoded(composition),
        APP / "bridge/family-types.ts": text.encode(),
        APP / "python/crebain_ncp_sensors/family_types.py": python_types(base["$defs"], additions["$defs"]),
    }
    return generated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    for target, raw in products().items():
        if args.write:
            target.write_bytes(raw)
        elif not target.is_file() or target.is_symlink() or target.read_bytes() != raw:
            raise ValueError("generated family contract drift: " + target.name)


if __name__ == "__main__":
    main()
