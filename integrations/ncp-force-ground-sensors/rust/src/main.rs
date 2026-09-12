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

struct LauncherArguments<'a> {
    bun: &'a Path,
    node: Option<&'a Path>,
    bridge: &'a Path,
    source_identity: &'a str,
    binding_json: &'a str,
}

fn launcher_arguments(args: &[String]) -> Result<LauncherArguments<'_>, String> {
    let (bun, node, bridge, source_identity, binding_json) = match args {
        [bun_key, bun, node_key, node, bridge_key, bridge, source_key, source, binding_key, binding]
            if bun_key == "--bun"
                && node_key == "--node"
                && bridge_key == "--bridge"
                && source_key == "--source-identity"
                && binding_key == "--binding-json" =>
        {
            (bun, Some(Path::new(node)), bridge, source, binding)
        }
        [bun_key, bun, bridge_key, bridge, source_key, source, binding_key, binding]
            if bun_key == "--bun"
                && bridge_key == "--bridge"
                && source_key == "--source-identity"
                && binding_key == "--binding-json" =>
        {
            (bun, None, bridge, source, binding)
        }
        _ => return Err("trusted launcher arguments required".into()),
    };
    Ok(LauncherArguments {
        bun: Path::new(bun),
        node,
        bridge: Path::new(bridge),
        source_identity,
        binding_json,
    })
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args = launcher_arguments(&args)?;
    let value = ncp_local::modular_wire::parse_value(args.binding_json.as_bytes())
        .map_err(|_| "binding JSON")?;
    let binding: BufferBinding = serde_json::from_value(value).map_err(|_| "binding schema")?;
    binding.validate().map_err(|_| "binding identity")?;
    let mut semantics = ["rgba8", "radiance", "pressure"]
        .iter()
        .map(|kind| contract::semantic(kind))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "installed semantic descriptors")?;
    semantics.sort();
    let engine = EngineProcess::spawn(args.bun, args.node, args.bridge, binding.generation.clone())
        .map_err(|_| "engine start")?;
    let mut engine = SharedEngine::new(engine);
    let application = SensorApplication::new(engine.clone(), args.source_identity.to_owned())
        .map_err(|_| "source identity")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_forms_keep_node_explicit_and_optional() {
        let plain = [
            "--bun",
            "/selected/bun",
            "--bridge",
            "/selected/bridge.ts",
            "--source-identity",
            "source",
            "--binding-json",
            "{}",
        ]
        .map(String::from)
        .to_vec();
        let parsed = launcher_arguments(&plain).unwrap();
        assert_eq!(parsed.node, None);
        assert_eq!(parsed.bun, Path::new("/selected/bun"));
        assert_eq!(parsed.bridge, Path::new("/selected/bridge.ts"));
        assert_eq!(parsed.source_identity, "source");
        assert_eq!(parsed.binding_json, "{}");
        let mut rendered = plain.clone();
        rendered.splice(2..2, ["--node".into(), "/selected/node".into()]);
        assert_eq!(
            launcher_arguments(&rendered).unwrap().node,
            Some(Path::new("/selected/node"))
        );
        for count in [0, 1, 7, 9] {
            assert!(launcher_arguments(&rendered[..count]).is_err());
        }
        for index in (0..rendered.len()).step_by(2) {
            let mut malformed = rendered.clone();
            malformed[index] = "--unknown".into();
            assert!(launcher_arguments(&malformed).is_err());
        }
        let mut repeated = plain;
        repeated[2] = "--bun".into();
        assert!(launcher_arguments(&repeated).is_err());
    }
}
