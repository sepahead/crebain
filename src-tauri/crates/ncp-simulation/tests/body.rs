//! The `crebain.body` owner against the kernel it wraps.

use crebain_managed_simulation::{
    FaultCode, InnovationRecording, MultiDroneSimulation, PrepareRequest, StepRequest,
};
use crebain_ncp_simulation::body::{
    Body, PrepareBody, Proposal, ScheduledInput, StepBody, KERNEL_RUN_ID,
};
use crebain_ncp_simulation::{body_contract, BODY_APPLICATION};
use ncp::binding::ChildChannel;
use ncp::{Client, Error, Owner, DEFAULT_BOUND};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

const BINARY: &str = env!("CARGO_BIN_EXE_crebain-ncp-simulation");
const RESPONSE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn ids(n: usize) -> Vec<String> {
    ["alpha", "bravo", "charlie", "delta"][..n]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn prepare_body(n: usize, steps: u64) -> PrepareBody {
    PrepareBody {
        drone_ids: ids(n),
        tick_ms: 20,
        planned_steps: steps,
        initial_position_m: (0..n).flat_map(|i| [i as f64 * 10.0, 5.0, 20.0]).collect(),
        initial_velocity_mps: (0..n).flat_map(|i| [1.0, 0.5 * i as f64, 0.0]).collect(),
        sensor_variance_m2: vec![0.04; n * 3],
        schedule: Vec::new(),
    }
}

fn open() -> (Client<ChildChannel>, std::process::Child) {
    let (channel, child) = ncp::spawn(Command::new(BINARY)).expect("spawn the body");
    let contract = body_contract();
    let mut client = Client::new(channel, BODY_APPLICATION, &contract.identity);
    client.open().expect("open");
    (client, child)
}

fn call(client: &mut Client<ChildChannel>, op: &str, body: Value) -> Result<Value, Error> {
    client
        .call(op, body, &[])
        .map(|d| d.message["body"].clone())
}

fn accelerations(n: usize, tick: u64) -> Vec<f64> {
    (0..n * 3)
        .map(|i| ((i as f64 + 1.0) * 0.3 * (tick as f64 * 0.7).sin()).clamp(-5.0, 5.0))
        .collect()
}

fn step_body(n: usize, tick: u64, digest: &str) -> StepBody {
    StepBody {
        tick_index: tick,
        source_state_digest: digest.to_owned(),
        actuator_intent_acceleration_mps2: accelerations(n, tick),
        proposals: vec![Proposal {
            response: RESPONSE.into(),
            drone_ids: ids(n),
        }],
    }
}

fn kernel_prepare(body: &PrepareBody) -> PrepareRequest {
    PrepareRequest {
        schema_version: "crebain.simulation.prepare-request.v1".into(),
        run_id: KERNEL_RUN_ID.into(),
        drone_ids: body.drone_ids.clone(),
        tick_ms: body.tick_ms,
        max_ticks: body.planned_steps,
        initial_position_m: body.initial_position_m.clone(),
        initial_velocity_mps: body.initial_velocity_mps.clone(),
        sensor_variance_m2: body.sensor_variance_m2.clone(),
    }
}

fn kernel_step(n: usize, tick: u64, faults: Vec<FaultCode>, offsets: Vec<f64>) -> StepRequest {
    StepRequest {
        schema_version: "crebain.simulation.step-request.v1".into(),
        run_id: KERNEL_RUN_ID.into(),
        tick_index: tick,
        drone_ids: ids(n),
        actuator_intent_acceleration_mps2: accelerations(n, tick),
        sensor_offset_m: offsets,
        fault_codes: faults,
    }
}

fn digest(result: &Value) -> String {
    result["observation"]["state_digest"]
        .as_str()
        .expect("state digest")
        .to_owned()
}

#[test]
fn one_to_three_drones_match_the_kernel_frame_for_frame() {
    for n in 1..=3 {
        let steps = 12;
        let body = prepare_body(n, steps);
        let (mut client, mut child) = open();
        let mut result = call(&mut client, "prepare", json!(body)).expect("prepare");
        let (mut kernel, frame) = MultiDroneSimulation::new()
            .prepare_with_recording(
                kernel_prepare(&body),
                InnovationRecording::KalmanInnovationV1,
            )
            .expect("direct prepare");
        assert_eq!(result["frame"], json!(frame));
        assert_eq!(result["innovations"], json!(kernel.latest_innovations()));
        for tick in 1..=steps {
            let request = step_body(n, tick, &digest(&result));
            result = call(&mut client, "step", json!(request)).expect("step");
            let frame = kernel
                .step(kernel_step(
                    n,
                    tick,
                    vec![FaultCode::None; n],
                    vec![0.0; n * 3],
                ))
                .expect("direct step");
            assert_eq!(result["frame"], json!(frame), "{n} drones, step {tick}");
            assert_eq!(result["innovations"], json!(kernel.latest_innovations()));
            assert_eq!(result["observation"]["tick_index"], tick);
            assert_eq!(digest(&result), frame.state_digest);
        }
        let finish =
            call(&mut client, "finish", json!({"completed_steps": steps})).expect("finish");
        assert_eq!(finish["finish"]["cleaned_up"], true);
        assert_eq!(finish["completed_steps"], steps);
        client.close().expect("close");
        assert!(child.wait().expect("exit").success());
    }
}

#[test]
fn the_frozen_schedule_drops_sensors_and_holds_actuators_as_the_kernel_does() {
    let n = 2;
    let mut body = prepare_body(n, 4);
    body.schedule = vec![
        ScheduledInput {
            step: 2,
            drone_id: "alpha".into(),
            sensor_offset_m: [0.5, 0.0, -0.5],
            sensor_available: false,
            actuator_available: true,
        },
        ScheduledInput {
            step: 2,
            drone_id: "bravo".into(),
            sensor_offset_m: [0.0; 3],
            sensor_available: true,
            actuator_available: false,
        },
        ScheduledInput {
            step: 3,
            drone_id: "alpha".into(),
            sensor_offset_m: [0.0; 3],
            sensor_available: false,
            actuator_available: false,
        },
    ];
    let (mut client, mut child) = open();
    let mut result = call(&mut client, "prepare", json!(body)).expect("prepare");
    let (mut kernel, _) = MultiDroneSimulation::new()
        .prepare_with_recording(
            kernel_prepare(&body),
            InnovationRecording::KalmanInnovationV1,
        )
        .expect("direct prepare");
    let faults = [
        vec![FaultCode::None, FaultCode::None],
        vec![FaultCode::SensorDropout, FaultCode::ActuatorHold],
        vec![FaultCode::Combined, FaultCode::None],
        vec![FaultCode::None, FaultCode::None],
    ];
    for tick in 1..=4u64 {
        let mut offsets = vec![0.0; n * 3];
        if tick == 2 {
            offsets[..3].copy_from_slice(&[0.5, 0.0, -0.5]);
        }
        result = call(
            &mut client,
            "step",
            json!(step_body(n, tick, &digest(&result))),
        )
        .expect("step");
        let frame = kernel
            .step(kernel_step(
                n,
                tick,
                faults[tick as usize - 1].clone(),
                offsets,
            ))
            .expect("direct step");
        assert_eq!(result["frame"], json!(frame), "step {tick}");
    }
    client.close().expect("close");
    assert!(child.wait().expect("exit").success());
}

#[test]
fn a_dropped_sensor_hides_the_estimate_from_the_observation() {
    let mut body = prepare_body(1, 2);
    body.schedule = vec![ScheduledInput {
        step: 1,
        drone_id: "alpha".into(),
        sensor_offset_m: [0.0; 3],
        sensor_available: false,
        actuator_available: true,
    }];
    let (mut client, mut child) = open();
    let prepared = call(&mut client, "prepare", json!(body)).expect("prepare");
    assert_eq!(prepared["observation"]["estimate_available"], json!([true]));
    let dropped = call(
        &mut client,
        "step",
        json!(step_body(1, 1, &digest(&prepared))),
    )
    .expect("step");
    assert_eq!(dropped["observation"]["estimate_available"], json!([false]));
    assert_eq!(dropped["observation"]["position_m"], json!([0.0, 0.0, 0.0]));
    let back = call(
        &mut client,
        "step",
        json!(step_body(1, 2, &digest(&dropped))),
    )
    .expect("step");
    assert_eq!(back["observation"]["estimate_available"], json!([true]));
    client.close().expect("close");
    assert!(child.wait().expect("exit").success());
}

fn rejected(result: Result<Value, Error>, what: &str) {
    match result {
        Err(Error::Rejected { .. }) => {}
        other => panic!("{what}: expected a rejection, got {other:?}"),
    }
}

#[test]
fn invalid_steps_are_rejected_and_change_nothing() {
    let n = 2;
    let body = prepare_body(n, 3);
    let (mut client, mut child) = open();
    let prepared = call(&mut client, "prepare", json!(body)).expect("prepare");
    let current = digest(&prepared);
    let good = step_body(n, 1, &current);

    let mut stale = good.clone();
    stale.source_state_digest = RESPONSE.into();
    rejected(call(&mut client, "step", json!(stale)), "stale state");
    let mut skip = good.clone();
    skip.tick_index = 2;
    rejected(call(&mut client, "step", json!(skip)), "skipped step");
    let mut missing = good.clone();
    missing.proposals[0].drone_ids = vec!["alpha".into()];
    rejected(
        call(&mut client, "step", json!(missing)),
        "a drone without a proposal",
    );
    let mut twice = good.clone();
    twice.proposals = vec![
        Proposal {
            response: RESPONSE.into(),
            drone_ids: vec!["alpha".into()],
        },
        Proposal {
            response: RESPONSE.replace('0', "1"),
            drone_ids: vec!["alpha".into(), "bravo".into()],
        },
    ];
    rejected(
        call(&mut client, "step", json!(twice)),
        "a drone in two proposals",
    );
    let mut same = good.clone();
    same.proposals = vec![
        Proposal {
            response: RESPONSE.into(),
            drone_ids: vec!["alpha".into()],
        },
        Proposal {
            response: RESPONSE.into(),
            drone_ids: vec!["bravo".into()],
        },
    ];
    rejected(
        call(&mut client, "step", json!(same)),
        "one response named twice",
    );
    let mut unknown = good.clone();
    unknown.proposals[0].drone_ids = vec!["alpha".into(), "zulu".into()];
    rejected(
        call(&mut client, "step", json!(unknown)),
        "an unknown drone",
    );
    let mut not_identity = good.clone();
    not_identity.proposals[0].response = "ABC".into();
    rejected(
        call(&mut client, "step", json!(not_identity)),
        "a response that is not an identity",
    );
    let mut too_strong = good.clone();
    too_strong.actuator_intent_acceleration_mps2[0] = 50.5;
    rejected(
        call(&mut client, "step", json!(too_strong)),
        "an acceleration above 50",
    );
    let mut negative_zero = good.clone();
    negative_zero.actuator_intent_acceleration_mps2[1] = -0.0;
    rejected(
        call(&mut client, "step", json!(negative_zero)),
        "a negative zero, which the kernel rejects",
    );
    let mut short = good.clone();
    short.actuator_intent_acceleration_mps2.pop();
    rejected(
        call(&mut client, "step", json!(short)),
        "too few components",
    );
    rejected(
        call(&mut client, "step", json!({"tick_index": 1})),
        "a malformed body",
    );
    rejected(
        call(&mut client, "prepare", json!(body)),
        "a second prepare",
    );
    rejected(
        call(&mut client, "finish", json!({"completed_steps": 0})),
        "an early finish",
    );

    // Positive control: nothing changed, so the valid step still equals the kernel's first step.
    let result = call(&mut client, "step", json!(good)).expect("the valid step");
    let (mut kernel, _) = MultiDroneSimulation::new()
        .prepare_with_recording(
            kernel_prepare(&body),
            InnovationRecording::KalmanInnovationV1,
        )
        .expect("direct prepare");
    let frame = kernel
        .step(kernel_step(
            n,
            1,
            vec![FaultCode::None; n],
            vec![0.0; n * 3],
        ))
        .expect("direct step");
    assert_eq!(result["frame"], json!(frame));
    client.close().expect("close");
    assert!(child.wait().expect("exit").success());
}

#[test]
fn invalid_preparations_are_rejected_before_any_state() {
    let (mut client, mut child) = open();
    rejected(
        call(&mut client, "step", json!(step_body(1, 1, RESPONSE))),
        "a step before prepare",
    );
    let mut cases: Vec<(&str, PrepareBody)> = Vec::new();
    let mut unsorted = prepare_body(2, 4);
    unsorted.drone_ids.reverse();
    cases.push(("unsorted drones", unsorted));
    let mut repeated = prepare_body(2, 4);
    repeated.drone_ids[1] = "alpha".into();
    cases.push(("a repeated drone", repeated));
    let mut four = prepare_body(3, 4);
    four.drone_ids = ids(4);
    four.initial_position_m.extend([0.0; 3]);
    four.initial_velocity_mps.extend([0.0; 3]);
    four.sensor_variance_m2.extend([0.04; 3]);
    cases.push(("four drones", four));
    let mut grammar = prepare_body(1, 4);
    grammar.drone_ids = vec!["Alpha".into()];
    cases.push(("an identifier with a capital letter", grammar));
    let row = ScheduledInput {
        step: 1,
        drone_id: "alpha".into(),
        sensor_offset_m: [0.0; 3],
        sensor_available: true,
        actuator_available: true,
    };
    for (what, change) in [
        (
            "a schedule row at step 0",
            ScheduledInput {
                step: 0,
                ..row.clone()
            },
        ),
        (
            "a schedule row after the plan",
            ScheduledInput {
                step: 5,
                ..row.clone()
            },
        ),
        (
            "a schedule row of an unknown drone",
            ScheduledInput {
                drone_id: "zulu".into(),
                ..row.clone()
            },
        ),
        (
            "an offset above 50 m",
            ScheduledInput {
                sensor_offset_m: [0.0, 50.5, 0.0],
                ..row.clone()
            },
        ),
    ] {
        let mut body = prepare_body(1, 4);
        body.schedule = vec![change];
        cases.push((what, body));
    }
    let mut unordered = prepare_body(1, 4);
    unordered.schedule = vec![
        ScheduledInput {
            step: 2,
            ..row.clone()
        },
        row.clone(),
    ];
    cases.push(("an unordered schedule", unordered));
    let mut zero_tick = prepare_body(1, 4);
    zero_tick.tick_ms = 0;
    cases.push(("a step of 0 ms", zero_tick));
    let mut long = prepare_body(1, 1025);
    long.planned_steps = 1025;
    cases.push(("1025 steps", long));
    for (what, body) in cases {
        rejected(call(&mut client, "prepare", json!(body)), what);
    }
    // Positive control: a valid preparation on the same session.
    call(&mut client, "prepare", json!(prepare_body(1, 4))).expect("a valid prepare");
    client.close().expect("close");
    assert!(child.wait().expect("exit").success());
}

#[test]
fn a_finished_run_accepts_nothing_more() {
    let (mut client, mut child) = open();
    let mut result = call(&mut client, "prepare", json!(prepare_body(1, 2))).expect("prepare");
    for tick in 1..=2 {
        result = call(
            &mut client,
            "step",
            json!(step_body(1, tick, &digest(&result))),
        )
        .expect("step");
    }
    rejected(
        call(
            &mut client,
            "step",
            json!(step_body(1, 3, &digest(&result))),
        ),
        "a step after the plan",
    );
    let finish = call(&mut client, "finish", json!({"completed_steps": 2})).expect("finish");
    assert_eq!(finish["finish"]["state_digest"], digest(&result));
    rejected(
        call(&mut client, "finish", json!({"completed_steps": 2})),
        "a second finish",
    );
    rejected(
        call(&mut client, "prepare", json!(prepare_body(1, 2))),
        "a prepare after finish",
    );
    client.close().expect("close");
    assert!(child.wait().expect("exit").success());
}

/// Request frames by hand, to send one frame twice.
fn frame(session: &str, seq: u64, op: &str, ack: Option<&str>, body: Value) -> Vec<u8> {
    ncp::encode(
        &json!({"ncp": 2, "session": session, "seq": seq, "op": op, "ack": ack, "body": body}),
        &[],
    )
    .expect("encode")
}

#[test]
fn a_repeated_request_advances_the_body_once() {
    let contract = body_contract();
    let mut owner = Owner::new(
        BODY_APPLICATION,
        &contract.identity,
        Body::default(),
        contract.operations.clone(),
        DEFAULT_BOUND,
    );
    let session = ncp::random_session();
    let decode = |bytes: &[u8]| ncp::decode(bytes.to_vec(), DEFAULT_BOUND).expect("decode");
    let opened = decode(&owner.handle(frame(&session, 0, "open", None, json!({"application": BODY_APPLICATION, "contract": contract.identity, "bound": DEFAULT_BOUND}))).expect("open"));
    let prepared = decode(
        &owner
            .handle(frame(
                &session,
                1,
                "prepare",
                Some(&opened.identity),
                json!(prepare_body(1, 3)),
            ))
            .expect("prepare"),
    );
    let state = prepared.message["body"]["observation"]["state_digest"]
        .as_str()
        .unwrap()
        .to_owned();
    let step = frame(
        &session,
        2,
        "step",
        Some(&prepared.identity),
        json!(step_body(1, 1, &state)),
    );
    let first = owner.handle(step.clone()).expect("step");
    let again = owner.handle(step).expect("the same step again");
    assert_eq!(first, again, "a repeated request gets the kept response");
    let first = decode(&first);
    assert_eq!(first.message["outcome"], "ok");
    let next_state = first.message["body"]["observation"]["state_digest"]
        .as_str()
        .unwrap()
        .to_owned();
    // Had the repeat executed, the body would be at step 2 and reject step 2 from this state.
    let second = decode(
        &owner
            .handle(frame(
                &session,
                3,
                "step",
                Some(&first.identity),
                json!(step_body(1, 2, &next_state)),
            ))
            .expect("step 2"),
    );
    assert_eq!(second.message["outcome"], "ok");
    assert_eq!(second.message["body"]["observation"]["tick_index"], 2);
}

#[test]
fn the_binary_serves_only_ncp_frames_and_takes_no_arguments() {
    let mut child = Command::new(BINARY)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(b"GET / HTTP/1.1\r\n\r\n")
        .expect("write");
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .expect("stdout")
        .read_to_end(&mut output)
        .expect("read");
    let response = ncp::decode(output, DEFAULT_BOUND).expect("one frame");
    assert_eq!(response.message["outcome"], "ended");
    assert_eq!(response.message["code"], "bad_frame");
    assert!(child.wait().expect("exit").success());
    let status = Command::new(BINARY)
        .arg("--listen")
        .stderr(Stdio::null())
        .status()
        .expect("run");
    assert_eq!(status.code(), Some(2));
}
