"""Generate the closed private family bridge from the owned public schemas."""

import argparse
import copy
import json
from pathlib import Path
import runpy
import subprocess

HERE = Path(__file__).resolve().parent


def obj(**fields):
    return {"type": "object", "additionalProperties": False, "required": list(fields), "properties": fields}


def ref(name):
    return {"$ref": "#/$defs/" + name}


def integer(low, high):
    return {"type": "integer", "minimum": low, "maximum": high}


def tagged(kind, **fields):
    return obj(kind={"const": kind}, **fields)


def wrapped(value):
    if isinstance(value, list):
        return [wrapped(item) for item in value]
    if not isinstance(value, dict):
        return value
    if value.get("type") == "number":
        return ref("Float64")
    return {key: wrapped(item) for key, item in value.items()}


def product():
    public = json.loads((HERE / "family.application.schema.v1.json").read_bytes())
    native = json.loads((HERE / "engine-bridge.schema.v1.json").read_bytes())
    defs = copy.deepcopy(public["$defs"])
    defs.update({name: copy.deepcopy(value) for name, value in native["$defs"].items() if name not in defs})
    response_arms = native["$defs"]["Response"]["properties"]["body"]["oneOf"]
    native_arms = {arm["properties"]["kind"]["const"]: copy.deepcopy(arm) for arm in response_arms}
    # The ordinary bridge's retained native projection is authoritative here too.
    defs["NativeBatch"] = native_arms["advanced"]["properties"]["batch"]
    defs["NativeRestored"] = obj(ancestry=ref("BranchAncestry"), cpu_state_sha256=ref("Digest"),
        render_input_sha256=ref("Digest"), pixels=defs["Restored"]["properties"]["pixels"])
    slot = integer(0, 15)
    tick = integer(1, 7200)
    commands = [
        tagged("construct", plan=ref("FamilyPlan"), family_plan_digest=ref("Digest"), source_identity=ref("Digest")),
        tagged("prepare"),
        tagged("advance", slot=slot, command=ref("Command"), request_digest=ref("Digest")),
        tagged("read_chunk", slot=slot, tick=tick, engine_batch_sha256=ref("Digest"),
            sensor_id=defs["PressureWindow"]["properties"]["sensor_id"], offset=integer(0, 8388607), count=integer(1, 32768)),
        tagged("release_lease", slot=slot, tick=tick, engine_batch_sha256=ref("Digest")),
        tagged("checkpoint", expected_batch_digest=ref("Digest")),
        tagged("select", checkpoint=ref("CheckpointReference"), case_id=ref("Token"), forecast=ref("Digest")),
        tagged("reserve", checkpoint=ref("CheckpointReference"), case_id=ref("Token"), selected=ref("Digest"), request=ref("Digest")),
        tagged("restore", reservation=ref("ReservationReference"), family_plan_digest=ref("Digest")),
        tagged("evaluate", slot=integer(1, 15), batch=ref("Digest"), target=ref("Digest")),
        tagged("finish_branch", slot=integer(1, 15), evaluation=ref("Digest")),
        tagged("release_checkpoint", checkpoint=ref("CheckpointReference"), terminal=ref("Digest")),
        tagged("finish_canonical", terminals=defs["CanonicalFinish"]["properties"]["expected_branch_terminals"]),
        tagged("observe_canonical", stamp=ref("CommittedStamp"), result=ref("CanonicalResult")),
        tagged("observe_evaluation", slot=integer(1, 15), stamp=ref("CommittedStamp"), result=ref("EvaluationResultUnion")),
        tagged("observe_terminal", stamp=ref("CommittedStamp")),
        tagged("observe_ack", stamp=ref("CommittedStamp")),
        tagged("observe_eof", stamp=ref("CommittedStamp")),
        tagged("retire"),
    ]
    # ReadChunk permits all existing modalities, not only the evaluation microphone.
    commands[3]["properties"]["sensor_id"] = native_arms["chunk"]["properties"]["sensor_id"]
    bodies = [tagged("constructed"), native_arms["prepared"], native_arms["advanced"], native_arms["chunk"],
        tagged("released", tick=tick, engine_batch_sha256=ref("Digest"), canonical_final_state={"oneOf": [ref("CanonicalFinalState"), {"type": "null"}]}),
        tagged("checkpointed", result=ref("Checkpointed")), tagged("selected", result=ref("DecisionCommitted")),
        tagged("reserved", reference=ref("ReservationReference")), tagged("restored", result=ref("NativeRestored")),
        tagged("evaluated", result=ref("EvaluationResult")), tagged("branch_finished"), tagged("checkpoint_released"),
        tagged("family_finished", state=ref("CanonicalFinalState")), tagged("observed"), native_arms["retired"], native_arms["failed"]]
    defs["PrivateCommand"] = {"oneOf": commands}
    defs["PrivateBody"] = {"oneOf": bodies}
    defs["Request"] = obj(schema={"const": "crebain.family-engine-request.v1"}, generation=ref("Uuid"),
        sequence=integer(1, 9007199254740991), command=ref("PrivateCommand"))
    defs["Response"] = obj(schema={"const": "crebain.family-engine-response.v1"}, generation=ref("Uuid"),
        sequence=integer(1, 9007199254740991), body=ref("PrivateBody"))
    plain = copy.deepcopy(defs)
    defs = wrapped(defs)
    defs["Float64"] = obj(f64={"type": "string", "pattern": "^[0-9a-f]{16}$"})
    # Keep only the finite referenced closure; unrelated import slots are not private methods.
    reached = set()
    def visit(value):
        if isinstance(value, list):
            for item in value: visit(item)
        elif isinstance(value, dict):
            if "$ref" in value:
                name = value["$ref"].removeprefix("#/$defs/")
                if name not in reached:
                    reached.add(name)
                    visit(defs[name])
            else:
                for item in value.values(): visit(item)
    visit([ref("Request"), ref("Response")])
    result = {"$schema": public["$schema"], "$id": "crebain.family-engine-bridge.v1", "$defs": {name: defs[name] for name in sorted(reached)}}
    raw = (json.dumps(result, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n").encode()
    if len(raw) > 65536: raise ValueError("installed family bridge schema bound")
    ts_type = runpy.run_path(str(HERE / 'generate-family-contracts.py'))['ts_type']
    text = '// Generated private DTOs after exact Float64 decoding; the selected bridge schema owns admission.\n'
    for name in sorted(reached):
        if name in plain:
            text += f'export type {name} = {ts_type(plain[name])}\n'
    text = subprocess.run(['bun', 'x', '--no-install', 'prettier', '--stdin-filepath', 'family-engine-types.ts'],
        cwd=HERE.parents[2], input=text, text=True, capture_output=True, check=True).stdout.encode()
    runtime = json.loads((HERE / 'engine-runtime-receipt.schema.v1.json').read_bytes())
    runtime_defs = copy.deepcopy(runtime['$defs'])
    runtime_defs['BufferBinding'] = public['$defs']['BufferBinding']
    runtime_defs['FamilyReceipt'] = obj(schema={'const': 'crebain.family-graphics-runtime.v1'},
        family_id=ref('Uuid'), family_plan_digest=ref('Sha256'), slot=integer(0, 15),
        binding=ref('BufferBinding'), source_identity=ref('Sha256'), native_owner_id=ref('Uuid'),
        graphics=ref('Graphics'), identity_scope={'const': 'browser-reported-strings-not-loaded-code-or-hardware-proof'})
    runtime_product = {'$schema': public['$schema'], '$id': 'crebain.family-graphics-runtime.types.v1', '$defs': runtime_defs}
    runtime_raw = (json.dumps(runtime_product, indent=2) + '\n').encode()
    return {HERE / 'family.engine-bridge.schema.v1.json': raw,
        HERE / 'family.runtime-receipt.schema.v1.json': runtime_raw,
        HERE.parent / 'bridge/family-engine-types.ts': text}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    for target, raw in product().items():
        if args.write: target.write_bytes(raw)
        elif target.is_symlink() or not target.is_file() or target.read_bytes() != raw:
            raise ValueError("generated family bridge drift: " + target.name)


if __name__ == "__main__":
    main()
