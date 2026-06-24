# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="center" alt="" />&nbsp; ryu-sdk-uniffi

> UniFFI binding surface over the Ryu SDK Rust kernel — the multi-language path. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-UniFFI-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-sdk-uniffi` wraps the [`ryu-sdk`](../ryu-sdk) Rust kernel with [UniFFI](https://github.com/mozilla/uniffi-rs), so a single cdylib emits idiomatic packages for multiple languages. It wraps the *same* `ryu_sdk::*` functions the other bindings do — manifest validation, the gateway egress blocklist, and the model/embedding transport — so nothing drifts across languages.

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
cargo build -p ryu-sdk-uniffi   # → cdylib + staticlib + lib
cargo test  -p ryu-sdk-uniffi   # asserts the shared rules without a foreign toolchain

# Generate language bindings from the built library:
cargo run -p ryu-sdk-uniffi --bin uniffi-bindgen -- generate --library <built-cdylib> --language python --out-dir <out>
```

Per `Cargo.toml`, `uniffi-bindgen` emits Python, Swift, and Kotlin; C# and Go are available via the third-party `uniffi-bindgen-cs` / `uniffi-bindgen-go` generators. The generated module imports as `ryu_sdk` (set by `setup_scaffolding!` and `uniffi.toml`).

## What it provides

- **Manifest + gateway** (`#[uniffi::export]` fns) — `validate_plugin_id`, `parse_and_validate_manifest`, `plugin_manifest_json_schema`, `resolve_gateway_url`/`resolve_gateway_token`, `assert_allowed_egress`.
- **Model + embedding clients** — `ModelClient` / `EmbeddingClient` objects with `Record` types (`ChatMessage`, `ChatResult`, `Usage`, `Embedding`, `EmbeddingResult`); direct-provider base URLs are rejected at construction.
- **Blocking surface only** — value-in / value-out, mapping cleanly onto UniFFI's IDL. Streaming chat is deliberately omitted (UniFFI has no closure type; it is the deferred `ChatSink` callback-interface slice — see `docs/multi-language-bindings-spec.md`).

## Role / How it fits

The generated multi-language path among the three kernel bindings — alongside [`ryu-sdk-ffi`](../ryu-sdk-ffi) (C-ABI / Go) and [`ryu-sdk-napi`](../ryu-sdk-napi) (TypeScript/JS).

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
