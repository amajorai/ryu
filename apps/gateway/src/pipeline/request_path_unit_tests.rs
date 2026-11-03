//! Unit tests for the request-path helpers split out of `pipeline/mod.rs`:
//! the request context, routing, outputs, own-supply masks, the buffered
//! runner and the shared chat-attempt steps.

use std::sync::Arc;

use serde_json::{json, Value};

use super::test_support::plain_request_context;
use super::*;
use crate::{config::ProviderId, error::GatewayError, state::AppState};

#[test]
fn context_audit_teams_fall_back_to_the_static_team_and_attempts_are_stamped() {
    let mut ctx = plain_request_context();
    assert_eq!(context::RequestContext::audit_team_ids(&ctx), None);
    ctx.team_id = Some("team-a".into());
    assert_eq!(ctx.audit_team_ids().as_deref(), Some("team-a"));

    let stamped = ctx.at_attempt(2, &ProviderId::from("secondary"));
    assert_eq!(stamped.violation_attempt.index, 2);
    assert_eq!(
        stamped.violation_attempt.provider,
        Some(ProviderId::from("secondary"))
    );
    // The original context still screens attempt zero.
    assert_eq!(ctx.violation_attempt.index, 0);
}

#[test]
fn routing_affinity_is_scoped_to_org_and_caller() {
    let mut ctx = plain_request_context();
    let body = json!({"prompt_cache_key": "session-1"});
    let alone = routing::account_affinity(&ctx, &body).expect("a session id");
    ctx.org_id = Some("org-a".into());
    let in_org = routing::account_affinity(&ctx, &body).expect("a session id");
    ctx.user_id = Some("user-1".into());
    let as_user = routing::account_affinity(&ctx, &body).expect("a session id");
    assert_ne!(alone, in_org);
    assert_ne!(in_org, as_user);
    // No session id, or an oversized one, has no affinity.
    assert_eq!(routing::account_affinity(&ctx, &json!({})), None);
    let long = json!({"prompt_cache_key": "x".repeat(257)});
    assert_eq!(routing::account_affinity(&ctx, &long), None);
}

#[test]
fn routing_restores_token_ceilings_and_refuses_a_pool_after_budget() {
    let mut body = json!({"max_tokens": 5, "messages": []});
    routing::restore_token_ceiling(&mut body, "max_tokens", Some(&json!(100)));
    assert_eq!(body["max_tokens"], 100);
    routing::restore_token_ceiling(&mut body, "max_tokens", None);
    assert!(body.get("max_tokens").is_none());

    let decision = crate::router::RouteDecision {
        provider: ProviderId::from("pool:fast"),
        model: "m".into(),
    };
    let mut pool = None;
    assert!(matches!(
        routing::reconcile_pool_after_budget(&decision, &mut pool),
        Err(GatewayError::AllProvidersUnavailable(_))
    ));
}

#[test]
fn outputs_name_degraded_mode_and_embedding_operations() {
    let degraded = outputs::DegradedMode::Fallback("secondary".into());
    assert_eq!(degraded.header_value(), "fallback:secondary");
    assert_eq!(outputs::EmbeddingOperation::Embed.as_str(), "embedding");
    assert_eq!(outputs::EmbeddingOperation::Rerank.as_str(), "rerank");
}

#[test]
fn own_supply_masks_hide_ryu_slots_from_managed_callers_only() {
    let slot = crate::config::CLOUDFLARE_PROVIDER_ID;
    let mut degraded = Some(DegradedMode::Fallback(slot.to_owned()));
    own_supply_route::mask_degraded(&mut degraded, false);
    assert_eq!(degraded, Some(DegradedMode::Fallback(slot.to_owned())));
    own_supply_route::mask_degraded(&mut degraded, true);
    assert_eq!(degraded, Some(DegradedMode::Fallback("ryu".to_owned())));

    let mut used: &'static str = crate::config::CLOUDFLARE_PROVIDER_ID;
    own_supply_route::mask_provider_used(&mut used, true);
    assert_eq!(used, "ryu");
    let mut other: &'static str = "primary";
    own_supply_route::mask_provider_used(&mut other, true);
    assert_eq!(other, "primary");
}

#[tokio::test]
async fn buffered_loops_stop_for_a_caller_that_is_already_gone() {
    let caller = tokio_util::sync::CancellationToken::new();
    let running = buffered::unless_caller_gone(async { 7 }, Some(&caller)).await;
    assert!(matches!(running, buffered::LoopOutcome::Finished(7)));
    caller.cancel();
    let gone = buffered::unless_caller_gone(async { 7 }, Some(&caller)).await;
    assert!(matches!(gone, buffered::LoopOutcome::CallerGone));
    // Unmetered work keeps running whatever the token says.
    let unmetered = buffered::unless_caller_gone(async { 7 }, None).await;
    assert!(matches!(unmetered, buffered::LoopOutcome::Finished(7)));

    let detached = buffered::run_buffered(true, async { Ok::<_, GatewayError>(3) }).await;
    assert_eq!(detached.expect("detached work finishes"), 3);
}

#[test]
fn an_exhausted_chain_names_the_request_and_keeps_typed_errors() {
    let state = AppState::new_for_test_default();
    let none = chat_attempt::exhausted_chain_error(&state, None, "model 'm'");
    assert_eq!(
        none.to_string(),
        GatewayError::AllProvidersUnavailable("All providers unavailable for model 'm'".into())
            .to_string()
    );
    let wrapped = chat_attempt::exhausted_chain_error(
        &state,
        Some(GatewayError::ProviderError("boom".into())),
        "image model 'm'",
    );
    match wrapped {
        GatewayError::AllProvidersUnavailable(message) => {
            assert!(message.starts_with("All providers unavailable for image model 'm': "));
        }
        other => panic!("expected all_providers_unavailable, got {other:?}"),
    }
    let budget = chat_attempt::exhausted_chain_error(
        &state,
        Some(GatewayError::BudgetExceeded(None)),
        "model 'm'",
    );
    assert!(matches!(budget, GatewayError::BudgetExceeded(None)));
}

fn failed(was_primary: bool, replay_unsafe: bool) -> chat_attempt::FailedChatAttempt<'static> {
    chat_attempt::FailedChatAttempt {
        provider: "primary",
        circuit_key: "primary".into(),
        pool: None,
        was_primary,
        replay_unsafe,
        unavailable_log: "unavailable",
        failed_log: "failed",
    }
}

#[test]
fn a_failed_attempt_ends_on_safety_stops_on_uncertain_delivery_and_otherwise_falls_back() {
    let state = AppState::new_for_test_default();
    let ctx = plain_request_context();
    let start = std::time::Instant::now();
    let mut last_err = None;
    let mut skipped = false;

    let safety = GatewayError::FirewallBlocked("stopped".into(), None);
    let ended = chat_attempt::after_failed_chat_attempt(
        &state,
        &ctx,
        failed(true, false),
        safety,
        "m",
        start,
        &mut last_err,
        &mut skipped,
    );
    assert!(matches!(ended, Err(GatewayError::FirewallBlocked(..))));
    assert!(last_err.is_none() && !skipped);

    let uncertain = GatewayError::ProviderDeliveryUncertain("accepted".into());
    let stop = chat_attempt::after_failed_chat_attempt(
        &state,
        &ctx,
        failed(true, false),
        uncertain,
        "m",
        start,
        &mut last_err,
        &mut skipped,
    );
    assert!(matches!(stop, Ok(true)));
    assert!(matches!(
        last_err,
        Some(GatewayError::ProviderDeliveryUncertain(_))
    ));

    let outage = GatewayError::ProviderError("boom".into());
    let next = chat_attempt::after_failed_chat_attempt(
        &state,
        &ctx,
        failed(true, false),
        outage,
        "m",
        start,
        &mut last_err,
        &mut skipped,
    );
    assert!(matches!(next, Ok(false)));
    assert!(skipped, "a failed primary marks the chain as degraded");
    assert!(matches!(last_err, Some(GatewayError::ProviderError(_))));

    let replay = chat_attempt::after_failed_chat_attempt(
        &state,
        &ctx,
        failed(false, true),
        GatewayError::ProviderError("boom".into()),
        "m",
        start,
        &mut last_err,
        &mut skipped,
    );
    assert!(matches!(replay, Ok(true)), "a tool loop is never replayed");
}

#[tokio::test]
async fn an_ungated_attempt_takes_no_engine_slot() {
    let state = AppState::new_for_test_default();
    let ctx = plain_request_context();
    let permit = chat_attempt::acquire_engine_slot(&state, &ctx, "primary", true).await;
    assert!(permit.is_ok());
}

#[test]
fn a_fallback_attempt_restores_ceilings_and_reapplies_a_restrict_budget() {
    let state = Arc::new(AppState::new_for_test_default());
    let ctx = plain_request_context();
    let admitted = json!({"model": "m", "messages": [], "max_tokens": 50});
    let fifty = json!(50);
    let mut body: Value = json!({"model": "m", "messages": [{"role": "tool"}], "max_tokens": 9});
    let attempt = ChatAttemptRoute {
        decision: crate::router::RouteDecision {
            provider: ProviderId::from("secondary"),
            model: "m".into(),
        },
        pool: None,
    };
    let base = chat_attempt::AttemptBase {
        requested_model: "m",
        budget: &None,
        pool_base_body: Some(&admitted),
        original_max_tokens: Some(&fifty),
        original_max_completion_tokens: None,
    };
    let mut decision = crate::router::RouteDecision {
        provider: ProviderId::from("primary"),
        model: "m".into(),
    };
    let mut claim = None;
    let mut outcome = ryu_gw_providers::PromptCacheOutcome::Disabled;
    chat_attempt::prepare_fallback_attempt(
        &state,
        &ctx,
        &base,
        &attempt,
        &mut body,
        &mut decision,
        &mut claim,
        &mut outcome,
    )
    .expect("an unrestricted fallback is prepared");
    assert_eq!(decision.provider, ProviderId::from("secondary"));
    assert_eq!(
        body["messages"],
        json!([]),
        "a pool retry restarts from the admitted body"
    );
    assert_eq!(body["max_tokens"], 50);
}
