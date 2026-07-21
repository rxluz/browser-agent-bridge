# Browser Agent Bridge

[![CI](https://github.com/rxluz/browser-agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/rxluz/browser-agent-bridge/actions/workflows/ci.yml)
[![GitHub Pages](https://img.shields.io/badge/docs-GitHub%20Pages-2ea44f)](https://rxluz.github.io/browser-agent-bridge/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Use an MCP client to operate the **Chrome session you already use**: existing tabs, authenticated web apps, SSO, and local network access. Browser Agent Bridge keeps this control path on the local machine:

```text
MCP client -> local MCP server -> loopback bridge -> Chrome extension -> Chrome
```

It is designed for developer workflows that need a real, signed-in browser rather than a clean, disposable automation profile.

> [!WARNING]
> This project gives an AI agent powerful access to the browser session you connect. It can read page content and perform actions as you. Review [Security](#security-model) before installing it, and never give an untrusted agent unrestricted access.

## Why this exists

Playwright and Puppeteer are excellent for automated testing, but normally launch an isolated browser profile. Browser Agent Bridge fills a different gap:

- **Your existing Chrome profile**: works with tabs and sessions that are already open.
- **Site-agnostic interactions**: snapshot controls, then act by stable `agentId`.
- **Modern UI support**: open shadow roots, same-origin iframes, React-controlled inputs, and rich-text editors.
- **Trusted input**: uses the Chrome DevTools Protocol for clicks, keyboard input, selection, and text insertion when synthetic events are rejected.
- **MCP first**: works with any MCP client that supports local stdio servers; the Copilot CLI adapter is optional.

## Features

| Capability | What it does |
| --- | --- |
| Tab lifecycle | List, create, activate, close, navigate, reload, and traverse browser history. |
| Read | Extract visible text, links, screenshots, and compact accessibility-oriented snapshots. |
| Interact | Click, type, clear fields, insert trusted text, press shortcuts, and scroll. |
| Target controls | Use `agentId` from `snapshot`; the legacy `id` alias remains supported. |
| Wait | Wait for selectors, visible text, or JavaScript conditions. |
| Hardened editors | Supports browser-trusted text input for many rich-text editor implementations. |
| Optional page JavaScript | `eval` is disabled by default and requires explicit server opt-in. |

## Quick start

### 1. Install the local bridge

```bash
git clone https://github.com/rxluz/browser-agent-bridge.git
cd browser-agent-bridge
cd server
npm ci

export BRIDGE_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
npm start
```

Keep the generated token private. The server only binds to loopback addresses unless you explicitly override that safety check.

### 2. Load and pair the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository's `extension/` directory.
4. Open the Browser Agent Bridge extension popup.
5. Enter `127.0.0.1`, port `8765`, and the same `BRIDGE_TOKEN`.
6. Save. The extension badge displays `on` when connected.

### 3. Add the MCP server to your client

Install Node.js 18 or later, then add this stdio server configuration to your MCP-capable client:

```json
{
  "mcpServers": {
    "browser-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/browser-agent-bridge/mcp-server/index.js"],
      "env": {
        "BRIDGE_HOST": "127.0.0.1",
        "BRIDGE_PORT": "8765",
        "BRIDGE_TOKEN": "your-generated-token"
      }
    }
  }
}
```

The MCP server provides:

- `browser_status` — checks whether the local bridge and extension are connected.
- `browser_command` — runs a documented bridge action, such as `snapshot`, `click`, `type`, or `get_content`.

For an example prompt:

> Take a viewport-only snapshot of my active tab. Identify the search field, enter “MCP specification”, and wait until the results text appears.

## Interaction model

Start with a compact snapshot, then target a returned `agentId`:

```json
{
  "action": "snapshot",
  "params": { "viewportOnly": true, "max": 100 }
}
```

```json
{
  "action": "type",
  "params": { "agentId": "12", "text": "MCP specification" }
}
```

For rich-text editors, use `insert_text` after focusing the target. `press` accepts named keys such as `Enter` and standard shortcuts such as `CTRL+A` and `META+A`.

See the complete action reference in the [setup guide](https://rxluz.github.io/browser-agent-bridge/setup.html#action-reference).

## Security model

Browser Agent Bridge is deliberately local:

- The bridge listens only on `127.0.0.1`, `::1`, or `localhost` by default.
- A 32-character minimum shared token is required.
- The Chrome extension requires explicit local configuration before it connects.
- `eval` is blocked by default. Enable it only when required:

  ```bash
  BRIDGE_ENABLE_EVAL=1 npm start
  ```

- Chrome displays its normal DevTools debugging notice while trusted input is in use.

This is not a sandbox. It can operate authenticated sessions and see content from pages it is asked to inspect. Do not use it with untrusted prompts, unknown MCP clients, or sensitive browser profiles without understanding the risk.

Read the full [security guidance](SECURITY.md), [threat model](https://rxluz.github.io/browser-agent-bridge/security.html), and [architecture](https://rxluz.github.io/browser-agent-bridge/architecture.html).

## Project layout

```text
extension/     Chrome Manifest V3 extension that owns Chrome API access
server/        Local HTTP/WebSocket loopback bridge and standalone CLI
mcp-server/    Dependency-free stdio MCP server
docs/          GitHub Pages site and extended documentation
```

## Development

```bash
cd server && npm ci && cd ..
npm run check
npm test
```

The test suite validates bridge authentication, command forwarding, disconnect handling, and MCP protocol/tool behavior. It does not automate a personal browser profile.

## Roadmap

- [ ] Publish the Chrome extension through the Chrome Web Store after a hardened pairing and consent flow.
- [ ] Publish the MCP server package to npm.
- [ ] Add explicit per-origin and per-tab consent controls.
- [ ] Add structured local audit logs with redaction.
- [ ] Add integration coverage against a disposable Chrome profile in CI.

## Contributing and support

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and use the issue templates for bugs and proposals.

For security-sensitive reports, follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

[MIT](LICENSE) © 2026 Ricardo Luz.
