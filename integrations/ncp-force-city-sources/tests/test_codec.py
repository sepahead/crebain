"""Closed city shapes and independent resource admission, without native execution."""

from dataclasses import replace
import unittest
from ncp_local import modular_wire as w
from crebain_ncp_sensors.city import codec as c, types as t
from crebain_ncp_sensors.city.contract import CityContract
from fixtures import plan, set_rows


class CodecTests(unittest.TestCase):
    def test_zero_two_three_four_and_twelve_sources_are_explicit(self):
        for modalities in (
            (),
            ("rgb", "pressure"),
            ("rgb", "thermal", "pressure"),
            ("rgb",) * 4,
            ("rgb",) * 4 + ("thermal",) * 4 + ("pressure",) * 4,
        ):
            p = plan(256, modalities=modalities, solids=16)
            self.assertEqual(CityContract.decode_prepare(c.raw(p)), p)
            self.assertEqual(c.validate_rows(p, set_rows(p), (), 0), 256)
            self.assertEqual(hasattr(p, "thermal"), "thermal" in modalities)
            self.assertEqual(hasattr(p, "acoustic"), "pressure" in modalities)

    def test_fifth_modality_thirteenth_source_and_257th_entity_reject(self):
        for modalities in (
            ("rgb",) * 5,
            ("rgb",) * 4 + ("thermal",) * 4 + ("pressure",) * 5,
        ):
            with self.assertRaises(w.ModularError):
                CityContract.decode_prepare(c.raw(plan(256, modalities=modalities)))
        with self.assertRaises(w.ModularError):
            plan(257)
        CityContract.decode_prepare(c.raw(plan(256)))

    def test_foreign_reordered_missing_and_repeated_recipient_rows_reject(self):
        p = plan(256)
        rows = set_rows(p)
        for malformed in (
            rows[:-1],
            rows[::-1],
            rows[:-1] + ((254, *rows[-1][1:]),),
            rows[:-1] + ((256, *rows[-1][1:]),),
        ):
            with self.assertRaises(w.ModularError):
                c.validate_rows(p, malformed, (), 0)
        self.assertEqual(c.validate_rows(p, rows, (), 3840), 256)
        with self.assertRaises(w.ModularError):
            c.validate_rows(p, rows, (), 3841)

    def test_integer_float_boolean_and_negative_zero_are_not_interchangeable(self):
        p = plan()
        raw = c.raw(p)
        raw["world"]["initial_positions"][0][0] = -0.0
        decoded = c.decode("Prepare", raw)
        self.assertFalse(c.equal_bits(decoded.world.initial_positions[0][0], 0.0))
        for malformed in (0, True):
            raw["world"]["initial_positions"][0][0] = malformed
            with self.assertRaises(w.ModularError):
                c.decode("Prepare", raw)
        raw = c.raw(p)
        raw["world"]["horizon_ticks"] = 2.0
        with self.assertRaises(w.ModularError):
            c.decode("Prepare", raw)

    def test_missing_foreign_models_and_source_aliases_reject(self):
        p = plan(2, modalities=("rgb", "thermal", "pressure"))
        raw = c.raw(p)
        del raw["thermal"]
        with self.assertRaises(w.ModularError):
            CityContract.decode_prepare(raw)
        raw = c.raw(p)
        raw["sources"][1]["source_id"] = raw["sources"][0]["source_id"]
        with self.assertRaises(w.ModularError):
            CityContract.decode_prepare(raw)
        raw = c.raw(plan())
        raw["unexpected"] = {}
        with self.assertRaises(w.ModularError):
            c.decode("Prepare", raw)

    def test_resource_drift_rejects_and_maximum_original_arenas_join(self):
        p = plan(256, modalities=("rgb",) * 4 + ("thermal",) * 4 + ("pressure",) * 4)
        sources = tuple(
            replace(s, width=1280, height=1280)
            if type(s) is t.RGBRequest
            else replace(s, width=320, height=320)
            if type(s) is t.ThermalRequest
            else s
            for s in p.sources
        )
        p = replace(
            p, sources=sources, acoustic=replace(p.acoustic, soundSpeedMps=300.0)
        )
        p = replace(p, resource_plan_digest=c.resource_digest(p))
        CityContract.decode_prepare(c.raw(p))
        self.assertEqual(c.resources(p)["native_original_bytes"], 27_857_088)
        self.assertEqual(c.resources(p)["acoustic_history_bytes"], 13_985_792)
        with self.assertRaises(w.ModularError):
            CityContract.decode_prepare(
                c.raw(replace(p, resource_plan_digest="0" * 64))
            )


if __name__ == "__main__":
    unittest.main()
