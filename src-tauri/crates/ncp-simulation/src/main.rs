//! `crebain-ncp-simulation`: one `crebain.body` session on standard input and output.
//!
//! The process opens no network listener. It takes no arguments; the host's `prepare` request
//! carries the whole configuration.

use crebain_ncp_simulation::{body::Body, body_contract};
use ncp::{binding::serve_stdio, Owner, DEFAULT_BOUND};

fn main() {
    if std::env::args().len() > 1 {
        eprintln!("crebain-ncp-simulation takes no arguments; it serves one NCP 2 session on standard input and output");
        std::process::exit(2);
    }
    let contract = body_contract();
    let mut owner = Owner::new(contract, Body::default()).with_max_bound(DEFAULT_BOUND);
    if let Err(error) = serve_stdio(&mut owner) {
        eprintln!("crebain-ncp-simulation: {error}");
        std::process::exit(1);
    }
}
