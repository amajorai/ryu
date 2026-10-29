//! Short-lived, credential-scoped subscription usage observations for the
//! native and supported SDK OAuth account pools. This holds normalized percentages only; neither
//! access nor refresh tokens enter the routing cache.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use super::oauth_pool_policy::{Policy, Strategy};

const OBSERVATION_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_OBSERVATIONS: usize = 1_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub windows: Vec<WindowObservation>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowObservation {
    pub used_percent: f64,
    pub reset_at: Option<chrono::DateTime<chrono::Utc>>,
    pub window_seconds: Option<i64>,
}

impl Observation {
    pub fn highest_used_percent(&self) -> f64 {
        self.windows
            .iter()
            .map(|window| window.used_percent)
            .fold(0.0, f64::max)
    }
}

/// The account id and sealed credential revision supplied by the vault. The
/// revision is used only to reject usage observed for a prior login.
pub struct Candidate<'a> {
    pub account_id: &'a str,
    pub revision: &'a [u8],
}

#[derive(Default)]
pub struct PoolCursor {
    round_robin: usize,
    fill_account: Option<String>,
}

impl PoolCursor {
    /// Choose only a new or released session. Callers must check healthy
    /// session bindings before invoking this method.
    pub fn select(
        &mut self,
        provider_id: &str,
        candidates: &[Candidate<'_>],
        active: &str,
        policy: &Policy,
    ) -> Option<usize> {
        self.select_with(candidates, active, policy, |candidate| {
            get(provider_id, candidate.account_id, candidate.revision)
        })
    }

    fn select_with(
        &mut self,
        candidates: &[Candidate<'_>],
        active: &str,
        policy: &Policy,
        mut observe: impl FnMut(&Candidate<'_>) -> Option<Observation>,
    ) -> Option<usize> {
        let available: Vec<usize> = candidates
            .iter()
            .enumerate()
            .filter(|(_, candidate)| policy.allowed(candidate.account_id))
            .map(|(index, _)| index)
            .collect();
        if available.is_empty() {
            return None;
        }
        if policy.strategy == Strategy::Manual {
            return available
                .iter()
                .copied()
                .find(|index| candidates[*index].account_id == active)
                .or_else(|| available.first().copied());
        }
        let observations: Vec<_> = candidates
            .iter()
            .map(|candidate| {
                (policy.strategy != Strategy::RoundRobin)
                    .then(|| observe(candidate))
                    .flatten()
            })
            .collect();
        let has_headroom = available.iter().any(|index| {
            observations[*index].as_ref().is_some_and(|usage| {
                usage.highest_used_percent()
                    < selection_drain_limit(policy, candidates[*index].account_id)
            })
        });
        let drained: Vec<bool> = candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| {
                has_headroom
                    && observations[index].as_ref().is_some_and(|usage| {
                        usage.highest_used_percent()
                            >= selection_drain_limit(policy, candidate.account_id)
                    })
            })
            .collect();
        let deferred: Vec<bool> = candidates
            .iter()
            .enumerate()
            .map(|(index, candidate)| {
                drained[index]
                    && available.iter().all(|member| {
                        policy.priority(candidates[*member].account_id)
                            != policy.priority(candidate.account_id)
                            || drained[*member]
                    })
            })
            .collect();
        let priority = available
            .iter()
            .filter(|index| !deferred[**index])
            .map(|index| policy.priority(candidates[*index].account_id))
            .min()?;
        let group: Vec<usize> = available
            .into_iter()
            .filter(|index| {
                !deferred[*index] && policy.priority(candidates[*index].account_id) == priority
            })
            .collect();
        match policy.strategy {
            Strategy::Manual => unreachable!(),
            Strategy::RoundRobin => Some(self.next_round_robin(&group)),
            Strategy::QuotaFirst => {
                let ranked: Vec<_> = group
                    .iter()
                    .filter_map(|index| {
                        let usage = observations[*index].as_ref()?;
                        let used = usage.highest_used_percent();
                        (used < 100.0).then_some((*index, used))
                    })
                    .collect();
                let best_used = ranked.iter().map(|(_, used)| *used).min_by(f64::total_cmp);
                let best: Vec<_> = ranked
                    .iter()
                    .filter(|(_, used)| Some(*used) == best_used)
                    .map(|(index, _)| *index)
                    .collect();
                Some(if best.len() == 1 {
                    best[0]
                } else {
                    self.next_round_robin(if best.is_empty() { &group } else { &best })
                })
            }
            Strategy::FillFirst => {
                if let Some(current) = self.fill_account.as_deref() {
                    if let Some(index) = group
                        .iter()
                        .copied()
                        .find(|index| candidates[*index].account_id == current)
                    {
                        let used = observations[index]
                            .as_ref()
                            .map(|usage| usage.highest_used_percent());
                        // Unknown usage does not assert free quota, and cannot
                        // by itself prove this account should be drained.
                        if used.is_none_or(|used| {
                            used < selection_drain_limit(policy, candidates[index].account_id)
                        }) {
                            return Some(index);
                        }
                    }
                }
                let next = group
                    .iter()
                    .filter_map(|index| {
                        let used = observations[*index].as_ref()?.highest_used_percent();
                        (used < selection_drain_limit(policy, candidates[*index].account_id))
                            .then_some((*index, used))
                    })
                    .max_by(|left, right| left.1.total_cmp(&right.1))
                    .map_or_else(|| self.next_round_robin(&group), |(index, _)| index);
                self.fill_account = Some(candidates[next].account_id.to_owned());
                Some(next)
            }
            Strategy::ResetFirst => {
                let now = chrono::Utc::now();
                let ranked: Vec<_> = group
                    .iter()
                    .filter_map(|index| {
                        let usage = observations[*index].as_ref()?;
                        if usage.highest_used_percent() >= 100.0 {
                            return None;
                        }
                        let reset = usage
                            .windows
                            .iter()
                            .filter_map(|window| window.reset_at)
                            .filter(|reset| *reset > now)
                            .min()?;
                        Some((*index, reset))
                    })
                    .collect();
                let earliest_reset = ranked.iter().map(|(_, reset)| *reset).min();
                let best: Vec<_> = ranked
                    .iter()
                    .filter(|(_, reset)| Some(*reset) == earliest_reset)
                    .map(|(index, _)| *index)
                    .collect();
                Some(if best.len() == 1 {
                    best[0]
                } else {
                    self.next_round_robin(if best.is_empty() { &group } else { &best })
                })
            }
        }
    }

    fn next_round_robin(&mut self, group: &[usize]) -> usize {
        let index = group[self.round_robin % group.len()];
        self.round_robin = self.round_robin.wrapping_add(1);
        index
    }
}

fn selection_drain_limit(policy: &Policy, account_id: &str) -> f64 {
    let threshold = if policy.strategy == Strategy::FillFirst {
        policy.drain_threshold(account_id)
    } else {
        policy
            .accounts
            .get(account_id)
            .and_then(|rule| rule.drain_threshold_percent)
            .unwrap_or(100)
    };
    match threshold {
        0 => 100.0,
        percent => f64::from(percent),
    }
}

struct Entry {
    revision: Vec<u8>,
    read_started_at: Instant,
    observed_at: Instant,
    observation: Observation,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<(String, String), Entry>,
}

impl Cache {
    #[cfg(test)]
    fn record(
        &mut self,
        provider_id: &str,
        account_id: &str,
        revision: &[u8],
        snapshot: &ryu_usage::UsageSnapshot,
    ) {
        self.record_started(provider_id, account_id, revision, Instant::now(), snapshot);
    }

    fn record_started(
        &mut self,
        provider_id: &str,
        account_id: &str,
        revision: &[u8],
        started_at: Instant,
        snapshot: &ryu_usage::UsageSnapshot,
    ) {
        let key = (provider_id.to_owned(), account_id.to_owned());
        // Compare request order, not completion order. An older vendor read
        // can finish after a newer read starts, and either can finish first.
        if self
            .entries
            .get(&key)
            .is_some_and(|entry| entry.read_started_at > started_at)
        {
            return;
        }
        // A failed or unparseable reading invalidates the old observation. It
        // must never look like zero use or silently keep a stale favorable rank.
        let Some(observation) = normalize(snapshot) else {
            self.remove_if_revision(provider_id, account_id, revision, started_at);
            return;
        };
        let now = Instant::now();
        self.entries
            .retain(|_, entry| now.duration_since(entry.observed_at) < OBSERVATION_TTL);
        if self.entries.len() >= MAX_OBSERVATIONS {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.observed_at)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            key,
            Entry {
                revision: revision.to_vec(),
                read_started_at: started_at,
                observed_at: now,
                observation,
            },
        );
    }

    fn get(&mut self, provider_id: &str, account_id: &str, revision: &[u8]) -> Option<Observation> {
        let key = (provider_id.to_owned(), account_id.to_owned());
        let entry = self.entries.get(&key)?;
        if entry.revision != revision {
            return None;
        }
        if entry.observed_at.elapsed() >= OBSERVATION_TTL {
            self.entries.remove(&key);
            return None;
        }
        Some(entry.observation.clone())
    }

    fn remove_if_revision(
        &mut self,
        provider_id: &str,
        account_id: &str,
        revision: &[u8],
        started_at: Instant,
    ) {
        let key = (provider_id.to_owned(), account_id.to_owned());
        if self
            .entries
            .get(&key)
            .is_some_and(|entry| entry.revision == revision && entry.read_started_at <= started_at)
        {
            self.entries.remove(&key);
        }
    }
}

fn normalize(snapshot: &ryu_usage::UsageSnapshot) -> Option<Observation> {
    if !snapshot.available {
        return None;
    }
    let mut windows = Vec::new();
    for window in snapshot
        .windows
        .iter()
        .filter(|window| window.model.is_none())
    {
        if !window.used_percent.is_finite() || !(0.0..=100.0).contains(&window.used_percent) {
            return None;
        }
        windows.push(WindowObservation {
            used_percent: window.used_percent,
            reset_at: window
                .resets_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&chrono::Utc)),
            window_seconds: window.window_seconds,
        });
    }
    (!windows.is_empty()).then_some(Observation { windows })
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}

pub fn record(
    provider_id: &str,
    account_id: &str,
    revision: &[u8],
    started_at: Instant,
    snapshot: &ryu_usage::UsageSnapshot,
) {
    cache()
        .lock()
        .expect("OAuth pool usage cache mutex")
        .record_started(provider_id, account_id, revision, started_at, snapshot);
}

pub fn get(provider_id: &str, account_id: &str, revision: &[u8]) -> Option<Observation> {
    cache()
        .lock()
        .expect("OAuth pool usage cache mutex")
        .get(provider_id, account_id, revision)
}

pub fn remove_if_revision(
    provider_id: &str,
    account_id: &str,
    revision: &[u8],
    started_at: Instant,
) {
    cache()
        .lock()
        .expect("OAuth pool usage cache mutex")
        .remove_if_revision(provider_id, account_id, revision, started_at);
}

fn warm_account_revisions(
    vault: &crate::pi_config::accounts::AccountVault,
    provider_id: &str,
    policy: &Policy,
) -> anyhow::Result<Vec<(String, Vec<u8>)>> {
    if !matches!(provider_id, "claude-pro-max" | "chatgpt")
        && !crate::pi_config::sdk_account_routing::quota_observations_supported(provider_id)
    {
        return Ok(Vec::new());
    }
    let Some(meta) = crate::pi_config::provider_meta(provider_id) else {
        return Ok(Vec::new());
    };
    let scope = crate::pi_config::accounts::provider_scope(meta.auth_key);
    let mut revisions = Vec::new();
    for account in vault.list(&scope)? {
        if !warm_account_allowed(&account, policy)
            || vault.needs_reauth(&scope, &account.account_id)?
        {
            continue;
        }
        if let Some(revision) = vault.credential_revision(&scope, &account.account_id)? {
            revisions.push((account.account_id, revision));
        }
    }
    revisions.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(revisions)
}

fn warm_account_allowed(
    account: &crate::pi_config::accounts::AccountInfo,
    policy: &Policy,
) -> bool {
    account.kind == crate::pi_config::accounts::KIND_OAUTH
        && !account.needs_reauth
        && policy.allowed(&account.account_id)
}

/// Warm quota evidence without delaying a model request. The first new session
/// may use the strategy's round-robin fallback; subsequent sessions can use
/// fresh vendor observations. A credential rotation starts a new sweep even
/// inside the usual five-minute throttle window.
pub fn warm_in_background(provider_id: &str, policy: &Policy) {
    if matches!(policy.strategy, Strategy::Manual | Strategy::RoundRobin) {
        return;
    }
    let Some(vault) = crate::pi_config::accounts::global() else {
        return;
    };
    let Some(meta) = crate::pi_config::provider_meta(provider_id) else {
        return;
    };
    let provider_id = meta.id;
    let account_revisions = match warm_account_revisions(vault, provider_id, policy) {
        Ok(revisions) => revisions,
        Err(error) => {
            tracing::warn!(%error, provider_id, "could not list OAuth accounts for usage warmup");
            return;
        }
    };
    if account_revisions.is_empty() {
        return;
    }
    static LAST_WARM: OnceLock<Mutex<HashMap<&'static str, (Instant, Vec<(String, Vec<u8>)>)>>> =
        OnceLock::new();
    let last_warm = LAST_WARM.get_or_init(|| Mutex::new(HashMap::new()));
    {
        let mut guard = last_warm.lock().expect("OAuth pool warmup mutex");
        if guard.get(provider_id).is_some_and(|(last, previous)| {
            last.elapsed() < OBSERVATION_TTL && previous == &account_revisions
        }) {
            return;
        }
        guard.insert(provider_id, (Instant::now(), account_revisions.clone()));
    }
    tokio::spawn(async move {
        for batch in account_revisions.chunks(4) {
            let reads = batch.iter().map(|(account_id, _)| {
                super::usage_api::read_provider_account_usage(provider_id, account_id)
            });
            futures_util::future::join_all(reads).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::oauth_pool_policy::{AccountRule, Policy, Strategy};

    #[test]
    fn sdk_warmup_captures_each_account_revision_from_its_canonical_scope() {
        use crate::pi_config::accounts::{provider_scope, AccountVault, KIND_API_KEY, KIND_OAUTH};
        let vault = AccountVault::in_memory().unwrap();
        let scope = provider_scope(
            crate::pi_config::provider_meta("openai-codex")
                .unwrap()
                .auth_key,
        );
        for (id, kind) in [("b", KIND_OAUTH), ("a", KIND_OAUTH), ("key", KIND_API_KEY)] {
            vault
                .upsert(&scope, id, id, kind, Some(serde_json::json!({"access":id})))
                .unwrap();
        }
        let policy = Policy::default();
        let revisions = warm_account_revisions(&vault, "openai-codex", &policy).unwrap();
        assert_eq!(
            revisions
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(
            revisions[0].1,
            vault.credential_revision(&scope, "a").unwrap().unwrap()
        );
        assert!(warm_account_revisions(&vault, "github-copilot", &policy)
            .unwrap()
            .is_empty());
        assert!(warm_account_revisions(&vault, "kimi-coding", &policy)
            .unwrap()
            .is_empty());
        vault
            .upsert(
                &scope,
                "a",
                "a",
                KIND_OAUTH,
                Some(serde_json::json!({"access":"new"})),
            )
            .unwrap();
        let rotated = warm_account_revisions(&vault, "openai-codex", &policy).unwrap();
        assert_ne!(rotated[0].1, revisions[0].1);
        assert_eq!(rotated[1].1, revisions[1].1);
    }

    #[test]
    fn warmup_excludes_disabled_quarantined_and_non_oauth_accounts() {
        use crate::pi_config::accounts::{provider_scope, AccountVault, KIND_OAUTH};
        let vault = AccountVault::in_memory().unwrap();
        let scope = provider_scope(
            crate::pi_config::provider_meta("github-copilot")
                .unwrap()
                .auth_key,
        );
        vault
            .upsert(
                &scope,
                "account",
                "account",
                KIND_OAUTH,
                Some(serde_json::json!({"access":"token"})),
            )
            .unwrap();
        let mut account = vault.list(&scope).unwrap().remove(0);
        let mut policy = Policy::default();
        assert!(warm_account_allowed(&account, &policy));
        account.needs_reauth = true;
        assert!(!warm_account_allowed(&account, &policy));
        account.needs_reauth = false;
        policy.accounts.insert(
            "account".to_owned(),
            AccountRule {
                enabled: false,
                priority: 0,
                drain_threshold_percent: None,
            },
        );
        assert!(!warm_account_allowed(&account, &policy));
        assert!(warm_account_revisions(&vault, "github-copilot", &policy)
            .unwrap()
            .is_empty());
        policy.accounts.clear();
        account.kind = crate::pi_config::accounts::KIND_OPAQUE.to_owned();
        assert!(!warm_account_allowed(&account, &policy));
    }

    fn snapshot(available: bool, windows: Vec<ryu_usage::UsageWindow>) -> ryu_usage::UsageSnapshot {
        ryu_usage::UsageSnapshot {
            agent_id: "claude".to_owned(),
            engine: "claude".to_owned(),
            available,
            plan: None,
            reason: None,
            windows,
            meters: Vec::new(),
            extra_usage_usd: None,
            retry_after_seconds: None,
            ..Default::default()
        }
    }

    fn window(used_percent: f64, model: Option<&str>) -> ryu_usage::UsageWindow {
        ryu_usage::UsageWindow {
            label: "Weekly".to_owned(),
            used_percent,
            resets_at: None,
            window_seconds: Some(604_800),
            model: model.map(str::to_owned),
        }
    }

    #[test]
    fn observation_requires_fresh_matching_credential_and_account_wide_meter() {
        let mut cache = Cache::default();
        cache.record(
            "claude",
            "first",
            b"revision-a",
            &snapshot(true, vec![window(40.0, None), window(99.0, Some("opus"))]),
        );
        assert_eq!(
            cache
                .get("claude", "first", b"revision-a")
                .map(|observation| observation.highest_used_percent()),
            Some(40.0)
        );
        assert!(cache.get("claude", "first", b"revision-b").is_none());
        assert!(cache.get("claude", "first", b"revision-a").is_some());
        assert!(cache.get("chatgpt", "first", b"revision-a").is_none());
    }

    #[test]
    fn unknown_and_invalid_usage_clear_prior_observation() {
        let mut cache = Cache::default();
        let good = snapshot(true, vec![window(30.0, None)]);
        cache.record("claude", "first", b"revision", &good);
        cache.record("claude", "first", b"revision", &snapshot(false, Vec::new()));
        assert!(cache.get("claude", "first", b"revision").is_none());

        cache.record("claude", "first", b"revision", &good);
        cache.record(
            "claude",
            "first",
            b"revision",
            &snapshot(true, vec![window(f64::NAN, None)]),
        );
        assert!(cache.get("claude", "first", b"revision").is_none());
    }

    #[test]
    fn stale_usage_failure_cannot_clear_a_new_credential_observation() {
        let mut cache = Cache::default();
        let good = snapshot(true, vec![window(30.0, None)]);
        cache.record("claude", "first", b"new-revision", &good);
        cache.record(
            "claude",
            "first",
            b"old-revision",
            &snapshot(false, Vec::new()),
        );
        cache.remove_if_revision("claude", "first", b"old-revision", Instant::now());
        assert_eq!(
            cache
                .get("claude", "first", b"new-revision")
                .map(|observation| observation.highest_used_percent()),
            Some(30.0)
        );
    }

    #[test]
    fn slower_valid_read_cannot_replace_a_newer_credential_observation() {
        let mut cache = Cache::default();
        let old_started_at = Instant::now();
        let good = snapshot(true, vec![window(30.0, None)]);
        cache.record("claude", "first", b"new-revision", &good);
        cache.record_started(
            "claude",
            "first",
            b"old-revision",
            old_started_at,
            &snapshot(true, vec![window(10.0, None)]),
        );
        assert_eq!(
            cache
                .get("claude", "first", b"new-revision")
                .map(|observation| observation.highest_used_percent()),
            Some(30.0)
        );
    }

    #[test]
    fn newer_credential_read_wins_even_when_old_read_finishes_first() {
        let mut cache = Cache::default();
        let old_started_at = Instant::now() - Duration::from_secs(2);
        let new_started_at = Instant::now() - Duration::from_secs(1);
        cache.record_started(
            "claude",
            "first",
            b"old-revision",
            old_started_at,
            &snapshot(true, vec![window(10.0, None)]),
        );
        cache.record_started(
            "claude",
            "first",
            b"new-revision",
            new_started_at,
            &snapshot(true, vec![window(30.0, None)]),
        );
        assert_eq!(
            cache
                .get("claude", "first", b"new-revision")
                .map(|observation| observation.highest_used_percent()),
            Some(30.0)
        );
    }

    #[test]
    fn slower_failed_read_cannot_clear_newer_observation_of_same_credential() {
        let mut cache = Cache::default();
        let old_started_at = Instant::now();
        cache.record(
            "claude",
            "first",
            b"revision",
            &snapshot(true, vec![window(30.0, None)]),
        );
        cache.remove_if_revision("claude", "first", b"revision", old_started_at);
        assert!(cache.get("claude", "first", b"revision").is_some());
    }

    #[test]
    fn saturated_window_wins_over_less_used_window() {
        let normalized = normalize(&snapshot(
            true,
            vec![window(31.0, None), window(100.0, None)],
        ));
        assert_eq!(
            normalized.map(|item| item.highest_used_percent()),
            Some(100.0)
        );
    }

    fn candidate<'a>(id: &'a str) -> Candidate<'a> {
        Candidate {
            account_id: id,
            revision: b"same",
        }
    }

    fn observation(used_percent: f64) -> Observation {
        Observation {
            windows: vec![WindowObservation {
                used_percent,
                reset_at: None,
                window_seconds: Some(18_000),
            }],
        }
    }

    #[test]
    fn manual_and_round_robin_respect_enabled_accounts_and_priority() {
        let candidates = [candidate("first"), candidate("second"), candidate("third")];
        let mut cursor = PoolCursor::default();
        let mut policy = Policy::default();
        assert_eq!(
            cursor.select_with(&candidates, "second", &policy, |_| None),
            Some(1)
        );
        policy.strategy = Strategy::RoundRobin;
        policy.accounts.insert(
            "first".to_owned(),
            AccountRule {
                drain_threshold_percent: None,
                enabled: false,
                priority: 0,
            },
        );
        policy.accounts.insert(
            "third".to_owned(),
            AccountRule {
                drain_threshold_percent: None,
                enabled: true,
                priority: 5,
            },
        );
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |_| None),
            Some(1)
        );
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |_| None),
            Some(1)
        );
        policy.accounts.get_mut("third").unwrap().priority = 0;
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |_| None),
            Some(1)
        );
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |_| None),
            Some(2)
        );
    }

    #[test]
    fn quota_first_uses_only_known_headroom_and_falls_back_to_rotation() {
        let candidates = [
            candidate("first"),
            candidate("second"),
            candidate("unknown"),
        ];
        let mut cursor = PoolCursor::default();
        let policy = Policy {
            strategy: Strategy::QuotaFirst,
            ..Policy::default()
        };
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |candidate| {
                match candidate.account_id {
                    "first" => Some(observation(80.0)),
                    "second" => Some(observation(30.0)),
                    _ => None,
                }
            }),
            Some(1)
        );
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |_| None),
            Some(0)
        );
    }

    #[test]
    fn quota_first_rotates_equal_readings_without_selecting_unknown_accounts() {
        let candidates = [
            candidate("first"),
            candidate("second"),
            candidate("unknown"),
        ];
        let mut cursor = PoolCursor::default();
        let policy = Policy {
            strategy: Strategy::QuotaFirst,
            ..Policy::default()
        };
        let mut select = || {
            cursor.select_with(&candidates, "first", &policy, |candidate| {
                (candidate.account_id != "unknown").then(|| observation(25.0))
            })
        };
        assert_eq!([select(), select(), select()], [Some(0), Some(1), Some(0)]);
    }

    #[test]
    fn fill_first_holds_account_until_fresh_usage_reaches_threshold() {
        let candidates = [candidate("first"), candidate("second")];
        let mut cursor = PoolCursor::default();
        let policy = Policy {
            strategy: Strategy::FillFirst,
            ..Policy::default()
        };
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |_| None),
            Some(0)
        );
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |_| None),
            Some(0)
        );
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |candidate| {
                Some(observation(if candidate.account_id == "first" {
                    85.0
                } else {
                    20.0
                }))
            }),
            Some(1)
        );
    }

    #[test]
    fn reset_first_uses_future_reset_and_ignores_unknown() {
        let candidates = [candidate("first"), candidate("second")];
        let now = chrono::Utc::now();
        let mut cursor = PoolCursor::default();
        let policy = Policy {
            strategy: Strategy::ResetFirst,
            ..Policy::default()
        };
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |candidate| {
                let mut usage = observation(40.0);
                usage.windows[0].reset_at = Some(
                    now + chrono::Duration::minutes(if candidate.account_id == "first" {
                        60
                    } else {
                        30
                    }),
                );
                Some(usage)
            }),
            Some(1)
        );
    }

    #[test]
    fn reset_first_rotates_accounts_with_the_same_reset_deadline() {
        let candidates = [candidate("first"), candidate("second")];
        let reset_at = chrono::Utc::now() + chrono::Duration::minutes(30);
        let mut cursor = PoolCursor::default();
        let policy = Policy {
            strategy: Strategy::ResetFirst,
            ..Policy::default()
        };
        let mut select = || {
            cursor.select_with(&candidates, "first", &policy, |_| {
                let mut usage = observation(40.0);
                usage.windows[0].reset_at = Some(reset_at);
                Some(usage)
            })
        };
        assert_eq!([select(), select(), select()], [Some(0), Some(1), Some(0)]);
    }

    #[test]
    fn stale_observation_is_discarded() {
        let mut cache = Cache::default();
        cache.record(
            "claude",
            "first",
            b"revision",
            &snapshot(true, vec![window(10.0, None)]),
        );
        cache
            .entries
            .get_mut(&("claude".to_owned(), "first".to_owned()))
            .unwrap()
            .observed_at = Instant::now() - OBSERVATION_TTL;
        assert!(cache.get("claude", "first", b"revision").is_none());
    }

    #[test]
    fn observed_drained_priority_tier_yields_to_known_backup_and_retains_unknown_tiers() {
        let candidates = [candidate("first"), candidate("backup")];
        for strategy in [
            Strategy::FillFirst,
            Strategy::QuotaFirst,
            Strategy::ResetFirst,
        ] {
            let mut cursor = PoolCursor::default();
            let mut policy = Policy {
                strategy,
                ..Policy::default()
            };
            policy.accounts.insert(
                "backup".into(),
                AccountRule {
                    enabled: true,
                    priority: 1,
                    drain_threshold_percent: None,
                },
            );
            assert_eq!(
                cursor.select_with(&candidates, "first", &policy, |candidate| {
                    let mut usage = observation(if candidate.account_id == "first" {
                        100.0
                    } else {
                        10.0
                    });
                    usage.windows[0].reset_at =
                        Some(chrono::Utc::now() + chrono::Duration::hours(1));
                    Some(usage)
                }),
                Some(1),
                "{strategy:?}"
            );
            assert_eq!(
                cursor.select_with(&candidates, "first", &policy, |candidate| {
                    (candidate.account_id == "backup").then(|| observation(10.0))
                }),
                Some(0),
                "{strategy:?}"
            );
            policy.accounts.get_mut("backup").unwrap().enabled = false;
            assert_eq!(
                cursor.select_with(&candidates, "first", &policy, |_| Some(observation(100.0))),
                Some(0)
            );
        }
    }

    #[test]
    fn account_zero_override_retains_fill_until_exhaustion_and_removal_restores_drain() {
        let candidates = [candidate("first"), candidate("backup")];
        let mut cursor = PoolCursor::default();
        let mut policy = Policy {
            strategy: Strategy::FillFirst,
            ..Policy::default()
        };
        policy.accounts.insert(
            "first".into(),
            AccountRule {
                enabled: true,
                priority: 0,
                drain_threshold_percent: Some(0),
            },
        );
        policy.accounts.insert(
            "backup".into(),
            AccountRule {
                enabled: true,
                priority: 1,
                drain_threshold_percent: None,
            },
        );
        let select = |cursor: &mut PoolCursor, policy: &Policy, used| {
            cursor.select_with(&candidates, "first", policy, |candidate| {
                Some(observation(if candidate.account_id == "first" {
                    used
                } else {
                    10.0
                }))
            })
        };
        assert_eq!(select(&mut cursor, &policy, 85.0), Some(0));
        assert_eq!(select(&mut cursor, &policy, 100.0), Some(1));
        policy
            .accounts
            .get_mut("first")
            .unwrap()
            .drain_threshold_percent = None;
        assert_eq!(select(&mut cursor, &policy, 85.0), Some(1));
    }

    #[test]
    fn explicit_override_controls_tier_headroom_and_preserves_within_tier_reset_ranking() {
        let candidates = [candidate("first"), candidate("backup")];
        let mut cursor = PoolCursor::default();
        let mut policy = Policy {
            strategy: Strategy::ResetFirst,
            ..Policy::default()
        };
        policy.accounts.insert(
            "first".into(),
            AccountRule {
                enabled: true,
                priority: 0,
                drain_threshold_percent: Some(60),
            },
        );
        policy.accounts.insert(
            "backup".into(),
            AccountRule {
                enabled: true,
                priority: 1,
                drain_threshold_percent: None,
            },
        );
        let mut select = |policy: &Policy| {
            cursor.select_with(&candidates, "first", policy, |candidate| {
                let mut usage = observation(if candidate.account_id == "first" {
                    65.0
                } else {
                    10.0
                });
                usage.windows[0].reset_at = Some(
                    chrono::Utc::now()
                        + chrono::Duration::seconds(if candidate.account_id == "first" {
                            60
                        } else {
                            3600
                        }),
                );
                Some(usage)
            })
        };
        assert_eq!(select(&policy), Some(1));
        policy
            .accounts
            .get_mut("first")
            .unwrap()
            .drain_threshold_percent = Some(0);
        assert_eq!(select(&policy), Some(0));
        policy
            .accounts
            .get_mut("first")
            .unwrap()
            .drain_threshold_percent = Some(60);
        policy.accounts.get_mut("backup").unwrap().priority = 0;
        assert_eq!(select(&policy), Some(0));
    }
}
