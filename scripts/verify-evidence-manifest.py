#!/usr/bin/env python3
"""Verify a digest-bound evidence manifest without path or JSON ambiguity."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath
from typing import Any


SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
MEDIA_TYPE = re.compile(r"^[a-z0-9][a-z0-9.+-]{0,63}/[a-z0-9][a-z0-9.+-]{0,63}$")
ROLE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9._+-]+$")
APPLICATION_MEDIA_TYPES = {
    ".AppImage": "application/vnd.appimage",
    ".deb": "application/vnd.debian.binary-package",
    ".dmg": "application/x-apple-diskimage",
}


class ManifestError(ValueError):
    """Raised when evidence is ambiguous, unsafe, missing, or mismatched."""


def load_json_strict(path: Path) -> Any:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ManifestError(f"duplicate JSON key {key!r}")
            result[key] = value
        return result

    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates)
    except UnicodeDecodeError as error:
        raise ManifestError(f"manifest is not UTF-8: {error}") from error
    except json.JSONDecodeError as error:
        raise ManifestError(f"manifest is invalid JSON: {error}") from error


def safe_artifact_path(root: Path, value: Any) -> tuple[Path, str]:
    if not isinstance(value, str) or not value:
        raise ManifestError("artifact path must be a nonempty string")
    if "\\" in value or "\x00" in value:
        raise ManifestError(f"artifact path uses a forbidden separator or NUL: {value!r}")
    relative = PurePosixPath(value)
    if relative.is_absolute() or value != relative.as_posix() or ".." in relative.parts:
        raise ManifestError(f"artifact path is not normalized and relative: {value!r}")
    candidate = root.joinpath(*relative.parts)
    try:
        metadata = candidate.lstat()
    except FileNotFoundError as error:
        raise ManifestError(f"missing artifact: {value}") from error
    if stat.S_ISLNK(metadata.st_mode):
        raise ManifestError(f"artifact must not be a symbolic link: {value}")
    if not stat.S_ISREG(metadata.st_mode):
        raise ManifestError(f"artifact must be a regular file: {value}")
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ManifestError(f"artifact escapes evidence root: {value}") from error
    return resolved, value


def verify_manifest(
    manifest_path: Path,
    root: Path,
    expected_commit: str | None = None,
) -> int:
    manifest_path = manifest_path.resolve(strict=True)
    root = root.resolve(strict=True)
    try:
        manifest_relative = manifest_path.relative_to(root).as_posix()
    except ValueError as error:
        raise ManifestError("manifest must be inside the evidence root") from error
    document = load_json_strict(manifest_path)
    if not isinstance(document, dict):
        raise ManifestError("manifest root must be an object")
    if document.get("manifest_schema") != "1.0.0":
        raise ManifestError("manifest_schema must equal '1.0.0'")
    source_commit = document.get("source_commit")
    if not isinstance(source_commit, str) or not COMMIT.fullmatch(source_commit):
        raise ManifestError("source_commit must be a lowercase 40-hex Git commit")
    if expected_commit is not None:
        if not COMMIT.fullmatch(expected_commit):
            raise ManifestError("--expected-commit must be lowercase 40-hex")
        if source_commit != expected_commit:
            raise ManifestError(
                f"source_commit mismatch: expected {expected_commit}, got {source_commit}"
            )
    artifacts = document.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise ManifestError("artifacts must be a nonempty array")

    seen_paths: set[str] = set()
    verified = 0
    for index, item in enumerate(artifacts):
        if not isinstance(item, dict):
            raise ManifestError(f"artifacts[{index}] must be an object")
        allowed_keys = {"path", "sha256", "bytes", "media_type", "role"}
        actual_keys = set(item)
        if actual_keys != allowed_keys:
            raise ManifestError(
                f"artifacts[{index}] fields differ: "
                f"missing={sorted(allowed_keys - actual_keys)}, "
                f"unknown={sorted(actual_keys - allowed_keys)}"
            )
        path, display_path = safe_artifact_path(root, item.get("path"))
        if display_path == manifest_relative:
            raise ManifestError("manifest must not list itself as an artifact")
        if display_path in seen_paths:
            raise ManifestError(f"duplicate artifact path: {display_path}")
        seen_paths.add(display_path)
        expected_digest = item.get("sha256")
        if not isinstance(expected_digest, str) or not SHA256.fullmatch(expected_digest):
            raise ManifestError(f"invalid SHA-256 for {display_path}")
        expected_bytes = item.get("bytes")
        if (
            isinstance(expected_bytes, bool)
            or not isinstance(expected_bytes, int)
            or expected_bytes < 0
        ):
            raise ManifestError(f"invalid byte count for {display_path}")
        media_type = item.get("media_type")
        if not isinstance(media_type, str) or not MEDIA_TYPE.fullmatch(media_type):
            raise ManifestError(f"invalid media type for {display_path}")
        role = item.get("role")
        if not isinstance(role, str) or len(role) > 64 or not ROLE.fullmatch(role):
            raise ManifestError(f"invalid artifact role for {display_path}")
        relative = PurePosixPath(display_path)
        if relative.parts[0] == "application":
            if len(relative.parts) != 2 or not PACKAGE_NAME.fullmatch(relative.name):
                raise ManifestError(
                    "application package must have one safe top-level basename: "
                    f"{display_path}"
                )
            expected_media_type = APPLICATION_MEDIA_TYPES.get(relative.suffix)
            if expected_media_type is None:
                raise ManifestError(
                    "application package must be .dmg, .AppImage, or .deb: "
                    f"{display_path}"
                )
            if role != "application-package":
                raise ManifestError(
                    f"application package has invalid role: {display_path}"
                )
            if media_type != expected_media_type:
                raise ManifestError(
                    f"application package has invalid media type: {display_path}"
                )
        elif role == "application-package":
            raise ManifestError(
                "application-package role is restricted to application/: "
                f"{display_path}"
            )

        digest = hashlib.sha256()
        actual_bytes = 0
        flags = getattr(os, "O_NOFOLLOW", 0) | os.O_RDONLY
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise ManifestError(
                    f"artifact changed type while opening: {display_path}"
                )
            while True:
                block = os.read(descriptor, 1024 * 1024)
                if not block:
                    break
                actual_bytes += len(block)
                digest.update(block)
        finally:
            os.close(descriptor)
        if actual_bytes != expected_bytes:
            raise ManifestError(
                f"byte count mismatch for {display_path}: "
                f"expected {expected_bytes}, got {actual_bytes}"
            )
        actual_digest = digest.hexdigest()
        if actual_digest != expected_digest:
            raise ManifestError(
                f"digest mismatch for {display_path}: "
                f"expected {expected_digest}, got {actual_digest}"
            )
        verified += 1

    actual_paths: set[str] = set()
    for candidate in root.rglob("*"):
        metadata = candidate.lstat()
        relative = candidate.relative_to(root).as_posix()
        if relative == manifest_relative:
            continue
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ManifestError(f"unsealed special or symbolic-link entry: {relative}")
        actual_paths.add(relative)
    if actual_paths != seen_paths:
        raise ManifestError(
            "manifest artifact inventory differs from evidence root: "
            f"missing={sorted(actual_paths - seen_paths)}, "
            f"unexpected={sorted(seen_paths - actual_paths)}"
        )
    return verified


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--expected-commit")
    arguments = parser.parse_args()
    try:
        count = verify_manifest(
            arguments.manifest, arguments.root, arguments.expected_commit
        )
    except (ManifestError, OSError) as error:
        print(f"EVIDENCE VERIFICATION FAILED: {error}", file=sys.stderr)
        return 2
    print(f"VERIFIED {count} digest-bound evidence artifacts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
