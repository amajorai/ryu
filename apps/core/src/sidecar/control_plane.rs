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

use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
    /// Whether a node that is not Ryu-managed must also refuse sources outside
    /// `tools` (the organization or the node's team requires connector
    /// approval). Absent on older control planes, which never enforced grants
    /// off managed nodes.
    #[serde(default, rename = "grantsEnforced")]
    grants_enforced: bool,
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
    /// Org-bound nodes that are not Ryu-managed enforce `tools` only when the
    /// control plane says so; managed nodes always do.
    pub grants_enforced: bool,
}

fn resolved_scope_slot() -> &'static RwLock<Option<ResolvedScope>> {
    static SLOT: OnceLock<RwLock<Option<ResolvedScope>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

/// Publish the last successful control-plane grant resolution. A failed refresh
/// deliberately leaves the last verified scope in place; a managed node with no
/// successful resolution remains deny-by-default at the MCP dispatch boundary.
pub fn set_resolved_scope(scope: ResolvedScope) {
    if let Ok(mut slot) = resolved_scope_slot().write() {
        *slot = Some(scope);
    }
}

fn current_resolved_scope() -> Option<ResolvedScope> {
    resolved_scope_slot()
        .read()
        .ok()
        .and_then(|slot| slot.as_ref().cloned())
}

/// Whether control-plane grants govern this node's external sources.
///
/// - Managed nodes: always, deny-by-default until a grant resolution succeeds.
/// - Org-bound desktop/self-hosted nodes: once a resolution says the
///   organization (or the node's team) requires connector approval. Until then
///   they keep local-first behavior, so joining an organization never silently
///   disables a member's own servers. A restart keeps an enforcing
///   organization's last resolution (see [`grant_inputs`]).
/// - Unbound nodes: never.
fn grants_enforced(managed: bool, bound: bool, scope: Option<&ResolvedScope>) -> bool {
    managed || (bound && scope.is_some_and(|scope| scope.grants_enforced))
}

fn granted_in(
    managed: bool,
    bound: bool,
    scope: Option<&ResolvedScope>,
    matches: impl Fn(&ResolvedTool) -> bool,
) -> bool {
    if !grants_enforced(managed, bound, scope) {
        return true;
    }
    scope.is_some_and(|scope| scope.tools.iter().any(matches))
}

/// Check a control-plane-managed source at the final Core dispatch boundary.
/// Where grants are enforced (see [`grants_enforced`]) the source needs a
/// successful grant resolution and an exact kind/slug match; a missing scope or
/// a revoked grant therefore cannot fall through to the local registry.
pub fn resolved_source_granted(kind: &str, slug: &str) -> bool {
    granted_now(|tool| tool.kind == kind && tool.slug == slug)
}

/// [`granted_in`] against this process's registration, live resolution and
/// the grant scope restored at boot (see [`grant_inputs`]).
fn granted_now(matches: impl Fn(&ResolvedTool) -> bool) -> bool {
    let managed = is_managed_node();
    let restored = RESTORED_GRANTS
        .read()
        .ok()
        .and_then(|restored| restored.as_ref().map(|(_, scope)| scope.clone()));
    let (bound, scope) = grant_inputs(
        managed,
        registered_org().is_some(),
        current_resolved_scope(),
        restored,
    );
    granted_in(managed, bound, scope.as_ref(), matches)
}

/// The binding and scope grant checks run against. A live resolution wins; until
/// one succeeds in this process, an org-bound node that is not Ryu-managed uses
/// the enforced grant scope persisted for its binding (restored at boot), so a
/// restart while the control plane is unreachable keeps enforcing the last
/// known grants instead of admitting every source. That restored scope also
/// counts as the binding until registration confirms or replaces it. Managed
/// nodes ignore it and stay deny-by-default until a live resolution.
fn grant_inputs(
    managed: bool,
    registered: bool,
    live: Option<ResolvedScope>,
    restored: Option<ResolvedScope>,
) -> (bool, Option<ResolvedScope>) {
    let bound = registered || restored.is_some();
    let scope = if managed { live } else { live.or(restored) };
    (bound, scope)
}

/// A skill install identity in comparable form: trimmed and without trailing
/// `/`. Only a URL's scheme and host are case-insensitive, so only they are
/// lowercased; repository paths, in-repo directories, SSH sources and local
/// paths compare exactly (a case mismatch denies rather than admitting another
/// repository on a case-sensitive host). `None` for an unqualified name (no
/// `/`): every catalog id (`owner/repo/skill`), repository, URL and pack id is
/// qualified, while a bare name passed as a source is a path relative to Core's
/// working directory and so names no fixed identity.
fn skill_identity(raw: &str) -> Option<String> {
    let identity = raw.trim().trim_end_matches('/');
    if !identity.contains('/') {
        return None;
    }
    let Some((scheme, rest)) = identity.split_once("://") else {
        return Some(identity.to_owned());
    };
    let (host, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    Some(format!(
        "{}://{}{path}",
        scheme.to_ascii_lowercase(),
        host.to_ascii_lowercase()
    ))
}

/// Prefix of a source-qualified catalog install identity (see
/// [`skill_catalog_identity`]). A requested source or skills.sh id carrying it
/// is refused, so such a grant is reachable only through its catalog source.
const CATALOG_IDENTITY_PREFIX: &str = "catalog:";

/// The built-in skills.sh catalog source, whose `owner/repo/skill` ids are
/// themselves the canonical skill identities.
const SKILLS_SH_CATALOG: &str = "skills-sh";

/// Where a `POST /api/skills/catalog/install` resolves its id. Each registry
/// maps its ids to content its own way (ClawHub, LobeHub, browse.sh and the
/// well-known source install by the id's final segment), so a catalog id is an
/// identity only together with the source that installs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillCatalogOrigin<'a> {
    /// A built-in source, identified by its fixed source id.
    Builtin(&'a str),
    /// A user-added source: its id is user-chosen and its id-to-content mapping
    /// user-defined, so it names no fixed identity.
    Custom,
}

/// The grant identity of a catalog install: the bare id for skills.sh, and
/// `catalog:<source>/<id>` for any other built-in source. `None` for a custom
/// source (grant its concrete source and install from source instead).
fn skill_catalog_identity(origin: SkillCatalogOrigin<'_>, id: &str) -> Option<String> {
    match origin {
        SkillCatalogOrigin::Builtin(SKILLS_SH_CATALOG) => requested_skill_identity(id),
        SkillCatalogOrigin::Builtin(source) => {
            skill_identity(&format!("{CATALOG_IDENTITY_PREFIX}{source}/{}", id.trim()))
        }
        SkillCatalogOrigin::Custom => None,
    }
}

/// A requested source, pack id or skills.sh id in comparable form. One shaped
/// like a source-qualified catalog identity is refused.
fn requested_skill_identity(raw: &str) -> Option<String> {
    skill_identity(raw).filter(|identity| {
        !identity
            .get(..CATALOG_IDENTITY_PREFIX.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(CATALOG_IDENTITY_PREFIX))
    })
}

/// Whether `tool` grants the comparable skill `identity`: it must equal the
/// grant's slug or its configured `config.source` (see [`skill_identity`]); a
/// shared final path segment never matches, so a grant for one repository's
/// `pdf` skill cannot authorize any other source that happens to end in `/pdf`.
fn skill_identity_granted(tool: &ResolvedTool, identity: &str) -> bool {
    let source = tool
        .config
        .get("source")
        .and_then(serde_json::Value::as_str);
    std::iter::once(tool.slug.as_str())
        .chain(source)
        .filter_map(skill_identity)
        .any(|granted| granted == identity)
}

/// Whether one of a skill's install identifiers (a catalog id such as
/// `owner/repo/skill`, a source reference, or a pack id) is granted by `tool`.
fn skill_identifier_granted(tool: &ResolvedTool, identifier: &str) -> bool {
    requested_skill_identity(identifier)
        .is_some_and(|identity| skill_identity_granted(tool, &identity))
}

/// Gate a skill install (source or pack) on the control-plane skill grants
/// wherever grants are enforced. User-authored local skills are not installs
/// and are never gated here, mirroring MCP where only external servers are.
pub fn skill_install_granted(identifiers: &[&str]) -> bool {
    granted_now(|tool| {
        tool.kind == "skill"
            && identifiers
                .iter()
                .any(|identifier| skill_identifier_granted(tool, identifier))
    })
}

/// Gate a catalog install of `id` through `origin` (see
/// [`skill_catalog_identity`]) wherever grants are enforced, so a grant for one
/// registry's skill cannot install another registry's skill of the same name.
pub fn skill_catalog_install_granted(origin: SkillCatalogOrigin<'_>, id: &str) -> bool {
    let identity = skill_catalog_identity(origin, id);
    granted_now(|tool| {
        tool.kind == "skill"
            && identity
                .as_deref()
                .is_some_and(|identity| skill_identity_granted(tool, identity))
    })
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

    /// Apply the managed governance layer from a SUCCESSFUL resolution. A
    /// resolution that omits governance means the control plane no longer
    /// manages it, so the managed document, its locks and the managed hook
    /// overrides are all cleared. (A failed fetch never reaches here: the
    /// refresh loop keeps the last known good layer in that case.)
    pub async fn apply_governance(
        &self,
        preferences: &crate::server::preferences::PreferencesStore,
        app_store: &crate::plugins::PluginStore,
    ) -> Result<()> {
        self.apply_governance_for(preferences, app_store, current_binding().as_ref())
            .await
    }

    /// [`Self::apply_governance`] recording the node `binding` the managed
    /// layer belongs to, so a restart only restores it for the same binding.
    async fn apply_governance_for(
        &self,
        preferences: &crate::server::preferences::PreferencesStore,
        app_store: &crate::plugins::PluginStore,
        binding: Option<&GovernanceBinding>,
    ) -> Result<()> {
        let Some(governance) = self.governance.as_ref() else {
            return clear_managed_governance(preferences, app_store).await;
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
        match binding {
            Some(binding) => {
                preferences
                    .set(
                        MANAGED_GOVERNANCE_BINDING_KEY,
                        &serde_json::to_string(binding)?,
                    )
                    .await?;
            }
            // Resolved before registration finished: provenance unknown, so a
            // restart will not restore it (the refresh re-applies it bound).
            None => preferences.delete(MANAGED_GOVERNANCE_BINDING_KEY).await?,
        }
        crate::governance::set_managed_locks(&governance.organization, &governance.team);
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

/// Preference key holding the node binding the persisted managed governance
/// document was applied under.
const MANAGED_GOVERNANCE_BINDING_KEY: &str = "gateway-governance-managed-binding-v1";

/// The organization/team binding a managed governance layer belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GovernanceBinding {
    org_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    team_id: Option<String>,
}

impl GovernanceBinding {
    fn of(node: &RegisteredNode) -> Self {
        Self {
            org_id: node.org.id.clone(),
            team_id: node.team_id.clone(),
        }
    }
}

/// This node's current registration binding, if registration has succeeded.
fn current_binding() -> Option<GovernanceBinding> {
    registered_node().as_ref().map(GovernanceBinding::of)
}

/// The binding whose persisted locks were restored at boot, so registration
/// can drop them the moment it reveals a different organization or team.
static RESTORED_BINDING: RwLock<Option<GovernanceBinding>> = RwLock::new(None);

fn clear_published_locks() {
    let empty = GatewayGovernanceValues::default();
    crate::governance::set_managed_locks(&empty, &empty);
}

/// Remove every trace of the managed governance layer: the persisted document
/// and its binding, the published locks, and the managed hook overrides of
/// each managed scope.
async fn clear_managed_governance(
    preferences: &crate::server::preferences::PreferencesStore,
    app_store: &crate::plugins::PluginStore,
) -> Result<()> {
    preferences
        .delete(crate::server::governance::MANAGED_GOVERNANCE_KEY)
        .await?;
    preferences.delete(MANAGED_GOVERNANCE_BINDING_KEY).await?;
    if let Ok(mut restored) = RESTORED_BINDING.write() {
        *restored = None;
    }
    let empty = GatewayGovernanceValues::default();
    crate::governance::set_managed_locks(&empty, &empty);
    for scope in [
        GovernanceScope::Organization,
        GovernanceScope::Team,
        GovernanceScope::User,
    ] {
        app_store
            .replace_managed_hook_overrides(scope, &empty.hooks)
            .await?;
    }
    Ok(())
}

/// What boot does with a persisted managed governance layer.
#[derive(Debug, PartialEq, Eq)]
enum BootGovernance {
    /// Local-only node, or bound to a different org/team: drop the layer.
    Clear,
    /// Same binding (or registration still pending): republish its locks.
    Restore,
    /// No recorded binding: publish nothing; the refresh re-applies it.
    Skip,
}

fn boot_governance(
    has_gateway_key: bool,
    stored: Option<&GovernanceBinding>,
    current: Option<&GovernanceBinding>,
) -> BootGovernance {
    if !has_gateway_key {
        return BootGovernance::Clear;
    }
    match (stored, current) {
        (None, _) => BootGovernance::Skip,
        (Some(stored), Some(current)) if stored != current => BootGovernance::Clear,
        // Registration usually completes after boot; `note_registration`
        // drops these locks if it reveals a different binding.
        (Some(_), _) => BootGovernance::Restore,
    }
}

/// Republish the locks of the persisted managed governance document at boot,
/// before the first control-plane refresh, but only for the node binding it
/// was applied under. A node that is now local-only (no gateway key) or bound
/// to another organization/team drops the former layer, its locks and its
/// managed hook overrides instead of enforcing them indefinitely.
///
/// The last enforced grant scope is restored by the same binding rule, and
/// only under the gateway credential it was resolved with, so an org-bound
/// node that restarts during a control-plane outage keeps enforcing its
/// organization's connector approval (see [`grant_inputs`]).
pub async fn restore_managed_locks(
    preferences: &crate::server::preferences::PreferencesStore,
    app_store: &crate::plugins::PluginStore,
) {
    let credential = gateway_key().as_deref().map(credential_fingerprint);
    let current = current_binding();
    restore_managed_locks_with(
        preferences,
        app_store,
        credential.is_some(),
        current.as_ref(),
    )
    .await;
    let restored = load_persisted_grant_scope(
        preferences,
        credential.as_deref(),
        current.as_ref(),
        &GrantNarrowing::current(),
    )
    .await;
    if let Ok(mut slot) = RESTORED_GRANTS.write() {
        *slot = restored;
    }
}

async fn restore_managed_locks_with(
    preferences: &crate::server::preferences::PreferencesStore,
    app_store: &crate::plugins::PluginStore,
    has_gateway_key: bool,
    current: Option<&GovernanceBinding>,
) {
    let read = |key: &'static str| async move {
        preferences.get(key).await.unwrap_or_else(|error| {
            tracing::warn!("control-plane: could not read managed governance ({error})");
            None
        })
    };
    let Some(stored) = read(crate::server::governance::MANAGED_GOVERNANCE_KEY).await else {
        return;
    };
    let binding = read(MANAGED_GOVERNANCE_BINDING_KEY)
        .await
        .and_then(|value| serde_json::from_str::<GovernanceBinding>(&value).ok());
    match boot_governance(has_gateway_key, binding.as_ref(), current) {
        BootGovernance::Clear => {
            if let Err(error) = clear_managed_governance(preferences, app_store).await {
                tracing::warn!("control-plane: could not clear stale managed governance ({error})");
                clear_published_locks();
            }
        }
        BootGovernance::Skip => {}
        BootGovernance::Restore => match serde_json::from_str::<ResolvedGovernance>(&stored) {
            Ok(governance) => {
                crate::governance::set_managed_locks(&governance.organization, &governance.team);
                if let Ok(mut restored) = RESTORED_BINDING.write() {
                    *restored = binding;
                }
            }
            Err(error) => {
                tracing::warn!("control-plane: persisted managed governance is invalid ({error})");
            }
        },
    }
}

// ── Last-known grant enforcement (restart survival) ──────────────────────────

/// Preference key holding the last enforced grant scope and its node binding.
const GRANT_SCOPE_KEY: &str = "gateway-grant-scope-v1";

/// An enforced grant scope restored at boot and the binding it was resolved
/// under. A `None` binding marks the fail-closed scope restored when the
/// record belonged to another gateway credential: it grants nothing and no
/// registration clears it, so only a live resolution supersedes it.
type RestoredGrants = (Option<GovernanceBinding>, ResolvedScope);

/// The grants restored at boot (see [`RestoredGrants`]). Cleared when
/// registration reveals another binding, when the node becomes local-only, and
/// when the registration is cleared.
static RESTORED_GRANTS: RwLock<Option<RestoredGrants>> = RwLock::new(None);

/// A non-secret fingerprint of the gateway credential a grant scope was
/// resolved with: a domain-separated SHA-256 of the key, truncated. The key
/// itself never reaches the store; the fingerprint only tells a restart
/// whether the record was resolved under the credential it now presents.
fn credential_fingerprint(gateway_key: &str) -> String {
    let digest = Sha256::digest(format!("ryu-grant-scope-credential-v1\0{gateway_key}"));
    hex::encode(&digest[..16])
}

/// One persisted grant. Only the identity a grant check reads is stored; the
/// opaque entry config (e.g. an MCP server's env) never reaches the store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGrant {
    kind: String,
    slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
}

/// The team/project narrowing a resolution was requested with (`RYU_TEAM_ID`,
/// `RYU_PROJECT_ID`, sent as `x-team-id` / `x-project-id`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantNarrowing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
}

impl GrantNarrowing {
    fn current() -> Self {
        let read = |name| std::env::var(name).ok().filter(|value| !value.is_empty());
        Self {
            team_id: read(ENV_TEAM_ID),
            project_id: read(ENV_PROJECT_ID),
        }
    }
}

/// The last successful resolution of an organization that enforces grants on
/// this node, recorded with the binding and narrowing it applies to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedGrantScope {
    binding: GovernanceBinding,
    /// [`credential_fingerprint`] of the gateway key the scope was resolved
    /// with. A record without one (written before it existed) matches no key.
    #[serde(default)]
    credential: Option<String>,
    #[serde(default)]
    narrowing: GrantNarrowing,
    tools: Vec<PersistedGrant>,
}

impl PersistedGrantScope {
    fn of(
        scope: &ResolvedScope,
        binding: &GovernanceBinding,
        credential: &str,
        narrowing: &GrantNarrowing,
    ) -> Self {
        Self {
            binding: binding.clone(),
            credential: Some(credential.to_owned()),
            narrowing: narrowing.clone(),
            tools: scope
                .tools
                .iter()
                .map(|tool| PersistedGrant {
                    kind: tool.kind.clone(),
                    slug: tool.slug.clone(),
                    source: tool
                        .config
                        .get("source")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned),
                })
                .collect(),
        }
    }

    /// The restored binding and enforced scope. Under another team/project
    /// narrowing the recorded grants are not this node's, so it restores an
    /// enforced scope granting nothing (fail closed) until a live resolution.
    fn into_scope(self, narrowing: &GrantNarrowing) -> RestoredGrants {
        let same_narrowing = self.narrowing == *narrowing;
        let tools = self
            .tools
            .into_iter()
            .filter(|_| same_narrowing)
            .map(|grant| ResolvedTool {
                id: format!("{}:{}", grant.kind, grant.slug),
                name: grant.slug.clone(),
                version: String::new(),
                config: grant.source.map_or(
                    serde_json::Value::Null,
                    |source| serde_json::json!({ "source": source }),
                ),
                has_credential: false,
                kind: grant.kind,
                slug: grant.slug,
            })
            .collect();
        let scope = ResolvedScope {
            governance: None,
            tools,
            grants_enforced: true,
        };
        (Some(self.binding), scope)
    }
}

/// The scope restored for a record resolved under another gateway credential:
/// enforced, granting nothing, and bound to no binding a registration could
/// contradict, so the node stays deny-by-default until a live resolution.
fn fail_closed_grants() -> RestoredGrants {
    let scope = ResolvedScope {
        governance: None,
        tools: Vec::new(),
        grants_enforced: true,
    };
    (None, scope)
}

/// Record a successful resolution, with the [`credential_fingerprint`] of the
/// gateway key it was resolved with, so a restart during a control-plane
/// outage keeps enforcing it. A scope resolved before registration (or with no
/// gateway key) has no known provenance and leaves the record unchanged; one
/// that no longer enforces grants removes it.
async fn persist_grant_scope(
    preferences: &crate::server::preferences::PreferencesStore,
    scope: &ResolvedScope,
    binding: Option<&GovernanceBinding>,
    credential: Option<&str>,
    narrowing: &GrantNarrowing,
) -> Result<()> {
    let (Some(binding), Some(credential)) = (binding, credential) else {
        return Ok(());
    };
    if !scope.grants_enforced {
        return preferences.delete(GRANT_SCOPE_KEY).await;
    }
    let record = PersistedGrantScope::of(scope, binding, credential, narrowing);
    let encoded = serde_json::to_string(&record)?;
    if preferences.get(GRANT_SCOPE_KEY).await?.as_deref() == Some(encoded.as_str()) {
        return Ok(());
    }
    preferences.set(GRANT_SCOPE_KEY, &encoded).await
}

/// The persisted enforced grant scope this boot may use. `credential` is the
/// [`credential_fingerprint`] of the gateway key this boot presents.
///
/// - Unreadable, or the node is local-only now: removed, nothing restored.
/// - Resolved under another gateway credential (e.g. the key was replaced with
///   one for another organization while registration is still pending), or
///   written before fingerprints existed: an enforced scope granting nothing is
///   restored ([`fail_closed_grants`]) so the former credential's grants never
///   apply. The record is kept, so every later boot under this credential fails
///   closed too until a live resolution replaces or removes it.
/// - Otherwise the binding rule of the managed governance layer
///   ([`boot_governance`]) decides: another known binding removes it; under
///   another team/project narrowing it restores as an enforced scope granting
///   nothing (see [`PersistedGrantScope::into_scope`]).
async fn load_persisted_grant_scope(
    preferences: &crate::server::preferences::PreferencesStore,
    credential: Option<&str>,
    current: Option<&GovernanceBinding>,
    narrowing: &GrantNarrowing,
) -> Option<RestoredGrants> {
    let stored = match preferences.get(GRANT_SCOPE_KEY).await {
        Ok(stored) => stored?,
        Err(error) => {
            tracing::warn!("control-plane: could not read the persisted grant scope ({error})");
            return None;
        }
    };
    let persisted = serde_json::from_str::<PersistedGrantScope>(&stored).ok();
    let (keep, restored) = match persisted {
        // A local-only node (no credential) drops the record below. Another
        // credential's record is kept: it can never restore under this key, and
        // removing it would let the next boot enforce nothing at all.
        Some(persisted)
            if credential.is_some() && persisted.credential.as_deref() != credential =>
        {
            (true, Some(fail_closed_grants()))
        }
        Some(persisted)
            if boot_governance(credential.is_some(), Some(&persisted.binding), current)
                == BootGovernance::Restore =>
        {
            (true, Some(persisted.into_scope(narrowing)))
        }
        _ => (false, None),
    };
    if !keep {
        if let Err(error) = preferences.delete(GRANT_SCOPE_KEY).await {
            tracing::warn!("control-plane: could not clear a stale grant scope ({error})");
        }
    }
    restored
}

/// Whether registration under `current` invalidates the restored grants: only
/// a scope restored for another binding. The fail-closed scope (no binding)
/// stays until a live resolution.
fn restored_grants_stale(restored: Option<&RestoredGrants>, current: &GovernanceBinding) -> bool {
    restored
        .and_then(|(binding, _)| binding.as_ref())
        .is_some_and(|binding| binding != current)
}

fn clear_restored_grants() {
    if let Ok(mut restored) = RESTORED_GRANTS.write() {
        *restored = None;
    }
}

/// Called when registration publishes `node`: locks restored at boot for a
/// different binding stop applying immediately (the refresh then replaces or
/// clears the persisted layer for the new binding).
fn note_registration(node: &RegisteredNode) {
    let current = GovernanceBinding::of(node);
    let stale_grants = RESTORED_GRANTS
        .read()
        .ok()
        .is_some_and(|restored| restored_grants_stale(restored.as_ref(), &current));
    if stale_grants {
        clear_restored_grants();
    }
    let stale = RESTORED_BINDING
        .read()
        .ok()
        .and_then(|restored| restored.clone())
        .is_some_and(|restored| restored != current);
    if stale {
        clear_published_locks();
        if let Ok(mut restored) = RESTORED_BINDING.write() {
            *restored = None;
        }
    }
}

/// The project this node is bound to (`RYU_PROJECT_ID`), if any: the same
/// project scope the registry resolution sends as `x-project-id`.
pub fn node_project_id() -> Option<String> {
    std::env::var(ENV_PROJECT_ID)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Control-plane base URL Core resolves the registry against.
pub(crate) fn control_plane_url() -> String {
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

    // The same narrowing a persisted grant scope records (see `GrantNarrowing`).
    let narrowing = GrantNarrowing::current();
    if let Some(team) = narrowing.team_id {
        req = req.header("x-team-id", team);
    }
    if let Some(project) = narrowing.project_id {
        req = req.header("x-project-id", project);
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
        grants_enforced: body.grants_enforced,
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
use std::sync::Mutex;
use std::time::Instant;

/// How long a resolved permission set is trusted before Core re-asks the control
/// plane. Short so a role/grant change propagates promptly; only SUCCESSFUL
/// lookups are cached (a transient failure must not deny a user for the window).
const PERMISSIONS_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
pub(crate) struct PermissionsResponse {
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default, rename = "roleKeys")]
    role_keys: Vec<String>,
    #[serde(default)]
    principal: Option<CurrentPrincipal>,
    #[serde(default)]
    node: Option<CurrentAuthorizationNode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentAuthorizationNode {
    id: String,
    scope: NodeScope,
    owner_user_id: Option<String>,
    team_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentPrincipal {
    user_id: String,
    org_id: String,
    role: String,
    teams: Vec<CurrentTeam>,
    /// Every team the user holds in the org, whatever the node's scope.
    /// `teams` is narrowed to a team node's own team (and empty on a
    /// personal node); vault policy subjects need the full list.
    #[serde(default)]
    policy_team_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentTeam {
    id: String,
    org_id: String,
    role: String,
}

/// One user's current authorization on this node, as the control plane
/// re-verified it.
#[derive(Debug, Clone)]
pub struct CurrentAuthorization {
    pub caller: crate::identity_verify::VerifiedCaller,
    pub permissions: ResolvedPermissions,
    /// Every team the user holds in the org, for vault `team:<id>` policy
    /// subjects. `caller.teams` is narrowed on team and personal nodes, so
    /// `None` means the complete list is unknown there (an older control
    /// plane) and policy evaluation must fail closed.
    pub policy_team_ids: Option<Vec<String>>,
}

/// Deferred execution cannot rely on JWT-era membership or cached grants. Missing
/// current membership and all transport/decode failures are explicit denials.
pub async fn resolve_current_principal(
    user_id: &str,
) -> Result<(crate::identity_verify::VerifiedCaller, ResolvedPermissions)> {
    resolve_current_authorization(user_id)
        .await
        .map(|current| (current.caller, current.permissions))
}

/// [`resolve_current_principal`], plus the user's complete policy team list.
pub async fn resolve_current_authorization(user_id: &str) -> Result<CurrentAuthorization> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    let client = CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| anyhow!("authorization transport unavailable"))?;
    let key = gateway_key().ok_or_else(|| anyhow!("authorization unavailable"))?;
    let mut query = vec![
        ("userId", user_id.to_owned()),
        ("deferred", "true".to_owned()),
    ];
    if let Some(team) = registered_node().and_then(|node| node.team_id) {
        query.push(("team", team));
    }
    let mut response = client
        .get(format!(
            "{}/api/control-plane/gateway/permissions",
            control_plane_url().trim_end_matches('/')
        ))
        .header("x-gateway-key", key)
        .query(&query)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 65_536 {
            return Err(anyhow!("authorization response is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    current_authorization_from_body(user_id, serde_json::from_slice(&bytes)?)
}

/// Validate a deferred `/gateway/permissions` response against this node's
/// registration and the requested user.
pub(crate) fn current_authorization_from_body(
    user_id: &str,
    body: PermissionsResponse,
) -> Result<CurrentAuthorization> {
    let principal = body
        .principal
        .ok_or_else(|| anyhow!("organization membership required"))?;
    let current_node = body
        .node
        .ok_or_else(|| anyhow!("current node authorization unavailable"))?;
    let registered = registered_node().ok_or_else(|| anyhow!("node binding unavailable"))?;
    if current_node.id != registered.node_id
        || current_node.scope != registered.scope
        || current_node.owner_user_id != registered.owner_user_id
        || current_node.team_id != registered.team_id
    {
        return Err(anyhow!("current node authority changed"));
    }
    if principal.user_id != user_id || registered_org().is_none_or(|org| org.id != principal.org_id)
    {
        return Err(anyhow!("principal binding mismatch"));
    }
    let caller = crate::identity_verify::VerifiedCaller {
        user_id: principal.user_id,
        email: None,
        email_verified: false,
        org_id: Some(principal.org_id.clone()),
        role: crate::identity_verify::OrgRole::from_ba_str(&principal.role),
        teams: principal
            .teams
            .into_iter()
            .filter(|team| team.org_id == principal.org_id)
            .map(|team| crate::identity_verify::TeamMembership {
                id: team.id,
                org_id: team.org_id,
                role: team.role,
            })
            .collect(),
    };
    // An org node's `teams` is already the complete list; a team or personal
    // node's is narrowed, so only the explicit list will do there.
    let policy_team_ids = principal.policy_team_ids.or_else(|| {
        (registered.scope == NodeScope::Org)
            .then(|| caller.teams.iter().map(|team| team.id.clone()).collect())
    });
    Ok(CurrentAuthorization {
        caller,
        permissions: ResolvedPermissions {
            permissions: body.permissions.into_iter().collect(),
            role_ids: body.role_keys.into_iter().collect(),
        },
        policy_team_ids,
    })
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
/// results land here (see [`try_resolve_permission_context`]).
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
    try_resolve_permission_context(client, user_id)
        .await
        .unwrap_or_default()
}

/// The control plane could not answer a permission lookup this time (transport
/// error, timeout, 408/429/5xx, or an undecodable body). It is not a denial:
/// a caller that can retry (a long-lived stream) should, and every other caller
/// falls back to the role tier through [`resolve_permission_context`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionLookupUnavailable;

/// Whether a non-2xx `/gateway/permissions` status is an outage rather than an
/// answer. Other 4xx statuses are definite and resolve to no custom grants.
pub(crate) fn permission_lookup_status_is_transient(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

/// [`resolve_permission_context`], but an outage is reported instead of being
/// folded into the empty set. A definite answer (no gateway key on an unbound
/// node, a 4xx refusal) is `Ok` with whatever the control plane granted.
pub async fn try_resolve_permission_context(
    client: &reqwest::Client,
    user_id: &str,
) -> Result<ResolvedPermissions, PermissionLookupUnavailable> {
    let cache_key = permissions_cache_key(user_id);
    // Fast path: a fresh cached positive result.
    if let Ok(guard) = permissions_cache().lock() {
        if let Some((at, permissions)) = guard.get(&cache_key) {
            if at.elapsed() < PERMISSIONS_TTL {
                return Ok(permissions.clone());
            }
        }
    }

    let Some(key) = gateway_key() else {
        // Unmanaged/local node: no control plane to consult. Fall back to role tier.
        return Ok(ResolvedPermissions::default());
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
            return Err(PermissionLookupUnavailable);
        }
    };
    if !resp.status().is_success() {
        tracing::debug!(
            "resolve_permissions returned {} (falling back to role tier)",
            resp.status()
        );
        if permission_lookup_status_is_transient(resp.status()) {
            return Err(PermissionLookupUnavailable);
        }
        return Ok(ResolvedPermissions::default());
    }
    let body: PermissionsResponse = match resp.json().await {
        Ok(body) => body,
        Err(e) => {
            tracing::debug!("resolve_permissions decode failed (falling back to role tier): {e}");
            return Err(PermissionLookupUnavailable);
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
    Ok(permissions)
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

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
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
    /// The credential-scoped effective org policy (C2 tool rules live under
    /// `policy.rules`). Absent on a control plane that predates the field.
    #[serde(default)]
    policy: Option<crate::org_policy::WireEffectivePolicy>,
    /// Hash of the effective policy + limits, so the node detects change cheaply.
    #[serde(default, rename = "policyVersion")]
    policy_version: Option<String>,
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
    #[cfg(test)]
    if let Ok(managed) = TEST_NODE_BINDING.try_with(|binding| binding.0) {
        return managed;
    }
    crate::sidecar::gateway::managed_node()
}

/// The org this managed node is bound to, if registration has succeeded.
pub fn registered_org() -> Option<RegisteredOrg> {
    registered_node().map(|node| node.org)
}

/// The exact managed node scope, if registration has succeeded.
pub fn registered_node() -> Option<RegisteredNode> {
    #[cfg(test)]
    if let Ok(node) = TEST_NODE_BINDING.try_with(|binding| binding.1.clone()) {
        return node;
    }
    REGISTERED_NODE.read().ok().and_then(|g| g.clone())
}

#[cfg(test)]
tokio::task_local! {
    /// A per-task `(managed, registered node)` binding for tests, so an
    /// authorization test can run against a managed, org-bound node without
    /// flipping the process-global `RYU_MANAGED_NODE` flag or registration that
    /// concurrently running tests also read.
    static TEST_NODE_BINDING: (bool, Option<RegisteredNode>);
}

/// Run `fut` as if this node were `managed` and registered as `node`. Only the
/// current task sees the binding: [`is_managed_node`] and [`registered_node`]
/// (and so [`registered_org`]) answer from it.
#[cfg(test)]
pub(crate) async fn with_test_node_binding<F: std::future::Future>(
    managed: bool,
    node: Option<RegisteredNode>,
    fut: F,
) -> F::Output {
    TEST_NODE_BINDING.scope((managed, node), fut).await
}

/// Clear a registration that failed the enrolled bundle's org/node binding
/// check. This also drops the delegation-key pin learned from that response.
pub(crate) fn clear_registered_node() {
    if let Ok(mut guard) = REGISTERED_NODE.write() {
        *guard = None;
    }
    // The former binding's managed locks stop applying now; the refresh loop
    // clears the persisted layer and hook overrides (local-only) or replaces
    // them with whatever the control plane resolves for this key.
    clear_published_locks();
    if let Ok(mut restored) = RESTORED_BINDING.write() {
        *restored = None;
    }
    clear_restored_grants();
    if let Ok(mut guard) = REGISTERED_DELEGATION_KEY.write() {
        *guard = None;
    }
    let _ = std::fs::remove_file(delegation_key_path());
    crate::org_policy::clear();
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
    load_public_file(&delegation_key_path()).filter(|key| valid_delegation_key(key))
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
//
// At rest every credential file here is sealed (see `docs/encryption-at-rest.md`):
// `node-control.token`, `bootstrap-ack.token` and the legacy
// `gateway-durable.token` with the master key (`enc:v1:`, only Core reads them),
// and `gateway-relay.token` with the Gateway's component subkey (`encc:v1:`),
// because the local Gateway opens it for diagnostics summaries. Reads accept a
// legacy plaintext file and reseal it once; writes fail closed without a key.
// `delegation-ed25519.pub` is a public key and stays plaintext.

const CONTROL_TOKEN_FILE: &str = "node-control.token";
const RELAY_TOKEN_FILE: &str = "gateway-relay.token";
const LEGACY_DURABLE_TOKEN_FILE: &str = "gateway-durable.token";
const DELEGATION_PUBLIC_KEY_FILE: &str = "delegation-ed25519.pub";
const BOOTSTRAP_ACK_TOKEN_FILE: &str = "bootstrap-ack.token";
static RELAY_TOKEN_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
// Bounded compatibility for nodes upgraded from the old dual-purpose file.
// 2026-12-01T00:00:00Z.
const LEGACY_DURABLE_COMPAT_UNTIL_UNIX: u64 = 1_796_083_200;

/// Absolute path of the persisted durable token in the active Core data dir.
fn control_token_path() -> std::path::PathBuf {
    crate::paths::secret_path(CONTROL_TOKEN_FILE)
}

fn relay_token_path() -> std::path::PathBuf {
    crate::paths::secret_path(RELAY_TOKEN_FILE)
}

/// Path to the persisted, least-privilege Gateway relay credential. Local
/// Gateway services may read this file to authenticate their opt-in diagnostics
/// summary without receiving the Axiom ingest token.
pub fn gateway_relay_token_path() -> std::path::PathBuf {
    relay_token_path()
}

/// Persist a relay credential from an acknowledged self-hosted enrollment for
/// the local Gateway sidecar. The file remains least-privilege and user-only.
pub fn persist_gateway_relay_token(token: &str) -> std::io::Result<std::path::PathBuf> {
    let token = normalized_token(token).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Gateway relay credential is empty",
        )
    })?;
    if ryu_gw_credentials::validate(&token).is_err() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Gateway relay credential is invalid",
        ));
    }
    let path = relay_token_path();
    persist_single_token_at(&path, &token)?;
    Ok(path)
}

fn legacy_durable_token_path() -> std::path::PathBuf {
    crate::paths::secret_path(LEGACY_DURABLE_TOKEN_FILE)
}

fn delegation_key_path() -> std::path::PathBuf {
    crate::paths::secret_path(DELEGATION_PUBLIC_KEY_FILE)
}

fn bootstrap_ack_token_path() -> std::path::PathBuf {
    crate::paths::secret_path(BOOTSTRAP_ACK_TOKEN_FILE)
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

/// The cipher that seals one credential file: the Gateway component subkey for
/// the relay token the Gateway reads, the master key for everything else.
fn token_sealer_for(
    path: &std::path::Path,
) -> anyhow::Result<std::sync::Arc<dyn ryu_crypto::SecretSealer>> {
    // Idempotent; covers callers that never ran `main` (tests, CLI subcommands).
    crate::crypto_host::install();
    if path.file_name().and_then(|name| name.to_str()) == Some(RELAY_TOKEN_FILE) {
        Ok(std::sync::Arc::new(ryu_crypto::component_cipher(
            ryu_crypto::components::GATEWAY,
        )?))
    } else {
        Ok(std::sync::Arc::new(ryu_crypto::global_cipher()?))
    }
}

/// Seal `token` with the cipher for `path` and atomically replace the file
/// (0600). Fails closed: without a key nothing is written.
fn write_secret_at(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    let sealer = token_sealer_for(path).map_err(std::io::Error::other)?;
    write_sealed_secret_at(path, token, &*sealer)
}

fn write_sealed_secret_at(
    path: &std::path::Path,
    token: &str,
    sealer: &dyn ryu_crypto::SecretSealer,
) -> std::io::Result<()> {
    ryu_crypto::write_secret_file(path, token, sealer).map_err(std::io::Error::other)
}

/// Write a NON-secret file (the pinned delegation public key) at 0600.
fn write_public_at(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    use std::io::Write as _;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn persist_single_token_at(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    let sealer = token_sealer_for(path).map_err(std::io::Error::other)?;
    persist_single_token_with(path, token, &*sealer)
}

/// Replace one credential file atomically (sealed temp file + rename), unless
/// it already holds `token` sealed. Compares OPENED values, so a sealed file
/// is not rewritten on every call; a legacy plaintext file is resealed.
fn persist_single_token_with(
    path: &std::path::Path,
    token: &str,
    sealer: &dyn ryu_crypto::SecretSealer,
) -> std::io::Result<()> {
    let _write_guard = RELAY_TOKEN_WRITE_LOCK
        .lock()
        .map_err(|_| std::io::Error::other("Gateway relay token writer lock poisoned"))?;
    if matches!(
        ryu_crypto::read_secret_file(path, Some(sealer)),
        Ok(Some(ref opened)) if opened.value == token && !opened.needs_reseal
    ) {
        return Ok(());
    }
    write_sealed_secret_at(path, token, sealer)
}

fn persist_split_tokens_at(
    control_path: &std::path::Path,
    relay_path: &std::path::Path,
    control: &str,
    relay: &str,
) -> std::io::Result<()> {
    let control_sealer = token_sealer_for(control_path).map_err(std::io::Error::other)?;
    let relay_sealer = token_sealer_for(relay_path).map_err(std::io::Error::other)?;
    persist_split_tokens_with(
        control_path,
        relay_path,
        control,
        relay,
        &*control_sealer,
        &*relay_sealer,
    )
}

/// Persist both split credentials sealed. Each file is replaced atomically, and
/// a pair that already holds these sealed values is left alone.
fn persist_split_tokens_with(
    control_path: &std::path::Path,
    relay_path: &std::path::Path,
    control: &str,
    relay: &str,
    control_sealer: &dyn ryu_crypto::SecretSealer,
    relay_sealer: &dyn ryu_crypto::SecretSealer,
) -> std::io::Result<()> {
    let unchanged = |path: &std::path::Path, value: &str, sealer: &dyn ryu_crypto::SecretSealer| {
        matches!(
            ryu_crypto::read_secret_file(path, Some(sealer)),
            Ok(Some(ref opened)) if opened.value == value && !opened.needs_reseal
        )
    };
    if unchanged(control_path, control, control_sealer)
        && unchanged(relay_path, relay, relay_sealer)
    {
        return Ok(());
    }
    // Both ciphers come from the same master key, so a missing key fails the
    // first write before either file changes.
    write_sealed_secret_at(control_path, control, control_sealer)?;
    write_sealed_secret_at(relay_path, relay, relay_sealer)?;
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

/// Read a persisted credential from `path`, opened and trimmed; `None` if
/// absent/empty or if a sealed file cannot be opened (logged). A legacy
/// plaintext file is resealed in place once.
fn load_durable_token_from(path: &std::path::Path) -> Option<String> {
    match token_sealer_for(path) {
        Ok(sealer) => load_durable_token_with(path, Some(&*sealer)),
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                "control-plane: no key for the persisted credential ({error})"
            );
            load_durable_token_with(path, None)
        }
    }
}

fn load_durable_token_with(
    path: &std::path::Path,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> Option<String> {
    let opened = match ryu_crypto::read_secret_file(path, sealer) {
        Ok(opened) => opened?,
        Err(error) => {
            tracing::error!(
                path = %path.display(),
                "control-plane: the persisted credential could not be opened: {error}"
            );
            return None;
        }
    };
    if opened.needs_reseal {
        if let Some(sealer) = sealer {
            if let Err(error) = write_sealed_secret_at(path, &opened.value, sealer) {
                tracing::warn!(
                    path = %path.display(),
                    "control-plane: could not seal the plaintext credential in place: {error}"
                );
            }
        }
    }
    Some(opened.value)
}

/// Read a NON-secret persisted file (the delegation public key), trimmed.
fn load_public_file(path: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
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
    // The node's project adds that project's (and its team's) policy layers.
    if let Some(project) = node_project_id() {
        req = req.header("x-project-id", project);
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
    write_public_at(&delegation_key_path(), &body.delegation_public_key)
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
    note_registration(&node);
    if let Ok(mut guard) = REGISTERED_NODE.write() {
        *guard = Some(node);
    }
    if crate::org_policy::set_snapshot(crate::org_policy::OrgPolicySnapshot::from_wire(
        org.id.clone(),
        body.policy_version,
        body.policy,
    )) {
        crate::org_policy::invalidate_features();
    }
    Ok(Some(org))
}

// ── Live policy refresh ──────────────────────────────────────────────────────
//
// Grants (`/api/registry/gateway/tools`), managed governance, and the org tool
// policy (`/api/control-plane/gateway/resolve` `policy` + `policyVersion`) used
// to be resolved exactly once at boot, so an admin revoking a grant or denying a
// tool waited for a node restart. The loop below re-resolves them on a jittered
// interval and swaps each slot atomically. A failed fetch never clears a slot:
// managed nodes keep their last-known-good scope (and stay deny-by-default when
// no resolution has ever succeeded).

/// Base interval between org-policy (`policyVersion`) polls.
const POLICY_POLL_INTERVAL: Duration = Duration::from_secs(30);
/// Grants/governance are refreshed at least this often, and immediately when
/// the policy version changes.
const SCOPE_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
struct PolicyResolveResponse {
    organization: ResolveOrg,
    #[serde(default)]
    policy: Option<crate::org_policy::WireEffectivePolicy>,
    #[serde(default, rename = "policyVersion")]
    policy_version: Option<String>,
}

/// Re-read the bound organization's effective policy. Only runs once the node
/// has registered: before that the configured key may still be the single-use
/// bootstrap credential, and presenting it here would consume it outside the
/// persistence path in [`register_managed_node`].
pub async fn resolve_org_policy(
    client: &reqwest::Client,
) -> Result<Option<crate::org_policy::OrgPolicySnapshot>> {
    let Some(registered) = registered_org() else {
        return Ok(None);
    };
    let Some(key) = gateway_key() else {
        return Ok(None);
    };
    let mut request = client
        .get(format!(
            "{}/api/control-plane/gateway/resolve",
            control_plane_url().trim_end_matches('/')
        ))
        .header("x-gateway-key", key)
        .timeout(Duration::from_secs(10));
    if let Some(project) = node_project_id() {
        request = request.header("x-project-id", project);
    }
    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("org policy resolve request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(anyhow!("org policy resolve returned {}", response.status()));
    }
    let body: PolicyResolveResponse = response
        .json()
        .await
        .map_err(|error| anyhow!("org policy resolve decode failed: {error}"))?;
    if body.organization.id != registered.id {
        return Err(anyhow!(
            "org policy resolve returned a different organization than this node is bound to"
        ));
    }
    Ok(Some(crate::org_policy::OrgPolicySnapshot::from_wire(
        body.organization.id,
        body.policy_version,
        body.policy,
    )))
}

#[derive(Debug, Deserialize)]
struct OrgFeaturesResponse {
    #[serde(rename = "organizationId")]
    organization_id: String,
    #[serde(default)]
    features: std::collections::BTreeMap<String, bool>,
}

/// Effective organization feature toggles for `user_id` (member override, then
/// org override, then catalog default), or the organization-wide values when
/// `user_id` is `None`. The org is derived server-side from the node credential.
pub async fn resolve_org_features(
    client: &reqwest::Client,
    user_id: Option<&str>,
) -> Result<std::collections::BTreeMap<String, bool>> {
    let registered = registered_org().ok_or_else(|| anyhow!("node is not organization-bound"))?;
    let key = gateway_key().ok_or_else(|| anyhow!("no node credential configured"))?;
    let mut request = client
        .get(format!(
            "{}/api/control-plane/gateway/organization-features",
            control_plane_url().trim_end_matches('/')
        ))
        .header("x-gateway-key", key)
        .timeout(Duration::from_secs(10));
    if let Some(user_id) = user_id.filter(|value| !value.trim().is_empty()) {
        request = request.query(&[("userId", user_id)]);
    }
    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("org features request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(anyhow!("org features returned {}", response.status()));
    }
    let body: OrgFeaturesResponse = response
        .json()
        .await
        .map_err(|error| anyhow!("org features decode failed: {error}"))?;
    if body.organization_id != registered.id {
        return Err(anyhow!(
            "org features returned a different organization than this node is bound to"
        ));
    }
    Ok(body.features)
}

#[derive(Debug, Deserialize)]
struct OrgToolPolicyResponse {
    #[serde(rename = "organizationId")]
    organization_id: String,
    #[serde(default)]
    policy: Option<crate::org_policy::WireEffectivePolicy>,
}

/// The effective tool policy (`allowedTools`, `deniedTools`,
/// `allowedMcpServers`) for `user_id` on this node: the credential's org/team
/// (or personal owner) layers plus that user's layer. `user_id = None` yields
/// the credential-scoped default. The org is derived server-side from the node
/// credential, exactly like [`resolve_org_features`].
pub async fn resolve_org_tool_policy(
    client: &reqwest::Client,
    user_id: Option<&str>,
) -> Result<crate::org_policy::OrgToolRules> {
    let registered = registered_org().ok_or_else(|| anyhow!("node is not organization-bound"))?;
    let key = gateway_key().ok_or_else(|| anyhow!("no node credential configured"))?;
    let mut request = client
        .get(format!(
            "{}/api/control-plane/gateway/tool-policy",
            control_plane_url().trim_end_matches('/')
        ))
        .header("x-gateway-key", key)
        .timeout(Duration::from_secs(10));
    if let Some(project) = node_project_id() {
        request = request.header("x-project-id", project);
    }
    if let Some(user_id) = user_id.filter(|value| !value.trim().is_empty()) {
        request = request.query(&[("userId", user_id)]);
    }
    let response = request
        .send()
        .await
        .map_err(|error| anyhow!("org tool policy request failed: {error}"))?;
    // An authoritative refusal (400/401/403, e.g. 400 for a removed member) is
    // typed so the per-caller cache drops that caller instead of serving
    // last-known-good; any other status (a route-level 404 included) is an outage.
    if let Some(refused) = crate::org_policy::CallerPolicyRefused::from_status(response.status()) {
        return Err(anyhow::Error::new(refused));
    }
    if !response.status().is_success() {
        return Err(anyhow!("org tool policy returned {}", response.status()));
    }
    let body: OrgToolPolicyResponse = response
        .json()
        .await
        .map_err(|error| anyhow!("org tool policy decode failed: {error}"))?;
    if body.organization_id != registered.id {
        return Err(anyhow!(
            "org tool policy returned a different organization than this node is bound to"
        ));
    }
    Ok(
        crate::org_policy::OrgPolicySnapshot::from_wire(body.organization_id, None, body.policy)
            .rules,
    )
}

/// `base` plus or minus up to 20%, so a fleet of nodes does not poll in lockstep.
fn jittered(base: Duration) -> Duration {
    use rand::Rng as _;
    let base_ms = u64::try_from(base.as_millis()).unwrap_or(u64::MAX);
    let spread = base_ms / 5;
    let offset = rand::thread_rng().gen_range(0..=spread.saturating_mul(2));
    Duration::from_millis(base_ms - spread + offset)
}

/// Apply one registry resolution. Returns `false` when the node is unmanaged.
async fn refresh_registry_scope(
    client: &reqwest::Client,
    state: &crate::server::ServerState,
    // `None` until the first successful apply in this process, so the first
    // resolution always reconciles the persisted layer (including clearing a
    // managed layer the control plane stopped sending while Core was down).
    last_governance: &mut Option<GovernanceMarker>,
) -> bool {
    match resolve_scope(client).await {
        Ok(None) => {
            // Local-only: no control plane manages this node, so no managed
            // layer, lock or hook override may outlive a former binding.
            let marker = (None, None);
            if last_governance.as_ref() != Some(&marker) {
                clear_restored_grants();
                if let Err(error) = state.preferences.delete(GRANT_SCOPE_KEY).await {
                    tracing::warn!(
                        "control-plane: could not clear the persisted grant scope ({error})"
                    );
                }
                match clear_managed_governance(&state.preferences, &state.app_store).await {
                    Ok(()) => *last_governance = Some(marker),
                    Err(error) => tracing::warn!(
                        "control-plane: could not clear managed governance ({error})"
                    ),
                }
            }
            false
        }
        Ok(Some(scope)) => {
            set_resolved_scope(scope.clone());
            let credential = gateway_key().as_deref().map(credential_fingerprint);
            if let Err(error) = persist_grant_scope(
                &state.preferences,
                &scope,
                current_binding().as_ref(),
                credential.as_deref(),
                &GrantNarrowing::current(),
            )
            .await
            {
                tracing::warn!("control-plane: could not persist the grant scope ({error})");
            }
            // Re-apply when the document OR the node binding changes, so a
            // layer first applied before registration gets its binding.
            let encoded = (
                scope
                    .governance
                    .as_ref()
                    .and_then(|governance| serde_json::to_string(governance).ok()),
                current_binding(),
            );
            if last_governance.as_ref() != Some(&encoded) {
                match scope
                    .apply_governance(&state.preferences, &state.app_store)
                    .await
                {
                    Ok(()) => *last_governance = Some(encoded),
                    Err(error) => tracing::warn!(
                        "control-plane: managed governance apply failed ({error}); keeping last known good policy"
                    ),
                }
            }
            tracing::debug!(
                mcp = ?scope.allowed_slugs("mcp"),
                composio = ?scope.allowed_slugs("composio"),
                grant_scoped_composio = scope.has_grant_scoped_composio(),
                "control-plane: resolved {} granted tool(s) for this gateway scope",
                scope.tools.len()
            );
            true
        }
        Err(error) => {
            tracing::warn!(
                "control-plane: registry resolution failed ({error}); keeping last known good scope"
            );
            true
        }
    }
}

/// The last applied managed governance document and the binding it was
/// applied under.
type GovernanceMarker = (Option<String>, Option<GovernanceBinding>);

/// Keep grants, managed governance, and the org tool policy live for the
/// lifetime of the process. Runs on every node; an unmanaged node only pays a
/// local key lookup per tick.
/// Keep the Ryu Router "Free" model ids fresh: fetched from the control
/// plane's public projection at boot and every 10 minutes, cached on disk.
/// Ids only — the supplier behind a model never reaches Core. Fail-open: an
/// unreachable plane keeps the last good list (empty before the first fetch).
pub async fn run_free_models_refresh_loop() {
    let client = reqwest::Client::new();
    let cache_path = crate::pi_config::ryu_free_models_cache_path();
    loop {
        if !ryu_model_catalog::ryu_free_models::refresh(&client, &control_plane_url(), &cache_path)
            .await
        {
            tracing::debug!(
                "control-plane: Ryu Router free-model refresh failed; keeping the last list"
            );
        }
        tokio::time::sleep(ryu_model_catalog::ryu_free_models::REFRESH_EVERY).await;
    }
}

pub async fn run_scope_refresh_loop(state: crate::server::ServerState) {
    let client = reqwest::Client::new();
    let mut last_governance: Option<GovernanceMarker> = None;
    let mut last_scope_refresh: Option<std::time::Instant> = None;
    let mut announced_unmanaged = false;
    loop {
        let mut policy_changed = false;
        match resolve_org_policy(&client).await {
            Ok(Some(snapshot)) => {
                policy_changed = crate::org_policy::set_snapshot(snapshot);
                if policy_changed {
                    crate::org_policy::invalidate_features();
                    tracing::info!("control-plane: organization policy changed; refreshing scope");
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                "control-plane: org policy refresh failed ({error}); keeping last known good policy"
            ),
        }
        let scope_due = last_scope_refresh.is_none_or(|at| {
            at.elapsed() >= SCOPE_REFRESH_INTERVAL.saturating_sub(Duration::from_secs(5))
        });
        if policy_changed || scope_due {
            let managed = refresh_registry_scope(&client, &state, &mut last_governance).await;
            last_scope_refresh = Some(std::time::Instant::now());
            if !managed && !announced_unmanaged {
                announced_unmanaged = true;
                tracing::info!(
                    "control-plane: no gateway key (RYU_GATEWAY_KEY) set; using local MCP registry only"
                );
            }
        }
        tokio::time::sleep(jittered(POLICY_POLL_INTERVAL)).await;
    }
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

    #[tokio::test]
    async fn absent_governance_clears_managed_layer_and_boot_restores_locks() {
        let _serial = MANAGED_LOCKS_TEST_LOCK.lock().await;
        use crate::governance::{locked_above, HookPolicyOverride};
        const HOOK: &str = "control-plane-clear-test-hook";
        let directory = tempfile::tempdir().unwrap();
        let preferences =
            crate::server::preferences::PreferencesStore::open(directory.path().join("p.db"))
                .unwrap();
        let app_store = crate::plugins::PluginStore::open_in_memory().unwrap();
        let mut organization = GatewayGovernanceValues::default();
        organization.hooks.insert(
            HOOK.to_owned(),
            HookPolicyOverride {
                enabled: Some(false),
                trusted: None,
            },
        );
        organization.locked_fields = vec![format!("hooks.{HOOK}")];
        let managed = ResolvedScope {
            grants_enforced: false,
            governance: Some(ResolvedGovernance {
                revision: 1,
                organization,
                team: GatewayGovernanceValues::default(),
                user: GatewayGovernanceValues::default(),
            }),
            tools: Vec::new(),
        };
        let binding = GovernanceBinding {
            org_id: "org_clear_test".into(),
            team_id: None,
        };
        managed
            .apply_governance_for(&preferences, &app_store, Some(&binding))
            .await
            .unwrap();
        let lock_path = format!("hooks.{HOOK}");
        assert!(locked_above(GovernanceScope::User, &lock_path));
        let managed_hooks = |records: Vec<crate::plugins::HookOverrideRecord>| {
            records
                .into_iter()
                .filter(|record| record.managed && record.hook_key == HOOK)
                .count()
        };
        assert_eq!(
            managed_hooks(app_store.list_hook_overrides().await.unwrap()),
            1
        );

        // Boot: locks come back from the persisted document alone.
        let empty = GatewayGovernanceValues::default();
        crate::governance::set_managed_locks(&empty, &empty);
        assert!(!locked_above(GovernanceScope::User, &lock_path));
        restore_managed_locks_with(&preferences, &app_store, true, Some(&binding)).await;
        assert!(locked_above(GovernanceScope::User, &lock_path));

        // A successful resolution without governance removes the managed layer.
        let unmanaged = ResolvedScope {
            grants_enforced: false,
            governance: None,
            tools: Vec::new(),
        };
        unmanaged
            .apply_governance(&preferences, &app_store)
            .await
            .unwrap();
        assert!(preferences
            .get(crate::server::governance::MANAGED_GOVERNANCE_KEY)
            .await
            .unwrap()
            .is_none());
        assert!(!locked_above(GovernanceScope::User, &lock_path));
        assert_eq!(
            managed_hooks(app_store.list_hook_overrides().await.unwrap()),
            0
        );
        restore_managed_locks_with(&preferences, &app_store, true, Some(&binding)).await;
        assert!(!locked_above(GovernanceScope::User, &lock_path));
    }

    /// The published managed locks are process-global; tests that publish
    /// or clear them run one at a time.
    static MANAGED_LOCKS_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn boot_restores_managed_locks_only_for_the_same_binding() {
        let org_a = GovernanceBinding {
            org_id: "org_a".into(),
            team_id: None,
        };
        let org_b = GovernanceBinding {
            org_id: "org_b".into(),
            team_id: None,
        };
        let team = GovernanceBinding {
            org_id: "org_a".into(),
            team_id: Some("team-1".into()),
        };
        use BootGovernance::{Clear, Restore, Skip};
        assert_eq!(boot_governance(false, Some(&org_a), None), Clear);
        assert_eq!(boot_governance(false, Some(&org_a), Some(&org_a)), Clear);
        assert_eq!(boot_governance(true, Some(&org_a), Some(&org_b)), Clear);
        assert_eq!(boot_governance(true, Some(&org_a), Some(&team)), Clear);
        assert_eq!(boot_governance(true, Some(&org_a), Some(&org_a)), Restore);
        assert_eq!(boot_governance(true, Some(&org_a), None), Restore);
        assert_eq!(boot_governance(true, None, Some(&org_a)), Skip);
    }

    #[tokio::test]
    async fn stale_bindings_drop_the_former_orgs_managed_layer_at_boot() {
        let _serial = MANAGED_LOCKS_TEST_LOCK.lock().await;
        use crate::governance::{locked_above, HookPolicyOverride};
        const HOOK: &str = "control-plane-binding-test-hook";
        let lock_path = format!("hooks.{HOOK}");
        let directory = tempfile::tempdir().unwrap();
        let preferences =
            crate::server::preferences::PreferencesStore::open(directory.path().join("p.db"))
                .unwrap();
        let app_store = crate::plugins::PluginStore::open_in_memory().unwrap();
        let mut organization = GatewayGovernanceValues::default();
        organization.hooks.insert(
            HOOK.to_owned(),
            HookPolicyOverride {
                enabled: Some(false),
                trusted: None,
            },
        );
        organization.locked_fields = vec![lock_path.clone()];
        let scope = ResolvedScope {
            grants_enforced: false,
            governance: Some(ResolvedGovernance {
                revision: 1,
                organization,
                team: GatewayGovernanceValues::default(),
                user: GatewayGovernanceValues::default(),
            }),
            tools: Vec::new(),
        };
        let org_a = GovernanceBinding {
            org_id: "org_a".into(),
            team_id: None,
        };
        let org_b = GovernanceBinding {
            org_id: "org_b".into(),
            team_id: None,
        };
        let managed_hooks = || async {
            app_store
                .list_hook_overrides()
                .await
                .unwrap()
                .into_iter()
                .filter(|record| record.managed && record.hook_key == HOOK)
                .count()
        };

        // Same org after a restart: the locks come back.
        scope
            .apply_governance_for(&preferences, &app_store, Some(&org_a))
            .await
            .unwrap();
        clear_published_locks();
        restore_managed_locks_with(&preferences, &app_store, true, Some(&org_a)).await;
        assert!(locked_above(GovernanceScope::User, &lock_path));

        // Rebound to org B: org A's layer, locks and hook overrides are gone.
        clear_published_locks();
        restore_managed_locks_with(&preferences, &app_store, true, Some(&org_b)).await;
        assert!(!locked_above(GovernanceScope::User, &lock_path));
        assert_eq!(managed_hooks().await, 0);
        assert!(preferences
            .get(crate::server::governance::MANAGED_GOVERNANCE_KEY)
            .await
            .unwrap()
            .is_none());

        // Restarted unbound / local-only: nothing managed survives either.
        scope
            .apply_governance_for(&preferences, &app_store, Some(&org_a))
            .await
            .unwrap();
        assert_eq!(managed_hooks().await, 1);
        clear_published_locks();
        restore_managed_locks_with(&preferences, &app_store, false, None).await;
        assert!(!locked_above(GovernanceScope::User, &lock_path));
        assert_eq!(managed_hooks().await, 0);
        assert!(preferences
            .get(MANAGED_GOVERNANCE_BINDING_KEY)
            .await
            .unwrap()
            .is_none());
    }

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
    fn grants_are_enforced_on_managed_nodes_and_opted_in_org_nodes_only() {
        let scope = |grants_enforced| ResolvedScope {
            governance: None,
            tools: vec![tool("mcp", "github", false)],
            grants_enforced,
        };
        let github = |tool: &ResolvedTool| tool.kind == "mcp" && tool.slug == "github";
        let linear = |tool: &ResolvedTool| tool.kind == "mcp" && tool.slug == "linear";
        // Unbound: local-first, nothing enforced.
        assert!(granted_in(false, false, None, linear));
        // Managed: deny until resolved, then exact grants only.
        assert!(!granted_in(true, false, None, github));
        assert!(granted_in(true, false, Some(&scope(false)), github));
        assert!(!granted_in(true, false, Some(&scope(false)), linear));
        // Org-bound desktop: only once the org requires approval.
        assert!(granted_in(false, true, Some(&scope(false)), linear));
        assert!(granted_in(false, true, None, linear));
        assert!(!granted_in(false, true, Some(&scope(true)), linear));
        assert!(granted_in(false, true, Some(&scope(true)), github));
    }

    #[test]
    fn skill_grants_match_the_full_granted_identity_only() {
        let catalog = tool("skill", "anthropics/skills/pdf", false);
        assert!(skill_identifier_granted(&catalog, "anthropics/skills/pdf"));
        assert!(skill_identifier_granted(
            &catalog,
            " anthropics/skills/pdf/ "
        ));
        // Paths compare exactly: on a case-sensitive host another case is
        // another repository.
        assert!(!skill_identifier_granted(&catalog, "Anthropics/Skills/PDF"));
        assert!(!skill_identifier_granted(&catalog, "attacker/evil/pdf"));
        assert!(!skill_identifier_granted(
            &catalog,
            "https://github.com/attacker/evil/tree/main/pdf"
        ));
        assert!(skill_identifier_granted(
            &tool("skill", "o/r", false),
            "o/r"
        ));

        // A short slug is a name, not a source identity: it authorizes nothing
        // on its own, least of all every source whose last segment is `pdf`.
        let short = tool("skill", "pdf", false);
        for identifier in [
            "pdf",
            "anthropics/skills/pdf",
            "https://github.com/attacker/evil/tree/main/pdf",
            "git@github.com:attacker/pdf",
            "/tmp/pdf",
        ] {
            assert!(
                !skill_identifier_granted(&short, identifier),
                "{identifier}"
            );
        }

        // A short slug with a configured source grants exactly that source.
        let sourced = ResolvedTool {
            config: serde_json::json!({
                "source": "https://github.com/anthropics/skills/tree/main/pdf"
            }),
            ..short
        };
        assert!(skill_identifier_granted(
            &sourced,
            "https://github.com/anthropics/skills/tree/main/pdf/"
        ));
        // Only the scheme and host are case-insensitive.
        assert!(skill_identifier_granted(
            &sourced,
            "HTTPS://GitHub.com/anthropics/skills/tree/main/pdf"
        ));
        assert!(!skill_identifier_granted(
            &sourced,
            "https://github.com/anthropics/skills/tree/main/PDF"
        ));
        assert!(!skill_identifier_granted(
            &sourced,
            "https://github.com/attacker/evil/tree/main/pdf"
        ));
        assert!(!skill_identifier_granted(&sourced, "attacker/evil/pdf"));
    }

    #[test]
    fn catalog_installs_are_granted_with_the_source_that_installs_them() {
        let granted = |grant: &ResolvedTool, origin, id| {
            skill_catalog_identity(origin, id)
                .is_some_and(|identity| skill_identity_granted(grant, &identity))
        };
        let skills_sh = SkillCatalogOrigin::Builtin("skills-sh");
        let clawhub = SkillCatalogOrigin::Builtin("clawhub");

        // A skills.sh grant covers that id on skills.sh only: ClawHub installs
        // by the id's final segment, so the same id there is another skill.
        let skills_sh_grant = tool("skill", "anthropics/skills/pdf", false);
        assert!(granted(
            &skills_sh_grant,
            skills_sh,
            "anthropics/skills/pdf"
        ));
        assert!(!granted(&skills_sh_grant, clawhub, "anthropics/skills/pdf"));
        assert!(!granted(
            &skills_sh_grant,
            SkillCatalogOrigin::Custom,
            "anthropics/skills/pdf"
        ));

        // Another built-in registry is granted source-qualified.
        let clawhub_grant = tool("skill", "catalog:clawhub/clawhub/pdf", false);
        assert!(granted(&clawhub_grant, clawhub, "clawhub/pdf"));
        assert!(!granted(&clawhub_grant, clawhub, "clawhub/other"));
        assert!(!granted(
            &clawhub_grant,
            SkillCatalogOrigin::Builtin("lobehub"),
            "clawhub/pdf"
        ));
        // A user-added source is never a fixed identity.
        assert!(!granted(
            &clawhub_grant,
            SkillCatalogOrigin::Custom,
            "clawhub/pdf"
        ));
        // The qualified identity is not reachable as a skills.sh id or a source.
        assert!(!granted(
            &clawhub_grant,
            skills_sh,
            "catalog:clawhub/clawhub/pdf"
        ));
        assert!(!skill_identifier_granted(
            &clawhub_grant,
            "catalog:clawhub/clawhub/pdf"
        ));
    }

    #[test]
    fn restored_grants_keep_an_org_bound_node_enforcing_until_a_live_resolution() {
        let restored = || ResolvedScope {
            governance: None,
            tools: vec![tool("mcp", "github", false)],
            grants_enforced: true,
        };
        let live_unenforced = || ResolvedScope {
            governance: None,
            tools: Vec::new(),
            grants_enforced: false,
        };
        let check = |managed, registered, live, restored, slug: &'static str| {
            let (bound, scope) = grant_inputs(managed, registered, live, restored);
            granted_in(managed, bound, scope.as_ref(), |tool: &ResolvedTool| {
                tool.kind == "mcp" && tool.slug == slug
            })
        };
        // Restarted during an outage: not yet registered, no live resolution.
        assert!(!check(false, false, None, Some(restored()), "linear"));
        assert!(check(false, false, None, Some(restored()), "github"));
        // Nothing persisted: still local-first.
        assert!(check(false, false, None, None, "linear"));
        // A live resolution supersedes the restored scope.
        assert!(check(
            false,
            true,
            Some(live_unenforced()),
            Some(restored()),
            "linear"
        ));
        // Managed nodes stay deny-by-default until a live resolution.
        assert!(!check(true, false, None, Some(restored()), "github"));
    }

    #[tokio::test]
    async fn enforced_grant_scope_survives_a_restart_for_the_same_binding_only() {
        let directory = tempfile::tempdir().unwrap();
        let preferences =
            crate::server::preferences::PreferencesStore::open(directory.path().join("p.db"))
                .unwrap();
        let org_a = GovernanceBinding {
            org_id: "org_a".into(),
            team_id: None,
        };
        let org_b = GovernanceBinding {
            org_id: "org_b".into(),
            team_id: None,
        };
        let mut sourced = tool("skill", "pdf", false);
        sourced.config = serde_json::json!({
            "source": "anthropics/skills/pdf",
            "env": { "UNRELATED": "value" }
        });
        let enforced = ResolvedScope {
            governance: None,
            tools: vec![tool("mcp", "github", false), sourced],
            grants_enforced: true,
        };

        let project_1 = GrantNarrowing {
            team_id: None,
            project_id: Some("p1".into()),
        };
        let project_2 = GrantNarrowing {
            team_id: None,
            project_id: Some("p2".into()),
        };
        let p1 = &project_1;
        let fingerprint_a = credential_fingerprint("credential-a");
        let key_a = Some(fingerprint_a.as_str());

        // Resolved before registration: provenance unknown, nothing recorded.
        persist_grant_scope(&preferences, &enforced, None, key_a, p1)
            .await
            .unwrap();
        assert!(load_persisted_grant_scope(&preferences, key_a, None, p1)
            .await
            .is_none());

        persist_grant_scope(&preferences, &enforced, Some(&org_a), key_a, p1)
            .await
            .unwrap();
        let stored = preferences.get(GRANT_SCOPE_KEY).await.unwrap().unwrap();
        assert!(
            !stored.contains("UNRELATED"),
            "entry config is not persisted"
        );
        assert!(
            !stored.contains("credential-a"),
            "only the credential's fingerprint is persisted"
        );
        // Restarted under another project: still enforcing, but the other
        // project's grants admit nothing until a live resolution.
        let (_, narrowed) = load_persisted_grant_scope(&preferences, key_a, None, &project_2)
            .await
            .expect("an enforcing binding keeps enforcing");
        assert!(narrowed.grants_enforced);
        assert!(narrowed.tools.is_empty());
        let (binding, scope) = load_persisted_grant_scope(&preferences, key_a, None, p1)
            .await
            .expect("restored while registration is pending");
        assert_eq!(binding, Some(org_a.clone()));
        assert!(scope.grants_enforced);
        assert_eq!(scope.allowed_slugs("mcp"), vec!["github".to_owned()]);
        assert!(scope
            .tools
            .iter()
            .any(|tool| tool.kind == "skill"
                && skill_identifier_granted(tool, "anthropics/skills/pdf")));
        assert!(
            load_persisted_grant_scope(&preferences, key_a, Some(&org_a), p1)
                .await
                .is_some()
        );

        // Another binding drops the record.
        assert!(
            load_persisted_grant_scope(&preferences, key_a, Some(&org_b), p1)
                .await
                .is_none()
        );
        assert!(preferences.get(GRANT_SCOPE_KEY).await.unwrap().is_none());

        // So does a node that is local-only now.
        persist_grant_scope(&preferences, &enforced, Some(&org_a), key_a, p1)
            .await
            .unwrap();
        assert!(load_persisted_grant_scope(&preferences, None, None, p1)
            .await
            .is_none());
        assert!(preferences.get(GRANT_SCOPE_KEY).await.unwrap().is_none());

        // An organization that stops enforcing removes the record.
        persist_grant_scope(&preferences, &enforced, Some(&org_a), key_a, p1)
            .await
            .unwrap();
        let relaxed = ResolvedScope {
            grants_enforced: false,
            ..enforced
        };
        persist_grant_scope(&preferences, &relaxed, Some(&org_a), key_a, p1)
            .await
            .unwrap();
        assert!(load_persisted_grant_scope(&preferences, key_a, None, p1)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn grant_scope_of_another_credential_never_restores() {
        let directory = tempfile::tempdir().unwrap();
        let preferences =
            crate::server::preferences::PreferencesStore::open(directory.path().join("p.db"))
                .unwrap();
        let org_a = GovernanceBinding {
            org_id: "org_a".into(),
            team_id: None,
        };
        let enforced = ResolvedScope {
            governance: None,
            tools: vec![tool("mcp", "github", false)],
            grants_enforced: true,
        };
        let narrowing = GrantNarrowing::default();
        let fingerprint_a = credential_fingerprint("credential-a");
        let fingerprint_b = credential_fingerprint("credential-b");
        assert_ne!(fingerprint_a, fingerprint_b);
        let (key_a, key_b) = (Some(fingerprint_a.as_str()), Some(fingerprint_b.as_str()));

        // No gateway key at resolution time: provenance unknown, nothing recorded.
        persist_grant_scope(&preferences, &enforced, Some(&org_a), None, &narrowing)
            .await
            .unwrap();
        assert!(preferences.get(GRANT_SCOPE_KEY).await.unwrap().is_none());

        // The same credential restores its grants across restarts.
        persist_grant_scope(&preferences, &enforced, Some(&org_a), key_a, &narrowing)
            .await
            .unwrap();
        let (_, scope) = load_persisted_grant_scope(&preferences, key_a, None, &narrowing)
            .await
            .expect("same credential restores");
        assert_eq!(scope.allowed_slugs("mcp"), vec!["github".to_owned()]);

        // The key was replaced (e.g. with another organization's) and
        // registration is still pending: the former grants are dropped and the
        // node stays enforcing with nothing granted until a live resolution.
        let (binding, scope) = load_persisted_grant_scope(&preferences, key_b, None, &narrowing)
            .await
            .expect("another credential fails closed");
        assert!(binding.is_none(), "no registration may clear it");
        assert!(scope.grants_enforced);
        assert!(scope.tools.is_empty());
        let fail_closed = (binding, scope.clone());
        assert!(!restored_grants_stale(Some(&fail_closed), &org_a));
        let (bound, scope) = grant_inputs(false, false, None, Some(scope));
        assert!(!granted_in(false, bound, scope.as_ref(), |tool| {
            tool.kind == "mcp" && tool.slug == "github"
        }));
        // A second restart before any live resolution still fails closed: the
        // record is kept, never restored under this key.
        for current in [None, Some(&org_a)] {
            let (binding, scope) =
                load_persisted_grant_scope(&preferences, key_b, current, &narrowing)
                    .await
                    .expect("every boot under another credential fails closed");
            assert!(binding.is_none());
            assert!(scope.grants_enforced);
            assert!(scope.tools.is_empty());
        }
        // The original credential still restores its own grants.
        let (_, scope) = load_persisted_grant_scope(&preferences, key_a, None, &narrowing)
            .await
            .expect("the original credential restores");
        assert_eq!(scope.allowed_slugs("mcp"), vec!["github".to_owned()]);
        // A live resolution under the new credential replaces the record.
        persist_grant_scope(&preferences, &enforced, Some(&org_a), key_b, &narrowing)
            .await
            .unwrap();
        let (_, scope) = load_persisted_grant_scope(&preferences, key_b, None, &narrowing)
            .await
            .expect("the new credential restores its resolution");
        assert_eq!(scope.allowed_slugs("mcp"), vec!["github".to_owned()]);

        // Even once the binding is known and matches, another credential's
        // record does not restore.
        persist_grant_scope(&preferences, &enforced, Some(&org_a), key_a, &narrowing)
            .await
            .unwrap();
        let (_, scope) = load_persisted_grant_scope(&preferences, key_b, Some(&org_a), &narrowing)
            .await
            .expect("another credential fails closed");
        assert!(scope.tools.is_empty());

        // A record written before fingerprints existed matches no credential.
        let legacy = serde_json::json!({
            "binding": { "orgId": "org_a" },
            "tools": [{ "kind": "mcp", "slug": "github" }],
        });
        preferences
            .set(GRANT_SCOPE_KEY, &legacy.to_string())
            .await
            .unwrap();
        for _restart in 0..2 {
            let (_, scope) = load_persisted_grant_scope(&preferences, key_a, None, &narrowing)
                .await
                .expect("a legacy record fails closed on every boot");
            assert!(scope.grants_enforced);
            assert!(scope.tools.is_empty());
        }
        // A local-only node still drops it.
        assert!(
            load_persisted_grant_scope(&preferences, None, None, &narrowing)
                .await
                .is_none()
        );
        assert!(preferences.get(GRANT_SCOPE_KEY).await.unwrap().is_none());
    }

    #[test]
    fn registration_clears_only_grants_restored_for_another_binding() {
        let org_a = GovernanceBinding {
            org_id: "org_a".into(),
            team_id: None,
        };
        let org_b = GovernanceBinding {
            org_id: "org_b".into(),
            team_id: None,
        };
        let enforced = ResolvedScope {
            governance: None,
            tools: Vec::new(),
            grants_enforced: true,
        };
        let restored_a = (Some(org_a.clone()), enforced);
        assert!(!restored_grants_stale(None, &org_a));
        assert!(!restored_grants_stale(Some(&restored_a), &org_a));
        assert!(restored_grants_stale(Some(&restored_a), &org_b));
        // The fail-closed scope survives any registration.
        assert!(!restored_grants_stale(Some(&fail_closed_grants()), &org_b));
    }

    #[test]
    fn allowed_slugs_filters_by_kind() {
        let scope = ResolvedScope {
            grants_enforced: false,
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
            grants_enforced: false,
            governance: None,
            tools: vec![tool("composio", "github", true)],
        };
        assert!(with.has_grant_scoped_composio());

        // A Composio entry without a stored credential is not yet wired end-to-end.
        let without = ResolvedScope {
            grants_enforced: false,
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
            grants_enforced: false,
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

    /// Outages are retryable; any other refusal is a definite answer.
    #[test]
    fn permission_lookup_outages_are_distinguished_from_refusals() {
        use reqwest::StatusCode;
        for status in [
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::GATEWAY_TIMEOUT,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert!(permission_lookup_status_is_transient(status), "{status}");
        }
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
        ] {
            assert!(!permission_lookup_status_is_transient(status), "{status}");
        }
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

    fn test_master() -> ryu_crypto::FieldCipher {
        ryu_crypto::FieldCipher::new(&[11u8; 32])
    }

    fn test_gateway_cipher() -> ryu_crypto::ComponentCipher {
        ryu_crypto::ComponentCipher::from_subkey_b64(
            ryu_crypto::components::GATEWAY,
            "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw=",
        )
        .unwrap()
    }

    fn raw_contains(path: &std::path::Path, needle: &str) -> bool {
        String::from_utf8_lossy(&std::fs::read(path).unwrap()).contains(needle)
    }

    #[test]
    fn persist_and_load_split_tokens_roundtrip_sealed_at_0600() {
        let dir = tempfile::tempdir().unwrap();
        let control_path = dir.path().join(CONTROL_TOKEN_FILE);
        let relay_path = dir.path().join(RELAY_TOKEN_FILE);
        let master = test_master();
        let gateway = test_gateway_cipher();

        // Absent ⇒ None (a fresh node has no persisted durable).
        assert_eq!(load_durable_token_with(&control_path, Some(&master)), None);

        persist_split_tokens_with(
            &control_path,
            &relay_path,
            "rgw_control_persisted",
            "rgw_relay_persisted",
            &master,
            &gateway,
        )
        .unwrap();
        assert_eq!(
            load_durable_token_with(&control_path, Some(&master)).as_deref(),
            Some("rgw_control_persisted")
        );
        assert_eq!(
            load_durable_token_with(&relay_path, Some(&gateway)).as_deref(),
            Some("rgw_relay_persisted")
        );
        // The raw credentials never reach disk; the relay token carries the
        // Gateway envelope so the local Gateway can open it.
        assert!(!raw_contains(&control_path, "rgw_control_persisted"));
        assert!(!raw_contains(&relay_path, "rgw_relay_persisted"));
        assert!(raw_contains(&control_path, "enc:v1:"));
        assert!(raw_contains(&relay_path, "encc:v1:"));
        // A sealed file never reads with the wrong key or no key.
        assert_eq!(load_durable_token_with(&control_path, None), None);
        assert_eq!(load_durable_token_with(&relay_path, Some(&master)), None);

        // Persisting the same pair again leaves the files untouched.
        let before = std::fs::read(&control_path).unwrap();
        persist_split_tokens_with(
            &control_path,
            &relay_path,
            "rgw_control_persisted",
            "rgw_relay_persisted",
            &master,
            &gateway,
        )
        .unwrap();
        assert_eq!(std::fs::read(&control_path).unwrap(), before);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&control_path, &relay_path] {
                let mode = std::fs::metadata(path).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "credential file must be 0600");
            }
        }
    }

    #[test]
    fn legacy_plaintext_credentials_load_and_are_resealed_once() {
        let dir = tempfile::tempdir().unwrap();
        let control_path = dir.path().join(CONTROL_TOKEN_FILE);
        let ack_path = dir.path().join(BOOTSTRAP_ACK_TOKEN_FILE);
        std::fs::write(&control_path, "rgw_legacy_control\n").unwrap();
        std::fs::write(&ack_path, "rgw_legacy_bootstrap").unwrap();
        let master = test_master();
        for (path, token) in [
            (&control_path, "rgw_legacy_control"),
            (&ack_path, "rgw_legacy_bootstrap"),
        ] {
            assert_eq!(
                load_durable_token_with(path, Some(&master)).as_deref(),
                Some(token)
            );
            assert!(!raw_contains(path, token), "plaintext left after reseal");
            assert!(raw_contains(path, "enc:v1:"));
            assert_eq!(
                load_durable_token_with(path, Some(&master)).as_deref(),
                Some(token)
            );
        }
        // Without a key a legacy plaintext file still reads (and stays as is).
        let relay_path = dir.path().join(RELAY_TOKEN_FILE);
        std::fs::write(&relay_path, "rgw_legacy_relay").unwrap();
        assert_eq!(
            load_durable_token_with(&relay_path, None).as_deref(),
            Some("rgw_legacy_relay")
        );
        // A rewrite of the same value over legacy plaintext seals it.
        persist_single_token_with(&relay_path, "rgw_legacy_relay", &test_gateway_cipher()).unwrap();
        assert!(!raw_contains(&relay_path, "rgw_legacy_relay"));
    }

    #[test]
    fn persist_gateway_relay_token_replaces_atomically_and_keeps_private_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RELAY_TOKEN_FILE);
        let gateway = test_gateway_cipher();

        super::persist_single_token_with(&path, "rgw_relay_first", &gateway)
            .expect("initial relay token");
        assert_eq!(
            super::load_durable_token_with(&path, Some(&gateway)).as_deref(),
            Some("rgw_relay_first")
        );
        super::persist_single_token_with(&path, "rgw_relay_rotated", &gateway)
            .expect("rotated relay token");
        assert_eq!(
            super::load_durable_token_with(&path, Some(&gateway)).as_deref(),
            Some("rgw_relay_rotated")
        );
        assert!(!raw_contains(&path, "rgw_relay_rotated"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "credential file must be 0600");
        }
        let leftovers = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0, "temporary credential file left behind");
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

    fn deferred_body(
        scope: &str,
        team: Option<&str>,
        policy: Option<&[&str]>,
    ) -> PermissionsResponse {
        let mut principal = serde_json::json!({
            "userId": "u1",
            "orgId": "org-1",
            "role": "member",
            "teams": team
                .map(|id| vec![serde_json::json!({ "id": id, "orgId": "org-1", "role": "member" })])
                .unwrap_or_default(),
        });
        if let Some(ids) = policy {
            principal["policyTeamIds"] = serde_json::json!(ids);
        }
        serde_json::from_value(serde_json::json!({
            "permissions": [],
            "roleKeys": [],
            "principal": principal,
            "node": {
                "id": "node-1",
                "scope": scope,
                "ownerUserId": null,
                "teamId": team,
            },
        }))
        .unwrap()
    }

    fn bound_node(scope: NodeScope, team_id: Option<&str>) -> RegisteredNode {
        RegisteredNode {
            org: RegisteredOrg {
                id: "org-1".into(),
                name: "Org".into(),
                slug: None,
            },
            node_id: "node-1".into(),
            scope,
            team_id: team_id.map(Into::into),
            owner_user_id: None,
        }
    }

    #[tokio::test]
    async fn current_authorization_keeps_policy_teams_apart_from_narrowed_teams() {
        // A team node: the principal lists only the node's team, the policy
        // list carries every team the user holds in the org.
        let current = with_test_node_binding(
            true,
            Some(bound_node(NodeScope::Team, Some("eng"))),
            async {
                current_authorization_from_body(
                    "u1",
                    deferred_body("team", Some("eng"), Some(&["eng", "contractors"])),
                )
            },
        )
        .await
        .unwrap();
        assert_eq!(
            current
                .caller
                .teams
                .iter()
                .map(|team| team.id.as_str())
                .collect::<Vec<_>>(),
            vec!["eng"]
        );
        assert_eq!(
            current.policy_team_ids,
            Some(vec!["eng".to_owned(), "contractors".to_owned()])
        );
        // Without the explicit list a team node's policy teams are unknown.
        let older = with_test_node_binding(
            true,
            Some(bound_node(NodeScope::Team, Some("eng"))),
            async {
                current_authorization_from_body("u1", deferred_body("team", Some("eng"), None))
            },
        )
        .await
        .unwrap();
        assert_eq!(older.policy_team_ids, None);
        // An org node's principal already lists every team.
        let org = with_test_node_binding(true, Some(bound_node(NodeScope::Org, None)), async {
            let mut body = deferred_body("org", None, None);
            if let Some(principal) = body.principal.as_mut() {
                principal.teams.push(CurrentTeam {
                    id: "contractors".into(),
                    org_id: "org-1".into(),
                    role: "member".into(),
                });
            }
            current_authorization_from_body("u1", body)
        })
        .await
        .unwrap();
        assert_eq!(org.policy_team_ids, Some(vec!["contractors".to_owned()]));
    }
}
