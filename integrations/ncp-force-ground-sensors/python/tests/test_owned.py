"""Owned API controls with the independent synthetic NCP peer; no native claims."""

from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
import unittest
import time
from unittest.mock import patch

from crebain_ncp_sensors import body_session, new_binding, InstalledRuntime
from crebain_ncp_sensors import owned
from fixtures import binding, owner, plan, target
from test_client import channel


class OwnedTests(unittest.TestCase):
    def setUp(self):
        self.runtime = InstalledRuntime(
            Path("/selected"), Path("/selected/producer"), Path("/selected/bun"),
            Path("/selected/node"), Path("/selected/bridge.ts"), Path("/selected/project"),
            "a" * 64, "b" * 64, (("PATH", "/usr/bin:/bin"),),
        )

    @contextmanager
    def host(self, *, cleanup=None, hook=None):
        host, application = owner()
        closes = []
        with channel(host, hook=hook) as stream:
            def close(*, healthy):
                closes.append(healthy)
                if cleanup is not None:
                    raise cleanup
            process = SimpleNamespace(reader=stream, writer=stream, close=close,
                                      exit={"cleanup_confirmed": cleanup is None},
                                      diagnostics=b"synthetic diagnostic", diagnostics_truncated=False)
            with patch.object(InstalledRuntime, "open", return_value=self.runtime), \
                    patch.object(owned, "_Process", return_value=process) as spawn:
                yield application, closes, spawn

    def test_auto_finish_and_explicit_finish_are_equivalent(self):
        for explicit in (False, True):
            with self.subTest(explicit=explicit), self.host() as (application, closes, spawn):
                with body_session(self.runtime, plan(2), binding=binding()) as body:
                    for tick in range(2):
                        with body.advance(target() if tick == 0 else None):
                            pass
                    if explicit:
                        body.finish()
                self.assertTrue(application.finished)
                self.assertEqual(application.advances, 2)
                self.assertEqual(closes, [True])
                self.assertEqual(body.process_exit, {"cleanup_confirmed": True})
                self.assertEqual(body.diagnostics, b"synthetic diagnostic")
                self.assertIn("--node", spawn.call_args.args[0])

    def test_incomplete_and_unreleased_work_cannot_finish(self):
        for release in (False, True):
            with self.subTest(release=release), self.host() as (application, closes, _):
                with self.assertRaises(ValueError):
                    with body_session(self.runtime, plan(2), binding=binding()) as body:
                        batch = body.advance(target())
                        if release:
                            batch.release()
                self.assertFalse(application.finished)
                self.assertEqual(body.validated_ticks, 1)
                self.assertEqual(closes, [False])

    def test_user_failure_and_cleanup_failure_remain_separate(self):
        for primary in (RuntimeError("caller failed"), KeyboardInterrupt(), SystemExit(3)):
            cleanup = RuntimeError("cleanup failed")
            with self.subTest(primary=type(primary).__name__), self.host(cleanup=cleanup) as (application, closes, _):
                with self.assertRaises(BaseExceptionGroup) as caught:
                    with body_session(self.runtime, plan(), binding=binding()):
                        raise primary
                self.assertEqual(caught.exception.exceptions, (primary, cleanup))
                self.assertFalse(application.finished)
                self.assertEqual(closes, [False])

    def test_primary_failure_survives_successful_cleanup(self):
        primary = RuntimeError("caller failed")
        with self.host() as (_, closes, _):
            with self.assertRaises(RuntimeError) as caught:
                with body_session(self.runtime, plan(), binding=binding()):
                    raise primary
            self.assertIs(caught.exception, primary)
            self.assertEqual(closes, [False])
            self.assertIn("synthetic diagnostic", primary.__notes__[0])

    def test_cached_finish_cannot_hide_overdue_caller_work(self):
        with self.host() as (application, closes, _):
            clock = SimpleNamespace(monotonic=lambda: time.monotonic())
            with patch.object(owned, "time", clock):
                with self.assertRaises(TimeoutError):
                    with body_session(self.runtime, plan(1), binding=binding()) as body:
                        with body.advance(target()):
                            pass
                        body.finish()
                        clock.monotonic = lambda: float("inf")
            self.assertTrue(application.finished)
            self.assertEqual(closes, [False])

    def test_invalid_setup_never_spawns(self):
        mutations = (
            {"prepare": replace(plan(), planned_ticks=0)},
            {"timeout_s": True}, {"timeout_s": 0}, {"timeout_s": 601},
            {"timeout_s": float("nan")}, {"exchange": 3},
            {"binding": replace(binding(), application_digest="0" * 64)},
            {"binding": object()}, {"runtime": object()},
        )
        with patch.object(InstalledRuntime, "open", return_value=self.runtime), \
                patch.object(owned, "_Process", side_effect=AssertionError("spawned")) as spawn:
            for mutation in mutations:
                values = {"runtime": self.runtime, "prepare": plan(), "binding": binding(), **mutation}
                with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                    with body_session(**values):
                        self.fail("invalid setup admitted")
            spawn.assert_not_called()

    def test_reopened_runtime_and_graphics_selection_precede_spawn(self):
        with patch.object(owned, "_Process", side_effect=AssertionError("spawned")) as spawn:
            with patch.object(InstalledRuntime, "open", return_value=replace(self.runtime, source_identity="c" * 64)):
                with self.assertRaises(ValueError):
                    with body_session(self.runtime, plan()):
                        pass
            no_node = replace(self.runtime, node=None)
            with patch.object(InstalledRuntime, "open", return_value=no_node):
                with self.assertRaises(ValueError):
                    with body_session(no_node, plan()):
                        pass
            spawn.assert_not_called()

    def test_camera_free_omits_node_even_when_installed(self):
        selected = plan(1)
        selected = replace(selected, specification=replace(selected.specification,
            scene=replace(selected.specification.scene, rgbCameras=(), thermalCameras=())))
        with self.host() as (application, closes, spawn):
            with body_session(self.runtime, selected, binding=binding()) as body:
                with body.advance(target()):
                    pass
            self.assertTrue(application.finished)
            self.assertEqual(closes, [True])
            self.assertNotIn("--node", spawn.call_args.args[0])

    def test_new_bindings_share_only_an_explicit_run(self):
        first, second = new_binding(), new_binding()
        third = new_binding(run_id=first.run_id)
        self.assertNotEqual(first.run_id, second.run_id)
        self.assertEqual(first.run_id, third.run_id)
        self.assertEqual(len({first.endpoint_id, second.endpoint_id, third.endpoint_id}), 3)
        self.assertEqual(len({first.generation, second.generation, third.generation}), 3)
        with self.assertRaises(ValueError):
            new_binding(run_id="not-a-uuid")


if __name__ == "__main__":
    unittest.main()
