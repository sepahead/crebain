"""Synthetic protocol controls only. This fixture runs no CREBAIN simulation."""

from dataclasses import replace
import hashlib
from pathlib import Path
import struct

from ncp_local import modular_owner as o, modular_wire as w
from ncp_local.modular_buffer import BufferBinding, OutputSpec

from crebain_ncp_sensors import codec as c, types as t
from crebain_ncp_sensors.contract import SensorContract

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"


def binding():
    return BufferBinding(o.profile_digest(), c.APPLICATION_DIGEST,
                         "11111111-1111-4111-8111-111111111111",
                         "22222222-2222-4222-8222-222222222222",
                         "33333333-3333-4333-8333-333333333333")


def plan(ticks=3, small=True):
    workload = w.parse((CONTRACTS / "m1.workload.v1.json").read_bytes())
    spec = workload["specification"]
    if small:
        for camera in spec["scene"]["rgbCameras"] + spec["scene"]["thermalCameras"]:
            camera["width"] = camera["height"] = 8
    return SensorContract.decode_prepare({"specification": spec, "planned_ticks": ticks,
                                          "composition_digest": c.COMPOSITION_DIGEST})


def target(pitch=0.0):
    return t.SetTarget("set_target", True, -0.0, pitch, 0.0, 8.0)


def seal(kind, value):
    return replace(value, **{f"{kind}_digest": c.commitment(kind, c.raw(value))})


def prepared(prepare, selected_binding=None):
    selected_binding = selected_binding or binding()
    source = "a" * 64
    digest = c.commitment("plan", {**c.raw(prepare), "engine_run_id": "ncp-" + selected_binding.run_id,
                                    "source_identity": source})
    catalog = seal("catalog", t.SensorCatalog("crebain.sensor-catalog.v1", digest,
                                              c.expected_catalog(prepare.specification), ""))
    return t.Prepared("prepared", digest, catalog, "not_acquired", source,
                      "44444444-4444-4444-8444-444444444444", "b" * 64)


def tensor(entry, tick):
    if entry.kind == "rgba8":
        return t.RgbaTensor("rgba8", "u8", (entry.configuration.height, entry.configuration.width, 4),
                            "c_contiguous", "bottom-left", "rgba8-srgb")
    if entry.kind == "radiance":
        return t.RadianceTensor("radiance", "f32le", (entry.configuration.height, entry.configuration.width),
                                "c_contiguous", "bottom-left", "W/(m2 sr)")
    start, end = (tick - 1) * 16000 // 120, tick * 16000 // 120
    return t.PressureTensor("pressure", "f64le", (end - start,), "c_contiguous", start, end, 16000, "pascal")


def payload(tensor):
    size = c.tensor_bytes(tensor)
    if tensor.kind == "rgba8":
        return bytes(range(256)) * (size // 256) + bytes(range(size % 256))
    pattern = struct.pack("<dddd", -0.0, 0.0, -5e-324, 1.7976931348623157e308) if tensor.kind == "pressure" else struct.pack("<ffff", -0.0, 0.0, 2**-149, 10000.0)
    return (pattern * ((size + len(pattern) - 1) // len(pattern)))[:size]


class SyntheticSensors(SensorContract):
    """Test-only output owner, with explicit application lifetime checks."""

    def __init__(self):
        self.prepare = self.prepared = None
        self.tick = 0
        self.last = self.accepted = None
        self.advances = 0
        self.finished = False
        self.fail_tick = None

    def due(self, tick):
        return tuple(entry for entry in self.prepared.sensor_catalog.entries
                     if entry.kind == "pressure" or tick % entry.configuration.periodTicks == 0)

    def admit(self, operation, view):
        if type(operation) is w.Application:
            command = operation.data
            if view.buffers.live_slots or command.tick != self.tick + 1 or command.previous_batch_digest != self.last:
                raise o.AdmissionError(w.Code.STATE)
            if command.tick > self.prepare.planned_ticks:
                raise o.AdmissionError(w.Code.INVALID)
            if type(command.action) is t.Hold and command.action.accepted_action_request_digest != self.accepted:
                raise o.AdmissionError(w.Code.INVALID)
            return o.AdmissionDemand(outputs=tuple(OutputSpec(entry.sensor_contract_digest, c.tensor_bytes(tensor(entry, command.tick))) for entry in self.due(command.tick)))
        if type(operation) is w.Finish:
            if view.buffers.live_slots or self.tick != self.prepare.planned_ticks or operation.data.last_batch_digest != self.last:
                raise o.AdmissionError(w.Code.STATE)
        return o.AdmissionDemand()

    def execute(self, operation, permit):
        if type(operation) is w.Prepare:
            self.prepare = operation.data
            self.prepared = prepared(self.prepare, permit.context.binding)
            return o.ApplicationResult(self.prepared)
        if type(operation) is w.Application:
            self.advances += 1
            if operation.data.tick == self.fail_tick:
                raise o.ExecutionError("backend")
            self.tick = operation.data.tick
            if type(operation.data.action) is t.SetTarget:
                self.accepted = permit.context.request_digest
            digest = hashlib.sha256(f"synthetic-test-only-{self.tick}".encode()).hexdigest()
            slots, index = [], 0
            for entry in self.prepared.sensor_catalog.entries:
                if entry not in self.due(self.tick):
                    next_tick = (self.tick // entry.configuration.periodTicks + 1) * entry.configuration.periodTicks
                    slots.append(t.NotDue("not_due", entry.sensor_id, next_tick if next_tick <= self.prepare.planned_ticks else None))
                    continue
                shape = tensor(entry, self.tick)
                data = payload(shape)
                for offset in range(0, len(data), 32768):
                    permit.write_output(index, offset, data[offset:offset + 32768])
                byte_manifest = permit.seal_output(index)
                index += 1
                typed = seal("manifest", t.SensorManifest("crebain.sensor-manifest.v1", entry.sensor_contract_digest,
                    entry.sensor_id, byte_manifest.manifest_digest, digest, self.tick, self.tick, shape, ""))
                slots.append(t.Due("due", entry.sensor_id, typed, byte_manifest))
            batch = seal("batch", t.SensorBatch("crebain.sensor-batch.v1", self.prepared.plan_digest,
                self.prepared.engine_owner_id, digest, self.prepared.source_identity, self.prepared.scene_sha256,
                self.tick, self.last, tuple(slots), ""))
            self.last = batch.batch_digest
            return o.ApplicationResult(t.Advanced("advanced", self.tick, self.accepted, batch))
        if type(operation) is w.Finish:
            self.finished = True
            return o.TerminalResult(t.Terminal(self.prepared.plan_digest, self.prepare.planned_ticks, self.tick,
                self.last, "confirmed", "complete", False))
        if type(operation) is w.Abort:
            return o.AbortedResult()
        raise AssertionError("generic operation reached synthetic application")


def owner():
    application = SyntheticSensors()
    return o.Owner(binding(), application, tuple(sorted(c.SENSOR_DIGESTS.values()))), application
