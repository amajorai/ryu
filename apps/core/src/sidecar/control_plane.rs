//! Control-plane registry resolution (U30, data-plane side).
//!
//! The control plane (`packages/api` `/api/registry`, backed by MongoDB) holds
//! the hierarchy-scoped catalog of skills/MCP/Composio entries and the
//! org-admin grants that decide what is available per org/team/project. This
//! module is the *local gateway's* read side: it authenticates with the
//! gateway key (U27) and resolves the allowed tool set for its scope.
//!
//! Placement (CLAUDE.md §1): the control plane decides *what is allowed/shared*;
//! Core only *resolves and runs* what it permits. So policy lives upstream and
//! this module just fetches the resolved set, then narrows the local config-
//! driven MCP registry (U13) down to the entries the org has granted.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Deserialize;

/// Env var with the control-plane base URL (the `apps/server` Hono API, which
/// mounts `/api/registry`). Defaults to local dev.
const ENV_CONTROL_PLANE_URL: &str = "RYU_CONTROL_PLANE_URL";
/// Env var with this gateway's API key (issued by the control plane, U27).
const ENV_GATEWAY_KEY: &str = "RYU_GATEWAY_KEY";
/// Env var with this managed node's publicly-reachable base URL (A4 / #501).
/// A managed node sets this (provisioning injects it) so the control plane can
/// record where the node is reachable and the desktop NodeSelector can list it.
/// Nothing-hardcoded: the node never guesses its own public address from
/// `RYU_BIND` (which is a loopback/0.0.0.0 bind, not a reachable URL) — the
/// reachable URL is a single explicit knob. Unset ⇒ the node does not advertise
/// a URL and registration stays a no-op binding (best-effort, never blocks).
const ENV_NODE_PUBLIC_URL: &str = "RYU_NODE_PUBLIC_URL";
/// Optional team scope to narrow resolution.
const ENV_TEAM_ID: &str = "RYU_TEAM_ID";
/// Optional project scope to narrow resolution.
const ENV_PROJECT_ID: &str = "RYU_PROJECT_ID";

const DEFAULT_CONTROL_PLANE_URL: &str = "http://127.0.0.1:3000";

/// A single tool source the control plane has granted to this gateway's scope.
#[derive(Debug, Clone, Deserialize)]
pub struct ResolvedTool {
    pub id: String,
    /// `skill` | `mcp` | `composio`.
    pub kind: String,
    /// Stable slug within the org (e.g. an MCP server name or Composio toolkit).
    pub slug: String,
    pub name: String,
    /// Resolved version (grant pin, else the entry's catalog version).
    pub version: String,
    /// Kind-specific opaque config (e.g. the MCP `{ command, args, env }`).
    #[serde(default)]
    pub config: serde_json::Value,
    /// True when a credential (e.g. a Composio connected account) is stored for
    /// this entry, i.e. the integration is grant-scoped end-to-end.
    #[serde(default, rename = "hasCredential")]
    pub has_credential: bool,
}

#[derive(Debug, Deserialize)]
struct ResolveResponse {
    #[serde(default)]
    tools: Vec<ResolvedTool>,
}

/// Resolved control-plane scope for this gateway.
#[derive(Debug, Clone)]
pub struct ResolvedScope {
    pub tools: Vec<ResolvedTool>,
}

impl ResolvedScope {
    /// Slugs of every granted tool of a given kind, e.g. the MCP servers this
    /// gateway is allowed to expose. Used to narrow the local U13 registry.
    pub fn allowed_slugs(&self, kind: &str) -> Vec<String> {
        self.tools
            .iter()
            .filter(|t| t.kind == kind)
            .map(|t| t.slug.clone())
            .collect()
    }

    /// Whether any granted Composio integration is wired end-to-end (a credential
    /// is stored for it). Satisfies the "grant-scoped Composio integration
    /// end-to-end" acceptance check on the data-plane side.
    pub fn has_grant_scoped_composio(&self) -> bool {
        self.tools
            .iter()
            .any(|t| t.kind == "composio" && t.has_credential)
    }
}

/// Control-plane base URL Core resolves the registry against.
fn control_plane_url() -> String {
    std::env::var(ENV_CONTROL_PLANE_URL)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CONTROL_PLANE_URL.to_owned())
}

/// This gateway's control-plane API key, if configured. When unset, the gateway
/// is unmanaged (local-only) and registry resolution is skipped.
pub fn gateway_key() -> Option<String> {
    std::env::var(ENV_GATEWAY_KEY)
        .ok()
        .filter(|s| !s.is_empty())
}

/// This managed node's publicly-reachable base URL, if configured (A4 / #501).
/// Trimmed, non-empty, and only an absolute `http(s)://` URL is accepted — a
/// bare host or loopback bind is rejected here so a dead picker entry can never
/// be advertised (the control plane re-validates on persist as defense in depth).
pub fn node_public_url() -> Option<String> {
    let raw = std::env::var(ENV_NODE_PUBLIC_URL).ok()?;
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        Some(trimmed.to_owned())
    } else {
        None
    }
}

/// Resolve the allowed tool set for this gateway's org/team/project scope.
///
/// Returns `Ok(None)` when no gateway key is configured (local-only mode, no
/// control plane to consult). Returns `Err` when a key is set but resolution
/// fails (network/auth), so callers can decide whether to fail closed.
pub async fn resolve_scope(client: &reqwest::Client) -> Result<Option<ResolvedScope>> {
    let Some(key) = gateway_key() else {
        return Ok(None);
    };

    let url = format!(
        "{}/api/registry/gateway/tools",
        control_plane_url().trim_end_matches('/')
    );
    let mut req = client
        .get(&url)
        .header("x-gateway-key", key)
        .timeout(Duration::from_secs(10));

    if let Ok(team) = std::env::var(ENV_TEAM_ID) {
        if !team.is_empty() {
            req = req.header("x-team-id", team);
        }
    }
    if let Ok(project) = std::env::var(ENV_PROJECT_ID) {
        if !project.is_empty() {
            req = req.header("x-project-id", project);
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("control-plane resolve request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("control-plane resolve returned {}", resp.status()));
    }

    let body: ResolveResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("control-plane resolve decode failed: {e}"))?;
    Ok(Some(ResolvedScope { tools: body.tools }))
}

// ── Notify-target resolution (member roster for NotifyUser workflow node) ─────

/// One resolved notification recipient (a member of the node's bound org).
#[derive(Debug, Clone, Deserialize)]
pub struct NotifyTargetUser {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NotifyTargetsResponse {
    #[serde(default)]
    users: Vec<NotifyTargetUser>,
}

/// Resolve the members a `NotifyUser` workflow node should ping.
///
/// The org is derived server-side from the gateway key (same credential the
/// `/gateway/resolve` handshake uses), so Core only needs the key. `team_id`, when
/// set, narrows the roster to that team's members. Returns `Err` when no gateway
/// key is configured (an org/team ping is meaningless on an unmanaged local node)
/// or the request fails, so the node can surface a clear error.
pub async fn resolve_notify_targets(
    client: &reqwest::Client,
    team_id: Option<&str>,
) -> Result<Vec<NotifyTargetUser>> {
    let Some(key) = gateway_key() else {
        return Err(anyhow!(
            "this node is not bound to an organization (no gateway key); \
             an org/team notification target cannot be resolved"
        ));
    };

    let url = format!(
        "{}/api/control-plane/gateway/notify-targets",
        control_plane_url().trim_end_matches('/')
    );
    let mut req = client
        .get(&url)
        .header("x-gateway-key", key)
        .timeout(Duration::from_secs(10));
    if let Some(team) = team_id.filter(|t| !t.is_empty()) {
        req = req.query(&[("team", team)]);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("notify-targets request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("notify-targets returned {}", resp.status()));
    }
    let body: NotifyTargetsResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("notify-targets decode failed: {e}"))?;
    Ok(body.users)
}

// ── Effective-permission resolution (org/team RBAC) ──────────────────────────

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// How long a resolved permission set is trusted before Core re-asks the control
/// plane. Short so a role/grant change propagates promptly; only SUCCESSFUL
/// lookups are cached (a transient failure must not deny a user for the window).
const PERMISSIONS_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
struct PermissionsResponse {
    #[serde(default)]
    permissions: Vec<String>,
}

/// Process-wide TTL cache of effective permissions keyed by user id. Only positive
/// results land here (see [`resolve_permissions`]).
fn permissions_cache() -> &'static Mutex<HashMap<String, (Instant, HashSet<String>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, HashSet<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a user's effective permissions (built-in role tier UNION every custom
/// role granted to them) in this node's gateway-key-bound org.
///
/// Mirrors [`resolve_notify_targets`]'s auth exactly: the org is derived
/// server-side from the `x-gateway-key` credential, so Core only sends the key and
/// the `userId`. This is the custom-role slice Core cannot compute locally.
///
/// FAIL-CLOSED CONTRACT: on ANY failure (no gateway key, network error, non-2xx,
/// decode error) this returns an EMPTY set — never an error and never a wide set.
/// Callers UNION this with the role tier from `permissions_for_role`, so an empty
/// result simply falls back to the built-in tier (never full access). Successful
/// lookups are cached for [`PERMISSIONS_TTL`]; failures are not cached.
pub async fn resolve_permissions(client: &reqwest::Client, user_id: &str) -> HashSet<String> {
    // Fast path: a fresh cached positive result.
    if let Ok(guard) = permissions_cache().lock() {
        if let Some((at, perms)) = guard.get(user_id) {
            if at.elapsed() < PERMISSIONS_TTL {
                return perms.clone();
            }
        }
    }

    let Some(key) = gateway_key() else {
        // Unmanaged/local node: no control plane to consult. Fall back to role tier.
        return HashSet::new();
    };

    let url = format!(
        "{}/api/control-plane/gateway/permissions",
        control_plane_url().trim_end_matches('/')
    );
    let resp = match client
        .get(&url)
        .header("x-gateway-key", key)
        .query(&[("userId", user_id)])
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            tracing::debug!("resolve_permissions request failed (falling back to role tier): {e}");
            return HashSet::new();
        }
    };
    if !resp.status().is_success() {
        tracing::debug!(
            "resolve_permissions returned {} (falling back to role tier)",
            resp.status()
        );
        return HashSet::new();
    }
    let body: PermissionsResponse = match resp.json().await {
        Ok(body) => body,
        Err(e) => {
            tracing::debug!("resolve_permissions decode failed (falling back to role tier): {e}");
            return HashSet::new();
        }
    };

    let perms: HashSet<String> = body.permissions.into_iter().collect();
    // Cache only this positive result.
    if let Ok(mut guard) = permissions_cache().lock() {
        guard.insert(user_id.to_owned(), (Instant::now(), perms.clone()));
    }
    perms
}

// ── Managed-node registration (A4 / #501) ────────────────────────────────────
//
// On a node flagged managed (`RYU_MANAGED_NODE`) Core self-registers to the
// control plane so the node binds to an org and its usage attributes to the
// right wallet. There is no separate "node record" in the control plane today:
// the `GatewayCredential` already binds a gateway key → org, and the
// `/api/control-plane/gateway/resolve` handshake (which stamps `lastUsedAt`) is
// the org binding. Registration therefore = "resolve my org via the gateway
// key and remember it", reusing the credential `/gateway/resolve` already
// performs (also used by the credits debit, so the wallet resolves to the same
// org). Building a node row nothing reads would be a half-feature, so we don't.

use std::sync::RwLock;

/// The org this managed node resolved to, cached after a successful register so
/// `GET /api/system/info` can surface it. `None` until registration succeeds.
static NODE_ORG: RwLock<Option<RegisteredOrg>> = RwLock::new(None);

/// The org a managed node is bound to (the registration result).
#[derive(Debug, Clone, serde::Serialize)]
pub struct RegisteredOrg {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ResolveOrgResponse {
    organization: ResolveOrg,
}

#[derive(Debug, Deserialize)]
struct ResolveOrg {
    id: String,
    name: String,
    #[serde(default)]
    slug: Option<String>,
}

/// Whether this Core is flagged as a managed node. Single source of truth lives
/// with the gateway spawn env (`RYU_MANAGED_NODE`), re-exported here so the
/// registration path and the gateway env-builder agree.
pub fn is_managed_node() -> bool {
    crate::sidecar::gateway::managed_node()
}

/// The org this managed node is bound to, if registration has succeeded.
pub fn registered_org() -> Option<RegisteredOrg> {
    NODE_ORG.read().ok().and_then(|g| g.clone())
}

/// Register this managed node with the control plane (A4 / #501).
///
/// Returns:
///   - `Ok(None)`   when the node is not managed, or has no gateway key — there
///                  is nothing to register, and a local install must never be
///                  blocked. Best-effort by design.
///   - `Ok(Some)`   the org this node bound to (also cached for `system/info`).
///   - `Err`        a managed node WITH a key whose resolve failed (network /
///                  auth) — the caller logs it; Core still comes up.
///
/// The binding is via the `GatewayCredential` the key maps to, so this node's
/// usage (and the credits debit) attribute to the resolved org's wallet.
pub async fn register_managed_node(client: &reqwest::Client) -> Result<Option<RegisteredOrg>> {
    if !is_managed_node() {
        return Ok(None);
    }
    let Some(key) = gateway_key() else {
        return Ok(None);
    };

    let url = format!(
        "{}/api/control-plane/gateway/resolve",
        control_plane_url().trim_end_matches('/')
    );
    let mut req = client
        .get(&url)
        .header("x-gateway-key", key)
        .timeout(Duration::from_secs(10));
    // Advertise where this node is reachable so the desktop NodeSelector can list
    // it. Sent on the existing resolve handshake (no new endpoint) so credits +
    // scope resolution are untouched. Omitted when unset — the binding still
    // succeeds; the node just won't appear in the picker until a URL is set.
    if let Some(public_url) = node_public_url() {
        req = req.header("x-node-public-url", public_url);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("managed-node register request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "managed-node register returned {} (check RYU_GATEWAY_KEY)",
            resp.status()
        ));
    }

    let body: ResolveOrgResponse = resp
        .json()
        .await
        .map_err(|e| anyhow!("managed-node register decode failed: {e}"))?;
    let org = RegisteredOrg {
        id: body.organization.id,
        name: body.organization.name,
        slug: body.organization.slug,
    };
    if let Ok(mut guard) = NODE_ORG.write() {
        *guard = Some(org.clone());
    }
    Ok(Some(org))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(kind: &str, slug: &str, has_credential: bool) -> ResolvedTool {
        ResolvedTool {
            id: format!("{kind}-{slug}"),
            kind: kind.to_owned(),
            slug: slug.to_owned(),
            name: slug.to_owned(),
            version: "1.0.0".to_owned(),
            config: serde_json::Value::Null,
            has_credential,
        }
    }

    #[test]
    fn allowed_slugs_filters_by_kind() {
        let scope = ResolvedScope {
            tools: vec![
                tool("mcp", "fs", false),
                tool("mcp", "git", false),
                tool("composio", "github", true),
            ],
        };
        let mut mcp = scope.allowed_slugs("mcp");
        mcp.sort();
        assert_eq!(mcp, vec!["fs".to_owned(), "git".to_owned()]);
        assert_eq!(scope.allowed_slugs("composio"), vec!["github".to_owned()]);
    }

    #[test]
    fn detects_grant_scoped_composio() {
        let with = ResolvedScope {
            tools: vec![tool("composio", "github", true)],
        };
        assert!(with.has_grant_scoped_composio());

        // A Composio entry without a stored credential is not yet wired end-to-end.
        let without = ResolvedScope {
            tools: vec![tool("composio", "github", false)],
        };
        assert!(!without.has_grant_scoped_composio());
    }

    #[test]
    fn parses_resolve_response() {
        let json = r#"{
            "organizationId": "org1",
            "scope": { "teamId": null, "projectId": null },
            "tools": [
                { "id": "e1", "kind": "mcp", "slug": "fs", "name": "Filesystem", "version": "1.2.0", "config": { "command": "npx" }, "hasCredential": false },
                { "id": "e2", "kind": "composio", "slug": "github", "name": "GitHub", "version": "1.0.0", "config": {}, "hasCredential": true }
            ]
        }"#;
        let parsed: ResolveResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.tools.len(), 2);
        let scope = ResolvedScope {
            tools: parsed.tools,
        };
        assert_eq!(scope.allowed_slugs("mcp"), vec!["fs".to_owned()]);
        assert!(scope.has_grant_scoped_composio());
    }

    #[test]
    fn parses_gateway_resolve_org() {
        // Mirrors the `/api/control-plane/gateway/resolve` response shape; only
        // the `organization` block is needed for the node→org binding.
        let json = r#"{
            "organization": { "id": "org_123", "name": "Acme", "slug": "acme" },
            "credential": { "id": "c1", "name": "node", "keyPrefix": "rgw_abc" },
            "policy": { "rules": {}, "lockedFields": [] }
        }"#;
        let parsed: ResolveOrgResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.organization.id, "org_123");
        assert_eq!(parsed.organization.name, "Acme");
        assert_eq!(parsed.organization.slug.as_deref(), Some("acme"));
    }

    #[test]
    fn register_skips_when_unmanaged() {
        // No RYU_MANAGED_NODE → register is a no-op (Ok(None)), never touching
        // the network. We assert the managed gate, not the HTTP call.
        // Serialize against the gateway managed-node tests (shared process-global).
        let _lock = crate::sidecar::gateway::lock_managed_node_env();
        let prev = std::env::var("RYU_MANAGED_NODE").ok();
        std::env::remove_var("RYU_MANAGED_NODE");
        assert!(!is_managed_node());
        if let Some(v) = prev {
            std::env::set_var("RYU_MANAGED_NODE", v);
        }
    }

    #[test]
    fn node_public_url_accepts_only_absolute_http() {
        // A reachable URL must be an absolute http(s) URL; a bare host or a
        // loopback bind string is rejected so a dead picker entry is never
        // advertised. Serialized via the env var the registration path reads.
        std::env::set_var(ENV_NODE_PUBLIC_URL, "https://node.ryu.cloud:7980");
        assert_eq!(
            node_public_url().as_deref(),
            Some("https://node.ryu.cloud:7980")
        );

        std::env::set_var(ENV_NODE_PUBLIC_URL, "  http://1.2.3.4:7980  ");
        assert_eq!(node_public_url().as_deref(), Some("http://1.2.3.4:7980"));

        for bad in ["node.ryu.cloud:7980", "ftp://x", "", "   "] {
            std::env::set_var(ENV_NODE_PUBLIC_URL, bad);
            assert_eq!(node_public_url(), None, "{bad:?} must be rejected");
        }

        std::env::remove_var(ENV_NODE_PUBLIC_URL);
        assert_eq!(node_public_url(), None);
    }
}
