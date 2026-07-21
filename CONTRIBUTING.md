# Contributing

Thanks for improving Browser Agent Bridge.

## Before you start

1. Search existing issues and discussions before opening a new one.
2. For a behavioral change, open an issue first when the design is not obvious.
3. Never include session tokens, cookies, credentials, browser exports, or screenshots containing private information in an issue, pull request, test fixture, or log.

## Development workflow

```bash
cd server
npm ci
cd ..
npm run check
npm test
```

Changes should stay site-agnostic. Do not add selectors, workarounds, or special cases for a particular website unless the same browser-platform behavior is demonstrably shared across sites.

## Pull requests

- Keep each pull request focused.
- Add or update tests for bridge/MCP protocol changes.
- Update the README and Pages docs when user-facing behavior changes.
- Explain security implications for any change that expands permissions, page access, or command capabilities.
- Do not change the default security posture without an explicit rationale and migration note.

## Commit messages

Use short imperative summaries, for example: `Support agent IDs in MCP command targets`.

## Reporting security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
