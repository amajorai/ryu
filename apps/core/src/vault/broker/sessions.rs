//! Broker sessions: short-lived `rvb_` tokens that authenticate an agent to
//! the proxy.
//!
//! A session is bound to one environment and an explicit list of services, is
//! minted by a human (node bearer) or a machine token holding `use` on each
//! `sys/broker/<service>`, and lives at most [`MAX_TTL_SECS`] unless a human
//! minted it with [`TTL_NEVER`] (an admin choice, see the route). A session a
//! machine token minted also ends when that token is revoked or expires or
//! its identity is disabled. Ended sessions stay as history ([`history`]) up
//! to [`MAX_HISTORY_ROWS`]. Only the SHA-256 of the token is stored. A
//! session grants brokering only: it is not a vault token and no route that
//! returns plaintext accepts it.

use std::net::IpAddr;

use anyhow::{Context, Result};
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::vault::{now_millis, random_token, sha256_hex, VaultError};

/// Token prefix.
pub const TOKEN_PREFIX: &str = "rvb_";
pub const DEFAULT_TTL_SECS: i64 = 3600;
pub const MIN_TTL_SECS: i64 = 60;
pub const MAX_TTL_SECS: i64 = 24 * 3600;
/// `ttl_secs` of a session that never expires (human minters only).
pub const TTL_NEVER: i64 = i64::MAX;
/// The `expires_at` stored for a session that never expires: the last
/// millisecond of year 9999, which every client can still render as a date.
pub const NEVER_EXPIRES_AT: i64 = 253_402_300_799_999;
/// Ended (revoked or expired) sessions kept as history; older ones go first.
pub const MAX_HISTORY_ROWS: i64 = 10_000;
/// Live sessions per minting subject.
pub const MAX_ACTIVE_PER_SUBJECT: i64 = 10;
/// Services per session.
pub const MAX_SERVICES: usize = 32;
const MAX_LABEL_LEN: usize = 128;

/// A stored session (never the token).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerSession {
    pub id: String,
    pub environment: String,
    pub services: Vec<String>,
    pub label: String,
    /// `user:<id>`, `operator`, or `machine:<id>`.
    pub minted_by: String,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<i64>,
    /// Accessor of the machine token that minted the session. The session
    /// is live only while that token is (see [`lookup`]), and credential
    /// resolution applies that machine's policies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minted_token: Option<String>,
    /// The human minter's policy subjects and manager standing, captured at
    /// mint. Card substitution evaluates the minter's current policies for
    /// these subjects, so a human-minted session uses only cards its minter
    /// holds `use` on. `None` for machine-minted sessions (their token's
    /// policies apply) and for sessions minted before it was recorded (no
    /// card use).
    #[serde(default, skip_serializing)]
    pub minter_scope: Option<MinterScope>,
}

/// Who minted a human session, for evaluating the minter's capabilities
/// later (see [`BrokerSession::minter_scope`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinterScope {
    /// Policy-binding subjects (`user:<id>`, `role:<role>`, `team:<id>`);
    /// empty for the unbound local operator.
    pub subjects: Vec<String>,
    /// A configuration manager (or the unbound local operator), whose
    /// baseline is every capability.
    pub manager: bool,
}

impl BrokerSession {
    pub fn allows(&self, service: &str) -> bool {
        self.services.iter().any(|s| s == service)
    }

    /// The user whose policies apply at credential resolution, if a user
    /// minted the session.
    pub fn user_id(&self) -> Option<&str> {
        self.minted_by.strip_prefix("user:")
    }

    /// Audit actor for brokered use.
    pub fn actor(&self) -> crate::vault::audit::AuditActor {
        crate::vault::audit::AuditActor::new("broker_session", Some(&self.id))
    }
}

/// What to mint.
#[derive(Debug, Clone)]
pub struct MintRequest {
    pub environment: String,
    pub services: Vec<String>,
    pub label: String,
    pub ttl_secs: Option<i64>,
    pub minted_by: String,
    /// The minter's own expiry (a machine token), which caps the session.
    pub not_after: Option<i64>,
    /// Accessor of the minting machine token, if a machine minted it.
    pub minted_token: Option<String>,
    /// The human minter's subjects (human-minted sessions only).
    pub minter_scope: Option<MinterScope>,
}

/// Create the sessions table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_broker_sessions (
             id          TEXT PRIMARY KEY,
             token_hash  TEXT NOT NULL UNIQUE,
             environment TEXT NOT NULL,
             services    TEXT NOT NULL,
             label       TEXT NOT NULL DEFAULT '',
             minted_by   TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             expires_at  INTEGER NOT NULL,
             revoked_at  INTEGER,
             minted_token TEXT,
             minter_scope TEXT
         );
         CREATE INDEX IF NOT EXISTS vault_broker_sessions_minted_by
             ON vault_broker_sessions (minted_by);",
    )
    .context("initializing broker sessions schema")?;
    let has_minted_token = conn
        .prepare(
            "SELECT 1 FROM pragma_table_info('vault_broker_sessions') WHERE name = 'minted_token'",
        )?
        .exists([])?;
    if !has_minted_token {
        conn.execute_batch("ALTER TABLE vault_broker_sessions ADD COLUMN minted_token TEXT;")
            .context("adding broker session minted_token")?;
    }
    let has_minter_scope = conn
        .prepare(
            "SELECT 1 FROM pragma_table_info('vault_broker_sessions') WHERE name = 'minter_scope'",
        )?
        .exists([])?;
    if !has_minter_scope {
        conn.execute_batch("ALTER TABLE vault_broker_sessions ADD COLUMN minter_scope TEXT;")
            .context("adding broker session minter_scope")?;
    }
    Ok(())
}

fn invalid(message: &str) -> anyhow::Error {
    VaultError::Invalid(message.to_owned()).into()
}

/// Mint a session. The caller has already checked `use` on every service and
/// that the services exist in the environment. Returns the token once.
pub fn mint(conn: &Connection, request: MintRequest) -> Result<(String, BrokerSession)> {
    let ttl = request.ttl_secs.unwrap_or(DEFAULT_TTL_SECS);
    let never = ttl == TTL_NEVER;
    if never && (request.minted_token.is_some() || request.not_after.is_some()) {
        return Err(invalid(
            "only a person may mint a session that never expires",
        ));
    }
    if !never && !(MIN_TTL_SECS..=MAX_TTL_SECS).contains(&ttl) {
        return Err(invalid("ttlSecs must be between 60 and 86400"));
    }
    if request.services.is_empty() || request.services.len() > MAX_SERVICES {
        return Err(invalid("a session needs 1-32 services"));
    }
    if request.label.len() > MAX_LABEL_LEN {
        return Err(invalid("label is too long"));
    }
    let now = now_millis();
    // Count only sessions that are still usable: one whose minting token was
    // revoked or expired (or whose identity was disabled) is dead, as
    // `lookup` and `list` see it, and must not hold a slot.
    let active: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM vault_broker_sessions WHERE minted_by = ?1 AND {}",
            live_clause("?2")
        ),
        params![request.minted_by, now],
        |row| row.get(0),
    )?;
    if active >= MAX_ACTIVE_PER_SUBJECT {
        return Err(VaultError::Conflict(format!(
            "at most {MAX_ACTIVE_PER_SUBJECT} live broker sessions per principal; revoke one first"
        ))
        .into());
    }
    let mut expires_at = if never {
        NEVER_EXPIRES_AT
    } else {
        now + ttl * 1000
    };
    if let Some(cap) = request.not_after {
        expires_at = expires_at.min(cap);
    }
    let mut services = request.services;
    services.sort();
    services.dedup();
    let token = random_token(TOKEN_PREFIX);
    let session = BrokerSession {
        id: random_token("bvs_"),
        environment: request.environment,
        services,
        label: request.label,
        minted_by: request.minted_by,
        created_at: now,
        expires_at,
        revoked_at: None,
        minted_token: request.minted_token,
        minter_scope: request.minter_scope,
    };
    let minter_scope = session
        .minter_scope
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    conn.execute(
        "INSERT INTO vault_broker_sessions
            (id, token_hash, environment, services, label, minted_by, created_at, expires_at,
             minted_token, minter_scope)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            session.id,
            sha256_hex(token.as_bytes()),
            session.environment,
            serde_json::to_string(&session.services)?,
            session.label,
            session.minted_by,
            session.created_at,
            session.expires_at,
            session.minted_token,
            minter_scope
        ],
    )?;
    Ok((token, session))
}

const COLUMNS: &str =
    "id, environment, services, label, minted_by, created_at, expires_at, revoked_at, minted_token,
     minter_scope";

/// A session is live while it is unrevoked and unexpired and, when a machine
/// token minted it, while that token is unrevoked and unexpired and its
/// identity is enabled. `now` names the parameter holding the current time
/// in milliseconds.
fn live_clause(now: &str) -> String {
    format!(
        "revoked_at IS NULL AND expires_at > {now}
         AND (minted_token IS NULL OR EXISTS (
             SELECT 1 FROM vault_tokens t
             JOIN vault_machine_identities i ON i.id = t.identity_id
             WHERE t.accessor = vault_broker_sessions.minted_token
               AND t.revoked_at IS NULL AND t.expires_at > {now} AND i.disabled = 0))"
    )
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<BrokerSession> {
    let services: String = row.get(2)?;
    Ok(BrokerSession {
        id: row.get(0)?,
        environment: row.get(1)?,
        services: serde_json::from_str(&services).unwrap_or_default(),
        label: row.get(3)?,
        minted_by: row.get(4)?,
        created_at: row.get(5)?,
        expires_at: row.get(6)?,
        revoked_at: row.get(7)?,
        minted_token: row.get(8)?,
        minter_scope: row
            .get::<_, Option<String>>(9)?
            .and_then(|scope| serde_json::from_str(&scope).ok()),
    })
}

/// The live session behind a token, if any, presented from `client`. A
/// session a CIDR-bound machine token minted is usable only from inside that
/// token's bound blocks, so minting a session cannot carry the token's
/// address binding to other networks.
pub fn lookup(
    conn: &Connection,
    token: &str,
    client: Option<IpAddr>,
) -> Result<Option<BrokerSession>> {
    if !token.starts_with(TOKEN_PREFIX) {
        return Ok(None);
    }
    let session = conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM vault_broker_sessions WHERE token_hash = ?1 AND {}",
                live_clause("?2")
            ),
            params![sha256_hex(token.as_bytes()), now_millis()],
            row_to_session,
        )
        .optional()?;
    match session {
        Some(session) if minted_token_admits(conn, &session, client)? => Ok(Some(session)),
        _ => Ok(None),
    }
}

/// Refuse a use-limited machine token as the minter of a broker session: each
/// brokered credential resolution would otherwise be a free use, so the
/// session would outlive the token's use limit.
pub fn check_minting_token(conn: &Connection, accessor: &str) -> Result<()> {
    let info = crate::vault::tokens::token_info_locked(conn, accessor)?;
    if info.num_uses_remaining.is_some() {
        return Err(VaultError::Denied(
            "a use-limited token cannot mint a broker session".to_owned(),
        )
        .into());
    }
    Ok(())
}

/// Whether the machine token that minted `session` (if any) admits a request
/// from `client` under its CIDR binding.
fn minted_token_admits(
    conn: &Connection,
    session: &BrokerSession,
    client: Option<IpAddr>,
) -> Result<bool> {
    let Some(accessor) = &session.minted_token else {
        return Ok(true);
    };
    let info = crate::vault::tokens::token_info_locked(conn, accessor)?;
    Ok(crate::vault::tokens::ip_allowed(&info.bound_cidrs, client))
}

/// The session with this id if it is still live (re-checked by the proxy on
/// every request of a long-lived connection).
pub fn live(conn: &Connection, id: &str) -> Result<Option<BrokerSession>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM vault_broker_sessions WHERE id = ?1 AND {}",
                live_clause("?2")
            ),
            params![id, now_millis()],
            row_to_session,
        )
        .optional()?)
}

/// Live sessions, newest first.
pub fn list(conn: &Connection) -> Result<Vec<BrokerSession>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM vault_broker_sessions WHERE {} ORDER BY created_at DESC",
        live_clause("?1")
    ))?;
    let rows = stmt.query_map(params![now_millis()], row_to_session)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One session by id (live or not).
pub fn get(conn: &Connection, id: &str) -> Result<Option<BrokerSession>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM vault_broker_sessions WHERE id = ?1"),
            params![id],
            row_to_session,
        )
        .optional()?)
}

/// Revoke a session. Returns whether a live session was revoked.
pub fn revoke(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE vault_broker_sessions SET revoked_at = ?2
         WHERE id = ?1 AND revoked_at IS NULL",
        params![id, now_millis()],
    )? > 0)
}

/// Trim session history: ended (expired or revoked) sessions are kept, and
/// only those past the newest [`MAX_HISTORY_ROWS`] are deleted.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM vault_broker_sessions WHERE id IN (
             SELECT id FROM vault_broker_sessions
             WHERE expires_at <= ?1 OR revoked_at IS NOT NULL
             ORDER BY created_at DESC LIMIT -1 OFFSET ?2)",
        params![now, MAX_HISTORY_ROWS],
    )?)
}

/// Extract an `rvb_` token from a `Proxy-Authorization` (or `Authorization`)
/// value: `Bearer <token>`, `Basic base64(<token>)`, or `Basic
/// base64(<user>:<password>)` where either half is the token.
pub fn parse_authorization(value: &str) -> Option<String> {
    let value = value.trim();
    let (scheme, credentials) = value.split_once(' ')?;
    let credentials = credentials.trim();
    if scheme.eq_ignore_ascii_case("bearer") {
        return credentials
            .starts_with(TOKEN_PREFIX)
            .then(|| credentials.to_owned());
    }
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(credentials)
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    decoded
        .split(':')
        .find(|part| part.starts_with(TOKEN_PREFIX))
        .map(str::to_owned)
}

#[path = "session_history.rs"]
pub mod history;

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
