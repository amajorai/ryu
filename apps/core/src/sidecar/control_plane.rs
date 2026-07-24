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
/// Env var with the bearer Core presents to the gateway data plane (F7: adopted
/// in-process after a bootstrap→durable exchange). Mirrors `gateway::ENV_GATEWAY_TOKEN`.
const ENV_GATEWAY_TOKEN: &str = "RYU_GATEWAY_TOKEN";
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
    /// F7: present only when the control plane just exchanged a single-use
    /// BOOTSTRAP gateway credential for a durable per-node one. When set, the node
    /// must adopt this durable token for the gateway data plane; the bootstrap it
    /// presented is now revoked. `#[serde(default)]` so every ordinary resolve
    /// (the field absent) decodes unchanged.
    #[serde(default, rename = "credentialRotation")]
    credential_rotation: Option<CredentialRotation>,
}

/// F7: the durable gateway token minted in exchange for a bootstrap token.
#[derive(Debug, Deserialize)]
struct CredentialRotation {
    token: String,
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

// ── F7: durable-token persistence (restart survival) ─────────────────────────
//
// A managed node boots with a single-use BOOTSTRAP key in `RYU_GATEWAY_KEY`
// (from cloud-init `core.env`). `register_managed_node` exchanges it for a
// DURABLE per-node token, which must outlive the process: the bootstrap is
// revoked + expired the moment it is exchanged, so a restart that re-read the
// bootstrap from `core.env` would 401. Core cannot rewrite `/etc/ryu/core.env`
// (owned root:ryu, and `ProtectSystem=full` makes /etc read-only for the
// service), but it CAN write its own data dir, so the durable is persisted
// there at 0600 (same custody posture as `master.key`) and re-adopted at boot.

/// Filename of the persisted durable gateway token inside the Core data dir.
const DURABLE_TOKEN_FILE: &str = "gateway-durable.token";

/// Absolute path of the persisted durable token in the active Core data dir.
fn durable_token_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join(DURABLE_TOKEN_FILE)
}

/// Pure: the durable token to adopt from a rotation's raw token string — trimmed,
/// or `None` when empty (keep the presented key + warn). Unit-testable without I/O.
fn durable_from_rotation_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// Adopt a durable token for BOTH gateway roles in THIS process. The durable
/// serves as the control-plane key (resolve/notify/permissions) AND the
/// data-plane bearer, so both env vars point at it; setting only one strands the
/// other on the revoked bootstrap.
fn apply_durable_token(token: &str) {
    std::env::set_var(ENV_GATEWAY_KEY, token);
    std::env::set_var(ENV_GATEWAY_TOKEN, token);
}

/// Persist `token` to [`durable_token_path`] atomically-ish at 0600. Delegates to
/// [`persist_durable_token_at`] so tests can target a scratch path (the real
/// [`durable_token_path`] is `OnceLock`-cached process-wide).
fn persist_durable_token(token: &str) -> std::io::Result<()> {
    persist_durable_token_at(&durable_token_path(), token)
}

fn persist_durable_token_at(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, token.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Read a persisted durable token from `path`, trimmed; `None` if absent/empty.
fn load_durable_token_from(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// F7 boot loader: if a prior bootstrap exchange persisted a durable token, adopt
/// it for BOTH gateway roles BEFORE any registration/resolution spawn runs, so a
/// restarted node presents the durable — never the now expired+revoked bootstrap
/// that `core.env` still carries. Best-effort and idempotent: absent file = no-op
/// (a fresh node then exchanges its bootstrap normally). MUST be called from
/// `main.rs` ahead of the `resolve_scope` and `register_managed_node` spawns.
pub fn load_persisted_durable_token() {
    if let Some(token) = load_durable_token_from(&durable_token_path()) {
        apply_durable_token(&token);
        tracing::info!(
            "control-plane: loaded a persisted durable gateway token (restart survival); using it for the control + data plane"
        );
    }
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

    // F7 (armed): if the control plane exchanged our single-use bootstrap KEY for a
    // durable per-node token, adopt it for BOTH gateway roles and persist it so a
    // restart survives.
    //
    //  - The durable serves BOTH roles: `ENV_GATEWAY_KEY` (control plane —
    //    resolve_scope / notify / permissions) AND `ENV_GATEWAY_TOKEN` (the
    //    data-plane bearer `gateway::gateway_bearer()` presents to the fleet).
    //    Setting only the TOKEN would leave the next resolve presenting the now
    //    REVOKED bootstrap KEY → 401, so both are set. Both are read lazily on
    //    every call, so `set_var` takes effect for all subsequent traffic in THIS
    //    process without a restart.
    //  - Persist to a Core-WRITABLE 0600 file (the service user cannot rewrite
    //    `root:ryu 0640 /etc/ryu/core.env`, and the bootstrap in core.env is
    //    expired + revoked after this exchange). The boot loader
    //    (`load_persisted_durable_token`, run from `main.rs` before the register /
    //    resolve spawns) re-adopts it on the next start, so a restart never
    //    re-presents the dead bootstrap.
    if let Some(rotation) = body.credential_rotation {
        match durable_from_rotation_token(&rotation.token) {
            Some(token) => {
                apply_durable_token(&token);
                match persist_durable_token(&token) {
                    Ok(()) => tracing::info!(
                        "control-plane: adopted + persisted a rotated durable gateway token (bootstrap exchanged)"
                    ),
                    Err(e) => tracing::warn!(
                        "control-plane: adopted a rotated durable gateway token in-process but failed to persist it ({e}); it survives this process but a restart will need re-provisioning"
                    ),
                }
            }
            None => tracing::warn!(
                "control-plane: bootstrap exchange returned an empty durable token; keeping the presented token"
            ),
        }
    }

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

    // ── F7: durable-token exchange + restart-survival persistence ────────────

    /// Serialize env-mutating tests: `set_var`/`remove_var` are process-global.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static L: std::sync::Mutex<()> = std::sync::Mutex::new(());
        L.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn durable_from_rotation_token_trims_and_rejects_empty() {
        // Empty / whitespace-only ⇒ None (keep the presented bootstrap + warn).
        assert_eq!(durable_from_rotation_token(""), None);
        assert_eq!(durable_from_rotation_token("   "), None);
        // A real token is trimmed and adopted.
        assert_eq!(
            durable_from_rotation_token("  rgw_durable_abc  ").as_deref(),
            Some("rgw_durable_abc")
        );
    }

    #[test]
    fn parses_gateway_resolve_credential_rotation() {
        // A resolve that just exchanged a bootstrap carries `credentialRotation`;
        // an ordinary resolve omits it (serde default ⇒ None).
        let with = r#"{
            "organization": { "id": "org_1", "name": "Acme" },
            "credentialRotation": { "token": "rgw_durable_xyz" }
        }"#;
        let parsed: ResolveOrgResponse = serde_json::from_str(with).unwrap();
        assert_eq!(
            parsed
                .credential_rotation
                .as_ref()
                .and_then(|r| durable_from_rotation_token(&r.token))
                .as_deref(),
            Some("rgw_durable_xyz")
        );

        let without = r#"{ "organization": { "id": "org_1", "name": "Acme" } }"#;
        let plain: ResolveOrgResponse = serde_json::from_str(without).unwrap();
        assert!(plain.credential_rotation.is_none());
    }

    #[test]
    fn persist_and_load_durable_token_roundtrips_at_0600() {
        let dir = std::env::temp_dir().join(format!(
            "ryu-durable-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join(DURABLE_TOKEN_FILE);

        // Absent ⇒ None (a fresh node has no persisted durable).
        assert_eq!(load_durable_token_from(&path), None);

        persist_durable_token_at(&path, "rgw_durable_persisted").unwrap();
        assert_eq!(
            load_durable_token_from(&path).as_deref(),
            Some("rgw_durable_persisted")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "durable token file must be 0600");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_durable_token_overrides_a_stale_bootstrap_in_env() {
        let _lock = env_lock();
        // Simulate a RESTARTED node: core.env still carries the (now revoked)
        // bootstrap KEY, and no data-plane TOKEN yet.
        std::env::set_var(ENV_GATEWAY_KEY, "rgw_stale_bootstrap");
        std::env::remove_var(ENV_GATEWAY_TOKEN);

        // The boot loader / exchange adopts the durable for BOTH roles.
        apply_durable_token("rgw_durable_new");
        assert_eq!(
            std::env::var(ENV_GATEWAY_KEY).unwrap(),
            "rgw_durable_new",
            "control-plane KEY must be overridden to the durable"
        );
        assert_eq!(
            std::env::var(ENV_GATEWAY_TOKEN).unwrap(),
            "rgw_durable_new",
            "data-plane TOKEN must also be set to the durable (both roles)"
        );

        std::env::remove_var(ENV_GATEWAY_KEY);
        std::env::remove_var(ENV_GATEWAY_TOKEN);
    }
}
