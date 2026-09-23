//! Actual public NCP owner/client controls with an explicitly synthetic native port.
mod common;
use common::*;
use crebain_ncp_force_city_sources::{
    admission as a,
    application::CityApplication,
    contract,
    engine::{EngineBatch, EngineError, EnginePort, EnginePrepared},
    types::*,
};
use ncp_local::{
    modular_client::Client,
    modular_owner::{AppOperation, AppResponse, Lifecycle, Owner},
    modular_wire::{self as w, Body, Operation, Outcome, ReadInput, ReferenceInput},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Copy, Default)]
enum Fault {
    #[default]
    None,
    Backings,
    Advance,
    Foreign,
    Read,
    Hash,
    Release,
    Source,
    Retire,
    Rows,
    Tensor,
}
#[derive(Default)]
struct State {
    plan: Option<Prepare>,
    advances: usize,
    reads: usize,
    retires: usize,
    fault: Fault,
    payloads: Vec<(String, Vec<u8>)>,
}
#[derive(Clone)]
struct Fake(Rc<RefCell<State>>);
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
const OWNER: &str = "44444444-4444-4444-8444-444444444444";
impl EnginePort for Fake {
    fn prepare(&mut self, _: &str, _: &str, p: &Prepare) -> Result<EnginePrepared, EngineError> {
        let mut s = self.0.borrow_mut();
        s.plan = Some(p.clone());
        Ok(EnginePrepared {
            owner_id: OWNER.into(),
            native_plan_sha256: SOURCE.into(),
            scene_sha256: SOURCE.into(),
            backing_bytes: [
                a::resources(p).unwrap()["native_original_bytes"]
                    .as_u64()
                    .unwrap() as usize
                    + usize::from(matches!(s.fault, Fault::Backings)),
                16384 + 256 * p.world.entity_ids.len() + 4096 * p.sources.len(),
                4096 + 32768 * p.world.entity_ids.len(),
            ],
        })
    }
    fn advance(&mut self, c: &Advance, previous: Option<&str>) -> Result<EngineBatch, EngineError> {
        let mut s = self.0.borrow_mut();
        s.advances += 1;
        if matches!(s.fault, Fault::Advance) {
            return Err(EngineError);
        }
        let p = s.plan.clone().unwrap();
        s.payloads.clear();
        let source_failed = matches!(s.fault, Fault::Source | Fault::Retire);
        let mut slots:Vec<_>=p.sources.iter().enumerate().map(|(i,source)|{
            let info=a::source_info(source);
            let common=json!({"request_id":info.request,"source_id":info.source,"entity_index":info.entity});
            let mut value=common.as_object().unwrap().clone();
            if !c.tick.is_multiple_of(info.period){
                value.extend(json!({"status":"not_due","next_due_tick":(c.tick+info.period-c.tick%info.period<=p.world.horizon_ticks).then_some(c.tick+info.period-c.tick%info.period)}).as_object().unwrap().clone());
            }else if source_failed&&i==1{
                value.extend(json!({"status":"failed","attempted_at_tick":c.tick,"reason":"acquisition_failed","diagnostic":"synthetic source acquisition failure"}).as_object().unwrap().clone());
            }else if source_failed&&i>1{
                value.extend(json!({"status":"absent","due_at_tick":c.tick,"reason":"not_attempted_after_failure","causal_failed_request_id":a::source_info(&p.sources[1]).request}).as_object().unwrap().clone());
            }else{
                let bytes=vec![0;a::expected_bytes(source,c.tick)];let digest=hash(&bytes);
                s.payloads.push((info.request.into(),bytes));
                value.extend(json!({"status":"produced","source_config_digest":SOURCE,"source_body_tick":c.tick,"available_after_body_tick":c.tick,"source_production_digest":SOURCE,"original_payload_sha256":digest,"byte_length":a::expected_bytes(source,c.tick),"tensor":a::expected_tensor(source,c.tick)}).as_object().unwrap().clone());
            }
            serde_json::from_value(serde_json::Value::Object(value)).unwrap()
        }).collect();
        if let Some(SourceOutcome::Produced(first)) = slots.first_mut() {
            match s.fault {
                Fault::Foreign => first.source_id = "foreign".into(),
                Fault::Hash => first.original_payload_sha256 = "f".repeat(64),
                Fault::Tensor => {
                    first.tensor = Tensor::RgbaTensor(Box::new(RgbaTensor {
                        kind: "rgba8".into(),
                        dtype: "u8".into(),
                        shape: [8, 9, 4],
                        layout: "c_contiguous".into(),
                        row_origin: "bottom-left".into(),
                        encoding: "rgba8-srgb".into(),
                    }))
                }
                _ => {}
            }
        }
        let mut rows: Vec<AppliedRow> = c
            .rows
            .iter()
            .enumerate()
            .map(|(i, row)| match row {
                ControlRow::SetRow((_, _, armed, _)) => {
                    (i as u64, SOURCE.into(), "set".into(), *armed)
                }
                ControlRow::HoldRow((_, _, digest)) => {
                    (i as u64, digest.clone(), "hold".into(), true)
                }
            })
            .collect();
        if matches!(s.fault, Fault::Rows) {
            rows.pop();
        }
        Ok(EngineBatch {
            owner_id: OWNER.into(),
            native_plan_sha256: SOURCE.into(),
            scene_sha256: SOURCE.into(),
            tick: c.tick,
            previous_native_batch_sha256: previous.map(str::to_owned),
            native_batch_sha256: hash(&c.tick.to_be_bytes()),
            source_failed,
            control: ControlReceipt {
                tick: c.tick,
                execution: "known_completed".into(),
                before_state_sha256: SOURCE.into(),
                after_state_sha256: SOURCE.into(),
                native_transition_sha256: SOURCE.into(),
                all_motor_assignments_completed: true,
                rows,
            },
            slots,
        })
    }
    fn read_chunk(
        &mut self,
        _: &str,
        request: &str,
        _: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError> {
        let mut s = self.0.borrow_mut();
        s.reads += 1;
        if matches!(s.fault, Fault::Read) {
            return Err(EngineError);
        }
        Ok(s.payloads
            .iter()
            .find(|(id, _)| id == request)
            .ok_or(EngineError)?
            .1[offset..offset + count]
            .to_vec())
    }
    fn release(&mut self, _: &str) -> Result<(), EngineError> {
        let mut s = self.0.borrow_mut();
        if matches!(s.fault, Fault::Release) {
            return Err(EngineError);
        }
        s.payloads.clear();
        Ok(())
    }
    fn retire(&mut self) -> Result<(), EngineError> {
        let mut s = self.0.borrow_mut();
        s.retires += 1;
        if matches!(s.fault, Fault::Retire) {
            Err(EngineError)
        } else {
            Ok(())
        }
    }
}
type App = CityApplication<Fake>;
fn small(n: usize, sources: usize) -> Prepare {
    let mut p = plan(n, sources, 0, false);
    p.world.horizon_ticks = 1;
    for s in &mut p.sources {
        match s {
            SourceRequest::RGBRequest(x) => {
                x.width = 8;
                x.height = 8
            }
            SourceRequest::ThermalRequest(x) => {
                x.width = 8;
                x.height = 8
            }
            _ => {}
        }
    }
    p.resource_plan_digest = a::resource_digest(&p).unwrap();
    p
}
fn setup(p: &Prepare, fault: Fault) -> (Owner<App>, Client<App>, Rc<RefCell<State>>, Prepared) {
    let state = Rc::new(RefCell::new(State {
        fault,
        ..State::default()
    }));
    let app = App::new(Fake(Rc::clone(&state)), SOURCE.into(), RUN.into()).unwrap();
    let mut semantics: Vec<_> = ["rgba8", "radiance", "pressure"]
        .iter()
        .map(|k| contract::semantic(k).unwrap())
        .collect();
    semantics.sort();
    let mut owner = Owner::new(binding(), app, semantics).unwrap();
    let mut client = Client::new(binding()).unwrap();
    let r = run(&mut owner, &mut client, Operation::Prepare(p.clone()));
    let Body::Prepared {
        data: CityResult::Prepared(prepared),
    } = r.body
    else {
        panic!("preparation failed")
    };
    (owner, client, state, *prepared)
}
fn run(
    owner: &mut Owner<App>,
    client: &mut Client<App>,
    operation: AppOperation<App>,
) -> AppResponse<App> {
    let bytes = client.begin(operation).unwrap().to_vec();
    let response = client.observe(owner.process(&bytes).unwrap()).unwrap();
    if response.outcome == Outcome::Committed {
        let ack = client.acknowledgement().unwrap();
        client
            .observe_acknowledgement(owner.process(&ack).unwrap())
            .unwrap();
    }
    response
}
fn batch(result: AppResponse<App>) -> Batch {
    match result.body {
        Body::Application {
            data: CityResult::Advanced(r),
        } => r.batch,
        Body::Application {
            data: CityResult::AdvanceFailed(r),
        } => r.batch,
        _ => panic!("batch required"),
    }
}
fn export(
    owner: &mut Owner<App>,
    client: &mut Client<App>,
    batch: &Batch,
    slot: &Produced,
) -> Exported {
    let c = ExportSource {
        kind: "export_source".into(),
        plan_digest: batch.plan_digest.clone(),
        batch_digest: batch.batch_digest.clone(),
        request_id: slot.request_id.clone(),
        source_id: slot.source_id.clone(),
        entity_index: slot.entity_index,
        source_body_tick: slot.source_body_tick,
        source_production_digest: slot.source_production_digest.clone(),
        original_payload_sha256: slot.original_payload_sha256.clone(),
    };
    let r = run(
        owner,
        client,
        Operation::Application(CityCommand::ExportSource(Box::new(c))),
    );
    match r.body {
        Body::Application {
            data: CityResult::Exported(e),
        } => *e,
        _ => panic!("export required"),
    }
}
fn release(owner: &mut Owner<App>, client: &mut Client<App>, batch: &Batch) {
    let r = run(
        owner,
        client,
        Operation::Application(CityCommand::ReleaseBatch(Box::new(ReleaseBatch {
            kind: "release_batch".into(),
            plan_digest: batch.plan_digest.clone(),
            batch_digest: batch.batch_digest.clone(),
            tick: batch.tick,
        }))),
    );
    assert_eq!(r.outcome, Outcome::Committed);
}
#[test]
fn zero_source_256_roster_commits_one_complete_shared_reply_and_finish() {
    let p = small(256, 0);
    let (mut owner, mut client, state, prepared) = setup(&p, Fault::None);
    let b = batch(run(
        &mut owner,
        &mut client,
        Operation::Application(CityCommand::Advance(Box::new(advance(&p, 1, None)))),
    ));
    assert_eq!(b.control.rows.len(), 256);
    assert!(b.slots.is_empty());
    release(&mut owner, &mut client, &b);
    let r = run(
        &mut owner,
        &mut client,
        Operation::Finish(Finish {
            plan_digest: prepared.plan_digest,
            completed_ticks: 1,
            last_released_batch_digest: b.batch_digest,
        }),
    );
    assert_eq!(r.outcome, Outcome::Committed);
    assert_eq!(state.borrow().advances, 1);
    assert_eq!(state.borrow().retires, 1);
}
#[test]
fn bad_last_row_and_undrained_batch_reject_without_an_extra_transition() {
    let p = small(256, 0);
    let (mut owner, mut client, state, _) = setup(&p, Fault::None);
    let mut c = advance(&p, 1, None);
    if let ControlRow::SetRow(ref mut r) = c.rows[255] {
        r.0 = 254;
    }
    let rejected = run(
        &mut owner,
        &mut client,
        Operation::Application(CityCommand::Advance(Box::new(c))),
    );
    assert_eq!(rejected.outcome, Outcome::RejectedBeforeExecution);
    assert_eq!(state.borrow().advances, 0);
    let b = batch(run(
        &mut owner,
        &mut client,
        Operation::Application(CityCommand::Advance(Box::new(advance(&p, 1, None)))),
    ));
    let reject = run(
        &mut owner,
        &mut client,
        Operation::Application(CityCommand::Advance(Box::new(advance(&p, 1, None)))),
    );
    assert_eq!(reject.outcome, Outcome::RejectedBeforeExecution);
    assert_eq!(state.borrow().advances, 1);
    release(&mut owner, &mut client, &b);
}
#[test]
fn originals_export_with_typed_payload_join_and_live_buffers_block_release() {
    let p = small(2, 2);
    let (mut owner, mut client, state, _) = setup(&p, Fault::None);
    let b = batch(run(
        &mut owner,
        &mut client,
        Operation::Application(CityCommand::Advance(Box::new(advance(&p, 1, None)))),
    ));
    for slot in &b.slots {
        let SourceOutcome::Produced(slot) = slot else {
            panic!("produced")
        };
        let e = export(&mut owner, &mut client, &b, slot);
        assert_eq!(
            e.typed_manifest.original_payload_sha256,
            e.byte_manifest.payload_sha256
        );
        let read = run(
            &mut owner,
            &mut client,
            Operation::BufferRead(ReadInput {
                reference: e.byte_manifest.reference(),
                expected_manifest_digest: e.byte_manifest.manifest_digest.clone(),
                index: 0,
            }),
        );
        let Body::Chunk { data } = read.body else {
            panic!("chunk")
        };
        assert_eq!(data.decoded().unwrap(), vec![0; 256]);
        let rejected = run(
            &mut owner,
            &mut client,
            Operation::Application(CityCommand::ReleaseBatch(Box::new(ReleaseBatch {
                kind: "release_batch".into(),
                plan_digest: b.plan_digest.clone(),
                batch_digest: b.batch_digest.clone(),
                tick: 1,
            }))),
        );
        assert_eq!(rejected.outcome, Outcome::RejectedBeforeExecution);
        run(
            &mut owner,
            &mut client,
            Operation::BufferRelease(ReferenceInput {
                reference: e.byte_manifest.reference(),
            }),
        );
    }
    release(&mut owner, &mut client, &b);
    assert_eq!(state.borrow().advances, 1);
}
#[test]
fn actual_prior_originals_survive_known_source_failure_and_successful_finish_is_forbidden() {
    let p = small(2, 3);
    let (mut owner, mut client, state, prepared) = setup(&p, Fault::Source);
    let r = run(
        &mut owner,
        &mut client,
        Operation::Application(CityCommand::Advance(Box::new(advance(&p, 1, None)))),
    );
    assert!(matches!(
        r.body,
        Body::Application {
            data: CityResult::AdvanceFailed(_)
        }
    ));
    let b = batch(r);
    assert!(matches!(b.slots[0], SourceOutcome::Produced(_)));
    assert!(matches!(b.slots[1], SourceOutcome::Failed(_)));
    assert!(matches!(b.slots[2], SourceOutcome::Absent(_)));
    let SourceOutcome::Produced(slot) = &b.slots[0] else {
        unreachable!()
    };
    let e = export(&mut owner, &mut client, &b, slot);
    assert_eq!(e.byte_manifest.payload_sha256, hash(&vec![0; 256]));
    run(
        &mut owner,
        &mut client,
        Operation::BufferRelease(ReferenceInput {
            reference: e.byte_manifest.reference(),
        }),
    );
    release(&mut owner, &mut client, &b);
    let rejected = run(
        &mut owner,
        &mut client,
        Operation::Finish(Finish {
            plan_digest: prepared.plan_digest,
            completed_ticks: 1,
            last_released_batch_digest: b.batch_digest,
        }),
    );
    assert_eq!(rejected.outcome, Outcome::RejectedBeforeExecution);
    assert_eq!(state.borrow().advances, 1);
    assert_eq!(
        run(&mut owner, &mut client, Operation::Abort(w::Empty {})).outcome,
        Outcome::Committed
    );
}
#[test]
fn invalid_or_unavailable_required_native_output_retires_without_a_typed_partial_success() {
    for fault in [
        Fault::Advance,
        Fault::Foreign,
        Fault::Read,
        Fault::Hash,
        Fault::Release,
        Fault::Retire,
        Fault::Rows,
        Fault::Tensor,
    ] {
        let p = small(2, 3);
        let (mut owner, mut client, state, _) = setup(&p, fault);
        let r = run(
            &mut owner,
            &mut client,
            Operation::Application(CityCommand::Advance(Box::new(advance(&p, 1, None)))),
        );
        assert_eq!(r.outcome, Outcome::Indeterminate);
        assert_eq!(owner.lifecycle(), Lifecycle::Retired);
        assert_eq!(state.borrow().advances, 1);
        assert!(state.borrow().retires >= 1);
    }
}
#[test]
fn declared_backing_bytes_must_equal_actual_preparation_reservations() {
    let p = small(1, 0);
    let state = Rc::new(RefCell::new(State {
        fault: Fault::Backings,
        ..State::default()
    }));
    let app = App::new(Fake(Rc::clone(&state)), SOURCE.into(), RUN.into()).unwrap();
    let mut owner = Owner::new(binding(), app, vec![contract::semantic("rgba8").unwrap()]).unwrap();
    let mut client = Client::new(binding()).unwrap();
    let r = run(&mut owner, &mut client, Operation::Prepare(p));
    assert_eq!(r.outcome, Outcome::Indeterminate);
    assert_eq!(state.borrow().advances, 0);
    assert_eq!(state.borrow().retires, 1);
}
