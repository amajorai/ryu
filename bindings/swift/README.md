# Ryu SDK — Swift example project

This directory is a Swift Package example and test project for the UniFFI
binding. The generated Swift source and FFI module are derived from
`crates/sdk/uniffi`; they are intentionally ignored so the Rust surface remains
the only source of truth.

## Requirements

- Swift 5.9 or newer
- Rust and Cargo
- macOS for the current native-library test command

## Test and run

From the repository root:

```sh
bash bindings/swift/test.sh
```

The command builds the shared Rust library, generates `RyuSdk.swift` and its
FFI module, runs the XCTest suite, and runs the no-network example. The example
only validates a plugin id, checks Gateway egress, and constructs a
Gateway-pointed model client; it does not send a model request.

The generated API includes manifest validation, Gateway URL/token resolution,
egress enforcement, `ModelClient` chat/streaming, `EmbeddingClient`, and the
`ChatSink` callback interface. A live chat or embedding call requires a running
Ryu Gateway and is covered by the Rust transport tests.
