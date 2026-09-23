"""Actual SDK/socket/Bun controls with an explicitly synthetic native fixture."""

from contextlib import contextmanager
from dataclasses import replace
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

from ncp_local import modular_wire as w, wire as framing

from crebain_ncp_sensors import codec as c, family_contract as fc, family_types as f, types as t
from crebain_ncp_sensors.family import FamilySession


APP = Path(__file__).resolve().parents[2]


def plan(branches=2, seconds=30):
    workload = json.loads((APP / "contracts/m1.workload.v1.json").read_bytes())
    raw = workload["specification"]
    raw["scene"]["thermalCameras"] = []
    for camera in raw["scene"]["rgbCameras"]:
        camera.update(width=8, height=8, periodTicks=3)
    body = c.decode("Prepare", {"specification": raw, "planned_ticks": 6, "composition_digest": fc.COMPOSITION_DIGEST})
    target = t.SetTarget("set_target", True, 0.0, 0.0, 0.0, 8.0)
    return f.FamilyPlan(
        str(uuid.uuid4()), fc.new_binding(), body, 3,
        tuple(f.BranchPlan(slot, f"case-{slot}", "label" if slot == 1 else "same_action_control", fc.new_binding(), target)
              for slot in range(1, branches + 1)),
        f.PressureWindow("scaled_compensated_pressure_rms400_v1", "pressure:mic-a", 4, 6, 400, "pascal", fc.TARGET_DIGEST),
        f.FamilyLimits(seconds, branches + 1, 2, 1, 1, 3200),
    )


class FamilyContractTests(unittest.TestCase):
    def test_session_rebuilds_immutable_input_and_rejects_mutable_containers_before_io(self):
        selected = plan()
        expected = fc.freeze_plan(selected)
        streams = [(io.BytesIO(), io.BytesIO()) for _ in range(3)]
        session = FamilySession(selected, streams, deadline=time.monotonic() + 10,
                                close_endpoint=lambda slot: None)
        self.assertIsNot(session.plan, selected)
        self.assertIsNot(session.plan.branches[0], selected.branches[0])
        # Deliberately bypass the host DTO's frozen guard after construction.
        # This tests retained references, not hostile in-process containment.
        object.__setattr__(selected, "branches", ())
        self.assertEqual(session.plan, expected)
        self.assertEqual(type(session.plan.branches), tuple)
        self.assertTrue(all(writer.getvalue() == b"" for _, writer in streams))
        session.close()
        streams = [(io.BytesIO(), io.BytesIO()) for _ in range(3)]
        with self.assertRaises(w.ModularError):
            FamilySession(replace(expected, branches=list(expected.branches)), streams,
                          deadline=time.monotonic() + 10, close_endpoint=lambda slot: None)
        self.assertTrue(all(writer.getvalue() == b"" for _, writer in streams))

    def test_exact_constructor_and_fifteen_branch_cap_have_paired_rejections(self):
        selected = plan(15)
        fc.validate_plan(selected)
        self.assertEqual(fc.decode("FamilyPlan", c.raw(selected)), selected)
        for changed in (
            replace(selected, branches=(*selected.branches, selected.branches[-1])),
            replace(selected, canonical_binding=selected.branches[0].binding),
            replace(selected, evaluation=replace(selected.evaluation, sensor_id="rgb:mic-a")),
            replace(selected, evaluation=replace(selected.evaluation, sensor_id="pressure:missing")),
            replace(selected, evaluation=replace(selected.evaluation, first_tick=3)),
            replace(selected, limits=replace(selected.limits, endpoint_count=17)),
            replace(selected, body=replace(selected.body, composition_digest=c.COMPOSITION_DIGEST)),
        ):
            with self.subTest(changed=changed), self.assertRaises((w.ModularError, ValueError)):
                fc.validate_plan(changed)

    def test_exact_role_schema_rejects_extra_fields_wrong_purpose_and_uninhabited_import(self):
        selected = plan()
        raw = c.raw(selected)
        raw["unexpected"] = False
        with self.assertRaises(w.ModularError):
            fc.decode("FamilyPlan", raw)
        raw = c.raw(selected)
        raw["branches"][0]["purpose"] = "restored_authority_from_json"
        with self.assertRaises(w.ModularError):
            fc.decode("FamilyPlan", raw)
        with self.assertRaises(w.ModularError):
            fc.CanonicalContract.decode_import({})
        command = f.CheckpointCommand("checkpoint", 3, "a" * 64)
        fc.CanonicalContract.check_input(w.Application(command))
        with self.assertRaises(w.ModularError):
            fc.EvaluationContract.check_input(w.Application(command))

    def test_owner_target_vectors_preserve_all_original_bits_and_reject_nonfinite_or_wrong_extent(self):
        ordinary = Path(os.environ.get("CREBAIN_SENSOR_BRIDGE", APP / "bridge/main.ts"))
        vectors = json.loads(ordinary.with_name("pressure-window.vectors.v1.json").read_bytes())
        for row in vectors["vectors"]:
            payload = bytes.fromhex(row["payload_le_f64_hex"])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), row["payload_sha256"])
            self.assertEqual(struct.pack("<d", fc.pressure_rms(payload)).hex(), row["rms_le_f64_hex"])
        for payload in (b"", b"\0" * 3192, struct.pack("<d", float("nan")) * 400,
                        struct.pack("<d", float("inf")) * 400):
            with self.assertRaises(w.ModularError):
                fc.pressure_rms(payload)
        self.assertEqual(struct.pack("<d", fc.pressure_rms(struct.pack("<d", -0.0) * 400)), b"\0" * 8)


@unittest.skipUnless(os.environ.get("CREBAIN_FAMILY_PRODUCER"), "explicit constructed family binary required")
class FamilySocketTests(unittest.TestCase):
    @contextmanager
    def launch(self, selected, *, exchanges=None, defer_shutdown=None, expected_exit=0):
        channels = [socket.socketpair() for _ in range(selected.limits.endpoint_count)]
        streams = [(host.makefile("rb", buffering=0), host.makefile("wb", buffering=0)) for host, _ in channels]
        ordinary = Path(os.environ["CREBAIN_SENSOR_BRIDGE"])
        command = [os.environ["CREBAIN_FAMILY_PRODUCER"], "--bun", os.environ["CREBAIN_SENSOR_BUN"],
                   "--node", os.environ["CREBAIN_SENSOR_NODE"], "--bridge", str(ordinary.with_name("family-process.test-support.ts")),
                   "--source-identity", "a" * 64, "--family-plan-json", json.dumps(c.raw(selected), separators=(",", ":")),
                   "--service-fds-json", json.dumps([service.fileno() for _, service in channels])]
        child = None
        failed = False
        with tempfile.TemporaryFile() as diagnostics:
            try:
                child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=diagnostics,
                                         pass_fds=tuple(service.fileno() for _, service in channels), close_fds=True)
                for _, service in channels:
                    service.close()

                def close_endpoint(slot):
                    if defer_shutdown is not None and slot == 1:
                        defer_shutdown.append(channels[slot][0])
                    else:
                        channels[slot][0].shutdown(socket.SHUT_RDWR)

                session = FamilySession(selected, streams, deadline=time.monotonic() + selected.limits.total_wall_seconds,
                                        close_endpoint=close_endpoint, source_identity="a" * 64, exchanges=exchanges)
                yield session
            except BaseException:
                failed = True
                raise
            finally:
                for host, service in channels:
                    try:
                        host.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    host.close()
                    service.close()
                for pair in streams:
                    for stream in pair:
                        stream.close()
                if child is not None:
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()  # Only this test's direct, unreaped child.
                        child.wait(timeout=3)
                        if not failed:
                            self.fail("synthetic family child did not retire")
                    if not failed:
                        diagnostics.seek(0)
                        self.last_diagnostics = diagnostics.read(131072).decode(errors="replace")
                        self.assertEqual(child.returncode, expected_exit, self.last_diagnostics)
                    else:
                        diagnostics.seek(0)
                        print(diagnostics.read(65536).decode(errors="replace"), file=sys.stderr)

    def select_parent(self, session):
        session.prepare()
        canonical = session.canonical
        target = session.plan.branches[0].target
        for tick in range(1, 4):
            with canonical.advance(target if tick == 1 else None):
                pass
        checkpoint = canonical.checkpoint()
        canonical.commit_decision("f" * 64, "case-1")
        for tick in range(4, 7):
            with canonical.advance(target if tick == 4 else None):
                pass
        return checkpoint

    def evaluate_branch(self, session, case_id):
        branch = session.reserve(case_id)
        branch.prepare()
        for tick in range(4, 7):
            with branch.advance(branch.branch.target if tick == 4 else None):
                pass
        branch.evaluate()
        self.assertEqual(len(branch._pressure), 0)
        self.assertEqual(branch._segments, [])
        return branch

    @staticmethod
    def exchange(request, reader, writer, *, deadline):
        framing.write_local_frame(writer, request, deadline=deadline)
        response = framing.read_local_frame(reader, deadline=deadline)
        if response is None:
            raise EOFError("selected family endpoint closed")
        return response

    def test_actual_multichannel_family_reads_two_siblings_and_closes_parent_last(self):
        selected = plan()
        with self.launch(selected) as session:
            session.prepare()
            canonical = session.canonical
            for tick in range(1, 4):
                with canonical.advance(selected.branches[0].target if tick == 1 else None) as batch:
                    self.assertEqual(batch.observation.batch.body_tick, tick)
            checkpoint = canonical.checkpoint()
            canonical.commit_decision("f" * 64, "case-1")
            for tick in range(4, 7):
                with canonical.advance(selected.branches[0].target if tick == 4 else None):
                    pass
            windows = []
            for specification in selected.branches:
                branch = session.reserve(specification.case_id)
                restored = branch.prepare()
                self.assertEqual(restored.cpu_state_sha256, checkpoint.cpu_state_sha256)
                self.assertEqual(restored.initial_observation, "inherited_checkpoint")
                self.assertFalse(hasattr(branch._prepared, "initial_observation"))
                for tick in range(4, 7):
                    with branch.advance(specification.target if tick == 4 else None):
                        pass
                evaluation = branch.evaluate()
                windows.append(evaluation.window_payload_sha256)
                terminal = branch.finish()
                self.assertEqual(terminal.shared_family_process_retirement, "pending")
                self.assertTrue(branch.channel_shutdown_requested)
            self.assertEqual(windows[0], windows[1])
            canonical.release_checkpoint()
            terminal = session.finish()
            self.assertEqual(terminal.sdk_host_process_retirement, "pending")
            self.assertEqual(terminal.bun_process_retirement, "confirmed")

    def test_sixteen_actual_owners_complete_fifteen_serial_siblings(self):
        selected = plan(15)
        with self.launch(selected) as session:
            self.select_parent(session)
            identities = set()
            for specification in selected.branches:
                branch = self.evaluate_branch(session, specification.case_id)
                identities.add((branch.binding.run_id, branch.restored.ancestry.native_owner_id,
                                branch.restored.ancestry.graphics_generation))
                branch.finish()
            self.assertEqual(len(identities), 15)
            session.canonical.release_checkpoint()
            session.finish()
        rows = [json.loads(line.split(" ", 1)[1]) for line in self.last_diagnostics.splitlines()
                if line.startswith("CREBAIN_FAMILY_ENDPOINT_V1 ")]
        self.assertEqual(len(rows), 16)
        self.assertTrue(all(row["terminal_ack_sent"] and row["channel_closed"] for row in rows))

    def test_terminal_ack_replays_use_actual_sdk_before_real_eof(self):
        selected = plan(1)
        replayed = []
        terminal = False

        def exchange(request, reader, writer, *, deadline):
            nonlocal terminal
            decoded = w.Request.decode(request, selected.branches[0].binding, fc.EvaluationContract)
            response = self.exchange(request, reader, writer, deadline=deadline)
            if type(decoded.command) is w.Execute and type(decoded.command.operation) is w.Finish:
                terminal = True
            elif terminal and type(decoded.command) is w.Ack:
                for _ in range(2):
                    repeated = self.exchange(request, reader, writer, deadline=deadline)
                    self.assertEqual(response, repeated)
                    replayed.append(repeated)
            return response

        with self.launch(selected, exchanges=(None, exchange)) as session:
            self.select_parent(session)
            branch = self.evaluate_branch(session, "case-1")
            branch.finish()
            self.assertEqual(len(replayed), 2)
            session.canonical.release_checkpoint()
            session.finish()

    def test_lost_terminal_ack_preserves_observed_commit_and_never_asserts_client_closure(self):
        for after_send in (False, True):
            with self.subTest(after_send=after_send):
                selected = plan(1)
                terminal = False
                original = OSError("injected lost terminal acknowledgement")

                def exchange(request, reader, writer, *, deadline):
                    nonlocal terminal
                    decoded = w.Request.decode(request, selected.branches[0].binding, fc.EvaluationContract)
                    if terminal and type(decoded.command) is w.Ack:
                        if after_send:
                            self.exchange(request, reader, writer, deadline=deadline)
                        raise original
                    response = self.exchange(request, reader, writer, deadline=deadline)
                    if type(decoded.command) is w.Execute and type(decoded.command.operation) is w.Finish:
                        terminal = True
                    return response

                with self.launch(selected, exchanges=(None, exchange), expected_exit=1) as session:
                    self.select_parent(session)
                    branch = self.evaluate_branch(session, "case-1")
                    with self.assertRaises(OSError) as raised:
                        branch.finish()
                    self.assertIs(raised.exception, original)
                    self.assertIs(branch.last_committed.body.data, branch.terminal)
                    self.assertNotEqual(branch.last_acknowledged, branch.last_committed)
                    self.assertFalse(branch.channel_shutdown_requested)
                    self.assertTrue(session.failed)

    def test_queued_parent_frame_waits_for_real_branch_eof(self):
        selected = plan(2)
        deferred = []
        errors = []
        with self.launch(selected, defer_shutdown=deferred) as session:
            self.select_parent(session)
            self.evaluate_branch(session, "case-1").finish()
            self.assertEqual(len(deferred), 1)

            def close_later():
                try:
                    time.sleep(0.05)
                    deferred[0].shutdown(socket.SHUT_RDWR)
                except BaseException as error:
                    errors.append(error)

            closer = threading.Thread(target=close_later)
            closer.start()
            try:
                self.evaluate_branch(session, "case-2").finish()
            finally:
                closer.join(2)
            self.assertFalse(closer.is_alive())
            self.assertEqual(errors, [])
            session.canonical.release_checkpoint()
            session.finish()

    def test_stuck_branch_eof_never_extends_absolute_family_lifetime(self):
        selected = plan(2, seconds=1)
        deferred = []
        started = time.monotonic()
        with self.launch(selected, defer_shutdown=deferred, expected_exit=1) as session:
            self.select_parent(session)
            self.evaluate_branch(session, "case-1").finish()
            with self.assertRaises((OSError, ValueError, TimeoutError, EOFError)):
                session.reserve("case-2")
            self.assertTrue(session.failed)
            self.assertIsNone(session.evaluations[1].reservation)
        self.assertLess(time.monotonic() - started, 5)


if __name__ == "__main__":
    unittest.main()
