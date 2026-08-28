#!/usr/bin/env python3
"""Fail-closed tests for managed-simulation package staging."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

from managed_simulation_build_provenance import canonical, validate_stage_receipt
from managed_simulation_test_fixtures import build_receipt, macho_arm64


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "stage-managed-simulation-package.py"
INTEGRATION = ROOT / "integrations" / "engram" / "managed-simulation"


def invoke(
    binary: Path,
    output: Path,
    recipe: Path,
    build_receipt_path: Path,
    stage_receipt_path: Path,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "python3",
            str(SCRIPT),
            "--binary",
            str(binary),
            "--output",
            str(output),
            "--recipe",
            str(recipe),
            "--build-receipt",
            str(build_receipt_path),
            "--stage-receipt",
            str(stage_receipt_path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="crebain-stage-test-") as temporary:
        root = Path(temporary).resolve()
        workspace = root / "workspace"
        shutil.copytree(INTEGRATION / "contracts", workspace / "contracts")
        shutil.copy2(
            INTEGRATION / "configuration.json", workspace / "configuration.json"
        )
        shutil.copy2(
            INTEGRATION / "authoring.macos-aarch64-darwin.json",
            workspace / "authoring.json",
        )
        os.chmod(workspace / "authoring.json", 0o644)
        os.chmod(workspace / "configuration.json", 0o640)
        source_modes = {
            path: stat.S_IMODE(path.stat().st_mode)
            for path in (
                workspace / "authoring.json",
                workspace / "configuration.json",
            )
        }
        binary = root / "runtime"
        binary.write_bytes(macho_arm64())
        os.chmod(binary, 0o755)
        build = build_receipt(binary.read_bytes())
        build_path = root / "observed-build-receipt.json"
        build_path.write_bytes(canonical(build) + b"\n")
        output = root / "package"
        stage_path = root / "package-stage-receipt.json"

        accepted = invoke(
            binary,
            output,
            workspace / "authoring.json",
            build_path,
            stage_path,
        )
        assert accepted.returncode == 0, accepted.stderr
        staged_binary = output / "bin" / "crebain-managed-simulation"
        assert staged_binary.read_bytes() == binary.read_bytes()
        assert stat.S_IMODE(staged_binary.stat().st_mode) == 0o700
        stage = json.loads(stage_path.read_bytes())
        validate_stage_receipt(
            stage,
            build_receipt=build,
            build_receipt_bytes=build_path.read_bytes(),
        )
        assert {
            path: stat.S_IMODE(path.stat().st_mode) for path in source_modes
        } == source_modes

        replay = invoke(
            binary,
            output,
            workspace / "authoring.json",
            build_path,
            root / "replay-stage-receipt.json",
        )
        assert replay.returncode != 0 and "output already exists" in replay.stderr

        link = root / "runtime-link"
        link.symlink_to(binary)
        linked = invoke(
            link,
            root / "linked-package",
            workspace / "authoring.json",
            build_path,
            root / "linked-stage-receipt.json",
        )
        assert linked.returncode != 0 and "without following links" in linked.stderr

        malicious_document = json.loads((workspace / "authoring.json").read_text())
        malicious_document["schemas"][0]["package_relative_path"] = "../escape.json"
        malicious = workspace / "malicious.json"
        malicious.write_text(json.dumps(malicious_document))
        escaped = invoke(
            binary,
            root / "escaped-package",
            malicious,
            build_path,
            root / "escaped-stage-receipt.json",
        )
        assert escaped.returncode != 0 and "unsafe" in escaped.stderr
        assert not (root / "escaped-package").exists()

        nonfinite = workspace / "nonfinite.json"
        nonfinite.write_text(
            (workspace / "authoring.json")
            .read_text()
            .replace('"configuration.json"', "NaN", 1)
        )
        rejected_nonfinite = invoke(
            binary,
            root / "nonfinite-package",
            nonfinite,
            build_path,
            root / "nonfinite-stage-receipt.json",
        )
        assert rejected_nonfinite.returncode != 0
        assert "non-finite number" in rejected_nonfinite.stderr
        assert not (root / "nonfinite-package").exists()
        assert {
            path: stat.S_IMODE(path.stat().st_mode) for path in source_modes
        } == source_modes

        for name, payload, mode, expected in (
            ("text", b"#!/bin/sh\nexit 0\n" + b"#" * 32, 0o755, "not thin"),
            ("header-only", macho_arm64()[:32], 0o755, "load-command"),
            ("wrong-arch", macho_arm64(cpu_type=0x01000007), 0o755, "not arm64"),
            ("wrong-type", macho_arm64(file_type=6), 0o755, "not executable"),
            ("not-executable", macho_arm64(), 0o644, "lacks owner executable"),
        ):
            hostile_binary = root / f"{name}-runtime"
            hostile_binary.write_bytes(payload)
            hostile_binary.chmod(mode)
            hostile_build = build_receipt(
                payload,
                source_mode=0o755 if name == "not-executable" else mode,
            )
            hostile_build_path = root / f"{name}-build.json"
            hostile_build_path.write_bytes(canonical(hostile_build) + b"\n")
            rejected = invoke(
                hostile_binary,
                root / f"{name}-package",
                workspace / "authoring.json",
                hostile_build_path,
                root / f"{name}-stage.json",
            )
            assert rejected.returncode != 0 and expected in rejected.stderr, (
                name,
                rejected.returncode,
                rejected.stderr,
            )
            assert stat.S_IMODE(hostile_binary.stat().st_mode) == mode
            assert not (root / f"{name}-package").exists()
            assert not (root / f"{name}-stage.json").exists()

        swap_build = build_receipt(macho_arm64() + b"swapped")
        swap_path = root / "swapped-build.json"
        swap_path.write_bytes(canonical(swap_build) + b"\n")
        swapped = invoke(
            binary,
            root / "swapped-package",
            workspace / "authoring.json",
            swap_path,
            root / "swapped-stage.json",
        )
        assert swapped.returncode != 0 and "differs" in swapped.stderr
        assert not (root / "swapped-package").exists()

        unsorted_document = json.loads((workspace / "authoring.json").read_text())
        unsorted_document["schemas"][0:2] = reversed(unsorted_document["schemas"][0:2])
        unsorted_recipe = workspace / "unsorted.json"
        unsorted_recipe.write_text(json.dumps(unsorted_document))
        unsorted = invoke(
            binary,
            root / "unsorted-package",
            unsorted_recipe,
            build_path,
            root / "unsorted-stage.json",
        )
        assert unsorted.returncode != 0 and "sorted and unique" in unsorted.stderr
        assert not list(root.rglob(".*.tmp"))

    print("OK: managed simulation staging validates observed Mach-O provenance")


if __name__ == "__main__":
    main()
