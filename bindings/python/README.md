# `ryu-sdk` — Python binding

The Python binding to the Ryu SDK core, **generated** from
[`crates/sdk/uniffi`](../../crates/sdk/uniffi) via UniFFI. It exposes the
same shared Rust kernel as the TypeScript (`crates/sdk/napi`) and Go
(`bindings/go`) bindings, so manifest validation, the gateway egress blocklist,
and the model/embedding transport never drift across languages.

## What is committed vs generated

- **Committed:** this README, `pyproject.toml` (packaging shell), `smoke_test.py`
  (the pipeline proof), `test_sdk.py` (the binding contract tests), and
  `example.py` (a no-network example project entry point).
- **Generated (gitignored):** the importable `ryu_sdk/` package and the compiled
  `libryu_sdk_uniffi.{so,dylib}` / `ryu_sdk_uniffi.dll` placed beside it.

## Regenerate locally

`ryu-sdk-uniffi` is a workspace member with its own lockfile. Commands below use
the repository root manifest path, so the shared `target/` directory is used
consistently by the Rust and foreign binding tests.

```sh
# 1. Build the cdylib.
cargo build --release --manifest-path crates/sdk/uniffi/Cargo.toml

# 2. Generate the Python module from the compiled library. The out-dir is the
#    repository-root bindings/python/ryu_sdk.
cargo run --release --manifest-path crates/sdk/uniffi/Cargo.toml \
  --bin uniffi-bindgen -- generate \
  --library target/release/libryu_sdk_uniffi.so \
  --language python --out-dir bindings/python/ryu_sdk

# 3. Copy the compiled library next to the generated module so it loads.
cp target/release/libryu_sdk_uniffi.so bindings/python/ryu_sdk/

# 4. Prove it.
cd bindings/python && PYTHONPATH=. python3 smoke_test.py
PYTHONPATH=. python3 -m unittest -v test_sdk.py
PYTHONPATH=. python3 example.py
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

The exported surface includes `validate_plugin_id`, `parse_and_validate_manifest`,
`plugin_manifest_json_schema`, `resolve_gateway_url`, `resolve_gateway_token`,
`assert_allowed_egress`, `ModelClient.chat`, `ModelClient.stream` with
`ChatSink`, and `EmbeddingClient.embed`. See the public
[Fumadocs language-binding guide](https://docs.ryuhq.com/docs/extend/develop/sdk/language-bindings).
