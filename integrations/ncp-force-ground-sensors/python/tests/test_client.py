from contextlib import contextmanager
from dataclasses import replace
import base64
import hashlib
import io
import socket
import threading
import time
import unittest

from ncp_local import modular_wire as w, wire as framing
from ncp_local.modular_client import Client

from crebain_ncp_sensors import SessionError, run_session
from crebain_ncp_sensors import codec as c, types as t
from crebain_ncp_sensors.contract import SensorContract
from fixtures import binding, owner, plan, target


@contextmanager
def channel(host, hook=None):
    """Owned socket pair with one bounded synthetic SDK peer thread."""
    first, second = socket.socketpair()
    client_stream = first.makefile("rwb", buffering=0)
    peer_stream = second.makefile("rwb", buffering=0)
    errors = []

    def serve():
        try:
            deadline = time.monotonic() + 60
            while True:
                payload = framing.read_local_frame(peer_stream, deadline=deadline)
                if payload is None:
                    return
                response = bytes(host.process(payload))
                if hook:
                    response = hook(payload, response)
                if response is None:
                    # Deliberate complete channel loss after owned processing.
                    return
                framing.write_local_frame(peer_stream, response, deadline=deadline)
        except (BrokenPipeError, ConnectionResetError):
            pass  # The reading client may retire after a malformed response.
        except BaseException as error:
            errors.append(error)
        finally:
            peer_stream.close()
            second.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield client_stream
    finally:
        client_stream.close()
        first.close()
        thread.join(5)
        if thread.is_alive():
            raise AssertionError("owned synthetic peer did not terminate")
        if errors:
            raise errors[0]


class ClientTests(unittest.TestCase):
    def test_24_tick_synthetic_transport_roster_and_releases(self):
        host, application = owner()
        observed = []

        def record(observation):
            self.assertEqual(host.usage.live_slots, 0)
            self.assertEqual(host.usage.reserved_bytes, 0)
            self.assertIsInstance(observation, t.BatchObservation)
            observed.append((observation.batch.body_tick, tuple((reading.manifest.tensor.kind, len(reading.payload)) for reading in observation.readings)))

        with channel(host) as stream:
            result = run_session(stream, stream, binding(), plan(24, small=False),
                                 ((1, target()), (13, target(0.03))), record,
                                 deadline=time.monotonic() + 60)
        self.assertEqual(application.advances, 24)
        self.assertTrue(application.finished)
        self.assertEqual(result.raw_bytes, 4_326_400)
        self.assertEqual(result.payload_count, 44)
        self.assertEqual([tick for tick, _ in observed], list(range(1, 25)))
        totals = {kind: sum(length for _, entries in observed for name, length in entries if name == kind)
                  for kind in ("rgba8", "radiance", "pressure")}
        self.assertEqual(totals, {"rgba8": 3_686_400, "radiance": 614_400, "pressure": 25_600})
        self.assertEqual(result.terminal.completed_ticks, 24)
        self.assertFalse(result.terminal.scientific_validation)

    def test_exact_healthy_replay_ack_does_not_release_and_explicit_release(self):
        host, application = owner()
        client = Client(binding(), SensorContract)
        response = client.observe(host.process(client.begin(w.Prepare(plan(2)))))
        client.observe_acknowledgement(host.process(client.acknowledgement()))
        command = t.Command("advance_tick", 1, None, target(), t.CaptureReservation())
        exact_request = client.begin(w.Application(command))
        first = bytes(host.process(exact_request))
        advanced = client.observe(first).body.data
        self.assertEqual(bytes(host.process(exact_request)), first)
        self.assertEqual(client.observe(first).body.data, advanced)
        self.assertEqual(application.advances, 1)
        before = host.usage
        client.observe_acknowledgement(host.process(client.acknowledgement()))
        self.assertEqual(host.usage, before)
        manifest = advanced.batch.slots[2].byte_manifest
        read = client.observe(host.process(client.begin(w.Read(manifest.reference(), manifest.manifest_digest, 0))))
        self.assertEqual(len(read.body.data.decoded()), manifest.byte_length)
        client.observe_acknowledgement(host.process(client.acknowledgement()))
        next_command = t.Command("advance_tick", 2, advanced.batch.batch_digest,
                                 t.Hold("hold", advanced.accepted_action_request_digest), t.CaptureReservation())
        rejected = client.observe(host.process(client.begin(w.Application(next_command))))
        self.assertEqual(rejected.outcome, w.Outcome.REJECTED)
        self.assertEqual(application.advances, 1)
        client.observe(host.process(client.begin(w.Release(manifest.reference()))))
        client.observe_acknowledgement(host.process(client.acknowledgement()))
        unavailable = client.observe(host.process(client.begin(w.Read(manifest.reference(), manifest.manifest_digest, 0))))
        self.assertEqual(unavailable.code, w.Code.BUFFER_UNAVAILABLE)
        resumed = client.observe(host.process(client.begin(w.Application(next_command))))
        self.assertEqual(resumed.outcome, w.Outcome.COMMITTED)
        self.assertEqual(application.advances, 2)

    def test_all_schedule_preflight_finishes_before_any_write(self):
        for actions in ((), ((2, target()),), ((1, target()), (1, target())),
                        ((True, target()),), ((1, target()), (4, target())),
                        ((1, target()), (2, replace(target(), altitude_m=9.0)))):
            output = io.BytesIO()
            with self.assertRaises(ValueError):
                run_session(io.BytesIO(), output, binding(), plan(), actions, lambda _: None, deadline=time.monotonic() + 5)
            self.assertEqual(output.getvalue(), b"")

    def test_finite_but_corrupted_payload_with_fresh_chunk_hash_fails_full_hash(self):
        host, application = owner()
        recorded = []

        def corrupt(request, response):
            original = w.Request.decode(request, binding(), SensorContract)
            if type(original.command) is w.Execute and type(original.command.operation) is w.Read:
                decoded = w.Response.decode(response, binding(), SensorContract)
                chunk = decoded.body.data
                data = bytes([1]) + chunk.decoded()[1:]
                changed = replace(chunk, data_base64=base64.b64encode(data).decode(), chunk_sha256=hashlib.sha256(data).hexdigest())
                return replace(decoded, body=w.Body(w.BodyKind.CHUNK, changed)).encode()
            return response

        with channel(host, corrupt) as stream, self.assertRaises(SessionError) as failure:
            run_session(stream, stream, binding(), plan(), ((1, target()),), recorded.append, deadline=time.monotonic() + 10)
        self.assertEqual(recorded, [])
        self.assertEqual(failure.exception.stage, "read")
        self.assertEqual(failure.exception.last_validated_tick, 0)
        self.assertTrue(failure.exception.advance_result_observed)
        self.assertEqual(application.advances, 1)
        self.assertFalse(application.finished)

    def test_bad_second_modality_exposes_no_partial_batch(self):
        host, application = owner()
        records = []

        def corrupt(request, response):
            original = w.Request.decode(request, binding(), SensorContract)
            if application.tick == 2 and type(original.command) is w.Execute and type(original.command.operation) is w.Read:
                decoded = w.Response.decode(response, binding(), SensorContract)
                # Tick 2 has RGB then pressure. Pressure's complete chunk is 1064 bytes.
                if decoded.body.data.decoded_length == 1064:
                    changed = replace(decoded.body.data, manifest_digest="f" * 64)
                    return replace(decoded, body=w.Body(w.BodyKind.CHUNK, changed)).encode()
            return response

        with channel(host, corrupt) as stream, self.assertRaises(SessionError) as failure:
            run_session(stream, stream, binding(), plan(), ((1, target()),), lambda result: records.append(result.batch.body_tick), deadline=time.monotonic() + 10)
        self.assertEqual(records, [1])
        self.assertEqual(failure.exception.last_validated_tick, 1)
        self.assertEqual(failure.exception.attempted_tick, 2)
        self.assertEqual(application.advances, 2)

    def test_unknown_advance_keeps_last_complete_prefix_and_never_retries(self):
        host, application = owner()
        application.fail_tick = 2
        records = []
        with channel(host) as stream, self.assertRaises(SessionError) as failure:
            run_session(stream, stream, binding(), plan(), ((1, target()),), lambda result: records.append(result.batch.body_tick), deadline=time.monotonic() + 10)
        self.assertEqual(records, [1])
        self.assertEqual(application.advances, 2)
        self.assertEqual(failure.exception.last_validated_tick, 1)
        self.assertEqual(failure.exception.last_recorded_tick, 1)
        self.assertEqual(failure.exception.attempted_tick, 2)
        self.assertFalse(failure.exception.advance_result_observed)
        self.assertFalse(failure.exception.engine_retirement_confirmed)

    def test_lost_response_after_execution_is_unknown_without_retry(self):
        host, application = owner()

        def lose(request, response):
            original = w.Request.decode(request, binding(), SensorContract)
            if type(original.command) is w.Execute and type(original.command.operation) is w.Application:
                return None
            return response

        with channel(host, lose) as stream, self.assertRaises(SessionError) as failure:
            run_session(stream, stream, binding(), plan(), ((1, target()),), lambda _: None, deadline=time.monotonic() + 10)
        self.assertEqual(application.advances, 1)
        self.assertEqual(failure.exception.last_validated_tick, 0)
        self.assertFalse(failure.exception.advance_result_observed)
        self.assertFalse(application.finished)

    def test_callback_failure_after_release_does_not_claim_recorded_or_finished(self):
        host, application = owner()

        def fail(_):
            self.assertEqual(host.usage.live_slots, 0)
            raise OSError("synthetic local recorder failure")

        with channel(host) as stream, self.assertRaises(SessionError) as failure:
            run_session(stream, stream, binding(), plan(), ((1, target()),), fail, deadline=time.monotonic() + 10)
        self.assertEqual(failure.exception.stage, "record")
        self.assertEqual(failure.exception.last_validated_tick, 1)
        self.assertEqual(failure.exception.last_recorded_tick, 0)
        self.assertFalse(application.finished)

    def test_terminal_claim_drift_fails_after_complete_reading(self):
        host, application = owner()
        records = []

        def drift(request, response):
            original = w.Request.decode(request, binding(), SensorContract)
            if type(original.command) is w.Execute and type(original.command.operation) is w.Finish:
                decoded = w.Response.decode(response, binding(), SensorContract)
                changed = replace(decoded.body.data, scientific_validation=True)
                return replace(decoded, body=w.Body(w.BodyKind.FINISHED, changed)).encode()
            return response

        with channel(host, drift) as stream, self.assertRaises(SessionError) as failure:
            run_session(stream, stream, binding(), plan(1), ((1, target()),), records.append, deadline=time.monotonic() + 10)
        self.assertEqual(len(records), 1)
        self.assertEqual(failure.exception.last_validated_tick, 1)
        self.assertEqual(failure.exception.stage, "finish")
        self.assertFalse(failure.exception.engine_retirement_confirmed)
        self.assertTrue(application.finished)  # Peer truth cannot substitute for an accepted terminal response.

    def test_lost_terminal_ack_retains_observed_retirement_without_success(self):
        host, application = owner()

        def lose(request, response):
            original = w.Request.decode(request, binding(), SensorContract)
            return None if application.finished and type(original.command) is w.Ack else response

        with channel(host, lose) as stream, self.assertRaises(SessionError) as failure:
            run_session(stream, stream, binding(), plan(1), ((1, target()),), lambda _: None, deadline=time.monotonic() + 10)
        self.assertEqual(failure.exception.stage, "finish")
        self.assertEqual(failure.exception.last_recorded_tick, 1)
        self.assertTrue(failure.exception.engine_retirement_confirmed)
        self.assertIsNone(failure.exception.attempted_tick)


if __name__ == "__main__":
    unittest.main()
