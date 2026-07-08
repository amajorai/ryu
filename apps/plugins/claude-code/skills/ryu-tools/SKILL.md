---
name: ryu-tools
description: Reference for the ryu_* MCP tools this plugin exposes and how to combine them to drive a Ryu node. Covers node health, models and engines, agents and teams, skills, workflows, the MCP bridge, RAG retrieval, and one-shot ask. Use when deciding which Ryu tool to call or how to chain them for a task.
---

# Driving Ryu through the ryu_* tools

This plugin bundles an MCP bridge to one Ryu Core node. Every tool below is namespaced `ryu_` and maps to a typed Core API call. `tools/list` reflects the live set - trust it for exact names and argument shapes over this summary. All tools are read-only except `ryu_set_active_model`, `ryu_install_skill`, and `ryu_run_workflow`.

## Health and system

- `ryu_health` - is the node alive. Call this first when anything fails.
- `ryu_system_status` - active engine, engine running state, sidecars, gateway reachability, mesh.
- `ryu_system_info` - hardware snapshot: CPU, RAM, disk, GPU/VRAM, OS.

## Models and engines

- `ryu_search_models` `{ query, limit? }` - search the catalog (Hugging Face GGUF by default).
- `ryu_get_active_model` - what the local chat stack is serving now.
- `ryu_set_active_model` `{ modelId, engine? }` - switch the served model. It must already be installed; the engine is usually derived from the model format.
- `ryu_list_engines` - inference engines and their installed models.

## Agents and teams

- `ryu_list_agents` - agents configured on the node.
- `ryu_list_teams` - multi-agent teams.

`agentId` values from `ryu_list_agents` are what `ryu_call_mcp_tool` needs, because Core ties each MCP tool allowlist to a registered agent.

## Skills

- `ryu_list_skills` - installed skills and their active state.
- `ryu_search_skills` `{ query, limit? }` - search the skills directory.
- `ryu_install_skill` `{ id }` - install a skill by catalog id and hot-reload Core's registry.

## Workflows

- `ryu_list_workflows` - defined workflows.
- `ryu_run_workflow` `{ id, input? }` - run one by id. It can return `awaiting_input`; surface exactly what it is waiting on.

## MCP bridge (reach any registered server)

- `ryu_list_mcp_servers` - MCP servers Ryu has registered.
- `ryu_call_mcp_tool` `{ tool, server?, agentId, args? }` - invoke a tool on any registered MCP server. `tool` may be fully qualified `server__tool` or a bare name plus `server`. `agentId` is required. This is how you reach Ghost, Shadow, Composio, and every other server Ryu governs, through one call.

## Knowledge and memory (RAG)

- `ryu_list_spaces` - knowledge Spaces (document collections).
- `ryu_search_space` `{ spaceId, query, limit? }` - semantic search inside one Space.
- `ryu_search_retrieval` `{ query, topK? }` - unified search over memory plus all Spaces.

## One-shot ask

- `ryu_ask` `{ question, conversationId? }` - ask Ryu's side-question model one question with no tool access. Fast and self-contained. Not an agent run; for that, inspect `ryu_list_agents` or run a workflow.

## Common chains

- Bring a node online: `ryu_health` then `ryu_get_active_model`, and if empty, `ryu_search_models` then `ryu_set_active_model`.
- Answer from the user's own knowledge: `ryu_search_retrieval`, then cite the hits.
- Use a governed external tool: `ryu_list_agents` for an `agentId`, `ryu_list_mcp_servers` for the server, then `ryu_call_mcp_tool`.

See [[setup-ryu]] to get a node running in the first place.
