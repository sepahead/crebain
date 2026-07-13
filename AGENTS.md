# CREBAIN Development Guide

## Build and Validation Commands

```bash
# Frontend development
bun run dev              # Start Vite dev server
bun run build            # Typecheck + build for production
bun run typecheck        # TypeScript type checking only

# Tauri (full app)
bun run tauri:dev        # Development mode with hot reload
bun run tauri:build      # Production build

# Validation and testing
bun run lint             # ESLint
bun run format           # Prettier (write); format:check verifies
bun run test             # Run tests in watch mode
bun run test:run         # Run tests once
bun run test:coverage    # Run tests with coverage (enforces thresholds)
bun run benchmark:native-detector -- --help # Release-only native detector evidence CLI
bun run check:bundle     # Build + initial-bundle size budget
bun run check:ncp-coherence # Verify NCP manifests, locks, and normative docs agree
bun run check:plant-boundary # Verify the inert plant package/process dependency boundary
bun run check:plant-frames # Verify the digest-bound JS/Rust frame-convention corpus
bun run check:plant      # Check the headless plant-authority package
bun run test:plant       # Test command/health/captured-age contracts, frame/lifecycle/channel/passive-expiry/headless foundations
bun run clippy:plant     # Strict Clippy for all plant targets
bun run fmt:plant:check  # Rustfmt check scoped to the plant package
bun run self-check:plant # Run crebain-plantd in inert self-check mode
bun run validate         # typecheck + lint + format:check + frontend tests
bun run validate:all     # NCP + frontend + inert plant + Rust default/NCP gates

# Rust backend
bun run check:rust       # locked cargo check for src-tauri/Cargo.toml
bun run test:rust        # locked cargo test for all default targets
bun run clippy:rust      # locked cargo clippy for all default targets; warnings denied
bun run check:rust:ncp   # locked check of dormant NCP bridge + opt-in Galadriel producer
bun run clippy:rust:ncp  # locked clippy bridge/producer, all targets, warnings denied
bun run test:rust:ncp    # locked tests for bridge/producer feature, including all targets
cargo build --locked --manifest-path src-tauri/Cargo.toml
```

## Code Style

### TypeScript / React

- ESLint (typescript-eslint type-checked + react-hooks) and Prettier are
  enforced; run `bun run lint` and `bun run format:check` (or `bun run validate`)
- Use functional components with hooks
- Prefer `useMemo` and `useCallback` for expensive computations
- Use `useRef` for mutable values that do not trigger re-renders
- Use the centralized logger (`src/lib/logger.ts`) instead of `console.*` in production code
- Use named constants for magic numbers
- Always clean up effects (intervals, subscriptions, event listeners)

### Rust / Tauri

- Run `bun run clippy:rust` before committing Rust changes
- Use `log::info/warn/error` instead of `println!`
- Validate all external inputs, including paths, scene files, model files, IPC payloads, ROS URLs, Zenoh topics, and CDR payload metadata
- Use `spawn_blocking` for CPU-intensive operations in async contexts

## Architecture Notes

### Frontend (`src/`)

- `components/` - React UI components
- `hooks/` - Custom React hooks
- `ros/` - ROS bridge, Gazebo integration, Zenoh transport adapters, performance monitoring
- `detection/` - ML detection types, sensor fusion, and scenario fixtures
- `physics/` - Drone physics simulation
- `simulation/` - Interception system
- `state/` - Scene serialization and persistence

### Backend (`src-tauri/`)

- `common/` - Shared detection, NMS, YOLO, error, and path validation utilities
- `inference/` - ML abstraction layer with CoreML default on macOS, experimental MLX YOLOv8 safetensors path, CUDA/TensorRT on Linux, and ONNX fallback
- `transport/` - Zenoh-oriented transport, CDR validation, and Tauri transport commands
- `ncp/` - Dormant NCP Engram action/control adapter behind the off-by-default `ncp` feature; its Tauri commands remain unregistered. The feature also compiles the separately exact-runtime-gated `galadriel_producer.rs`, strict `galadriel_registry.rs`, and frozen `producer_monitor.rs` evidence path. Do not describe secure config loading as TLS/ACL proof or local puts as receiver delivery. See `src-tauri/src/ncp/README.md` and `docs/GALADRIEL_PRODUCER.md`. (The dormant TypeScript peer is `src/neuro/`; Vite dev separately exposes the transport-free `window.__ncpDrone` harness.)
- `sensor_fusion.rs` - Kalman/EKF/UKF/Particle/IMM filters plus the feature-gated exact-time frozen-prior Galadriel ledger, bounded upstream/capacity accounting, and sparse assignment; registry transforms are not executed and component load tests are not deployment deadline evidence
- `lib.rs` - Tauri IPC commands and app setup

## Performance Guidelines

- Use `CircularBuffer` for high-frequency position data
- Prefer squared distance comparisons (avoid `sqrt()`)
- Use `ImageBitmap` for browser-native image decoding
- Memoize derived state to prevent unnecessary recomputes
- Keep camera feed updates at the documented 83ms interval unless profiling justifies a change

## Testing

Test files use Vitest. Place tests in `__tests__/` directories or use `.test.ts` suffix.

```ts
import { describe, expect, it } from 'vitest'
```

Before committing, prefer `bun run validate:all` unless the change is documentation-only and clearly cannot affect code.

Do not add Claude, AI assistants, or agents as commit/PR co-authors — no `Co-Authored-By:` trailer and no "Generated with Claude Code" / 🤖 line in commit messages or pull-request descriptions.

## Documentation Consistency

Tracked Markdown files should agree on validation commands, backend status, roadmap items, model assumptions, and security boundaries. Keep these files synchronized when behavior changes:

- `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`
- `docs/*.md`
- `public/models/README.md`
- `ros/README.md`
- `.github/**/*.md`
- `.windsurf/workflows/*.md`

For documentation-only edits (Markdown files with no command, status, or behavior changes), run `git diff --check` at minimum. Run `bun run validate:all` when the edit reflects or accompanies Rust, IPC, model-loading, transport, ROS, scene, or sensor-fusion behavior changes.
