"""Single-step controls with the existing synthetic peer and real NCP framing."""

import io
import time
import unittest
from dataclasses import replace

from crebain_ncp_sensors import PendingBatch, SensorSession, SessionError
from crebain_ncp_sensors import types as t
from crebain_ncp_sensors.contract import SensorContract
from ncp_local import modular_wire as w
from test_client import channel

from fixtures import binding, owner, plan, target


class SessionTests(unittest.TestCase):
    def test_adaptive_steps_retain_complete_batches_until_release(self):
        host, application = owner()
        with channel(host) as stream:
            with SensorSession(
                stream, stream, binding(), plan(), deadline=time.monotonic() + 10
            ) as session:
                self.assertEqual(session.validated_ticks, 0)
                prepared = w.Request.decode(
                    session.prepare_request, binding(), SensorContract
                )
                self.assertIsInstance(prepared.command.operation, w.Prepare)
                self.assertEqual(
                    session.prepare_response.request_digest, prepared.request_digest
                )
                first = session.advance(target())
                self.assertGreater(host.usage.live_slots, 0)
                for operation in (session.advance, session.finish):
                    with self.assertRaises(ValueError):
                        operation()
                self.assertEqual(application.advances, 1)
                with first as batch:
                    self.assertIs(batch, first)
                    observed = batch.observation
                    self.assertEqual(observed.batch.body_tick, 1)
                    self.assertEqual(len(observed.readings), 1)
                    request = w.Request.decode(batch.request, binding(), SensorContract)
                    self.assertEqual(
                        batch.response.request_digest, request.request_digest
                    )
                    next_target = target(observed.batch.body_tick * 0.01)
                self.assertTrue(first.released)
                self.assertEqual(host.usage.live_slots, 0)
                first.release()  # No second protocol release.
                with session.advance(next_target) as second:
                    request = w.Request.decode(
                        second.request, binding(), SensorContract
                    )
                    self.assertEqual(
                        request.command.operation.data.action.pitch_rad, 0.01
                    )
                    accepted = second.response.body.data.accepted_action_request_digest
                    self.assertEqual(accepted, request.request_digest)
                    self.assertEqual(len(second.observation.readings), 2)
                with session.advance() as third:
                    request = w.Request.decode(third.request, binding(), SensorContract)
                    self.assertEqual(
                        request.command.operation.data.action, t.Hold("hold", accepted)
                    )
                result = session.finish()
                self.assertIs(session.finish(), result)
                self.assertEqual(result.terminal.completed_ticks, 3)
                self.assertEqual(result.payload_count, 5)
                with self.assertRaises(ValueError):
                    session.advance()
        self.assertEqual(application.advances, 3)
        self.assertTrue(application.finished)

    def test_invalid_local_actions_and_early_finish_leave_session_usable(self):
        host, application = owner()
        with channel(host) as stream:
            with SensorSession(
                stream, stream, binding(), plan(1), deadline=time.monotonic() + 10
            ) as session:
                for action in (None, object(), replace(target(), altitude_m=9.0)):
                    with self.assertRaises(ValueError):
                        session.advance(action)
                    self.assertEqual(application.advances, 0)
                with self.assertRaises(ValueError):
                    session.finish()
                with session.advance(target()):
                    pass
                self.assertEqual(session.finish().terminal.completed_ticks, 1)

    def test_capture_context_failure_preserves_live_buffers_and_retires_client(self):
        host, application = owner()
        releases = []

        def observe(request, response):
            operation = w.Request.decode(request, binding(), SensorContract).command
            if type(operation) is w.Execute and type(operation.operation) is w.Release:
                releases.append(operation)
            return response

        with channel(host, observe) as stream:
            session = SensorSession(
                stream, stream, binding(), plan(), deadline=time.monotonic() + 10
            )
            with session, self.assertRaisesRegex(OSError, "selected capture failure"):
                with session.advance(target()) as pending:
                    self.assertEqual(session.validated_ticks, 1)
                    raise OSError("selected capture failure")
            self.assertFalse(pending.released)
            self.assertEqual(releases, [])
            self.assertGreater(host.usage.live_slots, 0)
            with self.assertRaises(ValueError):
                session.advance()
            with self.assertRaises(ValueError):
                pending.release()
        self.assertEqual(application.advances, 1)
        self.assertFalse(application.finished)

    def test_early_context_failure_does_not_advance_or_finish(self):
        host, application = owner()
        with channel(host) as stream:
            with self.assertRaisesRegex(OSError, "selected host failure"):
                with SensorSession(
                    stream, stream, binding(), plan(), deadline=time.monotonic() + 10
                ):
                    raise OSError("selected host failure")
        self.assertEqual(application.advances, 0)
        self.assertEqual(host.usage.live_slots, 0)
        self.assertFalse(application.finished)

    def test_copied_handle_cannot_release_original_buffers(self):
        host, application = owner()
        with channel(host) as stream:
            with SensorSession(
                stream, stream, binding(), plan(1), deadline=time.monotonic() + 10
            ) as session:
                original = session.advance(target())
                copied = PendingBatch(
                    session, original.request, original.response, original.observation
                )
                with self.assertRaises(ValueError):
                    copied.release()
                self.assertGreater(host.usage.live_slots, 0)
                with original:
                    with self.assertRaises(ValueError):
                        original.__enter__()
                self.assertEqual(host.usage.live_slots, 0)
                self.assertEqual(session.finish().terminal.completed_ticks, 1)
        self.assertEqual(application.advances, 1)

    def test_closed_or_unprepared_session_never_writes(self):
        output = io.BytesIO()
        session = SensorSession(
            io.BytesIO(), output, binding(), plan(), deadline=time.monotonic() + 10
        )
        for operation in (lambda: session.advance(target()), session.finish):
            with self.assertRaises(ValueError):
                operation()
        session.close()
        with self.assertRaises(ValueError):
            session.prepare()
        self.assertEqual(output.getvalue(), b"")

    def test_manual_steps_do_not_invent_a_recorded_prefix(self):
        host, application = owner()
        application.fail_tick = 2
        with channel(host) as stream:
            with SensorSession(
                stream, stream, binding(), plan(), deadline=time.monotonic() + 10
            ) as session:
                with session.advance(target()):
                    pass
                with self.assertRaises(SessionError) as stopped:
                    session.advance()
                self.assertEqual(stopped.exception.last_validated_tick, 1)
                self.assertEqual(stopped.exception.last_recorded_tick, 0)
                self.assertEqual(stopped.exception.attempted_tick, 2)
                self.assertFalse(stopped.exception.advance_result_observed)
        self.assertEqual(application.advances, 2)
        self.assertFalse(application.finished)
