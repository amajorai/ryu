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

Configure the target node with two environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RYU_CORE_URL` | `http://127.0.0.1:7980` | Base URL of the Ryu Core node. |
| `RYU_CORE_TOKEN` | _(unset)_ | Optional node-admittance bearer (the node's `RYU_TOKEN` secret). When unset, no `Authorization` header is sent - fine for a local loopback node. |
| `RYU_AUTH_URL` | `http://localhost:3000` | Control-plane (Better Auth) base URL, used only by the auth subcommands and `ryu_whoami`. |

`tools/list` works even when Core is down (the tool definitions are static). Tool
calls require a reachable Core node.

## Authentication

`ryu-mcp` signs in with the **same OAuth 2.0 Device Authorization Grant (RFC 8628)**
the desktop, mobile, and CLI clients use, through Ryu Core's proxy:

```bash
bun run apps/mcp/src/index.ts login     # opens your browser, polls Core, stores the bearer
bun run apps/mcp/src/index.ts whoami    # prints the signed-in user
bun run apps/mcp/src/index.ts logout    # clears the credential
```

`login` calls `POST {RYU_CORE_URL}/api/auth/login`, opens the verification URL,
then polls `GET /api/auth/status` until you approve it. Core performs the Better
Auth device grant server-side and persists the bearer to the shared credential
store `~/.ryu/auth.json` - so a `ryu-mcp login`, a `ryu login`, or a desktop
sign-in all satisfy each other (single sign-on).

The stored credential is a **standard OAuth 2.0 Bearer access token** (a Better
Auth control-plane session token) - exactly the bearer format MCP's own auth
model expects. For a **stdio** server the host launches the process, so this
user credential is carried out-of-band (the shared file), not over the MCP wire.

Two distinct tokens, deliberately kept separate:

- **`Authorization: Bearer` to Core** is the **node-admittance** token
  (`RYU_CORE_TOKEN` / the node's `RYU_TOKEN`). A local loopback node needs none.
- The **device-auth session token** identifies the **user** to the control plane
  (powers `ryu_whoami`, sessions, billing). It is not a Core node bearer, so the
  20 node tools above are unaffected by sign-in. (Carrying the user's identity
  into a remote/multi-tenant node via the `x-ryu-user-jwt` header is a planned
  follow-up; a local node does not need it.)

## Run it

```bash
bun run apps/mcp/src/index.ts
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
        "RYU_CORE_URL": "http://127.0.0.1:7980",
        "RYU_CORE_TOKEN": ""
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
| `ryu_run_workflow` | Run a workflow (`{ id, input? }`). |
| `ryu_list_mcp_servers` | List MCP servers Ryu has registered. |
| `ryu_call_mcp_tool` | Bridge: invoke a tool on any registered MCP server (`{ tool, server?, agentId, args? }`). `agentId` is required - Core ties the tool allowlist to a registered agent. |
| `ryu_list_spaces` | List knowledge Spaces. |
| `ryu_search_space` | Semantic search within one Space (`{ spaceId, query, limit? }`). |
| `ryu_search_retrieval` | Unified RAG search across memory + all Spaces (`{ query, topK? }`). |
| `ryu_ask` | Ask Ryu a question, single synchronous answer (`{ question, conversationId? }`). Omitting `conversationId` asks against an ephemeral context. |
| `ryu_whoami` | Report the signed-in Ryu user (or prompt to run `ryu-mcp login`). |
