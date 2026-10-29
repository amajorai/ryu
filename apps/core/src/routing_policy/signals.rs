//! Reading the numbers the fallback rules test — with the caching that makes a
//! per-turn check affordable.
//!
//! The user-facing promise is "check my headroom every time I send a message".
//! Taken literally that is three vendor round-trips per turn, which would be
//! slow, would burn the vendors' own rate limits, and — for the subscription
//! readers — is flatly unsafe: `ryu_usage` never refreshes an OAuth token
//! because those refresh tokens are single-use and refreshing one logs the user
//! out of their coding agent. So the *evaluation* is per turn and the *reads*
//! are cached:
//!
//! | Signal | TTL | Why |
//! |---|---|---|
//! | Subscription windows | 5 min | The same cadence (and the same underlying reader) the desktop's usage bar already polls at. Deliberately NOT shortened. |
//! | BYOK provider credit | 5 min | A prepaid balance moves only as fast as you spend it. |
//! | Ryu $ wallet | 60 s | The Gateway relearns it on every billed call, so a short TTL is cheap and keeps a "$5" rule honest. |
//! | Provider-scoped accounts | the subscriptions cache's TTL | Read cache-only through `crate::subscriptions`; never awaited on the turn path. |
//!
//! ## Cold vs. stale
//!
//! A **stale** entry is served immediately and refreshed in the background
//! (stale-while-revalidate) — a turn is never made to wait on a signal we
//! already have a recent answer for. A **cold** signal (nothing cached at all,
//! i.e. the first turn after boot) is awaited, but under a hard timeout: a
//! vendor endpoint that hangs must cost the turn a bounded pause and then be
//! treated as unknown, and an unknown signal makes its rule abstain rather than
//! fire. Being slow must never become being wrong.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use super::{
    AccountWindows, ProviderAccounts, ProviderScope, RequiredSignals, Signals, WindowReading,
};

/// Subscription windows and BYOK balances: the desktop's existing cadence.
const SLOW_TTL: Duration = Duration::from_secs(5 * 60);
/// The Ryu $ wallet, which the Gateway re-observes on every billed call.
const WALLET_TTL: Duration = Duration::from_secs(60);
/// How long a *cold* read may delay a turn before it is treated as unknown.
const COLD_TIMEOUT: Duration = Duration::from_secs(2);

/// One cached reading.
#[derive(Debug, Clone)]
struct Entry<T> {
    value: T,
    fetched_at: Instant,
}

impl<T> Entry<T> {
    fn is_stale(&self, ttl: Duration) -> bool {
        self.fetched_at.elapsed() >= ttl
    }
}

#[derive(Default)]
struct Cache {
    wallet_usd: RwLock<Option<Entry<Option<f64>>>>,
    provider_usd: RwLock<HashMap<String, Entry<Option<f64>>>>,
    windows: RwLock<HashMap<String, Entry<Vec<WindowReading>>>>,
    /// Keys with a refresh already in flight, so N concurrent turns produce one
    /// vendor call rather than N.
    inflight: RwLock<std::collections::HashSet<String>>,
}

fn cache() -> &'static Arc<Cache> {
    static CACHE: std::sync::OnceLock<Arc<Cache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Arc::new(Cache::default()))
}

/// Drop every cached reading. Used by tests and by the settings write path, so
/// editing a rule re-reads rather than judging against a snapshot taken under
/// the old configuration.
pub fn invalidate_all() {
    let c = cache();
    if let Ok(mut w) = c.wallet_usd.write() {
        *w = None;
    }
    if let Ok(mut p) = c.provider_usd.write() {
        p.clear();
    }
    if let Ok(mut w) = c.windows.write() {
        w.clear();
    }
}

/// Mark a key as being refreshed. Returns false when someone else already is.
fn claim(key: &str) -> bool {
    let c = cache();
    let Ok(mut inflight) = c.inflight.write() else {
        return false;
    };
    inflight.insert(key.to_string())
}

fn release(key: &str) {
    if let Ok(mut inflight) = cache().inflight.write() {
        inflight.remove(key);
    }
}

/// Collect every signal the enabled rules need.
///
/// Returns immediately with whatever is cached and fresh; kicks off background
/// refreshes for stale entries; awaits (briefly) only the genuinely cold ones.
pub async fn collect(required: &RequiredSignals) -> Signals {
    let mut cold: Vec<ColdFetch> = Vec::new();
    let mut signals = Signals::default();

    if required.ryu_credits {
        match read_wallet_cache() {
            Some(value) => signals.ryu_credits_usd = value,
            None => cold.push(ColdFetch::Wallet),
        }
    }
    for provider in &required.providers {
        match read_provider_cache(provider) {
            Some(Some(usd)) => signals.provider_credits_usd.push((provider.clone(), usd)),
            // A cached "this provider exposes no balance" is a real answer; do
            // not re-ask every turn.
            Some(None) => {}
            None => cold.push(ColdFetch::Provider(provider.clone())),
        }
    }
    for agent in &required.agents {
        match read_windows_cache(agent) {
            Some(windows) => signals.subscription_windows.push((agent.clone(), windows)),
            None => cold.push(ColdFetch::Windows(agent.clone())),
        }
    }
    if !required.provider_accounts.is_empty() {
        signals.provider_accounts = collect_provider_accounts(&required.provider_accounts).await;
        signals.pi_provider = Some(crate::pi_config::current().provider);
    }

    if cold.is_empty() {
        return signals;
    }

    // Cold reads run concurrently under ONE shared deadline, so N unknown
    // signals cost one timeout, not N.
    let fetched = tokio::time::timeout(COLD_TIMEOUT, run_cold(cold))
        .await
        .unwrap_or_default();
    for result in fetched {
        match result {
            ColdResult::Wallet(Some(usd)) => signals.ryu_credits_usd = Some(usd),
            ColdResult::Provider(id, Some(usd)) => signals.provider_credits_usd.push((id, usd)),
            ColdResult::Windows(id, windows) if !windows.is_empty() => {
                signals.subscription_windows.push((id, windows));
            }
            _ => {}
        }
    }
    signals
}

enum ColdFetch {
    Wallet,
    Provider(String),
    Windows(String),
}

enum ColdResult {
    Wallet(Option<f64>),
    Provider(String, Option<f64>),
    Windows(String, Vec<WindowReading>),
}

async fn run_cold(fetches: Vec<ColdFetch>) -> Vec<ColdResult> {
    let tasks = fetches.into_iter().map(|fetch| async move {
        match fetch {
            ColdFetch::Wallet => ColdResult::Wallet(fetch_wallet_usd().await),
            ColdFetch::Provider(id) => {
                let usd = fetch_provider_usd(&id).await;
                ColdResult::Provider(id, usd)
            }
            ColdFetch::Windows(id) => {
                let windows = fetch_windows(&id).await;
                ColdResult::Windows(id, windows)
            }
        }
    });
    futures_util::future::join_all(tasks).await
}

/// Read the wallet cache, spawning a background refresh when stale. `None` means
/// cold (caller must fetch); `Some(None)` means "known to be unreadable".
fn read_wallet_cache() -> Option<Option<f64>> {
    let entry = cache().wallet_usd.read().ok()?.clone()?;
    if entry.is_stale(WALLET_TTL) && claim("wallet") {
        tokio::spawn(async {
            fetch_wallet_usd().await;
            release("wallet");
        });
    }
    Some(entry.value)
}

fn read_provider_cache(provider_id: &str) -> Option<Option<f64>> {
    let entry = cache()
        .provider_usd
        .read()
        .ok()?
        .get(provider_id)
        .cloned()?;
    if entry.is_stale(SLOW_TTL) {
        let key = format!("provider:{provider_id}");
        if claim(&key) {
            let provider = provider_id.to_string();
            tokio::spawn(async move {
                fetch_provider_usd(&provider).await;
                release(&key);
            });
        }
    }
    Some(entry.value)
}

fn read_windows_cache(agent_id: &str) -> Option<Vec<WindowReading>> {
    let entry = cache().windows.read().ok()?.get(agent_id).cloned()?;
    if entry.is_stale(SLOW_TTL) {
        let key = format!("windows:{agent_id}");
        if claim(&key) {
            let agent = agent_id.to_string();
            tokio::spawn(async move {
                fetch_windows(&agent).await;
                release(&key);
            });
        }
    }
    Some(entry.value)
}

/// The org's remaining Ryu $ balance, in dollars.
///
/// Core has no control-plane session of its own — the wallet is an org-level,
/// billing-plane fact and the desktop reads it with the user's Better-Auth
/// token. What Core *can* reach is the Gateway, which relearns the authoritative
/// balance on every metered call (its debit hook stores the `balanceMicroUsd`
/// the control plane returns). So the Gateway is the source here: one loopback
/// hop, no new credential, and a number that is exactly as fresh as the last
/// billed request.
async fn fetch_wallet_usd() -> Option<f64> {
    let usd = gateway_wallet_usd().await;
    if let Ok(mut slot) = cache().wallet_usd.write() {
        *slot = Some(Entry {
            value: usd,
            fetched_at: Instant::now(),
        });
    }
    usd
}

async fn gateway_wallet_usd() -> Option<f64> {
    let base = crate::sidecar::gateway::gateway_url();
    let url = format!("{}/v1/wallet", base.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    let mut request = client.get(&url);
    if let Some(token) = crate::sidecar::gateway::gateway_admin_key() {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    // `null` is a real answer meaning "no billed call has resolved a balance on
    // this node yet" — distinct from a transport failure, but both leave the
    // signal unknown, which makes the rule abstain either way.
    let micro = body.get("balance_micro_usd")?.as_i64()?;
    Some(micro as f64 / 1_000_000.0)
}

/// A BYOK provider's prepaid balance, in dollars, or `None` when the provider
/// exposes none / has no stored key / the call failed.
async fn fetch_provider_usd(provider_id: &str) -> Option<f64> {
    let usd = if ryu_usage::supports_provider_credits(provider_id) {
        let key = crate::pi_config::provider_api_key(provider_id).unwrap_or_default();
        let snapshot = ryu_usage::fetch_provider_credits(provider_id, &key).await;
        dollars_in(&snapshot.meters)
    } else {
        None
    };
    if let Ok(mut map) = cache().provider_usd.write() {
        map.insert(
            provider_id.to_string(),
            Entry {
                value: usd,
                fetched_at: Instant::now(),
            },
        );
    }
    usd
}

/// Pull the dollar figure out of a credits snapshot's meter rows. A meter can
/// carry several values (a balance reads as dollars *and* a credit count); the
/// dollar one is the only unit a `below_usd` rule can compare against.
fn dollars_in(meters: &[ryu_usage::UsageMeter]) -> Option<f64> {
    meters.iter().find_map(|meter| {
        meter
            .values
            .iter()
            .find(|v| matches!(v.kind, ryu_usage::UsageValueKind::Dollars))
            .map(|v| v.number)
    })
}

/// An agent's rolling windows. Unavailable snapshots (not logged in, token
/// expired, rate limited) yield an EMPTY list, which reads as "unknown" and
/// makes the rule abstain — the alternative, treating a signed-out agent as
/// having 0% left, would silently reroute every turn.
async fn fetch_windows(agent_id: &str) -> Vec<WindowReading> {
    let snapshot = ryu_usage::fetch_usage(agent_id).await;
    let windows: Vec<WindowReading> = if snapshot.available {
        snapshot
            .windows
            .iter()
            .map(|w| WindowReading {
                label: w.label.clone(),
                model: w.model.clone(),
                used_percent: w.used_percent,
            })
            .collect()
    } else {
        Vec::new()
    };
    if let Ok(mut map) = cache().windows.write() {
        map.insert(
            agent_id.to_string(),
            Entry {
                value: windows.clone(),
                fetched_at: Instant::now(),
            },
        );
    }
    windows
}

/// Per-account windows for provider-scoped rules.
///
/// Unlike the agent windows above, these are never fetched on the turn path:
/// every read is [`UsageMode::Cached`](crate::subscriptions::UsageMode::Cached)
/// against the shared, credential-revision-keyed subscriptions cache. A miss
/// schedules a background read and leaves the account out, so a cold cache
/// makes the rule abstain instead of costing the turn a vendor round-trip.
async fn collect_provider_accounts(scopes: &[ProviderScope]) -> Vec<ProviderAccounts> {
    let mut providers: Vec<ProviderAccounts> = Vec::new();
    for scope in scopes {
        if providers.iter().any(|p| p.provider_id == scope.provider_id) {
            continue;
        }
        let wants_pool = scopes
            .iter()
            .any(|s| s.provider_id == scope.provider_id && s.account_id.is_none());
        let exact: Vec<&str> = scopes
            .iter()
            .filter(|s| s.provider_id == scope.provider_id)
            .filter_map(|s| s.account_id.as_deref())
            .collect();
        let label = crate::pi_config::provider_meta(&scope.provider_id)
            .map_or_else(|| scope.provider_id.clone(), |meta| meta.label.to_owned());
        let Some(kind) = crate::subscriptions::provider_kind(&scope.provider_id) else {
            providers.push(ProviderAccounts {
                provider_id: scope.provider_id.clone(),
                label,
                accounts: Vec::new(),
            });
            continue;
        };
        let policy = crate::subscriptions::load_policy(&scope.provider_id).await;
        let infos = {
            let provider = scope.provider_id.clone();
            crate::subscriptions::blocking(move || {
                crate::pi_config::list_provider_accounts(&provider)
            })
            .await
        };
        let mut accounts = Vec::new();
        for info in infos {
            let eligible = !info.needs_reauth
                && policy
                    .as_ref()
                    .is_none_or(|policy| policy.allowed(&info.account_id));
            let named = exact.contains(&info.account_id.as_str());
            if !named && !(wants_pool && eligible) {
                continue;
            }
            if let Some(windows) = account_windows(&scope.provider_id, kind, &info).await {
                accounts.push(AccountWindows {
                    account_id: info.account_id,
                    eligible,
                    windows,
                });
            }
        }
        providers.push(ProviderAccounts {
            provider_id: scope.provider_id.clone(),
            label,
            accounts,
        });
    }
    providers
}

/// One listed saved account's cached windows, or `None` when nothing usable is
/// cached (pending or unavailable).
async fn account_windows(
    provider_id: &str,
    kind: crate::subscriptions::ProviderKind,
    info: &crate::pi_config::accounts::AccountInfo,
) -> Option<Vec<WindowReading>> {
    let reading = crate::subscriptions::reading::read_info(
        provider_id,
        kind,
        info,
        crate::subscriptions::reading::ReadOptions {
            mode: crate::subscriptions::UsageMode::Cached,
            max_age: crate::subscriptions::DEFAULT_MAX_AGE,
            model: None,
            include_label: false,
        },
    )
    .await;
    if !reading.available {
        return None;
    }
    let windows = windows_from_reading(&reading.windows);
    (!windows.is_empty()).then_some(windows)
}

/// Flatten projected reading windows (`label`, `model`, `usedPercent`).
fn windows_from_reading(windows: &[serde_json::Value]) -> Vec<WindowReading> {
    windows
        .iter()
        .filter_map(|window| {
            Some(WindowReading {
                label: window
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                model: window
                    .get("model")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                used_percent: window
                    .get("usedPercent")
                    .and_then(serde_json::Value::as_f64)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_usage::{UsageMeter, UsageValue, UsageValueKind};

    #[test]
    fn projected_reading_windows_flatten_to_window_readings() {
        let windows = vec![
            serde_json::json!({
                "targetId": "window:Weekly::604800",
                "label": "Weekly",
                "scope": "account",
                "model": null,
                "usedPercent": 62.5,
                "remainingPercent": 37.5,
            }),
            serde_json::json!({
                "label": "Opus",
                "scope": "model",
                "model": "opus",
                "usedPercent": 90.0,
            }),
            // No percent: not a window a threshold can judge.
            serde_json::json!({ "label": "Broken" }),
        ];
        assert_eq!(
            windows_from_reading(&windows),
            vec![
                WindowReading {
                    label: "Weekly".to_string(),
                    model: None,
                    used_percent: 62.5,
                },
                WindowReading {
                    label: "Opus".to_string(),
                    model: Some("opus".to_string()),
                    used_percent: 90.0,
                },
            ]
        );
    }

    #[test]
    fn stale_entry_is_detected_by_ttl() {
        let entry = Entry {
            value: Some(1.0),
            fetched_at: Instant::now() - Duration::from_secs(120),
        };
        assert!(entry.is_stale(WALLET_TTL));
        assert!(!entry.is_stale(SLOW_TTL));
    }

    #[test]
    fn inflight_claim_is_exclusive() {
        invalidate_all();
        let key = "test:exclusive";
        assert!(claim(key));
        assert!(!claim(key));
        release(key);
        assert!(claim(key));
        release(key);
    }

    fn value(number: f64, kind: UsageValueKind, unit: Option<&str>) -> UsageValue {
        UsageValue {
            number,
            kind,
            unit: unit.map(str::to_string),
        }
    }

    fn meter(label: &str, values: Vec<UsageValue>) -> UsageMeter {
        UsageMeter {
            label: label.to_string(),
            values,
            expires_at: Vec::new(),
            resets_at: None,
        }
    }

    #[test]
    fn dollars_are_picked_out_of_a_multi_value_meter() {
        let meters = vec![meter(
            "Credits",
            vec![
                value(1234.0, UsageValueKind::Count, Some("credits")),
                value(12.34, UsageValueKind::Dollars, None),
            ],
        )];
        assert_eq!(dollars_in(&meters), Some(12.34));
    }

    #[test]
    fn a_meter_with_no_dollar_value_yields_no_reading() {
        let meters = vec![meter(
            "Searches",
            vec![value(40.0, UsageValueKind::Count, Some("searches"))],
        )];
        assert_eq!(dollars_in(&meters), None);
    }

    #[tokio::test]
    async fn collecting_nothing_touches_no_signal() {
        invalidate_all();
        let signals = collect(&RequiredSignals::default()).await;
        assert_eq!(signals, Signals::default());
    }
}
