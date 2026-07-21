# Changelog

All notable changes to Browser Agent Bridge are documented in this file.

The project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-21

### Added

- Chrome extension and loopback HTTP/WebSocket bridge.
- Standard stdio MCP server exposing browser status and command tools.
- Generic snapshot targeting for standard DOM controls, open shadow roots, and same-origin iframes.
- Trusted input primitives for clicks, text insertion, key presses, and clearing.
- GitHub Pages documentation, CI, issue templates, and contribution guidance.

### Security

- Required a minimum 32-character bridge token for new installations.
- Restricted the bridge to loopback addresses by default.
- Disabled arbitrary page JavaScript evaluation unless explicitly enabled.
