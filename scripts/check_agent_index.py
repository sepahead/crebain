#!/usr/bin/env python3
"""Check this repository's agent-readable index, `agent-index.json`.

The index tells an agent, in machine-readable form, how to work in the repository:
its entry documents, delivery path, local gates and when each applies, generated,
frozen and optionally shared artifacts, and its ecosystem relations. AGENTS.md
remains the operating contract; the index restates its operational facts so that
tools can act on them.

This check keeps the index from rotting silently. It verifies the schema, that every
referenced path exists in the working tree, that every repository script named in a
command exists, that gate identifiers are unique, and that no machine-specific path
appears. It cannot check that a command is the right one; review does that.

Usage: python3 <this script> [--root DIR]
Standard library only.
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import shlex
import sys
from pathlib import Path

SCHEMA = "sepahead.agent-index.v1"
TOP = {
    "schema": str,
    "repository": str,
    "summary": str,
    "entry_documents": list,
    "delivery": dict,
    "gates": list,
    "generated": list,
    "frozen": list,
    "ecosystem": list,
}
DELIVERY = {
    "default_branch": str,
    "merge": str,
    "signing": str,
    "attribution": str,
    "owner_only": list,
}
GATE = {"id": str, "when": str, "command": str, "cost": str}
COSTS = {"fast", "medium", "full"}
SCRIPT_SUFFIXES = (".py", ".sh", ".mjs", ".js", ".ts", ".rb", ".pl")
MACHINE_PATH = re.compile(r"(/Users/|/home/|/private/|/tmp/|[A-Za-z]:\\\\)")


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def typed(errors: list[str], where: str, obj: object, spec: dict[str, type]) -> bool:
    if not isinstance(obj, dict):
        fail(errors, f"{where}: expected an object")
        return False
    for key, kind in spec.items():
        if key not in obj:
            fail(errors, f"{where}: missing '{key}'")
        elif not isinstance(obj[key], kind):
            fail(errors, f"{where}.{key}: expected {kind.__name__}")
    return True


def path_exists(root: Path, pattern: str) -> bool:
    if any(ch in pattern for ch in "*?["):
        return bool(glob.glob(str(root / pattern), recursive=True))
    return (root / pattern.rstrip("/")).exists()


def command_paths(command: str) -> list[str]:
    """Repository-relative script paths named in a shell command."""
    paths = []
    for part in re.split(r"&&|\|\||;|\|", command):
        try:
            tokens = shlex.split(part)
        except ValueError:
            tokens = part.split()
        for token in tokens:
            token = token.strip()
            if token.startswith("-") or "=" in token.split("/")[0]:
                continue
            if token.endswith(SCRIPT_SUFFIXES) and not token.startswith(
                ("http:", "https:")
            ):
                paths.append(token[2:] if token.startswith("./") else token)
    return paths


def check(root: Path) -> list[str]:
    errors: list[str] = []
    index_path = root / "agent-index.json"
    try:
        raw = index_path.read_text(encoding="utf-8")
        index = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        return [f"agent-index.json: {error}"]
    if MACHINE_PATH.search(raw):
        fail(errors, "agent-index.json: contains a machine-specific path")
    if not typed(errors, "index", index, TOP):
        return errors
    if index["schema"] != SCHEMA:
        fail(errors, f"schema: expected '{SCHEMA}'")
    typed(errors, "delivery", index["delivery"], DELIVERY)
    for i, doc in enumerate(index["entry_documents"]):
        if typed(errors, f"entry_documents[{i}]", doc, {"path": str, "role": str}):
            if not path_exists(root, doc["path"]):
                fail(errors, f"entry_documents[{i}]: missing path {doc['path']}")
    seen: set[str] = set()
    for i, gate in enumerate(index["gates"]):
        if not typed(errors, f"gates[{i}]", gate, GATE):
            continue
        if gate["id"] in seen:
            fail(errors, f"gates[{i}]: duplicate id {gate['id']}")
        seen.add(gate["id"])
        if gate["cost"] not in COSTS:
            fail(errors, f"gates[{i}]: cost must be one of {sorted(COSTS)}")
        for script in command_paths(gate["command"]):
            if not path_exists(root, script):
                fail(errors, f"gates[{i}] ({gate['id']}): missing script {script}")
        env = gate.get("environment")
        if env is not None and not path_exists(root, env):
            fail(errors, f"gates[{i}] ({gate['id']}): missing environment file {env}")
    if "shared" in index and not isinstance(index["shared"], list):
        fail(errors, "index.shared: expected list")
    for section in ("generated", "frozen", "shared"):
        for i, item in enumerate(index.get(section) or []):
            spec = (
                {"path": str, "regenerate": str}
                if section == "generated"
                else {"path": str, "reason": str}
            )
            if typed(errors, f"{section}[{i}]", item, spec):
                if not path_exists(root, item["path"]):
                    fail(errors, f"{section}[{i}]: missing path {item['path']}")
                if section == "generated":
                    for script in command_paths(item["regenerate"]):
                        if not path_exists(root, script):
                            fail(errors, f"generated[{i}]: missing script {script}")
    for i, link in enumerate(index["ecosystem"]):
        typed(errors, f"ecosystem[{i}]", link, {"repository": str, "relation": str})
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    args = parser.parse_args()
    errors = check(args.root.resolve())
    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)
    if errors:
        return 1
    index = json.loads((args.root / "agent-index.json").read_text(encoding="utf-8"))
    counts = {key: len(index[key]) for key in ("entry_documents", "gates")}
    print(
        f"OK agent-index.json: {counts['entry_documents']} documents, "
        f"{counts['gates']} gates, {len(index['generated'])} generated and "
        f"{len(index['frozen'])} frozen artifacts"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
