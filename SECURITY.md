# Security Policy

## Supported versions

Only the latest release on the default branch receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities through a private GitHub security advisory for this repository. Do not include proof-of-concept details in a public issue.

Include a concise description, affected versions, reproduction steps, expected impact, and any suggested mitigation. You should receive an acknowledgment within seven days.

## Security posture

Browser Agent Bridge can control an authenticated browser session. Its guardrails are intentionally conservative:

- loopback-only bridge binding by default;
- strong shared token required;
- no default token;
- `eval` disabled unless explicitly enabled;
- no telemetry or remote service;
- explicit Chrome extension installation and local pairing.

These controls do not make the tool safe for untrusted prompts or clients. Treat any MCP client connected to this server as capable of performing browser actions under your identity.
