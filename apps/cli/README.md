# Ryu CLI

> A terminal UI for chatting with Ryu and managing the local stack. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-ratatui-dea584.svg?logo=rust&logoColor=white)](../../README.md)

Ryu CLI is a Rust + ratatui terminal interface over Ryu Core. It offers chat, sidecar management, device login, session control, and automatic discovery of Ryu nodes on the LAN — all without leaving the terminal.

**Tier:** OSS, self-hostable — Apache-2.0

## Stack

- Rust + `ratatui` (TUI) over `crossterm`
- `reqwest` HTTP client (with SOCKS support) to reach Core
- `tokio` async runtime

## Run standalone

```bash
# From this directory
cargo build --release    # produces the `ryu` binary in target/release

./target/release/ryu     # opens the control-panel TUI
```

The CLI talks to a running [Ryu Core](../core/README.md) (default `http://localhost:7980`) and, for auth, to the identity backend.

Key environment variables:

- `RYU_AUTH_URL` — backend URL for auth (default `http://localhost:3000`)

## What it does

- **Chat** — multi-turn AI chat; the default chat routes to the web `/ai` endpoint, while `Ctrl+A` routes to Core (`:7980`)
- **Sidecar management** — view status and start/stop/restart sidecars, plus a setup wizard
- **Device login** — browser-based OAuth (`login`/`logout`/`whoami`), session listing and revocation
- **Sessions** — list and manage active sessions
- **Node management** — add/remove/select Ryu nodes (`~/.ryu/nodes.json`), with LAN node auto-discovery and per-command node targeting (`--node <name>`)
- **Mouse support** — clickable tabs, buttons, and list items

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
