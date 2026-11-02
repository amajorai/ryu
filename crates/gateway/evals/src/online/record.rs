//! A sampled job, the scored record it becomes, and the record query.

use serde::{Deserialize, Serialize};

use crate::EvaluatorScore;

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
    /// `true` only when every evaluator ran and passed. One that did not run
    /// (a judge that refused, was filtered or cut off, stated no verdict, or
    /// was skipped by the judge budget) leaves the record not passed: an
    /// unjudged response is never reported as clean.
    pub pass: bool,
    pub enqueued_at_ms: i64,
    pub scored_at_ms: i64,
}

impl OnlineEvalRecord {
    /// Build a record. It passes only when it has scores and every one of
    /// them executed and passed.
    pub fn from_job<C>(
        job: &OnlineEvalJob<C>,
        scores: Vec<EvaluatorScore>,
        scored_at_ms: i64,
    ) -> Self {
        let pass = !scores.is_empty() && scores.iter().all(|score| score.executed && score.pass);
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
    /// Only records that did not pass: an evaluator failed or did not run.
    #[serde(default, alias = "failedOnly")]
    pub failed_only: bool,
    #[serde(default)]
    pub limit: Option<usize>,
}

pub(super) const DEFAULT_QUERY_LIMIT: usize = 100;
pub(super) const MAX_QUERY_LIMIT: usize = 1_000;

impl OnlineEvalQuery {
    pub(super) fn matches(&self, record: &OnlineEvalRecord) -> bool {
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

#[cfg(test)]
#[path = "record_test.rs"]
mod tests;
