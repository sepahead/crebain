## Summary

Describe what changed and why.

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update
- [ ] Refactor / maintenance
- [ ] Test-only change

## Risk and Scope

- **Primary area**: frontend / Rust backend / Tauri IPC / ML / ROS / Zenoh / sensor fusion / docs
- **External inputs touched**: none / paths / model files / scene files / IPC payloads / ROS URLs / transport topics / CDR payload metadata
- **User-visible behavior changed**: yes / no

## Validation

| Command | Result | Notes |
|---------|--------|-------|
| `bun run validate` | not run |  |
| `bun run validate:all` | not run | Required for Rust, plant-authority, IPC, transport, model-loading, or integration changes |
| Native detector evidence bundle | not applicable | Required only for a retained numeric detector-performance claim |
| Manual smoke checklist | not run | Required for demo, operational/deployment, or 1.0 readiness claims; the research-only 0.9 exception must cite `docs/NARROWED_GO_0.9.0.md` |

## Checklist

- [ ] Code follows project style guidelines
- [ ] Relevant tests were added or updated
- [ ] Documentation was updated where behavior, commands, status, or security boundaries changed
- [ ] README, AGENTS, CONTRIBUTING, SECURITY, ROS/model docs, and templates remain aligned
- [ ] New performance, safety, ML, ROS, or transport claims are measured, sourced, or clearly labeled as assumptions
- [ ] New external input paths validate null bytes, traversal, size/range limits, and unsupported modes as appropriate

## Related Issues

Fixes #
