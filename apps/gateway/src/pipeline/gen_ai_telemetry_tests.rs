//! The firewall-policy mapping that guards exported gen_ai span content
//! (`gen_ai_telemetry::dlp_content_guard`). The span mechanism itself is
//! covered in `telemetry::gen_ai_span`; these tests pin the decision that keeps
//! a raw prompt or completion out of the OTLP collector: the request's resolved
//! firewall policy, not a hand-written closure, decides whether content is
//! withheld (Block), sanitized (Sanitize) or redacted (WarnAndContinue).
use serde_json::{json, Value};

use super::{gen_ai_telemetry::dlp_content_guard, test_support::plain_request_context};
use crate::{
    audit::AuditLogger,
    config::{AuditConfig, FirewallPolicy, GatewayConfig},
    evals::EvalsRunner,
    state::AppState,
};

const AWS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
const EMAIL: &str = "alice@corp.example";

fn state_with(policy: FirewallPolicy, scan_outbound: bool) -> AppState {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config.cache.enabled = false;
    config.firewall.enabled = true;
    config.firewall.scan_inbound = true;
    config.firewall.scan_outbound = scan_outbound;
    config.firewall.policy = policy;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()))
}

/// Run the request's content guard over `value`, returning whether the
/// content may be exported and what it looks like afterwards.
fn guard(policy: FirewallPolicy, scan_outbound: bool, mut value: Value) -> (bool, Value) {
    let state = state_with(policy, scan_outbound);
    let guard = dlp_content_guard(&state, &plain_request_context());
    let keep = guard(&mut value);
    (keep, value)
}

fn messages(content: &str) -> Value {
    json!([{ "role": "assistant", "content": content }])
}

#[test]
fn block_policy_withholds_content_with_a_detected_secret() {
    let (keep, _) = guard(
        FirewallPolicy::Block,
        true,
        messages(&format!("deploy with {AWS_KEY}")),
    );
    assert!(!keep, "Block must withhold span content holding a secret");
}

#[test]
fn block_policy_withholds_content_with_detected_pii() {
    let (keep, _) = guard(
        FirewallPolicy::Block,
        true,
        messages(&format!("mail {EMAIL} today")),
    );
    assert!(!keep, "Block must withhold span content holding PII");
}

#[test]
fn block_policy_exports_clean_content_unchanged() {
    let original = messages("the weather is nice");
    let (keep, value) = guard(FirewallPolicy::Block, true, original.clone());
    assert!(keep);
    assert_eq!(value, original);
}

#[test]
fn sanitize_policy_exports_sanitized_content() {
    let (keep, value) = guard(
        FirewallPolicy::Sanitize,
        true,
        messages(&format!("mail {EMAIL} with {AWS_KEY}")),
    );
    assert!(keep, "Sanitize exports the content once sanitized");
    let text = value.to_string();
    assert!(!text.contains(EMAIL), "PII must be sanitized: {text}");
    assert!(!text.contains(AWS_KEY), "secret must be sanitized: {text}");
    assert!(text.contains("[REDACTED:"), "{text}");
    assert!(text.contains("mail "), "surrounding text survives: {text}");
}

/// WarnAndContinue mirrors the client response: the unconditional outbound
/// redaction scrubs secret tokens, but PII the client also sees is left as is.
#[test]
fn warn_and_continue_policy_exports_redacted_content() {
    let (keep, value) = guard(
        FirewallPolicy::WarnAndContinue,
        true,
        messages(&format!("mail {EMAIL} with {AWS_KEY}")),
    );
    assert!(keep, "WarnAndContinue exports the content");
    let text = value.to_string();
    assert!(!text.contains(AWS_KEY), "secret must be redacted: {text}");
    assert!(text.contains("[REDACTED:aws_akid]"), "{text}");
    assert!(
        text.contains(EMAIL),
        "WarnAndContinue redacts, it does not sanitize PII: {text}"
    );
}

/// A value the outbound scan does not flag still goes through the
/// unconditional external-token redaction, whatever the policy: with outbound
/// scanning off, a Block policy must neither withhold nor export the raw key.
#[test]
fn unflagged_content_still_gets_external_token_redaction() {
    for policy in [
        FirewallPolicy::Block,
        FirewallPolicy::Sanitize,
        FirewallPolicy::WarnAndContinue,
    ] {
        let (keep, value) = guard(
            policy.clone(),
            false,
            json!({ "prompt": format!("use {AWS_KEY}") }),
        );
        assert!(keep, "{policy:?}: unflagged content is exported");
        let text = value.to_string();
        assert!(!text.contains(AWS_KEY), "{policy:?}: {text}");
        assert!(text.contains("[REDACTED:aws_akid]"), "{policy:?}: {text}");
    }
}

/// Secrets in object keys are scrubbed too, not only string leaves.
#[test]
fn redaction_reaches_object_keys() {
    let (keep, value) = guard(
        FirewallPolicy::WarnAndContinue,
        true,
        json!({ AWS_KEY: "value" }),
    );
    assert!(keep);
    let text = value.to_string();
    assert!(!text.contains(AWS_KEY), "{text}");
}
