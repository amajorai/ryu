//! Organization-managed runtime policy consumed from the control plane.
//!
//! Two control-plane decisions land here, both only for an org-bound node:
//!
//! - **Tool policy (C2).** `policy.rules.allowedTools`, `deniedTools` and
//!   `allowedMcpServers` from `GET /api/control-plane/gateway/resolve`. Every
//!   entry is a glob (`*` any run of characters, `?` one character, ASCII
//!   case-insensitive) matched against the canonical `server.tool` id or the
//!   MCP server id. A deny match always wins; a non-empty allowlist denies
//!   everything it does not match. The resolve snapshot only carries the node
//!   credential's org/team (or personal owner) layers, so Core resolves the
//!   rules per verified caller (`GET /api/control-plane/gateway/tool-policy`,
//!   which adds that user's layer) and enforces them at the final MCP/tool
//!   dispatch boundary, failing closed when a known caller's rules have never
//!   resolved. The approval engine also consults the node snapshot (Layer C),
//!   so an approval can never authorize a tool the organization denied.
//! - **Organization feature toggles** (`apps.install`, `plugins.marketplace`,
//!   `engines.update`, ...). Resolved per verified user and enforced at the
//!   matching Core routes; the desktop reads the same values to hide controls.
//!
//! Unbound (local, personal) nodes never receive a snapshot, so every check is a
//! no-op there and local-first behavior is unchanged. A failed refresh keeps the
//! last-known-good snapshot rather than dropping to "unrestricted".

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Org feature: installing apps/plugins on a node.
pub const FEATURE_APPS_INSTALL: &str = "apps.install";
/// Org feature: installing from the plugin marketplace/catalog.
pub const FEATURE_PLUGINS_MARKETPLACE: &str = "plugins.marketplace";
/// Org feature: updating (force-reinstalling) local engines.
pub const FEATURE_ENGINES_UPDATE: &str = "engines.update";

/// How long a per-user feature resolution is served before it is refreshed.
const FEATURE_TTL: Duration = Duration::from_secs(60);
/// One audit row per denied tool id per window, so a looping agent cannot
/// flood the gateway audit log with identical denials.
const DENIAL_AUDIT_WINDOW: Duration = Duration::from_secs(60);

/// The tool-governance slice of the organization's effective policy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgToolRules {
    pub allowed_tools: Vec<String>,
    pub denied_tools: Vec<String>,
    pub allowed_mcp_servers: Vec<String>,
}

impl OrgToolRules {
    pub fn is_empty(&self) -> bool {
        self.allowed_tools.is_empty()
            && self.denied_tools.is_empty()
            && self.allowed_mcp_servers.is_empty()
    }
}

/// The last successful policy resolution for this node's bound organization.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgPolicySnapshot {
    pub organization_id: String,
    /// The control plane's `policyVersion` (hash of effective policy + limits).
    /// `None` for a control plane that predates the field.
    pub version: Option<String>,
    pub rules: OrgToolRules,
    /// Policy fields locked by an organization/team administrator.
    pub locked_fields: Vec<String>,
}

/// Wire shape of the resolve response's `policy` object. Every field tolerates
/// absence and an explicit `null`, since older control planes omit the C2 keys.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEffectivePolicy {
    #[serde(default)]
    pub locked_fields: Option<Vec<String>>,
    #[serde(default)]
    pub rules: Option<WirePolicyRules>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePolicyRules {
    #[serde(default)]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub denied_tools: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_mcp_servers: Option<Vec<String>>,
}

fn clean_patterns(values: Option<Vec<String>>) -> Vec<String> {
    let mut patterns: Vec<String> = values
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .collect();
    patterns.sort();
    patterns.dedup();
    patterns
}

impl OrgPolicySnapshot {
    pub fn from_wire(
        organization_id: String,
        version: Option<String>,
        policy: Option<WireEffectivePolicy>,
    ) -> Self {
        let policy = policy.unwrap_or_default();
        let rules = policy.rules.unwrap_or_default();
        Self {
            organization_id,
            version: version.filter(|value| !value.trim().is_empty()),
            rules: OrgToolRules {
                allowed_tools: clean_patterns(rules.allowed_tools),
                denied_tools: clean_patterns(rules.denied_tools),
                allowed_mcp_servers: clean_patterns(rules.allowed_mcp_servers),
            },
            locked_fields: clean_patterns(policy.locked_fields),
        }
    }
}

static SNAPSHOT: RwLock<Option<Arc<OrgPolicySnapshot>>> = RwLock::new(None);

/// Publish a freshly resolved policy. Returns `true` when the effective policy
/// changed (by `policyVersion`, or by content when the version is absent).
pub fn set_snapshot(snapshot: OrgPolicySnapshot) -> bool {
    let Ok(mut slot) = SNAPSHOT.write() else {
        return false;
    };
    let changed =
        slot.as_deref()
            .is_none_or(|current| match (&current.version, &snapshot.version) {
                (Some(previous), Some(next)) => {
                    previous != next || current.organization_id != snapshot.organization_id
                }
                _ => current != &snapshot,
            });
    *slot = Some(Arc::new(snapshot));
    changed
}

/// The current snapshot, `None` on an unbound node or before the first
/// successful resolution.
pub fn current() -> Option<Arc<OrgPolicySnapshot>> {
    SNAPSHOT.read().ok().and_then(|slot| slot.clone())
}

/// Drop the snapshot when the node loses its organization binding.
pub fn clear() {
    if let Ok(mut slot) = SNAPSHOT.write() {
        *slot = None;
    }
    invalidate_features();
}

/// ASCII case-insensitive glob match: `*` matches any run (including `.` and
/// `/`), `?` matches exactly one character. Everything else is literal.
pub fn glob_match(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().map(|c| c.to_ascii_lowercase()).collect();
    let value: Vec<char> = value.chars().map(|c| c.to_ascii_lowercase()).collect();
    let (mut p, mut v) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut star_value = 0usize;
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            star_value = v;
            p += 1;
        } else if let Some(star_at) = star {
            p = star_at + 1;
            star_value += 1;
            v = star_value;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

fn first_match<'a>(patterns: &'a [String], value: &str) -> Option<&'a str> {
    patterns
        .iter()
        .find(|pattern| glob_match(pattern, value))
        .map(String::as_str)
}

/// Outcome of evaluating one tool call against the organization's tool rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolPolicyDecision {
    Allow,
    Deny { reason: String },
}

/// Pure evaluation. `mcp_server` is the external MCP server that serves the
/// tool, when it is one; built-in tools pass `None` and are governed by the
/// tool globs only.
pub fn evaluate_tool(
    rules: &OrgToolRules,
    tool_id: &str,
    mcp_server: Option<&str>,
) -> ToolPolicyDecision {
    if let Some(pattern) = first_match(&rules.denied_tools, tool_id) {
        return ToolPolicyDecision::Deny {
            reason: format!(
                "tool '{tool_id}' is denied by your organization's tool policy (rule '{pattern}')"
            ),
        };
    }
    if let Some(server) = mcp_server {
        if !rules.allowed_mcp_servers.is_empty()
            && first_match(&rules.allowed_mcp_servers, server).is_none()
        {
            return ToolPolicyDecision::Deny {
                reason: format!(
                    "MCP server '{server}' is not in your organization's allowed MCP servers"
                ),
            };
        }
    }
    if !rules.allowed_tools.is_empty() && first_match(&rules.allowed_tools, tool_id).is_none() {
        return ToolPolicyDecision::Deny {
            reason: format!("tool '{tool_id}' is not in your organization's allowed tools"),
        };
    }
    ToolPolicyDecision::Allow
}

/// Whether a tool should be listed to a model at all under `layers` (the rule
/// sets from [`visible_tool_rules`]). Every layer must allow it, matching the
/// deny-overrides combining of [`check_tool_for_caller`]; no layers lists
/// everything. Mirrors [`evaluate_tool`] without recording an audit row.
pub fn tool_visible_under(
    layers: &[Arc<OrgToolRules>],
    tool_id: &str,
    mcp_server: Option<&str>,
) -> bool {
    layers
        .iter()
        .all(|rules| evaluate_tool(rules, tool_id, mcp_server) == ToolPolicyDecision::Allow)
}

/// Turn one tool-rule resolution into a dispatch decision. A resolution error
/// (org-bound node, no rules ever resolved for this caller) fails closed.
fn tool_decision(
    resolution: Result<Option<&OrgToolRules>, &str>,
    tool_id: &str,
    mcp_server: Option<&str>,
) -> Result<(), (&'static str, String)> {
    match resolution {
        Ok(None) => Ok(()),
        Ok(Some(rules)) => match evaluate_tool(rules, tool_id, mcp_server) {
            ToolPolicyDecision::Allow => Ok(()),
            ToolPolicyDecision::Deny { reason } => Err(("org_policy.tool_denied", reason)),
        },
        Err(error) => Err((
            "org_policy.tool_policy_unavailable",
            format!("tool '{tool_id}' was not run: {error}"),
        )),
    }
}

/// Deny-overrides across the node snapshot's org/team rules (`base`, refreshed
/// by `/gateway/resolve`) and the caller's resolution. The caller's rules may be
/// last-known-good while `/gateway/tool-policy` is failing, so a deny, a
/// narrowed allowlist, or a narrowed MCP-server allowlist that reached the
/// snapshot binds every caller from the next call, as the Gateway's
/// `policy_for_caller` does for model rules.
fn combined_tool_decision(
    base: Option<&OrgToolRules>,
    caller: Result<Option<&OrgToolRules>, &str>,
    tool_id: &str,
    mcp_server: Option<&str>,
) -> Result<(), (&'static str, String)> {
    tool_decision(Ok(base), tool_id, mcp_server)?;
    tool_decision(caller, tool_id, mcp_server)
}

/// The node snapshot a verified caller's own rules are combined with. `None`
/// without a caller (their rules already are the snapshot), on an unbound node,
/// before the first resolution, or for a snapshot of another organization.
fn caller_base_snapshot(user_id: Option<&str>) -> Option<Arc<OrgPolicySnapshot>> {
    user_id.filter(|value| !value.trim().is_empty())?;
    let node = crate::sidecar::control_plane::registered_node()?;
    current().filter(|snapshot| snapshot.organization_id == node.org.id)
}

/// Enforce the organization's tool rules for the verified caller at a dispatch
/// boundary. `user_id` is the server-derived principal (verified HTTP caller or
/// host-conversation owner), never a client-supplied id; `None` applies the
/// node credential's org/team rules. A verified caller is also held to the
/// current node snapshot (deny-overrides). A no-op on an unbound node. A denial
/// is audited (rate-limited) and returned as a user-readable reason.
pub async fn check_tool_for_caller(
    user_id: Option<&str>,
    tool_id: &str,
    mcp_server: Option<&str>,
) -> Result<(), String> {
    let resolution = effective_tool_rules(user_id).await;
    // Read the snapshot after the await so one refreshed during the per-caller
    // fetch binds this call.
    let base = caller_base_snapshot(user_id);
    let resolution = match &resolution {
        Ok(rules) => Ok(rules.as_deref()),
        Err(error) => Err(error.as_str()),
    };
    combined_tool_decision(
        base.as_deref().map(|snapshot| &snapshot.rules),
        resolution,
        tool_id,
        mcp_server,
    )
    .map_err(|(action, reason)| {
        record_denial(action, tool_id, &reason);
        reason
    })
}

fn denial_audit_log() -> &'static Mutex<HashMap<String, Instant>> {
    static LOG: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn should_audit(key: &str) -> bool {
    let Ok(mut log) = denial_audit_log().lock() else {
        return true;
    };
    let now = Instant::now();
    log.retain(|_, at| now.duration_since(*at) < DENIAL_AUDIT_WINDOW);
    if log.contains_key(key) {
        return false;
    }
    log.insert(key.to_owned(), now);
    true
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

/// Best-effort gateway control audit row for an org-policy denial. Mirrors the
/// server's `record_gateway_control` sink (`POST /v1/audit/control`) but needs
/// no request state, so dispatch paths without a `ServerState` can use it.
pub fn record_denial(action: &'static str, target: &str, reason: &str) {
    if !should_audit(&format!("{action}:{target}")) {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let target = bounded(target, 200);
    let summary = bounded(reason, 400);
    handle.spawn(async move {
        use crate::sidecar::gateway::{gateway_admin_key, gateway_url};
        static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
        let client = CLIENT.get_or_init(reqwest::Client::new);
        let mut request = client
            .post(format!(
                "{}/v1/audit/control",
                gateway_url().trim_end_matches('/')
            ))
            .timeout(Duration::from_millis(1500))
            .json(&serde_json::json!({
                "action": action,
                "target": target,
                "summary": summary,
            }));
        if let Some(token) = gateway_admin_key() {
            request = request.bearer_auth(token);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => tracing::warn!(
                action,
                status = %response.status(),
                "org policy denial audit returned a non-success status"
            ),
            Err(error) => tracing::warn!(
                action,
                error = %error,
                "org policy denial audit write failed"
            ),
        }
    });
}

// ── Organization feature toggles ─────────────────────────────────────────────

struct FeatureCacheEntry {
    at: Instant,
    features: BTreeMap<String, bool>,
}

fn feature_cache() -> &'static Mutex<HashMap<String, FeatureCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, FeatureCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stale_instant() -> Instant {
    Instant::now()
        .checked_sub(FEATURE_TTL + Duration::from_secs(1))
        .unwrap_or_else(Instant::now)
}

/// Forget every cached per-caller resolution, feature toggles and tool rules
/// alike (policy change, rebinding). Values stay as last-known-good, but the
/// next read refreshes them.
pub fn invalidate_features() {
    if let Ok(mut cache) = feature_cache().lock() {
        for entry in cache.values_mut() {
            entry.at = stale_instant();
        }
    }
    if let Ok(mut cache) = tool_rules_cache().lock() {
        for entry in cache.values_mut() {
            entry.at = stale_instant();
        }
    }
}

/// Cache key for one caller's features under one node binding.
fn feature_cache_key(org_id: &str, team_id: Option<&str>, user_id: Option<&str>) -> String {
    format!(
        "{org_id}\0{}\0{}",
        team_id.unwrap_or_default(),
        user_id.unwrap_or_default()
    )
}

fn cached_features(key: &str, fresh_only: bool) -> Option<BTreeMap<String, bool>> {
    let cache = feature_cache().lock().ok()?;
    let entry = cache.get(key)?;
    (!fresh_only || entry.at.elapsed() < FEATURE_TTL).then(|| entry.features.clone())
}

/// Effective organization features for the verified caller (or the
/// organization default when `user_id` is `None`).
///
/// - `Ok(None)`: the node is not bound to an organization; nothing to enforce.
/// - `Ok(Some(map))`: fresh or last-known-good values.
/// - `Err(_)`: the node is org-bound but no resolution has ever succeeded for
///   this caller. Callers enforcing a toggle fail closed on this.
pub async fn effective_features(
    user_id: Option<&str>,
) -> Result<Option<BTreeMap<String, bool>>, String> {
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return Ok(None);
    };
    // Keyed by the node's org + team binding as well as the caller, so a
    // rebind to another org can never serve (or fall back to) the previous
    // org's toggles.
    let key = feature_cache_key(&node.org.id, node.team_id.as_deref(), user_id);
    if let Some(features) = cached_features(&key, true) {
        return Ok(Some(features));
    }
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(reqwest::Client::new);
    match crate::sidecar::control_plane::resolve_org_features(client, user_id).await {
        Ok(features) => {
            if let Ok(mut cache) = feature_cache().lock() {
                cache.insert(
                    key,
                    FeatureCacheEntry {
                        at: Instant::now(),
                        features: features.clone(),
                    },
                );
            }
            Ok(Some(features))
        }
        Err(error) => {
            if let Some(features) = cached_features(&key, false) {
                tracing::debug!("org features refresh failed ({error}); serving last known good");
                return Ok(Some(features));
            }
            Err(format!(
                "organization feature policy is unavailable ({error})"
            ))
        }
    }
}

// ── Per-caller tool rules ────────────────────────────────────────────────────
//
// `/gateway/resolve` sees only the node credential, so the process-global
// snapshot carries the org/team (or personal owner) layers and never the user
// layer of whoever is calling a shared node. Tool rules are therefore resolved
// per verified caller, keyed and cached exactly like the feature toggles.

struct ToolRulesCacheEntry {
    at: Instant,
    rules: Arc<OrgToolRules>,
}

fn tool_rules_cache() -> &'static Mutex<HashMap<String, ToolRulesCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ToolRulesCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Seed one caller's resolved tool rules, as a fresh `/gateway/tool-policy`
/// answer would, so a dispatch test can exercise the member layer without the
/// control plane. Tests only.
#[cfg(test)]
pub(crate) fn seed_caller_tool_rules_for_tests(
    org_id: &str,
    team_id: Option<&str>,
    user_id: &str,
    rules: OrgToolRules,
) {
    if let Ok(mut cache) = tool_rules_cache().lock() {
        cache.insert(
            feature_cache_key(org_id, team_id, Some(user_id)),
            ToolRulesCacheEntry {
                at: Instant::now(),
                rules: Arc::new(rules),
            },
        );
    }
}

fn cached_tool_rules(key: &str, fresh_only: bool) -> Option<Arc<OrgToolRules>> {
    let cache = tool_rules_cache().lock().ok()?;
    let entry = cache.get(key)?;
    (!fresh_only || entry.at.elapsed() < FEATURE_TTL).then(|| Arc::clone(&entry.rules))
}

/// The control plane answered a per-caller tool-policy request and refused it
/// (`/gateway/tool-policy` answers 400 for a caller who is no longer a member,
/// 401 for a dead credential, 403 for an out-of-scope caller or project). Unlike
/// an outage this is authoritative, so the caller's last-known-good rules are
/// dropped rather than served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallerPolicyRefused(pub u16);

impl std::fmt::Display for CallerPolicyRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the control plane refused this caller (HTTP {})", self.0)
    }
}

impl std::error::Error for CallerPolicyRefused {}

impl CallerPolicyRefused {
    /// The refusal a status represents: exactly the 400/401/403 that
    /// `/gateway/tool-policy` emits as a decision. Every other status, including
    /// a route-level 404 from a rolling deploy or ingress, 408/429
    /// back-pressure, and 5xx, is an outage that keeps last-known-good.
    pub fn from_status(status: reqwest::StatusCode) -> Option<Self> {
        matches!(
            status,
            reqwest::StatusCode::BAD_REQUEST
                | reqwest::StatusCode::UNAUTHORIZED
                | reqwest::StatusCode::FORBIDDEN
        )
        .then_some(Self(status.as_u16()))
    }
}

/// Resolve one caller's tool rules under one node binding: fresh cache, else
/// `fetch`, else (only when the control plane could not answer) last-known-good,
/// else an error the dispatch boundary fails closed on. A [`CallerPolicyRefused`]
/// from `fetch` drops the caller's cached rules, so a removed member is denied
/// from the next refresh instead of keeping their old rules.
async fn resolve_tool_rules_at<Fetch, Pending>(
    org_id: &str,
    team_id: Option<&str>,
    user_id: &str,
    fetch: Fetch,
) -> Result<Arc<OrgToolRules>, String>
where
    Fetch: FnOnce() -> Pending,
    Pending: std::future::Future<Output = anyhow::Result<OrgToolRules>>,
{
    let key = feature_cache_key(org_id, team_id, Some(user_id));
    if let Some(rules) = cached_tool_rules(&key, true) {
        return Ok(rules);
    }
    match fetch().await {
        Ok(rules) => {
            let rules = Arc::new(rules);
            if let Ok(mut cache) = tool_rules_cache().lock() {
                cache.insert(
                    key,
                    ToolRulesCacheEntry {
                        at: Instant::now(),
                        rules: Arc::clone(&rules),
                    },
                );
            }
            Ok(rules)
        }
        Err(error) if error.downcast_ref::<CallerPolicyRefused>().is_some() => {
            if let Ok(mut cache) = tool_rules_cache().lock() {
                cache.remove(&key);
            }
            tracing::info!("org tool policy refused ({error}); dropped cached rules");
            Err(format!(
                "your organization's tool policy denied this caller ({error})"
            ))
        }
        Err(error) => {
            if let Some(rules) = cached_tool_rules(&key, false) {
                tracing::debug!(
                    "org tool policy refresh failed ({error}); serving last known good"
                );
                return Ok(rules);
            }
            Err(format!(
                "your organization's tool policy is unavailable ({error})"
            ))
        }
    }
}

/// Effective organization tool rules for the verified caller.
///
/// - `Ok(None)`: the node is not organization-bound, or no caller is known and
///   the node snapshot has not resolved yet; nothing to enforce.
/// - `Ok(Some(rules))`: the caller's fresh or last-known-good rules. With
///   `user_id = None` (an autonomous call with no verified principal) these are
///   the node credential's org/team rules, matching the feature path's
///   organization default.
/// - `Err(_)`: org-bound, a caller is known, and no resolution has ever
///   succeeded for them. Dispatch fails closed on this.
pub async fn effective_tool_rules(
    user_id: Option<&str>,
) -> Result<Option<Arc<OrgToolRules>>, String> {
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return Ok(None);
    };
    let Some(user_id) = user_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(current().map(|snapshot| Arc::new(snapshot.rules.clone())));
    };
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(reqwest::Client::new);
    resolve_tool_rules_at(&node.org.id, node.team_id.as_deref(), user_id, || {
        crate::sidecar::control_plane::resolve_org_tool_policy(client, Some(user_id))
    })
    .await
    .map(Some)
}

/// Rule layers used to decide which tools to list; a tool is listed only when
/// every layer allows it, as dispatch decides. Listing is advisory (dispatch is
/// the boundary), so an unavailable per-caller resolution falls back to the
/// node snapshot rather than hiding every tool.
pub async fn visible_tool_rules(user_id: Option<&str>) -> Vec<Arc<OrgToolRules>> {
    let caller = match effective_tool_rules(user_id).await {
        Ok(rules) => rules,
        Err(_) => current().map(|snapshot| Arc::new(snapshot.rules.clone())),
    };
    let base = caller_base_snapshot(user_id).map(|snapshot| Arc::new(snapshot.rules.clone()));
    base.into_iter().chain(caller).collect()
}

/// Organization features a Core route requires. Every returned key must be
/// enabled for the caller. Only mutating installation/update routes are gated;
/// browsing stays available so the desktop can explain why a control is off.
pub fn features_for_route(
    method: &str,
    path: &str,
    query: Option<&str>,
) -> &'static [&'static str] {
    let segments: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    // Editing a custom MCP server changes the command or endpoint the node runs,
    // so it needs the same authority as adding one.
    if method == "PUT" {
        return match segments.as_slice() {
            ["", "api", "mcp", "servers", _] => &[FEATURE_APPS_INSTALL],
            _ => &[],
        };
    }
    if method != "POST" {
        return &[];
    }
    match segments.as_slice() {
        // An update fetches and installs new package code, so it is gated
        // exactly like the install it replaces; so are the catalog installs
        // for MCP servers and skills, which fetch from the same marketplace.
        ["", "api", "plugins", "catalog", "install"]
        | ["", "api", "marketplace", "packages", "install" | "update"]
        | ["", "api", "mcp", "catalog", "install"]
        | ["", "api", "skills", "catalog" | "packs", "install"] => &[FEATURE_PLUGINS_MARKETPLACE],
        ["", "api", "apps" | "plugins", "install"]
        | ["", "api", "plugins", "install-bundle"]
        | ["", "api", "apps" | "plugins", _, "install" | "update"]
        // Bringing new external code or endpoints onto the node outside the
        // marketplace: a custom MCP server, imported OpenAPI/GraphQL tools, and
        // a skill fetched from an arbitrary source.
        | ["", "api", "mcp", "servers"]
        | ["", "api", "tools", "import", "openapi" | "graphql"]
        | ["", "api", "skills", "install-from-source"] => &[FEATURE_APPS_INSTALL],
        ["", "api", "setup", _, "install"] if query_flag(query, "force") => {
            &[FEATURE_ENGINES_UPDATE]
        }
        _ => &[],
    }
}

fn query_flag(query: Option<&str>, name: &str) -> bool {
    query.is_some_and(|query| {
        query.split('&').any(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            key == name && matches!(value, "true" | "1")
        })
    })
}

/// Human label for a feature key used in denial messages.
pub fn feature_label(key: &str) -> &'static str {
    match key {
        FEATURE_APPS_INSTALL => "App installation",
        FEATURE_PLUGINS_MARKETPLACE => "Marketplace plugins",
        FEATURE_ENGINES_UPDATE => "Engine updates",
        _ => "This feature",
    }
}

/// Decide whether the caller may use every feature a route requires. Returns a
/// user-readable denial reason; `None` permits the request.
pub async fn route_denial(
    method: &str,
    path: &str,
    query: Option<&str>,
    user_id: Option<&str>,
) -> Option<String> {
    let required = features_for_route(method, path, query);
    if required.is_empty() {
        return None;
    }
    match effective_features(user_id).await {
        Ok(None) => None,
        Ok(Some(features)) => required
            .iter()
            .find(|key| features.get(**key).copied() == Some(false))
            .map(|key| {
                format!(
                    "{} is disabled by your organization's administrator",
                    feature_label(key)
                )
            }),
        Err(error) => Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(allowed: &[&str], denied: &[&str], servers: &[&str]) -> OrgToolRules {
        OrgToolRules {
            allowed_tools: allowed.iter().map(|v| (*v).to_owned()).collect(),
            denied_tools: denied.iter().map(|v| (*v).to_owned()).collect(),
            allowed_mcp_servers: servers.iter().map(|v| (*v).to_owned()).collect(),
        }
    }

    #[test]
    fn glob_matches_wildcards_case_insensitively() {
        assert!(glob_match("github.*", "github.create_issue"));
        assert!(glob_match("*.delete_*", "drive.delete_file"));
        assert!(glob_match("GitHub.?et_repo", "github.get_repo"));
        assert!(glob_match("*", "anything.at.all"));
        assert!(glob_match("io.github.acme/*", "io.github.acme/files"));
        assert!(!glob_match("github.*", "gitlab.create_issue"));
        assert!(!glob_match("github.get", "github.get_repo"));
        assert!(!glob_match("?", ""));
        assert!(glob_match("", ""));
    }

    /// Core and the Gateway (`apps/gateway/src/policy/tool_policy.rs`) replay
    /// the same golden cases, so their tool-policy evaluators cannot drift.
    #[test]
    fn evaluator_matches_the_shared_gateway_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../crates/gateway/contracts/fixtures/org-tool-policy-v1.json"
        ))
        .expect("fixture json");
        let cases = fixture["cases"].as_array().expect("fixture cases");
        assert!(!cases.is_empty());
        for case in cases {
            let wire: WirePolicyRules =
                serde_json::from_value(case["rules"].clone()).unwrap_or_default();
            let snapshot = OrgPolicySnapshot::from_wire(
                "org".to_owned(),
                None,
                Some(WireEffectivePolicy {
                    locked_fields: None,
                    rules: Some(wire),
                }),
            );
            let decision = evaluate_tool(
                &snapshot.rules,
                case["tool"].as_str().expect("tool"),
                case["mcpServer"].as_str(),
            );
            assert_eq!(
                decision == ToolPolicyDecision::Allow,
                case["allow"].as_bool().expect("allow"),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn empty_rules_allow_everything() {
        assert_eq!(
            evaluate_tool(&OrgToolRules::default(), "shell.exec", Some("shell")),
            ToolPolicyDecision::Allow
        );
    }

    #[test]
    fn deny_wins_over_allow() {
        let rules = rules(&["github.*"], &["github.delete_*"], &[]);
        assert_eq!(
            evaluate_tool(&rules, "github.get_repo", None),
            ToolPolicyDecision::Allow
        );
        let ToolPolicyDecision::Deny { reason } = evaluate_tool(&rules, "github.delete_repo", None)
        else {
            panic!("deny must win");
        };
        assert!(reason.contains("github.delete_*"));
        assert!(matches!(
            evaluate_tool(&rules, "slack.post", None),
            ToolPolicyDecision::Deny { .. }
        ));
    }

    #[test]
    fn mcp_server_allowlist_only_applies_to_external_servers() {
        let rules = rules(&[], &[], &["github", "io.acme/*"]);
        assert_eq!(
            evaluate_tool(&rules, "github.get_repo", Some("github")),
            ToolPolicyDecision::Allow
        );
        assert_eq!(
            evaluate_tool(&rules, "io.acme/files.read", Some("io.acme/files")),
            ToolPolicyDecision::Allow
        );
        assert!(matches!(
            evaluate_tool(&rules, "notion.search", Some("notion")),
            ToolPolicyDecision::Deny { .. }
        ));
        // Built-in tools are not MCP servers and stay governed by tool globs only.
        assert_eq!(
            evaluate_tool(&rules, "plans.submit", None),
            ToolPolicyDecision::Allow
        );
    }

    /// The control plane's `POLICY_DENY_ALL` (packages/db control-plane.model.ts):
    /// the effective allowlist when cascaded layers share nothing. It must survive
    /// wire cleaning and deny every tool and MCP server, never read as empty.
    #[test]
    fn deny_all_marker_from_a_disjoint_cascade_denies_everything() {
        let policy: WireEffectivePolicy = serde_json::from_value(serde_json::json!({
            "rules": {
                "allowedTools": ["<deny-all>"],
                "allowedMcpServers": ["<deny-all>"]
            }
        }))
        .expect("policy decodes");
        let snapshot = OrgPolicySnapshot::from_wire("org".to_owned(), None, Some(policy));
        assert!(!snapshot.rules.is_empty());
        for (tool, server) in [
            ("github.get_repo", Some("github")),
            ("linear.create_issue", Some("linear")),
            ("plans.submit", None),
        ] {
            assert!(
                matches!(
                    evaluate_tool(&snapshot.rules, tool, server),
                    ToolPolicyDecision::Deny { .. }
                ),
                "{tool} must be denied under a deny-all allowlist"
            );
        }
    }

    #[test]
    fn wire_policy_tolerates_missing_and_null_fields() {
        let policy: WireEffectivePolicy = serde_json::from_value(serde_json::json!({
            "lockedFields": ["deniedTools"],
            "rules": {
                "approvedModels": ["gpt-*"],
                "deniedTools": [" shell.* ", "", "shell.*"],
                "allowedTools": null
            }
        }))
        .expect("policy decodes");
        let snapshot =
            OrgPolicySnapshot::from_wire("org".to_owned(), Some("v1".to_owned()), Some(policy));
        assert_eq!(snapshot.rules.denied_tools, vec!["shell.*".to_owned()]);
        assert!(snapshot.rules.allowed_tools.is_empty());
        assert_eq!(snapshot.locked_fields, vec!["deniedTools".to_owned()]);
        let empty = OrgPolicySnapshot::from_wire("org".to_owned(), None, None);
        assert!(empty.rules.is_empty());
    }

    #[test]
    fn route_mapping_gates_install_and_update_mutations_only() {
        assert_eq!(
            features_for_route("POST", "/api/apps/install", None),
            &[FEATURE_APPS_INSTALL]
        );
        assert_eq!(
            features_for_route("POST", "/api/plugins/acme/install", None),
            &[FEATURE_APPS_INSTALL]
        );
        assert_eq!(
            features_for_route("POST", "/api/plugins/catalog/install", None),
            &[FEATURE_PLUGINS_MARKETPLACE]
        );
        assert_eq!(
            features_for_route("POST", "/api/marketplace/packages/install", None),
            &[FEATURE_PLUGINS_MARKETPLACE]
        );
        assert_eq!(
            features_for_route("POST", "/api/setup/llamacpp/install", Some("force=true")),
            &[FEATURE_ENGINES_UPDATE]
        );
        assert!(features_for_route("POST", "/api/setup/llamacpp/install", None).is_empty());
        assert!(features_for_route("GET", "/api/plugins/catalog", None).is_empty());
        assert!(features_for_route("POST", "/api/apps/acme/enable", None).is_empty());
        for (method, path) in [
            ("POST", "/api/mcp/servers"),
            ("PUT", "/api/mcp/servers/acme"),
            ("POST", "/api/tools/import/openapi"),
            ("POST", "/api/tools/import/graphql"),
            ("POST", "/api/skills/install-from-source"),
        ] {
            assert_eq!(
                features_for_route(method, path, None),
                &[FEATURE_APPS_INSTALL],
                "{method} {path}"
            );
        }
        assert!(features_for_route("GET", "/api/mcp/servers", None).is_empty());
        assert!(features_for_route("DELETE", "/api/mcp/servers/acme", None).is_empty());
    }

    #[test]
    fn feature_cache_never_serves_one_orgs_toggles_to_another() {
        let org_a = feature_cache_key("org_cache_a", None, Some("user-1"));
        let org_b = feature_cache_key("org_cache_b", None, Some("user-1"));
        let team_scoped = feature_cache_key("org_cache_a", Some("team-1"), Some("user-1"));
        assert_ne!(org_a, org_b);
        assert_ne!(org_a, team_scoped);
        assert_ne!(
            feature_cache_key("org_cache_a", None, Some("u")),
            feature_cache_key("org_cache_a", Some("u"), None)
        );
        feature_cache().lock().unwrap().insert(
            org_a.clone(),
            FeatureCacheEntry {
                at: Instant::now(),
                features: BTreeMap::from([(FEATURE_APPS_INSTALL.to_owned(), true)]),
            },
        );
        invalidate_features();
        // Org B (after a rebind) has no last-known-good of its own: nothing,
        // not org A's values, is available to fall back to.
        assert!(cached_features(&org_b, false).is_none());
        assert!(cached_features(&team_scoped, false).is_none());
        assert!(cached_features(&org_a, false).is_some());
        assert!(cached_features(&org_a, true).is_none(), "invalidated");
    }

    #[tokio::test]
    async fn tool_rules_resolve_per_caller_and_fail_closed() {
        let org = "org_tool_rules";
        let user_deny = || async { Ok(rules(&[], &["shell.*"], &["github"])) };
        // Alice's user layer denies shell.* even though the node snapshot
        // (org/team layers) never carried it.
        let alice = resolve_tool_rules_at(org, None, "alice", user_deny)
            .await
            .expect("alice resolves");
        assert!(matches!(
            tool_decision(Ok(Some(&alice)), "shell.exec", None),
            Err(("org_policy.tool_denied", _))
        ));
        assert!(tool_decision(Ok(Some(&alice)), "github.get_repo", Some("github")).is_ok());
        let alice_layers = [Arc::clone(&alice)];
        assert!(!tool_visible_under(&alice_layers, "shell.exec", None));
        assert!(!tool_visible_under(
            &alice_layers,
            "notion.search",
            Some("notion")
        ));
        assert!(tool_visible_under(&[], "shell.exec", None));

        // Bob shares the node but has his own (empty) layer.
        let bob = resolve_tool_rules_at(org, None, "bob", || async { Ok(OrgToolRules::default()) })
            .await
            .expect("bob resolves");
        assert!(tool_decision(Ok(Some(&bob)), "shell.exec", None).is_ok());

        // A fresh entry is served without asking the control plane again.
        let cached = resolve_tool_rules_at(org, None, "alice", || async {
            Err(anyhow::anyhow!("must not be called"))
        })
        .await
        .expect("fresh cache");
        assert_eq!(cached, alice);

        // After invalidation an outage serves last-known-good, never "allow all".
        invalidate_features();
        let stale = resolve_tool_rules_at(org, None, "alice", || async {
            Err(anyhow::anyhow!("offline"))
        })
        .await
        .expect("last known good");
        assert_eq!(stale.denied_tools, vec!["shell.*".to_owned()]);

        // A caller that never resolved, or the same user under another team
        // binding, has nothing to fall back to and fails closed.
        for (team, user) in [(None, "carol"), (Some("team-1"), "alice")] {
            let error = resolve_tool_rules_at(org, team, user, || async {
                Err(anyhow::anyhow!("offline"))
            })
            .await
            .expect_err("fails closed");
            let denied = tool_decision(Err(&error), "github.get_repo", None);
            assert!(matches!(
                denied,
                Err(("org_policy.tool_policy_unavailable", ref reason))
                    if reason.contains("github.get_repo") && reason.contains("offline")
            ));
        }
        assert!(tool_decision(Ok(None), "shell.exec", None).is_ok());
    }

    /// A caller's last-known-good rules (served while `/gateway/tool-policy`
    /// fails) cannot outlive a narrower node snapshot: deny-overrides applies the
    /// current org/team deny, tool allowlist, and MCP-server allowlist.
    #[test]
    fn stale_caller_rules_are_held_to_the_current_node_snapshot() {
        let stale_caller = rules(&[], &["shell.*"], &[]);
        let base = rules(&["github.*", "plans.*"], &["github.delete_*"], &["github"]);
        let decide = |tool: &str, server: Option<&str>| {
            combined_tool_decision(Some(&base), Ok(Some(&stale_caller)), tool, server)
        };
        for (tool, server) in [
            ("github.delete_repo", Some("github")),
            ("linear.create_issue", Some("linear")),
            ("notes.write", None),
        ] {
            assert!(
                matches!(decide(tool, server), Err(("org_policy.tool_denied", _))),
                "{tool} must be denied by the current snapshot"
            );
        }
        // The caller's own layer still binds, and a tool both allow runs.
        assert!(matches!(
            combined_tool_decision(
                Some(&rules(&[], &[], &[])),
                Ok(Some(&stale_caller)),
                "shell.exec",
                None
            ),
            Err(("org_policy.tool_denied", _))
        ));
        assert!(decide("github.get_repo", Some("github")).is_ok());
        assert!(decide("plans.submit", None).is_ok());
        // No snapshot: the caller's rules decide alone; unavailable fails closed.
        assert!(
            combined_tool_decision(None, Ok(Some(&stale_caller)), "plans.submit", None).is_ok()
        );
        assert!(matches!(
            combined_tool_decision(
                Some(&base),
                Err("offline"),
                "github.get_repo",
                Some("github")
            ),
            Err(("org_policy.tool_policy_unavailable", _))
        ));

        // Listing matches dispatch: every layer must allow a tool.
        let layers = [Arc::new(base.clone()), Arc::new(stale_caller.clone())];
        assert!(!tool_visible_under(
            &layers,
            "github.delete_repo",
            Some("github")
        ));
        assert!(!tool_visible_under(&layers, "shell.exec", None));
        assert!(!tool_visible_under(&layers, "notes.write", None));
        assert!(tool_visible_under(
            &layers,
            "github.get_repo",
            Some("github")
        ));
    }

    #[test]
    fn only_client_decisions_refuse_a_caller() {
        use reqwest::StatusCode;
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
        ] {
            assert_eq!(
                CallerPolicyRefused::from_status(status),
                Some(CallerPolicyRefused(status.as_u16())),
                "{status}"
            );
        }
        for status in [
            StatusCode::OK,
            StatusCode::NOT_FOUND,
            StatusCode::METHOD_NOT_ALLOWED,
            StatusCode::GONE,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert_eq!(CallerPolicyRefused::from_status(status), None, "{status}");
        }
    }

    #[tokio::test]
    async fn a_refused_caller_loses_last_known_good_tool_rules() {
        let org = "org_tool_rules_refusal";
        let resolved = resolve_tool_rules_at(org, None, "removed-member", || async {
            Ok(rules(&[], &["shell.*"], &[]))
        })
        .await
        .expect("member resolves");
        assert_eq!(resolved.denied_tools, vec!["shell.*".to_owned()]);

        // An outage keeps serving the member's last rules.
        invalidate_features();
        let stale = resolve_tool_rules_at(org, None, "removed-member", || async {
            Err(anyhow::anyhow!("offline"))
        })
        .await
        .expect("an outage serves last known good");
        assert_eq!(stale, resolved);

        // Removal: the control plane answers 400 for a non-member.
        invalidate_features();
        let refused = resolve_tool_rules_at(org, None, "removed-member", || async {
            Err(anyhow::Error::new(CallerPolicyRefused(400)))
        })
        .await
        .expect_err("a refusal denies");
        assert!(matches!(
            tool_decision(Err(&refused), "github.get_repo", None),
            Err(("org_policy.tool_policy_unavailable", ref reason)) if reason.contains("HTTP 400")
        ));

        // A later outage cannot revive the dropped rules.
        let after = resolve_tool_rules_at(org, None, "removed-member", || async {
            Err(anyhow::anyhow!("offline"))
        })
        .await;
        assert!(
            after.is_err(),
            "a refused caller stays denied through an outage"
        );
    }

    #[test]
    fn update_and_catalog_install_routes_cannot_bypass_install_toggles() {
        for path in ["/api/apps/acme/update", "/api/plugins/acme/update/"] {
            assert_eq!(
                features_for_route("POST", path, None),
                &[FEATURE_APPS_INSTALL],
                "{path}"
            );
        }
        for path in [
            "/api/marketplace/packages/update",
            "/api/mcp/catalog/install",
            "/api/skills/catalog/install",
            "/api/skills/packs/install",
        ] {
            assert_eq!(
                features_for_route("POST", path, None),
                &[FEATURE_PLUGINS_MARKETPLACE],
                "{path}"
            );
        }
        // Reads and lifecycle toggles that fetch no code stay ungated.
        assert!(features_for_route("GET", "/api/mcp/updates", None).is_empty());
        assert!(features_for_route("POST", "/api/plugins/acme/uninstall", None).is_empty());
    }
}
