# Ryu SDK — Kotlin example project

This directory is a Gradle/JVM example and test project for the UniFFI binding.
The generated Kotlin source is derived from `crates/sdk/uniffi` and ignored;
the Rust binding remains the only source of truth. JNA is the runtime bridge
used by UniFFI's generated JVM bindings.

## Requirements

- JDK 17 or newer
- Gradle 8 or newer
- Rust and Cargo

## Test and run

From the repository root on a JVM/Linux host:

```sh
bash bindings/kotlin/test.sh
```

The command builds the shared Rust library, generates the Kotlin package, runs
the JUnit test suite, and runs the no-network example. The example validates a
plugin id, checks Gateway egress, and constructs a Gateway-pointed model client;
it does not send a model request.

The generated API includes manifest validation, Gateway URL/token resolution,
egress enforcement, `ModelClient` chat/streaming, `EmbeddingClient`, and the
`ChatSink` callback interface.
