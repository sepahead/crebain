{
  description = "CREBAIN research-only visualization, simulation, and sensor-fusion prototype";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils = {
      url = "github:numtide/flake-utils";
      inputs.systems.follows = "systems";
    };
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    systems.url = "github:nix-systems/default";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    bun2nix = {
      url = "github:nix-community/bun2nix/2.1.1";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.systems.follows = "systems";
      inputs.flake-parts.follows = "flake-parts";
      inputs.treefmt-nix.follows = "treefmt-nix";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      rust-overlay,
      bun2nix,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        # nixpkgs is locked independently, so bind Bun's official release
        # archives here to keep Nix, CI, and the JavaScript manifest identical.
        bunVersion = "1.3.14";
        bunReleaseAssets = {
          "aarch64-darwin" = {
            file = "bun-darwin-aarch64.zip";
            hash = "sha256-2LliIYKK1vl6x6wKt+lYcjQa92MAHogD6CZ2UsJlJiA=";
          };
          "aarch64-linux" = {
            file = "bun-linux-aarch64.zip";
            hash = "sha256-on/7Y6gxA3WDbg1vZorhf6jY0YuIw3yCHGUzGXOhmjs=";
          };
          "x86_64-darwin" = {
            file = "bun-darwin-x64-baseline.zip";
            hash = "sha256-PjWtb1OXGpg0v55nhuKt9ytfGSHMmpxf3gc9KXKUQHY=";
          };
          "x86_64-linux" = {
            file = "bun-linux-x64.zip";
            hash = "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=";
          };
        };
        exactBunOverlay = final: previous: {
          bun = previous.bun.overrideAttrs (old: {
            version = bunVersion;
            src = final.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${bunReleaseAssets.${system}.file}";
              inherit (bunReleaseAssets.${system}) hash;
            };
            passthru = (old.passthru or { }) // {
              sources = builtins.mapAttrs (
                _: asset:
                final.fetchurl {
                  url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${asset.file}";
                  inherit (asset) hash;
                }
              ) bunReleaseAssets;
            };
          });
        };
        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            rust-overlay.overlays.default
            exactBunOverlay
            # bun2nix's easyOverlay captures `prev`; it must see exactBunOverlay
            # so its setup hook and dependency-cache builders use the same Bun.
            bun2nix.overlays.default
          ];
          # The explicit x86_64-linux CUDA development shell references unfree
          # NVIDIA packages. The default package does not.
          config.allowUnfree = true;
        };
        inherit (pkgs.stdenv) isDarwin isLinux;
        exactBun = assert pkgs.bun.version == bunVersion; pkgs.bun;

        # Use the repository's exact Rust channel and component declaration.
        # The custom Rust platform makes buildRustPackage use the same toolchain,
        # rather than whichever Rust release happens to accompany nixpkgs.
        rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
        rustPlatform = pkgs.makeRustPlatform {
          cargo = rustToolchain;
          rustc = rustToolchain;
        };
        tauriHook = pkgs.cargo-tauri.hook.override {
          cargo = rustToolchain;
        };

        onnxruntimeMerged = pkgs.symlinkJoin {
          name = "onnxruntime-merged";
          paths =
            [ pkgs.onnxruntime ]
            ++ pkgs.lib.optional (pkgs.onnxruntime ? dev) pkgs.onnxruntime.dev;
        };
        darwinOrtLinkEnv = pkgs.lib.optionalAttrs isDarwin {
          ORT_LIB_PATH = "${onnxruntimeMerged}/lib";
          ORT_PREFER_DYNAMIC_LINK = "1";
        };

        linuxBuildInputs = with pkgs; [
          glib
          glib-networking
          gtk3
          libayatana-appindicator
          librsvg
          libsoup_3
          onnxruntime
          openssl
          webkitgtk_4_1
          zlib
        ];
        darwinBuildInputs = with pkgs; [
          libiconv
          onnxruntimeMerged
          openssl
          zlib
        ];
        platformBuildInputs = if isLinux then linuxBuildInputs else darwinBuildInputs;
        linuxRuntimeLibraryPath = pkgs.lib.makeLibraryPath linuxBuildInputs;

        commonDevelopmentInputs = with pkgs; [
          exactBun
          cargo-edit
          cargo-watch
          cmake
          nodejs_24
          pkg-config
          rustToolchain
        ];
        cpuShell = pkgs.mkShell ({
          packages = commonDevelopmentInputs ++ platformBuildInputs;
          RUST_BACKTRACE = "1";
          RUST_LOG = "info";
          ORT_SKIP_DOWNLOAD = "1";
          CARGO_FEATURES = "";
          CREBAIN_BACKEND = if isDarwin then "coreml" else "onnx";
          CREBAIN_ZENOH = "1";
          ORT_DYLIB_PATH = if isLinux then "${onnxruntimeMerged}/lib/libonnxruntime.so" else "";
          LD_LIBRARY_PATH = if isLinux then linuxRuntimeLibraryPath else "";
        } // darwinOrtLinkEnv);
      in
      {
        devShells = {
          default = cpuShell;
          cpu-only = cpuShell;
        }
        // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
          cuda = pkgs.mkShell {
            packages =
              commonDevelopmentInputs
              ++ linuxBuildInputs
              ++ (with pkgs.cudaPackages; [
                cudatoolkit
                cudnn
                nccl
              ]);
            RUST_BACKTRACE = "1";
            RUST_LOG = "info";
            ORT_SKIP_DOWNLOAD = "1";
            CARGO_FEATURES = "cuda";
            CREBAIN_BACKEND = "onnx";
            CREBAIN_ZENOH = "1";
            CUDA_PATH = "${pkgs.cudaPackages.cudatoolkit}";
            ORT_DYLIB_PATH = "${onnxruntimeMerged}/lib/libonnxruntime.so";
            LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (
              linuxBuildInputs
              ++ (with pkgs.cudaPackages; [
                cudatoolkit
                cudnn
                nccl
              ])
            );
          };
        };

        packages.default = rustPlatform.buildRustPackage ({
          pname = "crebain";
          version = "0.9.0";

          # Flake `self` is the clean, lock-pinned Git source. cargo-tauri runs
          # the configured bounded frontend build before compiling and bundling.
          src = self;
          cargoRoot = "src-tauri";
          buildAndTestSubdir = "src-tauri";
          tauriBundleType = if isLinux then "deb" else "app";

          cargoLock = {
            lockFile = ./src-tauri/Cargo.lock;
            # One fixed-output source covers both optional packages because
            # Cargo.lock resolves ncp-core and ncp-zenoh from the same commit.
            outputHashes = {
              "ncp-core-0.8.0" = "sha256-GaYmp35xnxlZ0TClyKsFNYswzulgyaCA+TPzF6bJMVk=";
            };
          };

          bunDeps = pkgs.bun2nix.fetchBunDeps {
            bunNix = ./bun.nix;
          };
          dontRunLifecycleScripts = true;
          # Preserve the audited source bytes through the frontend build. The
          # package invokes tooling from nativeBuildInputs by name and installs
          # the compiled application rather than repository scripts.
          dontUseBunPatch = true;
          dontUseBunBuild = true;
          dontUseBunCheck = true;
          dontUseBunInstall = true;
          bunInstallFlags =
            if isDarwin then
              [
                "--linker=hoisted"
                "--backend=copyfile"
              ]
            else
              [ "--linker=hoisted" ];

          nativeBuildInputs = with pkgs; [
            tauriHook
            exactBun
            pkgs.bun2nix.hook
            cmake
            nodejs_24
            pkg-config
          ] ++ pkgs.lib.optionals isLinux [ wrapGAppsHook4 ];
          buildInputs = platformBuildInputs;
          # Qualification runs the locked default/NCP test matrices separately;
          # this derivation is the clean frontend-plus-native package proof.
          doCheck = false;

          ORT_SKIP_DOWNLOAD = "1";
          ORT_DYLIB_PATH = if isLinux then "${onnxruntimeMerged}/lib/libonnxruntime.so" else "";

          preFixup = pkgs.lib.optionalString isLinux ''
            gappsWrapperArgs+=(
              --set-default ORT_DYLIB_PATH "${onnxruntimeMerged}/lib/libonnxruntime.so"
              --prefix LD_LIBRARY_PATH : "${linuxRuntimeLibraryPath}"
            )
          '';

          meta = with pkgs.lib; {
            description = "Research-only spatial visualization, simulation, and sensor-fusion prototype";
            homepage = "https://github.com/sepahead/crebain";
            license = [
              licenses.mit
              licenses.asl20
            ];
            mainProgram = "crebain";
            platforms = platforms.linux ++ platforms.darwin;
          };
        } // darwinOrtLinkEnv);
      }
    );
}
