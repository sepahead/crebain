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
    # ort-sys rc.12 publishes the pinned macOS static runtime only for Apple
    # Silicon. Keep the flake's advertised outputs aligned with the platforms
    # for which every fixed input is available and qualified.
    flake-utils.lib.eachSystem [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ] (
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

        linuxOnnxruntimeMerged = pkgs.symlinkJoin {
          name = "onnxruntime-merged";
          paths =
            [ pkgs.onnxruntime ]
            ++ pkgs.lib.optional (pkgs.onnxruntime ? dev) pkgs.onnxruntime.dev;
        };

        # Match ort-sys 2.0.0-rc.12's own immutable Apple Silicon
        # distribution. The raw-LZMA2 archive contains one static library;
        # both the archive and extracted library are digest checked. Every
        # Mach-O member in this exact library declares macOS 13.4.
        darwinOrtStaticArchive = pkgs.fetchurl {
          url = "https://cdn.pyke.io/0/pyke:ort-rs/ms@1.24.2/aarch64-apple-darwin.tar.lzma2";
          hash = "sha256-YSc591Q43AoHVGHh+0VCJrSh6xdeYKcnG6lmu7uXLNQ=";
        };
        darwinOrtStatic = pkgs.runCommand "onnxruntime-static-1.24.2-aarch64-darwin" {
          nativeBuildInputs = with pkgs; [
            coreutils
            gnutar
            xz
          ];
          dontStrip = true;
        } ''
          mkdir -p "$out/lib"
          xz --format=raw --lzma2=dict=64MiB -dc ${darwinOrtStaticArchive} \
            | tar -x -C "$out/lib" -f -
          test -f "$out/lib/libonnxruntime.a"
          test ! -L "$out/lib/libonnxruntime.a"
          echo "4d53c916ea95f09203324f9aad7b76f75c16d8a4bc98f8a949ea0ac73c07604d  $out/lib/libonnxruntime.a" \
            | sha256sum -c -
        '';
        darwinOrtLinkEnv = pkgs.lib.optionalAttrs isDarwin {
          ORT_LIB_PATH = "${darwinOrtStatic}/lib";
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
          darwinOrtStatic
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
          ORT_DYLIB_PATH = if isLinux then "${linuxOnnxruntimeMerged}/lib/libonnxruntime.so" else "";
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
            ORT_DYLIB_PATH = "${linuxOnnxruntimeMerged}/lib/libonnxruntime.so";
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
          ]
          ++ pkgs.lib.optionals isLinux [ wrapGAppsHook4 ]
          ++ pkgs.lib.optionals isDarwin [ pkgs.darwin.cctools ];
          buildInputs = platformBuildInputs;
          # Qualification runs the locked default/NCP test matrices separately;
          # this derivation is the clean frontend-plus-native package proof.
          doCheck = false;

          ORT_SKIP_DOWNLOAD = "1";
          ORT_DYLIB_PATH = if isLinux then "${linuxOnnxruntimeMerged}/lib/libonnxruntime.so" else "";

          preFixup = pkgs.lib.optionalString isLinux ''
            gappsWrapperArgs+=(
              --set-default ORT_DYLIB_PATH "${linuxOnnxruntimeMerged}/lib/libonnxruntime.so"
              --prefix LD_LIBRARY_PATH : "${linuxRuntimeLibraryPath}"
            )
          '';

          # Darwin stdenv supplies a Nix-built libiconv while compiling. Its
          # API is the same compatibility-version-7 interface that macOS ships,
          # but the current nixpkgs dylib targets a newer OS. Use the system
          # install name in the finished application, matching the ordinary
          # Cargo/Tauri package, then prove no Nix store dylib remains.
          postFixup = pkgs.lib.optionalString isDarwin ''
            app_binary="$out/Applications/crebain.app/Contents/MacOS/crebain"
            nix_iconv="$(
              otool -L "$app_binary" \
                | awk '$1 ~ /^\/nix\/store\/.*\/libiconv\.2\.dylib$/ { print $1 }'
            )"
            test -n "$nix_iconv"
            test "$(printf '%s\n' "$nix_iconv" | wc -l | tr -d ' ')" -eq 1
            install_name_tool \
              -change "$nix_iconv" /usr/lib/libiconv.2.dylib \
              "$app_binary"
            otool -L "$app_binary" | grep -Fq '/usr/lib/libiconv.2.dylib'
            if otool -L "$app_binary" | tail -n +2 | grep -Fq '/nix/store/'; then
              echo 'unexpected Nix store dynamic dependency in macOS application' >&2
              exit 1
            fi
          '';

          meta = with pkgs.lib; {
            description = "Research-only spatial visualization, simulation, and sensor-fusion prototype";
            homepage = "https://github.com/sepahead/crebain";
            license = [
              licenses.mit
              licenses.asl20
            ];
            mainProgram = "crebain";
            platforms = [
              "aarch64-darwin"
              "aarch64-linux"
              "x86_64-linux"
            ];
          };
        } // darwinOrtLinkEnv);
      }
    );
}
