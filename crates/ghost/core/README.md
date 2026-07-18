# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ghost-core

> Shared desktop-automation primitives for Ryu. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ghost-core` is the common foundation for desktop automation: a recipe engine and store for record-and-replay flows, a learning module, and a CDP (Chrome DevTools Protocol) layer. It is the shared building block used by both the Ghost app (the desktop-automation MCP server) and the Shadow app (capture + semantic search).

**Tier:** OSS, Apache-2.0 (MIT-derived from Ghost OS; see [NOTICE](./NOTICE))

## Install / Build

```bash
cargo build -p ghost-core
```

## What it provides

- **Recipe engine + store** (`recipe/`): parameterized record-and-replay automations; re-exported as `engine`, `store`, and `types`.
- **Learning** (`learning/`): automation-learning primitives.
- **CDP** (`cdp/`): Chrome DevTools Protocol integration over `tokio-tungstenite`.

## Role / How it fits

A pure-logic crate (no platform FFI here): perception and input synthesis live in the sibling `ghost-eyes` and `ghost-hands` crates. Ghost and Shadow build on all three.

## License

Apache-2.0; see [LICENSE](./LICENSE). Incorporates MIT-licensed portions of [Ghost OS](https://github.com/ghostwright/ghost-os); see [NOTICE](./NOTICE). © 2026 A Major Pte. Ltd.
