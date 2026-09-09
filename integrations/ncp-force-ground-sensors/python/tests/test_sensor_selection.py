"""Selected sensor rosters through real NCP framing and a synthetic producer."""

from dataclasses import replace
import time
import unittest

from crebain_ncp_sensors import SensorSession, codec as c
from crebain_ncp_sensors.contract import SensorContract
from ncp_local import modular_wire as w

from fixtures import binding, owner, plan, target
from test_client import channel


def selected(rgb, thermal, microphones):
    original = plan(ticks=6)
    scene = original.specification.scene
    rosters = {}
    for field, count in (("rgbCameras", rgb), ("thermalCameras", thermal), ("microphones", microphones)):
        first = getattr(scene, field)[0]
        rosters[field] = tuple(replace(first, id=f"source-{index}") for index in range(count))
    return replace(original, specification=replace(original.specification, scene=replace(scene, **rosters)))


class SensorSelectionTests(unittest.TestCase):
    def test_each_nonempty_modality_subset_completes_without_absent_payloads(self):
        for mask in range(1, 8):
            counts = tuple(int(bool(mask & (1 << bit))) for bit in range(3))
            with self.subTest(counts=counts):
                requested = selected(*counts)
                host, application = owner()
                observed = {"rgba8": 0, "radiance": 0, "pressure": 0}
                with channel(host) as stream, SensorSession(
                    stream, stream, binding(), requested, deadline=time.monotonic() + 10
                ) as session:
                    for tick in range(1, 7):
                        with session.advance(target() if tick == 1 else None) as pending:
                            batch = pending.observation
                            self.assertEqual(len(batch.batch.slots), sum(counts))
                            for reading in batch.readings:
                                observed[reading.manifest.tensor.kind] += 1
                        self.assertEqual(host.usage.live_slots, 0)
                    result = session.finish()
                self.assertEqual(tuple(observed.values()), tuple(a * b for a, b in zip(counts, (3, 2, 6))))
                self.assertEqual(result.terminal.completed_ticks, 6)
                self.assertTrue(application.finished)

    def test_two_cameras_retain_distinct_ids_and_independent_capture_periods(self):
        requested = selected(2, 0, 1)
        scene = requested.specification.scene
        requested = replace(requested, specification=replace(requested.specification,
            scene=replace(scene, rgbCameras=(scene.rgbCameras[0], replace(scene.rgbCameras[1], periodTicks=3)))))
        expected = (
            ("pressure:source-0",),
            ("rgb:source-0", "pressure:source-0"),
            ("rgb:source-1", "pressure:source-0"),
            ("rgb:source-0", "pressure:source-0"),
            ("pressure:source-0",),
            ("rgb:source-0", "rgb:source-1", "pressure:source-0"),
        )
        host, _ = owner()
        with channel(host) as stream, SensorSession(
            stream, stream, binding(), requested, deadline=time.monotonic() + 10
        ) as session:
            for tick, ids in enumerate(expected, 1):
                with session.advance(target() if tick == 1 else None) as pending:
                    self.assertEqual(tuple(reading.manifest.sensor_id for reading in pending.observation.readings), ids)
            self.assertEqual(session.finish().payload_count, 11)
        duplicate = replace(scene, rgbCameras=(scene.rgbCameras[0], scene.rgbCameras[0]))
        with self.assertRaises(w.ModularError):
            SensorContract.decode_prepare(c.raw(replace(requested, specification=replace(requested.specification, scene=duplicate))))

    def test_admission_rejects_empty_oversized_and_unknown_rosters(self):
        for counts in ((0, 0, 0), (5, 0, 0), (0, 5, 0), (0, 0, 5)):
            with self.subTest(counts=counts), self.assertRaises(w.ModularError):
                SensorContract.decode_prepare(c.raw(selected(*counts)))
        for counts in ((1, 0, 0), (4, 0, 0), (0, 4, 0), (0, 0, 4), (2, 1, 1)):
            self.assertEqual(SensorContract.decode_prepare(c.raw(selected(*counts))), selected(*counts))
        unknown = c.raw(selected(1, 0, 1))
        unknown["specification"]["scene"]["radars"] = []
        with self.assertRaises(w.ModularError):
            SensorContract.decode_prepare(unknown)


if __name__ == "__main__":
    unittest.main()
