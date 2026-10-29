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

use std::collections::BTreeSet;
use std::future::Future;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audit::{AuditActor, AuditEntry};
use super::machine::{IssuedToken, MachineIdentity, DEFAULT_TOKEN_TTL_SECS, MAX_TOKEN_TTL_SECS};
use super::{now_millis, random_token, sha256_hex, VaultError};
use crate::plugin_secrets::PluginSecretStore;

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

// ── Request context ───────────────────────────────────────────────────────

/// Per-request facts the token layer needs: the resolved client address and
/// the accessor of the token that authenticated the request (for lease
/// attribution).
#[derive(Clone, Default)]
pub struct RequestContext {
    client_ip: Option<IpAddr>,
    token_accessor: Arc<Mutex<Option<String>>>,
}

impl RequestContext {
    pub fn new(client_ip: Option<IpAddr>) -> Self {
        Self {
            client_ip,
            token_accessor: Arc::default(),
        }
    }

    /// The accessor of the token that authenticated this request, if any.
    pub fn token_accessor(&self) -> Option<String> {
        self.token_accessor
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }
}

tokio::task_local! {
    static REQUEST: RequestContext;
}

/// Run `future` with `context` as the current request context.
pub async fn with_request_context<F: Future>(context: RequestContext, future: F) -> F::Output {
    REQUEST.scope(context, future).await
}

/// The current request's client address. `None` outside an HTTP request or
/// when the address cannot be trusted, so CIDR-bound tokens fail closed.
pub fn request_client_ip() -> Option<IpAddr> {
    REQUEST.try_with(|context| context.client_ip).ok().flatten()
}

fn note_request_token(accessor: &str) {
    let _ = REQUEST.try_with(|context| {
        if let Ok(mut guard) = context.token_accessor.lock() {
            *guard = Some(accessor.to_owned());
        }
    });
}

/// The accessor of the token that authenticated the current request.
pub fn request_token_accessor() -> Option<String> {
    REQUEST
        .try_with(RequestContext::token_accessor)
        .ok()
        .flatten()
}

// ── CIDR blocks ───────────────────────────────────────────────────────────

/// One IPv4 or IPv6 CIDR block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    network: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parse `10.0.0.0/8`, `fd00::/8`, or a bare address (a host block).
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let (address, prefix) = match text.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix.parse::<u8>().ok()?)),
            None => (text, None),
        };
        let address: IpAddr = address.parse().ok()?;
        let address = address.to_canonical();
        let width = if address.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(width);
        if prefix > width {
            return None;
        }
        Some(Self {
            network: mask(address, prefix),
            prefix,
        })
    }

    /// Whether `ip` is inside this block.
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = ip.to_canonical();
        ip.is_ipv4() == self.network.is_ipv4() && mask(ip, self.prefix) == self.network
    }

    /// Whether every address of `other` is inside this block.
    pub fn covers(&self, other: &Cidr) -> bool {
        self.prefix <= other.prefix && self.contains(other.network)
    }
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.network, self.prefix)
    }
}

fn mask(ip: IpAddr, prefix: u8) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => {
            let bits = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - u32::from(prefix))
            };
            IpAddr::V4((u32::from(v4) & bits).into())
        }
        IpAddr::V6(v6) => {
            let bits = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - u32::from(prefix))
            };
            IpAddr::V6((u128::from(v6) & bits).into())
        }
    }
}

/// Validate and canonicalize a CIDR list (deduplicated, at most [`MAX_CIDRS`]).
pub fn normalize_cidrs(list: &[String]) -> Result<Vec<String>> {
    if list.len() > MAX_CIDRS {
        return Err(VaultError::Invalid(format!("at most {MAX_CIDRS} CIDR blocks")).into());
    }
    let mut out = Vec::new();
    for entry in list {
        let cidr = Cidr::parse(entry)
            .ok_or_else(|| VaultError::Invalid(format!("`{entry}` is not a CIDR block")))?;
        let text = cidr.to_string();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    Ok(out)
}

/// Whether `ip` satisfies `cidrs`. An empty list allows any address; a
/// non-empty list requires a known address inside one of the blocks.
pub fn ip_allowed(cidrs: &[String], ip: Option<IpAddr>) -> bool {
    cidrs.is_empty()
        || ip.is_some_and(|ip| {
            cidrs
                .iter()
                .filter_map(|cidr| Cidr::parse(cidr))
                .any(|cidr| cidr.contains(ip))
        })
}

/// Whether every block in `inner` lies inside some block of `outer` (an empty
/// `outer` admits anything).
pub fn cidrs_within(inner: &[String], outer: &[String]) -> bool {
    if outer.is_empty() {
        return true;
    }
    let outer: Vec<Cidr> = outer.iter().filter_map(|c| Cidr::parse(c)).collect();
    inner.iter().all(|entry| {
        Cidr::parse(entry).is_some_and(|cidr| outer.iter().any(|block| block.covers(&cidr)))
    })
}

/// Proxies whose `X-Forwarded-For` header is trusted
/// (`RYU_VAULT_TRUSTED_PROXIES`, comma-separated CIDRs; empty by default).
pub fn trusted_proxies() -> Vec<Cidr> {
    std::env::var(ENV_TRUSTED_PROXIES)
        .unwrap_or_default()
        .split(',')
        .filter(|entry| !entry.trim().is_empty())
        .filter_map(Cidr::parse)
        .collect()
}

/// Resolve the client address of a request.
///
/// The socket peer is authoritative. `X-Forwarded-For` is honored only when
/// the peer is a configured trusted proxy, and then the right-most entry that
/// is not itself a trusted proxy wins. A loopback peer behind Core's own
/// forwarding tunnel is a remote client of unknown address, so the result is
/// `None` and CIDR-bound tokens fail closed.
pub fn resolve_client_ip(
    peer: Option<IpAddr>,
    forwarded_for: Option<&str>,
    trusted: &[Cidr],
    tunnel_active: bool,
) -> Option<IpAddr> {
    let peer = peer?.to_canonical();
    if peer.is_loopback() && tunnel_active {
        return None;
    }
    if !trusted.iter().any(|proxy| proxy.contains(peer)) {
        return Some(peer);
    }
    let Some(header) = forwarded_for else {
        return Some(peer);
    };
    for hop in header.rsplit(',') {
        let ip: IpAddr = hop.trim().parse().ok()?;
        let ip = ip.to_canonical();
        if !trusted.iter().any(|proxy| proxy.contains(ip)) {
            return Some(ip);
        }
    }
    Some(peer)
}

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

fn check_range(field: &str, value: Option<i64>, min: i64, max: i64) -> Result<()> {
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
    fn max_expires_at(&self, now: i64, ttl_secs: i64) -> Option<i64> {
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

// ── Schema ────────────────────────────────────────────────────────────────

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `ALTER TABLE … ADD COLUMN` unless the column already exists.
pub(crate) fn add_column(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}

/// Add the lifecycle columns and the token-role table. Runs after the machine
/// and lease schemas; idempotent and backward compatible.
pub fn init_schema(conn: &Connection) -> Result<()> {
    for (column, decl) in [
        ("parent_accessor", "TEXT"),
        ("orphan", "INTEGER NOT NULL DEFAULT 0"),
        ("max_expires_at", "INTEGER"),
        ("period_secs", "INTEGER"),
        ("num_uses", "INTEGER"),
        ("bound_cidrs", "TEXT"),
        ("role", "TEXT"),
        ("ttl_secs", "INTEGER"),
        ("scoped", "INTEGER NOT NULL DEFAULT 0"),
        ("renewable", "INTEGER NOT NULL DEFAULT 1"),
    ] {
        add_column(conn, "vault_tokens", column, decl)?;
    }
    add_column(conn, "vault_machine_identities", "token_config", "TEXT")?;
    add_column(conn, "vault_approle_secret_ids", "cidr_list", "TEXT")?;
    add_column(
        conn,
        "vault_approle_secret_ids",
        "token_bound_cidrs",
        "TEXT",
    )?;
    add_column(conn, "vault_leases", "token_accessor", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS vault_tokens_parent ON vault_tokens (parent_accessor);
         CREATE INDEX IF NOT EXISTS vault_leases_token ON vault_leases (token_accessor);
         CREATE TABLE IF NOT EXISTS vault_token_roles (
             name       TEXT PRIMARY KEY,
             config     TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );",
    )
    .context("initializing token lifecycle schema")
}

fn json_list(text: Option<String>) -> Vec<String> {
    text.and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn list_json(list: &[String]) -> Result<Option<String>> {
    Ok(if list.is_empty() {
        None
    } else {
        Some(serde_json::to_string(list)?)
    })
}

/// Record the current request's token on a freshly created lease, so revoking
/// the token revokes the lease.
pub(crate) fn attach_request_token_locked(conn: &Connection, lease_id: &str) -> Result<()> {
    if let Some(accessor) = request_token_accessor() {
        conn.execute(
            "UPDATE vault_leases SET token_accessor = ?1 WHERE id = ?2",
            params![accessor, lease_id],
        )?;
    }
    Ok(())
}

// ── Issuing ───────────────────────────────────────────────────────────────

/// A token row to insert.
#[derive(Debug, Clone)]
pub(crate) struct NewToken {
    pub identity_id: String,
    pub policies: Vec<String>,
    /// Whether `policies` narrows the identity's live policies.
    pub scoped: bool,
    pub ttl_secs: i64,
    pub max_expires_at: Option<i64>,
    /// Upper bound on the first expiry (a parent's expiry).
    pub expires_cap: Option<i64>,
    pub period_secs: Option<i64>,
    pub num_uses: Option<i64>,
    pub bound_cidrs: Vec<String>,
    pub parent_accessor: Option<String>,
    pub orphan: bool,
    pub role: Option<String>,
    pub renewable: bool,
}

/// The token an identity receives at login. `cidr_override` carries an
/// AppRole secret id's `tokenBoundCidrs`.
pub(crate) fn identity_token(
    identity: &MachineIdentity,
    policies: Vec<String>,
    cidr_override: Option<Vec<String>>,
    now: i64,
) -> NewToken {
    let config = &identity.token_config;
    let ttl_secs = config.period_secs.unwrap_or(identity.token_ttl_secs);
    NewToken {
        identity_id: identity.id.clone(),
        policies,
        scoped: false,
        ttl_secs,
        max_expires_at: config.max_expires_at(now, ttl_secs),
        expires_cap: None,
        period_secs: config.period_secs,
        num_uses: config.num_uses,
        bound_cidrs: cidr_override
            .filter(|cidrs| !cidrs.is_empty())
            .unwrap_or_else(|| config.bound_cidrs.clone()),
        parent_accessor: None,
        orphan: false,
        role: None,
        renewable: config.renewable.unwrap_or(true),
    }
}

/// Delete a token whose issuance audit was refused under fail-closed, so
/// the withheld bearer token can never be presented.
pub(crate) fn withhold_token_locked(conn: &Connection, accessor: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_tokens WHERE accessor = ?1",
        params![accessor],
    )?;
    Ok(())
}

/// Insert a token row and return the token (shown once).
pub(crate) fn insert_token_locked(conn: &Connection, new: &NewToken) -> Result<IssuedToken> {
    let token = random_token("rvt_");
    let accessor = random_token("rva_");
    let now = now_millis();
    let mut expires_at = now + new.ttl_secs * 1000;
    if let Some(max) = new.max_expires_at {
        expires_at = expires_at.min(max);
    }
    if let Some(cap) = new.expires_cap {
        expires_at = expires_at.min(cap);
    }
    conn.execute(
        "INSERT INTO vault_tokens
             (accessor, digest, identity_id, policies, created_at, expires_at, parent_accessor,
              orphan, max_expires_at, period_secs, num_uses, bound_cidrs, role, ttl_secs, scoped,
              renewable)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            accessor,
            sha256_hex(token.as_bytes()),
            new.identity_id,
            serde_json::to_string(&new.policies)?,
            now,
            expires_at,
            new.parent_accessor,
            new.orphan as i64,
            new.max_expires_at,
            new.period_secs,
            new.num_uses,
            list_json(&new.bound_cidrs)?,
            new.role,
            new.ttl_secs,
            new.scoped as i64,
            new.renewable as i64,
        ],
    )?;
    Ok(IssuedToken {
        token,
        accessor,
        identity_id: new.identity_id.clone(),
        policies: new.policies.clone(),
        expires_at,
    })
}

const INFO_COLUMNS: &str = "accessor, identity_id, policies, parent_accessor, orphan, role,
     created_at, expires_at, max_expires_at, period_secs, num_uses, bound_cidrs, renewable,
     last_used_at, revoked_at";

fn info_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TokenInfo> {
    let expires_at: i64 = row.get(7)?;
    let revoked_at: Option<i64> = row.get(14)?;
    let ttl_secs = if revoked_at.is_some() {
        0
    } else {
        ((expires_at - now_millis()) / 1000).max(0)
    };
    Ok(TokenInfo {
        accessor: row.get(0)?,
        identity_id: row.get(1)?,
        policies: json_list(row.get(2)?),
        parent_accessor: row.get(3)?,
        orphan: row.get::<_, i64>(4)? != 0,
        role: row.get(5)?,
        created_at: row.get(6)?,
        expires_at,
        max_expires_at: row.get(8)?,
        period_secs: row.get(9)?,
        num_uses_remaining: row.get(10)?,
        bound_cidrs: json_list(row.get(11)?),
        renewable: row.get::<_, i64>(12)? != 0,
        last_used_at: row.get(13)?,
        revoked_at,
        ttl_secs,
    })
}

pub(crate) fn token_info_locked(conn: &Connection, accessor: &str) -> Result<TokenInfo> {
    conn.query_row(
        &format!("SELECT {INFO_COLUMNS} FROM vault_tokens WHERE accessor = ?1"),
        params![accessor],
        info_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("token `{accessor}`")).into())
}

fn is_live(info: &TokenInfo, now: i64) -> bool {
    info.revoked_at.is_none() && info.expires_at > now
}

/// Walk the parent chain; `None` when an ancestor is gone, revoked, or
/// expired, otherwise the depth (0 for a root token).
fn live_depth_locked(conn: &Connection, parent: Option<String>, now: i64) -> Result<Option<usize>> {
    let mut depth = 0;
    let mut next = parent;
    while let Some(accessor) = next {
        depth += 1;
        if depth > MAX_CHILD_DEPTH + 1 {
            return Ok(None);
        }
        let row: Option<(Option<String>, i64, Option<i64>)> = conn
            .query_row(
                "SELECT parent_accessor, expires_at, revoked_at FROM vault_tokens
                 WHERE accessor = ?1",
                params![accessor],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        match row {
            Some((parent, expires_at, None)) if expires_at > now => next = parent,
            _ => return Ok(None),
        }
    }
    Ok(Some(depth))
}

fn load_role_locked(conn: &Connection, name: &str) -> Result<TokenRole> {
    let row: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT config, created_at, updated_at FROM vault_token_roles WHERE name = ?1",
            params![name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (config, created_at, updated_at) =
        row.ok_or_else(|| VaultError::NotFound(format!("token role `{name}`")))?;
    let mut role: TokenRole = serde_json::from_str(&config)?;
    role.name = name.to_owned();
    role.created_at = created_at;
    role.updated_at = updated_at;
    Ok(role)
}

/// The parent of a child token being minted.
pub(crate) struct ParentToken<'a> {
    pub accessor: &'a str,
    /// The parent's effective policies right now.
    pub policies: &'a [String],
}

fn min_opt(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Resolve the policies of a new token: a subset of `base`, inside the
/// role's allow list and outside its deny list.
fn child_policies(
    base: &[String],
    requested: Option<Vec<String>>,
    role: Option<&TokenRole>,
) -> Result<Vec<String>> {
    let allowed = role
        .map(|role| role.allowed_policies.as_slice())
        .unwrap_or_default();
    let disallowed = role
        .map(|role| role.disallowed_policies.as_slice())
        .unwrap_or_default();
    let policies: Vec<String> = match requested {
        Some(requested) => {
            let mut seen = BTreeSet::new();
            requested
                .into_iter()
                .filter(|policy| seen.insert(policy.clone()))
                .collect()
        }
        None => base
            .iter()
            .filter(|policy| allowed.is_empty() || allowed.contains(policy))
            .cloned()
            .collect(),
    };
    for policy in &policies {
        if !base.contains(policy) {
            return Err(VaultError::Denied(format!(
                "policy `{policy}` is not held by the creating token"
            ))
            .into());
        }
        if (!allowed.is_empty() && !allowed.contains(policy)) || disallowed.contains(policy) {
            return Err(
                VaultError::Denied(format!("the token role does not allow `{policy}`")).into(),
            );
        }
    }
    Ok(policies)
}

/// A scoped (child) token keeps only the policies it was minted with.
fn narrow_scoped_locked(
    conn: &Connection,
    accessor: &str,
    info: &TokenInfo,
    policies: &mut Vec<String>,
) -> Result<()> {
    let scoped: i64 = conn.query_row(
        "SELECT scoped FROM vault_tokens WHERE accessor = ?1",
        params![accessor],
        |row| row.get(0),
    )?;
    if scoped != 0 {
        policies.retain(|policy| info.policies.contains(policy));
    }
    Ok(())
}

/// The policies a token may use now, for a credential that acts on its
/// behalf later (a broker session it minted): `None` when an ancestor is
/// gone, revoked, or expired, and a scoped token's own narrowed list. Unlike
/// [`PluginSecretStore::token_admit_locked`] it spends no use: the token is
/// not being presented.
pub(crate) fn token_policies_now_locked(
    conn: &Connection,
    accessor: &str,
    now: i64,
    mut policies: Vec<String>,
) -> Result<Option<Vec<String>>> {
    let info = token_info_locked(conn, accessor)?;
    if live_depth_locked(conn, info.parent_accessor.clone(), now)?.is_none() {
        return Ok(None);
    }
    narrow_scoped_locked(conn, accessor, &info, &mut policies)?;
    Ok(Some(policies))
}

impl PluginSecretStore {
    /// Lifecycle checks for a presented token, run under the connection lock
    /// on every authenticated request: the parent chain must be live, the
    /// client address must satisfy the token's CIDRs, and a use is consumed
    /// (the token is revoked as its last use is spent). Returns the policies
    /// the token may use now, or `None` to reject it.
    pub(crate) fn token_admit_locked(
        &self,
        conn: &Connection,
        accessor: &str,
        now: i64,
        mut policies: Vec<String>,
    ) -> Result<Option<Vec<String>>> {
        let info = token_info_locked(conn, accessor)?;
        if live_depth_locked(conn, info.parent_accessor.clone(), now)?.is_none() {
            return Ok(None);
        }
        if !ip_allowed(&info.bound_cidrs, request_client_ip()) {
            self.audit_locked(
                conn,
                &AuditEntry::new(
                    &AuditActor::new("machine", Some(&info.identity_id)),
                    "token.use",
                    "denied",
                )
                .details(json!({ "accessor": accessor, "reason": "source address not allowed" })),
            );
            return Ok(None);
        }
        if info.num_uses_remaining.is_some() {
            // All SET expressions read the pre-update row, so the use that
            // brings the count to zero also revokes the token, atomically.
            let consumed = conn.execute(
                "UPDATE vault_tokens
                 SET num_uses = num_uses - 1,
                     revoked_at = CASE WHEN num_uses <= 1 THEN ?1 ELSE revoked_at END
                 WHERE accessor = ?2 AND num_uses > 0 AND revoked_at IS NULL",
                params![now, accessor],
            )?;
            if consumed == 0 {
                return Ok(None);
            }
        }
        narrow_scoped_locked(conn, accessor, &info, &mut policies)?;
        note_request_token(accessor);
        Ok(Some(policies))
    }

    /// Token metadata by accessor.
    pub async fn token_info(&self, accessor: &str) -> Result<TokenInfo> {
        let conn = self.conn.lock().await;
        token_info_locked(&conn, accessor)
    }

    /// Live tokens, optionally for one identity (id or name), newest first.
    pub async fn token_list(&self, identity: Option<&str>) -> Result<Vec<TokenInfo>> {
        let conn = self.conn.lock().await;
        let identity_id = match identity {
            Some(identity) => Some(super::machine::identity_locked(&conn, identity)?.id),
            None => None,
        };
        let mut stmt = conn.prepare(&format!(
            "SELECT {INFO_COLUMNS} FROM vault_tokens
             WHERE (?1 IS NULL OR identity_id = ?1) AND revoked_at IS NULL AND expires_at > ?2
             ORDER BY created_at DESC LIMIT 1000"
        ))?;
        let rows = stmt.query_map(params![identity_id, now_millis()], info_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Renew a token by accessor. A periodic token gains one period; others
    /// gain `increment_secs` (default: the token's TTL). Never past the max
    /// TTL or a live parent's expiry, and never shortened.
    pub async fn token_renew(
        &self,
        accessor: &str,
        increment_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<TokenInfo> {
        let conn = self.conn.lock().await;
        let info = token_info_locked(&conn, accessor)?;
        let now = now_millis();
        if !is_live(&info, now) {
            return Err(VaultError::Conflict("the token has expired or was revoked".into()).into());
        }
        if !info.renewable {
            return Err(VaultError::Denied("this token is not renewable".into()).into());
        }
        if live_depth_locked(&conn, info.parent_accessor.clone(), now)?.is_none() {
            return Err(VaultError::Conflict("the parent token is no longer live".into()).into());
        }
        let ttl_secs: Option<i64> = conn.query_row(
            "SELECT ttl_secs FROM vault_tokens WHERE accessor = ?1",
            params![accessor],
            |row| row.get(0),
        )?;
        let increment = match info.period_secs {
            Some(period) => period,
            None => increment_secs
                .or(ttl_secs)
                .unwrap_or(DEFAULT_TOKEN_TTL_SECS)
                .clamp(1, MAX_TOKEN_MAX_TTL_SECS),
        };
        let mut expires_at = now + increment * 1000;
        if let Some(max) = info.max_expires_at {
            expires_at = expires_at.min(max);
        }
        if let Some(parent) = &info.parent_accessor {
            expires_at = expires_at.min(token_info_locked(&conn, parent)?.expires_at);
        }
        let expires_at = expires_at.max(info.expires_at);
        conn.execute(
            "UPDATE vault_tokens SET expires_at = ?1 WHERE accessor = ?2",
            params![expires_at, accessor],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "token.renew", "ok")
                .details(json!({ "accessor": accessor, "expiresAt": expires_at })),
        );
        token_info_locked(&conn, accessor)
    }

    /// Mint a token for `identity_id`. With `parent`, the token is a child
    /// (policy subset, TTL capped by the parent) unless the role makes it an
    /// orphan; without, an administrator is minting a root token.
    fn token_create_locked(
        &self,
        conn: &Connection,
        identity: &MachineIdentity,
        base_policies: &[String],
        parent: Option<&ParentToken<'_>>,
        request: TokenRequest,
        actor: &AuditActor,
    ) -> Result<IssuedToken> {
        let now = now_millis();
        let role = match &request.role {
            Some(name) => Some(load_role_locked(conn, name)?),
            None => None,
        };
        let mut parent_info = None;
        if let Some(parent) = parent {
            let info = token_info_locked(conn, parent.accessor)?;
            if info.num_uses_remaining.is_some() {
                return Err(VaultError::Denied(
                    "a use-limited token cannot create child tokens".into(),
                )
                .into());
            }
            let depth = live_depth_locked(conn, info.parent_accessor.clone(), now)?
                .ok_or_else(|| VaultError::Conflict("the parent token is not live".into()))?;
            if depth >= MAX_CHILD_DEPTH {
                return Err(VaultError::Invalid("the token chain is too deep".into()).into());
            }
            parent_info = Some(info);
        }
        let role_orphan = role.as_ref().is_some_and(|role| role.orphan);
        let orphan = match (parent.is_some(), request.orphan) {
            // Only a role an administrator configured can detach a child.
            (true, Some(true)) if !role_orphan => {
                return Err(VaultError::Denied(
                    "orphan child tokens require a token role with `orphan: true`".into(),
                )
                .into())
            }
            (true, _) => role_orphan,
            (false, _) => true,
        };
        let policies = child_policies(base_policies, request.policies, role.as_ref())?;
        let role_config = role
            .as_ref()
            .map(|role| role.token.clone())
            .unwrap_or_default();
        let config = TokenConfig {
            max_ttl_secs: role_config.max_ttl_secs,
            explicit_max_ttl_secs: min_opt(
                role_config.explicit_max_ttl_secs,
                request.explicit_max_ttl_secs,
            ),
            period_secs: role_config.period_secs.or(request.period_secs),
            num_uses: min_opt(role_config.num_uses, request.num_uses.filter(|n| *n > 0)),
            bound_cidrs: request.bound_cidrs.clone().unwrap_or_default(),
            renewable: match (role_config.renewable, request.renewable) {
                (Some(false), _) | (_, Some(false)) => Some(false),
                _ => None,
            },
        }
        .normalize()?;
        if !cidrs_within(&config.bound_cidrs, &role_config.bound_cidrs) {
            return Err(VaultError::Denied("boundCidrs must lie inside the role's".into()).into());
        }
        let inherited_cidrs = parent_info
            .as_ref()
            .map(|info| info.bound_cidrs.clone())
            .unwrap_or_default();
        if !cidrs_within(&config.bound_cidrs, &inherited_cidrs) {
            return Err(
                VaultError::Denied("boundCidrs must lie inside the parent token's".into()).into(),
            );
        }
        let bound_cidrs = [
            &config.bound_cidrs,
            &role_config.bound_cidrs,
            &inherited_cidrs,
        ]
        .into_iter()
        .find(|list| !list.is_empty())
        .cloned()
        .unwrap_or_default();
        let ttl_secs = config
            .period_secs
            .or(request.ttl_secs)
            .or(role.as_ref().and_then(|role| role.ttl_secs))
            .unwrap_or(identity.token_ttl_secs)
            .clamp(MIN_CHILD_TTL_SECS, MAX_TOKEN_TTL_SECS);
        let mut max_expires_at = config.max_expires_at(now, ttl_secs);
        let mut expires_cap = None;
        if let Some(info) = &parent_info {
            // Every child (orphan or not) starts inside its parent's lifetime.
            expires_cap = Some(info.expires_at);
            if !orphan {
                max_expires_at = min_opt(max_expires_at, info.max_expires_at);
            }
        }
        let new = NewToken {
            identity_id: identity.id.clone(),
            policies,
            scoped: true,
            ttl_secs,
            max_expires_at,
            expires_cap,
            period_secs: config.period_secs,
            num_uses: config.num_uses,
            bound_cidrs,
            parent_accessor: if orphan {
                None
            } else {
                parent.map(|parent| parent.accessor.to_owned())
            },
            orphan,
            role: role.as_ref().map(|role| role.name.clone()),
            renewable: config.renewable.unwrap_or(true),
        };
        let issued = insert_token_locked(conn, &new)?;
        let permitted = self.audit_locked(
            conn,
            &AuditEntry::new(actor, "token.create", "ok").details(json!({
                "accessor": issued.accessor,
                "identity": identity.id,
                "parentAccessor": parent.map(|parent| parent.accessor),
                "orphan": orphan,
                "role": new.role,
                "policies": new.policies,
                "numUses": new.num_uses,
            })),
        );
        if !permitted {
            withhold_token_locked(conn, &issued.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(issued)
    }

    /// Mint a child of the presented token.
    pub async fn token_create_child(
        &self,
        parent_accessor: &str,
        parent_policies: &[String],
        identity_id: &str,
        request: TokenRequest,
        actor: &AuditActor,
    ) -> Result<IssuedToken> {
        let conn = self.conn.lock().await;
        let identity = super::machine::identity_locked(&conn, identity_id)?;
        if identity.disabled {
            return Err(VaultError::Denied("identity is disabled".into()).into());
        }
        if let Some(role) = &request.role {
            // A role can detach a child (orphan) or make it periodic, so a
            // machine may only use one its own policies grant `use` on.
            let key = format!("sys/token-roles/{role}");
            let policies: Vec<_> = super::policy::list_policies(&conn)?
                .into_iter()
                .filter(|policy| parent_policies.contains(&policy.name))
                .collect();
            let caps =
                super::policy::evaluate(&super::policy::CapabilitySet::new(), &policies, &key);
            if !caps.contains(&super::policy::Capability::Use) {
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "token.create", "denied")
                        .details(json!({ "parentAccessor": parent_accessor, "role": role })),
                );
                return Err(VaultError::Denied(format!(
                    "using token role `{role}` requires `use` on {key}"
                ))
                .into());
            }
        }
        let parent = ParentToken {
            accessor: parent_accessor,
            policies: parent_policies,
        };
        self.token_create_locked(
            &conn,
            &identity,
            parent.policies,
            Some(&parent),
            request,
            actor,
        )
    }

    /// An administrator mints a root (orphan) token for an identity.
    pub async fn token_create_for_identity(
        &self,
        identity: &str,
        request: TokenRequest,
        actor: &AuditActor,
    ) -> Result<IssuedToken> {
        let conn = self.conn.lock().await;
        let identity = super::machine::identity_locked(&conn, identity)?;
        if identity.disabled {
            return Err(VaultError::Denied("identity is disabled".into()).into());
        }
        let base =
            super::machine::effective_machine_policies(&conn, &identity.id, &identity.policies)?;
        self.token_create_locked(&conn, &identity, &base, None, request, actor)
    }

    /// Revoke a token. Without `orphan_children`, its descendants go with it;
    /// with it, direct children become orphans and survive. Every revoked
    /// token's cubbyhole is destroyed and its live leases are revoked at the
    /// provider (a provider failure leaves the lease for the reaper).
    pub async fn token_revoke_tree(
        &self,
        accessor: &str,
        orphan_children: bool,
        actor: &AuditActor,
    ) -> Result<RevokeReport> {
        let (accessors, leases) = {
            let conn = self.conn.lock().await;
            let tx = conn.unchecked_transaction()?;
            let accessors: Vec<String> = if orphan_children {
                tx.execute(
                    "UPDATE vault_tokens SET parent_accessor = NULL, orphan = 1
                     WHERE parent_accessor = ?1",
                    params![accessor],
                )?;
                vec![accessor.to_owned()]
            } else {
                let mut stmt = tx.prepare(
                    "WITH RECURSIVE tree(accessor) AS (
                         SELECT ?1
                         UNION SELECT t.accessor FROM vault_tokens t
                               JOIN tree ON t.parent_accessor = tree.accessor
                     )
                     SELECT accessor FROM tree",
                )?;
                let rows = stmt.query_map(params![accessor], |row| row.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let now = now_millis();
            let mut leases = Vec::new();
            for each in &accessors {
                tx.execute(
                    "UPDATE vault_tokens SET revoked_at = COALESCE(revoked_at, ?1)
                     WHERE accessor = ?2",
                    params![now, each],
                )?;
                super::wrapping::cubbyhole_destroy_locked(&tx, each)?;
                let mut stmt = tx.prepare(
                    "SELECT id FROM vault_leases WHERE token_accessor = ?1 AND revoked_at IS NULL",
                )?;
                let rows = stmt.query_map(params![each], |row| row.get::<_, String>(0))?;
                for lease in rows {
                    leases.push(lease?);
                }
            }
            self.audit_locked(
                &tx,
                &AuditEntry::new(actor, "token.revoke", "ok").details(json!({
                    "accessor": accessor,
                    "descendants": accessors.len().saturating_sub(1),
                    "orphanChildren": orphan_children,
                    "leases": leases.len(),
                })),
            );
            tx.commit()?;
            self.flush_audit(&conn);
            (accessors, leases)
        };
        let mut report = RevokeReport {
            tokens: accessors.len(),
            ..RevokeReport::default()
        };
        for lease in leases {
            match self.dynamic_revoke(&lease, actor).await {
                Ok(_) => report.leases_revoked += 1,
                Err(error) => {
                    report.leases_failed += 1;
                    tracing::warn!("revoking lease {lease} with its token: {error:#}");
                }
            }
        }
        Ok(report)
    }

    /// Set an identity's token settings. Applies to tokens issued afterwards.
    pub async fn machine_set_token_config(
        &self,
        id_or_name: &str,
        config: TokenConfig,
        actor: &AuditActor,
    ) -> Result<MachineIdentity> {
        let config = config.normalize()?;
        let conn = self.conn.lock().await;
        let identity = super::machine::identity_locked(&conn, id_or_name)?;
        conn.execute(
            "UPDATE vault_machine_identities SET token_config = ?1 WHERE id = ?2",
            params![serde_json::to_string(&config)?, identity.id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.token_config", "ok")
                .details(json!({ "identity": identity.id, "config": config })),
        );
        super::machine::identity_locked(&conn, &identity.id)
    }

    /// Issue an AppRole secret id with CIDR restrictions.
    pub async fn machine_issue_secret_id_with(
        &self,
        id_or_name: &str,
        options: SecretIdOptions,
        actor: &AuditActor,
    ) -> Result<(String, super::machine::SecretIdInfo)> {
        let cidr_list = normalize_cidrs(&options.cidr_list)?;
        let token_cidrs = normalize_cidrs(&options.token_bound_cidrs)?;
        let identity = self.machine_get(id_or_name).await?;
        if !cidrs_within(&token_cidrs, &identity.token_config.bound_cidrs) {
            return Err(VaultError::Invalid(
                "tokenBoundCidrs must lie inside the identity's boundCidrs".into(),
            )
            .into());
        }
        let (secret, info) = self
            .machine_issue_secret_id(&identity.id, options.ttl_secs, options.uses, actor)
            .await?;
        if cidr_list.is_empty() && token_cidrs.is_empty() {
            return Ok((secret, info));
        }
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE vault_approle_secret_ids SET cidr_list = ?1, token_bound_cidrs = ?2
             WHERE accessor = ?3",
            params![
                list_json(&cidr_list)?,
                list_json(&token_cidrs)?,
                info.accessor
            ],
        );
        if let Err(error) = updated {
            // Never leave a secret id behind without the bounds it was issued with.
            let _ = conn.execute(
                "DELETE FROM vault_approle_secret_ids WHERE accessor = ?1",
                params![info.accessor],
            );
            return Err(error.into());
        }
        Ok((secret, info))
    }

    /// Create or replace a token role.
    pub async fn token_role_put(&self, role: TokenRole, actor: &AuditActor) -> Result<TokenRole> {
        if !super::transit::is_valid_key_name(&role.name) {
            return Err(VaultError::Invalid("invalid token role name".into()).into());
        }
        check_range(
            "ttlSecs",
            role.ttl_secs,
            MIN_CHILD_TTL_SECS,
            MAX_TOKEN_TTL_SECS,
        )?;
        let token = role.token.clone().normalize()?;
        let stored = TokenRole {
            token,
            created_at: 0,
            updated_at: 0,
            ..role
        };
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_token_roles (name, config, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(name) DO UPDATE SET config = excluded.config,
                                              updated_at = excluded.updated_at",
            params![stored.name, serde_json::to_string(&stored)?, now],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "token.role.put", "ok").details(json!({ "role": stored.name })),
        );
        load_role_locked(&conn, &stored.name)
    }

    /// One token role.
    pub async fn token_role_get(&self, name: &str) -> Result<TokenRole> {
        let conn = self.conn.lock().await;
        load_role_locked(&conn, name)
    }

    /// Every token role.
    pub async fn token_role_list(&self) -> Result<Vec<TokenRole>> {
        let conn = self.conn.lock().await;
        let names: Vec<String> = {
            let mut stmt = conn.prepare("SELECT name FROM vault_token_roles ORDER BY name")?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        names
            .iter()
            .map(|name| load_role_locked(&conn, name))
            .collect()
    }

    /// Delete a token role (tokens minted from it keep their settings).
    pub async fn token_role_delete(&self, name: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let deleted = conn.execute(
            "DELETE FROM vault_token_roles WHERE name = ?1",
            params![name],
        )? > 0;
        self.audit_locked(
            &conn,
            &AuditEntry::new(
                actor,
                "token.role.delete",
                if deleted { "ok" } else { "not_found" },
            )
            .details(json!({ "role": name })),
        );
        Ok(deleted)
    }

    /// Prune wrapping tokens, tombstones, and cubbyholes of dead tokens.
    pub async fn token_lifecycle_prune(&self) -> Result<usize> {
        let conn = self.conn.lock().await;
        super::wrapping::wrapping_prune_locked(&conn, now_millis())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::machine::AuthMethod;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    async fn approle(store: &PluginSecretStore, name: &str, policies: &[&str]) -> (String, String) {
        let identity = store
            .machine_create(
                name,
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                policies.iter().map(|p| (*p).to_owned()).collect(),
                Some(600),
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let AuthMethod::AppRole { role_id } = identity.auth else {
            panic!("approle")
        };
        (identity.id, role_id)
    }

    async fn login(store: &PluginSecretStore, name: &str, role_id: &str) -> IssuedToken {
        let (secret, _) = store
            .machine_issue_secret_id(name, None, None, &AuditActor::system())
            .await
            .unwrap();
        store.approle_login(role_id, &secret).await.unwrap()
    }

    #[test]
    fn cidrs_parse_contain_and_cover() {
        let block = Cidr::parse("10.1.2.3/16").unwrap();
        assert_eq!(block.to_string(), "10.1.0.0/16");
        assert!(block.contains(ip("10.1.200.1")));
        assert!(!block.contains(ip("10.2.0.1")));
        assert!(block.contains(ip("::ffff:10.1.0.9")));
        assert!(block.covers(&Cidr::parse("10.1.4.0/24").unwrap()));
        assert!(!block.covers(&Cidr::parse("10.0.0.0/8").unwrap()));
        let v6 = Cidr::parse("fd00::/8").unwrap();
        assert!(v6.contains(ip("fd12::1")) && !v6.contains(ip("10.1.0.1")));
        assert_eq!(
            Cidr::parse("192.168.1.7").unwrap().to_string(),
            "192.168.1.7/32"
        );
        for bad in ["", "10.0.0.0/33", "nope/8", "fd00::/129"] {
            assert!(Cidr::parse(bad).is_none(), "{bad}");
        }
        assert!(ip_allowed(&[], None));
        assert!(!ip_allowed(&["10.0.0.0/8".into()], None));
        assert!(ip_allowed(&["10.0.0.0/8".into()], Some(ip("10.9.9.9"))));
        assert!(normalize_cidrs(&["bad".into()]).is_err());
    }

    #[test]
    fn forwarded_for_is_trusted_only_from_configured_proxies() {
        let proxies = vec![Cidr::parse("10.0.0.0/8").unwrap()];
        let peer = Some(ip("203.0.113.5"));
        // An untrusted peer cannot spoof its address.
        assert_eq!(
            resolve_client_ip(peer, Some("10.1.1.1"), &proxies, false),
            peer
        );
        // A trusted proxy's right-most untrusted hop wins.
        assert_eq!(
            resolve_client_ip(
                Some(ip("10.0.0.2")),
                Some("198.51.100.1, 203.0.113.9, 10.0.0.3"),
                &proxies,
                false
            ),
            Some(ip("203.0.113.9"))
        );
        assert_eq!(
            resolve_client_ip(Some(ip("10.0.0.2")), Some("garbage"), &proxies, false),
            None
        );
        // Tunneled loopback is a remote client of unknown address.
        assert_eq!(
            resolve_client_ip(Some(ip("127.0.0.1")), None, &[], true),
            None
        );
        assert_eq!(
            resolve_client_ip(Some(ip("127.0.0.1")), None, &[], false),
            Some(ip("127.0.0.1"))
        );
    }

    #[tokio::test]
    async fn use_limited_tokens_are_revoked_at_zero() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (_, role_id) = approle(&store, "limited", &["p"]).await;
        store
            .machine_set_token_config(
                "limited",
                TokenConfig {
                    num_uses: Some(2),
                    ..TokenConfig::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let token = login(&store, "limited", &role_id).await;
        assert!(store.token_lookup(&token.token).await.unwrap().is_some());
        assert!(store.token_lookup(&token.token).await.unwrap().is_some());
        assert!(store.token_lookup(&token.token).await.unwrap().is_none());
        let info = store.token_info(&token.accessor).await.unwrap();
        assert_eq!(info.num_uses_remaining, Some(0));
        assert!(info.revoked_at.is_some());
    }

    #[tokio::test]
    async fn cidr_bound_tokens_need_a_matching_client() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (_, role_id) = approle(&store, "bound", &[]).await;
        store
            .machine_set_token_config(
                "bound",
                TokenConfig {
                    bound_cidrs: vec!["10.0.0.0/8".into()],
                    ..TokenConfig::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let (secret, _) = store
            .machine_issue_secret_id("bound", None, None, &AuditActor::system())
            .await
            .unwrap();
        // Login from outside the bound CIDRs is refused.
        let outside = RequestContext::new(Some(ip("192.0.2.1")));
        assert!(
            with_request_context(outside, store.approle_login(&role_id, &secret))
                .await
                .is_err()
        );
        let inside = RequestContext::new(Some(ip("10.2.3.4")));
        let token = with_request_context(inside.clone(), store.approle_login(&role_id, &secret))
            .await
            .unwrap();
        assert!(
            with_request_context(inside, store.token_lookup(&token.token))
                .await
                .unwrap()
                .is_some()
        );
        let elsewhere = RequestContext::new(Some(ip("192.0.2.1")));
        assert!(
            with_request_context(elsewhere, store.token_lookup(&token.token))
                .await
                .unwrap()
                .is_none()
        );
        // Outside any request the address is unknown: fail closed.
        assert!(store.token_lookup(&token.token).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn secret_id_cidrs_gate_login_and_bind_the_token() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (_, role_id) = approle(&store, "sid", &[]).await;
        let (secret, _) = store
            .machine_issue_secret_id_with(
                "sid",
                SecretIdOptions {
                    cidr_list: vec!["198.51.100.0/24".into()],
                    token_bound_cidrs: vec!["198.51.100.7/32".into()],
                    ..SecretIdOptions::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let wrong = RequestContext::new(Some(ip("203.0.113.1")));
        assert!(
            with_request_context(wrong, store.approle_login(&role_id, &secret))
                .await
                .is_err()
        );
        let right = RequestContext::new(Some(ip("198.51.100.7")));
        let token = with_request_context(right, store.approle_login(&role_id, &secret))
            .await
            .unwrap();
        let info = store.token_info(&token.accessor).await.unwrap();
        assert_eq!(info.bound_cidrs, vec!["198.51.100.7/32".to_owned()]);
    }

    #[tokio::test]
    async fn narrowing_identity_cidrs_overrides_older_secret_ids() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (_, role_id) = approle(&store, "narrowed", &[]).await;
        let (secret, _) = store
            .machine_issue_secret_id_with(
                "narrowed",
                SecretIdOptions {
                    token_bound_cidrs: vec!["198.51.100.0/24".into()],
                    ..SecretIdOptions::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        store
            .machine_set_token_config(
                "narrowed",
                TokenConfig {
                    bound_cidrs: vec!["203.0.113.0/24".into()],
                    ..TokenConfig::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        // Inside the old override but outside the identity's new range.
        let old_range = RequestContext::new(Some(ip("198.51.100.7")));
        assert!(
            with_request_context(old_range, store.approle_login(&role_id, &secret))
                .await
                .is_err()
        );
        // Inside the new range, but the stored override is no longer inside it.
        let new_range = RequestContext::new(Some(ip("203.0.113.9")));
        assert!(
            with_request_context(new_range, store.approle_login(&role_id, &secret))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn renew_extends_up_to_the_max_ttl() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (_, role_id) = approle(&store, "renew", &[]).await;
        store
            .machine_set_token_config(
                "renew",
                TokenConfig {
                    max_ttl_secs: Some(900),
                    ..TokenConfig::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let token = login(&store, "renew", &role_id).await;
        let info = store.token_info(&token.accessor).await.unwrap();
        let max = info.max_expires_at.unwrap();
        assert!(max - info.created_at <= 900_000);
        let renewed = store
            .token_renew(&token.accessor, Some(10_000), &AuditActor::system())
            .await
            .unwrap();
        assert_eq!(renewed.expires_at, max);
        store
            .token_revoke(&token.accessor, &AuditActor::system())
            .await
            .unwrap();
        assert!(store
            .token_renew(&token.accessor, None, &AuditActor::system())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn periodic_tokens_renew_by_one_period_without_a_max() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (_, role_id) = approle(&store, "periodic", &[]).await;
        store
            .machine_set_token_config(
                "periodic",
                TokenConfig {
                    period_secs: Some(120),
                    renewable: Some(true),
                    ..TokenConfig::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let token = login(&store, "periodic", &role_id).await;
        let info = store.token_info(&token.accessor).await.unwrap();
        assert_eq!(info.period_secs, Some(120));
        assert_eq!(info.max_expires_at, None);
        assert!(info.expires_at - info.created_at <= 120_000);
        let renewed = store
            .token_renew(&token.accessor, Some(99_999), &AuditActor::system())
            .await
            .unwrap();
        assert!(renewed.expires_at - now_millis() <= 120_000);
    }

    #[tokio::test]
    async fn non_renewable_tokens_refuse_renewal() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (_, role_id) = approle(&store, "fixed", &[]).await;
        store
            .machine_set_token_config(
                "fixed",
                TokenConfig {
                    renewable: Some(false),
                    ..TokenConfig::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let token = login(&store, "fixed", &role_id).await;
        assert!(store
            .token_renew(&token.accessor, None, &AuditActor::system())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn broker_resolution_keeps_a_scoped_tokens_narrowed_policies() {
        use crate::vault::machine::{principal_by_accessor_locked, principal_policies_locked};
        use crate::vault::policy::{bind, put_policy, Capability, Policy, PolicyRule};
        let store = PluginSecretStore::in_memory().unwrap();
        let (identity_id, role_id) = approle(&store, "broker", &["read", "write"]).await;
        {
            let conn = store.conn.lock().await;
            for name in ["read", "write", "bound"] {
                put_policy(
                    &conn,
                    &Policy {
                        name: name.into(),
                        description: String::new(),
                        rules: vec![PolicyRule {
                            path: format!("{name}/**"),
                            capabilities: vec![Capability::Use],
                            deny: false,
                            ..Default::default()
                        }],
                    },
                )
                .unwrap();
            }
            bind(
                &conn,
                "bound",
                &format!("machine:{identity_id}"),
                None,
                None,
            )
            .unwrap();
        }
        let parent = login(&store, "broker", &role_id).await;
        let child = store
            .token_create_child(
                &parent.accessor,
                &parent.policies,
                &identity_id,
                TokenRequest {
                    policies: Some(vec!["read".into()]),
                    ..TokenRequest::default()
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let conn = store.conn.lock().await;
        let principal = principal_by_accessor_locked(&conn, &child.accessor)
            .unwrap()
            .unwrap();
        assert_eq!(principal.policies, vec!["read".to_owned()]);
        let documents: Vec<String> = principal_policies_locked(&conn, &principal)
            .unwrap()
            .into_iter()
            .map(|policy| policy.name)
            .collect();
        assert_eq!(documents, vec!["read".to_owned()], "no binding re-added");
        // The parent keeps everything, its binding included.
        let principal = principal_by_accessor_locked(&conn, &parent.accessor)
            .unwrap()
            .unwrap();
        let mut documents: Vec<String> = principal_policies_locked(&conn, &principal)
            .unwrap()
            .into_iter()
            .map(|policy| policy.name)
            .collect();
        documents.sort();
        assert_eq!(documents, ["bound", "read", "write"]);
        // Revoking the parent ends the child's broker authority too.
        conn.execute(
            "UPDATE vault_tokens SET revoked_at = ?1 WHERE accessor = ?2",
            params![now_millis(), parent.accessor],
        )
        .unwrap();
        assert!(principal_by_accessor_locked(&conn, &child.accessor)
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn child_tokens_narrow_policies_and_die_with_the_parent() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (identity_id, role_id) = approle(&store, "orch", &["read", "write"]).await;
        let parent = login(&store, "orch", &role_id).await;
        let actor = AuditActor::system();
        // Escalation beyond the parent's policies is refused.
        assert!(store
            .token_create_child(
                &parent.accessor,
                &parent.policies,
                &identity_id,
                TokenRequest {
                    policies: Some(vec!["admin".into()]),
                    ..TokenRequest::default()
                },
                &actor,
            )
            .await
            .is_err());
        let child = store
            .token_create_child(
                &parent.accessor,
                &parent.policies,
                &identity_id,
                TokenRequest {
                    policies: Some(vec!["read".into()]),
                    ttl_secs: Some(999_999),
                    num_uses: Some(1),
                    ..TokenRequest::default()
                },
                &actor,
            )
            .await
            .unwrap();
        assert!(child.expires_at <= parent.expires_at);
        let principal = store.token_lookup(&child.token).await.unwrap().unwrap();
        assert_eq!(principal.policies, vec!["read".to_owned()]);
        // A use-limited token cannot have children of its own.
        assert!(store
            .token_create_child(
                &child.accessor,
                &principal.policies,
                &identity_id,
                TokenRequest::default(),
                &actor,
            )
            .await
            .is_err());
        // The single use is spent.
        assert!(store.token_lookup(&child.token).await.unwrap().is_none());
        let second = store
            .token_create_child(
                &parent.accessor,
                &parent.policies,
                &identity_id,
                TokenRequest::default(),
                &actor,
            )
            .await
            .unwrap();
        let grandchild = store
            .token_create_child(
                &second.accessor,
                &second.policies,
                &identity_id,
                TokenRequest::default(),
                &actor,
            )
            .await
            .unwrap();
        let report = store
            .token_revoke_tree(&parent.accessor, false, &actor)
            .await
            .unwrap();
        assert_eq!(report.tokens, 4);
        assert!(store.token_lookup(&second.token).await.unwrap().is_none());
        assert!(store
            .token_lookup(&grandchild.token)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn orphans_need_a_role_and_survive_the_parent() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (identity_id, role_id) = approle(&store, "orph", &["read"]).await;
        let parent = login(&store, "orph", &role_id).await;
        let actor = AuditActor::system();
        let request = |role: Option<&str>| TokenRequest {
            role: role.map(str::to_owned),
            orphan: Some(true),
            ..TokenRequest::default()
        };
        assert!(store
            .token_create_child(
                &parent.accessor,
                &parent.policies,
                &identity_id,
                request(None),
                &actor
            )
            .await
            .is_err());
        store
            .token_role_put(
                TokenRole {
                    name: "detached".into(),
                    orphan: true,
                    allowed_policies: vec!["read".into()],
                    ..TokenRole::default()
                },
                &actor,
            )
            .await
            .unwrap();
        // Without `use` on the role, a machine cannot mint from it.
        assert!(store
            .token_create_child(
                &parent.accessor,
                &parent.policies,
                &identity_id,
                request(Some("detached")),
                &actor,
            )
            .await
            .is_err());
        {
            let conn = store.conn.lock().await;
            crate::vault::policy::put_policy(
                &conn,
                &crate::vault::policy::Policy {
                    name: "read".into(),
                    description: String::new(),
                    rules: vec![crate::vault::policy::PolicyRule {
                        path: "sys/token-roles/detached".into(),
                        capabilities: vec![crate::vault::policy::Capability::Use],
                        deny: false,
                        ..Default::default()
                    }],
                },
            )
            .unwrap();
        }
        let orphan = store
            .token_create_child(
                &parent.accessor,
                &parent.policies,
                &identity_id,
                request(Some("detached")),
                &actor,
            )
            .await
            .unwrap();
        store.token_revoke(&parent.accessor, &actor).await.unwrap();
        let info = store.token_info(&orphan.accessor).await.unwrap();
        assert!(info.orphan && info.parent_accessor.is_none());
        assert!(store.token_lookup(&orphan.token).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn revoke_orphan_keeps_children_alive() {
        let store = PluginSecretStore::in_memory().unwrap();
        let (identity_id, role_id) = approle(&store, "keep", &["read"]).await;
        let parent = login(&store, "keep", &role_id).await;
        let actor = AuditActor::system();
        let child = store
            .token_create_child(
                &parent.accessor,
                &parent.policies,
                &identity_id,
                TokenRequest::default(),
                &actor,
            )
            .await
            .unwrap();
        let report = store
            .token_revoke_tree(&parent.accessor, true, &actor)
            .await
            .unwrap();
        assert_eq!(report.tokens, 1);
        assert!(store.token_lookup(&child.token).await.unwrap().is_some());
        assert!(store.token_info(&child.accessor).await.unwrap().orphan);
    }

    #[tokio::test]
    async fn token_revocation_revokes_attached_leases() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let (_, role_id) = approle(&store, "leasy", &[]).await;
        let token = login(&store, "leasy", &role_id).await;
        store
            .dynamic_put_role(
                "rnd",
                &crate::vault::dynamic::ProviderConfig::Random {
                    length: 16,
                    charset: crate::plugin_secrets::kv::Charset::Hex,
                    field: None,
                },
                Some(600),
                Some(600),
                &actor,
            )
            .await
            .unwrap();
        let context = RequestContext::new(None);
        let credential = with_request_context(context.clone(), async {
            store.token_lookup(&token.token).await.unwrap().unwrap();
            store
                .dynamic_issue("rnd", None, Some("machine:x"), &actor)
                .await
                .unwrap()
        })
        .await;
        assert_eq!(context.token_accessor(), Some(token.accessor.clone()));
        let report = store
            .token_revoke_tree(&token.accessor, false, &actor)
            .await
            .unwrap();
        assert_eq!(report.leases_revoked, 1);
        assert!(store
            .lease_get(&credential.lease.id)
            .await
            .unwrap()
            .revoked_at
            .is_some());
    }

    #[tokio::test]
    async fn role_policy_lists_constrain_admin_tokens() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        approle(&store, "svc", &["a", "b"]).await;
        store
            .token_role_put(
                TokenRole {
                    name: "narrow".into(),
                    disallowed_policies: vec!["b".into()],
                    token: TokenConfig {
                        num_uses: Some(3),
                        ..TokenConfig::default()
                    },
                    ..TokenRole::default()
                },
                &actor,
            )
            .await
            .unwrap();
        assert!(store
            .token_create_for_identity(
                "svc",
                TokenRequest {
                    role: Some("narrow".into()),
                    policies: Some(vec!["b".into()]),
                    ..TokenRequest::default()
                },
                &actor,
            )
            .await
            .is_err());
        let token = store
            .token_create_for_identity(
                "svc",
                TokenRequest {
                    role: Some("narrow".into()),
                    policies: Some(vec!["a".into()]),
                    num_uses: Some(10),
                    ..TokenRequest::default()
                },
                &actor,
            )
            .await
            .unwrap();
        let info = store.token_info(&token.accessor).await.unwrap();
        assert_eq!(info.num_uses_remaining, Some(3));
        assert!(info.orphan);
        assert_eq!(store.token_role_list().await.unwrap().len(), 1);
        assert!(store.token_role_delete("narrow", &actor).await.unwrap());
        assert!(store.token_role_get("narrow").await.is_err());
    }

    #[test]
    fn token_configs_validate_ranges() {
        assert!(TokenConfig {
            period_secs: Some(5),
            ..TokenConfig::default()
        }
        .normalize()
        .is_err());
        let config = TokenConfig {
            num_uses: Some(0),
            bound_cidrs: vec!["10.0.0.1/8".into()],
            ..TokenConfig::default()
        }
        .normalize()
        .unwrap();
        assert_eq!(config.num_uses, None);
        assert_eq!(config.bound_cidrs, vec!["10.0.0.0/8".to_owned()]);
    }
}
