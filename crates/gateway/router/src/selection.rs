//! Pure strategy ordering. Execution strategies remain explicit host work.
use serde::{Deserialize, Serialize};

use super::{PoolMember, State};

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CanonicalPoolStrategy {
    Priority,
    Weighted,
    #[default]
    RoundRobin,
    ContextRelay,
    FillFirst,
    P2c,
    Random,
    LeastUsed,
    CostOptimized,
    ResetAware,
    ResetWindow,
    Headroom,
    StrictRandom,
    Auto,
    Lkgp,
    ContextOptimized,
    CacheOptimized,
    Fusion,
    Pipeline,
    QuotaWeighted,
    #[serde(rename = "weighted_round_robin")]
    LegacyWeightedRoundRobin,
}

impl CanonicalPoolStrategy {
    pub const ALL: [Self; 21] = [
        Self::Priority,
        Self::Weighted,
        Self::RoundRobin,
        Self::ContextRelay,
        Self::FillFirst,
        Self::P2c,
        Self::Random,
        Self::LeastUsed,
        Self::CostOptimized,
        Self::ResetAware,
        Self::ResetWindow,
        Self::Headroom,
        Self::StrictRandom,
        Self::Auto,
        Self::Lkgp,
        Self::ContextOptimized,
        Self::CacheOptimized,
        Self::Fusion,
        Self::Pipeline,
        Self::QuotaWeighted,
        Self::LegacyWeightedRoundRobin,
    ];

    // Retain the existing Rust spelling without conflating canonical weighted draw.
    #[allow(non_upper_case_globals)]
    pub const WeightedRoundRobin: Self = Self::LegacyWeightedRoundRobin;

    pub fn is_chat_only(self) -> bool {
        matches!(
            self,
            Self::Fusion
                | Self::Pipeline
                | Self::ContextRelay
                | Self::ContextOptimized
                | Self::CacheOptimized
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PoolSelectionError {
    ExecutionRequired(CanonicalPoolStrategy),
    ContextEstimateOverflow,
}

impl std::fmt::Display for PoolSelectionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ExecutionRequired(strategy) => {
                write!(f, "{strategy:?} requires a chat execution plan")
            }
            Self::ContextEstimateOverflow => {
                f.write_str("context estimate exceeds supported range")
            }
        }
    }
}
impl std::error::Error for PoolSelectionError {}

#[derive(Clone, Debug)]
pub struct PoolRequest {
    pub now_ms: u64,
    pub signal_max_age_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_prefix: Option<String>,
    pub auto_weights: Option<AutoScoringWeights>,
}
impl Default for PoolRequest {
    fn default() -> Self {
        Self {
            now_ms: super::now_ms(),
            signal_max_age_ms: 300_000,
            input_tokens: None,
            output_tokens: None,
            cache_prefix: None,
            auto_weights: None,
        }
    }
}
impl PoolRequest {
    pub(super) fn context_required(&self) -> Result<Option<u64>, PoolSelectionError> {
        match (self.input_tokens, self.output_tokens) {
            (None, None) => Ok(None),
            (input, output) => input
                .unwrap_or(0)
                .checked_add(output.unwrap_or(0))
                .map(Some)
                .ok_or(PoolSelectionError::ContextEstimateOverflow),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct MemberSignals {
    pub estimated_cost_micro_usd: Option<u64>,
    pub remaining_fraction: Option<f64>,
    pub reset_in_ms: Option<u64>,
    pub reset_window_ms: Option<u64>,
    pub context_tokens: Option<u64>,
    pub latency_ms: Option<u64>,
    pub cache_affinity_score: Option<f64>,
    pub observed_at_ms: Option<u64>,
    pub quota_windows: Vec<QuotaWindowSignal>,
    pub health_score: Option<f64>,
    pub task_fit_score: Option<f64>,
    pub tier_priority_score: Option<f64>,
    pub tier_affinity_score: Option<f64>,
    pub specificity_score: Option<f64>,
    pub context_affinity_score: Option<f64>,
    pub session_availability_score: Option<f64>,
    pub reset_window_affinity_score: Option<f64>,
    pub quality_score: Option<f64>,
    pub reliability_score: Option<f64>,
    pub latency_std_dev_ms: Option<f64>,
    pub connection_pool_size: Option<u32>,
}

#[derive(Clone, Debug)]
pub struct QuotaWindowSignal {
    pub remaining_fraction: f64,
    pub reset_in_ms: Option<u64>,
    pub window_ms: Option<u64>,
}

/// Pinned OmniRoute default weights. Configured missing fields deserialize as
/// zero before normalization; absent configuration uses the full default set.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AutoScoringWeights {
    #[serde(default)]
    pub quota: f64,
    #[serde(default)]
    pub health: f64,
    #[serde(default)]
    pub cost_inv: f64,
    #[serde(default)]
    pub latency_inv: f64,
    #[serde(default)]
    pub task_fit: f64,
    #[serde(default)]
    pub stability: f64,
    #[serde(default)]
    pub tier_priority: f64,
    #[serde(default)]
    pub tier_affinity: f64,
    #[serde(default)]
    pub specificity_match: f64,
    #[serde(default)]
    pub context_affinity: f64,
    #[serde(default)]
    pub cache_affinity: f64,
    #[serde(default)]
    pub session_availability: f64,
    #[serde(default)]
    pub reset_window_affinity: f64,
    #[serde(default)]
    pub connection_density: f64,
    #[serde(default)]
    pub quality: f64,
    #[serde(default)]
    pub reliability: f64,
}
impl Default for AutoScoringWeights {
    fn default() -> Self {
        Self {
            quota: 0.1429,
            health: 0.1605,
            cost_inv: 0.1429,
            latency_inv: 0.1143,
            task_fit: 0.0762,
            stability: 0.0476,
            tier_priority: 0.0476,
            tier_affinity: 0.0476,
            specificity_match: 0.0476,
            context_affinity: 0.0476,
            cache_affinity: 0.0,
            session_availability: 0.0476,
            reset_window_affinity: 0.0,
            connection_density: 0.0476,
            quality: 0.03,
            reliability: 0.0,
        }
    }
}
impl AutoScoringWeights {
    pub fn normalized(&self) -> [f64; 16] {
        let values = [
            self.quota,
            self.health,
            self.cost_inv,
            self.latency_inv,
            self.task_fit,
            self.stability,
            self.tier_priority,
            self.tier_affinity,
            self.specificity_match,
            self.context_affinity,
            self.cache_affinity,
            self.session_availability,
            self.reset_window_affinity,
            self.connection_density,
            self.quality,
            self.reliability,
        ];
        let clean = values.map(|v| if v.is_finite() && v >= 0.0 { v } else { 0.0 });
        let total: f64 = clean.iter().sum();
        if total > 0.0 && total.is_finite() {
            clean.map(|v| v / total)
        } else {
            Self::default().normalized()
        }
    }
}
impl MemberSignals {
    pub(super) fn fresh(&self, request: &PoolRequest) -> bool {
        self.observed_at_ms.is_some_and(|at| {
            at <= request.now_ms && request.now_ms - at <= request.signal_max_age_ms
        })
    }
    pub(super) fn remaining(&self, request: &PoolRequest) -> Option<f64> {
        self.remaining_fraction
            .filter(|value| self.fresh(request) && value.is_finite() && (0.0..=1.0).contains(value))
            .into_iter()
            .chain(
                valid_windows(self, request)
                    .into_iter()
                    .map(|w| w.remaining_fraction),
            )
            .min_by(f64::total_cmp)
    }
}

fn valid_windows<'a>(
    facts: &'a MemberSignals,
    request: &PoolRequest,
) -> Vec<&'a QuotaWindowSignal> {
    if !facts.fresh(request) || facts.quota_windows.len() > 8 {
        return Vec::new();
    }
    facts
        .quota_windows
        .iter()
        .filter(|w| w.remaining_fraction.is_finite() && (0.0..=1.0).contains(&w.remaining_fraction))
        .collect()
}

fn reset_remaining(facts: &MemberSignals, request: &PoolRequest) -> Option<u64> {
    if !facts.fresh(request) {
        return None;
    }
    facts
        .reset_in_ms
        .into_iter()
        .chain(
            valid_windows(facts, request)
                .into_iter()
                .filter_map(|w| w.reset_in_ms),
        )
        .min()
}

fn score_window(
    window: &QuotaWindowSignal,
    duration: u64,
    remaining_weight: f64,
    reset_weight: f64,
) -> f64 {
    let urgency = window
        .reset_in_ms
        .map(|reset| 1.0 - (reset as f64 / duration as f64).clamp(0.0, 1.0))
        .unwrap_or(0.5);
    remaining_weight * window.remaining_fraction
        + reset_weight * urgency * (1.0 - window.remaining_fraction)
}

fn quota_score(facts: &MemberSignals, request: &PoolRequest) -> Option<f64> {
    const SESSION: u64 = 5 * 60 * 60 * 1000;
    const WEEKLY: u64 = 7 * 24 * 60 * 60 * 1000;
    let windows = valid_windows(facts, request);
    let session = windows
        .iter()
        .filter(|w| w.window_ms == Some(SESSION))
        .min_by(|a, b| a.remaining_fraction.total_cmp(&b.remaining_fraction));
    let weekly = windows
        .iter()
        .filter(|w| w.window_ms == Some(WEEKLY))
        .min_by(|a, b| a.remaining_fraction.total_cmp(&b.remaining_fraction));
    if session.is_none() && weekly.is_none() {
        // An overall/unnamed measurement is not two named observations.
        return facts.remaining(request);
    }
    // Missing buckets contribute only internal neutral scores, not telemetry.
    let session_score = session
        .map(|w| score_window(w, SESSION, 0.45, 0.55))
        .unwrap_or(0.5);
    let weekly_score = weekly
        .map(|w| score_window(w, WEEKLY, 0.25, 0.75))
        .unwrap_or(0.5);
    let mut score = 0.35 * session_score + 0.65 * weekly_score;
    if let Some(window) = session.filter(|w| w.remaining_fraction < 0.1) {
        score *= (window.remaining_fraction / 0.1).max(0.05);
    }
    Some(score)
}

fn bounded_score(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
}
fn recent_latencies(state: &State, member: usize, request: &PoolRequest) -> Vec<f64> {
    state.latency_samples[member]
        .iter()
        .filter(|(at, _)| *at <= request.now_ms && request.now_ms - at <= request.signal_max_age_ms)
        .map(|(_, ms)| *ms as f64)
        .collect()
}
fn observed_latency(
    facts: &MemberSignals,
    state: &State,
    member: usize,
    request: &PoolRequest,
) -> Option<f64> {
    facts
        .latency_ms
        .filter(|_| facts.fresh(request))
        .map(|ms| ms as f64)
        .or_else(|| {
            let mut values = recent_latencies(state, member, request);
            if values.is_empty() {
                return None;
            }
            values.sort_by(f64::total_cmp);
            Some(values[((values.len() * 95).div_ceil(100) - 1).min(values.len() - 1)])
        })
}
fn observed_stddev(
    facts: &MemberSignals,
    state: &State,
    member: usize,
    request: &PoolRequest,
) -> Option<f64> {
    facts
        .latency_std_dev_ms
        .filter(|v| facts.fresh(request) && v.is_finite() && *v >= 0.0)
        .or_else(|| {
            let values = recent_latencies(state, member, request);
            if values.len() < 2 {
                return None;
            }
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            Some(
                (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64)
                    .sqrt(),
            )
        })
}
fn observed_reliability(state: &State, member: usize, request: &PoolRequest) -> Option<f64> {
    let samples: Vec<bool> = state.feedback[member]
        .iter()
        .filter(|(at, _)| *at <= request.now_ms && request.now_ms - at <= request.signal_max_age_ms)
        .map(|(_, success)| *success)
        .collect();
    (!samples.is_empty())
        .then(|| samples.iter().filter(|success| **success).count() as f64 / samples.len() as f64)
}

fn auto_score(
    member: usize,
    top: &[usize],
    facts: &[MemberSignals],
    state: &State,
    request: &PoolRequest,
) -> f64 {
    let f = &facts[member];
    let max_cost = top
        .iter()
        .filter_map(|i| facts[*i].estimated_cost_micro_usd)
        .max()
        .unwrap_or(1)
        .max(1) as f64;
    let max_latency = top
        .iter()
        .filter_map(|i| observed_latency(&facts[*i], state, *i, request))
        .max_by(f64::total_cmp)
        .unwrap_or(1.0)
        .max(1.0);
    let max_std = top
        .iter()
        .filter_map(|i| observed_stddev(&facts[*i], state, *i, request))
        .max_by(f64::total_cmp)
        .unwrap_or(1.0)
        .max(1.0);
    let reliability = bounded_score(f.reliability_score)
        .filter(|_| f.fresh(request))
        .or_else(|| observed_reliability(state, member, request))
        .unwrap_or(1.0);
    let fresh = |v| bounded_score(v).filter(|_| f.fresh(request));
    let cache = bounded_score(f.cache_affinity_score).unwrap_or_else(|| {
        request
            .cache_prefix
            .as_deref()
            .and_then(|key| state.cache_bindings.get(key))
            .map(|b| if b.member == member { 1.0 } else { 0.0 })
            .unwrap_or(0.0)
    });
    let reset = fresh(f.reset_window_affinity_score)
        .or_else(|| {
            f.reset_in_ms
                .zip(f.reset_window_ms)
                .filter(|(_, window)| f.fresh(request) && *window > 0)
                .map(|(reset, window)| 1.0 - (reset as f64 / window as f64).clamp(0.0, 1.0))
        })
        .unwrap_or(0.5);
    // Cold defaults are ranking heuristics only. They never populate telemetry.
    let factors = [
        f.remaining(request).unwrap_or(0.5),
        fresh(f.health_score).unwrap_or(1.0),
        f.estimated_cost_micro_usd
            .map(|cost| (1.0 - cost as f64 / max_cost).clamp(0.0, 1.0))
            .unwrap_or(0.0),
        observed_latency(f, state, member, request)
            .map(|ms| (1.0 - ms / max_latency).clamp(0.0, 1.0))
            .unwrap_or(0.0),
        bounded_score(f.task_fit_score).unwrap_or(0.5),
        observed_stddev(f, state, member, request)
            .map(|sd| (1.0 - sd / max_std).clamp(0.0, 1.0))
            .unwrap_or(0.5),
        bounded_score(f.tier_priority_score).unwrap_or(0.5),
        bounded_score(f.tier_affinity_score).unwrap_or(0.5),
        bounded_score(f.specificity_score).unwrap_or(0.5),
        bounded_score(f.context_affinity_score).unwrap_or(0.5),
        cache,
        fresh(f.session_availability_score).unwrap_or(1.0 / (1.0 + state.inflight[member] as f64)),
        reset,
        (f.connection_pool_size.unwrap_or(1).saturating_sub(1) as f64 / 10.0).clamp(0.0, 1.0),
        fresh(f.quality_score).unwrap_or(0.5),
        reliability,
    ];
    let weights = request
        .auto_weights
        .clone()
        .unwrap_or_default()
        .normalized();
    factors
        .into_iter()
        .zip(weights)
        .map(|(factor, weight)| factor * weight)
        .sum::<f64>()
        .clamp(0.0, 1.0)
}

fn unit(rng: &mut impl FnMut() -> f64) -> f64 {
    let draw = rng();
    if draw.is_finite() {
        draw.clamp(0.0, 1.0 - f64::EPSILON)
    } else {
        0.0
    }
}
fn index(len: usize, rng: &mut impl FnMut() -> f64) -> usize {
    (unit(rng) * len as f64) as usize
}
fn weighted(top: &[usize], weights: impl Fn(usize) -> f64, rng: &mut impl FnMut() -> f64) -> usize {
    let total: f64 = top.iter().map(|i| weights(*i)).sum();
    if total <= 0.0 {
        return top[index(top.len(), rng)];
    }
    let mut draw = unit(rng) * total;
    for i in top {
        let weight = weights(*i);
        if weight > 0.0 && draw < weight {
            return *i;
        }
        draw -= weight;
    }
    *top.iter()
        .rev()
        .find(|i| weights(**i) > 0.0)
        .expect("positive total")
}
fn promote(order: &mut Vec<usize>, winner: usize) {
    order.retain(|i| *i != winner);
    order.insert(0, winner);
}
fn rank(order: &mut [usize], score: impl Fn(usize) -> Option<f64>) {
    order.sort_by(|a, b| match (score(*a), score(*b)) {
        (Some(a), Some(b)) => b.total_cmp(&a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}

fn smallest_known<T: Ord>(order: &mut [usize], value: impl Fn(usize) -> Option<T>) {
    order.sort_by(|a, b| match (value(*a), value(*b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
}

pub(super) fn order(
    strategy: CanonicalPoolStrategy,
    members: &[PoolMember],
    state: &mut State,
    mut eligible: Vec<usize>,
    request: &PoolRequest,
    facts: &[MemberSignals],
    sticky_limit: u8,
    rng: &mut impl FnMut() -> f64,
) -> Vec<usize> {
    use CanonicalPoolStrategy as S;
    let first = eligible[0];
    let top: Vec<usize> = eligible
        .iter()
        .copied()
        .take_while(|i| {
            members[*i].last_resort == members[first].last_resort
                && members[*i].priority == members[first].priority
        })
        .collect();
    let mut ranked = top.clone();
    let winner = match strategy {
        S::Priority | S::ContextRelay => first,
        S::FillFirst => state
            .fill_active
            .filter(|i| {
                eligible.contains(i) && members[*i].last_resort == members[first].last_resort
            })
            .unwrap_or(first),
        S::RoundRobin => {
            if let Some(current) = state
                .round_robin_member
                .filter(|i| top.contains(i) && state.round_robin_assignments < sticky_limit)
            {
                state.round_robin_assignments += 1;
                current
            } else {
                let winner = top[state.cursor % top.len()];
                state.cursor = state.cursor.wrapping_add(1);
                state.round_robin_member = Some(winner);
                state.round_robin_assignments = 1;
                winner
            }
        }
        S::LegacyWeightedRoundRobin => {
            let total: i64 = top.iter().map(|i| i64::from(members[*i].weight)).sum();
            for i in &top {
                state.smooth_weights[*i] += i64::from(members[*i].weight);
            }
            let winner = *top
                .iter()
                .max_by_key(|i| (state.smooth_weights[**i], -(**i as i64)))
                .unwrap();
            state.smooth_weights[winner] -= total;
            winner
        }
        S::Weighted => {
            let winner = weighted(&top, |i| f64::from(members[i].weight), rng);
            ranked.sort_by_key(|i| std::cmp::Reverse(members[*i].weight));
            promote(&mut ranked, winner);
            winner
        }
        S::StrictRandom => top[index(top.len(), rng)],
        S::Random => {
            if state.random_members != top || state.random_deck.is_empty() {
                state.random_members.clone_from(&top);
                state.random_deck.clone_from(&top);
                for i in (1..state.random_deck.len()).rev() {
                    let other = index(i + 1, rng);
                    state.random_deck.swap(i, other);
                }
                if state.random_deck.len() > 1
                    && state.random_deck.last().copied() == state.last_random
                {
                    let last = state.random_deck.len() - 1;
                    state.random_deck.swap(0, last);
                }
            }
            let winner = state.random_deck.pop().unwrap();
            state.last_random = Some(winner);
            winner
        }
        S::LeastUsed => *top
            .iter()
            .min_by_key(|i| (state.inflight[**i], **i))
            .unwrap(),
        S::P2c => {
            if top.len() == 1 {
                top[0]
            } else {
                let a = index(top.len(), rng);
                let mut b = index(top.len() - 1, rng);
                if b >= a {
                    b += 1;
                }
                if (state.inflight[top[b]], top[b]) < (state.inflight[top[a]], top[a]) {
                    top[b]
                } else {
                    top[a]
                }
            }
        }
        S::Lkgp => state
            .last_good
            .filter(|i| {
                eligible.contains(i) && members[*i].last_resort == members[first].last_resort
            })
            .unwrap_or(first),
        S::CostOptimized => {
            smallest_known(&mut ranked, |i| facts[i].estimated_cost_micro_usd);
            ranked[0]
        }
        S::Headroom => {
            rank(&mut ranked, |i| facts[i].remaining(request));
            ranked[0]
        }
        S::ResetWindow => {
            smallest_known(&mut ranked, |i| reset_remaining(&facts[i], request));
            ranked[0]
        }
        S::ResetAware => {
            rank(&mut ranked, |i| quota_score(&facts[i], request));
            ranked[0]
        }
        S::QuotaWeighted => {
            let observed: Vec<usize> = top
                .iter()
                .copied()
                .filter(|i| quota_score(&facts[*i], request).is_some())
                .collect();
            if observed.is_empty() {
                first
            } else {
                weighted(
                    &observed,
                    |i| {
                        quota_score(&facts[i], request).unwrap().max(0.0)
                            / (1.0 + state.inflight[i] as f64)
                    },
                    rng,
                )
            }
        }
        S::ContextOptimized => {
            if request.input_tokens.is_some() || request.output_tokens.is_some() {
                smallest_known(&mut ranked, |i| facts[i].context_tokens);
            }
            ranked[0]
        }
        S::CacheOptimized => {
            rank(&mut ranked, |i| {
                facts[i]
                    .cache_affinity_score
                    .filter(|score| score.is_finite() && (0.0..=1.0).contains(score))
            });
            ranked[0]
        }
        S::Auto => {
            rank(&mut ranked, |i| {
                Some(auto_score(i, &top, facts, state, request))
            });
            ranked[0]
        }
        S::Fusion | S::Pipeline => unreachable!("execution plans are checked before ordering"),
    };
    // Preserve strategy-ranked fallbacks within the chosen priority group.
    let top_set: std::collections::HashSet<usize> = ranked.iter().copied().collect();
    eligible.retain(|i| !top_set.contains(i));
    ranked.extend(eligible);
    promote(&mut ranked, winner);
    ranked
}

#[cfg(test)]
mod window_scoring_tests {
    use super::*;

    #[test]
    fn distinct_known_windows_use_exact_pinned_coefficients() {
        let request = PoolRequest {
            now_ms: 1_000,
            ..Default::default()
        };
        let mut facts = MemberSignals {
            observed_at_ms: Some(1_000),
            quota_windows: vec![
                QuotaWindowSignal {
                    remaining_fraction: 0.8,
                    reset_in_ms: Some(18_000_000),
                    window_ms: Some(18_000_000),
                },
                QuotaWindowSignal {
                    remaining_fraction: 0.8,
                    reset_in_ms: Some(604_800_000),
                    window_ms: Some(604_800_000),
                },
            ],
            ..Default::default()
        };
        assert!((quota_score(&facts, &request).unwrap() - 0.256).abs() < 1e-10);
        facts.quota_windows.pop();
        assert!((quota_score(&facts, &request).unwrap() - 0.451).abs() < 1e-10);
        assert_eq!(
            facts.quota_windows.len(),
            1,
            "unknown weekly score must not create a reported observation"
        );
        assert_eq!(facts.remaining(&request), Some(0.8));
    }

    #[test]
    fn malformed_or_oversized_windows_are_not_reported_as_quota() {
        let request = PoolRequest {
            now_ms: 1_000,
            ..Default::default()
        };
        let mut facts = MemberSignals {
            observed_at_ms: Some(1_000),
            quota_windows: vec![QuotaWindowSignal {
                remaining_fraction: f64::NAN,
                reset_in_ms: None,
                window_ms: None,
            }],
            ..Default::default()
        };
        assert_eq!(quota_score(&facts, &request), None);
        facts.quota_windows = vec![
            QuotaWindowSignal {
                remaining_fraction: 1.0,
                reset_in_ms: None,
                window_ms: None
            };
            9
        ];
        assert_eq!(quota_score(&facts, &request), None);
    }
}
