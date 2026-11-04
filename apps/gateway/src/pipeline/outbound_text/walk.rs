//! Zones and the walks over a request body (see the parent module docs).

use super::*;

/// The entries of `entries` in sorted key order. serde_json's map order is a
/// Cargo feature: with `preserve_order` (which any crate in the same build
/// can switch on through feature unification) a map iterates in the order the
/// request listed its keys. Every walk sorts explicitly so extraction is the
/// same in every build and no request can choose the order it is screened in.
pub(super) fn sorted_entries(entries: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut sorted: Vec<_> = entries.iter().collect();
    sorted.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
    sorted
}

/// Visit the raw string leaves of `value` that the chat walk screens, where
/// `value` sits below a non-root content key such as `messages`: every
/// non-empty string except the encoded media the walk skips in its zone (see
/// [`is_encoded`]). A URL under a media key is not visited, since no inbound
/// screen read it.
pub(crate) fn visit_screened_leaves(value: &Value, visit: &mut dyn FnMut(&str)) {
    visit_screened(value, Zone::Content, visit);
}

pub(super) fn visit_screened(value: &Value, zone: Zone, visit: &mut dyn FnMut(&str)) {
    match value {
        Value::String(text) => {
            if !text.is_empty() && !is_encoded(text, zone, true) {
                visit(text);
            }
        }
        Value::Array(values) => {
            for value in values {
                visit_screened(value, zone, visit);
            }
        }
        Value::Object(entries) => {
            for (key, value) in sorted_entries(entries) {
                visit_screened(value, child_zone(key, value, zone, false, false), visit);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Whether the inbound firewall (under its `enabled` / `scan_inbound` gate) or
/// one of `guardrails` matches anything in `residual`. Nothing is counted,
/// alerted or refused. An over-limit residual reports no match, so a caller
/// that discounts matches still screens it and refuses it as too large.
pub(crate) fn residual_has_match(
    scanner: &dyn FirewallBackend,
    guardrails: &[String],
    residual: &Residual,
) -> bool {
    let Ok(parts) = residual.parts() else {
        return false;
    };
    let config = scanner.config();
    let texts = [parts.uncovered, parts.decoded, parts.secrets_only];
    let inbound = config.enabled
        && config.scan_inbound
        && texts
            .iter()
            .any(|text| !text.is_empty() && scanner.scan_inbound(text).is_some());
    inbound
        || (!guardrails.is_empty()
            && texts.iter().any(|text| {
                !text.is_empty() && scanner.scan_locked_guardrails(text, guardrails).is_some()
            }))
}

/// The residual of a chat-shaped body: everything except the conversation
/// leaves (`visit_conversation_strings`) and the function definition leaves
/// the definition pass reads (`visit_definition_strings`).
pub(crate) fn chat_residual_text(body: &Value) -> Residual {
    residual_text(body, |visit| {
        super::super::visit_conversation_strings(body, visit);
        super::super::visit_definition_strings(body, visit);
    })
}

/// Whether `text` is encoded media the walk skips in `zone`: a base64 `data:`
/// URI anywhere, and under a media key also a URL or a long whitespace-free
/// run of the (standard or URL-safe) base64 alphabet. A `data:` URI that is
/// not base64 is plain text and is screened.
///
/// `media_urls` is false for tool-loop content, where a URL under a media key
/// is screened like any other string.
pub(super) fn is_encoded(text: &str, zone: Zone, media_urls: bool) -> bool {
    if let Some(uri) = text.strip_prefix("data:") {
        return uri
            .split_once(',')
            .is_some_and(|(header, payload)| header.ends_with(";base64") && is_base64(payload));
    }
    zone == Zone::Media
        && ((media_urls && is_url(text)) || (text.len() >= BLOB_MIN_LEN && is_base64(text)))
}

pub(super) fn is_base64(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'-' | b'_'))
}

/// A whitespace-free `<scheme>://...` string.
pub(super) fn is_url(text: &str) -> bool {
    !text.chars().any(char::is_whitespace)
        && text.split_once("://").is_some_and(|(scheme, _)| {
            scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
        })
}

/// A URL or encoded-media field: [`MEDIA_KEYS`], or a key naming a modality
/// ([`MEDIA_KEY_PARTS`]). Other URL keys (`webhook_url`, `callback_url`) are
/// not media and are screened.
pub(super) fn is_media_key(key: &str) -> bool {
    MEDIA_KEYS.contains(&key) || MEDIA_KEY_PARTS.iter().any(|part| key.contains(part))
}

/// Whether the subtree under `key` is a media zone (see [`is_media_key`]), for
/// the leaf scan of a non-chat request.
pub(in crate::pipeline) fn is_media_zone_key(key: &str) -> bool {
    is_media_key(key)
}

/// Whether a string leaf inside a media zone is encoded bytes, not text the
/// provider reads: a long whitespace-free run of the base64 alphabet. Regexes
/// find nothing meaningful in it and random base64 trips the secret patterns.
/// A URL is not skipped here: the leaf scan reads it up to its signed query.
pub(in crate::pipeline) fn is_media_zone_blob(text: &str) -> bool {
    text.len() >= BLOB_MIN_LEN && is_base64(text)
}

/// The zone of the value under `key`. Secrets-only and media zones hold for
/// the whole subtree.
pub(super) fn child_zone(
    key: &str,
    value: &Value,
    zone: Zone,
    root: bool,
    action_arguments: bool,
) -> Zone {
    if zone != Zone::Content || action_arguments {
        return zone;
    }
    if root && DEFINITION_KEYS.contains(&key) {
        return Zone::SecretsOnly;
    }
    if root && CONTROL_KEYS.contains(&key) {
        let token = value
            .as_str()
            .is_some_and(|text| !text.chars().any(char::is_whitespace));
        if token {
            return Zone::SecretsOnly;
        }
    }
    if is_media_key(key) {
        return Zone::Media;
    }
    Zone::Content
}

/// Walk the wire body: skip encoded media and covered raw leaves, and route
/// every other leaf to the part its zone names. When `keys` holds, every
/// object key below is screened like a value in the zone of the object that
/// holds it.
pub(super) fn walk_wire(
    value: &Value,
    zone: Zone,
    root: bool,
    keys: bool,
    owned: &HashSet<usize>,
    out: &mut Residual,
) {
    if out.over_limit {
        return;
    }
    match value {
        Value::String(text) => {
            if text.is_empty() || (!out.action_arguments && is_encoded(text, zone, !out.tool_loop))
            {
                return;
            }
            let covered = owned.contains(&(text.as_ptr() as usize));
            let part = match zone {
                Zone::SecretsOnly => Part::SecretsOnly,
                Zone::Content | Zone::Media if covered => Part::Decoded,
                Zone::Content | Zone::Media => Part::Uncovered,
            };
            if !covered {
                out.push(part, text);
            }
            push_decoded(text, part, 0, out);
        }
        Value::Array(values) => {
            for value in values {
                walk_wire(value, zone, false, keys, owned, out);
            }
        }
        Value::Object(entries) => {
            for (key, value) in sorted_entries(entries) {
                if keys {
                    let part = match zone {
                        Zone::SecretsOnly => Part::SecretsOnly,
                        Zone::Content | Zone::Media => Part::Uncovered,
                    };
                    out.push(part, key);
                    push_decoded(key, part, 0, out);
                }
                let child_keys = keys || (root && KEYED_KEYS.contains(&key.as_str()));
                let zone = child_zone(key, value, zone, root, out.action_arguments);
                walk_wire(value, zone, false, child_keys, owned, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}
