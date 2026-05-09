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
