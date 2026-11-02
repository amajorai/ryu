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
/// keys, so a match split across frames is read on the concatenated delta
/// text and on each cross-frame lane as well. The mask rewrites only the
/// choice text, so a split in any other field survives it.
pub(in crate::pipeline) fn sse_sanitize_survivor(
    payload: &Value,
    scanner: &dyn FirewallBackend,
) -> Option<FirewallMatch> {
    let categories = redact_categories(scanner.config());
    let mut text = String::new();
    super::collect_sse_payload_text(payload, &mut text);
    let mut lanes = std::collections::BTreeMap::new();
    for frame in payload.as_array().into_iter().flatten() {
        super::collect_sse_payload_lanes(frame, "", &mut lanes);
    }
    redact_survivor(&json_string_projection(payload), scanner, &categories)
        .or_else(|| redact_survivor(&text, scanner, &categories))
        .or_else(|| {
            lanes
                .values()
                .find_map(|lane| redact_survivor(lane, scanner, &categories))
        })
}

/// Sanitize every string and key, failing closed: a string whose match
/// survives [`sanitize_text_or_survivor`] becomes [`SANITIZE_MASK`].
pub(in crate::pipeline) fn sanitize_json_strings(value: &mut Value, scanner: &dyn FirewallBackend) {
    sanitize_json_with(value, scanner, &redact_categories(scanner.config()));
}

fn sanitize_json_with(value: &mut Value, scanner: &dyn FirewallBackend, categories: &[String]) {
    let sanitize = |text: &str| {
        let sanitized = sanitize_text_with(text, scanner, categories)
            .unwrap_or_else(|_| SANITIZE_MASK.to_owned());
        scanner.redact_outbound(&sanitized).0
    };
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
