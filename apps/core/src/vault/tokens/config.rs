//! Token settings, token roles, requests and reports.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::vault::machine::MAX_TOKEN_TTL_SECS;
use crate::vault::VaultError;

use super::cidr::*;
use super::*;

// ── Configuration ─────────────────────────────────────────────────────────

/// Token settings of a machine identity or token role.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenConfig {
    /// Renewable lifetime cap (default 24 h, at most 30 days).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_ttl_secs: Option<i64>,
    /// Hard cap that also applies to periodic tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicit_max_ttl_secs: Option<i64>,
    /// Periodic tokens renew by this many seconds and have no max TTL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period_secs: Option<i64>,
    /// Requests the token may authenticate before it is revoked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_uses: Option<i64>,
    /// Client addresses allowed to log in for and present the token.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bound_cidrs: Vec<String>,
    /// `false` makes issued tokens non-renewable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renewable: Option<bool>,
}

pub(super) fn check_range(field: &str, value: Option<i64>, min: i64, max: i64) -> Result<()> {
    match value {
        Some(value) if !(min..=max).contains(&value) => {
            Err(VaultError::Invalid(format!("`{field}` must be between {min} and {max}")).into())
        }
        _ => Ok(()),
    }
}

impl TokenConfig {
    /// Validate ranges and canonicalize CIDRs. `numUses: 0` means unlimited.
    pub fn normalize(mut self) -> Result<Self> {
        check_range("maxTtlSecs", self.max_ttl_secs, 60, MAX_TOKEN_MAX_TTL_SECS)?;
        check_range(
            "explicitMaxTtlSecs",
            self.explicit_max_ttl_secs,
            MIN_CHILD_TTL_SECS,
            MAX_TOKEN_MAX_TTL_SECS,
        )?;
        check_range("periodSecs", self.period_secs, 60, MAX_TOKEN_TTL_SECS)?;
        check_range("numUses", self.num_uses, 0, 1_000_000)?;
        if self.num_uses == Some(0) {
            self.num_uses = None;
        }
        self.bound_cidrs = normalize_cidrs(&self.bound_cidrs)?;
        Ok(self)
    }

    /// Hard expiry for a token created `now` with `ttl_secs`.
    pub(super) fn max_expires_at(&self, now: i64, ttl_secs: i64) -> Option<i64> {
        let explicit = self.explicit_max_ttl_secs;
        let cap = if self.period_secs.is_some() {
            explicit?
        } else {
            let max = self
                .max_ttl_secs
                .unwrap_or(MAX_TOKEN_TTL_SECS)
                .max(ttl_secs);
            explicit.map_or(max, |explicit| max.min(explicit))
        };
        Some(now + cap * 1000)
    }
}

/// A named template for minting child and admin-created tokens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenRole {
    pub name: String,
    /// Policies a token from this role may carry (empty: any the creator holds).
    pub allowed_policies: Vec<String>,
    /// Policies a token from this role may never carry.
    pub disallowed_policies: Vec<String>,
    /// Tokens from this role have no parent and survive its revocation.
    pub orphan: bool,
    /// Default TTL of tokens from this role.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_secs: Option<i64>,
    #[serde(flatten)]
    pub token: TokenConfig,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A request to mint a child or admin-created token. Unset fields come from
/// the role, then the identity.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TokenRequest {
    pub role: Option<String>,
    pub policies: Option<Vec<String>>,
    pub ttl_secs: Option<i64>,
    pub explicit_max_ttl_secs: Option<i64>,
    pub period_secs: Option<i64>,
    pub num_uses: Option<i64>,
    pub bound_cidrs: Option<Vec<String>>,
    pub orphan: Option<bool>,
    pub renewable: Option<bool>,
}

/// AppRole secret id options beyond TTL and use count.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SecretIdOptions {
    pub ttl_secs: Option<i64>,
    pub uses: Option<i64>,
    /// Client addresses allowed to log in with this secret id.
    pub cidr_list: Vec<String>,
    /// CIDRs bound to tokens issued with this secret id (must lie inside the
    /// identity's `boundCidrs` when it has any).
    pub token_bound_cidrs: Vec<String>,
}

/// Token metadata (never the token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub accessor: String,
    pub identity_id: String,
    pub policies: Vec<String>,
    pub parent_accessor: Option<String>,
    pub orphan: bool,
    pub role: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub max_expires_at: Option<i64>,
    pub period_secs: Option<i64>,
    pub num_uses_remaining: Option<i64>,
    pub bound_cidrs: Vec<String>,
    pub renewable: bool,
    pub last_used_at: Option<i64>,
    pub revoked_at: Option<i64>,
    /// Seconds until expiry (0 once expired or revoked).
    pub ttl_secs: i64,
}

/// What a revocation touched.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeReport {
    pub tokens: usize,
    pub leases_revoked: usize,
    pub leases_failed: usize,
}
