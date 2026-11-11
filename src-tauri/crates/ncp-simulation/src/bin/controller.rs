//! `crebain-ncp-controller`: the reference controller, one `crebain.controller` session on
//! standard input and output.

use crebain_ncp_simulation::{controller::Reference, controller_contract};
use ncp::{binding::serve_stdio, Owner, DEFAULT_BOUND};

fn main() {
    if std::env::args().len() > 1 {
        eprintln!("crebain-ncp-controller takes no arguments; prepare carries its parameters");
        std::process::exit(2);
    }
    let contract = controller_contract();
    let mut owner = Owner::new(
        &contract.application,
        &contract.identity,
        Reference::default(),
        contract.operations,
        DEFAULT_BOUND,
    );
    if let Err(error) = serve_stdio(&mut owner) {
        eprintln!("crebain-ncp-controller: {error}");
        std::process::exit(1);
    }
}
