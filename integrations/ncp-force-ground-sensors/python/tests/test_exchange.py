"""Optional host transport controls; these peers produce synthetic sensor bytes."""

import hashlib
import io
import time
import unittest

from ncp_local import modular_wire as w, wire as framing

from crebain_ncp_sensors import SensorContract, SensorSession, SessionError, run_session
from crebain_ncp_sensors import types as t
from fixtures import binding, owner, plan, target
from test_client import channel


class ExchangeTests(unittest.TestCase):
    def setUp(self):
        self.host, self.application = owner()
        self.deadline = time.monotonic() + 30
        self.frames = []

    def exchange(self, request, reader, writer, *, deadline):
        self.assertIs(reader, writer)
        self.assertEqual(deadline, self.deadline)
        framing.write_local_frame(writer, request, deadline=deadline)
        response = framing.read_local_frame(reader, deadline=deadline)
        self.assertIsNotNone(response)
        self.frames.append((request, response))
        return response

    def session(self, stream, exchange, ticks=1):
        return SensorSession(
            stream,
            stream,
            binding(),
            plan(ticks),
            deadline=self.deadline,
            exchange=exchange,
        )

    def requests(self):
        return [
            w.Request.decode(raw, binding(), SensorContract) for raw, _ in self.frames
        ]

    def test_every_due_payload_is_captured_before_first_batch_release(self):
        due, chunks, released = [], {}, []

        def capture(request, reader, writer, *, deadline):
            nonlocal due
            original = w.Request.decode(request, binding(), SensorContract)
            operation = (
                original.command.operation
                if type(original.command) is w.Execute
                else None
            )
            if type(operation) is w.Release:
                self.assertGreater(self.host.usage.live_slots, 0)
                # Every modality must already be complete before any batch release.
                for manifest in due:
                    payload = b"".join(chunks[manifest.manifest_digest])
                    self.assertEqual(len(payload), manifest.byte_length)
                    self.assertEqual(
                        hashlib.sha256(payload).hexdigest(), manifest.payload_sha256
                    )
                released.append(operation.reference)
            response = self.exchange(request, reader, writer, deadline=deadline)
            observed = w.Response.decode(response, binding(), SensorContract)
            self.assertEqual(original.request_digest, observed.request_digest)
            if type(operation) is w.Application:
                due = [
                    slot.byte_manifest
                    for slot in observed.body.data.batch.slots
                    if type(slot) is t.Due
                ]
                chunks.clear()
            if type(operation) is w.Read:
                chunk = observed.body.data
                chunks.setdefault(chunk.manifest_digest, []).append(chunk.decoded())
            return response

        with channel(self.host) as stream, self.session(stream, capture, 6) as session:
            for tick in range(1, 7):
                with session.advance(target() if tick == 1 else None) as batch:
                    self.assertEqual(batch.observation.batch.body_tick, tick)
                    self.assertGreater(self.host.usage.live_slots, 0)
                self.assertEqual(self.host.usage.live_slots, 0)
            result = session.finish()
        self.assertEqual(len(released), result.payload_count)
        self.assertEqual(self.application.advances, 6)
        self.assertTrue(self.application.finished)
        operations = [
            w.Response.decode(raw, binding(), SensorContract).operation
            for _, raw in self.frames
        ]
        self.assertEqual(operations[:2], [w.Name.PREPARE, w.Name.ACK])
        self.assertEqual(operations[-2:], [w.Name.FINISH, w.Name.ACK])
        self.assertTrue(all(name is w.Name.ACK for name in operations[1::2]))
        self.assertEqual(len(operations), 2 * (6 + 2 + 2 * result.payload_count))

    def test_noncallable_hook_is_rejected_before_io(self):
        for invalid in (False, 0, "capture", object()):
            stream = io.BytesIO()
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                self.session(stream, invalid)
            self.assertEqual(stream.getvalue(), b"")
        self.assertEqual(self.application.advances, 0)

    def test_capture_failure_before_dispatch_does_not_advance_or_retry(self):
        marker = OSError("request storage failed")
        attempted = []

        def fail(request, reader, writer, *, deadline):
            original = w.Request.decode(request, binding(), SensorContract)
            if (
                type(original.command) is w.Execute
                and type(original.command.operation) is w.Application
            ):
                attempted.append(request)
                raise marker
            return self.exchange(request, reader, writer, deadline=deadline)

        with channel(self.host) as stream, self.session(stream, fail) as session:
            with self.assertRaises(SessionError) as caught:
                session.advance(target())
            with self.assertRaises(ValueError):
                session.advance(target())
        self.assertIs(caught.exception.__cause__, marker)
        self.assertEqual(len(attempted), 1)
        self.assertEqual(len(self.frames), 2)
        self.assertEqual(self.application.advances, 0)
        self.assertEqual(caught.exception.last_validated_tick, 0)
        self.assertFalse(caught.exception.advance_result_observed)

    def test_failed_response_capture_keeps_executed_tick_unknown_without_ack(self):
        self.check_response_failure(w.Application, "advance", False)

    def test_failed_chunk_capture_keeps_buffers_live_without_partial_batch(self):
        self.check_response_failure(w.Read, "read", True)

    def check_response_failure(self, operation_type, stage, advance_observed):
        marker = OSError("response storage failed")

        def fail(request, reader, writer, *, deadline):
            response = self.exchange(request, reader, writer, deadline=deadline)
            original = w.Request.decode(request, binding(), SensorContract)
            if (
                type(original.command) is w.Execute
                and type(original.command.operation) is operation_type
            ):
                raise marker
            return response

        with channel(self.host) as stream, self.session(stream, fail) as session:
            with self.assertRaises(SessionError) as caught:
                session.advance(target())
            with self.assertRaises(ValueError):
                session.advance(target())
        error = caught.exception
        self.assertIs(error.__cause__, marker)
        self.assertEqual(error.stage, stage)
        self.assertEqual(error.last_validated_tick, 0)
        self.assertEqual(error.last_recorded_tick, 0)
        self.assertEqual(error.attempted_tick, 1)
        self.assertEqual(error.advance_result_observed, advance_observed)
        self.assertEqual(self.application.advances, 1)
        self.assertGreater(self.host.usage.live_slots, 0)
        self.assertFalse(self.application.finished)
        self.assertIs(type(self.requests()[-1].command.operation), operation_type)

    def test_malformed_hook_reply_is_rejected_before_ack(self):
        def malformed(request, reader, writer, *, deadline):
            self.exchange(request, reader, writer, deadline=deadline)
            return b"{}"

        with channel(self.host) as stream:
            session = self.session(stream, malformed)
            with self.assertRaises(SessionError):
                session.prepare()
            with self.assertRaises(ValueError):
                session.prepare()
        self.assertEqual(len(self.frames), 1)
        self.assertEqual(self.application.advances, 0)
        self.assertFalse(self.application.finished)

    def test_unavailable_terminal_ack_does_not_return_success(self):
        def refuse(request, response):
            original = w.Request.decode(request, binding(), SensorContract)
            if self.application.finished and type(original.command) is w.Ack:
                return w.Response(
                    binding(),
                    original.sequence,
                    w.Name.ACK,
                    original.request_digest,
                    w.Outcome.UNAVAILABLE,
                    w.Code.NO_RESULT,
                    w.Body(w.BodyKind.UNAVAILABLE),
                ).encode()
            return response

        with channel(self.host, refuse) as stream:
            with self.session(stream, self.exchange) as session:
                with session.advance(target()):
                    pass
                with self.assertRaises(SessionError) as caught:
                    session.finish()
                with self.assertRaises(ValueError):
                    session.finish()
        self.assertEqual(caught.exception.stage, "finish")
        self.assertEqual(caught.exception.last_validated_tick, 1)
        self.assertTrue(caught.exception.engine_retirement_confirmed)
        self.assertTrue(self.application.finished)

    def test_scheduled_helper_forwards_hook_and_records_after_release(self):
        recorded = []

        def record(observation):
            self.assertEqual(self.host.usage.live_slots, 0)
            self.assertEqual(self.requests()[-1].command.__class__, w.Ack)
            recorded.append(observation.batch.body_tick)

        with channel(self.host) as stream:
            result = run_session(
                stream,
                stream,
                binding(),
                plan(2),
                ((1, target()),),
                record,
                deadline=self.deadline,
                exchange=self.exchange,
            )
        self.assertEqual(recorded, [1, 2])
        self.assertEqual(result.terminal.completed_ticks, 2)
        self.assertTrue(self.application.finished)

    def test_capture_failure_never_calls_scheduled_recorder(self):
        recorded = []

        def fail(request, reader, writer, *, deadline):
            response = self.exchange(request, reader, writer, deadline=deadline)
            original = w.Request.decode(request, binding(), SensorContract)
            if (
                type(original.command) is w.Execute
                and type(original.command.operation) is w.Read
            ):
                raise OSError("response storage failed")
            return response

        with channel(self.host) as stream, self.assertRaises(SessionError) as caught:
            run_session(
                stream,
                stream,
                binding(),
                plan(1),
                ((1, target()),),
                recorded.append,
                deadline=self.deadline,
                exchange=fail,
            )
        self.assertEqual(recorded, [])
        self.assertEqual(caught.exception.last_recorded_tick, 0)
        self.assertGreater(self.host.usage.live_slots, 0)
        self.assertFalse(self.application.finished)


if __name__ == "__main__":
    unittest.main()
