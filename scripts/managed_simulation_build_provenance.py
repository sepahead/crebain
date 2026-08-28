#!/usr/bin/env python3
"""Validate managed-simulation build and staging provenance receipts."""

from __future__ import annotations

import hashlib
import json
import re
import stat
import struct
from pathlib import PurePosixPath
from typing import Any, Mapping, NoReturn


SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
GIT_OBJECT_PATTERN = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")
MODULE_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*")
BUILD_RECEIPT_SCHEMA = "crebain.managed-simulation-observed-build-receipt.v1"
STAGE_RECEIPT_SCHEMA = "crebain.managed-simulation-package-stage-receipt.v1"
PACK_RECEIPT_SCHEMA = "crebain.managed-simulation-engram-pack-receipt.v1"
TARGET = {
    "target_id": "macos-aarch64-darwin",
    "operating_system": "macos",
    "architecture": "aarch64",
    "abi": "darwin",
    "rust_target_triple": "aarch64-apple-darwin",
}
BUILD_CONTRACT_PATHS = frozenset(
    {
        "integrations/engram/managed-simulation/contracts/configuration.schema.json",
        "integrations/engram/managed-simulation/contracts/finish-request.schema.json",
        "integrations/engram/managed-simulation/contracts/finish-response.schema.json",
        "integrations/engram/managed-simulation/contracts/managed-runtime-ipc.schema.json",
        "integrations/engram/managed-simulation/contracts/prepare-request.schema.json",
        "integrations/engram/managed-simulation/contracts/prepare-response.schema.json",
        "integrations/engram/managed-simulation/contracts/standard-v3-finish-request.schema.json",
        "integrations/engram/managed-simulation/contracts/standard-v3-finish-response.schema.json",
        "integrations/engram/managed-simulation/contracts/standard-v3-prepare-request.schema.json",
        "integrations/engram/managed-simulation/contracts/standard-v3-prepare-response.schema.json",
        "integrations/engram/managed-simulation/contracts/standard-v3-step-request.schema.json",
        "integrations/engram/managed-simulation/contracts/standard-v3-step-response.schema.json",
        "integrations/engram/managed-simulation/contracts/step-request.schema.json",
        "integrations/engram/managed-simulation/contracts/step-response.schema.json",
    }
)
NO_AUTHORITY = {
    "execution": False,
    "installation": False,
    "ncp": False,
    "physical": False,
    "plant": False,
    "scientific": False,
}
BUILD_RECEIPT_KEYS = {
    "schema_version",
    "repository",
    "source",
    "generator",
    "cargo",
    "output",
    "input_identity_sha256",
    "claims",
    "authority",
    "disclosure",
    "receipt_sha256",
}
REPOSITORY_KEYS = {
    "origin",
    "commit",
    "tree",
    "origin_main",
    "object_format",
    "clean",
}
SOURCE_KEYS = {"policy", "files", "roster_sha256"}
SOURCE_ROW_KEYS = {
    "relative_path",
    "size_bytes",
    "sha256",
    "git_mode",
    "git_blob",
}
GENERATOR_KEYS = {"files", "roster_sha256"}
CARGO_KEYS = {
    "workspace_manifest_path",
    "workspace_manifest_exact_sha256",
    "package_manifest_path",
    "package_manifest_exact_sha256",
    "lock_path",
    "lock_exact_sha256",
    "toolchain_path",
    "toolchain_exact_sha256",
    "rust_toolchain",
    "rustc_version",
    "cargo_version",
    "argv",
    "profile",
    "target",
    "target_directory_policy",
    "environment_policy",
}
OUTPUT_KEYS = {
    "file_name",
    "byte_length",
    "sha256",
    "source_mode",
    "format",
    "architecture",
    "file_type",
}
CLAIM_KEYS = {
    "observed_local_build",
    "reproducible_build",
    "signature",
    "external_dependency_bytes_attested",
    "complete_environment_attested",
}
STAGE_RECEIPT_KEYS = {
    "schema_version",
    "observed_build_receipt_exact_sha256",
    "observed_build_receipt_sha256",
    "crebain_commit",
    "crebain_tree",
    "origin_main",
    "target",
    "recipe_exact_sha256",
    "configuration_exact_sha256",
    "source_executable",
    "staged_executable",
    "package_inventory",
    "package_inventory_sha256",
    "authority",
    "disclosure",
    "receipt_sha256",
}
PACK_RECEIPT_KEYS = {
    "schema_version",
    "engram_repository",
    "engram_tool",
    "verification_policy",
    "operations",
    "observed_build_receipt_exact_sha256",
    "observed_build_receipt_sha256",
    "package_stage_receipt_exact_sha256",
    "package_stage_receipt_sha256",
    "seal_receipt_exact_sha256",
    "bundle_receipt_exact_sha256",
    "package_generation_id",
    "claims",
    "authority",
    "disclosure",
    "receipt_sha256",
}
PACK_TOOL_KEYS = {
    "relative_path",
    "size_bytes",
    "sha256",
    "git_mode",
    "git_blob",
}
EXECUTABLE_KEYS = {
    "byte_length",
    "sha256",
    "mode",
    "format",
    "architecture",
    "file_type",
}
INVENTORY_ROW_KEYS = {
    "relative_path",
    "byte_length",
    "sha256",
    "mode",
    "role",
}
EXPECTED_CARGO_ARGV = [
    "rustup",
    "run",
    "1.91.1",
    "cargo",
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "-p",
    "crebain-managed-simulation",
    "--target",
    "aarch64-apple-darwin",
    "--target-dir",
    "src-tauri/target/managed-simulation-bootstrap/observed-build-target",
]


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_receipt_digest(
    document: Mapping[str, Any], *, field: str = "receipt_sha256", label: str
) -> str:
    reported = document.get(field)
    if not isinstance(reported, str) or not SHA256_PATTERN.fullmatch(reported):
        fail(f"{label} lacks its canonical digest")
    material = {key: value for key, value in document.items() if key != field}
    if sha256(canonical(material)) != reported:
        fail(f"{label} canonical digest differs")
    return reported


def safe_relative(value: Any, *, label: str, suffix: str | None = None) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        fail(f"{label} is not one nonempty POSIX path")
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(
        part in {"", ".", ".."} for part in relative.parts
    ):
        fail(f"{label} is unsafe")
    if relative.as_posix() != value or (
        suffix is not None and relative.suffix != suffix
    ):
        fail(f"{label} is not canonical")
    return value


def _require_exact_keys(
    value: Any, expected: set[str], *, label: str
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} member roster differs")
    return value


def _require_sha256(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        fail(f"{label} is not one lowercase SHA-256 digest")
    return value


def _require_git_object(value: Any, *, label: str) -> str:
    if not isinstance(value, str) or not GIT_OBJECT_PATTERN.fullmatch(value):
        fail(f"{label} is not one lowercase Git object ID")
    return value


def validate_source_roster(
    rows: Any,
    *,
    label: str,
    require_build_inputs: bool,
) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or not rows or len(rows) > 128:
        fail(f"{label} has an invalid file count")
    paths: list[str] = []
    total_bytes = 0
    for row in rows:
        row = _require_exact_keys(row, SOURCE_ROW_KEYS, label=f"{label} row")
        path = safe_relative(row.get("relative_path"), label=f"{label} path")
        if row.get("git_mode") not in {"100644", "100755"}:
            fail(f"{label} Git mode differs")
        _require_git_object(row.get("git_blob"), label=f"{label} Git blob")
        _require_sha256(row.get("sha256"), label=f"{label} file digest")
        size = row.get("size_bytes")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or not 1 <= size <= 16 * 1024 * 1024
        ):
            fail(f"{label} file size is invalid")
        total_bytes += size
        paths.append(path)
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        fail(f"{label} paths are not sorted and unique")
    if total_bytes > 128 * 1024 * 1024:
        fail(f"{label} exceeds its byte bound")
    if require_build_inputs:
        required = {
            "rust-toolchain.toml",
            "src-tauri/Cargo.lock",
            "src-tauri/Cargo.toml",
            "src-tauri/crates/managed-simulation/Cargo.toml",
            "src-tauri/crates/managed-simulation/src/lib.rs",
            "src-tauri/crates/managed-simulation/src/main.rs",
            "src-tauri/src/pid_observation.rs",
            "src-tauri/src/sensor_fusion.rs",
        } | BUILD_CONTRACT_PATHS
        if not required.issubset(paths):
            fail(f"{label} lacks required build inputs")
        allowed = {
            "rust-toolchain.toml",
            "src-tauri/Cargo.lock",
            "src-tauri/Cargo.toml",
            "src-tauri/crates/managed-simulation/Cargo.toml",
            "src-tauri/src/pid_observation.rs",
            "src-tauri/src/sensor_fusion.rs",
        } | BUILD_CONTRACT_PATHS
        if any(
            path not in allowed
            and not (
                path.startswith("src-tauri/crates/managed-simulation/src/")
                and path.endswith(".rs")
            )
            for path in paths
        ):
            fail(f"{label} contains a path outside the managed build closure")
    return rows


def parse_macho_arm64_executable(payload: bytes) -> dict[str, str]:
    if len(payload) < 32:
        fail("managed-simulation executable is too short for a Mach-O header")
    if payload[:4] != b"\xcf\xfa\xed\xfe":
        fail("managed-simulation executable is not thin little-endian Mach-O 64-bit")
    (
        cpu_type,
        _cpu_subtype,
        file_type,
        command_count,
        command_bytes,
        _flags,
        reserved,
    ) = struct.unpack_from("<IIIIIII", payload, 4)
    if cpu_type != 0x0100000C:
        fail("managed-simulation executable architecture is not arm64")
    if file_type != 2:
        fail("managed-simulation Mach-O file type is not executable")
    if (
        reserved != 0
        or not 1 <= command_count <= 4096
        or command_bytes < command_count * 8
        or command_bytes > min(len(payload) - 32, 16 * 1024 * 1024)
    ):
        fail("managed-simulation Mach-O load-command envelope is invalid")
    command_end = 32 + command_bytes
    offset = 32
    has_executable_text = False
    has_main_entry = False
    maximum_file_end = 0
    for _index in range(command_count):
        if offset + 8 > command_end:
            fail("managed-simulation Mach-O load-command header is truncated")
        command, command_size = struct.unpack_from("<II", payload, offset)
        if (
            command_size < 8
            or command_size % 8 != 0
            or offset + command_size > command_end
        ):
            fail("managed-simulation Mach-O load-command size is invalid")
        if command == 0x19:  # LC_SEGMENT_64
            if command_size < 72:
                fail("managed-simulation Mach-O segment command is truncated")
            (
                segment_name,
                _vm_address,
                _vm_size,
                file_offset,
                file_size,
                _maximum_protection,
                initial_protection,
                _section_count,
                _segment_flags,
            ) = struct.unpack_from("<16sQQQQiiII", payload, offset + 8)
            if file_offset > len(payload) or file_size > len(payload) - file_offset:
                fail("managed-simulation Mach-O segment escapes the file")
            maximum_file_end = max(maximum_file_end, file_offset + file_size)
            if segment_name.rstrip(b"\0") == b"__TEXT":
                if (
                    file_offset != 0
                    or file_size < command_end
                    or initial_protection & 0x4 == 0
                ):
                    fail("managed-simulation Mach-O __TEXT segment is not executable")
                has_executable_text = True
        elif command == 0x80000028:  # LC_MAIN
            if command_size != 24:
                fail("managed-simulation Mach-O LC_MAIN command size is invalid")
            entry_offset, _stack_size = struct.unpack_from("<QQ", payload, offset + 8)
            if entry_offset < command_end or entry_offset >= len(payload):
                fail("managed-simulation Mach-O entry point escapes executable bytes")
            has_main_entry = True
        offset += command_size
    if offset != command_end:
        fail("managed-simulation Mach-O load-command roster is not exact")
    if (
        not has_executable_text
        or not has_main_entry
        or maximum_file_end != len(payload)
    ):
        fail("managed-simulation Mach-O executable structure is incomplete")
    return {"format": "mach-o-64", "architecture": "arm64", "file_type": "executable"}


def executable_identity(payload: bytes, mode: int) -> dict[str, Any]:
    permissions = stat.S_IMODE(mode)
    if permissions & stat.S_IXUSR == 0:
        fail("managed-simulation source lacks owner executable mode")
    if permissions & 0o022:
        fail("managed-simulation source executable is group- or world-writable")
    return {
        "byte_length": len(payload),
        "sha256": sha256(payload),
        "mode": permissions,
        **parse_macho_arm64_executable(payload),
    }


def validate_build_receipt(document: Any) -> dict[str, Any]:
    receipt = _require_exact_keys(
        document, BUILD_RECEIPT_KEYS, label="observed-build receipt"
    )
    if receipt.get("schema_version") != BUILD_RECEIPT_SCHEMA:
        fail("observed-build receipt schema differs")
    repository = _require_exact_keys(
        receipt.get("repository"), REPOSITORY_KEYS, label="build repository"
    )
    commit = _require_git_object(repository.get("commit"), label="CREBAIN commit")
    tree = _require_git_object(repository.get("tree"), label="CREBAIN tree")
    if (
        repository.get("origin_main") != commit
        or repository.get("object_format") not in {"sha1", "sha256"}
        or repository.get("clean") is not True
        or not isinstance(repository.get("origin"), str)
        or not repository.get("origin")
        or "\n" in repository.get("origin", "")
    ):
        fail("observed-build repository is not clean immutable origin/main")
    object_length = 40 if repository["object_format"] == "sha1" else 64
    if len(commit) != object_length or len(tree) != object_length:
        fail("observed-build Git objects differ from the declared object format")

    source = _require_exact_keys(
        receipt.get("source"), SOURCE_KEYS, label="build source closure"
    )
    if (
        source.get("policy")
        != "clean-origin-main-git-blob-and-rustc-dep-info-build-inputs.v1"
    ):
        fail("observed-build source policy differs")
    source_rows = validate_source_roster(
        source.get("files"), label="build source roster", require_build_inputs=True
    )
    if any(len(row["git_blob"]) != object_length for row in source_rows):
        fail("observed-build source blob differs from the Git object format")
    if source.get("roster_sha256") != sha256(canonical(source_rows)):
        fail("observed-build source roster digest differs")

    generator = _require_exact_keys(
        receipt.get("generator"), GENERATOR_KEYS, label="build generator closure"
    )
    generator_rows = validate_source_roster(
        generator.get("files"),
        label="build generator roster",
        require_build_inputs=False,
    )
    if any(len(row["git_blob"]) != object_length for row in generator_rows):
        fail("observed-build generator blob differs from the Git object format")
    expected_generator_paths = [
        "scripts/build-managed-simulation-bootstrap.py",
        "scripts/managed_simulation_authoring_files.py",
        "scripts/managed_simulation_build_provenance.py",
    ]
    if [row["relative_path"] for row in generator_rows] != expected_generator_paths:
        fail("observed-build generator source roster differs")
    if generator.get("roster_sha256") != sha256(canonical(generator_rows)):
        fail("observed-build generator roster digest differs")

    cargo = _require_exact_keys(receipt.get("cargo"), CARGO_KEYS, label="Cargo build")
    exact_paths = {
        "workspace_manifest_path": "src-tauri/Cargo.toml",
        "package_manifest_path": "src-tauri/crates/managed-simulation/Cargo.toml",
        "lock_path": "src-tauri/Cargo.lock",
        "toolchain_path": "rust-toolchain.toml",
    }
    for field, expected in exact_paths.items():
        if cargo.get(field) != expected:
            fail(f"observed-build {field} differs")
    for field in (
        "workspace_manifest_exact_sha256",
        "package_manifest_exact_sha256",
        "lock_exact_sha256",
        "toolchain_exact_sha256",
    ):
        _require_sha256(cargo.get(field), label=f"observed-build {field}")
    if (
        cargo.get("rust_toolchain") != "1.91.1"
        or cargo.get("rustc_version") != "rustc 1.91.1 (ed61e7d7e 2025-11-07)"
        or cargo.get("cargo_version") != "cargo 1.91.1 (ea2d97820 2025-10-10)"
        or cargo.get("argv") != EXPECTED_CARGO_ARGV
        or cargo.get("profile") != "release"
        or cargo.get("target") != TARGET
        or cargo.get("target_directory_policy")
        != "fresh-fixed-owner-private-removed-after-copy.v1"
        or cargo.get("environment_policy")
        != "reject-build-override-environment-and-record-output-bytes.v1"
    ):
        fail("observed-build Cargo toolchain, arguments, profile, or target differs")

    by_path = {row["relative_path"]: row for row in source_rows}
    digest_joins = {
        "workspace_manifest_exact_sha256": "src-tauri/Cargo.toml",
        "package_manifest_exact_sha256": "src-tauri/crates/managed-simulation/Cargo.toml",
        "lock_exact_sha256": "src-tauri/Cargo.lock",
        "toolchain_exact_sha256": "rust-toolchain.toml",
    }
    if any(
        cargo[field] != by_path[path]["sha256"] for field, path in digest_joins.items()
    ):
        fail("observed-build Cargo input digest differs from its Git source row")

    output = _require_exact_keys(
        receipt.get("output"), OUTPUT_KEYS, label="build output"
    )
    if (
        output.get("file_name") != "crebain-managed-simulation"
        or not isinstance(output.get("byte_length"), int)
        or isinstance(output.get("byte_length"), bool)
        or not 1 <= output.get("byte_length", 0) <= 64 * 1024 * 1024
        or output.get("source_mode") not in {0o700, 0o500, 0o755, 0o555}
        or output.get("format") != "mach-o-64"
        or output.get("architecture") != "arm64"
        or output.get("file_type") != "executable"
    ):
        fail("observed-build output identity differs")
    _require_sha256(output.get("sha256"), label="observed-build executable digest")

    input_identity = {
        "repository": repository,
        "source_roster_sha256": source["roster_sha256"],
        "generator_roster_sha256": generator["roster_sha256"],
        "cargo": cargo,
    }
    if receipt.get("input_identity_sha256") != sha256(canonical(input_identity)):
        fail("observed-build input identity digest differs")
    if receipt.get("claims") != {
        "observed_local_build": True,
        "reproducible_build": False,
        "signature": False,
        "external_dependency_bytes_attested": False,
        "complete_environment_attested": False,
    }:
        fail("observed-build claim boundary differs")
    if receipt.get("authority") != NO_AUTHORITY:
        fail("observed-build receipt grants authority")
    if not isinstance(receipt.get("disclosure"), str) or not receipt.get("disclosure"):
        fail("observed-build receipt lacks its disclosure")
    canonical_receipt_digest(receipt, label="observed-build receipt")
    return receipt


def validate_stage_inventory(rows: Any) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or not 2 <= len(rows) <= 128:
        fail("package-stage inventory has an invalid file count")
    paths: list[str] = []
    executable_count = 0
    for row in rows:
        row = _require_exact_keys(
            row, INVENTORY_ROW_KEYS, label="package-stage inventory row"
        )
        path = safe_relative(
            row.get("relative_path"), label="package-stage inventory path"
        )
        _require_sha256(row.get("sha256"), label="package-stage inventory digest")
        if (
            not isinstance(row.get("byte_length"), int)
            or isinstance(row.get("byte_length"), bool)
            or not 1 <= row.get("byte_length", 0) <= 64 * 1024 * 1024
            or row.get("mode") not in {0o600, 0o700}
            or row.get("role") not in {"contract", "executable"}
        ):
            fail("package-stage inventory row value differs")
        if row["role"] == "executable":
            executable_count += 1
            if path != "bin/crebain-managed-simulation" or row["mode"] != 0o700:
                fail("package-stage executable inventory differs")
        elif (
            not path.startswith("contracts/")
            or not path.endswith(".schema.json")
            or row["mode"] != 0o600
        ):
            fail("package-stage contract inventory path or mode differs")
        paths.append(path)
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        fail("package-stage inventory paths are not sorted and unique")
    if executable_count != 1:
        fail("package-stage inventory lacks one exact executable")
    return rows


def validate_stage_receipt(
    document: Any,
    *,
    build_receipt: Mapping[str, Any],
    build_receipt_bytes: bytes,
) -> dict[str, Any]:
    build_receipt = validate_build_receipt(build_receipt)
    if build_receipt_bytes != canonical(build_receipt) + b"\n":
        fail("observed-build receipt bytes are not exact canonical JSON")
    receipt = _require_exact_keys(
        document, STAGE_RECEIPT_KEYS, label="package-stage receipt"
    )
    if receipt.get("schema_version") != STAGE_RECEIPT_SCHEMA:
        fail("package-stage receipt schema differs")
    if (
        receipt.get("observed_build_receipt_exact_sha256")
        != sha256(build_receipt_bytes)
        or receipt.get("observed_build_receipt_sha256")
        != build_receipt.get("receipt_sha256")
        or receipt.get("crebain_commit")
        != build_receipt.get("repository", {}).get("commit")
        or receipt.get("crebain_tree")
        != build_receipt.get("repository", {}).get("tree")
        or receipt.get("origin_main") != receipt.get("crebain_commit")
        or receipt.get("target") != TARGET
    ):
        fail("package-stage build, Git, or target lineage differs")
    _require_sha256(
        receipt.get("recipe_exact_sha256"), label="package-stage recipe digest"
    )
    _require_sha256(
        receipt.get("configuration_exact_sha256"),
        label="package-stage configuration digest",
    )
    source = _require_exact_keys(
        receipt.get("source_executable"),
        EXECUTABLE_KEYS,
        label="stage source executable",
    )
    staged = _require_exact_keys(
        receipt.get("staged_executable"), EXECUTABLE_KEYS, label="staged executable"
    )
    expected_output = build_receipt["output"]
    if (
        source.get("byte_length") != expected_output.get("byte_length")
        or source.get("sha256") != expected_output.get("sha256")
        or source.get("mode") != expected_output.get("source_mode")
        or source.get("format") != expected_output.get("format")
        or source.get("architecture") != expected_output.get("architecture")
        or source.get("file_type") != expected_output.get("file_type")
        or staged
        != {
            **source,
            "mode": 0o700,
        }
    ):
        fail("package-stage executable does not join the observed build")
    inventory = validate_stage_inventory(receipt.get("package_inventory"))
    executable_row = next(row for row in inventory if row["role"] == "executable")
    if executable_row != {
        "relative_path": "bin/crebain-managed-simulation",
        "byte_length": staged["byte_length"],
        "sha256": staged["sha256"],
        "mode": staged["mode"],
        "role": "executable",
    }:
        fail("package-stage inventory executable lineage differs")
    if receipt.get("package_inventory_sha256") != sha256(canonical(inventory)):
        fail("package-stage inventory digest differs")
    if receipt.get("authority") != NO_AUTHORITY:
        fail("package-stage receipt grants authority")
    if not isinstance(receipt.get("disclosure"), str) or not receipt.get("disclosure"):
        fail("package-stage receipt lacks its disclosure")
    canonical_receipt_digest(receipt, label="package-stage receipt")
    return receipt


def validate_pack_receipt(document: Any) -> dict[str, Any]:
    receipt = _require_exact_keys(
        document, PACK_RECEIPT_KEYS, label="Engram pack receipt"
    )
    if receipt.get("schema_version") != PACK_RECEIPT_SCHEMA:
        fail("Engram pack receipt schema differs")
    repository = _require_exact_keys(
        receipt.get("engram_repository"),
        REPOSITORY_KEYS,
        label="Engram pack repository",
    )
    commit = _require_git_object(repository.get("commit"), label="Engram commit")
    tree = _require_git_object(repository.get("tree"), label="Engram tree")
    if (
        repository.get("origin_main") != commit
        or repository.get("object_format") not in {"sha1", "sha256"}
        or repository.get("clean") is not True
        or not isinstance(repository.get("origin"), str)
        or not repository.get("origin")
        or "\n" in repository.get("origin", "")
    ):
        fail("Engram pack repository is not clean immutable origin/main")
    object_length = 40 if repository["object_format"] == "sha1" else 64
    if len(commit) != object_length or len(tree) != object_length:
        fail("Engram pack Git objects differ from the declared object format")

    tool = _require_exact_keys(
        receipt.get("engram_tool"), PACK_TOOL_KEYS, label="Engram pack tool"
    )
    if (
        tool.get("relative_path") != "scripts/engram_extension.py"
        or tool.get("git_mode") not in {"100644", "100755"}
        or not isinstance(tool.get("size_bytes"), int)
        or isinstance(tool.get("size_bytes"), bool)
        or not 1 <= tool.get("size_bytes", 0) <= 1024 * 1024
    ):
        fail("Engram pack tool identity differs")
    _require_sha256(tool.get("sha256"), label="Engram pack tool digest")
    tool_blob = _require_git_object(
        tool.get("git_blob"), label="Engram pack tool Git blob"
    )
    if len(tool_blob) != object_length:
        fail("Engram pack tool blob differs from the Git object format")

    if (
        receipt.get("verification_policy")
        != "clean-head-origin-main-committed-tool-before-and-after-each-operation.v1"
        or receipt.get("operations")
        != [
            {"operation": "pack", "exit_code": 0, "source_reverified": True},
            {"operation": "check", "exit_code": 0, "source_reverified": True},
        ]
    ):
        fail("Engram pack verification policy or operation roster differs")
    for field in (
        "observed_build_receipt_exact_sha256",
        "observed_build_receipt_sha256",
        "package_stage_receipt_exact_sha256",
        "package_stage_receipt_sha256",
        "seal_receipt_exact_sha256",
        "bundle_receipt_exact_sha256",
    ):
        _require_sha256(receipt.get(field), label=f"Engram pack {field}")
    generation = receipt.get("package_generation_id")
    if (
        not isinstance(generation, str)
        or not generation.startswith("pkggen_")
        or not SHA256_PATTERN.fullmatch(generation.removeprefix("pkggen_"))
    ):
        fail("Engram pack package generation ID differs")
    if receipt.get("claims") != {
        "local_pack_observed": True,
        "local_check_observed": True,
        "publisher_authenticated": False,
        "signature": False,
        "reproducible": False,
        "executed_tool_loaded_bytes_attested": False,
        "complete_python_environment_attested": False,
    }:
        fail("Engram pack claim boundary differs")
    if receipt.get("authority") != NO_AUTHORITY:
        fail("Engram pack receipt grants authority")
    if not isinstance(receipt.get("disclosure"), str) or not receipt.get("disclosure"):
        fail("Engram pack receipt lacks its disclosure")
    canonical_receipt_digest(receipt, label="Engram pack receipt")
    return receipt


def validate_module_roster(rows: Any, *, label: str) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or len(rows) > 1024:
        fail(f"{label} is not one bounded roster")
    keys: list[tuple[str, str]] = []
    module_names: list[str] = []
    paths: list[str] = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"module_name", "relative_path"}:
            fail(f"{label} row member roster differs")
        module_name = row.get("module_name")
        if not isinstance(module_name, str) or not MODULE_PATTERN.fullmatch(
            module_name
        ):
            fail(f"{label} module name is not canonical")
        path = safe_relative(
            row.get("relative_path"), label=f"{label} source path", suffix=".py"
        )
        keys.append((module_name, path))
        module_names.append(module_name)
        paths.append(path)
    if keys != sorted(keys) or len(keys) != len(set(keys)):
        fail(f"{label} is not sorted and unique")
    if len(module_names) != len(set(module_names)) or len(paths) != len(set(paths)):
        fail(f"{label} module names or paths are not unique")
    return rows


def validate_path_roster(
    rows: Any,
    *,
    label: str,
    keys: set[str],
    sort_fields: tuple[str, ...],
    path_field: str = "relative_path",
) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or not rows or len(rows) > 1024:
        fail(f"{label} is not one bounded nonempty roster")
    order: list[tuple[Any, ...]] = []
    paths: list[str] = []
    for row in rows:
        if not isinstance(row, dict) or set(row) != keys:
            fail(f"{label} row member roster differs")
        paths.append(safe_relative(row.get(path_field), label=f"{label} path"))
        identity: list[str] = []
        for field in sort_fields:
            value = row.get(field)
            if not isinstance(value, str):
                fail(f"{label} {field} is not one string")
            identity.append(value)
        order.append(tuple(identity))
    if order != sorted(order) or len(order) != len(set(order)):
        fail(f"{label} is not sorted and unique")
    if len(paths) != len(set(paths)):
        fail(f"{label} paths are not unique")
    return rows
