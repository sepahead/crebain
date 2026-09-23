//! Actual SDK and Bun transport with explicitly synthetic native owners; no native qualification.

use crebain_ncp_force_ground_sensors::{
    contract,
    family_application::{CanonicalApplication, EvaluationApplication, FamilyController},
    family_contract as family,
    family_engine::FamilyEngine,
    family_process::FamilyProcess,
    family_protocol::{Observation, ObservedEndpoint},
    family_types::*,
    types::{
        self, Action, AdvanceTick, AdvanceTickCaptureReservation, Prepare, SensorBatch, SensorSlot,
    },
    Finite64,
};
use ncp_local::modular_buffer::BufferBinding;
use ncp_local::modular_client::Client;
use ncp_local::modular_owner::{self, AppOperation, AppResponse, Application};
use ncp_local::modular_wire::{Body, ModularError, Operation, Outcome, ReferenceInput};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn convert<T: Serialize, U: DeserializeOwned>(value: &T) -> U {
    serde_json::from_value(serde_json::to_value(value).unwrap()).unwrap()
}
fn binding(slot: usize) -> BufferBinding {
    BufferBinding {
        profile_digest: modular_owner::profile_digest().unwrap(),
        application_digest: family::application_digest().unwrap(),
        run_id: format!("{slot:08x}-1111-4111-8111-111111111111"),
        endpoint_id: format!("{slot:08x}-2222-4222-8222-222222222222"),
        generation: format!("{slot:08x}-3333-4333-8333-333333333333"),
    }
}
fn plan(branches: usize) -> FamilyPlan {
    let workload: Value =
        serde_json::from_slice(include_bytes!("../../contracts/m1.workload.v1.json")).unwrap();
    let mut body: Prepare = serde_json::from_value(
        json!({"specification":workload["specification"], "planned_ticks":6,
        "composition_digest":family::composition_digest().unwrap()}),
    )
    .unwrap();
    body.specification.scene.thermal_cameras.clear();
    for camera in &mut body.specification.scene.rgb_cameras {
        camera.width = 8;
        camera.height = 8;
        camera.period_ticks = 3;
    }
    let target: types::SetTarget = convert(&action(None));
    FamilyPlan {
        family_id: "98765432-0000-4000-8000-111111111111".into(),
        canonical_binding: binding(0),
        body,
        landmark_tick: 3,
        branches: (1..=branches)
            .map(|slot| BranchPlan {
                slot: slot as u64,
                case_id: format!("case-{slot}"),
                purpose: if slot == 1 {
                    BranchPlanPurpose::Label
                } else {
                    BranchPlanPurpose::SameActionControl
                },
                binding: binding(slot),
                target: target.clone(),
            })
            .collect(),
        evaluation: PressureWindow {
            kind: "scaled_compensated_pressure_rms400_v1".into(),
            sensor_id: "pressure:mic-a".into(),
            first_tick: 4,
            last_tick: 6,
            sample_count: 400,
            unit: "pascal".into(),
            target_function_digest: family::target_digest().unwrap(),
        },
        limits: FamilyLimits {
            total_wall_seconds: 60,
            endpoint_count: branches as u64 + 1,
            max_active_native_owners: 2,
            public_checkpoint_slots: 1,
            temporary_checkpoint_slots: 1,
            evaluation_window_bytes: 3200,
        },
    }
}
fn paths() -> Option<(PathBuf, PathBuf, PathBuf)> {
    let bun = std::env::var_os("CREBAIN_SENSOR_BUN")?;
    let node = std::env::var_os("CREBAIN_SENSOR_NODE").expect("paired selected Node");
    let ordinary =
        std::env::var_os("CREBAIN_SENSOR_BRIDGE").expect("paired selected project source");
    Some((
        bun.into(),
        node.into(),
        Path::new(&ordinary).with_file_name("family-process.test-support.ts"),
    ))
}
fn semantics() -> Vec<String> {
    let mut result = ["rgba8", "radiance", "pressure"]
        .into_iter()
        .map(|kind| contract::semantic(kind).unwrap())
        .collect::<Vec<_>>();
    result.sort();
    result
}
fn call<A: Application, F>(
    endpoint: &mut ObservedEndpoint<A>,
    client: &mut Client<A>,
    operation: AppOperation<A>,
    notify: &mut F,
) -> AppResponse<A>
where
    F: for<'a> FnMut(Observation<'a, A>) -> Result<(), ModularError>,
{
    let input = client.begin(operation).unwrap().to_vec();
    let mut frame = Vec::new();
    endpoint.exchange(&input, &mut frame, &mut *notify).unwrap();
    let response = client.observe(&frame[4..]).unwrap();
    assert_eq!(
        response.outcome,
        Outcome::Committed,
        "{}",
        String::from_utf8_lossy(&frame[4..])
    );
    let ack = client.acknowledgement().unwrap();
    frame.clear();
    endpoint.exchange(&ack, &mut frame, &mut *notify).unwrap();
    client.observe_acknowledgement(&frame[4..]).unwrap();
    response
}
fn action(accepted: Option<String>) -> Action {
    accepted.map_or_else(
        || Action::SetTarget {
            armed: true,
            roll_rad: Finite64::new(0.0).unwrap(),
            pitch_rad: Finite64::new(0.0).unwrap(),
            heading_rad: Finite64::new(0.0).unwrap(),
            altitude_m: Finite64::new(8.0).unwrap(),
        },
        |accepted_action_request_digest| Action::Hold {
            accepted_action_request_digest,
        },
    )
}
fn advance(tick: u64, previous: Option<String>, accepted: Option<String>) -> AdvanceTick {
    AdvanceTick {
        kind: "advance_tick".into(),
        tick,
        previous_batch_digest: previous,
        action: action(accepted),
        capture_reservation: AdvanceTickCaptureReservation {
            kind: "absent".into(),
        },
    }
}
fn release<A: Application, F>(
    endpoint: &mut ObservedEndpoint<A>,
    client: &mut Client<A>,
    batch: &SensorBatch,
    notify: &mut F,
) where
    F: for<'a> FnMut(Observation<'a, A>) -> Result<(), ModularError>,
{
    for slot in &batch.slots {
        if let SensorSlot::Due { byte_manifest, .. } = slot {
            call(
                endpoint,
                client,
                Operation::BufferRelease(ReferenceInput {
                    reference: byte_manifest.reference(),
                }),
                notify,
            );
        }
    }
}

#[test]
fn constructor_admits_fifteen_slots_and_rejects_duplicate_foreign_or_changed_bounds() {
    assert_eq!(
        family::target_digest().unwrap(),
        "2587d58265dfec6decf9d2255a410ca195a337e1bbf1020ccaac4f37ee6c1505"
    );
    let original = plan(15);
    family::validate("FamilyPlan", &original).expect("closed constructor schema");
    contract::validate("Prepare", &original.body).expect("unchanged sensor preparation schema");
    family::validate_plan(&original).unwrap();
    for mutate in [
        |p: &mut FamilyPlan| p.branches[1].binding = p.branches[0].binding.clone(),
        |p: &mut FamilyPlan| p.branches[0].binding.application_digest = "a".repeat(64),
        |p: &mut FamilyPlan| p.branches[0].slot = 2,
        |p: &mut FamilyPlan| p.limits.endpoint_count = 17,
        |p: &mut FamilyPlan| p.evaluation.first_tick = 3,
        |p: &mut FamilyPlan| p.evaluation.sensor_id = "rgb:mic-a".into(),
        |p: &mut FamilyPlan| p.evaluation.sensor_id = "pressure:missing".into(),
        |p: &mut FamilyPlan| p.evaluation.target_function_digest = "a".repeat(64),
        |p: &mut FamilyPlan| p.body.composition_digest = contract::composition_digest().unwrap(),
    ] {
        let mut invalid = original.clone();
        mutate(&mut invalid);
        assert!(family::validate_plan(&invalid).is_err());
    }
}

#[test]
fn real_bun_process_can_construct_and_retire_family_without_any_native_preparation() {
    let Some((bun, node, fixture)) = paths() else {
        return;
    };
    let production = fixture.with_file_name("family-main.ts");
    let mut process =
        FamilyProcess::spawn(&bun, &node, &production, &plan(2), &"a".repeat(64)).unwrap();
    process.retire().unwrap();
    process.retire().unwrap();
}

#[test]
fn actual_sdk_owners_and_private_bun_bridge_close_two_synthetic_siblings_before_parent() {
    let Some((bun, node, fixture)) = paths() else {
        return;
    };
    let plan = plan(2);
    let process = FamilyProcess::spawn(&bun, &node, &fixture, &plan, &"a".repeat(64)).unwrap();
    let family = FamilyController::new(plan.clone(), "a".repeat(64), process).unwrap();
    let mut canonical = ObservedEndpoint::new(
        plan.canonical_binding.clone(),
        family.canonical().unwrap(),
        semantics(),
    )
    .unwrap();
    assert!(family.canonical().is_err());
    let mut branches = (1..=2)
        .map(|slot| {
            ObservedEndpoint::new(
                plan.branches[slot - 1].binding.clone(),
                family.evaluation(slot).unwrap(),
                semantics(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert!(family.evaluation(1).is_err());
    assert!(family.evaluation(0).is_err());
    assert!(family.evaluation(3).is_err());
    let mut client =
        Client::<CanonicalApplication<FamilyProcess>>::new(plan.canonical_binding.clone()).unwrap();
    let mut notify = |event: Observation<'_, CanonicalApplication<FamilyProcess>>| {
        family.observe_canonical(event)
    };
    let prepared = call(
        &mut canonical,
        &mut client,
        Operation::Prepare(CanonicalPrepare { plan: plan.clone() }),
        &mut notify,
    );
    let Body::Prepared {
        data:
            CanonicalResult::FamilyPrepared {
                family_plan_digest,
                body,
                ..
            },
    } = prepared.body
    else {
        panic!("preparation")
    };
    let body_plan = body.plan_digest;
    let mut previous = None;
    let mut accepted = None;
    for tick in 1..=3 {
        let result = call(
            &mut canonical,
            &mut client,
            Operation::Application(convert(&advance(tick, previous.clone(), accepted.clone()))),
            &mut notify,
        );
        let Body::Application {
            data: CanonicalResult::FamilyAdvanced { body, .. },
        } = result.body
        else {
            panic!("canonical prefix")
        };
        release(&mut canonical, &mut client, &body.batch, &mut notify);
        previous = Some(body.batch.batch_digest);
        accepted = Some(body.accepted_action_request_digest);
    }
    let result = call(
        &mut canonical,
        &mut client,
        Operation::Application(CanonicalCommand::Checkpoint {
            tick: 3,
            expected_batch_digest: previous.clone().unwrap(),
        }),
        &mut notify,
    );
    let Body::Application {
        data: CanonicalResult::Checkpointed { reference, .. },
    } = result.body
    else {
        panic!("checkpoint")
    };
    call(
        &mut canonical,
        &mut client,
        Operation::Application(CanonicalCommand::CommitDecision {
            checkpoint: reference.clone(),
            forecast_commitment_digest: "f".repeat(64),
            selected_case_id: "case-1".into(),
        }),
        &mut notify,
    );
    let mut selected_result = String::new();
    let mut final_cpu = String::new();
    for tick in 4..=6 {
        let result = call(
            &mut canonical,
            &mut client,
            Operation::Application(convert(&advance(
                tick,
                previous.clone(),
                if tick == 4 { None } else { accepted.clone() },
            ))),
            &mut notify,
        );
        selected_result = result.result_digest;
        let Body::Application {
            data:
                CanonicalResult::FamilyAdvanced {
                    body,
                    canonical_final_state,
                    ..
                },
        } = result.body
        else {
            panic!("canonical continuation")
        };
        if tick == 6 {
            final_cpu = canonical_final_state.unwrap().cpu_state_sha256;
        }
        release(&mut canonical, &mut client, &body.batch, &mut notify);
        previous = Some(body.batch.batch_digest);
        accepted = Some(body.accepted_action_request_digest);
    }
    let mut terminals = Vec::new();
    let mut sibling_window = None;
    for (index, endpoint) in branches.iter_mut().enumerate() {
        let slot = index + 1;
        let result = call(
            &mut canonical,
            &mut client,
            Operation::Application(CanonicalCommand::ReserveBranch {
                checkpoint: reference.clone(),
                case_id: format!("case-{slot}"),
                expected_selected_execution_result_digest: selected_result.clone(),
            }),
            &mut notify,
        );
        let Body::Application {
            data:
                CanonicalResult::BranchReserved {
                    reference: reservation,
                    ..
                },
        } = result.body
        else {
            panic!("reservation")
        };
        let mut peer = Client::<EvaluationApplication<FamilyProcess>>::new(
            plan.branches[index].binding.clone(),
        )
        .unwrap();
        let mut observe = |event: Observation<'_, EvaluationApplication<FamilyProcess>>| {
            family.observe_evaluation(slot, event)
        };
        let response = call(
            endpoint,
            &mut peer,
            Operation::Prepare(EvaluationPrepare {
                reservation: *reservation,
                expected_family_plan_digest: family_plan_digest.clone(),
            }),
            &mut observe,
        );
        let Body::Prepared {
            data:
                EvaluationResultUnion::Restored {
                    sensor_catalog,
                    ancestry,
                    ..
                },
        } = response.body
        else {
            panic!("restore")
        };
        assert_eq!(
            ancestry.origin_engine_run_id,
            format!("ncp-{}", plan.canonical_binding.run_id)
        );
        assert_eq!(ancestry.execution_binding, plan.branches[index].binding);
        let branch_plan = sensor_catalog.plan_digest;
        assert_eq!(branch_plan, body_plan);
        let mut branch_previous = None;
        let mut branch_accepted = None;
        for tick in 4..=6 {
            let response = call(
                endpoint,
                &mut peer,
                Operation::Application(convert(&advance(
                    tick,
                    branch_previous.clone(),
                    branch_accepted.clone(),
                ))),
                &mut observe,
            );
            let Body::Application {
                data:
                    EvaluationResultUnion::FamilyAdvanced {
                        body,
                        ancestry,
                        canonical_final_state,
                    },
            } = response.body
            else {
                panic!("branch continuation")
            };
            assert!(ancestry.is_some());
            assert!(canonical_final_state.is_none());
            release(endpoint, &mut peer, &body.batch, &mut observe);
            branch_previous = Some(body.batch.batch_digest);
            branch_accepted = Some(body.accepted_action_request_digest);
        }
        let response = call(
            endpoint,
            &mut peer,
            Operation::Application(EvaluationCommand::EvaluatePressureWindow {
                expected_batch_digest: branch_previous.clone().unwrap(),
                expected_target_function_digest: plan.evaluation.target_function_digest.clone(),
            }),
            &mut observe,
        );
        let evaluation_digest = response.result_digest;
        let Body::Application {
            data:
                EvaluationResultUnion::PressureWindowEvaluated {
                    final_cpu_state_sha256,
                    window_payload_sha256,
                    ..
                },
        } = response.body
        else {
            panic!("evaluation")
        };
        assert_eq!(final_cpu_state_sha256, final_cpu);
        if let Some(expected) = &sibling_window {
            assert_eq!(expected, &window_payload_sha256)
        }
        sibling_window = Some(window_payload_sha256);
        let response = call(
            endpoint,
            &mut peer,
            Operation::Finish(EvaluationFinish {
                body: types::Finish {
                    plan_digest: branch_plan,
                    completed_ticks: 6,
                    last_batch_digest: branch_previous.unwrap(),
                },
                evaluation_result_digest: evaluation_digest,
            }),
            &mut observe,
        );
        let Body::Finished { data } = response.body else {
            panic!("branch finish")
        };
        assert_eq!(data.shared_family_process_retirement, "pending");
        let terminal = endpoint.last_committed().unwrap();
        terminals.push(CommittedStamp {
            binding: terminal.binding().clone(),
            sequence: terminal.sequence(),
            request_digest: terminal.request_digest().into(),
            result_digest: terminal.result_digest().into(),
        });
        // This component supplies the EOF observation explicitly. Separate binary/socket
        // controls qualify actual EOF; this call alone is not that transport evidence.
        family
            .close_evaluation(slot, endpoint.observe_eof().unwrap())
            .unwrap();
    }
    call(
        &mut canonical,
        &mut client,
        Operation::Application(CanonicalCommand::ReleaseCheckpoint {
            checkpoint: reference,
            expected_last_branch_terminal_result_digest: terminals
                .last()
                .unwrap()
                .result_digest
                .clone(),
        }),
        &mut notify,
    );
    let response = call(
        &mut canonical,
        &mut client,
        Operation::Finish(CanonicalFinish {
            body: types::Finish {
                plan_digest: body_plan,
                completed_ticks: 6,
                last_batch_digest: previous.unwrap(),
            },
            family_plan_digest,
            expected_branch_terminals: terminals,
        }),
        &mut notify,
    );
    let Body::Finished { data } = response.body else {
        panic!("canonical finish")
    };
    assert_eq!(data.canonical_final_state.cpu_state_sha256, final_cpu);
    assert_eq!(data.bun_process_retirement, "confirmed");
    assert_eq!(data.sdk_host_process_retirement, "pending");
    canonical.observe_eof().unwrap();
    family.retire().unwrap();
}
