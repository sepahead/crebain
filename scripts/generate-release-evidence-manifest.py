#!/usr/bin/env python3
"""Generate a deterministic digest manifest for a prepared release directory."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
from pathlib import Path, PurePosixPath

COMMIT = re.compile(r"^[0-9a-f]{40}$")
MEDIA_TYPES = {
    ".appimage": "application/vnd.appimage",
    ".deb": "application/vnd.debian.binary-package",
    ".dmg": "application/x-apple-diskimage",
    ".gz": "application/gzip",
    ".json": "application/json",
    ".txt": "text/plain",
}
APPLICATION_MEDIA_TYPES = {
    ".AppImage": "application/vnd.appimage",
    ".deb": "application/vnd.debian.binary-package",
    ".dmg": "application/x-apple-diskimage",
}


def media_type_for(path: str) -> str:
    """Return a platform-independent media type for the sealed artifact."""
    return MEDIA_TYPES.get(PurePosixPath(path).suffix.lower(), "application/octet-stream")


def role_for(path: str) -> str:
    if path.startswith("application/"):
        package = PurePosixPath(path)
        if len(package.parts) != 2 or package.suffix not in APPLICATION_MEDIA_TYPES:
            raise ValueError(
                "application artifacts must be top-level .dmg, .AppImage, or .deb packages: "
                f"{path}"
            )
        return "application-package"
    if path.endswith("qualification-logs.tar.gz"):
        return "automated-qualification-archive"
    if path.endswith(".spdx.json"):
        return "software-bill-of-materials"
    if path.endswith("cargo-metadata.json"):
        return "resolved-rust-dependency-graph"
    if path.endswith("SHA256SUMS"):
        return "checksum-index"
    return "release-evidence"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--commit", required=True)
    arguments = parser.parse_args()

    if not COMMIT.fullmatch(arguments.commit):
        parser.error("--commit must be a lowercase 40-hex Git commit")
    root = arguments.root.resolve(strict=True)
    output = arguments.output.resolve(strict=False)
    try:
        output.relative_to(root)
    except ValueError:
        parser.error("--output must be inside --root")
    if arguments.output.is_symlink():
        parser.error("--output must not be a symbolic link")

    artifacts: list[dict[str, object]] = []
    try:
        for path in sorted(root.rglob("*")):
            metadata = path.lstat()
            if path == output:
                continue
            if stat.S_ISDIR(metadata.st_mode):
                continue
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise ValueError(f"release evidence must contain only regular files: {path}")
            relative = path.relative_to(root).as_posix()
            if relative == ".DS_Store":
                raise ValueError(".DS_Store is forbidden in release evidence")
            digest = hashlib.sha256()
            byte_count = 0
            with path.open("rb") as handle:
                while block := handle.read(1024 * 1024):
                    digest.update(block)
                    byte_count += len(block)
            artifacts.append(
                {
                    "path": relative,
                    "sha256": digest.hexdigest(),
                    "bytes": byte_count,
                    "media_type": media_type_for(relative),
                    "role": role_for(relative),
                }
            )
        if not artifacts:
            raise ValueError("release evidence directory is empty")
        output.write_text(
            json.dumps(
                {
                    "manifest_schema": "1.0.0",
                    "source_commit": arguments.commit,
                    "artifacts": artifacts,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
    except (OSError, ValueError) as error:
        print(f"RELEASE MANIFEST GENERATION FAILED: {error}", file=sys.stderr)
        return 2
    print(f"WROTE {len(artifacts)} digest-bound release artifacts to {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
