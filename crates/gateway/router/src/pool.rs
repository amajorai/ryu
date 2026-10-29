//! Provider/model pool selection independent of the Gateway request pipeline.
//!
//! Each member names both a provider and its actual upstream model. A caller
//! alias never gets forwarded unchanged to a different provider by accident.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[path = "selection.rs"]
mod selection;
pub use selection::{
    AutoScoringWeights, CanonicalPoolStrategy, MemberSignals, PoolRequest, PoolSelectionError,
    QuotaWindowSignal,
};
pub type PoolStrategy = CanonicalPoolStrategy;

const DEFAULT_COOLDOWN: Duration = Duration::from_secs(60);
const BINDING_IDLE_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_BINDINGS: usize = 10_000;
const MAX_MEMBERS: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolMember {
    pub provider: String,
    pub model: String,
    pub priority: u8,
    pub weight: u16,
    pub enabled: bool,
    /// Use for new sessions only after every regular member is unavailable.
    pub last_resort: bool,
}

struct Binding {
    member: usize,
    last_used: u64,
    confirmed: bool,
}

struct State {
    cursor: usize,
    round_robin_member: Option<usize>,
    round_robin_assignments: u8,
    bindings: HashMap<String, Binding>,
    unavailable_until: Vec<Option<u64>>,
    smooth_weights: Vec<i64>,
    successes: Vec<u64>,
    inflight: Vec<u64>,
    fill_active: Option<usize>,
    last_good: Option<usize>,
    random_members: Vec<usize>,
    random_deck: Vec<usize>,
    last_random: Option<usize>,
    cache_bindings: HashMap<String, Binding>,
    latencies: Vec<Option<(u64, u64)>>,
    feedback: Vec<std::collections::VecDeque<(u64, bool)>>,
    latency_samples: Vec<std::collections::VecDeque<(u64, u64)>>,
}

pub struct ProviderPool {
    members: Vec<PoolMember>,
    strategy: PoolStrategy,
    sticky_limit: u8,
    state: Mutex<State>,
}

impl ProviderPool {
    pub fn new(members: Vec<PoolMember>, strategy: PoolStrategy) -> Result<Self, String> {
        Self::new_with_sticky_limit(members, strategy, 1)
    }

    pub fn new_with_sticky_limit(
        members: Vec<PoolMember>,
        strategy: PoolStrategy,
        sticky_limit: u8,
    ) -> Result<Self, String> {
        if !(1..=100).contains(&sticky_limit) {
            return Err("round-robin sticky limit must be between 1 and 100".to_owned());
        }
        if members.is_empty() || members.len() > MAX_MEMBERS {
            return Err(format!(
                "provider pool must have 1 to {MAX_MEMBERS} members"
            ));
        }
        let mut providers = HashSet::new();
        for member in &members {
            if member.provider.trim().is_empty()
                || member.model.trim().is_empty()
                || member.provider.len() > 128
                || member.model.len() > 256
                || member.provider.trim() != member.provider
                || member.model.trim() != member.model
                || member.provider.chars().any(char::is_control)
                || member.model.chars().any(char::is_control)
            {
                return Err("pool member provider or model is invalid".to_owned());
            }
            if member.enabled
                && member.weight == 0
                && strategy == PoolStrategy::LegacyWeightedRoundRobin
            {
                return Err("enabled pool members must have a positive weight".to_owned());
            }
            if !providers.insert((member.provider.as_str(), member.model.as_str())) {
                return Err("a provider/model pair may appear only once in a pool".to_owned());
            }
        }
        if !members.iter().any(|member| member.enabled) {
            return Err("provider pool must have an enabled member".to_owned());
        }
        let count = members.len();
        Ok(Self {
            members,
            strategy,
            sticky_limit,
            state: Mutex::new(State {
                cursor: 0,
                round_robin_member: None,
                round_robin_assignments: 0,
                bindings: HashMap::new(),
                unavailable_until: vec![None; count],
                smooth_weights: vec![0; count],
                successes: vec![0; count],
                inflight: vec![0; count],
                fill_active: None,
                last_good: None,
                random_members: Vec::new(),
                random_deck: Vec::new(),
                last_random: None,
                cache_bindings: HashMap::new(),
                latencies: vec![None; count],
                feedback: vec![std::collections::VecDeque::new(); count],
                latency_samples: vec![std::collections::VecDeque::new(); count],
            }),
        })
    }

    pub fn member(&self, index: usize) -> Option<&PoolMember> {
        self.members.get(index)
    }

    /// Return eligible members with the selected one first. `available` lets
    /// Gateway filter missing providers and open circuits without duplicating
    /// strategy logic in the request pipeline.
    pub fn candidates(
        &self,
        session: Option<&str>,
        available: impl Fn(&PoolMember) -> bool,
    ) -> Vec<usize> {
        self.candidates_with_facts(session, &PoolRequest::default(), available, |_| {
            MemberSignals::default()
        })
        .unwrap_or_default()
    }

    pub fn eligible_members(&self, available: impl Fn(&PoolMember) -> bool) -> Vec<usize> {
        let allowed: Vec<bool> = self.members.iter().map(&available).collect();
        let state = self.state.lock().expect("provider pool mutex");
        self.eligible(&state, now_ms(), &allowed)
    }

    fn eligible(&self, state: &State, now: u64, allowed: &[bool]) -> Vec<usize> {
        let mut eligible: Vec<usize> = self
            .members
            .iter()
            .enumerate()
            .filter(|(i, member)| {
                member.enabled
                    && allowed[*i]
                    && !state.unavailable_until[*i].is_some_and(|until| until > now)
            })
            .map(|(i, _)| i)
            .collect();
        eligible.sort_by_key(|i| (self.members[*i].last_resort, self.members[*i].priority, *i));
        eligible
    }

    pub fn candidates_with_facts(
        &self,
        session: Option<&str>,
        request: &PoolRequest,
        available: impl Fn(&PoolMember) -> bool,
        signals: impl Fn(&PoolMember) -> MemberSignals,
    ) -> Result<Vec<usize>, PoolSelectionError> {
        self.candidates_with_facts_and_rng(session, request, available, signals, fastrand::f64)
    }

    pub fn candidates_with_facts_and_rng(
        &self,
        session: Option<&str>,
        request: &PoolRequest,
        available: impl Fn(&PoolMember) -> bool,
        signals: impl Fn(&PoolMember) -> MemberSignals,
        mut rng: impl FnMut() -> f64,
    ) -> Result<Vec<usize>, PoolSelectionError> {
        if matches!(self.strategy, PoolStrategy::Fusion | PoolStrategy::Pipeline) {
            return Err(PoolSelectionError::ExecutionRequired(self.strategy));
        }
        let required = request.context_required()?;
        let allowed: Vec<bool> = self.members.iter().map(&available).collect();
        let facts: Vec<MemberSignals> = self.members.iter().map(signals).collect();
        let mut state = self.state.lock().expect("provider pool mutex");
        expire_bindings(&mut state.bindings, request.now_ms);
        expire_bindings(&mut state.cache_bindings, request.now_ms);
        let mut eligible = self.eligible(&state, request.now_ms, &allowed);
        eligible.retain(|i| {
            facts[*i].remaining(request) != Some(0.0)
                && !required
                    .zip(facts[*i].context_tokens)
                    .is_some_and(|(need, capacity)| need > capacity)
        });
        if eligible.is_empty() {
            return Ok(eligible);
        }
        let session = bounded_key(session);
        let prefix = bounded_key(request.cache_prefix.as_deref());
        let session_binding = session
            .and_then(|id| state.bindings.get(id))
            .filter(|binding| eligible.contains(&binding.member));
        let cache_binding = prefix
            .and_then(|key| state.cache_bindings.get(key))
            .filter(|binding| eligible.contains(&binding.member));
        let pinned = if self.strategy == PoolStrategy::CacheOptimized {
            // A proven prefix may replace a tentative choice, but never move a
            // successful conversation's physical account.
            session_binding
                .filter(|binding| binding.confirmed)
                .or(cache_binding)
                .or(session_binding)
        } else {
            session_binding.or(cache_binding)
        }
        .map(|binding| binding.member);
        let ordered = if let Some(member) = pinned {
            eligible.retain(|i| *i != member);
            eligible.insert(0, member);
            eligible
        } else {
            selection::order(
                self.strategy,
                &self.members,
                &mut state,
                eligible,
                request,
                &facts,
                self.sticky_limit,
                &mut rng,
            )
        };
        if self.strategy != PoolStrategy::Lkgp {
            if let Some(id) = session {
                bind(&mut state.bindings, id, ordered[0], request.now_ms, false);
            }
        }
        // Cache affinity is evidence of an accepted response, not of a speculative pick.
        Ok(ordered)
    }

    pub fn acquire(self: &Arc<Self>, member: usize) -> Option<PoolLease> {
        if !self.members.get(member)?.enabled {
            return None;
        }
        let mut state = self.state.lock().expect("provider pool mutex");
        if state.unavailable_until[member].is_some_and(|until| until > now_ms()) {
            return None;
        }
        state.inflight[member] = state.inflight[member].checked_add(1)?;
        Some(PoolLease {
            pool: Arc::clone(self),
            member,
        })
    }

    pub fn in_flight(&self, member: usize) -> Option<u64> {
        self.state
            .lock()
            .expect("provider pool mutex")
            .inflight
            .get(member)
            .copied()
    }

    pub fn record_success(&self, session: Option<&str>, member: usize) {
        self.record_success_with_facts(session, member, &PoolRequest::default(), None);
    }

    pub fn record_success_with_facts(
        &self,
        session: Option<&str>,
        member: usize,
        request: &PoolRequest,
        latency_ms: Option<u64>,
    ) {
        if member >= self.members.len() {
            return;
        }
        let mut state = self.state.lock().expect("provider pool mutex");
        state.successes[member] = state.successes[member].saturating_add(1);
        state.last_good = Some(member);
        state.fill_active = Some(member);
        push_sample(&mut state.feedback[member], (request.now_ms, true));
        if let Some(latency) = latency_ms {
            state.latencies[member] = Some((request.now_ms, latency));
            push_sample(
                &mut state.latency_samples[member],
                (request.now_ms, latency),
            );
        }
        if let Some(id) = bounded_key(session) {
            bind(&mut state.bindings, id, member, request.now_ms, true);
        }
        if let Some(key) = bounded_key(request.cache_prefix.as_deref()) {
            bind(&mut state.cache_bindings, key, member, request.now_ms, true);
        }
    }

    /// Record only a host-classified, penalized upstream failure. Request-shape
    /// and policy rejections must not be submitted as provider reliability data.
    pub fn record_failure(&self, member: usize, observed_at_ms: u64) {
        if member >= self.members.len() {
            return;
        }
        let mut state = self.state.lock().expect("provider pool mutex");
        push_sample(&mut state.feedback[member], (observed_at_ms, false));
    }

    pub fn next_cooldown_delay(&self, available: impl Fn(&PoolMember) -> bool) -> Option<Duration> {
        let now = now_ms();
        let allowed: Vec<bool> = self.members.iter().map(&available).collect();
        let state = self.state.lock().expect("provider pool mutex");
        self.members
            .iter()
            .enumerate()
            .filter(|(i, member)| member.enabled && allowed[*i])
            .filter_map(|(i, _)| state.unavailable_until[i])
            .filter_map(|until| until.checked_sub(now).filter(|ms| *ms > 0))
            .min()
            .map(Duration::from_millis)
    }

    pub fn record_rate_limit(&self, member: usize, retry_after_secs: Option<u64>) {
        self.record_rate_limit_at(member, retry_after_secs, now_ms());
    }

    pub fn record_rate_limit_at(&self, member: usize, retry_after_secs: Option<u64>, now: u64) {
        let mut state = self.state.lock().expect("provider pool mutex");
        if member < self.members.len() {
            let fallback = DEFAULT_COOLDOWN.as_millis() as u64;
            let wait = retry_after_secs
                .and_then(|secs| secs.checked_mul(1000))
                .unwrap_or(fallback);
            state.unavailable_until[member] =
                now.checked_add(wait).or_else(|| now.checked_add(fallback));
            state.smooth_weights[member] = 0;
        }
    }
}

#[cfg(test)]
mod strategy_contract_tests {
    use super::*;

    fn make_pool(strategy: PoolStrategy, weights: &[u16]) -> Arc<ProviderPool> {
        Arc::new(
            ProviderPool::new(
                weights
                    .iter()
                    .enumerate()
                    .map(|(i, weight)| PoolMember {
                        provider: format!("provider-{i}"),
                        model: format!("model-{i}"),
                        priority: 0,
                        weight: *weight,
                        enabled: true,
                        last_resort: false,
                    })
                    .collect(),
                strategy,
            )
            .unwrap(),
        )
    }
    fn request_facts() -> PoolRequest {
        PoolRequest {
            now_ms: 1_000,
            signal_max_age_ms: 100,
            ..PoolRequest::default()
        }
    }
    fn choose(
        pool: &ProviderPool,
        request: &PoolRequest,
        facts: &[MemberSignals],
        draw: f64,
    ) -> usize {
        pool.candidates_with_facts_and_rng(
            None,
            request,
            |_| true,
            |member| {
                facts[member
                    .provider
                    .strip_prefix("provider-")
                    .unwrap()
                    .parse::<usize>()
                    .unwrap()]
                .clone()
            },
            || draw,
        )
        .unwrap()[0]
    }
    fn observed(remaining: f64, reset: u64) -> MemberSignals {
        MemberSignals {
            remaining_fraction: Some(remaining),
            reset_in_ms: Some(reset),
            reset_window_ms: Some(3_600_000),
            observed_at_ms: Some(1_000),
            ..Default::default()
        }
    }

    #[test]
    fn canonical_set_is_unique_and_execution_strategies_are_explicit() {
        assert_eq!(
            PoolStrategy::ALL.into_iter().collect::<HashSet<_>>().len(),
            21
        );
        assert_eq!(PoolStrategy::default(), PoolStrategy::RoundRobin);
        for strategy in [PoolStrategy::Fusion, PoolStrategy::Pipeline] {
            let pool = make_pool(strategy, &[1, 1]);
            assert_eq!(
                pool.candidates_with_facts(
                    None,
                    &request_facts(),
                    |_| true,
                    |_| MemberSignals::default()
                ),
                Err(PoolSelectionError::ExecutionRequired(strategy))
            );
            assert!(pool.candidates(None, |_| true).is_empty());
            assert_eq!(pool.eligible_members(|_| true), vec![0, 1]);
        }
        assert!(PoolStrategy::ContextRelay.is_chat_only());
        assert!(!PoolStrategy::Headroom.is_chat_only());
    }

    #[test]
    fn weighted_draw_and_legacy_rotation_are_distinct() {
        let weighted = make_pool(PoolStrategy::Weighted, &[1, 3, 0]);
        let facts = vec![MemberSignals::default(); 3];
        assert_eq!(choose(&weighted, &request_facts(), &facts, 0.0), 0);
        assert_eq!(choose(&weighted, &request_facts(), &facts, 0.25), 1);
        assert_eq!(choose(&weighted, &request_facts(), &facts, 0.999), 1);
        let legacy = make_pool(PoolStrategy::LegacyWeightedRoundRobin, &[1, 3]);
        let mut counts = [0; 2];
        for _ in 0..40 {
            counts[legacy.candidates(None, |_| true)[0]] += 1;
        }
        assert_eq!(counts, [10, 30]);
        let uniform = make_pool(PoolStrategy::Weighted, &[0, 0]);
        assert_eq!(choose(&uniform, &request_facts(), &facts[..2], 0.75), 1);
    }

    #[test]
    fn random_cycles_without_replacement_while_strict_draws_can_repeat() {
        let random = make_pool(PoolStrategy::Random, &[1, 9, 1]);
        let strict = make_pool(PoolStrategy::StrictRandom, &[1, 9, 1]);
        let facts = vec![MemberSignals::default(); 3];
        let picks: Vec<_> = (0..12)
            .map(|_| choose(&random, &request_facts(), &facts, 0.0))
            .collect();
        for cycle in picks.chunks(3) {
            assert_eq!(cycle.iter().copied().collect::<HashSet<_>>().len(), 3);
        }
        for pair in picks.windows(2) {
            assert_ne!(pair[0], pair[1]);
        }
        for _ in 0..5 {
            assert_eq!(choose(&strict, &request_facts(), &facts, 0.0), 0);
        }
    }

    #[test]
    fn leases_release_current_load_on_cancellation_and_p2c_uses_it() {
        let pool = make_pool(PoolStrategy::P2c, &[1, 1]);
        for _ in 0..100 {
            pool.record_success(None, 1);
        }
        let lease = pool.acquire(0).unwrap();
        assert_eq!(pool.in_flight(0), Some(1));
        assert_eq!(
            choose(
                &pool,
                &request_facts(),
                &vec![MemberSignals::default(); 2],
                0.0
            ),
            1
        );
        drop(lease);
        assert_eq!(pool.in_flight(0), Some(0));
        assert_eq!(
            choose(
                &pool,
                &request_facts(),
                &vec![MemberSignals::default(); 2],
                0.0
            ),
            0
        );
        assert!(pool.acquire(9).is_none());
    }

    #[test]
    fn fill_first_retains_successful_backup_when_priority_recovers() {
        for strategy in [
            PoolStrategy::Priority,
            PoolStrategy::FillFirst,
            PoolStrategy::Lkgp,
        ] {
            let mut members = make_pool(strategy, &[1, 1]).members.clone();
            members[1].priority = 1;
            let pool = ProviderPool::new(members, strategy).unwrap();
            assert_eq!(pool.candidates(None, |m| m.provider == "provider-1")[0], 1);
            // Selection alone cannot establish a last-known-good member.
            assert_eq!(pool.candidates(None, |_| true)[0], 0);
            pool.record_success(None, 1);
            assert_eq!(
                pool.candidates(None, |_| true)[0],
                if strategy == PoolStrategy::Priority {
                    0
                } else {
                    1
                }
            );
        }
    }

    #[test]
    fn headroom_reset_window_and_reset_aware_disagree_for_real_facts() {
        let facts = [
            observed(0.1, 60_000),
            observed(0.9, 3_600_000),
            MemberSignals::default(),
        ];
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::Headroom, &[1, 1, 1]),
                &request_facts(),
                &facts,
                0.0
            ),
            1
        );
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::ResetAware, &[1, 1, 1]),
                &request_facts(),
                &facts,
                0.0
            ),
            1
        );
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::ResetWindow, &[1, 1, 1]),
                &request_facts(),
                &facts,
                0.0
            ),
            0
        );
        let mut stale = facts.clone();
        stale[1].observed_at_ms = Some(899);
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::Headroom, &[1, 1, 1]),
                &request_facts(),
                &stale,
                0.0
            ),
            0
        );
        stale[0].remaining_fraction = Some(f64::NAN);
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::Headroom, &[1, 1, 1]),
                &request_facts(),
                &stale,
                0.0
            ),
            0
        );
    }

    #[test]
    fn quota_weighted_uses_observed_window_score_and_inflight_not_authored_weight() {
        let facts = [
            MemberSignals {
                observed_at_ms: Some(1_000),
                quota_windows: vec![QuotaWindowSignal {
                    remaining_fraction: 0.2,
                    reset_in_ms: Some(18_000_000),
                    window_ms: Some(18_000_000),
                }],
                ..Default::default()
            },
            MemberSignals {
                observed_at_ms: Some(1_000),
                quota_windows: vec![QuotaWindowSignal {
                    remaining_fraction: 0.8,
                    reset_in_ms: Some(18_000_000),
                    window_ms: Some(18_000_000),
                }],
                ..Default::default()
            },
            MemberSignals::default(),
        ];
        let pool = make_pool(PoolStrategy::QuotaWeighted, &[99, 1, 100]);
        assert_eq!(choose(&pool, &request_facts(), &facts, 0.7), 1);
        let leases: Vec<_> = (0..4).map(|_| pool.acquire(1).unwrap()).collect();
        assert_eq!(choose(&pool, &request_facts(), &facts, 0.7), 0);
        drop(leases);
        assert_eq!(choose(&pool, &request_facts(), &facts, 0.7), 1);
        assert_eq!(
            choose(
                &pool,
                &request_facts(),
                &vec![MemberSignals::default(); 3],
                0.7
            ),
            0
        );
    }

    #[test]
    fn cost_context_and_auto_read_distinct_available_facts() {
        let facts = [
            MemberSignals {
                estimated_cost_micro_usd: Some(100),
                context_tokens: Some(8_000),
                latency_ms: Some(50),
                observed_at_ms: Some(1_000),
                ..Default::default()
            },
            MemberSignals {
                estimated_cost_micro_usd: Some(10),
                context_tokens: Some(16_000),
                latency_ms: Some(1),
                observed_at_ms: Some(1_000),
                ..Default::default()
            },
            MemberSignals {
                context_tokens: Some(128_000),
                ..Default::default()
            },
        ];
        let request = PoolRequest {
            input_tokens: Some(8_000),
            output_tokens: Some(1_000),
            ..request_facts()
        };
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::CostOptimized, &[1, 1, 1]),
                &request,
                &facts,
                0.0
            ),
            1
        );
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::ContextOptimized, &[1, 1, 1]),
                &request,
                &facts,
                0.0
            ),
            1
        );
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::Auto, &[1, 1, 1]),
                &request,
                &facts,
                0.0
            ),
            1
        );
        let huge = [
            MemberSignals {
                estimated_cost_micro_usd: Some(u64::MAX),
                ..Default::default()
            },
            MemberSignals {
                estimated_cost_micro_usd: Some(u64::MAX - 1),
                ..Default::default()
            },
        ];
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::CostOptimized, &[1, 1]),
                &request,
                &huge,
                0.0
            ),
            1
        );
    }

    #[test]
    fn context_overflow_and_known_insufficient_capacity_are_explicit() {
        let pool = make_pool(PoolStrategy::ContextRelay, &[1, 1]);
        let request = PoolRequest {
            input_tokens: Some(u64::MAX),
            output_tokens: Some(1),
            ..request_facts()
        };
        assert_eq!(
            pool.candidates_with_facts(None, &request, |_| true, |_| MemberSignals::default()),
            Err(PoolSelectionError::ContextEstimateOverflow)
        );
        let request = PoolRequest {
            input_tokens: Some(9_000),
            output_tokens: Some(1_000),
            ..request_facts()
        };
        assert_eq!(
            pool.candidates_with_facts(
                None,
                &request,
                |_| true,
                |m| MemberSignals {
                    context_tokens: Some(if m.provider == "provider-0" {
                        8_000
                    } else {
                        16_000
                    }),
                    ..Default::default()
                }
            )
            .unwrap(),
            vec![1]
        );
    }

    #[test]
    fn cache_prefix_pins_only_after_success_and_expires_before_rotation() {
        let pool = make_pool(PoolStrategy::CacheOptimized, &[1, 1]);
        let mut request = PoolRequest {
            cache_prefix: Some("prefix-a".into()),
            ..request_facts()
        };
        pool.record_success_with_facts(None, 1, &request, Some(10));
        assert_eq!(
            choose(&pool, &request, &vec![MemberSignals::default(); 2], 0.0),
            1
        );
        request.cache_prefix = Some("prefix-b".into());
        assert_eq!(
            choose(&pool, &request, &vec![MemberSignals::default(); 2], 0.0),
            0
        );
        request.cache_prefix = Some("prefix-a".into());
        request.now_ms += BINDING_IDLE_TTL.as_millis() as u64;
        assert_eq!(
            choose(&pool, &request, &vec![MemberSignals::default(); 2], 0.0),
            0
        );
    }

    #[test]
    fn signal_clock_and_cooldown_do_not_need_wallclock_sleeps() {
        let pool = make_pool(PoolStrategy::Priority, &[1, 1]);
        pool.record_rate_limit_at(0, Some(1), 1_000);
        let mut request = request_facts();
        request.now_ms = 1_999;
        assert_eq!(
            choose(&pool, &request, &vec![MemberSignals::default(); 2], 0.0),
            1
        );
        request.now_ms = 2_000;
        assert_eq!(
            choose(&pool, &request, &vec![MemberSignals::default(); 2], 0.0),
            0
        );
        let future = [
            MemberSignals::default(),
            MemberSignals {
                remaining_fraction: Some(1.0),
                observed_at_ms: Some(2_001),
                ..Default::default()
            },
        ];
        assert_eq!(
            choose(
                &make_pool(PoolStrategy::Headroom, &[1, 1]),
                &request,
                &future,
                0.0
            ),
            0
        );
    }

    fn only_auto_factor(factor: usize) -> AutoScoringWeights {
        let mut weights = AutoScoringWeights {
            quota: 0.0,
            health: 0.0,
            cost_inv: 0.0,
            latency_inv: 0.0,
            task_fit: 0.0,
            stability: 0.0,
            tier_priority: 0.0,
            tier_affinity: 0.0,
            specificity_match: 0.0,
            context_affinity: 0.0,
            cache_affinity: 0.0,
            session_availability: 0.0,
            reset_window_affinity: 0.0,
            connection_density: 0.0,
            quality: 0.0,
            reliability: 0.0,
        };
        let field = match factor {
            0 => &mut weights.quota,
            1 => &mut weights.health,
            2 => &mut weights.cost_inv,
            3 => &mut weights.latency_inv,
            4 => &mut weights.task_fit,
            5 => &mut weights.stability,
            6 => &mut weights.tier_priority,
            7 => &mut weights.tier_affinity,
            8 => &mut weights.specificity_match,
            9 => &mut weights.context_affinity,
            10 => &mut weights.cache_affinity,
            11 => &mut weights.session_availability,
            12 => &mut weights.reset_window_affinity,
            13 => &mut weights.connection_density,
            14 => &mut weights.quality,
            15 => &mut weights.reliability,
            _ => unreachable!(),
        };
        *field = 1.0;
        weights
    }

    #[test]
    fn every_auto_factor_has_a_real_discriminating_input() {
        for factor in 0..16 {
            let pool = make_pool(PoolStrategy::Auto, &[1, 1]);
            let request = PoolRequest {
                auto_weights: Some(only_auto_factor(factor)),
                ..request_facts()
            };
            let mut facts = [
                MemberSignals {
                    observed_at_ms: Some(1_000),
                    ..Default::default()
                },
                MemberSignals {
                    observed_at_ms: Some(1_000),
                    ..Default::default()
                },
            ];
            let mut lease = None;
            match factor {
                0 => {
                    facts[0].remaining_fraction = Some(0.2);
                    facts[1].remaining_fraction = Some(0.8);
                }
                1 => {
                    facts[0].health_score = Some(0.5);
                    facts[1].health_score = Some(1.0);
                }
                2 => {
                    facts[0].estimated_cost_micro_usd = Some(100);
                    facts[1].estimated_cost_micro_usd = Some(10);
                }
                3 => {
                    facts[0].latency_ms = Some(100);
                    facts[1].latency_ms = Some(10);
                }
                4 => {
                    facts[0].task_fit_score = Some(0.2);
                    facts[1].task_fit_score = Some(0.8);
                }
                5 => {
                    facts[0].latency_std_dev_ms = Some(100.0);
                    facts[1].latency_std_dev_ms = Some(0.0);
                }
                6 => {
                    facts[0].tier_priority_score = Some(0.2);
                    facts[1].tier_priority_score = Some(0.8);
                }
                7 => {
                    facts[0].tier_affinity_score = Some(0.2);
                    facts[1].tier_affinity_score = Some(0.8);
                }
                8 => {
                    facts[0].specificity_score = Some(0.2);
                    facts[1].specificity_score = Some(0.8);
                }
                9 => {
                    facts[0].context_affinity_score = Some(0.2);
                    facts[1].context_affinity_score = Some(0.8);
                }
                10 => {
                    facts[0].cache_affinity_score = Some(0.2);
                    facts[1].cache_affinity_score = Some(0.8);
                }
                11 => {
                    lease = pool.acquire(0);
                }
                12 => {
                    facts[0].reset_window_affinity_score = Some(0.2);
                    facts[1].reset_window_affinity_score = Some(0.8);
                }
                13 => {
                    facts[0].connection_pool_size = Some(1);
                    facts[1].connection_pool_size = Some(11);
                }
                14 => {
                    facts[0].quality_score = Some(0.2);
                    facts[1].quality_score = Some(0.8);
                }
                15 => {
                    facts[0].reliability_score = Some(0.2);
                    facts[1].reliability_score = Some(0.8);
                }
                _ => unreachable!(),
            }
            assert_eq!(
                choose(&pool, &request, &facts, 0.0),
                1,
                "Auto factor {factor} must affect ranking"
            );
            drop(lease);
        }
        assert!(
            (AutoScoringWeights::default()
                .normalized()
                .iter()
                .sum::<f64>()
                - 1.0)
                .abs()
                < 1e-10
        );
    }

    #[test]
    fn reliability_and_latency_feedback_are_fresh_bounded_observations() {
        let pool = make_pool(PoolStrategy::Auto, &[1, 1]);
        let mut request = PoolRequest {
            auto_weights: Some(only_auto_factor(15)),
            ..request_facts()
        };
        pool.record_failure(0, request.now_ms);
        assert_eq!(
            choose(&pool, &request, &vec![MemberSignals::default(); 2], 0.0),
            1
        );
        for _ in 0..201 {
            pool.record_success_with_facts(None, 0, &request, Some(10));
        }
        assert_eq!(pool.state.lock().unwrap().feedback[0].len(), 200);
        assert_eq!(pool.state.lock().unwrap().latency_samples[0].len(), 200);
        assert_eq!(
            choose(&pool, &request, &vec![MemberSignals::default(); 2], 0.0),
            0
        );
        pool.record_failure(0, request.now_ms);
        request.now_ms += request.signal_max_age_ms + 1;
        assert_eq!(
            choose(&pool, &request, &vec![MemberSignals::default(); 2], 0.0),
            0
        );
    }

    #[test]
    fn lkgp_never_binds_a_speculative_session_and_relay_preserves_priority() {
        let lkgp = make_pool(PoolStrategy::Lkgp, &[1, 1]);
        assert_eq!(lkgp.candidates(Some("conversation"), |_| true)[0], 0);
        assert!(lkgp.state.lock().unwrap().bindings.is_empty());
        lkgp.record_success(Some("conversation"), 1);
        assert_eq!(lkgp.candidates(Some("conversation"), |_| true)[0], 1);
        let relay = make_pool(PoolStrategy::ContextRelay, &[1, 1]);
        assert_eq!(relay.candidates(None, |_| true)[0], 0);
        assert_eq!(relay.candidates(None, |_| true)[0], 0);
    }

    #[test]
    fn proven_prefix_precedes_tentative_pick_but_not_confirmed_conversation() {
        let pool = make_pool(PoolStrategy::CacheOptimized, &[1, 1]);
        let request = PoolRequest {
            cache_prefix: Some("prefix".into()),
            ..request_facts()
        };
        pool.record_success_with_facts(None, 1, &request, None);
        // Establish an unconfirmed pick on A, without the prefix.
        pool.candidates_with_facts(
            Some("tentative"),
            &request_facts(),
            |_| true,
            |_| MemberSignals::default(),
        )
        .unwrap();
        assert_eq!(
            pool.candidates_with_facts(
                Some("tentative"),
                &request,
                |_| true,
                |_| MemberSignals::default()
            )
            .unwrap()[0],
            1
        );
        pool.record_success_with_facts(Some("confirmed"), 0, &request_facts(), None);
        assert_eq!(
            pool.candidates_with_facts(
                Some("confirmed"),
                &request,
                |_| true,
                |_| MemberSignals::default()
            )
            .unwrap()[0],
            0
        );
    }

    #[test]
    fn a_provider_can_supply_distinct_models_without_duplicate_pairs() {
        let mut members = make_pool(PoolStrategy::Priority, &[1, 1]).members.clone();
        members[1].provider = members[0].provider.clone();
        assert!(ProviderPool::new(members.clone(), PoolStrategy::Fusion).is_ok());
        members[1].model = members[0].model.clone();
        assert!(ProviderPool::new(members, PoolStrategy::Fusion).is_err());
    }

    #[test]
    fn session_and_prefix_state_are_bounded_and_oversized_keys_are_not_retained() {
        let pool = make_pool(PoolStrategy::CacheOptimized, &[1]);
        let oversized = "x".repeat(513);
        let request = PoolRequest {
            cache_prefix: Some(oversized.clone()),
            ..request_facts()
        };
        pool.record_success_with_facts(Some(&oversized), 0, &request, None);
        assert!(pool.state.lock().unwrap().bindings.is_empty());
        assert!(pool.state.lock().unwrap().cache_bindings.is_empty());
        for i in 0..=MAX_BINDINGS {
            let request = PoolRequest {
                now_ms: i as u64,
                cache_prefix: Some(format!("prefix-{i}")),
                ..request_facts()
            };
            pool.record_success_with_facts(Some(&format!("session-{i}")), 0, &request, None);
        }
        let state = pool.state.lock().unwrap();
        assert_eq!(state.bindings.len(), MAX_BINDINGS);
        assert_eq!(state.cache_bindings.len(), MAX_BINDINGS);
        assert!(!state.bindings.contains_key("session-0"));
        assert!(!state.cache_bindings.contains_key("prefix-0"));
    }
}

pub struct PoolLease {
    pool: Arc<ProviderPool>,
    member: usize,
}
impl Drop for PoolLease {
    fn drop(&mut self) {
        let mut state = self
            .pool
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.inflight[self.member] = state.inflight[self.member].saturating_sub(1);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}
fn bounded_key(key: Option<&str>) -> Option<&str> {
    key.filter(|key| !key.is_empty() && key.len() <= 512)
}
fn expire_bindings(bindings: &mut HashMap<String, Binding>, now: u64) {
    bindings.retain(|_, binding| {
        now.saturating_sub(binding.last_used) < BINDING_IDLE_TTL.as_millis() as u64
    });
}
fn push_sample<T>(samples: &mut std::collections::VecDeque<T>, value: T) {
    if samples.len() >= 200 {
        samples.pop_front();
    }
    samples.push_back(value);
}
fn bind(
    bindings: &mut HashMap<String, Binding>,
    id: &str,
    member: usize,
    now: u64,
    confirmed: bool,
) {
    if bindings.len() >= MAX_BINDINGS && !bindings.contains_key(id) {
        if let Some(oldest) = bindings
            .iter()
            .min_by_key(|(_, value)| value.last_used)
            .map(|(key, _)| key.clone())
        {
            bindings.remove(&oldest);
        }
    }
    let confirmed = confirmed
        || bindings
            .get(id)
            .is_some_and(|old| old.member == member && old.confirmed);
    bindings.insert(
        id.to_owned(),
        Binding {
            member,
            last_used: now,
            confirmed,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_delay_ignores_disabled_and_unexecutable_members() {
        let pool = ProviderPool::new(members(&[1, 1]), PoolStrategy::Priority).unwrap();
        pool.record_rate_limit(0, Some(1));
        assert!(pool
            .next_cooldown_delay(|member| member.provider == "provider-1")
            .is_none());
        assert!(pool
            .next_cooldown_delay(|_| true)
            .is_some_and(|delay| delay <= Duration::from_secs(1)));
        assert_eq!(pool.candidates(Some("warm"), |_| true), vec![1]);
    }

    #[test]
    fn overflowing_retry_after_does_not_immediately_restore_a_failed_member() {
        let pool = ProviderPool::new(members(&[1, 1]), PoolStrategy::RoundRobin).unwrap();
        pool.record_rate_limit(0, Some(u64::MAX));
        assert_eq!(pool.candidates(None, |_| true), vec![1]);
    }

    fn members(weights: &[u16]) -> Vec<PoolMember> {
        weights
            .iter()
            .enumerate()
            .map(|(index, weight)| PoolMember {
                provider: format!("provider-{index}"),
                model: format!("upstream-model-{index}"),
                priority: 0,
                weight: *weight,
                enabled: true,
                last_resort: false,
            })
            .collect()
    }

    #[test]
    fn round_robin_keeps_sessions_sticky_and_exposes_member_models() {
        let pool = ProviderPool::new(members(&[1, 1, 1]), PoolStrategy::RoundRobin).unwrap();
        assert_eq!(pool.candidates(Some("a"), |_| true)[0], 0);
        assert_eq!(pool.candidates(Some("b"), |_| true)[0], 1);
        assert_eq!(pool.candidates(Some("a"), |_| true)[0], 0);
        assert_eq!(pool.member(1).unwrap().model, "upstream-model-1");
    }

    #[test]
    fn last_resort_is_deferred_for_new_sessions_but_keeps_existing_affinity() {
        let mut routes = members(&[1, 1, 1]);
        routes[0].last_resort = true;
        routes[0].priority = 0;
        routes[1].priority = 10;
        routes[2].priority = 10;
        let pool = ProviderPool::new(routes, PoolStrategy::RoundRobin).unwrap();

        assert_eq!(pool.candidates(Some("one"), |_| true), vec![1, 2, 0]);
        assert_eq!(pool.candidates(Some("two"), |_| true), vec![2, 1, 0]);
        assert_eq!(
            pool.candidates(Some("emergency"), |member| { member.last_resort }),
            vec![0]
        );
        assert_eq!(pool.candidates(Some("emergency"), |_| true)[0], 0);
        pool.record_rate_limit(1, Some(60));
        pool.record_rate_limit(2, Some(60));
        assert_eq!(pool.candidates(Some("new"), |_| true), vec![0]);
    }

    #[test]
    fn round_robin_batches_new_sessions_without_moving_bound_sessions() {
        let pool =
            ProviderPool::new_with_sticky_limit(members(&[1, 1]), PoolStrategy::RoundRobin, 2)
                .unwrap();
        assert_eq!(pool.candidates(Some("a"), |_| true)[0], 0);
        assert_eq!(pool.candidates(Some("b"), |_| true)[0], 0);
        assert_eq!(pool.candidates(Some("c"), |_| true)[0], 1);
        assert_eq!(pool.candidates(Some("a"), |_| true)[0], 0);
        assert_eq!(pool.candidates(Some("d"), |_| true)[0], 1);
        assert_eq!(pool.candidates(Some("e"), |_| true)[0], 0);
    }

    #[test]
    fn round_robin_batch_moves_when_its_member_cools() {
        let pool =
            ProviderPool::new_with_sticky_limit(members(&[1, 1]), PoolStrategy::RoundRobin, 3)
                .unwrap();
        assert_eq!(pool.candidates(None, |_| true)[0], 0);
        pool.record_rate_limit(0, Some(60));
        assert_eq!(pool.candidates(None, |_| true)[0], 1);
        assert_eq!(pool.candidates(None, |_| true)[0], 1);
        assert!(
            ProviderPool::new_with_sticky_limit(members(&[1, 1]), PoolStrategy::RoundRobin, 0,)
                .is_err()
        );
    }

    #[test]
    fn priority_and_health_limit_the_candidate_set() {
        let mut configured = members(&[1, 1, 1]);
        configured[0].priority = 2;
        configured[2].priority = 1;
        let pool = ProviderPool::new(configured, PoolStrategy::Priority).unwrap();
        assert_eq!(pool.candidates(None, |_| true), vec![1, 2, 0]);
        assert_eq!(
            pool.candidates(None, |member| member.provider != "provider-1"),
            vec![2, 0]
        );
    }

    #[test]
    fn fill_first_drains_one_member_before_using_a_backup() {
        let pool = ProviderPool::new(members(&[1, 1]), PoolStrategy::FillFirst).unwrap();
        assert_eq!(pool.candidates(Some("first"), |_| true)[0], 0);
        assert_eq!(pool.candidates(Some("second"), |_| true)[0], 0);
        pool.record_rate_limit(0, Some(30));
        assert_eq!(pool.candidates(Some("third"), |_| true)[0], 1);
        pool.record_success(Some("first"), 1);
        assert_eq!(pool.candidates(Some("first"), |_| true)[0], 1);
    }

    #[test]
    fn least_used_tracks_current_load_and_preserves_session_affinity() {
        let pool =
            Arc::new(ProviderPool::new(members(&[1, 1, 1]), PoolStrategy::LeastUsed).unwrap());
        pool.record_success(None, 0);
        assert_eq!(pool.candidates(Some("a"), |_| true)[0], 0);
        let lease = pool.acquire(0).unwrap();
        assert_eq!(pool.candidates(Some("b"), |_| true)[0], 1);
        assert_eq!(pool.candidates(Some("a"), |_| true)[0], 0);
        drop(lease);
        assert_eq!(pool.candidates(None, |_| true)[0], 0);
    }

    #[test]
    fn weighted_draw_only_uses_eligible_top_tier_members() {
        let mut configured = members(&[1, 4, 1]);
        configured[2].priority = 1;
        let pool = ProviderPool::new(configured, PoolStrategy::Weighted).unwrap();
        for _ in 0..100 {
            assert!(matches!(pool.candidates(None, |_| true)[0], 0 | 1));
        }
        pool.record_rate_limit(1, Some(30));
        for _ in 0..10 {
            assert_eq!(pool.candidates(None, |_| true)[0], 0);
        }
    }

    #[test]
    fn recovered_higher_priority_does_not_move_an_active_session() {
        let mut configured = members(&[1, 1]);
        configured[1].priority = 1;
        let pool = ProviderPool::new(configured, PoolStrategy::Priority).unwrap();
        assert_eq!(
            pool.candidates(Some("conversation"), |member| member.provider
                != "provider-0")[0],
            1
        );
        assert_eq!(pool.candidates(Some("conversation"), |_| true)[0], 1);
        assert_eq!(pool.candidates(Some("new-conversation"), |_| true)[0], 0);
    }

    #[test]
    fn rate_limit_moves_a_sticky_session_then_rebinds_it() {
        let pool = ProviderPool::new(members(&[1, 1]), PoolStrategy::RoundRobin).unwrap();
        assert_eq!(pool.candidates(Some("a"), |_| true)[0], 0);
        pool.record_rate_limit(0, Some(30));
        assert_eq!(pool.candidates(Some("a"), |_| true), vec![1]);
        pool.record_success(Some("a"), 1);
        assert_eq!(pool.candidates(Some("a"), |_| true)[0], 1);
        pool.record_rate_limit(1, Some(30));
        assert!(pool.candidates(Some("a"), |_| true).is_empty());
    }

    #[test]
    fn weighted_rotation_converges_without_burst_after_cooldown() {
        let pool =
            ProviderPool::new(members(&[5, 3, 2]), PoolStrategy::WeightedRoundRobin).unwrap();
        let mut counts = [0; 3];
        for _ in 0..100 {
            counts[pool.candidates(None, |_| true)[0]] += 1;
        }
        assert_eq!(counts, [50, 30, 20]);
        pool.record_rate_limit(0, Some(30));
        let mut remaining = [0; 3];
        for _ in 0..50 {
            remaining[pool.candidates(None, |_| true)[0]] += 1;
        }
        assert_eq!(remaining, [0, 30, 20]);
    }

    #[test]
    fn rejects_ambiguous_or_unusable_members() {
        assert!(ProviderPool::new(Vec::new(), PoolStrategy::Priority).is_err());
        let mut duplicate = members(&[1, 1]);
        duplicate[1].provider = duplicate[0].provider.clone();
        duplicate[1].model = duplicate[0].model.clone();
        assert!(ProviderPool::new(duplicate, PoolStrategy::Priority).is_err());
        let mut disabled = members(&[1]);
        disabled[0].enabled = false;
        assert!(ProviderPool::new(disabled, PoolStrategy::Priority).is_err());
        let mut blank_model = members(&[1]);
        blank_model[0].model = " ".to_owned();
        assert!(ProviderPool::new(blank_model, PoolStrategy::Priority).is_err());
    }
}
