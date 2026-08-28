#!/usr/bin/env python3
"""Provider-free controls for the tracked real-NEST suite and index builder."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import ModuleType

from managed_simulation_test_fixtures import real_nest_validation_fixture


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/run-managed-simulation-real-nest-suite.py"


def load_suite() -> ModuleType:
    specification = importlib.util.spec_from_file_location("crebain_nest_suite", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("real-NEST suite module cannot be loaded")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


SUITE = load_suite()


def minimal_installed_proof() -> dict[str, object]:
    pack_tool = {
        "relative_path": "scripts/engram_extension.py",
        "size_bytes": 7,
        "sha256": "f" * 64,
        "git_mode": "100755",
        "git_blob": "1" * 40,
    }
    fields = {
        "store_id": "extstore_" + "1" * 64,
        "package_generation_id": "pkggen_" + "2" * 64,
        "installation_id": "inst_" + "3" * 64,
        "crebain_commit": "a" * 40,
        "crebain_tree": "b" * 40,
        "crebain_origin_main": "a" * 40,
        "engram_commit": "d" * 40,
        "engram_tree": "e" * 40,
        "engram_origin_main": "d" * 40,
        "engram_extension_tool_sha256": pack_tool["sha256"],
        "engram_extension_tool_git_blob": pack_tool["git_blob"],
        "engram_pack_receipt": {
            "engram_repository": {
                "origin": "git@example.invalid:engram.git",
                "commit": "d" * 40,
                "tree": "e" * 40,
                "origin_main": "d" * 40,
                "object_format": "sha1",
                "clean": True,
            },
            "engram_tool": pack_tool,
        },
        "executable_format": "mach-o-64",
        "executable_architecture": "arm64",
        "build_stage_seal_install_lineage_verified": True,
        "build_stage_seal_pack_install_lineage_verified": True,
    }
    for index, field in enumerate(
        (
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
            "build_source_roster_sha256",
            "build_input_identity_sha256",
        ),
        start=4,
    ):
        fields[field] = f"{index:x}"[-1] * 64
    return fields


def write_json(path: Path, value: object) -> bytes:
    payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    path.write_bytes(payload)
    os.chmod(path, 0o600)
    return payload


def reseal_suite(root: Path, suite: dict[str, object]) -> None:
    definition = {
        key: value for key, value in suite.items() if key != "suite_definition_sha256"
    }
    suite["suite_definition_sha256"] = SUITE.sha256(SUITE.canonical(definition))
    write_json(root / "SUITE.json", suite)


class RealNestSuiteTests(unittest.TestCase):
    def test_bounded_subprocess_drains_large_stderr_and_stdout_concurrently(
        self,
    ) -> None:
        completed = SUITE.run_bounded_process(
            [
                sys.executable,
                "-c",
                (
                    "import os\n"
                    "for _ in range(32):\n"
                    " os.write(1, b'o' * 4096)\n"
                    " os.write(2, b'e' * 4096)\n"
                ),
            ],
            input_bytes=None,
            timeout_seconds=2,
            max_input_bytes=0,
            max_stdout_bytes=128 * 1024,
            max_stderr_bytes=128 * 1024,
            label="concurrent-output control",
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(len(completed.stdout), 128 * 1024)
        self.assertEqual(len(completed.stderr), 128 * 1024)

        with self.assertRaisesRegex(
            SUITE.ManagedSimulationSubprocessError,
            "stderr exceeded 4096 bytes",
        ) as raised:
            SUITE.run_bounded_process(
                [
                    sys.executable,
                    "-c",
                    "import os; os.write(2, b'x' * 1048576)",
                ],
                input_bytes=None,
                timeout_seconds=2,
                max_input_bytes=0,
                max_stdout_bytes=1,
                max_stderr_bytes=4096,
                label="large-stderr control",
            )
        self.assertEqual(len(raised.exception.stderr), 4096)

    def test_bounded_subprocess_stops_blocked_stdin_and_timeout(self) -> None:
        started = time.monotonic()
        with self.assertRaisesRegex(
            SUITE.ManagedSimulationSubprocessError,
            "input deadline expired",
        ):
            SUITE.run_bounded_process(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                input_bytes=b"x" * (1024 * 1024),
                timeout_seconds=0.2,
                max_input_bytes=1024 * 1024,
                max_stdout_bytes=1,
                max_stderr_bytes=1,
                label="blocked-stdin control",
            )
        self.assertLess(time.monotonic() - started, 2.0)

        started = time.monotonic()
        with self.assertRaisesRegex(
            SUITE.ManagedSimulationSubprocessError,
            "process deadline expired",
        ):
            SUITE.run_bounded_process(
                [sys.executable, "-c", "import time; time.sleep(30)"],
                input_bytes=None,
                timeout_seconds=0.2,
                max_input_bytes=0,
                max_stdout_bytes=1,
                max_stderr_bytes=1,
                label="timeout control",
            )
        self.assertLess(time.monotonic() - started, 2.0)

    @unittest.skipUnless(
        os.name == "posix" and hasattr(os, "fork"),
        "requires POSIX process groups",
    )
    def test_bounded_subprocess_kills_descendant_after_parent_exit(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="crebain-managed-subprocess-descendant-"
        ) as raw:
            pid_path = Path(raw) / "descendant.pid"
            program = (
                "import os, pathlib, time\n"
                "pid = os.fork()\n"
                "if pid == 0:\n"
                f" pathlib.Path({str(pid_path)!r}).write_text(str(os.getpid()))\n"
                " time.sleep(30)\n"
            )
            with self.assertRaisesRegex(
                SUITE.ManagedSimulationSubprocessError,
                "descendants retained output pipes",
            ):
                SUITE.run_bounded_process(
                    [sys.executable, "-c", program],
                    input_bytes=None,
                    timeout_seconds=1,
                    max_input_bytes=0,
                    max_stdout_bytes=4096,
                    max_stderr_bytes=4096,
                    label="descendant control",
                )
            descendant_pid = int(pid_path.read_text(encoding="utf-8"))
            observation_deadline = time.monotonic() + 1.0
            while True:
                try:
                    os.kill(descendant_pid, 0)
                except ProcessLookupError:
                    break
                if time.monotonic() >= observation_deadline:
                    self.fail("bounded subprocess descendant remained alive")
                time.sleep(0.01)

    def test_tracked_inputs_are_exact_one_two_three(self) -> None:
        suite, suite_bytes, plans, _config_path, _config_bytes = (
            SUITE.verify_suite_inputs()
        )
        self.assertEqual(sorted(plans), [1, 2, 3])
        self.assertEqual(
            suite["suite_definition_sha256"],
            "b0c5710c737dd7b979de853e833342801f2767bf36769fe679c5e125e252007f",
        )
        self.assertEqual(
            SUITE.sha256(suite_bytes),
            "96682b76c066e045c9ae9154704afc14e6e5b6133a66568dc83964c62d59e6a3",
        )

    def test_hostile_suite_and_plan_mutations_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-nest-suite-inputs-") as raw:
            root = Path(raw).resolve()
            shutil.copytree(SUITE.INPUT_ROOT, root, dirs_exist_ok=True)
            for path in root.iterdir():
                os.chmod(path, 0o600)
            suite = json.loads((root / "SUITE.json").read_text())
            suite["runs"][1]["drone_count"] = 1
            reseal_suite(root, suite)
            with self.assertRaisesRegex(RuntimeError, "exact 1/2/3-drone roster"):
                SUITE.verify_suite_inputs(root)

            shutil.rmtree(root)
            shutil.copytree(SUITE.INPUT_ROOT, root)
            for path in root.iterdir():
                os.chmod(path, 0o600)
            suite = json.loads((root / "SUITE.json").read_text())
            plan_path = root / suite["runs"][0]["plan_path"]
            plan = json.loads(plan_path.read_text())
            plan["ncp_transport_used"] = True
            plan_bytes = write_json(plan_path, plan)
            suite["runs"][0]["plan_exact_sha256"] = SUITE.sha256(plan_bytes)
            reseal_suite(root, suite)
            with self.assertRaisesRegex(RuntimeError, "run plan or exact 6N topology"):
                SUITE.verify_suite_inputs(root)

    def test_symlinked_tracked_input_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-nest-suite-link-") as raw:
            root = Path(raw).resolve()
            shutil.copytree(SUITE.INPUT_ROOT, root, dirs_exist_ok=True)
            for path in root.iterdir():
                os.chmod(path, 0o600)
            target = root / "run-plan-1-drone.json"
            saved = root / "saved.json"
            target.rename(saved)
            target.symlink_to(saved)
            with self.assertRaisesRegex(RuntimeError, "without following links"):
                SUITE.verify_suite_inputs(root)

    def test_index_requires_distinct_run_and_store_identities(self) -> None:
        suite, suite_bytes, _plans, _config_path, config_bytes = (
            SUITE.verify_suite_inputs()
        )
        proof = minimal_installed_proof()
        tool_source_bytes = {
            path: f"fixture {path}\n".encode() for path in SUITE.TOOL_SOURCE_ROLES
        }
        rows = [
            {
                "drone_count": count,
                "path": f"capture-{count}-drone{'s' if count > 1 else ''}.json",
                "capture_sha256": "abc"[count - 1] * 64,
                "plan_exact_sha256": suite["runs"][count - 1]["plan_exact_sha256"],
                "receipt_sha256": str(count) * 64,
                "evidence_bundle_sha256": "def"[count - 1] * 64,
                "receipt_store_id": "clrs_" + str(count) * 64,
                "receipt_store_closure_sha256": str(count + 3) * 64,
                "engram_source_closure_sha256": "f" * 64,
                "observed_build_receipt_exact_sha256": proof[
                    "observed_build_receipt_exact_sha256"
                ],
                "population_count": count * 6,
                "population_neuron_count": count * 48,
                "device_node_count": count * 12,
                "connection_count": count * 96,
                "session_count": 1,
            }
            for count in (1, 2, 3)
        ]
        index = SUITE.build_index(
            suite=suite,
            suite_bytes=suite_bytes,
            config_bytes=config_bytes,
            installed_proof=proof,
            installed_proof_bytes=b"proof\n",
            engram_identity={
                "repository": "git@example.invalid:engram.git",
                "commit": "d" * 40,
                "tree": "e" * 40,
                "origin_main": "d" * 40,
                "object_format": "sha1",
                "clean": True,
            },
            capture_rows=rows,
            tool_source_bytes=tool_source_bytes,
        )
        self.assertEqual(
            index["schema_version"],
            "crebain.real-nest-closed-loop-evidence-index.v2",
        )
        self.assertEqual(index["package"]["engram_commit"], "d" * 40)
        self.assertEqual(index["package"]["engram_extension_tool_git_blob"], "1" * 40)
        self.assertTrue(index["assertions"]["engram_pack_source_lineage_common"])
        self.assertTrue(
            index["assertions"]["observed_build_stage_seal_pack_install_lineage_common"]
        )

        wrong_engram = copy.deepcopy(proof)
        wrong_engram["engram_pack_receipt"]["engram_repository"]["commit"] = "9" * 40
        wrong_engram["engram_pack_receipt"]["engram_repository"]["origin_main"] = (
            "9" * 40
        )
        wrong_engram["engram_commit"] = "9" * 40
        wrong_engram["engram_origin_main"] = "9" * 40
        with self.assertRaisesRegex(RuntimeError, "immutable checkout"):
            SUITE.build_index(
                suite=suite,
                suite_bytes=suite_bytes,
                config_bytes=config_bytes,
                installed_proof=wrong_engram,
                installed_proof_bytes=b"proof\n",
                engram_identity={
                    "repository": "git@example.invalid:engram.git",
                    "commit": "d" * 40,
                    "tree": "e" * 40,
                    "origin_main": "d" * 40,
                    "object_format": "sha1",
                    "clean": True,
                },
                capture_rows=rows,
                tool_source_bytes=tool_source_bytes,
            )

        incomplete_lineage = copy.deepcopy(proof)
        incomplete_lineage["build_stage_seal_pack_install_lineage_verified"] = False
        with self.assertRaisesRegex(RuntimeError, "build-through-install"):
            SUITE.build_index(
                suite=suite,
                suite_bytes=suite_bytes,
                config_bytes=config_bytes,
                installed_proof=incomplete_lineage,
                installed_proof_bytes=b"proof\n",
                engram_identity={
                    "repository": "git@example.invalid:engram.git",
                    "commit": "d" * 40,
                    "tree": "e" * 40,
                    "origin_main": "d" * 40,
                    "object_format": "sha1",
                    "clean": True,
                },
                capture_rows=rows,
                tool_source_bytes=tool_source_bytes,
            )
        hostile = copy.deepcopy(rows)
        hostile[2]["receipt_store_id"] = hostile[1]["receipt_store_id"]
        with self.assertRaisesRegex(RuntimeError, "reuse a run/store identity"):
            SUITE.build_index(
                suite=suite,
                suite_bytes=suite_bytes,
                config_bytes=config_bytes,
                installed_proof=proof,
                installed_proof_bytes=b"proof\n",
                engram_identity={
                    "repository": "git@example.invalid:engram.git",
                    "commit": "d" * 40,
                    "tree": "e" * 40,
                    "origin_main": "d" * 40,
                    "object_format": "sha1",
                    "clean": True,
                },
                capture_rows=hostile,
                tool_source_bytes=tool_source_bytes,
            )
        for roster_drift in ("missing", "extra"):
            malformed = copy.deepcopy(rows)
            if roster_drift == "missing":
                del malformed[0]["session_count"]
            else:
                malformed[0]["unexpected"] = True
            with self.assertRaisesRegex(RuntimeError, "exact 15-key contract"):
                SUITE.build_index(
                    suite=suite,
                    suite_bytes=suite_bytes,
                    config_bytes=config_bytes,
                    installed_proof=proof,
                    installed_proof_bytes=b"proof\n",
                    engram_identity={
                        "repository": "git@example.invalid:engram.git",
                        "commit": "d" * 40,
                        "tree": "e" * 40,
                        "origin_main": "d" * 40,
                        "object_format": "sha1",
                        "clean": True,
                    },
                    capture_rows=malformed,
                    tool_source_bytes=tool_source_bytes,
                )

    def test_capture_v2_exact_closures_and_hostile_plan_drift(self) -> None:
        suite, _suite_bytes, plans, _config_path, config_bytes = (
            SUITE.verify_suite_inputs()
        )
        run_plan = plans[1][1]
        nest_config = SUITE.PROOF.decode_json_object(
            config_bytes, "tracked NEST configuration"
        )
        evidence, neural_steps = real_nest_validation_fixture(run_plan, nest_config)
        package_store_id = "extstore_" + "1" * 64
        package_generation_id = "pkggen_" + "2" * 64
        lifecycle = {
            "store_id": package_store_id,
            "package_generation_id": package_generation_id,
            "binding_sha256": "7" * 64,
        }
        terminal = {"runtime_lifecycle": lifecycle}
        terminal["receipt_sha256"] = SUITE.sha256(SUITE.canonical(terminal))
        evidence["run_receipt_sha256"] = terminal["receipt_sha256"]
        evidence["bundle_sha256"] = SUITE.sha256(SUITE.canonical(evidence))
        receipt_store_id = "clrs_" + "8" * 64
        summary = {
            "run_status": "completed",
            "receipt_sha256": terminal["receipt_sha256"],
            "evidence_bundle_sha256": evidence["bundle_sha256"],
            "store_id": receipt_store_id,
        }
        source_row = {
            "relative_path": "backend/example.py",
            "size_bytes": 7,
            "sha256": "a" * 64,
            "git_mode": "100644",
            "git_blob": "b" * 40,
        }
        tool_source_row = {
            "relative_path": "scripts/engram_extension.py",
            "size_bytes": 11,
            "sha256": "4" * 64,
            "git_mode": "100755",
            "git_blob": "5" * 40,
        }
        installed_proof = {
            "store_id": package_store_id,
            "package_generation_id": package_generation_id,
            "observed_build_receipt_exact_sha256": "9" * 64,
            "engram_commit": "c" * 40,
            "engram_tree": "d" * 40,
            "engram_origin_main": "c" * 40,
            "engram_extension_tool_sha256": tool_source_row["sha256"],
            "engram_extension_tool_git_blob": tool_source_row["git_blob"],
            "engram_pack_receipt": {
                "engram_repository": {
                    "origin": "git@example.invalid:engram.git",
                    "commit": "c" * 40,
                    "tree": "d" * 40,
                    "origin_main": "c" * 40,
                    "object_format": "sha1",
                    "clean": True,
                },
                "engram_tool": tool_source_row,
            },
        }
        installed_bytes = SUITE.canonical(installed_proof) + b"\n"
        source_closure = {
            "schema_version": "crebain.engram-python-source-closure.v1",
            "discovery_policy": (
                "loaded-host-modules-plus-worker-runtime-identity-and-entrypoints.v1"
            ),
            "git": {
                "repository": "git@example.invalid:engram.git",
                "commit": "c" * 40,
                "tree": "d" * 40,
                "origin_main": "c" * 40,
                "object_format": "sha1",
                "clean": True,
            },
            "host_modules": [
                {
                    "module_name": "scripts.engram_extension",
                    "relative_path": "scripts/engram_extension.py",
                }
            ],
            "worker_project_modules": [],
            "worker_project_source_roster_sha256": "e" * 64,
            "reviewed_runtime_handshake_receipt_sha256": "f" * 64,
            "reviewed_runtime_guardian_source_sha256": "1" * 64,
            "exercised_entrypoints": [
                {"role": "test-entrypoint", "relative_path": "backend/example.py"}
            ],
            "sources": [source_row, tool_source_row],
        }
        source_closure["closure_sha256"] = SUITE.sha256(SUITE.canonical(source_closure))
        store_closure = {
            "schema_version": "crebain.closed-loop-receipt-store-closure.v1",
            "store_id": receipt_store_id,
            "receipt_sha256": terminal["receipt_sha256"],
            "receipt_artifact_path": "receipts/receipt.json",
            "evidence_bundle_sha256": evidence["bundle_sha256"],
            "evidence_artifact_path": "evidence/evidence.json",
            "file_count": 2,
            "total_bytes": 2,
            "files": [
                {
                    "relative_path": "evidence/evidence.json",
                    "size_bytes": 1,
                    "sha256": "2" * 64,
                },
                {
                    "relative_path": "receipts/receipt.json",
                    "size_bytes": 1,
                    "sha256": "3" * 64,
                },
            ],
        }
        store_closure["closure_sha256"] = SUITE.sha256(SUITE.canonical(store_closure))
        topology = SUITE.PROOF.assert_population_topology(
            run_plan,
            nest_config,
            evidence,
            neural_steps,
        )
        guardian = SUITE.PROOF.assert_worker_guardian_closure(evidence)
        capture = {
            "schema_version": "crebain.real-nest-closed-loop-capture.v2",
            "engram_source_sha256": {
                source_row["relative_path"]: source_row["sha256"],
                tool_source_row["relative_path"]: tool_source_row["sha256"],
            },
            "engram_source_closure": source_closure,
            "package_generation_id": installed_proof["package_generation_id"],
            "installed_package_proof_exact_sha256": SUITE.sha256(installed_bytes),
            "installed_package_proof": installed_proof,
            "plan_exact_sha256": SUITE.sha256(plans[1][2]),
            "nest_config_exact_sha256": SUITE.sha256(config_bytes),
            "receipt_lock_timeout_ms": 30_000,
            "run_plan": run_plan,
            "nest_config": nest_config,
            "summary": summary,
            "terminal_receipt": terminal,
            "reviewed_native_runtime": {
                "handshake_receipt": {},
                "termination_receipt": {},
                "lifecycle_binding_sha256": lifecycle["binding_sha256"],
                "guardian_closure_verified": True,
                "package_store_lineage_verified": True,
            },
            "nest_worker_guardian_closure": guardian,
            "receipt_store_closure": store_closure,
            "population_topology": topology,
            "nest_evidence_bundle": evidence,
            "neural_steps": neural_steps,
            "assertions": {key: True for key in SUITE.CAPTURE_ASSERTIONS},
            "authority": SUITE.SIMULATOR_ONLY_AUTHORITY,
            "disclosure": "provider-free validator fixture",
        }
        capture_bytes = SUITE.canonical(capture) + b"\n"
        row = SUITE.validate_capture(
            capture,
            capture_bytes=capture_bytes,
            row=suite["runs"][0],
            plan_bytes=plans[1][2],
            config_bytes=config_bytes,
            installed_proof=installed_proof,
            installed_proof_bytes=installed_bytes,
            engram_commit="c" * 40,
        )
        self.assertEqual(row["population_count"], 6)
        self.assertEqual(set(row), SUITE.CAPTURE_ROW_KEYS)

        forged_tool_proof = copy.deepcopy(installed_proof)
        forged_tool_proof["engram_pack_receipt"]["engram_tool"]["sha256"] = "6" * 64
        forged_tool_proof["engram_extension_tool_sha256"] = "6" * 64
        forged_tool_bytes = SUITE.canonical(forged_tool_proof) + b"\n"
        forged_tool_capture = copy.deepcopy(capture)
        forged_tool_capture["installed_package_proof"] = forged_tool_proof
        forged_tool_capture["installed_package_proof_exact_sha256"] = SUITE.sha256(
            forged_tool_bytes
        )
        with self.assertRaisesRegex(RuntimeError, "loaded committed source"):
            SUITE.validate_capture(
                forged_tool_capture,
                capture_bytes=SUITE.canonical(forged_tool_capture) + b"\n",
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=forged_tool_proof,
                installed_proof_bytes=forged_tool_bytes,
                engram_commit="c" * 40,
            )

        with self.assertRaisesRegex(RuntimeError, "exact canonical JSON"):
            SUITE.validate_capture(
                capture,
                capture_bytes=b" " + capture_bytes,
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=installed_proof,
                installed_proof_bytes=installed_bytes,
                engram_commit="c" * 40,
            )
        hostile = copy.deepcopy(capture)
        hostile["run_plan"]["channels"][0]["action_width"] = 2
        with self.assertRaisesRegex(RuntimeError, "input or installed-package lineage"):
            SUITE.validate_capture(
                hostile,
                capture_bytes=SUITE.canonical(hostile) + b"\n",
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=installed_proof,
                installed_proof_bytes=installed_bytes,
                engram_commit="c" * 40,
            )

        path_spoof = copy.deepcopy(capture)
        path_spoof["engram_source_closure"]["sources"][0]["relative_path"] = (
            "../backend/example.py"
        )
        path_spoof["engram_source_sha256"] = {
            "../backend/example.py": source_row["sha256"]
        }
        source_material = {
            key: value
            for key, value in path_spoof["engram_source_closure"].items()
            if key != "closure_sha256"
        }
        path_spoof["engram_source_closure"]["closure_sha256"] = SUITE.sha256(
            SUITE.canonical(source_material)
        )
        with self.assertRaisesRegex(RuntimeError, "source closure differs"):
            SUITE.validate_capture(
                path_spoof,
                capture_bytes=SUITE.canonical(path_spoof) + b"\n",
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=installed_proof,
                installed_proof_bytes=installed_bytes,
                engram_commit="c" * 40,
            )

        object_format_drift = copy.deepcopy(capture)
        object_format_drift["engram_source_closure"]["git"]["object_format"] = "sha256"
        source_material = {
            key: value
            for key, value in object_format_drift["engram_source_closure"].items()
            if key != "closure_sha256"
        }
        object_format_drift["engram_source_closure"]["closure_sha256"] = SUITE.sha256(
            SUITE.canonical(source_material)
        )
        with self.assertRaisesRegex(RuntimeError, "source closure differs"):
            SUITE.validate_capture(
                object_format_drift,
                capture_bytes=SUITE.canonical(object_format_drift) + b"\n",
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=installed_proof,
                installed_proof_bytes=installed_bytes,
                engram_commit="c" * 40,
            )

        nested_escape = copy.deepcopy(capture)
        nested_escape["engram_source_closure"]["exercised_entrypoints"][0][
            "relative_path"
        ] = "backend/absent.py"
        source_material = {
            key: value
            for key, value in nested_escape["engram_source_closure"].items()
            if key != "closure_sha256"
        }
        nested_escape["engram_source_closure"]["closure_sha256"] = SUITE.sha256(
            SUITE.canonical(source_material)
        )
        with self.assertRaisesRegex(RuntimeError, "nested source roster escapes"):
            SUITE.validate_capture(
                nested_escape,
                capture_bytes=SUITE.canonical(nested_escape) + b"\n",
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=installed_proof,
                installed_proof_bytes=installed_bytes,
                engram_commit="c" * 40,
            )

        module_path_alias = copy.deepcopy(capture)
        module_path_alias["engram_source_closure"]["host_modules"] = [
            {
                "module_name": "backend.example",
                "relative_path": "backend/example.py",
            },
            {
                "module_name": "backend.other",
                "relative_path": "backend/example.py",
            },
        ]
        source_material = {
            key: value
            for key, value in module_path_alias["engram_source_closure"].items()
            if key != "closure_sha256"
        }
        module_path_alias["engram_source_closure"]["closure_sha256"] = SUITE.sha256(
            SUITE.canonical(source_material)
        )
        with self.assertRaisesRegex(
            RuntimeError, "module names or paths are not unique"
        ):
            SUITE.validate_capture(
                module_path_alias,
                capture_bytes=SUITE.canonical(module_path_alias) + b"\n",
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=installed_proof,
                installed_proof_bytes=installed_bytes,
                engram_commit="c" * 40,
            )

        entrypoint_path_alias = copy.deepcopy(capture)
        entrypoint_path_alias["engram_source_closure"]["exercised_entrypoints"].append(
            {
                "role": "zzz-secondary",
                "relative_path": "backend/example.py",
            }
        )
        source_material = {
            key: value
            for key, value in entrypoint_path_alias["engram_source_closure"].items()
            if key != "closure_sha256"
        }
        entrypoint_path_alias["engram_source_closure"]["closure_sha256"] = SUITE.sha256(
            SUITE.canonical(source_material)
        )
        with self.assertRaisesRegex(RuntimeError, "paths are not unique"):
            SUITE.validate_capture(
                entrypoint_path_alias,
                capture_bytes=SUITE.canonical(entrypoint_path_alias) + b"\n",
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=installed_proof,
                installed_proof_bytes=installed_bytes,
                engram_commit="c" * 40,
            )

        store_order = copy.deepcopy(capture)
        store_order["receipt_store_closure"]["files"].reverse()
        with self.assertRaisesRegex(RuntimeError, "receipt-store closure differs"):
            SUITE.validate_capture(
                store_order,
                capture_bytes=SUITE.canonical(store_order) + b"\n",
                row=suite["runs"][0],
                plan_bytes=plans[1][2],
                config_bytes=config_bytes,
                installed_proof=installed_proof,
                installed_proof_bytes=installed_bytes,
                engram_commit="c" * 40,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
