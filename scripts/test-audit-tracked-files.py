#!/usr/bin/env python3
"""Self-tests for the immutable Git-tree audit generator."""

from __future__ import annotations

import csv
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("audit-tracked-files.py")


def run(*arguments: str, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [*arguments],
        cwd=cwd,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class AuditTrackedFilesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.repo = Path(self.temporary.name) / "repo"
        self.repo.mkdir()
        run("git", "init", "--quiet", cwd=self.repo)
        run("git", "config", "user.name", "Audit Test", cwd=self.repo)
        run("git", "config", "user.email", "audit@example.invalid", cwd=self.repo)
        run("git", "remote", "add", "origin", "https://example.invalid/test.git", cwd=self.repo)
        (self.repo / "plain.txt").write_text("tracked\n", encoding="utf-8")
        (self.repo / "binary.bin").write_bytes(b"\x00\x01\x02")
        if hasattr(os, "symlink"):
            (self.repo / "link.txt").symlink_to("plain.txt")
        run("git", "add", ".", cwd=self.repo)
        run("git", "commit", "--quiet", "-m", "fixture", cwd=self.repo)
        self.commit = run("git", "rev-parse", "HEAD", cwd=self.repo).stdout.strip()
        self.output = self.repo / "output"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def audit(self, *arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return run(
            "python3",
            str(SCRIPT),
            "--repo",
            str(self.repo),
            "--ref",
            self.commit,
            "--out",
            str(self.output),
            *arguments,
            cwd=self.repo,
            check=check,
        )

    def rows(self) -> list[dict[str, str]]:
        with (self.output / "FILE_REVIEW_LEDGER.csv").open(
            newline="", encoding="utf-8"
        ) as handle:
            return list(csv.DictReader(handle))

    def test_reads_committed_blobs_not_dirty_worktree(self) -> None:
        (self.repo / "plain.txt").write_text("dirty and different\n", encoding="utf-8")
        self.audit()
        row = next(item for item in self.rows() if item["path"] == "plain.txt")
        self.assertEqual(
            row["sha256"],
            "e544535ca87c45bbcf3495423e0781d4fba16276f78a5e07a1049447cdc1e63e",
        )
        self.assertEqual(row["bytes"], "8")

    def test_emits_every_required_column_and_binary_identity(self) -> None:
        self.audit()
        rows = self.rows()
        self.assertEqual(len(rows), 3 if hasattr(os, "symlink") else 2)
        required = {
            "path",
            "git_blob_id",
            "sha256",
            "bytes",
            "lines",
            "language",
            "generated",
            "generator",
            "public_surface",
            "security_critical",
            "science_critical",
            "authority_critical",
            "reviewer",
            "review_status",
            "requirements",
            "assumptions",
            "defects",
            "tests",
            "evidence",
            "disposition",
            "completed_at",
        }
        self.assertTrue(required.issubset(rows[0]))
        binary = next(item for item in rows if item["path"] == "binary.bin")
        self.assertEqual(binary["text"], "NO")
        self.assertEqual(binary["lines"], "0")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_records_symlink_blob_without_following_target(self) -> None:
        (self.repo / "plain.txt").write_text("changed target\n", encoding="utf-8")
        self.audit()
        link = next(item for item in self.rows() if item["path"] == "link.txt")
        self.assertEqual(link["git_mode"], "120000")
        self.assertEqual(link["symlink_target"], "plain.txt")
        self.assertEqual(link["bytes"], "9")

    def test_joins_explicit_review_metadata_and_packet_assignment(self) -> None:
        review_map = self.repo / "review.json"
        review_map.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "files": [
                        {
                            "path": "plain.txt",
                            "reviewer": "reviewer-a",
                            "review_status": "SEPARATE_AGENT_REVIEWED",
                            "completed_at": "2026-07-14",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        packets = self.repo / "packets"
        packets.mkdir()
        (packets / "lane-1.json").write_text(
            json.dumps({"files": ["binary.bin"], "lines": 0}), encoding="utf-8"
        )
        self.audit("--review-map", str(review_map), "--packet-dir", str(packets))
        by_path = {item["path"]: item for item in self.rows()}
        self.assertEqual(by_path["plain.txt"]["reviewer"], "reviewer-a")
        self.assertEqual(
            by_path["plain.txt"]["review_status"], "SEPARATE_AGENT_REVIEWED"
        )
        self.assertEqual(by_path["binary.bin"]["reviewer"], "lane-1")
        self.assertEqual(by_path["binary.bin"]["review_status"], "UNREVIEWED")

    def test_rejects_review_paths_not_in_frozen_tree(self) -> None:
        review_map = self.repo / "review.json"
        review_map.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "files": [{"path": "missing.txt", "review_status": "REVIEWED"}],
                }
            ),
            encoding="utf-8",
        )
        result = self.audit("--review-map", str(review_map), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("untracked paths", result.stderr)


if __name__ == "__main__":
    unittest.main()
