from dataclasses import FrozenInstanceError, replace
import math
import struct
import unittest

from ncp_local import modular_owner as o, modular_wire as w
from ncp_local.modular_buffer import BufferPool, TrustedHostCreationContext
from ncp_local.modular_client import Client

from crebain_ncp_sensors import codec as c, types as t
from crebain_ncp_sensors.contract import SensorContract
from fixtures import binding, owner, payload, plan, prepared, seal, target, tensor


class CodecTests(unittest.TestCase):
    def assert_rejected(self, function, *args):
        with self.assertRaises((ValueError, TypeError)):
            function(*args)

    def test_frozen_descriptor_and_plan_join(self):
        requested = plan()
        result = prepared(requested)
        c.validate_prepared(requested, result, binding())
        for field in ("run_id", "generation", "application_digest"):
            altered = replace(binding(), **{field: "55555555-5555-4555-8555-555555555555" if field != "application_digest" else "f" * 64})
            if field == "run_id":
                self.assert_rejected(c.validate_prepared, requested, result, altered)
            else:
                # Generation/application joins belong to generic byte manifests.
                self.assertNotEqual(altered, binding())
        self.assert_rejected(c.validate_prepared, requested, replace(result, source_identity="f" * 64), binding())
        with self.assertRaises(FrozenInstanceError):
            requested.planned_ticks = 4

    def test_exact_integer_and_closed_recursive_admission(self):
        value = c.raw(plan())
        for invalid in (True, False, -0.0, 1.0, 0, 7201):
            self.assert_rejected(SensorContract.decode_prepare, {**value, "planned_ticks": invalid})
        for admitted in (1, 7200):
            self.assertEqual(SensorContract.decode_prepare({**value, "planned_ticks": admitted}).planned_ticks, admitted)
        for key in ("path", "runId", "sourceIdentity"):
            invalid = c.raw(plan())
            invalid["specification"][key] = "inert"
            self.assert_rejected(SensorContract.decode_prepare, invalid)
        self.assert_rejected(SensorContract.decode_prepare, {**value, "composition_digest": "f" * 64})
        invalid = c.raw(plan())
        invalid["specification"]["drones"] *= 2
        self.assert_rejected(SensorContract.decode_prepare, invalid)
        invalid = c.raw(plan())
        invalid["specification"]["scene"]["solids"] = [{}]
        self.assert_rejected(SensorContract.decode_prepare, invalid)

    def test_target_limits_wrap_and_signed_zero(self):
        controller = plan().specification.controller
        c.validate_target(target(), controller)
        self.assertLess(math.copysign(1, c.decode("SetTarget", c.raw(target())).roll_rad), 0)
        for field, allowed, rejected in (("roll_rad", 0.1, math.nextafter(0.1, math.inf)),
                                         ("pitch_rad", -0.1, math.nextafter(-0.1, -math.inf)),
                                         ("altitude_m", 8.5, math.nextafter(8.5, math.inf)),
                                         ("heading_rad", 0.199, 0.201)):
            c.validate_target(replace(target(), **{field: allowed}), controller)
            self.assert_rejected(c.validate_target, replace(target(), **{field: rejected}), controller)
        c.validate_target(replace(target(), heading_rad=-math.pi + 0.05), replace(controller, referenceHeadingRad=math.pi - 0.05))
        for invalid in (True, float("nan"), float("inf"), -float("inf")):
            self.assert_rejected(c.validate_target, replace(target(), roll_rad=invalid), controller)
        self.assertFalse(c.equal_bits(target(), replace(target(), roll_rad=0.0)))

    def test_catalog_configuration_order_identity_and_units_are_bound(self):
        requested = plan()
        result = prepared(requested)
        c.validate_prepared(requested, result, binding())
        entries = result.sensor_catalog.entries
        variants = (entries[::-1], (entries[0], entries[0], entries[2]),
                    (replace(entries[0], sensor_id="thermal:rgb-a"), *entries[1:]),
                    (replace(entries[0], configuration=replace(entries[0].configuration, fovDegrees=61)), *entries[1:]),
                    (*entries[:2], replace(entries[2], configuration=replace(entries[2].configuration, position=(0, 2, 11)))))
        for variant in variants:
            changed = replace(result, sensor_catalog=seal("catalog", replace(result.sensor_catalog, entries=variant)))
            self.assert_rejected(c.validate_prepared, requested, changed, binding())

    def test_specification_relational_negatives(self):
        requested = plan()
        camera = requested.specification.scene.rgbCameras[0]
        for cameras in ((camera, camera), (replace(camera, target=camera.position),)):
            changed = replace(requested, specification=replace(requested.specification,
                scene=replace(requested.specification.scene, rgbCameras=cameras)))
            self.assert_rejected(SensorContract.decode_prepare, c.raw(changed))
        changed = replace(requested, specification=replace(requested.specification,
            scene=replace(requested.specification.scene, thermalCameras=(replace(camera, width=321),))))
        self.assert_rejected(SensorContract.decode_prepare, c.raw(changed))

    def test_source_owned_sorted_rosters_and_acoustic_distance_bounds(self):
        requested = plan()
        for field in ("materials", "rgbCameras", "thermalCameras", "microphones"):
            first = getattr(requested.specification.scene, field)[0]
            second = replace(first, id=first.id + "-z")
            for rows, accepted in (((first, second), True), ((second, first), False)):
                changed = replace(requested, specification=replace(requested.specification,
                    scene=replace(requested.specification.scene, **{field: rows})))
                if accepted:
                    admitted = SensorContract.decode_prepare(c.raw(changed))
                    c.validate_prepared(admitted, prepared(admitted), binding())
                else:
                    self.assert_rejected(SensorContract.decode_prepare, c.raw(changed))
        for distance, accepted in ((32.0, True), (math.nextafter(32.0, math.inf), False)):
            changed = replace(requested, specification=replace(requested.specification,
                acoustic=replace(requested.specification.acoustic, referenceDistanceM=distance)))
            if accepted:
                SensorContract.decode_prepare(c.raw(changed))
            else:
                self.assert_rejected(SensorContract.decode_prepare, c.raw(changed))

    def reading(self, kind, data=None):
        entry = next(entry for entry in prepared(plan()).sensor_catalog.entries if entry.kind == kind)
        shape = tensor(entry, 3)
        data = payload(shape) if data is None else data
        pool = BufferPool(binding(), tuple(sorted(c.SENSOR_DIGESTS.values())))
        manifest = pool.publish(TrustedHostCreationContext(binding(), "c" * 64, "d" * 64), entry.sensor_contract_digest, data)
        typed = seal("manifest", t.SensorManifest("crebain.sensor-manifest.v1", entry.sensor_contract_digest,
            entry.sensor_id, manifest.manifest_digest, "e" * 64, 3, 3, shape, ""))
        return typed, manifest, data

    def test_dense_rgba_layout_and_bit_preservation(self):
        typed, manifest, data = self.reading("rgba8")
        reading = c.validate_payload(typed, manifest, data)
        self.assertIs(reading.payload, data)
        self.assertEqual(reading.payload, bytes(range(256)))
        self.assertEqual(reading.payload[(3 * 8 + 2) * 4 + 1], 105)
        for field, value in (("row_origin", "top-left"), ("encoding", "rgb-linear"), ("dtype", "f32le"), ("shape", (8, 8, 3))):
            self.assert_rejected(c.validate_payload, replace(typed, tensor=replace(typed.tensor, **{field: value})), manifest, data)
        self.assert_rejected(c.validate_payload, typed, manifest, data[:-1])
        self.assert_rejected(c.validate_payload, typed, manifest, bytes([255]) + data[1:])

    def test_float_payloads_preserve_subnormals_signed_zero_and_f64_range(self):
        for kind, fmt, width in (("radiance", "<f", 4), ("pressure", "<d", 8)):
            typed, manifest, data = self.reading(kind)
            reading = c.validate_payload(typed, manifest, data)
            self.assertEqual(reading.payload, data)
            self.assertEqual(struct.unpack(fmt, data[:width])[0], 0)
            self.assertLess(math.copysign(1, struct.unpack(fmt, data[:width])[0]), 0)
            self.assertNotEqual(struct.unpack(fmt, data[2 * width:3 * width])[0], 0)
        typed, manifest, data = self.reading("pressure")
        self.assertGreater(struct.unpack("<d", data[24:32])[0], 1e300)
        c.validate_payload(typed, manifest, data)

    def test_nonfinite_and_radiance_range_rejected_after_valid_hash(self):
        for kind, fmt in (("radiance", "<f"), ("pressure", "<d")):
            typed, _, original = self.reading(kind)
            for number in (float("nan"), float("inf"), -float("inf")):
                encoded = struct.pack(fmt, number)
                changed = encoded + original[len(encoded):]
                typed, manifest, data = self.reading(kind, changed)
                self.assert_rejected(c.validate_payload, typed, manifest, data)
        _, _, original = self.reading("radiance")
        for number in (-2**-149, 10000.0009765625):
            typed, manifest, data = self.reading("radiance", struct.pack("<f", number) + original[4:])
            self.assert_rejected(c.validate_payload, typed, manifest, data)
        typed, manifest, data = self.reading("pressure", struct.pack("<d", -1.7976931348623157e308) + self.reading("pressure")[2][8:])
        c.validate_payload(typed, manifest, data)

    def advanced(self, tick=1, ticks=3):
        host, _ = owner()
        client = Client(binding(), SensorContract)
        requested = plan(ticks)
        result = client.observe(host.process(client.begin(w.Prepare(requested)))).body.data
        client.observe_acknowledgement(host.process(client.acknowledgement()))
        last = accepted = None
        for current in range(1, tick + 1):
            command = t.Command("advance_tick", current, last, target() if current == 1 else t.Hold("hold", accepted), t.CaptureReservation())
            request = w.Request.decode(client.begin(w.Application(command)), binding(), SensorContract)
            response = client.observe(host.process(client.pending_request))
            advanced = response.body.data
            context = o.ExecutionContext(binding(), request.sequence, request.request_digest, request.command.expected_predecessor_result_digest)
            accepted, last = advanced.accepted_action_request_digest, advanced.batch.batch_digest
            client.observe_acknowledgement(host.process(client.acknowledgement()))
            for slot in advanced.batch.slots:
                if type(slot) is t.Due:
                    client.observe(host.process(client.begin(w.Release(slot.byte_manifest.reference()))))
                    client.observe_acknowledgement(host.process(client.acknowledgement()))
        return requested, result, command, advanced, context

    def test_batch_clock_horizon_and_pressure_intervals(self):
        for tick, length in ((1, 133), (2, 133), (3, 134)):
            requested, result, command, advanced, context = self.advanced(tick)
            c.validate_batch(requested, result, command, advanced)
            pressure = advanced.batch.slots[2]
            self.assertEqual(pressure.typed_manifest.tensor.shape, (length,))
            shifted = replace(pressure.typed_manifest.tensor, sample_start=1 + pressure.typed_manifest.tensor.sample_start,
                              sample_end=1 + pressure.typed_manifest.tensor.sample_end)
            slot = replace(pressure, typed_manifest=seal("manifest", replace(pressure.typed_manifest, tensor=shifted)))
            changed = replace(advanced, batch=seal("batch", replace(advanced.batch, slots=(*advanced.batch.slots[:2], slot))))
            c.validate_batch_envelope(changed.batch, context)  # Valid bytes/digests; wrong causal clock.
            self.assert_rejected(c.validate_batch, requested, result, command, changed)
        requested, result, command, advanced, _ = self.advanced(1, 1)
        self.assertTrue(all(slot.next_due_tick is None for slot in advanced.batch.slots[:2]))
        changed = replace(advanced, batch=seal("batch", replace(advanced.batch,
            slots=(replace(advanced.batch.slots[0], next_due_tick=2), *advanced.batch.slots[1:]))))
        self.assert_rejected(c.validate_batch, requested, result, command, changed)

    def test_manifest_creation_generation_and_three_predecessors_are_distinct(self):
        requested, result, command, advanced, context = self.advanced(3)
        c.validate_batch_envelope(advanced.batch, context)
        self.assertNotEqual(context.predecessor, command.previous_batch_digest)
        self.assertNotEqual(advanced.accepted_action_request_digest, context.request_digest)
        for altered in (replace(context, request_digest="f" * 64), replace(context, predecessor=command.previous_batch_digest),
                        replace(context, binding=replace(binding(), generation="55555555-5555-4555-8555-555555555555"))):
            self.assert_rejected(c.validate_batch_envelope, advanced.batch, altered)
        for field in ("source_identity", "scene_sha256", "plan_digest", "previous_batch_digest"):
            changed = replace(advanced, batch=seal("batch", replace(advanced.batch, **{field: "f" * 64})))
            self.assert_rejected(c.validate_batch, requested, result, command, changed)
        slots = advanced.batch.slots
        changed = seal("batch", replace(advanced.batch, slots=(replace(slots[0], sensor_id=slots[2].sensor_id), *slots[1:])))
        self.assert_rejected(c.validate_batch_envelope, changed, context)

    def test_uninhabited_imports_and_capture_role(self):
        for method in (SensorContract.decode_import, SensorContract.decode_metadata, SensorContract.decode_imported):
            self.assert_rejected(method, {})
        command = c.raw(t.Command("advance_tick", 1, None, target(), t.CaptureReservation()))
        command["capture_reservation"] = {"kind": "reserved"}
        self.assert_rejected(SensorContract.decode_command, command)
        self.assertFalse(SensorContract.allows(w.Name.IMPORT))

    def test_every_admitted_tick_has_nonempty_pressure_payload(self):
        requested, result, command, advanced, context = self.advanced(1)
        self.assertEqual([slot.kind for slot in advanced.batch.slots], ["not_due", "not_due", "due"])
        c.validate_batch_envelope(advanced.batch, context)
        c.validate_batch(requested, result, command, advanced)
        raw = c.raw(requested)
        raw["specification"]["scene"]["microphones"] = []
        self.assert_rejected(SensorContract.decode_prepare, raw)
        pressure = advanced.batch.slots[2]
        absent = t.NotDue("not_due", pressure.sensor_id, None)
        changed = replace(advanced, batch=seal("batch", replace(advanced.batch, slots=(*advanced.batch.slots[:2], absent))))
        c.validate_batch_envelope(changed.batch, context)
        self.assert_rejected(c.validate_batch, requested, result, command, changed)
        for field in ("byte_length", "chunk_count"):
            invalid = replace(pressure, byte_manifest=replace(pressure.byte_manifest, **{field: 0}))
            batch = seal("batch", replace(advanced.batch, slots=(*advanced.batch.slots[:2], invalid)))
            self.assert_rejected(c.validate_batch_envelope, batch, context)

    def test_fixed_digest_tags_match_the_shared_commitments(self):
        from fixtures import CONTRACTS
        committed = w.parse((CONTRACTS / "commitments.v1.json").read_bytes())
        self.assertEqual(committed["application_digest"], c.APPLICATION_DIGEST)
        self.assertEqual(committed["composition_digest"], c.COMPOSITION_DIGEST)
        self.assertEqual(committed["sensor_contract_digests"], c.SENSOR_DIGESTS)
        self.assertFalse(committed["new_generic_digest_domains"])
        for kind, discriminator in committed["discriminators"].items():
            key = committed["self_digest_fields"][kind]
            value = {"number": -0.0, "text": "source"}
            if key:
                value[key] = "f" * 64
            expected = w.typed_digest(w.PROFILE_DOMAIN, {"schema": discriminator, "value": {name: item for name, item in value.items() if name != key}})
            self.assertEqual(c.commitment(kind, value), expected)
            changed = {**value, "number": 0.0}
            self.assertNotEqual(c.commitment(kind, value), c.commitment(kind, changed))

    def test_integral_continuous_tokens_share_commitments_but_negative_zero_does_not(self):
        from numeric_parity import vectors
        integer, floating, negative_zero = vectors()["cases"]
        for field in ("plan_digest", "catalog_digest"):
            self.assertEqual(integer[field], floating[field])
            self.assertNotEqual(integer[field], negative_zero[field])
        self.assertIs(type(integer["prepare"]["specification"]["controller"]["referenceHeadingRad"]), int)
        self.assertIs(type(floating["prepare"]["specification"]["controller"]["referenceHeadingRad"]), float)
        invalid = c.raw(plan())
        invalid["planned_ticks"] = 3.0
        self.assert_rejected(SensorContract.decode_prepare, invalid)


if __name__ == "__main__":
    unittest.main()
