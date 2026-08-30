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

Legend: ✅ first-class documented capability · ◐ available through composition, configuration, or
a limited/preview surface · — not the product's primary documented surface.

### Agent frameworks and local runtimes

| Capability | [Ryu](https://github.com/amajorai/ryu) | [Mastra](https://mastra.ai/ai-agents) | [LangChain / LangGraph](https://www.langchain.com/) | [OpenClaw](https://github.com/openclaw/openclaw) | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | [Omnigent](https://github.com/omnigent-ai/omnigent) |
| --- | --- | --- | --- | --- | --- | --- |
| Primary layer | ✅ control plane + agent runtime | TypeScript agent-app framework | agent framework + deployment platform | local multi-channel agent Gateway | self-improving agent + messaging Gateway | ✅ meta-harness around existing agents |
| Use an existing agent or harness | ✅ Claude Code, Codex, Pi, OpenClaw, Hermes, ACP | — build agent logic in the framework | — build agent logic in the framework | — integrated runtime | ◐ optional Codex runtime | ✅ Claude Code, Codex, Cursor, OpenCode, Hermes, Pi, custom agents |
| BYO models and providers | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Local or self-hosted runtime | ✅ Core + Gateway | ✅ open-source app | ✅ open-source components | ✅ | ✅ | ✅ |
| Managed hosting | ✅ Ryu Cloud | ◐ Mastra Cloud beta | ✅ LangGraph Platform | — | ◐ Hermes Cloud | ◐ managed hosts and sandboxes |
| Multi-agent coordination | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Durable workflows and triggers | ✅ | ✅ workflows and schedules | ✅ durable execution | ✅ automations | ✅ cron and webhooks | ◐ |
| Tools and MCP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Memory and retrieval | ✅ | ✅ | ✅ built-in persistence and stores | ✅ | ✅ | ◐ shared session history |
| Routing, budgets, approvals, and audit | ✅ Gateway control plane | ◐ logs, evals, and enterprise features | ◐ deployment controls and LangSmith | ◐ runtime policies and approvals | ◐ command approval and allowlists | ✅ policies, spend caps, and access control |
| Sandboxed execution | ✅ sandbox backends | ◐ deployment-dependent | ◐ deployment-dependent | ◐ optional; off by default | ◐ configured isolation and approvals | ✅ OS-level sandbox |
| Background schedules | ✅ | ✅ | ◐ | ✅ | ✅ | ◐ |
| CLI, app, and channel delivery | ✅ CLI, Desktop, Web, mobile, bots | ◐ build the host app | ◐ build the host app | ✅ messaging channels | ✅ CLI, Desktop, and messaging | ✅ terminal, Web, native, and mobile |
| Skills, plugins, and integrations | ✅ apps, plugins, skills, marketplace | ◐ tools and MCP | ✅ integrations ecosystem | ✅ skills and plugins | ✅ skills, plugins, and MCP | ◐ plugins and custom agents |
| License / delivery | mixed open-core + managed product | Apache-2.0 core + EE/cloud | MIT OSS + commercial cloud | MIT | MIT | Apache-2.0 / alpha |

### Managed agent products and cloud platforms

| Capability | [Ryu](https://github.com/amajorai/ryu) | [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) | [Notion Custom Agents](https://www.notion.com/help/custom-agents) | [Grok Bot](https://x.ai/bot) | [Hyperagent](https://www.hyperagent.com/docs/get-started) | [ChatGPT Workspace Agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business) | [Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/agents/overview) | [Vertex AI Agent Engine](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Primary layer | ✅ portable control plane + runtime | managed Claude harness + sessions | workspace automation | hosted AI teammate with its own computer | hosted agent fleet and workspace | workspace agents inside ChatGPT | managed agent service and platform | managed agent runtime + ADK |
| Use an existing agent or harness | ✅ | ◐ Claude Agent SDK / Messages migrations; not an arbitrary harness | — | — | ◐ hand work to agents through hosted MCP | — | ✅ own code, LangGraph, OpenAI Agents SDK, Anthropic Agent SDK, and more | ✅ ADK, LangChain, LangGraph, or custom templates |
| BYO models and providers | ✅ | — Claude models | ◐ model picker across supported providers | — Grok | ◐ Anthropic, OpenAI, Google, and open models | ◐ OpenAI model picker | ◐ supported Foundry catalog | ◐ Vertex-supported models |
| Local or self-hosted runtime | ✅ | ◐ self-hosted sandbox option | — | — | — | — | ◐ agent code can run elsewhere; Foundry remains managed | ◐ agent code can run elsewhere; Agent Engine remains managed |
| Managed hosting | ✅ Ryu Cloud | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-agent coordination | ✅ | ✅ | ◐ workflows, not a general multi-agent runtime | ◐ parallel Bots | ✅ delegated agents and teams | ◐ repeatable workflows | ✅ workflows and hosted agents | ✅ multi-agent templates and ADK |
| Tools and MCP | ✅ | ✅ built-in, custom, and MCP tools | ✅ tools, apps, and MCP | ◐ computer and connectors | ✅ built-in tools, integrations, and MCP | ✅ tools, apps, custom MCPs, and skills | ✅ tools, MCP, OpenAPI, and skills | ◐ tools and framework-dependent MCP |
| Memory and retrieval | ✅ | ✅ memory stores | ✅ Notion pages, databases, and connected context | — not a primary documented surface | ✅ memories, skills, and relevance search | ◐ connected apps, files, and workspace context | ◐ session state plus memory/retrieval features | ✅ sessions and Memory Bank |
| Routing, budgets, approvals, and audit | ✅ Gateway control plane | ◐ confirmations, session budgets, and event traces | ✅ access controls, activity logs, and version history | ◐ public control details are limited | ✅ budgets, team controls, activity, and approvals | ◐ workspace access controls | ✅ Entra identity, RBAC, policies, and observability | ◐ IAM, VPC-SC, logging, and monitoring |
| Sandboxed execution | ✅ sandbox backends | ✅ isolated cloud or self-hosted sandboxes | — | ◐ managed computer; isolation details vary | ◐ hosted execution environment | ◐ managed execution; details vary by tool | ◐ managed hosted-agent containers | ◐ managed runtime |
| Background schedules and triggers | ✅ | ✅ cron deployments | ✅ schedules and workspace events | ✅ routines and parallel execution | ✅ schedules, webhooks, email, and Live Mode | ✅ schedules and API triggers | ◐ workflow and event integration | ◐ application-defined triggers |
| CLI, app, and channel delivery | ✅ CLI, Desktop, Web, mobile, bots | ◐ API and CLI; delivery is built by the integrator | ✅ Notion and Slack | ✅ desktop, mobile, and more | ✅ Web, Slack, Telegram, email, and MCP | ✅ ChatGPT, Slack, and API | ◐ API, SDKs, and custom channels | ◐ SDK, API, and playground |
| Skills, plugins, and integrations | ✅ apps, plugins, skills, marketplace | ✅ skills, tools, and MCP | ✅ connected apps, tools, and custom workers | ◐ connectors | ✅ skills, integrations, and MCP | ✅ apps, skills, and custom MCPs | ✅ tool catalog and skills | ◐ frameworks, tools, and templates |
| License / delivery | mixed open-core + managed product | proprietary managed service | proprietary managed service | proprietary managed service | proprietary hosted service | proprietary managed service | proprietary Azure service | proprietary Google Cloud service |

The “Hyperagent” column refers to the hosted product documented at [hyperagent.com](https://www.hyperagent.com/),
not the separate [HyperAgent.io protocol](https://hyperagent.io/) or research projects that use the
same name. Hyperagent's public docs describe a hosted service; no local or self-hosted runtime is
listed in the sources reviewed here.

Sources checked on 2026-08-29: [Ryu](https://docs.ryuhq.com/docs/start-here/architecture/why-ryu),
[Mastra](https://mastra.ai/ai-agents),
[LangGraph Platform](https://www.langchain.com/langgraph),
[OpenClaw](https://github.com/openclaw/openclaw),
[Hermes Agent](https://hermes-agent.nousresearch.com/docs/),
[Omnigent](https://omnigent.ai/),
[Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview),
[Notion Custom Agents](https://www.notion.com/help/custom-agents),
[Grok Bot](https://x.ai/bot),
[Hyperagent](https://www.hyperagent.com/docs/get-started),
[ChatGPT Workspace Agents](https://help.openai.com/en/articles/20001143-chatgpt-workspace-agents-for-enterprise-and-business),
[Microsoft Foundry Agent Service](https://learn.microsoft.com/en-us/azure/foundry/agents/overview), and
[Vertex AI Agent Engine](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview).

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
