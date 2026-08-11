#![cfg(feature = "ncp")]

use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Output},
};

fn headless_command(arguments: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_crebain-ncp-headless"))
        .args(arguments)
        .env_remove("NCP_ZENOH_CONFIG")
        .output()
        .expect("headless binary must start")
}

fn stdout_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).expect("stdout must be JSON")
}

fn stderr_json(output: &Output) -> Value {
    serde_json::from_slice(&output.stderr).expect("stderr must be JSON")
}

const STRICT_CLIENT_CONFIG: &[u8] = br#"{
  mode: "client",
  scouting: {
    multicast: { enabled: false },
    gossip: { enabled: false },
  },
  connect: { endpoints: ["tls/127.0.0.1:7447"] },
  listen: { endpoints: [] },
  transport: { link: { tls: {
    root_ca_certificate: "ca.pem",
    connect_certificate: "client.pem",
    connect_private_key: "client.key",
    verify_name_on_connect: true,
  } } },
}"#;

#[test]
fn self_check_is_network_free_and_wire_exact() {
    let output = headless_command(&["self-check"]);
    assert!(output.status.success(), "{output:?}");
    let report = stdout_json(&output);
    assert_eq!(report["status"], "ok");
    assert_eq!(report["ncp_wire"], "0.8");
    assert_eq!(report["contract_hash"], "d1b50a2d8a265276");
    assert_eq!(report["strict_client_configuration"], "required_for_run");
    assert_eq!(report["scope"], "perception_rpc_only");
    assert_eq!(
        report["peer_requirement"],
        "compatible_ncp_wire_0.8_responder"
    );
    assert_eq!(report["network_opened"], false);
}

#[test]
fn no_arguments_perform_no_action() {
    let output = headless_command(&[]);
    assert!(!output.status.success());
    let report = stderr_json(&output);
    assert_eq!(report["status"], "error");
    assert!(report["error"]
        .as_str()
        .is_some_and(|error| error.contains("explicit")));
}

#[test]
fn validate_requires_secure_config_without_opening_transport() {
    let output = headless_command(&["validate", "--session-id", "dry-check"]);
    assert!(!output.status.success());
    let report = stderr_json(&output);
    assert!(report["error"]
        .as_str()
        .is_some_and(|error| error.contains("NCP_ZENOH_CONFIG")));
}

#[test]
fn validate_rejects_a_parseable_but_non_secure_snapshot() {
    let mut file = tempfile::Builder::new()
        .suffix(".json5")
        .tempfile()
        .expect("temporary config must open");
    file.write_all(b"{}")
        .expect("temporary config must be writable");
    let output = Command::new(env!("CARGO_BIN_EXE_crebain-ncp-headless"))
        .args(["validate", "--session-id", "dry-check"])
        .env("NCP_ZENOH_CONFIG", file.path())
        .output()
        .expect("headless binary must start");
    assert!(!output.status.success(), "{output:?}");
    let report = stderr_json(&output);
    assert!(report["error"]
        .as_str()
        .is_some_and(|error| error.contains("secure config") && error.contains("mode")));
}

#[test]
fn validate_checks_strict_client_configuration_without_making_a_deployment_claim() {
    let mut file = tempfile::Builder::new()
        .suffix(".json5")
        .tempfile()
        .expect("temporary config must open");
    file.write_all(STRICT_CLIENT_CONFIG)
        .expect("temporary config must be writable");
    let output = Command::new(env!("CARGO_BIN_EXE_crebain-ncp-headless"))
        .args(["validate", "--session-id", "dry-check"])
        .env("NCP_ZENOH_CONFIG", file.path())
        .output()
        .expect("headless binary must start");
    assert!(output.status.success(), "{output:?}");
    let report = stdout_json(&output);
    assert_eq!(report["status"], "strict_client_configuration_validated");
    assert_eq!(report["strict_client_configuration_validated"], true);
    assert_eq!(
        report["peer_requirement"],
        "compatible_ncp_wire_0.8_responder"
    );
    assert_eq!(report["network_opened"], false);
    assert_eq!(report["security_policy_proven"], false);
}

#[test]
fn run_rejects_a_non_secure_snapshot_before_opening_transport() {
    let mut file = tempfile::Builder::new()
        .suffix(".json5")
        .tempfile()
        .expect("temporary config must open");
    file.write_all(b"{}")
        .expect("temporary config must be writable");
    let output = Command::new(env!("CARGO_BIN_EXE_crebain-ncp-headless"))
        .args(["run", "--session-id", "dry-check"])
        .env("NCP_ZENOH_CONFIG", file.path())
        .output()
        .expect("headless binary must start");
    assert!(!output.status.success(), "{output:?}");
    let report = stderr_json(&output);
    assert!(report["error"]
        .as_str()
        .is_some_and(|error| error.contains("secure config") && error.contains("mode")));
}
