# ryu-sdk-ffi

> C-ABI bindings over the Ryu SDK Rust kernel. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-FFI-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-sdk-ffi` exposes a stable C-ABI surface over [`ryu-sdk`](../ryu-sdk), so the kernel's Runnable/manifest logic and gateway egress rules can be consumed from any C-FFI client (including the Go cgo binding). It builds as a static library for cgo static linking, a dynamic library for runtime loading, and an rlib so the C-ABI surface stays unit-testable from Rust.

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
cargo build -p ryu-sdk-ffi   # → staticlib + cdylib + rlib
cargo test  -p ryu-sdk-ffi
```

Generated C headers live in `include/` (see `cbindgen.toml`).

## What it provides

- A C-ABI FFI surface over `ryu-sdk` (path dependency).
- `staticlib` / `cdylib` / `rlib` crate outputs for static linking, dynamic loading, and Rust-side tests.
- A C header (`include/`) generated via cbindgen.

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
