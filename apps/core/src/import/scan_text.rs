//! Scan copy as Core messages: each item title, export detail and warning is
//! built from a template in `crate::i18n::messages::import`. The English text
//! stays on the wire (`title`, `detail`, `warnings`) for older clients, and
//! the message rides next to it (`title_i18n`, `detail_i18n`,
//! `warning_notices`) so the desktop renders it in the reader's language.

use serde::ser::SerializeSeq;
use serde::Serializer;
use serde_json::Value;

use super::*;

/// One scan warning: the English sentence plus, when it has one, its message.
#[derive(Debug, Clone, Serialize)]
pub struct ScanWarning {
    pub message: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "wire_message"
    )]
    pub i18n: Option<Message>,
}

impl ScanWarning {
    pub fn new(message: Message) -> Self {
        Self {
            message: english(&message),
            i18n: Some(message),
        }
    }

    /// A warning with no translatable words (a path and a relayed error).
    pub fn verbatim(message: String) -> Self {
        Self {
            message,
            i18n: None,
        }
    }
}

/// The English text of `message` as the desktop renders it: `{name}` filled
/// in, apostrophes kept literally (the scan titles quote names with `'`).
pub fn english(message: &Message) -> String {
    let wire = message.to_wire();
    let source = wire.get("message").and_then(Value::as_str).unwrap_or("");
    let args = wire.get("args").and_then(Value::as_object);
    let mut out = String::with_capacity(source.len() + 16);
    let mut rest = source;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = &after[..close];
        match args.and_then(|args| args.get(name)) {
            Some(Value::String(text)) => out.push_str(text),
            Some(Value::Object(number)) => {
                let value = number.get("number").and_then(Value::as_f64).unwrap_or(0.0);
                out.push_str(&format!("{value}"));
            }
            _ => {
                out.push('{');
                out.push_str(name);
                out.push('}');
            }
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

/// `message` with a whole-number `count` argument.
pub(super) fn counted(message: Message, count: usize) -> Message {
    message.number("count", count as f64, 0, 0)
}

/// `serialize_with` for an optional message: its wire form.
pub(super) fn wire_message<S: Serializer>(
    message: &Option<Message>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match message {
        Some(message) => serializer.serialize_some(&message.to_wire()),
        None => serializer.serialize_none(),
    }
}

/// `serialize_with` for a list of messages: their wire forms.
pub(super) fn wire_messages<S: Serializer>(
    messages: &[Message],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut seq = serializer.serialize_seq(Some(messages.len()))?;
    for message in messages {
        seq.serialize_element(&message.to_wire())?;
    }
    seq.end()
}

impl ScanItem {
    /// An item whose title is `title`; `detail` is a path or `None`.
    pub(super) fn titled(
        kind: &'static str,
        id: String,
        title: Message,
        detail: Option<String>,
    ) -> Self {
        Self {
            content_revision: None,
            kind,
            id,
            title: english(&title),
            title_i18n: Some(title),
            detail,
            detail_i18n: Vec::new(),
            already_exists: false,
        }
    }

    /// Replace the detail with `sentences`, joined with a space in English.
    pub(super) fn with_sentences(mut self, sentences: Vec<Message>) -> Self {
        let english: Vec<String> = sentences.iter().map(english).collect();
        self.detail = Some(english.join(" "));
        self.detail_i18n = sentences;
        self
    }
}

impl Collector {
    /// Record a warning built from a template in `messages::import`.
    pub(super) fn warn(&mut self, message: Message) {
        self.warnings.push(ScanWarning::new(message));
    }

    /// Record a warning that is only a path and a relayed error.
    pub(super) fn warn_verbatim(&mut self, message: String) {
        self.warnings.push(ScanWarning::verbatim(message));
    }
}
