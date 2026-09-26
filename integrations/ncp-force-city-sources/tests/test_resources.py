"""Pre-effect logical admission controls; no opaque-memory or native claim."""

from dataclasses import fields, replace
import builtins
from pathlib import Path
import unittest
from unittest.mock import patch

from ncp_local import modular_wire as w
from ncp_local.modular_client import Client
from crebain_ncp_sensors.city import codec as c, types as t, new_binding
from crebain_ncp_sensors.city.contract import CityContract
from crebain_ncp_sensors.city.resources import (
    GRAPHICS_INPUT_BYTES,
    NATIVE_PLAN_BYTES,
    ResourceBudget,
    admit_composition,
    composition_resources,
    recheck_admission,
)
from fixtures import plan


def maximum_plan():
    p = plan(
        256,
        ticks=3,
        solids=16,
        modalities=("rgb",) * 4 + ("thermal",) * 4 + ("pressure",) * 4,
    )
    sources = tuple(
        replace(s, width=1280, height=1280)
        if type(s) is t.RGBRequest
        else replace(s, width=320, height=320)
        if type(s) is t.ThermalRequest
        else s
        for s in p.sources
    )
    p = replace(p, sources=sources, acoustic=replace(p.acoustic, soundSpeedMps=300.0))
    return replace(p, resource_plan_digest=c.resource_digest(p))


def exact_budget(required):
    return ResourceBudget(
        required.logical_bytes, required.graphics_color_bytes, required.storage_bytes
    )


class ResourceControls(unittest.TestCase):
    def test_complete_maximum_and_134_sample_boundary_use_independent_oracles(self):
        p, binding = maximum_plan(), new_binding()
        r = composition_resources(p, binding)
        self.assertEqual(
            r.host_original_bytes, 4 * 3 * (1280**2 * 4 + 320**2 * 4) + 4 * 400 * 8
        )
        self.assertEqual(
            r.maximum_batch_bytes, 4 * (1280**2 * 4 + 320**2 * 4 + 134 * 8)
        )
        self.assertEqual(r.payload_count, 36)
        self.assertEqual(r.chunk_count, 2568)
        self.assertEqual(r.normal_exchanges, 5296)
        self.assertEqual(r.maximum_exchanges, 5298)
        self.assertEqual(r.graphics_color_bytes, 4 * (1280**2 * 4 + 320**2 * 16))
        self.assertEqual(r.capture_storage_bytes, 0)
        self.assertFalse(r.opaque_runtime_memory_bound)
        self.assertFalse(r.physical_reservation)

    def test_exact_minus_and_plus_logical_and_graphics_limits(self):
        p, binding = maximum_plan(), new_binding()
        required = composition_resources(p, binding)
        exact = exact_budget(required)
        admitted = admit_composition(p, binding, exact)
        recheck_admission(p, binding, admitted)
        for name in ("logical_bytes", "graphics_color_bytes"):
            with self.subTest(name=name):
                with self.assertRaises(w.ModularError):
                    admit_composition(
                        p, binding, replace(exact, **{name: getattr(exact, name) - 1})
                    )
                admit_composition(
                    p, binding, replace(exact, **{name: getattr(exact, name) + 1})
                )

    def test_zero_sources_and_sparse_due_ticks_never_import_capture(self):
        original_import = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name.startswith("prisoma"):
                self.fail("unselected transcript imported")
            return original_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", guarded):
            p = plan(ticks=3)
            r = composition_resources(p, new_binding())
            self.assertEqual(
                (r.payload_count, r.host_original_bytes, r.normal_exchanges), (0, 0, 16)
            )
            p = plan(ticks=3, modalities=("pressure",))
            p = replace(p, sources=(replace(p.sources[0], publication_period_ticks=3),))
            p = replace(p, resource_plan_digest=c.resource_digest(p))
            r = composition_resources(p, new_binding())
            self.assertEqual((r.payload_count, r.host_original_bytes), (1, 134 * 8))

    def test_forged_values_and_boolean_integer_aliases_never_authorize(self):
        p, binding = plan(ticks=1), new_binding()
        r = composition_resources(p, binding)
        a = admit_composition(p, binding, exact_budget(r))
        for field in fields(r):
            with self.subTest(field=field.name):
                value = getattr(r, field.name)
                forged = replace(
                    r,
                    **{
                        field.name: 0
                        if type(value) is bool
                        else False
                        if value == 0
                        else value + 1
                    },
                )
                with self.assertRaises(w.ModularError):
                    recheck_admission(p, binding, replace(a, resources=forged))
        for forged in (
            replace(a, capture=0),
            replace(a, prepare_digest="f" * 64),
            replace(a, binding=new_binding()),
            replace(a, budget=replace(a.budget, storage_bytes=False)),
        ):
            with self.assertRaises(w.ModularError):
                recheck_admission(p, binding, forged)
        recheck_admission(p, binding, a)

    def test_late_invalid_rosters_reject_instead_of_trusting_resource_digest(self):
        p, binding = maximum_plan(), new_binding()
        for invalid in (
            replace(
                p, sources=p.sources[:-1] + (replace(p.sources[-1], entity_index=256),)
            ),
            replace(
                p,
                sources=p.sources[:-1]
                + (replace(p.sources[-1], source_id=p.sources[0].source_id),),
            ),
            replace(
                p,
                world=replace(
                    p.world,
                    entity_ids=p.world.entity_ids[:-1] + (p.world.entity_ids[0],),
                ),
            ),
            replace(p, resource_plan_digest="0" * 64),
        ):
            with self.assertRaises(w.ModularError):
                composition_resources(invalid, binding)
        composition_resources(p, binding)

    def test_actual_prepare_frame_capacity_is_independent_of_count_admission(self):
        p = plan(
            256,
            ticks=1,
            solids=64,
            long_ids=True,
            modalities=("rgb",) * 4 + ("thermal",) * 4 + ("pressure",) * 4,
        )
        # Legal finite coordinates with full decimal encodings exhaust the
        # real outer frame while retaining the admitted entity/source counts.
        p = replace(
            p,
            world=replace(
                p.world,
                initial_positions=tuple(
                    (
                        x + 0.123456789012345,
                        y + 0.234567890123456,
                        z + 0.345678901234567,
                    )
                    for x, y, z in p.world.initial_positions
                ),
                controller_references=tuple(
                    (y + 0.234567890123456, 0.123456789012345)
                    for y, _ in p.world.controller_references
                ),
            ),
        )
        p = replace(
            p,
            scene=replace(
                p.scene,
                materials=tuple(
                    replace(p.scene.materials[0], id=f"m{i:02}".ljust(64, "x"))
                    for i in range(16)
                ),
                solids=tuple(
                    replace(
                        solid,
                        center=tuple(
                            value + 0.123456789012345 for value in solid.center
                        ),
                        half_extents=(2.123456789012345,) * 3,
                        yaw=0.123456789012345,
                        friction=0.123456789012345,
                        restitution=0.123456789012345,
                    )
                    for solid in p.scene.solids
                ),
            ),
        )
        p = replace(p, resource_plan_digest=c.resource_digest(p))
        binding = new_binding()
        # Select the first independently shape-admitted geometry extent below
        # the payload bound. The public envelope must still reject this extent.
        for count in range(64, -1, -1):
            candidate = replace(
                p, scene=replace(p.scene, solids=p.scene.solids[:count])
            )
            try:
                CityContract.check_input(w.Prepare(candidate))
            except w.ModularError:
                continue
            p = candidate
            break
        else:
            self.fail("no admitted application payload")
        with self.assertRaises(w.ModularError):
            Client(binding, CityContract).begin(w.Prepare(p))
        with self.assertRaises(w.ModularError):
            composition_resources(p, binding)
        self.assertLess(
            len(Client(binding, CityContract).begin(w.Prepare(maximum_plan()))),
            w.FRAME_BYTES,
        )

    def test_unimplemented_canonical_experiment_rejects_before_optional_import(self):
        p, binding = plan(), new_binding()
        composition_resources(p, binding, canonical_experiment=False)
        with self.assertRaisesRegex(w.ModularError, "unsupported_canonical_experiment"):
            composition_resources(p, binding, canonical_experiment=True)

    def test_named_native_encoding_extents_match_owning_source(self):
        source = (
            Path(__file__).resolve().parents[3]
            / "src/environment/CitySourceContract.ts"
        ).read_text()
        self.assertIn("export const CITY_PLAN_BYTES = 512 * 1024", source)
        self.assertIn("export const CITY_GRAPHICS_INPUT_BYTES = 128 * 1024", source)
        self.assertEqual(
            (NATIVE_PLAN_BYTES, GRAPHICS_INPUT_BYTES), (512 * 1024, 128 * 1024)
        )


if __name__ == "__main__":
    unittest.main()
