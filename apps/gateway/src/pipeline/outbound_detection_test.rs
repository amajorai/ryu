//! An outbound firewall decision logs one request-scoped line per response:
//! let-through matches (Sanitize, WarnAndContinue) at `warn` when
//! `[firewall] log_detections` is on and at `debug` when it is off; blocks
//! always at `warn`. The scanner's own per-hit line is `debug` only, so no
//! extra `warn` line repeats a decision without its request ID.

use super::log_capture::LogBuffer;
use super::*;
use crate::config::{CustomPattern, CustomPatternKind, FirewallConfig};
use std::sync::atomic::Ordering;

const SANITIZED_STREAM: &str = "firewall: sanitized outbound response (streaming)";
const WARNED_STREAM: &str = "firewall: outbound violation (warn-and-continue, streaming)";
const SANITIZED: &str = "firewall: sanitized outbound response";
const WARNED: &str = "firewall: outbound violation (warn-and-continue)";
const BLOCKED: &str = "firewall: blocked outbound response";
const SCANNER_LINE: &str = "detected in outbound response";
pub(super) const REQUEST_ID: &str = "outbound-log-test";

/// A state whose node-base firewall uses `policy` and `log_detections`, plus
/// `custom` outbound patterns, and a plain request context for it.
pub(super) fn state_with(
    policy: FirewallPolicy,
    log_detections: bool,
    custom: Vec<CustomPattern>,
) -> (Arc<AppState>, RequestContext) {
    let mut config = crate::GatewayConfig::default();
    config.firewall = FirewallConfig {
        policy,
        log_detections,
        custom_patterns: custom,
        ..FirewallConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let state = Arc::new(AppState::new_for_test(config, audit, evals));
    let mut ctx = test_support::plain_request_context();
    ctx.request_id = REQUEST_ID.into();
    (state, ctx)
}

/// An SSE body delivering each part as its own content frame and chunk, so
/// stream DLP sees one push per frame.
pub(super) fn sse(parts: &[&str]) -> Body {
    let mut chunks: Vec<Result<String, std::io::Error>> = parts
        .iter()
        .map(|part| {
            let frame = json!({ "choices": [{ "index": 0, "delta": { "content": part } }] });
            Ok(format!("data: {frame}\n\n"))
        })
        .collect();
    chunks.push(Ok("data: [DONE]\n\n".to_owned()));
    Body::from_stream(futures_util::stream::iter(chunks))
}

/// Run a stream through outbound DLP under a captured subscriber, draining
/// the body inside the capture, and return the delivered text.
pub(super) async fn stream_through(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Body,
    buffer: &LogBuffer,
) -> String {
    let _guard = buffer.capture();
    let (body, _permit) = apply_outbound_firewall_stream(
        body,
        state,
        ctx,
        crate::concurrency::AdmissionPermit::none(),
    )
    .await;
    let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

/// The single policy line, at the level `log_detections` chooses, carrying
/// the request ID and the pattern; no other `warn` line.
fn assert_one_line(buffer: &LogBuffer, message: &str, log_detections: bool) {
    let captured = buffer.text();
    let lines: Vec<String> = buffer
        .lines_with(message)
        .into_iter()
        .filter(|line| line.ends_with(message) || line.contains(&format!("{message} ")))
        .collect();
    assert_eq!(lines.len(), 1, "{captured}");
    let line = &lines[0];
    assert!(line.contains(&format!("request_id={REQUEST_ID}")), "{line}");
    assert!(line.contains("pattern="), "{line}");
    let level = if log_detections { "WARN" } else { "DEBUG" };
    assert!(line.trim_start().starts_with(level), "{line}");
    let warns = buffer.warn_lines();
    let expected = usize::from(log_detections);
    assert_eq!(warns.len(), expected, "{captured}");
    assert!(
        warns.iter().all(|line| !line.contains(SCANNER_LINE)),
        "{captured}"
    );
}

#[tokio::test]
async fn an_incremental_stream_logs_one_line_per_response() {
    for (policy, message) in [
        (FirewallPolicy::Sanitize, SANITIZED_STREAM),
        (FirewallPolicy::WarnAndContinue, WARNED_STREAM),
    ] {
        for log_detections in [true, false] {
            let (state, ctx) = state_with(policy.clone(), log_detections, Vec::new());
            let buffer = LogBuffer::default();
            let body = sse(&[
                "Mail john@example.com ",
                "then ",
                "jane@example.org ",
                "and more words ",
            ]);
            stream_through(state, ctx, body, &buffer).await;
            assert_one_line(&buffer, message, log_detections);
        }
    }
}

#[tokio::test]
async fn a_buffered_stream_logs_one_line_per_response() {
    let custom = || {
        vec![CustomPattern {
            name: "ticket_id".into(),
            regex: r"TCK-\d{6}".into(),
            kind: CustomPatternKind::Pii,
        }]
    };
    for (policy, message) in [
        (FirewallPolicy::Sanitize, SANITIZED_STREAM),
        (FirewallPolicy::WarnAndContinue, WARNED_STREAM),
    ] {
        for log_detections in [true, false] {
            let (state, ctx) = state_with(policy.clone(), log_detections, custom());
            assert!(outbound_custom_patterns(&state.resolved_scanner(&ctx)));
            let buffer = LogBuffer::default();
            let body = sse(&["Ticket TCK-123456 ", "and TCK-654321 ", "done "]);
            stream_through(state, ctx, body, &buffer).await;
            assert_one_line(&buffer, message, log_detections);
        }
    }
}

fn response_with_two_values() -> Value {
    json!({
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Mail john@example.com or jane@example.org"
            }
        }]
    })
}

#[test]
fn a_non_stream_let_through_logs_one_line_at_the_configured_level() {
    for (policy, message) in [
        (FirewallPolicy::Sanitize, SANITIZED),
        (FirewallPolicy::WarnAndContinue, WARNED),
    ] {
        for log_detections in [true, false] {
            let (state, ctx) = state_with(policy.clone(), log_detections, Vec::new());
            let buffer = LogBuffer::default();
            let mut response = response_with_two_values();
            {
                let _guard = buffer.capture();
                assert!(!apply_outbound_json_dlp(&state, &ctx, &mut response).unwrap());
            }
            assert_one_line(&buffer, message, log_detections);
            assert_eq!(state.metrics.firewall_blocked.load(Ordering::SeqCst), 0);
        }
    }
}

#[test]
fn a_non_stream_block_always_logs_at_warn() {
    for log_detections in [true, false] {
        let (state, ctx) = state_with(FirewallPolicy::Block, log_detections, Vec::new());
        let buffer = LogBuffer::default();
        let mut response = response_with_two_values();
        {
            let _guard = buffer.capture();
            assert!(matches!(
                apply_outbound_json_dlp(&state, &ctx, &mut response),
                Err(GatewayError::FirewallBlocked(..))
            ));
        }
        let captured = buffer.text();
        let warns = buffer.warn_lines();
        assert_eq!(warns.len(), 1, "{captured}");
        assert!(warns[0].contains(BLOCKED), "{captured}");
        assert!(
            warns[0].contains(&format!("request_id={REQUEST_ID}")),
            "{captured}"
        );
        assert_eq!(state.metrics.firewall_blocked.load(Ordering::SeqCst), 1);
    }
}

const SURVIVED: &str = "firewall: outbound match survived Sanitize; blocked";

/// A Sanitize response whose match survives redaction is a block: it logs the
/// block line alone, never a "sanitized" line before it.
fn assert_only_the_block_line(buffer: &LogBuffer) {
    let captured = buffer.text();
    assert!(buffer.lines_with(SANITIZED).is_empty(), "{captured}");
    let warns = buffer.warn_lines();
    assert_eq!(warns.len(), 1, "{captured}");
    assert!(warns[0].contains(SURVIVED), "{captured}");
    assert!(
        warns[0].contains(&format!("request_id={REQUEST_ID}")),
        "{captured}"
    );
}

#[test]
fn a_non_stream_sanitize_survivor_logs_only_the_block_line() {
    for log_detections in [true, false] {
        let (state, ctx) = state_with(FirewallPolicy::Sanitize, log_detections, Vec::new());
        let buffer = LogBuffer::default();
        let mut response = response_with_two_values();
        // Two strings that join an SSN only on the response's scan view.
        response["extra"] = json!(["ssn 123-45", "6789"]);
        {
            let _guard = buffer.capture();
            assert!(matches!(
                apply_outbound_json_dlp(&state, &ctx, &mut response),
                Err(GatewayError::FirewallBlocked(..))
            ));
        }
        assert_only_the_block_line(&buffer);
        assert_eq!(state.metrics.firewall_blocked.load(Ordering::SeqCst), 1);
    }
}

/// The incremental stream decides per step, so a match let through early can
/// still end blocked: its "sanitized" line waits for the stream to end
/// unblocked. A natural Sanitize survivor is masked before it can block here,
/// so an unscannable frame stands in for the later block; a survivor's block
/// clears the pending line the same way.
#[tokio::test]
async fn a_stream_blocked_after_a_let_through_logs_only_the_block_line() {
    for log_detections in [true, false] {
        let (state, ctx) = state_with(FirewallPolicy::Sanitize, log_detections, Vec::new());
        let buffer = LogBuffer::default();
        let first = json!({ "choices": [{ "index": 0, "delta": {
            "content": "Mail john@example.com " } }] });
        let chunks = [format!("data: {first}\n\n"), "event: ping\n\n".to_owned()];
        let body = Body::from_stream(futures_util::stream::iter(
            chunks.into_iter().map(Ok::<_, std::io::Error>),
        ));
        let out = stream_through(state.clone(), ctx, body, &buffer).await;
        assert!(out.contains("[REDACTED:EMAIL]"), "{out}");
        assert!(out.contains("could not be scanned"), "{out}");
        let captured = buffer.text();
        assert!(buffer.lines_with(SANITIZED).is_empty(), "{captured}");
        let warns = buffer.warn_lines();
        assert_eq!(warns.len(), 1, "{captured}");
        assert!(
            warns[0].contains("unscannable response stream"),
            "{captured}"
        );
        assert_eq!(state.metrics.firewall_blocked.load(Ordering::SeqCst), 1);
    }
}
