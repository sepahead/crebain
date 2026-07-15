#!/usr/bin/env python3
"""Adversarial self-tests for verify-evidence-manifest.py."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify-evidence-manifest.py")
SPEC = importlib.util.spec_from_file_location("verify_evidence_manifest", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ManifestError = MODULE.ManifestError
verify_manifest = MODULE.verify_manifest

GENERATOR_SCRIPT = Path(__file__).with_name("generate-release-evidence-manifest.py")
GENERATOR_SPEC = importlib.util.spec_from_file_location(
    "generate_release_evidence_manifest", GENERATOR_SCRIPT
)
assert GENERATOR_SPEC and GENERATOR_SPEC.loader
GENERATOR = importlib.util.module_from_spec(GENERATOR_SPEC)
GENERATOR_SPEC.loader.exec_module(GENERATOR)


class EvidenceManifestTests(unittest.TestCase):
    commit = "a" * 40

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.artifact = self.root / "evidence.txt"
        self.artifact.write_bytes(b"bounded evidence\n")
        self.manifest = self.root / "manifest.json"
        self.write_manifest()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def document(self) -> dict[str, object]:
        data = self.artifact.read_bytes()
        return {
            "manifest_schema": "1.0.0",
            "source_commit": self.commit,
            "artifacts": [
                {
                    "path": "evidence.txt",
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "bytes": len(data),
                    "media_type": "text/plain",
                    "role": "test-vector",
                }
            ],
        }

    def write_manifest(self, document: dict[str, object] | None = None) -> None:
        self.manifest.write_text(
            json.dumps(document or self.document()), encoding="utf-8"
        )

    def assert_rejected(self, pattern: str) -> None:
        with self.assertRaisesRegex(ManifestError, pattern):
            verify_manifest(self.manifest, self.root, self.commit)

    def test_accepts_exact_regular_artifact(self) -> None:
        self.assertEqual(verify_manifest(self.manifest, self.root, self.commit), 1)

    def test_rejects_empty_artifact_list(self) -> None:
        document = self.document()
        document["artifacts"] = []
        self.write_manifest(document)
        self.assert_rejected("nonempty")

    def test_rejects_duplicate_json_keys(self) -> None:
        self.manifest.write_text(
            '{"manifest_schema":"1.0.0","manifest_schema":"1.0.0",'
            f'"source_commit":"{self.commit}","artifacts":[]}}',
            encoding="utf-8",
        )
        self.assert_rejected("duplicate JSON key")

    def test_rejects_parent_traversal_and_absolute_paths(self) -> None:
        for unsafe in ("../evidence.txt", str(self.artifact)):
            document = self.document()
            document["artifacts"][0]["path"] = unsafe  # type: ignore[index]
            self.write_manifest(document)
            self.assert_rejected("normalized and relative")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_rejects_symlink_even_when_target_is_inside_root(self) -> None:
        link = self.root / "link.txt"
        link.symlink_to(self.artifact.name)
        document = self.document()
        document["artifacts"][0]["path"] = link.name  # type: ignore[index]
        self.write_manifest(document)
        self.assert_rejected("symbolic link")

    def test_rejects_duplicate_artifact_paths(self) -> None:
        document = self.document()
        document["artifacts"] = [
            document["artifacts"][0],  # type: ignore[index]
            dict(document["artifacts"][0]),  # type: ignore[index]
        ]
        self.write_manifest(document)
        self.assert_rejected("duplicate artifact path")

    def test_rejects_missing_or_malformed_metadata(self) -> None:
        document = self.document()
        del document["artifacts"][0]["role"]  # type: ignore[index]
        self.write_manifest(document)
        self.assert_rejected("fields differ")

        document = self.document()
        document["artifacts"][0]["media_type"] = "not a media type"  # type: ignore[index]
        self.write_manifest(document)
        self.assert_rejected("invalid media type")

        document = self.document()
        document["artifacts"][0]["role"] = "../unsafe"  # type: ignore[index]
        self.write_manifest(document)
        self.assert_rejected("invalid artifact role")

    def test_rejects_application_role_outside_application_directory(self) -> None:
        document = self.document()
        document["artifacts"][0]["role"] = "application-package"  # type: ignore[index]
        self.write_manifest(document)
        self.assert_rejected("restricted to application")

    def test_rejects_unsupported_nested_or_misclassified_application_packages(self) -> None:
        application = self.root / "application"
        application.mkdir()
        cases = (
            ("app.rpm", "application/x-rpm", "application-package", "must be .dmg"),
            (
                "app.dmg",
                "application/octet-stream",
                "application-package",
                "invalid media type",
            ),
            (
                "app.deb",
                "application/vnd.debian.binary-package",
                "release-evidence",
                "invalid role",
            ),
        )
        for name, media_type, role, error in cases:
            with self.subTest(name=name, media_type=media_type, role=role):
                package = application / name
                package.write_bytes(b"package\n")
                document = self.document()
                document["artifacts"][0].update(  # type: ignore[index]
                    {
                        "path": f"application/{name}",
                        "sha256": hashlib.sha256(b"package\n").hexdigest(),
                        "bytes": len(b"package\n"),
                        "media_type": media_type,
                        "role": role,
                    }
                )
                self.write_manifest(document)
                self.assert_rejected(error)
                package.unlink()

        nested = application / "nested"
        nested.mkdir()
        package = nested / "app.dmg"
        package.write_bytes(b"package\n")
        document = self.document()
        document["artifacts"][0].update(  # type: ignore[index]
            {
                "path": "application/nested/app.dmg",
                "sha256": hashlib.sha256(b"package\n").hexdigest(),
                "bytes": len(b"package\n"),
                "media_type": "application/x-apple-diskimage",
                "role": "application-package",
            }
        )
        self.write_manifest(document)
        self.assert_rejected("one safe top-level basename")

    def test_generator_rejects_non_allowlisted_application_paths(self) -> None:
        for path in ("application/app.rpm", "application/nested/app.dmg"):
            with self.subTest(path=path):
                with self.assertRaisesRegex(ValueError, "top-level .dmg"):
                    GENERATOR.role_for(path)

    def test_rejects_unsealed_regular_file(self) -> None:
        (self.root / "omitted.txt").write_text("not in manifest\n", encoding="utf-8")
        self.assert_rejected("inventory differs")

    def test_rejects_digest_byte_and_commit_mismatch(self) -> None:
        document = self.document()
        document["artifacts"][0]["sha256"] = "0" * 64  # type: ignore[index]
        self.write_manifest(document)
        self.assert_rejected("digest mismatch")

        document = self.document()
        document["artifacts"][0]["bytes"] = 1  # type: ignore[index]
        self.write_manifest(document)
        self.assert_rejected("byte count mismatch")

        self.write_manifest()
        with self.assertRaisesRegex(ManifestError, "source_commit mismatch"):
            verify_manifest(self.manifest, self.root, "b" * 40)

    def test_generator_classification_is_deterministic(self) -> None:
        self.assertEqual(
            GENERATOR.media_type_for("application/app.AppImage"),
            "application/vnd.appimage",
        )
        self.assertEqual(
            GENERATOR.role_for("evidence/qualification-logs.tar.gz"),
            "automated-qualification-archive",
        )
        self.assertEqual(
            GENERATOR.role_for("evidence/crebain.spdx.json"),
            "software-bill-of-materials",
        )


if __name__ == "__main__":
    unittest.main()
