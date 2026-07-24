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
//!   - `allowed_regions`: provider/data regions permitted (carried for callers;
//!     region tagging of providers is future work, kept in scope as data).

use std::time::Duration;

use serde::Deserialize;

mod cache;
mod drift;
pub use cache::{ResolveCache, ResolveErr};
pub use drift::{detect_drift, DriftWarning};

/// Env var with the control-plane base URL (no trailing `/api`).
const ENV_CONTROL_PLANE_URL: &str = "CONTROL_PLANE_URL";
/// Env var with this gateway's `rgw_` key used to authenticate to the control
/// plane.
const ENV_GATEWAY_KEY: &str = "GATEWAY_KEY";

/// The effective policy the data plane enforces. Mirrors the control plane's
/// `EffectivePolicy.rules` plus the locked-field list (advisory here: the
/// cascade already applied the locks).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EffectivePolicy {
    /// Guardrail names that must stay enabled (e.g. "pii", "secrets").
    #[serde(default)]
    pub locked_guardrails: Vec<String>,
    /// Allowlist of model ids the gateway may route to. Empty = no restriction.
    #[serde(default)]
    pub approved_models: Vec<String>,
    /// Provider/data regions permitted (e.g. "us", "eu"). Empty = no restriction.
    #[serde(default)]
    pub allowed_regions: Vec<String>,
    /// The org-effective firewall overlay cascaded by the control plane (hosted
    /// hierarchical policy). `None` ⇒ no org override; the gateway's node base
    /// (and any standalone-local overlay) applies. Fed to
    /// [`crate::firewall::resolve::FirewallResolver`]. Wire key: top-level
    /// `firewall` on the resolve response; its own fields are snake_case.
    #[serde(default)]
    pub firewall: Option<crate::config::FirewallOverlay>,
    /// Per-agent firewall overlays for this org, keyed by agent id. Wire key:
    /// top-level `agentOverlays` (camelCase) on the resolve response.
    #[serde(default)]
    pub agent_overlays: std::collections::HashMap<String, crate::config::FirewallOverlay>,
}

impl EffectivePolicy {
    /// Whether a model id is permitted. An empty allowlist permits everything.
    pub fn allows_model(&self, model: &str) -> bool {
        self.approved_models.is_empty() || self.approved_models.iter().any(|m| m == model)
    }

    /// Whether the firewall must be force-enabled to honour locked guardrails.
    pub fn requires_firewall(&self) -> bool {
        !self.locked_guardrails.is_empty()
    }
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
    /// Remaining credit budget in micro-USD, or `None` when the org has no
    /// managed budget cap. `Some(b)` with `b <= 0` means the wallet is exhausted.
    pub remaining_budget_micro_usd: Option<i64>,
    /// The org's resolved effective policy (allowlist / locked guardrails / regions).
    pub policy: EffectivePolicy,
}

/// Shape of the control plane's `/gateway/resolve` response (subset).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveResponse {
    #[serde(default)]
    organization: ResolveOrganization,
    #[serde(default)]
    policy: ResolvePolicy,
    /// Whether this org bills through managed inference (credit wallet).
    #[serde(default)]
    managed_inference: bool,
    /// Remaining credit budget in micro-USD (`null` when uncapped).
    #[serde(default)]
    remaining_budget_micro_usd: Option<i64>,
    /// Monthly credit pool in micro-USD (carried for parity; not gated on here).
    #[serde(default)]
    #[allow(dead_code)]
    monthly_credit_pool_micro_usd: i64,
    /// Org-effective firewall overlay (hosted hierarchical policy). Top-level on
    /// the resolve response; its own fields are snake_case. Emitted by the
    /// control plane (§5); the gateway feeds it to the firewall resolver.
    #[serde(default)]
    firewall: Option<crate::config::FirewallOverlay>,
    /// Per-agent firewall overlays keyed by agent id (top-level `agentOverlays`).
    #[serde(default)]
    agent_overlays: std::collections::HashMap<String, crate::config::FirewallOverlay>,
}

/// The `organization` field of the resolve response. We only need the id.
#[derive(Debug, Default, Deserialize)]
struct ResolveOrganization {
    #[serde(default)]
    id: String,
}

impl ResolveResponse {
    /// Map the parsed response into a [`ResolvedOrg`], moving the policy rules out.
    fn into_resolved(self) -> ResolvedOrg {
        ResolvedOrg {
            org_id: self.organization.id,
            managed_inference: self.managed_inference,
            remaining_budget_micro_usd: self.remaining_budget_micro_usd,
            policy: EffectivePolicy {
                locked_guardrails: self.policy.rules.locked_guardrails,
                approved_models: self.policy.rules.approved_models,
                allowed_regions: self.policy.rules.allowed_regions,
                firewall: self.firewall,
                agent_overlays: self.agent_overlays,
            },
        }
    }
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
    allowed_regions: Vec<String>,
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

    /// Fetch and parse the effective policy from the control plane. Errors are
    /// surfaced to the caller, which decides whether to fail open (default,
    /// keep serving with no extra policy) or closed. Uses the shared
    /// [`resolve_token`] mapping so the single-org startup path and the dynamic
    /// per-token path stay in sync.
    pub async fn fetch(&self, http: &reqwest::Client) -> anyhow::Result<EffectivePolicy> {
        let resolved = resolve_token(&self.control_plane_url, http, &self.gateway_key).await?;
        Ok(resolved.policy)
    }
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
) -> anyhow::Result<ResolvedOrg> {
    let endpoint = format!(
        "{}/api/control-plane/gateway/resolve",
        control_plane_url.trim_end_matches('/')
    );
    let resp = http
        .get(&endpoint)
        .header("x-gateway-key", token)
        .timeout(Duration::from_secs(5))
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("control plane returned HTTP {}", resp.status());
    }
    let parsed: ResolveResponse = resp.json().await?;
    Ok(parsed.into_resolved())
}

#[cfg(test)]
mod tests {
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
            "credential": { "id": "cred_1", "keyPrefix": "rgw_abc" },
            "policy": {
                "rules": {
                    "lockedGuardrails": ["pii", "secrets"],
                    "approvedModels": ["gpt-4o"],
                    "allowedRegions": ["eu"]
                },
                "lockedFields": ["approvedModels"]
            },
            "managedInference": true,
            "monthlyCreditPoolMicroUsd": 5_000_000,
            "remainingBudgetMicroUsd": 1_250_000
        });
        let parsed: ResolveResponse = serde_json::from_value(body).unwrap();
        assert_eq!(parsed.policy.rules.approved_models, vec!["gpt-4o"]);
        assert_eq!(parsed.policy.rules.locked_guardrails.len(), 2);
        assert_eq!(parsed.policy.rules.allowed_regions, vec!["eu"]);

        // The previously-dropped fields are now read into the ResolvedOrg.
        let resolved = parsed.into_resolved();
        assert_eq!(resolved.org_id, "o1");
        assert!(resolved.managed_inference);
        assert_eq!(resolved.remaining_budget_micro_usd, Some(1_250_000));
        assert_eq!(resolved.policy.approved_models, vec!["gpt-4o"]);
    }

    #[test]
    fn parses_resolve_response_with_null_budget_and_defaults() {
        // A BYOK/self-hosted org: no managed inference, uncapped budget (null).
        let body = serde_json::json!({
            "organization": { "id": "o2" },
            "policy": { "rules": {} },
            "remainingBudgetMicroUsd": null
        });
        let resolved: ResolvedOrg = serde_json::from_value::<ResolveResponse>(body)
            .unwrap()
            .into_resolved();
        assert_eq!(resolved.org_id, "o2");
        assert!(!resolved.managed_inference);
        assert_eq!(resolved.remaining_budget_micro_usd, None);
        assert!(resolved.policy.approved_models.is_empty());
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
            "policy": { "rules": {} },
            "credentialRotation": { "token": "rgw_durable_should_be_ignored" }
        });
        let resolved = serde_json::from_value::<ResolveResponse>(body)
            .expect("fleet ResolveResponse must tolerate an unknown credentialRotation field")
            .into_resolved();
        assert_eq!(resolved.org_id, "o3");
    }

    #[test]
    fn from_env_requires_both_url_and_key() {
        // With neither set in this test process, the source is None.
        if std::env::var(ENV_CONTROL_PLANE_URL).is_err() && std::env::var(ENV_GATEWAY_KEY).is_err()
        {
            assert!(PolicySource::from_env().is_none());
        }
    }
}
