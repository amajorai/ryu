# Ryu

**Agents are powerful. Using them shouldn't be.**

[![Docs](https://shieldcn.dev/badge/Docs-ryuhq.com-73DC8C.svg?logo=readthedocs&logoColor=white)](https://ryuhq.com/help)
[![Discord](https://shieldcn.dev/discord/1439211418724597800.svg?logo=discord&logoColor=white&color=4B78E6)](https://ryuhq.com/discord)
[![X](https://shieldcn.dev/badge/Follow-@ryuhq-FA9BFA.svg?logo=x&logoColor=white)](https://twitter.com/ryuhq)
[![Open core](https://shieldcn.dev/badge/License-Open--core-73DC8C.svg?logo=opensourceinitiative&logoColor=white)](./docs/open-core.md)

Ryu is the **whole car built around AI agent engines**: end-to-end managed infrastructure that
makes powerful agents as easy to use as installing an app. The agent engines are commoditized
(OpenAI, Claude Code, Pi, OpenClaw, Hermes, any OpenAI-compatible runtime); the orchestration and
control layer around them is the moat — **what an agent can reach, what it costs, what's safe to
send, and how it's governed.** Local-first, encrypted by default, no telemetry, **BYO everything,
zero lock-in.**

> **This repository is the open-core of Ryu.** It contains the orchestration engine, the LLM
> gateway, the CLI, the desktop-automation and capture sidecars, and the developer SDK — everything
> needed to self-host and to build on Ryu. The closed UX/identity/billing surfaces (desktop, web,
> mobile, and the identity plane) are developed separately and are not part of this repository.

---

## Architecture

```
Desktop · Bots (TG/Slack/WhatsApp/Discord) · CLI · Extension · Mobile
        │
   Ryu Gateway     the moat: routing · firewall · PII/DLP · budgets · evals · audit
        │            decides WHAT IS ALLOWED, SHARED, MEASURED, and PAID FOR
   Ryu Core        orchestration: sessions · memory · tools · workflows · sub-agents · sidecars
        │            decides WHAT RUNS, then hands every model call to the Gateway
   Any engine      OpenAI · Claude Code · Pi · OpenClaw · Hermes · any OpenAI-compatible
```

**The one design rule:** if code decides *what runs* (which agent, session, workflow, tool), it is
**Core**. If it decides *what is allowed, shared, measured, or paid for* (security, routing,
registry, evals, budgets, audit), it is **Gateway**. Core never enforces policy inline; it routes
every model call through the Gateway.

---

## What's in this repository

Each unit carries its own `LICENSE` and `README.md`.

### Apps

| App | Stack | License | What it is |
|---|---|---|---|
| [`apps/core`](./apps/core) | Rust/Axum :7980 | Apache-2.0 | Orchestration engine — the local backend |
| [`apps/gateway`](./apps/gateway) | Rust :7981 | **AGPL-3.0** | The LLM moat: routing, firewall, cache, evals, audit |
| [`apps/cli`](./apps/cli) | Rust/ratatui | Apache-2.0 | Terminal client for Core |
| [`apps/ghost`](./apps/ghost) | Rust | Apache-2.0 | Desktop-automation MCP server (dual-use) |
| [`apps/shadow`](./apps/shadow) | Rust :3030 | Apache-2.0 | Screen/audio capture + semantic search (dual-use) |
| [`apps/fumadocs`](./apps/fumadocs) | Next/Fumadocs | Apache-2.0 | Documentation site + interactive OpenAPI |
| [`apps/raycast`](./apps/raycast) | Raycast/TS | MIT | Raycast extension |

### Packages & crates

| Unit | License | What it is |
|---|---|---|
| [`packages/sdk`](./packages/sdk) · [`create-ryu-app`](./packages/create-ryu-app) | Apache-2.0 | Ryu's dev SDK + project scaffolder |
| [`packages/client`](./packages/client) | Apache-2.0 | Typed Core API client |
| [`crates/ryu-sdk{,-ffi,-napi}`](./crates) | Apache-2.0 | SDK kernel + FFI/Node-API bindings |
| [`crates/ghost-{core,eyes,hands}`](./crates) | Apache-2.0 | Automation crates (shared by Ghost + Shadow) |
| [`crates/shadow-core`](./crates/shadow-core) | Apache-2.0 | Shadow capture/search engine crate |

**Licensing.** Most of Ryu is **Apache-2.0**. The **Gateway is AGPL-3.0** — it's the layer
enterprises adopt and Ryu offers as a managed service, so copyleft keeps it OSI-open while
obligating SaaS forks to share their modifications. The Raycast extension is MIT. See
[`docs/open-core.md`](./docs/open-core.md) and each unit's `LICENSE`.

---

## Quick start (self-host)

```bash
# Build the two services that make up a self-hosted Ryu
cd apps/core    && cargo build --release   # → ryu-core    (:7980)
cd apps/gateway && cargo build --release   # → ryu-gateway (:7981)
```

Point any OpenAI-compatible client at the Gateway's `/v1/chat/completions`. On first run Ryu
downloads a fully-local stack (llama.cpp + Gemma 4 chat, nomic embeddings, whisper STT) — no API
key required. Every default (model, embedding, engine, RAG strategy) is a swappable default via one
registry, never a lock.

The TypeScript units (SDK, docs) use [Bun](https://bun.sh):

```bash
bun install
bun run build
```

---

## Dual-use & consent

**Ghost** (screen perception + synthetic input control) and **Shadow** (screen/audio capture) are
dual-use: exactly the capabilities malware wants. They are open-sourced for auditability and, inside
Ryu, run only behind explicit user consent. If you embed them, gate them behind clear consent and
treat them as high-trust dependencies. See each component's `SECURITY.md`.

## Contributing & security

Contributions are welcome — see each unit's `CONTRIBUTING.md` for standalone build instructions, and
`SECURITY.md` for private vulnerability reporting (or email `security@ryuhq.com`).

## License

This repository is open-core: Apache-2.0 for most units, **AGPL-3.0** for `apps/gateway`, MIT for
`apps/raycast`. Each subdirectory carries its own `LICENSE`. © 2026 A Major Pte. Ltd.
