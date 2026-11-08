//! [`Message`] and [`AlertText`]: English ICU source + arguments, rendered per
//! locale, plus the JSON wire form an app backend sends with `notify.fanout`
//! (`alert.i18n`) and `notify.deliver` (`i18n`).

use std::borrow::Cow;

use serde_json::{json, Map, Value};

use chrono::NaiveDate;

use super::{bidi, catalog, date, locale, number, relayed};

/// An English message template. Called with a placeholder echo it returns its
/// ICU source (`"Unexpected HTTP {status}."`); written as `format!` with named
/// arguments so the i18n extractor catalogs exactly that source.
pub type Template = fn(&dyn Fn(&'static str) -> String) -> String;

/// Longest wire message or argument Core renders, and the most arguments.
const MAX_WIRE_TEXT: usize = 2_000;
const MAX_WIRE_ARGS: usize = 16;
const MAX_WIRE_BODY: usize = 32;

/// One named argument.
#[derive(Debug, Clone, PartialEq)]
pub enum Arg {
    /// Inserted verbatim (names, ids, relayed errors).
    Text(String),
    /// Formatted with the locale's separators.
    Number {
        value: f64,
        min_fraction: u8,
        max_fraction: u8,
    },
    /// A calendar day, written with the locale's weekday and month names.
    Date(NaiveDate),
}

impl Arg {
    fn render(&self, locale: &str) -> String {
        match self {
            Arg::Text(text) => text.clone(),
            Arg::Number {
                value,
                min_fraction,
                max_fraction,
            } => number::format(locale, *value, *min_fraction, *max_fraction),
            Arg::Date(day) => date::format(locale, *day),
        }
    }

    fn to_wire(&self) -> Value {
        match self {
            Arg::Text(text) => Value::String(text.clone()),
            Arg::Number {
                value,
                min_fraction,
                max_fraction,
            } => json!({
                "number": value,
                "min_fraction": min_fraction,
                "max_fraction": max_fraction,
            }),
            Arg::Date(day) => json!({ "date": day.format("%Y-%m-%d").to_string() }),
        }
    }

    fn from_wire(value: &Value) -> Option<Self> {
        match value {
            Value::String(text) => Some(Arg::Text(clip(text))),
            Value::Number(number) => Some(Arg::Number {
                value: number.as_f64()?,
                min_fraction: 0,
                max_fraction: 0,
            }),
            Value::Object(object) if object.contains_key("date") => object
                .get("date")?
                .as_str()
                .and_then(date::parse)
                .map(Arg::Date),
            Value::Object(object) => {
                let fraction = |key: &str| {
                    object
                        .get(key)
                        .and_then(Value::as_u64)
                        .map_or(0, |n| n.min(6) as u8)
                };
                let max_fraction = fraction("max_fraction");
                Some(Arg::Number {
                    value: object.get("number")?.as_f64()?,
                    min_fraction: fraction("min_fraction").min(max_fraction),
                    max_fraction,
                })
            }
            _ => None,
        }
    }
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_WIRE_TEXT).collect()
}

/// An English ICU source plus its arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    source: Cow<'static, str>,
    args: Vec<(String, Arg)>,
    /// Relayed text (`"relay": true` on the wire): its `{text}` argument is
    /// looked up in the catalog before it is shown as is.
    relay: bool,
}

impl Message {
    /// A message from one of the `*_MESSAGE` templates.
    pub fn new(template: Template) -> Self {
        Self {
            source: Cow::Owned(template(&|name| format!("{{{name}}}"))),
            args: Vec::new(),
            relay: false,
        }
    }

    /// Add a verbatim argument.
    pub fn text(mut self, name: &str, value: impl Into<String>) -> Self {
        self.args.push((name.to_owned(), Arg::Text(value.into())));
        self
    }

    /// Add a number with between `min_fraction` and `max_fraction` decimals.
    pub fn number(mut self, name: &str, value: f64, min_fraction: u8, max_fraction: u8) -> Self {
        self.args.push((
            name.to_owned(),
            Arg::Number {
                value,
                min_fraction: min_fraction.min(max_fraction),
                max_fraction,
            },
        ));
        self
    }

    /// Add a calendar day, written with the locale's weekday and month names.
    pub fn date(mut self, name: &str, day: NaiveDate) -> Self {
        self.args.push((name.to_owned(), Arg::Date(day)));
        self
    }

    /// The English ICU source, which is also the catalog key.
    #[cfg(test)]
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Render for `locale` (any tag; unsupported ones fall back to English).
    pub fn render(&self, locale: &str) -> String {
        let locale = locale::resolve(locale);
        if let Some(text) = self.relayed_text() {
            return relayed::render(text, locale).unwrap_or_else(|| text.to_owned());
        }
        let translated = catalog::lookup(locale, &self.source)
            .and_then(|pattern| substitute(pattern, locale, &self.args));
        translated.unwrap_or_else(|| {
            substitute(&self.source, locale, &self.args).unwrap_or_else(|| self.source.to_string())
        })
    }

    /// The text of a relayed message (`{text}` with a text argument).
    fn relayed_text(&self) -> Option<&str> {
        if !self.relay || self.source != relayed::SOURCE {
            return None;
        }
        match self.args.as_slice() {
            [(name, Arg::Text(text))] if name == "text" => Some(text),
            _ => None,
        }
    }

    pub fn to_wire(&self) -> Value {
        let args: Map<String, Value> = self
            .args
            .iter()
            .map(|(name, arg)| (name.clone(), arg.to_wire()))
            .collect();
        let mut wire = json!({ "message": self.source, "args": args });
        if self.relay {
            wire["relay"] = Value::Bool(true);
        }
        wire
    }

    pub fn from_wire(value: &Value) -> Option<Self> {
        let source = value.get("message")?.as_str()?;
        if source.is_empty() || source.len() > MAX_WIRE_TEXT {
            return None;
        }
        let mut args = Vec::new();
        if let Some(object) = value.get("args").and_then(Value::as_object) {
            for (name, arg) in object.iter().take(MAX_WIRE_ARGS) {
                args.push((name.clone(), Arg::from_wire(arg)?));
            }
        }
        Some(Self {
            source: Cow::Owned(source.to_owned()),
            args,
            relay: value.get("relay").and_then(Value::as_bool) == Some(true),
        })
    }
}

/// How an alert body's messages are joined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Join {
    /// One message per line (a list of changes).
    Lines,
    /// Sentences of one paragraph (no space in Japanese and Chinese).
    Sentences,
}

/// A localizable alert: title plus body messages.
#[derive(Debug, Clone, PartialEq)]
pub struct AlertText {
    pub title: Message,
    pub body: Vec<Message>,
    pub join: Join,
}

impl AlertText {
    pub fn new(title: Message, body: Vec<Message>, join: Join) -> Self {
        Self { title, body, join }
    }

    /// `(title, body)` for `locale`.
    pub fn render(&self, locale: &str) -> (String, String) {
        let mut body = String::new();
        for message in &self.body {
            let sentence = message.render(locale);
            if !body.is_empty() {
                body.push_str(match self.join {
                    Join::Lines => "\n",
                    // A sentence still in English (no translation yet) keeps
                    // its space even in Japanese or Chinese.
                    Join::Sentences if body.ends_with(|c: char| c.is_ascii()) => " ",
                    Join::Sentences => locale::sentence_separator(locale),
                });
            }
            body.push_str(&sentence);
        }
        (self.title.render(locale), body)
    }

    pub fn to_wire(&self) -> Value {
        json!({
            "title": self.title.to_wire(),
            "body": self.body.iter().map(Message::to_wire).collect::<Vec<_>>(),
            "join": match self.join {
                Join::Lines => "lines",
                Join::Sentences => "sentences",
            },
        })
    }

    /// Parse the `i18n` object an alert carries. Anything malformed is `None`,
    /// and the alert's own English title and message are used instead.
    pub fn from_wire(value: &Value) -> Option<Self> {
        let title = Message::from_wire(value.get("title")?)?;
        let body = match value.get("body") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .iter()
                .take(MAX_WIRE_BODY)
                .map(Message::from_wire)
                .collect::<Option<Vec<_>>>()?,
            Some(_) => return None,
        };
        let join = match value.get("join").and_then(Value::as_str) {
            Some("sentences") => Join::Sentences,
            _ => Join::Lines,
        };
        Some(Self { title, body, join })
    }
}

/// Fill `{name}` placeholders. ICU quoting is honoured (`''` is an apostrophe,
/// `'{…}'` is literal). `None` for a pattern this renderer cannot format (a
/// `plural`/`select` argument, an unknown placeholder, unbalanced braces), so
/// the caller falls back to English rather than show a broken sentence.
pub(super) fn substitute(pattern: &str, locale: &str, args: &[(String, Arg)]) -> Option<String> {
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut chars = pattern.chars().peekable();
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
                let mut name = String::new();
                loop {
                    match chars.next()? {
                        '}' => break,
                        ch if ch.is_alphanumeric() || ch == '_' => name.push(ch),
                        _ => return None,
                    }
                }
                let (_, arg) = args.iter().find(|(key, _)| *key == name)?;
                // RTL locales isolate Latin text arguments (`bidi.rs`).
                match arg {
                    Arg::Text(text) => {
                        let whole = pattern.len() == name.len() + 2;
                        bidi::push_text_arg(&mut out, text, locale, whole);
                    }
                    _ => out.push_str(&arg.render(locale)),
                }
            }
            '}' => return None,
            other => out.push(other),
        }
    }
    Some(out)
}
