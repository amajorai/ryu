//! The buffered path's per-string redaction and its fail-closed mask.

use std::collections::BTreeMap;

use super::*;

/// What the per-string check compares: each choice's scan text
/// (`choice_scan_texts`) and every string lane, token mirrors included.
pub(super) struct Lanes {
    texts: BTreeMap<String, String>,
    lanes: BTreeMap<String, String>,
}

impl Lanes {
    pub(super) fn of(frames: &[Value]) -> Self {
        let texts = choice_scan_texts(frames);
        let mut lanes = BTreeMap::new();
        for frame in frames {
            collect_sse_payload_lanes(frame, "", &mut lanes);
            token_sequences(frame, &mut lanes);
        }
        Self { texts, lanes }
    }

    /// Whether `remaining` is not, lane by lane, the transform of `self`.
    pub(super) fn differs(
        &self,
        remaining: &Self,
        transform: &super::super::stream_dlp::redact::Transform<'_>,
    ) -> bool {
        // A choice lane gained or lost (a rewritten `index`) fails closed too.
        let choice_differs = self.texts.len() != remaining.texts.len()
            || self
                .texts
                .iter()
                .any(|(lane, text)| remaining.texts.get(lane) != Some(&transform.apply(text)));
        choice_differs
            || self.lanes.iter().any(|(path, text)| {
                // Token mirrors are compared as a sequence, never by position
                // (`token_mirror_lane`); a dropped sequence has nothing to compare.
                let dropped = !path.starts_with('/') && !remaining.lanes.contains_key(path);
                !token_mirror_lane(path)
                    && !dropped
                    && remaining.lanes.get(path) != Some(&transform.apply(text))
            })
    }
}

/// Redact (and, under `sanitize`, sanitize) every string of `payload` on
/// its own. On the raw strings: sanitizing redacted text would let a secret
/// rule's placeholder split a PII value (`sanitize_text`).
pub(super) fn redact_strings(
    payload: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
    sanitize: bool,
) {
    if sanitize {
        sanitize_json_strings(payload, scanner);
        drop_choice_logprobs(payload);
    } else {
        redact_with_mirrors(payload, scanner);
    }
}

/// The per-string path: redact (and, after a Sanitize violation, sanitize)
/// every string on its own, masking the payload unless the result equals the
/// transform of the joined text in every lane, each choice's text included. "Nothing still matches" is not
/// enough: removing a value's head on its own can leave a tail that no longer
/// matches.
pub(super) fn redact_per_string(
    payload: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
    sanitize: bool,
    provider: &[Value],
) {
    let transform = super::super::stream_dlp::redact::Transform::new(scanner, sanitize);
    if let Some(frames) = payload.as_array_mut() {
        super::super::stream_dlp::envelope::prepare_buffered(frames, &transform, provider);
    }
    let lanes_of = |payload: &Value| Lanes::of(payload.as_array().map_or(&[], Vec::as_slice));
    let raw = lanes_of(payload);
    redact_strings(payload, scanner, sanitize);
    if raw.differs(&lanes_of(payload), &transform) {
        mask_sse_payload_text(payload);
    }
}
