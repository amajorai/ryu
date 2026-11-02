//! [`NotifyHint`]: the user-facing notification an app raises alongside an
//! event, and [`NotifyMessage`], the localizable text it carries.
//!
//! # Localized text
//!
//! Core renders a hint's `i18n` text per recipient: the inbox row and toast in
//! the node's `ui-language`, each push in the locale its device registered
//! with. That object is the same `{ title, body, join }` shape
//! `notify.deliver` takes (an English ICU source plus named arguments per
//! message). The English rendering still goes out as the plain
//! `title`/`body`, so a Core that predates `i18n` delivers it unchanged.
//!
//! An app writes its copy as `*_MESSAGE` [`NotifyTemplate`]s in
//! `backend/src/fanout_messages.rs`, each `format!` with one named argument per
//! placeholder (`name = arg("name")`), so the i18n extractor catalogs the ICU
//! source and `tools/generate-core-i18n.mjs` copies its translations into
//! Core. Every message is a whole sentence. Core's renderer has no plural
//! selector, so a count is written as `label: {count}`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// An English template. Called with a placeholder echo it returns its ICU
/// source (`"A deal moved to {stage}"`).
pub type NotifyTemplate = fn(&dyn Fn(&'static str) -> String) -> String;

/// One named argument.
#[derive(Debug, Clone, PartialEq)]
enum Arg {
    /// Inserted verbatim (names, ids, relayed errors).
    Text(String),
    /// A whole number Core groups the way the reader's locale writes numbers.
    Count(i64),
}

impl Arg {
    fn english(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Count(count) => english_count(*count),
        }
    }

    fn to_wire(&self) -> Value {
        match self {
            Self::Text(text) => Value::String(text.clone()),
            Self::Count(count) => json!({ "number": count, "min_fraction": 0, "max_fraction": 0 }),
        }
    }
}

/// English digits with `,` grouping, as Core's English rendering prints them,
/// so the plain fallback text matches the localized English text.
fn english_count(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    if value < 0 {
        grouped.push('-');
    }
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// An English ICU source plus its named arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct NotifyMessage {
    source: String,
    args: Vec<(&'static str, Arg)>,
    /// Sent with `"relay": true`: Core may translate the relayed text.
    relay: bool,
}

impl NotifyMessage {
    /// A message from one of the app's `*_MESSAGE` templates.
    #[must_use]
    pub fn new(template: NotifyTemplate) -> Self {
        Self {
            source: template(&|name| format!("{{{name}}}")),
            args: Vec::new(),
            relay: false,
        }
    }

    /// Text that is not copy (a relayed error, a user's own words): shown as
    /// is in every language.
    #[must_use]
    pub fn verbatim(text: impl Into<String>) -> Self {
        Self {
            source: "{text}".to_owned(),
            args: vec![("text", Arg::Text(text.into()))],
            relay: false,
        }
    }

    /// Text relayed from elsewhere that may be catalogued copy (an error a
    /// worker or resolver raised). Core looks the text up in its catalog, as
    /// an exact sentence or a simple `{placeholder}` template, and shows it as
    /// is when it is not there. Use [`Self::verbatim`] for a person's own
    /// words, which must never be swapped for a catalog sentence. A Core that
    /// predates relays reads it as verbatim text.
    #[must_use]
    pub fn relayed(text: impl Into<String>) -> Self {
        Self {
            relay: true,
            ..Self::verbatim(text)
        }
    }

    /// Add a verbatim argument.
    #[must_use]
    pub fn text(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.args.push((name, Arg::Text(value.into())));
        self
    }

    /// Add a whole number.
    #[must_use]
    pub fn count(mut self, name: &'static str, value: i64) -> Self {
        self.args.push((name, Arg::Count(value)));
        self
    }

    /// The English ICU source, which is also the catalog key.
    #[must_use]
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The English text: the source with its arguments filled in. ICU quoting
    /// is honoured (`''` is an apostrophe, `'{…}'` is literal).
    #[must_use]
    pub fn english(&self) -> String {
        let mut out = String::with_capacity(self.source.len() + 16);
        let mut chars = self.source.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\'' => match chars.peek() {
                    Some('\'') => {
                        chars.next();
                        out.push('\'');
                    }
                    Some('{' | '}') => {
                        for quoted in chars.by_ref() {
                            if quoted == '\'' {
                                break;
                            }
                            out.push(quoted);
                        }
                    }
                    _ => out.push('\''),
                },
                '{' => {
                    let name: String = chars.by_ref().take_while(|&ch| ch != '}').collect();
                    match self.args.iter().find(|(key, _)| *key == name) {
                        Some((_, arg)) => out.push_str(&arg.english()),
                        None => {
                            out.push('{');
                            out.push_str(&name);
                            out.push('}');
                        }
                    }
                }
                other => out.push(other),
            }
        }
        out
    }

    fn to_wire(&self) -> Value {
        let args: Map<String, Value> = self
            .args
            .iter()
            .map(|(name, arg)| ((*name).to_owned(), arg.to_wire()))
            .collect();
        let mut wire = json!({ "message": self.source, "args": args });
        if self.relay {
            wire["relay"] = Value::Bool(true);
        }
        wire
    }
}

/// An optional user-facing notification to raise alongside an emitted event.
///
/// When present, Core delivers it into the app-inbox feed (the desktop Inbox
/// renders it, showing this app's icon) in addition to the hook/workflow fan-out.
/// Delivering is best-effort on Core's side — the emit itself never fails over a
/// notification. `target_user_id` names a specific member; omit it on a local
/// single-user node and Core delivers to the active account.
///
/// Build user-facing hints with [`NotifyHint::localized`];
/// [`NotifyHint::info`] carries English only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifyHint {
    /// The notification title (the row's headline), in English.
    pub title: String,
    /// Optional body text, in English.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// One of `info` | `success` | `warning` | `error` (defaults to `info`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// The member to deliver to; omit to target the node's active account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_user_id: Option<String>,
    /// Localizable text (`{ title, body, join }`) Core renders per recipient
    /// locale. Absent on an English-only hint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n: Option<Value>,
}

impl NotifyHint {
    /// Build a plain `info` hint with just an English title and optional body.
    #[must_use]
    pub fn info(title: impl Into<String>, body: Option<String>) -> Self {
        Self {
            title: title.into(),
            body,
            level: None,
            target_user_id: None,
            i18n: None,
        }
    }

    /// Build an `info` hint from localizable messages. The body messages are
    /// sentences of one paragraph; the English rendering is the plain text.
    #[must_use]
    pub fn localized(title: NotifyMessage, body: Vec<NotifyMessage>) -> Self {
        let english_body = body
            .iter()
            .map(NotifyMessage::english)
            .collect::<Vec<_>>()
            .join(" ");
        let i18n = json!({
            "title": title.to_wire(),
            "body": body.iter().map(NotifyMessage::to_wire).collect::<Vec<_>>(),
            "join": "sentences",
        });
        Self {
            title: title.english(),
            body: (!english_body.is_empty()).then_some(english_body),
            level: None,
            target_user_id: None,
            i18n: Some(i18n),
        }
    }

    /// Mark the hint `level` (`info` | `success` | `warning` | `error`).
    #[must_use]
    pub fn with_level(mut self, level: impl Into<String>) -> Self {
        self.level = Some(level.into());
        self
    }
}

#[cfg(test)]
#[path = "notify_test.rs"]
mod tests;
