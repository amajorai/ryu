<p align="center">
  <a href="https://ryuhq.com">
    <img src=".github/banner.png" alt="Ryu — End-to-end infrastructure for AI agents" width="100%" />
  </a>
</p>

# <img src=".github/logo.png" width="50" align="center" alt="" />&nbsp; Ryu

**Agents are powerful. Using them shouldn't be.**

> [!WARNING]
> **Early access — under active development.** Ryu is pre-1.0 and moving fast. APIs, schemas, config, on-disk formats, and CLI flags can change without notice, and releases may include breaking changes between versions. Pin a version, expect rough edges, and read the release notes before upgrading. Not yet recommended for production-critical workloads.

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

<!--
  DEMO GIF SLOT — drop a ~10s screen capture of the aha moment (install → pick agent → first
  local reply, no key) at .github/demo.gif and uncomment. This is the single highest-impact
  visual on the page; keep it under ~4 MB so it autoplays on GitHub.

  <p align="center"><img src=".github/demo.gif" alt="Ryu in 10 seconds" width="100%" /></p>
-->

## How it compares

Model routers (LiteLLM, OpenRouter) route *one chat completion*. Ryu governs *whole agents* — the
tools they reach, what they cost, and what's safe to send — and runs the engine you already use.

| | **Ryu** | LiteLLM | OpenRouter | Agent CLI alone |
|---|:---:|:---:|:---:|:---:|
| Self-hostable | ✅ | ✅ | ❌ hosted | ✅ |
| Local model on install, no API key | ✅ | ⚠️ BYO Ollama | ❌ | ⚠️ varies |
| Multi-provider routing + fallback | ✅ | ✅ | ✅ | ❌ |
| Firewall + PII/DLP on egress | ✅ | ⚠️ plugins | ❌ | ❌ |
| Budgets + audit trail | ✅ | ✅ | ⚠️ credits | ❌ |
| Governs **agents**, not just completions | ✅ | ❌ | ❌ | — |
| Wraps an existing agent (Claude Code, Codex, …) | ✅ | ❌ | ❌ | — |
| Install-and-go desktop app | ✅ | ❌ | ❌ | ❌ |
| No provider lock-in | ✅ | ✅ | ⚠️ | ❌ |

<sub>✅ built · ⚠️ partial / BYO · ❌ not offered. Honest as of the current release — corrections
via PR welcome. The desktop app is proprietary but is a thin GUI over this open core.</sub>

> **This repository is the open-source core of Ryu**: the orchestration engine, the LLM gateway, the CLI, and the developer SDK.
>
> It's everything you need to self-host Ryu or build on it. The desktop, web, and mobile apps are proprietary and developed separately, so they aren't here.
>
> **The apps are thin GUIs over this open engine.** Everything that touches your data or makes a decision lives here and is auditable: orchestration (Core), model governance (Gateway), and on-device capture (the open [Shadow](https://github.com/amajorai/shadow) sidecar). The desktop just talks to `ryu-core` over local HTTP and renders the result.

## Download

Most people want the **[desktop app](https://github.com/amajorai/ryu/releases/latest)**: install, pick an agent, go.

Every release ships on a [single page](https://github.com/amajorai/ryu/releases/latest) with desktop installers for macOS, Windows, and Linux, the headless binaries, and the Island companion.

For the wider ecosystem, see **[Awesome Ryu](https://github.com/amajorai/awesome-ryu)**.

## Backed by

Ryu is built with the support of leading startup programs.

<p align="center">
  <a href="https://aws.amazon.com/startups/" target="_blank" rel="noopener"><img alt="AWS Activate" height="34" src=".github/backers/aws.svg" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://block71.co" target="_blank" rel="noopener"><img alt="BLOCK71" height="34" src=".github/backers/block71.png" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.anthropic.com/startups" target="_blank" rel="noopener"><img alt="Claude for Startups" height="34" src=".github/backers/claude.svg" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://openai.com/startups" target="_blank" rel="noopener"><img alt="OpenAI for Startups" height="34" src=".github/backers/openai.svg" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.cloudflare.com/forstartups/" target="_blank" rel="noopener"><img alt="Cloudflare for Startups" height="34" src=".github/backers/cloudflare.svg" /></a>
</p>

<p align="center">
  <sub>AWS Activate&nbsp; · &nbsp;BLOCK71&nbsp; · &nbsp;Claude for Startups&nbsp; · &nbsp;OpenAI for Startups&nbsp; · &nbsp;Cloudflare for Startups</sub>
</p>

## How it fits together

Two Rust services are the whole self-hostable stack, with no database and no cloud.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/architecture-dark.svg">
  <img alt="Ryu architecture: any surface routes through the Gateway, into Core, out to any engine, and back" src=".github/architecture-light.svg" width="100%">
</picture>

**Core** runs your agents. **Gateway** governs every model call. Core never enforces policy itself; it hands each call to the Gateway. That split is the whole idea: Core decides *what runs*, the Gateway decides *what's allowed*.

## Footprint

<!-- BENCH:ROOT:START (generated by scripts/benchmark.mjs, do not edit by hand) -->

Ryu's self-hostable stack is two small static Rust binaries (`ryu-core` + `ryu-gateway`), plus the CLI:
no interpreter, no runtime, no Electron, no Docker. Every number below is emitted by
[`scripts/benchmark.mjs`](./scripts/benchmark.mjs); reproduce it with `node scripts/benchmark.mjs --build --runtime`.

| Component | Release binary | Crates | Source (LOC) | Idle RSS | Idle CPU |
| --- | --- | --- | --- | --- | --- |
| [`apps/core`](./apps/core) | 44.2 MB | 687 | 105,168 | n/a | n/a |
| [`apps/gateway`](./apps/gateway) | 18.7 MB | 405 | 20,658 | 17.0 MB | 0.0% |
| [`apps/cli`](./apps/cli) | 5.9 MB | 235 | 10,497 | n/a | n/a |

_Idle RSS and CPU are sampled only for the Gateway (a stateless proxy with a clean idle), and idle CPU is effectively nil. Core boots a full local stack on first run and the CLI is short-lived, so they report size/deps/LOC. Measured on `win32`._

<!-- BENCH:ROOT:END -->

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

### One-click deploy

Stand up a hosted node (Core + Gateway) on a container host. Each builds the
[`Dockerfile`](./Dockerfile): Core runs the stack and manages the Gateway on
loopback, so only Core's port is published.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/amajorai/ryu)
&nbsp;
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new)
&nbsp;
[![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/amajorai/ryu/tree/main)

Or run it yourself:

- **Docker Compose** — `docker compose up --build` ([`docker-compose.yml`](./docker-compose.yml)): Core on `:7980`, Gateway on `:7981`, model state in a named volume.
- **Fly.io** — `fly launch --copy-config` then `fly deploy` ([`fly.toml`](./fly.toml)).

> **Sizing.** Core downloads a fully-local model stack on first boot, so pick a
> plan with **≥ 2 GB RAM** (4 GB is comfortable), or set a provider key such as
> `OPENAI_API_KEY` to skip the local download and run small.
>
> **License.** The Gateway is **AGPL-3.0**: host a *modified* Gateway and §13
> obliges you to offer those changes to its users. Core is Apache-2.0.

The documentation site (`apps/fumadocs`) is a Next.js app and deploys to Vercel
in one click — [![Deploy docs to Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/amajorai/ryu&root-directory=apps/fumadocs&project-name=ryu-docs). Vercel is serverless and cannot host the long-running Core/Gateway; use a container host above for the backend.

## Dual-use & consent

Ghost (screen perception and synthetic input) and Shadow (screen and audio capture) are dual-use, exactly the capabilities malware wants.

They're open-sourced for auditability and, inside Ryu, run only behind explicit user consent. If you embed them, gate them behind clear consent and treat them as high-trust dependencies. See each repository's `SECURITY.md`.

## Contributing & security

Contributions are welcome — start with [`CONTRIBUTING.md`](./.github/CONTRIBUTING.md) (it explains
the one-way mirror this repo runs on) and the [Code of Conduct](./.github/CODE_OF_CONDUCT.md).
Questions and ideas go to [Discord](https://ryuhq.com/discord) or
[Discussions](https://github.com/amajorai/ryu/discussions).

Report vulnerabilities privately per [`SECURITY.md`](./.github/SECURITY.md) — email
`security@ryuhq.com`, never a public issue.

## License

Open-core: Apache-2.0 for most units, AGPL-3.0 for `apps/gateway`. Each subdirectory carries its own `LICENSE`. © 2026 A Major Pte. Ltd.
