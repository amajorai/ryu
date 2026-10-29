//! Session-sticky selection for one provider's API-key accounts.
//!
//! New conversations enter the pool in round-robin order. A live conversation
//! keeps its account, including across streaming requests, until that account
//! reports a quota failure. Failed accounts cool down before new work uses them.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEFAULT_COOLDOWN: Duration = Duration::from_secs(60);
/// How long a key the upstream refused to authenticate stays out of rotation
/// before one request probes it again.
const AUTH_FAILURE_COOLDOWN: Duration = Duration::from_secs(5 * 60);
const MAX_BINDINGS: usize = 10_000;
const BINDING_IDLE_TTL: Duration = Duration::from_secs(60 * 60);
const QUOTA_OBSERVATION_TTL: Duration = Duration::from_secs(5 * 60);
pub const DEFAULT_FILL_FIRST_DRAIN_PERCENT: u8 = 80;

/// Ranking for new sessions within the highest available account priority.
/// A live session keeps its binding regardless of a newer quota observation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountSelectionStrategy {
    #[default]
    RoundRobin,
    QuotaFirst,
    FillFirst,
    ResetFirst,
}

#[derive(Clone, Copy)]
struct QuotaObservation {
    remaining: Option<u64>,
    limit: Option<u64>,
    reset_at: Option<u64>,
    observed_at: Instant,
}

struct Binding {
    account: usize,
    last_used: Instant,
}

struct State {
    strategy: AccountSelectionStrategy,
    fill_first_drain_percent: u8,
    cursor: usize,
    fill_account: Option<usize>,
    bindings: HashMap<String, Binding>,
    unavailable_until: Vec<Option<Instant>>,
    policies: Vec<crate::ProviderAccountPolicy>,
    quota: Vec<Option<QuotaObservation>>,
    quota_domains: Vec<Option<String>>,
}

pub struct AccountPool {
    count: usize,
    state: Mutex<State>,
}

impl AccountPool {
    pub fn new(count: usize) -> Self {
        Self {
            count,
            state: Mutex::new(State {
                strategy: AccountSelectionStrategy::RoundRobin,
                fill_first_drain_percent: DEFAULT_FILL_FIRST_DRAIN_PERCENT,
                cursor: 0,
                fill_account: None,
                bindings: HashMap::new(),
                unavailable_until: vec![None; count],
                policies: vec![crate::ProviderAccountPolicy::default(); count],
                quota: vec![None; count],
                quota_domains: vec![None; count],
            }),
        }
    }

    pub fn configure(&self, policies: &[crate::ProviderAccountPolicy]) {
        assert_eq!(policies.len(), self.count, "account policy count");
        self.state.lock().expect("account pool mutex").policies = policies.to_vec();
    }

    pub fn configure_strategy(&self, strategy: AccountSelectionStrategy) {
        self.state.lock().expect("account pool mutex").strategy = strategy;
    }

    /// New, unbound sessions leave the fill account after fresh quota evidence
    /// reaches this used percentage. Existing healthy bindings stay in place.
    pub fn configure_fill_first_drain_percent(&self, percent: u8) {
        assert!((1..=100).contains(&percent), "fill-first drain percent");
        self.state
            .lock()
            .expect("account pool mutex")
            .fill_first_drain_percent = percent;
    }

    pub fn has_restrictions(&self) -> bool {
        self.state
            .lock()
            .expect("account pool mutex")
            .policies
            .iter()
            .any(|p| !p.enabled || p.priority != 0)
    }

    /// Candidate accounts in selection order. An empty list means every account
    /// is cooling down; callers should surface a rate-limit response.
    pub fn candidates(&self, session: Option<&str>) -> Vec<usize> {
        let strategy = {
            let state = self.state.lock().expect("account pool mutex");
            if matches!(
                state.strategy,
                AccountSelectionStrategy::RoundRobin | AccountSelectionStrategy::FillFirst
            ) || state
                .policies
                .iter()
                .enumerate()
                .filter(|(_, policy)| policy.enabled)
                .all(|(index, _)| {
                    state.quota_domains[index].is_some()
                        && state.quota[index]
                            .is_some_and(|value| quota_rank(Some(value), Instant::now()).0 == 0)
                })
            {
                state.strategy
            } else {
                AccountSelectionStrategy::RoundRobin
            }
        };
        self.ordered_candidates(session, None, strategy)
    }

    #[cfg(test)]
    pub fn candidates_with_strategy(
        &self,
        session: Option<&str>,
        strategy: AccountSelectionStrategy,
    ) -> Vec<usize> {
        self.ordered_candidates(session, None, strategy)
    }

    /// Recheck an already planned candidate after another key reports a shared
    /// quota failure during the same request.
    pub fn is_available(&self, account: usize) -> bool {
        let state = self.state.lock().expect("account pool mutex");
        account < self.count && is_available(&state, account, Instant::now())
    }

    /// Record only the headers returned by this specific account. Provider-wide
    /// metrics cannot safely rank multiple keys belonging to the same provider.
    pub fn record_quota(&self, account: usize, info: &crate::RateLimitInfo) {
        let (Some(remaining), Some(limit)) = (info.remaining, info.limit) else {
            return;
        };
        if limit == 0 {
            return;
        }
        let mut state = self.state.lock().expect("account pool mutex");
        let Some(slot) = state.quota.get_mut(account) else {
            return;
        };
        *slot = Some(QuotaObservation {
            remaining: Some(remaining),
            limit: Some(limit),
            reset_at: info.reset_at,
            observed_at: Instant::now(),
        });
    }

    /// An upstream may report the same organization quota for several keys.
    /// Keep its identity in memory only, so one 429 cools the entire known domain.
    pub fn record_quota_domain(&self, account: usize, domain: &str) {
        if domain.is_empty() || domain.len() > 128 || domain.chars().any(char::is_control) {
            return;
        }
        let mut state = self.state.lock().expect("account pool mutex");
        if let Some(previous) = state.quota_domains.get(account) {
            // Never attach an old organization's quota reading to a newly
            // reported organization. Initial discovery can retain its reading.
            if previous
                .as_deref()
                .is_some_and(|previous| previous != domain)
            {
                state.quota[account] = None;
            }
            state.quota_domains[account] = Some(domain.to_owned());
        }
    }

    pub(crate) fn candidates_with_priorities(
        &self,
        session: Option<&str>,
        priorities: &[u32],
    ) -> Vec<usize> {
        self.ordered_candidates(
            session,
            Some(priorities),
            AccountSelectionStrategy::RoundRobin,
        )
    }

    fn ordered_candidates(
        &self,
        session: Option<&str>,
        priorities: Option<&[u32]>,
        strategy: AccountSelectionStrategy,
    ) -> Vec<usize> {
        if self.count == 0 {
            return Vec::new();
        }
        let now = Instant::now();
        let mut state = self.state.lock().expect("account pool mutex");
        let configured_priorities: Vec<u32> = state
            .policies
            .iter()
            .map(|p| u32::from(p.priority))
            .collect();
        let priorities = priorities.or(Some(configured_priorities.as_slice()));
        state
            .bindings
            .retain(|_, binding| now.duration_since(binding.last_used) < BINDING_IDLE_TTL);

        let pinned = session
            .and_then(|id| state.bindings.get(id))
            .map(|binding| binding.account)
            .filter(|index| is_available(&state, *index, now));
        let mut deferred = vec![false; self.count];
        if strategy != AccountSelectionStrategy::RoundRobin {
            let limits: Vec<u128> = (0..self.count)
                .map(|index| match strategy {
                    AccountSelectionStrategy::FillFirst => account_drain_limit(&state, index),
                    _ => {
                        let percent = state.policies[index].drain_threshold_percent.unwrap_or(100);
                        u128::from(if percent == 0 { 100 } else { percent }) * 10_000
                    }
                })
                .collect();
            let observed_usage: Vec<Option<u128>> = (0..self.count)
                .map(|index| {
                    if !is_available(&state, index, now) || state.quota_domains[index].is_none() {
                        return None;
                    }
                    let (unknown, used) = domain_quota_rank(&state, index, now);
                    (unknown == 0).then_some(used)
                })
                .collect();
            // Move new work past proven drained tiers only when another
            // available account has proven headroom. Unknown/stale readings
            // never exclude an account, and live bindings still sort first.
            if observed_usage
                .iter()
                .enumerate()
                .any(|(index, used)| used.is_some_and(|used| used < limits[index]))
            {
                for (index, used) in observed_usage.iter().enumerate() {
                    deferred[index] = used.is_some_and(|used| used >= limits[index])
                        && (0..self.count)
                            .filter(|member| {
                                is_available(&state, *member, now)
                                    && priorities
                                        .is_none_or(|values| values[*member] == values[index])
                            })
                            .all(|member| {
                                observed_usage[member].is_some_and(|used| used >= limits[member])
                            });
                }
            }
        }
        let start = pinned.unwrap_or_else(|| {
            let start = if let Some(priorities) = priorities {
                let best = (0..self.count)
                    .filter(|index| is_available(&state, *index, now) && !deferred[*index])
                    .map(|index| priorities[index])
                    .min();
                let group: Vec<usize> = (0..self.count)
                    .filter(|index| {
                        Some(priorities[*index]) == best
                            && is_available(&state, *index, now)
                            && !deferred[*index]
                    })
                    .collect();
                if group.is_empty() {
                    0
                } else {
                    match strategy {
                        AccountSelectionStrategy::RoundRobin => group[state.cursor % group.len()],
                        AccountSelectionStrategy::FillFirst => {
                            let current =
                                state.fill_account.filter(|account| group.contains(account));
                            let selected = current
                                .filter(|account| !fill_account_drained(&state, *account, now))
                                .or_else(|| {
                                    group.iter().copied().find(|account| {
                                        Some(*account) != current
                                            && fill_account_has_headroom(&state, *account, now)
                                    })
                                })
                                .or(current)
                                .unwrap_or(group[0]);
                            state.fill_account = Some(selected);
                            selected
                        }
                        AccountSelectionStrategy::QuotaFirst => {
                            let best = group
                                .iter()
                                .map(|index| domain_quota_rank(&state, *index, now))
                                .min()
                                .expect("nonempty group");
                            let tied: Vec<_> = group
                                .iter()
                                .copied()
                                .filter(|index| domain_quota_rank(&state, *index, now) == best)
                                .collect();
                            tied[state.cursor % tied.len()]
                        }
                        AccountSelectionStrategy::ResetFirst => {
                            let best = group
                                .iter()
                                .map(|index| domain_reset_rank(&state, *index, now))
                                .min()
                                .expect("nonempty group");
                            let tied: Vec<_> = group
                                .iter()
                                .copied()
                                .filter(|index| domain_reset_rank(&state, *index, now) == best)
                                .collect();
                            tied[state.cursor % tied.len()]
                        }
                    }
                }
            } else {
                state.cursor % self.count
            };
            state.cursor = state.cursor.wrapping_add(1);
            start
        });
        let mut candidates: Vec<usize> = (0..self.count)
            .map(|offset| (start + offset) % self.count)
            .filter(|index| is_available(&state, *index, now))
            .collect();
        if let Some(priorities) = priorities {
            match strategy {
                AccountSelectionStrategy::RoundRobin | AccountSelectionStrategy::FillFirst => {
                    candidates.sort_by_key(|index| {
                        (Some(*index) != pinned, deferred[*index], priorities[*index])
                    });
                }
                AccountSelectionStrategy::QuotaFirst => {
                    candidates.sort_by_key(|index| {
                        (
                            Some(*index) != pinned,
                            deferred[*index],
                            priorities[*index],
                            domain_quota_rank(&state, *index, now),
                        )
                    });
                }
                AccountSelectionStrategy::ResetFirst => {
                    candidates.sort_by_key(|index| {
                        (
                            Some(*index) != pinned,
                            deferred[*index],
                            priorities[*index],
                            domain_reset_rank(&state, *index, now),
                        )
                    });
                }
            }
        }

        if let (Some(id), Some(first)) = (session, candidates.first().copied()) {
            bind_session(&mut state, id, first, now);
        }
        candidates
    }

    /// Rebind a session only after an upstream account accepted its request.
    pub fn record_success(&self, session: Option<&str>, account: usize) {
        let Some(id) = session else {
            return;
        };
        let mut state = self.state.lock().expect("account pool mutex");
        if account < self.count {
            bind_session(&mut state, id, account, Instant::now());
        }
    }

    pub fn record_rate_limit(&self, account: usize, retry_after_secs: Option<u64>) {
        let mut state = self.state.lock().expect("account pool mutex");
        let domain = state
            .quota_domains
            .get(account)
            .and_then(Option::as_deref)
            .map(str::to_owned);
        let wait = retry_after_secs
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_COOLDOWN);
        let now = Instant::now();
        let until = now
            .checked_add(wait)
            .or_else(|| now.checked_add(DEFAULT_COOLDOWN));
        for index in 0..self.count {
            if index == account
                || domain
                    .as_deref()
                    .is_some_and(|domain| state.quota_domains[index].as_deref() == Some(domain))
            {
                state.unavailable_until[index] = until;
                // A 429 invalidates the last success observation for every key
                // known to share its quota domain.
                state.quota[index] = None;
            }
        }
    }

    /// The upstream refused this account's credential (HTTP 401/403). See
    /// [`Self::record_account_rejection`].
    pub fn record_auth_failure(&self, account: usize) {
        self.record_account_rejection(account, AUTH_FAILURE_COOLDOWN);
    }

    /// The upstream rejected this account itself rather than its request: a
    /// refused credential or exhausted credit (402). Unlike a 429 that belongs
    /// to this key alone, so it never cools a shared quota domain. A session
    /// bound to the key moves on with the next accepted request. The account
    /// leaves rotation only while another account can still serve: the last
    /// usable account keeps answering, so its real error stays visible (and
    /// still counts toward the provider circuit) instead of turning into a
    /// synthetic rate limit, and a refilled key serves again at once.
    pub fn record_account_rejection(&self, account: usize, cooldown: Duration) {
        let mut state = self.state.lock().expect("account pool mutex");
        let now = Instant::now();
        if account >= self.count
            || !(0..self.count).any(|other| other != account && is_available(&state, other, now))
        {
            return;
        }
        state.unavailable_until[account] = now.checked_add(cooldown);
        state.quota[account] = None;
    }

    pub(crate) fn copy_binding(&self, source: &str, target: &str) {
        let account = self
            .state
            .lock()
            .expect("account pool mutex")
            .bindings
            .get(source)
            .map(|binding| binding.account);
        if let Some(account) = account {
            self.record_success(Some(target), account);
        }
    }
}

fn bind_session(state: &mut State, id: &str, account: usize, now: Instant) {
    state
        .bindings
        .retain(|_, binding| now.duration_since(binding.last_used) < BINDING_IDLE_TTL);
    if state.bindings.len() >= MAX_BINDINGS && !state.bindings.contains_key(id) {
        if let Some(oldest) = state
            .bindings
            .iter()
            .min_by_key(|(_, binding)| binding.last_used)
            .map(|(key, _)| key.clone())
        {
            state.bindings.remove(&oldest);
        }
    }
    state.bindings.insert(
        id.to_owned(),
        Binding {
            account,
            last_used: now,
        },
    );
}

fn quota_rank(observation: Option<QuotaObservation>, now: Instant) -> (u8, u128) {
    let Some(value) =
        observation.filter(|value| now.duration_since(value.observed_at) < QUOTA_OBSERVATION_TTL)
    else {
        return (1, u128::MAX);
    };
    // A recent response can still describe a window that has already reset.
    // Its remaining capacity is no longer evidence for the current window.
    if value
        .reset_at
        .is_some_and(|reset_at| reset_at <= unix_now_secs())
    {
        return (1, u128::MAX);
    }
    let (Some(remaining), Some(limit)) = (value.remaining, value.limit) else {
        return (1, u128::MAX);
    };
    if limit == 0 {
        return (1, u128::MAX);
    }
    let used = u128::from(limit.saturating_sub(remaining)) * 1_000_000 / u128::from(limit);
    (0, used)
}

fn domain_quota_rank(state: &State, index: usize, now: Instant) -> (u8, u128) {
    let Some(domain) = state.quota_domains[index].as_deref() else {
        return quota_rank(state.quota[index], now);
    };
    let worst = state
        .quota_domains
        .iter()
        .enumerate()
        .filter(|(_, member_domain)| member_domain.as_deref() == Some(domain))
        .map(|(member, _)| {
            let (unknown, used) = quota_rank(state.quota[member], now);
            (unknown, used)
        })
        .max()
        .unwrap_or((1, u128::MAX));
    worst
}

fn fill_account_drained(state: &State, index: usize, now: Instant) -> bool {
    if state.quota_domains[index].is_none() {
        return false;
    }
    let (unknown, used) = domain_quota_rank(state, index, now);
    unknown == 0 && used >= account_drain_limit(state, index)
}

fn account_drain_limit(state: &State, index: usize) -> u128 {
    let percent = state.policies[index].effective_drain_threshold(state.fill_first_drain_percent);
    // Zero disables proactive draining, never a definitive exhausted window.
    u128::from(if percent == 0 { 100 } else { percent }) * 10_000
}

fn fill_account_has_headroom(state: &State, index: usize, now: Instant) -> bool {
    if state.quota_domains[index].is_none() {
        return false;
    }
    let (unknown, used) = domain_quota_rank(state, index, now);
    unknown == 0 && used < account_drain_limit(state, index)
}

fn reset_rank(observation: Option<QuotaObservation>, now: Instant) -> (u8, u64) {
    let Some(value) =
        observation.filter(|value| now.duration_since(value.observed_at) < QUOTA_OBSERVATION_TTL)
    else {
        return (1, u64::MAX);
    };
    let Some(reset_at) = value.reset_at else {
        return (1, u64::MAX);
    };
    let now_secs = unix_now_secs();
    if reset_at <= now_secs
        || !matches!((value.remaining, value.limit), (Some(remaining), Some(limit)) if remaining > 0 && limit > 0)
    {
        return (1, u64::MAX);
    }
    (0, reset_at)
}

fn unix_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn domain_reset_rank(state: &State, index: usize, now: Instant) -> (u8, u64) {
    let Some(domain) = state.quota_domains[index].as_deref() else {
        return reset_rank(state.quota[index], now);
    };
    let latest = state
        .quota_domains
        .iter()
        .enumerate()
        .filter(|(_, member_domain)| member_domain.as_deref() == Some(domain))
        .map(|(member, _)| {
            let (unknown, reset_at) = reset_rank(state.quota[member], now);
            (unknown, reset_at)
        })
        .max()
        .unwrap_or((1, u64::MAX));
    latest
}

fn is_available(state: &State, index: usize, now: Instant) -> bool {
    state.policies[index].enabled && !is_cooling(state, index, now)
}

fn is_cooling(state: &State, index: usize, now: Instant) -> bool {
    state.unavailable_until[index].is_some_and(|until| until > now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_quota_window_falls_back_to_rotation_and_keeps_affinity() {
        let pool = AccountPool::new(2);
        pool.configure_strategy(AccountSelectionStrategy::QuotaFirst);
        for (account, remaining) in [90, 20].into_iter().enumerate() {
            pool.record_quota_domain(account, &format!("org-{account}"));
            pool.record_quota(
                account,
                &crate::RateLimitInfo {
                    remaining: Some(remaining),
                    limit: Some(100),
                    reset_at: Some(unix_now_secs().saturating_sub(1)),
                    ..Default::default()
                },
            );
        }
        assert_eq!(pool.candidates(Some("warm"))[0], 0);
        assert_eq!(pool.candidates(Some("new"))[0], 1);
        assert_eq!(pool.candidates(Some("warm"))[0], 0);
    }

    #[test]
    fn fill_first_does_not_drain_using_an_elapsed_window() {
        let pool = AccountPool::new(2);
        pool.configure_strategy(AccountSelectionStrategy::FillFirst);
        assert_eq!(pool.candidates(None)[0], 0);
        for (account, remaining) in [5, 90].into_iter().enumerate() {
            pool.record_quota_domain(account, &format!("org-{account}"));
            pool.record_quota(
                account,
                &crate::RateLimitInfo {
                    remaining: Some(remaining),
                    limit: Some(100),
                    reset_at: Some(unix_now_secs().saturating_sub(1)),
                    ..Default::default()
                },
            );
        }
        assert_eq!(pool.candidates(None)[0], 0);
    }

    #[test]
    fn organization_change_invalidates_its_old_quota_reading() {
        let pool = AccountPool::new(1);
        pool.record_quota_domain(0, "old-org");
        pool.record_quota(
            0,
            &crate::RateLimitInfo {
                remaining: Some(90),
                limit: Some(100),
                ..Default::default()
            },
        );
        pool.record_quota_domain(0, "old-org");
        assert!(pool.state.lock().unwrap().quota[0].is_some());
        pool.record_quota_domain(0, "new-org");
        assert!(pool.state.lock().unwrap().quota[0].is_none());
    }

    #[test]
    fn overflowing_retry_after_cools_the_shared_quota_domain() {
        let pool = AccountPool::new(3);
        pool.record_quota_domain(0, "shared");
        pool.record_quota_domain(1, "shared");
        pool.record_rate_limit(0, Some(u64::MAX));
        assert_eq!(pool.candidates(None), vec![2]);
    }

    #[test]
    fn account_policy_prioritizes_and_disables_without_breaking_healthy_affinity() {
        let pool = AccountPool::new(3);
        assert_eq!(pool.candidates(Some("established"))[0], 0);
        let mut policies = vec![crate::ProviderAccountPolicy::default(); 3];
        policies[0].priority = 10;
        policies[1].enabled = false;
        pool.configure(&policies);
        assert!(pool.has_restrictions());
        assert_eq!(pool.candidates(None), vec![2, 0]);
        assert_eq!(pool.candidates(Some("established")), vec![0, 2]);
        policies[0].enabled = false;
        pool.configure(&policies);
        assert_eq!(pool.candidates(Some("established")), vec![2]);
        policies[2].enabled = false;
        pool.configure(&policies);
        assert!(pool.candidates(None).is_empty());
    }

    #[test]
    fn new_sessions_rotate_while_existing_sessions_keep_their_account() {
        let pool = AccountPool::new(3);
        assert_eq!(pool.candidates(Some("session-a"))[0], 0);
        assert_eq!(pool.candidates(Some("session-b"))[0], 1);
        assert_eq!(pool.candidates(Some("session-a"))[0], 0);
        assert_eq!(pool.candidates(Some("session-c"))[0], 2);
    }

    #[test]
    fn equal_quota_and_reset_readings_rotate_new_sessions() {
        let reset = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        for strategy in [
            AccountSelectionStrategy::QuotaFirst,
            AccountSelectionStrategy::ResetFirst,
        ] {
            let pool = AccountPool::new(2);
            pool.configure_strategy(strategy);
            for (index, domain) in ["org-a", "org-b"].into_iter().enumerate() {
                pool.record_quota_domain(index, domain);
                pool.record_quota(
                    index,
                    &crate::RateLimitInfo {
                        remaining: Some(80),
                        limit: Some(100),
                        reset_at: Some(reset),
                        ..Default::default()
                    },
                );
            }
            assert_eq!(pool.candidates(Some("first")), vec![0, 1]);
            assert_eq!(pool.candidates(Some("second")), vec![1, 0]);
            assert_eq!(pool.candidates(Some("first")), vec![0, 1]);
        }
    }

    #[test]
    fn accepted_request_rebinding_keeps_session_map_bounded() {
        let pool = AccountPool::new(2);
        for index in 0..=MAX_BINDINGS {
            pool.record_success(Some(&format!("session-{index}")), 1);
        }
        assert_eq!(
            pool.state
                .lock()
                .expect("account pool mutex")
                .bindings
                .len(),
            MAX_BINDINGS
        );
        pool.record_success(Some("invalid-account"), 2);
        assert!(!pool
            .state
            .lock()
            .expect("account pool mutex")
            .bindings
            .contains_key("invalid-account"));
    }

    #[test]
    fn quota_failure_skips_the_account_and_rebinds_the_session() {
        let pool = AccountPool::new(2);
        assert_eq!(pool.candidates(Some("session-a")), vec![0, 1]);
        pool.record_rate_limit(0, Some(30));
        assert_eq!(pool.candidates(Some("session-a")), vec![1]);
        pool.record_success(Some("session-a"), 1);
        assert_eq!(pool.candidates(Some("session-a")), vec![1]);
    }

    #[test]
    fn auth_failure_cools_only_that_key_and_moves_its_session() {
        let pool = AccountPool::new(3);
        pool.record_quota_domain(0, "shared");
        pool.record_quota_domain(1, "shared");
        assert_eq!(pool.candidates(Some("session-a"))[0], 0);
        pool.record_auth_failure(0);
        // A refused key is not the organization's quota: its sibling stays.
        let mut candidates = pool.candidates(Some("session-a"));
        candidates.sort_unstable();
        assert_eq!(candidates, vec![1, 2]);
        pool.record_success(Some("session-a"), 1);
        assert_eq!(pool.candidates(Some("session-a"))[0], 1);
    }

    #[test]
    fn auth_failure_keeps_the_last_usable_account_in_rotation() {
        let single = AccountPool::new(1);
        single.record_auth_failure(0);
        assert_eq!(single.candidates(None), vec![0]);

        let pool = AccountPool::new(2);
        pool.record_auth_failure(0);
        pool.record_auth_failure(1);
        assert_eq!(pool.candidates(None), vec![1]);
    }

    #[test]
    fn all_accounts_in_cooldown_fail_closed() {
        let pool = AccountPool::new(1);
        pool.record_rate_limit(0, Some(30));
        assert!(pool.candidates(Some("session-a")).is_empty());
    }

    #[test]
    fn quota_and_reset_rank_only_account_scoped_fresh_observations() {
        let pool = AccountPool::new(3);
        let reset = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        pool.record_quota(
            0,
            &crate::RateLimitInfo {
                remaining: Some(90),
                limit: Some(100),
                reset_at: Some(reset + 120),
                ..Default::default()
            },
        );
        pool.record_quota(
            1,
            &crate::RateLimitInfo {
                remaining: Some(20),
                limit: Some(100),
                reset_at: Some(reset + 30),
                ..Default::default()
            },
        );
        assert_eq!(
            pool.candidates_with_strategy(None, AccountSelectionStrategy::QuotaFirst)[0],
            0
        );
        assert_eq!(
            pool.candidates_with_strategy(None, AccountSelectionStrategy::ResetFirst)[0],
            1
        );
        pool.record_success(Some("warm-session"), 1);
        assert_eq!(
            pool.candidates_with_strategy(
                Some("warm-session"),
                AccountSelectionStrategy::QuotaFirst
            )[0],
            1
        );
        pool.record_rate_limit(1, Some(30));
        assert_eq!(
            pool.candidates_with_strategy(
                Some("warm-session"),
                AccountSelectionStrategy::ResetFirst
            )[0],
            0
        );
    }

    #[test]
    fn unknown_and_stale_quota_never_claim_best_capacity() {
        let pool = AccountPool::new(2);
        pool.record_quota(
            0,
            &crate::RateLimitInfo {
                remaining: Some(95),
                limit: Some(100),
                ..Default::default()
            },
        );
        pool.record_quota(
            1,
            &crate::RateLimitInfo {
                remaining: Some(90),
                limit: Some(100),
                ..Default::default()
            },
        );
        pool.state.lock().unwrap().quota[0]
            .as_mut()
            .unwrap()
            .observed_at = Instant::now() - QUOTA_OBSERVATION_TTL;
        assert_eq!(
            pool.candidates_with_strategy(None, AccountSelectionStrategy::QuotaFirst)[0],
            1
        );
        pool.record_quota(
            0,
            &crate::RateLimitInfo {
                reset_at: Some(123),
                ..Default::default()
            },
        );
        assert_eq!(
            pool.candidates_with_strategy(None, AccountSelectionStrategy::QuotaFirst)[0],
            1
        );
    }

    #[test]
    fn rate_limit_cools_every_key_in_a_known_shared_domain() {
        let pool = AccountPool::new(3);
        pool.record_quota_domain(0, "org-one");
        pool.record_quota_domain(1, "org-one");
        pool.record_quota_domain(2, "org-two");
        pool.record_rate_limit(0, Some(30));
        assert_eq!(pool.candidates(None), vec![2]);
    }

    #[test]
    fn fill_first_keeps_unbound_work_until_observed_drain_then_preserves_bound_sessions() {
        let pool = AccountPool::new(2);
        pool.configure_strategy(AccountSelectionStrategy::FillFirst);
        assert_eq!(pool.candidates(Some("warm"))[0], 0);
        assert_eq!(pool.candidates(None)[0], 0);
        pool.record_quota_domain(0, "org-one");
        pool.record_quota_domain(1, "org-two");
        pool.record_quota(
            0,
            &crate::RateLimitInfo {
                remaining: Some(19),
                limit: Some(100),
                ..Default::default()
            },
        );
        assert_eq!(pool.candidates(None)[0], 0);
        pool.record_quota(
            1,
            &crate::RateLimitInfo {
                remaining: Some(90),
                limit: Some(100),
                ..Default::default()
            },
        );
        assert_eq!(pool.candidates(None)[0], 1);
        assert_eq!(pool.candidates(None)[0], 1);
        assert_eq!(pool.candidates(Some("warm"))[0], 0);
        pool.record_rate_limit(1, Some(30));
        assert_eq!(pool.candidates(None)[0], 0);
    }

    #[test]
    fn configured_fill_first_threshold_drains_only_new_sessions() {
        let pool = AccountPool::new(2);
        pool.configure_strategy(AccountSelectionStrategy::FillFirst);
        pool.configure_fill_first_drain_percent(60);
        assert_eq!(pool.candidates(Some("bound"))[0], 0);
        pool.record_quota_domain(0, "org-one");
        pool.record_quota_domain(1, "org-two");
        pool.record_quota(
            0,
            &crate::RateLimitInfo {
                remaining: Some(35),
                limit: Some(100),
                ..Default::default()
            },
        );
        pool.record_quota(
            1,
            &crate::RateLimitInfo {
                remaining: Some(90),
                limit: Some(100),
                ..Default::default()
            },
        );
        assert_eq!(pool.candidates(None)[0], 1);
        assert_eq!(pool.candidates(Some("bound"))[0], 0);
    }

    #[test]
    fn proven_drained_priority_tier_yields_new_work_without_rebinding_live_sessions() {
        for (strategy, remaining) in [
            (AccountSelectionStrategy::FillFirst, 20),
            (AccountSelectionStrategy::FillFirst, 0),
            (AccountSelectionStrategy::QuotaFirst, 0),
            (AccountSelectionStrategy::ResetFirst, 0),
        ] {
            let pool = AccountPool::new(2);
            pool.configure_strategy(strategy);
            pool.configure(&[
                crate::ProviderAccountPolicy::default(),
                crate::ProviderAccountPolicy {
                    priority: 1,
                    ..Default::default()
                },
            ]);
            pool.record_success(Some("warm"), 0);
            for (account, remaining) in [remaining, 90].into_iter().enumerate() {
                pool.record_quota_domain(account, &format!("org-{account}"));
                pool.record_quota(
                    account,
                    &crate::RateLimitInfo {
                        remaining: Some(remaining),
                        limit: Some(100),
                        reset_at: Some(unix_now_secs() + 3600),
                        ..Default::default()
                    },
                );
            }
            assert_eq!(pool.candidates(None), vec![1, 0], "{strategy:?}");
            assert_eq!(pool.candidates(Some("new")), vec![1, 0], "{strategy:?}");
            assert_eq!(pool.candidates(Some("warm")), vec![0, 1], "{strategy:?}");
            pool.record_rate_limit(1, Some(30));
            assert_eq!(pool.candidates(None), vec![0], "{strategy:?}");
        }
    }

    #[test]
    fn unknown_or_stale_priority_tier_is_not_treated_as_drained() {
        for strategy in [
            AccountSelectionStrategy::FillFirst,
            AccountSelectionStrategy::QuotaFirst,
            AccountSelectionStrategy::ResetFirst,
        ] {
            let pool = AccountPool::new(2);
            pool.configure_strategy(strategy);
            pool.configure(&[
                crate::ProviderAccountPolicy::default(),
                crate::ProviderAccountPolicy {
                    priority: 1,
                    ..Default::default()
                },
            ]);
            for account in 0..2 {
                pool.record_quota_domain(account, &format!("org-{account}"));
            }
            pool.record_quota(
                1,
                &crate::RateLimitInfo {
                    remaining: Some(90),
                    limit: Some(100),
                    reset_at: Some(unix_now_secs() + 3600),
                    ..Default::default()
                },
            );
            assert_eq!(pool.candidates(None)[0], 0, "{strategy:?}");
            pool.record_quota(
                0,
                &crate::RateLimitInfo {
                    remaining: Some(0),
                    limit: Some(100),
                    ..Default::default()
                },
            );
            pool.state.lock().unwrap().quota[0]
                .as_mut()
                .unwrap()
                .observed_at = Instant::now() - QUOTA_OBSERVATION_TTL;
            assert_eq!(pool.candidates(None)[0], 0, "{strategy:?}");
        }
    }

    #[test]
    fn account_drain_override_zero_and_removal_preserve_inheritance_and_affinity() {
        let pool = AccountPool::new(2);
        pool.configure_strategy(AccountSelectionStrategy::FillFirst);
        let mut policies = [
            crate::ProviderAccountPolicy::default(),
            crate::ProviderAccountPolicy {
                priority: 1,
                ..Default::default()
            },
        ];
        policies[0].drain_threshold_percent = Some(0);
        pool.configure(&policies);
        pool.record_success(Some("warm"), 0);
        for (account, remaining) in [15, 90].into_iter().enumerate() {
            pool.record_quota_domain(account, &format!("org-{account}"));
            pool.record_quota(
                account,
                &crate::RateLimitInfo {
                    remaining: Some(remaining),
                    limit: Some(100),
                    ..Default::default()
                },
            );
        }
        assert_eq!(pool.candidates(None)[0], 0);
        pool.configure_fill_first_drain_percent(60);
        assert_eq!(pool.candidates(None)[0], 0);
        policies[0].drain_threshold_percent = None;
        pool.configure(&policies);
        assert_eq!(pool.candidates(None), vec![1, 0]);
        assert_eq!(pool.candidates(Some("warm")), vec![0, 1]);
        policies[0].drain_threshold_percent = Some(0);
        pool.configure(&policies);
        pool.record_quota(
            0,
            &crate::RateLimitInfo {
                remaining: Some(0),
                limit: Some(100),
                ..Default::default()
            },
        );
        assert_eq!(pool.candidates(None), vec![1, 0]);
    }

    #[test]
    fn explicit_account_threshold_controls_tiers_without_changing_within_tier_reset_rank() {
        for strategy in [
            AccountSelectionStrategy::FillFirst,
            AccountSelectionStrategy::QuotaFirst,
            AccountSelectionStrategy::ResetFirst,
        ] {
            let pool = AccountPool::new(2);
            pool.configure_strategy(strategy);
            let mut policies = [
                crate::ProviderAccountPolicy::default(),
                crate::ProviderAccountPolicy {
                    priority: 1,
                    ..Default::default()
                },
            ];
            pool.configure(&policies);
            for (account, remaining) in [35, 90].into_iter().enumerate() {
                pool.record_quota_domain(account, &format!("org-{account}"));
                pool.record_quota(
                    account,
                    &crate::RateLimitInfo {
                        remaining: Some(remaining),
                        limit: Some(100),
                        reset_at: Some(unix_now_secs() + if account == 0 { 60 } else { 3600 }),
                        ..Default::default()
                    },
                );
            }
            assert_eq!(pool.candidates(None)[0], 0, "{strategy:?}");
            policies[0].drain_threshold_percent = Some(60);
            pool.configure(&policies);
            assert_eq!(pool.candidates(None), vec![1, 0], "{strategy:?}");
            policies[0].drain_threshold_percent = Some(0);
            pool.configure(&policies);
            assert_eq!(pool.candidates(None)[0], 0, "{strategy:?}");
            if strategy == AccountSelectionStrategy::ResetFirst {
                policies[0].drain_threshold_percent = Some(60);
                policies[1].priority = 0;
                pool.configure(&policies);
                assert_eq!(pool.candidates(None)[0], 0);
            }
        }
    }
}
