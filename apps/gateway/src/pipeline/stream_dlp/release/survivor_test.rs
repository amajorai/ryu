//! Fail-closed Sanitize and visible-length holds in the stream DLP: a match
//! only the scan view shows never passes as redacted, and invisible padding
//! cannot stretch a bounded match past the release window.

use std::sync::Arc;

use super::super::scan_test::{bare_stream, run_streaming, scanner};
use super::super::*;
use crate::config::{FirewallConfig, GatewayConfig};
use crate::state::AppState;

#[test]
fn invisible_padding_cannot_stretch_a_bounded_match_past_the_window() {
    // `987 65 4321` with 80 zero-width spaces (240 bytes) after each digit of
    // the leading groups: the raw text runs far past BOUNDED_MATCH_LEN while
    // the scan view is the 11-byte SSN, so no digit may leave early.
    let scanner = scanner();
    let pad = "\u{200B}".repeat(80);
    let mut owned = vec!["ssn ".to_owned()];
    for group in ["987", "65"] {
        for digit in group.chars() {
            owned.push(format!("{digit}{pad}"));
        }
        owned.push(" ".to_owned());
    }
    owned.extend(["4321 ".to_owned(), "and more ".to_owned()]);
    let parts: Vec<&str> = owned.iter().map(String::as_str).collect();
    let raw = bare_stream(&parts);
    // One push per frame, so each frame is a release decision of its own.
    let frame_ends: Vec<usize> = raw.match_indices("\n\n").map(|(at, _)| at + 2).collect();
    let (streamed, blocked) =
        run_streaming(&raw, &frame_ends, FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "{streamed}");
    let released = streamed.split("Response blocked by policy").next().unwrap();
    for digit in ['9', '8', '7', '6', '5'] {
        assert!(!released.contains(digit), "{digit} released: {released}");
    }
}

#[test]
fn tag_padding_cannot_stretch_a_bounded_match_past_the_window() {
    // As above, with 80 TAG `a` characters (320 bytes) after each digit: the
    // visible view (TAG characters dropped) is the SSN, and TAG letters break
    // the digit chain, so only the window's scan-view count holds the digits
    // back. TAG characters count for nothing in it.
    let scanner = scanner();
    let pad = "\u{E0061}".repeat(80);
    let mut owned = vec!["ssn ".to_owned()];
    for group in ["987", "65"] {
        for digit in group.chars() {
            owned.push(format!("{digit}{pad}"));
        }
        owned.push(" ".to_owned());
    }
    owned.extend(["4321 ".to_owned(), "and more ".to_owned()]);
    let parts: Vec<&str> = owned.iter().map(String::as_str).collect();
    let raw = bare_stream(&parts);
    let frame_ends: Vec<usize> = raw.match_indices("\n\n").map(|(at, _)| at + 2).collect();
    let (streamed, blocked) =
        run_streaming(&raw, &frame_ends, FirewallPolicy::Block, &scanner).unwrap();
    assert!(blocked, "{streamed}");
    let released = streamed.split("Response blocked by policy").next().unwrap();
    for digit in ['9', '8', '7', '6', '5'] {
        assert!(!released.contains(digit), "{digit} released: {released}");
    }
}

#[test]
fn the_window_counts_scan_view_bytes() {
    // TAG characters count for nothing and a fullwidth digit for its one-byte
    // fold, as `bounded_cut` on main counted them; zero-width ones as before.
    let scanner = scanner();
    let mut dlp = StreamingDlp::new(FirewallPolicy::Block, true);
    let raw = bare_stream(&["x \u{FF11}\u{FF12}\u{FF13}\u{E0061}\u{200B}"]);
    let frame_end = raw.find("\n\n").unwrap() + 2;
    dlp.push(&raw.as_bytes()[..frame_end], &scanner).unwrap();
    let end = dlp.len();
    assert_eq!(dlp.back_visible_capped(end, 3), (end - 16, false));
}

async fn drive(policy: FirewallPolicy, parts: &[&str]) -> String {
    let config = GatewayConfig {
        firewall: FirewallConfig {
            policy: policy.clone(),
            ..FirewallConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let state = Arc::new(AppState::new_for_test(config, audit, evals));
    let ctx = crate::pipeline::test_support::plain_request_context();
    let scanner = state.resolved_scanner(&ctx);
    let mut raw = String::new();
    for part in parts {
        let frame =
            serde_json::json!({ "choices": [{ "index": 0, "delta": { "content": part } }] });
        raw.push_str(&format!("data: {frame}\n\n"));
    }
    raw.push_str("data: [DONE]\n\n");
    let body = dlp_body(raw.into(), state, ctx, scanner, policy, true, true);
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[tokio::test]
async fn sanitize_masks_a_fold_only_address_split_across_deltas() {
    let out = drive(
        FirewallPolicy::Sanitize,
        &["mail alice\u{FF20}exa", "mple.com today. ", "Bye. "],
    )
    .await;
    assert!(!out.contains("alice") && !out.contains("mple.com"), "{out}");
    assert!(out.ends_with("data: [DONE]\n\n"));
}

#[tokio::test]
async fn block_replaces_the_stream_with_the_notice() {
    let out = drive(
        FirewallPolicy::Block,
        &["key sk-abcdefghijklmnopqrstuvwxyz0123 ", "ok. "],
    )
    .await;
    assert!(!out.contains("sk-abcdefghijklmnopqrstuvwxyz0123"), "{out}");
    assert!(out.contains("Response blocked by policy"), "{out}");
}
