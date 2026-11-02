//! The shared online-eval state: the bounded hand-off queue, the per-tenant
//! judge-call budget, the bounded result store, and the counters.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::mpsc;

use super::config::OnlineEvalsConfig;
use super::record::{
    OnlineEvalJob, OnlineEvalQuery, OnlineEvalRecord, DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT,
};

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
#[path = "store_test.rs"]
mod tests;
