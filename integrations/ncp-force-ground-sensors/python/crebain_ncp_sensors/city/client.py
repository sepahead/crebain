"""Sequential typed city control, original-byte export, and observed/acknowledged facts."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import math
import time

from ncp_local import modular_wire as w
from ncp_local.modular_client import Client

from . import codec as c, types as t
from .contract import CityContract


@dataclass(frozen=True, slots=True)
class Reading:
    manifest: t.SourceManifest
    byte_manifest: t.BufferManifest
    payload: bytes


@dataclass(frozen=True, slots=True)
class Observation:
    batch: t.Batch
    readings: tuple[Reading, ...]
    source_failed: bool


@dataclass(frozen=True, slots=True)
class SessionResult:
    prepared: t.Prepared
    terminal: t.Terminal
    raw_bytes: int
    payload_count: int
    predecessor: str


@dataclass(frozen=True, slots=True)
class CommittedObservation:
    """Last fully checked response; its ACK may remain unobserved."""

    operation: str
    response: w.Response


class SourceFailure(RuntimeError):
    """Known source failure; prior originals remain available, successful Finish is forbidden."""


class PendingBatch:
    def __init__(self, session, request, response, observation):
        self._session = session
        self.request = request
        self.response = response
        self.observation = observation
        self.released = False
        self._entered = False

    def release(self):
        if not self.released:
            self._session._release(self)

    def __enter__(self):
        c.require(not self._entered and not self.released)
        self._session._require_active()
        c.require(self._session._pending is self)
        self._entered = True
        return self

    def __exit__(self, kind, error, traceback):
        if kind is None:
            self.release()
        else:
            self._session.close()


class CitySession:
    """One caller, one shared world, one retained observation; no automatic retry."""

    def __init__(
        self,
        reader,
        writer,
        binding,
        prepare,
        *,
        deadline,
        exchange=None,
        source_identity=None,
    ):
        c.require(
            type(deadline) in (int, float)
            and math.isfinite(deadline)
            and deadline > time.monotonic()
        )
        c.require(exchange is None or callable(exchange))
        CityContract.check_input(w.Prepare(prepare))
        self._reader, self._writer = reader, writer
        self._plan, self._deadline, self._exchange = prepare, deadline, exchange
        self._expected_source = source_identity
        self._client = Client(binding, CityContract)
        self._prepared = self._completed = self._pending = None
        self.prepare_request = self.prepare_response = None
        self.last_committed: CommittedObservation | None = None
        self.observed_prepared = False
        self.observed_completed_tick = 0
        self.observed_terminal: t.Terminal | None = None
        self.acknowledged_prepared = False
        self.acknowledged_completed_tick = 0
        self.acknowledged_terminal = False
        self.acknowledged_result_digest = None
        self.observed_native_retirement = False
        self._released = None
        self._accepted = ()
        self._actions = self._raw_bytes = self._payload_count = 0
        self._source_failed = self._aborted = False
        self.stage = "prepare"

    @property
    def next_tick(self):
        return self.acknowledged_completed_tick + 1

    def _require_active(self):
        c.require(self._prepared is not None and not self._client.is_retired)

    @contextmanager
    def _guard(self, stage):
        self.stage = stage
        try:
            yield
        except BaseException:
            self.close()
            raise

    def _call(self, operation, validate=None):
        request = self._client.begin(operation)
        response = (
            self._client.dispatch(self._reader, self._writer, deadline=self._deadline)
            if self._exchange is None
            else self._client.observe(
                self._exchange(
                    request, self._reader, self._writer, deadline=self._deadline
                )
            )
        )
        c.require(response.outcome is w.Outcome.COMMITTED, "binding")
        if validate is not None:
            validate(response.body.data)
        self.last_committed = CommittedObservation(self.stage, response)
        if type(operation) is w.Prepare:
            self.observed_prepared = True
            self._prepared = response.body.data
            self.prepare_request, self.prepare_response = request, response
        elif type(operation) is w.Application and type(operation.data) is t.Advance:
            self.observed_completed_tick = response.body.data.batch.tick
            self.observed_native_retirement = (
                type(response.body.data) is t.AdvanceFailed
            )
        elif type(operation) is w.Finish:
            self.observed_terminal = response.body.data
            self.observed_native_retirement = True
        elif type(operation) is w.Abort:
            self.observed_native_retirement = True
        # Fully checked COMMITTED facts survive an unobserved ACK.
        if self._exchange is None:
            ack = self._client.dispatch_acknowledgement(
                self._reader, self._writer, deadline=self._deadline
            )
        else:
            ack = self._client.observe_acknowledgement(
                self._exchange(
                    self._client.acknowledgement(),
                    self._reader,
                    self._writer,
                    deadline=self._deadline,
                )
            )
        c.require(ack.outcome is w.Outcome.ACKNOWLEDGED, "binding")
        self.acknowledged_result_digest = response.result_digest
        return request, response

    def prepare(self):
        c.require(self._prepared is None and not self._client.is_retired)
        with self._guard("prepare"):
            self._call(
                w.Prepare(self._plan),
                lambda value: c.require(
                    self._expected_source is None
                    or value.source_identity == self._expected_source,
                    "binding",
                ),
            )
            self.acknowledged_prepared = True
        return self._prepared

    def advance(self, rows=None):
        self._require_active()
        c.require(
            not self._source_failed
            and self._pending is None
            and self.next_tick <= self._plan.world.horizon_ticks
        )
        if rows is None:
            c.require(bool(self._accepted))
            rows = tuple((i, "hold", row[1]) for i, row in enumerate(self._accepted))
        additions = c.validate_rows(self._plan, rows, self._accepted, self._actions)
        command = t.Advance(
            "advance",
            self._prepared.plan_digest,
            self._prepared.roster_digest,
            self.next_tick,
            self._released,
            rows,
        )
        with self._guard("advance"):
            request, response = self._call(
                w.Application(command),
                lambda result: c.validate_batch(
                    self._plan, self._prepared, command, result, self._accepted
                ),
            )
            result = response.body.data
            self.acknowledged_completed_tick = result.batch.tick
            self._accepted = result.batch.control.rows
            self._actions += additions
            self._source_failed = type(result) is t.AdvanceFailed
            readings = []
            for slot in result.batch.slots:
                if type(slot) is not t.Produced:
                    continue
                self.stage = "export"
                export = t.ExportSource(
                    kind="export_source",
                    plan_digest=result.batch.plan_digest,
                    batch_digest=result.batch.batch_digest,
                    request_id=slot.request_id,
                    source_id=slot.source_id,
                    entity_index=slot.entity_index,
                    source_body_tick=slot.source_body_tick,
                    source_production_digest=slot.source_production_digest,
                    original_payload_sha256=slot.original_payload_sha256,
                )

                def joined(value):
                    manifest = value.typed_manifest
                    for field in ("source_catalog_digest", "scene_sha256"):
                        c.require(
                            getattr(manifest, field) == getattr(result.batch, field),
                            "binding",
                        )
                    c.require(
                        manifest.source_config_digest == slot.source_config_digest
                        and c.equal_bits(manifest.tensor, slot.tensor),
                        "binding",
                    )

                _, exported = self._call(w.Application(export), joined)
                typed, manifest = (
                    exported.body.data.typed_manifest,
                    exported.body.data.byte_manifest,
                )
                payload = bytearray(manifest.byte_length)
                for index in range(manifest.chunk_count):
                    self.stage = "read"
                    _, response_chunk = self._call(
                        w.Read(manifest.reference(), manifest.manifest_digest, index)
                    )
                    chunk = response_chunk.body.data
                    decoded = chunk.decoded()
                    c.require(
                        chunk.manifest_digest == manifest.manifest_digest
                        and chunk.index == index
                        and chunk.offset == index * manifest.chunk_bytes,
                        "binding",
                    )
                    c.require(
                        len(decoded)
                        == min(
                            manifest.chunk_bytes, manifest.byte_length - chunk.offset
                        ),
                        "binding",
                    )
                    payload[chunk.offset : chunk.offset + len(decoded)] = decoded
                complete = bytes(payload)
                del payload, decoded, response_chunk, chunk
                c.validate_payload(typed, manifest, complete)
                readings.append(Reading(typed, manifest, complete))
                self.stage = "buffer_release"
                self._call(w.Release(manifest.reference()))
            self._raw_bytes += sum(len(reading.payload) for reading in readings)
            self._payload_count += len(readings)
            self._pending = PendingBatch(
                self,
                request,
                response,
                Observation(result.batch, tuple(readings), self._source_failed),
            )
            return self._pending

    def _release(self, batch):
        self._require_active()
        c.require(self._pending is batch)
        b = batch.observation.batch
        with self._guard("batch_release"):
            self._call(
                w.Application(
                    t.ReleaseBatch(
                        "release_batch", b.plan_digest, b.batch_digest, b.tick
                    )
                )
            )
            self._released = b.batch_digest
            self._pending = None
            batch.released = True

    def abort(self):
        self._require_active()
        with self._guard("abort"):
            self._call(w.Abort())
            self._aborted = True
        self.close()

    def finish(self):
        if self._completed is not None:
            return self._completed
        if self._source_failed:
            if not self._aborted and not self._client.is_retired:
                self.abort()
            raise SourceFailure(
                "city source failed; retained originals do not authorize successful Finish"
            )
        self._require_active()
        c.require(
            self._pending is None
            and self.acknowledged_completed_tick == self._plan.world.horizon_ticks
        )
        with self._guard("finish"):
            _, response = self._call(
                w.Finish(
                    t.Finish(
                        self._prepared.plan_digest,
                        self.acknowledged_completed_tick,
                        self._released,
                    )
                )
            )
            self.acknowledged_terminal = True
            self._completed = SessionResult(
                self._prepared,
                response.body.data,
                self._raw_bytes,
                self._payload_count,
                self._client.predecessor,
            )
        self.close()
        return self._completed

    def close(self):
        self._client.retire_channel()

    def __enter__(self):
        self.prepare()
        return self

    def __exit__(self, kind, error, traceback):
        self.close()
