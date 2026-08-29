#!/usr/bin/env python3
"""Run and index the tracked one-, two-, and three-drone NEST proof suite."""

from __future__ import annotations

import argparse
from collections.abc import Callable
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath
from types import ModuleType
from typing import Any, Mapping, NoReturn

from managed_simulation_authoring_files import (
    ManagedSimulationSubprocessError,
    run_bounded_process,
    write_new_regular,
)
from managed_simulation_build_provenance import (
    validate_module_roster,
    validate_path_roster,
)


ROOT = Path(__file__).resolve().parents[1]
INPUT_ROOT = (
    ROOT / "integrations/engram/managed-simulation/operational-inputs/real-nest-3.9-v1"
)
PROOF_RUNNER = ROOT / "scripts/run-managed-simulation-real-nest-proof.py"
TOOL_SOURCE_ROLES = {
    "scripts/managed_simulation_authoring_files.py": "atomic-authoring-io",
    "scripts/managed_simulation_build_provenance.py": "receipt-validator",
    "scripts/run-managed-simulation-real-nest-proof.py": "capture-runner",
    "scripts/run-managed-simulation-real-nest-suite.py": "suite-runner",
}
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
MAX_SUBPROCESS_OUTPUT_BYTES = 1024 * 1024
MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
GIT_OBJECT_PATTERN = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")
PUBLICATION_FILES = (
    "INDEX.json",
    "capture-1-drone.json",
    "capture-2-drones.json",
    "capture-3-drones.json",
)
SIMULATOR_ONLY_AUTHORITY = {
    "simulator_only": True,
    "ncp_qualified": False,
    "physical_actuation": False,
    "plant_control": False,
    "scientific_authority": False,
}
CAPTURE_KEYS = {
    "schema_version",
    "engram_source_sha256",
    "engram_source_closure",
    "package_generation_id",
    "installed_package_proof_exact_sha256",
    "installed_package_proof",
    "plan_exact_sha256",
    "nest_config_exact_sha256",
    "receipt_lock_timeout_ms",
    "run_plan",
    "nest_config",
    "summary",
    "terminal_receipt",
    "reviewed_native_runtime",
    "nest_worker_guardian_closure",
    "receipt_store_closure",
    "receipt_store_sidecars",
    "population_topology",
    "nest_evidence_bundle",
    "neural_steps",
    "assertions",
    "authority",
    "disclosure",
}
CAPTURE_ASSERTIONS = {
    "fault_then_next_step_hold",
    "nest_hold_washout_and_reset_verified",
    "nest_recovery_washout_and_reset_verified",
    "resumed_nest_proposal_nonzero",
    "other_channels_never_entered_safety_mode",
    "terminal_receipt_and_neural_result_lineage_verified",
    "engram_host_and_worker_source_closure_verified",
    "reviewed_runtime_guardian_lineage_verified",
    "engram_commit_equals_local_origin_main",
    "private_frozen_run_inputs_used",
    "one_nest_session_exact_6n_population_topology_verified",
    "nest_worker_guardian_terminal_closure_verified",
    "receipt_store_artifact_closure_verified",
    "installed_generation_seal_package_bundle_store_lineage_verified",
}
SOURCE_CLOSURE_KEYS = {
    "schema_version",
    "discovery_policy",
    "git",
    "source_roster_sha256",
    "host_modules",
    "worker_project_modules",
    "worker_project_source_roster_sha256",
    "reviewed_runtime_handshake_receipt_sha256",
    "reviewed_runtime_guardian_source_sha256",
    "reviewed_runtime_exec_gate_source_sha256",
    "reviewed_runtime_exec_gate_command_sha256",
    "exercised_entrypoints",
    "sources",
    "closure_sha256",
}
RECEIPT_STORE_CLOSURE_KEYS = {
    "schema_version",
    "store_id",
    "receipt_sha256",
    "receipt_artifact_path",
    "evidence_bundle_sha256",
    "evidence_artifact_path",
    "file_count",
    "total_bytes",
    "files",
    "closure_sha256",
}
CAPTURE_ROW_KEYS = {
    "drone_count",
    "path",
    "capture_sha256",
    "plan_exact_sha256",
    "receipt_sha256",
    "evidence_bundle_sha256",
    "receipt_store_id",
    "receipt_store_closure_sha256",
    "engram_source_closure_sha256",
    "engram_source_roster_sha256",
    "observed_build_receipt_exact_sha256",
    "population_count",
    "population_neuron_count",
    "device_node_count",
    "connection_count",
    "session_count",
}
SOURCE_ROW_KEYS = {
    "relative_path",
    "size_bytes",
    "sha256",
    "git_mode",
    "git_blob",
}


def load_proof_runner() -> ModuleType:
    specification = importlib.util.spec_from_file_location(
        "crebain_real_nest_suite_proof",
        PROOF_RUNNER,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("real-NEST proof runner cannot be loaded")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


PROOF = load_proof_runner()


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def is_nonnegative_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


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


def git_output(repository: Path, *arguments: str) -> bytes:
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    environment.update(
        {
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        }
    )
    try:
        completed = run_bounded_process(
            [
                "git",
                "--no-replace-objects",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                *arguments,
            ],
            cwd=repository,
            env=environment,
            input_bytes=None,
            timeout_seconds=30,
            max_input_bytes=0,
            max_stdout_bytes=MAX_GIT_OUTPUT_BYTES,
            max_stderr_bytes=64 * 1024,
            label="CREBAIN Git verification",
        )
    except ManagedSimulationSubprocessError as error:
        diagnostic = error.stderr[:4096].decode("utf-8", errors="replace")
        fail(f"CREBAIN Git verification failed: {error}: {diagnostic.strip()}")
    if completed.returncode != 0:
        diagnostic = completed.stderr[:4096].decode("utf-8", errors="replace")
        fail(f"CREBAIN Git verification failed: {diagnostic.strip()}")
    return completed.stdout


def verify_immutable_crebain_checkout(
    repository: Path,
    expected_commit: str,
    *,
    allowed_untracked_paths: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Capture one clean CREBAIN source revision before evidence publication."""

    if not GIT_OBJECT_PATTERN.fullmatch(expected_commit):
        fail("expected CREBAIN source revision is not one lowercase Git object ID")
    repository = Path(os.path.abspath(repository))
    if repository.resolve(strict=True) != repository:
        fail("CREBAIN source repository must be one canonical directory")
    worktree_root = (
        git_output(repository, "rev-parse", "--show-toplevel").decode().strip()
    )
    if (
        Path(os.path.abspath(worktree_root)).resolve(strict=True) != repository
        or git_output(repository, "rev-parse", "--is-bare-repository") != b"false\n"
        or git_output(repository, "rev-parse", "--is-inside-work-tree") != b"true\n"
    ):
        fail("CREBAIN Git worktree root or repository mode differs")
    index_rows = git_output(repository, "ls-files", "-v", "-z", "--")
    if (
        not index_rows
        or not index_rows.endswith(b"\0")
        or any(not row.startswith(b"H ") for row in index_rows[:-1].split(b"\0"))
    ):
        fail("CREBAIN tracked index contains non-normal file flags")
    head = (
        git_output(repository, "rev-parse", "--verify", "HEAD^{commit}")
        .decode()
        .strip()
    )
    origin_main = (
        git_output(
            repository,
            "rev-parse",
            "--verify",
            "refs/remotes/origin/main^{commit}",
        )
        .decode()
        .strip()
    )
    if head != expected_commit or origin_main != expected_commit:
        fail(
            "CREBAIN HEAD and local origin/main do not equal the package source revision"
        )
    if git_output(repository, "cat-file", "-t", expected_commit) != b"commit\n":
        fail("required CREBAIN source object is not a commit")
    if tuple(sorted(set(allowed_untracked_paths))) != allowed_untracked_paths or any(
        not path
        or path.startswith("/")
        or "\\" in path
        or PurePosixPath(path).as_posix() != path
        or any(part in {"", ".", ".."} for part in PurePosixPath(path).parts)
        for path in allowed_untracked_paths
    ):
        fail("allowed CREBAIN untracked path roster is not canonical")
    status = git_output(
        repository,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
    )
    expected_status = b"".join(
        b"?? " + os.fsencode(path) + b"\0" for path in allowed_untracked_paths
    )
    if status != expected_status:
        fail("CREBAIN source checkout has unexpected tracked or untracked state")
    object_format = (
        git_output(repository, "rev-parse", "--show-object-format").decode().strip()
    )
    object_length = 40 if object_format == "sha1" else 64
    tree = (
        git_output(repository, "rev-parse", "--verify", f"{expected_commit}^{{tree}}")
        .decode()
        .strip()
    )
    origin = git_output(repository, "remote", "get-url", "origin").decode().strip()
    if (
        object_format not in {"sha1", "sha256"}
        or len(expected_commit) != object_length
        or not GIT_OBJECT_PATTERN.fullmatch(tree)
        or len(tree) != object_length
        or not origin
        or "\n" in origin
    ):
        fail("CREBAIN source repository identity is malformed")
    return {
        "repository": origin,
        "commit": expected_commit,
        "tree": tree,
        "origin_main_at_capture": origin_main,
        "object_format": object_format,
        "clean_at_capture": True,
    }


def verify_crebain_source_lineage(
    installed_proof: Mapping[str, Any],
    source_identity: Mapping[str, Any],
) -> None:
    build = installed_proof.get("observed_build_receipt")
    repository = build.get("repository") if isinstance(build, dict) else None
    expected = (
        {
            "repository": repository.get("origin"),
            "commit": repository.get("commit"),
            "tree": repository.get("tree"),
            "origin_main_at_capture": repository.get("origin_main"),
            "object_format": repository.get("object_format"),
            "clean_at_capture": repository.get("clean"),
        }
        if isinstance(repository, dict)
        else None
    )
    if (
        dict(source_identity) != expected
        or installed_proof.get("crebain_commit") != source_identity.get("commit")
        or installed_proof.get("crebain_tree") != source_identity.get("tree")
        or installed_proof.get("crebain_origin_main")
        != source_identity.get("origin_main_at_capture")
    ):
        fail("installed package proof differs from the clean CREBAIN source revision")


def verify_publication_roster(
    root: Path,
    expected_payloads: Mapping[str, bytes],
) -> None:
    if tuple(sorted(expected_payloads)) != PUBLICATION_FILES:
        fail("operational publication payload roster differs")
    with os.scandir(root) as entries:
        observed = sorted(entries, key=lambda entry: entry.name)
    if [entry.name for entry in observed] != list(PUBLICATION_FILES) or any(
        not entry.is_file(follow_symlinks=False) for entry in observed
    ):
        fail("operational publication directory is not the exact four-file roster")
    for name in PUBLICATION_FILES:
        if (
            PROOF.read_regular(root / name, MAX_DOCUMENT_BYTES)
            != expected_payloads[name]
        ):
            fail(f"operational publication file changed: {name}")


def install_publication_atomically(
    staging: Path,
    output: Path,
    expected_payloads: Mapping[str, bytes],
    post_install_check: Callable[[], None],
) -> None:
    """Install one publication and restore staging after a failed final check."""

    os.replace(staging, output)
    try:
        verify_publication_roster(output, expected_payloads)
        post_install_check()
    except BaseException:
        if output.exists() or output.is_symlink():
            os.replace(output, staging)
        raise


def remove_failed_staging(path: Path) -> None:
    """Remove only the suite-owned staging leaf after a failed publication."""

    if path.is_symlink() or (path.exists() and not path.is_dir()):
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def safe_local_name(value: Any, *, label: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        fail(f"{label} is not one local POSIX file name")
    relative = PurePosixPath(value)
    if relative.is_absolute() or len(relative.parts) != 1 or relative.suffix != ".json":
        fail(f"{label} is not one local JSON file")
    if relative.name != value or relative.name in {".", ".."}:
        fail(f"{label} is not canonical")
    return value


def read_object(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    payload = PROOF.read_regular(path, MAX_DOCUMENT_BYTES)
    return PROOF.decode_json_object(payload, label), payload


def verify_suite_inputs(
    input_root: Path = INPUT_ROOT,
) -> tuple[
    dict[str, Any], bytes, dict[int, tuple[Path, dict[str, Any], bytes]], Path, bytes
]:
    suite_path = input_root / "SUITE.json"
    suite, suite_bytes = read_object(suite_path, "operational input suite")
    definition_digest = suite.get("suite_definition_sha256")
    definition = {
        key: value for key, value in suite.items() if key != "suite_definition_sha256"
    }
    authority = suite.get("authority")
    constraints = suite.get("constraints")
    if (
        suite.get("schema_version") != "crebain.real-nest-operational-input-suite.v1"
        or suite.get("profile") != "installed-crebain-standard-v3-real-nest-3.9"
        or suite.get("capture_schema_version")
        != "crebain.real-nest-closed-loop-capture.v2"
        or definition_digest != sha256(canonical(definition))
        or authority != SIMULATOR_ONLY_AUTHORITY
        or not isinstance(constraints, dict)
        or constraints.get("session_count_per_run") != 1
        or constraints.get("action_axes_per_drone") != 3
        or constraints.get("signed_populations_per_action_axis") != 2
        or constraints.get("ncp_transport_used") is not False
        or constraints.get("music_transport_used") is not False
        or constraints.get("simulator_only") is not True
    ):
        fail("operational input suite identity, digest, or authority differs")

    config_row = suite.get("nest_config")
    if not isinstance(config_row, dict):
        fail("operational input suite lacks its NEST configuration")
    config_name = safe_local_name(
        config_row.get("path"), label="NEST configuration path"
    )
    config_path = input_root / config_name
    config_bytes = PROOF.read_regular(config_path, MAX_DOCUMENT_BYTES)
    config = PROOF.decode_json_object(config_bytes, "tracked NEST configuration")
    if (
        sha256(config_bytes) != config_row.get("exact_sha256")
        or config.get("schema_version") != "engram.nest-population-controller-config.v2"
        or config.get("population_size") != constraints.get("population_size")
    ):
        fail("tracked NEST configuration identity or population size differs")

    rows = suite.get("runs")
    if not isinstance(rows, list) or [row.get("drone_count") for row in rows] != [
        1,
        2,
        3,
    ]:
        fail("operational input suite must contain the exact 1/2/3-drone roster")
    plans: dict[int, tuple[Path, dict[str, Any], bytes]] = {}
    for row in rows:
        count = row["drone_count"]
        name = safe_local_name(row.get("plan_path"), label="run plan path")
        path = input_root / name
        plan_bytes = PROOF.read_regular(path, MAX_DOCUMENT_BYTES)
        plan = PROOF.decode_json_object(plan_bytes, f"tracked {count}-drone run plan")
        channel_ids, population_names, axis_roster = PROOF.expected_population_topology(
            plan
        )
        if (
            sha256(plan_bytes) != row.get("plan_exact_sha256")
            or plan.get("step_count") != row.get("expected_step_count")
            or plan.get("step_count") != 6
            or plan.get("simulator_only") is not True
            or plan.get("ncp_transport_used") is not False
            or plan.get("music_transport_used") is not False
            or plan.get("physical_actuation") is not False
            or plan.get("scientific_authority") is not False
            or channel_ids != row.get("expected_channel_ids")
            or len(channel_ids) != count
            or len(axis_roster) != count * 3
            or len(population_names) != row.get("expected_population_count")
            or row.get("expected_population_count") != count * 6
            or row.get("expected_population_neuron_count")
            != count * 6 * config["population_size"]
            or row.get("expected_device_node_count") != count * 12
            or row.get("expected_connection_count")
            != count * 12 * config["population_size"]
        ):
            fail(f"tracked {count}-drone run plan or exact 6N topology differs")
        plans[count] = (path, plan, plan_bytes)
    return suite, suite_bytes, plans, config_path, config_bytes


def assert_closed_authority(document: Mapping[str, Any], label: str) -> None:
    authority = document.get("authority")
    if authority != SIMULATOR_ONLY_AUTHORITY:
        fail(f"{label} grants or implies non-simulator authority")


def validate_capture(
    capture: dict[str, Any],
    *,
    capture_bytes: bytes,
    row: Mapping[str, Any],
    plan_bytes: bytes,
    config_bytes: bytes,
    installed_proof: Mapping[str, Any],
    installed_proof_bytes: bytes,
    engram_commit: str,
) -> dict[str, Any]:
    count = row.get("drone_count")
    if capture_bytes != PROOF.managed_runtime_canonical(capture) + b"\n":
        fail(f"{count}-drone capture is not exact canonical JSON")
    expected_plan = PROOF.decode_json_object(plan_bytes, f"tracked {count}-drone plan")
    expected_config = PROOF.decode_json_object(
        config_bytes, "tracked NEST configuration"
    )
    if (
        set(capture) != CAPTURE_KEYS
        or capture.get("schema_version") != "crebain.real-nest-closed-loop-capture.v2"
        or capture.get("package_generation_id")
        != installed_proof.get("package_generation_id")
        or capture.get("installed_package_proof") != installed_proof
        or capture.get("installed_package_proof_exact_sha256")
        != sha256(installed_proof_bytes)
        or capture.get("plan_exact_sha256") != sha256(plan_bytes)
        or capture.get("nest_config_exact_sha256") != sha256(config_bytes)
        or capture.get("run_plan") != expected_plan
        or capture.get("nest_config") != expected_config
    ):
        fail(f"{count}-drone capture input or installed-package lineage differs")
    source = capture.get("engram_source_closure")
    source_git = source.get("git") if isinstance(source, dict) else None
    sources = source.get("sources") if isinstance(source, dict) else None
    host_modules = source.get("host_modules") if isinstance(source, dict) else None
    worker_modules = (
        source.get("worker_project_modules") if isinstance(source, dict) else None
    )
    entrypoints = (
        source.get("exercised_entrypoints") if isinstance(source, dict) else None
    )
    object_length = (
        40
        if isinstance(source_git, dict) and source_git.get("object_format") == "sha1"
        else 64
    )
    if (
        not isinstance(source, dict)
        or set(source) != SOURCE_CLOSURE_KEYS
        or not isinstance(source_git, dict)
        or set(source_git)
        != {"repository", "commit", "tree", "origin_main", "object_format", "clean"}
        or not isinstance(sources, list)
        or not sources
        or PROOF.assert_canonical_digest(
            source,
            field="closure_sha256",
            label="Engram source closure",
        )
        != source.get("closure_sha256")
        or not isinstance(source_git.get("repository"), str)
        or not source_git.get("repository")
        or "\n" in source_git.get("repository", "")
        or source_git.get("commit") != engram_commit
        or source_git.get("origin_main") != engram_commit
        or not PROOF.GIT_COMMIT_PATTERN.fullmatch(source_git.get("tree", ""))
        or source_git.get("object_format") not in {"sha1", "sha256"}
        or len(source_git.get("commit", "")) != object_length
        or len(source_git.get("tree", "")) != object_length
        or source_git.get("clean") is not True
        or any(
            not isinstance(item, dict)
            or item.get("git_mode") not in {"100644", "100755"}
            or not PROOF.GIT_COMMIT_PATTERN.fullmatch(item.get("git_blob", ""))
            or len(item.get("git_blob", "")) != object_length
            for item in sources
        )
        or any(
            set(item) != SOURCE_ROW_KEYS
            or not isinstance(item.get("relative_path"), str)
            or not is_nonnegative_integer(item.get("size_bytes"))
            or not PROOF.SHA256_PATTERN.fullmatch(item.get("sha256", ""))
            for item in sources
        )
        or [item["relative_path"] for item in sources]
        != sorted({item["relative_path"] for item in sources})
        or capture.get("engram_source_sha256")
        != {item["relative_path"]: item["sha256"] for item in sources}
    ):
        fail(f"{count}-drone capture Engram source closure differs")
    sources = validate_path_roster(
        sources,
        label="Engram capture source roster",
        keys=SOURCE_ROW_KEYS,
        sort_fields=("relative_path",),
    )
    source_roster_sha256 = sha256(
        b"crebain.engram-source-roster.v1\0" + canonical(sources)
    )
    if source.get("source_roster_sha256") != source_roster_sha256:
        fail(f"{count}-drone capture Engram source roster digest differs")
    PROOF.verify_pack_source_lineage(installed_proof, source_git, sources)
    host_modules = validate_module_roster(
        host_modules, label="Engram host module roster"
    )
    worker_modules = validate_module_roster(
        worker_modules, label="Engram worker module roster"
    )
    entrypoints = validate_path_roster(
        entrypoints,
        label="Engram exercised entrypoint roster",
        keys={"role", "relative_path"},
        sort_fields=("role", "relative_path"),
    )
    source_paths = {item["relative_path"] for item in sources}
    nested_source_paths = {
        item["relative_path"] for item in [*host_modules, *worker_modules, *entrypoints]
    }
    reviewed_guardian_rows = [
        item
        for item in sources
        if item["relative_path"]
        == "backend/integrations/reviewed_native_process_guardian.py"
    ]
    reviewed_exec_gate_rows = [
        item
        for item in sources
        if item["relative_path"] == "backend/integrations/contained_exec_gate.py"
    ]
    if (
        source_paths != nested_source_paths
        or {item["module_name"] for item in host_modules} != PROOF.REQUIRED_HOST_MODULES
        or {item["module_name"] for item in worker_modules}
        != PROOF.REQUIRED_WORKER_MODULES
        or any(
            not PROOF._expected_module_path(item["module_name"], item["relative_path"])
            for item in [*host_modules, *worker_modules]
        )
        or entrypoints
        != [
            {"role": role, "relative_path": relative_path}
            for role, relative_path in sorted(PROOF.EXERCISED_ENTRYPOINTS)
        ]
        or len(reviewed_guardian_rows) != 1
        or reviewed_guardian_rows[0]["sha256"]
        != source.get("reviewed_runtime_guardian_source_sha256")
        or len(reviewed_exec_gate_rows) != 1
        or reviewed_exec_gate_rows[0]["sha256"]
        != source.get("reviewed_runtime_exec_gate_source_sha256")
    ):
        fail(f"{count}-drone capture nested source closure differs")
    terminal = capture.get("terminal_receipt")
    evidence = capture.get("nest_evidence_bundle")
    neural_steps = capture.get("neural_steps")
    if (
        not isinstance(terminal, dict)
        or not isinstance(evidence, dict)
        or not isinstance(neural_steps, list)
    ):
        fail(f"{count}-drone capture lacks terminal NEST evidence")
    receipt_sha256 = PROOF.assert_managed_runtime_digest(
        terminal,
        field="receipt_sha256",
        label="terminal closed-loop receipt",
    )
    evidence_sha256 = PROOF.assert_managed_runtime_digest(
        evidence,
        field="bundle_sha256",
        label="NEST evidence bundle",
    )
    if evidence.get("run_receipt_sha256") != receipt_sha256:
        fail(f"{count}-drone terminal receipt and evidence bundle differ")
    nest_evidence_closure = PROOF.assert_nest_evidence_closure(
        terminal,
        evidence,
        expected_step_count=6,
    )
    PROOF.assert_neural_steps_closure(
        capture.get("run_plan", {}),
        terminal,
        evidence,
        neural_steps,
        expected_step_count=6,
    )
    topology = PROOF.assert_population_topology(
        capture.get("run_plan", {}),
        capture.get("nest_config", {}),
        evidence,
        neural_steps,
    )
    if (
        topology != capture.get("population_topology")
        or topology.get("drone_count") != count
        or topology.get("population_count") != row.get("expected_population_count")
        or topology.get("population_neuron_count")
        != row.get("expected_population_neuron_count")
        or topology.get("device_node_count") != row.get("expected_device_node_count")
        or topology.get("connection_count") != row.get("expected_connection_count")
    ):
        fail(f"{count}-drone capture exact 6N topology differs")
    guardian = nest_evidence_closure["worker_guardian_closure"]
    if guardian != capture.get("nest_worker_guardian_closure"):
        fail(f"{count}-drone capture worker guardian closure differs")
    store = capture.get("receipt_store_closure")
    sidecars = capture.get("receipt_store_sidecars")
    store_files = store.get("files") if isinstance(store, dict) else None
    expected_receipt_path = f"receipts/{receipt_sha256[:2]}/{receipt_sha256}.json"
    expected_evidence_path = f"evidence/{evidence_sha256[:2]}/{evidence_sha256}.json"
    reviewed_value = capture.get("reviewed_native_runtime")
    reviewed_handshake = (
        reviewed_value.get("handshake_receipt")
        if isinstance(reviewed_value, dict)
        else None
    )
    expected_store_material = PROOF.assert_receipt_store_sidecars(
        sidecars,
        store_id=store.get("store_id") if isinstance(store, dict) else "",
        receipt_document=terminal,
        evidence_document=evidence,
        run_plan_document=capture["run_plan"],
        nest_config_document=capture["nest_config"],
        package_generation_id=capture["package_generation_id"],
        reviewed_handshake=(
            reviewed_handshake if isinstance(reviewed_handshake, dict) else None
        ),
    )
    expected_store_files = [
        {
            "relative_path": relative_path,
            "size_bytes": len(payload),
            "sha256": sha256(payload),
        }
        for relative_path, payload in sorted(expected_store_material.items())
    ]
    if (
        not isinstance(store, dict)
        or set(store) != RECEIPT_STORE_CLOSURE_KEYS
        or store.get("schema_version") != "crebain.closed-loop-receipt-store-closure.v1"
        or not isinstance(store_files, list)
        or len(store_files) != 8
        or any(
            not isinstance(item, dict)
            or set(item) != {"relative_path", "size_bytes", "sha256"}
            or not isinstance(item.get("relative_path"), str)
            or not is_nonnegative_integer(item.get("size_bytes"))
            or not PROOF.SHA256_PATTERN.fullmatch(item.get("sha256", ""))
            for item in store_files
        )
        or [item["relative_path"] for item in store_files]
        != sorted({item["relative_path"] for item in store_files})
        or store.get("file_count") != len(store_files)
        or store.get("total_bytes") != sum(item["size_bytes"] for item in store_files)
        or store.get("receipt_artifact_path") != expected_receipt_path
        or store.get("evidence_artifact_path") != expected_evidence_path
        or store_files != expected_store_files
        or PROOF.assert_canonical_digest(
            store,
            field="closure_sha256",
            label="closed-loop receipt store closure",
        )
        != store.get("closure_sha256")
        or store.get("receipt_sha256") != receipt_sha256
        or store.get("evidence_bundle_sha256") != evidence_sha256
    ):
        fail(f"{count}-drone capture receipt-store closure differs")
    validate_path_roster(
        store_files,
        label="closed-loop receipt-store file roster",
        keys={"relative_path", "size_bytes", "sha256"},
        sort_fields=("relative_path",),
    )
    reservation_id = sidecars["finalized_reservation"]["reservation"]["reservation_id"]
    PROOF.assert_run_summary(
        capture.get("summary"),
        channel_count=count,
        store_id=store["store_id"],
        reservation_id=reservation_id,
        receipt_document=terminal,
        evidence_document=evidence,
    )
    reviewed = capture.get("reviewed_native_runtime")
    lifecycle = terminal.get("runtime_lifecycle")
    command_binding = (
        reviewed.get("exec_gate_command_binding")
        if isinstance(reviewed, dict)
        else None
    )
    handshake = (
        reviewed.get("handshake_receipt") if isinstance(reviewed, dict) else None
    )
    termination = (
        reviewed.get("termination_receipt") if isinstance(reviewed, dict) else None
    )
    worker_files = evidence.get("worker_runtime_identity", {}).get("files", [])
    worker_python_rows = [
        item
        for item in worker_files
        if isinstance(item, dict) and item.get("role") == "python-executable"
    ]
    if (
        not isinstance(reviewed, dict)
        or set(reviewed)
        != {
            "exec_gate_command_binding",
            "handshake_receipt",
            "termination_receipt",
            "lifecycle_binding_sha256",
            "guardian_closure_verified",
            "package_store_lineage_verified",
        }
        or not isinstance(command_binding, dict)
        or not isinstance(handshake, dict)
        or not isinstance(termination, dict)
        or not isinstance(lifecycle, dict)
        or len(worker_python_rows) != 1
        or reviewed.get("guardian_closure_verified") is not True
        or reviewed.get("package_store_lineage_verified") is not True
        or lifecycle.get("store_id") != installed_proof.get("store_id")
        or lifecycle.get("package_generation_id")
        != installed_proof.get("package_generation_id")
    ):
        fail(f"{count}-drone reviewed runtime package-store closure differs")
    expected_reviewed = PROOF.assert_reviewed_runtime_closure(
        command_binding,
        handshake,
        termination,
        lifecycle,
        source["reviewed_runtime_guardian_source_sha256"],
        source["reviewed_runtime_exec_gate_source_sha256"],
        worker_python_rows[0]["sha256"],
        installed_proof,
    )
    if expected_reviewed != reviewed or source.get(
        "reviewed_runtime_exec_gate_command_sha256"
    ) != command_binding.get("exec_gate_command_sha256"):
        fail(f"{count}-drone reviewed runtime contained-command closure differs")
    assertions = capture.get("assertions")
    if (
        not isinstance(assertions, dict)
        or set(assertions) != CAPTURE_ASSERTIONS
        or any(value is not True for value in assertions.values())
    ):
        fail(f"{count}-drone capture has an incomplete assertion roster")
    assert_closed_authority(capture, f"{count}-drone capture")
    PROOF.assert_no_authority_escalation(capture, f"{count}-drone capture")
    return {
        "drone_count": count,
        "path": f"capture-{count}-drone{'s' if count > 1 else ''}.json",
        "capture_sha256": sha256(capture_bytes),
        "plan_exact_sha256": sha256(plan_bytes),
        "receipt_sha256": receipt_sha256,
        "evidence_bundle_sha256": evidence_sha256,
        "receipt_store_id": store["store_id"],
        "receipt_store_closure_sha256": store["closure_sha256"],
        "engram_source_closure_sha256": source["closure_sha256"],
        "engram_source_roster_sha256": source_roster_sha256,
        "observed_build_receipt_exact_sha256": installed_proof[
            "observed_build_receipt_exact_sha256"
        ],
        "population_count": topology["population_count"],
        "population_neuron_count": topology["population_neuron_count"],
        "device_node_count": topology["device_node_count"],
        "connection_count": topology["connection_count"],
        "session_count": topology["session_count"],
    }


def build_index(
    *,
    suite: Mapping[str, Any],
    suite_bytes: bytes,
    config_bytes: bytes,
    installed_proof: Mapping[str, Any],
    installed_proof_bytes: bytes,
    crebain_source_identity: Mapping[str, Any],
    engram_identity: Mapping[str, Any],
    capture_rows: list[dict[str, Any]],
    tool_source_bytes: Mapping[str, bytes],
) -> dict[str, Any]:
    if [row.get("drone_count") for row in capture_rows] != [1, 2, 3]:
        fail("operational capture index requires the exact 1/2/3-drone roster")
    PROOF.verify_pack_source_lineage(installed_proof, engram_identity)
    verify_crebain_source_lineage(installed_proof, crebain_source_identity)
    if (
        installed_proof.get("build_stage_seal_install_lineage_verified") is not True
        or installed_proof.get("build_stage_seal_pack_install_lineage_verified")
        is not True
    ):
        fail("operational package proof lacks build-through-install lineage")
    if any(set(row) != CAPTURE_ROW_KEYS for row in capture_rows):
        fail(
            "operational capture row member roster differs from the exact 16-key contract"
        )
    expected_capture_paths = [
        "capture-1-drone.json",
        "capture-2-drones.json",
        "capture-3-drones.json",
    ]
    if [row.get("path") for row in capture_rows] != expected_capture_paths:
        fail("operational capture paths are not the exact sorted local roster")
    for row in capture_rows:
        safe_local_name(row.get("path"), label="capture row path")
    if (
        len({row["receipt_sha256"] for row in capture_rows}) != 3
        or len({row["capture_sha256"] for row in capture_rows}) != 3
        or len({row["evidence_bundle_sha256"] for row in capture_rows}) != 3
        or len({row["receipt_store_id"] for row in capture_rows}) != 3
        or len({row["engram_source_closure_sha256"] for row in capture_rows}) != 3
        or len({row["engram_source_roster_sha256"] for row in capture_rows}) != 1
        or len({row["observed_build_receipt_exact_sha256"] for row in capture_rows})
        != 1
        or next(
            iter({row["observed_build_receipt_exact_sha256"] for row in capture_rows})
        )
        != installed_proof.get("observed_build_receipt_exact_sha256")
    ):
        fail(
            "operational captures reuse a run/store identity or differ in source closure"
        )
    if set(tool_source_bytes) != set(TOOL_SOURCE_ROLES) or any(
        not isinstance(payload, bytes) or not payload
        for payload in tool_source_bytes.values()
    ):
        fail("operational tool source closure differs")
    tool_source_rows = [
        {
            "role": TOOL_SOURCE_ROLES[path],
            "path": path,
            "exact_sha256": sha256(tool_source_bytes[path]),
        }
        for path in sorted(TOOL_SOURCE_ROLES)
    ]
    index = {
        "schema_version": "crebain.real-nest-closed-loop-evidence-index.v2",
        "profile": suite["profile"],
        "input_suite": {
            "schema_version": suite["schema_version"],
            "exact_sha256": sha256(suite_bytes),
            "suite_definition_sha256": suite["suite_definition_sha256"],
            "nest_config_exact_sha256": sha256(config_bytes),
        },
        "tool_source_closure": {
            "schema_version": "crebain.real-nest-tool-source-closure.v1",
            "files": tool_source_rows,
            "roster_sha256": sha256(canonical(tool_source_rows)),
        },
        "crebain_source_repository": dict(crebain_source_identity),
        "engram": dict(engram_identity),
        "package": {
            key: installed_proof[key]
            for key in (
                "store_id",
                "package_generation_id",
                "installation_id",
                "generation_core_sha256",
                "bundle_receipt_exact_sha256",
                "seal_receipt_exact_sha256",
                "install_observation_exact_sha256",
                "package_sha256",
                "executable_sha256",
                "configuration_canonical_sha256",
                "operation_roster_sha256",
                "receipt_sha256",
                "observed_build_receipt_exact_sha256",
                "observed_build_receipt_sha256",
                "package_stage_receipt_exact_sha256",
                "package_stage_receipt_sha256",
                "engram_pack_receipt_exact_sha256",
                "engram_pack_receipt_sha256",
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
                "build_stage_seal_pack_install_lineage_verified",
            )
        },
        "installed_package_proof_exact_sha256": sha256(installed_proof_bytes),
        "captures": capture_rows,
        "assertions": {
            "tracked_inputs_exact": True,
            "one_session_per_run": True,
            "exact_6n_population_topology": True,
            "one_two_three_drone_roster": True,
            "distinct_receipt_and_evidence_identities": True,
            "distinct_closed_receipt_stores": True,
            "common_clean_engram_source_roster": True,
            "distinct_engram_runtime_source_closures": True,
            "crebain_source_lineage_common": True,
            "installed_package_lineage_common": True,
            "observed_build_stage_seal_install_lineage_common": True,
            "engram_pack_source_lineage_common": True,
            "observed_build_stage_seal_pack_install_lineage_common": True,
        },
        "authority": {
            "simulator_only": True,
            "ncp_qualified": False,
            "physical_actuation": False,
            "plant_control": False,
            "scientific_authority": False,
        },
        "disclosure": (
            "This index binds installed CREBAIN simulator and real NEST evidence. "
            "It is not physical authority or scientific validation."
        ),
    }
    return index


def run_suite(arguments: argparse.Namespace) -> None:
    input_root = arguments.input_root.resolve(strict=True)
    suite, suite_bytes, plans, config_path, config_bytes = verify_suite_inputs(
        input_root
    )
    installed_path = Path(os.path.abspath(arguments.installed_proof))
    installed_proof, installed_bytes = PROOF.load_installed_proof(installed_path)
    crebain_source_identity = verify_immutable_crebain_checkout(
        ROOT,
        installed_proof["crebain_commit"],
    )
    verify_crebain_source_lineage(installed_proof, crebain_source_identity)
    engram_root = arguments.engram_root.resolve(strict=True)
    engram_identity = PROOF.verify_immutable_engram_checkout(
        engram_root,
        arguments.engram_commit,
    )
    store = arguments.store.resolve(strict=True)
    output = Path(os.path.abspath(arguments.output_directory))
    if output.exists() or output.is_symlink():
        fail("operational suite output already exists")
    parent = output.parent.resolve(strict=True)
    if output.parent != parent:
        fail("operational suite output parent must not use a symlink")
    try:
        output_relative = output.relative_to(ROOT).as_posix()
    except ValueError:
        fail("operational suite output must remain inside the CREBAIN repository")
    tool_source_bytes = {
        relative: PROOF.read_regular(ROOT / relative, MAX_DOCUMENT_BYTES)
        for relative in sorted(TOOL_SOURCE_ROLES)
    }
    staging = Path(tempfile.mkdtemp(prefix=".crebain-real-nest-suite-", dir=parent))
    os.chmod(staging, 0o700)
    try:
        staging_relative = staging.relative_to(ROOT).as_posix()
    except ValueError:
        fail("operational suite staging must remain inside the CREBAIN repository")
    allowed_untracked_paths = tuple(
        sorted(f"{staging_relative}/{name}" for name in PUBLICATION_FILES)
    )
    published_untracked_paths = tuple(
        sorted(f"{output_relative}/{name}" for name in PUBLICATION_FILES)
    )
    published = False
    try:
        capture_rows: list[dict[str, Any]] = []
        capture_payloads: dict[str, bytes] = {}
        for row in suite["runs"]:
            count = row["drone_count"]
            receipt_store = (
                staging / f"receipt-store-{count}-drone{'s' if count > 1 else ''}"
            )
            capture_name = f"capture-{count}-drone{'s' if count > 1 else ''}.json"
            capture_path = staging / capture_name
            command = [
                str(arguments.python),
                str(PROOF_RUNNER),
                "--engram-root",
                str(engram_root),
                "--engram-commit",
                arguments.engram_commit,
                "--store",
                str(store),
                "--receipt-store",
                str(receipt_store),
                "--receipt-lock-timeout-ms",
                str(arguments.receipt_lock_timeout_ms),
                "--identifier",
                installed_proof["package_generation_id"],
                "--installed-proof",
                str(installed_path),
                "--plan",
                str(plans[count][0]),
                "--nest-config",
                str(config_path),
                "--capture",
                str(capture_path),
            ]
            try:
                completed = run_bounded_process(
                    command,
                    cwd=ROOT,
                    input_bytes=None,
                    timeout_seconds=arguments.run_timeout_seconds,
                    max_input_bytes=0,
                    max_stdout_bytes=MAX_SUBPROCESS_OUTPUT_BYTES,
                    max_stderr_bytes=MAX_SUBPROCESS_OUTPUT_BYTES,
                    label=f"{count}-drone real-NEST proof",
                )
            except ManagedSimulationSubprocessError as error:
                diagnostic = error.stderr[:4096].decode("utf-8", errors="replace")
                fail(
                    f"{count}-drone real-NEST proof failed: "
                    f"{error}: {diagnostic.strip()}"
                )
            if completed.returncode != 0:
                diagnostic = completed.stderr[:4096].decode("utf-8", errors="replace")
                fail(f"{count}-drone real-NEST proof failed: {diagnostic.strip()}")
            capture, capture_bytes = read_object(
                capture_path,
                f"{count}-drone real-NEST capture",
            )
            capture_payloads[capture_name] = capture_bytes
            capture_rows.append(
                validate_capture(
                    capture,
                    capture_bytes=capture_bytes,
                    row=row,
                    plan_bytes=plans[count][2],
                    config_bytes=config_bytes,
                    installed_proof=installed_proof,
                    installed_proof_bytes=installed_bytes,
                    engram_commit=arguments.engram_commit,
                )
            )
            if receipt_store.is_symlink() or not receipt_store.is_dir():
                fail(f"{count}-drone receipt store is not one private directory")
            shutil.rmtree(receipt_store)
        index = build_index(
            suite=suite,
            suite_bytes=suite_bytes,
            config_bytes=config_bytes,
            installed_proof=installed_proof,
            installed_proof_bytes=installed_bytes,
            crebain_source_identity=crebain_source_identity,
            engram_identity=engram_identity,
            capture_rows=capture_rows,
            tool_source_bytes=tool_source_bytes,
        )
        index_bytes = PROOF.managed_runtime_canonical(index) + b"\n"
        write_new_regular(
            staging / "INDEX.json",
            index_bytes,
            label="real-NEST evidence index",
            fail=fail,
        )
        publication_payloads = {"INDEX.json": index_bytes, **capture_payloads}
        verify_publication_roster(staging, publication_payloads)
        if (
            any(
                PROOF.read_regular(ROOT / relative, MAX_DOCUMENT_BYTES) != payload
                for relative, payload in tool_source_bytes.items()
            )
            or PROOF.read_regular(installed_path, MAX_DOCUMENT_BYTES) != installed_bytes
            or PROOF.verify_immutable_engram_checkout(
                engram_root, arguments.engram_commit
            )
            != engram_identity
        ):
            fail(
                "suite code, package proof, or source checkout changed before publication"
            )
        verify_publication_roster(staging, publication_payloads)
        final_source_identity = verify_immutable_crebain_checkout(
            ROOT,
            installed_proof["crebain_commit"],
            allowed_untracked_paths=allowed_untracked_paths,
        )
        if final_source_identity != crebain_source_identity:
            fail("CREBAIN source identity changed before publication")
        verify_crebain_source_lineage(installed_proof, final_source_identity)

        def verify_installed_publication() -> None:
            published_source_identity = verify_immutable_crebain_checkout(
                ROOT,
                installed_proof["crebain_commit"],
                allowed_untracked_paths=published_untracked_paths,
            )
            if published_source_identity != crebain_source_identity:
                fail("CREBAIN source identity changed after evidence publication")
            verify_crebain_source_lineage(
                installed_proof,
                published_source_identity,
            )

        install_publication_atomically(
            staging,
            output,
            publication_payloads,
            verify_installed_publication,
        )
        published = True
        print(
            canonical(
                {
                    "status": "verified",
                    "output_directory": str(output),
                    "index_sha256": sha256(index_bytes),
                    "engram_commit": arguments.engram_commit,
                    "package_generation_id": installed_proof["package_generation_id"],
                    "drone_counts": [1, 2, 3],
                }
            ).decode("utf-8")
        )
    finally:
        if not published:
            remove_failed_staging(staging)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-root", type=Path, default=INPUT_ROOT)
    parser.add_argument("--verify-inputs", action="store_true")
    parser.add_argument("--engram-root", type=Path)
    parser.add_argument("--engram-commit")
    parser.add_argument("--store", type=Path)
    parser.add_argument("--installed-proof", type=Path)
    parser.add_argument("--output-directory", type=Path)
    parser.add_argument("--python", type=Path, default=Path(sys.executable))
    parser.add_argument("--receipt-lock-timeout-ms", type=int, default=30_000)
    parser.add_argument("--run-timeout-seconds", type=int, default=300)
    arguments = parser.parse_args()
    if arguments.verify_inputs:
        if any(
            value is not None
            for value in (
                arguments.engram_root,
                arguments.engram_commit,
                arguments.store,
                arguments.installed_proof,
                arguments.output_directory,
            )
        ):
            fail("--verify-inputs does not accept operational execution arguments")
        suite, suite_bytes, plans, _config, _config_bytes = verify_suite_inputs(
            arguments.input_root.resolve(strict=True)
        )
        print(
            canonical(
                {
                    "status": "verified",
                    "suite_exact_sha256": sha256(suite_bytes),
                    "suite_definition_sha256": suite["suite_definition_sha256"],
                    "drone_counts": sorted(plans),
                }
            ).decode("utf-8")
        )
        return
    if any(
        value is None
        for value in (
            arguments.engram_root,
            arguments.engram_commit,
            arguments.store,
            arguments.installed_proof,
            arguments.output_directory,
        )
    ):
        fail("operational suite execution requires Engram, store, proof, and output")
    if not 1 <= arguments.run_timeout_seconds <= 1800:
        fail("run timeout must be between 1 and 1800 seconds")
    PROOF.validate_receipt_lock_timeout(arguments.receipt_lock_timeout_ms)
    run_suite(arguments)


if __name__ == "__main__":
    main()
