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
    // Asks `enabled` and not `allowed`, so an agent's pool never changes the warmed set.
    account.kind == crate::pi_config::accounts::KIND_OAUTH
        && !account.needs_reauth
        && policy.enabled(&account.account_id)
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
mod tests;
