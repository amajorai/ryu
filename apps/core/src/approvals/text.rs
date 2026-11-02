//! Localizable wording of an approval card: title, question and summary as
//! Core [`Message`]s, so every client renders them in its reader's locale.
//!
//! [`ApprovalRequest`](super::ApprovalRequest) keeps the English rendering in
//! `title`, `question` and `summary` (older clients and rows written before
//! this existed read those) and carries [`ApprovalText::to_wire`] as `i18n`:
//!
//! ```json
//! { "title": Phrase, "question": Phrase?, "summary": [Phrase | { "text": "…" }] }
//! ```
//!
//! A phrase is `{ "message": <English ICU source>, "args": { name: value } }`.
//! A value is a string (inserted verbatim: ids, names, addresses, the agent's
//! own words), a number object, or a nested phrase rendered in the same locale
//! first. Summary pieces are concatenated as rendered; `{ "text" }` pieces are
//! verbatim (line breaks and text the agent or app wrote).

use serde_json::{Map, Value};

use crate::i18n::{Message, Template};

/// One message whose arguments may themselves be messages.
#[derive(Debug, Clone, PartialEq)]
pub struct Phrase {
    base: Message,
    nested: Vec<(String, Phrase)>,
}

impl Phrase {
    pub fn new(template: Template) -> Self {
        Self {
            base: Message::new(template),
            nested: Vec::new(),
        }
    }

    /// A verbatim argument (never translated).
    pub fn text(mut self, name: &str, value: impl Into<String>) -> Self {
        self.base = self.base.text(name, value);
        self
    }

    /// A whole number, written with the locale's separators.
    pub fn count(mut self, name: &str, value: usize) -> Self {
        self.base = self.base.number(name, value as f64, 0, 0);
        self
    }

    /// An argument that is itself a message, rendered in the same locale.
    pub fn phrase(mut self, name: &str, value: Phrase) -> Self {
        self.nested.push((name.to_owned(), value));
        self
    }

    pub fn render(&self, locale: &str) -> String {
        if self.nested.is_empty() {
            return self.base.render(locale);
        }
        let mut message = self.base.clone();
        for (name, nested) in &self.nested {
            message = message.text(name, nested.render(locale));
        }
        message.render(locale)
    }

    pub fn to_wire(&self) -> Value {
        let mut wire = self.base.to_wire();
        if let Some(args) = wire.get_mut("args").and_then(Value::as_object_mut) {
            for (name, nested) in &self.nested {
                args.insert(name.clone(), nested.to_wire());
            }
        }
        wire
    }
}

/// One piece of a summary.
#[derive(Debug, Clone, PartialEq)]
pub enum Piece {
    Phrase(Phrase),
    /// Verbatim text: separators and the agent's or app's own words.
    Raw(String),
}

impl Piece {
    fn render(&self, locale: &str) -> String {
        match self {
            Piece::Phrase(phrase) => phrase.render(locale),
            Piece::Raw(text) => text.clone(),
        }
    }

    fn to_wire(&self) -> Value {
        match self {
            Piece::Phrase(phrase) => phrase.to_wire(),
            Piece::Raw(text) => {
                let mut object = Map::new();
                object.insert("text".to_owned(), Value::String(text.clone()));
                Value::Object(object)
            }
        }
    }
}

/// The card wording, before rendering.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalText {
    pub title: Phrase,
    pub question: Option<Phrase>,
    pub summary: Vec<Piece>,
}

impl ApprovalText {
    pub fn new(title: Phrase, summary: Vec<Piece>) -> Self {
        Self {
            title,
            question: None,
            summary,
        }
    }

    pub fn with_question(mut self, question: Phrase) -> Self {
        self.question = Some(question);
        self
    }

    /// `(title, question, summary)` in `locale`.
    pub fn render(&self, locale: &str) -> (String, Option<String>, String) {
        let summary = self
            .summary
            .iter()
            .map(|piece| piece.render(locale))
            .collect();
        (
            self.title.render(locale),
            self.question
                .as_ref()
                .map(|question| question.render(locale)),
            summary,
        )
    }

    pub fn to_wire(&self) -> Value {
        let mut wire = Map::new();
        wire.insert("title".to_owned(), self.title.to_wire());
        if let Some(question) = &self.question {
            wire.insert("question".to_owned(), question.to_wire());
        }
        wire.insert(
            "summary".to_owned(),
            Value::Array(self.summary.iter().map(Piece::to_wire).collect()),
        );
        Value::Object(wire)
    }
}

/// A summary from phrases and verbatim text, in order.
#[derive(Debug, Default)]
pub struct Summary(Vec<Piece>);

impl Summary {
    pub fn phrase(mut self, phrase: Phrase) -> Self {
        self.0.push(Piece::Phrase(phrase));
        self
    }

    pub fn raw(mut self, text: impl Into<String>) -> Self {
        self.0.push(Piece::Raw(text.into()));
        self
    }

    /// A line break, then `phrase`.
    pub fn line(self, phrase: Phrase) -> Self {
        self.raw("\n").phrase(phrase)
    }

    /// A blank line, then the verbatim `text`.
    pub fn paragraph(self, text: impl Into<String>) -> Self {
        self.raw("\n\n").raw(text)
    }

    pub fn build(self) -> Vec<Piece> {
        self.0
    }
}

/// Render one wire phrase (as [`Phrase::to_wire`] writes it) in `locale`.
/// `None` when it is malformed, so the caller keeps its English text.
pub fn render_wire_phrase(value: &Value, locale: &str) -> Option<String> {
    render_wire_at_depth(value, locale, 0)
}

/// Render a whole wire `i18n` object (as [`ApprovalText::to_wire`] writes
/// it) to `(title, question, summary)`; `None` when any part is malformed.
pub fn render_wire(value: &Value, locale: &str) -> Option<(String, Option<String>, String)> {
    let title = render_wire_phrase(value.get("title")?, locale)?;
    let question = match value.get("question") {
        None | Some(Value::Null) => None,
        Some(question) => Some(render_wire_phrase(question, locale)?),
    };
    let mut summary = String::new();
    for piece in value.get("summary")?.as_array()? {
        match piece.get("text") {
            Some(text) => summary.push_str(text.as_str()?),
            None => summary.push_str(&render_wire_phrase(piece, locale)?),
        }
    }
    Some((title, question, summary))
}

fn render_wire_at_depth(value: &Value, locale: &str, depth: usize) -> Option<String> {
    /// Phrases nest one level today; anything deeper is not ours.
    const MAX_DEPTH: usize = 3;
    if depth > MAX_DEPTH {
        return None;
    }
    let mut flat = value.clone();
    if let Some(args) = flat.get_mut("args").and_then(Value::as_object_mut) {
        for arg in args.values_mut() {
            if arg.get("message").is_some() {
                *arg = Value::String(render_wire_at_depth(arg, locale, depth + 1)?);
            }
        }
    }
    Message::from_wire(&flat).map(|message| message.render(locale))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::i18n::messages;

    #[test]
    fn nested_phrases_render_and_travel_as_objects() {
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_REPLY_ALL_TITLE_MESSAGE),
            Summary::default()
                .phrase(
                    Phrase::new(messages::APPROVAL_REPLY_SUMMARY_MESSAGE)
                        .text("sender", "Nova")
                        .phrase(
                            "recipients",
                            Phrase::new(messages::APPROVAL_REPLY_SENDER_MESSAGE),
                        ),
                )
                .paragraph("Thanks!")
                .build(),
        );
        let (title, question, summary) = text.render("en");
        assert_eq!(title, "Reply all to an email");
        assert_eq!(question, None);
        assert_eq!(
            summary,
            "Nova wants to reply to the sender of the message.\n\nThanks!"
        );
        let wire = text.to_wire();
        assert_eq!(
            wire["summary"][0]["args"]["recipients"]["message"],
            "the sender of the message"
        );
        assert_eq!(wire["summary"][0]["args"]["sender"], "Nova");
        assert_eq!(wire["summary"][2]["text"], "Thanks!");
        assert!(wire.get("question").is_none());
        assert_eq!(
            render_wire_phrase(&wire["summary"][0], "en").as_deref(),
            Some("Nova wants to reply to the sender of the message.")
        );
        assert_eq!(render_wire_phrase(&json!({ "args": {} }), "en"), None);
    }

    #[test]
    fn counts_are_numbers_on_the_wire() {
        let phrase = Phrase::new(messages::APPROVAL_BODY_HIDDEN_MESSAGE).count("hidden", 1200);
        assert_eq!(
            phrase.render("en"),
            "1,200 more characters of the message are not shown here."
        );
        assert_eq!(phrase.to_wire()["args"]["hidden"]["number"], 1200.0);
    }
}
