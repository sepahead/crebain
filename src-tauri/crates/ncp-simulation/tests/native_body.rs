//! Controlled proposals exercise the real body kernel. These tests do not run NEST.
use crebain_managed_simulation::{FaultCode, MultiDroneSimulation, PrepareRequest, StepRequest};
use crebain_ncp_simulation::{
    BodyBackend, BodyConfiguration, FinishData, ScheduledInput, APPLICATION_PROFILE,
};
use ncp_local::local::{
    local_digest, local_profile_digest, LocalBackend, LocalBinding, LocalCode, LocalOperation,
    LocalOutcome, LocalOwner, LocalRequest, LocalResponse, LocalRole,
};
use ncp_local::local_data::{
    action_layout, observation_layout, ActionMode, BodyResult, BodyStep, InnovationStatus,
    NeuralProposal, NeuralStep, PrepareData, RunPlan, Snapshot,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

fn binding(role: LocalRole) -> LocalBinding {
    LocalBinding {
        profile_digest: local_profile_digest().unwrap(),
        run_id: "10000000-0000-4000-8000-000000000000".into(),
        generation: match role {
            LocalRole::Body => "20000000-0000-4000-8000-000000000000",
            _ => "30000000-0000-4000-8000-000000000000",
        }
        .into(),
        role,
    }
}
fn plan(n: usize, steps: u64) -> RunPlan {
    RunPlan {
        schema: "ncp.local.plan.v1".into(),
        entity_ids: (0..n).map(|i| format!("entity-{i}")).collect(),
        planned_steps: steps,
        step_us: 10_000,
        resolution_us: 100,
        readout_delay_us: 100,
        seed: 42,
        execution_mode: "direct_simulation".into(),
        capture_mode: "lossless_bounded".into(),
        monitor_mode: "record_only".into(),
        calibrated_posterior: false,
        observation_layout: observation_layout(),
        action_layout: action_layout(),
    }
}
fn configuration(n: usize) -> BodyConfiguration {
    BodyConfiguration {
        initial_position_m: (0..n)
            .flat_map(|i| [i as f64 * 500.0, 0.0, 100.0])
            .collect(),
        initial_velocity_mps: (0..n).flat_map(|_| [1.0, 0.0, 0.0]).collect(),
        sensor_variance_m2: vec![1.0; n * 3],
        expected_neural_generation: binding(LocalRole::Neural).generation,
        schedule: vec![],
    }
}
fn prepare(plan: &RunPlan, config: &BodyConfiguration) -> Value {
    serde_json::to_value(PrepareData {
        plan: plan.clone(),
        application_profile: APPLICATION_PROFILE.into(),
        configuration: serde_json::to_value(config).unwrap(),
    })
    .unwrap()
}
fn request(
    binding: &LocalBinding,
    sequence: u64,
    operation: LocalOperation,
    body: Value,
) -> LocalRequest {
    let mut value = LocalRequest {
        schema: "ncp.local.request.v1".into(),
        profile_digest: binding.profile_digest.clone(),
        run_id: binding.run_id.clone(),
        generation: binding.generation.clone(),
        sequence,
        operation,
        body,
        request_digest: String::new(),
    };
    value.seal().unwrap();
    value
}
fn seal_response(response: &mut LocalResponse) {
    let mut value = serde_json::to_value(&*response).unwrap();
    value.as_object_mut().unwrap().remove("result_digest");
    response.result_digest = local_digest("ncp.local.response.v1", &value).unwrap();
}
fn proposal(plan: &RunPlan, source: &Snapshot) -> LocalResponse {
    let next = source.step + 1;
    let neural = NeuralProposal {
        schema: "ncp.local.neural-result.v1".into(),
        plan_digest: plan.digest().unwrap(),
        step: next,
        source_snapshot_digest: source.snapshot_digest.clone(),
        selected_modes: source
            .available
            .iter()
            .map(|available| {
                if *available {
                    ActionMode::Active
                } else {
                    ActionMode::ZeroAcceleration
                }
            })
            .collect(),
        values: source
            .available
            .iter()
            .flat_map(|available| {
                if *available {
                    [2.0, -1.0, 0.5]
                } else {
                    [0.0; 3]
                }
            })
            .collect(),
        neural_time_us: plan.time_us(next).unwrap(),
        completed_end_us: plan.time_us(next).unwrap() - plan.readout_delay_us,
        window_start_us: source.time_us.saturating_sub(plan.readout_delay_us),
        spike_counts: vec![0; plan.entity_ids.len() * 6],
        neural_model: "controlled-test-input".into(),
    };
    let request = request(
        &binding(LocalRole::Neural),
        next + 1,
        LocalOperation::Step,
        serde_json::to_value(NeuralStep {
            source_snapshot: source.clone(),
        })
        .unwrap(),
    );
    let mut response = LocalResponse {
        schema: "ncp.local.response.v1".into(),
        binding: binding(LocalRole::Neural),
        sequence: request.sequence,
        operation: request.operation,
        request_digest: request.request_digest,
        outcome: LocalOutcome::Committed,
        code: LocalCode::Ok,
        body: serde_json::to_value(neural).unwrap(),
        result_digest: String::new(),
    };
    seal_response(&mut response);
    response
}
fn step(response: LocalResponse) -> Value {
    serde_json::to_value(BodyStep {
        neural_response: response,
    })
    .unwrap()
}
fn snapshot(value: &Value) -> Snapshot {
    serde_json::from_value(value["snapshot"].clone()).unwrap()
}
fn finish(plan: &RunPlan) -> Value {
    serde_json::to_value(FinishData {
        plan_digest: plan.digest().unwrap(),
        completed_steps: plan.planned_steps,
    })
    .unwrap()
}
fn call(owner: &mut LocalOwner<BodyBackend>, req: &LocalRequest) -> (Vec<u8>, LocalResponse) {
    let bytes = owner.handle(&serde_json::to_vec(req).unwrap()).unwrap();
    let response = serde_json::from_slice(&bytes).unwrap();
    (bytes, response)
}
fn ack(owner: &mut LocalOwner<BodyBackend>, response: &LocalResponse) {
    let req = request(
        &binding(LocalRole::Body),
        response.sequence,
        LocalOperation::Ack,
        json!({"result_digest":response.result_digest}),
    );
    assert_eq!(call(owner, &req).1.outcome, LocalOutcome::Acknowledged);
}

#[test]
fn one_to_three_entity_native_trajectory_matches_direct_kernel() {
    for n in 1..=3 {
        let plan = plan(n, 16);
        let config = configuration(n);
        let mut body = BodyBackend::new(binding(LocalRole::Body)).unwrap();
        let first = body
            .execute(LocalOperation::Prepare, &prepare(&plan, &config))
            .unwrap();
        let mut source = snapshot(&first);
        assert!(source
            .innovations
            .iter()
            .all(|row| row.status == InnovationStatus::Birth && row.nis.is_none()));
        let (mut oracle, initial) = MultiDroneSimulation::new()
            .prepare(PrepareRequest {
                schema_version: "crebain.simulation.prepare-request.v1".into(),
                run_id: format!("ncp.{}", binding(LocalRole::Body).run_id),
                drone_ids: plan.entity_ids.clone(),
                tick_ms: plan.step_us / 1000,
                max_ticks: plan.planned_steps,
                initial_position_m: config.initial_position_m,
                initial_velocity_mps: config.initial_velocity_mps,
                sensor_variance_m2: config.sensor_variance_m2,
            })
            .unwrap();
        assert_eq!(source.values[0], initial.fused_position_m[0]);
        for k in 1..=plan.planned_steps {
            let response = proposal(&plan, &source);
            let input: NeuralProposal = serde_json::from_value(response.body.clone()).unwrap();
            let expected = oracle
                .step(StepRequest {
                    schema_version: "crebain.simulation.step-request.v1".into(),
                    run_id: format!("ncp.{}", binding(LocalRole::Body).run_id),
                    tick_index: k,
                    drone_ids: plan.entity_ids.clone(),
                    actuator_intent_acceleration_mps2: input.values,
                    sensor_offset_m: vec![0.0; n * 3],
                    fault_codes: vec![FaultCode::None; n],
                })
                .unwrap();
            let actual: BodyResult = serde_json::from_value(
                body.execute(LocalOperation::Step, &step(response)).unwrap(),
            )
            .unwrap();
            actual.validate(&plan).unwrap();
            assert_eq!(
                actual.applied_values,
                expected.actuator_output_acceleration_mps2
            );
            for i in 0..n {
                assert_eq!(
                    &actual.snapshot.values[i * 6..i * 6 + 3],
                    &expected.fused_position_m[i * 3..i * 3 + 3]
                );
                assert_eq!(
                    &actual.snapshot.values[i * 6 + 3..i * 6 + 6],
                    &expected.fused_velocity_mps[i * 3..i * 3 + 3]
                );
            }
            assert!(actual
                .snapshot
                .innovations
                .iter()
                .all(|row| row.status == InnovationStatus::Observed && row.source.is_some()));
            source = actual.snapshot;
        }
        let terminal = body
            .execute(LocalOperation::Finish, &finish(&plan))
            .unwrap();
        assert_eq!(terminal["cleaned_up"], true);
        assert_eq!(terminal["completed_steps"], 16);
        assert!(body
            .validate(LocalOperation::Prepare, &prepare(&plan, &configuration(n)))
            .is_err());
    }
}

#[test]
fn frozen_faults_preserve_missingness_peer_activity_and_actual_application() {
    let plan = plan(3, 3);
    let mut config = configuration(3);
    config.schedule = vec![
        ScheduledInput {
            step: 1,
            entity_id: plan.entity_ids[0].clone(),
            sensor_offset_m: [0.0; 3],
            sensor_available: false,
            actuator_available: true,
        },
        ScheduledInput {
            step: 1,
            entity_id: plan.entity_ids[1].clone(),
            sensor_offset_m: [0.1, -0.2, 0.3],
            sensor_available: true,
            actuator_available: false,
        },
    ];
    let mut body = BodyBackend::new(binding(LocalRole::Body)).unwrap();
    let initial = snapshot(
        &body
            .execute(LocalOperation::Prepare, &prepare(&plan, &config))
            .unwrap(),
    );
    let first: BodyResult = serde_json::from_value(
        body.execute(LocalOperation::Step, &step(proposal(&plan, &initial)))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first.snapshot.available, vec![false, true, true]);
    assert_eq!(&first.snapshot.values[..6], &[0.0; 6]);
    assert_eq!(
        first.snapshot.innovations[0].status,
        InnovationStatus::Unavailable
    );
    assert!(first.snapshot.innovations[0].source.is_none());
    assert_eq!(&first.proposed_values[3..6], &[2.0, -1.0, 0.5]);
    assert_eq!(&first.applied_values[3..6], &[0.0; 3]);
    assert!(first.snapshot.innovations[1].nis.unwrap() > 0.0);
    let second: BodyResult = serde_json::from_value(
        body.execute(
            LocalOperation::Step,
            &step(proposal(&plan, &first.snapshot)),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        second.selected_modes,
        vec![
            ActionMode::ZeroAcceleration,
            ActionMode::Active,
            ActionMode::Active
        ]
    );
    assert_eq!(&second.applied_values[..3], &[0.0; 3]);
    assert!(second.snapshot.available.iter().all(|v| *v));
    assert!(
        second.snapshot.values[0] > 0.0,
        "zero acceleration is not a position hold"
    );
}

#[test]
fn bad_source_generation_role_digest_and_missingness_reject_without_mutation() {
    let plan = plan(2, 2);
    let config = configuration(2);
    let mut body = BodyBackend::new(binding(LocalRole::Body)).unwrap();
    let initial = snapshot(
        &body
            .execute(LocalOperation::Prepare, &prepare(&plan, &config))
            .unwrap(),
    );
    let good = proposal(&plan, &initial);
    for mutation in 0..7 {
        let mut bad = good.clone();
        match mutation {
            0 => bad.binding.generation = "40000000-0000-4000-8000-000000000000".into(),
            1 => bad.binding.role = LocalRole::Body,
            2 => bad.request_digest = "0".repeat(64),
            3 => bad.sequence += 1,
            4 => bad.body["source_snapshot_digest"] = json!("0".repeat(64)),
            5 => bad.body["values"][0] = json!(51.0),
            _ => bad.body["selected_modes"][0] = json!("zero_acceleration"),
        };
        seal_response(&mut bad);
        assert!(body
            .validate(LocalOperation::Step, &step(bad.clone()))
            .is_err());
        assert!(body.execute(LocalOperation::Step, &step(bad)).is_err());
        assert!(body
            .validate(LocalOperation::Step, &step(good.clone()))
            .is_ok());
    }
    assert!(body
        .execute(LocalOperation::Finish, &finish(&plan))
        .is_err());
    let result: BodyResult =
        serde_json::from_value(body.execute(LocalOperation::Step, &step(good)).unwrap()).unwrap();
    assert_eq!(result.step, 1);
    assert_eq!(result.source_snapshot_digest, initial.snapshot_digest);
}

#[test]
fn closed_configuration_and_schedule_fail_before_prepare() {
    let plan = plan(1, 2);
    let config = configuration(1);
    let good = prepare(&plan, &config);
    let mut cases = vec![];
    let mut v = good.clone();
    v["configuration"]["host_api"] = json!(true);
    cases.push(v);
    let mut v = good.clone();
    v["configuration"]["sensor_variance_m2"][0] = json!(0.0);
    cases.push(v);
    let mut v = good.clone();
    v["configuration"]["expected_neural_generation"] = json!(binding(LocalRole::Body).generation);
    cases.push(v);
    let row = json!({"step":1,"entity_id":"entity-0","sensor_offset_m":[0.0,0.0,0.0],"sensor_available":true,"actuator_available":true});
    let mut v = good.clone();
    v["configuration"]["schedule"] = json!([row.clone(), row]);
    cases.push(v);
    let mut v = good.clone();
    v["application_profile"] = json!("historical-host-api");
    cases.push(v);
    let mut body = BodyBackend::new(binding(LocalRole::Body)).unwrap();
    for bad in cases {
        assert!(body.execute(LocalOperation::Prepare, &bad).is_err());
        assert!(body.validate(LocalOperation::Prepare, &good).is_ok());
    }
    assert!(body.execute(LocalOperation::Prepare, &good).is_ok());
}

#[test]
fn exact_response_recovery_never_advances_body_twice() {
    let plan = plan(1, 2);
    let config = configuration(1);
    let binding = binding(LocalRole::Body);
    let backend = BodyBackend::new(binding.clone()).unwrap();
    let mut owner = LocalOwner::new(binding.clone(), backend).unwrap();
    let first = request(
        &binding,
        1,
        LocalOperation::Prepare,
        prepare(&plan, &config),
    );
    let (_, prepared) = call(&mut owner, &first);
    let initial = snapshot(&prepared.body);
    ack(&mut owner, &prepared);
    let advance = request(
        &binding,
        2,
        LocalOperation::Step,
        step(proposal(&plan, &initial)),
    );
    let (original, response) = call(&mut owner, &advance);
    assert_eq!(response.outcome, LocalOutcome::Committed);
    assert_eq!(original, call(&mut owner, &advance).0);
    let lookup = request(
        &binding,
        2,
        LocalOperation::Result,
        json!({"request_digest": advance.request_digest}),
    );
    assert_eq!(original, call(&mut owner, &lookup).0);
    ack(&mut owner, &response);
    assert_eq!(
        call(&mut owner, &advance).1.outcome,
        LocalOutcome::Unavailable
    );
    let next = request(
        &binding,
        3,
        LocalOperation::Step,
        step(proposal(&plan, &snapshot(&response.body))),
    );
    let (_, response) = call(&mut owner, &next);
    assert_eq!(response.body["step"], 2);
    assert_eq!(response.outcome, LocalOutcome::Committed);
}

#[test]
fn native_binary_accepts_only_framed_ncp_on_private_stdio() {
    let binding = binding(LocalRole::Body);
    let plan = plan(1, 1);
    let req = request(
        &binding,
        1,
        LocalOperation::Prepare,
        prepare(&plan, &configuration(1)),
    );
    let payload = serde_json::to_vec(&req).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_crebain-ncp-simulation"))
        .args(["--binding", &serde_json::to_string(&binding).unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let input = child.stdin.as_mut().unwrap();
        input
            .write_all(&(payload.len() as u32).to_be_bytes())
            .unwrap();
        input.write_all(&payload).unwrap();
        input.flush().unwrap();
    }
    let mut length = [0; 4];
    child
        .stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut length)
        .unwrap();
    let mut result = vec![0; u32::from_be_bytes(length) as usize];
    child
        .stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut result)
        .unwrap();
    let response: LocalResponse = serde_json::from_slice(&result).unwrap();
    response.verify(&binding, &req).unwrap();
    assert_eq!(response.outcome, LocalOutcome::Committed);
    assert_eq!(response.body["snapshot"]["step"], 0);
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
    let output = Command::new(env!("CARGO_BIN_EXE_crebain-ncp-simulation"))
        .arg("--stdio")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}

#[test]
fn application_entity_grammar_and_runtime_overflow_have_distinct_boundaries() {
    let good_plan = plan(1, 1);
    for entity in ["Entity-0", "1entity"] {
        let mut rejected_plan = good_plan.clone();
        rejected_plan.entity_ids = vec![entity.into()];
        rejected_plan.validate().unwrap();
        let mut body = BodyBackend::new(binding(LocalRole::Body)).unwrap();
        assert!(body
            .execute(
                LocalOperation::Prepare,
                &prepare(&rejected_plan, &configuration(1))
            )
            .is_err());
        assert!(body
            .execute(
                LocalOperation::Prepare,
                &prepare(&good_plan, &configuration(1))
            )
            .is_ok());
    }
    let binding = binding(LocalRole::Body);
    let mut config = configuration(1);
    config.initial_position_m = vec![100_000.0, 0.0, 0.0];
    config.initial_velocity_mps = vec![100.0, 0.0, 0.0];
    let mut owner =
        LocalOwner::new(binding.clone(), BodyBackend::new(binding.clone()).unwrap()).unwrap();
    let req = request(
        &binding,
        1,
        LocalOperation::Prepare,
        prepare(&good_plan, &config),
    );
    let (_, prepared) = call(&mut owner, &req);
    assert_eq!(prepared.outcome, LocalOutcome::Committed);
    ack(&mut owner, &prepared);
    let req = request(
        &binding,
        2,
        LocalOperation::Step,
        step(proposal(&good_plan, &snapshot(&prepared.body))),
    );
    let (bytes, response) = call(&mut owner, &req);
    assert_eq!(response.outcome, LocalOutcome::Indeterminate);
    assert_eq!(bytes, call(&mut owner, &req).0);
    ack(&mut owner, &response);
    let req = request(
        &binding,
        3,
        LocalOperation::Prepare,
        prepare(&good_plan, &configuration(1)),
    );
    assert_eq!(call(&mut owner, &req).1.code, LocalCode::Retired);
}
