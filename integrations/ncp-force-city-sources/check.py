#!/usr/bin/env python3
"""Run the city construction gate against an explicitly selected exact NCP source."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

from compose import APP, checked_dependency, compose

ROOT = APP.parents[1]
SHARED = APP.parent / "ncp-force-ground-sensors"


def inventory():
    paths = set(APP.rglob("*")) | set((SHARED / "python").rglob("*"))
    paths.add(SHARED / "install_runtime.py")
    paths.add(SHARED / "bridge/family-failure.ts")
    rows = []
    for path in sorted(paths):
        if path.is_symlink():
            raise ValueError("city construction source symlink")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            payload = path.read_bytes()
            rows.append(
                {
                    "path": path.relative_to(ROOT).as_posix(),
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            )
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ncp-source", type=Path, default=os.environ.get("CREBAIN_SENSOR_NCP_SOURCE")
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--transcript-python",
        type=Path,
        default=os.environ.get("CREBAIN_CITY_TRANSCRIPT_PYTHON"),
        help="explicit Python environment with the optional Prisoma transcript installed",
    )
    args = parser.parse_args()
    if args.ncp_source is None:
        parser.error(
            "--ncp-source or explicit CREBAIN_SENSOR_NCP_SOURCE is required; no fallback"
        )
    output = args.output or Path(tempfile.mkdtemp(prefix="crebain-city-check-"))
    if args.output:
        output.mkdir(mode=0o700)
    output = output.resolve(strict=True)
    before = inventory()
    (output / "source-before.json").write_text(json.dumps(before, indent=2) + "\n")
    executions = []
    tools = {name: shutil.which(name) for name in ("rustup", "bun", "node")}
    if any(value is None for value in tools.values()):
        raise ValueError("required construction tool unavailable")
    cargo = [tools["rustup"], "run", "1.91.1", "cargo"]
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", RUSTUP_TOOLCHAIN="1.91.1")
    env.pop("CARGO_TARGET_DIR", None)
    started = time.monotonic()

    def run(name, argv, *, cwd=ROOT, timeout=180, extra=None):
        begin = time.monotonic()
        row = {"name": name, "argv": list(map(str, argv)), "returncode": None}
        try:
            with (output / (name + ".log")).open("xb") as stream:
                result = subprocess.run(
                    argv,
                    cwd=cwd,
                    env=dict(env, **(extra or {})),
                    stdout=stream,
                    stderr=subprocess.STDOUT,
                    timeout=timeout,
                )
            row["returncode"] = result.returncode
            if result.returncode:
                raise RuntimeError("city construction control failed: " + name)
        except subprocess.TimeoutExpired:
            row["timed_out"] = True
            raise
        finally:
            row["elapsed_seconds"] = time.monotonic() - begin
            executions.append(row)
            (output / "executions.json").write_text(
                json.dumps(executions, indent=2) + "\n"
            )

    passed = False
    try:
        pin, blobs = checked_dependency(Path(args.ncp_source))
        if pin["dependency_ready"] is not False:
            raise ValueError("construction does not establish dependency readiness")
        original_read = Path.read_bytes
        chosen = Path(args.ncp_source).resolve() / blobs[0][0]

        def changed_read(path):
            value = original_read(path)
            return value + b"\n" if path == chosen else value

        with patch.object(Path, "read_bytes", changed_read):
            try:
                checked_dependency(Path(args.ncp_source))
            except ValueError as error:
                if "source drift" not in str(error):
                    raise
            else:
                raise AssertionError("altered dependency bytes admitted")
        checked_dependency(Path(args.ncp_source))
        build = output / "composition"
        compose(Path(args.ncp_source), build)
        for name, command in (
            ("cargo", cargo),
            ("rustc", [tools["rustup"], "run", "1.91.1", "rustc"]),
            ("bun", [tools["bun"]]),
            ("node", [tools["node"]]),
        ):
            run(name + "-version", command + ["--version"])
        python_path = os.pathsep.join(
            map(str, [build / "sdk-python", build / "python", APP / "tests"])
        )
        runtime = {
            "PYTHONPATH": python_path,
            "CREBAIN_CITY_BUN": tools["bun"],
            "CREBAIN_CITY_BRIDGE": str(APP / "bridge/main.ts"),
            "CREBAIN_CITY_PRODUCER": str(
                build / "application/target/debug/crebain-ncp-force-city-sources"
            ),
        }
        run(
            "generated-types",
            [sys.executable, "-B", APP / "contracts/generate-types.py", "--check"],
        )
        run(
            "generated-resources",
            [sys.executable, "-B", APP / "contracts/generate-resources.py", "--check"],
            extra=runtime,
        )
        run(
            "bridge-types",
            [tools["bun"], "x", "--no-install", "tsc", "-p", APP / "tsconfig.json"],
        )
        run(
            "bridge-lint",
            [
                tools["bun"],
                "x",
                "--no-install",
                "eslint",
                "--config",
                APP / "eslint.config.mjs",
                APP / "bridge",
                "--max-warnings",
                "0",
            ],
        )
        run(
            "bridge-controls",
            [
                tools["bun"],
                "test",
                APP / "bridge/owner.test.ts",
                APP / "bridge/failure.test.ts",
            ],
        )
        run(
            "rust-format",
            cargo + ["fmt", "--all", "--", "--check"],
            cwd=build / "application",
        )
        run(
            "rust-producer",
            cargo + ["build", "--locked", "--offline"],
            cwd=build / "application",
        )
        run(
            "rust-controls",
            cargo + ["test", "--locked", "--offline", "--all-targets"],
            cwd=build / "application",
        )
        run(
            "rust-doc-controls",
            cargo + ["test", "--locked", "--offline", "--doc"],
            cwd=build / "application",
        )
        run(
            "rust-clippy",
            cargo
            + [
                "clippy",
                "--locked",
                "--offline",
                "--all-targets",
                "--",
                "-D",
                "warnings",
            ],
            cwd=build / "application",
        )
        run(
            "rust-doc",
            cargo + ["doc", "--locked", "--offline", "--no-deps"],
            cwd=build / "application",
            extra={"RUSTDOCFLAGS": "-D warnings"},
        )
        run(
            "python-controls",
            [
                sys.executable,
                "-B",
                "-m",
                "unittest",
                "discover",
                "-s",
                APP / "tests",
                "-v",
            ],
            extra=runtime,
        )
        if args.transcript_python is not None:
            if not args.transcript_python.is_absolute():
                raise ValueError("selected transcript Python must be absolute")
            run(
                "capture-owner-controls",
                [str(args.transcript_python), "-B", APP / "check_capture.py"],
                extra=runtime,
            )
        checked_dependency(Path(args.ncp_source))
        if inventory() != before:
            raise ValueError("selected source changed during city construction gate")
        passed = True
    finally:
        result = {
            "schema": "crebain.city-construction-gate.v1",
            "passed": passed,
            "source_files": before,
            "executions": executions,
            "elapsed_seconds": time.monotonic() - started,
            "actual_cpu_source_controls_complete": any(
                row["name"] == "python-controls" and row["returncode"] == 0
                for row in executions
            ),
            "graphics_control_scope": "synthetic",
            "installed_qualified": False,
            "native_256_qualified": False,
            "scientific_validation": False,
            "dependency_ready": False,
            "capture_owner_controls_selected": args.transcript_python is not None,
            "capture_owner_controls_passed": any(
                row["name"] == "capture-owner-controls" and row["returncode"] == 0
                for row in executions
            ),
        }
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(
            json.dumps(
                {
                    "passed": passed,
                    "evidence": str(output),
                    "installed_qualified": False,
                }
            )
        )


if __name__ == "__main__":
    main()
