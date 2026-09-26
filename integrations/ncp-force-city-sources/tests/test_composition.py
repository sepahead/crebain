"""Synthetic effect-boundary controls; optional-owner format tests are separate."""

from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from types import ModuleType, SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch

from ncp_local import modular_wire as w
from crebain_ncp_sensors.city import composition, owned, resources, new_binding
from crebain_ncp_sensors.city.runtime import InstalledCityRuntime
from fixtures import plan
from test_resources import exact_budget, maximum_plan


@dataclass(frozen=True)
class Terminal:
    status: str = "completed"


def runtime():
    root = Path("/synthetic/runtime")
    return InstalledCityRuntime(
        root,
        root / "producer",
        root / "bun",
        None,
        root / "bridge",
        root,
        "a" * 64,
        "b" * 64,
        (),
    )


@contextmanager
def peers(*, finish_error=None, close_error=None, constructor_error=None):
    """Declare synthetic owner behavior without imitating a transcript format."""
    events = []
    module = ModuleType("prisoma_ncp_transcript")
    module.Peer = lambda binding, contract: (binding, contract)
    module.capacity_bytes = lambda peers, *, max_exchanges: 12345

    class Journal:
        def __init__(self, path, selected, **kwargs):
            events.append(("construct", path, selected, kwargs))
            if constructor_error is not None:
                raise constructor_error

        def finish(self):
            events.append(("finish",))
            if finish_error is not None:
                raise finish_error
            return Terminal()

        def close(self):
            events.append(("close",))
            if close_error is not None:
                raise close_error

    module.Journal = Journal
    with patch.dict(sys.modules, {module.__name__: module}):
        yield events


class CompositionControls(unittest.TestCase):
    def setUp(self):
        self.p, self.binding, self.runtime = plan(ticks=1), new_binding(), runtime()
        self.receipt = owned.RetirementReceipt(
            "crebain.city-session-retirement.v1",
            True,
            {"cleanup_confirmed": True},
            b"",
            False,
            None,
            True,
            1,
            None,
            True,
            True,
            1,
            True,
            "c" * 64,
        )

    def budget(self, p=None, capture=False):
        return exact_budget(
            resources.composition_resources(p or self.p, self.binding, capture=capture)
        )

    def test_insufficient_budget_and_bad_final_source_have_no_selected_effect(self):
        p = maximum_plan()
        budget = self.budget(p)
        invalid = replace(
            p, sources=p.sources[:-1] + (replace(p.sources[-1], entity_index=256),)
        )
        with peers() as events, patch.object(owned, "_Process") as process:
            for selected, limit in (
                (p, replace(budget, logical_bytes=budget.logical_bytes - 1)),
                (invalid, budget),
            ):
                with self.assertRaises(w.ModularError):
                    with composition.budgeted_city_session(
                        self.runtime,
                        selected,
                        budget=limit,
                        binding=self.binding,
                        capture_path=Path("/not-created"),
                    ):
                        self.fail("invalid admission yielded")
            self.assertEqual(events, [])
            process.assert_not_called()

    def test_runtime_timeout_and_missing_camera_launcher_reject_before_journal(self):
        with (
            peers() as events,
            patch.object(InstalledCityRuntime, "open", return_value=self.runtime),
            patch.object(owned, "_Process") as process,
        ):
            for selected, rt, timeout in (
                (self.p, self.runtime, True),
                (self.p, object(), 600),
                (plan(ticks=1, modalities=("rgb",)), self.runtime, 600),
            ):
                with self.assertRaises(w.ModularError):
                    with composition.budgeted_city_session(
                        rt,
                        selected,
                        budget=self.budget(selected, True),
                        binding=self.binding,
                        timeout_s=timeout,
                        capture_path=Path("/not-created"),
                    ):
                        self.fail("invalid launch yielded")
            self.assertEqual(events, [])
            process.assert_not_called()

    def test_exact_available_disk_accepts_and_minus_one_rejects(self):
        with patch.object(
            composition.os,
            "statvfs",
            return_value=SimpleNamespace(f_bavail=12345, f_frsize=1),
        ):
            self.assertEqual(
                composition._storage_preflight(Path("/capture"), 12345),
                Path("/capture"),
            )
            with self.assertRaises(w.ModularError):
                composition._storage_preflight(Path("/capture"), 12346)
        with self.assertRaises(w.ModularError):
            composition._storage_preflight(Path("relative"), 0)

    def test_process_owner_recomputes_forged_admission_before_construction(self):
        admission = resources.admit_composition(self.p, self.binding, self.budget())
        forged = replace(
            admission, resources=replace(admission.resources, host_original_bytes=False)
        )
        original = OSError("admitted constructor reached")
        with (
            patch.object(InstalledCityRuntime, "open", return_value=self.runtime),
            patch.object(owned, "_Process", side_effect=original) as process,
        ):
            with self.assertRaises(w.ModularError):
                with owned.city_session(
                    self.runtime,
                    self.p,
                    binding=self.binding,
                    _resource_admission=forged,
                ):
                    self.fail("forged admission yielded")
            process.assert_not_called()
            with self.assertRaises(OSError) as caught:
                with owned.city_session(
                    self.runtime,
                    self.p,
                    binding=self.binding,
                    _resource_admission=admission,
                ):
                    self.fail("constructor failure yielded")
            self.assertIs(caught.exception, original)
            process.assert_called_once()

    def test_healthy_capture_finalizes_after_retirement_and_closes(self):
        state = SimpleNamespace(retirement=None, capture_terminal=None)

        @contextmanager
        def body(*args, **kwargs):
            resources.recheck_admission(
                self.p, self.binding, kwargs["_resource_admission"]
            )
            self.assertIsNotNone(kwargs["exchange"])
            yield state
            state.retirement = self.receipt

        with (
            tempfile.TemporaryDirectory() as directory,
            peers() as events,
            patch.object(InstalledCityRuntime, "open", return_value=self.runtime),
            patch.object(composition, "city_session", body),
        ):
            with composition.budgeted_city_session(
                self.runtime,
                self.p,
                binding=self.binding,
                budget=self.budget(capture=True),
                capture_path=Path(directory) / "capture",
            ) as session:
                self.assertIsNone(session.retirement)
            self.assertEqual(
                [row[0] for row in events], ["construct", "finish", "close"]
            )
            self.assertEqual(session.capture_terminal, {"status": "completed"})
            self.assertIs(session.retirement, self.receipt)

    def test_operation_and_capture_cleanup_preserve_originals_and_retirement(self):
        operation, cleanup = KeyboardInterrupt("operation"), OSError("capture close")
        state = SimpleNamespace(retirement=self.receipt, capture_terminal=None)

        @contextmanager
        def body(*args, **kwargs):
            yield state

        with (
            tempfile.TemporaryDirectory() as directory,
            peers(close_error=cleanup) as events,
            patch.object(InstalledCityRuntime, "open", return_value=self.runtime),
            patch.object(composition, "city_session", body),
        ):
            with self.assertRaises(BaseExceptionGroup) as caught:
                with composition.budgeted_city_session(
                    self.runtime,
                    self.p,
                    binding=self.binding,
                    budget=self.budget(capture=True),
                    capture_path=Path(directory) / "capture",
                ):
                    raise operation
            self.assertIs(caught.exception.exceptions[0], operation)
            self.assertIs(caught.exception.exceptions[1], cleanup)
            self.assertIs(owned.failure_retirement(caught.exception), self.receipt)
            self.assertEqual([row[0] for row in events], ["construct", "close"])
            self.assertIsNone(state.capture_terminal)

    def test_pre_yield_failure_closes_journal_and_retains_unyielded_receipt(self):
        original = OSError("process construction failed")
        receipt = replace(self.receipt, yielded=False, process_exit=None)
        original.city_retirement = receipt

        @contextmanager
        def body(*args, **kwargs):
            raise original
            yield

        with (
            tempfile.TemporaryDirectory() as directory,
            peers() as events,
            patch.object(InstalledCityRuntime, "open", return_value=self.runtime),
            patch.object(composition, "city_session", body),
        ):
            with self.assertRaises(OSError) as caught:
                with composition.budgeted_city_session(
                    self.runtime,
                    self.p,
                    binding=self.binding,
                    budget=self.budget(capture=True),
                    capture_path=Path(directory) / "capture",
                ):
                    self.fail("pre-yield failure yielded")
            self.assertIs(caught.exception, original)
            self.assertIs(owned.failure_retirement(original), receipt)
            self.assertEqual([row[0] for row in events], ["construct", "close"])

    def test_constructor_and_terminal_failures_never_claim_capture_success(self):
        for stage in ("constructor", "finish"):
            original = OSError(stage)
            state = SimpleNamespace(retirement=self.receipt, capture_terminal=None)

            @contextmanager
            def body(*args, **kwargs):
                yield state

            with (
                self.subTest(stage=stage),
                tempfile.TemporaryDirectory() as directory,
                peers(
                    constructor_error=original if stage == "constructor" else None,
                    finish_error=original if stage == "finish" else None,
                ) as events,
                patch.object(InstalledCityRuntime, "open", return_value=self.runtime),
                patch.object(composition, "city_session", body),
            ):
                with self.assertRaises(OSError) as caught:
                    with composition.budgeted_city_session(
                        self.runtime,
                        self.p,
                        binding=self.binding,
                        budget=self.budget(capture=True),
                        capture_path=Path(directory) / "capture",
                    ):
                        pass
                self.assertIs(caught.exception, original)
                self.assertIsNone(state.capture_terminal)
                self.assertEqual(
                    sum(row[0] == "close" for row in events), int(stage == "finish")
                )
                self.assertIs(
                    owned.failure_retirement(original),
                    self.receipt if stage == "finish" else None,
                )


if __name__ == "__main__":
    unittest.main()
