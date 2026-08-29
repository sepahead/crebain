#!/usr/bin/env python3
"""Build closed synthetic provenance fixtures for provider-free tests."""

from __future__ import annotations

import hashlib
import json
import math
import struct
from collections.abc import Mapping, Sequence
from typing import Any

from managed_simulation_build_provenance import (
    BUILD_CONTRACT_PATHS,
    BUILD_RECEIPT_SCHEMA,
    EXPECTED_CARGO_ARGV,
    NO_AUTHORITY,
    PACK_RECEIPT_SCHEMA,
    STAGE_RECEIPT_SCHEMA,
    TARGET,
    canonical,
    sha256,
)


SOURCE_PATHS = [
    "rust-toolchain.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/crates/managed-simulation/Cargo.toml",
    "src-tauri/crates/managed-simulation/src/lib.rs",
    "src-tauri/crates/managed-simulation/src/main.rs",
    "src-tauri/src/pid_observation.rs",
    "src-tauri/src/sensor_fusion.rs",
    *sorted(BUILD_CONTRACT_PATHS),
]
GENERATOR_PATHS = [
    "scripts/build-managed-simulation-bootstrap.py",
    "scripts/managed_simulation_authoring_files.py",
    "scripts/managed_simulation_build_provenance.py",
]

WORKER_MODULE_NAMES = (
    "backend.core",
    "backend.core.errors",
    "backend.core.units",
    "backend.integrations",
    "backend.integrations.contained_exec_gate",
    "backend.integrations.managed_runtime_contract",
    "backend.integrations.managed_runtime_json",
    "backend.integrations.managed_runtime_manager_contract",
    "backend.neurocontrol",
    "backend.neurocontrol.backends",
    "backend.neurocontrol.bus",
    "backend.neurocontrol.codec",
    "backend.neurocontrol.loop",
    "backend.neurocontrol.profiles",
    "backend.neurocontrol.protocol",
    "backend.neurocontrol.service",
    "backend.neurocontrol.session",
    "backend.neurocontrol.transport",
    "backend.optimization",
    "backend.optimization.extension_closed_loop",
    "backend.optimization.extension_closed_loop_limits",
    "backend.optimization.extension_closed_loop_nest",
    "backend.optimization.extension_closed_loop_nest_process",
    "backend.optimization.simulator_study_ledger",
    "backend.schemas",
    "backend.schemas.evidence",
    "backend.schemas.runtime",
    "backend.schemas.simulator_study",
)

HOST_MODULE_NAMES = tuple(
    sorted(
        {
            *WORKER_MODULE_NAMES,
            "backend.integrations.extension_package_store",
            "backend.integrations.extension_package_v2_contract",
            "backend.integrations.managed_runtime_authoring",
            "backend.integrations.reviewed_native_development_session",
            "backend.integrations.reviewed_native_process_guardian",
            "backend.integrations.standard_closed_loop_simulator",
            "backend.optimization.extension_closed_loop_nest_evidence",
            "backend.optimization.extension_closed_loop_receipt_store",
            "scripts",
            "scripts.engram_extension",
        }
    )
)

EXERCISED_ENTRYPOINTS = (
    (
        "nest-guardian",
        "backend/optimization/extension_closed_loop_nest_guardian.py",
    ),
    (
        "nest-worker",
        "backend/optimization/extension_closed_loop_nest_worker.py",
    ),
    (
        "reviewed-runtime-guardian",
        "backend/integrations/reviewed_native_process_guardian.py",
    ),
)


def _managed_runtime_float_text(value: float) -> str:
    """Render one binary64 value with the Host API 2 spelling rules."""

    if type(value) is not float:
        raise TypeError("fixture managed-runtime float is not a float")
    if (
        not math.isfinite(value)
        or abs(value) > 1.0e300
        or (value == 0.0 and math.copysign(1.0, value) < 0.0)
    ):
        raise ValueError("fixture managed-runtime float is not portable")
    negative = value < 0.0
    source = repr(abs(value)).lower()
    if "e" in source:
        mantissa, exponent_text = source.split("e", 1)
        exponent = int(exponent_text)
        digits = mantissa.replace(".", "").lstrip("0").rstrip("0") or "0"
        decimal_point = exponent + 1
    else:
        integer, dot, fraction = source.partition(".")
        combined = integer + (fraction if dot else "")
        first = next(
            (index for index, character in enumerate(combined) if character != "0"),
            None,
        )
        if first is None:
            return "0.0"
        decimal_point = len(integer) - first
        digits = combined[first:].rstrip("0")
    trailing_zero_count = decimal_point - len(digits)
    if 0 <= trailing_zero_count and decimal_point <= 16:
        rendered = digits + ("0" * trailing_zero_count) + ".0"
    elif 0 < decimal_point <= 16:
        rendered = digits[:decimal_point] + "." + digits[decimal_point:]
    elif -5 < decimal_point <= 0:
        rendered = "0." + ("0" * (-decimal_point)) + digits
    else:
        exponent = decimal_point - 1
        exponent_text = f"+{exponent}" if exponent >= 0 else str(exponent)
        rendered = (
            f"{digits}e{exponent_text}"
            if len(digits) == 1
            else f"{digits[0]}.{digits[1:]}e{exponent_text}"
        )
    return f"-{rendered}" if negative else rendered


def managed_runtime_canonical(value: Any) -> bytes:
    """Encode synthetic Host API 2 documents without importing Engram."""

    active: set[int] = set()
    nodes = 0

    def encode(current: Any, depth: int) -> bytes:
        nonlocal nodes
        nodes += 1
        if nodes > 1_000_000 or depth > 64:
            raise ValueError("fixture managed-runtime JSON exceeds its structure bound")
        if current is None:
            return b"null"
        if current is True:
            return b"true"
        if current is False:
            return b"false"
        if type(current) is int:
            if abs(current) > 9_007_199_254_740_991:
                raise ValueError(
                    "fixture managed-runtime JSON integer exceeds the exact range"
                )
            return str(current).encode("ascii")
        if type(current) is float:
            return _managed_runtime_float_text(current).encode("ascii")
        if type(current) is str:
            if any(
                0xD800 <= ord(character) <= 0xDFFF
                or ord(character) == 0xFFFD
                or 0xFDD0 <= ord(character) <= 0xFDEF
                or (ord(character) & 0xFFFF) in {0xFFFE, 0xFFFF}
                or (ord(character) < 0x20 and character not in {"\t", "\n", "\r"})
                or 0x7F <= ord(character) <= 0x9F
                for character in current
            ):
                raise ValueError(
                    "fixture managed-runtime JSON contains nonportable Unicode"
                )
            return json.dumps(
                current,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        is_mapping = isinstance(current, Mapping)
        is_sequence = isinstance(current, Sequence) and not isinstance(
            current, (str, bytes, bytearray)
        )
        if not is_mapping and not is_sequence:
            raise TypeError("fixture managed-runtime JSON contains an invalid value")
        identity = id(current)
        if identity in active:
            raise ValueError("fixture managed-runtime JSON contains a cycle")
        active.add(identity)
        try:
            if is_mapping:
                if any(type(key) is not str for key in current):
                    raise TypeError(
                        "fixture managed-runtime JSON object key is not a string"
                    )
                members = (
                    encode(key, depth + 1) + b":" + encode(current[key], depth + 1)
                    for key in sorted(current)
                )
                return b"{" + b",".join(members) + b"}"
            return b"[" + b",".join(encode(item, depth + 1) for item in current) + b"]"
        finally:
            active.remove(identity)

    return encode(value, 1)


def _fixture_sha(label: str) -> str:
    return sha256(f"CREBAIN synthetic Engram b6 fixture: {label}".encode())


def _seal_canonical(
    document: dict[str, Any], field: str = "receipt_sha256"
) -> dict[str, Any]:
    document[field] = sha256(canonical(document))
    return document


def _seal_managed(
    document: dict[str, Any], field: str = "receipt_sha256"
) -> dict[str, Any]:
    document[field] = sha256(managed_runtime_canonical(document))
    return document


def macho_arm64(*, cpu_type: int = 0x0100000C, file_type: int = 2) -> bytes:
    command_bytes = 72 + 24
    header_bytes = 32
    code = b"\x1f\x20\x03\xd5" * 8
    file_size = header_bytes + command_bytes + len(code)
    header = b"\xcf\xfa\xed\xfe" + struct.pack(
        "<IIIIIII",
        cpu_type,
        0,
        file_type,
        2,
        command_bytes,
        0,
        0,
    )
    text_segment = struct.pack(
        "<II16sQQQQiiII",
        0x19,
        72,
        b"__TEXT".ljust(16, b"\0"),
        0x1_0000_0000,
        4096,
        0,
        file_size,
        7,
        5,
        0,
        0,
    )
    main_entry = struct.pack("<IIQQ", 0x80000028, 24, header_bytes + command_bytes, 0)
    return header + text_segment + main_entry + code


def source_row(path: str) -> dict[str, Any]:
    payload = f"synthetic committed fixture: {path}\n".encode()
    return {
        "relative_path": path,
        "size_bytes": len(payload),
        "sha256": sha256(payload),
        "git_mode": "100755" if path.endswith(".py") else "100644",
        "git_blob": hashlib.sha1(payload, usedforsecurity=False).hexdigest(),
    }


def build_receipt(binary: bytes, *, source_mode: int = 0o755) -> dict[str, Any]:
    source_rows = [source_row(path) for path in SOURCE_PATHS]
    source_rows.sort(key=lambda row: row["relative_path"])
    generator_rows = [source_row(path) for path in GENERATOR_PATHS]
    generator_rows.sort(key=lambda row: row["relative_path"])
    repository = {
        "origin": "https://github.com/sepahead/crebain.git",
        "commit": "a" * 40,
        "tree": "b" * 40,
        "origin_main": "a" * 40,
        "object_format": "sha1",
        "clean": True,
    }
    source = {
        "policy": "clean-origin-main-git-blob-and-rustc-dep-info-build-inputs.v1",
        "files": source_rows,
        "roster_sha256": sha256(canonical(source_rows)),
    }
    generator = {
        "files": generator_rows,
        "roster_sha256": sha256(canonical(generator_rows)),
    }
    by_path = {row["relative_path"]: row for row in source_rows}
    cargo = {
        "workspace_manifest_path": "src-tauri/Cargo.toml",
        "workspace_manifest_exact_sha256": by_path["src-tauri/Cargo.toml"]["sha256"],
        "package_manifest_path": "src-tauri/crates/managed-simulation/Cargo.toml",
        "package_manifest_exact_sha256": by_path[
            "src-tauri/crates/managed-simulation/Cargo.toml"
        ]["sha256"],
        "lock_path": "src-tauri/Cargo.lock",
        "lock_exact_sha256": by_path["src-tauri/Cargo.lock"]["sha256"],
        "toolchain_path": "rust-toolchain.toml",
        "toolchain_exact_sha256": by_path["rust-toolchain.toml"]["sha256"],
        "rust_toolchain": "1.91.1",
        "rustc_version": "rustc 1.91.1 (ed61e7d7e 2025-11-07)",
        "cargo_version": "cargo 1.91.1 (ea2d97820 2025-10-10)",
        "argv": EXPECTED_CARGO_ARGV,
        "profile": "release",
        "target": TARGET,
        "target_directory_policy": "fresh-fixed-owner-private-removed-after-copy.v1",
        "environment_policy": "reject-build-override-environment-and-record-output-bytes.v1",
    }
    input_identity = {
        "repository": repository,
        "source_roster_sha256": source["roster_sha256"],
        "generator_roster_sha256": generator["roster_sha256"],
        "cargo": cargo,
    }
    receipt: dict[str, Any] = {
        "schema_version": BUILD_RECEIPT_SCHEMA,
        "repository": repository,
        "source": source,
        "generator": generator,
        "cargo": cargo,
        "output": {
            "file_name": "crebain-managed-simulation",
            "byte_length": len(binary),
            "sha256": sha256(binary),
            "source_mode": source_mode,
            "format": "mach-o-64",
            "architecture": "arm64",
            "file_type": "executable",
        },
        "input_identity_sha256": sha256(canonical(input_identity)),
        "claims": {
            "observed_local_build": True,
            "reproducible_build": False,
            "signature": False,
            "external_dependency_bytes_attested": False,
            "complete_environment_attested": False,
        },
        "authority": NO_AUTHORITY,
        "disclosure": "Synthetic observed-build receipt for provider-free tests only.",
    }
    receipt["receipt_sha256"] = sha256(canonical(receipt))
    return receipt


def stage_receipt(
    build: dict[str, Any],
    inventory: list[dict[str, Any]],
    *,
    recipe_bytes: bytes,
    configuration_bytes: bytes,
) -> dict[str, Any]:
    build_bytes = canonical(build) + b"\n"
    output = build["output"]
    source = {
        "byte_length": output["byte_length"],
        "sha256": output["sha256"],
        "mode": output["source_mode"],
        "format": output["format"],
        "architecture": output["architecture"],
        "file_type": output["file_type"],
    }
    receipt: dict[str, Any] = {
        "schema_version": STAGE_RECEIPT_SCHEMA,
        "observed_build_receipt_exact_sha256": sha256(build_bytes),
        "observed_build_receipt_sha256": build["receipt_sha256"],
        "crebain_commit": build["repository"]["commit"],
        "crebain_tree": build["repository"]["tree"],
        "origin_main": build["repository"]["origin_main"],
        "target": TARGET,
        "recipe_exact_sha256": sha256(recipe_bytes),
        "configuration_exact_sha256": sha256(configuration_bytes),
        "source_executable": source,
        "staged_executable": {**source, "mode": 0o700},
        "package_inventory": inventory,
        "package_inventory_sha256": sha256(canonical(inventory)),
        "authority": NO_AUTHORITY,
        "disclosure": "Synthetic package-stage receipt for provider-free tests only.",
    }
    receipt["receipt_sha256"] = sha256(canonical(receipt))
    return receipt


def pack_receipt(
    build: dict[str, Any],
    stage: dict[str, Any],
    *,
    seal_bytes: bytes,
    bundle_bytes: bytes,
    package_generation_id: str,
    engram_repository: dict[str, Any] | None = None,
    engram_tool: dict[str, Any] | None = None,
) -> dict[str, Any]:
    tool_payload = b"synthetic committed Engram extension tool\n"
    repository = engram_repository or {
        "origin": "https://github.com/sepahead/engram.git",
        "commit": "c" * 40,
        "tree": "d" * 40,
        "origin_main": "c" * 40,
        "object_format": "sha1",
        "clean": True,
    }
    tool = engram_tool or {
        "relative_path": "scripts/engram_extension.py",
        "size_bytes": len(tool_payload),
        "sha256": sha256(tool_payload),
        "git_mode": "100755",
        "git_blob": hashlib.sha1(tool_payload, usedforsecurity=False).hexdigest(),
    }
    build_bytes = canonical(build) + b"\n"
    stage_bytes = canonical(stage) + b"\n"
    receipt: dict[str, Any] = {
        "schema_version": PACK_RECEIPT_SCHEMA,
        "engram_repository": repository,
        "engram_tool": tool,
        "verification_policy": (
            "clean-head-origin-main-committed-tool-before-and-after-each-operation.v1"
        ),
        "operations": [
            {"operation": "pack", "exit_code": 0, "source_reverified": True},
            {"operation": "check", "exit_code": 0, "source_reverified": True},
        ],
        "observed_build_receipt_exact_sha256": sha256(build_bytes),
        "observed_build_receipt_sha256": build["receipt_sha256"],
        "package_stage_receipt_exact_sha256": sha256(stage_bytes),
        "package_stage_receipt_sha256": stage["receipt_sha256"],
        "seal_receipt_exact_sha256": sha256(seal_bytes),
        "bundle_receipt_exact_sha256": sha256(bundle_bytes),
        "package_generation_id": package_generation_id,
        "claims": {
            "local_pack_observed": True,
            "local_check_observed": True,
            "publisher_authenticated": False,
            "signature": False,
            "reproducible": False,
            "executed_tool_loaded_bytes_attested": False,
            "complete_python_environment_attested": False,
        },
        "authority": NO_AUTHORITY,
        "disclosure": (
            "Synthetic Engram pack receipt for provider-free tests only. "
            "It does not attest loaded interpreter or imported-module bytes."
        ),
    }
    receipt["receipt_sha256"] = sha256(canonical(receipt))
    return receipt


def installed_proof(
    build: dict[str, Any],
    stage: dict[str, Any],
    pack: dict[str, Any],
) -> dict[str, Any]:
    standard_schemas = {
        "engram.closed-loop-simulator.finish-request.v3": "486d0b94e229000b03eec04b0c6e05e6b01c9be1df1090d1c58c27bf14b09880",
        "engram.closed-loop-simulator.finish-response.v3": "abf670d295150b6f20d088aa88365e98f73fa4d0042859f7aa5d7a2403a45d9e",
        "engram.closed-loop-simulator.prepare-request.v3": "a5376511d1ba2edeef1b144074423bafc9fd88562893e3f2a4bba9718fc67e34",
        "engram.closed-loop-simulator.prepare-response.v3": "06fd034822ae82e164d2c14be034e0286b4f02d1345be076affebdd84fa5348a",
        "engram.closed-loop-simulator.step-request.v3": "aafb7c6574e83ba386acb4c10b81e5f9f4c1669e6b79208d86701b06fa473bb2",
        "engram.closed-loop-simulator.step-response.v3": "bac8b67dcd19fbd7addbf825cb1f3b1bf796fe28f638a84380bf906b32fcdb39",
    }

    def fixture_digest(label: str) -> str:
        return sha256(f"synthetic installed proof: {label}".encode())

    build_bytes = canonical(build) + b"\n"
    stage_bytes = canonical(stage) + b"\n"
    pack_bytes = canonical(pack) + b"\n"
    proof: dict[str, Any] = {
        "schema_version": "crebain.standard-v3-installed-binary-proof.v3",
        "observed_build_receipt_exact_sha256": sha256(build_bytes),
        "observed_build_receipt_sha256": build["receipt_sha256"],
        "observed_build_receipt": build,
        "package_stage_receipt_exact_sha256": sha256(stage_bytes),
        "package_stage_receipt_sha256": stage["receipt_sha256"],
        "package_stage_receipt": stage,
        "engram_pack_receipt_exact_sha256": sha256(pack_bytes),
        "engram_pack_receipt_sha256": pack["receipt_sha256"],
        "engram_pack_receipt": pack,
        "crebain_commit": build["repository"]["commit"],
        "crebain_tree": build["repository"]["tree"],
        "crebain_origin_main": build["repository"]["origin_main"],
        "engram_commit": pack["engram_repository"]["commit"],
        "engram_tree": pack["engram_repository"]["tree"],
        "engram_origin_main": pack["engram_repository"]["origin_main"],
        "engram_extension_tool_sha256": pack["engram_tool"]["sha256"],
        "engram_extension_tool_git_blob": pack["engram_tool"]["git_blob"],
        "build_source_roster_sha256": build["source"]["roster_sha256"],
        "build_input_identity_sha256": build["input_identity_sha256"],
        "executable_format": "mach-o-64",
        "executable_architecture": "arm64",
        "store_id": "extstore_" + fixture_digest("store"),
        "package_generation_id": pack["package_generation_id"],
        "installation_id": "inst_" + fixture_digest("installation"),
        "generation_core_sha256": fixture_digest("generation core"),
        "bundle_receipt_exact_sha256": pack["bundle_receipt_exact_sha256"],
        "seal_receipt_exact_sha256": pack["seal_receipt_exact_sha256"],
        "install_observation_exact_sha256": fixture_digest("install observation"),
        "manifest_exact_sha256": fixture_digest("manifest"),
        "package_lock_exact_sha256": fixture_digest("package lock"),
        "configuration_exact_sha256": stage["configuration_exact_sha256"],
        "package_sha256": fixture_digest("package"),
        "executable_sha256": build["output"]["sha256"],
        "configuration_canonical_sha256": fixture_digest("configuration"),
        "operation_roster_sha256": fixture_digest("operations"),
        "operation_ids": [
            "crebain.simulation.finish.v1",
            "crebain.simulation.finish.v3",
            "crebain.simulation.prepare.v1",
            "crebain.simulation.prepare.v3",
            "crebain.simulation.step.v1",
            "crebain.simulation.step.v3",
        ],
        "standard_schema_sha256": standard_schemas,
        "drone_counts": [1, 2, 3],
        "step_count": 6,
        "fault_step": 3,
        "fault": "sensor-unavailable",
        "host_policy": [
            "fault-observed",
            "safe-hold",
            "bounded-zero-washout",
            "bounded-nonzero-resume",
        ],
        "recovery_controls_sha256": {
            "1": fixture_digest("one drone"),
            "2": fixture_digest("two drones"),
            "3": fixture_digest("three drones"),
        },
        "baseline_three_controls_sha256": fixture_digest("baseline"),
        "replay_exact": True,
        "unaffected_lane_observations_exact": True,
        "negative_clock_gate": "standard.clock-mismatch",
        "signal_cancellation_gate": "active-SIGTERM-then-fresh-generation-prepared",
        "installed_artifacts_reverified_after_execution": True,
        "generation_seal_package_bundle_store_lineage_verified": True,
        "build_stage_seal_install_lineage_verified": True,
        "build_stage_seal_pack_install_lineage_verified": True,
        "authority": {
            "simulator_only": True,
            "ncp_qualified": False,
            "physical_actuation": False,
            "plant_control": False,
            "scientific_authority": False,
        },
        "disclosure": "Synthetic installed proof for provider-free tests only.",
    }
    proof["receipt_sha256"] = sha256(canonical(proof))
    return proof


def _module_relative_path(module_name: str) -> str:
    package_modules = {
        "backend.core",
        "backend.integrations",
        "backend.neurocontrol",
        "backend.optimization",
        "backend.schemas",
        "scripts",
    }
    base = module_name.replace(".", "/")
    return f"{base}/__init__.py" if module_name in package_modules else f"{base}.py"


def _source_fixture_payload(relative_path: str) -> bytes:
    return f"# synthetic Engram b6 source: {relative_path}\n".encode()


def _source_fixture_row(relative_path: str) -> dict[str, Any]:
    payload = _source_fixture_payload(relative_path)
    return {
        "relative_path": relative_path,
        "size_bytes": len(payload),
        "sha256": sha256(payload),
        "git_mode": "100755"
        if relative_path == "scripts/engram_extension.py"
        else "100644",
        "git_blob": hashlib.sha1(payload, usedforsecurity=False).hexdigest(),
    }


def engram_source_closure_fixture(
    *,
    installed: Mapping[str, Any],
    reviewed_handshake_sha256: str,
    reviewed_exec_gate_command_sha256: str,
    worker_project_source_roster_sha256: str,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Build the exact host, worker, and entrypoint source-union fixture."""

    host_modules = [
        {
            "module_name": module_name,
            "relative_path": _module_relative_path(module_name),
        }
        for module_name in HOST_MODULE_NAMES
    ]
    worker_modules = [
        {
            "module_name": module_name,
            "relative_path": _module_relative_path(module_name),
        }
        for module_name in WORKER_MODULE_NAMES
    ]
    entrypoints = [
        {"role": role, "relative_path": relative_path}
        for role, relative_path in EXERCISED_ENTRYPOINTS
    ]
    relative_paths = sorted(
        {
            item["relative_path"]
            for item in [*host_modules, *worker_modules, *entrypoints]
        }
    )
    by_path = {
        relative_path: _source_fixture_row(relative_path)
        for relative_path in relative_paths
    }
    tool = installed["engram_pack_receipt"]["engram_tool"]
    by_path["scripts/engram_extension.py"] = dict(tool)
    sources = [by_path[path] for path in sorted(by_path)]
    repository = installed["engram_pack_receipt"]["engram_repository"]
    closure: dict[str, Any] = {
        "schema_version": "crebain.engram-python-source-closure.v1",
        "discovery_policy": (
            "loaded-host-modules-plus-worker-runtime-identity-and-entrypoints.v1"
        ),
        "git": {
            "repository": repository["origin"],
            "commit": repository["commit"],
            "tree": repository["tree"],
            "origin_main": repository["origin_main"],
            "object_format": repository["object_format"],
            "clean": repository["clean"],
        },
        "source_roster_sha256": sha256(
            b"crebain.engram-source-roster.v1\0" + canonical(sources)
        ),
        "host_modules": host_modules,
        "worker_project_modules": worker_modules,
        "worker_project_source_roster_sha256": (worker_project_source_roster_sha256),
        "reviewed_runtime_handshake_receipt_sha256": reviewed_handshake_sha256,
        "reviewed_runtime_guardian_source_sha256": by_path[
            "backend/integrations/reviewed_native_process_guardian.py"
        ]["sha256"],
        "reviewed_runtime_exec_gate_source_sha256": by_path[
            "backend/integrations/contained_exec_gate.py"
        ]["sha256"],
        "reviewed_runtime_exec_gate_command_sha256": (
            reviewed_exec_gate_command_sha256
        ),
        "exercised_entrypoints": entrypoints,
        "sources": sources,
    }
    closure["closure_sha256"] = sha256(canonical(closure))
    return closure, by_path


def reviewed_runtime_fixture(
    *,
    installed: Mapping[str, Any],
    guardian_source_sha256: str,
    exec_gate_source_sha256: str,
    python_executable_sha256: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build the complete reviewed-native command and lifecycle closure."""

    command = _seal_canonical(
        {
            "schema_version": "engram.contained-exec-command.v1",
            "python_executable_sha256": python_executable_sha256,
            "exec_gate_source_sha256": exec_gate_source_sha256,
            "argument_shape": [
                "python",
                "-I",
                "-S",
                "-c",
                "frozen-exec-gate-source",
                "--gate-fd",
                "descriptor",
                "--ready-fd",
                "descriptor",
                "--expected-session-id",
                "supervisor-session-id",
                "target-command",
            ],
            "target_command_sha256": _fixture_sha("reviewed target command"),
        },
        "exec_gate_command_sha256",
    )
    generation_id = "gen_" + _fixture_sha("reviewed generation")
    process_group_id = 41_000
    handshake = _seal_canonical(
        {
            "schema_version": "engram.reviewed-native-development-handshake.v1",
            "profile": "engram.reviewed-native-development.v1",
            "extension_id": "sepahead.crebain.simulation",
            "extension_version": "0.1.0",
            "target_id": "macos-aarch64-darwin",
            "installation_id": installed["installation_id"],
            "generation_id": generation_id,
            "generation_ordinal": 1,
            "launch_source": "package-store-lease",
            "store_id": installed["store_id"],
            "package_generation_id": installed["package_generation_id"],
            "executable_sha256": installed["executable_sha256"],
            "validator_set_sha256": _fixture_sha("reviewed validator set"),
            "host_handshake_frame_sha256": _fixture_sha("reviewed host frame"),
            "runtime_handshake_frame_sha256": _fixture_sha("reviewed runtime frame"),
            "exec_gate_source_sha256": exec_gate_source_sha256,
            "exec_gate_command_sha256": command["exec_gate_command_sha256"],
            "guardian_source_sha256": guardian_source_sha256,
            "guardian_command_sha256": _fixture_sha("reviewed guardian command"),
            "guardian_ready_frame_sha256": _fixture_sha("reviewed guardian ready"),
            "sandbox_profile_sha256": _fixture_sha("reviewed sandbox profile"),
            "sandbox_launcher_sha256": _fixture_sha("reviewed sandbox launcher"),
            "process_pid": process_group_id,
            "guardian_pid": process_group_id + 1,
            "process_group_id": process_group_id,
            "session_id": process_group_id - 1,
            "generation_directory_identity_sha256": _fixture_sha(
                "reviewed generation directory"
            ),
            "handshake_transcript_accepted": True,
            "child_ready_claim": False,
            "host_local_admission": True,
            "process_launch_performed": True,
            "explicit_absolute_path_spawn": True,
            "path_lookup_at_spawn": True,
            "package_path_reopened_for_spawn": False,
            "verified_executable_staged": True,
            "staged_executable_owner_private": True,
            "staged_executable_user_immutable": True,
            "process_group_containment": True,
            "runtime_process_group_leader": True,
            "guardian_group_member": True,
            "guardian_owner_loss_seal": True,
            "guardian_generation_lease_retained": True,
            "guardian_uncertainty_record_prepared": True,
            "descendant_creation_denied": True,
            "os_sandbox_enforced": True,
            "network_isolation_enforced": True,
            "filesystem_isolation_enforced": False,
            "external_dependency_closure_attested": False,
            "automatic_restart": False,
            "publisher_authenticated": False,
            "package_generation_lease_retained": True,
            "durable_process_launch_authority": False,
            "replayable_live_launch_authority": False,
            "ncp_authority": False,
            "physical_authority": False,
            "scientific_authority": False,
        }
    )
    termination = _seal_canonical(
        {
            "schema_version": "engram.reviewed-native-development-termination.v1",
            "handshake_receipt_sha256": handshake["receipt_sha256"],
            "generation_id": generation_id,
            "guardian_pid": handshake["guardian_pid"],
            "process_group_id": process_group_id,
            "disposition": "clean-exit",
            "reason_code": "runtime.clean-exit",
            "exit_code": 0,
            "termination_signal": None,
            "child_reaped": True,
            "guardian_reaped": True,
            "containment_empty": True,
            "diagnostic_stream_complete": True,
            "private_work_directory_removed": True,
            "package_generation_lease_released": True,
            "group_signal_while_guardian_unreaped": True,
            "direct_child_signal_while_unreaped": False,
            "containment_signal_scope": "process-group",
            "containment_seal_signal": 9,
            "guardian_generation_lease_held_until_containment": True,
            "stderr_sha256": sha256(b""),
            "stderr_retained_bytes": 0,
            "stderr_truncated": False,
            "durable_process_launch_authority": False,
            "ncp_authority": False,
            "physical_authority": False,
            "scientific_authority": False,
        }
    )
    lifecycle = _seal_managed(
        {
            "schema_version": "engram.closed-loop-runtime-lifecycle-binding.v1",
            "profile": handshake["profile"],
            "generation_id": generation_id,
            "generation_directory_identity_sha256": handshake[
                "generation_directory_identity_sha256"
            ],
            "handshake_receipt_sha256": handshake["receipt_sha256"],
            "termination_receipt_sha256": termination["receipt_sha256"],
            "launch_source": "package-store-lease",
            "store_id": installed["store_id"],
            "package_generation_id": installed["package_generation_id"],
            "package_generation_lease_retained_at_launch": True,
            "package_generation_lease_released": True,
            "termination_disposition": "clean-exit",
            "child_reaped": True,
            "containment_empty": True,
            "diagnostic_stream_complete": True,
            "private_work_directory_removed": True,
            "publisher_authenticated": False,
            "durable_process_launch_authority": False,
            "ncp_authority": False,
            "physical_authority": False,
            "scientific_authority": False,
        },
        "binding_sha256",
    )
    return (
        {
            "exec_gate_command_binding": command,
            "handshake_receipt": handshake,
            "termination_receipt": termination,
            "lifecycle_binding_sha256": lifecycle["binding_sha256"],
            "guardian_closure_verified": True,
            "package_store_lineage_verified": True,
        },
        lifecycle,
    )


def _default_runtime_lifecycle() -> dict[str, Any]:
    return _seal_managed(
        {
            "schema_version": "engram.closed-loop-runtime-lifecycle-binding.v1",
            "profile": "engram.reviewed-native-development.v1",
            "generation_id": "gen_" + _fixture_sha("default runtime generation"),
            "generation_directory_identity_sha256": _fixture_sha(
                "default generation directory"
            ),
            "handshake_receipt_sha256": _fixture_sha("default handshake"),
            "termination_receipt_sha256": _fixture_sha("default termination"),
            "launch_source": "package-store-lease",
            "store_id": "extstore_" + _fixture_sha("default extension store"),
            "package_generation_id": "pkggen_"
            + _fixture_sha("default package generation"),
            "package_generation_lease_retained_at_launch": True,
            "package_generation_lease_released": True,
            "termination_disposition": "clean-exit",
            "child_reaped": True,
            "containment_empty": True,
            "diagnostic_stream_complete": True,
            "private_work_directory_removed": True,
            "publisher_authenticated": False,
            "durable_process_launch_authority": False,
            "ncp_authority": False,
            "physical_authority": False,
            "scientific_authority": False,
        },
        "binding_sha256",
    )


def _runtime_file_row(relative_path: str, role: str) -> dict[str, Any]:
    payload = _source_fixture_payload(relative_path)
    return {
        "absolute_path": f"/private/crebain-fixture/engram/{relative_path}",
        "role": role,
        "sha256": sha256(payload),
        "size_bytes": len(payload),
    }


def _closed_loop_step_id(study_run_id: str, step_index: int) -> str:
    digest = sha256(
        managed_runtime_canonical(
            {
                "domain": "engram-extension-closed-loop-step-v2",
                "run_id": study_run_id,
                "step_index": step_index,
            }
        )
    )
    return f"step_{digest[:32]}"


def real_nest_closed_loop_fixture(
    plan: dict[str, Any],
    config: dict[str, Any],
    *,
    runtime_lifecycle: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    """Build complete successful Engram b6 terminal and NEST V2 receipts."""

    runtime_lifecycle = runtime_lifecycle or _default_runtime_lifecycle()
    channel_ids = [channel["channel_id"] for channel in plan["channels"]]
    population_bindings = {
        channel["channel_id"]: sorted(
            population_name
            for action_index in range(3)
            for population_name in (
                f"{channel['neural_population_prefix']}.d{action_index:02}.negative",
                f"{channel['neural_population_prefix']}.d{action_index:02}.positive",
            )
        )
        for channel in plan["channels"]
    }
    population_names = sorted(
        population_name
        for names in population_bindings.values()
        for population_name in names
    )
    population_roster = [
        {
            "channel_id": channel_id,
            "population_names": list(population_bindings[channel_id]),
        }
        for channel_id in channel_ids
    ]
    control_bindings = [
        {
            "channel_id": channel["channel_id"],
            "axis_binding_sha256s": [
                sha256(canonical(axis)) for axis in channel["neural_control_axes"]
            ],
            "neural_codec_sha256": sha256(
                canonical(
                    {
                        "channel_id": channel["channel_id"],
                        "axes": channel["neural_control_axes"],
                    }
                )
            ),
        }
        for channel in plan["channels"]
    ]
    control_by_channel = {row["channel_id"]: row for row in control_bindings}
    population_size = config["population_size"]
    resolution_ms = float(config["resolution_ms"])
    resolution_tics = int(round(resolution_ms * 1_000))
    step_duration_ms = float(config["step_duration_ms"])
    step_duration_tics = int(round(step_duration_ms * 1_000))
    maximum_input_rate_hz = float(config["baseline_rate_hz"] + config["input_span_hz"])
    action_dimension_count = sum(
        len(row["axis_binding_sha256s"]) for row in control_bindings
    )
    signed_population_count = action_dimension_count * 2
    population_neuron_count = signed_population_count * population_size
    device_node_count = signed_population_count * 2
    total_node_count = population_neuron_count + device_node_count
    total_connection_count = population_neuron_count * 2
    total_run_tics = step_duration_tics * 6
    neuron_tic_work_units = population_neuron_count * total_run_tics
    input_event_work_units = math.ceil(
        maximum_input_rate_hz * total_run_tics * population_neuron_count / 1_000_000
    )
    estimated_step_response_bytes = (
        32 * 1024 + len(channel_ids) * 4 * 1024 + action_dimension_count * 8 * 1024
    )
    estimated_evidence_bundle_bytes = (
        16 * 1024 * 1024
        + len(channel_ids) * 4 * 1024
        + action_dimension_count * 8 * 1024
        + estimated_step_response_bytes * 6
    )
    estimated_step_response_nodes = (
        128 + len(channel_ids) * 42 + action_dimension_count * 160
    )
    estimated_evidence_bundle_nodes = (
        32_768
        + len(channel_ids) * 64
        + action_dimension_count * 192
        + 6 * (128 + len(channel_ids) * 40 + action_dimension_count * 160)
    )
    closed_loop_definition_sha256 = sha256(canonical(plan))

    project_rows = [
        _runtime_file_row(
            _module_relative_path(module_name),
            f"project-module:{module_name}",
        )
        for module_name in WORKER_MODULE_NAMES
    ]
    external_rows = [
        {
            "absolute_path": "/private/crebain-fixture/site-packages/nest/__init__.py",
            "role": "nest-package-init",
            "sha256": _fixture_sha("NEST package init"),
            "size_bytes": 101,
        },
        {
            "absolute_path": "/private/crebain-fixture/site-packages/nest/pynestkernel.so",
            "role": "nest-pynestkernel-native",
            "sha256": _fixture_sha("NEST native extension"),
            "size_bytes": 102,
        },
        {
            "absolute_path": "/private/crebain-fixture/site-packages/pydantic_core.so",
            "role": "pydantic-core-native",
            "sha256": _fixture_sha("Pydantic core"),
            "size_bytes": 103,
        },
        {
            "absolute_path": "/private/crebain-fixture/site-packages/pydantic/__init__.py",
            "role": "pydantic-package-init",
            "sha256": _fixture_sha("Pydantic package init"),
            "size_bytes": 104,
        },
        {
            "absolute_path": "/private/crebain-fixture/bin/python3",
            "role": "python-executable",
            "sha256": _fixture_sha("Python executable"),
            "size_bytes": 105,
        },
        _runtime_file_row(
            "backend/optimization/extension_closed_loop_nest_worker.py",
            "worker-source",
        ),
    ]
    runtime_files = [*project_rows, *external_rows]
    required_runtime_files = [
        *project_rows,
        *[
            row
            for row in external_rows
            if row["role"]
            not in {
                "nest-package-init",
                "nest-pynestkernel-native",
            }
        ],
    ]
    project_source_roster_sha256 = sha256(canonical(project_rows))
    worker_source = next(row for row in runtime_files if row["role"] == "worker-source")
    python_executable = next(
        row for row in runtime_files if row["role"] == "python-executable"
    )
    adapter_source = next(
        row
        for row in project_rows
        if row["role"]
        == "project-module:backend.optimization.extension_closed_loop_nest_process"
    )
    controller_source = next(
        row
        for row in project_rows
        if row["role"]
        == "project-module:backend.optimization.extension_closed_loop_nest"
    )
    exec_gate_source = _runtime_file_row(
        "backend/integrations/contained_exec_gate.py",
        "exec-gate-source",
    )
    guardian_relative = "backend/optimization/extension_closed_loop_nest_guardian.py"
    guardian_source = _runtime_file_row(guardian_relative, "guardian-source")
    guardian_source_text = _source_fixture_payload(guardian_relative).decode()
    worker_command = [
        python_executable["absolute_path"],
        "-I",
        "-S",
        "-B",
        worker_source["absolute_path"],
        "--resource-limit-profile",
        "portable-posix-rlimit-v1",
        "--address-space-bytes",
        "0",
        "--cpu-time-seconds",
        "300",
        "--file-size-bytes",
        str(64 * 1024 * 1024),
        "--open-file-count",
        "256",
    ]
    guardian_command = [
        python_executable["absolute_path"],
        "-I",
        "-S",
        "-B",
        "-c",
        guardian_source_text,
    ]
    sandbox_profile = (
        "(version 1)(allow default)(deny process-fork)(deny signal)"
        "(deny process-info-pidinfo (target others))"
        "(deny process-info-dirtycontrol (target others))"
    )
    worker_dispatch_command = [
        "/usr/bin/sandbox-exec",
        "-p",
        sandbox_profile,
        *worker_command,
    ]
    environment = [
        ["LANG", "C"],
        ["LC_ALL", "C"],
        ["PATH", "/usr/bin:/bin"],
        ["TZ", "UTC"],
    ]
    sys_path = [
        "/private/crebain-fixture/engram",
        "/private/crebain-fixture/lib/python3.11",
        "/private/crebain-fixture/lib/python3.11/lib-dynload",
        "/private/crebain-fixture/site-packages",
    ]
    child_provider_identity_sha256 = sha256(
        canonical(
            {
                "schema_version": "engram.nest-population-controller-identity.v1",
                "provider": "NEST",
                "semantic_policy": "engram.nest-population-controller-policy.v4",
                "test_failure_phase": "none",
                "controller_source_sha256": controller_source["sha256"],
                "reported_version": "3.9.0",
                "config": config,
                "nest_tic_ms": "0.001",
                "local_num_threads": 1,
                "model_roster": [
                    "iaf_psc_delta",
                    "inhomogeneous_poisson_generator",
                    "spike_recorder",
                ],
                "resource_limits": {
                    "max_total_nodes": 65_536,
                    "max_total_connections": 100_000,
                    "max_neuron_tic_work_units": 10_000_000_000,
                    "max_input_event_work_units": 100_000_000,
                },
                "loaded_bytes_attested": False,
                "ncp_transport": False,
            }
        )
    )
    worker_command_sha256 = sha256(
        canonical(
            {
                "guardian_command": guardian_command,
                "worker_command": worker_command,
                "worker_dispatch_command": worker_dispatch_command,
                "exec_gate_source_sha256": exec_gate_source["sha256"],
                "session_escape_prevention_profile": (
                    "darwin-gated-group-leader-deny-fork-v1"
                ),
                "darwin_sandbox_profile_sha256": sha256(sandbox_profile.encode()),
                "darwin_sandbox_launcher_sha256": _fixture_sha(
                    "Darwin sandbox launcher"
                ),
            }
        )
    )
    expectation = _seal_canonical(
        {
            "schema_version": "engram.nest-worker-launch-expectation.v4",
            "guardian_command": guardian_command,
            "worker_command": worker_command,
            "worker_dispatch_command": worker_dispatch_command,
            "worker_command_sha256": worker_command_sha256,
            "environment": environment,
            "sys_path": sys_path,
            "python_executable_sha256": python_executable["sha256"],
            "worker_source_sha256": worker_source["sha256"],
            "exec_gate_source_file": exec_gate_source,
            "exec_gate_source_sha256": exec_gate_source["sha256"],
            "guardian_source_file": guardian_source,
            "guardian_source_sha256": guardian_source["sha256"],
            "adapter_source_sha256": adapter_source["sha256"],
            "controller_configuration": config,
            "child_provider_test_failure_phase": "none",
            "expected_child_provider_identity_sha256": (child_provider_identity_sha256),
            "required_runtime_files": required_runtime_files,
            "required_runtime_file_roster_sha256": sha256(
                canonical(required_runtime_files)
            ),
            "required_project_source_roster_sha256": (project_source_roster_sha256),
            "project_source_discovery_policy": (
                "minimum-direct-worker-import-roster-v1"
            ),
            "resource_limit_profile": "portable-posix-rlimit-v1",
            "platform": "darwin",
            "session_escape_prevention_profile": (
                "darwin-gated-group-leader-deny-fork-v1"
            ),
            "descendant_creation_denied": True,
            "runtime_process_group_leader": True,
            "guardian_group_member": True,
            "darwin_sandbox_profile_sha256": sha256(sandbox_profile.encode()),
            "darwin_sandbox_launcher_sha256": _fixture_sha("Darwin sandbox launcher"),
            "address_space_bytes": None,
            "address_space_limit_enforced": False,
            "cpu_time_seconds": 300,
            "file_size_bytes": 64 * 1024 * 1024,
            "open_file_count": 256,
            "core_file_bytes": 0,
            "network_namespace_isolation": False,
            "syscall_filter": False,
            "production_isolation": False,
            "external_dependency_closure_attested": False,
            "loaded_bytes_attested": False,
        }
    )
    worker_pid = 31_000
    guardian_pid = worker_pid + 1
    session_id = worker_pid - 1
    launch = _seal_canonical(
        {
            "schema_version": "engram.nest-worker-launch-attempt.v1",
            "phase": "worker-ready",
            "outcome": "succeeded",
            "reason_code": "neural.nest-worker-launch-succeeded",
            "launch_expectation_sha256": expectation["receipt_sha256"],
            "worker_pid": worker_pid,
            "guardian_pid": guardian_pid,
            "process_group_id": worker_pid,
            "session_id": session_id,
            "guardian_started": True,
            "guardian_ready_observed": True,
            "worker_started": True,
            "stderr_drain_started": True,
            "worker_reaped": False,
            "guardian_reaped": False,
            "containment_empty": False,
            "bounded_cleanup_observation_complete": False,
            "group_signal_attempted": False,
            "group_signal_basis": "none",
            "anchored_group_kill_delivered": False,
            "containment_seal_signal": None,
            "posix_process_group_portability_scope": (
                "darwin-linux-reviewed-local-development"
            ),
            "production_isolation": False,
            "scientific_authority": False,
        }
    )
    resource_limits = _seal_canonical(
        {
            "schema_version": "engram.nest-worker-resource-limits.v1",
            "profile": "portable-posix-rlimit-v1",
            "platform": "darwin",
            "address_space_bytes": None,
            "address_space_limit_enforced": False,
            "cpu_time_seconds": 300,
            "file_size_bytes": 64 * 1024 * 1024,
            "open_file_count": 256,
            "core_file_bytes": 0,
            "applied_before_nest_import": True,
            "network_namespace_isolation": False,
            "syscall_filter": False,
            "production_isolation": False,
        }
    )
    runtime_identity = _seal_canonical(
        {
            "schema_version": "engram.nest-worker-runtime-identity.v2",
            "python_version": "3.11.15 synthetic",
            "reported_nest_version": "3.9.0",
            "reported_pydantic_version": "2.13.4",
            "isolated_flag": 1,
            "no_site_flag": 1,
            "ignore_environment_flag": 1,
            "no_user_site_flag": 1,
            "environment": environment,
            "sys_path": sys_path,
            "files": runtime_files,
            "file_roster_sha256": sha256(canonical(runtime_files)),
            "project_source_roster_sha256": project_source_roster_sha256,
            "project_source_closure_verified": True,
            "resource_limits": resource_limits,
            "external_dependency_closure_attested": False,
            "response_bound_loaded_bytes": False,
            "loaded_bytes_attested": False,
        }
    )

    connection_rows = [
        {
            "population_name": population_name,
            "direction": direction,
            "connection_count": population_size,
            "requested_weight": (
                float(config["input_weight_mv"]) if direction == "input" else 1.0
            ),
            "effective_weight": (
                float(config["input_weight_mv"]) if direction == "input" else 1.0
            ),
            "requested_delay_tics": resolution_tics,
            "delay_api_argument_ms": resolution_ms,
            "effective_delay_ms": resolution_ms,
            "effective_delay_tics": resolution_tics,
            "requested_receptor": 0,
            "effective_receptor": 0,
            "synapse_model": "static_synapse",
        }
        for population_name in population_names
        for direction in ("input", "recorder")
    ]
    work_admission = _seal_canonical(
        {
            "schema_version": "engram.nest-work-admission.v1",
            "channel_count": len(channel_ids),
            "planned_step_count": 6,
            "action_dimension_count": action_dimension_count,
            "closed_loop_definition_sha256": closed_loop_definition_sha256,
            "controller_configuration_sha256": sha256(canonical(config)),
            "expected_control_binding_sha256": sha256(canonical(control_bindings)),
            "expected_population_roster_sha256": sha256(canonical(population_roster)),
            "population_size": population_size,
            "step_duration_tics": step_duration_tics,
            "maximum_input_rate_hz": maximum_input_rate_hz,
            "signed_population_count": signed_population_count,
            "population_neuron_count": population_neuron_count,
            "device_node_count": device_node_count,
            "total_node_count": total_node_count,
            "total_connection_count": total_connection_count,
            "total_run_tics": total_run_tics,
            "neuron_tic_work_units": neuron_tic_work_units,
            "input_event_work_units": input_event_work_units,
            "byte_estimate_policy": "closed-json-upper-bound-v1",
            "estimated_step_response_bytes": estimated_step_response_bytes,
            "estimated_evidence_bundle_bytes": estimated_evidence_bundle_bytes,
            "node_estimate_policy": "canonical-json-node-upper-bound-v1",
            "estimated_step_response_nodes": estimated_step_response_nodes,
            "estimated_evidence_bundle_nodes": estimated_evidence_bundle_nodes,
            "max_total_nodes": 65_536,
            "max_total_connections": 100_000,
            "max_neuron_tic_work_units": 10_000_000_000,
            "max_input_event_work_units": 100_000_000,
            "max_step_response_bytes": 3_145_728,
            "max_evidence_bundle_bytes": 251_658_240,
            "max_step_response_nodes": 32_768,
            "max_evidence_bundle_nodes": 131_072,
            "admitted": True,
        }
    )
    model_readback = {
        "effective_model_roster": [
            "iaf_psc_delta",
            "inhomogeneous_poisson_generator",
            "spike_recorder",
        ],
        "population_neuron_count": population_neuron_count,
        "device_node_count": device_node_count,
    }
    session = _seal_canonical(
        {
            "schema_version": "engram.nest-session-readback.v2",
            "reported_version": "3.9.0",
            "requested_resolution_ms": resolution_ms,
            "requested_resolution_tics": resolution_tics,
            "resolution_api_argument_ms": resolution_ms,
            "effective_resolution_ms": resolution_ms,
            "effective_resolution_tics": resolution_tics,
            "requested_step_duration_ms": step_duration_ms,
            "requested_step_duration_tics": step_duration_tics,
            "run_api_argument_ms": step_duration_ms,
            "requested_rng_seed": config["rng_seed"],
            "effective_rng_seed": config["rng_seed"],
            "requested_local_num_threads": 1,
            "effective_local_num_threads": 1,
            "effective_total_num_virtual_processes": 1,
            "effective_model_roster": model_readback["effective_model_roster"],
            "model_readback_sha256": sha256(canonical(model_readback)),
            "control_neuron_model": "iaf_psc_delta",
            "control_neuron_refractory_period_tics": 2_000,
            "control_neuron_refractory_input": False,
            "channel_recovery_policy": (
                "delta-current-zero-input-washout-dual-reset-v1"
            ),
            "requested_input_weight": float(config["input_weight_mv"]),
            "requested_recorder_weight": 1.0,
            "requested_receptor": 0,
            "requested_connection_delay_tics": resolution_tics,
            "connection_delay_api_argument_ms": resolution_ms,
            "connection_readbacks": connection_rows,
            "connection_readback_sha256": sha256(canonical(connection_rows)),
            "control_bindings": control_bindings,
            "control_binding_sha256": sha256(canonical(control_bindings)),
            "population_roster": population_roster,
            "population_roster_sha256": sha256(canonical(population_roster)),
            "observed_population_neuron_count": population_neuron_count,
            "observed_device_node_count": device_node_count,
            "observed_total_connection_count": total_connection_count,
            "kernel_reset_at_admission": True,
            "one_session": True,
            "work_admission": work_admission,
            "ncp_transport": False,
            "loaded_bytes_attested": False,
        }
    )
    capabilities = {
        "schema_version": "engram.closed-loop-neural-capabilities.v1",
        "provider": "engram.nest-population-controller",
        "provider_identity_sha256": child_provider_identity_sha256,
        "deadline_enforcement": "cooperative-observed",
        "declared_step_duration_tics": step_duration_tics,
        "session_model": "one-session-named-populations",
        "max_channels": 64,
        "automatic_restart": False,
        "physical_actuation": False,
        "ncp_transport": False,
        "loaded_bytes_attested": False,
        "durable_evidence_profile": "none",
    }
    child_prepared = _seal_managed(
        {
            "schema_version": "engram.closed-loop-neural-prepared.v1",
            "study_run_id": plan["study_run_id"],
            "definition_sha256": closed_loop_definition_sha256,
            "provider_identity_sha256": child_provider_identity_sha256,
            "provider_session_receipt_sha256": session["receipt_sha256"],
            "single_session": True,
            "step_duration_tics": step_duration_tics,
            "populations": population_roster,
        }
    )
    parent_provider_identity_sha256 = _fixture_sha("parent neural provider")
    binding = _seal_canonical(
        {
            "schema_version": "engram.nest-worker-session-binding.v1",
            "study_run_id": plan["study_run_id"],
            "parent_provider_identity_sha256": parent_provider_identity_sha256,
            "runtime_launch_expectation_sha256": expectation["receipt_sha256"],
            "worker_launch_attempt_sha256": launch["receipt_sha256"],
            "worker_source_sha256": worker_source["sha256"],
            "guardian_source_sha256": guardian_source["sha256"],
            "adapter_source_sha256": adapter_source["sha256"],
            "worker_command_sha256": worker_command_sha256,
            "worker_runtime_identity_sha256": runtime_identity["receipt_sha256"],
            "worker_project_source_roster_sha256": project_source_roster_sha256,
            "child_provider_identity_sha256": child_provider_identity_sha256,
            "child_capabilities_sha256": sha256(canonical(capabilities)),
            "child_prepared_receipt_sha256": child_prepared["receipt_sha256"],
            "child_session_receipt_sha256": session["receipt_sha256"],
            "child_lineage_verified": True,
            "loaded_bytes_attested": False,
            "response_bound_loaded_bytes": False,
            "ncp_transport": False,
            "scientific_authority": False,
        }
    )
    provider_prepared = _seal_managed(
        {
            "schema_version": "engram.closed-loop-neural-prepared.v1",
            "study_run_id": plan["study_run_id"],
            "definition_sha256": closed_loop_definition_sha256,
            "provider_identity_sha256": parent_provider_identity_sha256,
            "provider_session_receipt_sha256": binding["receipt_sha256"],
            "single_session": True,
            "step_duration_tics": step_duration_tics,
            "populations": population_roster,
        }
    )
    preparation = _seal_canonical(
        {
            "schema_version": "engram.nest-worker-preparation-attempt.v1",
            "study_run_id": plan["study_run_id"],
            "definition_sha256": closed_loop_definition_sha256,
            "phase": "provider-prepare",
            "outcome": "succeeded",
            "reason_code": "neural.prepare-succeeded",
            "runtime_launch_expectation_sha256": expectation["receipt_sha256"],
            "worker_launch_attempt_sha256": launch["receipt_sha256"],
            "runtime_identity_receipt_sha256": runtime_identity["receipt_sha256"],
            "provider_preparation_receipt_sha256": provider_prepared["receipt_sha256"],
            "session_binding_receipt_sha256": binding["receipt_sha256"],
            "worker_request_dispatched": True,
            "worker_response_observed": True,
            "scientific_authority": False,
        }
    )

    empty_roster_sha256 = sha256(canonical([]))
    step_executions: list[dict[str, Any]] = []
    step_attempts: list[dict[str, Any]] = []
    terminal_steps: list[dict[str, Any]] = []
    terminal_executions: list[dict[str, Any]] = []
    neural_steps: list[dict[str, Any]] = []
    previous_snapshot_sha256 = _fixture_sha(f"{plan['study_run_id']} initial snapshot")
    initial_snapshot_sha256 = previous_snapshot_sha256
    for step_index in range(1, 7):
        before_tics = (step_index - 1) * step_duration_tics
        after_tics = step_index * step_duration_tics
        previous_watermark = max(0, before_tics - resolution_tics)
        current_watermark = max(0, after_tics - resolution_tics)
        encoded_inputs = [
            {
                "channel_id": channel_id,
                "action_index": action_index,
                "axis_binding_sha256": control_by_channel[channel_id][
                    "axis_binding_sha256s"
                ][action_index],
                "neural_codec_sha256": control_by_channel[channel_id][
                    "neural_codec_sha256"
                ],
                "raw_affine_sum": 0.0,
                "normalized_input": 0.0,
                "clamped": False,
                "input_disposition": "encoded-observation",
            }
            for channel_id in channel_ids
            for action_index in range(3)
        ]
        safety_readbacks = [
            {
                "channel_id": channel_id,
                "hold_required": False,
                "recovery_from_hold": False,
                "input_disposition": "encoded-observation",
                "population_state_reset_performed": False,
                "population_state_reset_verified": False,
                "safety_washout_performed": False,
                "resolution_tics": resolution_tics,
                "minimum_refractory_flush_tics": 2_000,
                "safety_interval_tics": 0,
                "post_delivery_quiescence_tics": 0,
                "recorder_delivery_flush_slack_tics": 0,
                "discarded_pending_event_count": 0,
                "pre_interval_reset_readback_sha256": empty_roster_sha256,
                "post_interval_reset_readback_sha256": empty_roster_sha256,
                "reset_readback_sha256": _fixture_sha(f"{channel_id} reset readback"),
                "recorder_quarantine_sha256": _fixture_sha(
                    f"{channel_id} recorder quarantine"
                ),
            }
            for channel_id in channel_ids
        ]
        event_deltas = [
            {
                "population_name": name,
                "prior_event_count": 0,
                "current_event_count": 0,
                "event_count_delta": 0,
            }
            for name in population_names
        ]
        completed_windows = [
            {
                "population_name": name,
                "previous_completed_watermark_tics": previous_watermark,
                "current_completed_watermark_tics": current_watermark,
                "decode_window_start_tics": previous_watermark,
                "completed_window_tics": current_watermark - previous_watermark,
                "recorder_delivery_delay_tics": resolution_tics,
                "newly_delivered_event_count": 0,
                "completed_event_count": 0,
                "pending_event_count": 0,
                "quarantined_event_count": 0,
                "completed_event_times_sha256": empty_roster_sha256,
                "pending_event_times_sha256": empty_roster_sha256,
                "quarantined_event_times_sha256": empty_roster_sha256,
            }
            for name in population_names
        ]
        schedules = [
            {
                "population_name": name,
                "generator_model": "inhomogeneous_poisson_generator",
                "requested_schedule_time_tics": resolution_tics,
                "schedule_api_argument_ms": resolution_ms,
                "effective_schedule_time_ms": resolution_ms,
                "effective_schedule_time_tics": resolution_tics,
                "requested_rate_hz": maximum_input_rate_hz,
                "effective_rate_hz": maximum_input_rate_hz,
            }
            for name in population_names
        ]
        desired_rate_hz = float(config["baseline_rate_hz"])
        requested_weight_mv = (
            float(config["input_weight_mv"]) * desired_rate_hz / maximum_input_rate_hz
        )
        weights = [
            {
                "population_name": name,
                "connection_count": population_size,
                "constant_generator_rate_hz": maximum_input_rate_hz,
                "desired_equivalent_rate_hz": desired_rate_hz,
                "configured_full_scale_weight_mv": float(config["input_weight_mv"]),
                "requested_weight_mv": requested_weight_mv,
                "effective_weight_mv": requested_weight_mv,
                "input_disposition": "encoded-observation",
            }
            for name in population_names
        ]
        execution = _seal_canonical(
            {
                "schema_version": "engram.nest-step-execution-readback.v3",
                "step_index": step_index,
                "before_biological_time_tics": before_tics,
                "requested_run_tics": step_duration_tics,
                "run_api_argument_ms": step_duration_ms,
                "after_biological_time_tics": after_tics,
                "encoded_control_inputs": encoded_inputs,
                "control_encoding_sha256": sha256(canonical(encoded_inputs)),
                "channel_safety_readbacks": safety_readbacks,
                "channel_safety_readback_sha256": sha256(canonical(safety_readbacks)),
                "population_event_deltas": event_deltas,
                "completed_window_readbacks": completed_windows,
                "completed_window_readback_sha256": sha256(
                    canonical(completed_windows)
                ),
                "generator_schedule_readbacks": schedules,
                "generator_schedule_readback_sha256": sha256(canonical(schedules)),
                "input_weight_readbacks": weights,
                "input_weight_readback_sha256": sha256(canonical(weights)),
                "input_encoding_policy": "constant-rate-variable-weight-v1",
                "decoded_proposal_only": True,
                "scientific_authority": False,
            }
        )
        step_id = _closed_loop_step_id(plan["study_run_id"], step_index)
        request = _seal_managed(
            {
                "schema_version": "engram.closed-loop-neural-step-request.v1",
                "study_run_id": plan["study_run_id"],
                "step_index": step_index,
                "step_id": step_id,
                "neural_preparation_sha256": provider_prepared["receipt_sha256"],
                "source_snapshot_sha256": previous_snapshot_sha256,
                "observation_runtime_time_tics": before_tics,
                "runtime_interval_end_time_tics": after_tics,
                "runtime_interval_tics": step_duration_tics,
                "controller_start_time_tics": before_tics,
                "controller_end_time_tics": after_tics,
                "controller_interval_tics": step_duration_tics,
                "channels": [
                    {
                        "channel_id": channel["channel_id"],
                        "subject_id": channel["subject_id"],
                        "observation_values": [
                            0.0 for _ in range(channel["observation_width"])
                        ],
                        "hold_required": False,
                        "fault_code": "none",
                    }
                    for channel in plan["channels"]
                ],
            },
            "request_sha256",
        )
        request_sha256 = request["request_sha256"]
        partial_readback_sha256 = sha256(
            canonical(
                {
                    "before_biological_time_tics": before_tics,
                    "observed_after_biological_time_tics": after_tics,
                    "simulation_dispatched": True,
                    "simulation_returned": True,
                }
            )
        )
        attempt = _seal_canonical(
            {
                "schema_version": "engram.nest-step-attempt.v1",
                "attempt_index": step_index,
                "step_index": step_index,
                "request_sha256": request_sha256,
                "before_biological_time_tics": before_tics,
                "requested_run_tics": step_duration_tics,
                "simulation_dispatched": True,
                "simulation_returned": True,
                "observed_after_biological_time_tics": after_tics,
                "decoded_proposal_produced": True,
                "execution_receipt_sha256": execution["receipt_sha256"],
                "partial_readback_sha256": partial_readback_sha256,
                "observation_scope": "child-reported",
                "outcome": "succeeded",
                "reason_code": "neural.step-succeeded",
                "scientific_authority": False,
            }
        )
        result = _seal_managed(
            {
                "schema_version": "engram.closed-loop-neural-step-result.v1",
                "study_run_id": plan["study_run_id"],
                "step_index": step_index,
                "step_id": step_id,
                "request_sha256": request_sha256,
                "controller_start_time_tics": before_tics,
                "controller_end_time_tics": after_tics,
                "proposals": [
                    {
                        "channel_id": channel["channel_id"],
                        "values": [0.0 for _ in range(channel["action_width"])],
                        "source_populations": list(
                            population_bindings[channel["channel_id"]]
                        ),
                    }
                    for channel in plan["channels"]
                ],
                "provider_execution_scope": "nest-exact-step-readback",
                "provider_execution_sha256": execution["receipt_sha256"],
            },
            "result_sha256",
        )
        neural_result_sha256 = result["result_sha256"]
        output_snapshot_sha256 = _fixture_sha(
            f"{plan['study_run_id']} output snapshot {step_index}"
        )
        terminal_step = _seal_managed(
            {
                "schema_version": "engram.extension-closed-loop-step-receipt.v2",
                "study_run_id": plan["study_run_id"],
                "step_index": step_index,
                "step_id": step_id,
                "input_snapshot_sha256": previous_snapshot_sha256,
                "neural_request_sha256": request_sha256,
                "neural_result_sha256": neural_result_sha256,
                "provider_execution_scope": "nest-exact-step-readback",
                "provider_execution_sha256": execution["receipt_sha256"],
                "admitted_action_sha256": _fixture_sha(
                    f"{plan['study_run_id']} action {step_index}"
                ),
                "runtime_request_sha256": _fixture_sha(
                    f"{plan['study_run_id']} runtime request {step_index}"
                ),
                "output_snapshot_sha256": output_snapshot_sha256,
                "fault_codes": ["none"],
            }
        )
        terminal_execution = _seal_managed(
            {
                "schema_version": "engram.closed-loop-neural-execution-binding.v1",
                "step_index": step_index,
                "step_id": step_id,
                "neural_request_sha256": request_sha256,
                "neural_result_sha256": neural_result_sha256,
                "provider_execution_scope": "nest-exact-step-readback",
                "provider_execution_sha256": execution["receipt_sha256"],
            },
            "binding_sha256",
        )
        step_executions.append(execution)
        step_attempts.append(attempt)
        terminal_steps.append(terminal_step)
        terminal_executions.append(terminal_execution)
        neural_steps.append({"request": request, "result": result})
        previous_snapshot_sha256 = output_snapshot_sha256

    stderr_sha256 = sha256(b"")
    request_count = 9
    termination_attempt = _seal_canonical(
        {
            "schema_version": "engram.nest-worker-termination-attempt.v1",
            "attempt_index": 1,
            "runtime_launch_expectation_sha256": expectation["receipt_sha256"],
            "worker_launch_attempt_sha256": launch["receipt_sha256"],
            "worker_pid": worker_pid,
            "guardian_pid": guardian_pid,
            "process_group_id": worker_pid,
            "session_id": session_id,
            "worker_source_sha256": worker_source["sha256"],
            "guardian_source_sha256": guardian_source["sha256"],
            "adapter_source_sha256": adapter_source["sha256"],
            "worker_command_sha256": worker_command_sha256,
            "disposition": "clean-exit",
            "reason_code": "neural.nest-worker-clean-exit",
            "exit_code": 0,
            "termination_signal": None,
            "child_reaped": True,
            "guardian_reaped": True,
            "containment_empty": True,
            "diagnostic_stream_complete": True,
            "group_signal_attempted": True,
            "group_signal_basis": "guardian-group-anchor-unreaped",
            "group_signal_while_guardian_unreaped": True,
            "anchored_group_kill_delivered": True,
            "containment_seal_signal": 9,
            "guardian_unexpected_exit_observed": False,
            "posix_process_group_portability_scope": (
                "darwin-linux-reviewed-local-development"
            ),
            "stderr_sha256": stderr_sha256,
            "stderr_retained_bytes": 0,
            "stderr_truncated": False,
            "request_count": request_count,
            "response_count": request_count,
            "hard_deadline_enforcement": True,
            "ncp_transport": False,
            "physical_authority": False,
            "scientific_authority": False,
        }
    )
    termination_attempts = [termination_attempt]
    worker_lifecycle = _seal_canonical(
        {
            "schema_version": "engram.nest-worker-lifecycle-receipt.v2",
            "runtime_launch_expectation_sha256": expectation["receipt_sha256"],
            "worker_launch_attempt_sha256": launch["receipt_sha256"],
            "worker_pid": worker_pid,
            "guardian_pid": guardian_pid,
            "process_group_id": worker_pid,
            "session_id": session_id,
            "worker_source_sha256": worker_source["sha256"],
            "guardian_source_sha256": guardian_source["sha256"],
            "adapter_source_sha256": adapter_source["sha256"],
            "worker_command_sha256": worker_command_sha256,
            "runtime_identity_receipt_sha256": runtime_identity["receipt_sha256"],
            "resource_limit_receipt_sha256": resource_limits["receipt_sha256"],
            "session_binding_receipt_sha256": binding["receipt_sha256"],
            "termination_attempts": termination_attempts,
            "termination_attempt_roster_sha256": sha256(
                canonical(termination_attempts)
            ),
            "disposition": "clean-exit",
            "reason_code": "neural.nest-worker-clean-exit",
            "exit_code": 0,
            "termination_signal": None,
            "child_reaped": True,
            "guardian_reaped": True,
            "containment_empty": True,
            "diagnostic_stream_complete": True,
            "guardian_unexpected_exit_observed": False,
            "posix_process_group_portability_scope": (
                "darwin-linux-reviewed-local-development"
            ),
            "stderr_sha256": stderr_sha256,
            "stderr_retained_bytes": 0,
            "stderr_truncated": False,
            "request_count": request_count,
            "response_count": request_count,
            "hard_deadline_enforcement": True,
            "ncp_transport": False,
            "physical_authority": False,
            "scientific_authority": False,
        }
    )
    population_tails = [
        {
            "population_name": name,
            "pending_event_count": 0,
            "pending_event_times_sha256": empty_roster_sha256,
        }
        for name in population_names
    ]
    tail = _seal_canonical(
        {
            "schema_version": "engram.nest-tail-disposition-receipt.v1",
            "study_run_id": plan["study_run_id"],
            "final_biological_time_tics": total_run_tics,
            "recorder_delivery_delay_tics": resolution_tics,
            "final_completed_watermark_tics": max(0, total_run_tics - resolution_tics),
            "population_tails": population_tails,
            "population_tail_roster_sha256": sha256(canonical(population_tails)),
            "total_pending_event_count": 0,
            "accounting_disposition": ("discarded-incomplete-recorder-delivery-tail"),
            "decoded_proposal_only": True,
            "proposals_used_completed_windows_only": True,
            "scientific_authority": False,
        }
    )
    runtime_binding_sha256 = _fixture_sha("runtime adapter binding")
    runtime_cleanup = _seal_managed(
        {
            "schema_version": "engram.closed-loop-cleanup.v2",
            "component": "runtime",
            "owner_identity_sha256": runtime_binding_sha256,
            "mode": "finish",
            "attempted": True,
            "confirmed": True,
            "containment_empty": True,
            "reason_code": "loop.completed",
            "runtime_lifecycle": runtime_lifecycle,
            "provider_lifecycle_receipt_sha256": None,
            "provider_terminal_receipt_sha256": None,
        }
    )
    neural_cleanup = _seal_managed(
        {
            "schema_version": "engram.closed-loop-cleanup.v2",
            "component": "neural",
            "owner_identity_sha256": parent_provider_identity_sha256,
            "mode": "close",
            "attempted": True,
            "confirmed": True,
            "containment_empty": True,
            "reason_code": "loop.completed",
            "runtime_lifecycle": None,
            "provider_lifecycle_receipt_sha256": worker_lifecycle["receipt_sha256"],
            "provider_terminal_receipt_sha256": tail["receipt_sha256"],
        }
    )
    cleanup = [runtime_cleanup, neural_cleanup]
    timebase = dict(plan["timebase"])
    transcript_sha256 = sha256(
        managed_runtime_canonical(
            {
                "domain": "engram-extension-closed-loop-transcript-v5",
                "digest_canonicalization": "engram.managed-runtime-json.v1",
                "planned_step_count": 6,
                "timebase": timebase,
                "neural_preparation_sha256": provider_prepared["receipt_sha256"],
                "neural_session_receipt_sha256": binding["receipt_sha256"],
                "neural_durable_evidence_profile": (
                    "engram.nest-closed-loop-evidence-bundle.v2"
                ),
                "initial_snapshot_sha256": initial_snapshot_sha256,
                "last_verified_simulation_time_tics": total_run_tics,
                "runtime_progress_disposition": "finished-and-host-verified",
                "step_receipts": [row["receipt_sha256"] for row in terminal_steps],
                "neural_execution_bindings": [
                    row["binding_sha256"] for row in terminal_executions
                ],
                "runtime_finish_sha256": _fixture_sha("runtime finish"),
                "runtime_lifecycle_binding_sha256": runtime_lifecycle["binding_sha256"],
                "cleanup_receipts": [row["receipt_sha256"] for row in cleanup],
                "status": "completed",
                "primary_reason_code": "loop.completed",
                "terminal_reason_code": "loop.completed",
            }
        )
    )
    terminal = _seal_managed(
        {
            "schema_version": "engram.extension-closed-loop-run-receipt.v2",
            "digest_canonicalization": "engram.managed-runtime-json.v1",
            "study_run_id": plan["study_run_id"],
            "study_definition_sha256": plan["study_definition_sha256"],
            "closed_loop_definition_sha256": closed_loop_definition_sha256,
            "runtime_binding_sha256": runtime_binding_sha256,
            "runtime_adapter_configuration_sha256": _fixture_sha(
                "runtime adapter configuration"
            ),
            "neural_provider_identity_sha256": parent_provider_identity_sha256,
            "neural_preparation_sha256": provider_prepared["receipt_sha256"],
            "neural_session_receipt_sha256": binding["receipt_sha256"],
            "neural_durable_evidence_profile": (
                "engram.nest-closed-loop-evidence-bundle.v2"
            ),
            "planned_step_count": 6,
            "timebase": timebase,
            "initial_snapshot_sha256": initial_snapshot_sha256,
            "steps": terminal_steps,
            "neural_executions": terminal_executions,
            "last_verified_simulation_time_tics": total_run_tics,
            "runtime_progress_disposition": "finished-and-host-verified",
            "runtime_finish_sha256": _fixture_sha("runtime finish"),
            "runtime_lifecycle": runtime_lifecycle,
            "cleanup": cleanup,
            "cleanup_complete": True,
            "transcript_sha256": transcript_sha256,
            "status": "completed",
            "primary_reason_code": "loop.completed",
            "terminal_reason_code": "loop.completed",
            "runtime_deadline_enforcement": "host-generation-kill",
            "neural_deadline_enforcement": "host-generation-kill",
            "simulator_only": True,
            "physical_actuation": False,
            "ncp_qualified": False,
            "scientific_authority": False,
            "is_paper_local_evidence": False,
            "calibrated_posterior": False,
        }
    )
    evidence = _seal_managed(
        {
            "schema_version": "engram.nest-closed-loop-evidence-bundle.v2",
            "digest_canonicalization": "engram.managed-runtime-json.v1",
            "profile": "killable-nest-population-controller-v2",
            "run_receipt_sha256": terminal["receipt_sha256"],
            "study_run_id": plan["study_run_id"],
            "neural_provider_identity_sha256": parent_provider_identity_sha256,
            "neural_preparation_sha256": provider_prepared["receipt_sha256"],
            "runtime_launch_expectation": expectation,
            "worker_launch_attempt": launch,
            "preparation_attempt": preparation,
            "child_capabilities": capabilities,
            "worker_runtime_identity": runtime_identity,
            "child_preparation_receipt": child_prepared,
            "provider_preparation_receipt": provider_prepared,
            "worker_session_binding": binding,
            "nest_session_readback": session,
            "step_execution_receipts": step_executions,
            "step_attempt_receipts": step_attempts,
            "tail_disposition_receipt": tail,
            "worker_termination_attempt_receipts": termination_attempts,
            "worker_lifecycle_receipt": worker_lifecycle,
            "worker_terminal_disposition": "confirmed-lifecycle",
            "execution_authority": False,
            "ncp_control": False,
            "physical_actuation": False,
            "scientific_authority": False,
            "is_paper_local_evidence": False,
            "calibrated_posterior": False,
        },
        "bundle_sha256",
    )
    return terminal, evidence, neural_steps


def real_nest_validation_fixture(
    plan: dict[str, Any],
    config: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    _terminal, evidence, neural_steps = real_nest_closed_loop_fixture(plan, config)
    return evidence, neural_steps


def closed_loop_store_fixture(
    *,
    terminal: dict[str, Any],
    evidence: dict[str, Any],
    run_plan: dict[str, Any],
    nest_config: dict[str, Any],
    package_generation_id: str,
    reviewed_handshake: dict[str, Any],
    store_id: str = "clrs_" + "8" * 64,
    reservation_id: str = "clrr_" + "9" * 64,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, bytes]]:
    """Build the exact eight-file reserved v5 receipt-store fixture."""

    def seal_managed(document: dict[str, Any], field: str) -> dict[str, Any]:
        return _seal_managed(dict(document), field)

    receipt_artifact = {
        key: value for key, value in terminal.items() if key != "receipt_sha256"
    }
    evidence_artifact = {
        key: value for key, value in evidence.items() if key != "bundle_sha256"
    }
    receipt_digest = terminal["receipt_sha256"]
    evidence_digest = evidence["bundle_sha256"]
    work_admission = evidence["nest_session_readback"]["work_admission"]
    pre_spawn_sha256 = "a" * 64
    reservation = seal_managed(
        {
            "schema_version": "engram.extension-closed-loop-receipt-reservation.v1",
            "store_id": store_id,
            "reservation_id": reservation_id,
            "study_run_id": terminal["study_run_id"],
            "closed_loop_definition_sha256": terminal["closed_loop_definition_sha256"],
            "receipt_profile": "engram.extension-closed-loop-run-receipt.v2",
            "evidence_profile": ("optional-engram.nest-closed-loop-evidence-bundle.v2"),
            "nest_work_admission_sha256": work_admission["receipt_sha256"],
            "pre_spawn_sha256": pre_spawn_sha256,
            "run_plan_sha256": sha256(managed_runtime_canonical(run_plan)),
            "nest_configuration_sha256": sha256(canonical(nest_config)),
            "expected_runtime_binding_sha256": terminal["runtime_binding_sha256"],
            "reviewed_native_handshake_receipt_sha256": reviewed_handshake[
                "receipt_sha256"
            ],
            "reviewed_native_handshake": reviewed_handshake,
            "package_generation_id": package_generation_id,
            "runtime_generation_id": terminal["runtime_lifecycle"]["generation_id"],
            "reserved_record_count": 1,
            "reserved_artifact_bytes": 16 * 1024 * 1024,
            "reserved_evidence_bytes": work_admission[
                "estimated_evidence_bundle_bytes"
            ],
            "reserved_record_bytes": 4096,
            "execution_authority": False,
            "ncp_control": False,
            "physical_actuation": False,
            "scientific_authority": False,
            "is_paper_local_evidence": False,
            "calibrated_posterior": False,
        },
        "reservation_sha256",
    )
    simulation_dispatch_sha256 = sha256(
        managed_runtime_canonical(
            {
                "schema_version": "engram.extension-closed-loop-dispatch-intent.v1",
                "store_id": store_id,
                "reservation_id": reservation_id,
                "reservation_sha256": reservation["reservation_sha256"],
            }
        )
    )
    extension_dispatch_sha256 = sha256(
        managed_runtime_canonical(
            {
                "schema_version": (
                    "engram.extension-closed-loop-extension-dispatch-intent.v1"
                ),
                "store_id": store_id,
                "reservation_id": reservation_id,
                "pre_spawn_sha256": pre_spawn_sha256,
            }
        )
    )
    finalization = seal_managed(
        {
            "schema_version": ("engram.extension-closed-loop-finalized-reservation.v1"),
            "store_id": store_id,
            "reservation": reservation,
            "pre_spawn_sha256": pre_spawn_sha256,
            "extension_dispatch_sha256": extension_dispatch_sha256,
            "simulation_dispatch_sha256": simulation_dispatch_sha256,
            "terminal_receipt_sha256": receipt_digest,
            "evidence_bundle_sha256": evidence_digest,
            "nest_work_admission_rejoined": True,
            "execution_authority": False,
            "ncp_control": False,
            "physical_actuation": False,
            "scientific_authority": False,
            "is_paper_local_evidence": False,
            "calibrated_posterior": False,
        },
        "finalization_sha256",
    )
    publication_wal_sha256 = sha256(
        managed_runtime_canonical(
            {
                "domain": (
                    "engram-extension-closed-loop-reserved-publication-wal-closure-v1"
                ),
                "store_id": store_id,
                "reservation_id": reservation_id,
                "pre_spawn_sha256": pre_spawn_sha256,
                "extension_dispatch_sha256": extension_dispatch_sha256,
                "reservation_sha256": reservation["reservation_sha256"],
                "simulation_dispatch_sha256": simulation_dispatch_sha256,
                "terminal_receipt_sha256": receipt_digest,
            }
        )
    )
    study_run_key_sha256 = sha256(
        managed_runtime_canonical(
            {
                "domain": ("engram-extension-closed-loop-publication-study-run-key-v1"),
                "store_id": store_id,
                "study_run_id": terminal["study_run_id"],
            }
        )
    )
    anchor = seal_managed(
        {
            "schema_version": (
                "engram.extension-closed-loop-publication-admission-anchor.v1"
            ),
            "store_id": store_id,
            "study_run_key_sha256": study_run_key_sha256,
            "study_run_id": terminal["study_run_id"],
            "terminal_receipt_sha256": receipt_digest,
            "admission_mode": "reserved",
            "publication_wal_sha256": publication_wal_sha256,
            "evidence_bundle_sha256": evidence_digest,
            "reservation_id": reservation_id,
            "reservation_sha256": reservation["reservation_sha256"],
            "pre_spawn_sha256": pre_spawn_sha256,
            "extension_dispatch_sha256": extension_dispatch_sha256,
            "simulation_dispatch_sha256": simulation_dispatch_sha256,
            "reservation_finalization_sha256": finalization["finalization_sha256"],
            "execution_authority": False,
            "ncp_control": False,
            "physical_actuation": False,
            "scientific_authority": False,
            "is_paper_local_evidence": False,
            "calibrated_posterior": False,
        },
        "anchor_sha256",
    )
    authority = seal_managed(
        {
            "schema_version": ("engram.extension-closed-loop-publication-authority.v1"),
            "store_id": store_id,
            "terminal_receipt_sha256": receipt_digest,
            "study_run_id": terminal["study_run_id"],
            "admission_mode": "reserved",
            "publication_admission_anchor_sha256": anchor["anchor_sha256"],
            "publication_wal_sha256": publication_wal_sha256,
            "evidence_bundle_sha256": evidence_digest,
            "reservation_id": reservation_id,
            "reservation_sha256": reservation["reservation_sha256"],
            "reservation_finalization_sha256": finalization["finalization_sha256"],
            "nest_work_admission_sha256": work_admission["receipt_sha256"],
            "execution_authority": False,
            "ncp_control": False,
            "physical_actuation": False,
            "scientific_authority": False,
            "is_paper_local_evidence": False,
            "calibrated_posterior": False,
        },
        "authority_sha256",
    )
    receipt_path = f"receipts/{receipt_digest[:2]}/{receipt_digest}.json"
    evidence_path = f"evidence/{evidence_digest[:2]}/{evidence_digest}.json"
    observation = seal_managed(
        {
            "schema_version": "engram.extension-closed-loop-stored-receipt.v5",
            "store_id": store_id,
            "artifact": {
                "artifact_id": f"art_{receipt_digest[:32]}",
                "kind": "closed_loop_receipt",
                "sha256": receipt_digest,
            },
            "study_run_id": terminal["study_run_id"],
            "run_status": terminal["status"],
            "terminal_reason_code": terminal["terminal_reason_code"],
            "relative_artifact_path": receipt_path,
            "artifact_byte_length": len(managed_runtime_canonical(receipt_artifact)),
            "evidence_profile": "killable-nest-population-controller-v2",
            "evidence_bundle_sha256": evidence_digest,
            "relative_evidence_path": evidence_path,
            "evidence_byte_length": len(managed_runtime_canonical(evidence_artifact)),
            "admission_mode": "reserved",
            "publication_authority_sha256": authority["authority_sha256"],
            "reservation_id": reservation_id,
            "reservation_sha256": reservation["reservation_sha256"],
            "reservation_finalization_sha256": finalization["finalization_sha256"],
            "nest_work_admission_sha256": work_admission["receipt_sha256"],
            "nest_work_admission_rejoined": True,
            "digest_canonicalization": "engram.managed-runtime-json.v1",
            "execution_authority": False,
            "ncp_control": False,
            "physical_actuation": False,
            "scientific_authority": False,
            "is_paper_local_evidence": False,
            "calibrated_posterior": False,
        },
        "record_sha256",
    )
    metadata = {
        "schema_version": "engram.extension-closed-loop-receipt-store.v5",
        "store_id": store_id,
        "policy": "engram.extension-closed-loop-receipt-store-policy.v5",
        "digest_canonicalization": "engram.managed-runtime-json.v1",
        "execution_authority": False,
        "ncp_control": False,
        "physical_actuation": False,
        "scientific_authority": False,
        "is_paper_local_evidence": False,
        "calibrated_posterior": False,
    }
    sidecars = _seal_canonical(
        {
            "schema_version": "crebain.closed-loop-receipt-store-sidecars.v1",
            "store_metadata": metadata,
            "finalized_reservation": finalization,
            "observation": observation,
            "publication_admission_anchor": anchor,
            "publication_authority": authority,
        },
        "closure_sha256",
    )
    material = {
        "store.json": managed_runtime_canonical(metadata),
        "writer.lock": b"engram-extension-closed-loop-receipt-store-lock-v1\n",
        receipt_path: managed_runtime_canonical(receipt_artifact),
        evidence_path: managed_runtime_canonical(evidence_artifact),
        (
            f"finalized-reservations/{reservation_id[5:7]}/{reservation_id}.json"
        ): managed_runtime_canonical(finalization),
        f"observations/{receipt_digest[:2]}/{receipt_digest}.json": (
            managed_runtime_canonical(observation)
        ),
        f"publication-admission-anchors/{study_run_key_sha256}.json": (
            managed_runtime_canonical(anchor)
        ),
        (
            f"publication-authorities/{receipt_digest[:2]}/{receipt_digest}.json"
        ): managed_runtime_canonical(authority),
    }
    files = [
        {
            "relative_path": relative_path,
            "size_bytes": len(payload),
            "sha256": sha256(payload),
        }
        for relative_path, payload in sorted(material.items())
    ]
    closure: dict[str, Any] = {
        "schema_version": "crebain.closed-loop-receipt-store-closure.v1",
        "store_id": store_id,
        "receipt_sha256": receipt_digest,
        "receipt_artifact_path": receipt_path,
        "evidence_bundle_sha256": evidence_digest,
        "evidence_artifact_path": evidence_path,
        "file_count": 8,
        "total_bytes": sum(row["size_bytes"] for row in files),
        "files": files,
    }
    closure["closure_sha256"] = sha256(canonical(closure))
    return closure, sidecars, material
