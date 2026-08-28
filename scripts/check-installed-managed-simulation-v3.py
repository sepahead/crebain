#!/usr/bin/env python3
"""Exercise the installed CREBAIN standard-v3 binary through private pipes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import stat
import struct
import time
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

from managed_simulation_authoring_files import (
    BoundedProcess,
    ManagedSimulationSubprocessError,
    write_new_regular,
)
from managed_simulation_build_provenance import (
    NO_AUTHORITY,
    TARGET,
    executable_identity,
    validate_build_receipt,
    validate_pack_receipt,
    validate_stage_inventory,
    validate_stage_receipt,
)


IPC = "engram.managed-runtime-ipc.v1"
PREPARE_ID = "crebain.simulation.prepare.v3"
STEP_ID = "crebain.simulation.step.v3"
FINISH_ID = "crebain.simulation.finish.v3"
STANDARD_SCHEMA_HASHES = {
    "engram.closed-loop-simulator.finish-request.v3": "486d0b94e229000b03eec04b0c6e05e6b01c9be1df1090d1c58c27bf14b09880",
    "engram.closed-loop-simulator.finish-response.v3": "abf670d295150b6f20d088aa88365e98f73fa4d0042859f7aa5d7a2403a45d9e",
    "engram.closed-loop-simulator.prepare-request.v3": "a5376511d1ba2edeef1b144074423bafc9fd88562893e3f2a4bba9718fc67e34",
    "engram.closed-loop-simulator.prepare-response.v3": "06fd034822ae82e164d2c14be034e0286b4f02d1345be076affebdd84fa5348a",
    "engram.closed-loop-simulator.step-request.v3": "aafb7c6574e83ba386acb4c10b81e5f9f4c1669e6b79208d86701b06fa473bb2",
    "engram.closed-loop-simulator.step-response.v3": "bac8b67dcd19fbd7addbf825cb1f3b1bf796fe28f638a84380bf906b32fcdb39",
}
EXPECTED_OPERATION_IDS = [
    "crebain.simulation.finish.v1",
    FINISH_ID,
    "crebain.simulation.prepare.v1",
    PREPARE_ID,
    "crebain.simulation.step.v1",
    STEP_ID,
]
MAX_DOCUMENT_BYTES = 1_048_576
MAX_BINARY_BYTES = 128 * 1024 * 1024
FRAME_LIMIT = 65_536
STEP_COUNT = 6
FAULT_STEP = 3
HOLD_STEP = 4
WASHOUT_STEP = 5
RESUME_STEP = 6
GENERATION_DOMAIN = b"engram-component-package-generation-v1\0"
MANIFEST_AUTHORITY = {
    "physical_actuation": False,
    "plant_control": False,
    "agent_direct_execution": False,
    "scientific_authority": False,
    "is_paper_local_evidence": False,
    "calibrated_posterior": False,
}
SEAL_AUTHORITY = {
    "execution": False,
    "installation": False,
    "ncp": False,
    "physical": False,
    "readiness": False,
    "scientific": False,
}
INSTALL_AUTHORITY = {
    "store_installation": True,
    "execution": False,
    "ncp": False,
    "physical": False,
    "scientific": False,
}
RUNTIME_CONFIGURATION = {
    "catalog_id": "sepahead.crebain.simulation.configuration.v1",
    "schema": {
        "schema_id": "crebain.simulation.configuration.v1",
        "schema_sha256": "425195af335d2131744f65d14b4713b1b2fcc6e55ea44f885e720172acdb7551",
    },
    "max_bytes": 4096,
}
RUNTIME_TRANSPORT = {
    "kind": "inherited-private-pipes",
    "framing": "uint32-be-length-prefixed-json",
    "contract": {
        "schema_id": "engram.managed-runtime-ipc.v1",
        "schema_sha256": "e6950a2b3d1913ebacb82823afe648538ec789fe845ed3894b2122dd9864cfc1",
    },
    "host_to_runtime": "inherited-read-pipe",
    "runtime_to_host": "inherited-write-pipe",
    "diagnostics": "bounded-inherited-write-pipe",
    "descriptor_inheritance": "explicit-private-only",
}
RUNTIME_LIFECYCLE = {
    "control_plane": "host-manager-only",
    "readiness_authority": "host-manager-only",
    "ipc_lifecycle_messages_enabled": False,
    "startup_timeout_ms": 10_000,
    "handshake_timeout_ms": 5_000,
    "shutdown_timeout_ms": 3_000,
    "kill_timeout_ms": 1_000,
    "max_generation_lifetime_ms": 7_200_000,
}
RESTART_POLICY = {
    "mode": "bounded",
    "max_restarts": 0,
    "window_ms": 60_000,
    "backoff_ms": 1_000,
    "healthy_reset_ms": 120_000,
    "on_exhaustion": "stop",
}
RUNTIME_RESOURCES = {
    "max_frame_bytes": 65_536,
    "max_inflight_operations": 1,
    "max_operations_per_generation": 1_026,
    "max_operation_timeout_ms": 5_000,
    "max_memory_bytes": 268_435_456,
    "max_cpu_time_ms": 600_000,
    "max_diagnostic_bytes": 1_048_576,
    "max_artifact_bytes": 0,
    "max_processes": 1,
}
RUNTIME_PIPE_BYTE_LIMIT = (FRAME_LIMIT + 4) * (
    RUNTIME_RESOURCES["max_operations_per_generation"] + 2
)


def fail(message: str) -> NoReturn:
    raise RuntimeError(message)


def canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def safe_relative(value: Any, *, label: str) -> PurePosixPath:
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
    if relative.as_posix() != value:
        fail(f"{label} is not canonical")
    return relative


def canonical_receipt(document: dict[str, Any], field: str = "receipt_sha256") -> str:
    reported = document.get(field)
    if not isinstance(reported, str) or len(reported) != 64:
        fail(f"installed receipt lacks {field}")
    material = {key: value for key, value in document.items() if key != field}
    if sha256(canonical(material)) != reported:
        fail(f"installed receipt {field} differs from its canonical content")
    return reported


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


def require_private_directory(path: Path, *, label: str) -> None:
    try:
        observed = path.lstat()
    except OSError as error:
        fail(f"{label} cannot be inspected: {path}: {error}")
    if (
        not stat.S_ISDIR(observed.st_mode)
        or observed.st_uid != os.geteuid()
        or observed.st_mode & 0o022
    ):
        fail(f"{label} is not one owner-controlled directory")


def read_regular(path: Path, maximum: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        fail(
            f"installed artifact cannot be opened without following links: {path}: {error}"
        )
    try:
        observed = os.fstat(descriptor)
        if (
            not stat.S_ISREG(observed.st_mode)
            or observed.st_uid != os.geteuid()
            or observed.st_nlink != 1
            or observed.st_size < 1
            or observed.st_size > maximum
        ):
            fail(f"installed artifact is not one bounded owner-controlled file: {path}")
        chunks: list[bytes] = []
        remaining = observed.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                fail(f"installed artifact changed while it was read: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            fail(f"installed artifact grew while it was read: {path}")
        after = os.fstat(descriptor)
        if not same_file_observation(observed, after):
            fail(f"installed artifact changed while it was read: {path}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def decode_object(payload: bytes, label: str) -> dict[str, Any]:
    def closed_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                fail(f"installed JSON contains a duplicate member: {label}: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        fail(f"installed JSON contains a non-finite number: {label}: {value}")

    try:
        value = json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=closed_object,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"installed JSON is malformed: {label}: {error}")
    if not isinstance(value, dict):
        fail(f"installed JSON is not an object: {label}")
    return value


def load_object(path: Path) -> tuple[dict[str, Any], bytes]:
    payload = read_regular(path, MAX_DOCUMENT_BYTES)
    value = decode_object(payload, str(path))
    return value, payload


def standard_step_id(study_run_id: str, step_index: int) -> str:
    material = {
        "domain": "engram-extension-closed-loop-step-v2",
        "run_id": study_run_id,
        "step_index": step_index,
    }
    return "step_" + sha256(canonical(material))[:32]


def derive_hex(domain: str, value: str, length: int) -> str:
    return sha256(domain.encode() + b"\0" + value.encode())[:length]


class InstalledCandidate:
    def __init__(
        self,
        generation_root: Path,
        seal_receipt_path: Path,
        build_receipt_path: Path,
        stage_receipt_path: Path,
        pack_receipt_path: Path,
    ) -> None:
        self.root = Path(os.path.abspath(generation_root))
        try:
            root_observation = self.root.lstat()
        except OSError as error:
            fail(f"installed generation root cannot be inspected: {self.root}: {error}")
        if (
            not stat.S_ISDIR(root_observation.st_mode)
            or root_observation.st_uid != os.geteuid()
            or root_observation.st_mode & 0o022
            or self.root.resolve(strict=True) != self.root
        ):
            fail("installed generation root is not one owner-controlled directory")
        self.manifest, manifest_bytes = load_object(self.root / "manifest.json")
        self.package_lock, package_lock_bytes = load_object(
            self.root / "package-lock.json"
        )
        self.configuration, configuration_bytes = load_object(
            self.root / "configuration.json"
        )
        self.bundle_receipt, bundle_receipt_bytes = load_object(
            self.root / "bundle-receipt.json"
        )
        if bundle_receipt_bytes != canonical(self.bundle_receipt):
            fail("installed bundle receipt is not exact canonical JSON bytes")
        self.seal_receipt_path = Path(os.path.abspath(seal_receipt_path))
        if (
            self.seal_receipt_path.parent.resolve(strict=True)
            != self.seal_receipt_path.parent
        ):
            fail("installed seal receipt parent must not use a symlink")
        self.seal_receipt, seal_receipt_bytes = load_object(self.seal_receipt_path)
        self.build_receipt_path = Path(os.path.abspath(build_receipt_path))
        self.stage_receipt_path = Path(os.path.abspath(stage_receipt_path))
        self.pack_receipt_path = Path(os.path.abspath(pack_receipt_path))
        for receipt_path, label in (
            (self.build_receipt_path, "observed-build receipt"),
            (self.stage_receipt_path, "package-stage receipt"),
            (self.pack_receipt_path, "Engram pack receipt"),
        ):
            if receipt_path.parent.resolve(strict=True) != receipt_path.parent:
                fail(f"installed {label} parent must not use a symlink")
        self.build_receipt, build_receipt_bytes = load_object(self.build_receipt_path)
        self.stage_receipt, stage_receipt_bytes = load_object(self.stage_receipt_path)
        self.pack_receipt, pack_receipt_bytes = load_object(self.pack_receipt_path)
        if (
            build_receipt_bytes != canonical(self.build_receipt) + b"\n"
            or stage_receipt_bytes != canonical(self.stage_receipt) + b"\n"
            or pack_receipt_bytes != canonical(self.pack_receipt) + b"\n"
        ):
            fail("build, stage, and pack receipts must use exact canonical JSON bytes")
        validate_build_receipt(self.build_receipt)
        validate_stage_receipt(
            self.stage_receipt,
            build_receipt=self.build_receipt,
            build_receipt_bytes=build_receipt_bytes,
        )
        validate_pack_receipt(self.pack_receipt)
        if (
            self.bundle_receipt.get("schema_version")
            != "engram.extension-package-bundle-receipt.v1"
            or self.seal_receipt.get("schema_version")
            != "engram.managed-extension-seal-receipt.v1"
        ):
            fail("installed bundle or seal receipt schema differs")
        if self.seal_receipt.get("authority") != SEAL_AUTHORITY:
            fail("installed seal receipt grants authority")
        expected_target = {
            "target_id": "macos-aarch64-darwin",
            "operating_system": "macos",
            "architecture": "aarch64",
            "abi": "darwin",
        }
        if (
            self.seal_receipt.get("extension")
            != {"id": "sepahead.crebain.simulation", "version": "0.1.0"}
            or self.seal_receipt.get("target") != expected_target
            or self.seal_receipt.get("profile")
            != "engram.reviewed-native-development.v1"
            or self.seal_receipt.get("launch_abi") != "engram.managed-runtime-stdio.v1"
        ):
            fail("installed seal identity or target differs")
        generation_id = self.bundle_receipt.get("generation_id")
        if (
            not isinstance(generation_id, str)
            or not generation_id.startswith("pkggen_")
            or len(generation_id) != 71
            or self.root.name != generation_id
            or self.root.parent.name != generation_id[7:9]
            or self.root.parent.parent.name != "generations"
        ):
            fail("installed generation root does not match its package generation ID")
        self.store_root = self.root.parents[2]
        package_root = self.root / "package"
        observations_root = self.store_root / "observations"
        for path, label in (
            (self.store_root, "installed store root"),
            (self.store_root / "generations", "installed generations directory"),
            (self.root.parent, "installed generation shard"),
            (self.root, "installed generation root"),
            (package_root, "installed package root"),
            (observations_root, "installed observations directory"),
        ):
            require_private_directory(path, label=label)
        self.install_observation_path = observations_root / f"{generation_id}.json"
        self.install_observation, install_observation_bytes = load_object(
            self.install_observation_path
        )
        generation_fields = (
            "store_policy",
            "publisher_authentication",
            "extension",
            "runtime",
            "manifest",
            "package_lock",
            "configuration",
            "package",
        )
        if any(field not in self.bundle_receipt for field in generation_fields):
            fail("installed bundle receipt lacks its complete generation core")
        generation_core = {
            field: self.bundle_receipt[field] for field in generation_fields
        }
        expected_generation_id = "pkggen_" + sha256(
            GENERATION_DOMAIN + canonical(generation_core)
        )
        if expected_generation_id != generation_id:
            fail("installed package generation ID differs from its generation core")
        bundle_receipt_sha256 = sha256(bundle_receipt_bytes)
        if (
            self.pack_receipt.get("observed_build_receipt_exact_sha256")
            != sha256(build_receipt_bytes)
            or self.pack_receipt.get("observed_build_receipt_sha256")
            != self.build_receipt.get("receipt_sha256")
            or self.pack_receipt.get("package_stage_receipt_exact_sha256")
            != sha256(stage_receipt_bytes)
            or self.pack_receipt.get("package_stage_receipt_sha256")
            != self.stage_receipt.get("receipt_sha256")
            or self.pack_receipt.get("seal_receipt_exact_sha256")
            != sha256(seal_receipt_bytes)
            or self.pack_receipt.get("bundle_receipt_exact_sha256")
            != bundle_receipt_sha256
            or self.pack_receipt.get("package_generation_id") != generation_id
            or self.pack_receipt.get("authority") != NO_AUTHORITY
        ):
            fail(
                "installed build, stage, seal, pack, bundle, or generation lineage differs"
            )
        if (
            self.install_observation.get("schema_version")
            != "engram.extension-package-install-observation.v1"
            or self.install_observation.get("generation_id") != generation_id
            or self.install_observation.get("bundle_receipt_sha256")
            != bundle_receipt_sha256
            or self.install_observation.get("state") != "published-verified"
            or any(
                field in self.install_observation
                for field in ("status", "installation_state")
            )
            or self.install_observation.get("authority") != INSTALL_AUTHORITY
        ):
            fail("installed store observation does not authorize this exact generation")
        self.store_id = self.install_observation.get("store_id")
        if not isinstance(self.store_id, str) or not self.store_id.startswith(
            "extstore_"
        ):
            fail("installed store observation lacks its store identity")
        reported_store_ids = {
            value
            for value in (
                self.bundle_receipt.get("store_id"),
                self.bundle_receipt.get("store_policy", {}).get("store_id"),
            )
            if value is not None
        }
        if reported_store_ids and reported_store_ids != {self.store_id}:
            fail("installed bundle and store observation identities differ")
        for field in (
            "extension",
            "manifest",
            "package_lock",
            "configuration",
            "package",
        ):
            if self.bundle_receipt.get(field) != self.seal_receipt.get(field):
                fail(f"installed bundle and seal {field} lineage differs")
        bundle_runtime = self.bundle_receipt.get("runtime")
        if not isinstance(bundle_runtime, dict) or bundle_runtime != {
            "installation_id": self.seal_receipt.get("installation_id"),
            "launch_abi": self.seal_receipt.get("launch_abi"),
            "operation_roster_sha256": self.seal_receipt.get("operation_roster_sha256"),
            "profile": self.seal_receipt.get("profile"),
            "schema_registry_sha256": self.seal_receipt.get("schema_registry_sha256"),
            "target": self.seal_receipt.get("target"),
        }:
            fail("installed bundle and seal runtime lineage differs")
        executable_relative = self.package_lock.get("executable", {}).get(
            "inventory_path"
        )
        if executable_relative != "bin/crebain-managed-simulation":
            fail("installed executable inventory path drifted")
        self.binary = self.root / "package" / executable_relative
        executable_bytes = read_regular(self.binary, MAX_BINARY_BYTES)
        installed_executable_identity = executable_identity(
            executable_bytes, self.binary.lstat().st_mode
        )
        if (
            not os.access(self.binary, os.X_OK)
            or installed_executable_identity["sha256"]
            != self.build_receipt.get("output", {}).get("sha256")
            or installed_executable_identity["sha256"]
            != self.stage_receipt.get("staged_executable", {}).get("sha256")
            or installed_executable_identity["format"] != "mach-o-64"
            or installed_executable_identity["architecture"] != "arm64"
            or installed_executable_identity["file_type"] != "executable"
        ):
            fail("installed runtime does not join one observed Mach-O arm64 build")

        self._observed_artifacts = {
            self.root / "manifest.json": (MAX_DOCUMENT_BYTES, sha256(manifest_bytes)),
            self.root / "package-lock.json": (
                MAX_DOCUMENT_BYTES,
                sha256(package_lock_bytes),
            ),
            self.root / "configuration.json": (
                MAX_DOCUMENT_BYTES,
                sha256(configuration_bytes),
            ),
            self.root / "bundle-receipt.json": (
                MAX_DOCUMENT_BYTES,
                sha256(bundle_receipt_bytes),
            ),
            self.install_observation_path: (
                MAX_DOCUMENT_BYTES,
                sha256(install_observation_bytes),
            ),
            self.seal_receipt_path: (MAX_DOCUMENT_BYTES, sha256(seal_receipt_bytes)),
            self.build_receipt_path: (
                MAX_DOCUMENT_BYTES,
                sha256(build_receipt_bytes),
            ),
            self.stage_receipt_path: (
                MAX_DOCUMENT_BYTES,
                sha256(stage_receipt_bytes),
            ),
            self.pack_receipt_path: (
                MAX_DOCUMENT_BYTES,
                sha256(pack_receipt_bytes),
            ),
            self.binary: (MAX_BINARY_BYTES, sha256(executable_bytes)),
        }

        receipt = self.seal_receipt
        exact_joins = (
            (sha256(manifest_bytes), receipt.get("manifest", {}).get("exact_sha256")),
            (
                sha256(package_lock_bytes),
                receipt.get("package_lock", {}).get("exact_sha256"),
            ),
            (
                sha256(configuration_bytes),
                receipt.get("configuration", {}).get("exact_sha256"),
            ),
            (
                sha256(executable_bytes),
                receipt.get("package", {}).get("executable_sha256"),
            ),
        )
        if any(actual != expected for actual, expected in exact_joins):
            fail("installed bytes differ from the sealed candidate")
        if sha256(canonical(self.manifest)) != receipt["manifest"]["canonical_sha256"]:
            fail("installed manifest canonical digest drifted")
        if (
            sha256(canonical(self.package_lock))
            != receipt["package_lock"]["canonical_sha256"]
        ):
            fail("installed package lock canonical digest drifted")
        self.configuration_sha256 = sha256(canonical(self.configuration))
        if self.configuration_sha256 != receipt["configuration"]["canonical_sha256"]:
            fail("installed configuration canonical digest drifted")
        if self.bundle_receipt.get("package", {}).get("package_sha256") != receipt.get(
            "package", {}
        ).get("package_sha256"):
            fail("installed bundle package digest differs from the seal")

        runtime = self.manifest.get("runtime", {})
        if (
            self.manifest.get("schema_version") != "2.0"
            or self.manifest.get("id") != "sepahead.crebain.simulation"
            or self.manifest.get("host_api") != {"minimum": "2.0", "maximum": "2.0"}
            or self.manifest.get("presentation", {}).get("mode") != "none"
            or self.manifest.get("capabilities")
            != [
                "compute.one-shot",
                "operations.simulation",
                "runtime.managed-headless",
            ]
            or self.manifest.get("ncp")
            != {
                "mode": "none",
                "activation_enabled": False,
                "host_compatible": False,
            }
            or self.manifest.get("authority") != MANIFEST_AUTHORITY
            or runtime.get("mode") != "managed-headless"
            or runtime.get("profile") != "engram.reviewed-native-development.v1"
            or runtime.get("configuration") != RUNTIME_CONFIGURATION
            or runtime.get("transport") != RUNTIME_TRANSPORT
            or runtime.get("lifecycle") != RUNTIME_LIFECYCLE
            or runtime.get("resources") != RUNTIME_RESOURCES
            or runtime.get("restart_policy") != RESTART_POLICY
        ):
            fail("installed manifest crosses the simulator-only Host API 2.0 boundary")
        reviewed_package = runtime.get("reviewed_package")
        if reviewed_package != {
            "lock_schema": "engram.extension-package-lock.v1",
            "target_id": receipt.get("target", {}).get("target_id"),
            "lock_sha256": sha256(package_lock_bytes),
            "package_sha256": receipt.get("package", {}).get("package_sha256"),
            "executable_catalog_id": "sepahead.crebain.simulation.runtime.v1",
        }:
            fail("installed manifest reviewed-package lineage differs")
        if (
            self.package_lock.get("schema_version") != "1.0"
            or self.package_lock.get("extension_id") != self.manifest.get("id")
            or self.package_lock.get("extension_version")
            != self.manifest.get("version")
            or self.package_lock.get("target") != receipt.get("target")
            or self.package_lock.get("package", {}).get("package_sha256")
            != receipt.get("package", {}).get("package_sha256")
            or self.package_lock.get("executable", {}).get("catalog_id")
            != "sepahead.crebain.simulation.runtime.v1"
        ):
            fail("installed package lock identity or seal lineage differs")
        self.operations = runtime.get("operations")
        if not isinstance(self.operations, list):
            fail("installed operation roster is absent")
        if [
            row.get("operation_id") for row in self.operations
        ] != EXPECTED_OPERATION_IDS:
            fail("installed operation roster is not the exact six-operation roster")
        self.by_operation = {row["operation_id"]: row for row in self.operations}
        self.operation_roster_sha256 = sha256(
            b"engram-managed-operation-roster-v1\0" + canonical(self.operations)
        )
        if self.operation_roster_sha256 != receipt.get("operation_roster_sha256"):
            fail("installed operation roster digest differs from the seal")
        contracts = self.package_lock.get("contracts")
        if not isinstance(contracts, list) or len(contracts) != 14:
            fail("installed package must contain exactly fourteen runnable contracts")
        contract_hashes = {
            row.get("contract_id"): row.get("sha256") for row in contracts
        }
        for schema_id, expected_hash in STANDARD_SCHEMA_HASHES.items():
            if contract_hashes.get(schema_id) != expected_hash:
                fail(f"installed standard schema digest drifted: {schema_id}")

        inventory = self.package_lock.get("inventory")
        if not isinstance(inventory, list) or not 1 <= len(inventory) <= 128:
            fail("installed package lock has no bounded inventory")
        inventory_by_path: dict[str, dict[str, Any]] = {}
        schema_ids: set[str] = set()
        for row in inventory:
            if not isinstance(row, dict):
                fail("installed package inventory row is not an object")
            relative = safe_relative(
                row.get("relative_path"), label="package inventory path"
            )
            relative_text = relative.as_posix()
            if relative_text in inventory_by_path:
                fail("installed package inventory paths are not unique")
            path = self.root / "package" / relative_text
            parent = package_root
            for part in relative.parts[:-1]:
                parent /= part
                require_private_directory(parent, label="installed package directory")
            maximum = (
                MAX_BINARY_BYTES
                if row.get("role") == "executable"
                else MAX_DOCUMENT_BYTES
            )
            payload = read_regular(path, maximum)
            observed = path.lstat()
            if (
                row.get("byte_length") != len(payload)
                or row.get("sha256") != sha256(payload)
                or row.get("mode") != observed.st_mode
            ):
                fail(f"installed package inventory differs: {relative_text}")
            inventory_by_path[relative_text] = row
            self._observed_artifacts[path] = (maximum, sha256(payload))
            if row.get("role") == "contract":
                contract_document = decode_object(payload, relative_text)
                schema_id = contract_document.get("$id")
                if (
                    not isinstance(schema_id, str)
                    or not schema_id.startswith("https://engram.local/schemas/")
                    or not schema_id.endswith(".schema.json")
                    or schema_id in schema_ids
                ):
                    fail(
                        f"installed contract lacks its schema identity: {relative_text}"
                    )
                schema_ids.add(schema_id)
        if set(inventory_by_path) != {
            "bin/crebain-managed-simulation",
            *(row.get("inventory_path") for row in contracts),
        }:
            fail("installed package inventory and contract roster differ")
        for row in contracts:
            inventory_row = inventory_by_path.get(row.get("inventory_path"))
            if (
                not isinstance(inventory_row, dict)
                or inventory_row.get("role") != "contract"
                or inventory_row.get("sha256") != row.get("sha256")
            ):
                fail(f"installed contract inventory differs: {row.get('contract_id')}")
        seal_schemas = receipt.get("schemas")
        if not isinstance(seal_schemas, list) or len(seal_schemas) != len(contracts):
            fail("installed seal schema roster differs")
        for contract, sealed_schema in zip(contracts, seal_schemas, strict=True):
            path = self.root / "package" / contract["inventory_path"]
            payload = read_regular(path, MAX_DOCUMENT_BYTES)
            document = decode_object(payload, contract["inventory_path"])
            if (
                not isinstance(sealed_schema, dict)
                or sealed_schema.get("schema_id") != contract.get("contract_id")
                or sealed_schema.get("package_relative_path")
                != contract.get("inventory_path")
                or sealed_schema.get("exact_sha256") != sha256(payload)
                or sealed_schema.get("canonical_sha256") != sha256(canonical(document))
            ):
                fail(
                    f"installed seal schema lineage differs: {contract.get('contract_id')}"
                )
        executable_inventory = inventory_by_path["bin/crebain-managed-simulation"]
        if (
            executable_inventory.get("role") != "executable"
            or executable_inventory.get("sha256")
            != self.package_lock.get("executable", {}).get("sha256")
            or executable_inventory.get("sha256")
            != receipt.get("package", {}).get("executable_sha256")
        ):
            fail("installed executable inventory lineage differs")
        normalized_inventory = [
            {
                "relative_path": row["relative_path"],
                "byte_length": row["byte_length"],
                "sha256": row["sha256"],
                "mode": stat.S_IMODE(row["mode"]),
                "role": row["role"],
            }
            for row in inventory
        ]
        validate_stage_inventory(normalized_inventory)
        expected_target = {
            key: value for key, value in TARGET.items() if key != "rust_target_triple"
        }
        if (
            normalized_inventory != self.stage_receipt.get("package_inventory")
            or self.stage_receipt.get("target") != TARGET
            or self.seal_receipt.get("target") != expected_target
            or self.stage_receipt.get("configuration_exact_sha256")
            != self.seal_receipt.get("configuration", {}).get("exact_sha256")
            or self.stage_receipt.get("staged_executable")
            != installed_executable_identity
        ):
            fail("installed package, stage receipt, and Engram seal lineage differs")

        profile = self.configuration.get("standard_simulator_profile", {})
        if profile.get("recoverable_fault_schedule") != [
            {
                "step_index": FAULT_STEP,
                "channel_ordinal": 1,
                "fault_disposition": "sensor-unavailable",
            }
        ]:
            fail("installed recoverable fault schedule drifted")
        self.identity = {
            "manifest_exact_sha256": receipt["manifest"]["exact_sha256"],
            "manifest_canonical_sha256": receipt["manifest"]["canonical_sha256"],
            "package_lock_exact_sha256": receipt["package_lock"]["exact_sha256"],
            "package_lock_canonical_sha256": receipt["package_lock"][
                "canonical_sha256"
            ],
            "package_sha256": receipt["package"]["package_sha256"],
            "executable_sha256": receipt["package"]["executable_sha256"],
            "configuration_exact_sha256": receipt["configuration"]["exact_sha256"],
            "configuration_canonical_sha256": self.configuration_sha256,
            "target_id": receipt["target"]["target_id"],
            "profile": receipt["profile"],
            "launch_abi": receipt["launch_abi"],
            "operation_roster_sha256": self.operation_roster_sha256,
            "schema_registry_sha256": receipt["schema_registry_sha256"],
            "installation_id": receipt["installation_id"],
        }
        self.package_generation_id = generation_id
        self.generation_core_sha256 = sha256(canonical(generation_core))
        self.bundle_receipt_exact_sha256 = bundle_receipt_sha256
        self.seal_receipt_exact_sha256 = sha256(seal_receipt_bytes)
        self.install_observation_exact_sha256 = sha256(install_observation_bytes)
        self.build_receipt_exact_sha256 = sha256(build_receipt_bytes)
        self.stage_receipt_exact_sha256 = sha256(stage_receipt_bytes)
        self.pack_receipt_exact_sha256 = sha256(pack_receipt_bytes)
        self.installed_executable_identity = installed_executable_identity

    def reverify(self) -> None:
        for path, (maximum, expected) in self._observed_artifacts.items():
            if sha256(read_regular(path, maximum)) != expected:
                fail(f"installed artifact changed during the operational gate: {path}")


class RuntimePipe:
    def __init__(self, candidate: InstalledCandidate, scenario: str) -> None:
        self.candidate = candidate
        self.scenario = scenario
        self.generation = {
            "installation_id": candidate.identity["installation_id"],
            "generation_id": "gen_"
            + derive_hex("crebain-installed-v3-generation", scenario, 64),
            "ordinal": 1,
        }
        self.session = BoundedProcess(
            [str(candidate.binary)],
            stdin_pipe=True,
            max_input_bytes=RUNTIME_PIPE_BYTE_LIMIT,
            max_stdout_bytes=RUNTIME_PIPE_BYTE_LIMIT,
            max_stderr_bytes=RUNTIME_RESOURCES["max_diagnostic_bytes"],
            label=f"installed managed runtime {scenario}",
        )
        self.process = self.session.process

    @staticmethod
    def _diagnostic(payload: bytes) -> str:
        return payload[:4096].decode("utf-8", errors="replace").strip()

    def _fail_process(self, error: ManagedSimulationSubprocessError) -> NoReturn:
        diagnostic = self._diagnostic(error.stderr)
        fail(f"installed runtime process failed: {error}: {diagnostic}")

    def close(self, expected_code: int = 0) -> str:
        deadline = time.monotonic() + 5.0
        self.session.close_stdin()
        try:
            result = self.session.wait(deadline=deadline)
        except ManagedSimulationSubprocessError as error:
            self._fail_process(error)
        diagnostic = self._diagnostic(result.stderr)
        if result.returncode != expected_code:
            fail(
                f"installed runtime exit {result.returncode}, "
                f"expected {expected_code}: {diagnostic}"
            )
        return diagnostic

    def abort(self) -> None:
        self.session.abort()

    def terminate_active(self) -> str:
        if os.name != "posix":
            fail("the reviewed macOS installed-runtime gate requires POSIX signals")
        deadline = time.monotonic() + 2.0
        self.session.send_signal(signal.SIGTERM)
        try:
            result = self.session.wait(deadline=deadline)
        except ManagedSimulationSubprocessError as error:
            self._fail_process(error)
        diagnostic = self._diagnostic(result.stderr)
        if result.returncode != -signal.SIGTERM:
            fail(
                f"installed runtime SIGTERM exit {result.returncode}, "
                f"expected {-signal.SIGTERM}"
            )
        return diagnostic

    def exchange(self, value: dict[str, Any]) -> dict[str, Any]:
        payload = canonical(value)
        if len(payload) > FRAME_LIMIT:
            fail("host test frame exceeds the installed runtime limit")
        deadline = time.monotonic() + 5.0
        try:
            self.session.write_all(
                struct.pack(">I", len(payload)) + payload,
                deadline=deadline,
            )
            return self._read_frame(deadline=deadline)
        except ManagedSimulationSubprocessError as error:
            self._fail_process(error)

    def send_without_response(self, value: dict[str, Any]) -> None:
        payload = canonical(value)
        if len(payload) > FRAME_LIMIT:
            fail("host test frame exceeds the installed runtime limit")
        try:
            self.session.write_all(
                struct.pack(">I", len(payload)) + payload,
                deadline=time.monotonic() + 5.0,
            )
        except ManagedSimulationSubprocessError as error:
            self._fail_process(error)

    def _read_exact(self, length: int, *, deadline: float) -> bytes:
        try:
            return self.session.read_exact(length, deadline=deadline)
        except ManagedSimulationSubprocessError as error:
            self._fail_process(error)

    def _read_frame(self, *, deadline: float) -> dict[str, Any]:
        length = struct.unpack(">I", self._read_exact(4, deadline=deadline))[0]
        if not 1 <= length <= FRAME_LIMIT:
            fail("installed runtime emitted an invalid frame length")
        payload = self._read_exact(length, deadline=deadline)
        return decode_object(payload, "installed runtime response")


def envelope(
    pipe: RuntimePipe, kind: str, sequence: int, body: dict[str, Any]
) -> dict[str, Any]:
    marker = derive_hex(
        "crebain-installed-v3-message", f"{pipe.scenario}:{sequence}:{kind}", 32
    )
    return {
        "schema_version": "1.0",
        "protocol": IPC,
        "kind": kind,
        "sender": "host",
        "generation": pipe.generation,
        "sequence": sequence,
        "message_id": "msg_" + marker,
        "body": body,
    }


def handshake(pipe: RuntimePipe) -> dict[str, Any]:
    configuration_schema = pipe.candidate.manifest["runtime"]["configuration"]["schema"]
    request = envelope(
        pipe,
        "host.handshake",
        0,
        {
            "challenge": "chal_"
            + derive_hex("crebain-installed-v3-challenge", pipe.scenario, 64),
            "identity": pipe.candidate.identity,
            "configuration": {
                "schema": configuration_schema,
                "canonical_sha256": pipe.candidate.configuration_sha256,
                "document": pipe.candidate.configuration,
            },
            "max_frame_bytes": FRAME_LIMIT,
        },
    )
    response = pipe.exchange(request)
    if (
        response.get("kind") != "runtime.handshake"
        or response.get("body", {}).get("identity") != pipe.candidate.identity
        or response.get("body", {}).get("ready_claim") is not False
    ):
        fail("installed runtime handshake identity drifted")
    return response


def operation_request(
    pipe: RuntimePipe,
    operation_id: str,
    sequence: int,
    control: dict[str, Any],
) -> dict[str, Any]:
    operation = pipe.candidate.by_operation[operation_id]
    marker = derive_hex(
        "crebain-installed-v3-operation", f"{pipe.scenario}:{sequence}", 64
    )
    return envelope(
        pipe,
        "operation.request",
        sequence,
        {
            "idempotency_key": "idem_" + marker,
            "operation": {
                key: operation[key]
                for key in ("operation_id", "class", "effect", "artifact_access")
            },
            "request_schema": operation["request_schema"],
            "response_schema": operation["response_schema"],
            "compute_grant": {
                "mode": "host-one-shot",
                "grant_id": "grant_" + marker,
                "generation_id": pipe.generation["generation_id"],
                "operation_id": operation_id,
                "issued_for_sequence": sequence,
                "max_cpu_time_ms": operation["max_cpu_time_ms"],
                "valid_for_ms": 5000,
                "reusable": False,
            },
            "timeout_ms": 5000,
            "control": control,
            "bulk": {"inline": False, "references": []},
        },
    )


def require_success(response: dict[str, Any], operation_id: str) -> dict[str, Any]:
    body = response.get("body", {})
    if (
        response.get("kind") != "operation.response"
        or body.get("status") != "succeeded"
        or body.get("operation", {}).get("operation_id") != operation_id
    ):
        fail(f"installed runtime operation failed: {operation_id}")
    control = body.get("control")
    if not isinstance(control, dict):
        fail("installed runtime response control is absent")
    return control


def semantic_rosters(count: int) -> dict[str, list[Any]]:
    return {
        "channel_ids": [f"channel-{index:02}" for index in range(1, count + 1)],
        "subject_kinds": ["simulated.drone"] * count,
        "subject_ids": [f"subject-{index:02}" for index in range(1, count + 1)],
        "observation_space_ids": ["kinematics.position-velocity-enu-si"] * count,
        "action_space_ids": ["kinematics.acceleration-enu-si"] * count,
        "observation_widths": [6] * count,
        "action_widths": [3] * count,
        "observation_component_ids": [
            "position.east",
            "position.north",
            "position.up",
            "velocity.east",
            "velocity.north",
            "velocity.up",
        ]
        * count,
        "observation_unit_ids": [
            "si.metre",
            "si.metre",
            "si.metre",
            "si.metre-per-second",
            "si.metre-per-second",
            "si.metre-per-second",
        ]
        * count,
        "action_component_ids": [
            "acceleration.east",
            "acceleration.north",
            "acceleration.up",
        ]
        * count,
        "action_unit_ids": ["si.metre-per-second-squared"] * (count * 3),
    }


def actions(count: int) -> list[float]:
    return [
        value
        for index in range(1, count + 1)
        for value in (float(index), -0.5 * index, 0.25 * index)
    ]


def prepare_control(
    candidate: InstalledCandidate,
    count: int,
    scenario: str,
    study_run_id: str,
    step_count: int,
) -> dict[str, Any]:
    return {
        "schema_version": "engram.closed-loop-simulator.prepare-request.v3",
        "study_run_id": study_run_id,
        "closed_loop_definition_sha256": sha256(
            canonical({"count": count, "scenario": scenario})
        ),
        "runtime_adapter_configuration_sha256": candidate.configuration_sha256,
        "step_count": step_count,
        "tic_unit": "microsecond",
        "causality_policy": "sample-runtime-run-controller-apply-zoh-v1",
        "step_duration_tics": 20000,
        **semantic_rosters(count),
        "action_min_values": [-10.0] * (count * 3),
        "action_max_values": [10.0] * (count * 3),
        "safe_action_values": [0.0] * (count * 3),
    }


def run_scenario(
    candidate: InstalledCandidate,
    count: int,
    recovery_policy: bool,
) -> list[dict[str, Any]]:
    mode = "recovery" if recovery_policy else "baseline"
    scenario = f"installed-standard-v3-{count}-{mode}"
    study_run_id = f"study-run-installed-v3-{count}-{mode}"
    pipe = RuntimePipe(candidate, scenario)
    controls: list[dict[str, Any]] = []
    try:
        handshake(pipe)
        rosters = semantic_rosters(count)
        prepare = prepare_control(candidate, count, scenario, study_run_id, STEP_COUNT)
        response = pipe.exchange(operation_request(pipe, PREPARE_ID, 1, prepare))
        prepared = require_success(response, PREPARE_ID)
        if prepared.get("observation_widths") != [6] * count:
            fail("installed standard prepare width drifted")
        controls.append(prepared)
        prior = prepared
        for step_index in range(1, STEP_COUNT + 1):
            action_values = actions(count)
            dispositions = ["bounded-neural-proposal"] * count
            if recovery_policy and step_index == HOLD_STEP:
                if prior.get("fault_dispositions", [None])[0] != "sensor-unavailable":
                    fail(
                        "host safe hold was not causally selected from the prior fault"
                    )
                action_values[:3] = [0.0, 0.0, 0.0]
                dispositions[0] = "safe-hold"
            elif recovery_policy and step_index == WASHOUT_STEP:
                action_values[:3] = [0.0, 0.0, 0.0]
            step = {
                "schema_version": "engram.closed-loop-simulator.step-request.v3",
                "study_run_id": study_run_id,
                "step_index": step_index,
                "step_id": standard_step_id(study_run_id, step_index),
                "source_snapshot_sha256": sha256(
                    canonical({"source": scenario, "step": step_index})
                ),
                "runtime_request_sha256": sha256(
                    canonical({"request": scenario, "step": step_index})
                ),
                "tic_unit": "microsecond",
                "causality_policy": "sample-runtime-run-controller-apply-zoh-v1",
                "step_duration_tics": 20000,
                "source_simulation_time_tics": (step_index - 1) * 20000,
                "target_simulation_time_tics": step_index * 20000,
                "channel_ids": rosters["channel_ids"],
                "subject_ids": rosters["subject_ids"],
                "action_widths": [3] * count,
                "action_values": action_values,
                "saturated_values": [False] * (count * 3),
                "action_dispositions": dispositions,
            }
            response = pipe.exchange(
                operation_request(pipe, STEP_ID, step_index + 1, step)
            )
            prior = require_success(response, STEP_ID)
            controls.append(prior)
        finish = {
            "schema_version": "engram.closed-loop-simulator.finish-request.v3",
            "study_run_id": study_run_id,
            "final_step_index": STEP_COUNT,
            "final_snapshot_sha256": sha256(canonical({"final": scenario})),
            "tic_unit": "microsecond",
            "causality_policy": "sample-runtime-run-controller-apply-zoh-v1",
            "step_duration_tics": 20000,
            "final_simulation_time_tics": STEP_COUNT * 20000,
            "reason": "completed",
        }
        finished = require_success(
            pipe.exchange(operation_request(pipe, FINISH_ID, STEP_COUNT + 2, finish)),
            FINISH_ID,
        )
        if finished.get("run_state_cleared") is not True:
            fail("installed standard run did not clear terminal state")
        diagnostic = pipe.close()
        if diagnostic:
            fail(f"installed successful runtime emitted diagnostics: {diagnostic}")
    except BaseException:
        pipe.abort()
        raise

    fault = controls[FAULT_STEP]
    if (
        fault.get("fault_dispositions")
        != ["sensor-unavailable"] + ["none"] * (count - 1)
        or fault.get("fault_codes") != ["sensor-unavailable"] + ["none"] * (count - 1)
        or fault.get("observation_present") != [False] + [True] * (count - 1)
    ):
        fail("installed scheduled sensor-unavailable response drifted")
    for index, control in enumerate(controls[1:], start=1):
        values = control.get("observation_values")
        if not isinstance(values, list) or len(values) != count * 6:
            fail("installed observation vector width drifted")
        if index != FAULT_STEP and (
            control.get("fault_dispositions") != ["none"] * count
            or control.get("observation_present") != [True] * count
        ):
            fail("installed recoverable fault did not clear after one step")
    if recovery_policy:
        if controls[HOLD_STEP].get("fault_dispositions") != ["none"] * count:
            fail("installed safe hold manufactured a simulator fault")
        if controls[WASHOUT_STEP].get("fault_dispositions") != ["none"] * count:
            fail("installed recovery washout manufactured a simulator fault")
        before = controls[WASHOUT_STEP]["observation_values"][:6]
        resumed = controls[RESUME_STEP]["observation_values"][:6]
        if before == resumed:
            fail("installed lane did not resume after bounded nonzero action")
    return controls


def run_negative_clock_gate(candidate: InstalledCandidate) -> None:
    pipe = RuntimePipe(candidate, "installed-standard-v3-negative-clock")
    try:
        handshake(pipe)
        rosters = semantic_rosters(1)
        invalid = {
            "schema_version": "engram.closed-loop-simulator.prepare-request.v3",
            "study_run_id": "study-run-installed-v3-negative",
            "closed_loop_definition_sha256": "a" * 64,
            "runtime_adapter_configuration_sha256": candidate.configuration_sha256,
            "step_count": 1,
            "tic_unit": "millisecond",
            "causality_policy": "sample-runtime-run-controller-apply-zoh-v1",
            "step_duration_tics": 20000,
            **rosters,
            "action_min_values": [-10.0] * 3,
            "action_max_values": [10.0] * 3,
            "safe_action_values": [0.0] * 3,
        }
        pipe.send_without_response(operation_request(pipe, PREPARE_ID, 1, invalid))
        diagnostic = pipe.close(expected_code=2)
        if "standard.clock-mismatch" not in diagnostic:
            fail(
                "installed negative clock gate did not fail before state creation: "
                f"{diagnostic}"
            )
    except BaseException:
        pipe.abort()
        raise


def run_signal_cancellation_gate(candidate: InstalledCandidate) -> None:
    scenario = "installed-standard-v3-signal-cancellation"
    pipe = RuntimePipe(candidate, scenario)
    try:
        handshake(pipe)
        control = prepare_control(
            candidate,
            3,
            scenario,
            "study-run-installed-v3-signal-cancellation",
            1,
        )
        prepared = require_success(
            pipe.exchange(operation_request(pipe, PREPARE_ID, 1, control)),
            PREPARE_ID,
        )
        if prepared.get("run_state_active") is not True:
            fail("installed signal-cancellation setup did not create active state")
        diagnostic = pipe.terminate_active()
        if diagnostic:
            fail(f"installed SIGTERM cancellation emitted diagnostics: {diagnostic}")
    except BaseException:
        pipe.abort()
        raise

    restart_scenario = "installed-standard-v3-after-signal-cancellation"
    restarted = RuntimePipe(candidate, restart_scenario)
    try:
        handshake(restarted)
        control = prepare_control(
            candidate,
            3,
            restart_scenario,
            "study-run-installed-v3-after-signal-cancellation",
            1,
        )
        prepared = require_success(
            restarted.exchange(operation_request(restarted, PREPARE_ID, 1, control)),
            PREPARE_ID,
        )
        if prepared.get("run_state_active") is not True:
            fail("fresh generation did not prepare after installed cancellation")
        diagnostic = restarted.close()
        if diagnostic:
            fail(
                f"fresh post-cancellation generation emitted diagnostics: {diagnostic}"
            )
    except BaseException:
        restarted.abort()
        raise


def assert_lane_isolation(
    baseline: list[dict[str, Any]], recovery: list[dict[str, Any]]
) -> None:
    if len(baseline) != len(recovery):
        fail("installed paired trajectory lengths differ")
    for step_index, (left, right) in enumerate(zip(baseline, recovery, strict=True)):
        if left["observation_values"][6:] != right["observation_values"][6:]:
            fail(f"installed B/C observation isolation drifted at step {step_index}")
        if left["fault_dispositions"][1:] != right["fault_dispositions"][1:]:
            fail(f"installed B/C fault isolation drifted at step {step_index}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generation-root", type=Path, required=True)
    parser.add_argument("--seal-receipt", type=Path, required=True)
    parser.add_argument("--build-receipt", type=Path, required=True)
    parser.add_argument("--stage-receipt", type=Path, required=True)
    parser.add_argument("--pack-receipt", type=Path, required=True)
    parser.add_argument("--write-receipt", type=Path)
    arguments = parser.parse_args()
    candidate = InstalledCandidate(
        arguments.generation_root,
        arguments.seal_receipt,
        arguments.build_receipt,
        arguments.stage_receipt,
        arguments.pack_receipt,
    )

    recovery_by_count: dict[int, list[dict[str, Any]]] = {}
    for count in (1, 2, 3):
        recovery_by_count[count] = run_scenario(candidate, count, True)
    baseline = run_scenario(candidate, 3, False)
    recovery = recovery_by_count[3]
    replay = run_scenario(candidate, 3, True)
    if recovery != replay:
        fail("installed three-channel recovery replay drifted")
    assert_lane_isolation(baseline, recovery)
    run_negative_clock_gate(candidate)
    run_signal_cancellation_gate(candidate)
    candidate.reverify()

    receipt = {
        "schema_version": "crebain.standard-v3-installed-binary-proof.v3",
        "observed_build_receipt_exact_sha256": (candidate.build_receipt_exact_sha256),
        "observed_build_receipt_sha256": candidate.build_receipt["receipt_sha256"],
        "observed_build_receipt": candidate.build_receipt,
        "package_stage_receipt_exact_sha256": candidate.stage_receipt_exact_sha256,
        "package_stage_receipt_sha256": candidate.stage_receipt["receipt_sha256"],
        "package_stage_receipt": candidate.stage_receipt,
        "engram_pack_receipt_exact_sha256": candidate.pack_receipt_exact_sha256,
        "engram_pack_receipt_sha256": candidate.pack_receipt["receipt_sha256"],
        "engram_pack_receipt": candidate.pack_receipt,
        "crebain_commit": candidate.build_receipt["repository"]["commit"],
        "crebain_tree": candidate.build_receipt["repository"]["tree"],
        "crebain_origin_main": candidate.build_receipt["repository"]["origin_main"],
        "engram_commit": candidate.pack_receipt["engram_repository"]["commit"],
        "engram_tree": candidate.pack_receipt["engram_repository"]["tree"],
        "engram_origin_main": candidate.pack_receipt["engram_repository"][
            "origin_main"
        ],
        "engram_extension_tool_sha256": candidate.pack_receipt["engram_tool"]["sha256"],
        "engram_extension_tool_git_blob": candidate.pack_receipt["engram_tool"][
            "git_blob"
        ],
        "build_source_roster_sha256": candidate.build_receipt["source"][
            "roster_sha256"
        ],
        "build_input_identity_sha256": candidate.build_receipt["input_identity_sha256"],
        "executable_format": candidate.installed_executable_identity["format"],
        "executable_architecture": candidate.installed_executable_identity[
            "architecture"
        ],
        "store_id": candidate.store_id,
        "package_generation_id": candidate.package_generation_id,
        "installation_id": candidate.identity["installation_id"],
        "generation_core_sha256": candidate.generation_core_sha256,
        "bundle_receipt_exact_sha256": candidate.bundle_receipt_exact_sha256,
        "seal_receipt_exact_sha256": candidate.seal_receipt_exact_sha256,
        "install_observation_exact_sha256": (
            candidate.install_observation_exact_sha256
        ),
        "manifest_exact_sha256": candidate.identity["manifest_exact_sha256"],
        "package_lock_exact_sha256": candidate.identity["package_lock_exact_sha256"],
        "configuration_exact_sha256": candidate.identity["configuration_exact_sha256"],
        "package_sha256": candidate.identity["package_sha256"],
        "executable_sha256": candidate.identity["executable_sha256"],
        "configuration_canonical_sha256": candidate.configuration_sha256,
        "operation_roster_sha256": candidate.operation_roster_sha256,
        "operation_ids": EXPECTED_OPERATION_IDS,
        "standard_schema_sha256": STANDARD_SCHEMA_HASHES,
        "drone_counts": [1, 2, 3],
        "step_count": STEP_COUNT,
        "fault_step": FAULT_STEP,
        "fault": "sensor-unavailable",
        "host_policy": [
            "fault-observed",
            "safe-hold",
            "bounded-zero-washout",
            "bounded-nonzero-resume",
        ],
        "recovery_controls_sha256": {
            str(count): sha256(canonical(controls))
            for count, controls in recovery_by_count.items()
        },
        "baseline_three_controls_sha256": sha256(canonical(baseline)),
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
        "disclosure": "This local receipt observes installed simulator bytes and private-pipe responses. It is not a signature or NEST evidence.",
    }
    receipt["receipt_sha256"] = sha256(canonical(receipt))
    payload = canonical(receipt) + b"\n"
    if arguments.write_receipt is not None:
        receipt_path = Path(os.path.abspath(arguments.write_receipt))
        if receipt_path.parent.resolve(strict=True) != receipt_path.parent:
            fail("installed proof output parent must not use a symlink")
        write_new_regular(
            receipt_path,
            payload,
            label="installed proof",
            fail=fail,
        )
    print(payload.decode("utf-8"), end="")


if __name__ == "__main__":
    main()
