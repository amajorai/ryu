//! Fail-closed outbound Sanitize: PII or a secret that only the normalized
//! scan sees (fullwidth `＠`, a zero-width split, fullwidth digits) must be
//! redacted or refused on every outbound path, never released as "sanitized".

use super::*;
use crate::config::{FirewallConfig, FirewallPolicy, GatewayConfig};
use crate::evaluators::EvaluatorBinding;
use crate::firewall::FirewallScanner;
use crate::pipeline::gen_ai_telemetry::dlp_content_guard;
use crate::pipeline::stream_dlp::StreamingDlp;

const FULLWIDTH_EMAIL: &str = "alice\u{FF20}example.com";
const ZWSP_EMAIL: &str = "alice@exa\u{200B}mple.com";
/// `4111 1111 1111 1111` (Luhn-valid) in fullwidth digits.
const FULLWIDTH_CARD: &str = "\u{FF14}\u{FF11}\u{FF11}\u{FF11} \u{FF11}\u{FF11}\u{FF11}\u{FF11} \
                              \u{FF11}\u{FF11}\u{FF11}\u{FF11} \u{FF11}\u{FF11}\u{FF11}\u{FF11}";
const ZWSP_AWS_KEY: &str = "AKIA\u{200B}IOSFODNN7EXAMPLE";
/// An SSN with a TAG `Z` inside: the scan reads it with TAGs stripped, the
/// in-place fold cannot remove it.
const TAG_SSN: &str = "123-45\u{E005A}-6789";

fn leaks(text: &str) -> bool {
    [
        "alice",
        "mple.com",
        "\u{FF11}",
        "4111",
        "IOSFODNN7EXAMPLE",
        "6789",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn sanitize_config() -> FirewallConfig {
    FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        ..FirewallConfig::default()
    }
}

fn state_with(firewall: FirewallConfig) -> Arc<AppState> {
    let config = GatewayConfig {
        firewall,
        ..GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    Arc::new(AppState::new_for_test(config, audit, evals))
}

fn ctx() -> RequestContext {
    crate::pipeline::test_support::plain_request_context()
}

fn reply(content: &str) -> Value {
    serde_json::json!({
        "model": "m",
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": content } }]
    })
}

fn sse(parts: &[&str]) -> String {
    let mut raw = String::new();
    for part in parts {
        let frame = serde_json::json!({
            "id": "c1",
            "object": "chat.completion.chunk",
            "choices": [{ "index": 0, "delta": { "content": part } }]
        });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    raw
}

#[test]
fn sanitize_json_strings_redacts_fold_only_pii_and_secrets() {
    let scanner = FirewallScanner::new_scoped(sanitize_config());
    for hidden in [
        FULLWIDTH_EMAIL,
        ZWSP_EMAIL,
        FULLWIDTH_CARD,
        ZWSP_AWS_KEY,
        TAG_SSN,
    ] {
        let mut value = reply(&format!("contact {hidden} today"));
        sanitize_json_strings(&mut value, &scanner);
        let text = value.to_string();
        assert!(!leaks(&text), "{hidden:?} survived: {text}");
    }
}

#[test]
fn sanitize_text_refolds_or_reports_the_survivor() {
    let scanner = FirewallScanner::new_scoped(sanitize_config());
    let refolded = sanitize_text_or_survivor(&format!("mail {ZWSP_EMAIL}"), &scanner)
        .expect("a zero-width split folds and redacts");
    assert_eq!(refolded, "mail [REDACTED:EMAIL]");
    assert!(sanitize_text_or_survivor(&format!("ssn {TAG_SSN}"), &scanner).is_err());
    assert!(!sanitize_pending("plain words", &scanner));
    assert!(sanitize_pending(FULLWIDTH_EMAIL, &scanner));
}

#[test]
fn outbound_json_sanitize_redacts_fold_only_pii() {
    let state = state_with(sanitize_config());
    for hidden in [FULLWIDTH_EMAIL, ZWSP_EMAIL, FULLWIDTH_CARD] {
        let mut response = reply(&format!("contact {hidden} today"));
        let clean = apply_outbound_json_dlp(&state, &ctx(), &mut response)
            .expect("a redactable match is sanitized, not blocked");
        assert!(!clean);
        assert!(
            !leaks(&response.to_string()),
            "{hidden:?} reached the client"
        );
    }
}

#[test]
fn outbound_json_sanitize_blocks_a_match_split_across_strings() {
    let state = state_with(sanitize_config());
    let mut response = reply("see below");
    response["extra"] = serde_json::json!(["ssn 123-45", "6789"]);
    assert!(matches!(
        apply_outbound_json_dlp(&state, &ctx(), &mut response),
        Err(GatewayError::FirewallBlocked(..))
    ));
}

#[test]
fn buffered_sse_sanitize_masks_fold_only_pii() {
    let scanner = FirewallScanner::new_scoped(sanitize_config());
    let cases = [
        sse(&[&format!("contact {FULLWIDTH_EMAIL} today")]),
        sse(&["contact alice@exa\u{200B}", "mple.com today"]),
        sse(&["contact alice\u{FF20}exa", "mple.com today"]),
    ];
    for raw in cases {
        let (rewritten, assembled, violation) =
            rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).unwrap();
        assert!(violation.is_some());
        assert!(!leaks(&rewritten), "client bytes leaked: {rewritten}");
        assert!(!leaks(&assembled));
    }
}

#[test]
fn buffered_sse_sanitize_refuses_a_surviving_split() {
    let scanner = FirewallScanner::new_scoped(sanitize_config());
    // Two object keys the mask never rewrites, adjacent on the scan view.
    let frame = serde_json::json!({
        "choices": [{ "index": 0, "delta": { "content": "hi" } }],
        "x": { "123-45": null, "6789": null }
    });
    let raw = format!("data: {frame}\n\ndata: [DONE]\n\n");
    assert!(rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize).is_err());
}

#[test]
fn buffered_sse_sanitize_refuses_a_cross_frame_split_the_mask_skips() {
    let scanner = FirewallScanner::new_scoped(sanitize_config());
    // A field beside `choices` is outside the mask; its lane joins the two
    // halves only across frames, where the per-frame scan view never does.
    let mut raw = String::new();
    for (content, extra) in [("hi ", "ssn 123-45"), ("there", "-6789")] {
        let frame = serde_json::json!({
            "choices": [{ "index": 0, "delta": { "content": content } }],
            "x": extra
        });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    let error = rewrite_sse_for_dlp(&raw, &scanner, &FirewallPolicy::Sanitize)
        .expect_err("a surviving cross-frame match refuses the stream");
    assert!(error.contains("could not be redacted"), "{error}");

    // The incremental stream holds frames that carry a tool call and ends
    // with a block notice instead of releasing the two halves.
    let mut raw = String::new();
    for (name, extra) in [("lookup", "ssn 123-45"), ("", "-6789")] {
        let frame = serde_json::json!({
            "choices": [{ "index": 0, "delta": { "tool_calls": [
                { "index": 0, "function": { "name": name, "arguments": "{}" } }
            ] } }],
            "x": extra
        });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    let mut dlp = StreamingDlp::new(FirewallPolicy::Sanitize, true);
    let mut out = String::new();
    for line in raw.split_inclusive("\n\n") {
        out.push_str(&dlp.push(line.as_bytes(), &scanner).unwrap().bytes);
    }
    let last = dlp.finish(&scanner).unwrap();
    out.push_str(&last.bytes);
    assert!(last.blocked, "{out}");
    assert!(out.contains("could not be redacted"), "{out}");
    assert!(!leaks(&out), "client bytes leaked: {out}");
}

#[test]
fn incremental_stream_sanitize_masks_fold_only_pii() {
    let scanner = FirewallScanner::new_scoped(sanitize_config());
    let cases = [
        sse(&[&format!("contact {FULLWIDTH_EMAIL} today. "), "More text. "]),
        sse(&[
            "contact alice\u{FF20}exa",
            "mple.com today. ",
            "More text. ",
        ]),
        sse(&[
            "contact alice@exa\u{200B}",
            "mple.com today. ",
            "More text. ",
        ]),
    ];
    for raw in cases {
        let mut dlp = StreamingDlp::new(FirewallPolicy::Sanitize, true);
        let mut out = String::new();
        for line in raw.split_inclusive("\n\n") {
            out.push_str(&dlp.push(line.as_bytes(), &scanner).unwrap().bytes);
        }
        let last = dlp.finish(&scanner).unwrap();
        out.push_str(&last.bytes);
        assert!(!last.blocked);
        assert!(!leaks(&out), "client bytes leaked: {out}");
    }
}

#[test]
fn telemetry_guard_sanitize_withholds_fold_only_pii() {
    let state = state_with(sanitize_config());
    let guard = dlp_content_guard(&state, &ctx());
    let mut value = reply(&format!("contact {FULLWIDTH_EMAIL} or {ZWSP_EMAIL}"));
    assert!(guard(&mut value));
    assert!(!leaks(&value.to_string()));
}

fn pii_leakage_state(redact_pii: bool) -> Arc<AppState> {
    state_with(FirewallConfig {
        // The node firewall stays off so only the evaluator acts.
        enabled: false,
        redact_pii,
        evaluators: vec![EvaluatorBinding {
            id: "pii_leakage".into(),
            enabled: true,
            inline_action: Some(FirewallPolicy::Sanitize),
            offline: None,
            locked: false,
        }],
        ..FirewallConfig::default()
    })
}

#[tokio::test]
async fn pii_leakage_sanitize_redacts_or_blocks_non_stream() {
    let state = pii_leakage_state(true);
    for hidden in [FULLWIDTH_EMAIL, "123\u{200B}-45-6789"] {
        let mut response = reply(&format!("contact {hidden}"));
        apply_inline_output_evaluators(&state, &ctx(), &mut response)
            .await
            .expect("a redactable match is sanitized");
        assert!(
            !leaks(&response.to_string()),
            "{hidden:?} reached the client"
        );
    }

    // `redact_pii` off: Sanitize removes nothing, so the flagged reply is refused.
    let state = pii_leakage_state(false);
    let mut response = reply(&format!("contact {FULLWIDTH_EMAIL}"));
    assert!(matches!(
        apply_inline_output_evaluators(&state, &ctx(), &mut response).await,
        Err(GatewayError::FirewallBlocked(..))
    ));
}

async fn stream_through(state: Arc<AppState>, raw: String) -> String {
    let (body, _permit) = apply_outbound_firewall_stream(
        Body::from(raw),
        state,
        ctx(),
        crate::concurrency::AdmissionPermit::none(),
    )
    .await;
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[tokio::test]
async fn pii_leakage_sanitize_redacts_or_blocks_stream() {
    let raw = sse(&["contact alice\u{FF20}exa", "mple.com today"]);
    let out = stream_through(pii_leakage_state(true), raw.clone()).await;
    assert!(!leaks(&out), "client bytes leaked: {out}");
    assert!(!out.contains("blocked"));

    let out = stream_through(pii_leakage_state(false), raw).await;
    assert!(!leaks(&out), "client bytes leaked: {out}");
    assert!(out.contains("Response blocked by evaluator"), "{out}");
}
