//! Response-side redaction and the end-of-stream outbound audit (#455).

use axum::body::{Body, Bytes};
use tracing::warn;

use super::{
    audit_rows::{emit_audit, provider_label},
    WireFormat,
};
use crate::{firewall::FirewallBackend, state::SharedState};
use ryu_gw_passthrough::redact_sse_stream;

const MAX_REDACT_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// State of the response redaction. The whole response is held to give the
/// DLP pass one contiguous assistant-text stream; a bounded cap prevents this
/// security fix from becoming an unbounded buffering DoS.
struct ResponseRedactState {
    inner: axum::body::BodyDataStream,
    state: SharedState,
    /// The request's resolved scanner, so response redaction applies the same
    /// overlays as the request side.
    scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
    format: WireFormat,
    /// Raw response bytes held until the single contiguous DLP pass. Holding a
    /// bounded response is deliberate: per-delta redaction can miss a secret
    /// split across two SSE events, while an unbounded hold would be a DoS.
    raw: Vec<u8>,
    /// Set once the redacted body and audit row have been produced at stream
    /// end, or once the buffer cap was hit.
    flushed: bool,
    /// Forwarded end-user id (`x-ryu-user-id`) for the end-of-stream audit row.
    user_id: Option<String>,
    /// Forwarded agent id (`x-ryu-agent-id`) for the end-of-stream audit row.
    agent_id: Option<String>,
    /// Forwarded product surface (`x-ryu-feature`) for the end-of-stream audit row.
    feature: Option<String>,
}

/// Hold the upstream response (at most [`MAX_REDACT_RESPONSE_BYTES`]) and send
/// it to the client after one contiguous DLP pass, so credentials split across
/// SSE text-delta events are caught before any response byte leaves the
/// Gateway. Past the cap, or on an upstream read error, the body fails and
/// nothing is sent.
///
/// A body containing `data:` anywhere is treated as SSE ([`redact_sse_stream`]:
/// joined assistant text through `sanitize` then `redact_outbound`, the rest
/// of the body through `redact_outbound`). Any other body gets `redact_outbound`
/// only, with no `sanitize`. A non-SSE body that merely contains `data:` is
/// scrubbed the same way, but its audit sees no assistant text and is skipped.
pub(super) fn redact_response_passthrough(
    body: Body,
    format: WireFormat,
    state: SharedState,
    scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
) -> Body {
    use futures_util::StreamExt;

    let init = ResponseRedactState {
        inner: body.into_data_stream(),
        state,
        scanner,
        format,
        raw: Vec::new(),
        flushed: false,
        user_id,
        agent_id,
        feature,
    };

    let transformed = futures_util::stream::unfold(init, |mut s| async move {
        loop {
            if s.flushed {
                return None;
            }
            match s.inner.next().await {
                Some(Ok(bytes)) => {
                    if s.raw.len().saturating_add(bytes.len()) > MAX_REDACT_RESPONSE_BYTES {
                        s.flushed = true;
                        return Some((
                            Err(std::io::Error::other(
                                "passthrough response exceeded the DLP buffer cap",
                            )),
                            s,
                        ));
                    }
                    s.raw.extend_from_slice(&bytes);
                    continue;
                }
                Some(Err(e)) => {
                    return Some((Err(std::io::Error::other(e.to_string())), s));
                }
                None => {
                    if s.flushed {
                        return None;
                    }
                    s.flushed = true;
                    let raw = String::from_utf8_lossy(&s.raw).to_string();
                    let scanner = s.scanner.as_ref();
                    let (redacted, audit_text) = if raw.contains("data:") {
                        redact_sse_stream(s.format, scanner, &raw)
                    } else {
                        let (redacted, _) = FirewallBackend::redact_outbound(scanner, &raw);
                        (redacted.clone(), redacted)
                    };
                    audit_outbound(
                        &s.state,
                        scanner,
                        s.format,
                        &audit_text,
                        s.user_id.clone(),
                        s.agent_id.clone(),
                        s.feature.clone(),
                    );
                    if redacted.is_empty() {
                        return None;
                    }
                    return Some((Ok(Bytes::from(redacted.into_bytes())), s));
                }
            }
        }
    });

    Body::from_stream(transformed)
}

/// Run the single end-of-stream outbound audit over the redacted text: the
/// joined assistant text of an SSE body (tool-call and thinking deltas are not
/// audited), or the whole of any other body. `scan_outbound` returns nothing
/// unless the scanner's `scan_outbound` is on. A hit means a PII or secret
/// match survived the redaction pass: a category `sanitize` skipped
/// (`redact_pii`/`redact_secrets` off; a non-SSE body is never sanitized), or
/// a match only the scan's normalized text exposes. It writes an audit row and
/// blocks nothing.
fn audit_outbound(
    state: &SharedState,
    scanner: &crate::firewall::FirewallScanner,
    format: WireFormat,
    text: &str,
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
) {
    if text.is_empty() {
        return;
    }
    if let Some(violation) = scanner.scan_outbound(text) {
        warn!(
            provider = provider_label(format),
            pattern = %violation.pattern_name,
            "passthrough: residual outbound firewall violation after streaming redaction"
        );
        emit_audit(
            state,
            format,
            "unknown",
            0,
            Some(format!(
                "outbound firewall violation: {}",
                violation.pattern_name
            )),
            user_id,
            agent_id,
            feature,
        );
    }
}
