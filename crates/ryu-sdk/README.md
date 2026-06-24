# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="center" alt="" />&nbsp; ryu-sdk

> The Rust dev-SDK kernel: the shared Runnable contract. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-sdk` is the shared Rust kernel of the Ryu SDK: the manifest model and validation, the gateway egress rules, the Runnable contract, and a gateway-mandatory model client. One Rust implementation is the foundation the FFI and Node-API bindings build on, so the local logic never drifts across languages. The OpenAPI specs for the gateway transport are vendored here as the canonical contract.

**Tier:** OSS, Apache-2.0

## Install / Build

```bash
cargo build -p ryu-sdk
cargo test  -p ryu-sdk
```

The optional `codegen` feature regenerates an OpenAPI client from the vendored specs; it is off by default (the hand-written model client is the shipping transport).

## What it provides

- **Runnable contract** (`runnable.rs`): the unified input → run → output trait.
- **Manifest model** (`manifest.rs`): `plugin.json` types, semver/id validation, and a derived JSON Schema.
- **Gateway egress rules + clients** (`gateway.rs`, `model.rs`, `embedding.rs`): direct-provider URLs are blocked at construction; every model and embedding call routes through the Ryu Gateway.
- A vendored OpenAPI contract (`specs/`) exercised by the `spec_conformance` test.

## Role / How it fits

The single shared kernel. The [`ryu-sdk-ffi`](../ryu-sdk-ffi) (C-ABI), [`ryu-sdk-napi`](../ryu-sdk-napi) (Node-API), and [`ryu-sdk-uniffi`](../ryu-sdk-uniffi) (Python/Swift/Kotlin) bindings all wrap *this* crate and duplicate no logic, so the manifest rules and gateway egress blocklist never drift across languages.

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
