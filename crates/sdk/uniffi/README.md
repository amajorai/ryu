# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-sdk-uniffi

> UniFFI binding surface over the Ryu SDK Rust kernel: the multi-language path. Part of [Ryu](../../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-UniFFI-dea584.svg?logo=rust&logoColor=white)](../../../README.md)

`ryu-sdk-uniffi` wraps the [`ryu-sdk`](../core) Rust kernel with [UniFFI](https://github.com/mozilla/uniffi-rs), so a single cdylib emits idiomatic packages for multiple languages. It wraps the *same* `ryu_sdk::*` functions the other bindings do (manifest validation, the gateway egress blocklist, and the model/embedding transport), so nothing drifts across languages.

**Tier:** OSS, Apache-2.0

## Install / Build

```bash
cargo build -p ryu-sdk-uniffi   # → cdylib + staticlib + lib
cargo test  -p ryu-sdk-uniffi   # asserts the shared rules without a foreign toolchain

# Generate language bindings from the built library:
cargo run -p ryu-sdk-uniffi --bin uniffi-bindgen -- generate --library <built-cdylib> --language python --out-dir <out>
```

Per `Cargo.toml`, `uniffi-bindgen` emits Python, Swift, and Kotlin; C# is
available through the version-pinned third-party `uniffi-bindgen-cs` generator.
Go uses the maintained hand-written C ABI in `crates/sdk/ffi` rather than a
third-party UniFFI generator. The generated Python module imports as `ryu_sdk`
(set by `setup_scaffolding!`). The language example projects and their tests are
under `bindings/`.

## What it provides

- **Manifest + gateway** (`#[uniffi::export]` fns): `validate_plugin_id`, `parse_and_validate_manifest`, `plugin_manifest_json_schema`, `resolve_gateway_url`/`resolve_gateway_token`, `assert_allowed_egress`.
- **Model + embedding clients:** `ModelClient` / `EmbeddingClient` objects with `Record` types (`ChatMessage`, `ChatResult`, `Usage`, `Embedding`, `EmbeddingResult`); direct-provider base URLs are rejected at construction.
- **Blocking and callback streaming:** value-in / value-out operations map cleanly onto UniFFI's IDL. Streaming chat uses the exported `ChatSink` callback interface because UniFFI has no closure type; each stream terminates with exactly one `on_done` or `on_error` callback.

## Role / How it fits

The generated multi-language path among the three kernel bindings, alongside [`ryu-sdk-ffi`](../ffi) (C-ABI / Go) and [`ryu-sdk-napi`](../napi) (TypeScript/JS).

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
