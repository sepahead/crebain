"""Run the installed 24-tick example through ordinary owned NCP sessions."""

import argparse
import json

from . import InstalledRuntime, SensorContract, SetTarget, body_session
from .codec import COMPOSITION_DIGEST


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", help="prefix created by install_runtime.py")
    parser.add_argument("--microphone-only", action="store_true")
    parser.add_argument("--timeout-s", type=int, default=180)
    args = parser.parse_args()
    runtime = InstalledRuntime.open(args.runtime)
    path = runtime.project / "integrations/ncp-force-ground-sensors/contracts/m1.workload.v1.json"
    workload = json.loads(path.read_text(encoding="utf-8"))
    if args.microphone_only:
        workload["specification"]["scene"]["rgbCameras"] = []
        workload["specification"]["scene"]["thermalCameras"] = []
    prepare = SensorContract.decode_prepare({
        "specification": workload["specification"],
        "planned_ticks": workload["planned_ticks"],
        "composition_digest": COMPOSITION_DIGEST,
    })
    actions = {
        row["tick"]: SetTarget("set_target", row["armed"], row["control"]["roll_rad"],
                              row["control"]["pitch_rad"], row["control"]["heading_rad"],
                              row["control"]["altitude_m"])
        for row in workload["targets"]
    }
    with body_session(runtime, prepare, timeout_s=args.timeout_s) as body:
        for tick in range(1, prepare.planned_ticks + 1):
            with body.advance(actions.get(tick)):
                pass
        result = body.finish()
    print(json.dumps({
        "source_identity": result.prepared.source_identity,
        "completed_ticks": result.terminal.completed_ticks,
        "payload_count": result.payload_count, "raw_bytes": result.raw_bytes,
        "process_exit": body.process_exit,
        "scientific_validation": False,
    }))


if __name__ == "__main__":
    main()
