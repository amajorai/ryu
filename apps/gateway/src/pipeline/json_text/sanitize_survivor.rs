//! Fail-closed Sanitize for outbound text. `FirewallScanner::sanitize`
//! rewrites the raw text while detection reads the `normalize_for_scan` view,
//! so every outbound Sanitize here re-scans what it produced and either folds
//! and redacts again, masks, or reports the survivor for the caller to block.

use serde_json::Value;

use super::{json_string_projection, rewrite_object_keys};
use crate::firewall::{FirewallBackend, FirewallMatch};

/// Replaces a string whose redact-category match survives both Sanitize passes.
pub(in crate::pipeline) const SANITIZE_MASK: &str = "[REDACTED]";

/// The categories Sanitize is configured to redact (`redact_pii`,
/// `redact_secrets`): what a survivor re-scan reads, as in
/// [`sanitize_inbound_or_survivor`].
pub(in crate::pipeline) fn redact_categories(
    config: &crate::config::FirewallConfig,
) -> Vec<String> {
    let mut categories = Vec::with_capacity(2);
    if config.redact_pii {
        categories.push("pii".to_owned());
    }
    if config.redact_secrets {
        categories.push("secrets".to_owned());
    }
    categories
}

/// The first redact-category match on the normalized view of `text`.
fn redact_survivor(
    text: &str,
    scanner: &dyn FirewallBackend,
    categories: &[String],
) -> Option<FirewallMatch> {
    if categories.is_empty() {
        return None;
    }
    scanner.scan_locked_guardrails(text, categories)
}

/// Sanitize one string, failing closed. `sanitize` rewrites the raw text while
/// detection reads the `normalize_for_scan` view, so PII or a secret split by
/// a zero-width character or spelled in fullwidth / lookalike characters is
/// detected yet survives the raw pass. A survivor is folded with
/// `fold_for_redaction` and sanitized again; a match that still survives (or
/// one hidden with TAG characters) is returned instead of the text.
pub(in crate::pipeline) fn sanitize_text_or_survivor(
    text: &str,
    scanner: &dyn FirewallBackend,
) -> Result<String, FirewallMatch> {
    sanitize_text_with(text, scanner, &redact_categories(scanner.config()))
}

fn sanitize_text_with(
    text: &str,
    scanner: &dyn FirewallBackend,
    categories: &[String],
) -> Result<String, FirewallMatch> {
    let sanitized = scanner.sanitize(text);
    let Some(survivor) = redact_survivor(&sanitized, scanner, categories) else {
        return Ok(sanitized);
    };
    // The scan also reads TAG characters stripped, a view the in-place fold
    // cannot reproduce (`123-45<TAG>-6789` folds to `123-45Z-6789`), so a
    // TAG-bearing survivor is never refolded.
    if sanitized.chars().any(is_tag_char) {
        return Err(survivor);
    }
    let refolded = scanner.sanitize(&ryu_gw_firewall::fold_for_redaction(&sanitized));
    match redact_survivor(&refolded, scanner, categories) {
        Some(survivor) => Err(survivor),
        None => Ok(refolded),
    }
}

/// A Unicode TAG character (`U+E0000..=U+E007F`).
fn is_tag_char(c: char) -> bool {
    ('\u{E0000}'..='\u{E007F}').contains(&c)
}

/// The DLP's Sanitize rewrite of one string, failing closed: the order-free
/// [`sanitize_text`](super::super::stream_dlp::redact::sanitize_text) (PII,
/// secrets and the outbound scrub), refolded and rewritten again when a
/// redact-category match survives on the scan view, and [`SANITIZE_MASK`]
/// when one still survives. Every outbound Sanitize of response text uses it:
/// each JSON string here, and the stream DLP's text-level `Transform`, so a
/// value split across deltas is judged the same joined as one string.
pub(in crate::pipeline) fn sanitize_text_closed(
    scanner: &dyn FirewallBackend,
    text: &str,
) -> String {
    sanitize_closed_with(text, scanner, &redact_categories(scanner.config()))
}

fn sanitize_closed_with(
    text: &str,
    scanner: &dyn FirewallBackend,
    categories: &[String],
) -> String {
    let rewrite = |text: &str| super::super::stream_dlp::redact::sanitize_text(scanner, text);
    let sanitized = rewrite(text);
    if redact_survivor(&sanitized, scanner, categories).is_none() {
        return sanitized;
    }
    // A TAG-bearing survivor is never refolded (see `sanitize_text_with`).
    if sanitized.chars().any(is_tag_char) {
        return SANITIZE_MASK.to_owned();
    }
    // Only the surviving values change where the rewrite aligns with the
    // fold; otherwise the whole string is folded and rewritten again.
    let refolded = super::super::stream_dlp::redact::sanitize_folded(scanner, &sanitized)
        .unwrap_or_else(|| rewrite(&ryu_gw_firewall::fold_for_redaction(&sanitized)));
    if redact_survivor(&refolded, scanner, categories).is_some() {
        SANITIZE_MASK.to_owned()
    } else {
        refolded
    }
}

/// Whether Sanitize has anything left to do in `text`: the raw pass rewrites
/// it, or a redact-category match is on its normalized view.
pub(in crate::pipeline) fn sanitize_pending(text: &str, scanner: &dyn FirewallBackend) -> bool {
    scanner.sanitize(text) != text
        || redact_survivor(text, scanner, &redact_categories(scanner.config())).is_some()
}

/// After a Sanitize pass over a response, the first redact-category match
/// still on its scan view ([`json_string_projection`]): a match split across
/// two strings is visible only here. Callers block on `Some`.
pub(in crate::pipeline) fn outbound_sanitize_survivor(
    value: &Value,
    scanner: &dyn FirewallBackend,
) -> Option<FirewallMatch> {
    redact_survivor(
        &json_string_projection(value),
        scanner,
        &redact_categories(scanner.config()),
    )
}

/// [`outbound_sanitize_survivor`] for a sanitized SSE payload (an array of
/// frames): the per-frame scan view separates frames with their envelope
/// keys, so a match split across frames is read on each choice's delta text
/// (`choice_scan_texts`, which keeps a separator at a reasoning, answer or
/// tool-call switch, as detection does) and on each cross-frame lane as
/// well. The mask rewrites only the choice text, so a split in any other
/// field survives it.
pub(in crate::pipeline) fn sse_sanitize_survivor(
    payload: &Value,
    scanner: &dyn FirewallBackend,
) -> Option<FirewallMatch> {
    let categories = redact_categories(scanner.config());
    let frames = payload.as_array().map_or(&[][..], Vec::as_slice);
    let texts = super::choice_scan_texts(frames);
    let mut lanes = std::collections::BTreeMap::new();
    for frame in frames {
        super::collect_sse_payload_lanes(frame, "", &mut lanes);
    }
    redact_survivor(&json_string_projection(payload), scanner, &categories)
        .or_else(|| {
            texts
                .values()
                .find_map(|text| redact_survivor(text, scanner, &categories))
        })
        .or_else(|| {
            lanes
                .values()
                .find_map(|lane| redact_survivor(lane, scanner, &categories))
        })
}

/// Sanitize every string and key with [`sanitize_text_closed`]: a string
/// whose match survives both passes becomes [`SANITIZE_MASK`].
pub(in crate::pipeline) fn sanitize_json_strings(value: &mut Value, scanner: &dyn FirewallBackend) {
    sanitize_json_with(value, scanner, &redact_categories(scanner.config()));
}

fn sanitize_json_with(value: &mut Value, scanner: &dyn FirewallBackend, categories: &[String]) {
    let sanitize = |text: &str| sanitize_closed_with(text, scanner, categories);
    match value {
        Value::String(text) => *text = sanitize(text),
        Value::Array(values) => {
            for value in values {
                sanitize_json_with(value, scanner, categories);
            }
        }
        Value::Object(values) => {
            rewrite_object_keys(values, &sanitize);
            for value in values.values_mut() {
                sanitize_json_with(value, scanner, categories);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}
