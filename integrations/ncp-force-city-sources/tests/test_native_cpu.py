"""Actual CPU source construction controls; no installed, GPU, or stability qualification."""

from contextlib import contextmanager
from dataclasses import replace
import json
import hashlib
import os
from pathlib import Path
import time
import struct
import unittest

from ncp_local import modular_wire as w
from crebain_ncp_sensors._process import _Process
from crebain_ncp_sensors.city import CitySession, new_binding
from crebain_ncp_sensors.city import codec as c, types as t
from fixtures import plan, set_rows


@contextmanager
def source_session(p, exchange=None):
    producer = Path(os.environ["CREBAIN_CITY_PRODUCER"]).resolve(strict=True)
    bridge = Path(os.environ["CREBAIN_CITY_BRIDGE"]).resolve(strict=True)
    bun = Path(os.environ["CREBAIN_CITY_BUN"]).resolve(strict=True)
    root = bridge.parents[3]
    binding = new_binding()
    deadline = time.monotonic() + 90
    command = [
        str(producer),
        "--bun",
        str(bun),
        "--bridge",
        str(bridge),
        "--source-identity",
        "a" * 64,
        "--binding-json",
        json.dumps(c.raw(binding), separators=(",", ":")),
    ]
    environment = {
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "DO_NOT_TRACK": "1",
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
        "NODE_OPTIONS": "--no-global-search-paths",
    }
    process = _Process(command, environment, root, deadline=deadline)
    session = CitySession(
        process.reader,
        process.writer,
        binding,
        p,
        deadline=deadline,
        exchange=exchange,
        source_identity="a" * 64,
    )
    try:
        yield session, process
    finally:
        session.close()
        try:
            process.close(healthy=session.acknowledged_terminal)
        except BaseException as cleanup:
            print("SOURCE_CONTROL_CLEANUP_ERROR", type(cleanup).__name__, flush=True)
            if session.acknowledged_terminal:
                raise
            # Negative controls inspect the actual unresolved/failing receipt below.
        finally:
            print(
                "SOURCE_CONTROL_RETIREMENT",
                json.dumps(
                    {
                        "exit": process.exit,
                        "directory": str(process.directory),
                        "diagnostics": process.diagnostics.decode(
                            "utf-8", errors="replace"
                        ),
                        "truncated": process.diagnostics_truncated,
                    }
                ),
                flush=True,
            )


def microphone_plan(n=1, ticks=2, count=1):
    p = plan(n, ticks=ticks, modalities=("pressure",) * count)
    sources = tuple(
        replace(s, position=(-90.0, 50.0, -89.0 - float(i)))
        for i, s in enumerate(p.sources)
    )
    p = replace(p, sources=sources)
    return replace(p, resource_plan_digest=c.resource_digest(p))


class NativeCPUControls(unittest.TestCase):
    def test_rehashed_foreign_batch_identity_rejects_before_acknowledgement(self):
        from ncp_local import wire

        for selected in ("recipient", "source", "source_tick", "ordered_control"):
            with self.subTest(selected=selected):

                def exchange(request, reader, writer, *, deadline):
                    wire.write_local_frame(writer, request, deadline=deadline)
                    response = wire.read_local_frame(reader, deadline=deadline)
                    decoded = w.parse(response)
                    if (
                        decoded["body"]["kind"] == "application"
                        and decoded["body"]["data"]["kind"] == "advanced"
                    ):
                        batch = decoded["body"]["data"]["batch"]
                        if selected == "recipient":
                            batch["slots"][0]["entity_index"] = 2
                        elif selected == "source":
                            batch["slots"][0]["source_id"] = "foreign"
                        elif selected == "source_tick":
                            batch["slots"][0]["source_body_tick"] = 2
                        else:
                            batch["control"]["rows"] = batch["control"]["rows"][::-1]
                        batch["batch_digest"] = c.commitment("batch", batch)
                        decoded["result_digest"] = w.typed_digest(
                            w.RESPONSE_SCHEMA, decoded, "result_digest"
                        )
                        return w.encode(decoded)
                    return response

                p = microphone_plan(3, ticks=2)
                with source_session(p, exchange) as (session, _):
                    session.prepare()
                    with self.assertRaises(w.ModularError):
                        session.advance(set_rows(p))
                    self.assertEqual(session.observed_completed_tick, 0)
                    self.assertEqual(session.acknowledged_completed_tick, 0)
                    self.assertTrue(session._client.is_retired)

    def test_numerical_payload_checks_reject_rehashed_nonfinite_and_invalid_radiance(
        self,
    ):
        p = microphone_plan(ticks=1)
        with source_session(p) as (session, _):
            session.prepare()
            with session.advance(set_rows(p)) as pending:
                reading = pending.observation.readings[0]
                c.validate_payload(
                    reading.manifest, reading.byte_manifest, reading.payload
                )
                for kind, values in (
                    ("pressure", (0.0, float("nan"), float("inf"))),
                    ("radiance", (0.0, -1.0, 10001.0, float("nan"))),
                ):
                    for value in values:
                        payload = struct.pack(
                            "<d" if kind == "pressure" else "<f", value
                        )
                        digest = hashlib.sha256(payload).hexdigest()
                        tensor = (
                            t.PressureTensor(
                                "pressure",
                                "f64le",
                                (1,),
                                "c_contiguous",
                                0,
                                1,
                                16000,
                                "pascal",
                            )
                            if kind == "pressure"
                            else t.RadianceTensor(
                                "radiance",
                                "f32le",
                                (1, 1),
                                "c_contiguous",
                                "bottom-left",
                                "W/(m2 sr)",
                            )
                        )
                        manifest = replace(
                            reading.manifest,
                            tensor=tensor,
                            original_payload_sha256=digest,
                        )
                        byte_manifest = replace(
                            reading.byte_manifest,
                            byte_length=len(payload),
                            payload_sha256=digest,
                        )
                        if value == 0.0:
                            c.validate_payload(manifest, byte_manifest, payload)
                        else:
                            with self.assertRaises(w.ModularError):
                                c.validate_payload(manifest, byte_manifest, payload)
            session.finish()

    def test_actual_256_cpu_only_whole_world_and_invalid_last_row(self):
        p = plan(256, ticks=2, solids=16)
        with source_session(p) as (session, process):
            session.prepare()
            bad = set_rows(p)[:-1] + ((254, *set_rows(p)[255][1:]),)
            with self.assertRaises(w.ModularError):
                session.advance(bad)
            for tick in range(1, 3):
                with session.advance(set_rows(p) if tick == 1 else None) as pending:
                    b = pending.observation.batch
                    self.assertEqual(b.tick, tick)
                    self.assertEqual(len(b.control.rows), 256)
                    self.assertEqual(
                        tuple(row[0] for row in b.control.rows), tuple(range(256))
                    )
                    self.assertEqual(pending.observation.readings, ())
                    self.assertFalse(pending.observation.source_failed)
            terminal = session.finish()
            self.assertEqual(terminal.terminal.completed_ticks, 2)
        self.assertTrue(process.exit["cleanup_confirmed"])
        self.assertEqual(process.exit["returncode"], 0)
        self.assertIn(b'"graphics":null', process.diagnostics)

    def test_actual_four_pressure_sources_keep_original_production_and_bytes(self):
        p = microphone_plan(3, ticks=3, count=4)
        with source_session(p) as (session, process):
            session.prepare()
            for tick in range(1, 4):
                with session.advance(set_rows(p) if tick == 1 else None) as pending:
                    readings = pending.observation.readings
                    self.assertEqual(len(readings), 4)
                    self.assertEqual(
                        len({r.manifest.source_production_digest for r in readings}), 4
                    )
                    for reading in readings:
                        c.validate_payload(
                            reading.manifest, reading.byte_manifest, reading.payload
                        )
                        self.assertEqual(
                            len(reading.payload), (134 if tick == 3 else 133) * 8
                        )
            result = session.finish()
            self.assertEqual(result.payload_count, 12)
            self.assertEqual(result.raw_bytes, 4 * 400 * 8)
        self.assertTrue(process.exit["cleanup_confirmed"])


class AckLossControls(unittest.TestCase):
    def test_prepare_advance_export_and_finish_committed_facts_survive_ack_loss(self):
        from ncp_local import wire

        for selected in ("prepare", "advance", "export_source", "finish"):
            with self.subTest(selected=selected):
                p = microphone_plan(ticks=1)
                original = OSError("selected acknowledgement reply unavailable")
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

                with source_session(p, exchange) as (session, process):
                    with self.assertRaises(OSError) as caught:
                        session.prepare()
                        with session.advance(set_rows(p)):
                            pass
                        session.finish()
                    self.assertIs(caught.exception, original)
                    self.assertTrue(session.observed_prepared)
                    self.assertEqual(
                        session.acknowledged_prepared, selected != "prepare"
                    )
                    self.assertEqual(
                        session.observed_completed_tick,
                        0 if selected == "prepare" else 1,
                    )
                    self.assertEqual(
                        session.acknowledged_completed_tick,
                        1 if selected in ("export_source", "finish") else 0,
                    )
                    self.assertEqual(
                        session.observed_terminal is not None, selected == "finish"
                    )
                    self.assertFalse(session.acknowledged_terminal)
                    self.assertIsNotNone(session.last_committed)
                    self.assertEqual(
                        session.last_committed.response.outcome, w.Outcome.COMMITTED
                    )
                    self.assertTrue(session._client.is_retired)
                    with self.assertRaises(w.ModularError):
                        session.advance()
                self.assertIsNotNone(process.exit)
                self.assertEqual(
                    process.exit["cleanup_confirmed"], selected == "finish"
                )


if __name__ == "__main__":
    unittest.main()
