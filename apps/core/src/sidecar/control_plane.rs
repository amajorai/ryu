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
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::governance::{validate_governance_values, GatewayGovernanceValues, GovernanceScope};

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
    #[serde(default)]
    governance: Option<ResolvedGovernance>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedGovernance {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub organization: GatewayGovernanceValues,
    #[serde(default)]
    pub team: GatewayGovernanceValues,
    #[serde(default)]
    pub user: GatewayGovernanceValues,
}

/// Resolved control-plane scope for this gateway.
#[derive(Debug, Clone)]
pub struct ResolvedScope {
    pub governance: Option<ResolvedGovernance>,
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

    pub async fn apply_governance(
        &self,
        preferences: &crate::server::preferences::PreferencesStore,
        app_store: &crate::plugins::PluginStore,
    ) -> Result<()> {
        let Some(governance) = self.governance.as_ref() else {
            return Ok(());
        };
        validate_governance_values(GovernanceScope::Organization, &governance.organization)
            .map_err(|error| anyhow!(error))?;
        validate_governance_values(GovernanceScope::Team, &governance.team)
            .map_err(|error| anyhow!(error))?;
        validate_governance_values(GovernanceScope::User, &governance.user)
            .map_err(|error| anyhow!(error))?;
        let encoded = serde_json::to_string(governance)?;
        preferences
            .set(crate::server::governance::MANAGED_GOVERNANCE_KEY, &encoded)
            .await?;
        app_store
            .replace_managed_hook_overrides(
                GovernanceScope::Organization,
                &governance.organization.hooks,
            )
            .await?;
        app_store
            .replace_managed_hook_overrides(GovernanceScope::Team, &governance.team.hooks)
            .await?;
        app_store
            .replace_managed_hook_overrides(GovernanceScope::User, &governance.user.hooks)
            .await?;
        Ok(())
    }
}

/// Control-plane base URL Core resolves the registry against.
fn control_plane_url() -> String {
    let environment = std::env::var(ENV_CONTROL_PLANE_URL)
        .ok()
        .filter(|value| !value.trim().is_empty());
    select_control_plane_url(
        environment,
        crate::fleet::enrolled_control_plane_url(),
        DEFAULT_CONTROL_PLANE_URL,
    )
}

fn select_control_plane_url(
    environment: Option<String>,
    enrolled: Option<String>,
    default: &str,
) -> String {
    environment
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .or(enrolled)
        .unwrap_or_else(|| default.to_owned())
}

/// This gateway's control-plane API key, if configured. When unset, the gateway
/// is unmanaged (local-only) and registry resolution is skipped.
pub fn gateway_key() -> Option<String> {
    let environment = std::env::var(ENV_GATEWAY_KEY)
        .ok()
        .filter(|value| !value.trim().is_empty());
    select_control_token(environment, crate::fleet::enrolled_control_token())
}

fn select_control_token(environment: Option<String>, enrolled: Option<String>) -> Option<String> {
    environment
        .map(|value| value.trim().to_owned())
        .or(enrolled)
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
        .header("x-gateway-key", key.clone())
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
    Ok(Some(ResolvedScope {
        governance: body.governance,
        tools: body.tools,
    }))
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
    pub image: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    /// Display name from the mirrored `user` row. Absent whenever the user row is
    /// missing (the roster is driven off `member` docs, which carry no name), so
    /// callers must have a fallback rather than treating this as required.
    #[serde(default)]
    pub name: Option<String>,
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
        .header("x-gateway-key", key.clone())
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

// ── Team roster (grant-editor principal directory) ───────────────────────────

/// One team in the node's bound org.
#[derive(Debug, Clone, Deserialize)]
pub struct OrgTeam {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// One custom Ryu role in the node's organization. The ACL editor needs the
/// stable key and label only; permission bodies stay on the control plane.
#[derive(Debug, Clone, Deserialize)]
pub struct OrgRole {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TeamsResponse {
    #[serde(default)]
    teams: Vec<OrgTeam>,
}

/// Resolve the node's org teams, for a grant editor that must offer teams to
/// target instead of making an admin type raw ids.
///
/// FAIL-EMPTY CONTRACT (unlike [`resolve_notify_targets`], which errors): every
/// failure — unbound node, unreachable control plane, a control plane too old to
/// serve this route — yields an EMPTY list. A directory is decoration around the
/// ACL, not part of it: an unbound personal node has no org to enumerate, and
/// erroring there would leave the editor unable to render at all.
pub async fn resolve_teams(client: &reqwest::Client) -> Vec<OrgTeam> {
    let Some(key) = gateway_key() else {
        return Vec::new();
    };

    let url = format!(
        "{}/api/control-plane/gateway/teams",
        control_plane_url().trim_end_matches('/')
    );
    let resp = match client
        .get(&url)
        .header("x-gateway-key", key)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            tracing::debug!("teams request failed (returning empty directory): {e}");
            return Vec::new();
        }
    };
    if !resp.status().is_success() {
        tracing::debug!(
            "teams returned {} (returning empty directory)",
            resp.status()
        );
        return Vec::new();
    }
    match resp.json::<TeamsResponse>().await {
        Ok(body) => body.teams,
        Err(e) => {
            tracing::debug!("teams decode failed (returning empty directory): {e}");
            Vec::new()
        }
    }
}

#[derive(Debug, Deserialize)]
struct RolesResponse {
    #[serde(default)]
    roles: Vec<OrgRole>,
}

/// Resolve custom roles for the node's ACL target picker. Built-in role ids are
/// local and are added by Core; this endpoint supplies only organization-owned
/// custom keys and is narrowed by the presenting gateway credential.
pub async fn resolve_roles(client: &reqwest::Client) -> Vec<OrgRole> {
    let Some(key) = gateway_key() else {
        return Vec::new();
    };
    let url = format!(
        "{}/api/control-plane/gateway/roles",
        control_plane_url().trim_end_matches('/')
    );
    let response = match client
        .get(&url)
        .header("x-gateway-key", key)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::debug!("roles request failed (returning empty directory): {error}");
            return Vec::new();
        }
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    response
        .json::<RolesResponse>()
        .await
        .map(|body| body.roles)
        .unwrap_or_default()
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
    #[serde(default, rename = "roleKeys")]
    role_keys: Vec<String>,
}

/// The control-plane slice of one caller's authorization. Permissions answer
/// whether a capability is held; role keys let the node ACL resolver apply a
/// resource overwrite targeted at a named custom role.
#[derive(Debug, Clone, Default)]
pub struct ResolvedPermissions {
    pub permissions: HashSet<String>,
    pub role_ids: HashSet<String>,
}

/// Process-wide TTL cache of effective permissions keyed by user id. Only positive
/// results land here (see [`resolve_permissions`]).
fn permissions_cache() -> &'static Mutex<HashMap<String, (Instant, ResolvedPermissions)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, ResolvedPermissions)>>> =
        OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn permissions_cache_key(user_id: &str) -> String {
    let team = registered_node()
        .and_then(|node| node.team_id)
        .unwrap_or_default();
    format!("{user_id}:{team}")
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
pub async fn resolve_permission_context(
    client: &reqwest::Client,
    user_id: &str,
) -> ResolvedPermissions {
    let cache_key = permissions_cache_key(user_id);
    // Fast path: a fresh cached positive result.
    if let Ok(guard) = permissions_cache().lock() {
        if let Some((at, permissions)) = guard.get(&cache_key) {
            if at.elapsed() < PERMISSIONS_TTL {
                return permissions.clone();
            }
        }
    }

    let Some(key) = gateway_key() else {
        // Unmanaged/local node: no control plane to consult. Fall back to role tier.
        return ResolvedPermissions::default();
    };

    let url = format!(
        "{}/api/control-plane/gateway/permissions",
        control_plane_url().trim_end_matches('/')
    );
    let mut query = vec![("userId", user_id.to_owned())];
    if let Some(team) = registered_node().and_then(|node| node.team_id) {
        query.push(("team", team));
    }
    let resp = match client
        .get(&url)
        .header("x-gateway-key", key)
        .query(&query)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            tracing::debug!("resolve_permissions request failed (falling back to role tier): {e}");
            return ResolvedPermissions::default();
        }
    };
    if !resp.status().is_success() {
        tracing::debug!(
            "resolve_permissions returned {} (falling back to role tier)",
            resp.status()
        );
        return ResolvedPermissions::default();
    }
    let body: PermissionsResponse = match resp.json().await {
        Ok(body) => body,
        Err(e) => {
            tracing::debug!("resolve_permissions decode failed (falling back to role tier): {e}");
            return ResolvedPermissions::default();
        }
    };

    let permissions = ResolvedPermissions {
        permissions: body.permissions.into_iter().collect(),
        role_ids: body.role_keys.into_iter().collect(),
    };
    // Cache only this positive result.
    if let Ok(mut guard) = permissions_cache().lock() {
        guard.insert(cache_key, (Instant::now(), permissions.clone()));
    }
    permissions
}

/// Compatibility projection for callers that only need the effective set.
pub async fn resolve_permissions(client: &reqwest::Client, user_id: &str) -> HashSet<String> {
    resolve_permission_context(client, user_id)
        .await
        .permissions
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

/// The org and stable node scope this managed node resolved to, cached after a
/// successful register so request authorization can bind to the exact node.
/// `None` until registration succeeds.
static REGISTERED_NODE: RwLock<Option<RegisteredNode>> = RwLock::new(None);
static REGISTERED_DELEGATION_KEY: RwLock<Option<String>> = RwLock::new(None);

/// The org a managed node is bound to (the registration result).
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct RegisteredOrg {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
}

/// The node boundary returned by the control plane. The `node_id` is stable
/// across bootstrap -> durable gateway credential rotation; `team_id` and
/// `owner_user_id` identify the node's authorization scope.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct RegisteredNode {
    pub org: RegisteredOrg,
    pub node_id: String,
    pub scope: NodeScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<String>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeScope {
    Org,
    Team,
    Personal,
}

#[derive(Debug, Deserialize)]
struct ResolveOrgResponse {
    #[serde(rename = "delegationPublicKey")]
    delegation_public_key: String,
    organization: ResolveOrg,
    /// The control plane's live managed-inference entitlement for this org.
    /// Core uses this server-authenticated value for paid-only profile work;
    /// the desktop preference remains only the local-node fallback.
    #[serde(default, rename = "managedInference")]
    managed_inference: bool,
    #[serde(default)]
    credential: Option<ResolveCredential>,
    /// F7: present only when the control plane just exchanged a single-use
    /// BOOTSTRAP gateway credential for a durable per-node one. When set, the node
    /// must adopt this durable token for the gateway data plane; the bootstrap it
    /// presented is now revoked. `#[serde(default)]` so every ordinary resolve
    /// (the field absent) decodes unchanged.
    #[serde(default, rename = "credentialRotation")]
    credential_rotation: Option<CredentialRotation>,
}

#[derive(Debug, Deserialize)]
struct ResolveCredential {
    id: String,
    #[serde(default, rename = "nodeId")]
    node_id: Option<String>,
    #[serde(default, rename = "teamId")]
    team_id: Option<String>,
    #[serde(default, rename = "ownerUserId")]
    owner_user_id: Option<String>,
}

/// F7: the durable gateway token minted in exchange for a bootstrap token.
#[derive(Debug, Deserialize)]
struct CredentialRotation {
    #[serde(default, rename = "controlToken")]
    control_token: Option<String>,
    #[serde(default, rename = "relayToken")]
    relay_token: Option<String>,
    /// One-release wire compatibility with the former dual-purpose response.
    #[serde(default)]
    token: Option<String>,
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
    registered_node().map(|node| node.org)
}

/// The exact managed node scope, if registration has succeeded.
pub fn registered_node() -> Option<RegisteredNode> {
    REGISTERED_NODE.read().ok().and_then(|g| g.clone())
}

/// Clear a registration that failed the enrolled bundle's org/node binding
/// check. This also drops the delegation-key pin learned from that response.
pub(crate) fn clear_registered_node() {
    if let Ok(mut guard) = REGISTERED_NODE.write() {
        *guard = None;
    }
    if let Ok(mut guard) = REGISTERED_DELEGATION_KEY.write() {
        *guard = None;
    }
    let _ = std::fs::remove_file(delegation_key_path());
}

/// The Ed25519 public key pinned by the last authenticated control-plane
/// handshake. Falls back to the persisted pin so delegation verification can
/// start before the first successful register call after a restart.
pub fn registered_delegation_key() -> Option<String> {
    if let Ok(guard) = REGISTERED_DELEGATION_KEY.read() {
        if let Some(key) = guard.as_ref() {
            return Some(key.clone());
        }
    }
    load_durable_token_from(&delegation_key_path()).filter(|key| valid_delegation_key(key))
}

// ── F7: durable-token persistence (restart survival) ─────────────────────────
//
// A managed node boots with a single-use BOOTSTRAP key in `RYU_GATEWAY_KEY`
// (from cloud-init `core.env`). `register_managed_node` exchanges it for
// separate node-control and inference-relay credentials, which must outlive the
// process. Core acknowledges and revokes the bootstrap only after both are
// durable. Core cannot rewrite `/etc/ryu/core.env`
// (owned root:ryu, and `ProtectSystem=full` makes /etc read-only for the
// service), but it CAN write its own data dir, so the durable is persisted
// them at 0600 (same custody posture as `master.key`) and re-adopts them at boot.

const CONTROL_TOKEN_FILE: &str = "node-control.token";
const RELAY_TOKEN_FILE: &str = "gateway-relay.token";
const LEGACY_DURABLE_TOKEN_FILE: &str = "gateway-durable.token";
const DELEGATION_PUBLIC_KEY_FILE: &str = "delegation-ed25519.pub";
const BOOTSTRAP_ACK_TOKEN_FILE: &str = "bootstrap-ack.token";
// Bounded compatibility for nodes upgraded from the old dual-purpose file.
// 2026-12-01T00:00:00Z.
const LEGACY_DURABLE_COMPAT_UNTIL_UNIX: u64 = 1_796_083_200;

/// Absolute path of the persisted durable token in the active Core data dir.
fn control_token_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join(CONTROL_TOKEN_FILE)
}

fn relay_token_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join(RELAY_TOKEN_FILE)
}

fn legacy_durable_token_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join(LEGACY_DURABLE_TOKEN_FILE)
}

fn delegation_key_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join(DELEGATION_PUBLIC_KEY_FILE)
}

fn bootstrap_ack_token_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join(BOOTSTRAP_ACK_TOKEN_FILE)
}

fn valid_delegation_key(key: &str) -> bool {
    base64::engine::general_purpose::STANDARD
        .decode(key.trim())
        .is_ok_and(|bytes| bytes.len() == 32)
}

fn normalized_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn rotation_tokens(rotation: &CredentialRotation) -> Option<(String, String)> {
    match (
        rotation.control_token.as_deref().and_then(normalized_token),
        rotation.relay_token.as_deref().and_then(normalized_token),
    ) {
        (Some(control), Some(relay)) => Some((control, relay)),
        _ => rotation
            .token
            .as_deref()
            .and_then(normalized_token)
            .map(|legacy| (legacy.clone(), legacy)),
    }
}

fn apply_split_tokens(control: &str, relay: &str) {
    std::env::set_var(ENV_GATEWAY_KEY, control);
    std::env::set_var(ENV_GATEWAY_TOKEN, relay);
}

fn write_secret_at(path: &std::path::Path, token: &str) -> std::io::Result<()> {
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

fn persist_split_tokens_at(
    control_path: &std::path::Path,
    relay_path: &std::path::Path,
    control: &str,
    relay: &str,
) -> std::io::Result<()> {
    if load_durable_token_from(control_path).as_deref() == Some(control)
        && load_durable_token_from(relay_path).as_deref() == Some(relay)
    {
        return Ok(());
    }
    let control_tmp = control_path.with_extension("token.tmp");
    let relay_tmp = relay_path.with_extension("token.tmp");
    write_secret_at(&control_tmp, control)?;
    write_secret_at(&relay_tmp, relay)?;
    std::fs::rename(&control_tmp, control_path)?;
    std::fs::rename(&relay_tmp, relay_path)?;
    Ok(())
}

fn persist_split_tokens(control: &str, relay: &str) -> std::io::Result<()> {
    persist_split_tokens_at(&control_token_path(), &relay_token_path(), control, relay)?;
    let _ = std::fs::remove_file(legacy_durable_token_path());
    Ok(())
}

fn persisted_split_tokens() -> Option<(String, String)> {
    Some((
        load_durable_token_from(&control_token_path())?,
        load_durable_token_from(&relay_token_path())?,
    ))
}

async fn acknowledge_bootstrap(client: &reqwest::Client, bootstrap: &str) -> bool {
    let ack_url = format!(
        "{}/api/control-plane/gateway/bootstrap/ack",
        control_plane_url().trim_end_matches('/')
    );
    match client
        .post(ack_url)
        .header("x-gateway-key", bootstrap)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response)
            if response.status().is_success()
                || response.status() == reqwest::StatusCode::UNAUTHORIZED =>
        {
            let _ = std::fs::remove_file(bootstrap_ack_token_path());
            true
        }
        Ok(response) => {
            tracing::warn!(
                "control-plane: bootstrap acknowledgement returned {}; retrying after restart",
                response.status()
            );
            false
        }
        Err(error) => {
            tracing::warn!(
                "control-plane: bootstrap acknowledgement failed ({error}); retrying after restart"
            );
            false
        }
    }
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
    if !should_load_managed_cloud_tokens(
        is_managed_node(),
        crate::fleet::has_enrolled_node_bundle(),
    ) {
        tracing::info!(
            "control-plane: using enrolled self-hosted credentials without changing the local Gateway bearer"
        );
        return;
    }
    let control = load_durable_token_from(&control_token_path());
    let relay = load_durable_token_from(&relay_token_path());
    if let (Some(control), Some(relay)) = (control, relay) {
        apply_split_tokens(&control, &relay);
        tracing::info!(
            "control-plane: loaded separate persisted node-control and gateway-relay credentials"
        );
        return;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(u64::MAX);
    if now < LEGACY_DURABLE_COMPAT_UNTIL_UNIX {
        if let Some(legacy) = load_durable_token_from(&legacy_durable_token_path()) {
            apply_split_tokens(&legacy, &legacy);
            tracing::warn!(
                "control-plane: loaded a legacy dual-purpose gateway credential; rotate before 2026-12-01"
            );
        }
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
    let enrolled_self_hosted =
        !is_managed_node() && crate::fleet::enrolled_control_token().is_some();
    if !should_register_node(is_managed_node(), enrolled_self_hosted) {
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
        .header("x-gateway-key", key.clone())
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

    if !valid_delegation_key(&body.delegation_public_key) {
        return Err(anyhow!(
            "managed-node register returned an invalid Ed25519 delegation public key"
        ));
    }
    write_secret_at(&delegation_key_path(), &body.delegation_public_key)
        .map_err(|error| anyhow!("failed to persist delegation public key: {error}"))?;
    if let Ok(mut guard) = REGISTERED_DELEGATION_KEY.write() {
        *guard = Some(body.delegation_public_key.clone());
    }

    // A prior exchange may have persisted both credentials but lost the ACK
    // response. Keep retrying the saved bootstrap until the server confirms it
    // is consumed (or reports it already invalid).
    if persisted_split_tokens().is_some() {
        if let Some(pending_bootstrap) = load_durable_token_from(&bootstrap_ack_token_path()) {
            let _ = acknowledge_bootstrap(client, &pending_bootstrap).await;
        }
    }

    // A managed node gets the paid gate from the authenticated control-plane
    // handshake, not from a client preference. Local nodes still receive the
    // same flag from the desktop entitlement sync path.
    crate::entitlement::set_managed_inference_entitled(if body.managed_inference {
        "true"
    } else {
        "false"
    });

    // If the control plane exchanged our single-use bootstrap key, durably store
    // the independently-scoped control and relay credentials before acknowledging
    // consumption. A lost response is safe: the server returns this same pair until
    // the acknowledgement succeeds.
    //
    //  - `ENV_GATEWAY_KEY` receives only node-control authority;
    //    `ENV_GATEWAY_TOKEN` receives only inference-relay authority.
    //  - Persist both to Core-WRITABLE 0600 files (the service user cannot rewrite
    //    `root:ryu 0640 /etc/ryu/core.env`, and the bootstrap in core.env is
    //    expired + revoked after this exchange). The boot loader
    //    (`load_persisted_durable_token`, run from `main.rs` before the register /
    //    resolve spawns) re-adopts it on the next start, so a restart never
    //    re-presents the dead bootstrap.
    if !enrolled_self_hosted {
        if let Some(rotation) = body.credential_rotation.as_ref() {
            match rotation_tokens(rotation) {
                Some((control, relay)) => match persist_split_tokens(&control, &relay) {
                    Ok(()) => {
                        write_secret_at(&bootstrap_ack_token_path(), &key).map_err(|error| {
                            anyhow!(
                                "failed to persist bootstrap acknowledgement marker: {error}"
                            )
                        })?;
                        apply_split_tokens(&control, &relay);
                        if acknowledge_bootstrap(client, &key).await {
                            tracing::info!(
                                    "control-plane: persisted separate control/relay credentials and acknowledged bootstrap consumption"
                                );
                        }
                    }
                    Err(error) => tracing::warn!(
                        "control-plane: refusing to consume bootstrap because the split credential pair could not be persisted ({error})"
                    ),
                },
                None => tracing::warn!(
                    "control-plane: bootstrap exchange returned an incomplete credential pair; keeping the presented bootstrap"
                ),
            }
        }
    }

    let org = RegisteredOrg {
        id: body.organization.id,
        name: body.organization.name,
        slug: body.organization.slug,
    };
    let credential = body.credential.ok_or_else(|| {
        anyhow!("managed-node register response is missing its credential binding")
    })?;
    let node_id = credential.node_id.unwrap_or(credential.id);
    if node_id.trim().is_empty() {
        return Err(anyhow!(
            "managed-node register response has an empty node binding"
        ));
    }
    let team_id = credential.team_id;
    let owner_user_id = credential.owner_user_id;
    if team_id.is_some() && owner_user_id.is_some() {
        return Err(anyhow!(
            "managed-node register response combines team and personal bindings"
        ));
    }
    let scope = if owner_user_id.is_some() {
        NodeScope::Personal
    } else if team_id.is_some() {
        NodeScope::Team
    } else {
        NodeScope::Org
    };
    let node = RegisteredNode {
        org: org.clone(),
        node_id,
        scope,
        team_id,
        owner_user_id,
    };
    if let Ok(mut guard) = REGISTERED_NODE.write() {
        *guard = Some(node);
    }
    Ok(Some(org))
}

fn should_load_managed_cloud_tokens(managed_cloud: bool, has_enrolled_bundle: bool) -> bool {
    managed_cloud || !has_enrolled_bundle
}

fn should_register_node(managed_cloud: bool, enrolled_self_hosted: bool) -> bool {
    managed_cloud || enrolled_self_hosted
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
            governance: None,
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
            governance: None,
            tools: vec![tool("composio", "github", true)],
        };
        assert!(with.has_grant_scoped_composio());

        // A Composio entry without a stored credential is not yet wired end-to-end.
        let without = ResolvedScope {
            governance: None,
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
            governance: parsed.governance,
            tools: parsed.tools,
        };
        assert_eq!(scope.allowed_slugs("mcp"), vec!["fs".to_owned()]);
        assert!(scope.has_grant_scoped_composio());
    }

    #[test]
    fn parses_additive_governance_layers_without_collapsing_false() {
        let json = r#"{
            "tools": [],
            "governance": {
                "revision": 7,
                "organization": { "hooks": { "plugin::hook": { "trusted": true } } },
                "team": { "hooks": { "plugin::hook": { "enabled": false } } },
                "user": { "git": { "branchPrefix": "user/" } }
            }
        }"#;

        let parsed: ResolveResponse = serde_json::from_str(json).expect("governance response");
        let governance = parsed.governance.expect("additive governance block");
        assert_eq!(governance.revision, 7);
        assert_eq!(governance.team.hooks["plugin::hook"].enabled, Some(false));
        assert_eq!(governance.user.git.branch_prefix.as_deref(), Some("user/"));
    }

    #[test]
    fn parses_gateway_resolve_org() {
        // Mirrors the `/api/control-plane/gateway/resolve` response shape; only
        // the `organization` block is needed for the node→org binding.
        let json = r#"{
            "delegationPublicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "organization": { "id": "org_123", "name": "Acme", "slug": "acme" },
            "credential": { "id": "c1", "name": "node", "keyPrefix": "rgw_abc" },
            "managedInference": true,
            "policy": { "rules": {}, "lockedFields": [] }
        }"#;
        let parsed: ResolveOrgResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.organization.id, "org_123");
        assert_eq!(parsed.organization.name, "Acme");
        assert_eq!(parsed.organization.slug.as_deref(), Some("acme"));
        assert!(parsed.managed_inference);
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
    fn control_token_precedence_keeps_environment_override_ahead_of_enrollment() {
        assert_eq!(
            select_control_token(
                Some(" env-control ".into()),
                Some("enrolled-control".into())
            ),
            Some("env-control".into())
        );
        assert_eq!(
            select_control_token(None, Some("enrolled-control".into())),
            Some("enrolled-control".into())
        );
        assert_eq!(select_control_token(None, None), None);
    }

    #[test]
    fn control_plane_url_precedence_is_environment_then_acknowledged_enrollment_then_default() {
        assert_eq!(
            select_control_plane_url(
                Some("https://env.example".into()),
                Some("https://enrolled.example".into()),
                "http://127.0.0.1:3000"
            ),
            "https://env.example"
        );
        assert_eq!(
            select_control_plane_url(
                None,
                Some("https://enrolled.example".into()),
                "http://127.0.0.1:3000"
            ),
            "https://enrolled.example"
        );
        assert_eq!(
            select_control_plane_url(None, None, "http://127.0.0.1:3000"),
            "http://127.0.0.1:3000"
        );
    }

    #[test]
    fn enrolled_self_hosted_node_registers_without_managed_cloud_flag() {
        assert!(should_register_node(false, true));
        assert!(should_register_node(true, false));
        assert!(!should_register_node(false, false));
    }

    #[test]
    fn enrolled_self_hosted_startup_never_applies_managed_cloud_split_tokens() {
        assert!(!should_load_managed_cloud_tokens(false, true));
        assert!(should_load_managed_cloud_tokens(true, true));
        assert!(should_load_managed_cloud_tokens(false, false));
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
    fn normalized_token_trims_and_rejects_empty() {
        // Empty / whitespace-only ⇒ None (keep the presented bootstrap + warn).
        assert_eq!(normalized_token(""), None);
        assert_eq!(normalized_token("   "), None);
        // A real token is trimmed and adopted.
        assert_eq!(
            normalized_token("  rgw_durable_abc  ").as_deref(),
            Some("rgw_durable_abc")
        );
    }

    #[test]
    fn delegation_key_requires_exactly_one_ed25519_public_key() {
        assert!(valid_delegation_key(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
        ));
        assert!(!valid_delegation_key(""));
        assert!(!valid_delegation_key("YWJj"));
        assert!(!valid_delegation_key("not-base64"));
    }

    #[test]
    fn parses_gateway_resolve_credential_rotation() {
        // A resolve that just exchanged a bootstrap carries `credentialRotation`;
        // an ordinary resolve omits it (serde default ⇒ None).
        let with = r#"{
            "delegationPublicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "organization": { "id": "org_1", "name": "Acme" },
            "credentialRotation": {
                "controlToken": "rgw_control_xyz",
                "relayToken": "rgw_relay_xyz"
            }
        }"#;
        let parsed: ResolveOrgResponse = serde_json::from_str(with).unwrap();
        let pair = parsed
            .credential_rotation
            .as_ref()
            .and_then(rotation_tokens)
            .expect("split pair");
        assert_eq!(pair.0, "rgw_control_xyz");
        assert_eq!(pair.1, "rgw_relay_xyz");

        let without = r#"{
            "delegationPublicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "organization": { "id": "org_1", "name": "Acme" }
        }"#;
        let plain: ResolveOrgResponse = serde_json::from_str(without).unwrap();
        assert!(plain.credential_rotation.is_none());
    }

    #[test]
    fn persist_and_load_split_tokens_roundtrip_at_0600() {
        let dir = std::env::temp_dir().join(format!(
            "ryu-durable-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let control_path = dir.join(CONTROL_TOKEN_FILE);
        let relay_path = dir.join(RELAY_TOKEN_FILE);

        // Absent ⇒ None (a fresh node has no persisted durable).
        assert_eq!(load_durable_token_from(&control_path), None);

        persist_split_tokens_at(
            &control_path,
            &relay_path,
            "rgw_control_persisted",
            "rgw_relay_persisted",
        )
        .unwrap();
        assert_eq!(
            load_durable_token_from(&control_path).as_deref(),
            Some("rgw_control_persisted")
        );
        assert_eq!(
            load_durable_token_from(&relay_path).as_deref(),
            Some("rgw_relay_persisted")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&control_path, &relay_path] {
                let mode = std::fs::metadata(path).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "credential file must be 0600");
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_split_tokens_keeps_control_and_relay_separate() {
        let _lock = env_lock();
        // Simulate a RESTARTED node: core.env still carries the (now revoked)
        // bootstrap KEY, and no data-plane TOKEN yet.
        std::env::set_var(ENV_GATEWAY_KEY, "rgw_stale_bootstrap");
        std::env::remove_var(ENV_GATEWAY_TOKEN);

        // The boot loader / exchange adopts the durable for BOTH roles.
        apply_split_tokens("rgw_control_new", "rgw_relay_new");
        assert_eq!(
            std::env::var(ENV_GATEWAY_KEY).unwrap(),
            "rgw_control_new",
            "control-plane KEY must use only the control credential"
        );
        assert_eq!(
            std::env::var(ENV_GATEWAY_TOKEN).unwrap(),
            "rgw_relay_new",
            "data-plane TOKEN must use only the relay credential"
        );

        std::env::remove_var(ENV_GATEWAY_KEY);
        std::env::remove_var(ENV_GATEWAY_TOKEN);
    }
}
