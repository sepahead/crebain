#!/usr/bin/env python3
"""Synchronize Engram contracts from one clean, pushed source commit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from managed_simulation_authoring_files import (
    ManagedSimulationSubprocessError,
    run_bounded_process,
)


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_ROOT = ROOT / "integrations" / "engram" / "managed-simulation" / "contracts"
PROVENANCE_PATH = CONTRACT_ROOT / "PROVENANCE.json"
EVIDENCE_SCHEMA_ROOT = (
    ROOT / "integrations" / "engram" / "managed-simulation" / "evidence-schemas"
)
RUNTIME_RECEIPT_PROVENANCE_PATH = (
    EVIDENCE_SCHEMA_ROOT / "ENGRAM_RUNTIME_RECEIPT_PROVENANCE.json"
)
MAX_CONTRACT_BYTES = 1024 * 1024
MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024
OBJECT_ID = re.compile(r"(?:[a-f0-9]{40}|[a-f0-9]{64})")


@dataclass(frozen=True)
class ContractSpec:
    schema_id: str
    source_path: str
    destination_name: str
    runtime_role: str


def standard_spec(version: int, operation: str, direction: str) -> ContractSpec:
    stem = f"engram.closed-loop-simulator.{operation}-{direction}.v{version}"
    prefix = "audit-standard" if version < 3 else "standard"
    return ContractSpec(
        schema_id=stem,
        source_path=f"integrations/contracts/{stem}.schema.json",
        destination_name=f"{prefix}-v{version}-{operation}-{direction}.schema.json",
        runtime_role="audit-only" if version < 3 else "runnable",
    )


CONTRACT_SPECS = (
    ContractSpec(
        schema_id="engram.managed-runtime-ipc.v1",
        source_path="integrations/contracts/engram.managed-runtime-ipc.v1.schema.json",
        destination_name="managed-runtime-ipc.schema.json",
        runtime_role="runnable",
    ),
    *(
        standard_spec(version, operation, direction)
        for version in (1, 2, 3)
        for operation in ("finish", "prepare", "step")
        for direction in ("request", "response")
    ),
)

RUNTIME_RECEIPT_SCHEMA_NAMES = (
    "engram.closed-loop-runtime-lifecycle-binding.v1.schema.json",
    "engram.contained-exec-command.v1.schema.json",
    "engram.extension-closed-loop-run-receipt.v2.schema.json",
    "engram.nest-closed-loop-evidence-bundle.v2.schema.json",
    "engram.reviewed-native-development-handshake.v1.schema.json",
    "engram.reviewed-native-development-termination.v1.schema.json",
)
RUNTIME_RECEIPT_SCHEMA_SPECS = tuple(
    ContractSpec(
        schema_id=name.removesuffix(".schema.json"),
        source_path=f"integrations/contracts/{name}",
        destination_name=name,
        runtime_role="evidence-validation",
    )
    for name in RUNTIME_RECEIPT_SCHEMA_NAMES
)


def fail(message: str) -> None:
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


def git(source_root: Path, *arguments: str) -> bytes:
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
        fail(f"Engram Git verification failed: {error}: {diagnostic.strip()}")
    if completed.returncode != 0:
        diagnostic = completed.stderr[:4096].decode("utf-8", errors="replace")
        fail(f"Engram Git verification failed: {diagnostic.strip()}")
    return completed.stdout


def read_regular(path: Path, maximum: int = MAX_CONTRACT_BYTES) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        fail(f"contract cannot be opened without following links: {path}: {error}")
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or before.st_nlink != 1
            or not 1 <= before.st_size <= maximum
        ):
            fail(f"contract is not one bounded owner-controlled file: {path}")
        payload = b""
        while len(payload) < before.st_size:
            chunk = os.read(descriptor, before.st_size - len(payload))
            if not chunk:
                fail(f"contract changed while it was read: {path}")
            payload += chunk
        if os.read(descriptor, 1):
            fail(f"contract grew while it was read: {path}")
        after = os.fstat(descriptor)

        def identity(row: os.stat_result) -> tuple[int, ...]:
            return (
                row.st_dev,
                row.st_ino,
                row.st_mode,
                row.st_uid,
                row.st_nlink,
                row.st_size,
                row.st_mtime_ns,
                row.st_ctime_ns,
            )

        if identity(before) != identity(after):
            fail(f"contract changed while it was read: {path}")
        return payload
    finally:
        os.close(descriptor)


def strict_json_object(payload: bytes, label: str) -> dict[str, Any]:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                fail(f"{label} has a duplicate member: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        fail(f"{label} has a non-finite number: {value}")

    try:
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=object_pairs,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"{label} is not strict UTF-8 JSON: {error}")
    if not isinstance(value, dict):
        fail(f"{label} must contain one JSON object")
    return value


def verify_checkout(source_root: Path, expected_commit: str) -> dict[str, Any]:
    if not OBJECT_ID.fullmatch(expected_commit):
        fail("Engram commit is not one lowercase Git object ID")
    head = git(source_root, "rev-parse", "--verify", "HEAD").decode().strip()
    origin_main = (
        git(source_root, "rev-parse", "--verify", "refs/remotes/origin/main")
        .decode()
        .strip()
    )
    if head != expected_commit or origin_main != expected_commit:
        fail("Engram HEAD and local origin/main do not equal the required commit")
    if git(source_root, "cat-file", "-t", expected_commit) != b"commit\n":
        fail("required Engram object is not a commit")
    if git(source_root, "status", "--porcelain=v1", "--untracked-files=all"):
        fail("Engram checkout is not clean")
    repository = git(source_root, "remote", "get-url", "origin").decode().strip()
    if not repository or "\n" in repository:
        fail("Engram origin URL is absent or malformed")
    return {
        "repository": repository,
        "commit": expected_commit,
        "tree": git(source_root, "rev-parse", f"{expected_commit}^{{tree}}")
        .decode()
        .strip(),
        "origin_main": origin_main,
        "object_format": git(source_root, "rev-parse", "--show-object-format")
        .decode()
        .strip(),
        "clean": True,
    }


def bind_tree_rows(
    source_root: Path,
    commit: str,
    specs: Iterable[ContractSpec],
) -> dict[str, tuple[str, str]]:
    paths = [spec.source_path for spec in specs]
    output = git(source_root, "ls-tree", "-z", "--full-tree", commit, "--", *paths)
    rows: dict[str, tuple[str, str]] = {}
    for encoded in output.split(b"\0"):
        if not encoded:
            continue
        try:
            header, raw_path = encoded.split(b"\t", 1)
            mode, kind, object_id = header.decode("ascii").split(" ")
            path = raw_path.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as error:
            fail(f"Engram contract tree row is malformed: {error}")
        if (
            kind != "blob"
            or mode not in {"100644", "100755"}
            or not OBJECT_ID.fullmatch(object_id)
            or path in rows
        ):
            fail(f"Engram contract tree row is invalid: {path}")
        rows[path] = (mode, object_id)
    if set(rows) != set(paths):
        fail("Engram contract roster contains an untracked or missing source")
    return rows


def build_sync(
    source_root: Path,
    expected_commit: str,
    specs: Iterable[ContractSpec] = CONTRACT_SPECS,
    *,
    destination_path_prefix: str = (
        "integrations/engram/managed-simulation/contracts/"
    ),
    include_size_bytes: bool = False,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    specs = tuple(specs)
    if len({spec.schema_id for spec in specs}) != len(specs):
        fail("contract schema IDs are not unique")
    if len({spec.destination_name for spec in specs}) != len(specs):
        fail("contract destination names are not unique")
    source_identity = verify_checkout(source_root, expected_commit)
    tree_rows = bind_tree_rows(source_root, expected_commit, specs)
    copies: list[dict[str, Any]] = []
    payloads: dict[str, bytes] = {}
    for spec in specs:
        payload = read_regular(source_root / spec.source_path)
        document = strict_json_object(payload, spec.source_path)
        if document.get("$id") not in {
            spec.schema_id,
            f"https://engram.local/schemas/{spec.schema_id}.schema.json",
        }:
            fail(f"Engram contract $id differs: {spec.source_path}")
        observed_blob = (
            git(source_root, "hash-object", "--no-filters", "--", spec.source_path)
            .decode()
            .strip()
        )
        mode, committed_blob = tree_rows[spec.source_path]
        if observed_blob != committed_blob:
            fail(
                f"Engram contract bytes differ from the committed blob: {spec.source_path}"
            )
        payloads[spec.destination_name] = payload
        copy = {
            "schema_id": spec.schema_id,
            "source_path": spec.source_path,
            "destination_path": destination_path_prefix + spec.destination_name,
            "sha256": sha256(payload),
            "git_mode": mode,
            "git_blob": committed_blob,
            "runtime_role": spec.runtime_role,
        }
        if include_size_bytes:
            copy["size_bytes"] = len(payload)
        copies.append(copy)
    if verify_checkout(source_root, expected_commit) != source_identity:
        fail("Engram checkout changed during contract synchronization")
    provenance = {
        "schema_version": "crebain.contract-provenance.v2",
        "source": source_identity,
        "copies": copies,
        "generation": {
            "policy": "clean-head-equals-local-origin-main-git-blob-copy.v1",
            "copy_count": len(copies),
        },
        "authority": "compatibility-copy-only",
    }
    return provenance, payloads


def build_runtime_receipt_sync(
    source_root: Path,
    expected_commit: str,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    return build_sync(
        source_root,
        expected_commit,
        RUNTIME_RECEIPT_SCHEMA_SPECS,
        destination_path_prefix=(
            "integrations/engram/managed-simulation/evidence-schemas/"
        ),
        include_size_bytes=True,
    )


def expected_provenance_bytes(provenance: dict[str, Any]) -> bytes:
    return (
        json.dumps(
            provenance,
            allow_nan=False,
            ensure_ascii=False,
            indent=2,
        ).encode("utf-8")
        + b"\n"
    )


def check_local(
    contract_root: Path,
    provenance_path: Path,
    provenance: dict[str, Any],
    payloads: dict[str, bytes],
) -> None:
    for name, expected in payloads.items():
        if read_regular(contract_root / name) != expected:
            fail(f"CREBAIN contract copy differs from Engram: {name}")
    if read_regular(provenance_path) != expected_provenance_bytes(provenance):
        fail("CREBAIN contract provenance is stale")


def replace_outputs(
    contract_root: Path,
    provenance_path: Path,
    provenance: dict[str, Any],
    payloads: dict[str, bytes],
) -> None:
    contract_root = contract_root.resolve(strict=True)
    if provenance_path.parent.resolve(strict=True) != contract_root:
        fail("provenance output must remain in the contract directory")
    with tempfile.TemporaryDirectory(
        prefix=".contract-sync-", dir=contract_root
    ) as raw:
        staging = Path(raw)
        for name, payload in payloads.items():
            target = staging / name
            target.write_bytes(payload)
            os.chmod(target, 0o600)
        staged_provenance = staging / provenance_path.name
        staged_provenance.write_bytes(expected_provenance_bytes(provenance))
        os.chmod(staged_provenance, 0o600)
        for name in sorted(payloads):
            destination = contract_root / name
            observed = destination.lstat()
            if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
                fail(f"contract destination is not one regular file: {destination}")
            os.replace(staging / name, destination)
        observed = provenance_path.lstat()
        if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1:
            fail("contract provenance destination is not one regular file")
        os.replace(staged_provenance, provenance_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engram-root", type=Path, required=True)
    parser.add_argument("--engram-commit", required=True)
    parser.add_argument(
        "--surface",
        choices=("wire", "runtime-receipts"),
        default="wire",
        help="select the immutable Engram contract surface",
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--check", action="store_true")
    action.add_argument("--write", action="store_true")
    arguments = parser.parse_args()
    source_root = arguments.engram_root.resolve(strict=True)
    if arguments.surface == "wire":
        provenance, payloads = build_sync(source_root, arguments.engram_commit)
        output_root = CONTRACT_ROOT
        provenance_path = PROVENANCE_PATH
    else:
        provenance, payloads = build_runtime_receipt_sync(
            source_root, arguments.engram_commit
        )
        output_root = EVIDENCE_SCHEMA_ROOT
        provenance_path = RUNTIME_RECEIPT_PROVENANCE_PATH
    if arguments.write:
        replace_outputs(output_root, provenance_path, provenance, payloads)
    check_local(output_root, provenance_path, provenance, payloads)
    print(
        canonical(
            {
                "status": "verified",
                "engram_commit": arguments.engram_commit,
                "surface": arguments.surface,
                "contract_count": len(payloads),
                "provenance_sha256": sha256(expected_provenance_bytes(provenance)),
            }
        ).decode("utf-8")
    )


if __name__ == "__main__":
    main()
