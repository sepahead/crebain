//! Test-only independent public decoding. This executable cannot construct an engine.

use crebain_ncp_force_city_sources::{
    application::CityApplication,
    contract,
    engine::{EngineBatch, EngineError, EnginePort, EnginePrepared},
    types::{Advance, Prepare},
};
use ncp_local::{
    modular_buffer::BufferBinding,
    modular_owner::{self, AppOperation, Contract},
    modular_wire::{self as w, Command, Request},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeSet, error::Error, fs::File, io::Read, path::Path};

// An uninhabited type makes even accidental engine construction impossible.
enum NoEngine {}
impl EnginePort for NoEngine {
    fn prepare(&mut self, _: &str, _: &str, _: &Prepare) -> Result<EnginePrepared, EngineError> {
        match *self {}
    }
    fn advance(&mut self, _: &Advance, _: Option<&str>) -> Result<EngineBatch, EngineError> {
        match *self {}
    }
    fn read_chunk(
        &mut self,
        _: &str,
        _: &str,
        _: &str,
        _: usize,
        _: usize,
    ) -> Result<Vec<u8>, EngineError> {
        match *self {}
    }
    fn release(&mut self, _: &str) -> Result<(), EngineError> {
        match *self {}
    }
    fn retire(&mut self) -> Result<(), EngineError> {
        match *self {}
    }
}
type App = CityApplication<NoEngine>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    layer: String,
}

fn read(path: &Path, limit: u64) -> Result<Vec<u8>, Box<dyn Error>> {
    if !path.symlink_metadata()?.is_file() {
        return Err("fixture is not a regular file".into());
    }
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err("fixture extent".into());
    }
    Ok(bytes)
}
fn binding() -> Result<BufferBinding, w::ModularError> {
    Ok(BufferBinding {
        profile_digest: modular_owner::profile_digest()?,
        application_digest: w::typed_digest(
            w::PROFILE_DOMAIN,
            &w::parse_value(contract::DESCRIPTOR)?,
            None,
        )?,
        run_id: "11111111-1111-4111-8111-111111111111".into(),
        endpoint_id: "22222222-2222-4222-8222-222222222222".into(),
        generation: "33333333-3333-4333-8333-333333333333".into(),
    })
}
fn evaluate(
    case: &Case,
    raw: &[u8],
    response: Option<&[u8]>,
    binding: &BufferBinding,
) -> Result<Value, Box<dyn Error>> {
    let mut row = json!({"id": case.id, "layer": case.layer, "request_accepted": false,
        "accepted": false, "stage": "request", "error": null, "request_digest": null,
        "result_digest": null, "typed_value_digest": null});
    let request = match Request::<AppOperation<App>>::decode(raw, binding) {
        Ok(request) => request,
        Err(error) => {
            row["error"] = json!(format!("{error:?}"));
            return Ok(row);
        }
    };
    row["request_accepted"] = json!(true);
    row["request_digest"] = json!(request.request_digest);
    row["stage"] = json!("input");
    let Command::Execute { operation, .. } = &request.command else {
        return Err("corpus requires execute".into());
    };
    if let Err(error) = App::check_input(operation) {
        row["error"] = json!(format!("{error:?}"));
        return Ok(row);
    }
    if !App::allows(operation.name()) {
        row["error"] = json!("operation not allowed");
        return Ok(row);
    }
    let projected = if let Some(raw) = response {
        row["stage"] = json!("response");
        match modular_owner::verify_response::<App>(binding, &request, raw) {
            Ok(value) => {
                row["result_digest"] = json!(value.result_digest);
                serde_json::to_value(&value.body)?
            }
            Err(error) => {
                row["error"] = json!(format!("{error:?}"));
                return Ok(row);
            }
        }
    } else {
        serde_json::to_value(operation)?
    };
    row["typed_value_digest"] = json!(w::typed_digest(w::PROFILE_DOMAIN, &projected, None)?);
    row["accepted"] = json!(true);
    row["stage"] = json!("accepted");
    Ok(row)
}
fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args_os().skip(1);
    let root = args.next().ok_or("one fixture directory required")?;
    if args.next().is_some() {
        return Err("one fixture directory required".into());
    }
    let root = Path::new(&root);
    let bytes = read(&root.join("manifest.json"), 65_536)?;
    // The public scanner rejects duplicate metadata keys before closed deserialization.
    let manifest: Manifest = serde_json::from_value(w::parse_value(&bytes)?)?;
    if manifest.schema != "crebain.city-codec-corpus.v1"
        || manifest.cases.is_empty()
        || manifest.cases.len() > 128
    {
        return Err("manifest bounds".into());
    }
    let mut seen = BTreeSet::new();
    for case in &manifest.cases {
        if case.id.is_empty()
            || case.id.len() > 64
            || !case
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            || !seen.insert(&case.id)
            || !matches!(case.layer.as_str(), "request" | "response")
        {
            return Err("manifest case".into());
        }
    }
    let binding = binding()?;
    let mut rows = Vec::with_capacity(manifest.cases.len());
    for (i, case) in manifest.cases.iter().enumerate() {
        let raw = read(&root.join(format!("{i:03}.request.bin")), 65_537)?;
        let response = if case.layer == "response" {
            Some(read(&root.join(format!("{i:03}.response.bin")), 65_537)?)
        } else {
            None
        };
        rows.push(evaluate(case, &raw, response.as_deref(), &binding)?);
    }
    let report =
        serde_json::to_vec(&json!({"schema": "crebain.city-codec-report.v1", "rows": rows}))?;
    if report.len() >= 262_144 {
        return Err("report extent".into());
    }
    println!("{}", std::str::from_utf8(&report)?);
    Ok(())
}
