"""Sequential reading on trusted streams; this module does not launch processes."""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Sequence
from contextlib import contextmanager
from typing import BinaryIO, Protocol

from ncp_local import modular_wire as w
from ncp_local.modular_client import Client

from . import codec as c
from . import types as t
from .contract import SensorContract


class Exchange(Protocol):
    """Host-supplied transport boundary; returns one original response frame."""

    def __call__(
        self,
        request: bytes,
        reader: BinaryIO,
        writer: BinaryIO,
        *,
        deadline: float,
    ) -> bytes: ...


class SessionError(RuntimeError):
    """A stopped session with its last validated prefix, never an invented tick."""

    def __init__(
        self,
        stage: str,
        validated: int,
        recorded: int,
        last_digest: str | None,
        attempted_tick: int | None,
        advance_result_observed: bool,
        engine_retirement_confirmed: bool,
    ) -> None:
        super().__init__(
            f"sensor session stopped during {stage}; last validated tick {validated}"
        )
        self.stage = stage
        self.last_validated_tick = validated
        self.last_recorded_tick = recorded
        self.last_batch_digest = last_digest
        self.attempted_tick = attempted_tick
        self.advance_result_observed = advance_result_observed
        self.engine_retirement_confirmed = engine_retirement_confirmed


class PendingBatch:
    """A complete observation whose producer buffers still await explicit release."""

    def __init__(
        self,
        session: SensorSession,
        request: bytes,
        response: w.Response,
        observation: t.BatchObservation,
    ) -> None:
        self._session = session
        self._request = request
        self._response = response
        self._observation = observation
        self._released = self._entered = False

    @property
    def request(self) -> bytes:
        return self._request

    @property
    def response(self) -> w.Response:
        return self._response

    @property
    def observation(self) -> t.BatchObservation:
        return self._observation

    @property
    def released(self) -> bool:
        return self._released

    def release(self) -> None:
        if not self._released:
            self._session._release(self)

    def __enter__(self) -> PendingBatch:
        c.require(not self._entered and not self._released)
        self._session._require_active()
        c.require(self._session._pending is self)
        self._entered = True
        return self

    def __exit__(self, error_type, error, traceback) -> None:
        if error_type is None:
            self.release()
        else:
            self._session.close()


class SensorSession:
    """Single-caller sensor steps on host-owned streams, with one live batch.

    Context entry prepares the producer. The host explicitly calls finish and
    owns stream closure, process lifetime, capture, and policy resource bounds.
    Context exit retires only this client; it makes no engine-cleanup claim.
    """

    def __init__(
        self,
        reader: BinaryIO,
        writer: BinaryIO,
        binding: t.BufferBinding,
        prepare: t.Prepare,
        *,
        deadline: float,
        exchange: Exchange | None = None,
    ) -> None:
        c.require(
            type(deadline) in (int, float)
            and math.isfinite(deadline)
            and deadline > time.monotonic()
        )
        c.require(exchange is None or callable(exchange))
        SensorContract.check_input(w.Prepare(prepare))
        self._reader, self._writer = reader, writer
        self._plan, self._deadline = prepare, deadline
        self._exchange = exchange
        self._client = Client(binding, SensorContract)
        self._prepared = self._prepare_request = self._prepare_response = None
        self._pending = self._completed = None
        self._validated = self._recorded = self._raw_bytes = self._payload_count = 0
        self._last_digest = self._accepted = self._attempted_tick = None
        self._advance_observed = self._retired = False
        self._stage = "prepare"

    @property
    def next_tick(self) -> int:
        return self._validated + 1

    @property
    def validated_ticks(self) -> int:
        return self._validated

    @property
    def prepare_request(self) -> bytes | None:
        return self._prepare_request

    @property
    def prepare_response(self) -> w.Response | None:
        return self._prepare_response

    def _require_active(self) -> None:
        c.require(self._prepared is not None and not self._client.is_retired)

    @contextmanager
    def _guard(self, stage: str):
        self._stage = stage
        try:
            yield
        except BaseException as error:
            self.close()
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            raise SessionError(
                self._stage,
                self._validated,
                self._recorded,
                self._last_digest,
                self._attempted_tick,
                self._advance_observed,
                self._retired,
            ) from error

    def _execute(self, operation: w.Operation) -> tuple[bytes, w.Response]:
        request = self._client.begin(operation)
        if self._exchange is None:
            response = self._client.dispatch(
                self._reader, self._writer, deadline=self._deadline
            )
        else:
            response = self._client.observe(
                self._exchange(
                    request, self._reader, self._writer, deadline=self._deadline
                )
            )
        c.require(response.outcome is w.Outcome.COMMITTED, "binding")
        return request, response

    def _acknowledge(self) -> None:
        if self._exchange is None:
            response = self._client.dispatch_acknowledgement(
                self._reader, self._writer, deadline=self._deadline
            )
        else:
            response = self._client.observe_acknowledgement(
                self._exchange(
                    self._client.acknowledgement(),
                    self._reader,
                    self._writer,
                    deadline=self._deadline,
                )
            )
        c.require(response.outcome is w.Outcome.ACKNOWLEDGED, "binding")

    def prepare(self) -> t.Prepared:
        c.require(self._prepared is None and not self._client.is_retired)
        with self._guard("prepare"):
            self._prepare_request, self._prepare_response = self._execute(
                w.Prepare(self._plan)
            )
            self._prepared = self._prepare_response.body.data
            self._acknowledge()
        return self._prepared

    def advance(self, target: t.SetTarget | None = None) -> PendingBatch:
        """Read one complete tick. Omit target only to hold an accepted target."""
        self._require_active()
        c.require(self._pending is None and self.next_tick <= self._plan.planned_ticks)
        if target is None:
            c.require(self._accepted is not None)
            action = t.Hold("hold", self._accepted)
        else:
            c.require(type(target) is t.SetTarget)
            c.validate_target(target, self._plan.specification.controller)
            action = target
        with self._guard("advance"):
            self._attempted_tick, self._advance_observed = self.next_tick, False
            command = t.Command(
                "advance_tick",
                self.next_tick,
                self._last_digest,
                action,
                t.CaptureReservation(),
            )
            request, response = self._execute(w.Application(command))
            result = response.body.data
            self._advance_observed = True
            c.validate_batch(self._plan, self._prepared, command, result)
            self._accepted = result.accepted_action_request_digest
            # Acknowledgement frees the result slot. Sensor buffers remain live.
            self._acknowledge()
            self._stage = "read"
            readings = []
            for slot in result.batch.slots:
                if type(slot) is t.NotDue:
                    continue
                manifest = slot.byte_manifest
                payload = bytearray(manifest.byte_length)
                for index in range(manifest.chunk_count):
                    _, chunk_response = self._execute(
                        w.Read(manifest.reference(), manifest.manifest_digest, index)
                    )
                    chunk = chunk_response.body.data
                    decoded = chunk.decoded()
                    remaining = manifest.byte_length - index * manifest.chunk_bytes
                    c.require(
                        chunk.manifest_digest == manifest.manifest_digest
                        and chunk.index == index,
                        "binding",
                    )
                    c.require(
                        chunk.offset == index * manifest.chunk_bytes
                        and len(decoded) == min(manifest.chunk_bytes, remaining),
                        "binding",
                    )
                    payload[chunk.offset : chunk.offset + len(decoded)] = decoded
                    self._acknowledge()
                del chunk, decoded
                readings.append(
                    c.validate_payload(slot.typed_manifest, manifest, bytes(payload))
                )
                del payload
            # Expose no partial batch, even when an earlier modality passed.
            observation = t.BatchObservation(result.batch, tuple(readings))
            self._validated, self._last_digest = result.tick, result.batch.batch_digest
            self._raw_bytes += sum(len(reading.payload) for reading in readings)
            self._payload_count += len(readings)
            self._pending = PendingBatch(self, request, response, observation)
            return self._pending

    def _release(self, batch: PendingBatch) -> None:
        self._require_active()
        c.require(self._pending is batch)
        with self._guard("release"):
            for slot in batch.observation.batch.slots:
                if type(slot) is t.Due:
                    self._execute(w.Release(slot.byte_manifest.reference()))
                    self._acknowledge()
            batch._released = True
            self._pending = None

    def finish(self) -> t.SessionResult:
        if self._completed is not None:
            return self._completed
        self._require_active()
        c.require(self._pending is None and self._validated == self._plan.planned_ticks)
        with self._guard("finish"):
            self._attempted_tick = None
            _, response = self._execute(
                w.Finish(
                    t.Finish(
                        self._prepared.plan_digest, self._validated, self._last_digest
                    )
                )
            )
            terminal = response.body.data
            c.require(terminal.planned_ticks == self._plan.planned_ticks, "binding")
            self._retired = terminal.engine_retirement == "confirmed"
            self._acknowledge()
            self._completed = t.SessionResult(
                self._prepared,
                terminal,
                self._raw_bytes,
                self._payload_count,
                self._client.predecessor,
            )
        self.close()
        return self._completed

    def close(self) -> None:
        self._client.retire_channel()

    def __enter__(self) -> SensorSession:
        self.prepare()
        return self

    def __exit__(self, error_type, error, traceback) -> None:
        self.close()


def run_session(
    reader: BinaryIO,
    writer: BinaryIO,
    binding: t.BufferBinding,
    prepare: t.Prepare,
    actions: Sequence[tuple[int, t.SetTarget]],
    recorder: Callable[[t.BatchObservation], None],
    *,
    deadline: float,
    exchange: Exchange | None = None,
) -> t.SessionResult:
    """Validate the full schedule, then release each batch before its callback.

    The host owns streams, cleanup, and callback bounds. An optional exchange
    function can capture original frames before source-buffer release. Use
    SensorSession for observation-dependent actions or explicit release timing.
    """
    SensorContract.check_input(w.Prepare(prepare))
    c.require(
        type(actions) in (tuple, list) and 1 <= len(actions) <= prepare.planned_ticks
    )
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
    with SensorSession(
        reader, writer, binding, prepare, deadline=deadline, exchange=exchange
    ) as session:
        for tick in range(1, prepare.planned_ticks + 1):
            batch = session.advance(schedule.get(tick))
            batch.release()
            with session._guard("record"):
                recorder(batch.observation)
                session._recorded = tick
            del batch
        return session.finish()
