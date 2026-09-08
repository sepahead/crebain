#!/usr/bin/env python3
"""Run the construction gate with an explicitly selected exact NCP source."""
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

def inventory():
    result = []
    for path in sorted(APP.rglob("*")):
        if path.is_symlink():
            raise ValueError("application source symlink")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            blob = path.read_bytes()
            result.append({"path": path.relative_to(ROOT).as_posix(), "bytes": len(blob),
                           "sha256": hashlib.sha256(blob).hexdigest()})
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ncp-source", type=Path, default=os.environ.get("CREBAIN_SENSOR_NCP_SOURCE"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.ncp_source is None:
        parser.error("--ncp-source or explicit CREBAIN_SENSOR_NCP_SOURCE is required; no fallback")
    output = args.output or Path(tempfile.mkdtemp(prefix="crebain-sensor-check-"))
    if args.output:
        output.mkdir(mode=0o700)
    output = output.resolve(strict=True)
    before = inventory()
    (output / "source-before.json").write_text(json.dumps(before, indent=2) + "\n")
    executions = []
    tools = {name: shutil.which(name) for name in ("cargo", "rustc", "rustfmt", "bun", "node")}
    if any(value is None for value in tools.values()):
        raise ValueError("required construction tool unavailable")
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", RUSTUP_TOOLCHAIN="1.91.1")
    started = time.monotonic()
    def run(name, argv, *, cwd=ROOT, timeout=180, extra=None):
        begin = time.monotonic()
        with (output / (name + ".log")).open("wb") as stream:
            result = subprocess.run(argv, cwd=cwd, env=dict(env, **(extra or {})),
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
        row = {"name": name, "argv": list(map(str, argv)), "returncode": result.returncode,
               "elapsed_seconds": time.monotonic() - begin}
        executions.append(row)
        (output / "executions.json").write_text(json.dumps(executions, indent=2) + "\n")
        if result.returncode:
            raise RuntimeError("construction control failed: " + name)
        return row
    passed = False
    try:
        pin, blobs = checked_dependency(Path(args.ncp_source))
        assert pin["dependency_ready"] is False
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
                raise AssertionError("changed dependency bytes were admitted")
        # Negative control altered only the observed copy; source files stayed exact.
        checked_dependency(Path(args.ncp_source))
        build = output / "composition"
        compose(Path(args.ncp_source), build)
        for name in ("cargo", "rustc", "rustfmt", "bun", "node"):
            run(name + "-version", [tools[name], "--version"])
        run("generated-dtos", [sys.executable, "-B", APP / "contracts/generate-rust-types.py", "--check"])
        run("bridge-types", [tools["bun"], "x", "--no-install", "tsc", "-p", APP / "tsconfig.json"])
        run("bridge-lint", [tools["bun"], "x", "--no-install", "eslint", "--config", APP / "eslint.config.mjs", APP / "bridge", "--max-warnings", "0"])
        run("bridge-controls", [tools["bun"], "test", APP / "bridge/owner.test.ts"])
        python_path = os.pathsep.join(map(str, [build / "sdk-python", build / "python", build / "python/tests"]))
        run("python-controls", [sys.executable, "-B", "-m", "unittest", "discover", "-s", build / "python/tests", "-v"],
            extra={"PYTHONPATH": python_path})
        vector = output / "numeric-parity-python.json"
        with vector.open("wb") as stream:
            subprocess.run([sys.executable, "-B", build / "python/tests/numeric_parity.py"], env=dict(env, PYTHONPATH=python_path),
                           stdout=stream, check=True, timeout=30)
        runtime = {"CREBAIN_SENSOR_NUMERIC_VECTORS": str(vector), "CREBAIN_SENSOR_BUN": tools["bun"],
                   "CREBAIN_SENSOR_NODE": tools["node"], "CREBAIN_SENSOR_BRIDGE": str(APP / "bridge/main.ts")}
        run("rust-format", [tools["cargo"], "fmt", "--all", "--", "--check"], cwd=build / "application")
        run("rust-controls", [tools["cargo"], "test", "--locked", "--offline"], cwd=build / "application", extra=runtime)
        run("rust-clippy", [tools["cargo"], "clippy", "--locked", "--offline", "--all-targets", "--", "-D", "warnings"], cwd=build / "application")
        run("rust-doc", [tools["cargo"], "doc", "--locked", "--offline", "--no-deps"], cwd=build / "application", extra={"RUSTDOCFLAGS": "-D warnings"})
        checked_dependency(Path(args.ncp_source))
        if inventory() != before:
            raise ValueError("application source changed during construction gate")
        passed = True
    finally:
        result = {"schema": "crebain.sensor-construction-gate.v1", "passed": passed,
                  "source_files": before, "executions": executions, "elapsed_seconds": time.monotonic() - started,
                  "dependency_ready": False, "actual_sensor_transfer": "NOT_RUN", "installed_qualified": False,
                  "scientific_validation": False, "final70": "OPEN"}
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"passed": passed, "evidence": str(output), "dependency_ready": False, "installed_qualified": False}))

if __name__ == "__main__":
    main()
