# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-sdk-ffi

> C-ABI bindings over the Ryu SDK Rust kernel. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-FFI-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-sdk-ffi` exposes a stable C-ABI surface over [`ryu-sdk`](../ryu-sdk), so the kernel's Runnable/manifest logic, gateway egress rules, and model/embedding clients can be called from any C-FFI consumer, including the Go (cgo) binding. It duplicates no logic; the single Rust kernel stays the source of truth.

**Tier:** OSS, Apache-2.0

## Install / Build

```bash
cargo build -p ryu-sdk-ffi   # → staticlib + cdylib + rlib
cargo test  -p ryu-sdk-ffi
```

The generated C header lives in `include/ryu_sdk.h` (regenerate via cbindgen; see `cbindgen.toml`).

## What it provides

- **Manifest + schema:** `ryu_validate_plugin_id`, `ryu_parse_and_validate_manifest`, `ryu_plugin_manifest_json_schema`.
- **Gateway:** `ryu_resolve_gateway_url`, `ryu_assert_allowed_egress` (rejects direct-provider URLs).
- **Model + embedding clients:** opaque-handle `*_new` / `*_chat` / `*_embed` / `*_free`, blocking on a shared Tokio runtime.
- **Memory + errors:** every returned `char*` is heap-owned and freed via `ryu_string_free`; thread-local `ryu_last_error` carries the message.
- `staticlib` / `cdylib` / `rlib` outputs for static linking, dynamic loading, and Rust-side tests.

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
