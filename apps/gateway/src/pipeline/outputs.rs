//! What the pipeline returns: buffered and streamed outputs, degraded mode.

use super::*;

/// Describes the degraded mode the pipeline entered, if any, for this request.
///
/// Emitted as the `x-degraded` response header and incremented in metrics
/// so clients and operators can observe fallback / exhaustion events (#218).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DegradedMode {
    /// Request was served by a fallback provider because the primary circuit
    /// was open. Header value: `fallback:<provider-name>`.
    Fallback(String),
}

impl DegradedMode {
    /// The stable string emitted as the `x-degraded` header value.
    pub fn header_value(&self) -> String {
        match self {
            DegradedMode::Fallback(provider) => format!("fallback:{provider}"),
        }
    }
}

#[allow(dead_code)]
pub struct PipelineOutput {
    pub response: Value,
    pub context: RequestContext,
    pub provider_used: &'static str,
    pub model_used: String,
    pub cache_hit: bool,
    /// Triggered budget action (U21), surfaced to the client as headers.
    pub budget: Option<BudgetDecision>,
    /// Overall eval score for this request, if it was sampled and scored.
    pub eval_score: Option<f32>,
    /// Set when the request was served in degraded mode (#218).
    pub degraded: Option<DegradedMode>,
    /// Stamped policy alert (budget-cap or firewall warn) for the Ok path. The
    /// handler inserts it into `response.extensions_mut()`; the router's
    /// `map_response` layer writes it out as `x-ryu-policy-alert`.
    pub policy_alert: Option<PolicyAlert>,
    /// What the prompt-cache stage did, surfaced as `x-ryu-prompt-cache`.
    pub prompt_cache: ryu_gw_providers::PromptCacheOutcome,
    /// Prompt tokens the provider served from its cache (`x-ryu-cache-read`) and
    /// wrote into it (`x-ryu-cache-write`). Together with `prompt_cache` these
    /// are what let a caller *prove* markers reached the provider and hit —
    /// previously only an aggregate counter existed, so a single request could
    /// not be checked.
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

/// Provider operation for the non-chat, token-metered data-plane endpoints.
/// Embeddings and reranking deliberately enter this pipeline instead of calling
/// a provider directly so auth, rate limits, budgets, reservations, fallback,
/// accounting, and audit records share one governed seam.
#[derive(Clone, Copy)]
pub enum EmbeddingOperation {
    Embed,
    Rerank,
}

impl EmbeddingOperation {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Embed => "embedding",
            Self::Rerank => "rerank",
        }
    }
}

#[allow(dead_code)]
pub struct PipelineStreamOutput {
    pub body: Body,
    pub context: RequestContext,
    pub provider_used: &'static str,
    pub model_used: String,
    /// Triggered budget action (U21), surfaced to the client as headers.
    pub budget: Option<BudgetDecision>,
    /// Set when the streaming request was served in degraded mode (#218).
    pub degraded: Option<DegradedMode>,
    /// Stamped policy alert (budget-cap or firewall warn) for the Ok path (see
    /// [`PipelineOutput::policy_alert`]).
    pub policy_alert: Option<PolicyAlert>,
    /// What the prompt-cache stage did, surfaced as `x-ryu-prompt-cache`. The
    /// read/write token counts are not available here — they arrive in the
    /// stream's terminal usage frame, so the observer records them into metrics
    /// at stream end rather than into a header.
    pub prompt_cache: ryu_gw_providers::PromptCacheOutcome,
}
