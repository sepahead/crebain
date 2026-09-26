"""Frozen synthetic public frames; no engine, runtime, or independent outcome oracle."""

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import math

from ncp_local import modular_buffer as b, modular_owner as o, modular_wire as w
from crebain_ncp_sensors.city import codec as c
from crebain_ncp_sensors.city.contract import CityContract
from fixtures import plan, set_rows

RUN = "11111111-1111-4111-8111-111111111111"
ENDPOINT = "22222222-2222-4222-8222-222222222222"
GENERATION = "33333333-3333-4333-8333-333333333333"
OWNER = "44444444-4444-4444-8444-444444444444"
SOURCE = "a" * 64
OTHER = "b" * 64
PREVIOUS = "c" * 64


def binding():
    return b.BufferBinding(
        o.profile_digest(),
        w.typed_digest(w.PROFILE_DOMAIN, w.parse(CityContract.descriptor())),
        RUN,
        ENDPOINT,
        GENERATION,
    )


@dataclass(frozen=True)
class Vector:
    identity: str
    layer: str
    expected: str
    request: bytes
    response: bytes | None = None


def seal(value, field, domain):
    value = deepcopy(value)
    value[field] = w.typed_digest(domain, value, field)
    return w.encode(value)


def request(data, kind="prepare", sequence=1, previous=None):
    return seal(
        {
            "schema": w.REQUEST_SCHEMA,
            "binding": c.raw(binding()),
            "sequence": sequence,
            "command": {
                "kind": "execute",
                "expected_predecessor_result_digest": previous,
                "operation": {"kind": kind, "data": deepcopy(data)},
            },
            "request_digest": "",
        },
        "request_digest",
        w.REQUEST_SCHEMA,
    )


def response(req, data=None, kind="application"):
    r = w.parse(req)
    return seal(
        {
            "schema": w.RESPONSE_SCHEMA,
            "binding": c.raw(binding()),
            "sequence": r["sequence"],
            "operation": r["command"]["operation"]["kind"],
            "request_digest": r["request_digest"],
            "outcome": "committed",
            "code": "ok",
            "body": {
                "kind": kind,
                **({"data": deepcopy(data)} if data is not None else {}),
            },
            "result_digest": "",
        },
        "result_digest",
        w.RESPONSE_SCHEMA,
    )


def replace_token(raw, before, after):
    if raw.count(before) != 1:
        raise AssertionError("lexical mutation must have one location")
    return raw.replace(before, after)


def put(value, path, replacement):
    target = value
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = replacement


def prepared(p):
    return {
        "kind": "prepared",
        "plan_digest": c.commitment(
            "plan", {"prepare": c.raw(p), "run_id": RUN, "source_identity": SOURCE}
        ),
        "roster_digest": c.commitment("roster", c.raw(p.world.entity_ids)),
        "scene_sha256": SOURCE,
        "source_catalog_digest": c.catalog_digest(p),
        "resource_plan_digest": p.resource_plan_digest,
        "source_identity": SOURCE,
        "engine_owner_id": OWNER,
        "native_plan_sha256": SOURCE,
    }


def advance(p, tick=1):
    d = prepared(p)
    return {
        "kind": "advance",
        "plan_digest": d["plan_digest"],
        "roster_digest": d["roster_digest"],
        "tick": tick,
        "previous_batch_digest": None,
        "rows": c.raw(set_rows(p)),
    }


def slot(source, tick=1, status="produced"):
    row = {
        "request_id": source.request_id,
        "source_id": source.source_id,
        "entity_index": source.entity_index,
        "status": status,
    }
    if status == "not_due":
        return {**row, "next_due_tick": 2}
    if status == "failed":
        return {
            **row,
            "attempted_at_tick": tick,
            "reason": "acquisition_failed",
            "diagnostic": "synthetic acquisition failure",
        }
    tensor = c.expected_tensor(source, tick)
    payload = bytes(c.tensor_bytes(tensor))
    return {
        **row,
        "source_config_digest": SOURCE,
        "source_body_tick": tick,
        "available_after_body_tick": tick,
        "source_production_digest": SOURCE,
        "original_payload_sha256": hashlib.sha256(payload).hexdigest(),
        "byte_length": len(payload),
        "tensor": c.raw(tensor),
    }


def batch(p, slots, tick=1):
    d = prepared(p)
    result = {
        key: d[key]
        for key in (
            "plan_digest",
            "roster_digest",
            "scene_sha256",
            "source_catalog_digest",
        )
    }
    result.update(
        tick=tick,
        previous_batch_digest=None,
        control={
            "tick": tick,
            "execution": "known_completed",
            "before_state_sha256": SOURCE,
            "after_state_sha256": OTHER,
            "native_transition_sha256": SOURCE,
            "all_motor_assignments_completed": True,
            "rows": [[i, SOURCE, "set", True] for i in range(len(p.world.entity_ids))],
        },
        slots=deepcopy(slots),
        batch_digest="",
    )
    result["batch_digest"] = c.commitment("batch", result)
    return result


def advanced_pair(p, statuses=(), *, failed=False, tick=1):
    req = request(advance(p, tick), "application", previous=PREVIOUS)
    data = {
        "kind": "advance_failed" if failed else "advanced",
        "batch": batch(
            p,
            [
                slot(s, tick, status)
                for s, status in zip(p.sources, statuses, strict=True)
            ],
            tick,
        ),
    }
    if failed:
        data.update(
            native_retirement="confirmed",
            physical_advance_allowed=False,
            successful_finish_allowed=False,
        )
    return req, response(req, data)


def export_pair(modality, tick=1):
    p = plan(modalities=(modality,))
    d, produced = prepared(p), slot(p.sources[0], tick)
    command = {
        "kind": "export_source",
        "plan_digest": d["plan_digest"],
        "batch_digest": OTHER,
        **{
            key: produced[key]
            for key in (
                "request_id",
                "source_id",
                "entity_index",
                "source_body_tick",
                "source_production_digest",
                "original_payload_sha256",
            )
        },
    }
    req = request(command, "application", previous=PREVIOUS)
    payload = bytes(produced["byte_length"])
    semantic = c.SENSOR_DIGESTS[produced["tensor"]["kind"]]
    pool = b.BufferPool(binding(), (semantic,))
    with pool.reserve_outputs((b.OutputSpec(semantic, len(payload)),)) as reserved:
        reserved.enter(
            b.TrustedHostCreationContext(
                binding(), w.parse(req)["request_digest"], PREVIOUS
            )
        )
        reserved.write(0, 0, payload)
        byte_manifest = c.raw(reserved.seal(0))
    typed = {
        "schema": "crebain.force-city-source-manifest.v1",
        **{key: value for key, value in command.items() if key != "kind"},
        "scene_sha256": SOURCE,
        "source_catalog_digest": d["source_catalog_digest"],
        "source_config_digest": SOURCE,
        "available_after_body_tick": tick,
        "byte_manifest_digest": byte_manifest["manifest_digest"],
        "tensor": produced["tensor"],
        "manifest_digest": "",
    }
    typed["manifest_digest"] = c.commitment("manifest", typed)
    return req, response(
        req,
        {
            "kind": "source_exported",
            "typed_manifest": typed,
            "byte_manifest": byte_manifest,
        },
    )


def mutate_response(
    pair, path, value, *, repair_batch=False, repair_typed=False, repair_byte=False
):
    req, raw = pair
    row = w.parse(raw)
    put(row, path, value)
    data = row["body"].get("data", {})
    if repair_batch:
        data["batch"]["batch_digest"] = c.commitment("batch", data["batch"])
    if repair_byte:
        # Fixture construction only. Both public verifiers independently validate this digest.
        data["byte_manifest"]["manifest_digest"] = b._manifest_digest(
            data["byte_manifest"]
        )
        data["typed_manifest"]["byte_manifest_digest"] = data["byte_manifest"][
            "manifest_digest"
        ]
    if repair_typed:
        data["typed_manifest"]["manifest_digest"] = c.commitment(
            "manifest", data["typed_manifest"]
        )
    return req, seal(row, "result_digest", w.RESPONSE_SCHEMA)


def vectors():
    rows = {}

    def add(name, req, res=None):
        if name in rows:
            raise AssertionError("duplicate fixture")
        rows[name] = (req, res)

    cpu = c.raw(plan())
    for name, count, mods in (
        ("prepare_cpu_one", 1, ()),
        ("prepare_cpu_256", 256, ()),
        ("prepare_two_sources", 2, ("rgb", "pressure")),
        ("prepare_three_modalities", 3, ("rgb", "thermal", "pressure")),
        ("prepare_four_sources", 4, ("rgb",) * 4),
        (
            "prepare_twelve_sources",
            256,
            ("rgb",) * 4 + ("thermal",) * 4 + ("pressure",) * 4,
        ),
    ):
        add(name, request(c.raw(plan(count, modalities=mods))))
    for name, horizon in (
        ("horizon_one", 1),
        ("horizon_7200", 7200),
        ("horizon_zero", 0),
        ("horizon_7201", 7201),
        ("horizon_float", 2.0),
        ("horizon_boolean", True),
    ):
        value = deepcopy(cpu)
        value["world"]["horizon_ticks"] = horizon
        add(name, request(value))
    add("sequence_max_exact", request(cpu, sequence=b.MAX_ID))
    command = advance(plan())
    add("set_row_shape", request(command, "application"))
    hold = deepcopy(command)
    hold["rows"] = [[0, "hold", SOURCE]]
    add("hold_row_shape", request(hold, "application"))
    add("abort_shape", request({}, "abort"))
    finish = {
        "plan_digest": SOURCE,
        "completed_ticks": 1,
        "last_released_batch_digest": OTHER,
    }
    add("finish_shape", request(finish, "finish"))

    def prepare_mutation(name, source, path, value):
        row = deepcopy(source)
        put(row, path, value)
        add(name, request(row))

    p2 = c.raw(plan(2, modalities=("rgb", "thermal", "pressure"), solids=2))
    too_many = c.raw(plan(256))
    for key in ("entity_ids", "initial_positions", "controller_references"):
        too_many["world"][key].append(
            "d256" if key == "entity_ids" else deepcopy(too_many["world"][key][-1])
        )
    add("entity_257", request(too_many))
    for name, path, value in (
        ("duplicate_entity_ids", ["world", "entity_ids"], ["d000", "d000"]),
        (
            "missing_position_row",
            ["world", "initial_positions"],
            p2["world"]["initial_positions"][:-1],
        ),
        ("reordered_entity_roster", ["world", "entity_ids"], ["d001", "d000"]),
        ("duplicate_source_id", ["sources", 1, "source_id"], "s000"),
        ("foreign_source_recipient", ["sources", 2, "entity_index"], 2),
        ("unknown_modality", ["sources", 2, "kind"], "radar"),
        ("unsupported_mount", ["sources", 0, "scope"], "entity_local"),
        ("unknown_rendering_mode", ["sources", 0, "rendering_mode"], "raytraced"),
        ("invalid_final_material_index", ["scene", "solids", 1, "material_index"], 1),
    ):
        prepare_mutation(name, p2, path, value)
    twelve = c.raw(
        plan(1, modalities=("rgb",) * 4 + ("thermal",) * 4 + ("pressure",) * 4)
    )
    thirteen = deepcopy(twelve)
    extra = deepcopy(thirteen["sources"][-1])
    extra.update(request_id="r012", source_id="s012")
    thirteen["sources"].append(extra)
    add("source_13", request(thirteen))
    fifth = c.raw(plan(1, modalities=("rgb",) * 4))
    extra = deepcopy(fifth["sources"][-1])
    extra.update(request_id="r004", source_id="s004")
    fifth["sources"].append(extra)
    add("fifth_same_modality", request(fifth))
    for field in ("acoustic", "thermal"):
        row = deepcopy(p2)
        del row[field]
        add("missing_" + field, request(row))
        row = deepcopy(cpu)
        row[field] = deepcopy(p2[field])
        add("extra_unrequested_" + field, request(row))
    for name, value in (
        ("continuous_positive_zero", 0.0),
        ("continuous_negative_zero", -0.0),
        ("continuous_adjacent_low", 0.03),
        ("continuous_adjacent_high", math.nextafter(0.03, math.inf)),
        ("integer_in_continuous_field", 0),
        ("boolean_in_continuous_field", True),
    ):
        prepare_mutation(name, cpu, ["world", "initial_positions", 0, 0], value)
    add(
        "alternate_float_spelling",
        replace_token(rows["continuous_adjacent_low"][0], b"[0.03,50.0", b"[3e-2,50.0"),
    )
    prepare_mutation("float_in_integer_field", cpu, ["world", "action_budget"], 4096.0)
    prepare_mutation(
        "unknown_nested_field", cpu, ["world", "range_override"], [0.0, 1.0]
    )
    prepare_mutation(
        "unsupported_range_override", cpu, ["range_override"], {"roll": [-1.0, 1.0]}
    )
    prepare_mutation("altered_composition_digest", cpu, ["composition_digest"], OTHER)
    prepare_mutation("altered_resource_digest", cpu, ["resource_plan_digest"], OTHER)
    add(
        "negative_integer_zero",
        replace_token(
            request(c.raw(plan(modalities=("rgb",)))),
            b'"entity_index":0',
            b'"entity_index":-0',
        ),
    )
    add(
        "continuous_negative_zero_integer_spelling",
        replace_token(rows["continuous_negative_zero"][0], b"[-0.0,50.0", b"[-0,50.0"),
    )
    add(
        "nonfinite_token",
        replace_token(rows["continuous_positive_zero"][0], b"[0.0,50.0", b"[NaN,50.0"),
    )
    add(
        "duplicate_nested_key",
        replace_token(
            rows["prepare_cpu_one"][0],
            b'"horizon_ticks":2',
            b'"horizon_ticks":2,"horizon_ticks":2',
        ),
    )
    for name, field, value in (
        ("foreign_application_digest", "application_digest", OTHER),
    ):
        row = w.parse(request(cpu))
        row["binding"][field] = value
        add(name, seal(row, "request_digest", w.REQUEST_SCHEMA))
    row = w.parse(request(cpu))
    del row["binding"]["application_digest"]
    add("missing_application_digest", seal(row, "request_digest", w.REQUEST_SCHEMA))
    for name, value in (("sequence_boolean", True), ("sequence_float", 1.0)):
        add(name, request(cpu, sequence=value))
    add(
        "sequence_above_safe_max",
        replace_token(
            rows["sequence_max_exact"][0],
            b'"sequence":9007199254740991',
            b'"sequence":9007199254740992',
        ),
    )
    add("unimplemented_import_descriptor", request({}, "buffer_import_begin"))

    p = plan(2, modalities=("rgb", "pressure"))
    prep_req = request(c.raw(p))
    prep = (prep_req, response(prep_req, prepared(p), "prepared"))
    add("prepared_valid", *prep)
    zero = advanced_pair(plan(), ())
    add("advanced_zero_sources", *zero)
    add("advanced_all_not_due", *advanced_pair(p, ("not_due", "not_due")))
    add(
        "advanced_produced_rgba",
        *advanced_pair(plan(modalities=("rgb",)), ("produced",)),
    )
    add(
        "advanced_produced_pressure",
        *advanced_pair(plan(modalities=("pressure",)), ("produced",)),
    )
    failed = advanced_pair(p, ("produced", "failed"), failed=True)
    add("advance_failed_one_source", *failed)
    exports = {}
    for name, modality, tick in (
        ("exported_rgba", "rgb", 1),
        ("exported_radiance", "thermal", 1),
        ("exported_pressure_133", "pressure", 1),
        ("exported_pressure_134", "pressure", 3),
    ):
        exports[name] = export_pair(modality, tick)
        add(name, *exports[name])
    release = {
        "kind": "release_batch",
        "plan_digest": SOURCE,
        "batch_digest": OTHER,
        "tick": 1,
    }
    release_req = request(release, "application")
    released = (
        release_req,
        response(release_req, {**release, "kind": "batch_released"}),
    )
    add("batch_released_valid", *released)
    finish_req = request(finish, "finish")
    finished = (
        finish_req,
        response(
            finish_req,
            {
                **finish,
                "native_retirement": "confirmed",
                "promised_source_output": "complete",
                "scientific_validation": False,
            },
            "finished",
        ),
    )
    add("finish_valid", *finished)
    abort_req = request({}, "abort")
    add("abort_valid", abort_req, response(abort_req, kind="aborted"))
    for name, field in (
        ("prepared_wrong_plan", "plan_digest"),
        ("prepared_wrong_roster", "roster_digest"),
        ("prepared_wrong_catalog", "source_catalog_digest"),
        ("prepared_wrong_resources", "resource_plan_digest"),
    ):
        add(name, *mutate_response(prep, ["body", "data", field], OTHER))
    for name, path, value in (
        ("response_wrong_request_digest", ["request_digest"], OTHER),
        ("response_wrong_sequence", ["sequence"], 2),
        ("response_wrong_generation", ["binding", "generation"], OWNER),
        ("response_unknown_outcome", ["outcome"], "successful"),
        ("response_unknown_result_kind", ["body", "data", "kind"], "unknown"),
    ):
        add(name, *mutate_response(zero, path, value))
    add(
        "advanced_wrong_tick",
        *mutate_response(zero, ["body", "data", "batch", "tick"], 2, repair_batch=True),
    )
    healthy = advanced_pair(p, ("produced", "produced"))
    original_rows = w.parse(healthy[1])["body"]["data"]["batch"]["control"]["rows"]
    add(
        "advanced_reordered_control_rows",
        *mutate_response(
            healthy,
            ["body", "data", "batch", "control", "rows"],
            original_rows[::-1],
            repair_batch=True,
        ),
    )
    add(
        "advanced_failed_slot",
        *mutate_response(
            failed,
            ["body", "data"],
            {"kind": "advanced", "batch": w.parse(failed[1])["body"]["data"]["batch"]},
        ),
    )
    add(
        "advance_failed_zero_failed",
        *mutate_response(
            failed,
            ["body", "data", "batch", "slots"],
            [slot(s) for s in p.sources],
            repair_batch=True,
        ),
    )
    add(
        "advance_failed_two_failed",
        *mutate_response(
            failed,
            ["body", "data", "batch", "slots"],
            [slot(s, status="failed") for s in p.sources],
            repair_batch=True,
        ),
    )
    add(
        "failed_cleanup_unconfirmed",
        *mutate_response(failed, ["body", "data", "native_retirement"], "unconfirmed"),
    )
    add(
        "failed_allows_advance",
        *mutate_response(failed, ["body", "data", "physical_advance_allowed"], True),
    )
    exported = exports["exported_rgba"]
    for name, field, value in (
        ("export_foreign_source", "source_id", "foreign"),
        ("export_foreign_entity", "entity_index", 1),
        ("export_wrong_batch", "batch_digest", SOURCE),
        ("export_wrong_source_tick", "source_body_tick", 2),
        ("export_late_availability", "available_after_body_tick", 2),
        ("export_wrong_production", "source_production_digest", OTHER),
        ("export_wrong_payload_hash", "original_payload_sha256", OTHER),
    ):
        add(
            name,
            *mutate_response(
                exported,
                ["body", "data", "typed_manifest", field],
                value,
                repair_typed=True,
            ),
        )
    add(
        "export_wrong_typed_manifest_digest",
        *mutate_response(
            exported, ["body", "data", "typed_manifest", "manifest_digest"], OTHER
        ),
    )
    add(
        "export_wrong_byte_manifest_digest",
        *mutate_response(
            exported,
            ["body", "data", "byte_manifest", "manifest_digest"],
            OTHER,
            repair_typed=True,
        ),
    )
    add(
        "export_wrong_tensor_extent",
        *mutate_response(
            exported,
            ["body", "data", "typed_manifest", "tensor", "shape"],
            [8, 9, 4],
            repair_typed=True,
        ),
    )
    for name, field, value in (
        ("export_wrong_semantic", "semantic_digest", OTHER),
        ("export_wrong_creator", "creating_request_digest", OTHER),
        ("export_wrong_predecessor", "causal_predecessor", OTHER),
        ("export_imported_origin", "imported_manifest_digest", OTHER),
    ):
        add(
            name,
            *mutate_response(
                exported,
                ["body", "data", "byte_manifest", field],
                value,
                repair_byte=True,
                repair_typed=True,
            ),
        )
    add(
        "release_wrong_batch",
        *mutate_response(released, ["body", "data", "batch_digest"], SOURCE),
    )
    add(
        "finish_wrong_prefix",
        *mutate_response(finished, ["body", "data", "completed_ticks"], 2),
    )
    add(
        "finish_scientific_validation_true",
        *mutate_response(finished, ["body", "data", "scientific_validation"], True),
    )
    add(
        "response_integer_float_alias",
        *mutate_response(
            zero, ["body", "data", "batch", "tick"], 1.0, repair_batch=True
        ),
    )
    add(
        "response_boolean_integer_alias",
        *mutate_response(
            zero, ["body", "data", "batch", "tick"], True, repair_batch=True
        ),
    )
    add(
        "response_duplicate_key",
        zero[0],
        replace_token(zero[1], b'"sequence":1', b'"sequence":1,"sequence":1'),
    )
    add("response_unknown_field", *mutate_response(zero, ["unknown"], None))
    if set(rows) != {identity for identity, _, _ in ROSTER}:
        raise AssertionError("fixture roster changed")
    return tuple(
        Vector(identity, layer, expected, *rows[identity])
        for identity, layer, expected in ROSTER
    )


# Reviewed before outcomes; additions need an explicit successor roster.
ROSTER = (
    ("prepare_cpu_one", "request", "accept"),
    ("prepare_cpu_256", "request", "accept"),
    ("prepare_two_sources", "request", "accept"),
    ("prepare_three_modalities", "request", "accept"),
    ("prepare_four_sources", "request", "accept"),
    ("prepare_twelve_sources", "request", "accept"),
    ("horizon_one", "request", "accept"),
    ("horizon_7200", "request", "accept"),
    ("sequence_max_exact", "request", "accept"),
    ("hold_row_shape", "request", "accept"),
    ("set_row_shape", "request", "accept"),
    ("abort_shape", "request", "accept"),
    ("finish_shape", "request", "accept"),
    ("horizon_zero", "request", "reject"),
    ("horizon_7201", "request", "reject"),
    ("horizon_float", "request", "reject"),
    ("horizon_boolean", "request", "reject"),
    ("entity_257", "request", "reject"),
    ("duplicate_entity_ids", "request", "reject"),
    ("missing_position_row", "request", "reject"),
    ("reordered_entity_roster", "request", "reject"),
    ("duplicate_source_id", "request", "reject"),
    ("foreign_source_recipient", "request", "reject"),
    ("source_13", "request", "reject"),
    ("fifth_same_modality", "request", "reject"),
    ("missing_acoustic", "request", "reject"),
    ("extra_unrequested_acoustic", "request", "reject"),
    ("missing_thermal", "request", "reject"),
    ("extra_unrequested_thermal", "request", "reject"),
    ("unknown_modality", "request", "reject"),
    ("unsupported_mount", "request", "reject"),
    ("unknown_rendering_mode", "request", "reject"),
    ("invalid_final_material_index", "request", "reject"),
    ("continuous_positive_zero", "request", "accept"),
    ("continuous_negative_zero", "request", "accept"),
    ("continuous_adjacent_low", "request", "accept"),
    ("continuous_adjacent_high", "request", "accept"),
    ("alternate_float_spelling", "request", "accept"),
    ("integer_in_continuous_field", "request", "reject"),
    ("boolean_in_continuous_field", "request", "reject"),
    ("float_in_integer_field", "request", "reject"),
    ("negative_integer_zero", "request", "reject"),
    ("nonfinite_token", "request", "reject"),
    ("duplicate_nested_key", "request", "reject"),
    ("unknown_nested_field", "request", "reject"),
    ("missing_application_digest", "request", "reject"),
    ("foreign_application_digest", "request", "reject"),
    ("altered_composition_digest", "request", "reject"),
    ("altered_resource_digest", "request", "reject"),
    ("sequence_boolean", "request", "reject"),
    ("sequence_float", "request", "reject"),
    ("sequence_above_safe_max", "request", "reject"),
    ("unimplemented_import_descriptor", "request", "reject"),
    ("unsupported_range_override", "request", "reject"),
    ("prepared_valid", "response", "accept"),
    ("advanced_zero_sources", "response", "accept"),
    ("advanced_all_not_due", "response", "accept"),
    ("advanced_produced_rgba", "response", "accept"),
    ("advanced_produced_pressure", "response", "accept"),
    ("advance_failed_one_source", "response", "accept"),
    ("exported_rgba", "response", "accept"),
    ("exported_radiance", "response", "accept"),
    ("exported_pressure_133", "response", "accept"),
    ("exported_pressure_134", "response", "accept"),
    ("batch_released_valid", "response", "accept"),
    ("finish_valid", "response", "accept"),
    ("abort_valid", "response", "accept"),
    ("prepared_wrong_plan", "response", "reject"),
    ("prepared_wrong_roster", "response", "reject"),
    ("prepared_wrong_catalog", "response", "reject"),
    ("prepared_wrong_resources", "response", "reject"),
    ("response_wrong_request_digest", "response", "reject"),
    ("response_wrong_sequence", "response", "reject"),
    ("response_wrong_generation", "response", "reject"),
    ("response_unknown_outcome", "response", "reject"),
    ("response_unknown_result_kind", "response", "reject"),
    ("advanced_wrong_tick", "response", "reject"),
    ("advanced_reordered_control_rows", "response", "reject"),
    ("advanced_failed_slot", "response", "reject"),
    ("advance_failed_zero_failed", "response", "reject"),
    ("advance_failed_two_failed", "response", "reject"),
    ("failed_cleanup_unconfirmed", "response", "reject"),
    ("failed_allows_advance", "response", "reject"),
    ("export_foreign_source", "response", "reject"),
    ("export_foreign_entity", "response", "reject"),
    ("export_wrong_batch", "response", "reject"),
    ("export_wrong_source_tick", "response", "reject"),
    ("export_late_availability", "response", "reject"),
    ("export_wrong_production", "response", "reject"),
    ("export_wrong_payload_hash", "response", "reject"),
    ("export_wrong_semantic", "response", "reject"),
    ("export_wrong_typed_manifest_digest", "response", "reject"),
    ("export_wrong_byte_manifest_digest", "response", "reject"),
    ("export_wrong_tensor_extent", "response", "reject"),
    ("export_wrong_creator", "response", "reject"),
    ("export_wrong_predecessor", "response", "reject"),
    ("export_imported_origin", "response", "reject"),
    ("release_wrong_batch", "response", "reject"),
    ("finish_wrong_prefix", "response", "reject"),
    ("finish_scientific_validation_true", "response", "reject"),
    ("response_integer_float_alias", "response", "reject"),
    ("response_boolean_integer_alias", "response", "reject"),
    ("response_duplicate_key", "response", "reject"),
    ("response_unknown_field", "response", "reject"),
    ("continuous_negative_zero_integer_spelling", "request", "accept"),
)
