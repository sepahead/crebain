#!/usr/bin/env python3
"""Check the NEST controller, alone and in the closed loop with CREBAIN's NCP 2 body.

    python3 check.py --ncp-python DIR --nest-python PYTHON [--evidence DIR]

The environment variables CREBAIN_NCP_PYTHON and CREBAIN_NEST_PYTHON can give the first two.

--ncp-python  a directory that holds the NCP 2 Python SDK package `ncp`, for example the
              `python` directory of an NCP checkout at the revision that the body pins
--nest-python an interpreter with NEST 3.10 (PyNEST)
--evidence    a new directory for the summaries, the verification reports, and the environment

1. The controller's validation and readout, with a stand-in for the network (no NEST).
2. With NEST: one network flies one drone, and three networks fly five drones in two worlds,
   600 steps of 20 ms each. Every drone must end within 0.1 m of its target, the transcripts
   must pass `crebain-ncp-loop verify`, and a second run of the first loop must give the same
   summary.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CRATE = ROOT / "src-tauri" / "crates" / "ncp-simulation"
DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
STEPS = 600
WITHIN_M = 0.1


class Stand_in:
    """A network whose spike counts are the drive, rounded: plus = round(10 max(u, 0)) + 5."""

    description = {"kind": "stand-in"}

    def __init__(self, channels: int, parameters: dict) -> None:
        self.channels = channels
        self.calls: list[list[float]] = []

    def step(self, drives: list[float], tick_ms: int) -> list[tuple[int, int]]:
        assert len(drives) == self.channels and tick_ms == 20
        self.calls.append(drives)
        return [(round(10 * max(u, 0.0)) + 5, round(10 * max(-u, 0.0)) + 5) for u in drives]


def unit_tests() -> None:
    import ncp
    import nest_controller as nc

    def rejected(call, *args) -> None:
        try:
            call(*args)
        except ncp.BodyInvalid:
            return
        raise AssertionError(f"accepted: {args}")

    controller = nc.NestController(Stand_in)
    prepare = {"drone_ids": ["alpha", "bravo"], "tick_ms": 20, "targets_m": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
               "parameters": {"neurons": 10, "gain_mps2_per_spike": 1.0, "kp": 1.0, "kd": 0.0}}
    step = {"tick_index": 1, "source_state_digest": DIGEST, "drone_ids": ["alpha", "bravo"],
            "estimate_available": [True, False], "position_m": [0.0] * 6, "velocity_mps": [0.0] * 6}
    rejected(controller.validate, "step", step)
    for change in ({"drone_ids": ["bravo", "alpha"]}, {"drone_ids": []}, {"tick_ms": 0},
                   {"targets_m": [1.0] * 5}, {"targets_m": [float("nan")] + [0.0] * 5},
                   {"parameters": {"ki": 1.0}}, {"parameters": {"neurons": 0}},
                   {"parameters": {"max_acceleration_mps2": 60.0}}, {"parameters": {"bias_pA": [500.0, 400.0]}},
                   {"extra": 1}):
        rejected(controller.validate, "prepare", {**prepare, **change})
    result = controller.execute("prepare", prepare)
    assert result["drone_ids"] == ["alpha", "bravo"] and result["controller"]["parameters"]["neurons"] == 10
    rejected(controller.validate, "prepare", prepare)
    for change in ({"tick_index": 2}, {"drone_ids": ["alpha"]}, {"source_state_digest": "x"},
                   {"estimate_available": [1, 0]}, {"position_m": [0.0] * 5},
                   {"velocity_mps": [float("inf")] + [0.0] * 5}):
        rejected(controller.validate, "step", {**step, **change})
    out = controller.execute("step", step)
    # alpha, x: u = 1 -> 15 and 5 spikes in 10 neurons -> a = 1.0; bravo has no estimate -> 0.
    assert out["acceleration_mps2"] == [1.0, 0.0, 0.0, 0.0, 0.0, 0.0], out
    assert all(not (a == 0.0 and str(a).startswith("-")) for a in out["acceleration_mps2"]), "no negative zero"
    assert out["tick_index"] == 1 and out["source_state_digest"] == DIGEST
    far = {**step, "tick_index": 2, "position_m": [-90.0] + [0.0] * 5}
    assert controller.execute("step", far)["acceleration_mps2"][0] == 5.0, "clamped to 5 m/s^2"
    print("ok: controller validation and readout with a stand-in network")


def build() -> Path:
    subprocess.run(["cargo", "build", "--quiet", "--locked", "--release", "--manifest-path", str(CRATE / "Cargo.toml")],
                   check=True)
    return CRATE / "target" / "release"


def drone(name: str, start: list[float], target: list[float]) -> dict:
    return {"id": name, "initial_position_m": start, "initial_velocity_mps": [0.0, 0.0, 0.0],
            "sensor_variance_m2": [0.01, 0.01, 0.01], "target_m": target}


def configs(binaries: Path, nest_python: str) -> dict[str, dict]:
    network = [nest_python, str(HERE / "nest_controller.py")]
    body = [str(binaries / "crebain-ncp-simulation")]
    one = {"tick_ms": 20, "steps": STEPS, "body_command": body,
           "worlds": [{"drones": [drone("alpha", [0.0, 0.0, 10.0], [12.0, -6.0, 18.0])]}],
           "controllers": [{"command": network, "world": 0, "drone_ids": ["alpha"]}]}
    many = {"tick_ms": 20, "steps": STEPS, "body_command": body,
            "worlds": [{"drones": [drone("alpha", [0.0, 0.0, 10.0], [10.0, 5.0, 15.0]),
                                   drone("bravo", [20.0, 0.0, 10.0], [15.0, -5.0, 12.0]),
                                   drone("charlie", [-10.0, 10.0, 5.0], [-4.0, 4.0, 9.0])]},
                       {"drones": [drone("delta", [0.0, 0.0, 30.0], [8.0, 8.0, 20.0]),
                                   drone("echo", [5.0, -5.0, 25.0], [-6.0, 2.0, 22.0])]}],
            "controllers": [{"command": network, "world": 0, "drone_ids": ["alpha", "bravo"]},
                            {"command": network, "world": 0, "drone_ids": ["charlie"]},
                            {"command": network, "world": 1, "drone_ids": ["delta", "echo"]}]}
    return {"one-network-one-drone": one, "three-networks-five-drones": many}


def run_loop(binaries: Path, config: dict, out: Path, env: dict) -> tuple[dict, dict]:
    config_path = out.parent / f"{out.name}.json"
    config_path.write_text(json.dumps(config))
    loop = str(binaries / "crebain-ncp-loop")
    summary = json.loads(subprocess.run([loop, "run", str(config_path), str(out)], env=env, check=True,
                                        capture_output=True, text=True).stdout)
    report = json.loads(subprocess.run([loop, "verify", str(out)], check=True, capture_output=True, text=True).stdout)
    for world in summary["worlds"]:
        for d in world["drones"]:
            if not d["final_error_m"] < WITHIN_M:
                raise AssertionError(f"{out.name}: {d['id']} ends {d['final_error_m']} m from its target")
    return summary, report


def environment(nest_python: str, ncp_python: Path) -> dict:
    nest_version = subprocess.run([nest_python, "-c", "import os; os.environ['PYNEST_QUIET']='1'; import nest; print(nest.__version__)"],
                                  check=True, capture_output=True, text=True).stdout.strip().splitlines()[-1]
    python_version = subprocess.run([nest_python, "-c", "import sys; print(sys.version.split()[0])"],
                                    check=True, capture_output=True, text=True).stdout.strip()
    ncp_commit = subprocess.run(["git", "-C", str(ncp_python), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    crebain_commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    changed = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=no"],
                             capture_output=True, text=True).stdout.strip()
    return {"nest": nest_version, "nest_python": python_version, "ncp_commit": ncp_commit or "unknown",
            "crebain_commit": crebain_commit or "unknown", "crebain_tracked_files_unchanged": not changed,
            "machine": platform.machine(), "system": platform.system(), "release": platform.release()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ncp-python", type=Path, default=os.environ.get("CREBAIN_NCP_PYTHON"))
    parser.add_argument("--nest-python", default=os.environ.get("CREBAIN_NEST_PYTHON"))
    parser.add_argument("--evidence", type=Path)
    args = parser.parse_args()
    if not args.ncp_python or not args.nest_python:
        raise SystemExit("select the NCP 2 Python SDK and the NEST interpreter: --ncp-python and --nest-python, "
                         "or CREBAIN_NCP_PYTHON and CREBAIN_NEST_PYTHON")
    args.ncp_python = Path(args.ncp_python)
    if args.evidence and args.evidence.exists():
        raise SystemExit(f"{args.evidence} exists; give a new directory")
    sys.path[:0] = [str(args.ncp_python), str(HERE)]
    unit_tests()
    binaries = build()
    env = dict(os.environ, PYTHONPATH=str(args.ncp_python), PYTHONDONTWRITEBYTECODE="1")
    results = {}
    with tempfile.TemporaryDirectory(prefix="crebain-nest-loop-") as work:
        for name, config in configs(binaries, args.nest_python).items():
            summary, report = run_loop(binaries, config, Path(work) / name, env)
            errors = [round(d["final_error_m"], 4) for w in summary["worlds"] for d in w["drones"]]
            print(f"ok: {name}: {report['controllers']} networks, {report['proposals']} proposals verified, final errors {errors} m")
            results[name] = {"summary": summary, "verify": report}
        again, _ = run_loop(binaries, configs(binaries, args.nest_python)["one-network-one-drone"], Path(work) / "again", env)
        if again != results["one-network-one-drone"]["summary"]:
            raise AssertionError("a second run of the same loop gave another summary")
        print("ok: a second run gave the same summary")
        if args.evidence:
            args.evidence.mkdir(parents=True)
            for name, result in results.items():
                for kind, value in result.items():
                    (args.evidence / f"{name}.{kind}.json").write_text(json.dumps(value, indent=1, sort_keys=True) + "\n")
                shutil.copy(Path(work) / name / "trajectory.jsonl", args.evidence / f"{name}.trajectory.jsonl")
            (args.evidence / "environment.json").write_text(
                json.dumps(environment(args.nest_python, args.ncp_python), indent=1, sort_keys=True) + "\n")
            print(f"evidence written to {args.evidence.name}")


if __name__ == "__main__":
    main()
