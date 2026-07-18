//! Core's implementation of the extracted [`ryu_mcp_catalog::McpCatalogHost`]
//! seam.
//!
//! The `ryu-mcp-catalog` crate owns the MCP server catalog primitive — the
//! tolerant `server.json` wire parser, catalog card/detail shaping, registry
//! pagination, and the security-hardened install-plan builder (package /
//! version / remote-URL validation). What it cannot own — because it is a
//! kernel utility — is the one coupling its fetch needs: the **SSRF-guarded
//! HTTP GET** ([`crate::server::guarded_get_bytes`]: https-only, resolved-IP
//! screening + pinning against DNS-rebind, redirects disabled). A registry base
//! URL is operator/source supplied, so it must be fetched through that guard,
//! not a raw client. This shim implements it, and Core installs the shim once at
//! boot via [`ryu_mcp_catalog::set_global_host`], BEFORE any catalog route can
//! run.

use std::sync::Arc;

use ryu_mcp_catalog::McpCatalogHost;

/// Install [`CoreMcpCatalogHost`] as the process-global MCP-catalog host.
/// Idempotent (first install wins). Called once from `main` at boot; the catalog
/// is only reachable over HTTP routes, so it is never consulted before install.
pub fn install() {
    ryu_mcp_catalog::set_global_host(Arc::new(CoreMcpCatalogHost));
}

/// Core's `McpCatalogHost` — the kernel side of the MCP-catalog seam.
pub struct CoreMcpCatalogHost;

#[async_trait::async_trait]
impl McpCatalogHost for CoreMcpCatalogHost {
    async fn guarded_get_bytes(&self, url: &str) -> anyhow::Result<Vec<u8>> {
        crate::server::guarded_get_bytes(url).await
    }
}
