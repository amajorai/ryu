//! Scanner unit tests: config-gated sanitize, custom patterns, companion and
//! outbound redaction, and the per-kind scan entry.

use super::*;
use crate::config::{CustomPattern, FirewallConfig, FirewallPolicy};

fn scanner_with(redact_pii: bool, redact_secrets: bool) -> FirewallScanner {
    FirewallScanner::new(FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        redact_pii,
        redact_secrets,
        ..FirewallConfig::default()
    })
}

#[test]
fn sanitize_replaces_pii_and_secret_when_both_enabled() {
    let scanner = scanner_with(true, true);
    let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
    let out = scanner.sanitize(text);
    assert!(
        !out.contains("user@example.com"),
        "PII email should be redacted: {out}"
    );
    assert!(
        !out.contains("sk-abcdefghijklmnopqrstu"),
        "secret key should be redacted: {out}"
    );
    assert!(
        out.contains("[REDACTED:"),
        "output should contain placeholder: {out}"
    );
}

#[test]
fn sanitize_leaves_text_untouched_when_both_disabled() {
    let scanner = scanner_with(false, false);
    let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
    let out = scanner.sanitize(text);
    assert_eq!(
        out, text,
        "no redaction should occur when both flags are false"
    );
}

#[test]
fn sanitize_redacts_only_pii_when_secrets_disabled() {
    let scanner = scanner_with(true, false);
    let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
    let out = scanner.sanitize(text);
    assert!(
        !out.contains("user@example.com"),
        "PII email should be redacted: {out}"
    );
    assert!(
        out.contains("sk-abcdefghijklmnopqrstu"),
        "secret key should NOT be redacted when redact_secrets=false: {out}"
    );
}

#[test]
fn sanitize_redacts_only_secrets_when_pii_disabled() {
    let scanner = scanner_with(false, true);
    let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
    let out = scanner.sanitize(text);
    assert!(
        out.contains("user@example.com"),
        "PII email should NOT be redacted when redact_pii=false: {out}"
    );
    assert!(
        !out.contains("sk-abcdefghijklmnopqrstu"),
        "secret key should be redacted: {out}"
    );
}

// ── Default policy: Block stops injection matches outright ────────────────

/// The firewall's default enforcement action is `Block`, on BOTH the enum
/// `Default` and the `FirewallConfig` struct default (the two paths a config
/// with `policy` omitted can arrive by). Injection matches are not
/// redactable, so any non-blocking default lets them proceed with the
/// attack text intact; Sanitize and warn-and-continue are opt-in.
#[test]
fn default_policy_is_block() {
    assert_eq!(FirewallPolicy::default(), FirewallPolicy::Block);
    assert_eq!(
        FirewallConfig::default().policy,
        FirewallPolicy::Block,
        "struct default and enum default must agree"
    );
}

/// A request carrying ONLY a bare secret (no PII, no injection) is detected by
/// the inbound scan — the precondition for the `Sanitize` policy to
/// redact it before egress. Prior to this, `scan_inbound` scanned injection +
/// PII only, so a secret-only prompt slipped through unredacted even under
/// Sanitize (the leak this flip closes).
#[test]
fn bare_secret_is_detected_inbound() {
    let scanner = FirewallScanner::new(FirewallConfig::default());
    // Canonical AWS example access-key id; matches `AKIA[0-9A-Z]{16}`.
    let hit = scanner.scan_inbound("please deploy with AKIAIOSFODNN7EXAMPLE now");
    let hit = hit.expect("bare secret must be detected inbound");
    assert_eq!(hit.kind, DetectionKind::Secret);
}

/// End-to-end at the scanner level: the sanitize pass (the redaction applied
/// when `policy = sanitize`) scrubs a detected secret from the text that
/// would egress to the provider.
#[test]
fn default_config_redacts_bare_secret_before_egress() {
    let scanner = FirewallScanner::new(FirewallConfig::default());
    let egress = scanner.sanitize("please deploy with AKIAIOSFODNN7EXAMPLE now");
    assert!(
        !egress.contains("AKIAIOSFODNN7EXAMPLE"),
        "secret must not survive into egress text: {egress}"
    );
    assert!(
        egress.contains("[REDACTED:"),
        "expected a redaction marker: {egress}"
    );
}

// ── Custom pattern tests ──────────────────────────────────────────────────

#[test]
fn custom_pii_pattern_is_scanned_and_redacted() {
    let scanner = FirewallScanner::new(FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        custom_patterns: vec![CustomPattern {
            name: "employee_id".to_string(),
            regex: r"EMP-\d{6}".to_string(),
            kind: CustomPatternKind::Pii,
        }],
        ..FirewallConfig::default()
    });
    // Inbound scan should trip on the custom PII pattern.
    let hit = scanner.scan_inbound("my badge is EMP-123456 thanks");
    assert!(hit.is_some(), "custom PII pattern should match inbound");
    // Sanitize should replace it with the name-derived marker.
    let out = scanner.sanitize("my badge is EMP-123456 thanks");
    assert!(
        !out.contains("EMP-123456"),
        "custom PII should be redacted: {out}"
    );
    assert!(
        out.contains("[REDACTED:EMPLOYEE_ID]"),
        "marker should derive from the pattern name: {out}"
    );
}

#[test]
fn custom_secret_pattern_is_redacted_outbound() {
    let scanner = FirewallScanner::new(FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        custom_patterns: vec![CustomPattern {
            name: "internal_token".to_string(),
            regex: r"INT_[A-Z0-9]{10}".to_string(),
            kind: CustomPatternKind::Secret,
        }],
        ..FirewallConfig::default()
    });
    let hit = scanner.scan_outbound("leaked INT_ABCDE12345 value");
    assert!(hit.is_some(), "custom secret pattern should match outbound");
}

#[test]
fn invalid_custom_pattern_is_skipped_not_fatal() {
    // An unclosed group is invalid regex; the scanner must still build and
    // keep the built-in patterns working.
    let scanner = FirewallScanner::new(FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        custom_patterns: vec![
            CustomPattern {
                name: "broken".to_string(),
                regex: r"(unclosed".to_string(),
                kind: CustomPatternKind::Pii,
            },
            CustomPattern {
                name: "".to_string(),
                regex: r"nonempty".to_string(),
                kind: CustomPatternKind::Pii,
            },
        ],
        ..FirewallConfig::default()
    });
    // Built-in email PII still fires despite the invalid custom entries.
    let out = scanner.sanitize("reach me at user@example.com");
    assert!(
        !out.contains("user@example.com"),
        "built-in PII must still redact when a custom pattern is invalid: {out}"
    );
}

// ── Companion egress redaction tests (#199) ───────────────────────────────

fn disabled_scanner() -> FirewallScanner {
    FirewallScanner::new(FirewallConfig {
        enabled: false,
        redact_pii: false,
        redact_secrets: false,
        ..FirewallConfig::default()
    })
}

/// AC1: companion-sourced text has PII and secrets masked in the output.
#[test]
fn redact_companion_egress_masks_pii_and_secrets() {
    // Use a scanner with firewall disabled to prove the method ignores config.
    let scanner = disabled_scanner();
    let text = "Email: user@example.com key=sk-abcdefghijklmnopqrstu";
    let (out, detected) = scanner.redact_companion_egress(text);
    assert!(
        !out.contains("user@example.com"),
        "companion egress must redact PII email regardless of config: {out}"
    );
    assert!(
        !out.contains("sk-abcdefghijklmnopqrstu"),
        "companion egress must redact secrets regardless of config: {out}"
    );
    assert!(
        out.contains("[REDACTED:"),
        "redacted text must contain placeholder: {out}"
    );
    assert!(
        detected.contains(&DetectionKind::Pii),
        "Pii must be reported in detected categories"
    );
    assert!(
        detected.contains(&DetectionKind::Secret),
        "Secret must be reported in detected categories"
    );
}

/// AC3 (firewall-disabled config cannot bypass companion redaction): even when
/// the local firewall is fully disabled, companion egress redaction still fires.
#[test]
fn redact_companion_egress_ignores_disabled_firewall_config() {
    let scanner = disabled_scanner();
    let text = "SSN: 123-45-6789 key: sk-abcdefghijklmnopqrstu";
    let (out, detected) = scanner.redact_companion_egress(text);
    assert!(
        !out.contains("123-45-6789"),
        "companion egress must redact PII even when firewall is disabled: {out}"
    );
    assert!(
        !detected.is_empty(),
        "at least one category must be detected"
    );
}

/// Clean text produces no detections and is passed through unmodified.
#[test]
fn redact_companion_egress_clean_text_passes_through() {
    let scanner = disabled_scanner();
    let text = "The weather today is sunny and warm.";
    let (out, detected) = scanner.redact_companion_egress(text);
    assert_eq!(out, text, "clean text must pass through unchanged");
    assert!(
        detected.is_empty(),
        "no categories must be detected for clean text"
    );
}

/// AC4: non-companion path (regular sanitize) is unchanged by the new method.
#[test]
fn regular_sanitize_unchanged_by_companion_method() {
    let scanner = scanner_with(true, true);
    let text = "Contact user@example.com or use key sk-abcdefghijklmnopqrstu";
    let regular = scanner.sanitize(text);
    // The companion method should also redact, but the regular path must be identical
    // to its pre-#199 behavior (PII + secrets redacted when both flags true).
    assert!(!regular.contains("user@example.com"));
    assert!(!regular.contains("sk-abcdefghijklmnopqrstu"));
}

// ── Outbound DLP redaction tests (OUTBOUND-DLP contract) ──────────────────

/// `redact_outbound` ignores the config gates, so a default scanner suffices.
fn default_scanner() -> FirewallScanner {
    FirewallScanner::new(FirewallConfig::default())
}

#[test]
fn redact_outbound_masks_github_classic_pat() {
    let fw = default_scanner();
    let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    let (out, hits) = fw.redact_outbound(&format!("token is {secret} ok"));
    assert!(!out.contains(secret), "classic PAT must be redacted: {out}");
    assert!(out.contains("[REDACTED:gh_pat]"), "got: {out}");
    assert!(hits.contains(&"gh_pat"));
}

#[test]
fn redact_outbound_masks_github_oauth_pat() {
    let fw = default_scanner();
    // gho_ is caught ONLY by the outbound rule (not by sanitize's secret set).
    let secret = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
    let (out, hits) = fw.redact_outbound(&format!("bearer {secret}"));
    assert!(!out.contains(secret), "OAuth PAT must be redacted: {out}");
    assert!(out.contains("[REDACTED:gh_pat]"));
    assert!(hits.contains(&"gh_pat"));
}

#[test]
fn redact_outbound_masks_openai_key() {
    let fw = default_scanner();
    let secret = "sk-abcdefghijklmnopqrstuvwx";
    let (out, hits) = fw.redact_outbound(&format!("key={secret}"));
    assert!(!out.contains(secret), "sk- key must be redacted: {out}");
    assert!(out.contains("[REDACTED:openai_key]"));
    assert!(hits.contains(&"openai_key"));
}

#[test]
fn redact_outbound_masks_aws_akid() {
    let fw = default_scanner();
    let secret = "AKIAIOSFODNN7EXAMPLE";
    let (out, hits) = fw.redact_outbound(&format!("aws {secret} end"));
    assert!(!out.contains(secret), "AKIA id must be redacted: {out}");
    assert!(out.contains("[REDACTED:aws_akid]"));
    assert!(hits.contains(&"aws_akid"));
}

#[test]
fn redact_outbound_masks_bearer_token() {
    let fw = default_scanner();
    let text = "Authorization: Bearer abcdef0123456789ABCDEF";
    let (out, hits) = fw.redact_outbound(text);
    assert!(
        !out.contains("abcdef0123456789ABCDEF"),
        "bearer token must be redacted: {out}"
    );
    assert!(out.contains("[REDACTED:bearer]"));
    assert!(hits.contains(&"bearer"));
}

#[test]
fn redact_outbound_masks_token_and_password_params() {
    let fw = default_scanner();
    let (out, hits) = fw.redact_outbound("?token=abcd1234efgh&password=hunter2secret");
    assert!(
        !out.contains("abcd1234efgh"),
        "token= must be redacted: {out}"
    );
    assert!(
        !out.contains("hunter2secret"),
        "password= must be redacted: {out}"
    );
    assert!(hits.contains(&"token_param"));
    assert!(hits.contains(&"secret_param"));
}

#[test]
fn redact_outbound_marker_is_stable() {
    let fw = default_scanner();
    let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    let (out, _) = fw.redact_outbound(&format!("{secret} then {secret}"));
    // Same shape twice → identical placeholder both times, secret gone.
    assert!(!out.contains(secret));
    assert_eq!(out.matches("[REDACTED:gh_pat]").count(), 2, "got: {out}");
}

#[test]
fn redact_outbound_clean_text_unchanged() {
    let fw = default_scanner();
    let text = "The quick brown fox jumps over the lazy dog.";
    let (out, hits) = fw.redact_outbound(text);
    assert_eq!(out, text, "clean text must pass through unchanged");
    assert!(hits.is_empty(), "no markers should fire on clean text");
}

// ── Unified-evaluator detection kinds (P3) ────────────────────────────────

/// The code_injection detector flags the canonical `os.system("rm -rf /")`
/// payload (both the os.system call and the rm -rf shape), and passes clean text.
#[test]
fn scan_kind_flags_code_injection() {
    let fw = default_scanner();
    let hit = fw.scan_kind(r#"os.system("rm -rf /")"#, DetectionKind::CodeInjection);
    assert!(hit.is_some(), "os.system rm -rf must be flagged");
    assert_eq!(hit.unwrap().kind, DetectionKind::CodeInjection);

    assert!(
        fw.scan_kind(
            "please summarize this document",
            DetectionKind::CodeInjection
        )
        .is_none(),
        "benign text must not flag code injection"
    );
}

/// code_injection also catches eval()/exec()/backticks/$()/<script>/SQLi shapes.
#[test]
fn scan_kind_code_injection_variants() {
    let fw = default_scanner();
    for payload in [
        "eval(userInput)",
        "exec('id')",
        "result = `whoami`",
        "x = $(cat /etc/passwd)",
        "<script>alert(1)</script>",
        "' OR 1=1 --",
        "1 UNION SELECT password FROM users",
    ] {
        assert!(
            fw.scan_kind(payload, DetectionKind::CodeInjection)
                .is_some(),
            "must flag: {payload}"
        );
    }
}

/// scan_kind ignores the global enabled/scan_* gates (an enabled per-agent
/// binding fires even when the node firewall is off), and returns None for the
/// image kinds (no regex representation).
#[test]
fn scan_kind_ignores_gate_and_image_kinds() {
    let fw = FirewallScanner::new(FirewallConfig {
        enabled: false,
        scan_inbound: false,
        scan_outbound: false,
        ..FirewallConfig::default()
    });
    assert!(
        fw.scan_kind("reach me at user@example.com", DetectionKind::Pii)
            .is_some(),
        "scan_kind must fire even with the firewall disabled"
    );
    assert!(
        fw.scan_kind("anything", DetectionKind::ExplicitImage)
            .is_none(),
        "image kinds have no regex set"
    );
}

/// The lexical toxicity/bias seeds trip on obvious payloads (the authoritative
/// judgment is the LLM-judge path; this proves the seed is not a no-op).
#[test]
fn scan_kind_toxicity_and_bias_seed() {
    let fw = default_scanner();
    assert!(fw
        .scan_kind("you are a worthless piece of shit", DetectionKind::Toxicity)
        .is_some());
    assert!(fw
        .scan_kind("all women are inferior", DetectionKind::Bias)
        .is_some());
    assert!(fw
        .scan_kind("a friendly, helpful reply", DetectionKind::Toxicity)
        .is_none());
}
