//! Broker sessions: short-lived `rvb_` tokens that authenticate an agent to
//! the proxy.
//!
//! A session is bound to one environment and an explicit list of services, is
//! minted by a human (node bearer) or a machine token holding `use` on each
//! `sys/broker/<service>`, and lives at most [`MAX_TTL_SECS`]. A session a
//! machine token minted also ends when that token is revoked or expires or
//! its identity is disabled. Only the SHA-256 of the token is stored. A
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
    if !(MIN_TTL_SECS..=MAX_TTL_SECS).contains(&ttl) {
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
    let mut expires_at = now + ttl * 1000;
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

/// Delete expired and revoked sessions.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM vault_broker_sessions WHERE expires_at <= ?1 OR revoked_at IS NOT NULL",
        params![now],
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

#[cfg(test)]
mod tests {
    use super::*;

    fn request(subject: &str) -> MintRequest {
        MintRequest {
            environment: "default".into(),
            services: vec!["openai".into(), "github".into(), "openai".into()],
            label: "agent".into(),
            ttl_secs: None,
            minted_by: subject.into(),
            not_after: None,
            minted_token: None,
            minter_scope: None,
        }
    }

    #[tokio::test]
    async fn sessions_mint_lookup_and_revoke() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let (token, session) = mint(&conn, request("user:u1")).unwrap();
        assert!(token.starts_with(TOKEN_PREFIX));
        assert_eq!(session.services, vec!["github", "openai"]);
        assert_eq!(session.user_id(), Some("u1"));
        let stored: String = conn
            .query_row("SELECT token_hash FROM vault_broker_sessions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_ne!(stored, token);
        assert_eq!(lookup(&conn, &token, None).unwrap().unwrap().id, session.id);
        assert!(lookup(&conn, "rvb_wrong", None).unwrap().is_none());
        assert!(lookup(&conn, "rvt_other", None).unwrap().is_none());
        assert!(revoke(&conn, &session.id).unwrap());
        assert!(lookup(&conn, &token, None).unwrap().is_none());
        assert_eq!(prune(&conn, now_millis()).unwrap(), 1);
    }

    #[tokio::test]
    async fn minting_enforces_ttl_caps_and_limits() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let mut bad = request("operator");
        bad.ttl_secs = Some(10);
        assert!(mint(&conn, bad).is_err());
        let mut bad = request("operator");
        bad.services.clear();
        assert!(mint(&conn, bad).is_err());
        let mut capped = request("machine:m1");
        capped.not_after = Some(now_millis() + 5_000);
        let (_, session) = mint(&conn, capped).unwrap();
        assert!(session.expires_at <= now_millis() + 5_000);
        for _ in 1..MAX_ACTIVE_PER_SUBJECT {
            mint(&conn, request("machine:m1")).unwrap();
        }
        let error = mint(&conn, request("machine:m1")).unwrap_err();
        assert_eq!(
            error.downcast_ref::<VaultError>().unwrap().code(),
            "vault_conflict"
        );
        assert!(mint(&conn, request("machine:m2")).is_ok());
    }

    #[tokio::test]
    async fn machine_minted_sessions_end_with_their_token() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let issued = crate::vault::broker::test_machine_token(&store, "ci", Vec::new()).await;
        let (token, session) = {
            let conn = store.conn.lock().await;
            let mut minted = request(&format!("machine:{}", issued.identity_id));
            minted.minted_token = Some(issued.accessor.clone());
            minted.not_after = Some(issued.expires_at);
            mint(&conn, minted).unwrap()
        };
        assert_eq!(
            session.minted_token.as_deref(),
            Some(issued.accessor.as_str())
        );
        {
            let conn = store.conn.lock().await;
            assert!(lookup(&conn, &token, None).unwrap().is_some());
            assert!(live(&conn, &session.id).unwrap().is_some());
            assert_eq!(list(&conn).unwrap().len(), 1);
        }
        store
            .token_revoke(&issued.accessor, &crate::vault::audit::AuditActor::system())
            .await
            .unwrap();
        let conn = store.conn.lock().await;
        assert!(lookup(&conn, &token, None).unwrap().is_none());
        assert!(live(&conn, &session.id).unwrap().is_none());
        assert!(list(&conn).unwrap().is_empty());
        // The row itself is untouched; only liveness follows the token.
        assert!(get(&conn, &session.id)
            .unwrap()
            .unwrap()
            .revoked_at
            .is_none());
    }

    #[tokio::test]
    async fn sessions_of_a_dead_minting_token_free_their_slots() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let issued = crate::vault::broker::test_machine_token(&store, "ci", Vec::new()).await;
        let subject = format!("machine:{}", issued.identity_id);
        let minted_with = |accessor: &str, expires_at: i64| {
            let mut minted = request(&subject);
            minted.minted_token = Some(accessor.to_owned());
            minted.not_after = Some(expires_at);
            minted
        };
        {
            let conn = store.conn.lock().await;
            for _ in 0..MAX_ACTIVE_PER_SUBJECT {
                mint(&conn, minted_with(&issued.accessor, issued.expires_at)).unwrap();
            }
            assert!(mint(&conn, minted_with(&issued.accessor, issued.expires_at)).is_err());
        }
        store
            .token_revoke(&issued.accessor, &crate::vault::audit::AuditActor::system())
            .await
            .unwrap();
        // A fresh login (any live token) mints again: the dead token's
        // sessions no longer count toward the subject's limit.
        let fresh = crate::vault::broker::test_machine_token(&store, "ci-2", Vec::new()).await;
        let conn = store.conn.lock().await;
        assert!(mint(&conn, minted_with(&fresh.accessor, fresh.expires_at)).is_ok());
    }

    #[tokio::test]
    async fn machine_minted_sessions_keep_their_token_cidr_binding() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let issued = crate::vault::broker::test_machine_token(&store, "ci", Vec::new()).await;
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_tokens SET bound_cidrs = ?1 WHERE accessor = ?2",
            params![r#"["10.0.0.0/8"]"#, issued.accessor],
        )
        .unwrap();
        let mut minted = request(&format!("machine:{}", issued.identity_id));
        minted.minted_token = Some(issued.accessor.clone());
        minted.not_after = Some(issued.expires_at);
        let (token, session) = mint(&conn, minted).unwrap();
        let inside: IpAddr = "10.1.2.3".parse().unwrap();
        let outside: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(
            lookup(&conn, &token, Some(inside)).unwrap().unwrap().id,
            session.id
        );
        assert!(lookup(&conn, &token, Some(outside)).unwrap().is_none());
        assert!(lookup(&conn, &token, None).unwrap().is_none());
        // Sessions a human minted carry no token binding.
        let (human, _) = mint(&conn, request("user:u1")).unwrap();
        assert!(lookup(&conn, &human, Some(outside)).unwrap().is_some());
    }

    #[tokio::test]
    async fn use_limited_tokens_cannot_mint_sessions() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let issued = crate::vault::broker::test_machine_token(&store, "ci", Vec::new()).await;
        let conn = store.conn.lock().await;
        check_minting_token(&conn, &issued.accessor).unwrap();
        conn.execute(
            "UPDATE vault_tokens SET num_uses = 3 WHERE accessor = ?1",
            params![issued.accessor],
        )
        .unwrap();
        let error = check_minting_token(&conn, &issued.accessor).unwrap_err();
        assert_eq!(
            error.downcast_ref::<VaultError>().unwrap().code(),
            "vault_denied"
        );
    }

    #[tokio::test]
    async fn live_rechecks_revocation_by_id() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let (_, session) = mint(&conn, request("operator")).unwrap();
        assert!(live(&conn, &session.id).unwrap().is_some());
        revoke(&conn, &session.id).unwrap();
        assert!(live(&conn, &session.id).unwrap().is_none());
        assert!(live(&conn, "bvs_missing").unwrap().is_none());
    }

    #[test]
    fn authorization_values_parse_every_form() {
        let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        assert_eq!(
            parse_authorization("Bearer rvb_abc").as_deref(),
            Some("rvb_abc")
        );
        assert_eq!(
            parse_authorization(&format!("Basic {}", b64("rvb_abc"))).as_deref(),
            Some("rvb_abc")
        );
        assert_eq!(
            parse_authorization(&format!("basic {}", b64("rvb:rvb_abc"))).as_deref(),
            Some("rvb_abc")
        );
        assert_eq!(
            parse_authorization(&format!("Basic {}", b64("rvb_abc:prod"))).as_deref(),
            Some("rvb_abc")
        );
        assert_eq!(parse_authorization("Bearer rvt_machine"), None);
        assert_eq!(parse_authorization("Basic !!!"), None);
        assert_eq!(parse_authorization("Digest x"), None);
    }
}
