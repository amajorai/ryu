//! What an account's answer means, read from what the vendors really send.
use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};

use super::answer::{self, Answer, Vendor};

const OPUS: &str = "claude-opus-4-5";

fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in pairs {
        headers.insert(*name, HeaderValue::from_str(value).unwrap());
    }
    headers
}

fn classify(status: u16, pairs: &[(&'static str, &str)], body: Value) -> Answer {
    let now = Utc.with_ymd_and_hms(2026, 11, 20, 0, 0, 0).unwrap();
    answer::classify_at(
        StatusCode::from_u16(status).unwrap(),
        &headers(pairs),
        body.to_string().as_bytes(),
        OPUS,
        now,
    )
}

#[test]
fn a_limit_answer_is_held_until_the_reset_the_vendor_names() {
    let hours = |h: u64| Some(Duration::from_secs(h * 60 * 60));
    let reset = Utc.with_ymd_and_hms(2026, 11, 20, 5, 0, 0).unwrap();
    // Claude subscription: five hour limit, epoch seconds.
    let epoch = reset.timestamp().to_string();
    let limited = classify(
        429,
        &[("anthropic-ratelimit-unified-reset", &epoch)],
        json!({"type": "error", "error": {"type": "rate_limit_error", "message": "limit"}}),
    );
    assert_eq!(limited, Answer::Limited(hours(5)));
    // Retry-After and the RFC 3339 headers; the latest wins.
    let limited = classify(
        429,
        &[
            ("retry-after", "60"),
            ("anthropic-ratelimit-tokens-reset", "2026-11-20T02:00:00Z"),
        ],
        json!({}),
    );
    assert_eq!(limited, Answer::Limited(hours(2)));
    // ChatGPT Codex names the reset in its body.
    let limited = classify(
        429,
        &[],
        json!({"error": {"type": "usage_limit_reached", "resets_in_seconds": 10800}}),
    );
    assert_eq!(limited, Answer::Limited(hours(3)));
    // A limit that names no reset.
    assert_eq!(classify(429, &[], json!({})), Answer::Limited(None));
    // A reset in the past says nothing.
    assert_eq!(
        classify(
            429,
            &[("anthropic-ratelimit-unified-reset", "1")],
            json!({})
        ),
        Answer::Limited(None)
    );
}

#[test]
fn no_access_to_the_requested_model_is_told_apart_from_other_refusals() {
    let anthropic = json!({"type": "error", "error": {"type": "not_found_error", "message": format!("model: {OPUS}")}});
    assert_eq!(classify(404, &[], anthropic), Answer::NoModel);
    let openai = json!({"error": {"code": "model_not_found", "message": format!("The model `{OPUS}` does not exist")}});
    assert_eq!(classify(404, &[], openai), Answer::NoModel);
    let codex = json!({"detail": format!("The '{OPUS}' model is not supported when using Codex with a ChatGPT account.")});
    assert_eq!(classify(400, &[], codex), Answer::NoModel);
    let plan = json!({"error": {"type": "permission_error", "message": format!("Your plan does not have access to {OPUS}")}});
    assert_eq!(classify(403, &[], plan), Answer::NoModel);

    // A refusal that does not name the model, or names it for another reason.
    let other = json!({"error": {"type": "invalid_request_error", "message": "temperature is not supported"}});
    assert_eq!(classify(400, &[], other), Answer::Final);
    let login = json!({"error": {"type": "authentication_error", "message": "invalid token"}});
    assert_eq!(classify(401, &[], login.clone()), Answer::Skip);
    assert_eq!(classify(403, &[], login), Answer::Skip);
    assert_eq!(classify(409, &[], json!({})), Answer::Skip);
    assert_eq!(classify(500, &[], json!({})), Answer::Final);
    assert_eq!(classify(529, &[], json!({})), Answer::Final);
    assert_eq!(classify(200, &[], json!({})), Answer::Served);
}

async fn read(response: axum::response::Response) -> (StatusCode, HeaderMap, Value) {
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, headers, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn every_account_out_is_one_clear_answer_with_the_first_reset() {
    let wait = Duration::from_secs(3 * 60 * 60 + 10);
    let (status, headers, body) = read(answer::all_limited(Vendor::Anthropic, wait)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(headers["retry-after"], "10810");
    assert_eq!(body["type"], "error");
    assert_eq!(body["error"]["type"], "rate_limit_error");
    assert_eq!(
        body["error"]["message"],
        "Every account this agent can use is at its usage limit. The first one resets in about 3 hours."
    );
    let (status, _, body) =
        read(answer::all_limited(Vendor::OpenAi, Duration::from_secs(90))).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["error"]["code"], "usage_limit_reached");
    assert!(body["error"]["message"]
        .as_str()
        .unwrap()
        .ends_with("about 2 minutes."));

    let (status, _, body) = read(answer::no_account_for(Vendor::Anthropic, OPUS)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"]["message"].as_str().unwrap().contains(OPUS));
}
