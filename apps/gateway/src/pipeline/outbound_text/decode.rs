//! Decoded forms of a screened string: embedded JSON, JSON and percent escapes, base64 text.

use super::*;

/// Push the decoded forms of `text` into `part`. A string that looks like
/// JSON is parsed and every string inside it is pushed, under any key (an
/// escaped payload can sit under any key name). One that does not parse
/// (truncated or otherwise invalid arguments) is unescaped textually; any
/// other string has only its `\uXXXX` escapes decoded. A plain-text `data:`
/// URI also has its percent escapes decoded.
pub(super) fn push_decoded(text: &str, part: Part, depth: usize, out: &mut Residual) {
    if depth >= MAX_EMBEDDED_DEPTH || out.over_limit {
        return;
    }
    if out.action_arguments {
        if let Some(decoded) = percent_decoded(text) {
            out.push(part, &decoded);
        }
        if let Some(decoded) = base64_text(text) {
            out.push(part, &decoded);
        }
    } else if let Some(decoded) = percent_decoded_data_uri(text) {
        out.push(part, &decoded);
    }
    let looks_like_json = matches!(
        text.trim_start().as_bytes().first(),
        Some(b'{' | b'[' | b'"')
    );
    if looks_like_json {
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            push_embedded(&parsed, part, depth + 1, out);
            return;
        }
    }
    if let Some(decoded) = unescape_json(text, looks_like_json) {
        out.push(part, &decoded);
    }
}

pub(super) fn push_embedded(value: &Value, part: Part, depth: usize, out: &mut Residual) {
    match value {
        Value::String(text) => {
            if text.is_empty()
                || (!out.action_arguments && is_encoded(text, Zone::Content, !out.tool_loop))
            {
                return;
            }
            out.push(part, text);
            push_decoded(text, part, depth, out);
        }
        Value::Array(values) => {
            for value in values {
                push_embedded(value, part, depth, out);
            }
        }
        Value::Object(entries) => {
            for (key, value) in sorted_entries(entries) {
                if out.action_arguments || out.tool_loop {
                    out.push(part, key);
                    push_decoded(key, part, depth, out);
                }
                push_embedded(value, part, depth, out);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Decode the JSON escapes in `text`, or `None` when it has none: `\uXXXX`
/// (surrogate pairs included) always, and the single-character escapes
/// (`\n`, `\t`, `\"`, ...) when `all`. Unknown or malformed escapes are kept
/// as written.
pub(super) fn unescape_json(text: &str, all: bool) -> Option<String> {
    if !text.contains('\\') {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut decoded_any = false;
    while let Some(index) = rest.find('\\') {
        out.push_str(&rest[..index]);
        let after = &rest[index + 1..];
        let simple = match after.as_bytes().first() {
            Some(b'n') => Some('\n'),
            Some(b't') => Some('\t'),
            Some(b'r') => Some('\r'),
            Some(b'b') => Some('\u{8}'),
            Some(b'f') => Some('\u{c}'),
            Some(b'"') => Some('"'),
            Some(b'\\') => Some('\\'),
            Some(b'/') => Some('/'),
            _ => None,
        };
        if let Some(simple) = simple.filter(|_| all) {
            decoded_any = true;
            out.push(simple);
            rest = &after[1..];
            continue;
        }
        let Some(unit) = after.strip_prefix('u').and_then(hex_unit) else {
            out.push('\\');
            rest = after;
            continue;
        };
        decoded_any = true;
        rest = &after[5..];
        if (0xD800..0xDC00).contains(&unit) {
            if let Some(low) = rest.strip_prefix("\\u").and_then(hex_unit) {
                if (0xDC00..0xE000).contains(&low) {
                    let scalar = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                    out.push(char::from_u32(scalar).unwrap_or(char::REPLACEMENT_CHARACTER));
                    rest = &rest[6..];
                    continue;
                }
            }
        }
        out.push(char::from_u32(unit).unwrap_or(char::REPLACEMENT_CHARACTER));
    }
    out.push_str(rest);
    decoded_any.then_some(out)
}

/// The payload of a `data:` URI with its `%XX` escapes decoded, or `None` when
/// `text` is not a `data:` URI or its payload has no escape. Malformed escapes
/// are kept as written.
pub(super) fn percent_decoded_data_uri(text: &str) -> Option<String> {
    let (_, payload) = text.strip_prefix("data:")?.split_once(',')?;
    percent_decoded(payload)
}

/// `text` with its `%XX` escapes decoded, or `None` when it has no `%`.
/// Malformed escapes are kept as written.
pub(crate) fn percent_decoded(text: &str) -> Option<String> {
    if !text.contains('%') {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = bytes[index] == b'%'
            && bytes
                .get(index + 1..index + 3)
                .is_some_and(|digits| digits.iter().all(u8::is_ascii_hexdigit));
        if escaped {
            let digits = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("00");
            out.push(u8::from_str_radix(digits, 16).unwrap_or(0));
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Shortest whitespace-free base64-alphabet token an action argument decodes.
/// Shorter tokens are identifiers, and four characters carry three bytes.
pub(super) const BASE64_TEXT_MIN_LEN: usize = 16;

/// The UTF-8 text a base64 `data:` URI payload, or a whitespace-free token of
/// the standard or URL-safe base64 alphabet, decodes to. `None` when it does
/// not decode, or decodes to bytes that are not text (those stay screened in
/// their raw form only).
pub(super) fn base64_text(text: &str) -> Option<String> {
    use base64::{
        alphabet,
        engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
        Engine as _,
    };
    let payload = match text.strip_prefix("data:") {
        Some(uri) => {
            let (header, payload) = uri.split_once(',')?;
            if !header.ends_with(";base64") {
                return None;
            }
            payload
        }
        None if text.len() >= BASE64_TEXT_MIN_LEN => text,
        None => return None,
    };
    if payload.is_empty() || !is_base64(payload) {
        return None;
    }
    let config = GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true);
    let bytes = [alphabet::STANDARD, alphabet::URL_SAFE]
        .iter()
        .find_map(|alphabet| GeneralPurpose::new(alphabet, config).decode(payload).ok())?;
    let decoded = String::from_utf8(bytes).ok()?;
    let text_like = decoded
        .chars()
        .all(|c| !c.is_control() || c.is_whitespace());
    text_like.then_some(decoded)
}

/// The four hex digits at the start of `text`, as a UTF-16 code unit.
pub(super) fn hex_unit(text: &str) -> Option<u32> {
    let digits = text.get(..4)?;
    if !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(digits, 16).ok()
}
