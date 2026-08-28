#!/usr/bin/env python3
"""Stage one target-native CREBAIN managed-simulation authoring package."""

from __future__ import annotations

import argparse
import os
import shutil
import stat
from pathlib import Path, PurePosixPath
from typing import Any

from managed_simulation_authoring_files import (
    MAX_EXECUTABLE_BYTES,
    MAX_RECIPE_BYTES,
    MAX_SCHEMA_BYTES,
    absolute_without_resolving_leaf,
    copy_regular,
    decode_json_object,
    read_regular,
    read_regular_observed,
    reject,
    safe_relative,
    write_new_regular,
)
from managed_simulation_build_provenance import (
    NO_AUTHORITY,
    STAGE_RECEIPT_SCHEMA,
    TARGET,
    canonical,
    executable_identity,
    sha256,
    validate_build_receipt,
    validate_stage_receipt,
)


ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "integrations" / "engram" / "managed-simulation"
DEFAULT_BINARY = (
    ROOT
    / "src-tauri"
    / "target"
    / "managed-simulation-bootstrap"
    / "crebain-managed-simulation"
)
DEFAULT_OUTPUT = INTEGRATION / "package"
DEFAULT_BUILD_RECEIPT = INTEGRATION / "build" / "observed-build-receipt.json"
DEFAULT_STAGE_RECEIPT = INTEGRATION / "package-stage-receipt.json"


def stage(
    binary: Path,
    output: Path,
    recipe_path: Path,
    build_receipt_path: Path,
    stage_receipt_path: Path,
) -> None:
    if output.exists() or output.is_symlink():
        reject(f"output already exists: {output}")
    if stage_receipt_path.exists() or stage_receipt_path.is_symlink():
        reject(f"stage receipt already exists: {stage_receipt_path}")
    if output.parent.resolve(strict=True) != output.parent:
        reject("package output parent must not use a symlink")
    if stage_receipt_path.parent.resolve(strict=True) != stage_receipt_path.parent:
        reject("stage receipt parent must not use a symlink")
    recipe_bytes = read_regular(recipe_path, MAX_RECIPE_BYTES)
    recipe = decode_json_object(recipe_bytes, label=str(recipe_path))
    build_receipt_bytes = read_regular(build_receipt_path, MAX_RECIPE_BYTES)
    build_receipt = validate_build_receipt(
        decode_json_object(build_receipt_bytes, label=str(build_receipt_path))
    )
    if build_receipt_bytes != canonical(build_receipt) + b"\n":
        reject("observed-build receipt must use exact canonical JSON bytes")
    workspace = recipe_path.parent
    executable = recipe.get("executable")
    schemas = recipe.get("schemas")
    if not isinstance(executable, dict) or not isinstance(schemas, list) or not schemas:
        reject("recipe executable and schema roster are required")
    executable_path = safe_relative(executable.get("package_relative_path"))
    if executable_path.parts[0] != "bin":
        reject("executable must be staged below bin/")

    schema_rows: list[tuple[Path, PurePosixPath, str]] = []
    seen_paths: set[PurePosixPath] = set()
    schema_ids: list[str] = []
    for schema in schemas:
        if not isinstance(schema, dict) or set(schema) != {
            "schema_id",
            "package_relative_path",
        }:
            reject("schema row must be one closed object")
        schema_id = schema.get("schema_id")
        if not isinstance(schema_id, str) or not schema_id:
            reject("schema ID must be a nonempty string")
        relative = safe_relative(schema.get("package_relative_path"))
        if relative.parts[0] != "contracts" or relative in seen_paths:
            reject("schema paths must be unique and below contracts/")
        seen_paths.add(relative)
        schema_ids.append(schema_id)
        schema_rows.append((workspace.joinpath(*relative.parts), relative, schema_id))
    if schema_ids != sorted(schema_ids) or len(schema_ids) != len(set(schema_ids)):
        reject("schema IDs must be sorted and unique")

    configuration_path = safe_relative(recipe.get("configuration_path"))
    configuration = workspace.joinpath(*configuration_path.parts)
    configuration_bytes = read_regular(configuration, MAX_RECIPE_BYTES)

    binary_payload, binary_observation = read_regular_observed(
        binary, MAX_EXECUTABLE_BYTES
    )
    source_identity = executable_identity(binary_payload, binary_observation.st_mode)
    expected_output = build_receipt["output"]
    if source_identity != {
        "byte_length": expected_output["byte_length"],
        "sha256": expected_output["sha256"],
        "mode": expected_output["source_mode"],
        "format": expected_output["format"],
        "architecture": expected_output["architecture"],
        "file_type": expected_output["file_type"],
    }:
        reject("source executable differs from its observed-build receipt")

    output.mkdir(parents=True, mode=0o700)
    os.chmod(output, 0o700)
    receipt_created = False
    try:
        copy_regular(
            binary, output.joinpath(*executable_path.parts), 0o700, MAX_EXECUTABLE_BYTES
        )
        for source, relative, _schema_id in schema_rows:
            copy_regular(
                source, output.joinpath(*relative.parts), 0o600, MAX_SCHEMA_BYTES
            )
        staged_path = output.joinpath(*executable_path.parts)
        staged_payload, staged_observation = read_regular_observed(
            staged_path, MAX_EXECUTABLE_BYTES
        )
        staged_identity = executable_identity(
            staged_payload, staged_observation.st_mode
        )
        inventory: list[dict[str, Any]] = [
            {
                "relative_path": executable_path.as_posix(),
                "byte_length": len(staged_payload),
                "sha256": sha256(staged_payload),
                "mode": stat.S_IMODE(staged_observation.st_mode),
                "role": "executable",
            }
        ]
        for _source, relative, _schema_id in schema_rows:
            staged_schema = output.joinpath(*relative.parts)
            payload, observed = read_regular_observed(staged_schema, MAX_SCHEMA_BYTES)
            inventory.append(
                {
                    "relative_path": relative.as_posix(),
                    "byte_length": len(payload),
                    "sha256": sha256(payload),
                    "mode": stat.S_IMODE(observed.st_mode),
                    "role": "contract",
                }
            )
        inventory.sort(key=lambda row: row["relative_path"])
        receipt = {
            "schema_version": STAGE_RECEIPT_SCHEMA,
            "observed_build_receipt_exact_sha256": sha256(build_receipt_bytes),
            "observed_build_receipt_sha256": build_receipt["receipt_sha256"],
            "crebain_commit": build_receipt["repository"]["commit"],
            "crebain_tree": build_receipt["repository"]["tree"],
            "origin_main": build_receipt["repository"]["origin_main"],
            "target": TARGET,
            "recipe_exact_sha256": sha256(recipe_bytes),
            "configuration_exact_sha256": sha256(configuration_bytes),
            "source_executable": source_identity,
            "staged_executable": staged_identity,
            "package_inventory": inventory,
            "package_inventory_sha256": sha256(canonical(inventory)),
            "authority": NO_AUTHORITY,
            "disclosure": (
                "This receipt joins one observed build to staged package bytes. "
                "It grants no execution, installation, or deployment authority."
            ),
        }
        receipt["receipt_sha256"] = sha256(canonical(receipt))
        validate_stage_receipt(
            receipt,
            build_receipt=build_receipt,
            build_receipt_bytes=build_receipt_bytes,
        )
        write_new_regular(
            stage_receipt_path,
            canonical(receipt) + b"\n",
            label="package-stage receipt",
        )
        receipt_created = True
    except BaseException:
        shutil.rmtree(output)
        if (
            receipt_created
            and stage_receipt_path.exists()
            and not stage_receipt_path.is_symlink()
        ):
            stage_receipt_path.unlink()
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--build-receipt", type=Path, default=DEFAULT_BUILD_RECEIPT)
    parser.add_argument("--stage-receipt", type=Path, default=DEFAULT_STAGE_RECEIPT)
    parser.add_argument(
        "--recipe",
        type=Path,
        default=INTEGRATION / "authoring.macos-aarch64-darwin.json",
    )
    arguments = parser.parse_args()
    binary = absolute_without_resolving_leaf(arguments.binary)
    output = absolute_without_resolving_leaf(arguments.output)
    recipe = absolute_without_resolving_leaf(arguments.recipe)
    build_receipt = absolute_without_resolving_leaf(arguments.build_receipt)
    stage_receipt = absolute_without_resolving_leaf(arguments.stage_receipt)
    stage(binary, output, recipe, build_receipt, stage_receipt)
    print(f"OK: staged managed simulation package at {output}")


if __name__ == "__main__":
    main()
