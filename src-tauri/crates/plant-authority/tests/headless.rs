use std::process::Command;

#[test]
fn headless_self_check_should_exit_without_renderer_or_vehicle_services() {
    let output = Command::new(env!("CARGO_BIN_EXE_crebain-plantd"))
        .arg("--self-check")
        .output()
        .expect("self-check process should start");
    let stdout = String::from_utf8(output.stdout).expect("self-check output should be UTF-8");

    assert!(
        output.status.success() && stdout.contains("self-check: ok") && stdout.contains("inert")
    );
}

#[test]
fn headless_binary_should_reject_daemon_start_without_an_enabled_profile() {
    let output = Command::new(env!("CARGO_BIN_EXE_crebain-plantd"))
        .output()
        .expect("headless process should start");
    let stderr = String::from_utf8(output.stderr).expect("usage output should be UTF-8");

    assert!(
        output.status.code() == Some(2)
            && stderr.contains("usage: crebain-plantd --self-check")
            && stderr.contains("cannot connect to an actuator")
    );
}
