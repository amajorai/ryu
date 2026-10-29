use super::*;

/// Wrap + template-token-strip a tool RESULT before it re-enters the ACP model,
/// unless the flag is off or the result comes from an internal discovery
/// meta-tool. External/registry/Composio results are untrusted (poisoned
/// web/tool output can impersonate the transcript), so they are boundary-wrapped
/// and stripped. The meta-tools (`tool_search`/`describe`) emit Ryu-generated
/// JSON envelopes the desktop and the next round parse, so they are EXCLUDED —
/// wrapping would corrupt that discovery contract. Default-ON (opt-out via
/// [`untrusted::set_enabled`]).
///
/// **This is the ACP plane's model edge, and it is the only place the ACP tool
/// result is neutralized.** The widget channel ([`widget_payload`]) deliberately
/// does NOT neutralize — see that function's doc comment for the full trace. Keep
/// the boundary here; do not push it back onto widget delivery. `pub(crate)` so
/// the OpenAI-compat tool loop (`adapters/mod.rs`) folds through the SAME edge
/// instead of growing a divergent copy.
///
/// External results are also size-bounded here ([`bound_tool_result`]), for the
/// same reason: this is the one edge every model-bound result crosses. The
/// meta-tool envelopes are exempt from that too, since cutting JSON would break
/// the parse.
pub(crate) fn neutralize_external_result(tool_id: &str, text: String) -> String {
    let is_external = !matches!(tool_id, "tool_search" | "describe");
    if !is_external {
        return text;
    }
    let text = elide_inline_images(text);
    let text = bound_tool_result(text, MAX_TOOL_RESULT_CHARS);
    if untrusted::is_enabled() {
        untrusted::neutralize(&text)
    } else {
        text
    }
}

/// Base64 payloads shorter than this are left alone (icons, tiny thumbnails).
pub(super) const MIN_ELIDED_IMAGE_CHARS: usize = 1_024;

/// Replace inline base64 image payloads in a JSON tool result with a short
/// placeholder.
///
/// This edge carries text only, so an image result (a browser screenshot's
/// `{image, encoding: "base64", mime: "image/png"}`, or the `screenshot` inside a
/// page-context bundle) reached the model as hundreds of KB of base64 characters,
/// which [`bound_tool_result`] then sliced in the middle: tens of thousands of
/// tokens the model cannot decode, replayed on every later turn. Recognised by
/// shape, so any tool returning the same envelope benefits. Non-JSON text and
/// JSON without such a payload pass through untouched.
pub(super) fn elide_inline_images(text: String) -> String {
    if text.len() < MIN_ELIDED_IMAGE_CHARS || !text.trim_start().starts_with('{') {
        return text;
    }
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        return text;
    };
    if !elide_images_in(&mut value) {
        return text;
    }
    serde_json::to_string(&value).unwrap_or(text)
}

/// Recursively elide `{image|data, encoding: "base64", mime: "image/*"}` objects.
/// Returns whether anything was replaced.
pub(super) fn elide_images_in(value: &mut Value) -> bool {
    match value {
        Value::Object(map) => {
            // Ryu's `{image, encoding: "base64", mime}` envelope, or an MCP
            // `{type: "image", data, mimeType}` content block passed through whole.
            let ryu_mime = (map.get("encoding").and_then(Value::as_str) == Some("base64"))
                .then(|| map.get("mime").and_then(Value::as_str))
                .flatten();
            let mcp_mime = (map.get("type").and_then(Value::as_str) == Some("image"))
                .then(|| map.get("mimeType").and_then(Value::as_str))
                .flatten();
            let image_mime = ryu_mime
                .or(mcp_mime)
                .filter(|mime| mime.starts_with("image/"))
                .map(str::to_owned);
            let mut changed = false;
            if let Some(mime) = image_mime {
                for key in ["image", "data"] {
                    let Some(payload) = map.get(key).and_then(Value::as_str) else {
                        continue;
                    };
                    if payload.len() < MIN_ELIDED_IMAGE_CHARS {
                        continue;
                    }
                    let bytes = payload.len() / 4 * 3;
                    map.insert(
                        key.to_owned(),
                        Value::String(format!(
                            "[{mime} image, ~{} KB, omitted: base64 is not readable as text. \
                             Use an accessibility snapshot or page text to inspect content]",
                            bytes / 1024
                        )),
                    );
                    changed = true;
                }
            }
            for child in map.values_mut() {
                changed |= elide_images_in(child);
            }
            changed
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| elide_images_in(item) | changed),
        _ => false,
    }
}

/// Most characters of one tool result that reach the model. Below this nothing
/// changes; above it the result is cut by [`bound_tool_result`]. About 28k tokens,
/// so it only bites on pathological outputs (a multi-megabyte HTTP body or command
/// stdout), which would otherwise be re-sent on every later turn of the session.
pub(super) const MAX_TOOL_RESULT_CHARS: usize = 100_000;

/// Cap a model-facing tool result at `limit` characters, keeping its head and its
/// tail around a marker that says how much was left out.
///
/// Head and tail rather than a plain prefix because long outputs put what matters
/// at both ends: a command's error and exit summary print last, a listing's
/// header prints first. Every tool result is replayed on each later turn, so one
/// oversized result is paid for many times over.
pub(super) fn bound_tool_result(text: String, limit: usize) -> String {
    let total = text.chars().count();
    if total <= limit {
        return text;
    }
    let head_chars = limit / 2;
    let tail_chars = limit - head_chars;
    let head_end = text
        .char_indices()
        .nth(head_chars)
        .map_or(text.len(), |(index, _)| index);
    let tail_start = text
        .char_indices()
        .nth(total - tail_chars)
        .map_or(text.len(), |(index, _)| index);
    let omitted = total - head_chars - tail_chars;
    format!(
        "{}\n...[{omitted} characters omitted from the middle of this tool result; \
         narrow the request to see them]...\n{}",
        &text[..head_end],
        &text[tail_start..]
    )
}
