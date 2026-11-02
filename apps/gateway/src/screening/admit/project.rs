//! The admission projection: which texts and media a request sends upstream.

use base64::Engine as _;
use ryu_gw_screening::{LeafClass, ScreenImage};
use serde_json::Value;

use super::{MediaPart, ScreenInput};

/// The chat projection: each message's text under its role's class, tool
/// call arguments, top-level prompt fields, tool definitions, and media
/// parts.
pub fn chat_input(body: &Value) -> ScreenInput {
    let mut input = ScreenInput {
        model: body.get("model").and_then(Value::as_str).map(str::to_owned),
        ..ScreenInput::default()
    };
    for message in body["messages"].as_array().into_iter().flatten() {
        let class = match message["role"].as_str() {
            Some("system" | "developer") => LeafClass::System,
            Some("assistant") => LeafClass::Assistant,
            Some("tool" | "function") => LeafClass::ToolResult,
            _ => LeafClass::User,
        };
        collect_content(&message["content"], class, &mut input);
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                input.push(LeafClass::ToolArgs, arguments);
            }
        }
        if let Some(arguments) = message["function_call"]["arguments"].as_str() {
            input.push(LeafClass::ToolArgs, arguments);
        }
    }
    for key in ["prompt", "system", "instructions", "suffix"] {
        collect_content(&body[key], LeafClass::User, &mut input);
    }
    // Predicted output is sent upstream as a draft of the reply, and the regex
    // floor counts it as conversation, so it is never in the residual either.
    collect_content(
        &body["prediction"]["content"],
        LeafClass::Assistant,
        &mut input,
    );
    if !body["input"].is_null() {
        let mut text = String::new();
        walk_value(&body["input"], &mut text, &mut input.media, Walk::Parts);
        input.push(LeafClass::User, &text);
    }
    for tool in body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(body["functions"].as_array().into_iter().flatten())
    {
        let mut text = String::new();
        collect_strings(tool, &mut text);
        input.push(LeafClass::Definition, &text);
    }
    input
}

fn collect_content(content: &Value, class: LeafClass, input: &mut ScreenInput) {
    match content {
        Value::String(text) => input.push(class, text),
        Value::Array(parts) => {
            for part in parts {
                if let Some(media) = media_part(part) {
                    input.media.push(media);
                    continue;
                }
                match part {
                    Value::String(text) => input.push(class, text),
                    Value::Object(_) => {
                        let mut text = String::new();
                        for key in ["text", "content", "input_text", "output_text"] {
                            collect_strings(&part[key], &mut text);
                        }
                        input.push(class, &text);
                    }
                    _ => {}
                }
            }
        }
        Value::Object(_) => {
            let mut text = String::new();
            collect_strings(content, &mut text);
            input.push(class, &text);
        }
        _ => {}
    }
}

/// How [`walk_value`] reads media.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Walk {
    /// Media content parts only (chat, embeddings, tool rounds).
    Parts,
    /// A media route: a bare `image`, `mask` or similar field, or a data
    /// URL, is media too.
    MediaRoute,
    /// A transcription on a node's own tier: the audio fields are skipped,
    /// everything else is read as on a media route (spec D17).
    SkipAudio,
    /// A transcription on the floor tier: the audio is media no backend can
    /// screen, so it is refused; everything else is read as on a media route.
    RefuseAudio,
}

/// The audio fields of a transcription body.
const AUDIO_KEYS: &[&str] = &["file", "audio", "input_audio", "audio_url"];

/// Every string leaf of `value` into `text`, media aside.
pub(super) fn walk_value(value: &Value, text: &mut String, media: &mut Vec<MediaPart>, walk: Walk) {
    match value {
        Value::String(s) => {
            let audio = s
                .get(..11)
                .is_some_and(|head| head.eq_ignore_ascii_case("data:audio/"));
            if audio && walk == Walk::SkipAudio {
                return;
            }
            if audio && walk == Walk::RefuseAudio {
                media.push(MediaPart::Unscreenable);
                return;
            }
            if walk != Walk::Parts && looks_like_media(s) {
                media.push(decode_data_url(s).unwrap_or(MediaPart::Unscreenable));
            } else {
                text.push_str(s);
                text.push('\n');
            }
        }
        Value::Array(items) => items.iter().for_each(|v| walk_value(v, text, media, walk)),
        Value::Object(map) => {
            if let Some(part) = media_part(value) {
                media.push(part);
                return;
            }
            for (key, v) in map {
                if AUDIO_KEYS.contains(&key.as_str()) {
                    match walk {
                        Walk::SkipAudio => continue,
                        Walk::RefuseAudio if !v.is_null() => {
                            media.push(MediaPart::Unscreenable);
                            continue;
                        }
                        _ => {}
                    }
                }
                if walk != Walk::Parts && MEDIA_KEYS.contains(&key.as_str()) && !v.is_null() {
                    media.push(match v.as_str().and_then(decode_data_url) {
                        Some(part) => part,
                        None => MediaPart::Unscreenable,
                    });
                    continue;
                }
                walk_value(v, text, media, walk);
            }
        }
        _ => {}
    }
}

/// Body keys that carry an input image or other media on a media route.
const MEDIA_KEYS: &[&str] = &[
    "image",
    "images",
    "image_url",
    "mask",
    "input_image",
    "init_image",
    "reference_image",
    "start_image",
    "end_image",
    "video",
    "audio",
    "file",
];

fn looks_like_media(s: &str) -> bool {
    let head = s.get(..16).unwrap_or(s).to_ascii_lowercase();
    head.starts_with("data:image/")
        || head.starts_with("data:audio/")
        || head.starts_with("data:video/")
}

/// A content part that carries media, if `part` is one.
fn media_part(part: &Value) -> Option<MediaPart> {
    let kind = part["type"].as_str().unwrap_or("");
    let is_media = matches!(
        kind,
        "image_url"
            | "input_image"
            | "image"
            | "input_audio"
            | "audio"
            | "file"
            | "input_file"
            | "video"
            | "document"
    ) || part.get("image_url").is_some()
        || part.get("input_audio").is_some();
    if !is_media {
        return None;
    }
    let url = part["image_url"]["url"]
        .as_str()
        .or_else(|| part["image_url"].as_str())
        .or_else(|| part["url"].as_str());
    Some(
        url.and_then(decode_data_url)
            .unwrap_or(MediaPart::Unscreenable),
    )
}

/// The bytes of a `data:image/...;base64,` URL. Anything else (a remote URL,
/// audio, a malformed URL) is unscreenable.
fn decode_data_url(url: &str) -> Option<MediaPart> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    if !mime.starts_with("image/") {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .ok()?;
    Some(MediaPart::Image(ScreenImage::new(bytes, mime)))
}

fn collect_strings(value: &Value, out: &mut String) {
    match value {
        Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        Value::Array(items) => items.iter().for_each(|v| collect_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Message text, tool call arguments, tool definitions and media parts
    /// all reach the screen; a remote image URL is unscreenable media.
    #[test]
    fn the_chat_projection_reads_every_upstream_text_and_media_part() {
        let body = json!({
            "model": "m",
            "messages": [
                { "role": "system", "content": "system-marker" },
                { "role": "assistant", "content": null, "tool_calls": [
                    { "function": { "name": "f", "arguments": "{\"x\":\"args-marker\"}" } }
                ] },
                { "role": "user", "content": [
                    { "type": "text", "text": "user-marker" },
                    { "type": "image_url", "image_url": { "url": "https://example.invalid/a.png" } }
                ] }
            ],
            "tools": [{ "type": "function", "function": { "description": "definition-marker" } }]
        });
        let input = chat_input(&body);
        let texts: Vec<(LeafClass, &str)> = input
            .segments
            .iter()
            .map(|s| (s.class, s.text.as_str()))
            .collect();
        assert!(texts.contains(&(LeafClass::System, "system-marker")));
        assert!(texts
            .iter()
            .any(|(c, t)| *c == LeafClass::User && t.contains("user-marker")));
        assert!(texts
            .iter()
            .any(|(c, t)| *c == LeafClass::ToolArgs && t.contains("args-marker")));
        assert!(texts
            .iter()
            .any(|(c, t)| *c == LeafClass::Definition && t.contains("definition-marker")));
        assert!(matches!(input.media.as_slice(), [MediaPart::Unscreenable]));
        assert_eq!(input.model.as_deref(), Some("m"));
    }
}
