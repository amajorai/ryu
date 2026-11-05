//! `[firewall] log_detections` gates the firewall stage's own log line for a
//! match that a non-blocking policy lets through.

use super::log_capture::LogBuffer;
use super::*;
use crate::config::FirewallConfig;

/// Runs the firewall stage over a request carrying a bare secret under
/// `WarnAndContinue` and returns the stage's own log line.
async fn warn_and_continue_line(log_detections: bool) -> String {
    let mut config = crate::GatewayConfig::default();
    config.firewall = FirewallConfig {
        policy: FirewallPolicy::WarnAndContinue,
        log_detections,
        ..FirewallConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let state = Arc::new(AppState::new_for_test(config, audit, evals));
    let ctx = test_support::plain_request_context();
    let mut body = json!({
        "model": "gpt-4o",
        "messages": [{ "role": "user", "content": "deploy with AKIAIOSFODNN7EXAMPLE now" }]
    });
    let scanner = state.resolved_scanner(&ctx);
    let prompt = extract_text_for_scanning(&body);
    let definitions = extract_definition_text(&body);
    let residual = outbound_text::chat_residual_text(&body);

    let buffer = LogBuffer::default();
    let guard = buffer.capture();
    firewall_stage(
        &state,
        &ctx,
        &mut body,
        &scanner,
        &prompt,
        &definitions,
        &residual,
    )
    .await
    .expect("warn-and-continue admits the request");
    drop(guard);

    let captured = buffer.text();
    captured
        .lines()
        .find(|line| line.contains("firewall: inbound violation (warn-and-continue)"))
        .unwrap_or_else(|| panic!("the stage logs the match: {captured}"))
        .to_owned()
}

#[tokio::test]
async fn a_let_through_firewall_match_warns_only_when_log_detections_is_on() {
    let loud = warn_and_continue_line(true).await;
    assert!(loud.contains("WARN"), "{loud}");
    assert!(loud.contains("pattern="), "{loud}");

    let quiet = warn_and_continue_line(false).await;
    assert!(quiet.contains("DEBUG"), "{quiet}");
    assert!(!quiet.contains("WARN"), "{quiet}");
}
