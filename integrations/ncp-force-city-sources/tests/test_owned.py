"""Owned receipt joins using actual CPU processes and explicit source-only selection."""

from contextlib import contextmanager
from pathlib import Path
import os
import unittest
from unittest.mock import patch

from ncp_local import modular_wire as w, wire
from crebain_ncp_sensors.city import owned
from crebain_ncp_sensors.city.runtime import InstalledCityRuntime
from fixtures import plan, set_rows


@contextmanager
def source_selection():
    """Replace only installation admission; this does not qualify installed bytes."""
    producer = Path(os.environ["CREBAIN_CITY_PRODUCER"]).resolve(strict=True)
    bridge = Path(os.environ["CREBAIN_CITY_BRIDGE"]).resolve(strict=True)
    bun = Path(os.environ["CREBAIN_CITY_BUN"]).resolve(strict=True)
    environment = (
        ("PATH", "/usr/bin:/bin"),
        ("LANG", "C.UTF-8"),
        ("DO_NOT_TRACK", "1"),
        ("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0"),
        ("NODE_OPTIONS", "--no-global-search-paths"),
    )
    runtime = InstalledCityRuntime(
        producer.parent,
        producer,
        bun,
        None,
        bridge,
        bridge.parents[3],
        "a" * 64,
        "b" * 64,
        environment,
    )
    with patch.object(InstalledCityRuntime, "open", return_value=runtime):
        yield runtime


class OwnedControls(unittest.TestCase):
    def test_budgeted_path_preserves_originals_and_rejects_late_invalid_action(self):
        from crebain_ncp_sensors.city import composition, resources
        from test_native_cpu import microphone_plan
        from test_resources import exact_budget

        p = microphone_plan(n=2, ticks=3, count=2)
        originals = []
        for selected in (False, True):
            payloads = []
            binding = owned.new_binding()
            with source_selection() as runtime:
                options = {"binding": binding, "timeout_s": 60}
                launch = owned.city_session
                if selected:
                    launch = composition.budgeted_city_session
                    options["budget"] = exact_budget(
                        resources.composition_resources(p, binding)
                    )
                with launch(runtime, p, **options) as session:
                    if selected:
                        observed = session.last_committed
                        rows = set_rows(p)
                        with self.assertRaises(w.ModularError):
                            session.advance(rows[:-1] + ((2, *rows[-1][1:]),))
                        self.assertIs(session.last_committed, observed)
                        self.assertEqual(session.acknowledged_completed_tick, 0)
                    for _ in range(3):
                        with session.advance(set_rows(p)) as pending:
                            payloads.extend(
                                reading.payload
                                for reading in pending.observation.readings
                            )
                self.assertTrue(session.retirement.process_exit["cleanup_confirmed"])
                self.assertEqual(session.retirement.acknowledged_completed_tick, 3)
                self.assertEqual(session.resource_admission is not None, selected)
                originals.append(payloads)
        self.assertEqual(originals[0], originals[1])
        self.assertEqual(sum(map(len, originals[1])), 2 * 400 * 8)

    def test_success_has_observed_and_acknowledged_terminal_with_exit(self):
        p = plan(ticks=1)
        with source_selection() as runtime:
            with owned.city_session(runtime, p, timeout_s=60) as session:
                with session.advance(set_rows(p)):
                    pass
        receipt = session.retirement
        self.assertTrue(receipt.yielded)
        self.assertTrue(receipt.acknowledged_terminal)
        self.assertIsNotNone(receipt.observed_terminal)
        self.assertEqual(receipt.observed_completed_tick, 1)
        self.assertEqual(receipt.acknowledged_completed_tick, 1)
        self.assertEqual(receipt.process_exit["returncode"], 0)
        self.assertTrue(receipt.process_exit["cleanup_confirmed"])

    def test_pre_yield_and_post_yield_ack_loss_retains_observed_facts(self):
        for selected in ("prepare", "advance", "finish"):
            with self.subTest(selected=selected):
                original = OSError("selected ACK reply unavailable")
                pending = None

                def exchange(request, reader, writer, *, deadline):
                    nonlocal pending
                    value = w.parse(request)["command"]
                    if value["kind"] == "execute":
                        operation = value["operation"]
                        pending = (
                            operation["data"]["kind"]
                            if operation["kind"] == "application"
                            else operation["kind"]
                        )
                    wire.write_local_frame(writer, request, deadline=deadline)
                    response = wire.read_local_frame(reader, deadline=deadline)
                    if value["kind"] == "ack" and pending == selected:
                        raise original
                    return response

                p = plan(ticks=1)
                with source_selection() as runtime:
                    with self.assertRaises(BaseException) as caught:
                        with owned.city_session(
                            runtime, p, timeout_s=60, exchange=exchange
                        ) as session:
                            with session.advance(set_rows(p)):
                                pass
                outgoing = caught.exception
                errors = (
                    outgoing.exceptions
                    if type(outgoing) is ExceptionGroup
                    else (outgoing,)
                )
                self.assertIs(errors[0], original)
                receipt = owned.failure_retirement(outgoing)
                self.assertIsNotNone(receipt)
                self.assertEqual(receipt.yielded, selected != "prepare")
                self.assertTrue(receipt.observed_prepared)
                self.assertEqual(receipt.acknowledged_prepared, selected != "prepare")
                self.assertEqual(
                    receipt.observed_completed_tick, int(selected != "prepare")
                )
                self.assertEqual(
                    receipt.acknowledged_completed_tick, int(selected == "finish")
                )
                self.assertEqual(
                    receipt.observed_terminal is not None, selected == "finish"
                )
                self.assertFalse(receipt.acknowledged_terminal)
                self.assertEqual(
                    receipt.last_committed.response.outcome, w.Outcome.COMMITTED
                )
                self.assertEqual(
                    receipt.process_exit["cleanup_confirmed"], selected == "finish"
                )

    def test_constructor_cancellation_has_unavailable_process_receipt(self):
        original = KeyboardInterrupt("before process owner returned")
        with (
            source_selection() as runtime,
            patch.object(owned, "_Process", side_effect=original),
        ):
            with self.assertRaises(KeyboardInterrupt) as caught:
                with owned.city_session(runtime, plan(ticks=1), timeout_s=60):
                    self.fail("constructor failure yielded")
        self.assertIs(caught.exception, original)
        receipt = owned.failure_retirement(original)
        self.assertFalse(receipt.yielded)
        self.assertIsNone(receipt.process_exit)
        self.assertFalse(receipt.observed_prepared)

    def test_primary_cancellation_and_cleanup_error_keep_both_originals(self):
        original = KeyboardInterrupt("caller cancellation")
        cleanup = OSError("cleanup diagnostic failure")
        process_type = owned._Process
        close = process_type.close

        def failed_close(process, *, healthy):
            # The control still retires its actual child before injecting this failure.
            try:
                close(process, healthy=healthy)
            except BaseException:
                pass
            raise cleanup

        with (
            source_selection() as runtime,
            patch.object(process_type, "close", failed_close),
        ):
            with self.assertRaises(BaseExceptionGroup) as caught:
                with owned.city_session(runtime, plan(ticks=1), timeout_s=60):
                    raise original
        self.assertIs(caught.exception.exceptions[0], original)
        self.assertIs(caught.exception.exceptions[1], cleanup)
        receipt = owned.failure_retirement(caught.exception)
        self.assertTrue(receipt.yielded)
        self.assertTrue(receipt.acknowledged_prepared)
        self.assertFalse(receipt.acknowledged_terminal)
        self.assertIsNotNone(receipt.process_exit)
        self.assertFalse(receipt.process_exit["cleanup_confirmed"])


if __name__ == "__main__":
    unittest.main()
