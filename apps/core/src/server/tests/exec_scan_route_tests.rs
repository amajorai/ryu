use crate::server::{exec_scan, exec_scan_reply, ExecScanBody};
use crate::sidecar::gateway::ExecScanOutcome;
use axum::Json;

/// Env vars `check_exec_scan` reads. Captured and restored around each test
/// so the crate-wide gateway env lock is the only cross-test coupling.
const SCAN_ENV: &[&str] = &[
    "RYU_EXEC_APPROVAL_MODE",
    "RYU_GATEWAY_URL",
    "RYU_ALLOW_GATEWAY_FALLBACK",
];

fn capture_env() -> Vec<(&'static str, Option<String>)> {
    SCAN_ENV
        .iter()
        .map(|k| (*k, std::env::var(k).ok()))
        .collect()
}

fn restore_env(saved: &[(&'static str, Option<String>)]) {
    for (key, value) in saved {
        match value {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }
}

fn body(command: &str) -> ExecScanBody {
    serde_json::from_value(serde_json::json!({ "command": command, "agent_id": "ryu" }))
        .expect("ExecScanBody literal")
}

async fn call(command: &str) -> (axum::http::StatusCode, serde_json::Value) {
    let response = exec_scan(Json(body(command))).await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body reads");
    (
        status,
        serde_json::from_slice(&bytes).expect("JSON response body"),
    )
}

/// The wire vocabulary, pinned: the gateway's three decision strings survive
/// the proxy verbatim, and only a non-allow verdict carries a `reason`.
#[test]
fn exec_scan_reply_renders_every_verdict() {
    assert_eq!(
        exec_scan_reply(ExecScanOutcome::Allow),
        serde_json::json!({ "decision": "allow" })
    );
    assert_eq!(
        exec_scan_reply(ExecScanOutcome::ApprovalRequired("ask first".to_owned())),
        serde_json::json!({ "decision": "approval_required", "reason": "ask first" })
    );
    assert_eq!(
        exec_scan_reply(ExecScanOutcome::Deny("nope".to_owned())),
        serde_json::json!({ "decision": "deny", "reason": "nope" })
    );
}

/// THE test for this route. A `deny` must arrive as **HTTP 200** carrying the
/// verdict, because the Pi extension reads any non-2xx as "the scanner is
/// unreachable". That now also blocks, but with a generic outage reason
/// instead of the policy's own — a 403 here would hide why it was refused.
///
/// The deny itself is produced the same way a real outage would produce it:
/// the gate armed (nothing set) against an unreachable gateway, with the
/// fallback opt-out absent, i.e. `check_exec_scan`'s fail-closed path.
#[tokio::test]
async fn exec_scan_denies_with_http_200_so_the_caller_cannot_fall_back() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let saved = capture_env();
    std::env::remove_var("RYU_EXEC_APPROVAL_MODE");
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");

    let (status, verdict) = call("rm -rf /").await;
    restore_env(&saved);

    assert_eq!(
        status,
        axum::http::StatusCode::OK,
        "a deny MUST be a 200; the caller treats non-2xx as a transport \
             failure and falls back to its local denylist"
    );
    assert_eq!(verdict["decision"], "deny");
    assert!(
        verdict["reason"].as_str().is_some_and(|r| !r.is_empty()),
        "a deny must carry a reason the model can be shown, got {verdict}"
    );
}

/// The operator opt-out is inherited, not reimplemented: with the gate
/// explicitly disarmed the route allows without touching the network (the
/// gateway URL points at a closed port, so any HTTP call would fail closed).
#[tokio::test]
async fn exec_scan_inherits_the_off_mode_short_circuit() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let saved = capture_env();
    std::env::set_var("RYU_EXEC_APPROVAL_MODE", "off");
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");

    let (status, verdict) = call("echo hi").await;
    restore_env(&saved);

    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(verdict, serde_json::json!({ "decision": "allow" }));
}

/// An empty command is answered `deny` at 200, not `400`: a 4xx is
/// indistinguishable from an unreachable Core at the caller, so it would fail
/// open. Also proves the route never reaches the gateway for it — the URL
/// below would otherwise fail closed with a network reason.
#[tokio::test]
async fn exec_scan_answers_an_empty_command_with_a_200_deny() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let saved = capture_env();
    std::env::set_var("RYU_EXEC_APPROVAL_MODE", "off");
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");

    let (status, verdict) = call("   ").await;
    restore_env(&saved);

    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(verdict["decision"], "deny");
}

/// `agent_id` is optional and never authorizes anything, so its absence must
/// parse rather than 4xx (a 4xx would be read as a transport failure and fail
/// open). Pinned because the neighbouring `/api/mcp/tools/call` REQUIRES the
/// same-named field, and the difference is deliberate.
#[test]
fn exec_scan_body_accepts_a_missing_agent_id() {
    let parsed: ExecScanBody =
        serde_json::from_value(serde_json::json!({ "command": "ls" })).expect("parse");
    assert_eq!(parsed.agent_id, None);
    assert_eq!(parsed.command, "ls");
}
