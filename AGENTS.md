# CREBAIN development guide

## Build and validation commands

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
bun run check:product-profiles # Verify all eight immutable 0.9 NoAuthority profiles
bun run check:ipc-contracts # Verify frontend/Rust commands and event contracts
bun run check:release-tools # Verify version/tag and digest-manifest tooling
bun run check:vendor-compat # Verify exact crates.io overlay provenance
bun run check:production-vendors # Verify pinned Spark/Rapier/Three transforms and local-byte runtimes
bun run check:ros-defs    # Validate ROS definitions and package XML
bun run check:nix-deps    # Verify bun.nix is exactly generated from bun.lock
bun run check:plant-boundary # Verify the inert plant package/process dependency boundary
bun run check:plant-frames # Verify the digest-bound JS/Rust frame-convention corpus
bun run check:plant      # Check the headless plant-authority package
bun run test:plant       # Test command/health/captured-age/safe-action/deadline-monitor/apply-observation contracts plus frame/lifecycle/channel/passive-expiry/headless foundations
bun run clippy:plant     # Strict Clippy for all plant targets
bun run fmt:plant:check  # Rustfmt check scoped to the plant package
bun run self-check:plant # Run crebain-plantd in inert self-check mode
bun run validate         # contracts/provenance + typecheck/lint/format/frontend tests
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

## Code style

### TypeScript / React

- ESLint (typescript-eslint type-checked + react-hooks) and Prettier are
  enforced. Run `bun run lint` and `bun run format:check` (or
  `bun run validate`).
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

## Architecture notes

### Frontend (`src/`)

- `components/` - React UI components
- `hooks/` - Custom React hooks
- `ros/` - ROS bridge, Gazebo integration, Zenoh transport adapters, performance monitoring
- `detection/` - ML detection types, sensor fusion, and scenario fixtures
- `physics/` - Drone physics simulation
- `simulation/` - Interception system
- `state/` - Scene serialization and persistence
- `integrations/` - Restricted Engram host validation and read-only status bridge.
  `engramHost=1` disables CREBAIN native access, external telemetry, artifact
  exchange, local simulation, scene mutation, and the development NCP command
  harness. The bridge revokes after 32 expected-peer messages in one second.
  It accepts only user-agent-trusted messages and normalizes exact primitive
  fields before serialization.
  The host must also receive fresh heartbeat status and an inaccessible
  native-IPC probe before interaction.

### Backend (`src-tauri/`)

- `common/` - Shared detection, NMS, YOLO, error, and path validation utilities
- `inference/` - ML abstraction layer with CoreML default on macOS, experimental MLX YOLOv8 safetensors path, CUDA/TensorRT on Linux, and ONNX fallback
- `transport/` - Zenoh-oriented transport, CDR validation, and Tauri transport commands
- `crates/plant-authority/` - Separate zero-dependency inert plant foundation.
  It includes unwired deadline-monitor and apply-observation candidates. It is
  not linked into Tauri or tied to a write. It cannot authorize, revoke, or
  apply output.
- `ncp/` - Dormant NCP Engram action/control adapter behind the off-by-default
  `ncp` feature. Its Tauri commands remain unregistered. The feature also
  compiles the separately gated Galadriel evidence path. Do not describe secure
  configuration loading as TLS or ACL proof. Do not describe local puts as
  receiver delivery. See `src-tauri/src/ncp/README.md` and
  `docs/GALADRIEL_PRODUCER.md`. The dormant TypeScript peer is `src/neuro/`.
  Vite development exposes the transport-free `window.__ncpDrone` harness.
- `sensor_fusion.rs` - Kalman, EKF, UKF, particle, and IMM filters. It also
  contains the feature-gated exact-time Galadriel ledger, bounded accounting,
  and sparse assignment. Registry transforms are not executed. Component load
  tests are not deployment deadline evidence.
- `lib.rs` - Tauri IPC commands and app setup

## Performance guidelines

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

Before you commit a code or behavior change, prefer `bun run validate:all`. For
a documentation-only change that cannot affect code, use the documentation
checks below.

Do not add Claude, AI assistants, or agents as commit/PR co-authors — no `Co-Authored-By:` trailer and no "Generated with Claude Code" / 🤖 line in commit messages or pull-request descriptions.

## Documentation style

Use the principles of [ASD-STE100 Simplified Technical English, Issue 9](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf)
for new or changed technical prose. The
[official ASD-STE100 site](https://www.asd-ste100.org/) identifies Issue 9,
dated January 15, 2025, as the current standard. These rules are the CREBAIN
house-style adaptation. Do not claim that a document fully conforms to
ASD-STE100 unless a qualified review verifies it.

- Use American English and approved project terminology. Use one technical
  term for one concept.
- Write short, direct sentences. Use no more than 20 words in a procedural
  sentence and 25 words in a descriptive sentence when practical.
- Give one instruction in each numbered step. Use the imperative form for
  instructions.
- Put a condition before the action that depends on it.
- Use active voice. Use passive voice only when the actor is unknown or the
  actor is less important than the action.
- Give one topic in each sentence. Keep related sentences in one paragraph,
  and use no more than six sentences in a paragraph when practical.
- Use a vertical list for complex information. Do not use semicolons in prose.
- Define each abbreviation at its first use. Do not change exact identifiers,
  command names, code, protocol terms, quoted text, or required legal text.
- Use requirement words consistently: `must` states a requirement, `must not`
  states a prohibition, `may` gives permission, and `can` states capability.
  Do not replace these words if the replacement changes the contract.
- Use `WARNING` for a risk of injury or death. Use `CAUTION` for a risk of
  damage. Start the safety instruction with a command or condition, then state
  the possible result.
- Do not use slang, unexplained jargon, Latin abbreviations, or a word-for-word
  substitution that changes the meaning. Rewrite the sentence when necessary.
- Treat CREBAIN names, source identifiers, API names, and domain-specific
  vocabulary as technical terms. Keep their spelling consistent.
- Preserve the meaning of historical records, frozen evidence, generated
  files, vendored documentation, quotations, licenses, and codes of conduct.

## Documentation consistency

Tracked Markdown files must agree on validation commands, backend status,
roadmap items, model assumptions, and security boundaries. When behavior
changes, keep these files synchronized:

- `README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`, and
  `CODE_OF_CONDUCT.md`
- `docs/*.md`
- `public/models/README.md`
- `ros/README.md`
- `.github/**/*.md`
- `.windsurf/workflows/*.md`

For documentation-only edits (Markdown files with no command, status, or behavior changes), run `git diff --check` at minimum. Run `bun run validate:all` when the edit reflects or accompanies Rust, IPC, model-loading, transport, ROS, scene, or sensor-fusion behavior changes.
