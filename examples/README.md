# Ryu SDK examples

Small, runnable examples for building on Ryu with [`@ryu/sdk`](../packages/sdk). Every
example routes model calls through the **gateway** — no provider keys live in code.

## Run

```bash
bun install
# point at your gateway (defaults shown)
export RYU_GATEWAY_URL=http://127.0.0.1:7981
export RYU_GATEWAY_TOKEN=...        # if your gateway requires auth
export RYU_MODEL=gpt-4o-mini        # any model your gateway routes

bun run examples/agent/minimal-agent.ts "the sea at dawn"
bun run examples/tool/calculator.ts
bun run examples/workflow/summarize-and-rate.ts
bun run examples/gateway/openai-compat-smoke.ts
```

## What's here

| Example | Shows |
|---|---|
| [`agent/minimal-agent.ts`](./agent/minimal-agent.ts) | `defineAgent` — wrap a `run` function as an agent Runnable that calls a model via the gateway |
| [`tool/calculator.ts`](./tool/calculator.ts) | `defineTool` — a typed, JSON-Schema-validated deterministic tool (no model needed) |
| [`workflow/summarize-and-rate.ts`](./workflow/summarize-and-rate.ts) | `defineWorkflow` — compose a tool + a model call; agents/tools/workflows are peers under one `run(input, ctx)` contract |
| [`gateway/openai-compat-smoke.ts`](./gateway/openai-compat-smoke.ts) | Hit the gateway's OpenAI-compatible `/v1/chat/completions` directly |

## The one rule

Every model call goes through the Ryu **gateway** (`defineModel` / `ctx.gateway`),
never a provider base URL directly — that's where routing, firewall, budgets, and
audit apply. To scaffold a full project with a `plugin.json`, use
[`create-ryu-app`](../packages/create-ryu-app): `bunx create-ryu-app my-app`.
