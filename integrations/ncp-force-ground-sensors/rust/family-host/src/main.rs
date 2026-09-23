//! The only raw-descriptor ownership transfer for the optional family executable.

use crebain_ncp_force_ground_sensors::family_host::{self, LaunchPlan};

// The application library still forbids unsafe Rust. This private startup capsule
// contains the bounded operating-system inspection and exclusive ownership transfer.
#[allow(unsafe_code)]
mod inherited;

fn run() -> Result<(), String> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let launch = LaunchPlan::parse(&arguments).map_err(str::to_owned)?;
    // Startup has created no threads, signal handlers, FD-owning helpers, or children.
    // No code can close/reassign the inherited service roster during this transfer.
    let streams =
        inherited::take_at_startup(&launch.service_fds).map_err(|error| error.to_string())?;
    family_host::run(launch, streams)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("CREBAIN live family: {error}");
        std::process::exit(1);
    }
}
