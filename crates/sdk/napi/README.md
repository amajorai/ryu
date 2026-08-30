# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-sdk-napi

> Node-API addon over the Ryu SDK Rust kernel. Part of [Ryu](../../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-NAPI-dea584.svg?logo=rust&logoColor=white)](../../../README.md)

`ryu-sdk-napi` is a Node-API (napi-rs) binding that exposes the [`ryu-sdk`](../core) Rust kernel to TypeScript/JavaScript as a native addon. It is published to npm as `@ryuhq/sdk-native`, which is what makes `@ryuhq/sdk` installable. The TS SDK depends on this prebuilt addon for its native logic, so manifest rules and Gateway egress never reimplement in JS.

**Tier:** OSS, Apache-2.0

## Install / Build

```bash
cargo build -p ryu-sdk-napi   # → cdylib (.node)
# or, via napi-rs tooling for the host platform:
napi build --platform --release
```

The compiled `.node` (e.g. `ryu_sdk_napi.win32-x64-msvc.node`) is what `@ryuhq/sdk-native` ships. A `smoke.mjs` exercises the loaded addon.

## What it provides

- A napi-rs `cdylib` addon (napi8, async + Tokio runtime) wrapping `ryu-sdk`: manifest validation, gateway URL/egress checks, and the model/embedding clients.
- TypeScript typings (`index.d.ts`) and a JS loader (`index.js`).
- The npm-published `@ryuhq/sdk-native` package that backs `@ryuhq/sdk`.

## Role / How it fits

One of three bindings over the shared kernel, alongside [`ryu-sdk-ffi`](../ffi) (C-ABI / Go) and [`ryu-sdk-uniffi`](../uniffi) (Python/Swift/Kotlin/C#). It is the only one that keeps the streaming closure boundary, via napi-rs `ThreadsafeFunction`.

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
