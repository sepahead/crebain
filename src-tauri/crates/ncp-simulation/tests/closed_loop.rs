//! Controllers and worlds in a closed loop over NCP 2, and the offline check of its transcripts.

use crebain_ncp_simulation::body::ScheduledInput;
use crebain_ncp_simulation::host::{
    run, ControllerConfig, DroneConfig, LoopConfig, Summary, WorldConfig,
};
use crebain_ncp_simulation::verify::verify;
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

const BODY: &str = env!("CARGO_BIN_EXE_crebain-ncp-simulation");
const CONTROLLER: &str = env!("CARGO_BIN_EXE_crebain-ncp-controller");

fn out_dir(name: &str) -> PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "crebain-ncp-loop-{}-{}-{name}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn drone(id: &str, start: [f64; 3], target: [f64; 3]) -> DroneConfig {
    DroneConfig {
        id: id.into(),
        initial_position_m: start,
        initial_velocity_mps: [0.0; 3],
        sensor_variance_m2: [0.01; 3],
        target_m: target,
    }
}

fn controller(world: usize, drones: &[&str]) -> ControllerConfig {
    ControllerConfig {
        command: vec![CONTROLLER.into()],
        world,
        drone_ids: drones.iter().map(|d| d.to_string()).collect(),
        parameters: json!({"kp": 1.0, "kd": 2.0, "max_acceleration_mps2": 5.0}),
    }
}

fn one_to_one() -> LoopConfig {
    LoopConfig {
        tick_ms: 20,
        steps: 400,
        body_command: vec![BODY.into()],
        worlds: vec![WorldConfig {
            drones: vec![drone("alpha", [0.0, 0.0, 10.0], [12.0, -6.0, 18.0])],
            schedule: vec![],
        }],
        controllers: vec![controller(0, &["alpha"])],
    }
}

/// Three controllers fly five drones in two worlds: in world 0, one controller flies two drones
/// and another flies the third; in world 1, one controller flies both drones.
fn many_to_many() -> LoopConfig {
    LoopConfig {
        tick_ms: 20,
        steps: 400,
        body_command: vec![BODY.into()],
        worlds: vec![
            WorldConfig {
                drones: vec![
                    drone("alpha", [0.0, 0.0, 10.0], [10.0, 5.0, 15.0]),
                    drone("bravo", [20.0, 0.0, 10.0], [15.0, -5.0, 12.0]),
                    drone("charlie", [-10.0, 10.0, 5.0], [-4.0, 4.0, 9.0]),
                ],
                schedule: vec![],
            },
            WorldConfig {
                drones: vec![
                    drone("delta", [0.0, 0.0, 30.0], [8.0, 8.0, 20.0]),
                    drone("echo", [5.0, -5.0, 25.0], [-6.0, 2.0, 22.0]),
                ],
                schedule: vec![],
            },
        ],
        controllers: vec![
            controller(0, &["alpha", "bravo"]),
            controller(0, &["charlie"]),
            controller(1, &["delta", "echo"]),
        ],
    }
}

fn assert_arrived(summary: &Summary, within_m: f64) {
    for world in &summary.worlds {
        for drone in &world.drones {
            assert!(
                drone.initial_error_m > 5.0,
                "{} starts away from its target",
                drone.id
            );
            assert!(
                drone.final_error_m < within_m,
                "{} ends {} m from its target",
                drone.id,
                drone.final_error_m
            );
        }
    }
}

#[test]
fn one_controller_flies_one_drone_to_its_target() {
    let dir = out_dir("one");
    let summary = run(&one_to_one(), &dir).expect("run");
    assert_arrived(&summary, 0.5);
    let report = verify(&dir).expect("the transcripts verify");
    assert_eq!(
        (
            report.worlds,
            report.controllers,
            report.steps,
            report.proposals
        ),
        (1, 1, 400, 400)
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn three_controllers_fly_five_drones_in_two_worlds() {
    let dir = out_dir("many");
    let summary = run(&many_to_many(), &dir).expect("run");
    assert_arrived(&summary, 0.5);
    assert_eq!(summary.controllers.len(), 3);
    let report = verify(&dir).expect("the transcripts verify");
    assert_eq!(
        (report.worlds, report.controllers, report.proposals),
        (2, 3, 3 * 400)
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn two_runs_of_one_loop_are_identical() {
    let (a, b) = (out_dir("a"), out_dir("b"));
    let first = run(&many_to_many(), &a).expect("first run");
    let second = run(&many_to_many(), &b).expect("second run");
    assert_eq!(first, second);
    assert_eq!(
        fs::read(a.join("trajectory.jsonl")).unwrap(),
        fs::read(b.join("trajectory.jsonl")).unwrap()
    );
    fs::remove_dir_all(a).ok();
    fs::remove_dir_all(b).ok();
}

#[test]
fn the_loop_survives_sensor_dropouts_and_actuator_holds() {
    let mut config = one_to_one();
    config.worlds[0].schedule = (10..60)
        .map(|step| ScheduledInput {
            step,
            drone_id: "alpha".into(),
            sensor_offset_m: [0.0; 3],
            sensor_available: step % 3 != 0,
            actuator_available: step % 7 != 0,
        })
        .collect();
    let dir = out_dir("faults");
    let summary = run(&config, &dir).expect("run");
    assert_arrived(&summary, 0.5);
    let trajectory = fs::read_to_string(dir.join("trajectory.jsonl")).unwrap();
    let hidden = trajectory
        .lines()
        .filter(|line| line.contains("\"estimate_available\":[false]"))
        .count();
    assert_eq!(hidden, (10..60).filter(|s| s % 3 == 0).count());
    verify(&dir).expect("the transcripts verify");
    fs::remove_dir_all(dir).ok();
}

#[test]
fn a_changed_byte_or_a_wrong_manifest_fails_the_check() {
    let dir = out_dir("tamper");
    run(&many_to_many(), &dir).expect("run");
    verify(&dir).expect("the original verifies");

    // A changed acceleration in a controller's transcript: the frame no longer matches its digest.
    let path = dir.join("controller-1.ncpt");
    let original = fs::read(&path).unwrap();
    let at = original
        .windows(17)
        .rposition(|w| w == b"acceleration_mps2")
        .expect("a result")
        + 22;
    let mut changed = original.clone();
    changed[at] = if changed[at] == b'1' { b'2' } else { b'1' };
    fs::write(&path, &changed).unwrap();
    assert!(
        verify(&dir).is_err(),
        "a changed controller result must fail"
    );
    fs::write(&path, &original).unwrap();
    verify(&dir).expect("restored");

    // A manifest that gives a drone to another controller.
    let manifest_path = dir.join("manifest.json");
    let manifest = fs::read_to_string(&manifest_path).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    value["controllers"][1]["world"] = json!(1);
    fs::write(&manifest_path, value.to_string()).unwrap();
    assert!(
        verify(&dir).is_err(),
        "a controller of another world must fail"
    );
    fs::write(&manifest_path, &manifest).unwrap();

    // A missing transcript.
    fs::rename(dir.join("world-1.ncpt"), dir.join("moved.ncpt")).unwrap();
    assert!(
        verify(&dir).is_err(),
        "a missing world transcript must fail"
    );
    fs::remove_dir_all(dir).ok();
}

#[test]
fn bad_assignments_fail_before_any_process_starts() {
    let mut twice = many_to_many();
    twice.controllers[1].drone_ids = vec!["bravo".into()];
    let mut orphan = many_to_many();
    orphan.controllers.remove(1);
    let mut elsewhere = many_to_many();
    elsewhere.controllers[2].world = 2;
    let mut unordered = many_to_many();
    unordered.worlds[1].drones.reverse();
    for (what, config) in [
        ("a drone with two controllers", twice),
        ("a drone without one", orphan),
        ("a missing world", elsewhere),
        ("unordered drones", unordered),
    ] {
        let dir = out_dir("bad");
        assert!(run(&config, &dir).is_err(), "{what}");
        assert!(!dir.exists(), "{what}: no output directory");
    }
}
