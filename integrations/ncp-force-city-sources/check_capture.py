#!/usr/bin/env python3
"""Run explicit optional capture controls with selected installed Prisoma bytes."""

import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sys
import unittest

import prisoma_ncp_transcript
from prisoma_ncp_transcript import transcript
from ncp_local import modular_client, modular_owner, modular_wire

APP = Path(__file__).resolve().parent
sys.path[:0] = [str(APP / "tests"), str(APP / "capture-tests")]


def inventory():
    rows = []
    for module in (
        prisoma_ncp_transcript,
        transcript,
        modular_client,
        modular_owner,
        modular_wire,
    ):
        path = Path(module.__file__).resolve(strict=True)
        payload = path.read_bytes()
        rows.append(
            {
                "module": module.__name__,
                "path": str(path),
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
    return rows


def main():
    before = inventory()
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.discover(str(APP / "capture-tests"))
    )
    unchanged = before == inventory()
    passed = result.wasSuccessful() and not result.skipped and unchanged
    print(
        json.dumps(
            {
                "schema": "crebain.city-capture-owner-controls.v1",
                "passed": passed,
                "tests": result.testsRun,
                "skipped": len(result.skipped),
                "python": sys.executable,
                "prisoma_version": version("prisoma-ncp-transcript"),
                "module_files": before,
                "module_files_unchanged": unchanged,
                "scope": "source CPU controls and actual optional transcript owner; no installed runtime qualification",
            }
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
