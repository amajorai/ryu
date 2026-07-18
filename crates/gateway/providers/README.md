# ryu-gw-providers

Ryu **Gateway** concrete backend providers — the HTTP implementations behind the `Provider` trait,
extracted into a self-contained crate.

## What it is

The `Provider` trait plus its built-in HTTP implementations and the shared provider machinery:

- **Providers** — `OpenAiProvider`, `AnthropicProvider`, `LocalProvider`, `CoreProvider`,
  `OpenRouterProvider`, `ModalProvider`, `GenAiProvider`, `ReplicateProvider`, `FalProvider`
  (one module each).
- **Shared HTTP helpers** — retry with back-off, rate-limit header parsing, model discovery,
  media-output normalization (in `lib.rs`).
- **`quota`** — the per-provider quota sink (drives capacity-aware demotion).
- **`jobs`** — video-job value types (`JobStatus`, `VideoJob`) for async media generation.
- **`error`** — the crate-local `ProviderError`.

## Role in the decomposition

A **"engine moves, wiring stays" core crate**. The `ProviderRegistry` + config-driven registration
+ provider-key **custody** stay in `apps/gateway` (`src/providers.rs`). The trait returns the
crate-local `ProviderError`; the Gateway maps it **1:1** to its `GatewayError` at the pipeline call
boundary (`impl From<ProviderError> for GatewayError`) — this is what preserves the
rate-limit-vs-fault distinction the circuit breaker depends on. Adding a provider is a drop-in: a
new `Provider` impl here + a registration line in the Gateway.

## Key API

- `trait Provider` — the completion/model/media contract every backend implements.
- The nine provider structs above; `ProviderError`; `JobStatus` / `VideoJob`.

## How it is consumed

Compiled **into the Gateway** binary (`apps/gateway`), which registers instances and custodies keys.
Not a sidecar. The swap seam is the Gateway's `ProviderRegistry`; this crate supplies the backends.
