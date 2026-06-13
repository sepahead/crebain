# CREBAIN Security Policy

CREBAIN handles local files, model paths, Tauri IPC payloads, ROS URLs, and Zenoh transport data. Treat every external boundary as untrusted unless it has explicit validation and release evidence.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x | Supported |
| < 0.4 | Unsupported |

## Reporting a Vulnerability

If you discover a security vulnerability in CREBAIN, please report it responsibly.

**Do NOT** open a public GitHub issue for security vulnerabilities.

### How to Report

1. **Private vulnerability reporting**: Send details through GitHub’s [private vulnerability reporting flow](https://github.com/sepehrmn/crebain/security/advisories/new).
2. **GitHub Security Advisories**: Use the [Advisories page](https://github.com/sepehrmn/crebain/security/advisories).

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Affected commit, platform, app mode, and backend/transport path
- Suggested fix, if known

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Fix Timeline**: Depends on severity (critical: ASAP, medium: 30 days)

## Security Best Practices

When using CREBAIN:

- Keep ML models and inference backends updated.
- Restrict network access to rosbridge and Zenoh endpoints.
- Run with least privilege.
- Review scene file imports from untrusted sources.
- Treat model paths, scene files, ROS URLs, IPC payloads, CDR payloads, and transport topics as untrusted input.
- Do not expose rosbridge or Zenoh endpoints directly to untrusted networks without authentication, network policy, and deployment-appropriate transport security.
- Validate externally supplied ML models before use; this repository does not provide or endorse model weights.

## Threat Model Summary

| Boundary | Untrusted Inputs | Current Controls | Required Review Before Release Claims |
|----------|------------------|------------------|---------------------------------------|
| Model loading | `CREBAIN_MODEL_PATH`, `CREBAIN_ONNX_MODEL`, `CREBAIN_MLX_MODEL`, `CREBAIN_MLX_MODEL_SHA256`, local model files | Path validation, extension checks including MLX `.safetensors`, optional MLX SHA-256 digest pinning, missing-model error paths, TensorRT engine build input validation | Verify provenance, rights, tensor contracts, preprocessing, class mapping, and benchmark context |
| Scene persistence | Scene file path and serialized scene JSON | Allowed-root path validation, `.json` extension check, size limit, JSON parse check, scene schema migration | Exercise save/load rejection paths in automated or manual smoke testing |
| Native detection IPC | Raw RGBA payload, dimensions, thresholds, max detections | Dimension and byte-length validation, threshold clamping, structured error payloads | Confirm malformed payloads fail without frontend crash |
| ROS bridge | WebSocket URL, topic/service names, message types, queue parameters, timeouts, Gazebo spawn payloads | URL/message validation, open-socket connection checks, immediate service-call failure on disconnect/send failure, Gazebo spawn request validation | Restrict network exposure; require deployment-appropriate authentication and transport security |
| Zenoh transport | Topic names, CDR payloads, publish payloads, event names | Topic validation, deterministic event-name encoding, bounded CDR strings/sequences/data arrays, image metadata validation, finite publish payload validation | Review namespace policy, access control, and payload assumptions for deployment |
| Tauri commands/events | Frontend command constants and emitted transport events | Command registration tests, source-contract tests, event-name guardrails, typed response validation on frontend boundaries | Keep frontend/backend command contracts and event names synchronized |

## Release Security Gate

Before making release-readiness claims, confirm that:

1. `bun run validate:all` passes.
2. `docs/MANUAL_SMOKE_TEST.md` has no unresolved release-blocking findings.
3. New external input paths are documented in this file or explicitly ruled out of scope.
4. Performance, ML accuracy, transport latency, and safety claims cite measured evidence from the target environment.
