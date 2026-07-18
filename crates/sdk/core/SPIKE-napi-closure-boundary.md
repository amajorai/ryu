# SPIKE — napi Rust-core FFI closure boundary proof (#437)

> Phase-2 gate for epic #425. Decides the core/wrapper split and whether
> multi-language bindings (UniFFI) are viable across the same boundary before we
> fan out per-language binding work.

## TL;DR / verdict

- **Ship the TS binding on napi-rs for v1.** The closure boundary — a host-language
  `run()` / streaming callback crossing into the native core per invocation —
  is **proven working today** by `crates/ryu-sdk-napi`'s `ModelClient.stream()`,
  which drives a JS callback from a Rust async stream via a `ThreadsafeFunction`.
- **Defer Go / C# / Python (UniFFI) bindings.** UniFFI has no closure type. The
  same per-invocation callback boundary must be re-expressed as a **callback
  interface** (a host object implementing a Rust-defined trait), which is a
  larger surface and a different ergonomics story than napi's closures. It is
  doable but should not block v1, and the caveat below must be designed in, not
  discovered later.
- **Confirmed split:** the Rust core (`ryu-sdk`) stays *thin* — manifest
  validation, gateway egress rules, the gateway-mandatory model/embedding HTTP
  clients. The host-language layer keeps everything that is genuinely a closure:
  the Runnable `run()` body, the streaming consumer, app wiring. This matches the
  VS Code lesson cited in the issue: extension **code** runs in the host language;
  only declarative `contributes`/manifest data lives in the shared layer.

## (a) How the host-language closure crosses each boundary

### napi-rs (what we built) — closures cross natively

The hard case in the issue is "Rust calling back into a JS/Go/C# closure per
invocation." napi-rs solves this with `ThreadsafeFunction` (TSFN): a JS function
reference that is safe to call from any Rust thread, marshalling each call back
onto the Node event loop.

Concretely, in `crates/ryu-sdk-napi/src/lib.rs`:

- `ModelClient.stream(messages, callback)` takes
  `callback: ThreadsafeFunction<Option<ChatDelta>>` (`src/lib.rs:131-135`). That
  `callback` is an ordinary JS function the TS caller passes in — the host-language
  closure.
- The method spawns the core's async stream onto the addon's tokio runtime
  (`napi::tokio::spawn`, `src/lib.rs:138`), and for every SSE delta the Rust core
  yields it calls back into JS with
  `callback.call(Ok(Some(payload)), ThreadsafeFunctionCallMode::NonBlocking)`
  (`src/lib.rs:148`). Errors call back with `Err(..)` (`src/lib.rs:151-154`) and a
  clean end-of-stream sends a `null` sentinel (`src/lib.rs:160`).

So the closure crosses the boundary **per delta**, Rust→JS, off a background
thread, with no per-call manual glue beyond declaring the TSFN parameter. The
import at `src/lib.rs:11` (`ThreadsafeFunction`, `ThreadsafeFunctionCallMode`) is
the entire machinery. This is exactly the per-invocation callback the spike set
out to prove, and it compiles and runs (see "what the napi crate proves today").

The Runnable `run()` itself does **not** need to be reimplemented in Rust: a TS
`defineAgent({ run })` keeps `run` in TypeScript and calls *into* the native
`ModelClient`/`EmbeddingClient` for the gateway-governed I/O. The native side
never owns the agent loop — it owns the transport and the rules.

### UniFFI (Go / C# / Python / Swift / Kotlin) — no closures, callback interfaces instead

UniFFI deliberately has **no closure / `fn`-pointer type** in its IDL. You cannot
pass a Go func or a C# delegate as a Rust closure argument. The supported pattern
is a **callback interface** (a.k.a. foreign trait impl): Rust declares a trait,
the host language implements it as an object, and a host instance is passed in;
Rust invokes its methods. To re-express the streaming callback under UniFFI you
would define something like a `trait ChatSink { fn on_delta(&self, d: ChatDelta);
fn on_error(&self, e: String); fn on_done(&self); }`, have the host implement it,
and call those methods from Rust instead of calling a closure.

Implications versus napi:

- **More boilerplate, different shape.** One closure becomes a multi-method
  interface object per host language. Lifetime/threading rules for foreign objects
  called from Rust threads are stricter and vary by target.
- **Per-call overhead is comparable in spirit** (an FFI call per delta), but the
  marshalling/codegen path is heavier and the ergonomics are worse for the SDK's
  callback-heavy surface (`run()`, streaming).
- **The C-ABI crate we already have (`ryu-sdk-ffi`) sidesteps closures entirely**
  by exposing only **blocking, value-in/value-out** functions
  (`ryu_model_client_chat`, now `ryu_embedding_client_embed`) that `block_on` the
  core runtime (`crates/ryu-sdk-ffi/src/lib.rs:33-41`, `:262`). Go/C# call these
  synchronously and run their own goroutine/Task for concurrency — **no Rust→host
  closure crosses at all**. That is the pragmatic near-term path for non-TS
  languages: ship blocking calls over the C ABI, add streaming-as-callback-interface
  later if demand warrants.

## (b) Concrete verdict

| Target | Mechanism | Closure boundary | Decision |
|---|---|---|---|
| TypeScript / JS (v1) | **napi-rs** | `ThreadsafeFunction` — closures cross natively, proven | **Ship now** (`crates/ryu-sdk-napi`) |
| Go / C# / Python (later) | C-ABI (`ryu-sdk-ffi`) for blocking calls; UniFFI callback interfaces if streaming is needed | No closures over C-ABI; UniFFI = callback interface, **not** a closure | **Defer**, caveat below |

- **napi-rs for the TS binding, v1.** Cited working code:
  `crates/ryu-sdk-napi/src/lib.rs:131-163` (`ModelClient.stream` driving a JS
  callback per delta). The async unary path
  (`ModelClient.chat`, `src/lib.rs:113-124`) and the new `EmbeddingClient.embed`
  also cross the boundary cleanly with napi's `async fn` support.
- **UniFFI for Go/C#/Python is deferred,** and the **closure caveat is the
  reason**: there is no closure type, so any per-invocation callback (streaming,
  HITL prompts, tool dispatch back into host code) must be modelled as a callback
  interface object. Until a non-TS language actually needs *streaming*, the
  existing C-ABI blocking surface (`ryu-sdk-ffi`) covers Go/C# without any closure
  crossing at all. Adopt UniFFI only when streaming/HITL into a non-TS host is a
  real requirement, and design the callback interface up front.

## (c) What the napi crate proves *today* (with citations)

- **The closure boundary works end-to-end.** `ModelClient.stream` accepts a JS
  callback as `ThreadsafeFunction<Option<ChatDelta>>`
  (`crates/ryu-sdk-napi/src/lib.rs:134`) and invokes it for each delta
  (`:148`), for errors (`:151`), and for clean completion with a `null` sentinel
  (`:160`), all off a spawned tokio task (`:138`). The machinery is a single
  import (`:11`).
- **The core is genuinely thin and shared.** Every napi entry point delegates
  straight into `ryu_sdk::*` with only type marshalling: manifest validate
  (`:18-19`, `:25-27`), JSON Schema (`:33-34`), gateway resolve/egress (`:41-54`),
  the model client (`:102-108`, `:113-124`), and now the embedding client. There
  is **no logic duplicated** in the binding — the binding is a marshalling shell.
- **The same core also has a closure-free C ABI.** `crates/ryu-sdk-ffi/src/lib.rs`
  exposes blocking calls (`ryu_model_client_chat` at `:242`,
  `ryu_embedding_client_embed`) over a shared multi-thread runtime
  (`:33-41`), proving the non-closure path that Go/C# can use immediately. Its
  unit tests pass (`cargo test -p ryu-sdk-ffi`: 5 passed).
- **Single-core guarantee.** Because both bindings call the same `ryu-sdk`
  functions, the manifest rules, gateway egress blocklist, and model/embedding
  transport can never drift across languages — the property the whole binding
  strategy depends on.

### Per-call overhead note

The napi path adds one TSFN dispatch per streamed delta (a bounded, non-blocking
hop onto the Node event loop) on top of the network read the core already does;
for a token-streaming chat this is dominated by network/model latency, not the
boundary. The C-ABI blocking path adds one `block_on` per call and zero per-delta
crossings. Neither is a bottleneck for the SDK's I/O-bound workload, which is why
"keep `run()` in the host, call the thin native core for governed I/O" is the
right split rather than pushing the agent loop into Rust.
