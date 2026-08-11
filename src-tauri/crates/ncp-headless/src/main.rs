//! Explicit command-line entry point for the perception-only NCP session runner.

use crebain_ncp_headless::{
    dispatch, parse_args, run_strict_client, HeadlessDispatch, HeadlessError, HeadlessOutput, USAGE,
};
use serde::Serialize;
use std::{
    env,
    io::{self, Write},
    process::ExitCode,
};

#[derive(Serialize)]
struct ErrorOutput<'a> {
    kind: &'static str,
    status: &'static str,
    error: &'a str,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let message = error.to_string();
            let output = ErrorOutput {
                kind: "crebain_ncp_headless_error",
                status: "error",
                error: &message,
            };
            let _ignored = write_json(io::stderr().lock(), &output);
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), HeadlessError> {
    match dispatch(parse_args(env::args_os().skip(1))?)? {
        HeadlessDispatch::Help => write_bytes(io::stdout().lock(), USAGE.as_bytes()),
        HeadlessDispatch::Offline(output) => write_json(io::stdout().lock(), &output),
        HeadlessDispatch::Run(config) => {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .map_err(|error| HeadlessError::Output {
                    reason: format!("cannot create async runtime: {error}"),
                })?;
            let report = runtime.block_on(run_strict_client(&config))?;
            write_json(io::stdout().lock(), &HeadlessOutput::Session(report))
        }
    }
}

fn write_json(mut writer: impl Write, output: &impl Serialize) -> Result<(), HeadlessError> {
    serde_json::to_writer(&mut writer, output).map_err(output_error)?;
    writer.write_all(b"\n").map_err(output_error)
}

fn write_bytes(mut writer: impl Write, bytes: &[u8]) -> Result<(), HeadlessError> {
    writer.write_all(bytes).map_err(output_error)
}

fn output_error(error: impl std::fmt::Display) -> HeadlessError {
    HeadlessError::Output {
        reason: format!("cannot write command output: {error}"),
    }
}
