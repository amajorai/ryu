use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use hmac::{Hmac, Mac};
use ryu_gw_contracts::credit_debit::CreditDebitReason;
use serde_json::{json, Value};
use sha2::Sha256;
use tracing::{debug, info, warn};
use uuid::Uuid;

mod auxiliary;
mod edit_rescan;
#[cfg(test)]
mod edit_rescan_probe_tests;
#[cfg(test)]
mod edit_rescan_tests;
pub(crate) mod inference_governance;
mod media_knobs;
mod outbound_text;
#[cfg(test)]
mod outbound_text_tests;
mod pool_dispatch;
pub(crate) mod pool_execution;
mod pool_signals;
pub(crate) mod upstream_features;
pub(crate) mod web;
use inference_governance::InferenceClient;
mod gen_ai_telemetry;
#[cfg(test)]
mod gen_ai_telemetry_tests;
pub(crate) mod model_alias;
mod own_supply;
pub(crate) mod provider_call_guard;
mod provider_usage;
mod stream_dlp;
#[cfg(test)]
mod stream_dlp_probe_tests;
#[cfg(test)]
mod stream_dlp_scope_tests;
mod tool_loop_screen;
#[cfg(test)]
mod tool_loop_screen_probe_tests;
#[cfg(test)]
mod tool_loop_screen_tests;
mod tool_rounds;
pub(crate) mod upstream_signals;
pub(crate) mod zero_data_retention;
use provider_usage::{
    cost_usd_to_micro, inject_stream_usage_option, provider_cache_write_tokens_reported,
    provider_cached_tokens_reported, response_reported_cost_usd, sse_estimate_output_tokens,
    sse_parse_cache_usage, sse_parse_cache_write_tokens_reported, sse_parse_cached_tokens_reported,
    sse_parse_cost, sse_parse_usage,
};

mod inline_eval;
use inline_eval::{
    backstop_flag, inline_detection_kind, inline_outcome, llm_judge_backstop_kind, InlineOutcome,
};

pub mod node_routing;

/// A minimal [`RequestContext`] for tests in OTHER modules (`state`, …) that need
/// one but have no business restating all thirty-odd fields — and would silently
/// rot every time one is added. Tests inside this module keep their own local
/// builders, which encode per-test intent.
#[cfg(test)]
pub(crate) mod test_support {
    use super::RequestContext;

    /// An anonymous, unbudgeted, preference-free context. Mutate the one or two
    /// fields your test is actually about.
    pub(crate) fn plain_request_context() -> RequestContext {
        RequestContext {
            org_limits: None,
            identity: None,
            standing: None,
            enforcement: None,
            host_conversation: None,
            authorized_operation: crate::config::ApiKeyOperation::Inference,
            provider_snapshot: None,
            request_id: "test-req".to_string(),
            api_key: "sk-test".to_string(), // Test vector, not a credential. gitleaks:allow skipcq
            owner_binding: ryu_gw_credentials::fingerprint("sk-test"),
            is_master_key: false,
            org_id: None,
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: None,
            agent_provider_access: None,
            key_config: None,
            skill_ids: None,
            tool_actions: None,
            tools_header_present: false,
            capability_hints: None,
            slot_provider: None,
            slot_model: None,
            own_supply_route: None,
            violation_attempt: Default::default(),
            session_id: None,
            feature: None,
            purpose: None,
            companion_source: false,
            tool_search_requested: false,
            untrusted_caller: false,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: false,
            openrouter_routing_enabled: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            credit_accounting_unavailable: false,
            budget_resolved_at: None,
            resolved_policy: None,
            prompt_cache_mode: None,
            prompt_cache_ttl: None,
            node_routing: None,
        }
    }
}

pub mod stages;
use stages::PipelineStage;

use crate::{
    audit::AuditRecord,
    budget::{BudgetAdmission, BudgetChargeKind, BudgetDecision, BudgetHold, CreditReservation},
    cache::Cache,
    config::{
        AlertTier, ApiKeyConfig, ApiKeyOperation, BudgetAction, FirewallPolicy, Modality,
        ProviderId,
    },
    error::GatewayError,
    evaluators::{Evaluator, EvaluatorImpl, EvaluatorRegistry, EvaluatorTarget},
    firewall::{inspector::InspectorClient, FirewallScanner},
    policy_alert::PolicyAlert,
    router::RouteDecision,
    semantic_cache::SemanticCache,
    state::AppState,
};

// Production clusters split out of this file. Each child does `use super::*;`
// and the private globs below keep every item reachable inside `pipeline` by
// its old path; the `pub(crate) use` block re-exports what the rest of the
// crate imports as `crate::pipeline::<item>`.
pub(crate) use audit::audit_refused;
pub(crate) use auth::{authenticate, authenticate_for_operation, AuthInputs};
pub(crate) use body_shaping::ANTHROPIC_BETA_FIELD;
pub(crate) use core_proof::{ct_eq, has_core_proof_key};
pub(crate) use credit_reserve::credit_headroom_micro_usd;
pub(crate) use media_jobs::{submit_audio_job, submit_video_job};
pub(crate) use media_poll::{poll_audio_job, poll_video_job};
pub(crate) use prompt_text::is_dlp_guardrail;
pub(crate) use tool_debit::{
    external_tool_debit_reason, external_tool_ref_id, spawn_external_tool_debit_for_ids,
    spawn_managed_tool_debit, ManagedToolDebit,
};
mod audit;
use audit::*;
mod auth;
use auth::*;
mod auth_identity;
use auth_identity::*;
mod body_shaping;
use body_shaping::*;
mod budget;
use budget::*;
mod budget_charge;
use budget_charge::*;
mod core_proof;
use core_proof::*;
mod credit_reserve;
use credit_reserve::*;
mod debit;
use debit::*;
mod dlp_stream;
use dlp_stream::*;
mod inline_apply;
use inline_apply::*;
mod inline_flags;
use inline_flags::*;
mod json_text;
use json_text::*;
mod media_jobs;
use media_jobs::*;
mod media_poll;
mod prompt_text;
use prompt_text::*;
mod routing_smart;
use routing_smart::*;
mod stream_observe;
use stream_observe::*;
mod stream_observer;
use stream_observer::*;
mod stream_opening;
use stream_opening::*;
mod tool_debit;
use tool_debit::*;
mod tool_loop_select;
use tool_loop_select::*;

// The request paths, split by responsibility. Each child does `use super::*;`
// and the globs below keep every item reachable inside `pipeline` by its old
// path.
mod attempt_errors;
use attempt_errors::*;
mod buffered;
pub use buffered::run;
use buffered::*;
mod chat_attempt;
use chat_attempt::*;
mod chat_buffered;
use chat_buffered::*;
mod chat_buffered_answer;
use chat_buffered_answer::*;
mod chat_buffered_attempts;
use chat_buffered_attempts::*;
mod chat_buffered_dispatch;
use chat_buffered_dispatch::*;
mod chat_stream;
pub use chat_stream::run_stream;
use chat_stream::*;
mod chat_stream_answer;
use chat_stream_answer::*;
mod chat_stream_attempts;
use chat_stream_attempts::*;
mod context;
pub use context::RequestContext;
mod embedding;
pub use embedding::run_embedding;
mod inbound_inspector;
use inbound_inspector::*;
mod inbound_stages;
use inbound_stages::*;
mod multimodal;
use multimodal::*;
pub use multimodal::{run_multimodal, run_speech};
mod multimodal_answer;
use multimodal_answer::*;
mod outputs;
pub use outputs::{DegradedMode, EmbeddingOperation, PipelineOutput, PipelineStreamOutput};
mod own_supply_route;
use own_supply_route::*;
mod pre_process;
use pre_process::*;
mod routing;
pub(crate) use routing::admit_request;
use routing::*;
mod stream_pool;
use stream_pool::*;

/// Build the firewall [`PolicyAlert`] for an inbound/outbound firewall match, or
/// `None` when the resolved firewall's `alert` tier is below `Warn` (so a
/// firewall with no configured tier fires no alert). `enforcement` is `block`
/// (Block) or `notify` (WarnAndContinue).
fn firewall_policy_alert(
    cfg: &crate::config::FirewallConfig,
    ctx: &RequestContext,
    enforcement: &str,
) -> Option<PolicyAlert> {
    if cfg.alert >= AlertTier::Warn {
        Some(PolicyAlert::firewall(
            enforcement,
            cfg.alert,
            ctx.org_id.as_deref().unwrap_or(""),
        ))
    } else {
        None
    }
}

#[cfg(test)]
mod request_path_flow_tests;
#[cfg(test)]
mod request_path_unit_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod authenticate_tests;

/// End-to-end fallback / cost-tier demotion tests driven through the full
/// `run()` pipeline with scripted providers. These pin the request-path behavior
/// the focus of the coverage sweep called out: a `ProviderRateLimited` demotes
/// down the fallback chain WITHOUT tripping the circuit, a generic provider error
/// trips the circuit and still fails over, an already-open circuit is skipped,
/// and chain exhaustion surfaces the typed `AllProvidersUnavailable` error.
#[cfg(test)]
mod fallback_tests;
