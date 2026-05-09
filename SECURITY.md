# CREBAIN Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x | Supported |
| < 0.4 | Unsupported |

## Reporting a Vulnerability

If you discover a security vulnerability in CREBAIN, please report it responsibly.

**Do NOT** open a public GitHub issue for security vulnerabilities.

### How to Report

1. **Email**: Send details to the maintainers via GitHub's [Private vulnerability reporting](https://github.com/crebain/crebain/security/advisories/new)
2. **GitHub Security Advisories**: Use the [Advisories page](https://github.com/crebain/crebain/security/advisories)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 7 days
- **Fix Timeline**: Depends on severity (critical: ASAP, medium: 30 days)

## Security Best Practices

When using CREBAIN:

- Keep ML models and inference backends updated
- Restrict network access to ROS/Zenoh bridges
- Run with least privilege
- Review scene file imports from untrusted sources
- Treat model paths, scene files, ROS URLs, and transport topics as untrusted input
- Do not expose rosbridge or Zenoh endpoints directly to untrusted networks without authentication, network policy, and transport security appropriate for the deployment
- Validate externally supplied ML models before use; this repository does not provide or endorse model weights

## Threat Model Summary

| Boundary | Untrusted Inputs | Current Controls | Required Review Before Release Claims |
|----------|------------------|------------------|---------------------------------------|
| Model loading | `CREBAIN_MODEL_PATH`, `CREBAIN_ONNX_MODEL`, local model files | Path validation, extension checks, missing-model error paths | Verify provenance, rights, tensor contracts, preprocessing, class mapping, and benchmark context |
| Scene persistence | Scene file path and serialized scene JSON | Allowed-root path validation, `.json` extension check, size limit, JSON parse check | Exercise save/load rejection paths in automated or manual smoke testing |
| Native detection IPC | Raw RGBA payload, dimensions, thresholds, max detections | Dimension and byte-length validation, threshold clamping, structured error payloads | Confirm malformed payloads fail without frontend crash |
| ROS bridge | WebSocket URL and ROS graph messages | User-controlled connection state and visible errors | Restrict network exposure; require deployment-appropriate authentication and transport security |
| Zenoh transport | Topic names, pub/sub payloads, event names | Topic validation and deterministic event-name encoding | Review namespace policy, access control, and payload assumptions for deployment |
| Tauri commands/events | Frontend command constants and emitted transport events | Command registration tests and event-name guardrails | Keep frontend/backend command contracts and event names synchronized |
