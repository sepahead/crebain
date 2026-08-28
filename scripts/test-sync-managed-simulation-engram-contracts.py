#!/usr/bin/env python3
"""Provider-free controls for deterministic Engram contract synchronization."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "sync-managed-simulation-engram-contracts.py"


def load_sync() -> ModuleType:
    specification = importlib.util.spec_from_file_location(
        "crebain_contract_sync", SCRIPT
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("contract sync module cannot be loaded")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


SYNC = load_sync()


class ContractSyncTests(unittest.TestCase):
    def test_default_roster_is_the_exact_current_contract_set(self) -> None:
        expected = [
            (
                "engram.managed-runtime-ipc.v1",
                "managed-runtime-ipc.schema.json",
                "runnable",
            )
        ]
        for version in (1, 2, 3):
            prefix = "audit-standard" if version < 3 else "standard"
            role = "audit-only" if version < 3 else "runnable"
            for operation in ("finish", "prepare", "step"):
                for direction in ("request", "response"):
                    expected.append(
                        (
                            f"engram.closed-loop-simulator.{operation}-{direction}.v{version}",
                            f"{prefix}-v{version}-{operation}-{direction}.schema.json",
                            role,
                        )
                    )
        observed = [
            (spec.schema_id, spec.destination_name, spec.runtime_role)
            for spec in SYNC.CONTRACT_SPECS
        ]
        self.assertEqual(observed, expected)
        self.assertEqual(len(observed), 19)
        self.assertEqual(
            [spec.source_path for spec in SYNC.CONTRACT_SPECS],
            [
                f"integrations/contracts/{spec.schema_id}.schema.json"
                for spec in SYNC.CONTRACT_SPECS
            ],
        )

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="crebain-contract-sync-")
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "engram"
        self.source.mkdir()
        self.run_git("init")
        self.run_git("config", "user.name", "CREBAIN Test")
        self.run_git("config", "user.email", "test@crebain.invalid")
        self.run_git("remote", "add", "origin", "git@example.invalid:engram.git")
        self.run_git("commit", "--allow-empty", "-m", "base")
        self.specs = (
            SYNC.ContractSpec(
                "test.contract.one.v1",
                "integrations/contracts/test.contract.one.v1.schema.json",
                "one.schema.json",
                "runnable",
            ),
            SYNC.ContractSpec(
                "test.contract.two.v1",
                "integrations/contracts/test.contract.two.v1.schema.json",
                "two.schema.json",
                "audit-only",
            ),
        )
        for spec in self.specs:
            path = self.source / spec.source_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"$id": spec.schema_id}) + "\n")
        self.run_git("add", ".")
        self.run_git("commit", "-m", "contracts")
        self.commit = self.git_text("rev-parse", "HEAD")
        self.run_git("update-ref", "refs/remotes/origin/main", self.commit)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_git(self, *arguments: str) -> None:
        subprocess.run(
            ["git", *arguments],
            cwd=self.source,
            check=True,
            capture_output=True,
            timeout=10,
        )

    def git_text(self, *arguments: str) -> str:
        return subprocess.run(
            ["git", *arguments],
            cwd=self.source,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()

    def test_clean_origin_main_generates_non_null_blob_provenance(self) -> None:
        provenance, payloads = SYNC.build_sync(self.source, self.commit, self.specs)
        self.assertEqual(provenance["schema_version"], "crebain.contract-provenance.v2")
        self.assertEqual(provenance["source"]["commit"], self.commit)
        self.assertEqual(provenance["source"]["origin_main"], self.commit)
        self.assertEqual(set(payloads), {"one.schema.json", "two.schema.json"})
        self.assertTrue(all(row["git_blob"] for row in provenance["copies"]))
        self.assertTrue(
            all(
                SYNC.OBJECT_ID.fullmatch(row["git_blob"])
                for row in provenance["copies"]
            )
        )

    def test_dirty_checkout_and_origin_drift_fail_closed(self) -> None:
        untracked = self.source / "untracked"
        untracked.write_text("hostile")
        with self.assertRaisesRegex(RuntimeError, "not clean"):
            SYNC.build_sync(self.source, self.commit, self.specs)
        untracked.unlink()
        self.run_git("update-ref", "refs/remotes/origin/main", "HEAD^")
        with self.assertRaisesRegex(RuntimeError, "origin/main"):
            SYNC.build_sync(self.source, self.commit, self.specs)

    def test_schema_identity_and_committed_blob_fail_closed(self) -> None:
        target = self.source / self.specs[0].source_path
        target.write_text('{"$id":"wrong"}\n')
        with self.assertRaisesRegex(RuntimeError, "not clean"):
            SYNC.build_sync(self.source, self.commit, self.specs)
        self.run_git("checkout", "--", self.specs[0].source_path)
        wrong = (
            SYNC.ContractSpec(
                "wrong",
                self.specs[0].source_path,
                self.specs[0].destination_name,
                "runnable",
            ),
        )
        with self.assertRaisesRegex(RuntimeError, r"\$id differs"):
            SYNC.build_sync(self.source, self.commit, wrong)

    def test_local_copy_and_provenance_are_exact(self) -> None:
        provenance, payloads = SYNC.build_sync(self.source, self.commit, self.specs)
        destination = self.root / "copies"
        destination.mkdir()
        provenance_path = destination / "PROVENANCE.json"
        for name, payload in payloads.items():
            (destination / name).write_bytes(payload)
        provenance_path.write_bytes(SYNC.expected_provenance_bytes(provenance))
        SYNC.check_local(destination, provenance_path, provenance, payloads)
        (destination / "one.schema.json").write_text("{}\n")
        with self.assertRaisesRegex(RuntimeError, "differs from Engram"):
            SYNC.check_local(destination, provenance_path, provenance, payloads)

    def test_replace_outputs_updates_every_copy_and_provenance(self) -> None:
        provenance, payloads = SYNC.build_sync(self.source, self.commit, self.specs)
        destination = self.root / "replace-copies"
        destination.mkdir()
        provenance_path = destination / "PROVENANCE.json"
        for name in payloads:
            (destination / name).write_text('{"$id":"stale"}\n')
        provenance_path.write_text("{}\n")
        unrelated = destination / "project-owned.schema.json"
        unrelated.write_text('{"$id":"project-owned"}\n')

        SYNC.replace_outputs(destination, provenance_path, provenance, payloads)

        SYNC.check_local(destination, provenance_path, provenance, payloads)
        self.assertEqual(unrelated.read_text(), '{"$id":"project-owned"}\n')

    def test_replace_outputs_rejects_a_linked_destination(self) -> None:
        provenance, payloads = SYNC.build_sync(self.source, self.commit, self.specs)
        destination = self.root / "linked-copies"
        destination.mkdir()
        provenance_path = destination / "PROVENANCE.json"
        provenance_path.write_text("{}\n")
        real = destination / "real.schema.json"
        real.write_text('{"$id":"stale"}\n')
        (destination / "one.schema.json").symlink_to(real.name)
        (destination / "two.schema.json").write_text('{"$id":"stale"}\n')

        with self.assertRaisesRegex(RuntimeError, "not one regular file"):
            SYNC.replace_outputs(destination, provenance_path, provenance, payloads)


if __name__ == "__main__":
    unittest.main(verbosity=2)
