#!/usr/bin/env python3
"""Build closed synthetic provenance fixtures for provider-free tests."""

from __future__ import annotations

import hashlib
import struct
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


def real_nest_validation_fixture(
    plan: dict[str, Any],
    config: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
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
    population_size = config["population_size"]
    connection_rows = [
        {
            "population_name": population_name,
            "direction": direction,
            "connection_count": population_size,
        }
        for population_name in population_names
        for direction in ("input", "recorder")
    ]
    population_roster = [
        {
            "channel_id": channel["channel_id"],
            "population_names": list(population_bindings[channel["channel_id"]]),
        }
        for channel in plan["channels"]
    ]
    session = {
        "one_session": True,
        "connection_readbacks": connection_rows,
        "connection_readback_sha256": sha256(canonical(connection_rows)),
        "observed_population_neuron_count": len(population_names) * population_size,
        "observed_device_node_count": len(population_names) * 2,
        "observed_total_connection_count": len(population_names) * population_size * 2,
        "population_roster": population_roster,
        "population_roster_sha256": sha256(canonical(population_roster)),
        "receipt_sha256": "1" * 64,
    }
    executions: list[dict[str, Any]] = []
    neural_steps: list[dict[str, Any]] = []
    for _step_index in range(1, 7):
        executions.append(
            {
                "generator_schedule_readbacks": [
                    {"population_name": name} for name in population_names
                ],
                "input_weight_readbacks": [
                    {"population_name": name} for name in population_names
                ],
                "completed_window_readbacks": [
                    {"population_name": name} for name in population_names
                ],
                "population_event_deltas": [
                    {"population_name": name} for name in population_names
                ],
                "channel_safety_readbacks": [
                    {"channel_id": channel_id} for channel_id in channel_ids
                ],
                "encoded_control_inputs": [
                    {"channel_id": channel_id, "action_index": action_index}
                    for channel_id in channel_ids
                    for action_index in range(3)
                ],
            }
        )
        neural_steps.append(
            {
                "request": {
                    "channels": [
                        {"channel_id": channel_id} for channel_id in channel_ids
                    ]
                },
                "result": {
                    "proposals": [
                        {
                            "channel_id": channel_id,
                            "source_populations": list(population_bindings[channel_id]),
                        }
                        for channel_id in channel_ids
                    ]
                },
            }
        )

    identity: dict[str, Any] = {"fixture": "runtime-identity"}
    identity["receipt_sha256"] = sha256(canonical(identity))
    binding: dict[str, Any] = {
        "worker_runtime_identity_sha256": identity["receipt_sha256"],
        "child_session_receipt_sha256": session["receipt_sha256"],
        "child_lineage_verified": True,
        "loaded_bytes_attested": False,
        "response_bound_loaded_bytes": False,
        "ncp_transport": False,
        "scientific_authority": False,
    }
    binding["receipt_sha256"] = sha256(canonical(binding))
    attempt: dict[str, Any] = {
        "attempt_index": 1,
        "worker_pid": 12345,
        "worker_source_sha256": "2" * 64,
        "worker_command_sha256": "3" * 64,
        "adapter_source_sha256": "4" * 64,
        "child_reaped": True,
        "containment_empty": True,
        "diagnostic_stream_complete": True,
        "hard_deadline_enforcement": True,
        "ncp_transport": False,
        "physical_authority": False,
        "scientific_authority": False,
    }
    attempt["receipt_sha256"] = sha256(canonical(attempt))
    attempts = [attempt]
    lifecycle: dict[str, Any] = {
        "termination_attempts": attempts,
        "session_binding_receipt_sha256": binding["receipt_sha256"],
        "runtime_identity_receipt_sha256": identity["receipt_sha256"],
        "termination_attempt_roster_sha256": sha256(canonical(attempts)),
        "worker_pid": attempt["worker_pid"],
        "worker_source_sha256": attempt["worker_source_sha256"],
        "worker_command_sha256": attempt["worker_command_sha256"],
        "adapter_source_sha256": attempt["adapter_source_sha256"],
        "child_reaped": True,
        "containment_empty": True,
        "diagnostic_stream_complete": True,
        "hard_deadline_enforcement": True,
        "ncp_transport": False,
        "physical_authority": False,
        "scientific_authority": False,
    }
    lifecycle["receipt_sha256"] = sha256(canonical(lifecycle))
    evidence = {
        "nest_session_readback": session,
        "step_execution_receipts": executions,
        "worker_terminal_disposition": "confirmed-lifecycle",
        "worker_session_binding": binding,
        "worker_runtime_identity": identity,
        "worker_lifecycle_receipt": lifecycle,
        "worker_termination_attempt_receipts": attempts,
    }
    return evidence, neural_steps
