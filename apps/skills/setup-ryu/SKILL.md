---
name: setup-ryu
description: Set up Ryu end-to-end for a user as their local-first AI node, then point their other agents at it. Covers what Ryu is, installing and launching Core/the desktop app, verifying health on 127.0.0.1:7980, downloading and activating a local model, and wiring the apps/mcp MCP server so any agent can drive the node. Use when a user asks to install, start, configure, or connect to Ryu.
---

# Set up Ryu

You are setting up Ryu for a user. Work top to bottom. Do not skip the health check before moving on, and do not fabricate endpoints - every route below is real.

## What Ryu is

Ryu is a local-first AI node that runs on the user's own machine. Three pieces matter:

- Core: the brain and HTTP API. Listens on `http://127.0.0.1:7980`. Owns the model catalog, agents, workflows, RAG Spaces, MCP registry, and chat.
- Gateway: the OpenAI-compatible inference gateway on `http://127.0.0.1:7981`. Serves the active local model and meters usage.
- Desktop app: the Tauri shell most users launch. Starting it boots Core and Gateway for them.

A user can run just Core (headless) or the full desktop app. Either way, everything an external agent needs is the Core HTTP API on `:7980`.

## Step 1 - install and launch

Prefer the desktop app for non-technical users, Core for headless or server setups.

- Desktop: install the Ryu desktop app and open it. It starts Core (`:7980`) and Gateway (`:7981`) automatically.
- Headless Core from the repo: from the monorepo run Core directly (it is a Rust binary under `apps/core`). Use the project's standard run command for `apps/core`. Core binds `:7980`.

Always use `bun` for any JavaScript-side commands in this monorepo.

## Step 2 - verify health (do not skip)

Confirm Core is reachable before anything else:

```sh
curl -s http://127.0.0.1:7980/api/health
```

A healthy node returns JSON like `{"status":"ok"}`. For a fuller picture use `GET /api/system/status` (reachability + mesh) and `GET /api/system/info` (hardware: CPU, RAM, GPU). If `/api/health` does not answer, Core is not up - go back to Step 1.

## Step 3 - download and activate a local model

The model catalog is Hugging Face GGUF by default. The engine is derived from the model format, so you usually only pick the model.

1. Search the catalog:

```sh
curl -s "http://127.0.0.1:7980/api/models/catalog?query=qwen&format=gguf&sort=trending&limit=10"
```

2. Inspect a model's quantizations and device-fit:

```sh
curl -s "http://127.0.0.1:7980/api/models/catalog/detail?id=<repo_id>&format=gguf"
```

3. Install one specific GGUF file (verified downloader):

```sh
curl -s -X POST http://127.0.0.1:7980/api/models/catalog/install \
  -H 'content-type: application/json' \
  -d '{"id":"<repo_id>","file":"<filename.gguf>","format":"gguf"}'
```

4. Activate the installed model so the local chat stack serves it:

```sh
curl -s -X POST http://127.0.0.1:7980/api/models/active \
  -H 'content-type: application/json' \
  -d '{"id":"<repo_id_or_stem>"}'
```

Read the current selection with `GET /api/models/active`. List runnable engines with `GET /api/engines`. For more depth see [[ryu-local-model]].

## Step 4 - point other agents at Ryu (the key step)

Ryu ships an MCP server at `apps/mcp` that exposes the Core API as MCP tools over stdio. Adding it lets Claude Code, Cursor, or any MCP client drive the node. It reads its target node from `RYU_CORE_URL` (default `http://127.0.0.1:7980`); set `RYU_CORE_TOKEN` if the node requires auth.

Add this to the agent's MCP config (`mcpServers`). Point the path at this repo's `apps/mcp`:

```json
{
  "mcpServers": {
    "ryu": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/apps/mcp/src/index.ts"],
      "env": {
        "RYU_CORE_URL": "http://127.0.0.1:7980"
      }
    }
  }
}
```

The package also exposes a `ryu-mcp` bin, so after `bun install` you can launch it by that name instead of the file path.

After connecting, the agent receives the canonical tool list via the MCP `tools/list` handshake - trust that list for exact names. The tools include `ryu_ask`, `ryu_list_agents`, `ryu_search_models`, `ryu_set_active_model`, `ryu_run_workflow`, `ryu_call_mcp_tool`, and `ryu_search_retrieval`. Full reference in [[ryu-mcp]].

## Step 5 - confirm the loop

Verify the agent can reach Ryu through MCP by calling `ryu_health`, then `ryu_get_active_model`. If both succeed, the user's other agents are wired to their Ryu node.

## Where to go next

- Drive the node through MCP: [[ryu-mcp]]
- Create an agent on the node: [[ryu-build-agent]]
- Manage local models and engines: [[ryu-local-model]]
- Author a new skill like this one: [[ryu-author-skill]]
