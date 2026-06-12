fn main() {
    tauri_build::build();

    // Link macOS frameworks for native CoreML FFI
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=CoreML");
        println!("cargo:rustc-link-lib=framework=Vision");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=Accelerate");
    }
}
