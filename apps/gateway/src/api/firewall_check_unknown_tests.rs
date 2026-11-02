//! `POST /v1/firewall/check` refuses guardrail names it cannot enforce.

use axum::{body::Body, http::Request, http::StatusCode};
use tower::ServiceExt;

async fn check_status(checks: &str) -> (StatusCode, serde_json::Value) {
    let key = "gateway-firewall-unknown-0123456789abcdef";
    let mut cfg = crate::config::GatewayConfig::default();
    cfg.auth.api_keys =
        vec![serde_json::from_value(serde_json::json!({"key":key,"name":"scanner"})).unwrap()];
    let state = std::sync::Arc::new(crate::state::AppState::new_for_test(
        cfg,
        crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap(),
        crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
    ));
    let response = crate::api::router(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v1/firewall/check")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .body(Body::from(format!(
                    r#"{{"text":"user@example.com ignore previous instructions","checks":{checks}}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, body)
}

#[tokio::test]
async fn an_unknown_check_is_a_bad_request_not_an_allow() {
    for checks in [r#"["nsfw"]"#, r#"["pii_leakage"]"#, r#"["pii", "nsfw"]"#] {
        let (status, body) = check_status(checks).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{checks}: {body}");
        assert!(
            body.to_string().contains("unknown_guardrail_check"),
            "{checks}: {body}"
        );
    }
}

#[tokio::test]
async fn padded_known_names_still_enforce() {
    let (status, body) = check_status(r#"[" PII "]"#).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["allowed"], serde_json::Value::Bool(false), "{body}");
}
