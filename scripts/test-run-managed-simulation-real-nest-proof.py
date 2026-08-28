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
    installed_proof,
    macho_arm64,
    pack_receipt,
    real_nest_validation_fixture,
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
    for name in sorted((*PROOF.REQUIRED_WORKER_MODULES, "backend.core.units")):
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
        if mode != "python":
            raise AssertionError("unexpected serialization mode")
        return copy.deepcopy(self.document)


class RealNestProofRunnerTests(unittest.TestCase):
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
            with self.assertRaisesRegex(RuntimeError, "missing required modules"):
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
        guardian = {"sha256": "1" * 64}
        handshake = {
            "guardian_source_sha256": guardian["sha256"],
            "launch_source": "package-store-lease",
            "store_id": "extstore_" + "2" * 64,
            "package_generation_id": "pkggen_" + "3" * 64,
        }
        handshake["receipt_sha256"] = PROOF.sha256(PROOF.canonical(handshake))
        termination = {
            "handshake_receipt_sha256": handshake["receipt_sha256"],
            "child_reaped": True,
            "containment_empty": True,
            "diagnostic_stream_complete": True,
            "private_work_directory_removed": True,
            "package_generation_lease_released": True,
        }
        termination["receipt_sha256"] = PROOF.sha256(PROOF.canonical(termination))
        lifecycle = {
            "handshake_receipt_sha256": handshake["receipt_sha256"],
            "termination_receipt_sha256": termination["receipt_sha256"],
            "launch_source": "package-store-lease",
            "store_id": handshake["store_id"],
            "package_generation_id": handshake["package_generation_id"],
            "package_generation_lease_retained_at_launch": True,
            "package_generation_lease_released": True,
            "child_reaped": True,
            "containment_empty": True,
            "diagnostic_stream_complete": True,
            "private_work_directory_removed": True,
            "termination_disposition": "clean-exit",
            "durable_process_launch_authority": False,
            "ncp_authority": False,
            "physical_authority": False,
            "scientific_authority": False,
        }
        lifecycle["binding_sha256"] = PROOF.sha256(PROOF.canonical(lifecycle))
        terminal = {
            "runtime_lifecycle": lifecycle,
        }
        installed = {
            "store_id": handshake["store_id"],
            "package_generation_id": handshake["package_generation_id"],
        }
        session = SimpleNamespace(
            handshake_receipt=FakeModel(handshake),
            termination_receipt=FakeModel(termination),
        )
        self.assertEqual(
            PROOF.reviewed_runtime_lineage(session, terminal, guardian, installed),
            {
                "handshake_receipt": handshake,
                "termination_receipt": termination,
                "lifecycle_binding_sha256": lifecycle["binding_sha256"],
                "guardian_closure_verified": True,
                "package_store_lineage_verified": True,
            },
        )
        hostile = copy.deepcopy(terminal)
        hostile["runtime_lifecycle"]["termination_receipt_sha256"] = "4" * 64
        hostile["runtime_lifecycle"]["binding_sha256"] = PROOF.sha256(
            PROOF.canonical(
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
        evidence, _neural_steps = real_nest_validation_fixture(plan, config)
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
            receipts = root / "receipts"
            evidence = root / "evidence"
            receipts.mkdir(mode=0o700)
            evidence.mkdir(mode=0o700)
            receipt_document = {"receipt_sha256": "1" * 64, "status": "completed"}
            evidence_document = {
                "bundle_sha256": "2" * 64,
                "run_receipt_sha256": "1" * 64,
            }
            (receipts / "receipt.json").write_bytes(
                PROOF.canonical(receipt_document) + b"\n"
            )
            (evidence / "evidence.json").write_bytes(
                PROOF.canonical(evidence_document) + b"\n"
            )
            for path in (receipts / "receipt.json", evidence / "evidence.json"):
                os.chmod(path, 0o600)
            store_id = "clrs_" + "3" * 64
            store_closure = PROOF.collect_receipt_store_closure(
                root,
                store_id=store_id,
                receipt_document=receipt_document,
                evidence_document=evidence_document,
            )
            self.assertEqual(store_closure["file_count"], 2)
            self.assertEqual(
                PROOF.receipt_store_identity(SimpleNamespace(store_id=store_id)),
                store_id,
            )
            duplicate = evidence / "duplicate.json"
            duplicate.write_bytes(PROOF.canonical(receipt_document) + b"\n")
            os.chmod(duplicate, 0o600)
            with self.assertRaisesRegex(RuntimeError, "one exact receipt"):
                PROOF.collect_receipt_store_closure(
                    root,
                    store_id=store_id,
                    receipt_document=receipt_document,
                    evidence_document=evidence_document,
                )
            duplicate.unlink()
            linked = evidence / "linked.json"
            linked.symlink_to(evidence / "evidence.json")
            with self.assertRaisesRegex(RuntimeError, "link or unbounded"):
                PROOF.collect_receipt_store_closure(
                    root,
                    store_id=store_id,
                    receipt_document=receipt_document,
                    evidence_document=evidence_document,
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
