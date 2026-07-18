# ryu-gw-router

Ryu **Gateway** model-routing core (Plane A) — the pure model→provider decision logic, extracted in
decomposition W6 from `apps/gateway/src/router/`.

## What it is

The routing *algorithm*, keyed on provider **strings** (the `ProviderKind`→string opening).
Everything here is pure — it operates over `&str` / `String` / `serde_json::Value` / `usize`, with
no Gateway config-types, no async, and no process/network state:

- **`RoutingTables`** — `route` (resolution order: exact map → longest user prefix → built-in prefix
  table → default), `route_modality` (per-modality slot resolution), `fallback_chain` (cost-tier
  sort), `eval_route` (eval-driven A/B explore/exploit picker).
- **`builtin_prefixes`** — the zero-config prefix→provider table (`claude-`→anthropic, `gpt-`→openai,
  `zeroclaw`/`openclaw`→core, …). This *is* the "just works" routing brain.
- **Classifier ("smart routing") text helpers** — `build_prompt`, `parse_choice`, `keyword_match`,
  `last_user_message`, `truncate`; `MAX_CLASSIFIER_INPUT_CHARS`.

## Role in the decomposition

A **"engine moves, wiring stays" core crate**. What stays in `apps/gateway/src/router/`: the
`ModelRouter` / `SmartRouter` structs that snapshot config into these tables, the `RouterRegistry` /
`SmartRouterBackend` traits + registration (the swap seam), the `RouteDecision` + config
value-types, the `AtomicU64` A/B counter (passed in via a closure so its increment timing is
preserved), and SmartRouter's async provider/embedding orchestration. The Gateway wrappers resolve
config → these string tables and map returned provider strings back to `ProviderId` /
`RouteDecision`, so every call site is behavior-identical.

## How it is consumed

Compiled **into the Gateway** binary (`apps/gateway`). Depends only on `serde_json` / `tracing`. Not
a sidecar. Swap the router at the Gateway's `RouterRegistry`; this crate is the resolution logic it
drives.
