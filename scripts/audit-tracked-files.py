#!/usr/bin/env python3
"""Inventory one immutable Git tree without following worktree symlinks.

The output is an inventory, not a claim that review occurred.  Review status
may be joined from an explicit JSON disposition map; absent entries remain
UNREVIEWED.  Blob bytes always come from Git, so a dirty worktree cannot change
the evidence for ``--ref``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any


REQUIRED_COLUMNS = (
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
)

EXTRA_COLUMNS = ("git_mode", "object_type", "text", "symlink_target")

LANGUAGES = {
    ".action": "ROS action",
    ".cff": "Citation File Format",
    ".cjs": "JavaScript",
    ".cpp": "C++",
    ".css": "CSS",
    ".csv": "CSV",
    ".glb": "glTF binary",
    ".h": "C/C++ header",
    ".html": "HTML",
    ".icns": "Apple icon",
    ".ico": "Windows icon",
    ".jpeg": "JPEG",
    ".jpg": "JPEG",
    ".js": "JavaScript",
    ".json": "JSON",
    ".launch": "ROS launch XML",
    ".lock": "lockfile",
    ".m": "Objective-C",
    ".md": "Markdown",
    ".mjs": "JavaScript",
    ".mm": "Objective-C++",
    ".msg": "ROS message",
    ".nix": "Nix",
    ".png": "PNG",
    ".proto": "Protocol Buffers",
    ".py": "Python",
    ".rs": "Rust",
    ".sh": "Shell",
    ".srv": "ROS service",
    ".svg": "SVG",
    ".toml": "TOML",
    ".ts": "TypeScript",
    ".tsx": "TypeScript React",
    ".txt": "text",
    ".urdf": "URDF XML",
    ".xml": "XML",
    ".yaml": "YAML",
    ".yml": "YAML",
}

TEXT_EXTENSIONS = {
    extension
    for extension, language in LANGUAGES.items()
    if language
    not in {"glTF binary", "Apple icon", "Windows icon", "JPEG", "PNG"}
}


@dataclass(frozen=True)
class TreeEntry:
    mode: str
    object_type: str
    object_id: str
    path: str


def git(repo: Path, *arguments: str, text: bool = False) -> bytes | str:
    return subprocess.check_output(
        ["git", "-C", str(repo), *arguments], text=text
    )


def parse_tree(repo: Path, ref: str) -> list[TreeEntry]:
    raw = git(repo, "ls-tree", "-r", "-z", "--full-tree", ref)
    assert isinstance(raw, bytes)
    entries: list[TreeEntry] = []
    for record in raw.split(b"\0"):
        if not record:
            continue
        metadata, encoded_path = record.split(b"\t", 1)
        mode, object_type, object_id = metadata.decode("ascii").split(" ")
        path = encoded_path.decode("utf-8", "surrogateescape")
        pure_path = PurePosixPath(path)
        if pure_path.is_absolute() or ".." in pure_path.parts:
            raise ValueError(f"unsafe path in Git tree: {path!r}")
        if object_type != "blob":
            raise ValueError(
                f"unsupported tracked object {object_type!r} at {path!r}"
            )
        entries.append(TreeEntry(mode, object_type, object_id, path))
    return entries


def read_blob(repo: Path, object_id: str) -> bytes:
    result = git(repo, "cat-file", "blob", object_id)
    assert isinstance(result, bytes)
    return result


def decode_text(path: str, mode: str, data: bytes) -> str | None:
    if mode == "120000":
        return data.decode("utf-8", "strict")
    extension = PurePosixPath(path).suffix.lower()
    if extension not in TEXT_EXTENSIONS and b"\0" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def language_for(path: str, mode: str, text: str | None) -> str:
    if mode == "120000":
        return "symbolic link"
    name = PurePosixPath(path).name
    if name in {"Dockerfile", "Makefile"}:
        return name
    if name.startswith("LICENSE"):
        return "license text"
    extension = PurePosixPath(path).suffix.lower()
    if extension in LANGUAGES:
        return LANGUAGES[extension]
    return "text" if text is not None else "binary"


def generated_by(path: str) -> tuple[str, str]:
    name = PurePosixPath(path).name
    if path == "bun.lock":
        return "YES", "bun install --frozen-lockfile"
    if name == "Cargo.lock":
        return "YES", "cargo metadata/build with --locked for verification"
    if path == "flake.lock":
        return "YES", "nix flake lock"
    if path == "src/__generated__/rust_types.ts":
        return "YES", "cargo test --features ts-export export-ts-types"
    if path.startswith(".superstack/security-reports/"):
        return "YES", "Superstack security-report tooling (external)"
    if path.startswith("src-tauri/icons/"):
        return "YES", "Tauri icon generation from project artwork"
    return "NO", ""


def flags_for(path: str) -> tuple[str, str, str, str]:
    lower = path.lower()
    public = (
        lower.endswith((".md", ".cff", ".msg", ".srv", ".action"))
        or lower.startswith(("public/", "assets/", "ros/", ".github/"))
        or lower
        in {
            "package.json",
            "src-tauri/cargo.toml",
            "src-tauri/tauri.conf.json",
        }
    )
    security = any(
        token in lower
        for token in (
            ".github/",
            "security",
            "cargo.lock",
            "bun.lock",
            "deny.toml",
            "path.rs",
            "transport/",
            "rosbridge",
            "ncp/",
            "galadriel",
            "plant-authority",
            "capabilities/",
            "authority-boundary",
            "release",
        )
    )
    science = any(
        token in lower
        for token in (
            "detection",
            "inference",
            "sensor_fusion",
            "sensor-fusion",
            "physics",
            "simulation",
            "model",
            "benchmark",
            "scenario",
            "pid_observation",
        )
    )
    authority = any(
        token in lower
        for token in (
            "authority",
            "plant-",
            "transport",
            "ros/",
            "ncp",
            "galadriel",
            "interception",
            "guidance",
            "gazebo",
            "capabilities/",
            "src-tauri/src/lib.rs",
        )
    )
    yes_no = lambda value: "YES" if value else "NO"
    return yes_no(public), yes_no(security), yes_no(science), yes_no(authority)


def load_review_map(
    path: Path | None,
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    if path is None:
        return {}, {}
    pairs_seen: set[str] = set()

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key {key!r} in {path}")
            result[key] = value
        return result

    document = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates)
    if document.get("schema_version") != 1 or not isinstance(document.get("files"), list):
        raise ValueError("review map must have schema_version 1 and a files array")
    packet_reviews = document.get("packet_reviews", {})
    if not isinstance(packet_reviews, dict):
        raise ValueError("review-map packet_reviews must be an object")
    for lane, review in packet_reviews.items():
        if not isinstance(lane, str) or not lane or not isinstance(review, dict):
            raise ValueError("packet_reviews entries must map lane names to objects")
    result: dict[str, dict[str, Any]] = {}
    for item in document["files"]:
        item_path = item.get("path")
        if not isinstance(item_path, str) or not item_path:
            raise ValueError("every review-map entry needs a nonempty path")
        if item_path in pairs_seen:
            raise ValueError(f"duplicate review-map path {item_path!r}")
        pairs_seen.add(item_path)
        result[item_path] = item
    return result, packet_reviews


def packet_assignments(packet_directory: Path | None) -> dict[str, str]:
    if packet_directory is None:
        return {}
    assignments: dict[str, str] = {}
    for packet in sorted(packet_directory.glob("lane-*.json")):
        document = json.loads(packet.read_text(encoding="utf-8"))
        files = document.get("files")
        if not isinstance(files, list):
            raise ValueError(f"{packet} has no files array")
        lane = packet.stem
        for path in files:
            if not isinstance(path, str) or not path:
                raise ValueError(f"{packet} contains an invalid path")
            if path in assignments:
                raise ValueError(f"{path!r} appears in multiple review packets")
            assignments[path] = lane
    return assignments


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--out", default="audit/generated")
    parser.add_argument("--review-map", type=Path)
    parser.add_argument("--packet-dir", type=Path)
    arguments = parser.parse_args()

    repo = Path(arguments.repo).resolve()
    output = (repo / arguments.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    commit = str(git(repo, "rev-parse", f"{arguments.ref}^{{commit}}", text=True)).strip()
    entries = parse_tree(repo, arguments.ref)
    review_map, packet_reviews = load_review_map(arguments.review_map)
    assignments = packet_assignments(arguments.packet_dir)
    tracked_paths = {entry.path for entry in entries}
    unknown_reviews = sorted(set(review_map) - tracked_paths)
    unknown_assignments = sorted(set(assignments) - tracked_paths)
    if unknown_reviews or unknown_assignments:
        raise ValueError(
            f"review metadata names untracked paths: {unknown_reviews + unknown_assignments}"
        )

    rows: list[dict[str, Any]] = []
    manifest_files: list[dict[str, Any]] = []
    for entry in entries:
        data = read_blob(repo, entry.object_id)
        text = decode_text(entry.path, entry.mode, data)
        line_count = (
            0
            if text is None
            else text.count("\n") + (1 if text and not text.endswith("\n") else 0)
        )
        digest = hashlib.sha256(data).hexdigest()
        generated, generator = generated_by(entry.path)
        public, security, science, authority = flags_for(entry.path)
        packet_review = packet_reviews.get(assignments.get(entry.path, ""), {})
        review = {**packet_review, **review_map.get(entry.path, {})}
        reviewer = review.get("reviewer", assignments.get(entry.path, ""))
        row: dict[str, Any] = {
            "path": entry.path,
            "git_blob_id": entry.object_id,
            "sha256": digest,
            "bytes": len(data),
            "lines": line_count,
            "language": language_for(entry.path, entry.mode, text),
            "generated": review.get("generated", generated),
            "generator": review.get("generator", generator),
            "public_surface": review.get("public_surface", public),
            "security_critical": review.get("security_critical", security),
            "science_critical": review.get("science_critical", science),
            "authority_critical": review.get("authority_critical", authority),
            "reviewer": reviewer,
            "review_status": review.get("review_status", "UNREVIEWED"),
            "requirements": review.get("requirements", ""),
            "assumptions": review.get("assumptions", ""),
            "defects": review.get("defects", ""),
            "tests": review.get("tests", ""),
            "evidence": review.get("evidence", ""),
            "disposition": review.get("disposition", ""),
            "completed_at": review.get("completed_at", ""),
            "git_mode": entry.mode,
            "object_type": entry.object_type,
            "text": "YES" if text is not None else "NO",
            "symlink_target": text if entry.mode == "120000" else "",
        }
        rows.append(row)
        manifest_files.append(
            {
                "path": entry.path,
                "git_mode": entry.mode,
                "git_blob_id": entry.object_id,
                "sha256": digest,
                "bytes": len(data),
                "lines": line_count,
                "language": row["language"],
                "text": text is not None,
                "symlink_target": row["symlink_target"] or None,
            }
        )

    with (output / "FILE_REVIEW_LEDGER.csv").open(
        "w", newline="", encoding="utf-8"
    ) as handle:
        writer = csv.DictWriter(handle, fieldnames=REQUIRED_COLUMNS + EXTRA_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)

    manifest = {
        "schema_version": 2,
        "repository": str(git(repo, "remote", "get-url", "origin", text=True)).strip(),
        "source_ref": arguments.ref,
        "source_commit": commit,
        "tracked_files": len(rows),
        "tracked_bytes": sum(int(row["bytes"]) for row in rows),
        "text_lines": sum(int(row["lines"]) for row in rows),
        "symlinks": sum(row["git_mode"] == "120000" for row in rows),
        "reviewed_files": sum(row["review_status"] != "UNREVIEWED" for row in rows),
        "files": manifest_files,
    }
    (output / "TRACKED_FILE_MANIFEST.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {key: manifest[key] for key in (
                "source_commit",
                "tracked_files",
                "tracked_bytes",
                "text_lines",
                "reviewed_files",
                "symlinks",
            )},
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
