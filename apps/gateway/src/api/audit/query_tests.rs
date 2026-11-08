//! `GET /v1/audit` and `GET /v1/audit/usage`: the admin gate, derived cost,
//! exact usage rollups, and markup/managed-cost reporting.

use super::test_support::{
    bearer, loopback, state_with, state_with_credits, wait_for_audit_entries,
};
use super::{query_audit, query_audit_usage, AuditQueryParams, AuditUsageQueryParams};
use crate::audit::AuditRecord;
use crate::config::{ProviderBillingMode, ProviderBillingPolicy, ProviderId};
use crate::error::GatewayError;
use axum::extract::{Query, State};
use axum::Json;
use std::sync::Arc;

// ── query_audit ───────────────────────────────────────────────────────────

fn empty_params() -> Query<AuditQueryParams> {
    Query(serde_json::from_value(serde_json::json!({})).unwrap())
}

#[tokio::test]
async fn query_audit_errors_when_logging_is_disabled() {
    let state = state_with(false);
    let res = query_audit(
        State(state),
        loopback(),
        bearer("sk-master"),
        empty_params(),
    )
    .await;
    assert!(
        matches!(res, Err(GatewayError::Internal(_))),
        "a disabled audit log must surface an error, not empty data"
    );
}

#[tokio::test]
async fn query_audit_returns_rows_with_derived_cost() {
    let state = state_with_credits(true, true);
    // Log one model_call row, then let the background writer flush.
    state.log_audit(AuditRecord {
        key_id: None,
        request_id: "r1".to_string(),
        api_key: "sk-master".to_string(),
        user_name: None,
        org_id: None,
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "openai-credits".to_string(),
        model: "gpt-4o".to_string(),
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: Some("injected".to_owned()),
        prompt_cache_read_tokens: Some(900),
        prompt_cache_write_tokens: Some(100),
        cache_write_1h_tokens: None,
        latency_ms: 5,
        eval_score: None,
        error: None,
        skill_ids: None,
        session_id: None,
        user_id: None,
        agent_id: None,
        feature: None,
        purpose: None,
        managed_inference: true,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
    // The writer is a background thread over a bounded channel; wait for the
    // row rather than depending on a fixed scheduler-dependent delay.
    wait_for_audit_entries(&state, 1).await;

    let Json(body) = query_audit(
        State(Arc::clone(&state)),
        loopback(),
        bearer("sk-master"),
        empty_params(),
    )
    .await
    .expect("master key may read the audit log");
    assert_eq!(body["count"], 1);
    // Derived cost at the default 2000/1k rate: 1000 tokens ⇒ 2000 micro-USD.
    assert_eq!(body["entries"][0]["cost_micro_usd"], 2000);
    assert_eq!(body["entries"][0]["prompt_cache_outcome"], "injected");
    assert_eq!(body["entries"][0]["prompt_cache_read_tokens"], 900);
    assert_eq!(body["entries"][0]["prompt_cache_write_tokens"], 100);
}

#[tokio::test]
async fn query_audit_usage_returns_exact_rollup_cost_and_counts() {
    let state = state_with_credits(true, true);
    let mut record = AuditRecord {
        key_id: None,
        request_id: "usage-reported".to_owned(),
        api_key: "sk-master".to_owned(),
        user_name: None,
        org_id: Some("org-1".to_owned()),
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "openrouter".to_owned(),
        model: "gpt-5".to_owned(),
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 25,
        eval_score: None,
        error: None,
        skill_ids: None,
        session_id: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        user_id: Some("member-1".to_owned()),
        agent_id: None,
        feature: Some("chat".to_owned()),
        purpose: None,
        managed_inference: true,
        provider_cost_micro_usd: Some(1_250),
        widget_instance_id: None,
    };
    state.log_audit(record.clone());
    record.request_id = "usage-fallback".to_owned();
    record.input_tokens = 10;
    record.output_tokens = 5;
    record.provider_cost_micro_usd = None;
    record.error = Some("provider failed".to_owned());
    state.log_audit(record);
    wait_for_audit_entries(&state, 2).await;

    let Json(body) = query_audit_usage(
        State(state),
        loopback(),
        bearer("sk-master"),
        Query(AuditUsageQueryParams {
            from: (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339(),
            until: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            provider: Some("openrouter".to_owned()),
            model: Some("gpt-5".to_owned()),
            purpose: None,
        }),
    )
    .await
    .expect("usage rollup");

    assert_eq!(body["kind"], "rollup");
    assert_eq!(body["bucketSeconds"], 900);
    assert_eq!(body["events"].as_array().map(Vec::len), Some(1));
    assert_eq!(body["events"][0]["requestCount"], 2);
    assert_eq!(body["events"][0]["errorCount"], 1);
    assert_eq!(body["events"][0]["latencyTotalMs"], 50);
    assert_eq!(body["events"][0]["source"], "managed");
    assert_eq!(body["events"][0]["costMicroUsd"], 1280);
}

#[tokio::test]
async fn query_audit_usage_filters_by_purpose_and_reports_cache_tokens() {
    let state = state_with(true);
    let mut record = AuditRecord {
        key_id: None,
        request_id: "foreground".to_owned(),
        api_key: "sk-master".to_owned(),
        user_name: None,
        org_id: None,
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "anthropic".to_owned(),
        model: "claude".to_owned(),
        input_tokens: 10,
        output_tokens: 1,
        cache_read_tokens: Some(5),
        cache_write_tokens: None,
        cache_write_1h_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        latency_ms: 5,
        eval_score: None,
        error: None,
        skill_ids: None,
        session_id: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        user_id: None,
        agent_id: None,
        feature: Some("chat".to_owned()),
        purpose: None,
        managed_inference: false,
        provider_cost_micro_usd: None,
        widget_instance_id: None,
    };
    state.log_audit(record.clone());
    record.request_id = "compaction".to_owned();
    record.purpose = Some("compaction".to_owned());
    record.cache_read_tokens = Some(800);
    record.cache_write_tokens = Some(120);
    state.log_audit(record);
    wait_for_audit_entries(&state, 2).await;

    let Json(body) = query_audit_usage(
        State(state),
        loopback(),
        bearer("sk-master"),
        Query(AuditUsageQueryParams {
            from: (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339(),
            until: (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            provider: None,
            model: None,
            purpose: Some("compaction".to_owned()),
        }),
    )
    .await
    .expect("usage rollup");

    assert_eq!(body["events"].as_array().map(Vec::len), Some(1));
    let event = &body["events"][0];
    assert_eq!(event["purpose"], "compaction");
    assert_eq!(event["feature"], "chat");
    assert_eq!(event["cacheReadTokens"], 800);
    assert_eq!(event["cacheWriteTokens"], 120);
}

#[tokio::test]
async fn query_audit_usage_rejects_ranges_over_400_days() {
    let result = query_audit_usage(
        State(state_with(true)),
        loopback(),
        bearer("sk-master"),
        Query(AuditUsageQueryParams {
            from: "2025-01-01T00:00:00Z".to_owned(),
            until: "2026-03-01T00:00:00Z".to_owned(),
            provider: None,
            model: None,
            purpose: None,
        }),
    )
    .await;
    assert!(matches!(result, Err(GatewayError::BadRequest(_))));
}

#[tokio::test]
async fn query_audit_applies_global_markup_to_reported_provider_cost() {
    let mut state = state_with_credits(true, true);
    Arc::get_mut(&mut state)
        .expect("test state has one owner")
        .config
        .credits
        .markup_bps = 2000;
    state.log_audit(AuditRecord {
        key_id: None,
        request_id: "marked-up-provider".to_string(),
        api_key: "sk-master".to_string(),
        user_name: None,
        org_id: Some("org-1".to_string()),
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "acme".to_string(),
        model: "gpt-4o".to_string(),
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 5,
        eval_score: None,
        error: None,
        skill_ids: None,
        session_id: None,
        user_id: None,
        agent_id: None,
        feature: None,
        purpose: None,
        managed_inference: true,
        provider_cost_micro_usd: Some(1000),
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
    wait_for_audit_entries(&state, 1).await;

    let Json(body) = query_audit(
        State(Arc::clone(&state)),
        loopback(),
        bearer("sk-master"),
        empty_params(),
    )
    .await
    .expect("master key may read the audit log");
    assert_eq!(body["entries"][0]["cost_micro_usd"], 1200);
}

#[tokio::test]
async fn query_audit_returns_openrouter_transaction_cost_for_managed_rows() {
    let mut state = state_with_credits(true, true);
    let gateway_config = &mut Arc::get_mut(&mut state)
        .expect("test state has one owner")
        .config;
    gateway_config.credits.markup_bps = 2000;
    gateway_config.credits.provider_billing.insert(
        ProviderId::from("openrouter"),
        ProviderBillingPolicy {
            mode: ProviderBillingMode::PassThrough,
        },
    );
    state.log_audit(AuditRecord {
        key_id: None,
        request_id: "managed-openrouter".to_string(),
        api_key: "sk-master".to_string(),
        user_name: None,
        org_id: Some("org-1".to_string()),
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "openrouter".to_string(),
        model: "openai/gpt-5.6-sol".to_string(),
        input_tokens: 1000,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 5,
        eval_score: None,
        error: None,
        skill_ids: None,
        session_id: None,
        user_id: None,
        agent_id: None,
        feature: None,
        purpose: None,
        managed_inference: true,
        provider_cost_micro_usd: Some(1250),
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
    wait_for_audit_entries(&state, 1).await;

    let Json(body) = query_audit(
        State(Arc::clone(&state)),
        loopback(),
        bearer("sk-master"),
        empty_params(),
    )
    .await
    .expect("master key may read the audit log");
    assert_eq!(body["entries"][0]["source"], "managed");
    assert_eq!(body["entries"][0]["cost_micro_usd"], 1250);
}
