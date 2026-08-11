#!/usr/bin/env python3
"""Structural validator for the reference ROS interface definitions in ros/.

These files are reference-only (not a complete colcon package), so instead of a
full build this checks that:
  - package.xml is well-formed XML
  - each launch file is well-formed XML
  - a launch group does not repeat an included drone namespace
  - every .msg / .srv line is a comment, blank, a service separator (---), or a
    valid `Type field` / `Type field = constant` declaration.

Exits non-zero on the first malformed definition.
"""
from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROS_DIR = Path(__file__).resolve().parent.parent / "ros"

# Type (with optional array/bounded-array suffix) followed by a field name, with
# an optional constant assignment.
FIELD_RE = re.compile(
    r"^[A-Za-z][A-Za-z0-9_/]*(\[[0-9]*\]|\[<=[0-9]+\])?\s+[A-Za-z][A-Za-z0-9_]*"
    r"(\s*=\s*.+)?$"
)


def check_interface_file(path: Path) -> list[str]:
    errors: list[str] = []
    for lineno, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line or line == "---":
            continue
        if not FIELD_RE.match(line):
            errors.append(f"{path}:{lineno}: malformed definition: {raw!r}")
    return errors


def check_launch_file(path: Path) -> list[str]:
    """Validate launch XML and reject a repeated effective namespace."""
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as exc:
        return [f"{path}: invalid XML: {exc}"]

    errors: list[str] = []
    for group in root.iter("group"):
        group_namespace = group.get("ns")
        if not group_namespace:
            continue
        for include in group.iter("include"):
            for argument in include.findall("arg"):
                if (
                    argument.get("name") == "namespace"
                    and argument.get("value") == group_namespace
                ):
                    errors.append(
                        f"{path}: group and included launch repeat namespace "
                        f"{group_namespace!r}"
                    )
    return errors


def main() -> int:
    if not ROS_DIR.is_dir():
        print(f"✖ ros/ directory not found at {ROS_DIR}")
        return 1

    errors: list[str] = []
    checked = 0

    for xml_path in ROS_DIR.rglob("package.xml"):
        try:
            ET.parse(xml_path)
            checked += 1
        except ET.ParseError as exc:
            errors.append(f"{xml_path}: invalid XML: {exc}")

    for launch_path in ROS_DIR.rglob("*.launch"):
        errors.extend(check_launch_file(launch_path))
        checked += 1

    for ext in ("*.msg", "*.srv"):
        for path in ROS_DIR.rglob(ext):
            errors.extend(check_interface_file(path))
            checked += 1

    if errors:
        print("\n".join(errors))
        print(f"\n✖ {len(errors)} malformed ROS definition(s).")
        return 1

    print(f"✓ {checked} ROS reference file(s) validated.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
