//! Universal subscription primitives: provider → saved accounts → usage.
//!
//! One owner for the question "which subscription logins does this node hold,
//! and how much of each one's limit is left?". Every surface (the owner HTTP
//! routes, the plugin bridge, hooks, the `usage` MCP tools, monitors and
//! routing) reads through this module instead of re-deriving provider lists,
//! account eligibility or usage projection on its own.
//!
//! Disclosure is the caller's decision, never the default: account labels (often
//! email addresses) are emitted only when a query asks for them, and nothing
//! here ever serializes a credential, a credential revision or a token.
//! Readings are cached per credential revision in [`cache`]; the routing
//! observation map in `server::oauth_pool_usage` keeps its own
//! invalidate-on-failure rule.

pub(crate) mod cache;
pub(crate) mod projection;
pub(crate) mod reading;

use std::{future::Future, time::Duration};

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;

use crate::{
    pi_config::accounts::{AccountInfo, KIND_API_KEY, KIND_OAUTH},
    server::oauth_pool_policy::{self, Policy, Strategy},
};

/// The wire version of [`SubscriptionsSnapshot`].
pub(crate) const SNAPSHOT_VERSION: u32 = 1;
/// The default freshness bound for [`UsageMode::Refresh`].
pub(crate) const DEFAULT_MAX_AGE: Duration = cache::READING_TTL;
/// Accounts probed concurrently while building a snapshot.
const PROBE_CONCURRENCY: usize = 4;
/// Upper bound for provider and account ids accepted from callers.
pub(crate) const MAX_ID_CHARS: usize = 256;

/// How a read may touch the vendor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UsageMode {
    /// No usage at all: list providers and accounts only.
    None,
    /// Cache only. A miss reports `pending` and schedules a background read.
    Cached,
    /// A cached reading younger than `max_age`, else one (coalesced) vendor read.
    Refresh,
    /// Always read the vendor. Reserved for the owner HTTP surface.
    Force,
}

impl UsageMode {
    /// Parse the wire spelling used by the HTTP and bridge surfaces.
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "cached" => Some(Self::Cached),
            "refresh" => Some(Self::Refresh),
            "force" => Some(Self::Force),
            _ => None,
        }
    }
}

/// Which saved account a reading targets. `Exact` never falls back to the
/// active account: an unknown or foreign id reads as `account_not_found`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccountSel<'a> {
    Exact(&'a str),
    Active,
}

pub(crate) struct SnapshotQuery {
    pub provider_id: Option<String>,
    pub usage: UsageMode,
    pub include_labels: bool,
    pub max_age: Duration,
    /// Probe only this account; every account is still listed.
    pub only_account: Option<String>,
}

impl Default for SnapshotQuery {
    fn default() -> Self {
        Self {
            provider_id: None,
            usage: UsageMode::Cached,
            include_labels: false,
            max_age: DEFAULT_MAX_AGE,
            only_account: None,
        }
    }
}

/// Run synchronous vault/SQLite/settings I/O off the async workers.
pub(crate) async fn blocking<T, F>(work: F) -> T
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubscriptionsSnapshot {
    pub version: u32,
    pub generated_at: String,
    pub providers: Vec<SubscriptionProvider>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProviderKind {
    /// A Ryu-managed subscription login (Pi OAuth).
    Subscription,
    /// A BYOK provider with a readable prepaid balance.
    ApiCredits,
    /// A vendor CLI login read by an ACP agent (`acp:*`). Never has accounts.
    AgentLogin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccountPinning {
    None,
    /// Direct managed SDK sessions keep a per-conversation account affinity.
    /// `"proxy"` is reserved for future native-proxy pinning.
    Sdk,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderCapabilities {
    /// Saved accounts can each report their own usage.
    pub account_usage: bool,
    /// Saved accounts can each be pinged by warmup.
    pub account_ping: bool,
    pub account_pinning: AccountPinning,
    pub pool_strategies: Vec<Strategy>,
    pub quota_observations: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolPolicySummary {
    pub strategy: Strategy,
    pub drain_threshold_percent: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubscriptionProvider {
    pub provider_id: String,
    pub label: String,
    pub kind: ProviderKind,
    pub managed: bool,
    pub capabilities: ProviderCapabilities,
    pub policy: Option<PoolPolicySummary>,
    pub active_account_id: Option<String>,
    pub accounts: Vec<SubscriptionAccount>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AccountState {
    Ok,
    Pending,
    Unavailable,
    NeedsReauth,
    PoolDisabled,
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubscriptionAccount {
    pub account_id: String,
    /// The saved display name (often an email). `None` unless labels were asked for.
    pub label: Option<String>,
    pub kind: String,
    pub active: bool,
    pub gateway_active: bool,
    pub needs_reauth: bool,
    /// Epoch milliseconds of the account's last write.
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_state: Option<String>,
    pub pool_enabled: bool,
    pub pool_priority: Option<u8>,
    pub state: AccountState,
    pub usage: Option<ProviderUsageReading>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReadingReason {
    Unsupported,
    NotLoggedIn,
    TokenExpired,
    MissingScope,
    NoPlan,
    RateLimited,
    Error,
    AccountNotFound,
}

impl From<ryu_usage::UsageUnavailable> for ReadingReason {
    fn from(reason: ryu_usage::UsageUnavailable) -> Self {
        use ryu_usage::UsageUnavailable as U;
        match reason {
            U::Unsupported => Self::Unsupported,
            U::NotLoggedIn => Self::NotLoggedIn,
            U::TokenExpired => Self::TokenExpired,
            U::MissingScope => Self::MissingScope,
            U::NoPlan => Self::NoPlan,
            U::RateLimited => Self::RateLimited,
            U::Error => Self::Error,
        }
    }
}

/// One canonical, self-describing usage reading.
///
/// A reading with `available: false` and no `reason` is *pending*: nothing is
/// cached yet and the caller chose not to wait for the vendor.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUsageReading {
    pub provider_id: String,
    /// The account that was actually read; `None` when no account was read.
    pub account_id: Option<String>,
    /// Owner/consented surfaces only; always `None` on agent-visible surfaces.
    pub account_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub engine: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<ReadingReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_matched: Option<bool>,
    pub observed_at: String,
    pub cached: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_usage_usd: Option<f64>,
    /// Projected percent windows; see [`projection::project_window`].
    pub windows: Vec<Value>,
    /// Projected non-percent meters; see [`projection::project_meters`].
    pub meters: Vec<Value>,
}

impl ProviderUsageReading {
    /// No reading is cached yet and none was taken.
    pub(crate) fn is_pending(&self) -> bool {
        !self.available && self.reason.is_none()
    }

    /// Drop the account label for agent-visible surfaces.
    pub(crate) fn without_label(mut self) -> Self {
        self.account_label = None;
        self
    }
}

/// The saved accounts' provider kind, or `None` for an id this module does not
/// know (the HTTP reading route answers 404 for those).
pub(crate) fn provider_kind(provider_id: &str) -> Option<ProviderKind> {
    // Any `acp:` id (custom or differently cased) is a CLI login: it must read
    // the CLI's own credential, never fall through to a Ryu-managed account.
    if provider_id
        .trim()
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("acp:"))
    {
        return Some(ProviderKind::AgentLogin);
    }
    if crate::pi_config::provider_meta(provider_id)
        .is_some_and(|meta| meta.auth_kind == "subscription" && meta.credit_pool.is_empty())
    {
        return Some(ProviderKind::Subscription);
    }
    ryu_usage::supports_provider_credits(provider_id).then_some(ProviderKind::ApiCredits)
}

/// What a provider's saved accounts can do. `None` for an unknown provider.
pub(crate) fn provider_capabilities(provider_id: &str) -> Option<ProviderCapabilities> {
    let kind = provider_kind(provider_id)?;
    if kind == ProviderKind::AgentLogin {
        return Some(ProviderCapabilities {
            account_usage: false,
            account_ping: false,
            account_pinning: AccountPinning::None,
            pool_strategies: Vec::new(),
            quota_observations: false,
        });
    }
    let pool = oauth_pool_policy::capabilities(provider_id);
    let pins = crate::pi_config::provider_meta(provider_id).is_some()
        && crate::pi_config::session_accounts::account_auth_key(provider_id).is_some();
    Some(ProviderCapabilities {
        account_usage: match kind {
            ProviderKind::ApiCredits => ryu_usage::supports_provider_credits(provider_id),
            _ => ryu_usage::supports_account_usage(provider_id),
        },
        account_ping: crate::server::account_warmup::supported(provider_id),
        account_pinning: if pins {
            AccountPinning::Sdk
        } else {
            AccountPinning::None
        },
        pool_strategies: pool
            .as_ref()
            .map(|pool| pool.strategies.to_vec())
            .unwrap_or_default(),
        quota_observations: pool.is_some_and(|pool| pool.quota_observations),
    })
}

/// Build the provider → accounts → usage snapshot.
pub(crate) async fn snapshot(query: SnapshotQuery) -> SubscriptionsSnapshot {
    let mut providers = Vec::new();
    for provider_id in provider_ids(query.provider_id.as_deref()) {
        if let Some(provider) = provider_row(&provider_id, &query).await {
            providers.push(provider);
        }
    }
    SubscriptionsSnapshot {
        version: SNAPSHOT_VERSION,
        generated_at: Utc::now().to_rfc3339(),
        providers,
    }
}

/// Providers in display order: managed subscription logins, API-credit
/// providers that hold saved keys, then ACP CLI logins. An explicitly requested
/// known provider is always listed, even with no saved accounts.
fn provider_ids(only: Option<&str>) -> Vec<String> {
    if let Some(provider_id) = only {
        return provider_kind(provider_id)
            .map(|_| vec![provider_id.to_owned()])
            .unwrap_or_default();
    }
    let mut ids: Vec<String> = crate::pi_config::PROVIDERS
        .iter()
        .filter(|meta| provider_kind(meta.id) == Some(ProviderKind::Subscription))
        .map(|meta| meta.id.to_owned())
        .collect();
    for provider_id in ryu_usage::PROVIDERS_WITH_CREDITS {
        // An environment key with no saved account still reads credits, so
        // it is listed too (the reader treats that key as the active one).
        if provider_kind(provider_id) == Some(ProviderKind::ApiCredits)
            && (!crate::pi_config::list_provider_accounts(provider_id).is_empty()
                || crate::pi_config::provider_api_key(provider_id)
                    .is_some_and(|key| !key.is_empty()))
        {
            ids.push((*provider_id).to_owned());
        }
    }
    ids.extend(
        ryu_usage::SUBSCRIPTION_AGENTS
            .iter()
            .map(|agent| (*agent).to_owned()),
    );
    ids
}

fn provider_label(provider_id: &str, kind: ProviderKind) -> String {
    if kind == ProviderKind::AgentLogin {
        return agent_login_label(provider_id).to_owned();
    }
    crate::pi_config::provider_meta(provider_id)
        .map_or_else(|| provider_id.to_owned(), |meta| meta.label.to_owned())
}

/// Product names for the ACP CLI logins (not PII).
pub(crate) fn agent_login_label(provider_id: &str) -> &'static str {
    match provider_id {
        "acp:claude" => "Claude Code",
        "acp:codex" => "Codex",
        "acp:copilot" => "GitHub Copilot",
        "acp:grok" => "Grok",
        "acp:glm" => "GLM / Z.ai",
        "acp:devin" => "Devin",
        "acp:opencode" => "OpenCode",
        "acp:ollama" => "Ollama",
        "acp:cursor" => "Cursor",
        "acp:gemini" => "Gemini",
        _ => "Subscription provider",
    }
}

/// The account kind a provider's usage reader accepts.
fn readable_kind(kind: ProviderKind) -> Option<&'static str> {
    match kind {
        ProviderKind::Subscription => Some(KIND_OAUTH),
        ProviderKind::ApiCredits => Some(KIND_API_KEY),
        ProviderKind::AgentLogin => None,
    }
}

/// The node's saved pool policy for a provider, when it has an account pool.
pub(crate) async fn load_policy(provider_id: &str) -> Option<Policy> {
    if !oauth_pool_policy::supported(provider_id) {
        return None;
    }
    let preferences = match crate::learning::global_state() {
        Some(state) => state.preferences.clone(),
        None => match crate::server::preferences::PreferencesStore::open_default() {
            Ok(preferences) => preferences,
            Err(error) => {
                tracing::warn!(%error, provider_id, "subscription snapshot could not open preferences");
                return Some(Policy::default());
            }
        },
    };
    Some(oauth_pool_policy::load(&preferences, provider_id).await)
}

async fn provider_row(provider_id: &str, query: &SnapshotQuery) -> Option<SubscriptionProvider> {
    let kind = provider_kind(provider_id)?;
    let capabilities = provider_capabilities(provider_id)?;
    let label = provider_label(provider_id, kind);
    let Some(readable) = readable_kind(kind) else {
        return Some(SubscriptionProvider {
            provider_id: provider_id.to_owned(),
            label,
            kind,
            managed: false,
            capabilities,
            policy: None,
            active_account_id: None,
            accounts: Vec::new(),
        });
    };
    let owned_id = provider_id.to_owned();
    let (infos, connection_states) = blocking(move || {
        let infos = crate::pi_config::list_provider_accounts(&owned_id);
        let states = connection_states(&owned_id, &infos);
        (infos, states)
    })
    .await;
    let policy = load_policy(provider_id).await;
    let active_account_id = infos
        .iter()
        .find(|info| info.active)
        .map(|info| info.account_id.clone());
    let mode = query.usage;
    let max_age = query.max_age;
    let mut accounts = build_accounts(
        AccountRowsInput {
            readable_kind: readable,
            account_usage: capabilities.account_usage,
            policy: policy.as_ref(),
            include_labels: query.include_labels,
            mode,
            only_account: query.only_account.as_deref(),
        },
        infos,
        |account_id| async move {
            reading::read_account(provider_id, &account_id, mode, max_age, None).await
        },
    )
    .await;
    for account in &mut accounts {
        account.connection_state = connection_states
            .iter()
            .find(|(id, _)| id == &account.account_id)
            .map(|(_, state)| (*state).to_owned());
    }
    Some(SubscriptionProvider {
        provider_id: provider_id.to_owned(),
        label,
        kind,
        managed: false,
        capabilities,
        policy: policy.map(|policy| PoolPolicySummary {
            strategy: policy.strategy,
            drain_threshold_percent: policy.drain_threshold_percent,
        }),
        active_account_id,
        accounts,
    })
}

/// ChatGPT plan logins report a connection state derived from the sealed
/// credential; only the state string leaves this function.
fn connection_states(provider_id: &str, infos: &[AccountInfo]) -> Vec<(String, &'static str)> {
    if provider_id != crate::pi_config::CHATGPT_PLAN_PROVIDER_ID {
        return Vec::new();
    }
    let vault = crate::pi_config::accounts::global();
    let scope = crate::pi_config::accounts::provider_scope(crate::pi_config::CHATGPT_PLAN_AUTH_KEY);
    infos
        .iter()
        .map(|info| {
            let state = vault
                .and_then(|vault| vault.credential(&scope, &info.account_id).ok())
                .flatten()
                .map_or("unavailable", |value| {
                    crate::pi_config::chatgpt_plan::connection_state(&value)
                });
            (info.account_id.clone(), state)
        })
        .collect()
}

struct AccountRowsInput<'a> {
    readable_kind: &'a str,
    account_usage: bool,
    policy: Option<&'a Policy>,
    include_labels: bool,
    mode: UsageMode,
    only_account: Option<&'a str>,
}

/// The state an account has before any probe, or `None` when it may be probed.
/// Accounts that need sign-in, are disabled in the pool, or have no reader are
/// listed but never sent to the vendor.
fn static_state(info: &AccountInfo, input: &AccountRowsInput<'_>) -> Option<AccountState> {
    if info.needs_reauth {
        return Some(AccountState::NeedsReauth);
    }
    if input
        .policy
        .is_some_and(|policy| !policy.allowed(&info.account_id))
    {
        return Some(AccountState::PoolDisabled);
    }
    if !input.account_usage || info.kind != input.readable_kind {
        return Some(AccountState::Unsupported);
    }
    None
}

async fn build_accounts<F, Fut>(
    input: AccountRowsInput<'_>,
    infos: Vec<AccountInfo>,
    read: F,
) -> Vec<SubscriptionAccount>
where
    F: Fn(String) -> Fut,
    Fut: Future<Output = Option<ProviderUsageReading>>,
{
    let mut probe = Vec::new();
    let mut rows: Vec<SubscriptionAccount> = infos
        .into_iter()
        .enumerate()
        .map(|(index, info)| {
            let state = static_state(&info, &input);
            if state.is_none()
                && input.mode != UsageMode::None
                && input
                    .only_account
                    .is_none_or(|wanted| wanted == info.account_id)
            {
                probe.push(index);
            }
            SubscriptionAccount {
                pool_enabled: input
                    .policy
                    .is_none_or(|policy| policy.allowed(&info.account_id)),
                pool_priority: input.policy.map(|policy| policy.priority(&info.account_id)),
                label: input.include_labels.then_some(info.label),
                account_id: info.account_id,
                kind: info.kind,
                active: info.active,
                gateway_active: info.gateway_active,
                needs_reauth: info.needs_reauth,
                updated_at: info.updated_at,
                connection_state: None,
                state: state.unwrap_or(AccountState::Pending),
                usage: None,
            }
        })
        .collect();
    for batch in probe.chunks(PROBE_CONCURRENCY) {
        let reads = batch
            .iter()
            .map(|index| read(rows[*index].account_id.clone()));
        let readings = futures_util::future::join_all(reads).await;
        for (index, reading) in batch.iter().zip(readings) {
            let row = &mut rows[*index];
            row.state = match &reading {
                Some(reading) if reading.available => AccountState::Ok,
                Some(reading) if reading.is_pending() => AccountState::Pending,
                Some(_) => AccountState::Unavailable,
                None => AccountState::Pending,
            };
            row.usage = reading
                .filter(|reading| !reading.is_pending())
                .map(|mut reading| {
                    reading.account_label = row.label.clone();
                    reading
                });
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use super::*;
    use crate::server::oauth_pool_policy::AccountRule;

    fn info(account_id: &str, kind: &str, needs_reauth: bool) -> AccountInfo {
        AccountInfo {
            account_id: account_id.to_owned(),
            label: format!("{account_id}@example.test"),
            kind: kind.to_owned(),
            active: account_id == "acct_active",
            gateway_active: false,
            updated_at: 1,
            needs_reauth,
        }
    }

    fn reading(account_id: &str, available: bool) -> ProviderUsageReading {
        ProviderUsageReading {
            provider_id: "claude-pro-max".to_owned(),
            account_id: Some(account_id.to_owned()),
            account_label: None,
            agent_id: None,
            engine: "claude".to_owned(),
            available,
            plan: None,
            reason: (!available).then_some(ReadingReason::RateLimited),
            model_matched: None,
            observed_at: "2026-10-14T00:00:00+00:00".to_owned(),
            cached: true,
            retry_after_seconds: None,
            extra_usage_usd: None,
            windows: vec![serde_json::json!({
                "targetId": "window:Session::18000",
                "usedPercent": 10.0,
            })],
            meters: Vec::new(),
        }
    }

    #[test]
    fn any_acp_id_is_an_agent_login() {
        for id in ["acp:claude", "ACP:Claude", "acp:my-claude", " acp:codex"] {
            assert_eq!(provider_kind(id), Some(ProviderKind::AgentLogin), "{id}");
        }
    }

    #[tokio::test]
    async fn reauth_disabled_and_unreadable_accounts_are_listed_but_never_probed() {
        let policy = Policy {
            strategy: Strategy::QuotaFirst,
            accounts: HashMap::from([(
                "acct_disabled".to_owned(),
                AccountRule {
                    enabled: false,
                    priority: 3,
                    drain_threshold_percent: None,
                },
            )]),
            ..Policy::default()
        };
        let probed = Arc::new(Mutex::new(Vec::new()));
        let seen = probed.clone();
        let rows = build_accounts(
            AccountRowsInput {
                readable_kind: KIND_OAUTH,
                account_usage: true,
                policy: Some(&policy),
                include_labels: true,
                mode: UsageMode::Refresh,
                only_account: None,
            },
            vec![
                info("acct_active", KIND_OAUTH, false),
                info("acct_reauth", KIND_OAUTH, true),
                info("acct_disabled", KIND_OAUTH, false),
                info("acct_key", KIND_API_KEY, false),
                info("acct_limited", KIND_OAUTH, false),
            ],
            move |account_id| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push(account_id.clone());
                    Some(reading(&account_id, account_id != "acct_limited"))
                }
            },
        )
        .await;

        assert_eq!(
            *probed.lock().unwrap(),
            vec!["acct_active".to_owned(), "acct_limited".to_owned()]
        );
        let states: Vec<_> = rows.iter().map(|row| row.state).collect();
        assert_eq!(
            states,
            vec![
                AccountState::Ok,
                AccountState::NeedsReauth,
                AccountState::PoolDisabled,
                AccountState::Unsupported,
                AccountState::Unavailable,
            ]
        );
        assert!(!rows[2].pool_enabled);
        assert_eq!(rows[2].pool_priority, Some(3));
        assert_eq!(
            rows[0]
                .usage
                .as_ref()
                .and_then(|usage| usage.account_label.as_deref()),
            Some("acct_active@example.test")
        );
        assert!(rows[1].usage.is_none());
    }

    #[tokio::test]
    async fn only_account_probes_just_that_account_but_lists_all() {
        let probed = Arc::new(Mutex::new(Vec::new()));
        let seen = probed.clone();
        let rows = build_accounts(
            AccountRowsInput {
                readable_kind: KIND_OAUTH,
                account_usage: true,
                policy: None,
                include_labels: false,
                mode: UsageMode::Cached,
                only_account: Some("acct_b"),
            },
            vec![
                info("acct_a", KIND_OAUTH, false),
                info("acct_b", KIND_OAUTH, false),
            ],
            move |account_id| {
                seen.lock().unwrap().push(account_id.clone());
                let reading = reading(&account_id, true);
                async move { Some(reading) }
            },
        )
        .await;
        assert_eq!(rows.len(), 2);
        assert_eq!(*probed.lock().unwrap(), vec!["acct_b".to_owned()]);
        assert_eq!(rows[0].state, AccountState::Pending);
        assert_eq!(rows[1].state, AccountState::Ok);
    }

    #[tokio::test]
    async fn labels_are_omitted_unless_requested_and_none_mode_never_probes() {
        let probes = Arc::new(Mutex::new(0_usize));
        let counter = probes.clone();
        let rows = build_accounts(
            AccountRowsInput {
                readable_kind: KIND_OAUTH,
                account_usage: true,
                policy: None,
                include_labels: false,
                mode: UsageMode::None,
                only_account: None,
            },
            vec![info("acct_active", KIND_OAUTH, false)],
            move |account_id| {
                let counter = counter.clone();
                async move {
                    *counter.lock().unwrap() += 1;
                    Some(reading(&account_id, true))
                }
            },
        )
        .await;
        assert_eq!(*probes.lock().unwrap(), 0);
        assert_eq!(rows[0].label, None);
        assert_eq!(rows[0].state, AccountState::Pending);
        assert!(rows[0].pool_enabled);
        assert_eq!(rows[0].pool_priority, None);
    }

    fn collect_keys(value: &Value, keys: &mut Vec<String>) {
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    keys.push(key.clone());
                    collect_keys(child, keys);
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect_keys(item, keys);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn serialization_never_contains_credential_keys() {
        let mut account_reading = reading("acct_active", true);
        account_reading.account_label = Some("owner@example.test".to_owned());
        let snapshot = SubscriptionsSnapshot {
            version: SNAPSHOT_VERSION,
            generated_at: "2026-10-14T00:00:00+00:00".to_owned(),
            providers: vec![SubscriptionProvider {
                provider_id: "claude-pro-max".to_owned(),
                label: "Claude Pro/Max".to_owned(),
                kind: ProviderKind::Subscription,
                managed: false,
                capabilities: ProviderCapabilities {
                    account_usage: true,
                    account_ping: true,
                    account_pinning: AccountPinning::None,
                    pool_strategies: vec![Strategy::Manual, Strategy::QuotaFirst],
                    quota_observations: true,
                },
                policy: Some(PoolPolicySummary {
                    strategy: Strategy::QuotaFirst,
                    drain_threshold_percent: 80,
                }),
                active_account_id: Some("acct_active".to_owned()),
                accounts: vec![SubscriptionAccount {
                    account_id: "acct_active".to_owned(),
                    label: Some("owner@example.test".to_owned()),
                    kind: KIND_OAUTH.to_owned(),
                    active: true,
                    gateway_active: false,
                    needs_reauth: false,
                    updated_at: 1,
                    connection_state: Some("authorized".to_owned()),
                    pool_enabled: true,
                    pool_priority: Some(0),
                    state: AccountState::Ok,
                    usage: Some(account_reading),
                }],
            }],
        };
        let value = serde_json::to_value(&snapshot).expect("serialize snapshot");
        let mut keys = Vec::new();
        collect_keys(&value, &mut keys);
        for key in &keys {
            let lower = key.to_ascii_lowercase();
            for forbidden in ["credential", "token", "revision", "refresh", "secret"] {
                assert!(
                    !lower.contains(forbidden),
                    "snapshot key '{key}' looks like credential material"
                );
            }
        }
        assert_eq!(
            value["providers"][0]["capabilities"]["accountPinning"],
            "none"
        );
        assert_eq!(value["providers"][0]["policy"]["strategy"], "quota_first");
        assert_eq!(value["providers"][0]["accounts"][0]["state"], "ok");
        assert_eq!(value["providers"][0]["kind"], "subscription");
    }

    #[test]
    fn usage_mode_parses_only_the_wire_spellings() {
        assert_eq!(UsageMode::parse("none"), Some(UsageMode::None));
        assert_eq!(UsageMode::parse("cached"), Some(UsageMode::Cached));
        assert_eq!(UsageMode::parse("refresh"), Some(UsageMode::Refresh));
        assert_eq!(UsageMode::parse("force"), Some(UsageMode::Force));
        assert_eq!(UsageMode::parse("Force"), None);
        assert_eq!(UsageMode::parse(""), None);
    }

    #[test]
    fn capabilities_reflect_readers_warmup_and_pinning() {
        let claude = provider_capabilities("claude-pro-max").expect("claude is known");
        assert!(claude.account_usage);
        assert!(claude.account_ping);
        assert_eq!(claude.account_pinning, AccountPinning::None);
        assert!(claude.quota_observations);

        let copilot = provider_capabilities("github-copilot").expect("copilot is known");
        assert!(copilot.account_usage);
        assert!(!copilot.account_ping);
        assert_eq!(copilot.account_pinning, AccountPinning::Sdk);

        let plan = provider_capabilities("chatgpt-plan").expect("plan is known");
        assert!(!plan.account_usage);

        let agent = provider_capabilities("acp:claude").expect("agent login is known");
        assert!(!agent.account_usage);
        assert!(agent.pool_strategies.is_empty());

        assert_eq!(provider_kind("openrouter"), Some(ProviderKind::ApiCredits));
        assert!(provider_capabilities("anthropic").is_none());
        assert!(provider_kind(crate::pi_config::MANAGED_OPENROUTER_ID).is_none());
        assert!(provider_capabilities("definitely-unknown").is_none());
    }
}
