//! `POST /v1/exec/audit` ingest and the `POST /v1/exec/budget/check` pre-run
//! gate, including per-widget-instance rate limits.

use super::test_support::{bearer, state_with, wait_for_audit_entries};
use super::{check_exec_budget, ingest_exec_audit, ExecAuditBody, ExecBudgetCheckBody};
use crate::audit::{AuditLogger, AuditQuery};
use crate::config::{AuditConfig, AuthConfig, EvalsConfig, GatewayConfig};
use crate::error::GatewayError;
use crate::evals::EvalsRunner;
use crate::state::AppState;
use crate::tools::exec::WidgetEnvelope;
use axum::extract::State;
use axum::Json;
use std::sync::Arc;

fn exec_body() -> ExecAuditBody {
    ExecAuditBody {
        backend: "wasmtime".to_string(),
        command: "echo hi".to_string(),
        duration_ms: 42,
        exit_code: 0,
        session_id: Some("s1".to_string()),
        error: None,
        event_type: None,
        agent_id: None,
        user_id: None,
        user_name: None,
        feature: None,
    }
}

#[tokio::test]
async fn ingest_exec_rejects_untrusted_keys() {
    let state = state_with(false);
    let res = ingest_exec_audit(State(state), bearer("sk-plain"), Json(exec_body())).await;
    assert!(
        matches!(res, Err(GatewayError::Unauthorized(_))),
        "a non-trusted key must not forge exec rows"
    );
}

#[tokio::test]
async fn ingest_exec_records_and_advances_the_budget_counter() {
    let state = state_with(false);
    assert_eq!(state.exec_budget.current_count(), 0);
    let Json(body) = ingest_exec_audit(
        State(Arc::clone(&state)),
        bearer("sk-master"),
        Json(exec_body()),
    )
    .await
    .expect("master key may ingest");
    assert_eq!(body["ok"], true);
    assert_eq!(body["exec_count"], 1);
    assert_eq!(state.exec_budget.current_count(), 1);
}

#[tokio::test]
async fn ingest_credential_read_does_not_drain_the_exec_budget() {
    let state = state_with(false);
    let mut b = exec_body();
    b.event_type = Some("credential_read".to_string());
    let Json(body) = ingest_exec_audit(State(Arc::clone(&state)), bearer("sk-core"), Json(b))
        .await
        .expect("trusted forwarder may ingest");
    assert_eq!(body["ok"], true);
    // A credential read is a distinct event and must NOT count against exec budget.
    assert_eq!(state.exec_budget.current_count(), 0);
}

#[tokio::test]
async fn service_event_cannot_be_forged_through_exec_ingest_or_drain_sandbox_quota() {
    let state = state_with(false);
    let mut body = exec_body();
    body.event_type = Some("service_call".into());
    assert!(matches!(
        ingest_exec_audit(State(Arc::clone(&state)), bearer("sk-core"), Json(body)).await,
        Err(GatewayError::BadRequest(_))
    ));
    assert_eq!(state.exec_budget.current_count(), 0);
}

#[tokio::test]
async fn ingest_exec_preserves_agent_and_caller_attribution() {
    let state = state_with(true);
    let mut body = exec_body();
    body.agent_id = Some("agent-support".to_owned());
    body.user_id = Some("user-1".to_owned());
    body.user_name = Some("Jia Wei".to_owned());
    body.feature = Some("agent".to_owned());

    ingest_exec_audit(State(Arc::clone(&state)), bearer("sk-core"), Json(body))
        .await
        .expect("trusted forwarder may ingest");
    wait_for_audit_entries(&state, 1).await;

    let entries = state
        .audit
        .query(&AuditQuery {
            agent_id: Some("agent-support".to_owned()),
            ..Default::default()
        })
        .expect("query by agent id");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].user_id.as_deref(), Some("user-1"));
    assert_eq!(entries[0].user_name.as_deref(), Some("Jia Wei"));
    assert_eq!(entries[0].feature.as_deref(), Some("agent"));
}

// ── check_exec_budget ─────────────────────────────────────────────────────

fn check_body(widget: Option<WidgetEnvelope>) -> ExecBudgetCheckBody {
    check_body_with_feature(widget, None)
}

fn check_body_with_feature(
    widget: Option<WidgetEnvelope>,
    feature: Option<&str>,
) -> ExecBudgetCheckBody {
    ExecBudgetCheckBody {
        backend: "wasmtime".to_string(),
        command: "echo".to_string(),
        feature: feature.map(str::to_owned),
        widget,
    }
}

#[tokio::test]
async fn check_exec_budget_allows_under_default_unlimited_budget() {
    let state = state_with(false);
    let Json(resp) = check_exec_budget(State(state), bearer("sk-master"), Json(check_body(None)))
        .await
        .expect("master key");
    assert!(resp.allowed);
    assert!(resp.reason.is_none());
}

#[tokio::test]
async fn check_exec_budget_rejects_untrusted_keys() {
    let state = state_with(false);
    let res = check_exec_budget(State(state), bearer("sk-plain"), Json(check_body(None))).await;
    assert!(matches!(res, Err(GatewayError::Unauthorized(_))));
}

#[tokio::test]
async fn check_exec_budget_denies_a_widget_over_its_per_instance_rate() {
    // Drive the widget max_calls_per_min down to 1 so the second call denies.
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut config = GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some("sk-master".to_string()),
            api_keys: vec![],
        },
        ..GatewayConfig::default()
    };
    config.widget.enabled = true;
    config.widget.max_calls_per_min = 1;
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));

    let envelope = || {
        Some(WidgetEnvelope {
            instance_id: "widget-rate-instance".to_string(),
            origin_server: "com.acme.app".to_string(),
        })
    };
    // First widget call is allowed.
    let Json(first) = check_exec_budget(
        State(Arc::clone(&state)),
        bearer("sk-master"),
        Json(check_body(envelope())),
    )
    .await
    .unwrap();
    assert!(first.allowed);
    // Second, same instance, same minute ⇒ denied with a rate-limit reason.
    let Json(second) = check_exec_budget(
        State(Arc::clone(&state)),
        bearer("sk-master"),
        Json(check_body(envelope())),
    )
    .await
    .unwrap();
    assert!(!second.allowed);
    assert!(second.reason.unwrap().contains("rate limit"));
}

#[tokio::test]
async fn check_exec_budget_denies_a_widget_followup_over_its_per_instance_rate() {
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut config = GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some("sk-master".to_string()),
            api_keys: vec![],
        },
        ..GatewayConfig::default()
    };
    config.widget.enabled = true;
    config.widget.max_followups_per_min = 1;
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));

    let envelope = || {
        Some(WidgetEnvelope {
            instance_id: "widget-followup-rate-instance".to_string(),
            origin_server: "com.acme.app".to_string(),
        })
    };
    let body = || check_body_with_feature(envelope(), Some("widget-followup"));
    let Json(first) =
        check_exec_budget(State(Arc::clone(&state)), bearer("sk-master"), Json(body()))
            .await
            .unwrap();
    assert!(first.allowed);

    let Json(second) = check_exec_budget(State(state), bearer("sk-master"), Json(body()))
        .await
        .unwrap();
    assert!(!second.allowed);
    assert!(second.reason.unwrap().contains("follow-up rate limit"));
}
