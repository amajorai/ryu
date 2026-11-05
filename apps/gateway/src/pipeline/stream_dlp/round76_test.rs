//! Round 76: once a Sanitize or Warn violation is recorded, detection is not
//! re-run (or re-logged) on every later push, and redaction still applies.
//! The long-cut probe's own scanner hits never log at `warn` either.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::scan_test::scanner;
use super::StreamingDlp;
use crate::config::{FirewallConfig, FirewallPolicy};
use crate::firewall::{FirewallBackend, FirewallMatch, FirewallScanner};
use crate::pipeline::log_capture::LogBuffer;
use crate::pipeline::outbound_detection_test::{sse, state_with, stream_through, REQUEST_ID};

/// The built-in scanner, counting `scan_outbound` matches.
struct Counting {
    inner: FirewallScanner,
    matches: AtomicUsize,
}

impl FirewallBackend for Counting {
    fn config(&self) -> &FirewallConfig {
        self.inner.config()
    }
    fn policy(&self) -> &FirewallPolicy {
        self.inner.policy()
    }
    fn outbound_enabled(&self) -> bool {
        self.inner.outbound_enabled()
    }
    fn scan_inbound(&self, text: &str) -> Option<FirewallMatch> {
        self.inner.scan_inbound(text)
    }
    fn scan_outbound(&self, text: &str) -> Option<FirewallMatch> {
        let found = self.inner.scan_outbound(text);
        if found.is_some() {
            self.matches.fetch_add(1, Ordering::Relaxed);
        }
        found
    }
    fn scan_locked_guardrails(&self, text: &str, guardrails: &[String]) -> Option<FirewallMatch> {
        self.inner.scan_locked_guardrails(text, guardrails)
    }
    fn sanitize(&self, text: &str) -> String {
        FirewallBackend::sanitize(&self.inner, text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        self.inner.redact_outbound(text)
    }
}

#[test]
fn a_recorded_violation_is_not_detected_again_on_every_push() {
    let counting = Counting {
        inner: scanner(),
        matches: AtomicUsize::new(0),
    };
    let mut dlp = StreamingDlp::new(FirewallPolicy::Sanitize, true);
    let mut out = String::new();
    let mut parts = vec!["Mail ".to_owned(), "john@example.com ".to_owned()];
    parts.extend(std::iter::repeat_n("and ".to_owned(), 70));
    for part in &parts {
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part } }] });
        out.push_str(
            &dlp.push(format!("data: {frame}\n\n").as_bytes(), &counting)
                .unwrap()
                .bytes,
        );
    }
    out.push_str(&dlp.finish(&counting).unwrap().bytes);
    assert!(!out.contains("john@example.com"), "{out}");
    assert!(
        counting.matches.load(Ordering::Relaxed) <= 2,
        "{}",
        counting.matches.load(Ordering::Relaxed)
    );
}

// The long-cut probe (`long_cut_safe`) re-scans a long token's tail on every
// push after the token closes, and that tail alone can match where the whole
// text does not. The probe decides nothing, so its scanner hits must never
// reach `warn`: a response logs its decision once, and a clean response logs
// no `warn` line at all.

/// Pushes after the long token, each releasing text and re-running the probe.
const PUSHES: usize = 40;

/// A minified-JSON token far longer than the scan reach, with an email near
/// its end, then short words.
fn email_token_parts() -> Vec<String> {
    let token = format!(
        "{{\"k\":\"{}\",\"mail\":\"john@example.com\"}}",
        "a".repeat(10_000)
    );
    let mut parts = vec![format!("{token} ")];
    parts.extend(std::iter::repeat_n("and ".to_owned(), PUSHES));
    parts
}

/// A long token whose probed tail starts exactly at an IBAN glued to the
/// letters before it: the tail alone sees a word boundary there and matches,
/// the whole text does not. The pad places the probe's cut on the IBAN.
fn clean_token_parts() -> Vec<String> {
    let token = format!(
        "{{\"k\":\"{}GB29NWBK60161331926819\",\"pad\":\"{}\"}}",
        "q".repeat(9_982),
        "b".repeat(4_318)
    );
    let mut parts = vec![format!("{token} ")];
    parts.extend(std::iter::repeat_n("x ".to_owned(), PUSHES));
    parts
}

/// Scanner hits and whether any step recorded a violation.
fn probe(parts: &[String], policy: FirewallPolicy) -> (usize, bool) {
    let counting = Counting {
        inner: scanner(),
        matches: AtomicUsize::new(0),
    };
    let enforce = !matches!(policy, FirewallPolicy::WarnAndContinue);
    let mut dlp = StreamingDlp::new(policy, enforce);
    let mut violated = false;
    for part in parts {
        let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part } }] });
        let output = dlp
            .push(format!("data: {frame}\n\n").as_bytes(), &counting)
            .unwrap();
        violated |= output.violation.is_some();
    }
    violated |= dlp.finish(&counting).unwrap().violation.is_some();
    (counting.matches.load(Ordering::Relaxed), violated)
}

#[test]
fn the_long_cut_probe_repeats_scanner_hits_the_dlp_never_decides_on() {
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let (matches, violated) = probe(&email_token_parts(), policy.clone());
        assert!(violated, "{policy:?}");
        assert!(matches > 2, "{policy:?}: the probe repeats ({matches})");
    }
    let (matches, violated) = probe(&clean_token_parts(), FirewallPolicy::WarnAndContinue);
    assert!(!violated, "the whole text holds no match");
    assert!(matches > 0, "the tail alone matches ({matches})");
}

#[tokio::test]
async fn a_long_token_response_logs_its_decision_once() {
    for (policy, message) in [
        (
            FirewallPolicy::WarnAndContinue,
            "firewall: outbound violation (warn-and-continue, streaming)",
        ),
        (
            FirewallPolicy::Sanitize,
            "firewall: sanitized outbound response (streaming)",
        ),
    ] {
        let (state, ctx) = state_with(policy, true, Vec::new());
        let buffer = LogBuffer::default();
        let parts = email_token_parts();
        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
        stream_through(state, ctx, sse(&parts), &buffer).await;
        let captured = buffer.text();
        let warns = buffer.warn_lines();
        assert_eq!(warns.len(), 1, "{captured}");
        assert!(warns[0].contains(message), "{captured}");
        assert!(
            warns[0].contains(&format!("request_id={REQUEST_ID}")),
            "{captured}"
        );
    }
}

#[tokio::test]
async fn a_clean_long_token_response_logs_no_warning() {
    for policy in [FirewallPolicy::WarnAndContinue, FirewallPolicy::Sanitize] {
        let (state, ctx) = state_with(policy, true, Vec::new());
        let buffer = LogBuffer::default();
        let parts = clean_token_parts();
        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
        let delivered = stream_through(state, ctx, sse(&parts), &buffer).await;
        assert!(delivered.contains("GB29NWBK60161331926819"));
        let captured = buffer.text();
        assert!(buffer.warn_lines().is_empty(), "{captured}");
    }
}
