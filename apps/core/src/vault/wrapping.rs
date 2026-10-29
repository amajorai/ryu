//! Response wrapping and per-token cubbyholes.
//!
//! **Wrapping** turns a response that carries a secret (a revealed value, an
//! AppRole secret id, a dynamic credential, a child token) into a single-use
//! wrapping token (`rvw_…`) with a short TTL. The response is sealed with the
//! keyring in `vault_wrapped_responses`; only the token's SHA-256 digest is
//! stored. Whoever unwraps first gets the response and the row is deleted. A
//! tombstone keeps the digest, so a second unwrap is reported (and audited)
//! as a reuse: the handoff was intercepted, or the recipient is confused, and
//! the secret should be treated as compromised. An orchestrator can therefore
//! hand a sandbox or sub-agent a wrapping token without ever holding the
//! secret itself.
//!
//! A **cubbyhole** is a small private key/value store owned by one machine
//! token: only that token can read or write it, values are sealed, and the
//! whole store is destroyed when the token is revoked or expires.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use super::audit::{AuditActor, AuditEntry};
use super::{now_millis, random_token, sha256_hex, VaultError};
use crate::plugin_secrets::PluginSecretStore;

/// Prefix of wrapping tokens.
pub const WRAP_TOKEN_PREFIX: &str = "rvw_";
/// Shortest wrapping TTL.
pub const MIN_WRAP_TTL_SECS: i64 = 1;
/// Longest wrapping TTL (24 hours).
pub const MAX_WRAP_TTL_SECS: i64 = 24 * 3600;
/// Default TTL of `sys/wrapping/wrap` when no TTL header is sent.
pub const DEFAULT_WRAP_TTL_SECS: i64 = 300;
/// Largest response that can be wrapped.
pub const MAX_WRAPPED_BYTES: usize = 1024 * 1024;
/// Largest cubbyhole value (serialized JSON).
pub const MAX_CUBBYHOLE_VALUE_BYTES: usize = 64 * 1024;
/// Most keys one token's cubbyhole may hold.
pub const MAX_CUBBYHOLE_KEYS: i64 = 256;
/// How long reuse tombstones are kept.
const TOMBSTONE_RETENTION_MILLIS: i64 = 7 * 24 * 3600 * 1000;

/// Metadata of a wrapping token. `token` is present only when it is minted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrapInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub accessor: String,
    pub ttl_secs: i64,
    pub creation_path: String,
    pub created_at: i64,
    pub expires_at: i64,
}

/// One cubbyhole key (never the value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CubbyholeEntry {
    pub key: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Parse a wrap TTL: `300`, `300s`, `5m`, or `1h`, within the allowed range.
pub fn parse_wrap_ttl(text: &str) -> Result<i64> {
    let text = text.trim();
    let invalid = || VaultError::Invalid(format!("invalid wrap TTL `{text}`"));
    let (digits, unit) = match text.char_indices().last() {
        Some((index, 's')) => (&text[..index], 1),
        Some((index, 'm')) => (&text[..index], 60),
        Some((index, 'h')) => (&text[..index], 3600),
        _ => (text, 1),
    };
    let value: i64 = digits.parse().map_err(|_| invalid())?;
    let secs = value.checked_mul(unit).ok_or_else(invalid)?;
    if !(MIN_WRAP_TTL_SECS..=MAX_WRAP_TTL_SECS).contains(&secs) {
        return Err(VaultError::Invalid(format!(
            "wrap TTL must be between {MIN_WRAP_TTL_SECS}s and {MAX_WRAP_TTL_SECS}s"
        ))
        .into());
    }
    Ok(secs)
}

fn is_valid_cubbyhole_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// Create the wrapping and cubbyhole tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_wrapped_responses (
             accessor      TEXT PRIMARY KEY,
             digest        TEXT NOT NULL UNIQUE,
             creation_path TEXT NOT NULL,
             created_at    INTEGER NOT NULL,
             expires_at    INTEGER NOT NULL,
             ttl_secs      INTEGER NOT NULL,
             nonce         BLOB NOT NULL,
             ciphertext    BLOB NOT NULL,
             key_version   INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS vault_wrapping_tombstones (
             digest        TEXT PRIMARY KEY,
             accessor      TEXT NOT NULL,
             creation_path TEXT NOT NULL,
             reason        TEXT NOT NULL,
             at            INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_cubbyhole (
             token_accessor TEXT NOT NULL,
             key            TEXT NOT NULL,
             created_at     INTEGER NOT NULL,
             updated_at     INTEGER NOT NULL,
             nonce          BLOB NOT NULL,
             ciphertext     BLOB NOT NULL,
             key_version    INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (token_accessor, key)
         );",
    )
    .context("initializing wrapping schema")
}

/// Destroy one token's cubbyhole.
pub(crate) fn cubbyhole_destroy_locked(conn: &Connection, accessor: &str) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM vault_cubbyhole WHERE token_accessor = ?1",
        params![accessor],
    )?)
}

/// Delete expired wrapping tokens, old tombstones, and the cubbyholes of
/// tokens that are no longer live.
pub(crate) fn wrapping_prune_locked(conn: &Connection, now: i64) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO vault_wrapping_tombstones
             (digest, accessor, creation_path, reason, at)
         SELECT digest, accessor, creation_path, 'expired', ?1
         FROM vault_wrapped_responses WHERE expires_at <= ?1",
        params![now],
    )?;
    let wraps = tx.execute(
        "DELETE FROM vault_wrapped_responses WHERE expires_at <= ?1",
        params![now],
    )?;
    let tombstones = tx.execute(
        "DELETE FROM vault_wrapping_tombstones WHERE at < ?1",
        params![now - TOMBSTONE_RETENTION_MILLIS],
    )?;
    let cubbyholes = tx.execute(
        "DELETE FROM vault_cubbyhole WHERE token_accessor NOT IN (
             SELECT accessor FROM vault_tokens WHERE revoked_at IS NULL AND expires_at > ?1
         )",
        params![now],
    )?;
    tx.commit()?;
    Ok(wraps + tombstones + cubbyholes)
}

fn wrap_actor(accessor: Option<&str>) -> AuditActor {
    AuditActor::new("wrapping_token", accessor)
}

struct WrappedRow {
    accessor: String,
    creation_path: String,
    created_at: i64,
    expires_at: i64,
    ttl_secs: i64,
    key_version: u32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

impl WrappedRow {
    fn info(&self) -> WrapInfo {
        WrapInfo {
            token: None,
            accessor: self.accessor.clone(),
            ttl_secs: self.ttl_secs,
            creation_path: self.creation_path.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
        }
    }
}

fn wrapped_row_locked(conn: &Connection, digest: &str) -> Result<Option<WrappedRow>> {
    Ok(conn
        .query_row(
            "SELECT accessor, creation_path, created_at, expires_at, ttl_secs, key_version,
                    nonce, ciphertext
             FROM vault_wrapped_responses WHERE digest = ?1",
            params![digest],
            |row| {
                Ok(WrappedRow {
                    accessor: row.get(0)?,
                    creation_path: row.get(1)?,
                    created_at: row.get(2)?,
                    expires_at: row.get(3)?,
                    ttl_secs: row.get(4)?,
                    key_version: row.get(5)?,
                    nonce: row.get(6)?,
                    ciphertext: row.get(7)?,
                })
            },
        )
        .optional()?)
}

fn tombstone_locked(conn: &Connection, digest: &str, row: &WrappedRow, reason: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_wrapped_responses WHERE digest = ?1",
        params![digest],
    )?;
    conn.execute(
        "INSERT OR REPLACE INTO vault_wrapping_tombstones
             (digest, accessor, creation_path, reason, at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            digest,
            row.accessor,
            row.creation_path,
            reason,
            now_millis()
        ],
    )?;
    Ok(())
}

/// Undo [`tombstone_locked`] for a token whose handout was refused, so the
/// wrapped response is not destroyed by an audit outage and can be retried.
fn restore_wrapped_locked(conn: &Connection, digest: &str, row: &WrappedRow) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO vault_wrapped_responses
             (accessor, digest, creation_path, created_at, expires_at, ttl_secs, nonce,
              ciphertext, key_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            row.accessor,
            digest,
            row.creation_path,
            row.created_at,
            row.expires_at,
            row.ttl_secs,
            row.nonce,
            row.ciphertext,
            row.key_version
        ],
    )?;
    tx.execute(
        "DELETE FROM vault_wrapping_tombstones WHERE digest = ?1",
        params![digest],
    )?;
    tx.commit()?;
    Ok(())
}

impl PluginSecretStore {
    fn wrap_insert_locked(
        &self,
        conn: &Connection,
        payload: &[u8],
        ttl_secs: i64,
        creation_path: &str,
    ) -> Result<WrapInfo> {
        if payload.len() > MAX_WRAPPED_BYTES {
            return Err(VaultError::Invalid("the response is too large to wrap".into()).into());
        }
        let ttl_secs = ttl_secs.clamp(MIN_WRAP_TTL_SECS, MAX_WRAP_TTL_SECS);
        let (key_version, nonce, ciphertext) = self.seal_row(payload)?;
        let token = random_token(WRAP_TOKEN_PREFIX);
        let accessor = random_token("rwa_");
        let created_at = now_millis();
        let expires_at = created_at + ttl_secs * 1000;
        conn.execute(
            "INSERT INTO vault_wrapped_responses
                 (accessor, digest, creation_path, created_at, expires_at, ttl_secs, nonce,
                  ciphertext, key_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                accessor,
                sha256_hex(token.as_bytes()),
                creation_path,
                created_at,
                expires_at,
                ttl_secs,
                nonce,
                ciphertext,
                key_version
            ],
        )?;
        Ok(WrapInfo {
            token: Some(token),
            accessor,
            ttl_secs,
            creation_path: creation_path.to_owned(),
            created_at,
            expires_at,
        })
    }

    /// Seal `payload` behind a new single-use wrapping token.
    pub async fn wrap_response(
        &self,
        payload: &[u8],
        ttl_secs: i64,
        creation_path: &str,
        actor: &AuditActor,
    ) -> Result<WrapInfo> {
        let conn = self.conn.lock().await;
        let info = self.wrap_insert_locked(&conn, payload, ttl_secs, creation_path)?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "wrapping.wrap", "ok").details(json!({
                "accessor": info.accessor,
                "creationPath": info.creation_path,
                "ttlSecs": info.ttl_secs,
            })),
        );
        Ok(info)
    }

    /// Take the wrapped row for `token`, reporting reuse and expiry. The row
    /// is opened before it is deleted, so a sealed vault never burns it.
    fn wrap_take_locked(
        &self,
        conn: &Connection,
        token: &str,
        action: &str,
        reason: &str,
    ) -> Result<(WrappedRow, Vec<u8>)> {
        let digest = sha256_hex(token.trim().as_bytes());
        let row = if token.trim().starts_with(WRAP_TOKEN_PREFIX) {
            wrapped_row_locked(conn, &digest)?
        } else {
            None
        };
        let Some(row) = row else {
            let used: Option<(String, String, String)> = conn
                .query_row(
                    "SELECT accessor, creation_path, reason FROM vault_wrapping_tombstones
                     WHERE digest = ?1",
                    params![digest],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            return Err(match used {
                Some((accessor, creation_path, previous)) => {
                    self.audit_locked(
                        conn,
                        &AuditEntry::new(&wrap_actor(Some(&accessor)), action, "denied").details(
                            json!({
                                "accessor": accessor,
                                "creationPath": creation_path,
                                "reason": format!("wrapping token already {previous}"),
                            }),
                        ),
                    );
                    VaultError::Denied(format!(
                        "this wrapping token was already {previous}; if you did not do that, \
                         treat the wrapped secret as compromised"
                    ))
                }
                None => {
                    self.audit_locked(
                        conn,
                        &AuditEntry::new(&wrap_actor(None), action, "denied")
                            .details(json!({ "reason": "unknown wrapping token" })),
                    );
                    VaultError::Denied("invalid wrapping token".into())
                }
            }
            .into());
        };
        if row.expires_at <= now_millis() {
            tombstone_locked(conn, &digest, &row, "expired")?;
            self.audit_locked(
                conn,
                &AuditEntry::new(&wrap_actor(Some(&row.accessor)), action, "denied").details(
                    json!({ "accessor": row.accessor, "reason": "wrapping token expired" }),
                ),
            );
            return Err(VaultError::Denied("the wrapping token has expired".into()).into());
        }
        let payload = self.open_row(row.key_version, &row.nonce, &row.ciphertext)?;
        tombstone_locked(conn, &digest, &row, reason)?;
        Ok((row, payload))
    }

    /// Unwrap: return the wrapped response and destroy the wrapping token.
    pub async fn wrap_unwrap(&self, token: &str) -> Result<Vec<u8>> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let result = self.wrap_take_locked(&tx, token, "wrapping.unwrap", "unwrapped");
        let (row, payload) = match result {
            Ok(taken) => taken,
            Err(error) => {
                // Keep the denial audit row and any expiry tombstone.
                tx.commit()?;
                self.flush_audit(&conn);
                return Err(error);
            }
        };
        tx.commit()?;
        // Audit after the tombstone commits: inside a transaction the
        // fail-closed verdict is deferred, and the payload must not leave
        // without an accepted row. A refused row restores the wrapped
        // response, so an audit outage never destroys it and a retry works.
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(&wrap_actor(Some(&row.accessor)), "wrapping.unwrap", "ok")
                .details(json!({ "accessor": row.accessor, "creationPath": row.creation_path })),
        ) {
            restore_wrapped_locked(&conn, &sha256_hex(token.trim().as_bytes()), &row)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(payload)
    }

    /// Describe a wrapping token without consuming it.
    pub async fn wrap_lookup(&self, token: &str) -> Result<WrapInfo> {
        let conn = self.conn.lock().await;
        let row = if token.trim().starts_with(WRAP_TOKEN_PREFIX) {
            wrapped_row_locked(&conn, &sha256_hex(token.trim().as_bytes()))?
        } else {
            None
        };
        let row = row
            .filter(|row| row.expires_at > now_millis())
            .ok_or_else(|| VaultError::NotFound("wrapping token".into()))?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(&wrap_actor(Some(&row.accessor)), "wrapping.lookup", "ok")
                .details(json!({ "accessor": row.accessor })),
        );
        Ok(row.info())
    }

    /// Re-wrap: consume the token and wrap the same response under a new
    /// token with the original TTL, sealed with the active key.
    pub async fn wrap_rewrap(&self, token: &str) -> Result<WrapInfo> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let (row, payload) = match self.wrap_take_locked(&tx, token, "wrapping.rewrap", "rewrapped")
        {
            Ok(taken) => taken,
            Err(error) => {
                tx.commit()?;
                self.flush_audit(&conn);
                return Err(error);
            }
        };
        let info = self.wrap_insert_locked(&tx, &payload, row.ttl_secs, &row.creation_path)?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(&wrap_actor(Some(&row.accessor)), "wrapping.rewrap", "ok")
                .details(json!({ "accessor": row.accessor, "newAccessor": info.accessor })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(info)
    }

    /// Write one key of a token's cubbyhole.
    pub async fn cubbyhole_put(
        &self,
        token_accessor: &str,
        key: &str,
        value: &Value,
        actor: &AuditActor,
    ) -> Result<()> {
        if !is_valid_cubbyhole_key(key) {
            return Err(VaultError::Invalid("invalid cubbyhole key".into()).into());
        }
        let plain = serde_json::to_vec(value)?;
        if plain.len() > MAX_CUBBYHOLE_VALUE_BYTES {
            return Err(VaultError::Invalid("the cubbyhole value is too large".into()).into());
        }
        let (key_version, nonce, ciphertext) = self.seal_row(&plain)?;
        let conn = self.conn.lock().await;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_cubbyhole WHERE token_accessor = ?1 AND key != ?2",
            params![token_accessor, key],
            |row| row.get(0),
        )?;
        if count >= MAX_CUBBYHOLE_KEYS {
            return Err(VaultError::Conflict("the cubbyhole is full".into()).into());
        }
        let now = now_millis();
        conn.execute(
            "INSERT INTO vault_cubbyhole
                 (token_accessor, key, created_at, updated_at, nonce, ciphertext, key_version)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
             ON CONFLICT(token_accessor, key) DO UPDATE SET
                 updated_at = excluded.updated_at, nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext, key_version = excluded.key_version",
            params![token_accessor, key, now, nonce, ciphertext, key_version],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "cubbyhole.write", "ok").details(json!({ "key": key })),
        );
        Ok(())
    }

    /// Read one key of a token's cubbyhole.
    pub async fn cubbyhole_get(
        &self,
        token_accessor: &str,
        key: &str,
        actor: &AuditActor,
    ) -> Result<Value> {
        let conn = self.conn.lock().await;
        let row: Option<(u32, Vec<u8>, Vec<u8>)> = conn
            .query_row(
                "SELECT key_version, nonce, ciphertext FROM vault_cubbyhole
                 WHERE token_accessor = ?1 AND key = ?2",
                params![token_accessor, key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (key_version, nonce, ciphertext) =
            row.ok_or_else(|| VaultError::NotFound(format!("cubbyhole key `{key}`")))?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "cubbyhole.read", "ok").details(json!({ "key": key })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(serde_json::from_slice(&plain)?)
    }

    /// Keys of a token's cubbyhole.
    pub async fn cubbyhole_list(&self, token_accessor: &str) -> Result<Vec<CubbyholeEntry>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT key, created_at, updated_at FROM vault_cubbyhole
             WHERE token_accessor = ?1 ORDER BY key",
        )?;
        let rows = stmt.query_map(params![token_accessor], |row| {
            Ok(CubbyholeEntry {
                key: row.get(0)?,
                created_at: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Delete one key of a token's cubbyhole.
    pub async fn cubbyhole_delete(
        &self,
        token_accessor: &str,
        key: &str,
        actor: &AuditActor,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let deleted = conn.execute(
            "DELETE FROM vault_cubbyhole WHERE token_accessor = ?1 AND key = ?2",
            params![token_accessor, key],
        )? > 0;
        self.audit_locked(
            &conn,
            &AuditEntry::new(
                actor,
                "cubbyhole.delete",
                if deleted { "ok" } else { "not_found" },
            )
            .details(json!({ "key": key })),
        );
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::machine::AuthMethod;

    #[test]
    fn wrap_ttls_parse_units_and_bounds() {
        assert_eq!(parse_wrap_ttl("300").unwrap(), 300);
        assert_eq!(parse_wrap_ttl("45s").unwrap(), 45);
        assert_eq!(parse_wrap_ttl("5m").unwrap(), 300);
        assert_eq!(parse_wrap_ttl("2h").unwrap(), 7200);
        for bad in ["", "0", "-5", "25h", "abc", "5d", "99999999999999999999"] {
            assert!(parse_wrap_ttl(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn unwrap_is_single_use_and_reuse_is_audited() {
        let store = PluginSecretStore::in_memory().unwrap();
        let payload = br#"{"secretId":"sid_abc"}"#;
        let info = store
            .wrap_response(
                payload,
                60,
                "/api/vault/machines/ci/secret-ids",
                &AuditActor::system(),
            )
            .await
            .unwrap();
        let token = info.token.clone().unwrap();
        assert!(token.starts_with(WRAP_TOKEN_PREFIX));
        let looked = store.wrap_lookup(&token).await.unwrap();
        assert_eq!(looked.accessor, info.accessor);
        assert!(looked.token.is_none());
        assert_eq!(store.wrap_unwrap(&token).await.unwrap(), payload.to_vec());
        let error = store.wrap_unwrap(&token).await.unwrap_err().to_string();
        assert!(error.contains("already unwrapped"), "{error}");
        assert!(store.wrap_lookup(&token).await.is_err());
        let conn = store.conn.lock().await;
        let denied: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vault_audit WHERE action = 'wrapping.unwrap'
                 AND outcome = 'denied'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(denied, 1);
        // The plaintext never reaches the database.
        let leaked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vault_wrapped_responses WHERE ciphertext LIKE '%sid_abc%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leaked, 0);
    }

    #[tokio::test]
    async fn expired_and_unknown_tokens_are_refused() {
        let store = PluginSecretStore::in_memory().unwrap();
        let info = store
            .wrap_response(b"{}", 60, "/x", &AuditActor::system())
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute("UPDATE vault_wrapped_responses SET expires_at = 0", [])
                .unwrap();
        }
        let token = info.token.unwrap();
        assert!(store.wrap_unwrap(&token).await.is_err());
        assert!(store.wrap_unwrap("rvw_unknown").await.is_err());
        assert!(store.wrap_unwrap("not-a-wrap-token").await.is_err());
    }

    #[tokio::test]
    async fn rewrap_moves_the_payload_to_a_new_token() {
        let store = PluginSecretStore::in_memory().unwrap();
        let info = store
            .wrap_response(b"{\"v\":1}", 120, "/p", &AuditActor::system())
            .await
            .unwrap();
        let old = info.token.unwrap();
        let fresh = store.wrap_rewrap(&old).await.unwrap();
        assert_eq!(fresh.ttl_secs, 120);
        assert_eq!(fresh.creation_path, "/p");
        assert!(store.wrap_unwrap(&old).await.is_err());
        assert_eq!(
            store.wrap_unwrap(&fresh.token.unwrap()).await.unwrap(),
            b"{\"v\":1}".to_vec()
        );
    }

    #[tokio::test]
    async fn cubbyholes_are_private_and_die_with_the_token() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let identity = store
            .machine_create(
                "cubby",
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                vec![],
                None,
                &actor,
            )
            .await
            .unwrap();
        let AuthMethod::AppRole { role_id } = identity.auth else {
            panic!("approle")
        };
        let (secret, _) = store
            .machine_issue_secret_id("cubby", None, None, &actor)
            .await
            .unwrap();
        let token = store.approle_login(&role_id, &secret).await.unwrap();
        let value = json!({ "note": "private" });
        store
            .cubbyhole_put(&token.accessor, "scratch", &value, &actor)
            .await
            .unwrap();
        assert!(store
            .cubbyhole_put(&token.accessor, "../bad", &value, &actor)
            .await
            .is_err());
        assert_eq!(
            store
                .cubbyhole_get(&token.accessor, "scratch", &actor)
                .await
                .unwrap(),
            value
        );
        assert!(store
            .cubbyhole_get("rva_someone_else", "scratch", &actor)
            .await
            .is_err());
        assert_eq!(
            store.cubbyhole_list(&token.accessor).await.unwrap().len(),
            1
        );
        store.token_revoke(&token.accessor, &actor).await.unwrap();
        assert!(store
            .cubbyhole_list(&token.accessor)
            .await
            .unwrap()
            .is_empty());
        // Pruning drops cubbyholes of tokens that expired without revocation.
        let other = store
            .machine_issue_secret_id("cubby", None, None, &actor)
            .await
            .unwrap();
        let second = store.approle_login(&role_id, &other.0).await.unwrap();
        store
            .cubbyhole_put(&second.accessor, "k", &value, &actor)
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute("UPDATE vault_tokens SET expires_at = 1", [])
                .unwrap();
        }
        assert!(store.token_lifecycle_prune().await.unwrap() >= 1);
        assert!(store
            .cubbyhole_list(&second.accessor)
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .cubbyhole_delete(&second.accessor, "k", &actor)
            .await
            .map(|deleted| !deleted)
            .unwrap());
    }
}
