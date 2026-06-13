# Changelog

All notable changes to CREBAIN are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This project is a research prototype; capability statuses are tracked in the
README and treated as unverified until measured on target hardware.

## [Unreleased]

Open-source readiness and quality hardening.

### Added

- ESLint (typescript-eslint type-checked + react-hooks) and Prettier, wired into
  `bun run validate`; `.editorconfig`.
- Frontend coverage via `@vitest/coverage-istanbul` with regression-ratchet
  thresholds; an initial-bundle size budget guard (`bun run check:bundle`).
- `rust-toolchain.toml` pinning the toolchain; enforced `cargo fmt` and the
  `clippy::undocumented_unsafe_blocks` lint.
- AppHandle-backed IPC integration tests (Tauri mock runtime) and a
  constant-velocity fusion tracking scenario; render smoke tests for the viewer
  panels.
- CI hardening (least-privilege permissions, concurrency, rust-cache, bundle and
  coverage gates) plus new workflows: CodeQL, OpenSSF Scorecard, supply-chain
  audit (cargo-deny + bun audit), tag-triggered Tauri release, Nix flake check,
  ROS-definition validation, and scheduled benchmarks.
- Supply-chain policy: `dependabot.yml` (npm/cargo/actions) and
  `src-tauri/deny.toml`.
- Governance: `CODEOWNERS`, structured issue forms, `SUPPORT.md`, `CHANGELOG.md`,
  `CITATION.cff`, and a committed `flake.lock`.

### Changed

- Renamed the Rust crate `app` → `crebain` (lib `crebain_lib`).
- Replaced `lazy_static` with `std::sync::LazyLock`; made rosbridge mutex locking
  panic/poison tolerant.
- Began decomposing `CrebainViewer` (extracted `HeaderBar` and `DetectionPanel`);
  added a typed three.js traversal/disposal helper and removed duplicated logic.
- Corrected repository URLs and metadata; fixed the stale `index.html` title.
- Bumped `rustls-webpki` to a patched release.

### Removed

- Unused `core-graphics` and `core-foundation` Rust dependencies.

## [0.4.0] - 2026

Stabilization baseline.

### Added

- Backend IPC and transport boundary hardening: native detection ingress, scene
  path/JSON validation and schema migration, sensor-fusion config/measurement
  validation, ROSBridge graph/service validation, and Zenoh CDR/topic/payload
  validation.
- Experimental MLX YOLOv8 safetensors forward pass (opt-in) with DFL
  postprocessing; rosbridge WebSocket fallback transport.
- Release-readiness artifacts: acceptance matrix, model contracts, manual smoke
  checklist, release evidence log, and the security threat model.

## [0.3.0] - 2025

- Sensor fusion engine (KF/EKF/UKF/PF/IMM), guidance controller, and interception
  system; ROS/Gazebo and Zenoh transport paths.

## [0.2.0] - 2025

- Multi-camera surveillance, ML detection pipeline with platform-native backends,
  and drone physics simulation.

## [0.1.0] - 2025

- Initial Tauri + React + Three.js prototype with Gaussian Splatting scene
  rendering.

[Unreleased]: https://github.com/sepehrmn/crebain/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/sepehrmn/crebain/releases/tag/v0.4.0
