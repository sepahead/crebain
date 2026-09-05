//! Test-only direct kernel replay. This example does not call the NCP adapter.
//!
//! Input contains one managed-kernel preparation and its complete step roster.
//! Output retains every raw frame and actual innovation, including initial birth.
//! The input limit bounds test data; this example is not a protocol endpoint.

use std::error::Error;
use std::io::{self, Read, Write};

use crebain_managed_simulation::{
    InnovationRecording, MultiDroneSimulation, PrepareRequest, StepRequest,
};
use serde::Deserialize;

const MAX_INPUT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Replay {
    prepare: PrepareRequest,
    steps: Vec<StepRequest>,
}

fn replay(input: Replay, output: &mut impl Write) -> Result<(), Box<dyn Error>> {
    if input.steps.len() as u64 != input.prepare.max_ticks {
        return Err("the replay must include the complete declared step roster".into());
    }
    let (mut kernel, initial) = MultiDroneSimulation::new()
        .prepare_with_recording(input.prepare, InnovationRecording::KalmanInnovationV1)?;
    serde_json::to_writer(
        &mut *output,
        &serde_json::json!({"frame": initial, "innovations": kernel.latest_innovations()}),
    )?;
    output.write_all(b"\n")?;
    for request in input.steps {
        let frame = kernel.step(request)?;
        serde_json::to_writer(
            &mut *output,
            &serde_json::json!({"frame": frame, "innovations": kernel.latest_innovations()}),
        )?;
        output.write_all(b"\n")?;
    }
    output.flush()?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("test replay exceeds the input bound".into());
    }
    replay(serde_json::from_slice(&bytes)?, &mut io::stdout().lock())
}
