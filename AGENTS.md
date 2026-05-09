# CREBAIN Development Guide

## Build Commands

```bash
# Frontend development
bun run dev              # Start Vite dev server
bun run build            # Typecheck + build for production
bun run typecheck        # TypeScript type checking only

# Tauri (full app)
bun run tauri:dev        # Development mode with hot reload
bun run tauri:build      # Production build

# Testing
bun run test             # Run tests in watch mode
bun run test:run         # Run tests once
bun run test:coverage    # Run tests with coverage
bun run test:benchmark   # Run detector benchmarks
bun run validate         # TypeScript typecheck + frontend tests
bun run validate:all     # Frontend validation + Rust check/test/clippy

# Rust backend
bun run check:rust       # cargo check --manifest-path src-tauri/Cargo.toml
bun run test:rust        # cargo test --manifest-path src-tauri/Cargo.toml
bun run clippy:rust      # cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo build --manifest-path src-tauri/Cargo.toml
```

## Code Style

### TypeScript/React

- Use functional components with hooks
- Prefer `useMemo` and `useCallback` for expensive computations
- Use `useRef` for mutable values that don't trigger re-renders
- Use the centralized logger (`src/lib/logger.ts`) instead of `console.*` in production code
- Use named constants for magic numbers
- Always clean up effects (intervals, subscriptions, event listeners)

### Rust

- Run `cargo clippy` before committing
- Use `log::info/warn/error` instead of `println!`
- Validate all external inputs (paths, user data)
- Use `spawn_blocking` for CPU-intensive operations in async contexts

## Architecture Notes

### Frontend (`src/`)

- `components/` - React UI components
- `hooks/` - Custom React hooks
- `ros/` - ROS bridge, Gazebo integration, Zenoh transport adapters, performance monitoring
- `detection/` - ML detection types and sensor fusion
- `physics/` - Drone physics simulation
- `simulation/` - Interception system
- `state/` - Scene serialization and persistence

### Backend (`src-tauri/`)

- `common/` - Shared detection, NMS, YOLO, error, and path validation utilities
- `inference/` - ML abstraction layer (CoreML, MLX, CUDA, TensorRT, ONNX)
- `transport/` - Zenoh low-latency transport and Tauri transport commands
- `sensor_fusion.rs` - Kalman/EKF/UKF/Particle/IMM filters
- `lib.rs` - Tauri IPC commands and app setup

## Performance Guidelines

- Use `CircularBuffer` for high-frequency position data
- Prefer squared distance comparisons (avoid `sqrt()`)
- Use `ImageBitmap` for GPU-accelerated image decoding
- Memoize derived state to prevent unnecessary recomputes
- Keep camera feed updates at ~12 FPS (83ms interval)

## Testing

Test files use Vitest. Place tests in `__tests__/` directories or use `.test.ts` suffix.

```ts
import { describe, expect, it } from 'vitest'
```

Before committing, prefer `bun run validate:all` unless the change is documentation-only and clearly cannot affect code.
