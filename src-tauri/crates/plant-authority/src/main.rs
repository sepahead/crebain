//! Headless entry point for the inert CREBAIN plant-authority foundation.

use std::process::ExitCode;

use crebain_plant_authority::{run_self_check, PlantState};

const SELF_CHECK_ARGUMENT: &str = "--self-check";

fn main() -> ExitCode {
    let mut arguments = std::env::args_os();
    let _program = arguments.next();
    let operation = arguments.next();
    if operation.as_deref() != Some(std::ffi::OsStr::new(SELF_CHECK_ARGUMENT))
        || arguments.next().is_some()
    {
        eprintln!("usage: crebain-plantd {SELF_CHECK_ARGUMENT}");
        eprintln!("this L0 binary is inert and cannot connect to an actuator");
        return ExitCode::from(2);
    }

    match run_self_check() {
        Ok(report) if report.final_state == PlantState::Shutdown => {
            println!(
                "crebain-plantd self-check: ok (inert, generation={}, overwritten={}, dropped={})",
                report.final_generation.get(),
                report.latest_overwritten,
                report.evidence_dropped
            );
            ExitCode::SUCCESS
        }
        Ok(report) => {
            eprintln!(
                "crebain-plantd self-check: failed (unexpected state {:?})",
                report.final_state
            );
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("crebain-plantd self-check: failed: {error}");
            ExitCode::FAILURE
        }
    }
}
