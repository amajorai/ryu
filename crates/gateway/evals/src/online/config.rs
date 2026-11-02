//! The `[evals.online]` config block, the per-tenant policy it resolves to,
//! and the request-keyed sampling and text helpers the hot path uses.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

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

    pub(super) fn effective_queue_capacity(&self) -> usize {
        self.queue_capacity.clamp(1, MAX_QUEUE_CAPACITY)
    }

    pub(super) fn effective_store_capacity(&self) -> usize {
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

#[cfg(test)]
#[path = "config_test.rs"]
mod tests;
