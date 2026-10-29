---
name: setup-ryu
description: Get the user's Ryu Core node running and serving a local model so this plugin's ryu_* tools work. Covers what Ryu is, launching Core or the desktop app, verifying health on 127.0.0.1:7980, and activating a local model. The plugin already wires the MCP bridge, so this skips manual MCP config. Use when ryu_health fails or the user asks to install, start, or connect to Ryu.
---

# Set up Ryu (plugin edition)

This plugin already wires the Ryu MCP bridge into Codex, so you do not configure MCP servers by hand. Your job is to make sure the node this plugin points at is running and serving a model. Work top to bottom and do not skip the health check.

## What Ryu is

Ryu is a local-first AI node on the user's own machine. Two pieces matter here:

- Core - the brain and HTTP API on `http://127.0.0.1:7980`. Owns the model catalog, agents, workflows, RAG Spaces, MCP registry, and chat. Every `ryu_*` tool in this plugin talks to Core.
- Gateway - the OpenAI-compatible inference gateway on `http://127.0.0.1:7981`. Serves the active local model and meters usage.

The desktop app boots both. A headless user can run just Core.

## Step 1 - make sure Core is up

- Desktop: have the user install and open the Ryu desktop app. It starts Core and Gateway automatically.
- Headless from the repo: Core is a Rust binary under `apps/core`; run it with the project's standard run command. It binds `:7980`.

The bridge reads its target from `RYU_CORE_URL` (default `http://127.0.0.1:7980`). Codex forwards `RYU_CORE_URL` and `RYU_CORE_TOKEN` from the environment Codex was started in (the plugin's `.mcp.json` lists them under `env_vars`), so set them in that shell, then restart Codex. Leave `RYU_CORE_TOKEN` unset for a local loopback node: the bridge reads that node's local token itself. A remote node needs its own token.

## Step 2 - verify health (do not skip)

Call the `ryu_health` tool. A healthy node returns `{"status":"ok"}`. If it errors, Core is not reachable: recheck Step 1 and confirm `RYU_CORE_URL` in the environment Codex was started from matches where Core is actually listening. Then call `ryu_system_status` for engine and sidecar state.

## Step 3 - activate a local model

If `ryu_get_active_model` shows nothing serving, help the user pick one:

1. `ryu_search_models` with a query (for example `qwen3`) to browse the catalog.
2. Install a specific GGUF from the Ryu desktop model store, or via the models REST surface (see the `ryu-local-model` skill).
3. `ryu_set_active_model` with the installed model id, then `ryu_get_active_model` to confirm.

## Step 4 - confirm the loop

Call `ryu_health`, then `ryu_get_active_model`. If both succeed, the plugin is fully wired to a live node and every other `ryu_*` tool will work.

## Where to go next

- Full tool reference and driving patterns: [[ryu-tools]]
