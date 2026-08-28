#!/usr/bin/env python3
"""Provider-free replay for the installed CREBAIN standard-v3 gate."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from types import ModuleType
from typing import Any

from managed_simulation_build_provenance import canonical as provenance_canonical
from managed_simulation_test_fixtures import (
    build_receipt,
    macho_arm64,
    pack_receipt,
    stage_receipt,
)


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check-installed-managed-simulation-v3.py"
INTEGRATION = ROOT / "integrations" / "engram" / "managed-simulation"
BINARY = ROOT / "src-tauri" / "target" / "release" / "crebain-managed-simulation"


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


def write_json(path: Path, value: Any) -> bytes:
    payload = canonical(value) + b"\n"
    path.write_bytes(payload)
    os.chmod(path, 0o600)
    return payload


def reseal(document: dict[str, Any]) -> None:
    material = {
        key: value for key, value in document.items() if key != "receipt_sha256"
    }
    document["receipt_sha256"] = sha256(canonical(material))


def make_candidate(root: Path) -> tuple[Path, Path, Path, Path, Path]:
    manifest = json.loads((INTEGRATION / "manifest.template.json").read_text())
    configuration = json.loads((INTEGRATION / "configuration.json").read_text())
    recipe = json.loads(
        (INTEGRATION / "authoring.macos-aarch64-darwin.json").read_text()
    )
    contracts = []
    contract_payloads: dict[str, bytes] = {}
    inventory = []
    for row in recipe["schemas"]:
        source = INTEGRATION / row["package_relative_path"]
        payload = source.read_bytes()
        relative = row["package_relative_path"].removeprefix("contracts/")
        inventory_path = f"contracts/{relative}"
        contract_payloads[inventory_path] = payload
        contracts.append(
            {
                "contract_id": row["schema_id"],
                "inventory_path": inventory_path,
                "kind": "json-schema",
                "sha256": sha256(payload),
            }
        )
        inventory.append(
            {
                "byte_length": len(payload),
                "mode": stat.S_IFREG | 0o600,
                "relative_path": inventory_path,
                "role": "contract",
                "sha256": sha256(payload),
            }
        )
    binary_payload = BINARY.read_bytes()
    inventory.insert(
        0,
        {
            "byte_length": len(binary_payload),
            "mode": stat.S_IFREG | 0o700,
            "relative_path": "bin/crebain-managed-simulation",
            "role": "executable",
            "sha256": sha256(binary_payload),
        },
    )
    inventory.sort(key=lambda row: row["relative_path"])
    package_sha256 = sha256(b"provider-free-synthetic-installed-package")
    target = {
        "target_id": "macos-aarch64-darwin",
        "operating_system": "macos",
        "architecture": "aarch64",
        "abi": "darwin",
    }
    package_lock = {
        "schema_version": "1.0",
        "extension_id": manifest["id"],
        "extension_version": manifest["version"],
        "target": target,
        "executable": {
            "catalog_id": "sepahead.crebain.simulation.runtime.v1",
            "inventory_path": "bin/crebain-managed-simulation",
            "sha256": sha256(binary_payload),
        },
        "contracts": contracts,
        "inventory": inventory,
        "package": {
            "byte_length": sum(row["byte_length"] for row in inventory),
            "file_count": len(inventory),
            "format": "directory-tree-v1",
            "inventory_sha256": sha256(canonical(inventory)),
            "package_sha256": package_sha256,
            "tree_digest_algorithm": "engram-extension-package-tree-v1",
        },
    }
    package_lock_bytes = canonical(package_lock) + b"\n"
    manifest["runtime"]["reviewed_package"] = {
        "lock_schema": "engram.extension-package-lock.v1",
        "target_id": target["target_id"],
        "lock_sha256": sha256(package_lock_bytes),
        "package_sha256": package_sha256,
        "executable_catalog_id": "sepahead.crebain.simulation.runtime.v1",
    }
    manifest_bytes = canonical(manifest) + b"\n"
    configuration_bytes = canonical(configuration) + b"\n"
    operations = manifest["runtime"]["operations"]
    operation_roster_sha256 = sha256(
        b"engram-managed-operation-roster-v1\0" + canonical(operations)
    )
    seal = {
        "schema_version": "engram.managed-extension-seal-receipt.v1",
        "installation_id": "inst_" + "1" * 64,
        "profile": "engram.reviewed-native-development.v1",
        "launch_abi": "engram.managed-runtime-stdio.v1",
        "operation_roster_sha256": operation_roster_sha256,
        "schema_registry_sha256": sha256(b"provider-free-schema-registry"),
        "target": target,
        "manifest": {
            "exact_sha256": sha256(manifest_bytes),
            "canonical_sha256": sha256(canonical(manifest)),
        },
        "package_lock": {
            "exact_sha256": sha256(package_lock_bytes),
            "canonical_sha256": sha256(canonical(package_lock)),
        },
        "configuration": {
            "exact_sha256": sha256(configuration_bytes),
            "canonical_sha256": sha256(canonical(configuration)),
        },
        "package": {
            "package_sha256": package_sha256,
            "executable_sha256": sha256(binary_payload),
        },
        "schemas": [
            {
                "schema_id": row["contract_id"],
                "package_relative_path": row["inventory_path"],
                "exact_sha256": row["sha256"],
                "canonical_sha256": sha256(
                    canonical(json.loads(contract_payloads[row["inventory_path"]]))
                ),
            }
            for row in contracts
        ],
        "authority": {
            "execution": False,
            "installation": False,
            "ncp": False,
            "physical": False,
            "readiness": False,
            "scientific": False,
        },
    }
    generation_core = {
        "store_policy": {"store_id": "extstore_" + "2" * 64},
        "publisher_authentication": {"authenticated": False},
        "extension": seal["extension"]
        if "extension" in seal
        else {
            "id": manifest["id"],
            "version": manifest["version"],
        },
        "runtime": {
            "installation_id": seal["installation_id"],
            "launch_abi": seal["launch_abi"],
            "operation_roster_sha256": seal["operation_roster_sha256"],
            "profile": seal["profile"],
            "schema_registry_sha256": seal["schema_registry_sha256"],
            "target": seal["target"],
        },
        "manifest": seal["manifest"],
        "package_lock": seal["package_lock"],
        "configuration": seal["configuration"],
        "package": seal["package"],
    }
    seal["extension"] = generation_core["extension"]
    generation_id = "pkggen_" + sha256(
        b"engram-component-package-generation-v1\0" + canonical(generation_core)
    )
    store = root / "store"
    generation = store / "generations" / generation_id[7:9] / generation_id
    binary = generation / "package" / "bin" / "crebain-managed-simulation"
    binary.parent.mkdir(parents=True, mode=0o700)
    for directory in (
        store,
        store / "generations",
        generation.parent,
        generation,
        generation / "package",
        binary.parent,
    ):
        os.chmod(directory, 0o700)
    binary.write_bytes(binary_payload)
    os.chmod(binary, 0o700)
    for relative, payload in contract_payloads.items():
        target = generation / "package" / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(target.parent, 0o700)
        target.write_bytes(payload)
        os.chmod(target, 0o600)

    bundle_receipt = {
        "schema_version": "engram.extension-package-bundle-receipt.v1",
        "generation_id": generation_id,
        **generation_core,
    }
    (generation / "manifest.json").write_bytes(manifest_bytes)
    (generation / "package-lock.json").write_bytes(package_lock_bytes)
    (generation / "configuration.json").write_bytes(configuration_bytes)
    bundle_bytes = canonical(bundle_receipt)
    (generation / "bundle-receipt.json").write_bytes(bundle_bytes)
    os.chmod(generation / "bundle-receipt.json", 0o600)
    for path in (
        generation / "manifest.json",
        generation / "package-lock.json",
        generation / "configuration.json",
    ):
        os.chmod(path, 0o600)
    observations = store / "observations"
    observations.mkdir(mode=0o700)
    write_json(
        observations / f"{generation_id}.json",
        {
            "schema_version": "engram.extension-package-install-observation.v1",
            "store_id": generation_core["store_policy"]["store_id"],
            "generation_id": generation_id,
            "bundle_receipt_sha256": sha256(bundle_bytes),
            "state": "published-verified",
            "authority": {
                "store_installation": True,
                "execution": False,
                "ncp": False,
                "physical": False,
                "scientific": False,
            },
        },
    )
    seal_path = root / "seal-receipt.json"
    seal_bytes = write_json(seal_path, seal)
    build = build_receipt(
        binary_payload,
        source_mode=stat.S_IMODE(BINARY.stat().st_mode),
    )
    build_path = root / "observed-build-receipt.json"
    build_path.write_bytes(provenance_canonical(build) + b"\n")
    os.chmod(build_path, 0o600)
    stage_inventory = [
        {
            "relative_path": row["relative_path"],
            "byte_length": row["byte_length"],
            "sha256": row["sha256"],
            "mode": stat.S_IMODE(row["mode"]),
            "role": row["role"],
        }
        for row in inventory
    ]
    stage = stage_receipt(
        build,
        stage_inventory,
        recipe_bytes=(INTEGRATION / "authoring.macos-aarch64-darwin.json").read_bytes(),
        configuration_bytes=configuration_bytes,
    )
    stage_path = root / "package-stage-receipt.json"
    stage_path.write_bytes(provenance_canonical(stage) + b"\n")
    os.chmod(stage_path, 0o600)
    pack = pack_receipt(
        build,
        stage,
        seal_bytes=seal_bytes,
        bundle_bytes=bundle_bytes,
        package_generation_id=generation_id,
    )
    pack_path = root / "engram-pack-receipt.json"
    pack_path.write_bytes(provenance_canonical(pack) + b"\n")
    os.chmod(pack_path, 0o600)
    return generation, seal_path, build_path, stage_path, pack_path


def invoke(
    generation: Path,
    seal: Path,
    build: Path,
    stage: Path,
    pack: Path,
    receipt: Path,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--generation-root",
            str(generation),
            "--seal-receipt",
            str(seal),
            "--build-receipt",
            str(build),
            "--stage-receipt",
            str(stage),
            "--pack-receipt",
            str(pack),
            "--write-receipt",
            str(receipt),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )


def load_checker() -> ModuleType:
    specification = importlib.util.spec_from_file_location(
        "crebain_installed_checker", SCRIPT
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("installed checker module cannot be loaded")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def main() -> None:
    if not BINARY.is_file() or not os.access(BINARY, os.X_OK):
        raise RuntimeError(
            "build the managed-simulation release binary before this gate"
        )
    checker = load_checker()
    for payload, expected in (
        (b'{"value":1,"value":2}', "duplicate member"),
        (b'{"value":NaN}', "non-finite number"),
        (b"\xff", "malformed"),
    ):
        try:
            checker.decode_object(payload, "hostile-test-frame")
        except RuntimeError as error:
            assert expected in str(error)
        else:
            raise AssertionError(f"strict decoder accepted {payload!r}")
    with tempfile.TemporaryDirectory(prefix="crebain-installed-v3-test-") as raw:
        root = Path(raw).resolve()
        generation, seal, build, stage, pack = make_candidate(root)
        receipt = root / "installed-proof.json"
        accepted = invoke(generation, seal, build, stage, pack, receipt)
        assert accepted.returncode == 0, accepted.stderr
        proof = json.loads(receipt.read_text())
        assert (
            proof["schema_version"] == "crebain.standard-v3-installed-binary-proof.v3"
        )
        assert proof["observed_build_receipt"] == json.loads(build.read_bytes())
        assert proof["package_stage_receipt"] == json.loads(stage.read_bytes())
        assert proof["engram_pack_receipt"] == json.loads(pack.read_bytes())
        assert proof["executable_format"] == "mach-o-64"
        assert proof["executable_architecture"] == "arm64"
        assert proof["build_stage_seal_install_lineage_verified"] is True
        assert proof["build_stage_seal_pack_install_lineage_verified"] is True
        assert proof["package_generation_id"] == generation.name
        reported_receipt = proof.pop("receipt_sha256")
        assert reported_receipt == sha256(canonical(proof))
        proof["receipt_sha256"] = reported_receipt
        assert proof["drone_counts"] == [1, 2, 3]
        assert proof["replay_exact"] is True
        assert proof["unaffected_lane_observations_exact"] is True
        assert proof["signal_cancellation_gate"] == (
            "active-SIGTERM-then-fresh-generation-prepared"
        )
        assert proof["installed_artifacts_reverified_after_execution"] is True

        replay = invoke(generation, seal, build, stage, pack, receipt)
        assert replay.returncode != 0 and "File exists" in replay.stderr

        observation = generation.parents[2] / "observations" / f"{generation.name}.json"
        observation_bytes = observation.read_bytes()
        changed_observation = json.loads(observation_bytes)
        changed_observation["state"] = "pending"
        write_json(observation, changed_observation)
        rejected_observation = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "changed-observation-proof.json",
        )
        assert rejected_observation.returncode != 0
        assert "store observation" in rejected_observation.stderr
        observation.write_bytes(observation_bytes)

        contract = generation / "package" / "contracts" / "configuration.schema.json"
        contract_bytes = contract.read_bytes()
        contract.write_bytes(contract_bytes + b" ")
        changed_contract = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "changed-contract-proof.json",
        )
        assert changed_contract.returncode != 0
        assert "package inventory differs" in changed_contract.stderr
        contract.write_bytes(contract_bytes)

        contracts_directory = generation / "package" / "contracts"
        saved_contracts = root / "saved-contracts"
        contracts_directory.rename(saved_contracts)
        contracts_directory.symlink_to(saved_contracts, target_is_directory=True)
        linked_contract_directory = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "linked-contract-directory-proof.json",
        )
        assert linked_contract_directory.returncode != 0
        assert "package directory" in linked_contract_directory.stderr
        contracts_directory.unlink()
        saved_contracts.rename(contracts_directory)

        linked_root = root / "linked-generation"
        linked_root.symlink_to(generation, target_is_directory=True)
        linked = invoke(
            linked_root,
            seal,
            build,
            stage,
            pack,
            root / "linked-proof.json",
        )
        assert linked.returncode != 0
        assert "owner-controlled directory" in linked.stderr

        original_manifest = generation / "manifest.json"
        saved_manifest = root / "manifest.json"
        original_manifest.rename(saved_manifest)
        original_manifest.symlink_to(saved_manifest)
        linked_manifest = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "linked-manifest-proof.json",
        )
        assert linked_manifest.returncode != 0
        assert "without following links" in linked_manifest.stderr

        original_manifest.unlink()
        original_manifest.write_bytes(
            b'{"schema_version":"2.0","schema_version":"2.0"}\n'
        )
        duplicate_manifest = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "duplicate-manifest-proof.json",
        )
        assert duplicate_manifest.returncode != 0
        assert "duplicate member" in duplicate_manifest.stderr

    with tempfile.TemporaryDirectory(prefix="crebain-installed-v3-format-test-") as raw:
        root = Path(raw).resolve()
        generation, seal, build, stage, pack = make_candidate(root)
        binary = generation / "package/bin/crebain-managed-simulation"
        original = binary.read_bytes()
        for label, payload, expected in (
            ("text", b"#!/bin/sh\n" + b"#" * 32, "not thin"),
            ("wrong-architecture", macho_arm64(cpu_type=0x01000007), "not arm64"),
            ("wrong-file-type", macho_arm64(file_type=6), "not executable"),
        ):
            binary.write_bytes(payload)
            binary.chmod(0o700)
            rejected = invoke(
                generation,
                seal,
                build,
                stage,
                pack,
                root / f"{label}-proof.json",
            )
            assert rejected.returncode != 0 and expected in rejected.stderr
            binary.write_bytes(original)
            binary.chmod(0o700)
        binary.chmod(0o600)
        no_execute = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "no-execute-proof.json",
        )
        assert (
            no_execute.returncode != 0 and "lacks owner executable" in no_execute.stderr
        )

    with tempfile.TemporaryDirectory(prefix="crebain-installed-v3-swap-test-") as raw:
        root = Path(raw).resolve()
        generation, seal, build, stage, pack = make_candidate(root)
        stage_document = json.loads(stage.read_bytes())
        stage_document["observed_build_receipt_exact_sha256"] = "f" * 64
        stage_material = {
            key: value
            for key, value in stage_document.items()
            if key != "receipt_sha256"
        }
        stage_document["receipt_sha256"] = sha256(canonical(stage_material))
        stage.write_bytes(canonical(stage_document) + b"\n")
        swapped = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "swapped-receipt-proof.json",
        )
        assert (
            swapped.returncode != 0
            and "build, Git, or target lineage" in swapped.stderr
        )

    with tempfile.TemporaryDirectory(prefix="crebain-installed-pack-bytes-") as raw:
        root = Path(raw).resolve()
        generation, seal, build, stage, pack = make_candidate(root)
        pack.write_bytes(b" " + pack.read_bytes())
        noncanonical = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "noncanonical-pack-proof.json",
        )
        assert noncanonical.returncode != 0
        assert "exact canonical JSON bytes" in noncanonical.stderr

    for field in (
        "observed_build_receipt_exact_sha256",
        "observed_build_receipt_sha256",
        "package_stage_receipt_exact_sha256",
        "package_stage_receipt_sha256",
        "seal_receipt_exact_sha256",
        "bundle_receipt_exact_sha256",
    ):
        with tempfile.TemporaryDirectory(
            prefix=f"crebain-installed-pack-{field}-"
        ) as raw:
            root = Path(raw).resolve()
            generation, seal, build, stage, pack = make_candidate(root)
            document = json.loads(pack.read_bytes())
            document[field] = "e" * 64
            reseal(document)
            pack.write_bytes(canonical(document) + b"\n")
            rejected = invoke(
                generation,
                seal,
                build,
                stage,
                pack,
                root / f"wrong-{field}.json",
            )
            assert rejected.returncode != 0
            assert "lineage differs" in rejected.stderr

    with tempfile.TemporaryDirectory(
        prefix="crebain-installed-pack-generation-"
    ) as raw:
        root = Path(raw).resolve()
        generation, seal, build, stage, pack = make_candidate(root)
        document = json.loads(pack.read_bytes())
        document["package_generation_id"] = "pkggen_" + "e" * 64
        reseal(document)
        pack.write_bytes(canonical(document) + b"\n")
        wrong_generation = invoke(
            generation,
            seal,
            build,
            stage,
            pack,
            root / "wrong-pack-generation.json",
        )
        assert wrong_generation.returncode != 0
        assert "lineage differs" in wrong_generation.stderr

    for label, mutate, expected in (
        (
            "forged-digest",
            lambda document: document.__setitem__("disclosure", "forged"),
            "canonical digest differs",
        ),
        (
            "authority-promotion",
            lambda document: document["authority"].__setitem__("execution", True),
            "grants authority",
        ),
        (
            "authentication-promotion",
            lambda document: document["claims"].__setitem__(
                "publisher_authenticated", True
            ),
            "claim boundary differs",
        ),
    ):
        with tempfile.TemporaryDirectory(
            prefix=f"crebain-installed-pack-{label}-"
        ) as raw:
            root = Path(raw).resolve()
            generation, seal, build, stage, pack = make_candidate(root)
            document = json.loads(pack.read_bytes())
            mutate(document)
            if label != "forged-digest":
                reseal(document)
            pack.write_bytes(canonical(document) + b"\n")
            rejected = invoke(
                generation,
                seal,
                build,
                stage,
                pack,
                root / f"{label}.json",
            )
            assert rejected.returncode != 0
            assert expected in rejected.stderr

    print(
        "OK: installed managed simulation gate replays 1/2/3 channels, "
        "cancellation, provenance, and hostile paths"
    )


if __name__ == "__main__":
    main()
