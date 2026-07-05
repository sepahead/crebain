# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CREBAIN - Adaptive Response & Awareness System (ARAS)
# Adaptives Reaktions- und Aufklärungssystem
#
# Cross-platform Nix flake for macOS (Apple Silicon) and NixOS (CUDA)
#
# Usage:
#   nix develop                    # Enter dev shell (auto-detects platform)
#   nix develop .#cuda             # Force CUDA dev shell
#   nix develop .#cpu-only         # CPU-only dev shell
#   nix build                      # Build for current platform
#   nix run                        # Run the application
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  description = "CREBAIN - Adaptive Response & Awareness System (ARAS)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [
          rust-overlay.overlays.default
        ];
        isLinuxSystem = builtins.match ".*-linux" system != null;
        pkgs = import nixpkgs {
          inherit system overlays;
          config = {
            allowUnfree = true;  # Required for CUDA packages
            cudaSupport = isLinuxSystem;
          };
        };

        # ─────────────────────────────────────────────────────────────────────
        # PLATFORM DETECTION
        # ─────────────────────────────────────────────────────────────────────

        isDarwin = pkgs.stdenv.isDarwin;
        isLinux = pkgs.stdenv.isLinux;
        isAarch64 = pkgs.stdenv.hostPlatform.isAarch64;

        # Check if CUDA is available on this system.
        #
        # On NixOS, `nvidia-smi` is typically in `/run/current-system/sw/bin` or
        # `/run/wrappers/bin` rather than `/usr/bin`.
        hasCuda = isLinux && (
          builtins.pathExists "/dev/nvidia0"
          || builtins.pathExists "/proc/driver/nvidia/version"
          || builtins.pathExists "/run/current-system/sw/bin/nvidia-smi"
          || builtins.pathExists "/run/wrappers/bin/nvidia-smi"
          || builtins.pathExists "/usr/bin/nvidia-smi"
          || builtins.pathExists "/bin/nvidia-smi"
        );

        # ─────────────────────────────────────────────────────────────────────
        # RUST TOOLCHAIN
        # ─────────────────────────────────────────────────────────────────────

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
          targets = if isDarwin
            then [ "aarch64-apple-darwin" "x86_64-apple-darwin" ]
            else [ "x86_64-unknown-linux-gnu" "aarch64-unknown-linux-gnu" ];
        };

        # ─────────────────────────────────────────────────────────────────────
        # COMMON DEPENDENCIES (All Platforms)
        # ─────────────────────────────────────────────────────────────────────

        commonBuildInputs = with pkgs; [
          # Rust
          rustToolchain
          cargo
          cargo-watch
          cargo-edit


          # Node.js / Bun for frontend
          nodejs_20
          bun

          # Build tools
          pkg-config
          cmake
          gnumake

          # Common dependencies
          openssl
          zlib

          # Zenoh (built via Cargo, but we need system deps)
          # zenoh-rs links against these
        ];

        # ─────────────────────────────────────────────────────────────────────
        # MACOS DEPENDENCIES (Apple Silicon / Intel)
        # ─────────────────────────────────────────────────────────────────────

        darwinBuildInputs = with pkgs; [
          # Apple Frameworks for CoreML/Metal
          darwin.apple_sdk.frameworks.CoreML
          darwin.apple_sdk.frameworks.Metal
          darwin.apple_sdk.frameworks.MetalPerformanceShaders
          darwin.apple_sdk.frameworks.Accelerate
          darwin.apple_sdk.frameworks.Vision
          darwin.apple_sdk.frameworks.CoreVideo
          darwin.apple_sdk.frameworks.CoreMedia
          darwin.apple_sdk.frameworks.CoreGraphics
          darwin.apple_sdk.frameworks.AVFoundation
          darwin.apple_sdk.frameworks.Security
          darwin.apple_sdk.frameworks.SystemConfiguration
          darwin.apple_sdk.frameworks.WebKit
          darwin.apple_sdk.frameworks.AppKit
          darwin.apple_sdk.frameworks.Foundation
          darwin.apple_sdk.frameworks.IOKit

          # System libraries
          libiconv
          darwin.libobjc
        ];

        # ─────────────────────────────────────────────────────────────────────
        # LINUX DEPENDENCIES (NixOS with optional CUDA)
        # ─────────────────────────────────────────────────────────────────────

	        linuxBuildInputs = with pkgs; [
          # Tauri dependencies
          gtk3
          webkitgtk
          libsoup
          glib
          cairo
          pango
          gdk-pixbuf
          atk

	          # ONNX Runtime (CPU fallback)
	          onnxruntime

          # Audio/Video
          alsa-lib
          libappindicator

          # Vulkan for WebGPU
          vulkan-loader
          vulkan-headers
          vulkan-tools

          # X11 (for Tauri and headless Gazebo)
          xorg.libX11
          xorg.libXcursor
          xorg.libXrandr
          xorg.libXi
          xorg.libxcb

          # D-Bus
          dbus
	        ];

	        # Nixpkgs may split `onnxruntime` into multiple outputs (typically `out`
	        # for runtime libraries and `dev` for headers and unversioned linker
	        # symlinks). `ort`'s dynamic loader benefits
	        # from a single path that exposes `include/` and `lib/libonnxruntime.so`.
	        onnxruntimeMerged = pkgs.symlinkJoin {
	          name = "onnxruntime-merged";
	          paths = [ pkgs.onnxruntime ] ++ pkgs.lib.optional (pkgs.onnxruntime ? dev) pkgs.onnxruntime.dev;
	        };

	        # CUDA dependencies (only for Linux with NVIDIA GPU)
	        cudaBuildInputs = with pkgs; [
	          cudaPackages.cudatoolkit
	          cudaPackages.cudnn
	          cudaPackages.tensorrt
          cudaPackages.nccl
        ];

        # ─────────────────────────────────────────────────────────────────────
        # GAZEBO / ROS DEPENDENCIES
        # ─────────────────────────────────────────────────────────────────────

        gazeboDeps = with pkgs; if isLinux then [
          # Gazebo Ignition (Garden/Harmonic)
          # Note: May need to build from source or use rosdistro
        ] else [];

        # ─────────────────────────────────────────────────────────────────────
        # COMBINED DEPENDENCIES
        # ─────────────────────────────────────────────────────────────────────

        platformBuildInputs =
          if isDarwin then darwinBuildInputs
          else linuxBuildInputs ++ (if hasCuda then cudaBuildInputs else []);

      in
      {
        # ─────────────────────────────────────────────────────────────────────
        # DEVELOPMENT SHELLS
        # ─────────────────────────────────────────────────────────────────────

        # Default development shell (auto-detects platform)
        devShells.default = pkgs.mkShell {
          buildInputs = commonBuildInputs ++ platformBuildInputs ++ gazeboDeps;

          RUST_BACKTRACE = "1";
          RUST_LOG = "info";
          ORT_SKIP_DOWNLOAD = "1";

          # Cargo features based on platform
          CARGO_FEATURES = if isDarwin then "" else (if hasCuda then "cuda" else "");

          # Library paths for dynamic linking
          LD_LIBRARY_PATH = if isLinux then
            pkgs.lib.makeLibraryPath (linuxBuildInputs ++ (if hasCuda then cudaBuildInputs else []))
          else "";

	          # CUDA paths (Linux only)
	          CUDA_PATH = if hasCuda then "${pkgs.cudaPackages.cudatoolkit}" else "";
	          TENSORRT_ROOT = if hasCuda then "${pkgs.cudaPackages.tensorrt}" else "";
	          # `ort` uses dynamic loading; make the ONNX Runtime dylib location explicit to
	          # avoid accidentally picking up a different `libonnxruntime.so` from the host.
	          ORT_DYLIB_PATH = if isLinux then "${onnxruntimeMerged}/lib/libonnxruntime.so" else "";

          shellHook = ''
            echo ""
            echo "╔══════════════════════════════════════════════════════════════════╗"
            echo "║        CREBAIN - Adaptive Response & Awareness System            ║"
            echo "║        Adaptives Reaktions- und Aufklärungssystem (ARAS)         ║"
            echo "╠══════════════════════════════════════════════════════════════════╣"
            ${if isDarwin then ''
            echo "║  Platform:   macOS ${if isAarch64 then "(Apple Silicon)" else "(Intel)"}                              ║"
            echo "║  ML Backend: CoreML / MLX                                        ║"
            echo "║  GPU:        Metal                                               ║"
            echo "║  Features:   (default)                                           ║"
            '' else ''
            echo "║  Platform:   Linux (NixOS)                                       ║"
            ${if hasCuda then ''
            echo "║  ML Backend: CUDA / TensorRT                                     ║"
            echo "║  GPU:        $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "NVIDIA (not detected)")  ║"
            echo "║  Features:   --features cuda                                     ║"
            '' else ''
            echo "║  ML Backend: ONNX Runtime (CPU)                                  ║"
            echo "║  GPU:        None (CPU fallback)                                 ║"
            echo "║  Features:   (none)                                              ║"
            ''}
            ''}
            echo "╠══════════════════════════════════════════════════════════════════╣"
            echo "║  Rust:   $(rustc --version | cut -d' ' -f2)                                                ║"
            echo "║  Bun:    $(bun --version 2>/dev/null || echo "not found")                                                 ║"
            echo "╠══════════════════════════════════════════════════════════════════╣"
            echo "║  Commands:                                                       ║"
            echo "║    bun install          - Install frontend dependencies          ║"
            echo "║    bun run dev          - Start frontend dev server              ║"
            echo "║    bun run tauri dev    - Start Tauri app                        ║"
            echo "║    cargo build          - Build Rust backend                     ║"
            echo "╚══════════════════════════════════════════════════════════════════╝"
            echo ""

            # Platform-specific environment
            ${if isDarwin then ''
            export CREBAIN_BACKEND=coreml
            export CREBAIN_ZENOH=1
            '' else ''
            ${if hasCuda then ''
            export CREBAIN_BACKEND=tensorrt
            '' else ''
            export CREBAIN_BACKEND=onnx
            ''}
            export CREBAIN_ZENOH=1
            export RMW_IMPLEMENTATION=rmw_zenoh_cpp
            ''}

            # Ensure NVIDIA driver libraries are visible when available (NixOS).
            if [ -d /run/opengl-driver/lib ]; then
              export LD_LIBRARY_PATH="/run/opengl-driver/lib:$LD_LIBRARY_PATH"
            fi
            if [ -d /run/opengl-driver-32/lib ]; then
              export LD_LIBRARY_PATH="/run/opengl-driver-32/lib:$LD_LIBRARY_PATH"
            fi
          '';
        };

        # CUDA development shell (force CUDA even if not auto-detected)
	        devShells.cuda = pkgs.mkShell {
	          buildInputs = commonBuildInputs ++ linuxBuildInputs ++ cudaBuildInputs;

          RUST_BACKTRACE = "1";
	          ORT_SKIP_DOWNLOAD = "1";
	          CARGO_FEATURES = "cuda";
	          CUDA_PATH = "${pkgs.cudaPackages.cudatoolkit}";
	          TENSORRT_ROOT = "${pkgs.cudaPackages.tensorrt}";
	          ORT_DYLIB_PATH = "${onnxruntimeMerged}/lib/libonnxruntime.so";
	          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (linuxBuildInputs ++ cudaBuildInputs);

          shellHook = ''
            echo "CREBAIN Development Environment (CUDA Forced)"
            echo "=============================================="
            export CREBAIN_BACKEND=tensorrt
            export CREBAIN_ZENOH=1

            # Ensure NVIDIA driver libraries are visible when available (NixOS).
            if [ -d /run/opengl-driver/lib ]; then
              export LD_LIBRARY_PATH="/run/opengl-driver/lib:$LD_LIBRARY_PATH"
            fi
            if [ -d /run/opengl-driver-32/lib ]; then
              export LD_LIBRARY_PATH="/run/opengl-driver-32/lib:$LD_LIBRARY_PATH"
            fi
          '';
        };

        # CPU-only development shell (no GPU acceleration)
	        devShells.cpu-only = pkgs.mkShell {
          buildInputs = commonBuildInputs ++ (if isLinux then linuxBuildInputs else darwinBuildInputs);

	          RUST_BACKTRACE = "1";
	          ORT_SKIP_DOWNLOAD = "1";
	          CARGO_FEATURES = "";
	          ORT_DYLIB_PATH = if isLinux then "${onnxruntimeMerged}/lib/libonnxruntime.so" else "";

          shellHook = ''
            echo "CREBAIN Development Environment (CPU Only)"
            echo "=========================================="
            export CREBAIN_BACKEND=onnx
            export CREBAIN_ZENOH=1
          '';
        };

        # Main package build
        packages.default = pkgs.rustPlatform.buildRustPackage {
          pname = "crebain";
          version = "0.4.0";
          
          src = ./.;
          cargoLock.lockFile = ./src-tauri/Cargo.lock;
          
          nativeBuildInputs = with pkgs; [
            pkg-config
            cmake
            rustToolchain
            makeWrapper
          ];
          
          buildInputs = commonBuildInputs ++ (
            if pkgs.stdenv.isLinux then linuxBuildInputs ++ (if hasCuda then cudaBuildInputs else []) else []
          );
          ORT_SKIP_DOWNLOAD = "1";
          
          
          # Build Tauri app
          buildPhase = ''
            cd src-tauri
            cargo build --release ${if hasCuda then "--features cuda" else ""}
          '';
          
          installPhase = ''
            mkdir -p $out/bin
            cp target/release/crebain $out/bin/crebain
            
	            ${pkgs.lib.optionalString pkgs.stdenv.isLinux ''
	            # `ort` loads ONNX Runtime dynamically. Make the dylib path explicit so
	            # `nix run` works without requiring users to export ORT_DYLIB_PATH.
	            wrapProgram $out/bin/crebain \
	              --set-default ORT_DYLIB_PATH "${onnxruntimeMerged}/lib/libonnxruntime.so" \
	              --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath (linuxBuildInputs ++ (if hasCuda then cudaBuildInputs else []))}" \
	              --prefix LD_LIBRARY_PATH : "/run/opengl-driver/lib" \
	              --prefix LD_LIBRARY_PATH : "/run/opengl-driver-32/lib"
	            ''}
            
            # Copy resources
            mkdir -p $out/share/crebain/models
            cp -r resources/* $out/share/crebain/models/ 2>/dev/null || true
            
          '';
          
	          meta = with pkgs.lib; {
	            description = "CREBAIN - Adaptive Response & Awareness System (ARAS)";
	            homepage = "https://github.com/sepahead/crebain";
	            license = [ licenses.mit licenses.asl20 ];
	            platforms = platforms.linux ++ platforms.darwin;
	          };
	        };

        # Docker image for deployment
        packages.docker = pkgs.dockerTools.buildImage {
          name = "crebain";
          tag = "latest";
          
          copyToRoot = pkgs.buildEnv {
            name = "crebain-root";
            paths = [ self.packages.${system}.default ];
          };
          
          config = {
            Cmd = [ "/bin/crebain" ];
            Env = [
              "RUST_LOG=info"
              "CREBAIN_MODEL_PATH=/share/crebain/models/yolov8s.onnx"
            ];
          };
        };

      }
    );
}
