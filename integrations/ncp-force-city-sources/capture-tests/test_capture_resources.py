"""Explicit optional Prisoma-owner controls; select its installed package to run."""

from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ncp_local import modular_wire as w
from prisoma_ncp_transcript import CaptureError, Journal, Peer, capacity_bytes, inspect
from crebain_ncp_sensors.city import composition, new_binding, owned
from crebain_ncp_sensors.city.contract import CityContract
from crebain_ncp_sensors.city.resources import admit_composition, composition_resources
from fixtures import plan
from test_resources import exact_budget, maximum_plan


class CaptureResources(unittest.TestCase):
    def test_actual_body_and_captured_originals_and_exchange_counts_agree(self):
        from fixtures import set_rows
        from test_native_cpu import microphone_plan
        from test_owned import source_selection

        p, originals = microphone_plan(n=2, ticks=3, count=2), []
        with tempfile.TemporaryDirectory() as directory:
            for capture in (False, True):
                binding = new_binding()
                required = composition_resources(p, binding, capture=capture)
                payloads = []
                with source_selection() as rt:
                    with composition.budgeted_city_session(
                        rt,
                        p,
                        binding=binding,
                        budget=exact_budget(required),
                        capture_path=Path(directory) / "capture" if capture else None,
                        timeout_s=60,
                    ) as session:
                        for _ in range(3):
                            with session.advance(set_rows(p)) as pending:
                                payloads.extend(
                                    row.payload for row in pending.observation.readings
                                )
                    self.assertTrue(
                        session.retirement.process_exit["cleanup_confirmed"]
                    )
                    self.assertEqual(session.capture_terminal is not None, capture)
                    originals.append(payloads)
                if capture:
                    exchanges = []
                    inspect(
                        Path(directory) / "capture",
                        (Peer(binding, CityContract),),
                        exchanges.append,
                    )
                    self.assertEqual(len(exchanges), required.normal_exchanges)
                    self.assertEqual(
                        session.capture_terminal["exchange_pairs"],
                        required.normal_exchanges,
                    )
                    self.assertLessEqual(
                        (Path(directory) / "capture").stat().st_size,
                        required.storage_bytes,
                    )
            self.assertEqual(originals[0], originals[1])
            self.assertEqual(sum(map(len, originals[1])), 2 * 400 * 8)

    def test_real_capacity_and_exact_minus_plus_storage_limits(self):
        p, binding = maximum_plan(), new_binding()
        r = composition_resources(p, binding, capture=True)
        self.assertEqual(
            r.capture_storage_bytes,
            capacity_bytes((Peer(binding, CityContract),), max_exchanges=5298),
        )
        budget = exact_budget(r)
        admit_composition(p, binding, budget, capture=True)
        admit_composition(
            p,
            binding,
            replace(budget, storage_bytes=budget.storage_bytes + 1),
            capture=True,
        )
        with self.assertRaises(w.ModularError):
            admit_composition(
                p,
                binding,
                replace(budget, storage_bytes=budget.storage_bytes - 1),
                capture=True,
            )

    def test_unrecordable_horizon_rejects_before_real_file_or_process(self):
        p, binding = plan(ticks=7200), new_binding()
        uncaptured = composition_resources(p, binding)
        self.assertGreater(uncaptured.maximum_exchanges, 8190)
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(owned, "_Process") as process,
        ):
            target = Path(directory) / "transcript"
            with self.assertRaises(ValueError):
                with composition.budgeted_city_session(
                    object(),
                    p,
                    binding=binding,
                    budget=exact_budget(uncaptured),
                    capture_path=target,
                ):
                    self.fail("unrecordable horizon yielded")
            self.assertEqual(list(Path(directory).iterdir()), [])
            process.assert_not_called()

    def test_real_journal_closes_and_preserves_prefix_after_process_failure(self):
        from crebain_ncp_sensors.city.runtime import InstalledCityRuntime
        from test_composition import runtime

        p, binding, rt = plan(ticks=1), new_binding(), runtime()
        original = OSError("producer constructor unavailable")
        budget = exact_budget(composition_resources(p, binding, capture=True))
        journals = []

        def record_journal(*args, **kwargs):
            journal = Journal(*args, **kwargs)
            journals.append(journal)
            return journal

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(InstalledCityRuntime, "open", return_value=rt),
            patch.object(owned, "_Process", side_effect=original),
            patch("prisoma_ncp_transcript.Journal", record_journal),
        ):
            target = Path(directory) / "transcript"
            with self.assertRaises(OSError) as caught:
                with composition.budgeted_city_session(
                    rt, p, binding=binding, budget=budget, capture_path=target
                ):
                    self.fail("unreturned process yielded")
            self.assertIs(caught.exception, original)
            self.assertIsNone(owned.failure_retirement(original).process_exit)
            prefix = target.read_bytes()
            self.assertGreater(len(prefix), 0)
            self.assertLess(len(prefix), budget.storage_bytes)
            self.assertEqual(len(journals), 1)
            self.assertIsNone(journals[0]._fd)
            with self.assertRaisesRegex(CaptureError, "terminal_missing"):
                inspect(target, (Peer(binding, CityContract),), lambda exchange: None)
            # The selected prefix remains an incomplete original, not a made-up
            # terminal. Opening exclusively again must reject its existing path.
            with self.assertRaises(FileExistsError):
                target.open("xb")


if __name__ == "__main__":
    unittest.main()
