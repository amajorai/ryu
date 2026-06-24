# <img src=".github/logo.png" width="34" align="center" alt="" />&nbsp; Ryu

**Agents are powerful. Using them shouldn't be.**

[![Docs](https://shieldcn.dev/badge/Docs-ryuhq.com-73DC8C.svg?logo=readthedocs&logoColor=white)](https://ryuhq.com/help)
[![Discord](https://shieldcn.dev/discord/1439211418724597800.svg?logo=discord&logoColor=white&color=4B78E6)](https://ryuhq.com/discord)
[![X](https://shieldcn.dev/badge/Follow-@ryuhq-FA9BFA.svg?logo=x&logoColor=white)](https://twitter.com/ryuhq)
[![Open source](https://shieldcn.dev/badge/License-Apache--2.0%20%2B%20AGPL--3.0-73DC8C.svg?logo=opensourceinitiative&logoColor=white)](./docs/open-core.md)

Ryu is managed infrastructure for AI agents. It runs any engine — OpenAI, Claude Code, Pi, OpenClaw, Hermes, or any OpenAI-compatible runtime — behind one control layer that governs what each agent can reach, what it costs, and what's safe to send. Local-first, encrypted by default, no telemetry. You bring your own agent, key, and model, and nothing is hardcoded: every default is swappable.

> **This repository is the open-source core of Ryu** — the orchestration engine, the LLM gateway, the CLI, and the developer SDK. It's everything you need to self-host Ryu or build on it. The desktop, web, and mobile apps are proprietary and developed separately, so they aren't in this repo.
>
> **The apps are thin GUIs over this open engine.** Everything that touches your data or makes a decision lives here and is auditable: orchestration (Core), model governance (Gateway), and on-device capture (the open [Shadow](https://github.com/amajorai/shadow) sidecar). The desktop is a window onto Core — it talks to `ryu-core` over local HTTP and renders the result; the substance is open, the shell is just UI.

## Download

Most people want the **[desktop app](https://github.com/amajorai/ryu/releases/latest)** — install, pick an agent, go. Every download for a release lives on a [single release page](https://github.com/amajorai/ryu/releases/latest): desktop installers for macOS, Windows, and Linux, the headless binaries, and the Island companion. For the wider ecosystem, see **[Awesome Ryu](https://github.com/amajorai/awesome-ryu)**.

## How it fits together

Two Rust services are the whole self-hostable stack — no database, no cloud:

```
Desktop · Bots (Telegram/Slack/WhatsApp/Discord) · CLI · Extension · Mobile
        │
   Gateway   every model call: routing · firewall · PII/DLP · budgets · evals · audit
        │
   Core      agents · sessions · memory · tools · workflows · sub-agents · sidecars
        │
   Engines   OpenAI · Claude Code · Pi · OpenClaw · Hermes · any OpenAI-compatible
```

**Core** runs your agents. **Gateway** governs every model call. Core never enforces policy itself — it hands each call to the Gateway. That split is the whole idea: Core decides *what runs*, the Gateway decides *what's allowed*.

## What's here

| Unit | License | What it is |
|---|---|---|
| [`apps/core`](./apps/core) | Apache-2.0 | Orchestration engine — the local backend (`:7980`) |
| [`apps/gateway`](./apps/gateway) | AGPL-3.0 | The control layer: routing, firewall, cache, evals, audit (`:7981`) |
| [`apps/cli`](./apps/cli) | Apache-2.0 | Terminal client for Core |
| [`apps/fumadocs`](./apps/fumadocs) | Apache-2.0 | Documentation site with interactive OpenAPI |
| [`packages/sdk`](./packages/sdk) · [`create-ryu-app`](./packages/create-ryu-app) | Apache-2.0 | Developer SDK and project scaffolder |
| [`packages/client`](./packages/client) | Apache-2.0 | Typed Core API client |
| [`crates/ryu-sdk{,-ffi,-napi}`](./crates) | Apache-2.0 | SDK kernel plus FFI and Node-API bindings |
| [`crates/ghost-core`](./crates/ghost-core) | Apache-2.0 | Automation primitives Core builds on |

Most of Ryu is **Apache-2.0**. The **Gateway is AGPL-3.0** — it's the layer teams adopt and Ryu runs as a service, so copyleft keeps it open while requiring hosted forks to share their changes. All of it is OSI-approved open source; this is open-core, not source-available. See [`docs/open-core.md`](./docs/open-core.md) and each unit's `LICENSE`.

The desktop-automation server **[Ghost](https://github.com/amajorai/ghost)**, the capture sidecar **[Shadow](https://github.com/amajorai/shadow)**, and the **[Raycast extension](https://github.com/amajorai/ryu-raycast)** each live in their own repository.

## Quick start (self-host)

```bash
cd apps/core    && cargo build --release   # ryu-core    :7980
cd apps/gateway && cargo build --release   # ryu-gateway :7981
```

Point any OpenAI-compatible client at the Gateway's `/v1/chat/completions`. On first run Ryu downloads a fully-local stack — llama.cpp with Gemma 4 for chat, nomic embeddings, whisper for speech — so it works with no API key. Swap any piece later: model, embedder, engine, and RAG strategy are all config.

The TypeScript units (SDK, docs) use [Bun](https://bun.sh):

```bash
bun install && bun run build
```

## Dual-use & consent

Ghost (screen perception and synthetic input) and Shadow (screen and audio capture) are dual-use — exactly the capabilities malware wants. They're open-sourced for auditability and, inside Ryu, run only behind explicit user consent. If you embed them, gate them behind clear consent and treat them as high-trust dependencies. See each repository's `SECURITY.md`.

## Contributing & security

Contributions are welcome — see each unit's `CONTRIBUTING.md` for standalone build steps, and `SECURITY.md` for private vulnerability reporting (or email `security@ryuhq.com`).

## License

Open-core: Apache-2.0 for most units, AGPL-3.0 for `apps/gateway`. Each subdirectory carries its own `LICENSE`. © 2026 A Major Pte. Ltd.
