#!/usr/bin/env python3
"""Build managed simulation from one clean immutable CREBAIN main commit."""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import stat
import sys
import tomllib
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

from managed_simulation_authoring_files import (
    MAX_EXECUTABLE_BYTES,
    ManagedSimulationSubprocessError,
    absolute_without_resolving_leaf,
    copy_regular,
    read_regular,
    run_bounded_process,
    write_new_regular,
)
from managed_simulation_build_provenance import (
    BUILD_CONTRACT_PATHS,
    BUILD_RECEIPT_SCHEMA,
    EXPECTED_CARGO_ARGV,
    NO_AUTHORITY,
    TARGET,
    canonical,
    executable_identity,
    safe_relative,
    sha256,
    validate_build_receipt,
)


ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "integrations/engram/managed-simulation"
DEFAULT_BINARY = (
    ROOT
    / "src-tauri/target/managed-simulation-bootstrap"
    / "crebain-managed-simulation"
)
DEFAULT_RECEIPT = INTEGRATION / "build/observed-build-receipt.json"
TARGET_DIRECTORY_ARGUMENT = (
    "src-tauri/target/managed-simulation-bootstrap/observed-build-target"
)
MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
MAX_SOURCE_BYTES = 16 * 1024 * 1024
MAX_BUILD_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_DEP_INFO_BYTES = 2 * 1024 * 1024
SOURCE_FIXED = {
    "rust-toolchain.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/src/pid_observation.rs",
    "src-tauri/src/sensor_fusion.rs",
} | BUILD_CONTRACT_PATHS
SOURCE_PREFIX = "src-tauri/crates/managed-simulation/"
GENERATOR_PATHS = {
    "scripts/build-managed-simulation-bootstrap.py",
    "scripts/managed_simulation_authoring_files.py",
    "scripts/managed_simulation_build_provenance.py",
}
CARGO_METADATA_INPUTS = {
    "rust-toolchain.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/Cargo.toml",
    f"{SOURCE_PREFIX}Cargo.toml",
}
FORBIDDEN_BUILD_ENVIRONMENT = {
    "CARGO_BUILD_RUSTC",
    "CARGO_BUILD_RUSTC_WRAPPER",
    "CARGO_BUILD_TARGET",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_ENCODED_RUSTFLAGS",
    "CARGO_INCREMENTAL",
    "CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_CODEGEN_UNITS",
    "CARGO_PROFILE_RELEASE_CODEGEN_UNITS",
    "CARGO_PROFILE_RELEASE_DEBUG",
    "CARGO_PROFILE_RELEASE_INCREMENTAL",
    "CARGO_PROFILE_RELEASE_LTO",
    "CARGO_PROFILE_RELEASE_OPT_LEVEL",
    "CARGO_PROFILE_RELEASE_PANIC",
    "CARGO_PROFILE_RELEASE_RPATH",
    "CARGO_PROFILE_RELEASE_STRIP",
    "CARGO_TARGET_DIR",
    "CFLAGS",
    "CXXFLAGS",
    "DEVELOPER_DIR",
    "LDFLAGS",
    "MACOSX_DEPLOYMENT_TARGET",
    "RUSTC",
    "RUSTC_BOOTSTRAP",
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "RUSTFLAGS",
    "RUSTDOCFLAGS",
    "SDKROOT",
}
FORBIDDEN_BUILD_ENVIRONMENT_PREFIXES = (
    "CARGO_BUILD_",
    "CARGO_PROFILE_",
    "CARGO_TARGET_",
)


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def git_output(root: Path, *arguments: str) -> bytes:
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    environment.update({"GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"})
    try:
        completed = run_bounded_process(
            ["git", *arguments],
            cwd=root,
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


def verify_immutable_checkout(root: Path, expected_commit: str) -> dict[str, Any]:
    head = git_output(root, "rev-parse", "--verify", "HEAD").decode().strip()
    remote_main = (
        git_output(root, "rev-parse", "--verify", "refs/remotes/origin/main")
        .decode()
        .strip()
    )
    if head != expected_commit or remote_main != expected_commit:
        fail("CREBAIN HEAD and local origin/main do not equal the required commit")
    if git_output(root, "cat-file", "-t", expected_commit) != b"commit\n":
        fail("required CREBAIN object is not a commit")
    if git_output(root, "status", "--porcelain=v1", "--untracked-files=all"):
        fail("CREBAIN checkout is not clean")
    tree = git_output(root, "rev-parse", f"{expected_commit}^{{tree}}").decode().strip()
    object_format = (
        git_output(root, "rev-parse", "--show-object-format").decode().strip()
    )
    origin = git_output(root, "remote", "get-url", "origin").decode().strip()
    if object_format not in {"sha1", "sha256"} or not origin or "\n" in origin:
        fail("CREBAIN Git object format or origin URL is invalid")
    return {
        "origin": origin,
        "commit": expected_commit,
        "tree": tree,
        "origin_main": remote_main,
        "object_format": object_format,
        "clean": True,
    }


def committed_rows(root: Path, commit: str) -> dict[str, tuple[str, str]]:
    payload = git_output(root, "ls-tree", "-r", "-z", "--full-tree", commit)
    rows: dict[str, tuple[str, str]] = {}
    for entry in payload.split(b"\0"):
        if not entry:
            continue
        try:
            header, raw_path = entry.split(b"\t", 1)
            mode, kind, object_id = header.decode("ascii").split(" ")
            path = raw_path.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as error:
            fail(f"CREBAIN Git tree row is malformed: {error}")
        if kind == "blob" and (
            path in SOURCE_FIXED
            or path.startswith(SOURCE_PREFIX)
            or path in GENERATOR_PATHS
        ):
            if mode not in {"100644", "100755"} or path in rows:
                fail(f"CREBAIN Git source row is invalid: {path}")
            rows[path] = (mode, object_id)
    required = (
        SOURCE_FIXED
        | GENERATOR_PATHS
        | {
            f"{SOURCE_PREFIX}Cargo.toml",
            f"{SOURCE_PREFIX}src/lib.rs",
            f"{SOURCE_PREFIX}src/main.rs",
        }
    )
    if not required.issubset(rows):
        fail("CREBAIN Git tree lacks required managed-simulation build sources")
    if any(
        path.startswith(SOURCE_PREFIX)
        and path != f"{SOURCE_PREFIX}Cargo.toml"
        and not (path.startswith(f"{SOURCE_PREFIX}src/") and path.endswith(".rs"))
        for path in rows
    ):
        fail("managed-simulation crate contains an unclassified build input")
    return rows


def bind_rows(
    root: Path,
    commit: str,
    catalog: dict[str, tuple[str, str]],
    paths: set[str],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for path in sorted(paths):
        safe_relative(path, label="CREBAIN build source path")
        mode, object_id = catalog[path]
        source = root.joinpath(*PurePosixPath(path).parts)
        payload = read_regular(source, MAX_SOURCE_BYTES)
        observed_id = (
            git_output(root, "hash-object", "--no-filters", "--", path).decode().strip()
        )
        committed_payload = git_output(root, "show", f"{commit}:{path}")
        if observed_id != object_id or committed_payload != payload:
            fail(f"CREBAIN source differs from its committed Git blob: {path}")
        result.append(
            {
                "relative_path": path,
                "size_bytes": len(payload),
                "sha256": sha256(payload),
                "git_mode": mode,
                "git_blob": object_id,
            }
        )
    return result


def exact_tool_versions(root: Path) -> tuple[str, str, str]:
    toolchain_bytes = read_regular(root / "rust-toolchain.toml", 64 * 1024)
    try:
        toolchain = tomllib.loads(toolchain_bytes.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        fail(f"Rust toolchain document is invalid: {error}")
    if toolchain.get("toolchain") != {
        "channel": "1.91.1",
        "components": ["rustfmt", "clippy"],
    }:
        fail("Rust toolchain document differs from the exact release toolchain")
    rustup = shutil.which("rustup")
    if rustup is None:
        fail("rustup is unavailable")
    versions: list[str] = []
    for tool in ("rustc", "cargo"):
        try:
            completed = run_bounded_process(
                [rustup, "run", "1.91.1", tool, "--version"],
                cwd=root,
                input_bytes=None,
                timeout_seconds=30,
                max_input_bytes=0,
                max_stdout_bytes=1024,
                max_stderr_bytes=4096,
                label=f"exact {tool} version probe",
            )
        except ManagedSimulationSubprocessError as error:
            fail(f"exact {tool} version probe failed: {error}")
        if completed.returncode != 0 or completed.stderr:
            fail(f"exact {tool} version probe failed")
        try:
            versions.append(completed.stdout.decode("utf-8").strip())
        except UnicodeDecodeError as error:
            fail(f"exact {tool} version is not UTF-8: {error}")
    expected = (
        "rustc 1.91.1 (ed61e7d7e 2025-11-07)",
        "cargo 1.91.1 (ea2d97820 2025-10-10)",
    )
    if tuple(versions) != expected:
        fail("active rustup toolchain does not match exact Rust 1.91.1")
    return rustup, versions[0], versions[1]


def require_closed_build_environment() -> None:
    present = sorted(
        name
        for name, value in os.environ.items()
        if value
        and (
            name in FORBIDDEN_BUILD_ENVIRONMENT
            or name.startswith(FORBIDDEN_BUILD_ENVIRONMENT_PREFIXES)
        )
    )
    if present:
        fail(f"build override environment is not empty: {','.join(present)}")


def run_build(
    root: Path,
    rustup: str,
    target_directory: Path,
    timeout_seconds: int,
) -> Path:
    expected_target_directory = root.joinpath(
        *PurePosixPath(TARGET_DIRECTORY_ARGUMENT).parts
    )
    if target_directory != expected_target_directory:
        fail("managed-simulation target directory differs from its exact argument")
    command = [
        rustup,
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
        TARGET["rust_target_triple"],
        "--target-dir",
        TARGET_DIRECTORY_ARGUMENT,
    ]
    environment = os.environ.copy()
    for name in FORBIDDEN_BUILD_ENVIRONMENT:
        environment.pop(name, None)
    environment.update({"CARGO_INCREMENTAL": "0", "LC_ALL": "C"})
    try:
        completed = run_bounded_process(
            command,
            cwd=root,
            env=environment,
            input_bytes=None,
            timeout_seconds=timeout_seconds,
            max_input_bytes=0,
            max_stdout_bytes=MAX_BUILD_OUTPUT_BYTES,
            max_stderr_bytes=MAX_BUILD_OUTPUT_BYTES,
            label="managed-simulation release build",
        )
    except ManagedSimulationSubprocessError as error:
        diagnostic = error.stderr[:8192].decode("utf-8", errors="replace")
        fail(f"managed-simulation release build failed: {error}: {diagnostic.strip()}")
    if completed.returncode != 0:
        diagnostic = completed.stderr[:8192].decode("utf-8", errors="replace")
        fail(f"managed-simulation release build failed: {diagnostic.strip()}")
    return (
        target_directory
        / TARGET["rust_target_triple"]
        / "release"
        / "crebain-managed-simulation"
    )


def verify_rustc_dependency_roster(
    root: Path,
    target_directory: Path,
    expected_source_paths: set[str],
) -> None:
    root = root.resolve(strict=True)
    dependency_directory = (
        target_directory / TARGET["rust_target_triple"] / "release" / "deps"
    )
    dep_info_files = sorted(dependency_directory.glob("crebain_managed_simulation-*.d"))
    if not 2 <= len(dep_info_files) <= 8:
        fail("Cargo did not emit the bounded managed-simulation dep-info roster")
    observed_paths: set[str] = set()
    workspace = root / "src-tauri"
    for dep_info in dep_info_files:
        payload = read_regular(dep_info, MAX_DEP_INFO_BYTES)
        try:
            document = payload.decode("utf-8")
        except UnicodeDecodeError as error:
            fail(f"Cargo dep-info is not UTF-8: {error}")
        if "\r" in document or "\0" in document:
            fail("Cargo dep-info contains an invalid control character")
        logical_document = document.replace("\\\n", " ")
        file_dependency_count = 0
        for line in logical_document.splitlines():
            _target, separator, dependencies = line.partition(": ")
            if not separator or not dependencies:
                continue
            try:
                tokens = shlex.split(dependencies, comments=False, posix=True)
            except ValueError as error:
                fail(f"Cargo dep-info dependency list is malformed: {error}")
            for token in tokens:
                candidate = Path(token)
                if not candidate.is_absolute():
                    candidate = workspace / candidate
                try:
                    resolved = candidate.resolve(strict=True)
                    relative = resolved.relative_to(root).as_posix()
                except (OSError, ValueError) as error:
                    fail(f"Cargo dep-info source escapes CREBAIN: {token}: {error}")
                safe_relative(relative, label="Cargo dep-info source path")
                observed_paths.add(relative)
                file_dependency_count += 1
        if file_dependency_count == 0:
            fail(f"Cargo dep-info lacks source dependencies: {dep_info.name}")
    expected_compile_paths = expected_source_paths - CARGO_METADATA_INPUTS
    if observed_paths != expected_compile_paths:
        missing = sorted(expected_compile_paths - observed_paths)
        unexpected = sorted(observed_paths - expected_compile_paths)
        fail(
            "Cargo dep-info differs from the exact Git build-source roster: "
            f"missing={missing}, unexpected={unexpected}"
        )


def prepare_output_parent(path: Path) -> None:
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    observed = parent.lstat()
    if (
        not stat.S_ISDIR(observed.st_mode)
        or observed.st_uid != os.geteuid()
        or observed.st_mode & 0o022
        or parent.resolve(strict=True) != parent
    ):
        fail(f"build output parent is not owner-private: {parent}")


def build_receipt(
    *,
    repository: dict[str, Any],
    source_rows: list[dict[str, Any]],
    generator_rows: list[dict[str, Any]],
    rustc_version: str,
    cargo_version: str,
    output_identity: dict[str, Any],
) -> dict[str, Any]:
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
        "rustc_version": rustc_version,
        "cargo_version": cargo_version,
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
            "byte_length": output_identity["byte_length"],
            "sha256": output_identity["sha256"],
            "source_mode": output_identity["mode"],
            "format": output_identity["format"],
            "architecture": output_identity["architecture"],
            "file_type": output_identity["file_type"],
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
        "disclosure": (
            "This receipt records one local build and its output bytes. "
            "It is not a signature, reproducibility proof, or dependency attestation."
        ),
    }
    receipt["receipt_sha256"] = sha256(canonical(receipt))
    return validate_build_receipt(receipt)


def execute(arguments: argparse.Namespace) -> None:
    root = arguments.root.resolve(strict=True)
    binary_output = absolute_without_resolving_leaf(arguments.binary_output)
    receipt_output = absolute_without_resolving_leaf(arguments.receipt_output)
    if binary_output.exists() or binary_output.is_symlink():
        fail(f"build binary output already exists: {binary_output}")
    if receipt_output.exists() or receipt_output.is_symlink():
        fail(f"build receipt output already exists: {receipt_output}")
    if not 1 <= arguments.timeout_seconds <= 1800:
        fail("build timeout must be between 1 and 1800 seconds")
    repository_before = verify_immutable_checkout(root, arguments.commit)
    catalog = committed_rows(root, arguments.commit)
    source_paths = {
        path
        for path in catalog
        if path in SOURCE_FIXED or path.startswith(SOURCE_PREFIX)
    }
    source_rows = bind_rows(root, arguments.commit, catalog, source_paths)
    generator_rows = bind_rows(root, arguments.commit, catalog, GENERATOR_PATHS)
    require_closed_build_environment()
    rustup, rustc_version, cargo_version = exact_tool_versions(root)
    prepare_output_parent(binary_output)
    prepare_output_parent(receipt_output)
    temporary = root.joinpath(*PurePosixPath(TARGET_DIRECTORY_ARGUMENT).parts)
    if temporary.exists() or temporary.is_symlink():
        fail(f"observed-build target directory already exists: {temporary}")
    prepare_output_parent(temporary)
    temporary.mkdir(mode=0o700)
    binary_published = False
    identity: dict[str, Any] | None = None
    receipt: dict[str, Any] | None = None
    try:
        try:
            built = run_build(root, rustup, temporary, arguments.timeout_seconds)
            verify_rustc_dependency_roster(root, temporary, source_paths)
            payload = read_regular(built, MAX_EXECUTABLE_BYTES)
            observed = built.lstat()
            identity = executable_identity(payload, observed.st_mode)
            copy_regular(
                built,
                binary_output,
                identity["mode"],
                MAX_EXECUTABLE_BYTES,
            )
            binary_published = True
            published_payload = read_regular(binary_output, MAX_EXECUTABLE_BYTES)
            published_identity = executable_identity(
                published_payload, binary_output.lstat().st_mode
            )
            if published_identity != identity:
                fail("published executable differs from the observed Cargo output")
            repository_after = verify_immutable_checkout(root, arguments.commit)
            if repository_after != repository_before:
                fail("CREBAIN Git identity changed during the observed build")
            if bind_rows(root, arguments.commit, catalog, source_paths) != source_rows:
                fail("managed-simulation build inputs changed during the build")
            if (
                bind_rows(root, arguments.commit, catalog, GENERATOR_PATHS)
                != generator_rows
            ):
                fail("observed-build generator changed during the build")
            receipt = build_receipt(
                repository=repository_after,
                source_rows=source_rows,
                generator_rows=generator_rows,
                rustc_version=rustc_version,
                cargo_version=cargo_version,
                output_identity=published_identity,
            )
        finally:
            shutil.rmtree(temporary)
        if identity is None or receipt is None:
            fail("observed build ended without a complete output and receipt")
        write_new_regular(
            receipt_output,
            canonical(receipt) + b"\n",
            label="observed-build receipt",
            fail=fail,
        )
    except BaseException:
        if (
            binary_published
            and binary_output.exists()
            and not binary_output.is_symlink()
        ):
            binary_output.unlink()
        raise
    if identity is None or receipt is None:
        fail("observed build ended without a published output and receipt")
    print(
        canonical(
            {
                "status": "verified",
                "commit": arguments.commit,
                "binary_sha256": identity["sha256"],
                "receipt_sha256": receipt["receipt_sha256"],
            }
        ).decode("utf-8")
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--binary-output", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--receipt-output", type=Path, default=DEFAULT_RECEIPT)
    parser.add_argument("--timeout-seconds", type=int, default=900)
    execute(parser.parse_args())


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(f"managed-simulation observed build failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
