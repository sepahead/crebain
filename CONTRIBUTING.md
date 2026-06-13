# CREBAIN Contributing Guide

Thank you for contributing to CREBAIN. This guide keeps changes reviewable, reproducible, and aligned with the project’s safety, validation, and documentation boundaries.

## Code of Conduct

Please be respectful and constructive in all interactions. CREBAIN follows the standards in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Getting Started

### Prerequisites

- **Bun** 1.0+ for project scripts; **Node.js** 20+ if running Node-based tooling directly
- **Rust** 1.81+ with `cargo`
- **macOS**: Xcode Command Line Tools
- **Linux**: CUDA Toolkit and NVIDIA runtime libraries when testing CUDA/TensorRT paths

### Development Setup

```bash
# Clone the repository
git clone https://github.com/sepehrmn/crebain.git

# From the repository root
bun install

# Start the frontend development server
bun run dev

# Or start the full Tauri app
bun run tauri:dev
```

## Development Workflow

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation changes
- `refactor/description` - Refactoring or maintenance

### Making Changes

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run the relevant validation commands
5. Submit a pull request

### Validation Requirements

Use the smallest check that is honest for the change:

```bash
# Frontend validation
bun run validate

# Full validation: frontend + Rust check/test/clippy
bun run validate:all
```

| Change Type | Required Check |
|-------------|----------------|
| Markdown-only, no command/status changes | `git diff --check` |
| Frontend-only source/test changes | `bun run validate` |
| Rust, Tauri IPC, model loading, scene persistence, ROS, Zenoh, transport, or sensor fusion changes | `bun run validate:all` |
| Release-candidate claims | `bun run validate:all` plus `docs/MANUAL_SMOKE_TEST.md` |

For documentation-only changes, keep Markdown files aligned on validation commands, backend status, roadmap items, model assumptions, and security boundaries.

### Code Style

#### TypeScript/React

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

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

feat(fusion): add particle filter support
fix(ros): handle disconnection gracefully
docs(readme): update installation instructions
```

## Pull Request Process

1. Keep the change focused and explain the risk.
2. Add or update tests for behavior changes.
3. Update documentation when behavior, commands, backend status, model assumptions, or security boundaries change.
4. Ensure relevant checks pass (`bun run validate` for frontend-only changes; `bun run validate:all` for Rust, IPC, integration, or cross-cutting changes).
5. Request review and address feedback promptly.

## Reporting Issues

When reporting bugs, please include:

- Operating system, hardware, app mode, and commit/version
- Steps to reproduce
- Expected vs actual behavior
- Backend/model/ROS/Zenoh context where relevant
- Relevant logs, screenshots, or validation output

## Feature Requests

Open an issue with:

- Clear description of the feature
- Use case and motivation
- Proposed behavior and acceptance criteria
- Security, model, ROS/Zenoh, and performance assumptions
- Proposed implementation, if known

## Questions?

Open a [discussion](https://github.com/sepehrmn/crebain/discussions) for general questions.

---

Thank you for contributing to CREBAIN!
