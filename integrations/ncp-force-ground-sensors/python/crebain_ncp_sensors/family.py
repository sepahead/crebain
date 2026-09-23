"""Privileged live-family orchestration on separately owned NCP streams.

Only the trusted label collector receives this object. Ordinary predictors receive
immutable BatchObservation values, without this family, its selectors, or its peers.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import math
import struct
import time

from ncp_local import modular_wire as w
from ncp_local.modular_client import Client

from . import codec as c, family_contract as fc, family_types as f, types as t
from .client import PendingBatch, _read_observation


@dataclass(frozen=True, slots=True)
class _RestoredBatchContext:
    """Local checked ancestry joins, without fabricating a public Prepared response."""

    plan_digest: str
    sensor_catalog: t.SensorCatalog
    source_identity: str
    engine_owner_id: str
    scene_sha256: str


class _Endpoint:
    def __init__(self, family, slot, reader, writer, contract, exchange):
        self._family, self.slot = family, slot
        self._reader, self._writer = reader, writer
        self.binding = family.plan.canonical_binding if slot == 0 else family.plan.branches[slot - 1].binding
        self._client = Client(self.binding, contract)
        self._exchange = exchange
        self._prepared = self._pending = self._terminal = None
        self._accepted = self._last_digest = None
        self.validated_tick = 0 if slot == 0 else family.plan.landmark_tick
        self.attempted_tick = None
        self.last_committed = None
        self.last_acknowledged = None
        self.channel_shutdown_requested = False
        self.failed = False
        self._last_batch = None
        self._raw_bytes = self._payload_count = 0

    @property
    def next_tick(self):
        return self.validated_tick + 1

    @property
    def terminal(self):
        return self._terminal

    @contextmanager
    def _guard(self):
        try:
            yield
        except BaseException as primary:
            self.failed = True
            try:
                self._family.close()
            except BaseException as cleanup:
                raise BaseExceptionGroup("family endpoint and local retirement failed", [primary, cleanup])
            raise

    def _require_active(self):
        c.require(self._prepared is not None and not self._client.is_retired and not self._family.failed)
        c.require(time.monotonic() < self._family.deadline)

    def _execute(self, operation):
        request = self._client.begin(operation)
        if self._exchange is None:
            response = self._client.dispatch(self._reader, self._writer, deadline=self._family.deadline)
        else:
            response = self._client.observe(self._exchange(
                request, self._reader, self._writer, deadline=self._family.deadline,
            ))
        c.require(response.outcome is w.Outcome.COMMITTED, "binding")
        # Record the complete observed outcome before an ACK can fail.
        self.last_committed = response
        return request, response

    def _acknowledge(self):
        if self._exchange is None:
            response = self._client.dispatch_acknowledgement(
                self._reader, self._writer, deadline=self._family.deadline,
            )
        else:
            response = self._client.observe_acknowledgement(self._exchange(
                self._client.acknowledgement(), self._reader, self._writer, deadline=self._family.deadline,
            ))
        c.require(response.outcome is w.Outcome.ACKNOWLEDGED, "binding")
        self.last_acknowledged = self.last_committed

    def _roundtrip(self, operation):
        request, response = self._execute(operation)
        self._acknowledge()
        return request, response

    def advance(self, target=None):
        """Read one complete original sensor batch; release remains explicit."""
        self._require_active()
        c.require(self._pending is None and self.next_tick <= self._family.plan.body.planned_ticks)
        if target is None:
            c.require(self._accepted is not None)
            action = t.Hold("hold", self._accepted)
        else:
            c.require(type(target) is t.SetTarget)
            c.validate_target(target, self._family.plan.body.specification.controller)
            action = target
        self._admit_advance(action)
        with self._guard():
            self.attempted_tick = self.next_tick
            command = t.Command("advance_tick", self.next_tick, self._last_digest, action, t.CaptureReservation())
            request, response = self._execute(w.Application(command))
            result = response.body.data
            c.validate_batch(self._family.plan.body, self._prepared, command, result.body)
            self._validate_advance(result, response)
            self._acknowledge()
            observation = _read_observation(result.body, self._execute, self._acknowledge)
            self._record_observation(observation)
            self._accepted = result.body.accepted_action_request_digest
            self.validated_tick = result.body.tick
            self._last_digest = result.body.batch.batch_digest
            self._last_batch = result.body.batch
            self._raw_bytes += sum(len(reading.payload) for reading in observation.readings)
            self._payload_count += len(observation.readings)
            self._pending = PendingBatch(self, request, response, observation)
            return self._pending

    def _release(self, batch):
        self._require_active()
        c.require(self._pending is batch)
        with self._guard():
            for reading in batch.observation.readings:
                self._roundtrip(w.Release(reading.byte_manifest.reference()))
            batch._released = True
            self._pending = None

    def _idle(self):
        self._require_active()
        c.require(self._pending is None)

    def _finish_body(self):
        self._idle()
        c.require(self.validated_tick == self._family.plan.body.planned_ticks)
        return t.Finish(self._prepared.plan_digest, self.validated_tick, self._last_digest)

    def close(self):
        self._client.retire_channel()

    def _record_observation(self, observation):
        pass


class CanonicalSession(_Endpoint):
    """Privileged parent peer. The originating native parent stays live through labels."""

    checkpointed: f.Checkpointed | None = None
    decision: f.DecisionCommitted | None = None
    decision_stamp: f.CommittedStamp | None = None
    selected_execution: f.CommittedStamp | None = None
    final_state: f.CanonicalFinalState | None = None
    checkpoint_released = False

    def prepare(self):
        c.require(self._prepared is None and not self._client.is_retired)
        with self._guard():
            _, response = self._execute(w.Prepare(f.CanonicalPrepare(self._family.plan)))
            result = response.body.data
            if self._family.source_identity is not None:
                c.require(result.body.source_identity == self._family.source_identity, "binding")
            self._prepared = result.body
            self._family.digest = result.family_plan_digest
            self._acknowledge()
            return result

    def _admit_advance(self, action):
        landmark = self._family.plan.landmark_tick
        if self.next_tick == landmark + 1:
            c.require(self.decision is not None and c.equal_bits(action, self.decision.selected_target), "binding")
        elif self.next_tick > landmark + 1:
            c.require(type(action) is t.Hold)
        else:
            c.require(self.checkpointed is None)

    def _validate_advance(self, result, response):
        final = self._family.plan.body.planned_ticks
        c.require(result.ancestry is None, "binding")
        c.require((result.canonical_final_state is not None) == (result.body.tick == final), "binding")
        if result.canonical_final_state is not None:
            self.final_state = result.canonical_final_state
            self.selected_execution = fc.stamp(response)

    def checkpoint(self):
        self._idle()
        c.require(self.validated_tick == self._family.plan.landmark_tick and self.checkpointed is None)
        with self._guard():
            _, response = self._execute(w.Application(f.CheckpointCommand(
                "checkpoint", self.validated_tick, self._last_digest,
            )))
            result = response.body.data
            c.require(result.reference.family_id == self._family.plan.family_id
                      and result.reference.parent_native_owner_id == self._prepared.engine_owner_id
                      and result.accepted_native_batch_sha256 == self._last_batch.engine_batch_sha256, "binding")
            expected = tuple(f.PixelIdentity(slot.sensor_id, slot.byte_manifest.payload_sha256)
                             for slot in self._last_batch.slots
                             if type(slot) is t.Due and slot.typed_manifest.tensor.kind != "pressure")
            c.require(result.pixels == expected, "binding")
            self.checkpointed = result
            self._acknowledge()
            return result

    def commit_decision(self, forecast_commitment_digest, selected_case_id):
        """Bind original forecast-artifact bytes separately from the actual collection action."""
        self._idle()
        c.require(self.checkpointed is not None and self.decision is None)
        selected = next((branch for branch in self._family.plan.branches
                         if branch.case_id == selected_case_id and branch.purpose == "label"), None)
        c.require(selected is not None)
        fc.decode("Digest", forecast_commitment_digest)
        with self._guard():
            _, response = self._execute(w.Application(f.CommitDecisionCommand(
                "commit_decision", self.checkpointed.reference, forecast_commitment_digest, selected_case_id,
            )))
            result = response.body.data
            c.require(c.equal_bits(result.selected_target, selected.target), "binding")
            self.decision, self.decision_stamp = result, fc.stamp(response)
            self._acknowledge()
            return result

    def release_checkpoint(self):
        self._idle()
        c.require(self.checkpointed is not None and not self.checkpoint_released)
        c.require(all(branch.channel_shutdown_requested and branch.terminal is not None for branch in self._family.evaluations))
        with self._guard():
            last = self._family.evaluations[-1].terminal_stamp
            _, response = self._execute(w.Application(f.ReleaseCheckpointCommand(
                "release_checkpoint", self.checkpointed.reference, last.result_digest,
            )))
            self.checkpoint_released = True
            self._acknowledge()
            return response.body.data

    def finish(self):
        if self._terminal is not None and self.channel_shutdown_requested:
            return self._terminal
        body = self._finish_body()
        c.require(self.checkpoint_released and self.final_state is not None)
        terminals = tuple(branch.terminal_stamp for branch in self._family.evaluations)
        c.require(all(terminal is not None for terminal in terminals))
        with self._guard():
            _, response = self._execute(w.Finish(f.CanonicalFinish(body, self._family.digest, terminals)))
            terminal = response.body.data
            c.require(terminal.family_id == self._family.plan.family_id
                      and c.equal_bits(terminal.canonical_final_state, self.final_state), "binding")
            self._terminal = terminal
            self._acknowledge()
            self._family._shutdown(0)
            self.channel_shutdown_requested = True
            self.close()
            return terminal


class EvaluationSession(_Endpoint):
    """One separately bound restored sibling with a restricted pressure-label operation."""

    def __init__(self, *args):
        super().__init__(*args)
        self.reservation = self.restored = self.evaluated = self.terminal_stamp = None
        self.evaluation_stamp = None
        self._segments = []
        self._pressure = bytearray()

    @property
    def branch(self):
        return self._family.plan.branches[self.slot - 1]

    def prepare(self):
        c.require(self.reservation is not None and self._prepared is None and not self._client.is_retired)
        with self._guard():
            _, response = self._execute(w.Prepare(f.EvaluationPrepare(self.reservation, self._family.digest)))
            result = response.body.data
            canonical = self._family.canonical
            origin = canonical.checkpointed
            ancestry = result.ancestry
            c.require(ancestry.family_id == self._family.plan.family_id
                      and ancestry.origin_engine_run_id == "ncp-" + canonical.binding.run_id
                      and ancestry.origin_sensor_batch_digest == origin.accepted_sensor_batch_digest
                      and ancestry.origin_native_batch_sha256 == origin.accepted_native_batch_sha256
                      and ancestry.action_history_position == origin.accepted_action_position
                      and ancestry.selection == canonical.decision_stamp
                      and ancestry.selected_execution == canonical.selected_execution, "binding")
            c.require(ancestry.native_owner_id != canonical._prepared.engine_owner_id, "binding")
            earlier = self._family.evaluations[:self.slot - 1]
            c.require(all(branch.restored is not None
                          and ancestry.native_owner_id != branch.restored.ancestry.native_owner_id
                          and ancestry.graphics_generation != branch.restored.ancestry.graphics_generation
                          for branch in earlier), "binding")
            c.require(result.cpu_state_sha256 == origin.cpu_state_sha256
                      and result.render_input_sha256 == origin.render_input_sha256
                      and result.pixels == origin.pixels, "binding")
            c.require(c.equal_bits(result.sensor_catalog, canonical._prepared.sensor_catalog), "binding")
            self._prepared = _RestoredBatchContext(
                result.sensor_catalog.plan_digest, result.sensor_catalog,
                canonical._prepared.source_identity, ancestry.native_owner_id,
                canonical._prepared.scene_sha256,
            )
            self.restored = result
            self._acknowledge()
            return result

    def _admit_advance(self, action):
        if self.next_tick == self._family.plan.landmark_tick + 1:
            c.require(c.equal_bits(action, self.branch.target), "binding")
        else:
            c.require(type(action) is t.Hold)

    def _validate_advance(self, result, response):
        c.require(self.restored is not None and result.ancestry == self.restored.ancestry
                  and result.canonical_final_state is None, "binding")

    def _record_observation(self, observation):
        target = self._family.plan.evaluation
        if target.first_tick <= observation.batch.body_tick <= target.last_tick:
            selected = [reading for reading in observation.readings if reading.manifest.sensor_id == target.sensor_id]
            c.require(len(selected) == 1, "binding")
            reading = selected[0]
            tensor = reading.manifest.tensor
            c.require(len(self._segments) < 3 and len(self._pressure) + len(reading.payload) <= 3200, "capacity")
            self._segments.append(f.PressureSegment(
                reading.manifest.source_body_tick, reading.manifest.available_after_body_tick,
                tensor.sample_start, tensor.sample_end, reading.manifest.manifest_digest,
                reading.byte_manifest.manifest_digest, reading.byte_manifest.payload_sha256, len(reading.payload),
            ))
            self._pressure.extend(reading.payload)

    def evaluate(self):
        self._idle()
        c.require(self.validated_tick == self._family.plan.body.planned_ticks and self.evaluated is None)
        c.require(len(self._segments) == 3 and len(self._pressure) == 3200)
        with self._guard():
            _, response = self._execute(w.Application(f.EvaluateCommand(
                "evaluate_pressure_window", self._last_digest, fc.TARGET_DIGEST,
            )))
            result = response.body.data
            c.require(result.ancestry == self.restored.ancestry
                      and result.target == self._family.plan.evaluation
                      and result.segments == tuple(self._segments)
                      and result.window_payload_sha256 == hashlib.sha256(self._pressure).hexdigest()
                      and result.final_native_batch_sha256 == self._last_batch.engine_batch_sha256
                      and result.accepted_action_request_digest == self._accepted, "binding")
            expected = fc.pressure_rms(bytes(self._pressure))
            c.require(struct.pack("<d", result.value_pa) == struct.pack("<d", expected), "binding")
            if c.equal_bits(self.branch.target, self._family.canonical.decision.selected_target):
                c.require(result.final_cpu_state_sha256 == self._family.canonical.final_state.cpu_state_sha256, "binding")
            self.evaluated, self.evaluation_stamp = result, fc.stamp(response)
            self._acknowledge()
            # The immutable result retains every segment identity. The live raw
            # window allowance belongs only to the one active evaluation child.
            self._pressure.clear()
            self._segments.clear()
            return result

    def finish(self):
        if self._terminal is not None and self.channel_shutdown_requested:
            return self._terminal
        body = self._finish_body()
        c.require(self.evaluated is not None and self.evaluation_stamp is not None)
        with self._guard():
            _, response = self._execute(w.Finish(f.EvaluationFinish(body, self.evaluation_stamp.result_digest)))
            terminal = response.body.data
            c.require(terminal.ancestry == self.restored.ancestry
                      and terminal.family_id == self._family.plan.family_id
                      and terminal.case_id == self.branch.case_id, "binding")
            self._terminal, self.terminal_stamp = terminal, fc.stamp(response)
            self._acknowledge()
            self._family._shutdown(self.slot)
            self.channel_shutdown_requested = True
            self.close()
            return terminal


class FamilySession:
    """One frozen family on host-owned channels; process cleanup remains with that host.

    All endpoint SDK clients exist before preparation. A shutdown callback must close
    its selected real channel. Only the Rust host's EOF observation releases ancestry.
    """

    def __init__(self, plan, streams, *, deadline, close_endpoint, source_identity=None, exchanges=None):
        plan = fc.freeze_plan(plan)
        c.require(type(streams) in (tuple, list) and len(streams) == plan.limits.endpoint_count)
        c.require(all(type(pair) in (tuple, list) and len(pair) == 2 for pair in streams))
        c.require(type(deadline) in (int, float) and math.isfinite(deadline)
                  and 0 < deadline - time.monotonic() <= plan.limits.total_wall_seconds)
        c.require(callable(close_endpoint))
        if source_identity is not None:
            fc.decode("Digest", source_identity)
        if exchanges is None:
            exchanges = (None,) * len(streams)
        c.require(type(exchanges) in (tuple, list) and len(exchanges) == len(streams)
                  and all(exchange is None or callable(exchange) for exchange in exchanges))
        self.plan, self.deadline, self.source_identity = plan, deadline, source_identity
        self._shutdown = close_endpoint
        self.digest = None
        self.failed = False
        self.process_exit = None
        self.diagnostics = b""
        self.diagnostics_truncated = False
        self.canonical = CanonicalSession(self, 0, *streams[0], fc.CanonicalContract, exchanges[0])
        self.evaluations = tuple(EvaluationSession(self, slot, *streams[slot], fc.EvaluationContract, exchanges[slot])
                                 for slot in range(1, len(streams)))

    def prepare(self):
        return self.canonical.prepare()

    def reserve(self, case_id):
        canonical = self.canonical
        canonical._idle()
        c.require(canonical.selected_execution is not None and not canonical.checkpoint_released)
        c.require(canonical.validated_tick == self.plan.body.planned_ticks)
        branch = next((branch for branch in self.evaluations if not branch.channel_shutdown_requested), None)
        c.require(branch is not None and branch.branch.case_id == case_id and branch.reservation is None)
        with canonical._guard():
            _, response = canonical._execute(w.Application(f.ReserveBranchCommand(
                "reserve_branch", canonical.checkpointed.reference, case_id, canonical.selected_execution.result_digest,
            )))
            result = response.body.data
            c.require(result.family_plan_digest == self.digest
                      and result.reference.family_id == self.plan.family_id
                      and result.reference.branch_binding == branch.binding, "binding")
            branch.reservation = result.reference
            canonical._acknowledge()
            return branch

    def finish(self):
        return self.canonical.finish()

    def close(self):
        self.failed = self.failed or any(endpoint._terminal is None for endpoint in (self.canonical, *self.evaluations))
        errors = []
        for endpoint in (self.canonical, *self.evaluations):
            try:
                endpoint.close()
            except BaseException as error:
                errors.append(error)
        if errors:
            self.failed = True
            raise BaseExceptionGroup("family local endpoint retirement failed", errors)
