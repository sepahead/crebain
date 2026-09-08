"""Sequential reading on trusted streams; this module does not launch processes."""

from __future__ import annotations

from collections.abc import Callable, Sequence
import math
import time
from typing import BinaryIO

from ncp_local import modular_wire as w
from ncp_local.modular_client import Client

from . import codec as c
from . import types as t
from .contract import SensorContract


class SessionError(RuntimeError):
    """A stopped session with its last validated prefix, never an invented tick."""

    def __init__(self, stage: str, validated: int, recorded: int, last_digest: str | None,
                 attempted_tick: int | None, advance_result_observed: bool,
                 engine_retirement_confirmed: bool) -> None:
        super().__init__(f"sensor session stopped during {stage}; last validated tick {validated}")
        self.stage = stage
        self.last_validated_tick = validated
        self.last_recorded_tick = recorded
        self.last_batch_digest = last_digest
        self.attempted_tick = attempted_tick
        self.advance_result_observed = advance_result_observed
        self.engine_retirement_confirmed = engine_retirement_confirmed


def run_session(
    reader: BinaryIO,
    writer: BinaryIO,
    binding: t.BufferBinding,
    prepare: t.Prepare,
    actions: Sequence[tuple[int, t.SetTarget]],
    recorder: Callable[[t.BatchObservation], None],
    *,
    deadline: float,
) -> t.SessionResult:
    """Read every due payload, release it explicitly, then deliver a local observation.

    The host supplies one absolute monotonic deadline and owns both streams and
    engine cleanup. No reconnect, automatic retry, process launch, or capture is
    implicit. A callback's own storage, work, and retention require host bounds.
    """
    c.require(type(deadline) in (int, float) and math.isfinite(deadline) and deadline > time.monotonic())
    SensorContract.check_input(w.Prepare(prepare))
    c.require(type(actions) in (tuple, list) and 1 <= len(actions) <= prepare.planned_ticks)
    schedule = {}
    prior = 0
    for item in actions:
        c.require(type(item) in (tuple, list) and len(item) == 2)
        tick, target = item
        c.require(type(tick) is int and prior < tick <= prepare.planned_ticks)
        c.require(type(target) is t.SetTarget)
        c.validate_target(target, prepare.specification.controller)
        schedule[tick] = target
        prior = tick
    c.require(1 in schedule and callable(recorder))
    client = Client(binding, SensorContract)
    validated = recorded = raw_bytes = payload_count = 0
    last_digest = accepted = None
    attempted_tick = None
    advance_observed = retired = False
    stage = "prepare"

    def execute(operation: w.Operation) -> w.Response:
        client.begin(operation)
        response = client.dispatch(reader, writer, deadline=deadline)
        c.require(response.outcome is w.Outcome.COMMITTED, "binding")
        return response

    def acknowledge() -> None:
        response = client.dispatch_acknowledgement(reader, writer, deadline=deadline)
        c.require(response.outcome is w.Outcome.ACKNOWLEDGED, "binding")

    try:
        prepared = execute(w.Prepare(prepare)).body.data
        acknowledge()
        for tick in range(1, prepare.planned_ticks + 1):
            attempted_tick, advance_observed = tick, False
            stage = "advance"
            action = schedule.get(tick) or t.Hold("hold", accepted)
            command = t.Command("advance_tick", tick, last_digest, action, t.CaptureReservation())
            result = execute(w.Application(command)).body.data
            advance_observed = True
            c.validate_batch(prepare, prepared, command, result)
            accepted = result.accepted_action_request_digest
            acknowledge()  # Frees only the result slot. Sensor buffers remain live.
            stage = "read"
            readings = []
            for slot in result.batch.slots:
                if type(slot) is t.NotDue:
                    continue
                manifest = slot.byte_manifest
                payload = bytearray(manifest.byte_length)
                for index in range(manifest.chunk_count):
                    chunk = execute(w.Read(manifest.reference(), manifest.manifest_digest, index)).body.data
                    decoded = chunk.decoded()
                    remaining = manifest.byte_length - index * manifest.chunk_bytes
                    c.require(chunk.manifest_digest == manifest.manifest_digest and chunk.index == index, "binding")
                    c.require(chunk.offset == index * manifest.chunk_bytes and len(decoded) == min(manifest.chunk_bytes, remaining), "binding")
                    payload[chunk.offset:chunk.offset + len(decoded)] = decoded
                    acknowledge()
                del chunk, decoded
                readings.append(c.validate_payload(slot.typed_manifest, manifest, bytes(payload)))
                del payload
            # Nothing reaches the recorder until the complete due roster passes.
            observation = t.BatchObservation(result.batch, tuple(readings))
            validated, last_digest = tick, result.batch.batch_digest
            stage = "release"
            for slot in result.batch.slots:
                if type(slot) is t.Due:
                    execute(w.Release(slot.byte_manifest.reference()))
                    acknowledge()
            stage = "record"
            recorder(observation)
            recorded = tick
            raw_bytes += sum(len(reading.payload) for reading in readings)
            payload_count += len(readings)
            del observation, readings, result
        stage = "finish"
        attempted_tick = None
        terminal = execute(w.Finish(t.Finish(prepared.plan_digest, validated, last_digest))).body.data
        c.require(terminal.planned_ticks == prepare.planned_ticks, "binding")
        retired = terminal.engine_retirement == "confirmed"
        acknowledge()
        return t.SessionResult(prepared, terminal, raw_bytes, payload_count, client.predecessor)
    except BaseException as error:
        client.retire_channel()
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        raise SessionError(stage, validated, recorded, last_digest, attempted_tick, advance_observed, retired) from error
    finally:
        client.retire_channel()
