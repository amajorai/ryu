//! The `PolicyAlert` wire shape: the gateway's stamp on a governed response that
//! tells Core (self-host) or the control-plane (managed) that a policy matched
//! and which notification tier it wants fanned out.
//!
//! This is the gateway half of the "generalized policy-action framework" (spec
//! §2.2c). The gateway DECIDES (which tier fires); Core/control-plane DELIVER.
//! The alert rides the HTTP response header `x-ryu-policy-alert` as
//! `base64(json)` on BOTH the Ok (2xx) response AND the Err (402/403/block)
//! response, so a block-tier alert (the case that returns before any Ok Response
//! exists) is never dropped. Core decodes leniently: a malformed header is
//! skipped, never fatal.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::budget::{BudgetDecision, BudgetScope};
use crate::config::AlertTier;

/// HTTP response header the gateway stamps and Core reads.
pub const POLICY_ALERT_HEADER: &str = "x-ryu-policy-alert";

/// The gateway's policy-match stamp. Serialized to `base64(json)` on the wire.
///
/// Field names are the wire contract (Core reads them verbatim) — do NOT rename
/// without updating the Core reader at `apps/core/src/policy_alerts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyAlert {
    /// What kind of policy matched: `budget` | `session_budget` | `wallet_empty`
    /// | `firewall`.
    pub source: String,
    /// The enforcement action taken: `notify` | `downgrade` | `restrict` |
    /// `stop` | `block`.
    pub enforcement: String,
    /// The notification fan-out tier the matched rule requested.
    pub alert_tier: AlertTier,
    /// The identity dimension the decision applies to: `user` | `agent` |
    /// `session` | `request`.
    pub scope: String,
    /// The subject id within `scope` (user id, agent id, session id, org id), or
    /// empty when there is none.
    pub subject_key: String,
    /// Tokens/units used when the rule matched (0 for firewall / wallet-empty).
    pub used: u64,
    /// The configured limit that was reached (0 when not applicable).
    pub limit: u64,
    /// Stable per-episode key so the deliverer can debounce repeats. Deterministic
    /// across gateway restarts (a fixed sha256, never a per-boot random hash).
    pub dedupe_key: String,
    /// Owning org id for managed routing, or empty for a single-tenant node.
    pub org_id: String,
}

impl PolicyAlert {
    /// Build a `PolicyAlert` from a matched budget/session/wallet decision. The
    /// `source`/`scope` are inferred from the decision using the invariant that
    /// `BudgetEnforcer::decide` only returns a live decision when `limit > 0`, so
    /// any live decision with `limit == 0` is the wallet-empty rule.
    ///
    /// `tier` is the MAX alert tier across all matched decisions (computed by the
    /// caller), which can exceed this single decision's own configured tier.
    pub fn from_budget_decision(d: &BudgetDecision, tier: AlertTier, org_id: &str) -> Self {
        // limit == 0 ⟺ wallet-empty (decide() returns None for limit == 0 rules,
        // so the only live limit==0 decision is the synthetic wallet rule).
        if d.limit == 0 {
            return Self::wallet_empty(&d.key, enforcement_label(d.action), tier, org_id);
        }
        match d.scope {
            BudgetScope::Session => {
                Self::session(&d.key, enforcement_label(d.action), tier, d.used, d.limit, org_id)
            }
            BudgetScope::User | BudgetScope::Agent => Self::budget(
                scope_label(d.scope),
                &d.key,
                enforcement_label(d.action),
                tier,
                d.used,
                d.limit,
                org_id,
            ),
        }
    }

    /// A per-user / per-agent token-budget alert.
    pub fn budget(
        scope: &str,
        subject_key: &str,
        enforcement: &str,
        tier: AlertTier,
        used: u64,
        limit: u64,
        org_id: &str,
    ) -> Self {
        Self::new("budget", enforcement, tier, scope, subject_key, used, limit, org_id)
    }

    /// A per-session running-cap alert.
    pub fn session(
        subject_key: &str,
        enforcement: &str,
        tier: AlertTier,
        used: u64,
        limit: u64,
        org_id: &str,
    ) -> Self {
        Self::new(
            "session_budget",
            enforcement,
            tier,
            "session",
            subject_key,
            used,
            limit,
            org_id,
        )
    }

    /// An org wallet-empty alert.
    pub fn wallet_empty(subject_key: &str, enforcement: &str, tier: AlertTier, org_id: &str) -> Self {
        Self::new(
            "wallet_empty",
            enforcement,
            tier,
            "user",
            subject_key,
            0,
            0,
            org_id,
        )
    }

    /// A firewall / DLP inbound-match alert. `enforcement` is `block` (Block) or
    /// `notify` (WarnAndContinue).
    pub fn firewall(enforcement: &str, tier: AlertTier, org_id: &str) -> Self {
        Self::new("firewall", enforcement, tier, "request", "", 0, 0, org_id)
    }

    #[allow(clippy::too_many_arguments)]
    fn new(
        source: &str,
        enforcement: &str,
        alert_tier: AlertTier,
        scope: &str,
        subject_key: &str,
        used: u64,
        limit: u64,
        org_id: &str,
    ) -> Self {
        let dedupe_key = dedupe_key(source, scope, subject_key, limit);
        Self {
            source: source.to_string(),
            enforcement: enforcement.to_string(),
            alert_tier,
            scope: scope.to_string(),
            subject_key: subject_key.to_string(),
            used,
            limit,
            dedupe_key,
            org_id: org_id.to_string(),
        }
    }

    /// Encode as `base64(json)` for the `x-ryu-policy-alert` header value. Standard
    /// alphabet, no line wrapping (Core decodes with the standard engine).
    pub fn to_header(&self) -> String {
        // serde_json on a plain struct of strings/u64s cannot fail; fall back to
        // an empty object rather than panicking on the (unreachable) error.
        let json = serde_json::to_vec(self).unwrap_or_else(|_| b"{}".to_vec());
        B64.encode(json)
    }

    /// Decode a `base64(json)` header value. Lenient: any decode/parse failure
    /// returns `None` so a malformed header is skipped, never fatal.
    pub fn from_header(value: &str) -> Option<PolicyAlert> {
        let bytes = B64.decode(value.trim()).ok()?;
        serde_json::from_slice(&bytes).ok()
    }
}

/// Stable hex dedupe key over the identifying fields. Deterministic across
/// process restarts (a fixed sha256, not a seeded `Hash`), because Core dedupes
/// on this key in a persistent store and the gateway may recompute it for the
/// same breach after a restart. The limit is bucketed as-is (an integer cap is
/// already a stable bucket).
fn dedupe_key(source: &str, scope: &str, subject_key: &str, limit: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    hasher.update([0u8]);
    hasher.update(scope.as_bytes());
    hasher.update([0u8]);
    hasher.update(subject_key.as_bytes());
    hasher.update([0u8]);
    hasher.update(limit.to_le_bytes());
    hex::encode(hasher.finalize())
}

/// Stable lowercase enforcement label for a budget action.
fn enforcement_label(action: crate::config::BudgetAction) -> &'static str {
    match action {
        crate::config::BudgetAction::Notify => "notify",
        crate::config::BudgetAction::Downgrade => "downgrade",
        crate::config::BudgetAction::Restrict => "restrict",
        crate::config::BudgetAction::Stop => "stop",
    }
}

/// Wire label for a budget scope.
fn scope_label(scope: BudgetScope) -> &'static str {
    match scope {
        BudgetScope::User => "user",
        BudgetScope::Agent => "agent",
        BudgetScope::Session => "session",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;

    #[test]
    fn round_trips_base64_header() {
        let alert = PolicyAlert::budget("user", "u123", "stop", AlertTier::Email, 1200, 1000, "org1");
        let header = alert.to_header();
        let decoded = PolicyAlert::from_header(&header).expect("header should decode");
        assert_eq!(alert, decoded);
        assert_eq!(decoded.source, "budget");
        assert_eq!(decoded.enforcement, "stop");
        assert_eq!(decoded.alert_tier, AlertTier::Email);
    }

    #[test]
    fn from_header_is_lenient_on_garbage() {
        assert!(PolicyAlert::from_header("not!!base64").is_none());
        // Valid base64 that is not our JSON shape.
        assert!(PolicyAlert::from_header(&B64.encode(b"[]")).is_none());
    }

    #[test]
    fn dedupe_key_is_stable_across_calls() {
        let a = PolicyAlert::budget("user", "u1", "stop", AlertTier::Warn, 5, 10, "org");
        let b = PolicyAlert::budget("user", "u1", "notify", AlertTier::Email, 9, 10, "org");
        // Same (source, scope, subject, limit) ⇒ same dedupe key regardless of
        // enforcement/tier/used, so repeat episodes debounce.
        assert_eq!(a.dedupe_key, b.dedupe_key);
        let c = PolicyAlert::budget("user", "u2", "stop", AlertTier::Warn, 5, 10, "org");
        assert_ne!(a.dedupe_key, c.dedupe_key);
    }

    /// F1 regression guard: the budget-stop error path MUST emit the
    /// `x-ryu-policy-alert` header on the 402 response, since that Response only
    /// ever exists inside `GatewayError::into_response`.
    #[test]
    fn budget_stop_error_response_carries_header() {
        let alert = PolicyAlert::budget("user", "u1", "stop", AlertTier::Email, 1200, 1000, "org1");
        let err = crate::error::GatewayError::BudgetExceeded(Some(alert.clone()));
        let resp = err.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::PAYMENT_REQUIRED);
        let header = resp
            .headers()
            .get(POLICY_ALERT_HEADER)
            .expect("error response must carry the policy-alert header");
        let decoded =
            PolicyAlert::from_header(header.to_str().unwrap()).expect("header should decode");
        assert_eq!(decoded, alert);
    }

    /// The firewall block error path must also stamp the header.
    #[test]
    fn firewall_block_error_response_carries_header() {
        let alert = PolicyAlert::firewall("block", AlertTier::Fanout, "org1");
        let err =
            crate::error::GatewayError::FirewallBlocked("blocked: ssn".to_string(), Some(alert.clone()));
        let resp = err.into_response();
        assert_eq!(resp.status(), axum::http::StatusCode::FORBIDDEN);
        let header = resp
            .headers()
            .get(POLICY_ALERT_HEADER)
            .expect("firewall error response must carry the policy-alert header");
        let decoded =
            PolicyAlert::from_header(header.to_str().unwrap()).expect("header should decode");
        assert_eq!(decoded, alert);
    }
}
