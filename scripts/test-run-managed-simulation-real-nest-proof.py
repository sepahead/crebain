#!/usr/bin/env python3
"""Provider-free controls for the immutable real-NEST proof runner."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import subprocess
import tempfile
import types
import unittest
from argparse import Namespace
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

from managed_simulation_build_provenance import canonical as provenance_canonical
from managed_simulation_test_fixtures import (
    build_receipt,
    closed_loop_store_fixture,
    installed_proof,
    macho_arm64,
    pack_receipt,
    real_nest_closed_loop_fixture,
    real_nest_validation_fixture,
    reviewed_runtime_fixture,
    stage_receipt,
)


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run-managed-simulation-real-nest-proof.py"


def load_proof_runner() -> ModuleType:
    specification = importlib.util.spec_from_file_location(
        "crebain_real_nest_proof_runner",
        SCRIPT,
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("real-NEST proof runner cannot be loaded")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


PROOF = load_proof_runner()


def write_source(root: Path, relative: Path, payload: bytes | None = None) -> Path:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload if payload is not None else relative.as_posix().encode())
    return target


def make_source_tree(root: Path) -> None:
    relative_paths = {
        Path(*name.split(".")).with_suffix(".py")
        for name in PROOF.REQUIRED_HOST_MODULES | PROOF.REQUIRED_WORKER_MODULES
    }
    relative_paths.add(Path("backend/core/units.py"))
    relative_paths.update(
        Path(relative) for _role, relative in PROOF.EXERCISED_ENTRYPOINTS
    )
    for relative in relative_paths:
        write_source(root, relative)


def make_host_modules(root: Path) -> dict[str, ModuleType]:
    modules: dict[str, ModuleType] = {}
    for name in sorted((*PROOF.REQUIRED_HOST_MODULES, "backend.core.units")):
        module = types.ModuleType(name)
        module.__file__ = str(root / Path(*name.split(".")).with_suffix(".py"))
        modules[name] = module
    return modules


def runtime_file_row(
    source_root: Path,
    runtime_root: Path,
    relative: Path,
    role: str,
) -> dict[str, Any]:
    payload = (source_root / relative).read_bytes()
    return {
        "role": role,
        "absolute_path": str(runtime_root / relative),
        "size_bytes": len(payload),
        "sha256": PROOF.sha256(payload),
    }


def make_worker_evidence(source_root: Path, runtime_root: Path) -> dict[str, Any]:
    project_rows = []
    for name in sorted(PROOF.REQUIRED_WORKER_MODULES):
        relative = Path(*name.split(".")).with_suffix(".py")
        project_rows.append(
            runtime_file_row(
                source_root,
                runtime_root,
                relative,
                f"project-module:{name}",
            )
        )
    worker_relative = Path("backend/optimization/extension_closed_loop_nest_worker.py")
    worker = runtime_file_row(
        source_root,
        runtime_root,
        worker_relative,
        "worker-source",
    )
    files = tuple((*project_rows, worker))
    project_digest = PROOF.sha256(PROOF.canonical(tuple(project_rows)))
    guardian = runtime_file_row(
        source_root,
        runtime_root,
        Path("backend/optimization/extension_closed_loop_nest_guardian.py"),
        "guardian-source",
    )
    adapter = next(
        row
        for row in project_rows
        if row["role"]
        == "project-module:backend.optimization.extension_closed_loop_nest_process"
    )
    return {
        "worker_runtime_identity": {
            "files": files,
            "file_roster_sha256": PROOF.sha256(PROOF.canonical(files)),
            "project_source_roster_sha256": project_digest,
            "project_source_closure_verified": True,
        },
        "runtime_launch_expectation": {
            "required_runtime_files": tuple((*project_rows, worker)),
            "guardian_source_file": guardian,
            "guardian_source_sha256": guardian["sha256"],
            "worker_source_sha256": worker["sha256"],
        },
        "worker_session_binding": {
            "worker_source_sha256": worker["sha256"],
            "guardian_source_sha256": guardian["sha256"],
            "adapter_source_sha256": adapter["sha256"],
            "worker_project_source_roster_sha256": project_digest,
        },
    }


def reseal_worker_identity(evidence: dict[str, Any]) -> None:
    identity = evidence["worker_runtime_identity"]
    files = tuple(identity["files"])
    project_rows = tuple(
        row for row in files if row["role"].startswith("project-module:")
    )
    identity["files"] = files
    identity["file_roster_sha256"] = PROOF.sha256(PROOF.canonical(files))
    identity["project_source_roster_sha256"] = PROOF.sha256(
        PROOF.canonical(project_rows)
    )
    evidence["worker_session_binding"]["worker_project_source_roster_sha256"] = (
        identity["project_source_roster_sha256"]
    )


class FakeModel:
    def __init__(self, document: dict[str, Any]) -> None:
        self.document = document

    def model_dump(self, *, mode: str) -> dict[str, Any]:
        if mode != "json":
            raise AssertionError("unexpected serialization mode")
        return json.loads(json.dumps(self.document))


class RealNestProofRunnerTests(unittest.TestCase):
    def test_model_document_normalizes_python_tuples_to_json_arrays(self) -> None:
        document = PROOF.model_document(FakeModel({"rows": ({"value": 1},)}))
        self.assertEqual(document, {"rows": [{"value": 1}]})

    def test_model_document_rejects_a_non_object(self) -> None:
        class NonObjectModel:
            def model_dump(self, *, mode: str) -> list[str]:
                self.assert_json_mode(mode)
                return ["not-an-object"]

            @staticmethod
            def assert_json_mode(mode: str) -> None:
                if mode != "json":
                    raise AssertionError("unexpected serialization mode")

        with self.assertRaisesRegex(RuntimeError, "one JSON object"):
            PROOF.model_document(NonObjectModel())

    def test_installed_proof_v3_build_stage_join_and_stale_controls(self) -> None:
        binary = macho_arm64()
        build = build_receipt(binary)
        inventory = [
            {
                "relative_path": "bin/crebain-managed-simulation",
                "byte_length": len(binary),
                "sha256": PROOF.sha256(binary),
                "mode": 0o700,
                "role": "executable",
            },
            {
                "relative_path": "contracts/example.schema.json",
                "byte_length": 3,
                "sha256": PROOF.sha256(b"{}\n"),
                "mode": 0o600,
                "role": "contract",
            },
        ]
        stage = stage_receipt(
            build,
            inventory,
            recipe_bytes=b"{}\n",
            configuration_bytes=b"{}\n",
        )
        pack = pack_receipt(
            build,
            stage,
            seal_bytes=b"synthetic seal bytes",
            bundle_bytes=b"synthetic bundle bytes",
            package_generation_id="pkggen_" + "8" * 64,
        )
        proof = installed_proof(build, stage, pack)

        def write(path: Path, document: dict[str, Any]) -> None:
            path.write_bytes(provenance_canonical(document) + b"\n")
            path.chmod(0o600)

        def reseal(document: dict[str, Any]) -> None:
            material = {
                key: value for key, value in document.items() if key != "receipt_sha256"
            }
            document["receipt_sha256"] = PROOF.sha256(provenance_canonical(material))

        with tempfile.TemporaryDirectory(prefix="crebain-installed-proof-v3-") as raw:
            root = Path(raw).resolve()
            path = root / "proof.json"
            write(path, proof)
            loaded, payload = PROOF.load_installed_proof(path)
            self.assertEqual(loaded, proof)
            self.assertEqual(payload, provenance_canonical(proof) + b"\n")

            path.write_bytes(b" " + provenance_canonical(proof) + b"\n")
            with self.assertRaisesRegex(RuntimeError, "exact canonical JSON"):
                PROOF.load_installed_proof(path)

            stale = copy.deepcopy(proof)
            stale["schema_version"] = "crebain.standard-v3-installed-binary-proof.v2"
            reseal(stale)
            write(path, stale)
            with self.assertRaisesRegex(RuntimeError, "proof schema differs"):
                PROOF.load_installed_proof(path)

            swapped = copy.deepcopy(proof)
            swapped_build = swapped["observed_build_receipt"]
            swapped_build["disclosure"] = "Different valid observed-build receipt."
            reseal(swapped_build)
            reseal(swapped)
            write(path, swapped)
            with self.assertRaisesRegex(RuntimeError, "package-stage build"):
                PROOF.load_installed_proof(path)

            toolchain = copy.deepcopy(proof)
            toolchain["observed_build_receipt"]["cargo"]["rust_toolchain"] = "stable"
            reseal(toolchain)
            write(path, toolchain)
            with self.assertRaisesRegex(RuntimeError, "Cargo toolchain"):
                PROOF.load_installed_proof(path)

            forged_pack = copy.deepcopy(proof)
            forged_pack["engram_pack_receipt"]["disclosure"] = "forged"
            reseal(forged_pack)
            write(path, forged_pack)
            with self.assertRaisesRegex(RuntimeError, "canonical digest differs"):
                PROOF.load_installed_proof(path)

            wrong_stage = copy.deepcopy(proof)
            wrong_stage["engram_pack_receipt"]["package_stage_receipt_exact_sha256"] = (
                "7" * 64
            )
            reseal(wrong_stage["engram_pack_receipt"])
            reseal(wrong_stage)
            write(path, wrong_stage)
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                PROOF.load_installed_proof(path)

            wrong_generation = copy.deepcopy(proof)
            wrong_generation["engram_pack_receipt"]["package_generation_id"] = (
                "pkggen_" + "7" * 64
            )
            reseal(wrong_generation["engram_pack_receipt"])
            reseal(wrong_generation)
            write(path, wrong_generation)
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                PROOF.load_installed_proof(path)

            promoted = copy.deepcopy(proof)
            promoted["engram_pack_receipt"]["authority"]["execution"] = True
            reseal(promoted["engram_pack_receipt"])
            reseal(promoted)
            write(path, promoted)
            with self.assertRaisesRegex(RuntimeError, "grants authority"):
                PROOF.load_installed_proof(path)

        repository = pack["engram_repository"]
        identity = {
            "repository": repository["origin"],
            "commit": repository["commit"],
            "tree": repository["tree"],
            "origin_main": repository["origin_main"],
            "object_format": repository["object_format"],
            "clean": True,
        }
        PROOF.verify_pack_source_lineage(proof, identity, [pack["engram_tool"]])

        other_commit = copy.deepcopy(proof)
        other_repository = other_commit["engram_pack_receipt"]["engram_repository"]
        other_repository["commit"] = "e" * 40
        other_repository["tree"] = "f" * 40
        other_repository["origin_main"] = "e" * 40
        other_commit["engram_commit"] = "e" * 40
        other_commit["engram_tree"] = "f" * 40
        other_commit["engram_origin_main"] = "e" * 40
        reseal(other_commit["engram_pack_receipt"])
        reseal(other_commit)
        PROOF.validate_pack_receipt(other_commit["engram_pack_receipt"])
        with self.assertRaisesRegex(RuntimeError, "immutable checkout"):
            PROOF.verify_pack_source_lineage(other_commit, identity)

        wrong_tool = copy.deepcopy(proof)
        wrong_tool["engram_pack_receipt"]["engram_tool"]["sha256"] = "9" * 64
        wrong_tool["engram_extension_tool_sha256"] = "9" * 64
        with self.assertRaisesRegex(RuntimeError, "loaded committed source"):
            PROOF.verify_pack_source_lineage(
                wrong_tool,
                identity,
                [pack["engram_tool"]],
            )

        wrong_blob = copy.deepcopy(proof)
        wrong_blob["engram_pack_receipt"]["engram_tool"]["git_blob"] = "9" * 40
        wrong_blob["engram_extension_tool_git_blob"] = "9" * 40
        with self.assertRaisesRegex(RuntimeError, "loaded committed source"):
            PROOF.verify_pack_source_lineage(
                wrong_blob,
                identity,
                [pack["engram_tool"]],
            )

    def test_receipt_lock_timeout_bounds_and_forwarding(self) -> None:
        for accepted in (1, PROOF.DEFAULT_RECEIPT_LOCK_TIMEOUT_MS, 300_000):
            self.assertEqual(PROOF.validate_receipt_lock_timeout(accepted), accepted)
        for rejected in (False, 0, 300_001, 1.0, "30000"):
            with self.assertRaisesRegex(RuntimeError, "receipt lock timeout"):
                PROOF.validate_receipt_lock_timeout(rejected)

        arguments = Namespace(
            receipt_lock_timeout_ms=48_271,
            identifier="pkggen_test",
            generation_ordinal=7,
            startup_timeout_ms=9_000,
            termination_grace_ms=700,
        )
        forwarded = PROOF.build_closed_loop_namespace(
            arguments,
            plan_path=Path("/private/plan.json"),
            config_path=Path("/private/config.json"),
            store_path=Path("/private/store"),
            receipt_store_path=Path("/private/receipts"),
        )
        self.assertEqual(forwarded.receipt_lock_timeout_ms, 48_271)
        self.assertEqual(forwarded.identifier, "pkggen_test")
        self.assertEqual(
            PROOF.build_parser()
            .parse_args(
                [
                    "--engram-root",
                    "/engram",
                    "--engram-commit",
                    "a" * 40,
                    "--store",
                    "/store",
                    "--receipt-store",
                    "/receipts",
                    "--identifier",
                    "pkg",
                    "--installed-proof",
                    "/installed-proof",
                    "--plan",
                    "/plan",
                    "--nest-config",
                    "/config",
                    "--capture",
                    "/capture",
                ]
            )
            .receipt_lock_timeout_ms,
            30_000,
        )

    def test_receipt_store_requires_one_fresh_private_canonical_child(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-fresh-receipt-store-") as raw:
            root = Path(raw).resolve()
            os.chmod(root, 0o700)
            fresh = root / "fresh-store"
            self.assertEqual(PROOF.fresh_receipt_store_path(fresh), fresh)

            fresh.mkdir(mode=0o700)
            with self.assertRaisesRegex(RuntimeError, "must not exist"):
                PROOF.fresh_receipt_store_path(fresh)
            fresh.rmdir()

            target = root / "target"
            target.mkdir(mode=0o700)
            linked_leaf = root / "linked-store"
            linked_leaf.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "must not exist"):
                PROOF.fresh_receipt_store_path(linked_leaf)

            linked_parent = root / "linked-parent"
            linked_parent.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "canonical directory"):
                PROOF.fresh_receipt_store_path(linked_parent / "store")

            os.chmod(root, 0o770)
            with self.assertRaisesRegex(RuntimeError, "owner-controlled"):
                PROOF.fresh_receipt_store_path(root / "unsafe-parent-store")
            os.chmod(root, 0o700)

    def test_strict_json_positive_and_hostile_controls(self) -> None:
        self.assertEqual(PROOF.decode_json_object(b'{"ok":true}', "test"), {"ok": True})
        for payload, expected in (
            (b'{"a":1,"a":2}', "duplicate JSON member"),
            (b'{"a":NaN}', "non-finite JSON number"),
            (b"[]", "one JSON object"),
            (b"\xff", "strict UTF-8 JSON"),
        ):
            with self.assertRaisesRegex(RuntimeError, expected):
                PROOF.decode_json_object(payload, "test")

    def test_host_source_closure_includes_transitive_modules(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-host-source-positive-") as raw:
            root = Path(raw).resolve()
            make_source_tree(root)
            records = PROOF.collect_loaded_engram_sources(
                root,
                make_host_modules(root),
            )
            names = [record["module_name"] for record in records]
            self.assertEqual(names, sorted(names))
            self.assertTrue(PROOF.REQUIRED_HOST_MODULES.issubset(names))
            self.assertIn("backend.core.units", names)
            entrypoints = PROOF.collect_entrypoint_sources(root)
            self.assertEqual(
                {record["role"] for record in entrypoints},
                {role for role, _relative in PROOF.EXERCISED_ENTRYPOINTS},
            )

    def test_host_source_closure_rejects_missing_and_aliased_modules(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-host-source-negative-") as raw:
            root = Path(raw).resolve()
            make_source_tree(root)
            modules = make_host_modules(root)
            modules.pop("backend.integrations.extension_package_store")
            with self.assertRaisesRegex(RuntimeError, "exact module roster"):
                PROOF.collect_loaded_engram_sources(root, modules)

            modules = make_host_modules(root)
            aliased = modules["backend.integrations.extension_package_store"]
            aliased.__file__ = str(root / "backend/integrations/other.py")
            write_source(root, Path("backend/integrations/other.py"))
            with self.assertRaisesRegex(RuntimeError, "canonical module path"):
                PROOF.collect_loaded_engram_sources(root, modules)

    def test_worker_frozen_source_closure_and_guardian_join(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="crebain-worker-source-positive-"
        ) as raw:
            root = Path(raw).resolve()
            runtime_root = root.parent / f"{root.name}-frozen-runtime"
            make_source_tree(root)
            evidence = make_worker_evidence(root, runtime_root)
            records = PROOF.collect_worker_sources(root, evidence)
            names = {
                record["module_name"] for record in records if "module_name" in record
            }
            self.assertTrue(PROOF.REQUIRED_WORKER_MODULES.issubset(names))
            self.assertIn("backend.core.units", names)
            self.assertIn(
                "nest-guardian-entrypoint",
                {record["role"] for record in records},
            )

    def test_worker_source_closure_rejects_hostile_mutations(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="crebain-worker-source-negative-"
        ) as raw:
            root = Path(raw).resolve()
            runtime_root = root.parent / f"{root.name}-frozen-runtime"
            make_source_tree(root)
            baseline = make_worker_evidence(root, runtime_root)

            unverified = copy.deepcopy(baseline)
            unverified["worker_runtime_identity"]["project_source_closure_verified"] = (
                False
            )
            with self.assertRaisesRegex(RuntimeError, "closure is not verified"):
                PROOF.collect_worker_sources(root, unverified)

            changed = copy.deepcopy(baseline)
            target_role = "project-module:backend.integrations.managed_runtime_contract"
            target = next(
                row
                for row in changed["worker_runtime_identity"]["files"]
                if row["role"] == target_role
            )
            target["sha256"] = "f" * 64
            required = next(
                row
                for row in changed["runtime_launch_expectation"][
                    "required_runtime_files"
                ]
                if row["role"] == target_role
            )
            required["sha256"] = "f" * 64
            reseal_worker_identity(changed)
            with self.assertRaisesRegex(RuntimeError, "runtime identity"):
                PROOF.collect_worker_sources(root, changed)

            escaped = copy.deepcopy(baseline)
            escaped_target = next(
                row
                for row in escaped["worker_runtime_identity"]["files"]
                if row["role"] == target_role
            )
            escaped_target["absolute_path"] = str(
                runtime_root / "escape" / "managed_runtime_contract.py"
            )
            escaped_required = next(
                row
                for row in escaped["runtime_launch_expectation"][
                    "required_runtime_files"
                ]
                if row["role"] == target_role
            )
            escaped_required["absolute_path"] = escaped_target["absolute_path"]
            reseal_worker_identity(escaped)
            with self.assertRaisesRegex(RuntimeError, "runtime source root"):
                PROOF.collect_worker_sources(root, escaped)

            incomplete = copy.deepcopy(baseline)
            missing_role = (
                "project-module:backend.optimization.extension_closed_loop_limits"
            )
            incomplete["worker_runtime_identity"]["files"] = tuple(
                row
                for row in incomplete["worker_runtime_identity"]["files"]
                if row["role"] != missing_role
            )
            incomplete["runtime_launch_expectation"]["required_runtime_files"] = tuple(
                row
                for row in incomplete["runtime_launch_expectation"][
                    "required_runtime_files"
                ]
                if row["role"] != missing_role
            )
            reseal_worker_identity(incomplete)
            with self.assertRaisesRegex(RuntimeError, "source closure is incomplete"):
                PROOF.collect_worker_sources(root, incomplete)

            guardian_drift = copy.deepcopy(baseline)
            guardian_drift["runtime_launch_expectation"]["guardian_source_sha256"] = (
                "e" * 64
            )
            with self.assertRaisesRegex(RuntimeError, "launch expectation"):
                PROOF.collect_worker_sources(root, guardian_drift)

    def test_source_inventory_detects_mutation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-source-inventory-") as raw:
            root = Path(raw).resolve()
            source = write_source(root, Path("backend/example.py"), b"before")
            inventory = PROOF.merge_source_inventory(
                [
                    PROOF.source_record(
                        root,
                        PROOF.safe_source_relative("backend/example.py"),
                        role="test",
                    )
                ]
            )
            PROOF.verify_source_inventory(root, inventory)
            source.write_bytes(b"after!")
            with self.assertRaisesRegex(RuntimeError, "changed during capture"):
                PROOF.verify_source_inventory(root, inventory)

    def test_reviewed_guardian_lifecycle_join(self) -> None:
        installed = {
            "store_id": "extstore_" + "2" * 64,
            "package_generation_id": "pkggen_" + "3" * 64,
            "installation_id": "inst_" + "4" * 64,
            "executable_sha256": "5" * 64,
            "observed_build_receipt": {
                "cargo": {"target": {"target_id": "macos-aarch64-darwin"}}
            },
        }
        guardian = {"sha256": "1" * 64}
        exec_gate = {"sha256": "6" * 64}
        python_executable_sha256 = "7" * 64
        reviewed, lifecycle = reviewed_runtime_fixture(
            installed=installed,
            guardian_source_sha256=guardian["sha256"],
            exec_gate_source_sha256=exec_gate["sha256"],
            python_executable_sha256=python_executable_sha256,
        )
        terminal = {"runtime_lifecycle": lifecycle}
        session = SimpleNamespace(
            exec_gate_command_binding=FakeModel(reviewed["exec_gate_command_binding"]),
            handshake_receipt=FakeModel(reviewed["handshake_receipt"]),
            termination_receipt=FakeModel(reviewed["termination_receipt"]),
        )
        self.assertEqual(
            PROOF.reviewed_runtime_lineage(
                session,
                terminal,
                guardian,
                exec_gate,
                python_executable_sha256,
                installed,
            ),
            reviewed,
        )
        hostile = copy.deepcopy(terminal)
        hostile["runtime_lifecycle"]["termination_receipt_sha256"] = "4" * 64
        hostile["runtime_lifecycle"]["binding_sha256"] = PROOF.sha256(
            PROOF.managed_runtime_canonical(
                {
                    key: value
                    for key, value in hostile["runtime_lifecycle"].items()
                    if key != "binding_sha256"
                }
            )
        )
        with self.assertRaisesRegex(RuntimeError, "source lineage"):
            PROOF.reviewed_runtime_lineage(
                session,
                hostile,
                guardian,
                exec_gate,
                python_executable_sha256,
                installed,
            )

        missing_command_field = copy.deepcopy(reviewed["exec_gate_command_binding"])
        missing_command_field.pop("argument_shape")
        with self.assertRaisesRegex(RuntimeError, "field roster differs"):
            PROOF.assert_reviewed_runtime_closure(
                missing_command_field,
                reviewed["handshake_receipt"],
                reviewed["termination_receipt"],
                lifecycle,
                guardian["sha256"],
                exec_gate["sha256"],
                python_executable_sha256,
                installed,
            )
        extra_authority_field = copy.deepcopy(reviewed["handshake_receipt"])
        extra_authority_field["execution_authority"] = False
        with self.assertRaisesRegex(RuntimeError, "field roster differs"):
            PROOF.assert_reviewed_runtime_closure(
                reviewed["exec_gate_command_binding"],
                extra_authority_field,
                reviewed["termination_receipt"],
                lifecycle,
                guardian["sha256"],
                exec_gate["sha256"],
                python_executable_sha256,
                installed,
            )

    def test_exact_six_n_population_topology_and_hostile_controls(self) -> None:
        input_root = (
            ROOT
            / "integrations/engram/managed-simulation/operational-inputs"
            / "real-nest-3.9-v1"
        )
        captures: dict[int, dict[str, Any]] = {}
        config = json.loads((input_root / "nest-config.json").read_text())
        for count in (1, 2, 3):
            suffix = "drone" if count == 1 else "drones"
            plan = json.loads(
                (input_root / f"run-plan-{count}-{suffix}.json").read_text()
            )
            evidence, neural_steps = real_nest_validation_fixture(plan, config)
            capture = {
                "run_plan": plan,
                "nest_config": config,
                "nest_evidence_bundle": evidence,
                "neural_steps": neural_steps,
            }
            captures[count] = capture
            topology = PROOF.assert_population_topology(
                capture["run_plan"],
                capture["nest_config"],
                capture["nest_evidence_bundle"],
                capture["neural_steps"],
            )
            self.assertEqual(topology["session_count"], 1)
            self.assertEqual(topology["drone_count"], count)
            self.assertEqual(topology["population_count"], 6 * count)
            self.assertEqual(topology["population_neuron_count"], 48 * count)
            self.assertEqual(topology["device_node_count"], 12 * count)
            self.assertEqual(topology["connection_count"], 96 * count)

        capture = captures[3]

        reordered_prefix_plan = copy.deepcopy(captures[2]["run_plan"])
        reordered_prefix_plan["channels"][0]["neural_population_prefix"] = (
            "zeta.channel"
        )
        reordered_prefix_plan["channels"][1]["neural_population_prefix"] = (
            "alpha.channel"
        )
        reordered_evidence, reordered_steps = real_nest_validation_fixture(
            reordered_prefix_plan,
            config,
        )
        reordered_topology = PROOF.assert_population_topology(
            reordered_prefix_plan,
            config,
            reordered_evidence,
            reordered_steps,
        )
        self.assertTrue(reordered_topology["population_names"][0].startswith("alpha."))
        self.assertTrue(
            reordered_evidence["nest_session_readback"]["population_roster"][0][
                "population_names"
            ][0].startswith("zeta.")
        )
        self.assertTrue(
            reordered_steps[0]["result"]["proposals"][0]["source_populations"][
                0
            ].startswith("zeta.")
        )

        hostile_cases = []
        second_session = copy.deepcopy(capture)
        second_session["nest_evidence_bundle"]["nest_session_readback"][
            "one_session"
        ] = False
        hostile_cases.append((second_session, "exactly one session"))
        missing_population = copy.deepcopy(capture)
        missing_population["nest_evidence_bundle"]["nest_session_readback"][
            "connection_readbacks"
        ].pop()
        hostile_cases.append((missing_population, "connection topology"))
        wrong_population_channel = copy.deepcopy(capture)
        wrong_population_session = wrong_population_channel["nest_evidence_bundle"][
            "nest_session_readback"
        ]
        wrong_population_session["population_roster"][0]["channel_id"] = (
            "hostile-channel"
        )
        wrong_population_session["population_roster_sha256"] = PROOF.sha256(
            PROOF.canonical(wrong_population_session["population_roster"])
        )
        hostile_cases.append((wrong_population_channel, "population roster differs"))
        wrong_population_digest = copy.deepcopy(capture)
        wrong_population_digest["nest_evidence_bundle"]["nest_session_readback"][
            "population_roster_sha256"
        ] = "0" * 64
        hostile_cases.append((wrong_population_digest, "population roster digest"))
        wrong_count = copy.deepcopy(capture)
        wrong_count["nest_evidence_bundle"]["nest_session_readback"][
            "observed_population_neuron_count"
        ] = 143
        hostile_cases.append((wrong_count, "node or connection totals"))
        wrong_step_roster = copy.deepcopy(capture)
        wrong_step_roster["nest_evidence_bundle"]["step_execution_receipts"][0][
            "completed_window_readbacks"
        ][0]["population_name"] = "hostile.population"
        hostile_cases.append((wrong_step_roster, "completed window roster"))
        wrong_proposal = copy.deepcopy(capture)
        wrong_proposal["neural_steps"][0]["result"]["proposals"][0][
            "source_populations"
        ].pop()
        hostile_cases.append((wrong_proposal, "proposal population roster"))
        malformed_axis = copy.deepcopy(capture)
        malformed_axis["nest_evidence_bundle"]["step_execution_receipts"][0][
            "encoded_control_inputs"
        ][0] = None
        hostile_cases.append((malformed_axis, "encoded control axis roster"))
        for hostile, expected in hostile_cases:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(RuntimeError, expected):
                    PROOF.assert_population_topology(
                        hostile["run_plan"],
                        hostile["nest_config"],
                        hostile["nest_evidence_bundle"],
                        hostile["neural_steps"],
                    )

    def test_worker_guardian_and_receipt_store_closure(self) -> None:
        input_root = (
            ROOT
            / "integrations/engram/managed-simulation/operational-inputs"
            / "real-nest-3.9-v1"
        )
        plan = json.loads((input_root / "run-plan-1-drone.json").read_text())
        config = json.loads((input_root / "nest-config.json").read_text())
        runtime_installed = {
            "store_id": "extstore_" + "2" * 64,
            "package_generation_id": "pkggen_" + "4" * 64,
            "installation_id": "inst_" + "5" * 64,
            "executable_sha256": "6" * 64,
            "observed_build_receipt": {
                "cargo": {"target": {"target_id": "macos-aarch64-darwin"}}
            },
        }
        reviewed, runtime_lifecycle = reviewed_runtime_fixture(
            installed=runtime_installed,
            guardian_source_sha256="7" * 64,
            exec_gate_source_sha256="8" * 64,
            python_executable_sha256="9" * 64,
        )
        terminal, evidence, neural_steps = real_nest_closed_loop_fixture(
            plan,
            config,
            runtime_lifecycle=runtime_lifecycle,
        )
        PROOF.assert_nest_evidence_closure(terminal, evidence, expected_step_count=6)
        PROOF.assert_neural_steps_closure(
            plan,
            terminal,
            evidence,
            neural_steps,
            expected_step_count=6,
        )
        observation_zero = neural_steps[0]["request"]["channels"][0][
            "observation_values"
        ][0]
        proposal_zero = neural_steps[0]["result"]["proposals"][0]["values"][0]
        self.assertIs(type(observation_zero), float)
        self.assertIs(type(proposal_zero), float)
        self.assertIn(
            b'"observation_values":[0.0',
            PROOF.managed_runtime_canonical(neural_steps[0]["request"]),
        )
        missing_evidence_field = copy.deepcopy(evidence)
        missing_evidence_field.pop("profile")
        with self.assertRaisesRegex(RuntimeError, "field roster differs"):
            PROOF.assert_nest_evidence_closure(
                terminal,
                missing_evidence_field,
                expected_step_count=6,
            )
        extra_terminal_field = copy.deepcopy(terminal)
        extra_terminal_field["authority"] = False
        with self.assertRaisesRegex(RuntimeError, "field roster differs"):
            PROOF.assert_nest_evidence_closure(
                extra_terminal_field,
                evidence,
                expected_step_count=6,
            )
        missing_neural_field = copy.deepcopy(neural_steps)
        missing_neural_field[0]["request"].pop("source_snapshot_sha256")
        with self.assertRaisesRegex(RuntimeError, "field roster differs"):
            PROOF.assert_neural_steps_closure(
                plan,
                terminal,
                evidence,
                missing_neural_field,
                expected_step_count=6,
            )
        authority_like_neural_field = copy.deepcopy(neural_steps)
        authority_like_neural_field[0]["result"]["scientific_authority"] = False
        with self.assertRaisesRegex(RuntimeError, "field roster differs"):
            PROOF.assert_neural_steps_closure(
                plan,
                terminal,
                evidence,
                authority_like_neural_field,
                expected_step_count=6,
            )
        integer_zero_steps = copy.deepcopy(neural_steps)
        integer_zero_terminal = copy.deepcopy(terminal)
        integer_zero_request = integer_zero_steps[0]["request"]
        integer_zero_request["channels"][0]["observation_values"][0] = 0
        integer_zero_request["request_sha256"] = PROOF.sha256(
            PROOF.managed_runtime_canonical(
                {
                    key: value
                    for key, value in integer_zero_request.items()
                    if key != "request_sha256"
                }
            )
        )
        integer_zero_result = integer_zero_steps[0]["result"]
        integer_zero_result["request_sha256"] = integer_zero_request["request_sha256"]
        integer_zero_result["result_sha256"] = PROOF.sha256(
            PROOF.managed_runtime_canonical(
                {
                    key: value
                    for key, value in integer_zero_result.items()
                    if key != "result_sha256"
                }
            )
        )
        for binding in (
            integer_zero_terminal["steps"][0],
            integer_zero_terminal["neural_executions"][0],
        ):
            binding["neural_request_sha256"] = integer_zero_request["request_sha256"]
            binding["neural_result_sha256"] = integer_zero_result["result_sha256"]
        with self.assertRaisesRegex(RuntimeError, "non-float JSON value"):
            PROOF.assert_neural_steps_closure(
                plan,
                integer_zero_terminal,
                evidence,
                integer_zero_steps,
                expected_step_count=6,
            )
        closure = PROOF.assert_worker_guardian_closure(evidence)
        self.assertTrue(closure["child_reaped"])
        self.assertEqual(closure["termination_attempt_count"], 1)
        hostile = copy.deepcopy(evidence)
        hostile["worker_terminal_disposition"] = "unknown"
        with self.assertRaisesRegex(RuntimeError, "lifecycle is incomplete"):
            PROOF.assert_worker_guardian_closure(hostile)
        identity_drift = copy.deepcopy(evidence)
        lifecycle = identity_drift["worker_lifecycle_receipt"]
        lifecycle["runtime_identity_receipt_sha256"] = "4" * 64
        lifecycle["receipt_sha256"] = PROOF.sha256(
            PROOF.canonical(
                {
                    key: value
                    for key, value in lifecycle.items()
                    if key != "receipt_sha256"
                }
            )
        )
        with self.assertRaisesRegex(RuntimeError, "terminal closure differs"):
            PROOF.assert_worker_guardian_closure(identity_drift)

        with tempfile.TemporaryDirectory(prefix="crebain-receipt-store-") as raw:
            root = Path(raw).resolve()
            os.chmod(root, 0o700)
            store_id = "clrs_" + "3" * 64
            handshake = reviewed["handshake_receipt"]
            expected_closure, expected_sidecars, material = closed_loop_store_fixture(
                terminal=terminal,
                evidence=evidence,
                run_plan=plan,
                nest_config=config,
                package_generation_id=runtime_installed["package_generation_id"],
                reviewed_handshake=handshake,
                store_id=store_id,
            )
            for relative_path, payload in material.items():
                path = root / relative_path
                path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                path.write_bytes(payload)
                os.chmod(path, 0o600)
            store_closure, sidecars = PROOF.collect_receipt_store_material(
                root,
                store_id=store_id,
                receipt_document=terminal,
                evidence_document=evidence,
            )
            self.assertEqual(store_closure, expected_closure)
            self.assertEqual(sidecars, expected_sidecars)
            PROOF.assert_receipt_store_sidecars(
                sidecars,
                store_id=store_id,
                receipt_document=terminal,
                evidence_document=evidence,
                run_plan_document=plan,
                nest_config_document=config,
                package_generation_id=runtime_installed["package_generation_id"],
                reviewed_handshake=handshake,
            )
            summary = {
                "authority": False,
                "calibrated_posterior": False,
                "channel_count": 1,
                "completed_step_count": 6,
                "evidence_bundle_sha256": evidence["bundle_sha256"],
                "ncp_qualified": False,
                "physical_actuation": False,
                "planned_step_count": 6,
                "receipt_sha256": terminal["receipt_sha256"],
                "reservation_id": sidecars["finalized_reservation"]["reservation"][
                    "reservation_id"
                ],
                "run_status": "completed",
                "scientific_authority": False,
                "simulator_only": True,
                "status": "recorded",
                "store_id": store_id,
                "study_run_id": terminal["study_run_id"],
                "terminal_reason_code": terminal["terminal_reason_code"],
            }
            PROOF.assert_run_summary(
                summary,
                channel_count=1,
                store_id=store_id,
                reservation_id=summary["reservation_id"],
                receipt_document=terminal,
                evidence_document=evidence,
            )
            hostile_summary = {**summary, "authority": True}
            with self.assertRaisesRegex(RuntimeError, "authority"):
                PROOF.assert_run_summary(
                    hostile_summary,
                    channel_count=1,
                    store_id=store_id,
                    reservation_id=summary["reservation_id"],
                    receipt_document=terminal,
                    evidence_document=evidence,
                )
            self.assertEqual(
                PROOF.receipt_store_identity(SimpleNamespace(store_id=store_id)),
                store_id,
            )
            semantic_store = SimpleNamespace(
                store_id=store_id,
                open=lambda _digest: FakeModel(terminal),
                open_evidence=lambda _digest: FakeModel(evidence),
            )
            PROOF.assert_receipt_store_reopen(
                semantic_store,
                store_id=store_id,
                receipt_sha256=terminal["receipt_sha256"],
                receipt_document=terminal,
                evidence_document=evidence,
            )
            hostile_store = SimpleNamespace(
                store_id=store_id,
                open=lambda _digest: FakeModel(terminal),
                open_evidence=lambda _digest: FakeModel(terminal),
            )
            with self.assertRaisesRegex(RuntimeError, "semantic reopen differs"):
                PROOF.assert_receipt_store_reopen(
                    hostile_store,
                    store_id=store_id,
                    receipt_sha256=terminal["receipt_sha256"],
                    receipt_document=terminal,
                    evidence_document=evidence,
                )
            duplicate = root / "evidence/duplicate.json"
            duplicate.write_bytes(
                PROOF.managed_runtime_canonical(
                    {
                        key: value
                        for key, value in terminal.items()
                        if key != "receipt_sha256"
                    }
                )
            )
            os.chmod(duplicate, 0o600)
            with self.assertRaisesRegex(RuntimeError, "exact eight-file"):
                PROOF.collect_receipt_store_closure(
                    root,
                    store_id=store_id,
                    receipt_document=terminal,
                    evidence_document=evidence,
                )
            duplicate.unlink()
            (root / "store.json").write_bytes(b"{ }")
            with self.assertRaisesRegex(RuntimeError, "not canonical"):
                PROOF.collect_receipt_store_closure(
                    root,
                    store_id=store_id,
                    receipt_document=terminal,
                    evidence_document=evidence,
                )
            (root / "store.json").write_bytes(material["store.json"])
            forged_receipt = {**terminal, "receipt_sha256": "0" * 64}
            with self.assertRaisesRegex(RuntimeError, "artifact digests differ"):
                PROOF.collect_receipt_store_closure(
                    root,
                    store_id=store_id,
                    receipt_document=forged_receipt,
                    evidence_document=evidence,
                )
            linked = root / "evidence/linked.json"
            linked.symlink_to(root / expected_closure["evidence_artifact_path"])
            with self.assertRaisesRegex(RuntimeError, "link or unbounded"):
                PROOF.collect_receipt_store_closure(
                    root,
                    store_id=store_id,
                    receipt_document=terminal,
                    evidence_document=evidence,
                )
            hostile_sidecars = copy.deepcopy(sidecars)
            hostile_sidecars["observation"]["execution_authority"] = True
            hostile_sidecars["observation"]["record_sha256"] = PROOF.sha256(
                PROOF.managed_runtime_canonical(
                    {
                        key: value
                        for key, value in hostile_sidecars["observation"].items()
                        if key != "record_sha256"
                    }
                )
            )
            hostile_sidecars["closure_sha256"] = PROOF.sha256(
                PROOF.canonical(
                    {
                        key: value
                        for key, value in hostile_sidecars.items()
                        if key != "closure_sha256"
                    }
                )
            )
            with self.assertRaisesRegex(RuntimeError, "non-simulator authority"):
                PROOF.assert_receipt_store_sidecars(
                    hostile_sidecars,
                    store_id=store_id,
                    receipt_document=terminal,
                    evidence_document=evidence,
                )

    def test_immutable_git_binding_positive_and_dirty_controls(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-git-binding-") as raw:
            repository = Path(raw).resolve()
            self.run_git(repository, "init")
            self.run_git(repository, "config", "user.name", "CREBAIN Test")
            self.run_git(repository, "config", "user.email", "test@crebain.invalid")
            self.run_git(
                repository,
                "remote",
                "add",
                "origin",
                "git@example.invalid:engram.git",
            )
            source = write_source(repository, Path("backend/source.py"), b"committed\n")
            self.run_git(repository, "add", "backend/source.py")
            self.run_git(repository, "commit", "-m", "fixture")
            commit = self.git_text(repository, "rev-parse", "HEAD")
            self.run_git(
                repository,
                "update-ref",
                "refs/remotes/origin/main",
                commit,
            )

            identity = PROOF.verify_immutable_engram_checkout(repository, commit)
            self.assertEqual(identity["commit"], commit)
            self.assertEqual(identity["repository"], "git@example.invalid:engram.git")
            record = PROOF.source_record(
                repository,
                PROOF.safe_source_relative("backend/source.py"),
                role="test",
            )
            bound = PROOF.bind_git_source_objects(repository, commit, [record])
            self.assertEqual(bound[0]["sha256"], PROOF.sha256(b"committed\n"))
            self.assertTrue(bound[0]["git_blob"])

            with self.assertRaisesRegex(RuntimeError, "lowercase Git object ID"):
                PROOF.verify_immutable_engram_checkout(repository, "a" * 41)
            with self.assertRaisesRegex(RuntimeError, "required commit"):
                PROOF.verify_immutable_engram_checkout(repository, "a" * 40)

            redirected = repository / "redirected-worktree"
            redirected.mkdir()
            self.run_git(
                repository,
                "config",
                "core.worktree",
                str(redirected),
            )
            with self.assertRaisesRegex(
                RuntimeError,
                "Git worktree identity|Git verification failed",
            ):
                PROOF.verify_immutable_engram_checkout(repository, commit)
            self.run_git(repository, "config", "--unset", "core.worktree")
            redirected.rmdir()

            self.run_git(
                repository,
                "update-index",
                "--assume-unchanged",
                "backend/source.py",
            )
            with self.assertRaisesRegex(RuntimeError, "non-normal file flags"):
                PROOF.verify_immutable_engram_checkout(repository, commit)
            self.run_git(
                repository,
                "update-index",
                "--no-assume-unchanged",
                "backend/source.py",
            )
            self.run_git(
                repository,
                "update-index",
                "--skip-worktree",
                "backend/source.py",
            )
            with self.assertRaisesRegex(RuntimeError, "non-normal file flags"):
                PROOF.verify_immutable_engram_checkout(repository, commit)
            self.run_git(
                repository,
                "update-index",
                "--no-skip-worktree",
                "backend/source.py",
            )

            untracked = write_source(repository, Path("backend/untracked.py"), b"new\n")
            with self.assertRaisesRegex(RuntimeError, "not clean"):
                PROOF.verify_immutable_engram_checkout(repository, commit)
            untracked.unlink()
            source.write_bytes(b"modified\n")
            with self.assertRaisesRegex(RuntimeError, "not clean"):
                PROOF.verify_immutable_engram_checkout(repository, commit)
            source.write_bytes(b"committed\n")

            untracked = write_source(repository, Path("backend/untracked.py"), b"new\n")
            untracked_record = PROOF.source_record(
                repository,
                PROOF.safe_source_relative("backend/untracked.py"),
                role="test",
            )
            with self.assertRaisesRegex(RuntimeError, "untracked or missing Git paths"):
                PROOF.bind_git_source_objects(
                    repository,
                    commit,
                    [untracked_record],
                )

    @staticmethod
    def run_git(repository: Path, *arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=repository,
            check=True,
            capture_output=True,
            timeout=10,
        )

    @staticmethod
    def git_text(repository: Path, *arguments: str) -> str:
        return subprocess.run(
            ["git", *arguments],
            cwd=repository,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()


if __name__ == "__main__":
    unittest.main(verbosity=2)
