#!/usr/bin/env python3
"""Create or verify a path-safe SHA-256 inventory of an external handoff tree."""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import sys
import zipfile
from pathlib import Path


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".zip":
        return "zip-archive"
    if suffix in {".md", ".txt", ".yaml", ".yml", ".csv"}:
        return "text"
    if suffix == ".json":
        return "json"
    return "opaque"


def inventory(source: Path, label: str) -> dict[str, object]:
    source = source.resolve(strict=True)
    if not source.is_dir():
        raise ValueError("handoff source is not a directory")
    files: list[dict[str, object]] = []
    total_bytes = 0
    archive_members = 0
    for path in sorted(source.rglob("*")):
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(f"handoff contains a symbolic link: {path.relative_to(source)}")
        if path.is_dir():
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"handoff contains a special file: {path.relative_to(source)}")
        relative = path.relative_to(source).as_posix()
        entry: dict[str, object] = {
            "path": relative,
            "bytes": metadata.st_size,
            "sha256": digest(path),
            "kind": kind(path),
        }
        if path.suffix.lower() == ".zip":
            with zipfile.ZipFile(path) as archive:
                corrupt = archive.testzip()
                if corrupt is not None:
                    raise ValueError(f"corrupt ZIP member in {relative}: {corrupt}")
                members = [member for member in archive.infolist() if not member.is_dir()]
                if any(
                    Path(member.filename).is_absolute() or ".." in Path(member.filename).parts
                    for member in members
                ):
                    raise ValueError(f"unsafe ZIP member path in {relative}")
                entry["regular_members"] = len(members)
                archive_members += len(members)
        files.append(entry)
        total_bytes += metadata.st_size
    return {
        "schema_version": 1,
        "handoff_root": label,
        "prepared": "2026-07-14",
        "frozen_crebain_commit": "4c311900ade5668200a48d56fb191be1916b884a",
        "cryptographic_signature": None,
        "signature_status": "NOT_PROVIDED; SHA-256 inventory is integrity evidence, not signer identity",
        "file_count": len(files),
        "total_bytes": total_bytes,
        "zip_regular_member_count": archive_members,
        "files": files,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--write", action="store_true")
    arguments = parser.parse_args()
    try:
        rendered = json.dumps(
            inventory(arguments.source, arguments.label), indent=2, sort_keys=True
        ) + "\n"
        if arguments.write:
            arguments.output.write_text(rendered, encoding="utf-8")
        elif arguments.output.read_text(encoding="utf-8") != rendered:
            raise ValueError("tracked handoff input manifest drift")
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"HANDOFF INVENTORY FAILED: {error}", file=sys.stderr)
        return 1
    document = json.loads(rendered)
    print(
        f"OK: inventoried {document['file_count']} handoff files and "
        f"{document['zip_regular_member_count']} ZIP members"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
