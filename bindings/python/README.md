# `ryu-sdk` — Python binding

The Python binding to the Ryu SDK core, **generated** from
[`crates/ryu-sdk-uniffi`](../../crates/ryu-sdk-uniffi) via UniFFI. It exposes the
same shared Rust kernel as the TypeScript (`crates/ryu-sdk-napi`) and Go
(`bindings/go`) bindings, so manifest validation, the gateway egress blocklist,
and the model/embedding transport never drift across languages.

## What is committed vs generated

- **Committed:** this README, `pyproject.toml` (packaging shell), `smoke_test.py`
  (the pipeline proof).
- **Generated (gitignored):** the importable `ryu_sdk/` package and the compiled
  `libryu_sdk_uniffi.{so,dylib}` / `ryu_sdk_uniffi.dll` placed beside it.

## Regenerate locally

`ryu-sdk-uniffi` is a STANDALONE crate (its own `Cargo.lock`, no workspace), so
all `cargo` commands run from inside it and `target/` lives there. Paths below are
relative to `crates/ryu-sdk-uniffi/` (matching the CI in
`.github/workflows/sdk-bindings.yml`).

```sh
cd crates/ryu-sdk-uniffi

# 1. Build the cdylib.
cargo build --release

# 2. Generate the Python module from the compiled library. The out-dir is the
#    repo-root bindings/python/ryu_sdk (two levels up).
cargo run --release --bin uniffi-bindgen -- \
  generate --library target/release/libryu_sdk_uniffi.so \
  --language python --out-dir ../../bindings/python/ryu_sdk

# 3. Copy the compiled library next to the generated module so it loads.
cp target/release/libryu_sdk_uniffi.so ../../bindings/python/ryu_sdk/

# 4. Prove it.
cd ../../bindings/python && PYTHONPATH=. python smoke_test.py
```

On Windows the artifact is `target/release/ryu_sdk_uniffi.dll` (no `lib` prefix,
not `.so`); swap the two `libryu_sdk_uniffi.so` paths above for it. A committed
`ryu_sdk/__init__.py` re-exports the generated `ryu_sdk.py` so `import ryu_sdk`
resolves the surface directly (it is the one tracked file under the otherwise
gitignored `ryu_sdk/` package).

(The `uniffi-bindgen` bin target is `src/bin/uniffi-bindgen.rs`, calling
`uniffi::uniffi_bindgen_main()` from the `cli` feature on the `uniffi` dep. The
emitted module name is `ryu_sdk` because the crate calls
`setup_scaffolding!("ryu_sdk")` — the namespace, not the crate name
`ryu_sdk_uniffi`, drives the package name.)

## Scope

The blocking surface only: `validate_plugin_id`, `parse_and_validate_manifest`,
`plugin_manifest_json_schema`, `resolve_gateway_url`, `resolve_gateway_token`,
`assert_allowed_egress`, `ModelClient.chat`, `EmbeddingClient.embed`. **Streaming
chat is deferred** (UniFFI has no closure type; it needs a `ChatSink` callback
interface). See [`docs/multi-language-bindings-spec.md`](../../docs/multi-language-bindings-spec.md).
