//! Synthetic application controls use the actual generic owner and independent client.
use crebain_ncp_force_ground_sensors::{
    application::{due, payload_valid, validate_prepare, SensorApplication},
    contract::{self, Commitment},
    engine::{bridge_value, EngineBatch, EngineError, EnginePayload, EnginePort, EnginePrepared},
    types::*,
    Finite64,
};
use ncp_local::modular_buffer::BufferBinding;
use ncp_local::modular_client::Client;
use ncp_local::modular_owner::{self, AppOperation, AppResponse, Lifecycle, Owner};
use ncp_local::modular_wire::{self, Body, Operation, Outcome, ReadInput, ReferenceInput, Request};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone, Copy, Default)]
enum Fault {
    #[default]
    None,
    Advance,
    SecondPayload,
    Release,
    Retire,
    Order,
    Alias,
    Hash,
    Tick,
}
#[derive(Default)]
struct State {
    advances: usize,
    retires: usize,
    reads: usize,
    leases: usize,
    fault: Fault,
    prepared: Option<Prepare>,
    payloads: Vec<(String, Vec<u8>)>,
}
#[derive(Clone)]
struct Fake(Rc<RefCell<State>>);
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
impl EnginePort for Fake {
    fn prepare(&mut self, _: &str, _: &str, p: &Prepare) -> Result<EnginePrepared, EngineError> {
        self.0.borrow_mut().prepared = Some(p.clone());
        Ok(EnginePrepared {
            engine_owner_id: "44444444-4444-4444-8444-444444444444".into(),
            scene_sha256: "b".repeat(64),
        })
    }
    fn advance(
        &mut self,
        c: &AdvanceTick,
        previous: Option<&str>,
        _: &str,
    ) -> Result<EngineBatch, EngineError> {
        let mut state = self.0.borrow_mut();
        state.advances += 1;
        if matches!(state.fault, Fault::Advance) {
            return Err(EngineError);
        }
        let roster = due(state.prepared.as_ref().unwrap(), c.tick).unwrap();
        state.payloads = roster
            .iter()
            .map(|row| {
                let mut bytes = vec![0; row.bytes];
                if row.kind == "pressure" {
                    for block in bytes.chunks_exact_mut(8) {
                        block.copy_from_slice(&(-0.0_f64).to_le_bytes());
                    }
                }
                (row.sensor_id.clone(), bytes)
            })
            .collect();
        state.leases += 1;
        let mut payloads: Vec<_> = roster
            .iter()
            .zip(&state.payloads)
            .map(|(row, (_, bytes))| EnginePayload {
                sensor_id: row.sensor_id.clone(),
                kind: row.kind.into(),
                byte_length: row.bytes as u64,
                payload_sha256: hash(bytes),
            })
            .collect();
        match state.fault {
            Fault::Order => payloads.reverse(),
            Fault::Alias => payloads[0].sensor_id = "rgb:alias".into(),
            Fault::Hash => payloads[0].payload_sha256 = "f".repeat(64),
            _ => {}
        }
        Ok(EngineBatch {
            engine_owner_id: "44444444-4444-4444-8444-444444444444".into(),
            source_identity: "a".repeat(64),
            scene_sha256: "b".repeat(64),
            body_tick: c.tick + u64::from(matches!(state.fault, Fault::Tick)),
            engine_batch_sha256: hash(&c.tick.to_be_bytes()),
            previous_engine_batch_sha256: previous.map(str::to_owned),
            payloads,
        })
    }
    fn read_chunk(
        &mut self,
        _: u64,
        _: &str,
        sensor: &str,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, EngineError> {
        let mut state = self.0.borrow_mut();
        state.reads += 1;
        if matches!(state.fault, Fault::SecondPayload) && state.payloads[1].0 == sensor {
            return Err(EngineError);
        }
        Ok(state
            .payloads
            .iter()
            .find(|(id, _)| id == sensor)
            .unwrap()
            .1[offset..offset + count]
            .to_vec())
    }
    fn release_lease(&mut self, _: u64, _: &str) -> Result<(), EngineError> {
        let mut state = self.0.borrow_mut();
        if matches!(state.fault, Fault::Release) {
            return Err(EngineError);
        }
        state.leases -= 1;
        Ok(())
    }
    fn retire(&mut self) -> Result<(), EngineError> {
        let mut state = self.0.borrow_mut();
        state.retires += 1;
        if matches!(state.fault, Fault::Retire) {
            return Err(EngineError);
        }
        state.leases = 0;
        Ok(())
    }
}
type App = SensorApplication<Fake>;
fn binding() -> BufferBinding {
    BufferBinding {
        profile_digest: modular_owner::profile_digest().unwrap(),
        application_digest: modular_wire::typed_digest(
            modular_wire::PROFILE_DOMAIN,
            &modular_wire::parse_value(contract::DESCRIPTOR).unwrap(),
            None,
        )
        .unwrap(),
        run_id: "11111111-1111-4111-8111-111111111111".into(),
        endpoint_id: "22222222-2222-4222-8222-222222222222".into(),
        generation: "33333333-3333-4333-8333-333333333333".into(),
    }
}
fn prepare() -> Prepare {
    let workload: Value =
        serde_json::from_slice(include_bytes!("../../contracts/m1.workload.v1.json")).unwrap();
    serde_json::from_value(json!({"specification":workload["specification"],"planned_ticks":24,"composition_digest":contract::composition_digest().unwrap()})).unwrap()
}
fn small() -> Prepare {
    let mut p = prepare();
    for camera in p
        .specification
        .scene
        .rgb_cameras
        .iter_mut()
        .chain(&mut p.specification.scene.thermal_cameras)
    {
        camera.width = 8;
        camera.height = 8;
        camera.period_ticks = 1;
    }
    p.planned_ticks = 2;
    p
}
fn setup(p: Prepare) -> (Owner<App>, Client<App>, Rc<RefCell<State>>) {
    let state = Rc::new(RefCell::new(State::default()));
    let app = App::new(Fake(Rc::clone(&state)), "a".repeat(64)).unwrap();
    let mut owner = Owner::new(binding(), app, {
        let mut s: Vec<_> = ["rgba8", "radiance", "pressure"]
            .iter()
            .map(|k| contract::semantic(k).unwrap())
            .collect();
        s.sort();
        s
    })
    .unwrap();
    let mut client = Client::<App>::new(binding()).unwrap();
    assert_eq!(
        run(&mut owner, &mut client, Operation::Prepare(p)).outcome,
        Outcome::Committed
    );
    (owner, client, state)
}
fn run(
    owner: &mut Owner<App>,
    client: &mut Client<App>,
    op: AppOperation<App>,
) -> AppResponse<App> {
    let request = client.begin(op).unwrap().to_vec();
    let response = client.observe(owner.process(&request).unwrap()).unwrap();
    if response.outcome == Outcome::Committed {
        let ack = client.acknowledgement().unwrap();
        client
            .observe_acknowledgement(owner.process(&ack).unwrap())
            .unwrap();
    }
    response
}
fn advance(tick: u64, previous: Option<String>, accepted: Option<String>) -> AdvanceTick {
    AdvanceTick {
        kind: "advance_tick".into(),
        tick,
        previous_batch_digest: previous,
        action: accepted.map_or(
            Action::SetTarget {
                armed: true,
                roll_rad: Finite64::new(0.0).unwrap(),
                pitch_rad: Finite64::new(0.0).unwrap(),
                heading_rad: Finite64::new(0.0).unwrap(),
                altitude_m: Finite64::new(8.0).unwrap(),
            },
            |digest| Action::Hold {
                accepted_action_request_digest: digest,
            },
        ),
        capture_reservation: AdvanceTickCaptureReservation {
            kind: "absent".into(),
        },
    }
}
fn completed(response: AppResponse<App>) -> (SensorBatch, String) {
    match response.body {
        Body::Application {
            data:
                SensorResult::Advanced {
                    batch,
                    accepted_action_request_digest,
                    ..
                },
        } => (batch, accepted_action_request_digest),
        other => panic!("not advanced: {other:?}"),
    }
}
fn release(owner: &mut Owner<App>, client: &mut Client<App>, batch: &SensorBatch) {
    for slot in &batch.slots {
        if let SensorSlot::Due { byte_manifest, .. } = slot {
            assert_eq!(
                run(
                    owner,
                    client,
                    Operation::BufferRelease(ReferenceInput {
                        reference: byte_manifest.reference()
                    })
                )
                .outcome,
                Outcome::Committed
            );
        }
    }
}

#[test]
fn frozen_m1_arithmetic_and_signed_zero_payloads() {
    let p = prepare();
    validate_prepare(&p).unwrap();
    let mut totals = [0_usize; 4];
    let mut max_bytes = 0;
    let mut max_chunks = 0;
    for tick in 1..=24 {
        let roster = due(&p, tick).unwrap();
        let mut bytes = 0;
        let mut chunks = 0;
        for row in roster {
            bytes += row.bytes;
            chunks += row.bytes.div_ceil(32768);
            match row.kind {
                "rgba8" => totals[0] += 1,
                "radiance" => totals[1] += 1,
                _ => totals[2] += row.bytes / 8,
            }
        }
        totals[3] += bytes;
        max_bytes = max_bytes.max(bytes);
        max_chunks = max_chunks.max(chunks);
    }
    assert_eq!(totals, [12, 8, 3200, 4326400]);
    assert_eq!((max_bytes, max_chunks), (385072, 14));
    assert!(payload_valid("pressure", &(-0.0_f64).to_le_bytes()));
    assert!(payload_valid("radiance", &(-0.0_f32).to_le_bytes()));
    assert!(!payload_valid("pressure", &f64::NAN.to_le_bytes()));
    assert!(!payload_valid("radiance", &10_001_f32.to_le_bytes()));
    assert!(!payload_valid("pressure", &[0; 7]));
}

#[test]
fn full_admitted_clock_interval_is_adjacent_and_zero_period_is_rejected() {
    let mut p = small();
    p.planned_ticks = 7200;
    let mut previous = 0;
    for tick in 1..=7200 {
        let roster = due(&p, tick).unwrap();
        let Tensor::Pressure {
            sample_start,
            sample_end,
            shape,
            ..
        } = &roster.last().unwrap().tensor
        else {
            panic!("pressure omitted")
        };
        assert_eq!(*sample_start, previous);
        assert_eq!(
            sample_end - sample_start,
            if tick % 3 == 0 { 134 } else { 133 }
        );
        assert_eq!(shape[0], sample_end - sample_start);
        previous = *sample_end;
    }
    assert_eq!(previous, 960000);
    p.specification.scene.rgb_cameras[0].period_ticks = 0;
    assert!(due(&p, 1).is_err());
    p.specification.scene.rgb_cameras[0].period_ticks = 1;
    assert!(due(&p, 1).is_ok());
}

#[test]
fn prepared_source_bounds_have_passing_neighbors() {
    let p = small();
    validate_prepare(&p).unwrap();
    let mut bad = p.clone();
    bad.specification.scene.thermal_cameras[0].width = 321;
    assert!(validate_prepare(&bad).is_err());
    bad.specification.scene.thermal_cameras[0].width = 320;
    validate_prepare(&bad).unwrap();
    bad = p.clone();
    bad.specification.acoustic.reference_distance_m = Finite64::new(33.0).unwrap();
    assert!(validate_prepare(&bad).is_err());
    bad.specification.acoustic.reference_distance_m = Finite64::new(32.0).unwrap();
    validate_prepare(&bad).unwrap();
    bad = p.clone();
    bad.specification
        .scene
        .rgb_cameras
        .push(bad.specification.scene.rgb_cameras[0].clone());
    assert!(validate_prepare(&bad).is_err());
    bad.specification.scene.rgb_cameras[1].id = "rgb-b".into();
    validate_prepare(&bad).unwrap();
    bad.specification.scene.rgb_cameras.reverse();
    assert!(validate_prepare(&bad).is_err());
}

#[test]
fn every_nonempty_modality_subset_releases_its_native_lease() {
    for mask in 1_u8..8 {
        let mut p = small();
        let scene = &mut p.specification.scene;
        if mask & 1 == 0 {
            scene.rgb_cameras.clear();
        }
        if mask & 2 == 0 {
            scene.thermal_cameras.clear();
        }
        if mask & 4 == 0 {
            scene.microphones.clear();
        }
        for camera in scene
            .rgb_cameras
            .iter_mut()
            .chain(&mut scene.thermal_cameras)
        {
            camera.period_ticks = 2;
        }
        validate_prepare(&p).unwrap();
        let (mut owner, mut client, state) = setup(p);
        let mut previous = None;
        let mut accepted = None;
        for tick in 1..=2 {
            let response = run(
                &mut owner,
                &mut client,
                Operation::Application(advance(tick, previous, accepted)),
            );
            let (batch, action) = completed(response);
            assert_eq!(batch.slots.len(), mask.count_ones() as usize);
            let due_count = batch
                .slots
                .iter()
                .filter(|slot| matches!(slot, SensorSlot::Due { .. }))
                .count();
            assert_eq!(
                due_count,
                if tick == 1 {
                    usize::from(mask & 4 != 0)
                } else {
                    mask.count_ones() as usize
                }
            );
            assert_eq!(state.borrow().leases, 0);
            release(&mut owner, &mut client, &batch);
            previous = Some(batch.batch_digest);
            accepted = Some(action);
        }
        assert_eq!(state.borrow().advances, 2);
    }
}

#[test]
fn empty_sensor_selection_rejects_and_repeated_modalities_keep_their_ids() {
    let mut p = small();
    p.specification.scene.thermal_cameras.clear();
    p.specification.scene.microphones.clear();
    p.specification.scene.rgb_cameras.clear();
    assert!(validate_prepare(&p).is_err());
    let camera = small().specification.scene.rgb_cameras.remove(0);
    for index in 0..4 {
        let mut instance = camera.clone();
        instance.id = format!("camera-{index}");
        p.specification.scene.rgb_cameras.push(instance);
        validate_prepare(&p).unwrap();
        let (mut owner, mut client, _) = setup(p.clone());
        let (batch, _) = completed(run(
            &mut owner,
            &mut client,
            Operation::Application(advance(1, None, None)),
        ));
        let ids: Vec<_> = batch
            .slots
            .iter()
            .map(|slot| match slot {
                SensorSlot::Due { sensor_id, .. } => sensor_id.clone(),
                _ => panic!("configured camera omitted"),
            })
            .collect();
        assert_eq!(
            ids,
            (0..=index)
                .map(|i| format!("rgb:camera-{i}"))
                .collect::<Vec<_>>()
        );
        release(&mut owner, &mut client, &batch);
    }
    let mut duplicate = p.clone();
    duplicate.specification.scene.rgb_cameras[1].id = "camera-0".into();
    assert!(validate_prepare(&duplicate).is_err());
    let mut fifth = camera;
    fifth.id = "camera-4".into();
    p.specification.scene.rgb_cameras.push(fifth);
    assert!(validate_prepare(&p).is_err());
}

#[test]
fn replay_ack_and_explicit_release_preserve_byte_identity() {
    let (mut owner, mut client, state) = setup(small());
    let request = client
        .begin(Operation::Application(advance(1, None, None)))
        .unwrap()
        .to_vec();
    let first = owner.process(&request).unwrap().to_vec();
    assert_eq!(owner.process(&request).unwrap(), first);
    assert_eq!(state.borrow().advances, 1);
    let (batch, accepted) = completed(client.observe(&first).unwrap());
    let reserved = owner.usage().reserved_bytes;
    assert!(reserved > 0);
    let ack = client.acknowledgement().unwrap();
    client
        .observe_acknowledgement(owner.process(&ack).unwrap())
        .unwrap();
    assert_eq!(owner.usage().reserved_bytes, reserved);
    let blocked = run(
        &mut owner,
        &mut client,
        Operation::Application(advance(
            2,
            Some(batch.batch_digest.clone()),
            Some(accepted.clone()),
        )),
    );
    assert_eq!(blocked.outcome, Outcome::RejectedBeforeExecution);
    assert_eq!(state.borrow().advances, 1);
    for slot in &batch.slots {
        if let SensorSlot::Due {
            sensor_id,
            byte_manifest,
            ..
        } = slot
        {
            let response = run(
                &mut owner,
                &mut client,
                Operation::BufferRead(ReadInput {
                    reference: byte_manifest.reference(),
                    expected_manifest_digest: byte_manifest.manifest_digest.clone(),
                    index: 0,
                }),
            );
            let Body::Chunk { data } = response.body else {
                panic!("missing chunk")
            };
            let actual = data.decoded().unwrap();
            assert_eq!(
                &actual,
                &state
                    .borrow()
                    .payloads
                    .iter()
                    .find(|(id, _)| id == sensor_id)
                    .unwrap()
                    .1
            );
        }
    }
    release(&mut owner, &mut client, &batch);
    assert_eq!(owner.usage().reserved_bytes, 0);
    let (last, _) = completed(run(
        &mut owner,
        &mut client,
        Operation::Application(advance(2, Some(batch.batch_digest), Some(accepted))),
    ));
    let blocked = run(
        &mut owner,
        &mut client,
        Operation::Finish(Finish {
            plan_digest: last.plan_digest.clone(),
            completed_ticks: 2,
            last_batch_digest: last.batch_digest.clone(),
        }),
    );
    assert_eq!(blocked.outcome, Outcome::RejectedBeforeExecution);
    release(&mut owner, &mut client, &last);
    let terminal = run(
        &mut owner,
        &mut client,
        Operation::Finish(Finish {
            plan_digest: last.plan_digest,
            completed_ticks: 2,
            last_batch_digest: last.batch_digest,
        }),
    );
    assert!(matches!(
        terminal.body,
        Body::Finished {
            data: Terminal {
                scientific_validation: false,
                ..
            }
        }
    ));
}

#[test]
fn retained_engine_faults_never_admit_a_following_advance() {
    for fault in [
        Fault::Advance,
        Fault::SecondPayload,
        Fault::Release,
        Fault::Order,
        Fault::Alias,
        Fault::Hash,
        Fault::Tick,
    ] {
        let (mut owner, mut client, state) = setup(small());
        let (prior, accepted) = completed(run(
            &mut owner,
            &mut client,
            Operation::Application(advance(1, None, None)),
        ));
        release(&mut owner, &mut client, &prior);
        state.borrow_mut().fault = fault;
        let request = client
            .begin(Operation::Application(advance(
                2,
                Some(prior.batch_digest.clone()),
                Some(accepted),
            )))
            .unwrap()
            .to_vec();
        let bytes = owner.process(&request).unwrap().to_vec();
        let response = AppResponse::<App>::decode(&bytes, &binding()).unwrap();
        assert_eq!(response.outcome, Outcome::Indeterminate);
        assert_eq!(owner.lifecycle(), Lifecycle::Retired);
        assert_eq!(state.borrow().advances, 2);
        assert!(state.borrow().retires >= 1);
        assert_eq!(owner.process(&request).unwrap(), bytes);
        assert_eq!(state.borrow().advances, 2);
        assert_eq!(prior.body_tick, 1);
    }
}

#[test]
fn retirement_failure_cannot_become_successful_finish() {
    let mut p = small();
    p.planned_ticks = 1;
    let (mut owner, mut client, state) = setup(p);
    let (batch, _) = completed(run(
        &mut owner,
        &mut client,
        Operation::Application(advance(1, None, None)),
    ));
    release(&mut owner, &mut client, &batch);
    state.borrow_mut().fault = Fault::Retire;
    let response = run(
        &mut owner,
        &mut client,
        Operation::Finish(Finish {
            plan_digest: batch.plan_digest,
            completed_ticks: 1,
            last_batch_digest: batch.batch_digest,
        }),
    );
    assert_eq!(response.outcome, Outcome::Indeterminate);
    assert_eq!(owner.lifecycle(), Lifecycle::Retired);
}

fn reseal_response(mut value: Value) -> Vec<u8> {
    let batch = &mut value["body"]["data"]["batch"];
    for slot in batch["slots"].as_array_mut().unwrap() {
        if slot["kind"] == "due" {
            let typed = &mut slot["typed_manifest"];
            typed["manifest_digest"] = contract::commit(Commitment::Manifest, typed)
                .unwrap()
                .into();
        }
    }
    batch["batch_digest"] = contract::commit(Commitment::Batch, batch).unwrap().into();
    value["result_digest"] =
        modular_wire::typed_digest(modular_wire::RESPONSE_SCHEMA, &value, Some("result_digest"))
            .unwrap()
            .into();
    serde_json::to_vec(&value).unwrap()
}

#[test]
fn recomputed_commitments_cannot_hide_typed_tensor_or_source_substitution() {
    let (mut owner, mut client, _) = setup(small());
    let bytes = client
        .begin(Operation::Application(advance(1, None, None)))
        .unwrap()
        .to_vec();
    let request = Request::<AppOperation<App>>::decode(&bytes, &binding()).unwrap();
    let valid = owner.process(&bytes).unwrap().to_vec();
    modular_owner::verify_response::<App>(&binding(), &request, &valid).unwrap();
    let original: Value = serde_json::from_slice(&valid).unwrap();
    for change in 0..7 {
        let mut value = original.clone();
        match change {
            0 => {
                value["body"]["data"]["batch"]["slots"][0]["typed_manifest"]["tensor"]["shape"][0] =
                    9.into()
            }
            1 => {
                value["body"]["data"]["batch"]["slots"][0]["typed_manifest"]["source_body_tick"] =
                    2.into()
            }
            2 => {
                value["body"]["data"]["batch"]["slots"][0]["typed_manifest"]
                    ["sensor_contract_digest"] = contract::semantic("pressure").unwrap().into()
            }
            3 => {
                let first = value["body"]["data"]["batch"]["slots"][0].clone();
                value["body"]["data"]["batch"]["slots"][1] = first;
            }
            4 => {
                value["body"]["data"]["batch"]["slots"][2]["typed_manifest"]["tensor"]
                    ["sample_end"] = 134.into()
            }
            5 => {
                value["body"]["data"]["batch"]["slots"][0]["typed_manifest"]
                    ["engine_batch_sha256"] = "e".repeat(64).into()
            }
            _ => {
                value["body"]["data"]["batch"]["slots"][2] = json!({
                    "kind": "not_due", "sensor_id": "pressure:mic-a", "next_due_tick": null
                });
            }
        }
        assert!(modular_owner::verify_response::<App>(
            &binding(),
            &request,
            &reseal_response(value)
        )
        .is_err());
    }
}

#[test]
fn float_bridge_and_commitment_kinds_preserve_the_existing_projection() {
    let positive = Finite64::new(0.0).unwrap();
    let negative = Finite64::new(-0.0).unwrap();
    assert_ne!(positive, negative);
    assert_eq!(
        bridge_value(&negative).unwrap(),
        json!({"f64":"8000000000000000"})
    );
    let integer = contract::commit(Commitment::Plan, &json!({"x":0})).unwrap();
    assert_eq!(
        integer,
        contract::commit(Commitment::Plan, &json!({"x":0.0})).unwrap()
    );
    assert_ne!(
        integer,
        contract::commit(Commitment::Plan, &json!({"x":-0.0})).unwrap()
    );
    assert_ne!(
        integer,
        contract::commit(Commitment::Catalog, &json!({"x":0})).unwrap()
    );
    assert_ne!(
        contract::semantic("rgba8").unwrap(),
        contract::semantic("radiance").unwrap()
    );
    assert_ne!(
        contract::semantic("pressure").unwrap(),
        contract::semantic("radiance").unwrap()
    );
}

#[test]
fn independent_python_vectors_rejoin_actual_rust_prepare_outputs() {
    let Some(path) = std::env::var_os("CREBAIN_SENSOR_NUMERIC_VECTORS") else {
        return;
    };
    let vectors: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let p: Prepare = serde_json::from_value(case["prepare"].clone()).unwrap();
        let state = Rc::new(RefCell::new(State::default()));
        let app = App::new(Fake(state), "a".repeat(64)).unwrap();
        let mut owner = Owner::new(binding(), app, {
            let mut s: Vec<_> = ["rgba8", "radiance", "pressure"]
                .iter()
                .map(|k| contract::semantic(k).unwrap())
                .collect();
            s.sort();
            s
        })
        .unwrap();
        let mut client = Client::<App>::new(binding()).unwrap();
        let result = run(&mut owner, &mut client, Operation::Prepare(p));
        let Body::Prepared {
            data:
                SensorResult::Prepared {
                    plan_digest,
                    sensor_catalog,
                    ..
                },
        } = result.body
        else {
            panic!("missing preparation")
        };
        assert_eq!(plan_digest, case["plan_digest"].as_str().unwrap());
        assert_eq!(
            sensor_catalog.catalog_digest,
            case["catalog_digest"].as_str().unwrap()
        );
        let expected: SensorCatalog = serde_json::from_value(case["catalog"].clone()).unwrap();
        assert_eq!(sensor_catalog, expected);
    }
}

/// Test-only adversarial adapter changes a typed result after successful execution.
struct CorruptAfterExecute(App);
impl modular_owner::Contract for CorruptAfterExecute {
    type Prepare = Prepare;
    type Command = AdvanceTick;
    type ImportDescriptor = Never;
    type ImportMetadata = Never;
    type Finish = Finish;
    type Result = SensorResult;
    type Imported = Never;
    type Terminal = Terminal;
    fn descriptor() -> &'static [u8] {
        <App as modular_owner::Contract>::descriptor()
    }
    fn allows(operation: modular_wire::OperationName) -> bool {
        <App as modular_owner::Contract>::allows(operation)
    }
    fn check_input(operation: &AppOperation<Self>) -> Result<(), modular_wire::ModularError> {
        <App as modular_owner::Contract>::check_input(operation)
    }
    fn check_response(
        operation: &AppOperation<Self>,
        body: &modular_owner::AppBody<Self>,
        context: &modular_owner::ExecutionContext,
    ) -> Result<(), modular_wire::ModularError> {
        <App as modular_owner::Contract>::check_response(operation, body, context)
    }
    fn check_import_metadata(
        descriptor: &Never,
        _: &Never,
    ) -> Result<(), modular_wire::ModularError> {
        match *descriptor {}
    }
}
impl modular_owner::Application for CorruptAfterExecute {
    fn admit(
        &self,
        operation: &AppOperation<Self>,
        view: &modular_owner::AdmissionView<'_>,
    ) -> Result<modular_owner::AdmissionDemand, modular_wire::Code> {
        modular_owner::Application::admit(&self.0, operation, view)
    }
    fn execute(
        &mut self,
        operation: &AppOperation<Self>,
        permit: &mut modular_owner::ExecutionPermit<'_, '_>,
    ) -> Result<modular_owner::ApplicationOutput<SensorResult, Terminal>, modular_wire::Diagnostic>
    {
        let mut output = modular_owner::Application::execute(&mut self.0, operation, permit)?;
        if let modular_owner::ApplicationOutput::Result(SensorResult::Advanced { batch, .. }) =
            &mut output
        {
            if let SensorSlot::Due { typed_manifest, .. } = &mut batch.slots[0] {
                if let Tensor::Rgba8 { shape, .. } = &mut typed_manifest.tensor {
                    shape[0] += 1;
                }
                typed_manifest.manifest_digest =
                    contract::commit(Commitment::Manifest, typed_manifest).unwrap();
            }
            batch.batch_digest = contract::commit(Commitment::Batch, batch).unwrap();
        }
        Ok(output)
    }
    fn split_import<'a>(
        &'a self,
        descriptor: &'a Never,
    ) -> Result<modular_owner::ImportSource<'a, Never>, modular_wire::Code> {
        match *descriptor {}
    }
    fn validate_import(
        &self,
        metadata: &Never,
        _: &ncp_local::modular_buffer::BufferManifest,
        _: &[u8],
    ) -> Result<Never, modular_wire::Code> {
        match *metadata {}
    }
}

#[test]
fn invalid_result_after_successful_engine_advance_retires_the_core() {
    let state = Rc::new(RefCell::new(State::default()));
    let mut host_retirement = Fake(Rc::clone(&state));
    let app = App::new(Fake(Rc::clone(&state)), "a".repeat(64)).unwrap();
    let mut semantics: Vec<_> = ["rgba8", "radiance", "pressure"]
        .iter()
        .map(|k| contract::semantic(k).unwrap())
        .collect();
    semantics.sort();
    let mut owner = Owner::new(binding(), CorruptAfterExecute(app), semantics).unwrap();
    let mut client = Client::<App>::new(binding()).unwrap();
    let prepare_request = client.begin(Operation::Prepare(small())).unwrap().to_vec();
    client
        .observe(owner.process(&prepare_request).unwrap())
        .unwrap();
    let ack = client.acknowledgement().unwrap();
    client
        .observe_acknowledgement(owner.process(&ack).unwrap())
        .unwrap();
    let advance_request = client
        .begin(Operation::Application(advance(1, None, None)))
        .unwrap()
        .to_vec();
    let response = owner.process(&advance_request).unwrap().to_vec();
    assert_eq!(
        AppResponse::<App>::decode(&response, &binding())
            .unwrap()
            .outcome,
        Outcome::Indeterminate
    );
    assert_eq!(owner.lifecycle(), Lifecycle::Retired);
    assert_eq!((state.borrow().advances, state.borrow().leases), (1, 0));
    // The host owns a separate local retirement handle for this exact case.
    host_retirement.retire().unwrap();
    assert_eq!(state.borrow().retires, 1);
    assert_eq!(owner.process(&advance_request).unwrap(), response);
    let next = Request::encode(
        binding(),
        owner.high_water() + 1,
        modular_wire::Command::Execute {
            expected_predecessor_result_digest: owner.predecessor().map(str::to_owned),
            operation: Operation::<Prepare, AdvanceTick, Never, Finish>::Application(advance(
                2, None, None,
            )),
        },
    )
    .unwrap();
    assert_ne!(
        AppResponse::<App>::decode(owner.process(&next).unwrap(), &binding())
            .unwrap()
            .outcome,
        Outcome::Committed
    );
    assert_eq!(state.borrow().advances, 1);
}
