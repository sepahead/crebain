#!/usr/bin/env python3
"""Run Engram's installed CREBAIN loop and capture its exact neural results."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import re
import stat
import sys
import tempfile
from argparse import Namespace
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

from managed_simulation_authoring_files import (
    ManagedSimulationSubprocessError,
    run_bounded_process,
    write_new_regular,
)
from managed_simulation_build_provenance import (
    TARGET,
    validate_build_receipt,
    validate_pack_receipt,
    validate_stage_receipt,
)


MAX_SOURCE_BYTES = 8 * 1024 * 1024
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_SOURCE_FILES = 1_024
MAX_SOURCE_TOTAL_BYTES = 128 * 1024 * 1024
MAX_RECEIPT_STORE_FILES = 128
MAX_RECEIPT_STORE_BYTES = 64 * 1024 * 1024
DEFAULT_RECEIPT_LOCK_TIMEOUT_MS = 30_000
MAX_RECEIPT_LOCK_TIMEOUT_MS = 300_000
SHA256_PATTERN = re.compile(r"[a-f0-9]{64}")
GIT_COMMIT_PATTERN = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")
REQUIRED_HOST_MODULES = frozenset(
    {
        "scripts.engram_extension",
        "backend.integrations.extension_package_store",
        "backend.integrations.managed_runtime_authoring",
        "backend.integrations.managed_runtime_contract",
        "backend.integrations.managed_runtime_json",
        "backend.integrations.managed_runtime_manager_contract",
        "backend.integrations.reviewed_native_development_session",
        "backend.integrations.reviewed_native_process_guardian",
        "backend.integrations.standard_closed_loop_simulator",
        "backend.optimization.extension_closed_loop",
        "backend.optimization.extension_closed_loop_limits",
        "backend.optimization.extension_closed_loop_nest",
        "backend.optimization.extension_closed_loop_nest_evidence",
        "backend.optimization.extension_closed_loop_nest_process",
        "backend.optimization.extension_closed_loop_receipt_store",
        "backend.optimization.simulator_study_ledger",
    }
)
REQUIRED_WORKER_MODULES = frozenset(
    {
        "backend.integrations.managed_runtime_contract",
        "backend.integrations.managed_runtime_json",
        "backend.integrations.managed_runtime_manager_contract",
        "backend.optimization.extension_closed_loop",
        "backend.optimization.extension_closed_loop_limits",
        "backend.optimization.extension_closed_loop_nest",
        "backend.optimization.extension_closed_loop_nest_process",
        "backend.optimization.simulator_study_ledger",
    }
)
EXERCISED_ENTRYPOINTS = (
    (
        "reviewed-runtime-guardian",
        "backend/integrations/reviewed_native_process_guardian.py",
    ),
    (
        "nest-worker",
        "backend/optimization/extension_closed_loop_nest_worker.py",
    ),
    (
        "nest-guardian",
        "backend/optimization/extension_closed_loop_nest_guardian.py",
    ),
)
SIMULATOR_ONLY_AUTHORITY = {
    "simulator_only": True,
    "ncp_qualified": False,
    "physical_actuation": False,
    "plant_control": False,
    "scientific_authority": False,
}
INSTALLED_PROOF_KEYS = {
    "schema_version",
    "observed_build_receipt_exact_sha256",
    "observed_build_receipt_sha256",
    "observed_build_receipt",
    "package_stage_receipt_exact_sha256",
    "package_stage_receipt_sha256",
    "package_stage_receipt",
    "engram_pack_receipt_exact_sha256",
    "engram_pack_receipt_sha256",
    "engram_pack_receipt",
    "crebain_commit",
    "crebain_tree",
    "crebain_origin_main",
    "engram_commit",
    "engram_tree",
    "engram_origin_main",
    "engram_extension_tool_sha256",
    "engram_extension_tool_git_blob",
    "build_source_roster_sha256",
    "build_input_identity_sha256",
    "executable_format",
    "executable_architecture",
    "store_id",
    "package_generation_id",
    "installation_id",
    "generation_core_sha256",
    "bundle_receipt_exact_sha256",
    "seal_receipt_exact_sha256",
    "install_observation_exact_sha256",
    "manifest_exact_sha256",
    "package_lock_exact_sha256",
    "configuration_exact_sha256",
    "package_sha256",
    "executable_sha256",
    "configuration_canonical_sha256",
    "operation_roster_sha256",
    "operation_ids",
    "standard_schema_sha256",
    "drone_counts",
    "step_count",
    "fault_step",
    "fault",
    "host_policy",
    "recovery_controls_sha256",
    "baseline_three_controls_sha256",
    "replay_exact",
    "unaffected_lane_observations_exact",
    "negative_clock_gate",
    "signal_cancellation_gate",
    "installed_artifacts_reverified_after_execution",
    "generation_seal_package_bundle_store_lineage_verified",
    "build_stage_seal_install_lineage_verified",
    "build_stage_seal_pack_install_lineage_verified",
    "authority",
    "disclosure",
    "receipt_sha256",
}
STANDARD_V3_SCHEMA_HASHES = {
    "engram.closed-loop-simulator.finish-request.v3": "486d0b94e229000b03eec04b0c6e05e6b01c9be1df1090d1c58c27bf14b09880",
    "engram.closed-loop-simulator.finish-response.v3": "abf670d295150b6f20d088aa88365e98f73fa4d0042859f7aa5d7a2403a45d9e",
    "engram.closed-loop-simulator.prepare-request.v3": "a5376511d1ba2edeef1b144074423bafc9fd88562893e3f2a4bba9718fc67e34",
    "engram.closed-loop-simulator.prepare-response.v3": "06fd034822ae82e164d2c14be034e0286b4f02d1345be076affebdd84fa5348a",
    "engram.closed-loop-simulator.step-request.v3": "aafb7c6574e83ba386acb4c10b81e5f9f4c1669e6b79208d86701b06fa473bb2",
    "engram.closed-loop-simulator.step-response.v3": "bac8b67dcd19fbd7addbf825cb1f3b1bf796fe28f638a84380bf906b32fcdb39",
}


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


def same_file_observation(before: os.stat_result, after: os.stat_result) -> bool:
    return (
        before.st_dev,
        before.st_ino,
        before.st_mode,
        before.st_uid,
        before.st_nlink,
        before.st_size,
        before.st_mtime_ns,
        before.st_ctime_ns,
    ) == (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_uid,
        after.st_nlink,
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    )


def read_regular(path: Path, maximum: int, *, allow_empty: bool = False) -> bytes:
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
    except OSError as error:
        fail(f"input cannot be opened without following links: {path}: {error}")
    try:
        observed = os.fstat(descriptor)
        if (
            not stat.S_ISREG(observed.st_mode)
            or observed.st_uid != os.geteuid()
            or observed.st_nlink != 1
            or (observed.st_size < 1 and not allow_empty)
            or observed.st_size > maximum
        ):
            fail(f"input is not one bounded owner-controlled file: {path}")
        chunks: list[bytes] = []
        remaining = observed.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                fail(f"input changed while it was read: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            fail(f"input grew while it was read: {path}")
        after = os.fstat(descriptor)
        if not same_file_observation(observed, after):
            fail(f"input changed while it was read: {path}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def decode_json_object(payload: bytes, label: str) -> dict[str, Any]:
    def closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                fail(f"{label} contains a duplicate JSON member: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        fail(f"{label} contains a non-finite JSON number: {value}")

    try:
        document = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=closed_object,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not strict UTF-8 JSON: {error}")
    if not isinstance(document, dict):
        fail(f"{label} must contain one JSON object")
    return document


def absolute_without_resolving_leaf(path: Path) -> Path:
    return Path(os.path.abspath(path))


def fresh_receipt_store_path(path: Path) -> Path:
    candidate = absolute_without_resolving_leaf(path)
    if candidate.exists() or candidate.is_symlink():
        fail("receipt store path must not exist before Engram initializes it")
    try:
        parent = candidate.parent.resolve(strict=True)
        observed_parent = parent.lstat()
    except OSError as error:
        fail(f"receipt store parent cannot be inspected: {error}")
    if (
        parent != candidate.parent
        or not stat.S_ISDIR(observed_parent.st_mode)
        or observed_parent.st_uid != os.geteuid()
        or observed_parent.st_mode & 0o022
    ):
        fail("receipt store parent is not one owner-controlled canonical directory")
    return candidate


def canonical_reported_absolute_path(value: Any, *, label: str) -> Path:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        fail(f"{label} is not one absolute POSIX path")
    reported = Path(value)
    canonical_path = absolute_without_resolving_leaf(reported)
    if not reported.is_absolute() or reported != canonical_path:
        fail(f"{label} is not one canonical absolute path")
    return reported


def model_document(value: Any) -> dict[str, Any]:
    document = value.model_dump(mode="python")
    if not isinstance(document, dict):
        fail("Engram model did not serialize to one JSON object")
    return document


def safe_source_relative(value: str) -> PurePosixPath:
    if (
        not value
        or "\\" in value
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        fail("Engram source path is not one canonical POSIX path")
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(
        part in {"", ".", ".."} for part in relative.parts
    ):
        fail(f"Engram source path is unsafe: {value}")
    if relative.as_posix() != value or relative.suffix != ".py":
        fail(f"Engram source path is not canonical Python source: {value}")
    return relative


def module_source_relative(module_name: str, *, is_package: bool) -> PurePosixPath:
    parts = module_name.split(".")
    if not parts or any(not part.isidentifier() for part in parts):
        fail(f"Engram module name is not canonical: {module_name}")
    base = PurePosixPath(*parts)
    return base / "__init__.py" if is_package else base.with_suffix(".py")


def source_record(
    engram_root: Path,
    relative: PurePosixPath,
    *,
    role: str,
    module_name: str | None = None,
) -> dict[str, Any]:
    path = engram_root.joinpath(*relative.parts)
    if path.parent.resolve(strict=True) != path.parent:
        fail(f"Engram source parent resolves outside its canonical path: {relative}")
    payload = read_regular(path, MAX_SOURCE_BYTES, allow_empty=True)
    record: dict[str, Any] = {
        "role": role,
        "relative_path": relative.as_posix(),
        "size_bytes": len(payload),
        "sha256": sha256(payload),
    }
    if module_name is not None:
        record["module_name"] = module_name
    return record


def collect_loaded_engram_sources(
    engram_root: Path,
    modules: Mapping[str, Any],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    paths: dict[str, str] = {}
    for module_name, module in tuple(modules.items()):
        observed_file = getattr(module, "__file__", None)
        if not isinstance(module_name, str) or not isinstance(observed_file, str):
            continue
        observed = absolute_without_resolving_leaf(Path(observed_file))
        try:
            relative_path = observed.relative_to(engram_root)
        except ValueError:
            continue
        relative = safe_source_relative(relative_path.as_posix())
        expected = module_source_relative(
            module_name,
            is_package=hasattr(module, "__path__"),
        )
        if relative != expected:
            fail(
                "Engram module source alias differs from its canonical module path: "
                f"{module_name}"
            )
        prior = paths.setdefault(relative.as_posix(), module_name)
        if prior != module_name:
            fail(f"Engram source has more than one loaded module name: {relative}")
        records.append(
            source_record(
                engram_root,
                relative,
                role="host-loaded-module",
                module_name=module_name,
            )
        )
    loaded_names = {record["module_name"] for record in records}
    missing = sorted(REQUIRED_HOST_MODULES - loaded_names)
    if missing:
        fail(f"Engram host source closure is missing required modules: {missing}")
    if len(records) > MAX_SOURCE_FILES:
        fail("Engram host source closure exceeds its file bound")
    return sorted(records, key=lambda record: record["module_name"])


def collect_entrypoint_sources(engram_root: Path) -> list[dict[str, Any]]:
    return [
        source_record(
            engram_root,
            safe_source_relative(relative),
            role=role,
        )
        for role, relative in EXERCISED_ENTRYPOINTS
    ]


def collect_worker_sources(
    engram_root: Path,
    evidence_document: Mapping[str, Any],
) -> list[dict[str, Any]]:
    identity = evidence_document.get("worker_runtime_identity")
    if not isinstance(identity, dict):
        fail("NEST evidence does not contain a worker runtime identity")
    if identity.get("project_source_closure_verified") is not True or not isinstance(
        identity.get("project_source_roster_sha256"), str
    ):
        fail("NEST worker project source closure is not verified")
    if not SHA256_PATTERN.fullmatch(identity["project_source_roster_sha256"]):
        fail("NEST worker project source roster digest is invalid")
    files = identity.get("files")
    if (
        not isinstance(files, (list, tuple))
        or not files
        or len(files) > MAX_SOURCE_FILES
    ):
        fail("NEST worker runtime file roster is invalid")
    if identity.get("file_roster_sha256") != sha256(canonical(files)):
        fail("NEST worker runtime file roster digest differs")
    project_file_rows = tuple(
        row
        for row in files
        if isinstance(row, dict)
        and isinstance(row.get("role"), str)
        and row["role"].startswith("project-module:")
    )
    if identity["project_source_roster_sha256"] != sha256(canonical(project_file_rows)):
        fail("NEST worker project source roster digest differs")

    worker_file = next(
        (
            row
            for row in files
            if isinstance(row, dict) and row.get("role") == "worker-source"
        ),
        None,
    )
    if worker_file is None:
        fail("NEST worker runtime identity lacks its worker source")
    worker_relative = safe_source_relative(
        "backend/optimization/extension_closed_loop_nest_worker.py"
    )
    reported_worker = canonical_reported_absolute_path(
        worker_file.get("absolute_path"),
        label="NEST worker source path",
    )
    worker_runtime_root = reported_worker
    for _part in worker_relative.parts:
        worker_runtime_root = worker_runtime_root.parent
    if worker_runtime_root.joinpath(*worker_relative.parts) != reported_worker:
        fail("NEST worker source path does not identify one runtime source root")

    records: list[dict[str, Any]] = []
    seen_roles: set[str] = set()
    worker_modules: set[str] = set()
    worker_source_seen = False
    for row in files:
        if not isinstance(row, dict):
            fail("NEST worker runtime file row is invalid")
        role = row.get("role")
        if not isinstance(role, str) or role in seen_roles:
            fail("NEST worker runtime file roles are not unique strings")
        seen_roles.add(role)
        module_name: str | None = None
        if role.startswith("project-module:"):
            module_name = role.removeprefix("project-module:")
            reported = canonical_reported_absolute_path(
                row.get("absolute_path"),
                label="NEST worker project source path",
            )
            is_package = reported.name == "__init__.py"
            relative = module_source_relative(module_name, is_package=is_package)
            worker_modules.add(module_name)
        elif role == "worker-source":
            relative = worker_relative
            reported = reported_worker
            worker_source_seen = True
        else:
            continue
        expected = worker_runtime_root.joinpath(*relative.parts)
        if reported != expected:
            fail(f"NEST worker source path escapes its runtime source root: {role}")
        observed = source_record(
            engram_root,
            relative,
            role="worker-loaded-module" if module_name else "nest-worker-entrypoint",
            module_name=module_name,
        )
        if (
            row.get("sha256") != observed["sha256"]
            or row.get("size_bytes") != observed["size_bytes"]
        ):
            fail(f"NEST worker source bytes differ from its runtime identity: {role}")
        records.append(observed)
    missing = sorted(REQUIRED_WORKER_MODULES - worker_modules)
    if missing or not worker_source_seen:
        fail(
            "NEST worker source closure is incomplete: "
            f"missing_modules={missing}, worker_source={worker_source_seen}"
        )

    expectation = evidence_document.get("runtime_launch_expectation")
    if not isinstance(expectation, dict):
        fail("NEST evidence lacks its runtime launch expectation")
    required_files = expectation.get("required_runtime_files")
    if not isinstance(required_files, (list, tuple)) or not required_files:
        fail("NEST runtime launch expectation lacks required files")
    identity_by_role = {
        row["role"]: row
        for row in files
        if isinstance(row, dict) and isinstance(row.get("role"), str)
    }
    required_by_role: dict[str, Mapping[str, Any]] = {}
    for row in required_files:
        if not isinstance(row, dict) or not isinstance(row.get("role"), str):
            fail("NEST required runtime file row is invalid")
        if row["role"] in required_by_role:
            fail("NEST required runtime file roles are not unique")
        required_by_role[row["role"]] = row
        if identity_by_role.get(row["role"]) != row:
            fail("NEST required runtime file differs from worker observation")
    if required_by_role.get("worker-source") != worker_file:
        fail("NEST launch expectation does not bind the worker source")

    guardian_relative = safe_source_relative(
        "backend/optimization/extension_closed_loop_nest_guardian.py"
    )
    guardian_file = expectation.get("guardian_source_file")
    if not isinstance(guardian_file, dict) or guardian_file.get("role") != (
        "guardian-source"
    ):
        fail("NEST launch expectation lacks its guardian source")
    reported_guardian = canonical_reported_absolute_path(
        guardian_file.get("absolute_path"),
        label="NEST guardian source path",
    )
    if reported_guardian != worker_runtime_root.joinpath(*guardian_relative.parts):
        fail("NEST guardian source escapes the worker runtime source root")
    guardian_record = source_record(
        engram_root,
        guardian_relative,
        role="nest-guardian-entrypoint",
    )
    if (
        guardian_file.get("sha256") != guardian_record["sha256"]
        or guardian_file.get("size_bytes") != guardian_record["size_bytes"]
        or expectation.get("guardian_source_sha256") != guardian_record["sha256"]
        or expectation.get("worker_source_sha256") != worker_file.get("sha256")
    ):
        fail("NEST worker or guardian source differs from its launch expectation")
    records.append(guardian_record)

    binding = evidence_document.get("worker_session_binding")
    if not isinstance(binding, dict):
        fail("NEST evidence lacks its worker session binding")
    adapter_role = (
        "project-module:backend.optimization.extension_closed_loop_nest_process"
    )
    adapter_file = identity_by_role.get(adapter_role)
    if not isinstance(adapter_file, dict) or (
        binding.get("worker_source_sha256") != worker_file.get("sha256")
        or binding.get("guardian_source_sha256") != guardian_record["sha256"]
        or binding.get("adapter_source_sha256") != adapter_file.get("sha256")
        or binding.get("worker_project_source_roster_sha256")
        != identity["project_source_roster_sha256"]
    ):
        fail("NEST worker session source lineage differs")
    return sorted(
        records,
        key=lambda record: (
            record.get("module_name", ""),
            record["relative_path"],
        ),
    )


def merge_source_inventory(
    *record_groups: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_path: dict[str, dict[str, Any]] = {}
    for record in (record for group in record_groups for record in group):
        relative = record["relative_path"]
        prior = by_path.get(relative)
        source = {
            "relative_path": relative,
            "size_bytes": record["size_bytes"],
            "sha256": record["sha256"],
        }
        if prior is not None and prior != source:
            fail(f"Engram source observations disagree: {relative}")
        by_path[relative] = source
    if not by_path or len(by_path) > MAX_SOURCE_FILES:
        fail("Engram source closure has an invalid file count")
    if (
        sum(record["size_bytes"] for record in by_path.values())
        > MAX_SOURCE_TOTAL_BYTES
    ):
        fail("Engram source closure exceeds its byte bound")
    return [by_path[path] for path in sorted(by_path)]


def verify_source_inventory(
    engram_root: Path,
    inventory: list[dict[str, Any]],
) -> None:
    for record in inventory:
        relative = safe_source_relative(record["relative_path"])
        payload = read_regular(
            engram_root.joinpath(*relative.parts),
            MAX_SOURCE_BYTES,
            allow_empty=True,
        )
        if len(payload) != record["size_bytes"] or sha256(payload) != record["sha256"]:
            fail(f"Engram source changed during capture: {relative}")


def git_output(engram_root: Path, *arguments: str) -> bytes:
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    environment.update({"GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"})
    try:
        completed = run_bounded_process(
            ["git", *arguments],
            cwd=engram_root,
            env=environment,
            input_bytes=None,
            timeout_seconds=30,
            max_input_bytes=0,
            max_stdout_bytes=MAX_INPUT_BYTES,
            max_stderr_bytes=64 * 1024,
            label="Engram Git verification",
        )
    except ManagedSimulationSubprocessError as error:
        diagnostic = error.stderr[:4096].decode("utf-8", errors="replace")
        fail(f"Engram Git verification failed: {error}: {diagnostic.strip()}")
    if completed.returncode != 0:
        diagnostic = completed.stderr[:4096].decode("utf-8", errors="replace")
        fail(f"Engram Git verification failed: {diagnostic.strip()}")
    return completed.stdout


def verify_immutable_engram_checkout(
    engram_root: Path,
    expected_commit: str,
) -> dict[str, Any]:
    if not GIT_COMMIT_PATTERN.fullmatch(expected_commit):
        fail("expected Engram commit is not one lowercase Git object ID")
    head = git_output(engram_root, "rev-parse", "--verify", "HEAD").decode().strip()
    remote_main = (
        git_output(engram_root, "rev-parse", "--verify", "refs/remotes/origin/main")
        .decode()
        .strip()
    )
    if head != expected_commit or remote_main != expected_commit:
        fail("Engram HEAD and local origin/main do not equal the required commit")
    if git_output(engram_root, "cat-file", "-t", expected_commit) != b"commit\n":
        fail("required Engram object is not a commit")
    status = git_output(
        engram_root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    )
    if status:
        fail("Engram checkout is not clean")
    tree = (
        git_output(engram_root, "rev-parse", f"{expected_commit}^{{tree}}")
        .decode()
        .strip()
    )
    object_format = (
        git_output(engram_root, "rev-parse", "--show-object-format").decode().strip()
    )
    repository = git_output(engram_root, "remote", "get-url", "origin").decode().strip()
    object_length = 40 if object_format == "sha1" else 64
    if (
        object_format not in {"sha1", "sha256"}
        or len(expected_commit) != object_length
        or len(tree) != object_length
        or not repository
        or "\n" in repository
    ):
        fail("Engram Git object format, object IDs, or origin URL is malformed")
    return {
        "repository": repository,
        "commit": expected_commit,
        "tree": tree,
        "origin_main": remote_main,
        "object_format": object_format,
        "clean": True,
    }


def bind_git_source_objects(
    engram_root: Path,
    expected_commit: str,
    inventory: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    paths = [record["relative_path"] for record in inventory]
    payload = git_output(
        engram_root,
        "ls-tree",
        "-z",
        "--full-tree",
        expected_commit,
        "--",
        *paths,
    )
    rows: dict[str, tuple[str, str]] = {}
    for entry in payload.split(b"\0"):
        if not entry:
            continue
        try:
            header, raw_path = entry.split(b"\t", 1)
            mode, kind, object_id = header.decode("ascii").split(" ")
            path = raw_path.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as error:
            fail(f"Engram Git source catalog is malformed: {error}")
        if (
            kind != "blob"
            or mode not in {"100644", "100755"}
            or not GIT_COMMIT_PATTERN.fullmatch(object_id)
            or len(object_id) != len(expected_commit)
            or path in rows
        ):
            fail(f"Engram Git source catalog contains an invalid row: {path}")
        rows[path] = (mode, object_id)
    if set(rows) != set(paths):
        fail("Engram source closure contains untracked or missing Git paths")
    for path, (_mode, object_id) in rows.items():
        observed_id = (
            git_output(
                engram_root,
                "hash-object",
                "--no-filters",
                "--",
                path,
            )
            .decode()
            .strip()
        )
        if observed_id != object_id:
            fail(f"Engram source bytes differ from their committed Git blob: {path}")
    return [
        {
            **record,
            "git_mode": rows[record["relative_path"]][0],
            "git_blob": rows[record["relative_path"]][1],
        }
        for record in inventory
    ]


def verify_pack_source_lineage(
    installed_proof: Mapping[str, Any],
    engram_identity: Mapping[str, Any],
    source_inventory: list[dict[str, Any]] | None = None,
) -> None:
    pack = installed_proof.get("engram_pack_receipt")
    if not isinstance(pack, dict):
        fail("installed proof lacks its Engram pack receipt")
    repository = pack.get("engram_repository")
    tool = pack.get("engram_tool")
    expected_repository = {
        "origin": engram_identity.get("repository"),
        "commit": engram_identity.get("commit"),
        "tree": engram_identity.get("tree"),
        "origin_main": engram_identity.get("origin_main"),
        "object_format": engram_identity.get("object_format"),
        "clean": engram_identity.get("clean"),
    }
    if (
        repository != expected_repository
        or installed_proof.get("engram_commit") != engram_identity.get("commit")
        or installed_proof.get("engram_tree") != engram_identity.get("tree")
        or installed_proof.get("engram_origin_main")
        != engram_identity.get("origin_main")
        or not isinstance(tool, dict)
        or installed_proof.get("engram_extension_tool_sha256") != tool.get("sha256")
        or installed_proof.get("engram_extension_tool_git_blob") != tool.get("git_blob")
    ):
        fail("Engram pack source lineage differs from the immutable checkout")
    if source_inventory is None:
        return
    matching = [
        row
        for row in source_inventory
        if row.get("relative_path") == "scripts/engram_extension.py"
    ]
    if len(matching) != 1 or matching[0] != tool:
        fail("Engram pack tool differs from the loaded committed source closure")


def validate_receipt_lock_timeout(value: int) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= MAX_RECEIPT_LOCK_TIMEOUT_MS
    ):
        fail("receipt lock timeout must be between 1 and 300000 ms")
    return value


def assert_canonical_digest(
    document: Mapping[str, Any],
    *,
    field: str,
    label: str,
) -> str:
    reported = document.get(field)
    if not isinstance(reported, str) or not SHA256_PATTERN.fullmatch(reported):
        fail(f"{label} lacks its canonical digest")
    material = {key: value for key, value in document.items() if key != field}
    if sha256(canonical(material)) != reported:
        fail(f"{label} canonical digest differs")
    return reported


def load_installed_proof(path: Path) -> tuple[dict[str, Any], bytes]:
    payload = read_regular(path, MAX_INPUT_BYTES)
    document = decode_json_object(payload, "installed managed-simulation proof")
    if payload != canonical(document) + b"\n":
        fail("installed managed-simulation proof is not exact canonical JSON")
    if set(document) != INSTALLED_PROOF_KEYS or document.get("schema_version") != (
        "crebain.standard-v3-installed-binary-proof.v3"
    ):
        fail("installed managed-simulation proof schema differs")
    assert_canonical_digest(
        document,
        field="receipt_sha256",
        label="installed managed-simulation proof",
    )
    authority = document.get("authority")
    observed_build = document.get("observed_build_receipt")
    package_stage = document.get("package_stage_receipt")
    engram_pack = document.get("engram_pack_receipt")
    if (
        not isinstance(observed_build, dict)
        or not isinstance(package_stage, dict)
        or not isinstance(engram_pack, dict)
    ):
        fail("installed managed-simulation proof lacks build, stage, or pack receipts")
    validate_build_receipt(observed_build)
    observed_build_bytes = canonical(observed_build) + b"\n"
    validate_stage_receipt(
        package_stage,
        build_receipt=observed_build,
        build_receipt_bytes=observed_build_bytes,
    )
    package_stage_bytes = canonical(package_stage) + b"\n"
    validate_pack_receipt(engram_pack)
    engram_pack_bytes = canonical(engram_pack) + b"\n"
    pack_repository = engram_pack["engram_repository"]
    pack_tool = engram_pack["engram_tool"]
    if (
        authority != SIMULATOR_ONLY_AUTHORITY
        or document.get("drone_counts") != [1, 2, 3]
        or document.get("replay_exact") is not True
        or document.get("unaffected_lane_observations_exact") is not True
        or document.get("installed_artifacts_reverified_after_execution") is not True
        or document.get("generation_seal_package_bundle_store_lineage_verified")
        is not True
        or document.get("build_stage_seal_install_lineage_verified") is not True
        or document.get("build_stage_seal_pack_install_lineage_verified") is not True
        or document.get("observed_build_receipt_exact_sha256")
        != sha256(observed_build_bytes)
        or document.get("observed_build_receipt_sha256")
        != observed_build.get("receipt_sha256")
        or document.get("package_stage_receipt_exact_sha256")
        != sha256(package_stage_bytes)
        or document.get("package_stage_receipt_sha256")
        != package_stage.get("receipt_sha256")
        or document.get("engram_pack_receipt_exact_sha256") != sha256(engram_pack_bytes)
        or document.get("engram_pack_receipt_sha256")
        != engram_pack.get("receipt_sha256")
        or document.get("crebain_commit")
        != observed_build.get("repository", {}).get("commit")
        or document.get("crebain_tree")
        != observed_build.get("repository", {}).get("tree")
        or document.get("crebain_origin_main") != document.get("crebain_commit")
        or package_stage.get("crebain_commit") != document.get("crebain_commit")
        or document.get("engram_commit") != pack_repository.get("commit")
        or document.get("engram_tree") != pack_repository.get("tree")
        or document.get("engram_origin_main") != document.get("engram_commit")
        or document.get("engram_origin_main") != pack_repository.get("origin_main")
        or document.get("engram_extension_tool_sha256") != pack_tool.get("sha256")
        or document.get("engram_extension_tool_git_blob") != pack_tool.get("git_blob")
        or engram_pack.get("observed_build_receipt_exact_sha256")
        != sha256(observed_build_bytes)
        or engram_pack.get("observed_build_receipt_sha256")
        != observed_build.get("receipt_sha256")
        or engram_pack.get("package_stage_receipt_exact_sha256")
        != sha256(package_stage_bytes)
        or engram_pack.get("package_stage_receipt_sha256")
        != package_stage.get("receipt_sha256")
        or engram_pack.get("seal_receipt_exact_sha256")
        != document.get("seal_receipt_exact_sha256")
        or engram_pack.get("bundle_receipt_exact_sha256")
        != document.get("bundle_receipt_exact_sha256")
        or engram_pack.get("package_generation_id")
        != document.get("package_generation_id")
        or document.get("build_source_roster_sha256")
        != observed_build.get("source", {}).get("roster_sha256")
        or document.get("build_input_identity_sha256")
        != observed_build.get("input_identity_sha256")
        or document.get("configuration_exact_sha256")
        != package_stage.get("configuration_exact_sha256")
        or document.get("executable_format") != "mach-o-64"
        or document.get("executable_architecture") != "arm64"
        or package_stage.get("target") != TARGET
        or not isinstance(document.get("disclosure"), str)
        or not document.get("disclosure")
    ):
        fail("installed managed-simulation proof is incomplete or grants authority")
    for field, prefix in (
        ("store_id", "extstore_"),
        ("package_generation_id", "pkggen_"),
        ("installation_id", "inst_"),
    ):
        value = document.get(field)
        if (
            not isinstance(value, str)
            or value[: len(prefix)] != prefix
            or not SHA256_PATTERN.fullmatch(value[len(prefix) :])
        ):
            fail(f"installed managed-simulation proof lacks {field}")
    for field in (
        "generation_core_sha256",
        "bundle_receipt_exact_sha256",
        "seal_receipt_exact_sha256",
        "install_observation_exact_sha256",
        "manifest_exact_sha256",
        "package_lock_exact_sha256",
        "configuration_exact_sha256",
        "package_sha256",
        "executable_sha256",
        "configuration_canonical_sha256",
        "operation_roster_sha256",
        "observed_build_receipt_exact_sha256",
        "observed_build_receipt_sha256",
        "package_stage_receipt_exact_sha256",
        "package_stage_receipt_sha256",
        "engram_pack_receipt_exact_sha256",
        "engram_pack_receipt_sha256",
        "build_source_roster_sha256",
        "build_input_identity_sha256",
        "engram_extension_tool_sha256",
    ):
        value = document.get(field)
        if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
            fail(f"installed managed-simulation proof lacks {field}")
    for field in (
        "engram_commit",
        "engram_tree",
        "engram_origin_main",
        "engram_extension_tool_git_blob",
    ):
        value = document.get(field)
        if not isinstance(value, str) or not GIT_COMMIT_PATTERN.fullmatch(value):
            fail(f"installed managed-simulation proof lacks {field}")
    if document.get("executable_sha256") != observed_build.get("output", {}).get(
        "sha256"
    ) or document.get("executable_sha256") != package_stage.get(
        "staged_executable", {}
    ).get("sha256"):
        fail("installed executable differs from its build and stage receipts")
    if document.get("signal_cancellation_gate") != (
        "active-SIGTERM-then-fresh-generation-prepared"
    ):
        fail("installed managed-simulation proof lacks its cancellation closure")
    if (
        document.get("operation_ids")
        != [
            "crebain.simulation.finish.v1",
            "crebain.simulation.finish.v3",
            "crebain.simulation.prepare.v1",
            "crebain.simulation.prepare.v3",
            "crebain.simulation.step.v1",
            "crebain.simulation.step.v3",
        ]
        or document.get("step_count") != 6
        or document.get("fault_step") != 3
        or document.get("fault") != "sensor-unavailable"
        or document.get("host_policy")
        != [
            "fault-observed",
            "safe-hold",
            "bounded-zero-washout",
            "bounded-nonzero-resume",
        ]
        or document.get("negative_clock_gate") != "standard.clock-mismatch"
    ):
        fail("installed managed-simulation proof contract roster differs")
    recovery_controls = document.get("recovery_controls_sha256")
    standard_schemas = document.get("standard_schema_sha256")
    if (
        not isinstance(recovery_controls, dict)
        or set(recovery_controls) != {"1", "2", "3"}
        or any(
            not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value)
            for value in recovery_controls.values()
        )
        or standard_schemas != STANDARD_V3_SCHEMA_HASHES
        or not SHA256_PATTERN.fullmatch(
            document.get("baseline_three_controls_sha256", "")
        )
    ):
        fail("installed managed-simulation proof digest roster differs")
    return document, payload


def expected_population_topology(
    plan_document: Mapping[str, Any],
) -> tuple[list[str], list[str], list[tuple[str, int]]]:
    channels = plan_document.get("channels")
    if not isinstance(channels, list) or not 1 <= len(channels) <= 3:
        fail("run plan requires one through three drone channels")
    channel_ids: list[str] = []
    population_names: list[str] = []
    axis_roster: list[tuple[str, int]] = []
    prefixes: set[str] = set()
    for channel in channels:
        if not isinstance(channel, dict):
            fail("run plan channel is not an object")
        channel_id = channel.get("channel_id")
        prefix = channel.get("neural_population_prefix")
        axes = channel.get("neural_control_axes")
        if (
            not isinstance(channel_id, str)
            or channel_id in channel_ids
            or not isinstance(prefix, str)
            or prefix in prefixes
            or channel.get("subject_kind") != "simulated.drone"
            or channel.get("action_width") != 3
            or not isinstance(axes, list)
            or [axis.get("action_index") for axis in axes if isinstance(axis, dict)]
            != [0, 1, 2]
        ):
            fail("run plan channel or three-axis neural topology differs")
        channel_ids.append(channel_id)
        prefixes.add(prefix)
        for action_index in range(3):
            axis_roster.append((channel_id, action_index))
            population_names.extend(
                (
                    f"{prefix}.d{action_index:02}.negative",
                    f"{prefix}.d{action_index:02}.positive",
                )
            )
    return channel_ids, population_names, axis_roster


def exact_named_rows(
    rows: Any,
    *,
    key: str,
    expected: list[str],
    label: str,
) -> list[Mapping[str, Any]]:
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        fail(f"{label} is not one object roster")
    if [row.get(key) for row in rows] != expected:
        fail(f"{label} differs from the exact population topology")
    return rows


def assert_population_topology(
    plan_document: Mapping[str, Any],
    config_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
    neural_steps: list[dict[str, Any]],
) -> dict[str, Any]:
    channel_ids, population_names, axis_roster = expected_population_topology(
        plan_document
    )
    population_size = config_document.get("population_size")
    if (
        not isinstance(population_size, int)
        or isinstance(population_size, bool)
        or population_size < 1
    ):
        fail("NEST configuration population size is not an integer")
    session = evidence_document.get("nest_session_readback")
    if not isinstance(session, dict) or session.get("one_session") is not True:
        fail("NEST evidence does not prove exactly one session")
    expected_population_count = 6 * len(channel_ids)
    if len(population_names) != expected_population_count:
        fail("expected signed population topology is not exactly 6N")
    expected_connections = [
        (population_name, direction)
        for population_name in population_names
        for direction in ("input", "recorder")
    ]
    connection_rows = session.get("connection_readbacks")
    if not isinstance(connection_rows, list) or any(
        not isinstance(row, dict) for row in connection_rows
    ):
        fail("NEST connection readbacks are absent")
    if [
        (row.get("population_name"), row.get("direction")) for row in connection_rows
    ] != expected_connections:
        fail("NEST connection topology differs from the exact 6N roster")
    if any(row.get("connection_count") != population_size for row in connection_rows):
        fail("NEST connection count differs from the population size")
    if session.get("connection_readback_sha256") != sha256(canonical(connection_rows)):
        fail("NEST connection readback digest differs")
    if (
        session.get("observed_population_neuron_count")
        != expected_population_count * population_size
        or session.get("observed_device_node_count") != expected_population_count * 2
        or session.get("observed_total_connection_count")
        != expected_population_count * population_size * 2
    ):
        fail("NEST node or connection totals differ from the exact 6N topology")
    reported_roster = session.get("population_roster")
    if reported_roster is not None:
        if not isinstance(reported_roster, list):
            fail("NEST population roster is not an array")
        names = [
            row.get("population_name") if isinstance(row, dict) else row
            for row in reported_roster
        ]
        if names != population_names:
            fail("NEST population roster differs from the exact 6N topology")

    executions = evidence_document.get("step_execution_receipts")
    if (
        not isinstance(executions, list)
        or len(executions) != 6
        or len(neural_steps) != 6
    ):
        fail("NEST topology proof requires six exact steps")
    expected_axes = [list(row) for row in axis_roster]
    for step_index, (execution, neural_step) in enumerate(
        zip(executions, neural_steps, strict=True), start=1
    ):
        if not isinstance(execution, dict):
            fail("NEST execution receipt is not an object")
        for key, label in (
            ("generator_schedule_readbacks", "generator schedule roster"),
            ("input_weight_readbacks", "input weight roster"),
            ("completed_window_readbacks", "completed window roster"),
            ("population_event_deltas", "population event roster"),
        ):
            exact_named_rows(
                execution.get(key),
                key="population_name",
                expected=population_names,
                label=f"step {step_index} {label}",
            )
        safety = exact_named_rows(
            execution.get("channel_safety_readbacks"),
            key="channel_id",
            expected=channel_ids,
            label=f"step {step_index} channel safety roster",
        )
        if len(safety) != len(channel_ids):
            fail("NEST channel safety roster cardinality differs")
        encoded = execution.get("encoded_control_inputs")
        if (
            not isinstance(encoded, list)
            or any(not isinstance(row, dict) for row in encoded)
            or [[row.get("channel_id"), row.get("action_index")] for row in encoded]
            != expected_axes
        ):
            fail(f"step {step_index} encoded control axis roster differs")
        result = neural_step.get("result")
        request = neural_step.get("request")
        if not isinstance(result, dict) or not isinstance(request, dict):
            fail("captured neural step lacks request or result")
        if [
            row.get("channel_id") for row in request.get("channels", [])
        ] != channel_ids:
            fail(f"step {step_index} neural request channel roster differs")
        proposals = result.get("proposals")
        if (
            not isinstance(proposals, list)
            or [row.get("channel_id") for row in proposals if isinstance(row, dict)]
            != channel_ids
        ):
            fail(f"step {step_index} neural proposal channel roster differs")
        for channel_ordinal, proposal in enumerate(proposals):
            expected_sources = population_names[
                channel_ordinal * 6 : (channel_ordinal + 1) * 6
            ]
            if proposal.get("source_populations") != expected_sources:
                fail(f"step {step_index} neural proposal population roster differs")
    return {
        "session_count": 1,
        "drone_count": len(channel_ids),
        "action_axis_count": len(axis_roster),
        "population_count": expected_population_count,
        "population_neuron_count": expected_population_count * population_size,
        "device_node_count": expected_population_count * 2,
        "connection_count": expected_population_count * population_size * 2,
        "population_names": population_names,
        "derived_population_roster_sha256": sha256(canonical(population_names)),
    }


def assert_worker_guardian_closure(
    evidence_document: Mapping[str, Any],
) -> dict[str, Any]:
    binding = evidence_document.get("worker_session_binding")
    lifecycle = evidence_document.get("worker_lifecycle_receipt")
    attempts = evidence_document.get("worker_termination_attempt_receipts")
    identity = evidence_document.get("worker_runtime_identity")
    session = evidence_document.get("nest_session_readback")
    if (
        evidence_document.get("worker_terminal_disposition") != "confirmed-lifecycle"
        or not isinstance(binding, dict)
        or not isinstance(lifecycle, dict)
        or not isinstance(attempts, list)
        or not attempts
        or not isinstance(identity, dict)
        or not isinstance(session, dict)
        or lifecycle.get("termination_attempts") != attempts
    ):
        fail("NEST worker guardian lifecycle is incomplete")
    binding_digest = assert_canonical_digest(
        binding,
        field="receipt_sha256",
        label="NEST worker session binding",
    )
    lifecycle_digest = assert_canonical_digest(
        lifecycle,
        field="receipt_sha256",
        label="NEST worker lifecycle receipt",
    )
    identity_digest = assert_canonical_digest(
        identity,
        field="receipt_sha256",
        label="NEST worker runtime identity",
    )
    if (
        lifecycle.get("session_binding_receipt_sha256") != binding_digest
        or lifecycle.get("runtime_identity_receipt_sha256") != identity_digest
        or binding.get("worker_runtime_identity_sha256") != identity_digest
        or binding.get("child_session_receipt_sha256") != session.get("receipt_sha256")
        or binding.get("child_lineage_verified") is not True
        or binding.get("loaded_bytes_attested") is not False
        or binding.get("response_bound_loaded_bytes") is not False
        or binding.get("ncp_transport") is not False
        or binding.get("scientific_authority") is not False
        or lifecycle.get("termination_attempt_roster_sha256")
        != sha256(canonical(attempts))
        or lifecycle.get("child_reaped") is not True
        or lifecycle.get("containment_empty") is not True
        or lifecycle.get("diagnostic_stream_complete") is not True
        or lifecycle.get("hard_deadline_enforcement") is not True
        or lifecycle.get("ncp_transport") is not False
        or lifecycle.get("physical_authority") is not False
        or lifecycle.get("scientific_authority") is not False
    ):
        fail("NEST worker guardian terminal closure differs")
    for expected_index, attempt in enumerate(attempts, start=1):
        if not isinstance(attempt, dict):
            fail("NEST worker termination attempt is not an object")
        assert_canonical_digest(
            attempt,
            field="receipt_sha256",
            label="NEST worker termination attempt",
        )
        if (
            attempt.get("attempt_index") != expected_index
            or attempt.get("worker_pid") != lifecycle.get("worker_pid")
            or attempt.get("worker_source_sha256")
            != lifecycle.get("worker_source_sha256")
            or attempt.get("worker_command_sha256")
            != lifecycle.get("worker_command_sha256")
            or attempt.get("adapter_source_sha256")
            != lifecycle.get("adapter_source_sha256")
            or attempt.get("child_reaped") is not True
            or attempt.get("containment_empty") is not True
            or attempt.get("diagnostic_stream_complete") is not True
            or attempt.get("hard_deadline_enforcement") is not True
            or attempt.get("ncp_transport") is not False
            or attempt.get("physical_authority") is not False
            or attempt.get("scientific_authority") is not False
        ):
            fail("NEST worker termination attempt lineage differs")
    return {
        "worker_session_binding_receipt_sha256": binding_digest,
        "worker_runtime_identity_receipt_sha256": identity_digest,
        "worker_lifecycle_receipt_sha256": lifecycle_digest,
        "termination_attempt_count": len(attempts),
        "termination_attempt_roster_sha256": sha256(canonical(attempts)),
        "worker_pid": lifecycle.get("worker_pid"),
        "worker_source_sha256": lifecycle.get("worker_source_sha256"),
        "worker_command_sha256": lifecycle.get("worker_command_sha256"),
        "child_reaped": True,
        "containment_empty": True,
        "diagnostic_stream_complete": True,
    }


def receipt_store_identity(store: Any) -> str:
    value = getattr(store, "store_id", None)
    if callable(value):
        value = value()
    if not isinstance(value, str) or not value.startswith("clrs_"):
        fail("closed-loop receipt store does not expose its exact store identity")
    return value


def collect_receipt_store_closure(
    root: Path,
    *,
    store_id: str,
    receipt_document: Mapping[str, Any],
    evidence_document: Mapping[str, Any],
) -> dict[str, Any]:
    observed_root = root.lstat()
    if (
        not stat.S_ISDIR(observed_root.st_mode)
        or observed_root.st_uid != os.geteuid()
        or observed_root.st_mode & 0o022
        or root.resolve(strict=True) != root
    ):
        fail("receipt store root is not one owner-controlled private directory")
    pending = [root]
    rows: list[dict[str, Any]] = []
    receipt_paths: list[str] = []
    evidence_paths: list[str] = []
    total_bytes = 0
    while pending:
        directory = pending.pop()
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError as error:
            fail(f"receipt store directory cannot be enumerated: {error}")
        for entry in entries:
            path = Path(entry.path)
            observed = entry.stat(follow_symlinks=False)
            if observed.st_uid != os.geteuid():
                fail("receipt store entry is not owner-controlled")
            if stat.S_ISDIR(observed.st_mode):
                if observed.st_mode & 0o022:
                    fail("receipt store directory is not private")
                pending.append(path)
                continue
            if (
                not stat.S_ISREG(observed.st_mode)
                or observed.st_nlink != 1
                or observed.st_size > MAX_INPUT_BYTES
            ):
                fail("receipt store contains a link or unbounded non-regular entry")
            relative = path.relative_to(root).as_posix()
            if any(
                ord(character) < 0x20 or ord(character) == 0x7F
                for character in relative
            ) or any(part in {"", ".", ".."} for part in PurePosixPath(relative).parts):
                fail("receipt store contains an unsafe relative path")
            payload = read_regular(path, MAX_INPUT_BYTES, allow_empty=True)
            total_bytes += len(payload)
            rows.append(
                {
                    "relative_path": relative,
                    "size_bytes": len(payload),
                    "sha256": sha256(payload),
                }
            )
            if path.suffix == ".json":
                document = decode_json_object(payload, f"receipt store {relative}")
                if document == receipt_document:
                    receipt_paths.append(relative)
                if document == evidence_document:
                    evidence_paths.append(relative)
            if (
                len(rows) > MAX_RECEIPT_STORE_FILES
                or total_bytes > MAX_RECEIPT_STORE_BYTES
            ):
                fail("receipt store closure exceeds its file or byte bound")
    rows.sort(key=lambda row: row["relative_path"])
    if len(receipt_paths) != 1 or len(evidence_paths) != 1:
        fail("receipt store does not contain one exact receipt and evidence artifact")
    closure: dict[str, Any] = {
        "schema_version": "crebain.closed-loop-receipt-store-closure.v1",
        "store_id": store_id,
        "receipt_sha256": receipt_document.get("receipt_sha256"),
        "receipt_artifact_path": receipt_paths[0],
        "evidence_bundle_sha256": evidence_document.get("bundle_sha256"),
        "evidence_artifact_path": evidence_paths[0],
        "file_count": len(rows),
        "total_bytes": total_bytes,
        "files": rows,
    }
    closure["closure_sha256"] = sha256(canonical(closure))
    return closure


def build_closed_loop_namespace(
    arguments: argparse.Namespace,
    *,
    plan_path: Path,
    config_path: Path,
    store_path: Path,
    receipt_store_path: Path,
) -> Namespace:
    return Namespace(
        plan=plan_path,
        nest_config=config_path,
        store=store_path,
        receipt_store=receipt_store_path,
        receipt_lock_timeout_ms=validate_receipt_lock_timeout(
            arguments.receipt_lock_timeout_ms
        ),
        identifier=arguments.identifier,
        generation_ordinal=arguments.generation_ordinal,
        startup_timeout_ms=arguments.startup_timeout_ms,
        termination_grace_ms=arguments.termination_grace_ms,
        progress=False,
    )


def reviewed_runtime_lineage(
    session: Any,
    terminal_receipt: Mapping[str, Any],
    reviewed_guardian_source: Mapping[str, Any],
    installed_proof: Mapping[str, Any],
) -> dict[str, Any]:
    handshake = model_document(session.handshake_receipt)
    termination_model = session.termination_receipt
    if termination_model is None:
        fail("reviewed runtime session lacks its termination receipt")
    termination = model_document(termination_model)
    lifecycle = terminal_receipt.get("runtime_lifecycle")
    if not isinstance(lifecycle, dict):
        fail("terminal receipt lacks reviewed runtime lifecycle evidence")
    handshake_digest = assert_canonical_digest(
        handshake,
        field="receipt_sha256",
        label="reviewed runtime handshake receipt",
    )
    termination_digest = assert_canonical_digest(
        termination,
        field="receipt_sha256",
        label="reviewed runtime termination receipt",
    )
    lifecycle_digest = assert_canonical_digest(
        lifecycle,
        field="binding_sha256",
        label="reviewed runtime lifecycle binding",
    )
    if (
        handshake.get("guardian_source_sha256")
        != reviewed_guardian_source.get("sha256")
        or termination.get("handshake_receipt_sha256") != handshake_digest
        or lifecycle.get("handshake_receipt_sha256") != handshake_digest
        or lifecycle.get("termination_receipt_sha256") != termination_digest
        or handshake.get("launch_source") != "package-store-lease"
        or lifecycle.get("launch_source") != "package-store-lease"
        or handshake.get("store_id") != installed_proof.get("store_id")
        or lifecycle.get("store_id") != installed_proof.get("store_id")
        or handshake.get("package_generation_id")
        != installed_proof.get("package_generation_id")
        or lifecycle.get("package_generation_id")
        != installed_proof.get("package_generation_id")
        or lifecycle.get("package_generation_lease_retained_at_launch") is not True
        or lifecycle.get("package_generation_lease_released") is not True
        or lifecycle.get("child_reaped") is not True
        or lifecycle.get("containment_empty") is not True
        or lifecycle.get("diagnostic_stream_complete") is not True
        or lifecycle.get("private_work_directory_removed") is not True
        or lifecycle.get("termination_disposition") != "clean-exit"
        or lifecycle.get("durable_process_launch_authority") is not False
        or lifecycle.get("ncp_authority") is not False
        or lifecycle.get("physical_authority") is not False
        or lifecycle.get("scientific_authority") is not False
        or termination.get("child_reaped") is not True
        or termination.get("containment_empty") is not True
        or termination.get("diagnostic_stream_complete") is not True
        or termination.get("private_work_directory_removed") is not True
        or termination.get("package_generation_lease_released") is not True
    ):
        fail("reviewed runtime guardian or lifecycle source lineage differs")
    return {
        "handshake_receipt": handshake,
        "termination_receipt": termination,
        "lifecycle_binding_sha256": lifecycle_digest,
        "guardian_closure_verified": True,
        "package_store_lineage_verified": True,
    }


def assert_recovery(captured: list[tuple[Any, Any]], evidence: Any) -> None:
    if len(captured) != 6 or len(evidence.step_execution_receipts) != 6:
        fail("proof requires exactly six controller steps")
    for expected_step, (request, result) in enumerate(captured, start=1):
        if request.step_index != expected_step or result.step_index != expected_step:
            fail("captured controller step order drifted")
        if result.request_sha256 != request.request_sha256:
            fail("captured neural request/result lineage drifted")
        if result.provider_execution_scope != "nest-exact-step-readback":
            fail("captured neural result is not real-NEST evidence")
        execution = evidence.step_execution_receipts[expected_step - 1]
        if result.provider_execution_sha256 != execution.receipt_sha256:
            fail("captured neural result does not bind its NEST execution receipt")

    channel_ids = tuple(item.channel_id for item in captured[0][0].channels)
    if not 1 <= len(channel_ids) <= 3:
        fail("captured controller channel count is outside one through three")
    faulted_channel = channel_ids[0]
    held = captured[3][0]
    recovery = captured[4][0]
    resumed = captured[5][1]
    held_by_id = {item.channel_id: item for item in held.channels}
    recovery_by_id = {item.channel_id: item for item in recovery.channels}
    proposal_by_id = {item.channel_id: item for item in resumed.proposals}
    if not held_by_id[faulted_channel].hold_required:
        fail("scheduled fault did not cause the next host safe hold")
    if recovery_by_id[faulted_channel].hold_required:
        fail("recovery step unexpectedly retained the host hold")
    if not any(value != 0.0 for value in proposal_by_id[faulted_channel].values):
        fail("faulted channel did not resume a nonzero NEST proposal")
    for channel_id in channel_ids[1:]:
        if held_by_id[channel_id].hold_required:
            fail("scheduled fault contaminated another channel's safety input")

    held_readback = next(
        item
        for item in evidence.step_execution_receipts[3].channel_safety_readbacks
        if item.channel_id == faulted_channel
    )
    recovery_readback = next(
        item
        for item in evidence.step_execution_receipts[4].channel_safety_readbacks
        if item.channel_id == faulted_channel
    )
    if not (
        held_readback.hold_required
        and held_readback.safety_washout_performed
        and held_readback.population_state_reset_verified
    ):
        fail("NEST hold washout/reset evidence is incomplete")
    if not (
        recovery_readback.recovery_from_hold
        and recovery_readback.safety_washout_performed
        and recovery_readback.population_state_reset_verified
    ):
        fail("NEST recovery washout/reset evidence is incomplete")
    for execution in evidence.step_execution_receipts:
        for item in execution.channel_safety_readbacks[1:]:
            if item.hold_required or item.recovery_from_hold:
                fail("scheduled fault contaminated another NEST safety lane")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engram-root", type=Path, required=True)
    parser.add_argument("--engram-commit", required=True)
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--receipt-store", type=Path, required=True)
    parser.add_argument(
        "--receipt-lock-timeout-ms",
        type=int,
        default=DEFAULT_RECEIPT_LOCK_TIMEOUT_MS,
    )
    parser.add_argument("--identifier", required=True)
    parser.add_argument("--installed-proof", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--nest-config", type=Path, required=True)
    parser.add_argument("--capture", type=Path, required=True)
    parser.add_argument("--generation-ordinal", type=int, default=1)
    parser.add_argument("--startup-timeout-ms", type=int, default=30_000)
    parser.add_argument("--termination-grace-ms", type=int, default=1_000)
    return parser


def main() -> None:
    arguments = build_parser().parse_args()

    engram_root = arguments.engram_root.resolve(strict=True)
    if not engram_root.is_dir():
        fail("Engram root is not a directory")
    plan_path = absolute_without_resolving_leaf(arguments.plan)
    config_path = absolute_without_resolving_leaf(arguments.nest_config)
    store_path = arguments.store.resolve(strict=True)
    receipt_store_path = fresh_receipt_store_path(arguments.receipt_store)
    capture_path = absolute_without_resolving_leaf(arguments.capture)
    installed_proof_path = absolute_without_resolving_leaf(arguments.installed_proof)
    if capture_path.exists() or capture_path.is_symlink():
        fail("capture output already exists")
    capture_parent = capture_path.parent.resolve(strict=True)
    if capture_parent != capture_path.parent:
        fail("capture output parent must not use a symlink")
    observed_capture_parent = capture_parent.lstat()
    if (
        not stat.S_ISDIR(observed_capture_parent.st_mode)
        or observed_capture_parent.st_uid != os.geteuid()
        or observed_capture_parent.st_mode & 0o022
    ):
        fail("capture output parent is not one owner-controlled directory")

    git_before = verify_immutable_engram_checkout(
        engram_root,
        arguments.engram_commit,
    )
    plan_bytes = read_regular(plan_path, MAX_INPUT_BYTES)
    config_bytes = read_regular(config_path, MAX_INPUT_BYTES)
    plan_document = decode_json_object(plan_bytes, "run plan")
    config_document = decode_json_object(config_bytes, "NEST configuration")
    installed_proof, installed_proof_bytes = load_installed_proof(installed_proof_path)
    if installed_proof.get("package_generation_id") != arguments.identifier:
        fail("installed proof package generation differs from the requested identifier")
    verify_pack_source_lineage(installed_proof, git_before)
    validate_receipt_lock_timeout(arguments.receipt_lock_timeout_ms)

    sys.path.insert(0, str(engram_root))
    cli = importlib.import_module("scripts.engram_extension")
    host_sources_before = collect_loaded_engram_sources(engram_root, sys.modules)
    entrypoint_sources_before = collect_entrypoint_sources(engram_root)
    captured: list[tuple[Any, Any]] = []
    captured_sessions: list[Any] = []
    captured_controllers: list[Any] = []
    base_controller = cli.KillableNestPopulationController
    base_reviewed_session = cli.ReviewedNativeDevelopmentSession

    class CapturingController(base_controller):  # type: ignore[valid-type,misc]
        def __init__(self, *positional: Any, **keywords: Any) -> None:
            super().__init__(*positional, **keywords)
            captured_controllers.append(self)

        def step(self, request: Any, *, deadline_ns: int) -> Any:
            result = super().step(request, deadline_ns=deadline_ns)
            captured.append((request, result))
            return result

    class CapturingReviewedSession:
        @classmethod
        def launch_closed_loop_from_store(
            cls, *positional: Any, **keywords: Any
        ) -> Any:
            session = base_reviewed_session.launch_closed_loop_from_store(
                *positional,
                **keywords,
            )
            captured_sessions.append(session)
            return session

    with tempfile.TemporaryDirectory(prefix="crebain-real-nest-inputs-") as raw:
        private_root = Path(raw)
        os.chmod(private_root, 0o700)
        private_plan = private_root / "run-plan.json"
        private_config = private_root / "nest-config.json"
        write_new_regular(
            private_plan,
            plan_bytes,
            label="private run plan",
            fail=fail,
        )
        write_new_regular(
            private_config,
            config_bytes,
            label="private NEST configuration",
            fail=fail,
        )
        run_arguments = build_closed_loop_namespace(
            arguments,
            plan_path=private_plan,
            config_path=private_config,
            store_path=store_path,
            receipt_store_path=receipt_store_path,
        )
        setattr(cli, "KillableNestPopulationController", CapturingController)
        setattr(cli, "ReviewedNativeDevelopmentSession", CapturingReviewedSession)
        try:
            summary, return_code = cli._run_closed_loop(run_arguments)
        finally:
            setattr(cli, "KillableNestPopulationController", base_controller)
            setattr(cli, "ReviewedNativeDevelopmentSession", base_reviewed_session)
        if (
            read_regular(private_plan, MAX_INPUT_BYTES) != plan_bytes
            or read_regular(private_config, MAX_INPUT_BYTES) != config_bytes
        ):
            fail("private run inputs changed during Engram execution")

    if return_code != 0 or summary.get("run_status") != "completed":
        fail("Engram closed-loop command did not complete")
    if len(captured_sessions) != 1:
        fail("proof requires exactly one reviewed runtime session")
    if len(captured_controllers) != 1:
        fail("proof requires exactly one NEST controller session")
    receipt_store = cli.ClosedLoopReceiptStore(
        receipt_store_path,
        lock_timeout_ms=arguments.receipt_lock_timeout_ms,
    )
    receipt = receipt_store.open(summary["receipt_sha256"])
    evidence = receipt_store.open_evidence(summary["receipt_sha256"])
    if evidence is None:
        fail("real-NEST run did not persist an evidence bundle")
    if evidence.run_receipt_sha256 != receipt.receipt_sha256:
        fail("NEST evidence does not bind the terminal receipt")
    expected_results = [item.neural_result_sha256 for item in receipt.neural_executions]
    actual_results = [result.result_sha256 for _, result in captured]
    if actual_results != expected_results:
        fail("captured neural result roster differs from the terminal receipt")
    assert_recovery(captured, evidence)

    receipt_document = model_document(receipt)
    evidence_document = model_document(evidence)
    neural_step_documents = [
        {
            "request": model_document(request),
            "result": model_document(result),
        }
        for request, result in captured
    ]
    topology = assert_population_topology(
        plan_document,
        config_document,
        evidence_document,
        neural_step_documents,
    )
    worker_guardian_closure = assert_worker_guardian_closure(evidence_document)
    store_id = receipt_store_identity(receipt_store)
    receipt_store_closure = collect_receipt_store_closure(
        receipt_store_path,
        store_id=store_id,
        receipt_document=receipt_document,
        evidence_document=evidence_document,
    )
    reviewed_guardian_source = next(
        record
        for record in entrypoint_sources_before
        if record["role"] == "reviewed-runtime-guardian"
    )
    reviewed_lineage = reviewed_runtime_lineage(
        captured_sessions[0],
        receipt_document,
        reviewed_guardian_source,
        installed_proof,
    )
    host_sources_after = collect_loaded_engram_sources(engram_root, sys.modules)
    entrypoint_sources_after = collect_entrypoint_sources(engram_root)
    worker_sources = collect_worker_sources(engram_root, evidence_document)
    before_inventory = merge_source_inventory(
        host_sources_before,
        entrypoint_sources_before,
    )
    after_inventory = merge_source_inventory(
        host_sources_after,
        entrypoint_sources_after,
        worker_sources,
    )
    after_by_path = {record["relative_path"]: record for record in after_inventory}
    if any(
        after_by_path.get(record["relative_path"]) != record
        for record in before_inventory
    ):
        fail("Engram source closure changed after its initial import")
    verify_source_inventory(engram_root, after_inventory)
    if (
        read_regular(plan_path, MAX_INPUT_BYTES) != plan_bytes
        or read_regular(config_path, MAX_INPUT_BYTES) != config_bytes
        or read_regular(installed_proof_path, MAX_INPUT_BYTES) != installed_proof_bytes
    ):
        fail("external run inputs or installed proof changed during capture")

    git_after = verify_immutable_engram_checkout(
        engram_root,
        arguments.engram_commit,
    )
    if git_after != git_before:
        fail("Engram Git identity changed during capture")
    git_sources = bind_git_source_objects(
        engram_root,
        arguments.engram_commit,
        after_inventory,
    )
    verify_pack_source_lineage(installed_proof, git_after, git_sources)
    host_module_roster = [
        {
            "module_name": record["module_name"],
            "relative_path": record["relative_path"],
        }
        for record in host_sources_after
    ]
    worker_module_roster = [
        {
            "module_name": record["module_name"],
            "relative_path": record["relative_path"],
        }
        for record in worker_sources
        if "module_name" in record
    ]
    source_closure: dict[str, Any] = {
        "schema_version": "crebain.engram-python-source-closure.v1",
        "discovery_policy": (
            "loaded-host-modules-plus-worker-runtime-identity-and-entrypoints.v1"
        ),
        "git": git_after,
        "host_modules": host_module_roster,
        "worker_project_modules": worker_module_roster,
        "worker_project_source_roster_sha256": evidence_document[
            "worker_runtime_identity"
        ]["project_source_roster_sha256"],
        "reviewed_runtime_handshake_receipt_sha256": reviewed_lineage[
            "handshake_receipt"
        ]["receipt_sha256"],
        "reviewed_runtime_guardian_source_sha256": reviewed_guardian_source["sha256"],
        "exercised_entrypoints": sorted(
            (
                {"role": role, "relative_path": relative}
                for role, relative in EXERCISED_ENTRYPOINTS
            ),
            key=lambda row: (row["role"], row["relative_path"]),
        ),
        "sources": git_sources,
    }
    source_closure["closure_sha256"] = sha256(canonical(source_closure))
    source_sha256 = {
        record["relative_path"]: record["sha256"] for record in git_sources
    }

    verify_source_inventory(engram_root, after_inventory)
    if (
        collect_receipt_store_closure(
            receipt_store_path,
            store_id=store_id,
            receipt_document=receipt_document,
            evidence_document=evidence_document,
        )
        != receipt_store_closure
    ):
        fail("receipt store closure changed before capture publication")
    if read_regular(installed_proof_path, MAX_INPUT_BYTES) != installed_proof_bytes:
        fail("installed proof changed before capture publication")
    if (
        verify_immutable_engram_checkout(engram_root, arguments.engram_commit)
        != git_before
    ):
        fail("Engram checkout changed before capture publication")

    payload = {
        "schema_version": "crebain.real-nest-closed-loop-capture.v2",
        "engram_source_sha256": source_sha256,
        "engram_source_closure": source_closure,
        "package_generation_id": arguments.identifier,
        "installed_package_proof_exact_sha256": sha256(installed_proof_bytes),
        "installed_package_proof": installed_proof,
        "plan_exact_sha256": sha256(plan_bytes),
        "nest_config_exact_sha256": sha256(config_bytes),
        "receipt_lock_timeout_ms": arguments.receipt_lock_timeout_ms,
        "run_plan": plan_document,
        "nest_config": config_document,
        "summary": summary,
        "terminal_receipt": receipt_document,
        "reviewed_native_runtime": reviewed_lineage,
        "nest_worker_guardian_closure": worker_guardian_closure,
        "receipt_store_closure": receipt_store_closure,
        "population_topology": topology,
        "nest_evidence_bundle": evidence_document,
        "neural_steps": neural_step_documents,
        "assertions": {
            "fault_then_next_step_hold": True,
            "nest_hold_washout_and_reset_verified": True,
            "nest_recovery_washout_and_reset_verified": True,
            "resumed_nest_proposal_nonzero": True,
            "other_channels_never_entered_safety_mode": True,
            "terminal_receipt_and_neural_result_lineage_verified": True,
            "engram_host_and_worker_source_closure_verified": True,
            "reviewed_runtime_guardian_lineage_verified": True,
            "engram_commit_equals_local_origin_main": True,
            "private_frozen_run_inputs_used": True,
            "one_nest_session_exact_6n_population_topology_verified": True,
            "nest_worker_guardian_terminal_closure_verified": True,
            "receipt_store_artifact_closure_verified": True,
            "installed_generation_seal_package_bundle_store_lineage_verified": True,
        },
        "authority": SIMULATOR_ONLY_AUTHORITY,
        "disclosure": (
            "This local capture binds installed simulator and real NEST results. "
            "It is not a signature, physical authority, or scientific validation."
        ),
    }
    output = canonical(payload) + b"\n"
    write_new_regular(
        capture_path,
        output,
        label="real-NEST capture",
        fail=fail,
    )
    print(
        canonical(
            {
                "status": "verified",
                "capture": str(capture_path),
                "capture_sha256": sha256(output),
                "receipt_sha256": receipt.receipt_sha256,
                "evidence_bundle_sha256": summary["evidence_bundle_sha256"],
                "engram_commit": arguments.engram_commit,
                "engram_source_closure_sha256": source_closure["closure_sha256"],
                "channel_count": len(captured[0][0].channels),
            }
        ).decode("utf-8")
    )


if __name__ == "__main__":
    main()
