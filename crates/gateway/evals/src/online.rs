//! Online evals: score a sampled fraction of production traffic with catalog
//! evaluators, asynchronously and off the request hot path.
//!
//! This module owns the transport-free half of online evaluation so it can be
//! unit-tested without a provider:
//!
//! * [`OnlineEvalsConfig`] — the `[evals.online]` config block, opt-in
//!   (`enabled = false` by default) with per-tenant overrides;
//! * [`OnlineEvalsConfig::resolve`] — the per-tenant effective policy;
//! * [`sampled`] — deterministic, request-id-keyed sampling, so a request's
//!   inclusion does not depend on unrelated traffic interleaving;
//! * [`OnlineEvals`] — the bounded hand-off queue (`try_send`, never awaits on
//!   the request path), the per-tenant judge-call budget, the bounded result
//!   store, and the counters the evals API reports.
//!
//! The Gateway owns the worker that drains the queue (it needs the pipeline to
//! run LLM-judge evaluators through the governed provider path), so judge
//! calls are budgeted, firewalled, and audited like any other model call.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::EvaluatorScore;

/// Tenant key used when a request carries no organization.
pub const LOCAL_TENANT: &str = "local";

/// Hard ceilings applied regardless of configuration so a typo cannot turn
/// the online scorer into an unbounded memory or provider sink.
const MAX_QUEUE_CAPACITY: usize = 10_000;
const MAX_STORE_CAPACITY: usize = 50_000;
const MAX_CONCURRENCY: usize = 16;
const MAX_TEXT_CHARS: usize = 64 * 1024;
const MAX_EVALUATORS: usize = 16;

/// `[evals.online]`: production-traffic scoring with catalog evaluators.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct OnlineEvalsConfig {
    /// Opt-in switch. Online scoring copies (DLP-sanitized) prompts and
    /// responses into an in-memory queue and may make judge calls, so it never
    /// runs unless an operator enables it.
    #[serde(default)]
    pub enabled: bool,
    /// Fraction of eligible completed requests to score, in `[0.0, 1.0]`.
    #[serde(default = "default_online_sample_rate")]
    pub sample_rate: f32,
    /// Catalog evaluator ids (built-in or custom) applied to sampled traffic.
    #[serde(default)]
    pub evaluators: Vec<String>,
    /// Judge model for LLM-judge evaluators that do not pin their own
    /// `offline.judgeModel`. Falls back to `[evals].judge_model`, then
    /// `[evals].default_model` / the pinned chat model, then the model that
    /// served the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<String>,
    /// Bounded hand-off queue. When full, new samples are dropped and counted.
    #[serde(default = "default_queue_capacity")]
    pub queue_capacity: usize,
    /// Jobs scored in parallel by the background worker.
    #[serde(default = "default_max_concurrency")]
    pub max_concurrency: usize,
    /// Per-tenant judge-call budget per rolling minute. `0` disables judge
    /// calls entirely (deterministic evaluators still run).
    #[serde(default = "default_judge_calls_per_minute")]
    pub max_judge_calls_per_minute: u32,
    /// Most recent records kept for the evals API.
    #[serde(default = "default_store_capacity")]
    pub store_capacity: usize,
    /// Prompt/response characters copied into a job (head-truncated).
    #[serde(default = "default_max_text_chars")]
    pub max_text_chars: usize,
    /// Per-tenant overrides keyed by organization id (`local` for requests
    /// without an organization).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tenants: BTreeMap<String, OnlineTenantConfig>,
}

/// Per-tenant override for [`OnlineEvalsConfig`]. Unset fields inherit.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct OnlineTenantConfig {
    /// `false` opts this tenant out even when online evals are enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluators: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_judge_calls_per_minute: Option<u32>,
}

fn default_online_sample_rate() -> f32 {
    0.05
}
fn default_queue_capacity() -> usize {
    256
}
fn default_max_concurrency() -> usize {
    2
}
fn default_judge_calls_per_minute() -> u32 {
    60
}
fn default_store_capacity() -> usize {
    1_000
}
fn default_max_text_chars() -> usize {
    8_000
}

impl Default for OnlineEvalsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sample_rate: default_online_sample_rate(),
            evaluators: Vec::new(),
            judge_model: None,
            queue_capacity: default_queue_capacity(),
            max_concurrency: default_max_concurrency(),
            max_judge_calls_per_minute: default_judge_calls_per_minute(),
            store_capacity: default_store_capacity(),
            max_text_chars: default_max_text_chars(),
            tenants: BTreeMap::new(),
        }
    }
}

/// The effective online-eval policy for one tenant.
#[derive(Debug, Clone, PartialEq)]
pub struct OnlineTenantPolicy {
    pub tenant: String,
    pub sample_rate: f32,
    pub evaluators: Vec<String>,
    pub judge_model: Option<String>,
    pub max_judge_calls_per_minute: u32,
}

impl OnlineEvalsConfig {
    /// Validate operator input before it is applied. Unknown evaluator ids are
    /// checked by the Gateway against its catalog; this covers shape limits.
    pub fn validate(&self) -> Result<(), String> {
        let rates = std::iter::once(Some(self.sample_rate))
            .chain(self.tenants.values().map(|tenant| tenant.sample_rate));
        for rate in rates.flatten() {
            if !(0.0..=1.0).contains(&rate) || rate.is_nan() {
                return Err(format!(
                    "evals.online sample_rate must be within [0, 1], got {rate}"
                ));
            }
        }
        let evaluator_lists = std::iter::once(&self.evaluators).chain(
            self.tenants
                .values()
                .filter_map(|tenant| tenant.evaluators.as_ref()),
        );
        for list in evaluator_lists {
            if list.len() > MAX_EVALUATORS {
                return Err(format!(
                    "evals.online accepts at most {MAX_EVALUATORS} evaluators per scope"
                ));
            }
            if list.iter().any(|id| id.trim().is_empty()) {
                return Err("evals.online evaluator ids must not be empty".to_owned());
            }
        }
        if self.tenants.keys().any(|tenant| tenant.trim().is_empty()) {
            return Err("evals.online tenant keys must not be empty".to_owned());
        }
        Ok(())
    }

    /// Every evaluator id referenced at any scope (for catalog validation).
    pub fn referenced_evaluators(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.evaluators.iter().map(String::as_str).collect();
        for tenant in self.tenants.values() {
            if let Some(list) = &tenant.evaluators {
                ids.extend(list.iter().map(String::as_str));
            }
        }
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    /// Resolve the effective policy for `tenant`. `None` when online evals are
    /// disabled globally or for the tenant, the rate is zero, or no evaluator
    /// is configured — the request path then does no further work.
    pub fn resolve(&self, tenant: &str) -> Option<OnlineTenantPolicy> {
        if !self.enabled {
            return None;
        }
        let overrides = self.tenants.get(tenant);
        if overrides.and_then(|o| o.enabled) == Some(false) {
            return None;
        }
        let sample_rate = overrides
            .and_then(|o| o.sample_rate)
            .unwrap_or(self.sample_rate)
            .clamp(0.0, 1.0);
        let evaluators = overrides
            .and_then(|o| o.evaluators.clone())
            .unwrap_or_else(|| self.evaluators.clone());
        if sample_rate <= 0.0 || evaluators.is_empty() {
            return None;
        }
        let judge_model = overrides
            .and_then(|o| o.judge_model.clone())
            .or_else(|| self.judge_model.clone())
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty());
        Some(OnlineTenantPolicy {
            tenant: tenant.to_owned(),
            sample_rate,
            evaluators,
            judge_model,
            max_judge_calls_per_minute: overrides
                .and_then(|o| o.max_judge_calls_per_minute)
                .unwrap_or(self.max_judge_calls_per_minute),
        })
    }

    fn effective_queue_capacity(&self) -> usize {
        self.queue_capacity.clamp(1, MAX_QUEUE_CAPACITY)
    }

    fn effective_store_capacity(&self) -> usize {
        self.store_capacity.clamp(1, MAX_STORE_CAPACITY)
    }

    /// Worker parallelism, clamped to `[1, 16]`.
    pub fn effective_concurrency(&self) -> usize {
        self.max_concurrency.clamp(1, MAX_CONCURRENCY)
    }

    /// Characters copied from prompt/response into a job, clamped.
    pub fn effective_text_chars(&self) -> usize {
        self.max_text_chars.clamp(1, MAX_TEXT_CHARS)
    }
}

/// Deterministic request-keyed sampling: FNV-1a over the request id mapped to
/// `[0, 1)`. Unlike a shared counter, the decision for a request never depends
/// on what other tenants sent, so per-tenant rates are honoured independently.
pub fn sampled(request_id: &str, rate: f32) -> bool {
    if rate >= 1.0 {
        return true;
    }
    if rate <= 0.0 || rate.is_nan() {
        return false;
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in request_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // Finalize (splitmix64) so similar ids spread across the range.
    hash ^= hash >> 30;
    hash = hash.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    hash ^= hash >> 27;
    hash = hash.wrapping_mul(0x94d0_49bb_1331_11eb);
    hash ^= hash >> 31;
    let unit = (hash >> 11) as f64 / (1u64 << 53) as f64;
    unit < f64::from(rate)
}

/// Head-truncate to `max_chars` characters, never splitting a code point.
pub fn clip_text(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => text[..cut].to_owned(),
        None => text.to_owned(),
    }
}

/// Parse the trace id out of a W3C `traceparent` (`00-<trace>-<span>-<flags>`).
pub fn trace_id_from_traceparent(traceparent: &str) -> Option<String> {
    let mut parts = traceparent.trim().split('-');
    let _version = parts.next()?;
    let trace_id = parts.next()?;
    let valid = trace_id.len() == 32
        && trace_id.bytes().all(|b| b.is_ascii_hexdigit())
        && trace_id.bytes().any(|b| b != b'0');
    valid.then(|| trace_id.to_ascii_lowercase())
}

/// One sampled production request awaiting scoring. `C` is the embedding
/// service's request context (the Gateway carries its authenticated request
/// context so judge calls are governed and billed to the same tenant).
#[derive(Debug, Clone)]
pub struct OnlineEvalJob<C = ()> {
    pub request_id: String,
    pub trace_id: Option<String>,
    pub tenant: String,
    pub agent_id: Option<String>,
    pub model: String,
    pub provider: String,
    /// Latest user prompt after inbound firewall/DLP processing.
    pub prompt: String,
    /// Response text after outbound DLP and inline guardrails.
    pub response: String,
    pub evaluators: Vec<String>,
    pub judge_model: Option<String>,
    pub max_judge_calls_per_minute: u32,
    pub enqueued_at_ms: i64,
    pub context: C,
}

/// A scored production request, as returned by `GET /v1/evals/online`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineEvalRecord {
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    pub tenant: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub model: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub judge_model: Option<String>,
    pub scores: Vec<EvaluatorScore>,
    /// `true` when every executed evaluator passed.
    pub pass: bool,
    pub enqueued_at_ms: i64,
    pub scored_at_ms: i64,
}

impl OnlineEvalRecord {
    /// Build a record, deriving `pass` from the executed scores.
    pub fn from_job<C>(
        job: &OnlineEvalJob<C>,
        scores: Vec<EvaluatorScore>,
        scored_at_ms: i64,
    ) -> Self {
        let pass = scores
            .iter()
            .filter(|score| score.executed)
            .all(|score| score.pass);
        Self {
            request_id: job.request_id.clone(),
            trace_id: job.trace_id.clone(),
            tenant: job.tenant.clone(),
            agent_id: job.agent_id.clone(),
            model: job.model.clone(),
            provider: job.provider.clone(),
            judge_model: job.judge_model.clone(),
            scores,
            pass,
            enqueued_at_ms: job.enqueued_at_ms,
            scored_at_ms,
        }
    }
}

/// Filter for [`OnlineEvals::query`]. Every set field must match.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct OnlineEvalQuery {
    #[serde(default, alias = "requestId")]
    pub request_id: Option<String>,
    #[serde(default, alias = "traceId")]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub tenant: Option<String>,
    #[serde(default, alias = "agentId")]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub evaluator: Option<String>,
    /// Only records with at least one failing executed evaluator.
    #[serde(default, alias = "failedOnly")]
    pub failed_only: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

const DEFAULT_QUERY_LIMIT: usize = 100;
const MAX_QUERY_LIMIT: usize = 1_000;

impl OnlineEvalQuery {
    fn matches(&self, record: &OnlineEvalRecord) -> bool {
        let eq = |want: &Option<String>, have: Option<&str>| {
            want.as_deref().is_none_or(|want| have == Some(want))
        };
        eq(&self.request_id, Some(&record.request_id))
            && eq(&self.trace_id, record.trace_id.as_deref())
            && eq(&self.tenant, Some(&record.tenant))
            && eq(&self.agent_id, record.agent_id.as_deref())
            && self
                .evaluator
                .as_deref()
                .is_none_or(|id| record.scores.iter().any(|score| score.id == id))
            && (!self.failed_only || !record.pass)
    }
}

/// Why a sample did not reach the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfferOutcome {
    Enqueued,
    QueueFull,
    /// The worker is gone (shutdown) or online evals were never started.
    Closed,
}

/// Point-in-time counters for the evals API.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineEvalStats {
    pub enqueued: u64,
    pub dropped_queue_full: u64,
    pub scored: u64,
    pub judge_budget_skipped: u64,
    pub stored: usize,
}

#[derive(Default)]
struct Counters {
    enqueued: AtomicU64,
    dropped_queue_full: AtomicU64,
    scored: AtomicU64,
    judge_budget_skipped: AtomicU64,
}

/// Fixed-window per-tenant judge-call budget.
#[derive(Default)]
struct JudgeBudget {
    windows: Mutex<HashMap<String, (i64, u32)>>,
}

const BUDGET_WINDOW_MS: i64 = 60_000;
const MAX_BUDGET_TENANTS: usize = 4_096;

impl JudgeBudget {
    fn try_acquire(&self, tenant: &str, limit: u32, now_ms: i64) -> bool {
        if limit == 0 {
            return false;
        }
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if windows.len() >= MAX_BUDGET_TENANTS && !windows.contains_key(tenant) {
            windows.retain(|_, (start, _)| now_ms - *start < BUDGET_WINDOW_MS);
        }
        let entry = windows.entry(tenant.to_owned()).or_insert((now_ms, 0));
        if now_ms - entry.0 >= BUDGET_WINDOW_MS {
            *entry = (now_ms, 0);
        }
        if entry.1 >= limit {
            return false;
        }
        entry.1 += 1;
        true
    }
}

/// Shared online-eval state: queue sender, judge budget, results, counters.
pub struct OnlineEvals<C = ()> {
    sender: Option<mpsc::Sender<OnlineEvalJob<C>>>,
    store: Mutex<VecDeque<OnlineEvalRecord>>,
    store_capacity: usize,
    counters: Counters,
    budget: JudgeBudget,
}

impl<C: Send + 'static> OnlineEvals<C> {
    /// Build the shared state and, when online evals are enabled, the
    /// receiver the Gateway's background worker drains. The queue is created
    /// even when no tenant currently resolves so a later config change needs
    /// no restart of the worker.
    #[allow(clippy::type_complexity)]
    pub fn new(
        config: &OnlineEvalsConfig,
    ) -> (Arc<Self>, Option<mpsc::Receiver<OnlineEvalJob<C>>>) {
        let (sender, receiver) = if config.enabled {
            let (tx, rx) = mpsc::channel(config.effective_queue_capacity());
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let state = Arc::new(Self {
            sender,
            store: Mutex::new(VecDeque::new()),
            store_capacity: config.effective_store_capacity(),
            counters: Counters::default(),
            budget: JudgeBudget::default(),
        });
        (state, receiver)
    }

    /// Whether a worker queue exists.
    pub fn is_running(&self) -> bool {
        self.sender.as_ref().is_some_and(|tx| !tx.is_closed())
    }

    /// Hand a job to the worker without waiting. Never blocks the caller.
    pub fn offer(&self, job: OnlineEvalJob<C>) -> OfferOutcome {
        let Some(sender) = &self.sender else {
            return OfferOutcome::Closed;
        };
        match sender.try_send(job) {
            Ok(()) => {
                self.counters.enqueued.fetch_add(1, Ordering::Relaxed);
                OfferOutcome::Enqueued
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.counters
                    .dropped_queue_full
                    .fetch_add(1, Ordering::Relaxed);
                OfferOutcome::QueueFull
            }
            Err(mpsc::error::TrySendError::Closed(_)) => OfferOutcome::Closed,
        }
    }

    /// Reserve one judge call for `tenant` within its per-minute budget.
    /// Counts a skip when the budget is exhausted.
    pub fn try_acquire_judge(&self, tenant: &str, limit: u32, now_ms: i64) -> bool {
        let acquired = self.budget.try_acquire(tenant, limit, now_ms);
        if !acquired {
            self.counters
                .judge_budget_skipped
                .fetch_add(1, Ordering::Relaxed);
        }
        acquired
    }

    /// Store a scored record, evicting the oldest past capacity.
    pub fn record(&self, record: OnlineEvalRecord) {
        let mut store = self
            .store
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while store.len() >= self.store_capacity {
            store.pop_front();
        }
        store.push_back(record);
        self.counters.scored.fetch_add(1, Ordering::Relaxed);
    }

    /// Newest-first records matching `query`.
    pub fn query(&self, query: &OnlineEvalQuery) -> Vec<OnlineEvalRecord> {
        let limit = query
            .limit
            .unwrap_or(DEFAULT_QUERY_LIMIT)
            .clamp(1, MAX_QUERY_LIMIT);
        let store = self
            .store
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        store
            .iter()
            .rev()
            .filter(|record| query.matches(record))
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn stats(&self) -> OnlineEvalStats {
        let stored = self
            .store
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len();
        OnlineEvalStats {
            enqueued: self.counters.enqueued.load(Ordering::Relaxed),
            dropped_queue_full: self.counters.dropped_queue_full.load(Ordering::Relaxed),
            scored: self.counters.scored.load(Ordering::Relaxed),
            judge_budget_skipped: self.counters.judge_budget_skipped.load(Ordering::Relaxed),
            stored,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enabled_config() -> OnlineEvalsConfig {
        OnlineEvalsConfig {
            enabled: true,
            sample_rate: 0.5,
            evaluators: vec!["pii_leakage".to_owned()],
            ..OnlineEvalsConfig::default()
        }
    }

    fn job(request_id: &str) -> OnlineEvalJob {
        OnlineEvalJob {
            request_id: request_id.to_owned(),
            trace_id: None,
            tenant: LOCAL_TENANT.to_owned(),
            agent_id: Some("agent-a".to_owned()),
            model: "m".to_owned(),
            provider: "p".to_owned(),
            prompt: "hi".to_owned(),
            response: "hello".to_owned(),
            evaluators: vec!["pii_leakage".to_owned()],
            judge_model: None,
            max_judge_calls_per_minute: 1,
            enqueued_at_ms: 1,
            context: (),
        }
    }

    fn score(id: &str, pass: bool, executed: bool) -> EvaluatorScore {
        EvaluatorScore {
            id: id.to_owned(),
            category: "security".to_owned(),
            score: if pass { 1.0 } else { 0.0 },
            pass,
            detail: String::new(),
            executed,
        }
    }

    #[test]
    fn disabled_by_default_and_without_evaluators() {
        assert!(OnlineEvalsConfig::default().resolve(LOCAL_TENANT).is_none());
        let mut config = enabled_config();
        config.evaluators.clear();
        assert!(config.resolve(LOCAL_TENANT).is_none());
    }

    #[test]
    fn tenant_overrides_inherit_and_opt_out() {
        let mut config = enabled_config();
        config.judge_model = Some("judge-a".to_owned());
        config.tenants.insert(
            "org-1".to_owned(),
            OnlineTenantConfig {
                sample_rate: Some(1.0),
                judge_model: Some("judge-b".to_owned()),
                ..OnlineTenantConfig::default()
            },
        );
        config.tenants.insert(
            "org-2".to_owned(),
            OnlineTenantConfig {
                enabled: Some(false),
                ..OnlineTenantConfig::default()
            },
        );
        let base = config.resolve("other").expect("inherits global");
        assert_eq!(base.sample_rate, 0.5);
        assert_eq!(base.judge_model.as_deref(), Some("judge-a"));
        let org1 = config.resolve("org-1").expect("override");
        assert_eq!(org1.sample_rate, 1.0);
        assert_eq!(org1.judge_model.as_deref(), Some("judge-b"));
        assert_eq!(org1.evaluators, vec!["pii_leakage".to_owned()]);
        assert!(config.resolve("org-2").is_none());
    }

    #[test]
    fn validate_rejects_out_of_range_rates_and_empty_ids() {
        let mut config = enabled_config();
        config.sample_rate = 1.5;
        assert!(config.validate().is_err());
        let mut config = enabled_config();
        config.evaluators.push(" ".to_owned());
        assert!(config.validate().is_err());
        assert!(enabled_config().validate().is_ok());
    }

    #[test]
    fn sampling_is_deterministic_and_close_to_rate() {
        assert!(sampled("anything", 1.0));
        assert!(!sampled("anything", 0.0));
        assert_eq!(sampled("req-42", 0.3), sampled("req-42", 0.3));
        let hits = (0..10_000)
            .filter(|i| sampled(&format!("req-{i}"), 0.25))
            .count();
        assert!((2_200..=2_800).contains(&hits), "hits = {hits}");
    }

    #[test]
    fn traceparent_parsing_rejects_invalid_ids() {
        assert_eq!(
            trace_id_from_traceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01")
                .as_deref(),
            Some("4bf92f3577b34da6a3ce929d0e0e4736")
        );
        assert!(trace_id_from_traceparent(
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01"
        )
        .is_none());
        assert!(trace_id_from_traceparent("garbage").is_none());
    }

    #[test]
    fn clip_text_respects_char_boundaries() {
        assert_eq!(clip_text("héllo", 2), "hé");
        assert_eq!(clip_text("hi", 10), "hi");
    }

    #[tokio::test]
    async fn bounded_queue_drops_when_full() {
        let mut config = enabled_config();
        config.queue_capacity = 1;
        let (online, receiver) = OnlineEvals::<()>::new(&config);
        let mut receiver = receiver.expect("enabled config creates a queue");
        assert_eq!(online.offer(job("a")), OfferOutcome::Enqueued);
        assert_eq!(online.offer(job("b")), OfferOutcome::QueueFull);
        assert_eq!(receiver.recv().await.expect("job").request_id, "a");
        assert_eq!(online.offer(job("c")), OfferOutcome::Enqueued);
        let stats = online.stats();
        assert_eq!(stats.enqueued, 2);
        assert_eq!(stats.dropped_queue_full, 1);
    }

    #[test]
    fn disabled_config_has_no_queue() {
        let (online, receiver) = OnlineEvals::<()>::new(&OnlineEvalsConfig::default());
        assert!(receiver.is_none());
        assert!(!online.is_running());
        assert_eq!(online.offer(job("a")), OfferOutcome::Closed);
    }

    #[test]
    fn judge_budget_is_per_tenant_and_windowed() {
        let (online, _rx) = OnlineEvals::<()>::new(&enabled_config());
        assert!(online.try_acquire_judge("t1", 2, 0));
        assert!(online.try_acquire_judge("t1", 2, 10));
        assert!(!online.try_acquire_judge("t1", 2, 20));
        assert!(online.try_acquire_judge("t2", 2, 20));
        assert!(online.try_acquire_judge("t1", 2, 60_000));
        assert!(!online.try_acquire_judge("t3", 0, 0));
        assert_eq!(online.stats().judge_budget_skipped, 2);
    }

    #[test]
    fn store_is_bounded_and_queryable_newest_first() {
        let mut config = enabled_config();
        config.store_capacity = 2;
        let (online, _rx) = OnlineEvals::<()>::new(&config);
        let mut first = job("r1");
        first.trace_id = Some("t".repeat(32));
        online.record(OnlineEvalRecord::from_job(
            &first,
            vec![score("pii_leakage", true, true)],
            2,
        ));
        online.record(OnlineEvalRecord::from_job(
            &job("r2"),
            vec![
                score("pii_leakage", false, true),
                score("toxicity", false, false),
            ],
            3,
        ));
        online.record(OnlineEvalRecord::from_job(
            &job("r3"),
            vec![score("pii_leakage", true, true)],
            4,
        ));
        let all = online.query(&OnlineEvalQuery::default());
        assert_eq!(
            all.iter()
                .map(|r| r.request_id.as_str())
                .collect::<Vec<_>>(),
            vec!["r3", "r2"]
        );
        let failed = online.query(&OnlineEvalQuery {
            failed_only: true,
            ..OnlineEvalQuery::default()
        });
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].request_id, "r2");
        assert!(!failed[0].pass);
        let by_eval = online.query(&OnlineEvalQuery {
            evaluator: Some("toxicity".to_owned()),
            ..OnlineEvalQuery::default()
        });
        assert_eq!(by_eval.len(), 1);
        assert_eq!(online.stats().stored, 2);
        assert_eq!(online.stats().scored, 3);
    }

    #[test]
    fn config_round_trips_through_toml_shaped_json() {
        let config: OnlineEvalsConfig = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "evaluators": ["toxicity"],
            "tenants": { "org-9": { "sample_rate": 0.0 } }
        }))
        .expect("parse");
        assert_eq!(config.sample_rate, 0.05);
        assert!(config.resolve("org-9").is_none());
        assert!(config.resolve("other").is_some());
    }
}
