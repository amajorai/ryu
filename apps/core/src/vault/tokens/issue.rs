//! Issuing token rows, token lookup and policy narrowing.

use std::collections::BTreeSet;

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use crate::vault::machine::{IssuedToken, MachineIdentity};
use crate::vault::{now_millis, random_token, sha256_hex, VaultError};

use super::*;
use super::{config::*, schema::*};

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

pub(super) const INFO_COLUMNS: &str =
    "accessor, identity_id, policies, parent_accessor, orphan, role,
     created_at, expires_at, max_expires_at, period_secs, num_uses, bound_cidrs, renewable,
     last_used_at, revoked_at";

pub(super) fn info_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TokenInfo> {
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

pub(super) fn is_live(info: &TokenInfo, now: i64) -> bool {
    info.revoked_at.is_none() && info.expires_at > now
}

/// Walk the parent chain; `None` when an ancestor is gone, revoked, or
/// expired, otherwise the depth (0 for a root token).
pub(super) fn live_depth_locked(
    conn: &Connection,
    parent: Option<String>,
    now: i64,
) -> Result<Option<usize>> {
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

pub(super) fn load_role_locked(conn: &Connection, name: &str) -> Result<TokenRole> {
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

pub(super) fn min_opt(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Resolve the policies of a new token: a subset of `base`, inside the
/// role's allow list and outside its deny list.
pub(super) fn child_policies(
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
pub(super) fn narrow_scoped_locked(
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
