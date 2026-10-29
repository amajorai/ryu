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

Toggle it off any time with `enabled = false` under the plugin in `~/.codex/config.toml`.

Codex plugins have no `userConfig` prompt, and Codex starts stdio MCP servers with a minimal allow-listed environment. [`codex/.mcp.json`](./codex/.mcp.json) therefore lists `RYU_CORE_URL`, `RYU_CORE_TOKEN`, `RYU_DIR`, `RYU_PROFILE`, and `RYU_AUTH_URL` under `env_vars`, which forwards each one that is set in the shell Codex was started from. Nothing is hard-coded: unset, the bridge targets the profile's local Core (`http://127.0.0.1:7980` for a release profile) and reads that node's local token itself.

```sh
export RYU_CORE_URL=https://node.example.com   # only for a non-default node
export RYU_CORE_TOKEN=...                      # only for a node that is not local
codex
```

## Out of repo

Both plugins currently launch the bridge from this checkout: Claude Code through `${CLAUDE_PROJECT_DIR}/apps/mcp/src/index.ts`, Codex through `apps/mcp/src/index.ts` relative to the session's working directory. That keeps the contributor loop build-free (edit `apps/mcp/src`, restart the agent) and works today.

The bridge is packaged for npm as `@ryuhq/mcp` (bin `ryu-mcp`, `@ryuhq/core-client` bundled into `dist/index.js`, published by `bun run publish:npm`). Once a version is on npm (`npm view @ryuhq/mcp version`), the out-of-repo launch is `bunx @ryuhq/mcp` and neither plugin needs a checkout. Only the `command`/`args` pair of each `.mcp.json` changes:

```json
"command": "bunx",
"args": ["@ryuhq/mcp"]
```

Keep the `env` (Claude Code) and `env_vars` (Codex) blocks as they are. `npx -y @ryuhq/mcp` works the same way on hosts without Bun. Until the package is published, point the launch line at an absolute path to your checkout's `apps/mcp/src/index.ts` instead.

When the shipped launch lines switch to `bunx`, a contributor who wants the agent to run their local bridge source edits the `command`/`args` pair in their local copy of the plugin back to `bun` with `["run", "<checkout>/apps/mcp/src/index.ts"]`, or adds a separate MCP server entry with that launch line in their own agent config.

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
