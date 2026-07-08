# Ryu plugins for coding agents

Installable plugins that put a running **Ryu Core** node inside two coding agents:

- [`claude-code/`](./claude-code) - a [Claude Code plugin](https://code.claude.com/docs/en/plugins-reference)
- [`codex/`](./codex) - a [Codex plugin](https://developers.openai.com/codex/plugins)

Both wrap the same three ingredients Ryu already ships, so there is no new backend:

1. The **MCP bridge** at [`apps/mcp`](../mcp) - a stdio server that turns the Core HTTP API into ~20 `ryu_*` tools. Each plugin's `.mcp.json` launches it, so the tools appear the moment the plugin is enabled.
2. **Skills** - `setup-ryu` and `ryu-tools`, adapted from [`apps/skills`](../skills) for the plugin context (the MCP wiring step is gone because the plugin does it).
3. **Command flows** - Claude Code slash commands (`/ryu:status`, `/ryu:models`, `/ryu:ask`, `/ryu:workflow`, `/ryu:retrieval`); Codex surfaces the same flows through its skills and `defaultPrompt` suggestions.

```
external agent (Claude Code / Codex)
      -> ryu MCP bridge (apps/mcp, stdio)
      -> Ryu Core (:7980)
      -> local models / agents / skills / workflows / RAG / any registered MCP server
```

## What you get

Once enabled, the agent can drive the user's node with tools like `ryu_health`, `ryu_search_models`, `ryu_set_active_model`, `ryu_list_agents`, `ryu_run_workflow`, `ryu_search_retrieval`, `ryu_ask`, and `ryu_call_mcp_tool` (the bridge to any MCP server Ryu governs). Full list in each plugin's `ryu-tools` skill and in [`apps/mcp/README.md`](../mcp/README.md).

## Requirements

- **Bun** on PATH (the bridge runs under `bun`).
- A reachable Ryu Core node. Local desktop or headless Core listens on `http://127.0.0.1:7980`.
- The plugins launch the bridge from this repo (`apps/mcp/src/index.ts`), so run the agent **from the ryu repo root**. To use the plugins from another project, see [Out of repo](#out-of-repo).

## Install: Claude Code

The marketplace manifest lives at [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json).

```sh
# from the ryu repo root
claude plugin marketplace add ./apps/plugins
claude plugin install ryu@ryu
```

Claude Code prompts for two plugin options on enable:

- `ryu_core_url` - defaults to `http://127.0.0.1:7980`.
- `ryu_core_token` - optional node-admittance bearer (sensitive). Leave blank for a local loopback node.

Then, in a session started from the repo root:

```
/ryu:status
/ryu:models qwen3 coder
/ryu:ask what models are installed?
```

## Install: Codex

The marketplace manifest lives at the Codex-canonical [`.agents/plugins/marketplace.json`](../../.agents/plugins/marketplace.json) (repo root).

```sh
# from the ryu repo root - registers the repo-local marketplace
codex plugin marketplace add ./.agents/plugins
codex plugin install ryu
```

Toggle it off any time with `enabled = false` under the plugin in `~/.codex/config.toml`. The target node is set by `RYU_CORE_URL` / `RYU_CORE_TOKEN` in [`codex/.mcp.json`](./codex/.mcp.json).

## Out of repo

Both plugins launch the local `apps/mcp` bridge, which depends on this monorepo's `@ryuhq/core-client` workspace package. To run the plugins from an arbitrary project, point the launch command at a full path to your ryu checkout:

- **Claude Code**: edit `claude-code/.mcp.json` and replace `${CLAUDE_PROJECT_DIR}/apps/mcp/src/index.ts` with an absolute path to `apps/mcp/src/index.ts`.
- **Codex**: edit `codex/.mcp.json` and replace `apps/mcp/src/index.ts` with the absolute path.

The clean long-term fix is to publish the bridge as a standalone package (`@ryuhq/mcp`, with `@ryuhq/core-client` bundled) and launch it with `bunx @ryuhq/mcp` - then neither plugin needs the repo on disk. That is the one packaging task tracked as a follow-up; the plugins are structured so only the two `.mcp.json` launch lines change.

## Layout

```
apps/plugins/
  .claude-plugin/marketplace.json   Claude Code marketplace (lists the ryu plugin)
  claude-code/
    .claude-plugin/plugin.json      manifest + userConfig (core url, token)
    .mcp.json                       launches apps/mcp as the "ryu" MCP server
    commands/                       /ryu:status /ryu:models /ryu:ask /ryu:workflow /ryu:retrieval
    skills/                         setup-ryu, ryu-tools
  codex/
    .codex-plugin/plugin.json       manifest + interface metadata
    .mcp.json                       launches apps/mcp as the "ryu" MCP server
    skills/                         setup-ryu, ryu-tools
  README.md
../../.agents/plugins/marketplace.json   Codex marketplace (repo root, canonical location)
```
