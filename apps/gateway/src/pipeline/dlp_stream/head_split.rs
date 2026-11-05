//! A buffered payload of one choice whose leading content deltas are
//! followed by other frames (a tool call): the head goes out at text level
//! and only the rest takes the per-string path, as the stream releases a
//! held-whole stream's head at its end (`StreamingDlp::final_head`).

use super::per_string::{redact_strings, Lanes};
use super::*;
use crate::pipeline::stream_dlp::redact::{rewrite_prepared, text_level_frame, Transform};

/// Rewrite `payload` with its leading text-level frames redacted at text
/// level and the rest string by string, masking only the rest when its
/// per-string result is not the transform of its text. `false` leaves
/// `payload` untouched for the whole per-string path: no head, no rest, a
/// second choice, token mirrors anywhere (judged over the whole payload, as
/// the stream judges them over its batch), a lane carrying a value across
/// the head/rest boundary, or a head that does not split or check exactly.
pub(super) fn redact_head_then_rest(
    payload: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
    sanitize: bool,
    provider: &[Value],
) -> bool {
    let Some(frames) = payload.as_array() else {
        return false;
    };
    let head = frames
        .iter()
        .take_while(|frame| text_level_frame(frame))
        .count();
    if head == 0 || head == frames.len() || frames.iter().any(has_token_mirrors) {
        return false;
    }
    // Another choice's frames keep the whole per-string path: its output then
    // does not depend on how the choices interleave (`round89_test`).
    if choice_scan_texts(frames).len() > 1 {
        return false;
    }
    let mut transform = Transform::new(scanner, sanitize);
    // Prepared once over the whole payload: a split envelope value is
    // masked in every frame, the head's as the rest's.
    let mut prepared = frames.clone();
    super::super::stream_dlp::envelope::prepare_buffered(&mut prepared, &transform, provider);
    if !splits_cleanly(&prepared, head, &transform) {
        return false;
    }
    let Some(mut rewritten) =
        rewrite_prepared(&frames[..head], prepared[..head].to_vec(), &mut transform)
    else {
        return false;
    };
    // The head on its own, every lane (envelope strings included): it is
    // never masked below, so it must pass the per-string check by itself.
    if Lanes::of(&prepared[..head]).differs(&Lanes::of(&rewritten), &transform) {
        return false;
    }
    let mut rest = Value::Array(prepared[head..].to_vec());
    redact_strings(&mut rest, scanner, sanitize);
    let Value::Array(rest) = rest else {
        return false;
    };
    let rest_start = rewritten.len();
    rewritten.extend(rest);
    // The head splits cleanly from the rest in every lane and passes on its
    // own, so a mismatch here is the rest's: mask only the rest, as the
    // stream masks only its tail.
    if Lanes::of(&prepared).differs(&Lanes::of(&rewritten), &transform) {
        for frame in &mut rewritten[rest_start..] {
            mask_sse_payload_text(frame);
        }
    }
    *payload = Value::Array(rewritten);
    true
}

/// Whether the first `head` frames redact the same on their own as joined
/// with the rest: in the primary scan text (which runs from the head's
/// content on into the rest's text, separated where the rest starts in
/// another lane, `TextLane`) and in every string lane both
/// carry (`StreamingDlp::splits_cleanly`).
fn splits_cleanly(prepared: &[Value], head: usize, transform: &Transform<'_>) -> bool {
    let apart = |head: &str, rest: &str| {
        let mut apart = transform.apply(head);
        apart.push_str(&transform.apply(rest));
        transform.apply(&format!("{head}{rest}")) == apart
    };
    let primary = |frames: &[Value]| choice_scan_texts(frames).remove("0").unwrap_or_default();
    let whole = primary(prepared);
    let head_text = primary(&prepared[..head]);
    let Some(rest_text) = whole.strip_prefix(head_text.as_str()) else {
        return false;
    };
    if !apart(&head_text, rest_text) {
        return false;
    }
    let lanes = |frames: &[Value]| {
        let mut lanes = std::collections::BTreeMap::new();
        for frame in frames {
            collect_sse_payload_lanes(frame, "", &mut lanes);
        }
        lanes
    };
    let head_lanes = lanes(&prepared[..head]);
    lanes(&prepared[head..]).iter().all(|(path, rest)| {
        head_lanes
            .get(path)
            .is_none_or(|head: &String| apart(head, rest))
    })
}
