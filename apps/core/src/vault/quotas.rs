//! Request quotas and lease administration (`sys/quotas`, `sys/leases`).
//!
//! Two quota kinds protect the vault from runaway callers:
//!
//! * **rate-limit**: a token bucket per (quota, client address) over every
//!   vault route under a path prefix. A built-in `default-login` quota limits
//!   `/api/vault/auth/*` to `RYU_VAULT_LOGIN_RATE_PER_MIN` requests per minute
//!   per client (default 60; `0` disables it). Over the limit the HTTP layer
//!   answers `429` with `Retry-After` and audits the first rejection of each
//!   run (not every one, so a flood cannot grow the audit log). The built-in
//!   quota applies only to clients with a known address: requests whose
//!   address is unknown (a loopback peer behind a forwarding tunnel) would
//!   otherwise share one bucket that a single caller could drain for
//!   everyone. Configured quotas still apply to them, in one shared
//!   `unknown` bucket per quota.
//! * **lease-count**: a cap on live dynamic-secret leases for roles matching a
//!   glob, checked (and serialized) before a dynamic credential is issued, so
//!   a looping agent cannot mint unbounded database users.
//!
//! Lease administration adds lookup, prefix listing and counting, revoke by
//! prefix, and tidy over [`super::leases`]. A lease's prefix path is
//! `<role>/<lease id>`, so `db/` selects every lease of role `db`.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audit::{AuditActor, AuditEntry};
use super::leases::LeaseInfo;
use super::{now_millis, VaultError};
use crate::plugin_secrets::PluginSecretStore;

/// Env var for the built-in login rate limit (requests per minute per client).
pub const ENV_LOGIN_RATE_PER_MIN: &str = "RYU_VAULT_LOGIN_RATE_PER_MIN";
/// Built-in login rate limit.
pub const DEFAULT_LOGIN_RATE_PER_MIN: u32 = 60;
/// Name of the built-in login quota.
pub const DEFAULT_LOGIN_QUOTA: &str = "default-login";
const API_PREFIX: &str = "/api/vault/";
const MAX_BUCKETS: usize = 10_000;
const CACHE_TTL: Duration = Duration::from_secs(10);
/// Default age of revoked lease rows that tidy deletes (30 days).
pub const DEFAULT_TIDY_AGE_SECS: i64 = 30 * 24 * 3600;

/// One quota rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum QuotaRule {
    #[serde(rename = "rate-limit", rename_all = "camelCase")]
    RateLimit {
        /// Route prefix, relative to `/api/vault/` (`auth/`, `agent/`) or
        /// absolute. Empty means every vault route.
        #[serde(default)]
        path: String,
        /// Requests allowed per interval.
        rate: u32,
        #[serde(default = "default_interval")]
        interval_secs: i64,
        /// Once exceeded, refuse the client for this long.
        #[serde(default)]
        block_interval_secs: Option<i64>,
    },
    #[serde(rename = "lease-count", rename_all = "camelCase")]
    LeaseCount {
        /// Dynamic role glob (`*` = every role).
        role: String,
        max_leases: i64,
    },
}

fn default_interval() -> i64 {
    60
}

/// A named quota.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub name: String,
    #[serde(flatten)]
    pub rule: QuotaRule,
    /// Built-in quotas come from configuration and cannot be edited here.
    pub builtin: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A refused request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotaExceeded {
    pub quota: String,
    pub retry_after_secs: u64,
    pub message: String,
}

impl QuotaRule {
    /// Validate and canonicalize (absolute path prefixes).
    pub fn normalize(self) -> Result<Self> {
        let invalid =
            |message: &str| -> anyhow::Error { VaultError::Invalid(message.into()).into() };
        match self {
            Self::RateLimit {
                path,
                rate,
                interval_secs,
                block_interval_secs,
            } => {
                let trimmed = path.trim().trim_start_matches('/');
                let path = if trimmed.starts_with(API_PREFIX.trim_start_matches('/')) {
                    format!("/{trimmed}")
                } else {
                    format!("{API_PREFIX}{trimmed}")
                };
                if path.contains("..") || path.contains(char::is_whitespace) {
                    return Err(invalid("invalid quota path"));
                }
                if !(1..=100_000).contains(&rate) {
                    return Err(invalid("`rate` must be between 1 and 100000"));
                }
                if !(1..=3600).contains(&interval_secs) {
                    return Err(invalid("`intervalSecs` must be between 1 and 3600"));
                }
                if block_interval_secs.is_some_and(|block| !(1..=86_400).contains(&block)) {
                    return Err(invalid("`blockIntervalSecs` must be between 1 and 86400"));
                }
                Ok(Self::RateLimit {
                    path,
                    rate,
                    interval_secs,
                    block_interval_secs,
                })
            }
            Self::LeaseCount { role, max_leases } => {
                if role.trim().is_empty() || role.len() > 128 {
                    return Err(invalid("`role` must be a role name or glob"));
                }
                if !(1..=1_000_000).contains(&max_leases) {
                    return Err(invalid("`maxLeases` must be between 1 and 1000000"));
                }
                Ok(Self::LeaseCount {
                    role: role.trim().to_owned(),
                    max_leases,
                })
            }
        }
    }
}

/// The built-in login quota, unless disabled with `0`.
pub fn builtin_login_quota() -> Option<Quota> {
    let rate = std::env::var(ENV_LOGIN_RATE_PER_MIN)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(DEFAULT_LOGIN_RATE_PER_MIN);
    (rate > 0).then(|| Quota {
        name: DEFAULT_LOGIN_QUOTA.to_owned(),
        rule: QuotaRule::RateLimit {
            path: format!("{API_PREFIX}auth/"),
            rate,
            interval_secs: 60,
            block_interval_secs: None,
        },
        builtin: true,
        created_at: 0,
        updated_at: 0,
    })
}

/// Create the quota table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_quotas (
             name       TEXT PRIMARY KEY,
             rule       TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );",
    )
    .context("initializing quota schema")
}

fn list_quotas_locked(conn: &Connection) -> Result<Vec<Quota>> {
    let mut stmt =
        conn.prepare("SELECT name, rule, created_at, updated_at FROM vault_quotas ORDER BY name")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;
    let mut quotas = Vec::new();
    for row in rows {
        let (name, rule, created_at, updated_at) = row?;
        match serde_json::from_str(&rule) {
            Ok(rule) => quotas.push(Quota {
                name,
                rule,
                builtin: false,
                created_at,
                updated_at,
            }),
            Err(error) => tracing::warn!("skipping unreadable vault quota {name}: {error}"),
        }
    }
    Ok(quotas)
}

// ── Rate limiting ─────────────────────────────────────────────────────────

struct Bucket {
    tokens: f64,
    updated: Instant,
    blocked_until: Option<Instant>,
    /// Whether the current run of rejections was already reported.
    rejection_reported: bool,
}

/// A rate-limited request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateDenied {
    /// How long until the client may retry.
    pub retry_after: Duration,
    /// The first rejection since the client was last admitted. Only this one
    /// is audited, so a flood cannot grow the audit log.
    pub first: bool,
}

fn deny(bucket: &mut Bucket, retry_after: Duration) -> Result<(), RateDenied> {
    let first = !bucket.rejection_reported;
    bucket.rejection_reported = true;
    Err(RateDenied { retry_after, first })
}

/// Token buckets keyed by (quota, client).
#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<(String, String), Bucket>>,
}

impl RateLimiter {
    /// Take one request from the bucket; `Err` when empty or blocked.
    pub fn check(
        &self,
        quota: &str,
        rule: &QuotaRule,
        client: &str,
        now: Instant,
    ) -> Result<(), RateDenied> {
        let QuotaRule::RateLimit {
            rate,
            interval_secs,
            block_interval_secs,
            ..
        } = rule
        else {
            return Ok(());
        };
        let capacity = f64::from(*rate);
        let per_sec = capacity / (*interval_secs).max(1) as f64;
        let Ok(mut buckets) = self.buckets.lock() else {
            return Ok(());
        };
        if buckets.len() >= MAX_BUCKETS {
            buckets
                .retain(|_, bucket| now.duration_since(bucket.updated) < Duration::from_secs(600));
            if buckets.len() >= MAX_BUCKETS {
                buckets.clear();
            }
        }
        let bucket = buckets
            .entry((quota.to_owned(), client.to_owned()))
            .or_insert(Bucket {
                tokens: capacity,
                updated: now,
                blocked_until: None,
                rejection_reported: false,
            });
        if let Some(until) = bucket.blocked_until {
            if now < until {
                return deny(bucket, until - now);
            }
            bucket.blocked_until = None;
        }
        let elapsed = now.duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * per_sec).min(capacity);
        bucket.updated = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            bucket.rejection_reported = false;
            return Ok(());
        }
        if let Some(block) = block_interval_secs {
            let wait = Duration::from_secs((*block).max(1) as u64);
            bucket.blocked_until = Some(now + wait);
            return deny(bucket, wait);
        }
        let wait = Duration::from_secs_f64(((1.0 - bucket.tokens) / per_sec).max(1.0));
        deny(bucket, wait)
    }
}

/// The process-wide rate limiter.
pub fn limiter() -> &'static RateLimiter {
    static LIMITER: OnceLock<RateLimiter> = OnceLock::new();
    LIMITER.get_or_init(RateLimiter::default)
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

type QuotaCache = Mutex<Option<(Instant, u64, Vec<Quota>)>>;

fn cache() -> &'static QuotaCache {
    static CACHE: OnceLock<QuotaCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Rate-limit quotas whose prefix covers `path`.
///
/// The built-in login quota also covers the Vault-compatible
/// `/v1/auth/<method>/login` routes, so the compat login surface cannot be
/// used to sidestep it.
pub fn rate_quotas_for<'a>(quotas: &'a [Quota], path: &str) -> Vec<&'a Quota> {
    let compat_login = path.starts_with("/v1/auth/") && path.ends_with("/login");
    quotas
        .iter()
        .filter(|quota| match &quota.rule {
            QuotaRule::RateLimit { path: prefix, .. } => {
                path.starts_with(prefix.as_str())
                    || (compat_login && quota.builtin && quota.name == DEFAULT_LOGIN_QUOTA)
            }
            QuotaRule::LeaseCount { .. } => false,
        })
        .collect()
}

/// Lease-count quotas covering `role`.
pub fn lease_quotas_for<'a>(quotas: &'a [Quota], role: &str) -> Vec<&'a Quota> {
    quotas
        .iter()
        .filter(|quota| matches!(&quota.rule, QuotaRule::LeaseCount { role: glob, .. } if super::policy::glob_matches(glob, role)))
        .collect()
}

/// Serializes dynamic issuance under lease-count quotas so the count check
/// and the new lease cannot race.
pub fn issuance_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Lease totals.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseCounts {
    pub total: i64,
    pub by_role: BTreeMap<String, i64>,
}

/// What revoke-prefix did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokePrefixReport {
    pub revoked: usize,
    pub failed: Vec<String>,
}

/// What tidy did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyReport {
    /// Revoked lease rows older than the cutoff that were deleted.
    pub deleted: usize,
    /// Expired leases of deleted roles, marked revoked (nothing left to call).
    pub orphaned: usize,
}

/// Filter for lease listing and counting.
#[derive(Debug, Clone, Default)]
pub struct LeaseFilter<'a> {
    /// Prefix of `<role>/<lease id>`.
    pub prefix: Option<&'a str>,
    pub issued_to: Option<&'a str>,
    pub include_revoked: bool,
}

impl PluginSecretStore {
    /// Every quota: built-in ones first, then stored ones.
    pub async fn quota_list(&self) -> Result<Vec<Quota>> {
        let conn = self.conn.lock().await;
        let mut quotas: Vec<Quota> = builtin_login_quota().into_iter().collect();
        quotas.extend(list_quotas_locked(&conn)?);
        Ok(quotas)
    }

    /// The quotas the HTTP layer enforces, cached briefly.
    pub async fn quota_active(&self) -> Result<Vec<Quota>> {
        let generation = GENERATION.load(Ordering::Acquire);
        if let Ok(guard) = cache().lock() {
            if let Some((loaded, cached_generation, quotas)) = guard.as_ref() {
                if *cached_generation == generation && loaded.elapsed() < CACHE_TTL {
                    return Ok(quotas.clone());
                }
            }
        }
        let quotas = self.quota_list().await?;
        if let Ok(mut guard) = cache().lock() {
            *guard = Some((Instant::now(), generation, quotas.clone()));
        }
        Ok(quotas)
    }

    /// Create or replace a quota.
    pub async fn quota_put(
        &self,
        name: &str,
        rule: QuotaRule,
        actor: &AuditActor,
    ) -> Result<Quota> {
        if !super::transit::is_valid_key_name(name) || name == DEFAULT_LOGIN_QUOTA {
            return Err(VaultError::Invalid("invalid quota name".into()).into());
        }
        let rule = rule.normalize()?;
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_quotas (name, rule, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(name) DO UPDATE SET rule = excluded.rule, updated_at = excluded.updated_at",
            params![name, serde_json::to_string(&rule)?, now],
        )?;
        GENERATION.fetch_add(1, Ordering::AcqRel);
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "quota.put", "ok")
                .details(json!({ "quota": name, "rule": rule })),
        );
        list_quotas_locked(&conn)?
            .into_iter()
            .find(|quota| quota.name == name)
            .ok_or_else(|| VaultError::NotFound(format!("quota `{name}`")).into())
    }

    /// Delete a quota.
    pub async fn quota_delete(&self, name: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let deleted = conn.execute("DELETE FROM vault_quotas WHERE name = ?1", params![name])? > 0;
        GENERATION.fetch_add(1, Ordering::AcqRel);
        self.audit_locked(
            &conn,
            &AuditEntry::new(
                actor,
                "quota.delete",
                if deleted { "ok" } else { "not_found" },
            )
            .details(json!({ "quota": name })),
        );
        Ok(deleted)
    }

    /// Check the lease-count quotas covering `role`.
    pub async fn quota_check_leases(
        &self,
        quotas: &[Quota],
        role: &str,
    ) -> Result<Option<QuotaExceeded>> {
        let applicable = lease_quotas_for(quotas, role);
        if applicable.is_empty() {
            return Ok(None);
        }
        let counts = self.lease_counts(&LeaseFilter::default()).await?.by_role;
        for quota in applicable {
            let QuotaRule::LeaseCount {
                role: glob,
                max_leases,
            } = &quota.rule
            else {
                continue;
            };
            let live: i64 = counts
                .iter()
                .filter(|(name, _)| super::policy::glob_matches(glob, name))
                .map(|(_, count)| count)
                .sum();
            if live >= *max_leases {
                return Ok(Some(QuotaExceeded {
                    quota: quota.name.clone(),
                    retry_after_secs: 60,
                    message: format!(
                        "lease-count quota `{}` allows {max_leases} live leases for `{glob}`",
                        quota.name
                    ),
                }));
            }
        }
        Ok(None)
    }

    /// Leases matching `filter`, newest first (at most 1000).
    pub async fn lease_search(&self, filter: &LeaseFilter<'_>) -> Result<Vec<LeaseInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {} FROM vault_leases
             WHERE (?1 IS NULL OR substr(role || '/' || id, 1, length(?1)) = ?1)
               AND (?2 IS NULL OR issued_to = ?2)
               AND (?3 OR (revoked_at IS NULL AND expires_at > ?4))
             ORDER BY created_at DESC LIMIT 1000",
            super::leases::COLUMNS
        ))?;
        let rows = stmt.query_map(
            params![
                filter.prefix,
                filter.issued_to,
                filter.include_revoked,
                now_millis()
            ],
            super::leases::lease_from_row,
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Live lease counts matching `filter` (revoked leases are never counted).
    pub async fn lease_counts(&self, filter: &LeaseFilter<'_>) -> Result<LeaseCounts> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT role, COUNT(*) FROM vault_leases
             WHERE revoked_at IS NULL AND expires_at > ?3
               AND (?1 IS NULL OR substr(role || '/' || id, 1, length(?1)) = ?1)
               AND (?2 IS NULL OR issued_to = ?2)
             GROUP BY role",
        )?;
        let rows = stmt.query_map(
            params![filter.prefix, filter.issued_to, now_millis()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        let mut counts = LeaseCounts::default();
        for row in rows {
            let (role, count) = row?;
            counts.total += count;
            counts.by_role.insert(role, count);
        }
        Ok(counts)
    }

    /// Revoke every live lease under `prefix` at its provider.
    pub async fn lease_revoke_prefix(
        &self,
        prefix: &str,
        actor: &AuditActor,
    ) -> Result<RevokePrefixReport> {
        if prefix.trim().is_empty() {
            return Err(VaultError::Invalid("a non-empty prefix is required".into()).into());
        }
        // Every live lease under the prefix, not the capped search page, so
        // a compromise response never leaves leases silently behind.
        let ids: Vec<String> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id FROM vault_leases
                 WHERE substr(role || '/' || id, 1, length(?1)) = ?1
                   AND revoked_at IS NULL AND expires_at > ?2
                 ORDER BY created_at",
            )?;
            let rows = stmt.query_map(params![prefix, now_millis()], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut report = RevokePrefixReport::default();
        for id in ids {
            match self.dynamic_revoke(&id, actor).await {
                Ok(_) => report.revoked += 1,
                Err(_) => report.failed.push(id),
            }
        }
        self.audit(
            &AuditEntry::new(
                actor,
                "lease.revoke_prefix",
                if report.failed.is_empty() {
                    "ok"
                } else {
                    "error"
                },
            )
            .details(
                json!({ "prefix": prefix, "revoked": report.revoked, "failed": report.failed }),
            ),
        )
        .await;
        Ok(report)
    }

    /// Delete revoked lease rows older than `older_than_secs` and close out
    /// expired leases whose role no longer exists.
    pub async fn lease_tidy(
        &self,
        older_than_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<TidyReport> {
        let now = now_millis();
        let cutoff = now - older_than_secs.unwrap_or(DEFAULT_TIDY_AGE_SECS).max(0) * 1000;
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let deleted = tx.execute(
            "DELETE FROM vault_leases WHERE revoked_at IS NOT NULL AND revoked_at < ?1",
            params![cutoff],
        )?;
        let orphaned = tx.execute(
            "UPDATE vault_leases SET revoked_at = ?1
             WHERE revoked_at IS NULL AND expires_at <= ?1
               AND role NOT IN (SELECT name FROM vault_dynamic_roles)",
            params![now],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "lease.tidy", "ok")
                .details(json!({ "deleted": deleted, "orphaned": orphaned })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(TidyReport { deleted, orphaned })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::leases::NewLease;

    fn rate(rate: u32, interval_secs: i64, block: Option<i64>) -> QuotaRule {
        QuotaRule::RateLimit {
            path: "auth/".into(),
            rate,
            interval_secs,
            block_interval_secs: block,
        }
    }

    #[test]
    fn rate_limits_refill_and_block() {
        let limiter = RateLimiter::default();
        let rule = rate(2, 60, None);
        let start = Instant::now();
        assert!(limiter.check("q", &rule, "1.1.1.1", start).is_ok());
        assert!(limiter.check("q", &rule, "1.1.1.1", start).is_ok());
        let retry = limiter.check("q", &rule, "1.1.1.1", start).unwrap_err();
        assert!(retry.retry_after >= Duration::from_secs(1));
        assert!(retry.first);
        // Later rejections in the same run are not reported again.
        assert!(
            !limiter
                .check("q", &rule, "1.1.1.1", start)
                .unwrap_err()
                .first
        );
        // Other clients have their own bucket.
        assert!(limiter.check("q", &rule, "2.2.2.2", start).is_ok());
        // Thirty seconds refill one request at 2/minute.
        assert!(limiter
            .check("q", &rule, "1.1.1.1", start + Duration::from_secs(31))
            .is_ok());
        let blocking = rate(1, 60, Some(300));
        assert!(limiter.check("b", &blocking, "c", start).is_ok());
        assert_eq!(
            limiter
                .check("b", &blocking, "c", start)
                .unwrap_err()
                .retry_after,
            Duration::from_secs(300)
        );
        // Blocked even after the bucket would have refilled.
        assert!(limiter
            .check("b", &blocking, "c", start + Duration::from_secs(120))
            .is_err());
    }

    #[test]
    fn quota_rules_normalize_paths_and_ranges() {
        let QuotaRule::RateLimit { path, .. } = rate(5, 60, None).normalize().unwrap() else {
            panic!("rate")
        };
        assert_eq!(path, "/api/vault/auth/");
        let QuotaRule::RateLimit { path, .. } = QuotaRule::RateLimit {
            path: "/api/vault/agent/".into(),
            rate: 1,
            interval_secs: 1,
            block_interval_secs: None,
        }
        .normalize()
        .unwrap() else {
            panic!("rate")
        };
        assert_eq!(path, "/api/vault/agent/");
        assert!(rate(0, 60, None).normalize().is_err());
        assert!(rate(1, 0, None).normalize().is_err());
        assert!(QuotaRule::LeaseCount {
            role: "db".into(),
            max_leases: 0
        }
        .normalize()
        .is_err());
        let quotas = vec![Quota {
            name: "q".into(),
            rule: rate(5, 60, None).normalize().unwrap(),
            builtin: false,
            created_at: 0,
            updated_at: 0,
        }];
        assert_eq!(
            rate_quotas_for(&quotas, "/api/vault/auth/approle/login").len(),
            1
        );
        assert!(rate_quotas_for(&quotas, "/api/vault/agent/self").is_empty());
        // An operator quota on `auth/` does not silently extend to `/v1`.
        assert!(rate_quotas_for(&quotas, "/v1/auth/approle/login").is_empty());
    }

    #[test]
    fn builtin_login_quota_covers_every_login_surface() {
        let quotas = vec![Quota {
            name: DEFAULT_LOGIN_QUOTA.into(),
            rule: QuotaRule::RateLimit {
                path: format!("{API_PREFIX}auth/"),
                rate: 60,
                interval_secs: 60,
                block_interval_secs: None,
            },
            builtin: true,
            created_at: 0,
            updated_at: 0,
        }];
        for path in [
            "/api/vault/auth/approle/login",
            "/api/vault/auth/kubernetes/login",
            "/api/vault/auth/cert/login",
            "/v1/auth/approle/login",
            "/v1/auth/jwt/login",
        ] {
            assert_eq!(rate_quotas_for(&quotas, path).len(), 1, "{path}");
        }
        for path in ["/v1/auth/token/lookup-self", "/v1/secret/data/app"] {
            assert!(rate_quotas_for(&quotas, path).is_empty(), "{path}");
        }
    }

    async fn lease(store: &PluginSecretStore, role: &str, issued_to: &str) -> LeaseInfo {
        store
            .lease_create(
                NewLease {
                    role,
                    provider: "random",
                    issued_to: Some(issued_to),
                    ttl_secs: 600,
                    max_ttl_secs: 600,
                    renewable: true,
                    revoke_data: &serde_json::Value::Null,
                },
                &AuditActor::system(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn lease_count_quotas_cap_matching_roles() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let quota = store
            .quota_put(
                "db-cap",
                QuotaRule::LeaseCount {
                    role: "db-*".into(),
                    max_leases: 2,
                },
                &actor,
            )
            .await
            .unwrap();
        assert!(store
            .quota_put("default-login", rate(1, 1, None), &actor)
            .await
            .is_err());
        let quotas = vec![quota];
        lease(&store, "db-a", "machine:m").await;
        assert!(store
            .quota_check_leases(&quotas, "db-b")
            .await
            .unwrap()
            .is_none());
        lease(&store, "db-b", "machine:m").await;
        let exceeded = store
            .quota_check_leases(&quotas, "db-c")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exceeded.quota, "db-cap");
        // Other roles are unaffected.
        assert!(store
            .quota_check_leases(&quotas, "cache")
            .await
            .unwrap()
            .is_none());
        assert!(store.quota_delete("db-cap", &actor).await.unwrap());
        assert!(store
            .quota_list()
            .await
            .unwrap()
            .iter()
            .all(|quota| quota.builtin));
    }

    #[tokio::test]
    async fn leases_list_count_revoke_by_prefix_and_tidy() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let first = lease(&store, "db", "machine:a").await;
        lease(&store, "db", "machine:b").await;
        lease(&store, "cache", "machine:a").await;
        let by_prefix = store
            .lease_search(&LeaseFilter {
                prefix: Some("db/"),
                ..LeaseFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(by_prefix.len(), 2);
        let exact = format!("db/{}", first.id);
        assert_eq!(
            store
                .lease_search(&LeaseFilter {
                    prefix: Some(&exact),
                    ..LeaseFilter::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
        let counts = store
            .lease_counts(&LeaseFilter {
                issued_to: Some("machine:a"),
                ..LeaseFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(counts.total, 2);
        assert_eq!(counts.by_role.get("cache"), Some(&1));
        assert!(store.lease_revoke_prefix("", &actor).await.is_err());
        // More than one search page (1000) of live leases is all attempted.
        for _ in 0..1001 {
            lease(&store, "bulk", "machine:c").await;
        }
        let bulk = store.lease_revoke_prefix("bulk/", &actor).await.unwrap();
        assert_eq!(bulk.revoked + bulk.failed.len(), 1001);
        {
            let conn = store.conn.lock().await;
            conn.execute("DELETE FROM vault_leases WHERE role = 'bulk'", [])
                .unwrap();
        }
        // The `db` role does not exist, so provider revocation fails and the
        // leases stay live for the reaper.
        let report = store.lease_revoke_prefix("db/", &actor).await.unwrap();
        assert_eq!(report.revoked, 0);
        assert_eq!(report.failed.len(), 2);
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_leases SET expires_at = 1 WHERE role = 'db'",
                [],
            )
            .unwrap();
        }
        let tidy = store.lease_tidy(None, &actor).await.unwrap();
        assert_eq!(tidy.orphaned, 2);
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_leases SET revoked_at = 1 WHERE role = 'db'",
                [],
            )
            .unwrap();
        }
        let tidy = store.lease_tidy(None, &actor).await.unwrap();
        assert_eq!(tidy.deleted, 2);
        let all = store
            .lease_search(&LeaseFilter {
                include_revoked: true,
                ..LeaseFilter::default()
            })
            .await
            .unwrap();
        assert_eq!(all.len(), 1);
    }
}
