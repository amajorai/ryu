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
mod roles;
pub mod static_roles;
pub mod target_guard;
pub mod webhook;

use std::collections::BTreeMap;

use anyhow::Result;
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

pub use roles::{init_schema, is_valid_role_name};

fn clamp_ttl(requested: Option<i64>, default: i64, max: i64) -> i64 {
    requested.unwrap_or(default).clamp(1, max.max(1))
}

impl PluginSecretStore {
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
mod tests;
