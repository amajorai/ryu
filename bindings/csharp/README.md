# `ryu-sdk` — C# binding (generated via `uniffi-bindgen-cs`)

The C# binding to the Ryu SDK core, **generated** from
[`crates/ryu-sdk-uniffi`](../../crates/ryu-sdk-uniffi) via the third-party
[`uniffi-bindgen-cs`](https://github.com/NordSecurity/uniffi-bindgen-cs)
generator. It exposes the same shared Rust kernel as the TypeScript
(`crates/ryu-sdk-napi`), Python (`bindings/python`), and Go (`bindings/go`)
bindings, so manifest validation, the gateway egress blocklist, and the
model/embedding transport never drift across languages. The surface includes the
streaming `ModelClient.Stream(messages, sink)` export and its `ChatSink` callback
interface (`OnDelta` / `OnError` / `OnDone`).

## Status

- **Binding generated + committed-shell in place.** `ryu_sdk.cs` was generated
  from the compiled `ryu_sdk_uniffi.dll` (the same cdylib the Python smoke loads),
  so the generation pipeline is proven on this machine.
- **Smoke NOT yet run here.** The environment has the .NET *runtime* but no .NET
  *SDK*, so `dotnet run` could not compile the smoke. A developer with the .NET SDK
  runs the steps below to prove it end-to-end.

## Supply-chain pin (load-bearing)

`uniffi-bindgen-cs` is maintained out-of-tree (NordSecurity) and version-locked to
a specific UniFFI minor. The `crates/ryu-sdk-uniffi` crate pins `uniffi = "0.28"`
(resolving to 0.28.3), so the matching generator is **`v0.9.2+v0.28.3`**. Bumping
the `uniffi` dependency is a coordinated cross-language event — the C# (and Go)
generators cannot regenerate until they support the target minor. See the
supply-chain section of
[`docs/multi-language-bindings-spec.md`](../../docs/multi-language-bindings-spec.md).

## What is committed vs generated

- **Committed:** this README, `ryu_sdk.csproj` (packaging shell), `Program.cs`
  (the smoke), `.gitignore`.
- **Generated (gitignored):** `ryu_sdk.cs` and the compiled
  `ryu_sdk_uniffi.dll` (`libryu_sdk_uniffi.{so,dylib}` on Unix) placed beside it.

## Regenerate + smoke locally

`ryu-sdk-uniffi` is a STANDALONE crate (its own `Cargo.lock`, no workspace), so
`cargo` and `uniffi-bindgen-cs` both run from inside it. From the repo root a
`just` shortcut wraps all of this: `just -f crates/ryu-sdk-uniffi/justfile
gen-csharp`. The manual steps:

```sh
# 0. One-time: install the version-matched generator.
cargo install uniffi-bindgen-cs \
  --git https://github.com/NordSecurity/uniffi-bindgen-cs \
  --tag v0.9.2+v0.28.3

cd crates/ryu-sdk-uniffi

# 1. Build the cdylib.
cargo build --release

# 2. Generate the C# surface from the compiled library. (Run from the crate dir:
#    uniffi-bindgen-cs reads Cargo metadata from the current directory.)
uniffi-bindgen-cs --library target/release/ryu_sdk_uniffi.dll \
  --out-dir ../../bindings/csharp

# 3. Copy the compiled library next to the generated surface so P/Invoke resolves.
cp target/release/ryu_sdk_uniffi.dll ../../bindings/csharp/

# 4. Prove it (needs the .NET SDK, not just the runtime).
cd ../../bindings/csharp && dotnet run
# -> ryu_sdk C# binding smoke test: OK
```

On Unix the artifact is `target/release/libryu_sdk_uniffi.so` (or `.dylib`); swap
the two `ryu_sdk_uniffi.dll` paths above for it.

## Scope

The full `ryu-sdk-uniffi` surface: `ValidatePluginId`,
`ParseAndValidateManifest`, `PluginManifestJsonSchema`, `ResolveGatewayUrl`,
`ResolveGatewayToken`, `AssertAllowedEgress`, `ModelClient.Chat`,
`ModelClient.Stream` (+ `ChatSink`), `EmbeddingClient.Embed`.
