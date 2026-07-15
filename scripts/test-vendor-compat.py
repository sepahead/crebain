#!/usr/bin/env python3
"""Mutation tests for the offline crates.io compatibility overlay verifier."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify-vendor-compat.py")
SPEC = importlib.util.spec_from_file_location("verify_vendor_compat", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VendorCompatTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.vendor = self.root / "vendor-compat"
        shutil.copytree(MODULE.VENDOR_ROOT, self.vendor)
        self.lock = self.root / "Cargo.lock"
        self.cargo = self.root / "Cargo.toml"
        shutil.copy2(MODULE.LOCK_PATH, self.lock)
        shutil.copy2(MODULE.CARGO_MANIFEST_PATH, self.cargo)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def document(self) -> dict[str, object]:
        return MODULE.load_json_strict(self.vendor / "PROVENANCE.json")

    def write_document(self, document: dict[str, object]) -> None:
        (self.vendor / "PROVENANCE.json").write_text(
            json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

    def verify(self, document: dict[str, object] | None = None) -> None:
        MODULE.verify_manifest(document or self.document(), self.vendor, self.lock, self.cargo)

    def test_accepts_exact_bundled_archives_and_overlay(self) -> None:
        self.verify()

    def test_rejects_source_and_manifest_changed_together(self) -> None:
        source = self.vendor / "flume-0.11.1" / "src" / "lib.rs"
        source.write_bytes(source.read_bytes() + b"\n// unauthorized\n")
        document = self.document()
        files = document["packages"]["flume-0.11.1"]["upstream_files"]  # type: ignore[index]
        files["src/lib.rs"] = hashlib.sha256(source.read_bytes()).hexdigest()
        self.write_document(document)
        with self.assertRaisesRegex(ValueError, "archive-derived upstream provenance drift"):
            self.verify(document)

    def test_rejects_archive_license_schema_and_extra_file_mutations(self) -> None:
        archive = self.vendor / "upstream-archives" / "uhlc-0.8.2.crate"
        archive.write_bytes(archive.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "archive SHA-256 mismatch"):
            self.verify()

        self.setUp_clean_vendor()
        document = self.document()
        document["packages"]["uhlc-0.8.2"]["license"] = "invented"  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "archive identity or license drift"):
            self.verify(document)

        self.setUp_clean_vendor()
        (self.vendor / "unaccounted.txt").write_text("extra\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "unaccounted"):
            self.verify()

    def setUp_clean_vendor(self) -> None:
        shutil.rmtree(self.vendor)
        shutil.copytree(MODULE.VENDOR_ROOT, self.vendor)

    def test_rejects_duplicate_manifest_keys(self) -> None:
        path = self.vendor / "PROVENANCE.json"
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace(
                '"schema_version": 2',
                '"schema_version": 2, "schema_version": 2',
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            MODULE.load_json_strict(path)

    def test_rejects_lock_and_patch_resolution_drift(self) -> None:
        self.lock.write_text(
            self.lock.read_text(encoding="utf-8").replace(
                'name = "spin"\nversion = "0.12.2"',
                'name = "spin"\nversion = "0.12.1"',
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "resolve exactly spin"):
            self.verify()

        shutil.copy2(MODULE.LOCK_PATH, self.lock)
        self.cargo.write_text(
            self.cargo.read_text(encoding="utf-8").replace(
                'flume = { path = "vendor-compat/flume-0.11.1" }',
                'flume = { path = "vendor-compat/other" }',
            ),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "does not exactly name"):
            self.verify()

    def test_rejects_dormant_lz4_reintroduced_into_lock(self) -> None:
        self.lock.write_text(
            self.lock.read_text(encoding="utf-8")
            + '\n[[package]]\nname = "lz4_flex"\nversion = "0.10.0"\n',
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "retains lz4_flex"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
