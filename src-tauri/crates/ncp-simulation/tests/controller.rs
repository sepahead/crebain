//! The reference controller and the checks of the controller contract.

use crebain_ncp_simulation::controller::{
    ControllerPrepare, ControllerResult, ControllerStep, Gains, Reference,
};
use crebain_ncp_simulation::controller_contract;
use ncp::binding::PipeChild;
use ncp::{Client, Error};
use serde_json::{json, Value};
use std::process::Command;

const BINARY: &str = env!("CARGO_BIN_EXE_crebain-ncp-controller");
const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn open() -> Client<PipeChild> {
    let channel = ncp::spawn(Command::new(BINARY)).expect("spawn");
    let mut client = Client::new(channel, &controller_contract());
    client.open().expect("open");
    client
}

/// Whether the child exited successfully; closing the session ends it.
fn exited(client: &mut Client<PipeChild>) -> bool {
    client
        .channel_mut()
        .exit_status()
        .is_some_and(|status| status.success())
}

fn prepare() -> ControllerPrepare {
    ControllerPrepare {
        drone_ids: vec!["alpha".into(), "bravo".into()],
        tick_ms: 20,
        targets_m: vec![10.0, 0.0, 5.0, -2.0, 3.0, 1.0],
        parameters: json!({"kp": 0.5, "kd": 1.5, "max_acceleration_mps2": 2.0}),
    }
}

fn step(tick: u64) -> ControllerStep {
    ControllerStep {
        tick_index: tick,
        source_state_digest: DIGEST.into(),
        drone_ids: vec!["alpha".into(), "bravo".into()],
        estimate_available: vec![true, false],
        position_m: vec![9.0, 0.0, 5.0, 0.0, 0.0, 0.0],
        velocity_mps: vec![0.4, -1.0, 0.0, 0.0, 0.0, 0.0],
    }
}

fn call(client: &mut Client<PipeChild>, op: &str, body: Value) -> Result<Value, Error> {
    client
        .call(op, body, &[])
        .map(|d| d.message["body"].clone())
}

#[test]
fn the_reference_law_clamps_and_holds_drones_without_an_estimate() {
    let mut client = open();
    let prepared = call(&mut client, "prepare", json!(prepare())).expect("prepare");
    assert_eq!(
        prepared["controller"]["gains"],
        json!({"kp": 0.5, "kd": 1.5, "max_acceleration_mps2": 2.0})
    );
    let result: ControllerResult =
        serde_json::from_value(call(&mut client, "step", json!(step(1))).expect("step"))
            .expect("result");
    result
        .answers(&step(1))
        .expect("the result echoes its request");
    // alpha: x 0.5*1 - 1.5*0.4 = -0.1; y 0 - 1.5*(-1) = 1.5; z 0. bravo has no estimate: zeros.
    let expected = [0.5 * 1.0 - 1.5 * 0.4, 1.5, 0.0, 0.0, 0.0, 0.0];
    assert_eq!(result.acceleration_mps2, expected);
    assert!(
        result
            .acceleration_mps2
            .iter()
            .all(|a| !(*a == 0.0 && a.is_sign_negative())),
        "no negative zero"
    );
    let mut far = step(2);
    far.position_m[0] = -90.0;
    let result: ControllerResult =
        serde_json::from_value(call(&mut client, "step", json!(far)).expect("step 2"))
            .expect("result");
    assert_eq!(
        result.acceleration_mps2[0], 2.0,
        "clamped to max_acceleration_mps2"
    );
    client.close().expect("close");
    assert!(exited(&mut client));
}

#[test]
fn the_law_never_proposes_a_negative_zero() {
    let prepare = ControllerPrepare {
        targets_m: vec![-0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ..prepare()
    };
    let gains = Gains {
        kp: 1.0,
        kd: 1.0,
        max_acceleration_mps2: 5.0,
    };
    let mut observation = step(1);
    observation.estimate_available = vec![true, true];
    observation.position_m = vec![0.0; 6];
    observation.velocity_mps = vec![0.0, -0.0, 0.0, 0.0, 0.0, 0.0];
    let proposed = Reference::propose(&prepare, &gains, &observation);
    assert!(
        proposed.iter().all(|a| *a == 0.0 && a.is_sign_positive()),
        "{proposed:?}"
    );
}

#[test]
fn results_that_do_not_answer_their_request_are_refused() {
    let good = ControllerResult {
        tick_index: 1,
        source_state_digest: DIGEST.into(),
        drone_ids: vec!["alpha".into(), "bravo".into()],
        acceleration_mps2: vec![0.0; 6],
    };
    good.answers(&step(1)).expect("positive control");
    let cases = [
        ControllerResult {
            tick_index: 2,
            ..good.clone()
        },
        ControllerResult {
            source_state_digest: DIGEST.replace('0', "f"),
            ..good.clone()
        },
        ControllerResult {
            drone_ids: vec!["alpha".into()],
            ..good.clone()
        },
        ControllerResult {
            acceleration_mps2: vec![0.0; 5],
            ..good.clone()
        },
        ControllerResult {
            acceleration_mps2: vec![0.0, 0.0, 0.0, 0.0, 0.0, 50.5],
            ..good.clone()
        },
        ControllerResult {
            acceleration_mps2: vec![0.0, -0.0, 0.0, 0.0, 0.0, 0.0],
            ..good.clone()
        },
    ];
    for (index, case) in cases.iter().enumerate() {
        assert!(case.answers(&step(1)).is_err(), "case {index}");
    }
}

/// An invalid request is declined: it never runs, and the session goes on (NCP 2, rule 7.3.12).
fn declined(result: Result<Value, Error>, what: &str) {
    assert!(
        matches!(result, Err(Error::Declined { .. })),
        "{what}: {result:?}"
    );
}

#[test]
fn invalid_requests_are_declined_and_the_session_goes_on() {
    let mut client = open();
    declined(
        call(&mut client, "step", json!(step(1))),
        "a step before prepare",
    );
    for (what, parameters) in [
        ("a negative gain", json!({"kp": -1.0})),
        ("a limit above 50", json!({"max_acceleration_mps2": 60.0})),
        ("an unknown parameter", json!({"ki": 1.0})),
    ] {
        declined(
            call(
                &mut client,
                "prepare",
                json!(ControllerPrepare {
                    parameters,
                    ..prepare()
                }),
            ),
            what,
        );
    }
    declined(
        call(
            &mut client,
            "prepare",
            json!(ControllerPrepare {
                drone_ids: vec!["bravo".into(), "alpha".into()],
                ..prepare()
            }),
        ),
        "unsorted drones",
    );
    declined(
        call(
            &mut client,
            "prepare",
            json!(ControllerPrepare {
                targets_m: vec![0.0; 5],
                ..prepare()
            }),
        ),
        "short targets",
    );
    call(&mut client, "prepare", json!(prepare())).expect("positive control: a valid prepare");
    declined(call(&mut client, "step", json!(step(2))), "a skipped step");
    declined(
        call(
            &mut client,
            "step",
            json!(ControllerStep {
                drone_ids: vec!["alpha".into(), "charlie".into()],
                ..step(1)
            }),
        ),
        "other drones",
    );
    declined(
        call(
            &mut client,
            "step",
            json!(ControllerStep {
                source_state_digest: "x".into(),
                ..step(1)
            }),
        ),
        "a digest that is not an identity",
    );
    call(&mut client, "step", json!(step(1))).expect("positive control: step 1");
    client.close().expect("close");
    assert!(exited(&mut client));
}
