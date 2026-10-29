//! UI message text and attachments shared by ACP and OpenAI-compatible turns.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A single message in the AI SDK UIMessage format (simplified subset).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiMessage {
    pub role: String,
    /// Legacy string or parts array (AI SDK v5 and earlier).
    #[serde(default)]
    pub content: UiContent,
    /// AI SDK v6 sends parts at the top level instead of content.
    #[serde(default)]
    pub parts: Vec<serde_json::Value>,
    /// Client display metadata, preserved at rest but never trusted for identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(untagged)]
pub enum UiContent {
    #[default]
    Empty,
    Text(String),
    Parts(Vec<Value>),
}

impl UiMessage {
    /// Preserve the submitted render parts across both AI SDK wire shapes.
    pub fn render_parts(&self) -> Option<Value> {
        let parts = if self.parts.is_empty() {
            match &self.content {
                UiContent::Parts(parts) => parts,
                _ => return None,
            }
        } else {
            &self.parts
        };
        (!parts.is_empty()).then(|| Value::Array(parts.clone()))
    }
}

impl UiContent {
    /// Extract a plain-text string from any content shape.
    pub fn as_text(&self) -> String {
        match self {
            Self::Text(s) => s.clone(),
            Self::Parts(parts) => parts
                .iter()
                .filter_map(|p| p.get("text")?.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
                .join(""),
            Self::Empty => String::new(),
        }
    }
}

/// Extract the last user message as a prompt string for ACP agents.
/// Image extracted from a user message part (base64 data + MIME type).
#[derive(Debug, Clone)]
pub struct ImagePart {
    pub data: String,
    pub mime_type: String,
}

pub(super) fn last_user_message(messages: &[UiMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(ui_message_text)
        .unwrap_or_default()
}

/// Extract the plain-text of a single UI message, handling both the legacy
/// `content` shape and the AI SDK v6 top-level `parts` array. Shared so the
/// plugin pre-turn hook (which rewrites the outgoing user message) reads text the
/// same way the chat path does.
pub(crate) fn ui_message_text(m: &UiMessage) -> String {
    let from_content = m.content.as_text();
    if !from_content.is_empty() {
        return from_content;
    }
    // AI SDK v6: text lives in top-level parts array.
    m.parts
        .iter()
        .filter_map(|p| {
            let t = p.get("type")?.as_str()?;
            if t == "text" {
                p.get("text")?.as_str().map(str::to_owned)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Replace the text of the most recent `user` message in place with `text`,
/// preserving any non-text parts (e.g. image `file` parts stay attached). Used by
/// the plugin pre-turn hook to swap the outgoing prompt for its expanded form
/// before the turn is streamed and persisted. Returns `true` if a user message
/// was found and rewritten.
pub(crate) fn set_last_user_text(messages: &mut [UiMessage], text: String) -> bool {
    if let Some(m) = messages.iter_mut().rev().find(|m| m.role == "user") {
        m.content = UiContent::Text(text);
        // Drop v6 text parts so the rewritten `content` is authoritative; keep
        // non-text parts (images/files) so multimodal input survives the rewrite.
        m.parts
            .retain(|p| p.get("type").and_then(|t| t.as_str()) != Some("text"));
        true
    } else {
        false
    }
}

/// Append `extra` as additional context to the most recent `user` message
/// (additive, not a replacement — the user's own text is kept). Used by the
/// plugin `Inject` directive (`session_start` / `pre_user_turn`) to fold
/// plugin-supplied context into the outgoing turn. Returns `true` if a user
/// message was found.
pub(crate) fn append_last_user_text(messages: &mut [UiMessage], extra: &str) -> bool {
    if let Some(m) = messages.iter_mut().rev().find(|m| m.role == "user") {
        let base = ui_message_text(m);
        let joined = if base.is_empty() {
            extra.to_string()
        } else {
            format!("{base}\n\n{extra}")
        };
        m.content = UiContent::Text(joined);
        m.parts
            .retain(|p| p.get("type").and_then(|t| t.as_str()) != Some("text"));
        true
    } else {
        false
    }
}

/// Image `file` parts of a single message (AI SDK v6 `file` parts with an image
/// mediaType/mimeType carrying a data-URL `data:<mime>;base64,<data>`).
///
/// The `mime.starts_with("image/")` skip below is NOT a drop: non-image `file` parts
/// are handled by [`message_document_parts`], which both call sites invoke alongside
/// this one. Adding a third kind of part means extending that pair — a part type
/// neither function claims reaches the model as nothing, which is exactly the bug
/// this seam was split to fix.
pub(super) fn message_image_parts(msg: &UiMessage) -> Vec<ImagePart> {
    let mut images = Vec::new();
    for part in &msg.parts {
        let type_ = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if type_ != "file" {
            continue;
        }
        let mime = part
            .get("mediaType")
            .or_else(|| part.get("mimeType"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !mime.starts_with("image/") {
            continue;
        }
        let url = part.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(base64) = extract_base64_from_data_url(url) {
            images.push(ImagePart {
                data: base64,
                mime_type: mime.to_owned(),
            });
        }
    }
    images
}

/// Cap on the extracted text a single attached document may contribute to a turn.
///
/// Mirrors `crate::document_parse::MAX_MARKDOWN_BYTES`, which already clamped it on
/// the way in. Repeated here because this side must hold regardless of who wrote the
/// part: a `file` part arrives from a client and is not trusted to have been
/// through Core's own parse facade.
const MAX_DOCUMENT_PART_CHARS: usize = 400_000;

/// Cap on how many attached documents one message may contribute, so a drag-and-drop
/// of forty files cannot crowd the conversation out of its own context window.
const MAX_DOCUMENT_PARTS: usize = 12;

/// The **document half** of the multimodal seam, and the reason a dropped PDF is no
/// longer discarded.
///
/// [`message_image_parts`] deliberately skips every `file` part whose mediaType is
/// not `image/*`. Until this function existed, that `continue` was the end of the
/// road: a PDF, a DOCX, a spreadsheet — anything not an image — reached the model as
/// nothing at all, with no error anywhere in the stack. This is its sibling, so the
/// two together account for every `file` part instead of one of them quietly eating
/// the rest.
///
/// ## Why the extracted text arrives as a part rather than as the user's prose
///
/// The desktop extracts through `POST /api/documents/parse` (the one
/// `document.parse` facade) and attaches the resulting markdown as a
/// `text/markdown` `file` part carrying the ORIGINAL filename. It is not folded into
/// the user's message text on the client, because the user did not type it: a 60k
/// character extraction rendered inside their own chat bubble is not a chat message.
/// Keeping it a part lets the transcript render a document chip while the model
/// receives the contents, and — because message parts are persisted (the sealed
/// `parts` column) — a reloaded thread still carries the document without re-parsing
/// a file the user may have since deleted.
///
/// ## Why it is resolved HERE and not further out
///
/// Both chat planes converge on this module, and both build their prompt text from
/// the same `UiMessage`s. Resolving at this seam means one implementation serves the
/// openai-compat plane (per message, so document context survives across the whole
/// history) and the ACP plane (last turn only) with the same rules, instead of two
/// prompt builders growing their own idea of what an attachment is.
///
/// Only `data:` URLs are read. A part pointing at an `http(s)` URL is skipped rather
/// than fetched: this runs inside the chat request path, and turning a
/// client-supplied URL into a server-side fetch would be an SSRF primitive on the
/// hottest path in the product.
fn message_document_parts(msg: &UiMessage) -> Vec<(String, String)> {
    let mut docs = Vec::new();
    for part in &msg.parts {
        if docs.len() >= MAX_DOCUMENT_PARTS {
            break;
        }
        if part.get("type").and_then(|v| v.as_str()) != Some("file") {
            continue;
        }
        let mime = part
            .get("mediaType")
            .or_else(|| part.get("mimeType"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        // Images are the other half of the seam.
        if mime.starts_with("image/") {
            continue;
        }
        let filename = part
            .get("filename")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("attachment")
            .to_owned();

        // A `file` part that is neither an image nor readable text is the case the
        // desktop no longer produces (it extracts before sending) but that any other
        // client still can — native, TUI, the extension, a channel adapter. It gets a
        // NOTE, not a skip. Dropping it is the original bug, and "the model was never
        // told there was a file" is precisely the failure mode that made it invisible
        // for so long: this way the assistant can say "I can see notes.pdf is attached
        // but I can't read it", which is a debuggable answer.
        let text = mime
            .starts_with("text/")
            .then(|| part.get("url").and_then(|v| v.as_str()).unwrap_or(""))
            .and_then(decode_text_data_url)
            .filter(|t| !t.trim().is_empty());
        let Some(text) = text else {
            docs.push((
                filename,
                format!(
                    "[This file is attached but no text could be extracted from it \
                     (type: {}). Tell the user you cannot read it rather than \
                     guessing at its contents.]",
                    if mime.is_empty() { "unknown" } else { mime }
                ),
            ));
            continue;
        };

        let mut body = text;
        if body.chars().count() > MAX_DOCUMENT_PART_CHARS {
            body = body
                .chars()
                .take(MAX_DOCUMENT_PART_CHARS)
                .collect::<String>()
                + "\n\n[truncated]";
        }
        docs.push((filename, body));
    }
    docs
}

/// The attached documents of `msg` rendered as one context block, or `None`.
///
/// Fenced and labelled with the source filename so the model can tell the user's own
/// words from a file's contents — the same reason retrieved memory is delimited.
pub(super) fn document_context_block(msg: &UiMessage) -> Option<String> {
    let docs = message_document_parts(msg);
    if docs.is_empty() {
        return None;
    }
    let mut out = String::new();
    for (filename, body) in docs {
        out.push_str(&format!(
            "\n\n<attached-document filename=\"{}\">\n{}\n</attached-document>",
            filename.replace('"', "'"),
            body
        ));
    }
    Some(out)
}

/// Decode a `data:` URL whose payload is text, base64 or percent/plain encoded.
/// `None` for a non-data URL or bytes that are not valid UTF-8.
fn decode_text_data_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if meta.ends_with(";base64") {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .ok()?;
        return String::from_utf8(bytes).ok();
    }
    // Non-base64 data URLs are percent-encoded text.
    Some(percent_decode(data))
}

/// Minimal percent-decode for a plain `data:` URL payload. Invalid escapes are kept
/// verbatim rather than dropped — losing characters from a document silently is the
/// class of bug this whole change exists to remove.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extract image parts from the last user message (for the ACP plane, which
/// sends only the latest turn). The openai_compat plane uses
/// [`message_image_parts`] per message instead, to preserve image context across
/// the full history.
pub(super) fn last_user_images(messages: &[UiMessage]) -> Vec<ImagePart> {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(message_image_parts)
        .unwrap_or_default()
}

/// Strip `data:<mime>;base64,` prefix and return the raw base64 string.
fn extract_base64_from_data_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("data:")?;
    let (_meta, data) = rest.split_once(',')?;
    Some(data.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Attached documents (the non-image half of the `file`-part seam) ─────────

    /// Build a `file` part the way the desktop composer sends an extracted document.
    fn doc_part(filename: &str, markdown: &str) -> serde_json::Value {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(markdown);
        serde_json::json!({
            "type": "file",
            "mediaType": "text/markdown",
            "filename": filename,
            "url": format!("data:text/markdown;base64,{b64}"),
        })
    }

    fn user_with_parts(text: &str, parts: Vec<serde_json::Value>) -> UiMessage {
        UiMessage {
            metadata: None,
            role: "user".to_owned(),
            content: UiContent::Text(text.to_owned()),
            parts,
        }
    }

    #[test]
    fn attached_document_reaches_the_prompt_labelled_with_its_filename() {
        let m = user_with_parts(
            "summarise this",
            vec![doc_part("q3.pdf", "# Revenue\nUp 12%.")],
        );
        let block = document_context_block(&m).expect("a document part yields a block");
        assert!(block.contains("filename=\"q3.pdf\""), "got: {block}");
        assert!(block.contains("Up 12%."), "got: {block}");
    }

    #[test]
    fn images_and_documents_do_not_claim_each_others_parts() {
        let image = serde_json::json!({
            "type": "file",
            "mediaType": "image/png",
            "url": "data:image/png;base64,AAAA",
        });
        let m = user_with_parts("both", vec![image, doc_part("notes.md", "hello")]);
        // Exactly one each — neither function eats the other's part, and nothing is
        // dropped by both (the bug this seam exists to close).
        assert_eq!(message_image_parts(&m).len(), 1);
        assert_eq!(message_document_parts(&m).len(), 1);
    }

    #[test]
    fn remote_urls_are_never_fetched_but_are_still_declared() {
        let remote = serde_json::json!({
            "type": "file",
            "mediaType": "text/markdown",
            "filename": "evil.md",
            "url": "https://internal.example/admin",
        });
        let m = user_with_parts("read it", vec![remote]);
        let block = document_context_block(&m).expect("declared, not silently dropped");
        // The URL is never dereferenced — a client-supplied URL must not become a
        // server-side fetch on the chat path.
        assert!(!block.contains("internal.example"), "got: {block}");
        assert!(block.contains("no text could be extracted"), "got: {block}");
    }

    #[test]
    fn an_unreadable_file_part_is_declared_rather_than_dropped() {
        // What every non-desktop client still sends: the raw document, unparsed.
        let raw = serde_json::json!({
            "type": "file",
            "mediaType": "application/pdf",
            "filename": "contract.pdf",
            "url": "data:application/pdf;base64,JVBERi0=",
        });
        let m = user_with_parts("what does it say", vec![raw]);
        let block = document_context_block(&m).expect("must not vanish");
        assert!(block.contains("contract.pdf"), "got: {block}");
        assert!(block.contains("application/pdf"), "got: {block}");
    }

    #[test]
    fn plain_data_urls_decode_too() {
        let part = serde_json::json!({
            "type": "file",
            "mediaType": "text/plain",
            "filename": "a.txt",
            "url": "data:text/plain,hello%20world",
        });
        let m = user_with_parts("", vec![part]);
        assert!(document_context_block(&m).unwrap().contains("hello world"));
    }

    #[test]
    fn a_message_with_only_a_document_still_produces_a_block() {
        // The ACP plane's emptiness guard depends on this: attaching a file with no
        // typed text is a real turn, not "no user message".
        let m = user_with_parts("", vec![doc_part("spec.docx", "body text")]);
        assert!(document_context_block(&m).is_some());
    }

    #[test]
    fn attached_documents_are_capped_per_message() {
        let parts: Vec<_> = (0..40)
            .map(|i| doc_part(&format!("f{i}.md"), "x"))
            .collect();
        let m = user_with_parts("many", parts);
        assert_eq!(message_document_parts(&m).len(), MAX_DOCUMENT_PARTS);
    }

    #[test]
    fn a_blank_extraction_says_so_instead_of_looking_like_no_attachment() {
        let m = user_with_parts("hi", vec![doc_part("blank.txt", "   \n  ")]);
        let block = document_context_block(&m).expect("the file was still attached");
        assert!(block.contains("blank.txt"), "got: {block}");
        assert!(block.contains("no text could be extracted"), "got: {block}");
    }

    #[test]
    fn a_message_with_no_file_parts_adds_nothing() {
        let m = user_with_parts("just a question", vec![]);
        assert!(document_context_block(&m).is_none());
    }
}
