//! Per-account usage readings: the one place that resolves a provider account,
//! reads its sealed credential, calls the vendor reader, and caches the result
//! under the credential revision it was read with.

use std::{future::Future, time::Instant};

use chrono::{DateTime, Utc};

use super::{
    cache::{self, Cache, Freshness},
    projection, AccountSel, ProviderKind, ProviderUsageReading, ReadingReason, UsageMode,
};
use crate::pi_config::accounts::{AccountInfo, KIND_API_KEY, KIND_OAUTH};

/// Cache key used for readings that belong to no saved account (ACP CLI logins
/// and an API-credit provider's environment key). CLI logins carry no
/// revision; an environment key's revision is its digest ([`key_revision`]).
const UNSCOPED_ACCOUNT: &str = "";
const UNSCOPED_REVISION: &[u8] = b"";

/// Revision for an unscoped credit reading: a digest of the key it was read
/// with, never the key itself.
fn key_revision(key: &str) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    Sha256::digest(key.as_bytes()).to_vec()
}

/// Options for [`read_with`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct ReadOptions<'a> {
    pub mode: UsageMode,
    pub max_age: std::time::Duration,
    /// Keep account-wide windows plus model-scoped windows matching this model.
    pub model: Option<&'a str>,
    /// Owner/consented surfaces only. Agent-visible surfaces leave it `false`.
    pub include_label: bool,
}

/// Read one provider account's usage as a canonical reading, without the
/// account label. See [`read_with`].
pub(crate) async fn read(
    provider_id: &str,
    account: AccountSel<'_>,
    mode: UsageMode,
    max_age: std::time::Duration,
) -> ProviderUsageReading {
    read_with(
        provider_id,
        account,
        ReadOptions {
            mode,
            max_age,
            model: None,
            include_label: false,
        },
    )
    .await
}

/// Read one provider account's usage.
///
/// `Exact` never falls back to the active account; an id that is not a saved
/// account of this provider reads `account_not_found`. Accounts that need
/// sign-in, or whose kind has no reader, never reach the vendor.
pub(crate) async fn read_with(
    provider_id: &str,
    account: AccountSel<'_>,
    options: ReadOptions<'_>,
) -> ProviderUsageReading {
    let Some(kind) = super::provider_kind(provider_id) else {
        return unavailable(provider_id, None, ReadingReason::Unsupported);
    };
    if kind == ProviderKind::AgentLogin {
        return match account {
            AccountSel::Exact(_) => unavailable(provider_id, None, ReadingReason::Unsupported),
            AccountSel::Active => {
                // A CLI login has no revision Core can see, so a `/login` to a
                // different account is invisible to the cache. A refresh read
                // therefore always goes live (single-flighted, then recorded);
                // only cache-only callers may see a reading up to the TTL old.
                let options = if options.mode == UsageMode::Refresh {
                    // Force shares one in-flight read among concurrent callers.
                    ReadOptions {
                        mode: UsageMode::Force,
                        ..options
                    }
                } else {
                    options
                };
                read_unscoped(provider_id, UNSCOPED_REVISION, options, || async {
                    ryu_usage::fetch_usage(provider_id).await
                })
                .await
            }
        };
    }
    let accounts = {
        let provider = provider_id.to_owned();
        super::blocking(move || crate::pi_config::list_provider_accounts(&provider)).await
    };
    let info = match resolve_account(&accounts, account) {
        Resolution::Found(info) => info,
        Resolution::NotFound => {
            return unavailable(provider_id, None, ReadingReason::AccountNotFound);
        }
        Resolution::NoActive if kind == ProviderKind::ApiCredits => {
            // A credit provider may be configured by environment variable with
            // no saved account; that key is the provider's active credential.
            // The key's digest is the revision, so a rotated key never serves
            // the previous key's balance from the cache.
            let key = crate::pi_config::provider_api_key(provider_id).unwrap_or_default();
            let revision = key_revision(&key);
            return read_unscoped(provider_id, &revision, options, || async move {
                credits_snapshot(
                    provider_id,
                    ryu_usage::fetch_provider_credits(provider_id, &key).await,
                )
            })
            .await;
        }
        Resolution::NoActive => {
            return unavailable(provider_id, None, ReadingReason::NotLoggedIn);
        }
    };
    read_info(provider_id, kind, info, options).await
}

/// Read one already-listed saved account. Callers that hold the account list
/// use this instead of [`read_with`] so the vault is not listed again.
pub(crate) async fn read_info(
    provider_id: &str,
    kind: ProviderKind,
    info: &AccountInfo,
    options: ReadOptions<'_>,
) -> ProviderUsageReading {
    let label = options.include_label.then(|| info.label.clone());
    let readable = match kind {
        ProviderKind::Subscription => {
            info.kind == KIND_OAUTH && ryu_usage::supports_account_usage(provider_id)
        }
        ProviderKind::ApiCredits => info.kind == KIND_API_KEY,
        ProviderKind::AgentLogin => false,
    };
    let mut reading = if info.needs_reauth {
        unavailable(
            provider_id,
            Some(&info.account_id),
            ReadingReason::TokenExpired,
        )
    } else if !readable {
        unavailable(
            provider_id,
            Some(&info.account_id),
            ReadingReason::Unsupported,
        )
    } else {
        read_account(
            provider_id,
            &info.account_id,
            options.mode,
            options.max_age,
            options.model,
        )
        .await
        .unwrap_or_else(|| pending(provider_id, &info.account_id))
    };
    reading.account_label = label;
    reading
}

enum Resolution<'a> {
    Found(&'a AccountInfo),
    NotFound,
    NoActive,
}

fn resolve_account<'a>(accounts: &'a [AccountInfo], selection: AccountSel<'_>) -> Resolution<'a> {
    match selection {
        AccountSel::Exact(account_id) => accounts
            .iter()
            .find(|info| info.account_id == account_id)
            .map_or(Resolution::NotFound, Resolution::Found),
        AccountSel::Active => accounts
            .iter()
            .find(|info| info.active)
            .map_or(Resolution::NoActive, Resolution::Found),
    }
}

/// Read one saved account through the revision-keyed cache. `None` means
/// pending: `mode` did not allow a vendor read and nothing fresh is cached.
pub(crate) async fn read_account(
    provider_id: &str,
    account_id: &str,
    mode: UsageMode,
    max_age: std::time::Duration,
    model: Option<&str>,
) -> Option<ProviderUsageReading> {
    if mode == UsageMode::None {
        return None;
    }
    let revision = {
        let (provider, account) = (provider_id.to_owned(), account_id.to_owned());
        super::blocking(move || account_revision(&provider, &account)).await
    };
    let Some(revision) = revision else {
        // No sealed credential: the reader answers locally (not logged in)
        // without vendor I/O, and there is no revision to cache under.
        let snapshot = read_raw(provider_id, account_id).await;
        return Some(to_reading(
            provider_id,
            Some(account_id),
            &snapshot,
            model,
            Utc::now(),
            false,
        ));
    };
    let (snapshot, observed_at, cached) = read_through(
        cache::global(),
        provider_id,
        account_id,
        &revision,
        mode,
        max_age,
        || read_raw(provider_id, account_id),
        || schedule_refresh(provider_id, account_id),
    )
    .await?;
    Some(to_reading(
        provider_id,
        Some(account_id),
        &snapshot,
        model,
        observed_at,
        cached,
    ))
}

/// Cache-first read with single flight per account. `fetch` performs the
/// vendor read and records it; `schedule` starts a background read on a
/// [`UsageMode::Cached`] miss.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn read_through<F, Fut>(
    cache: &Cache,
    provider_id: &str,
    account_id: &str,
    revision: &[u8],
    mode: UsageMode,
    max_age: std::time::Duration,
    fetch: F,
    schedule: impl FnOnce(),
) -> Option<(ryu_usage::UsageSnapshot, DateTime<Utc>, bool)>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ryu_usage::UsageSnapshot>,
{
    let requested_at = Instant::now();
    if mode != UsageMode::Force {
        if let Some(hit) = cache.lookup(
            provider_id,
            account_id,
            revision,
            Freshness::MaxAge(max_age),
        ) {
            return Some((hit.snapshot, hit.observed_at, true));
        }
    }
    match mode {
        UsageMode::None => return None,
        UsageMode::Cached => {
            schedule();
            return None;
        }
        UsageMode::Refresh | UsageMode::Force => {}
    }
    let flight = cache.flight(provider_id, account_id);
    let _in_flight = flight.lock().await;
    // Another caller may have finished the same read while this one waited.
    let freshness = if mode == UsageMode::Force {
        Freshness::StartedAfter(requested_at)
    } else {
        Freshness::MaxAge(max_age)
    };
    if let Some(hit) = cache.lookup(provider_id, account_id, revision, freshness) {
        return Some((hit.snapshot, hit.observed_at, true));
    }
    let snapshot = fetch().await;
    Some((snapshot, Utc::now(), false))
}

/// Start a background read for one account unless one is already running.
pub(crate) fn schedule_refresh(provider_id: &str, account_id: &str) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    // A read that never gets recorded (a straddled rotation, an unreadable
    // revision) would otherwise be rescheduled on every cache-only call.
    if !claim_background_read(provider_id, account_id, Instant::now()) {
        return;
    }
    let provider_id = provider_id.to_owned();
    let account_id = account_id.to_owned();
    runtime.spawn(async move {
        let flight = cache::global().flight(&provider_id, &account_id);
        // A read for this account is already in flight; it will populate the cache.
        let Ok(guard) = flight.try_lock() else {
            return;
        };
        drop(guard);
        read_account(
            &provider_id,
            &account_id,
            UsageMode::Refresh,
            super::DEFAULT_MAX_AGE,
            None,
        )
        .await;
    });
}

/// At most one background read per account per [`cache::ERROR_TTL`].
fn claim_background_read(provider_id: &str, account_id: &str, now: Instant) -> bool {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };
    static LAST: OnceLock<Mutex<HashMap<(String, String), Instant>>> = OnceLock::new();
    let mut last = LAST
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    last.retain(|_, at| now.duration_since(*at) < cache::ERROR_TTL);
    let key = (provider_id.to_owned(), account_id.to_owned());
    if last.contains_key(&key) {
        return false;
    }
    last.insert(key, now);
    true
}

/// Readings that belong to no saved account are cached without a revision.
async fn read_unscoped<F, Fut>(
    provider_id: &str,
    revision: &[u8],
    options: ReadOptions<'_>,
    fetch: F,
) -> ProviderUsageReading
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ryu_usage::UsageSnapshot>,
{
    let cache = cache::global();
    let read = read_through(
        cache,
        provider_id,
        UNSCOPED_ACCOUNT,
        revision,
        options.mode,
        options.max_age,
        || async {
            let started_at = Instant::now();
            let snapshot = fetch().await;
            cache.record(
                provider_id,
                UNSCOPED_ACCOUNT,
                revision,
                started_at,
                &snapshot,
            );
            snapshot
        },
        || schedule_unscoped_refresh(provider_id),
    )
    .await;
    match read {
        Some((snapshot, observed_at, cached)) => to_reading(
            provider_id,
            None,
            &snapshot,
            options.model,
            observed_at,
            cached,
        ),
        None => {
            let mut reading = pending(provider_id, UNSCOPED_ACCOUNT);
            reading.account_id = None;
            reading
        }
    }
}

fn schedule_unscoped_refresh(provider_id: &str) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    if !claim_background_read(provider_id, UNSCOPED_ACCOUNT, Instant::now()) {
        return;
    }
    let provider_id = provider_id.to_owned();
    runtime.spawn(async move {
        read_with(
            &provider_id,
            AccountSel::Active,
            ReadOptions {
                mode: UsageMode::Refresh,
                max_age: super::DEFAULT_MAX_AGE,
                model: None,
                include_label: false,
            },
        )
        .await;
    });
}

/// The sealed credential revision of one saved account, if it has a credential.
fn account_revision(provider_id: &str, account_id: &str) -> Option<Vec<u8>> {
    let scope = crate::pi_config::provider_account_scope(provider_id)?;
    crate::pi_config::accounts::global()?
        .credential_revision(&scope, account_id)
        .ok()
        .flatten()
}

/// Read one saved account from the vendor, uncached, and record the result in
/// both the routing observation map and the reading cache under the credential
/// revision guard. The snapshot is stamped with the provider and account ids.
pub(crate) async fn read_raw(provider_id: &str, account_id: &str) -> ryu_usage::UsageSnapshot {
    match super::provider_kind(provider_id) {
        Some(ProviderKind::Subscription) => {
            read_subscription_account(provider_id, account_id).await
        }
        Some(ProviderKind::ApiCredits) => read_credit_account(provider_id, account_id).await,
        // No saved accounts to resolve: never stamp an id that was not found.
        _ => {
            let mut snapshot =
                ryu_usage::fetch_ryu_provider_usage_for_credential(provider_id, None).await;
            snapshot.provider_id = Some(provider_id.to_owned());
            snapshot
        }
    }
}

fn stamp(
    mut snapshot: ryu_usage::UsageSnapshot,
    provider_id: &str,
    account_id: &str,
) -> ryu_usage::UsageSnapshot {
    snapshot.provider_id = Some(provider_id.to_owned());
    snapshot.account_id = Some(account_id.to_owned());
    snapshot
}

/// Shared by the per-account HTTP meter, the owner snapshot and the throttled
/// OAuth pool warmer. All of them use exactly the same credential-revision guard.
async fn read_subscription_account(
    provider_id: &str,
    account_id: &str,
) -> ryu_usage::UsageSnapshot {
    let read_started_at = Instant::now();
    // Vault accounts are Ryu-owned, so unlike a CLI's own login they may be
    // refreshed here (a no-op while the token is fresh). Without this an account
    // the pool has not routed to lately reads `token_expired` until its next turn.
    // Refresh before capturing the revision so the rotation it persists does not
    // trip the revision guard and discard this reading. A failed refresh falls
    // through to the stored credential, so a dead login still reads expired.
    if crate::pi_config::provider_supports_oauth_refresh(provider_id) {
        if let Err(error) =
            crate::pi_config::subscription_request_credential_for_account(provider_id, account_id)
                .await
        {
            tracing::debug!(provider = %provider_id, error = %error, "usage read could not refresh the saved account; reading the stored credential");
        }
    }
    let revision_before =
        crate::pi_config::subscription_account_credential_revision(provider_id, account_id)
            .ok()
            .flatten();
    let credential = match crate::pi_config::subscription_account_credential(
        provider_id,
        account_id,
    ) {
        Ok(credential) => credential,
        Err(error) => {
            if let Some(revision) = revision_before.as_deref() {
                crate::server::oauth_pool_usage::remove_if_revision(
                    provider_id,
                    account_id,
                    revision,
                    read_started_at,
                );
            }
            tracing::warn!(provider = %provider_id, error = %error, "subscription account usage credential lookup failed");
            let snapshot = stamp(
                credential_lookup_failed_snapshot(provider_id).await,
                provider_id,
                account_id,
            );
            cache::guarded_record(
                cache::global(),
                provider_id,
                account_id,
                revision_before.as_deref(),
                revision_before.as_deref(),
                read_started_at,
                &snapshot,
            );
            return snapshot;
        }
    };
    let snapshot = stamp(
        ryu_usage::fetch_ryu_provider_usage_for_credential(provider_id, credential).await,
        provider_id,
        account_id,
    );
    let revision_after =
        crate::pi_config::subscription_account_credential_revision(provider_id, account_id)
            .ok()
            .flatten();
    if let (Some(before), Some(after)) = (revision_before.as_deref(), revision_after.as_deref()) {
        if before == after {
            crate::server::oauth_pool_usage::record(
                provider_id,
                account_id,
                after,
                read_started_at,
                &snapshot,
            );
        } else {
            crate::server::oauth_pool_usage::remove_if_revision(
                provider_id,
                account_id,
                before,
                read_started_at,
            );
        }
    } else if let Some(before) = revision_before.as_deref() {
        crate::server::oauth_pool_usage::remove_if_revision(
            provider_id,
            account_id,
            before,
            read_started_at,
        );
    }
    cache::guarded_record(
        cache::global(),
        provider_id,
        account_id,
        revision_before.as_deref(),
        revision_after.as_deref(),
        read_started_at,
        &snapshot,
    );
    snapshot
}

async fn credential_lookup_failed_snapshot(provider_id: &str) -> ryu_usage::UsageSnapshot {
    let mut snapshot = ryu_usage::fetch_ryu_provider_usage_for_credential(provider_id, None).await;
    if matches!(
        snapshot.reason,
        Some(ryu_usage::UsageUnavailable::NotLoggedIn)
    ) {
        snapshot.reason = Some(ryu_usage::UsageUnavailable::Error);
    }
    snapshot
}

/// One saved API-key account's prepaid balance. The key is handed to the credit
/// reader for this request only.
async fn read_credit_account(provider_id: &str, account_id: &str) -> ryu_usage::UsageSnapshot {
    let read_started_at = Instant::now();
    let revision_before = account_revision(provider_id, account_id);
    let credits = match crate::pi_config::provider_account_api_key(provider_id, account_id) {
        Ok(key) => ryu_usage::fetch_provider_credits(provider_id, &key).await,
        Err(_) => ryu_usage::fetch_provider_credits(provider_id, "").await,
    };
    let snapshot = stamp(
        credits_snapshot(provider_id, credits),
        provider_id,
        account_id,
    );
    let revision_after = account_revision(provider_id, account_id);
    cache::guarded_record(
        cache::global(),
        provider_id,
        account_id,
        revision_before.as_deref(),
        revision_after.as_deref(),
        read_started_at,
        &snapshot,
    );
    snapshot
}

/// Present a prepaid balance in the common snapshot shape.
fn credits_snapshot(
    provider_id: &str,
    credits: ryu_usage::ProviderCreditsSnapshot,
) -> ryu_usage::UsageSnapshot {
    let engine = if matches!(
        credits.reason,
        Some(ryu_usage::UsageUnavailable::Unsupported)
    ) {
        ""
    } else {
        "api_credits"
    };
    ryu_usage::UsageSnapshot {
        agent_id: provider_id.to_owned(),
        engine: engine.to_owned(),
        available: credits.available,
        reason: credits.reason,
        meters: credits.meters,
        retry_after_seconds: credits.retry_after_seconds,
        ..Default::default()
    }
}

/// Usage for the agent active in chat (`GET /api/agents/:id/usage` and the
/// hook's `{ agent_id }` form). A Ryu subscription provider id reads the
/// vault's active account, stamped with its ids; every other id reads the CLI
/// login the agent itself uses.
pub(crate) async fn agent_reading(agent_id: &str) -> ryu_usage::UsageSnapshot {
    if crate::pi_config::oauth_login::oauth_provider_id(agent_id).is_none() {
        return ryu_usage::fetch_usage(agent_id).await;
    }
    if super::provider_kind(agent_id) == Some(ProviderKind::Subscription) {
        if let Some(active) = crate::pi_config::list_provider_accounts(agent_id)
            .into_iter()
            .find(|info| info.active && info.kind == KIND_OAUTH)
        {
            return read_raw(agent_id, &active.account_id).await;
        }
    }
    if agent_id == crate::pi_config::CHATGPT_PROVIDER_ID {
        // The shared managed-Pi reader below reads the `openai-codex` entry, which
        // is a different provider's login. Read only the native provider's own.
        let credential = crate::pi_config::subscription_active_credential(agent_id)
            .ok()
            .flatten();
        return ryu_usage::fetch_ryu_provider_usage_for_credential(agent_id, credential).await;
    }
    ryu_usage::fetch_ryu_provider_usage(agent_id).await
}

/// Predict which saved account a conversation's next turn will use, without
/// creating or refreshing any binding. `None` when unknown.
///
/// Direct managed SDK providers keep a sealed per-conversation affinity. The
/// Claude proxy binds by session id. The ChatGPT proxy keys on Pi's own session
/// id, which Core cannot map to a conversation, so it is always unknown.
pub(crate) fn peek_account(
    provider_id: &str,
    conversation_id: Option<&str>,
    agent_id: &str,
) -> Option<String> {
    let conversation_id = conversation_id.filter(|id| !id.is_empty())?;
    if provider_id == "claude-pro-max" {
        return crate::server::claude_api::peek_binding(conversation_id);
    }
    if provider_id == crate::pi_config::CHATGPT_PROVIDER_ID {
        return None;
    }
    crate::pi_config::session_accounts::peek(provider_id, Some(conversation_id), agent_id)
        .ok()
        .flatten()
}

fn to_reading(
    provider_id: &str,
    account_id: Option<&str>,
    snapshot: &ryu_usage::UsageSnapshot,
    model: Option<&str>,
    observed_at: DateTime<Utc>,
    cached: bool,
) -> ProviderUsageReading {
    let raw = serde_json::to_value(snapshot).unwrap_or_default();
    let (windows, model_matched) = projection::project_windows(&raw, model);
    ProviderUsageReading {
        provider_id: provider_id.to_owned(),
        account_id: account_id.map(str::to_owned),
        account_label: None,
        agent_id: (!snapshot.agent_id.is_empty()).then(|| snapshot.agent_id.clone()),
        engine: snapshot.engine.clone(),
        available: snapshot.available,
        plan: snapshot.plan.clone(),
        reason: snapshot.reason.map(ReadingReason::from),
        model_matched,
        observed_at: observed_at.to_rfc3339(),
        cached,
        retry_after_seconds: snapshot.retry_after_seconds,
        extra_usage_usd: snapshot.extra_usage_usd,
        windows,
        meters: projection::project_meters(raw.get("meters")),
    }
}

/// Build a canonical reading from a snapshot read elsewhere (for example a
/// CLI login read by the `usage` MCP tool).
pub(crate) fn reading_from_snapshot(
    provider_id: &str,
    account_id: Option<&str>,
    snapshot: &ryu_usage::UsageSnapshot,
    model: Option<&str>,
) -> ProviderUsageReading {
    to_reading(provider_id, account_id, snapshot, model, Utc::now(), false)
}

fn unavailable(
    provider_id: &str,
    account_id: Option<&str>,
    reason: ReadingReason,
) -> ProviderUsageReading {
    ProviderUsageReading {
        provider_id: provider_id.to_owned(),
        account_id: account_id.map(str::to_owned),
        account_label: None,
        agent_id: None,
        engine: String::new(),
        available: false,
        plan: None,
        reason: Some(reason),
        model_matched: None,
        observed_at: Utc::now().to_rfc3339(),
        cached: false,
        retry_after_seconds: None,
        extra_usage_usd: None,
        windows: Vec::new(),
        meters: Vec::new(),
    }
}

fn pending(provider_id: &str, account_id: &str) -> ProviderUsageReading {
    let mut reading = unavailable(provider_id, Some(account_id), ReadingReason::Error);
    reading.reason = None;
    reading
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    use super::*;

    #[test]
    fn background_reads_are_claimed_once_per_error_ttl() {
        let start = Instant::now();
        let provider = "test-claim-provider";
        assert!(claim_background_read(provider, "acct_1", start));
        assert!(!claim_background_read(provider, "acct_1", start));
        assert!(claim_background_read(provider, "acct_2", start));
        assert!(claim_background_read(
            provider,
            "acct_1",
            start + cache::ERROR_TTL
        ));
    }

    fn info(account_id: &str, active: bool) -> AccountInfo {
        AccountInfo {
            account_id: account_id.to_owned(),
            label: account_id.to_owned(),
            kind: KIND_OAUTH.to_owned(),
            active,
            gateway_active: false,
            updated_at: 0,
            needs_reauth: false,
        }
    }

    fn ok_snapshot() -> ryu_usage::UsageSnapshot {
        ryu_usage::UsageSnapshot {
            agent_id: "claude-pro-max".to_owned(),
            engine: "claude".to_owned(),
            available: true,
            windows: vec![ryu_usage::UsageWindow {
                label: "Session".to_owned(),
                used_percent: 25.0,
                resets_at: None,
                window_seconds: Some(18_000),
                model: None,
            }],
            ..Default::default()
        }
    }

    #[test]
    fn exact_unknown_account_is_not_found_and_never_selects_the_active_account() {
        let accounts = vec![info("acct_active", true), info("acct_other", false)];
        assert!(matches!(
            resolve_account(&accounts, AccountSel::Exact("acct_missing")),
            Resolution::NotFound
        ));
        assert!(matches!(
            resolve_account(&accounts, AccountSel::Exact("acct_other")),
            Resolution::Found(found) if found.account_id == "acct_other"
        ));
        assert!(matches!(
            resolve_account(&accounts, AccountSel::Active),
            Resolution::Found(found) if found.account_id == "acct_active"
        ));
        assert!(matches!(
            resolve_account(&[info("acct_other", false)], AccountSel::Active),
            Resolution::NoActive
        ));
    }

    #[tokio::test]
    async fn exact_foreign_account_reads_account_not_found() {
        let reading = read(
            "claude-pro-max",
            AccountSel::Exact("acct_not_saved_anywhere"),
            UsageMode::Refresh,
            super::super::DEFAULT_MAX_AGE,
        )
        .await;
        assert!(!reading.available);
        assert_eq!(reading.reason, Some(ReadingReason::AccountNotFound));
        assert_eq!(reading.account_id, None);
        assert!(reading.windows.is_empty());
    }

    #[tokio::test]
    async fn agent_login_rejects_an_account_and_unknown_provider_is_unsupported() {
        let reading = read(
            "acp:claude",
            AccountSel::Exact("acct_any"),
            UsageMode::Refresh,
            super::super::DEFAULT_MAX_AGE,
        )
        .await;
        assert_eq!(reading.reason, Some(ReadingReason::Unsupported));
        let reading = read(
            "definitely-unknown",
            AccountSel::Active,
            UsageMode::Refresh,
            super::super::DEFAULT_MAX_AGE,
        )
        .await;
        assert_eq!(reading.reason, Some(ReadingReason::Unsupported));
    }

    #[tokio::test]
    async fn cache_hit_makes_no_fetch() {
        let cache = Cache::default();
        cache.record("p", "a", b"rev", Instant::now(), &ok_snapshot());
        let fetches = AtomicUsize::new(0);
        let read = read_through(
            &cache,
            "p",
            "a",
            b"rev",
            UsageMode::Refresh,
            Duration::from_secs(300),
            || async {
                fetches.fetch_add(1, Ordering::SeqCst);
                ok_snapshot()
            },
            || panic!("a hit never schedules"),
        )
        .await
        .expect("cached reading");
        assert!(read.2, "served from cache");
        assert_eq!(fetches.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn cached_mode_miss_is_pending_and_schedules_without_fetching() {
        let cache = Cache::default();
        let scheduled = AtomicUsize::new(0);
        let read = read_through(
            &cache,
            "p",
            "a",
            b"rev",
            UsageMode::Cached,
            Duration::from_secs(300),
            || async { panic!("cached mode never reads the vendor") },
            || {
                scheduled.fetch_add(1, Ordering::SeqCst);
            },
        )
        .await;
        assert!(read.is_none());
        assert_eq!(scheduled.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_reads_of_one_account_share_a_single_fetch() {
        let cache = Arc::new(Cache::default());
        let fetches = Arc::new(AtomicUsize::new(0));
        let reads = (0..8).map(|_| {
            let cache = cache.clone();
            let fetches = fetches.clone();
            tokio::spawn(async move {
                let recorder = cache.clone();
                read_through(
                    &cache,
                    "p",
                    "a",
                    b"rev",
                    UsageMode::Refresh,
                    Duration::from_secs(300),
                    || async move {
                        let started_at = Instant::now();
                        fetches.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        let snapshot = ok_snapshot();
                        recorder.record("p", "a", b"rev", started_at, &snapshot);
                        snapshot
                    },
                    || {},
                )
                .await
            })
        });
        for result in futures_util::future::join_all(reads).await {
            assert!(result.expect("read task").is_some());
        }
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn force_bypasses_a_fresh_cache_entry() {
        let cache = Cache::default();
        cache.record("p", "a", b"rev", Instant::now(), &ok_snapshot());
        let fetches = AtomicUsize::new(0);
        let read = read_through(
            &cache,
            "p",
            "a",
            b"rev",
            UsageMode::Force,
            Duration::from_secs(300),
            || async {
                fetches.fetch_add(1, Ordering::SeqCst);
                ok_snapshot()
            },
            || {},
        )
        .await
        .expect("forced reading");
        assert!(!read.2);
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn vault_read_failure_reports_usage_error_instead_of_missing_login() {
        let snapshot = credential_lookup_failed_snapshot("claude-pro-max").await;
        assert!(!snapshot.available);
        assert!(matches!(
            snapshot.reason,
            Some(ryu_usage::UsageUnavailable::Error)
        ));
        assert!(snapshot.windows.is_empty());
    }

    /// The native ChatGPT provider must read its own `openai-chatgpt` login, never
    /// the separate `openai-codex` provider's entry in the shared Pi auth file.
    #[test]
    fn native_chatgpt_agent_reading_uses_its_own_login() {
        let _guard = crate::pi_config::lock_pi_config_test_env();
        let dir = tempfile::tempdir().expect("temp dir");
        std::env::set_var("RYU_PI_AGENT_DIR", dir.path());
        // An expired JWT so the reader settles locally without a network call.
        let expired = "eyJhbGciOiJub25lIn0.eyJleHAiOjF9.sig";
        let auth = serde_json::json!({
            crate::pi_config::CHATGPT_AUTH_KEY: { "type": "oauth", "access": expired },
        });
        std::fs::write(dir.path().join("auth.json"), auth.to_string()).expect("write auth");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let snapshot = runtime.block_on(agent_reading(crate::pi_config::CHATGPT_PROVIDER_ID));
        std::env::remove_var("RYU_PI_AGENT_DIR");
        assert!(!snapshot.available);
        assert!(matches!(
            snapshot.reason,
            Some(ryu_usage::UsageUnavailable::TokenExpired)
        ));
        assert_eq!(snapshot.engine, "chatgpt");
    }

    #[test]
    fn readings_project_target_ids_and_reasons() {
        let reading =
            reading_from_snapshot("claude-pro-max", Some("acct_active"), &ok_snapshot(), None);
        assert_eq!(reading.windows[0]["targetId"], "window:Session::18000");
        assert_eq!(reading.account_label, None);
        let limited = ryu_usage::UsageSnapshot {
            reason: Some(ryu_usage::UsageUnavailable::RateLimited),
            retry_after_seconds: Some(30),
            ..Default::default()
        };
        let reading = reading_from_snapshot("chatgpt", Some("acct_active"), &limited, None);
        assert_eq!(reading.reason, Some(ReadingReason::RateLimited));
        assert_eq!(reading.retry_after_seconds, Some(30));
        assert!(!reading.is_pending());
        assert!(pending("chatgpt", "acct_active").is_pending());
    }

    #[test]
    fn credit_balances_keep_their_meters() {
        let credits = ryu_usage::ProviderCreditsSnapshot {
            provider_id: "openrouter".to_owned(),
            available: false,
            reason: Some(ryu_usage::UsageUnavailable::NotLoggedIn),
            meters: Vec::new(),
            retry_after_seconds: None,
        };
        let snapshot = credits_snapshot("openrouter", credits);
        assert_eq!(snapshot.engine, "api_credits");
        assert!(matches!(
            snapshot.reason,
            Some(ryu_usage::UsageUnavailable::NotLoggedIn)
        ));
    }
}
