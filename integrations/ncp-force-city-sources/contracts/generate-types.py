"""Generate closed language records from the one installed city schema."""

import itertools
import json
from pathlib import Path
import re
import subprocess
import sys

APP = Path(__file__).resolve().parent.parent
CLIENT = APP.parent / "ncp-force-ground-sensors/python/crebain_ncp_sensors/city"
DEFS = json.loads((APP / "contracts/application.schema.v1.json").read_bytes())["$defs"]
NAMES = {"Command": "CityCommand", "Result": "CityResult"}


def snake(name):
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name).lower()


def scalar(rule, language):
    if rule is False:
        return "Never"
    if "$ref" in rule:
        name = rule["$ref"].rsplit("/", 1)[1]
        return NAMES.get(name, name) if language == "rust" else name
    if "oneOf" in rule:
        choices = [arm for arm in rule["oneOf"] if arm.get("type") != "null"]
        if len(choices) == 1 and len(rule["oneOf"]) == 2:
            inner = scalar(choices[0], language)
            return f"Option<{inner}>" if language == "rust" else f"{inner} | None"
        raise ValueError("named unions required")
    if "const" in rule:
        value = rule["const"]
        kind = (
            "boolean"
            if type(value) is bool
            else "integer"
            if type(value) is int
            else "string"
        )
    elif "enum" in rule:
        kind = "string"
    else:
        kind = rule.get("type")
    kinds = {
        "boolean": ("bool", "bool"),
        "integer": ("u64", "int"),
        "number": ("Finite64", "float"),
        "string": ("String", "str"),
    }
    if kind in kinds:
        return kinds[kind][language == "python"]
    if kind == "array":
        prefix = rule.get("prefixItems")
        if prefix is not None:
            fields = [scalar(item, language) for item in prefix]
            if language == "rust":
                return (
                    f"[{fields[0]}; {len(fields)}]"
                    if len(set(fields)) == 1
                    else "(" + ", ".join(fields) + ",)"
                )
            return "tuple[" + ", ".join(fields) + "]"
        item = scalar(rule["items"], language)
        if language == "rust":
            return (
                f"[{item}; {rule['maxItems']}]"
                if rule["minItems"] == rule["maxItems"] and rule["maxItems"]
                else f"Vec<{item}>"
            )
        return f"tuple[{item}, ...]"
    raise ValueError(rule)


rust = [
    "//! Closed records generated from the installed city schema.",
    "use serde::{Deserialize, Serialize};",
    "use ncp_local::modular_buffer::BufferManifest;",
    "use crate::Finite64;",
    "/// No import capability exists in this application.",
    "#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]",
    "pub enum Never {}",
]
python = [
    '"""Closed immutable city records generated from the installed schema."""',
    "from __future__ import annotations",
    "from dataclasses import dataclass",
    "from typing import Never",
    "from ncp_local.modular_buffer import BufferBinding as BufferBinding, BufferManifest",
    "",
]
aliases = []
prepare_variants = []
constant_decoders = []
for name, rule in DEFS.items():
    if name in ("BufferBinding", "BufferManifest"):
        continue
    rust_name = NAMES.get(name, name)
    rust.append(
        f"/// Installed `{name}` record; relational admission remains separate."
    )
    if rule is False:
        rust.append(f"pub type {rust_name} = Never;")
        aliases.append(f"{name} = Never")
    elif "oneOf" in rule:
        rust.extend(
            [
                "#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]",
                "#[serde(untagged)]",
                f"pub enum {rust_name} {{",
            ]
        )
        arms = []
        for arm in rule["oneOf"]:
            target = arm["$ref"].rsplit("/", 1)[1]
            ty = scalar(arm, "rust")
            if DEFS[target].get("type") == "object":
                ty = f"Box<{ty}>"
            rust.extend(
                [f"    /// The closed `{target}` variant.", f"    {target}({ty}),"]
            )
            arms.append(target)
        rust.append("}")
        aliases.append(f"{name} = " + " | ".join(arms))
    elif rule.get("type") != "object":
        rust.append(f"pub type {rust_name} = {scalar(rule, 'rust')};")
        aliases.append(f"{name} = {scalar(rule, 'python')}")
    else:
        rust.extend(
            [
                "#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]",
                "#[serde(deny_unknown_fields)]",
                f"pub struct {rust_name} {{",
            ]
        )
        fields = rule["properties"]
        optional = [key for key in fields if key not in rule["required"]]
        for key, field in fields.items():
            target = snake(key)
            rust.append(f"    /// Closed member `{key}`.")
            if target != key:
                rust.append(f'    #[serde(rename = "{key}")]')
            ty = scalar(field, "rust")
            if "const" in field:
                # Untagged unions must reject another same-shaped variant during decoding.
                function = "decode_" + snake(name) + "_" + snake(key)
                rust.append(f'    #[serde(deserialize_with = "{function}")]')
                expected = json.dumps(field["const"])
                condition = (
                    ("value" if field["const"] else "!value")
                    if type(field["const"]) is bool
                    else f"value == {expected}"
                )
                constant_decoders.append(
                    f"fn {function}<'de, D: serde::Deserializer<'de>>(input: D) -> Result<{ty}, D::Error> {{\n"
                    f"    let value = <{ty} as Deserialize>::deserialize(input)?;\n"
                    f'    if {condition} {{ Ok(value) }} else {{ Err(serde::de::Error::custom("closed city constant")) }}\n'
                    "}\n"
                )
            if key in optional:
                rust.append(
                    '    #[serde(default, skip_serializing_if = "Option::is_none")]'
                )
                ty = f"Option<{ty}>"
            rust.append(f"    pub {target}: {ty},")
        rust.append("}")
        # The SDK projects every dataclass field. Separate closed records preserve omitted models.
        for selected_bits in itertools.product((False, True), repeat=len(optional)):
            selected = [key for key, enabled in zip(optional, selected_bits) if enabled]
            class_name = (
                name
                if not optional
                else name + ("".join(key.title() for key in selected) or "NoModels")
            )
            python.extend(
                ["@dataclass(frozen=True, slots=True)", f"class {class_name}:"]
            )
            for key, field in fields.items():
                if key not in optional or key in selected:
                    python.append(f"    {key}: {scalar(field, 'python')}")
            python.append("")
            if optional:
                if name != "Prepare":
                    raise ValueError(
                        "optional records need explicit decoder registration"
                    )
                prepare_variants.append((tuple(selected), class_name))
        if optional:
            aliases.append(
                f"{name} = " + " | ".join(row[1] for row in prepare_variants)
            )
    rust.append("")
rust.extend(constant_decoders)
python.extend(aliases)
python.append(
    "PREPARE_CLASSES = {"
    + ", ".join(repr(keys) + ": " + name for keys, name in prepare_variants)
    + "}"
)
rust_text = subprocess.run(
    ["rustup", "run", "1.91.1", "rustfmt", "--edition", "2021", "--emit", "stdout"],
    input="\n".join(rust),
    text=True,
    capture_output=True,
    check=True,
).stdout


def ts_type(rule):
    if rule is False:
        return "never"
    if "$ref" in rule:
        return rule["$ref"].rsplit("/", 1)[1]
    if "const" in rule:
        return json.dumps(rule["const"])
    if "enum" in rule:
        return " | ".join(json.dumps(value) for value in rule["enum"])
    if "oneOf" in rule:
        return " | ".join(ts_type(arm) for arm in rule["oneOf"])
    if "anyOf" in rule:
        return " | ".join(ts_type(arm) for arm in rule["anyOf"])
    kind = rule["type"]
    if kind == "array":
        if "prefixItems" in rule:
            return "[" + ", ".join(ts_type(item) for item in rule["prefixItems"]) + "]"
        if rule["minItems"] == rule["maxItems"]:
            return (
                "["
                + ", ".join(ts_type(rule["items"]) for _ in range(rule["maxItems"]))
                + "]"
            )
        return "Array<" + ts_type(rule["items"]) + ">"
    if kind == "object":
        return (
            "{ "
            + "; ".join(
                json.dumps(key)
                + ("" if key in rule["required"] else "?")
                + ": "
                + ts_type(value)
                for key, value in rule["properties"].items()
            )
            + " }"
        )
    return {
        "boolean": "boolean",
        "integer": "number",
        "number": "number",
        "string": "string",
        "null": "null",
    }[kind]


typescript = (
    "// Closed city records generated from the installed schema.\n"
    + "\n".join(
        "export type " + name + " = " + ts_type(rule) for name, rule in DEFS.items()
    )
    + "\n"
)
typescript = subprocess.run(
    [
        str(APP.parent.parent / "node_modules/.bin/prettier"),
        "--stdin-filepath",
        str(APP / "bridge/types.ts"),
    ],
    input=typescript,
    text=True,
    capture_output=True,
    check=True,
).stdout
outputs = {
    APP / "rust/src/types.rs": rust_text,
    CLIENT / "types.py": "\n".join(python) + "\n",
    APP / "bridge/types.ts": typescript,
}
if sys.argv[1:] not in ([], ["--check"]):
    raise SystemExit("only --check is supported")
for path, text in outputs.items():
    if sys.argv[1:]:
        if path.read_text() != text:
            raise SystemExit("generated city records changed: " + str(path))
    else:
        path.write_text(text)
