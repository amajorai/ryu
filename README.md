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
  <a href="https://docs.ryuhq.com">Docs</a> ·
  <a href="https://ryuhq.com/download">Download</a> ·
  <a href="https://ryuhq.com/discord">Discord</a>
</p>

## What it is

Ryu is a platform for building, running, and governing AI agents. It provides the layer
around an agent: tools, memory, workflows, model access, permissions, and delivery through
apps, plugins, APIs, and clients.

Most teams rebuild these parts for every agent. Ryu gives them one shared layer. Keep the
agent or model you already use, then add the capabilities you need.

## Why it is different

- **One layer above agents and models.** Connect Claude Code, Codex, Pi, OpenClaw, or
  another ACP or OpenAI-compatible agent. Use local models, hosted models, or both.
- **Clear control points.** Core runs agents, workflows, tools, and plugins. Gateway
  controls model calls, routing, firewall rules, budgets, approvals, and audit history.
- **Swappable parts.** Replace models, engines, memory, retrieval, sandboxes, and
  integrations without rebuilding the product around them.
- **One system across surfaces.** Run the same work through the CLI, Desktop, Web, bots,
  SDKs, or an API.

## How Ryu compares

Ryu sits at the control-plane and runtime layer around an agent. The matrices separate agent
frameworks and local runtimes from managed agent products. They describe documented product
surfaces, not model quality, latency, price, or security certification.

Legend: ✅ first-class documented capability · 🟡 available through composition, configuration, or
a limited/preview surface · ❌ not the product's primary documented surface.

### Agent frameworks and local runtimes

| Capability | [Ryu](https://github.com/amajorai/ryu) | [Mastra](https://mastra.ai/ai-agents) | [LangChain / LangGraph](https://www.langchain.com/) | [OpenClaw](https://github.com/openclaw/openclaw) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [Omnigent](https://github.com/omnigent-ai/omnigent) |
| --- | --- | --- | --- | --- | --- | --- |
| Use an existing agent or harness | ✅ | ❌ | ❌ | ❌ | 🟡 | ✅ |
| BYO models and providers | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Local or self-hosted runtime | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Managed hosting | ✅ | 🟡 | ✅ | ❌ | 🟡 | 🟡 |
| Multi-agent coordination | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Durable workflows and triggers | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Tools and MCP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Memory and retrieval | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 |
| Routing, budgets, approvals, and audit | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| Sandboxed execution | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ✅ |
| Background schedules | ✅ | ✅ | 🟡 | ✅ | ✅ | 🟡 |
| CLI, app, and channel delivery | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ |
| Skills, plugins, and integrations | ✅ | 🟡 | ✅ | ✅ | ✅ | 🟡 |

### Managed agent products and cloud platforms

| Capability | [Ryu](https://github.com/amajorai/ryu) | [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) | [Notion Custom Agents](https://www.notion.com/help/custom-agents) | [Grok Bot](https://x.ai/bot) | [Hyperagent](https://www.hyperagent.com/docs/get-started) | [ChatGPT Workspace Agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business) | [Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/agents/overview) | [Vertex AI Agent Engine](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Use an existing agent or harness | ✅ | 🟡 | ❌ | ❌ | 🟡 | ❌ | ✅ | ✅ |
| BYO models and providers | ✅ | ❌ | 🟡 | ❌ | 🟡 | 🟡 | 🟡 | 🟡 |
| Local or self-hosted runtime | ✅ | 🟡 | ❌ | ❌ | ❌ | ❌ | 🟡 | 🟡 |
| Managed hosting | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-agent coordination | ✅ | ✅ | 🟡 | 🟡 | ✅ | 🟡 | ✅ | ✅ |
| Tools and MCP | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | 🟡 |
| Memory and retrieval | ✅ | ✅ | ✅ | ❌ | ✅ | 🟡 | 🟡 | ✅ |
| Routing, budgets, approvals, and audit | ✅ | 🟡 | ✅ | 🟡 | ✅ | 🟡 | ✅ | 🟡 |
| Sandboxed execution | ✅ | ✅ | ❌ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 |
| Background schedules and triggers | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 |
| CLI, app, and channel delivery | ✅ | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 |
| Skills, plugins, and integrations | ✅ | ✅ | ✅ | 🟡 | ✅ | ✅ | ✅ | 🟡 |

## What it offers

- Agents, workflows, and teams for repeatable work.
- Plugins, MCP servers, and skills for tools and knowledge.
- Apps and a marketplace for packaging workflows for other people.
- Routing and governance for model choice, permissions, spend, and audit.
- Local-first operation with self-hosted Core and Gateway, plus cloud options.

## What you get

Ryu helps you move from an agent demo to repeatable work without rebuilding the stack for
each job. Start with a working agent instead of a blank project. Keep the model subscriptions
and tools you already use. Add capabilities without custom glue. Turn a useful workflow into
an app. Give each run the controls and history needed for real work.

## What's here

This repository is the read-only public mirror of Ryu's open-core stack:

- Open-source Core, Gateway, CLI/TUI clients, SDKs, and capability crates.
- Source-available Desktop, Island, and shared UI packages.
- Build, deploy, and GitHub Action files for the self-hosted stack.

The Web, server, mobile, browser-extension, identity, and billing surfaces are not in this
repository. The full product and feature documentation lives at
[docs.ryuhq.com](https://docs.ryuhq.com).

## Quick start

### Install a self-hosted node

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

Contributions to the open-source units are welcome. Start with the
[contribution guide](./.github/CONTRIBUTING.md), and report security issues through
[SECURITY.md](./.github/SECURITY.md).
