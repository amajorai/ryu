//! Login lockout: a machine identity whose logins fail `threshold` times
//! inside `windowSecs` is locked for `durationSecs`, whatever method or
//! surface the attempts came through. While locked, logins are refused before
//! any credential is checked. An administrator can unlock early.
//!
//! Defaults follow OpenBao's user lockout: 5 failures in 15 minutes lock
//! for 15 minutes. Only existing identities are tracked, so random names
//! cannot grow the table. Locks and unlocks are audited
//! (`auth.lockout.lock`, `auth.lockout.unlock`); a refused attempt is
//! audited as `auth.lockout.denied`.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{now_millis, VaultError};

const DEFAULT_THRESHOLD: u32 = 5;
const DEFAULT_WINDOW_SECS: i64 = 15 * 60;
const DEFAULT_DURATION_SECS: i64 = 15 * 60;
const MAX_SECS: i64 = 30 * 24 * 3600;

/// Lockout settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockoutConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Failed logins that lock an identity.
    #[serde(default = "default_threshold")]
    pub threshold: u32,
    /// How long failures count toward the threshold.
    #[serde(default = "default_window")]
    pub window_secs: i64,
    /// How long a lock lasts.
    #[serde(default = "default_duration")]
    pub duration_secs: i64,
}

fn default_enabled() -> bool {
    true
}
fn default_threshold() -> u32 {
    DEFAULT_THRESHOLD
}
fn default_window() -> i64 {
    DEFAULT_WINDOW_SECS
}
fn default_duration() -> i64 {
    DEFAULT_DURATION_SECS
}

impl Default for LockoutConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold: DEFAULT_THRESHOLD,
            window_secs: DEFAULT_WINDOW_SECS,
            duration_secs: DEFAULT_DURATION_SECS,
        }
    }
}

impl LockoutConfig {
    fn validate(&self) -> Result<()> {
        if !(1..=1000).contains(&self.threshold) {
            return Err(VaultError::Invalid("threshold must be 1 to 1000".into()).into());
        }
        for (name, secs) in [
            ("windowSecs", self.window_secs),
            ("durationSecs", self.duration_secs),
        ] {
            if !(1..=MAX_SECS).contains(&secs) {
                return Err(VaultError::Invalid(format!("{name} must be 1 to {MAX_SECS}")).into());
            }
        }
        Ok(())
    }
}

/// A locked identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedIdentity {
    pub identity: String,
    pub failures: u32,
    pub locked_at: i64,
    pub locked_until: i64,
}

/// A refused login: the identity is locked until `locked_until` (ms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Locked {
    pub locked_until: i64,
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_login_lockouts (
             identity      TEXT PRIMARY KEY,
             failures      INTEGER NOT NULL,
             window_start  INTEGER NOT NULL,
             locked_at     INTEGER,
             locked_until  INTEGER
         );
         CREATE TABLE IF NOT EXISTS vault_login_lockout_config (
             id     INTEGER PRIMARY KEY CHECK (id = 1),
             config TEXT NOT NULL
         );",
    )
    .context("initializing login lockout schema")
}

fn read_config(conn: &Connection) -> Result<LockoutConfig> {
    init_schema(conn)?;
    let stored: Option<String> = conn
        .query_row(
            "SELECT config FROM vault_login_lockout_config WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stored
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

/// The identity a login names: an AppRole role id resolves to its identity.
/// `None` when no such identity exists.
fn resolve(conn: &Connection, principal: &LoginPrincipal) -> Result<Option<String>> {
    let (column, value) = match principal {
        LoginPrincipal::RoleId(role_id) => ("role_id", role_id),
        LoginPrincipal::Identity(name) => ("name", name),
    };
    Ok(conn
        .query_row(
            &format!("SELECT name FROM vault_machine_identities WHERE {column} = ?1"),
            params![value],
            |row| row.get(0),
        )
        .optional()?)
}

/// Who a login attempt is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginPrincipal {
    RoleId(String),
    Identity(String),
}

fn actor_for(identity: &str) -> AuditActor {
    AuditActor::new("machine", Some(identity))
}

/// Whether a refused attempt for `identity` should be audited: at most once
/// a minute per identity, so a flood against a locked identity cannot grow
/// the audit log.
fn refusal_audit_due(identity: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static LAST: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    let Ok(mut last) = LAST.get_or_init(|| Mutex::new(HashMap::new())).lock() else {
        return false;
    };
    let now = Instant::now();
    last.retain(|_, at| now.duration_since(*at) < Duration::from_secs(60));
    if last.contains_key(identity) {
        return false;
    }
    last.insert(identity.to_owned(), now);
    true
}

impl PluginSecretStore {
    pub async fn lockout_config(&self) -> Result<LockoutConfig> {
        let conn = self.conn.lock().await;
        read_config(&conn)
    }

    pub async fn lockout_set_config(
        &self,
        config: &LockoutConfig,
        actor: &AuditActor,
    ) -> Result<LockoutConfig> {
        config.validate()?;
        let conn = self.conn.lock().await;
        init_schema(&conn)?;
        conn.execute(
            "INSERT INTO vault_login_lockout_config (id, config) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET config = excluded.config",
            params![serde_json::to_string(config)?],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "auth.lockout.config", "ok")
                .details(serde_json::to_value(config)?),
        );
        Ok(*config)
    }

    /// Refuse a login for a locked identity. Expired locks are cleared.
    pub async fn lockout_check(&self, principal: &LoginPrincipal) -> Result<Option<Locked>> {
        let conn = self.conn.lock().await;
        if !read_config(&conn)?.enabled {
            return Ok(None);
        }
        let Some(identity) = resolve(&conn, principal)? else {
            return Ok(None);
        };
        let locked_until: Option<i64> = conn
            .query_row(
                "SELECT locked_until FROM vault_login_lockouts WHERE identity = ?1",
                params![identity],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        match locked_until {
            Some(until) if until > now_millis() => {
                if refusal_audit_due(&identity) {
                    self.audit_locked(
                        &conn,
                        &AuditEntry::new(&actor_for(&identity), "auth.lockout.denied", "denied")
                            .details(json!({ "identity": identity, "lockedUntil": until })),
                    );
                }
                Ok(Some(Locked {
                    locked_until: until,
                }))
            }
            Some(_) => {
                conn.execute(
                    "DELETE FROM vault_login_lockouts WHERE identity = ?1",
                    params![identity],
                )?;
                Ok(None)
            }
            None => Ok(None),
        }
    }

    /// Record a login outcome: a success clears the count; a failure counts
    /// toward the threshold and may lock the identity. Returns the new lock.
    pub async fn lockout_record(
        &self,
        principal: &LoginPrincipal,
        succeeded: bool,
    ) -> Result<Option<Locked>> {
        let conn = self.conn.lock().await;
        let config = read_config(&conn)?;
        let Some(identity) = resolve(&conn, principal)? else {
            return Ok(None);
        };
        if succeeded || !config.enabled {
            conn.execute(
                "DELETE FROM vault_login_lockouts WHERE identity = ?1",
                params![identity],
            )?;
            return Ok(None);
        }
        let now = now_millis();
        let row: Option<(u32, i64)> = conn
            .query_row(
                "SELECT failures, window_start FROM vault_login_lockouts WHERE identity = ?1",
                params![identity],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (failures, window_start) = match row {
            Some((failures, start)) if now - start <= config.window_secs * 1000 => {
                (failures + 1, start)
            }
            _ => (1, now),
        };
        let locked = failures >= config.threshold;
        let (locked_at, locked_until) = if locked {
            (Some(now), Some(now + config.duration_secs * 1000))
        } else {
            (None, None)
        };
        conn.execute(
            "INSERT INTO vault_login_lockouts (identity, failures, window_start, locked_at, locked_until)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(identity) DO UPDATE SET failures = excluded.failures,
                 window_start = excluded.window_start, locked_at = excluded.locked_at,
                 locked_until = excluded.locked_until",
            params![identity, failures, window_start, locked_at, locked_until],
        )?;
        let Some(until) = locked_until else {
            return Ok(None);
        };
        self.audit_locked(
            &conn,
            &AuditEntry::new(&actor_for(&identity), "auth.lockout.lock", "ok").details(json!({
                "identity": identity, "failures": failures, "lockedUntil": until,
            })),
        );
        Ok(Some(Locked {
            locked_until: until,
        }))
    }

    /// Identities locked now.
    pub async fn lockout_list(&self) -> Result<Vec<LockedIdentity>> {
        let conn = self.conn.lock().await;
        init_schema(&conn)?;
        let mut stmt = conn.prepare(
            "SELECT identity, failures, locked_at, locked_until FROM vault_login_lockouts
             WHERE locked_until > ?1 ORDER BY identity",
        )?;
        let rows = stmt.query_map(params![now_millis()], |row| {
            Ok(LockedIdentity {
                identity: row.get(0)?,
                failures: row.get(1)?,
                locked_at: row.get(2)?,
                locked_until: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Unlock an identity and clear its failure count. Returns whether it
    /// was locked.
    pub async fn lockout_unlock(&self, identity: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        init_schema(&conn)?;
        let was_locked: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM vault_login_lockouts
                 WHERE identity = ?1 AND locked_until > ?2)",
            params![identity, now_millis()],
            |row| row.get(0),
        )?;
        conn.execute(
            "DELETE FROM vault_login_lockouts WHERE identity = ?1",
            params![identity],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "auth.lockout.unlock", "ok")
                .details(json!({ "identity": identity, "wasLocked": was_locked })),
        );
        Ok(was_locked)
    }
}

#[cfg(test)]
#[path = "login_lockout_tests.rs"]
mod tests;
