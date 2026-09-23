"""Declared deterministic construction fixtures; no runtime or scientific qualification."""

from dataclasses import replace
from crebain_ncp_sensors.city import codec as c


def plan(entities=1, *, ticks=2, modalities=(), solids=0, long_ids=False):
    def identity(prefix, index):
        value = f"{prefix}{index:03}"
        return value.ljust(64, "x") if long_ids else value

    sources = []
    for i, kind in enumerate(modalities):
        row = {
            "request_id": identity("r", i),
            "source_id": identity("s", i),
            "entity_index": i % entities,
            "scope": "entity_requested_world_fixed",
            "position": [0.0, 50.0, float(i)],
            "publication_period_ticks": 1,
            "kind": kind,
        }
        if kind == "pressure":
            row.update(
                sample_rate_hz=16000,
                observation_model="crebain.discrete-direct-acoustic.v1",
            )
        else:
            row.update(
                target=[1.0, 50.0, 0.0],
                width=8,
                height=8,
                fov_degrees=90.0,
                rendering_mode="mesh_and_authored_gaussians"
                if kind == "rgb"
                else "bolometric_mesh",
            )
        sources.append(row)
    value = {
        "schema": "crebain.force-city-prepare.v1",
        "composition_digest": c.COMPOSITION_DIGEST,
        "resource_plan_digest": "0" * 64,
        "world": {
            "profile": "crebain.rapier-force-city.v1",
            "engine_model": "rapier-0.19.3-observed-no-gyro-v1",
            "frame": "three-y-up-z-forward-m",
            "horizon_ticks": ticks,
            "action_budget": 4096,
            "entity_ids": [identity("d", i) for i in range(entities)],
            "initial_positions": [
                [12.0 * (i % 16) - 90.0, 50.0 + float(i % 3), 12.0 * (i // 16) - 90.0]
                for i in range(entities)
            ],
            "controller_references": [
                [50.0 + float(i % 3), 0.0] for i in range(entities)
            ],
        },
        "scene": {
            "id": "city",
            "materials": [
                {
                    "id": "material",
                    "linearRgb": [0.5, 0.5, 0.5],
                    "gaussianOpacity": 0.5,
                    "temperatureK": 300.0,
                    "emissivity": 0.8,
                }
            ],
            "solids": [
                {
                    "id": identity("b", i),
                    "center": [12.0 * (i % 8) - 42.0, 2.0, 12.0 * (i // 8) - 42.0],
                    "half_extents": [2.0, 2.0, 2.0],
                    "yaw": 0.0,
                    "friction": 0.7,
                    "restitution": 0.0,
                    "material_index": 0,
                }
                for i in range(solids)
            ],
        },
        "sources": sources,
    }
    if "pressure" in modalities:
        value["acoustic"] = {
            "profile": "crebain.discrete-direct-acoustic.v1",
            "sampleRateHz": 16000,
            "soundSpeedMps": 343.0,
            "maximumRangeM": 128.0,
            "referenceDistanceM": 1.0,
            "referencePressurePa": 0.01,
            "bladeCount": 2,
            "blockedGain": 0.2,
            "noiseStdPa": 0.0,
            "seed": 42,
        }
    if "thermal" in modalities:
        value["thermal"] = {
            "profile": "crebain.lumped-gray-thermal.v1",
            "ambientK": 293.0,
            "initialK": 293.0,
            "capacityJPerK": 100.0,
            "areaM2": 0.1,
            "convectionWPerM2K": 10.0,
            "emissivity": 0.8,
            "motorEfficiency": 0.8,
        }
    result = c.decode("Prepare", value)
    return replace(result, resource_plan_digest=c.resource_digest(result))


def set_rows(p):
    return tuple(
        (i, "set", True, (0.03 if i % 2 else -0.03, 0.0, reference[1], reference[0]))
        for i, reference in enumerate(p.world.controller_references)
    )
