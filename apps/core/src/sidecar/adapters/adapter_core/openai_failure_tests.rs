//! A failed Gateway-plane turn carries Core messages (`i18n`) whose English
//! render is the card's title and message, on the live frames and on the
//! persisted `error` part, so the card reads in the reader's locale.

use super::*;
use crate::i18n::AlertText;

fn wire(failure: &AcpFailure) -> Value {
    failure
        .i18n_wire()
        .expect("every Gateway-plane failure carries i18n")
}

/// Title and body are Core messages whose English render is the card.
fn assert_localized(failure: &AcpFailure, code: &str, title: &str, body_source: &str) {
    assert_eq!(failure.code, code);
    assert_eq!(failure.title, title);
    let text = AlertText::from_wire(&wire(failure)).expect("wire parses");
    assert_eq!(
        text.render("en"),
        (failure.title.clone(), failure.message.clone())
    );
    assert_eq!(wire(failure)["body"][0]["message"], body_source);
}

fn gateway_body(kind: &str, message: &str) -> String {
    serde_json::json!({ "error": { "message": message, "type": kind, "code": kind } }).to_string()
}

#[test]
fn insufficient_credits_is_the_ryu_credits_card() {
    let failure = upstream_failure(
        402,
        &gateway_body(
            "insufficient_credits",
            "organization credit balance exhausted",
        ),
    );
    assert_localized(
        &failure,
        "insufficient_credits",
        "Ryu credits exhausted",
        &Message::new(m::ACP_RYU_CREDITS_MESSAGE).render("en"),
    );
    // No " (insufficient_credits)" suffix reaches the card.
    assert!(!failure.message.contains("insufficient_credits"));
}

#[test]
fn rate_limits_get_the_rate_limit_card() {
    let failure = upstream_failure(
        429,
        &gateway_body("rate_limit_exceeded", "Rate limit exceeded."),
    );
    assert_localized(
        &failure,
        "rate_limited",
        "Rate limit reached",
        &Message::new(m::GATEWAY_RATE_LIMIT_MESSAGE).render("en"),
    );
    // A bare 429 from a raw provider is the same card.
    assert_eq!(upstream_failure(429, "").code, "rate_limited");
}

#[test]
fn typed_gateway_refusals_map_to_their_cards() {
    for (status, kind, code, title) in [
        (
            402,
            "budget_exceeded",
            "budget_exceeded",
            "Spend budget reached",
        ),
        (
            429,
            "provider_rate_limited",
            "provider_rate_limited",
            "Provider rate limit reached",
        ),
        (
            404,
            "model_not_found",
            "model_not_found",
            "Model unavailable",
        ),
        (
            503,
            "circuit_open",
            "circuit_open",
            "Provider temporarily unavailable",
        ),
    ] {
        let failure = upstream_failure(status, &gateway_body(kind, "raw gateway text"));
        assert_eq!(failure.code, code);
        assert_eq!(failure.title, title);
        assert!(!failure.message.contains("raw gateway text"), "{code}");
        assert_eq!(
            wire(&failure)["body"].as_array().map(Vec::len),
            Some(1),
            "{code}"
        );
    }
}

#[test]
fn the_abuse_ladder_is_read_from_its_code() {
    let throttled = serde_json::json!({ "error": {
        "message": "limited", "type": "rate_limit_exceeded", "code": "abuse_throttled",
    } });
    let failure = upstream_failure(429, &throttled.to_string());
    assert_eq!(failure.code, "abuse_throttled");
    assert_eq!(failure.title, "Requests temporarily limited");
    let restricted = serde_json::json!({ "error": {
        "message": "restricted", "type": "policy_violation", "code": "account_restricted",
    } });
    assert_eq!(
        upstream_failure(403, &restricted.to_string()).title,
        "Account restricted"
    );
}

#[test]
fn an_unknown_refusal_relays_the_gateway_text_under_a_localized_title() {
    let failure = upstream_failure(
        403,
        &gateway_body("policy_violation", "Request blocked by firewall: secrets"),
    );
    assert_eq!(failure.code, "policy_violation");
    assert_eq!(failure.title, "Request failed");
    assert_eq!(failure.message, "Request blocked by firewall: secrets");
    let text = AlertText::from_wire(&wire(&failure)).expect("wire parses");
    assert!(text.body.is_empty(), "the card keeps the relayed message");
}

#[test]
fn a_non_json_error_names_the_status() {
    let failure = upstream_failure(502, "<html>bad gateway</html>");
    assert_eq!(failure.code, "upstream_error");
    assert_eq!(failure.message, "The model returned HTTP 502.");
    assert_eq!(wire(&failure)["body"][0]["args"]["status"], "502");
}

/// A listener that accepts and then never answers, so a request times out
/// after its headers are sent.
async fn silent_server() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    format!("http://{address}/v1/chat/completions")
}

#[tokio::test]
async fn a_stall_names_the_idle_limit_in_seconds() {
    let client = build_stream_http_client(
        std::time::Duration::from_secs(5),
        std::time::Duration::from_millis(200),
    );
    let error = client
        .post(silent_server().await)
        .body("{}")
        .send()
        .await
        .expect_err("a silent upstream times out");
    let failure = connect_failure(&error, std::time::Duration::from_secs(45));
    assert_localized(
        &failure,
        "model_stalled",
        "Model stopped responding",
        "The model stopped responding after {seconds} seconds.",
    );
    assert_eq!(
        failure.message,
        "The model stopped responding after 45 seconds."
    );
    // A string arg, which the chat card's renderer accepts (it rejects a
    // `{ number }` object and would fall back to English).
    assert_eq!(wire(&failure)["body"][0]["args"]["seconds"], "45");
}

#[tokio::test]
async fn an_unreachable_model_keeps_the_transport_error_as_detail() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let error = reqwest::Client::new()
        .post(format!("http://{address}/"))
        .send()
        .await
        .expect_err("nothing listens");
    let failure = connect_failure(&error, std::time::Duration::from_secs(30));
    assert_eq!(failure.code, "model_unreachable");
    assert_eq!(failure.title, "Couldn't reach the model");
    assert!(failure.message.starts_with("Couldn't reach the model."));
    assert_eq!(
        wire(&failure)["body"][0]["args"]["detail"],
        error.to_string()
    );
}

#[test]
fn the_error_frames_carry_the_card_then_end_the_stream() {
    let failure = upstream_failure(402, &gateway_body("insufficient_credits", "exhausted"));
    let frames = error_ui_frames(&failure);
    let first = String::from_utf8(frames[0].clone()).unwrap();
    let card: Value = serde_json::from_str(first.trim().trim_start_matches("data:").trim())
        .expect("first frame is JSON");
    assert_eq!(card["type"], "data-ryu-error");
    assert_eq!(card["transient"], true);
    assert_eq!(card["data"], failure_part(&failure));
    assert_eq!(card["data"]["i18n"], wire(&failure));
    let error = String::from_utf8(frames[1].clone()).unwrap();
    assert!(error.contains(r#""type":"error""#), "{error}");
    assert!(
        error.contains(&failure.message),
        "errorText stays the English card"
    );
    assert_eq!(frames.len(), 4, "card, error, finish, [DONE]");
}

#[test]
fn fallback_and_core_errors_stay_localizable() {
    let primary = AcpFailure::from("Gateway inference credential unavailable".to_owned());
    assert_eq!(primary.code, "agent_error");
    assert_eq!(primary.title, "Request failed");
    assert_eq!(primary.message, "Gateway inference credential unavailable");
    let fallback = upstream_failure(502, "");
    let both = fallback_failure(&primary, &fallback);
    assert_eq!(both.code, "fallback_failed");
    assert!(both.message.contains("primary provider failed"));
    assert!(both.message.contains("fallback also failed"));
    assert_eq!(
        rejection_text(
            m::TURN_GATEWAY_AGENT_PROOF_UNAVAILABLE_MESSAGE,
            Some("expired")
        ),
        "The Gateway agent proof is unavailable: expired"
    );
    assert_eq!(
        rejection_text(m::TURN_NO_USER_MESSAGE_MESSAGE, None),
        "There is no user message to send to the agent."
    );
}
