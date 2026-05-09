# CREBAIN Contributing Guide

Thank you for your interest in contributing to CREBAIN! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. We welcome contributors of all experience levels.

## Getting Started

### Prerequisites

- **Node.js** 18+ or **Bun** 1.0+
- **Rust** 1.81+ with `cargo`
- **macOS**: Xcode Command Line Tools
- **Linux**: CUDA Toolkit (optional, for GPU acceleration)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/crebain/crebain.git

# From the repository root
bun install

# Start development server
bun run dev

# Or start the full Tauri app
bun run tauri:dev
```

## Development Workflow

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation changes
- `refactor/description` - Code refactoring

### Making Changes

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run tests and linting
5. Submit a pull request

### Code Quality Requirements

Before submitting a PR, ensure:

```bash
# Frontend validation
bun run validate

# Full validation: frontend + Rust check/test/clippy
bun run validate:all
```

### Code Style

#### TypeScript/React

- Use functional components with hooks
- Prefer `useMemo` and `useCallback` for expensive computations
- Use `useRef` for mutable values that do not trigger re-renders
- Use the centralized logger (`src/lib/logger.ts`) instead of `console.*` in production code
- Use named constants for magic numbers
- Always clean up effects (intervals, subscriptions, event listeners)

#### Rust

- Run `cargo clippy` before committing
- Use `log::info/warn/error` instead of `println!`
- Validate all external inputs (paths, user data)
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

1. Update documentation if needed
2. Add tests for new functionality
3. Ensure all checks pass
4. Request review from maintainers
5. Address feedback promptly

## Reporting Issues

When reporting bugs, please include:

- Operating system and version
- Steps to reproduce
- Expected vs actual behavior
- Relevant logs or screenshots

## Feature Requests

Open an issue with:

- Clear description of the feature
- Use case / motivation
- Proposed implementation (if any)

## Questions?

Open a [discussion](https://github.com/crebain/crebain/discussions) for general questions.

---

Thank you for contributing to CREBAIN!
