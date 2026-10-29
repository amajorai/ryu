use super::*;

/// Constant-time string equality — no early return on the first differing byte, so
/// comparing a caller-supplied key against the configured master key leaks no timing
/// signal about how many leading bytes matched. Length mismatch short-circuits (key
/// length is not secret). The Gateway defaults to a `0.0.0.0` bind, making a naive
/// `==` a remotely-observable side channel.
pub(crate) fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Verify the Core-minted proof on an agent-scoped Gateway route.
///
/// Dynamic `rgw_` credentials are tenant credentials, not trusted-forwarder
/// credentials. The proof makes the agent identity an assertion from Core,
/// bound to the exact bearer that authenticated this request, instead of a
/// caller-controlled header that could move spend between agents.
pub(super) fn verify_agent_route_proof(
    raw_api_key: Option<&str>,
    agent_id: &str,
    proof: &str,
    core_proof_key: Option<&str>,
) -> bool {
    type AgentRouteMac = Hmac<Sha256>;

    let Some(raw_api_key) = raw_api_key else {
        return false;
    };
    let key = raw_api_key
        .strip_prefix("Bearer ")
        .unwrap_or(raw_api_key)
        .trim();
    if key.is_empty() || proof.trim().is_empty() {
        return false;
    }
    let Some(core_proof_key) = core_proof_key else {
        return false;
    };
    let Ok(expected) = hex::decode(proof.trim()) else {
        return false;
    };
    let bearer_fingerprint = ryu_gw_credentials::fingerprint(key);
    let Ok(mut mac) = AgentRouteMac::new_from_slice(core_proof_key.as_bytes()) else {
        return false;
    };
    mac.update(b"ryu-agent-route-v2\0");
    mac.update(bearer_fingerprint.as_bytes());
    mac.update(agent_id.as_bytes());
    mac.verify_slice(&expected).is_ok()
}

/// Env holding the fleet master the per-org Core proof keys derive from.
pub(super) const ENV_CORE_PROOF_MASTER_KEY: &str = "GATEWAY_CORE_PROOF_MASTER_KEY";

/// Core proof keys accepted for an organization: the directly configured
/// `GATEWAY_CORE_PROOF_KEY` (single-org gateways and nodes provisioned before
/// per-org keys), and the key derived for `org_id` from
/// `GATEWAY_CORE_PROOF_MASTER_KEY`. Removing the direct key from a hosted
/// gateway leaves only per-org keys, so one node's key cannot prove Core
/// identity for another organization.
pub(super) fn core_proof_keys_for_org(org_id: Option<&str>) -> Vec<String> {
    let configured = |name: &str| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    };
    let mut keys = Vec::new();
    if let Some(direct) = configured("GATEWAY_CORE_PROOF_KEY") {
        keys.push(direct);
    }
    if let (Some(master), Some(org_id)) = (
        configured(ENV_CORE_PROOF_MASTER_KEY),
        org_id.filter(|org| !org.is_empty()),
    ) {
        if let Ok(derived) = ryu_gw_credentials::derive_org_core_proof_key(&master, org_id) {
            keys.push(derived);
        }
    }
    keys
}

/// Env naming the one organization the direct `GATEWAY_CORE_PROOF_KEY` may
/// sign hosted `gwb1` credentials for (a single-org Gateway). Unset on a
/// multi-org fleet Gateway, where the direct key is shared by every legacy
/// node and therefore proves nothing about which org a `gwb1` names.
pub(super) const ENV_CORE_PROOF_KEY_ORG_ID: &str = "GATEWAY_CORE_PROOF_KEY_ORG_ID";

/// Core proof keys a hosted `gwb1` naming `org_id` must verify under.
///
/// Unlike [`core_proof_keys_for_org`] (where the proof key only attributes an
/// agent id next to an `rgw_` bearer that already fixed the org), a `gwb1`
/// is a complete credential that itself chooses the org to bill, and its org
/// id comes from the token being verified. So it verifies only under the key
/// derived for that org from `GATEWAY_CORE_PROOF_MASTER_KEY`, which no other
/// org's node holds. The shared direct key is accepted only on a single-org
/// Gateway whose configured org (`GATEWAY_CORE_PROOF_KEY_ORG_ID`) is that org.
pub(super) fn box_hosted_proof_keys(org_id: &str) -> Vec<String> {
    let configured = |name: &str| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    };
    box_hosted_proof_keys_from(
        configured("GATEWAY_CORE_PROOF_KEY").as_deref(),
        configured(ENV_CORE_PROOF_KEY_ORG_ID).as_deref(),
        configured(ENV_CORE_PROOF_MASTER_KEY).as_deref(),
        org_id,
    )
}

/// The pure half of [`box_hosted_proof_keys`].
pub(super) fn box_hosted_proof_keys_from(
    direct: Option<&str>,
    direct_org: Option<&str>,
    master: Option<&str>,
    org_id: &str,
) -> Vec<String> {
    let mut keys = Vec::new();
    if org_id.is_empty() {
        return keys;
    }
    if let Some(master) = master {
        if let Ok(derived) = ryu_gw_credentials::derive_org_core_proof_key(master, org_id) {
            keys.push(derived);
        }
    }
    if let (Some(direct), Some(direct_org)) = (direct, direct_org) {
        if direct_org.trim() == org_id {
            keys.push(direct.to_owned());
        }
    }
    keys
}

/// Product surface every `gwb1` request is attributed to.
pub(super) const BOX_FEATURE: &str = "box";
/// Control-plane route that reports an org's managed-credit budget by org id
/// (`GET {CONTROL_PLANE_URL}/api/gateway/orgs/:orgId/budget`).
pub(super) const BOX_ORG_BUDGET_PATH: &str = "/api/gateway/orgs";
/// How long a resolved org budget is reused for `gwb1` requests. The debit
/// path keeps the wallet's cached balance fresh in between.
pub(super) const BOX_ORG_BUDGET_TTL: std::time::Duration = std::time::Duration::from_secs(30);
/// Largest org-budget response read.
pub(super) const MAX_BOX_ORG_BUDGET_BYTES: usize = 64 * 1024;

/// The org id a `gwb1` token names, read from its payload WITHOUT verifying
/// it. Used only to pick the per-org Core proof keys the token must then
/// verify under; nothing from an unverified payload is trusted.
pub(super) fn box_token_org_hint(token: &str) -> Option<String> {
    let payload = token.strip_prefix("gwb1.")?.split('.').next()?;
    let bytes = hex::decode(payload).ok()?;
    // Parse with the scope's own serde shape (camelCase `orgId`) so the hint
    // can never drift from the field the signature covers.
    let scope: ryu_gw_credentials::BoxInferenceScope = serde_json::from_slice(&bytes).ok()?;
    valid_box_org_id(&scope.org_id).then_some(scope.org_id)
}

/// An org id safe to place in a control-plane path: 1–128 of `[A-Za-z0-9_-]`.
pub(super) fn valid_box_org_id(org_id: &str) -> bool {
    !org_id.is_empty()
        && org_id.len() <= 128
        && org_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// A `gwb1` request may name only the identity its scope was issued for.
pub(super) fn check_box_identity(
    scope: &ryu_gw_credentials::BoxInferenceScope,
    user_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<(), GatewayError> {
    if user_id.is_some_and(|id| Some(id) != scope.user_id.as_deref())
        || session_id.is_some_and(|id| id != scope.session_id)
    {
        return Err(GatewayError::Unauthorized(
            "Inference identity does not match the issued Box scope".to_owned(),
        ));
    }
    Ok(())
}

/// Audit label for a `gwb1` request. The raw token is never stored.
pub(super) fn box_api_key_label(scope: &ryu_gw_credentials::BoxInferenceScope) -> String {
    format!("box:{}:{}", scope.org_id, scope.box_id)
}

/// An org's managed-credit view, as the control plane reports it by org id.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BoxOrgBudget {
    #[serde(default)]
    pub(super) managed_inference: bool,
    #[serde(default)]
    pub(super) managed_tier_unavailable: bool,
    #[serde(default)]
    pub(super) remaining_budget_micro_usd: Option<i64>,
    #[serde(default)]
    pub(super) unrestricted_budget_micro_usd: Option<i64>,
    #[serde(default)]
    pub(super) pool_budgets_micro_usd: std::collections::HashMap<String, i64>,
    #[serde(default)]
    pub(super) openrouter_routing_enabled: bool,
}

/// The credit fields a `gwb1` tenant is gated on. Mirrors
/// `ResolvedOrg::metered_credit`: on a gateway that bills tenants, "not
/// managed" means "not funded", and an unreadable tier is an accounting
/// outage (503), never an empty wallet.
pub(super) fn box_tenant_credit(
    budget: &BoxOrgBudget,
    gateway_bills_tenants: bool,
) -> crate::policy::TenantCredit {
    use crate::policy::TenantCredit;
    if !gateway_bills_tenants || (budget.managed_inference && !budget.managed_tier_unavailable) {
        return TenantCredit {
            managed_inference: budget.managed_inference,
            remaining_budget_micro_usd: budget.remaining_budget_micro_usd,
            unrestricted_budget_micro_usd: budget.unrestricted_budget_micro_usd,
            pool_budgets_micro_usd: budget.pool_budgets_micro_usd.clone(),
            accounting_unavailable: false,
        };
    }
    if budget.managed_tier_unavailable {
        return box_accounting_unavailable();
    }
    TenantCredit {
        managed_inference: true,
        remaining_budget_micro_usd: Some(budget.remaining_budget_micro_usd.unwrap_or(0).min(0)),
        unrestricted_budget_micro_usd: Some(0),
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        accounting_unavailable: false,
    }
}

pub(super) fn box_accounting_unavailable() -> crate::policy::TenantCredit {
    crate::policy::TenantCredit {
        managed_inference: true,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        accounting_unavailable: true,
    }
}

/// Where and how the hosted org budget lookup authenticates.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct BoxBudgetSource {
    /// Control-plane root (a trailing `/api` is tolerated).
    pub(super) url: String,
    /// The header the service credential travels in.
    pub(super) header: &'static str,
    /// The gateway's service credential. Never logged.
    pub(super) secret: String,
}

impl std::fmt::Debug for BoxBudgetSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoxBudgetSource")
            .field("url", &self.url)
            .field("header", &self.header)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
thread_local! {
    /// Test-only control-plane endpoint for the org budget lookup, so tests
    /// never mutate the process environment other tests read.
    pub(super) static BOX_BUDGET_SOURCE_OVERRIDE: std::cell::RefCell<Option<BoxBudgetSource>> =
        const { std::cell::RefCell::new(None) };
}

/// The org budget lookup's endpoint and credential. The route answers for any
/// org, so it takes the fleet's service credential, never an org key:
///
/// 1. the credits hook's control plane and `RYU_CREDITS_INTERNAL_SECRET`
///    (the secret this gateway already debits any org with), sent as
///    `x-ryu-internal-secret`. A multi-tenant fleet has only this one;
/// 2. otherwise `CONTROL_PLANE_URL` and `GATEWAY_KEY` as `x-gateway-key`, for
///    a single-org gateway configured with that secret as its key.
pub(super) fn select_box_budget_source(
    credits: &crate::config::CreditsConfig,
    env: impl Fn(&str) -> Option<String>,
) -> Option<BoxBudgetSource> {
    let non_empty = |value: Option<String>| {
        value
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let credits_url = non_empty(Some(credits.base_url.clone()));
    let credits_secret = non_empty(credits.internal_secret.clone());
    if let (Some(url), Some(secret)) = (credits_url, credits_secret) {
        return Some(BoxBudgetSource {
            url,
            header: "x-ryu-internal-secret",
            secret,
        });
    }
    Some(BoxBudgetSource {
        url: non_empty(env("CONTROL_PLANE_URL"))?,
        header: "x-gateway-key",
        secret: non_empty(env("GATEWAY_KEY"))?,
    })
}

pub(super) fn box_budget_source(credits: &crate::config::CreditsConfig) -> Option<BoxBudgetSource> {
    #[cfg(test)]
    if let Some(source) = BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| cell.borrow().clone()) {
        return Some(source);
    }
    select_box_budget_source(credits, |name| std::env::var(name).ok())
}

/// Why a hosted org budget could not be read.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum BoxBudgetError {
    /// No control plane is configured on this gateway.
    NotConfigured,
    /// The control plane does not know the org (`404`).
    UnknownOrg,
    /// Transport failure, a non-404 error status, or an unreadable body.
    Unavailable,
}

pub(super) fn box_budget_cache() -> &'static dashmap::DashMap<String, (Instant, Arc<BoxOrgBudget>)>
{
    static CACHE: std::sync::OnceLock<dashmap::DashMap<String, (Instant, Arc<BoxOrgBudget>)>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(dashmap::DashMap::new)
}

/// The org's managed-credit view for a hosted `gwb1` request, cached for
/// [`BOX_ORG_BUDGET_TTL`]. Returns the view and when it was fetched.
pub(super) async fn box_org_budget(
    http: &reqwest::Client,
    credits: &crate::config::CreditsConfig,
    org_id: &str,
) -> Result<(Arc<BoxOrgBudget>, Instant), BoxBudgetError> {
    let source = box_budget_source(credits).ok_or(BoxBudgetError::NotConfigured)?;
    let control_plane_url = source.url.as_str();
    let cache_key = format!("{control_plane_url}\n{org_id}");
    if let Some(entry) = box_budget_cache().get(&cache_key) {
        let (fetched_at, budget) = entry.value();
        if fetched_at.elapsed() < BOX_ORG_BUDGET_TTL {
            return Ok((Arc::clone(budget), *fetched_at));
        }
    }
    let base = control_plane_url.trim_end_matches('/');
    let base = base.strip_suffix("/api").unwrap_or(base);
    let endpoint = format!("{base}{BOX_ORG_BUDGET_PATH}/{org_id}/budget");
    let mut response = http
        .get(&endpoint)
        .header(source.header, source.secret.as_str())
        .header(
            crate::policy::GATEWAY_INSTANCE_HEADER,
            crate::policy::gateway_instance_id(),
        )
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| BoxBudgetError::Unavailable)?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(BoxBudgetError::UnknownOrg);
    }
    if !response.status().is_success() {
        return Err(BoxBudgetError::Unavailable);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| BoxBudgetError::Unavailable)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_BOX_ORG_BUDGET_BYTES {
            return Err(BoxBudgetError::Unavailable);
        }
        body.extend_from_slice(&chunk);
    }
    let budget: BoxOrgBudget =
        serde_json::from_slice(&body).map_err(|_| BoxBudgetError::Unavailable)?;
    let fetched_at = Instant::now();
    let budget = Arc::new(budget);
    box_budget_cache().insert(cache_key, (fetched_at, Arc::clone(&budget)));
    Ok((budget, fetched_at))
}

pub(super) fn resolved_dynamic_agent_id(
    raw_api_key: Option<&str>,
    agent_id: Option<&str>,
    agent_proof: Option<&str>,
    core_proof_keys: &[String],
) -> Result<Option<String>, GatewayError> {
    match (agent_id, agent_proof) {
        (Some(agent_id), Some(proof))
            if core_proof_keys
                .iter()
                .any(|key| verify_agent_route_proof(raw_api_key, agent_id, proof, Some(key))) =>
        {
            Ok(Some(agent_id.to_owned()))
        }
        (Some(_), None) => Err(GatewayError::Unauthorized(
            "agent route proof is required for dynamic credentials".to_owned(),
        )),
        (Some(_), Some(_)) | (None, Some(_)) => Err(GatewayError::Unauthorized(
            "invalid agent route proof".to_owned(),
        )),
        (None, None) => Ok(None),
    }
}

/// Who a dynamically resolved `rgw_` request is, for identity and for limits.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct DynamicCaller {
    /// The request's user identity (`ctx.user_id`): only ever a verified JWT
    /// user. It selects user-owned resources (personal Composio entity,
    /// user-partitioned cache tenant, stored responses) and audit attribution.
    pub(super) user_id: Option<String>,
    /// The member the credential is bound to (a personal node's owner), for
    /// member caps, member spend, and the owner's narrowing policy only.
    pub(super) bound_user_id: Option<String>,
    /// Team scopes, the credential's bound team first so `ctx.team_id`
    /// names it.
    pub(super) team_ids: Vec<String>,
}

/// Bind a dynamically resolved `rgw_` request to its credential's scope as
/// well as any verified forwarded JWT. Limits are most-restrictive-wins, so
/// the credential binding only ever adds caps; it never removes a verified
/// caller's identity, and it never grants a user identity without one.
///
/// - A team-node credential (`team_id`) always counts against its team, so the
///   team's caps apply even when no JWT is sent. A verified caller keeps their
///   identity and teams on top of it, including an org admin operating a team
///   they are not on, or a member whose token carries no teams.
/// - A personal-node credential (`owner_user_id`) always counts against its
///   owner (`bound_user_id`) and the owner's teams as the control plane read
///   them (`owner_team_ids`), even when no JWT is sent. The owner becomes the
///   request's `user_id` only from the owner's own verified JWT, so the node
///   token alone never reaches the owner's personal resources. A JWT naming
///   anyone else is ignored, not refused: Desktop forwards whichever account
///   is signed in, and Core already limits personal nodes to their owner.
/// - An org-wide credential keeps the JWT-only attribution.
pub(super) fn bind_dynamic_caller(
    owner_user_id: Option<&str>,
    owner_team_ids: Option<&[String]>,
    team_id: Option<&str>,
    verified: Option<crate::policy::VerifiedUser>,
) -> DynamicCaller {
    let verified = match (owner_user_id, verified) {
        (Some(owner), Some(user)) if user.user_id != owner => None,
        (_, verified) => verified,
    };
    let mut team_ids: Vec<String> = team_id.map(str::to_owned).into_iter().collect();
    let scopes = owner_team_ids.unwrap_or_default().iter().chain(
        verified
            .as_ref()
            .map_or(&[][..], |user| user.team_ids.as_slice()),
    );
    for team in scopes {
        if !team_ids.contains(team) {
            team_ids.push(team.clone());
        }
    }
    DynamicCaller {
        user_id: verified.map(|user| user.user_id),
        bound_user_id: owner_user_id.map(str::to_owned),
        team_ids,
    }
}

/// Whether a dynamically resolved organization bearer is accompanied by Core's
/// separate trusted relay credential for that organization. The caller must
/// keep organization and resource scope from the resolved bearer; this header
/// alone is never an auth credential or a source of tenant identity.
pub fn has_core_proof_key(headers: &axum::http::HeaderMap, org_id: Option<&str>) -> bool {
    let Some(presented) = headers
        .get("x-ryu-core-key")
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    core_proof_keys_for_org(org_id)
        .iter()
        .any(|expected| core_proof_header_matches(presented, expected))
}

pub(super) fn core_proof_header_matches(presented: &str, expected: &str) -> bool {
    ct_eq(presented, expected)
}
