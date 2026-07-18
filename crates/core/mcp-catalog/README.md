# ryu-mcp-catalog

MCP-server **catalog** primitive: browse and install MCP servers from the official
Model Context Protocol registry (`registry.modelcontextprotocol.io`) and sibling
sources (Smithery, Ryu-hosted). All logic lives here so desktop/mobile/extension are
pure GUI over one Core HTTP API — the sibling of `ryu-model-catalog` and `ryu-skills`.

## Role in the decomposition

An extracted **Core capability crate**, compiled into `apps/core` as the in-process
default (no IPC). Discovering *what could run* and installing it (writing a server
entry into `~/.ryu/mcp.json`) is *what runs* → **Core**, not Gateway.

The crate has **zero dependency on `apps/core`**. Its one cross-cutting coupling —
the SSRF-guarded remote fetch (registry base URLs are operator/source supplied) —
inverts through the narrow **`McpCatalogHost`** trait. Core implements it in
`apps/core/src/mcp_catalog_host.rs` and installs it once at boot via
`set_global_host` before the first catalog call; production `host()` panics if unset
rather than silently dropping the SSRF guard. **That trait is the swap seam.**

## Key surface

- `McpCatalogHost` — the inverted kernel seam: `guarded_get_bytes` (https-only,
  resolved-IP screening, pinned IPs / anti DNS-rebind, redirects disabled).
- Tolerant `server.json` wire parser — reads the subset of the paginated
  `/v0.1/servers` envelope that matters (`packages[]` npm/pypi/oci with a stdio/http
  transport → launch command; `remotes[]` → hosted URL), ignoring unknown fields.
- Catalog card/detail shaping + SSRF-safe cursor pagination.
- Security-hardened **install-plan builder**: validates/normalizes the package
  identifier + version and remote URL (no shell metacharacters, no path traversal);
  the installed entry is written **disabled** so install never auto-launches. A
  freshly installed server lands in the same `~/.ryu/mcp.json` the sidecar
  `McpRegistry` reads, so its tools are listable after a hot-reload.

## Consumed as

Compiled-into-Core crate; served over Core's `/api/mcp/*` catalog routes.

Deps: anyhow, serde/serde_json, async-trait, url. No download logic here (install
writes config only; launch is the sidecar's job).
