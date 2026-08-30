# ryu-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a
running **Ryu Core** node to any MCP host (Claude Desktop, Cursor, etc.). It makes
Ryu an interface to other systems:

```
external agent -> ryu-mcp -> Ryu Core -> local models / agents / skills / registered MCP servers / RAG
```

The server speaks JSON-RPC over stdio and translates each tool call into a typed
`@ryuhq/core-client` request against one Core node.

## Configuration

Configure one Core target with these environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RYU_CORE_URL` | `http://127.0.0.1:7980` | Base URL of the Ryu Core node. |
| `RYU_CORE_TOKEN` | _(unset)_ | The target node's bearer. When omitted for a loopback URL, the bridge reads that Core's local `node-auth.token`; a remote target must be given its own token. |
| `RYU_DIR` | _(unset)_ | Core's relocated data directory; used when resolving a loopback `node-auth.token`. |
| `RYU_AUTH_URL` | `http://localhost:3000` | Control-plane (Better Auth) base URL used by `login`, `logout`, and `whoami`. |
| `RYU_HOME` | `~/.ryu` | Directory for this bridge's session unless `RYU_MCP_AUTH_FILE` is set. |
| `RYU_MCP_AUTH_FILE` | `~/.ryu/mcp-auth.json` | Explicit path for this bridge's session file. |

`tools/list` works even when Core is down (the tool definitions are static). Tool
calls require a reachable Core node.

## Authentication

`ryu-mcp` signs in with the **same OAuth 2.0 Device Authorization Grant (RFC 8628)**
the desktop, mobile, and CLI clients use, directly against the Ryu control plane:

```bash
	bun run apps/mcp/src/index.ts login     # opens the Ryu /device approval page
bun run apps/mcp/src/index.ts whoami    # prints the signed-in user
bun run apps/mcp/src/index.ts logout    # clears the credential
```

`login` calls `POST {RYU_AUTH_URL}/api/auth/device/code`, opens the Ryu `/device`
approval page, then polls `POST /api/auth/device/token` until you approve it.
The bridge stores its own session in `~/.ryu/mcp-auth.json` (or the path in
`RYU_MCP_AUTH_FILE`). The account is the same Ryu account, but the file is
intentionally separate from Desktop's encrypted `auth.bin` vault and Core's
encrypted node auth files.

The stored credential is a **standard OAuth 2.0 Bearer access token** (a Better
Auth control-plane session token). For a **stdio** server the host launches the
process, so this user credential is used only by `ryu_whoami`; it is not sent over
the MCP wire.

Two distinct tokens, deliberately kept separate:

- **`Authorization: Bearer` to Core** is the **node-admittance** token
  (`RYU_CORE_TOKEN` / the node's `RYU_TOKEN`). A current local Core normally
  mints `node-auth.token`, which the bridge reads automatically for loopback.
- The **device-auth session token** identifies the **user** to the control plane
  (powers `ryu_whoami`, sessions, billing). It is not a node bearer and does not
  replace `RYU_CORE_TOKEN` for direct node calls.

## Which MCP endpoint should you use?

This package is the compatibility bridge for hosts that need a stdio process. A
new external host should prefer Core's canonical HTTP endpoint:

```text
https://<node>/mcp/<agent-id>
```

For a Ryu Cloud or organization-bound node, use the hosted endpoint instead:

```text
https://<ryu-service>/mcp/<node-id>/<agent-id>
```

The hosted endpoint uses Better Auth OAuth + PKCE, checks the organization grant,
then forwards a short-lived node-and-agent delegation. It never forwards the
original user OAuth token to Core.

## Run it

```bash
bun run apps/mcp/src/index.ts
```

The pure target/auth boundary tests run without a Core or control-plane server:

```bash
(cd apps/mcp && bun test src)
```

## Use it from an MCP host

Add this to your host's MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ryu": {
      "command": "bun",
      "args": ["run", "apps/mcp/src/index.ts"],
      "env": {
        "RYU_CORE_URL": "http://127.0.0.1:7980"
      }
    }
  }
}
```

Use an absolute path to `apps/mcp/src/index.ts` (or the `ryu-mcp` bin) if the host
does not launch from the repo root.

## Tools

| Tool | Description |
| --- | --- |
| `ryu_health` | Probe whether the Core node is alive. |
| `ryu_system_info` | Live hardware snapshot (CPU, RAM, disk, GPU/VRAM, OS). |
| `ryu_system_status` | Service status: active engine, engine running, sidecars, gateway, mesh. |
| `ryu_list_agents` | List configured agents. |
| `ryu_list_teams` | List multi-agent teams. |
| `ryu_search_models` | Search the model catalog (`{ query, limit? }`). |
| `ryu_get_active_model` | Read the currently served model. |
| `ryu_set_active_model` | Switch the served model (`{ modelId, engine? }`). |
| `ryu_list_engines` | List inference engines and their installed models. |
| `ryu_list_skills` | List installed skills and their active state. |
| `ryu_search_skills` | Search the skills directory (`{ query, limit? }`). |
| `ryu_install_skill` | Install a skill by catalog id (`{ id }`). |
| `ryu_list_workflows` | List defined workflows. |
| `ryu_run_workflow` | Run a workflow (`{ id, input?, dryRun? }`); `dryRun: true` is a transient read-only preview that creates no run history and skips effectful nodes. |
| `ryu_list_mcp_servers` | List MCP servers Ryu has registered. |
| `ryu_call_mcp_tool` | Bridge: invoke a tool on any registered MCP server (`{ tool, server?, agentId, args? }`). `agentId` is required - Core ties the tool allowlist to a registered agent. |
| `ryu_list_spaces` | List knowledge Spaces. |
| `ryu_search_space` | Semantic search within one Space (`{ spaceId, query, limit? }`). |
| `ryu_search_retrieval` | Unified RAG search across memory + all Spaces (`{ query, topK? }`). |
| `ryu_ask` | Ask Ryu a question, single synchronous answer (`{ question, conversationId? }`). Omitting `conversationId` asks against an ephemeral context. |
| `ryu_whoami` | Report the signed-in Ryu user (or prompt to run `ryu-mcp login`). |
