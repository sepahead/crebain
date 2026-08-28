#!/usr/bin/env python3
"""Generate the normalized CREBAIN managed-runtime transcript fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import struct
import time
from pathlib import Path
from typing import Any

from managed_simulation_authoring_files import (
    BoundedProcess,
    BoundedProcessResult,
    ManagedSimulationSubprocessError,
    run_bounded_process,
)


ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "integrations" / "engram" / "managed-simulation"
CONTRACTS = INTEGRATION / "contracts"
DEFAULT_BINARY = (
    ROOT / "src-tauri" / "target" / "release" / "crebain-managed-simulation"
)
IPC = "engram.managed-runtime-ipc.v1"
GENERATION = {
    "installation_id": "inst_" + "a" * 64,
    "generation_id": "gen_" + "b" * 64,
    "ordinal": 1,
}
SCHEMAS = {
    "configuration": (
        "crebain.simulation.configuration.v1",
        "configuration.schema.json",
    ),
    "finish-request": (
        "engram.closed-loop-simulator.finish-request.v3",
        "standard-v3-finish-request.schema.json",
    ),
    "finish-response": (
        "engram.closed-loop-simulator.finish-response.v3",
        "standard-v3-finish-response.schema.json",
    ),
    "prepare-request": (
        "engram.closed-loop-simulator.prepare-request.v3",
        "standard-v3-prepare-request.schema.json",
    ),
    "prepare-response": (
        "engram.closed-loop-simulator.prepare-response.v3",
        "standard-v3-prepare-response.schema.json",
    ),
    "step-request": (
        "engram.closed-loop-simulator.step-request.v3",
        "standard-v3-step-request.schema.json",
    ),
    "step-response": (
        "engram.closed-loop-simulator.step-response.v3",
        "standard-v3-step-response.schema.json",
    ),
}
PROCESS_TIMEOUT_SECONDS = 10.0
PROCESS_INPUT_LIMIT = 1024 * 1024
PROCESS_OUTPUT_LIMIT = 1024 * 1024
PROCESS_DIAGNOSTIC_LIMIT = 4096


def canonical(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def standard_step_id(study_run_id: str, step_index: int) -> str:
    material = {
        "domain": "engram-extension-closed-loop-step-v2",
        "run_id": study_run_id,
        "step_index": step_index,
    }
    return "step_" + digest(canonical(material))[:32]


def schema_reference(key: str) -> dict[str, str]:
    schema_id, filename = SCHEMAS[key]
    return {
        "schema_id": schema_id,
        "schema_sha256": digest((CONTRACTS / filename).read_bytes()),
    }


def operation_roster() -> list[dict[str, Any]]:
    manifest = json.loads((INTEGRATION / "manifest.template.json").read_text())
    operations = manifest.get("runtime", {}).get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("manifest operation roster is unavailable")
    return operations


def host_handshake(roster_digest: str) -> dict[str, Any]:
    configuration = json.loads((INTEGRATION / "configuration.json").read_text())
    configuration_digest = digest(canonical(configuration))
    identity = {
        "manifest_exact_sha256": "1" * 64,
        "manifest_canonical_sha256": "2" * 64,
        "package_lock_exact_sha256": "3" * 64,
        "package_lock_canonical_sha256": "4" * 64,
        "package_sha256": "5" * 64,
        "executable_sha256": "6" * 64,
        "configuration_exact_sha256": configuration_digest,
        "configuration_canonical_sha256": configuration_digest,
        "target_id": "macos-aarch64-darwin",
        "profile": "engram.reviewed-native-development.v1",
        "launch_abi": "engram.managed-runtime-stdio.v1",
        "operation_roster_sha256": roster_digest,
        "schema_registry_sha256": "7" * 64,
        "installation_id": GENERATION["installation_id"],
    }
    return {
        "schema_version": "1.0",
        "protocol": IPC,
        "kind": "host.handshake",
        "sender": "host",
        "generation": GENERATION,
        "sequence": 0,
        "message_id": "msg_" + "1" * 32,
        "body": {
            "challenge": "chal_" + "c" * 64,
            "identity": identity,
            "configuration": {
                "schema": schema_reference("configuration"),
                "canonical_sha256": configuration_digest,
                "document": configuration,
            },
            "max_frame_bytes": 65536,
        },
    }


def operation_request(
    operation: dict[str, Any], sequence: int, marker: str, control: dict[str, Any]
) -> dict[str, Any]:
    identity_fields = ("operation_id", "class", "effect", "artifact_access")
    return {
        "schema_version": "1.0",
        "protocol": IPC,
        "kind": "operation.request",
        "sender": "host",
        "generation": GENERATION,
        "sequence": sequence,
        "message_id": "msg_" + marker * 32,
        "body": {
            "idempotency_key": "idem_" + marker * 64,
            "operation": {field: operation[field] for field in identity_fields},
            "request_schema": operation["request_schema"],
            "response_schema": operation["response_schema"],
            "compute_grant": {
                "mode": "host-one-shot",
                "grant_id": "grant_" + marker * 64,
                "generation_id": GENERATION["generation_id"],
                "operation_id": operation["operation_id"],
                "issued_for_sequence": sequence,
                "max_cpu_time_ms": operation["max_cpu_time_ms"],
                "valid_for_ms": 5000,
                "reusable": False,
            },
            "timeout_ms": 5000,
            "control": control,
            "bulk": {"inline": False, "references": []},
        },
    }


def decode_frames(payload: bytes) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    offset = 0
    while offset < len(payload):
        if len(payload) - offset < 4:
            raise ValueError("runtime emitted a truncated frame prefix")
        length = struct.unpack(">I", payload[offset : offset + 4])[0]
        start = offset + 4
        end = start + length
        if end > len(payload):
            raise ValueError("runtime emitted a truncated frame payload")
        frames.append(json.loads(payload[start:end]))
        offset = end
    return frames


def frame_record(direction: str, envelope: dict[str, Any]) -> dict[str, Any]:
    payload = canonical(envelope)
    return {
        "direction": direction,
        "payload_length": len(payload),
        "prefix_hex": struct.pack(">I", len(payload)).hex(),
        "payload_sha256": digest(payload),
        "envelope": envelope,
    }


def wire_frames(frames: list[dict[str, Any]]) -> bytes:
    return b"".join(
        struct.pack(">I", len(canonical(frame))) + canonical(frame) for frame in frames
    )


def bounded_diagnostic(payload: bytes) -> str:
    if len(payload) > 4096:
        raise RuntimeError("managed runtime diagnostic exceeded 4096 bytes")
    return payload.decode("utf-8", errors="replace").strip()


def runtime_failure(
    label: str, error: ManagedSimulationSubprocessError
) -> RuntimeError:
    diagnostic = error.stderr.decode("utf-8", errors="replace").strip()
    return RuntimeError(f"{label}: {error}: {diagnostic}")


def run_runtime(
    binary: Path,
    *,
    input_bytes: bytes,
    label: str,
) -> BoundedProcessResult:
    try:
        return run_bounded_process(
            [str(binary)],
            input_bytes=input_bytes,
            timeout_seconds=PROCESS_TIMEOUT_SECONDS,
            max_input_bytes=PROCESS_INPUT_LIMIT,
            max_stdout_bytes=PROCESS_OUTPUT_LIMIT,
            max_stderr_bytes=PROCESS_DIAGNOSTIC_LIMIT,
            label=label,
        )
    except ManagedSimulationSubprocessError as error:
        raise runtime_failure(label, error) from error


def read_process_frame(
    process: BoundedProcess,
    *,
    deadline: float,
) -> dict[str, Any]:
    length = struct.unpack(">I", process.read_exact(4, deadline=deadline))[0]
    if not 1 <= length <= 65_536:
        raise RuntimeError("managed runtime emitted an invalid lifecycle frame length")
    value = json.loads(process.read_exact(length, deadline=deadline))
    if not isinstance(value, dict):
        raise RuntimeError("managed runtime lifecycle response is not an object")
    return value


def stop_process(process: BoundedProcess) -> None:
    process.abort()


def verify_process_lifecycle(binary: Path, transcript: dict[str, Any]) -> None:
    host_frames = [
        frame["envelope"]
        for frame in transcript["frames"]
        if frame["direction"] == "host-to-runtime"
    ]
    active_wire = wire_frames(host_frames[:2])

    clean_eof = run_runtime(
        binary,
        input_bytes=active_wire,
        label="managed runtime active-EOF lifecycle",
    )
    if clean_eof.returncode != 0 or bounded_diagnostic(clean_eof.stderr):
        raise RuntimeError(
            "managed runtime did not cleanly cancel active state on input EOF"
        )
    clean_frames = decode_frames(clean_eof.stdout)
    if (
        len(clean_frames) != 2
        or clean_frames[1].get("body", {}).get("control", {}).get("run_state_active")
        is not True
    ):
        raise RuntimeError(
            "managed runtime active-EOF cancellation setup did not prepare"
        )

    truncated = run_runtime(
        binary,
        input_bytes=b"\x00\x00",
        label="managed runtime truncated-frame lifecycle",
    )
    if truncated.returncode != 2 or "frame.truncated-prefix" not in bounded_diagnostic(
        truncated.stderr
    ):
        raise RuntimeError("managed runtime did not fail closed on partial-frame EOF")

    if os.name != "posix":
        return
    process = BoundedProcess(
        [str(binary)],
        stdin_pipe=True,
        max_input_bytes=PROCESS_INPUT_LIMIT,
        max_stdout_bytes=PROCESS_OUTPUT_LIMIT,
        max_stderr_bytes=PROCESS_DIAGNOSTIC_LIMIT,
        label="managed runtime signal-cancellation lifecycle",
    )
    try:
        deadline = time.monotonic() + PROCESS_TIMEOUT_SECONDS
        process.write_all(active_wire, deadline=deadline)
        handshake_response = read_process_frame(process, deadline=deadline)
        prepare_response = read_process_frame(process, deadline=deadline)
        if (
            handshake_response.get("kind") != "runtime.handshake"
            or prepare_response.get("body", {})
            .get("control", {})
            .get("run_state_active")
            is not True
        ):
            raise RuntimeError(
                "managed runtime signal-cancellation setup did not prepare"
            )
        process.send_signal(signal.SIGTERM)
        result = process.wait(deadline=deadline)
        if result.returncode != -signal.SIGTERM:
            raise RuntimeError(
                f"managed runtime SIGTERM exit {result.returncode}, "
                f"expected {-signal.SIGTERM}"
            )
        if bounded_diagnostic(result.stderr):
            raise RuntimeError(
                "managed runtime emitted a diagnostic during SIGTERM cancellation"
            )
    except ManagedSimulationSubprocessError as error:
        raise runtime_failure(
            "managed runtime signal-cancellation lifecycle",
            error,
        ) from error
    finally:
        stop_process(process)


def generate(binary: Path) -> dict[str, Any]:
    roster = operation_roster()
    roster_digest = digest(b"engram-managed-operation-roster-v1\0" + canonical(roster))
    by_id = {row["operation_id"]: row for row in roster}
    channel_ids = ["channel-01", "channel-02", "channel-03"]
    subject_ids = ["subject-01", "subject-02", "subject-03"]
    study_run_id = "study-run-standard-wire-01"
    configuration = json.loads((INTEGRATION / "configuration.json").read_text())
    configuration_digest = digest(canonical(configuration))
    controls = {
        "prepare": {
            "schema_version": "engram.closed-loop-simulator.prepare-request.v3",
            "study_run_id": study_run_id,
            "closed_loop_definition_sha256": "8" * 64,
            "runtime_adapter_configuration_sha256": configuration_digest,
            "step_count": 1,
            "tic_unit": "microsecond",
            "causality_policy": "sample-runtime-run-controller-apply-zoh-v1",
            "step_duration_tics": 20000,
            "channel_ids": channel_ids,
            "subject_kinds": ["simulated.drone"] * 3,
            "subject_ids": subject_ids,
            "observation_space_ids": ["kinematics.position-velocity-enu-si"] * 3,
            "action_space_ids": ["kinematics.acceleration-enu-si"] * 3,
            "observation_widths": [6] * 3,
            "action_widths": [3] * 3,
            "observation_component_ids": [
                "position.east",
                "position.north",
                "position.up",
                "velocity.east",
                "velocity.north",
                "velocity.up",
            ]
            * 3,
            "observation_unit_ids": [
                "si.metre",
                "si.metre",
                "si.metre",
                "si.metre-per-second",
                "si.metre-per-second",
                "si.metre-per-second",
            ]
            * 3,
            "action_component_ids": [
                "acceleration.east",
                "acceleration.north",
                "acceleration.up",
            ]
            * 3,
            "action_unit_ids": ["si.metre-per-second-squared"] * 9,
            "action_min_values": [-10] * 9,
            "action_max_values": [10] * 9,
            "safe_action_values": [0] * 9,
        },
        "step": {
            "schema_version": "engram.closed-loop-simulator.step-request.v3",
            "study_run_id": study_run_id,
            "step_index": 1,
            "step_id": standard_step_id(study_run_id, 1),
            "source_snapshot_sha256": "a" * 64,
            "runtime_request_sha256": "d" * 64,
            "tic_unit": "microsecond",
            "causality_policy": "sample-runtime-run-controller-apply-zoh-v1",
            "step_duration_tics": 20000,
            "source_simulation_time_tics": 0,
            "target_simulation_time_tics": 20000,
            "channel_ids": channel_ids,
            "subject_ids": subject_ids,
            "action_widths": [3] * 3,
            "action_values": [1] * 9,
            "saturated_values": [False] * 9,
            "action_dispositions": ["bounded-neural-proposal"] * 3,
        },
        "finish": {
            "schema_version": "engram.closed-loop-simulator.finish-request.v3",
            "study_run_id": study_run_id,
            "final_step_index": 1,
            "final_snapshot_sha256": "f" * 64,
            "tic_unit": "microsecond",
            "causality_policy": "sample-runtime-run-controller-apply-zoh-v1",
            "step_duration_tics": 20000,
            "final_simulation_time_tics": 20000,
            "reason": "completed",
        },
    }
    host_frames = [host_handshake(roster_digest)]
    for sequence, (name, marker) in enumerate(
        (("prepare", "2"), ("step", "3"), ("finish", "4")), start=1
    ):
        host_frames.append(
            operation_request(
                by_id[f"crebain.simulation.{name}.v3"],
                sequence,
                marker,
                controls[name],
            )
        )
    wire = wire_frames(host_frames)
    completed = run_runtime(
        binary,
        input_bytes=wire,
        label="managed runtime sample transcript",
    )
    if completed.returncode != 0:
        diagnostic = bounded_diagnostic(completed.stderr)
        raise RuntimeError(
            f"managed runtime rejected its sample transcript: {diagnostic or completed.returncode}"
        )
    runtime_frames = decode_frames(completed.stdout)
    if len(runtime_frames) != 4:
        raise ValueError("managed runtime emitted an unexpected frame count")
    fixed_markers = ("8", "5", "6", "7")
    for frame, marker in zip(runtime_frames, fixed_markers, strict=True):
        frame["message_id"] = "msg_" + marker * 32
    runtime_frames[0]["body"]["runtime_nonce"] = "nonce_" + "9" * 64
    frames: list[dict[str, Any]] = []
    for host, runtime in zip(host_frames, runtime_frames, strict=True):
        frames.append(frame_record("host-to-runtime", host))
        frames.append(frame_record("runtime-to-host", runtime))
    return {
        "schema_version": "crebain.simulation.sample-transcript.v2",
        "fixture_only": True,
        "framing": "uint32-be-length-prefixed-canonical-json",
        "operation_roster_sha256": roster_digest,
        "scenario": {
            "drone_count": 3,
            "step_count": 1,
            "surface": "standard-v3",
            "authority": "simulator-only",
            "ncp_mode": "none",
        },
        "frames": frames,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--compact", action="store_true")
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--write", type=Path)
    arguments = parser.parse_args()
    if arguments.verify is not None and arguments.write is not None:
        raise SystemExit("--verify and --write are mutually exclusive")
    document = generate(arguments.binary.resolve())
    if arguments.verify is not None:
        expected = json.loads(arguments.verify.resolve().read_text())
        if document != expected:
            raise SystemExit("managed simulation transcript fixture is stale")
        verify_process_lifecycle(arguments.binary.resolve(), document)
        print("OK: managed simulation transcript and process lifecycle replay exactly")
        return
    if arguments.write is not None:
        destination = arguments.write.resolve()
        destination.write_bytes(canonical(document) + b"\n")
        print(f"Wrote {destination}")
        return
    separators = (",", ":") if arguments.compact else None
    print(
        json.dumps(
            document, indent=None if arguments.compact else 2, separators=separators
        )
    )


if __name__ == "__main__":
    main()
