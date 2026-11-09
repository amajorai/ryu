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
    /// Where tapping the notification leads: a deep link into the emitting
    /// app, `ryu://apps/<plugin id>[/<path>][?<query>]` (see
    /// [`NotifyHint::link_is_valid_for`]). Core drops a link that names another
    /// app or is malformed and still delivers the notification. A Core that
    /// predates links ignores the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// The longest tap link Core accepts.
pub const MAX_NOTIFY_LINK_BYTES: usize = 512;
/// The scheme and prefix every app notification link starts with.
const APP_LINK_PREFIX: &str = "ryu://apps/";

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
            link: None,
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
            link: None,
        }
    }

    /// Mark the hint `level` (`info` | `success` | `warning` | `error`).
    #[must_use]
    pub fn with_level(mut self, level: impl Into<String>) -> Self {
        self.level = Some(level.into());
        self
    }

    /// Address the hint to one member.
    #[must_use]
    pub fn for_user(mut self, user_id: impl Into<String>) -> Self {
        self.target_user_id = Some(user_id.into());
        self
    }

    /// Open `link` when the notification is tapped. It must be a deep link
    /// into the emitting app ([`Self::link_is_valid_for`]).
    #[must_use]
    pub fn with_link(mut self, link: impl Into<String>) -> Self {
        self.link = Some(link.into());
        self
    }

    /// Whether `link` is a tap target `plugin_id` may attach: exactly
    /// `ryu://apps/<plugin_id>`, optionally followed by a path and a query, at
    /// most [`MAX_NOTIFY_LINK_BYTES`] of printable ASCII. The path may not hold
    /// empty, `.` or `..` segments, nor percent-escapes of `.`, `/`, `\` or
    /// `%` (so a client that decodes the path, once or twice, still cannot
    /// climb out of the app), and the link may not carry a fragment,
    /// whitespace, a backslash or broken percent-escapes. A link can therefore
    /// only ever open the emitting app's own screens; each surface still maps
    /// it to a screen it knows, or opens the app's default view.
    #[must_use]
    pub fn link_is_valid_for(plugin_id: &str, link: &str) -> bool {
        if plugin_id.is_empty() || link.len() > MAX_NOTIFY_LINK_BYTES {
            return false;
        }
        let Some(rest) = link
            .strip_prefix(APP_LINK_PREFIX)
            .and_then(|rest| rest.strip_prefix(plugin_id))
        else {
            return false;
        };
        let (path, query) = match rest.split_once('?') {
            Some((path, query)) => (path, Some(query)),
            None => (rest, None),
        };
        let path_ok = path.is_empty()
            || path.strip_prefix('/').is_some_and(|segments| {
                segments.split('/').all(|segment| {
                    !matches!(segment, "" | "." | "..")
                        && link_text_is_valid(segment, |c| c != b'/' && c != b'?')
                        && !escapes_path_syntax(segment)
                })
            });
        path_ok && query.is_none_or(|query| link_text_is_valid(query, |_| true))
    }
}

/// Whether a path segment percent-escapes path syntax: `.`, `/`, `\`, or
/// `%` itself (a double-encoded escape). Call it only on text that
/// [`link_text_is_valid`] accepted, so every `%` starts a full escape.
fn escapes_path_syntax(segment: &str) -> bool {
    segment.as_bytes().windows(3).any(|window| {
        window[0] == b'%'
            && std::str::from_utf8(&window[1..])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                .is_some_and(|byte| matches!(byte, b'.' | b'/' | b'\\' | b'%'))
    })
}

/// Printable ASCII from the URI path/query alphabet, with well-formed
/// percent-escapes. `extra` narrows the alphabet further.
fn link_text_is_valid(text: &str, extra: impl Fn(u8) -> bool) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            let escape_ok = bytes
                .get(index + 1..index + 3)
                .is_some_and(|hex| hex.iter().all(u8::is_ascii_hexdigit));
            if !escape_ok {
                return false;
            }
            index += 3;
            continue;
        }
        let allowed = byte.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/?".contains(&byte);
        if !allowed || !extra(byte) {
            return false;
        }
        index += 1;
    }
    true
}

#[cfg(test)]
#[path = "notify_test.rs"]
mod tests;
