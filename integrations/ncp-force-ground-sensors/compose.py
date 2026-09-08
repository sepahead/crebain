#!/usr/bin/env python3
"""Create a relocatable construction tree from explicitly selected, exact SDK bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

APP = Path(__file__).resolve().parent

def checked_dependency(source):
    source = source.resolve(strict=True)
    pin = json.loads((APP / "contracts/dependency-source.v1.json").read_bytes())
    def git(*args):
        return subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()
    if git("rev-parse", "HEAD") != pin["commit"] or git("rev-parse", "HEAD^{tree}") != pin["tree"]:
        raise ValueError("construction dependency revision drift")
    blobs = []
    for row in pin["files"]:
        relative = Path(row["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("invalid pinned relative path")
        candidate = source / relative
        if candidate.is_symlink() or not candidate.is_file() or candidate.resolve() != candidate:
            raise ValueError("construction dependency is not a direct regular file")
        blob = candidate.read_bytes()
        if len(blob) != row["bytes"] or hashlib.sha256(blob).hexdigest() != row["sha256"]:
            raise ValueError("construction dependency source drift: " + row["path"])
        blobs.append((relative, blob))
    return pin, blobs

def compose(source, destination):
    pin, blobs = checked_dependency(source)
    if destination.exists() or destination.is_symlink():
        raise ValueError("construction destination must be new")
    destination.mkdir(mode=0o700)
    # Reuse exactly the admitted snapshots; no reopening mutable source paths.
    for relative, blob in blobs:
        if relative.parts[:2] == ("local", "rust"):
            target = destination / "ncp-local" / Path(*relative.parts[2:])
        elif relative.parts[:3] == ("local", "python", "ncp_local"):
            target = destination / "sdk-python/ncp_local" / Path(*relative.parts[3:])
        else:
            raise ValueError("unselected dependency subtree")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
    for source_name, target_name in (("rust", "application"), ("contracts", "contracts"), ("python", "python")):
        source_dir = APP / source_name
        if source_dir.exists():
            shutil.copytree(source_dir, destination / target_name,
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "target"))
    roster = []
    for path in sorted(destination.rglob("*")):
        if path.is_symlink():
            raise ValueError("construction source symlink")
        if path.is_file():
            blob = path.read_bytes()
            roster.append({"path": path.relative_to(destination).as_posix(),
                           "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()})
    receipt = {"schema": "crebain.sensor-construction.v1", "dependency_commit": pin["commit"],
               "dependency_tree": pin["tree"], "dependency_ready": False,
               "files": roster, "installed_qualified": False}
    (destination / "construction.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ncp-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    receipt = compose(args.ncp_source, args.output)
    print(json.dumps({k: v for k, v in receipt.items() if k != "files"}))

if __name__ == "__main__":
    main()
