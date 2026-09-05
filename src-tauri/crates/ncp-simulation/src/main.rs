use std::io;

use crebain_ncp_simulation::BodyBackend;
use ncp_local::local::{serve_local, LocalBinding, LocalCode, LocalError, LocalOwner};

fn run() -> Result<(), LocalError> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--binding") {
        return Err(LocalError(LocalCode::Binding));
    }
    let binding = args.next().ok_or(LocalError(LocalCode::Binding))?;
    if binding.len() > 2_048 || args.next().is_some() {
        return Err(LocalError(LocalCode::Binding));
    }
    let binding: LocalBinding =
        serde_json::from_str(&binding).map_err(|_| LocalError(LocalCode::Binding))?;
    let backend = BodyBackend::new(binding.clone())?;
    let mut owner = LocalOwner::new(binding, backend)?;
    serve_local(
        &mut owner,
        &mut io::stdin().lock(),
        &mut io::stdout().lock(),
    )
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}
