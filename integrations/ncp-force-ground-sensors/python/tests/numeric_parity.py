"""Application numeric vectors for independent Rust/Python commitment checks."""

import json

from crebain_ncp_sensors import codec as c
from crebain_ncp_sensors.contract import SensorContract
from fixtures import binding, plan, prepared


def vectors():
    cases = []
    for name, zero, altitude in (("integral_tokens", 0, 8), ("float_tokens", 0.0, 8.0),
                                 ("negative_zero", -0.0, 8.0)):
        value = c.raw(plan())
        value["specification"]["controller"]["referenceHeadingRad"] = zero
        value["specification"]["controller"]["referenceAltitudeM"] = altitude
        value["specification"]["scene"]["rgbCameras"][0]["position"][0] = zero
        admitted = SensorContract.decode_prepare(value)
        result = prepared(admitted)
        cases.append({"name": name, "prepare": c.raw(admitted), "source_identity": result.source_identity,
                      "plan_digest": result.plan_digest, "catalog_digest": result.sensor_catalog.catalog_digest,
                      "catalog": c.raw(result.sensor_catalog)})
    return {"schema": "crebain.python-numeric-parity-controls.v1", "scope": "synthetic commitment vectors; no engine observation",
            "binding": c.raw(binding()), "cases": cases}


if __name__ == "__main__":
    print(json.dumps(vectors(), allow_nan=False, indent=2))
