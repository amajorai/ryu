# <img src=".github/logo.png" width="50" align="center" alt="" />&nbsp; Ryu

**Agents are powerful. Using them shouldn't be.**

[![Docs](https://shieldcn.dev/badge/Docs-ryuhq.com-73DC8C.svg?logo=readthedocs&logoColor=white)](https://ryuhq.com/help)
[![Discord](https://shieldcn.dev/discord/1439211418724597800.svg?logo=discord&logoColor=white&color=4B78E6)](https://ryuhq.com/discord)
[![X](https://shieldcn.dev/badge/Follow-@ryuhq-FA9BFA.svg?logo=x&logoColor=white)](https://twitter.com/ryuhq)
[![Open source](https://shieldcn.dev/badge/License-Apache--2.0%20%2B%20AGPL--3.0-73DC8C.svg?logo=opensourceinitiative&logoColor=white)](./docs/open-core.md)

**End-to-end infrastructure for AI agents.** The engines already exist: OpenAI, Claude Code, Pi, OpenClaw, Hermes, any OpenAI-compatible runtime. Ryu is the whole stack around them, so any agent works everywhere, as easily as installing an app.

One control layer governs what each agent can reach, what it costs, and what's safe to send. Memory, routing, observability, and security are built in.

Local-first, encrypted by default, no telemetry. Locked to no provider or ecosystem: bring your own agent, key, and model, and every default is swappable.

- 🔌 **Any engine, zero lock-in.** Wrap the agent you already use (OpenAI, Claude Code, Pi, OpenClaw, Hermes, and more). Ryu never reimplements the agent loop.
- 🛡️ **One control layer.** The Gateway governs *every* model call: routing, firewall, PII/DLP, budgets, evals, audit.
- 🏠 **Local-first, no key.** First run pulls a fully-local stack (llama.cpp + Gemma 4, nomic embeddings, whisper). Encrypted by default, no telemetry.
- 🔁 **BYO everything.** Agent, key, model. Every default (model, embedder, reranker, engine, RAG strategy, sandbox) swaps via one registry.
- 📦 **Two static binaries.** `ryu-core` and `ryu-gateway` are the whole self-hostable stack. No database, no cloud.
- 🧩 **Standards-native.** MCP, ACP, and Agent Skills are first-class. Point any OpenAI-compatible client at the Gateway.

> **This repository is the open-source core of Ryu**: the orchestration engine, the LLM gateway, the CLI, and the developer SDK.
>
> It's everything you need to self-host Ryu or build on it. The desktop, web, and mobile apps are proprietary and developed separately, so they aren't here.
>
> **The apps are thin GUIs over this open engine.** Everything that touches your data or makes a decision lives here and is auditable: orchestration (Core), model governance (Gateway), and on-device capture (the open [Shadow](https://github.com/amajorai/shadow) sidecar). The desktop just talks to `ryu-core` over local HTTP and renders the result.

## Download

Most people want the **[desktop app](https://github.com/amajorai/ryu/releases/latest)**: install, pick an agent, go.

Every release ships on a [single page](https://github.com/amajorai/ryu/releases/latest) with desktop installers for macOS, Windows, and Linux, the headless binaries, and the Island companion.

For the wider ecosystem, see **[Awesome Ryu](https://github.com/amajorai/awesome-ryu)**.

## How it fits together

Two Rust services are the whole self-hostable stack, with no database and no cloud.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/architecture-dark.svg">
  <img alt="Ryu architecture: any surface routes through the Gateway, into Core, out to any engine, and back" src=".github/architecture-light.svg" width="100%">
</picture>

**Core** runs your agents. **Gateway** governs every model call. Core never enforces policy itself; it hands each call to the Gateway. That split is the whole idea: Core decides *what runs*, the Gateway decides *what's allowed*.

## What's here

| Unit | License | What it is |
|---|---|---|
| [`apps/core`](./apps/core) | Apache-2.0 | Orchestration engine, the local backend (`:7980`) |
| [`apps/gateway`](./apps/gateway) | AGPL-3.0 | The control layer: routing, firewall, cache, evals, audit (`:7981`) |
| [`apps/cli`](./apps/cli) | Apache-2.0 | Terminal client for Core |
| [`apps/fumadocs`](./apps/fumadocs) | Apache-2.0 | Documentation site with interactive OpenAPI |
| [`packages/sdk`](./packages/sdk) · [`create-ryu-app`](./packages/create-ryu-app) | Apache-2.0 | Developer SDK and project scaffolder |
| [`packages/client`](./packages/client) | Apache-2.0 | Typed Core API client |
| [`crates/ryu-sdk{,-ffi,-napi}`](./crates) | Apache-2.0 | SDK kernel plus FFI and Node-API bindings |
| [`crates/ghost-core`](./crates/ghost-core) | Apache-2.0 | Automation primitives Core builds on |

Most of Ryu is **Apache-2.0**. The **Gateway is AGPL-3.0**: it's the layer teams adopt and Ryu runs as a service, so copyleft keeps it open while requiring hosted forks to share their changes.

All of it is OSI-approved open source. This is open-core, not source-available. See [`docs/open-core.md`](./docs/open-core.md) and each unit's `LICENSE`.

Three siblings live in their own repositories: the desktop-automation server **[Ghost](https://github.com/amajorai/ghost)**, the capture sidecar **[Shadow](https://github.com/amajorai/shadow)**, and the **[Raycast extension](https://github.com/amajorai/ryu-raycast)**.

## Quick start (self-host)

```bash
cd apps/core    && cargo build --release   # ryu-core    :7980
cd apps/gateway && cargo build --release   # ryu-gateway :7981
```

Point any OpenAI-compatible client at the Gateway's `/v1/chat/completions`.

On first run, Ryu downloads a fully-local stack (llama.cpp with Gemma 4 for chat, nomic embeddings, whisper for speech), so it works with **no API key**.

Swap any piece later: model, embedder, engine, and RAG strategy are all config.

The TypeScript units (SDK, docs) use [Bun](https://bun.sh):

```bash
bun install && bun run build
```

## Dual-use & consent

Ghost (screen perception and synthetic input) and Shadow (screen and audio capture) are dual-use, exactly the capabilities malware wants.

They're open-sourced for auditability and, inside Ryu, run only behind explicit user consent. If you embed them, gate them behind clear consent and treat them as high-trust dependencies. See each repository's `SECURITY.md`.

## Contributing & security

Contributions are welcome. See each unit's `CONTRIBUTING.md` for standalone build steps, and `SECURITY.md` for private vulnerability reporting (or email `security@ryuhq.com`).

## License

Open-core: Apache-2.0 for most units, AGPL-3.0 for `apps/gateway`. Each subdirectory carries its own `LICENSE`. © 2026 A Major Pte. Ltd.
