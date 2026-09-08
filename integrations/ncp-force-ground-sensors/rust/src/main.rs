//! Standalone producer on trusted already-established stdio.

use crebain_ncp_force_ground_sensors::{
    application::SensorApplication,
    contract,
    engine::{EnginePort, EngineProcess, SharedEngine},
};
use ncp_local::modular_buffer::BufferBinding;
use ncp_local::modular_owner::{Lifecycle, Owner};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let names = [
        "--bun",
        "--node",
        "--bridge",
        "--source-identity",
        "--binding-json",
    ];
    if args.len() != 10 || names.iter().enumerate().any(|(i, key)| args[2 * i] != *key) {
        return Err("trusted launcher arguments required".into());
    }
    let value =
        ncp_local::modular_wire::parse_value(args[9].as_bytes()).map_err(|_| "binding JSON")?;
    let binding: BufferBinding = serde_json::from_value(value).map_err(|_| "binding schema")?;
    binding.validate().map_err(|_| "binding identity")?;
    let mut semantics = ["rgba8", "radiance", "pressure"]
        .iter()
        .map(|kind| contract::semantic(kind))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "installed semantic descriptors")?;
    semantics.sort();
    let engine = EngineProcess::spawn(
        Path::new(&args[1]),
        Path::new(&args[3]),
        Path::new(&args[5]),
        binding.generation.clone(),
    )
    .map_err(|_| "engine start")?;
    let mut engine = SharedEngine::new(engine);
    let application =
        SensorApplication::new(engine.clone(), args[7].clone()).map_err(|_| "source identity")?;
    let mut owner = Owner::new(binding, application, semantics).map_err(|_| "installed owner")?;
    let (input_tx, input_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let result = (|| {
                let mut prefix = [0; 4];
                input.read_exact(&mut prefix).map_err(|_| ())?;
                let length = u32::from_be_bytes(prefix) as usize;
                if length == 0 || length > 65_536 {
                    return Err(());
                }
                let mut bytes = vec![0; length];
                input.read_exact(&mut bytes).map_err(|_| ())?;
                Ok(bytes)
            })();
            let failed = result.is_err();
            if input_tx.send(result).is_err() || failed {
                break;
            }
        }
    });
    let (output_tx, output_rx) = mpsc::sync_channel::<Vec<u8>>(1);
    let (written_tx, written_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut output = std::io::stdout().lock();
        while let Ok(bytes) = output_rx.recv() {
            let result = (|| {
                output
                    .write_all(&(bytes.len() as u32).to_be_bytes())
                    .map_err(|_| ())?;
                output.write_all(&bytes).map_err(|_| ())?;
                output.flush().map_err(|_| ())
            })();
            let failed = result.is_err();
            if written_tx.send(result).is_err() || failed {
                break;
            }
        }
    });
    let mut retirement_attempted = false;
    let mut host_failed = false;
    while let Ok(Ok(input)) = input_rx.recv_timeout(Duration::from_secs(120)) {
        let response = match owner.process(&input) {
            Ok(bytes) => bytes.to_vec(),
            Err(_) => {
                host_failed = true;
                break;
            }
        };
        if owner.lifecycle() == Lifecycle::Retired && !retirement_attempted {
            retirement_attempted = true;
            if engine.retire().is_err() {
                eprintln!("CREBAIN engine retirement unresolved; suffix remains unknown");
                host_failed = true;
            }
        }
        if output_tx.try_send(response).is_err()
            || !matches!(
                written_rx.recv_timeout(Duration::from_secs(120)),
                Ok(Ok(()))
            )
        {
            host_failed = true;
            break;
        }
    }
    owner.retire_channel();
    if engine.retire().is_err() {
        return Err("engine retirement unresolved; no complete terminal claim".into());
    }
    if host_failed {
        Err("NCP channel retired after failure".into())
    } else {
        Ok(())
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("CREBAIN sensor producer: {error}");
        std::process::exit(1);
    }
}
