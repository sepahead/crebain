#!/usr/bin/env python3
"""Create one source-bound CREBAIN package envelope through Engram."""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
import tempfile
from pathlib import Path

from managed_simulation_authoring_files import (
    MAX_EXECUTABLE_BYTES,
    MAX_RECIPE_BYTES,
    ManagedSimulationSubprocessError,
    absolute_without_resolving_leaf,
    copy_regular,
    decode_json_object,
    load_json_object,
    read_regular,
    reject,
    run_bounded_process,
    safe_relative,
    write_new_regular,
)
from managed_simulation_build_provenance import (
    NO_AUTHORITY,
    TARGET,
    canonical,
    sha256,
    validate_build_receipt,
    validate_pack_receipt,
    validate_stage_inventory,
    validate_stage_receipt,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INTEGRATION = ROOT / "integrations" / "engram" / "managed-simulation"
MAX_TREE_FILES = 128
MAX_TREE_BYTES = 128 * 1024 * 1024
MAX_ENGRAM_PROCESS_OUTPUT_BYTES = 1024 * 1024
MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_ENGRAM_TOOL_BYTES = 1024 * 1024
ENGRAM_TOOL_RELATIVE = "scripts/engram_extension.py"
OBJECT_ID = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")


def run_git(source_root: Path, *arguments: str) -> bytes:
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    environment.update({"GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"})
    try:
        completed = run_bounded_process(
            ["git", *arguments],
            cwd=source_root,
            env=environment,
            input_bytes=None,
            timeout_seconds=30,
            max_input_bytes=0,
            max_stdout_bytes=MAX_GIT_OUTPUT_BYTES,
            max_stderr_bytes=64 * 1024,
            label="Engram Git verification",
        )
    except ManagedSimulationSubprocessError as error:
        diagnostic = error.stderr[:4096].decode("utf-8", errors="replace")
        reject(f"Engram Git verification failed: {error}: {diagnostic.strip()}")
    if completed.returncode != 0:
        diagnostic = completed.stderr[:4096].decode("utf-8", errors="replace")
        reject(f"Engram Git verification failed: {diagnostic.strip()}")
    return completed.stdout


def verify_engram_source(
    source_root: Path, expected_commit: str
) -> tuple[dict[str, object], dict[str, object]]:
    if not OBJECT_ID.fullmatch(expected_commit):
        reject("Engram commit is not one lowercase Git object ID")
    try:
        observed_root = source_root.lstat()
    except OSError as error:
        reject(f"Engram root cannot be inspected: {source_root}: {error}")
    if (
        not stat.S_ISDIR(observed_root.st_mode)
        or source_root.resolve(strict=True) != source_root
    ):
        reject("Engram root must be one canonical directory")
    head = run_git(source_root, "rev-parse", "--verify", "HEAD").decode().strip()
    origin_main = (
        run_git(source_root, "rev-parse", "--verify", "refs/remotes/origin/main")
        .decode()
        .strip()
    )
    if head != expected_commit or origin_main != expected_commit:
        reject("Engram HEAD and local origin/main do not equal the required commit")
    if run_git(source_root, "cat-file", "-t", expected_commit) != b"commit\n":
        reject("required Engram object is not a commit")
    if run_git(source_root, "status", "--porcelain=v1", "--untracked-files=all"):
        reject("Engram checkout is not clean")
    origin = run_git(source_root, "remote", "get-url", "origin").decode().strip()
    object_format = (
        run_git(source_root, "rev-parse", "--show-object-format").decode().strip()
    )
    object_length = 40 if object_format == "sha1" else 64
    if (
        object_format not in {"sha1", "sha256"}
        or len(expected_commit) != object_length
        or not origin
        or "\n" in origin
    ):
        reject("Engram repository identity is malformed")
    tree = (
        run_git(source_root, "rev-parse", f"{expected_commit}^{{tree}}")
        .decode()
        .strip()
    )
    if not OBJECT_ID.fullmatch(tree) or len(tree) != object_length:
        reject("Engram tree identity is malformed")

    tree_output = run_git(
        source_root,
        "ls-tree",
        "-z",
        "--full-tree",
        expected_commit,
        "--",
        ENGRAM_TOOL_RELATIVE,
    )
    rows = [row for row in tree_output.split(b"\0") if row]
    if len(rows) != 1:
        reject("Engram pack tool is absent from the required commit")
    try:
        header, raw_path = rows[0].split(b"\t", 1)
        git_mode, kind, git_blob = header.decode("ascii").split(" ")
        relative_path = raw_path.decode("utf-8")
    except (UnicodeDecodeError, ValueError) as error:
        reject(f"Engram pack tool tree row is malformed: {error}")
    if (
        relative_path != ENGRAM_TOOL_RELATIVE
        or kind != "blob"
        or git_mode not in {"100644", "100755"}
        or not OBJECT_ID.fullmatch(git_blob)
        or len(git_blob) != object_length
    ):
        reject("Engram pack tool is not one committed regular source blob")
    tool_path = source_root / ENGRAM_TOOL_RELATIVE
    if tool_path.parent.resolve(strict=True) != tool_path.parent:
        reject("Engram pack tool parent must not use a symlink")
    payload = read_regular(tool_path, MAX_ENGRAM_TOOL_BYTES)
    observed_blob = (
        run_git(
            source_root,
            "hash-object",
            "--no-filters",
            "--",
            ENGRAM_TOOL_RELATIVE,
        )
        .decode()
        .strip()
    )
    if observed_blob != git_blob:
        reject("Engram pack tool bytes differ from the committed Git blob")
    repository: dict[str, object] = {
        "origin": origin,
        "commit": expected_commit,
        "tree": tree,
        "origin_main": origin_main,
        "object_format": object_format,
        "clean": True,
    }
    tool: dict[str, object] = {
        "relative_path": ENGRAM_TOOL_RELATIVE,
        "size_bytes": len(payload),
        "sha256": sha256(payload),
        "git_mode": git_mode,
        "git_blob": git_blob,
    }
    return repository, tool


def isolated_python_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in (
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONINSPECT",
        "PYTHONSTARTUP",
        "PYTHONBREAKPOINT",
        "PYTHONWARNINGS",
        "PYTHONUSERBASE",
    ):
        environment.pop(name, None)
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


def require_private_directory(source: Path) -> None:
    try:
        observed = source.lstat()
    except OSError as error:
        reject(f"source directory cannot be inspected: {source}: {error}")
    if (
        not stat.S_ISDIR(observed.st_mode)
        or observed.st_uid != os.geteuid()
        or observed.st_mode & 0o022
        or source.resolve(strict=True) != source
    ):
        reject(f"source is not an owner-controlled private directory: {source}")


def copy_private_tree(source: Path, destination: Path) -> None:
    require_private_directory(source)
    destination.mkdir(mode=0o700, parents=True)
    os.chmod(destination, 0o700)
    file_count = 0
    byte_count = 0
    pending = [(source, destination)]
    while pending:
        source_directory, destination_directory = pending.pop()
        try:
            entries = sorted(os.scandir(source_directory), key=lambda row: row.name)
        except OSError as error:
            reject(
                f"source directory cannot be enumerated: {source_directory}: {error}"
            )
        for entry in entries:
            source_path = Path(entry.path)
            destination_path = destination_directory / entry.name
            try:
                observed = entry.stat(follow_symlinks=False)
            except OSError as error:
                reject(f"source entry cannot be inspected: {source_path}: {error}")
            if observed.st_uid != os.geteuid():
                reject(f"source entry is not owner-controlled: {source_path}")
            if stat.S_ISDIR(observed.st_mode):
                if observed.st_mode & 0o022:
                    reject(f"source directory is not private: {source_path}")
                destination_path.mkdir(mode=0o700)
                pending.append((source_path, destination_path))
                continue
            if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
                reject(
                    f"source tree contains a link or non-regular entry: {source_path}"
                )
            file_count += 1
            byte_count += observed.st_size
            if file_count > MAX_TREE_FILES or byte_count > MAX_TREE_BYTES:
                reject(f"source tree exceeds its bounded inventory: {source}")
            mode = 0o700 if observed.st_mode & 0o111 else 0o600
            copy_regular(source_path, destination_path, mode, MAX_EXECUTABLE_BYTES)


def read_receipt(path: Path) -> tuple[dict[str, object], bytes]:
    payload = read_regular(path, MAX_RECIPE_BYTES)
    return decode_json_object(payload, label=str(path)), payload


def observed_package_inventory(package_root: Path) -> list[dict[str, object]]:
    require_private_directory(package_root)
    rows: list[dict[str, object]] = []
    pending = [package_root]
    total_bytes = 0
    while pending:
        directory = pending.pop()
        for entry in sorted(os.scandir(directory), key=lambda row: row.name):
            path = Path(entry.path)
            observed = entry.stat(follow_symlinks=False)
            if observed.st_uid != os.geteuid():
                reject(f"package entry is not owner-controlled: {path}")
            if stat.S_ISDIR(observed.st_mode):
                if observed.st_mode & 0o022:
                    reject(f"package directory is not private: {path}")
                pending.append(path)
                continue
            if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
                reject(f"package contains a link or non-regular entry: {path}")
            relative = path.relative_to(package_root).as_posix()
            maximum = (
                MAX_EXECUTABLE_BYTES
                if relative == "bin/crebain-managed-simulation"
                else MAX_RECIPE_BYTES * 16
            )
            payload = read_regular(path, maximum)
            total_bytes += len(payload)
            rows.append(
                {
                    "relative_path": relative,
                    "byte_length": len(payload),
                    "sha256": sha256(payload),
                    "mode": stat.S_IMODE(observed.st_mode),
                    "role": (
                        "executable"
                        if relative == "bin/crebain-managed-simulation"
                        else "contract"
                    ),
                }
            )
            if len(rows) > MAX_TREE_FILES or total_bytes > MAX_TREE_BYTES:
                reject("package exceeds its bounded inventory")
    rows.sort(key=lambda row: str(row["relative_path"]))
    return validate_stage_inventory(rows)


def verify_stage_to_seal_lineage(
    *,
    integration: Path,
    recipe_path: Path,
    configuration_path: Path,
    package_root: Path,
    sealed_root: Path,
    build_receipt_path: Path,
    stage_receipt_path: Path,
) -> tuple[bytes, bytes, bytes]:
    build_receipt, build_receipt_bytes = read_receipt(build_receipt_path)
    validate_build_receipt(build_receipt)
    stage_receipt, stage_receipt_bytes = read_receipt(stage_receipt_path)
    if (
        build_receipt_bytes != canonical(build_receipt) + b"\n"
        or stage_receipt_bytes != canonical(stage_receipt) + b"\n"
    ):
        reject("build and stage receipts must use exact canonical JSON bytes")
    validate_stage_receipt(
        stage_receipt,
        build_receipt=build_receipt,
        build_receipt_bytes=build_receipt_bytes,
    )
    if (
        stage_receipt.get("recipe_exact_sha256")
        != sha256(read_regular(recipe_path, MAX_RECIPE_BYTES))
        or stage_receipt.get("configuration_exact_sha256")
        != sha256(read_regular(configuration_path, MAX_RECIPE_BYTES))
        or stage_receipt.get("package_inventory")
        != observed_package_inventory(package_root)
    ):
        reject("stage receipt differs from the current authoring inputs or package")
    seal_path = sealed_root / "seal-receipt.json"
    lock_path = sealed_root / "package-lock.json"
    seal, seal_bytes = read_receipt(seal_path)
    package_lock, lock_bytes = read_receipt(lock_path)
    seal_package = seal.get("package")
    seal_package_lock = seal.get("package_lock")
    seal_configuration = seal.get("configuration")
    if (
        not isinstance(seal_package, dict)
        or not isinstance(seal_package_lock, dict)
        or not isinstance(seal_configuration, dict)
    ):
        reject("Engram seal lacks closed package lineage objects")
    seal_target = {
        key: value for key, value in TARGET.items() if key != "rust_target_triple"
    }
    if (
        seal.get("schema_version") != "engram.managed-extension-seal-receipt.v1"
        or seal.get("target") != seal_target
        or seal_package.get("executable_sha256")
        != stage_receipt.get("staged_executable", {}).get("sha256")
        or seal_package_lock.get("exact_sha256") != sha256(lock_bytes)
        or seal_configuration.get("exact_sha256")
        != stage_receipt.get("configuration_exact_sha256")
    ):
        reject("Engram seal does not join the staged executable and configuration")
    lock_inventory = package_lock.get("inventory")
    if not isinstance(lock_inventory, list):
        reject("Engram package lock lacks its inventory")
    normalized_lock_inventory = []
    for row in lock_inventory:
        if not isinstance(row, dict):
            reject("Engram package lock inventory row is invalid")
        normalized_lock_inventory.append(
            {
                "relative_path": row.get("relative_path"),
                "byte_length": row.get("byte_length"),
                "sha256": row.get("sha256"),
                "mode": stat.S_IMODE(row.get("mode", 0))
                if isinstance(row.get("mode"), int)
                and not isinstance(row.get("mode"), bool)
                else None,
                "role": row.get("role"),
            }
        )
    if normalized_lock_inventory != stage_receipt.get("package_inventory"):
        reject("Engram seal package inventory differs from the stage receipt")
    if sha256(canonical(package_lock)) != seal_package_lock.get("canonical_sha256"):
        reject("Engram package lock canonical digest differs from the seal")
    if integration != recipe_path.parent:
        reject("authoring recipe is outside the integration root")
    return build_receipt_bytes, stage_receipt_bytes, seal_bytes


def pack(
    *,
    integration: Path,
    engram_root: Path,
    engram_commit: str,
    output: Path,
    timeout_seconds: int,
    build_receipt_path: Path,
    stage_receipt_path: Path,
) -> int:
    recipe_path = integration / "authoring.macos-aarch64-darwin.json"
    recipe = load_json_object(recipe_path)
    configuration_relative = safe_relative(recipe.get("configuration_path"))
    package_relative = safe_relative(recipe.get("package_root"))
    sealed_relative = safe_relative(recipe.get("output_directory"))
    if configuration_relative.as_posix() != "configuration.json":
        reject("recipe configuration path is not the reviewed CREBAIN path")
    if package_relative.as_posix() != "package":
        reject("recipe package root is not the reviewed CREBAIN path")
    if sealed_relative.parts[:1] != ("sealed",) or len(sealed_relative.parts) != 2:
        reject("recipe output directory is not one reviewed target below sealed/")

    configuration_path = integration.joinpath(*configuration_relative.parts)
    package_root = integration.joinpath(*package_relative.parts)
    sealed_root = integration.joinpath(*sealed_relative.parts)
    executable = engram_root / ENGRAM_TOOL_RELATIVE
    if output.exists() or output.is_symlink():
        reject(f"package output already exists: {output}")
    output_parent = output.parent.resolve(strict=True)
    if output.parent != output_parent:
        reject("package output parent must not use a symlink")
    try:
        output.relative_to(engram_root)
    except ValueError:
        pass
    else:
        reject("package output must remain outside the Engram checkout")
    if timeout_seconds < 1 or timeout_seconds > 300:
        reject("pack timeout must be between 1 and 300 seconds")
    source_identity = verify_engram_source(engram_root, engram_commit)
    source_receipts = verify_stage_to_seal_lineage(
        integration=integration,
        recipe_path=recipe_path,
        configuration_path=configuration_path,
        package_root=package_root,
        sealed_root=sealed_root,
        build_receipt_path=build_receipt_path,
        stage_receipt_path=stage_receipt_path,
    )
    build_receipt_bytes, stage_receipt_bytes, seal_receipt_bytes = source_receipts
    build_receipt = decode_json_object(
        build_receipt_bytes, label=str(build_receipt_path)
    )
    stage_receipt = decode_json_object(
        stage_receipt_bytes, label=str(stage_receipt_path)
    )
    interpreter = Path(sys.executable).resolve(strict=True)
    if not stat.S_ISREG(interpreter.lstat().st_mode):
        reject("current Python interpreter is not one regular file")

    temporary_root = Path(tempfile.gettempdir()).resolve(strict=True)
    with (
        tempfile.TemporaryDirectory(
            prefix="crebain-managed-simulation-pack-", dir=temporary_root
        ) as raw,
        tempfile.TemporaryDirectory(
            prefix=".crebain-managed-simulation-package-", dir=output_parent
        ) as staged_raw,
    ):
        workspace = Path(raw)
        staged_root = Path(staged_raw)
        os.chmod(workspace, 0o700)
        os.chmod(staged_root, 0o700)
        staged_envelope = staged_root / "package"
        staged_envelope.mkdir(mode=0o700)
        staged_bundle = staged_envelope / "bundle"
        private_recipe = workspace / recipe_path.name
        copy_regular(recipe_path, private_recipe, 0o600, MAX_RECIPE_BYTES)
        copy_regular(
            configuration_path,
            workspace.joinpath(*configuration_relative.parts),
            0o600,
            MAX_RECIPE_BYTES,
        )
        copy_private_tree(package_root, workspace.joinpath(*package_relative.parts))
        copy_private_tree(sealed_root, workspace.joinpath(*sealed_relative.parts))
        commands = (
            [
                str(interpreter),
                "-I",
                "-B",
                str(executable),
                "pack",
                str(private_recipe),
                str(staged_bundle),
            ],
            [
                str(interpreter),
                "-I",
                "-B",
                str(executable),
                "check",
                str(staged_bundle),
            ],
        )
        for operation, command in zip(("pack", "check"), commands, strict=True):
            try:
                completed = run_bounded_process(
                    command,
                    cwd=engram_root,
                    env=isolated_python_environment(),
                    input_bytes=None,
                    timeout_seconds=timeout_seconds,
                    max_input_bytes=0,
                    max_stdout_bytes=MAX_ENGRAM_PROCESS_OUTPUT_BYTES,
                    max_stderr_bytes=MAX_ENGRAM_PROCESS_OUTPUT_BYTES,
                    label=f"Engram {operation}",
                )
            except ManagedSimulationSubprocessError as error:
                diagnostic = error.stderr[:4096].decode("utf-8", errors="replace")
                reject(f"Engram {operation} failed: {error}: {diagnostic.strip()}")
            if completed.returncode != 0:
                return completed.returncode
            if verify_engram_source(engram_root, engram_commit) != source_identity:
                reject(f"Engram source identity changed during {operation}")

        bundle_receipt, bundle_receipt_bytes = read_receipt(
            staged_bundle / "bundle-receipt.json"
        )
        generation_id = bundle_receipt.get("generation_id")
        if (
            bundle_receipt_bytes != canonical(bundle_receipt)
            or bundle_receipt.get("schema_version")
            != "engram.extension-package-bundle-receipt.v1"
            or not isinstance(generation_id, str)
            or not generation_id.startswith("pkggen_")
            or not OBJECT_ID.fullmatch(generation_id.removeprefix("pkggen_"))
            or len(generation_id) != 71
        ):
            reject("Engram bundle receipt is not one canonical generation receipt")
        if (
            verify_stage_to_seal_lineage(
                integration=integration,
                recipe_path=recipe_path,
                configuration_path=configuration_path,
                package_root=package_root,
                sealed_root=sealed_root,
                build_receipt_path=build_receipt_path,
                stage_receipt_path=stage_receipt_path,
            )
            != source_receipts
        ):
            reject("build, stage, or seal receipt changed during Engram pack")

        receipt: dict[str, object] = {
            "schema_version": "crebain.managed-simulation-engram-pack-receipt.v1",
            "engram_repository": source_identity[0],
            "engram_tool": source_identity[1],
            "verification_policy": (
                "clean-head-origin-main-committed-tool-before-and-after-each-operation.v1"
            ),
            "operations": [
                {"operation": "pack", "exit_code": 0, "source_reverified": True},
                {"operation": "check", "exit_code": 0, "source_reverified": True},
            ],
            "observed_build_receipt_exact_sha256": sha256(build_receipt_bytes),
            "observed_build_receipt_sha256": build_receipt["receipt_sha256"],
            "package_stage_receipt_exact_sha256": sha256(stage_receipt_bytes),
            "package_stage_receipt_sha256": stage_receipt["receipt_sha256"],
            "seal_receipt_exact_sha256": sha256(seal_receipt_bytes),
            "bundle_receipt_exact_sha256": sha256(bundle_receipt_bytes),
            "package_generation_id": generation_id,
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
                "This receipt records local Git and byte observations. It does not "
                "attest loaded interpreter bytes, imported-module bytes, a complete "
                "Python environment, a publisher, a signature, or any authority."
            ),
        }
        receipt["receipt_sha256"] = sha256(canonical(receipt))
        validate_pack_receipt(receipt)
        receipt_payload = canonical(receipt) + b"\n"
        receipt_path = staged_envelope / "engram-pack-receipt.json"
        write_new_regular(receipt_path, receipt_payload, label="Engram pack receipt")
        if (
            verify_engram_source(engram_root, engram_commit) != source_identity
            or read_regular(staged_bundle / "bundle-receipt.json", MAX_RECIPE_BYTES)
            != bundle_receipt_bytes
            or read_regular(receipt_path, MAX_RECIPE_BYTES) != receipt_payload
        ):
            reject("Engram source, bundle, or pack receipt changed before publication")
        os.replace(staged_envelope, output)
        directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        descriptor = os.open(output_parent, directory_flags)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engram-root", type=Path, required=True)
    parser.add_argument("--engram-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--integration-root", type=Path, default=DEFAULT_INTEGRATION)
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument("--build-receipt", type=Path)
    parser.add_argument("--stage-receipt", type=Path)
    arguments = parser.parse_args()
    integration = absolute_without_resolving_leaf(arguments.integration_root)
    build_receipt = absolute_without_resolving_leaf(
        arguments.build_receipt or integration / "build" / "observed-build-receipt.json"
    )
    stage_receipt = absolute_without_resolving_leaf(
        arguments.stage_receipt or integration / "package-stage-receipt.json"
    )
    return_code = pack(
        integration=integration,
        engram_root=absolute_without_resolving_leaf(arguments.engram_root),
        engram_commit=arguments.engram_commit,
        output=absolute_without_resolving_leaf(arguments.output),
        timeout_seconds=arguments.timeout_seconds,
        build_receipt_path=build_receipt,
        stage_receipt_path=stage_receipt,
    )
    raise SystemExit(return_code)


if __name__ == "__main__":
    main()
