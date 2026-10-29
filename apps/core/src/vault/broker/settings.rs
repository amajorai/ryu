//! Per-environment broker settings: what happens to traffic for a host no
//! service covers, and the markdown "skills" agents read through discovery.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::services::MAX_NOTES_BYTES;
use crate::vault::{now_millis, VaultError};

/// What the broker does with a request no service matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnmatchedHostPolicy {
    /// Refuse with a 403 that tells the agent how to propose a service.
    #[default]
    Deny,
    /// Forward (or tunnel) without injecting anything.
    Passthrough,
}

impl UnmatchedHostPolicy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::Passthrough => "passthrough",
        }
    }

    fn parse(value: &str) -> Self {
        if value == "passthrough" {
            Self::Passthrough
        } else {
            Self::Deny
        }
    }
}

/// Broker settings of one environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentSettings {
    #[serde(default)]
    pub environment: String,
    #[serde(default)]
    pub unmatched_host_policy: UnmatchedHostPolicy,
    /// Markdown instructions for agents (at most 64 KiB).
    #[serde(default)]
    pub skills: String,
    #[serde(default)]
    pub updated_at: i64,
}

impl EnvironmentSettings {
    fn defaults(environment: &str) -> Self {
        Self {
            environment: environment.to_owned(),
            unmatched_host_policy: UnmatchedHostPolicy::Deny,
            skills: String::new(),
            updated_at: 0,
        }
    }
}

/// Create the settings table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_broker_environments (
             environment           TEXT PRIMARY KEY,
             unmatched_host_policy TEXT NOT NULL DEFAULT 'deny',
             skills                TEXT NOT NULL DEFAULT '',
             updated_at            INTEGER NOT NULL
         );",
    )
    .context("initializing broker environment settings schema")
}

/// Settings for an environment (defaults when never written: `deny`).
pub fn get(conn: &Connection, environment: &str) -> Result<EnvironmentSettings> {
    let row: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT unmatched_host_policy, skills, updated_at FROM vault_broker_environments
             WHERE environment = ?1",
            params![environment],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(match row {
        Some((policy, skills, updated_at)) => EnvironmentSettings {
            environment: environment.to_owned(),
            unmatched_host_policy: UnmatchedHostPolicy::parse(&policy),
            skills,
            updated_at,
        },
        None => EnvironmentSettings::defaults(environment),
    })
}

/// Write an environment's settings.
pub fn put(
    conn: &Connection,
    environment: &str,
    policy: UnmatchedHostPolicy,
    skills: &str,
) -> Result<EnvironmentSettings> {
    if !crate::vault::is_valid_environment(environment) {
        return Err(VaultError::Invalid("invalid environment".into()).into());
    }
    if skills.len() > MAX_NOTES_BYTES {
        return Err(VaultError::Invalid("skills exceed 64 KiB".into()).into());
    }
    conn.execute(
        "INSERT INTO vault_broker_environments
            (environment, unmatched_host_policy, skills, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (environment) DO UPDATE SET
            unmatched_host_policy = excluded.unmatched_host_policy,
            skills = excluded.skills,
            updated_at = excluded.updated_at",
        params![environment, policy.as_str(), skills, now_millis()],
    )?;
    get(conn, environment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn settings_default_to_deny_and_round_trip() {
        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        let conn = store.conn.lock().await;
        let defaults = get(&conn, "prod").unwrap();
        assert_eq!(defaults.unmatched_host_policy, UnmatchedHostPolicy::Deny);
        assert!(defaults.skills.is_empty());
        let saved = put(
            &conn,
            "prod",
            UnmatchedHostPolicy::Passthrough,
            "# Use __KEY__",
        )
        .unwrap();
        assert_eq!(
            saved.unmatched_host_policy,
            UnmatchedHostPolicy::Passthrough
        );
        assert_eq!(get(&conn, "prod").unwrap().skills, "# Use __KEY__");
        assert!(put(&conn, "sys", UnmatchedHostPolicy::Deny, "").is_err());
        let huge = "a".repeat(MAX_NOTES_BYTES + 1);
        assert!(put(&conn, "prod", UnmatchedHostPolicy::Deny, &huge).is_err());
    }
}
