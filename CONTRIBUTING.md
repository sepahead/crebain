# CREBAIN contributing guide

Thank you for contributing to CREBAIN. This guide keeps changes reviewable and
reproducible. It also keeps changes within the project safety, validation, and
documentation boundaries.

## Code of conduct

Be respectful and constructive in all interactions. Follow the standards in
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Getting started

### Prerequisites

- **Bun** 1.3.14+ for project scripts
- **Node.js** 20.19+ for Node-based tooling
- **Rust** 1.89+ with `cargo` (MSRV per `src-tauri/Cargo.toml`)
- `rust-toolchain.toml` pins Rust 1.91.1 for development and CI
- **macOS**: Xcode Command Line Tools
- **Linux**: CUDA Toolkit and NVIDIA runtime libraries when testing CUDA/TensorRT paths

### Development setup

```bash
# Clone the repository
git clone https://github.com/sepahead/crebain.git

# From the repository root
bun install

# Start the frontend development server
bun run dev

# Or start the full Tauri app
bun run tauri:dev
```

## Development workflow

### Branch naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation changes
- `refactor/description` - Refactoring or maintenance

### Making changes

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run the relevant validation commands
5. Submit a pull request

### Validation requirements

Use the narrowest check that covers the change:

```bash
# Baselines/contracts/provenance + frontend typecheck/lint/format/tests
bun run validate

# NCP pin coherence + frontend + plant boundary/frame corpus + locked Rust default/NCP bridge/producer gates
bun run validate:all
```

| Change Type | Required Check |
|-------------|----------------|
| Markdown-only, no command/status changes | `git diff --check` |
| NCP manifest, lockfile, or normative-doc changes | `bun run check:ncp-coherence` |
| Galadriel producer registry/config/envelope/security/baseline changes | `bun run check:phase0-baseline` plus `bun run check:ncp-coherence`; use `bun run validate:all` for source behavior |
| Frontend-only source/test changes | `bun run validate` |
| Production renderer-vendor, GLB loader, or Vite artifact-boundary changes | `bun run check:production-vendors` and `bun run check:bundle`; use `bun run validate` for the complete frontend gate |
| Rust, Tauri IPC, model loading, scene persistence, ROS, Zenoh, transport, or sensor fusion changes | `bun run validate:all` |
| Headless plant package, command/health/captured-age/safe-action/deadline-monitor/apply-observation contract, frame corpus, lifecycle, or channel-policy changes | `bun run check:plant-boundary`, `bun run check:plant-frames`, and `bun run validate:all` |
| 0.9 research/source/package prerelease | `bun run validate:all`; manual rows may remain explicitly pending only under the exclusions in `docs/NARROWED_GO_0.9.0.md` |
| Demo, operational/deployment, or 1.0 readiness claims | `bun run validate:all` plus completed `docs/MANUAL_SMOKE_TEST.md` evidence |
| Native detector performance claim | The release command and archived evidence bundle in `docs/NATIVE_DETECTOR_BENCHMARK.md` |

For documentation-only changes, keep Markdown files aligned on validation commands, backend status, roadmap items, model assumptions, and security boundaries.

`bun run validate` also verifies:

- the exact pinned Spark, Rapier, and Three production transforms
- the local-byte and texture runtimes
- the product profiles and IPC registry
- the release and audit tools
- the vendor provenance and ROS definitions
- the Bun-to-Nix dependency expression

`bun run validate:all` also runs:

- the inert plant boundary and closed in-memory contract tests
- the captured-age, safe-action, deadline-monitor, and apply-observation tests
- the digest-bound JavaScript and Rust frame corpus
- Rustfmt, Cargo check, all-target tests, strict Clippy, and the headless
  self-check

Each Rust package acceptance script uses the checked-in Cargo lockfile with
`--locked`. These commands do not run:

- a real model benchmark
- the bundle budget or coverage thresholds
- the `cuda,tensorrt` or `--no-default-features` checks
- CodeQL or supply-chain audits

Release candidates require those hosted workflows. See
`docs/RELEASE_ACCEPTANCE.md`.

### Code style

#### TypeScript/React

- ESLint and Prettier are enforced (`bun run lint`, `bun run format:check`, both
  part of `bun run validate`). Fix findings before you open a pull request.
- Use functional components with hooks
- Prefer `useMemo` and `useCallback` for expensive computations
- Use `useRef` for mutable values that do not trigger re-renders
- Use the centralized logger (`src/lib/logger.ts`) instead of `console.*` in production code
- Use named constants for magic numbers
- Always clean up effects (intervals, subscriptions, event listeners)

#### Rust

- Run `bun run clippy:rust` before committing Rust changes
- Use `log::info/warn/error` instead of `println!`
- Validate all external inputs, including paths, model files, scene JSON, IPC payloads, ROS URLs, transport topics, and CDR payload metadata
- Use `spawn_blocking` for CPU-intensive operations in async contexts

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

feat(fusion): add particle filter support
fix(ros): handle disconnection gracefully
docs(readme): update installation instructions
```

## Pull request process

1. Keep the change focused.
2. Explain the risk.
3. Add or update tests for behavior changes.
4. Update documentation when behavior, commands, backend status, model
   assumptions, or security boundaries change.
5. Run `bun run validate` for frontend-only changes.
6. Run `bun run validate:all` for Rust, IPC, integration, or cross-cutting
   changes.
7. Request review.
8. Address feedback promptly.

## Reporting issues

When you report a bug, include:

- Operating system, hardware, app mode, and commit/version
- Steps to reproduce
- Expected behavior and actual behavior
- Backend, model, ROS, or Zenoh context where relevant
- Relevant logs, screenshots, or validation output

## Feature requests

Open an issue with:

- Clear description of the feature
- Use case and motivation
- Proposed behavior and acceptance criteria
- Security, model, ROS/Zenoh, and performance assumptions
- Proposed implementation, if known

## Questions

Open a [discussion](https://github.com/sepahead/crebain/discussions) for general questions.

---

Thank you for contributing to CREBAIN.
