//! Dynamic secrets: short-lived credentials minted on demand.
//!
//! A dynamic role names a provider and its configuration (sealed at rest,
//! since it holds the provider's own admin credential). Issuing against a role
//! creates a fresh credential and a [lease](super::leases); revoking the lease,
//! or letting the scheduler reap it at expiry, deletes the credential at the
//! provider.
//!
//! Providers (configuration in [`providers::ProviderConfig`]):
//!
//! * `postgres`, `mysql` (alias `mariadb`), `mssql`: a login created from
//!   templated statements and dropped on revocation (Postgres renewal extends
//!   `VALID UNTIL`; the others renew as bookkeeping);
//! * `mongodb`: a user per lease (`createUser` / `dropUser`);
//! * `redis` (alias `valkey`): an ACL user per lease (`ACL SETUSER` /
//!   `ACL DELUSER`); renewal is bookkeeping only;
//! * `aws-sts`: `AssumeRole` session credentials (expire on their own, not
//!   renewable);
//! * `aws-iam` - an IAM user with policies, groups, and an access key, deleted
//!   on revocation;
//! * `gcp`: a service-account key (deleted on revocation) or an access token
//!   (expires on its own);
//! * `azure`: an application client secret whose end date is the lease's
//!   expiry, removed on revocation;
//! * `kubernetes`: a service-account token, for an existing account or for a
//!   generated, role-bound account deleted on revocation;
//! * `kubernetes-rules` - a generated Role or ClusterRole holding the role's
//!   RBAC rules, with an account bound to it, all deleted on revocation;
//! * `rabbitmq` - a user per lease with vhost and topic permissions, created
//!   and deleted through the management HTTP API;
//! * `webhook`: delegates issue/renew/revoke to an HTTPS endpoint the operator
//!   runs, signed with an HMAC so the endpoint can trust the caller;
//! * `random`: a generated value with lease bookkeeping only, for systems that
//!   read the credential back from Ryu.
//!
//! The database clients other than Postgres speak their wire protocols
//! directly ([`mysql_wire`], [`mssql_wire`], [`mongo_wire`]), as [`redis`]
//! does, so Core carries no database driver crates.
//!
//! [`static_roles`] rotates existing credentials (database users, Redis ACL
//! users, IAM access keys, webhook-managed API keys) on a schedule instead of
//! minting new ones.

pub mod aws;
pub mod aws_iam;
pub mod azure;
pub mod gcp;
pub(crate) mod http;
pub mod kubernetes;
pub mod kubernetes_rules;
pub(crate) mod mongo_bson;
pub(crate) mod mongo_wire;
pub mod mongodb;
pub mod mssql;
pub(crate) mod mssql_tds;
pub(crate) mod mssql_wire;
pub mod mysql;
pub(crate) mod mysql_wire;
pub(crate) mod naming;
pub mod postgres;
mod providers;
pub mod rabbitmq;
pub mod redis;
mod roles;
pub mod static_roles;
pub mod target_guard;
pub mod username_template;
#[cfg(test)]
mod username_template_tests;
pub mod webhook;

use std::collections::BTreeMap;

use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};

use super::audit::{AuditActor, AuditEntry};
use super::leases::{LeaseInfo, NewLease};
use super::{now_millis, VaultError};
use crate::plugin_secrets::kv::Charset;
use crate::plugin_secrets::{Generator, PluginSecretStore};

pub use providers::ProviderConfig;

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
    /// Retry leases still waiting for their revoke (see `lease_record_for_revoke`).
    pub pending_revoke_leases: i64,
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

pub(crate) use roles::role_version_locked;
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
        let (info, config, version) = self.dynamic_role_versioned(role).await?;
        let mut ttl = clamp_ttl(ttl_secs, info.default_ttl_secs, info.max_ttl_secs);
        let display_name = actor.id.as_deref().unwrap_or(&actor.kind);
        let issued = match config.issue(role, display_name, ttl).await {
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
            .lease_create_for_role_version(
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
                Some(&version),
            )
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                // Without a lease row nothing could ever revoke this
                // credential, so revoke it now with the issuance-time config.
                let cleanup = config.revoke(role, "", &issued.revoke_data).await;
                let cleanup_error = cleanup.err().map(|error| error.to_string());
                // If the provider refused, keep an expired, token-less lease
                // so the reaper retries the revoke instead of forgetting it.
                let retry_lease = match &cleanup_error {
                    None => None,
                    Some(_) => self
                        .lease_record_for_revoke(
                            NewLease {
                                role,
                                provider: config.kind(),
                                issued_to,
                                ttl_secs: 0,
                                max_ttl_secs: 0,
                                renewable: false,
                                revoke_data: &issued.revoke_data,
                            },
                            Some(&version),
                        )
                        .await
                        .map_err(|record| {
                            tracing::warn!("recording an unrevoked {role} credential: {record:#}");
                        })
                        .ok(),
                };
                self.audit(
                    &AuditEntry::new(actor, "dynamic.issue", "error").details(json!({
                        "role": role,
                        "error": error.to_string(),
                        "credentialRevoked": cleanup_error.is_none(),
                        "revokeError": cleanup_error,
                        "retryLeaseId": retry_lease,
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
            config
                .renew(&lease.role, lease_id, &revoke_data, ttl)
                .await?;
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
        let result = match self.revoke_target(&lease.role, lease_id).await {
            Ok(None) => {
                self.audit(
                    &AuditEntry::new(actor, "lease.revoke", "error").details(json!({
                        "leaseId": lease_id, "retryLeaseId": lease_id, "role": lease.role,
                        "reason": "blocked", "code": "retry_lease_role_changed",
                    })),
                )
                .await;
                return Err(VaultError::Conflict(format!(
                    "role `{}` changed after this credential was issued; a configuration manager must rebind it before its revoke is retried",
                    lease.role
                ))
                .into());
            }
            Err(error) => Err(error),
            Ok(Some(config)) => config.revoke(&lease.role, lease_id, &revoke_data).await,
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

    /// The config to revoke `lease_id` through, or `None` when it is a retry
    /// lease that must be refused because its role is no longer the one it
    /// was issued under: a delegated admin may have pointed it at a target of
    /// their own. Only a configuration manager's explicit rebind lifts this: a
    /// save that changes the provider config, or one that confirms the
    /// current config (`rebind_retry_leases`); see
    /// [`Self::dynamic_put_role_with`]. A retry lease recorded before binding
    /// existed (no version) is always refused until such a rebind.
    ///
    /// The version compared is the one read under the same lock as the
    /// returned config, so no save can slip between the check and the target.
    async fn revoke_target(&self, role: &str, lease_id: &str) -> Result<Option<ProviderConfig>> {
        let binding = if self.lease_is_pending_revoke(lease_id).await? {
            Some(self.lease_issued_role_version(lease_id).await?)
        } else {
            None
        };
        #[cfg(test)]
        rebind_race_test::pause_before_role_read(role).await;
        let (_, config, version) = self.dynamic_role_versioned(role).await?;
        let blocked = binding.is_some_and(|issued| issued.as_deref() != Some(version.as_str()));
        Ok((!blocked).then_some(config))
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
            // A retry lease never reached anyone, so its revoke is a cleanup,
            // not an expiry (no `lease-expire` event).
            let reason = match self.lease_is_pending_revoke(&lease.id).await {
                Ok(true) => "cleanup",
                _ => "expired",
            };
            match self
                .dynamic_revoke_for(&lease.id, &actor, Some(reason))
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
#[path = "issue_race_test.rs"]
mod issue_race_test;
#[cfg(test)]
mod rebind_race_test;
#[cfg(test)]
mod rebind_test;
#[cfg(test)]
mod retry_lease_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
#[path = "url_leak_test.rs"]
mod url_leak_test;
