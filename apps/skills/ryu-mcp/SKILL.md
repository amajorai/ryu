---
name: ryu-mcp
description: Drive a Ryu node through the apps/mcp MCP server. Covers configuring the stdio server with RYU_CORE_URL, the tools/list handshake, and every Ryu tool (ask Ryu, list/activate models, list agents and teams, run workflows, bridge to registered MCP servers, search RAG Spaces and skills). Use when an agent should operate a Ryu node over MCP rather than raw HTTP.
---

# Ryu over MCP

This skill teaches an agent to operate a Ryu node through `apps/mcp`, the MCP server that wraps Ryu Core's HTTP API. If Ryu is not installed yet, do [[setup-ryu]] first.

## Configure the server

`apps/mcp` is a stdio MCP server (name `ryu-mcp`). It builds a single target node from the environment:

- `RYU_CORE_URL` - base URL of the Core node. Default `http://127.0.0.1:7980`.
- `RYU_CORE_TOKEN` - bearer token, only if the node requires auth.

Add it to the agent's `mcpServers` config:

```json
{
  "mcpServers": {
    "ryu": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/apps/mcp/src/index.ts"],
      "env": { "RYU_CORE_URL": "http://127.0.0.1:7980" }
    }
  }
}
```

After `bun install` you can use the `ryu-mcp` bin instead of the file path. On connect, the client receives the canonical tool list via `tools/list` - that handshake is the source of truth for exact names and argument schemas.

## Sign in (optional)

`ryu-mcp` signs in with the same OAuth 2.0 Device Authorization Grant the desktop, mobile, and CLI clients use, through Core's proxy. Run the subcommands directly (not the stdio server):

```bash
ryu-mcp login     # opens the browser, polls Core, stores the bearer in ~/.ryu/auth.json
ryu-mcp whoami    # prints the signed-in user
ryu-mcp logout    # clears the credential
```

`~/.ryu/auth.json` is shared with the desktop and CLI, so one sign-in covers them all (single sign-on). The third env var, `RYU_AUTH_URL` (default `http://localhost:3000`), points at the control plane and is only used by these subcommands and `ryu_whoami`. Sign-in identifies the user to the control plane; it does not change what the node tools can do (those still use `RYU_CORE_TOKEN`).

## Tools

Health and system:

- `ryu_health` - probe whether the node is alive (`GET /api/health`). No args.
- `ryu_system_info` - hardware snapshot (CPU, RAM, GPU). No args.
- `ryu_system_status` - reachability plus mesh status. No args.

Agents and teams:

- `ryu_list_agents` - list the agents configured on the node. No args. To create or edit agents, see [[ryu-build-agent]].
- `ryu_list_teams` - list multi-agent teams. No args.

Models and engines:

- `ryu_search_models` - search the catalog (HF GGUF by default). Args - `query`, optional `limit`.
- `ryu_get_active_model` - read which installed model the local chat engine serves. No args.
- `ryu_set_active_model` - switch the served model. Args - `modelId` (local stem or HF repo id, must already be installed), optional `engine` to override the format-derived engine.
- `ryu_list_engines` - list runnable inference engines. No args. More in [[ryu-local-model]].

Skills directory:

- `ryu_list_skills` - list skills available on the node. No args.
- `ryu_search_skills` - search/browse the skills directory. Args - `query`.
- `ryu_install_skill` - install a skill by catalog id. Args - `id`.

Workflows:

- `ryu_list_workflows` - list workflows defined on the node. No args.
- `ryu_run_workflow` - run a workflow. Args - `id`, optional `input` (string map).

MCP bridge:

- `ryu_list_mcp_servers` - list MCP servers Ryu has registered. No args.
- `ryu_call_mcp_tool` - invoke a tool on any MCP server Ryu has registered. Args - `tool` (fully-qualified `server__tool`, or a bare name plus `server`), `agentId` (required - Core ties the per-agent tool allowlist to a registered agent, so an empty or unknown agent is denied), optional `args` object. This is how you reach Ghost, Shadow, Spider, and other registered tools through one node.

Spaces and retrieval (RAG):

- `ryu_list_spaces` - list knowledge Spaces (document collections). No args.
- `ryu_search_space` - search one Space. Args - `spaceId`, `query`.
- `ryu_search_retrieval` - unified search across memory and all Spaces, returning scored chunks. Args - `query`, optional `topK`.

Ask Ryu:

- `ryu_ask` - ask Ryu a question and get one synchronous answer (`POST /api/btw`). Routes to the node's configured side-question model with no tool access. Args - `question`, optional `conversationId` to ground the answer in an existing conversation; omit it for an ephemeral context.

Identity:

- `ryu_whoami` - report the Ryu user this server is signed in as, or a prompt to run `ryu-mcp login`. No args.

## Typical flows

- First contact: `ryu_health` then `ryu_get_active_model`. If there is no active model, `ryu_search_models` then `ryu_set_active_model`.
- One-off question against the node's brain: `ryu_ask`.
- Use the node's registered tools: `ryu_list_mcp_servers`, then `ryu_call_mcp_tool` with a valid `agentId`.
- Knowledge lookup: `ryu_search_retrieval` for everything, or `ryu_search_space` to scope to one collection.

## Notes

- `ryu_set_active_model` only switches between installed models. To download a new one, install it first (see [[ryu-local-model]]).
- `ryu_call_mcp_tool` always needs a real `agentId`; the allowlist lives on the agent, not the call.
