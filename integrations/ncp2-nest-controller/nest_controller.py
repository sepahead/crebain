#!/usr/bin/env python3
"""A crebain.controller owner whose controller is a spiking network in NEST.

It serves one NCP 2 session on standard input and output. For each drone and each axis, two
populations of leaky integrate-and-fire neurons (NEST's iaf_psc_alpha) carry the
proportional-derivative signal

    u = kp (target - position) - kd velocity                      in m/s^2

as firing rates: the "+" population receives the current drive * max(u, 0) and the "-"
population drive * max(-u, 0), each on top of a bias current that differs from neuron to neuron.
The bias lies above the firing threshold, so both populations fire at rest and a small error
changes the rates in proportion; a bias below the threshold would leave a dead zone around the
target.
After each step of tick_ms of simulated time, the controller proposes, for each axis,

    a = clamp(gain * (spikes+ - spikes-) / neurons)                in m/s^2

A drone without an estimate gets a = 0, as with the reference controller. The network keeps its
state from step to step.

This is a minimal spiking controller that puts a neural network into the loop. It is not a model
from Engram or from the literature, and it claims nothing about neural control.

Requires NEST 3.10 (PyNEST) and the NCP 2 Python SDK (`sepahead-ncp`) on the module path.
"""

from __future__ import annotations

import math
import os
import sys
from pathlib import Path
from typing import Any, Callable, Protocol

import ncp

HERE = Path(__file__).resolve().parent
CONTRACT = HERE.parents[1] / "src-tauri" / "crates" / "ncp-simulation" / "contracts" / "crebain.controller.v1.json"
MAX_ACCELERATION_MPS2 = 50.0

DEFAULTS: dict[str, Any] = {
    "kp": 1.0,  # 1/s^2
    "kd": 2.0,  # 1/s
    "max_acceleration_mps2": 5.0,
    "neurons": 50,  # in each population
    "bias_pA": [400.0, 500.0],  # the bias currents spread evenly over this range; rheobase 375 pA
    "drive_pA_per_mps2": 100.0,
    "gain_mps2_per_spike": 1.6,  # per spike and neuron of the difference
    "seed": 1,
}


class Network(Protocol):
    """Two populations for each channel (drone and axis)."""

    description: dict[str, Any]

    def step(self, drives: list[float], tick_ms: int) -> list[tuple[int, int]]:
        """Drive each channel with u for tick_ms of simulated time; return (spikes+, spikes-)."""


class NestNetwork:
    """The populations in NEST, with one spike recorder for each."""

    def __init__(self, channels: int, parameters: dict[str, Any]) -> None:
        os.environ.setdefault("PYNEST_QUIET", "1")
        import nest  # imported here, after serve_stdio moved other output to standard error

        self.nest = nest
        nest.ResetKernel()
        nest.set_verbosity("M_ERROR")
        nest.SetKernelStatus({"resolution": 0.1, "local_num_threads": 1, "rng_seed": parameters["seed"]})
        n = parameters["neurons"]
        low, high = parameters["bias_pA"]
        self.bias = [low + (high - low) * i / max(n - 1, 1) for i in range(n)]
        self.drive = parameters["drive_pA_per_mps2"]
        self.channels = []
        for _ in range(channels):
            pair = []
            for _ in range(2):
                population = nest.Create("iaf_psc_alpha", n, params={"I_e": self.bias})
                recorder = nest.Create("spike_recorder")
                nest.Connect(population, recorder)
                pair.append((population, recorder))
            self.channels.append(pair)
        self.description = {
            "kind": "NEST population rate code: two iaf_psc_alpha populations for each drone and axis",
            "nest": str(nest.__version__) if hasattr(nest, "__version__") else "unknown",
            "neurons": channels * 2 * n,
        }

    def step(self, drives: list[float], tick_ms: int) -> list[tuple[int, int]]:
        for (plus, minus), u in zip(self.channels, drives, strict=True):
            plus[0].set(I_e=[b + self.drive * max(u, 0.0) for b in self.bias])
            minus[0].set(I_e=[b + self.drive * max(-u, 0.0) for b in self.bias])
        self.nest.Simulate(float(tick_ms))
        counts = []
        for plus, minus in self.channels:
            counts.append((plus[1].get("n_events"), minus[1].get("n_events")))
            # Setting n_events to 0 clears the recorder, so each step reads a constant amount.
            plus[1].set(n_events=0)
            minus[1].set(n_events=0)
        return counts


def _number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def check_parameters(given: Any) -> dict[str, Any]:
    if given is None:
        given = {}
    if type(given) is not dict or not set(given) <= set(DEFAULTS):
        raise ncp.BodyInvalid(f"parameters must be an object with members from {sorted(DEFAULTS)}")
    p = {**DEFAULTS, **given}
    bias = p["bias_pA"]
    if not (
        all(_number(p[k]) and p[k] >= 0 for k in ("kp", "kd", "drive_pA_per_mps2", "gain_mps2_per_spike"))
        and _number(p["max_acceleration_mps2"])
        and 0 < p["max_acceleration_mps2"] <= MAX_ACCELERATION_MPS2
        and type(p["neurons"]) is int
        and 1 <= p["neurons"] <= 1000
        and type(bias) is list
        and len(bias) == 2
        and all(_number(b) for b in bias)
        and 0 <= bias[0] <= bias[1] <= 10_000
        and type(p["seed"]) is int
        and 1 <= p["seed"] < 2**31
    ):
        raise ncp.BodyInvalid("a parameter is out of range")
    return p


def check_prepare(body: Any) -> None:
    if type(body) is not dict or set(body) - {"parameters"} != {"drone_ids", "tick_ms", "targets_m"}:
        raise ncp.BodyInvalid("prepare needs drone_ids, tick_ms, targets_m, and optional parameters")
    ids = body["drone_ids"]
    if type(ids) is not list or not 1 <= len(ids) <= 3 or any(type(i) is not str for i in ids) or ids != sorted(set(ids)):
        raise ncp.BodyInvalid("drone_ids must be 1 to 3 sorted, unique identifiers")
    if type(body["tick_ms"]) is not int or not 1 <= body["tick_ms"] <= 1000:
        raise ncp.BodyInvalid("tick_ms must be an integer from 1 to 1000")
    targets = body["targets_m"]
    if type(targets) is not list or len(targets) != 3 * len(ids) or not all(_number(t) for t in targets):
        raise ncp.BodyInvalid("targets_m needs 3 finite components for each drone")
    check_parameters(body.get("parameters"))


def check_step(prepare: dict[str, Any], last: int, body: Any) -> None:
    members = {"tick_index", "source_state_digest", "drone_ids", "estimate_available", "position_m", "velocity_mps"}
    if type(body) is not dict or set(body) != members:
        raise ncp.BodyInvalid(f"step needs exactly {sorted(members)}")
    n = len(prepare["drone_ids"])
    if type(body["tick_index"]) is not int or body["tick_index"] != last + 1:
        raise ncp.BodyInvalid(f"tick_index must be {last + 1}")
    if (
        body["drone_ids"] != prepare["drone_ids"]
        or type(body["estimate_available"]) is not list
        or len(body["estimate_available"]) != n
        or any(type(a) is not bool for a in body["estimate_available"])
        or any(type(body[k]) is not list or len(body[k]) != 3 * n for k in ("position_m", "velocity_mps"))
        or not all(_number(v) for v in body["position_m"] + body["velocity_mps"])
        or not ncp.exchange.is_identity(body["source_state_digest"])
    ):
        raise ncp.BodyInvalid("the step must name the prepared drones with finite values and a state digest")


class NestController:
    """The handler: validation, the drive of the network, and the readout."""

    def __init__(self, make_network: Callable[[int, dict[str, Any]], Network]) -> None:
        self.make_network = make_network
        self.prepared: tuple[dict[str, Any], dict[str, Any], Network] | None = None
        self.last = 0

    def validate(self, op: str, body: Any) -> None:
        if op == "prepare":
            if self.prepared is not None:
                raise ncp.BodyInvalid("the controller is prepared")
            check_prepare(body)
        elif op == "step":
            if self.prepared is None:
                raise ncp.BodyInvalid("prepare first")
            check_step(self.prepared[0], self.last, body)
        else:
            raise ncp.BodyInvalid(f"unknown operation {op}")

    def execute(self, op: str, body: Any) -> Any:
        self.validate(op, body)
        if op == "prepare":
            parameters = check_parameters(body.get("parameters"))
            network = self.make_network(3 * len(body["drone_ids"]), parameters)
            self.prepared = (body, parameters, network)
            return {"controller": {**network.description, "parameters": parameters}, "drone_ids": body["drone_ids"]}
        prepare, p, network = self.prepared  # type: ignore[misc]
        drives = []
        for i, available in enumerate(body["estimate_available"]):
            for axis in range(3):
                at = 3 * i + axis
                u = p["kp"] * (prepare["targets_m"][at] - body["position_m"][at]) - p["kd"] * body["velocity_mps"][at]
                drives.append(u if available else 0.0)
        counts = network.step(drives, prepare["tick_ms"])
        limit = p["max_acceleration_mps2"]
        acceleration = []
        for i, available in enumerate(body["estimate_available"]):
            for axis in range(3):
                plus, minus = counts[3 * i + axis]
                a = p["gain_mps2_per_spike"] * (plus - minus) / p["neurons"] if available else 0.0
                # `+ 0.0` turns a negative zero into zero, which the world requires.
                acceleration.append(min(max(a, -limit), limit) + 0.0)
        self.last = body["tick_index"]
        return {
            "tick_index": body["tick_index"],
            "source_state_digest": body["source_state_digest"],
            "drone_ids": body["drone_ids"],
            "acceleration_mps2": acceleration,
        }


def owner(make_network: Callable[[int, dict[str, Any]], Network] = NestNetwork) -> ncp.Owner:
    contract = ncp.Contract.from_bytes(CONTRACT.read_bytes())
    return ncp.Owner(contract.application, contract.identity, NestController(make_network), contract.operations)


def main() -> None:
    if len(sys.argv) > 1:
        print("nest_controller.py takes no arguments; prepare carries its parameters", file=sys.stderr)
        sys.exit(2)
    ncp.serve_stdio(owner())


if __name__ == "__main__":
    main()
