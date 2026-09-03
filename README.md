<p align="center">
  <a href="https://ryuhq.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/banner-dark.png" />
      <img src=".github/banner.png" alt="Ryu — Build and run AI agents without starting from scratch" width="100%" />
    </picture>
  </a>
</p>

<p align="center"><img src=".github/logo.png" width="96" alt="" /></p>
<h1 align="center">Ryu</h1>

<p align="center">
  Build and run AI agents without starting from scratch. Extend capability with plugins, or turn agents into apps.
</p>

<p align="center">
  <a href="https://github.com/amajorai/ryu/stargazers"><img src="https://shieldcn.dev/github/stars/amajorai/ryu.svg" alt="GitHub stars" /></a>&nbsp;
  <a href="https://github.com/amajorai/ryu/releases"><img src="https://shieldcn.dev/github/release/amajorai/ryu.svg" alt="Latest release" /></a>&nbsp;
  <a href="https://github.com/amajorai/ryu/actions/workflows/ci.yml"><img src="https://shieldcn.dev/github/ci/amajorai/ryu.svg?workflow=ci.yml&branch=main" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://docs.ryuhq.com"><img src="https://shieldcn.dev/badge/Docs-docs.ryuhq.com-73DC8C.svg?logo=readthedocs&logoColor=white" alt="Docs" /></a>&nbsp;
  <a href="https://ryuhq.com/download"><img src="https://shieldcn.dev/badge/Ryu-Desktop-4B78E6.svg?logo=tauri&logoColor=white" alt="Ryu Desktop" /></a>&nbsp;
  <a href="https://ryuhq.com/discord"><img src="https://shieldcn.dev/discord/1439211418724597800.svg?logo=discord&logoColor=white&color=4B78E6" alt="Discord" /></a>&nbsp;
  <a href="https://x.com/ryuhq"><img src="https://shieldcn.dev/badge/Follow-@ryuhq-FA9BFA.svg?logo=x&logoColor=white" alt="Follow @ryuhq" /></a>&nbsp;
  <a href="./LICENSING.md"><img src="https://shieldcn.dev/badge/License-Open--core-73DC8C.svg?logo=opensourceinitiative&logoColor=white" alt="Open core" /></a>
</p>

## What is Ryu?

Ryu is a platform for building, running, and governing AI agents. It provides the layer
around an agent: tools, memory, workflows, model access, permissions, and delivery through
apps, plugins, APIs, and clients.

Most teams rebuild these parts for every agent. Ryu gives them one shared layer. Keep the
agent or model you already use, then add the capabilities you need.

## Why Ryu?

Ryu is for teams that want to move from an agent demo to repeatable work without rebuilding the
stack for every job.

- **Start with what you have.** Connect Claude Code, Codex, Pi, OpenClaw, or another ACP or
  OpenAI-compatible agent. Use local models, hosted models, or both.
- **Add the missing layer.** Use agents, workflows, teams, plugins, MCP servers, skills, apps,
  and a marketplace to package repeatable work.
- **Keep control.** Route model calls and enforce permissions, budgets, approvals, firewall rules,
  durable state, and audit history.
- **Swap parts as you grow.** Replace models, engines, memory, retrieval, sandboxes, and
  integrations without rebuilding the product around them.
- **Run it where work happens.** Use the same system through the CLI, Desktop, Web, bots, SDKs,
  or an API, with self-hosted Core and Gateway or managed options.

This public repository includes the open-core runtime, Gateway, CLI/TUI clients, capability crates,
source-available Desktop, Island, the shared UI packages those surfaces need, and build/deploy files
for the self-hosted stack. The SDK authoring packages, Rust kernel SDK, foreign bindings, and SDK
examples live in the [public SDK hub](https://github.com/amajorai/ryu-sdk). Feature-app source lives
in its `ryu-<app>` satellite, while plugin source and the Marketplace catalog live in the
[Marketplace repository](https://github.com/amajorai/ryu-marketplace). The Web, server, mobile,
browser-extension, identity, and billing surfaces live outside this repository; the full product
documentation is at [docs.ryuhq.com](https://docs.ryuhq.com).

## How Ryu compares

Ryu sits at the control-plane and runtime layer around an agent. The matrices separate agent
frameworks and local runtimes from managed agent products and cloud platforms. They describe
documented product surfaces, not model quality, latency, or security certification.

Legend: ✅ first-class documented capability · 🟡 available through composition, configuration, or
a limited/preview surface · ❌ not the product's primary documented surface.

The hosted `eve`/Vercel path is usage-metered: Vercel charges for Function active CPU,
provisioned memory time, and invocations. Ryu's self-hosted path runs on infrastructure you
control. DeepSeek Harness is a developer preview built on the Cordis composability kernel, so
its runtime internals are a useful comparison point but not a maturity or model-quality claim.
See [Vercel Functions pricing](https://vercel.com/docs/functions/usage-and-pricing), [DeepSeek
Harness](https://github.com/deepseek-ai/deepseek-harness), and [Cordis](https://github.com/cordiverse/cordis).

### Agent frameworks and local runtimes

| Capability | [Ryu](https://github.com/amajorai/ryu) | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | [Mastra](https://mastra.ai/ai-agents) | [LangChain / LangGraph](https://www.langchain.com/) | [eve](https://eve.dev/) | [OpenClaw](https://github.com/openclaw/openclaw) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [Omnigent](https://github.com/omnigent-ai/omnigent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Use an existing agent or harness | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 | ✅ |
| BYO models and providers | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Local or self-hosted runtime | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Managed hosting | ✅ | ❌ | 🟡 | ✅ | 🟡 | ❌ | 🟡 | 🟡 |
| Multi-agent coordination | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Durable workflows and triggers | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Tools and MCP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Memory and retrieval | ✅ | 🟡 | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 |
| Routing, budgets, approvals, and audit | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| Sandboxed execution | ✅ | ✅ | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | ✅ |
| Background schedules | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | 🟡 |
| CLI, app, and channel delivery | ✅ | 🟡 | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ |
| Skills, plugins, and integrations | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 |

### Managed agent products and cloud platforms

| Capability | [Ryu](https://github.com/amajorai/ryu) | [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) | [Notion Custom Agents](https://www.notion.com/help/custom-agents) | [Grok Bot](https://x.ai/bot) | [Hyperagent](https://www.hyperagent.com/docs/get-started) | [Vercel AI Cloud](https://vercel.com/agents) | [ChatGPT Workspace Agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business) | [Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/agents/overview) | [Vertex AI Agent Engine](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Use an existing agent or harness | ✅ | 🟡 | ❌ | ❌ | 🟡 | 🟡 | ❌ | ✅ | ✅ |
| BYO models and providers | ✅ | ❌ | 🟡 | ❌ | 🟡 | ✅ | 🟡 | 🟡 | 🟡 |
| Local or self-hosted runtime | ✅ | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ | 🟡 | 🟡 |
| Managed hosting | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-agent coordination | ✅ | ✅ | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | ✅ | ✅ |
| Tools and MCP | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Memory and retrieval | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 | 🟡 | 🟡 | ✅ |
| Routing, budgets, approvals, and audit | ✅ | 🟡 | ✅ | 🟡 | ✅ | 🟡 | 🟡 | ✅ | 🟡 |
| Sandboxed execution | ✅ | ✅ | ❌ | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | 🟡 |
| Background schedules and triggers | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 |
| CLI, app, and channel delivery | ✅ | 🟡 | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | 🟡 |
| Skills, plugins, and integrations | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | ✅ | ✅ | 🟡 |

## Quick Start

The self-hosted path runs Core and Gateway on infrastructure you control. It does not need a Ryu
account or control-plane service.

**macOS and Linux**:

```bash
curl -fsSL https://raw.githubusercontent.com/amajorai/ryu/main/install.sh | sh
ryu-cli
```

**Windows PowerShell**:

```powershell
irm https://raw.githubusercontent.com/amajorai/ryu/main/install.ps1 | iex
ryu-cli
```

The installer starts Core and the Gateway with the bundled local defaults. Read the
[self-hosting guide](https://docs.ryuhq.com/docs/start-here/getting-started/self-host)
for providers, deployment, and configuration.

## Licensing

The open-core units are Apache-2.0, except the Gateway, which is AGPL-3.0. Desktop, Island,
and shared UI packages are source-available under
[`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md); they are not open source. See
[`LICENSING.md`](./LICENSING.md) and [`TRADEMARK.md`](./TRADEMARK.md) for the full boundary.

Ryu is pre-1.0. Interfaces, APIs, and on-disk formats may change between releases.

## Contributing

Contributions to the open-source units and source-available layer are welcome. Open a pull
request in this repository and start with the [contribution guide](./CONTRIBUTING.md). Accepted
changes are carried back into the Ryu monorepo by maintainers and included in a later sync.
Report security issues through [SECURITY.md](./.github/SECURITY.md).

For placement, use the public hub that owns the source:

- Core, Gateway, CLI, Desktop, Island, and their shared runtime dependencies: this repository.
- SDK packages, Rust SDK crates, bindings, and examples: [`amajorai/ryu-sdk`](https://github.com/amajorai/ryu-sdk).
- A feature app's backend, UI, or sidecar: its [`amajorai/ryu-<app>`](https://github.com/amajorai) satellite.
- Plugin source, catalog metadata, schemas, and icons: [`amajorai/ryu-marketplace`](https://github.com/amajorai/ryu-marketplace).

`generated/ryu-runtime/` is a mirror build input for Core's compiled-in manifests and referenced
assets. It is generated and is not an app or plugin authoring surface.
