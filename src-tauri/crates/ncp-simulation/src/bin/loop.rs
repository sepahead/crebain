//! `crebain-ncp-loop`: run a closed loop of controllers and worlds, or check its transcripts.
//!
//! crebain-ncp-loop run CONFIG.json OUT_DIR   writes transcripts, manifest.json,
//!                                            trajectory.jsonl, and summary.json; prints the summary
//! crebain-ncp-loop verify OUT_DIR            checks the transcripts; prints what it covered
//!
//! A program name without a path in CONFIG is looked up next to this executable first.

use crebain_ncp_simulation::{host, verify};
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["run", config, out] => std::fs::read(config)
            .map_err(|error| format!("{config}: {error}"))
            .and_then(|bytes| {
                serde_json::from_slice::<host::LoopConfig>(&bytes)
                    .map_err(|error| format!("{config}: {error}"))
            })
            .and_then(|config| host::run(&config, Path::new(out)))
            .and_then(|summary| {
                serde_json::to_string_pretty(&summary).map_err(|error| error.to_string())
            }),
        ["verify", out] => verify::verify(Path::new(out)).and_then(|report| {
            serde_json::to_string_pretty(&report).map_err(|error| error.to_string())
        }),
        _ => Err(
            "usage: crebain-ncp-loop run CONFIG.json OUT_DIR | crebain-ncp-loop verify OUT_DIR"
                .into(),
        ),
    };
    match outcome {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("crebain-ncp-loop: {error}");
            ExitCode::FAILURE
        }
    }
}
