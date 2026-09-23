"""Installed family-wrapper lifecycle controls; native preparation is synthetic."""

from contextlib import contextmanager
from dataclasses import fields, replace
import io
from pathlib import Path
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from crebain_ncp_sensors import family_owned
from crebain_ncp_sensors.family import FamilySession
from crebain_ncp_sensors.runtime import InstalledFamilyRuntime, InstalledRuntime
from test_family import plan


class FamilyOwnedTests(unittest.TestCase):
    def setUp(self):
        self.runtime = InstalledFamilyRuntime(
            Path("/selected"), Path("/selected/producer"), Path("/selected/bun"),
            Path("/selected/node"), Path("/selected/bridge.ts"), Path("/selected/project"),
            "a" * 64, "b" * 64, (("PATH", "/usr/bin:/bin"),),
        )

    @contextmanager
    def host(self, *, prepare_error=None, local_error=None, process_error=None, constructor_error=None):
        events = []
        session = SimpleNamespace(process_exit=None, diagnostics=b"", diagnostics_truncated=False)

        def prepare():
            events.append("prepare")
            if prepare_error is not None:
                raise prepare_error

        def local_close():
            events.append("local_close")
            if local_error is not None:
                raise local_error

        def close(*, healthy):
            events.append(("process_close", healthy))
            if process_error is not None:
                raise process_error

        session.prepare = prepare
        session.finish = lambda: events.append("finish")
        session.close = local_close
        process = SimpleNamespace(streams=[(io.BytesIO(), io.BytesIO())] * 3,
                                  close_endpoint=lambda slot: None, close=close,
                                  exit={"cleanup_confirmed": process_error is None},
                                  diagnostics=b"synthetic family diagnostics", diagnostics_truncated=True)
        with patch.object(InstalledFamilyRuntime, "open", return_value=self.runtime), \
                patch.object(family_owned, "_Process", return_value=process) as spawn, \
                patch.object(family_owned, "FamilySession", return_value=session,
                             side_effect=constructor_error):
            yield session, events, spawn

    def test_success_finishes_before_local_and_actual_process_cleanup_and_retains_diagnostics(self):
        with self.host() as (session, events, spawn):
            with family_owned.family_session(self.runtime, plan()) as value:
                self.assertIs(value, session)
                events.append("caller")
        self.assertEqual(events, ["prepare", "caller", "finish", "local_close", ("process_close", True)])
        self.assertEqual(session.process_exit, {"cleanup_confirmed": True})
        self.assertEqual(session.diagnostics, b"synthetic family diagnostics")
        self.assertTrue(session.diagnostics_truncated)
        self.assertEqual(spawn.call_args.kwargs["_family_endpoints"], 3)
        self.assertIn("--family-plan-json", spawn.call_args.args[0])

    def test_pre_yield_prepare_and_constructor_failures_still_retire_process_and_preserve_original(self):
        for constructor in (False, True):
            primary = KeyboardInterrupt("injected pre-yield cancellation")
            with self.subTest(constructor=constructor), self.host(
                    **({"constructor_error": primary} if constructor else {"prepare_error": primary})) as (_, events, _):
                with self.assertRaises(KeyboardInterrupt) as raised:
                    with family_owned.family_session(self.runtime, plan()):
                        self.fail("pre-yield failure yielded a family")
                self.assertIs(raised.exception, primary)
                self.assertEqual(events[-1], ("process_close", False))
                self.assertNotIn("finish", events)

    def test_caller_local_and_process_cleanup_failures_keep_all_original_objects(self):
        primary, local, process = RuntimeError("caller"), OSError("local retirement"), SystemExit(7)
        with self.host(local_error=local, process_error=process) as (session, events, _):
            with self.assertRaises(BaseExceptionGroup) as raised:
                with family_owned.family_session(self.runtime, plan()):
                    raise primary
            self.assertEqual(raised.exception.exceptions, (primary, local, process))
            self.assertEqual(events[-2:], ["local_close", ("process_close", False)])
            self.assertEqual(session.process_exit, {"cleanup_confirmed": False})

    def test_local_cleanup_failure_alone_cannot_skip_process_retirement(self):
        original = OSError("injected local close")
        with self.host(local_error=original) as (_, events, _):
            with self.assertRaises(OSError) as raised:
                with family_owned.family_session(self.runtime, plan()):
                    pass
            self.assertIs(raised.exception, original)
            self.assertEqual(events[-1], ("process_close", False))

    def test_overdue_caller_work_cannot_use_a_cached_terminal_to_claim_success(self):
        with self.host() as (_, events, _):
            clock = SimpleNamespace(monotonic=lambda: time.monotonic())
            with patch.object(family_owned, "time", clock):
                with self.assertRaises(TimeoutError):
                    with family_owned.family_session(self.runtime, plan()) as session:
                        session.finish()
                        clock.monotonic = lambda: float("inf")
            self.assertEqual(events.count("finish"), 1)
            self.assertEqual(events[-1], ("process_close", False))

    def test_fixed_runtime_and_reopened_bytes_precede_every_spawn(self):
        ordinary = InstalledRuntime(*(getattr(self.runtime, field.name) for field in fields(InstalledRuntime)))
        with patch.object(family_owned, "_Process", side_effect=AssertionError("spawned")) as spawn:
            for selected, reopened in ((ordinary, ordinary),
                                       (self.runtime, replace(self.runtime, source_identity="c" * 64)),
                                       (replace(self.runtime, node=None), replace(self.runtime, node=None))):
                with self.subTest(selected=selected), patch.object(InstalledFamilyRuntime, "open", return_value=reopened):
                    with self.assertRaises(ValueError):
                        with family_owned.family_session(selected, plan()):
                            self.fail("unadmitted runtime yielded")
            spawn.assert_not_called()

    def test_each_local_sdk_endpoint_retires_even_when_an_earlier_endpoint_close_fails(self):
        selected = plan(15)
        streams = [(io.BytesIO(), io.BytesIO()) for _ in range(16)]
        family = FamilySession(selected, streams, deadline=time.monotonic() + 10,
                               close_endpoint=lambda slot: None)
        closed = []
        failure = RuntimeError("injected first SDK retirement failure")

        def retire(slot):
            closed.append(slot)
            if slot == 0:
                raise failure

        for endpoint in (family.canonical, *family.evaluations):
            endpoint._client.retire_channel = lambda slot=endpoint.slot: retire(slot)
        primary = RuntimeError("original operation failed")
        with self.assertRaises(BaseExceptionGroup) as raised:
            with family.canonical._guard():
                raise primary
        self.assertIs(raised.exception.exceptions[0], primary)
        self.assertIs(raised.exception.exceptions[1].exceptions[0], failure)
        self.assertEqual(closed, list(range(16)))
        self.assertTrue(family.failed)


if __name__ == "__main__":
    unittest.main()
