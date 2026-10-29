//! Dynamic secrets: short-lived credentials minted on demand.
//!
//! A dynamic role names a provider and its configuration (sealed at rest,
//! since it holds the provider's own admin credential). Issuing against a role
//! creates a fresh credential and a [lease](super::leases); revoking the lease,
//! or letting the scheduler reap it at expiry, deletes the credential at the
//! provider.
//!
//! Providers:
//!
//! * `postgres`: creates a login role from templated statements and drops it
//!   on revocation (renewal extends `VALID UNTIL`);
//! * `aws-sts`: `AssumeRole` session credentials (expire on their own, not
//!   renewable);
//! * `webhook`: delegates issue/renew/revoke to an HTTPS endpoint the operator
//!   runs, signed with an HMAC so the endpoint can trust the caller;
//! * `redis` (alias `valkey`): an ACL user per lease (`ACL SETUSER` /
//!   `ACL DELUSER`); renewal is bookkeeping only;
//! * `random`: a generated value with lease bookkeeping only, for systems that
//!   read the credential back from Ryu.
//!
//! [`static_roles`] rotates existing credentials (database users, Redis ACL
//! users, IAM access keys, webhook-managed API keys) on a schedule instead of
//! minting new ones.

pub mod aws;
pub mod postgres;
pub mod redis;
pub mod static_roles;
pub mod webhook;

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::audit::{AuditActor, AuditEntry};
use super::leases::{LeaseInfo, NewLease};
use super::{now_millis, VaultError};
use crate::plugin_secrets::kv::Charset;
use crate::plugin_secrets::{Generator, PluginSecretStore};

fn random_generator(length: u16, charset: Charset) -> Generator {
    Generator::Random { length, charset }
}

/// Default lease TTL when a role does not set one (1 hour).
pub const DEFAULT_TTL_SECS: i64 = 3600;
/// Upper bound for any dynamic lease (32 days).
pub const MAX_TTL_SECS: i64 = 32 * 24 * 3600;
/// Wall-clock budget for starting revocations in one reaper pass; leases left
/// over wait for the next scheduler tick.
const REAP_TIME_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);

/// Provider configuration. Serialized and sealed as one blob.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ProviderConfig {
    #[serde(rename = "postgres")]
    Postgres(postgres::PostgresConfig),
    #[serde(rename = "aws-sts")]
    AwsSts(aws::AwsStsConfig),
    #[serde(rename = "webhook")]
    Webhook(webhook::WebhookConfig),
    #[serde(rename = "redis", alias = "valkey")]
    Redis(redis::RedisConfig),
    #[serde(rename = "random")]
    Random {
        length: u16,
        charset: Charset,
        /// Key the value is returned under (default `value`).
        #[serde(default)]
        field: Option<String>,
    },
}

impl ProviderConfig {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Postgres(_) => "postgres",
            Self::AwsSts(_) => "aws-sts",
            Self::Webhook(_) => "webhook",
            Self::Redis(_) => "redis",
            Self::Random { .. } => "random",
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Postgres(config) => config.validate(),
            Self::AwsSts(config) => config.validate(),
            Self::Webhook(config) => config.validate(),
            Self::Redis(config) => config.validate(),
            Self::Random {
                length, charset, ..
            } => random_generator(*length, *charset).validate(),
        }
    }

    fn renewable(&self) -> bool {
        !matches!(self, Self::AwsSts(_))
    }

    /// Non-secret summary for listings.
    fn summary(&self) -> Value {
        match self {
            Self::Postgres(config) => json!({
                "host": config.redacted_target(),
                "statements": config.creation_statements.len(),
            }),
            Self::AwsSts(config) => json!({ "roleArn": config.role_arn, "region": config.region }),
            Self::Webhook(config) => json!({ "url": config.url }),
            Self::Redis(config) => json!({
                "host": config.redacted_target(),
                "rules": config.acl_rules.len(),
            }),
            Self::Random {
                length, charset, ..
            } => json!({ "length": length, "charset": charset }),
        }
    }
}

/// Role metadata (configuration secrets redacted).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicRoleInfo {
    pub name: String,
    pub provider: String,
    pub default_ttl_secs: i64,
    pub max_ttl_secs: i64,
    pub summary: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A freshly issued credential. Returned once and never stored in plaintext.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicCredential {
    pub lease: LeaseInfo,
    pub data: BTreeMap<String, String>,
}

/// What a provider returns from issuing.
pub(crate) struct Issued {
    pub data: BTreeMap<String, String>,
    pub revoke_data: Value,
    /// Provider-imposed expiry (seconds from now), if shorter than the lease.
    pub ttl_cap_secs: Option<i64>,
}

/// Create the dynamic role table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_dynamic_roles (
             name             TEXT PRIMARY KEY,
             provider         TEXT NOT NULL,
             default_ttl_secs INTEGER NOT NULL,
             max_ttl_secs     INTEGER NOT NULL,
             summary          TEXT NOT NULL,
             created_at       INTEGER NOT NULL,
             updated_at       INTEGER NOT NULL,
             nonce            BLOB NOT NULL,
             ciphertext       BLOB NOT NULL,
             key_version      INTEGER NOT NULL DEFAULT 0
         );",
    )
    .context("initializing dynamic role schema")
}

/// Role names share the transit key grammar.
pub fn is_valid_role_name(name: &str) -> bool {
    super::transit::is_valid_key_name(name)
}

fn clamp_ttl(requested: Option<i64>, default: i64, max: i64) -> i64 {
    requested.unwrap_or(default).clamp(1, max.max(1))
}

impl PluginSecretStore {
    /// Create or replace a dynamic role.
    pub async fn dynamic_put_role(
        &self,
        name: &str,
        config: &ProviderConfig,
        default_ttl_secs: Option<i64>,
        max_ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<DynamicRoleInfo> {
        if !is_valid_role_name(name) {
            return Err(VaultError::Invalid("invalid dynamic role name".into()).into());
        }
        config
            .validate()
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        let max = max_ttl_secs.unwrap_or(24 * 3600).clamp(1, MAX_TTL_SECS);
        let default = default_ttl_secs
            .unwrap_or(DEFAULT_TTL_SECS.min(max))
            .clamp(1, max);
        let sealed_config = serde_json::to_vec(config)?;
        let (key_version, nonce, ciphertext) = self.seal_row(&sealed_config)?;
        let now = now_millis();
        let conn = self.conn.lock().await;
        // Renewal and revocation use the role's current provider config, so a
        // config change under live leases would send them to the new target
        // while the old credentials stay active. TTL-only edits are fine.
        let stored: Option<(Vec<u8>, Vec<u8>, u32)> = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version FROM vault_dynamic_roles WHERE name = ?1",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((old_nonce, old_ciphertext, old_key_version)) = stored {
            let previous = self.open_row(old_key_version, &old_nonce, &old_ciphertext)?;
            let changed = serde_json::from_slice::<Value>(&previous)?
                != serde_json::from_slice::<Value>(&sealed_config)?;
            let live: i64 = conn.query_row(
                "SELECT COUNT(*) FROM vault_leases WHERE role = ?1 AND revoked_at IS NULL",
                params![name],
                |row| row.get(0),
            )?;
            if changed && live > 0 {
                return Err(VaultError::Conflict(format!(
                    "role `{name}` has {live} live lease(s); revoke them before changing its provider configuration"
                ))
                .into());
            }
        }
        conn.execute(
            "INSERT INTO vault_dynamic_roles
                 (name, provider, default_ttl_secs, max_ttl_secs, summary, created_at, updated_at,
                  nonce, ciphertext, key_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9)
             ON CONFLICT(name) DO UPDATE SET provider = excluded.provider,
                 default_ttl_secs = excluded.default_ttl_secs,
                 max_ttl_secs = excluded.max_ttl_secs, summary = excluded.summary,
                 updated_at = excluded.updated_at, nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext, key_version = excluded.key_version",
            params![
                name,
                config.kind(),
                default,
                max,
                config.summary().to_string(),
                now,
                nonce,
                ciphertext,
                key_version
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "dynamic.role.put", "ok")
                .details(json!({ "role": name, "provider": config.kind() })),
        );
        role_info_locked(&conn, name)
    }

    /// Every dynamic role.
    pub async fn dynamic_list_roles(&self) -> Result<Vec<DynamicRoleInfo>> {
        let conn = self.conn.lock().await;
        let names: Vec<String> = {
            let mut stmt = conn.prepare("SELECT name FROM vault_dynamic_roles ORDER BY name")?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        names
            .iter()
            .map(|name| role_info_locked(&conn, name))
            .collect()
    }

    /// Delete a role. Live leases stay revocable (their revocation data is
    /// self-contained only for providers that do not need the role config, so
    /// deletion is refused while the role has live leases).
    pub async fn dynamic_delete_role(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let live: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_leases WHERE role = ?1 AND revoked_at IS NULL",
            params![name],
            |row| row.get(0),
        )?;
        if live > 0 {
            return Err(VaultError::Conflict(format!(
                "role `{name}` has {live} live lease(s); revoke them first"
            ))
            .into());
        }
        let removed = conn.execute(
            "DELETE FROM vault_dynamic_roles WHERE name = ?1",
            params![name],
        )?;
        if removed == 0 {
            return Err(VaultError::NotFound(format!("dynamic role `{name}`")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "dynamic.role.delete", "ok").details(json!({ "role": name })),
        );
        Ok(())
    }

    async fn dynamic_role(&self, name: &str) -> Result<(DynamicRoleInfo, ProviderConfig)> {
        let conn = self.conn.lock().await;
        let info = role_info_locked(&conn, name)?;
        let (nonce, ciphertext, key_version): (Vec<u8>, Vec<u8>, u32) = conn.query_row(
            "SELECT nonce, ciphertext, key_version FROM vault_dynamic_roles WHERE name = ?1",
            params![name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        Ok((info, serde_json::from_slice(&plain)?))
    }

    /// Issue a credential for `role`. `issued_to` is the principal recorded on
    /// the lease (for example `user:<id>` or `machine:<id>`).
    pub async fn dynamic_issue(
        &self,
        role: &str,
        ttl_secs: Option<i64>,
        issued_to: Option<&str>,
        actor: &AuditActor,
    ) -> Result<DynamicCredential> {
        let (info, config) = self.dynamic_role(role).await?;
        let mut ttl = clamp_ttl(ttl_secs, info.default_ttl_secs, info.max_ttl_secs);
        let issued = match &config {
            ProviderConfig::Postgres(config) => postgres::issue(config, role, ttl).await,
            ProviderConfig::AwsSts(config) => aws::issue(config, role, ttl).await,
            ProviderConfig::Webhook(config) => webhook::issue(config, role, ttl).await,
            ProviderConfig::Redis(config) => redis::issue(config, role).await,
            ProviderConfig::Random {
                length,
                charset,
                field,
            } => Ok(Issued {
                data: BTreeMap::from([(
                    field.clone().unwrap_or_else(|| "value".to_owned()),
                    random_generator(*length, *charset).generate(),
                )]),
                revoke_data: Value::Null,
                ttl_cap_secs: None,
            }),
        };
        let issued = match issued {
            Ok(issued) => issued,
            Err(error) => {
                self.audit(
                    &AuditEntry::new(actor, "dynamic.issue", "error")
                        .details(json!({ "role": role, "error": error.to_string() })),
                )
                .await;
                return Err(error);
            }
        };
        if let Some(cap) = issued.ttl_cap_secs {
            ttl = ttl.min(cap.max(1));
        }
        let lease = match self
            .lease_create(
                NewLease {
                    role,
                    provider: config.kind(),
                    issued_to,
                    ttl_secs: ttl,
                    max_ttl_secs: if config.renewable() {
                        info.max_ttl_secs
                    } else {
                        ttl
                    },
                    renewable: config.renewable(),
                    revoke_data: &issued.revoke_data,
                },
                actor,
            )
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                // Without a lease row nothing could ever revoke this
                // credential, so revoke it now with the issuance-time config.
                let cleanup = match &config {
                    ProviderConfig::Postgres(config) => {
                        postgres::revoke(config, &issued.revoke_data).await
                    }
                    ProviderConfig::Webhook(config) => {
                        webhook::revoke(config, role, "", &issued.revoke_data).await
                    }
                    ProviderConfig::Redis(config) => {
                        redis::revoke(config, &issued.revoke_data).await
                    }
                    ProviderConfig::AwsSts(_) | ProviderConfig::Random { .. } => Ok(()),
                };
                let cleanup_error = cleanup.err().map(|error| error.to_string());
                self.audit(
                    &AuditEntry::new(actor, "dynamic.issue", "error").details(json!({
                        "role": role,
                        "error": error.to_string(),
                        "credentialRevoked": cleanup_error.is_none(),
                        "revokeError": cleanup_error,
                    })),
                )
                .await;
                return Err(error);
            }
        };
        Ok(DynamicCredential {
            lease,
            data: issued.data,
        })
    }

    /// Renew a lease, extending the credential at the provider where needed.
    pub async fn dynamic_renew(
        &self,
        lease_id: &str,
        increment_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<LeaseInfo> {
        let (lease, revoke_data) = self.lease_revoke_data(lease_id).await?;
        let increment = increment_secs
            .unwrap_or(DEFAULT_TTL_SECS)
            .clamp(1, MAX_TTL_SECS);
        let now = now_millis();
        if lease.revoked_at.is_some() || lease.expires_at <= now {
            return Err(VaultError::Conflict("the lease has expired or was revoked".into()).into());
        }
        if !lease.renewable {
            return Err(VaultError::Denied("this lease is not renewable".into()).into());
        }
        // Extend the credential upstream first and persist the new expiry only
        // once that succeeds, so a failed renewal never leaves a stored lease
        // that outlives its credential.
        let ttl = ((now + increment * 1000).min(lease.max_expires_at) - now) / 1000;
        if let Ok((_, config)) = self.dynamic_role(&lease.role).await {
            match &config {
                ProviderConfig::Postgres(config) => {
                    postgres::renew(config, &revoke_data, ttl).await?
                }
                ProviderConfig::Webhook(config) => {
                    webhook::renew(config, &lease.role, lease_id, &revoke_data, ttl).await?;
                }
                // Redis users have no expiry; the reaper deletes them.
                ProviderConfig::AwsSts(_)
                | ProviderConfig::Redis(_)
                | ProviderConfig::Random { .. } => {}
            }
        }
        self.lease_extend(lease_id, increment, actor).await
    }

    /// Revoke a lease and delete its credential at the provider. A provider
    /// failure keeps the lease live so the reaper retries it.
    pub async fn dynamic_revoke(&self, lease_id: &str, actor: &AuditActor) -> Result<LeaseInfo> {
        self.dynamic_revoke_for(lease_id, actor, None).await
    }

    /// [`Self::dynamic_revoke`] with a `reason` recorded on the audit row
    /// (`expired` when the reaper ends a lease), which drives the
    /// `lease-expire` vault event.
    async fn dynamic_revoke_for(
        &self,
        lease_id: &str,
        actor: &AuditActor,
        reason: Option<&str>,
    ) -> Result<LeaseInfo> {
        let (lease, revoke_data) = self.lease_revoke_data(lease_id).await?;
        if lease.revoked_at.is_some() {
            return Ok(lease);
        }
        let result = match self.dynamic_role(&lease.role).await {
            Ok((_, ProviderConfig::Postgres(config))) => {
                postgres::revoke(&config, &revoke_data).await
            }
            Ok((_, ProviderConfig::Webhook(config))) => {
                webhook::revoke(&config, &lease.role, lease_id, &revoke_data).await
            }
            Ok((_, ProviderConfig::Redis(config))) => redis::revoke(&config, &revoke_data).await,
            // STS sessions and random values have nothing to delete upstream.
            Ok((_, ProviderConfig::AwsSts(_) | ProviderConfig::Random { .. })) => Ok(()),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            self.audit(
                &AuditEntry::new(actor, "lease.revoke", "error")
                    .details(json!({ "leaseId": lease_id, "error": error.to_string() })),
            )
            .await;
            return Err(error);
        }
        self.lease_mark_revoked_for(lease_id, actor, "ok", reason)
            .await
    }

    /// Revoke every lease of `role` (for example after a suspected leak).
    pub async fn dynamic_revoke_role(&self, role: &str, actor: &AuditActor) -> Result<usize> {
        let mut revoked = 0;
        for lease in self.lease_list(Some(role), false).await? {
            if self.dynamic_revoke(&lease.id, actor).await.is_ok() {
                revoked += 1;
            }
        }
        Ok(revoked)
    }

    /// Revoke expired leases. Returns how many were revoked.
    ///
    /// A lease whose revocation fails is retried with backoff instead of at
    /// the head of the next pass, and a pass stops starting new revocations
    /// once [`REAP_TIME_BUDGET`] is spent, so one unreachable provider can
    /// neither starve other leases nor stall the scheduler tick.
    pub async fn dynamic_reap(&self) -> Result<usize> {
        let actor = AuditActor::system();
        let started = std::time::Instant::now();
        let mut revoked = 0;
        for lease in self.lease_expired(now_millis()).await? {
            if started.elapsed() >= REAP_TIME_BUDGET {
                tracing::warn!("lease reaper time budget spent; resuming next tick");
                break;
            }
            match self
                .dynamic_revoke_for(&lease.id, &actor, Some("expired"))
                .await
            {
                Ok(_) => revoked += 1,
                Err(error) => {
                    tracing::warn!("revoking expired lease {}: {error:#}", lease.id);
                    if let Err(error) = self.lease_defer_revoke(&lease.id, now_millis()).await {
                        tracing::warn!("deferring expired lease {}: {error:#}", lease.id);
                    }
                }
            }
        }
        Ok(revoked)
    }
}

fn role_info_locked(conn: &Connection, name: &str) -> Result<DynamicRoleInfo> {
    conn.query_row(
        "SELECT name, provider, default_ttl_secs, max_ttl_secs, summary, created_at, updated_at
         FROM vault_dynamic_roles WHERE name = ?1",
        params![name],
        |row| {
            Ok(DynamicRoleInfo {
                name: row.get(0)?,
                provider: row.get(1)?,
                default_ttl_secs: row.get(2)?,
                max_ttl_secs: row.get(3)?,
                summary: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or(Value::Null),
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("dynamic role `{name}`")).into())
}

/// Random lowercase-alphanumeric suffix used in generated usernames.
pub(crate) fn random_suffix(len: usize) -> String {
    use rand::Rng;
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn random_role() -> ProviderConfig {
        serde_json::from_value(json!({
            "kind": "random", "length": 24, "charset": "hex", "field": "token"
        }))
        .unwrap()
    }

    #[test]
    fn provider_configs_round_trip_with_a_kind_tag() {
        let config = random_role();
        assert_eq!(
            config,
            ProviderConfig::Random {
                length: 24,
                charset: Charset::Hex,
                field: Some("token".into()),
            }
        );
        let value = serde_json::to_value(&config).unwrap();
        assert_eq!(value["kind"], "random");
    }

    #[tokio::test]
    async fn random_roles_issue_renew_and_revoke() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let role = store
            .dynamic_put_role("ci-token", &random_role(), Some(60), Some(600), &actor)
            .await
            .unwrap();
        assert_eq!(role.provider, "random");
        let issued = store
            .dynamic_issue("ci-token", Some(10_000), Some("user:u1"), &actor)
            .await
            .unwrap();
        assert_eq!(issued.data["token"].len(), 24);
        // The requested TTL is clamped to the role's max.
        assert!(issued.lease.expires_at - issued.lease.created_at <= 600_000);
        store
            .dynamic_renew(&issued.lease.id, Some(30), &actor)
            .await
            .unwrap();
        assert!(store.dynamic_delete_role("ci-token", &actor).await.is_err());
        // TTL edits are allowed under live leases; a provider change is not.
        store
            .dynamic_put_role("ci-token", &random_role(), Some(30), Some(600), &actor)
            .await
            .unwrap();
        let changed = ProviderConfig::Random {
            length: 32,
            charset: Charset::Hex,
            field: Some("token".into()),
        };
        assert!(store
            .dynamic_put_role("ci-token", &changed, Some(60), Some(600), &actor)
            .await
            .is_err());
        let revoked = store
            .dynamic_revoke(&issued.lease.id, &actor)
            .await
            .unwrap();
        assert!(revoked.revoked_at.is_some());
        store.dynamic_delete_role("ci-token", &actor).await.unwrap();
    }

    #[tokio::test]
    async fn fail_closed_withholds_and_revokes_dynamic_credentials() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store
            .dynamic_put_role("ci-token", &random_role(), Some(60), Some(600), &actor)
            .await
            .unwrap();
        crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
        let issued = store
            .dynamic_issue("ci-token", None, Some("user:u1"), &actor)
            .await;
        crate::vault::audit_devices::set_fail_closed_for_test(None);
        assert!(matches!(
            issued.unwrap_err().downcast_ref::<VaultError>(),
            Some(VaultError::AuditUnavailable)
        ));
        // The withheld lease is not left live.
        assert!(store
            .lease_list(Some("ci-token"), false)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn the_reaper_records_expiry_as_lease_expire() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        store
            .dynamic_put_role("short", &random_role(), Some(60), Some(600), &actor)
            .await
            .unwrap();
        let issued = store
            .dynamic_issue("short", None, None, &actor)
            .await
            .unwrap();
        let mut rx = crate::vault::events::subscribe();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_leases SET expires_at = 0 WHERE id = ?1",
                params![issued.lease.id],
            )
            .unwrap();
        }
        assert_eq!(store.dynamic_reap().await.unwrap(), 1);
        loop {
            let event = rx.recv().await.unwrap();
            if event.lease_id.as_deref() == Some(issued.lease.id.as_str()) {
                assert_eq!(event.kind, "lease-expire");
                assert_eq!(event.policy_key(), "sys/dynamic/short");
                break;
            }
        }
    }

    #[tokio::test]
    async fn failing_revocations_do_not_starve_healthy_expired_leases() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        // More failing leases than one reaper page: their role is gone, so
        // every revocation attempt fails.
        for _ in 0..201 {
            store
                .lease_create(
                    NewLease {
                        role: "gone",
                        provider: "random",
                        issued_to: None,
                        ttl_secs: 0,
                        max_ttl_secs: 0,
                        renewable: false,
                        revoke_data: &Value::Null,
                    },
                    &actor,
                )
                .await
                .unwrap();
        }
        store
            .dynamic_put_role("short", &random_role(), Some(60), Some(600), &actor)
            .await
            .unwrap();
        let healthy = store
            .dynamic_issue("short", None, None, &actor)
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_leases SET expires_at = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
                params![healthy.lease.id],
            )
            .unwrap();
        }
        // The first pass fills its page with failing leases and backs them off.
        assert_eq!(store.dynamic_reap().await.unwrap(), 0);
        // The next pass reaches the healthy lease behind them.
        assert_eq!(store.dynamic_reap().await.unwrap(), 1);
        assert!(store
            .lease_get(&healthy.lease.id)
            .await
            .unwrap()
            .revoked_at
            .is_some());
        let conn = store.conn.lock().await;
        let deferred: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM vault_leases
                 WHERE role = 'gone' AND revoke_attempts = 1 AND next_revoke_at > ?1",
                params![now_millis()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(deferred, 201);
    }

    #[tokio::test]
    async fn fresh_expirations_are_reaped_before_due_retries() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        // A full page of failing leases whose backoff has lapsed: they expired
        // earlier than the healthy lease, so they would sort first by expiry.
        for _ in 0..200 {
            store
                .lease_create(
                    NewLease {
                        role: "gone",
                        provider: "random",
                        issued_to: None,
                        ttl_secs: 0,
                        max_ttl_secs: 0,
                        renewable: false,
                        revoke_data: &Value::Null,
                    },
                    &actor,
                )
                .await
                .unwrap();
        }
        store
            .dynamic_put_role("short", &random_role(), Some(60), Some(600), &actor)
            .await
            .unwrap();
        let healthy = store
            .dynamic_issue("short", None, None, &actor)
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_leases SET expires_at = 0, revoke_attempts = 5, next_revoke_at = 0
                 WHERE role = 'gone'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE vault_leases SET expires_at = 1 WHERE id = ?1",
                params![healthy.lease.id],
            )
            .unwrap();
        }
        let due = store.lease_expired(now_millis()).await.unwrap();
        assert_eq!(due.len(), 200);
        assert_eq!(due[0].id, healthy.lease.id);
        // A single pass reaches the never-attempted lease ahead of the retries.
        assert_eq!(store.dynamic_reap().await.unwrap(), 1);
        assert!(store
            .lease_get(&healthy.lease.id)
            .await
            .unwrap()
            .revoked_at
            .is_some());
    }

    #[tokio::test]
    async fn invalid_roles_are_rejected() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        assert!(store
            .dynamic_put_role("Bad Name", &random_role(), None, None, &actor)
            .await
            .is_err());
        let short: ProviderConfig =
            serde_json::from_value(json!({ "kind": "random", "length": 2, "charset": "hex" }))
                .unwrap();
        assert!(store
            .dynamic_put_role("x", &short, None, None, &actor)
            .await
            .is_err());
    }
}
