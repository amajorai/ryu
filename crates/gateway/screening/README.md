# ryu-gw-screening

Ryu **Gateway** hazard screener backends for the managed guardrails platform floor (Phase 2).

## What it is

Pure HTTP clients, parsers and composition with **no gateway types**, so the contracts can be tested
across a crate boundary:

- `backend`: the `ScreenerBackend` trait, `ScreenRequest` / `ScreenItem`, `BackendVerdict` /
  `ItemVerdict` (per-code scores on the shared taxonomy plus a confidence source), and
  `BackendError` (`Timeout`, `Unavailable`, `Malformed`, `OverCapacity`, `NotPermitted`).
- `chain`: `ScreenerChain` runs the backends of a role (text hazard, prompt attack, vision, output).
  Local backends run concurrently; remote processors are fallback-only by default and see only the
  items the local backends left undecided. The score per code is the maximum across backends. A hard
  code (S4 always, S9 by default) is decided only by a backend with a matching qualification record.
- `safety_client`: `SafetyClient`, one pinned endpoint per backend, no redirects, a 64 KiB response
  cap, no proxies, and never the router or a provider slot.
- `cache`: keyed segment hashes (`HMAC(scope, class || NFKC(text))`) and the per-replica score cache,
  keyed by `backend_id@model@weights_sha256[0..8]#template_version`.
- `backends`:
  - `decision`: closed-choice decision models on the TypeSafe `systemone` wire. Local (Laya, Ollaya,
    Kev) is the primary screener; remote (Jev) is opt-in and gated by a `RemotePermit`.
  - `guard_model`: Llama Guard and Qwen3Guard-Gen output dialects on an OpenAI-compatible engine.
  - `inspector`: the LLM-judge inspector prompt and parser, and an adapter on a pinned endpoint.
  - `test` (tests and the `test-backends` feature only): the sentinel `TestBackend`.

The `test-backends` feature also exposes `testing::MockServer` (a llama-server style guard engine and a
systemone server answering from the spec 00.9 sentinels). Only dev-dependencies enable it.

## Role in the decomposition

The admission glue (floor parsing, fail modes, receipts, violation events, the status route) stays in
`apps/gateway/src/screening/`. The taxonomy comes from `ryu-gw-firewall::taxonomy`, which embeds
`packages/safety-taxonomy/taxonomy.json`.
