//! Machine vault token lifecycle.
//!
//! [`super::machine`] issues `rvt_…` tokens at login. This module owns what a
//! token can do after that, following the HashiCorp Vault / OpenBao token
//! model:
//!
//! * **TTLs**: every token has a TTL and a hard `maxExpiresAt` (from the
//!   identity's `maxTtlSecs`, capped by `explicitMaxTtlSecs`). Renewal
//!   (`renew-self`, or an admin by accessor) extends it up to that cap.
//! * **Periodic tokens**: a `periodSecs` token renews by one period at a time
//!   and has no max TTL unless an explicit one is set.
//! * **Use limits**: `numUses` is decremented atomically on every request the
//!   token authenticates; the token is revoked when it reaches zero.
//! * **CIDR binding**: `boundCidrs` restrict the client address that may
//!   present (or log in for) the token. AppRole secret ids carry their own
//!   `cidrList` (login) and `tokenBoundCidrs` (issued token).
//! * **Child tokens**: a token can mint a narrower child (policy subset, TTL
//!   capped by the parent, optionally use-limited). Revoking a token revokes
//!   its non-orphan descendants, the leases they hold, and their cubbyholes.
//! * **Token roles**: named templates (`allowedPolicies`, `orphan`, period,
//!   limits) that child and admin-created tokens can be minted from.
//!
//! The HTTP layer runs every vault request inside a [`RequestContext`] that
//! carries the resolved client address, so CIDR checks and lease attribution
//! work without threading extra arguments through every handler.

/// Longest hard lifetime of a renewable token (30 days).
pub const MAX_TOKEN_MAX_TTL_SECS: i64 = 30 * 24 * 3600;
/// Shortest TTL for a child or admin-created token.
pub const MIN_CHILD_TTL_SECS: i64 = 10;
/// Deepest parent chain a child token may sit under.
pub const MAX_CHILD_DEPTH: usize = 8;
/// Most CIDR blocks one token, role, or secret id may carry.
pub const MAX_CIDRS: usize = 32;
/// Env var listing proxy CIDRs whose `X-Forwarded-For` is trusted.
pub const ENV_TRUSTED_PROXIES: &str = "RYU_VAULT_TRUSTED_PROXIES";

mod admit_create;
mod cidr;
mod config;
mod context;
mod issue;
mod revoke_roles;
mod schema;

pub use cidr::{cidrs_within, ip_allowed, normalize_cidrs, resolve_client_ip, trusted_proxies};
pub use config::{SecretIdOptions, TokenConfig, TokenInfo, TokenRequest, TokenRole};
pub use context::{request_client_ip, with_request_context, RequestContext};
pub(crate) use issue::{
    identity_token, insert_token_locked, token_info_locked, token_policies_now_locked,
    withhold_token_locked,
};
pub use schema::init_schema;
pub(crate) use schema::request_lease_holder_locked;

// Public before the split but not named outside this module today (or only by
// tests). Re-exported so every `vault::tokens::<item>` path stays stable.
#[allow(unused_imports)]
pub use cidr::Cidr;
#[allow(unused_imports)]
pub use config::RevokeReport;
#[allow(unused_imports)]
pub use context::request_token_accessor;
#[allow(unused_imports)]
pub(crate) use issue::{NewToken, ParentToken};
#[allow(unused_imports)]
pub(crate) use schema::add_column;

#[cfg(test)]
mod admit_create_tests;
#[cfg(test)]
mod issue_tests;
#[cfg(test)]
mod revoke_roles_tests;
#[cfg(test)]
mod schema_tests;
#[cfg(test)]
mod tests;
