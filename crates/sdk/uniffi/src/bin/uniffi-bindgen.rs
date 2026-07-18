//! The `uniffi-bindgen` CLI entry point for this crate.
//!
//! `cargo run --release --bin uniffi-bindgen -- generate --library <cdylib>
//! --language python --out-dir <dir>` drives this. The binary is provided by the
//! `cli` feature on the `uniffi` dependency; this thin `main` is the bin target
//! that exposes it (UniFFI does not ship a standalone `uniffi-bindgen` binary you
//! can `cargo run` without declaring one).
fn main() {
    uniffi::uniffi_bindgen_main();
}
