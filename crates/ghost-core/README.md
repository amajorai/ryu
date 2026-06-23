# ghost-core

> Core desktop-automation primitives for Ryu. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ghost-core` holds the shared building blocks for desktop automation: a recipe engine and store, a learning module, and a CDP (Chrome DevTools Protocol) layer. It is the common foundation used by both the Ghost app (the desktop-automation MCP server) and the Shadow app (capture + semantic search).

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
cargo build -p ghost-core
```

## What it provides

- **Recipe engine + store** (`recipe/`) — re-exported as `engine`, `store`, and `types`.
- **Learning** (`learning/`) — automation learning primitives.
- **CDP** (`cdp/`) — Chrome DevTools Protocol integration.

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
