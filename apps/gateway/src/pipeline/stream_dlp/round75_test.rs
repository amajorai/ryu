//! Round 75: the standing refusal an evaluator Sanitize rebuilds keeps the
//! DLP's own Sanitize verdict.

use serde_json::json;

use super::scan_test::scanner;

#[test]
fn a_rebuilt_refusal_trailer_is_sanitized_under_an_active_sanitize() {
    let scanner = scanner();
    let refusal = json!({ "error": { "code": "invalid_api_key",
        "message": "key owner alice@example.org" } });
    let raw = format!(
        "data: {}\n\ndata: {refusal}\n\ndata: [DONE]\n\n",
        json!({ "choices": [{ "index": 0, "delta": { "content": "mail bob@example.com" } }] })
    );
    let sanitized =
        super::super::evaluator_sanitized(&scanner, &raw, &crate::config::FirewallPolicy::Sanitize);
    assert!(sanitized.contains("invalid_api_key"), "{sanitized}");
    assert!(!sanitized.contains("alice@example.org"), "{sanitized}");
    assert!(!sanitized.contains("bob@example.com"), "{sanitized}");
    let redacted = super::super::evaluator_sanitized(
        &scanner,
        &raw,
        &crate::config::FirewallPolicy::WarnAndContinue,
    );
    assert!(redacted.contains("invalid_api_key"), "{redacted}");
    assert!(!redacted.contains("bob@example.com"), "{redacted}");
}
