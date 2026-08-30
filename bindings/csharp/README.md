# Ryu SDK — C# binding

This example project uses the version-matched third-party
[`uniffi-bindgen-cs`](https://github.com/NordSecurity/uniffi-bindgen-cs) generator
over `crates/sdk/uniffi`. It exposes the same manifest validation, Gateway
egress, model, embedding, and `ChatSink` surfaces as the first-party UniFFI
targets.

## Version pin

`crates/sdk/uniffi` uses UniFFI `0.28.3`. Install the matching C# generator:

```sh
cargo install uniffi-bindgen-cs \
  --git https://github.com/NordSecurity/uniffi-bindgen-cs \
  --tag v0.9.2+v0.28.3
```

## Test and run

From the repository root on a .NET 8 SDK host:

```sh
bash bindings/csharp/test.sh
```

The command builds the shared Rust cdylib, generates `ryu_sdk.cs`, copies the
native library beside the project, and runs `Program.cs`. The smoke is
no-network: it validates a plugin id and manifest, checks Gateway egress, and
constructs Gateway-pointed model and embedding clients. The generated source
and native library are ignored build outputs.
