mod common;
use common::*;
use crebain_ncp_force_city_sources::{admission as a, contract, engine, types::*, Finite64};
use ncp_local::modular_wire::{self as w, Command, Operation, Request};
use serde_json::json;

type Op = Operation<Prepare, CityCommand, Never, Finish>;
fn frame(operation: Op) -> Result<Vec<u8>, w::ModularError> {
    Request::encode(
        binding(),
        9_007_199_254_740_991,
        Command::Execute {
            expected_predecessor_result_digest: Some("a".repeat(64)),
            operation,
        },
    )
}
#[test]
fn maximum_roster_and_twelve_sources_fit_selected_geometry_and_result_bounds() {
    let p = plan(256, 12, 16, false);
    a::validate_prepare(&p).unwrap();
    assert_eq!(
        a::resources(&p).unwrap()["native_original_bytes"],
        27_857_088
    );
    assert_eq!(
        a::resources(&p).unwrap()["acoustic_history_bytes"],
        13_985_792
    );
    let prepare = frame(Operation::Prepare(p.clone())).unwrap();
    let private = engine::prepare_command(RUN, SOURCE, &p).unwrap();
    engine::preflight(&private).unwrap();
    let c = advance(&p, 7200, Some("a".repeat(64)));
    a::validate_rows(&p, &c, &[], 0).unwrap();
    let set = frame(Operation::Application(CityCommand::Advance(Box::new(
        c.clone(),
    ))))
    .unwrap();
    engine::preflight(&engine::advance_command(&c, Some(SOURCE)).unwrap()).unwrap();
    let mut hold = c.clone();
    hold.rows = (0..256)
        .map(|i| ControlRow::HoldRow((i, "hold".into(), SOURCE.into())))
        .collect();
    let hold_bytes = frame(Operation::Application(CityCommand::Advance(Box::new(
        hold.clone(),
    ))))
    .unwrap();
    engine::preflight(&engine::advance_command(&hold, Some(SOURCE)).unwrap()).unwrap();
    let finish = frame(Operation::Finish(Finish {
        plan_digest: SOURCE.into(),
        completed_ticks: 7200,
        last_released_batch_digest: SOURCE.into(),
    }))
    .unwrap();
    // All longest source IDs and terminal tick spellings, with 256 complete control rows.
    let long = plan(256, 12, 16, true);
    let slots: Vec<_> = long
        .sources
        .iter()
        .map(|s| {
            let s0 = a::source_info(s);
            SourceOutcome::Produced(Box::new(Produced {
                request_id: s0.request.into(),
                source_id: s0.source.into(),
                entity_index: 255,
                status: "produced".into(),
                source_config_digest: SOURCE.into(),
                source_body_tick: 7200,
                available_after_body_tick: 7200,
                source_production_digest: SOURCE.into(),
                original_payload_sha256: SOURCE.into(),
                byte_length: a::expected_bytes(s, 7200) as u64,
                tensor: a::expected_tensor(s, 7200),
            }))
        })
        .collect();
    let batch = Batch {
        plan_digest: SOURCE.into(),
        roster_digest: SOURCE.into(),
        scene_sha256: SOURCE.into(),
        source_catalog_digest: SOURCE.into(),
        tick: 7200,
        previous_batch_digest: Some(SOURCE.into()),
        control: ControlReceipt {
            tick: 7200,
            execution: "known_completed".into(),
            before_state_sha256: SOURCE.into(),
            after_state_sha256: SOURCE.into(),
            native_transition_sha256: SOURCE.into(),
            all_motor_assignments_completed: true,
            rows: (0..256)
                .map(|i| (i, SOURCE.into(), "hold".into(), false))
                .collect(),
        },
        slots,
        batch_digest: SOURCE.into(),
    };
    let result = CityResult::Advanced(Box::new(Advanced {
        kind: "advanced".into(),
        batch,
    }));
    contract::validate("Result", &result).unwrap();
    a::encoded_bound(&result, a::RESULT_BYTES).unwrap();
    let response = json!({"schema":w::RESPONSE_SCHEMA,"binding":binding(),"sequence":9_007_199_254_740_991_u64,"operation":"application","request_digest":SOURCE,
        "outcome":"committed","code":"ok","body":{"kind":"application","data":result},"result_digest":SOURCE});
    let reply = serde_json::to_vec(&response).unwrap();
    w::parse_value(&reply).unwrap();
    println!("frame_bytes prepare={} private_prepare_command={} set={} hold={} finish={} maximum_advanced_reply={}",prepare.len(),serde_json::to_vec(&private).unwrap().len(),set.len(),hold_bytes.len(),finish.len(),reply.len());
}
#[test]
fn long_ids_and_maximum_geometry_reject_before_private_dispatch() {
    let p = plan(256, 12, 64, true);
    a::validate_prepare(&p).unwrap();
    assert!(engine::preflight(&engine::prepare_command(RUN, SOURCE, &p).unwrap()).is_err());
    let mut reduced = p;
    reduced.world.entity_ids.truncate(1);
    reduced.world.initial_positions.truncate(1);
    reduced.world.controller_references.truncate(1);
    reduced.sources.clear();
    reduced.acoustic = None;
    reduced.thermal = None;
    reduced.resource_plan_digest = a::resource_digest(&reduced).unwrap();
    a::validate_prepare(&reduced).unwrap();
    engine::preflight(&engine::prepare_command(RUN, SOURCE, &reduced).unwrap()).unwrap();
}
#[test]
fn invalid_final_entity_and_exhausted_action_history_do_not_admit() {
    let p = plan(256, 0, 16, false);
    let c = advance(&p, 1, None);
    assert_eq!(a::validate_rows(&p, &c, &[], 0).unwrap(), 256);
    let mut bad = c.clone();
    bad.rows[255] = ControlRow::SetRow((254, "set".into(), true, [Finite64::new(0.0).unwrap(); 4]));
    assert!(a::validate_rows(&p, &bad, &[], 0).is_err());
    assert!(a::validate_rows(&p, &c, &[], 3841).is_err());
    assert!(a::validate_rows(&p, &c, &[], 3840).is_ok());
}
#[test]
fn rgb_and_thermal_remain_distinct_closed_variants() {
    let p = plan(1, 8, 0, false);
    assert!(matches!(p.sources[0], SourceRequest::RGBRequest(_)));
    assert!(matches!(p.sources[4], SourceRequest::ThermalRequest(_)));
    let mut row = serde_json::to_value(&p.sources[4]).unwrap();
    row["kind"] = json!("mounted");
    assert!(serde_json::from_value::<SourceRequest>(row).is_err());
}

#[test]
fn response_reservation_covers_longest_closed_rows_and_escaped_failure_diagnostic() {
    let p = plan(256, 12, 16, true);
    let id = "a".repeat(64);
    let row: AppliedRow = (255, id.clone(), "hold".into(), false);
    assert!(serde_json::to_vec(&row).unwrap().len() < 96);
    for source in &p.sources {
        let slot = Produced {
            request_id: id.clone(),
            source_id: id.clone(),
            entity_index: 255,
            status: "produced".into(),
            source_config_digest: SOURCE.into(),
            source_body_tick: 7200,
            available_after_body_tick: 7200,
            source_production_digest: SOURCE.into(),
            original_payload_sha256: SOURCE.into(),
            byte_length: a::expected_bytes(source, 7200) as u64,
            tensor: a::expected_tensor(source, 7200),
        };
        contract::validate("Produced", &slot).unwrap();
        assert!(serde_json::to_vec(&slot).unwrap().len() < 1024);
    }
    let absent = Absent {
        request_id: id.clone(),
        source_id: id.clone(),
        entity_index: 255,
        status: "absent".into(),
        due_at_tick: 7200,
        reason: "not_attempted_after_failure".into(),
        causal_failed_request_id: id.clone(),
    };
    let not_due = NotDue {
        request_id: id.clone(),
        source_id: id.clone(),
        entity_index: 255,
        status: "not_due".into(),
        next_due_tick: Some(7200),
    };
    let failure = Failed {
        request_id: id.clone(),
        source_id: id,
        entity_index: 255,
        status: "failed".into(),
        attempted_at_tick: 7200,
        reason: "acquisition_failed".into(),
        diagnostic: "\\\"".repeat(128),
    };
    for (name, value) in [
        ("Absent", serde_json::to_value(absent).unwrap()),
        ("NotDue", serde_json::to_value(not_due).unwrap()),
        ("Failed", serde_json::to_value(failure).unwrap()),
    ] {
        contract::validate(name, &value).unwrap();
        assert!(serde_json::to_vec(&value).unwrap().len() < 1024);
    }
    // Fixed schema syntax and digest fields fit the independently reserved header.
    assert!(4096 + 96 * p.world.entity_ids.len() + 1024 * p.sources.len() <= a::RESULT_BYTES);
}
