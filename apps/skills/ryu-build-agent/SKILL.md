---
name: ryu-build-agent
description: Create and configure an agent on a Ryu node via Core's /api/agents REST surface. Covers listing, reading, creating, updating, and deleting agents, the full record schema (system prompt, engine, model, tools, skills allowlist, orchestrator and agent-creation toggles), and inspecting an agent's reachable tools. Use when a user wants a custom agent on their Ryu node.
---

# Build a Ryu agent

This skill configures agents on a Ryu node through Core's agent API. If Ryu is not running, do [[setup-ryu]] first. To list agents quickly over MCP, use `ryu_list_agents` from [[ryu-mcp]]; agent creation and editing go through the HTTP routes below.

Base URL is the Core node, default `http://127.0.0.1:7980`.

## Endpoints

- `GET /api/agents` - list agents (lightweight summaries).
- `GET /api/agents/:id` - read one full agent record.
- `POST /api/agents` - create an agent. Returns the new record.
- `PUT /api/agents/:id` - update an agent.
- `DELETE /api/agents/:id` - delete an agent.
- `GET /api/agents/:id/tools` - the observed plus MCP tools that agent can reach.
- `GET /api/agents/:id/export` - export a portable template.
- `POST /api/agents/import` - import a template, returns the created agent.

## Record schema

The create/update body uses snake_case fields. The meaningful ones:

- `name` - display name. Required.
- `description` - what the agent is for. Nullable.
- `system_prompt` - the agent's instructions. Nullable.
- `engine` - inference engine label, or null to derive from the model.
- `model` - model id the agent runs on, or null for the node default.
- `tools` - array of tool ids the agent may call.
- `skills` - skill id allowlist. Empty means all enabled skills; non-empty restricts to exactly those.
- `composio_actions` - Composio action names this agent may call (gateway-route only).
- `can_create_agents` - whether this agent may mint new agents. `null` uses the default, which is off (privileged, opt-in).
- `orchestrator` - whether this agent may discover peers and delegate. `null` uses the default, which is on.
- `inference` - optional per-agent sampling defaults (advanced settings).
- `version` - semver string. Omitting it on create defaults to `1.0.0`.

Read-only fields Core returns: `id`, `built_in`, `locked` (a locked agent cannot be edited via the API), `created_at`, `updated_at`.

## Create an agent

```sh
curl -s -X POST http://127.0.0.1:7980/api/agents \
  -H 'content-type: application/json' \
  -d '{
    "name": "Researcher",
    "description": "Reads Spaces and answers with citations.",
    "system_prompt": "You are a careful research assistant. Cite sources.",
    "engine": null,
    "model": null,
    "tools": ["ryu_search_retrieval"],
    "skills": []
  }'
```

## Update an agent

Fetch the record with `GET /api/agents/:id`, change fields, then `PUT` it back. Omitting `can_create_agents` or `orchestrator` leaves them unchanged; sending `null` clears each to its default.

```sh
curl -s -X PUT http://127.0.0.1:7980/api/agents/<id> \
  -H 'content-type: application/json' \
  -d '{ "name": "Researcher", "description": "Now with web access.", "system_prompt": "...", "engine": null, "model": null, "tools": ["ryu_search_retrieval", "web_search"], "skills": [] }'
```

## Inspect reachable tools

```sh
curl -s http://127.0.0.1:7980/api/agents/<id>/tools
```

This returns the observed plus MCP tools the agent can actually reach, which is the allowlist Core enforces when something calls `ryu_call_mcp_tool` with this agent's id.

## Tips

- Keep `system_prompt` focused and the `tools` list minimal; add tools only as the agent needs them.
- Use `skills` to scope an agent to a subset of installed skills.
- A `locked` or `built_in` agent cannot be edited; clone it via export/import to customize.
