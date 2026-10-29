use super::*;
use crate::audit::AuditLogger;
use axum::{
    routing::{get, post},
    Json, Router,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[tokio::test]
async fn accepted_hosted_speech_delivery_failure_keeps_one_debit_one_audit_no_regeneration() {
    let submissions = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&submissions);
    let vendor_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let vendor_base = format!("http://{}", vendor_listener.local_addr().unwrap());
    let reference = format!("{vendor_base}/result");
    let vendor = Router::new().route("/voice", post(move || { let observed = Arc::clone(&observed); let reference = reference.clone(); async move { observed.fetch_add(1, Ordering::SeqCst); Json(serde_json::json!({"status":"COMPLETED","response_url":reference,"metrics":{"inference_time":1.0}})) } })).route("/result", get(|| async { Json(serde_json::json!({"audio":{"url":"https://unknown-cdn.invalid/audio.mp3"}})) }));
    let vendor_task = tokio::spawn(async move {
        axum::serve(vendor_listener, vendor).await.unwrap();
    });
    let debits = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let observed = Arc::clone(&debits);
    let ledger = Router::new().route(
        "/api/credits/debit",
        post(move |Json(body): Json<Value>| {
            let observed = Arc::clone(&observed);
            async move {
                observed.lock().await.push(body);
                Json(serde_json::json!({"balanceMicroUsd":1000000}))
            }
        }),
    );
    let ledger_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ledger_base = format!("http://{}", ledger_listener.local_addr().unwrap());
    let ledger_task = tokio::spawn(async move {
        axum::serve(ledger_listener, ledger).await.unwrap();
    });
    let audit_path =
        std::env::temp_dir().join(format!("ryu-speech-audit-{}.sqlite", uuid::Uuid::new_v4()));
    let mut config = crate::config::GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("fal");
    config.routing.fallback_chain = vec![];
    config.firewall.enabled = false;
    config.credits.enabled = true;
    config.credits.base_url = ledger_base;
    config.credits.internal_secret = Some("ledger-secret".into());
    let audit = AuditLogger::new(&crate::config::AuditConfig {
        enabled: true,
        db_path: audit_path.to_string_lossy().into_owned(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    state
        .provider_runtime
        .register_for_test(Arc::new(ryu_gw_providers::FalProvider::new(
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            "vendor-secret".into(),
            vendor_base,
            1,
            2,
        )));
    let state = Arc::new(state);
    let mut ctx = super::test_support::plain_request_context();
    ctx.managed_inference = true;
    ctx.org_id = Some("speech-org".into());
    ctx.request_id = "hosted-speech-delivery".into();
    ctx.remaining_budget_micro_usd = Some(1000000);
    ctx.unrestricted_budget_micro_usd = Some(1000000);
    let (output, origin) = run_speech(
        Arc::clone(&state),
        ctx,
        serde_json::json!({"model":"voice","input":"Hello","voice":"alloy"}),
    )
    .await
    .unwrap();
    assert_eq!(output.provider_used, "fal");
    assert!(origin.unwrap().complete(&output.response).await.is_err());
    tokio::time::timeout(Duration::from_secs(3), async {
        while debits.lock().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let debits = debits.lock().await;
    assert_eq!(debits.len(), 1);
    assert_eq!(debits[0]["reason"], "gateway_usage");
    assert_eq!(debits[0]["provider"], "fal");
    assert_eq!(submissions.load(Ordering::SeqCst), 1);
    let query = crate::audit::AuditQuery {
        request_id: Some("hosted-speech-delivery".into()),
        ..Default::default()
    };
    let rows = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let rows = state.audit.query(&query).unwrap();
            if !rows.is_empty() {
                break rows;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].event_type, "model_call");
    vendor_task.abort();
    ledger_task.abort();
}
