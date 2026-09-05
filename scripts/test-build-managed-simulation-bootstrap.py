#!/usr/bin/env python3
"""Exercise the clean-main observed-build provenance boundary."""

from __future__ import annotations

import copy
import importlib.util
import io
import os
import stat
import struct
import sys
import subprocess
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

from managed_simulation_authoring_files import copy_regular, write_new_regular
from managed_simulation_build_provenance import (
    canonical,
    executable_identity,
    parse_macho_arm64_executable,
    sha256,
    validate_build_receipt,
    validate_stage_receipt,
)
from managed_simulation_test_fixtures import (
    GENERATOR_PATHS,
    SOURCE_PATHS,
    build_receipt,
    macho_arm64,
    stage_receipt,
)


SCRIPT = Path(__file__).with_name("build-managed-simulation-bootstrap.py")
SPEC = importlib.util.spec_from_file_location("managed_simulation_bootstrap", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("observed-build script cannot be imported")
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BOOTSTRAP)


def reseal(receipt: dict[str, object]) -> None:
    material = {key: value for key, value in receipt.items() if key != "receipt_sha256"}
    receipt["receipt_sha256"] = sha256(canonical(material))


class ObservedBuildTests(unittest.TestCase):
    def test_macho_arm64_executable_and_hostile_headers(self) -> None:
        payload = macho_arm64()
        self.assertEqual(
            parse_macho_arm64_executable(payload),
            {
                "format": "mach-o-64",
                "architecture": "arm64",
                "file_type": "executable",
            },
        )
        identity = executable_identity(payload, stat.S_IFREG | 0o755)
        self.assertEqual(identity["sha256"], sha256(payload))
        zero_commands = b"\xcf\xfa\xed\xfe" + struct.pack(
            "<IIIIIII", 0x0100000C, 0, 2, 0, 0, 0, 0
        )
        invalid_command_size = bytearray(payload)
        invalid_command_size[36:40] = (7).to_bytes(4, "little")
        missing_entry = bytearray(payload)
        missing_entry[104:108] = (0).to_bytes(4, "little")
        for hostile in (
            b"#!/bin/sh\nexit 0\n",
            b"\xca\xfe\xba\xbe" + b"\0" * 28,
            zero_commands,
            payload[:-1],
            bytes(invalid_command_size),
            bytes(missing_entry),
            macho_arm64(cpu_type=0x01000007),
            macho_arm64(file_type=6),
        ):
            with self.assertRaises(RuntimeError):
                parse_macho_arm64_executable(hostile)
        for mode in (0o644, 0o777):
            with self.assertRaises(RuntimeError):
                executable_identity(payload, stat.S_IFREG | mode)

    def test_closed_build_receipt_and_hostile_provenance(self) -> None:
        payload = macho_arm64()
        receipt = build_receipt(payload)
        self.assertEqual(validate_build_receipt(receipt), receipt)

        hostiles = []
        path_spoof = copy.deepcopy(receipt)
        path_spoof["source"]["files"][0]["relative_path"] = "../rust-toolchain.toml"
        path_spoof["source"]["roster_sha256"] = sha256(
            canonical(path_spoof["source"]["files"])
        )
        reseal(path_spoof)
        hostiles.append(path_spoof)

        control_path_spoof = copy.deepcopy(receipt)
        control_path_spoof["source"]["files"][0]["relative_path"] = (
            "rust-toolchain.toml\nspoof"
        )
        control_path_spoof["source"]["roster_sha256"] = sha256(
            canonical(control_path_spoof["source"]["files"])
        )
        reseal(control_path_spoof)
        hostiles.append(control_path_spoof)

        source_swap = copy.deepcopy(receipt)
        source_swap["source"]["files"][0]["sha256"] = "f" * 64
        source_swap["source"]["roster_sha256"] = sha256(
            canonical(source_swap["source"]["files"])
        )
        reseal(source_swap)
        hostiles.append(source_swap)

        embedded_contract_omitted = copy.deepcopy(receipt)
        embedded_contract_omitted["source"]["files"] = [
            row
            for row in embedded_contract_omitted["source"]["files"]
            if not row["relative_path"].endswith("/configuration.schema.json")
        ]
        embedded_contract_omitted["source"]["roster_sha256"] = sha256(
            canonical(embedded_contract_omitted["source"]["files"])
        )
        reseal(embedded_contract_omitted)
        hostiles.append(embedded_contract_omitted)

        unclassified_source = copy.deepcopy(receipt)
        extra_row = copy.deepcopy(unclassified_source["source"]["files"][-1])
        extra_row["relative_path"] = "src-tauri/crates/managed-simulation/README.md"
        unclassified_source["source"]["files"].append(extra_row)
        unclassified_source["source"]["files"].sort(
            key=lambda row: row["relative_path"]
        )
        unclassified_source["source"]["roster_sha256"] = sha256(
            canonical(unclassified_source["source"]["files"])
        )
        reseal(unclassified_source)
        hostiles.append(unclassified_source)

        unsorted = copy.deepcopy(receipt)
        unsorted["source"]["files"][0:2] = reversed(unsorted["source"]["files"][0:2])
        unsorted["source"]["roster_sha256"] = sha256(
            canonical(unsorted["source"]["files"])
        )
        reseal(unsorted)
        hostiles.append(unsorted)

        toolchain = copy.deepcopy(receipt)
        toolchain["cargo"]["rust_toolchain"] = "stable"
        reseal(toolchain)
        hostiles.append(toolchain)

        target_directory = copy.deepcopy(receipt)
        target_directory["cargo"]["argv"][-1] = "/tmp/unbound-target"
        reseal(target_directory)
        hostiles.append(target_directory)

        architecture = copy.deepcopy(receipt)
        architecture["output"]["architecture"] = "x86_64"
        reseal(architecture)
        hostiles.append(architecture)

        format_drift = copy.deepcopy(receipt)
        format_drift["output"]["format"] = "elf-64"
        reseal(format_drift)
        hostiles.append(format_drift)

        for hostile in hostiles:
            with self.assertRaises(RuntimeError):
                validate_build_receipt(hostile)

    def test_stage_receipt_rejects_build_receipt_swap(self) -> None:
        payload = macho_arm64()
        build_a = build_receipt(payload)
        inventory = [
            {
                "relative_path": "bin/crebain-managed-simulation",
                "byte_length": len(payload),
                "sha256": sha256(payload),
                "mode": 0o700,
                "role": "executable",
            },
            {
                "relative_path": "contracts/example.schema.json",
                "byte_length": 3,
                "sha256": sha256(b"{}\n"),
                "mode": 0o600,
                "role": "contract",
            },
        ]
        stage = stage_receipt(
            build_a,
            inventory,
            recipe_bytes=b"{}\n",
            configuration_bytes=b"{}\n",
        )
        validate_stage_receipt(
            stage,
            build_receipt=build_a,
            build_receipt_bytes=canonical(build_a) + b"\n",
        )
        executable_contract = copy.deepcopy(stage)
        executable_contract["package_inventory"][1]["mode"] = 0o700
        executable_contract["package_inventory_sha256"] = sha256(
            canonical(executable_contract["package_inventory"])
        )
        reseal(executable_contract)
        with self.assertRaisesRegex(RuntimeError, "contract inventory path or mode"):
            validate_stage_receipt(
                executable_contract,
                build_receipt=build_a,
                build_receipt_bytes=canonical(build_a) + b"\n",
            )
        build_b = build_receipt(payload + b"different")
        with self.assertRaises(RuntimeError):
            validate_stage_receipt(
                stage,
                build_receipt=build_b,
                build_receipt_bytes=canonical(build_b) + b"\n",
            )

    def test_clean_origin_main_git_binding_and_dirty_controls(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-build-git-test-") as raw:
            root = Path(raw)
            subprocess.run(
                ["git", "init", "-b", "main"], cwd=root, check=True, capture_output=True
            )
            subprocess.run(
                ["git", "config", "user.email", "test@example.invalid"],
                cwd=root,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "CREBAIN test"],
                cwd=root,
                check=True,
            )
            payloads: dict[str, bytes] = {}
            for relative in sorted({*SOURCE_PATHS, *GENERATOR_PATHS}):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                payload = f"committed {relative}\n".encode()
                path.write_bytes(payload)
                payloads[relative] = payload
                if relative.endswith(".py"):
                    path.chmod(0o755)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(
                ["git", "commit", "-m", "fixture"],
                cwd=root,
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    "git",
                    "remote",
                    "add",
                    "origin",
                    "https://example.invalid/crebain.git",
                ],
                cwd=root,
                check=True,
            )
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            subprocess.run(
                ["git", "update-ref", "refs/remotes/origin/main", commit],
                cwd=root,
                check=True,
            )
            identity = BOOTSTRAP.verify_immutable_checkout(root, commit)
            self.assertEqual(identity["commit"], commit)
            catalog = BOOTSTRAP.committed_rows(root, commit)
            rows = BOOTSTRAP.bind_rows(root, commit, catalog, set(SOURCE_PATHS))
            self.assertEqual(
                [row["relative_path"] for row in rows], sorted(SOURCE_PATHS)
            )

            dirty = root / SOURCE_PATHS[0]
            dirty.write_bytes(b"dirty\n")
            with self.assertRaises(RuntimeError):
                BOOTSTRAP.verify_immutable_checkout(root, commit)
            dirty.write_bytes(payloads[SOURCE_PATHS[0]])
            untracked = root / "untracked.txt"
            untracked.write_text("untracked\n", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                BOOTSTRAP.verify_immutable_checkout(root, commit)

    def test_build_override_environment_fails_closed(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            BOOTSTRAP.require_closed_build_environment()
        for name in ("CARGO_INCREMENTAL", "CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS"):
            for value in ("0", "1", "true"):
                with self.subTest(name=name, value=value):
                    with mock.patch.dict(os.environ, {name: value}, clear=True):
                        with self.assertRaisesRegex(RuntimeError, name):
                            BOOTSTRAP.require_closed_build_environment()

    def test_ci_environment_cleanup_is_child_local_and_preserves_other_overrides(self) -> None:
        environment = {"PATH": os.environ["PATH"], "CARGO_INCREMENTAL": "0",
                       "CREBAIN_CI_TEST_SENTINEL": "preserved"}
        program = (
            "import os,runpy,sys;"
            "assert 'CARGO_INCREMENTAL' not in os.environ;"
            "assert os.environ['CREBAIN_CI_TEST_SENTINEL']=='preserved';"
            f"sys.path.insert(0,{str(SCRIPT.parent)!r});"
            f"runpy.run_path({str(SCRIPT)!r})['require_closed_build_environment']()"
        )
        parent_before = dict(os.environ)
        for overrides in ({}, {"RUSTFLAGS": "-C debuginfo=1"}):
            with self.subTest(overrides=overrides):
                completed = subprocess.run(
                    ["env", "-u", "CARGO_INCREMENTAL", sys.executable, "-B", "-c", program],
                    env={**environment, **overrides}, capture_output=True, timeout=10,
                )
                self.assertEqual(completed.returncode, 1 if overrides else 0,
                                 completed.stderr.decode())
                if overrides:
                    self.assertIn(b"build override environment is not empty: RUSTFLAGS", completed.stderr)
        self.assertEqual(os.environ, parent_before)
        self.assertEqual(environment["CARGO_INCREMENTAL"], "0")

    def test_build_rejects_a_target_directory_not_named_by_argv(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-build-target-test-") as raw:
            root = Path(raw)
            with self.assertRaisesRegex(RuntimeError, "exact argument"):
                BOOTSTRAP.run_build(root, "rustup", root / "different", 1)

    def test_rustc_dep_info_closes_the_actual_source_roster(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-build-dep-info-test-") as raw:
            root = Path(raw)
            workspace = root / "src-tauri"
            source_paths = {
                "src-tauri/crates/managed-simulation/src/lib.rs",
                "src-tauri/crates/managed-simulation/src/main.rs",
                "integrations/engram/managed-simulation/contracts/configuration.schema.json",
            }
            for relative in source_paths:
                source = root / relative
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text(f"fixture {relative}\n", encoding="utf-8")
            target = root / "target"
            dependencies = target / "aarch64-apple-darwin" / "release" / "deps"
            dependencies.mkdir(parents=True)
            relative_sources = [
                os.path.relpath(root / relative, workspace)
                for relative in sorted(source_paths)
            ]
            (dependencies / "crebain_managed_simulation-library.d").write_text(
                f"library: {' '.join(relative_sources[:-1])}\n",
                encoding="utf-8",
            )
            binary_dep_info = dependencies / "crebain_managed_simulation-binary.d"
            binary_dep_info.write_text(
                f"binary: {relative_sources[-1]}\n",
                encoding="utf-8",
            )
            BOOTSTRAP.verify_rustc_dependency_roster(root, target, source_paths)

            binary_dep_info.write_text("binary: ../unexpected.rs\n", encoding="utf-8")
            (root / "unexpected.rs").write_text("unexpected\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "exact Git build-source roster"):
                BOOTSTRAP.verify_rustc_dependency_roster(root, target, source_paths)

    def test_atomic_publication_never_replaces_existing_bytes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="crebain-atomic-publish-test-") as raw:
            root = Path(raw).resolve()
            source = root / "source"
            source.write_bytes(b"source bytes")
            destination = root / "destination"
            copy_regular(source, destination, 0o600, 1024)
            with self.assertRaises(SystemExit):
                copy_regular(source, destination, 0o600, 1024)
            self.assertEqual(destination.read_bytes(), b"source bytes")

            receipt = root / "receipt.json"
            write_new_regular(receipt, b"{}\n", label="test receipt")
            with self.assertRaises(SystemExit):
                write_new_regular(receipt, b"changed\n", label="test receipt")
            self.assertEqual(receipt.read_bytes(), b"{}\n")
            self.assertFalse(list(root.glob(".*.tmp")))

    def test_receipt_publishes_only_after_target_cleanup(self) -> None:
        repository = {
            "origin": "https://example.invalid/crebain.git",
            "commit": "a" * 40,
            "tree": "b" * 40,
            "origin_main": "a" * 40,
            "object_format": "sha1",
            "clean": True,
        }
        real_rmtree = BOOTSTRAP.shutil.rmtree
        real_write_new_regular = BOOTSTRAP.write_new_regular

        for cleanup_failure in (False, True):
            with self.subTest(cleanup_failure=cleanup_failure):
                with tempfile.TemporaryDirectory(
                    prefix="crebain-build-cleanup-test-"
                ) as raw:
                    root = Path(raw).resolve()
                    output_parent = root / "output"
                    output_parent.mkdir(mode=0o700)
                    target_parent = (
                        root / "src-tauri/target/managed-simulation-bootstrap"
                    )
                    target_parent.mkdir(parents=True, mode=0o700)
                    binary_output = output_parent / "crebain-managed-simulation"
                    receipt_output = output_parent / "observed-build-receipt.json"
                    events: list[str] = []

                    def fake_bind_rows(
                        _root: Path,
                        _commit: str,
                        _catalog: object,
                        paths: set[str],
                    ) -> list[dict[str, object]]:
                        label = (
                            "generator"
                            if paths == BOOTSTRAP.GENERATOR_PATHS
                            else "source"
                        )
                        return [{"relative_path": label}]

                    def fake_run_build(
                        _root: Path,
                        _rustup: str,
                        target: Path,
                        _timeout: int,
                    ) -> Path:
                        executable = (
                            target
                            / "aarch64-apple-darwin/release/crebain-managed-simulation"
                        )
                        executable.parent.mkdir(parents=True)
                        executable.write_bytes(macho_arm64())
                        executable.chmod(0o755)
                        return executable

                    def cleanup(path: Path) -> None:
                        events.append("cleanup")
                        if cleanup_failure:
                            raise RuntimeError("simulated target cleanup failure")
                        real_rmtree(path)

                    def publish_receipt(
                        path: Path,
                        payload: bytes,
                        *,
                        label: str,
                        fail: object,
                    ) -> None:
                        events.append("receipt")
                        real_write_new_regular(
                            path,
                            payload,
                            label=label,
                            fail=fail,
                        )

                    arguments = Namespace(
                        root=root,
                        commit="a" * 40,
                        binary_output=binary_output,
                        receipt_output=receipt_output,
                        timeout_seconds=30,
                    )
                    with (
                        mock.patch.object(
                            BOOTSTRAP,
                            "verify_immutable_checkout",
                            return_value=repository,
                        ),
                        mock.patch.object(
                            BOOTSTRAP,
                            "committed_rows",
                            return_value={"rust-toolchain.toml": ("100644", "c" * 40)},
                        ),
                        mock.patch.object(
                            BOOTSTRAP, "bind_rows", side_effect=fake_bind_rows
                        ),
                        mock.patch.object(
                            BOOTSTRAP, "require_closed_build_environment"
                        ),
                        mock.patch.object(
                            BOOTSTRAP,
                            "exact_tool_versions",
                            return_value=("rustup", "rustc fixture", "cargo fixture"),
                        ),
                        mock.patch.object(
                            BOOTSTRAP, "run_build", side_effect=fake_run_build
                        ),
                        mock.patch.object(BOOTSTRAP, "verify_rustc_dependency_roster"),
                        mock.patch.object(
                            BOOTSTRAP,
                            "build_receipt",
                            return_value={"receipt_sha256": "d" * 64},
                        ),
                        mock.patch.object(
                            BOOTSTRAP.shutil, "rmtree", side_effect=cleanup
                        ),
                        mock.patch.object(
                            BOOTSTRAP,
                            "write_new_regular",
                            side_effect=publish_receipt,
                        ) as receipt_writer,
                        mock.patch("sys.stdout", new=io.StringIO()),
                    ):
                        if cleanup_failure:
                            with self.assertRaisesRegex(
                                RuntimeError, "target cleanup failure"
                            ):
                                BOOTSTRAP.execute(arguments)
                        else:
                            BOOTSTRAP.execute(arguments)

                    if cleanup_failure:
                        self.assertEqual(events, ["cleanup"])
                        receipt_writer.assert_not_called()
                        self.assertFalse(binary_output.exists())
                        self.assertFalse(receipt_output.exists())
                    else:
                        self.assertEqual(events, ["cleanup", "receipt"])
                        receipt_writer.assert_called_once()
                        self.assertTrue(binary_output.exists())
                        self.assertTrue(receipt_output.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
