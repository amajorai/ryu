# ryu-sdk-napi

> Node-API addon over the Ryu SDK Rust kernel. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-NAPI-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-sdk-napi` is a Node-API (napi-rs) binding that exposes the [`ryu-sdk`](../ryu-sdk) Rust kernel to TypeScript/JavaScript as a native addon. It is published to npm as `@ryu/sdk-native`, which is what makes `@ryu/sdk` installable — the TS SDK depends on this prebuilt addon for its native logic.

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
cargo build -p ryu-sdk-napi   # → cdylib (.node)
# or build the addon via napi-rs tooling for the host platform
```

The compiled `.node` (e.g. `ryu_sdk_napi.win32-x64-msvc.node`) is what `@ryu/sdk-native` ships.

## What it provides

- A napi-rs `cdylib` addon over `ryu-sdk` (path dependency), with async support via the Tokio runtime feature.
- TypeScript typings (`index.d.ts`) and a JS loader (`index.js`).
- The npm-published `@ryu/sdk-native` package that backs `@ryu/sdk`.

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
