//! Companion egress redaction must remove PII and secrets the normalized scan
//! detects, not only what the raw-text patterns match.

use super::redact::COMPANION_MASK;
use super::*;

/// A locally disabled firewall: companion redaction must ignore it.
fn disabled_scanner() -> FirewallScanner {
    FirewallScanner::new_scoped(FirewallConfig {
        enabled: false,
        redact_pii: false,
        redact_secrets: false,
        ..FirewallConfig::default()
    })
}

fn tags(ascii: &str) -> String {
    ascii
        .chars()
        .map(|c| char::from_u32(0xE0000 + c as u32).unwrap())
        .collect()
}

#[test]
fn fullwidth_email_is_redacted_and_audited() {
    let fw = disabled_scanner();
    let text = "mail \u{FF41}\u{FF4C}\u{FF49}\u{FF43}\u{FF45}\u{FF20}\u{FF45}\u{FF58}\u{FF41}\u{FF4D}\u{FF50}\u{FF4C}\u{FF45}\u{FF0E}\u{FF43}\u{FF4F}\u{FF4D} today";
    let (out, detected) = fw.redact_companion_egress(text);
    assert_eq!(out, "mail [REDACTED:EMAIL] today");
    assert_eq!(detected, vec![DetectionKind::Pii]);
}

#[test]
fn zero_width_split_ssn_and_secret_are_redacted() {
    let fw = disabled_scanner();
    let (out, detected) = fw.redact_companion_egress("ssn 123\u{200B}-45-6789");
    assert!(!out.contains("6789"), "{out}");
    assert!(detected.contains(&DetectionKind::Pii));

    let (out, detected) =
        fw.redact_companion_egress("key sk-\u{200B}abcdefghijklmnopqrstuvwxyz0123");
    assert!(!out.contains("abcdefghij"), "{out}");
    assert!(detected.contains(&DetectionKind::Secret));
}

#[test]
fn a_match_only_the_scan_view_joins_masks_the_whole_text() {
    let fw = disabled_scanner();
    // TAG characters inside the address hide it from both rewrite passes, but
    // the visible text a reader sees is still the address.
    let text = format!("contact alice@exa{}mple.com", tags("~ "));
    let (out, detected) = fw.redact_companion_egress(&text);
    assert_eq!(out, COMPANION_MASK);
    assert!(detected.contains(&DetectionKind::Pii));
}

#[test]
fn clean_unicode_text_is_left_unfolded() {
    let fw = disabled_scanner();
    let text = "\u{FF48}\u{FF45}\u{FF4C}\u{FF4C}\u{FF4F}\u{3000}\u{4E16}\u{754C}";
    let (out, detected) = fw.redact_companion_egress(text);
    assert_eq!(out, text);
    assert!(detected.is_empty());
}

#[test]
fn companion_messages_never_carry_a_fullwidth_email() {
    let fw = disabled_scanner();
    let mut messages = serde_json::json!([
        {"role": "user", "content": "reach me at \u{FF42}\u{FF4F}\u{FF42}\u{FF20}example\u{FF0E}com"},
        {"role": "user", "content": [{"type": "text", "text": "card 4111\u{2011}1111\u{2011}1111\u{2011}1111"}]}
    ]);
    fw.companion_sanitize_messages(&mut messages);
    let first = messages[0]["content"].as_str().unwrap();
    assert!(!first.contains("example"), "{first}");
    assert!(first.contains("[REDACTED:EMAIL]"), "{first}");
    let second = messages[1]["content"][0]["text"].as_str().unwrap();
    assert!(!second.contains("1111"), "{second}");
}

/// A violation excerpt is redacted even when the firewall's own redaction is
/// off, and obfuscated PII cannot survive into storage.
#[test]
fn violation_excerpts_redact_regardless_of_config() {
    let fw = disabled_scanner();
    let backend: &dyn FirewallBackend = &fw;
    let fullwidth = "mail alice\u{FF20}example.com";
    let excerpt = backend.redact_excerpt(fullwidth);
    assert!(!excerpt.contains("alice"), "{excerpt}");
    assert!(!excerpt.contains("example"), "{excerpt}");
    let excerpt =
        backend.redact_excerpt("key ghp_abcdefghijklmnopqrstuvwxyz0123456789 ssn 123-45-6789");
    assert!(!excerpt.contains("ghp_abc"), "{excerpt}");
    assert!(!excerpt.contains("6789"), "{excerpt}");
    assert_eq!(backend.redact_excerpt("nothing to hide"), "nothing to hide");
    // The config-gated path this replaces would have kept the address.
    assert!(fw.sanitize(fullwidth).contains("alice"));
}
