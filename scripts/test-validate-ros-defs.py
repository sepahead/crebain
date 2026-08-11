#!/usr/bin/env python3
"""Fail-closed regression tests for the ROS launch validator."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate_ros_defs.py")
SPEC = importlib.util.spec_from_file_location("validate_ros_defs", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_launch(directory: Path, source: str) -> Path:
    path = directory / "fixture.launch"
    path.write_text(source, encoding="utf-8")
    return path


with tempfile.TemporaryDirectory(prefix="crebain-ros-validator-") as temporary:
    directory = Path(temporary)
    valid = write_launch(
        directory,
        '<launch><group><include file="single.launch">'
        '<arg name="namespace" value="drone_0"/>'
        "</include></group></launch>\n",
    )
    assert MODULE.check_launch_file(valid) == []

    duplicate = write_launch(
        directory,
        '<launch><group ns="drone_0"><include file="single.launch">'
        '<arg name="namespace" value="drone_0"/>'
        "</include></group></launch>\n",
    )
    errors = MODULE.check_launch_file(duplicate)
    assert len(errors) == 1 and "repeat namespace 'drone_0'" in errors[0]

    malformed = write_launch(directory, "<launch><group></launch>\n")
    errors = MODULE.check_launch_file(malformed)
    assert len(errors) == 1 and "invalid XML" in errors[0]

print("OK: ROS launch validator rejected duplicate namespaces and malformed XML")
