# ryu-gw-evals

Ryu **Gateway** evals stage (decomposition W6), extracted from `apps/gateway/src/evals` into a
self-contained crate.

## What it is

Two things:

- **Live scoring** — the `EvalsRunner`: per-request sampling (`should_sample`) + per-provider score
  EMA (`record_provider_score` / `provider_score` / `all_provider_scores`). `score` grades a
  response on latency + policy-pass into an `EvalResult`. This score feeds the router's eval-driven
  A/B pick.
- **Dataset scorers** — pure, network-free helpers: `score_case`, `aggregate_scores`, the
  `Assertion` types, and LLM-judge helpers.

## Role in the decomposition

An **extracted gateway stage crate**. Config lives here; the Gateway re-exports `EvalsConfig` from
`crate::config`, so `GatewayConfig.evals` and every call site are unchanged. The swap seam is a
**backend trait + registry**:

- `EvalsBackend` — the trait a swappable evals engine implements.
- `EvalsRegistry` — id-keyed holder; the built-in `EvalsRunner` (`BUILTIN = "builtin"`) is active
  by default (`from_runner`, `register`, `set_active`, `available`).

## Key API

- `EvalsRunner::new(EvalsConfig)`, `should_sample`, `score`, `record_provider_score`,
  `provider_score`, `all_provider_scores`, `sampled_count`.
- `EvalResult`, `EvalsConfig` (`enabled`, `max_latency_ms`, `sample_rate`, include-usage flag).
- Dataset side: `score_case`, `aggregate_scores`, `Assertion`, judge helpers.

## How it is consumed

Compiled **into the Gateway** binary (`apps/gateway`), which owns the pipeline wiring. Not a sidecar.
Swap the engine by registering a different `EvalsBackend`.
