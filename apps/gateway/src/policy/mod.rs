//! Control-plane policy distribution and enforcement (U28).
//!
//! The gateway is the local data plane. On startup it authenticates to the
//! control plane with its own gateway key (the `rgw_` credential issued by
//! U27's `/orgs/:id/gateway-keys`) and fetches the **effective policy** for its
//! organization via `GET {control_plane}/api/control-plane/gateway/resolve`.
//! The control plane has already cascaded org/team/project/user layers and
//! honoured admin locks, so the data plane receives one resolved policy and
//! enforces it on every model call — it never re-derives the cascade and never
//! lets a lower level override an admin-locked field (that decision was made
//! upstream).
//!
//! Enforcement points (in `pipeline::pre_process`):
//!   - `approved_models`: if non-empty, the requested model must be on the list.
//!   - `locked_guardrails`: guardrails the org requires stay on (the firewall is
//!     forced enabled when any are present).
//!   - `allowed_regions`: provider/data regions permitted; routing must resolve a
//!     provider region before dispatch and rejects unknown regions.
//!
//! Tool rules (`allowed_tools` / `denied_tools`) are enforced in the Gateway's
//! tool loops through [`OrgToolGate`] (see `tool_policy`).

use std::time::Duration;

use serde::Deserialize;

mod cache;
mod drift;
mod tool_policy;
mod user_jwt;
mod user_policy;
pub use cache::{ResolveCache, ResolveErr};
pub use drift::{detect_drift, DriftWarning};
pub use tool_policy::{OrgToolGate, ToolDenialAudit};
pub use user_jwt::{UserJwtVerifier, VerifiedUser};
pub use user_policy::{policy_for_caller, UserPolicyCache, UserPolicyRules};

/// Env var with the control-plane base URL (no trailing `/api`).
const ENV_CONTROL_PLANE_URL: &str = "CONTROL_PLANE_URL";
/// Env var with this gateway's `rgw_` key used to authenticate to the control
/// plane.
const ENV_GATEWAY_KEY: &str = "GATEWAY_KEY";

/// The effective policy the data plane enforces. Mirrors the control plane's
/// `EffectivePolicy.rules` plus the locked-field list (advisory here: the
/// cascade already applied the locks).
#[derive(Debug, Clone, Deserialize)]
pub struct EffectivePolicy {
    #[serde(default)]
    pub zero_data_retention_enabled: bool,
    /// Whether the gateway has a verified effective policy. Standalone gateways
    /// use the available empty policy; an unavailable managed policy denies.
    #[serde(skip, default = "default_policy_available")]
    pub available: bool,
    /// Guardrail names that must stay enabled (e.g. "pii", "secrets").
    #[serde(default)]
    pub locked_guardrails: Vec<String>,
    /// Allowlist of model ids the gateway may route to. Empty = no restriction.
    #[serde(default)]
    pub approved_models: Vec<String>,
    #[serde(default)]
    pub approved_providers: Vec<String>,
    /// Provider/data regions permitted (e.g. "us", "eu"). Empty = no restriction.
    #[serde(default)]
    pub allowed_regions: Vec<String>,
    /// Tool-id globs the organization allows (C2). Empty = no restriction;
    /// non-empty denies everything unmatched. Enforced by [`OrgToolGate`].
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// Tool-id globs the organization denies (C2). A match always wins.
    #[serde(default)]
    pub denied_tools: Vec<String>,
    /// External MCP server globs the organization allows (C2). Empty = no
    /// restriction. Carried for parity; Core applies it at dispatch.
    #[serde(default)]
    pub allowed_mcp_servers: Vec<String>,
    /// The org-effective firewall overlay cascaded by the control plane (hosted
    /// hierarchical policy). `None` ⇒ no org override; the gateway's node base
    /// (and any standalone-local overlay) applies. Fed to
    /// [`crate::firewall::resolve::FirewallResolver`]. Wire key: top-level
    /// `firewall` on the resolve response; its own fields are snake_case.
    #[serde(default)]
    pub firewall: Option<crate::config::FirewallOverlay>,
    /// The node's team firewall overlay (tighten-only; see
    /// [`crate::firewall::resolve::PolicyBundle::team_firewall`]). Wire key:
    /// top-level `teamFirewall`.
    #[serde(default)]
    pub team_firewall: Option<crate::config::FirewallOverlay>,
    /// Per-agent firewall overlays for this org, keyed by agent id. Wire key:
    /// top-level `agentOverlays` (camelCase) on the resolve response.
    #[serde(default)]
    pub agent_overlays: std::collections::HashMap<String, crate::config::FirewallOverlay>,
    /// Whether the org lets managed (wallet-billed) traffic use hosted web
    /// search. An org admin turns it off with the `products.web_search`
    /// organization feature. Defaults to true so standalone gateways and control
    /// planes that predate the toggle keep today's behavior.
    #[serde(skip, default = "default_hosted_web_search_enabled")]
    pub hosted_web_search_enabled: bool,
    /// Whether the control plane accepts the dedicated `web_search` debit
    /// reason. One that predates it rejects an unknown reason with a 400, which
    /// marks the org's accounting unavailable and blocks its managed traffic, so
    /// hosted searches debit as `gateway_usage` until the resolve response
    /// advertises support. False for standalone gateways and older control planes.
    #[serde(skip)]
    pub web_search_debit_reason: bool,
}

fn default_policy_available() -> bool {
    true
}

fn default_hosted_web_search_enabled() -> bool {
    true
}

impl Default for EffectivePolicy {
    fn default() -> Self {
        Self {
            zero_data_retention_enabled: false,
            available: default_policy_available(),
            locked_guardrails: Vec::new(),
            approved_models: Vec::new(),
            approved_providers: Vec::new(),
            allowed_regions: Vec::new(),
            allowed_tools: Vec::new(),
            denied_tools: Vec::new(),
            allowed_mcp_servers: Vec::new(),
            firewall: None,
            team_firewall: None,
            agent_overlays: std::collections::HashMap::new(),
            hosted_web_search_enabled: default_hosted_web_search_enabled(),
            web_search_debit_reason: false,
        }
    }
}

impl EffectivePolicy {
    pub fn allows_provider(&self, provider: &str) -> bool {
        self.available
            && (self.approved_providers.is_empty()
                || self
                    .approved_providers
                    .iter()
                    .any(|allowed| allowed == provider))
    }
    /// Whether a model id is permitted. An empty allowlist permits everything.
    pub fn allows_model(&self, model: &str) -> bool {
        self.available
            && (self.approved_models.is_empty() || self.approved_models.iter().any(|m| m == model))
    }

    /// Whether a routed provider's verified region is permitted. A configured
    /// region policy fails closed when the route has no region metadata.
    pub fn allows_region(&self, region: Option<&str>) -> bool {
        if !self.available {
            return false;
        }
        self.allowed_regions.is_empty()
            || region.is_some_and(|candidate| {
                self.allowed_regions
                    .iter()
                    .any(|allowed| regions_match(allowed, candidate))
            })
    }

    /// Whether the firewall must be force-enabled to honour locked guardrails.
    pub fn requires_firewall(&self) -> bool {
        !self.locked_guardrails.is_empty()
    }
}

fn regions_match(allowed: &str, candidate: &str) -> bool {
    let allowed = allowed.trim().to_ascii_lowercase();
    let candidate = candidate.trim().to_ascii_lowercase();
    allowed == candidate
        || candidate.starts_with(&format!("{allowed}-"))
        || matches!(
            (allowed.as_str(), candidate.as_str()),
            ("eu", value) if value.starts_with("europe-")
                || value.starts_with("eu-")
                || value.starts_with("eu_")
        )
        || matches!(
            (allowed.as_str(), candidate.as_str()),
            ("us", value) if value.starts_with("us-")
                || value.starts_with("us_")
        )
        || matches!(
            (allowed.as_str(), candidate.as_str()),
            ("asia", value) if value.starts_with("asia-")
                || value.starts_with("asia_")
        )
}

/// One org resolved from an arbitrary `rgw_` gateway token (the multi-tenant
/// data-plane path). Carries the fields the pipeline needs to attribute and gate
/// a request: the org id, whether it is a managed-inference tenant (so the
/// pre-flight credit gate applies), the org's remaining credit budget (authoritative
/// from the control plane), and its effective policy.
#[derive(Debug, Clone)]
pub struct ResolvedOrg {
    /// The organization id this token belongs to.
    pub org_id: String,
    /// Whether the org bills through managed inference (credit wallet). Only
    /// managed tenants get the pre-flight budget gate; BYOK/self-hosted do not.
    pub managed_inference: bool,
    /// Whether the org's current plan allows node-level OpenRouter routing
    /// preferences. Resolved by the control plane; caller headers cannot grant it.
    pub openrouter_routing_enabled: bool,
    /// Remaining credit budget in micro-USD, or `None` when the org has no
    /// managed budget cap. `Some(b)` with `b <= 0` means the wallet is exhausted.
    ///
    /// This is the TOTAL spendable balance — subscription + top-up + pool-
    /// restricted grants. It stays the number every legacy reader trusts; the two
    /// fields below decompose it for pool-aware gating without redefining it.
    pub remaining_budget_micro_usd: Option<i64>,
    /// The part of [`Self::remaining_budget_micro_usd`] spendable on ANY pool
    /// (subscription + top-up buckets). `None` ⇒ the control plane predates pool
    /// segregation, and [`crate::pipeline`] falls back to treating the whole
    /// balance as unrestricted — i.e. exactly today's behavior.
    pub unrestricted_budget_micro_usd: Option<i64>,
    /// Remaining POOL-RESTRICTED grant money, keyed by credit-pool id
    /// (`cloudflare` / `bedrock` / …, see [`crate::credit_pools`]). A pool absent
    /// from the map has no grant money left, which is indistinguishable from
    /// never having had any — deliberately, since both mean "this pool funds
    /// nothing". Empty ⇒ pool-blind behavior.
    pub pool_budgets_micro_usd: std::collections::HashMap<String, i64>,
    /// Ryu's own-supply allowances (wire `poolAllowances`), global supply facts
    /// the handshake carries for own-supply routing. Empty on older planes.
    pub pool_allowances: std::collections::HashMap<String, crate::credit_pools::PoolAllowance>,
    /// The org's resolved effective policy (allowlist / locked guardrails / regions).
    pub policy: EffectivePolicy,
    /// The control-plane id of the `rgw_` credential that resolved. Keys the
    /// per-key limits and the reporter's `keyDaily` rollup. `None` on a control
    /// plane that does not return it.
    pub credential_id: Option<String>,
    /// The org service account that owns the resolved credential (wire
    /// `credential.serviceAccountId`). Keys the shared service-account cap.
    /// `None` for node keys and on a control plane that does not send it.
    pub service_account_id: Option<String>,
    /// Everything the resolve said about the presenting credential (wire
    /// `credential`): its id, node, team, owner, creator, purpose and whether
    /// it serves a tenant's own end users. `None` on a control plane that does
    /// not return a credential id.
    pub credential: Option<std::sync::Arc<crate::identity::CredentialIdentity>>,
    /// The org's end-user salt epoch (wire `identity.saltEpoch`). `1` on a
    /// control plane that does not send it. The salt itself never travels.
    pub identity_salt_epoch: u32,
    /// The team the resolved credential is bound to (wire `credential.teamId`,
    /// a team node). Always counted as a team scope for this credential's
    /// traffic, whatever user JWT the caller forwards. `None` for org-wide and
    /// personal credentials and on a control plane that does not send it.
    pub team_id: Option<String>,
    /// The member whose personal node owns the resolved credential (wire
    /// `credential.ownerUserId`). Always the caller identity for this
    /// credential's traffic. `None` for org-wide and team credentials.
    pub owner_user_id: Option<String>,
    /// The personal-node owner's team ids in this org (wire
    /// `credential.ownerTeamIds`), read server-side so the owner's team caps
    /// apply with or without a forwarded JWT. `None` for non-personal
    /// credentials and on a control plane that does not send it.
    pub owner_team_ids: Option<Vec<String>>,
    /// Org budgets and rate limits (wire `limits`). Empty when the control
    /// plane sends none, which enforces nothing. Read through
    /// [`Self::enforced_limits`], which adds the plan's rate ceiling where it
    /// applies.
    pub limits: std::sync::Arc<crate::org_limits::OrgLimits>,
    /// [`Self::limits`] with the plan's rate ceiling (wire `planRateCeiling`)
    /// folded into the org-wide cap, or the same `Arc` when the control plane
    /// sends no ceiling. Precomputed so the hot path never clones the limits.
    pub billed_limits: std::sync::Arc<crate::org_limits::OrgLimits>,
    /// The control plane could not read this org's entitlement or wallet and
    /// had no recent last-known-good view to serve instead (wire
    /// `managedTierUnavailable`). The managed-tier fields above are then
    /// unknown, not "unfunded"; see [`Self::metered_credit`].
    pub managed_tier_unavailable: bool,
    /// Fleet-wide spend already reported for each capped scope (wire
    /// `limitsSpend`). `None` on older planes: caps read local counters only.
    pub limits_spend: Option<std::sync::Arc<crate::org_limits::RemoteSpend>>,
    /// Gateways that resolved for this org in the last few minutes, this one
    /// included (wire `activeGateways`), dividing every org rate ceiling. `None` on older
    /// planes: each gateway enforces the full ceilings.
    pub active_gateways: Option<u64>,
    /// Hash of the effective policy + limits (wire `policyVersion`), so a
    /// runtime can detect a change without diffing. `None` on older planes.
    pub policy_version: Option<String>,
    /// When this resolution was fetched. Cached resolutions are reused for up
    /// to a minute, so the budget figures above are as old as this; the credit
    /// gate compares it with the last debit's balance report.
    pub fetched_at: std::time::Instant,
    /// The credential's platform standing (wire `standing`, spec 05.5).
    /// Missing or malformed on the wire reads as unavailable, which refuses
    /// every request (see [`crate::standing`]).
    pub standing: crate::standing::PlatformStanding,
    /// Ryu's platform floor as this resolve sent it (wire `platformFloor`,
    /// spec 02.3). `None` when the control plane reported it unavailable or
    /// sent none, or the Gateway could not apply it in full. Callers feed it
    /// to [`crate::state::AppState::observe_platform_floor`] and never read it
    /// directly: the request applies the newest floor the process holds.
    pub platform_floor: Option<std::sync::Arc<crate::platform_floor::PlatformFloor>>,
    /// The enforcement-push version this resolution reflects: the ledger's
    /// latest version when the fetch started. Set by
    /// [`ResolveCache`]; 0 on a direct [`resolve_token`] call.
    pub enforcement_seen: u64,
    /// When the presenting credential was minted (wire
    /// `credential.createdAt`). `None` on a control plane that does not send
    /// it, which leaves the fleet's new-key limit off.
    pub credential_created_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// The credit fields a resolved tenant is gated on (see
/// [`ResolvedOrg::metered_credit`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TenantCredit {
    pub managed_inference: bool,
    pub remaining_budget_micro_usd: Option<i64>,
    pub unrestricted_budget_micro_usd: Option<i64>,
    pub pool_budgets_micro_usd: std::collections::HashMap<String, i64>,
    /// The tenant's balance is unknown because the control plane could not
    /// read it. Every credit gate answers `503 credit_accounting_unavailable`
    /// (retryable) rather than `402 insufficient_credits`: an outage is not
    /// evidence that the wallet is empty.
    pub accounting_unavailable: bool,
}

impl ResolvedOrg {
    /// The credit view to gate this tenant on.
    ///
    /// The control plane reports `managedInference = false` for an org with no
    /// managed entitlement AND no positive balance (`managedInferenceAvailable`),
    /// and also when its entitlement or wallet read fails. On a gateway that
    /// bills tenants (`gateway_bills_tenants`, i.e. it holds the credits debit
    /// secret), a dynamically resolved `rgw_` tenant is always served from this
    /// gateway's own provider keys: there is no per-org BYOK on that path. So
    /// "not managed" there means "not funded", never "bring your own key".
    /// Passing it through as non-managed skipped the pre-flight gate, every
    /// reservation, and web metering, so an exhausted promo grant or a lapsed
    /// subscription kept serving from the fleet's keys. Here it becomes a
    /// managed tenant with nothing left, which every existing gate refuses.
    ///
    /// A read failure is different: when the control plane says the managed
    /// tier is unavailable (`managedTierUnavailable`, sent only when it has no
    /// recent last-known-good view either), the tenant is managed with an
    /// UNKNOWN balance, and `accounting_unavailable` makes every credit gate
    /// answer `503 credit_accounting_unavailable` instead of telling a funded
    /// tenant its wallet is empty.
    ///
    /// A gateway that does not bill (self-hosted with only `CONTROL_PLANE_URL`
    /// for policy) keeps the resolved values unchanged.
    pub fn metered_credit(&self, gateway_bills_tenants: bool) -> TenantCredit {
        if !gateway_bills_tenants || (self.managed_inference && !self.managed_tier_unavailable) {
            return TenantCredit {
                managed_inference: self.managed_inference,
                remaining_budget_micro_usd: self.remaining_budget_micro_usd,
                unrestricted_budget_micro_usd: self.unrestricted_budget_micro_usd,
                pool_budgets_micro_usd: self.pool_budgets_micro_usd.clone(),
                accounting_unavailable: false,
            };
        }
        if self.managed_tier_unavailable {
            return TenantCredit {
                managed_inference: true,
                remaining_budget_micro_usd: None,
                unrestricted_budget_micro_usd: None,
                pool_budgets_micro_usd: std::collections::HashMap::new(),
                accounting_unavailable: true,
            };
        }
        TenantCredit {
            managed_inference: true,
            remaining_budget_micro_usd: Some(self.remaining_budget_micro_usd.unwrap_or(0).min(0)),
            unrestricted_budget_micro_usd: Some(0),
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            accounting_unavailable: false,
        }
    }

    /// The org limits this gateway enforces. The plan's rate ceiling exists
    /// because many organizations share the hosted Gateway's provider
    /// capacity, so only a gateway that bills tenants applies it; a gateway
    /// that does not (self-hosted, or an organization's own node) serves its
    /// own capacity and enforces only the caps the org's admins authored.
    pub fn enforced_limits(
        &self,
        gateway_bills_tenants: bool,
    ) -> &std::sync::Arc<crate::org_limits::OrgLimits> {
        if gateway_bills_tenants {
            &self.billed_limits
        } else {
            &self.limits
        }
    }
}

/// Shape of the control plane's `/gateway/resolve` response (subset).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveResponse {
    #[serde(default)]
    zero_data_retention_enabled: bool,
    #[serde(default)]
    organization: ResolveOrganization,
    #[serde(default)]
    credential: ResolveCredential,
    /// Wire: `identity`, the org's end-user hashing epoch. Missing on older
    /// control planes, which means epoch 1.
    #[serde(default)]
    identity: ResolveIdentity,
    #[serde(default)]
    policy: ResolvePolicy,
    /// Whether this org bills through managed inference (credit wallet).
    #[serde(default)]
    managed_inference: bool,
    /// Wire: `managedTierUnavailable`. True when the entitlement or wallet
    /// read failed and no recent last-known-good view existed, so
    /// `managedInference` and the budgets are unknown rather than false/empty.
    /// Missing on older control planes.
    #[serde(default)]
    managed_tier_unavailable: bool,
    /// Wire: `planRateCeiling`, the plan's org-wide rpm/tpm ceiling. Kept
    /// outside `limits` so a gateway that does not bill tenants can ignore it.
    /// Missing or `null` on older control planes: no ceiling.
    #[serde(default)]
    plan_rate_ceiling: Option<crate::org_limits::RateCeiling>,
    /// Business-only OpenRouter routing capability. Missing on older control
    /// planes, so the feature fails closed during rollout.
    #[serde(default)]
    openrouter_routing_enabled: bool,
    /// Wire: `hostedWebSearchEnabled`. Missing on older control planes, which
    /// keeps hosted web search available exactly as before the toggle existed.
    #[serde(default)]
    hosted_web_search_enabled: Option<bool>,
    /// Wire: `webSearchDebitReason`. True when the control plane accepts the
    /// `web_search` debit reason. Missing on older control planes, so hosted
    /// searches keep debiting as `gateway_usage` there.
    #[serde(default)]
    web_search_debit_reason: bool,
    /// Remaining credit budget in micro-USD (`null` when uncapped).
    #[serde(default)]
    remaining_budget_micro_usd: Option<i64>,
    /// Wire: `unrestrictedBudgetMicroUsd`. The subscription + top-up part of the
    /// balance — money spendable against any pool. Absent on a control plane that
    /// predates pool segregation, which is why it is `Option` + `serde(default)`
    /// rather than a bare `i64`: `Some(0)` ("no unrestricted money") and `None`
    /// ("this control plane cannot tell me") must not collapse into each other,
    /// or an old control plane would gate every pooled request to death.
    #[serde(default)]
    unrestricted_budget_micro_usd: Option<i64>,
    /// Wire: `poolBudgetsMicroUsd`, a `{ poolId: microUsd }` object.
    ///
    /// TRAP: the struct-level `rename_all = "camelCase"` renames FIELDS, not map
    /// KEYS. Pool ids therefore travel verbatim, so `CREDIT_POOL_IDS` in
    /// `packages/auth/src/lib/credit-pools.ts` and the pool column of
    /// [`crate::credit_pools`] must be the same literal strings — a casing
    /// mismatch would silently zero every pool budget rather than error.
    #[serde(default)]
    pool_budgets_micro_usd: std::collections::HashMap<String, i64>,
    /// Wire: `poolAllowances`, `{ poolId: { remainingMicroUsd, expiresAt } }`
    /// for Ryu's own supply. Missing on older planes.
    #[serde(default)]
    pool_allowances: std::collections::HashMap<String, crate::credit_pools::PoolAllowance>,
    /// Monthly credit pool in micro-USD (carried for parity; not gated on here).
    #[serde(default)]
    #[allow(dead_code)]
    monthly_credit_pool_micro_usd: i64,
    /// Org-effective firewall overlay (hosted hierarchical policy). Top-level on
    /// the resolve response; its own fields are snake_case. Emitted by the
    /// control plane (§5); the gateway feeds it to the firewall resolver.
    #[serde(default)]
    firewall: Option<crate::config::FirewallOverlay>,
    /// The node's team firewall overlay (top-level `teamFirewall`). Missing on
    /// older control planes and for credentials with no team.
    #[serde(default)]
    team_firewall: Option<crate::config::FirewallOverlay>,
    /// Per-agent firewall overlays keyed by agent id (top-level `agentOverlays`).
    #[serde(default)]
    agent_overlays: std::collections::HashMap<String, crate::config::FirewallOverlay>,
    /// Org budgets and rate limits (contract C1). Missing or `null` ⇒ none.
    #[serde(default, deserialize_with = "crate::org_limits::null_as_default")]
    limits: crate::org_limits::OrgLimits,
    /// Fleet-wide spend per capped scope. Kept outside `limits` so it never
    /// changes `policyVersion`. Missing or `null` on older planes.
    #[serde(default)]
    limits_spend: Option<crate::org_limits::RemoteSpend>,
    /// Gateways serving the org recently. Kept outside `limits` so it never
    /// changes `policyVersion`. Missing or `null` on older planes.
    #[serde(default)]
    active_gateways: Option<f64>,
    /// Hash of the effective policy + limits. Missing on older planes.
    #[serde(default)]
    policy_version: Option<String>,
    /// Wire: `standing`, kept raw so a malformed object fails closed as an
    /// unavailable standing instead of failing the whole resolve as a 401.
    #[serde(default)]
    standing: Option<serde_json::Value>,
    /// Wire: `platformFloor`, kept raw so a malformed floor is rejected on its
    /// own (the Gateway keeps the floor it holds) instead of failing the
    /// whole resolve.
    #[serde(default)]
    platform_floor: Option<serde_json::Value>,
    /// Wire: `platformFloorUnavailable`. True when the control plane could not
    /// read its floor; sent only because every resolve advertises the
    /// `platform_floor` capability.
    #[serde(default)]
    platform_floor_unavailable: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveCredential {
    /// The credential's control-plane id (keys per-key limits).
    #[serde(default)]
    id: Option<String>,
    /// Set when the credential belongs to an org service account.
    #[serde(default)]
    service_account_id: Option<String>,
    /// The node this credential belongs to; stable across rotation.
    #[serde(default)]
    node_id: Option<String>,
    /// Set on a team node's credential.
    #[serde(default)]
    team_id: Option<String>,
    /// Set on a member's personal-node credential.
    #[serde(default)]
    owner_user_id: Option<String>,
    /// The personal-node owner's team ids in this org.
    #[serde(default)]
    owner_team_ids: Option<Vec<String>>,
    /// The member who minted the credential (a custodian, never an actor).
    #[serde(default)]
    created_by: Option<String>,
    /// Whether an org admin declared this credential as serving the tenant's
    /// own end users, which lets `x-ryu-end-user` become the upstream subject.
    #[serde(default)]
    serves_end_users: bool,
    #[serde(default)]
    purpose: String,
    #[serde(default)]
    allowed_operations: Vec<String>,
    /// When the credential was minted (ISO 8601). Drives the new-key rate
    /// limit on the fleet ([`crate::enforcement`]); absent or unparseable
    /// leaves that limit off.
    #[serde(default)]
    created_at: Option<String>,
}

/// The `identity` field of the resolve response. Only the epoch travels; the
/// salt is derived inside the Gateway.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveIdentity {
    #[serde(default)]
    salt_epoch: Option<u32>,
}

/// A non-empty, trimmed, control-free id from the resolve, or `None`.
fn resolved_id(value: Option<String>) -> Option<String> {
    value.filter(|id| {
        !id.is_empty() && id.len() <= 256 && id.trim() == id && !id.chars().any(char::is_control)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialUse {
    NodeControl,
    GatewayRelay,
    GatewayWebSearch,
    GatewayWebFetch,
}

impl CredentialUse {
    fn purpose(self) -> &'static str {
        match self {
            Self::NodeControl => "node_control",
            Self::GatewayRelay | Self::GatewayWebSearch | Self::GatewayWebFetch => "gateway_relay",
        }
    }

    fn operation(self) -> &'static str {
        match self {
            Self::NodeControl => "node.resolve",
            Self::GatewayRelay => "gateway.inference",
            Self::GatewayWebSearch => "gateway.web.search",
            Self::GatewayWebFetch => "gateway.web.fetch",
        }
    }
}

/// The `organization` field of the resolve response. We only need the id.
#[derive(Debug, Default, Deserialize)]
struct ResolveOrganization {
    #[serde(default)]
    id: String,
}

impl ResolveResponse {
    /// Map the parsed response into a [`ResolvedOrg`], moving the policy rules out.
    fn into_resolved(self, credential_use: CredentialUse) -> anyhow::Result<ResolvedOrg> {
        if self.organization.id.is_empty()
            || self.organization.id.len() > 256
            || self.organization.id.trim() != self.organization.id
            || self.organization.id.chars().any(char::is_control)
        {
            anyhow::bail!("control plane returned an invalid organization identity");
        }
        let purpose_matches = self.credential.purpose == credential_use.purpose()
            || self.credential.purpose == "legacy_dual";
        if !purpose_matches
            || !self
                .credential
                .allowed_operations
                .iter()
                .any(|operation| operation == credential_use.operation())
        {
            anyhow::bail!(
                "control plane returned a credential without {} authority",
                credential_use.operation()
            );
        }
        let credential_created_at = self
            .credential
            .created_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&chrono::Utc));
        let credential_id = resolved_id(self.credential.id);
        let service_account_id = resolved_id(self.credential.service_account_id);
        let credential = credential_id.clone().map(|credential_id| {
            std::sync::Arc::new(crate::identity::CredentialIdentity {
                credential_id,
                node_id: resolved_id(self.credential.node_id),
                team_id: resolved_id(self.credential.team_id.clone()),
                owner_user_id: resolved_id(self.credential.owner_user_id.clone()),
                created_by: resolved_id(self.credential.created_by),
                service_account_id: service_account_id.clone(),
                serves_end_users: self.credential.serves_end_users,
                purpose: self.credential.purpose.clone(),
            })
        });
        let standing = crate::standing::PlatformStanding::from_wire(self.standing.as_ref());
        // A standing that refuses everything comes with a minimal body that
        // carries no policy. Never load it as a permissive empty policy.
        let policy_available = standing.refuses != crate::standing::StandingRefusal::All;
        let team_id = non_empty_binding(self.credential.team_id);
        let owner_user_id = non_empty_binding(self.credential.owner_user_id);
        if team_id.is_some() && owner_user_id.is_some() {
            // The control plane never issues a credential bound to both; one
            // that claims both has no well-defined scope, so refuse it.
            anyhow::bail!("control plane returned a credential bound to both a team and a member");
        }
        // Only a personal credential carries its owner's teams.
        let owner_team_ids = owner_user_id
            .as_ref()
            .and(self.credential.owner_team_ids)
            .map(|ids| {
                let mut ids: Vec<String> = ids
                    .into_iter()
                    .filter_map(|id| non_empty_binding(Some(id)))
                    .collect();
                ids.sort_unstable();
                ids.dedup();
                ids
            });
        let limits = std::sync::Arc::new(self.limits);
        let billed_limits = match self.plan_rate_ceiling {
            Some(ceiling) => std::sync::Arc::new(limits.with_rate_ceiling(ceiling)),
            None => std::sync::Arc::clone(&limits),
        };
        Ok(ResolvedOrg {
            org_id: self.organization.id,
            managed_inference: self.managed_inference,
            managed_tier_unavailable: self.managed_tier_unavailable,
            openrouter_routing_enabled: self.openrouter_routing_enabled,
            remaining_budget_micro_usd: self.remaining_budget_micro_usd,
            unrestricted_budget_micro_usd: self.unrestricted_budget_micro_usd,
            pool_budgets_micro_usd: self.pool_budgets_micro_usd,
            pool_allowances: self.pool_allowances,
            policy: EffectivePolicy {
                zero_data_retention_enabled: self.zero_data_retention_enabled,
                available: policy_available,
                locked_guardrails: self.policy.rules.locked_guardrails,
                approved_models: self.policy.rules.approved_models,
                approved_providers: self.policy.rules.approved_providers,
                allowed_regions: self.policy.rules.allowed_regions,
                allowed_tools: self.policy.rules.allowed_tools,
                denied_tools: self.policy.rules.denied_tools,
                allowed_mcp_servers: self.policy.rules.allowed_mcp_servers,
                firewall: self.firewall,
                team_firewall: self.team_firewall,
                agent_overlays: self.agent_overlays,
                hosted_web_search_enabled: self
                    .hosted_web_search_enabled
                    .unwrap_or_else(default_hosted_web_search_enabled),
                web_search_debit_reason: self.web_search_debit_reason,
            },
            credential_id,
            service_account_id,
            credential,
            identity_salt_epoch: self
                .identity
                .salt_epoch
                .filter(|epoch| *epoch >= 1)
                .unwrap_or(1),
            team_id,
            owner_user_id,
            owner_team_ids,
            limits,
            billed_limits,
            limits_spend: self.limits_spend.map(std::sync::Arc::new),
            active_gateways: self
                .active_gateways
                .filter(|count| count.is_finite() && *count >= 1.0)
                .map(|count| count as u64),
            policy_version: self.policy_version.filter(|version| !version.is_empty()),
            fetched_at: std::time::Instant::now(),
            standing,
            platform_floor: crate::platform_floor::PlatformFloor::from_wire(
                self.platform_floor.as_ref(),
                self.platform_floor_unavailable,
            ),
            enforcement_seen: 0,
            credential_created_at,
        })
    }
}

/// Parse a resolve body the way [`resolve_token`] does, for tests outside
/// this module.
#[cfg(test)]
pub(crate) fn parse_resolve_for_test(body: serde_json::Value) -> ResolvedOrg {
    serde_json::from_value::<ResolveResponse>(body)
        .expect("resolve body parses")
        .into_resolved(CredentialUse::GatewayRelay)
        .expect("resolve body converts")
}

/// A credential binding id from the resolve response, or `None` when absent,
/// empty, or whitespace (legacy rows send `null`).
fn non_empty_binding(value: Option<String>) -> Option<String> {
    value
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
}

/// The `policy` field of the resolve response: `{ rules, lockedFields }`.
#[derive(Debug, Default, Deserialize)]
struct ResolvePolicy {
    #[serde(default)]
    rules: ResolveRules,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveRules {
    #[serde(default)]
    locked_guardrails: Vec<String>,
    #[serde(default)]
    approved_models: Vec<String>,
    #[serde(default)]
    approved_providers: Vec<String>,
    #[serde(default)]
    allowed_regions: Vec<String>,
    #[serde(default, deserialize_with = "crate::org_limits::null_as_default")]
    allowed_tools: Vec<String>,
    #[serde(default, deserialize_with = "crate::org_limits::null_as_default")]
    denied_tools: Vec<String>,
    #[serde(default, deserialize_with = "crate::org_limits::null_as_default")]
    allowed_mcp_servers: Vec<String>,
}

/// Configuration the gateway needs to reach its control plane.
pub struct PolicySource {
    control_plane_url: String,
    gateway_key: String,
}

impl PolicySource {
    /// Build from environment. Returns `None` when the gateway is not bound to a
    /// control plane (no URL or no key) — a standalone/local gateway runs with
    /// no distributed policy and enforces nothing extra.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var(ENV_CONTROL_PLANE_URL)
            .ok()
            .filter(|s| !s.is_empty())?;
        let key = std::env::var(ENV_GATEWAY_KEY)
            .ok()
            .filter(|s| !s.is_empty())?;
        Some(Self {
            control_plane_url: url.trim_end_matches('/').to_string(),
            gateway_key: key,
        })
    }

    /// Fetch the full resolution for this gateway's own key: its effective
    /// policy plus the org id and `policyVersion` the background refresh
    /// compares. Errors are surfaced to the caller, which decides whether to
    /// fail open or closed. Uses the shared [`resolve_token`] mapping so the
    /// single-org startup path and the dynamic per-token path stay in sync.
    pub async fn fetch_resolved(&self, http: &reqwest::Client) -> anyhow::Result<ResolvedOrg> {
        resolve_token(
            &self.control_plane_url,
            http,
            &self.gateway_key,
            CredentialUse::NodeControl,
        )
        .await
    }
}

/// Header naming this gateway process on every resolve, so the control plane
/// can count the gateways serving an org (`activeGateways`) and each one can
/// enforce its share of the org's rate ceilings.
pub const GATEWAY_INSTANCE_HEADER: &str = "x-ryu-gateway-instance";

/// A random id for this process, generated once. It identifies nothing but
/// the process: a restart is a new instance, and the old id ages out.
pub fn gateway_instance_id() -> &'static str {
    static INSTANCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    INSTANCE.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

/// Resolve an arbitrary `rgw_` gateway token to its org + budget + policy via the
/// control plane's `/gateway/resolve` endpoint (the multi-tenant data-plane path).
///
/// The endpoint accepts ANY valid, non-revoked token as `x-gateway-key` and
/// returns that token's org; it 401s on a missing/invalid/revoked token, which
/// surfaces here as an error the caller maps to a hard 401 (never fail-open into
/// anonymous). `control_plane_url` is the base URL WITHOUT the `/api` suffix
/// (the same value `PolicySource` reads from `CONTROL_PLANE_URL`).
pub async fn resolve_token(
    control_plane_url: &str,
    http: &reqwest::Client,
    token: &str,
    credential_use: CredentialUse,
) -> anyhow::Result<ResolvedOrg> {
    let endpoint = format!(
        "{}/api/control-plane/gateway/resolve",
        control_plane_url.trim_end_matches('/')
    );
    let mut request = http
        .get(&endpoint)
        .header("x-gateway-key", token)
        .header(GATEWAY_INSTANCE_HEADER, gateway_instance_id())
        // Read `standing` (spec 05.5): a suspended or banned credential then
        // answers 200 with the reason, mapped to its 00.7 code here, instead
        // of a generic 401.
        .header(
            crate::standing::RESOLVE_CAPABILITIES_HEADER,
            crate::standing::RESOLVE_CAPABILITIES,
        )
        // Tell the control plane what time it is HERE. A managed node's quiet
        // hour (the window a deferred resize or update runs in) has to be
        // measured in the node's own zone — an org with a node in Frankfurt and
        // one in Singapore has two different nights — and the machine is the
        // only party that reliably knows its own. The control plane records it
        // as the DETECTED zone; an explicit setting always outranks it.
        .timeout(Duration::from_secs(5));
    if matches!(
        credential_use,
        CredentialUse::GatewayWebSearch | CredentialUse::GatewayWebFetch
    ) {
        request = request.header("x-ryu-gateway-operation", credential_use.operation());
    } else {
        request = request.header("x-ryu-node-timezone", local_timezone());
    }
    // A gateway running for one project applies that project's policy layers.
    if credential_use == CredentialUse::NodeControl {
        if let Some(project) = std::env::var("RYU_PROJECT_ID")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
        {
            request = request.header("x-project-id", project);
        }
    }
    let mut resp = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("control plane resolve transport unavailable"))?;
    if !resp.status().is_success() {
        anyhow::bail!("control plane returned HTTP {}", resp.status());
    }
    const MAX_RESOLVE_BYTES: usize = 1024 * 1024;
    if resp
        .content_length()
        .is_some_and(|length| length > MAX_RESOLVE_BYTES as u64)
    {
        anyhow::bail!("control plane resolve response exceeds the size limit");
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("control plane resolve body unavailable"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESOLVE_BYTES {
            anyhow::bail!("control plane resolve response exceeds the size limit");
        }
        body.extend_from_slice(&chunk);
    }
    let parsed: ResolveResponse = serde_json::from_slice(&body)
        .map_err(|_| anyhow::anyhow!("control plane returned an invalid resolve response"))?;
    parsed.into_resolved(credential_use)
}

/// This machine's IANA time zone, or `UTC` when it cannot be determined.
///
/// `TZ` first because an operator who sets it means it — a container is usually
/// UTC by default and `TZ` is how you say otherwise. Then the system zone.
///
/// Never fails: the zone is a scheduling nicety, and a node that cannot name its
/// own zone must still serve requests. UTC is the honest fallback — wrong for
/// most of the world, but fixed and explicable rather than a guess.
fn local_timezone() -> String {
    if let Ok(tz) = std::env::var("TZ") {
        if let Some(zone) = zone_from_tz(&tz) {
            return zone;
        }
    }
    // `/etc/timezone` is the plain-text answer on Debian/Ubuntu, which is what a
    // managed node runs. Read directly rather than adding a crate: the gateway
    // is a self-contained workspace that is published, and one std read is not
    // worth a dependency in it.
    if let Ok(raw) = std::fs::read_to_string("/etc/timezone") {
        let zone = raw.trim();
        if !zone.is_empty() {
            return zone.to_string();
        }
    }
    // Elsewhere (and on macOS) `/etc/localtime` is a symlink into the tz
    // database, so the zone id is the tail of its target.
    if let Ok(link) = std::fs::read_link("/etc/localtime") {
        if let Some(zone) = zone_from_localtime(&link.to_string_lossy()) {
            return zone;
        }
    }
    "UTC".to_string()
}

/// The zone id in a `TZ` value, or `None` when it names nothing usable.
///
/// `TZ=:Europe/Berlin` is legal POSIX — the leading colon tells the C library to
/// treat the rest as a file reference — and forwarding it verbatim would send a
/// zone id the control plane cannot parse.
fn zone_from_tz(raw: &str) -> Option<String> {
    let zone = raw.trim().trim_start_matches(':').trim();
    if zone.is_empty() {
        return None;
    }
    Some(zone.to_string())
}

/// The zone id embedded in an `/etc/localtime` symlink target.
fn zone_from_localtime(target: &str) -> Option<String> {
    let idx = target.find("/zoneinfo/")?;
    let zone = target[idx + "/zoneinfo/".len()..].trim();
    if zone.is_empty() {
        return None;
    }
    Some(zone.to_string())
}

#[cfg(test)]
mod tests {

    #[test]
    fn tz_env_is_used_verbatim_when_it_names_a_zone() {
        assert_eq!(
            super::zone_from_tz("Asia/Singapore"),
            Some("Asia/Singapore".to_string())
        );
    }

    #[test]
    fn tz_env_strips_the_posix_colon_prefix() {
        // `TZ=:Europe/Berlin` is legal POSIX; forwarded verbatim the control
        // plane would reject it as an unknown zone.
        assert_eq!(
            super::zone_from_tz(":Europe/Berlin"),
            Some("Europe/Berlin".to_string())
        );
    }

    #[test]
    fn an_empty_tz_env_names_nothing_rather_than_an_empty_zone() {
        assert_eq!(super::zone_from_tz(""), None);
        assert_eq!(super::zone_from_tz("  "), None);
        assert_eq!(super::zone_from_tz(":"), None);
    }

    #[test]
    fn localtime_symlink_yields_the_zone_after_zoneinfo() {
        assert_eq!(
            super::zone_from_localtime("/usr/share/zoneinfo/America/New_York"),
            Some("America/New_York".to_string())
        );
    }

    #[test]
    fn a_localtime_target_with_no_zoneinfo_segment_yields_nothing() {
        // Better to fall through to UTC than to send a path fragment as a zone.
        assert_eq!(super::zone_from_localtime("/etc/localtime"), None);
    }

    use super::*;

    #[test]
    fn empty_allowlist_permits_any_model() {
        let policy = EffectivePolicy::default();
        assert!(policy.allows_model("gpt-4o"));
        assert!(policy.allows_model("claude-3-5-sonnet"));
    }

    #[test]
    fn allowlist_restricts_to_listed_models() {
        let policy = EffectivePolicy {
            approved_models: vec!["gpt-4o".to_string()],
            ..Default::default()
        };
        assert!(policy.allows_model("gpt-4o"));
        assert!(!policy.allows_model("gpt-4o-mini"));
    }

    #[test]
    fn provider_restrictions_are_independent_from_model_names_and_fail_closed() {
        let mut policy = EffectivePolicy {
            approved_models: vec!["model-only".into()],
            approved_providers: vec!["tavily".into()],
            ..Default::default()
        };
        assert!(policy.allows_provider("tavily"));
        assert!(!policy.allows_provider("exa"));
        assert!(policy.allows_model("model-only"));
        assert!(!policy.allows_model("tavily"));
        policy.available = false;
        assert!(!policy.allows_provider("tavily"));
    }

    #[test]
    fn unavailable_policy_denies_models_and_regions() {
        let policy = EffectivePolicy {
            available: false,
            ..Default::default()
        };
        assert!(!policy.allows_model("gpt-4o"));
        assert!(!policy.allows_region(Some("global")));
    }

    #[test]
    fn non_empty_region_policy_requires_verified_route_metadata() {
        let policy = EffectivePolicy {
            allowed_regions: vec!["eu".to_owned()],
            ..Default::default()
        };
        assert!(policy.allows_region(Some("EU-WEST-1")));
        assert!(policy.allows_region(Some("europe-west4")));
        assert!(!policy.allows_region(None));
        assert!(!policy.allows_region(Some("global")));
    }

    /// The control plane resolves disjoint layer allowlists to `POLICY_DENY_ALL`
    /// (packages/db control-plane.model.ts) rather than an empty list, which would
    /// read as unrestricted. Every allowlist check must treat it as allowing nothing.
    #[test]
    fn deny_all_marker_permits_no_model_provider_or_region() {
        let deny_all = vec!["<deny-all>".to_owned()];
        let policy = EffectivePolicy {
            approved_models: deny_all.clone(),
            approved_providers: deny_all.clone(),
            allowed_regions: deny_all,
            ..Default::default()
        };
        assert!(!policy.allows_model("gpt-4o"));
        assert!(!policy.allows_model("llama-3"));
        assert!(!policy.allows_provider("tavily"));
        assert!(!policy.allows_region(Some("us-east-1")));
        assert!(!policy.allows_region(Some("eu")));
        assert!(!policy.allows_region(None));
    }

    #[test]
    fn locked_guardrails_force_firewall() {
        let none = EffectivePolicy::default();
        assert!(!none.requires_firewall());

        let locked = EffectivePolicy {
            locked_guardrails: vec!["pii".to_string()],
            ..Default::default()
        };
        assert!(locked.requires_firewall());
    }

    #[test]
    fn parses_resolve_response_shape() {
        let body = serde_json::json!({
            "organization": { "id": "o1", "name": "Acme", "slug": "acme" },
            "credential": {
                "id": "cred_1",
                "keyPrefix": "rgw_abc",
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "policy": {
                "rules": {
                    "lockedGuardrails": ["pii", "secrets"],
                    "approvedModels": ["gpt-4o"],
                    "allowedRegions": ["eu"]
                },
                "lockedFields": ["approvedModels"]
            },
            "managedInference": true,
            "openrouterRoutingEnabled": true,
            "hostedWebSearchEnabled": false,
            "webSearchDebitReason": true,
            "monthlyCreditPoolMicroUsd": 5_000_000,
            "remainingBudgetMicroUsd": 1_250_000
        });
        let parsed: ResolveResponse = serde_json::from_value(body).unwrap();
        assert_eq!(parsed.policy.rules.approved_models, vec!["gpt-4o"]);
        assert_eq!(parsed.policy.rules.locked_guardrails.len(), 2);
        assert_eq!(parsed.policy.rules.allowed_regions, vec!["eu"]);

        // The previously-dropped fields are now read into the ResolvedOrg.
        let resolved = parsed.into_resolved(CredentialUse::GatewayRelay).unwrap();
        assert_eq!(resolved.org_id, "o1");
        assert!(resolved.managed_inference);
        assert!(resolved.openrouter_routing_enabled);
        assert!(!resolved.policy.hosted_web_search_enabled);
        assert!(resolved.policy.web_search_debit_reason);
        assert_eq!(resolved.remaining_budget_micro_usd, Some(1_250_000));
        assert_eq!(resolved.policy.approved_models, vec!["gpt-4o"]);
    }

    #[test]
    fn keeps_the_resolved_credential_identity_and_salt_epoch() {
        let body = serde_json::json!({
            "organization": { "id": "o1" },
            "credential": {
                "id": "cred_1",
                "nodeId": "node_1",
                "teamId": "team_1",
                "ownerUserId": null,
                "createdBy": "usr_creator",
                "serviceAccountId": null,
                "servesEndUsers": true,
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "identity": { "saltEpoch": 3 }
        });
        // A credential is bound to a team or to a member, never both.
        let mut both = body.clone();
        both["credential"]["ownerUserId"] = serde_json::json!("usr_owner");
        let refused = serde_json::from_value::<ResolveResponse>(both)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .map(|_| ())
            .unwrap_err();
        assert!(refused
            .to_string()
            .contains("bound to both a team and a member"));
        let resolved = serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap();
        let credential = resolved.credential.as_deref().expect("credential identity");
        assert_eq!(credential.credential_id, "cred_1");
        assert_eq!(credential.node_id.as_deref(), Some("node_1"));
        assert_eq!(credential.team_id.as_deref(), Some("team_1"));
        assert_eq!(credential.owner_user_id, None);
        assert_eq!(credential.created_by.as_deref(), Some("usr_creator"));
        assert_eq!(credential.service_account_id, None);
        assert!(credential.serves_end_users);
        assert_eq!(credential.purpose, "gateway_relay");
        assert_eq!(resolved.identity_salt_epoch, 3);

        // A control plane that predates these fields: epoch 1, ordinary key.
        let older = serde_json::json!({
            "organization": { "id": "o1" },
            "credential": {
                "id": "cred_1",
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            }
        });
        let resolved = serde_json::from_value::<ResolveResponse>(older)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap();
        let credential = resolved.credential.as_deref().expect("credential identity");
        assert!(!credential.serves_end_users);
        assert_eq!(credential.created_by, None);
        assert_eq!(resolved.identity_salt_epoch, 1);
    }

    #[test]
    fn parses_limits_credential_id_and_policy_version() {
        let body = serde_json::json!({
            "organization": { "id": "o1" },
            "credential": {
                "id": "cred_1",
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "policyVersion": "v-abc",
            "limits": {
                "org": {
                    "budgetMicroUsd": 5_000_000,
                    "budgetWindow": "monthly",
                    "budgetAction": "stop",
                    "downgradeModel": null,
                    "alertThresholdsPct": [50, 80, 100],
                    "rpm": 600,
                    "tpm": null
                },
                "memberDefault": null,
                "members": { "u1": { "budgetMicroUsd": 1_000, "budgetWindow": "daily",
                    "budgetAction": "downgrade", "downgradeModel": "gpt-4o-mini",
                    "alertThresholdsPct": [], "rpm": null, "tpm": 1000 } },
                "teams": {},
                "keys": {}
            }
        });
        let resolved = serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap();
        assert_eq!(resolved.credential_id.as_deref(), Some("cred_1"));
        assert_eq!(resolved.policy_version.as_deref(), Some("v-abc"));
        let org = resolved.limits.org.as_ref().expect("org cap");
        assert_eq!(org.budget_micro_usd, Some(5_000_000));
        assert_eq!(org.rpm, Some(600));
        let member = &resolved.limits.members["u1"];
        assert_eq!(member.downgrade_model.as_deref(), Some("gpt-4o-mini"));
        assert_eq!(member.tpm, Some(1000));
        assert_eq!(
            resolved.service_account_id, None,
            "a node key has no account"
        );
    }

    #[test]
    fn parses_service_account_credential_and_cap() {
        let body = serde_json::json!({
            "organization": { "id": "o1" },
            "credential": {
                "id": "cred_sa",
                "serviceAccountId": "sa_1",
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "limits": {
                "serviceAccounts": { "sa_1": { "budgetMicroUsd": 2_000,
                    "budgetWindow": "daily", "budgetAction": "stop",
                    "alertThresholdsPct": [], "rpm": 10, "tpm": null } }
            }
        });
        let resolved = serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap();
        assert_eq!(resolved.service_account_id.as_deref(), Some("sa_1"));
        let cap = &resolved.limits.service_accounts["sa_1"];
        assert_eq!(cap.budget_micro_usd, Some(2_000));
        assert_eq!(cap.rpm, Some(10));
        assert!(!resolved.limits.is_empty());
    }

    #[test]
    fn missing_or_null_limits_enforce_nothing() {
        for limits in [None, Some(serde_json::Value::Null)] {
            let mut body = serde_json::json!({
                "organization": { "id": "o1" },
                "credential": {
                    "purpose": "gateway_relay",
                    "allowedOperations": ["gateway.inference"]
                }
            });
            if let Some(value) = limits {
                body["limits"] = value;
            }
            let resolved = serde_json::from_value::<ResolveResponse>(body)
                .unwrap()
                .into_resolved(CredentialUse::GatewayRelay)
                .unwrap();
            assert!(resolved.limits.is_empty());
            assert!(resolved.policy_version.is_none());
            assert!(resolved.credential_id.is_none());
        }
    }

    #[test]
    fn parses_resolve_response_with_null_budget_and_defaults() {
        // A BYOK/self-hosted org: no managed inference, uncapped budget (null).
        let body = serde_json::json!({
            "organization": { "id": "o2" },
            "credential": {
                "purpose": "node_control",
                "allowedOperations": ["node.resolve"]
            },
            "policy": { "rules": {} },
            "remainingBudgetMicroUsd": null
        });
        let resolved: ResolvedOrg = serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::NodeControl)
            .unwrap();
        assert_eq!(resolved.org_id, "o2");
        assert!(!resolved.managed_inference);
        assert!(!resolved.openrouter_routing_enabled);
        // A control plane that predates the toggle keeps hosted search available.
        assert!(resolved.policy.hosted_web_search_enabled);
        // ...and is never sent a debit reason it would reject.
        assert!(!resolved.policy.web_search_debit_reason);
        assert_eq!(resolved.remaining_budget_micro_usd, None);
        assert!(resolved.policy.approved_models.is_empty());
        // A pre-pool-segregation control plane omits both pool fields entirely;
        // the gateway must read that as "cannot tell me", not as "zero".
        assert_eq!(resolved.unrestricted_budget_micro_usd, None);
        assert!(resolved.pool_budgets_micro_usd.is_empty());
    }

    fn resolve_with_credential(credential: serde_json::Value) -> anyhow::Result<ResolvedOrg> {
        serde_json::from_value::<ResolveResponse>(serde_json::json!({
            "organization": { "id": "o-bound" },
            "credential": credential,
        }))
        .unwrap()
        .into_resolved(CredentialUse::GatewayRelay)
    }

    #[test]
    fn resolve_response_reads_the_credential_team_and_owner_binding() {
        let team = resolve_with_credential(serde_json::json!({
            "purpose": "gateway_relay",
            "allowedOperations": ["gateway.inference"],
            "teamId": "team-a",
            "ownerUserId": null
        }))
        .unwrap();
        assert_eq!(team.team_id.as_deref(), Some("team-a"));
        assert_eq!(team.owner_user_id, None);

        let personal = resolve_with_credential(serde_json::json!({
            "purpose": "gateway_relay",
            "allowedOperations": ["gateway.inference"],
            "teamId": "  ",
            "ownerUserId": "user-1",
            "ownerTeamIds": ["team-b", "", "team-a", "team-b"]
        }))
        .unwrap();
        assert_eq!(personal.team_id, None);
        assert_eq!(personal.owner_user_id.as_deref(), Some("user-1"));
        assert_eq!(
            personal.owner_team_ids,
            Some(vec!["team-a".to_owned(), "team-b".to_owned()])
        );
        // Owner teams are meaningless without an owner and are dropped.
        let unowned = resolve_with_credential(serde_json::json!({
            "purpose": "gateway_relay",
            "allowedOperations": ["gateway.inference"],
            "teamId": "team-a",
            "ownerTeamIds": ["team-x"]
        }))
        .unwrap();
        assert_eq!(unowned.owner_team_ids, None);

        // Legacy planes omit both: an org-wide credential.
        let org = resolve_with_credential(serde_json::json!({
            "purpose": "gateway_relay",
            "allowedOperations": ["gateway.inference"]
        }))
        .unwrap();
        assert_eq!((org.team_id, org.owner_user_id), (None, None));

        // A credential claiming both bindings has no defined scope.
        assert!(resolve_with_credential(serde_json::json!({
            "purpose": "gateway_relay",
            "allowedOperations": ["gateway.inference"],
            "teamId": "team-a",
            "ownerUserId": "user-1"
        }))
        .is_err());
    }

    fn resolved_with(managed: bool, remaining: Option<i64>) -> ResolvedOrg {
        let body = serde_json::json!({
            "organization": { "id": "o-free" },
            "credential": {
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "managedInference": managed,
            "remainingBudgetMicroUsd": remaining,
            "unrestrictedBudgetMicroUsd": remaining,
            "poolBudgetsMicroUsd": { "cloudflare": 0 }
        });
        serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap()
    }

    #[test]
    fn unfunded_tenant_on_a_billing_gateway_is_gated_not_byok() {
        // An exhausted promo grant / lapsed plan resolves as not managed. On the
        // hosted fleet that must read as "nothing left", never as BYOK.
        for remaining in [Some(0), Some(-40), None] {
            let credit = resolved_with(false, remaining).metered_credit(true);
            assert!(credit.managed_inference);
            assert!(credit.remaining_budget_micro_usd.is_some_and(|b| b <= 0));
            assert_eq!(credit.unrestricted_budget_micro_usd, Some(0));
            assert!(credit.pool_budgets_micro_usd.is_empty());
        }
    }

    #[test]
    fn funded_or_non_billing_tenants_keep_the_resolved_credit() {
        let funded = resolved_with(true, Some(5_000));
        let credit = funded.metered_credit(true);
        assert!(credit.managed_inference);
        assert_eq!(credit.remaining_budget_micro_usd, Some(5_000));
        assert_eq!(credit.pool_budgets_micro_usd.get("cloudflare"), Some(&0));

        // A self-hosted gateway that only resolves policy does not bill, so the
        // control plane's BYOK reading stands.
        let byok = resolved_with(false, None).metered_credit(false);
        assert!(!byok.managed_inference);
        assert_eq!(byok.remaining_budget_micro_usd, None);
        assert!(!byok.accounting_unavailable);
    }

    #[test]
    fn an_unreadable_managed_tier_is_unknown_credit_never_an_empty_wallet() {
        // The control plane could not read the entitlement or wallet and had no
        // recent last-known-good view: a billing gateway must answer 503
        // (accounting unavailable), not 402 insufficient_credits.
        let body = serde_json::json!({
            "organization": { "id": "o-outage" },
            "credential": {
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "managedInference": false,
            "managedTierUnavailable": true,
            "remainingBudgetMicroUsd": null,
            "unrestrictedBudgetMicroUsd": null,
            "poolBudgetsMicroUsd": {}
        });
        let resolved = serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap();
        assert!(resolved.managed_tier_unavailable);
        let credit = resolved.metered_credit(true);
        assert!(credit.accounting_unavailable);
        assert!(credit.managed_inference);
        assert_eq!(credit.remaining_budget_micro_usd, None);
        assert_eq!(credit.unrestricted_budget_micro_usd, None);

        // A gateway that does not bill keeps the control plane's reading.
        let credit = resolved.metered_credit(false);
        assert!(!credit.accounting_unavailable);
        assert!(!credit.managed_inference);

        // Older planes never send the flag.
        assert!(!resolved_with(false, Some(0)).managed_tier_unavailable);
        assert!(
            !resolved_with(true, Some(10))
                .metered_credit(true)
                .accounting_unavailable
        );
    }

    #[test]
    fn the_plan_rate_ceiling_applies_only_on_a_billing_gateway() {
        let body = serde_json::json!({
            "organization": { "id": "o-free" },
            "credential": {
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "limits": { "org": { "rpm": 500 } },
            "planRateCeiling": { "rpm": 30, "tpm": 60000 }
        });
        let resolved = serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap();
        let billed = resolved.enforced_limits(true).org.as_ref().unwrap();
        assert_eq!((billed.rpm, billed.tpm), (Some(30), Some(60_000)));
        // Self-hosted / an org's own node: only the authored cap.
        let authored = resolved.enforced_limits(false).org.as_ref().unwrap();
        assert_eq!((authored.rpm, authored.tpm), (Some(500), None));

        // No ceiling on the wire (older plane, or `null`): both views are the
        // authored limits, sharing one allocation.
        for send_null in [false, true] {
            let mut body = serde_json::json!({
                "organization": { "id": "o-free" },
                "credential": {
                    "purpose": "gateway_relay",
                    "allowedOperations": ["gateway.inference"]
                },
                "limits": { "org": { "rpm": 500 } }
            });
            if send_null {
                body["planRateCeiling"] = serde_json::Value::Null;
            }
            let resolved = serde_json::from_value::<ResolveResponse>(body)
                .unwrap()
                .into_resolved(CredentialUse::GatewayRelay)
                .unwrap();
            assert!(std::sync::Arc::ptr_eq(
                resolved.enforced_limits(true),
                resolved.enforced_limits(false)
            ));
        }
    }

    #[test]
    fn parses_pool_segregated_budget_fields() {
        // The shape the control plane emits alongside the total: the unrestricted
        // decomposition plus per-pool restricted grant remainders.
        let body = serde_json::json!({
            "organization": { "id": "o3" },
            "credential": {
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "policy": { "rules": {} },
            "managedInference": true,
            "remainingBudgetMicroUsd": 52_000_000,
            "unrestrictedBudgetMicroUsd": 2_000_000,
            "poolBudgetsMicroUsd": { "bedrock": 50_000_000, "cloudflare": 0 }
        });
        let resolved: ResolvedOrg = serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap();
        assert_eq!(resolved.remaining_budget_micro_usd, Some(52_000_000));
        assert_eq!(resolved.unrestricted_budget_micro_usd, Some(2_000_000));
        // Map KEYS survive `rename_all = "camelCase"` verbatim — that rename
        // applies to struct fields only. If this ever starts failing with
        // `bedrock` missing, the control plane changed the pool id, not the
        // casing convention.
        assert_eq!(
            resolved.pool_budgets_micro_usd.get("bedrock").copied(),
            Some(50_000_000)
        );
        assert_eq!(
            resolved.pool_budgets_micro_usd.get("cloudflare").copied(),
            Some(0)
        );
    }

    #[test]
    fn resolve_response_reads_active_gateways_and_ignores_unusable_counts() {
        let resolve = |count: serde_json::Value| {
            serde_json::from_value::<ResolveResponse>(serde_json::json!({
                "organization": { "id": "o4" },
                "credential": {
                    "purpose": "gateway_relay",
                    "allowedOperations": ["gateway.inference"]
                },
                "policy": { "rules": {} },
                "activeGateways": count
            }))
            .unwrap()
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap()
            .active_gateways
        };
        assert_eq!(resolve(serde_json::json!(4)), Some(4));
        assert_eq!(resolve(serde_json::json!(null)), None, "older plane");
        assert_eq!(resolve(serde_json::json!(0)), None);
        assert_eq!(resolve(serde_json::json!(-2)), None);
        let instance = gateway_instance_id();
        assert_eq!(instance.len(), 32);
        assert_eq!(instance, gateway_instance_id(), "stable for the process");
    }

    #[test]
    fn resolve_response_ignores_unknown_credential_rotation_field() {
        // F7 (load-bearing): the hosted FLEET gateway also calls `/gateway/resolve`
        // (with the client bearer as x-gateway-key) on every chat. Its
        // `ResolveResponse` has NO `credentialRotation` field and MUST silently
        // drop it — if this struct ever gained `#[serde(deny_unknown_fields)]`, a
        // bootstrap presented to the fleet would error here instead of being
        // ignored, and the whole KEY-only injection contract (only the NODE's own
        // `register_managed_node` triggers the single-use exchange) would break,
        // bricking fresh nodes. This test fails loudly if that regression lands.
        let body = serde_json::json!({
            "organization": { "id": "o3", "name": "Acme" },
            "credential": {
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            },
            "policy": { "rules": {} },
            "credentialRotation": { "token": "rgw_durable_should_be_ignored" }
        });
        let resolved = serde_json::from_value::<ResolveResponse>(body)
            .expect("fleet ResolveResponse must tolerate an unknown credentialRotation field")
            .into_resolved(CredentialUse::GatewayRelay)
            .unwrap();
        assert_eq!(resolved.org_id, "o3");
    }

    /// A resolve with no `standing`, or a malformed one, still parses (it is
    /// not a 401) but carries an unavailable standing and a policy that
    /// permits nothing.
    #[test]
    fn a_missing_or_malformed_standing_resolves_to_a_refusing_deny_policy() {
        for standing in [
            None,
            Some(serde_json::json!("active")),
            Some(serde_json::json!({ "state": 7 })),
        ] {
            let mut body = serde_json::json!({
                "organization": { "id": "o-standing" },
                "credential": {
                    "purpose": "gateway_relay",
                    "allowedOperations": ["gateway.inference"]
                }
            });
            if let Some(standing) = standing.clone() {
                body["standing"] = standing;
            }
            let resolved = serde_json::from_value::<ResolveResponse>(body)
                .unwrap()
                .into_resolved(CredentialUse::GatewayRelay)
                .unwrap();
            assert_eq!(
                resolved.standing.state,
                crate::standing::StandingState::StandingUnavailable,
                "{standing:?}"
            );
            assert!(!resolved.policy.available, "{standing:?}");
            assert!(resolved
                .standing
                .refusal(crate::custody::GatewayCustody::SelfHosted)
                .is_some());
        }
    }

    #[test]
    fn relay_resolution_rejects_node_control_credentials() {
        let body = serde_json::json!({
            "organization": { "id": "o3" },
            "credential": {
                "purpose": "node_control",
                "allowedOperations": ["node.resolve"]
            },
            "policy": { "rules": {} }
        });
        let parsed = serde_json::from_value::<ResolveResponse>(body).unwrap();
        assert!(parsed.into_resolved(CredentialUse::GatewayRelay).is_err());
    }

    #[test]
    fn web_resolution_requires_explicit_operation_and_valid_tenant_identity() {
        for id in ["", " org ", "org\nother"] {
            let parsed: ResolveResponse = serde_json::from_value(serde_json::json!({"organization":{"id":id},"credential":{"purpose":"gateway_relay","allowedOperations":["gateway.web.search"]}})).unwrap();
            assert!(parsed
                .into_resolved(CredentialUse::GatewayWebSearch)
                .is_err());
        }
        let body = serde_json::json!({"organization":{"id":"org-web"},"credential":{"purpose":"gateway_relay","allowedOperations":["gateway.web.search"]},"policy":{"rules":{"approvedProviders":["tavily"]}},"standing":{"state":"active","refuses":"none"}});
        let parsed: ResolveResponse = serde_json::from_value(body.clone()).unwrap();
        let resolved = parsed
            .into_resolved(CredentialUse::GatewayWebSearch)
            .unwrap();
        assert!(resolved.policy.allows_provider("tavily"));
        assert!(!resolved.policy.allows_provider("exa"));
        for operation in [
            CredentialUse::GatewayRelay,
            CredentialUse::GatewayWebFetch,
            CredentialUse::NodeControl,
        ] {
            let parsed: ResolveResponse = serde_json::from_value(body.clone()).unwrap();
            assert!(parsed.into_resolved(operation).is_err());
        }
    }

    #[test]
    fn from_env_requires_both_url_and_key() {
        // With neither set in this test process, the source is None.
        if std::env::var(ENV_CONTROL_PLANE_URL).is_err() && std::env::var(ENV_GATEWAY_KEY).is_err()
        {
            assert!(PolicySource::from_env().is_none());
        }
    }

    #[tokio::test]
    async fn resolve_rejects_oversized_and_invalid_responses_without_echoing_secrets() {
        use axum::{routing::get, Router};

        let secret = "upstream-secret-must-not-appear";
        for body in [secret.to_owned(), "x".repeat(1024 * 1024 + 1)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let app = Router::new().route(
                "/api/control-plane/gateway/resolve",
                get(move || {
                    let body = body.clone();
                    async move { body }
                }),
            );
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let error = resolve_token(
                &format!("http://{address}"),
                &client,
                "client-secret-must-not-appear",
                CredentialUse::GatewayWebSearch,
            )
            .await
            .unwrap_err();
            server.abort();
            let message = error.to_string();
            assert!(!message.contains(secret));
            assert!(!message.contains("client-secret"));
            assert!(
                message == "control plane returned an invalid resolve response"
                    || message == "control plane resolve response exceeds the size limit"
            );
        }
    }
}
