use std::io::{self, Write};

fn main() {
    std::panic::set_hook(Box::new(|_| {
        let _ = writeln!(
            io::stderr().lock(),
            "managed-runtime: internal-panic-contained"
        );
    }));
    if let Err(error) = crebain_managed_simulation::serve_managed_runtime(
        &mut io::stdin().lock(),
        &mut io::stdout().lock(),
    ) {
        let _ = writeln!(io::stderr().lock(), "managed-runtime: {}", error.reason());
        std::process::exit(2);
    }
}
